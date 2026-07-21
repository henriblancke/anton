/**
 * Budget governor + pace-line tests (anton-7tcc). Pure, injected-clock — no timers. Exercises the
 * cases the ticket calls out: fresh week, reset boundary, front-loaded burst, day vs night window,
 * behind- vs ahead-of-pace, session-guard trip, and null-usage fail-open.
 */
import { describe, expect, it } from "vitest";
import type { ClaudeUsage } from "../claude/usage";
import { budgetGate, DEFAULT_BUDGET_POLICY, type BudgetPolicy } from "./budget";

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

/** UTC noon and 02:00 on a fixed day — offset 0 makes these hour 12 (day) and hour 2 (night). */
const NOON = Date.parse("2026-07-16T12:00:00Z");
const NIGHT = Date.parse("2026-07-16T02:00:00Z");

const POLICY: BudgetPolicy = { ...DEFAULT_BUDGET_POLICY };

/** Weekly reset that places `now` at the given elapsed fraction of the week. */
function resetForElapsed(nowMs: number, elapsed: number): string {
  return new Date(nowMs + (1 - elapsed) * WEEK_MS).toISOString();
}

function makeUsage(o: Partial<ClaudeUsage> = {}): ClaudeUsage {
  return {
    sessionPct: 0,
    weeklyPct: 0,
    sessionResetAt: "2026-07-16T15:00:00Z",
    weeklyResetAt: resetForElapsed(NOON, 0.5),
    plan: "max",
    ...o,
  };
}

describe("budgetGate", () => {
  describe("null-usage fail-open", () => {
    it("admits when usage is null (broken read never halts anton)", () => {
      expect(budgetGate(null, POLICY, NOON)).toEqual({ admit: true });
    });
  });

  describe("session guard", () => {
    it("defers to the session reset once sessionPct crosses the floor", () => {
      const usage = makeUsage({ sessionPct: 96, sessionResetAt: "2026-07-16T15:00:00Z" });
      const d = budgetGate(usage, POLICY, NOON);
      expect(d.admit).toBe(false);
      if (d.admit) return;
      expect(d.reason).toBe("session-headroom");
      expect(d.retryAt.toISOString()).toBe("2026-07-16T15:00:00.000Z");
    });

    it("trips exactly at 100 - minSessionHeadroomPct and not a hair below", () => {
      expect(budgetGate(makeUsage({ sessionPct: 95 }), POLICY, NIGHT).admit).toBe(false);
      expect(budgetGate(makeUsage({ sessionPct: 94 }), POLICY, NIGHT).admit).toBe(true);
    });

    it("falls back to a session-window horizon when the reset time is unknown", () => {
      const usage = makeUsage({ sessionPct: 99, sessionResetAt: null });
      const d = budgetGate(usage, POLICY, NOON);
      if (d.admit) throw new Error("expected defer");
      expect(d.reason).toBe("session-headroom");
      expect(d.retryAt.getTime()).toBe(NOON + POLICY.sessionWindowMs);
    });

    it("outranks the daytime reserve and the pace-line", () => {
      // Day, session-exhausted, and ahead of pace all at once — the hard floor still wins.
      const usage = makeUsage({
        sessionPct: 98,
        weeklyPct: 80,
        weeklyResetAt: resetForElapsed(NOON, 0.5),
      });
      const d = budgetGate(usage, POLICY, NOON);
      if (d.admit) throw new Error("expected defer");
      expect(d.reason).toBe("session-headroom");
    });
  });

  describe("fresh week", () => {
    it("admits at the start of the week with low usage (night)", () => {
      const usage = makeUsage({
        sessionPct: 10,
        weeklyPct: 0,
        weeklyResetAt: resetForElapsed(NIGHT, 0.01),
      });
      expect(budgetGate(usage, POLICY, NIGHT)).toEqual({ admit: true });
    });

    it("admits during the day when the session is well below the reserve", () => {
      const usage = makeUsage({
        sessionPct: 20,
        weeklyPct: 1,
        weeklyResetAt: resetForElapsed(NOON, 0.01),
      });
      expect(budgetGate(usage, POLICY, NOON)).toEqual({ admit: true });
    });
  });

  describe("day vs night window (on-pace, session low-ish)", () => {
    // On pace (weeklyPct == expected), session past the daytime reserve but below the hard floor.
    const onPace = makeUsage({
      sessionPct: 70,
      weeklyPct: 50,
      weeklyResetAt: resetForElapsed(NOON, 0.5),
    });

    it("defers to tonight during the day", () => {
      const d = budgetGate(onPace, POLICY, NOON);
      if (d.admit) throw new Error("expected defer");
      expect(d.reason).toBe("daytime-reserve");
      expect(d.retryAt.toISOString()).toBe("2026-07-16T22:00:00.000Z");
    });

    it("admits the same usage at night", () => {
      const usage = makeUsage({
        sessionPct: 70,
        weeklyPct: 50,
        weeklyResetAt: resetForElapsed(NIGHT, 0.5),
      });
      expect(budgetGate(usage, POLICY, NIGHT)).toEqual({ admit: true });
    });

    it("holds the daytime reserve exactly at the reserve threshold", () => {
      const usage = makeUsage({
        sessionPct: 60, // == 100 - daytimeReservePct
        weeklyPct: 50,
        weeklyResetAt: resetForElapsed(NOON, 0.5),
      });
      const d = budgetGate(usage, POLICY, NOON);
      if (d.admit) throw new Error("expected defer");
      expect(d.reason).toBe("daytime-reserve");
    });
  });

  describe("behind pace vs ahead of pace", () => {
    it("spills into the day when behind pace (overrides the daytime reserve)", () => {
      const usage = makeUsage({
        sessionPct: 70, // would trip the daytime reserve...
        weeklyPct: 30, // ...but expected is 50, so we're behind → work anyway
        weeklyResetAt: resetForElapsed(NOON, 0.5),
      });
      expect(budgetGate(usage, POLICY, NOON)).toEqual({ admit: true });
    });

    it("defers weekly-on-track when ahead of pace, day or night", () => {
      const reset = resetForElapsed(NIGHT, 0.5);
      const usage = makeUsage({ sessionPct: 10, weeklyPct: 80, weeklyResetAt: reset });
      const d = budgetGate(usage, POLICY, NIGHT);
      if (d.admit) throw new Error("expected defer");
      expect(d.reason).toBe("weekly-on-track");
      const weekStart = Date.parse(reset) - WEEK_MS;
      const expected = weekStart + ((80 - POLICY.paceSlackPct) / POLICY.weeklyTargetPct) * WEEK_MS;
      expect(d.retryAt.getTime()).toBe(expected);
    });
  });

  describe("front-loaded burst", () => {
    it("defers weekly-on-track and retries when the pace-line catches up", () => {
      const reset = resetForElapsed(NOON, 0.1); // only 10% of the week elapsed
      const usage = makeUsage({ sessionPct: 5, weeklyPct: 40, weeklyResetAt: reset });
      const d = budgetGate(usage, POLICY, NOON);
      if (d.admit) throw new Error("expected defer");
      expect(d.reason).toBe("weekly-on-track");
      const weekStart = Date.parse(reset) - WEEK_MS;
      const expected = weekStart + ((40 - POLICY.paceSlackPct) / POLICY.weeklyTargetPct) * WEEK_MS;
      expect(d.retryAt.getTime()).toBe(expected);
    });
  });

  describe("reset boundary", () => {
    it("clamps elapsed to 1 at the reset and lets low usage spill (behind pace)", () => {
      const usage = makeUsage({
        sessionPct: 70,
        weeklyPct: 60, // expected ~100 at reset → behind → admit even during the day
        weeklyResetAt: new Date(NOON).toISOString(), // now == reset → elapsed 1
      });
      expect(budgetGate(usage, POLICY, NOON)).toEqual({ admit: true });
    });

    it("keeps clamping past the reset (remaining goes negative)", () => {
      const usage = makeUsage({
        sessionPct: 30,
        weeklyPct: 90,
        weeklyResetAt: new Date(NOON - HOUR_MS).toISOString(), // reset already passed
      });
      // expected == weeklyTargetPct (100); 90 < 95 → behind → admit.
      expect(budgetGate(usage, POLICY, NOON)).toEqual({ admit: true });
    });

    it("caps a weekly-on-track retry at the weekly reset", () => {
      // A reserve plan (target 50) the burst has already blown past — the pace-line would only meet
      // usage after the reset, so clamp the retry to the reset itself.
      const reservePolicy: BudgetPolicy = { ...POLICY, weeklyTargetPct: 50 };
      const reset = resetForElapsed(NIGHT, 0.9);
      const usage = makeUsage({ sessionPct: 5, weeklyPct: 99, weeklyResetAt: reset });
      const d = budgetGate(usage, reservePolicy, NIGHT);
      if (d.admit) throw new Error("expected defer");
      expect(d.reason).toBe("weekly-on-track");
      expect(d.retryAt.getTime()).toBe(Date.parse(reset));
    });
  });

  describe("missing weekly reset", () => {
    it("runs without pace — daytime reserve still holds, no ahead-of-pace defer", () => {
      const day = makeUsage({ sessionPct: 70, weeklyPct: 90, weeklyResetAt: null });
      const d = budgetGate(day, POLICY, NOON);
      if (d.admit) throw new Error("expected defer");
      expect(d.reason).toBe("daytime-reserve");
      // Same usage at night: no pace, no daytime window → admit.
      expect(budgetGate(makeUsage({ ...day }), POLICY, NIGHT)).toEqual({ admit: true });
    });
  });
});
