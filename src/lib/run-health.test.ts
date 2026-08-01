/**
 * Report persistence (anton-4ks0): one row per project, replaced on every sweep, read back as typed
 * findings. The board renders whatever this returns, so the round-trip and the degradation paths
 * (never swept vs. swept-clean vs. corrupt blob) are what these tests pin.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { makeTestDb, type TestDb } from "./db/testing";
import * as schema from "./db/schema";
import {
  getRunHealthReport,
  saveRunHealthReport,
  sortFindings,
  type RunHealthFinding,
} from "./run-health";
import type { Clock } from "./jobs/queue";

const NOW = 1_800_000_000_000;
const clock: Clock = { now: () => NOW };

function finding(o: Partial<RunHealthFinding> = {}): RunHealthFinding {
  return {
    kind: "parked-run",
    key: "parked-run:r-1",
    reason: "run parked 3h: usage-limit",
    since: NOW - 3 * 3_600_000,
    ageMs: 3 * 3_600_000,
    runId: "r-1",
    ...o,
  };
}

describe("run-health report storage", () => {
  let tdb: TestDb;
  const projectId = "p1";

  beforeEach(async () => {
    tdb = makeTestDb();
    await tdb.db.insert(schema.projects).values({
      id: projectId,
      slug: "p1",
      name: "p1",
      repoPath: "/tmp/p1",
    });
  });

  afterEach(() => tdb.close());

  it("round-trips findings with their links and ages intact", async () => {
    const findings = [finding(), finding({ kind: "stale-pr", key: "stale-pr:e-1:7", prNumber: 7 })];

    await saveRunHealthReport(tdb.db, clock, { projectId, jobId: "job-1", findings });

    const report = await getRunHealthReport(tdb.db, projectId);
    expect(report).toMatchObject({ projectId, jobId: "job-1", generatedAt: Math.floor(NOW / 1000) });
    expect(report!.findings).toEqual(sortFindings(findings));
  });

  it("replaces the previous report rather than appending — one row per project", async () => {
    await saveRunHealthReport(tdb.db, clock, { projectId, findings: [finding()] });
    await saveRunHealthReport(tdb.db, clock, {
      projectId,
      findings: [finding({ kind: "dead-lease", key: "dead-lease:e-2", beadId: "e-2" })],
    });

    const rows = await tdb.db.select().from(schema.runHealthReports);
    expect(rows).toHaveLength(1);
    expect(rows[0].findingCount).toBe(1);
    const report = await getRunHealthReport(tdb.db, projectId);
    expect(report!.findings.map((f) => f.kind)).toEqual(["dead-lease"]);
  });

  it("distinguishes never-swept from swept-and-clean", async () => {
    expect(await getRunHealthReport(tdb.db, projectId)).toBeUndefined();

    await saveRunHealthReport(tdb.db, clock, { projectId, findings: [] });

    const report = await getRunHealthReport(tdb.db, projectId);
    expect(report).toBeTruthy();
    expect(report!.findings).toEqual([]);
  });

  it("orders findings deterministically so two sweeps over the same state serialize identically", () => {
    const unsorted = [
      finding({ kind: "stale-pr", key: "stale-pr:b" }),
      finding({ kind: "dead-lease", key: "dead-lease:z" }),
      finding({ kind: "dead-lease", key: "dead-lease:a" }),
      finding({ kind: "parked-run", key: "parked-run:r-1" }),
    ];
    expect(sortFindings(unsorted).map((f) => f.key)).toEqual([
      "dead-lease:a",
      "dead-lease:z",
      "parked-run:r-1",
      "stale-pr:b",
    ]);
    // Sorting is pure — the caller's array is untouched.
    expect(unsorted[0].key).toBe("stale-pr:b");
  });

  it("degrades a corrupt blob to no findings instead of crashing the board", async () => {
    await saveRunHealthReport(tdb.db, clock, { projectId, findings: [finding()] });
    await tdb.db
      .update(schema.runHealthReports)
      .set({ findingsJson: "{not json" })
      .where(eq(schema.runHealthReports.projectId, projectId));

    const report = await getRunHealthReport(tdb.db, projectId);
    expect(report!.findings).toEqual([]);
    // The count column still shows the sweep saw something — the discrepancy stays visible.
    const rows = await tdb.db.select().from(schema.runHealthReports);
    expect(rows[0].findingCount).toBe(1);
  });
});
