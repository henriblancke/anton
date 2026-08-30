/**
 * The shape one bar takes, and the walk that runs a list of them (anton-d2sx).
 *
 * Held apart from the guards themselves so `order-guards.ts` and `home-guards.ts` are siblings that
 * share a contract rather than importing each other, and so the seam in `refusals.ts` can hand a
 * claim to either without knowing which bars it holds.
 */
import type { Bead } from "../beads/bd";
import type { BoardIndex } from "../gardener/board-index";
import type { PmClaim } from "./report";

/**
 * One bar a claim of kind `C` must clear: the refusal it earns, or undefined to hand the claim on.
 *
 * The bars are held as ORDERED LISTS of these rather than as one nested chain because the order is
 * the behaviour. Several of them describe the same board state from different angles, and a weaker
 * bar placed ahead of a stronger one would mask the fault the stronger one exists to report — so the
 * ordering has to be data somebody can read and a test can pin, not a shape nesting happens to have.
 */
export type Guard<C extends PmClaim> = (
  claim: C,
  subject: Bead,
  index: BoardIndex,
  nowMs: number,
) => string | undefined;

/** The first bar this claim fails, in list order, or undefined when it clears all of them. */
export function firstRefusal<C extends PmClaim>(
  guards: readonly Guard<C>[],
  claim: C,
  subject: Bead,
  index: BoardIndex,
  nowMs: number,
): string | undefined {
  for (const guard of guards) {
    const refusal = guard(claim, subject, index, nowMs);
    if (refusal) return refusal;
  }
  return undefined;
}
