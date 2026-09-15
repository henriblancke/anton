import { attachCycleEvidence, cycleEvidenceFor } from "./cycle-evidence";
import type { Bead } from "./types";

export const ISSUE_SNAPSHOT_MAX_AGE_MS = 30_000;

interface SnapshotEntry {
  beads: Bead[] | null;
  serialized: string | null;
  version: number;
  generation: number;
  loadedAt: number;
  refresh: Promise<Bead[]> | null;
  // A local write bumped the version but retained last-good beads. Full board reads must block on a
  // fresh post-write read (never serve the stale-but-version-stamped board); cleared once one lands.
  pendingWrite: boolean;
}

export interface SnapshotReadOptions {
  /**
   * Whether a pending local write blocks the read on a fresh post-write load. Default `true` for
   * write-then-navigate/forced-reload paths that must reflect the write. The versioned poll path
   * passes `false`: it is contractually non-blocking, so it serves the retained board now and lets
   * a background refresh (and the client's next poll) surface the post-write data.
   */
  blockOnPendingWrite?: boolean;
}

export interface SnapshotRead {
  beads: Bead[];
  /** The snapshot version these exact beads carry — captured in the same tick they were read, so a
   * concurrent background refresh can never advance the version past the data a caller returns. */
  version: number;
}

const SNAPSHOTS_KEY = Symbol.for("anton.beads.issueSnapshots");
const DESCRIPTIONS_KEY = Symbol.for("anton.beads.beadDescriptions");
const LISTENERS_KEY = Symbol.for("anton.beads.boardChangeListeners");

function snapshots(): Map<string, SnapshotEntry> {
  const global = globalThis as unknown as Record<
    symbol,
    Map<string, SnapshotEntry> | undefined
  >;
  return (global[SNAPSHOTS_KEY] ??= new Map());
}

/** Told, with the repo path, whenever that repo's board moved. Never awaited, never throws. */
export type BoardChangeListener = (cwd: string) => void;

function boardChangeListeners(): Set<BoardChangeListener> {
  const global = globalThis as unknown as Record<symbol, Set<BoardChangeListener> | undefined>;
  return (global[LISTENERS_KEY] ??= new Set());
}

/**
 * Subscribe to "this repo's board moved", and get back the unsubscribe (anton-h32k).
 *
 * The signal is a completed board read whose CONTENT differs from the last one — announced from
 * {@link refreshIssueSnapshot}, never from an invalidation. That distinction is the whole contract:
 * an invalidation says a fresh read is needed, not that anything changed, and the sync coalescer
 * invalidates on every pass that reaches `synced` whether or not the pull landed a single commit.
 * A listener wired to that would fire every 30s on any wired board — a heartbeat wearing a change
 * feed's name. Every mover still reaches subscribers, because every local write (`bdWrite`,
 * `bdGateWrite`) and every remote pull forces the read that detects it.
 *
 * Global-keyed for the same reason the snapshots themselves are: Next compiles instrumentation and
 * the app layer into separate module registries, so a module-scoped set would leave a listener
 * registered at boot deaf to every board read a route handler makes.
 */
export function onBoardChanged(listener: BoardChangeListener): () => void {
  const registered = boardChangeListeners();
  registered.add(listener);
  return () => {
    registered.delete(listener);
  };
}

/**
 * Tell every subscriber this repo's board moved. A listener is a side channel and must never break
 * the read the caller actually asked for — its throw is logged and swallowed.
 */
function announceBoardChange(cwd: string): void {
  for (const listener of boardChangeListeners()) {
    try {
      listener(cwd);
    } catch (e) {
      console.error(`[snapshot] board-change listener failed for ${cwd}`, e);
    }
  }
}

/** Per-repo memo of the one field `bd list` can drop — a bead's description — keyed by bead id. */
function descriptionCaches(): Map<string, Map<string, string>> {
  const global = globalThis as unknown as Record<
    symbol,
    Map<string, Map<string, string>> | undefined
  >;
  return (global[DESCRIPTIONS_KEY] ??= new Map());
}

/**
 * Serve a bead's description from the per-repo memo, loading it once (via `bd show`) on a miss. The
 * list snapshot carries most fields but can omit the description; this memoizes that single lazy
 * fetch so repeat detail opens of the same bead don't re-spawn bd. A loader that yields no
 * description is memoized as empty, so a genuinely description-less bead still costs at most one
 * spawn. The memo is cleared whenever the snapshot is invalidated (a local write or a remote pull
 * may have changed the description), so a stale description can never outlive the write that changed it.
 */
export async function getBeadDescription(
  cwd: string,
  id: string,
  loader: () => Promise<string | undefined>,
): Promise<string> {
  const generation = entryFor(cwd).generation;
  const caches = descriptionCaches();
  const cache = caches.get(cwd) ?? new Map<string, string>();
  if (!caches.has(cwd)) caches.set(cwd, cache);
  const cached = cache.get(id);
  if (cached !== undefined) return cached;
  const description = (await loader()) ?? "";
  // A write or remote pull invalidated this load while it was in flight. Return the value to its
  // original caller, but never let pre-invalidation data repopulate the post-invalidation cache.
  if (entryFor(cwd).generation === generation) cache.set(id, description);
  return description;
}

function entryFor(cwd: string): SnapshotEntry {
  const entries = snapshots();
  const existing = entries.get(cwd);
  if (existing) return existing;
  const created: SnapshotEntry = {
    beads: null,
    serialized: null,
    version: 0,
    generation: 0,
    loadedAt: 0,
    refresh: null,
    pendingWrite: false,
  };
  entries.set(cwd, created);
  return created;
}

/** Monotonic repository version used by lightweight browser freshness checks. */
export function issueSnapshotVersion(cwd: string): number {
  return entryFor(cwd).version;
}

/**
 * Monotonic counter bumped whenever the retained board content actually changes — on every
 * invalidation ({@link invalidateIssueSnapshot}) AND, below in {@link refreshIssueSnapshot}, on a
 * TTL/probe refresh that discovers different content with no invalidation call in between (PR
 * #274 review, round 8 on `issues.ts:213`). A shared-server board (`dolt_mode: server`) can move
 * because ANOTHER machine wrote it — a change this repo only ever discovers by a plain TTL refresh
 * noticing the graph differs, never through `invalidateIssueSnapshot`. Without the bump there,
 * `attachCyclesBestEffort`'s shared-fetch key (`${cwd}::${generation}`) stays unchanged across that
 * refresh, so an in-flight `bd dep cycles` call started against the OLD graph gets reused and
 * stamped onto the REPLACED board as if it were current — a newly introduced cycle recorded as
 * cycle-free, or a repaired one as still present, until some later change happens to bump it again.
 * Callers that share an in-flight `bd dep cycles` fetch across concurrent readers use this counter
 * to detect a snapshot replaced mid-fetch, so a result describing a stale graph is never attached
 * to a newer one.
 */
export function issueSnapshotGeneration(cwd: string): number {
  return entryFor(cwd).generation;
}

/**
 * Bump the version alone — no content changed, no beads replaced, no generation advance — for a side
 * channel that recovers independently of the bead data itself (PR #274 review, round 2 on
 * `issues.ts:158`: a `bd dep cycles` retry landing evidence that a prior read couldn't get).
 *
 * The poll path's freshness token is sourced from this number and nothing else it can move on its
 * own, so without this a `bd` hiccup on the first authoritative read would leave every later poll
 * 304-ing the same "evidence unavailable" verdict until the bead content itself changed or a manual
 * reload forced a read — never on `bd` simply recovering.
 */
export function markCycleEvidenceRecovered(cwd: string): void {
  entryFor(cwd).version += 1;
}

/**
 * Mark cached data stale while retaining it so a background-refresh reader (the poll path) keeps
 * serving last-good data and never waits behind a Dolt sync. `localWrite` additionally bumps the
 * version (so clients detect the change), clears any in-flight loader — forcing a fresh read that
 * starts AFTER the write; the pre-write loader is orphaned and the generation guard discards its
 * result — and flags the entry pendingWrite so full board reads (`getIssueSnapshot`) block on that
 * fresh read rather than hand back the retained board stamped with the already-advanced version.
 * Beads are retained either way: an invalidation marks the snapshot stale, it never blanks the board.
 */
export function invalidateIssueSnapshot(cwd: string, localWrite = false): void {
  const entry = entryFor(cwd);
  entry.loadedAt = 0;
  entry.generation += 1;
  // A lazily-fetched description may now be stale (a write or a remote pull can change it), so drop
  // the memo alongside the snapshot rather than serve a description that predates the change.
  descriptionCaches().get(cwd)?.clear();
  if (localWrite) {
    entry.version += 1;
    // A post-write read must start after the write, never share a loader that started before it.
    entry.refresh = null;
    entry.pendingWrite = true;
  }
}

/**
 * Refresh a repository once. Concurrent callers share the same loader invocation. A failed
 * refresh never discards the last good snapshot.
 *
 * This is also where "the board moved" is ANNOUNCED ({@link onBoardChanged}), because a completed
 * read is the only place the app can tell a move from a poll: it compares the board it just loaded
 * against the one it held.
 */
export function refreshIssueSnapshot(
  cwd: string,
  loader: () => Promise<Bead[]>,
  now = Date.now(),
): Promise<Bead[]> {
  const entry = entryFor(cwd);
  if (entry.refresh) return entry.refresh;
  const generation = entry.generation;

  const refresh = loader()
    .then((beads) => {
      // A write or sync invalidated this loader while it was running. Its result predates that
      // boundary and must never repopulate the current snapshot.
      if (entry.generation !== generation) return entry.beads ?? beads;
      const serialized = JSON.stringify(beads);
      // A cold entry has no board to differ FROM, so the first read of a repo sets the baseline
      // rather than announcing a move nobody made.
      const moved = entry.serialized !== null && entry.serialized !== serialized;
      // Identical graph content: this fresh array (the cycle sidecar is WeakMap-keyed on array
      // identity, so a new array never inherits it) still describes the same graph the retained
      // evidence was read for, so carry it forward. Without this, an ordinary refresh that never
      // asked for cycles drops previously-attached evidence on every poll even when nothing
      // changed, forcing the next evidence probe to re-spawn `bd dep cycles` and bump the version
      // for no real change.
      const hadEvidence = entry.beads ? cycleEvidenceFor(entry.beads) !== undefined : false;
      if (!moved && entry.beads && cycleEvidenceFor(beads) === undefined) {
        const evidence = cycleEvidenceFor(entry.beads);
        if (evidence !== undefined) attachCycleEvidence(beads, evidence);
      }
      // Evidence becoming available where the retained snapshot had none is also a reason to bump,
      // even when the bead content itself is unchanged — a `withCycles` refresh that finally lands
      // real evidence after a prior attempt degraded must give a stuck poller a fresh token, not
      // wait for unrelated content to change too (mirrors `markCycleEvidenceRecovered`'s reasoning).
      const evidenceRecovered = !hadEvidence && cycleEvidenceFor(beads) !== undefined;
      if (entry.serialized !== serialized || evidenceRecovered) entry.version += 1;
      // Content actually differing is a graph change regardless of whether anything called
      // `invalidateIssueSnapshot` — a shared-server board can move from another machine's write, and
      // a plain TTL refresh is the only place that ever notices. Bump here too, or a cycle fetch
      // in flight against the pre-refresh graph keeps coalescing onto the replaced board (see
      // {@link issueSnapshotGeneration}).
      if (moved) entry.generation += 1;
      entry.beads = beads;
      entry.serialized = serialized;
      entry.loadedAt = now;
      // This read started after (and its generation matches) the write, so it reflects it — the
      // retained board is no longer the only post-write data and reads can serve warm again.
      entry.pendingWrite = false;
      // Announced AFTER the entry has taken the new board, so a listener that reads back sees it.
      if (moved) announceBoardChange(cwd);
      return beads;
    })
    .finally(() => {
      if (entry.refresh === refresh) entry.refresh = null;
    });
  entry.refresh = refresh;
  return refresh;
}

/**
 * Overwrite the retained board with `hydrated`, guarded by `generation` (PR #274 review,
 * `issues.ts:294`). `refreshIssueSnapshot`'s single-flight loader is loader-blind: a concurrent
 * refresh that never asked for `strictGates` can win the race and latch a gate-less board onto this
 * entry before a `strictGates` caller re-fetches the missing gates and merges them into a NEW array
 * downstream (`dedupeById` never mutates the retained one in place, unlike the cycle-evidence
 * WeakMap attachment). Without writing that merged array back here, the entry stays on the degraded
 * board it already cached, so every later reader of THIS snapshot (a subsequent `getBoard` in the
 * same request, another page's poll) keeps seeing a `blocks` edge to a resolved gate as still
 * dangling and open.
 *
 * `generation` must be read (via {@link issueSnapshotGeneration}) before the extra gate fetch that
 * produced `hydrated` — a mismatch here means the entry moved (an invalidation, a newer refresh)
 * while that fetch was in flight, so `hydrated` describes a graph this entry no longer represents
 * and must not be stamped onto it.
 */
export function hydrateIssueSnapshot(cwd: string, hydrated: Bead[], generation: number): void {
  const entry = entryFor(cwd);
  if (entry.generation !== generation) return;
  entry.beads = hydrated;
  entry.serialized = JSON.stringify(hydrated);
  entry.version += 1;
}

/**
 * The background board read currently in flight for `cwd`, or null when none is (anton-3dpp).
 *
 * The refreshes above are deliberately un-awaited — that is what keeps a read from waiting behind
 * embedded Dolt — so the `bd list` they spawn outlives the call that started it. On an EMBEDDED
 * board that matters to exactly one other caller: a Dolt pass takes the repo's exclusive lock, and
 * bd fails (it does not queue) when a read still holds it. The sync coalescer awaits this before
 * starting a pass so the two never collide. Returned as an opaque promise: callers wait for the
 * read to be over, never for its beads.
 */
export function issueSnapshotRefreshInFlight(cwd: string): Promise<unknown> | null {
  return entryFor(cwd).refresh;
}

/**
 * Return the last valid snapshot immediately. Cold loads wait once; stale warm loads trigger a
 * background refresh and keep serving known-good data. A pending local write is the exception when
 * `blockOnPendingWrite` (the default): the retained board predates the write yet the version already
 * advanced, so this read blocks on a fresh post-write load (falling back to last-good on a transient
 * failure) rather than serve stale data a version poll would then treat as current — the guarantee
 * the API forced-reload path relies on, honored on write-then-navigate/server-render flows too. The
 * versioned poll path opts out (`blockOnPendingWrite: false`) to stay non-blocking: it serves the
 * retained board now and kicks the post-write load in the background for the client's next poll.
 */
export async function getIssueSnapshot(
  cwd: string,
  loader: () => Promise<Bead[]>,
  now = Date.now(),
  opts: SnapshotReadOptions = {},
): Promise<Bead[]> {
  return (await readIssueSnapshot(cwd, loader, now, opts)).beads;
}

/**
 * Like {@link getIssueSnapshot} but returns the snapshot version alongside the beads, read in the
 * same synchronous tick. Callers that STAMP a response with the version (the board's freshness token)
 * must use this: reading beads and version separately lets an in-flight refresh land between them and
 * advance the version past the data being served, which a version poll would then treat as current
 * and 304 forever — pinning the client to the pre-refresh board until the next invalidation.
 */
export async function readIssueSnapshot(
  cwd: string,
  loader: () => Promise<Bead[]>,
  now = Date.now(),
  { blockOnPendingWrite = true }: SnapshotReadOptions = {},
): Promise<SnapshotRead> {
  const entry = entryFor(cwd);
  const retained = entry.beads;
  if (retained) {
    if (entry.pendingWrite && blockOnPendingWrite) {
      await refreshIssueSnapshot(cwd, loader, now).catch(() => {});
      return { beads: entry.beads ?? retained, version: entry.version };
    }
    // Serve retained now, but a pending write or a stale TTL still needs a fresh read behind it.
    if (
      entry.pendingWrite ||
      now - entry.loadedAt >= ISSUE_SNAPSHOT_MAX_AGE_MS
    ) {
      void refreshIssueSnapshot(cwd, loader, now).catch(() => {});
    }
    return { beads: retained, version: entry.version };
  }
  // Take the loader's own result, not just the cache: when a write invalidates mid-flight the
  // generation guard refuses to repopulate the cache but still hands the loaded board back here —
  // reading `entry.beads` alone would serve a successful load as an empty board.
  const loaded = await refreshIssueSnapshot(cwd, loader, now);
  return { beads: entry.beads ?? loaded, version: entry.version };
}

/** Start a freshness probe without making the caller wait for embedded Dolt. */
export function probeIssueSnapshot(
  cwd: string,
  loader: () => Promise<Bead[]>,
): void {
  const entry = entryFor(cwd);
  if (
    !entry.beads ||
    Date.now() - entry.loadedAt >= ISSUE_SNAPSHOT_MAX_AGE_MS
  ) {
    void refreshIssueSnapshot(cwd, loader).catch(() => {});
  }
}

/**
 * Test-only reset; repository runtime code should invalidate instead. Drops the board-change
 * subscribers too: the registry is process-global, so a suite that forgot to unsubscribe would
 * otherwise leak a listener into the next one and have it fire on a board it knows nothing about.
 */
export function resetIssueSnapshots(): void {
  snapshots().clear();
  descriptionCaches().clear();
  boardChangeListeners().clear();
}
