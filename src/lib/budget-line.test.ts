/**
 * Budget-line placement (anton-vlom / R3.6). What these pin is the one property the lane cannot
 * check for itself: the line is drawn only where the governor's own numbers justify it, and is
 * OMITTED — never guessed, never approximated to zero — everywhere else.
 */
import { describe, expect, it } from "vitest";

import {
  budgetLine,
  RUN_JOB_TYPE,
  type BudgetSignal,
  type BurnCost,
} from "./budget-line";
import type { BudgetHeadroom } from "./jobs/budget";

function headroom(over: Partial<BudgetHeadroom> = {}): BudgetHeadroom {
  return {
    sessionPct: 50,
    sessionReason: "session-headroom",
    weeklyPct: null,
    weeklyReason: "weekly-cap",
    ...over,
  };
}

function signal(over: Partial<BudgetHeadroom> = {}, cost: Partial<BurnCost> = {}): BudgetSignal {
  return {
    headroom: headroom(over),
    burn: { [RUN_JOB_TYPE]: { sessionPct: 20, weeklyPct: 3, seeded: false, ...cost } },
  };
}

/** `n` ranked run targets — the lane's queue, every card an `execute-epic`. */
const queue = (n: number) => Array.from({ length: n }, () => ({}));

describe("budgetLine", () => {
  it("places the line where the session headroom runs out", () => {
    // 50% headroom at 20% a run: two fit outright and the third crosses — the governor starts it
    // anyway, so the line falls after it.
    expect(budgetLine(signal(), queue(5))).toEqual({
      affordable: 3,
      reason: "session-headroom",
      seeded: false,
    });
  });

  it("counts the run that crosses the threshold — the governor admits it", () => {
    // budgetGate reads the meter BEFORE a run starts and reserves nothing, so a run whose average
    // is larger than what is left still gets started; only the one after it is held. A line drawn
    // above it would mark work as waiting that anton is about to run.
    expect(budgetLine(signal({ sessionPct: 5 }), queue(3))).toEqual({
      affordable: 1,
      reason: "session-headroom",
      seeded: false,
    });
  });

  it("names the daytime reserve when that is the session-side hold", () => {
    const line = budgetLine(signal({ sessionPct: 10, sessionReason: "daytime-reserve" }), queue(3));
    expect(line).toEqual({ affordable: 1, reason: "daytime-reserve", seeded: false });
  });

  it("places the line on the weekly side when the weekly budget binds first", () => {
    // Session affords five runs; the weekly allowance (4 points, 3 a run) affords two.
    const line = budgetLine(signal({ sessionPct: 100, weeklyPct: 4 }), queue(5));
    expect(line).toEqual({ affordable: 2, reason: "weekly-cap", seeded: false });
  });

  it("names the pace-line when the weekly hold is the throttle band", () => {
    const line = budgetLine(
      signal({ sessionPct: 100, weeklyPct: 0, weeklyReason: "weekly-on-track" }),
      queue(2),
    );
    expect(line).toEqual({ affordable: 0, reason: "weekly-on-track", seeded: false });
  });

  it("reports the session floor when both sides run out on the same card", () => {
    // The gate's own precedence: the hard session floor is checked before the weekly holds.
    const line = budgetLine(signal({ sessionPct: 10, weeklyPct: 1 }), queue(2));
    expect(line?.reason).toBe("session-headroom");
  });

  it("yields to the weekly hold when the session side is only the daytime reserve", () => {
    // budgetGate tests the reserve AFTER weekly cap/pacing, so a card over both is held by the
    // weekly side. Naming the reserve would promise the wait ends tonight when it runs to the
    // weekly catch-up or reset.
    const line = budgetLine(
      signal({ sessionPct: 10, sessionReason: "daytime-reserve", weeklyPct: 1 }),
      queue(2),
    );
    expect(line).toEqual({ affordable: 1, reason: "weekly-cap", seeded: false });
  });

  it("puts the line above the whole queue when nothing is affordable now", () => {
    expect(budgetLine(signal({ sessionPct: 0 }), queue(3))).toEqual({
      affordable: 0,
      reason: "session-headroom",
      seeded: false,
    });
  });

  it("carries the seeded flag so the line can be worded as an estimate", () => {
    expect(budgetLine(signal({}, { seeded: true }), queue(5))?.seeded).toBe(true);
  });

  describe("omission — the governor fails open and so does the line", () => {
    it("draws nothing when usage is unreadable (no signal at all)", () => {
      expect(budgetLine(null, queue(5))).toBeNull();
    });

    it("draws nothing when the whole queue is affordable", () => {
      expect(budgetLine(signal({ sessionPct: 100, weeklyPct: 100 }), queue(3))).toBeNull();
    });

    it("draws nothing on an empty queue", () => {
      expect(budgetLine(signal(), [])).toBeNull();
    });

    it("draws nothing when a queued type has no recorded burn average", () => {
      // A cost we would have to invent is a line we cannot justify.
      expect(budgetLine(signal({ sessionPct: 0 }), [{ jobType: "some-future-type" }])).toBeNull();
    });

    it("draws nothing when the weekly side is unknown and the session side affords everything", () => {
      // A null weeklyPct is "no weekly signal", not "no weekly budget" — it must never place a line.
      expect(budgetLine(signal({ sessionPct: 100, weeklyPct: null }), queue(4))).toBeNull();
    });

    it("draws nothing for a queue that costs nothing", () => {
      // Nothing charged can never exhaust a live budget, so there is no arithmetic to draw a line
      // from. (An exhausted meter is the separate case above: there the governor holds regardless
      // of what the queue costs.)
      const free = signal({ sessionPct: 50, weeklyPct: 10 }, { sessionPct: 0, weeklyPct: 0 });
      expect(budgetLine(free, queue(3))).toBeNull();
    });
  });

  it("charges each card its own type's average", () => {
    const mixed: BudgetSignal = {
      headroom: headroom({ sessionPct: 25 }),
      burn: {
        [RUN_JOB_TYPE]: { sessionPct: 20, weeklyPct: 1, seeded: false },
        "nightly-stringer": { sessionPct: 2, weeklyPct: 0.3, seeded: true },
      },
    };
    // 2 + 2 + 20 = 24 still fits under 25, so the second run target is the one that crosses — and
    // the governor starts it, which leaves the third waiting.
    const entries = [
      { jobType: "nightly-stringer" },
      { jobType: "nightly-stringer" },
      {},
      {},
      {},
    ];
    expect(budgetLine(mixed, entries)).toEqual({
      affordable: 4,
      reason: "session-headroom",
      seeded: true,
    });
  });
});
