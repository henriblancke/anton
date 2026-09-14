/**
 * Every bar a START claim clears before anton files it (anton-1ivg.1): the reasons apply would
 * refuse the grant later, asked at filing time for the reason `order-guards.ts` and `home-guards.ts`
 * ask their own — an ask that can only ever fail sits on the board asking a founder to approve
 * something anton will refuse, until somebody declines it by hand (the anton-wsap failure mode).
 *
 * The eligibility bar is asked through apply's own {@link startBarred} rather than a copy of it, so
 * the filing check and the approve check cannot disagree about what the board would offer as work —
 * and so the move stays inside the picker's policy rather than beside it.
 */
import { beads, type Bead } from "../beads/bd";
import { HOME_STANDING, startBarred } from "../gardener/apply-plan";
import type { BoardIndex } from "../gardener/board-index";
import { firstRefusal, type Guard } from "./guard";
import type { PmClaimStart } from "./report";

/** Why this bead cannot be the start the claim asks for, or undefined when it clears every bar. */
export function startRefusal(
  claim: PmClaimStart,
  subject: Bead,
  index: BoardIndex,
  nowMs: number,
): string | undefined {
  return firstRefusal(START_GUARDS, claim, subject, index, nowMs);
}

// The gate is the whole ask, so a bead that already carries it has the outcome the claim wanted:
// `planApprove` settles such a proposal without writing, which costs a founder a decision for a
// board that already agrees. The claim's own premise is also simply false — nothing is withholding
// an approval that is there.
function alreadyApproved(claim: PmClaimStart, subject: Bead): string | undefined {
  return beads.isApproved(subject)
    ? `${claim.bead} is already approved — nothing is withholding the gate, so the move would write nothing`
    : undefined;
}

// The picker's own eligibility, delegated whole: a run target, unclaimed, unblocked, and clearing
// the approve gate's four promises. Asked here so a claim the board itself would refuse never
// reaches the founder — and asked through the SAME predicate apply holds it to, because a second
// definition of "startable" would file asks that refuse forever, or refuse asks apply would allow.
function notStartable(
  _claim: PmClaimStart,
  subject: Bead,
  index: BoardIndex,
): string | undefined {
  return startBarred(subject, index.all, HOME_STANDING.snapshot);
}

/**
 * The bars a start claim clears, in the order they run. Exported so a test can pin that order: the
 * cheap fact about the label comes first, so a bead that already carries the gate says so rather
 * than being reported as whatever the eligibility walk happens to find wrong with it.
 */
export const START_GUARDS: readonly Guard<PmClaimStart>[] = [alreadyApproved, notStartable];
