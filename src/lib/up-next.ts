/**
 * The board-picker's recorded plan, projected for the Up Next lane (anton-t9m4 / R3.1–R3.4).
 *
 * The lane is NOT a stage. The other four columns map to bead state; this one is a ranking this
 * machine recorded over Backlog, so it cannot be derived from a bead's status and must not be
 * invented as one. This module is the join that makes it renderable: the recorded plan supplies the
 * order and the ids, the board snapshot supplies each target's type, priority, age and unblocking
 * count.
 *
 * `unblocks` is resolved HERE rather than on the client because it is a transitive walk over the
 * whole `blocks` graph (`beads/rank.ts`) — the same count the ranking itself sorted on, so the lane
 * can never explain a position with a number the ranking did not use.
 *
 * Pure and spawn-free, like `board-provenance.ts` beside it: a snapshot and a plan in, the lane's
 * data out.
 */
import { unblockCounter } from "./beads/rank";
import type { Bead } from "./beads/types";
import type { BoardPickerPlan } from "./board-picker-plan";
import { issueTypeOf } from "./ticket-view";
import type { UpNextAbsence, UpNextEntry } from "./types";

/**
 * The two halves of "does a pass put picks on this board?", kept apart because the lane's answer to
 * their absences differs: one is re-enabled on the automation panel, the other is a level.
 */
export interface UpNextStance {
  /** The `board-picker` schedule is enabled here. */
  scheduled: boolean;
  /** The resolved autonomy offers its picks (`shadow` or `apply`, never `propose`). */
  levelOffers: boolean;
}

/**
 * The lane's entries in rank order, or `undefined` when there is no lane to draw.
 *
 * `undefined` covers three honest absences at once — no plan recorded, a picker the operator has
 * disarmed, and a plan the board has since moved past (the caller resolves those two and withholds
 * the plan) — because the lane's answer to all of them is the same: show nothing. An entry whose
 * bead has left the snapshot is dropped rather than rendered from the plan alone; the plan is
 * history, and the board is what is true now.
 *
 * `deferred` is the live half of that same rule. A veto lands between passes, so the plan the lane
 * reads still ranks the target the operator just set aside — and leaving it in Up Next would offer
 * the very start they declined, for up to a full picker cadence. The next pass excludes it as
 * `deferred` anyway; this makes the lane agree with that immediately.
 */
export function upNextEntries(
  board: Bead[],
  plan: BoardPickerPlan | undefined,
  deferred?: ReadonlyMap<string, number>,
): UpNextEntry[] | undefined {
  if (!plan) return undefined;
  const byId = new Map(board.map((bead) => [bead.id, bead]));
  const unblocks = unblockCounter(board);

  return [...plan.entries]
    .sort((a, b) => a.rank - b.rank)
    .flatMap((entry) => {
      const bead = byId.get(entry.beadId);
      if (!bead || deferred?.has(entry.beadId)) return [];
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
 * `undefined` is the one honest silence left — a plan the board has moved past, or none recorded
 * yet, which no action on this screen clears and the next pass fixes on its own. Naming that as a
 * state would tell the operator to do something about a wait.
 */
export function upNextAbsence(
  stance: UpNextStance,
  entries: UpNextEntry[] | undefined,
): UpNextAbsence | undefined {
  if (!stance.scheduled) return "disarmed";
  if (!stance.levelOffers) return "proposes-only";
  // An entry list that came back EMPTY is a pass that ran and found nothing it may start — distinct
  // from `undefined`, which is a ranking withheld rather than a board with nothing on it.
  return entries?.length === 0 ? "no-claimable-work" : undefined;
}

/**
 * The lane's half of the board's freshness token, so a poll sees the lane appear and disappear
 * instead of 304ing on a version that never moved.
 *
 * Only the STANCE: the plan's own generation already rides in the token via `provenanceVersion`, and
 * the stance is the one change that moves the lane while touching no plan row at all. Both halves
 * ride separately because they now name DIFFERENT absences — collapsing them to on/off would 304 an
 * operator who disarmed a `propose` project back onto the header that names the level.
 */
export function upNextVersion(stance: UpNextStance): string {
  if (!stance.scheduled) return "up:off:disarmed";
  return stance.levelOffers ? "up:on" : "up:off:proposes";
}
