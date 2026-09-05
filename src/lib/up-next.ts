/**
 * The board-picker's ranking, projected for the Up Next lane (anton-t9m4 / R3.1–R3.4).
 *
 * The lane is NOT a stage. The other four columns map to bead state; this one is a ranking over
 * Backlog, so it cannot be derived from a bead's status and must not be invented as one. This module
 * is the join that makes it renderable: the ranking supplies the order and the ids, the board
 * snapshot supplies each target's type, priority, age and unblocking count.
 *
 * `unblocks` is resolved HERE rather than on the client because it is a transitive walk over the
 * whole `blocks` graph (`beads/rank.ts`) — the same count the ranking itself sorted on, so the lane
 * can never explain a position with a number the ranking did not use.
 *
 * Pure and spawn-free, like `board-provenance.ts` beside it: a snapshot and a ranking in, the lane's
 * data out.
 */
import { unblockCounter } from "./beads/rank";
import type { Bead } from "./beads/types";
import type { PickerPlanEntry } from "./board-picker-plan";
import type { Policy } from "./policy/types";
import { issueTypeOf } from "./ticket-view";
import type { UpNextAbsence, UpNextEntry } from "./types";

/**
 * A ranking the lane can draw. Structural on purpose: the live decision the board read derives
 * (`decideBoardPickerPlan`) and a plan row recorded by a pass are the same shape here, so the lane
 * never has to know which of them it was handed — nor whether the one it holds has a generation.
 */
export interface UpNextRanking {
  entries: readonly PickerPlanEntry[];
}

/**
 * The two halves of "does a pass put picks on this board?", kept apart because the lane's answer to
 * their absences differs: one is re-enabled on the automation panel, the other is a level.
 */
export interface UpNextStance {
  /** The `board-picker` schedule is enabled here. */
  scheduled: boolean;
  /** The resolved autonomy offers its picks (`shadow` or `apply`, never `propose`). */
  levelOffers: boolean;
  /**
   * The settings read succeeded, so the armed policy (or its absence) is KNOWN. False is a failed
   * read, not an unarmed project: the ranking is withheld rather than computed as if nothing were
   * armed (PR #226 review), and the level beside it is a fail-soft guess from the same read.
   */
  policyKnown: boolean;
}

/**
 * The lane's entries in rank order, or `undefined` when there is no lane to draw.
 *
 * `undefined` means there is no ranking at all — the caller withholds one when the picker is
 * disarmed or the level offers nothing — as distinct from a ranking that admitted nobody, which is
 * an EMPTY lane and a fact about the board. An entry whose bead has left the snapshot is dropped
 * rather than rendered from the ranking alone; the board is what is true now.
 *
 * Vetoes are not re-applied here: a target the operator set aside is excluded by the decision that
 * produced this ranking (`decideBoardPickerPlan`, step 2), so subtracting them again would be a
 * second answer to a question already answered — and the one that could disagree with the plan.
 */
export function upNextEntries(
  board: Bead[],
  ranking: UpNextRanking | undefined,
): UpNextEntry[] | undefined {
  if (!ranking) return undefined;
  const byId = new Map(board.map((bead) => [bead.id, bead]));
  const unblocks = unblockCounter(board);

  return [...ranking.entries]
    .sort((a, b) => a.rank - b.rank)
    .flatMap((entry) => {
      const bead = byId.get(entry.beadId);
      if (!bead) return [];
      return [
        {
          beadId: entry.beadId,
          rank: entry.rank,
          ...(bead.priority === undefined ? {} : { priority: bead.priority }),
          type: issueTypeOf(bead),
          unblocks: unblocks(entry.beadId),
          createdAt: bead.created_at ?? "",
        } satisfies UpNextEntry,
      ];
    });
}

/**
 * WHICH absence the lane is showing, when {@link upNextEntries} yields no lane to draw (anton-w579).
 *
 * Only the absences an operator can clear are named, and they are asked in the order the stance
 * resolves them: a disarmed pass is why there is no ranking even when the level would offer one.
 * `undefined` is the silence left for a ranking withheld by neither — nothing the operator would act
 * on, so naming it would tell them to do something about a wait. Since the lane is DERIVED
 * (anton-r0ew) an armed, offering project reaches it in one case only: the derivation itself threw
 * and the board read degraded rather than falling over (PR #226 review). That is a server bug, in
 * the server log — not a wait, and not something the operator clears.
 */
export function upNextAbsence(
  stance: UpNextStance,
  entries: UpNextEntry[] | undefined,
): UpNextAbsence | undefined {
  if (!stance.scheduled) return "disarmed";
  // Ahead of the level, which comes from the very read that failed: a fail-soft "it offers" must not
  // be reported as the reason when what is actually true is that anton could not read the settings.
  if (!stance.policyKnown) return "policy-unreadable";
  if (!stance.levelOffers) return "proposes-only";
  // An entry list that came back EMPTY is a pass that ran and found nothing it may start — distinct
  // from `undefined`, which is a ranking withheld rather than a board with nothing on it.
  return entries?.length === 0 ? "no-claimable-work" : undefined;
}

/**
 * The lane's half of the board's freshness token, so a poll sees the lane appear and disappear
 * instead of 304ing on a version that never moved.
 *
 * The STANCE and the CLOCK. The ranking's other inputs already ride in the token — the beads through
 * the snapshot version, the armed policy through `provenanceVersion`, the vetoes through
 * `deferralVersion` — and the stance is the one change that moves the lane while touching none of
 * them. Both of its halves ride separately because they name DIFFERENT absences — collapsing them to
 * on/off would 304 an operator who disarmed a `propose` project back onto the header that names the
 * level.
 *
 * The clock is the other (PR #226 review), and only where it can change the answer: a policy stating
 * `minAgeDays`/`maxAgeDays` admits on whole days elapsed since a bead was filed, so a bead crosses
 * into or out of the derived ranking while every bead, setting, plan row and hold sits still. A
 * token blind to it would 304 the operator onto a lane — or onto the `no-claimable-work` that
 * replaces it — that the next read would have changed.
 */
export function upNextVersion(
  stance: UpNextStance,
  policy: Policy | undefined,
  nowMs: number,
): string {
  if (!stance.scheduled) return "up:off:disarmed";
  // A recovered settings read brings the lane back, and it must not 304 on the way: the withheld
  // ranking and the one drawn from the same armed policy are otherwise the same token.
  if (!stance.policyKnown) return "up:off:unreadable";
  if (!stance.levelOffers) return "up:off:proposes";
  return `up:on:${ageFence(policy, nowMs)}`;
}

/**
 * How coarsely {@link ageFence} quantizes the clock — the longest a bead that has just crossed a
 * whole-day boundary can stay out of a lane that claims to be derived live.
 *
 * Quantized rather than exact because the token is a 304 fence: carrying the raw clock would move it
 * on every poll and no board would ever 304 again, while the exact transition instants are per-bead
 * (`created_at + n days`) and reading them here would drag the whole bead snapshot onto the poll
 * path, which derives nothing today. Five minutes against a criterion stated in DAYS is inside the
 * rounding of its own unit, and costs one rebuild in ten polls (BOARD_POLL_MS) on an age-armed
 * project — and none at all on any other, which is what {@link ageFence}'s constant is for.
 */
export const UP_NEXT_AGE_FENCE_MS = 300_000;

/** Moves with the clock only for a policy that actually asserts an age bound — see the constant. */
function ageFence(policy: Policy | undefined, nowMs: number): string {
  const soaks = policy?.minAgeDays !== undefined || policy?.maxAgeDays !== undefined;
  return soaks ? `age:${Math.floor(nowMs / UP_NEXT_AGE_FENCE_MS)}` : "age:static";
}
