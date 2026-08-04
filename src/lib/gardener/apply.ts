/**
 * APPLY-ON-APPROVE (anton-1t3n): the half of the gardener that changes the board. A proposal that
 * nobody can act on is a report line with extra steps, so this is where approval stops being a label
 * and becomes `bd update --parent` / `bd link` / `bd supersede` / `bd close --reason` / `bd defer`.
 *
 * Three properties carry the module, and each answers a way apply could do harm:
 *
 *   • THE PLAN IS DATA, NOT PROSE. The move rides on the proposal bead as metadata, written in the
 *     same `bd create` (see emit.ts). Nothing here parses a description: a human is free to edit the
 *     ask's wording, and an apply that re-derived the move from that wording would mutate beads the
 *     approver never read about.
 *   • THE BOARD DECIDES, NOT THE PLAN. Every precondition is re-checked against a FRESH board read
 *     at approve time, because a proposal filed last night describes a board that has since moved.
 *     That includes the bar every detector proposes under — work a run owns is off limits — since
 *     the run that now holds the bead usually started AFTER the proposal was filed. Stale plans
 *     refuse loudly; a board that already reads as applied SETTLES the proposal instead of writing
 *     again — re-confirmed under the affected beads' own locks, because that path runs no step and
 *     so has nothing else to re-read them — and a retry after a half-finished approve therefore
 *     converges rather than double-moves. And
 *     because a snapshot is stale the instant it is taken, every bead a write rests on — the subject,
 *     the home/blocker/survivor it points at, and the run target whose ticket set a retirement would
 *     take it out of — is re-read and re-judged under its own write lock
 *     immediately before the write, on the same lock a run's claim takes (see `applyStep`), so a
 *     lease published mid-approval orders against this apply instead of racing it. A fresh read is
 *     not the whole answer either: it shows the board as it IS, never as it MOVED. So the two facts
 *     it cannot express — that the bead's claim is the one the plan was made about, and that a
 *     `stale` subject really has stayed silent — are settled against the PROPOSAL's own filing
 *     stamp, the one filing-time fact bd already keeps and no hand-edited plan can rewrite.
 *   • NO PARTIAL SILENT STATE. The only multi-write move is a cluster re-parent, and its steps carry
 *     their own undo: a failure part-way rolls the applied prefix back and leaves the proposal OPEN
 *     with the error attached as a note. Applying a proposal is serialized on the PROPOSAL's own
 *     lock for the same reason, so a second approve can't be part-way through the same steps while
 *     this one rolls them back or declares them done. What a reader must never find is a board
 *     half-moved and a proposal reading as done.
 *
 * Declining is the other half of the loop and needs no store of its own: a declined proposal is an
 * ABANDONED bead (closed + `abandoned`) still carrying its fingerprint label, which is exactly what
 * emission already suppresses on (see emit.ts `suppressedFingerprints`). The board is the memory.
 */
import { beads, LABELS, type Bead } from "../beads/bd";
import { withBeadWriteLock, withBeadWriteLocks } from "../beads/claim-lock";
import { loadAllIssues } from "../beads/issues";
import {
  indexBoard,
  isInFlight,
  isOpenWork,
  runClaimOf,
  stampMsOf,
  ticketOwnerOf,
  type BoardIndex,
} from "./board-index";
import {
  fingerprintLabelOf,
  GARDENER_OBSERVED_AT_KEY,
  isProposalBead,
  proposalPlanOf,
  type GardenerDetectionKind,
  type GardenerPlan,
} from "./detections";
import { impliesOrdering } from "./relink";

/** The `notes` prefix every gardener apply writes under — one line, like anton's other job notes. */
const NOTE_PREFIX = "gardener";

/** What every step carries about the bead it writes to, whatever the verb. */
interface StepSubject {
  id: string;
  /**
   * The run claim the subject carried when this step was DECIDED, or `""` for none — captured like
   * `undoParent`, and re-compared under the write lock (see {@link subjectMoved}).
   *
   * It exists because a claim is not visible as in-flight for its first moments: `beads.claimVerified`
   * writes the assignee and `in_progress` first and publishes the run-lease afterwards, so a bead in
   * that window reads as unowned work to {@link isInFlight}. A pickup serializes on the same per-bead
   * chain this apply locks, so without capturing the claim the apply takes the claim protocol's own
   * lock and then ignores what the claim wrote.
   */
  claim: string;
}

/** One board write an approved proposal resolves to, with whatever it takes to undo it. */
export type ApplyStep =
  | (StepSubject & {
      verb: "reparent";
      parent: string;
      /** The parent to restore on rollback; `""` is bd's detach form, for a bead that had none. */
      undoParent: string;
      /**
       * The run claim the HOME carried when this step was decided, or `""` — {@link StepSubject.claim}
       * for the other end of the move, re-compared under the home's own write lock.
       *
       * Same blind spot as the subject's, and worse consequences: a run that claimed the home in the
       * window before its lease is published reads as unowned to {@link isInFlight}, and it has
       * already selected the tickets it will work through — so work attached now rides along unrun
       * and is stranded the moment that run settles the card.
       *
       * Only ever a claim that PREDATES the filing: `planReparent` refuses a home claimed since (see
       * {@link claimedSinceFiling}), which is what stops a newcomer's claim from being recorded here
       * as its own baseline and then compared against itself under the lock.
       */
      parentClaim: string;
    })
  | (StepSubject & { verb: "link"; blocker: string })
  | (StepSubject & TicketOwner & RetireEvidence & { verb: "close"; reason: string })
  | (StepSubject & TicketOwner & RetireEvidence & { verb: "supersede"; replacement: string })
  | (StepSubject & TicketOwner & RetireEvidence & { verb: "defer" });

/**
 * What a RETIREMENT's evidence rests on, carried forward so the locked re-read can re-ask it — the
 * {@link StepSubject.claim} treatment for the one precondition no board read re-derives.
 *
 * Every other bar a retirement holds its subject to is a fact about the board's CURRENT shape:
 * status, liveness, claim, ticket set, open descendants. The premise is not — it is "nobody has
 * rewritten this bead since the patrol read it" ({@link premiseTouched}), and `planRetire` asks it
 * of the route's snapshot, which is already seconds old when the first bd write spawns. An edit
 * landing in that window rescopes the work while leaving every other bar untouched, so without this
 * the close/defer/supersede goes ahead on evidence the edit falsified.
 *
 * The kind (not the resolved premise) so the write re-derives through the same `RETIRE_PREMISE` the
 * decision used, and the observation stamp verbatim so both readings date against the same fence.
 * Unlike the topology re-checks, this one is a NARROWING rather than a serialization: an operator's
 * `bd update` takes no in-process lock, so the window it closes is snapshot→lock, not lock→write.
 */
interface RetireEvidence {
  /** The detection kind whose premise this rests on — {@link RETIRE_PREMISE}'s key. */
  kind: GardenerDetectionKind;
  /** The moment the patrol observed the board — {@link ApplyMoment.observedAtMs}, carried as-is. */
  observedAtMs: number | undefined;
}

/**
 * The run target whose TICKET SET a retirement's subject rides, or absent when the subject is its
 * own run target — its own claim is then the check — or hangs under nothing that runs.
 *
 * Carried by the retirement verbs alone because they are the ones that take the bead AWAY: a run
 * that has selected this ticket aborts when its claim reaches a bead the board has since closed,
 * deferred or superseded. The run target is where the only liveness signal lives (see
 * {@link ticketOwnerOf}), so it is locked and re-judged alongside the subject.
 *
 * `claim` is the owner's run claim when the step was decided, re-compared under the owner's own
 * write lock exactly like {@link StepSubject.claim} — and, like a re-parent's `parentClaim`, only
 * ever a claim that PREDATES the filing, because `planRetire` refuses an owner claimed since.
 */
interface TicketOwner {
  owner?: { id: string; claim: string };
}

/**
 * What approving this proposal means against the board AS IT NOW IS:
 *   • `apply`  — these writes, in this order.
 *   • `settled` — the board already reads as applied (someone did it by hand, or a previous approve
 *     landed its writes and failed before closing the proposal). Nothing to write; the proposal
 *     still closes, which is what makes a retry converge instead of re-applying.
 *   • `refuse` — a precondition the plan rests on is no longer true. Nothing is written at all.
 */
export type ApplyDecision =
  | { status: "apply"; steps: ApplyStep[]; summary: string }
  | { status: "settled"; summary: string }
  | { status: "refuse"; reason: string };

/**
 * The two moments an approval sits between: when the patrol OBSERVED the board its evidence
 * describes, and NOW, the board the writes would land on. Both are needed because a precondition
 * re-checked only against the approval's fresh snapshot is blind to everything that moved BEFORE
 * that snapshot was taken: the plan carries no state of its own to compare against, so the
 * observation stamp is what dates a change as "since we asked".
 */
export interface ApplyMoment {
  /** When the approval is being decided. */
  nowMs: number;
  /**
   * When the detection READ the board — see {@link observedAtOf}, which is deliberately not the
   * proposal's creation stamp. Undefined FAILS CLOSED wherever it is read: with nothing to date a
   * change against, we cannot prove the board still reads as the approver was shown.
   */
  observedAtMs: number | undefined;
}

/**
 * Decide a plan against a board, writing nothing. Pure, so every precondition — the ones that
 * protect other people's beads — is testable from a fixture board rather than a live one.
 *
 * The board is read through the SAME `indexBoard` the detectors use: parentage, card attribution and
 * `blocks` edges have to mean one thing on both halves of the loop, or a proposal could be filed
 * under one answer and applied under another.
 *
 * Two classes of precondition run here. SAFETY — is this bead free to write to — and PREMISE: is the
 * board still the one the detector judged? The second exists because approval can come days after
 * filing, and a proposal whose premise has been fixed by hand (an orphan re-homed, a stale bead
 * picked back up) would otherwise apply a move for a problem that no longer exists — undoing the fix
 * instead of the fault. Premise is re-derived from `plan.kind`, which the fingerprint binds, rather
 * than from filing-time state the plan would have to carry.
 */
export function planApply(plan: GardenerPlan, board: Bead[], at: ApplyMoment): ApplyDecision {
  const index = indexBoard(board);
  switch (plan.move) {
    case "reparent":
      return planReparent(plan, index, at);
    case "link":
      return planLink(plan, index, at);
    case "retire":
      return planRetire(plan, index, at);
  }
}

function planReparent(plan: GardenerPlan, index: BoardIndex, at: ApplyMoment): ApplyDecision {
  const { nowMs } = at;
  // A container-orphan detection with no single obvious home deliberately files WITHOUT a target —
  // it asks the approver to pick one. Approving it as-is would have to invent that answer.
  if (!plan.target) {
    return {
      status: "refuse",
      reason: `this proposal names no new parent — it asks for a home to be chosen, so re-parent ${plan.subjects.join(", ")} by hand and decline it`,
    };
  }
  const target = index.byId.get(plan.target);
  if (!target) return { status: "refuse", reason: missing(plan.target) };
  // The home's own state — settled, or owned by a run. Shared with the under-lock re-check in
  // `applyStep`, so the snapshot decision and the write refuse the same home for the same reason.
  const homeGone = homeUnusable(target, nowMs);
  if (homeGone) return { status: "refuse", reason: homeGone };
  // The home's half of the claim window no liveness signal covers — and the check the step's
  // `parentClaim` baseline rests on. A run that picked the target up AFTER the filing reads as free
  // to `homeUnusable`, so without this the step would record that newcomer's claim as its own
  // baseline and the under-lock re-check ({@link homeClaimed}) would compare it against itself and
  // wave the move through, hanging tickets under a run that has already chosen what it will run.
  const homeTaken = claimedSinceFiling(target, at, "hanging work under it", CLAIM_COST.home);
  if (homeTaken) return { status: "refuse", reason: homeTaken };
  // The same bar the detector proposes against: a home must be a BOARD CARD, or the move recreates
  // the very state (work riding no card) the proposal exists to fix.
  if (!index.cards.ids.has(plan.target)) {
    return {
      status: "refuse",
      reason: `${plan.target} is not a board card — re-parenting under it would leave the work riding no card, which is the state this proposal is about`,
    };
  }

  const steps: ApplyStep[] = [];
  for (const id of plan.subjects) {
    const subject = index.byId.get(id);
    if (!subject) return { status: "refuse", reason: missing(id) };
    const currentParent = beads.parentOf(subject);
    if (currentParent === plan.target) continue; // already where the proposal wants it
    if (!isOpenWork(subject)) {
      return {
        status: "refuse",
        reason: `${id} is ${settledWord(subject)} — the board moved on since this was proposed`,
      };
    }
    if (isInFlight(subject, nowMs)) {
      return { status: "refuse", reason: inFlightReason(subject, nowMs, "moving it") };
    }
    const claimed = claimedSinceFiling(subject, at, "moving it", CLAIM_COST.subject);
    if (claimed) return { status: "refuse", reason: claimed };
    const rehomed = reparentPremiseGone(plan, subject, index);
    if (rehomed) return { status: "refuse", reason: rehomed };
    // A parent that sits UNDER one of the subjects would make the subtree its own ancestor.
    if (index.isAncestor(id, plan.target)) {
      return {
        status: "refuse",
        reason: `${plan.target} sits under ${id} — re-parenting it there would make the subtree its own ancestor`,
      };
    }
    steps.push({
      verb: "reparent",
      id,
      claim: runClaimOf(subject),
      parent: plan.target,
      undoParent: currentParent ?? "",
      parentClaim: runClaimOf(target),
    });
  }

  if (steps.length === 0) {
    const sit = plan.subjects.length === 1 ? "sits" : "sit";
    return { status: "settled", summary: `${list(plan.subjects)} already ${sit} under ${plan.target}` };
  }
  return {
    status: "apply",
    steps,
    summary: `re-parented ${list(steps.map((s) => s.id))} under ${plan.target}`,
  };
}

function planLink(plan: GardenerPlan, index: BoardIndex, at: ApplyMoment): ApplyDecision {
  const { nowMs } = at;
  const [id] = plan.subjects;
  if (plan.subjects.length !== 1 || !id) {
    return { status: "refuse", reason: "a link proposal names exactly one blocked bead" };
  }
  if (!plan.target) return { status: "refuse", reason: "this proposal names no blocker to record" };

  const blocked = index.byId.get(id);
  const blocker = index.byId.get(plan.target);
  if (!blocked) return { status: "refuse", reason: missing(id) };
  if (!blocker) return { status: "refuse", reason: missing(plan.target) };

  // The edge the proposal asked for is already drawn: the ordering is recorded, so there is nothing
  // to write and the ask is answered.
  if (index.recordsBlocker(id, plan.target)) {
    return { status: "settled", summary: `a blocks edge already records ${plan.target} → ${id}` };
  }
  // The OPPOSITE edge is not this ask half-done — it is someone's explicit decision that the ordering
  // runs the other way, made after this was filed. Settling on it would close the proposal claiming
  // an edge the board does not hold, and writing ours would fight the human who drew theirs. Refuse,
  // and let them re-decide against the contradiction.
  if (index.hasBlocksEdge(id, plan.target)) {
    return {
      status: "refuse",
      reason: `the board records the opposite ordering — ${id} blocks ${plan.target} — which is someone's explicit decision; recording ${plan.target} as ${id}'s blocker would contradict it`,
    };
  }
  if (!isOpenWork(blocked)) {
    return {
      status: "refuse",
      reason: `${id} is ${settledWord(blocked)} — an ordering edge would constrain nothing`,
    };
  }
  // Shared with the under-lock re-check in `applyStep` for the same reason the home bar is.
  const blockerGone = blockerUnusable(blocker, id);
  if (blockerGone) return { status: "refuse", reason: blockerGone };
  // Only the blocked bead is written to, and a run is executing it right now: recording an ordering
  // edge against it would tell every other reader that live work is waiting on something.
  if (isInFlight(blocked, nowMs)) {
    return { status: "refuse", reason: inFlightReason(blocked, nowMs, "recording it as blocked") };
  }
  const claimed = claimedSinceFiling(blocked, at, "recording it as blocked", CLAIM_COST.subject);
  if (claimed) return { status: "refuse", reason: claimed };
  const unstated = linkPremiseGone(plan, id, index);
  if (unstated) return { status: "refuse", reason: unstated };
  // The blocker already waits on the blocked bead through other beads: no direct edge, so the pair
  // read as unrelated above, but this edge would close the loop — and bd rejects a blocking cycle at
  // every write path, so applying it would only 500 and leave the proposal open forever.
  if (index.isBlockedBy(plan.target, id)) {
    return {
      status: "refuse",
      reason: `${plan.target} is already blocked by ${id} through other beads — recording ${plan.target} as ${id}'s blocker would close a dependency cycle, which bd refuses to write`,
    };
  }

  return {
    status: "apply",
    steps: [{ verb: "link", id, claim: runClaimOf(blocked), blocker: plan.target }],
    summary: `recorded that ${plan.target} blocks ${id}`,
  };
}

function planRetire(plan: GardenerPlan, index: BoardIndex, at: ApplyMoment): ApplyDecision {
  const { nowMs } = at;
  const [id] = plan.subjects;
  if (plan.subjects.length !== 1 || !id) {
    return { status: "refuse", reason: "a retirement proposal names exactly one bead" };
  }
  const subject = index.byId.get(id);
  if (!subject) return { status: "refuse", reason: missing(id) };
  // Already settled by whatever means: the outcome the proposal wanted is the board's state, so
  // there is nothing to write and no reason to keep asking. An ABANDONED bead counts even in the
  // "open + abandoned" state a crashed abandon can leave — retiring it with `close` would turn a
  // recorded won't-do into work that reads as shipped, which is the one lie retirement must not tell.
  if (subject.status === "closed" || beads.isAbandoned(subject)) {
    // …except a SUPERSEDE, whose outcome is narrower than "settled": it records where the work
    // landed, and only the `supersedes` edge carries that answer. A subject closed or abandoned by
    // other means since the filing has no such edge, so settling here would close the ask as
    // answered while its one product — the pointer at the survivor — was never written.
    if (plan.retireAs === "supersede") {
      if (!plan.target) return { status: "refuse", reason: NO_SURVIVOR };
      if (!index.recordsSupersedes(id, plan.target)) {
        return {
          status: "refuse",
          reason: `${id} is ${settledWord(subject)}, but nothing on the board records it as superseded by ${plan.target} — it settled by other means, so this proposal's answer to "where did the work go" was never written; decline it, and supersede by hand if that is still the record you want`,
        };
      }
      return { status: "settled", summary: `${id} is already superseded by ${plan.target}` };
    }
    return { status: "settled", summary: `${id} is already ${settledWord(subject)}` };
  }
  if (plan.retireAs === "defer" && beads.isDeferred(subject)) {
    return { status: "settled", summary: `${id} is already deferred` };
  }
  // Nothing left to settle, so from here every branch WRITES — and a bead a run owns is the one
  // thing retirement must not write to. Closing or deferring work an agent is mid-flight over would
  // pull the bead out from under the run that is shipping it.
  if (isInFlight(subject, nowMs)) {
    return { status: "refuse", reason: inFlightReason(subject, nowMs, "retiring it") };
  }
  const claimed = claimedSinceFiling(subject, at, "retiring it", CLAIM_COST.subject);
  if (claimed) return { status: "refuse", reason: claimed };
  // The subject's own signals are only half the question. A grouped run publishes ONE lease, on the
  // run target its tickets hang under, so a ticket that run has selected but not yet reached carries
  // no lease, no PR ref and no claim of its own — retiring it would take a bead out of a live run's
  // ticket set, and the run aborts when its claim reaches a bead the board no longer holds. Asked of
  // the OWNER by the same two bars the subject answers to: is a run live on it, and was it claimed
  // in the window before a lease exists to see (see `claimedSinceFiling`).
  const owner = ticketOwnerOf(index, subject);
  if (owner) {
    const doing = retiringTicket(id);
    if (isInFlight(owner, nowMs)) {
      return { status: "refuse", reason: inFlightReason(owner, nowMs, doing) };
    }
    const ownerClaimed = claimedSinceFiling(owner, at, doing, CLAIM_COST.ticketSet);
    if (ownerClaimed) return { status: "refuse", reason: ownerClaimed };
  }
  // Every retirement rests on a claim about the subject AS THE PATROL FOUND IT (retire.ts), and that
  // is the one thing a fresh board read cannot confirm: it shows the bead as it IS, never as it was
  // edited. Re-confirmed against the filing stamp so approving a months-old ask cannot settle a bead
  // that has since been written out from under its own evidence.
  const touched = premiseTouched(subject, RETIRE_PREMISE[plan.kind], at.observedAtMs);
  if (touched) return { status: "refuse", reason: touched };
  // Settling a bead that still has open work under it strands that work: the children stay in the
  // ready set with a parent no run will ever reach — the unreachable state `detectContainerOrphans`
  // exists to flag, arrived at by approving a proposal. Only the SETTLING verbs are barred; `defer`
  // parks the subtree with its contract intact and is undone by reopening the parent.
  if (plan.retireAs === "close" || plan.retireAs === "supersede") {
    const open = index.openDescendants(id);
    if (open.length > 0) {
      return {
        status: "refuse",
        reason: `${id} still has open work under it (${namesSome(open.map((b) => b.id))}) — settling it would strand that work beneath a card nothing will run; close or retire the children first`,
      };
    }
  }

  // Whatever the verb, the write rests on the same two beads: the subject, and the run target whose
  // ticket set it rides (absent when it rides none). Both are re-read under their own locks, and so
  // is the premise the checks above just cleared (see {@link RetireEvidence}).
  const on = {
    id,
    claim: runClaimOf(subject),
    owner: owner ? { id: owner.id, claim: runClaimOf(owner) } : undefined,
    kind: plan.kind,
    observedAtMs: at.observedAtMs,
  };

  switch (plan.retireAs) {
    case "close":
      return {
        status: "apply",
        steps: [{ verb: "close", ...on, reason: closeReason(plan) }],
        summary: `closed ${id} as shipped`,
      };
    case "defer":
      return {
        status: "apply",
        steps: [{ verb: "defer", ...on }],
        summary: `deferred ${id} out of the ready set`,
      };
    case "supersede": {
      if (!plan.target) return { status: "refuse", reason: NO_SURVIVOR };
      const survivor = index.byId.get(plan.target);
      if (!survivor) return { status: "refuse", reason: missing(plan.target) };
      const survivorGone = survivorUnusable(survivor, id);
      if (survivorGone) return { status: "refuse", reason: survivorGone };
      // The other end of the same premise: `survivorUnusable` asks only whether the survivor still
      // reads as landed work, which a rewrite leaves untouched.
      const survivorTouched = premiseTouched(
        survivor,
        RETIRE_PREMISE[plan.kind]?.twin,
        at.observedAtMs,
      );
      if (survivorTouched) return { status: "refuse", reason: survivorTouched };
      return {
        status: "apply",
        steps: [{ verb: "supersede", ...on, replacement: plan.target }],
        summary: `closed ${id} as superseded by ${plan.target}`,
      };
    }
    default:
      return { status: "refuse", reason: `unknown retirement verb "${plan.retireAs}"` };
  }
}

/**
 * Has this bead been written to since the patrol observed the board? `undefined` when either stamp
 * is unreadable — the honest answer when there is nothing to compare, which every caller fails
 * closed on.
 *
 * bd stamps at ONE-SECOND resolution, so an EQUAL stamp orders nothing: the write may have landed
 * before the observation or after it, and the two readings mean opposite things here. It is answered
 * `undefined` — the same fail-closed "we cannot tell" a missing stamp gets — rather than `false`,
 * because `false` is a positive claim that the plan already saw this write, and nothing downstream
 * re-asks it: the step records exactly that state as its own baseline ({@link StepSubject.claim})
 * and the under-lock re-check then compares it against itself. {@link observedAtOf} floors the fence
 * to the same one-second grid so that tie is reachable at all.
 */
function writtenSinceFiling(subject: Bead, observedAtMs: number | undefined): boolean | undefined {
  const writtenAt = stampMsOf(subject);
  if (observedAtMs === undefined || writtenAt === undefined) return undefined;
  if (writtenAt === observedAtMs) return undefined;
  return writtenAt > observedAtMs;
}

/**
 * What a claim taken since the filing costs, per END of the move. The subject is written to, so its
 * run loses the bead out from under it; a re-parent's HOME is not written to at all — there the
 * damage is to the work being attached, which a run that has already selected its tickets will
 * never pick up.
 */
const CLAIM_COST = {
  subject: "would pull the bead out from under the run that owns it",
  home: "would leave that work riding along unrun, because the run has already selected the tickets it will work through",
  ticketSet:
    "would take a bead out of a set that run has already selected, and it aborts when its claim reaches a ticket the board no longer holds",
} as const;

/**
 * Why a run claim taken SINCE the proposal was filed bars this move, or undefined. Asked of BOTH
 * ends of a move — the bead being written to and the home it would be attached under — because the
 * blind spot below is a property of the claim, not of which side of the move the bead sits on.
 *
 * {@link isInFlight} is blind to a pickup for longer than it looks: `beads.claimVerified` writes the
 * assignee and `in_progress` first and publishes the run-lease afterwards, and a grouped run's child
 * tickets never carry a lease of their own at all — the lease lives on the target they hang under.
 * So "a run owns this right now" can be true while every liveness signal reads free.
 *
 * What separates that from the DEAD claim a retirement proposal is usually about is not the claim's
 * shape but its age: a claim written after the patrol filed is news the approver was never shown,
 * while one already there at filing is the very thing being proposed against ({@link StepSubject}
 * carries it forward as the step's baseline).
 */
function claimedSinceFiling(
  subject: Bead,
  at: ApplyMoment,
  doing: string,
  cost: string,
): string | undefined {
  const claim = runClaimOf(subject);
  if (!claim) return undefined;
  const since = writtenSinceFiling(subject, at.observedAtMs);
  if (since === false) return undefined; // the claim the plan was made against, not a newer one
  const dated =
    since === undefined
      ? "nothing dates that claim against this proposal's filing"
      : "it was claimed since this proposal was filed";
  return `${subject.id} is held by ${claim} and ${dated} — ${doing} ${cost}; decline it and act by hand if the claim is dead`;
}

/**
 * Why the subject no longer has the parent shape its detection was based on, or undefined. Both
 * re-parent kinds rest on one claim about where the bead sits — NO BOARD CARD CARRIES IT, whether it
 * hangs off a container epic (`container-orphan`) or off nothing at all (`parentless-cluster`) — so
 * that claim is re-derived from the fresh board rather than from a filing-time parent the plan would
 * have to carry.
 *
 * A bead somebody has since given a card has already been answered, by a decision newer than the one
 * being approved. Nothing downstream can object on its own: the step records that newer parent as
 * its own `undoParent`, and the under-lock re-check compares against that same value. Judged on the
 * CARD rather than the raw parent because that is what the move is for — a bead moved under another
 * container is still as unreachable as the proposal says, and re-homing it is still the fix.
 */
function reparentPremiseGone(
  plan: GardenerPlan,
  subject: Bead,
  index: BoardIndex,
): string | undefined {
  const card = index.cards.cardOf(subject);
  if (!card) return undefined;
  return `${subject.id} now rides board card ${card} — it was given a home since this proposal was filed, so moving it under ${plan.target} would overwrite that newer decision`;
}

/**
 * Why the board no longer states the ordering this link proposal read, or undefined. An
 * `implied-order` ask rests on exactly one piece of evidence — a body phrase or a `discovered-from`
 * edge — and unlike a status or a parent, no other bar reads it: the step carries only the pair, and
 * every remaining check asks whether the two beads are writable, never whether the ordering is still
 * stated anywhere.
 *
 * So a phrase edited out or an edge dropped since the filing would otherwise apply anyway, restoring
 * an ordering a newer board edit explicitly removed and taking the blocked bead back out of the ready
 * set that edit put it in. Re-derived from the fresh board through the detector's own reader (see
 * `relink.ts` {@link impliesOrdering}), so approval cannot hold the premise to a laxer bar than the
 * patrol held it to — and re-derived once more from a read taken under the pair's own write locks
 * ({@link assertOrderingStated}), because this snapshot is stale by the time the write spawns.
 */
function linkPremiseGone(
  plan: GardenerPlan,
  blockedId: string,
  index: BoardIndex,
): string | undefined {
  if (plan.kind !== "implied-order" || !plan.target) return undefined;
  if (impliesOrdering(index, blockedId, plan.target)) return undefined;
  return orderingUnstated(blockedId, plan.target);
}

/** What a retirement's evidence says a bead still IS, and what retiring against it anyway gets wrong. */
interface RetirePremise {
  /** The bead the evidence describes — read as "still …". */
  still: string;
  /** The harm of retiring against a bead that is no longer it — read as "and …". */
  harm: string;
  /**
   * The same claim about the bead the plan POINTS AT, for evidence that is a MATCH BETWEEN TWO beads
   * rather than a fact about the subject alone. Absent where the ask rests on the subject only —
   * `stale` measures silence and `shipped-orphan` a commit, and neither names a live counterpart.
   */
  twin?: RetirePremise;
}

/**
 * What each detection claims about the subject AS THE PATROL FOUND IT — the one premise a plan cannot
 * restate, because it is a fact about a moment rather than about the board now. Every kind is listed
 * so adding one without deciding whether an edit falsifies it is a type error; the re-parent and link
 * kinds carry no entry because their whole claim IS re-derivable from the fresh board (see
 * {@link reparentPremiseGone} and {@link linkPremiseGone}).
 *
 * All three retirements are fenced, not just `stale`: each measured something about the bead's
 * CONTENTS that an edit since the filing can invalidate — silence for `stale`, a match against a
 * closed twin for `superseded`, a match against the commit that delivered it for `shipped-orphan`.
 * A commit is immutable, but the bead it shipped is not: work added after it landed would be settled
 * as delivered. Refusing is loud and a human re-decides; settling a rescoped bead loses that work
 * silently.
 */
const RETIRE_PREMISE: Record<GardenerDetectionKind, RetirePremise | undefined> = {
  "container-orphan": undefined,
  "parentless-cluster": undefined,
  "implied-order": undefined,
  stale: {
    still: "the untouched bead the ask describes",
    harm: "deferring it now would park work somebody has since picked back up",
  },
  superseded: {
    still: "the bead whose contents matched the twin this supersede points at",
    harm: "retiring it against that twin now would settle work that may have moved past it",
    // The match is symmetric, so an edit to EITHER end falsifies it — and the survivor's end is the
    // dangerous one: it stays closed and non-abandoned however far its contents drift, so nothing
    // else here notices, and superseding onto a twin that no longer holds the work would close the
    // last live copy of it.
    twin: {
      still: "the landed twin whose contents this bead matched",
      harm: "superseding onto it now could retire the only copy of that work still open",
    },
  },
  "shipped-orphan": {
    still: "the bead the commit behind this ask shipped",
    harm: "closing it as shipped now would record a landing for work that may have been rescoped since",
  },
};

/**
 * Why this bead is no longer the one its retirement proposal describes, or undefined — asked of the
 * SUBJECT under the kind's own premise, and of a supersede's survivor under that premise's
 * {@link RetirePremise.twin}. `undefined` premise means the ask makes no filing-time claim about
 * this bead, so nothing here can go stale.
 *
 * Confirmed against the moment the patrol looked rather than by re-deriving the detection, because
 * "has anyone touched it since we asked" is the question the approver's evidence actually rests on —
 * and it is the only half of that evidence a board read can answer at all.
 *
 * Asked TWICE per retirement: once by `planRetire` against the route's snapshot, and again against
 * the re-read taken under the bead's own write lock (see {@link RetireEvidence}), because an edit
 * landing between those two moments leaves every other bar the write holds untouched.
 */
function premiseTouched(
  bead: Bead,
  premise: RetirePremise | undefined,
  observedAtMs: number | undefined,
): string | undefined {
  if (!premise) return undefined;
  const since = writtenSinceFiling(bead, observedAtMs);
  if (since === false) return undefined;
  return since === undefined
    ? `${bead.id} carries no write stamp this proposal's filing can be ordered against, so nothing confirms it is still ${premise.still}`
    : `${bead.id} has been written to since this proposal was filed — it is no longer ${premise.still}, and ${premise.harm}`;
}

/** Why a proposal could not be applied — mapped to a status by the route, never swallowed. */
export type ApplyFailure =
  /** The bead is not an applicable proposal (not one at all, no readable plan, already settled). */
  | "unusable"
  /** Preconditions no longer hold. Nothing was written; a human re-decides. */
  | "refused"
  /** A bd write failed mid-flight. Whatever landed was rolled back; the proposal stays open. */
  | "failed";

export class ProposalApplyError extends Error {
  constructor(
    readonly failure: ApplyFailure,
    message: string,
  ) {
    super(message);
    this.name = "ProposalApplyError";
  }
}

export interface ApplyResult {
  proposalId: string;
  plan: GardenerPlan;
  /** One line naming what changed — the proposal's close reason and its closing note. */
  summary: string;
  /** The beads this apply actually wrote to. Empty when the board already read as applied. */
  changed: string[];
}

/**
 * Apply an approved proposal and close it with a note of what changed.
 *
 * `board` is the caller's FRESH `--status all` read (the approve route forces one before it decides
 * anything): every precondition is judged against it, so a proposal filed against a board that has
 * since moved refuses instead of acting on last night's picture.
 *
 * Throws {@link ProposalApplyError} on every failure — and attaches the reason to the proposal as a
 * note first, so the bead a human comes back to says why it is still open. The one thing this never
 * does is close a proposal whose move did not land.
 */
export async function applyProposal(
  repo: string,
  proposal: Bead,
  board: Bead[],
): Promise<ApplyResult> {
  if (!isProposalBead(proposal)) {
    throw new ProposalApplyError("unusable", `${proposal.id} is not a gardener proposal`);
  }
  if (proposal.status === "closed") {
    throw new ProposalApplyError(
      "unusable",
      `${proposal.id} is already settled — a proposal is applied or declined once`,
    );
  }
  const plan = proposalPlanOf(proposal);

  // The WHOLE application — decide, write every step, settle — runs under the proposal's own write
  // lock, not just its closing write. A cluster re-parent releases each subject's lock between
  // steps, so two approvals of one proposal could interleave there: one fails part-way and restores
  // a subject to its stale `undoParent` while the other, which had already moved that subject, runs
  // on and closes the proposal — a settled proposal claiming a cluster the board only half holds.
  // Serialized, the second approval finds the proposal already closed and writes nothing at all.
  return withBeadWriteLock(repo, proposal.id, async () => {
    if (!plan) {
      // No plan, or one that disagrees with the bead's own fingerprint. Either way there is no move
      // to run, and guessing one from the prose would mutate beads nobody approved. Inside the lock
      // like every other write this module makes to a proposal — the refusal still notes the bead.
      throw await attachFailure(
        repo,
        proposal.id,
        new ProposalApplyError(
          "unusable",
          `${proposal.id} carries no readable gardener move — it cannot be applied; apply it by hand and decline it`,
        ),
      );
    }
    return applyApproved(repo, proposal, plan, board);
  });
}

/** The application itself: decide, write, settle — always under the proposal's lock (see caller). */
async function applyApproved(
  repo: string,
  proposal: Bead,
  plan: GardenerPlan,
  board: Bead[],
): Promise<ApplyResult> {
  // The settled check above judged the CALLER's snapshot — taken before whoever held this lock ran —
  // so re-read the proposal under it: two Approve clicks both pass that check, and the loser must
  // refuse rather than re-run a move that already landed.
  //
  // A read that FAILS is not permission to proceed. The proposal is what RECORDS the decision, and
  // every path out of here ends in a note + close on it — which runs OUTSIDE the rollback block. A
  // proposal we cannot read is one we probably cannot settle either (a deleted bead, an unreachable
  // bd), so falling through would move subjects and then fail to record any of it, leaving board
  // mutations with no settled proposal explaining them. Nothing has been written yet, so refusing
  // here costs nothing and a retry re-decides against a board it can actually see.
  let live: Bead;
  try {
    live = await beads.show(repo, proposal.id);
  } catch (e) {
    throw new ProposalApplyError(
      "refused",
      `cannot apply ${proposal.id}: it could not be re-read under its own write lock ` +
        `(${messageOf(e)}) — nothing was written`,
    );
  }
  if (live.status === "closed" || beads.isAbandoned(live)) {
    throw new ProposalApplyError(
      "unusable",
      `${proposal.id} is already settled — a proposal is applied or declined once`,
    );
  }

  // Dated from the proposal the approver read, not from `live`: its observation stamp is the moment
  // the patrol judged the board, which is what every "has this moved since we asked" check compares
  // to.
  const at: ApplyMoment = { nowMs: Date.now(), observedAtMs: observedAtOf(proposal) };
  const decision = planApply(plan, board, at);
  if (decision.status === "refuse") {
    throw await attachFailure(
      repo,
      proposal.id,
      new ProposalApplyError("refused", `cannot apply ${proposal.id}: ${decision.reason}`),
    );
  }

  // A SETTLED decision writes nothing, so — unlike an applied one — NO step ever locks or re-reads
  // the beads it rests on: the whole claim is the caller's snapshot, and a snapshot is stale the
  // instant it is taken. Re-confirm it under those beads' own write locks, and settle the proposal
  // inside them, so a subject moved away or an edge dropped after the route's refresh cannot leave
  // this proposal closed as applied over a board that no longer holds the state its summary names.
  if (decision.status === "settled") {
    return withBeadWriteLocks(repo, affectedBeads(plan), async () => {
      const drifted = await settledDrifted(repo, plan, at);
      if (drifted) {
        throw await attachFailure(
          repo,
          proposal.id,
          new ProposalApplyError("refused", `cannot apply ${proposal.id}: ${drifted}`),
        );
      }
      return settleProposal(repo, proposal.id, plan, decision.summary, []);
    });
  }

  // Only steps that actually WROTE — a step the board already satisfied is not ours to roll back
  // (see {@link alreadySatisfied}), and `changed` is both the rollback prefix and what the proposal
  // reports as touched.
  const changed: ApplyStep[] = [];
  try {
    for (const step of decision.steps) {
      if (await applyStep(repo, step)) changed.push(step);
    }
  } catch (e) {
    const rollback = await rollbackSteps(repo, changed);
    // A subject that moved under us is the board refusing, not a bd write breaking — but only
    // while nothing has landed yet. Once a prefix is written the outcome is a partial apply that
    // was rolled back, which is `failed` whatever tripped it.
    const stale = e instanceof SubjectMovedError && changed.length === 0;
    throw await attachFailure(
      repo,
      proposal.id,
      new ProposalApplyError(
        stale ? "refused" : "failed",
        stale
          ? `cannot apply ${proposal.id}: ${messageOf(e)}`
          : `applying ${proposal.id} failed: ${messageOf(e)}${rollback}`,
      ),
    );
  }

  return settleProposal(repo, proposal.id, plan, decision.summary, changed);
}

/**
 * Record what changed on the proposal itself and settle it — a plain close, not an abandon: the ask
 * was answered, and only a DECLINE suppresses the fingerprint (see the module header). Always under
 * the lock the whole application holds, so no second approve can be part-way through the same steps
 * while this one declares them done.
 */
async function settleProposal(
  repo: string,
  proposalId: string,
  plan: GardenerPlan,
  summary: string,
  changed: ApplyStep[],
): Promise<ApplyResult> {
  await beads.note(repo, proposalId, `${NOTE_PREFIX}: applied — ${summary}.`);
  await beads.close(repo, proposalId, `applied: ${summary}`);
  return { proposalId, plan, summary, changed: changed.map((s) => s.id) };
}

/** Every bead a plan's outcome rests on: the subjects it acts on, plus the bead it points at. */
function affectedBeads(plan: GardenerPlan): string[] {
  return plan.target ? [...plan.subjects, plan.target] : [...plan.subjects];
}

/**
 * Why the board no longer reads as already-applied, or undefined when it still does. Re-decided from
 * a FRESH board read through `planApply` itself rather than a hand-rolled per-verb re-check, so the
 * confirmation cannot hold the live board to a different bar than the decision held the snapshot to.
 */
async function settledDrifted(
  repo: string,
  plan: GardenerPlan,
  at: ApplyMoment,
): Promise<string | undefined> {
  let board: Bead[];
  try {
    board = await readWholeBoard(repo);
  } catch (e) {
    // Same rule as `reread`'s: a board we could not read says nothing, so the proposal stays open.
    return `the board could not be re-read to confirm the move is already applied (${messageOf(e)}) — nothing was written`;
  }
  const now = planApply(plan, board, { ...at, nowMs: Date.now() });
  switch (now.status) {
    case "settled":
      return undefined;
    case "refuse":
      return `the board no longer reads as applied — ${now.reason}`;
    default:
      return (
        "the board no longer reads as applied — the move was undone since this approval was " +
        "decided, so approving it again against the current board is what applies it"
      );
  }
}

// ── declining (the other half of the loop) ──

/**
 * The note a DECLINE leaves on a proposal, or undefined when the bead is not one.
 *
 * Declining is abandon — anton's existing won't-do outcome, which already closes the bead with the
 * operator's reason and labels it `abandoned`, and abandoned is exactly what emission suppresses on.
 * So the decline needs no verb of its own; what it needs is to SAY so, because "this question will
 * never be asked again" is a consequence of the label that nothing on the bead otherwise spells out.
 */
export function declineNote(proposal: Bead): string | undefined {
  const fingerprint = fingerprintLabelOf(proposal);
  if (!fingerprint) return undefined;
  // The `abandoned` label IS the suppression, so undoing a decline means dropping that label — not
  // reopening the bead, which would leave it suppressed and confuse the next reader.
  return (
    `${NOTE_PREFIX}: declined — the patrol will not file \`${fingerprint}\` again. ` +
    `Remove the \`${LABELS.abandoned}\` label to let it ask once more.`
  );
}

// ── execution (the only writes in this module) ──

/** A subject the board moved on between the decision and the write. Never a bd failure. */
class SubjectMovedError extends Error {}

/** What each verb would be DOING to the subject, for a refusal that reads as a sentence. */
const DOING: Record<ApplyStep["verb"], string> = {
  reparent: "moving it",
  link: "recording it as blocked",
  close: "retiring it",
  supersede: "retiring it",
  defer: "retiring it",
};

/** The verbs that SETTLE the subject — the ones that would strand whatever still hangs under it. */
const SETTLING: ReadonlySet<ApplyStep["verb"]> = new Set(["close", "supersede"]);

/** The verbs that take the subject OUT of whatever run's ticket set it rides. */
const RETIRING: ReadonlySet<ApplyStep["verb"]> = new Set(["close", "supersede", "defer"]);

/**
 * The bead a step points AT rather than writes to: a re-parent's new home, a link's blocker, a
 * supersede's survivor. The move's correctness rests on it as surely as on the subject — attaching
 * work under a home a run just claimed strands it, and an edge to a blocker that just closed leaves
 * the blocked bead reading as blocked forever — so it is locked and re-judged alongside the subject.
 */
function counterpartOf(step: ApplyStep): string | undefined {
  switch (step.verb) {
    case "reparent":
      return step.parent;
    case "link":
      return step.blocker;
    case "supersede":
      return step.replacement;
    default:
      return undefined;
  }
}

/**
 * The filing-time premise a RETIREMENT rests on, or absent for the verbs that make no claim about a
 * bead's contents. See {@link RetireEvidence} for why the step has to carry it at all.
 */
function evidenceOf(step: ApplyStep): RetireEvidence | undefined {
  switch (step.verb) {
    case "close":
    case "supersede":
    case "defer":
      return { kind: step.kind, observedAtMs: step.observedAtMs };
    default:
      return undefined;
  }
}

/**
 * The run target whose ticket set a RETIREMENT would take its subject out of, when it rides one. Not
 * written to and not pointed at — but the run that owns it is the one this write can abort, and the
 * only place that run is visible (see {@link TicketOwner}), so it is locked and re-judged too.
 */
function ownerOf(step: ApplyStep): TicketOwner["owner"] {
  switch (step.verb) {
    case "close":
    case "supersede":
    case "defer":
      return step.owner;
    default:
      return undefined;
  }
}

/**
 * One write, taken under the write lock of EVERY bead it rests on — the subject, its counterpart and
 * a retirement's ticket owner — and re-judged against reads taken from inside those locks.
 *
 * `planApply` decides against the caller's board snapshot, which is already seconds old by the time
 * the first bd write spawns — and the thing it is guarding against, a runner publishing a lease or
 * flipping a status, happens in exactly that window. Worse, a run's claim is serialized on this same
 * per-bead chain (beads/claim-lock.ts, shared with claimVerified and the human-claim CAS), so an
 * apply that stayed outside it wasn't racing the claim protocol so much as ignoring it: the snapshot
 * check could pass, a claim could land, and the move would still execute against work that had begun.
 *
 * Holding the locks makes the two orders: either the claim lands first and these reads see it
 * (refuse), or this write lands first and the claim queues behind it. Both ends need it, not just
 * the subject — a run claiming the HOME between the decision and the write has already selected its
 * tickets, so work attached now rides along unrun and is stranded when that run settles the card.
 * The ticket OWNER earns its lock the same way, from the other direction: a run picks its target up
 * on this very chain, so either its claim lands first and this read refuses, or this retirement
 * lands first and the run's own post-lease re-confirmation sees its ticket set move (execute-epic
 * step 1c) and retries — rather than aborting mid-flight on a bead the board no longer holds.
 *
 * Four questions are re-asked under the locks rather than left with the snapshot: whether the subject
 * still rides the TICKET SET the step captured (see {@link assertOwnerUnchanged}), whether a bead
 * about to be SETTLED still has open work under it (see {@link assertNothingStranded}), whether a
 * re-parent's home is still a BOARD CARD (see {@link assertHomeIsCard}), and whether the board still
 * STATES the ordering a link rests on (see {@link assertOrderingStated}). All four earn their board
 * read the same way — the write that flips the answer is itself a locked write on a bead this step
 * holds. Attaching work under a bead, and moving a bead onto another card, are both re-parents, which
 * take those beads' locks as subject and home; the one home that can STOP being a card is a legacy
 * epic, which stops the moment a feature lands under it — that same locked write; and a link's
 * evidence sits on the PAIR, whose bodies are edited under these very locks (`ticket-detail.ts`
 * `updateTicket`). So those writes genuinely order against each other.
 * The rest of the board-wide topology stays with the snapshot — whether the edge closes a cycle —
 * because it rests on beads no lock taken here covers, so re-deriving it would buy a whole board
 * read and still guarantee nothing.
 *
 * Answers whether this step LANDED a write, which is not the same as whether it succeeded: see
 * {@link alreadySatisfied}.
 */
async function applyStep(repo: string, step: ApplyStep): Promise<boolean> {
  const counterpart = counterpartOf(step);
  const owner = ownerOf(step);
  const locked = [step.id, counterpart, owner?.id].filter((id): id is string => id !== undefined);
  return withBeadWriteLocks(repo, locked, async () => {
    const subject = await reread(repo, step.id);
    const moved = subjectMoved(step, subject, Date.now());
    if (moved) throw new SubjectMovedError(moved);
    if (subject && alreadySatisfied(step, subject)) return false;
    if (counterpart) {
      const other = await reread(repo, counterpart);
      const otherMoved = counterpartMoved(step, counterpart, other, Date.now());
      if (otherMoved) throw new SubjectMovedError(otherMoved);
    }
    if (owner) {
      const live = await reread(repo, owner.id);
      const started = ownerStarted(step, owner, live, Date.now());
      if (started) throw new SubjectMovedError(started);
    }
    if (RETIRING.has(step.verb)) {
      const board = await lockedBoard(repo, `before retiring ${step.id}`);
      assertOwnerUnchanged(step, board);
      if (SETTLING.has(step.verb)) assertNothingStranded(step.id, board);
    }
    if (step.verb === "reparent") {
      const doing = `before re-parenting under ${step.parent}`;
      assertHomeIsCard(step.parent, await lockedBoard(repo, doing));
    }
    if (step.verb === "link") {
      const doing = `before recording ${step.blocker} as ${step.id}'s blocker`;
      assertOrderingStated(step.id, step.blocker, await lockedBoard(repo, doing));
    }
    await runStep(repo, step);
    return true;
  });
}

/**
 * Is this step's move already ON the board, put there by somebody else? Then this apply has nothing
 * to write, and — the reason it matters — nothing to UNDO either.
 *
 * A re-parent is the only verb that can reach here already satisfied: {@link subjectMoved}
 * deliberately accepts a subject sitting at `step.parent`, because another approval or an operator
 * landing the same move is the same move, and refusing would fail a cluster over a move that agrees
 * with it. But treating that no-op as a write this apply made puts it in the rollback prefix, so a
 * LATER member of the same cluster failing would restore `undoParent` over the other writer's
 * successful move — undoing a write we never made. Every other verb's idempotent state is caught
 * earlier, by `planApply`'s `settled` branch, and never becomes a step at all.
 */
function alreadySatisfied(step: ApplyStep, subject: Bead): boolean {
  return step.verb === "reparent" && (beads.parentOf(subject) ?? "") === step.parent;
}

/**
 * A fresh board for the topology re-checks, indexed the way both halves of the loop read it — or a
 * refusal naming what the read was needed for. Same rule as `reread`'s: a board we could not read
 * says nothing, so the step refuses and nothing is written.
 */
async function lockedBoard(repo: string, doing: string): Promise<BoardIndex> {
  try {
    return indexBoard(await readWholeBoard(repo));
  } catch (e) {
    throw new SubjectMovedError(
      `the board could not be re-read ${doing} (${messageOf(e)}) — nothing was written`,
    );
  }
}

/**
 * Refuse a retirement whose subject has changed hands since the decision, judged from a board read
 * taken INSIDE the subject's write lock.
 *
 * {@link ownerStarted} re-reads the owner the STEP captured and asks whether a run has started on it.
 * Neither it nor {@link subjectMoved} — which compares parents for a re-parent alone — can see the
 * other half: a re-parent approval landing in this window moves the subject under a DIFFERENT run
 * target, one this step holds no lock on and never re-reads, so retiring it here takes a ticket out
 * of a live run the decision never looked at, and that run aborts when its claim reaches the bead.
 * Re-derived through the same {@link ticketOwnerOf} the decision used, so the write cannot hold
 * ownership to a different bar than `planRetire` held the snapshot to.
 *
 * Refused on the IDENTITY change alone rather than on the newcomer's liveness: nothing locks the new
 * owner, so any liveness read of it would be racing the very claim this serialization exists to
 * order against — while "the subject no longer rides the set this proposal was decided against" is
 * settled by the read whose lock we do hold.
 */
function assertOwnerUnchanged(step: ApplyStep, board: BoardIndex): void {
  const subject = board.byId.get(step.id);
  if (!subject) throw new SubjectMovedError(missing(step.id));
  const now = ticketOwnerOf(board, subject)?.id;
  const was = ownerOf(step)?.id;
  if (now === was) return;
  throw new SubjectMovedError(
    `${step.id} now rides ${ticketSet(now)} rather than ${ticketSet(was)} — the run target it hangs under changed since this proposal was decided, so ${retiringTicket(step.id)} would act on a ticket set this approval never looked at`,
  );
}

/** A run target as an ownership refusal names it — absent means the subject rides no ticket set. */
const ticketSet = (id: string | undefined): string => (id ? `${id}'s ticket set` : "no ticket set");

/**
 * Refuse to settle a bead that still has open work beneath it, judged from a board read taken INSIDE
 * the subject's write lock rather than from the approval's snapshot.
 *
 * `planApply` asks the same question of the snapshot, and against a lone approval that is enough.
 * What it cannot see is a CONCURRENT one: a re-parent approval attaching work under this bead takes
 * this bead's write lock too (it is that step's home — see {@link applyStep}), so the two orders are
 * already serialized, and re-asking here is what makes the ordering mean something. Either the
 * re-parent lands first and this read finds the newcomer, or this settle lands first and the
 * re-parent's own home re-check refuses. Without it, both pass against snapshots taken before either
 * wrote, and the newly attached ticket is left beneath a card no run will ever reach.
 */
function assertNothingStranded(id: string, board: BoardIndex): void {
  const open = board.openDescendants(id);
  if (open.length > 0) {
    throw new SubjectMovedError(
      `${id} has open work under it (${namesSome(open.map((b) => b.id))}) since this proposal was filed — settling it would strand that work beneath a card nothing will run`,
    );
  }
}

/**
 * Refuse to hang work under a home that is no longer a BOARD CARD, judged from a board read taken
 * INSIDE the home's write lock rather than from the approval's snapshot.
 *
 * `planReparent` asks the same question of the snapshot, and against a lone approval that is enough.
 * What it cannot see is a CONCURRENT one: the only home that can stop being a card is a legacy epic,
 * and it stops the instant a FEATURE lands under it — a re-parent that takes this very epic's write
 * lock as its own home (see {@link applyStep}). So the two orders are already serialized, and
 * re-asking here is what makes the ordering mean something. Without it, both pass against snapshots
 * taken before either wrote, and this step attaches its subject directly to what is now a container
 * epic — work riding no card and reachable by no run, which is the state the proposal exists to fix.
 */
function assertHomeIsCard(parentId: string, board: BoardIndex): void {
  if (!board.cards.ids.has(parentId)) {
    throw new SubjectMovedError(
      `${parentId} is no longer a board card — re-parenting under it would leave the work riding no card, which is the state this proposal is about`,
    );
  }
}

/**
 * Refuse to draw an ordering edge whose evidence the board no longer states, judged from a board read
 * taken INSIDE the pair's write locks rather than from the approval's snapshot.
 *
 * `planApply` asks the same question of the snapshot ({@link linkPremiseGone}), and that snapshot is
 * already seconds old when the first bd write spawns — while everything else the locked half checks
 * asks only whether the two beads are still WRITABLE, which a deleted phrase leaves untouched. So
 * without this the edge lands after its sole evidence was removed, taking the blocked bead back out
 * of the ready set that edit put it in.
 *
 * The evidence sits on the pair itself — a body phrase on one of the two beads, or a
 * `discovered-from` edge between them (see `relink.ts` {@link impliesOrdering}) — and both beads are
 * locked here, so a body edit, which takes the same per-bead lock (`ticket-detail.ts` `updateTicket`),
 * either lands first and this read finds the phrase gone or queues behind this write. An operator
 * dropping the EDGE by hand takes no such lock, so for that half this is a narrowing of the
 * snapshot→lock window rather than a serialization — the same bargain {@link RetireEvidence} strikes.
 */
function assertOrderingStated(blockedId: string, blockerId: string, board: BoardIndex): void {
  if (impliesOrdering(board, blockedId, blockerId)) return;
  throw new SubjectMovedError(orderingUnstated(blockedId, blockerId));
}

/** The one phrasing both readings of the link premise refuse with — snapshot and under-lock alike. */
const orderingUnstated = (blockedId: string, blockerId: string): string =>
  `nothing on the board still places ${blockedId} after ${blockerId} — the body phrase or discovered-from edge this proposal read has been removed since it was filed, so recording the edge would restore an ordering a newer decision took away`;

/**
 * A fresh whole-board read for the topology re-checks — through `loadAllIssues` rather than a bare
 * `bd list --status all`, because that flag is unsupported on some bd versions and every re-check
 * here treats a failed read as a refusal. On such a bd a sound approval would refuse forever;
 * `loadAllIssues` falls back to merging the open and closed listings instead. Callers phrase their
 * own refusal for the read that genuinely fails.
 */
function readWholeBoard(repo: string): Promise<Bead[]> {
  return loadAllIssues(repo);
}

/** A bead read from inside its own write lock. A read that FAILED is never a bead that vanished. */
async function reread(repo: string, id: string): Promise<Bead | undefined> {
  try {
    return await beads.show(repo, id);
  } catch (e) {
    // Saying "gone" here would misdiagnose a flaky bd as a board that moved. Either way, the step
    // refuses and nothing is written.
    throw new SubjectMovedError(
      `${id} could not be re-read before applying the move (${messageOf(e)}) — nothing was written`,
    );
  }
}

/** Why this subject can no longer be written to, or undefined when the plan still holds for it. */
function subjectMoved(step: ApplyStep, subject: Bead | undefined, nowMs: number): string | undefined {
  if (!subject) return missing(step.id);
  if (!isOpenWork(subject)) {
    return `${step.id} is ${settledWord(subject)} — the board moved on since this was proposed`;
  }
  if (isInFlight(subject, nowMs)) return inFlightReason(subject, nowMs, DOING[step.verb]);
  // A pickup that landed since this step was decided, in the window `isInFlight` cannot see: the
  // claim writes assignee + `in_progress` and publishes the run-lease a moment later. That sequence
  // serializes on the very per-bead chain this apply holds, so the claim either lands before the
  // re-read above or queues behind this write — and refusing here is what makes that ordering worth
  // anything. A claim the plan already saw is not news (the stale-in-progress detector proposes
  // against exactly those); one since RELEASED leaves the bead freer than the plan assumed. So only
  // a new owner refuses.
  const claim = runClaimOf(subject);
  if (claim && claim !== step.claim) {
    return `${step.id} was claimed by ${claim} since this proposal was decided — ${DOING[step.verb]} would pull the bead out from under the run that now owns it`;
  }
  // A retirement rests on a claim about the subject's CONTENTS that every check above is blind to —
  // a rescoping edit leaves status, liveness and claim exactly as the plan found them. `planRetire`
  // asked it of the route's snapshot; re-asked here against the read taken under this bead's own
  // lock, so an edit landing in that window refuses instead of being settled as delivered.
  const evidence = evidenceOf(step);
  if (evidence) {
    const touched = premiseTouched(subject, RETIRE_PREMISE[evidence.kind], evidence.observedAtMs);
    if (touched) return touched;
  }
  // A re-parent is the one verb whose subject can move WITHOUT changing status: another approval or
  // an operator re-homing it since the plan was made is a newer decision than this one, and writing
  // over it would silently undo their move — then, on a cluster rollback, restore a parent two moves
  // stale. Landing where this step was already headed is the same move, so it stays idempotent.
  if (step.verb === "reparent") {
    const parent = beads.parentOf(subject) ?? "";
    if (parent !== step.undoParent && parent !== step.parent) {
      return `${step.id} now sits under ${home(parent)} rather than ${home(step.undoParent)} — it was re-parented since this proposal was filed, and moving it to ${step.parent} would overwrite that`;
    }
  }
  return undefined;
}

/**
 * Why the bead this step points at can no longer stand behind it, or undefined. Each verb re-asks
 * the SAME question `planApply` asked of it — through the same helper, so the write cannot hold a
 * counterpart to a laxer bar than the decision did.
 */
function counterpartMoved(
  step: ApplyStep,
  id: string,
  counterpart: Bead | undefined,
  nowMs: number,
): string | undefined {
  if (!counterpart) return missing(id);
  switch (step.verb) {
    case "reparent":
      return homeUnusable(counterpart, nowMs) ?? homeClaimed(step, counterpart);
    case "link":
      return blockerUnusable(counterpart, step.id);
    case "supersede":
      // The survivor's end of the same premise, re-asked under its own lock for the reason the
      // subject's is: `survivorUnusable` only asks whether it still reads as landed work, which a
      // rewrite leaves untouched — and superseding onto a twin that no longer holds the work would
      // close the last live copy of it.
      return (
        survivorUnusable(counterpart, step.id) ??
        premiseTouched(counterpart, RETIRE_PREMISE[step.kind]?.twin, step.observedAtMs)
      );
    default:
      return undefined;
  }
}

/**
 * Why a run has started on the target whose ticket set this retirement's subject rides, or
 * undefined. Judged by the same two bars `planRetire` held the snapshot to — a live run, and a claim
 * taken in the window before a lease exists to see — so the write cannot pass an owner the decision
 * would have refused.
 *
 * An owner that has LEFT the board is no obstacle: nothing is running a ticket set that no longer
 * exists, and the subject's own re-read already covers what became of it.
 *
 * This asks only whether the CAPTURED owner has started. Whether it is still the owner at all is
 * {@link assertOwnerUnchanged}'s question, and it has to be a separate one: a subject re-parented
 * since the decision rides a target this step never locked.
 */
function ownerStarted(
  step: ApplyStep,
  owner: NonNullable<TicketOwner["owner"]>,
  live: Bead | undefined,
  nowMs: number,
): string | undefined {
  if (!live) return undefined;
  if (isInFlight(live, nowMs)) return inFlightReason(live, nowMs, retiringTicket(step.id));
  const claim = runClaimOf(live);
  if (!claim || claim === owner.claim) return undefined;
  return `${live.id} was claimed by ${claim} since this proposal was decided — that run has already selected the tickets it will work through, so ${retiringTicket(step.id)} would abort it when its claim reaches a bead the board no longer holds`;
}

async function runStep(repo: string, step: ApplyStep): Promise<void> {
  switch (step.verb) {
    case "reparent":
      await beads.reparent(repo, step.id, step.parent);
      return;
    case "link":
      // `bd link a b` = b blocks a, which is the direction the detection states.
      await beads.link(repo, step.id, step.blocker, "blocks");
      return;
    case "close":
      await beads.close(repo, step.id, step.reason);
      return;
    case "supersede":
      await beads.supersede(repo, step.id, step.replacement);
      return;
    case "defer":
      await beads.defer(repo, step.id);
      return;
  }
}

/**
 * Undo the steps that DID land when a later one failed, newest first, and report the outcome as a
 * clause for the error. Only a cluster re-parent is ever multi-step, so this is the one shape that
 * can strand a half-applied move; every other move fails with nothing written.
 *
 * A rollback that itself fails is named in the error rather than swallowed: the board is then in a
 * state a human has to look at, and saying so is the whole point of failing loud.
 */
async function rollbackSteps(repo: string, applied: ApplyStep[]): Promise<string> {
  if (applied.length === 0) return " — nothing had been written";
  const stranded: string[] = [];
  const overtaken: string[] = [];
  for (const step of [...applied].reverse()) {
    if (step.verb !== "reparent") {
      stranded.push(step.id);
      continue;
    }
    try {
      // Undone under the same per-bead lock the write took, so a claim that queued behind the
      // failed apply doesn't interleave with its rollback.
      await withBeadWriteLock(repo, step.id, async () => {
        // Undo only what is still OURS to undo. Another approval — of a different proposal naming
        // the same subject — can land between this apply's per-step locks, and restoring the parent
        // this plan happened to record would clobber a move somebody else has since made and now
        // reads as the board's truth.
        //
        // A read that FAILED proves nothing either way, so it is STRANDED rather than restored: the
        // two mistakes are not symmetric. Restoring on a blind read overwrites a newer move
        // silently, and nothing on the board says it happened; leaving the step applied names the
        // bead in the error for a human to settle. Fail loud beats fail quiet.
        const live = await beads.show(repo, step.id).catch(() => undefined);
        if (!live) {
          stranded.push(step.id);
          return;
        }
        if ((beads.parentOf(live) ?? "") !== step.parent) {
          overtaken.push(step.id);
          return;
        }
        await beads.reparent(repo, step.id, step.undoParent);
      });
    } catch {
      stranded.push(step.id);
    }
  }
  if (stranded.length > 0) {
    return ` — ROLLBACK INCOMPLETE: ${list(stranded)} could not be restored and need a human`;
  }
  return overtaken.length === 0
    ? ` — the ${applied.length} write(s) already made were rolled back, so the board is unchanged`
    : ` — the ${applied.length} write(s) already made were rolled back, except ${list(overtaken)}, which another write has since moved and was left where it now sits`;
}

/**
 * Write the failure onto the proposal so the still-open bead explains itself, and hand the error
 * back for the caller to throw. Best-effort: a note that cannot be written must not replace the
 * real failure with a bd error about writing about it.
 */
async function attachFailure(
  repo: string,
  proposalId: string,
  error: ProposalApplyError,
): Promise<ProposalApplyError> {
  try {
    await beads.note(repo, proposalId, `${NOTE_PREFIX}: apply FAILED — ${oneLine(error.message)}`);
  } catch (e) {
    console.error(`[gardener] could not attach the apply failure to ${proposalId}`, e);
  }
  return error;
}

// ── small pure helpers ──

/**
 * The moment the proposal's EVIDENCE describes, in epoch ms — the fence every "has this moved since
 * we asked" check dates against.
 *
 * Not the bead's `created_at`: one patrol pass reads the board once and then files up to ten
 * proposals through sequential bd writes, so a subject edited after that read but before ITS
 * proposal was created is a change the detection never saw, which `created_at` would date as
 * already-observed. The emitter therefore stamps the snapshot's own moment onto the bead
 * ({@link GARDENER_OBSERVED_AT_KEY}).
 *
 * Two guards make trusting a metadata value safe here:
 *   • CLAMPED to `created_at`, so the stamp can only pull the fence EARLIER — the direction that
 *     costs refusals, never permission. Metadata is hand-editable, and a LATER fence is the one
 *     edit that would let a write the detection never saw pass as observed.
 *   • FLOORED to bd's one-second stamp grid, so a subject written in the same second as the
 *     observation still reads as the unorderable tie {@link writtenSinceFiling} fails closed on
 *     rather than as a write the plan saw.
 *
 * A missing or unreadable stamp falls back to `created_at` — a fence later by the length of one
 * pass, which is what anton shipped before this and is far better than refusing every proposal an
 * older patrol filed. An unreadable `created_at` stays `undefined`, which every caller fails closed
 * on.
 */
function observedAtOf(proposal: Bead): number | undefined {
  const created = msOf(proposal.created_at);
  if (created === undefined) return undefined;
  const observed = msOf(proposal.metadata?.[GARDENER_OBSERVED_AT_KEY]);
  return toBdStampGrid(observed === undefined ? created : Math.min(observed, created));
}

/** An ISO stamp (or an epoch-ms number) as epoch ms, or undefined when it is neither. */
function msOf(value: unknown): number | undefined {
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value !== "string" || !value) return undefined;
  const at = Date.parse(value);
  return Number.isFinite(at) ? at : undefined;
}

/** bd stamps beads at whole seconds; the fence is floored to match — see {@link writtenSinceFiling}. */
const toBdStampGrid = (ms: number): number => Math.floor(ms / 1000) * 1000;

/** The close reason a retirement writes — evidence lives on the proposal, so this stays one line. */
function closeReason(plan: GardenerPlan): string {
  return `closed by an approved gardener proposal (${plan.kind})`;
}

const missing = (id: string): string =>
  `${id} is no longer on the board — the proposal describes a board that has changed`;

/** A parent id as a refusal names it — `""` is bd's detached form, not a bead called nothing. */
const home = (parentId: string): string => parentId || "no parent";

const NO_SURVIVOR = "this proposal names no bead that superseded it";

/** What a retirement is doing to the RUN that holds the subject's ticket set, as a refusal reads. */
const retiringTicket = (id: string): string => `retiring ${id} out of its ticket set`;

/**
 * Why this bead can no longer be a re-parent HOME, or undefined. A settled home hangs the work off a
 * card nothing will run; a home a run OWNS is worse — that run already selected the tickets it will
 * work through, so work attached now rides along unrun, and when the run settles the card the
 * newcomers are left beneath a target nothing will claim, which is the unreachable state the
 * proposal exists to fix.
 *
 * This is only half of the guarantee, and it cannot be the other half: a run selects its tickets
 * before it publishes anything for this check to observe. The run closes its own side — it
 * re-confirms the selection once its lease is live and retries if the set moved (execute-epic step
 * 1c) — so a move that beats the lease is picked up rather than dropped. That confirmation runs
 * under THIS bead's write lock, the one `applyStep` holds around the check and the write below, so
 * the two genuinely order: this step cannot slip its write into the window after that read.
 */
function homeUnusable(home: Bead, nowMs: number): string | undefined {
  if (!isOpenWork(home)) {
    return `${home.id} is ${settledWord(home)} — re-parenting work under it would hang it off a card nothing will run`;
  }
  if (isInFlight(home, nowMs)) return inFlightReason(home, nowMs, "hanging more work under it");
  return undefined;
}

/**
 * Why a run that picked the HOME up since this step was decided bars the move, or undefined. This is
 * the home's half of the claim window {@link isInFlight} cannot see (see `parentClaim`), judged by
 * the same rule the subject's claim is: a claim the plan already saw is not news, and one RELEASED
 * since leaves the home freer than the plan assumed — only a NEW owner refuses.
 */
function homeClaimed(
  step: Extract<ApplyStep, { verb: "reparent" }>,
  home: Bead,
): string | undefined {
  const claim = runClaimOf(home);
  if (!claim || claim === step.parentClaim) return undefined;
  return `${home.id} was claimed by ${claim} since this proposal was decided — that run has already selected the tickets it will work through, so work hung under it now would ride along unrun`;
}

/**
 * Why this bead can no longer order `blockedId`, or undefined. Only the blocked bead is written to,
 * so a run holding the blocker is no obstacle — but a blocker that has LANDED makes the edge a lie.
 */
function blockerUnusable(blocker: Bead, blockedId: string): string | undefined {
  if (!isOpenWork(blocker)) {
    return `${blocker.id} is ${settledWord(blocker)} — the work ${blockedId} was waiting on has landed, so the edge would only make ${blockedId} read as blocked forever`;
  }
  return undefined;
}

/**
 * Why this bead is not a survivor `subjectId` can be superseded by, or undefined. The whole claim is
 * "the work landed over there": a survivor that is open again means it did not, and closing the
 * subject would write off work nothing has delivered.
 *
 * ABANDONED is the case a status check alone gets wrong — it IS `closed`, plus a label that says the
 * work was explicitly not done. Superseding onto it would retire the last live copy of the work in
 * favour of a recorded won't-do. Same bar `detectSuperseded` emits under (retire.ts).
 */
function survivorUnusable(survivor: Bead, subjectId: string): string | undefined {
  if (beads.isAbandoned(survivor)) {
    return `${survivor.id} is abandoned — a recorded won't-do delivered nothing, so ${subjectId} is not superseded by it`;
  }
  if (survivor.status !== "closed") {
    return `${survivor.id} is ${survivor.status} again — it has not landed, so ${subjectId} is not superseded by it`;
  }
  return undefined;
}

/**
 * Why a bead a run owns is off limits, naming the run that owns it. Every detector already refuses
 * to PROPOSE against in-flight work (see board-index `isInFlight`) — this is the same bar re-checked
 * at approve time, because the run may have claimed the bead AFTER the proposal was filed, and a
 * proposal is only ever as fresh as the night it was written.
 */
function inFlightReason(bead: Bead, nowMs: number, doing: string): string {
  const pr = beads.getPrRef(bead);
  const owner = beads.isRunLive(bead, nowMs)
    ? `a run holds a live lease on it${bead.assignee ? ` (${bead.assignee})` : ""}`
    : `it is in review${pr ? ` on ${pr}` : ""}`;
  return `${bead.id} is mid-run — ${owner}, so ${doing} would race the run that owns it`;
}

const settledWord = (bead: Bead): string =>
  beads.isAbandoned(bead) ? "abandoned" : bead.status === "closed" ? "closed" : bead.status;

const list = (ids: string[]): string => ids.join(", ");

/** How many ids a refusal spells out before it counts the rest — a reason stays one readable line. */
const NAMED_IDS = 5;

const namesSome = (ids: string[]): string =>
  ids.length <= NAMED_IDS
    ? list(ids)
    : `${list(ids.slice(0, NAMED_IDS))} and ${ids.length - NAMED_IDS} more`;

const oneLine = (text: string): string => text.replace(/\s+/g, " ").trim();

const messageOf = (e: unknown): string => oneLine(e instanceof Error ? e.message : String(e));
