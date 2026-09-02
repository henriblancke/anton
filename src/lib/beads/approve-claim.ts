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
 *   • A half-written sequence is REPORTED, not thrown. The one order that can break is a won swap
 *     followed by a refused label write, and it strands the target — so it comes back as
 *     `approveFailed` carrying the swap, which is what lets a caller undo its own claim.
 *
 * What it does NOT do is make the swap atomic across machines: the lock is keyed on `repoPath` and
 * so serializes THIS process only (see ./claim). Cross-machine the guard is the CAS itself, which on
 * an embedded board reads a possibly-stale mirror — which is what {@link ApproveClaimInput.refresh}
 * is for.
 */
import { beads, type Bead } from "./bd";
import { withClaimLock, type SwapResult } from "./claim";
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
 */
export type ApproveClaimResult<R> =
  | SwapResult
  | { refused: R }
  | { vanished: true }
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

    const swap = await cas(input.expectedOwner, input.nextOwner, locked);
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
