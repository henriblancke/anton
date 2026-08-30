/**
 * THE DECISION HALF of apply-on-approve (anton-1t3n): what approving a proposal MEANS against the
 * board as it now is, decided without writing anything.
 *
 * Split out of apply.ts (anton-ni1j) so the module that writes reads as composition. Pure over its
 * input — a board index and two moments — so every precondition that protects other people's beads
 * is testable from a fixture board rather than a live one, and so the WRITE half can re-ask each one
 * through the very same helper: a bar that lived inside a planner alone could be re-checked under
 * the lock at a laxer setting than the decision held the snapshot to, which is how a move passes a
 * check it never really passed. Everything the writes share — the step shapes, the bars, the
 * phrasing a refusal reads in — is therefore exported from here.
 *
 * apply.ts carries the three properties this whole layer rests on and why each exists.
 */
import { approvalGaps, formatApprovalGaps, type ApprovalGap } from "../approval-gate";
import { beads, LABELS, type Bead } from "../beads/bd";
import { isTicketTier } from "../beads/contract";
import {
  indexBoard,
  isInFlight,
  isOpenWork,
  runClaimOf,
  stampMsOf,
  ticketOwnerOf,
  ticketPathOf,
  type BoardIndex,
} from "./board-index";
import {
  namespaceOf,
  priorityOf,
  type GardenerDetectionKind,
  type GardenerPlan,
} from "./detections";
import { impliesOrdering } from "./relink";
import {
  carriedTickets,
  carrierPaths,
  groupedUnder,
  isClusterTier,
  MIN_CARRIED_TICKETS,
  MIN_CLUSTER_SIZE,
} from "./reparent";

/**
 * The `notes` prefix an apply writes under — one line, like anton's other job notes, and named for
 * the producer whose proposal it is so a reader can tell a patrol's note from a judgment pass's.
 */
export const notePrefix = (plan: GardenerPlan): string => namespaceOf(plan.kind);

/** What every step carries about the bead it writes to, whatever the verb. */
interface StepSubject {
  id: string;
  /**
   * The run claim the subject carried when this step was DECIDED, or `""` for none — captured like
   * `undoParent`, and re-compared under the write lock (see apply-steps.ts `subjectMoved`).
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
  /**
   * The two re-parent classes rest on DIFFERENT evidence, exactly as the two link kinds do, and
   * {@link EvidenceFence.kind} is what tells them apart under the lock: the gardener's
   * `container-orphan` / `parentless-cluster` claim "no board card carries this", which a fresh read
   * restates in full ({@link reparentPremiseGone}); a `misfiled` is the product master's reading of
   * which home two beads' contracts call for, which no board read restates — holding it to the card
   * check would refuse it forever, so it is fenced on the observation stamp instead
   * ({@link EVIDENCE_PREMISE}).
   */
  | (StepSubject &
      TicketOwner &
      EvidenceFence & {
        verb: "reparent";
        parent: string;
        /** The parent to restore on rollback; `""` is bd's detach form, for a bead that had none. */
        undoParent: string;
        /**
         * The run claim the HOME carried when this step was decided, or `""` —
         * {@link StepSubject.claim} for the other end of the move, re-compared under the home's own
         * write lock.
         *
         * Same blind spot as the subject's, and worse consequences: a run that claimed the home in
         * the window before its lease is published reads as unowned to {@link isInFlight}, and it
         * has already selected the tickets it will work through — so work attached now rides along
         * unrun and is stranded the moment that run settles the card.
         *
         * Only ever a claim that PREDATES the filing: `planReparent` refuses a home claimed since
         * (see {@link claimedSinceFiling}), which is what stops a newcomer's claim from being
         * recorded here as its own baseline and then compared against itself under the lock.
         */
        parentClaim: string;
        /**
         * The cluster this step is one move of, or absent for the re-parents that make no grouping
         * claim (`container-orphan`, `misfiled`) — what the write half needs to re-ask a
         * `parentless-cluster`'s two board-derived premises under the locks (apply-steps.ts
         * `assertClusterHolds`). Neither is a property of the bead being moved, so neither is
         * derivable from the step's two ends alone: the carried-ticket bar has to exclude the ask's
         * own members, and the grouping predicate reads the whole membership.
         */
        cluster?: ClusterPremise;
      })
  /**
   * The two link kinds rest on DIFFERENT evidence, and {@link EvidenceFence.kind} is what tells them
   * apart under the lock: an `implied-order` reads a phrase in one of the beads' bodies, so the write
   * re-derives it from the fresh board (apply-steps.ts `assertOrderingStated`); a `missing-order` is
   * the product master's own judgment, which no board read can restate — holding it to the phrase
   * check would refuse it forever, so it is fenced on the observation stamp instead
   * ({@link EVIDENCE_PREMISE}).
   */
  | (StepSubject & EvidenceFence & { verb: "link"; blocker: string })
  | (StepSubject &
      EvidenceFence & {
        verb: "reprioritize";
        /**
         * bd priority, 0 (critical) … 4 (lowest) — parsed from the plan's `P<n>` detail. Carries no
         * undo, unlike a re-parent: a priority proposal names exactly one bead, so its single step
         * is the whole move and a failure leaves nothing written (see apply-steps.ts `rollbackSteps`).
         */
        priority: number;
      })
  | (StepSubject & {
      verb: "unapprove";
      /**
       * What the withdrawal leaves ON the subject — the gaps that cost it its approval, written to
       * the bead itself. Without it a founder finds a target that silently left the queue: the
       * proposal explains it, but only to whoever thinks to look for the proposal.
       *
       * Re-derived from the board read taken under the subject's own lock rather than used as
       * captured (see apply-steps.ts `lockedWrite`), so it names what is wrong at the WRITE — an
       * approver who repaired one gap and introduced another must not be told about the repaired one.
       */
      note: string;
    })
  | (StepSubject & TicketOwner & EvidenceFence & { verb: "close"; reason: string })
  | (StepSubject & TicketOwner & EvidenceFence & { verb: "supersede"; replacement: string })
  | (StepSubject & TicketOwner & EvidenceFence & { verb: "defer" });

/** The one verb whose steps come in clusters — the shape both halves of the move are written in. */
export type ReparentStep = Extract<ApplyStep, { verb: "reparent" }>;

/**
 * The beads a home's CONTAINER premise — "the board already files work of this kind under it" — is
 * counted from, named so whoever re-asks it can lock them first.
 *
 * Split out from {@link ClusterPremise} because the settling half of an apply needs exactly this
 * half and none of the rest: a cluster whose every surviving member already sits under the home
 * writes no step, so it never reaches the per-step locks, yet its summary still claims the home is a
 * container (apply.ts `settleUnwritten`).
 */
export interface CarriedPremise {
  /**
   * The home's own pre-existing tickets, as the decision found them — the beads its CONTAINER
   * premise rests on, and the set the write half re-asks that premise over while holding their
   * locks (`homeCarriesNothing`'s `only`).
   *
   * A count would not survive the trip: the write half has to name the beads to lock them, and an
   * unnamed ticket can be deleted out from under the re-check between the board read and the write.
   * Narrower than "whatever the home carries at the write" on purpose — a ticket filed under the
   * home in the meantime is nothing this approval holds a lock on, so letting it carry the premise
   * would restore exactly the race the list exists to close.
   */
  carriers: string[];
  /**
   * The beads those carriers reach the home THROUGH — every ancestor between a carrier and the home
   * that is not itself a carrier (reparent.ts `carrierPaths`).
   *
   * A carrier proves nothing on its own: `cardOf` walks the whole parent chain, so a ticket counted
   * under the home reaches it only while every bead on that path survives. Deleting one takes that
   * bead's own lock alone, so the write half locks the path as well as its ends — otherwise the
   * container bar could pass on a carrier whose route to the home is cut between the read and the
   * write, which is the leaf-card landing the bar exists to stop.
   */
  carrierPaths: string[];
}

/**
 * What a cluster re-parent's two BOARD-DERIVED premises are re-asked over under the locks: the home
 * already filing work of this kind under it ({@link CarriedPremise}), and the members stating one
 * subject between them.
 *
 * Recorded per step because the write half sees one step at a time, and neither premise is a fact
 * about the bead being moved. Several lists rather than one: the count has to ignore every id the ask
 * NAMES — including the ones it has already dropped, which somebody may have filed under the home by
 * hand — while the grouping is asked of the members the decision actually kept, and both premises
 * name beads the write half has to LOCK before it can re-ask them of anything (apply-steps.ts
 * `lockedBeads`).
 */
export interface ClusterPremise extends CarriedPremise {
  /** Every id the proposal named, excluded from the home's carried-ticket count. */
  named: string[];
  /** The members the decision's regrouping kept — moving and already in place. */
  members: string[];
  /**
   * The members the board should ALREADY show under the home when this step is re-checked: the ones
   * the decision found in place, plus every earlier step of the same apply — `applySteps` runs them
   * in this order, so each step's premise names exactly what has landed by its turn.
   *
   * Their own step has run or will never run, so nothing else notices them LEAVING, and the card
   * test in {@link memberLeftCluster} structurally cannot: it reads a bead moved under a container
   * epic as still-unreachable work this very proposal is the fix for (see
   * {@link reparentPremiseGone}), which is right for a member still waiting to move and wrong for
   * one this apply already placed. Without this, detaching the landed half of a two-member cluster
   * between the writes leaves it supplying the grouping evidence for the other half's move, and the
   * proposal settles as applied with one bead under the home.
   */
  landed: string[];
}

/**
 * What a CONTENT-derived move's evidence rests on, carried forward so the locked re-read can re-ask
 * it — the {@link StepSubject.claim} treatment for the one precondition no board read re-derives.
 *
 * Every other bar such a move holds its subject to is a fact about the board's CURRENT shape:
 * status, liveness, claim, ticket set, open descendants. The premise is not — it is "nobody has
 * rewritten this bead since the pass read it" ({@link premiseTouched}), and the decision asks it
 * of the route's snapshot, which is already seconds old when the first bd write spawns. An edit
 * landing in that window rescopes the work while leaving every other bar untouched, so without this
 * the write goes ahead on evidence the edit falsified.
 *
 * Carried by every verb but `unapprove`: each rests on a reading of what the bead IS — silence, a
 * match against a twin, a commit that shipped it, a judgment of what it is worth, of what has to
 * land before it, or of which home its contract calls for — and none of those survives a rewrite.
 * The gardener's own re-parents and the `implied-order` half of `link` carry no PREMISE, because
 * their whole claim is re-derivable from a fresh board read; both steps carry the fence all the
 * same, so the kinds that aren't ({@link EVIDENCE_PREMISE}'s `missing-order` and `misfiled`) are
 * guarded rather than trusted.
 *
 * The kind (not the resolved premise) so the write re-derives through the same
 * {@link EVIDENCE_PREMISE} the decision used, and the observation stamp verbatim so both readings
 * date against the same fence. Unlike the topology re-checks, this one is a NARROWING rather than a
 * serialization: an operator's `bd update` takes no in-process lock, so the window it closes is
 * snapshot→lock, not lock→write.
 */
export interface EvidenceFence {
  /** The detection kind whose premise this rests on — {@link EVIDENCE_PREMISE}'s key. */
  kind: GardenerDetectionKind;
  /** The moment the patrol observed the board — {@link ApplyMoment.observedAtMs}, carried as-is. */
  observedAtMs: number | undefined;
}

/**
 * The run target whose TICKET SET the subject rides, or absent when the subject is its own run
 * target — its own claim is then the check — or hangs under nothing that runs.
 *
 * Carried by every verb that takes the bead OUT of that set: the retirements settle it, and a
 * RE-PARENT hands it to another target. Either way a run that has selected this ticket is left
 * shipping a bead its set no longer holds — it aborts when its claim reaches it, or, worse for a
 * move, the commit lands in the old card's PR while the bead hangs off the new one. The run target
 * is where the only liveness signal lives (see {@link ticketOwnerOf}), so it is locked and re-judged
 * alongside the subject.
 *
 * `claim` is the owner's run claim when the step was decided, re-compared under the owner's own
 * write lock exactly like {@link StepSubject.claim} — and, like a re-parent's `parentClaim`, only
 * ever a claim that PREDATES the filing, because both planners refuse an owner claimed since
 * ({@link ticketSetBusy}).
 */
export interface TicketOwner {
  owner?: { id: string; claim: string };
}

/** Everything a retirement step rests on, whatever verb it settles the subject with. */
type RetirementSubject = StepSubject & TicketOwner & EvidenceFence;

/**
 * What approving this proposal means against the board AS IT NOW IS:
 *   • `apply`  — these writes, in this order.
 *   • `settled` — the board already reads as applied (someone did it by hand, or a previous approve
 *     landed its writes and failed before closing the proposal). Nothing to write; the proposal
 *     still closes, which is what makes a retry converge instead of re-applying.
 *   • `refuse` — a precondition the plan rests on is no longer true. Nothing is written at all.
 *
 * A settlement carries whatever board-derived premise its summary rests on, exactly as a step does:
 * writing nothing is not the same as resting on nothing, and the settling half has to lock those
 * beads and re-count over them before it closes the proposal (apply.ts `settleUnwritten`).
 */
export type ApplyDecision =
  | { status: "apply"; steps: ApplyStep[]; summary: string }
  | { status: "settled"; summary: string; carried?: CarriedPremise }
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
   * When the detection READ the board — see apply.ts `observedAtOf`, which is deliberately not the
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
 *
 * `held` is the carried tickets the CALLER holds the write locks on, and narrows the home's
 * container bar to them — the same narrowing a step makes under its own locks (apply-steps.ts
 * `assertClusterHolds`). A caller holding no locks passes nothing and the bar counts freely, which
 * is right for a decision taken against a snapshot: it is deciding, not writing.
 */
export function planApply(
  plan: GardenerPlan,
  board: Bead[],
  at: ApplyMoment,
  held?: ReadonlySet<string>,
): ApplyDecision {
  const index = indexBoard(board);
  switch (plan.move) {
    case "reparent":
      return planReparent(plan, index, at, held);
    case "link":
      return planLink(plan, index, at);
    case "retire":
      return planRetire(plan, index, at);
    case "reprioritize":
      return planReprioritize(plan, index, at);
    case "unapprove":
      return planUnapprove(plan, index, at);
    case "split":
      // The one move anton never runs. Decomposing a ticket writes new contracts — `/shape`'s work,
      // and a human's call — so the proposal carries the sketch and the evidence, and settling it is
      // a DECLINE. Refusing here rather than at emission is what keeps the ask on the board.
      return {
        status: "refuse",
        reason: `splitting ${list(plan.subjects)} means writing new contracts, which anton will not do on its own — decompose it with \`/shape\` (the proposal's sketch is the starting point) and decline this proposal`,
      };
  }
}

// ── re-parent ──

function planReparent(
  plan: GardenerPlan,
  index: BoardIndex,
  at: ApplyMoment,
  held?: ReadonlySet<string>,
): ApplyDecision {
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
  const unusable = homeRefusal(plan, target, index, at, held);
  if (unusable) return { status: "refuse", reason: unusable };
  return reparentSteps(plan, target, index, at);
}

/**
 * Why work cannot be hung under this home at all, or undefined — the bars asked once, before any
 * subject is MOVED. The first two hold for the whole cluster; the tier bar is asked of each subject
 * in turn, because which home the taxonomy demands depends on what is being moved.
 */
function homeRefusal(
  plan: GardenerPlan,
  target: Bead,
  index: BoardIndex,
  at: ApplyMoment,
  held?: ReadonlySet<string>,
): string | undefined {
  // The home's own state — settled, or owned by a run. Shared with the under-lock re-check in
  // `applyStep`, so the snapshot decision and the write refuse the same home for the same reason.
  //
  // Then the home's half of the claim window no liveness signal covers — and the check the step's
  // `parentClaim` baseline rests on. A run that picked the target up AFTER the filing reads as free
  // to `homeUnusable`, so without this the step would record that newcomer's claim as its own
  // baseline and the under-lock re-check ({@link homeClaimed}) would compare it against itself and
  // wave the move through, hanging tickets under a run that has already chosen what it will run.
  //
  // Then the CONTAINER bar the cluster detector chose this home on — the one thing about the home
  // that nothing downstream re-asks, because the survivor re-check reads titles and labels alone.
  const gone =
    homeUnusable(target, at.nowMs) ??
    claimedSinceFiling(target, at, "hanging work under it", CLAIM_COST.home) ??
    homeStoppedCarrying(plan, target, index, held);
  if (gone) return gone;
  // Then the tier the taxonomy demands of a home, asked SUBJECT BY SUBJECT: a working-layer bead
  // wants the board card that runs it, a card wants the container epic that groups it, and one
  // cluster's members need not sit in the same tier.
  for (const id of plan.subjects) {
    const subject = index.byId.get(id);
    // A subject that has left the board is `reparentSubject`'s refusal to name, not this one's.
    if (!subject) continue;
    // Nor is one that has left the working layer: it is dropped from the move rather than moved
    // (see {@link clusterMemberLeftLayer}), and asking the tier question of it here would refuse
    // the whole cluster over a bead nothing is going to write to.
    if (clusterMemberLeftLayer(plan, subject)) continue;
    const wrongTier = homeWrongTier(subject, target, index, HOME_STANDING.snapshot);
    if (wrongTier) return wrongTier;
  }
  return undefined;
}

/**
 * The CONTAINER half of a cluster's "obvious home", asked of the snapshot. Asked of
 * `parentless-cluster` alone: no other kind chose its home on this evidence.
 *
 * `held` narrows the count to the tickets a locked caller can prove nothing is deleting under it
 * (see {@link homeCarriesNothing}'s `only`).
 */
function homeStoppedCarrying(
  plan: GardenerPlan,
  home: Bead,
  index: BoardIndex,
  held?: ReadonlySet<string>,
): string | undefined {
  if (plan.kind !== "parentless-cluster") return undefined;
  return homeCarriesNothing(home, index, new Set(plan.subjects), held);
}

/**
 * Why this home no longer carries work of its own, or undefined — the CONTAINER half of the
 * cluster detector's "obvious home" (reparent.ts {@link MIN_CARRIED_TICKETS}), re-asked against the
 * board the writes would land on.
 *
 * It is the one premise of a `parentless-cluster` no per-bead check restates: {@link homeUnusable}
 * asks only whether the card is still open and free, and {@link regroupSurvivors} re-derives the
 * MEMBERS' half from titles and labels. So a card whose last ticket was deleted or re-homed between
 * the filing and the approval would take the cluster anyway — and hanging one off a leaf card is
 * exactly what the bar exists to stop: it turns one PR's worth of work into somebody else's epic.
 *
 * `named` is every id the ask names, and they are excluded from the count — along with everything
 * riding on them (reparent.ts `ridesOnNamed`), because `cardOf` walks the whole chain and a named
 * member's own children reach the home only THROUGH it. A member somebody filed under the home by
 * hand since the proposal rides that card now, so counting it or its subtree would let the ask prove
 * its own premise with the very move it is asking for — as would an EARLIER step of the same
 * cluster, which is why the write half re-asks this with the same set (apply-steps.ts
 * `assertClusterHolds`) rather than with whatever is left to move.
 *
 * `only` narrows the count to the tickets the caller HOLDS THE LOCKS ON, and the write half always
 * passes it (see {@link ClusterPremise.carriers}). Counting freely there would leave the premise
 * resting on beads nothing serialized: `deleteTicket` takes the deleted ticket's own lock and no
 * other (`ticket-detail.ts`), so the home's lock does not order a deletion against this read, and
 * the last qualifying ticket could go between the board read and the write — landing the cluster on
 * a leaf card after all. Restricted to the locked set, a ticket that still counts here cannot be
 * deleted, re-homed or retyped until this step has written, because all three take its own lock.
 */
export function homeCarriesNothing(
  home: Bead,
  index: BoardIndex,
  named: ReadonlySet<string>,
  only?: ReadonlySet<string>,
): string | undefined {
  const carried = carriedTickets(index, home.id, named).filter((id) => only?.has(id) ?? true);
  if (carried.length >= MIN_CARRIED_TICKETS) return undefined;
  const lost = only
    ? `no longer carries the tickets this proposal was decided against`
    : `carries no tickets of its own any more`;
  return `${home.id} ${lost} — it was an obvious home only because the board already filed work of this kind under it, and a card carrying none is one PR's worth of work; hanging a cluster off it now would turn it into a container epic, so decline it and re-parent by hand if ${home.id} is still the right home`;
}

/** A subject no longer part of the claim: the board answered it after the proposal was filed. */
interface Answered {
  answered: string;
}

/** A subject that already sits under the home: nothing to write, but still one of the cluster. */
interface InPlace {
  inPlace: Bead;
}

/**
 * One step per subject that still has to move — the whole cluster, or the first refusal it hits.
 *
 * A member the board has ANSWERED since the filing is dropped from the move rather than refusing it
 * (see {@link Answered}). A cluster's membership is not its identity any more (anton-9hpp), so one
 * stale member used to make the whole proposal unapplyable forever while its own fingerprint went on
 * suppressing the fresh, valid cluster the next patrol derived. Dropping it preserves exactly the
 * property the refusal was protecting — the newer decision is never written over — while leaving the
 * members nobody has answered movable.
 *
 * When nothing is left to move, {@link nothingLeftToMove} answers the ask from what the board now
 * holds.
 */
function reparentSteps(
  plan: GardenerPlan,
  home: Bead,
  index: BoardIndex,
  at: ApplyMoment,
): ApplyDecision {
  const moves: ReparentStep[] = [];
  const answered: string[] = [];
  // Members that already sit under the home. They are written to by nobody, but they ARE the cluster
  // the proposal asked for, so they count towards the subject the survivors must still state between
  // them — a cluster half-applied by hand is still a cluster.
  const inPlace: Bead[] = [];
  for (const id of plan.subjects) {
    const moved = reparentSubject(plan, id, home, index, at);
    if (typeof moved === "string") return { status: "refuse", reason: moved };
    if ("inPlace" in moved) inPlace.push(moved.inPlace);
    else if ("answered" in moved) answered.push(moved.answered);
    else moves.push(moved);
  }
  const survivors = regroupSurvivors(plan, home, moves, inPlace, index);
  const steps = survivors.steps;
  if (steps.length === 0) {
    return nothingLeftToMove(plan, home, inPlace, answered, survivors, index);
  }
  const left = answered.length + survivors.dropped.length;
  const skipped = left > 0 ? ` (${left} member(s) no longer in the cluster)` : "";
  return {
    status: "apply",
    steps,
    summary: `re-parented ${list(steps.map((s) => s.id))} under ${home.id}${skipped}`,
  };
}

/**
 * What an approved re-parent with no move left to make ANSWERS with.
 *
 * The cluster the board ALREADY holds is asked first, and settles it. Members somebody filed under
 * the home by hand are the outcome this ask wanted, so once what sits there still states one subject
 * ({@link clusterStandsInPlace}) there is nothing to write and nothing left to ask. Reporting a
 * departed member's refusal instead is a proposal no approval can ever settle: the valid cluster is
 * on the board, so every later approve reaches the same refusal and the ask stays open until a human
 * declines it by hand.
 *
 * Failing that, the board's own answer stands: a cluster the regrouping unravelled reads as
 * dissolved, which is a better answer for an approver than the departure that started the
 * unravelling; and a member the board answered is reported as the refusal it is, because no write
 * happened and an approver reading "settled" would be told the ask landed under a target it never
 * reached.
 *
 * A cluster left with no answer at all — every member moved home by hand, and then retitled out of
 * the subject they shared — is REFUSED rather than settled ({@link clusterUnravelledInPlace}). What
 * sits under the home is not the cluster this ask was decided on, so a fresh patrol would propose
 * nothing, and closing it as applied would put the gardener's name on a grouping nobody derived.
 */
function nothingLeftToMove(
  plan: GardenerPlan,
  home: Bead,
  inPlace: Bead[],
  answered: string[],
  survivors: Survivors,
  index: BoardIndex,
): ApplyDecision {
  // The container premise rides the settlement the way it rides a step: this path writes no step, so
  // it is the settling half that has to lock these carriers and re-count over them before it closes
  // the proposal as applied (apply.ts `settleUnwritten`).
  if (clusterStandsInPlace(plan, home, inPlace)) {
    return settledInPlace(inPlace, home.id, carriedPremise(home, index, new Set(plan.subjects)));
  }
  if (survivors.dropped.length > 0) {
    return { status: "refuse", reason: clusterDissolved(home, survivors.dropped) };
  }
  const [firstAnswer] = answered;
  if (firstAnswer) return { status: "refuse", reason: firstAnswer };
  if (plan.kind === "parentless-cluster") {
    return { status: "refuse", reason: clusterUnravelledInPlace(home, inPlace) };
  }
  return settledInPlace(inPlace, home.id);
}

/**
 * How a cluster already sitting where it asked to sit, yet no longer stating one subject, reads to
 * the approver — the in-place twin of {@link clusterMemberUngrouped}, named over the whole set
 * because none of these beads is being written to.
 */
function clusterUnravelledInPlace(home: Bead, inPlace: Bead[]): string {
  const sit = inPlace.length === 1 ? "sits" : "sit";
  return `${list(inPlace.map((b) => b.id))} already ${sit} under ${home.id} but no longer state a subject ${home.id} states too — a title or \`area:\` label was edited since this proposal was decided, and it takes ${MIN_CLUSTER_SIZE} beads stating one subject before a home is obvious; nothing was written, so decline it and re-parent by hand if ${home.id} is still the right home`;
}

/**
 * Do the members already under the home still form a cluster on their own — {@link regroupSurvivors}'s
 * question, asked of the beads that need no write?
 *
 * `groupedUnder` reaches a bead only through a group of at least {@link MIN_CLUSTER_SIZE}, so a
 * non-empty answer IS the cluster the proposal asked for, sitting where it asked for it.
 */
function clusterStandsInPlace(plan: GardenerPlan, home: Bead, inPlace: Bead[]): boolean {
  if (plan.kind !== "parentless-cluster") return false;
  return groupedUnder(home, inPlace).size > 0;
}

/**
 * The home's carried tickets and the beads they reach it through, as the decision found them — what
 * a cluster's container premise is counted from, and the beads whoever re-asks it has to lock
 * ({@link CarriedPremise}).
 */
function carriedPremise(home: Bead, index: BoardIndex, named: ReadonlySet<string>): CarriedPremise {
  const carriers = carriedTickets(index, home.id, named);
  return { carriers, carrierPaths: carrierPaths(index, home.id, carriers) };
}

/** What is left of a cluster once the members that no longer state its subject are dropped. */
interface Survivors {
  steps: ReparentStep[];
  /** The ids the grouping dropped — what {@link clusterDissolved} names when nothing is left. */
  dropped: string[];
}

/**
 * The survivors re-asked the detector's own question: do these beads still state one subject their
 * home states too (reparent.ts `groupedUnder`)?
 *
 * A proposal's subjects are the UNION of every topic group the home hosts, so one proposal can carry
 * an escalation pair and a docker pair. Lose one member of each and two unrelated survivors still
 * clear a raw {@link MIN_CLUSTER_SIZE} count, while a fresh patrol — which groups before it counts —
 * would emit nothing at all. Counting is therefore not enough: the grouping predicate has to be
 * recomputed over whoever is left.
 *
 * A member no surviving group reaches is DROPPED rather than fatal, exactly like a closed or re-homed
 * one: its evidence left with the members it agreed with, and refusing over it would hold the pair
 * that still agrees hostage while the target-only fingerprint suppressed their fresh proposal.
 *
 * The membership this settles on rides every surviving step ({@link ClusterPremise}), because it is
 * what the write half re-asks this same question of under the locks — a title or `area:` edit landing
 * in the window between the two is invisible to every other bar a step holds.
 */
function regroupSurvivors(
  plan: GardenerPlan,
  home: Bead,
  steps: ReparentStep[],
  inPlace: Bead[],
  index: BoardIndex,
): Survivors {
  if (plan.kind !== "parentless-cluster") return { steps, dropped: [] };
  const moving = steps.flatMap((step) => {
    const subject = index.byId.get(step.id);
    return subject ? [subject] : [];
  });
  const grouped = groupedUnder(home, [...moving, ...inPlace]);
  const named = new Set(plan.subjects);
  const premise = {
    named: [...named],
    members: [...grouped].sort(),
    ...carriedPremise(home, index, named),
  };
  // Grows with the writes: the decision's in-place members have landed before the first step runs,
  // and each step adds its own subject for the ones after it (see {@link ClusterPremise.landed}).
  const landed = inPlace.filter((member) => grouped.has(member.id)).map((member) => member.id);
  return {
    steps: steps
      .filter((step) => grouped.has(step.id))
      .map((step) => {
        const cluster: ClusterPremise = { ...premise, landed: [...landed] };
        landed.push(step.id);
        return { ...step, cluster };
      }),
    dropped: steps.filter((step) => !grouped.has(step.id)).map((step) => step.id),
  };
}

/**
 * How a cluster that no longer holds together reads to the approver who has to decide it.
 *
 * `detectParentlessClusters` needs {@link MIN_CLUSTER_SIZE} loose beads stating one subject their
 * home states too before it will call a home obvious — a single loose bead sharing a topic with a
 * card is the weak evidence this whole detector was rebuilt to stop proposing on (anton-9hpp).
 * Dropping members must not smuggle the move below that bar, and {@link regroupSurvivors} asks the
 * detector's own predicate rather than a count, so a two-member cluster with one member re-homed and
 * a four-member one whose two pairs each lost a member both land here.
 */
function clusterDissolved(home: Bead, left: string[]): string {
  return `${list(left)} is all that is left of this cluster — it takes ${MIN_CLUSTER_SIZE} beads stating one subject ${home.id} states too before a home is obvious, and whatever changed since the filing is the newer reading of where this work belongs; decline it, and re-parent by hand if ${home.id} is still the right home`;
}

/**
 * Why the CLUSTER this step is one move of no longer holds, or undefined — the detector's own
 * grouping predicate (reparent.ts {@link groupedUnder}), re-asked over the whole recorded membership
 * as it now reads.
 *
 * The decision asks it of the approval's snapshot ({@link regroupSurvivors}); the write re-asks it
 * because the evidence is TITLES and `area:` labels, which every other bar a step holds is blind to
 * — a rename leaves the bead open, unclaimed, unmoved and the right tier, and the move then lands a
 * bead under a card it no longer shares a subject with.
 *
 * Asked of the WHOLE membership rather than of this step's subject alone, because the per-step locks
 * are released between the writes. Two questions come out of that:
 *
 *   • has a member the board ALREADY has under the home stopped stating the subject? That one is the
 *     damage, and nothing else is left to notice it: an earlier step of this apply put it there (or
 *     the decision counted it in place), and a check that only asked whether `subjectId` reached
 *     some group would pass every later step of a three-member cluster whose first member was
 *     retitled after its move — settling the proposal over a bead beneath a card it no longer
 *     belongs to.
 *   • is the subject about to be written still grouped — over the members still IN the cluster,
 *     which is what {@link memberLeftCluster} drops, so a lone survivor cannot be carried past a bar
 *     a fresh patrol would refuse.
 *
 * A member somebody has re-homed since is left where they put it: that is a newer decision than this
 * proposal, and the rollback deliberately does not fight it (apply-steps.ts `rollbackStep`). What it
 * no longer does is carry the grouping — the whole cluster is refused instead, so the rest of it is
 * not landed on evidence the board has withdrawn. Every member not yet under the home is its own
 * step besides, re-read under its own lock when its turn comes — so this is the only place the ones
 * already there are judged at all.
 */
export function clusterUngrouped(
  subjectId: string,
  home: Bead,
  cluster: ClusterPremise,
  index: BoardIndex,
  at: ApplyMoment,
): string | undefined {
  const inCluster = cluster.members.flatMap((id) => {
    const member = index.byId.get(id);
    return member && !memberLeftCluster(member, home, cluster, index, at) ? [member] : [];
  });
  const grouped = groupedUnder(home, inCluster);
  // Asked of the members still IN the cluster: one that left it by being closed or claimed is not a
  // bead whose SUBJECT changed, and naming an edit that never happened would send the approver
  // looking for it. It sits where the proposal wanted it, and the dissolution below is its reading.
  const strayed = inCluster.find(
    (m) => m.id !== subjectId && !grouped.has(m.id) && sitsUnder(index, m.id, home.id),
  );
  if (strayed) return clusterMemberStrayed(strayed.id, home);
  if (grouped.has(subjectId)) return undefined;
  // Which refusal the approver reads turns on WHY the grouping came apart: an edit to the beads
  // themselves, or members that left the cluster and took their half of the evidence with them.
  return inCluster.length === cluster.members.length
    ? clusterMemberUngrouped(subjectId, home)
    : clusterDissolved(
        home,
        inCluster.map((member) => member.id),
      );
}

/** Is this member already where the cluster's move puts it — by an earlier step of it, or by hand? */
function sitsUnder(index: BoardIndex, id: string, homeId: string): boolean {
  const member = index.byId.get(id);
  return member !== undefined && beads.parentOf(member) === homeId;
}

/** Why this member no longer states the subject the cluster is grouped on. */
const clusterMemberUngrouped = (id: string, home: Bead): string =>
  `${id} no longer states a subject the rest of this cluster and ${home.id} hold in common — a title or \`area:\` label was edited since this proposal was decided, and it takes ${MIN_CLUSTER_SIZE} beads stating one subject ${home.id} states too before a home is obvious`;

/** The same, for a member this apply has already landed under the home — the one it cannot leave. */
const clusterMemberStrayed = (id: string, home: Bead): string =>
  `${clusterMemberUngrouped(id, home)}, and it already sits under ${home.id} — landing the rest of this cluster would leave it beneath a card whose work it is no longer part of`;

/**
 * Has this member left the cluster since the decision, by any of the ways the decision itself drops
 * one — settled, promoted out of the working layer, picked up by a run, or given another card?
 *
 * The same questions {@link clusterMemberGone}, {@link clusterMemberLeftLayer} and
 * {@link reparentPremiseGone} ask of a subject, asked here of the members whose own step has already
 * run or will never run — the claim half through {@link subjectBusy}, exactly as the decision asks
 * it. A live lease alone is not enough: `bd update --claim` writes the assignee and `in_progress` a
 * moment before its run publishes one, and a member picked up in that window would otherwise go on
 * supplying the grouping evidence that carries everybody else's move (reparent.ts `isFree` excludes
 * it from the cluster at detection for the same reason). Dating it against the filing keeps the
 * baseline honest — a claim the plan itself saw is the thing being proposed against, not news.
 *
 * A member already LANDED under the home ({@link ClusterPremise.landed}) is held to one bar more: it
 * must still sit there.
 */
function memberLeftCluster(
  member: Bead,
  home: Bead,
  cluster: ClusterPremise,
  index: BoardIndex,
  at: ApplyMoment,
): boolean {
  if (!isOpenWork(member) || !isClusterTier(member)) return true;
  if (subjectBusy(member, at, DOING.reparent)) return true;
  if (cluster.landed.includes(member.id)) return beads.parentOf(member) !== home.id;
  const card = index.cards.cardOf(member);
  return card !== undefined && card !== home.id;
}

/**
 * What one member of a cluster resolves to: a refusal reason, the step that moves it, the answer
 * that drops it, or the bead itself when it already sits where the proposal wants it.
 */
function reparentSubject(
  plan: GardenerPlan,
  id: string,
  home: Bead,
  index: BoardIndex,
  at: ApplyMoment,
): string | ReparentStep | Answered | InPlace {
  const subject = index.byId.get(id);
  // A DELETED member left the cluster as surely as a closed or re-homed one, so for the kind whose
  // claim is its target it is answered rather than fatal — refusing here would hold the members
  // nobody touched hostage to a bead that no longer exists, while the proposal's own fingerprint
  // suppressed the fresh cluster the survivors form. Every other kind names the bead its move is
  // ABOUT, so a missing subject is still the board changing out from under the ask.
  if (!subject) return clusterMemberDeleted(plan, id) ?? missing(id);
  const currentParent = beads.parentOf(subject) ?? "";
  if (currentParent === home.id) return clusterMemberInPlace(plan, subject, at);
  // Asked before every safety bar because they are not ones: they decide whether this bead is still
  // part of the claim at all, and a bead nothing will write to cannot be unsafe to leave alone.
  const answered =
    reparentPremiseGone(plan, subject, index) ??
    clusterMemberLeftLayer(plan, subject) ??
    clusterMemberGone(plan, subject, at);
  if (answered) return { answered };
  const barred = reparentBarred(plan, subject, home, index, at);
  if (barred) return barred;
  return {
    verb: "reparent",
    id,
    claim: runClaimOf(subject),
    parent: home.id,
    undoParent: currentParent,
    parentClaim: runClaimOf(home),
    // The set the subject is LEAVING — the third bead this move rests on, locked and re-judged with
    // the other two (see {@link TicketOwner}).
    owner: ownerRef(ticketOwnerOf(index, subject)),
    kind: plan.kind,
    observedAtMs: at.observedAtMs,
  };
}

/**
 * What a member that ALREADY sits under the home resolves to: the cluster it half-applies, or the
 * answer that drops it.
 *
 * Nothing is written to such a bead, but it still COUNTS — towards the subject the survivors must
 * state between them ({@link regroupSurvivors}) and towards the floor below which the cluster has
 * dissolved. So the same question every other member is asked has to be asked of it: is it still one
 * of the loose beads the cluster was derived from? Closed, claimed, or promoted out of the working
 * layer, it left the cluster exactly as a re-homed member does — and counting it there would carry
 * a lone survivor past a bar a fresh patrol would refuse.
 *
 * {@link reparentPremiseGone} is deliberately NOT asked: the card it now rides is the home, which is
 * the outcome this proposal wanted, not a newer decision to preserve.
 */
function clusterMemberInPlace(
  plan: GardenerPlan,
  subject: Bead,
  at: ApplyMoment,
): Answered | InPlace {
  const answered = clusterMemberLeftLayer(plan, subject) ?? clusterMemberGone(plan, subject, at);
  return answered ? { answered } : { inPlace: subject };
}

/** Why this subject cannot be moved under this home, or undefined. */
function reparentBarred(
  plan: GardenerPlan,
  subject: Bead,
  home: Bead,
  index: BoardIndex,
  at: ApplyMoment,
): string | undefined {
  if (!isOpenWork(subject)) {
    return `${subject.id} is ${settledWord(subject)} — the board moved on since this was proposed`;
  }
  // The subject's own signals, then the ticket set it rides — the half no per-bead signal shows, and
  // the one a MOVE raids exactly as a retirement does (see {@link ticketSetBusy}).
  //
  // Then the premise, at whichever end of the move states one. A `misfiled` claim is a MATCH between
  // two contracts — this bead belongs under that home — so a rewrite of either falsifies it, and no
  // board read restates the judgment the way `reparentPremiseGone` restates the gardener's. Asked
  // here rather than in `homeRefusal` so a subject somebody has already moved home SETTLES: the
  // outcome the ask wanted is the board's state, and refusing over a stamp would leave it open
  // forever against a board that already agrees with it.
  const busy =
    subjectBusy(subject, at, DOING.reparent) ??
    ticketSetBusy(index, subject, at, movingTicket(subject.id)) ??
    premiseTouched(subject, EVIDENCE_PREMISE[plan.kind], at.observedAtMs) ??
    carrierMoved(plan, subject, home, index, at) ??
    premiseTouched(home, EVIDENCE_PREMISE[plan.kind]?.twin, at.observedAtMs);
  if (busy) return busy;
  // A parent that sits UNDER one of the subjects would make the subtree its own ancestor.
  if (index.isAncestor(subject.id, home.id)) {
    return `${home.id} sits under ${subject.id} — re-parenting it there would make the subtree its own ancestor`;
  }
  return undefined;
}

/**
 * The subjects that already sit under the target: the ask is answered and nothing is written. Named
 * from the beads that ARE there rather than from the plan, because a member the board answered
 * elsewhere is not one of them and telling an approver it sits under the target would be false.
 */
function settledInPlace(
  inPlace: Bead[],
  target: string,
  carried?: CarriedPremise,
): ApplyDecision {
  const sit = inPlace.length === 1 ? "sits" : "sit";
  return {
    status: "settled",
    summary: `${list(inPlace.map((b) => b.id))} already ${sit} under ${target}`,
    ...(carried ? { carried } : {}),
  };
}

// ── link ──

function planLink(plan: GardenerPlan, index: BoardIndex, at: ApplyMoment): ApplyDecision {
  const [id] = plan.subjects;
  if (plan.subjects.length !== 1 || !id) {
    return { status: "refuse", reason: "a link proposal names exactly one blocked bead" };
  }
  if (!plan.target) return { status: "refuse", reason: "this proposal names no blocker to record" };
  return linkPair(plan, id, plan.target, index, at);
}

/** The ordering ask decided against the pair it names, both ends resolved on the board. */
function linkPair(
  plan: GardenerPlan,
  id: string,
  blockerId: string,
  index: BoardIndex,
  at: ApplyMoment,
): ApplyDecision {
  const blocked = index.byId.get(id);
  if (!blocked) return { status: "refuse", reason: missing(id) };
  const blocker = index.byId.get(blockerId);
  if (!blocker) return { status: "refuse", reason: missing(blockerId) };
  const drawn = edgeAlreadyDrawn(id, blockerId, index);
  if (drawn) return drawn;
  const barred = linkBarred(plan, blocked, blocker, index, at);
  if (barred) return { status: "refuse", reason: barred };
  return {
    status: "apply",
    steps: [
      {
        verb: "link",
        id,
        claim: runClaimOf(blocked),
        blocker: blockerId,
        kind: plan.kind,
        observedAtMs: at.observedAtMs,
      },
    ],
    summary: `recorded that ${blockerId} blocks ${id}`,
  };
}

/** What the edges already on this pair answer the ask with, or undefined when none of them do. */
function edgeAlreadyDrawn(
  id: string,
  blockerId: string,
  index: BoardIndex,
): ApplyDecision | undefined {
  // The edge the proposal asked for is already drawn: the ordering is recorded, so there is nothing
  // to write and the ask is answered.
  if (index.recordsBlocker(id, blockerId)) {
    return { status: "settled", summary: `a blocks edge already records ${blockerId} → ${id}` };
  }
  // The OPPOSITE edge is not this ask half-done — it is someone's explicit decision that the ordering
  // runs the other way, made after this was filed. Settling on it would close the proposal claiming
  // an edge the board does not hold, and writing ours would fight the human who drew theirs. Refuse,
  // and let them re-decide against the contradiction.
  if (index.hasBlocksEdge(id, blockerId)) {
    return {
      status: "refuse",
      reason: `the board records the opposite ordering — ${id} blocks ${blockerId} — which is someone's explicit decision; recording ${blockerId} as ${id}'s blocker would contradict it`,
    };
  }
  // bd stores ONE edge per directed pair: a pair that already carries `discovered-from` answers
  // `bd link --type blocks` with "already exists with type discovered-from … remove it first" rather
  // than replacing the edge. `canOrder` bars the pair at filing time; an edge drawn since would
  // otherwise leave this ask failing on every approve until a human declined it (anton-wsap).
  if (index.recordsDiscovery(id, blockerId)) {
    return {
      status: "refuse",
      reason: `the board already records ${id} as discovered from ${blockerId}, and bd keeps one edge per pair — it refuses to write a blocks edge over that provenance, so this ask can only fail; drop the discovered-from edge by hand first if the ordering is what you want recorded`,
    };
  }
  return undefined;
}

/** Why the ordering edge cannot be drawn between these two, or undefined. */
function linkBarred(
  plan: GardenerPlan,
  blocked: Bead,
  blocker: Bead,
  index: BoardIndex,
  at: ApplyMoment,
): string | undefined {
  if (!isOpenWork(blocked)) {
    return `${blocked.id} is ${settledWord(blocked)} — an ordering edge would constrain nothing`;
  }
  // `blockerUnusable` is shared with the under-lock re-check in `applyStep` for the same reason the
  // home bar is. Only the blocked bead is WRITTEN to, so a run holding the blocker is no obstacle —
  // but a run executing the blocked bead is: recording an ordering edge against it would tell every
  // other reader that live work is waiting on something.
  //
  // Then the premise no board read restates: a `missing-order` is the product master's judgment
  // about the bead as it read that night, and every bar above asks only whether the pair is still
  // writable — which a rescoping edit leaves untouched. Without it, approving a months-old ordering
  // ask would constrain work somebody has since rewritten. (`implied-order`'s premise IS re-derived,
  // by {@link linkPremiseGone}.)
  const gone =
    blockerUnusable(blocker, blocked.id) ??
    subjectBusy(blocked, at, "recording it as blocked") ??
    linkPremiseGone(plan, blocked.id, index) ??
    premiseTouched(blocked, EVIDENCE_PREMISE[plan.kind], at.observedAtMs);
  if (gone) return gone;
  // The blocker already waits on the blocked bead through other beads: no direct edge, so the pair
  // read as unrelated above, but this edge would close the loop — and bd rejects a blocking cycle at
  // every write path, so applying it would only 500 and leave the proposal open forever.
  if (index.isBlockedBy(blocker.id, blocked.id)) {
    return `${blocker.id} is already blocked by ${blocked.id} through other beads — recording ${blocker.id} as ${blocked.id}'s blocker would close a dependency cycle, which bd refuses to write`;
  }
  return undefined;
}

// ── re-prioritize ──

/**
 * A priority change (anton-d2sx) — the one move that rewrites a FIELD rather than the graph.
 *
 * It holds the subject to the same bars every other move does — on the board, open, not mid-run,
 * not claimed since the filing. What it does NOT need is the stranding and ancestry machinery the
 * graph verbs carry: a priority touches one field on one bead and moves nothing, so nothing can be
 * left hanging by it.
 */
function planReprioritize(plan: GardenerPlan, index: BoardIndex, at: ApplyMoment): ApplyDecision {
  const [id] = plan.subjects;
  const priority = priorityOf(plan);
  if (plan.subjects.length !== 1 || !id) {
    return { status: "refuse", reason: "a priority proposal names exactly one bead" };
  }
  if (priority === undefined) {
    return { status: "refuse", reason: "this proposal names no priority to move the bead to" };
  }
  const subject = index.byId.get(id);
  if (!subject) return { status: "refuse", reason: missing(id) };
  return reprioritizeSubject(plan, subject, priority, at);
}

/**
 * The re-ranking decided against the bead itself. A subject already AT the asked-for priority
 * settles BEFORE the evidence fence is consulted — the outcome is the board's state whoever put it
 * there, and refusing over a stamp would leave the ask open forever on a board that already agrees
 * with it.
 */
function reprioritizeSubject(
  plan: GardenerPlan,
  subject: Bead,
  priority: number,
  at: ApplyMoment,
): ApplyDecision {
  if (subject.priority === priority) {
    return { status: "settled", summary: `${subject.id} is already at priority ${plan.detail}` };
  }
  const barred = reprioritizeBarred(plan, subject, at);
  if (barred) return { status: "refuse", reason: barred };
  return {
    status: "apply",
    steps: [
      {
        verb: "reprioritize",
        id: subject.id,
        claim: runClaimOf(subject),
        priority,
        kind: plan.kind,
        observedAtMs: at.observedAtMs,
      },
    ],
    summary: `moved ${subject.id} ${fromPriority(subject)}to ${plan.detail}`,
  };
}

/**
 * Why this bead cannot be re-ranked, or undefined. The evidence fence matters more here than
 * anywhere else: a priority is what anyone editing a bead is most likely to touch by hand, and the
 * pass's judgment was made about the bead as it read that night.
 */
function reprioritizeBarred(
  plan: GardenerPlan,
  subject: Bead,
  at: ApplyMoment,
): string | undefined {
  if (!isOpenWork(subject)) {
    return `${subject.id} is ${settledWord(subject)} — a priority would rank nothing`;
  }
  return (
    subjectBusy(subject, at, DOING.reprioritize) ??
    premiseTouched(subject, EVIDENCE_PREMISE[plan.kind], at.observedAtMs)
  );
}

/** Where the bead is ranked now, as the summary reads it — omitted when it carries no priority. */
const fromPriority = (subject: Bead): string =>
  typeof subject.priority === "number" ? `from P${subject.priority} ` : "";

// ── unapprove ──

/**
 * Withdrawing an approval that has stopped holding (anton-xg5y) — the one move that writes a CONTROL
 * label rather than the graph, a field or a status.
 *
 * Its premise is re-derived rather than fenced, which is what makes "fix or unapprove" two real
 * answers instead of one. The ask is "this target no longer clears the approve gate", and the gate is
 * a pure function of the board ({@link approvalGaps}) — so approving after a REPAIR settles the
 * proposal with the approval intact, and approving while it is still broken strips the label. An
 * evidence fence would have refused both: repairing a bead is itself a write since the filing, so the
 * one outcome the proposal most wants would have been the one it could never record.
 */
function planUnapprove(plan: GardenerPlan, index: BoardIndex, at: ApplyMoment): ApplyDecision {
  const [id] = plan.subjects;
  if (plan.subjects.length !== 1 || !id) {
    return { status: "refuse", reason: "an approval proposal names exactly one bead" };
  }
  const subject = index.byId.get(id);
  if (!subject) return { status: "refuse", reason: missing(id) };
  return unapproveSubject(subject, index, at);
}

/**
 * The withdrawal decided against the target itself. The safety bars are the usual ones with one edge
 * sharpened: withdrawing `approved` under a live run does not merely race it, it KILLS it —
 * execute-epic re-reads approval after its claim settles and poisons the run when the label is gone.
 * So a claimed subject refuses like everywhere else, and the next pass re-asks once the run lets go.
 */
function unapproveSubject(subject: Bead, index: BoardIndex, at: ApplyMoment): ApplyDecision {
  // Nothing left to withdraw: a settled bead queues no run, and a label somebody has already dropped
  // by hand is the outcome this ask wanted, whoever wrote it.
  if (!isOpenWork(subject)) {
    return {
      status: "settled",
      summary: `${subject.id} is ${settledWord(subject)} — its approval queues nothing`,
    };
  }
  if (!beads.isApproved(subject)) {
    return { status: "settled", summary: `${subject.id} no longer carries \`${LABELS.approved}\`` };
  }
  const busy = subjectBusy(subject, at, DOING.unapprove, CLAIM_COST.approval);
  if (busy) return { status: "refuse", reason: busy };

  const gaps = approvalGaps(subject, index.all);
  if (gaps.length === 0) {
    return {
      status: "settled",
      summary: `${subject.id} meets the approve gate again — the gaps were repaired, so the approval stands`,
    };
  }
  return {
    status: "apply",
    steps: [
      { verb: "unapprove", id: subject.id, claim: runClaimOf(subject), note: unapproveNote(gaps) },
    ],
    summary: `withdrew the approval on ${subject.id} — ${formatApprovalGaps(gaps)}`,
  };
}

/**
 * What a withdrawal writes onto the SUBJECT: why the label went, and how to get it back. Prefixed
 * like every other note this module leaves ({@link notePrefix}), off the kind rather than a literal,
 * so the producer a reader sees is the one that filed the ask.
 */
export function unapproveNote(gaps: ApprovalGap[]): string {
  return (
    `${namespaceOf("degraded-approval")}: approval withdrawn by an approved proposal — ` +
    `${formatApprovalGaps(gaps)}. Fix those and approve it again; nothing else about the bead changed.`
  );
}

// ── retire ──

function planRetire(plan: GardenerPlan, index: BoardIndex, at: ApplyMoment): ApplyDecision {
  const [id] = plan.subjects;
  if (plan.subjects.length !== 1 || !id) {
    return { status: "refuse", reason: "a retirement proposal names exactly one bead" };
  }
  const subject = index.byId.get(id);
  if (!subject) return { status: "refuse", reason: missing(id) };
  return (
    retirementSettled(plan, subject, index) ??
    retirementBarred(plan, subject, index, at) ??
    retirementSteps(plan, subject, index, at)
  );
}

/**
 * The outcome this retirement wanted, already on the board — or undefined when there is still
 * something to write. Settled by whatever means: the outcome the proposal wanted is the board's
 * state, so there is nothing to write and no reason to keep asking.
 */
function retirementSettled(
  plan: GardenerPlan,
  subject: Bead,
  index: BoardIndex,
): ApplyDecision | undefined {
  // An ABANDONED bead counts even in the "open + abandoned" state a crashed abandon can leave —
  // retiring it with `close` would turn a recorded won't-do into work that reads as shipped, which
  // is the one lie retirement must not tell.
  if (subject.status === "closed" || beads.isAbandoned(subject)) {
    return alreadyRetired(plan, subject, index);
  }
  return alreadyDeferred(plan, subject);
}

/** What a subject that has ALREADY settled means for the ask — narrower for a supersede. */
function alreadyRetired(plan: GardenerPlan, subject: Bead, index: BoardIndex): ApplyDecision {
  // A SUPERSEDE's outcome is narrower than "settled": it records where the work landed, and only the
  // `supersedes` edge carries that answer. A subject closed or abandoned by other means since the
  // filing has no such edge, so settling here would close the ask as answered while its one product
  // — the pointer at the survivor — was never written.
  if (plan.retireAs !== "supersede") {
    return { status: "settled", summary: `${subject.id} is already ${settledWord(subject)}` };
  }
  if (!plan.target) return { status: "refuse", reason: NO_SURVIVOR };
  if (!index.recordsSupersedes(subject.id, plan.target)) {
    return {
      status: "refuse",
      reason: `${subject.id} is ${settledWord(subject)}, but nothing on the board records it as superseded by ${plan.target} — it settled by other means, so this proposal's answer to "where did the work go" was never written; decline it, and supersede by hand if that is still the record you want`,
    };
  }
  return { status: "settled", summary: `${subject.id} is already superseded by ${plan.target}` };
}

/** A `defer` whose subject is already parked: the ask is answered without a write. */
function alreadyDeferred(plan: GardenerPlan, subject: Bead): ApplyDecision | undefined {
  if (plan.retireAs === "defer" && beads.isDeferred(subject)) {
    return { status: "settled", summary: `${subject.id} is already deferred` };
  }
  return undefined;
}

/**
 * Why this bead may not be retired, or undefined. Nothing is left to settle by the time this runs,
 * so from here every branch WRITES — and a bead a run owns is the one thing retirement must not
 * write to.
 */
function retirementBarred(
  plan: GardenerPlan,
  subject: Bead,
  index: BoardIndex,
  at: ApplyMoment,
): ApplyDecision | undefined {
  // Closing or deferring work an agent is mid-flight over would pull the bead out from under the run
  // that is shipping it; then the same two bars asked of the run target whose ticket set it rides;
  // then the premise a fresh board read cannot confirm — every retirement rests on a claim about the
  // subject AS THE PATROL FOUND IT (retire.ts), so approving a months-old ask must not settle a bead
  // that has since been written out from under its own evidence.
  const reason =
    subjectBusy(subject, at, "retiring it") ??
    ticketSetBusy(index, subject, at, retiringTicket(subject.id)) ??
    premiseTouched(subject, EVIDENCE_PREMISE[plan.kind], at.observedAtMs) ??
    wouldStrand(plan, subject, index);
  return reason ? { status: "refuse", reason } : undefined;
}

/**
 * Why a run holds the TICKET SET this subject rides, or undefined — the half of "busy" the subject's
 * own signals cannot answer.
 *
 * A grouped run publishes ONE lease, on the run target its tickets hang under, so a ticket that run
 * has selected but not yet reached carries no lease, no PR ref and no claim of its own — taking it
 * out of that set would raid a live run, and the run aborts when its claim reaches a bead the board
 * no longer holds.
 *
 * Asked by every move that takes the bead out: a retirement settles it, and a RE-PARENT hands it to
 * another target, which leaves the run shipping a commit for a bead that now belongs to a different
 * card. `doing` is which of the two, so the refusal names the move a founder is looking at.
 */
function ticketSetBusy(
  index: BoardIndex,
  subject: Bead,
  at: ApplyMoment,
  doing: string,
): string | undefined {
  const owner = ticketOwnerOf(index, subject);
  if (!owner) return undefined;
  return subjectBusy(owner, at, doing, CLAIM_COST.ticketSet);
}

/**
 * Why settling this bead would strand the work beneath it, or undefined. The children would stay in
 * the ready set with a parent no run will ever reach — the unreachable state
 * `detectContainerOrphans` exists to flag, arrived at by approving a proposal. Only the SETTLING
 * verbs are barred; `defer` parks the subtree with its contract intact and is undone by reopening
 * the parent.
 */
function wouldStrand(
  plan: GardenerPlan,
  subject: Bead,
  index: BoardIndex,
): string | undefined {
  if (plan.retireAs !== "close" && plan.retireAs !== "supersede") return undefined;
  const open = index.openDescendants(subject.id);
  if (open.length === 0) return undefined;
  return `${subject.id} still has open work under it (${namesSome(open.map((b) => b.id))}) — settling it would strand that work beneath a card nothing will run; close or retire the children first`;
}

/** The one write this retirement resolves to, under the verb the proposal named. */
function retirementSteps(
  plan: GardenerPlan,
  subject: Bead,
  index: BoardIndex,
  at: ApplyMoment,
): ApplyDecision {
  // Whatever the verb, the write rests on the same two beads: the subject, and the run target whose
  // ticket set it rides (absent when it rides none). Both are re-read under their own locks, and so
  // is the premise the checks above just cleared (see {@link EvidenceFence}).
  const on: RetirementSubject = {
    id: subject.id,
    claim: runClaimOf(subject),
    owner: ownerRef(ticketOwnerOf(index, subject)),
    kind: plan.kind,
    observedAtMs: at.observedAtMs,
  };
  switch (plan.retireAs) {
    case "close":
      return {
        status: "apply",
        steps: [{ verb: "close", ...on, reason: closeReason(plan) }],
        summary: `closed ${subject.id} as shipped`,
      };
    case "defer":
      return {
        status: "apply",
        steps: [{ verb: "defer", ...on }],
        summary: `deferred ${subject.id} out of the ready set`,
      };
    case "supersede":
      return supersedeSteps(plan, on, index, at);
    default:
      return { status: "refuse", reason: `unknown retirement verb "${plan.retireAs}"` };
  }
}

/** The run target as a step carries it — its id and the claim it held when this was decided. */
function ownerRef(owner: Bead | undefined): TicketOwner["owner"] {
  return owner ? { id: owner.id, claim: runClaimOf(owner) } : undefined;
}

/** A supersede also rests on the SURVIVOR: the bead the work is being recorded as landing in. */
function supersedeSteps(
  plan: GardenerPlan,
  on: RetirementSubject,
  index: BoardIndex,
  at: ApplyMoment,
): ApplyDecision {
  if (!plan.target) return { status: "refuse", reason: NO_SURVIVOR };
  const survivor = index.byId.get(plan.target);
  if (!survivor) return { status: "refuse", reason: missing(plan.target) };
  // `survivorUnusable` asks only whether the survivor still reads as landed work, which a rewrite
  // leaves untouched — so the other end of the premise is asked here too.
  const gone =
    survivorUnusable(survivor, on.id) ??
    premiseTouched(survivor, EVIDENCE_PREMISE[plan.kind]?.twin, at.observedAtMs);
  if (gone) return { status: "refuse", reason: gone };
  return {
    status: "apply",
    steps: [{ verb: "supersede", ...on, replacement: plan.target }],
    summary: `closed ${on.id} as superseded by ${plan.target}`,
  };
}

// ── the bars every move is held to ──

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
 * and the under-lock re-check then compares it against itself. apply.ts `observedAtOf` floors the
 * fence to the same one-second grid so that tie is reachable at all.
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
  // Sharper than `subject`: execute-epic re-reads the approval after its claim settles and poisons
  // the run when the label is gone, so this does not race the run — it ends it.
  approval:
    "would poison the run that owns it, which re-checks the approval after its claim settles and stops when the label is gone",
} as const;

/**
 * Why a run owns this bead right now, or undefined — the two questions every move asks of every bead
 * it touches, in the order that names the live run first.
 *
 * They are one helper because they are one bar with a blind spot in the middle: {@link isInFlight}
 * sees a published lease, {@link claimedSinceFiling} sees the pickup that has not published one yet,
 * and a move that asked only the first would write to work another machine already owns.
 */
function subjectBusy(
  subject: Bead,
  at: ApplyMoment,
  doing: string,
  cost: string = CLAIM_COST.subject,
): string | undefined {
  if (isInFlight(subject, at.nowMs)) return inFlightReason(subject, at.nowMs, doing);
  return claimedSinceFiling(subject, at, doing, cost);
}

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
 * Why the subject no longer has the parent shape its detection was based on, or undefined. The
 * GARDENER's two re-parent kinds rest on one claim about where the bead sits — NO BOARD CARD CARRIES
 * IT, whether it hangs off a container epic (`container-orphan`) or off nothing at all
 * (`parentless-cluster`) — so that claim is re-derived from the fresh board rather than from a
 * filing-time parent the plan would have to carry.
 *
 * A bead somebody has since given a card has already been answered, by a decision newer than the one
 * being approved. Nothing downstream can object on its own: the step records that newer parent as
 * its own `undoParent`, and the under-lock re-check compares against that same value. Judged on the
 * CARD rather than the raw parent because that is what the move is for — a bead moved under another
 * container is still as unreachable as the proposal says, and re-homing it is still the fix.
 *
 * The answer drops the bead from the move rather than refusing the plan; only a plan left with
 * nothing to write reports it as a refusal (see {@link reparentSteps}).
 *
 * Asked of those two kinds ALONE. A `misfiled` subject rides a perfectly good card already — that is
 * the whole claim — so holding it to this bar would refuse every one of them; its premise is the
 * evidence fence instead ({@link EVIDENCE_PREMISE}).
 */
function reparentPremiseGone(
  plan: GardenerPlan,
  subject: Bead,
  index: BoardIndex,
): string | undefined {
  if (plan.kind !== "container-orphan" && plan.kind !== "parentless-cluster") return undefined;
  const card = index.cards.cardOf(subject);
  if (!card) return undefined;
  return `${subject.id} now rides board card ${card} — it was given a home since this proposal was filed, so moving it under ${plan.target} would overwrite that newer decision`;
}

/**
 * Why this member is no longer one of the loose beads the cluster was derived from, or undefined.
 *
 * `detectParentlessClusters` builds only from beads that are parentless, still wanted, and held by
 * nobody (reparent.ts `isClusterCandidate`). A card answers the first of those and
 * {@link reparentPremiseGone} reads it; this reads the other two — a member closed since the filing,
 * or picked up by a run since it — which are just as much the board answering that bead, and just as
 * much a reason to leave it alone rather than to refuse everyone else.
 *
 * Asked of `parentless-cluster` alone, because only a GROUP claim survives losing a member. The same
 * facts about a single-subject re-parent are what {@link reparentBarred} refuses the plan over, which
 * is the honest answer when the plan is that one bead.
 */
function clusterMemberGone(plan: GardenerPlan, subject: Bead, at: ApplyMoment): string | undefined {
  if (plan.kind !== "parentless-cluster") return undefined;
  if (!isOpenWork(subject)) {
    return `${subject.id} is ${settledWord(subject)} — it left the cluster after this proposal was filed`;
  }
  return subjectBusy(subject, at, DOING.reparent);
}

/**
 * The same answer as {@link clusterMemberGone} for the member that is no longer working-layer work
 * at all — the fourth way a bead leaves a cluster, and the one every bar around it reads as a fatal
 * home refusal instead.
 *
 * `detectParentlessClusters` builds from tasks, bugs and chores (reparent.ts `isClusterTier`).
 * Promote one to a `feature` and it becomes a board card, so {@link homeWrongTier} refuses the whole
 * proposal as `feature-under-non-epic` before any member is judged — and the target-only fingerprint
 * goes on suppressing the fresh proposal the surviving pair would form. Dropping it leaves the
 * members nobody touched movable, which is what the other three answers already do.
 */
function clusterMemberLeftLayer(plan: GardenerPlan, subject: Bead): string | undefined {
  if (plan.kind !== "parentless-cluster") return undefined;
  if (isClusterTier(subject)) return undefined;
  return `${subject.id} is a ${subject.issue_type ?? "bead"} now, not the working-layer work this cluster was derived from — it left the cluster after this proposal was filed`;
}

/**
 * The same answer as {@link clusterMemberGone} for the member that is not on the board at all —
 * `bd delete` is the third way one leaves a cluster, and the only one no bead is left to read it
 * from. Returned already wrapped, because the caller has no subject to hand the other checks.
 */
function clusterMemberDeleted(plan: GardenerPlan, id: string): Answered | undefined {
  if (plan.kind !== "parentless-cluster") return undefined;
  return { answered: `${missing(id)} — it left the cluster after this proposal was filed` };
}

/**
 * Why nothing confirms the subject still rides the CARD its home was judged against, or undefined.
 *
 * bd nesting runs to any depth, so under `feature A → task P → subtask T` the card that ships T is
 * A, reached THROUGH P. Re-homing P under another feature hands the whole subtree to that feature
 * while leaving T's own parent and write stamp untouched — so every bar around this one waves the
 * move through: the fence reads T's stamp and sees nothing, `ticketSetBusy` re-derives the NEW card
 * from the fresh board and refuses only if a run holds it, and the step then records that same
 * newcomer as its own baseline, which is what the under-lock re-check (apply-steps.ts
 * `assertOwnerUnchanged`) compares against. The stale opinion lands on top of a subtree-level rehome
 * nobody re-judged.
 *
 * The plan carries no filing-time card to compare against, so the identity is PROVEN from the fence
 * rather than recalled: an ancestor's home moves by a `bd update --parent` on that ancestor, so a
 * path whose every bead predates the observation is a path the subject still reaches the same card
 * through. Undated fails closed, like every other reading of the fence.
 *
 * Asked of the fenced kinds alone — `misfiled`, in practice. The gardener's two re-parents claim
 * "no board card carries this at all", which {@link reparentPremiseGone} re-derives in full from the
 * fresh board and which an ancestor's move therefore cannot falsify unnoticed.
 */
function carrierMoved(
  plan: GardenerPlan,
  subject: Bead,
  home: Bead,
  index: BoardIndex,
  at: ApplyMoment,
): string | undefined {
  if (!EVIDENCE_PREMISE[plan.kind]) return undefined;
  for (const through of ticketPathOf(index, subject)) {
    const since = writtenSinceFiling(through, at.observedAtMs);
    if (since === false) continue; // this ancestor predates the filing, so the subtree has not moved
    const reached = `${subject.id} reaches the card that ships it through ${through.id}`;
    return since === undefined
      ? `${reached}, which carries no write stamp this proposal's filing can be ordered against — nothing confirms it still rides the card ${home.id} was chosen against`
      : `${reached}, and ${through.id} has been written to since this proposal was filed — re-homing that subtree moves ${subject.id} without touching it, so filing it under ${home.id} now could overwrite a newer decision about which card ships the work`;
  }
  return undefined;
}

/**
 * Why the board no longer states the ordering this link proposal read, or undefined. An
 * `implied-order` ask rests on exactly one piece of evidence — a body phrase on one end of the pair
 * — and unlike a status or a parent, no other bar reads it: the step carries only the pair, and every
 * remaining check asks whether the two beads are writable, never whether the ordering is still stated
 * anywhere.
 *
 * So a phrase edited out since the filing would otherwise apply anyway, restoring an ordering a newer
 * board edit explicitly removed and taking the blocked bead back out of the ready set that edit put
 * it in. Re-derived from the fresh board through the detector's own reader (see
 * `relink.ts` {@link impliesOrdering}), so approval cannot hold the premise to a laxer bar than the
 * patrol held it to — and re-derived once more from a read taken under the pair's own write locks
 * (apply-steps.ts `assertOrderingStated`), because this snapshot is stale by the time the write
 * spawns.
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

/** What a move's evidence says a bead still IS, and what writing against it anyway gets wrong. */
export interface EvidencePremise {
  /** The bead the evidence describes — read as "still …". */
  still: string;
  /** The harm of writing against a bead that is no longer it — read as "and …". */
  harm: string;
  /**
   * The same claim about the bead the plan POINTS AT, for evidence that is a MATCH BETWEEN TWO beads
   * rather than a fact about the subject alone. Absent where the ask rests on the subject only —
   * `stale` measures silence and `shipped-orphan` a commit, and neither names a live counterpart.
   */
  twin?: EvidencePremise;
}

/**
 * What each detection claims about the subject AS THE PASS FOUND IT — the one premise a plan cannot
 * restate, because it is a fact about a moment rather than about the board now. Every kind is listed
 * so adding one without deciding whether an edit falsifies it is a type error; the GARDENER's
 * topology kinds carry no entry because their whole claim IS re-derivable from the fresh board (see
 * {@link reparentPremiseGone} and {@link linkPremiseGone}).
 *
 * `missing-order` and `misfiled` are topology too and still fenced, because that re-derivation is
 * what they lack: {@link linkPremiseGone} answers only for `implied-order`, whose evidence is a body
 * phrase, and {@link reparentPremiseGone} only for the gardener's two, whose evidence is "no card
 * carries this". The product master's ordering and home claims are judgments about what two beads
 * are FOR, so no board read restates them and the stamp is the only thing left standing between them
 * and a bead somebody has since rewritten.
 *
 * All three retirements are fenced, not just `stale`: each measured something about the bead's
 * CONTENTS that an edit since the filing can invalidate — silence for `stale`, a match against a
 * closed twin for `superseded`, a match against the commit that delivered it for `shipped-orphan`.
 * A commit is immutable, but the bead it shipped is not: work added after it landed would be settled
 * as delivered. Refusing is loud and a human re-decides; settling a rescoped bead loses that work
 * silently.
 *
 * The product master's kinds are fenced for the same reason and one more: its evidence is a JUDGMENT
 * about what a bead is worth, read from the bead's own contract and its run history. A rewrite is
 * exactly how a bead stops being the one that was judged, and unlike the gardener's mechanical
 * claims nothing here can be re-derived at approve time — so the stamp is the only thing standing
 * between a months-old opinion and a bead somebody has since rescoped.
 */
export const EVIDENCE_PREMISE: Record<GardenerDetectionKind, EvidencePremise | undefined> = {
  "container-orphan": undefined,
  "parentless-cluster": undefined,
  "implied-order": undefined,
  "missing-order": {
    still: "the bead this ordering judgment was made about",
    harm: "recording the edge now would hold work somebody has since rewritten behind a prerequisite chosen for the version it replaced",
  },
  // A split is never applied (see `planApply`), so nothing here can act on a stale premise.
  oversized: undefined,
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
  mispriority: {
    still: "the bead whose contract and history this ranking was judged from",
    harm: "re-ranking it now would apply a judgment made about work that has since been rewritten",
  },
  misfiled: {
    still: "the bead whose contract this home was chosen for",
    harm: "moving it now would file work somebody has since rescoped under a home chosen for the version it replaced",
    // A home claim is a MATCH between two contracts, so an edit to EITHER end falsifies it — and the
    // home's end is the one nothing else here notices: every remaining bar asks only whether the
    // home is still open, unclaimed and the right tier, all of which a rewrite leaves untouched. So
    // without this the move lands under an epic that has since become about something else, which is
    // the misfiling the ask was raised to fix.
    twin: {
      still: "the home whose contract this bead was judged to belong under",
      harm: "hanging work under it now would file that work beneath a home that has since become something else",
    },
  },
  "low-value": {
    still: "the low-value bead the evidence describes",
    harm: "deferring it now would park work somebody has since given a reason to keep",
  },
  // No fence, deliberately — the one pm kind whose premise IS re-derivable (see `planUnapprove`).
  // Its whole claim is "this bead does not clear the approve gate", which `approvalGaps` re-answers
  // from the fresh board; fencing it would refuse the repair the proposal is half asking for, since
  // repairing a bead is itself a write since the filing.
  "degraded-approval": undefined,
};

/**
 * Why this bead is no longer the one its retirement proposal describes, or undefined — asked of the
 * SUBJECT under the kind's own premise, and of a supersede's survivor under that premise's
 * {@link EvidencePremise.twin}. `undefined` premise means the ask makes no filing-time claim about
 * this bead, so nothing here can go stale.
 *
 * Confirmed against the moment the patrol looked rather than by re-deriving the detection, because
 * "has anyone touched it since we asked" is the question the approver's evidence actually rests on —
 * and it is the only half of that evidence a board read can answer at all.
 *
 * Asked TWICE per retirement: once by `planRetire` against the route's snapshot, and again against
 * the re-read taken under the bead's own write lock (see {@link EvidenceFence}), because an edit
 * landing between those two moments leaves every other bar the write holds untouched.
 */
export function premiseTouched(
  bead: Bead,
  premise: EvidencePremise | undefined,
  observedAtMs: number | undefined,
): string | undefined {
  if (!premise) return undefined;
  const since = writtenSinceFiling(bead, observedAtMs);
  if (since === false) return undefined;
  return since === undefined
    ? `${bead.id} carries no write stamp this proposal's filing can be ordered against, so nothing confirms it is still ${premise.still}`
    : `${bead.id} has been written to since this proposal was filed — it is no longer ${premise.still}, and ${premise.harm}`;
}

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
 * under THIS bead's write lock, the one `applyStep` holds around the check and the write, so the
 * two genuinely order: this step cannot slip its write into the window after that read.
 */
export function homeUnusable(home: Bead, nowMs: number): string | undefined {
  if (!isOpenWork(home)) {
    return `${home.id} is ${settledWord(home)} — re-parenting work under it would hang it off a card nothing will run`;
  }
  if (isInFlight(home, nowMs)) return inFlightReason(home, nowMs, "hanging more work under it");
  return undefined;
}

/**
 * How a home refusal DATES itself. The snapshot decision states a fact about the board it was handed;
 * the write states a CHANGE, because the decision already cleared this very bar. One word, and it is
 * the whole difference between the two readings of {@link homeWrongTier}.
 */
export const HOME_STANDING = { snapshot: "is not", locked: "is no longer" } as const;

type HomeStanding = (typeof HOME_STANDING)[keyof typeof HOME_STANDING];

/**
 * Why the tier taxonomy will not let this home carry THIS subject, or undefined.
 *
 * The rule is not "cards only" but A HOME ONE TIER UP — `epic → feature → task|bug|chore`
 * (beads/tiers.mjs): a working-layer bead wants the board card that runs it, and a CARD wants the
 * container epic that groups it. Asking the card question of both is what refused every card move
 * outright, and asking neither is what would write a move `anton board-check` then reports as a
 * blocking violation.
 *
 * A card's home has to be a CONTAINER epic rather than any epic. An epic that groups no cards yet is
 * a run target in its own right (`beads.isRunTarget`) and renders as a card, so landing a card under
 * it demotes it: its own run is cancelled, and whatever tickets it carries are left beneath a card
 * nothing will reach — `ticket-under-container-epic`, arrived at by approving a proposal. An epic
 * that already groups cards plays that role, so the move is a pure addition to it.
 *
 * A subject that is NEITHER tier is refused outright ({@link subjectOffTaxonomy}) rather than held to
 * the working layer's bar, because "not a board card" is as true of a container epic as it is of a
 * ticket — and the taxonomy has no tier above a container to move one INTO.
 *
 * Shared by the snapshot decision and the under-lock re-check like every other bar in this module,
 * so the write cannot hold a home to a laxer tier than the decision held it to.
 */
export function homeWrongTier(
  subject: Bead,
  home: Bead,
  index: BoardIndex,
  standing: HomeStanding,
): string | undefined {
  if (!index.cards.ids.has(subject.id)) {
    const unhomeable = subjectOffTaxonomy(subject, index, standing);
    if (unhomeable) return unhomeable;
    if (index.cards.ids.has(home.id)) return undefined;
    return `${home.id} ${standing} a board card — re-parenting under it would leave the work riding no card, which is the state this proposal is about`;
  }
  if (index.isContainer(home)) return undefined;
  if (!beads.isEpic(home)) {
    return `${home.id} ${standing} an epic and ${subject.id} is a board card — a card hangs off an epic and nothing else (\`feature-under-non-epic\`); both are run targets, so the move would ship the same work twice`;
  }
  return `${home.id} ${standing} a container epic — it groups no cards, so it is a run target in its own right, and landing ${subject.id} under it would demote it: its own run is cancelled and any ticket it carries is left beneath a card nothing will reach (\`ticket-under-container-epic\`)`;
}

/**
 * Why the taxonomy names no home for this SUBJECT at all, or undefined — the half of the tier
 * question that has to be asked positively, because every bar around it reads "not a board card" and
 * that is true of a container epic and a `learning` as surely as it is of a ticket.
 *
 * No detector proposes moving one; a product-master report can, and it is untrusted input. Left to
 * the working layer's bar, a container epic named as the subject and a feature as its home would be
 * accepted, and after approval `boardCards.cardOf` would walk THROUGH the container and attribute
 * every ticket beneath it to that feature's run — tickets nobody shaped for it, dispatched into its
 * worktree and closed on its PR.
 */
function subjectOffTaxonomy(
  subject: Bead,
  index: BoardIndex,
  standing: HomeStanding,
): string | undefined {
  if (index.isContainer(subject)) {
    return `${subject.id} ${standing} a bead a card can carry — it is a container epic, which GROUPS the board's cards rather than riding one, so hanging it under a card would hand that card's run every ticket beneath it (\`boardCards.cardOf\` walks straight through)`;
  }
  if (!isTicketTier(subject)) {
    return `${subject.id} is a ${subject.issue_type ?? "bead"}, which is neither a board card nor working-layer work — the tier taxonomy (\`epic → feature → task|bug|chore\`) names no home for it, so nothing here can say where it belongs`;
  }
  return undefined;
}

/**
 * Why a run that picked the HOME up since this step was decided bars the move, or undefined. This is
 * the home's half of the claim window {@link isInFlight} cannot see (see `parentClaim`), judged by
 * the same rule the subject's claim is: a claim the plan already saw is not news, and one RELEASED
 * since leaves the home freer than the plan assumed — only a NEW owner refuses.
 */
export function homeClaimed(
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
export function blockerUnusable(blocker: Bead, blockedId: string): string | undefined {
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
export function survivorUnusable(survivor: Bead, subjectId: string): string | undefined {
  if (beads.isAbandoned(survivor)) {
    return `${survivor.id} is abandoned — a recorded won't-do delivered nothing, so ${subjectId} is not superseded by it`;
  }
  if (survivor.status !== "closed") {
    return `${survivor.id} is ${survivor.status} again — it has not landed, so ${subjectId} is not superseded by it`;
  }
  return undefined;
}

// ── the words a refusal reads in, shared by both halves ──

/** What each verb would be DOING to the subject, for a refusal that reads as a sentence. */
export const DOING: Record<ApplyStep["verb"], string> = {
  reparent: "moving it",
  link: "recording it as blocked",
  reprioritize: "re-ranking it",
  unapprove: "withdrawing its approval",
  close: "retiring it",
  supersede: "retiring it",
  defer: "retiring it",
};

/**
 * Why a bead a run owns is off limits, naming the run that owns it. Every detector already refuses
 * to PROPOSE against in-flight work (see board-index `isInFlight`) — this is the same bar re-checked
 * at approve time, because the run may have claimed the bead AFTER the proposal was filed, and a
 * proposal is only ever as fresh as the night it was written.
 */
export function inFlightReason(bead: Bead, nowMs: number, doing: string): string {
  const pr = beads.getPrRef(bead);
  const owner = beads.isRunLive(bead, nowMs)
    ? `a run holds a live lease on it${bead.assignee ? ` (${bead.assignee})` : ""}`
    : `it is in review${pr ? ` on ${pr}` : ""}`;
  return `${bead.id} is mid-run — ${owner}, so ${doing} would race the run that owns it`;
}

/** The close reason a retirement writes — evidence lives on the proposal, so this stays one line. */
function closeReason(plan: GardenerPlan): string {
  return `closed by an approved ${notePrefix(plan)} proposal (${plan.kind})`;
}

export const missing = (id: string): string =>
  `${id} is no longer on the board — the proposal describes a board that has changed`;

/** A parent id as a refusal names it — `""` is bd's detached form, not a bead called nothing. */
export const home = (parentId: string): string => parentId || "no parent";

const NO_SURVIVOR = "this proposal names no bead that superseded it";

/** What a retirement is doing to the RUN that holds the subject's ticket set, as a refusal reads. */
export const retiringTicket = (id: string): string => `retiring ${id} out of its ticket set`;

/** The same, for the move that takes a ticket out of that set by handing it to another target. */
export const movingTicket = (id: string): string => `moving ${id} out of its ticket set`;

/** Which of the two a step's verb reads as — the one phrasing every ticket-set refusal shares. */
export const takingTicket = (verb: ApplyStep["verb"], id: string): string =>
  verb === "reparent" ? movingTicket(id) : retiringTicket(id);

/** The one phrasing both readings of the link premise refuse with — snapshot and under-lock alike. */
export const orderingUnstated = (blockedId: string, blockerId: string): string =>
  `nothing on the board still places ${blockedId} after ${blockerId} — the body phrase this proposal read has been removed since it was filed, so recording the edge would restore an ordering a newer decision took away`;

export const settledWord = (bead: Bead): string =>
  beads.isAbandoned(bead) ? "abandoned" : bead.status === "closed" ? "closed" : bead.status;

export const list = (ids: string[]): string => ids.join(", ");

/** How many ids a refusal spells out before it counts the rest — a reason stays one readable line. */
const NAMED_IDS = 5;

export const namesSome = (ids: string[]): string =>
  ids.length <= NAMED_IDS
    ? list(ids)
    : `${list(ids.slice(0, NAMED_IDS))} and ${ids.length - NAMED_IDS} more`;
