/**
 * How the runner DISPATCHES (anton-dzh.1): which due jobs a tick may lease, and what an operator can
 * do to work already in flight. Concurrency caps (global, per-project, per-type), the autonomy and
 * schedule gates, per-project timeouts, rolling dispatch, and the project-level controls
 * (`abortProject`, `quiesceProject`, `runningJobInfo`).
 *
 * The settle-side outcomes these leases feed live in `runner.lifecycle.test.ts`; the budget
 * governor's admission gate — the other reason a tick leases nothing — in `runner.budget.test.ts`.
 */
import { describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import * as schema from "../db/schema";
import { enqueue, getJob } from "./queue";
import type { JobHandler, JobPolicy, JobPolicyResolver, JobRunner, RunnerConfig } from "./runner";
import { CONFIG, useRunnerHarness, waitUntil } from "./runner.fixture";

describe("JobRunner dispatch (live, in-memory db)", () => {
  const h = useRunnerHarness();

  /** A runner with an injected per-project policy resolver + a roomy global ceiling. */
  function policyRunner(
    handler: JobHandler,
    resolvePolicy: JobPolicyResolver,
    config?: Partial<RunnerConfig>,
  ) {
    return h.makeRunner({
      handlers: { "execute-epic": handler },
      config: { maxConcurrent: 5, ...config },
      resolvePolicy,
    });
  }

  const policy = (over: Partial<JobPolicy> = {}): JobPolicy => ({
    concurrency: 1,
    timeoutMs: Infinity,
    maxAttempts: 3,
    ...over,
  });

  it("respects maxConcurrent", async () => {
    let concurrent = 0;
    let peak = 0;
    const r = h.runner(
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
    h.seedProjects("A", "B");
    const r = policyRunner(async () => {}, () => policy({ concurrency: 1 }));
    await r.enqueue({ type: "execute-epic", projectId: "A", payload: { n: 1 } });
    await r.enqueue({ type: "execute-epic", projectId: "A", payload: { n: 2 } });
    await r.enqueue({ type: "execute-epic", projectId: "B", payload: { n: 3 } });

    const processed = await r.tickOnce();
    await r.whenIdle();
    expect(processed).toBe(2); // one A + one B, not both A's

    const schema = await import("../db/schema");
    const rows = await h.db.select().from(schema.jobs);
    const queuedA = rows.filter(
      (j) => j.projectId === "A" && j.status === "queued",
    );
    expect(queuedA).toHaveLength(1); // the over-cap A job was left for a later tick
  });

  it("runs at most one sync-push per project at a time (anton-x7la)", async () => {
    // The queued-only dedup index lets a queued follow-up sit alongside a running push. The runner
    // must still cap the RUNNING count at 1 per project: the per-repo coalescer serializes their
    // pushes, so a second concurrent lease buys nothing and would pile handlers into the global pool
    // under a slow remote. Bound: 1 running + 1 queued.
    h.seedProjects("A");
    let concurrent = 0;
    let peak = 0;
    let release!: () => void;
    const gate = new Promise<void>((res) => (release = res));
    const r = h.makeRunner({
      handlers: {
        "sync-push": async () => {
          concurrent += 1;
          peak = Math.max(peak, concurrent);
          await gate;
          concurrent -= 1;
        },
      },
      config: { maxConcurrent: 5 },
    });

    await r.enqueue({ type: "sync-push", projectId: "A" }); // A → queued
    expect(await r.tickOnce()).toBe(1); // A leased → running, handler blocks on the gate

    // A durable follow-up lands while A runs (permitted by the queued-only index).
    const bId = await r.enqueue({ type: "sync-push", projectId: "A" });
    expect(await r.tickOnce()).toBe(0); // capped at 1 running per project — B stays queued
    expect((await getJob(h.db, bId))?.status).toBe("queued");

    release();
    await r.whenIdle();
    expect(await r.tickOnce()).toBe(1); // A settled → the queued follow-up is now leasable
    await r.whenIdle();

    expect(peak).toBe(1); // the two pushes never ran concurrently for project A
  });

  it("autonomy off gates claiming: execute-epic stays queued, and re-enabling resumes it (anton-y3l)", async () => {
    // The autonomy master-switch gates at *claim*: approval-style enqueues still land, but no
    // tick leases the job while the switch is off; flipping it back on resumes on the next tick.
    h.seedProjects("A");
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
    let job = await getJob(h.db, id);
    expect(job?.status).toBe("queued"); // enqueued but not running — no attempt burned
    expect(job?.attempts).toBe(0);

    autonomy = true; // operator flips the switch back on
    expect(await r.tickOnce()).toBe(1);
    await r.whenIdle();
    expect(ran).toBe(1);
    job = await getJob(h.db, id);
    expect(job?.status).toBe("done");
  });

  it("autonomy off leaves in-flight work untouched and gates only new claims (anton-y3l)", async () => {
    // A job already leased keeps running to completion after the switch turns off; only the
    // not-yet-claimed job is held back.
    h.seedProjects("A");
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
    expect((await getJob(h.db, heldId))?.status).toBe("queued");
    expect((await getJob(h.db, inFlightId))?.status).toBe("running"); // untouched

    release(); // the in-flight job finishes normally despite the switch being off
    await r.whenIdle();
    expect((await getJob(h.db, inFlightId))?.status).toBe("done");
    expect((await getJob(h.db, heldId))?.status).toBe("queued"); // still waiting on the switch
  });

  /** Seed a schedule row (defaults to disabled) so its jobs can be gated at claim. */
  async function seedSchedule(
    projectId: string,
    type: string,
    over: { enabled?: boolean } = {},
  ) {
    await h.db.insert(schema.schedules).values({
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
    h.seedProjects("A");
    await seedSchedule("A", "review-fix", { enabled: false });
    let ran = 0;
    const r = h.makeRunner({
      handlers: {
        "review-fix": async () => {
          ran += 1;
        },
      },
    });
    const id = await r.enqueue({ type: "review-fix", projectId: "A" });

    expect(await r.tickOnce()).toBe(0); // schedule disabled → never leased
    await r.whenIdle();
    expect(ran).toBe(0);
    let job = await getJob(h.db, id);
    expect(job?.status).toBe("queued"); // still queued — no attempt burned
    expect(job?.attempts).toBe(0);

    // Re-enable the schedule → the still-queued job resumes on the next tick.
    await h.db
      .update(schema.schedules)
      .set({ enabled: true })
      .where(eq(schema.schedules.id, "sched-review-fix-A"));
    expect(await r.tickOnce()).toBe(1);
    await r.whenIdle();
    expect(ran).toBe(1);
    job = await getJob(h.db, id);
    expect(job?.status).toBe("done");
  });

  it("gates every scheduled job type, and a disabled schedule doesn't starve execute-epic (anton-7l7)", async () => {
    // The gate is keyed on (type, project): a disabled review-fix schedule holds its own job back
    // but leaves the same project's execute-epic dispatch (autonomy on) untouched.
    h.seedProjects("A");
    await seedSchedule("A", "review-fix", { enabled: false });
    let reviewRan = 0;
    let epicRan = 0;
    const r = h.makeRunner({
      handlers: {
        "review-fix": async () => {
          reviewRan += 1;
        },
        "execute-epic": async () => {
          epicRan += 1;
        },
      },
      config: { maxConcurrent: 5 },
      resolvePolicy: () => policy({ concurrency: 2, autonomy: true }),
    });
    const reviewId = await r.enqueue({ type: "review-fix", projectId: "A" });
    await r.enqueue({ type: "execute-epic", projectId: "A", payload: { n: 1 } });

    expect(await r.tickOnce()).toBe(1); // only the execute-epic job — review-fix is gated off
    await r.whenIdle();
    expect(reviewRan).toBe(0);
    expect(epicRan).toBe(1);
    expect((await getJob(h.db, reviewId))?.status).toBe("queued");
  });

  it("a large disabled-schedule backlog doesn't starve leasable work past the scan window (anton-7l7)", async () => {
    // Regression: disabled jobs sort earliest by runAt, so before the SQL-level bucket exclusion they
    // filled leaseDue's finite scan window (max(limit*8, 200)) every tick; the cap-0 skip then left a
    // leasable job sorting AFTER them permanently unreachable — enabled schedules and other projects
    // stalled until the disabled ones were re-enabled or removed. Excluding held buckets in the query
    // paginates past the backlog so leasable work is still reached.
    h.seedProjects("A", "B");
    await seedSchedule("A", "review-fix", { enabled: false });

    // 250 disabled review-fix jobs (> the 200-row scan window) as the earliest-by-runAt prefix.
    const backlogAt = new Date(h.clock.now() - 10_000);
    await h.db.insert(schema.jobs).values(
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
    await h.db.insert(schema.jobs).values({
      id: "leasable",
      type: "execute-epic",
      projectId: "B",
      status: "queued",
      runAt: new Date(h.clock.now() - 1_000),
      attempts: 0,
    });

    let epicRan = 0;
    const r = h.makeRunner({
      handlers: {
        "review-fix": async () => {},
        "execute-epic": async () => {
          epicRan += 1;
        },
      },
      config: { maxConcurrent: 5 },
      resolvePolicy: () => policy({ concurrency: 2, autonomy: true }),
    });

    expect(await r.tickOnce()).toBe(1); // reaches past the 250 held jobs to lease the execute-epic
    await r.whenIdle();
    expect(epicRan).toBe(1);
    expect((await getJob(h.db, "leasable"))?.status).toBe("done");
  });

  it("aborts a job that makes no progress for its per-project timeout and retries it", async () => {
    // Handler blocks until aborted and never heartbeats; the 20ms budget fires, aborts it →
    // retryable 'made no progress' error.
    const r = policyRunner(
      (ctx) =>
        new Promise<void>((_resolve, reject) => {
          if (ctx.signal.aborted) return reject(new Error("aborted"));
          ctx.signal.addEventListener("abort", () => reject(new Error("aborted")));
        }),
      () => policy({ timeoutMs: 20 }),
    );
    h.seedProjects("A");
    const id = await r.enqueue({ type: "execute-epic", projectId: "A" });

    await r.tickOnce();
    await r.whenIdle();
    const job = await getJob(h.db, id);
    expect(job?.status).toBe("queued"); // rescheduled (attempt 1 < maxAttempts)
    expect(job?.attempts).toBe(1);
    expect(job?.lastError).toMatch(/made no progress/);
  });

  it("lets a heartbeating handler outlive the timeout — it bounds silence, not total runtime (anton-t1mo)", async () => {
    // The point of the re-scope: a handler whose length is a function of its input (execute-epic
    // walking N tickets) must not be guillotined for being long. It reports progress between units
    // of work, and each heartbeat restarts the no-progress h.clock — so this handler runs several
    // times its budget and still completes. Under a TOTAL wall h.clock it would abort at 20ms.
    let finished = false;
    const r = policyRunner(
      async (ctx) => {
        for (let i = 0; i < 5; i++) {
          await new Promise((res) => setTimeout(res, 15));
          await ctx.heartbeat(); // progress reported → h.clock restarts
        }
        finished = true;
      },
      () => policy({ timeoutMs: 20 }),
    );
    h.seedProjects("A");
    const id = await r.enqueue({ type: "execute-epic", projectId: "A" });

    await r.tickOnce();
    await r.whenIdle();
    expect(finished).toBe(true);
    const job = await getJob(h.db, id);
    expect(job?.status).toBe("done");
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
    h.seedProjects("A");
    const id = await r.enqueue({ type: "execute-epic", projectId: "A" });

    await r.tickOnce();
    await r.whenIdle();
    const job = await getJob(h.db, id);
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

    const r = h.makeRunner({
      handlers: {
        "execute-epic": async (ctx) => {
          if ((ctx.payload as { slow?: boolean }).slow) {
            await slowGate;
            slowFinished = true;
          } else {
            fastFinished = true;
          }
        },
      },
      config: { maxConcurrent: 5 },
    });

    const slowId = await r.enqueue({ type: "execute-epic", payload: { slow: true } });
    // Tick leases + dispatches the slow job without awaiting it.
    expect(await r.tickOnce()).toBe(1);
    expect(r.activeCount).toBe(1);

    // A job enqueued while the slow one is still running is leased on the very next tick…
    const fastId = await r.enqueue({ type: "execute-epic", payload: { slow: false } });
    expect(await r.tickOnce()).toBe(1);

    // …and settles to `done` before the slow job finishes.
    await waitUntil(async () => (await getJob(h.db, fastId))?.status === "done");
    expect(fastFinished).toBe(true);
    expect(slowFinished).toBe(false); // slow job is still blocked in flight
    expect((await getJob(h.db, slowId))?.status).toBe("running");
    expect(r.activeCount).toBe(1); // only the slow job remains in flight

    // Release the slow job and drain: it settles too.
    releaseSlow();
    await r.whenIdle();
    expect(slowFinished).toBe(true);
    expect((await getJob(h.db, slowId))?.status).toBe("done");
    expect(r.activeCount).toBe(0);
  });

  it("never oversubscribes global capacity across rolling ticks", async () => {
    // Six jobs, global cap 2, each blocked in flight. No tick may push the in-flight set past 2.
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let peak = 0;
    const r = h.makeRunner({
      handlers: {
        "execute-epic": async () => {
          peak = Math.max(peak, r.activeCount);
          await gate;
        },
      },
      config: { maxConcurrent: 2 },
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
    const r = h.makeRunner({
      handlers: {
        "execute-epic": async () => {
          starts += 1;
          await gate;
        },
      },
      config: { maxConcurrent: 5 },
    });

    const id = await r.enqueue({ type: "execute-epic" });
    expect(await r.tickOnce()).toBe(1);
    await waitUntil(() => starts === 1); // handler is genuinely in flight
    expect(r.activeCount).toBe(1);

    // Let the lease lapse while the handler is still blocked in flight.
    h.clock.advance(CONFIG.leaseMs + 1);

    // Spare capacity + a reclaimable-looking row, yet the in-flight job is excluded → nothing leased.
    expect(await r.tickOnce()).toBe(0);
    expect(await r.tickOnce()).toBe(0);
    expect(r.activeCount).toBe(1); // still just the one handler
    expect(starts).toBe(1); // handler never re-entered

    // Its lease/attempts weren't overwritten by a phantom re-lease.
    const stillRunning = await getJob(h.db, id);
    expect(stillRunning?.status).toBe("running");
    expect(stillRunning?.attempts).toBe(1);

    // Drain: releasing the gate lets the single handler settle to done.
    release();
    await r.whenIdle();
    expect((await getJob(h.db, id))?.status).toBe("done");
  });

  it("abortProject force-aborts the in-flight job and removes the project's queued/running rows (anton-adt)", async () => {
    h.seedProjects("A", "B");
    let sawAbort = false;
    const r = h.runner(async (ctx) => {
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
    expect(await getJob(h.db, inFlightId)).toBeUndefined();
    expect(await getJob(h.db, queuedId)).toBeUndefined();
    // The other project's work is untouched.
    expect((await getJob(h.db, otherId))?.status).toBe("queued");
  });

  it("abortProject is a safe no-op for a project with no active jobs and leaves settled rows alone", async () => {
    h.seedProjects("A");
    const r = h.runner(async () => {});
    const id = await r.enqueue({ type: "execute-epic", projectId: "A" });
    await r.tickOnce();
    await r.whenIdle();

    await expect(r.abortProject("A")).resolves.toBeUndefined();
    // Settled (done) rows are the caller's to delete, not abortProject's.
    expect((await getJob(h.db, id))?.status).toBe("done");
  });

  it("quiesceProject rejects new enqueue/resume work and never leases the project again", async () => {
    h.seedProjects("A", "B");
    const r = h.runner(async () => {});
    const parked = await r.enqueue({ type: "execute-epic", projectId: "A" });
    await h.db.update(schema.jobs).set({ status: "parked" }).where(eq(schema.jobs.id, parked));

    await r.quiesceProject("A");

    await expect(r.enqueue({ type: "review-fix", projectId: "A" })).rejects.toThrow(
      /being deleted/,
    );
    await expect(r.enqueueExecuteEpic("A", "epic-race")).rejects.toThrow(/being deleted/);
    await expect(r.resume(parked)).resolves.toBe(false);
    const bypassed = await enqueue(h.db, h.clock, { type: "review-fix", projectId: "A" });
    const other = await r.enqueue({ type: "execute-epic", projectId: "B" });
    expect(await r.tickOnce()).toBe(1);
    await r.whenIdle();
    expect((await getJob(h.db, bypassed))?.status).toBe("queued");
    expect((await getJob(h.db, other))?.status).toBe("done");
  });

  it("refuses a resume for a project quiesced at the write itself (PR #218)", async () => {
    // The window the pre-read guard left open: teardown raises the barrier and sweeps the project's
    // active rows while the resume is already under way. Checked before the read, the resume would
    // still flip the parked row to `queued` behind that sweep — and teardown's leftover guard fails
    // the delete over it. The barrier is handed down into the resume's transaction, so the write
    // itself is what sees it.
    h.seedProjects("A");
    const r = h.runner(async () => {});
    const parked = await r.enqueue({ type: "execute-epic", projectId: "A" });
    await h.db.update(schema.jobs).set({ status: "parked" }).where(eq(schema.jobs.id, parked));

    const transaction = h.db.transaction.bind(h.db);
    vi.spyOn(h.db, "transaction").mockImplementationOnce(((fn: never) => {
      r.quiesceProject("A").catch(() => {});
      return transaction(fn);
    }) as typeof h.db.transaction);

    expect(await r.resume(parked)).toBe(false);
    expect((await getJob(h.db, parked))?.status).toBe("parked");
  });

  it("refuses a per-PR dispatch from a handler whose project was quiesced mid-triage (PR #250)", async () => {
    // The review-fix dispatcher yields on its `gh` read and only then inserts. A project delete that
    // lands inside that read raises the barrier and sweeps the project's active rows; an insert
    // through the bare queue helper would then create a fresh `queued` row AFTER the sweep, and
    // teardown's leftover guard fails the delete over it. Through the runner the insert is refused.
    h.seedProjects("A");
    let release!: () => void;
    const gate = new Promise<void>((res) => (release = res));
    let dispatched: string | undefined | "unset" = "unset";
    const r = h.makeRunner({
      handlers: {
        "review-fix": async (ctx) => {
          await gate;
          dispatched = ctx.enqueueReviewFixPr("A", "epic-1");
        },
      },
    });
    await r.enqueue({ type: "review-fix", projectId: "A", payload: { projectId: "A" } });
    expect(await r.tickOnce()).toBe(1);

    const quiesce = r.quiesceProject("A");
    // Let teardown finish its sweep — the dispatcher's own row is gone — before the handler wakes
    // and reaches its insert, so the row it would create is one no sweep could catch.
    await waitUntil(async () => {
      const rows = await h.db.select().from(schema.jobs);
      return rows.every((j) => j.status !== "queued" && j.status !== "running");
    });
    release();

    await expect(quiesce).resolves.toBeUndefined();
    await r.whenIdle();
    expect(dispatched).toBeUndefined();
    const fixes = await h.db.select().from(schema.jobs).where(eq(schema.jobs.type, "review-fix-pr"));
    expect(fixes).toHaveLength(0);
  });

  it("runningJobInfo returns what the handler reported while in flight, undefined after settle (anton-susu)", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let reported = false;
    const r = h.runner(async (ctx) => {
      ctx.report({ sessionId: "sess-1", cwd: "/tmp/wt-1" });
      reported = true;
      await gate;
    });
    const id = await r.enqueue({ type: "execute-epic" });
    expect(await r.tickOnce()).toBe(1);
    await waitUntil(() => reported);

    expect(r.runningJobInfo(id)).toEqual({
      sessionId: "sess-1",
      cwd: "/tmp/wt-1",
      type: "execute-epic",
    });
    expect(r.runningJobInfo("does-not-exist")).toBeUndefined();

    // Settled → the live handle is cleared with the in-flight entry; a done job reports nothing.
    release();
    await r.whenIdle();
    expect(r.runningJobInfo(id)).toBeUndefined();
    expect((await getJob(h.db, id))?.status).toBe("done");
  });

  it("runningJobInfo merges partial reports and a re-report overwrites (anton-susu)", async () => {
    // execute-epic re-reports per ticket: the handle must always name the CURRENT session.
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let ctxRef: Parameters<JobHandler>[0] | undefined;
    const r = h.runner(async (ctx) => {
      ctxRef = ctx;
      await gate;
    });
    const id = await r.enqueue({ type: "execute-epic" });
    await r.tickOnce();
    await waitUntil(() => ctxRef !== undefined);

    // In flight but nothing reported yet — the job is introspectable, its fields just empty.
    expect(r.runningJobInfo(id)).toEqual({ type: "execute-epic" });

    ctxRef!.report({ cwd: "/tmp/wt-1" });
    expect(r.runningJobInfo(id)).toEqual({ cwd: "/tmp/wt-1", type: "execute-epic" });
    ctxRef!.report({ sessionId: "sess-1" });
    expect(r.runningJobInfo(id)).toEqual({
      sessionId: "sess-1",
      cwd: "/tmp/wt-1",
      type: "execute-epic",
    });
    ctxRef!.report({ sessionId: "sess-2" }); // next ticket's session replaces the last
    expect(r.runningJobInfo(id)).toEqual({
      sessionId: "sess-2",
      cwd: "/tmp/wt-1",
      type: "execute-epic",
    });

    release();
    await r.whenIdle();
    expect(r.runningJobInfo(id)).toBeUndefined();
  });

  it("runningJobInfo clears even when the handler fails (settle → park/retry) (anton-susu)", async () => {
    const r = h.runner(async (ctx) => {
      ctx.report({ sessionId: "sess-fail", cwd: "/tmp/wt-f" });
      throw new Error("boom");
    });
    const id = await r.enqueue({ type: "execute-epic" });
    await r.tickOnce();
    await r.whenIdle();
    expect(r.runningJobInfo(id)).toBeUndefined();
    expect((await getJob(h.db, id))?.status).toBe("queued"); // rescheduled for retry
  });

  // ── the per-PR fix cap (anton-g5eu / anton-kwi6) ──
  //
  // The review-fix poll fans out one job per actionable PR, so the fan-out is bounded by how many
  // PRs are in review — nothing else. Without a cap a busy review day fills the global slot pool and
  // starves execute-epic; with one, the extras stay queued and lease on later ticks.
  //
  // Ported here from the pre-split runner.test.ts (anton-tart) — it is a dispatch/concurrency
  // concern, so it belongs beside the other cap cases and reuses this suite's `policy` and
  // `seedSchedule` helpers.
  describe("review-fix-pr concurrency", () => {
    /** A runner that gates review-fix-pr at `cap`, with a roomy global ceiling. */
    function prFixRunner(cap: number, handler: JobHandler = async () => {}) {
      return h.makeRunner({
        handlers: { "review-fix-pr": handler, "execute-epic": async () => {} },
        config: { maxConcurrent: 8, maxReviewFixConcurrent: 4 },
        resolvePolicy: () => policy({ concurrency: 2, reviewFixConcurrency: cap }),
      });
    }

    const enqueuePrFixes = async (r: JobRunner, count: number) => {
      for (let i = 0; i < count; i++) {
        await r.enqueue({
          type: "review-fix-pr",
          projectId: "A",
          payload: { projectId: "A", epicBeadId: `epic-${i}` },
        });
      }
    };

    it("leases only up to the project's cap and leaves the rest queued", async () => {
      h.seedProjects("A");
      let concurrent = 0;
      let peak = 0;
      let release!: () => void;
      const gate = new Promise<void>((res) => (release = res));
      const r = prFixRunner(2, async () => {
        concurrent += 1;
        peak = Math.max(peak, concurrent);
        await gate;
        concurrent -= 1;
      });
      await enqueuePrFixes(r, 4);

      expect(await r.tickOnce()).toBe(2);
      expect(await r.tickOnce()).toBe(0); // still at capacity — nothing dropped, nothing doubled
      release();
      await r.whenIdle();
      expect(peak).toBe(2);

      // The two held jobs lease on a later tick, once the first pair settled.
      expect(await r.tickOnce()).toBe(2);
      await r.whenIdle();
      const rows = await h.db.select().from(schema.jobs);
      expect(rows.filter((j) => j.status === "done")).toHaveLength(4);
    });

    // The per-project cap bounds one project's fan-out, not the sum (PR #250 review): several
    // projects with actionable PRs could still fill the whole pool between them. The runner-wide
    // ceiling holds the sum, so a job of another type queued behind them still finds a slot.
    it("holds the sum across projects at the runner-wide ceiling, leaving slots for other types", async () => {
      h.seedProjects("A", "B", "C");
      let release!: () => void;
      const gate = new Promise<void>((res) => (release = res));
      let epicRan = false;
      const r = h.makeRunner({
        handlers: {
          "review-fix-pr": async () => {
            await gate;
          },
          "execute-epic": async () => {
            epicRan = true;
          },
        },
        config: { maxConcurrent: 8, maxReviewFixConcurrent: 3 },
        resolvePolicy: () => policy({ concurrency: 2, reviewFixConcurrency: 2 }),
      });
      for (const projectId of ["A", "B", "C"]) {
        for (let i = 0; i < 2; i++) {
          await r.enqueue({
            type: "review-fix-pr",
            projectId,
            payload: { projectId, epicBeadId: `epic-${i}` },
          });
        }
      }

      // Six fixes, every one within its project's cap of two — the ceiling admits three.
      expect(await r.tickOnce()).toBe(3);
      expect(await r.tickOnce()).toBe(0);

      // The other types are what the ceiling reserves for: an execute-epic leases beside the held
      // fixes instead of waiting out one of them.
      await r.enqueue({ type: "execute-epic", projectId: "A" });
      expect(await r.tickOnce()).toBe(1);
      release();
      await r.whenIdle();
      expect(epicRan).toBe(true);

      // The held fixes lease once the first three settled — nothing dropped.
      expect(await r.tickOnce()).toBe(3);
      await r.whenIdle();
      const rows = await h.db.select().from(schema.jobs);
      expect(rows.filter((j) => j.status === "done")).toHaveLength(7);
    });

    /**
     * The child type has no schedule row of its own — it is dispatched by the `review-fix` poll — so
     * its hold is DERIVED from that switch. Otherwise turning the poll off would stop dispatching
     * while queued fixes kept leasing: the master switch has to stop fixing, not just polling.
     */
    it("is held by the review-fix schedule's master switch, and resumes when it is re-enabled", async () => {
      h.seedProjects("A");
      await seedSchedule("A", "review-fix", { enabled: false });
      let ran = 0;
      const r = prFixRunner(2, async () => {
        ran += 1;
      });
      await enqueuePrFixes(r, 2);

      expect(await r.tickOnce()).toBe(0);
      await r.whenIdle();
      expect(ran).toBe(0);
      const held = await h.db.select().from(schema.jobs);
      expect(held.every((j) => j.status === "queued" && j.attempts === 0)).toBe(true);

      await h.db
        .update(schema.schedules)
        .set({ enabled: true })
        .where(eq(schema.schedules.id, "sched-review-fix-A"));
      expect(await r.tickOnce()).toBe(2);
      await r.whenIdle();
      expect(ran).toBe(2);
    });

    it("leases none for a quiesced project, like every other type", async () => {
      h.seedProjects("A");
      const r = prFixRunner(2);
      await enqueuePrFixes(r, 2);
      await r.quiesceProject("A");
      expect(await r.tickOnce()).toBe(0);
    });
  });
});
