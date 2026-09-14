/**
 * The WIP hold's arithmetic (anton-wy9y / R4.2) — the flow brake, and the only one that clears
 * itself.
 *
 * anton opens PRs far faster than one person reviews them, so the failure mode autopilot is most
 * likely to reach is not bad code: it is a founder with fourteen unmerged PRs who stops reading any
 * of them. This counts the PRs already waiting on the operator and stops STARTING new work once
 * that queue is full. Nothing in flight is touched — a run mid-ticket keeps going, and review-fix
 * keeps working the very PRs that caused the hold.
 *
 * It is a HOLD, never a disarm (see autopilot-breaker.ts): nothing broke, nobody is being asked for
 * anything, and the next merge releases it with no human act at all. Which is why nothing here
 * persists — the count is a function of live board/PR state, so a stored one could only ever be a
 * staler second answer, and a stale hold is a stopped autopilot nobody can explain.
 *
 * Pure and structural, like the two disarm detectors it sits beside. The caller reads the board and
 * confirms each PR's state, so the rules stay testable without a db, a repo or a `gh` call.
 */
import type { AutopilotHold } from "./autopilot-breaker";

/** One unmerged PR occupying the operator's review queue. */
export interface ReviewSlot {
  /** The run target the PR is on — what carries `stage:in-review` and the PR ref. */
  beadId: string;
  prNumber: number;
}

/** The operator's review bandwidth, counted in unmerged PRs. */
export interface WipLimitConfig {
  /**
   * Starting stops at this many PRs in review. `0` turns the hold off outright — the single knob
   * for an operator who reviews faster than anton ships.
   */
  limit: number;
}

/** A limit being respected: the queue that reached it, and what it was measured against. */
export interface WipHold {
  limit: number;
  /** The PRs holding the queue, by PR number ascending — a stable order for the detail line. */
  slots: ReviewSlot[];
  /**
   * Were there candidates the caller stopped short of confirming? A hold is a hold at the limit, so
   * the confirmation stops there (see `picker-wip-hold.ts`) — which makes `slots` a LOWER BOUND on
   * the queue, and the copy has to say so rather than name a count it did not finish counting.
   */
  truncated?: boolean;
}

/**
 * The hold, or `undefined` when there is still bandwidth. `>=` rather than `>`: the limit is the
 * number of PRs the operator is willing to have waiting, so the Nth start is the one that would
 * exceed it.
 */
export function detectWipHold(
  slots: readonly ReviewSlot[],
  config: WipLimitConfig | undefined,
  truncated = false,
): WipHold | undefined {
  if (!config || config.limit <= 0) return undefined;
  if (slots.length < config.limit) return undefined;
  return {
    limit: config.limit,
    slots: [...slots].sort((a, b) => a.prNumber - b.prNumber),
    ...(truncated ? { truncated: true } : {}),
  };
}

/**
 * The limit and where the project stands against it, in one sentence — the hold's `detail`.
 *
 * Phrased as a standing rule the project has ("pauses new work at 3"), never as a fault, and it
 * still reads correctly when the queue is OVER the limit: a merge gate that resolves slower than
 * runs finish can leave more PRs open than the limit, and "4 of 3" would read as a bug in anton
 * rather than as the count it is.
 *
 * A truncated count reads as "at least 4", because the operator with a fourteen-PR backlog is
 * exactly the one this brake exists for — telling them four PRs are waiting, off a sample that
 * stopped at four, would misdescribe their own queue back to them.
 */
export function describeWipHold(hold: WipHold): string {
  const n = hold.slots.length;
  const prs = hold.slots.map((slot) => `#${slot.prNumber}`).join(", ");
  const count = hold.truncated ? `at least ${n}` : `${n}`;
  return `${count} open PR${n === 1 ? " is" : "s are"} waiting on review — this project pauses new work at ${hold.limit} (${prs})`;
}

/** The hold as every surface reads it (`autopilot-breaker.ts` owns the rest of the copy). */
export function toAutopilotHold(hold: WipHold): AutopilotHold {
  return { kind: "hold", reason: "wip-limit", detail: describeWipHold(hold) };
}
