import type { Bead } from "./types";

export const ISSUE_SNAPSHOT_MAX_AGE_MS = 30_000;

interface SnapshotEntry {
  beads: Bead[] | null;
  serialized: string | null;
  version: number;
  generation: number;
  loadedAt: number;
  refresh: Promise<Bead[]> | null;
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
  };
  entries.set(cwd, created);
  return created;
}

/** Monotonic repository version used by lightweight browser freshness checks. */
export function issueSnapshotVersion(cwd: string): number {
  return entryFor(cwd).version;
}

/**
 * Mark cached data stale while retaining it so readers keep serving last-good data and never wait
 * behind a Dolt sync/write. `localWrite` additionally bumps the version (so clients detect the
 * change) and clears any in-flight loader, forcing a fresh read that starts AFTER the write — the
 * pre-write loader is orphaned and the generation guard discards its result. Beads are retained
 * either way: a local write marks the snapshot stale, it never blanks the board.
 */
export function invalidateIssueSnapshot(cwd: string, localWrite = false): void {
  const entry = entryFor(cwd);
  entry.loadedAt = 0;
  entry.generation += 1;
  if (localWrite) {
    entry.version += 1;
    // A post-write read must start after the write, never share a loader that started before it.
    entry.refresh = null;
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
 * background refresh and keep serving known-good data.
 */
export async function getIssueSnapshot(
  cwd: string,
  loader: () => Promise<Bead[]>,
  now = Date.now(),
): Promise<Bead[]> {
  const entry = entryFor(cwd);
  if (entry.beads) {
    if (now - entry.loadedAt >= ISSUE_SNAPSHOT_MAX_AGE_MS) {
      void refreshIssueSnapshot(cwd, loader, now).catch(() => {});
    }
    return entry.beads;
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
