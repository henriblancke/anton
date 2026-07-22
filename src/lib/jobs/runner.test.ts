/**
 * Durability tests for the job runner (anton-dzh.1): the pure policy (`nextAction`) and the
 * live loop against a real in-memory anton.db with a controllable clock — lease/reclaim,
 * quota backoff (park + reschedule, attempt refunded), and poison-pill parking after N attempts.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { makeTestDb, type TestDb } from "../db/testing";
import * as schema from "../db/schema";
import { getBurnAverage, recordBurnSample } from "../burn";
import type { ClaudeUsage } from "../claude/usage";
import { PoisonError, RunAlreadyLiveError, UsageLimitError } from "./errors";
import { complete, enqueue, getJob, park, reschedule, toMs, type Clock } from "./queue";
import { DEFAULT_BUDGET_POLICY, type BudgetPolicy } from "./budget";
import {
  classifyError,
  DEFAULT_CONFIG,
  JobRunner,
  nextAction,
  type BeadLabelsReader,
  type BudgetPolicyResolver,
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

  it("reschedules a run-live-elsewhere hit after a cool-off and refunds the attempt (anton-jz1)", () => {
    // A foreign live lease is not this job's failure and the other run may hold it a long time, so
    // the attempt is refunded — it re-checks liveness each cool-off and must never poison-park.
    const a = nextAction(CONFIG, { attempts: 3 }, { kind: "lease-held", error: "live on B" }, now);
    expect(a.action).toBe("reschedule");
    if (a.action !== "reschedule") throw new Error("unreachable");
    expect(a.runAtMs).toBe(now + CONFIG.quotaCooloffMs);
    expect(a.refundAttempt).toBe(true);
  });

  it("classifies RunAlreadyLiveError as a lease-held outcome (anton-jz1)", () => {
    expect(classifyError(new RunAlreadyLiveError("live on B"))).toEqual({
      kind: "lease-held",
      error: "live on B",
    });
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
    await r.whenIdle();
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
    await r.whenIdle();
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
    await r.whenIdle();
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
    await r.whenIdle();
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
    await r.whenIdle();
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
    await r.whenIdle();
    let job = await getJob(tdb.db, id);
    expect(job?.status).toBe("queued");
    expect(job?.attempts).toBe(1);

    // Advance past backoff, attempt 2 → reschedule (backoff 2s)
    clock.advance(2_000);
    await r.tickOnce();
    await r.whenIdle();
    job = await getJob(tdb.db, id);
    expect(job?.status).toBe("queued");
    expect(job?.attempts).toBe(2);

    // Advance past backoff, attempt 3 → maxAttempts reached → park
    clock.advance(5_000);
    await r.tickOnce();
    await r.whenIdle();
    job = await getJob(tdb.db, id);
    expect(job?.status).toBe("parked");
    expect(job?.attempts).toBe(3);
    expect(job?.lastError).toMatch(/failed 3/);

    // Parked jobs are not picked up again.
    clock.advance(1_000_000);
    expect(await r.tickOnce()).toBe(0);
  });

  it("resumes a parked job back to queued with a fresh attempt budget, then runs it to completion", async () => {
    // anton-ner.2: parking must not be a permanent dead end. A transient error exhausts maxAttempts
    // and parks; resume() un-parks it (attempts refunded to 0) and the next tick runs it.
    let attempts = 0;
    const r = runner(
      async () => {
        attempts += 1;
        if (attempts <= 3) throw new Error("transient");
      },
      { maxAttempts: 3, backoffBaseMs: 1_000 },
    );
    const id = await r.enqueue({ type: "execute-epic" });

    // Burn through the retry budget → parked.
    await r.tickOnce();
    await r.whenIdle();
    clock.advance(2_000);
    await r.tickOnce();
    await r.whenIdle();
    clock.advance(5_000);
    await r.tickOnce();
    await r.whenIdle();
    let job = await getJob(tdb.db, id);
    expect(job?.status).toBe("parked");
    expect(job?.attempts).toBe(3);

    // Resume: parked → queued, due now, attempts refunded, lastError cleared.
    expect(await r.resume(id)).toBe(true);
    job = await getJob(tdb.db, id);
    expect(job?.status).toBe("queued");
    expect(job?.attempts).toBe(0);
    expect(job?.lastError).toBeNull();

    // Runs again (4th attempt now succeeds) → done.
    expect(await r.tickOnce()).toBe(1);
    await r.whenIdle();
    job = await getJob(tdb.db, id);
    expect(job?.status).toBe("done");
    expect(attempts).toBe(4);
  });

  it("resume() is a no-op (returns false) for a job that isn't parked", async () => {
    const r = runner(async () => {});
    const id = await r.enqueue({ type: "execute-epic" });
    // queued, not parked → refuse to touch its lifecycle.
    expect(await r.resume(id)).toBe(false);
    expect((await getJob(tdb.db, id))?.status).toBe("queued");
    expect(await r.resume("does-not-exist")).toBe(false);
  });

  it("resume() also un-parks a `failed` (reserved terminal) job (anton-ner.4)", async () => {
    const schema = await import("../db/schema");
    const r = runner(async () => {});
    const id = await r.enqueue({ type: "execute-epic" });
    await tdb.db.update(schema.jobs).set({ status: "failed" }).where(eq(schema.jobs.id, id));
    expect(await r.resume(id)).toBe(true);
    const job = await getJob(tdb.db, id);
    expect(job?.status).toBe("queued");
    expect(job?.attempts).toBe(0);
  });

  it("cancel() aborts the in-flight job, terminalizes it, and no durability path revives it (anton-a4jj)", async () => {
    // The core force-kill: abort the child AND mark the row terminal so the aborted handler's settle
    // (an AbortError classifies as a retryable `error`) can't reschedule it back to `queued`.
    let sawAbort = false;
    const r = runner(async (ctx) => {
      await new Promise<void>((resolveWait) => {
        ctx.signal.addEventListener("abort", () => {
          sawAbort = true;
          resolveWait();
        });
      });
    });
    const id = await r.enqueue({ type: "execute-epic" });
    expect(await r.tickOnce()).toBe(1);
    await waitUntil(() => r.activeCount === 1);

    expect(await r.cancel(id)).toBe(true);
    await r.whenIdle();

    expect(sawAbort).toBe(true);
    const job = await getJob(tdb.db, id);
    expect(job?.status).toBe("cancelled"); // NOT rescheduled by the aborted handler's settle
    expect(job?.leaseExpiresAt).toBeNull();

    // No re-lease even past the lease window, and resume refuses it.
    clock.advance(CONFIG.leaseMs * 2);
    expect(await r.tickOnce()).toBe(0);
    expect((await getJob(tdb.db, id))?.status).toBe("cancelled");
    expect(await r.resume(id)).toBe(false);
  });

  it("cancel() terminalizes a queued job so it is never leased (anton-a4jj)", async () => {
    const r = runner(async () => {});
    const id = await r.enqueue({ type: "execute-epic" });
    expect(await r.cancel(id)).toBe(true);
    expect((await getJob(tdb.db, id))?.status).toBe("cancelled");
    expect(await r.tickOnce()).toBe(0); // never dispatched
  });

  it("cancel() terminalizes a running row with no local controller so reclaim can't re-run it (anton-a4jj)", async () => {
    // A `running` row leased by a since-restarted process: the lease is still held and THIS runner
    // holds no in-flight controller. Cancel must still write the row terminal.
    const schema = await import("../db/schema");
    const r = runner(async () => {});
    await tdb.db.insert(schema.jobs).values({
      id: "leased-elsewhere",
      type: "execute-epic",
      status: "running",
      runAt: new Date(clock.now() - 1_000),
      leaseExpiresAt: new Date(clock.now() + CONFIG.leaseMs),
      attempts: 1,
    });

    expect(await r.cancel("leased-elsewhere")).toBe(true);
    expect((await getJob(tdb.db, "leased-elsewhere"))?.status).toBe("cancelled");

    // Past the original lease, lease-expiry reclaim never re-dispatches it.
    clock.advance(CONFIG.leaseMs * 2);
    expect(await r.tickOnce()).toBe(0);
    expect((await getJob(tdb.db, "leased-elsewhere"))?.status).toBe("cancelled");
  });

  it("cancel() is a safe no-op on an already-terminal job and reports whether it acted (anton-a4jj)", async () => {
    const r = runner(async () => {});
    const done = await r.enqueue({ type: "execute-epic" });
    await r.tickOnce();
    await r.whenIdle();
    expect((await getJob(tdb.db, done))?.status).toBe("done");
    expect(await r.cancel(done)).toBe(false); // already terminal — untouched
    expect((await getJob(tdb.db, done))?.status).toBe("done");

    // A second cancel of an already-cancelled job is a no-op; an unknown id too.
    const q = await r.enqueue({ type: "execute-epic" });
    expect(await r.cancel(q)).toBe(true);
    expect(await r.cancel(q)).toBe(false);
    expect(await r.cancel("does-not-exist")).toBe(false);
  });

  it("cancel() wins when a stale settlement tries to transition the job afterward", async () => {
    const transitions = [
      (id: string) => complete(tdb.db, clock, id),
      (id: string) => reschedule(tdb.db, clock, id, clock.now() + 1_000),
      (id: string) => park(tdb.db, clock, id, "stale failure"),
    ];

    for (const transition of transitions) {
      const r = runner(async () => {});
      const id = await r.enqueue({ type: "execute-epic" });
      await tdb.db
        .update(schema.jobs)
        .set({ status: "running", leaseExpiresAt: new Date(clock.now() + CONFIG.leaseMs) })
        .where(eq(schema.jobs.id, id));

      expect(await r.cancel(id)).toBe(true);
      await transition(id);
      expect((await getJob(tdb.db, id))?.status).toBe("cancelled");
    }
  });

  it("reconcile() reclaims orphaned running jobs and fails only truly-orphaned runs (anton-nbd)", async () => {
    const schema = await import("../db/schema");
    await seedProjects("A", "B");
    const nowMs = clock.now();

    // A running execute-epic job whose lease has NOT yet expired — a crash left it in flight. Its
    // run must be kept (the job is about to be re-dispatched), and reconcile must clear its lease so
    // the next tick reclaims it immediately instead of waiting out leaseMs.
    const liveJobId = await tdb.db
      .insert(schema.jobs)
      .values({
        id: "job-live",
        type: "execute-epic",
        projectId: "A",
        payloadJson: JSON.stringify({ projectId: "A", epicBeadId: "epic-live" }),
        status: "running",
        runAt: new Date(nowMs - 1_000),
        leaseExpiresAt: new Date(nowMs + 50_000), // not expired — only reconcile can free it
        attempts: 1,
      })
      .returning({ id: schema.jobs.id })
      .then((rows) => rows[0].id);

    // Its run row — must survive reconciliation (the job resumes and reuses it).
    await tdb.db.insert(schema.runs).values({
      id: "run-live",
      projectId: "A",
      epicBeadId: "epic-live",
      status: "running",
      startedAt: new Date(nowMs),
      updatedAt: new Date(nowMs),
    });

    // An orphaned run: stuck `running` with NO execute-epic job for its epic → nothing will resume
    // it, so reconcile must mark it failed.
    await tdb.db.insert(schema.runs).values({
      id: "run-orphan",
      projectId: "B",
      epicBeadId: "epic-dead",
      status: "running",
      startedAt: new Date(nowMs),
      updatedAt: new Date(nowMs),
    });

    let ran = false;
    const r = runner(async () => {
      ran = true;
    });
    const res = await r.reconcile();
    expect(res.reclaimedJobs).toBe(1);
    expect(res.reconciledRuns).toBe(1);

    // The live job kept its `running` status but its lease was expired (≤ now) → reclaimable.
    const job = await getJob(tdb.db, liveJobId);
    expect(job?.status).toBe("running");
    expect(toMs(job?.leaseExpiresAt)!).toBeLessThanOrEqual(nowMs);

    const runsRows = await tdb.db.select().from(schema.runs);
    expect(runsRows.find((x) => x.id === "run-live")?.status).toBe("running"); // kept
    const orphan = runsRows.find((x) => x.id === "run-orphan");
    expect(orphan?.status).toBe("failed"); // reconciled
    expect(orphan?.error).toMatch(/interrupted/);

    // The reclaimed job is re-dispatched on the very next tick.
    expect(await r.tickOnce()).toBe(1);
    await r.whenIdle();
    expect(ran).toBe(true);
  });

  it("reschedules a quota hit past the attempt cap — a quota error NEVER parks", async () => {
    // anton-ner.2 AC: even when attempts already reached maxAttempts, a UsageLimitError reschedules
    // (attempt refunded) rather than parking — you can't retry an exhausted quota, so it isn't the
    // job's fault and must not count against the poison budget.
    const resetAt = Math.floor(clock.now() / 1000) + 3600;
    const r = runner(
      async () => {
        throw new UsageLimitError("Claude AI usage limit reached", resetAt);
      },
      { maxAttempts: 1 }, // one attempt → would park a plain error immediately
    );
    const id = await r.enqueue({ type: "execute-epic" });

    await r.tickOnce();
    await r.whenIdle();
    const job = await getJob(tdb.db, id);
    expect(job?.status).toBe("queued"); // rescheduled, never parked
    expect(job?.attempts).toBe(0); // attempt refunded despite the cap
    expect(toMs(job?.runAt)).toBe(resetAt * 1000);
  });

  it("parks immediately on PoisonError without exhausting attempts", async () => {
    const r = runner(async () => {
      throw new PoisonError("unrecoverable");
    });
    const id = await r.enqueue({ type: "execute-epic" });
    await r.tickOnce();
    await r.whenIdle();
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
    // One tick leases only up to the global cap (2); the rest stay queued.
    expect(await r.tickOnce()).toBe(2);
    await r.whenIdle();
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
    await r.whenIdle();
    expect(processed).toBe(2); // one A + one B, not both A's

    const schema = await import("../db/schema");
    const rows = await tdb.db.select().from(schema.jobs);
    const queuedA = rows.filter(
      (j) => j.projectId === "A" && j.status === "queued",
    );
    expect(queuedA).toHaveLength(1); // the over-cap A job was left for a later tick
  });

  it("autonomy off gates claiming: execute-epic stays queued, and re-enabling resumes it (anton-y3l)", async () => {
    // The autonomy master-switch gates at *claim*: approval-style enqueues still land, but no
    // tick leases the job while the switch is off; flipping it back on resumes on the next tick.
    await seedProjects("A");
    let autonomy = false;
    let ran = 0;
    const r = policyRunner(
      async () => {
        ran += 1;
      },
      () => policy({ autonomy }),
    );
    const id = await r.enqueue({ type: "execute-epic", projectId: "A" });

    expect(await r.tickOnce()).toBe(0); // never claimed while the switch is off
    await r.whenIdle();
    expect(ran).toBe(0);
    let job = await getJob(tdb.db, id);
    expect(job?.status).toBe("queued"); // enqueued but not running — no attempt burned
    expect(job?.attempts).toBe(0);

    autonomy = true; // operator flips the switch back on
    expect(await r.tickOnce()).toBe(1);
    await r.whenIdle();
    expect(ran).toBe(1);
    job = await getJob(tdb.db, id);
    expect(job?.status).toBe("done");
  });

  it("autonomy off leaves in-flight work untouched and gates only new claims (anton-y3l)", async () => {
    // A job already leased keeps running to completion after the switch turns off; only the
    // not-yet-claimed job is held back.
    await seedProjects("A");
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let autonomy = true;
    const r = policyRunner(
      async () => {
        await gate;
      },
      () => policy({ concurrency: 2, autonomy }),
    );
    const inFlightId = await r.enqueue({ type: "execute-epic", projectId: "A", payload: { n: 1 } });
    expect(await r.tickOnce()).toBe(1); // leased + dispatched while autonomy is on
    expect(r.activeCount).toBe(1);

    autonomy = false; // switch off with the first job mid-run
    const heldId = await r.enqueue({ type: "execute-epic", projectId: "A", payload: { n: 2 } });
    expect(await r.tickOnce()).toBe(0); // the new job is not claimed
    expect((await getJob(tdb.db, heldId))?.status).toBe("queued");
    expect((await getJob(tdb.db, inFlightId))?.status).toBe("running"); // untouched

    release(); // the in-flight job finishes normally despite the switch being off
    await r.whenIdle();
    expect((await getJob(tdb.db, inFlightId))?.status).toBe("done");
    expect((await getJob(tdb.db, heldId))?.status).toBe("queued"); // still waiting on the switch
  });

  /** Seed a schedule row (defaults to disabled) so its jobs can be gated at claim. */
  async function seedSchedule(
    projectId: string,
    type: string,
    over: { enabled?: boolean } = {},
  ) {
    await tdb.db.insert(schema.schedules).values({
      id: `sched-${type}-${projectId}`,
      projectId,
      type,
      cron: "*/15 * * * *",
      enabled: over.enabled ?? false,
    });
  }

  it("disabling a schedule gates claiming: a queued review-fix stays queued (anton-7l7)", async () => {
    // Mirrors the scheduler's "skips disabled schedules" but at the runner/dispatch layer — a job
    // already sitting in `queued` (or backoff/quota-rescheduled) is NOT leased while its schedule is
    // off. Uses a plain runner (no policy resolver) to prove the gate is independent of autonomy.
    await seedProjects("A");
    await seedSchedule("A", "review-fix", { enabled: false });
    let ran = 0;
    const r = new JobRunner({ db: tdb.db, clock, config: CONFIG });
    r.registerHandler("review-fix", async () => {
      ran += 1;
    });
    const id = await r.enqueue({ type: "review-fix", projectId: "A" });

    expect(await r.tickOnce()).toBe(0); // schedule disabled → never leased
    await r.whenIdle();
    expect(ran).toBe(0);
    let job = await getJob(tdb.db, id);
    expect(job?.status).toBe("queued"); // still queued — no attempt burned
    expect(job?.attempts).toBe(0);

    // Re-enable the schedule → the still-queued job resumes on the next tick.
    await tdb.db
      .update(schema.schedules)
      .set({ enabled: true })
      .where(eq(schema.schedules.id, "sched-review-fix-A"));
    expect(await r.tickOnce()).toBe(1);
    await r.whenIdle();
    expect(ran).toBe(1);
    job = await getJob(tdb.db, id);
    expect(job?.status).toBe("done");
  });

  it("gates every scheduled job type, and a disabled schedule doesn't starve execute-epic (anton-7l7)", async () => {
    // The gate is keyed on (type, project): a disabled review-fix schedule holds its own job back
    // but leaves the same project's execute-epic dispatch (autonomy on) untouched.
    await seedProjects("A");
    await seedSchedule("A", "review-fix", { enabled: false });
    let reviewRan = 0;
    let epicRan = 0;
    const r = new JobRunner({
      db: tdb.db,
      clock,
      config: { ...CONFIG, maxConcurrent: 5 },
      resolvePolicy: () => policy({ concurrency: 2, autonomy: true }),
    });
    r.registerHandler("review-fix", async () => {
      reviewRan += 1;
    });
    r.registerHandler("execute-epic", async () => {
      epicRan += 1;
    });
    const reviewId = await r.enqueue({ type: "review-fix", projectId: "A" });
    await r.enqueue({ type: "execute-epic", projectId: "A", payload: { n: 1 } });

    expect(await r.tickOnce()).toBe(1); // only the execute-epic job — review-fix is gated off
    await r.whenIdle();
    expect(reviewRan).toBe(0);
    expect(epicRan).toBe(1);
    expect((await getJob(tdb.db, reviewId))?.status).toBe("queued");
  });

  it("a large disabled-schedule backlog doesn't starve leasable work past the scan window (anton-7l7)", async () => {
    // Regression: disabled jobs sort earliest by runAt, so before the SQL-level bucket exclusion they
    // filled leaseDue's finite scan window (max(limit*8, 200)) every tick; the cap-0 skip then left a
    // leasable job sorting AFTER them permanently unreachable — enabled schedules and other projects
    // stalled until the disabled ones were re-enabled or removed. Excluding held buckets in the query
    // paginates past the backlog so leasable work is still reached.
    await seedProjects("A", "B");
    await seedSchedule("A", "review-fix", { enabled: false });

    // 250 disabled review-fix jobs (> the 200-row scan window) as the earliest-by-runAt prefix.
    const backlogAt = new Date(clock.now() - 10_000);
    await tdb.db.insert(schema.jobs).values(
      Array.from({ length: 250 }, (_, i) => ({
        id: `held-${i}`,
        type: "review-fix" as const,
        projectId: "A",
        status: "queued" as const,
        runAt: backlogAt,
        attempts: 0,
      })),
    );
    // One leasable execute-epic (autonomy on) for another project, sorted AFTER the whole backlog.
    await tdb.db.insert(schema.jobs).values({
      id: "leasable",
      type: "execute-epic",
      projectId: "B",
      status: "queued",
      runAt: new Date(clock.now() - 1_000),
      attempts: 0,
    });

    let epicRan = 0;
    const r = new JobRunner({
      db: tdb.db,
      clock,
      config: { ...CONFIG, maxConcurrent: 5 },
      resolvePolicy: () => policy({ concurrency: 2, autonomy: true }),
    });
    r.registerHandler("review-fix", async () => {});
    r.registerHandler("execute-epic", async () => {
      epicRan += 1;
    });

    expect(await r.tickOnce()).toBe(1); // reaches past the 250 held jobs to lease the execute-epic
    await r.whenIdle();
    expect(epicRan).toBe(1);
    expect((await getJob(tdb.db, "leasable"))?.status).toBe("done");
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
    await r.whenIdle();
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
    await r.whenIdle();
    const job = await getJob(tdb.db, id);
    expect(job?.status).toBe("parked");
    expect(job?.attempts).toBe(1);
    expect(job?.lastError).toMatch(/failed 1/);
  });

  it("leases and settles a fast job while a long job is still in flight (rolling dispatch)", async () => {
    // The core parallel-sessions fix: a long job in flight must not block the next lease.
    let releaseSlow!: () => void;
    const slowGate = new Promise<void>((resolve) => {
      releaseSlow = resolve;
    });
    let slowFinished = false;
    let fastFinished = false;

    const r = new JobRunner({ db: tdb.db, clock, config: { ...CONFIG, maxConcurrent: 5 } });
    r.registerHandler("execute-epic", async (ctx) => {
      if ((ctx.payload as { slow?: boolean }).slow) {
        await slowGate;
        slowFinished = true;
      } else {
        fastFinished = true;
      }
    });

    const slowId = await r.enqueue({ type: "execute-epic", payload: { slow: true } });
    // Tick leases + dispatches the slow job without awaiting it.
    expect(await r.tickOnce()).toBe(1);
    expect(r.activeCount).toBe(1);

    // A job enqueued while the slow one is still running is leased on the very next tick…
    const fastId = await r.enqueue({ type: "execute-epic", payload: { slow: false } });
    expect(await r.tickOnce()).toBe(1);

    // …and settles to `done` before the slow job finishes.
    await waitUntil(async () => (await getJob(tdb.db, fastId))?.status === "done");
    expect(fastFinished).toBe(true);
    expect(slowFinished).toBe(false); // slow job is still blocked in flight
    expect((await getJob(tdb.db, slowId))?.status).toBe("running");
    expect(r.activeCount).toBe(1); // only the slow job remains in flight

    // Release the slow job and drain: it settles too.
    releaseSlow();
    await r.whenIdle();
    expect(slowFinished).toBe(true);
    expect((await getJob(tdb.db, slowId))?.status).toBe("done");
    expect(r.activeCount).toBe(0);
  });

  it("never oversubscribes global capacity across rolling ticks", async () => {
    // Six jobs, global cap 2, each blocked in flight. No tick may push the in-flight set past 2.
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let peak = 0;
    const r = new JobRunner({ db: tdb.db, clock, config: { ...CONFIG, maxConcurrent: 2 } });
    r.registerHandler("execute-epic", async () => {
      peak = Math.max(peak, r.activeCount);
      await gate;
    });
    for (let i = 0; i < 6; i++) await r.enqueue({ type: "execute-epic" });

    // First tick fills the two slots; while they stay in flight, later ticks lease nothing.
    expect(await r.tickOnce()).toBe(2);
    expect(await r.tickOnce()).toBe(0);
    expect(await r.tickOnce()).toBe(0);
    expect(r.activeCount).toBe(2);
    expect(peak).toBeLessThanOrEqual(2);

    // Drain the two in flight; the remaining four are picked up two-at-a-time on later ticks.
    release();
    await r.whenIdle();
    expect(peak).toBeLessThanOrEqual(2);
    expect(await r.tickOnce()).toBe(2);
    await r.whenIdle();
    expect(await r.tickOnce()).toBe(2);
    await r.whenIdle();
    expect(await r.tickOnce()).toBe(0); // all six done
  });

  it("never re-leases an in-flight job whose lease has lapsed (rolling dispatch, anton-ner)", async () => {
    // A long job stays in `inFlight` while its handler works. If its lease lapses mid-flight (a
    // missed renewal from laptop sleep or a transient DB failure) its `running` row looks
    // reclaimable — but a spare-capacity tick must NOT dispatch it a second time against the same
    // worktree. leaseDue excludes the runner's in-flight ids, so nothing is leased.
    let starts = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const r = new JobRunner({ db: tdb.db, clock, config: { ...CONFIG, maxConcurrent: 5 } });
    r.registerHandler("execute-epic", async () => {
      starts += 1;
      await gate;
    });

    const id = await r.enqueue({ type: "execute-epic" });
    expect(await r.tickOnce()).toBe(1);
    await waitUntil(() => starts === 1); // handler is genuinely in flight
    expect(r.activeCount).toBe(1);

    // Let the lease lapse while the handler is still blocked in flight.
    clock.advance(CONFIG.leaseMs + 1);

    // Spare capacity + a reclaimable-looking row, yet the in-flight job is excluded → nothing leased.
    expect(await r.tickOnce()).toBe(0);
    expect(await r.tickOnce()).toBe(0);
    expect(r.activeCount).toBe(1); // still just the one handler
    expect(starts).toBe(1); // handler never re-entered

    // Its lease/attempts weren't overwritten by a phantom re-lease.
    const stillRunning = await getJob(tdb.db, id);
    expect(stillRunning?.status).toBe("running");
    expect(stillRunning?.attempts).toBe(1);

    // Drain: releasing the gate lets the single handler settle to done.
    release();
    await r.whenIdle();
    expect((await getJob(tdb.db, id))?.status).toBe("done");
  });

  it("abortProject force-aborts the in-flight job and removes the project's queued/running rows (anton-adt)", async () => {
    await seedProjects("A", "B");
    let sawAbort = false;
    const r = runner(async (ctx) => {
      // Block until force-aborted — a stand-in for a long execute-epic run.
      await new Promise<void>((resolveWait) => {
        ctx.signal.addEventListener("abort", () => {
          sawAbort = true;
          resolveWait();
        });
      });
    });

    const inFlightId = await r.enqueue({ type: "execute-epic", projectId: "A" });
    expect(await r.tickOnce()).toBe(1);
    await waitUntil(() => r.activeCount === 1);

    // Queued work for the doomed project + an innocent bystander project.
    const queuedId = await r.enqueue({ type: "execute-epic", projectId: "A" });
    const otherId = await r.enqueue({ type: "execute-epic", projectId: "B" });

    await r.abortProject("A");
    await r.whenIdle();

    expect(sawAbort).toBe(true);
    expect(r.activeCount).toBe(0);
    // No orphaned lease survives: the project's active rows are gone entirely.
    expect(await getJob(tdb.db, inFlightId)).toBeUndefined();
    expect(await getJob(tdb.db, queuedId)).toBeUndefined();
    // The other project's work is untouched.
    expect((await getJob(tdb.db, otherId))?.status).toBe("queued");
  });

  it("abortProject is a safe no-op for a project with no active jobs and leaves settled rows alone", async () => {
    await seedProjects("A");
    const r = runner(async () => {});
    const id = await r.enqueue({ type: "execute-epic", projectId: "A" });
    await r.tickOnce();
    await r.whenIdle();

    await expect(r.abortProject("A")).resolves.toBeUndefined();
    // Settled (done) rows are the caller's to delete, not abortProject's.
    expect((await getJob(tdb.db, id))?.status).toBe("done");
  });

  it("quiesceProject rejects new enqueue/resume work and never leases the project again", async () => {
    await seedProjects("A", "B");
    const r = runner(async () => {});
    const parked = await r.enqueue({ type: "execute-epic", projectId: "A" });
    await tdb.db.update(schema.jobs).set({ status: "parked" }).where(eq(schema.jobs.id, parked));

    await r.quiesceProject("A");

    await expect(r.enqueue({ type: "review-fix", projectId: "A" })).rejects.toThrow(
      /being deleted/,
    );
    await expect(r.enqueueExecuteEpic("A", "epic-race")).rejects.toThrow(/being deleted/);
    await expect(r.resume(parked)).resolves.toBe(false);
    const bypassed = await enqueue(tdb.db, clock, { type: "review-fix", projectId: "A" });
    const other = await r.enqueue({ type: "execute-epic", projectId: "B" });
    expect(await r.tickOnce()).toBe(1);
    await r.whenIdle();
    expect((await getJob(tdb.db, bypassed))?.status).toBe("queued");
    expect((await getJob(tdb.db, other))?.status).toBe("done");
  });
});

describe("JobRunner per-job burn sampling (anton-w8ny)", () => {
  let tdb: TestDb;
  let clock: FakeClock;
  beforeEach(() => {
    tdb = makeTestDb();
    clock = new FakeClock(1_700_000_000_000);
  });
  afterEach(() => tdb.close());

  const usage = (sessionPct: number, weeklyPct: number): ClaudeUsage => ({
    sessionPct,
    weeklyPct,
    sessionResetAt: null,
    weeklyResetAt: null,
    plan: "max",
  });

  // Burn sampling is gated behind the budget-aware opt-in (anton-7mpv.1) — these tests wire a
  // resolver that opts every project in; the feature-off tests below omit it.
  const budgetAware: BudgetPolicyResolver = () => DEFAULT_BUDGET_POLICY;

  it("persists the session%/weekly% delta across a job, attributed to its type", async () => {
    // Pre-job snapshot via the cached read, post-job via the FRESH (TTL-bypassing) read:
    // 10%→30% session, 5%→8% weekly.
    const r = new JobRunner({
      db: tdb.db,
      clock,
      config: CONFIG,
      resolveBudgetPolicy: budgetAware,
      readUsage: async () => usage(10, 5),
      readUsageFresh: async () => usage(30, 8),
    });
    r.registerHandler("execute-epic", async () => {});
    await r.enqueue({ type: "execute-epic" });
    await r.tickOnce();
    await r.whenIdle();

    const avg = await getBurnAverage(tdb.db, "execute-epic", 1);
    expect(avg.seeded).toBe(false);
    expect(avg.sessionAvg).toBe(20);
    expect(avg.weeklyAvg).toBe(3);
  });

  it("closes the window with the fresh read, never the cached one (anti zero-delta)", async () => {
    // A cached after-read inside the TTL returns the same snapshot as the before-read → a bogus
    // 0% delta. The sampler must go through the fresh reader for the closing measurement.
    let freshCalls = 0;
    const r = new JobRunner({
      db: tdb.db,
      clock,
      config: CONFIG,
      resolveBudgetPolicy: budgetAware,
      readUsage: async () => usage(10, 5), // the stale cache entry, before AND after
      readUsageFresh: async () => {
        freshCalls += 1;
        return usage(25, 7);
      },
    });
    r.registerHandler("execute-epic", async () => {});
    await r.enqueue({ type: "execute-epic" });
    await r.tickOnce();
    await r.whenIdle();

    expect(freshCalls).toBe(1);
    const avg = await getBurnAverage(tdb.db, "execute-epic", 1);
    expect(avg.sessionAvg).toBe(15); // 25 − 10, not the cached self-subtraction's 0
  });

  it("records NO sample on a null usage read and still completes the job", async () => {
    const r = new JobRunner({
      db: tdb.db,
      clock,
      config: CONFIG,
      resolveBudgetPolicy: budgetAware,
      readUsage: async () => null,
      readUsageFresh: async () => null,
    });
    r.registerHandler("execute-epic", async () => {});
    const id = await r.enqueue({ type: "execute-epic" });
    await r.tickOnce();
    await r.whenIdle();

    expect((await getJob(tdb.db, id))?.status).toBe("done");
    const rows = await tdb.db.select().from(schema.burnSamples);
    expect(rows).toHaveLength(0);
  });

  it("never fails a job when the usage read throws", async () => {
    const boom = async (): Promise<ClaudeUsage | null> => {
      throw new Error("usage endpoint down");
    };
    const r = new JobRunner({
      db: tdb.db,
      clock,
      config: CONFIG,
      resolveBudgetPolicy: budgetAware,
      readUsage: boom,
      readUsageFresh: boom,
    });
    r.registerHandler("execute-epic", async () => {});
    const id = await r.enqueue({ type: "execute-epic" });
    await r.tickOnce();
    await r.whenIdle();

    expect((await getJob(tdb.db, id))?.status).toBe("done");
    const rows = await tdb.db.select().from(schema.burnSamples);
    expect(rows).toHaveLength(0);
  });

  it("records NO samples for jobs whose windows overlap (attribution needs a solo window)", async () => {
    // Two jobs in flight at once: each window would include the sibling's burn, double-counting
    // across types. Neither may record a sample; a later solo job samples normally again.
    let reads = 0;
    const r = new JobRunner({
      db: tdb.db,
      clock,
      config: { ...CONFIG, maxConcurrent: 2 },
      resolveBudgetPolicy: budgetAware,
      readUsage: async () => usage(10, 5),
      readUsageFresh: async () => {
        reads += 1;
        return usage(30, 8);
      },
    });
    r.registerHandler("execute-epic", async () => {});
    r.registerHandler("review-fix", async () => {});
    await r.enqueue({ type: "execute-epic" });
    await r.enqueue({ type: "review-fix" });
    expect(await r.tickOnce()).toBe(2); // both leased into the same tick → overlapping windows
    await r.whenIdle();

    expect(reads).toBe(0); // contaminated windows never even take the closing read
    expect(await tdb.db.select().from(schema.burnSamples)).toHaveLength(0);

    // Solo follow-up job still samples.
    await r.enqueue({ type: "execute-epic" });
    await r.tickOnce();
    await r.whenIdle();
    expect(await tdb.db.select().from(schema.burnSamples)).toHaveLength(1);
  });

  it("never reads usage when the project is not budget-aware (null policy — the feature-off default)", async () => {
    // The opt-in gate (anton-7mpv.1): a resolver that returns null means budget-aware execution is
    // off for the project, so a solo job must not open a burn window — neither the pre-job cached
    // read nor the post-job fresh read may fire (each shells out to credentials and can cache a
    // transient null into the shared cache the nav pill reads).
    let cachedReads = 0;
    let freshReads = 0;
    const r = new JobRunner({
      db: tdb.db,
      clock,
      config: CONFIG,
      resolveBudgetPolicy: () => null,
      readUsage: async () => {
        cachedReads += 1;
        return usage(10, 5);
      },
      readUsageFresh: async () => {
        freshReads += 1;
        return usage(30, 8);
      },
    });
    r.registerHandler("execute-epic", async () => {});
    const id = await r.enqueue({ type: "execute-epic" });
    await r.tickOnce();
    await r.whenIdle();

    expect((await getJob(tdb.db, id))?.status).toBe("done");
    expect(cachedReads).toBe(0);
    expect(freshReads).toBe(0);
    expect(await tdb.db.select().from(schema.burnSamples)).toHaveLength(0);
  });

  it("never reads usage when no budget resolver is wired at all", async () => {
    // Without a resolveBudgetPolicy dep nothing can be budget-aware, so the sampler stays fully off.
    let reads = 0;
    const count = async () => {
      reads += 1;
      return usage(10, 5);
    };
    const r = new JobRunner({
      db: tdb.db,
      clock,
      config: CONFIG,
      readUsage: count,
      readUsageFresh: count,
    });
    r.registerHandler("execute-epic", async () => {});
    await r.enqueue({ type: "execute-epic" });
    await r.tickOnce();
    await r.whenIdle();

    expect(reads).toBe(0);
    expect(await tdb.db.select().from(schema.burnSamples)).toHaveLength(0);
  });
});

describe("JobRunner budget governor admission gate (anton-szld)", () => {
  let tdb: TestDb;
  let clock: FakeClock;
  beforeEach(() => {
    tdb = makeTestDb();
    clock = new FakeClock(1_700_000_000_000);
  });
  afterEach(() => tdb.close());

  async function seedProjects(...ids: string[]) {
    const s = await import("../db/schema");
    for (const id of ids) {
      await tdb.db
        .insert(s.projects)
        .values({ id, slug: id.toLowerCase(), name: id, repoPath: `/tmp/${id}` });
    }
  }

  const usage = (over: Partial<ClaudeUsage> = {}): ClaudeUsage => ({
    sessionPct: 10,
    weeklyPct: 0,
    sessionResetAt: null,
    weeklyResetAt: null,
    plan: "max",
    ...over,
  });

  /** A runner wired with the budget governor: a fixed usage read + a fixed policy for every project. */
  function budgetRunner(
    handler: JobHandler,
    opts: {
      readUsage: () => Promise<ClaudeUsage | null>;
      policy?: BudgetPolicy;
      resolveBudgetPolicy?: BudgetPolicyResolver;
      readBeadLabels?: BeadLabelsReader;
    },
  ) {
    const r = new JobRunner({
      db: tdb.db,
      clock,
      config: { ...CONFIG, maxConcurrent: 5 },
      readUsage: opts.readUsage,
      // Keep the burn sampler off the real endpoint — these tests exercise the governor only.
      readUsageFresh: async () => null,
      resolveBudgetPolicy: opts.resolveBudgetPolicy ?? (() => opts.policy ?? DEFAULT_BUDGET_POLICY),
      readBeadLabels: opts.readBeadLabels,
    });
    for (const type of ["execute-epic", "review-fix", "nightly-stringer", "orphan-grooming"] as const) {
      r.registerHandler(type, handler);
    }
    return r;
  }

  it("defers a tick past the reset boundary: leases nothing and reschedules queued work to retryAt", async () => {
    // Session nearly exhausted (99% ≥ 100 − minSessionHeadroom 5) → session-headroom defer. No known
    // session reset, so retryAt is now + the 5h session window.
    await seedProjects("A");
    let ran = 0;
    const r = budgetRunner(
      async () => {
        ran += 1;
      },
      { readUsage: async () => usage({ sessionPct: 99 }) },
    );
    const id = await r.enqueue({ type: "execute-epic", projectId: "A" });

    expect(await r.tickOnce()).toBe(0); // held — nothing leased
    await r.whenIdle();
    expect(ran).toBe(0);
    const job = await getJob(tdb.db, id);
    expect(job?.status).toBe("queued");
    expect(job?.attempts).toBe(0); // a proactive hold never burns an attempt
    const expectedRetry = Math.floor((clock.now() + DEFAULT_BUDGET_POLICY.sessionWindowMs) / 1000) * 1000;
    expect(toMs(job?.runAt)).toBe(expectedRetry);
    expect(job?.lastError).toMatch(/budget: session-headroom/);
  });

  it("clears stale budget deferrals when a project's budget-aware pacing turns off", async () => {
    // A governed tick pushes the queued job past the session horizon; then the operator flips
    // budgetAware off (resolver → null). leaseDue only scans due rows, so without clearing the
    // governor's own deferrals the job would stay parked until the stale pace boundary — the next
    // tick must pull it back to due-now and lease it.
    await seedProjects("A");
    let budgetAwareOn = true;
    let ran = 0;
    const r = budgetRunner(
      async () => {
        ran += 1;
      },
      {
        readUsage: async () => usage({ sessionPct: 99 }),
        resolveBudgetPolicy: () => (budgetAwareOn ? DEFAULT_BUDGET_POLICY : null),
      },
    );
    const id = await r.enqueue({ type: "execute-epic", projectId: "A" });

    expect(await r.tickOnce()).toBe(0); // governed → deferred to the session horizon
    const deferred = await getJob(tdb.db, id);
    expect(toMs(deferred?.runAt)).toBeGreaterThan(clock.now());
    expect(deferred?.lastError).toMatch(/budget: session-headroom/);

    budgetAwareOn = false; // operator turns pacing off
    expect(await r.tickOnce()).toBe(1); // stale deferral cleared → leases this tick
    await r.whenIdle();
    expect(ran).toBe(1);
    const job = await getJob(tdb.db, id);
    expect(job?.status).toBe("done");
    expect(job?.lastError).toBeNull();
  });

  it("governs the orphan-grooming cleanup sweep, not just execute-epic", async () => {
    await seedProjects("A");
    const r = budgetRunner(async () => {}, { readUsage: async () => usage({ sessionPct: 99 }) });
    const id = await r.enqueue({ type: "orphan-grooming", projectId: "A" });

    expect(await r.tickOnce()).toBe(0);
    const job = await getJob(tdb.db, id);
    expect(job?.status).toBe("queued");
    expect(job?.lastError).toMatch(/budget:/);
  });

  it("does NOT govern review-fix or nightly-stringer — they lease immediately even when budget is scarce (anton-d8i4)", async () => {
    // Session 99% ≥ the floor would defer any governed type, but review-fix / nightly-stringer are
    // off the allowlist: a human's PR-review fix and the fixed nightly scan must not be paced.
    await seedProjects("A");
    let ran = 0;
    const r = budgetRunner(
      async () => {
        ran += 1;
      },
      { readUsage: async () => usage({ sessionPct: 99 }) },
    );
    const rf = await r.enqueue({ type: "review-fix", projectId: "A" });
    const ns = await r.enqueue({ type: "nightly-stringer", projectId: "A" });

    expect(await r.tickOnce()).toBe(2); // both leased despite the scarce budget
    await r.whenIdle();
    expect(ran).toBe(2);
    expect((await getJob(tdb.db, rf))?.status).toBe("done");
    expect((await getJob(tdb.db, ns))?.status).toBe("done");
  });

  it("runs an immediate-approved (bypassBudget) execute-epic while pacing a queued one (anton-d8i4)", async () => {
    // Ahead of the weekly pace-line (weekly-on-track), session fresh: a paced job defers, but an
    // immediate-approved one skips pacing and runs now.
    await seedProjects("A");
    const weeklyResetAt = new Date(clock.now() + 3.5 * 24 * 60 * 60 * 1000).toISOString(); // half-week left
    let ran = 0;
    const r = budgetRunner(
      async () => {
        ran += 1;
      },
      { readUsage: async () => usage({ sessionPct: 10, weeklyPct: 80, weeklyResetAt }) },
    );
    const paced = await r.enqueue({
      type: "execute-epic",
      projectId: "A",
      payload: { projectId: "A", epicBeadId: "A-1" },
    });
    const immediate = await r.enqueue({
      type: "execute-epic",
      projectId: "A",
      payload: { projectId: "A", epicBeadId: "A-2", bypassBudget: true },
    });

    expect(await r.tickOnce()).toBe(1); // only the immediate job leases
    await r.whenIdle();
    expect(ran).toBe(1);
    expect((await getJob(tdb.db, immediate))?.status).toBe("done");
    const pacedJob = await getJob(tdb.db, paced);
    expect(pacedJob?.status).toBe("queued");
    expect(toMs(pacedJob?.runAt)).toBeGreaterThan(clock.now()); // pushed out to the pace boundary
    expect(pacedJob?.lastError).toMatch(/budget: weekly-on-track/);
  });

  it("does NOT reclaim a crashed (lease-expired) paced execute-epic during a paced deferral, while a crashed bypass row reclaims (anton-d8i4)", async () => {
    // Weekly-on-track pacing defers non-bypass work while immediate work admits. deferQueuedJobs
    // only moves `queued` rows, so a paced job that was leased and then crashed sits `running`
    // with an expired lease — it must NOT be reclaimed and restarted ahead of the pace boundary,
    // while a bypass ("Approve") row in the same crashed state reclaims normally.
    await seedProjects("A");
    const s = await import("../db/schema");
    const seedCrashed = async (id: string, payload: object) => {
      await tdb.db.insert(s.jobs).values({
        id,
        type: "execute-epic",
        projectId: "A",
        payloadJson: JSON.stringify(payload),
        status: "running",
        runAt: new Date(clock.now() - 100_000),
        leaseExpiresAt: new Date(clock.now() - 50_000), // already expired — looks reclaimable
        attempts: 1,
      });
    };
    await seedCrashed("crashed-paced", { projectId: "A", epicBeadId: "A-1" });
    await seedCrashed("crashed-bypass", { projectId: "A", epicBeadId: "A-2", bypassBudget: true });

    const weeklyResetAt = new Date(clock.now() + 3.5 * 24 * 60 * 60 * 1000).toISOString();
    let ran = 0;
    const r = budgetRunner(
      async () => {
        ran += 1;
      },
      { readUsage: async () => usage({ sessionPct: 10, weeklyPct: 80, weeklyResetAt }) },
    );

    expect(await r.tickOnce()).toBe(1); // only the bypass row reclaims
    await r.whenIdle();
    expect(ran).toBe(1);
    expect((await getJob(tdb.db, "crashed-bypass"))?.status).toBe("done");
    // The paced row stays un-reclaimed this tick; it resumes when pacing admits again.
    const paced = await getJob(tdb.db, "crashed-paced");
    expect(paced?.status).toBe("running");
    expect(paced?.attempts).toBe(1); // no reclaim → no new attempt burned
  });

  it("still holds an immediate-approved execute-epic at the session-headroom floor (anton-d8i4)", async () => {
    // The session floor is the one hold "Approve" (immediate) does NOT bypass — it protects the tail
    // of the 5h session, so an immediate run can't blow the cap it would only hit mid-run.
    await seedProjects("A");
    let ran = 0;
    const r = budgetRunner(
      async () => {
        ran += 1;
      },
      { readUsage: async () => usage({ sessionPct: 99 }) },
    );
    const id = await r.enqueue({
      type: "execute-epic",
      projectId: "A",
      payload: { projectId: "A", epicBeadId: "A-1", bypassBudget: true },
    });

    expect(await r.tickOnce()).toBe(0); // held by the session floor
    await r.whenIdle();
    expect(ran).toBe(0);
    const job = await getJob(tdb.db, id);
    expect(job?.status).toBe("queued");
    const expectedRetry = Math.floor((clock.now() + DEFAULT_BUDGET_POLICY.sessionWindowMs) / 1000) * 1000;
    expect(toMs(job?.runAt)).toBe(expectedRetry);
    expect(job?.lastError).toMatch(/budget: session-headroom/);
  });

  it("admits a tick when the governor says work may run", async () => {
    await seedProjects("A");
    let ran = 0;
    const r = budgetRunner(
      async () => {
        ran += 1;
      },
      { readUsage: async () => usage({ sessionPct: 10 }) },
    );
    const id = await r.enqueue({ type: "execute-epic", projectId: "A" });

    expect(await r.tickOnce()).toBe(1);
    await r.whenIdle();
    expect(ran).toBe(1);
    expect((await getJob(tdb.db, id))?.status).toBe("done");
  });

  it("fails OPEN on a null usage read: no deferral, work leases normally", async () => {
    await seedProjects("A");
    let ran = 0;
    const r = budgetRunner(
      async () => {
        ran += 1;
      },
      { readUsage: async () => null },
    );
    const id = await r.enqueue({ type: "execute-epic", projectId: "A" });
    const runAtBefore = toMs((await getJob(tdb.db, id))?.runAt);

    expect(await r.tickOnce()).toBe(1); // null usage → governor admits
    await r.whenIdle();
    expect(ran).toBe(1);
    const job = await getJob(tdb.db, id);
    expect(job?.status).toBe("done");
    expect(runAtBefore).toBeLessThanOrEqual(clock.now()); // was due; governor never pushed it out
  });

  it("resumes prior budget deferrals on a null usage read — fail-open admits already-deferred work", async () => {
    // A governed tick defers the queued job past the session horizon; then the meter goes dark
    // (429 backoff, credentials hiccup, usage outage). leaseDue only scans due rows, so returning
    // on the null read without resuming the governor's own deferrals would strand the job until
    // the stale pace boundary — fail-open must pull it back to due-now and lease it.
    await seedProjects("A");
    let meterUp = true;
    let ran = 0;
    const r = budgetRunner(
      async () => {
        ran += 1;
      },
      { readUsage: async () => (meterUp ? usage({ sessionPct: 99 }) : null) },
    );
    const id = await r.enqueue({ type: "execute-epic", projectId: "A" });

    expect(await r.tickOnce()).toBe(0); // governed → deferred to the session horizon
    const deferred = await getJob(tdb.db, id);
    expect(toMs(deferred?.runAt)).toBeGreaterThan(clock.now());
    expect(deferred?.lastError).toMatch(/budget: session-headroom/);

    meterUp = false; // meter goes dark
    expect(await r.tickOnce()).toBe(1); // stale deferral resumed → leases this tick
    await r.whenIdle();
    expect(ran).toBe(1);
    expect((await getJob(tdb.db, id))?.status).toBe("done");
  });

  it("keeps the reactive UsageLimitError backstop working with the governor wired", async () => {
    // Governor admits (session fresh), but the handler still hits the wall mid-run: the reactive
    // path must reschedule to the reset and refund the attempt, exactly as without the governor.
    await seedProjects("A");
    const resetAt = Math.floor(clock.now() / 1000) + 3600; // seconds
    const r = budgetRunner(
      async () => {
        throw new UsageLimitError("hit the wall", resetAt);
      },
      { readUsage: async () => usage({ sessionPct: 10 }) },
    );
    const id = await r.enqueue({ type: "execute-epic", projectId: "A" });

    expect(await r.tickOnce()).toBe(1); // governor admitted; the job ran and hit the limit
    await r.whenIdle();
    const job = await getJob(tdb.db, id);
    expect(job?.status).toBe("queued"); // rescheduled, not parked
    expect(toMs(job?.runAt)).toBe(resetAt * 1000);
    expect(job?.attempts).toBe(0); // attempt refunded — quota isn't the job's fault
    expect(job?.lastError).toMatch(/usage-limit/);
  });

  // ── Per-job value/cost gate (anton-k05r) ──
  // The clock (1_700_000_000_000 ≈ 22:13 UTC) is NIGHT under the default policy (day 8–22), so the
  // daytime reserve never holds these ticks: the coarse gate admits and the fine gate decides.
  // sessionPct 85 → 15% headroom ≤ scarceHeadroomPct 20 → scarce (high-value only).

  /** Labels by bead id for the gate's reader; anything not listed reads as label-less cleanup. */
  const labelsReader =
    (byBead: Record<string, string[]>): BeadLabelsReader =>
    async (_pid, beadId) =>
      byBead[beadId] ?? [];

  /** Seed enough real burn samples that execute-epic's rolling average is `sessionDelta` (not the L-tier seed). */
  async function seedBurn(sessionDelta: number) {
    for (let i = 0; i < 5; i++) {
      await recordBurnSample(tdb.db, clock, "execute-epic", { sessionDelta, weeklyDelta: 0.1 });
    }
  }

  it("value gate: scarce session admits only high-value work, holding cleanup un-deferred (anton-k05r)", async () => {
    await seedProjects("A");
    await seedBurn(2); // measured cost 2% — fits the 15% headroom
    let ran = 0;
    const r = budgetRunner(
      async () => {
        ran += 1;
      },
      {
        readUsage: async () => usage({ sessionPct: 85 }),
        readBeadLabels: labelsReader({ "A-high": ["risk:high"] }),
      },
    );
    const high = await r.enqueue({
      type: "execute-epic",
      projectId: "A",
      payload: { projectId: "A", epicBeadId: "A-high" },
    });
    const low = await r.enqueue({
      type: "execute-epic",
      projectId: "A",
      payload: { projectId: "A", epicBeadId: "A-low" },
    });

    expect(await r.tickOnce()).toBe(1); // only the risk:high job clears the scarce threshold
    await r.whenIdle();
    expect(ran).toBe(1);
    expect((await getJob(tdb.db, high))?.status).toBe("done");
    // The held job is untouched — still queued and due (a per-tick hold, not a deferral), no
    // attempt burned. It re-evaluates next tick and leases the moment budget loosens.
    const held = await getJob(tdb.db, low);
    expect(held?.status).toBe("queued");
    expect(held?.attempts).toBe(0);
    expect(toMs(held?.runAt)).toBeLessThanOrEqual(clock.now());
  });

  it("value gate: a job whose cost cannot fit the remaining session is held even at high value", async () => {
    await seedProjects("A");
    // No burn samples → execute-epic costs the L-tier seed (20%), over the 15% headroom.
    const r = budgetRunner(async () => {}, {
      readUsage: async () => usage({ sessionPct: 85 }),
      readBeadLabels: labelsReader({ "A-1": ["risk:high"] }),
    });
    await r.enqueue({
      type: "execute-epic",
      projectId: "A",
      payload: { projectId: "A", epicBeadId: "A-1" },
    });

    expect(await r.tickOnce()).toBe(0); // cost-exceeds-headroom — admitting guarantees mid-run exhaustion
  });

  it("value gate: abundant budget admits low-value cleanup", async () => {
    await seedProjects("A");
    const r = budgetRunner(async () => {}, {
      readUsage: async () => usage({ sessionPct: 10 }), // 90% headroom ≥ abundant 60 → threshold 0
      readBeadLabels: labelsReader({}),
    });
    const id = await r.enqueue({
      type: "execute-epic",
      projectId: "A",
      payload: { projectId: "A", epicBeadId: "A-1" },
    });

    expect(await r.tickOnce()).toBe(1);
    await r.whenIdle();
    expect((await getJob(tdb.db, id))?.status).toBe("done");
  });

  it("value gate: holds the orphan-grooming cleanup sweep when the session is scarce", async () => {
    // Grooming carries no bead — it IS the low-value cleanup band — so scarce budget holds it
    // without any label read, and it drains later when budget is abundant/behind pace.
    await seedProjects("A");
    const r = budgetRunner(async () => {}, {
      readUsage: async () => usage({ sessionPct: 85 }),
    });
    const id = await r.enqueue({ type: "orphan-grooming", projectId: "A" });

    expect(await r.tickOnce()).toBe(0);
    expect((await getJob(tdb.db, id))?.status).toBe("queued");
  });

  it("value gate: fails open when the bead's labels cannot be read", async () => {
    await seedProjects("A");
    await seedBurn(2);
    const r = budgetRunner(async () => {}, {
      readUsage: async () => usage({ sessionPct: 85 }),
      readBeadLabels: async () => null, // bead unresolved → must admit, never starve on a guess
    });
    const id = await r.enqueue({
      type: "execute-epic",
      projectId: "A",
      payload: { projectId: "A", epicBeadId: "A-1" },
    });

    expect(await r.tickOnce()).toBe(1);
    await r.whenIdle();
    expect((await getJob(tdb.db, id))?.status).toBe("done");
  });

  it("value gate: an immediate-approved (bypassBudget) job skips the value gate", async () => {
    // The operator asked for "now" — only the session floor may hold it, not the value threshold.
    await seedProjects("A");
    await seedBurn(2);
    const r = budgetRunner(async () => {}, {
      readUsage: async () => usage({ sessionPct: 85 }),
      readBeadLabels: labelsReader({}), // would score as cleanup and be held if gated
    });
    const id = await r.enqueue({
      type: "execute-epic",
      projectId: "A",
      payload: { projectId: "A", epicBeadId: "A-1", bypassBudget: true },
    });

    expect(await r.tickOnce()).toBe(1);
    await r.whenIdle();
    expect((await getJob(tdb.db, id))?.status).toBe("done");
  });
});

/** Poll `pred` on real timers until it holds (used with in-flight jobs the FakeClock can't drive). */
async function waitUntil(
  pred: () => boolean | Promise<boolean>,
  { timeoutMs = 1_000, stepMs = 5 }: { timeoutMs?: number; stepMs?: number } = {},
): Promise<void> {
  const start = Date.now();
  for (;;) {
    if (await pred()) return;
    if (Date.now() - start > timeoutMs) throw new Error("waitUntil: timed out");
    await new Promise((resolve) => setTimeout(resolve, stepMs));
  }
}
