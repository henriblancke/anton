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

const SNAPSHOTS_KEY = Symbol.for("anton.beads.issueSnapshots");

function snapshots(): Map<string, SnapshotEntry> {
  const global = globalThis as unknown as Record<symbol, Map<string, SnapshotEntry> | undefined>;
  return (global[SNAPSHOTS_KEY] ??= new Map());
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
      if (entry.serialized !== serialized) entry.version += 1;
      entry.beads = beads;
      entry.serialized = serialized;
      entry.loadedAt = now;
      // This read started after (and its generation matches) the write, so it reflects it — the
      // retained board is no longer the only post-write data and reads can serve warm again.
      entry.pendingWrite = false;
      return beads;
    })
    .finally(() => {
      if (entry.refresh === refresh) entry.refresh = null;
    });
  entry.refresh = refresh;
  return refresh;
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
  { blockOnPendingWrite = true }: SnapshotReadOptions = {},
): Promise<Bead[]> {
  const entry = entryFor(cwd);
  const retained = entry.beads;
  if (retained) {
    if (entry.pendingWrite && blockOnPendingWrite) {
      return refreshIssueSnapshot(cwd, loader, now).catch(() => retained);
    }
    // Serve retained now, but a pending write or a stale TTL still needs a fresh read behind it.
    if (entry.pendingWrite || now - entry.loadedAt >= ISSUE_SNAPSHOT_MAX_AGE_MS) {
      void refreshIssueSnapshot(cwd, loader, now).catch(() => {});
    }
    return retained;
  }
  return refreshIssueSnapshot(cwd, loader, now);
}

/** Start a freshness probe without making the caller wait for embedded Dolt. */
export function probeIssueSnapshot(cwd: string, loader: () => Promise<Bead[]>): void {
  const entry = entryFor(cwd);
  if (!entry.beads || Date.now() - entry.loadedAt >= ISSUE_SNAPSHOT_MAX_AGE_MS) {
    void refreshIssueSnapshot(cwd, loader).catch(() => {});
  }
}

/** Test-only reset; repository runtime code should invalidate instead. */
export function resetIssueSnapshots(): void {
  snapshots().clear();
}
