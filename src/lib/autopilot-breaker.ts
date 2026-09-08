/**
 * What a STOPPED autopilot is, and what would start it again (anton-5c8h / R4.1, R4.5).
 *
 * Three kinds, and conflating them is the whole UX risk of the brakes:
 *
 *   • **hold** — a limit being respected. Self-clearing, nothing wrong, no human needed. The WIP
 *     hold is one: anton stops STARTING work while the operator's review queue is full, and the
 *     next merge releases it on its own.
 *   • **disarm** — a quality signal tripped. The policy is frozen until a human reads the evidence
 *     and re-arms it; no pass ever lifts one.
 *   • **stale** — anton is running behind its own latest code (anton-mh3c): a fix merged after the
 *     last pull, or a lockfile bump nobody reinstalled, so it refuses to START new work rather than
 *     ship stale code. Machine-wide, not per-project. Clears when the operator updates and restarts
 *     anton — a terminal act, not a re-arm — so it carries evidence but no board buttons.
 *
 * A hold drawn like a failure is worse than no brake at all: an operator who is trained to see red
 * for "anton is pacing itself" stops reading the band, and the next real disarm — the one that means
 * the work is getting worse — reads as more of the same noise. So the copy lives HERE, in one pure
 * module both the lane header and any later surface read, rather than being phrased per-surface.
 *
 * Pure by construction — no db, no clock, no `bd`. The disarm's persistence is
 * `autopilot-disarm.ts`; a hold is never persisted (see the table's own note for why); the stale
 * verdict is computed live from `jobs/self-freshness.ts` and never persisted either.
 */
import type { SelfFreshness } from "./jobs/self-freshness";

/** Why anton is holding. Self-clearing, every one of them — that is what makes it a hold. */
export type HoldReason = "wip-limit";

/** Why anton is disarmed. Each freezes the policy until a human re-arms it. */
export type DisarmReason = "score-regression" | "consecutive-failures";

/**
 * Why anton is stale. One reason — the halves (checkout behind, dependencies drifted, or a running
 * build the disk has moved past) can each or all be true, but the remedy is the same shape (update
 * and restart), so the specifics live in the detail and evidence rather than fracturing the kind.
 */
export type StaleReason = "behind-own-code";

export type BreakerReason = HoldReason | DisarmReason | StaleReason;

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

/**
 * A stopped autopilot because anton is behind its own latest code, and the terminal act that clears
 * it (anton-mh3c). Draws in the disarm's failure register — it needs a human — but offers no buttons:
 * there is nothing to re-arm and nothing to investigate on a page, only a command to run.
 */
export interface AutopilotStale {
  kind: "stale";
  reason: StaleReason;
  /** Which halves are behind — the checkout, the installed packages, or both — in one sentence. */
  detail: string;
  /**
   * One line per stale half, each naming the command that clears it (`git pull` / `bun install`).
   * The remedy lives HERE and not only in the run's park message, so the operator reads what to do
   * without opening a log (R4.5).
   */
  evidence: string[];
}

export type AutopilotBreaker = AutopilotHold | AutopilotDisarm | AutopilotStale;

export function isHold(breaker: AutopilotBreaker): breaker is AutopilotHold {
  return breaker.kind === "hold";
}

/** A disarm carries the re-arm the other two never do — the header keys its buttons off this. */
export function isDisarm(breaker: AutopilotBreaker): breaker is AutopilotDisarm {
  return breaker.kind === "disarm";
}

/** The heading — what has happened, in four words or fewer, before any detail is read. */
export const BREAKER_HEADLINE: Record<AutopilotBreaker["kind"], string> = {
  hold: "Autopilot is holding",
  disarm: "Autopilot is disarmed",
  stale: "Anton is running old code",
};

/** The kind, as the chip says it. The word the operator learns to tell the states apart by. */
export const BREAKER_KIND_LABEL: Record<AutopilotBreaker["kind"], string> = {
  hold: "hold",
  disarm: "disarm",
  stale: "stale",
};

/** Which brake tripped, named for what it is about rather than for the code that detects it. */
export const BREAKER_REASON_LABEL: Record<BreakerReason, string> = {
  "wip-limit": "Review queue is full",
  "score-regression": "Review scores fell below the floor",
  "consecutive-failures": "Runs failing one after another",
  "behind-own-code": "Behind its own latest code",
};

/**
 * The clause that completes "Releases when …" for each hold — the operator's ONE next fact, and the
 * reason a hold needs no buttons. Written as an action they already take, not as a system state:
 * "one PR merges" tells them to go do the review they were going to do anyway.
 *
 * Closing is named alongside merging because the detector releases the slot on either
 * (picker-wip-hold.ts drops MERGED *and* CLOSED). A PR closed without merging keeps its bead
 * labelled in review, so a hold that promised only merges would vanish with nothing on screen ever
 * having said why.
 */
const HOLD_RELEASED_BY: Record<HoldReason, string> = {
  "wip-limit": "one PR merges or closes",
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
  if (breaker.kind === "stale") {
    // Names the RESTART, which the per-half commands in the evidence do not: an operator who runs
    // `git pull` but never restarts anton leaves the running process exactly as behind as before.
    return "Update anton and restart it. Nothing starts new work until you do.";
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

function commits(n: number): string {
  return `${n} commit${n === 1 ? "" : "s"}`;
}

/**
 * The stale band for a self-freshness verdict, or `undefined` when anton is running its own latest
 * code — and undefined for every INDETERMINATE verdict too (a remote it could not reach, an unread
 * lockfile), exactly as `staleCheckoutRefusal` refuses to ground a start on a check that never
 * answered. So the band renders on `behind`/`drift` alone; a clean or unknowable checkout shows
 * nothing, which is the whole "nothing renders when the checkout is clean" property.
 *
 * The counterpart of the run-side `staleCheckoutRefusal` (jobs/execute-epic-freshness.ts): the same
 * two halves, phrased for a card (detail + per-half evidence with its command) rather than a park line.
 */
export function staleBreaker(freshness: SelfFreshness): AutopilotStale | undefined {
  const behind: string[] = [];
  const evidence: string[] = [];

  if (freshness.checkout.state === "behind") {
    const { behind: n, upstream } = freshness.checkout;
    behind.push(`${commits(n)} behind ${upstream}`);
    evidence.push(`Checkout is ${commits(n)} behind ${upstream} — run \`git pull\``);
  }
  if (freshness.dependencies.state === "drift") {
    const { packages } = freshness.dependencies;
    const many = packages.length !== 1;
    behind.push(`${packages.length} installed package${many ? "s" : ""} out of date`);
    evidence.push(
      `Installed package${many ? "s" : ""} no longer ${many ? "match" : "matches"} bun.lock ` +
        `(${packages.join(", ")}) — run \`bun install\``,
    );
  }
  if (freshness.build.state === "drifted") {
    // Disk can read current while the process still runs its boot-time build (anton-vzhf) — the one
    // half `git pull`/`bun install` does not fix, cleared only by the restart the card already asks for.
    behind.push("its running build is out of date");
    evidence.push("The code on disk has moved past the build anton is running — restart anton");
  }

  if (evidence.length === 0) return undefined;
  return {
    kind: "stale",
    reason: "behind-own-code",
    detail: `The running anton is behind its own latest code: ${behind.join("; ")}.`,
    evidence,
  };
}
