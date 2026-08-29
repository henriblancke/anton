/**
 * The board, projected into the flat candidates the policy editor evaluates in the browser.
 *
 * The split exists so the evaluator ({@link ./match}) can stay client-safe: it must run on every
 * criterion edit, which means it runs in the browser, which means it cannot reach the bd reader.
 * Everything that needs the board is resolved here, once, on the server that already holds the
 * snapshot.
 *
 * The projected set is the STRUCTURALLY ELIGIBLE one — {@link eligibleTargets}, the same gate the
 * board-picker narrows with the policy — not merely the open run targets. A target that is already
 * claimed, abandoned, held by a blocker or short of the approve contract is refused before any
 * policy is consulted, so counting it would inflate the one number the panel exists to make honest:
 * the panel would claim available work where the picker has none. The rest of the open run targets
 * are reported as {@link PolicyProjection.notStartable} instead, so the shrunken denominator is
 * explained rather than silently smaller than the board.
 *
 * `now` is a PARAMETER because age is the one candidate field that is not a property of the board:
 * reading the clock inside the predicate would make it impure and its tests time-dependent, so the
 * clock is read once, here, and each bead carries the age it had when the board was projected.
 */
import { beads } from "../beads/bd";
import { eligibleTargets } from "../jobs/picker-targets";
import type { Bead } from "../beads/types";
import type { PolicyCandidate } from "./match";

/** The startable set a policy chooses from, plus what never reaches it. */
export interface PolicyProjection {
  /** Exactly the targets the picker evaluates the policy over, in board order. */
  candidates: PolicyCandidate[];
  /**
   * Open run targets refused before the policy: claimed, abandoned, blocked, or not shaped to run.
   * A count rather than a list — the panel explains the denominator with it; the Up Next lane, which
   * reads the recorded plan, is where each refusal is named.
   */
  notStartable: number;
}

/**
 * Pure over a board snapshot a caller already holds — no bd spawn.
 *
 * Eligibility is derived the way the approve route and the picker derive it, through
 * {@link eligibleTargets}, so the editor can never disagree with what will actually refuse to start.
 * That gate already withholds every target held by an open blocker, which is why nothing here marks
 * blockedness: within this set {@link PolicyCandidate.blocked} is false by construction.
 */
export function policyCandidates(board: readonly Bead[], now: Date = new Date()): PolicyProjection {
  const all = board as Bead[];
  const byId = new Map(all.map((b) => [b.id, b]));
  const { eligible } = eligibleTargets(all);
  const openTargets = all.filter((b) => b.status === "open" && beads.isRunTarget(b, all));

  const candidates = eligible.map((b) => {
    const depth = parentDepth(b, byId);
    const ageDays = ageInDays(b, now);
    return {
      id: b.id,
      title: b.title,
      ...(b.issue_type ? { type: b.issue_type } : {}),
      ...(typeof b.priority === "number" ? { priority: b.priority } : {}),
      ...(typeof depth === "number" ? { depth } : {}),
      ...(typeof ageDays === "number" ? { ageDays } : {}),
      labels: b.labels ?? [],
    };
  });

  // Eligibility is a subset of the open run targets, so the difference is exactly what the gate
  // refused — no second walk of the exclusions to count them.
  return { candidates, notStartable: openTargets.length - eligible.length };
}

/**
 * Parent hops above a bead — 0 for top-level work. `undefined` where the chain cannot be resolved: a
 * parent this snapshot does not carry, or a cycle a malformed board could hold. The predicate fails
 * closed on that rather than being handed a depth nobody computed, which is why this reports the gap
 * instead of defaulting it to 0.
 */
function parentDepth(bead: Bead, byId: ReadonlyMap<string, Bead>): number | undefined {
  const seen = new Set<string>([bead.id]);
  let current = bead;
  let depth = 0;
  let parent = beads.parentOf(current);
  while (parent) {
    const next = byId.get(parent);
    if (!next || seen.has(parent)) return undefined;
    seen.add(parent);
    current = next;
    depth += 1;
    parent = beads.parentOf(current);
  }
  return depth;
}

/** Whole days since the bead was filed, or `undefined` when it carries no usable creation date. */
function ageInDays(bead: Bead, now: Date): number | undefined {
  if (!bead.created_at) return undefined;
  const created = Date.parse(bead.created_at);
  if (Number.isNaN(created)) return undefined;
  // Floored, so "at least 1 day old" means a full day has passed rather than a rounding of hours.
  return Math.max(0, Math.floor((now.getTime() - created) / 86_400_000));
}
