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
import { beads, LABELS, type Bead } from "../beads/bd";
import { ownerOf } from "../beads/claim";
import { contractGaps, formatContractGaps } from "../beads/contract";
import { computeEpicGraph, epicStandaloneBlockers, isUnit, standaloneBlockers } from "../epic-graph";
import { contractGatedBeads, resumeSkipped, runTickets } from "../ticket-view";
import { runClaude, type ClaudeResult, type RunClaudeOptions } from "../claude/driver";
import { formatAntonResult, type AntonResult } from "../claude/anton-result";
import {
  lookupOpenPullRequest,
  markPullRequestDraft,
  pullRequestState,
  resolveFreshBase,
  worktreeHasCommitFor,
  type PullRequest,
} from "../git/ops";
import { createWorktree, findWorktree, removeWorktree } from "../git/worktree";
import { bundledAgentIds, discoverAgents } from "../agents-discovery";
import { getProjectById, getProjectSettings, resolveReviewConfig } from "../projects";
import { resolveOperator } from "../operator";
import {
  createRun,
  findOpenRunForEpic,
  updateRun,
} from "../runs";
import {
  appendSessionLog,
  endSession,
  setSessionClaudeId,
  startJobSession,
} from "../sessions";
import { findingLines, type ReviewFinding } from "./review-context";
import {
  blockingFindings,
  finalViolation,
  type ReviewGateResult,
  type ReviewRound,
} from "./review-gate";
import { persistPartialReviewScores, persistReviewScores } from "./review-score";
import {
  isPoisonError,
  isRecoverableClaudeError,
  isUsageLimitError,
  isRunAlreadyLiveError,
  PoisonEpic,
  RunAlreadyLiveError,
} from "./errors";
import { assertRunFormulaFloor } from "./formula-floor";
import { validateRunFormula, type ResolvedStep } from "./run-formula";
import { truncateField, type StepContext } from "./step-registry";
import type { AntonDb, Clock } from "./queue";
import { systemClock } from "./queue";
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
    let all = await beads.list(repo, ["--status", "all"]);
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

    // Compute the target's open blockers from a board snapshot. A GRAPH UNIT — every feature and
    // every epic (epic-graph's isUnit) — takes its blockers from the epic-graph rollup, which is
    // where cross-unit edges inferred from ticket-level `blocks` land; keying on isEpic alone would
    // send a feature down the standalone path and miss every inferred blocker the approve route
    // gates on. A standalone task/bug (epic-of-one) never appears in the rollup, so derive its
    // blockers from its own `blocks` edges. A unit also inherits any open standalone (parentless
    // task/bug) prerequisite that the rollup drops (epicStandaloneBlockers) — the same gap the
    // approve route closes. Unit-ness is type-only (isUnit reads `issue_type`), so unlike the
    // grouping shape it genuinely can't change across a pull — capture it here, while `target` is
    // narrowed, and reuse it against the freshly-pulled board in step 0; `target` is a `let`
    // reassigned there, so reading it inside this closure would widen back to `Bead | undefined`.
    const targetIsUnit = isUnit(target);
    const computeBlockers = (board: Bead[]): string[] =>
      targetIsUnit
        ? [
            ...(computeEpicGraph(board).epics.find((n) => n.id === epicBeadId)?.blockedBy ?? []),
            ...epicStandaloneBlockers(board, epicBeadId),
          ]
        : standaloneBlockers(board, epicBeadId);

    // Re-check the same readiness gate the approval route enforces, now at job start. Approval only
    // guarantees readiness at approval time; between then and this lease a `blocks` edge could have
    // been added or pulled in via Dolt sync (a shared board), leaving this job queued behind a
    // blocker that's no longer done. Derive from the fresh `all` read above and PARK if a blocker is
    // open — starting still-blocked work would violate the sequence. Recoverable: once the blocker
    // completes, resuming the parked job re-reads beads and passes this gate. Re-checked again in
    // step 0 after the cross-machine pull refreshes `all` (a blocker another machine pushed since
    // would be invisible to this pre-pull snapshot).
    const blockers = computeBlockers(all);
    if (blockers.length > 0) {
      throw new PoisonEpic(
        `${epicBeadId} is blocked by ${blockers.join(", ")} — refusing to execute; ` +
          `resume the run once the blocker(s) complete`,
      );
    }

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
        branch,
        model: settings.model,
        status: "running",
      });
    } else {
      await updateRun(db, clock, runId, { status: "running", error: null });
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
        const fresh = await beads.list(repo, ["--status", "all"]);
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
          // Clean up any worktree a prior attempt left behind before short-circuiting (anton-jz1). A
          // resume that crashed AFTER the worktree-warm step (step 2 stamps `worktreePath` on the run
          // row) leaves the git worktree registered/on disk; this idempotent return skips the normal
          // `removeWorktree` finalization (step 6), so without this the run is marked done yet its
          // worktree lingers. Locate it by branch and remove it best-effort — a no-op when this resume
          // never created one.
          await safe(async () => {
            const staleWorktree = await findWorktree(repo, branch);
            if (staleWorktree) await removeWorktree(staleWorktree);
          });
          await updateRun(db, clock, runId, { status: "done", endedAt: clock.now(), error: null });
          return;
        }
        // Closed-without-merging ref → stale. Fall through to recover the epic: the foreign-lease gate
        // and general lease adoption below run as usual (nothing adopted here so `finally` owns only what
        // the recovery path takes), the closed tickets are skipped, and step 5 re-opens the PR.
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
      const freshBlockers = computeBlockers(all);
      if (freshBlockers.length > 0) {
        throw new PoisonEpic(
          `${epicBeadId} is blocked by ${freshBlockers.join(", ")} — refusing to execute; ` +
            `resume the run once the blocker(s) complete`,
        );
      }

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
      const formula = await validateRunFormula(repo, {
        labels: target.labels,
        variants: settings.formulaVariants,
      });
      assertRunFormulaFloor(formula);
      await updateRun(db, clock, runId, {
        formula: formula.source,
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
      const worktree = await createWorktree({
        repoPath: repo,
        branch,
        baseBranch: freshBase,
        warm: true,
      });
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
          // A claim failure has two very different causes and only one warrants poisoning. Re-read the
          // owner to tell them apart: if a DIFFERENT operator now holds the epic, this is a confirmed
          // take-over — retrying is pointless, so poison (human must re-approve as the current owner).
          // But `bd update --claim` also throws on transient failures (a Dolt lock, a CLI timeout) with
          // NO ownership change; poisoning those would park a valid approved epic that a retry would
          // claim cleanly. Treat that class as a normal retryable error — the same call runTicket's
          // hard gate makes — so the runner retries instead of parking. A racing steal is still caught:
          // either this re-read sees it, or the pre-read gate above does on the next attempt. If the
          // re-read ITSELF fails we can't confirm a take-over, so fall through to the retryable path.
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
      void beads
        .sync(repo)
        .catch((e) => console.error(`[execute-epic] claim sync failed for ${epicBeadId}`, e));

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
      for (const ticket of live) {
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
        await runTicket({
          run: runStep,
          steps: ticketSteps,
          ticket,
          operator,
          closeOnDone: !standaloneRun,
        });
        await ctx.heartbeat();
      }

      // 4b. The RUN phase of the walk (anton-lnkt): every formula step after the commit, in the
      //     order the project's formula puts them, dispatched through the same registry the ticket
      //     phase uses. These steps speak for the run as a whole — they read its whole diff and open
      //     its single PR — so each runs ONCE, and one at a time: they share a worktree and a PR, so
      //     a formula whose steps could overlap is still not a licence to fan out.
      //     `live`, not `tickets`: an abandoned ticket contributed no commit, so listing it would
      //     advertise work this run doesn't contain (anton-6xj0).
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
          tickets: live,
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
            await persistPartialReviewScores(repo, epicBeadId, gateRounds);
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
            const orphan =
              isRunAlreadyLiveError(e) && e.conflict === "foreign"
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
          await persistReviewScores(repo, epicBeadId, review);

          const blocking = blockingFindings(review.unresolved);
          // Two states must not become a PR: blocking findings the converge loop couldn't clear, and a
          // reviewer that broke the report protocol (silence — or a review that edited the code it was
          // judging — is not a clean review). Both park for the founder like a no-delivery ticket does,
          // with the reason on the bead so the board shows why rather than only the run log.
          if (blocking.length > 0 || review.outcome === "protocol-violation") {
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
          if (!standaloneRun) {
            await safe(() => beads.tag(repo, epicBeadId, [LABELS.stage("in-review")]));
            await safe(() => beads.untag(repo, epicBeadId, [LABELS.stage("implementing")]));
          }
          continue;
        }

        // Anything else the project put after its commit — a `step:verify` it moved there, or a
        // `step:claude` of its own. A step that RAN and did not achieve its work stops the run: the
        // registry leaves that judgement to the caller, and carrying on would report a delivery on
        // a pipeline that didn't finish.
        const result = await definition.handler(stepCtx);
        if (!result.ok) {
          throw new Error(
            result.detail ??
              `formula step "${cooked.id}" (step:${definition.name}) failed for ${epicBeadId}`,
          );
        }
      }

      // 5. Finalize run + clean up the worktree (the branch/PR carry the work now). The run IS done —
      //    the branch and its PR carry the work — so a stale-body salvage rides along as the row's
      //    error rather than failing a delivery that landed.
      await updateRun(db, clock, runId, {
        status: "done",
        endedAt: clock.now(),
        error: staleBodyFallback,
      });
      await safe(() => removeWorktree(worktree));
    } catch (e) {
      // Quota, a run already live on another machine (anton-jz1), or a self-review that refused the
      // PR → park the run (the job reschedules, re-checks liveness, or waits for the founder);
      // anything else → the run failed (job retries/parks).
      if (isUsageLimitError(e)) {
        await updateRun(db, clock, runId, { status: "parked", error: `usage-limit${orphanNotice}` });
      } else if (isRunAlreadyLiveError(e)) {
        // The notice rides along here too: a lease that merely lapsed still reconciles the branch's
        // orphan PR, and what that found (a PR drafted, or a `gh` lookup that failed) has nowhere
        // else to be reported — this run opens no PR and composes no park message.
        await updateRun(db, clock, runId, {
          status: "parked",
          error: `run-live-elsewhere${orphanNotice}`,
        });
      } else if (e instanceof ReviewBlockedError) {
        // Parked, not failed, and with no endedAt: the run is waiting on a human to resolve what the
        // gate refused on and resume it — the run history must not read like a crash. Resuming reuses
        // THIS row (findOpenRunForEpic), so the resumed attempt continues in the same worktree/branch.
        await updateRun(db, clock, runId, { status: "parked", error: e.message });
      } else {
        await updateRun(db, clock, runId, {
          status: "failed",
          error: `${e instanceof Error ? e.message : String(e)}${orphanNotice}`,
          endedAt: clock.now(),
        });
      }
      throw e; // let the runner apply job-level durability
    } finally {
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
    }
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
}): Promise<void> {
  const { run, ticket, operator } = args;
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
  void beads
    .sync(repo)
    .catch((e) => console.error(`[execute-epic] claim sync failed for ${ticket.id}`, e));

  const agentTag = labelValue(ticket.labels, "agent");
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

  // This ticket's step context: the run's, narrowed to this ticket. The session is opened HERE and
  // handed in, so one session still covers the whole ticket — dispatch, gates and commit — exactly
  // as before.
  const ticketCtx: StepContext = {
    ...run,
    tickets: [ticket],
    session,
    // In-session resume for a transient mid-stream death (anton-juar) — the dispatch machinery the
    // step inherits from the run rather than a second driver of its own.
    deps: { runClaude: resilientClaude({ db, ctx, sessionId, logPath, ticket }) },
  };

  let committed = false;
  try {
    // The ticket phase of the walk (anton-lnkt): the formula's steps up to and including its commit,
    // in formula order, each dispatched through the registry against THIS ticket. The walk replaces
    // the order these ran in, never the guards around them — the delivery-evidence gate below is
    // still what decides whether the ticket is done.
    // The agent's machine-readable self-report (anton-j5i8) — `delivered` or `blocked — <reason>`,
    // already recorded on the session log by the dispatching step. It CORROBORATES the
    // delivery-evidence gate below, never replaces it; a missing/unparseable line (null) simply
    // falls through to it.
    let selfReport: AntonResult | null = null;
    for (const { step: cooked, definition } of args.steps) {
      // Every step boundary is a lease checkpoint, exactly as every ticket boundary is.
      run.assertLeaseHeld?.();
      const result = await definition.handler({ ...ticketCtx, step: cooked });
      selfReport = result.facts?.selfReport ?? selfReport;

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
      if (!result.facts?.committed) {
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
      committed = true;

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
    if (noDelivery) {
      await appendSessionLog(logPath, `[no-delivery] ${e.message}\n`).catch(() => {});
    } else if (agentBlocked) {
      await appendSessionLog(logPath, `[agent-blocked] ${e.message}\n`).catch(() => {});
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
      throw e;
    }
    // Release the claim so the board never shows a dead session's ticket as in-flight
    // (anton-live-sync R10). A usage-limit park is NOT dead — the run resumes with the claim
    // intact. Two states must NOT silently re-queue the ticket open: work already landed on the
    // branch (commits exist), OR the agent delivered nothing at all (zero diff). Both are
    // human-review states — block with an operator-facing note. Resetting a no-delivery ticket to
    // open would silently re-queue it into the ready pool and hide the false-success. All
    // best-effort: never mask the run's error; the epic-level finally sync pushes the release.
    if (!isUsageLimitError(e)) {
      if (committed || noDelivery || agentBlocked) {
        await safe(() => beads.setStatus(repo, ticket.id, "blocked"));
        await safe(() =>
          beads.note(
            repo,
            ticket.id,
            noDelivery
              ? `anton: run made no changes (clean agent exit, zero diff) — nothing was delivered; ` +
                  `needs a human to implement it or fix the ticket, then resume the run`
              : agentBlocked
                ? `anton: the agent self-reported ANTON-RESULT: blocked and committed only partial ` +
                    `work — it declared the ticket incomplete; needs a human to finish or re-scope it, ` +
                    `then resume the run`
                : `anton: run failed after committing work — needs review`,
          ),
        );
      } else {
        await safe(() => beads.setStatus(repo, ticket.id, "open"));
      }
      await safe(() => beads.unassign(repo, ticket.id));
      await safe(() => beads.untag(repo, ticket.id, [LABELS.stage("implementing")]));
    }
    throw e;
  }
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
  /** The ticket being implemented, for the continuation prompt a resumed session gets. */
  ticket: Bead;
}): (options: RunClaudeOptions) => Promise<ClaudeResult> {
  const { db, ctx, sessionId, logPath, ticket } = args;
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
                // The full ticket spec already lives in the resumed conversation, so the prompt is
                // a brief continuation rather than the whole spec again.
                prompt: continuationPrompt(ticket, priorError),
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
 * Brief continuation prompt for a resumed session (anton-juar). The full ticket spec already lives in
 * the resumed conversation, so this only nudges the agent to pick up where it left off. The captured
 * error is injected ONLY when it may have been caused by the agent's own output (e.g. an oversized
 * tool result that tripped a limit) — never for pure infra noise the agent can't act on, which would
 * only distract it.
 */
export function continuationPrompt(ticket: Bead, priorError?: string): string {
  const lines = [
    `Your previous session for ${ticket.id} was interrupted mid-stream by a transient failure and ` +
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
 */
function reviewParkNote(
  review: ReviewGateResult,
  blocking: ReviewFinding[],
  advisory: ReviewFinding[],
  orphan?: OrphanPullRequest,
): string {
  const rounds = review.rounds.length;
  const head =
    blocking.length > 0
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
    // named the one thing to fix.
    blocking.length > 0
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

/** Fold the parsed self-report into a zero-diff block reason, when one was emitted (anton-j5i8). */
function selfReportSuffix(selfReport: AntonResult | null): string {
  if (!selfReport) return "";
  return selfReport.outcome === "delivered"
    ? ` The agent self-reported ANTON-RESULT: delivered — a false success on an unchanged tree.`
    : ` The agent self-reported ${formatAntonResult(selfReport)}, corroborating the block.`;
}

function labelValue(labels: string[] | undefined, prefix: string): string | undefined {
  const l = labels?.find((x) => x.startsWith(`${prefix}:`));
  return l ? l.slice(prefix.length + 1) : undefined;
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
    const agent = labelValue(t.labels, "agent");
    if (!agent) continue;
    if (active.has(agent)) continue;
    if (userAgents?.has(agent)) continue; // the project's own agent — never gated by the allowlist
    out.push({ id: t.id, agent });
  }
  return out;
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
