/**
 * The CLAIM half of a start: the pre-CAS refresh, the approve-and-claim swap, the unwind that takes
 * a half-written swap back, and the cross-machine settle that turns a local `ok` into a proven
 * reservation.
 *
 * These four are one module because they are one argument. The swap's ORDER is what makes a start
 * reversible — no label without a claim, nothing written on a lost race — and the unwind is that
 * order run backwards; the refresh and the settle are the two ends that extend it across machines.
 * Splitting them would put the sequence and its compensation where they could drift apart.
 *
 * Everything here is REVERSIBLE. The irreversible half is the enqueue, in `./picker-apply-start`,
 * and every stand-down below happens before it.
 */
import { beads, CLAIM_SETTLE_MS, type SyncOutcome } from "../beads/bd";
import { approveAndClaim, unwindApproveClaim } from "../beads/approve-claim";
import { isServerMode } from "../beads/board-mode";
import { ownerOf } from "../beads/claim";
import { loadAllIssues } from "../beads/issues";
import type { Bead } from "../beads/types";
import type { PickerDisarmCheck, PickerStanceCheck } from "./picker-apply-checks";
import type { PickerApplyOutcome } from "./picker-apply-outcome";
import { ineligibility } from "./picker-targets";

/** Why the under-lock guard abandoned the start — see {@link startGuard}. */
type StartRefusal = { stale: string } | { ineligible: string };

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
 *
 * `released` splits the losses (PR #218 review): a claim a NAMED worker won carries the approval
 * with it and is none of ours to reverse, while one that came off with nobody behind it leaves this
 * pass's approval covering nothing — so only the second is unwound. A target that left the board
 * entirely is neither: there is no bead left to take a write off.
 *
 * A held claim hands back the board it settled against: it is the freshest read this pass has, and
 * the flow brake at the final gate judges the review queue off it rather than spending a second
 * `bd list` on the same instant (see `PickerHoldCheck`).
 */
type SettleVerdict =
  | { held: true; board: Bead[] }
  | { lost: string; released?: true }
  | { unverified: string }
  | { stale: string };

/**
 * The board as it reads with THIS pass's own reservation cleared — the projection every re-check
 * after the CAS is judged against (PR #218 review).
 *
 * The claim under test is the one we just took, and both the eligibility rule and the policy stance
 * are evaluated over a STARTABLE set that drops an assigned bead. Judged raw, they would refuse
 * every start on the strength of its own claim. Shared by the settle's re-validation and the final
 * gate so the two cannot answer the same question from two different projections.
 */
function asUnclaimed(board: Bead[], target: Bead): { free: Bead; board: Bead[] } {
  const free = { ...target, assignee: undefined };
  return { free, board: board.map((b) => (b.id === target.id ? free : b)) };
}

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
    // A claim that lost the merge to a NAMED holder is not ours to unwind: the `approved` label
    // merged too, and whoever holds the reservation now is the one whose decision that label belongs
    // to. Pulling it back would be worse than leaving it (PR #218 review): the winner is almost
    // always the other picker, which wrote the SAME single label, so a withdrawal here would strip
    // the approval out from under a run that has already started and leave it parked on a target it
    // legitimately won. A reservation that came off with no successor is the opposite case, and the
    // caller unwinds it — which is why the two losses are told apart in the verdict, not just in
    // their wording.
    return holder
      ? { lost: `${holder} claimed it first` }
      : { lost: "the claim did not survive the board merge", released: true };
  }

  const moved = await stillStartable(board, settled, stance, "while the claim settled");
  if (moved) return { stale: moved };
  return { held: true, board };
}

/**
 * Is the reservation still worth having on THIS board? The three questions every re-validation after
 * the CAS asks, in one place so the settle and the final gate cannot drift apart (PR #218 review) —
 * and so a caller that has just spent a long await knows exactly what re-reading the board buys it.
 * Answers with the reason the start must be abandoned, or undefined while it holds. `when` names the
 * window the caller just spent, since that is the only part a reader needs to tell them apart.
 */
export async function stillStartable(
  board: Bead[],
  target: Bead,
  stance: PickerStanceCheck,
  when: string,
): Promise<string | undefined> {
  // The approval, which the eligibility rule below deliberately never asks about: the picker is the
  // label's second WRITER, so its rule tests whether approval WOULD hold, not whether it is there
  // (picker-targets.ts). Past the CAS that is the wrong question — this pass already wrote the
  // label, and another client can withdraw it inside the window while leaving this assignee
  // untouched. Enqueueing then buys a run execute-epic only poison-parks as unapproved, so the label
  // is re-checked here, beside the rule that cannot see it.
  if (!beads.isApproved(target)) return `the approval was withdrawn ${when}`;

  // The pass's OWN eligibility rule against the board just read — the same re-validation
  // `beads.staleClaimReason` does for a worker's pickup. Another machine can close, abandon or block
  // the target, label it `agent:human`, or attach a feature child inside the window while leaving
  // this assignee untouched; the holder check cannot see any of it, and enqueueing anyway buys a run
  // execute-epic only poison-parks. Judged with the reservation cleared (see {@link asUnclaimed}) —
  // exactly the assignee leg `staleClaimReason` leaves out, and for the same reason.
  const { free, board: asFree } = asUnclaimed(board, target);
  const excluded = ineligibility(free, asFree);
  if (excluded) {
    const why = excluded.detail ? `${excluded.reason} — ${excluded.detail}` : excluded.reason;
    return `the target stopped being startable ${when} (${why})`;
  }

  // And the OPERATOR's half of the same question, which no board read can answer: the standing
  // approval this start rests on can be withdrawn inside the window as easily as the target can move
  // under it. See `pickerStance`.
  const withdrawn = await stance(free, asFree);
  return withdrawn ? `the standing approval was withdrawn ${when} (${withdrawn})` : undefined;
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
): Promise<UnwindState> {
  const leftover = await unwindApproveClaim({
    repoPath,
    beadId,
    owner,
    restoreTo: undefined,
    wroteLabel: wrote.label,
    wroteClaim: wrote.claim,
  });
  if (leftover === "approval") {
    return {
      note: `${beadId} is left approved and claimed by anton — unapprove it by hand`,
      wroteBoard: true,
    };
  }
  if (leftover === "claim") {
    return { note: `${beadId} is left claimed by anton — clear its assignee by hand`, wroteBoard: true };
  }
  // The reservation passed to another worker mid-compensation, so the approval this pass wrote is
  // that holder's now and stays put (PR #218 review). Nobody has to clear anything — but the board
  // still carries the write, so the caller's plan reads stale exactly as it does after a start.
  if (leftover === "transferred") {
    return { note: `${beadId} is claimed by another worker — its approval stands`, wroteBoard: true };
  }
  // The same take-over, caught too late to put the approval back (PR #218 review): the holder's
  // target is unapproved, so their run stands down until a person re-approves it. Nothing of this
  // pass's is left to clear — what needs a human is the label it took off somebody else.
  if (leftover === "stripped") {
    return {
      note: `${beadId} was taken over while this pass unwound and lost its approval — re-approve it by hand`,
      wroteBoard: true,
    };
  }
  return { wroteBoard: false };
}

/**
 * What an unwind left behind: the line an operator needs, and whether the board still carries this
 * pass's writes (the caller's cue that its saved plan reads stale — see `PickerSkip`).
 */
interface UnwindState {
  note?: string;
  wroteBoard: boolean;
}

/** A skip reason plus whatever {@link unwindStart} left on the board — one line, both facts. */
function withLeftover(reason: string, note: string | undefined): string {
  return note ? `${reason}; ${note}` : reason;
}

/**
 * The under-lock re-checks the swap is contingent on — the same questions the plan already asked,
 * re-asked against the board read the write is about to be made against.
 *
 * Reports through `wrote` rather than returning it because the swap's own result cannot carry it:
 * whether the label is OURS to take back is decided HERE, off the locked read, and is needed later
 * by every unwind (see {@link unwindStart}).
 */
function startGuard(
  input: Pick<ClaimTargetInput, "stance" | "disarmed">,
  wrote: { label: boolean },
): (locked: Bead, board: Bead[]) => Promise<StartRefusal | undefined> {
  return async (locked, board) => {
    // Re-ask the pass's OWN eligibility rule under the lock, not a hand-rolled subset of it: a
    // target claimed, closed, abandoned, blocked, labelled `agent:human` or newly failing the
    // approve gate since the plan was decided must lose here rather than be started on a verdict
    // minutes old. It answers with the same machine-readable reason the plan's exclusions carry.
    const excluded = ineligibility(locked, board);
    if (excluded) {
      const why = excluded.detail ? `${excluded.reason} — ${excluded.detail}` : excluded.reason;
      return { ineligible: why };
    }
    // And the stance behind the start plus the safety brake, re-resolved here so a withdrawal or
    // a freeze that lands between the ranking and the lock costs nothing to honour: the settle
    // re-asks the stance too, but only this one refuses BEFORE the approval and the claim are
    // written (see `pickerDisarmed`). Both are independent board reads, so they run together
    // rather than holding the claim lock across two round trips.
    const [withdrawn, frozen] = await Promise.all([input.stance(locked, board), input.disarmed()]);
    if (withdrawn) return { ineligible: withdrawn };
    if (frozen) return { ineligible: frozen };
    wrote.label = !beads.isApproved(locked);
    return undefined;
  };
}

/**
 * A target this pass now HOLDS — approved and claimed — plus the two ways every path past the CAS
 * can end.
 *
 * Both endings are closures rather than facts because they have to agree on one answer to "does the
 * board still carry this pass's writes", which is what tells the caller its saved plan reads stale
 * (PR #218 review). That answer is decided by what the swap wrote and nothing after it re-derives
 * it, so it is captured here once instead of being threaded through every later phase.
 */
export interface ClaimedTarget {
  /** Whether the CAS actually MOVED the assignee — a no-op swap took no reservation to settle. */
  wrote: boolean;
  /**
   * Take this pass's writes back, publish whatever moved, and name what could not be taken back.
   * Every stand-down past the CAS is those same three moves.
   */
  standDown(reason: string): Promise<PickerApplyOutcome>;
  /**
   * Leave the writes standing and publish them — the ending for a loss to a NAMED successor, whose
   * reservation the approval has become and whose run would be stranded by withdrawing it.
   */
  keepWrites(reason: string): PickerApplyOutcome;
}

export interface ClaimTargetInput {
  repoPath: string;
  beadId: string;
  /** This machine's claim identity — the assignee the CAS writes and the settle reads back. */
  operator: string;
  stance: PickerStanceCheck;
  disarmed: PickerDisarmCheck;
  /** Publish this pass's writes — called on every path that made one, not only the started one. */
  publish: () => void;
}

/**
 * Approve and claim the target as ONE operation, or answer with the skip that abandoned the start.
 *
 * The label is CONTINGENT on the CAS, so a lost race leaves the bead exactly as it found it, and a
 * half-written sequence comes straight back off rather than stranding a claimed-but-unapproved
 * target no later pass re-picks.
 */
export async function claimTarget(
  input: ClaimTargetInput,
): Promise<ClaimedTarget | PickerApplyOutcome> {
  const { repoPath, beadId, operator, publish } = input;

  // Set by the guard, off the board read the write is made against: whether the label is OURS to
  // take back if the enqueue then fails (see unwindStart).
  const wrote = { label: false };

  const swap = await approveAndClaim<StartRefusal>({
    repoPath,
    beadId,
    // The plan only ever carries UNCLAIMED targets, so this is the CAS's whole cross-machine guard:
    // anyone who claimed since the pass read the board wins here and we abandon the start.
    expectedOwner: undefined,
    nextOwner: operator,
    refresh: refreshFor(repoPath),
    guard: startGuard(input, wrote),
  });

  if ("vanished" in swap) {
    const reason = "the target left the board before it started";
    return { skipped: { beadId, reason } };
  }
  if ("refused" in swap) {
    const reason = "stale" in swap.refused ? swap.refused.stale : swap.refused.ineligible;
    return { skipped: { beadId, reason } };
  }
  // The claim write itself fell over, ambiguously — approve-claim has already re-read the assignee
  // and handed the reservation back under the lock, so what is left here is the wording. Only a
  // reservation it could NOT take off leaves the target claimed-but-unapproved, which no later pass
  // re-picks.
  if ("claimFailed" in swap) {
    publish();
    const reason = `the target could not be claimed (${swap.claimFailed})`;
    const leftover = swap.stranded
      ? `${beadId} is left claimed by anton — clear its assignee by hand`
      : undefined;
    return {
      skipped: { beadId, reason: withLeftover(reason, leftover), wroteBoard: swap.stranded },
    };
  }
  // The claim landed and the label did not. Left alone this is the worst state the pass can produce:
  // an assignee with no approval and no run, which every later pass reads as "already claimed" and
  // never re-picks. So the claim comes straight back off, and the target is startable again next
  // cadence.
  if ("approveFailed" in swap) {
    const left = await unwindStart(repoPath, beadId, operator, {
      label: wrote.label,
      claim: swap.swap.wrote,
    });
    publish();
    const reason = `the target could not be approved (${swap.approveFailed})`;
    return {
      skipped: { beadId, reason: withLeftover(reason, left.note), wroteBoard: left.wroteBoard },
    };
  }
  // Lost the claim race. Abandoned cleanly and NOT retried: the winner holds the target, nothing was
  // written here (the label is contingent on this swap), and the next pass re-decides from a board
  // that now shows their claim.
  if (!swap.ok) {
    const holder = swap.owner ?? "another worker";
    return { skipped: { beadId, reason: `${holder} claimed it first` } };
  }

  return {
    wrote: swap.wrote,
    standDown: async (reason) => {
      const left = await unwindStart(repoPath, beadId, operator, {
        label: wrote.label,
        claim: swap.wrote,
      });
      publish();
      return {
        skipped: { beadId, reason: withLeftover(reason, left.note), wroteBoard: left.wroteBoard },
      };
    },
    keepWrites: (reason) => {
      publish();
      return { skipped: { beadId, reason, wroteBoard: wrote.label } };
    },
  };
}

/**
 * The settle's answer to the pass: the board it settled against — the freshest read this pass has,
 * which the flow brake at the final gate judges off rather than spending a second `bd list` — or
 * undefined where a no-op swap left nothing to settle.
 */
export interface SettledClaim {
  settled: Bead[] | undefined;
}

/**
 * Settle the reservation across machines before the enqueue, not after: the local swap only ordered
 * this process, and a run started on a claim that loses the merge is a second machine working the
 * same target. Only a swap that actually WROTE is settled — a no-op swap took no reservation of its
 * own to prove. See {@link settleClaim}.
 */
export async function settleHeldClaim(
  claimed: ClaimedTarget,
  input: {
    repoPath: string;
    beadId: string;
    operator: string;
    stance: PickerStanceCheck;
    settle?: ClaimSettleDeps;
  },
): Promise<SettledClaim | PickerApplyOutcome> {
  if (!claimed.wrote) return { settled: undefined };

  const settled = await settleClaim(
    input.repoPath,
    input.beadId,
    input.operator,
    input.stance,
    input.settle,
  );
  if ("lost" in settled) {
    // Only a NAMED successor keeps this pass's approval standing (PR #218 review): the label is
    // theirs to run on, and the unwind above deliberately leaves it. A reservation that came off
    // with nobody behind it keeps nothing — an approved, unassigned target with no run is what any
    // worker starts on — so those writes come back off like every other stand-down.
    if (settled.released) return claimed.standDown(settled.lost);
    return claimed.keepWrites(settled.lost);
  }
  // A claim we cannot PROVE and a claim whose target stopped being startable come off the same
  // way: fail closed, like the pre-CAS refresh, so the next pass re-decides against a target that
  // is free again rather than one anton holds with no run behind it.
  const unusable =
    "unverified" in settled ? settled.unverified : "stale" in settled ? settled.stale : undefined;
  if (unusable !== undefined) return claimed.standDown(unusable);
  return { settled: "held" in settled ? settled.board : undefined };
}
