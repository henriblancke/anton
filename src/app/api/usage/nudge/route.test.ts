/**
 * Nudge route contract (anton-eklj): resolves the three backlog-starvation conditions server-side
 * and serializes them as JSON; a null usage read answers 204 so a page render never sees an error.
 * The ready-queue sweep only runs when the cheap pace/headroom conditions already hold — otherwise
 * the nudge can't fire, so there's no reason to spawn `bd`.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ClaudeUsage } from "@/lib/claude/usage";
import type { ShapingSignal } from "@/lib/usage";

const getClaudeUsageCached = vi.fn<() => Promise<ClaudeUsage | null>>();
const getReadyCountCached = vi.fn<() => Promise<number | null>>();
vi.mock("@/lib/claude/usage", () => ({ getClaudeUsageCached }));
vi.mock("@/lib/claude/ready-count", () => ({ getReadyCountCached }));

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

afterEach(() => {
  vi.clearAllMocks();
});

describe("GET /api/usage/nudge", () => {
  it("answers 204 with no body when usage is unavailable", async () => {
    getClaudeUsageCached.mockResolvedValueOnce(null);

    const res = await GET();

    expect(res.status).toBe(204);
    expect(await res.text()).toBe("");
    expect(getReadyCountCached).not.toHaveBeenCalled();
  });

  it("reads the ready count and reports the signal when behind pace with headroom", async () => {
    getClaudeUsageCached.mockResolvedValueOnce(usage());
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
    getClaudeUsageCached.mockResolvedValueOnce(usage({ weeklyPct: 50 }));

    const res = await GET();
    const signal = (await res.json()) as ShapingSignal;

    expect(signal.behindPace).toBe(false);
    expect(signal.readyCount).toBeNull();
    expect(getReadyCountCached).not.toHaveBeenCalled();
  });
});
