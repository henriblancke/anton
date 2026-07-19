import { beads, type Bead } from "./bd";
import {
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
