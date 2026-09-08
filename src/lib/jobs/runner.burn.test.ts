/**
 * Per-job burn sampling (anton-w8ny): the runner opens a usage window around each job that invokes
 * Claude and persists the session%/weekly% delta, attributed to that job's type. What it must NOT do
 * is as load-bearing as what it does — no sample when windows overlap (attribution needs a solo
 * window), when the project is not budget-aware, or when the usage read fails.
 */
import { describe, expect, it } from "vitest";
import * as schema from "../db/schema";
import { getBurnAverage } from "../burn";
import type { ClaudeUsage } from "../claude/usage";
import { DEFAULT_BUDGET_POLICY } from "./budget";
import { PoisonEpic, RunAlreadyLiveError } from "./errors";
import { getJob } from "./queue";
import type { BudgetPolicyResolver } from "./runner";
import { usage, useRunnerHarness } from "./runner.fixture";

describe("JobRunner per-job burn sampling (anton-w8ny)", () => {
  const h = useRunnerHarness();

  // Burn sampling is gated behind the budget-aware opt-in (anton-7mpv.1) — these tests wire a
  // resolver that opts every project in; the feature-off tests below omit it.
  const budgetAware: BudgetPolicyResolver = () => DEFAULT_BUDGET_POLICY;

  it("persists the session%/weekly% delta across a job, attributed to its type", async () => {
    // Pre-job snapshot via the cached read, post-job via the FRESH (TTL-bypassing) read:
    // 10%→30% session, 5%→8% weekly.
    const r = h.makeRunner({
      handlers: {
        "execute-epic": async (ctx) => ctx.claudeReached(),
      },
      resolveBudgetPolicy: budgetAware,
      readUsage: async () => usage({ sessionPct: 10, weeklyPct: 5 }),
      readUsageFresh: async () => usage({ sessionPct: 30, weeklyPct: 8 }),
    });
    await r.enqueue({ type: "execute-epic" });
    await r.tickOnce();
    await r.whenIdle();

    const avg = await getBurnAverage(h.db, "execute-epic", 1);
    expect(avg.seeded).toBe(false);
    expect(avg.sessionAvg).toBe(20);
    expect(avg.weeklyAvg).toBe(3);
  });

  it("attributes the sample to the project whose job spent it (anton-wj3d)", async () => {
    h.seedProjects("P");
    const r = h.makeRunner({
      handlers: {
        "execute-epic": async (ctx) => ctx.claudeReached(),
      },
      resolveBudgetPolicy: budgetAware,
      readUsage: async () => usage({ sessionPct: 10, weeklyPct: 5 }),
      readUsageFresh: async () => usage({ sessionPct: 30, weeklyPct: 8 }),
    });
    await r.enqueue({ type: "execute-epic", projectId: "P" });
    await r.tickOnce();
    await r.whenIdle();

    const rows = await h.db.select().from(schema.burnSamples);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.projectId).toBe("P");
  });

  it("leaves the project null for a job that belongs to none", async () => {
    const r = h.makeRunner({
      handlers: {
        "execute-epic": async (ctx) => ctx.claudeReached(),
      },
      resolveBudgetPolicy: budgetAware,
      readUsage: async () => usage({ sessionPct: 10, weeklyPct: 5 }),
      readUsageFresh: async () => usage({ sessionPct: 30, weeklyPct: 8 }),
    });
    await r.enqueue({ type: "execute-epic" });
    await r.tickOnce();
    await r.whenIdle();

    const rows = await h.db.select().from(schema.burnSamples);
    expect(rows[0]!.projectId).toBeNull();
  });

  it("closes the window with the fresh read, never the cached one (anti zero-delta)", async () => {
    // A cached after-read inside the TTL returns the same snapshot as the before-read → a bogus
    // 0% delta. The sampler must go through the fresh reader for the closing measurement.
    let freshCalls = 0;
    const r = h.makeRunner({
      handlers: {
        "execute-epic": async (ctx) => ctx.claudeReached(),
      },
      resolveBudgetPolicy: budgetAware,
      readUsage: async () => usage({ sessionPct: 10, weeklyPct: 5 }), // the stale cache entry, before AND after
      readUsageFresh: async () => {
        freshCalls += 1;
        return usage({ sessionPct: 25, weeklyPct: 7 });
      },
    });
    await r.enqueue({ type: "execute-epic" });
    await r.tickOnce();
    await r.whenIdle();

    expect(freshCalls).toBe(1);
    const avg = await getBurnAverage(h.db, "execute-epic", 1);
    expect(avg.sessionAvg).toBe(15); // 25 − 10, not the cached self-subtraction's 0
  });

  it("records NO sample on a null usage read and still completes the job", async () => {
    const r = h.makeRunner({
      handlers: {
        "execute-epic": async (ctx) => ctx.claudeReached(),
      },
      resolveBudgetPolicy: budgetAware,
      readUsage: async () => null,
      readUsageFresh: async () => null,
    });
    const id = await r.enqueue({ type: "execute-epic" });
    await r.tickOnce();
    await r.whenIdle();

    expect((await getJob(h.db, id))?.status).toBe("done");
    const rows = await h.db.select().from(schema.burnSamples);
    expect(rows).toHaveLength(0);
  });

  it("records NO sample for an attempt that never reached Claude, however it settled (PR #248)", async () => {
    // The sample is gated on the handler's own `claudeReached` signal, not on the settlement type.
    // A preflight can end any way without ever spawning Claude — a lease held on another machine
    // reschedules, a target that vanished poison-parks, an abandoned target simply completes — and
    // every such window measured whatever ELSE moved the meter (here: nothing). Recording those
    // would let a handful of stale exits reprice the type at zero for the project's quota share.
    h.seedProjects("P");
    let freshReads = 0;
    const r = h.makeRunner({
      handlers: {},
      resolveBudgetPolicy: budgetAware,
      readUsage: async () => usage({ sessionPct: 10, weeklyPct: 5 }),
      readUsageFresh: async () => {
        freshReads++;
        return usage({ sessionPct: 10, weeklyPct: 5 });
      },
    });
    const exits: Array<[string, () => Promise<void>]> = [
      [
        "queued",
        async () => {
          throw new RunAlreadyLiveError("run live on another machine", "foreign");
        },
      ],
      [
        "parked",
        async () => {
          throw new PoisonEpic("target epic-1 is no longer approved");
        },
      ],
      ["done", async () => {}],
    ];
    for (const [status, handler] of exits) {
      r.registerHandler("execute-epic", handler);
      const id = await r.enqueue({ type: "execute-epic", projectId: "P" });
      await r.tickOnce();
      await r.whenIdle();
      expect((await getJob(h.db, id))?.status).toBe(status);
    }
    expect(freshReads).toBe(0);
    expect(await h.db.select().from(schema.burnSamples)).toHaveLength(0);

    // None of the skipped windows spent throttle budget either: the next attempt that does reach
    // Claude samples — even one that then fails, since a failed spawn still burned quota.
    r.registerHandler("execute-epic", async (ctx) => {
      ctx.claudeReached();
      throw new Error("agent crashed after the spawn");
    });
    await r.enqueue({ type: "execute-epic", projectId: "P" });
    await r.tickOnce();
    await r.whenIdle();
    expect(freshReads).toBe(1);
    expect(await h.db.select().from(schema.burnSamples)).toHaveLength(1);
  });

  it("never fails a job when the usage read throws", async () => {
    const boom = async (): Promise<ClaudeUsage | null> => {
      throw new Error("usage endpoint down");
    };
    const r = h.makeRunner({
      handlers: {
        "execute-epic": async (ctx) => ctx.claudeReached(),
      },
      resolveBudgetPolicy: budgetAware,
      readUsage: boom,
      readUsageFresh: boom,
    });
    const id = await r.enqueue({ type: "execute-epic" });
    await r.tickOnce();
    await r.whenIdle();

    expect((await getJob(h.db, id))?.status).toBe("done");
    const rows = await h.db.select().from(schema.burnSamples);
    expect(rows).toHaveLength(0);
  });

  it("records NO samples for jobs whose windows overlap (attribution needs a solo window)", async () => {
    // Two jobs in flight at once: each window would include the sibling's burn, double-counting
    // across types. Neither may record a sample; a later solo job samples normally again.
    let reads = 0;
    const r = h.makeRunner({
      handlers: {
        "execute-epic": async (ctx) => ctx.claudeReached(),
        "review-fix": async (ctx) => ctx.claudeReached(),
      },
      config: { maxConcurrent: 2 },
      resolveBudgetPolicy: budgetAware,
      readUsage: async () => usage({ sessionPct: 10, weeklyPct: 5 }),
      readUsageFresh: async () => {
        reads += 1;
        return usage({ sessionPct: 30, weeklyPct: 8 });
      },
    });
    await r.enqueue({ type: "execute-epic" });
    await r.enqueue({ type: "review-fix" });
    expect(await r.tickOnce()).toBe(2); // both leased into the same tick → overlapping windows
    await r.whenIdle();

    expect(reads).toBe(0); // contaminated windows never even take the closing read
    expect(await h.db.select().from(schema.burnSamples)).toHaveLength(0);

    // Solo follow-up job still samples.
    await r.enqueue({ type: "execute-epic" });
    await r.tickOnce();
    await r.whenIdle();
    expect(await h.db.select().from(schema.burnSamples)).toHaveLength(1);
  });

  it("never reads usage when the project is not budget-aware (null policy — the feature-off default)", async () => {
    // The opt-in gate (anton-7mpv.1): a resolver that returns null means budget-aware execution is
    // off for the project, so a solo job must not open a burn window — neither the pre-job cached
    // read nor the post-job fresh read may fire (each shells out to credentials and can cache a
    // transient null into the shared cache the nav pill reads).
    let cachedReads = 0;
    let freshReads = 0;
    const r = h.makeRunner({
      handlers: {
        "execute-epic": async (ctx) => ctx.claudeReached(),
      },
      resolveBudgetPolicy: () => null,
      readUsage: async () => {
        cachedReads += 1;
        return usage({ sessionPct: 10, weeklyPct: 5 });
      },
      readUsageFresh: async () => {
        freshReads += 1;
        return usage({ sessionPct: 30, weeklyPct: 8 });
      },
    });
    const id = await r.enqueue({ type: "execute-epic" });
    await r.tickOnce();
    await r.whenIdle();

    expect((await getJob(h.db, id))?.status).toBe("done");
    expect(cachedReads).toBe(0);
    expect(freshReads).toBe(0);
    expect(await h.db.select().from(schema.burnSamples)).toHaveLength(0);
  });

  it("throttles the sampler: no fresh read for a second solo job inside the interval", async () => {
    // The fresh read bypasses the usage cache; with maxConcurrent: 1 every solo completion would
    // hit the endpoint. burnSampleMinIntervalMs caps that — a second job finishing inside the
    // window records no sample and takes no fresh read; once the interval elapses, sampling resumes.
    let freshReads = 0;
    const r = h.makeRunner({
      handlers: {
        "execute-epic": async (ctx) => ctx.claudeReached(),
      },
      config: { burnSampleMinIntervalMs: 60_000 },
      resolveBudgetPolicy: budgetAware,
      readUsage: async () => usage({ sessionPct: 10, weeklyPct: 5 }),
      readUsageFresh: async () => {
        freshReads += 1;
        return usage({ sessionPct: 30, weeklyPct: 8 });
      },
    });

    // First solo job samples.
    await r.enqueue({ type: "execute-epic" });
    await r.tickOnce();
    await r.whenIdle();
    expect(freshReads).toBe(1);
    expect(await h.db.select().from(schema.burnSamples)).toHaveLength(1);

    // Second job 30s later — inside the 60s window — must NOT hit the endpoint.
    h.clock.advance(30_000);
    await r.enqueue({ type: "execute-epic" });
    await r.tickOnce();
    await r.whenIdle();
    expect(freshReads).toBe(1); // unchanged — throttled
    expect(await h.db.select().from(schema.burnSamples)).toHaveLength(1);

    // Past the window — sampling resumes.
    h.clock.advance(31_000);
    await r.enqueue({ type: "execute-epic" });
    await r.tickOnce();
    await r.whenIdle();
    expect(freshReads).toBe(2);
    expect(await h.db.select().from(schema.burnSamples)).toHaveLength(2);
  });

  it("opens no window for a type that never invokes Claude, leaving the throttle for a real job", async () => {
    // sync-push is a deterministic `git push` — a window around it would blame unrelated Claude
    // usage on it AND spend burnSampleMinIntervalMs, starving the execute-epic that follows.
    let cachedReads = 0;
    let freshReads = 0;
    const r = h.makeRunner({
      handlers: {
        "sync-push": async () => {},
        "execute-epic": async (ctx) => ctx.claudeReached(),
      },
      config: { maxConcurrent: 1, burnSampleMinIntervalMs: 60_000 },
      resolveBudgetPolicy: budgetAware,
      readUsage: async () => {
        cachedReads += 1;
        return usage({ sessionPct: 10, weeklyPct: 5 });
      },
      readUsageFresh: async () => {
        freshReads += 1;
        return usage({ sessionPct: 30, weeklyPct: 8 });
      },
    });

    const id = await r.enqueue({ type: "sync-push" });
    await r.tickOnce();
    await r.whenIdle();
    expect((await getJob(h.db, id))?.status).toBe("done");
    expect(cachedReads).toBe(0);
    expect(freshReads).toBe(0);
    expect(await h.db.select().from(schema.burnSamples)).toHaveLength(0);

    // Immediately after (well inside the throttle interval) a Claude job still samples.
    await r.enqueue({ type: "execute-epic" });
    await r.tickOnce();
    await r.whenIdle();
    expect(freshReads).toBe(1);
    const rows = await h.db.select().from(schema.burnSamples);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.jobType).toBe("execute-epic");
  });

  it("never reads usage when no budget resolver is wired at all", async () => {
    // Without a resolveBudgetPolicy dep nothing can be budget-aware, so the sampler stays fully off.
    let reads = 0;
    const count = async () => {
      reads += 1;
      return usage({ sessionPct: 10, weeklyPct: 5 });
    };
    const r = h.makeRunner({
      handlers: {
        "execute-epic": async (ctx) => ctx.claudeReached(),
      },
      readUsage: count,
      readUsageFresh: count,
    });
    await r.enqueue({ type: "execute-epic" });
    await r.tickOnce();
    await r.whenIdle();

    expect(reads).toBe(0);
    expect(await h.db.select().from(schema.burnSamples)).toHaveLength(0);
  });
});
