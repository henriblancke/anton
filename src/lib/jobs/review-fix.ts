/**
 * review-fix job (anton-3t2.2). For a project's in-review epics (open PR linked on the bead), poll
 * the PR via `gh` for requested changes + failing CI; when actionable, re-materialize the epic's
 * worktree, dispatch claude to resolve the feedback, commit, push, and re-request review. See
 * DESIGN §2/§4 and git/pr.ts.
 *
 * Enqueued per-project by the scheduler (a polling job): each run sweeps every in-review epic once.
 * Idempotent — a PR with nothing actionable is skipped, and claude's fixes are plain commits on the
 * existing branch, so a re-run just pushes whatever is left.
 */
import { randomUUID } from "node:crypto";
import { beads, LABELS, type Bead } from "../beads/bd";
import { loadAgentPrompt } from "../claude/agent-prompt";
import { buildExecutionSystemPrompt } from "../claude/system-prompt";
import { runClaude, type ClaudeEvent } from "../claude/driver";
import { loadSkill } from "../claude/prompt";
import { branchAheadOfRemote, commitAll, pushBranch } from "../git/ops";
import {
  classifyReview,
  commentOnPr,
  getPrReview,
  prNumberFromRef,
  reRequestReview,
  reviewersRequestingChanges,
  type PrReview,
} from "../git/pr";
import { createWorktree } from "../git/worktree";
import { getProjectById, getProjectSettings, type ProjectSettings } from "../projects";
import { runShell } from "./shell";
import { findOpenRunForEpic } from "../runs";
import { appendSessionLog, createSession, endSession, sessionLogPath } from "../sessions";
import { PoisonError } from "./errors";
import { isUsageLimitError } from "./errors";
import type { AntonDb, Clock } from "./queue";
import { systemClock } from "./queue";
import type { JobContext, JobHandler, RunnerLogger } from "./runner";

export interface ReviewFixPayload {
  projectId: string;
  scheduleId?: string;
  /** Optional: restrict to one epic (else sweep all in-review epics). */
  epicBeadId?: string;
}

export interface ReviewFixDeps {
  db: AntonDb;
  clock?: Clock;
  branchPrefix?: string;
}

const IN_REVIEW = LABELS.stage("in-review");

/** Handlers get no logger from the runner; fall back to console so swallowed errors are visible. */
const consoleLog: RunnerLogger = {
  info: (m, meta) => console.log(`[review-fix] ${m}`, meta ?? ""),
  error: (m, meta) => console.error(`[review-fix] ${m}`, meta ?? ""),
};

/** In-review epics = open epics tagged stage:in-review that carry a PR external-ref. */
export function inReviewEpics(all: Bead[]): Bead[] {
  return all.filter(
    (b) =>
      beads.isEpic(b) &&
      b.status !== "closed" &&
      (b.labels?.includes(IN_REVIEW) ?? false) &&
      prNumberFromRef(b.external_ref) !== undefined,
  );
}

/** Build the runner handler bound to a db/clock. Register it as the "review-fix" handler. */
export function makeReviewFixHandler(deps: ReviewFixDeps): JobHandler {
  const db = deps.db;
  const clock = deps.clock ?? systemClock;
  const branchPrefix = deps.branchPrefix ?? "anton";

  return async function reviewFix(ctx: JobContext): Promise<void> {
    const { projectId, epicBeadId } = ctx.payload as ReviewFixPayload;
    const project = await getProjectById(db, projectId);
    if (!project) throw new PoisonError(`project ${projectId} not found`);
    const repo = project.repoPath;
    const settings = await getProjectSettings(db, projectId);

    const all = await beads.list(repo, ["--status", "all"]);
    let epics = inReviewEpics(all);
    if (epicBeadId) epics = epics.filter((e) => e.id === epicBeadId);
    if (epics.length === 0) return; // nothing in review — done.

    // Sweep each in-review PR. One epic's failure shouldn't abort the others, but a usage limit
    // must propagate so the runner backs the WHOLE job off (you can't retry an exhausted quota).
    let lastError: unknown;
    for (const epic of epics) {
      await ctx.heartbeat();
      try {
        await handleEpic({ db, clock, ctx, repo, projectId, epic, settings, branchPrefix, all });
      } catch (e) {
        if (isUsageLimitError(e)) throw e; // stop the sweep; runner reschedules past the reset.
        lastError = e;
        consoleLog.error(`epic ${epic.id} (PR fix) failed; continuing sweep`, e);
      }
    }
    // Surface a non-quota failure so the job retries/parks — but only after trying every epic.
    if (lastError) {
      throw lastError instanceof Error ? lastError : new Error(String(lastError));
    }
  };
}

async function handleEpic(args: {
  db: AntonDb;
  clock: Clock;
  ctx: JobContext;
  repo: string;
  projectId: string;
  epic: Bead;
  settings: ProjectSettings;
  branchPrefix: string;
  all: Bead[];
}): Promise<void> {
  const { db, clock, ctx, repo, projectId, epic, settings, branchPrefix, all } = args;
  const number = prNumberFromRef(epic.external_ref);
  if (number === undefined) return;

  const pr = await getPrReview(repo, number, ctx.signal);
  const verdict = classifyReview(pr);
  if (!verdict.actionable) return; // nothing to fix on this PR yet.

  const branch = pr.headRefName || `${branchPrefix}/${epic.id}`;

  // Re-materialize the worktree from the PR branch (execute-epic removes it after opening the PR).
  const worktree = await createWorktree({
    repoPath: repo,
    branch,
    baseBranch: settings.baseBranch,
    warm: false,
  });
  await ctx.heartbeat();

  const sessionId = randomUUID();
  const logPath = sessionLogPath(sessionId);
  // Resume the epic's open run if present (for UI linkage); review-fix doesn't create runs itself.
  const run = await findOpenRunForEpic(db, projectId, epic.id);
  await createSession(db, clock, {
    id: sessionId,
    projectId,
    runId: run?.id,
    kind: "review-fix",
    beadId: epic.id,
    logPath,
  });
  const onEvent = (e: ClaudeEvent) => {
    const line = e.text ? `[${e.type}] ${e.text}\n` : `[${e.type}]\n`;
    void appendSessionLog(logPath, line).catch(() => {});
  };

  try {
    await appendSessionLog(logPath, `[review-fix] PR #${number}: ${verdict.reasons.join("; ")}\n`);

    // Compose the same layered system prompt used for execution (base + agent + seed), so the fix
    // obeys the operating contract. Use the epic's agent tag if it has one.
    const agentTag = labelValue(epic.labels, "agent");
    const appendSystemPrompt = await buildExecutionSystemPrompt({
      agentPrompt: await loadAgentPrompt(agentTag),
      seedPrompt: settings.seedPrompt,
    });

    // The editable reasoning contract (per-project override, else the shipped default) followed by
    // the concrete PR context anton fetched.
    const reasoning = settings.reviewFixPrompt?.trim() || (await loadSkill("review-fix"));
    const prompt = [reasoning, "", "---", "", reviewFixContext(epic, pr, verdict.reasons)].join("\n");

    const result = await runClaude({
      cwd: worktree.path,
      prompt,
      appendSystemPrompt,
      model: settings.model,
      permissionMode: settings.permissionMode ?? "bypassPermissions",
      signal: ctx.signal,
      onEvent,
    });
    if (!result.ok) {
      throw new Error(`claude reported an error resolving PR #${number}: ${result.text ?? "unknown"}`);
    }

    // Optional tests before pushing (same gate as execution).
    if (settings.testCommand) {
      const test = await runShell(settings.testCommand, worktree.path, ctx.signal);
      await appendSessionLog(logPath, `\n[tests] ${settings.testCommand}\n${test.output}\n`);
      if (!test.ok) throw new Error(`tests failed after review-fix for PR #${number} (exit ${test.code})`);
    }

    const { committed } = await commitAll(worktree.path, `${epic.id}: address review feedback (PR #${number})`);
    // Push if this run committed OR a prior attempt left commits unpushed (e.g. a push failed after
    // committing, then the retry's claude produced no new diff). Otherwise there is genuinely
    // nothing to send — treat that as a clean no-op, not a silent skip of pending work.
    const pending = committed || (await branchAheadOfRemote(repo, branch));
    if (!pending) {
      await appendSessionLog(logPath, `[review-fix] no changes produced; leaving PR #${number} as-is\n`);
      await endSession(db, clock, sessionId, "done");
      return;
    }

    await pushBranch(repo, branch);
    await safe(() =>
      commentOnPr(
        repo,
        number,
        `🤖 anton pushed a fix for the review feedback (${verdict.reasons.join("; ")}). Please re-review.`,
        ctx.signal,
      ),
    );
    await safe(() => reRequestReview(repo, number, reviewersRequestingChanges(pr), ctx.signal));

    await endSession(db, clock, sessionId, "done");
  } catch (e) {
    await endSession(db, clock, sessionId, "failed");
    throw e; // propagate so the runner applies quota backoff / retry / park
  }
  void all; // reserved (edge lookups if we later scope fixes to specific tickets)
}

// ── helpers ──

function labelValue(labels: string[] | undefined, prefix: string): string | undefined {
  const l = labels?.find((x) => x.startsWith(`${prefix}:`));
  return l ? l.slice(prefix.length + 1) : undefined;
}

/**
 * The concrete PR context appended beneath the (editable) reasoning contract: which epic/PR, why
 * it needs action, the reviewer summaries + inline comments + failing checks. The reasoning of HOW
 * to resolve lives in the review-fix prompt (default file or settings override), not here.
 */
function reviewFixContext(epic: Bead, pr: PrReview, reasons: string[]): string {
  const lines: string[] = [
    `## This PR`,
    ``,
    `Epic: ${epic.id} — ${epic.title}`,
    `PR: #${pr.number} (${pr.url})`,
    `Branch: ${pr.headRefName}`,
    `Why this needs action: ${reasons.join("; ")}.`,
    ``,
  ];

  const changeReviews = pr.reviews.filter((r) => r.state === "CHANGES_REQUESTED" && r.body.trim());
  if (changeReviews.length > 0) {
    lines.push(`Reviewer summaries requesting changes:`);
    for (const r of changeReviews) lines.push(`- @${r.author}: ${r.body.trim()}`);
    lines.push(``);
  }

  if (pr.comments.length > 0) {
    lines.push(`Inline review comments:`);
    for (const c of pr.comments) {
      const loc = c.path ? `${c.path}${c.line ? `:${c.line}` : ""}` : "(general)";
      lines.push(`- ${loc} — @${c.author}: ${c.body.trim()}`);
    }
    lines.push(``);
  }

  if (pr.failingChecks.length > 0) {
    lines.push(`Failing CI checks: ${pr.failingChecks.join(", ")}.`);
  }

  return lines.join("\n").trimEnd();
}

async function safe(fn: () => Promise<unknown>): Promise<void> {
  try {
    await fn();
  } catch {
    // best-effort
  }
}
