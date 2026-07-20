/**
 * Usage route contract (anton-1nc): a live snapshot serializes to JSON with a short-lived
 * Cache-Control header; a null read (pill off / no creds / endpoint down) answers 204 with no
 * body, so a page render never sees an error from this endpoint.
 */
import { describe, expect, it, vi } from "vitest";
import type { ClaudeUsage } from "@/lib/claude/usage";

const getClaudeUsageCached = vi.fn<() => Promise<ClaudeUsage | null>>();
vi.mock("@/lib/claude/usage", () => ({ getClaudeUsageCached }));

const { GET } = await import("./route");

describe("GET /api/usage", () => {
  it("returns the usage snapshot as JSON with a short-TTL cache header", async () => {
    const usage: ClaudeUsage = {
      sessionPct: 64,
      weeklyPct: 37,
      sessionResetAt: "2026-07-18T20:40:00+00:00",
      weeklyResetAt: "2026-07-19T00:00:00+00:00",
      plan: "max",
    };
    getClaudeUsageCached.mockResolvedValueOnce(usage);

    const res = await GET();

    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toContain("max-age=30");
    expect(await res.json()).toEqual(usage);
  });

  it("answers 204 with no body when usage is unavailable", async () => {
    getClaudeUsageCached.mockResolvedValueOnce(null);

    const res = await GET();

    expect(res.status).toBe(204);
    expect(await res.text()).toBe("");
  });
});
