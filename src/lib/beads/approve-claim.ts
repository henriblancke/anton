/**
 * APPROVE + CLAIM as one operation (R1.5): settle the reservation and write `approved` under the
 * bead's claim-write lock, with the caller's own re-checks judged against a board read taken under
 * that same lock.
 *
 * Lifted verbatim out of the approve route, which is now one of its two callers — the other is the
 * board-picker's apply step, the second writer of the `approved` label. Shared rather than copied
 * because the ORDER is the correctness argument, and it is easy to get subtly wrong: the label is
 * what locks the reservation (the claim route refuses to touch an approved target), so a bare swap
 * followed by an unlocked `beads.approve` leaves a window where a concurrent steal lands on a
 * not-yet-approved target and this caller then starts a run under somebody else's reservation. A
 * human hits that window once; overlapping picker passes would hit it every ten minutes.
 *
 * Three properties every caller inherits:
 *
 *   • The label is CONTINGENT on the swap. A lost CAS writes nothing at all, so a failed claim can
 *     never leave an `approved` label behind for the next reader to act on.
 *   • The guard judges the board as of the lock. Every gate a caller ran before it took the lock
 *     answered from a read anything could have moved since; whatever must still hold at the instant
 *     of the write is re-asked here, over a raw `loadAllIssues` (never the snapshot-backed refresh,
 *     whose last-good fallback is right for a view and wrong for a gate about to write).
 *   • A half-written sequence is REPORTED, not thrown. Both writes are ambiguous on failure — bd can
 *     commit and then time out — and either one left standing strands the target. A won swap under a
 *     refused label comes back as `approveFailed` carrying the swap, which is what lets a caller undo
 *     its own claim; a swap that threw is handed back here and comes back as `claimFailed`.
 *
 * What it does NOT do is make the swap atomic across machines: the lock is keyed on `repoPath` and
 * so serializes THIS process only (see ./claim). Cross-machine the guard is the CAS itself, which on
 * an embedded board reads a possibly-stale mirror — which is what {@link ApproveClaimInput.refresh}
 * is for.
 */
import { beads, LABELS, type Bead } from "./bd";
import { ownerOf, withClaimLock, type LockedSwap, type SwapResult } from "./claim";
import { loadAllIssues } from "./issues";

/**
 * The sequence's outcome: the swap's own verdict, the caller's refusal, the bead being gone, or the
 * label write failing on top of a won swap.
 *
 * `vanished` is its own variant rather than a guard refusal because every caller has to handle it
 * and none of them can express it: the guard is only ever handed a bead that exists.
 *
 * `approveFailed` exists because a thrown label write is NOT the same failure as a lost swap, and an
 * exception cannot tell them apart. The CAS has already moved the assignee by then, so the caller is
 * holding a reservation it never approved — a target that reads as claimed to every later pass and
 * to a human, with no approval and no run behind it. Reported as a value, carrying the swap, so the
 * caller can take its own writes back (picker-apply's `unwindStart`) instead of stranding them.
 *
 * `claimFailed` is the same argument one step earlier (PR #218 review): the CAS itself is AMBIGUOUS
 * on failure — `bd assign` can commit the assignee and then throw or time out, and the post-write
 * read-back can fail on its own. Letting that reject would skip every caller's compensation and
 * leave the identical stranded target, so the assignee is re-read and handed back here (see
 * {@link releaseAmbiguousClaim}) and only what could NOT be taken back is reported, as `stranded`.
 */
export type ApproveClaimResult<R> =
  | SwapResult
  | { refused: R }
  | { vanished: true }
  | { claimFailed: string; stranded: boolean }
  | { approveFailed: string; swap: Extract<SwapResult, { ok: true }> };

export interface ApproveClaimInput<R> {
  repoPath: string;
  beadId: string;
  /** The assignee the caller decided from — the CAS loses to anyone who landed since. */
  expectedOwner: string | undefined;
  /** Who holds the reservation afterwards; `undefined` releases it. */
  nextOwner: string | undefined;
  /**
   * Run under the lock BEFORE the board read, to refresh what that read is about to judge — the
   * picker's pull-before-CAS on an embedded board, where the local mirror can otherwise trail a
   * claim another machine already published. Returning a refusal abandons the whole sequence, which
   * is what makes a failed refresh fail CLOSED rather than write against a stale mirror.
   */
  refresh?: () => Promise<R | undefined>;
  /**
   * The caller's re-checks, over the bead and the board as of the lock. A returned value refuses:
   * nothing is written and it comes back as {@link ApproveClaimResult}'s `refused`.
   */
  guard: (locked: Bead, board: Bead[]) => R | undefined | Promise<R | undefined>;
}

/**
 * Hand back a claim whose own write THREW, and answer whether anything is still standing.
 *
 * A rejected `bd assign` proves nothing about the assignee: the command can commit and then time
 * out, and the CAS's post-write read-back can fail over a write that landed. So the reservation is
 * re-read and reversed through the SAME locked CAS — inside the lock, where no other writer can slip
 * between the ambiguous write and its compensation, and conditional by construction: a swap that
 * never landed reads as `expectedOwner` and short-circuits to a no-op, and a third party who holds
 * the target now loses the CAS and keeps it.
 *
 * Stranded ONLY when the target still reads as `nextOwner` afterwards — that reservation is ours,
 * has no approval and no run behind it, and needs a human. An unreadable board fails closed to
 * stranded, as {@link unwindApproveClaim} does for the same reason.
 */
async function releaseAmbiguousClaim<R>(
  cas: LockedSwap,
  beadId: string,
  input: ApproveClaimInput<R>,
): Promise<boolean> {
  try {
    const restored = await cas(input.nextOwner, input.expectedOwner);
    return !restored.ok && restored.owner === input.nextOwner;
  } catch (e) {
    console.error(`[approve-claim] could not hand back the ambiguous claim on ${beadId}`, e);
    return true;
  }
}

/**
 * Claim `beadId` for `nextOwner` and label it `approved`, both under its claim-write lock.
 *
 * The CAS is handed the locked read rather than re-reading: the lock is precisely what makes the two
 * reads identical, so a second `bd show` would only cost a spawn.
 */
export function approveAndClaim<R>(input: ApproveClaimInput<R>): Promise<ApproveClaimResult<R>> {
  const { repoPath, beadId } = input;
  return withClaimLock(repoPath, beadId, async (cas) => {
    const unrefreshed = await input.refresh?.();
    if (unrefreshed !== undefined) return { refused: unrefreshed };

    const board = await loadAllIssues(repoPath);
    const locked = board.find((b) => b.id === beadId);
    if (!locked) return { vanished: true };

    const refused = await input.guard(locked, board);
    if (refused !== undefined) return { refused };

    let swap: SwapResult;
    try {
      swap = await cas(input.expectedOwner, input.nextOwner, locked);
    } catch (e) {
      const stranded = await releaseAmbiguousClaim(cas, beadId, input);
      return { claimFailed: e instanceof Error ? e.message : String(e), stranded };
    }
    if (!swap.ok) return swap;
    // Contingent, never speculative: the label goes on only once the reservation is provably ours.
    try {
      await beads.approve(repoPath, beadId);
    } catch (e) {
      return { approveFailed: e instanceof Error ? e.message : String(e), swap };
    }
    return swap;
  });
}

/**
 * What an unwind LEFT on the board. The caller words it: the same value names a different state
 * depending on who was holding the reservation (the picker's own claim, an approver's hand-back).
 *
 * `approval` and `claim` are writes it could not take back — both need a human; `approval` also
 * covers a write it REFUSED to take back, because an unreadable board left it unable to say the
 * reservation was still ours (PR #218 review). `transferred` is the
 * opposite (PR #218 review): the reservation passed to another NAMED worker while this request held
 * it, so the writes stopped being ours to reverse. Nobody has to clear anything, but the approval
 * this request wrote is still standing, which a caller whose plan was stamped before it has to know.
 * A claim that was released rather than handed on is not this: with no successor the approval covers
 * nothing, so it comes off like any other failed sequence.
 */
export type UnwindLeftover = "approval" | "claim" | "transferred";

export interface UnwindApproveClaimInput {
  repoPath: string;
  beadId: string;
  /** Who the CAS made the holder — the reservation this unwind takes off. */
  owner: string | undefined;
  /** Who it goes back to; `undefined` releases it outright. */
  restoreTo: string | undefined;
  /**
   * Whether the approval is OURS to take back. False when the target was ALREADY approved before
   * the caller touched it — removing it there would erase somebody else's decision.
   */
  wroteLabel: boolean;
  /** Whether the CAS actually MOVED the assignee — a no-op swap took no reservation to release. */
  wroteClaim: boolean;
}

/**
 * Take back what a failed {@link approveAndClaim} left half-written — the compensation both callers
 * owe an `approveFailed`, in the module that owns the ordering it has to reverse.
 *
 * The writes come off in the reverse order they went on: the label first, because the label is what
 * locks the reservation — releasing the claim while the approval stood would publish an approved,
 * unassigned target, the exact shape a picker pass or a worker starts on. So each leg GATES the
 * next: a label that would not come off keeps its claim, and the target waits for a person instead
 * of being handed to the run nobody decided to make.
 *
 * `bd update --add-label` is AMBIGUOUS on failure — it can commit and then throw or time out — so
 * `wroteLabel` says the label is ours to take back, not that it is there. The bead is re-read and an
 * untag is only attempted on a label that actually landed (PR #218 review): an untag refusing a
 * label nobody wrote would otherwise gate the release and strand the claimed-but-unapproved target
 * this exists to prevent.
 *
 * That same re-read decides whether the writes are still OURS at all (PR #218 review). The untag is
 * the one unconditional write here — the release is a CAS and refuses a target somebody else holds —
 * and the lock orders this process only, so on a shared-server board a competing picker can win the
 * assignee race between the ambiguous `beads.approve` and this compensation. Stripping the label
 * then erases the approval the WINNER is now running on, which stands their run down or poison-parks
 * it. So a NAMED successor ends the unwind as `transferred`: their reservation, their approval, and
 * nothing of ours left to reverse — the same call the picker's settle makes when its claim loses the
 * board merge. A reservation that came off without one is the opposite case and unwinds normally: an
 * approval standing over an unassigned target with no run behind it is what any worker starts on.
 *
 * When that read FAILS the unwind stops without writing anything and reports the approval as a
 * leftover (PR #218 review). A missing answer is not evidence the reservation is still ours: guess
 * "ours" and an untag strips the approval out from under whoever took it, standing their run down
 * over a transient `bd show`. The leftover leaves the board as the failed sequence left it — visibly
 * approved and claimed, with an operator line naming both — which is the failure a person can see
 * and undo, rather than one that lands on somebody else's run.
 *
 * The WHOLE unwind runs under the bead's claim-write lock, not just its release (PR #218 review).
 * Unlocked, the re-read, the untag and the release are three separately-ordered writes, and a retry
 * approving the same target between them lands inside the compensation: this unwind then strips the
 * retry's approval, or releases the claim the retry took while its fresh approval stands — an
 * approved, unassigned target, the exact shape this ordering exists never to publish. Holding one
 * lock across all three makes the compensation as atomic as the sequence it reverses, so the release
 * goes through the LOCKED CAS rather than `setAssigneeIfOwner`, which would wait on the lock this
 * body already holds and deadlock.
 *
 * A swap lost to a THIRD PARTY is not a failure: someone else holds the reservation now, which is a
 * safe final state and none of ours to repair. A swap lost while the target still reads as `owner`
 * is the opposite (PR #218 review) — the release did not take, so the reservation is still ours,
 * still has no run behind it, and is reported as a leftover rather than swallowed because a
 * `SwapResult` object came back at all. An unreachable board leaves the claim standing too.
 */
export async function unwindApproveClaim(
  input: UnwindApproveClaimInput,
): Promise<UnwindLeftover | undefined> {
  const { repoPath, beadId } = input;

  return withClaimLock(repoPath, beadId, async (cas) => {
    // One read, two questions: is the reservation still ours to reverse, and did the label actually
    // land. Read only when there is a label to take off — with none, the release below is a CAS that
    // asks the ownership question itself.
    if (input.wroteLabel) {
      const current = await beads.show(repoPath, beadId).catch((e) => {
        console.error(`[approve-claim] could not re-read ${beadId} before unapproving it`, e);
        return undefined;
      });
      // A board that cannot be read answers NEITHER question, and the untag below is the one
      // unconditional write here (PR #218 review) — so the unwind stops rather than guessing at
      // ownership it could not verify. Untagging on the assumption the reservation is still ours
      // erases the approval a successor's run is already executing on; the leftover reported instead
      // sends a person to a target that is visibly approved, not one silently stood down.
      if (!current) return "approval";

      // Only a REAL successor ends the compensation (PR #218 review). A reservation that was merely
      // RELEASED — a human clearing the assignee while this request was in flight — leaves nobody
      // whose decision the approval has become, and standing down on it publishes the approved,
      // unassigned target this whole ordering exists never to produce. So a cleared assignee unwinds
      // like any other failure; only a named holder keeps the label.
      const holder = ownerOf(current);
      if (holder !== undefined && holder !== input.owner) return "transferred";

      if (beads.isApproved(current)) {
        const unapproved = await beads
          .untag(repoPath, beadId, [LABELS.approved])
          .then(() => true)
          .catch((e) => {
            console.error(`[approve-claim] could not unapprove ${beadId}`, e);
            return false;
          });
        if (!unapproved) return "approval";
      }
    }

    if (input.wroteClaim) {
      const released = await cas(input.owner, input.restoreTo).catch((e) => {
        console.error(`[approve-claim] could not release the claim on ${beadId}`, e);
        return undefined;
      });
      if (!released || (!released.ok && released.owner === input.owner)) return "claim";
    }

    return undefined;
  });
}
