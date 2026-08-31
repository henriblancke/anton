/**
 * The schedule → last-fire join (anton-znoz). Two halves, tested apart:
 *   • the mapper, which decides WHICH of the four claims a settled job row makes; and
 *   • the grouped read over a real migrated anton.db, because "the newest settled fire per schedule"
 *     rests on SQLite's min/max bare-column rule — a property no in-memory stand-in would prove.
 *
 * Plus the one thing an operator actually sees: `listSchedules`, the read every Automation-table
 * path goes through, carrying the outcome alongside the row.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makeFileDb, type FileDb } from "@/lib/testing/integration";

let fileDb: FileDb;
let runs: typeof import("./schedule-runs");
let listSchedules: typeof import("./schedules").listSchedules;
let getDb: typeof import("./db").getDb;
let schema: typeof import("./db/schema");

const PROJECT_ID = "p-sched";
const NOW = 1_800_000_000;
const CLOCK = { now: () => NOW * 1000 };

beforeAll(async () => {
  fileDb = makeFileDb();
  runs = await import("./schedule-runs");
  listSchedules = (await import("./schedules")).listSchedules;
  getDb = (await import("./db")).getDb;
  schema = await import("./db/schema");
  await getDb()
    .insert(schema.projects)
    .values({ id: PROJECT_ID, slug: "sched", name: "sched", repoPath: "/tmp/sched" });
});

afterAll(() => fileDb.cleanup());

describe("toScheduleLastRun", () => {
  // Enqueue and settlement are deliberately different instants: the mapper must carry BOTH, since
  // the UI matches the fire on when it was enqueued and dates it by when it settled.
  const ENQUEUED = NOW - 30;
  const row = (over: Partial<Parameters<typeof runs.toScheduleLastRun>[0]> = {}) => ({
    status: "done",
    outcome: "ok" as string | null,
    outcomeNote: null as string | null,
    lastError: null as string | null,
    at: NOW,
    enqueuedAt: ENQUEUED,
    ...over,
  });

  it("reads a job that changed something as ok, carrying its note", () => {
    expect(runs.toScheduleLastRun(row({ outcomeNote: "closed 2 gate(s)" }))).toEqual({
      outcome: "ok",
      at: NOW,
      enqueuedAt: ENQUEUED,
      note: "closed 2 gate(s)",
    });
  });

  it("keeps 'ran and did nothing' separate from both success and failure", () => {
    expect(runs.toScheduleLastRun(row({ outcome: "noop", outcomeNote: "no gate closed" }))).toEqual({
      outcome: "noop",
      at: NOW,
      enqueuedAt: ENQUEUED,
      note: "no gate closed",
    });
  });

  it("reads a parked job as failed, carrying why", () => {
    const got = runs.toScheduleLastRun(row({ status: "parked", outcome: null, lastError: "bd exited 1" }));
    expect(got).toEqual({ outcome: "failed", at: NOW, enqueuedAt: ENQUEUED, note: "bd exited 1" });
  });

  it("reads a failed job as failed", () => {
    expect(runs.toScheduleLastRun(row({ status: "failed", outcome: null })).outcome).toBe("failed");
  });

  // An operator killing a job is neither a result nor a fault; folding it into either would put a
  // red row in front of the person who caused it deliberately.
  it("keeps an operator cancel out of the failure count", () => {
    expect(runs.toScheduleLastRun(row({ status: "cancelled", outcome: null }))).toEqual({
      outcome: "cancelled",
      at: NOW,
      enqueuedAt: ENQUEUED,
    });
  });

  // Rows that settled before the outcome column existed, and handlers that report no effect, are
  // the same claim: it ran and did not fail. That is `ok`, and nothing more.
  it("reads a completed job with no reported outcome as ok with no note", () => {
    expect(runs.toScheduleLastRun(row({ outcome: null }))).toEqual({
      outcome: "ok",
      at: NOW,
      enqueuedAt: ENQUEUED,
    });
  });
});

describe("summarizeNote", () => {
  it("keeps only the first line of a multi-line error", () => {
    expect(runs.summarizeNote("bd exited 1\n  at foo()\n  at bar()")).toBe("bd exited 1");
  });

  it("clips a long line rather than letting it run the column", () => {
    const note = runs.summarizeNote("x".repeat(200));
    expect(note).toHaveLength(90);
    expect(note?.endsWith("…")).toBe(true);
  });

  it("treats empty and missing text alike", () => {
    expect(runs.summarizeNote("   ")).toBeUndefined();
    expect(runs.summarizeNote(null)).toBeUndefined();
  });
});

describe("lastRunsBySchedule", () => {
  let seq = 0;

  async function job(over: {
    scheduleId?: string;
    status: string;
    outcome?: string | null;
    outcomeNote?: string | null;
    lastError?: string | null;
    updatedAt: number;
    /** When the scheduler ENQUEUED it. Defaults to its settlement time. */
    createdAt?: number;
    projectId?: string;
  }) {
    const id = `j-${(seq += 1)}`;
    await getDb()
      .insert(schema.jobs)
      .values({
        id,
        type: "gate-check",
        projectId: over.projectId ?? PROJECT_ID,
        payloadJson: JSON.stringify(
          over.scheduleId ? { projectId: PROJECT_ID, scheduleId: over.scheduleId } : { projectId: PROJECT_ID },
        ),
        status: over.status,
        runAt: new Date(over.updatedAt * 1000),
        attempts: 1,
        outcome: over.outcome ?? null,
        outcomeNote: over.outcomeNote ?? null,
        lastError: over.lastError ?? null,
        createdAt: new Date((over.createdAt ?? over.updatedAt) * 1000),
        updatedAt: new Date(over.updatedAt * 1000),
      });
    return id;
  }

  it("answers with the NEWEST settled fire per schedule, and ignores everything else", async () => {
    // Two fires of the same schedule, an older one that did work and a newer one that did not.
    await job({ scheduleId: "s-1", status: "done", outcome: "ok", outcomeNote: "closed 2 gate(s)", updatedAt: NOW - 3600 });
    await job({ scheduleId: "s-1", status: "done", outcome: "noop", outcomeNote: "no gate closed", updatedAt: NOW - 60 });
    // A fire still in flight is not an outcome yet.
    await job({ scheduleId: "s-1", status: "running", updatedAt: NOW });
    // A different schedule, and a job no schedule fired (execute-epic and friends).
    await job({ scheduleId: "s-2", status: "parked", lastError: "gh: not authenticated", updatedAt: NOW - 10 });
    await job({ status: "done", outcome: "ok", updatedAt: NOW });

    const byId = await runs.lastRunsBySchedule(PROJECT_ID);

    expect(Object.keys(byId).sort()).toEqual(["s-1", "s-2"]);
    expect(byId["s-1"]).toEqual({
      outcome: "noop",
      at: NOW - 60,
      enqueuedAt: NOW - 60,
      note: "no gate closed",
    });
    expect(byId["s-2"]).toEqual({
      outcome: "failed",
      at: NOW - 10,
      enqueuedAt: NOW - 10,
      note: "gh: not authenticated",
    });
  });

  // A parked fire an operator resumes settles LATER than every fire since, so ordering on the
  // settlement time would let last week's result displace this hour's. The fire is picked by when
  // it was enqueued; only its date on screen comes from when it settled.
  it("picks the newest fire by enqueue time, not by which settled last", async () => {
    await job({
      scheduleId: "s-resumed",
      status: "failed",
      lastError: "bd exited 1",
      createdAt: NOW - 7 * 86_400,
      updatedAt: NOW, // resumed by hand today, long after the fire below
    });
    await job({
      scheduleId: "s-resumed",
      status: "done",
      outcome: "ok",
      outcomeNote: "closed 1 gate(s)",
      createdAt: NOW - 3600,
      updatedAt: NOW - 3500,
    });

    const byId = await runs.lastRunsBySchedule(PROJECT_ID);
    expect(byId["s-resumed"]).toEqual({
      outcome: "ok",
      at: NOW - 3500,
      enqueuedAt: NOW - 3600,
      note: "closed 1 gate(s)",
    });
  });

  // The case the enqueue time exists for: the newest fire is still RUNNING, so the only settled row
  // is an old one an operator resumed today. Its settlement time is newer than the running fire's
  // enqueue; only its own enqueue time can tell the UI this outcome is not that fire's.
  it("dates a resumed fire by its enqueue time even when it settled after a newer fire started", async () => {
    await job({
      scheduleId: "s-inflight",
      status: "failed",
      lastError: "bd exited 1",
      createdAt: NOW - 7 * 86_400,
      updatedAt: NOW - 30,
    });
    await job({ scheduleId: "s-inflight", status: "running", createdAt: NOW - 120, updatedAt: NOW - 120 });

    expect((await runs.lastRunsBySchedule(PROJECT_ID))["s-inflight"]).toEqual({
      outcome: "failed",
      at: NOW - 30,
      enqueuedAt: NOW - 7 * 86_400,
      note: "bd exited 1",
    });
  });

  it("is scoped to one project", async () => {
    await getDb()
      .insert(schema.projects)
      .values({ id: "p-other", slug: "other", name: "other", repoPath: "/tmp/other" });
    await job({ scheduleId: "s-other", status: "done", outcome: "ok", updatedAt: NOW, projectId: "p-other" });

    expect(await runs.lastRunsBySchedule(PROJECT_ID)).not.toHaveProperty("s-other");
    expect(Object.keys(await runs.lastRunsBySchedule("p-other"))).toEqual(["s-other"]);
  });

  it("returns nothing for a project whose schedules have never fired", async () => {
    await getDb()
      .insert(schema.projects)
      .values({ id: "p-quiet", slug: "quiet", name: "quiet", repoPath: "/tmp/quiet" });
    expect(await runs.lastRunsBySchedule("p-quiet")).toEqual({});
  });
});

describe("listSchedules carries the last fire's outcome", () => {
  it("hands the UI read path the row AND what came of it", async () => {
    await getDb()
      .insert(schema.projects)
      .values({ id: "p-ui", slug: "ui", name: "ui", repoPath: "/tmp/ui" });
    await getDb().insert(schema.schedules).values([
      {
        id: "sched-ran",
        projectId: "p-ui",
        type: "gate-check",
        cron: "*/10 * * * *",
        enabled: true,
        lastRunAt: new Date((NOW - 600) * 1000),
      },
      // Never fired: the row exists, so it has a cadence but no outcome to state.
      { id: "sched-idle", projectId: "p-ui", type: "gardener", cron: "0 5 * * *", enabled: false },
    ]);
    await getDb()
      .insert(schema.jobs)
      .values({
        id: "job-ui",
        type: "gate-check",
        projectId: "p-ui",
        payloadJson: JSON.stringify({ projectId: "p-ui", scheduleId: "sched-ran" }),
        status: "done",
        outcome: "noop",
        outcomeNote: "no gate closed",
        runAt: new Date((NOW - 600) * 1000),
        createdAt: new Date((NOW - 600) * 1000),
        updatedAt: new Date((NOW - 600) * 1000),
      });

    const byType = Object.fromEntries((await listSchedules("p-ui")).map((s) => [s.type, s]));
    expect(byType["gate-check"].lastRun).toEqual({
      outcome: "noop",
      at: NOW - 600,
      enqueuedAt: NOW - 600,
      note: "no gate closed",
    });
    expect(byType["gardener"].lastRun).toBeUndefined();
  });

  // The switch cannot say whether a disabled schedule's fire is paused or still executing — the
  // runner gates the claim, not the handler — so the read path has to carry the job's own status.
  it("hands the UI read path where an unsettled fire actually sits", async () => {
    await getDb()
      .insert(schema.projects)
      .values({ id: "p-live", slug: "live", name: "live", repoPath: "/tmp/live" });
    await getDb().insert(schema.schedules).values([
      // Switched off with its fire already leased: the handler runs on regardless.
      {
        id: "sched-leased",
        projectId: "p-live",
        type: "gate-check",
        cron: "*/10 * * * *",
        enabled: false,
        lastRunAt: new Date((NOW - 120) * 1000),
      },
      { id: "sched-quiet", projectId: "p-live", type: "gardener", cron: "0 5 * * *", enabled: true },
    ]);
    await getDb()
      .insert(schema.jobs)
      .values({
        id: "job-live",
        type: "gate-check",
        projectId: "p-live",
        payloadJson: JSON.stringify({ projectId: "p-live", scheduleId: "sched-leased" }),
        status: "running",
        leaseExpiresAt: new Date((NOW + 60) * 1000),
        runAt: new Date((NOW - 120) * 1000),
        createdAt: new Date((NOW - 120) * 1000),
        updatedAt: new Date((NOW - 120) * 1000),
      });

    const byType = Object.fromEntries(
      (await listSchedules("p-live", CLOCK)).map((s) => [s.type, s]),
    );
    expect(byType["gate-check"].pendingRun).toBe("running");
    expect(byType["gardener"].pendingRun).toBeUndefined();
  });
});

/**
 * Where an unsettled fire sits (anton-znoz). The Automation table reads "in progress" off this and
 * not off the enabled flag: the runner gates only the CLAIM on that flag, so an off schedule can
 * hold a queued job that nothing is running AND a leased job that very much is.
 */
describe("pendingRunsBySchedule", () => {
  const PENDING_PROJECT = "p-pending";
  let seq = 0;

  /** A `running` job defaults to a live lease — that is what "a worker holds it" means here. */
  async function pendingJob(over: {
    scheduleId?: string;
    status: string;
    projectId?: string;
    leaseExpiresAt?: Date | null;
  }) {
    const id = `pj-${(seq += 1)}`;
    const projectId = over.projectId ?? PENDING_PROJECT;
    const lease =
      over.leaseExpiresAt !== undefined
        ? over.leaseExpiresAt
        : over.status === "running"
          ? new Date((NOW + 60) * 1000)
          : null;
    await getDb()
      .insert(schema.jobs)
      .values({
        id,
        type: "gate-check",
        projectId,
        payloadJson: JSON.stringify(
          over.scheduleId ? { projectId, scheduleId: over.scheduleId } : { projectId },
        ),
        status: over.status,
        leaseExpiresAt: lease,
        runAt: new Date(NOW * 1000),
        createdAt: new Date(NOW * 1000),
        updatedAt: new Date(NOW * 1000),
      });
    return id;
  }

  beforeAll(async () => {
    await getDb()
      .insert(schema.projects)
      .values({ id: PENDING_PROJECT, slug: "pending", name: "pending", repoPath: "/tmp/pending" });
  });

  it("reports the leased fire, the waiting one, and nothing for a settled schedule", async () => {
    await pendingJob({ scheduleId: "p-running", status: "running" });
    await pendingJob({ scheduleId: "p-queued", status: "queued" });
    await pendingJob({ scheduleId: "p-settled", status: "done" });
    // A job no schedule fired (execute-epic and friends) belongs to no row here.
    await pendingJob({ status: "running" });

    const byId = await runs.pendingRunsBySchedule(PENDING_PROJECT, CLOCK);
    expect(byId).toEqual({ "p-running": "running", "p-queued": "queued" });
  });

  // With both behind one schedule, work IS running; answering "queued" would understate it and let
  // the UI call a live handler held.
  it("lets a leased fire outrank a queued one on the same schedule", async () => {
    await pendingJob({ scheduleId: "p-both", status: "queued" });
    await pendingJob({ scheduleId: "p-both", status: "running" });
    await pendingJob({ scheduleId: "p-both", status: "queued" });

    expect((await runs.pendingRunsBySchedule(PENDING_PROJECT, CLOCK))["p-both"]).toBe("running");
  });

  // The `running` status outlives the worker: a handler killed mid-flight leaves it stamped with a
  // lease nobody renews, and a DISABLED schedule's bucket is excluded from reclamation, so nothing
  // ever moves the row. Reading the status alone would have the table claim work in progress
  // forever.
  it("does not call an abandoned fire running once its lease has expired", async () => {
    await pendingJob({
      scheduleId: "p-dead",
      status: "running",
      leaseExpiresAt: new Date((NOW - 60) * 1000),
    });
    await pendingJob({ scheduleId: "p-unleased", status: "running", leaseExpiresAt: null });

    const byId = await runs.pendingRunsBySchedule(PENDING_PROJECT, CLOCK);
    expect(byId["p-dead"]).toBe("queued");
    expect(byId["p-unleased"]).toBe("queued");
  });

  // Freshness decides, not row order: a live fire still outranks a dead one behind the same
  // schedule, and a dead one must not shout down a live one.
  it("lets a live fire outrank an abandoned one on the same schedule", async () => {
    await pendingJob({
      scheduleId: "p-mixed",
      status: "running",
      leaseExpiresAt: new Date((NOW - 60) * 1000),
    });
    await pendingJob({ scheduleId: "p-mixed", status: "running" });

    expect((await runs.pendingRunsBySchedule(PENDING_PROJECT, CLOCK))["p-mixed"]).toBe("running");
  });

  it("is scoped to one project", async () => {
    await getDb()
      .insert(schema.projects)
      .values({ id: "p-elsewhere", slug: "elsewhere", name: "elsewhere", repoPath: "/tmp/elsewhere" });
    await pendingJob({ scheduleId: "p-far", status: "running", projectId: "p-elsewhere" });

    expect(await runs.pendingRunsBySchedule(PENDING_PROJECT, CLOCK)).not.toHaveProperty("p-far");
    expect(Object.keys(await runs.pendingRunsBySchedule("p-elsewhere", CLOCK))).toEqual(["p-far"]);
  });
});
