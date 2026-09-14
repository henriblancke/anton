/**
 * GET /api/projects/[slug]/router-usage contract (anton-ds7e): distinct from GET /api/usage, which
 * stays machine-wide and unchanged. An unrouted project answers 204 (nothing to show — the nav pill
 * already covers it); a routed project answers 200 with the view's `state`, whether `ok` or
 * `unreadable` — the unreadable state is a real 200 body, never folded into the 204 "not routed"
 * case, so the UI can never confuse "no router" with "router down".
 */
import { afterEach, describe, expect, it, vi } from "vitest";

const project = { id: "p1", slug: "tmp", repoPath: "/tmp/p1" };

vi.mock("../resolve-project", () => ({
  resolveProject: vi.fn(async () => ({ project })),
}));

const getProjectSettings = vi.fn(async () => ({}));
vi.mock("@/lib/projects", () => ({ getProjectSettings }));

vi.mock("@/lib/db", () => ({ getDb: () => ({}) }));

const getRouterUsageView = vi.fn();
vi.mock("@/lib/claude/router-usage-view", () => ({ getRouterUsageView }));

const { GET } = await import("./route");

const ctx = { params: Promise.resolve({ slug: "tmp" }) };
const get = () => GET(new Request("http://t/router-usage"), ctx);

afterEach(() => vi.clearAllMocks());

describe("GET /api/projects/[slug]/router-usage", () => {
  it("answers 204 with no body when the project isn't routed", async () => {
    getRouterUsageView.mockResolvedValueOnce({ state: "unrouted" });

    const res = await get();

    expect(res.status).toBe(204);
    expect(await res.text()).toBe("");
  });

  it("answers 200 with the routed snapshot, endpoint host, connection id, and dashboard url", async () => {
    const view = {
      state: "ok",
      usage: {
        sessionPct: 64,
        weeklyPct: 37,
        sessionResetAt: "2026-09-13T20:40:00.000Z",
        weeklyResetAt: "2026-09-14T00:00:00.000Z",
        plan: "Claude Code",
      },
      endpointHost: "localhost:20128",
      connectionId: "conn_ab12cd34",
      dashboardUrl: "http://localhost:20128",
    };
    getRouterUsageView.mockResolvedValueOnce(view);

    const res = await get();

    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toContain("max-age=30");
    expect(await res.json()).toEqual(view);
  });

  it("answers 200 with an unreadable state — never 204 — when the router can't be read", async () => {
    const view = {
      state: "unreadable",
      endpointHost: "localhost:20128",
      connectionId: "conn_ab12cd34",
      dashboardUrl: "http://localhost:20128",
    };
    getRouterUsageView.mockResolvedValueOnce(view);

    const res = await get();

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(view);
  });

  it("404s when the slug doesn't resolve to a project", async () => {
    const { resolveProject } = await import("../resolve-project");
    vi.mocked(resolveProject).mockResolvedValueOnce({
      response: new Response(JSON.stringify({ error: "Project not found" }), { status: 404 }),
    } as never);

    const res = await get();

    expect(res.status).toBe(404);
    expect(getRouterUsageView).not.toHaveBeenCalled();
  });
});
