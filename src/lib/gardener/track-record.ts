/**
 * THE SETTLED-PROPOSAL RECORD (anton-m29g): what the founder actually decided about a kind's
 * proposals, counted off the board and handed to {@link autonomyFor} as data.
 *
 * No new store. Every verdict is already on the board and has been since the first proposal settled
 * — a declined ask is an abandoned bead still carrying its fingerprint (the same signal
 * `suppressedFingerprints` keys on), an accepted one is a plain close. What was missing is a reader:
 * the approval gate is per-proposal, so a defect visible only ACROSS eleven of them — nine declined
 * `parentless-cluster` asks that each printed their own tell — was printed, filed, and never read in
 * aggregate. This module is that read, and the floor it feeds is what makes the aggregate binding
 * rather than advisory.
 *
 * Two things it must get right, or it inverts:
 *
 *   • A FOLD IS NOT AN APPLY. `reconcileDuplicateProposals` PLAINLY closes folded duplicates,
 *     deliberately, so that folding does not poison the survivor's fingerprint. Counting those as
 *     applies would score every duplicate as a success — precision inflating exactly when a detector
 *     is at its noisiest. The fold's own close reason is the tell ({@link isFoldReason}).
 *   • AN UNATTENDED APPLY IS NOT A VERDICT. An armed kind closes its own proposals through the same
 *     `applyProposal` a founder-approved one does, so counting those would let a kind ratchet its own
 *     record to 100% the moment it was armed — the floor could never re-engage on a detector that
 *     regressed, because it would be reading anton agreeing with itself. The policy close carries its
 *     own tell ({@link isPolicyApplyReason}).
 *   • THE WINDOW ROLLS. Only the last {@link EARNED_AUTONOMY_WINDOW} settled proposals per kind
 *     count, newest first, so a rewritten detector is not judged forever by the record of the one it
 *     replaced.
 *
 * Pure over a board snapshot, like `suppressedFingerprints` and for the same reason: the caller
 * already reads the board, and a derivation that read its own would give the pass and the settings
 * page two different answers to one question.
 */
import { beads, type Bead } from "../beads/bd";
import { isPolicyApplyReason } from "./apply";
import {
  emptyTrackRecord,
  EARNED_AUTONOMY_WINDOW,
  type ProposalTrackRecord,
} from "./autonomy";
import { fingerprintLabelOf, kindOfFingerprint, type GardenerDetectionKind } from "./detections";
import { isFoldReason } from "./emit";

/** One settled proposal, reduced to the two facts the record counts. */
interface Settlement {
  applied: boolean;
  /** When it settled — what the rolling window orders by. */
  atMs: number;
}

/**
 * When this bead settled, as a sortable number. `closed_at` is the fact being asked for; the
 * fallbacks exist because bd omits it on beads closed by older versions and a settlement with no
 * stamp must still take its place in the window rather than sorting as the epoch and being dropped
 * first. A bead with no readable stamp at all sorts oldest, which is the safe direction: it can only
 * fall OUT of the window, never displace a proposal that carries one.
 */
function settledAt(bead: Bead): number {
  for (const field of ["closed_at", "updated_at", "created_at"]) {
    const value = bead[field];
    if (typeof value !== "string") continue;
    const ms = Date.parse(value);
    if (!Number.isNaN(ms)) return ms;
  }
  return 0;
}

/**
 * How this proposal settled, or undefined when it did not settle — or when nothing about it should
 * count.
 *
 * The three outcomes, in the order they have to be tested:
 *   • ABANDONED is a decline. It is the founder's recorded won't-do and the verb the decline route
 *     writes, and it is tested FIRST because an abandoned bead is also closed.
 *   • A FOLD is neither. Nobody answered it; an overlapping patrol filed the same claim twice and
 *     this is the copy that was withdrawn.
 *   • AN UNATTENDED APPLY is neither. The kind was armed, so anton wrote it and nobody was asked —
 *     a count of what the founder decided cannot include anton's own writes.
 *   • Any other plain close is an apply — the move landed, and a human said so.
 */
function settlementOf(bead: Bead): Settlement | undefined {
  if (beads.isAbandoned(bead)) return { applied: false, atMs: settledAt(bead) };
  if (bead.status !== "closed") return undefined;
  if (isFoldReason(bead.close_reason)) return undefined;
  if (isPolicyApplyReason(bead.close_reason)) return undefined;
  return { applied: true, atMs: settledAt(bead) };
}

/**
 * The board's settled-proposal record, per kind, over the rolling window.
 *
 * The kind comes off the FINGERPRINT LABEL rather than the plan metadata: the label is the one
 * record of a kind that survives a hand-edited metadata blob, and a proposal whose plan rotted was
 * still decided about (see `kindOfFingerprint`).
 */
export function proposalTrackRecord(board: Bead[]): ProposalTrackRecord {
  const settlements = new Map<GardenerDetectionKind, Settlement[]>();

  for (const bead of board) {
    const fingerprint = fingerprintLabelOf(bead);
    if (!fingerprint) continue;
    const kind = kindOfFingerprint(fingerprint);
    if (!kind) continue;
    const settlement = settlementOf(bead);
    if (!settlement) continue;
    const forKind = settlements.get(kind);
    if (forKind) forKind.push(settlement);
    else settlements.set(kind, [settlement]);
  }

  const record = emptyTrackRecord();
  for (const [kind, all] of settlements) {
    // Newest first, then take the window: the record is what this detector has done LATELY.
    const windowed = all.sort((a, b) => b.atMs - a.atMs).slice(0, EARNED_AUTONOMY_WINDOW);
    record[kind] = {
      settled: windowed.length,
      applied: windowed.filter((s) => s.applied).length,
    };
  }
  return record;
}
