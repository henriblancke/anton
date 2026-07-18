/**
 * execute-epic job (anton-dzh.4). For an approved epic: warm a worktree, then per ticket run
 * `claude` (with the ticket's agent prompt) → run tests → commit; when all tickets are done, open
 * ONE PR via `gh` and move the epic to in-review. Idempotent/resumable — a re-run (crash, quota
 * backoff) skips tickets already closed and reuses the existing worktree. See DESIGN.md §4/§7.
 */
import { randomUUID } from "node:crypto";
import { beads, LABELS, type Bead } from "../beads/bd";
import { computeEpicGraph, epicStandaloneBlockers, standaloneBlockers } from "../epic-graph";
import { loadAgentPrompt } from "../claude/agent-prompt";
import { buildExecutionSystemPrompt } from "../claude/system-prompt";
import { runClaude, type ClaudeEvent } from "../claude/driver";
import { commitAll, openPullRequest, resolveFreshBase } from "../git/ops";
import { createWorktree, removeWorktree } from "../git/worktree";
import { getProjectById, getProjectSettings, type ProjectSettings } from "../projects";
import { resolveOperator } from "../operator";
import {
  createRun,
  findOpenRunForEpic,
  updateRun,
} from "../runs";
import { appendSessionLog, createSession, endSession, sessionLogPath } from "../sessions";
import { buildPrTitle } from "./pr-title";
import { isUsageLimitError, isRunAlreadyLiveError, RunAlreadyLiveError } from "./errors";
import { runShell } from "./shell";
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
    const all = await beads.list(repo, ["--status", "all"]);
    const target = all.find((b) => b.id === epicBeadId);
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

    // Re-check the same readiness gate the approval route enforces, now at job start. Approval only
    // guarantees readiness at approval time; between then and this lease a `blocks` edge could have
    // been added or pulled in via Dolt sync (a shared board), leaving this job queued behind a
    // blocker that's no longer done. An epic's blockers come from the epic-graph rollup; a
    // standalone task/bug (epic-of-one) never appears there, so derive its blockers from its own
    // `blocks` edges. Either way, derive from the fresh `all` read above and PARK if a blocker is
    // open — starting still-blocked work would violate the sequence. Recoverable: once the
    // blocker completes, resuming the parked job re-reads beads and passes this gate.
    // An epic also inherits any open standalone (parentless task/bug) prerequisite that the
    // epic-graph rollup drops (epicStandaloneBlockers) — the same gap the approve route closes.
    const blockers = beads.isEpic(target)
      ? [
          ...(computeEpicGraph(all).epics.find((n) => n.id === epicBeadId)?.blockedBy ?? []),
          ...epicStandaloneBlockers(all, epicBeadId),
        ]
      : standaloneBlockers(all, epicBeadId);
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
    const tickets = standaloneRun ? [target] : childrenOf(all, epicBeadId);
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
    // fresh lease after settle; `leaseRefreshInFlight` tracks a tick already mid-publish so `finally`
    // can await it before clearing the label (otherwise a slow refresh write could re-publish an
    // unexpired lease after the clear and leave the epic looking live until TTL — anton-jz1).
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
      // the (agent-free) PR step left to do.
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
        // A failed refresh only logs (it must not crash the process from a detached timer), and
        // publishLease leaves `leaseExpiry` un-advanced on failure — so if these writes keep failing,
        // `assertLeaseHeld` at the next checkpoint parks the run before the shared lease lapses.
        leaseRefreshInFlight = publishLease().catch((e) =>
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

      // 3. Claim the epic for the human operator (idempotent). The immediate sync nudge makes
      // the claim visible on teammates' boards within a heartbeat — that's the whole point of
      // claiming (anton-live-sync R6); fire-and-forget, the end-of-run sync is the backstop.
      const operator = await resolveOperator();
      await safe(() => beads.claim(repo, epicBeadId, operator));
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
      for (const ticket of orderTickets(tickets, all)) {
        assertLeaseHeld(); // yield before starting a ticket if the shared lease has lapsed
        if (ticket.status === "closed") continue;
        if (standaloneRun && (ticket.labels?.includes(inReview) ?? false)) {
          // Resume after a failed PR step: this ticket already committed and moved to in-review on
          // a prior attempt. Step 2 above re-tagged the target stage:implementing (it can't tell a
          // fresh run from a resume), and runTicket — the only standalone path that clears
          // implementing — is being skipped here. Clear it now so the ticket doesn't carry BOTH
          // stage labels into merge-finalize, which strips only in-review and would otherwise leave
          // a stale implementing label (making a reopened bead derive as in-progress).
          await safe(() => beads.untag(repo, ticket.id, [LABELS.stage("implementing")]));
          continue;
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
        body: prBody(target, tickets),
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

  let committed = false;
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
    committed = true;

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
    // Release the claim so the board never shows a dead session's ticket as in-flight
    // (anton-live-sync R10). A usage-limit park is NOT dead — the run resumes with the claim
    // intact. When work already landed on the branch, flag for a human instead of silently
    // re-queueing a ticket whose commits exist. All best-effort: never mask the run's error;
    // the epic-level finally sync pushes the release to the remote.
    if (!isUsageLimitError(e)) {
      if (committed) {
        await safe(() => beads.setStatus(repo, ticket.id, "blocked"));
        await safe(() =>
          beads.note(repo, ticket.id, `anton: run failed after committing work — needs review`),
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
 * The concrete task (`-p`) for one ticket: identity + acceptance only. The operating contract
 * (git/beads ownership, scope, learnings, fail-loud) lives in the locked base system prompt
 * (composeSystemPrompt), so it isn't duplicated here.
 */
function ticketPrompt(ticket: Bead): string {
  const acceptance = ticket.acceptance_criteria ?? ticket.acceptance ?? "(see `bd show`)";
  return [
    `Implement this beads ticket in the current worktree:`,
    ``,
    `Ticket: ${ticket.id} — ${ticket.title}`,
    ``,
    `Acceptance criteria:`,
    acceptance,
    ``,
    `Run \`bd show ${ticket.id}\` for the full Goal / Context, then implement it to satisfy the`,
    `acceptance criteria. Follow the operating contract in your system prompt.`,
  ].join("\n");
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

/** Swallow errors from best-effort bd side effects (already-applied labels, etc.). */
async function safe(fn: () => Promise<unknown>): Promise<void> {
  try {
    await fn();
  } catch {
    // best-effort
  }
}
