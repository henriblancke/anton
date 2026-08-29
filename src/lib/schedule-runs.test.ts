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
  const row = (over: Partial<Parameters<typeof runs.toScheduleLastRun>[0]> = {}) => ({
    status: "done",
    outcome: "ok" as string | null,
    outcomeNote: null as string | null,
    lastError: null as string | null,
    at: NOW,
    ...over,
  });

  it("reads a job that changed something as ok, carrying its note", () => {
    expect(runs.toScheduleLastRun(row({ outcomeNote: "closed 2 gate(s)" }))).toEqual({
      outcome: "ok",
      at: NOW,
      note: "closed 2 gate(s)",
    });
  });

  it("keeps 'ran and did nothing' separate from both success and failure", () => {
    expect(runs.toScheduleLastRun(row({ outcome: "noop", outcomeNote: "no gate closed" }))).toEqual({
      outcome: "noop",
      at: NOW,
      note: "no gate closed",
    });
  });

  it("reads a parked job as failed, carrying why", () => {
    const got = runs.toScheduleLastRun(row({ status: "parked", outcome: null, lastError: "bd exited 1" }));
    expect(got).toEqual({ outcome: "failed", at: NOW, note: "bd exited 1" });
  });

  it("reads a failed job as failed", () => {
    expect(runs.toScheduleLastRun(row({ status: "failed", outcome: null })).outcome).toBe("failed");
  });

  // An operator killing a job is neither a result nor a fault; folding it into either would put a
  // red row in front of the person who caused it deliberately.
  it("keeps an operator cancel out of the failure count", () => {
    expect(runs.toScheduleLastRun(row({ status: "cancelled", outcome: null })).outcome).toBe(
      "cancelled",
    );
  });

  // Rows that settled before the outcome column existed, and handlers that report no effect, are
  // the same claim: it ran and did not fail. That is `ok`, and nothing more.
  it("reads a completed job with no reported outcome as ok with no note", () => {
    expect(runs.toScheduleLastRun(row({ outcome: null }))).toEqual({ outcome: "ok", at: NOW });
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
    expect(byId["s-1"]).toEqual({ outcome: "noop", at: NOW - 60, note: "no gate closed" });
    expect(byId["s-2"]).toEqual({
      outcome: "failed",
      at: NOW - 10,
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
      note: "closed 1 gate(s)",
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
      note: "no gate closed",
    });
    expect(byType["gardener"].lastRun).toBeUndefined();
  });
});
