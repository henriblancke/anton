/**
 * execute-epic job (anton-dzh.4). For an approved epic: warm a worktree, then WALK THE PROJECT'S RUN
 * FORMULA (anton-lnkt) — its steps in execution order, one at a time, each dispatched through the
 * step registry (anton-4npr). The walk owns the ORDER; the guards around it are unchanged.
 *
 * The formula is split at its commit ({@link splitFormulaPhases}): the steps up to it run per ticket
 * (dispatch → gates → commit → close), the steps after it run once for the whole run (self-review →
 * ONE PR via `gh` → in-review). The pipeline is validated and floor-checked before any worktree
 * exists, so a broken one parks rather than half-executing.
 *
 * Git stays the evidence of record — there is no second store of run progress: idempotent/resumable
 * because a re-run (crash, quota backoff) reuses the existing worktree and skips tickets already
 * closed WHOSE COMMIT is on this branch; a cross-machine resume re-runs a board-closed ticket whose
 * commit never got pushed. See DESIGN.md §4/§7.
 */
import { randomUUID } from "node:crypto";
import {
  beads,
  gateReason,
  labelValueOf,
  LABELS,
  unclaimableStatus,
  type Bead,
  type Gate,
} from "../beads/bd";
import { loadAllIssues } from "../beads/issues";
import { ownerOf } from "../beads/claim";
import { withBeadWriteLock } from "../beads/claim-lock";
import { assignChildren, formatReservedChildren, releaseChildren } from "../beads/child-assign";
import { contractGaps, formatContractGaps } from "../beads/contract";
import { computeEpicGraph, epicStandaloneBlockers, isUnit, standaloneBlockers } from "../epic-graph";
import { contractGatedBeads, resumeSkipped, runTickets } from "../ticket-view";
import { runClaude, type ClaudeResult, type RunClaudeOptions } from "../claude/driver";
import { formatAntonResult, type AntonOutcome, type AntonResult } from "../claude/anton-result";
import {
  lookupOpenPullRequest,
  markPullRequestDraft,
  pullRequestState,
  readWorktreeState,
  resolveFreshBase,
  restoreWorktreeState,
  sameWorktreeState,
  worktreeHasCommitFor,
  type PullRequest,
  type WorktreeState,
} from "../git/ops";
import { prNumberFromRef } from "../git/pr";
import {
  acquireWorktreeClaim,
  createWorktree,
  findWorktree,
  releaseWorktreeClaim,
  worktreePathFor,
  type Worktree,
} from "../git/worktree";
import { releaseRunResources } from "./worktree-reaper";
import { bundledAgentIds, discoverAgents } from "../agents-discovery";
import {
  getProjectById,
  getProjectSettings,
  resolveReviewConfig,
  resolveTicketTimeoutMs,
} from "../projects";
import { resolveOperator } from "../operator";
import {
  createRun,
  findOpenRunForEpic,
  findRunFormulaForBranch,
  updateRun,
  type RunPatch,
} from "../runs";
import {
  appendSessionLog,
  endSession,
  setSessionClaudeId,
  startJobSession,
} from "../sessions";
import { describeScoreRegression, formatScoreSeries } from "./review-alarm";
import { findingLines, type ReviewFinding } from "./review-context";
import {
  blockingFindings,
  finalViolation,
  type ReviewGateResult,
  type ReviewRound,
} from "./review-gate";
import { persistPartialReviewScores, persistReviewScores } from "./review-score";
import {
  blockedByPoison,
  blockedTailReason,
  isForeignRunOwner,
  isPoisonError,
  isRecoverableClaudeError,
  isUsageLimitError,
  isRunAlreadyLiveError,
  parkedOnGateClause,
  PoisonEpic,
  RunAlreadyLiveError,
} from "./errors";
import { assertRunFormulaFloor } from "./formula-floor";
import { validateRunFormula, type ResolvedStep } from "./run-formula";
import { truncateField, type StepContext } from "./step-registry";
import type { AntonDb, Clock } from "./queue";
import { enqueueSyncPushDeduped, systemClock } from "./queue";
import type { JobContext, JobHandler } from "./runner";

export interface ExecuteEpicPayload {
  projectId: string;
  epicBeadId: string;
}

/** The step that turns work into evidence — and, for that reason, the walk's phase boundary. */
const COMMIT_STEP_NAME = "commit";

/** The formula split into the two phases a run walks (anton-lnkt). */
export interface FormulaPhases {
  /** Through the commit: dispatched once PER TICKET, in that ticket's own session. */
  ticketSteps: ResolvedStep[];
  /** After the commit: dispatched ONCE for the whole run, over every ticket that contributed. */
  runSteps: ResolvedStep[];
}

/**
 * Split the pipeline at its commit (anton-lnkt).
 *
 * The commit is where a ticket's work becomes git evidence — an epic's children close as they
 * commit, and `worktreeHasCommitFor` reads that commit to decide whether a ticket re-runs — so it is
 * also the line between what belongs to a TICKET and what belongs to the RUN. Everything that writes
 * to the worktree must precede it (the floor, anton-6b99, enforces exactly that), so the steps
 * before it are per-ticket work; the steps after it read the run's whole diff and open its single
 * PR, so they run once. Reordering the file moves that line — which is the point: a project that
 * moves its verify gates after the commit gets one run-wide verification instead of one per ticket,
 * with no anton code change.
 *
 * The floor guarantees exactly one `step:commit`, so this is a FAIL-LOUD assertion, not a fallback.
 */
export function splitFormulaPhases(formula: { source: string; steps: ResolvedStep[] }): FormulaPhases {
  const at = formula.steps.findIndex((s) => s.definition.name === COMMIT_STEP_NAME);
  if (at < 0) {
    throw new PoisonEpic(
      `run formula ${formula.source} declares no \`step:${COMMIT_STEP_NAME}\` — a run that never ` +
        `commits leaves no evidence of record, so anton has nothing to walk`,
    );
  }
  return { ticketSteps: formula.steps.slice(0, at + 1), runSteps: formula.steps.slice(at + 1) };
}

/**
 * Cross-machine run-liveness lease (anton-jz1). While a run executes, it publishes a
 * `run-lease:<expiry>` label on the target (the shared beads board) and refreshes it every
 * `RUN_LEASE_REFRESH_MS`; a Force run on another machine reads this and won't double-run a live
 * epic. TTL is comfortably longer than the refresh gap so a slow tick never lapses a live lease,
 * yet short enough that a crashed/killed machine (which stops refreshing) frees the epic for
 * re-trigger within the window. The lease is cleared when the run settles (below), so a
 * parked/failed/finished run is immediately re-triggerable without waiting out the TTL.
 */
const RUN_LEASE_TTL_MS = 15 * 60_000;
const RUN_LEASE_REFRESH_MS = 5 * 60_000;
/**
 * Propagation window the post-publish race arbitration (step 1b) settles for before it trusts an
 * uncontested read (anton-jz1). Concluding a run "won" from seeing only its OWN lease is a decision
 * made on the ABSENCE of a foreign lease, and absence is unreliable on an eventually-consistent
 * board: a machine that force-ran the same epic at the same instant may not have propagated its lease
 * yet, so a fast publish→read can miss it. Waiting a bounded window (comfortably above sync round-trip
 * latency, far below the TTL) lets a near-simultaneous foreign lease reach the remote before we
 * re-read and commit to running. This narrows — like the rest of this protocol, it can't fully close
 * without a real cross-machine lock — the asymmetric-read window the reviewer flagged.
 */
const RUN_LEASE_SETTLE_MS = 2_000;

/**
 * What a run may actually start, over one board snapshot (anton-1two). A run target is dispatched
 * PER TICKET, so "blocked" is not a property of the target: a ticket whose prerequisite ships in
 * ANOTHER run is held, while its independent siblings are ordinary work the run does now. The
 * rollup's per-child verdict (epic-graph `childReadiness`) is what tells those two apart — the
 * target-level `blockedBy` conflates them, and a run that gated on it stalled a whole feature over
 * one tail ticket (issue #58).
 */
export interface RunReadiness {
  /** Open prerequisites of the target or of its tickets — what the park reason names. */
  blockers: string[];
  /** Ticket ids a blocker OUTSIDE this run holds; never dispatched this pass. */
  gated: string[];
  /** At least one ticket is dispatchable now — the only condition under which the run proceeds. */
  runnable: boolean;
}

/**
 * Read {@link RunReadiness} off a board snapshot, for the run target `targetId`.
 *
 * A GRAPH UNIT — every feature and every epic (epic-graph's isUnit) — takes its verdict from the
 * epic-graph rollup, which is where cross-unit edges inferred from ticket-level `blocks` land;
 * keying on isEpic alone would send a feature down the standalone path and miss every inferred
 * blocker the approve route gates on. `targetIsUnit` is passed in rather than re-derived so a run
 * judges every board it re-reads by the shape it started with.
 *
 * The BLOCKER list stays the coarse roll-up — it names what the operator is waiting on, and a unit
 * also inherits any open standalone (parentless task/bug) prerequisite the rollup drops
 * (epicStandaloneBlockers), the same gap the approve route closes. Only the DECISION is per-child.
 *
 * A standalone task/bug (epic-of-one) never appears in the rollup and has nothing to be partial
 * about — it IS its own single ticket — so its own open `blocks` edges hold the whole run.
 */
export function runReadiness(
  board: Bead[],
  targetId: string,
  targetIsUnit: boolean,
): RunReadiness {
  if (!targetIsUnit) {
    const blockers = standaloneBlockers(board, targetId);
    return {
      blockers,
      gated: blockers.length > 0 ? [targetId] : [],
      runnable: blockers.length === 0,
    };
  }
  const node = computeEpicGraph(board).epics.find((n) => n.id === targetId);
  const blockers = [...(node?.blockedBy ?? []), ...epicStandaloneBlockers(board, targetId)];
  return {
    blockers,
    gated: node?.blockedChildren ?? [],
    // A unit always has a node; judging a missing one by its blockers is the fail-safe.
    runnable: node ? node.childReadiness !== "blocked" : blockers.length === 0,
  };
}

/**
 * The ask each open human gate among `blockers` carries, phrased as what a person does about it.
 *
 * A human gate blocks its target like any other prerequisite, but no work completes it — only
 * someone answering it — so listing it beside ordinary blockers describes a wait for something that
 * is never coming.
 */
function openHumanGateAsks(board: Bead[], blockers: string[]): string[] {
  return blockers.flatMap((id) => {
    const bead = board.find((b) => b.id === id);
    if (!bead || bead.status === "closed" || !beads.isHumanGate(bead)) return [];
    const ask = gateReason(bead) ?? "no reason recorded on the gate";
    return [
      `${id} is a human gate, not work in flight — "${ask}" — answer it, then ` +
        `\`bd gate resolve ${id}\`.`,
    ];
  });
}

/** The park a run takes when NOTHING in it can start. */
function blockedRunPoison(beadId: string, readiness: RunReadiness, board: Bead[]): PoisonEpic {
  if (readiness.blockers.length === 0) {
    return new PoisonEpic(
      `${beadId} has no ticket it can start — every ticket it would run is held by an open ` +
        `blocker outside this run; resume the run once they complete`,
    );
  }
  const blocked = blockedByPoison(beadId, readiness.blockers);
  // A human gate among the blockers is an ASK, not work in progress — and it can be the only record
  // of one: a needs-human park whose run row could not be settled leaves the gate standing alone
  // (anton-287p), and the next attempt lands here. Naming the ask is what keeps that recovery from
  // reading as an ordinary block. The blocked-by clause stays intact ahead of it — run-health
  // parses the ids back out of it to report this stall as the gate's own wait rather than twice.
  const asks = openHumanGateAsks(board, readiness.blockers);
  return asks.length > 0 ? new PoisonEpic(`${blocked.message}. ${asks.join(" ")}`) : blocked;
}

/**
 * The run ran every ticket it could and the rest are held by a prerequisite outside it (anton-1two).
 * Poison (`PoisonEpic`), so the runner parks the JOB for a human rather than burning retries on a
 * wait no retry shortens — and, like {@link ReviewBlockedError}, the RUN row is parked instead of
 * failed: its tickets' commits are on the branch, and the resume that follows the blocker landing
 * continues in this same row and worktree rather than reading as a crash.
 */
class BlockedTailError extends PoisonEpic {}

/**
 * A timed-out ticket's partial work could NOT be rolled back, so the run halted rather than let the
 * next ticket commit the leftovers as its own (anton-t1mo). Poison (`PoisonEpic`) like the tail
 * above, but distinguishable at the teardown: the worktree named in this error is the only copy of
 * that work and the very path the operator is told to clear, so it must survive the run's release
 * (`holdsPartialWork`) instead of being force-removed with the rest of a failed run's residue.
 */
class WorktreeDirtyError extends PoisonEpic {}

export interface ExecuteEpicDeps {
  db: AntonDb;
  clock?: Clock;
  /** Override the branch prefix (default "anton"). */
  branchPrefix?: string;
}

/**
 * Who a run is, as its worktree claim records it. The RUN id, not the epic's: a resumed attempt takes
 * a fresh claim of its own, and naming the run is what makes a leftover claim traceable to the
 * attempt that took it — the same reason review-fix keys its owner by job id.
 */
export function claimOwnerFor(runId: string): string {
  return `execute-epic#${runId}`;
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
    // One ticket's budget (anton-t1mo). Read once for the whole run so every ticket in a feature is
    // measured against the same clock, and collected here so the run can report which tickets it
    // had to leave behind.
    const ticketTimeoutMs = resolveTicketTimeoutMs(settings);
    /** Tickets this run had to stop, and whether each got its work committed before it was stopped. */
    const timedOut: { id: string; committed: boolean }[] = [];

    // The project's OWN agents — a discoverable `agent:<id>` whose id anton does NOT ship as a
    // bundled specialist — are NEVER gated by the active-agents allowlist (anton-dvo.1 reversed):
    // the operator brought them and labels tickets with them deliberately, so a second opt-in in
    // Settings is pure friction. The allowlist governs anton's bundled NAMESPACE only; a bundled id
    // stays gated even when the operator has a `.claude/agents/<id>.md` override of it (else a
    // machine that mirrors every bundled name into ~/.claude/agents would slip the whole allowlist).
    // An id that resolves nowhere (a typo) is not in `discovered`, so it isn't exempted — it parks.
    // Fails safe to "no user agents" on a discovery error rather than crashing the run here.
    const userAgentIds = await Promise.all([discoverAgents(repo), bundledAgentIds()])
      .then(([discovered, bundled]) => {
        const bundledSet = new Set(bundled);
        return discovered.filter((a) => !bundledSet.has(a.id)).map((a) => a.id);
      })
      .catch(() => [] as string[]);

    // Load the run target + (for a grouping target) its tickets from beads (the source of truth).
    // A target is a feature, a parentless task/bug run as an epic-of-one, or a legacy epic with no
    // feature children (isRunTarget). Distinguish the non-runnable cases so the poison message is
    // honest: a bead that WAS found but isn't a valid target must not read "not found" (that sends
    // the operator hunting for a missing bead), and a container epic must be told it is one.
    // `loadAllIssues`, not a bare `bd list`: bd OMITS gate beads from every ordinary listing while
    // carrying the `blocks` edge a gate puts on the bead it gates, and every blocker helper treats a
    // blocker it can't see as still open (fail safe). Since a run now arms a `gh:pr` merge gate on
    // its own target (step 5, anton-k0kj), a bare list would leave that edge dangling and poison the
    // target's own recovery run forever. The second read only happens when a dangling edge exists.
    // STRICT: a swallowed gate-listing failure would leave that same edge dangling, and the blocker
    // check below reads an unknown blocker as open (fail safe) — so a transient bd failure would
    // poison the run instead of retrying it. Let it reject; the runner retries.
    let all = await loadAllIssues(repo, { strictGates: true });
    let target = all.find((b) => b.id === epicBeadId);
    if (!target) throw new PoisonEpic(`bead ${epicBeadId} not found on the board`);
    if (!beads.isRunTarget(target, all)) {
      if (beads.isContainer(target, all)) {
        throw new PoisonEpic(
          `epic ${epicBeadId} is a container, not a run target — it has feature children, and each ` +
            `feature runs on its own (own worktree, own PR); run one of its features instead`,
        );
      }
      const parent = beads.parentOf(target);
      throw new PoisonEpic(
        `bead ${epicBeadId} is not runnable: type "${target.issue_type ?? "unknown"}"` +
          (parent ? ` with parent ${parent}` : "") +
          ` — only a feature, a parentless task/bug, or an epic with no feature children can be run`,
      );
    }
    if (!beads.isApproved(target)) {
      throw new PoisonEpic(`target ${epicBeadId} is not approved — refusing to execute`);
    }
    // An abandoned target has nothing left to execute (anton-6xj0): a human declared the work
    // won't be done. Return cleanly instead of poisoning — a park would put an operator's own
    // decision back in front of them as a job needing attention, and there is no run row yet, so
    // nothing can be mistaken for a delivery. Reached by a job that was already queued (or is being
    // resumed) when the abandon landed; a job that was RUNNING is cancelled by the abandon itself.
    if (beads.isAbandoned(target)) return;

    // Unit-ness is type-only (isUnit reads `issue_type`), so unlike the grouping shape it genuinely
    // can't change across a pull — capture it here, while `target` is narrowed, and reuse it against
    // the freshly-pulled board in step 0; `target` is a `let` reassigned there, so reading it inside
    // this closure would widen back to `Bead | undefined`.
    const targetIsUnit = isUnit(target);
    const computeReadiness = (board: Bead[]): RunReadiness =>
      runReadiness(board, epicBeadId, targetIsUnit);

    // Re-check the same readiness gate the approval route enforces, now at job start. Approval only
    // guarantees readiness at approval time; between then and this lease a `blocks` edge could have
    // been added or pulled in via Dolt sync (a shared board), leaving this job queued behind a
    // blocker that's no longer done. Derive from the fresh `all` read above and PARK if NOTHING can
    // start — starting still-blocked work would violate the sequence. Recoverable: once the blocker
    // completes, resuming the parked job re-reads beads and passes this gate. Re-checked again in
    // step 0 after the cross-machine pull refreshes `all` (a blocker another machine pushed since
    // would be invisible to this pre-pull snapshot).
    const readiness = computeReadiness(all);
    if (!readiness.runnable) throw blockedRunPoison(epicBeadId, readiness, all);

    // A grouping target runs all its children into one PR; a leaf target IS its own single ticket
    // (an epic-of-one). The rest of the pipeline — worktree, per-ticket claude→tests→commit→close,
    // one PR — is identical either way, so the leaf case is just a one-element ticket list.
    // An epic always groups (a childless one poisons below, exactly as before the tier split); a
    // feature groups only once tickets have been shaped under it — a feature shaped as one unit of
    // work is its own ticket, so it must not poison for having no children. A parentless task/bug
    // is always a leaf, unchanged. The rule is shared with epic-detail (beads.groupsChildren) so a
    // run and its detail page never disagree about which tickets the target contains.
    // The ticket set is the target's whole working-layer SUBTREE (runTickets), the same set the
    // board card displays and counts — a direct-children run would merge the PR while leaving a
    // deeper subtask open under a finished run target.
    const children = runTickets(all, epicBeadId);
    let standaloneRun = !beads.groupsChildren(target, children);
    let tickets = standaloneRun ? [target] : children;
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
        jobId: ctx.jobId,
        branch,
        model: settings.model,
        status: "running",
      });
    } else {
      // The score goes with the attempt that earned it (anton-cekf). A resume REUSES the parked row,
      // so leaving it would let a resumed attempt that never reaches review settle carrying the
      // previous attempt's number — and the score breaker, which reads one score per row, would
      // judge this attempt on a review it never had and could re-latch the disarm a human just
      // cleared. Cleared here, and rewritten by the gate the moment this attempt is reviewed.
      // `jobId` moves with the attempt (anton-rgso): a resume is a NEW job over the same row, and a
      // cancel the operator raises from here names that job, not the one that first parked.
      await updateRun(db, clock, runId, {
        status: "running",
        jobId: ctx.jobId,
        error: null,
        reviewScore: null,
      });
    }

    // Cross-machine run-liveness lease (anton-jz1). `leaseLabels` tracks the run-lease labels this
    // run OWNS — its published lease plus any leftover leases it adopted to sweep. Start EMPTY so the
    // `finally` never clears a lease this run never took ownership of: in particular the foreign-lease
    // gate at the top of the try (below) parks before adopting anything, so the other machine's live
    // lease is left intact. Declared out here so the `finally` can tear the refresh timer down and
    // clear the lease on settle. `runId` stamps the owner onto every publish so a later resume can
    // tell this run's own crash leftover from another machine's live lease.
    let leaseLabels: string[] = [];
    let leaseTimer: ReturnType<typeof setInterval> | null = null;
    // Set true in `finally` so a refresh tick that hasn't started yet no-ops instead of publishing a
    // fresh lease after settle; `leaseRefreshInFlight` tracks the tail of the serialized refresh
    // chain (each tick chains onto it rather than overwriting — see the setInterval below) so
    // `finally` can await every queued/in-flight refresh before clearing the label (otherwise a slow
    // refresh write could re-publish an unexpired lease after the clear and leave the epic looking
    // live until TTL — anton-jz1).
    let leaseSettled = false;
    let leaseRefreshInFlight: Promise<void> = Promise.resolve();
    // Expiry (ms) of the last lease this run PUSHED to the shared remote — advanced only after the
    // push confirms, so it tracks remote-visible liveness, not just a local write. The cooperative
    // `assertLeaseHeld` guard reads it to park the run before a lease whose refresh pushes have been
    // failing silently lapses past its TTL and another machine treats the epic as free (anton-jz1).
    let leaseExpiry = 0;
    // What the review gate found on the branch when it failed with an error anton rethrows unchanged
    // (a usage limit, a transient claude failure) — the `catch` below folds it into that attempt's
    // run error, which is the only report those paths get. Declared out here for that reason.
    let orphanNotice = "";
    // The children this run reserved for its actor when it claimed the target (anton-0d85). Declared
    // out here for the same reason as `leaseLabels`: the stopping paths below have to hand back what
    // the try took — and only that — so the set has to outlive the block that took it. Null until the
    // claim gate runs, so every gate that parks before it releases nothing.
    let childCascade: { actor: string; ids: string[] } | null = null;
    // A needs-human wait this attempt left LIVE on the board — whether or not the park row landed
    // beside it. Declared out here because the `finally`'s cleanup is the last window a force-kill
    // can land in (anton-287p), and reconciling that window means taking THIS arm back — see
    // reconcileCancelledArmedPark.
    let armedPark: LiveArmedAsk | undefined;
    // Tear the checkout down after all — set only when the teardown KEPT it for the park above, and
    // called only when the cleanup's kill window unseats that park (see concludeCancelledArmedPark).
    let releaseGateKeptWorktree: (() => Promise<void>) | undefined;
    // The error this attempt throws, thrown AFTER the `finally` rather than from inside the catch,
    // so the cleanup's own kill window can still rewrite it. Undefined = nothing to throw.
    let settled: { thrown: unknown } | undefined;
    // Write the run row, ANSWERING with the failure instead of throwing (anton-287p): the settle
    // paths behind a live gate must report a rejected write in the run's error rather than let it
    // swallow the ask they exist to deliver.
    const reportSettle = async (patch: RunPatch): Promise<string | undefined> => {
      try {
        await updateRun(db, clock, runId, patch);
        return undefined;
      } catch (failure) {
        return failure instanceof Error ? failure.message : String(failure);
      }
    };
    // The worktree this attempt warmed, hoisted for the same reason as the two above: EVERY terminal
    // outcome owes it back (anton-hrun.1), and the stopping paths live in the `catch`, outside the
    // block that created it. Null until step 2, so a run that parked before warming releases nothing.
    let runWorktree: Worktree | null = null;
    // This attempt's claim on the checkout, held for as long as it is executing in it (anton-hrun.1)
    // and named here so every stopping path can give it back. Null until step 2 takes it.
    let worktreeClaim: string | null = null;
    /**
     * Give the checkout back. Called before every teardown — the teardown force-removes the
     * directory, and a live claim (this run's own included) is precisely what refuses that — and
     * again in `finally`, which is what covers the stops that KEEP the worktree: a parked run resumes
     * in it, but is no longer executing in it, so nothing may go on reading the claim as occupancy.
     * Idempotent, and best-effort like the teardown it precedes.
     */
    const releaseWorktreeHold = async () => {
      const owner = worktreeClaim;
      if (!owner) return;
      worktreeClaim = null;
      await safe(() => releaseWorktreeClaim(repo, branch, owner));
    };
    // Publish/refresh this run's lease. Advances `leaseLabels` ONLY after the write lands (not
    // best-effort like the other bd writes): a swallowed failure that still advanced the tracked
    // label would let `finally` clear a label that isn't on the board while the real prior lease
    // lingers until TTL, and would report a shared lease that was never written. So this throws on
    // failure — the initial publish fails closed (a run holding no shared lease could be double-run
    // by another machine), while the refresh timer catches + logs instead of crashing the process.
    const publishLease = async () => {
      const exp = clock.now() + RUN_LEASE_TTL_MS;
      await beads.publishRunLease(repo, epicBeadId, exp, leaseLabels, runId);
      leaseLabels = [LABELS.runLease(exp, runId)];
      // Pushing the lease to the shared remote is REQUIRED, not a fire-and-forget nudge (anton-jz1):
      // the cross-machine guard only holds if OTHER machines' liveRunCheck can read this lease off the
      // Dolt remote, so a lease that lands locally but never pushes is invisible to them and lets them
      // double-run the epic. Await the push and let it throw on failure — the caller decides what a
      // failed publish means: the initial publish (step 1) fails the run closed; a refresh tick logs
      // and, because `leaseExpiry` is advanced only AFTER the push confirms below, leaves it un-bumped
      // so `assertLeaseHeld` parks the run before the stale lease lapses. `beads.sync` tolerates a
      // no-remote workspace (resolves without pushing), so a single-machine run advances normally.
      await beads.sync(repo);
      leaseExpiry = exp;
    };

    try {
      // 0. Cross-machine double-run guard (anton-jz1). A queued job that reschedules (quota/backoff)
      //    re-enters this handler WITHOUT the enqueue-time liveRunCheck. If a Force run started on
      //    ANOTHER machine while this job was parked/backing off, the target now carries that
      //    machine's unexpired run-lease. Pull the shared board and re-read the target FRESH before
      //    deciding: the `all` snapshot up top was taken before any of this setup, so a lease another
      //    machine published since (the sync heartbeat is periodic) would be invisible to a check
      //    against that stale bead and this gate would miss the concurrent run. Publishing our own
      //    lease (below) sweeps `leaseLabels`, so overwriting a foreign one would let BOTH machines
      //    run the epic at once — the exact double-run this lease exists to prevent. Treat a foreign
      //    live lease as a park/retry: RunAlreadyLiveError reschedules this job (refunding the
      //    attempt) to re-check once that run settles and clears its lease. This run's OWN lease
      //    (same runId, e.g. stranded by a crashed prior attempt) is not foreign and is adopted just
      //    below as a sweep leftover. Checked before any claim/worktree/session work so a run never
      //    half-executes into a concurrent one. Best-effort pull: a failure degrades to the last
      //    local snapshot rather than blocking a legitimate run.
      //    Track whether this pre-check ran against a TRUSTED (fresh) board read. A stale snapshot —
      //    the pull failed, or the show fell back to the top-of-handler `all` — can hide an
      //    already-live incumbent lease published by a run that started earlier. That incumbent only
      //    arbitrates the lease at ITS OWN startup and keeps running regardless of what we decide, so
      //    the post-publish race arbitration (step 1b) must NOT steal the lease from it by owner order
      //    when our pre-check couldn't rule it out (anton-jz1).
      let preCheckTrusted = true;
      try {
        await beads.pull(repo);
      } catch {
        preCheckTrusted = false; // stale local snapshot — an incumbent lease may be invisible below
      }
      let leaseTarget = target;
      try {
        leaseTarget = await beads.show(repo, epicBeadId);
      } catch {
        preCheckTrusted = false; // fell back to the stale top-of-handler snapshot
      }

      // Re-derive the ticket list from the freshly-pulled board (anton-jz1). `all`/`target`/`tickets`
      // up top were read BEFORE the pull above, so on a cross-machine retry a child ticket another
      // machine closed — then crashed before stamping the PR ref — still shows OPEN in that stale
      // snapshot. The ticket loop (step 4) skips only tickets whose status is `closed`, so iterating
      // the stale list would re-run claude and re-commit work the just-pulled board already reflects as
      // done. Re-list here so those remotely-closed tickets are skipped. Best-effort like the pull: a
      // failed re-list keeps the pre-pull snapshot (no worse than before this refresh existed). The
      // target's SHAPE is re-derived from the adopted board too, but in 0a-ter below — after the
      // completion short-circuit, alongside the other gates that must not fire on a finished run.
      try {
        // Strict for the same reason as the read up top — and here the catch already does the right
        // thing with a rejection: keep the gate-complete pre-pull snapshot rather than adopting a
        // fresh board whose gates are missing.
        const fresh = await loadAllIssues(repo, { strictGates: true });
        const freshTarget = fresh.find((b) => b.id === epicBeadId);
        if (freshTarget) {
          all = fresh;
          target = freshTarget;
          tickets = standaloneRun ? [target] : runTickets(all, epicBeadId);
          // Adopt the fresh bead for the liveness gates too (anton-jz1). When the `show` above failed
          // but this list succeeds, `leaseTarget` still points at the stale pre-pull snapshot — yet the
          // completion short-circuit (step 0a, reads the PR ref via getPrRef) and the foreign-lease gate below
          // read `leaseTarget`. Leaving it stale would let a run whose completion/lease is visible in
          // this fresh list fall through into worktree/PR handling instead of finishing idempotently.
          leaseTarget = freshTarget;
        }
      } catch {
        // keep the pre-pull snapshot
      }

      // 0a. Revalidate the target still needs execution (anton-jz1). A job that parked on a foreign
      //     live lease (foreignRunLeaseLive below) or lost the publish race (step 1b) reschedules and
      //     re-enters this handler once that lease clears — but the run that HELD the lease may have
      //     already carried this epic all the way to in-review: opened the PR, stamped the external
      //     ref, and cleared its lease on settle. Without this gate the loser would proceed, skip the
      //     already-closed tickets, and re-enter the PR step — creating a duplicate/empty PR or parking
      //     on a `gh "a pull request already exists"` failure. The PR ref is set ONLY by a
      //     completed PR step (step 5, setPrRef), but its mere PRESENCE is NOT proof another run
      //     finished: review-fix deliberately LEAVES the ref on a bead whose PR was CLOSED without
      //     merging so a Run/Force run can recover it. So a ref only marks completion when its PR is
      //     still live — open (review in flight) or merged; a closed-unmerged ref is stale and must
      //     fall through to the recovery path below (checked via `pullRequestState`). Nothing is left
      //     for execute-epic to do only in the live/merged case, so there we finish this attempt as
      //     done (idempotent) and settle this machine's run row rather than redoing covered work.
      //     Checked BEFORE the foreign-lease gate so a still-lingering lease from the finishing run
      //     can't re-park an epic that's already complete, and BEFORE adopting/publishing any lease so
      //     `finally` clears nothing we don't own. A stale board read (pull/show failed) simply won't
      //     show the ref yet and falls through to the lease gate below.
      // Read the PR pointer through the seam (anton-76ej): `metadata.pr`, or a legacy `gh-*`
      // external_ref as a fallback. A tracker URL parked in external_ref (e.g. Linear) is NOT a PR
      // pointer, so getPrRef ignores it — enabling a tracker integration can never trip this guard.
      const prRef = beads.getPrRef(leaseTarget);
      if (prRef) {
        // Distinguish a stale (closed-without-merging) ref from one that proves completion (anton-jz1).
        // Only an OPEN or MERGED PR means another run carried this epic to the finish; a CLOSED-unmerged
        // ref is what review-fix leaves for recovery, so DON'T short-circuit on it — fall through and let
        // this run re-open the PR. An UNKNOWN state (no `gh`, a network/CLI error, an unparseable ref) is
        // proof of NOTHING and must not be mistaken for either: treating it as done would strand a
        // genuinely-closed epic that a retry could recover, while falling through with a genuinely-merged
        // ref would run `gh pr create` on a branch with no diff and fail the run. So retry on unknown with
        // a COUNTING error (a plain throw, NOT RunAlreadyLiveError): a transient gh/network hiccup
        // self-heals within the retry budget, but a permanently-unreadable ref (gh missing, broken auth,
        // malformed ref) exhausts `maxAttempts` and PARKS for a human instead of retrying forever.
        // RunAlreadyLiveError is reserved for real lease/liveness conflicts, which the runner refunds and
        // retries indefinitely because a foreign run may legitimately hold the lease for a long time — an
        // unreadable ref is a local failure to resolve, not that, so it must count against the budget.
        const prState = await pullRequestState(repo, prRef);
        if (prState === "unknown") {
          throw new Error(
            `${epicBeadId} carries a PR ref but its state can't be read (gh unavailable or the ref is ` +
              `unparseable) — retrying rather than treating an unreadable PR as a completed run; a ` +
              `transient gh outage self-heals within the retry budget, a permanently-unreadable ref ` +
              `parks for a human`,
          );
        }
        if (prState === "open" || prState === "merged") {
          // Sweep this run's OWN leftover lease before the idempotent short-circuit (anton-jz1). If this
          // attempt resumes after a crash that landed the PR ref (step 5, setPrRef) but died
          // before `finally` cleared its run-lease, `leaseTarget` still carries an unexpired
          // `run-lease:…:<runId>` this run published. The general lease-adoption step (`leaseLabels =
          // runLeaseLabels(...)`) runs AFTER this return, so without adopting here `finally` would clear
          // nothing and other machines would keep seeing the epic as live until the TTL even though its
          // PR is already open. Adopt only OUR OWN lease (matched by runId) so `finally` clears it; a
          // foreign machine's lease is left for its own owner/TTL, honoring "finally clears only what we
          // own" (the same reason this gate precedes the general adoption below).
          leaseLabels = beads.ownRunLeaseLabels(leaseTarget, runId);
          // Restore the in-review board state before returning (anton-jz1). An epic run that crashed
          // AFTER setPrRef (step 5) but before the stage updates at the tail of step 5 leaves the
          // epic on stage:implementing with no stage:in-review. review-fix sweeps only stage:in-review
          // targets (see review-fix.ts), so without re-applying it here the run is marked done yet its
          // PR never enters the automated review/finalization path. Idempotent — a run that already
          // tagged in-review re-tags harmlessly. Standalone targets get in-review from runTicket on
          // commit (before the ref is ever set), so only the epic path needs this here.
          if (!standaloneRun) {
            await safe(() => beads.tag(repo, epicBeadId, [LABELS.stage("in-review")]));
            await safe(() => beads.untag(repo, epicBeadId, [LABELS.stage("implementing")]));
          }
          // Reconcile the merge gate here too, for the same reason the stage label is restored
          // (anton-k0kj): arming it is the LAST thing step 5 does, so a crash after setPrRef — or a
          // `gateCreate` the best-effort `safe` there swallowed — leaves this target gate-less, and
          // every later attempt takes THIS return instead of step 5. Without this the wait never
          // becomes board state: the merge is only ever noticed by the legacy review-fix sweep and no
          // timeout can surface a stall. Idempotent by construction (mergeGatePlan returns
          // `create: false` when this PR's gate already exists), so the common no-op short-circuit
          // writes nothing. Armed for a MERGED ref as well as an open one — gate-check closes it on
          // the next pass and dispatches finalization, which is exactly what this target still needs.
          await safe(() => armMergeGate(repo, epicBeadId, prRef, all));
          // Clean up any worktree a prior attempt left behind before short-circuiting (anton-jz1). A
          // resume that crashed AFTER the worktree-warm step (step 2 stamps `worktreePath` on the run
          // row) leaves the git worktree registered/on disk; this idempotent return skips the normal
          // teardown at the tail of the try, so without this the run is marked done yet its worktree
          // lingers. Locate it by branch — this attempt never warmed one, so `runWorktree` is null and
          // the `catch`'s teardown could not see it either.
          //
          // Routed through the same teardown as every other terminal exit (anton-hrun.1) rather than a
          // bare removal: this is a `done` outcome like any other, so it owes the same branch policy (a
          // merged PR on a closed bead takes the branch with it) and the same session account.
          //
          // A prior attempt that DID tear its checkout down leaves branch-only residue, which owes
          // that same policy — so an absent checkout falls back to the synthetic descriptor the
          // teardown accepts (as review-fix's finalize does): a merged PR on a settled target takes
          // the branch here, instead of leaving it for the next scheduled sweep.
          // Best-effort — a run whose PR is already open must not fail over a cleanup.
          await safe(async () => {
            const staleWorktree: Worktree = (await findWorktree(repo, branch)) ?? {
              path: worktreePathFor(repo, branch),
              branch,
              baseBranch: branch,
              repoPath: repo,
            };
            await releaseRunResources({
              db,
              clock,
              ctx,
              projectId,
              runId,
              repoPath: repo,
              worktree: staleWorktree,
              beadId: epicBeadId,
              status: "done",
            });
          });
          await updateRun(db, clock, runId, { status: "done", endedAt: clock.now(), error: null });
          return;
        }
        // Closed-without-merging ref → stale. Fall through to recover the epic: the foreign-lease gate
        // and general lease adoption below run as usual (nothing adopted here so `finally` owns only what
        // the recovery path takes), the closed tickets are skipped, and step 5 re-opens the PR.
      } else {
        // 0a, the other half of the same question. A send-back RETIRED a PR off this target
        //     (anton-leit) and that PR has since merged. The retire took the ref off on purpose —
        //     this run is the one it exists to let through — but it left the PR named on the bead
        //     (beads.retirePrRef), and a merge landing in that window changes the answer
        //     completely: the work is on
        //     the base branch now, a squash-merge left none of the tickets' `<id>:` commit subjects
        //     to recognise it by, and executing would re-dispatch shipped work onto a branch whose
        //     PR is closed. rework refuses exactly this (resolvePipeline: merged work comes back as
        //     its own target), so a merge that beat the rerun must not get in through the back door.
        //     PARK for the founder, whose call it is: the fix belongs on a new run target, which a
        //     fresh send-back now produces (resolvePipeline reads the retired pointer too).
        //     Only consulted when there is no live ref — a re-stamped one is the live answer and
        //     clears this pointer (beads.setPrRef) — and only when one was actually retired, so the
        //     ordinary run pays no `gh` call. An UNREADABLE state retries, exactly as the live-ref
        //     branch above does and for the same reason: `unknown` is proof of nothing, so letting it
        //     fall through to execute would re-dispatch shipped work whenever the retired PR had in
        //     fact merged — the corruption this branch exists to prevent, now decided by a `gh`
        //     outage. Running is not the cheap fallback it looks like either: `gh` is a hard
        //     dependency of the run (step 5 opens/updates the PR), so a run that cannot read it
        //     cannot finish. COUNTING (a plain throw), so a transient outage self-heals within the
        //     retry budget and a permanent one parks for a human instead of retrying forever.
        const retiredPr = beads.getRetiredPrRef(leaseTarget);
        if (retiredPr) {
          const retiredState = await pullRequestState(repo, retiredPr);
          if (retiredState === "unknown") {
            throw new Error(
              `${epicBeadId} was sent back with ${retiredPr} still open, and that pull request's ` +
                `state can't be read (gh unavailable or the ref is unparseable) — retrying rather ` +
                `than re-running a target whose work may already have merged; a transient gh outage ` +
                `self-heals within the retry budget, a permanently-unreadable ref parks for a human`,
            );
          }
          if (retiredState === "merged") {
            throw new PoisonEpic(
              `${epicBeadId} was sent back with ${retiredPr} still open, but that pull request has ` +
                `merged since — its work is on the base branch, so re-running this target would ` +
                `re-dispatch shipped tickets. Send the ticket back again: anton reads ${retiredPr} as ` +
                `merged now and carries the fix as its own run target instead.`,
            );
          }
        }
      }

      // 0a-bis. Re-run the job-start readiness gate against the freshly-pulled board (anton-jz1).
      //     The top-of-handler `blockers` check ran on the PRE-pull `all`, so a `blocks` edge
      //     another machine pushed before this pull is invisible there — and the `fresh` adoption
      //     above swapped `all`/`tickets` to the pulled board WITHOUT re-checking readiness, which
      //     would let this path execute a now-blocked epic and bypass the gate. Recompute from the
      //     adopted board and PARK if a blocker reopened (recoverable, same as the top gate).
      //     Checked AFTER the completion short-circuit (step 0a) so a genuinely-finished epic still
      //     takes the idempotent "done" path instead of parking, and BEFORE adopting/publishing any
      //     lease (below) so a park leaves nothing for `finally` to clear.
      //     This verdict is also what the ticket loop dispatches by (anton-1two), so the gate and the
      //     dispatch can't disagree about which tickets a cross-run blocker holds: `gated` is read
      //     from the same pulled board the loop iterates.
      const freshReadiness = computeReadiness(all);
      if (!freshReadiness.runnable) throw blockedRunPoison(epicBeadId, freshReadiness, all);
      const gated = new Set(freshReadiness.gated);

      // 0a-ter. Re-derive the target's SHAPE against the freshly-pulled board. Runnability and
      //     grouping are properties of the whole BOARD, not of the bead: another machine can add or
      //     remove a feature's first child between the top-of-handler list and the pull above. A
      //     legacy epic that just gained a feature is now a container — carrying the pre-pull shape
      //     forward would execute (and CLOSE) that unapproved feature as one of its own tickets —
      //     and a feature that just gained its first ticket must run that ticket instead of
      //     implementing itself. Recomputed from `all` unconditionally: when the re-list failed,
      //     `all` is still the pre-pull snapshot and this reproduces the top-of-handler result.
      //     Placed with 0a-bis for the same reason — AFTER the completion short-circuit, so an epic
      //     whose PR is already live still settles idempotently instead of parking on a shape change
      //     that no longer has any work to gate, and BEFORE any lease is adopted or published.
      if (!beads.isRunTarget(target, all)) {
        throw new PoisonEpic(
          beads.isContainer(target, all)
            ? `epic ${epicBeadId} gained a feature child while this run was queued — it is now a ` +
              `container, not a run target; run one of its features instead`
            : `bead ${epicBeadId} is no longer a run target (type "${target.issue_type ?? "unknown"}")` +
              ` — refusing to execute`,
        );
      }
      const freshChildren = runTickets(all, epicBeadId);
      standaloneRun = !beads.groupsChildren(target, freshChildren);
      tickets = standaloneRun ? [target] : freshChildren;
      if (tickets.length === 0) throw new PoisonEpic(`epic ${epicBeadId} has no tickets`);

      if (beads.foreignRunLeaseLive(leaseTarget, clock.now(), runId)) {
        throw new RunAlreadyLiveError(
          `${epicBeadId} is already running on another machine (unexpired run-lease) — parking; ` +
            `this attempt resumes once that run settles and clears its lease`,
          "foreign",
        );
      }
      // No foreign live lease: adopt any leftover leases on the freshly-read target (this run's own
      // from a crashed prior attempt, or an expired dead one from any machine) so the first publish
      // atomically replaces them. Set here — after the gate — so the `finally` only ever clears
      // leases we own.
      leaseLabels = beads.runLeaseLabels(leaseTarget);

      // A standalone target that already committed on a prior attempt carries stage:in-review and
      // is skipped straight to the PR step below — its agent never runs again on this resume. The
      // allowlist gate here, the ticket loop and the approve route share ONE "won't run" predicate
      // (ticket-view `resumeSkipped`) so none of them acts on a resume marker: gating on a
      // since-disabled agent would park a retry that only has the (agent-free) PR step left to do.
      // Caveat: "won't run" holds only when the ticket's commit is actually on this branch. A
      // done-on-board ticket whose commit is missing (cross-machine resume) DOES re-run, so the loop
      // re-applies this allowlist gate there — the worktree needed to prove commit presence doesn't
      // exist yet at this point.
      const isResumeSkipped = (t: Bead) => resumeSkipped(t, standaloneRun);

      // 0b. Dispatch honors the active-agents allowlist for anton's BUNDLED specialists (anton-dm7);
      // the project's own `.claude/agents` (userAgentIds) are always allowed. PARK, don't skip:
      // running the ticket with the default agent would silently produce work the operator disabled
      // the specialist for, and skipping it would open the epic's single PR incomplete. Parking is
      // recoverable — the operator enables the agent (Settings → Agents) or relabels the ticket,
      // then resumes; tickets and settings are re-read on every attempt. Checked before any
      // claim/worktree/session work so a run never half-executes into a config problem.
      const inactive = inactiveAgentTickets(
        tickets.filter((t) => !isResumeSkipped(t)),
        settings.agents,
        userAgentIds,
      );
      if (inactive.length > 0) {
        throw new PoisonEpic(
          `epic ${epicBeadId} needs agents enabled in this project's settings: ` +
            inactive.map((x) => `${x.id} → agent:${x.agent}`).join(", ") +
            ` — enable them in Settings → Agents (or relabel the tickets), then resume the run`,
        );
      }

      // 0c. Dispatch honors the bead contract (anton-j9zs) — the target plus every ticket this run
      // will actually dispatch. A BLOCKING gap (no Acceptance on a ticket, no Success Criteria on
      // an epic) leaves the agent with no definition of done and self-review with no rubric, so the
      // run would produce work nothing can judge. PARK, don't skip, for the same reason as the
      // allowlist gate above: skipping the ticket opens the epic's single PR incomplete. Recoverable
      // — the operator writes the missing section (`bd update --acceptance`) and resumes.
      // Judged against the FRESHLY-PULLED board: `target`/`tickets` were re-read in step 0 (and
      // re-derived in 0a-ter), so a bead repaired between approve and dispatch passes this gate
      // rather than parking on the enqueue-time snapshot. Resume-skipped beads are excluded exactly
      // as above — a ticket whose work is already committed won't run its agent again, so its spec
      // can't strand this attempt; if it turns out it WILL re-run (the cross-machine
      // commit-missing case), the ticket loop re-applies this gate there. When the whole set is
      // resume-skipped this run dispatches no agent at all — the closed-PR recovery that falls
      // through step 0a with only the (agent-free) PR step left — so it is gated on nothing, in the
      // grouped shape as well as the standalone one.
      // The set comes from the same helper the approve route and the board card use
      // (`contractGatedBeads`), so a target this parks on is one the board already marked and
      // approval already refused, rather than a surprise at dispatch.
      const contractGated = contractGatedBeads(target, freshChildren);
      const contractBlocking = contractGaps(contractGated, "blocking");
      if (contractBlocking.length > 0) {
        throw new PoisonEpic(
          `epic ${epicBeadId} has beads that don't meet the bead contract: ` +
            formatContractGaps(contractBlocking) +
            ` — write the missing section(s), then resume the run`,
        );
      }
      // Advisory gaps NEVER gate — they cost quality, not runnability. Logged so a degraded run is
      // visible rather than silent, then the run proceeds.
      const contractAdvisory = contractGaps(contractGated, "advisory");
      if (contractAdvisory.length > 0) {
        console.warn(
          `[execute-epic] ${epicBeadId} runs with advisory contract gaps: ` +
            formatContractGaps(contractAdvisory),
        );
      }

      // 0d. Validate the project's run pipeline (anton-hrql). The formula is what a run walks, so a
      //     broken one must fail at the START of a run rather than halfway through: cook it and
      //     resolve every step's handler here — before the lease is published and before any worktree
      //     exists — so an unparseable file, a key bd would silently drop, or a `step:` label that
      //     maps to no handler parks with the file path and the offending step instead of stranding a
      //     half-executed run. PARK, like the gates above: the operator fixes the file (or deletes it
      //     to fall back to anton's default) and resumes. Cheap and read-only — the project copy when
      //     it has one, else anton's bundled default.
      //     Then hold the cooked pipeline to anton's invariant floor (anton-6b99): the project owns
      //     the steps, anton owns the guarantees, so a formula may ADD steps freely but may not omit
      //     implement/commit/pr or order them so the run's work is thrown away (a PR opened before
      //     the commit, an agent dispatched after it). Same park, same place — before the worktree.
      //     WHICH pipeline is a per-label choice (anton-aa3m): the project may map a bead label to a
      //     formula of its own, so this run walks the first mapped label the TARGET carries (one run
      //     is one worktree and one PR, so it walks one pipeline), else the project's default. The
      //     floor is applied to whatever came back — selection only changes which file is loaded —
      //     so a variant cannot escape it. The choice is then recorded ON THE RUN below rather than
      //     left to be inferred from settings and labels that may since have changed.
      //     Selection happens ONCE PER BRANCH, not once per attempt: an attempt that already
      //     recorded a pipeline pins it, and this one re-validates that source instead of selecting
      //     again. Every attempt re-reads the board and the settings, so re-selecting would let a
      //     label added since (`stage:implementing` — which this very job adds below — or an
      //     operator's relabel) or an edited variant map switch pipelines after some tickets had
      //     already committed, while the record below claimed the whole run used the new one. The
      //     pin is not limited to the open run row: an ordinary handler error settles the row
      //     `failed`, so the runner's retry lands here with `existing` undefined while still reusing
      //     that attempt's worktree and its committed tickets — hence the branch-scoped lookup
      //     (findRunFormulaForBranch), which is the same continuity the retry itself resumes by.
      //     `{{var}}` values make this a RUNTIME cook: the pipeline is resolved with the run's own
      //     target, and bd's "every declared variable needs a value" check fires here rather than a
      //     formula anton cannot satisfy walking with literal placeholders in it.
      const pinnedFormula = existing?.formula
        ? { source: existing.formula, variant: existing.formulaVariant ?? undefined }
        : await findRunFormulaForBranch(db, projectId, epicBeadId, branch);
      const formula = await validateRunFormula(repo, {
        labels: target.labels,
        variants: settings.formulaVariants,
        pinned: pinnedFormula,
        vars: { target: epicBeadId },
      });
      assertRunFormulaFloor(formula);
      // `recorded`, not `source`: anton's bundled default is stored as a sentinel rather than an
      // install-absolute path, so a run in flight across an upgrade that moved the install root
      // re-reads the pipeline it pinned instead of parking on a path that only changed.
      await updateRun(db, clock, runId, {
        formula: formula.recorded,
        formulaVariant: formula.variant ?? null,
      });
      // The pipeline this run walks (anton-lnkt), split at the commit into its two phases. Steps run
      // ONE AT A TIME — they share one worktree and one PR, so a formula whose steps could run
      // concurrently is not a licence to fan out.
      const { ticketSteps, runSteps } = splitFormulaPhases(formula);

      // 1. Publish the cross-machine run-liveness lease BEFORE any slow setup — worktree creation,
      //    operator resolution, the epic claim — and keep it fresh while this run executes
      //    (anton-jz1). Acquiring it up front closes the window where another machine's Force run
      //    (whose local jobs table is empty) sees no lease during our setup and starts a second
      //    concurrent run; the fresh foreign-lease gate above already ruled out an existing one. The
      //    initial publish fails closed (publishLease throws if the label can't be written OR pushed
      //    to the shared remote) — a run whose lease no other machine can see must not proceed. The
      //    timer is unref'd so it never keeps the process alive, is torn down in `finally`, and its
      //    refresh failures are caught + logged (with `assertLeaseHeld` parking the run if they
      //    persist past the TTL) rather than fatal.
      //    Fail closed as a PARK, not a hard failure (anton-jz1). A transient board outage (Dolt
      //    remote/CLI unavailable) at run start leaves us unable to prove we hold the shared lease —
      //    the same "can't prove liveness" condition steps 1b/assertLeaseHeld already treat as a
      //    RunAlreadyLiveError (park + retry, refunding the attempt and cooling off until the board is
      //    reachable). Marking it `failed` instead would burn retry attempts on a temporary outage and
      //    eventually strand an approved job for a human. Not proceeding is what matters here; parking
      //    doesn't proceed any more than failing does, and it recovers on its own.
      // Steps 1 → 1c run under the TARGET's own bead write lock (anton-e42l). The lease and the
      // confirmation read below are what stop an approved gardener re-parent attaching a ticket to a
      // set this run has already selected — but a read alone serializes nothing: the gardener writes
      // under `withBeadWriteLock` (gardener/apply.ts `applyStep` locks the subject AND the home), and
      // it yields between passing `homeUnusable` and running the write. Outside that lock, this
      // confirmation could land in exactly that gap, see the old ticket set, and let the run proceed
      // while the delayed re-parent hangs a ticket nothing will dispatch — later closed unrun with
      // the target. Holding the home's lock across the publish and the confirmation makes the two
      // orders real: either the re-parent completes first and this read sees the drift (retry), or it
      // queues behind this block and its own locked re-read finds the live lease (refuse). Released
      // before the claim in step 3, which takes this same lock (beads/claim.ts) — nothing inside here
      // may take it, on pain of deadlock.
      await withBeadWriteLock(repo, epicBeadId, async () => {
        try {
          await publishLease();
        } catch (e) {
          throw new RunAlreadyLiveError(
            `${epicBeadId} could not publish its run-lease to the shared board (${
              e instanceof Error ? e.message : String(e)
            }) — parking rather than proceeding without a lease other machines can see; this attempt ` +
              `resumes once the board is reachable`,
          );
        }

        // 1b. Read-after-write conflict check (anton-jz1). The foreign-lease gate in step 0 read the
        //     board BEFORE this publish, so it can't serialize two machines that force-run the same
        //     epic at the same instant: both clear the gate before either lease is visible remotely,
        //     then both publish. Our lease was already pushed to the remote by the required publish in
        //     step 1; now re-pull so a concurrently-published foreign lease becomes visible, then
        //     re-read and arbitrate: winsRunLeaseRace keeps the lease for the lexicographically-lowest
        //     owner runId, so of two runs that both published, exactly one proceeds and the other parks
        //     (RunAlreadyLiveError → reschedules, re-checks once the winner settles). The pull is
        //     REQUIRED, not best-effort (anton-jz1): a swallowed pull failure would arbitrate against a
        //     stale local view that can't see the other machine's lease, so both could conclude they
        //     won — the exact double-run this step exists to break. If the pull fails we can't prove we
        //     won, so we fail closed (park + retry) rather than proceed. Throwing here (before the
        //     refresh timer is armed) means `finally` (leaseTimer still null) tears down only the lease
        //     this run published.
        const arbitrateRunLease = async () => {
          try {
            await beads.pull(repo);
          } catch (e) {
            throw new RunAlreadyLiveError(
              `${epicBeadId} could not refresh the shared board to arbitrate the run-lease race (${
                e instanceof Error ? e.message : String(e)
              }) — parking so a concurrent run on another machine isn't ignored; this attempt resumes ` +
                `once the board is reachable`,
            );
          }
          const acquired = await beads.show(repo, epicBeadId).catch(() => null);
          // Fail closed when this re-read fails (anton-jz1). It's the ONLY check confirming no
          // concurrent lease won the race; a null here (DB lock, transient CLI error, malformed output)
          // means we can't prove we won, so park + retry like the pull failure above rather than fall
          // through and proceed while another machine may hold a live lease.
          if (!acquired) {
            throw new RunAlreadyLiveError(
              `${epicBeadId} could not re-read the target to arbitrate the run-lease race — parking so a ` +
                `concurrent run on another machine isn't ignored; this attempt resumes once the board is reachable`,
            );
          }
          // If the step-0 pre-check was stale, an already-live incumbent lease could have been invisible
          // then and only surfaces now. That incumbent won't re-arbitrate, so winsRunLeaseRace's
          // lowest-owner-wins tiebreak would let us steal the lease and double-run. Park on ANY foreign
          // live lease instead of arbitrating by owner order (anton-jz1). A trusted (fresh) pre-check
          // guarantees no incumbent existed, so a foreign lease seen now is a symmetric racer and IS
          // safely arbitrable below.
          if (!preCheckTrusted && beads.foreignRunLeaseLive(acquired, clock.now(), runId)) {
            throw new RunAlreadyLiveError(
              `${epicBeadId} found a live run-lease from another machine after a stale pre-check — parking ` +
                `rather than stealing by owner order (that run started earlier and won't yield); this ` +
                `attempt resumes once it settles and clears its lease`,
              "foreign",
            );
          }
          if (!beads.winsRunLeaseRace(acquired, clock.now(), runId)) {
            throw new RunAlreadyLiveError(
              `${epicBeadId} lost the run-lease race to a concurrent run on another machine — parking; ` +
                `this attempt resumes once that run settles and clears its lease`,
              "foreign",
            );
          }
        };
        // Arbitrate, settle, then arbitrate AGAIN before committing to run (anton-jz1). A single
        // post-publish read can't close the race the reviewer flagged: winsRunLeaseRace returning true
        // means "no foreign lease that beats us is VISIBLE", but on an eventually-consistent board a
        // machine that force-ran the same instant may simply not have propagated its lease yet — so a
        // fast publish→read wins uncontested while the slower racer, re-reading later, sees both leases
        // and (if it sorts lower) also wins. That's the asymmetric-read double-run. The first call
        // parks us fast if we've already clearly lost; the settle then gives a near-simultaneous foreign
        // lease time to reach the remote, and the second call re-reads and re-arbitrates against it — so
        // an "uncontested" win is only trusted once it has survived a propagation window rather than
        // being acted on the instant no rival is visible. `clock.sleep` is the real wall-clock wait in
        // production (systemClock); test clocks omit it, so the settle is a no-op and the second read
        // runs immediately against the same fake board. This narrows, but (like the rest of this
        // protocol) can't fully close, the window — a true cross-machine lock/CAS would; beads/Dolt
        // offers none.
        await arbitrateRunLease();
        await clock.sleep?.(RUN_LEASE_SETTLE_MS);
        await arbitrateRunLease();

        // 1c. Re-confirm the ticket selection against a board that can SEE this run (anton-e42l).
        //     Steps 0a-ter/0b/0c chose and gated the tickets from a read taken BEFORE the publish
        //     above, and until that lease landed the target carried neither a lease nor a claim — so
        //     for that whole window it reads as free work to anyone else. An approved gardener
        //     re-parent is the case that matters: its home check (gardener/apply.ts `homeUnusable`)
        //     asks exactly "is a run holding this card", sees nothing, and attaches a ticket this run
        //     has already finished selecting. That newcomer is never dispatched, and merge
        //     finalization closes it unrun along with the rest of the target's subtree.
        //     The lease is now published, pushed and arbitrated, and this read runs under the
        //     target's write lock (see the wrapper above) — which is what makes it a serialization
        //     point rather than just a later read: a move that landed before it is IN this board, and
        //     one that has not written yet cannot write until the lock is released, by which time its
        //     own locked re-read sees the live lease and refuses. Cross-machine the lock buys
        //     nothing, and the lease is still the only guard there. A set that differs means our
        //     selection is the stale half of
        //     that race — retry (a plain Error, not a park) so the next attempt re-gates and runs the
        //     whole set rather than silently dropping the newcomer. Converges: the retry re-reads the
        //     board from the top and selects the set this read just saw.
        //     Fails closed on an unreadable board, like the arbitration reads above — we cannot prove
        //     the set is stable — and costs nothing, since no worktree exists yet.
        //     Status-blind by construction: `runTickets` filters on shape, not state, so a ticket
        //     another machine closed mid-window is still in both sets and doesn't trip this.
        let confirmedBoard: Bead[];
        try {
          confirmedBoard = await loadAllIssues(repo, { strictGates: true });
        } catch (e) {
          throw new Error(
            `${epicBeadId} could not re-read the board after publishing its run-lease to confirm its ` +
              `ticket set — retrying rather than executing a selection that may already be stale. ` +
              `(${e instanceof Error ? e.message : String(e)})`,
          );
        }
        //     The target's OWN run shape is re-confirmed here, not just its subtree: a parentless
        //     task/bug re-parented under another card in this same window keeps an EMPTY ticket set
        //     on both sides of the drift check below, so nothing would fire while the bead has
        //     become a ticket in someone else's run — executed here as well as there. PARK rather
        //     than retry, like 0a-ter: a target that stopped being one doesn't become one again by
        //     trying, and the message names what took it.
        const targetDrift = runTargetDrift(epicBeadId, confirmedBoard);
        if (targetDrift) {
          throw new PoisonEpic(
            `${epicBeadId} stopped being a run target while this run was starting (${targetDrift}) ` +
              `— refusing to execute work another target now owns`,
          );
        }
        const confirmedChildren = runTickets(confirmedBoard, epicBeadId);
        const drift = ticketSetDrift(freshChildren, confirmedChildren);
        if (drift) {
          throw new Error(
            `${epicBeadId}'s ticket set changed while this run was starting (${drift}) — retrying so ` +
              `the run gates and executes the whole set rather than dropping work moved under it ` +
              `before its run-lease was visible`,
          );
        }
      });

      leaseTimer = setInterval(() => {
        if (leaseSettled) return; // run is settling — don't publish a fresh lease behind finally's clear
        // Serialize refreshes by CHAINING onto the in-flight promise rather than overwriting it
        // (anton-jz1). If a `publishLease` runs longer than RUN_LEASE_REFRESH_MS (a `bd sync` queued
        // behind another sync, a remote stall), the next tick would otherwise start a second publish
        // concurrently AND replace the only promise `finally` awaits — the first, still-running
        // refresh could then land an unexpired lease AFTER finally cleared the label, leaving a
        // done/failed/parked run looking live until TTL. Chaining guarantees at most one publish is
        // in flight, and `leaseRefreshInFlight` always tracks the tail of the chain so `finally`
        // awaits every queued refresh. Re-check `leaseSettled` after the prior link resolves so a
        // refresh queued before settle no-ops instead of re-publishing behind finally's clear. A
        // failed refresh only logs (it must not crash the process from a detached timer), and
        // publishLease leaves `leaseExpiry` un-advanced on failure — so if these writes keep failing,
        // `assertLeaseHeld` at the next checkpoint parks the run before the shared lease lapses.
        leaseRefreshInFlight = leaseRefreshInFlight
          .catch(() => {}) // prior failure already logged below; keep the chain alive
          .then(() => {
            if (leaseSettled) return; // settled while the prior refresh was in flight — don't republish
            return publishLease();
          })
          .catch((e) =>
            console.error(`[execute-epic] run-lease refresh failed for ${epicBeadId}`, e),
          );
      }, RUN_LEASE_REFRESH_MS);
      if (typeof leaseTimer.unref === "function") leaseTimer.unref();

      // Cooperative lease-liveness guard (anton-jz1). The refresh timer only LOGS a failed publish;
      // if writes to the shared board keep failing, the lease silently lapses past its TTL while this
      // run is still executing, and another machine's liveRunCheck would then see the epic as free and
      // start a duplicate. So at each checkpoint below (every ticket boundary, every review-gate
      // review/fix dispatch — the gate is handed this guard — and before the PR) we
      // re-check the expiry we last successfully PUSHED: once it's in the past we can no longer prove
      // we hold the shared lease, so we yield (RunAlreadyLiveError → park + retry, re-checking liveness
      // next attempt) rather than keep running unguarded. A single ticket that itself runs past the TTL
      // under sustained sync failure can't be interrupted mid-session, so this bounds — not eliminates
      // — the exposure to roughly one ticket's worth of work.
      const assertLeaseHeld = () => {
        if (clock.now() >= leaseExpiry) {
          // `unproven`, not `foreign`: this is OUR lease lapsing, and nothing here read another
          // machine's. Callers that would hand the branch over to a foreign owner (the review gate's
          // orphan-PR reconcile) must not do so on this.
          throw new RunAlreadyLiveError(
            `${epicBeadId} run-lease expired mid-run (refresh writes to the shared board have been ` +
              `failing) — parking so another machine doesn't treat the epic as free and double-run ` +
              `it; this attempt resumes once the board is reachable`,
            "unproven",
          );
        }
      };

      // 2. Warm worktree (idempotent — reused on resume). Branch off the FRESHEST base
      // (anton-x3o): resolveFreshBase fetches origin/<base> and returns `origin/<base>` so a run
      // whose local base is stale still starts at the remote tip; it's best-effort and falls back
      // to the local base offline. On resume this is moot — createWorktree short-circuits to the
      // existing worktree, so the base is never re-applied mid-run. Note the PR `base` below stays
      // the plain branch name (gh needs a branch, not a remote-tracking ref).
      const baseBranch = settings.baseBranch ?? project.defaultBranch;
      // Held for the review gate below too: it diffs the branch against this base's MERGE BASE, so
      // the remote-tracking ref is the accurate fork point even when the local base has drifted.
      const freshBase = await resolveFreshBase(repo, baseBranch);
      // Claim the checkout for the whole run (anton-hrun.1). The claim's `git worktree lock` is the
      // ONLY evidence a second anton process over this repository has that the directory is in use:
      // its teardown and its sweep judge residue from their own run rows and the board, which say
      // nothing about a run on this machine, so an unclaimed checkout on a still-open bead reads as
      // "release the worktree" and is force-removed with this run's uncommitted work in it.
      worktreeClaim = claimOwnerFor(runId);
      await acquireWorktreeClaim(repo, branch, worktreeClaim);
      const worktree = await createWorktree({
        repoPath: repo,
        branch,
        baseBranch: freshBase,
        warm: true,
        claimedBy: worktreeClaim,
        // A cold install can run for minutes; without the job's signal an operator's kill would wait
        // it out, holding the run's concurrency slot the whole time.
        signal: ctx.signal,
      });
      runWorktree = worktree;
      await updateRun(db, clock, runId, {
        worktreePath: worktree.path,
        branch: worktree.branch,
        attempts: ctx.attempt,
      });
      await ctx.heartbeat();

      // Every step below runs through the step registry (anton-4npr) — one entry point per step,
      // dispatched by the walk in the order the project's formula declares. This is what they all
      // operate on; each dispatch adds the ticket(s) in scope (and, per ticket, that ticket's
      // session) plus the formula step itself, which is where a `step:claude` reads its prompt.
      const runStep: Omit<StepContext, "tickets"> = {
        db,
        clock,
        ctx,
        projectId,
        runId,
        repoPath: repo,
        worktreePath: worktree.path,
        branch: worktree.branch,
        baseBranch,
        baseRef: freshBase,
        target,
        settings,
        assertLeaseHeld,
      };

      // 3. Assert this process still owns the epic, THEN claim it for the human operator (idempotent).
      //    An approved-but-unstarted (backlog) target can be TAKEN OVER — reassigned to another
      //    operator via the approve route's steal — after this run was queued but before it leased the
      //    epic (a queued or autonomy-paused job). The take-over enqueues a fresh run on the NEW
      //    owner's instance, but the jobs table is machine-local: THIS stale job still sits on the
      //    ORIGINAL operator's instance. Running it now would execute under the new owner's
      //    reservation — the exact "run under someone else's claim" state the soft-lock
      //    forbids (DESIGN.md §Soft-lock). So gate on ownership FIRST — like the ticket-claim hard gate
      //    in runTicket — AND make the claim itself hard (below): a steal landing between this read and
      //    the claim is caught by `bd update --claim` refusing to reassign, not swallowed by `safe`.
      //    Re-read the owner here (not from the job-start snapshot): the worktree warm
      //    above is several ops wide, so ownership settles against current state, mirroring the approve
      //    route re-reading the assignee at its own run trigger. PARK (not fail) on a mismatch —
      //    recoverable, it stops the stale run without stomping the new owner, and the current owner
      //    approving afresh enqueues a run under their identity on their instance. A runner with no
      //    operator identity can't assert ownership, so it falls through to the prior best-effort claim.
      //    The claim's own sync nudge (below) still makes it visible on teammates' boards within a
      //    heartbeat (anton-live-sync R6); fire-and-forget, the end-of-run sync is the backstop.
      const operator = await resolveOperator();
      const currentOwner = ownerOf(await beads.show(repo, epicBeadId));
      if (operator && currentOwner && currentOwner !== operator) {
        throw new PoisonEpic(
          `${epicBeadId} is reserved by ${currentOwner}, not ${operator} — it was taken over after ` +
            `this run was queued; refusing to run under another operator's claim. Approve ${epicBeadId} ` +
            `as ${currentOwner} to start a run under the current owner.`,
        );
      }
      if (operator) {
        // Fold the ownership gate INTO the claim so a take-over that lands in the window between the
        // read above and this write can't slip through. `bd update --claim` refuses to reassign a
        // bead a different operator now holds, so it — not the stale pre-read — is the operation that
        // actually observes a racing steal. That refusal MUST stop the run (like runTicket's ticket
        // hard gate), never be swallowed by `safe`: swallowing would tag and execute the epic under
        // the new owner's reservation, the exact state the soft-lock forbids. On the NORMAL path the
        // approve route already pre-assigned this same operator (approve/route.ts `cas(owner, operator)`),
        // so this is a same-actor re-claim — and `bd update --claim` is idempotent for the same actor
        // ("idempotent if already claimed by you" per its own help; verified on bd 1.0.4), so it
        // succeeds and the run proceeds. Same story on resume, so a retry re-claims cleanly. A claim
        // only FAILS when a DIFFERENT operator now holds the bead — the take-over handled below.
        try {
          await beads.claim(repo, epicBeadId, operator);
        } catch (e) {
          // A claim failure has three causes and only the transient one is worth retrying. Re-read the
          // owner to spot the first: if a DIFFERENT operator now holds the epic, this is a confirmed
          // take-over — retrying is pointless, so poison (human must re-approve as the current owner).
          // But `bd update --claim` also throws on transient failures (a Dolt lock, a CLI timeout) with
          // NO ownership change; poisoning those would park a valid approved epic that a retry would
          // claim cleanly. Treat that class as a normal retryable error — the same call runTicket's
          // hard gate makes — so the runner retries instead of parking. A racing steal is still caught:
          // either this re-read sees it, or the pre-read gate above does on the next attempt. If the
          // re-read ITSELF fails we can't confirm a take-over, so fall through to the status check.
          const ownerNow = await beads
            .show(repo, epicBeadId)
            .then(ownerOf)
            .catch(() => undefined);
          if (ownerNow && ownerNow !== operator) {
            throw new PoisonEpic(
              `${epicBeadId} is reserved by ${ownerNow}, not ${operator} — it was taken over after this ` +
                `run was queued; refusing to run under another operator's claim. Approve ${epicBeadId} as ` +
                `${ownerNow} to start a run under the current owner. ` +
                `(${e instanceof Error ? e.message : String(e)})`,
            );
          }
          // The third cause: bd refused because the bead's STATUS isn't claimable (blocked, closed,
          // deferred), with no ownership change at all — so the re-read above sees nothing wrong and
          // the old code bucketed it as transient, retried it 3× against an error that can never
          // change, and parked telling the operator the Dolt DB was locked (anton-e5ix, observed on
          // anton-f5f3). Poison on the FIRST attempt instead, naming the status and the fix: only a
          // human moving the bead out of that status can make the claim succeed.
          const status = unclaimableStatus(e);
          if (status) {
            throw new PoisonEpic(
              `${epicBeadId} cannot be claimed while its status is "${status}" — bd refuses the claim ` +
                `and no retry can change that. Reopen/unblock ${epicBeadId} (its status must be ` +
                `claimable, e.g. open) and approve it again to start a run. ` +
                `(${e instanceof Error ? e.message : String(e)})`,
            );
          }
          throw new Error(
            `${epicBeadId} could not be claimed for ${operator} — the beads DB is locked or the claim ` +
              `command failed transiently; retrying. ` +
              `(${e instanceof Error ? e.message : String(e)})`,
          );
        }
      } else if (currentOwner) {
        // No operator identity, but the epic is owned by someone. We can't assert we ARE that
        // owner, and a best-effort `safe` claim would swallow bd's refusal to reassign a foreign
        // bead — tagging and running the epic under the current owner's reservation, the exact
        // state the soft-lock forbids (DESIGN.md §Soft-lock). So mirror the pre-read gate above
        // and PARK: this is an older queued approved-but-unassigned job on an instance without
        // ANTON_OPERATOR/global user.name, and another operator took the epic over before the
        // lease. Poison (recoverable) — a human must re-approve as the current owner to enqueue a
        // run under their identity. Retrying is pointless: this runner still can't assert ownership.
        throw new PoisonEpic(
          `${epicBeadId} is reserved by ${currentOwner}, but this runner has no operator identity ` +
            `(set ANTON_OPERATOR or the global git user.name) to assert ownership — refusing to ` +
            `run under another operator's claim. Approve ${epicBeadId} as ${currentOwner} to start ` +
            `a run under the current owner.`,
        );
      } else {
        // No operator identity AND the epic is unowned → nobody's reservation to stomp, so keep
        // the prior best-effort claim (bd falls back to its own actor resolution).
        await safe(() => beads.claim(repo, epicBeadId, operator));
      }
      await safe(() => beads.tag(repo, epicBeadId, [LABELS.stage("implementing")]));

      // 3b. Cascade the claim to the target's open children (anton-0d85). The claim above settles the
      //     FEATURE, but `bd ready --unassigned` filters on each TASK's assignee — so without this a
      //     running feature keeps offering its own children to every other worker on the board, and
      //     the only thing standing between them and a duplicate run is anton-side knowledge no plain
      //     `bd` client has. Assigning them makes bd's own readiness query exclude them natively.
      //     A child a DIFFERENT actor holds is left exactly as it is and reported here — a human's
      //     reservation outranks a run's, and clobbering it would hide the conflict that runTicket's
      //     hard claim gate is about to stop the run on anyway.
      //     Only for a grouped run: a standalone target IS its own ticket and was just claimed above.
      //     Skipped without an operator identity too — `bd assign` names an assignee, and there is
      //     none to name (the same reason that path keeps a best-effort claim).
      //     Fails CLOSED, like the run-lease publish and for the same reason: a run executing children
      //     the board still offers to everyone else is the duplicate-work hazard this exists to
      //     prevent, so half a cascade must stop the attempt rather than proceed quietly. Retryable
      //     (a plain Error, not poison) — a locked bd DB self-heals within the retry budget.
      if (operator && !standaloneRun) {
        const cascade = await assignChildren(repo, tickets, operator);
        // Recorded BEFORE the incomplete-cascade throw below, so the stopping path hands back the
        // reservations this cascade did take rather than stranding them.
        childCascade = { actor: operator, ids: cascade.held };
        if (cascade.reserved.length > 0) {
          console.warn(
            `[execute-epic] ${epicBeadId}: left ${cascade.reserved.length} child ticket(s) with ` +
              `another assignee untouched — ${formatReservedChildren(cascade.reserved)}`,
          );
        }
        if (cascade.failed.length > 0) {
          throw new Error(
            `${epicBeadId} could not reserve ${cascade.failed.map((f) => f.id).join(", ")} for ` +
              `${operator} — the beads DB is locked or the assign failed transiently; retrying ` +
              `rather than running a feature whose children the board still offers to other ` +
              `workers. (${cascade.failed[0].error})`,
          );
        }
      }
      // 3c. PUBLISH the claim and the cascade before executing anything (anton-0d85). A reservation
      //     only exists locally until it reaches the Dolt remote, so a fire-and-forget push would
      //     leave every other machine reading these beads as unassigned for the whole run — exactly
      //     the duplicate-work window 3a/3b are here to close, reopened at the last step. Await it
      //     and fail CLOSED, the same rule the run-lease publish follows and for the same reason.
      //     Retryable (a plain Error): the claim and the cascade are idempotent for this actor, so a
      //     retry re-publishes rather than re-reserving. `beads.sync` tolerates a no-remote
      //     workspace, so a single-machine run is unaffected.
      try {
        await beads.sync(repo);
      } catch (e) {
        throw new Error(
          `${epicBeadId} was claimed${operator ? ` for ${operator}` : ""} but the claim could not be ` +
            `published to the shared board — other machines would still see this work as unassigned; ` +
            `retrying rather than running it unpublished. ` +
            `(${e instanceof Error ? e.message : String(e)})`,
        );
      }

      // 4. Per ticket: the formula's ticket phase (its steps up to and including the commit) →
      //    (close | in-review). Skip work that already
      //    landed on a prior attempt. A closed ticket is done — an epic's children close as they
      //    commit, and any resumed run skips them. A standalone target is NEVER closed here (its
      //    close is a merge-time concern, below): the moment its single ticket commits, runTicket
      //    moves it to stage:in-review instead — that label is both the board's "in review" state
      //    and the persisted resume marker, so a retry after a failed PR step skips straight to
      //    the PR step here rather than re-running claude/tests/commit on already-committed work.
      // Abandoned tickets are dropped from the run entirely (anton-6xj0). Filtered out HERE, ahead
      // of the done-on-board logic below: an abandoned bead IS closed, but its work was never
      // committed, so that logic would read "closed with no commit on this branch" as a
      // cross-machine resume, reopen it, and re-run the agent on work a human explicitly killed.
      const live = orderTickets(tickets, all).filter((t) => !beads.isAbandoned(t));
      if (live.length === 0) {
        // Every ticket abandoned but the epic left open — a contradiction only a human can settle
        // (abandon the epic too, or add work to it). Park rather than open an empty PR or mark the
        // run done, either of which would read as a delivery that never happened.
        throw new PoisonEpic(
          `every ticket under ${epicBeadId} has been abandoned — nothing left to run; abandon the ` +
            `epic itself or give it work, then resume the run`,
        );
      }
      // A ticket a bead OUTSIDE this run still blocks is HELD, not run (anton-1two): its work depends
      // on code that hasn't landed, so dispatching it would hand the agent a premise that doesn't
      // exist yet — the false-success shape issue #46 is about. Its runnable siblings are independent
      // work, so they run now (the readiness verdict above already refused a run with none of them),
      // and the held tail parks the run after the loop rather than riding into the PR unrun.
      const held = live.filter((t) => gated.has(t.id));
      const dispatchable = live.filter((t) => !gated.has(t.id));
      // What a ticket that ran out of time takes down with it (anton-67xj). `skipCause` is the
      // graph verdict — every ticket transitively behind a rolled-back one — recomputed as each
      // timeout lands; `skipped` records the ones this loop ACTUALLY passed over, so a dependent
      // whose commit was already on the branch still counts as delivered.
      let skipCause = new Map<string, SkipCause>();
      const skipped = new Map<string, SkipCause>();
      // Hand a ticket this run will NOT dispatch back to the board, and say so on it. Shared by the
      // dispatch loop below and by the held tail (4a), which reaches the same verdict for a ticket a
      // cross-run blocker also holds — one writer, so the two paths can never leave a skipped ticket
      // in different states. `doneOnBoard` is the caller's answer to "closed elsewhere, commit
      // absent here"; only that case needs the reopen.
      const recordSkipped = async (ticket: Bead, skipping: SkipCause, doneOnBoard: boolean) => {
        skipped.set(ticket.id, skipping);
        // Closed on another machine but its commit never reached this branch, and now it will
        // never be regenerated here — reopen it, or the board advertises work no PR contains.
        // Required, not best-effort: merge finalization only preserves and rehomes children that
        // are still OPEN, so a ticket left closed here is recorded as shipped by the very merge
        // that proves it never was — the `not-delivered` marker below cannot rescue it.
        if (doneOnBoard && ticket.status === "closed") {
          if (!(await mustPersist(() => beads.reopen(repo, ticket.id)))) {
            throw new PoisonEpic(
              `${ticket.id} is closed on the board but its commit is on no branch here, and it ` +
                `was skipped because ${skipping.stopped} ran out of time — bd would not reopen ` +
                `it, so the merge of this run's pull request would file work no diff contains ` +
                `as shipped. Check the beads DB, then resume the run`,
            );
          }
        }
        // Mark it as work this run did NOT deliver, which is what stops merge finalization from
        // closing it as shipped when the PR for the rest of the feature lands (anton-67xj). That
        // marker is finalization's only input, so it is not best-effort: a run that cannot record
        // it must not go on to open a PR whose merge would then file this ticket as shipped.
        // Retry, then park for a human rather than proceed on an unwritten fact.
        //
        // Written BEFORE the reservation goes back (PR #199). The release is what makes this
        // ticket claimable again on a shared board, and a second run that takes it in the gap
        // would snapshot it without the marker — runTicket clears the label off its own snapshot,
        // so it would never clear this one, and the ticket could deliver with `not-delivered`
        // still attached, which sends merge finalization off preserving and rehoming work that
        // actually shipped. While the reservation stands, `bd ready --unassigned` keeps the ticket
        // out of every other worker's claimable set, so there is no such snapshot to take.
        if (!(await mustPersist(() => beads.tag(repo, ticket.id, [LABELS.notDelivered])))) {
          throw new PoisonEpic(
            `${ticket.id} was skipped because ${skipping.stopped} ran out of time, but bd would ` +
              `not record \`${LABELS.notDelivered}\` on it — the run stopped rather than open a ` +
              `pull request whose merge would close this undelivered ticket as shipped. Check ` +
              `the beads DB, then resume the run`,
          );
        }
        // …then hand it back: the run's claim cascade reserved it, and a ticket left assigned to a
        // run that never dispatched it is invisible to `bd ready --unassigned` on every machine.
        //
        // ONLY this run's own reservation, under the cascade's compare-and-swap (anton-67xj).
        // `tickets` is the run's snapshot, taken before any dispatch: an operator who took this
        // ticket over between the cascade and this skip is doing live work, and an unconditional
        // unassign would advertise their ticket as claimable and invite a second run of it.
        const reservedFor = childCascade?.actor;
        if (reservedFor) await safe(() => releaseChildren(repo, [ticket.id], reservedFor));
        await safe(() => beads.note(repo, ticket.id, skipNote(skipping)));
        console.warn(
          `[execute-epic] ${epicBeadId}: skipped ${ticket.id} — it depends on ` +
            `${skipping.waitingOn}, whose work was rolled back when ${skipping.stopped} ran out ` +
            `of time`,
        );
      };
      for (const ticket of dispatchable) {
        assertLeaseHeld(); // yield before starting a ticket if the shared lease has lapsed
        // A ticket marked done on the board — a closed epic child, or a standalone target moved to
        // stage:in-review — is only safe to SKIP if its commit is actually present on THIS
        // worktree's branch (anton-jz1). Board state propagates cross-machine via `bd sync`, but the
        // branch is pushed only at the PR step: a ticket another machine closed then parked/crashed
        // on (before openPullRequest) has its commit solely in that machine's local, never-pushed
        // worktree. This machine's fresh worktree branches off origin/<base> and lacks it, so
        // skipping on board state alone would open the epic's single PR missing that work while the
        // board still marks it done. Re-run it here so its commit lands on this branch. On a
        // same-machine resume the worktree is reused and the commit is present, so this skips as
        // before — no redundant re-run.
        const doneOnBoard = resumeSkipped(ticket, standaloneRun);
        if (doneOnBoard && (await worktreeHasCommitFor(worktree.path, ticket.id))) {
          if (standaloneRun) {
            // Resume after a failed PR step: this standalone ticket committed and moved to in-review
            // on a prior attempt. Step 2 above re-tagged the target stage:implementing (it can't
            // tell a fresh run from a resume), and runTicket — the only standalone path that clears
            // implementing — is being skipped here. Clear it now so the ticket doesn't carry BOTH
            // stage labels into merge-finalize, which strips only in-review and would otherwise
            // leave a stale implementing label (making a reopened bead derive as in-progress).
            await safe(() => beads.untag(repo, ticket.id, [LABELS.stage("implementing")]));
          }
          continue;
        }
        // A ticket whose prerequisite ran out of time is SKIPPED, not dispatched (anton-67xj). The
        // rollback took the mechanism it was written against off the branch, so its agent can only
        // report the absence and exit with a zero diff — which the no-delivery gate then reads as a
        // failed run, poisoning the tickets that DID deliver. Checked after the done-on-board skip
        // above (work already on this branch is delivered, whatever timed out later) and before the
        // re-gates below, which must not park a run over a ticket that is no longer going to run.
        const skipping = skipCause.get(ticket.id);
        if (skipping) {
          await recordSkipped(ticket, skipping, doneOnBoard);
          continue;
        }
        // Done on the board but the commit is missing from this branch (cross-machine resume): the
        // work must be regenerated here, which re-runs the ticket's agent. Step 0b's allowlist gate
        // SKIPPED this ticket — isResumeSkipped treats any done-on-board bead as "won't run", which
        // is only true when its commit is present. Now that we know it WILL re-run, re-gate it here
        // (anton-jz1): a ticket whose `agent:` label was disabled since it first closed must
        // poison-park, exactly as step 0b does, rather than silently regenerate under the default
        // agent. Checked before the reopen/runTicket so the re-run never starts.
        if (doneOnBoard) {
          const disabled = inactiveAgentTickets([ticket], settings.agents, userAgentIds);
          if (disabled.length > 0) {
            throw new PoisonEpic(
              `epic ${epicBeadId} needs agents enabled in this project's settings: ` +
                disabled.map((x) => `${x.id} → agent:${x.agent}`).join(", ") +
                ` — enable them in Settings → Agents (or relabel the tickets), then resume the run`,
            );
          }
          // Same re-gate for the bead contract (anton-j9zs): step 0c skipped this ticket as
          // resume-skipped, which only holds while it isn't re-run. Regenerating its work under a
          // spec with no definition of done is the state that gate exists to refuse. The grouped
          // TARGET is re-checked alongside the ticket: its criteria are the rubric self-review
          // scores the regenerated work against, and a run whose children all arrived closed was
          // gated on nothing at 0c — this is the first time that target's spec is read.
          const regressed = contractGaps(
            ticket.id === target.id ? [ticket] : [target, ticket],
            "blocking",
          );
          if (regressed.length > 0) {
            throw new PoisonEpic(
              `epic ${epicBeadId} has beads that don't meet the bead contract: ` +
                formatContractGaps(regressed) +
                ` — write the missing section(s), then resume the run`,
            );
          }
        }
        // Done on the board but the commit is missing from this branch (cross-machine resume): the
        // work must be regenerated here. Reopen a closed child first so runTicket's claim + close
        // operate on a live bead (a standalone target is never closed, so it needs no reopen).
        if (doneOnBoard && ticket.status === "closed") {
          await safe(() => beads.reopen(repo, ticket.id));
        }
        try {
          await runTicket({
            run: runStep,
            steps: ticketSteps,
            ticket,
            operator,
            closeOnDone: !standaloneRun,
            timeoutMs: ticketTimeoutMs,
          });
        } catch (e) {
          // A ticket that ran out of time is the ONE failure this loop absorbs (anton-t1mo). It has
          // already blocked its own bead and rolled its partial work back, so the feature can carry
          // on: the tickets behind it are independent work, and ending the run here would deliver
          // none of them — the exact failure this budget exists to prevent. Every other failure
          // still halts the run, unchanged.
          if (!(e instanceof TicketTimeoutError)) throw e;
          timedOut.push({ id: e.ticketId, committed: e.committed });
          console.warn(`[execute-epic] ${epicBeadId}: ${e.message}`);
          // Recomputed over the whole ledger, which decides for itself what cascades: a timeout
          // that landed AFTER its commit takes nothing down with it (anton-67xj). Walked over
          // `tickets` rather than `live`: an abandoned ticket still sits on the `blocks` edges of
          // the chain around it, so dropping it from the graph would cut the walk short and
          // dispatch the tickets BEHIND it against work the rollback took off the branch.
          skipCause = skippedDependents(timedOut, tickets, all);
        }
        // A finished ticket is progress — reported here so the runner's no-progress timeout
        // measures a wedge rather than a long-but-healthy feature (anton-t1mo).
        await ctx.heartbeat();
      }

      // A ticket ROLLED BACK by its budget contributed no commit (anton-t1mo), so it is not part of
      // what this run delivered — read by the park below and by the run phase's ticket list.
      const rolledBack = new Set(timedOut.filter((t) => !t.committed).map((t) => t.id));

      // 4a. The held tail stops the run HERE (anton-1two) — after every runnable ticket has committed
      //     and before anything speaks for the run as a whole. A run target ships ONE pull request
      //     for its whole self, so opening it now would advertise a feature that is missing the
      //     tickets a cross-run blocker held; closing them to make the set look whole would be the
      //     same false success one ticket down. So park: the committed work stays on the branch, the
      //     held tickets stay open and unrun, and the resume that follows the blocker landing walks
      //     this same branch — skipping what already committed — and opens the single PR then.
      //     A held ticket that ALSO sits behind a rolled-back timeout is the one exception
      //     (anton-67xj): the blocker is no longer the reason it can't run — the mechanism it was
      //     written against was rolled off the branch, and the ticket that owned it is `blocked`,
      //     which bd refuses to claim. So the resume this park promises could not dispatch it
      //     either, and parking would strand the commits the run's independent tickets already made
      //     behind a wait that decides nothing. Only tickets held for a reason a resume can clear
      //     hold the run.
      const stillHeld = held.filter((t) => !skipCause.has(t.id));
      if (stillHeld.length > 0) {
        throw new BlockedTailError(
          blockedTailReason(epicBeadId, {
            blockers: freshReadiness.blockers,
            // Every held ticket, including the timeout-skipped ones: the run parks either way, and
            // the operator reading the park is owed the whole tail rather than half of it.
            held: held.map((t) => t.id),
            ran: dispatchable
              .filter((t) => !rolledBack.has(t.id) && !skipped.has(t.id))
              .map((t) => t.id),
          }),
        );
      }
      // The run proceeds, so the held tail is now work this run did not deliver and must say so on
      // its own beads — otherwise the merge of the PR opening below closes it as shipped. Recorded
      // only once the park above is ruled out, so a run that still parks leaves the board untouched.
      // `doneOnBoard: false` — the epic graph puts closed children in neither the ready nor the held
      // set, so a held ticket is open by construction and has no cross-machine close to undo.
      // Every held ticket has a cause here: `stillHeld` is exactly the ones without one, and the
      // park above throws whenever that set is non-empty.
      for (const ticket of held) {
        await recordSkipped(ticket, skipCause.get(ticket.id)!, false);
      }

      // 4b. The RUN phase of the walk (anton-lnkt): every formula step after the commit, in the
      //     order the project's formula puts them, dispatched through the same registry the ticket
      //     phase uses. These steps speak for the run as a whole — they read its whole diff and open
      //     its single PR — so each runs ONCE, and one at a time: they share a worktree and a PR, so
      //     a formula whose steps could overlap is still not a licence to fan out.
      //     `live`, not `tickets`: an abandoned ticket contributed no commit, so listing it would
      //     advertise work this run doesn't contain (anton-6xj0). A ticket ROLLED BACK by its budget
      //     is dropped for the same reason (anton-t1mo) — leaving it in would put it in the PR body
      //     as delivered and hand the reviewer a diff it isn't in. One stopped AFTER its commit
      //     stays: its code is in the diff, so dropping it would hide work the reviewer must read.
      //     A ticket SKIPPED behind a rolled-back one (anton-67xj) never ran at all, so it is out
      //     for the same reason — the PR body must not claim work that has no diff.
      const delivered = live.filter((t) => !rolledBack.has(t.id) && !skipped.has(t.id));

      // Nothing survived, so this run has nothing to show (anton-t1mo). Absorbing the timeouts is
      // only correct while SOMETHING landed — carrying on here would run the review gate over an
      // empty diff and open a PR that delivers nothing, the same false success the no-delivery gate
      // refuses. Park instead: a whole feature timing out is a budget or a scoping problem, and a
      // human has to pick which.
      if (timedOut.length > 0 && delivered.length === 0) {
        throw new PoisonEpic(
          `every ticket under ${epicBeadId} ran out of time ` +
            `(${timedOut.map((t) => t.id).join(", ")})` +
            (skipped.size > 0
              ? ` or was skipped behind one that did (${[...skipped.keys()].join(", ")})`
              : "") +
            ` — nothing was delivered. Re-scope them into ` +
            `smaller tickets, or raise this project's ticketTimeoutMinutes, then resume the run`,
        );
      }

      let advisoryFindings: ReviewFinding[] = [];
      // A reused PR whose refresh `gh` refused still shows the previous attempt's body, and the run
      // completes regardless — so that round's advisories would exist nowhere: the score comment
      // records their COUNT, never their text. The salvage note rides out on the run row when even
      // the bead write fails (set by the `pr` step below, read by the finalize step).
      let staleBodyFallback: string | null = null;
      for (const { step: cooked, definition } of runSteps) {
        // A step boundary is a lease checkpoint: never dispatch run-level work — and never open a
        // PR — under a lease this run can no longer prove it holds.
        assertLeaseHeld();
        const stepCtx: StepContext = {
          ...runStep,
          tickets: delivered,
          step: cooked,
          advisories: advisoryFindings,
        };

        if (definition.name === "review") {
          // The pre-PR self-review gate (anton-omum): a fresh-context reviewer reads THIS run's
          // diff, its blocking findings are fixed on the branch, and only then does the PR open — so
          // the PR the founder merges has already been reviewed once. The formula says WHERE the
          // gate runs; the project setting still says WHETHER (absent ⇒ on). Nothing about the
          // verdict is persisted as a resume marker on purpose: a parked run that is resumed
          // re-reviews the worktree as it stands now, which is the only state the fixes it just made
          // are visible in. A run that already opened its PR never reaches here — step 0a
          // short-circuits it.
          if (!resolveReviewConfig(settings).enabled) continue;
          // Filled by the gate as each round completes, so a gate that THROWS — returning nothing —
          // still leaves this attempt's score history to persist below.
          const gateRounds: ReviewRound[] = [];
          const gate = await definition.handler({ ...stepCtx, rounds: gateRounds }).catch(async (e) => {
            // A throwing gate never reaches persistReviewScores below, so the rounds it DID finish
            // are written here or lost with the attempt — for a poison park (a round-3 death still
            // owes the founder rounds 1 and 2) and equally for a retryable one, where the run is
            // rescheduled and the resumed gate restarts from round 1 with nothing on the board.
            // The score goes on the RUN too, not only the board (anton-cekf): the label is the
            // target's latest across every attempt, so a later rerun would otherwise inherit this
            // one's number and let the breaker judge that run on a review it never had.
            const partialScore = await persistPartialReviewScores(repo, epicBeadId, gateRounds);
            if (partialScore !== undefined) {
              await updateRun(db, clock, runId, { reviewScore: partialScore });
            }
            // EVERY gate failure leaves the run without a PR of its own, so every one of them carries
            // the orphan hazard: a PR a previous attempt opened but never recorded (lost `gh` response
            // or lost setPrRef) stays READY and mergeable with un-reviewed work whether the gate
            // refused the verdict, died on a usage limit, or exhausted its retries. Reconcile before
            // propagating any of them. The one exception is a lease CONFIRMED lost to another machine —
            // that run owns the branch and may have opened this very PR after passing its OWN gate, so
            // drafting it would strand reviewed work with nobody left to ready it again. A lease this
            // run merely couldn't KEEP is not that evidence, and is in fact the only kind reachable
            // here: `assertLeaseHeld` — local expiry, `unproven` — is the gate's sole source of
            // RunAlreadyLiveError, and skipping the reconcile on it left the orphan mergeable.
            const orphan = isForeignRunOwner(e)
              ? undefined
              : await reconcileOrphanPullRequest(repo, worktree.branch);
            // Errors anton doesn't compose a park message for are rethrown untouched — the runner keys
            // its backoff (quota reschedule, retry) off the error's TYPE, and wrapping them would lose
            // that. What the reconcile found rides out on the run row instead (see the catch below).
            if (!isPoisonError(e)) {
              orphanNotice = orphanClause(orphan);
              throw e;
            }
            // The gate parks for a human on more than a blocking verdict: an unrevertable reviewer
            // commit or a fixer that switched branches throws PoisonError from inside it. Those need
            // the SAME parked-run handling — the instruction on both is repair by hand, then resume —
            // so they are re-thrown as a gate block. Left as-is they marked the run `failed`, which
            // hides the row from findOpenRunForEpic, and the resume the human was told to do would
            // start a REPLACEMENT run instead of continuing this one and its session history.
            throw new ReviewBlockedError(`${e.message}${orphanClause(orphan)}`, { cause: e });
          });
          // The gate's verdict is the only reason this step exists; a handler that returned none is
          // an anton bug, not a run outcome, so it fails loud rather than opening an unreviewed PR.
          const review = gate.facts?.review;
          if (!review) {
            throw new Error(
              `formula step "${cooked.id}" (step:review) returned no verdict — refusing to open a PR ` +
                `on an unreviewed run`,
            );
          }
          // The score history belongs to the board, not this run's logs — written on both exits the gate
          // RETURNS from, since a run parked on blocking findings is exactly the one whose score the
          // founder needs. The throwing exit is covered by the catch above.
          const reviewScore = await persistReviewScores(repo, epicBeadId, review);
          // ...and on the run row, which is what the score-regression breaker reads: one score per
          // ATTEMPT, so a rerun that settles unreviewed reads as a gap rather than as its target's
          // older score (see picker-score-breaker.ts).
          if (reviewScore !== undefined) {
            await updateRun(db, clock, runId, { reviewScore });
          }

          const blocking = blockingFindings(review.unresolved);
          // Three states must not become a PR: blocking findings the converge loop couldn't clear, a
          // reviewer that broke the report protocol (silence — or a review that edited the code it was
          // judging — is not a clean review), and a score regression the alarm stopped the loop on
          // (anton-i98r). All three park for the founder like a no-delivery ticket does, with the
          // reason on the bead so the board shows why rather than only the run log.
          if (
            blocking.length > 0 ||
            review.outcome === "protocol-violation" ||
            review.outcome === "score-regression"
          ) {
            const orphan = await reconcileOrphanPullRequest(repo, worktree.branch);
            // The advisories go on the bead with them: this run opens no PR, so its body — their only
            // other home — never exists, and the resumed run starts its review with an empty carry.
            const parkedAdvisories = review.unresolved.filter((f) => f.severity === "advisory");
            const note = reviewParkNote(review, blocking, parkedAdvisories, orphan);
            // Whether that write landed decides what the park reason can honestly say: a locked bd DB
            // would otherwise discard the findings' only copy while the run error told the founder to
            // read them on the bead (see reviewParkMessage).
            const noted = await safe(() => beads.note(repo, epicBeadId, note));
            throw new ReviewBlockedError(
              reviewParkMessage({
                targetId: epicBeadId,
                outcome: review.outcome,
                reason: reviewFailureReason(review, blocking),
                note,
                noted,
                orphan,
              }),
            );
          }
          // Advisory findings never park (anton-3apm): they ride along in the PR body so the founder
          // sees them at the merge gate — which is why they are carried into the steps that follow.
          //
          // Replaces rather than accumulates, and only because the carry runs BOTH ways: a formula
          // with a second `step:review` seeds that gate with what this one left open (see
          // `reviewStep`), so its reviewer was shown these and its verdict IS the whole open set —
          // one it did not restate is settled, not forgotten. Accumulating here would instead
          // resurrect advisories a later reviewer judged resolved.
          advisoryFindings = review.unresolved.filter((f) => f.severity === "advisory");
          continue;
        }

        if (definition.name === "pr") {
          // Open the run's ONE PR, stamp the ref, and (for an epic) move it to in-review. A
          // standalone target is NOT closed here: like an epic it stays OPEN, tagged stage:in-review
          // (the ticket phase already applied that on commit), carrying its PR ref until the PR
          // actually MERGES — at which point review-fix's merge-finalize path closes it. Closing it
          // now would derive it as Done on the board while its PR is still open and drop it out of
          // review-fix's in-review sweep.
          const pr = (await definition.handler(stepCtx)).facts?.pr;
          if (!pr) {
            throw new Error(
              `formula step "${cooked.id}" (step:pr) reported no pull request — the run has no way to ` +
                `reach a human, so it is not done`,
            );
          }
          if (pr.bodyStale) {
            const note = stalePrBodyNote(pr, advisoryFindings);
            // If that write ALSO fails (a locked or unavailable beads DB) the findings have no home
            // left, and the run would still finish `done` — the advisory detail silently dropped
            // between this review and the merge gate. Carry the whole note out on the run row
            // instead, the same durable fallback the park path uses (see reviewParkMessage).
            if (!(await safe(() => beads.note(repo, epicBeadId, note)))) {
              staleBodyFallback = stalePrBodyRunError(epicBeadId, note);
            }
          }
          await safe(() => beads.setPrRef(repo, epicBeadId, pr.ref));
          // The merge wait becomes board state, not a polling job (anton-k0kj): past this step the
          // only thing left to learn is whether this PR merges, which `bd gate check` answers for the
          // whole project in one call per slot. Best-effort like the writes around it — the
          // review-fix sweep still finalizes a merge it happens to see, so a failed arm costs
          // latency, not correctness.
          await safe(() => armMergeGate(repo, epicBeadId, pr.ref, all));
          if (!standaloneRun) {
            await safe(() => beads.tag(repo, epicBeadId, [LABELS.stage("in-review")]));
            await safe(() => beads.untag(repo, epicBeadId, [LABELS.stage("implementing")]));
          }
          continue;
        }

        // Anything else the project put after its commit — a `step:verify` it moved there. Never a
        // step that DISPATCHES an agent: the floor (anton-6b99, `diff-after-commit`) refuses every
        // `producesDiff` step here, which is both `implement` and `claude`, and it is asserted on
        // every attempt before the walk begins. So nothing reaching this line carries a
        // `facts.selfReport`, and an agent's ask or block is judged where the agents actually run —
        // the ticket phase (see the `needs-human` throw in runTicket). A step that RAN and did not
        // achieve its work stops the run: the registry leaves that judgement to the caller, and
        // carrying on would report a delivery on a pipeline that didn't finish.
        const result = await definition.handler(stepCtx);
        if (!result.ok) {
          throw new Error(
            result.detail ??
              `formula step "${cooked.id}" (step:${definition.name}) failed for ${epicBeadId}`,
          );
        }
      }

      // A feature that delivered most of itself still owes the founder the part it didn't
      // (anton-t1mo). The timed-out tickets are blocked on the board with their own notes, but the
      // TARGET is what the founder opens at the merge gate — so it says, in one place, that this PR
      // is the feature minus these tickets. Best-effort like the other target writes; the run row
      // below carries the same sentence when the bead write fails.
      const timeoutNotice = timedOut.length
        ? `${timedOut.length} ticket(s) ran out of time and did not finish — ` +
          `${timedOut.map((t) => t.id).join(", ")}. Each is blocked with its own note saying ` +
          `whether its work is in this PR; re-scope them or raise ticketTimeoutMinutes, then run them.`
        : null;
      if (timeoutNotice) await safe(() => beads.note(repo, epicBeadId, `anton: ${timeoutNotice}`));

      // The tickets the timeout took down with it (anton-67xj) — the founder reads the TARGET at the
      // merge gate, so the PR's missing half is named there too, not only on each skipped bead.
      const skippedNotice = skipped.size
        ? `${skipped.size} ticket(s) were never dispatched because the work they depend on was ` +
          `rolled back — ` +
          `${[...skipped].map(([id, c]) => `${id} (waiting on ${c.waitingOn})`).join(", ")}. ` +
          `Each is open, unassigned and noted; run them once the tickets they wait on land.`
        : null;
      if (skippedNotice) await safe(() => beads.note(repo, epicBeadId, `anton: ${skippedNotice}`));

      // 5. Finalize run + clean up the worktree (the branch/PR carry the work now). The run IS done —
      //    the branch and its PR carry the work — so a stale-body salvage rides along as the row's
      //    error rather than failing a delivery that landed.
      await updateRun(db, clock, runId, {
        status: "done",
        endedAt: clock.now(),
        error: [timeoutNotice, skippedNotice, staleBodyFallback].filter(Boolean).join(" — ") || null,
      });
      // The branch and its PR carry the work now, so the checkout is residue; the branch survives
      // because the target is still open in review (anton-hrun.1). The claim comes off first: the
      // release below force-removes the checkout, which a live claim refuses — ours as much as
      // anyone's, since the lock says nothing about which run inside this process took it.
      await releaseWorktreeHold();
      await safe(() =>
        releaseRunResources({
          db,
          clock,
          ctx,
          projectId,
          runId,
          repoPath: repo,
          worktree,
          beadId: epicBeadId,
          status: "done",
        }),
      );
    } catch (raw) {
      // Give the children back before settling the row (anton-0d85). This attempt has stopped —
      // parked on a blocking review, killed by an abandon, backed off after losing the lease race, or
      // failed outright — so holding its reservations would leave the whole feature invisible to
      // `bd ready --unassigned` on every machine while nothing at all is executing it. The CAS
      // releases only children this run still holds, so a takeover that landed mid-run keeps its new
      // owner. A resumed attempt re-takes them at its own claim gate, which is what makes this safe to
      // do on a recoverable stop. It runs on an ABORT too (a kill, an abandon) — unlike runTicket,
      // which writes nothing there: what runTicket would rewrite is the aborted ticket's STATUS, the
      // thing the abort's author is deciding, whereas a reservation with no run behind it is anton's
      // own bookkeeping either way, and the in-flight ticket it gives back is still `in_progress`, so
      // no `bd ready` serves it to anyone before the resume re-claims it.
      // The ONE exception is a usage-limit park: that run is not dead, it is waiting out a quota
      // window and resumes on THIS machine with everything intact — the same reason runTicket keeps
      // the in-flight ticket's claim on that path, and releasing here would contradict it.
      if (childCascade && !isUsageLimitError(raw)) {
        const release = await releaseChildren(repo, childCascade.ids, childCascade.actor);
        if (release.released.length > 0) {
          console.warn(
            `[execute-epic] ${epicBeadId}: released ${release.released.length} child ticket(s) back ` +
              `to the board — ${release.released.join(", ")}`,
          );
        }
        // A release that never landed is the one outcome nothing downstream reports: the run settles
        // below either way, and those children stay assigned to an actor with no run behind them —
        // hidden from `bd ready --unassigned` on every machine until someone clears them by hand.
        if (release.failed.length > 0) {
          console.error(
            `[execute-epic] ${epicBeadId}: could not release ${release.failed.length} child ` +
              `ticket(s) — ${release.failed.map((f) => f.id).join(", ")} — they remain assigned to ` +
              `${childCascade.actor} with no active run. (${release.failed[0].error})`,
          );
        }
      }
      // Reopen the timeouts this attempt absorbed (anton-67xj). runTicket leaves a rolled-back
      // timeout `blocked` on purpose — the run walks on to its PR and the block is the founder's cue
      // — but that only holds while the run REACHES that PR. Every stop below advertises a retry or
      // a resume instead, and that attempt re-dispatches this ticket: `blocked` is a status bd
      // refuses to claim, so runTicket's hard claim gate would kill the next attempt on a bead THIS
      // one blocked, over a failure (a `not-delivered` write that wouldn't land, a held tail, a
      // review the gate refused) that has nothing to do with it. Same restore the halting paths
      // inside runTicket perform, for the same reason; the note it left is what carries the
      // timeout's account to the operator, not the status.
      //
      // Only the ROLLED-BACK ones: a ticket stopped after its commit stays blocked for a human to
      // read, and reopening it would have the next attempt re-dispatch an agent over work already
      // on the branch. Not on an ABORT either — a kill or an abandon settles these beads itself
      // (an abandon closes them), and reopening one there re-queues work a human just killed, the
      // rule runTicket's own abort path follows.
      if (!ctx.signal.aborted) {
        for (const stalled of timedOut.filter((t) => !t.committed)) {
          await safe(() => beads.setStatus(repo, stalled.id, "open"));
        }
      }
      // Resolved HERE — after the release awaits, immediately before the settle that would arm the
      // gate — so a kill landing mid-unwind still converts (anton-287p). Nothing above this line
      // branches on the distinction (the release runs the same for either error), so the late read
      // costs nothing earlier.
      const e = askSettleError(raw, ctx.signal);
      // What the runner finally sees. Only the ask branch rewrites it — a kill can land INSIDE the
      // arm, after the read above (anton-287p) — so the row and the thrown error keep telling the
      // same story.
      let thrown: unknown = e;
      // Quota, a run already live on another machine (anton-jz1), or a self-review that refused the
      // PR → park the run (the job reschedules, re-checks liveness, or waits for the founder);
      // anything else → the run failed (job retries/parks).
      let settledAs: "parked" | "failed";
      // A live human gate this attempt armed. Kept apart from `settledAs` because the two disagree
      // on exactly the path this exists for: a park write that failed settles the row as `failed`
      // while the wait stands, and the checkout is the resume's (PR #205 review).
      let awaitsHumanGate = false;
      if (isUsageLimitError(e)) {
        settledAs = "parked";
        await updateRun(db, clock, runId, { status: "parked", error: `usage-limit${orphanNotice}` });
      } else if (isRunAlreadyLiveError(e)) {
        settledAs = "parked";
        // The notice rides along here too: a lease that merely lapsed still reconciles the branch's
        // orphan PR, and what that found (a PR drafted, or a `gh` lookup that failed) has nowhere
        // else to be reported — this run opens no PR and composes no park message.
        await updateRun(db, clock, runId, {
          status: "parked",
          error: `run-live-elsewhere${orphanNotice}`,
        });
      } else if (e instanceof NeedsHumanError) {
        // The ask becomes board state before the row settles (anton-287p): a `human` gate on the run
        // target, which a person resolves to release the run through the existing gate-resume pass.
        // Parked with no endedAt, like a review park — this run is waiting on someone, not dead, and
        // the resume reuses THIS row (findOpenRunForEpic) so its worktree/branch continue.
        //
        // No gate, no park (anton-287p.4): a parked run whose ask reached no gate is a wait no
        // `bd gate resolve` can end, and it would sit in the waiting-on-a-person surface forever. It
        // settles FAILED instead — the ask still reaches the operator, through a run state that
        // reads as needing attention rather than as patience.
        //
        // The arm gets the LIVE signal, not the sampled verdict above: it awaits the board (a strict
        // read, then any supersede) before it writes, so a force-kill arriving in that window would
        // otherwise still land a gate — the very state askSettleError exists to prevent. It refuses
        // the write in that case, and the ask settles in its cancelled form here.
        let gate: ArmedHumanGate | undefined;
        let gateError: string | undefined;
        // The one cancelled arm that DID leave board state behind: the kill landed inside `gate
        // create` and the undo failed too, so a gate blocks the target that this run will never come
        // back for. It cannot settle as "nothing was written" — the id has to reach the operator.
        let stranded: StrandedHumanGateError | undefined;
        try {
          gate = await armHumanGate(repo, epicBeadId, e, ctx.signal);
        } catch (failure) {
          if (failure instanceof StrandedHumanGateError) stranded = failure;
          gateError = failure instanceof Error ? failure.message : String(failure);
          console.error(
            `[execute-epic] could not arm ${epicBeadId}'s human gate — the ask reaches the operator ` +
              `only through this run's error (${gateError})`,
          );
        }
        if (!gate && !stranded && ctx.signal.aborted) {
          // Killed mid-arm — not a gate failure. Nothing was written, so this settles exactly like a
          // kill that beat the ask to the catch: no gate, no park, the ask carried in the error.
          settledAs = "failed";
          thrown = askSettleError(raw, ctx.signal);
          await updateRun(db, clock, runId, {
            status: "failed",
            error: thrown instanceof Error ? thrown.message : String(thrown),
            endedAt: clock.now(),
          });
        } else if (gate) {
          // The gate is live, so the row is the only half left that can disagree with the board —
          // and settling it is the last thing that can go wrong (anton-287p). Written through a
          // reporter, never a raw throw: a rejected write must not swallow the ask this branch
          // exists to deliver.
          const settlement = await settleArmedAsk({
            targetId: epicBeadId,
            ask: e,
            raw,
            gate,
            signal: ctx.signal,
            now: () => clock.now(),
            settle: reportSettle,
          });
          thrown = settlement.thrown;
          // A wait still standing is not finished with: the cleanup below has to run, and a kill
          // inside it leaves this gate blocking a target nothing returns to (anton-287p).
          armedPark = liveArmedAsk({ gate, ask: e, raw }, settlement);
          // The worktree follows the WAIT, not the row: a settle that failed still leaves the gate
          // standing, and the person who resolves it resumes this attempt here. Only a cancelled
          // unwind — which takes the gate back — leaves nothing coming for the checkout.
          settledAs = settlement.parked ? "parked" : "failed";
          awaitsHumanGate = settlement.awaitsHumanGate;
        } else {
          // The run FAILED, so the error the runner sees has to say so (PR #205 review). The ask's
          // own message promises a park "until someone answers it" — with no gate there is nothing
          // to answer on, and carrying it out unchanged would poison-park the job claiming a wait
          // that no `bd gate resolve` can end. Thrown as the same sentence the row records, so the
          // job outcome and the run row tell one story.
          settledAs = "failed";
          const reason = stranded
            ? strandedAskMessage(e, stranded)
            : ungatedAskMessage(e, gateError);
          thrown = new PoisonEpic(reason);
          await updateRun(db, clock, runId, {
            status: "failed",
            error: reason,
            endedAt: clock.now(),
          });
        }
      } else if (e instanceof BlockedTailError) {
        settledAs = "parked";
        // Parked, not failed, for the same reason as a blocked review below: this run delivered the
        // tickets it could and is waiting on work outside it, so the row must stay open for the
        // resume to continue in (findOpenRunForEpic) rather than read as a crashed attempt.
        await updateRun(db, clock, runId, { status: "parked", error: e.message });
      } else if (e instanceof ReviewBlockedError) {
        settledAs = "parked";
        // Parked, not failed, and with no endedAt: the run is waiting on a human to resolve what the
        // gate refused on and resume it — the run history must not read like a crash. Resuming reuses
        // THIS row (findOpenRunForEpic), so the resumed attempt continues in the same worktree/branch.
        await updateRun(db, clock, runId, { status: "parked", error: e.message });
      } else {
        settledAs = "failed";
        await updateRun(db, clock, runId, {
          status: "failed",
          error: `${e instanceof Error ? e.message : String(e)}${orphanNotice}`,
          endedAt: clock.now(),
        });
      }
      // Hand back the worktree this attempt warmed (anton-hrun.1). Delivery is not the only outcome
      // that owes it: a failure, a kill and an abandon all leave the same checkout and the same
      // branch behind, and before this every one of them tore down nothing. A park keeps both — it
      // resumes in this very worktree — unless its bead was settled underneath it, which is exactly
      // what a kill or an abandon does, and `releaseRunResources` re-reads the bead to see it.
      // Best-effort: a cleanup must never mask the run's own error, and what it misses the scheduled
      // reaper reclaims.
      const stoppedWorktree = runWorktree;
      if (stoppedWorktree) {
        // Ahead of the release for the same reason as the delivered path: this run's own claim would
        // refuse the removal it is asking for. A park that keeps the checkout drops the claim in
        // `finally` instead — it stops executing either way.
        await releaseWorktreeHold();
        const teardown = {
          db,
          clock,
          ctx,
          projectId,
          runId,
          repoPath: repo,
          worktree: stoppedWorktree,
          beadId: epicBeadId,
          // Only a CONFIRMED foreign owner keeps this machine's hands off the checkout — the same
          // rule the gate's orphan reconcile applies. A lease this run merely couldn't keep
          // (`unproven`) proves nothing about who else is running, and reading it as foreign skips
          // the teardown of a worktree nobody else owns.
          foreign: isForeignRunOwner(e),
          // A halt over unrollbackable partial work keeps its checkout: that tree is the only copy
          // of the work, and the run's own note tells an operator to clear THIS path before
          // resuming — a `--force` release here would delete what that instruction points at.
          holdsPartialWork: e instanceof WorktreeDirtyError,
        };
        let kept = false;
        await safe(async () => {
          const entry = await releaseRunResources({
            ...teardown,
            status: settledAs,
            // A wait whose gate is live keeps its checkout even when the row settled as failed: the
            // resume reuses this run, and the tree carries the edits the ask stopped in the middle
            // of (PR #205 review).
            awaitsHumanGate,
          });
          kept = entry.outcome === "kept";
        });
        // A checkout kept for a park the cleanup's kill window can still unseat is one this run may
        // owe back after all (PR #205 review): the reconcile below turns that park into a FAILED run
        // nothing resumes, and no other pass reclaims the tree — the scheduled reaper keeps every
        // checkout whose bead is still open, and this target's is. Armed only when the teardown
        // really kept something, so no other keep (foreign, partial work) is torn down behind it.
        if (kept && awaitsHumanGate) {
          releaseGateKeptWorktree = async () => {
            await safe(() =>
              releaseRunResources({ ...teardown, status: "failed", awaitsHumanGate: false }),
            );
          };
        }
      }
      settled = { thrown }; // thrown past the cleanup below; the runner applies job-level durability
    } finally {
      // Whatever else happened, this attempt is no longer executing in the checkout, so it may not
      // keep claiming it — a claim outliving its run would make the worktree and branch unreapable
      // by every later pass, on this machine and every other, until anton restarts. A no-op on the
      // paths that already released above.
      await releaseWorktreeHold();
      // Stop refreshing and drop the run-liveness lease now that this attempt has stopped executing
      // (anton-jz1). Clearing on EVERY settle path — done, parked, failed — is what lets a Force run
      // re-trigger a stopped run immediately instead of waiting out the lease TTL; a hard crash that
      // skips this still self-heals when the (un-refreshed) lease expires. Best-effort like the
      // other bd writes; the sync below pushes the removal to the remote.
      leaseSettled = true;
      if (leaseTimer) clearInterval(leaseTimer);
      // clearInterval only stops FUTURE ticks; a refresh already inside publishLease when we settle
      // would otherwise write a fresh lease after the clear below. Await it first so leaseLabels
      // reflects what it actually wrote and the clear removes the right (freshest) label (anton-jz1).
      await leaseRefreshInFlight;
      await safe(() => beads.clearRunLease(repo, epicBeadId, leaseLabels));

      // Every bd write above (claims, closes, stage labels, PR ref, lease clear) must reach the
      // remote even when the run failed mid-way. Logged, not thrown: a push failure must not mask
      // the run's own error or fail a run whose real work (branch + PR) already landed.
      await beads
        .sync(repo)
        .catch((e) => console.error(`[execute-epic] beads dolt sync failed for ${epicBeadId}`, e));

      // Everything above is an uninterruptible await and the sync is seconds of network, so this is
      // the last — and widest — window a force-kill can land in (anton-287p). By then the ask is a
      // live gate on the board and nothing else re-reads the signal: without this the stopped run
      // would leave its wait blocking a target no resume is coming for.
      const park = armedPark;
      if (park) {
        const concluded = await concludeCancelledArmedPark({
          gateId: park.gate.gateId,
          reconcile: () =>
            reconcileCancelledArmedPark({
              targetId: epicBeadId,
              ...park,
              signal: ctx.signal,
              now: () => clock.now(),
              settle: reportSettle,
            }),
          releaseKeptWorktree: releaseGateKeptWorktree,
          // Taking the arm back is a LOCAL bd write and the sync that would have carried it has
          // already run, so without this push the gate still reads as OPEN on every other machine —
          // the very state the reconcile just cleared here.
          push: () =>
            beads
              .sync(repo)
              .then(() => true)
              .catch((e) => {
                console.error(`[execute-epic] beads dolt sync failed for ${epicBeadId}`, e);
                return false;
              }),
          queuePush: () => {
            try {
              enqueueSyncPushDeduped(db, clock, projectId);
            } catch (e) {
              console.error(`[execute-epic] enqueue sync-push failed for ${projectId}`, e);
            }
          },
        });
        if (concluded) settled = concluded;
      }
    }
    // Thrown here rather than from the catch so the cleanup — and the kill window inside it — runs
    // first: `settled.thrown` is the attempt's final word on what happened.
    if (settled) throw settled.thrown;
  };
}

/** One ticket: session → the formula's ticket phase (…→ commit) → close. */
async function runTicket(args: {
  /** The run-level step context every ticket shares; this ticket's own is derived from it. */
  run: Omit<StepContext, "tickets">;
  /** The formula's ticket phase, in execution order — dispatched once per ticket (anton-lnkt). */
  steps: ResolvedStep[];
  ticket: Bead;
  operator?: string;
  /** Close the bead in beads once its work is committed. False for a standalone (epic-of-one)
   * target, which is never closed by execute-epic: it stays open + stage:in-review + PR ref until
   * its PR merges (review-fix's merge-finalize path closes it). On commit, a false value instead
   * moves the bead to stage:in-review — the resume marker + board state. Defaults to true (an
   * epic's children close as their work lands). */
  closeOnDone?: boolean;
  /** This ticket's wall-clock budget (anton-t1mo); `Infinity` leaves it unbounded. */
  timeoutMs: number;
}): Promise<void> {
  const { run, ticket, operator, timeoutMs } = args;
  const { db, clock, ctx, projectId, runId, worktreePath } = run;
  const repo = run.repoPath;
  const closeOnDone = args.closeOnDone ?? true;

  // Claim the ticket for the operator as a HARD GATE before doing any work. On a shared board
  // the claim is the cross-operator coordination primitive (anton-live-sync R6): a failure here
  // means the ticket was already claimed by another operator (e.g. after a heartbeat pull) or the
  // local Dolt DB is locked. In either case we must NOT run Claude on a ticket this process does
  // not own — and must NOT fall through to the failure path below, which would clear the real
  // owner's claim. Claiming is idempotent for the same actor, so a resume re-claims cleanly. A
  // conflict aborts the run before any session/worktree work; the job retries and either skips the
  // now-closed ticket (already-closed check in the caller) or reclaims one whose owner released it.
  try {
    await beads.claim(repo, ticket.id, operator);
  } catch (e) {
    throw new Error(
      `refusing to execute ${ticket.id}: could not claim it for ${operator ?? "this operator"} ` +
        `— already claimed by another operator, or the beads DB is locked ` +
        `(${e instanceof Error ? e.message : String(e)})`,
    );
  }
  // Announce the stage + nudge a sync so the claim reaches teammates within a heartbeat
  // (fire-and-forget; the end-of-run sync is the backstop).
  await safe(() => beads.tag(repo, ticket.id, [LABELS.stage("implementing")]));
  // A previous run marked this ticket as undelivered (timed out, or skipped behind one that did).
  // It is being run now, so that verdict is stale — and clearing it is as load-bearing as writing
  // it was (anton-67xj). The failure is the mirror image: a marker that survives its own successful
  // run makes merge finalization read delivered work as undelivered, hold this ticket out of the
  // close, and file a follow-up epic for work the merged diff already contains. So it is retried,
  // and a run that cannot clear it parks before it can open that PR.
  if (beads.isNotDelivered(ticket)) {
    if (!(await mustPersist(() => beads.untag(repo, ticket.id, [LABELS.notDelivered])))) {
      // Put the ticket back the way the claim above found it before halting. The claim already
      // moved it to `in_progress`, and the epic-level cleanup hands the assignee back but not the
      // status — leaving `in_progress` with no owner, which `bd update --claim` refuses outright.
      // The resume this park tells the operator to run would then never get past its claim gate.
      // Same restore the retryable-failure path below performs, for the same reason.
      await safe(() => beads.setStatus(repo, ticket.id, "open"));
      await safe(() => beads.unassign(repo, ticket.id));
      await safe(() => beads.untag(repo, ticket.id, [LABELS.stage("implementing")]));
      throw new PoisonEpic(
        `${ticket.id} carries \`${LABELS.notDelivered}\` from a previous run but bd would not ` +
          `clear it — running this ticket and opening a pull request would make merge ` +
          `finalization treat delivered work as undelivered. Check the beads DB, then resume the run`,
      );
    }
  }
  void beads
    .sync(repo)
    .catch((e) => console.error(`[execute-epic] claim sync failed for ${ticket.id}`, e));

  const agentTag = labelValueOf(ticket.labels, "agent");
  const session = await startJobSession(db, clock, {
    projectId,
    runId,
    kind: "execute",
    beadId: ticket.id,
  });
  const { sessionId, logPath } = session;
  await updateRun(db, clock, runId, { ticketBeadId: ticket.id, agentTag: agentTag ?? null });
  // Live handle (anton-susu): expose this ticket's session + worktree while it runs; each ticket's
  // dispatch overwrites the last, so the handle always names the job's CURRENT session.
  ctx.report({ sessionId, cwd: worktreePath });

  // This ticket's wall clock (anton-t1mo). A DERIVED signal — the job's abort still propagates
  // through it — so every child process a step spawns dies on either. The job-level signal is left
  // untouched: it means "the whole run is over", and the catch below reads it (not this one) to tell
  // an operator's kill from a ticket that merely ran long.
  //
  // Snapshot the tree BEFORE any step runs, so the timeout path can put back exactly what this
  // ticket found. Everything committed at this point belongs to earlier tickets; the delta a
  // timeout leaves behind is this ticket's alone — which is what makes rolling it back safe, and
  // what stops half-finished work from being swept into the NEXT ticket's commit.
  const ticketAbort = new AbortController();
  const abortTicket = () => ticketAbort.abort();
  ctx.signal.addEventListener("abort", abortTicket, { once: true });
  if (ctx.signal.aborted) ticketAbort.abort();
  let ranOutOfTime = false;
  const deadline =
    Number.isFinite(timeoutMs) && timeoutMs > 0
      ? setTimeout(() => {
          ranOutOfTime = true;
          ticketAbort.abort();
        }, timeoutMs)
      : null;
  if (deadline && typeof deadline.unref === "function") deadline.unref();
  // Read unconditionally, because two steps of the ticket need it and only one of them is the
  // timeout: `step:commit` compares HEAD against this baseline to tell an agent that changed
  // nothing from one that committed its own work (anton-8t1f), and that question is asked on every
  // ticket, not just the ones running under a deadline.
  //
  // Best-effort either way: an unreadable baseline costs the rollback, not the timeout — the ticket
  // is still stopped and blocked, and the run reports that its partial work had to be left in
  // place. `step:commit` likewise falls back to reading the index alone.
  const baseline = await readWorktreeState(worktreePath).catch(() => null);

  // This ticket's step context: the run's, narrowed to this ticket. The session is opened HERE and
  // handed in, so one session still covers the whole ticket — dispatch, gates and commit — exactly
  // as before. The claude driver is built per step below, so a resumed session is told which step it
  // is continuing.
  const ticketRunCtx = { ...ctx, signal: ticketAbort.signal };
  const ticketCtx: StepContext = {
    ...run,
    ctx: ticketRunCtx,
    tickets: [ticket],
    session,
    ...(baseline ? { ticketStartHead: baseline.head } : {}),
  };

  let committed = false;
  // The agent's machine-readable self-report (anton-j5i8) — `delivered` or `blocked — <reason>`,
  // already recorded on the session log by the dispatching step. It CORROBORATES the
  // delivery-evidence gate below, never replaces it; a missing/unparseable line (null) simply
  // falls through to it. Declared OUTSIDE the try so the catch can put the agent's own reason on
  // the bead note (anton-vqql) — a block the operator reads on the board instead of reconstructing
  // from the session log.
  let selfReport: AntonResult | null = null;
  try {
    // The ticket phase of the walk (anton-lnkt): the formula's steps up to and including its commit,
    // in formula order, each dispatched through the registry against THIS ticket. The walk replaces
    // the order these ran in, never the guards around them — the delivery-evidence gate below is
    // still what decides whether the ticket is done.
    for (const { step: cooked, definition } of args.steps) {
      // Every step boundary is a lease checkpoint, exactly as every ticket boundary is.
      run.assertLeaseHeld?.();
      const result = await definition.handler({
        ...ticketCtx,
        step: cooked,
        // In-session resume for a transient mid-stream death (anton-juar) — the dispatch machinery
        // the step inherits from the run rather than a second driver of its own. On the TICKET's
        // context, so a resume is refused once this ticket's budget is spent, exactly as it is on a
        // job-level abort (resuming into a signal that is already aborted only burns the budget).
        deps: {
          runClaude: resilientClaude({
            db,
            ctx: ticketRunCtx,
            sessionId,
            logPath,
            ticket,
            stepId: cooked.id,
          }),
        },
      });
      // A `blocked` or `needs-human` self-report is STICKY across a phase with several dispatching
      // steps, by SEVERITY (see {@link selfReportRank}). A later agent — a `step:claude` the project
      // added after `implement` — reports on its own work only, so letting its `delivered` overwrite
      // an earlier block would close a ticket the implementer declared incomplete on the partial
      // changes it left behind. An ask still outranks an earlier block, because it names the exact
      // move a person owes; sticking on the block instead would drop it silently and settle the run
      // behind no gate at all (PR #205 review). A missing/unparseable line (null) keeps whatever the
      // phase reported before it, as it always has.
      const reported = result.facts?.selfReport;
      if (reported && selfReportRank(reported.outcome) >= selfReportRank(selfReport?.outcome)) {
        selfReport = reported;
      }

      // The agent asked for a HUMAN (anton-287p): the next step belongs to a person — a credential,
      // a dashboard click, a judgement call — not to another attempt. Judged HERE, at the step that
      // raised the ask, rather than at the ticket's exits: what a person owes is usually the very
      // thing the NEXT step needs, so a `verify` allowed to run would throw on the missing
      // credential/account and MASK the ask — the run would take the generic failure path and park
      // behind no gate at all. Judged before the delivery-evidence gate too, because an ask is
      // legitimate with or without a diff: the common shape is an agent that got as far as it could
      // and stopped, which that gate would file as a zero-diff false stall a human then has to
      // decode. Whatever partial work it left stays in the parked run's worktree, which the resume
      // continues in — uncommitted, since only a dispatching step can raise an ask and every one of
      // them precedes the ticket's commit. The run parks on a human
      // gate carrying this ask instead (see the run-level catch).
      if (selfReport?.outcome === "needs-human") {
        throw new NeedsHumanError(ticket.id, selfReport.reason);
      }

      if (definition.name !== "commit") {
        // A step that RAN and did not achieve its work halts the ticket (and, through it, the epic).
        // Verify gates and any other throwing step propagate untouched, so the runner's own
        // classification — quota → backoff, poison → park — still applies unchanged.
        if (!result.ok) {
          throw new Error(
            result.detail ?? `formula step "${cooked.id}" (step:${definition.name}) failed for ${ticket.id}`,
          );
        }
        continue;
      }

      // The commit is the ticket's evidence of record — honor the step's { committed } verdict. A
      // clean agent exit that leaves NO diff delivered nothing: the exact false-success in issue #46
      // (root cause #1). Do NOT close/advance the ticket on empty delivery. Throw a NoDeliveryError
      // so the catch below BLOCKS the ticket for a human (never re-queues it open) and the error
      // propagates out of the ticket loop, halting dispatch of the rest of the epic. NoDeliveryError
      // is poison, so the runner parks the run for a human instead of retrying claude to the same
      // empty result forever.
      committed = result.facts?.committed === true;

      if (!committed) {
        // Empty tree: the delivery-evidence gate blocks + halts. Cross-check the self-report and
        // fold it into the reason (anton-j5i8): a `delivered` claim on an empty tree is the exact
        // false success the gate exists to catch; a `blocked` self-report corroborates the block and
        // carries the agent's own reason forward. A missing line just reads as the plain gate message.
        throw new NoDeliveryError(
          `${ticket.id} produced no delivery: claude exited cleanly and passed the verify gates but ` +
            `left no changes to commit (zero diff). Blocking the ticket for operator review and ` +
            `halting the epic — nothing landed, so closing it would be a false success.` +
            selfReportSuffix(selfReport),
        );
      }

      // Commit evidence exists, but the agent SELF-REPORTED blocked (anton-j5i8): it is telling us
      // the ticket is not actually done. Honor that honest signal — block the ticket for a human
      // rather than closing it on a partial change. This is NOT a self-report-alone failure (out of
      // scope): there IS commit evidence; we surface the contradiction (work committed + agent-declared
      // block) so the partial work isn't lost and a human decides. A `delivered`/missing self-report
      // with a real commit is the normal path and proceeds to close/in-review below.
      if (selfReport?.outcome === "blocked") {
        throw new BlockedByAgentError(
          `${ticket.id} was self-reported blocked by the agent (${formatAntonResult(selfReport)}) even ` +
            `though it committed changes. Blocking the ticket for operator review and halting the epic — ` +
            `the agent declared the work incomplete, so closing it would be a false success.`,
        );
      }
    }

    // Persist this ticket's "code done" state the moment it commits. An epic child closes (stage
    // → done). A standalone target isn't closed until its PR merges, so instead move it to
    // stage:in-review here (dropping implementing): that is both its board state and the persisted
    // resume marker, so a retry after a failed PR step skips it rather than re-running claude on
    // committed work. endSession still records the work done either way.
    if (closeOnDone) {
      await safe(() => beads.close(repo, ticket.id));
    } else {
      await safe(() => beads.tag(repo, ticket.id, [LABELS.stage("in-review")]));
      await safe(() => beads.untag(repo, ticket.id, [LABELS.stage("implementing")]));
    }
    await endSession(db, clock, sessionId, "done");
  } catch (e) {
    await endSession(db, clock, sessionId, "failed");
    // Record the no-delivery / agent-blocked reason in the session log too, so it's visible when
    // tailing/replaying the session — not just in the run row's error. Best-effort; never mask the
    // run's own error.
    const noDelivery = e instanceof NoDeliveryError;
    const agentBlocked = e instanceof BlockedByAgentError;
    // The ask is the RUN's wait, never the ticket's state (anton-287p.3). The run parks behind a
    // human gate and resumes THIS row once a person resolves it — and a `blocked` ticket is not
    // claimable, so blocking it below would make that resume impossible: the resumed run dies on
    // `bd update --claim` and the park becomes permanent. Left open and unassigned instead, which
    // is what the resumed run re-claims. What a human owes is on the gate, not on this bead.
    const needsHuman = e instanceof NeedsHumanError;
    if (noDelivery) {
      await appendSessionLog(logPath, `[no-delivery] ${e.message}\n`).catch(() => {});
    } else if (agentBlocked) {
      await appendSessionLog(logPath, `[agent-blocked] ${e.message}\n`).catch(() => {});
    }
    // OUT OF TIME (anton-t1mo) — checked FIRST, because this ticket's signal is aborted on this
    // path too and every check below would read it as an operator's kill. This abort has a known
    // author (anton) and a known remedy, so unlike a kill it settles the ticket here: roll the
    // partial work back, block the bead with the reason, and let the caller carry on with the next
    // ticket.
    //
    // The rollback is the half that keeps the REST of the run honest. A ticket stopped mid-edit
    // leaves a dirty tree, and the next ticket's commit step would sweep those changes up as its
    // own — the feature's history then attributes work to a ticket that never did it, and
    // unreviewed half-work rides into the PR under someone else's name.
    // `!ctx.signal.aborted` breaks the tie when both fired: an operator's kill outranks the budget,
    // and the abort path below is the one that writes nothing to a board a human is deciding on.
    if (ranOutOfTime && !ctx.signal.aborted) {
      await appendSessionLog(
        logPath,
        `[ticket-timeout] ${ticket.id} exceeded its ${Math.round(timeoutMs / 60_000)}m budget\n`,
      ).catch(() => {});
      // NEVER roll back a ticket that already committed. The baseline is the commit this ticket
      // STARTED from, so a reset onto it would delete that commit — and a ticket whose commit
      // landed has delivered real, gate-passed work; only its bookkeeping was cut short. The
      // rollback exists for the uncommitted case, which is the only one that can leak into the
      // next ticket's commit.
      const rolledBack =
        !committed && baseline
          ? await safe(() => restoreWorktreeState(worktreePath, baseline))
          : false;
      // A rollback that failed — or was impossible, because the baseline itself was unreadable —
      // may have left this ticket's files in the worktree the NEXT ticket commits from. Re-read the
      // tree rather than assume: only changes actually left behind are dangerous, and a tree that
      // can't be read at all counts as dangerous.
      const leftovers =
        !committed && !rolledBack && (await leftChangesBehind(worktreePath, baseline));
      await safe(() => beads.setStatus(repo, ticket.id, "blocked"));
      await safe(() => beads.unassign(repo, ticket.id));
      await safe(() => beads.untag(repo, ticket.id, [LABELS.stage("implementing")]));
      // Rolled back ⇒ nothing from this ticket is on the branch, so it is in no PR: mark it, or
      // merge finalization closes it as shipped when the rest of the feature lands (anton-67xj).
      // A ticket stopped AFTER its commit is NOT marked — its work is in the diff a human merges.
      // The marker is finalization's only input, so it is retried rather than best-effort; a run
      // that still cannot record it must not reach its PR (escalated below, once the note is on the
      // bead — the operator needs the timeout's own account either way).
      const marked =
        committed || (await mustPersist(() => beads.tag(repo, ticket.id, [LABELS.notDelivered])));
      await safe(() =>
        beads.note(
          repo,
          ticket.id,
          `anton: stopped after ${Math.round(timeoutMs / 60_000)}m — the ticket outlived its ` +
            `budget, so the run blocked it and carried on with the rest of the feature. ` +
            (committed
              ? `Its work IS committed on the branch (it was stopped after the commit) — review it ` +
                `and close the ticket by hand if it is complete. `
              : leftovers
                ? `Its partial work could NOT be rolled back and is STILL in the run's worktree ` +
                  `(${worktreePath}), so the run stopped rather than let another ticket commit it — ` +
                  `clear the worktree by hand before resuming. `
                : `Its partial work was rolled back (nothing from it is on the branch). `) +
            `Re-scope it into smaller tickets, or raise ticketTimeoutMinutes, then resume the run`,
        ),
      );
      // Either halt below PARKS the run and tells the operator to resume it, so this ticket has to
      // stay claimable (anton-67xj). The block above left it `blocked` — or `in_progress` and
      // unowned, if that best-effort status write failed — and runTicket's hard claim gate refuses
      // both, so the advertised resume would die on its own first step. Put it back at `open`, the
      // same restore the stale-marker path performs; the note above is what carries the timeout's
      // account to the operator, not the status. A timeout the run ABSORBS keeps `blocked` here: it
      // carries on to a PR, and the block is the human's cue — and if that run later stops instead,
      // its own stopping path reopens what it absorbed, for exactly the reason above.
      if (leftovers || !marked) await safe(() => beads.setStatus(repo, ticket.id, "open"));
      // The rollback is what keeps the REST of the run honest, so its failure cannot be absorbed
      // the way the timeout itself is: the next ticket captures its baseline from this same tree
      // and would commit these leftovers under its own name. The bead note can't prevent that —
      // nothing pauses the run, so the wrong commit lands long before an operator reads it. Halt
      // instead (poison → park) and let a human clear the tree before anything else commits.
      if (leftovers) {
        throw new WorktreeDirtyError(
          `${ticket.id} exceeded its ${Math.round(timeoutMs / 60_000)}m ticket budget and its ` +
            `partial work could NOT be rolled back — the run's worktree (${worktreePath}) still ` +
            `carries changes that the next ticket would commit as its own, so the run stopped ` +
            `here. Clear the worktree by hand, then resume the run`,
        );
      }
      // Same reasoning one step further out: this ticket's work is on no branch, and without the
      // marker the merge of the PR carrying the REST of the feature closes it as shipped. The note
      // above can't prevent that — finalization reads labels, not prose — so halt instead of
      // absorbing this timeout and walking on toward a PR that would swallow the ticket.
      if (!marked) {
        throw new PoisonEpic(
          `${ticket.id} exceeded its ${Math.round(timeoutMs / 60_000)}m ticket budget and its ` +
            `partial work was rolled back, but bd would not record \`${LABELS.notDelivered}\` on ` +
            `it — the run stopped rather than carry on to a pull request whose merge would close ` +
            `this undelivered ticket as shipped. Check the beads DB, then resume the run`,
        );
      }
      throw new TicketTimeoutError(ticket.id, timeoutMs, committed);
    }
    // An ABORTED ticket writes nothing to the board (anton-6xj0). The abort's author decides this
    // ticket's fate, not this unwinding handler: an abandon settles it (closed + `abandoned`, the
    // stage label cleared — beads.abandon does all three), a force-kill or a lost lease leaves it
    // claimed for the resume that follows. Writing here would race the abandon's own writes — the
    // handler unwinds in milliseconds while `bd close` takes far longer, so whichever landed last
    // would win — and reopening a ticket a human just killed re-queues it into the ready pool,
    // while blocking it would file the operator's own decision as a failure needing attention.
    // The error still propagates: the run stops, and the cancelled job means no park.
    // The same holds for a ticket abandoned WITHOUT this job being killed — an abandon on another
    // machine, arriving by sync, while this ticket happened to fail here. Its outcome is settled;
    // don't rewrite it. Checked second because it costs a bd read, and only on the failure path.
    const settledElsewhere =
      !ctx.signal.aborted &&
      (await beads
        .show(repo, ticket.id)
        .then((b) => beads.isAbandoned(b))
        .catch(() => false));
    if (ctx.signal.aborted || settledElsewhere) {
      const why = ctx.signal.aborted ? "aborted" : "abandoned";
      await appendSessionLog(logPath, `[${why}] ${ticket.id} was ${why} mid-run\n`).catch(() => {});
      // "Writes nothing to the board" covers the RUN's writes too, and the ask is one of them: the
      // run-level catch turns a NeedsHumanError into a `human` gate blocking the target. That gate
      // outlives the cancellation — a person must clear it by hand, and on an abandoned target
      // gate-check never resumes anything that would. Cancellation wins; the ask travels as a plain
      // stop instead, carrying what was asked so it still reaches the operator through the run row.
      if (e instanceof NeedsHumanError) throw new CancelledAskError(ticket.id, why, e.ask);
      throw e;
    }
    // Release the claim so the board never shows a dead session's ticket as in-flight
    // (anton-live-sync R10). A usage-limit park is NOT dead — the run resumes with the claim
    // intact. Two states must NOT silently re-queue the ticket open: work already landed on the
    // branch (commits exist), OR the agent delivered nothing at all (zero diff). Both are
    // human-review states — block with an operator-facing note. Resetting a no-delivery ticket to
    // open would silently re-queue it into the ready pool and hide the false-success. A
    // `needs-human` ask is the exception to that rule and is excused above. All
    // best-effort: never mask the run's error; the epic-level finally sync pushes the release.
    if (!isUsageLimitError(e)) {
      if ((committed || noDelivery || agentBlocked) && !needsHuman) {
        await safe(() => beads.setStatus(repo, ticket.id, "blocked"));
        // The tip this ticket's work landed on — the operator's route from the note straight to the
        // diff. Best-effort and only when something was committed: an unreadable worktree costs the
        // sha, never the note.
        const head = committed
          ? await readWorktreeState(worktreePath)
              .then((s) => s.head)
              .catch(() => undefined)
          : undefined;
        await safe(() =>
          beads.note(
            repo,
            ticket.id,
            ticketBlockNote({
              kind: noDelivery ? "no-delivery" : agentBlocked ? "agent-blocked" : "post-commit",
              selfReport,
              error: e,
              sessionId,
              branch: run.branch,
              head,
            }),
          ),
        );
      } else {
        await safe(() => beads.setStatus(repo, ticket.id, "open"));
      }
      await safe(() => beads.unassign(repo, ticket.id));
      await safe(() => beads.untag(repo, ticket.id, [LABELS.stage("implementing")]));
    }
    throw e;
  } finally {
    // The ticket is over either way — stop its clock and stop listening to the job's, so a long run
    // doesn't accumulate one live timer and one abort listener per ticket it has already finished.
    if (deadline) clearTimeout(deadline);
    ctx.signal.removeEventListener("abort", abortTicket);
  }
}

// ── merge wait (anton-k0kj) ──

/**
 * How long a merge wait may go unanswered before it stops being a wait and becomes a stall. Nothing
 * in bd acts on it — a `gh:pr` gate resolves on MERGE and on nothing else, and the `timer` scope
 * does not even enumerate a gh gate that carries a timeout (measured on bd 1.1.0 and 1.1.2) — so
 * this is purely the deadline gate-check's expiry pass reads to surface the wait for a human ONCE.
 * Generous on purpose: a week of review is slow, not broken, and the note costs one glance.
 * Go duration syntax, which has no `d` unit.
 */
const MERGE_GATE_TIMEOUT = "168h";

/**
 * Arm the run target's merge wait: a `gh:pr` gate on THIS PR number, so "waiting for merge" is board
 * state that `bd gate check` settles project-wide in one call, instead of a sweep that re-reads every
 * open PR to discover a merge (anton-k0kj). gate-check closes the gate when the PR merges and hands
 * the target to review-fix, whose merge-finalize behaviour is unchanged.
 *
 * Two cases the arm has to get right, both on the recovery path:
 *
 *   • ALREADY ARMED for this same PR (a re-run that reused the open PR) — create nothing. Re-creating
 *     would leave two gates racing to close the same wait. Every OTHER open merge gate on the target
 *     is still resolved first, so a stale one left behind by a failed resolve doesn't survive.
 *   • ARMED FOR A DIFFERENT PR — this target's previous PR was closed without merging and this run
 *     re-opened it under a new number. bd leaves that gate open FOREVER (a closed-unmerged PR
 *     escalates, it never resolves), so it must be resolved here or it lingers as a dead wait that
 *     gate-check would later surface as a stall against a PR nobody is waiting on.
 *
 * `board` is the run's own snapshot; gate beads reach it via loadAllIssues. A snapshot too old to
 * carry a gate just means a duplicate gate on the same PR number — both resolve on the same merge.
 *
 * A legacy `epic` run target gets NO gate: bd refuses the edge outright ("epics can only block other
 * epics, not tasks" — a gate bead is not an epic), and a failed `gate create` still leaves the gate
 * bead behind, blocking nothing. So the case is refused here rather than attempted: that target keeps
 * learning about its merge from the review-fix sweep, exactly as before. Features and standalone
 * task/bug targets — every run target the tier split produces — take the gate.
 */
/**
 * What arming this target's merge wait has to do, from the board alone: every open merge gate that
 * awaits a DIFFERENT PR (`stale`), and whether this PR's own wait still has to be created.
 *
 * ALL the stale gates, not the first: a `gateResolve` that failed on an earlier run leaves a
 * superseded gate open ALONGSIDE the replacement, and dependency order says nothing about which is
 * seen first. Stopping at the current PR's gate would strand the other as a dead wait that
 * gate-check later surfaces as a stall against a PR nobody is waiting on.
 */
export function mergeGatePlan(
  board: Bead[],
  targetId: string,
  awaitId: string,
): { stale: Gate[]; create: boolean } {
  const byId = new Map(board.map((b) => [b.id, b]));
  const armed = (board.find((b) => b.id === targetId)?.dependencies ?? [])
    .filter((d) => d.type === "blocks")
    .map((d) => byId.get(d.depends_on_id))
    .filter((b): b is Gate => b !== undefined && b.status !== "closed" && beads.isMergeWaitGate(b));
  return {
    stale: armed.filter((g) => g.await_id !== awaitId),
    create: !armed.some((g) => g.await_id === awaitId),
  };
}

async function armMergeGate(
  repo: string,
  targetId: string,
  prRef: string,
  board: Bead[],
): Promise<void> {
  const number = prNumberFromRef(prRef);
  if (number === undefined) return; // not a PR pointer (a tracker ref) — nothing to wait on
  const target = board.find((b) => b.id === targetId);
  if (target && beads.isEpic(target)) {
    console.log(
      `[execute-epic] ${targetId} is an epic — bd refuses a gate edge onto one, so its merge stays ` +
        `on the review-fix sweep (no gh:pr gate armed for PR #${number})`,
    );
    return;
  }
  const awaitId = String(number);

  const { stale, create } = mergeGatePlan(board, targetId, awaitId);

  for (const gate of stale) {
    const resolved = await safe(() =>
      beads.gateResolve(
        repo,
        gate.id,
        `PR #${gate.await_id} is no longer ${targetId}'s pull request — superseded by #${awaitId}`,
      ),
    );
    // A stale gate bd never auto-resolves (a closed-unmerged PR escalates forever) is a permanent
    // artifact if this write is lost — say so rather than leaving a dead wait to be surfaced later
    // against a PR nobody is waiting on.
    if (!resolved) {
      console.warn(
        `[execute-epic] could not resolve ${targetId}'s superseded merge gate ${gate.id} ` +
          `(PR #${gate.await_id}) — it stays open alongside the gate for #${awaitId}`,
      );
    }
  }
  if (!create) return; // the wait for this PR already exists — a second gate would race it

  await beads.gateCreate(repo, {
    blocks: targetId,
    type: "gh:pr",
    awaitId,
    timeout: MERGE_GATE_TIMEOUT,
    reason: `${targetId} is in review — waiting for PR #${awaitId} to merge`,
  });
}

// ── human wait (anton-287p) ──

/**
 * An ask as its TICKET raised it — the two halves a gate reason is composed from.
 * {@link NeedsHumanError} satisfies it structurally, so the run's catch passes the error itself.
 */
export interface HumanAsk {
  /** The ticket that raised the ask — where an ANSWER goes, as a human note. */
  ticketId: string;
  /** The agent's ask, verbatim. Undefined when it named none. */
  ask: string | undefined;
}

/**
 * The reason a human gate carries for THIS ask — the string the gate is identified by, so the arm
 * can tell "this ask is already with someone" from "the ask has changed". Shared by the plan and
 * the create so the two can never disagree about what an armed gate looks like.
 *
 * It NAMES the asking ticket (PR #205 review), because the gate's reason is the only evidence the
 * ask leaves on the board: the gate blocks the RUN TARGET, so a feature with several children gives
 * the escalation surface no way back to the child that stopped — and an answer left on the feature
 * never reaches the resumed session, which reads human notes off the ticket it re-dispatches.
 *
 * `<ticket> needs a human: <ask>` is a SHAPE, not just prose: the escalation surface reads the
 * ticket back off it (`askOf`, jobs/run-health.ts), so the two are pinned by a test each.
 */
export function humanGateReason(targetId: string, { ticketId, ask }: HumanAsk): string {
  return `${ticketId} needs a human: ${
    ask ?? `${targetId} stopped for a human, but the agent named no ask`
  }`;
}

/**
 * Marks a human gate ANTON armed for an ask of its own — the only ones a later arm may supersede.
 * Without it every open human gate on the target reads as anton's leftover, and a hold a person put
 * there by hand (`bd gate create --blocks <target>`, the "stop until I say so" gesture) would be
 * auto-resolved by the next ask — breaking the one contract this gate flavour has, that nothing but
 * an explicit human action ends it.
 */
export const HUMAN_GATE_ARMED_LABEL = "gate-armed";

/**
 * Every OPEN human gate blocking the target. The one place the target's waits are read out of a
 * board, so the plan made BEFORE the arm and the reconcile made after it can never disagree about
 * what counts as a wait on this target.
 */
function openHumanGates(board: Bead[], targetId: string): Gate[] {
  const byId = new Map(board.map((b) => [b.id, b]));
  return (board.find((b) => b.id === targetId)?.dependencies ?? [])
    .filter((d) => d.type === "blocks")
    .map((d) => byId.get(d.depends_on_id))
    .filter((b): b is Gate => b !== undefined && b.status !== "closed" && beads.isHumanGate(b));
}

/**
 * What arming this target's human wait has to do, from the board alone: the open gate that already
 * carries THIS ask (`open` — reuse it, a second gate would race it), anton's own earlier waits
 * (`stale` — their ask no longer applies, so they are superseded), and every other open human gate
 * on the target (`held` — a person's own hold, reported but never touched).
 *
 * ALL the stale gates, not the first, for the reason mergeGatePlan resolves all of its own: a
 * `gateResolve` that failed on an earlier run leaves a superseded gate open ALONGSIDE the live one,
 * and dependency order says nothing about which is seen first. It costs more here than it does
 * there — a human gate is a real blocker, so one left behind keeps the target unrunnable until
 * someone finds it by hand.
 *
 * `open` matches on the ask alone, label or not: an arm whose tag write was lost still created that
 * gate, and reusing it is what keeps the arm re-entrant. Ownership only ever narrows what may be
 * CLOSED, never what may be reused.
 */
export function humanGatePlan(
  board: Bead[],
  targetId: string,
  reason: string,
): { stale: Gate[]; held: Gate[]; open: Gate | undefined } {
  const armed = openHumanGates(board, targetId);
  const open = armed.find((g) => gateReason(g)?.trim() === reason.trim());
  const superseded = armed.filter((g) => g !== open);
  return {
    stale: superseded.filter((g) => g.labels?.includes(HUMAN_GATE_ARMED_LABEL) ?? false),
    held: superseded.filter((g) => !(g.labels?.includes(HUMAN_GATE_ARMED_LABEL) ?? false)),
    open,
  };
}

/** What an arm left on the board — and, only while that is safe, how to take it back. */
export interface ArmedHumanGate {
  /** The gate carrying this ask: created here, or the one an earlier attempt armed for it. */
  gateId: string;
  /**
   * Every OTHER open human gate on the target — holds this arm left where they are. Read back AFTER
   * the arm, so a gate armed while this run planned is named in the park too (PR #205 review); an
   * arm that could not complete that read fails rather than returning a list it knows is partial.
   */
  held: string[];
  /**
   * Resolve the gate this call created, returning the target to the state the arm found it in.
   *
   * Offered ONLY while undoing cannot be the thing that leaves the target bare (anton-287p): the
   * gate was created here AND no older wait was retired behind it. Absent for a gate an earlier
   * attempt armed — not this run's to take back — and absent after a supersede, where resolving the
   * replacement would leave the target carrying no wait at all on an ask nobody answered. Answers
   * whether the gate is actually gone; a resolve that failed leaves it standing.
   */
  undo?: () => Promise<boolean>;
}

/**
 * Arm the run target's HUMAN wait: a `human` gate blocking the target, whose reason IS the agent's
 * ask, verbatim. Returns that gate's id alongside the ids of every OTHER open human gate on the
 * target — the holds a person armed, which this arm leaves untouched but which keep the target
 * blocked, so the park message can name them instead of promising one `bd gate resolve` is enough.
 *
 * The one gate flavour nothing automates away, by design on both sides: `bd gate check` never
 * evaluates a human gate, and gate-check's expiry pass deliberately skips it (a wait on a person is
 * never anton's to call overdue). So it carries no timeout and ends only when someone runs
 * `bd gate resolve` — at which point the gate-resume pass hands this target back to the runner,
 * which is why the resume half needed nothing new here.
 *
 * Re-entrant (anton-287p.4), because a park is not the only way this is reached: a settle lost after
 * the gate landed, a resume, or a fresh worktree on another machine all re-run the arm against a
 * board that may already carry the wait. PULLED and then read fresh and STRICTLY — the run's own
 * snapshot predates any gate an earlier attempt (or another machine) armed, and a gate listing that
 * failed must never read as "nothing armed" — then mirror the merge gate's shape:
 *
 *   • THIS ask ALREADY ARMED — return that gate's id, create nothing. Two gates for one ask is one
 *     dead wait: resolving either leaves the target blocked by the other.
 *   • A DIFFERENT ask ANTON armed — this run stopped for a new reason, so the old wait is superseded
 *     and resolved here. Nothing else ever would, and it blocks the target while it lives. Retired
 *     only AFTER the replacement is armed, never before: a create that fails between the two would
 *     otherwise leave the target with no wait at all on an ask nobody answered — runnable again, and
 *     on a shared board claimable elsewhere. Overshooting into two open waits blocks the target
 *     instead of freeing it, and the next arm supersedes what is left.
 *   • A DIFFERENT ask A PERSON armed — left exactly where it is. A hand-made human gate is a hold
 *     only its author may release; superseding it would let this run resume through someone's
 *     explicit stop.
 *
 * THROWS when the gate cannot be created, when a superseded gate cannot be resolved (the replacement
 * stands — it is the target's only blocker by then — and every still-open id rides out in the
 * error), when a kill lands anywhere from the board read through the label write (a gate this run
 * created is undone first, which is safe only while the superseded wait is still open; one it was
 * only reusing is left where it stands), or when the shared board cannot be refreshed or read —
 * before the arm, where arming blind is how the duplicate wait gets made, or after it, where a
 * re-read that fails cannot rule out a gate armed concurrently (the created gate is undone first) —
 * so the caller settles the run LOUDLY instead of parking it. They are all the same failure: a park
 * is only meaningful if resolving the gate it names makes the target runnable, and it does not when
 * there is no gate, when a twin blocks the target, when anton's own superseded wait is still open
 * beside it, or when a wait the park never names holds it. An epic
 * target is the first case up front — bd refuses a gate edge onto one ("epics can only block other
 * epics") and a failed `gate create` still leaves an orphan gate bead behind, so it is refused here
 * rather than attempted.
 */
export async function armHumanGate(
  repo: string,
  targetId: string,
  /** The ask AND the ticket that raised it — both go into the gate's reason (PR #205 review). */
  ask: HumanAsk,
  /** The run's LIVE cancellation signal, re-read immediately before every board write below. */
  signal?: AbortSignal,
): Promise<ArmedHumanGate> {
  const reason = humanGateReason(targetId, ask);
  // A kill can only be observed between awaits, and this function awaits the board twice before it
  // writes anything — so the caller's pre-arm read of the signal is already stale here (anton-287p).
  // Re-read it before each write instead: a gate armed after an operator stopped the run blocks the
  // target until someone clears it by hand, for a wait nobody is waiting on. Refusing the SUPERSEDE
  // matters for the same reason in reverse — resolving the older ask while arming nothing would
  // leave the target with no wait at all, silently runnable again on an ask nobody answered.
  const refuseIfCancelled = (consequence: string) => {
    if (signal?.aborted) {
      throw new Error(
        `refusing to arm ${targetId}'s human gate — the run was cancelled while the board was ` +
          `read; ${consequence}`,
      );
    }
  };
  // The writes below are uninterruptible awaits of their own, so no check BEFORE one covers a kill
  // that lands while it runs (anton-287p): the gate would exist, the caller would read a successful
  // arm, and a cancelled run would park behind a wait nobody is waiting on. Re-read the signal after
  // each and undo the create, so the ask settles in its cancelled form exactly as if it never landed.
  //
  // Only ever called BEFORE the supersede: undoing is safe exactly while every wait this ask
  // supersedes is still open, so the undo can never be what leaves the target bare.
  const undoIfCancelled = async (gateId: string, during: string) => {
    if (!signal?.aborted) return;
    const undone = await safe(() =>
      beads.gateResolve(repo, gateId, `run cancelled while ${targetId}'s human gate was armed`),
    );
    if (undone) {
      throw new Error(
        `refusing to arm ${targetId}'s human gate — the run was cancelled while ${during}; gate ` +
          `${gateId} was resolved, so the target carries no wait from this run`,
      );
    }
    // The undo was the only thing that would ever have closed it: no automatic pass resolves a human
    // gate, so the target stays blocked until someone clears this id by hand. It rides out in the
    // error because nothing else on the board names it.
    throw new StrandedHumanGateError(
      targetId,
      gateId,
      `the run was cancelled while ${during}, and gate ${gateId} could not be resolved`,
    );
  };
  // Refresh from the SHARED board first, and refuse the arm when that cannot be done (PR #205
  // review). The run's own step-0 pull is a whole run old by the time an ask lands here, and on a
  // shared board another machine — or an operator — can have armed a human gate for this target in
  // between. Planned against a stale local working set that gate is invisible, so the strict read
  // below reports the target as bare and this arm creates a SECOND wait, which the run's next sync
  // then publishes: the same duplicate the read is strict to prevent, and the park would name only
  // the new one. `beads.pull` resolves for a board with no remote and for a shared server (nothing
  // to reconcile in either), so a rejection means exactly "anton cannot establish that it is looking
  // at the current board" — which is not a board to arm a human wait against.
  try {
    await beads.pull(repo);
  } catch (e) {
    throw new Error(
      `refusing to arm ${targetId}'s human gate — the shared board could not be refreshed (${
        e instanceof Error ? e.message : String(e)
      }), so a wait another machine already armed for this ask would be invisible and this arm ` +
        `would stack a second one beside it`,
      { cause: e },
    );
  }

  // STRICT, and no catch: this read is the ONLY thing that can tell "the ask is already with
  // someone" from "nothing is armed", and bd omits gate beads from every ordinary listing — so a
  // best-effort read that lost its `--type gate` leg would report an armed board as bare and create
  // a SECOND wait for the same ask. Two human gates is a wait resolving cannot end: the park names
  // only the new one, and closing it leaves the target blocked by the old one forever, with nothing
  // that ever auto-resolves it. Let the failure reject instead — the caller settles the run FAILED
  // with the ask in its error, which is recoverable; a duplicate gate is not.
  const board = await loadAllIssues(repo, { strictGates: true });

  const target = board.find((b) => b.id === targetId);
  if (target && beads.isEpic(target)) {
    throw new Error(
      `${targetId} is an epic — bd refuses a gate edge onto one, so the ask cannot become a gate`,
    );
  }

  const { stale, held, open } = humanGatePlan(board, targetId, reason);

  /**
   * Retire the waits this ask supersedes — ONLY ever with `armed` already live on the board.
   *
   * Ordering is the safety property (anton-287p): closing the old wait first would, on a `gate
   * create` that fails or a kill that lands in it, leave the target carrying no human gate at all
   * while its current ask is still unanswered — silently claimable again, on a shared board by
   * another machine. Armed-then-retired can only ever overshoot into TWO open waits, which blocks
   * the target rather than freeing it, and which the next arm's own supersede clears.
   *
   * THROWS with every still-open id when a supersede fails, or when a kill lands inside one: past
   * this point the replacement is the target's only blocker, so undoing it is exactly the failure
   * above. The gate stands and rides out in the error instead — the run settles FAILED naming it.
   */
  const retireSuperseded = async (armed: string) => {
    const unresolved: string[] = [];
    for (const gate of stale) {
      const resolved = await safe(() =>
        beads.gateResolve(repo, gate.id, `superseded — ${targetId} now waits on a newer ask`),
      );
      if (!resolved) unresolved.push(gate.id);
    }
    // Nothing else will ever close them, and each is a real blocker while it lives — so a park
    // behind the current ask is a wait resolving the named gate cannot end. Fail the arm instead:
    // the run settles FAILED carrying the ask and every id still holding the target.
    if (unresolved.length > 0) {
      throw new StrandedHumanGateError(
        targetId,
        armed,
        `${targetId}'s superseded human gate(s) ${unresolved.join(", ")} could not be resolved, so ` +
          `they stay open beside the wait this run armed (${armed})`,
        unresolved,
      );
    }
    if (stale.length > 0 && signal?.aborted) {
      throw new StrandedHumanGateError(
        targetId,
        armed,
        `the run was cancelled while ${targetId}'s superseded human gate(s) were retired, so the ` +
          `wait this run armed stands rather than leaving the target with none`,
      );
    }
  };

  // A person's own hold is not anton's to close, and it keeps blocking the target after this ask is
  // answered — the park would otherwise read as though one `bd gate resolve` resumes the run.
  for (const gate of held) {
    console.warn(
      `[execute-epic] ${targetId} also waits on human gate ${gate.id}, which anton did not arm — ` +
        `left open; the run resumes only once that hold is resolved too`,
    );
  }
  const heldIds = held.map((g) => g.id);
  const staleIds = new Set(stale.map((g) => g.id));

  /**
   * End an arm whose holds could not be reconciled — taking the gate back where that is still safe.
   *
   * Mirrors the cancellation unwind, and for the same reason: a gate this call CREATED can be
   * resolved right up to the supersede, so the ask settles exactly as if it never landed. A gate an
   * earlier attempt armed carries this same ask and is not this run's to close — it stands, and
   * rides out named in the error, because nothing else on the board would point at it.
   */
  const unreconciledFailure = async (gateId: string, undoable: boolean, cause: unknown) => {
    const why =
      `${targetId}'s human gates could not be re-read after arming ${gateId} (${
        cause instanceof Error ? cause.message : String(cause)
      }), so a gate armed for this target while this run planned would be missing from the park`;
    if (undoable) {
      const undone = await safe(() => beads.gateResolve(repo, gateId, `arm abandoned — ${why}`));
      if (undone) {
        return new Error(
          `refusing to park ${targetId} behind ${gateId} — ${why}; the gate was resolved, so the ` +
            `target carries no wait from this run`,
          { cause },
        );
      }
    }
    return new StrandedHumanGateError(targetId, gateId, why);
  };

  /**
   * Re-read the target's waits AFTER the arm, so the park names every gate that actually holds it
   * (PR #205 review).
   *
   * The plan above and the write below are separate bd transactions with nothing serializing them:
   * an operator — or another machine, whose commits are global the moment bd makes them on a shared
   * server — can arm a human gate for this target in the window between them. That gate is invisible
   * to the plan, so a park composed from the plan alone promises the operator that resolving THIS
   * run's gate resumes the run, while the target stays blocked by a wait nothing names.
   *
   * REPORTS rather than resolves, whoever armed it: a gate that appeared after the plan was made was
   * never judged against this ask, and closing a live wait anton did not plan to supersede is
   * exactly what the ownership label exists to prevent. The waits this ask DOES supersede are
   * excluded — they are retired moments later, and naming them would send the operator after gates
   * that are about to close.
   *
   * ABORTS the arm when the re-read fails, rather than falling back to the plan's holds (PR #205
   * review). The plan is exactly the reading that cannot see a gate armed since it was taken, so
   * parking on it publishes a message promising that resolving anton's gate resumes the run while an
   * unnamed wait keeps blocking the target — the same dead park the preflight read is strict to
   * prevent, reached from the other side. Failing costs only a re-run: the gate this call created is
   * taken back first (safe here, and only here — the waits this ask supersedes are all still open
   * behind it), and the run settles FAILED carrying the ask.
   */
  const reconcileHeld = async (armed: string, undoable: boolean): Promise<string[]> => {
    let fresh: Bead[];
    try {
      // Pulled as well as re-read: the other writer may be another MACHINE, whose gate reaches this
      // workspace only through a pull. Both legs resolve trivially for a board with no remote.
      await beads.pull(repo);
      fresh = await loadAllIssues(repo, { strictGates: true });
    } catch (e) {
      throw await unreconciledFailure(armed, undoable, e);
    }
    const stillHeld = openHumanGates(fresh, targetId)
      .map((g) => g.id)
      .filter((id) => id !== armed && !staleIds.has(id));
    for (const id of stillHeld.filter((id) => !heldIds.includes(id))) {
      console.warn(
        `[execute-epic] ${targetId} gained human gate ${id} while this run armed ${armed} — left ` +
          `open, because it was never judged against this ask; the run resumes only once it is ` +
          `resolved too`,
      );
    }
    return stillHeld;
  };

  // this ask is already with a human — a second gate would race it
  if (open) {
    // Reconciled before the cancellation check, not after: the re-read is an uninterruptible await
    // like every other, so a kill landing inside it must still reach the refusal below rather than
    // ride out as a successful arm. Not undoable: an earlier attempt armed this wait for this same
    // ask, so a reconcile that fails leaves it standing and names it instead.
    const stillHeld = await reconcileHeld(open.id, false);
    // Reusing writes nothing, so it reaches neither guarded write above — but a successful return is
    // what makes the caller PARK, and a cancelled run must never park (anton-287p). The gate itself
    // stays: an earlier attempt armed it for this same ask, and it is not this run's to take back.
    refuseIfCancelled(
      `gate ${open.id} already carries this ask, so the cancelled run must settle instead of ` +
        `parking behind a wait it is no longer taking`,
    );
    // Still retires what this ask supersedes — the reused gate IS the armed replacement, so an
    // earlier attempt's leftovers would otherwise stay open beside it forever.
    await retireSuperseded(open.id);
    // No `undo`: an earlier attempt armed this wait for this same ask, and closing someone else's
    // live wait is not how this run stops.
    return { gateId: open.id, held: stillHeld };
  }

  refuseIfCancelled("a gate armed now would block the target with nobody waiting on it");
  const gateId = await beads.gateCreate(repo, { blocks: targetId, type: "human", reason });
  await undoIfCancelled(gateId, "the gate was created");
  // Best-effort, unlike everything above: the gate exists and carries the ask, so the park is
  // already valid. A lost tag only costs a later arm the right to supersede this wait — it reads as
  // a person's hold and stays open, which is the safe direction for a gate only a human ends.
  if (!(await safe(() => beads.tag(repo, gateId, [HUMAN_GATE_ARMED_LABEL])))) {
    console.warn(
      `[execute-epic] could not label ${targetId}'s human gate ${gateId} ` +
        `(${HUMAN_GATE_ARMED_LABEL}) — a later ask will leave it open instead of superseding it`,
    );
  }
  // Before the last cancellation check, so that check covers the re-read's own window too. Undoable
  // for the same reason the kill's undo is: the waits this ask supersedes are all still open behind
  // this gate, so taking it back cannot be what leaves the target bare.
  const stillHeld = await reconcileHeld(gateId, true);
  // The label write and the re-read are the last uninterruptible awaits, and a kill landing inside
  // one would otherwise ride out as a successful arm past every check above. Last point an undo is
  // still safe: the waits this ask supersedes are all still open behind it.
  await undoIfCancelled(gateId, "the gate was labelled");
  // Replacement armed — only now is the older ask's wait retired.
  await retireSuperseded(gateId);
  return {
    gateId,
    held: stillHeld,
    // Retiring a wait behind this one spends the right to undo it: resolving the replacement would
    // then leave the target carrying no wait of anton's at all, on an ask nobody answered.
    undo:
      stale.length > 0
        ? undefined
        : () =>
            safe(() =>
              beads.gateResolve(
                repo,
                gateId,
                `run cancelled after ${targetId}'s human gate was armed`,
              ),
            ),
  };
}

/**
 * The park reason on the run row: the agent's ask, WHERE its answer goes, and the command(s) that
 * release the run.
 *
 * Where the answer goes is load-bearing for the asks that are a DECISION rather than an action (PR
 * #205 review). Resolving the gate records only that the wait ended — it carries nothing back — so a
 * resumed session handed the same inputs asks the same question again, and "choose A or B" becomes a
 * permanent resolve/re-arm loop. The channel that DOES reach it is the ticket's human notes: anton
 * inlines them into the dispatch prompt as binding steering (steps/prompts.ts), so an answer left
 * there is read by the very session that re-runs this work. Naming it here is what makes resolving
 * the gate mean "answered" instead of "asked again".
 *
 * Every open human gate is named, not just anton's own. A person's hand-made hold keeps blocking the
 * target after this ask is answered, so a message promising one `bd gate resolve` resumes the run
 * sends the operator down a path that leaves it parked, with nothing naming what still holds it.
 */
function needsHumanParkMessage(e: NeedsHumanError, gateId: string, held: string[]): string {
  const base =
    `${e.message} If answering means telling the run something — a decision, a value, which ` +
    `option to take — leave that answer as a note on ${e.ticketId} first: the resumed session reads ` +
    `human notes as binding steering, while the gate carries nothing back. Then ` +
    `\`bd gate resolve ${gateId}\``;
  return held.length > 0
    ? `${base}. ${held.length} other open human gate(s) on this target were not armed by anton ` +
        `(${held.join(", ")}) — the run resumes only once those are resolved too.`
    : `${base} — closing that gate resumes this run.`;
}

/**
 * The FAILURE reason when the ask could never become board state. Composed from the ask rather than
 * from {@link NeedsHumanError.message}, which promises a park this run deliberately does not take:
 * with no gate there is nothing to resolve, so parking would be a wait nothing can end.
 */
function ungatedAskMessage(e: NeedsHumanError, gateError: string | undefined): string {
  return (
    `${e.ticketId} needs a human: ${e.ask ?? "(the agent named no ask)"}. Its human gate could NOT ` +
    `be created (${gateError ?? "unknown error"}), so nothing on the board carries the ask and no ` +
    `\`bd gate resolve\` can release the run — it is FAILED rather than parked, because a park with ` +
    `no gate is a wait nothing can end. Answer the ask, then re-run the target.`
  );
}

/**
 * Settle the run row for an ask whose gate IS armed, and answer with the error the run throws.
 *
 * Split out of the handler because it is where the two halves of a needs-human park can still come
 * apart (anton-287p): the gate is on the board, and the row write that records the park is both
 * fallible and — like every other await in this unwind — a window a force-kill can land in. Three
 * outcomes, one per way that goes:
 *
 *   • **It landed.** The run is parked behind the gate; the ask rides out as the runner's park,
 *     NAMING that gate ({@link ParkedAskError}) so the sweep reports the wait once, not twice.
 *   • **A kill landed inside it.** Every check in the arm passed before it, and no check follows,
 *     so the row would otherwise read as parked behind a wait nobody is servicing. The arm is taken
 *     back where {@link ArmedHumanGate.undo} says that is still safe, and the gate is NAMED where
 *     it is not; either way the row settles FAILED, like a kill that landed earlier in the arm.
 *   • **The write failed.** The gate stays. Taking it back is the one move that is never right
 *     here — this failed on the run's own database, not on the board, so undoing would leave
 *     nothing at all carrying the ask, and a supersede the arm already retired makes it worse. The
 *     gate is the durable half (run-health reports an open human gate from the instant it opens)
 *     and the job parks LOUDLY naming it, rather than retrying into a park that says "blocked".
 *
 * The first two are decided by the LIVE signal alone, never by whether the write landed (PR #205
 * review): a kill can arrive inside a settle that then rejects too, and reading the failure first
 * would report a stopped run as an ordinary armed ask, with its gate blocking a target nobody
 * returns to. So cancellation is checked first, and the park write's own failure — still true of
 * the row when the corrective write fails as well — rides out alongside it.
 *
 * The second write in the cancelled outcome can fail the same way, and then only the message
 * changes: the unwind's verdict on the gate already happened, so it is carried through
 * ({@link unsettledCancelledAskMessage}) instead of being restated as still armed.
 *
 * A kill can also land AFTER all of this, in the cleanup the caller still has to run — so the first
 * outcome reports itself ({@link ArmedAskSettlement.parked}) and the caller reconciles that window
 * through {@link reconcileCancelledArmedPark}.
 */
export async function settleArmedAsk(args: {
  /** The run target the gate blocks. */
  targetId: string;
  /** The ask as the ticket raised it — the park and failure messages are composed from it. */
  ask: NeedsHumanError;
  /** The error the run's catch received, for the cancelled form of the ask. */
  raw: unknown;
  gate: ArmedHumanGate;
  /** The run's LIVE cancellation signal, re-read AFTER the park write — landed or not. */
  signal: AbortSignal;
  now: () => number;
  /** Write the row, answering with the failure message when the write did not land. */
  settle: (patch: RunPatch) => Promise<string | undefined>;
}): Promise<ArmedAskSettlement> {
  const { targetId, ask, gate, signal, settle } = args;
  // Names the gate from the start, because this is the error the RUNNER parks the job on: an ask
  // whose park message carries no gate id reads to the run-health sweep as a permanent failure, and
  // the wait gets escalated twice (PR #205 review). Replaced below on either path that unseats the
  // park — a cancelled unwind, or a row that could not be settled.
  let thrown: unknown = new ParkedAskError(ask, gate.gateId, gate.held);
  const parkFailure = await settle({
    status: "parked",
    error: needsHumanParkMessage(ask, gate.gateId, gate.held),
  });
  let unsettled = parkFailure;
  // Whether the cancelled unwind below already decided what the board holds. Its verdict — gate
  // taken back, or gate stranded — is the truth about the gate even if the corrective row write
  // then fails, so the still-armed message must not overwrite it.
  let cancelled = false;
  // The kill is read INDEPENDENTLY of whether the park write landed (PR #205 review): a force-kill
  // that arrives inside a settle which then also rejects (SQLITE_BUSY) is still a cancelled run, and
  // gating the unwind on the write would report it as an ordinary armed ask — leaving the gate this
  // run created blocking a target nobody is coming back for.
  if (signal.aborted) {
    cancelled = true;
    const unwound = await unwindCancelledAsk({
      ...args,
      during: "while its park was being recorded",
    });
    thrown = unwound.thrown;
    // The corrective write is the row's last word: when it lands the row is right and a failed park
    // write before it is spent history. When it does not, BOTH failures are still true of the row,
    // so both ride out in the error rather than only the one that happened last.
    unsettled =
      unwound.unsettled && parkFailure
        ? `${parkFailure}, then ${unwound.unsettled}`
        : unwound.unsettled;
  }
  if (unsettled) {
    console.error(
      `[execute-epic] ${targetId}: the run row could not be settled (${unsettled}) — ` +
        (cancelled
          ? `the cancelled unwind's verdict on human gate ${gate.gateId} stands`
          : `human gate ${gate.gateId} is armed`),
    );
    thrown = new PoisonEpic(
      cancelled
        ? unsettledCancelledAskMessage(thrown, unsettled)
        : unsettledAskMessage(ask, gate.gateId, unsettled),
    );
  }
  // `parked` is what the ROW says; `awaitsHumanGate` is what the BOARD holds. They part exactly on a
  // failed park write, and the caller needs both: the row decides how the run settles, the live wait
  // decides what the checkout and the cleanup's kill window still owe.
  return { thrown, parked: !cancelled && !parkFailure, awaitsHumanGate: !cancelled };
}

/** What {@link settleArmedAsk} left behind — the run's error, and whether the park is live. */
export interface ArmedAskSettlement {
  /** The error the run throws: the ask naming its gate behind a standing park, its cancelled form
   * otherwise. */
  thrown: unknown;
  /**
   * True only while the run really is RECORDED as parked behind the live gate — how the run settles.
   * A failed park write leaves the gate standing all the same, so what the cleanup's kill window
   * must reconcile is {@link awaitsHumanGate}, not this.
   */
  parked: boolean;
  /**
   * The gate still STANDS and a person resolving it resumes this run — true whether or not the park
   * row landed, and false only once the cancelled unwind has taken the wait back. It is what the
   * teardown needs (PR #205 review): a park write that failed settles the run as `failed`, and
   * releasing the checkout on that would delete the partial work the resume continues from. It is
   * also the arm a kill arriving LATER (in the handler's cleanup) has to reconcile, via
   * {@link reconcileCancelledArmedPark}.
   */
  awaitsHumanGate: boolean;
}

/** A needs-human wait this run left LIVE on the board — what the cleanup's kill window reconciles. */
export interface LiveArmedAsk {
  gate: ArmedHumanGate;
  ask: NeedsHumanError;
  /** The error the run's catch received, for the cancelled form of the ask. */
  raw: unknown;
  /** Whether the park row landed beside the gate — names the window in the stranded-gate message. */
  parkRecorded: boolean;
}

/**
 * The arm the run's cleanup still owes a reconcile, or `undefined` when nothing is left standing.
 *
 * Keyed on the GATE, not on the park row (PR #205 review): a park write that failed settles the run
 * as `failed` while the wait stays open, which is the sharper version of the very state this window
 * exists to prevent — a gate blocking a target with no row even recording it. Reconciling only the
 * parks that landed would make that the one live arm a cancellation can never take back. Nothing is
 * lost by taking it back: the cancelled form of the ask carries the ask itself, exactly as it does
 * for a kill that lands one await earlier ({@link settleArmedAsk}).
 *
 * A cancellation that call already unwound is settled — the gate is gone or named as stranded — so
 * it leaves no arm here.
 */
export function liveArmedAsk(
  arm: Omit<LiveArmedAsk, "parkRecorded">,
  settlement: ArmedAskSettlement,
): LiveArmedAsk | undefined {
  if (!settlement.awaitsHumanGate) return undefined;
  return { ...arm, parkRecorded: settlement.parked };
}

/**
 * Take a live armed ask back after a kill: undo the gate where {@link ArmedHumanGate.undo} says that
 * is still safe, NAME it where it is not, and record the run FAILED with whichever it was.
 *
 * Shared by the two windows a force-kill can land in once the gate is live and the park is this
 * run's verdict (anton-287p) — inside the park write itself, and inside the cleanup that runs after
 * it. Both leave the same state, because to the operator they are the same event: the run was
 * stopped, and nothing is coming back for the wait it armed.
 */
async function unwindCancelledAsk(args: {
  targetId: string;
  ask: NeedsHumanError;
  raw: unknown;
  gate: ArmedHumanGate;
  signal: AbortSignal;
  /** What the run was doing when the kill landed — names the window in the stranded-gate message. */
  during: string;
  now: () => number;
  settle: (patch: RunPatch) => Promise<string | undefined>;
}): Promise<{ thrown: unknown; unsettled: string | undefined; undone: boolean }> {
  const { targetId, ask, raw, gate, signal } = args;
  const undone = gate.undo ? await gate.undo() : false;
  // Undone, nothing on the board carries the ask — which is exactly what the cancelled form of the
  // error says. Standing, the gate blocks the target with no run coming back for it, so the row AND
  // the runner's park have to name it: the ask's own message would promise a park this run is no
  // longer taking.
  const thrown = undone
    ? askSettleError(raw, signal)
    : new PoisonEpic(
        strandedAskMessage(
          ask,
          new StrandedHumanGateError(
            targetId,
            gate.gateId,
            `the run was cancelled ${args.during}, so the wait armed for the ask stands`,
          ),
        ),
      );
  const unsettled = await args.settle({
    status: "failed",
    error: thrown instanceof Error ? thrown.message : String(thrown),
    endedAt: args.now(),
  });
  return { thrown, unsettled, undone };
}

/**
 * The LAST window a kill can land in once the ask's gate is live (anton-287p): the run's own cleanup
 * — awaiting the in-flight lease refresh, clearing the lease, syncing the board — runs AFTER
 * {@link settleArmedAsk}'s final signal read, is uninterruptible, and a board sync is seconds of
 * network. A force-kill arriving there would otherwise ride out as an ordinary park: the row parked,
 * the gate blocking the target, and no run ever coming back for either — the exact state every check
 * inside the arm exists to prevent, reached one await later. A park write that FAILED reaches the
 * same window with the gate open and no row recording it at all, so it is reconciled here too.
 *
 * Answers `undefined` when there is nothing to reconcile (the run was not cancelled after all), and
 * otherwise the error the run must throw INSTEAD of its ask — the same unwind, and the same row, as
 * a kill that landed one await earlier — plus whether the gate itself was taken back, which is what
 * the caller still owes the board a push for ({@link concludeCancelledArmedPark}).
 */
export async function reconcileCancelledArmedPark(args: {
  targetId: string;
  ask: NeedsHumanError;
  raw: unknown;
  gate: ArmedHumanGate;
  /** The run's LIVE signal, re-read after the cleanup awaits — nothing checks it after this. */
  signal: AbortSignal;
  /**
   * Whether the park row landed beside the gate. Only names the window in the stranded-gate message
   * — the unwind is the same either way — but a run whose park write failed must not be reported as
   * one that recorded a wait it never did.
   */
  parkRecorded?: boolean;
  now: () => number;
  settle: (patch: RunPatch) => Promise<string | undefined>;
}): Promise<CancelledParkReconcile | undefined> {
  if (!args.signal.aborted) return undefined;
  const { thrown, unsettled, undone } = await unwindCancelledAsk({
    ...args,
    during:
      `while it released its lease and synced the board, after its park ` +
      `${args.parkRecorded === false ? "could not be recorded" : "was recorded"}`,
  });
  if (!unsettled) return { thrown, undone };
  console.error(
    `[execute-epic] ${args.targetId}: the run row could not be settled (${unsettled}) — the ` +
      `cancelled unwind's verdict on human gate ${args.gate.gateId} stands`,
  );
  // The row may still read as parked, so the verdict above is carried through rather than restated:
  // it is the only accurate account of what the board holds.
  return { thrown: new PoisonEpic(unsettledCancelledAskMessage(thrown, unsettled)), undone };
}

/** What {@link reconcileCancelledArmedPark} did with the arm the cleanup's kill window caught. */
export interface CancelledParkReconcile {
  /** The error the run throws instead of its ask. */
  thrown: unknown;
  /** The gate was resolved here — a LOCAL board write no machine but this one has seen yet. */
  undone: boolean;
}

/**
 * The whole of the cleanup's kill window (anton-287p, PR #205 review): take the arm back, then
 * finish the two things the ordinary park left standing for a resume that is no longer coming — the
 * checkout kept FOR that park, and the board push that publishes the undo.
 *
 * Both matter only in the cancelled case, and neither has another owner:
 *
 *   • **The checkout.** The teardown already ran and kept it, correctly, because at that moment the
 *     run WAS parked behind a live gate. The reconcile turns that into a failed run nothing resumes,
 *     and no later pass reclaims the tree — the scheduled reaper keeps every worktree whose bead is
 *     still open, and a cancelled run's target is. Left alone, the cancelled run's partial edits sit
 *     there until a human finds them, and the next run on the branch inherits them.
 *   • **The push.** The undo is a local Dolt write and the run's end-of-cleanup sync has already
 *     gone. Until it ships, every other machine still reads the gate as OPEN and the target as
 *     blocked, while this run reports that it armed no gate at all. So a failed push queues the
 *     durable sync-push retry (anton-nowq) AND is named in the run's own error — the run is the only
 *     place that contradiction is visible.
 *
 * Answers `undefined` when there was nothing to reconcile, and otherwise the error the run throws.
 */
export async function concludeCancelledArmedPark(args: {
  /** The gate the park was armed on — named in the error when its undo could not be published. */
  gateId: string;
  /** Take the arm back if the run was cancelled — {@link reconcileCancelledArmedPark}. */
  reconcile: () => Promise<CancelledParkReconcile | undefined>;
  /** Hand back the checkout the teardown kept for the park. Undefined when it kept none. */
  releaseKeptWorktree?: () => Promise<void>;
  /** Publish the undo to the shared board; `false` when the push did not land. */
  push: () => Promise<boolean>;
  /** Queue the durable retry that keeps pushing, and parks for a human on exhaustion. */
  queuePush: () => void;
}): Promise<{ thrown: unknown } | undefined> {
  const reconciled = await args.reconcile();
  if (!reconciled) return undefined;
  if (args.releaseKeptWorktree) await args.releaseKeptWorktree();
  if (await args.push()) return { thrown: reconciled.thrown };
  args.queuePush();
  // Only a gate that WAS taken back can disagree with the board: a stranded one is open here and
  // open everywhere else, and its error already sends the operator to resolve it by hand.
  return {
    thrown: reconciled.undone
      ? new PoisonEpic(unpushedGateUndoMessage(reconciled.thrown, args.gateId))
      : reconciled.thrown,
  };
}

/**
 * The FAILURE reason when the ask DID reach the board but the run row could not record the park.
 * The gate is the durable half and still releases the target, so it is named here: the row may say
 * nothing at all, leaving this message the only place the two halves are connected.
 */
function unsettledAskMessage(e: NeedsHumanError, gateId: string, failure: string): string {
  return (
    `${e.ticketId} needs a human: ${e.ask ?? "(the agent named no ask)"}. Human gate ${gateId} ` +
    `IS armed and carries the ask, but this run's row could not be settled as parked ` +
    `(${failure}), so the run history does not show the wait. Answer the ask, then ` +
    `\`bd gate resolve ${gateId}\` — that still releases the target and resumes the run.`
  );
}

/**
 * The FAILURE reason when a cancelled unwind already settled what the board holds and only the
 * corrective row write failed. Its verdict is carried through verbatim rather than replaced by
 * {@link unsettledAskMessage}, which would contradict it: after a successful undo there is no gate
 * left to resolve, and telling the operator to close one would leave them waiting on an id that no
 * longer exists while the row still reads as parked.
 */
function unsettledCancelledAskMessage(cancelled: unknown, failure: string): string {
  const verdict = cancelled instanceof Error ? cancelled.message : String(cancelled);
  return (
    `${verdict} (The run was cancelled mid-park and its row could not then be settled as failed — ` +
    `${failure} — so the run history may still read as parked; the state described above is the ` +
    `accurate one.)`
  );
}

/**
 * The FAILURE reason when a cancelled unwind DID take its gate back but the push that publishes the
 * undo failed. The resolve is committed in this checkout's Dolt working set alone, so every other
 * machine still reads the gate as open and the target as blocked, while the verdict above says no
 * gate was armed at all. The durable sync-push retry is already queued, so the id is named as the
 * manual fallback rather than as a wait the operator must clear.
 */
function unpushedGateUndoMessage(cancelled: unknown, gateId: string): string {
  const verdict = cancelled instanceof Error ? cancelled.message : String(cancelled);
  return (
    `${verdict} (Resolving human gate ${gateId} could not be pushed to the shared board, so other ` +
    `machines still read it as open and the target as blocked until the queued sync-push lands. If ` +
    `it never does, \`bd gate resolve ${gateId}\` on a machine that can reach the remote.)`
  );
}

/**
 * The FAILURE reason when the arm left a live gate behind that no resume will reach — a kill whose
 * undo failed, or a supersede that failed beside the wait just armed. The ask IS on the board, on
 * gate(s) this run will never come back for. Named explicitly — nothing automatic resolves a human
 * gate, so the target stays blocked until someone clears every id.
 */
function strandedAskMessage(e: NeedsHumanError, stranded: StrandedHumanGateError): string {
  return (
    `${e.ticketId} needs a human: ${e.ask ?? "(the agent named no ask)"}. ${stranded.message}. The ` +
    `run is FAILED rather than parked — no resume is coming for that gate. Answer the ask, clear ` +
    `the gate${stranded.gateIds.length > 1 ? "s" : ""}, then re-run the target.`
  );
}

// ── helpers ──

/** Cap on in-session `claude --resume` retries before escalating to a fresh restart (anton-juar). */
const MAX_RESUME_ATTEMPTS = 2;

export function claudeResumeDecision(
  error: { sessionId?: string; signature: string },
  attempt: number,
  priorSignature?: string,
): { resume: true } | { resume: false; reason: string } {
  if (!error.sessionId) return { resume: false, reason: "no session id" };
  if (error.signature === priorSignature) {
    return { resume: false, reason: `repeated ${error.signature}` };
  }
  if (attempt >= MAX_RESUME_ATTEMPTS) {
    return { resume: false, reason: "resume budget spent" };
  }
  return { resume: true };
}

/**
 * A claude driver with resilient in-session recovery (anton-juar), shaped exactly like `runClaude`
 * so it drops into the step registry's driver seam and every step inherits the recovery. A transient
 * mid-stream
 * death (network drop, truncated stream, exit-without-result) that captured a Claude session id is
 * retried with `claude --resume <id>` — continuing the same conversation instead of re-running the
 * whole ticket from scratch — bounded by MAX_RESUME_ATTEMPTS so a flapping connection can't burn the
 * job's retry budget. A resume that dies the SAME way escalates immediately to a fresh restart. When
 * no session id was captured, the failure is deterministic (non-recoverable), or the resume budget
 * is spent, the error propagates so the job-level runner does today's fresh spawn (then parks after
 * maxAttempts) — resume is best-effort and never a new failure mode.
 */
function resilientClaude(args: {
  db: AntonDb;
  ctx: Pick<JobContext, "signal">;
  /** anton's session row for this ticket — where the captured claude id and the resume log land. */
  sessionId: string;
  logPath: string;
  /** The ticket in scope, for the continuation prompt a resumed session gets. */
  ticket: Bead;
  /**
   * The formula step being dispatched. Every dispatching step in the ticket phase inherits this
   * driver — `implement`, and any `step:claude` the project added — so the continuation prompt names
   * the step rather than implying the resumed session was implementing the ticket.
   */
  stepId?: string;
}): (options: RunClaudeOptions) => Promise<ClaudeResult> {
  const { db, ctx, sessionId, logPath, ticket, stepId } = args;
  return async function dispatch(options: RunClaudeOptions): Promise<ClaudeResult> {
    let resumeId: string | undefined;
    let priorError: string | undefined;
    let priorSignature: string | undefined;

    for (let attempt = 0; ; attempt++) {
      try {
        const result = await runClaude(
          resumeId
            ? {
                ...options,
                // The interrupted step's own context already lives in the resumed conversation, so
                // the prompt is a brief continuation rather than the whole instruction again.
                prompt: continuationPrompt(ticket, priorError, stepId),
                resumeSessionId: resumeId,
              }
            : options,
        );
        // Persist the real Claude session id once the run reports it (diagnostics + future resume).
        if (result.sessionId) await setSessionClaudeId(db, sessionId, result.sessionId).catch(() => {});
        return result;
      } catch (e) {
        // Only a transient (RecoverableClaudeError) failure is resume-eligible. A deterministic/content
        // failure (verify-gate, agent error), poison, or quota is NOT — it propagates unchanged so the
        // runner applies today's fresh-restart/park policy (never a resume that would replay bad state).
        if (!isRecoverableClaudeError(e)) throw e;
        // A killed job (force-kill, or an abandon that cancelled the run — anton-6xj0) aborts the
        // child mid-stream, which looks exactly like a transient death. Never resume through it: the
        // operator asked for this agent to stop, and the retry would spawn against an already-aborted
        // signal anyway. Checked before the resume decision so the abort propagates immediately.
        if (ctx.signal.aborted) throw e;
        // Persist the captured id even on the failure path — a mid-stream death may carry it only via
        // the system-init event, and it's what a fresh-restart's operator or a future resume relies on.
        if (e.sessionId) await setSessionClaudeId(db, sessionId, e.sessionId).catch(() => {});

        const decision = claudeResumeDecision(e, attempt, priorSignature);
        if (!decision.resume) {
          await appendSessionLog(
            logPath,
            `[resume] not resuming (${decision.reason}) — escalating to a fresh restart: ${e.message}\n`,
          ).catch(() => {});
          throw e;
        }
        resumeId = e.sessionId;
        priorError = e.message;
        priorSignature = e.signature;
        await appendSessionLog(
          logPath,
          `[resume] transient failure (${e.signature}); resuming claude session ${e.sessionId} — ` +
            `attempt ${attempt + 2}/${MAX_RESUME_ATTEMPTS + 1}: ${e.message}\n`,
        ).catch(() => {});
      }
    }
  };
}

/**
 * Brief continuation prompt for a resumed session (anton-juar). Whatever the interrupted session was
 * given — the ticket spec, or a `step:claude`'s own prompt — already lives in the resumed
 * conversation, so this only nudges the agent to pick up where it left off. It names the STEP when
 * there is one: the ticket phase can dispatch several agents, and telling a custom step's agent that
 * its session "for <ticket>" was interrupted misdescribes the work it was actually doing. The
 * captured error is injected ONLY when it may have been caused by the agent's own output (e.g. an
 * oversized tool result that tripped a limit) — never for pure infra noise the agent can't act on,
 * which would only distract it.
 */
export function continuationPrompt(ticket: Bead, priorError?: string, stepId?: string): string {
  const subject = stepId ? `the \`${stepId}\` step of ${ticket.id}` : ticket.id;
  const lines = [
    `Your previous session — ${subject} — was interrupted mid-stream by a transient failure and ` +
      `has been resumed with full conversation context. Continue from where you left off — do NOT ` +
      `restart from scratch. Inspect the working tree for partial edits before redoing anything, so ` +
      `you don't duplicate or conflict with work already in progress.`,
  ];
  if (priorError && mayBeAgentCaused(priorError)) {
    lines.push(
      ``,
      `Your previous session ended with: "${truncateField(priorError)}". If that was caused by your ` +
        `own output (an oversized tool result, too-long input), adjust your approach so it doesn't recur.`,
    );
  }
  lines.push(``, `Follow the operating contract in your system prompt.`);
  return lines.join("\n");
}

/**
 * Could this transient error have been triggered by the AGENT's own output rather than pure infra
 * noise (anton-juar)? Oversized-input / context-window / too-large-payload errors are the agent-caused
 * class worth surfacing back into the continuation; a bare network drop is not, so it's left out.
 */
function mayBeAgentCaused(message: string): boolean {
  return /prompt is too long|input (?:is )?too long|too many tokens|maximum context|context (?:length|window)|request (?:entity )?too large|payload too large|too large|\b413\b/i.test(
    message,
  );
}

/**
 * The agent exited clean but delivered no code — a zero-diff commit (issue #46 root cause #1).
 * Poison-classified (`name = "PoisonError"`), so the runner parks the run for a human rather than
 * burning retries: re-running the agent on the same unchanged ticket would just reproduce the empty
 * result. A distinct subclass so runTicket's catch can tell "delivered nothing" apart from other
 * failures and block (never re-queue open) the ticket accordingly.
 */
class NoDeliveryError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = "PoisonError"; // classified as poison by the runner
  }
}

/**
 * The agent committed changes but SELF-REPORTED `ANTON-RESULT: blocked` (anton-j5i8) — it declared
 * the ticket incomplete despite leaving a diff. Poison-classified (`name = "PoisonError"`) so the
 * runner parks for a human rather than retrying: the agent has said it can't finish, so re-running
 * would reproduce the same block. A distinct subclass so runTicket's catch can surface it (block +
 * agent-specific note) apart from a genuine post-commit failure.
 */
class BlockedByAgentError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = "PoisonError"; // classified as poison by the runner
  }
}

/**
 * The agent reported `ANTON-RESULT: needs-human — <ask>` (anton-287p): it stopped because only a
 * person can take the next step, not because it hit a broken state. Distinct from
 * {@link BlockedByAgentError} in what it COSTS the operator — a block is a defect to diagnose, an ask
 * is a minute of their attention — and the run-level catch is what turns it into board state: a
 * `human` gate on the run target carrying {@link ask} verbatim.
 *
 * Poison-classified (`name = "PoisonError"`) so the runner parks rather than burning attempts. A
 * retry cannot answer an ask; only the person can, and resolving their gate is what releases the run.
 */
export class NeedsHumanError extends Error {
  constructor(
    readonly ticketId: string,
    /** The agent's ask, verbatim — the gate's reason. Undefined when it named none. */
    readonly ask: string | undefined,
    /** Overridden only by {@link ParkedAskError}, which names the gate the ask actually reached. */
    message = `${ticketId} needs a human: ${ask ?? "(the agent named no ask)"}. The run is parked ` +
      `until someone answers it.`,
  ) {
    super(message);
    this.name = "PoisonError"; // classified as poison by the runner
  }
}

/**
 * The ask once its gate is LIVE and the run row records the park (anton-287p) — thrown in the plain
 * ask's place so the runner's poison park NAMES that gate.
 *
 * The id is what keeps ONE wait from being escalated twice (PR #205 review). Every poison park is an
 * `exhausted-job` finding — "parked without retrying (permanent failure)" — while the run-health
 * sweep already reports this same pause as the gate's own `needs-human`, the half that says what a
 * person does about it. Carrying the id in the park message is how the sweep recognises the two as
 * one wait ({@link parkedAskGateId}) and keeps only the actionable half; without it the operator
 * gets a second escalation calling a wait on them a permanent failure.
 */
export class ParkedAskError extends NeedsHumanError {
  constructor(
    ask: NeedsHumanError,
    readonly gateId: string,
    /**
     * The target's OTHER open human gates, named in the park for the same reason (PR #205 review):
     * they outlive this ask, so a sweep that knew only {@link gateId} would call the still-waiting
     * job a permanent failure as soon as anton's own gate is answered.
     */
    readonly held: string[] = [],
  ) {
    super(
      ask.ticketId,
      ask.ask,
      `${ask.ticketId} needs a human: ${ask.ask ?? "(the agent named no ask)"}. ` +
        parkedOnGateClause(gateId, held),
    );
  }
}

/**
 * A {@link NeedsHumanError} that a cancellation overtook (anton-287p): the agent asked for a human,
 * and by the time the ask reached the run's catch the job had been force-killed or the ticket
 * abandoned. Thrown in the ask's place so NO gate is armed — a `human` gate is new board state that
 * blocks the target until a person resolves it by hand, and arming one on a run someone just stopped
 * (an abandoned target especially, which gate-check will never resume) leaves a wait nobody asked
 * for. The ask still reaches the operator, through this run's error.
 *
 * Poison-classified exactly like the error it replaces: a retry cannot answer an ask either.
 */
class CancelledAskError extends Error {
  constructor(ticketId: string, why: "aborted" | "abandoned", ask: string | undefined) {
    super(
      `${ticketId} needed a human: ${ask ?? "(the agent named no ask)"}. The ticket was ${why} ` +
        `first, so the run stopped there and armed NO gate — nothing on the board carries the ask. ` +
        `Answer it and re-run the target if the work is still wanted.`,
    );
    this.name = "PoisonError"; // classified as poison by the runner
  }
}

/**
 * A cancelled arm that could not undo its own write (anton-287p): the kill landed while `gate create`
 * ran, so the gate exists — and the `gate resolve` that would have taken it back failed too. Nothing
 * automatic ever closes a human gate, so {@link gateId} keeps blocking {@link targetId} until a
 * person resolves it; the run settles FAILED naming it, because that id exists nowhere else.
 */
export class StrandedHumanGateError extends Error {
  /** Every human gate left open on the target — the wait this run armed first. */
  readonly gateIds: string[];
  constructor(
    readonly targetId: string,
    readonly gateId: string,
    detail: string,
    alsoOpen: string[] = [],
  ) {
    const ids = [gateId, ...alsoOpen];
    super(
      `${detail} — ${targetId} stays blocked until ` +
        `${ids.map((id) => `\`bd gate resolve ${id}\``).join(" and ")} runs`,
    );
    this.gateIds = ids;
  }
}

/**
 * What a run settles on when its ticket asked for a human — the ask itself, or the cancelled form
 * that arms no gate (anton-287p).
 *
 * Takes the LIVE signal, never a snapshot of `aborted`: the epic handler unwinds through several
 * awaited bd writes (releasing the children it reserved) before it settles, and a force-kill that
 * lands during them is still an operator stopping the run. Read too early, the ask would go on to
 * arm a `human` gate that blocks the target until someone clears it by hand, for a run nobody is
 * waiting on. So callers must pass the signal and call this at the settle, not at the catch.
 */
export function askSettleError(raw: unknown, signal: AbortSignal): unknown {
  return raw instanceof NeedsHumanError && signal.aborted
    ? new CancelledAskError(raw.ticketId, "aborted", raw.ask)
    : raw;
}

/**
 * One ticket outlived its wall-clock budget (anton-t1mo — `ticketTimeoutMinutes`).
 *
 * Deliberately NOT poison, and deliberately not fatal to the run: the ticket loop catches this one
 * error and moves to the next ticket, so a feature is never ended by a single ticket that couldn't
 * converge. runTicket has already blocked the bead and rolled its partial work back by the time this
 * is thrown, so nothing downstream needs to settle it — the loop only records which ticket it was.
 *
 * Carrying on is safe only because the worktree is provably clean of this ticket: a rollback that
 * could not prove that raises {@link PoisonEpic} instead, halting the run so no later ticket commits
 * the leftovers as its own.
 */
class TicketTimeoutError extends Error {
  constructor(
    readonly ticketId: string,
    readonly budgetMs: number,
    /**
     * Whether this ticket's work made it into a commit before the clock ran out (the narrow case of
     * a deadline landing on the bookkeeping AFTER the commit step). Its diff is on the branch, so
     * the run still lists it as delivered — only its bead is left unfinished.
     */
    readonly committed: boolean,
  ) {
    super(
      `${ticketId} exceeded its ${Math.round(budgetMs / 60_000)}m ticket budget and was stopped. ` +
        (committed
          ? `Its work IS committed on the branch (only its bead was left unfinished)`
          : `Its partial work was rolled back`) +
        ` and the ticket is blocked for review; the rest of the run continued. ` +
        `Re-scope it (or raise ticketTimeoutMinutes), then resume.`,
    );
    this.name = "TicketTimeoutError";
  }
}

/**
 * The review gate refused to let this run open a PR (anton-omum): blocking findings it could not
 * converge, a reviewer that broke the report protocol, or poison the gate raised itself (a reviewer
 * commit it could not revert, a fixer that moved to a branch of its own).
 *
 * Poison-classified (`name = "PoisonError"`) like {@link NoDeliveryError}, so the runner parks the run
 * for the founder instead of retrying: the reviewer has already had its bounded rounds to converge,
 * and re-running the same gate on the same diff would reproduce the same verdict. Marks the run
 * PARKED rather than failed, so the resume the founder is instructed to do reuses this row.
 */
class ReviewBlockedError extends Error {
  constructor(msg: string, options?: ErrorOptions) {
    super(msg, options);
    this.name = "PoisonError"; // classified as poison by the runner
  }
}

/**
 * Why the gate refused the PR, in one clause — shared by the park note and the thrown error so the
 * bead and the run log say the same thing.
 */
function reviewFailureReason(review: ReviewGateResult, blocking: ReviewFinding[]): string {
  // Ahead of the blocking count: the alarm is why the loop STOPPED where it did, and a founder
  // reading one sentence in the escalation panel needs the trend, not this round's finding tally.
  // The series rides along here because the run row is the only copy when the bd note fails.
  if (review.regression) {
    return (
      `${describeScoreRegression(review.regression)} — ${formatScoreSeries(review.rounds)}` +
      (blocking.length > 0 ? `, with ${blocking.length} blocking finding(s) still open` : ``)
    );
  }
  if (blocking.length > 0) return `${blocking.length} blocking finding(s) survived the gate`;
  switch (finalViolation(review)) {
    case "worktree-modified":
      return `the reviewer modified the worktree it was judging`;
    case "malformed-findings":
      return `the reviewer's findings list was unreadable`;
    case "missing-rationale":
      return `the reviewer scored the run without justifying the score`;
    case "trailing-content":
      return `the reviewer appended text after its report block`;
    default:
      return `the reviewer never reported a valid score`;
  }
}

/** What the park path found on the run's branch: an untracked PR it defused, or a lookup gh refused. */
interface OrphanPullRequest {
  /** The untracked PR open on the branch. Absent when the lookup itself failed. */
  pr?: PullRequest;
  /** Whether that PR is now a draft — it already was, or we flipped it. */
  drafted?: boolean;
  /** True when `gh` could not be asked at all, so an orphan may be sitting there un-drafted. */
  lookupFailed?: boolean;
}

/**
 * Defuse a PR a PREVIOUS attempt opened on this branch that never made it onto the bead (anton-3apm).
 *
 * `gh pr create` can succeed server-side with its response — or the best-effort `setPrRef` after it —
 * lost, so a retry finds no PR ref, re-runs, and reaches this gate with a live PR nobody tracks. Park
 * without touching it and un-reviewed work stays mergeable at the founder's merge gate while anton
 * reports no PR was opened: a false green of exactly the kind this gate exists to prevent. Converting
 * it to a draft keeps the PR (number, threads, body) while making it unmergeable until a resumed run
 * passes the gate and `openPullRequest` readies it again.
 *
 * The ref is deliberately NOT stamped onto the bead here: step 0a treats a ref whose PR is OPEN as
 * proof another run finished the epic, so recording it would make the next resume short-circuit as
 * done — retiring the epic with its blocking findings unaddressed.
 *
 * A lookup gh could not answer is reported as such, never as "no PR": the whole point of this pass is
 * that an un-drafted orphan stays mergeable, and telling the founder no PR was opened on the strength
 * of a network blip is the same false green in a quieter form.
 */
async function reconcileOrphanPullRequest(
  repoPath: string,
  branch: string,
): Promise<OrphanPullRequest | undefined> {
  const { pr, failed } = await lookupOpenPullRequest(repoPath, branch);
  if (failed) return { lookupFailed: true };
  if (!pr) return undefined;
  return { pr, drafted: pr.isDraft === true || (await markPullRequestDraft(repoPath, pr.ref)) };
}

/** What became of an orphan PR, appended to the park message — empty when the branch had none. */
function orphanClause(orphan: OrphanPullRequest | undefined): string {
  if (!orphan) return "";
  if (orphan.lookupFailed || !orphan.pr) {
    return (
      ` WARNING: anton could NOT check whether an earlier attempt left a PR open on this branch ` +
      `(the \`gh\` lookup failed) — if one is open it is still mergeable with this un-reviewed work. ` +
      `Check the branch by hand.`
    );
  }
  return orphan.drafted
    ? ` A PR an earlier attempt had already opened (${orphan.pr.url}) was converted to a DRAFT so ` +
        `this un-reviewed work can't be merged; it returns to ready when the gate passes.`
    : ` WARNING: a PR an earlier attempt had already opened (${orphan.pr.url}) is still open and ` +
        `could NOT be converted to a draft — draft or close it by hand so this un-reviewed work ` +
        `isn't merged.`;
}

/**
 * The park reason on the RUN row — and, when the bead write failed, the findings themselves.
 *
 * A parked run opens no PR, and the score comments carry counts and a rationale, never the notes:
 * the bead note is the findings' only home. If `bd note` fails (locked or unavailable DB) that home
 * doesn't exist, so the run error stops pointing at the bead and reproduces the whole note instead —
 * the run row is persisted (`updateRun`) and surfaced to the founder, which makes it the durable
 * fallback. Claiming "the findings are on the bead" unconditionally was the data loss: the only copy
 * discarded, under a message that told nobody to go looking.
 */
export function reviewParkMessage(args: {
  targetId: string;
  outcome: ReviewGateResult["outcome"];
  /** {@link reviewFailureReason} — the one-line why, without trailing punctuation. */
  reason: string;
  /** {@link reviewParkNote} — the full findings text this run tried to write to the bead. */
  note: string;
  /** Did that write land? */
  noted: boolean;
  orphan?: OrphanPullRequest;
}): string {
  const head = `${args.targetId} did not pass its pre-PR self-review (${args.outcome}): ${args.reason}.`;
  // The note already carries the orphan clause and the resume instruction, so the fallback branch
  // must not append them a second time.
  return args.noted
    ? `${head} No PR opened — the findings are on the bead; resolve them (or fix the ticket) and ` +
        `resume the run.${orphanClause(args.orphan)}`
    : `${head} No PR opened, and writing the findings to ${args.targetId} FAILED (a locked or ` +
        `unavailable beads DB) — nothing else holds them, so they are reproduced here in full; put ` +
        `them back on the bead by hand before resuming:\n\n${args.note}`;
}

/**
 * The park reason on the target bead: what the reviewer refused to pass, in its own words.
 *
 * The ADVISORIES ride along with the blocking findings, because this note is the only place they
 * survive. A parked run opens no PR — the body is where advisories normally reach the founder — and
 * the resumed run re-reviews from scratch with an empty carry, so an advisory the next reviewer
 * doesn't happen to restate would vanish between the review that found it and the merge gate it was
 * meant to reach. The score comment records their count, never their text.
 *
 * A run parked by the score-regression alarm (anton-i98r) leads with the SERIES instead: each round's
 * comment carries its own score, but nobody deciding rework-vs-accept should have to reassemble the
 * trend from a comment thread to see what the alarm saw.
 */
function reviewParkNote(
  review: ReviewGateResult,
  blocking: ReviewFinding[],
  advisory: ReviewFinding[],
  orphan?: OrphanPullRequest,
): string {
  const rounds = review.rounds.length;
  const head = review.regression
    ? // The series is the finding here: no single round failed, the trend did — so it leads, and the
      // blocking findings (if any) are listed beneath it as the detail they now are.
      `anton: the pre-PR self-review stopped on a score regression — ` +
      `${describeScoreRegression(review.regression)}. ` +
      `Score series: ${formatScoreSeries(review.rounds)}. No PR was opened; this needs your call, not ` +
      `another fix round.` +
      (blocking.length > 0 ? `\n\nStill open at that point:` : ``)
    : blocking.length > 0
      ? `anton: the pre-PR self-review left ${blocking.length} blocking finding(s) unresolved after ` +
        `${rounds} round(s) (${review.outcome}) — no PR was opened:`
      : violationParkHead(review, rounds);
  const orphanLine = orphanClause(orphan).trim();
  return [
    head,
    ...findingLines(blocking),
    ``,
    ...(advisory.length > 0
      ? [
          `Advisory findings from the same review (${advisory.length}) — they did not park the run, ` +
            `but no PR carries them, so they are recorded here:`,
          ...findingLines(advisory),
          ``,
        ]
      : []),
    ...(orphanLine ? [orphanLine, ``] : []),
    // A protocol violation lists no findings, so there is no "them" to resolve — the head already
    // named the one thing to fix. A regression names no single fault at all: what it asks for is a
    // decision about the work, which is the whole point of escalating instead of grinding.
    review.regression
      ? `Decide what this run needs — rework the ticket, split it, or accept the work as it stands — ` +
        `then resume the run.`
      : blocking.length > 0
        ? `Resolve them (or correct the ticket), then resume the run.`
        : `Correct the issue above, then resume the run.`,
  ].join("\n");
}

/** The park-note headline when the verdict itself was untrustworthy — which way it broke, and why. */
function violationParkHead(review: ReviewGateResult, rounds: number): string {
  switch (finalViolation(review)) {
    case "worktree-modified":
      return (
        `anton: the pre-PR self-review EDITED the worktree it was judging after ${rounds} round(s) ` +
        `— its changes were reverted and its verdict discarded, because a reviewer that fixes the ` +
        `code cannot vouch for it. No PR was opened; check which reviewer this project is using.`
      );
    case "malformed-findings":
      return (
        `anton: the pre-PR self-review reported an unreadable findings list after ${rounds} round(s) ` +
        `(${review.outcome}) — no PR was opened, because a report anton cannot parse may be hiding a ` +
        `blocking finding.`
      );
    case "missing-rationale":
      return (
        `anton: the pre-PR self-review reported a score with no rationale after ${rounds} round(s) ` +
        `(${review.outcome}) — no PR was opened, because a bare number says nothing about which ` +
        `Acceptance criteria were checked. Check that the reviewer emits a "rationale" with its score.`
      );
    case "trailing-content":
      return (
        `anton: the pre-PR self-review appended text AFTER its report block after ${rounds} round(s) ` +
        `(${review.outcome}) — no PR was opened, because trailing prose is where a reviewer retracts ` +
        `or corrects the verdict above it. Check that the reviewer ends its final message with the ` +
        `json block and nothing else.`
      );
    default:
      return (
        `anton: the pre-PR self-review never reported a valid score after ${rounds} round(s) ` +
        `(${review.outcome}) — no PR was opened, because silence is not a clean review.`
      );
  }
}

/**
 * The salvage note for a reused PR whose body could not be refreshed: this run's advisory findings,
 * plus the warning that the PR text belongs to an earlier attempt.
 *
 * The PR body is the ONLY place the findings' text is written — the score comments carry counts, a
 * verdict and a rationale, not the notes — so without this a `gh pr edit` that failed on a permission
 * or a network blip silently discards every actionable detail this review produced, while the founder
 * reads a stale finding list at the merge gate as if it were current.
 */
function stalePrBodyNote(pr: PullRequest, advisory: ReviewFinding[]): string {
  return [
    `anton: this run reused the PR at ${pr.url} but could NOT rewrite its title/body — what GitHub ` +
      `shows is an earlier attempt's text, not this run's. Read the findings below instead of the PR body.`,
    ``,
    ...(advisory.length > 0
      ? [`Advisory findings from this run's self-review (${advisory.length}):`, ...findingLines(advisory)]
      : [`This run's self-review reported no advisory findings.`]),
  ].join("\n");
}

/**
 * The run-row salvage when BOTH homes for a stale-body run's findings failed: `gh pr edit` refused
 * the refresh AND `bd note` could not record them either (a locked or unavailable beads DB).
 *
 * The run still delivered — the branch and its PR carry the work — so this rides on the completed
 * run row (persisted by `updateRun` and surfaced to the founder) rather than failing it. It
 * reproduces the note IN FULL because at this point nothing else holds the findings' text: the PR
 * body is an earlier attempt's, and the score comment records only their count.
 */
export function stalePrBodyRunError(targetId: string, note: string): string {
  return (
    `The PR body could not be refreshed AND writing this run's self-review findings to ${targetId} ` +
    `FAILED (a locked or unavailable beads DB) — nothing else holds them, so they are reproduced ` +
    `here in full; put them back on the bead by hand:\n\n${note}`
  );
}

/**
 * How much a self-report OUTRANKS the one a phase already carries. A phase of several dispatching
 * steps keeps the most severe report any of them made, and severity is how actionable it is: an ask
 * names the one move a person owes, a block names a defect to diagnose, and `delivered` is a claim
 * a later step cannot make on an earlier step's behalf. An absent report (null) ranks below all
 * three, so the first step to say anything sets the phase's report.
 */
function selfReportRank(outcome: AntonOutcome | undefined): number {
  switch (outcome) {
    case "needs-human":
      return 2;
    case "blocked":
      return 1;
    case "delivered":
      return 0;
    default:
      return -1;
  }
}

/** Fold the parsed self-report into a zero-diff block reason, when one was emitted (anton-j5i8). */
function selfReportSuffix(selfReport: AntonResult | null): string {
  if (!selfReport) return "";
  return selfReport.outcome === "delivered"
    ? ` The agent self-reported ANTON-RESULT: delivered — a false success on an unchanged tree.`
    : ` The agent self-reported ${formatAntonResult(selfReport)}, corroborating the block.`;
}

/**
 * How much of an agent's reason (or a failure's error text) one block note may carry. The note is a
 * board-level summary, not a transcript: enough to decide from, and bounded so a runaway message
 * can't bloat the bead's append-only notes blob. The session log still holds the full text.
 */
const BLOCK_NOTE_DETAIL_CHARS = 400;

/**
 * Flatten to a SINGLE line and cap. Machine notes live one-per-line in the notes blob
 * (beads/notes.ts), so an un-flattened multi-line reason would parse back as several notes — the
 * later lines attributed to anton with no context at all.
 */
function blockNoteDetail(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (!flat) return "";
  return flat.length > BLOCK_NOTE_DETAIL_CHARS
    ? `${flat.slice(0, BLOCK_NOTE_DETAIL_CHARS).trimEnd()}…`
    : flat;
}

export type TicketBlockKind = "no-delivery" | "agent-blocked" | "post-commit";

/**
 * The operator-facing note left on a ticket the run blocked (anton-vqql).
 *
 * Every category used to write one static string, so two tickets blocked for entirely different
 * causes got byte-identical notes and the only route to the difference was finding the run, finding
 * the session, and reading its log. The reason the agent already stated on its `ANTON-RESULT:
 * blocked` line — and the error behind a post-commit failure — belong on the bead, next to the
 * evidence that backs them: the session, and the branch + short sha when work was committed.
 *
 * Exactly one line by construction: the reason is flattened and capped, so `parseTicketNotes` reads
 * it back as one machine note. A missing or unparseable self-report degrades to the category text
 * alone — never an empty quote, never the string "undefined".
 */
export function ticketBlockNote(args: {
  kind: TicketBlockKind;
  /** The agent's parsed `ANTON-RESULT` line, when it emitted one. */
  selfReport: AntonResult | null;
  /** The error that halted the ticket — what a post-commit failure has to say for itself. */
  error?: unknown;
  sessionId: string;
  branch: string;
  /** The committed tip, full sha; absent when this ticket committed nothing. */
  head?: string;
}): string {
  const { kind, sessionId, branch, head } = args;
  const reason = blockNoteDetail(args.selfReport?.reason ?? "");
  // A reason that flattens to nothing is NO reason — drop it, so the rendering falls back to the
  // category text rather than trailing an empty quote or a dangling dash.
  const selfReport = args.selfReport && { ...args.selfReport, reason: reason || undefined };
  const failure = blockNoteDetail(errorText(args.error));

  const body =
    kind === "no-delivery"
      ? `run made no changes (clean agent exit, zero diff) — nothing was delivered; needs a human ` +
        `to implement it or fix the ticket, then resume the run.` +
        selfReportSuffix(selfReport)
      : kind === "agent-blocked"
        ? `the agent self-reported ANTON-RESULT: blocked and committed only partial work — it ` +
          `declared the ticket incomplete${reason ? `: "${reason}"` : ` (no reason given)`}; needs ` +
          `a human to finish or re-scope it, then resume the run.`
        : `run failed after committing work — needs review.` +
          (failure ? ` It failed with: ${failure}` : "");

  const evidence = head
    ? `session ${sessionId}, committed on ${branch} @ ${head.slice(0, 7)}`
    : `session ${sessionId}, nothing committed on ${branch}`;
  return blockNoteOneLine(`anton: ${body} [${evidence}]`);
}

/** The error's own words, or "" when there are none worth repeating. */
function errorText(error: unknown): string {
  if (error === undefined || error === null) return "";
  const text = error instanceof Error ? error.message : String(error);
  return text === "undefined" || text === "null" ? "" : text;
}

/** Last-resort flatten of the whole composed note — the blob is line-delimited, so this is a hard invariant. */
function blockNoteOneLine(note: string): string {
  return note.replace(/\s+/g, " ").trim();
}

/**
 * Tickets whose `agent:` label names a specialist agent the project has disabled (anton-dm7).
 * `activeAgents` is settings.agents; `userAgentIds` are the project's own agents — discoverable
 * `agent:<id>` ids that anton does NOT ship as bundled specialists (see the caller). Semantics:
 *   • absent allowlist (never persisted / cleared) → all agents active (a project that never touched
 *     settings must not stall; the API persists a cleared value as `undefined`, never `[]`)
 *   • EMPTY allowlist `[]` → no BUNDLED agent active: a ticket needing a bundled specialist is parked.
 *     The operator explicitly toggled every bundled agent off, and the API persists `[]` as a real
 *     value distinct from clearing (settings/route.ts) — honoring it is the whole point.
 *   • no `agent:` label → runs with the default agent, never blocked
 *   • a USER agent (id in `userAgentIds`) is NEVER gated — the operator brought it and labeled the
 *     ticket with it deliberately, so it runs regardless of the allowlist. This is the reversal of
 *     anton-dvo.1: the allowlist gates anton's bundled specialists only, not the project's own
 *     `.claude/agents`. An `agent:` label that is neither active nor a known user agent (a disabled
 *     bundled agent, or a typo that resolves nowhere) is still parked — the safety net stands.
 * `userAgentIds` defaults to none, so a caller that doesn't pass it gets the pre-reversal behavior
 * (every non-allowlisted labeled ticket parked) — used by callers/tests that only reason about the
 * allowlist itself.
 */
export function inactiveAgentTickets(
  tickets: Bead[],
  activeAgents: string[] | undefined,
  userAgentIds?: Iterable<string>,
): { id: string; agent: string }[] {
  if (activeAgents == null) return [];
  const active = new Set(activeAgents);
  const userAgents = userAgentIds ? new Set(userAgentIds) : null;
  const out: { id: string; agent: string }[] = [];
  for (const t of tickets) {
    const agent = labelValueOf(t.labels, "agent");
    if (!agent) continue;
    if (active.has(agent)) continue;
    if (userAgents?.has(agent)) continue; // the project's own agent — never gated by the allowlist
    out.push({ id: t.id, agent });
  }
  return out;
}

/**
 * How the TARGET itself stopped being a run target while its run was starting (anton-e42l), named
 * for the error — or undefined when it is still one.
 *
 * {@link ticketSetDrift} watches the subtree; this watches the bead. A parentless task/bug that a
 * re-parent moved under another card has an empty ticket set on BOTH sides of that check — nothing
 * attached, nothing detached — while the bead itself has become a child ticket of somebody else's
 * run target. Left unasked, this run would execute (and settle) a bead the other target's run also
 * owns. Judged with the same `isRunTarget` predicate as the pre-lease gate, so the two agree.
 */
export function runTargetDrift(id: string, board: Bead[]): string | undefined {
  const live = board.find((b) => b.id === id);
  if (!live) return "it is no longer on the board";
  if (beads.isRunTarget(live, board)) return undefined;
  if (beads.isContainer(live, board)) {
    return "it gained a feature child and is now a container epic — run one of its features instead";
  }
  const parent = beads.parentOf(live);
  return parent
    ? `it now hangs under ${parent}, whose run owns it as a ticket`
    : `its type is now "${live.issue_type ?? "unknown"}", which anton never runs on its own`;
}

/**
 * How the target's ticket subtree moved between this run's selection and a board that can see the
 * run's lease (anton-e42l), named for the error — or undefined when it didn't move.
 *
 * Ids only, and status-blind on purpose: `runTickets` filters on SHAPE, not state, so a ticket
 * another machine merely closed mid-window is in both sets and reads as no drift. What this is for
 * is a bead genuinely attached to (or pulled out of) the target while the run was starting up —
 * chiefly an approved gardener re-parent, which is allowed to attach work to any card no run is
 * visibly holding.
 */
export function ticketSetDrift(selected: Bead[], confirmed: Bead[]): string | undefined {
  const before = new Set(selected.map((t) => t.id));
  const after = new Set(confirmed.map((t) => t.id));
  const attached = [...after].filter((id) => !before.has(id));
  const detached = [...before].filter((id) => !after.has(id));
  if (attached.length === 0 && detached.length === 0) return undefined;
  return [
    attached.length > 0 ? `attached ${attached.join(", ")}` : "",
    detached.length > 0 ? `detached ${detached.join(", ")}` : "",
  ]
    .filter(Boolean)
    .join("; ");
}

/**
 * The run's INTERNAL dependency graph — `blocks` edges among the run's own tickets only, as
 * blocker id → the tickets that depend on it. Edges to beads outside the run are another gate's
 * business (`runReadiness` holds those tickets before the loop ever sees them).
 *
 * Shared by the two questions a run asks of that graph: what order to dispatch in
 * ({@link orderTickets}) and, once a ticket fails to deliver, what can no longer run
 * ({@link skippedDependents}). One reader, so the skip can never disagree with the order.
 */
function dependentEdges(tickets: Bead[], all: Bead[]): Map<string, string[]> {
  const ids = new Set(tickets.map((t) => t.id));
  const adj = new Map<string, string[]>(tickets.map((t) => [t.id, []]));
  for (const e of beads.edgesOf(all)) {
    if (e.type !== "blocks") continue;
    // e.from depends on e.to → e.to must come first.
    if (!ids.has(e.from) || !ids.has(e.to)) continue;
    adj.get(e.to)!.push(e.from);
  }
  return adj;
}

/** Why a ticket was never dispatched: the ticket it directly waits on, and the stopped ticket at
 * the head of that chain (the same id when the dependency is direct). */
export interface SkipCause {
  waitingOn: string;
  stopped: string;
}

/** One entry in a run's timeout ledger: the ticket the budget stopped, and whether its work had
 * already been committed when it did. */
export interface TicketTimeoutOutcome {
  id: string;
  committed: boolean;
}

/**
 * Every ticket that transitively depends on a ticket whose work was ROLLED BACK, and why
 * (anton-67xj).
 *
 * A ticket whose budget ran out has its partial work rolled back, so the mechanism the tickets
 * behind it were written against is not on the branch. Dispatching them anyway hands each agent a
 * premise that does not exist — the same false-success shape a cross-run blocker is held for — and
 * the zero diff that follows poisons the whole run, stranding the work its INDEPENDENT tickets
 * already committed. So they are skipped instead, and the run narrows rather than dies.
 *
 * Only a rolled-back timeout cascades, which is why this reads the ledger rather than a list of
 * ids: a ticket stopped AFTER its commit left its work on the branch — the deadline landed on the
 * bookkeeping, not the code — so the tickets behind it still have what they were written against
 * and still run.
 *
 * Breadth-first from the stopped set over the run's own `blocks` edges, so a chain a→b→c skips both
 * b and c; a ticket already recorded is never revisited, which also makes a cycle terminate.
 *
 * `tickets` is the run's WHOLE set, ABANDONED members included (PR #199) — an abandoned ticket is a
 * node the walk crosses, never a verdict it reports. Leaving it out of the graph would cut a→b→c at
 * an abandoned `b` and dispatch `c` against a mechanism the rollback took off the branch; leaving it
 * in the result would have the run skip-note a bead a human already closed.
 */
export function skippedDependents(
  timedOut: readonly TicketTimeoutOutcome[],
  tickets: Bead[],
  all: Bead[],
): Map<string, SkipCause> {
  const ids = new Set(tickets.map((t) => t.id));
  const adj = dependentEdges(tickets, all);
  const stoppedSet = new Set(
    timedOut.filter((t) => !t.committed && ids.has(t.id)).map((t) => t.id),
  );
  const cause = new Map<string, SkipCause>();
  const queue = [...stoppedSet];
  while (queue.length) {
    const id = queue.shift()!;
    const root = stoppedSet.has(id) ? id : cause.get(id)!.stopped;
    for (const dependent of adj.get(id) ?? []) {
      if (stoppedSet.has(dependent) || cause.has(dependent)) continue;
      cause.set(dependent, { waitingOn: id, stopped: root });
      queue.push(dependent);
    }
  }
  for (const t of tickets) if (beads.isAbandoned(t)) cause.delete(t.id);
  return cause;
}

/**
 * Why a skipped dependent did not run, for its own bead — the board has to say this, or the ticket
 * reads as work anton simply forgot. Names the ticket it waits on AND the stopped one at the head
 * of the chain, since for a transitive dependent those differ and only the second is actionable.
 */
export function skipNote(cause: SkipCause): string {
  const chain =
    cause.waitingOn === cause.stopped
      ? `${cause.stopped}, which ran out of time and had its work rolled back`
      : `${cause.waitingOn}, which was itself skipped behind ${cause.stopped} — that ticket ran ` +
        `out of time and had its work rolled back`;
  return (
    `anton: not dispatched — this ticket depends on ${chain}, so the work it builds on is not on ` +
    `the run's branch and an agent could not have finished it. Left open and unassigned; the run ` +
    `delivered the rest of the feature. Re-scope ${cause.stopped} (or raise ticketTimeoutMinutes), ` +
    `run it, then run this ticket.`
  );
}

/**
 * Topologically order tickets so a ticket runs after the tickets it depends on (`blocks` edges
 * among the epic's own members). Falls back to input order on a cycle.
 */
export function orderTickets(tickets: Bead[], all: Bead[]): Bead[] {
  const adj = dependentEdges(tickets, all);
  const indeg = new Map<string, number>(tickets.map((t) => [t.id, 0]));
  for (const dependents of adj.values()) {
    for (const d of dependents) indeg.set(d, (indeg.get(d) ?? 0) + 1);
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

/**
 * Whether a stopped ticket left changes behind in the shared worktree — the state that would ride
 * into the NEXT ticket's commit under the wrong name.
 *
 * Anything unreadable counts as left behind: a tree we cannot prove clean is exactly the one that
 * must not be waved through. With no baseline to compare against (its read failed), working-tree
 * dirt alone is the signal — that is what the commit step would pick up.
 */
async function leftChangesBehind(
  worktreePath: string,
  baseline: WorktreeState | null,
): Promise<boolean> {
  const now = await readWorktreeState(worktreePath).catch(() => null);
  if (!now) return true;
  return baseline ? !sameWorktreeState(now, baseline) : now.status !== "";
}

/**
 * Swallow errors from best-effort bd side effects (already-applied labels, etc.). Reports whether
 * the write actually landed, so a caller whose write carries content that exists nowhere else can
 * fall back instead of assuming it (see {@link reviewParkMessage}).
 */
async function safe(fn: () => Promise<unknown>): Promise<boolean> {
  try {
    await fn();
    return true;
  } catch {
    return false; // best-effort
  }
}

/** Backoff between {@link mustPersist} attempts — long enough to outlast a contended Dolt write. */
const PERSIST_RETRY_MS = 500;

/**
 * A bd write the run is NOT allowed to proceed without, retried before it is permitted to fail.
 * Answers whether it landed, so the caller escalates instead of carrying on as if it had.
 *
 * `safe` is right for a label whose absence a reader can survive. It is wrong for the
 * `not-delivered` marker (anton-67xj): that label is merge finalization's ONLY signal that a ticket
 * is in no diff, so swallowing its failure lets the run open a PR whose merge closes never-written
 * work as shipped — silently, and against the note on the bead telling the operator to re-run it.
 */
async function mustPersist(fn: () => Promise<unknown>, attempts = 3): Promise<boolean> {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    if (await safe(fn)) return true;
    if (attempt < attempts) await delayMs(PERSIST_RETRY_MS);
  }
  return false;
}

const delayMs = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    if (typeof t.unref === "function") t.unref();
  });
