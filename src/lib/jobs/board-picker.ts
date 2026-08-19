/**
 * board-picker job (anton-albm). The scheduled pass that reads the board and starts the next run
 * target on its own — the one automation that WRITES `approved` rather than acting on an approval a
 * human already gave. It is mechanical by design: a board read, the PRIME ranking, and the existing
 * idempotent enqueue path, with no Claude session on the tick (docs/plans/2026-08-18-002-feat-
 * autopilot-design.md — "an LLM cannot be a hash function").
 *
 * STUB. The decision module — eligibility → rank → start — lands in the next ticket; until then the
 * pass resolves without touching the board, and takes no deps because it uses none yet. Registering
 * it now is what makes the automation real to the operator: the schedule row is seeded (disabled, so
 * arming it stays a deliberate act) and a job type with NO handler parks as `not-wired` the moment
 * anyone turns it on. A no-op that completes is the honest shape for "armed, nothing to do yet":
 * listing is a view of the board and never a queue of events, so a slot that does nothing costs
 * nothing and loses nothing.
 */
import type { JobHandler } from "./runner";

/** What the scheduler enqueues for this type — the shape every scheduled job carries. */
export interface BoardPickerPayload {
  projectId: string;
  scheduleId?: string;
}

/** Build the runner handler. Register it as the "board-picker" handler. */
export function makeBoardPickerHandler(): JobHandler {
  return async function boardPicker(): Promise<void> {};
}
