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
import { CLAIM_KINDS, type PmClaim, type PmClaimOrder, type PmClaimRehome } from "./report";

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

/** Why this claim's own move cannot stand, or undefined. */
function kindRefusal(
  claim: PmClaim,
  subject: Bead,
  index: BoardIndex,
  nowMs: number,
): string | undefined {
  switch (claim.kind) {
    case "reprioritize":
      return subject.priority !== undefined && `P${subject.priority}` === claim.priority
        ? `${claim.bead} is already at ${claim.priority}`
        : undefined;
    case "order":
      return orderRefusal(claim, index);
    case "rehome":
      return rehomeRefusal(claim, subject, index, nowMs);
    // A deferred bead is still OPEN work, so `subjectChecked` waves it through — but a kill applies as
    // `defer`, and `planRetire` settles an already-deferred subject without writing anything. Left
    // unchecked the ask reaches the board, costs a founder a decision, and settles as a no-op. The
    // gardener's stale detector excludes deferred beads for this exact reason (gardener/retire.ts).
    case "kill":
      return beads.isDeferred(subject)
        ? `${claim.bead} is already deferred — killing it again would change nothing`
        : undefined;
    default:
      return undefined;
  }
}

/**
 * Why an ordering edge cannot be recorded — every reason bd or the graph would refuse it later.
 *
 * Checked here rather than left to approve time because an ask that can only ever fail is worse than
 * no ask: it sits on the board asking a founder to approve something anton will refuse, until
 * somebody declines it by hand (the anton-wsap failure mode).
 */
function orderRefusal(claim: PmClaimOrder, index: BoardIndex): string | undefined {
  const blockerId = claim.blockedBy;
  if (blockerId === claim.bead) return `${claim.bead} cannot block itself`;
  const blocker = index.byId.get(blockerId);
  if (!blocker) return `${blockerId} is not on the board`;
  // A proposal is open work, so `isOpenWork` waves it through — but it closes when the founder
  // approves or declines it, and the `blocks` edge outlives it. The subject would sit queue-blocked
  // behind an ask that no longer exists, with nothing left to land and unblock it.
  if (isProposalBead(blocker)) {
    return `${blockerId} is a proposal, not work — the edge would outlive it and leave ${claim.bead} blocked forever`;
  }
  if (!isOpenWork(blocker)) return `${blockerId} has already landed, so the edge would constrain nothing`;
  if (index.hasBlocksEdge(claim.bead, blockerId)) {
    return `the board already records an ordering between ${claim.bead} and ${blockerId}`;
  }
  // bd keeps ONE edge per directed pair and refuses a second type over it rather than replacing it.
  if (index.recordsDiscovery(claim.bead, blockerId) || index.recordsDiscovery(blockerId, claim.bead)) {
    return `${claim.bead} and ${blockerId} already carry a discovered-from edge, and bd keeps one edge per pair`;
  }
  if (index.isBlockedBy(blockerId, claim.bead)) {
    return `${blockerId} is already blocked by ${claim.bead} through other beads — the edge would close a cycle`;
  }
  return undefined;
}

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
  const homeId = claim.home;
  if (homeId === claim.bead) return `${claim.bead} cannot be its own home`;
  const currentHome = beads.parentOf(subject);
  if (currentHome === homeId) {
    return `${claim.bead} already hangs under ${homeId} — the move would write nothing`;
  }
  // The same no-op one tier out, and the one the context now invites: bd nesting runs to any depth,
  // so under `feature → task → subtask` the subtask already ships in the FEATURE's run and its PR,
  // and its line names that feature as `shipped by`. A claim citing that line proposes the card the
  // work already rides — which moves nothing between runs and only flattens nesting somebody meant.
  // A `rehome` is a claim that the work would ship in the WRONG card; here nothing is misfiled.
  const owner = ticketOwnerOf(index, subject);
  if (owner?.id === homeId) {
    return `${claim.bead} already ships under ${homeId} — it hangs inside that run's ticket set today, so the move would flatten nesting somebody meant rather than change what ships it`;
  }
  // The subject's half of "a run owns it". `subjectChecked` asks only `isInFlight`, which cannot see
  // a claim: a run working a ticket writes the assignee and `in_progress` onto it while the run-lease
  // lives on the CARD above, so the ticket reads as free work there. Moved out of that run's ticket
  // set, its commit lands in the old card's PR while the bead hangs off the new one, open and unrun.
  if (isClaimed(subject)) {
    return `${claim.bead} is held by ${runClaimOf(subject)} — that run is shipping it under its current home, so moving it now would leave the bead and the work it ships in two different places`;
  }
  // The rest of that half, and the one no per-bead signal can reach: a grouped run publishes ONE
  // lease, on the CARD its tickets hang under, and cascades an assignee only to the tickets it has
  // already reached. So a ticket that run has SELECTED but not yet started carries no lease and no
  // claim — both bars above read it as free work. Moving it out of that set now takes a bead out of
  // a set the run already chose, and the run aborts when its claim reaches it.
  if (owner && (isInFlight(owner, nowMs) || isClaimed(owner))) {
    return `${claim.bead} rides ${owner.id}'s ticket set and a run owns ${owner.id} — that run has already selected the tickets it will work through, so moving one out from under it now would abort it or strand the work it ships`;
  }
  const home = index.byId.get(homeId);
  if (!home) return `${homeId} is not on the board`;
  // A proposal is open work, so `isOpenWork` waves it through — but it is a bead ABOUT the board,
  // not part of its shape, and it closes the moment the founder answers it. Work hung under one
  // would be left beneath a settled ask nothing will ever run.
  if (isProposalBead(home)) return `${homeId} is a proposal, not a home`;
  if (!isOpenWork(home)) {
    return `${homeId} is already settled — hanging work under it would leave it riding a home nothing will run`;
  }
  // Both halves of "a run owns it": a published lease, and the pickup window before one exists. A run
  // that already selected the tickets it will work through would carry the newcomer along unrun.
  if (isInFlight(home, nowMs)) {
    return `${homeId} is mid-run — hanging work under it would race the run that owns it`;
  }
  if (isClaimed(home)) {
    return `${homeId} is held by ${runClaimOf(home)} — that run has already selected the tickets it will work through, so work hung under it now would ride along unrun`;
  }
  if (index.isAncestor(claim.bead, homeId)) {
    return `${homeId} sits under ${claim.bead} — the move would make the subtree its own ancestor`;
  }
  const wrongTier = homeWrongTier(subject, home, index, HOME_STANDING.snapshot);
  if (wrongTier) return wrongTier;
  // Last, so it never masks a stronger fault: a container epic and a `learning` are both naturally
  // parentless, and each is refused above for the reason it will still be refused for once somebody
  // gives it a home — the taxonomy names no home for it at all.
  //
  // A `rehome` is a claim about a home that is WRONG; a FIRST home is the gardener's mechanical ask,
  // and this pass is told to leave it alone. The context's "no run target carries this" section says
  // so for the work IT covers — but a parentless task/bug is a RUN TARGET and renders as one, so
  // nothing else here stops a claim that demotes a standalone run (often the most urgent bead on the
  // board) into somebody else's child ticket, cancelling the run it would have had.
  if (!currentHome) {
    return `${claim.bead} hangs under nothing — giving homeless work its first home is the gardener's proposal, not this pass's`;
  }
  // The rest of that ask, for work whose home is present but runs nothing: a ticket under a
  // CONTAINER epic has a parent, so the bar above waves it through, yet no run target carries it —
  // the loose section renders it under "work no run target carries" and tells the pass not to move
  // it, because `detectContainerOrphans` proposes this exact move already. Filing it here too gives
  // one move two fingerprints, so the founder who declined the gardener's ask meets it again under a
  // pm id. Asked through `isRunTarget` — the same split the context was built on — so a card, whose
  // owner is legitimately absent because it IS the run, still moves.
  if (!owner && !beads.isRunTarget(subject, index.all)) {
    return `no run target carries ${claim.bead} — it hangs under ${currentHome}, which runs nothing, so putting it where a run can reach it is the gardener's proposal, not this pass's`;
  }
  return undefined;
}

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
