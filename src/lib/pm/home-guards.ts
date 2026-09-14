/**
 * Every bar a HOME claim clears before anton files it (anton-02po): each reason apply would refuse
 * the move later, asked at filing time for the same reason `order-guards.ts` asks its own — an ask
 * that can only ever fail sits on the board asking a founder to approve something anton will refuse,
 * until somebody declines it by hand (the anton-wsap failure mode).
 *
 * The tier bar is asked through apply's own {@link homeWrongTier} rather than a copy of it, so the
 * filing check and the approve check cannot disagree about which homes the taxonomy allows — a
 * ticket hangs off the card that runs it, a card off the container epic that groups it.
 */
import { beads, type Bead } from "../beads/bd";
import { homeWrongTier, HOME_STANDING } from "../gardener/apply-plan";
import {
  isClaimed,
  isInFlight,
  isOpenWork,
  runClaimOf,
  ticketOwnerOf,
  type BoardIndex,
} from "../gardener/board-index";
import { isProposalBead } from "../gardener/detections";
import { firstRefusal, type Guard } from "./guard";
import type { PmClaimRehome } from "./report";

/** Why this bead cannot be hung under the home the claim names, or undefined. */
export function rehomeRefusal(
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

// The subject's half of "a run owns it". The shared subject bars ask only `isInFlight`, which
// cannot see a claim: a run working a ticket writes the assignee and `in_progress` onto it while the
// run-lease lives on the CARD above, so the ticket reads as free work there. Moved out of that run's
// ticket set, its commit lands in the old card's PR while the bead hangs off the new one, open and
// unrun.
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
 * up again, for the same reason the shared subject bars return the bead they proved exists.
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
