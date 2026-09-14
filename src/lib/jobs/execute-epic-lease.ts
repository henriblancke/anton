/**
 * The cross-machine run-liveness lease (anton-jz1 — extracted from execute-epic.ts in anton-1lix).
 *
 * One module owns the whole protocol — the publish that fails closed, the post-publish race
 * arbitration, the refresh chain, the cooperative expiry guard and the clear on settle — because
 * every one of those legs is decided on the same two facts ({@link LeaseState}), and a second writer
 * of either is how a stopped run leaves an epic looking live until its TTL runs out.
 */
import { beads, LABELS, type Bead } from "../beads/bd";
import { RunAlreadyLiveError } from "./errors";
import { safe } from "./execute-epic-persist";
import type { Clock } from "./queue";

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

/** The two facts every leg of the protocol is decided on, and the only mutable state here. */
interface LeaseState {
  readonly repo: string;
  readonly targetId: string;
  readonly runId: string;
  readonly clock: Clock;
  /**
   * The run-lease labels this run OWNS — its published lease plus any leftover leases it adopted to
   * sweep. Starts EMPTY so {@link RunLease.settle} never clears a lease this run never took
   * ownership of.
   */
  labels: string[];
  /**
   * Expiry (ms) of the last lease this run PUSHED to the shared remote — advanced only after the
   * push confirms, so it tracks remote-visible liveness, not just a local write. The cooperative
   * {@link RunLease.assertHeld} guard reads it to park the run before a lease whose refresh pushes
   * have been failing silently lapses past its TTL and another machine treats the epic as free.
   */
  expiry: number;
}

/**
 * Publish/refresh this run's lease. Advances `labels` ONLY after the write lands (not best-effort
 * like the other bd writes): a swallowed failure that still advanced the tracked label would let
 * `settle` clear a label that isn't on the board while the real prior lease lingers until TTL, and
 * would report a shared lease that was never written. So this throws on failure — the initial
 * publish fails closed (a run holding no shared lease could be double-run by another machine),
 * while the refresh timer catches + logs instead of crashing the process.
 */
async function publishLease(state: LeaseState): Promise<void> {
  const exp = state.clock.now() + RUN_LEASE_TTL_MS;
  await beads.publishRunLease(state.repo, state.targetId, exp, state.labels, state.runId);
  state.labels = [LABELS.runLease(exp, state.runId)];
  // Pushing the lease to the shared remote is REQUIRED, not a fire-and-forget nudge (anton-jz1):
  // the cross-machine guard only holds if OTHER machines' liveRunCheck can read this lease off the
  // Dolt remote, so a lease that lands locally but never pushes is invisible to them and lets them
  // double-run the epic. Await the push and let it throw on failure — the caller decides what a
  // failed publish means: the initial publish fails the run closed; a refresh tick logs and, because
  // `expiry` is advanced only AFTER the push confirms below, leaves it un-bumped so `assertHeld`
  // parks the run before the stale lease lapses. `beads.sync` tolerates a no-remote workspace
  // (resolves without pushing), so a single-machine run advances normally.
  await beads.sync(state.repo);
  state.expiry = exp;
}

/**
 * Read-after-write conflict check (anton-jz1). The foreign-lease gate in step 0 read the board
 * BEFORE the publish, so it can't serialize two machines that force-run the same epic at the same
 * instant: both clear the gate before either lease is visible remotely, then both publish. Our lease
 * was already pushed to the remote by the required publish; now re-pull so a concurrently-published
 * foreign lease becomes visible, then re-read and arbitrate: winsRunLeaseRace keeps the lease for
 * the lexicographically-lowest owner runId, so of two runs that both published, exactly one proceeds
 * and the other parks (RunAlreadyLiveError → reschedules, re-checks once the winner settles).
 *
 * The pull is REQUIRED, not best-effort: a swallowed pull failure would arbitrate against a stale
 * local view that can't see the other machine's lease, so both could conclude they won — the exact
 * double-run this step exists to break. If the pull fails we can't prove we won, so we fail closed
 * (park + retry) rather than proceed. Throwing here (before the refresh timer is armed) means the
 * caller's `finally` tears down only the lease this run published.
 */
async function arbitrateLease(state: LeaseState, preCheckTrusted: boolean): Promise<void> {
  const { repo, targetId, runId, clock } = state;
  try {
    await beads.pull(repo);
  } catch (e) {
    throw new RunAlreadyLiveError(
      `${targetId} could not refresh the shared board to arbitrate the run-lease race (${
        e instanceof Error ? e.message : String(e)
      }) — parking so a concurrent run on another machine isn't ignored; this attempt resumes ` +
        `once the board is reachable`,
    );
  }
  const acquired = await beads.show(repo, targetId).catch(() => null);
  // Fail closed when this re-read fails (anton-jz1). It's the ONLY check confirming no concurrent
  // lease won the race; a null here (DB lock, transient CLI error, malformed output) means we can't
  // prove we won, so park + retry like the pull failure above rather than fall through and proceed
  // while another machine may hold a live lease.
  if (!acquired) {
    throw new RunAlreadyLiveError(
      `${targetId} could not re-read the target to arbitrate the run-lease race — parking so a ` +
        `concurrent run on another machine isn't ignored; this attempt resumes once the board is reachable`,
    );
  }
  // If the step-0 pre-check was stale, an already-live incumbent lease could have been invisible
  // then and only surfaces now. That incumbent won't re-arbitrate, so winsRunLeaseRace's
  // lowest-owner-wins tiebreak would let us steal the lease and double-run. Park on ANY foreign live
  // lease instead of arbitrating by owner order (anton-jz1). A trusted (fresh) pre-check guarantees
  // no incumbent existed, so a foreign lease seen now is a symmetric racer and IS safely arbitrable.
  if (!preCheckTrusted && beads.foreignRunLeaseLive(acquired, clock.now(), runId)) {
    throw new RunAlreadyLiveError(
      `${targetId} found a live run-lease from another machine after a stale pre-check — parking ` +
        `rather than stealing by owner order (that run started earlier and won't yield); this ` +
        `attempt resumes once it settles and clears its lease`,
      "foreign",
    );
  }
  if (!beads.winsRunLeaseRace(acquired, clock.now(), runId)) {
    throw new RunAlreadyLiveError(
      `${targetId} lost the run-lease race to a concurrent run on another machine — parking; ` +
        `this attempt resumes once that run settles and clears its lease`,
      "foreign",
    );
  }
}

/** The run's hold on its target, from the first adoption to the clear on settle. */
export interface RunLease {
  /**
   * Park when ANOTHER machine's lease is live on `target` (anton-jz1). Called before anything is
   * adopted, so a park leaves the incumbent's lease exactly as it found it.
   */
  refuseForeign(target: Bead): void;
  /**
   * Take over the leftover leases on `target` — this run's own from a crashed prior attempt, or an
   * expired dead one from any machine — so the first publish atomically replaces them. Called only
   * after {@link refuseForeign}, so `settle` never clears a lease this run doesn't own.
   */
  adopt(target: Bead): void;
  /**
   * Take over ONLY this run's own leftover lease. The idempotent short-circuit (step 0a) returns
   * before the general adoption, so an attempt that crashed after stamping the PR ref still clears
   * the lease it published — while a foreign machine's is left for its own owner/TTL.
   */
  adoptOwn(target: Bead): void;
  /**
   * Publish the lease and win the post-publish race, or PARK. Fails closed on every leg: a run whose
   * lease no other machine can see, or that cannot prove it won, must not proceed.
   *
   * `preCheckTrusted` is false when the caller's pre-check ran on a stale board — see
   * {@link arbitrate} for why that forbids arbitrating by owner order.
   */
  claim(preCheckTrusted: boolean): Promise<void>;
  /** Arm the refresh timer. Separate from {@link claim} so nothing ticks until the run commits. */
  startRefresh(): void;
  /**
   * Yield the run when the lease we last PUSHED has lapsed — the cooperative guard every checkpoint
   * calls (each ticket boundary, each review dispatch, before the PR).
   */
  assertHeld(): void;
  /** Stop refreshing and drop the lease. Best-effort, like the other bd writes on the settle path. */
  settle(): Promise<void>;
}

export function makeRunLease(args: {
  repo: string;
  targetId: string;
  runId: string;
  clock: Clock;
}): RunLease {
  const { repo, targetId, runId, clock } = args;
  const state: LeaseState = { repo, targetId, runId, clock, labels: [], expiry: 0 };
  let timer: ReturnType<typeof setInterval> | null = null;
  // Set true by `settle` so a refresh tick that hasn't started yet no-ops instead of publishing a
  // fresh lease after settle; `refreshInFlight` tracks the tail of the serialized refresh chain (each
  // tick chains onto it rather than overwriting — see {@link startLeaseRefresh}) so `settle` can
  // await every queued/in-flight refresh before clearing the label (otherwise a slow refresh write
  // could re-publish an unexpired lease after the clear and leave the epic looking live until TTL).
  let settled = false;
  let refreshInFlight: Promise<void> = Promise.resolve();

  return {
    refuseForeign(target) {
      if (beads.foreignRunLeaseLive(target, clock.now(), runId)) {
        throw new RunAlreadyLiveError(
          `${targetId} is already running on another machine (unexpired run-lease) — parking; ` +
            `this attempt resumes once that run settles and clears its lease`,
          "foreign",
        );
      }
    },

    adopt(target) {
      state.labels = beads.runLeaseLabels(target);
    },

    adoptOwn(target) {
      state.labels = beads.ownRunLeaseLabels(target, runId);
    },

    async claim(preCheckTrusted) {
      await publishOrPark(state);
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
      await arbitrateLease(state, preCheckTrusted);
      await clock.sleep?.(RUN_LEASE_SETTLE_MS);
      await arbitrateLease(state, preCheckTrusted);
    },

    startRefresh() {
      timer = setInterval(() => {
        if (settled) return; // run is settling — don't publish a fresh lease behind the clear
        // Serialize refreshes by CHAINING onto the in-flight promise rather than overwriting it
        // (anton-jz1). If a publish runs longer than RUN_LEASE_REFRESH_MS (a `bd sync` queued behind
        // another sync, a remote stall), the next tick would otherwise start a second publish
        // concurrently AND replace the only promise `settle` awaits — the first, still-running
        // refresh could then land an unexpired lease AFTER the label was cleared, leaving a
        // done/failed/parked run looking live until TTL. Chaining guarantees at most one publish is
        // in flight, and `refreshInFlight` always tracks the tail of the chain so `settle` awaits
        // every queued refresh. Re-check `settled` after the prior link resolves so a refresh queued
        // before settle no-ops instead of re-publishing behind the clear. A failed refresh only logs
        // (it must not crash the process from a detached timer), and `publishLease` leaves
        // `state.expiry` un-advanced on failure — so if these writes keep failing, `assertHeld` at
        // the next checkpoint parks the run before the shared lease lapses.
        refreshInFlight = refreshInFlight
          .catch(() => {}) // prior failure already logged below; keep the chain alive
          .then(() => {
            if (settled) return; // settled while the prior refresh was in flight — don't republish
            return publishLease(state);
          })
          .catch((e) => console.error(`[execute-epic] run-lease refresh failed for ${targetId}`, e));
      }, RUN_LEASE_REFRESH_MS);
      if (typeof timer.unref === "function") timer.unref();
    },

    assertHeld() {
      // Cooperative lease-liveness guard (anton-jz1). The refresh timer only LOGS a failed publish;
      // if writes to the shared board keep failing, the lease silently lapses past its TTL while this
      // run is still executing, and another machine's liveRunCheck would then see the epic as free and
      // start a duplicate. So at each checkpoint (every ticket boundary, every review-gate review/fix
      // dispatch — the gate is handed this guard — and before the PR) we re-check the expiry we last
      // successfully PUSHED: once it's in the past we can no longer prove we hold the shared lease, so
      // we yield (RunAlreadyLiveError → park + retry, re-checking liveness next attempt) rather than
      // keep running unguarded. A single ticket that itself runs past the TTL under sustained sync
      // failure can't be interrupted mid-session, so this bounds — not eliminates — the exposure to
      // roughly one ticket's worth of work.
      if (clock.now() >= state.expiry) {
        // `unproven`, not `foreign`: this is OUR lease lapsing, and nothing here read another
        // machine's. Callers that would hand the branch over to a foreign owner (the review gate's
        // orphan-PR reconcile) must not do so on this.
        throw new RunAlreadyLiveError(
          `${targetId} run-lease expired mid-run (refresh writes to the shared board have been ` +
            `failing) — parking so another machine doesn't treat the epic as free and double-run ` +
            `it; this attempt resumes once the board is reachable`,
          "unproven",
        );
      }
    },

    async settle() {
      // Stop refreshing and drop the run-liveness lease now that this attempt has stopped executing
      // (anton-jz1). Clearing on EVERY settle path — done, parked, failed — is what lets a Force run
      // re-trigger a stopped run immediately instead of waiting out the lease TTL; a hard crash that
      // skips this still self-heals when the (un-refreshed) lease expires. Best-effort like the
      // other bd writes; the caller's sync pushes the removal to the remote.
      settled = true;
      if (timer) clearInterval(timer);
      // clearInterval only stops FUTURE ticks; a refresh already inside a publish when we settle
      // would otherwise write a fresh lease after the clear below. Await it first so `state.labels`
      // reflects what it actually wrote and the clear removes the right (freshest) label (anton-jz1).
      await refreshInFlight;
      await safe(() => beads.clearRunLease(repo, targetId, state.labels));
    },
  };
}

/**
 * The initial publish, which fails closed as a PARK rather than a hard failure (anton-jz1).
 *
 * A transient board outage (Dolt remote/CLI unavailable) at run start leaves us unable to prove we
 * hold the shared lease — the same "can't prove liveness" condition the arbitration and
 * {@link RunLease.assertHeld} already treat as a RunAlreadyLiveError (park + retry, refunding the
 * attempt and cooling off until the board is reachable). Marking it `failed` instead would burn retry
 * attempts on a temporary outage and eventually strand an approved job for a human. Not proceeding is
 * what matters here; parking doesn't proceed any more than failing does, and it recovers on its own.
 */
async function publishOrPark(state: LeaseState): Promise<void> {
  try {
    await publishLease(state);
  } catch (e) {
    throw new RunAlreadyLiveError(
      `${state.targetId} could not publish its run-lease to the shared board (${
        e instanceof Error ? e.message : String(e)
      }) — parking rather than proceeding without a lease other machines can see; this attempt ` +
        `resumes once the board is reachable`,
    );
  }
}
