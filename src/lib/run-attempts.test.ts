/**
 * The per-attempt run record (anton-rnrdr): the intervals `runs` cannot keep, and the fold that turns
 * them into wall time including retries.
 *
 * The failure it exists to prevent: `runs.attempt_started_at` is REWRITTEN on every resume, so a run
 * that parked twice before delivering carries only its last attempt's start beside a final `ended_at`
 * — and `endedAt − attemptStartedAt` over that row reports the last attempt's duration while calling
 * itself wall time, understating precisely the runs that struggled most. These cases walk the real
 * write path (`createRun` / `updateRun`) rather than seeding rows, because the whole point is that a
 * resume writes a NEW row where the old behaviour overwrote one.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeTestDb, type TestDb } from "./db/testing";
import * as schema from "./db/schema";
import { createRun, settleParkedRun, updateRun } from "./runs";
import {
  attemptIntervals,
  attemptWallMs,
  listRunAttempts,
  recordAttemptEnd,
  recordAttemptStart,
  runWallMs,
} from "./run-attempts";
import type { AntonDb, Clock } from "./jobs/queue";

let t: TestDb;
const PROJECT = "p1";
const EPIC = "anton-abc";
const T0 = 1_800_000_000_000;
const MIN = 60_000;

/** A clock the cases drive by hand, so the intervals under test are exact rather than elapsed. */
function clockAt(start: number): Clock & { set: (ms: number) => void } {
  let ms = start;
  return { now: () => ms, set: (next: number) => (ms = next) };
}

const clock = clockAt(T0);

beforeEach(async () => {
  t = makeTestDb();
  clock.set(T0);
  await t.db.insert(schema.projects).values({
    id: PROJECT,
    slug: "p1",
    name: "P1",
    repoPath: "/repo",
  });
});
afterEach(() => t.close());

/** Open a run the way `startEpicRun` does on a fresh dispatch. */
async function start(id: string): Promise<string> {
  return createRun(t.db, clock, { id, projectId: PROJECT, epicBeadId: EPIC, status: "running" });
}

/** Resume a parked run exactly as `startEpicRun` does — the write that rewrites `attemptStartedAt`. */
async function resume(runId: string): Promise<void> {
  await updateRun(t.db, clock, runId, {
    status: "running",
    error: null,
    attemptStartedAt: clock.now(),
  });
}

describe("one row per attempt", () => {
  it("records a run that parks twice and then delivers as three summing intervals", async () => {
    await start("r1");
    // Attempt 1: 10 minutes, then a quota park. A park writes NO `endedAt` on the run row — the row
    // stays open for the resume — so only the attempt record carries this interval at all.
    clock.set(T0 + 10 * MIN);
    await updateRun(t.db, clock, "r1", { status: "parked", error: "usage-limit" });
    // Attempt 2: resumed 4 hours later (the overnight quota window), runs 20 minutes, parks again.
    clock.set(T0 + 250 * MIN);
    await resume("r1");
    clock.set(T0 + 270 * MIN);
    await updateRun(t.db, clock, "r1", { status: "parked", error: "usage-limit" });
    // Attempt 3: resumed and delivered after 5 minutes.
    clock.set(T0 + 500 * MIN);
    await resume("r1");
    clock.set(T0 + 505 * MIN);
    await updateRun(t.db, clock, "r1", { status: "done", endedAt: clock.now() });

    const rows = await listRunAttempts(t.db, "r1");
    expect(attemptIntervals(rows).map((i) => [i.attempt, i.outcome])).toEqual([
      [1, "parked"],
      [2, "parked"],
      [3, "done"],
    ]);
    // 10 + 20 + 5 — the waiting between attempts is NOT wall time of the work, and the figure the
    // run row alone could produce (`endedAt − attemptStartedAt`) is the last attempt's 5 minutes.
    expect(await runWallMs(t.db, "r1")).toEqual({
      wallMs: 35 * MIN,
      attempts: 3,
      openAttempts: 0,
    });
  });

  it("gives a run that never retried one row equal to `ended - started`", async () => {
    await start("r1");
    clock.set(T0 + 42 * MIN);
    await updateRun(t.db, clock, "r1", { status: "done", endedAt: clock.now() });

    const rows = await listRunAttempts(t.db, "r1");
    expect(rows).toHaveLength(1);
    const run = (await t.db.select().from(schema.runs))[0]!;
    const rowInterval =
      (run.endedAt!.getTime() - run.startedAt!.getTime());
    expect(await runWallMs(t.db, "r1")).toEqual({
      wallMs: rowInterval,
      attempts: 1,
      openAttempts: 0,
    });
  });

  it("appends on resume rather than overwriting the previous attempt's interval", async () => {
    await start("r1");
    clock.set(T0 + 7 * MIN);
    await updateRun(t.db, clock, "r1", { status: "parked", error: "usage-limit" });
    const afterPark = await listRunAttempts(t.db, "r1");

    clock.set(T0 + 100 * MIN);
    await resume("r1");

    const afterResume = await listRunAttempts(t.db, "r1");
    expect(afterResume).toHaveLength(2);
    // The first row is byte-identical to what the park left: append-only means a later attempt can
    // never revise an earlier one's interval.
    expect(afterResume[0]).toEqual(afterPark[0]);
    expect(afterResume[1]!.endedAt).toBeNull();
    expect(afterResume[1]!.outcome).toBeNull();
  });

  it("leaves `runs.attempt_started_at` meaning exactly what it meant — the CURRENT attempt", async () => {
    await start("r1");
    clock.set(T0 + 7 * MIN);
    await updateRun(t.db, clock, "r1", { status: "parked", error: "usage-limit" });
    clock.set(T0 + 100 * MIN);
    await resume("r1");

    // What the repair weigher reads (gardener/repair.ts): the RESUMED attempt's start, not the run's.
    const run = (await t.db.select().from(schema.runs))[0]!;
    expect(run.attemptStartedAt!.getTime()).toBe(T0 + 100 * MIN);
    expect(run.startedAt!.getTime()).toBe(T0);
  });

  it("does not stretch an abandoned park's interval across the wait for the abandon", async () => {
    await start("r1");
    clock.set(T0 + 3 * MIN);
    await updateRun(t.db, clock, "r1", { status: "parked", error: "review-blocked" });
    // Hours later a person abandons the target and `settleParkedRun` flips the row to `failed`
    // (anton-wvcy). That is bookkeeping about a run which stopped executing at +3min — the park
    // already closed its attempt, and a second close here would report the whole wait as work.
    clock.set(T0 + 600 * MIN);

    expect(await settleParkedRun(t.db, clock, PROJECT, "r1", "target abandoned")).toBe(true);

    expect(await runWallMs(t.db, "r1")).toEqual({
      wallMs: 3 * MIN,
      attempts: 1,
      openAttempts: 0,
    });
    expect((await listRunAttempts(t.db, "r1"))[0]!.outcome).toBe("parked");
  });

  it("does not revise a settled attempt when a terminal status is written twice", async () => {
    await start("r1");
    clock.set(T0 + 10 * MIN);
    await updateRun(t.db, clock, "r1", { status: "done", endedAt: clock.now() });
    // Recovery re-settles an already-done row (execute-epic-recover.ts), and a park's corrective
    // write follows its first. Neither is a new attempt, and neither may move the interval.
    clock.set(T0 + 99 * MIN);
    await updateRun(t.db, clock, "r1", { status: "done", endedAt: clock.now(), error: null });

    expect(await runWallMs(t.db, "r1")).toEqual({
      wallMs: 10 * MIN,
      attempts: 1,
      openAttempts: 0,
    });
  });

  it("records nothing for a mid-attempt patch that settles nothing", async () => {
    await start("r1");
    await updateRun(t.db, clock, "r1", { status: "running", ticketBeadId: "anton-t1" });
    await updateRun(t.db, clock, "r1", { reviewScore: 8 });

    expect(await listRunAttempts(t.db, "r1")).toHaveLength(1);
  });

  it("closes the most recently opened attempt when two are open at once", async () => {
    // Mirrors reconcileInterruptedRuns leaving a crashed `running` row's attempt open when its job is
    // about to be re-dispatched (runs.ts), then the resume opening a second attempt on top of it
    // (execute-epic-start.ts) — two open rows for one run. The settle that follows must close the
    // attempt that actually ran (the newest), not the stale crashed one left open by the reconciler.
    await start("r1");
    clock.set(T0 + 5 * MIN);
    await recordAttemptStart(t.db, clock, { runId: "r1" });
    clock.set(T0 + 15 * MIN);
    await updateRun(t.db, clock, "r1", { status: "done", endedAt: clock.now() });

    const rows = await listRunAttempts(t.db, "r1");
    expect(rows.map((r) => [r.attempt, r.outcome, r.endedAt !== null])).toEqual([
      [1, null, false],
      [2, "done", true],
    ]);
    expect(await runWallMs(t.db, "r1")).toEqual({
      wallMs: 10 * MIN,
      attempts: 2,
      openAttempts: 1,
    });
  });

  it("keeps two runs' attempts apart", async () => {
    await start("r1");
    await start("r2");
    clock.set(T0 + 5 * MIN);
    await updateRun(t.db, clock, "r1", { status: "failed", endedAt: clock.now() });

    expect(await runWallMs(t.db, "r1")).toMatchObject({ wallMs: 5 * MIN, attempts: 1 });
    expect(await runWallMs(t.db, "r2")).toMatchObject({ attempts: 1, openAttempts: 1 });
  });
});

describe("recording never fails the run", () => {
  /** A db whose every `run_attempts` write rejects — a locked database, a schema not yet migrated. */
  function brokenDb(): AntonDb {
    return {
      select: () => {
        throw new Error("SQLITE_BUSY: database is locked");
      },
      insert: () => {
        throw new Error("SQLITE_BUSY: database is locked");
      },
      update: () => {
        throw new Error("SQLITE_BUSY: database is locked");
      },
    } as unknown as AntonDb;
  }

  it("swallows a start write that throws", async () => {
    await expect(
      recordAttemptStart(brokenDb(), clock, { runId: "r1", projectId: PROJECT }),
    ).resolves.toBeUndefined();
  });

  it("swallows an end write that throws", async () => {
    await expect(recordAttemptEnd(brokenDb(), clock, "r1", "failed")).resolves.toBeUndefined();
  });

  it("settles the run row even when the attempt record cannot be written", async () => {
    await start("r1");
    // The table disappears underneath a live run — the sharpest form of a write that cannot land.
    t.sqlite.exec("DROP TABLE run_attempts");
    clock.set(T0 + 9 * MIN);

    await expect(
      updateRun(t.db, clock, "r1", { status: "done", endedAt: clock.now() }),
    ).resolves.toBeUndefined();

    // The run itself settled — which is the whole contract: a meter must not cost a delivery.
    const run = (await t.db.select().from(schema.runs))[0]!;
    expect(run.status).toBe("done");
    expect(run.endedAt!.getTime()).toBe(T0 + 9 * MIN);
  });

  it("opens a run even when the first attempt's record cannot be written", async () => {
    t.sqlite.exec("DROP TABLE run_attempts");

    await expect(start("r1")).resolves.toBe("r1");
    expect((await t.db.select().from(schema.runs))[0]!.status).toBe("running");
  });
});

describe("attemptWallMs", () => {
  it("reports nothing recorded rather than zero", () => {
    // A run that settled before this table existed. Zero would read as "it took no time", which is
    // the opposite fact — the same rule as the ledger's unpriced-is-not-zero.
    expect(attemptWallMs([])).toBeUndefined();
  });

  it("counts an unclosed attempt without letting it contribute an interval", () => {
    // A crash or a `kill -9` leaves a row with no end. The sum is visibly partial rather than short.
    expect(
      attemptWallMs([
        { attempt: 1, startedAt: 100, endedAt: 160 },
        { attempt: 2, startedAt: 200 },
      ]),
    ).toEqual({ wallMs: 60_000, attempts: 2, openAttempts: 1 });
  });

  it("never reports a negative duration", () => {
    // The timestamps are whole-second, so a sub-second attempt can round to a negative delta.
    expect(attemptWallMs([{ attempt: 1, startedAt: 160, endedAt: 159 }])).toEqual({
      wallMs: 0,
      attempts: 1,
      openAttempts: 0,
    });
  });

  it("sums rather than unions, because a run's attempts cannot overlap", () => {
    // Unlike the ledger's `activeMs` over concurrent invocations: a resume only happens once the
    // previous attempt has settled, so two intervals that look overlapping are two real attempts.
    expect(
      attemptWallMs([
        { attempt: 1, startedAt: 100, endedAt: 200 },
        { attempt: 2, startedAt: 150, endedAt: 250 },
      ])?.wallMs,
    ).toBe(200_000);
  });
});

describe("the ordinal", () => {
  it("is dense and 1-based per run, independent of `runs.attempts`", async () => {
    await start("r1");
    // `runs.attempts` is the QUEUE's delivery count (`ctx.attempt`), stamped from a different clock —
    // a redelivery without a resume moves it and opens no attempt here.
    await updateRun(t.db, clock, "r1", { attempts: 7 });
    clock.set(T0 + MIN);
    await updateRun(t.db, clock, "r1", { status: "parked", error: "usage-limit" });
    clock.set(T0 + 2 * MIN);
    await resume("r1");

    expect((await listRunAttempts(t.db, "r1")).map((r) => r.attempt)).toEqual([1, 2]);
  });

  it("carries the project on every attempt, including the ones a resume opens", async () => {
    await start("r1");
    clock.set(T0 + MIN);
    await updateRun(t.db, clock, "r1", { status: "parked", error: "usage-limit" });
    clock.set(T0 + 2 * MIN);
    // A resume patches the existing row and never restates its project, so this one is resolved from
    // the run rather than passed in — every row stands on its own.
    await resume("r1");

    expect((await listRunAttempts(t.db, "r1")).map((r) => r.projectId)).toEqual([PROJECT, PROJECT]);
  });
});

describe("clock discipline", () => {
  it("stores whole seconds, like every other timestamp anton writes", async () => {
    clock.set(T0 + 1_234);
    await start("r1");
    const row = (await listRunAttempts(t.db, "r1"))[0]!;
    expect(row.startedAt.getTime() % 1000).toBe(0);
  });

  it("takes the caller's instant for an end, not the write's", async () => {
    await start("r1");
    clock.set(T0 + 30 * MIN);
    // The settle's own `endedAt` is what the run row records, so the attempt must agree with it —
    // a park, by contrast, passes none and the attempt's end is the park instant.
    await updateRun(t.db, clock, "r1", { status: "failed", endedAt: T0 + 20 * MIN });

    expect(await runWallMs(t.db, "r1")).toMatchObject({ wallMs: 20 * MIN });
  });
});

describe("listRunAttempts", () => {
  it("is empty for a run with nothing recorded, and never throws", async () => {
    expect(await listRunAttempts(t.db, "nope")).toEqual([]);
    expect(await runWallMs(t.db, "nope")).toBeUndefined();
  });
});

// The suite drives its own clock; make sure no case leaks a fake timer into the next.
afterEach(() => vi.useRealTimers());
