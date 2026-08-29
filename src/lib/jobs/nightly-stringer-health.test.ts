/**
 * A scheduled pass is ONE point on the scan-health trend, however many attempts or call sites it
 * took (anton-bz1w) — and the point is a monitor, never the work: a db that refuses it must not
 * fail a scan whose beads already landed.
 */
import { afterEach, beforeEach, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as schema from "../db/schema";
import { makeTestDb, type TestDb } from "../db/testing";
import { emptyScanCounts, type ScanCounts } from "../scan-health";
import { makeHealthRecorder } from "./nightly-stringer-health";
import type { ScanPass } from "./nightly-stringer-scan";
import type { Clock } from "./queue";

const clock: Clock = { now: () => 1_700_000_000_000 };

let t: TestDb;
let dir: string;
let logPath: string;
let projectId: string;

beforeEach(async () => {
  t = makeTestDb();
  dir = mkdtempSync(join(tmpdir(), "anton-stringer-health-"));
  logPath = join(dir, "session.log");
  projectId = randomUUID();
  await t.db.insert(schema.projects).values({
    id: projectId,
    slug: "sandbox",
    name: "sandbox",
    repoPath: "/tmp/sandbox",
    defaultBranch: "main",
  });
});

afterEach(() => {
  t.close();
  rmSync(dir, { recursive: true, force: true });
});

function counts(total: number): ScanCounts {
  return { ...emptyScanCounts(), total };
}

function pass(total: number): ScanPass {
  return {
    scanFile: join(dir, "scan.json"),
    scannedSha: "abc1234",
    counts: counts(total),
    collectorFailures: 1,
    deltaState: { before: "state-1", after: "state-2" },
    restoreBaseline: async () => undefined,
  };
}

const recorder = (jobId: string) =>
  makeHealthRecorder({
    db: t.db,
    clock,
    projectId,
    jobId,
    sessionId: "session-1",
    logPath,
    slug: "sandbox",
  });

it("records what the pass saw — counts, the tree it measured, and what triage did", async () => {
  await recorder("job-1")(pass(3), { created: 2, deduped: 1 });

  const [row] = await t.db.select().from(schema.scanSummaries);
  expect(row?.totalSignals).toBe(3);
  expect(row?.scannedSha).toBe("abc1234");
  expect(row?.beadsCreated).toBe(2);
  expect(row?.beadsDeduped).toBe(1);
  expect(row?.collectorFailures).toBe(1);
  expect(readFileSync(logPath, "utf8")).toContain("[stringer] health:");
});

it("lands at most one point per attempt — the failure path can call it after the success path", async () => {
  const record = recorder("job-2");
  await record(pass(3), { created: 2, deduped: 1 });
  await record(pass(9));

  const rows = await t.db.select().from(schema.scanSummaries);
  expect(rows.length).toBe(1);
  expect(rows[0]?.totalSignals).toBe(3);
});

it("never fails the pass when the record cannot be written", async () => {
  await t.db.delete(schema.projects);
  await expect(recorder("job-3")(pass(3))).resolves.toBeUndefined();
});
