/**
 * The budget-signal route (anton-vlom), against a real in-memory anton.db.
 *
 * Two properties the lane cannot prove on its own. FAIL-OPEN: every state in which the governor has
 * nothing to hold work on — the project isn't budget-aware, the usage read is null — answers `204`,
 * so the line is omitted rather than drawn from a guess. And the headroom is computed against the
 * project's STORED policy, not the shipped defaults, so the line lands where that project's governor
 * would actually stop.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { makeTestDb, type TestDb } from "@/lib/db/testing";
import * as schema from "@/lib/db/schema";
import { recordBurnSample } from "@/lib/burn";
import { systemClock } from "@/lib/jobs/queue";
import type { ClaudeUsage } from "@/lib/claude/usage";
import type { BudgetSignal } from "@/lib/budget-line";
import type { ProjectSettings } from "@/lib/projects";

let tdb: TestDb;
let usage: ClaudeUsage | null = null;
/** Counted in the mock itself: the route must not spend the shared usage cache on an ungoverned project. */
let usageReads = 0;

vi.mock("@/lib/db", () => ({ getDb: () => tdb.db, schema }));
const displayReads = vi.fn();
vi.mock("@/lib/claude/usage", () => ({
  getClaudeUsageCached: async () => {
    usageReads += 1;
    return usage;
  },
  getDisplayUsage: async () => {
    displayReads();
    return usage;
  },
}));

const { GET } = await import("./route");

const ctx = (slug: string) => ({ params: Promise.resolve({ slug }) });
const req = () => new Request("http://t/");

/** Mid-week, mid-session: neither hold is tripped, so both sides report real room. */
function makeUsage(over: Partial<ClaudeUsage> = {}): ClaudeUsage {
  return {
    sessionPct: 20,
    weeklyPct: 30,
    sessionResetAt: new Date(Date.now() + 3 * 3_600_000).toISOString(),
    weeklyResetAt: new Date(Date.now() + 3.5 * 24 * 3_600_000).toISOString(),
    plan: "max",
    ...over,
  };
}

async function settings(patch: ProjectSettings): Promise<void> {
  await tdb.db.update(schema.projects).set({ settingsJson: JSON.stringify(patch) });
}

describe("GET /picker/budget", () => {
  beforeEach(async () => {
    tdb = makeTestDb();
    usage = makeUsage();
    usageReads = 0;
    displayReads.mockClear();
    await tdb.db
      .insert(schema.projects)
      .values({ id: "p1", slug: "tmp", name: "tmp", repoPath: "/tmp/p1" });
    await settings({ budgetAware: true });
  });

  it("reports the governor's remaining headroom and the per-type burn average", async () => {
    const res = await GET(req(), ctx("tmp"));
    expect(res.status).toBe(200);

    const body = (await res.json()) as BudgetSignal;
    expect(body.headroom.sessionPct).toBeGreaterThan(0);
    // No samples yet: the average is the `execute-epic` tier seed, flagged as such so the line is
    // worded as an estimate rather than a measurement.
    expect(body.burn["execute-epic"]).toMatchObject({ seeded: true });
    expect(body.burn["execute-epic"]?.sessionPct).toBeGreaterThan(0);
  });

  it("reports the measured average once a type is fully sampled", async () => {
    for (let i = 0; i < 5; i++) {
      await recordBurnSample(tdb.db, systemClock, "execute-epic", {
        sessionDelta: 30,
        weeklyDelta: 4,
      });
    }
    const body = (await (await GET(req(), ctx("tmp"))).json()) as BudgetSignal;
    expect(body.burn["execute-epic"]).toEqual({ sessionPct: 30, weeklyPct: 4, seeded: false });
  });

  it("answers 204 when usage is unreadable — the governor fails open and so does the line", async () => {
    usage = null;
    expect((await GET(req(), ctx("tmp"))).status).toBe(204);
  });

  // The nav pill's last-good fallback would keep drawing a line — and marking cards as waiting —
  // through the very null read on which the governor fails open and starts them (PR #212 review).
  it("reads the governor's strict signal, never the display fallback", async () => {
    await GET(req(), ctx("tmp"));
    expect(usageReads).toBe(1);
    expect(displayReads).not.toHaveBeenCalled();
  });

  it("answers 204 for a project that is not budget-aware — no governor, no line", async () => {
    await settings({ budgetAware: false });
    expect((await GET(req(), ctx("tmp"))).status).toBe(204);
  });

  it("takes no usage read for an ungoverned project", async () => {
    await settings({});
    expect((await GET(req(), ctx("tmp"))).status).toBe(204);
    expect(usageReads).toBe(0);

    // The counter is live — a governed project does read.
    await settings({ budgetAware: true });
    await GET(req(), ctx("tmp"));
    expect(usageReads).toBe(1);
  });

  it("resolves the headroom against the project's stored policy, not the shipped defaults", async () => {
    await settings({ budgetAware: true, budgetPolicy: { weeklyTargetPct: 40 } });
    const tight = (await (await GET(req(), ctx("tmp"))).json()) as BudgetSignal;

    await settings({ budgetAware: true, budgetPolicy: { weeklyTargetPct: 95 } });
    const loose = (await (await GET(req(), ctx("tmp"))).json()) as BudgetSignal;

    expect(tight.headroom.weeklyPct).toBeLessThan(loose.headroom.weeklyPct!);
  });

  it("404s on an unknown slug", async () => {
    expect((await GET(req(), ctx("nope"))).status).toBe(404);
  });
});
