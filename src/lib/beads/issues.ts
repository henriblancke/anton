import { beads, type Bead } from "./bd";
import {
  getBeadDescription,
  getIssueSnapshot,
  probeIssueSnapshot,
  readIssueSnapshot,
  refreshIssueSnapshot,
  type SnapshotRead,
  type SnapshotReadOptions,
} from "./snapshot";

export async function loadAllIssues(cwd: string): Promise<Bead[]> {
  try {
    return await beads.list(cwd, ["--status", "all"]);
  } catch {
    const [open, closed] = await Promise.all([
      beads.list(cwd),
      beads.list(cwd, ["--status", "closed"]),
    ]);
    const seen = new Set<string>();
    return [...open, ...closed].filter((bead) => {
      if (seen.has(bead.id)) return false;
      seen.add(bead.id);
      return true;
    });
  }
}

export function allIssues(cwd: string, opts?: SnapshotReadOptions): Promise<Bead[]> {
  return getIssueSnapshot(cwd, () => loadAllIssues(cwd), undefined, opts);
}

/** Beads plus the snapshot version they carry, read atomically — for callers that stamp a response
 * with the version (the board freshness token) and must not desync data from version. */
export function readAllIssues(cwd: string, opts?: SnapshotReadOptions): Promise<SnapshotRead> {
  return readIssueSnapshot(cwd, () => loadAllIssues(cwd), undefined, opts);
}

export function refreshAllIssues(cwd: string): Promise<Bead[]> {
  return refreshIssueSnapshot(cwd, () => loadAllIssues(cwd));
}

export function probeAllIssues(cwd: string): void {
  probeIssueSnapshot(cwd, () => loadAllIssues(cwd));
}

/**
 * Return a snapshot bead guaranteed to carry its description, so detail views can be served off the
 * already-loaded list without a fresh `bd show`. `bd list --json` carries the description on
 * structured boards, so a snapshot bead is returned as-is — zero bd spawns. When the list omits it
 * (the one field it can drop), the description is fetched once via `bd show` and memoized (see
 * getBeadDescription), so repeat opens of the same bead stay warm.
 */
export async function ensureDescription(cwd: string, lite: Bead): Promise<Bead> {
  if (lite.description !== undefined) return lite;
  const description = await getBeadDescription(cwd, lite.id, async () => {
    const full = await beads.show(cwd, lite.id).catch(() => undefined);
    return full?.description;
  });
  return { ...lite, description };
}
