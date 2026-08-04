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
 *     because a snapshot is stale the instant it is taken, every bead a write rests on — the subject
 *     AND the home/blocker/survivor it points at — is re-read and re-judged under its own write lock
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
import { indexBoard, isInFlight, isOpenWork, stampMsOf, type BoardIndex } from "./board-index";
import {
  fingerprintLabelOf,
  isProposalBead,
  proposalPlanOf,
  type GardenerPlan,
} from "./detections";

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
       */
      parentClaim: string;
    })
  | (StepSubject & { verb: "link"; blocker: string })
  | (StepSubject & { verb: "close"; reason: string })
  | (StepSubject & { verb: "supersede"; replacement: string })
  | (StepSubject & { verb: "defer" });

/**
 * Who a RUN holds this bead for, or `""` when nobody does. `bd update --claim` — the worker pickup
 * primitive behind `beads.claimVerified` — writes the assignee and `in_progress` as one act, so that
 * pair IS the claim. A bare `bd assign` reserves a bead for a person without starting work on it
 * (DESIGN.md §Soft-lock) and deliberately does not count.
 */
function runClaimOf(bead: Bead): string {
  if (bead.status !== "in_progress") return "";
  return bead.assignee || "an unnamed runner";
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
 * The two moments an approval sits between: when the patrol FILED the proposal — the board its
 * evidence describes — and NOW, the board the writes would land on. Both are needed because a
 * precondition re-checked only against the approval's fresh snapshot is blind to everything that
 * moved BEFORE that snapshot was taken: the plan carries no state of its own to compare against, so
 * the filing stamp is what dates a change as "since we asked".
 */
export interface ApplyMoment {
  /** When the approval is being decided. */
  nowMs: number;
  /**
   * When the proposal bead was created, or undefined when it carries no readable stamp. Undefined
   * FAILS CLOSED wherever it is read: with nothing to date a change against, we cannot prove the
   * board still reads as the approver was shown.
   */
  filedAtMs: number | undefined;
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
    const claimed = claimedSinceFiling(subject, at, "moving it");
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
  const claimed = claimedSinceFiling(blocked, at, "recording it as blocked");
  if (claimed) return { status: "refuse", reason: claimed };
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
  const claimed = claimedSinceFiling(subject, at, "retiring it");
  if (claimed) return { status: "refuse", reason: claimed };
  // The premise `detectStale` filed on is that NOTHING has touched this bead (retire.ts), and that
  // premise is the one thing a fresh board read alone cannot confirm — silence is a claim about the
  // moment the patrol looked. Re-confirmed against the filing stamp so approving a months-old ask
  // cannot park work somebody has since picked back up.
  if (plan.kind === "stale") {
    const active = staleTouched(subject, at);
    if (active) return { status: "refuse", reason: active };
  }
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

  switch (plan.retireAs) {
    case "close":
      return {
        status: "apply",
        steps: [{ verb: "close", id, claim: runClaimOf(subject), reason: closeReason(plan) }],
        summary: `closed ${id} as shipped`,
      };
    case "defer":
      return {
        status: "apply",
        steps: [{ verb: "defer", id, claim: runClaimOf(subject) }],
        summary: `deferred ${id} out of the ready set`,
      };
    case "supersede": {
      if (!plan.target) return { status: "refuse", reason: NO_SURVIVOR };
      const survivor = index.byId.get(plan.target);
      if (!survivor) return { status: "refuse", reason: missing(plan.target) };
      const survivorGone = survivorUnusable(survivor, id);
      if (survivorGone) return { status: "refuse", reason: survivorGone };
      return {
        status: "apply",
        steps: [
          { verb: "supersede", id, claim: runClaimOf(subject), replacement: plan.target },
        ],
        summary: `closed ${id} as superseded by ${plan.target}`,
      };
    }
    default:
      return { status: "refuse", reason: `unknown retirement verb "${plan.retireAs}"` };
  }
}

/**
 * Has this bead been written to since the proposal was filed? `undefined` when either stamp is
 * unreadable — the honest answer when there is nothing to compare, which every caller fails closed
 * on. bd's own creation and write stamps are the only filing-time facts available here, and they are
 * better than any the plan could carry: a hand-edited metadata blob cannot rewrite them.
 *
 * bd stamps at ONE-SECOND resolution, so a write landing in the very second the proposal was created
 * reads as part of the board the patrol judged. That is the right way round: the window this closes
 * is the hours or nights between a patrol and an approval, and the sub-second remainder is covered
 * by the under-lock baseline ({@link StepSubject.claim}) like every other late arrival.
 */
function writtenSinceFiling(subject: Bead, at: ApplyMoment): boolean | undefined {
  const writtenAt = stampMsOf(subject);
  if (at.filedAtMs === undefined || writtenAt === undefined) return undefined;
  return writtenAt > at.filedAtMs;
}

/**
 * Why a run claim taken SINCE the proposal was filed bars this move, or undefined.
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
function claimedSinceFiling(subject: Bead, at: ApplyMoment, doing: string): string | undefined {
  const claim = runClaimOf(subject);
  if (!claim) return undefined;
  const since = writtenSinceFiling(subject, at);
  if (since === false) return undefined; // the claim the plan was made against, not a newer one
  const dated =
    since === undefined
      ? "nothing dates that claim against this proposal's filing"
      : "it was claimed since this proposal was filed";
  return `${subject.id} is held by ${claim} and ${dated} — ${doing} would pull the bead out from under the run that owns it; decline it and act by hand if the claim is dead`;
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
 * Why this bead is no longer the stale one the proposal describes, or undefined.
 *
 * `detectStale` measured SILENCE (retire.ts), and silence is the one premise a plan cannot restate:
 * it is a fact about the moment the patrol looked. Confirmed against that moment rather than by
 * re-deriving the day threshold, because "has anyone touched it since we asked" is the question the
 * approver's evidence actually rests on — a bead nobody wrote to has only grown staler, while one
 * edited, re-prioritised or picked back up is simply no longer the bead the ask describes.
 */
function staleTouched(subject: Bead, at: ApplyMoment): string | undefined {
  const since = writtenSinceFiling(subject, at);
  if (since === false) return undefined;
  return since === undefined
    ? `${subject.id} carries no write stamp this proposal's filing can be compared to, so nothing confirms it is still the untouched bead the ask describes`
    : `${subject.id} has been written to since this proposal was filed — it is no longer the untouched bead the ask describes, and deferring it now would park work somebody has picked back up`;
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

  // Dated from the proposal the approver read, not from `live`: `created_at` is the moment the
  // patrol judged the board, which is what every "has this moved since we asked" check compares to.
  const at: ApplyMoment = { nowMs: Date.now(), filedAtMs: filedAtOf(proposal) };
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

  const changed: ApplyStep[] = [];
  try {
    for (const step of decision.steps) {
      await applyStep(repo, step);
      changed.push(step);
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
    board = await beads.list(repo, ["--status", "all"]);
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
 * One write, taken under the write lock of EVERY bead it rests on — the subject and its counterpart
 * — and re-judged against reads taken from inside those locks.
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
 *
 * Two topology questions are re-asked under the locks rather than left with the snapshot: whether a
 * bead about to be SETTLED still has open work under it (see {@link assertNothingStranded}), and
 * whether a re-parent's home is still a BOARD CARD (see {@link assertHomeIsCard}). Both earn their
 * board read the same way — the write that flips the answer is itself a locked write on a bead this
 * step holds. Attaching work under a bead is a re-parent, which takes that bead's lock as its home;
 * and the one home that can STOP being a card is a legacy epic, which stops the moment a feature
 * lands under it — that same locked write. So the two approvals genuinely order against each other.
 * The rest of the board-wide topology stays with the snapshot — whether the edge closes a cycle —
 * because it rests on beads no lock taken here covers, so re-deriving it would buy a whole board
 * read and still guarantee nothing.
 */
async function applyStep(repo: string, step: ApplyStep): Promise<void> {
  const counterpart = counterpartOf(step);
  const locked = counterpart ? [step.id, counterpart] : [step.id];
  await withBeadWriteLocks(repo, locked, async () => {
    const subject = await reread(repo, step.id);
    const moved = subjectMoved(step, subject, Date.now());
    if (moved) throw new SubjectMovedError(moved);
    if (counterpart) {
      const other = await reread(repo, counterpart);
      const otherMoved = counterpartMoved(step, counterpart, other, Date.now());
      if (otherMoved) throw new SubjectMovedError(otherMoved);
    }
    if (SETTLING.has(step.verb)) await assertNothingStranded(repo, step.id);
    if (step.verb === "reparent") await assertHomeIsCard(repo, step.parent);
    await runStep(repo, step);
  });
}

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
async function assertNothingStranded(repo: string, id: string): Promise<void> {
  let board: Bead[];
  try {
    board = await beads.list(repo, ["--status", "all"]);
  } catch (e) {
    // Same call as `reread`'s: a board we could not read says nothing, so the step refuses.
    throw new SubjectMovedError(
      `the board could not be re-read before settling ${id} (${messageOf(e)}) — nothing was written`,
    );
  }
  const open = indexBoard(board).openDescendants(id);
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
async function assertHomeIsCard(repo: string, parentId: string): Promise<void> {
  let board: Bead[];
  try {
    board = await beads.list(repo, ["--status", "all"]);
  } catch (e) {
    // Same call as `reread`'s: a board we could not read says nothing, so the step refuses.
    throw new SubjectMovedError(
      `the board could not be re-read before re-parenting under ${parentId} (${messageOf(e)}) — nothing was written`,
    );
  }
  if (!indexBoard(board).cards.ids.has(parentId)) {
    throw new SubjectMovedError(
      `${parentId} is no longer a board card — re-parenting under it would leave the work riding no card, which is the state this proposal is about`,
    );
  }
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
      return survivorUnusable(counterpart, step.id);
    default:
      return undefined;
  }
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
 * When the proposal was FILED, in epoch ms, or undefined when it carries no readable `created_at`.
 * bd stamps every bead at creation, so this is the plan's filing time without the plan having to
 * carry a copy of it — and a copy is exactly what a hand-edited metadata blob could rewrite.
 */
function filedAtOf(proposal: Bead): number | undefined {
  const at = typeof proposal.created_at === "string" ? Date.parse(proposal.created_at) : NaN;
  return Number.isFinite(at) ? at : undefined;
}

/** The close reason a retirement writes — evidence lives on the proposal, so this stays one line. */
function closeReason(plan: GardenerPlan): string {
  return `closed by an approved gardener proposal (${plan.kind})`;
}

const missing = (id: string): string =>
  `${id} is no longer on the board — the proposal describes a board that has changed`;

/** A parent id as a refusal names it — `""` is bd's detached form, not a bead called nothing. */
const home = (parentId: string): string => parentId || "no parent";

const NO_SURVIVOR = "this proposal names no bead that superseded it";

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
 * 1c) — so a move that beats the lease is picked up rather than dropped.
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
