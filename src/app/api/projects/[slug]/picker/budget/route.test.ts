/**
 * The budget-signal route (anton-vlom), against a real in-memory anton.db.
 *
 * Two properties the lane cannot prove on its own. FAIL-OPEN: every state in which the governor has
 * nothing to hold work on — the project isn't budget-aware, the usage read is null — answers `204`,
 * so the line is omitted rather than drawn from a guess. And the headroom is computed against the
 * project's STORED policy, not the shipped defaults, so the line lands where that project's governor
 * would actually stop.
 *
 * The third is the quota share (R6.1/R6.4): the line has to carry the cut this project actually
 * spends against, not the machine-wide target — a lane drawn on the unshared ceiling would show
 * headroom for work the governor is about to defer, and hide the room an idle neighbour buys back.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";

import { makeTestDb, type TestDb } from "@/lib/db/testing";
import * as schema from "@/lib/db/schema";
import { recordBurnSample, TIER_SEEDS } from "@/lib/burn";
import { systemClock } from "@/lib/jobs/queue";
import type { ClaudeUsage } from "@/lib/claude/usage";
import type { BudgetSignal } from "@/lib/budget-line";
import type { ProjectSettings } from "@/lib/projects";

let tdb: TestDb;
let usage: ClaudeUsage | null = null;
/** Counted in the mock itself: the route must not spend the shared usage cache on an ungoverned project. */
let usageReads = 0;
/** This project's attributed spend, and whether reading it blows up — both driven per case. */
let spendPct: number | null = null;
let spendFails = false;

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
vi.mock("@/lib/quota-spend", () => ({
  projectWeeklySpendPct: async () => {
    if (spendFails) throw new Error("db hiccup");
    return spendPct;
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

async function settings(patch: ProjectSettings, id = "p1"): Promise<void> {
  await tdb.db
    .update(schema.projects)
    .set({ settingsJson: JSON.stringify(patch) })
    .where(eq(schema.projects.id, id));
}

/** Another armed repo, so the share board has a denominator to proportion against. */
async function neighbour(id: string, patch: ProjectSettings): Promise<void> {
  await tdb.db.insert(schema.projects).values({ id, slug: id, name: id, repoPath: `/tmp/${id}` });
  await settings(patch, id);
}

/** What a picker pass leaves behind — `0` targets is the only way a repo reads as idle (R6.4). */
async function pickerPlan(projectId: string, targetCount: number): Promise<void> {
  await tdb.db
    .insert(schema.boardPickerPlans)
    .values({ projectId, boardDigest: "d", boardObservedAtMs: 1, targetCount });
}

/** The lane's weekly headroom, which is what a share narrows. */
async function weeklyHeadroom(): Promise<number | null> {
  return ((await (await GET(req(), ctx("tmp"))).json()) as BudgetSignal).headroom.weeklyPct;
}

describe("GET /picker/budget", () => {
  beforeEach(async () => {
    tdb = makeTestDb();
    usage = makeUsage();
    usageReads = 0;
    spendPct = null;
    spendFails = false;
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
    // Attributed to this project: the weekly side is charged at the project's own rate, so an
    // unattributed sample would leave that half on the tier seed.
    for (let i = 0; i < 5; i++) {
      await recordBurnSample(tdb.db, systemClock, "execute-epic", "p1", {
        sessionDelta: 30,
        weeklyDelta: 4,
      });
    }
    const body = (await (await GET(req(), ctx("tmp"))).json()) as BudgetSignal;
    expect(body.burn["execute-epic"]).toEqual({ sessionPct: 30, weeklyPct: 4, seeded: false });
  });

  // The weekly side of the line is bounded by this project's SHARE, which the governor charges at
  // the project's own measured rate — so a lane charging the global rate would show an expensive
  // project too many affordable cards and a cheap one too few (PR #248 review). The session side
  // stays global: that meter is account-wide, and the runner's value gate charges it globally too.
  it("charges the weekly side at this project's rate and the session side at the account's", async () => {
    await neighbour("p2", {});
    // Only the NEIGHBOUR has samples, so the two averages cannot be confused: the account-wide read
    // is fully measured while this project has nothing of its own and falls back to the tier seed.
    for (let i = 0; i < 5; i++) {
      await recordBurnSample(tdb.db, systemClock, "execute-epic", "p2", {
        sessionDelta: 30,
        weeklyDelta: 4,
      });
    }

    const body = (await (await GET(req(), ctx("tmp"))).json()) as BudgetSignal;
    expect(body.burn["execute-epic"]?.sessionPct).toBe(30);
    expect(body.burn["execute-epic"]?.weeklyPct).toBe(TIER_SEEDS.L.weeklyPct);
    // Seeded on either side is seeded: the line leans on an estimate and must say so.
    expect(body.burn["execute-epic"]?.seeded).toBe(true);
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

  it("narrows the lane to the project's quota share, not the machine-wide target (R6.1)", async () => {
    // 20/80 across two armed repos: the line has to be drawn on the 20% cut of the 90-point target
    // this project may actually spend, or it would promise room its own governor is about to deny.
    await settings({ budgetAware: true, quotaSharePct: 20, budgetPolicy: { weeklyTargetPct: 90 } });
    await neighbour("p2", { budgetAware: true, quotaSharePct: 80 });

    // The account-side pace line alone would leave 40 points open; the 20% cut of 90 is tighter.
    expect(await weeklyHeadroom()).toBeCloseTo(18, 6);
  });

  it("holds the lane at the share cap when the spend read fails", async () => {
    // Unattributed is not "spent" — a db hiccup must relax the share back to its full cap, the same
    // fail-soft posture the governor takes, rather than throwing or blanking the line.
    await settings({ budgetAware: true, quotaSharePct: 20, budgetPolicy: { weeklyTargetPct: 90 } });
    await neighbour("p2", { budgetAware: true, quotaSharePct: 80 });
    spendFails = true;

    const res = await GET(req(), ctx("tmp"));
    expect(res.status).toBe(200);
    expect(((await res.json()) as BudgetSignal).headroom.weeklyPct).toBeCloseTo(18, 6);
  });

  it("widens the lane when an idle neighbour's share is renormalized away (R6.4)", async () => {
    // 20/30/50, and the 30 repo's picker pass found nothing startable — so it drops out of the
    // denominator and this repo's cut grows to 20/70. The lane has to show that room, or the
    // operator sees work waiting on quota nobody is using.
    await settings({ budgetAware: true, quotaSharePct: 20, budgetPolicy: { weeklyTargetPct: 90 } });
    await neighbour("p2", { budgetAware: true, quotaSharePct: 30 });
    await neighbour("p3", { budgetAware: true, quotaSharePct: 50 });
    await pickerPlan("p2", 0);

    // Still the binding limit (the account side leaves 40), so this is the share and nothing else.
    expect(await weeklyHeadroom()).toBeCloseTo((90 * 20) / 70, 6);
  });

  it("404s on an unknown slug", async () => {
    expect((await GET(req(), ctx("nope"))).status).toBe(404);
  });
});
