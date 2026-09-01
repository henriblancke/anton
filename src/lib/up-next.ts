/**
 * The board-picker's recorded plan, projected for the Up Next lane (anton-t9m4 / R3.1–R3.4).
 *
 * The lane is NOT a stage. The other four columns map to bead state; this one is a ranking this
 * machine recorded over Backlog, so it cannot be derived from a bead's status and must not be
 * invented as one. This module is the join that makes it renderable: the recorded plan supplies the
 * order and the ids, the board snapshot supplies each target's type, priority and unblocking count.
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
import type { UpNextEntry } from "./types";

/**
 * The lane's entries in rank order, or `undefined` when there is no lane to draw.
 *
 * `undefined` covers both honest absences at once — no plan recorded, and a picker the operator has
 * disarmed (the caller resolves that and withholds the plan) — because the lane's answer to both is
 * the same: show nothing. An entry whose bead has left the snapshot is dropped rather than rendered
 * from the plan alone; the plan is history, and the board is what is true now.
 */
export function upNextEntries(
  board: Bead[],
  plan: BoardPickerPlan | undefined,
): UpNextEntry[] | undefined {
  if (!plan) return undefined;
  const byId = new Map(board.map((bead) => [bead.id, bead]));
  const unblocks = unblockCounter(board);

  return [...plan.entries]
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
        } satisfies UpNextEntry,
      ];
    });
}

/**
 * The lane's half of the board's freshness token, so a poll sees the lane appear and disappear
 * instead of 304ing on a version that never moved.
 *
 * Only the ARMED bit: the plan's own generation already rides in the token via `provenanceVersion`,
 * and disarming the picker is the one change that moves the lane while touching no plan row at all.
 */
export function upNextVersion(pickerEnabled: boolean): string {
  return pickerEnabled ? "up:on" : "up:off";
}
