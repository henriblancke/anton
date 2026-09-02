/**
 * The board primitives merge finalization is built out of (anton-qeir): a best-effort write, the
 * two reads that answer `undefined` rather than throwing, the memo in front of `bd show`, the
 * ancestry walk both halves of the rehome decide belonging with, and the total order two racing
 * processes converge on.
 *
 * Every read here treats a bd failure as evidence of NOTHING rather than as a verdict — the rule
 * the whole finalization is written against, since a snapshot is never enough to justify clearing
 * a claim, moving a ticket, or closing a merged target over work that may still be somebody's.
 */
import { beads, LABELS, ownerOf, type Bead } from "../beads/bd";

/** The stage label an in-review target carries: the sweep selects on it, finalization clears it. */
export const IN_REVIEW = LABELS.stage("in-review");

/** A `bd show`-shaped reader: the bead, or `undefined` when the board could not answer. */
export type ReadBead = (id: string) => Promise<Bead | undefined>;

/** Run a best-effort side effect, swallowing failures. Returns true iff `fn` completed. */
export async function safe(fn: () => Promise<unknown>): Promise<boolean> {
  try {
    await fn();
    return true;
  } catch {
    // best-effort
    return false;
  }
}

/** One bead, or `undefined` when bd could not answer — an unreadable bead decides nothing. */
export function tryShow(repo: string, id: string): Promise<Bead | undefined> {
  return beads.show(repo, id).catch(() => undefined);
}

/**
 * The whole board, or `undefined` when bd could not answer. A list that fails proves nothing
 * either way, which is why callers hold finalization open on it rather than acting on the silence.
 */
export function tryList(repo: string): Promise<Bead[] | undefined> {
  return beads.list(repo, ["--status", "all"]).catch(() => undefined);
}

/**
 * A `bd show` reader backed by `memo`, so a bead read by several ancestry walks — and by both
 * halves of the rehome — costs one call. A read that fails memoises `undefined`: the caller treats
 * "unreadable" as evidence of nothing rather than retrying it per walk.
 */
export function memoisedShow(
  repo: string,
  memo: Map<string, Bead | undefined>,
): ReadBead {
  return async (id) => {
    if (!memo.has(id)) memo.set(id, await tryShow(repo, id));
    return memo.get(id);
  };
}

/**
 * Whether `candidate` still hangs somewhere beneath `epicId`, walked over `read`'s board rather
 * than the sweep's snapshot — an ANCESTOR another operator reparented carries every ticket under it
 * out of this run. `bySubtreeId` is the run's ticket set: a link that leaves it has left the merged
 * target, and a link that cannot be read proves nothing either way.
 *
 * Shared by both halves of the rehome, each with a reader of its own vintage: the plan's reads
 * predate the caller's release/reopen writes, and the apply pass re-reads the board after them.
 */
export async function ridesOn(
  candidate: Bead,
  epicId: string,
  bySubtreeId: Map<string, Bead>,
  read: ReadBead,
): Promise<"target" | "elsewhere" | "unknown"> {
  const seen = new Set<string>([candidate.id]);
  let parentId = beads.parentOf(candidate);
  while (parentId && !seen.has(parentId)) {
    if (parentId === epicId) return "target";
    seen.add(parentId); // a parent cycle terminates rather than hanging finalization
    if (!bySubtreeId.has(parentId)) return "elsewhere"; // left the subtree — another target owns it
    const parent = await read(parentId);
    if (!parent) return "unknown"; // an unreadable link proves nothing either way
    parentId = beads.parentOf(parent);
  }
  return "elsewhere";
}

/** A ticket's live state as a note fragment: the status, and who holds it when anyone does. */
export function stateOf(bead: Bead): string {
  const owner = ownerOf(bead);
  return `\`${bead.status}\`${owner ? ` under ${owner}` : ""}`;
}

/**
 * The older of two follow-up epics — creation time, with the id as a tie-break so the verdict is
 * TOTAL: two processes reconciling the same duplicate pair must reach the same bead, or neither
 * defers and the tickets split across both. A bead bd returns without a `created_at` sorts oldest;
 * any total order will do there, since the field is only missing if bd stops carrying it.
 */
export function olderOf(a: Bead, b: Bead): Bead {
  const at = a.created_at ?? "";
  const bt = b.created_at ?? "";
  if (at !== bt) return at < bt ? a : b;
  return a.id < b.id ? a : b;
}
