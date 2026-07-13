/**
 * Durability tests for the job runner (anton-dzh.1): the pure policy (`nextAction`) and the
 * live loop against a real in-memory anton.db with a controllable clock — lease/reclaim,
 * quota backoff (park + reschedule, attempt refunded), and poison-pill parking after N attempts.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeTestDb, type TestDb } from "../db/testing";
import { PoisonError, UsageLimitError } from "./errors";
import { getJob, toMs, type Clock } from "./queue";
import {
  DEFAULT_CONFIG,
  JobRunner,
  nextAction,
  type JobHandler,
  type JobPolicy,
  type JobPolicyResolver,
  type RunnerConfig,
} from "./runner";

class FakeClock implements Clock {
  constructor(private t: number) {}
  now() {
    return this.t;
  }
  advance(ms: number) {
    this.t += ms;
  }
  set(ms: number) {
    this.t = ms;
  }
}

const CONFIG: RunnerConfig = {
  ...DEFAULT_CONFIG,
  leaseMs: 10_000,
  maxAttempts: 3,
  backoffBaseMs: 1_000,
  backoffMaxMs: 60_000,
  quotaCooloffMs: 30 * 60_000,
  maxConcurrent: 2,
  tickMs: 1_000,
};

describe("nextAction (pure durability policy)", () => {
  const now = 1_000_000_000_000;
  it("completes on success", () => {
    expect(nextAction(CONFIG, { attempts: 1 }, { kind: "success" }, now)).toEqual({
      action: "complete",
    });
  });

  it("reschedules a quota hit to the reset time and refunds the attempt", () => {
    const resetAt = Math.floor(now / 1000) + 3600; // seconds
    const a = nextAction(CONFIG, { attempts: 2 }, { kind: "quota", resetAt }, now);
    expect(a.action).toBe("reschedule");
    if (a.action !== "reschedule") throw new Error("unreachable");
    expect(a.refundAttempt).toBe(true);
    expect(a.runAtMs).toBe(resetAt * 1000);
  });

  it("uses the cool-off window when the reset time is unknown", () => {
    const a = nextAction(CONFIG, { attempts: 1 }, { kind: "quota" }, now);
    if (a.action !== "reschedule") throw new Error("unreachable");
    expect(a.runAtMs).toBe(now + CONFIG.quotaCooloffMs);
    expect(a.refundAttempt).toBe(true);
  });

  it("parks immediately on a poison error", () => {
    const a = nextAction(CONFIG, { attempts: 1 }, { kind: "poison", error: "boom" }, now);
    expect(a.action).toBe("park");
  });

  it("retries with exponential backoff below the attempt cap", () => {
    const a = nextAction(CONFIG, { attempts: 1 }, { kind: "error", error: "flaky" }, now);
    if (a.action !== "reschedule") throw new Error("unreachable");
    expect(a.runAtMs).toBe(now + CONFIG.backoffBaseMs); // 2^0
    const b = nextAction(CONFIG, { attempts: 2 }, { kind: "error", error: "flaky" }, now);
    if (b.action !== "reschedule") throw new Error("unreachable");
    expect(b.runAtMs).toBe(now + CONFIG.backoffBaseMs * 2); // 2^1
  });

  it("parks (poison-pill) once attempts reach maxAttempts", () => {
    const a = nextAction(CONFIG, { attempts: 3 }, { kind: "error", error: "still broken" }, now);
    expect(a.action).toBe("park");
  });
});

describe("JobRunner (live, in-memory db)", () => {
  let tdb: TestDb;
  let clock: FakeClock;

  beforeEach(() => {
    tdb = makeTestDb();
    clock = new FakeClock(1_700_000_000_000);
  });
  afterEach(() => tdb.close());

  function runner(handler: JobHandler, extra?: Partial<RunnerConfig>) {
    const r = new JobRunner({ db: tdb.db, clock, config: { ...CONFIG, ...extra } });
    r.registerHandler("execute-epic", handler);
    return r;
  }

  /** A runner with an injected per-project policy resolver + a roomy global ceiling. */
  function policyRunner(
    handler: JobHandler,
    resolvePolicy: JobPolicyResolver,
    extra?: Partial<RunnerConfig>,
  ) {
    const r = new JobRunner({
      db: tdb.db,
      clock,
      config: { ...CONFIG, maxConcurrent: 5, ...extra },
      resolvePolicy,
    });
    r.registerHandler("execute-epic", handler);
    return r;
  }

  const policy = (over: Partial<JobPolicy> = {}): JobPolicy => ({
    concurrency: 1,
    timeoutMs: Infinity,
    maxAttempts: 3,
    ...over,
  });

  /** Seed project rows so jobs.project_id FK is satisfied when a test scopes jobs to a project. */
  async function seedProjects(...ids: string[]) {
    const schema = await import("../db/schema");
    for (const id of ids) {
      await tdb.db
        .insert(schema.projects)
        .values({ id, slug: id.toLowerCase(), name: id, repoPath: `/tmp/${id}` });
    }
  }

  it("runs a queued job to completion", async () => {
    let ran = 0;
    const r = runner(async () => {
      ran += 1;
    });
    const id = await r.enqueue({ type: "execute-epic", payload: { a: 1 } });
    const processed = await r.tickOnce();
    expect(processed).toBe(1);
    expect(ran).toBe(1);
    const job = await getJob(tdb.db, id);
    expect(job?.status).toBe("done");
    expect(job?.attempts).toBe(1);
  });

  it("hands the handler its parsed payload + attempt number", async () => {
    let seen: unknown;
    let attempt = -1;
    const r = runner(async (ctx) => {
      seen = ctx.payload;
      attempt = ctx.attempt;
    });
    await r.enqueue({ type: "execute-epic", payload: { epicBeadId: "e-1" } });
    await r.tickOnce();
    expect(seen).toEqual({ epicBeadId: "e-1" });
    expect(attempt).toBe(1);
  });

  it("parks a quota hit past the reset window and refunds the attempt (park + reschedule)", async () => {
    const resetAt = Math.floor(clock.now() / 1000) + 3600;
    const r = runner(async () => {
      throw new UsageLimitError("Claude AI usage limit reached", resetAt);
    });
    const id = await r.enqueue({ type: "execute-epic" });
    await r.tickOnce();
    const job = await getJob(tdb.db, id);
    expect(job?.status).toBe("queued"); // rescheduled, will auto-resume
    expect(job?.attempts).toBe(0); // attempt refunded — quota isn't the job's fault
    expect(toMs(job?.runAt)).toBe(resetAt * 1000);
    expect(job?.lastError).toMatch(/usage-limit/);

    // Not due yet → not picked up.
    expect(await r.tickOnce()).toBe(0);
    // After the reset window it runs again.
    clock.set(resetAt * 1000 + 1);
    let ranAfter = false;
    r.registerHandler("execute-epic", async () => {
      ranAfter = true;
    });
    expect(await r.tickOnce()).toBe(1);
    expect(ranAfter).toBe(true);
  });

  it("reclaims a crashed (lease-expired) running job on the next tick", async () => {
    // Seed a job stuck in `running` with an expired lease — simulating a crash mid-run.
    const id = await tdb.db
      .insert((await import("../db/schema")).jobs)
      .values({
        id: "stuck-1",
        type: "execute-epic",
        status: "running",
        runAt: new Date(clock.now() - 100_000),
        leaseExpiresAt: new Date(clock.now() - 50_000), // already expired
        attempts: 1,
      })
      .returning({ id: (await import("../db/schema")).jobs.id })
      .then((rows) => rows[0].id);

    let ran = false;
    const r = runner(async () => {
      ran = true;
    });
    const processed = await r.tickOnce();
    expect(processed).toBe(1);
    expect(ran).toBe(true);
    const job = await getJob(tdb.db, id);
    expect(job?.status).toBe("done");
    expect(job?.attempts).toBe(2); // reclaim counted as a new attempt
  });

  it("retries then poison-pill parks a persistently failing job after maxAttempts", async () => {
    const r = runner(
      async () => {
        throw new Error("always fails");
      },
      { maxAttempts: 3, backoffBaseMs: 1_000 },
    );
    const id = await r.enqueue({ type: "execute-epic" });

    // Attempt 1 → reschedule (backoff 1s)
    await r.tickOnce();
    let job = await getJob(tdb.db, id);
    expect(job?.status).toBe("queued");
    expect(job?.attempts).toBe(1);

    // Advance past backoff, attempt 2 → reschedule (backoff 2s)
    clock.advance(2_000);
    await r.tickOnce();
    job = await getJob(tdb.db, id);
    expect(job?.status).toBe("queued");
    expect(job?.attempts).toBe(2);

    // Advance past backoff, attempt 3 → maxAttempts reached → park
    clock.advance(5_000);
    await r.tickOnce();
    job = await getJob(tdb.db, id);
    expect(job?.status).toBe("parked");
    expect(job?.attempts).toBe(3);
    expect(job?.lastError).toMatch(/failed 3/);

    // Parked jobs are not picked up again.
    clock.advance(1_000_000);
    expect(await r.tickOnce()).toBe(0);
  });

  it("parks immediately on PoisonError without exhausting attempts", async () => {
    const r = runner(async () => {
      throw new PoisonError("unrecoverable");
    });
    const id = await r.enqueue({ type: "execute-epic" });
    await r.tickOnce();
    const job = await getJob(tdb.db, id);
    expect(job?.status).toBe("parked");
    expect(job?.attempts).toBe(1);
    expect(job?.lastError).toMatch(/poison/);
  });

  it("respects maxConcurrent", async () => {
    let concurrent = 0;
    let peak = 0;
    const r = runner(
      async () => {
        concurrent += 1;
        peak = Math.max(peak, concurrent);
        await new Promise((res) => setTimeout(res, 20));
        concurrent -= 1;
      },
      { maxConcurrent: 2 },
    );
    for (let i = 0; i < 5; i++) await r.enqueue({ type: "execute-epic" });
    await r.tickOnce();
    expect(peak).toBeLessThanOrEqual(2);
  });

  it("gates execute-epic concurrency per project (not globally)", async () => {
    // Concurrency 1 per project, roomy global ceiling. Two epics for A + one for B are due; a
    // single tick may lease only one A (its cap) and one B — the second A stays queued.
    await seedProjects("A", "B");
    const r = policyRunner(async () => {}, () => policy({ concurrency: 1 }));
    await r.enqueue({ type: "execute-epic", projectId: "A", payload: { n: 1 } });
    await r.enqueue({ type: "execute-epic", projectId: "A", payload: { n: 2 } });
    await r.enqueue({ type: "execute-epic", projectId: "B", payload: { n: 3 } });

    const processed = await r.tickOnce();
    expect(processed).toBe(2); // one A + one B, not both A's

    const schema = await import("../db/schema");
    const rows = await tdb.db.select().from(schema.jobs);
    const queuedA = rows.filter(
      (j) => j.projectId === "A" && j.status === "queued",
    );
    expect(queuedA).toHaveLength(1); // the over-cap A job was left for a later tick
  });

  it("aborts a job that exceeds its per-project timeout and retries it", async () => {
    // Handler blocks until aborted; a 20ms timeout fires, aborts it → retryable 'timed out' error.
    const r = policyRunner(
      (ctx) =>
        new Promise<void>((_resolve, reject) => {
          if (ctx.signal.aborted) return reject(new Error("aborted"));
          ctx.signal.addEventListener("abort", () => reject(new Error("aborted")));
        }),
      () => policy({ timeoutMs: 20 }),
    );
    await seedProjects("A");
    const id = await r.enqueue({ type: "execute-epic", projectId: "A" });

    await r.tickOnce();
    const job = await getJob(tdb.db, id);
    expect(job?.status).toBe("queued"); // rescheduled (attempt 1 < maxAttempts)
    expect(job?.attempts).toBe(1);
    expect(job?.lastError).toMatch(/timed out/);
  });

  it("parks after the project's retry budget (per-project maxAttempts overrides config)", async () => {
    // maxAttempts 1 for this project → a failing job parks on the first attempt, even though the
    // runner config's maxAttempts is 3.
    const r = policyRunner(
      async () => {
        throw new Error("always fails");
      },
      () => policy({ maxAttempts: 1 }),
    );
    await seedProjects("A");
    const id = await r.enqueue({ type: "execute-epic", projectId: "A" });

    await r.tickOnce();
    const job = await getJob(tdb.db, id);
    expect(job?.status).toBe("parked");
    expect(job?.attempts).toBe(1);
    expect(job?.lastError).toMatch(/failed 1/);
  });
});
