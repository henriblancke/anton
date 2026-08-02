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

function dedupeById(beadList: Bead[]): Bead[] {
  const seen = new Set<string>();
  return beadList.filter((bead) => {
    if (seen.has(bead.id)) return false;
    seen.add(bead.id);
    return true;
  });
}

async function loadWorkIssues(cwd: string): Promise<Bead[]> {
  try {
    return await beads.list(cwd, ["--status", "all"]);
  } catch {
    const [open, closed] = await Promise.all([
      beads.list(cwd),
      beads.list(cwd, ["--status", "closed"]),
    ]);
    return dedupeById([...open, ...closed]);
  }
}

/**
 * Does the listing point at a `blocks` blocker it does not itself contain? That dangling edge is
 * the ONLY thing a second read can resolve, and in practice it means a gate (see
 * {@link loadGateIssues}).
 */
function hasDanglingBlocker(work: Bead[]): boolean {
  const known = new Set(work.map((b) => b.id));
  return beads.edgesOf(work).some((e) => e.type === "blocks" && !known.has(e.to));
}

/**
 * Gate beads, which bd OMITS from every ordinary listing (measured against bd 1.1.2: a poured
 * molecule's gates are absent from `bd list --status all`, and `--type gate` is the only listing
 * that surfaces them) — while the `blocks` edge a gate puts on the bead it gates IS carried there.
 *
 * That asymmetry is the trap this read exists to close (anton-ve2r). Every blocker helper treats a
 * blocker missing from the list as still open (fail-safe), so without the gates present a RESOLVED
 * gate reads as an open blocker forever: its bead never returns to ready and its approve route 409s
 * permanently, `bd gate resolve` notwithstanding. Reading them makes their real status knowable;
 * keeping them OUT of the work surfaces is a separate, type-based filter (isPipelineArtifact).
 *
 * Best-effort on purpose: a bd that cannot answer this listing degrades to the pre-gate behaviour
 * (gates absent ⇒ their edges read as open blockers) rather than failing the whole board read.
 */
function loadGateIssues(cwd: string): Promise<Bead[]> {
  return beads.list(cwd, ["--status", "all", "--type", "gate"]).catch(() => []);
}

export async function loadAllIssues(cwd: string): Promise<Bead[]> {
  const work = await loadWorkIssues(cwd);
  // CONDITIONAL, not unconditional: a board read sits on the operator's critical path behind the
  // Dolt lock, and anton-hwkx trimmed approve down to exactly one. A board with no dangling blocker
  // has no gate that could change any answer, so it keeps paying for one read; only a board that
  // actually holds a gate edge pays for the second.
  if (!hasDanglingBlocker(work)) return work;
  // Deduped rather than concatenated: a future bd that starts carrying gates in the ordinary
  // listing must not double them (and a test double answering both reads alike must not either).
  return dedupeById([...work, ...await loadGateIssues(cwd)]);
}

export function allIssues(
  cwd: string,
  opts?: SnapshotReadOptions,
): Promise<Bead[]> {
  return getIssueSnapshot(cwd, () => loadAllIssues(cwd), undefined, opts);
}

/** Beads plus the snapshot version they carry, read atomically — for callers that stamp a response
 * with the version (the board freshness token) and must not desync data from version. */
export function readAllIssues(
  cwd: string,
  opts?: SnapshotReadOptions,
): Promise<SnapshotRead> {
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
export async function ensureDescription(
  cwd: string,
  lite: Bead,
): Promise<Bead> {
  if (lite.description !== undefined) return lite;
  const description = await getBeadDescription(cwd, lite.id, async () => {
    // Let transient bd failures reject: getBeadDescription must not turn a failed read into a
    // successfully cached empty contract. A later detail open can then retry the read.
    const full = await beads.show(cwd, lite.id);
    return full?.description;
  });
  return { ...lite, description };
}
