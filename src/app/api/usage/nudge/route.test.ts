/**
 * Nudge route contract (anton-eklj): resolves the three backlog-starvation conditions server-side
 * and serializes them as JSON; a null usage read answers 204 so a page render never sees an error.
 * The ready-queue sweep only runs when the cheap pace/headroom conditions already hold — otherwise
 * the nudge can't fire, so there's no reason to spawn `bd`. Pace/headroom are evaluated against the
 * budget-aware projects' STORED policies (not a hard-coded default), so the nudge agrees with what
 * each project's governor actually admits.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ClaudeUsage } from "@/lib/claude/usage";
import { DEFAULT_BUDGET_POLICY, type BudgetPolicy } from "@/lib/jobs/budget";
import type { ShapingSignal } from "@/lib/usage";

const getDisplayUsage = vi.fn<() => Promise<ClaudeUsage | null>>();
const getReadyCountCached = vi.fn<() => Promise<number | null>>();
const budgetAwareProjectPolicies = vi.fn<() => Promise<BudgetPolicy[]>>();
vi.mock("@/lib/claude/usage", () => ({ getDisplayUsage }));
vi.mock("@/lib/claude/ready-count", () => ({ getReadyCountCached }));
vi.mock("@/lib/projects", () => ({ budgetAwareProjectPolicies }));

const { GET } = await import("./route");

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * What `resolveBudgetPolicy` yields for a project with no stored knobs: the governor defaults with
 * the operator-facing DEFAULT_PROJECT_BUDGET_POLICY overlaid (keep in sync with projects.ts).
 */
const RESOLVED_DEFAULT: BudgetPolicy = {
  ...DEFAULT_BUDGET_POLICY,
  weeklyTargetPct: 90,
  daytimeReservePct: 15,
  dayStartHour: 9,
  dayEndHour: 18,
  minSessionHeadroomPct: 5,
  utcOffsetMinutes: -new Date().getTimezoneOffset(),
};

/** Weekly reset placing "now" at ~half the week, so a low weeklyPct reads as behind pace. */
function usage(o: Partial<ClaudeUsage> = {}): ClaudeUsage {
  return {
    sessionPct: 10,
    weeklyPct: 20,
    sessionResetAt: null,
    weeklyResetAt: new Date(Date.now() + 0.5 * WEEK_MS).toISOString(),
    plan: "max",
    ...o,
  };
}

beforeEach(() => {
  // Budget-aware execution is the gate for the nudge (anton-7mpv.1); default one governed project
  // on the resolved default policy so the signal cases exercise the usage path.
  budgetAwareProjectPolicies.mockResolvedValue([RESOLVED_DEFAULT]);
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("GET /api/usage/nudge", () => {
  it("answers 204 without reading usage when budget-aware execution is off everywhere (anton-7mpv.1)", async () => {
    budgetAwareProjectPolicies.mockResolvedValue([]);

    const res = await GET();

    expect(res.status).toBe(204);
    expect(await res.text()).toBe("");
    expect(getDisplayUsage).not.toHaveBeenCalled();
    expect(getReadyCountCached).not.toHaveBeenCalled();
  });

  it("answers 204 with no body when usage is unavailable", async () => {
    getDisplayUsage.mockResolvedValueOnce(null);

    const res = await GET();

    expect(res.status).toBe(204);
    expect(await res.text()).toBe("");
    expect(getReadyCountCached).not.toHaveBeenCalled();
  });

  it("reads the ready count and reports the signal when behind pace with headroom", async () => {
    getDisplayUsage.mockResolvedValueOnce(usage());
    getReadyCountCached.mockResolvedValueOnce(1);

    const res = await GET();
    const signal = (await res.json()) as ShapingSignal;

    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toContain("max-age=30");
    expect(signal.behindPace).toBe(true);
    expect(signal.headroomAvailable).toBe(true);
    expect(signal.readyCount).toBe(1);
    expect(signal.weeklyRemainingPct).toBe(80);
    expect(getReadyCountCached).toHaveBeenCalledOnce();
  });

  it("uses the governor's 15% daytime reserve, not the stricter global 40% default", async () => {
    // On pace (weekly 45% ≈ the elapsed half-week's 90%-target line), so the daytime-reserve
    // branch is what decides. sessionPct 70 clears the per-project reserve (100 − 15 = 85) at any
    // hour, but would have been deferred by the global default's 40% reserve (threshold 60) during
    // its 08–22 day window — the regime where the nudge went dark while the governor admitted work.
    getDisplayUsage.mockResolvedValueOnce(usage({ sessionPct: 70, weeklyPct: 45 }));

    const res = await GET();
    const signal = (await res.json()) as ShapingSignal;

    expect(signal.headroomAvailable).toBe(true);
  });

  it("applies a project's STORED budget knobs, not the shipped defaults", async () => {
    // Operator raised the daytime reserve to 60%: during the day window, sessionPct 70 breaches the
    // 100 − 60 = 40 threshold and the real governor defers — so the nudge must report no headroom,
    // where the default 15% reserve (threshold 85) would have admitted. Time + offset are pinned so
    // "now" (12:00 local) is inside the stored [9,18) day window.
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-01-07T12:00:00Z"));
    try {
      budgetAwareProjectPolicies.mockResolvedValue([
        { ...RESOLVED_DEFAULT, daytimeReservePct: 60, utcOffsetMinutes: 0 },
      ]);
      getDisplayUsage.mockResolvedValueOnce(usage({ sessionPct: 70, weeklyPct: 45 }));

      const res = await GET();
      const signal = (await res.json()) as ShapingSignal;

      expect(signal.headroomAvailable).toBe(false);
      expect(getReadyCountCached).not.toHaveBeenCalled();
    } finally {
      nowSpy.mockRestore();
    }
  });

  it("evaluates the day window on the stored policy's local clock, not UTC", async () => {
    // UTC noon = 20:00 local at UTC+8: night for the governor's local dayWindow [9,18), but mid-day
    // in UTC. sessionPct 90 trips the 15% daytime reserve, so a UTC-evaluated nudge would report no
    // headroom while the governor is admitting night work.
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-01-07T12:00:00Z"));
    try {
      budgetAwareProjectPolicies.mockResolvedValue([
        { ...RESOLVED_DEFAULT, utcOffsetMinutes: 480 },
      ]);
      getDisplayUsage.mockResolvedValueOnce(usage({ sessionPct: 90, weeklyPct: 45 }));

      const res = await GET();
      const signal = (await res.json()) as ShapingSignal;

      expect(signal.headroomAvailable).toBe(true);
    } finally {
      nowSpy.mockRestore();
    }
  });

  it("suppresses the ready sweep when pace and headroom hold only under DIFFERENT projects' policies", async () => {
    // Project A (target 90) is behind pace but its high session floor (40) defers — no headroom.
    // Project B (target 40) has headroom but is on pace. No single governor would burn idle quota,
    // so the sweep is skipped and readyCount stays null (which suppresses the nudge client-side),
    // even though each boolean is individually true across the workspace.
    budgetAwareProjectPolicies.mockResolvedValue([
      { ...RESOLVED_DEFAULT, minSessionHeadroomPct: 40 },
      { ...RESOLVED_DEFAULT, weeklyTargetPct: 40 },
    ]);
    getDisplayUsage.mockResolvedValueOnce(usage({ sessionPct: 70, weeklyPct: 20 }));

    const res = await GET();
    const signal = (await res.json()) as ShapingSignal;

    expect(signal.behindPace).toBe(true);
    expect(signal.headroomAvailable).toBe(true);
    expect(signal.readyCount).toBeNull();
    expect(getReadyCountCached).not.toHaveBeenCalled();
  });

  it("skips the ready-queue sweep when not behind pace", async () => {
    // On pace (weekly matches the elapsed half-week) → the nudge can't fire, so don't spawn bd.
    getDisplayUsage.mockResolvedValueOnce(usage({ weeklyPct: 50 }));

    const res = await GET();
    const signal = (await res.json()) as ShapingSignal;

    expect(signal.behindPace).toBe(false);
    expect(signal.readyCount).toBeNull();
    expect(getReadyCountCached).not.toHaveBeenCalled();
  });
});
