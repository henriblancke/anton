/**
 * Budget governor + pace-line tests (anton-7tcc). Pure, injected-clock — no timers. Exercises the
 * cases the ticket calls out: fresh week, reset boundary, front-loaded burst, day vs night window,
 * behind- vs ahead-of-pace, session-guard trip, and null-usage fail-open.
 */
import { describe, expect, it } from "vitest";
import type { ClaudeUsage } from "../claude/usage";
import {
  admissibleJobs,
  admitJob,
  budgetGate,
  budgetHeadroom,
  DEFAULT_BUDGET_POLICY,
  isBehindPace,
  jobValueScore,
  type BudgetPolicy,
} from "./budget";

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

  describe("idle-fill below the throttle band (anton-ld7j)", () => {
    it("runs a front-loaded early-week burst instead of benching it (uses idle capacity)", () => {
      // 40% weekly at 10% into the week: far ahead of the even line, but well below the throttle
      // band (cap 100 − band 20 = 80). Idle-fill runs it — the whole point of the feature.
      const usage = makeUsage({ sessionPct: 5, weeklyPct: 40, weeklyResetAt: resetForElapsed(NOON, 0.1) });
      expect(budgetGate(usage, POLICY, NOON)).toEqual({ admit: true });
    });

    it("runs day or night while below the band with a fresh session", () => {
      const usage = makeUsage({ sessionPct: 20, weeklyPct: 70, weeklyResetAt: resetForElapsed(NIGHT, 0.2) });
      expect(budgetGate(usage, POLICY, NIGHT)).toEqual({ admit: true });
    });
  });

  describe("weekly ceiling + throttle band (anton-ld7j)", () => {
    it("stops at the cap until the weekly resets (weekly-cap)", () => {
      const reset = resetForElapsed(NOON, 0.5);
      const usage = makeUsage({ sessionPct: 10, weeklyPct: 100, weeklyResetAt: reset });
      const d = budgetGate(usage, POLICY, NIGHT);
      if (d.admit) throw new Error("expected defer");
      expect(d.reason).toBe("weekly-cap");
      expect(d.retryAt.getTime()).toBe(Date.parse(reset));
    });

    it("paces inside the band when ahead of the even line, retrying at catch-up", () => {
      // 90% weekly (band [80,100)) at 30% into the week → ahead of the 30% line → throttle.
      const reset = resetForElapsed(NIGHT, 0.3);
      const usage = makeUsage({ sessionPct: 10, weeklyPct: 90, weeklyResetAt: reset });
      const d = budgetGate(usage, POLICY, NIGHT);
      if (d.admit) throw new Error("expected defer");
      expect(d.reason).toBe("weekly-on-track");
      const weekStart = Date.parse(reset) - WEEK_MS;
      const expected = weekStart + ((90 - POLICY.paceSlackPct) / POLICY.weeklyTargetPct) * WEEK_MS;
      expect(d.retryAt.getTime()).toBe(expected);
    });

    it("runs inside the band when on/behind the even line (not ahead)", () => {
      // 85% weekly at 90% into the week: the even line sits at 90 > 85, so we're behind → run.
      const usage = makeUsage({ sessionPct: 10, weeklyPct: 85, weeklyResetAt: resetForElapsed(NIGHT, 0.9) });
      expect(budgetGate(usage, POLICY, NIGHT)).toEqual({ admit: true });
    });
  });

  describe("skipPacing (run-directly / immediate approval, anton-d8i4)", () => {
    it("bypasses a weekly-on-track hold when ahead of pace", () => {
      const usage = makeUsage({
        sessionPct: 10,
        weeklyPct: 80, // ahead of the pace-line → would defer weekly-on-track…
        weeklyResetAt: resetForElapsed(NIGHT, 0.5),
      });
      expect(budgetGate(usage, POLICY, NIGHT)).not.toEqual({ admit: true }); // paced: defers
      expect(budgetGate(usage, POLICY, NIGHT, { skipPacing: true })).toEqual({ admit: true });
    });

    it("bypasses the daytime reserve", () => {
      const usage = makeUsage({
        sessionPct: 70, // past the daytime reserve during the day → would defer daytime-reserve…
        weeklyPct: 50,
        weeklyResetAt: resetForElapsed(NOON, 0.5),
      });
      expect(budgetGate(usage, POLICY, NOON)).not.toEqual({ admit: true });
      expect(budgetGate(usage, POLICY, NOON, { skipPacing: true })).toEqual({ admit: true });
    });

    it("still honors the session-headroom floor (the one hold it does NOT bypass)", () => {
      const usage = makeUsage({ sessionPct: 99, weeklyPct: 0 }); // above the 5% floor
      const d = budgetGate(usage, POLICY, NIGHT, { skipPacing: true });
      if (d.admit) throw new Error("expected the session floor to still defer");
      expect(d.reason).toBe("session-headroom");
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

    it("stops at a low reserve cap the burst blew past (weekly-cap to the reset)", () => {
      // A reserve plan (cap 50) already fully spent (99%): above the cap → stop until the weekly
      // resets, so the retry is the reset itself.
      const reservePolicy: BudgetPolicy = { ...POLICY, weeklyTargetPct: 50 };
      const reset = resetForElapsed(NIGHT, 0.9);
      const usage = makeUsage({ sessionPct: 5, weeklyPct: 99, weeklyResetAt: reset });
      const d = budgetGate(usage, reservePolicy, NIGHT);
      if (d.admit) throw new Error("expected defer");
      expect(d.reason).toBe("weekly-cap");
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

const DAY_MS = 24 * HOUR_MS;

/** Usage whose weekly pace-line sits at `elapsed` of the week relative to `now` (deterministic pace). */
function usageAt(
  now: number,
  o: { elapsed: number; weeklyPct: number; sessionPct: number },
): ClaudeUsage {
  return {
    sessionPct: o.sessionPct,
    weeklyPct: o.weeklyPct,
    sessionResetAt: new Date(now + 3 * HOUR_MS).toISOString(),
    weeklyResetAt: resetForElapsed(now, o.elapsed),
    plan: "max",
  };
}

// Mixed-value queue: one job per band. `value` here is what jobValueScore would produce.
const RISK_HIGH = { value: 0.9, sessionCost: 2 };
const BLOCKING_PR = { value: 0.6, sessionCost: 2 };
const CLEANUP = { value: 0.2, sessionCost: 2 };
const MIXED_QUEUE = [CLEANUP, RISK_HIGH, BLOCKING_PR];

/**
 * anton's OWN board vocabulary (anton-prng) — nominated in this project's settings, not shipped by
 * the scorer. Every assertion that speaks of `risk:high` / `blocking-PR` scores this policy, because
 * on a board that nominates nothing those strings mean nothing.
 */
const ANTON_POLICY: BudgetPolicy = { ...POLICY, valueLabels: ["risk:high", "blocking-PR"] };

describe("jobValueScore", () => {
  it("nominates nothing by default — every bead ranks in the age band", () => {
    // The agnosticism default: a repo anton has never seen the conventions of ranks on native
    // fields alone, and says so by scoring identically whatever labels a bead happens to carry.
    const risky = jobValueScore({ labels: ["risk:high", "blocking-PR"], ageMs: DAY_MS }, POLICY);
    const plain = jobValueScore({ labels: ["whatever"], ageMs: DAY_MS }, POLICY);
    expect(risky).toBe(plain);
    expect(risky).toBe(0.4 * (DAY_MS / POLICY.valueAgeWindowMs));
    // Age still orders the queue; it is simply the only signal left.
    expect(jobValueScore({ labels: [], ageMs: 7 * DAY_MS }, POLICY)).toBe(0.4);
  });

  it("reproduces the shipped bands exactly under anton's own two-tier nomination", () => {
    const ageFrac = 3 / 7; // three days into the seven-day age window
    const aged = 3 * DAY_MS;
    expect(jobValueScore({ labels: ["risk:high", "size:L"], ageMs: aged }, ANTON_POLICY)).toBe(
      0.8 + 0.2 * ageFrac,
    );
    expect(jobValueScore({ labels: ["blocking-PR"], ageMs: aged }, ANTON_POLICY)).toBe(
      0.5 + 0.2 * ageFrac,
    );
    expect(jobValueScore({ labels: ["size:S"], ageMs: aged }, ANTON_POLICY)).toBe(0.4 * ageFrac);
    // Band edges, where the thresholds admitJob was tuned against sit.
    expect(jobValueScore({ labels: ["risk:high"], ageMs: 0 }, ANTON_POLICY)).toBe(0.8);
    expect(jobValueScore({ labels: ["risk:high"], ageMs: 30 * DAY_MS }, ANTON_POLICY)).toBe(1);
    expect(jobValueScore({ labels: ["blocking-PR"], ageMs: 0 }, ANTON_POLICY)).toBe(0.5);
    expect(jobValueScore({ labels: ["blocking-PR"], ageMs: 30 * DAY_MS }, ANTON_POLICY)).toBe(0.7);
  });

  it("bands the nominations in order, disjointly", () => {
    const high = jobValueScore({ labels: ["risk:high", "size:L"] }, ANTON_POLICY);
    const pr = jobValueScore({ labels: ["blocking-PR"] }, ANTON_POLICY);
    const cleanup = jobValueScore({ labels: ["size:S"], ageMs: DAY_MS }, ANTON_POLICY);
    expect(high).toBeGreaterThanOrEqual(0.8);
    expect(pr).toBeGreaterThanOrEqual(0.5);
    expect(pr).toBeLessThan(0.7 + 1e-9);
    expect(cleanup).toBeLessThan(0.4);
    // Total order holds: a fresh cleanup job never outranks a PR job, etc.
    expect(pr).toBeGreaterThan(cleanup);
    expect(high).toBeGreaterThan(pr);
  });

  it("scores a bead in the HIGHEST nomination it carries, not the first label it has", () => {
    // The nomination order is the tier order — a bead carrying both bands in the top one.
    const both = jobValueScore({ labels: ["blocking-PR", "risk:high"] }, ANTON_POLICY);
    expect(both).toBe(jobValueScore({ labels: ["risk:high"] }, ANTON_POLICY));
  });

  it("keeps three nominated tiers disjoint — the structure generalises past two", () => {
    const three: BudgetPolicy = { ...POLICY, valueLabels: ["sev:1", "sev:2", "sev:3"] };
    const oldest = (label: string) =>
      jobValueScore({ labels: [label], ageMs: 30 * DAY_MS }, three);
    const freshest = (label: string) => jobValueScore({ labels: [label], ageMs: 0 }, three);
    // Every band's ceiling stays below the next band's floor: the oldest bead in a tier still loses
    // to the freshest bead one tier up, so the ordering is total rather than age-contaminated.
    expect(oldest("sev:2")).toBeLessThan(freshest("sev:1"));
    expect(oldest("sev:3")).toBeLessThan(freshest("sev:2"));
    expect(oldest("nothing")).toBeLessThan(freshest("sev:3"));
    // Still bounded by [0,1], with the nominated region above the unnominated one.
    expect(oldest("sev:1")).toBeLessThanOrEqual(1);
    expect(freshest("sev:3")).toBeGreaterThanOrEqual(0.5);
    expect(oldest("nothing")).toBe(0.4);
  });

  it("floors the top band on the scarce bar and the lowest on the normal bar, at any tier count", () => {
    // The bands are what admitJob's thresholds cut against, so "scarce admits the top tier only" and
    // "on-pace admits anything nominated" have to hold for one nomination or five — not just for the
    // two anton's own board happens to use. A single nomination that floored at 0.5 would be held by
    // every scarce tick, silently, which is the whole class of bug this ticket exists to kill.
    for (const valueLabels of [["a"], ["a", "b"], ["a", "b", "c"], ["a", "b", "c", "d", "e"]]) {
      const policy: BudgetPolicy = { ...POLICY, valueLabels };
      const top = valueLabels[0];
      const bottom = valueLabels[valueLabels.length - 1];
      expect(jobValueScore({ labels: [top], ageMs: 0 }, policy)).toBe(
        POLICY.valueThresholdScarce,
      );
      // A sole nomination IS the top tier — there is no lower one to floor on the normal bar.
      if (valueLabels.length > 1) {
        expect(jobValueScore({ labels: [bottom], ageMs: 0 }, policy)).toBe(
          POLICY.valueThresholdNormal,
        );
      }
      // And the whole nominated region stays inside [normal bar, 1].
      expect(jobValueScore({ labels: [top], ageMs: 30 * DAY_MS }, policy)).toBeLessThanOrEqual(1);
    }
  });

  it("uses age only as a within-band tie-break", () => {
    const fresh = jobValueScore({ labels: ["blocking-PR"], ageMs: 0 }, ANTON_POLICY);
    const old = jobValueScore({ labels: ["blocking-PR"], ageMs: 7 * DAY_MS }, ANTON_POLICY);
    expect(old).toBeGreaterThan(fresh);
    // Even a week-old cleanup job stays below the freshest blocking-PR job.
    const oldCleanup = jobValueScore({ labels: [], ageMs: 30 * DAY_MS }, ANTON_POLICY);
    expect(oldCleanup).toBeLessThan(fresh);
  });
});

describe("admitJob / admissibleJobs (pace-modulated prioritization)", () => {
  it("fails open on a null usage read", () => {
    expect(admitJob(null, POLICY, NOON, CLEANUP).admit).toBe(true);
  });

  it("ahead of pace in the throttle band admits only high-value work", () => {
    // Weekly burst into the throttle band (85% ≥ floor 80, vs 50% expected at half-week) → ahead of
    // pace where pacing engages → scarce, even with a fresh session (abundant headroom). Daytime, so
    // no night discount muddies the threshold.
    const usage = usageAt(NOON, { elapsed: 0.5, weeklyPct: 85, sessionPct: 10 });
    const admitted = admissibleJobs(usage, POLICY, NOON, MIXED_QUEUE);
    expect(admitted).toEqual([RISK_HIGH]);
    expect(admitJob(usage, POLICY, NOON, BLOCKING_PR).reason).toBe("value-below-threshold");
  });

  it("ahead of pace BELOW the throttle band is idle-fill — the value bar does not tighten", () => {
    // Early-week burst (70% at half-week vs 50% expected) that stays below the throttle floor (80):
    // budgetGate admits freely here (idle-fill, anton-ld7j), so admitJob must not read ahead-of-pace
    // as scarce. Fresh session (headroom 70 ≥ abundant 60) → abundant → everything runs.
    const usage = usageAt(NOON, { elapsed: 0.5, weeklyPct: 70, sessionPct: 30 });
    const admitted = admissibleJobs(usage, POLICY, NOON, MIXED_QUEUE);
    expect(admitted).toEqual([RISK_HIGH, BLOCKING_PR, CLEANUP]);
  });

  it("behind pace admits down to low-value cleanup", () => {
    // Under-spent week (10% at half-week) → behind pace → abundant → threshold 0, everything runs.
    const usage = usageAt(NOON, { elapsed: 0.5, weeklyPct: 10, sessionPct: 30 });
    const admitted = admissibleJobs(usage, POLICY, NOON, MIXED_QUEUE);
    // All three admitted, ordered by value (anton's admission order, not the board's).
    expect(admitted).toEqual([RISK_HIGH, BLOCKING_PR, CLEANUP]);
  });

  it("holds a job whose cost exceeds remaining headroom when ahead of pace", () => {
    // Ahead of pace inside the throttle band (85 ≥ floor 80); session headroom 30 is NOT scarce on
    // its own (> 20), so ahead-of-pace is the sole scarce driver — isolating acceptance #3.
    const usage = usageAt(NOON, { elapsed: 0.5, weeklyPct: 85, sessionPct: 70 });
    const heavyHighValue = { value: 0.95, sessionCost: 40 }; // 40 > 30 headroom
    const cheapHighValue = { value: 0.95, sessionCost: 5 };
    expect(admitJob(usage, POLICY, NOON, heavyHighValue).reason).toBe("cost-exceeds-headroom");
    expect(admitJob(usage, POLICY, NOON, cheapHighValue).admit).toBe(true);
  });

  it("night lowers the bar for heavy jobs but not light ones", () => {
    // On-pace (50% at half-week), mid headroom → normal threshold 0.5. A cleanup job (value 0.3)
    // is held by day but a HEAVY one clears at night; a light cleanup job stays held.
    const usage = usageAt(NIGHT, { elapsed: 0.5, weeklyPct: 50, sessionPct: 50 });
    const day = usageAt(NOON, { elapsed: 0.5, weeklyPct: 50, sessionPct: 50 });
    const heavyCleanup = { value: 0.3, sessionCost: 15 }; // full night discount → threshold 0.2
    const lightCleanup = { value: 0.3, sessionCost: 3 }; // small discount → threshold ~0.44
    expect(admitJob(day, POLICY, NOON, heavyCleanup).admit).toBe(false);
    expect(admitJob(usage, POLICY, NIGHT, heavyCleanup).admit).toBe(true);
    expect(admitJob(usage, POLICY, NIGHT, lightCleanup).admit).toBe(false);
  });
});

describe("isBehindPace (shaping-nudge input)", () => {
  it("is true when weekly usage trails the pace-line beyond the slack band", () => {
    // Half the week elapsed (target ~50%) but only 30% burned → behind, room in the plan.
    expect(isBehindPace(usageAt(NOON, { elapsed: 0.5, weeklyPct: 30, sessionPct: 10 }), POLICY, NOON)).toBe(true);
  });

  it("is false on-pace and when ahead of the plan", () => {
    expect(isBehindPace(usageAt(NOON, { elapsed: 0.5, weeklyPct: 50, sessionPct: 10 }), POLICY, NOON)).toBe(false);
    expect(isBehindPace(usageAt(NOON, { elapsed: 0.5, weeklyPct: 80, sessionPct: 10 }), POLICY, NOON)).toBe(false);
  });

  it("is false on a null read — never nags when the pace is unknown", () => {
    expect(isBehindPace(null, POLICY, NOON)).toBe(false);
  });
});

describe("budgetHeadroom (the budget line's placement input, anton-vlom)", () => {
  it("returns null on a null read — the line is omitted, never guessed", () => {
    expect(budgetHeadroom(null, POLICY, NOON)).toBeNull();
  });

  it("reports the session floor's remaining points at night", () => {
    // Night: the daytime reserve is not in force, so the hard floor (100 − 5) is what's left.
    const h = budgetHeadroom(usageAt(NIGHT, { elapsed: 0.5, weeklyPct: 50, sessionPct: 60 }), POLICY, NIGHT);
    expect(h).toMatchObject({ sessionPct: 35, sessionReason: "session-headroom" });
  });

  it("reports the daytime reserve inside the day window — the tighter hold on the same meter", () => {
    // On pace, so the reserve holds: 100 − 40 = 60 is the ceiling, 20 points below current usage.
    const h = budgetHeadroom(usageAt(NOON, { elapsed: 0.5, weeklyPct: 50, sessionPct: 40 }), POLICY, NOON);
    expect(h).toMatchObject({ sessionPct: 20, sessionReason: "daytime-reserve" });
  });

  it("waives the daytime reserve when behind the weekly plan — work spills into the day", () => {
    const h = budgetHeadroom(usageAt(NOON, { elapsed: 0.5, weeklyPct: 10, sessionPct: 40 }), POLICY, NOON);
    expect(h).toMatchObject({ sessionPct: 55, sessionReason: "session-headroom" });
  });

  it("says how much weekly burn the behind-pace waiver survives — it is not permanent", () => {
    // A projection spends weekly budget as it walks the queue, and the reserve is waived only while
    // usage stays behind pace: 35 more points (the 45-point line, less the 10 already spent) and the
    // gate stops waiving it, from which point the reserve's own ceiling (60) is what binds.
    const h = budgetHeadroom(usageAt(NOON, { elapsed: 0.5, weeklyPct: 10, sessionPct: 40 }), POLICY, NOON);
    expect(h?.reserveWaiver).toEqual({ afterWeeklyPct: 35, sessionPct: 20 });
  });

  it("carries no waiver where the reserve is not being waived at all", () => {
    // Night (out of the day window), and on-pace daytime (the reserve holds outright): in neither
    // case is there a waiver to expire, so a projection has nothing to re-apply.
    expect(
      budgetHeadroom(usageAt(NIGHT, { elapsed: 0.5, weeklyPct: 10, sessionPct: 40 }), POLICY, NIGHT)
        ?.reserveWaiver,
    ).toBeNull();
    expect(
      budgetHeadroom(usageAt(NOON, { elapsed: 0.5, weeklyPct: 50, sessionPct: 40 }), POLICY, NOON)
        ?.reserveWaiver,
    ).toBeNull();
    // No weekly signal: no pace to be behind, so the reserve was never waived either.
    expect(
      budgetHeadroom(makeUsage({ sessionPct: 40, weeklyPct: 10, weeklyResetAt: null }), POLICY, NOON)
        ?.reserveWaiver,
    ).toBeNull();
  });

  it("reports the weekly cap when the pace-line is above it", () => {
    // Late week: the pace-line has risen past the cap, so the cap is the only weekly hold left.
    const h = budgetHeadroom(usageAt(NIGHT, { elapsed: 0.99, weeklyPct: 88, sessionPct: 10 }), POLICY, NIGHT);
    expect(h).toMatchObject({ weeklyPct: 12, weeklyReason: "weekly-cap", weeklyInclusive: true });
  });

  it("reports the pace-line inside the throttle band, not the cap it hasn't reached", () => {
    // Mid-week, ahead of pace: idle-fill runs free to the throttle floor (80), and no further.
    const h = budgetHeadroom(usageAt(NIGHT, { elapsed: 0.5, weeklyPct: 62, sessionPct: 10 }), POLICY, NIGHT);
    // Held up by the throttle floor, which — like the cap — the gate defers AT.
    expect(h).toMatchObject({ weeklyPct: 18, weeklyReason: "weekly-on-track", weeklyInclusive: true });
  });

  it("marks the pace-line itself exclusive — the gate defers only PAST the ceiling", () => {
    // Late enough in the week that the pace-line has risen clear of the throttle floor (80) without
    // reaching the cap: 100 × 0.8 + 5 = 85 is the limit, and `usage > 85` is what defers.
    const h = budgetHeadroom(usageAt(NIGHT, { elapsed: 0.8, weeklyPct: 82, sessionPct: 10 }), POLICY, NIGHT);
    expect(h).toMatchObject({ weeklyPct: 3, weeklyReason: "weekly-on-track", weeklyInclusive: false });
  });

  it("reports no weekly headroom without a weekly signal — unknown, not zero", () => {
    const usage = makeUsage({ sessionPct: 10, weeklyPct: 40, weeklyResetAt: null });
    expect(budgetHeadroom(usage, POLICY, NIGHT)?.weeklyPct).toBeNull();
  });

  it("never reports negative headroom once a hold is already tripped", () => {
    const h = budgetHeadroom(usageAt(NIGHT, { elapsed: 0.5, weeklyPct: 99, sessionPct: 99 }), POLICY, NIGHT);
    expect(h).toMatchObject({ sessionPct: 0, weeklyPct: 0 });
  });

  it("agrees with the gate on whether work may start now", () => {
    // The property the budget line rests on: a surface that computed its own idea of "remaining"
    // would draw a line the governor does not keep. Zero on either side must mean the gate defers.
    //
    // The sampled points sit OFF the exact pace-line (ceilings here are 15 / 55 / 95): landing on
    // it exactly is the one hair's-width disagreement — the gate admits the run that would cross
    // the line, this reports no room for it — and it is a one-card difference on a float coincidence.
    for (const now of [NOON, NIGHT]) {
      for (const sessionPct of [0, 40, 59, 61, 94, 96]) {
        for (const weeklyPct of [0, 50, 79, 86, 96, 100]) {
          for (const elapsed of [0.1, 0.5, 0.9]) {
            const usage = usageAt(now, { elapsed, weeklyPct, sessionPct });
            const h = budgetHeadroom(usage, POLICY, now);
            const affordsOne = h!.sessionPct > 0 && (h!.weeklyPct === null || h!.weeklyPct > 0);
            expect(
              affordsOne,
              `now=${now} session=${sessionPct} weekly=${weeklyPct} elapsed=${elapsed}`,
            ).toBe(budgetGate(usage, POLICY, now).admit);
          }
        }
      }
    }
  });
});
