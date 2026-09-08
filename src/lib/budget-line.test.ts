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
    weeklyInclusive: true,
    sharePct: null,
    reserveWaiver: null,
    ...over,
  };
}

function signal(over: Partial<BudgetHeadroom> = {}, cost: Partial<BurnCost> = {}): BudgetSignal {
  return {
    headroom: headroom(over),
    burn: { [RUN_JOB_TYPE]: { sessionPct: 20, weeklyPct: 3, shareWeeklyPct: 3, seeded: false, ...cost } },
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

  it("re-applies the daytime reserve where the projected burn ends its behind-pace waiver", () => {
    // Behind pace inside the day window, the governor waives the reserve — but only while usage is
    // behind. The queue's own burn catches it up, and from there the gate defers at the reserve
    // (PR #212 review), so the waived hard floor must not be charged down the whole queue.
    const line = budgetLine(
      signal(
        {
          sessionPct: 55,
          weeklyPct: 100,
          reserveWaiver: { afterWeeklyPct: 35, sessionPct: 20 },
        },
        { sessionPct: 10, weeklyPct: 20 },
      ),
      queue(6),
    );
    // Two runs (40 weekly points) put usage back on pace; the third is held at the reserve, not four
    // cards later at the hard floor.
    expect(line).toEqual({ affordable: 2, reason: "daytime-reserve", seeded: false });
  });

  it("keeps the waived floor for a queue too small to catch the pace-line up", () => {
    // The waiver is real while it lasts: a queue that never spends its way back onto the pace-line
    // runs against the hard floor, and drawing the reserve there would bench work the governor runs.
    const line = budgetLine(
      signal(
        { sessionPct: 55, weeklyPct: 100, reserveWaiver: { afterWeeklyPct: 90, sessionPct: 20 } },
        { sessionPct: 20, weeklyPct: 5 },
      ),
      queue(5),
    );
    expect(line).toEqual({ affordable: 3, reason: "session-headroom", seeded: false });
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

  it("admits the card that lands exactly on the pace ceiling — the gate defers only past it", () => {
    // 6 weekly points at 3 a run: the second card's burn ends ON the ceiling, and budgetGate's
    // pacing test is strict (`usage > ceiling`), so the third still starts. Only the fourth waits.
    const line = budgetLine(
      signal({ sessionPct: 100, weeklyPct: 6, weeklyReason: "weekly-on-track", weeklyInclusive: false }),
      queue(4),
    );
    expect(line).toEqual({ affordable: 3, reason: "weekly-on-track", seeded: false });
  });

  it("holds the card that lands exactly on the weekly cap — that hold bites AT its threshold", () => {
    // The same arithmetic against an inclusive limit (`usage >= cap`): the second card is held.
    const line = budgetLine(signal({ sessionPct: 100, weeklyPct: 6 }), queue(4));
    expect(line).toEqual({ affordable: 2, reason: "weekly-cap", seeded: false });
  });

  // Each weekly hold is charged at the rate of the meter it reads (PR #248 review): the cap and the
  // pace-line at the account's, the share at this project's own.
  it("charges the cap at the account rate, whatever this project's own rate is", () => {
    // 10 account points at 5 a run across the fleet: two cards. The project's own 2-a-run rate would
    // promise five, against a cap the fleet's burn crosses long before.
    const line = budgetLine(
      signal({ sessionPct: 100, weeklyPct: 10 }, { weeklyPct: 5, shareWeeklyPct: 2 }),
      queue(6),
    );
    expect(line).toEqual({ affordable: 2, reason: "weekly-cap", seeded: false });
  });

  it("charges the pace-line at the account rate", () => {
    const line = budgetLine(
      signal(
        { sessionPct: 100, weeklyPct: 10, weeklyReason: "weekly-on-track", weeklyInclusive: false },
        { weeklyPct: 5, shareWeeklyPct: 2 },
      ),
      queue(6),
    );
    expect(line).toEqual({ affordable: 3, reason: "weekly-on-track", seeded: false });
  });

  it("charges the share at this project's own rate", () => {
    // The reverse case: 10 share points at 2 a run is five cards, and the fleet's 5-a-run average
    // says nothing about what THIS project's runs cost its own share. The account meter has room
    // for all of them.
    const line = budgetLine(
      signal({ sessionPct: 200, weeklyPct: 100, sharePct: 10 }, { weeklyPct: 5, shareWeeklyPct: 2 }),
      queue(8),
    );
    expect(line).toEqual({ affordable: 5, reason: "share-cap", seeded: false });
  });

  it("lets the share bind first even when the account meter has fewer raw points left", () => {
    // Which weekly hold binds is headroom over rate, not raw headroom (PR #248 review): 5 account
    // points at 0.3 a run afford sixteen cards, but 6 share points at 3 a run are gone after two.
    // Picking the account meter up front for its smaller number would call all sixteen affordable.
    const line = budgetLine(
      signal({ sessionPct: 200, weeklyPct: 5, sharePct: 6 }, { weeklyPct: 0.3, shareWeeklyPct: 3 }),
      queue(20),
    );
    expect(line).toEqual({ affordable: 2, reason: "share-cap", seeded: false });
  });

  it("lets the account cap bind first even when the share has fewer raw points left", () => {
    // The mirror: 3 share points at 0.3 a run outlast 10 account points at 5 a run.
    const line = budgetLine(
      signal({ sessionPct: 200, weeklyPct: 10, sharePct: 3 }, { weeklyPct: 5, shareWeeklyPct: 0.3 }),
      queue(20),
    );
    expect(line).toEqual({ affordable: 2, reason: "weekly-cap", seeded: false });
  });

  it("names the share when it and the pace-line run out on the same card", () => {
    // The gate tests the share before the pace-line, so a card over both waits on the share.
    const line = budgetLine(
      signal(
        { sessionPct: 200, weeklyPct: 10, weeklyReason: "weekly-on-track", sharePct: 6 },
        { weeklyPct: 5, shareWeeklyPct: 3 },
      ),
      queue(4),
    );
    expect(line).toEqual({ affordable: 2, reason: "share-cap", seeded: false });
  });

  it("names the cap when it and the share run out on the same card", () => {
    // …but the account cap comes before the share in the gate's order.
    const line = budgetLine(
      signal({ sessionPct: 200, weeklyPct: 10, sharePct: 6 }, { weeklyPct: 5, shareWeeklyPct: 3 }),
      queue(4),
    );
    expect(line).toEqual({ affordable: 2, reason: "weekly-cap", seeded: false });
  });

  it("projects the reserve waiver on the account meter even while the share binds", () => {
    // The waiver ends where ACCOUNT usage catches the pace-line up, so it is charged at the account
    // rate (20 a run: two cards) even though the tighter weekly hold is the share, charged at the
    // project's own 2 a run — the share would afford all six.
    const line = budgetLine(
      signal(
        {
          sessionPct: 55,
          weeklyPct: 100,
          sharePct: 12,
          reserveWaiver: { afterWeeklyPct: 35, sessionPct: 20 },
        },
        { sessionPct: 10, weeklyPct: 20, shareWeeklyPct: 2 },
      ),
      queue(6),
    );
    expect(line).toEqual({ affordable: 2, reason: "daytime-reserve", seeded: false });
  });

  it("yields the daytime reserve to the share when both run out on the same card", () => {
    const line = budgetLine(
      signal({ sessionPct: 10, sessionReason: "daytime-reserve", weeklyPct: 100, sharePct: 1 }),
      queue(2),
    );
    expect(line).toEqual({ affordable: 1, reason: "share-cap", seeded: false });
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
        [RUN_JOB_TYPE]: { sessionPct: 20, weeklyPct: 1, shareWeeklyPct: 1, seeded: false },
        "nightly-stringer": { sessionPct: 2, weeklyPct: 0.3, shareWeeklyPct: 0.3, seeded: true },
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
