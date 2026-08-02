/**
 * The hygiene report store (anton-3nv7): the patrol's durable record, against a real (in-memory)
 * anton.db. What matters here is that the audit trail stays both COMPLETE within its window and
 * BOUNDED — a patrol on a daily cron would otherwise grow the table forever — and that a report read
 * back is byte-for-byte the claim the patrol made.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";

import * as schema from "./db/schema";
import { makeTestDb, type TestDb } from "./db/testing";
import {
  completeHygieneReport,
  countFindings,
  getHygieneReport,
  getHygieneReportForJob,
  getHygieneVersion,
  listHygieneReports,
  NO_HYGIENE_REPORT,
  saveHygieneReport,
  sortFindings,
  startHygieneReport,
  summarizeReport,
  HYGIENE_REPORT_RETENTION,
  type HygieneFinding,
} from "./hygiene";
import type { Clock } from "./jobs/queue";

const NOW = 1_700_000_000_000;

let t: TestDb;
let projectId: string;
let clock: Clock;
let nowMs: number;

function finding(kind: HygieneFinding["kind"], id: string): HygieneFinding {
  return { kind, key: `${kind}:${id}`, beadId: id, detail: `${kind} on ${id}` };
}

beforeEach(async () => {
  t = makeTestDb();
  projectId = randomUUID();
  nowMs = NOW;
  clock = { now: () => nowMs };
  await t.db.insert(schema.projects).values({
    id: projectId,
    slug: "sandbox",
    name: "sandbox",
    repoPath: "/tmp/p",
    defaultBranch: "main",
  });
});

afterEach(() => t.close());

describe("hygiene report store", () => {
  it("round-trips a patrol's actions, findings and summary counts", async () => {
    await saveHygieneReport(t.db, clock, {
      projectId,
      jobId: "job-1",
      actions: { closedEpics: ["e-1"], rowsRecomputed: 2 },
      findings: [finding("lint", "t-1"), finding("orphan", "t-2"), finding("lint", "t-3")],
    });

    const report = await getHygieneReport(t.db, projectId);
    expect(report).toMatchObject({
      projectId,
      jobId: "job-1",
      generatedAt: Math.floor(NOW / 1000),
      actions: { closedEpics: ["e-1"], rowsRecomputed: 2 },
    });
    expect(report?.counts.lint).toBe(2);
    expect(report?.counts.orphan).toBe(1);
    expect(report?.counts.duplicate).toBe(0);
    // Persisted in the deterministic order, so two patrols over unchanged state compare equal.
    expect(report?.findings.map((f) => f.key)).toEqual(["lint:t-1", "lint:t-3", "orphan:t-2"]);
    expect(await getHygieneReportForJob(t.db, "job-1")).toEqual(report);
  });

  it("keeps the history bounded — a daily patrol must not grow the table forever", async () => {
    for (let i = 0; i < HYGIENE_REPORT_RETENTION + 5; i += 1) {
      nowMs = NOW + i * 86_400_000;
      await saveHygieneReport(t.db, clock, {
        projectId,
        jobId: `job-${i}`,
        actions: { closedEpics: [], rowsRecomputed: 0 },
        findings: [],
      });
    }

    const history = await listHygieneReports(t.db, projectId);
    expect(history).toHaveLength(HYGIENE_REPORT_RETENTION);
    // The newest survive, oldest first out.
    expect(history[0]?.jobId).toBe(`job-${HYGIENE_REPORT_RETENTION + 4}`);
    expect(await getHygieneReportForJob(t.db, "job-0")).toBeUndefined();
  });

  it("prunes only its own project's history", async () => {
    const other = randomUUID();
    await t.db.insert(schema.projects).values({
      id: other,
      slug: "other",
      name: "other",
      repoPath: "/tmp/other",
      defaultBranch: "main",
    });
    await saveHygieneReport(t.db, clock, {
      projectId: other,
      actions: { closedEpics: [], rowsRecomputed: 0 },
      findings: [],
    });
    for (let i = 0; i < HYGIENE_REPORT_RETENTION + 3; i += 1) {
      nowMs = NOW + i * 86_400_000;
      await saveHygieneReport(t.db, clock, {
        projectId,
        actions: { closedEpics: [], rowsRecomputed: 0 },
        findings: [],
      });
    }

    expect(await listHygieneReports(t.db, other)).toHaveLength(1);
  });

  it("reads a corrupt blob as empty rather than crashing the board", async () => {
    const id = await saveHygieneReport(t.db, clock, {
      projectId,
      actions: { closedEpics: ["e-1"], rowsRecomputed: 1 },
      findings: [finding("lint", "t-1")],
    });
    await t.db
      .update(schema.hygieneReports)
      .set({ findingsJson: "{not json" })
      .where(eq(schema.hygieneReports.id, id));

    const report = await getHygieneReport(t.db, projectId);
    expect(report?.findings).toEqual([]);
    // The denormalized count still says the patrol saw something — the discrepancy stays visible.
    expect(report?.actions.rowsRecomputed).toBe(1);
  });

  it("has no latest report before the first patrol — patrolled ≠ never patrolled", async () => {
    expect(await getHygieneReport(t.db, projectId)).toBeUndefined();
  });
});

describe("a report is published only once it completes", () => {
  it("keeps an open row off every read until its findings land", async () => {
    // The row exists so the patrol's WRITES survive a failing report tier — but a findings-less
    // report on the board would read as a clean bill of health, so nothing serves it yet.
    const { id } = await startHygieneReport(t.db, clock, {
      projectId,
      jobId: "job-1",
      actions: { closedEpics: ["e-1"], rowsRecomputed: 2 },
    });

    expect(await getHygieneReport(t.db, projectId)).toBeUndefined();
    expect(await getHygieneReportForJob(t.db, "job-1")).toBeUndefined();
    expect(await listHygieneReports(t.db, projectId)).toEqual([]);
    expect(await getHygieneVersion(t.db, projectId)).toBe(NO_HYGIENE_REPORT);

    await completeHygieneReport(t.db, clock, id, [finding("lint", "t-1")]);

    const report = await getHygieneReport(t.db, projectId);
    expect(report?.id).toBe(id);
    expect(report?.actions).toEqual({ closedEpics: ["e-1"], rowsRecomputed: 2 });
    expect(report?.findings.map((f) => f.key)).toEqual(["lint:t-1"]);
    // The board's token moves exactly when the report becomes visible.
    expect(await getHygieneVersion(t.db, projectId)).toBe(id);
  });

  it("merges a retried attempt into the open row instead of losing the first attempt's work", async () => {
    // The safe verbs are idempotent: the retry closes nothing, so a fresh row would publish
    // "closed 0 epics" for a patrol that closed one.
    const first = await startHygieneReport(t.db, clock, {
      projectId,
      jobId: "job-1",
      actions: { closedEpics: ["e-1"], rowsRecomputed: 2 },
    });
    const retry = await startHygieneReport(t.db, clock, {
      projectId,
      jobId: "job-1",
      actions: { closedEpics: [], rowsRecomputed: 1 },
    });

    expect(retry.id).toBe(first.id);
    expect(retry.actions).toEqual({ closedEpics: ["e-1"], rowsRecomputed: 3 });

    await completeHygieneReport(t.db, clock, retry.id, []);
    const history = await listHygieneReports(t.db, projectId);
    expect(history).toHaveLength(1); // one patrol, one report — not one per attempt
    expect(history[0]?.actions).toEqual({ closedEpics: ["e-1"], rowsRecomputed: 3 });
  });

  it("never rewrites a completed report — a later patrol opens its own row", async () => {
    const done = await saveHygieneReport(t.db, clock, {
      projectId,
      jobId: "job-1",
      actions: { closedEpics: ["e-1"], rowsRecomputed: 0 },
      findings: [],
    });

    const next = await startHygieneReport(t.db, clock, {
      projectId,
      jobId: "job-1",
      actions: { closedEpics: ["e-2"], rowsRecomputed: 0 },
    });

    expect(next.id).not.toBe(done);
    expect(next.actions.closedEpics).toEqual(["e-2"]);
    expect((await getHygieneReportForJob(t.db, "job-1"))?.actions.closedEpics).toEqual(["e-1"]);
  });
});

describe("hygiene version (the board's refresh token, anton-uwal)", () => {
  it("names the latest report and moves when a new patrol lands", async () => {
    // The board poll 304s on an unchanged token, so a patrol that didn't move it would stay
    // invisible until some unrelated write happened to change the token.
    expect(await getHygieneVersion(t.db, projectId)).toBe(NO_HYGIENE_REPORT);

    const first = await saveHygieneReport(t.db, clock, {
      projectId,
      actions: { closedEpics: [], rowsRecomputed: 0 },
      findings: [],
    });
    expect(await getHygieneVersion(t.db, projectId)).toBe(first);

    // Same second as the first patrol: the token must still move, so a fast follow-up isn't lost.
    const second = await saveHygieneReport(t.db, clock, {
      projectId,
      actions: { closedEpics: [], rowsRecomputed: 0 },
      findings: [finding("lint", "t-1")],
    });
    expect(second).not.toBe(first);
    expect(await getHygieneVersion(t.db, projectId)).toBe(second);
  });

  it("is scoped per project — another project's patrol never invalidates this board", async () => {
    const other = randomUUID();
    await t.db.insert(schema.projects).values({
      id: other,
      slug: "other",
      name: "other",
      repoPath: "/tmp/other",
      defaultBranch: "main",
    });
    await saveHygieneReport(t.db, clock, {
      projectId: other,
      actions: { closedEpics: [], rowsRecomputed: 0 },
      findings: [],
    });

    expect(await getHygieneVersion(t.db, projectId)).toBe(NO_HYGIENE_REPORT);
  });
});

describe("report summary helpers", () => {
  it("counts every kind, present or not", () => {
    expect(countFindings([finding("dep-cycle", "a")])).toEqual({
      lint: 0,
      "stale-open": 0,
      "stale-in-progress": 0,
      orphan: 0,
      "dep-cycle": 1,
      duplicate: 0,
    });
  });

  it("sorts by kind then key, without mutating the input", () => {
    const findings = [finding("orphan", "b"), finding("lint", "z"), finding("lint", "a")];
    expect(sortFindings(findings).map((f) => f.key)).toEqual(["lint:a", "lint:z", "orphan:b"]);
    expect(findings[0]?.key).toBe("orphan:b");
  });

  it("summarizes what changed and what needs eyes", () => {
    expect(
      summarizeReport({
        actions: { closedEpics: ["e-1"], rowsRecomputed: 2 },
        findings: [finding("lint", "t-1")],
      }),
    ).toBe("closed 1 epic(s) (e-1), recomputed 2 blocked row(s); 1 finding(s): 1 lint");
    expect(
      summarizeReport({ actions: { closedEpics: [], rowsRecomputed: 0 }, findings: [] }),
    ).toBe("closed 0 epic(s), recomputed 0 blocked row(s); no findings");
  });
});
