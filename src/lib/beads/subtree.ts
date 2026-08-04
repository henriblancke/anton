/**
 * The parent-child subtree walk, alone in a dependency-free leaf module (like ./claim-lock) so every
 * caller that must reason about "everything beneath this bead" shares ONE walk: an abandon's cascade
 * (abandon.ts) and a delete's cascade (epic-detail.ts) settle the same subtree by different means,
 * and two walks that disagreed would let one of them miss work the other takes.
 */
import { beads, type Bead } from "./bd";

/**
 * Every descendant of `rootId`, depth-first in board order. The walk goes the WHOLE way down, not
 * one level: under the three-tier shape (epic → feature → task) a ticket's parent is its feature, so
 * a direct-children walk sees neither the tickets a cascade takes with it nor the beads a delete
 * destroys.
 *
 * `keep` filters what is COLLECTED, never what is descended through — a settled bead is walked past
 * so open work beneath it is still found. Guards against a malformed parent cycle.
 *
 * Pure over a bead list, so a caller costs one bd read and is testable from a fixture board.
 */
export function descendantsOf(board: Bead[], rootId: string, keep?: (bead: Bead) => boolean): Bead[] {
  const childrenByParent = new Map<string, Bead[]>();
  for (const bead of board) {
    const parent = beads.parentOf(bead);
    if (!parent) continue;
    const siblings = childrenByParent.get(parent);
    if (siblings) siblings.push(bead);
    else childrenByParent.set(parent, [bead]);
  }

  const found: Bead[] = [];
  const seen = new Set<string>([rootId]); // also the cycle guard on a malformed parent chain
  const stack = [...(childrenByParent.get(rootId) ?? [])].reverse();
  while (stack.length > 0) {
    const bead = stack.pop()!;
    if (seen.has(bead.id)) continue;
    seen.add(bead.id);
    if (!keep || keep(bead)) found.push(bead);
    const children = childrenByParent.get(bead.id) ?? [];
    for (let i = children.length - 1; i >= 0; i--) stack.push(children[i]);
  }
  return found;
}
