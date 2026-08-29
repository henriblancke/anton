/**
 * The seam between the session's judgment and a write to the founder's board (anton-d2sx): every bar
 * a claim must clear before anton will file it, and the detection an accepted one becomes.
 *
 * The session emits CLAIMS, not beads. A fingerprint is a sha1 of a canonical key and dedup, capping
 * and provenance are mechanical — asking an LLM to produce them would be asking it to be a hash
 * function, and one wrong digit files a duplicate ask forever. So the session's whole output is
 * judgment, and {@link detectionsFor} turns it into the same {@link GardenerDetection} values the
 * gardener's own detectors produce, after checking every claim against the board it was made about.
 */
import { beads, type Bead } from "../beads/bd";
import { homeWrongTier, HOME_STANDING } from "../gardener/apply-plan";
import {
  indexBoard,
  isClaimed,
  isInFlight,
  isOpenWork,
  runClaimOf,
  ticketOwnerOf,
  type BoardIndex,
} from "../gardener/board-index";
import { isProposalBead, makeDetection, type GardenerDetection } from "../gardener/detections";
import {
  CLAIM_KINDS,
  type PmClaim,
  type PmClaimKill,
  type PmClaimOrder,
  type PmClaimRehome,
  type PmClaimReprioritize,
} from "./report";

/** A claim the board refused, with the reason — reported, never silently dropped. */
export interface RejectedClaim {
  claim: PmClaim;
  reason: string;
}

export interface DetectionsResult {
  detections: GardenerDetection[];
  rejected: RejectedClaim[];
}

/**
 * Turn the session's claims into detections, dropping every one the board refuses.
 *
 * This check is not defensive padding — it is the seam between a language model's judgment and a
 * write to the founder's board. A claim naming a bead that does not exist, or one a run is shipping
 * right now, would otherwise become a proposal that can only ever refuse at approve time; and a
 * priority "change" to the value the bead already carries is an ask with no content. Each rejection
 * is returned with its reason so the job can report it rather than swallow it — a pass whose claims
 * were all refused looks exactly like a healthy board unless somebody says otherwise.
 *
 * What it deliberately does NOT re-judge is the product question. Whether a bead is worth killing is
 * the session's call, and second-guessing it here would put the judgment in two places.
 */
export function detectionsFor(claims: PmClaim[], board: Bead[], nowMs: number): DetectionsResult {
  const index = indexBoard(board);
  const detections: GardenerDetection[] = [];
  const rejected: RejectedClaim[] = [];

  for (const claim of claims) {
    const checked = subjectChecked(claim, index, nowMs);
    const refusal =
      "refusal" in checked ? checked.refusal : kindRefusal(claim, checked.subject, index, nowMs);
    if (refusal) {
      rejected.push({ claim, reason: refusal });
      continue;
    }
    detections.push(detectionFor(claim));
  }
  return { detections, rejected };
}

/**
 * The claim's SUBJECT, or why it cannot carry a proposal at all — the bars every kind shares.
 *
 * Returns the bead rather than a boolean so every bar downstream HOLDS the thing those bars proved
 * exists, instead of looking it up again and asserting the guarantee a caller established.
 */
function subjectChecked(
  claim: PmClaim,
  index: BoardIndex,
  nowMs: number,
): { subject: Bead } | { refusal: string } {
  const subject = index.byId.get(claim.bead);
  if (!subject) return { refusal: `${claim.bead} is not on the board` };
  if (isProposalBead(subject)) return { refusal: `${claim.bead} is itself a proposal, not work` };
  if (!isOpenWork(subject)) return { refusal: `${claim.bead} is already settled` };
  if (isInFlight(subject, nowMs)) {
    return { refusal: `${claim.bead} is mid-run — a proposal would race the run` };
  }
  return { subject };
}

/**
 * One bar a claim of kind `C` must clear: the refusal it earns, or undefined to hand the claim on.
 *
 * The bars are held as ORDERED LISTS of these rather than as one nested chain because the order is
 * the behaviour. Several of them describe the same board state from different angles, and a weaker
 * bar placed ahead of a stronger one would mask the fault the stronger one exists to report — so the
 * ordering has to be data somebody can read and a test can pin, not a shape nesting happens to have.
 */
type Guard<C extends PmClaim> = (
  claim: C,
  subject: Bead,
  index: BoardIndex,
  nowMs: number,
) => string | undefined;

/** The first bar this claim fails, in list order, or undefined when it clears all of them. */
function firstRefusal<C extends PmClaim>(
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

/** Why this claim's own move cannot stand, or undefined. */
function kindRefusal(
  claim: PmClaim,
  subject: Bead,
  index: BoardIndex,
  nowMs: number,
): string | undefined {
  switch (claim.kind) {
    case "reprioritize":
      return priorityUnchanged(claim, subject);
    case "order":
      return orderRefusal(claim, subject, index, nowMs);
    case "rehome":
      return rehomeRefusal(claim, subject, index, nowMs);
    case "kill":
      return alreadyDeferred(claim, subject);
    default:
      return undefined;
  }
}

/** A priority "change" to the value the bead already carries is an ask with no content. */
function priorityUnchanged(claim: PmClaimReprioritize, subject: Bead): string | undefined {
  return subject.priority !== undefined && `P${subject.priority}` === claim.priority
    ? `${claim.bead} is already at ${claim.priority}`
    : undefined;
}

// A deferred bead is still OPEN work, so `subjectChecked` waves it through — but a kill applies as
// `defer`, and `planRetire` settles an already-deferred subject without writing anything. Left
// unchecked the ask reaches the board, costs a founder a decision, and settles as a no-op. The
// gardener's stale detector excludes deferred beads for this exact reason (gardener/retire.ts).
function alreadyDeferred(claim: PmClaimKill, subject: Bead): string | undefined {
  return beads.isDeferred(subject)
    ? `${claim.bead} is already deferred — killing it again would change nothing`
    : undefined;
}

/**
 * Why an ordering edge cannot be recorded — every reason bd or the graph would refuse it later.
 *
 * Checked here rather than left to approve time because an ask that can only ever fail is worse than
 * no ask: it sits on the board asking a founder to approve something anton will refuse, until
 * somebody declines it by hand (the anton-wsap failure mode).
 */
function orderRefusal(
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

/**
 * Why this bead cannot be hung under the home the claim names, or undefined — every reason apply
 * would refuse the move later, asked at filing time for the same reason {@link orderRefusal} is: an
 * ask that can only ever fail sits on the board asking a founder to approve something anton will
 * refuse, until somebody declines it by hand (the anton-wsap failure mode).
 *
 * The tier bar is asked through apply's own {@link homeWrongTier} rather than a copy of it, so the
 * filing check and the approve check cannot disagree about which homes the taxonomy allows — a
 * ticket hangs off the card that runs it, a card off the container epic that groups it.
 */
function rehomeRefusal(
  claim: PmClaimRehome,
  subject: Bead,
  index: BoardIndex,
  nowMs: number,
): string | undefined {
  return firstRefusal(REHOME_GUARDS, claim, subject, index, nowMs);
}

function homeIsSubject(claim: PmClaimRehome): string | undefined {
  return claim.home === claim.bead ? `${claim.bead} cannot be its own home` : undefined;
}

function homeIsCurrentParent(claim: PmClaimRehome, subject: Bead): string | undefined {
  return beads.parentOf(subject) === claim.home
    ? `${claim.bead} already hangs under ${claim.home} — the move would write nothing`
    : undefined;
}

// The same no-op one tier out, and the one the context now invites: bd nesting runs to any depth,
// so under `feature → task → subtask` the subtask already ships in the FEATURE's run and its PR,
// and its line names that feature as `shipped by`. A claim citing that line proposes the card the
// work already rides — which moves nothing between runs and only flattens nesting somebody meant.
// A `rehome` is a claim that the work would ship in the WRONG card; here nothing is misfiled.
function homeAlreadyShipsSubject(
  claim: PmClaimRehome,
  subject: Bead,
  index: BoardIndex,
): string | undefined {
  return ticketOwnerOf(index, subject)?.id === claim.home
    ? `${claim.bead} already ships under ${claim.home} — it hangs inside that run's ticket set today, so the move would flatten nesting somebody meant rather than change what ships it`
    : undefined;
}

// The subject's half of "a run owns it". `subjectChecked` asks only `isInFlight`, which cannot see
// a claim: a run working a ticket writes the assignee and `in_progress` onto it while the run-lease
// lives on the CARD above, so the ticket reads as free work there. Moved out of that run's ticket
// set, its commit lands in the old card's PR while the bead hangs off the new one, open and unrun.
function subjectHeldByRun(claim: PmClaimRehome, subject: Bead): string | undefined {
  return isClaimed(subject)
    ? `${claim.bead} is held by ${runClaimOf(subject)} — that run is shipping it under its current home, so moving it now would leave the bead and the work it ships in two different places`
    : undefined;
}

// The rest of that half, and the one no per-bead signal can reach: a grouped run publishes ONE
// lease, on the CARD its tickets hang under, and cascades an assignee only to the tickets it has
// already reached. So a ticket that run has SELECTED but not yet started carries no lease and no
// claim — both bars above read it as free work. Moving it out of that set now takes a bead out of
// a set the run already chose, and the run aborts when its claim reaches it.
function subjectRidesOwnedCard(
  claim: PmClaimRehome,
  subject: Bead,
  index: BoardIndex,
  nowMs: number,
): string | undefined {
  const owner = ticketOwnerOf(index, subject);
  return owner && (isInFlight(owner, nowMs) || isClaimed(owner))
    ? `${claim.bead} rides ${owner.id}'s ticket set and a run owns ${owner.id} — that run has already selected the tickets it will work through, so moving one out from under it now would abort it or strand the work it ships`
    : undefined;
}

function homeMissing(claim: PmClaimRehome, _subject: Bead, index: BoardIndex): string | undefined {
  return index.byId.has(claim.home) ? undefined : `${claim.home} is not on the board`;
}

// A proposal is open work, so `isOpenWork` waves it through — but it is a bead ABOUT the board,
// not part of its shape, and it closes the moment the founder answers it. Work hung under one
// would be left beneath a settled ask nothing will ever run.
function homeIsProposal(
  claim: PmClaimRehome,
  _subject: Bead,
  index: BoardIndex,
): string | undefined {
  return isProposalBead(homeIn(index, claim)) ? `${claim.home} is a proposal, not a home` : undefined;
}

function homeSettled(claim: PmClaimRehome, _subject: Bead, index: BoardIndex): string | undefined {
  return isOpenWork(homeIn(index, claim))
    ? undefined
    : `${claim.home} is already settled — hanging work under it would leave it riding a home nothing will run`;
}

// Both halves of "a run owns it": a published lease, and the pickup window before one exists. A run
// that already selected the tickets it will work through would carry the newcomer along unrun.
function homeInFlight(
  claim: PmClaimRehome,
  _subject: Bead,
  index: BoardIndex,
  nowMs: number,
): string | undefined {
  return isInFlight(homeIn(index, claim), nowMs)
    ? `${claim.home} is mid-run — hanging work under it would race the run that owns it`
    : undefined;
}

function homeClaimed(claim: PmClaimRehome, _subject: Bead, index: BoardIndex): string | undefined {
  const home = homeIn(index, claim);
  return isClaimed(home)
    ? `${claim.home} is held by ${runClaimOf(home)} — that run has already selected the tickets it will work through, so work hung under it now would ride along unrun`
    : undefined;
}

function homeUnderSubject(
  claim: PmClaimRehome,
  _subject: Bead,
  index: BoardIndex,
): string | undefined {
  return index.isAncestor(claim.bead, claim.home)
    ? `${claim.home} sits under ${claim.bead} — the move would make the subtree its own ancestor`
    : undefined;
}

function homeWrongTierForSubject(
  claim: PmClaimRehome,
  subject: Bead,
  index: BoardIndex,
): string | undefined {
  return homeWrongTier(subject, homeIn(index, claim), index, HOME_STANDING.snapshot);
}

// Last, so it never masks a stronger fault: a container epic and a `learning` are both naturally
// parentless, and each is refused above for the reason it will still be refused for once somebody
// gives it a home — the taxonomy names no home for it at all.
//
// A `rehome` is a claim about a home that is WRONG; a FIRST home is the gardener's mechanical ask,
// and this pass is told to leave it alone. The context's "no run target carries this" section says
// so for the work IT covers — but a parentless task/bug is a RUN TARGET and renders as one, so
// nothing else here stops a claim that demotes a standalone run (often the most urgent bead on the
// board) into somebody else's child ticket, cancelling the run it would have had.
function subjectHasNoHome(claim: PmClaimRehome, subject: Bead): string | undefined {
  return beads.parentOf(subject)
    ? undefined
    : `${claim.bead} hangs under nothing — giving homeless work its first home is the gardener's proposal, not this pass's`;
}

// The rest of that ask, for work whose home is present but runs nothing: a ticket under a
// CONTAINER epic has a parent, so the bar above waves it through, yet no run target carries it —
// the loose section renders it under "work no run target carries" and tells the pass not to move
// it, because `detectContainerOrphans` proposes this exact move already. Filing it here too gives
// one move two fingerprints, so the founder who declined the gardener's ask meets it again under a
// pm id. Asked through `isRunTarget` — the same split the context was built on — so a card, whose
// owner is legitimately absent because it IS the run, still moves.
function noRunTargetCarriesSubject(
  claim: PmClaimRehome,
  subject: Bead,
  index: BoardIndex,
): string | undefined {
  const owner = ticketOwnerOf(index, subject);
  return !owner && !beads.isRunTarget(subject, index.all)
    ? `no run target carries ${claim.bead} — it hangs under ${beads.parentOf(subject)}, which runs nothing, so putting it where a run can reach it is the gardener's proposal, not this pass's`
    : undefined;
}

/**
 * The home `homeMissing` proved is on the board — held by every guard after it rather than looked
 * up again, for the same reason {@link subjectChecked} returns the bead it proved exists.
 */
function homeIn(index: BoardIndex, claim: PmClaimRehome): Bead {
  return index.byId.get(claim.home) as Bead;
}

/**
 * The bars a home claim clears, IN THE ORDER THEY RUN — the order is the behaviour, so it is pinned
 * by a test. Two properties it encodes: the subject's own bars come before the home's, so a claim
 * anton would refuse whatever home it named says so; and `homeMissing` precedes every guard that
 * reads the home, which is what lets those hold it rather than re-assert the lookup. The two
 * "which pass owns this ask" bars sit LAST so they never mask a stronger fault.
 */
export const REHOME_GUARDS: readonly Guard<PmClaimRehome>[] = [
  homeIsSubject,
  homeIsCurrentParent,
  homeAlreadyShipsSubject,
  subjectHeldByRun,
  subjectRidesOwnedCard,
  homeMissing,
  homeIsProposal,
  homeSettled,
  homeInFlight,
  homeClaimed,
  homeUnderSubject,
  homeWrongTierForSubject,
  subjectHasNoHome,
  noRunTargetCarriesSubject,
];

/** The detection one accepted claim becomes — the shape both emission and apply already speak. */
function detectionFor(claim: PmClaim): GardenerDetection {
  switch (claim.kind) {
    case "reprioritize":
      return makeDetection({
        kind: CLAIM_KINDS.reprioritize,
        move: "reprioritize",
        subjects: [claim.bead],
        detail: claim.priority,
        summary: claim.summary,
        evidence: claim.evidence,
      });
    case "order":
      return makeDetection({
        kind: CLAIM_KINDS.order,
        move: "link",
        subjects: [claim.bead],
        target: claim.blockedBy,
        summary: claim.summary,
        evidence: claim.evidence,
      });
    case "rehome":
      return makeDetection({
        kind: CLAIM_KINDS.rehome,
        move: "reparent",
        subjects: [claim.bead],
        // Always a target, never the gardener's targetless "which feature?" ask: the session that
        // makes a home claim has already named the home, and one without it never parses.
        target: claim.home,
        summary: claim.summary,
        evidence: claim.evidence,
      });
    case "split":
      return makeDetection({
        kind: CLAIM_KINDS.split,
        move: "split",
        subjects: [claim.bead],
        summary: claim.summary,
        // The sketch rides with the evidence because it IS part of the claim: a split proposal
        // without a decomposition asks a founder to do the thinking the pass was run to do.
        evidence: [
          ...claim.evidence,
          ...claim.pieces.map((piece, i) => `proposed ticket ${i + 1}: ${piece}`),
        ],
      });
    case "kill":
      return makeDetection({
        kind: CLAIM_KINDS.kill,
        move: "retire",
        retireAs: "defer",
        subjects: [claim.bead],
        summary: claim.summary,
        evidence: claim.evidence,
      });
  }
}
