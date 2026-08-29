/**
 * THE WRITE HALF of apply-on-approve (anton-1t3n): one decided step turned into bd writes, taken
 * under the write lock of every bead it rests on — and undone again when a later step of the same
 * cluster fails.
 *
 * Split out of apply.ts (anton-ni1j) so the two halves can be read apart: apply-plan.ts decides what
 * a proposal MEANS against a snapshot, this decides whether that decision still holds against beads
 * re-read under their own locks, and apply.ts composes the two. Every bar re-asked here is asked
 * through apply-plan.ts's own helper, so the write cannot hold a bead to a laxer bar than the
 * decision held the snapshot to.
 */
import { approvalGaps, type ApprovalGap } from "../approval-gate";
import { beads, LABELS, type Bead } from "../beads/bd";
import { swapUnderLock } from "../beads/claim";
import { withBeadWriteLocks } from "../beads/claim-lock";
import { loadAllIssues } from "../beads/issues";
import { resolveOperator } from "../operator";
import {
  indexBoard,
  isInFlight,
  isOpenWork,
  runClaimOf,
  ticketOwnerOf,
  type BoardIndex,
} from "./board-index";
import {
  blockerUnusable,
  DOING,
  EVIDENCE_PREMISE,
  home,
  homeClaimed,
  HOME_STANDING,
  homeUnusable,
  homeWrongTier,
  inFlightReason,
  list,
  missing,
  namesSome,
  orderingUnstated,
  premiseTouched,
  settledWord,
  startBarred,
  survivorUnusable,
  takingTicket,
  unapproveNote,
  type ApplyStep,
  type EvidenceFence,
  type TicketOwner,
} from "./apply-plan";
import { impliesOrdering } from "./relink";

/** A subject the board moved on between the decision and the write. Never a bd failure. */
export class SubjectMovedError extends Error {}

/** The verbs that SETTLE the subject — the ones that would strand whatever still hangs under it. */
const SETTLING: ReadonlySet<ApplyStep["verb"]> = new Set(["close", "supersede"]);

/** The verbs that SETTLE the subject out of whatever run's ticket set it rides. */
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
 * The filing-time premise a CONTENT-derived move rests on, or absent for the verbs that make no claim
 * about a bead's contents. See {@link EvidenceFence} for why the step carries it.
 *
 * `link` is here for its `missing-order` half alone and `reparent` for its `misfiled` half alone; an
 * `implied-order` and the gardener's two re-parents resolve to no premise in
 * {@link EVIDENCE_PREMISE} and are re-derived from the board instead ({@link assertOrderingStated},
 * apply-plan.ts `reparentPremiseGone`).
 */
function evidenceOf(step: ApplyStep): EvidenceFence | undefined {
  switch (step.verb) {
    case "close":
    case "supersede":
    case "defer":
    case "reprioritize":
    case "link":
    case "reparent":
    case "approve":
      return { kind: step.kind, observedAtMs: step.observedAtMs };
    default:
      return undefined;
  }
}

/**
 * The run target whose ticket set this step would take its subject out of, when it rides one —
 * settled by a retirement, handed to another target by a re-parent. Not written to and not pointed
 * at, but the run that owns it is the one this write can abort, and the only place that run is
 * visible (see {@link TicketOwner}), so it is locked and re-judged too.
 */
function ownerOf(step: ApplyStep): TicketOwner["owner"] {
  switch (step.verb) {
    case "close":
    case "supersede":
    case "defer":
    case "reparent":
      return step.owner;
    default:
      return undefined;
  }
}

/** Every bead this step rests on, and so every lock it has to hold to write at all. */
function lockedBeads(step: ApplyStep): string[] {
  return [step.id, counterpartOf(step), ownerOf(step)?.id].filter(
    (id): id is string => id !== undefined,
  );
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
 * on this very chain, so either its claim lands first and this read refuses, or the write lands
 * first and the run's own post-lease re-confirmation sees its ticket set move (execute-epic step 1c)
 * and retries — rather than aborting mid-flight on a bead the board no longer holds. A re-parent
 * holds it too: handing a ticket to another card takes it out of that set exactly as retiring it
 * does, and leaves the run's commit landing in a PR for a bead that now belongs elsewhere.
 *
 * The body is the checks in the order they have to run, each named for what it refuses. Four of them
 * buy a whole board read rather than trusting the snapshot: whether the subject still rides the
 * TICKET SET the step captured ({@link assertOwnerUnchanged}), whether a bead about to be SETTLED
 * still has open work under it ({@link assertNothingStranded}), whether a re-parent's home is still
 * the TIER its subject demands ({@link assertHomeFitsSubject}), and whether the board still STATES
 * the ordering a link rests on ({@link assertOrderingStated}). All four earn it the same way — the
 * write that flips the answer is itself a locked write on a bead this step holds. Attaching work
 * under a bead, and moving a bead onto another card, are both re-parents, which take those beads'
 * locks as subject and home; an epic's tier turns entirely on its feature children — it stops being
 * a card, or stops being a container, the moment one lands under it or leaves it, that same locked
 * write; and a link's evidence sits on the PAIR, whose bodies are edited under these very locks
 * (`ticket-detail.ts` `updateTicket`). So those writes genuinely order against each other.
 * The rest of the board-wide topology stays with the snapshot — whether the edge closes a cycle —
 * because it rests on beads no lock taken here covers, so re-deriving it would buy a whole board
 * read and still guarantee nothing.
 *
 * The two APPROVAL moves buy one each for a different question — not "did the topology move" but
 * "does the approve gate still say what the ask read": {@link assertStillDegraded} for the
 * withdrawal, {@link assertStillStartable} for the start. Both are gate re-derivations rather than
 * serializations, and each refuses the opposite direction of the same drift.
 *
 * Answers whether this step LANDED a write, which is not the same as whether it succeeded: see
 * {@link alreadySatisfied}.
 *
 * `signal` is an unattended caller's cancel, and apply.ts hands it here for the FIRST step alone —
 * the only one that can still stop for free. Everything above the write is an await: acquiring the
 * locks, re-reading the subject, its counterpart and its owner, and up to a whole board read per
 * topology check. A cancel arriving in any of them is a pass an operator (or the no-progress
 * timeout) already stopped, and honouring it only at the caller's checkpoint would let it move a
 * subject and close the proposal over it regardless. So it is re-checked HERE, under the locks and
 * with no await left between it and the write — before the write, never after: a step that has
 * spawned its bd call is a write this process can no longer un-decide.
 *
 * The NO-OP return needs the same checkpoint, for a reason the write's own does not cover: it sits
 * on the far side of those very awaits, and returning "wrote nothing" unchecked is what lets the
 * caller settle the ask (apply.ts `settleProposal`) over a pass that was already stopped. Writing
 * nothing is not the same as having nothing left to stop.
 */
export async function applyStep(
  repo: string,
  step: ApplyStep,
  signal?: AbortSignal,
): Promise<boolean> {
  return withBeadWriteLocks(repo, lockedBeads(step), async () => {
    if (await lockedSubjectSatisfied(repo, step)) {
      signal?.throwIfAborted();
      return false;
    }
    await assertCounterpartUnmoved(repo, step);
    await assertOwnerIdle(repo, step);
    await assertRetirementHolds(repo, step);
    await assertHomeHolds(repo, step);
    await assertEvidenceHolds(repo, step);
    await assertStartHolds(repo, step);
    const write = await lockedWrite(repo, step);
    signal?.throwIfAborted();
    await runStep(repo, write);
    return true;
  });
}

/**
 * Re-read the subject under its own lock and answer whether the board already satisfies this step —
 * refusing outright when it has moved out from under the plan instead.
 */
async function lockedSubjectSatisfied(repo: string, step: ApplyStep): Promise<boolean> {
  const subject = await reread(repo, step.id);
  const moved = subjectMoved(step, subject, Date.now());
  if (moved) throw new SubjectMovedError(moved);
  return subject !== undefined && alreadySatisfied(step, subject);
}

/** The bead this step POINTS AT, re-judged under its own lock by the bar the decision used. */
async function assertCounterpartUnmoved(repo: string, step: ApplyStep): Promise<void> {
  const counterpart = counterpartOf(step);
  if (!counterpart) return;
  const other = await reread(repo, counterpart);
  const moved = counterpartMoved(step, counterpart, other, Date.now());
  if (moved) throw new SubjectMovedError(moved);
}

/** The run target whose ticket set a retirement would raid, re-judged under its own lock. */
async function assertOwnerIdle(repo: string, step: ApplyStep): Promise<void> {
  const owner = ownerOf(step);
  if (!owner) return;
  const live = await reread(repo, owner.id);
  const started = ownerStarted(step, owner, live, Date.now());
  if (started) throw new SubjectMovedError(started);
}

/** What a RETIREMENT owes the board it is about to take a bead out of. */
async function assertRetirementHolds(repo: string, step: ApplyStep): Promise<void> {
  if (!RETIRING.has(step.verb)) return;
  const board = await lockedBoard(repo, `before retiring ${step.id}`);
  assertOwnerUnchanged(step, board);
  if (SETTLING.has(step.verb)) assertNothingStranded(step.id, board);
}

/**
 * What a RE-PARENT owes the two run targets it sits between: the home it is about to hang work
 * under, and the ticket set it is taking that work out of.
 */
async function assertHomeHolds(repo: string, step: ApplyStep): Promise<void> {
  if (step.verb !== "reparent") return;
  const board = await lockedBoard(repo, `before re-parenting under ${step.parent}`);
  assertOwnerUnchanged(step, board);
  assertHomeFitsSubject(step, board);
}

/**
 * What the one link kind whose evidence IS a body phrase owes the pair. A `missing-order` ask rests
 * on the product master's judgment, which nothing on the board restates — re-deriving it here would
 * refuse every one of them; its premise is held by the evidence fence instead (see the link step's
 * docs in apply-plan.ts).
 */
async function assertEvidenceHolds(repo: string, step: ApplyStep): Promise<void> {
  if (step.verb !== "link" || step.kind !== "implied-order") return;
  const doing = `before recording ${step.blocker} as ${step.id}'s blocker`;
  assertOrderingStated(step.id, step.blocker, await lockedBoard(repo, doing));
}

/**
 * What an APPROVE owes the target it is about to release a run on — the evidence fence of the one
 * move that starts work, re-asked from a board read taken INSIDE the subject's own write lock.
 *
 * The mirror of {@link assertStillDegraded}, and it exists for the mirror reason: that check refuses
 * a withdrawal whose gaps were repaired since the decision, and this refuses a start whose target
 * stopped clearing the gate since the decision. Everything else the locked half asks — status,
 * liveness, claim, the premise stamp — is untouched by the writes that break the gate: an Acceptance
 * section edited away, a feature landed under a legacy epic, a `blocks` edge drawn. Without this,
 * the label goes on work the picker itself would no longer offer, and a run starts on it.
 *
 * Genuine serialization for the target's own body (`ticket-detail.ts` `updateTicket` takes this very
 * lock) and for a claim (beads/claim.ts, the same chain); a narrowing for the rest of the subtree
 * and for the blocker graph, whose edits take their own beads' locks.
 */
async function assertStartHolds(repo: string, step: ApplyStep): Promise<void> {
  if (step.verb !== "approve") return;
  const board = await lockedBoard(repo, `before approving ${step.id}`);
  assertStillStartable(step.id, board);
}

/** The picker's own eligibility, re-asked under the lock through the helper the decision used. */
function assertStillStartable(id: string, board: BoardIndex): void {
  const subject = board.byId.get(id);
  if (!subject) throw new SubjectMovedError(missing(id));
  const barred = startBarred(subject, board.all, HOME_STANDING.locked);
  if (barred) throw new SubjectMovedError(barred);
}

/**
 * The step as it will be WRITTEN. Only an unapprove differs from what was decided: its note carries
 * the approval gaps, re-derived once more from a board read taken inside the subject's own lock. The
 * decision asked the same question of the route's snapshot, which is already seconds old when this
 * write spawns — and a repair landing in that window leaves every other bar here untouched, so
 * without this the label comes off work that is sound again. Genuine serialization for the target's
 * own body (`updateTicket` takes this very lock); a narrowing for the rest of the subtree, whose
 * repairs take their own beads' locks.
 */
async function lockedWrite(repo: string, step: ApplyStep): Promise<ApplyStep> {
  if (step.verb !== "unapprove") return step;
  const doing = `before withdrawing the approval on ${step.id}`;
  const board = await lockedBoard(repo, doing);
  return { ...step, note: unapproveNote(assertStillDegraded(step.id, board)) };
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
  if (step.verb === "reparent") return (beads.parentOf(subject) ?? "") === step.parent;
  // A priority somebody set by hand between the decision and this lock is the same reasoning: the
  // board already says what the ask wanted, so there is no write to make — and, crucially, none to
  // undo. `subjectMoved` deliberately lets such a subject through (a re-ranked bead is not a bead
  // that moved out from under the plan), so without this the no-op would join the rollback prefix.
  if (step.verb === "reprioritize") return subject.priority === step.priority;
  // Somebody dropped the label by hand between the decision and this lock: the ask's outcome is the
  // board's state, so there is no write to make — and no second note to leave on a bead whose
  // approval is already gone.
  if (step.verb === "unapprove") return !beads.isApproved(subject);
  // Its mirror: somebody granted the approval by hand, or a concurrent approve landed it. The ask is
  // answered, so there is nothing to write — and nothing to auto-claim over their reservation.
  if (step.verb === "approve") return beads.isApproved(subject);
  return false;
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
 * Refuse a step whose subject has changed hands since the decision, judged from a board read taken
 * INSIDE the subject's write lock.
 *
 * {@link ownerStarted} re-reads the owner the STEP captured and asks whether a run has started on it.
 * Neither it nor {@link subjectMoved} — which compares the subject's OWN parent, for a re-parent
 * alone — can see the other half: a re-parent approval landing in this window can move an ANCESTOR
 * of the subject under a different run target, one this step holds no lock on and never re-reads, so
 * taking the ticket out here raids a live run the decision never looked at, and that run aborts when
 * its claim reaches the bead. Re-derived through the same {@link ticketOwnerOf} the decision used, so
 * the write cannot hold ownership to a different bar than the planner held the snapshot to.
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
    `${step.id} now rides ${ticketSet(now)} rather than ${ticketSet(was)} — the run target it hangs under changed since this proposal was decided, so ${takingTicket(step.verb, step.id)} would act on a ticket set this approval never looked at`,
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
 * Refuse to hang work under a home the tier taxonomy will not let carry this SUBJECT — judged from a
 * board read taken INSIDE the home's write lock rather than from the approval's snapshot, and
 * through the same {@link homeWrongTier} the decision used.
 *
 * `planReparent` asks the same question of the snapshot, and against a lone approval that is enough.
 * What it cannot see is a CONCURRENT one — and one write flips either tier: a legacy epic stops
 * being a board card, and an epic stops being a container, the instant a FEATURE lands under it or
 * leaves it, which is a re-parent taking this very epic's write lock as its own home or subject (see
 * {@link applyStep}). So the two orders are already serialized, and re-asking here is what makes the
 * ordering mean something. Without it, both pass against snapshots taken before either wrote, and
 * this step lands its subject one tier off: work attached directly to a container epic, riding no
 * card and reachable by no run — the state the proposal exists to fix — or a card hung under an epic
 * the move demotes out of its own run.
 */
function assertHomeFitsSubject(
  step: Extract<ApplyStep, { verb: "reparent" }>,
  board: BoardIndex,
): void {
  // Both ends were re-read under their own locks already; these guard the whole-board read
  // disagreeing with them, and say so the same way every other missing bead here does.
  const subject = board.byId.get(step.id);
  if (!subject) throw new SubjectMovedError(missing(step.id));
  const home = board.byId.get(step.parent);
  if (!home) throw new SubjectMovedError(missing(step.parent));
  const wrongTier = homeWrongTier(subject, home, board, HOME_STANDING.locked);
  if (wrongTier) throw new SubjectMovedError(wrongTier);
}

/**
 * Refuse to draw an ordering edge whose evidence the board no longer states, judged from a board read
 * taken INSIDE the pair's write locks rather than from the approval's snapshot.
 *
 * `planApply` asks the same question of the snapshot (apply-plan.ts `linkPremiseGone`), and that
 * snapshot is already seconds old when the first bd write spawns — while everything else the locked
 * half checks asks only whether the two beads are still WRITABLE, which a deleted phrase leaves
 * untouched. So without this the edge lands after its sole evidence was removed, taking the blocked
 * bead back out of the ready set that edit put it in.
 *
 * The evidence sits on the pair itself — a body phrase on one of the two beads (see `relink.ts`
 * {@link impliesOrdering}) — and both beads are locked here, so a body edit, which takes the same
 * per-bead lock (`ticket-detail.ts` `updateTicket`), either lands first and this read finds the
 * phrase gone or queues behind this write.
 */
function assertOrderingStated(blockedId: string, blockerId: string, board: BoardIndex): void {
  if (impliesOrdering(board, blockedId, blockerId)) return;
  throw new SubjectMovedError(orderingUnstated(blockedId, blockerId));
}

/**
 * The gaps that still cost this target its approval, from a board read taken INSIDE its write lock —
 * or a refusal when there are none left.
 *
 * A repair is the OTHER answer to a fix-or-unapprove ask, and it lands as an ordinary bead edit that
 * changes nothing else this step checks: the subject stays open, unclaimed and approved. So the
 * question has to be re-asked here, or an approval clicked moments after somebody wrote the missing
 * Acceptance would strip the label off work that is sound again.
 *
 * Returns them so the write NAMES the gaps as they are now: repairing one and introducing another is
 * a real sequence, and a note quoting the decision's list would tell the founder to fix something
 * they already fixed.
 */
function assertStillDegraded(id: string, board: BoardIndex): ApprovalGap[] {
  const subject = board.byId.get(id);
  if (!subject) throw new SubjectMovedError(missing(id));
  const gaps = approvalGaps(subject, board.all);
  if (gaps.length === 0) {
    throw new SubjectMovedError(
      `${id} meets the approve gate again — the gaps this proposal names were repaired since it was decided, so withdrawing the approval would take sound work out of the queue`,
    );
  }
  return gaps;
}

/**
 * A fresh whole-board read for the topology re-checks — through `loadAllIssues` rather than a bare
 * `bd list --status all`, because that flag is unsupported on some bd versions and every re-check
 * here treats a failed read as a refusal. On such a bd a sound approval would refuse forever;
 * `loadAllIssues` falls back to merging the open and closed listings instead. Callers phrase their
 * own refusal for the read that genuinely fails.
 *
 * GATE-COMPLETE, for the reason the armed pass's own pre-apply read is (gardener/armed.ts
 * `readBoardForApply`) — and this is the read that comes AFTER it, under the locks, with nothing
 * between it and the write. bd omits gate beads from every ordinary listing while carrying the
 * `blocks` edge a gate puts on the bead it gates, and every blocker helper reads a blocker absent
 * from the list as still open (epic-graph.ts). Degrading is right for a page render and wrong here:
 * a gate listing that fails leaves an approved target's own `gh:pr` merge gate reading as a real
 * blocker, which is a `blocked` approval gap — so {@link assertStillDegraded} would find gaps that
 * were repaired and strip the `approved` label off sound work, unattended. Failing the read closed
 * costs nothing extra, because every caller here already refuses on a read it could not make.
 */
export function readWholeBoard(repo: string): Promise<Bead[]> {
  return loadAllIssues(repo, { strictGates: true });
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
function subjectMoved(
  step: ApplyStep,
  subject: Bead | undefined,
  nowMs: number,
): string | undefined {
  if (!subject) return missing(step.id);
  if (!isOpenWork(subject)) {
    return `${step.id} is ${settledWord(subject)} — the board moved on since this was proposed`;
  }
  return claimMoved(step, subject, nowMs) ?? evidenceMoved(step, subject) ?? parentMoved(step, subject);
}

/**
 * Why a run owns the subject now, or undefined. A pickup that landed since this step was decided
 * sits in the window `isInFlight` cannot see: the claim writes assignee + `in_progress` and
 * publishes the run-lease a moment later. That sequence serializes on the very per-bead chain this
 * apply holds, so the claim either lands before the re-read or queues behind this write — and
 * refusing here is what makes that ordering worth anything.
 *
 * A claim the plan already saw is not news (the stale-in-progress detector proposes against exactly
 * those); one since RELEASED leaves the bead freer than the plan assumed. So only a NEW owner
 * refuses.
 */
function claimMoved(step: ApplyStep, subject: Bead, nowMs: number): string | undefined {
  if (isInFlight(subject, nowMs)) return inFlightReason(subject, nowMs, DOING[step.verb]);
  const claim = runClaimOf(subject);
  if (!claim || claim === step.claim) return undefined;
  return `${step.id} was claimed by ${claim} since this proposal was decided — ${DOING[step.verb]} would pull the bead out from under the run that now owns it`;
}

/**
 * Why an edit has falsified the evidence this step rests on, or undefined. A retirement, a
 * re-ranking, a `missing-order` and a `misfiled` all rest on a claim about the subject's CONTENTS
 * that every other check is blind to — a rescoping edit leaves status, liveness and claim exactly as
 * the plan found them. Each planner asked it of the route's snapshot; re-asked here against the read
 * taken under this bead's own lock, so an edit landing in that window refuses instead of being
 * settled as delivered.
 *
 * …but not when the board already reads as applied. Setting the asked-for priority BY HAND is itself
 * a write since the filing, so an unguarded fence would refuse the very state the ask wanted — the
 * same reason `planReprioritize` settles before it consults the premise.
 */
function evidenceMoved(step: ApplyStep, subject: Bead): string | undefined {
  const evidence = alreadySatisfied(step, subject) ? undefined : evidenceOf(step);
  if (!evidence) return undefined;
  return premiseTouched(subject, EVIDENCE_PREMISE[evidence.kind], evidence.observedAtMs);
}

/**
 * Why a re-parent's subject sits somewhere the plan never looked at, or undefined. A re-parent is the
 * one verb whose subject can move WITHOUT changing status: another approval or an operator re-homing
 * it since the plan was made is a newer decision than this one, and writing over it would silently
 * undo their move — then, on a cluster rollback, restore a parent two moves stale. Landing where this
 * step was already headed is the same move, so it stays idempotent.
 */
function parentMoved(step: ApplyStep, subject: Bead): string | undefined {
  if (step.verb !== "reparent") return undefined;
  const parent = beads.parentOf(subject) ?? "";
  if (parent === step.undoParent || parent === step.parent) return undefined;
  return `${step.id} now sits under ${home(parent)} rather than ${home(step.undoParent)} — it was re-parented since this proposal was filed, and moving it to ${step.parent} would overwrite that`;
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
      // The home's end of a `misfiled` match, re-asked under its own lock for the reason the
      // subject's is: the bars above ask only whether the home is still open, unclaimed and the
      // right tier, all of which a rewrite leaves untouched — and filing work under a home that has
      // since become something else is the misfiling the ask was raised to fix.
      return (
        homeUnusable(counterpart, nowMs) ??
        homeClaimed(step, counterpart) ??
        premiseTouched(counterpart, EVIDENCE_PREMISE[step.kind]?.twin, step.observedAtMs)
      );
    case "link":
      return blockerUnusable(counterpart, step.id);
    case "supersede":
      // The survivor's end of the same premise, re-asked under its own lock for the reason the
      // subject's is: `survivorUnusable` only asks whether it still reads as landed work, which a
      // rewrite leaves untouched — and superseding onto a twin that no longer holds the work would
      // close the last live copy of it.
      return (
        survivorUnusable(counterpart, step.id) ??
        premiseTouched(counterpart, EVIDENCE_PREMISE[step.kind]?.twin, step.observedAtMs)
      );
    default:
      return undefined;
  }
}

/**
 * Why a run has started on the target whose ticket set this step's subject rides, or undefined.
 * Judged by the same two bars the planner held the snapshot to — a live run, and a claim taken in
 * the window before a lease exists to see — so the write cannot pass an owner the decision would
 * have refused.
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
  const doing = takingTicket(step.verb, step.id);
  if (isInFlight(live, nowMs)) return inFlightReason(live, nowMs, doing);
  const claim = runClaimOf(live);
  if (!claim || claim === owner.claim) return undefined;
  return `${live.id} was claimed by ${claim} since this proposal was decided — that run has already selected the tickets it will work through, so ${doing} would abort it when its claim reaches a bead the board no longer holds`;
}

/** The bd verb each step resolves to — the only place this module spawns a write. */
async function runStep(repo: string, step: ApplyStep): Promise<void> {
  switch (step.verb) {
    case "reparent":
      await beads.reparent(repo, step.id, step.parent);
      return;
    case "link":
      // `bd link a b` = b blocks a, which is the direction the detection states.
      await beads.link(repo, step.id, step.blocker, "blocks");
      return;
    case "reprioritize":
      // Priority alone — no `currentLabels`, so `buildUpdateArgs` diffs no managed prefix and the
      // bead's `approved` / `stage:*` / `source:*` labels are untouched by the write.
      await beads.update(repo, step.id, { priority: step.priority });
      return;
    case "unapprove":
      // The note FIRST, then the label. Two writes, and only this order is safe to fail between: a
      // note that lands without the untag leaves the approval standing beside an explanation the
      // retry repeats, while an untag that lands without the note leaves a target that dropped out
      // of the queue saying nothing about why.
      await beads.note(repo, step.id, step.note);
      await beads.untag(repo, step.id, [LABELS.approved]);
      return;
    case "approve":
      await grantApproval(repo, step.id);
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
 * Grant the gate the way the approve route grants it: the auto-claim FIRST, then the label — the
 * same composition, through the same compare-and-swap (`beads/claim.ts`), so the two writers cannot
 * settle ownership by different rules.
 *
 * The order is the route's and only it is safe to fail between. `approved` is what locks the
 * reservation — the claim route refuses to touch an approved target — so a label that landed ahead
 * of the claim leaves a window in which a teammate's steal is still legal, on work anton is about to
 * run. A claim that lands without the label is a reserved target nothing picks up, which the retry
 * converges on: the swap reads owner→owner and writes nothing, then the label follows.
 *
 * The CAS is redundant against this process and not against the board: the fence above already
 * re-read the subject under this very lock, so a claim from another anton write queues behind us —
 * but bd is shared, and a teammate's `bd assign` from a shell takes no lock at all. Losing the swap
 * is the board declining, not a bd failure, which is why it refuses as a {@link SubjectMovedError}.
 *
 * `resolveOperator` is this machine's identity, memoized after its first read — the same one every
 * anton job claims under, so a shared board shows whose pipeline the start belongs to. With no
 * identity resolvable at all the swap is a verified no-op, exactly as it is on the route.
 */
async function grantApproval(repo: string, id: string): Promise<void> {
  const operator = await resolveOperator();
  const swap = await swapUnderLock(repo, id)(undefined, operator);
  if (!swap.ok) {
    throw new SubjectMovedError(
      `${id} was claimed by ${swap.owner ?? "another writer"} since this proposal was decided — approving it now would start a run on work somebody else has reserved`,
    );
  }
  await beads.approve(repo, id);
}

// ── rollback ──

/** Where each step of a rolled-back prefix ended up, for the clause the failure reports. */
interface RollbackOutcome {
  /** Left applied because the undo could not be made at all — a human has to settle it. */
  stranded: string[];
  /** Left applied because a run has since started on the card it was moved under. */
  adopted: string[];
  /** Left where another write has since moved it, which is newer than anything we recorded. */
  overtaken: string[];
}

/** What a rollback left behind: the clause the failure reports, and the beads it did not put back. */
export interface RollbackResult {
  /** The clause the apply failure ends on. */
  report: string;
  /**
   * Every bead this rollback left somewhere other than where the apply found it — stranded, adopted,
   * or overtaken. Carried as data as well as prose because the failure that ends here is reported as
   * `failed`, the one verdict that promises an unchanged board: a caller reading the verdict alone
   * would tell a founder nothing moved over beads this checkout has moved and cannot un-move, and
   * would go on reasoning against a snapshot those writes already invalidated (gardener/armed.ts
   * `movedTheBoard`). `overtaken` counts for the same reason the other two do — our write landed
   * locally, and another one landing on top of it does not put the bead back.
   */
  survivors: string[];
}

/**
 * Undo the steps that DID land when a later one failed, newest first, and report the outcome — as a
 * clause for the error, and as the beads that stayed moved. Only a cluster re-parent is ever
 * multi-step, so this is the one shape that can strand a half-applied move; every other move fails
 * with nothing written.
 *
 * A rollback that itself fails is named in the error rather than swallowed: the board is then in a
 * state a human has to look at, and saying so is the whole point of failing loud.
 */
export async function rollbackSteps(
  repo: string,
  applied: ApplyStep[],
): Promise<RollbackResult> {
  if (applied.length === 0) return { report: " — nothing had been written", survivors: [] };
  const outcome: RollbackOutcome = { stranded: [], adopted: [], overtaken: [] };
  for (const step of [...applied].reverse()) {
    await rollbackStep(repo, step, outcome);
  }
  return {
    report: rollbackReport(applied.length, outcome),
    survivors: [...outcome.stranded, ...outcome.adopted, ...outcome.overtaken],
  };
}

/**
 * Undo one applied step, recording where it ended up. Never throws: a rollback that fails is a line
 * in the report, not a second failure on top of the first.
 */
async function rollbackStep(
  repo: string,
  step: ApplyStep,
  outcome: RollbackOutcome,
): Promise<void> {
  if (step.verb !== "reparent") {
    outcome.stranded.push(step.id);
    return;
  }
  try {
    // Undone under the same per-bead locks the write took — the subject AND the home. The subject's
    // keeps a claim that queued behind the failed apply from interleaving with its rollback; the
    // HOME's is what makes the liveness check mean anything (anton-e42l). An early cluster member can
    // land, a run start on `step.parent` and confirm that member into its ticket set (execute-epic
    // step 1c, which holds this very lock), and only THEN a later member fail — so a rollback that
    // took the subject's lock alone would detach a ticket out from under a live run while it works,
    // on a selection that run has already fixed.
    await withBeadWriteLocks(repo, [step.id, step.parent], () => undoReparent(repo, step, outcome));
  } catch {
    outcome.stranded.push(step.id);
  }
}

/** Restore one re-parent's old home — but only what is still OURS to restore. */
async function undoReparent(
  repo: string,
  step: Extract<ApplyStep, { verb: "reparent" }>,
  outcome: RollbackOutcome,
): Promise<void> {
  // A read that FAILED proves nothing either way, so it is STRANDED rather than restored: the two
  // mistakes are not symmetric. Restoring on a blind read overwrites a newer move silently, and
  // nothing on the board says it happened; leaving the step applied names the bead in the error for
  // a human to settle. Fail loud beats fail quiet.
  const live = await beads.show(repo, step.id).catch(() => undefined);
  if (!live) {
    outcome.stranded.push(step.id);
    return;
  }
  // Another approval — of a different proposal naming the same subject — can land between this
  // apply's per-step locks, and restoring the parent this plan happened to record would clobber a
  // move somebody else has since made and now reads as the board's truth.
  if ((beads.parentOf(live) ?? "") !== step.parent) {
    outcome.overtaken.push(step.id);
    return;
  }
  const home = await beads.show(repo, step.parent).catch(() => undefined);
  if (homeAdopted(step, home)) {
    outcome.adopted.push(step.id);
    return;
  }
  await beads.reparent(repo, step.id, step.undoParent);
}

/**
 * Has the card this bead was moved under become a live run's ticket set? Judged by the same two bars
 * the write held the home to: a live run, and a claim taken since the step was decided. Either means
 * detaching now is the harm, so the move is LEFT and named rather than undone. A home we could not
 * read says nothing, and says it in the direction that would detach, so it counts as adopted for the
 * same fail-loud reason the subject read does.
 */
function homeAdopted(
  step: Extract<ApplyStep, { verb: "reparent" }>,
  home: Bead | undefined,
): boolean {
  if (!home) return true;
  return isInFlight(home, Date.now()) || homeClaimed(step, home) !== undefined;
}

/** What the rollback left behind, as the clause the apply failure ends on. */
function rollbackReport(applied: number, outcome: RollbackOutcome): string {
  if (outcome.stranded.length > 0 || outcome.adopted.length > 0) {
    return ` — ROLLBACK INCOMPLETE: ${incompleteClauses(outcome).join("; ")} — a human has to settle it`;
  }
  return outcome.overtaken.length === 0
    ? ` — the ${applied} write(s) already made were rolled back, so the board is unchanged`
    : ` — the ${applied} write(s) already made were rolled back, except ${list(outcome.overtaken)}, which another write has since moved and was left where it now sits`;
}

/** Every bead a human has to look at after an incomplete rollback, and why. */
function incompleteClauses(outcome: RollbackOutcome): string[] {
  return [
    outcome.stranded.length > 0 ? `${list(outcome.stranded)} could not be restored` : undefined,
    outcome.adopted.length > 0
      ? `${list(outcome.adopted)} was left in place because a run has since started on the card it was moved under, and detaching it would pull a ticket out of a selection that run has already made`
      : undefined,
    // Named here too: a human told to settle the board by hand needs every bead sitting somewhere
    // unexpected, not just the ones this rollback failed on.
    outcome.overtaken.length > 0
      ? `${list(outcome.overtaken)} was left where another write has since moved it`
      : undefined,
  ].filter((clause): clause is string => clause !== undefined);
}

export const oneLine = (text: string): string => text.replace(/\s+/g, " ").trim();

export const messageOf = (e: unknown): string =>
  oneLine(e instanceof Error ? e.message : String(e));
