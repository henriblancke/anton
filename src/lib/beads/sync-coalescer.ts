/**
 * The Dolt sync coalescer: every beads write nudge, every heartbeat backstop and the durable
 * sync-push job funnel through the one per-repo pass this module schedules, so two `bd dolt push`
 * runs can never overlap on a repo (beads GH#2466). It owns ALL per-repo sync state — the pass in
 * flight, the single trailing pass a burst coalesces into, whether this process has reconciled the
 * repo against its remote, and the operator-visible status registry the board reads.
 *
 * The seam: bd.ts owns talking to bd (including {@link runDoltSync}, which executes one pass);
 * this module decides WHEN a pass runs and under which mode; sync-engine.ts schedules the
 * heartbeat that asks for one.
 */
import { runDoltSync, type BdExec } from "./bd";
import { invalidateIssueSnapshot, issueSnapshotRefreshInFlight } from "./snapshot";

// ── Sync status registry (anton-live-sync) ──
//
// Keyed on globalThis via Symbol.for: the instrumentation-started sync engine and Next.js API
// route handlers can load DIFFERENT compiled instances of this module (separate bundles), so a
// plain module-level Map would leave routes reading an empty registry forever.

export type SyncState =
  | "unknown"
  | "not-wired"
  | "syncing"
  | "stalled"
  | "synced"
  | "failing"
  /** Server mode: propagation is inherent, so there is no sync to run or report (anton-0tul). */
  | "shared-server";

export interface SyncStatus {
  state: SyncState;
  /** ms epoch of the last successful pass (pull OR push); survives later failures for "last synced Xs ago". */
  lastSyncedAt: number | null;
  /** ms epoch of the last successful PUSH. Distinct from lastSyncedAt: a pull-only pass moves
   * lastSyncedAt but NOT this, so "unpushed for a while" is visible even while pulls keep succeeding. */
  lastPushedAt: number | null;
  /** Write-nudged full passes that committed new local work but failed to push, since the last
   * successful push — the count of local changes queued for the backstop to retry. 0 when the repo
   * is caught up with its remote; >0 means work is queued locally. Backstop retries never grow it:
   * they re-attempt already-counted commits, so a flaky remote can't inflate one stranded change
   * into "N unpushed". */
  unpushedCount: number;
  lastError: string | null;
  /** How long the pass has been pinned at `syncing`, once past the staleness window. Non-null only
   * for state `stalled` — it is what lets the badge say "stuck 4h" instead of spinning forever. */
  stalledForMs: number | null;
}

/** What the registry actually stores. `stalled` is never written — it is derived on read from
 * `syncingSince`, so a wedged process (which by definition runs no more code) still ages out. */
interface SyncRecord extends Omit<SyncStatus, "stalledForMs"> {
  /** ms epoch this pass stamped `syncing`; null in every terminal state. The stall clock. */
  syncingSince: number | null;
}

/**
 * How long a pass may sit in `syncing` before the registry reads it as `stalled`. A hang is not a
 * rejection: nothing throws, so the `.catch` that records `failing` never runs and the repo would
 * otherwise stay pinned at `syncing` forever — the anton-jfjw.3 defect, where two boards were
 * un-syncable for days with nothing anywhere saying so. Ten missed heartbeats (30s each): long
 * enough that a genuinely slow pull over a big board is not flagged, short enough that an operator
 * sees the stall in minutes rather than days. `ANTON_SYNC_STALL_MS` overrides it (read per call so
 * a change lands without a module reload).
 */
export const SYNC_STALL_MS = 300_000;

function stallWindowMs(): number {
  const raw = Number(process.env.ANTON_SYNC_STALL_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : SYNC_STALL_MS;
}

const SYNC_STATUS_KEY = Symbol.for("anton.beads.syncStatus");
const SYNC_STALL_LOGGED_KEY = Symbol.for("anton.beads.syncStallLogged");

function statusRegistry(): Map<string, SyncRecord> {
  const g = globalThis as unknown as Record<symbol, Map<string, SyncRecord> | undefined>;
  return (g[SYNC_STATUS_KEY] ??= new Map());
}

/** cwd → the `syncingSince` of the stall already logged, so a stall is announced once per
 * occurrence rather than once per read (the board polls getSyncStatus every few seconds). */
function stallLogRegistry(): Map<string, number> {
  const g = globalThis as unknown as Record<symbol, Map<string, number> | undefined>;
  return (g[SYNC_STALL_LOGGED_KEY] ??= new Map());
}

function rawStatus(cwd: string): SyncRecord {
  return (
    statusRegistry().get(cwd) ?? {
      state: "unknown",
      lastSyncedAt: null,
      lastPushedAt: null,
      unpushedCount: 0,
      lastError: null,
      syncingSince: null,
    }
  );
}

/**
 * The repo's sync health, with a wedged pass aged out of `syncing` into `stalled`. Every consumer
 * of the registry reads through here, so the backstop needs no timer and no cooperation from the
 * hung pass itself — which is the point: the process that would have reported the failure is the
 * one that is stuck. `now` is injectable for tests.
 */
export function getSyncStatus(cwd: string, now: number = Date.now()): SyncStatus {
  const { syncingSince, ...view } = rawStatus(cwd);
  if (view.state !== "syncing" || syncingSince === null) return { ...view, stalledForMs: null };
  const stuckForMs = now - syncingSince;
  if (stuckForMs < stallWindowMs()) return { ...view, stalledForMs: null };
  logStallOnce(cwd, syncingSince, stuckForMs, view.lastSyncedAt);
  return { ...view, state: "stalled", stalledForMs: stuckForMs };
}

/** One line per distinct stall, matching sync-engine's log-on-change discipline — an operator
 * tailing the console sees the wedge without running `ps`, and a polling board doesn't flood it. */
function logStallOnce(
  cwd: string,
  syncingSince: number,
  stuckForMs: number,
  lastSyncedAt: number | null,
): void {
  const logged = stallLogRegistry();
  if (logged.get(cwd) === syncingSince) return;
  logged.set(cwd, syncingSince);
  const mins = Math.round(stuckForMs / 60_000);
  const lastSynced =
    lastSyncedAt === null ? "never synced" : `last synced ${new Date(lastSyncedAt).toISOString()}`;
  console.error(
    `[beads.sync] ${cwd} has been stuck in 'syncing' for ${mins}m with no completion and no ` +
      `error — the sync pass is wedged (${lastSynced}).`,
  );
}

/**
 * Compact token for board refreshes. Repeated successful heartbeats do not change it, while every
 * user-visible health transition does (including gaining the first successful-sync timestamp and any
 * change to the unpushed-backlog count, which the badge renders). While stalled it also advances
 * once a minute: the badge renders a server-computed "stuck Xm", which would otherwise freeze at
 * the value captured when the stall was first detected — exactly the frozen-truth failure this
 * state exists to fix.
 */
export function getSyncStatusToken(cwd: string, now: number = Date.now()): string {
  const status = getSyncStatus(cwd, now);
  const seen = status.lastSyncedAt === null ? "never" : "seen";
  const stuck = status.stalledForMs === null ? "" : `:${Math.floor(status.stalledForMs / 60_000)}`;
  return `${status.state}:${seen}:${status.unpushedCount}:${status.lastError ?? ""}${stuck}`;
}

function recordStatus(cwd: string, patch: Partial<SyncRecord>): void {
  const next = { ...rawStatus(cwd), ...patch };
  // Single owner of the stall clock: it starts the moment a pass stamps `syncing` and is cleared by
  // any terminal state, so `syncingSince` always means "the pass currently in flight began here".
  if (patch.state !== undefined) next.syncingSince = patch.state === "syncing" ? Date.now() : null;
  statusRegistry().set(cwd, next);
}

/**
 * Concrete sync passes runDoltSync executes. "full" (write-nudged): pull → commit → push.
 * "pull": pull only — the heartbeat's default, which must NOT push when there are no local
 * changes; every anton instance pushing a shared remote every ~10s is the concurrent-push
 * manifest-corruption pattern (beads GH#2466).
 */
export type SyncMode = "full" | "pull";

/**
 * What the coalescer accepts. "backstop" is the heartbeat's push safety net (anton-sr8f): the
 * coalescer resolves it to "full" when the repo has unpushed local commits (a prior push failed) OR
 * has not yet been reconciled by this process (a cold start after a crash can't trust the in-memory
 * backlog count), and to "pull" otherwise — so stranded commits are always retried until they land,
 * while a caught-up, reconciled repo stays quiet. Routes through the same per-repo coalescer as
 * "full"/"pull", so a backstop push can never overlap a write-nudged one (beads GH#2466).
 *
 * "push" is the durable sync-push job's request (anton-nowq): it ALWAYS runs a full push pass to
 * retry the write's commit, but — unlike "full" — never grows the unpushed backlog (its work is
 * already counted by the write-nudged pass). "backstop" is wrong for the job: it snapshots
 * `unpushedCount` at call time and, if it coalesces behind a still-in-flight write push, reads 0 and
 * drops to pull-only — so a push that then fails goes unretried by the very job meant to retry/park
 * it. "push" forces the retry unconditionally without the count-inflation "full" would cause.
 */
export type SyncRequest = SyncMode | "backstop" | "push";

export type SyncOutcome = "synced" | "not-wired" | "shared-server";


// ── The coalescer ──

/**
 * One planned pass: the mode it runs as, plus the two flags only the requesting kind can decide.
 * Mutable while it sits queued — a later request upgrades it in place (see {@link mergeIntoQueued}).
 */
interface PlannedPass {
  mode: SyncMode;
  /**
   * Does this pass carry genuinely NEW local work? Only a write-nudge ("full") does. A backstop or
   * durable "push" retry re-attempts already-counted commits, so it must never grow the backlog —
   * otherwise a flaky remote turns one stranded change into "N unpushed" after N failed retries
   * (anton-rn88 review).
   */
  newWork: boolean;
  /**
   * May this pass run the server-mode health probe? Only a pass with NO board write of its own
   * behind it — the heartbeat ("backstop") and the read-freshness pulls. A write-nudge ("full") and
   * the durable push retry ("push") both follow a write that, on a shared server, already published
   * itself; probing after it can only invent a failure the write disproves (see runDoltSync).
   */
  probeServer: boolean;
}

/** The single queued pass a burst of requests shares, with a live handle on what it will run as. */
interface TrailingPass {
  promise: Promise<SyncOutcome>;
  pass: PlannedPass;
}

/**
 * Everything the coalescer knows about ONE repo, in one record (anton-ladt) — the pass in flight,
 * the pass queued behind it, and whether this process has reconciled the repo. These three used to
 * be five parallel cwd-keyed containers whose interactions lived only in prose, which is where both
 * anton-z908 and anton-rn88 hid.
 */
interface RepoSync {
  /** The pass currently executing, or undefined when the repo is idle. */
  running?: Promise<SyncOutcome>;
  /** The pass queued behind `running`; every request arriving meanwhile shares it. */
  trailing?: TrailingPass;
  /**
   * Has a full pass pushed (or resolved not-wired/shared-server) for this repo in THIS process?
   * `unpushedCount` lives only in memory, so after a restart a repo left ahead by a crashed process
   * reads count 0; until reconciled, a backstop must run a full pass rather than trust that 0 to
   * mean "caught up" and pull forever (anton-z908 review).
   */
  reconciled: boolean;
}

/**
 * Resolve a request to the concrete pass it runs as. A backstop becomes a push-retry when a prior
 * push failed (recorded backlog) OR when this process has not yet reconciled the repo; a caught-up,
 * already-reconciled repo stays pull-only and quiet. A durable "push" always retries the push,
 * regardless of the (possibly stale) count.
 */
function planPass(cwd: string, request: SyncRequest, reconciled: boolean): PlannedPass {
  const mode: SyncMode =
    request === "backstop"
      ? getSyncStatus(cwd).unpushedCount > 0 || !reconciled
        ? "full"
        : "pull"
      : request === "push"
        ? "full"
        : request;
  return {
    mode,
    newWork: request === "full",
    probeServer: request === "backstop" || request === "pull",
  };
}

/**
 * Fold a request arriving while a pass is queued into that pass: "full" upgrades a queued pull-only
 * pass, a coalesced write carries its new work in, and probe suppression is sticky and one-way — a
 * coalesced pass resolves for EVERY request riding it, so one post-write caller is enough to
 * disqualify the probe for the whole pass. The heartbeat that shares it loses nothing; it re-probes
 * on the next beat.
 */
function mergeIntoQueued(queued: PlannedPass, arriving: PlannedPass): void {
  if (arriving.mode === "full") queued.mode = "full";
  if (arriving.newWork) queued.newWork = true;
  if (!arriving.probeServer) queued.probeServer = false;
}

/** Record a pass that reached its outcome, and mark the repo reconciled once nothing is owed. */
function recordOutcome(
  cwd: string,
  state: RepoSync,
  mode: SyncMode,
  outcome: SyncOutcome,
): SyncOutcome {
  if (outcome === "shared-server") {
    // Every writer is already on the one database, so there is no backlog and nothing to
    // reconcile — record the state and stop forcing full backstop passes (anton-0tul).
    recordStatus(cwd, { state: "shared-server", lastError: null, unpushedCount: 0 });
    state.reconciled = true;
    return outcome;
  }
  if (outcome === "not-wired") {
    recordStatus(cwd, { state: "not-wired", lastError: null });
    state.reconciled = true; // no remote to reconcile against — stop forcing full backstop passes
    return outcome;
  }
  // Retain the last valid data while a background read refreshes after the remote pull.
  invalidateIssueSnapshot(cwd);
  const now = Date.now();
  // A full pass pushed everything — stamp the push and clear the backlog. A pull-only pass
  // moves lastSyncedAt but leaves lastPushedAt/unpushedCount alone (it never pushes).
  recordStatus(cwd, {
    state: "synced",
    lastSyncedAt: now,
    lastError: null,
    ...(mode === "full" ? { lastPushedAt: now, unpushedCount: 0 } : {}),
  });
  if (mode === "full") state.reconciled = true; // a full pass pushed — the backlog is reconciled
  return outcome;
}

/**
 * Record a pass that rejected. A write-nudged full pass committed new work but never landed its
 * push — grow the unpushed backlog so the next heartbeat backstop retries, and the operator sees a
 * truthful "N unpushed" count instead of the failure hiding in server logs. A backstop/durable
 * retry (newWork false) or a pull-only failure leaves the count as-is: the stranded work is already
 * counted (anton-rn88).
 */
function recordFailure(cwd: string, pass: PlannedPass, error: Error): void {
  const patch: Partial<SyncRecord> = { state: "failing", lastError: error.message };
  if (pass.mode === "full" && pass.newWork) {
    patch.unpushedCount = getSyncStatus(cwd).unpushedCount + 1;
  }
  recordStatus(cwd, patch);
}

/**
 * Run one pass now, recording it on the status registry from `syncing` through its outcome.
 *
 * It waits first on this process's OWN in-flight background board read (anton-3dpp). An embedded
 * board is single-holder: `bd dolt pull` takes the repo's exclusive Dolt lock, and a `bd list` still
 * holding it makes that pull FAIL rather than wait. The snapshot layer fires those reads
 * deliberately un-awaited (so a UI read never waits behind Dolt) — including the one this very
 * engine triggers when a pass ends and invalidates the snapshot — so without the wait the collision
 * is self-inflicted and load-dependent: the busier the box, the longer the read runs and the wider
 * the window. What it cost was never a lost sync alone; a run publishing its run-lease through this
 * pass fails CLOSED on it and reschedules as "live elsewhere" when nothing was live anywhere. We
 * wait for the read to be OVER, not for its beads, and only for one already in flight — a repo whose
 * reads keep re-firing can still never starve a pass.
 */
function startPass(
  cwd: string,
  state: RepoSync,
  pass: PlannedPass,
  exec: BdExec | undefined,
): Promise<SyncOutcome> {
  recordStatus(cwd, { state: "syncing" });
  const p = Promise.resolve(issueSnapshotRefreshInFlight(cwd))
    .catch(() => {}) // a failed read is the reader's business; it still released the lock
    .then(() => runDoltSync(cwd, exec, pass.mode, pass.probeServer))
    .then((outcome) => recordOutcome(cwd, state, pass.mode, outcome));
  state.running = p;
  // Bookkeeping only — callers hold `p` and see its rejection; this chain must not re-reject.
  void p
    .catch((e: Error) => recordFailure(cwd, pass, e))
    .finally(() => {
      if (state.running === p) state.running = undefined;
    });
  return p;
}

/**
 * Queue THE trailing pass behind the one in flight — the coalescing point: every further request
 * arriving before it starts merges into it rather than adding a pass, so a burst of writes costs one
 * extra push, not one each. Its plan stays live until it starts, so a late "full" still upgrades it.
 */
function queueBehind(
  cwd: string,
  state: RepoSync,
  running: Promise<SyncOutcome>,
  pass: PlannedPass,
  exec: BdExec | undefined,
): Promise<SyncOutcome> {
  const trailing: TrailingPass = {
    pass,
    promise: running
      .catch(() => {}) // the current run's failure belongs to its own callers
      .then(() => {
        state.trailing = undefined;
        return startPass(cwd, state, trailing.pass, exec);
      }),
  };
  state.trailing = trailing;
  return trailing.promise;
}

/**
 * Coalescing wrapper around runDoltSync, keyed by cwd: while a sync runs, every request that
 * arrives shares ONE trailing sync (which starts after the current one and therefore sees all
 * their writes) — a burst of writes costs one extra push, not one each. A "pull" request
 * piggybacks on any in-flight or queued pass (full ⊃ pull); a "full" request upgrades a queued
 * pull-only trailing pass. Updates the sync status registry on every pass. Exported for testing.
 *
 * Also tracks the per-repo unpushed backlog on the sync-status registry (anton-sr8f, anton-rn88): a
 * write-nudged full pass that fails to reach "synced" committed new local work it couldn't push, so
 * the repo is left ahead of its remote — recorded as `unpushedCount > 0`. A backstop retry that also
 * fails does NOT grow the count: it re-attempts the same stranded commits and adds no new work, so a
 * flaky remote can't inflate one change into "N unpushed". That count lets a "backstop" request (the
 * heartbeat) resolve to a push-retry while a caught-up repo stays pull-only, and it is the
 * operator-visible "N unpushed" surface. A full pass that reaches "synced"/"not-wired" clears the
 * count and stamps `lastPushedAt` (nothing left to push).
 *
 * Resolves with the pass's `SyncOutcome` so callers can tell delivery from non-delivery: a
 * "not-wired" repo has no remote to publish to, so the write is still only local. The durable
 * sync-push job depends on that distinction — resolving void would let it settle `done` on work it
 * never delivered (anton-x7la review). Coalesced callers share the outcome of the pass that covers
 * them, which is the pass their own request ran in.
 *
 * `exec` is injectable for tests; omitting it leaves runDoltSync to reach for the real bd, which is
 * what keeps bd's spawn seam private to bd.ts.
 */
export function createDoltSync(
  exec?: BdExec,
): (cwd: string, mode?: SyncRequest) => Promise<SyncOutcome> {
  const repos = new Map<string, RepoSync>();
  const stateOf = (cwd: string): RepoSync => {
    const existing = repos.get(cwd);
    if (existing) return existing;
    const fresh: RepoSync = { reconciled: false };
    repos.set(cwd, fresh);
    return fresh;
  };

  return function sync(cwd: string, request: SyncRequest = "full"): Promise<SyncOutcome> {
    const state = stateOf(cwd);
    const pass = planPass(cwd, request, state.reconciled);
    if (state.trailing) {
      mergeIntoQueued(state.trailing.pass, pass);
      return state.trailing.promise;
    }
    const running = state.running;
    return running
      ? queueBehind(cwd, state, running, pass, exec)
      : startPass(cwd, state, pass, exec);
  };
}

// The singleton is globalThis-anchored for the same cross-bundle reason as the status registry:
// two module instances with separate coalescing maps would defeat the never-overlap invariant.
//
// Versioned for the same reason the server-preflight registry in bd.ts is (PR #174 review), and
// here it is the BEHAVIOUR rather than a value shape that changes: what the global holds is a
// closure, and `Symbol.for` outlives module replacement — so under a Next.js dev hot reload this
// module would adopt the previous build's engine and every change to the pass (the server-probe
// suppression that keeps a published server-mode write from being rejected by a health probe behind
// it, say) would go untested until the process restarted. A new key hands the reloaded code its own
// engine; the old one stays reachable to whatever still holds it, which is the whole of what is
// given up — only in dev, where a reload is the point. Bump it whenever a pass's behaviour changes.
const DOLT_SYNC_KEY = Symbol.for("anton.beads.doltSync.v2");
export const doltSync = ((
  globalThis as unknown as Record<symbol, ReturnType<typeof createDoltSync>>
)[DOLT_SYNC_KEY] ??= createDoltSync());
