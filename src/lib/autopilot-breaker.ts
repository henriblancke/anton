/**
 * What a STOPPED autopilot is, and what would start it again (anton-5c8h / R4.1, R4.5).
 *
 * Two kinds, and conflating them is the whole UX risk of the brakes:
 *
 *   • **hold** — a limit being respected. Self-clearing, nothing wrong, no human needed. The WIP
 *     hold is one: anton stops STARTING work while the operator's review queue is full, and the
 *     next merge releases it on its own.
 *   • **disarm** — a quality signal tripped. The policy is frozen until a human reads the evidence
 *     and re-arms it; no pass ever lifts one.
 *
 * A hold drawn like a failure is worse than no brake at all: an operator who is trained to see red
 * for "anton is pacing itself" stops reading the band, and the next real disarm — the one that means
 * the work is getting worse — reads as more of the same noise. So the copy lives HERE, in one pure
 * module both the lane header and any later surface read, rather than being phrased per-surface.
 *
 * Pure by construction — no db, no clock, no `bd`. The disarm's persistence is
 * `autopilot-disarm.ts`; a hold is never persisted (see the table's own note for why).
 */

/** Why anton is holding. Self-clearing, every one of them — that is what makes it a hold. */
export type HoldReason = "wip-limit";

/** Why anton is disarmed. Each freezes the policy until a human re-arms it. */
export type DisarmReason = "score-regression" | "consecutive-failures";

export type BreakerReason = HoldReason | DisarmReason;

/** A limit being respected. Carries no actions, because there is nothing for a human to do. */
export interface AutopilotHold {
  kind: "hold";
  reason: HoldReason;
  /** The limit and where the project stands against it, in the detector's own words. */
  detail: string;
  /** Unix seconds the hold started, when the detector knows. */
  since?: number;
}

/** A frozen policy, and the case for or against lifting it. */
export interface AutopilotDisarm {
  kind: "disarm";
  reason: DisarmReason;
  /** What tripped, in the detector's own words. */
  detail: string;
  /**
   * The score series, or the runs that failed — the operator's whole case for re-arming or not.
   * Shown in full: a disarm asks for a judgment, and a judgment needs what it was made on.
   */
  evidence: string[];
  /**
   * The escalation this disarm raised (R4.6): the same detail and evidence, in the "Needs you"
   * strip, for the operator who scans that band and never reads a lane header. Settled by the
   * re-arm, since nothing else ever would.
   */
  escalationId?: string;
  /** Unix seconds the disarm latched. */
  since?: number;
}

export type AutopilotBreaker = AutopilotHold | AutopilotDisarm;

export function isHold(breaker: AutopilotBreaker): breaker is AutopilotHold {
  return breaker.kind === "hold";
}

/** The heading — what has happened, in four words or fewer, before any detail is read. */
export const BREAKER_HEADLINE: Record<"hold" | "disarm", string> = {
  hold: "Autopilot is holding",
  disarm: "Autopilot is disarmed",
};

/** The kind, as the chip says it. The word the operator learns to tell the two states apart by. */
export const BREAKER_KIND_LABEL: Record<"hold" | "disarm", string> = {
  hold: "hold",
  disarm: "disarm",
};

/** Which brake tripped, named for what it is about rather than for the code that detects it. */
export const BREAKER_REASON_LABEL: Record<BreakerReason, string> = {
  "wip-limit": "Review queue is full",
  "score-regression": "Review scores fell below the floor",
  "consecutive-failures": "Runs failing one after another",
};

/**
 * The clause that completes "Releases when …" for each hold — the operator's ONE next fact, and the
 * reason a hold needs no buttons. Written as an action they already take, not as a system state:
 * "one PR merges" tells them to go do the review they were going to do anyway.
 */
const HOLD_RELEASED_BY: Record<HoldReason, string> = {
  "wip-limit": "one PR merges",
};

/**
 * What would start anton again — the sentence R4.5 exists for, and the one thing every stopped state
 * must be able to say without anybody opening a log.
 *
 * A hold names the event that clears it and promises it clears ITSELF. A disarm names the human act,
 * because there isn't one that isn't: no pass re-arms, and a header that implied otherwise would
 * leave an operator waiting on a machine that is waiting on them.
 */
export function clearingCondition(breaker: AutopilotBreaker): string {
  if (isHold(breaker)) {
    return `Releases itself when ${HOLD_RELEASED_BY[breaker.reason]} — nothing for you to do.`;
  }
  return "Stays off until you re-arm it. Nothing re-arms it automatically.";
}

/** The reassurance a hold gets and a disarm must never get: this is the system working. */
export const HOLD_REASSURANCE = "Nothing is wrong — anton is pacing itself.";

/**
 * What being stopped actually costs, said once for both kinds. Worth stating on the band itself:
 * "autopilot is stopped" reads as "everything is stopped" unless something says otherwise, and an
 * operator who thinks a hold froze their in-flight run will go looking for a way to force it.
 */
export const BREAKER_EFFECT =
  "Work already running is unaffected — only starting new work is stopped.";

/**
 * Where the evidence for each disarm actually lives, so `Investigate` lands on the page that can
 * settle the question rather than on a generic dashboard: the score series is the Health page's
 * review trajectory, and a run of failures is read off the run history.
 */
const DISARM_INVESTIGATE_PAGE: Record<DisarmReason, string> = {
  "score-regression": "health",
  "consecutive-failures": "runs",
};

export function investigateHref(slug: string, reason: DisarmReason): string {
  return `/projects/${slug}/${DISARM_INVESTIGATE_PAGE[reason]}`;
}
