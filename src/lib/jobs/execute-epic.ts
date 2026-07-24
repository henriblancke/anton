/**
 * execute-epic job (anton-dzh.4). For an approved epic: warm a worktree, then per ticket run
 * `claude` (with the ticket's agent prompt) → run tests → commit; when all tickets are done, open
 * ONE PR via `gh` and move the epic to in-review. Idempotent/resumable — a re-run (crash, quota
 * backoff) reuses the existing worktree and skips tickets already closed WHOSE COMMIT is on this
 * branch; a cross-machine resume re-runs a board-closed ticket whose commit never got pushed. See
 * DESIGN.md §4/§7.
 */
import { randomUUID } from "node:crypto";
import { beads, LABELS, type Bead } from "../beads/bd";
import { ownerOf } from "../beads/claim";
import { humanNotesPromptBlock } from "../beads/notes";
import { computeEpicGraph, epicStandaloneBlockers, standaloneBlockers } from "../epic-graph";
import { loadAgentPrompt } from "../claude/agent-prompt";
import { buildExecutionSystemPrompt } from "../claude/system-prompt";
import { runClaude, type ClaudeEvent, type ClaudeResult } from "../claude/driver";
import { formatAntonResult, parseAntonResult } from "../claude/anton-result";
import {
  commitAll,
  openPullRequest,
  pullRequestState,
  resolveFreshBase,
  worktreeHasCommitFor,
} from "../git/ops";
import { createWorktree, findWorktree, removeWorktree } from "../git/worktree";
import {
  getProjectById,
  getProjectSettings,
  resolveVerifyGates,
  type ProjectSettings,
} from "../projects";
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
import { buildPrTitle } from "./pr-title";
import {
  isRecoverableClaudeError,
  isUsageLimitError,
  isRunAlreadyLiveError,
  RunAlreadyLiveError,
} from "./errors";
import { runVerifyGates } from "./shell";
import type { AntonDb, Clock } from "./queue";
import { systemClock } from "./queue";
import type { JobContext, JobHandler } from "./runner";

export interface ExecuteEpicPayload {
  projectId: string;
  epicBeadId: string;
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

    // Load the run target + (for an epic) its tickets from beads (the source of truth). A target
    // is an epic OR a parentless task/bug run as an epic-of-one (isRunTarget). Distinguish the two
    // non-runnable cases so the poison message is honest: a bead that WAS found but isn't a valid
    // target must not read "not found" (that sends the operator hunting for a missing bead).
    let all = await beads.list(repo, ["--status", "all"]);
    let target = all.find((b) => b.id === epicBeadId);
    if (!target) throw new PoisonEpic(`bead ${epicBeadId} not found on the board`);
    if (!beads.isRunTarget(target)) {
      const parent = (target.parent ?? target.parent_id) as string | undefined;
      throw new PoisonEpic(
        `bead ${epicBeadId} is not runnable: type "${target.issue_type ?? "unknown"}"` +
          (parent ? ` with parent ${parent}` : "") +
          ` — only an epic or a parentless task/bug can be run`,
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

    // Compute the epic's open blockers from a board snapshot. An epic's blockers come from the
    // epic-graph rollup; a standalone task/bug (epic-of-one) never appears there, so derive its
    // blockers from its own `blocks` edges. An epic also inherits any open standalone (parentless
    // task/bug) prerequisite that the epic-graph rollup drops (epicStandaloneBlockers) — the same
    // gap the approve route closes. The epic-vs-standalone shape can't change across a pull, so
    // capture it here (while `target` is narrowed) and reuse it against the freshly-pulled board in
    // step 0 — `target` is a `let` reassigned there, so reading it inside this closure would widen
    // back to `Bead | undefined`.
    const targetIsEpic = beads.isEpic(target);
    const computeBlockers = (board: Bead[]): string[] =>
      targetIsEpic
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

    // An epic runs all its children into one PR; a standalone task/bug IS its own single ticket
    // (an epic-of-one). The rest of the pipeline — worktree, per-ticket claude→tests→commit→close,
    // one PR — is identical either way, so the standalone case is just a one-element ticket list.
    const standaloneRun = !beads.isEpic(target);
    let tickets = standaloneRun ? [target] : childrenOf(all, epicBeadId);
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
      // machine closed — then crashed before stamping `external_ref` — still shows OPEN in that stale
      // snapshot. The ticket loop (step 4) skips only tickets whose status is `closed`, so iterating
      // the stale list would re-run claude and re-commit work the just-pulled board already reflects as
      // done. Re-list here so those remotely-closed tickets are skipped. Best-effort like the pull: a
      // failed re-list keeps the pre-pull snapshot (no worse than before this refresh existed). The
      // epic/standalone shape can't change across a pull, so `standaloneRun` is derived once above.
      try {
        const fresh = await beads.list(repo, ["--status", "all"]);
        const freshTarget = fresh.find((b) => b.id === epicBeadId);
        if (freshTarget) {
          all = fresh;
          target = freshTarget;
          tickets = standaloneRun ? [target] : childrenOf(all, epicBeadId);
          // Adopt the fresh bead for the liveness gates too (anton-jz1). When the `show` above failed
          // but this list succeeds, `leaseTarget` still points at the stale pre-pull snapshot — yet the
          // completion short-circuit (step 0a, reads `external_ref`) and the foreign-lease gate below
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
      //     on a `gh "a pull request already exists"` failure. The external ref is set ONLY by a
      //     completed PR step (step 5, setExternalRef), but its mere PRESENCE is NOT proof another run
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
      if (leaseTarget.external_ref) {
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
        const prState = await pullRequestState(repo, leaseTarget.external_ref);
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
          // attempt resumes after a crash that landed the external ref (step 5, setExternalRef) but died
          // before `finally` cleared its run-lease, `leaseTarget` still carries an unexpired
          // `run-lease:…:<runId>` this run published. The general lease-adoption step (`leaseLabels =
          // runLeaseLabels(...)`) runs AFTER this return, so without adopting here `finally` would clear
          // nothing and other machines would keep seeing the epic as live until the TTL even though its
          // PR is already open. Adopt only OUR OWN lease (matched by runId) so `finally` clears it; a
          // foreign machine's lease is left for its own owner/TTL, honoring "finally clears only what we
          // own" (the same reason this gate precedes the general adoption below).
          leaseLabels = beads.ownRunLeaseLabels(leaseTarget, runId);
          // Restore the in-review board state before returning (anton-jz1). An epic run that crashed
          // AFTER setExternalRef (step 5) but before the stage updates at the tail of step 5 leaves the
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

      if (beads.foreignRunLeaseLive(leaseTarget, clock.now(), runId)) {
        throw new RunAlreadyLiveError(
          `${epicBeadId} is already running on another machine (unexpired run-lease) — parking; ` +
            `this attempt resumes once that run settles and clears its lease`,
        );
      }
      // No foreign live lease: adopt any leftover leases on the freshly-read target (this run's own
      // from a crashed prior attempt, or an expired dead one from any machine) so the first publish
      // atomically replaces them. Set here — after the gate — so the `finally` only ever clears
      // leases we own.
      leaseLabels = beads.runLeaseLabels(leaseTarget);

      // A standalone target that already committed on a prior attempt carries stage:in-review and
      // is skipped straight to the PR step below — its agent never runs again on this resume. Both
      // the allowlist gate here and the ticket loop share this "won't run" predicate so neither
      // acts on a resume marker: gating on a since-disabled agent would park a retry that only has
      // the (agent-free) PR step left to do. Caveat: "won't run" holds only when the ticket's commit
      // is actually on this branch. A done-on-board ticket whose commit is missing (cross-machine
      // resume) DOES re-run, so the loop re-applies this allowlist gate there — the worktree needed
      // to prove commit presence doesn't exist yet at this point.
      const inReview = LABELS.stage("in-review");
      const isResumeSkipped = (t: Bead) =>
        t.status === "closed" || (standaloneRun && (t.labels?.includes(inReview) ?? false));

      // 0b. Dispatch honors the active-agents allowlist (anton-dm7). PARK, don't skip: running
      // the ticket with the default agent would silently produce work the operator disabled the
      // specialist for, and skipping it would open the epic's single PR incomplete. Parking is
      // recoverable — the operator enables the agent (Settings → Agents) or relabels the ticket,
      // then resumes; tickets and settings are re-read on every attempt. Checked before any
      // claim/worktree/session work so a run never half-executes into a config problem.
      const inactive = inactiveAgentTickets(
        tickets.filter((t) => !isResumeSkipped(t)),
        settings.agents,
      );
      if (inactive.length > 0) {
        throw new PoisonEpic(
          `epic ${epicBeadId} needs agents disabled in this project's settings: ` +
            inactive.map((x) => `${x.id} → agent:${x.agent}`).join(", ") +
            ` — enable them in Settings → Agents (or relabel the tickets), then resume the run`,
        );
      }

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
          );
        }
        if (!beads.winsRunLeaseRace(acquired, clock.now(), runId)) {
          throw new RunAlreadyLiveError(
            `${epicBeadId} lost the run-lease race to a concurrent run on another machine — parking; ` +
              `this attempt resumes once that run settles and clears its lease`,
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
      // start a duplicate. So at each checkpoint below (every ticket boundary, and before the PR) we
      // re-check the expiry we last successfully PUSHED: once it's in the past we can no longer prove
      // we hold the shared lease, so we yield (RunAlreadyLiveError → park + retry, re-checking liveness
      // next attempt) rather than keep running unguarded. A single ticket that itself runs past the TTL
      // under sustained sync failure can't be interrupted mid-session, so this bounds — not eliminates
      // — the exposure to roughly one ticket's worth of work.
      const assertLeaseHeld = () => {
        if (clock.now() >= leaseExpiry) {
          throw new RunAlreadyLiveError(
            `${epicBeadId} run-lease expired mid-run (refresh writes to the shared board have been ` +
              `failing) — parking so another machine doesn't treat the epic as free and double-run ` +
              `it; this attempt resumes once the board is reachable`,
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
      const worktree = await createWorktree({
        repoPath: repo,
        branch,
        baseBranch: await resolveFreshBase(repo, baseBranch),
        warm: true,
      });
      await updateRun(db, clock, runId, {
        worktreePath: worktree.path,
        branch: worktree.branch,
        attempts: ctx.attempt,
      });
      await ctx.heartbeat();

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

      // 4. Per ticket: claude → tests → commit → (close | in-review). Skip work that already
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
        const doneOnBoard =
          ticket.status === "closed" ||
          (standaloneRun && (ticket.labels?.includes(inReview) ?? false));
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
          const disabled = inactiveAgentTickets([ticket], settings.agents);
          if (disabled.length > 0) {
            throw new PoisonEpic(
              `epic ${epicBeadId} needs agents disabled in this project's settings: ` +
                disabled.map((x) => `${x.id} → agent:${x.agent}`).join(", ") +
                ` — enable them in Settings → Agents (or relabel the tickets), then resume the run`,
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
          db,
          clock,
          ctx,
          projectId,
          repo,
          runId,
          worktreePath: worktree.path,
          ticket,
          settings,
          operator,
          closeOnDone: !standaloneRun,
        });
        await ctx.heartbeat();
      }

      // 5. All tickets done → open one PR, stamp the PR ref, and (for an epic) move it to
      //    in-review. A standalone target is NOT closed here: like an epic it stays OPEN, tagged
      //    stage:in-review (runTicket already applied that on commit), carrying its PR ref until
      //    the PR actually MERGES — at which point review-fix's merge-finalize path closes it.
      //    Closing it now would derive it as Done on the board while its PR is still open and drop
      //    it out of review-fix's in-review sweep (which is what keeps a standalone PR in the
      //    automated review/finalization path).
      assertLeaseHeld(); // don't open a PR under a lease that has silently lapsed
      const pr = await openPullRequest({
        repoPath: repo,
        branch: worktree.branch,
        base: baseBranch,
        title: buildPrTitle(target, epicBeadId, settings.conventionalCommits),
        // `live`, not `tickets`: an abandoned ticket contributed no commit, so listing it would
        // advertise work this PR doesn't contain (anton-6xj0).
        body: prBody(target, live),
      });
      await safe(() => beads.setExternalRef(repo, epicBeadId, pr.ref));
      if (!standaloneRun) {
        await safe(() => beads.tag(repo, epicBeadId, [inReview]));
        await safe(() => beads.untag(repo, epicBeadId, [LABELS.stage("implementing")]));
      }

      // 6. Finalize run + clean up the worktree (the branch/PR carry the work now).
      await updateRun(db, clock, runId, { status: "done", endedAt: clock.now(), error: null });
      await safe(() => removeWorktree(worktree));
    } catch (e) {
      // Quota or a run already live on another machine (anton-jz1) → park the run (the job
      // reschedules and re-checks liveness); anything else → the run failed (job retries/parks).
      if (isUsageLimitError(e)) {
        await updateRun(db, clock, runId, { status: "parked", error: "usage-limit" });
      } else if (isRunAlreadyLiveError(e)) {
        await updateRun(db, clock, runId, { status: "parked", error: "run-live-elsewhere" });
      } else {
        await updateRun(db, clock, runId, {
          status: "failed",
          error: e instanceof Error ? e.message : String(e),
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
  operator?: string;
  /** Close the bead in beads once its work is committed. False for a standalone (epic-of-one)
   * target, which is never closed by execute-epic: it stays open + stage:in-review + PR ref until
   * its PR merges (review-fix's merge-finalize path closes it). On commit, a false value instead
   * moves the bead to stage:in-review — the resume marker + board state. Defaults to true (an
   * epic's children close as their work lands). */
  closeOnDone?: boolean;
}): Promise<void> {
  const { db, clock, ctx, projectId, repo, runId, worktreePath, ticket, settings, operator } =
    args;
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
  // Compose the system prompt: locked base contract + agent-tag prompt + operator seed. The base
  // is mandatory (buildExecutionSystemPrompt throws if src/prompts/system-base.md is missing).
  const agentPrompt = await loadAgentPrompt(agentTag, { projectDir: worktreePath });
  const appendSystemPrompt = await buildExecutionSystemPrompt({
    agentPrompt,
    seedPrompt: settings.seedPrompt,
  });

  const { sessionId, logPath, onEvent } = await startJobSession(db, clock, {
    projectId,
    runId,
    kind: "execute",
    beadId: ticket.id,
  });
  await updateRun(db, clock, runId, { ticketBeadId: ticket.id, agentTag: agentTag ?? null });

  // Human steering (anton-bfy4) can land at any moment — including while this epic's earlier
  // tickets were running — so the notes that reach the prompt are read HERE, at dispatch, not from
  // the board snapshot the run started with. Best-effort: an unreadable bead just means no notes.
  const dispatched = await withDispatchNotes(repo, ticket);

  let committed = false;
  try {
    const result = await runClaudeResilient({
      db,
      ctx,
      sessionId,
      logPath,
      worktreePath,
      ticket: dispatched,
      appendSystemPrompt,
      model: settings.model,
      permissionMode: settings.permissionMode ?? "bypassPermissions",
      onEvent,
    });
    if (!result.ok) {
      throw new Error(`claude reported an error for ${ticket.id}: ${result.text ?? "unknown"}`);
    }

    // Parse the agent's machine-readable self-report (anton-j5i8): the last `ANTON-RESULT:` line
    // from its output — `delivered` or `blocked — <reason>`. Recorded on the session log here; it
    // CORROBORATES the delivery-evidence gate below, never replaces it. A missing/unparseable line
    // (selfReport === null) simply falls through to the commit-evidence gate — never a crash.
    const selfReport = parseAntonResult(result.text);
    await appendSessionLog(logPath, `[anton-result] ${formatAntonResult(selfReport)}\n`).catch(() => {});

    // Verify gates (optional — configured per project): tests + operator-pinned lint/typecheck/
    // build (anton-3oh8). Absent → no gates run. A non-zero exit fails the ticket before commit.
    await runVerifyGates(
      resolveVerifyGates(settings),
      worktreePath,
      ctx.signal,
      logPath,
      (gate, code) => `${gate.label} gate failed for ${ticket.id} (exit ${code})`,
    );

    // Commit whatever claude changed — and honor commitAll's { committed } verdict. A clean agent
    // exit that leaves NO diff delivered nothing: the exact false-success in issue #46 (root cause
    // #1). Do NOT close/advance the ticket on empty delivery. Throw a NoDeliveryError so the catch
    // below BLOCKS the ticket for a human (never re-queues it open) and the error propagates out of
    // the ticket loop, halting dispatch of the rest of the epic. NoDeliveryError is poison, so the
    // runner parks the run for a human instead of retrying claude to the same empty result forever.
    const { committed: didCommit } = await commitAll(worktreePath, `${ticket.id}: ${ticket.title}`);
    if (!didCommit) {
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
 * Run claude for one ticket with resilient in-session recovery (anton-juar). A transient mid-stream
 * death (network drop, truncated stream, exit-without-result) that captured a Claude session id is
 * retried with `claude --resume <id>` — continuing the same conversation instead of re-running the
 * whole ticket from scratch — bounded by MAX_RESUME_ATTEMPTS so a flapping connection can't burn the
 * job's retry budget. A resume that dies the SAME way escalates immediately to a fresh restart. When
 * no session id was captured, the failure is deterministic (non-recoverable), or the resume budget
 * is spent, the error propagates so the job-level runner does today's fresh spawn (then parks after
 * maxAttempts) — resume is best-effort and never a new failure mode.
 */
async function runClaudeResilient(args: {
  db: AntonDb;
  ctx: JobContext;
  sessionId: string;
  logPath: string;
  worktreePath: string;
  ticket: Bead;
  appendSystemPrompt: string;
  model?: string;
  permissionMode: "default" | "acceptEdits" | "bypassPermissions" | "plan";
  onEvent: (e: ClaudeEvent) => void;
}): Promise<ClaudeResult> {
  const { db, ctx, sessionId, logPath, worktreePath, ticket } = args;
  let resumeId: string | undefined;
  let priorError: string | undefined;
  let priorSignature: string | undefined;

  for (let attempt = 0; ; attempt++) {
    try {
      const result = await runClaude({
        cwd: worktreePath,
        prompt: resumeId ? continuationPrompt(ticket, priorError) : ticketPrompt(ticket),
        resumeSessionId: resumeId,
        appendSystemPrompt: args.appendSystemPrompt,
        model: args.model,
        permissionMode: args.permissionMode,
        signal: ctx.signal,
        onEvent: args.onEvent,
      });
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

/** A permanent, human-needed failure (never retried). */
class PoisonEpic extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = "PoisonError"; // classified as poison by the runner
  }
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

/** Fold the parsed self-report into a zero-diff block reason, when one was emitted (anton-j5i8). */
function selfReportSuffix(selfReport: ReturnType<typeof parseAntonResult>): string {
  if (!selfReport) return "";
  return selfReport.outcome === "delivered"
    ? ` The agent self-reported ANTON-RESULT: delivered — a false success on an unchanged tree.`
    : ` The agent self-reported ${formatAntonResult(selfReport)}, corroborating the block.`;
}

function childrenOf(all: Bead[], epicId: string): Bead[] {
  return all.filter((b) => ((b.parent ?? b.parent_id) as string | undefined) === epicId);
}

function labelValue(labels: string[] | undefined, prefix: string): string | undefined {
  const l = labels?.find((x) => x.startsWith(`${prefix}:`));
  return l ? l.slice(prefix.length + 1) : undefined;
}

/**
 * Tickets whose `agent:` label names a specialist agent the project has disabled (anton-dm7).
 * `activeAgents` is settings.agents. Semantics:
 *   • absent (never persisted / cleared) → all agents active (a project that never touched
 *     settings must not stall; the API persists a cleared value as `undefined`, never `[]`)
 *   • EMPTY allowlist `[]` → no agents active: every ticket with an `agent:` label is parked.
 *     The operator explicitly toggled every agent off, and the API persists `[]` as a real
 *     value distinct from clearing (settings/route.ts) — honoring it is the whole point.
 *   • no `agent:` label → runs with the default agent, never blocked
 *   • the allowlist gates ALL agents — bundled AND the operator's own `.claude/agents` (anton-dvo.1).
 *     Custom agents are discoverable and toggleable in Settings now, so a ticket needing a disabled
 *     custom agent is parked just like a bundled one, rather than silently running.
 */
export function inactiveAgentTickets(
  tickets: Bead[],
  activeAgents: string[] | undefined,
): { id: string; agent: string }[] {
  if (activeAgents == null) return [];
  const active = new Set(activeAgents);
  const out: { id: string; agent: string }[] = [];
  for (const t of tickets) {
    const agent = labelValue(t.labels, "agent");
    if (!agent) continue;
    if (!active.has(agent)) out.push({ id: t.id, agent });
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
 * Cap on each inlined ticket field. anton worktrees carry a frozen embedded Dolt with no remote,
 * so `bd show` inside the worktree can fail (issue #46 root cause #3) — the prompt must therefore
 * carry the spec itself and not be load-bearing on in-worktree DB access. A generous per-field
 * budget keeps a pathologically large body from bloating the prompt while still delivering the
 * whole spec for the common case.
 */
const MAX_TICKET_FIELD_CHARS = 4000;

function truncateField(text: string): string {
  const trimmed = text.trim();
  if (trimmed.length <= MAX_TICKET_FIELD_CHARS) return trimmed;
  return `${trimmed.slice(0, MAX_TICKET_FIELD_CHARS)}\n… [truncated — run \`bd show\` for the full text]`;
}

/**
 * The concrete task (`-p`) for one ticket. The operating contract (git/beads ownership, scope,
 * learnings, fail-loud) lives in the locked base system prompt (composeSystemPrompt), so it isn't
 * duplicated here.
 *
 * The ticket's full spec — Goal / Out of scope / Verify (the `description` markdown), Acceptance,
 * and Context — is inlined so the agent can implement even when the worktree's beads DB is
 * unreadable (issue #46 root cause #3). `bd show` is offered as a convenience, never as the sole
 * source: a bead whose spec is genuinely empty AND whose `bd show` fails is a fail-loud/blocked
 * condition, not a cue to silently produce nothing.
 *
 * Human notes on the bead (anton-bfy4) are appended last — the operator's steer is the freshest
 * intent, so it reads as a refinement of the contract above it.
 */
export function ticketPrompt(ticket: Bead): string {
  const description = ticket.description?.trim();
  const acceptance = (ticket.acceptance_criteria ?? ticket.acceptance)?.trim();
  // In some boards Context is a separate column; in others it's folded into `description` as a
  // `## Context` heading. Only inline the standalone field when it isn't already in `description`.
  const context =
    ticket.context?.trim() && ticket.context.trim() !== description
      ? ticket.context.trim()
      : undefined;

  const lines = [
    `Implement this beads ticket in the current worktree:`,
    ``,
    `Ticket: ${ticket.id} — ${ticket.title}`,
  ];
  if (description) {
    lines.push(``, `## Goal / Out of scope / Verify`, truncateField(description));
  }
  lines.push(``, `## Acceptance criteria`, acceptance ? truncateField(acceptance) : "(none stated)");
  if (context) {
    lines.push(``, `## Context`, truncateField(context));
  }
  // The human steering channel (anton-bfy4): notes an operator left on the bead between the gates.
  // They come last so the freshest human intent is what the agent reads before the closing rules.
  const humanNotes = humanNotesPromptBlock(ticket.notes);
  if (humanNotes) {
    lines.push(``, truncateField(humanNotes));
  }
  lines.push(
    ``,
    `The full ticket spec is inlined above so you can implement it even if the worktree's beads ` +
      `DB is unreadable. \`bd show ${ticket.id}\` gives the same content when bd is healthy. If ` +
      `the spec above is empty AND \`bd show\` fails, stop and report the ticket as blocked — do ` +
      `not guess or silently bail. Follow the operating contract in your system prompt.`,
  );
  return lines.join("\n");
}

function prBody(target: Bead, tickets: Bead[]): string {
  // Standalone run (epic-of-one): the single ticket IS the target, so listing it again is noise.
  const standalone = tickets.length === 1 && tickets[0]?.id === target.id;
  const lines = [
    `Autonomous run for **${target.id}** — ${target.title}.`,
    ``,
    ...(standalone ? [] : [`Tickets:`, ...tickets.map((t) => `- ${t.id} — ${t.title}`), ``]),
    `🤖 Generated with [anton](https://github.com/) autonomous execution`,
  ];
  return lines.join("\n");
}

/**
 * The ticket as it should be dispatched: the board-snapshot bead plus its CURRENT notes blob, read
 * fresh so an operator's steer written after the run started still reaches this ticket's prompt.
 * `bd show` failing (e.g. a locked DB) must never block the run — the snapshot bead is returned.
 */
async function withDispatchNotes(repo: string, ticket: Bead): Promise<Bead> {
  const fresh = await beads.show(repo, ticket.id).catch(() => null);
  return fresh?.notes ? { ...ticket, notes: fresh.notes } : ticket;
}

/** Swallow errors from best-effort bd side effects (already-applied labels, etc.). */
async function safe(fn: () => Promise<unknown>): Promise<void> {
  try {
    await fn();
  } catch {
    // best-effort
  }
}
