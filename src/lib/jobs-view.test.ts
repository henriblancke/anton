/**
 * Pure-mapper tests for the jobs view (anton-ner.3): row→summary field extraction, epicBeadId
 * pulled from the JSON payload (tolerating malformed/absent payloads), timestamp normalization,
 * and the active/terminal split that groups parked/failed jobs for audit.
 *
 * Plus DB-backed tests for filtered paging (anton-mjdo.1): the filter lives in the SQL WHERE, so
 * `countJobs` and `listJobsPaged` must always agree about what the page is showing.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { countJobs, isActiveJob, listJobsPaged, toJobSummary, type JobFilters } from "./jobs-view";
import type { JobStatus, JobType } from "./jobs/queue";
import { applyMigrationsTo } from "./db/testing";
import type { schema } from "./db";

type JobRow = (typeof schema.jobs)["$inferSelect"];

function row(overrides: Partial<JobRow> = {}): JobRow {
  return {
    id: "j1",
    type: "review-fix",
    projectId: "p1",
    payloadJson: "{}",
    status: "done",
    runAt: new Date(1_000_000_000_000),
    leaseExpiresAt: null,
    attempts: 1,
    lastError: null,
    createdAt: new Date(1_000_000_000_000),
    updatedAt: new Date(1_000_000_060_000),
    ...overrides,
  } as JobRow;
}

describe("toJobSummary", () => {
  it("maps core fields and normalizes Date timestamps to epoch seconds", () => {
    const s = toJobSummary(row({ attempts: 3 }));
    expect(s).toMatchObject({
      id: "j1",
      type: "review-fix",
      status: "done",
      projectId: "p1",
      attempts: 3,
      createdAt: 1_000_000_000,
      updatedAt: 1_000_000_060,
    });
    expect(s.epicBeadId).toBeUndefined();
    expect(s.lastError).toBeUndefined();
  });

  it("extracts epicBeadId from the JSON payload", () => {
    const s = toJobSummary(row({ payloadJson: JSON.stringify({ projectId: "p1", epicBeadId: "anton-abc" }) }));
    expect(s.epicBeadId).toBe("anton-abc");
  });

  it("extracts scheduleId from a cron-enqueued payload (nightly-stringer etc.)", () => {
    const s = toJobSummary(row({ payloadJson: JSON.stringify({ projectId: "p1", scheduleId: "sched-9" }) }));
    expect(s.scheduleId).toBe("sched-9");
    expect(s.epicBeadId).toBeUndefined();
  });

  it("tolerates malformed or epic-less payloads without throwing", () => {
    expect(toJobSummary(row({ payloadJson: "not json" })).epicBeadId).toBeUndefined();
    expect(toJobSummary(row({ payloadJson: null as unknown as string })).epicBeadId).toBeUndefined();
    expect(toJobSummary(row({ payloadJson: JSON.stringify({ epicBeadId: 42 }) })).epicBeadId).toBeUndefined();
  });

  it("surfaces lastError for parked/failed jobs", () => {
    const s = toJobSummary(row({ status: "parked", lastError: "quota exhausted" }));
    expect(s.lastError).toBe("quota exhausted");
  });
});

describe("isActiveJob", () => {
  it("treats queued/running/parked as active and done/failed as terminal", () => {
    expect(isActiveJob("queued")).toBe(true);
    expect(isActiveJob("running")).toBe(true);
    expect(isActiveJob("parked")).toBe(true);
    expect(isActiveJob("done")).toBe(false);
    expect(isActiveJob("failed")).toBe(false);
  });
});

/** A mix of statuses and types, oldest first — index doubles as the activity ordering. */
const SEED: { status: JobStatus; type: JobType }[] = [
  { status: "queued", type: "execute-epic" },
  { status: "queued", type: "review-fix" },
  { status: "running", type: "execute-epic" },
  { status: "parked", type: "nightly-stringer" },
  { status: "done", type: "execute-epic" },
  { status: "done", type: "review-fix" },
  { status: "done", type: "orphan-grooming" },
  { status: "failed", type: "nightly-stringer" },
  { status: "cancelled", type: "execute-epic" },
];

const BASE_MS = 1_700_000_000_000;

describe("filtered paging", () => {
  let workDir: string;

  beforeAll(async () => {
    workDir = mkdtempSync(join(tmpdir(), "anton-jobs-view-test-"));
    const dbFile = join(workDir, "anton.db");
    process.env.ANTON_DB = dbFile;
    const setup = new Database(dbFile);
    applyMigrationsTo(setup);
    setup.close();

    // getDb() is lazy, so setting ANTON_DB above is enough — no module re-import needed.
    const { getDb, schema: dbSchema } = await import("./db");
    const db = getDb();
    for (const id of ["p1", "p2"]) {
      await db.insert(dbSchema.projects).values({ id, slug: id, name: id, repoPath: `/tmp/${id}` });
    }
    await db.insert(dbSchema.jobs).values(
      SEED.map((job, i) => ({
        id: `j${i}`,
        type: job.type,
        status: job.status,
        projectId: "p1",
        // Distinct, increasing activity so the newest-first page order is unambiguous.
        updatedAt: new Date(BASE_MS + i * 1000),
        createdAt: new Date(BASE_MS),
        runAt: new Date(BASE_MS),
      })),
    );
    // Another project's job must never leak into p1's counts or pages, filtered or not.
    await db.insert(dbSchema.jobs).values({
      id: "other",
      type: "review-fix",
      status: "running",
      projectId: "p2",
      updatedAt: new Date(BASE_MS + 99_000),
      createdAt: new Date(BASE_MS),
      runAt: new Date(BASE_MS),
    });
  });

  afterAll(() => {
    rmSync(workDir, { recursive: true, force: true });
  });

  /** Every matching row for `filters`, newest first — a page big enough to hold the whole seed. */
  const allMatching = (filters?: JobFilters) =>
    listJobsPaged("p1", { limit: 100, offset: 0, filters });

  const idsFor = (predicate: (job: (typeof SEED)[number]) => boolean) =>
    SEED.map((job, i) => ({ job, i }))
      .filter(({ job }) => predicate(job))
      .map(({ i }) => `j${i}`)
      .reverse();

  it("omitting filters lists every status and type, project-scoped", async () => {
    const jobs = await allMatching();
    expect(jobs.map((j) => j.id)).toEqual(idsFor(() => true));
    expect(await countJobs("p1")).toBe(SEED.length);
  });

  it("defaults to the active set when filters are present but empty", async () => {
    const jobs = await allMatching({});
    expect(jobs.map((j) => j.id)).toEqual(idsFor((j) => isActiveJob(j.status)));
    expect(await countJobs("p1", {})).toBe(jobs.length);
  });

  it.each([
    { name: "all statuses", filters: { status: "all" } as JobFilters, match: () => true },
    {
      name: "a single status",
      filters: { status: "done" } as JobFilters,
      match: (j: (typeof SEED)[number]) => j.status === "done",
    },
    {
      name: "status + type together",
      filters: { status: "all", type: "review-fix" } as JobFilters,
      match: (j: (typeof SEED)[number]) => j.type === "review-fix",
    },
    {
      name: "a type within the active default",
      filters: { type: "execute-epic" } as JobFilters,
      match: (j: (typeof SEED)[number]) => j.type === "execute-epic" && isActiveJob(j.status),
    },
  ])("count agrees with the page for $name", async ({ filters, match }) => {
    const jobs = await allMatching(filters);
    const total = await countJobs("p1", filters);
    expect(total).toBe(jobs.length);
    expect(jobs.map((j) => j.id)).toEqual(idsFor(match));
  });

  it("pages within a status filter instead of within the unfiltered list", async () => {
    const done = idsFor((j) => j.status === "done");
    expect(done).toHaveLength(3);
    expect(
      (await listJobsPaged("p1", { limit: 2, offset: 0, filters: { status: "done" } })).map(
        (j) => j.id,
      ),
    ).toEqual(done.slice(0, 2));
    expect(
      (await listJobsPaged("p1", { limit: 2, offset: 2, filters: { status: "done" } })).map(
        (j) => j.id,
      ),
    ).toEqual(done.slice(2));
  });

  it("degrades a garbage status or type to the default view", async () => {
    const garbage = {
      status: "pending'; DROP TABLE jobs; --",
      type: "deploy",
    } as unknown as JobFilters;
    const jobs = await allMatching(garbage);
    expect(jobs.map((j) => j.id)).toEqual(idsFor((j) => isActiveJob(j.status)));
    expect(await countJobs("p1", garbage)).toBe(jobs.length);
  });
});
