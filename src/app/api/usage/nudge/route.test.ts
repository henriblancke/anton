/**
 * Nudge route contract (anton-eklj): resolves the three backlog-starvation conditions server-side
 * and serializes them as JSON; a null usage read answers 204 so a page render never sees an error.
 * The ready-queue sweep only runs when the cheap pace/headroom conditions already hold — otherwise
 * the nudge can't fire, so there's no reason to spawn `bd`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ClaudeUsage } from "@/lib/claude/usage";
import type { ShapingSignal } from "@/lib/usage";

const getDisplayUsage = vi.fn<() => Promise<ClaudeUsage | null>>();
const getReadyCountCached = vi.fn<() => Promise<number | null>>();
const isBudgetAwareEnabledAnywhere = vi.fn<() => Promise<boolean>>();
vi.mock("@/lib/claude/usage", () => ({ getDisplayUsage }));
vi.mock("@/lib/claude/ready-count", () => ({ getReadyCountCached }));
// Only isBudgetAwareEnabledAnywhere is exercised here; the default policy constant the route also
// imports from projects is a plain value, re-exported so the module resolves under the mock.
vi.mock("@/lib/projects", () => ({
  isBudgetAwareEnabledAnywhere,
  DEFAULT_PROJECT_BUDGET_POLICY: { weeklyTargetPct: 90 },
}));

const { GET } = await import("./route");

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

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
  // Budget-aware execution is the gate for the nudge (anton-7mpv.1); default it ON so the existing
  // signal cases exercise the usage path. The disabled case overrides it below.
  isBudgetAwareEnabledAnywhere.mockResolvedValue(true);
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("GET /api/usage/nudge", () => {
  it("answers 204 without reading usage when budget-aware execution is off everywhere (anton-7mpv.1)", async () => {
    isBudgetAwareEnabledAnywhere.mockResolvedValue(false);

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
