/**
 * execute-epic job (anton-dzh.4). For an approved epic: warm a worktree, then per ticket run
 * `claude` (with the ticket's agent prompt) → run tests → commit; when all tickets are done, open
 * ONE PR via `gh` and move the epic to in-review. Idempotent/resumable — a re-run (crash, quota
 * backoff) skips tickets already closed and reuses the existing worktree. See DESIGN.md §4/§7.
 */
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { beads, LABELS, type Bead } from "../beads/bd";
import { loadAgentPrompt } from "../claude/agent-prompt";
import { runClaude, type ClaudeEvent } from "../claude/driver";
import { commitAll, openPullRequest } from "../git/ops";
import { createWorktree, removeWorktree } from "../git/worktree";
import { getProjectById, getProjectSettings, type ProjectSettings } from "../projects";
import {
  createRun,
  findOpenRunForEpic,
  updateRun,
} from "../runs";
import { appendSessionLog, createSession, endSession, sessionLogPath } from "../sessions";
import { isUsageLimitError } from "./errors";
import type { AntonDb, Clock } from "./queue";
import { systemClock } from "./queue";
import type { JobContext, JobHandler } from "./runner";

export interface ExecuteEpicPayload {
  projectId: string;
  epicBeadId: string;
}

export interface ExecuteEpicDeps {
  db: AntonDb;
  clock?: Clock;
  /** Override the branch prefix (default "anton"). */
  branchPrefix?: string;
}

/** Build the runner handler bound to a db/clock. Register it as the "execute-epic" handler. */
export function makeExecuteEpicHandler(deps: ExecuteEpicDeps): JobHandler {
  const db = deps.db;
  const clock = deps.clock ?? systemClock;
  const branchPrefix = deps.branchPrefix ?? "anton";

  return async function executeEpic(ctx: JobContext): Promise<void> {
    const { projectId, epicBeadId } = ctx.payload as ExecuteEpicPayload;
    const project = await getProjectById(db, projectId);
    if (!project) throw new PoisonEpic(`project ${projectId} not found`);

    const repo = project.repoPath;
    const settings = await getProjectSettings(db, projectId);

    // Load the epic + its tickets from beads (the source of truth).
    const all = await beads.list(repo, ["--status", "all"]);
    const epic = all.find((b) => b.id === epicBeadId);
    if (!epic || !beads.isEpic(epic)) throw new PoisonEpic(`epic ${epicBeadId} not found`);
    if (!beads.isApproved(epic)) {
      throw new PoisonEpic(`epic ${epicBeadId} is not approved — refusing to execute`);
    }

    const tickets = childrenOf(all, epicBeadId);
    if (tickets.length === 0) throw new PoisonEpic(`epic ${epicBeadId} has no tickets`);

    // Branches keep the `prefix/id` slash (git convention); only the worktree *path* segment is
    // sanitized (in worktreePathFor). Bead ids are already filesystem-/ref-safe.
    const branch = `${branchPrefix}/${epicBeadId}`;

    // Resume an open run or start a new one.
    const existing = await findOpenRunForEpic(db, projectId, epicBeadId);
    const runId = existing?.id ?? randomUUID();
    if (!existing) {
      await createRun(db, clock, {
        id: runId,
        projectId,
        epicBeadId,
        branch,
        model: settings.model,
        status: "running",
      });
    } else {
      await updateRun(db, clock, runId, { status: "running", error: null });
    }

    try {
      // 1. Warm worktree (idempotent — reused on resume).
      const worktree = await createWorktree({
        repoPath: repo,
        branch,
        baseBranch: settings.baseBranch ?? project.defaultBranch,
        warm: true,
      });
      await updateRun(db, clock, runId, {
        worktreePath: worktree.path,
        branch: worktree.branch,
        attempts: ctx.attempt,
      });
      await ctx.heartbeat();

      // 2. Mark the epic implementing (idempotent).
      await safe(() => beads.setStatus(repo, epicBeadId, "in_progress"));
      await safe(() => beads.tag(repo, epicBeadId, [LABELS.stage("implementing")]));

      // 3. Per ticket: claude → tests → commit → close. Skip already-closed (resume).
      for (const ticket of orderTickets(tickets, all)) {
        if (ticket.status === "closed") continue;
        await runTicket({
          db,
          clock,
          ctx,
          projectId,
          repo,
          runId,
          worktreePath: worktree.path,
          ticket,
          settings,
        });
        await ctx.heartbeat();
      }

      // 4. All tickets closed → open one PR, move epic to in-review.
      const pr = await openPullRequest({
        repoPath: repo,
        branch: worktree.branch,
        base: settings.baseBranch ?? project.defaultBranch,
        title: `${epic.title} (${epicBeadId})`,
        body: prBody(epic, tickets),
      });
      await safe(() => beads.setExternalRef(repo, epicBeadId, pr.ref));
      await safe(() => beads.tag(repo, epicBeadId, [LABELS.stage("in-review")]));
      await safe(() => beads.untag(repo, epicBeadId, [LABELS.stage("implementing")]));

      // 5. Finalize run + clean up the worktree (the branch/PR carry the work now).
      await updateRun(db, clock, runId, { status: "done", endedAt: clock.now(), error: null });
      await safe(() => removeWorktree(worktree));
    } catch (e) {
      // Quota → park the run (job reschedules); anything else → the run failed (job retries/parks).
      if (isUsageLimitError(e)) {
        await updateRun(db, clock, runId, { status: "parked", error: "usage-limit" });
      } else {
        await updateRun(db, clock, runId, {
          status: "failed",
          error: e instanceof Error ? e.message : String(e),
          endedAt: clock.now(),
        });
      }
      throw e; // let the runner apply job-level durability
    }
  };
}

/** One ticket: session → claude → tests → commit → close. */
async function runTicket(args: {
  db: AntonDb;
  clock: Clock;
  ctx: JobContext;
  projectId: string;
  repo: string;
  runId: string;
  worktreePath: string;
  ticket: Bead;
  settings: ProjectSettings;
}): Promise<void> {
  const { db, clock, ctx, projectId, repo, runId, worktreePath, ticket, settings } = args;
  const agentTag = labelValue(ticket.labels, "agent");
  const appendSystemPrompt = await loadAgentPrompt(agentTag);

  const sessionId = randomUUID();
  const logPath = sessionLogPath(sessionId);
  await createSession(db, clock, {
    id: sessionId,
    projectId,
    runId,
    kind: "execute",
    beadId: ticket.id,
    logPath,
  });
  await updateRun(db, clock, runId, { ticketBeadId: ticket.id, agentTag: agentTag ?? null });

  const onEvent = (e: ClaudeEvent) => {
    const line = e.text ? `[${e.type}] ${e.text}\n` : `[${e.type}]\n`;
    void appendSessionLog(logPath, line).catch(() => {});
  };

  try {
    const result = await runClaude({
      cwd: worktreePath,
      prompt: ticketPrompt(ticket),
      appendSystemPrompt,
      model: settings.model,
      permissionMode: settings.permissionMode ?? "bypassPermissions",
      signal: ctx.signal,
      onEvent,
    });
    if (!result.ok) {
      throw new Error(`claude reported an error for ${ticket.id}: ${result.text ?? "unknown"}`);
    }

    // Tests (optional — configured per project).
    if (settings.testCommand) {
      const test = await runShell(settings.testCommand, worktreePath, ctx.signal);
      await appendSessionLog(logPath, `\n[tests] ${settings.testCommand}\n${test.output}\n`);
      if (!test.ok) throw new Error(`tests failed for ${ticket.id} (exit ${test.code})`);
    }

    // Commit whatever claude changed.
    await commitAll(worktreePath, `${ticket.id}: ${ticket.title}`);

    // Mark the ticket done in beads (stage → done).
    await safe(() => beads.close(repo, ticket.id));
    await endSession(db, clock, sessionId, "done");
  } catch (e) {
    await endSession(db, clock, sessionId, "failed");
    throw e;
  }
}

// ── helpers ──

/** A permanent, human-needed failure (never retried). */
class PoisonEpic extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = "PoisonError"; // classified as poison by the runner
  }
}

function childrenOf(all: Bead[], epicId: string): Bead[] {
  return all.filter((b) => ((b.parent ?? b.parent_id) as string | undefined) === epicId);
}

function labelValue(labels: string[] | undefined, prefix: string): string | undefined {
  const l = labels?.find((x) => x.startsWith(`${prefix}:`));
  return l ? l.slice(prefix.length + 1) : undefined;
}

/**
 * Topologically order tickets so a ticket runs after the tickets it depends on (`blocks` edges
 * among the epic's own members). Falls back to input order on a cycle.
 */
export function orderTickets(tickets: Bead[], all: Bead[]): Bead[] {
  const ids = new Set(tickets.map((t) => t.id));
  const indeg = new Map<string, number>();
  const adj = new Map<string, string[]>();
  for (const t of tickets) {
    indeg.set(t.id, 0);
    adj.set(t.id, []);
  }
  for (const e of beads.edgesOf(all)) {
    if (e.type !== "blocks") continue;
    // e.from depends on e.to → e.to must come first.
    if (!ids.has(e.from) || !ids.has(e.to)) continue;
    adj.get(e.to)!.push(e.from);
    indeg.set(e.from, (indeg.get(e.from) ?? 0) + 1);
  }
  const queue = tickets.filter((t) => (indeg.get(t.id) ?? 0) === 0).map((t) => t.id);
  const order: string[] = [];
  const byId = new Map(tickets.map((t) => [t.id, t]));
  while (queue.length) {
    const id = queue.shift()!;
    order.push(id);
    for (const next of adj.get(id) ?? []) {
      indeg.set(next, (indeg.get(next) ?? 0) - 1);
      if ((indeg.get(next) ?? 0) === 0) queue.push(next);
    }
  }
  if (order.length !== tickets.length) return tickets; // cycle → original order
  return order.map((id) => byId.get(id)!);
}

function ticketPrompt(ticket: Bead): string {
  const acceptance = ticket.acceptance_criteria ?? ticket.acceptance ?? "(see `bd show`)";
  return [
    `You are implementing a single beads ticket in THIS worktree as part of an autonomous run.`,
    ``,
    `Ticket: ${ticket.id} — ${ticket.title}`,
    ``,
    `Acceptance criteria:`,
    acceptance,
    ``,
    `Run \`bd show ${ticket.id}\` for the full Goal / Context. Implement the ticket to satisfy`,
    `its acceptance criteria, editing the working tree directly.`,
    ``,
    `Rules:`,
    `- Do NOT commit, push, or open a PR — anton handles git after you finish.`,
    `- Do NOT run \`bd close\` — anton closes the ticket once tests pass.`,
    `- Keep changes scoped to this ticket.`,
    ``,
    `When done, briefly summarize what you changed.`,
  ].join("\n");
}

function prBody(epic: Bead, tickets: Bead[]): string {
  const lines = [
    `Autonomous run for **${epic.id}** — ${epic.title}.`,
    ``,
    `Tickets:`,
    ...tickets.map((t) => `- ${t.id} — ${t.title}`),
    ``,
    `🤖 Generated with [anton](https://github.com/) autonomous execution`,
  ];
  return lines.join("\n");
}

/** Run a shell command, capturing combined output. Aborts with the run's signal. */
function runShell(
  cmd: string,
  cwd: string,
  signal?: AbortSignal,
): Promise<{ ok: boolean; code: number | null; output: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn("sh", ["-c", cmd], { cwd, signal });
    let out = "";
    child.stdout?.on("data", (c: Buffer) => (out += c.toString("utf8")));
    child.stderr?.on("data", (c: Buffer) => (out += c.toString("utf8")));
    child.on("error", reject);
    child.on("close", (code) => resolve({ ok: code === 0, code, output: out }));
  });
}

/** Swallow errors from best-effort bd side effects (already-applied labels, etc.). */
async function safe(fn: () => Promise<unknown>): Promise<void> {
  try {
    await fn();
  } catch {
    // best-effort
  }
}
