/**
 * The runner's live durability loop against a real in-memory anton.db (anton-dzh.1): what a
 * handler's reported effect settles to, then lease/reclaim, quota backoff (park + reschedule with
 * the attempt refunded), poison-pill parking, resume, cancel and reconcile.
 *
 * Concurrency caps, gating and dispatch shape live in `runner.dispatch.test.ts`; the pure policy
 * these outcomes follow, in `runner.policy.test.ts`.
 */
import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import * as schema from "../db/schema";
import { PoisonError, UsageLimitError } from "./errors";
import { complete, getJob, park, reschedule, toMs } from "./queue";
import { CONFIG, useRunnerHarness, waitUntil } from "./runner.fixture";

describe("JobRunner lifecycle (live, in-memory db)", () => {
  const h = useRunnerHarness();

  // ── the handler's own claim about what it DID (anton-znoz) ──
  //
  // `status` says the job finished; `outcome` says whether finishing meant anything. The Automation
  // table reads the two together, so a run that reported nothing must not be dressed up as either.

  it("records a handler's reported effect on the completed job", async () => {
    const r = h.runner(async () => ({ changed: true, note: "bucketed 3 loose ticket(s)" }));
    const id = await r.enqueue({ type: "execute-epic", payload: {} });
    await r.tickOnce();
    await r.whenIdle();
    const job = await getJob(h.db, id);
    expect(job?.status).toBe("done");
    expect(job?.outcome).toBe("ok");
    expect(job?.outcomeNote).toBe("bucketed 3 loose ticket(s)");
  });

  it("records a no-op distinctly from a run that changed something", async () => {
    const r = h.runner(async () => ({ changed: false, note: "no loose tickets" }));
    const id = await r.enqueue({ type: "execute-epic", payload: {} });
    await r.tickOnce();
    await r.whenIdle();
    const job = await getJob(h.db, id);
    expect(job?.status).toBe("done");
    expect(job?.outcome).toBe("noop");
    expect(job?.outcomeNote).toBe("no loose tickets");
  });

  it("leaves the outcome null for a handler that reports nothing", async () => {
    const r = h.runner(async () => {});
    const id = await r.enqueue({ type: "execute-epic", payload: {} });
    await r.tickOnce();
    await r.whenIdle();
    const job = await getJob(h.db, id);
    expect(job?.status).toBe("done");
    expect(job?.outcome).toBeNull();
    expect(job?.outcomeNote).toBeNull();
  });

  it("records no outcome for a job that parked — a failure is status + lastError", async () => {
    const r = h.runner(async () => {
      throw new PoisonError("boom");
    });
    const id = await r.enqueue({ type: "execute-epic", payload: {} });
    await r.tickOnce();
    await r.whenIdle();
    const job = await getJob(h.db, id);
    expect(job?.status).toBe("parked");
    expect(job?.outcome).toBeNull();
    expect(job?.lastError).toContain("boom");
  });

  it("withholds a retry's no-op claim — an earlier attempt may have changed state", async () => {
    // The effect is attempt-local: gate-check can close gates and then throw, leaving the retry
    // nothing to find. Publishing that retry's "no gate closed" would report work that happened as
    // work that didn't, so the claim is withheld and the job settles as "ran, effect unknown".
    let attempt = 0;
    const r = h.runner(
      async () => {
        attempt += 1;
        if (attempt === 1) throw new Error("closed 2 gate(s), then failed");
        return { changed: false, note: "no gate closed" };
      },
      { maxAttempts: 3, backoffBaseMs: 1_000 },
    );
    const id = await r.enqueue({ type: "execute-epic" });

    await r.tickOnce();
    await r.whenIdle();
    h.clock.advance(2_000);
    await r.tickOnce();
    await r.whenIdle();

    const job = await getJob(h.db, id);
    expect(job?.status).toBe("done");
    expect(job?.attempts).toBe(2);
    expect(job?.outcome).toBeNull();
    expect(job?.outcomeNote).toContain("no gate closed");
    expect(job?.outcomeNote).toContain("earlier attempt");
  });

  it("still records a retry that changed something as ok", async () => {
    let attempt = 0;
    const r = h.runner(
      async () => {
        attempt += 1;
        if (attempt === 1) throw new Error("transient");
        return { changed: true, note: "closed 2 gate(s)" };
      },
      { maxAttempts: 3, backoffBaseMs: 1_000 },
    );
    const id = await r.enqueue({ type: "execute-epic" });

    await r.tickOnce();
    await r.whenIdle();
    h.clock.advance(2_000);
    await r.tickOnce();
    await r.whenIdle();

    const job = await getJob(h.db, id);
    expect(job?.status).toBe("done");
    expect(job?.outcome).toBe("ok");
    expect(job?.outcomeNote).toBe("closed 2 gate(s)");
  });

  it("runs a queued job to completion", async () => {
    let ran = 0;
    const r = h.runner(async () => {
      ran += 1;
    });
    const id = await r.enqueue({ type: "execute-epic", payload: { a: 1 } });
    const processed = await r.tickOnce();
    await r.whenIdle();
    expect(processed).toBe(1);
    expect(ran).toBe(1);
    const job = await getJob(h.db, id);
    expect(job?.status).toBe("done");
    expect(job?.attempts).toBe(1);
  });

  it("hands the handler its parsed payload + attempt number", async () => {
    let seen: unknown;
    let attempt = -1;
    const r = h.runner(async (ctx) => {
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
    const resetAt = Math.floor(h.clock.now() / 1000) + 3600;
    const r = h.runner(async () => {
      throw new UsageLimitError("Claude AI usage limit reached", resetAt);
    });
    const id = await r.enqueue({ type: "execute-epic" });
    await r.tickOnce();
    await r.whenIdle();
    const job = await getJob(h.db, id);
    expect(job?.status).toBe("queued"); // rescheduled, will auto-resume
    expect(job?.attempts).toBe(0); // attempt refunded — quota isn't the job's fault
    expect(toMs(job?.runAt)).toBe(resetAt * 1000);
    expect(job?.lastError).toMatch(/usage-limit/);

    // Not due yet → not picked up.
    expect(await r.tickOnce()).toBe(0);
    // After the reset window it runs again.
    h.clock.set(resetAt * 1000 + 1);
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
    const id = await h.db
      .insert((await import("../db/schema")).jobs)
      .values({
        id: "stuck-1",
        type: "execute-epic",
        status: "running",
        runAt: new Date(h.clock.now() - 100_000),
        leaseExpiresAt: new Date(h.clock.now() - 50_000), // already expired
        attempts: 1,
      })
      .returning({ id: (await import("../db/schema")).jobs.id })
      .then((rows) => rows[0].id);

    let ran = false;
    const r = h.runner(async () => {
      ran = true;
    });
    const processed = await r.tickOnce();
    await r.whenIdle();
    expect(processed).toBe(1);
    expect(ran).toBe(true);
    const job = await getJob(h.db, id);
    expect(job?.status).toBe("done");
    expect(job?.attempts).toBe(2); // reclaim counted as a new attempt
  });

  it("retries then poison-pill parks a persistently failing job after maxAttempts", async () => {
    const r = h.runner(
      async () => {
        throw new Error("always fails");
      },
      { maxAttempts: 3, backoffBaseMs: 1_000 },
    );
    const id = await r.enqueue({ type: "execute-epic" });

    // Attempt 1 → reschedule (backoff 1s)
    await r.tickOnce();
    await r.whenIdle();
    let job = await getJob(h.db, id);
    expect(job?.status).toBe("queued");
    expect(job?.attempts).toBe(1);

    // Advance past backoff, attempt 2 → reschedule (backoff 2s)
    h.clock.advance(2_000);
    await r.tickOnce();
    await r.whenIdle();
    job = await getJob(h.db, id);
    expect(job?.status).toBe("queued");
    expect(job?.attempts).toBe(2);

    // Advance past backoff, attempt 3 → maxAttempts reached → park
    h.clock.advance(5_000);
    await r.tickOnce();
    await r.whenIdle();
    job = await getJob(h.db, id);
    expect(job?.status).toBe("parked");
    expect(job?.attempts).toBe(3);
    expect(job?.lastError).toMatch(/failed 3/);

    // Parked jobs are not picked up again.
    h.clock.advance(1_000_000);
    expect(await r.tickOnce()).toBe(0);
  });

  it("resumes a parked job back to queued with a fresh attempt budget, then runs it to completion", async () => {
    // anton-ner.2: parking must not be a permanent dead end. A transient error exhausts maxAttempts
    // and parks; resume() un-parks it (attempts refunded to 0) and the next tick runs it.
    let attempts = 0;
    const r = h.runner(
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
    h.clock.advance(2_000);
    await r.tickOnce();
    await r.whenIdle();
    h.clock.advance(5_000);
    await r.tickOnce();
    await r.whenIdle();
    let job = await getJob(h.db, id);
    expect(job?.status).toBe("parked");
    expect(job?.attempts).toBe(3);

    // Resume: parked → queued, due now, attempts refunded, lastError cleared.
    expect(await r.resume(id)).toBe(true);
    job = await getJob(h.db, id);
    expect(job?.status).toBe("queued");
    expect(job?.attempts).toBe(0);
    expect(job?.lastError).toBeNull();

    // Runs again (4th attempt now succeeds) → done.
    expect(await r.tickOnce()).toBe(1);
    await r.whenIdle();
    job = await getJob(h.db, id);
    expect(job?.status).toBe("done");
    expect(attempts).toBe(4);
  });

  it("resume() is a no-op (returns false) for a job that isn't parked", async () => {
    const r = h.runner(async () => {});
    const id = await r.enqueue({ type: "execute-epic" });
    // queued, not parked → refuse to touch its lifecycle.
    expect(await r.resume(id)).toBe(false);
    expect((await getJob(h.db, id))?.status).toBe("queued");
    expect(await r.resume("does-not-exist")).toBe(false);
  });

  it("resume() also un-parks a `failed` (reserved terminal) job (anton-ner.4)", async () => {
    const schema = await import("../db/schema");
    const r = h.runner(async () => {});
    const id = await r.enqueue({ type: "execute-epic" });
    await h.db.update(schema.jobs).set({ status: "failed" }).where(eq(schema.jobs.id, id));
    expect(await r.resume(id)).toBe(true);
    const job = await getJob(h.db, id);
    expect(job?.status).toBe("queued");
    expect(job?.attempts).toBe(0);
  });

  it("cancel() aborts the in-flight job, terminalizes it, and no durability path revives it (anton-a4jj)", async () => {
    // The core force-kill: abort the child AND mark the row terminal so the aborted handler's settle
    // (an AbortError classifies as a retryable `error`) can't reschedule it back to `queued`.
    let sawAbort = false;
    const r = h.runner(async (ctx) => {
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
    const job = await getJob(h.db, id);
    expect(job?.status).toBe("cancelled"); // NOT rescheduled by the aborted handler's settle
    expect(job?.leaseExpiresAt).toBeNull();

    // No re-lease even past the lease window, and resume refuses it.
    h.clock.advance(CONFIG.leaseMs * 2);
    expect(await r.tickOnce()).toBe(0);
    expect((await getJob(h.db, id))?.status).toBe("cancelled");
    expect(await r.resume(id)).toBe(false);
  });

  it("cancel() refused by `only` leaves the in-flight child alone (anton-wvcy)", async () => {
    // The stale-button case: an escalation's "stop retrying" is raised against a parked/failed job,
    // but an operator resumed it first, so it is running again. The CAS refuses the write — and the
    // abort must be refused with it, or the click kills the agent that resume put back to work.
    let sawAbort = false;
    let finish!: () => void;
    const running = new Promise<void>((resolveWait) => {
      finish = resolveWait;
    });
    const r = h.runner(async (ctx) => {
      ctx.signal.addEventListener("abort", () => {
        sawAbort = true;
      });
      await running;
    });
    const id = await r.enqueue({ type: "execute-epic" });
    expect(await r.tickOnce()).toBe(1);
    await waitUntil(() => r.activeCount === 1);

    expect(await r.cancel(id, ["parked", "failed"])).toBe(false);

    expect(sawAbort).toBe(false);
    expect((await getJob(h.db, id))?.status).toBe("running");
    finish();
    await r.whenIdle();
    expect((await getJob(h.db, id))?.status).toBe("done"); // the resumed run finished normally
  });

  it("cancel() terminalizes a queued job so it is never leased (anton-a4jj)", async () => {
    const r = h.runner(async () => {});
    const id = await r.enqueue({ type: "execute-epic" });
    expect(await r.cancel(id)).toBe(true);
    expect((await getJob(h.db, id))?.status).toBe("cancelled");
    expect(await r.tickOnce()).toBe(0); // never dispatched
  });

  it("cancel() terminalizes a running row with no local controller so reclaim can't re-run it (anton-a4jj)", async () => {
    // A `running` row leased by a since-restarted process: the lease is still held and THIS runner
    // holds no in-flight controller. Cancel must still write the row terminal.
    const schema = await import("../db/schema");
    const r = h.runner(async () => {});
    await h.db.insert(schema.jobs).values({
      id: "leased-elsewhere",
      type: "execute-epic",
      status: "running",
      runAt: new Date(h.clock.now() - 1_000),
      leaseExpiresAt: new Date(h.clock.now() + CONFIG.leaseMs),
      attempts: 1,
    });

    expect(await r.cancel("leased-elsewhere")).toBe(true);
    expect((await getJob(h.db, "leased-elsewhere"))?.status).toBe("cancelled");

    // Past the original lease, lease-expiry reclaim never re-dispatches it.
    h.clock.advance(CONFIG.leaseMs * 2);
    expect(await r.tickOnce()).toBe(0);
    expect((await getJob(h.db, "leased-elsewhere"))?.status).toBe("cancelled");
  });

  it("cancel() is a safe no-op on an already-terminal job and reports whether it acted (anton-a4jj)", async () => {
    const r = h.runner(async () => {});
    const done = await r.enqueue({ type: "execute-epic" });
    await r.tickOnce();
    await r.whenIdle();
    expect((await getJob(h.db, done))?.status).toBe("done");
    expect(await r.cancel(done)).toBe(false); // already terminal — untouched
    expect((await getJob(h.db, done))?.status).toBe("done");

    // A second cancel of an already-cancelled job is a no-op; an unknown id too.
    const q = await r.enqueue({ type: "execute-epic" });
    expect(await r.cancel(q)).toBe(true);
    expect(await r.cancel(q)).toBe(false);
    expect(await r.cancel("does-not-exist")).toBe(false);
  });

  it("cancel() wins when a stale settlement tries to transition the job afterward", async () => {
    const transitions = [
      (id: string) => complete(h.db, h.clock, id),
      (id: string) => reschedule(h.db, h.clock, id, h.clock.now() + 1_000),
      (id: string) => park(h.db, h.clock, id, "stale failure"),
    ];

    for (const transition of transitions) {
      const r = h.runner(async () => {});
      const id = await r.enqueue({ type: "execute-epic" });
      await h.db
        .update(schema.jobs)
        .set({ status: "running", leaseExpiresAt: new Date(h.clock.now() + CONFIG.leaseMs) })
        .where(eq(schema.jobs.id, id));

      expect(await r.cancel(id)).toBe(true);
      await transition(id);
      expect((await getJob(h.db, id))?.status).toBe("cancelled");
    }
  });

  it("reconcile() reclaims orphaned running jobs and fails only truly-orphaned runs (anton-nbd)", async () => {
    const schema = await import("../db/schema");
    h.seedProjects("A", "B");
    const nowMs = h.clock.now();

    // A running execute-epic job whose lease has NOT yet expired — a crash left it in flight. Its
    // run must be kept (the job is about to be re-dispatched), and reconcile must clear its lease so
    // the next tick reclaims it immediately instead of waiting out leaseMs.
    const liveJobId = await h.db
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
    await h.db.insert(schema.runs).values({
      id: "run-live",
      projectId: "A",
      epicBeadId: "epic-live",
      status: "running",
      startedAt: new Date(nowMs),
      updatedAt: new Date(nowMs),
    });

    // An orphaned run: stuck `running` with NO execute-epic job for its epic → nothing will resume
    // it, so reconcile must mark it failed.
    await h.db.insert(schema.runs).values({
      id: "run-orphan",
      projectId: "B",
      epicBeadId: "epic-dead",
      status: "running",
      startedAt: new Date(nowMs),
      updatedAt: new Date(nowMs),
    });

    let ran = false;
    const r = h.runner(async () => {
      ran = true;
    });
    const res = await r.reconcile();
    expect(res.reclaimedJobs).toBe(1);
    expect(res.reconciledRuns).toBe(1);

    // The live job kept its `running` status but its lease was expired (≤ now) → reclaimable.
    const job = await getJob(h.db, liveJobId);
    expect(job?.status).toBe("running");
    expect(toMs(job?.leaseExpiresAt)!).toBeLessThanOrEqual(nowMs);

    const runsRows = await h.db.select().from(schema.runs);
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
    const resetAt = Math.floor(h.clock.now() / 1000) + 3600;
    const r = h.runner(
      async () => {
        throw new UsageLimitError("Claude AI usage limit reached", resetAt);
      },
      { maxAttempts: 1 }, // one attempt → would park a plain error immediately
    );
    const id = await r.enqueue({ type: "execute-epic" });

    await r.tickOnce();
    await r.whenIdle();
    const job = await getJob(h.db, id);
    expect(job?.status).toBe("queued"); // rescheduled, never parked
    expect(job?.attempts).toBe(0); // attempt refunded despite the cap
    expect(toMs(job?.runAt)).toBe(resetAt * 1000);
  });

  it("parks immediately on PoisonError without exhausting attempts", async () => {
    const r = h.runner(async () => {
      throw new PoisonError("unrecoverable");
    });
    const id = await r.enqueue({ type: "execute-epic" });
    await r.tickOnce();
    await r.whenIdle();
    const job = await getJob(h.db, id);
    expect(job?.status).toBe("parked");
    expect(job?.attempts).toBe(1);
    expect(job?.lastError).toMatch(/poison/);
  });
});
