/**
 * Everything a run does BEFORE it holds anything (anton-1lix — extracted from execute-epic.ts).
 *
 * One board read, the gates that read it, and the run row. Nothing here writes to the board or the
 * filesystem, which is the point: every refusal in this phase costs an operator a message and
 * nothing else — no lease to clear, no checkout to reap, no reservation to hand back.
 */
import { randomUUID } from "node:crypto";
import { beads, type Bead } from "../beads/bd";
import { loadAllIssues } from "../beads/issues";
import { isUnit } from "../epic-graph";
import { runTickets } from "../ticket-view";
import { bundledAgentIds, discoverAgents } from "../agents-discovery";
import { getProjectById, getProjectSettings, resolveTicketTimeoutMs } from "../projects";
import { createRun, findOpenRunForEpic, updateRun } from "../runs";
import { PoisonEpic } from "./errors";
import { blockedRunPoison, runReadiness } from "./execute-epic-board";
import { humanTargetPoison } from "./execute-epic-human-gate";
import { makeRunLease } from "./execute-epic-lease";
import { makeEpicRun, type EpicRun } from "./execute-epic-run";
import { systemClock, type AntonDb, type Clock } from "./queue";
import type { JobContext } from "./runner";

/** The payload the runner hands the `execute-epic` handler. */
export interface ExecuteEpicPayload {
  projectId: string;
  epicBeadId: string;
}

/**
 * Read the board, refuse everything that must never start, and open (or resume) the run row.
 *
 * Answers `null` — not an error — for an ABANDONED target (anton-6xj0): a human declared the work
 * won't be done, and a park would put their own decision back in front of them as a job needing
 * attention. There is no run row yet, so nothing can be mistaken for a delivery.
 */
export async function beginEpicRun(args: {
  db: AntonDb;
  clock?: Clock;
  branchPrefix?: string;
  ctx: JobContext;
}): Promise<EpicRun | null> {
  const { db, ctx } = args;
  const clock = args.clock ?? systemClock;
  const { projectId, epicBeadId } = ctx.payload as ExecuteEpicPayload;
  const project = await getProjectById(db, projectId);
  if (!project) throw new PoisonEpic(`project ${projectId} not found`);

  const repo = project.repoPath;
  const settings = await getProjectSettings(db, projectId);
  const userAgentIds = await discoverUserAgents(repo);

  // `loadAllIssues`, not a bare `bd list`: bd OMITS gate beads from every ordinary listing while
  // carrying the `blocks` edge a gate puts on the bead it gates, and every blocker helper treats a
  // blocker it can't see as still open (fail safe). Since a run arms a `gh:pr` merge gate on its own
  // target (anton-k0kj), a bare list would leave that edge dangling and poison the target's own
  // recovery run forever. STRICT for the same reason: a swallowed gate-listing failure would leave
  // that edge dangling and the blocker check would read it as open, poisoning a run a retry would
  // have carried. Let it reject; the runner retries.
  const all = await loadAllIssues(repo, { strictGates: true });
  const target = assertRunnableTarget(all, epicBeadId);
  if (!target) return null;

  // Unit-ness is type-only (isUnit reads `issue_type`), so unlike the grouping shape it genuinely
  // can't change across a pull — captured here and reused against every board this run re-reads.
  const targetIsUnit = isUnit(target);
  const readiness = (board: Bead[]) =>
    runReadiness(board, epicBeadId, targetIsUnit);

  // Re-check the same readiness gate the approval route enforces, now at job start. Approval only
  // guarantees readiness at approval time; between then and this lease a `blocks` edge could have
  // been added or pulled in via Dolt sync (a shared board), leaving this job queued behind a blocker
  // that's no longer done. PARK if NOTHING can start — starting still-blocked work would violate the
  // sequence. Recoverable: once the blocker completes, resuming the parked job re-reads beads and
  // passes this gate. Re-checked after the cross-machine pull (a blocker another machine pushed
  // since would be invisible to this pre-pull snapshot).
  const verdict = readiness(all);
  if (!verdict.runnable) throw blockedRunPoison(epicBeadId, verdict, all);

  const { standaloneRun, tickets } = selectRunTickets(all, target, epicBeadId);
  // Branches keep the `prefix/id` slash (git convention); only the worktree *path* segment is
  // sanitized (in worktreePathFor). Bead ids are already filesystem-/ref-safe.
  const branch = `${args.branchPrefix ?? "anton"}/${epicBeadId}`;
  const { runId, existing } = await openRunRow({
    db,
    clock,
    ctx,
    projectId,
    epicBeadId,
    branch,
    model: settings.model,
  });

  return makeEpicRun({
    db,
    clock,
    ctx,
    projectId,
    project,
    settings,
    repo,
    targetId: epicBeadId,
    branch,
    runId,
    existing,
    targetIsUnit,
    ticketTimeoutMs: resolveTicketTimeoutMs(settings),
    userAgentIds,
    // Cross-machine run-liveness lease (anton-jz1). Owns nothing until the foreign-lease gate has
    // passed, so the cleanup's clear can never take another machine's live lease. `runId` stamps the
    // owner onto every publish, so a later resume can tell this run's own crash leftover from a
    // foreign lease.
    lease: makeRunLease({ repo, targetId: epicBeadId, runId, clock }),
    all,
    target,
    standaloneRun,
    tickets,
    readiness,
  });
}

/**
 * The project's OWN agents — a discoverable `agent:<id>` whose id anton does NOT ship as a bundled
 * specialist. These are NEVER gated by the active-agents allowlist (anton-dvo.1 reversed): the
 * operator brought them and labels tickets with them deliberately, so a second opt-in in Settings is
 * pure friction. The allowlist governs anton's bundled NAMESPACE only; a bundled id stays gated even
 * when the operator has a `.claude/agents/<id>.md` override of it (else a machine that mirrors every
 * bundled name into ~/.claude/agents would slip the whole allowlist). An id that resolves nowhere (a
 * typo) is not in `discovered`, so it isn't exempted — it parks.
 *
 * Fails safe to "no user agents" on a discovery error rather than crashing the run here.
 */
async function discoverUserAgents(repo: string): Promise<string[]> {
  return Promise.all([discoverAgents(repo), bundledAgentIds()])
    .then(([discovered, bundled]) => {
      const bundledSet = new Set(bundled);
      return discovered.filter((a) => !bundledSet.has(a.id)).map((a) => a.id);
    })
    .catch(() => [] as string[]);
}

/**
 * The bead this run executes, or `undefined` when a human has abandoned it (the caller's clean exit).
 *
 * A target is a feature, a parentless task/bug run as an epic-of-one, or a legacy epic with no
 * feature children (isRunTarget). The non-runnable cases are distinguished so the poison message is
 * honest: a bead that WAS found but isn't a valid target must not read "not found" (that sends the
 * operator hunting for a missing bead), and a container epic must be told it is one.
 */
function assertRunnableTarget(all: Bead[], targetId: string): Bead | undefined {
  const target = all.find((b) => b.id === targetId);
  if (!target) throw new PoisonEpic(`bead ${targetId} not found on the board`);
  if (!beads.isRunTarget(target, all)) throw notARunTarget(target, all, targetId);
  if (!beads.isApproved(target)) {
    throw new PoisonEpic(`target ${targetId} is not approved — refusing to execute`);
  }
  // Reached by a job that was already queued (or is being resumed) when the abandon landed; a job
  // that was RUNNING is cancelled by the abandon itself.
  if (beads.isAbandoned(target)) return undefined;
  // Work only a person can do never reaches an agent (anton-mv70). `agent:human` names the one
  // specialist anton does not have, so dispatching it would fall through to the DEFAULT agent and
  // spend a run flailing at a credential, a purchase or a taste call. The claimable set already
  // excludes it (beads.isHumanWork); this is the backstop for every other way a run starts — Force
  // run, a resumed job queued before the label landed, an API enqueue. Poison, not retry: no number
  // of attempts turns human work into agent work, and parking puts it back in front of the operator
  // who has to do it.
  if (beads.isHumanWork(target)) throw humanTargetPoison(targetId);
  return target;
}

/** Why this bead cannot be run, in the words the operator needs to act on it. */
function notARunTarget(target: Bead, all: Bead[], targetId: string): PoisonEpic {
  if (beads.isContainer(target, all)) {
    return new PoisonEpic(
      `epic ${targetId} is a container, not a run target — it has feature children, and each ` +
        `feature runs on its own (own worktree, own PR); run one of its features instead`,
    );
  }
  const parent = beads.parentOf(target);
  return new PoisonEpic(
    `bead ${targetId} is not runnable: type "${target.issue_type ?? "unknown"}"` +
      (parent ? ` with parent ${parent}` : "") +
      ` — only a feature, a parentless task/bug, or an epic with no feature children can be run`,
  );
}

/**
 * The tickets this run dispatches, and whether the target IS its own single ticket.
 *
 * A grouping target runs all its children into one PR; a leaf target IS its own single ticket (an
 * epic-of-one). The rest of the pipeline — worktree, per-ticket claude→tests→commit→close, one PR —
 * is identical either way, so the leaf case is just a one-element ticket list. An epic always groups
 * (a childless one poisons here, exactly as before the tier split); a feature groups only once
 * tickets have been shaped under it — a feature shaped as one unit of work is its own ticket, so it
 * must not poison for having no children. A parentless task/bug is always a leaf. The rule is shared
 * with epic-detail (beads.groupsChildren) so a run and its detail page never disagree about which
 * tickets the target contains.
 *
 * The ticket set is the target's whole working-layer SUBTREE (runTickets), the same set the board
 * card displays and counts — a direct-children run would merge the PR while leaving a deeper subtask
 * open under a finished run target.
 */
export function selectRunTickets(
  all: Bead[],
  target: Bead,
  targetId: string,
): { standaloneRun: boolean; tickets: Bead[] } {
  const children = runTickets(all, targetId);
  const standaloneRun = !beads.groupsChildren(target, children);
  const tickets = standaloneRun ? [target] : children;
  if (tickets.length === 0) throw new PoisonEpic(`epic ${targetId} has no tickets`);
  return { standaloneRun, tickets };
}

/** Resume an open run or start a new one. */
async function openRunRow(args: {
  db: AntonDb;
  clock: Clock;
  ctx: JobContext;
  projectId: string;
  epicBeadId: string;
  branch: string;
  model: string | undefined;
}): Promise<{ runId: string; existing: Awaited<ReturnType<typeof findOpenRunForEpic>> }> {
  const { db, clock, ctx, projectId, epicBeadId, branch, model } = args;
  const existing = await findOpenRunForEpic(db, projectId, epicBeadId);
  const runId = existing?.id ?? randomUUID();
  if (!existing) {
    await createRun(db, clock, {
      id: runId,
      projectId,
      epicBeadId,
      jobId: ctx.jobId,
      branch,
      model,
      status: "running",
    });
    return { runId, existing };
  }
  // The score goes with the attempt that earned it (anton-cekf). A resume REUSES the parked row, so
  // leaving it would let a resumed attempt that never reaches review settle carrying the previous
  // attempt's number — and the score breaker, which reads one score per row, would judge this
  // attempt on a review it never had and could re-latch the disarm a human just cleared. Cleared
  // here, and rewritten by the gate the moment this attempt is reviewed. `jobId` moves with the
  // attempt (anton-rgso): a resume is a NEW job over the same row, and a cancel the operator raises
  // from here names that job, not the one that first parked. `attemptStartedAt` moves for the same
  // reason (anton-tebf): the repair weigher orders a failure against when its attempt began, and a
  // `dep-missing` repair parks the run it repaired — so a row still claiming the original start
  // would price the resumed attempt's failure as if it predated the repair.
  await updateRun(db, clock, runId, {
    status: "running",
    jobId: ctx.jobId,
    error: null,
    reviewScore: null,
    attemptStartedAt: clock.now(),
  });
  return { runId, existing };
}
