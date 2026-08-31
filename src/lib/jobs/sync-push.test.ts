/**
 * Tests for the durable sync-push handler (anton-nowq): it pushes a repo through the coalescer,
 * completes when caught up, and — driven by the runner — retries with backoff then PARKS a stuck
 * remote as a visible, resumable job. Plus the no-double-push guarantee: a job push and the E1
 * heartbeat backstop share one per-repo coalescer, so they can never overlap.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeTestDb, type TestDb } from "../db/testing";
import * as schema from "../db/schema";
import { type SyncOutcome } from "../beads/bd";
import { createDoltSync } from "../beads/sync-coalescer";
import { PoisonError, SyncNotWiredError } from "./errors";
import { enqueueSyncPushDeduped, getJob, type Clock } from "./queue";
import { JobRunner, type JobContext, type RunnerConfig } from "./runner";
import { DEFAULT_CONFIG } from "./runner";
import { makeSyncPushHandler } from "./sync-push";

class FakeClock implements Clock {
  constructor(private t: number) {}
  now() {
    return this.t;
  }
  advance(ms: number) {
    this.t += ms;
  }
}

function fakeCtx(over: Partial<JobContext> & { payload: unknown }): JobContext {
  return {
    jobId: "job-1",
    type: "sync-push",
    projectId: "p1",
    attempt: 1,
    heartbeat: async () => {},
    report: () => {},
    signal: new AbortController().signal,
    ...over,
  };
}

let t: TestDb;
beforeEach(() => {
  t = makeTestDb();
  t.db
    .insert(schema.projects)
    .values({ id: "p1", slug: "p1", name: "p1", repoPath: "/tmp/p1" })
    .run();
});
afterEach(() => t.close());

describe("makeSyncPushHandler", () => {
  it("pushes the project's repo through the injected push and completes", async () => {
    const push = vi.fn(async (): Promise<SyncOutcome> => "synced");
    const handler = makeSyncPushHandler({ db: t.db, push });
    await handler(fakeCtx({ payload: { projectId: "p1" } }));
    expect(push).toHaveBeenCalledWith("/tmp/p1");
  });

  it("signals not-wired instead of completing a push that delivered nothing", async () => {
    // A repo with no Dolt remote RESOLVES the push (it isn't an error), but the write never left
    // this machine — completing here would settle the job done on undelivered work.
    const push = vi.fn(async (): Promise<SyncOutcome> => "not-wired");
    const handler = makeSyncPushHandler({ db: t.db, push });
    await expect(handler(fakeCtx({ payload: { projectId: "p1" } }))).rejects.toBeInstanceOf(
      SyncNotWiredError,
    );
  });

  it("propagates a push failure so the runner can retry/park", async () => {
    const push = vi.fn(async () => {
      throw new Error("bd dolt push failed: connection reset");
    });
    const handler = makeSyncPushHandler({ db: t.db, push });
    await expect(handler(fakeCtx({ payload: { projectId: "p1" } }))).rejects.toThrow(/push failed/);
  });

  it("poisons a vanished project so it parks at once instead of burning retries", async () => {
    const push = vi.fn(async (): Promise<SyncOutcome> => "synced");
    const handler = makeSyncPushHandler({ db: t.db, push });
    await expect(
      handler(fakeCtx({ payload: { projectId: "gone" }, projectId: "gone" })),
    ).rejects.toBeInstanceOf(PoisonError);
    expect(push).not.toHaveBeenCalled();
  });
});

describe("sync-push durability (runner + real coalescer)", () => {
  const CONFIG: RunnerConfig = {
    ...DEFAULT_CONFIG,
    leaseMs: 10_000,
    maxAttempts: 3,
    backoffBaseMs: 1_000,
    backoffMaxMs: 60_000,
    maxConcurrent: 2,
    tickMs: 1_000,
  };

  it("retries with backoff and PARKS after exhausting the retry budget", async () => {
    const clock = new FakeClock(1_700_000_000_000);
    const push = async () => {
      throw new Error("remote unreachable");
    };
    const runner = new JobRunner({ db: t.db, clock, config: CONFIG });
    runner.registerHandler("sync-push", makeSyncPushHandler({ db: t.db, push }));

    const id = enqueueSyncPushDeduped(t.db, clock, "p1");

    // Attempt 1 → reschedule (backoff 1s)
    await runner.tickOnce();
    await runner.whenIdle();
    let job = await getJob(t.db, id);
    expect(job?.status).toBe("queued");
    expect(job?.attempts).toBe(1);

    // Attempt 2 → reschedule (backoff 2s)
    clock.advance(2_000);
    await runner.tickOnce();
    await runner.whenIdle();
    job = await getJob(t.db, id);
    expect(job?.status).toBe("queued");
    expect(job?.attempts).toBe(2);

    // Attempt 3 hits maxAttempts → PARK (visible, resumable)
    clock.advance(5_000);
    await runner.tickOnce();
    await runner.whenIdle();
    job = await getJob(t.db, id);
    expect(job?.status).toBe("parked");
    expect(job?.lastError).toMatch(/remote unreachable/);

    // Resume re-queues the parked job with a fresh budget — the recovery path a human triggers.
    expect(await runner.resume(id)).toBe(true);
    job = await getJob(t.db, id);
    expect(job?.status).toBe("queued");
    expect(job?.attempts).toBe(0);
  });

  it("keeps a not-wired project's job pending (no attempt burn) and delivers once a remote is wired", async () => {
    const clock = new FakeClock(1_700_000_000_000);
    let wired = false;
    const pushes: string[] = [];
    const coalescer = createDoltSync(async (cwd, args) => {
      if (!wired) {
        throw Object.assign(new Error("bd"), { stderr: "No remote is configured — skipping.\n" });
      }
      if (args[1] === "push") pushes.push(cwd);
      return "";
    });

    const runner = new JobRunner({ db: t.db, clock, config: CONFIG });
    runner.registerHandler(
      "sync-push",
      makeSyncPushHandler({ db: t.db, push: (cwd) => coalescer(cwd, "push") }),
    );
    const id = enqueueSyncPushDeduped(t.db, clock, "p1");

    // No remote: nothing was published, so the job must NOT settle done — it stays queued for a
    // recheck, and the attempt is refunded so a local-only project never parks a queue for a human.
    await runner.tickOnce();
    await runner.whenIdle();
    let job = await getJob(t.db, id);
    expect(job?.status).toBe("queued");
    expect(job?.attempts).toBe(0);
    expect(job?.lastError).toMatch(/not wired/i);
    expect(pushes).toEqual([]);

    // Rechecks stay on the slow cadence rather than spinning at the retry backoff.
    clock.advance(CONFIG.backoffMaxMs);
    await runner.tickOnce();
    await runner.whenIdle();
    expect((await getJob(t.db, id))?.status).toBe("queued");

    // A human wires the remote (`anton init`): the very next recheck delivers and completes.
    wired = true;
    clock.advance(CONFIG.notWiredRetryMs);
    await runner.tickOnce();
    await runner.whenIdle();
    job = await getJob(t.db, id);
    expect(job?.status).toBe("done");
    expect(pushes).toEqual(["/tmp/p1"]);
  });

  it("completes when the push pass is a no-op on a caught-up repo", async () => {
    // Mirror production: the handler forces a full "push" pass unconditionally. On a caught-up,
    // reconciled repo that push lands nothing (bd dolt push is a clean exit 0) — the job still
    // completes done, idempotently. (The handler uses "push", NOT "backstop", precisely so a
    // still-in-flight write can't snapshot count 0 and drop it to pull-only.)
    const clock = new FakeClock(1_700_000_000_000);
    const coalescer = createDoltSync(async () => ""); // every bd step is a clean no-op
    // Reconcile the repo once (a full pass) so the state registry is caught up before the job runs.
    await coalescer("/tmp/p1", "full");

    const runner = new JobRunner({ db: t.db, clock, config: CONFIG });
    runner.registerHandler(
      "sync-push",
      makeSyncPushHandler({ db: t.db, push: (cwd) => coalescer(cwd, "push") }),
    );
    const id = enqueueSyncPushDeduped(t.db, clock, "p1");
    await runner.tickOnce();
    await runner.whenIdle();
    expect((await getJob(t.db, id))?.status).toBe("done");
  });
});

describe("no double-push against the E1 backstop (anton-nowq)", () => {
  it("a job push and a concurrent heartbeat backstop never overlap on the same repo", async () => {
    let inPush = 0;
    let maxConcurrentPush = 0;
    let pushes = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    // Shared per-repo coalescer — the SAME one E1's heartbeat and the durable job both route through.
    const coalescer = createDoltSync(async (_cwd, args) => {
      if (args[1] === "push") {
        pushes += 1;
        inPush += 1;
        maxConcurrentPush = Math.max(maxConcurrentPush, inPush);
        if (pushes === 1) await gate; // hold the first push so a second would overlap if uncoalesced
        inPush -= 1;
      }
      return "";
    });

    const handler = makeSyncPushHandler({
      db: t.db,
      push: (cwd) => coalescer(cwd, "push"), // the durable job forces a push
    });

    // Fire the job's push and the E1 heartbeat backstop concurrently at the same repo.
    const jobPush = handler(fakeCtx({ payload: { projectId: "p1" } }));
    const heartbeat = coalescer("/tmp/p1", "backstop");

    release();
    await Promise.all([jobPush, heartbeat]);

    // The coalescer serializes them: pushes never ran at the same time (no Dolt manifest corruption).
    expect(maxConcurrentPush).toBe(1);
  });
});
