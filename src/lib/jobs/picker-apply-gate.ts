/**
 * The BRAKES between a settled claim and the enqueue — the last window in which a start can still be
 * called off (PR #218 review).
 *
 * Everything behind this module is reversible and everything past it is not, so this is where the
 * pass spends its remaining doubt: the flow brake, which is the only one that can BLOCK for minutes
 * while it confirms a `gh pr view` per waiting PR; the board read that must follow such a
 * confirmation, because everything below is judged against the board; and the two settings brakes
 * plus the eligibility rule, asked last so they get the final word on the freshest read.
 *
 * The shape of the whole gate is a reconciliation, not a layering: each answer here can age behind
 * the next one's await, so a verdict is re-asked against the read taken on its far side until two
 * consecutive reads agree — and the pass fails closed rather than confirming forever.
 */
import { ownerOf } from "../beads/claim";
import { loadAllIssues } from "../beads/issues";
import type { Bead } from "../beads/types";
import {
  slotKey,
  type PickerDisarmCheck,
  type PickerHoldCheck,
  type PickerStanceCheck,
  type PickerWipLimitCheck,
} from "./picker-apply-checks";
import { stillStartable, type ClaimedTarget } from "./picker-apply-claim";
import {
  cancelled,
  CANCELLED_BEFORE_ENQUEUE,
  type PickerApplyOutcome,
} from "./picker-apply-outcome";
import { inReviewTargets } from "./run-health";

/**
 * Has a run joined the review queue that a given verdict never judged? (PR #218 review)
 *
 * The flow brake's verdict is taken over one board and spent on a later one, with a `gh pr view` per
 * waiting PR in between — minutes, at that read's ceiling. Confirming can only shrink the queue by
 * anything the BOARD shows: joining it means a run reaching `stage:in-review`, which only the board
 * can show. So a later board whose in-review targets are all ones the verdict already weighed cannot
 * have filled a slot it cleared this way, and the verdict stands. One it has never seen can, and only
 * a fresh verdict can say whether it did. (A slot the verdict retired can refill with no board change
 * at all; that half is reconciled by {@link sameRetired}.)
 *
 * Compared by (bead id, PR number) against the same `inReviewTargets` join the brake itself counts,
 * so the two cannot disagree about what occupies a slot. The PR number is half the identity (PR #218
 * review): a target whose merged PR is relinked to a fresh open one inside the window keeps its bead
 * id, so an id-only comparison would report no drift and spend a verdict that cleared the OLD
 * reference — while the new PR occupies a review slot the brake never counted, letting the pass
 * enqueue past the configured limit.
 */
function filledSince(judged: Bead[], fresh: Bead[]): boolean {
  const weighed = new Set(inReviewTargets(judged).map((s) => slotKey(s.bead.id, s.prNumber)));
  return inReviewTargets(fresh).some((s) => !weighed.has(slotKey(s.bead.id, s.prNumber)));
}

/**
 * Have the slots a verdict RETIRED changed under it? (PR #218 review)
 *
 * The board half of the reconciliation ({@link filledSince}) rests on confirming being able only to
 * SHRINK the queue — true of a merge, which retires its bead off the board, and false of a CLOSE,
 * which leaves the bead's stage and PR ref exactly where they were so a recovery re-run can find
 * them. REOPENING such a PR refills the slot the verdict cleared the pass into, with no board change
 * for the fresh read to catch and the same `(bead, PR)` pair on both sides.
 *
 * Nothing the board says can settle that, so it is settled the only way it can be: two consecutive
 * verdicts retiring the same slots agree about the PR states underneath them, and a reopen shows up
 * as the second verdict counting a slot the first did not — as a HOLD when it fills the limit, and
 * as a shrunken retired set when it does not.
 *
 * Where it STOPS is the final board read (PR #218 review): both agreeing verdicts are taken on its
 * NEAR side, so a reopen landing inside that read is one no reconciliation here can see. Closing
 * that window means a `gh pr view` between the last board read and the insert — a two-minute
 * ceiling for the approval, the claim and the eligibility rule to age behind, spent to spare the
 * flow limit one run it re-derives next cadence. The correctness half gets the last word, so this
 * narrows to a reopen during one `bd list` and is deliberately left there.
 */
function sameRetired(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const weighed = new Set(a);
  return b.every((key) => weighed.has(key));
}

/**
 * How many flow-brake verdicts one pass will spend before it gives up (PR #218 review).
 *
 * Each re-ask exists to catch a slot taken while the previous one confirmed its PRs, so the loop
 * only turns while the queue keeps GROWING under it — which on a healthy project it never does. A
 * queue filling that fast is a flow problem the brake is already reporting; standing down leaves the
 * target startable next cadence rather than confirming PRs forever against a run that cannot be
 * taken back.
 */
const FLOW_CONFIRMATION_LIMIT = 3;

/** A flow limit that could not be read fails closed, exactly as an unreadable hold does. */
const LIMIT_UNREADABLE = "the review limit could not be read before starting";

/** A board read past the CAS, with the reservation re-proven on it — see {@link readStartGate}. */
export interface GateRead {
  board: Bead[];
  target: Bead;
}

export interface StartGateInput {
  repoPath: string;
  beadId: string;
  /** This machine's claim identity — what every re-proof of the reservation compares against. */
  operator: string;
  /** The writes this pass made, and the two ways it can put them down. */
  claimed: ClaimedTarget;
  stance: PickerStanceCheck;
  disarmed: PickerDisarmCheck;
  held: PickerHoldCheck;
  wipLimit: PickerWipLimitCheck;
  /** The settle's board where there was one — see `SettledClaim` in `./picker-apply-claim`. */
  settledBoard: Bead[] | undefined;
  signal?: AbortSignal;
}

/** The board this gate judges everything against. FAILS CLOSED, like every other read here. */
async function readGateBoard(repoPath: string): Promise<Bead[] | string> {
  try {
    return await loadAllIssues(repoPath);
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    return `the board could not be read before starting (${detail})`;
  }
}

/**
 * A reservation this pass no longer holds, wherever it is read (PR #218 review). Every gate below
 * judges the target with the claim cleared (see `asUnclaimed`), so an ownership change — a merge
 * this machine lost, or a human clearing the assignee — would otherwise be discarded and the pass
 * would enqueue a second run against someone else's reservation.
 *
 * A NAMED successor keeps this pass's approval, exactly as a lost merge does: withdrawing it now
 * would strip it out from under the holder whose decision it has become. A claim that was merely
 * RELEASED keeps nothing (PR #218 review) — nobody is running on that approval, and an approved,
 * unassigned target with no run is precisely what the next worker starts on, which is the
 * unattended start this pass just stood down from. So it unwinds like any other stand-down.
 */
function lostClaim(
  claimed: ClaimedTarget,
  holder: string | undefined,
): Promise<PickerApplyOutcome> | PickerApplyOutcome {
  if (!holder) {
    return claimed.standDown("the claim was released while the review queue was confirmed");
  }
  return claimed.keepWrites(`${holder} claimed it first`);
}

/**
 * Re-read the board and re-prove the claim on it: the pair of questions every gate below is judged
 * over, in one place because they are asked once per confirmation rather than once per pass.
 * Ownership is asked BEFORE each further confirmation as well as after it — a target this pass has
 * already lost is not worth minutes of `gh` reads to decide about.
 */
async function readStartGate(input: StartGateInput): Promise<GateRead | PickerApplyOutcome> {
  const { claimed } = input;
  const board = await readGateBoard(input.repoPath);
  if (typeof board === "string") return claimed.standDown(board);
  const target = board.find((b) => b.id === input.beadId);
  if (!target) return claimed.standDown("the target left the board before its run was enqueued");
  const holder = ownerOf(target);
  if (holder !== input.operator) return lostClaim(claimed, holder);
  return { board, target };
}

/** A flow verdict and the two inputs it rests on that no later board read can re-check. */
interface FlowVerdict {
  board: Bead[];
  limit: number;
  /** The slots the verdict took off the board's count to reach it — see {@link sameRetired}. */
  retired: readonly string[];
  /** What the verdict BEFORE it retired, once there has been one. */
  previouslyRetired?: readonly string[];
}

/**
 * What has moved under a flow verdict since it was taken — the reason to re-ask it, or nothing.
 *
 * All three of the verdict's inputs age the same way and are reconciled on the same terms: the
 * board it counted, the operator's limit it was resolved against, and the PR states behind the slots
 * it retired. See {@link filledSince} and {@link sameRetired}.
 */
function verdictDrift(
  judged: FlowVerdict,
  fresh: { board: Bead[]; limit: number },
): string | undefined {
  if (fresh.limit !== judged.limit) {
    return "the review limit kept changing while the queue was confirmed";
  }
  if (filledSince(judged.board, fresh.board)) {
    return "the review queue kept filling while it was confirmed";
  }
  // A verdict that retired nothing rests only on what this read just re-confirmed; one that retired
  // a slot needs a second verdict to agree with it, and only reaches the stand-down below once those
  // two keep disagreeing.
  const agreed = judged.previouslyRetired && sameRetired(judged.previouslyRetired, judged.retired);
  if (judged.retired.length > 0 && !agreed) {
    return "the review queue's own PRs kept changing state while it was confirmed";
  }
  return undefined;
}

/**
 * Read the board on the far side of the flow confirmation, and keep re-asking the brake until a read
 * and a verdict agree (PR #218 review).
 *
 * The read can block for exactly as long as the confirmation that preceded it — a `gh pr view` per
 * waiting PR — and a verdict it CLEARS is precisely the case where PRs moved, so the board very
 * likely moved with them: judging the reservation, the eligibility rule or the policy off the
 * snapshot the confirmation began with would reopen the window this read exists to close.
 *
 * Which leaves the brake's OWN verdict as the last thing that can age behind a confirmation. So the
 * two are reconciled rather than layered — the read is taken, and while it shows drift the brake is
 * re-asked over IT and the board re-read on the far side of that. Confirming can only shrink the
 * queue (see {@link filledSince}), so a read that adds nothing new is one the standing verdict
 * already covers, and the loop ends there — on the common pass, at the first read, with no extra
 * `gh` at all. A queue filling faster than it can be confirmed never converges, so the pass fails
 * closed rather than spinning: the target is startable again next cadence.
 *
 * The answer is the LAST board read before the enqueue, and no blocking await sits between it and
 * the insert — only the local reads in {@link brakeStartGate}.
 */
async function confirmFlowVerdict(
  input: StartGateInput,
  first: FlowVerdict,
): Promise<GateRead | PickerApplyOutcome> {
  const { claimed } = input;
  let judged = first;
  for (let confirmations = 2; ; confirmations += 1) {
    const fresh = await readStartGate(input);
    if (!("board" in fresh)) return fresh;
    // The limit read on the far side of the verdict, and the near side of the next one: the queue is
    // only half of what the brake judged, and a setting the operator moved inside that confirmation
    // ages exactly as the board does.
    const freshLimit = await input.wipLimit();
    if (freshLimit === undefined) return claimed.standDown(LIMIT_UNREADABLE);
    const drifted = verdictDrift(judged, { board: fresh.board, limit: freshLimit });
    if (!drifted) return fresh;
    if (confirmations >= FLOW_CONFIRMATION_LIMIT) return claimed.standDown(drifted);
    const refilled = await input.held(fresh.board);
    if (refilled.hold) return claimed.standDown(refilled.hold);
    judged = {
      board: fresh.board,
      limit: freshLimit,
      retired: refilled.retired ?? [],
      previouslyRetired: judged.retired,
    };
  }
}

/**
 * The last three questions, together on that one fresh read so none of them ages behind another's
 * await: the disarm latch — which a breaker can raise on a run settling into a failing streak —
 * beside the board's own eligibility rule and the operator's policy, re-asked exactly as the settle
 * asked them (PR #218 review). See `pickerDisarmed` and {@link stillStartable}.
 *
 * The reservation is NOT re-proven on their far side, and deliberately so (PR #218 review). Every
 * read behind these three is anton.db through better-sqlite3 — synchronous, in-process, no socket
 * and no subprocess — so the window they open before the insert is a microtask, not the seconds a
 * `bd list` or a `gh pr view` costs. Re-proving ownership there means another board read, and the
 * board read is itself the long await: whatever followed it would sit behind a window ORDERS of
 * magnitude wider than the one it closed, and the enqueue can never be reached with no window at
 * all. So the last board read stays as close to the insert as a read can be: nothing between them
 * leaves this process.
 */
async function brakeStartGate(
  input: StartGateInput,
  final: GateRead,
): Promise<PickerApplyOutcome | undefined> {
  const { claimed } = input;
  const [frozen, moved] = await Promise.all([
    input.disarmed(),
    stillStartable(final.board, final.target, input.stance, "while the review queue was confirmed"),
  ]);
  if (frozen) return claimed.standDown(frozen);
  if (moved) return claimed.standDown(moved);

  // And the cancellation once more on the far side of the brakes (PR #218 review), because every one
  // of them is an await: a cancel landing while the WIP hold is derived or the freeze is read would
  // otherwise fall straight into the enqueue, and the post-insert sweep check deliberately KEEPS a
  // run it finds active — so the pass would leave teardown exactly the unattended run it stands down
  // to avoid. This is the last seam before the irreversible half.
  if (cancelled(input.signal)) return claimed.standDown(CANCELLED_BEFORE_ENQUEUE);
  return undefined;
}

/**
 * Every brake between the settled claim and the enqueue, in the order their cost and their authority
 * put them — answering with the board the run is started against, or the skip that called it off.
 *
 * The cancellation goes first: everything above it is reversible, a run is not, so a cancel that
 * landed anywhere in the refresh, the CAS or the settle window is spent HERE rather than on a run
 * teardown would have to delete out from under an approved, claimed bead.
 *
 * Then the FLOW brake, ahead of the two settings brakes (PR #218 review): it is the only one that
 * can BLOCK — a `gh pr view` per waiting PR, each with a two-minute ceiling of its own — so THEY get
 * the last word before the enqueue rather than aging behind it. A run that reached `stage:in-review`
 * while this pass claimed and settled, or an operator who lowered the limit in it, fills the review
 * queue the entry gate found bandwidth in, and the hold is derived rather than latched, so only
 * re-asking can see it. Judged against the settle's read where there was one — the freshest board
 * this pass has — and against one of its own otherwise, since a no-op swap settles nothing.
 */
export async function confirmStartGate(
  input: StartGateInput,
): Promise<GateRead | PickerApplyOutcome> {
  const { claimed } = input;
  if (cancelled(input.signal)) return claimed.standDown(CANCELLED_BEFORE_ENQUEUE);

  const holding = await input.held(input.settledBoard);
  if (holding.hold) return claimed.standDown(holding.hold);

  const gate = await readStartGate(input);
  if (!("board" in gate)) return gate;

  // The flow brake once more, now against THIS read (PR #218 review): a run reaching
  // `stage:in-review` while the first call confirmed its PRs fills the very slot that call cleared
  // the pass into, and only a verdict taken on the far side of that confirmation can see it. Free
  // wherever the board still shows bandwidth — under the limit the hold spawns no `gh` at all (see
  // `confirmWipQueue`).
  //
  // Its limit is snapshotted on the NEAR side, because the verdict resolves its own copy between
  // this read and the one below it: a limit that reads the same on both sides is the one the verdict
  // was taken under, and a limit that moved leaves the verdict spent on a rule the project no longer
  // has. See `pickerWipLimit`.
  const judgedLimit = await input.wipLimit();
  if (judgedLimit === undefined) return claimed.standDown(LIMIT_UNREADABLE);
  const stillHolding = await input.held(gate.board);
  if (stillHolding.hold) return claimed.standDown(stillHolding.hold);

  const final = await confirmFlowVerdict(input, {
    board: gate.board,
    limit: judgedLimit,
    retired: stillHolding.retired ?? [],
  });
  if (!("board" in final)) return final;

  const braked = await brakeStartGate(input, final);
  return braked ?? final;
}
