/**
 * Every bar an ORDERING claim clears before anton files it (anton-d2sx): each reason bd or the graph
 * would refuse a `blocks` edge later, asked at filing time instead.
 *
 * Asked here rather than left to approve time because an ask that can only ever fail is worse than
 * no ask: it sits on the board asking a founder to approve something anton will refuse, until
 * somebody declines it by hand (the anton-wsap failure mode).
 */
import type { Bead } from "../beads/bd";
import { isOpenWork, type BoardIndex } from "../gardener/board-index";
import { isProposalBead } from "../gardener/detections";
import { firstRefusal, type Guard } from "./guard";
import type { PmClaimOrder } from "./report";

/** Why an ordering edge cannot be recorded, or undefined when the claim clears every bar. */
export function orderRefusal(
  claim: PmClaimOrder,
  subject: Bead,
  index: BoardIndex,
  nowMs: number,
): string | undefined {
  return firstRefusal(ORDER_GUARDS, claim, subject, index, nowMs);
}

function blocksItself(claim: PmClaimOrder): string | undefined {
  return claim.blockedBy === claim.bead ? `${claim.bead} cannot block itself` : undefined;
}

function blockerMissing(claim: PmClaimOrder, _subject: Bead, index: BoardIndex): string | undefined {
  return index.byId.has(claim.blockedBy) ? undefined : `${claim.blockedBy} is not on the board`;
}

// A proposal is open work, so `isOpenWork` waves it through — but it closes when the founder
// approves or declines it, and the `blocks` edge outlives it. The subject would sit queue-blocked
// behind an ask that no longer exists, with nothing left to land and unblock it.
function blockerIsProposal(
  claim: PmClaimOrder,
  _subject: Bead,
  index: BoardIndex,
): string | undefined {
  return isProposalBead(blockerIn(index, claim))
    ? `${claim.blockedBy} is a proposal, not work — the edge would outlive it and leave ${claim.bead} blocked forever`
    : undefined;
}

function blockerSettled(claim: PmClaimOrder, _subject: Bead, index: BoardIndex): string | undefined {
  return isOpenWork(blockerIn(index, claim))
    ? undefined
    : `${claim.blockedBy} has already landed, so the edge would constrain nothing`;
}

function edgeAlreadyRecorded(
  claim: PmClaimOrder,
  _subject: Bead,
  index: BoardIndex,
): string | undefined {
  return index.hasBlocksEdge(claim.bead, claim.blockedBy)
    ? `the board already records an ordering between ${claim.bead} and ${claim.blockedBy}`
    : undefined;
}

// bd keeps ONE edge per directed pair and refuses a second type over it rather than replacing it.
function pairCarriesDiscovery(
  claim: PmClaimOrder,
  _subject: Bead,
  index: BoardIndex,
): string | undefined {
  return index.recordsDiscovery(claim.bead, claim.blockedBy) ||
    index.recordsDiscovery(claim.blockedBy, claim.bead)
    ? `${claim.bead} and ${claim.blockedBy} already carry a discovered-from edge, and bd keeps one edge per pair`
    : undefined;
}

function edgeWouldCloseCycle(
  claim: PmClaimOrder,
  _subject: Bead,
  index: BoardIndex,
): string | undefined {
  return index.isBlockedBy(claim.blockedBy, claim.bead)
    ? `${claim.blockedBy} is already blocked by ${claim.bead} through other beads — the edge would close a cycle`
    : undefined;
}

/**
 * The blocker `blockerMissing` proved is on the board. Every guard after it holds that bead rather
 * than re-asserting the lookup, which is the whole reason the order is fixed.
 */
function blockerIn(index: BoardIndex, claim: PmClaimOrder): Bead {
  return index.byId.get(claim.blockedBy) as Bead;
}

/**
 * The bars an ordering claim clears, in the order they run. Exported so a test can pin that order:
 * `blockerMissing` is what lets every guard after it read the blocker at all, and the graph checks
 * sit last so a plain contradiction is never reported as a cycle.
 */
export const ORDER_GUARDS: readonly Guard<PmClaimOrder>[] = [
  blocksItself,
  blockerMissing,
  blockerIsProposal,
  blockerSettled,
  edgeAlreadyRecorded,
  pairCarriesDiscovery,
  edgeWouldCloseCycle,
];
