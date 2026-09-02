/**
 * APPLY: the board-picker starts its top-ranked target (R1.5-R1.7).
 *
 * The pass above this one decides and records; this is the only place it WRITES. It writes exactly
 * what a human approval writes, through the same code: `approved` plus the auto-claim, as one
 * operation under the bead's claim-write lock (`beads/approve-claim.ts`, shared with the approve
 * route), then an enqueue through `enqueueExecuteEpicIfAbsent` — the idempotent path unstick and
 * gate-check already use, so two overlapping passes leave exactly one run — or, where that path
 * finds a run already parked on the target, the same resume unstick would give it.
 *
 * ONE target per pass, the top of the ranking. The plan is a view of the board, never a queue of
 * events (gate-check.ts's rule, which this inherits): "listed" must not read as "start it", so the
 * pass takes the single pick its ranking is confident about and re-decides everything else from a
 * fresh board next cadence, when the brakes, the budget and the operator's vetoes have all had a
 * chance to move.
 *
 * Five things this deliberately does NOT do:
 *
 *   • It never takes a target a HUMAN holds. The plan already excludes claimed targets, and the
 *     guard re-asks under the lock — a claim landing in that window loses the target, not the claim.
 *   • It never writes `approved` speculatively. The label is contingent on the CAS, so a lost claim
 *     race leaves the bead exactly as it found it: unapproved, unclaimed, and startable by whoever
 *     won. Losing is a SKIP, never a retry — retrying into a race is how one target becomes two runs.
 *   • It never bypasses the budget. The enqueue asks for no `bypassBudget`, so a governed project
 *     paces a policy start exactly as it paces a queued one.
 *   • It never outlives its own cancellation. The pass's signal is carried through every seam here,
 *     not just checked before the call, and the queue verbs run through the runner's quiesce gate —
 *     so a project being deleted mid-apply gets its writes taken back rather than a run it has to
 *     sweep and a bead left approved and claimed by anton (see {@link cancelled}) — and the same
 *     check is handed back for the awaits the CALLER spends after a start (see {@link ConfirmStart}).
 *   • It never invents a claim protocol. The bead write-lock and the assignee CAS are the ones the
 *     approve route uses; on an embedded board the mirror they judge is refreshed first (see
 *     {@link refreshFor}), and on every board with a second writer the reservation is settled and
 *     read back before anything is enqueued (see {@link settleClaim}) — the pass stands down
 *     whenever either leg fails.
 */
import { beads, CLAIM_SETTLE_MS, type SyncOutcome } from "../beads/bd";
import { isServerMode } from "../beads/board-mode";
import { approveAndClaim, unwindApproveClaim } from "../beads/approve-claim";
import { ownerOf } from "../beads/claim";
import { loadAllIssues } from "../beads/issues";
import { nudgeSync } from "../beads/sync-nudge";
import type { Bead } from "../beads/types";
import type { PickerPlanEntry } from "../board-picker-plan";
import { resolveOperator } from "../operator";
import { recordPickerStart } from "../picker-starts";
import { pickerTrackRecord } from "../picker-veto";
import { getProjectSettings, resolvePickerAutonomy, resolvePickerPolicy } from "../projects";
import { armedPickerPolicy } from "./picker-policy";
import { ineligibility } from "./picker-targets";
import {
  activeExecuteEpicId,
  enqueueExecuteEpicIfAbsent,
  resumableExecuteEpicId,
  resumeJob,
  type AntonDb,
  type Clock,
} from "./queue";

/**
 * The actor every unattended board write is attributed to (R1.7), matching `gardener/apply.ts`:
 * a start nobody watched is recorded as made by nobody, so a reader scanning `bd` history can tell
 * anton's own decisions from a founder's without opening anton at all.
 */
export const POLICY_ACTOR = "policy";

/** What one pass started: the pick, where it stood, and the run it enqueued. */
export interface PickerStart {
  beadId: string;
  rank: number;
  rule: string;
  jobId: string;
}

/**
 * Why a pass started nothing, and whether it left anything behind.
 *
 * `wroteBoard` is the caller's cue that this skip still moved the board (PR #218 review): a target
 * an already-live run covers keeps the approval and the claim, and an unwind that could not finish
 * leaves part of them. Both are inputs to the plan's freshness fence, so a caller that stamped a
 * plan before the apply has to re-stamp it exactly as it does after a start.
 */
export interface PickerSkip {
  beadId?: string;
  reason: string;
  wroteBoard?: boolean;
}

/**
 * Re-ask the teardown question once the CALLER's own post-start awaits are done (PR #218 review).
 *
 * `applyPickerPlan` re-checks the sweep at every seam of its own audit writes, but its last check is
 * still before it returns — and the caller then spends a board read of its own restamping the plan.
 * A cancel landing in that window is `abortProject` deleting the run this pass just enqueued, which
 * would leave the approval and the claim standing over nothing. Answers with the skip the pass
 * became, or undefined while the run stands.
 */
export type ConfirmStart = () => Promise<PickerApplyOutcome | undefined>;

/**
 * One apply pass's outcome. A skip is a VALUE and carries its reason: a pass that starts nothing is
 * the common case (a moved board, a claim lost, a run already covering the target), and it has to be
 * readable in the log without being an error.
 */
export type PickerApplyOutcome =
  | { started: PickerStart; confirmStart: ConfirmStart }
  | { skipped: PickerSkip };

/** Why the under-lock guard abandoned the start — see {@link applyPickerPlan}. */
type StartRefusal = { stale: string } | { ineligible: string };

export interface PickerApplyInput {
  db: AntonDb;
  clock: Clock;
  projectId: string;
  repoPath: string;
  /** The plan this pass decided, in rank order. Only its first entry is ever started. */
  entries: readonly PickerPlanEntry[];
  /** The settle seam — production passes none. See {@link ClaimSettleDeps}. */
  settle?: ClaimSettleDeps;
  /**
   * The pass's cancellation, carried THROUGH the apply rather than only checked before it (PR #218
   * review). The refresh, the settle and the claim are seconds of awaits, and a cancel landing in
   * them is `abortProject` tearing the project down: the writes this pass has made must come back
   * off rather than be left on the board of a project that is going away. See {@link cancelled}.
   */
  signal?: AbortSignal;
  /**
   * The two queue verbs a start needs, injectable exactly as unstick's `EpicResumeOps` is, so the
   * scheduled pass routes them through the runner singleton — whose quiesce gate refuses a project
   * mid-teardown — while a test drives them db-directly.
   */
  run?: PickerRunOps;
  /**
   * The standing-approval re-check, defaulting to {@link pickerStance} over this pass's own db. A
   * seam only so a test can drive the withdrawal window without a settings row to race against.
   */
  stance?: PickerStanceCheck;
}

/**
 * Is the operator's standing approval STILL what this start rests on? Answers with the reason it is
 * not, or undefined while it holds — the same shape as the board's own exclusions, because to a
 * reader "the policy stopped admitting it" and "the target stopped being startable" are one question
 * asked of two sources.
 */
export type PickerStanceCheck = (target: Bead, board: Bead[]) => Promise<string | undefined>;

/**
 * Re-resolve the picker's stance and judge the target against it (PR #218 review).
 *
 * `ineligibility` re-asks the BOARD's question under the lock and again after the settle; this asks
 * the SETTINGS one, which nothing else re-asks. The stance the pass is acting on was read once,
 * before the ranking, and everything since is a board read, a CAS and a settle window — long enough
 * for the operator to withdraw the very approval the start stands on. Removing the work policy,
 * narrowing it past this target, relabelling the target out of it, or moving the picker off `apply`
 * are all the same act: the standing approval is gone, and a start made on the old one is
 * unattended work nobody currently sanctions.
 *
 * Resolved through `resolvePickerAutonomy`/`resolvePickerPolicy` rather than by re-reading the
 * stored fields, so both floors — the armed policy and the EARNED record — bite here exactly as they
 * do where the pass first decided to call the apply at all.
 */
export function pickerStance(db: AntonDb, projectId: string): PickerStanceCheck {
  return async (target, board) => {
    const settings = await getProjectSettings(db, projectId);
    const autonomy = resolvePickerAutonomy(settings, await pickerTrackRecord(db, projectId));
    if (autonomy !== "apply") {
      return `this project's picker autonomy is no longer apply (now ${autonomy})`;
    }
    const armed = resolvePickerPolicy(settings);
    // Unreachable while `resolvePickerAutonomy` floors an unarmed project to `shadow`; kept because
    // the two resolutions are separate functions and a start off no policy is the one outcome this
    // whole gate exists to refuse.
    if (!armed) return "the work policy behind this start was withdrawn";
    const verdict = armedPickerPolicy(armed, board).admits(target);
    if (verdict.admitted) return undefined;
    return verdict.detail
      ? `the work policy no longer admits it — ${verdict.detail}`
      : "the work policy no longer admits it";
  };
}

/**
 * The queue half of a start, behind a seam.
 *
 * The raw `./queue` functions insert unconditionally; the runner's methods of the same name check
 * the project's quiesce barrier FIRST, in the same synchronous step as the insert, so a delete that
 * raised the barrier cannot have a run slip in behind it (PR #218 review). Only the runner can make
 * that check atomic — the barrier is its own in-memory set — so the pass takes the verbs from it.
 */
export interface PickerRunOps {
  enqueueIfAbsent(projectId: string, epicBeadId: string): string | undefined;
  resume(jobId: string): Promise<boolean>;
}

/**
 * The bead note that records a start (R1.7) — one line, because beads stores notes as a single
 * newline-joined blob where each unindented line is its own entry.
 *
 * It names the RULE and the RANK because those are the two questions asked of an unattended start:
 * which of my criteria let this through, and why this one before the others. The last sentence is
 * the one the gardener's armed applies also carry — the answer to "who approved this" is nobody, and
 * the setting is what a reader has to change.
 */
export function pickerStartNote(entry: PickerPlanEntry, ranked: number): string {
  return (
    `anton: started by POLICY — rank ${entry.rank} of ${ranked}, admitted by ${entry.rule}. ` +
    `Nobody approved this: this project's picker autonomy is set to apply.`
  );
}

/**
 * Refresh the local mirror before the CAS, or refuse — the cross-machine half of the guard.
 *
 * The claim lock is keyed on `repoPath`, so it orders THIS machine only; across machines the guard
 * is the assignee CAS, and on an embedded board that CAS reads a per-machine mirror which trails the
 * shared remote by a sync heartbeat. A claim another machine published moments ago is invisible in
 * that window, and the only direction a stale mirror can be wrong is the one that double-approves.
 * So the pass pulls first and FAILS CLOSED when the pull does not land — the same treatment unstick
 * gives cross-machine run ownership.
 *
 * Undefined on a shared-server board: there is no mirror to refresh (the write is global the moment
 * it commits), and `bd dolt pull` would run against the server and fail.
 */
function refreshFor(repoPath: string): (() => Promise<StartRefusal | undefined>) | undefined {
  if (isServerMode(repoPath)) return undefined;
  return async () => {
    try {
      await beads.pull(repoPath);
      return undefined;
    } catch (e) {
      return { stale: `the board could not be refreshed before claiming (${errorText(e)})` };
    }
  };
}

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

const sleepMs = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    if (typeof t.unref === "function") t.unref();
  });

/**
 * The settle seam, declared structurally like `beads.claimVerified`'s own deps so a test can drive
 * the cross-machine window without a remote to race against.
 */
export interface ClaimSettleDeps {
  push?: (cwd: string) => Promise<SyncOutcome>;
  pull?: (cwd: string) => Promise<unknown>;
  /** Fresh `--status all` board, for the post-settle re-validation (see {@link settleClaim}). */
  board?: (cwd: string) => Promise<Bead[]>;
  sleep?: (ms: number) => Promise<void>;
  settleMs?: number;
}

/**
 * Whether the reservation survived the remote's merge AND still names startable work — see
 * {@link settleClaim}. `stale` is the claim we WON on a target that stopped being eligible while we
 * settled: ours on paper, not runnable, and the writes are ours to take back.
 */
type SettleVerdict = { held: true } | { lost: string } | { unverified: string } | { stale: string };

/**
 * Prove the claim cross-machine BEFORE the enqueue — the settle half of the pickup protocol
 * (`beads.claimVerified` steps 3-6), applied to this pass's own CAS (PR #218 review).
 *
 * The claim lock and the assignee CAS order THIS process only, and the pull that precedes them can
 * itself lose a race: two pickers on two machines can both refresh, both find the target unclaimed,
 * and both write. So a local `ok` is a proposal, not a claim — until the write has been published
 * and read back through the remote's merge, where exactly one assignee survives. The enqueue is the
 * irreversible half of a start (a second machine's run is not something a later pass can take back),
 * so the proof has to come before it, not after.
 *
 * A shared-server board drops the SYNC legs and keeps the settle (PR #218 review). There is nothing
 * to publish — the write landed on the one database the moment bd committed it — but that is not the
 * same as being arbitrated: unlike `beads.claimVerified`, which rides bd's atomic `bd update
 * --claim`, this pass reserves through a read-then-`assign` CAS (a policy claim must not flip the
 * status), and two processes can both read the target free and both write, with the LAST write
 * standing. Waiting the propagation window and re-reading is what turns that last-write-wins into a
 * decided race: after both writes have landed, both processes read the same single assignee, and
 * only its owner starts anything.
 *
 * A not-wired embedded board drops the propagation WINDOW and keeps the re-validation, exactly as
 * `beads.claimVerified` does (PR #218 review): with no remote there is no merge to wait out, but the
 * board and the operator's stance can still have moved while this pass's own approve and claim
 * commands ran, and those are the checks that would otherwise never be re-asked on the default local
 * board.
 *
 * The assignee is machine-scoped, not per-instance (see `lib/operator.ts`: it is the same identity
 * the run ownership gate and review-fix's PR filter compare against), so two machines resolving to
 * one operator string cannot be told apart HERE — that residual cross-process window is the one
 * `beads/claim.ts` documents and anton-od4 tracks, and it is what a write landing AFTER the loser's
 * settle read leaves open. It is not the last guard: the irreversible half, the run itself,
 * arbitrates on a per-run lease token in `execute-epic.ts`, so a double enqueue still ends with
 * exactly one run and the other parked.
 */
async function settleClaim(
  repoPath: string,
  beadId: string,
  owner: string,
  stance: PickerStanceCheck,
  deps: ClaimSettleDeps = {},
): Promise<SettleVerdict> {
  // On a shared server the board IS the remote: every leg below that reconciles a local mirror is
  // not just unnecessary but unrunnable (`bd dolt pull/push` would run on the server itself).
  const shared = isServerMode(repoPath);
  const push = deps.push ?? beads.push;
  const pull = deps.pull ?? beads.pull;
  const readBoard = deps.board ?? loadAllIssues;
  const sleep = deps.sleep ?? sleepMs;

  // Is there a second writer whose write this pass has to WAIT OUT? A shared server always has one;
  // an embedded board has one only once it is wired to a remote.
  let arbitrated = shared;
  if (!shared) {
    let outcome: SyncOutcome;
    try {
      outcome = await push(repoPath);
    } catch (e) {
      return { unverified: `the claim could not be published before starting (${errorText(e)})` };
    }
    // An unwired board publishes nowhere, so there is no merge to settle for and nothing to pull
    // back — but that is the REMOTE half only (PR #218 review). Everything below still runs: the
    // operator can move the picker off `apply`, narrow the policy or relabel the target as human
    // work while this pass's own `bd` writes are in flight, and on the default local board this is
    // the only place those answers are re-asked after the under-lock read.
    arbitrated = outcome === "synced";
  }

  if (arbitrated) await sleep(deps.settleMs ?? CLAIM_SETTLE_MS);
  // The whole board, not just the bead: winning the assignee proves the race was won, not that the
  // prize is still worth having, and the re-validation below judges the target against its parents,
  // its children and its blockers.
  let board: Bead[];
  try {
    if (arbitrated && !shared) await pull(repoPath);
    board = await readBoard(repoPath);
  } catch (e) {
    return { unverified: `the claim could not be read back before starting (${errorText(e)})` };
  }
  const settled = board.find((b) => b.id === beadId);
  if (!settled) return { lost: "the target left the board while the claim settled" };

  const holder = ownerOf(settled);
  if (holder !== owner) {
    // A claim that did not survive the merge is not ours to unwind: the `approved` label merged too,
    // and whoever holds the reservation now is the one whose decision that label belongs to. Pulling
    // it back would be worse than leaving it (PR #218 review): the winner is almost always the other
    // picker, which wrote the SAME single label, so a withdrawal here would strip the approval out
    // from under a run that has already started and leave it parked on a target it legitimately won.
    return {
      lost: holder ? `${holder} claimed it first` : "the claim did not survive the board merge",
    };
  }

  // The approval, which the eligibility rule below deliberately never asks about: the picker is the
  // label's second WRITER, so its rule tests whether approval WOULD hold, not whether it is there
  // (picker-targets.ts). After the settle that is the wrong question — this pass already wrote the
  // label, and another client can withdraw it inside the window while leaving this assignee
  // untouched. Enqueueing then buys a run execute-epic only poison-parks as unapproved (PR #218
  // review), so the label is re-checked here, beside the rule that cannot see it.
  if (!beads.isApproved(settled)) {
    return { stale: "the approval was withdrawn while the claim settled" };
  }

  // Re-ask the pass's OWN eligibility rule against the board the settle just pulled — the same
  // post-settle re-validation `beads.staleClaimReason` does for a worker's pickup (PR #218 review).
  // Another machine can close, abandon or block the target, label it `agent:human`, or attach a
  // feature child inside the settle window while leaving this assignee untouched; the holder check
  // above cannot see any of it, and enqueueing anyway buys a run execute-epic only poison-parks.
  // Judged with the reservation cleared, because the claim under test is the very one we just took —
  // exactly the assignee leg `staleClaimReason` leaves out for the same reason. The board is cleared
  // with it: the policy stance below reads the target out of the startable projection, which the
  // assignee alone would keep it out of.
  const free = { ...settled, assignee: undefined };
  const asFree = board.map((b) => (b.id === beadId ? free : b));
  const excluded = ineligibility(free, asFree);
  if (excluded) {
    const why = excluded.detail ? `${excluded.reason} — ${excluded.detail}` : excluded.reason;
    return { stale: `the target stopped being startable while the claim settled (${why})` };
  }

  // And the OPERATOR's half of the same question, which no board read can answer (PR #218 review):
  // the standing approval this start rests on can be withdrawn inside the settle window as easily as
  // the target can move under it. See {@link pickerStance}.
  const withdrawn = await stance(free, asFree);
  if (withdrawn) {
    return { stale: `the standing approval was withdrawn while the claim settled (${withdrawn})` };
  }
  return { held: true };
}

/**
 * Undo what THIS pass wrote when the enqueue never happened — the one failure that would otherwise
 * strand the target for good.
 *
 * An approved, self-claimed target with no run is invisible to the next pass (its own guard reads it
 * as claimed) and to a human (it looks like work already under way). The ordering that takes the
 * writes back safely — label first, each leg gating the next, an ambiguous label write re-read
 * before it is untagged — belongs to `beads/approve-claim.ts` alongside the sequence it reverses,
 * and is shared with the approve route so the two compensations cannot drift (PR #218 review).
 *
 * What stays here is the WORDING: a skip reason has to name the state this pass left rather than
 * report a clean stand-down over a half-written target.
 */
async function unwindStart(
  repoPath: string,
  beadId: string,
  owner: string,
  wrote: { label: boolean; claim: boolean },
): Promise<string | undefined> {
  const leftover = await unwindApproveClaim({
    repoPath,
    beadId,
    owner,
    restoreTo: undefined,
    wroteLabel: wrote.label,
    wroteClaim: wrote.claim,
  });
  if (leftover === "approval") {
    return `${beadId} is left approved and claimed by anton — unapprove it by hand`;
  }
  if (leftover === "claim") return `${beadId} is left claimed by anton — clear its assignee by hand`;
  return undefined;
}

/** A skip reason plus whatever {@link unwindStart} could not take back — one line, both facts. */
function withLeftover(reason: string, leftover: string | undefined): string {
  return leftover ? `${reason}; ${leftover}` : reason;
}

/**
 * Resume the epic's settled-but-recoverable run, and answer with the job that is now running.
 *
 * `enqueueExecuteEpicIfAbsent` counts a `parked`/`failed` job as COVERING the epic, so it withholds
 * an id for one — but nothing redispatches a parked job on its own. Left there, the approval and the
 * claim this pass just wrote would hide the target from every later pass with no run behind them
 * (PR #218 review). Reached exactly where the unstick pass reaches for the same verb, and for the
 * same reason: a parked run is revived by resuming THAT job, so it reuses its open run and worktree
 * rather than starting a duplicate beside it.
 *
 * Undefined when there is nothing to resume, or when the resume lost its own CAS — an operator's
 * cancel, or a fresh job that took the epic's active slot first. The caller decides what that means
 * for its writes.
 */
async function resumeSettledRun(
  db: AntonDb,
  projectId: string,
  epicBeadId: string,
  resume: (jobId: string) => Promise<boolean>,
): Promise<string | undefined> {
  const resumable = await resumableExecuteEpicId(db, projectId, epicBeadId);
  if (!resumable) return undefined;
  return (await resume(resumable)) ? resumable : undefined;
}

/**
 * Whether the pass has been cancelled — asked at every seam that separates two of its writes, not
 * once before the first (PR #218 review).
 *
 * The caller's pre-call gate only proves the pass was live when the apply STARTED. What follows is
 * seconds of I/O — a mirror refresh, the CAS, the settle window — and a cancel landing anywhere in
 * it is `abortProject`: the project's queued rows are being deleted, so a run enqueued after it is
 * one teardown deletes (leaving an approved, anton-claimed bead behind) or one that trips teardown's
 * own leftover guard. Both are avoided the same way — stop, and take back whatever was written.
 */
function cancelled(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

/**
 * Start the plan's top-ranked target: approve it, claim it, enqueue its run, and record why.
 *
 * The caller owns the decision to CALL this — the armed level, the disarms, the WIP hold. What is
 * owned here is that the start is atomic, idempotent and reversible: no label without a claim, no
 * second run behind an overlapping pass, and nothing left half-written when the enqueue falls over.
 */
export async function applyPickerPlan(input: PickerApplyInput): Promise<PickerApplyOutcome> {
  const { db, clock, projectId, repoPath, entries, signal } = input;
  const top = entries[0];
  if (!top) return { skipped: { reason: "the plan ranked nothing to start" } };

  // db-direct by default (a test drives them that way); the scheduled pass is handed the runner's,
  // which refuse a project mid-teardown. See {@link PickerRunOps}.
  const enqueueIfAbsent =
    input.run?.enqueueIfAbsent ??
    ((project: string, epic: string) => enqueueExecuteEpicIfAbsent(db, clock, project, epic));
  const resume = input.run?.resume ?? ((jobId: string) => resumeJob(db, clock, jobId));
  const stance = input.stance ?? pickerStance(db, projectId);

  // Publish this pass's writes on EVERY path that made one, not only the started one (PR #218
  // review). A skip is not a no-op once the approval and the claim have landed: unpublished, they
  // are invisible to the second machine, whose next pass then reads the target as free — the very
  // double-start the refresh and the settle spend a round trip each to prevent.
  const publish = () => nudgeSync({ id: projectId, repoPath }, "picker-apply");

  // This machine's identity, exactly as the approve route resolves it: the assignee a run's ownership
  // gate reads. Without one the pass REFUSES to start anything (PR #218 review): the assignee is the
  // whole cross-machine guard, and an undefined one makes the CAS an unassigned→unassigned no-op that
  // settles nothing — two pickers would both approve and both enqueue the same target. A human
  // approving by hand is present to see that; an unattended start has only the claim as its proof.
  const operator = await resolveOperator();
  if (!operator) {
    const reason =
      "this machine has no claim identity to start work under — set ANTON_OPERATOR (or a global " +
      "git user.name)";
    return { skipped: { beadId: top.beadId, reason } };
  }

  // The cheapest cancel to honour: nothing is written yet, so a pass cancelled while it resolved its
  // identity stands down with no board state of its own to take back.
  if (cancelled(signal)) {
    const reason = "the pass was cancelled before it claimed anything";
    return { skipped: { beadId: top.beadId, reason } };
  }

  // Set by the guard, off the board read the write is made against: whether the label is OURS to
  // take back if the enqueue then fails (see unwindStart).
  let wroteLabel = false;

  const swap = await approveAndClaim<StartRefusal>({
    repoPath,
    beadId: top.beadId,
    // The plan only ever carries UNCLAIMED targets, so this is the CAS's whole cross-machine guard:
    // anyone who claimed since the pass read the board wins here and we abandon the start.
    expectedOwner: undefined,
    nextOwner: operator,
    refresh: refreshFor(repoPath),
    guard: async (locked, board) => {
      // Re-ask the pass's OWN eligibility rule under the lock, not a hand-rolled subset of it: a
      // target claimed, closed, abandoned, blocked, labelled `agent:human` or newly failing the
      // approve gate since the plan was decided must lose here rather than be started on a verdict
      // minutes old. It answers with the same machine-readable reason the plan's exclusions carry.
      const excluded = ineligibility(locked, board);
      if (excluded) {
        const why = excluded.detail ? `${excluded.reason} — ${excluded.detail}` : excluded.reason;
        return { ineligible: why };
      }
      // And the stance behind the start, re-resolved here so a withdrawal that lands between the
      // ranking and the lock costs nothing to honour: the settle re-asks it too, but only this one
      // refuses BEFORE the approval and the claim are written.
      const withdrawn = await stance(locked, board);
      if (withdrawn) return { ineligible: withdrawn };
      wroteLabel = !beads.isApproved(locked);
      return undefined;
    },
  });

  if ("vanished" in swap) {
    const reason = "the target left the board before it started";
    return { skipped: { beadId: top.beadId, reason } };
  }
  if ("refused" in swap) {
    const reason = "stale" in swap.refused ? swap.refused.stale : swap.refused.ineligible;
    return { skipped: { beadId: top.beadId, reason } };
  }
  // The claim landed and the label did not. Left alone this is the worst state the pass can produce:
  // an assignee with no approval and no run, which every later pass reads as "already claimed" and
  // never re-picks. So the claim comes straight back off, and the target is startable again next
  // cadence.
  if ("approveFailed" in swap) {
    const leftover = await unwindStart(repoPath, top.beadId, operator, {
      label: wroteLabel,
      claim: swap.swap.wrote,
    });
    publish();
    const reason = `the target could not be approved (${swap.approveFailed})`;
    return {
      skipped: {
        beadId: top.beadId,
        reason: withLeftover(reason, leftover),
        wroteBoard: leftover !== undefined,
      },
    };
  }
  // Lost the claim race. Abandoned cleanly and NOT retried: the winner holds the target, nothing was
  // written here (the label is contingent on this swap), and the next pass re-decides from a board
  // that now shows their claim.
  if (!swap.ok) {
    const holder = swap.owner ?? "another worker";
    return { skipped: { beadId: top.beadId, reason: `${holder} claimed it first` } };
  }

  // Every stand-down past the CAS is the same three moves — take the writes back, publish whatever
  // moved, and name what could not be taken back — and they all have to agree on whether the board
  // still carries this pass's writes, which is what tells the caller its saved plan reads stale
  // (PR #218 review). One closure, so that answer cannot drift between them.
  const standDown = async (reason: string): Promise<PickerApplyOutcome> => {
    const leftover = await unwindStart(repoPath, top.beadId, operator, {
      label: wroteLabel,
      claim: swap.wrote,
    });
    publish();
    return {
      skipped: {
        beadId: top.beadId,
        reason: withLeftover(reason, leftover),
        wroteBoard: leftover !== undefined,
      },
    };
  };

  // Settle the reservation across machines before the enqueue, not after: the local swap only
  // ordered this process, and a run started on a claim that loses the merge is a second machine
  // working the same target. Only a swap that actually WROTE is settled — a no-op swap took no
  // reservation of its own to prove.
  if (swap.wrote) {
    const settled = await settleClaim(repoPath, top.beadId, operator, stance, input.settle);
    if ("lost" in settled) {
      publish();
      // The label is deliberately NOT taken back above, so a lost claim still leaves this pass's
      // approval on the board when it was the one to write it.
      return { skipped: { beadId: top.beadId, reason: settled.lost, wroteBoard: wroteLabel } };
    }
    // A claim we cannot PROVE and a claim whose target stopped being startable come off the same
    // way: fail closed, like the pre-CAS refresh, so the next pass re-decides against a target that
    // is free again rather than one anton holds with no run behind it.
    const unusable =
      "unverified" in settled ? settled.unverified : "stale" in settled ? settled.stale : undefined;
    if (unusable !== undefined) return standDown(unusable);
  }

  // The last gate before the irreversible half. Everything above this line is reversible; a run is
  // not, so a cancel that landed anywhere in the refresh, the CAS or the settle window is spent HERE
  // rather than on a run teardown would have to delete out from under an approved, claimed bead.
  if (cancelled(signal)) return standDown("the pass was cancelled before its run was enqueued");

  // The idempotent enqueue, then the resume it cannot do: a run already covering this epic locally
  // withholds an id rather than spawning a second, which is what makes two overlapping passes one
  // run. No `bypassBudget` — a policy start is paced by the governor exactly as a queued one is.
  // Both verbs go through the runner in production, so a project whose teardown raised the quiesce
  // barrier throws here instead of being handed a fresh row (caught below, writes taken back).
  let jobId: string | undefined;
  try {
    jobId = enqueueIfAbsent(projectId, top.beadId);
    jobId ??= await resumeSettledRun(db, projectId, top.beadId, resume);
  } catch (e) {
    console.error(`[picker-apply] could not start a run for ${top.beadId}`, e);
    return standDown("the run could not be enqueued");
  }
  if (!jobId) {
    // Nothing of this pass's making runs. An ACTIVE job genuinely covers the target — an overlapping
    // pass, or a run already in flight — and the approval and the claim are what that run needs, so
    // they stand and only the note is skipped: no second start happened. With no active job the
    // writes cover nothing, and left standing they hide the target from every later pass (its own
    // guard reads a claimed bead as taken), so they come back off (PR #218 review).
    if (!activeExecuteEpicId(db, projectId, top.beadId)) {
      return standDown("no run could be started for this target");
    }
    publish();
    // The approval and the claim STAND here, so the caller's plan — stamped against a board where
    // this target was neither — is as stale as it would be after a start (PR #218 review).
    return {
      skipped: { beadId: top.beadId, reason: "a run already covers this target", wroteBoard: true },
    };
  }

  // The window on the FAR side of the insert (PR #218 review): a cancel that lands here is teardown
  // sweeping the project's rows, and the row it deletes may be the one this pass just wrote. So the
  // run is re-read rather than assumed — gone means the approval and the claim now cover nothing and
  // are ours to take back, exactly as when no run could be started at all. A cancel whose run
  // SURVIVED (a runner stop, a lost lease) leaves real queued work, so those writes stand.
  //
  // Asked at every seam of the audit writes below, not once before them (PR #218 review): each is
  // another await for teardown to delete the row under, and a pass that slept through one would
  // answer `started` with the approval and the claim standing over a run that no longer exists.
  const sweptAway = async (): Promise<PickerApplyOutcome | undefined> => {
    if (!cancelled(signal) || activeExecuteEpicId(db, projectId, top.beadId)) return undefined;
    return standDown("the pass was cancelled and its run removed with it");
  };

  const sweptBeforeNote = await sweptAway();
  if (sweptBeforeNote) return sweptBeforeNote;

  // The board-native record of the start, written as `policy` so bd's own history says who decided.
  // Best-effort: the run is already enqueued, and failing the pass over the audit line would leave a
  // started target reported as unstarted — the one lie the note exists to prevent.
  await beads
    .note(repoPath, top.beadId, pickerStartNote(top, entries.length), POLICY_ACTOR)
    .catch((e) => console.error(`[picker-apply] could not note the start of ${top.beadId}`, e));

  const sweptDuringNote = await sweptAway();
  if (sweptDuringNote) return sweptDuringNote;

  // The operator-facing half of the same record (anton-vfvg): the note answers a reader already
  // looking at the bead, this answers one who does not yet know anything happened. Best-effort for
  // the same reason as the note — the run exists either way, and losing the log entry must not be
  // reported as a failed start.
  await recordPickerStart(db, clock, {
    projectId,
    beadId: top.beadId,
    rank: top.rank,
    ranked: entries.length,
    rule: top.rule,
    jobId,
  }).catch((e) => console.error(`[picker-apply] could not log the start of ${top.beadId}`, e));

  const sweptDuringLog = await sweptAway();
  if (sweptDuringLog) return sweptDuringLog;

  // Publish the approval and the claim, exactly as the approve route does after its own write.
  publish();

  return {
    started: { beadId: top.beadId, rank: top.rank, rule: top.rule, jobId },
    // The caller's own post-start awaits are one more window for the same sweep (PR #218 review):
    // it restamps its plan over a fresh board read after this returns, and teardown landing in
    // there deletes the run this just enqueued. So the seam check is handed back rather than ending
    // at this return. See {@link ConfirmStart}.
    confirmStart: sweptAway,
  };
}
