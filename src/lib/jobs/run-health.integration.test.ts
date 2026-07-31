/**
 * End-to-end proof of anton-4ks0's acceptance: one sweep, one report, every stall class in it.
 * Drives the REAL run-health handler through a REAL JobRunner against REAL bd and a migrated
 * anton.db — a seeded parked run, a stale PR, a dead lease, and an exhausted job all show up in a
 * single persisted report. Skipped without bd.
 *
 * `gh` is the one seam stubbed: the PR reader is injected, because a temp repo has no GitHub PR to
 * ask about. Everything else — the board read, the run/job queries, the persistence — is real.
 */
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { describeBd, makeBdRepo, type BdRepo } from "@/lib/testing/integration";
import { driveJob } from "@/lib/testing/jobs";
import { makeTestDb, type TestDb } from "../db/testing";
import { beads, LABELS } from "../beads/bd";
import type { PrActivity } from "../git/pr";
import { getRunHealthReport, type RunHealthFinding } from "../run-health";
import * as schema from "../db/schema";
import { type Clock } from "./queue";
import { makeRunHealthHandler } from "./run-health";

const HOUR = 3_600_000;
const NOW = 1_900_000_000_000;

class FakeClock implements Clock {
  constructor(private t: number) {}
  now() {
    return this.t;
  }
}

function secDate(ms: number): Date {
  return new Date(Math.floor(ms / 1000) * 1000);
}

describeBd("run-health e2e (real handler · real bd)", () => {
  let bdRepo: BdRepo;
  let repo: string;
  let tdb: TestDb;
  let clock: FakeClock;
  let projectId: string;
  /** stage:in-review + a PR ref — the stale-PR subject. */
  let reviewEpic: string;
  /** An expired run-lease with no job behind it — the dead-lease subject. */
  let deadLeaseEpic: string;
  /** A healthy epic: no lease, no PR, nothing to say about it. */
  let healthyEpic: string;
  let parkedRunId: string;
  let exhaustedJobId: string;

  /** The PR the stale-PR subject points at: open, untouched for three days. */
  const stalePr: PrActivity = {
    number: 42,
    state: "OPEN",
    url: "https://github.com/o/r/pull/42",
    updatedAtMs: NOW - 3 * 24 * HOUR,
    isDraft: false,
  };

  /** One run-health sweep, driven to settlement against the suite's db/repo. */
  const sweep = () =>
    driveJob({
      db: tdb.db,
      clock,
      type: "run-health",
      handler: (deps) =>
        makeRunHealthHandler({ ...deps, readPrActivity: async () => stalePr }),
      projectId,
    });

  const findingsByKind = (findings: RunHealthFinding[], kind: string) =>
    findings.filter((f) => f.kind === kind);

  beforeAll(async () => {
    bdRepo = makeBdRepo({ initialCommit: true });
    repo = bdRepo.repo;

    reviewEpic = await beads.create(repo, {
      title: "In review, reviewer went quiet",
      type: "epic",
      description: "## Goal\nx",
    });
    await beads.tag(repo, reviewEpic, [LABELS.stage("in-review")]);
    await beads.setPrRef(repo, reviewEpic, "gh-42");

    deadLeaseEpic = await beads.create(repo, {
      title: "Machine died mid-run",
      type: "epic",
      description: "## Goal\nx",
    });
    // A lease that expired two hours ago — well past any grace window.
    await beads.tag(repo, deadLeaseEpic, [LABELS.runLease(NOW - 2 * HOUR, "run-gone")]);

    healthyEpic = await beads.create(repo, {
      title: "Nothing wrong here",
      type: "epic",
      description: "## Goal\nx",
    });

    tdb = makeTestDb();
    clock = new FakeClock(NOW);
    projectId = randomUUID();
    await tdb.db.insert(schema.projects).values({
      id: projectId,
      slug: "sandbox",
      name: "sandbox",
      repoPath: repo,
      defaultBranch: "main",
    });
  });

  beforeEach(async () => {
    await tdb.db.delete(schema.runs);
    await tdb.db.delete(schema.jobs);

    // A run parked four hours ago — past the 2h default, nothing will re-dispatch it.
    parkedRunId = randomUUID();
    await tdb.db.insert(schema.runs).values({
      id: parkedRunId,
      projectId,
      epicBeadId: healthyEpic,
      status: "parked",
      attempts: 3,
      error: "verify gate failed",
      startedAt: secDate(NOW - 6 * HOUR),
      updatedAt: secDate(NOW - 4 * HOUR),
    });

    // A job parked having spent its whole retry budget (the default maxRetries is 3).
    exhaustedJobId = randomUUID();
    await tdb.db.insert(schema.jobs).values({
      id: exhaustedJobId,
      type: "execute-epic",
      projectId,
      payloadJson: JSON.stringify({ projectId, epicBeadId: healthyEpic }),
      status: "parked",
      attempts: 3,
      lastError: "claude reported an error",
      runAt: secDate(NOW - 5 * HOUR),
      createdAt: secDate(NOW - 5 * HOUR),
      updatedAt: secDate(NOW - 5 * HOUR),
    });
  });

  afterAll(() => {
    tdb?.close();
    bdRepo.cleanup();
  });

  it("puts every stall class in one report, each linked to the work it concerns", async () => {
    await sweep();

    const report = await getRunHealthReport(tdb.db, projectId);
    expect(report).toBeTruthy();
    expect(report!.generatedAt).toBe(Math.floor(NOW / 1000));

    const parked = findingsByKind(report!.findings, "parked-run");
    expect(parked).toHaveLength(1);
    expect(parked[0]).toMatchObject({ runId: parkedRunId, beadId: healthyEpic });
    expect(parked[0].reason).toContain("verify gate failed");
    expect(parked[0].ageMs).toBe(4 * HOUR);

    const stale = findingsByKind(report!.findings, "stale-pr");
    expect(stale).toHaveLength(1);
    expect(stale[0]).toMatchObject({ beadId: reviewEpic, prNumber: 42, prUrl: stalePr.url });

    const dead = findingsByKind(report!.findings, "dead-lease");
    expect(dead).toHaveLength(1);
    expect(dead[0]).toMatchObject({ beadId: deadLeaseEpic });
    expect(dead[0].ageMs).toBe(2 * HOUR);

    const exhausted = findingsByKind(report!.findings, "exhausted-job");
    expect(exhausted).toHaveLength(1);
    expect(exhausted[0]).toMatchObject({ jobId: exhaustedJobId, beadId: healthyEpic });

    // The healthy epic is the control: it appears in no finding at all.
    expect(report!.findings.some((f) => f.kind === "dead-lease" && f.beadId === healthyEpic)).toBe(
      false,
    );
  });

  it("never mutates runs, jobs, or beads — the sweep only writes its report", async () => {
    const boardBefore = await beads.list(repo, ["--status", "all"]);
    const runBefore = (await tdb.db.select().from(schema.runs))[0];
    const jobBefore = (await tdb.db.select().from(schema.jobs))[0];

    await sweep();

    const boardAfter = await beads.list(repo, ["--status", "all"]);
    expect(
      boardAfter.map((b) => ({ id: b.id, status: b.status, labels: [...(b.labels ?? [])].sort() })),
    ).toEqual(
      boardBefore.map((b) => ({ id: b.id, status: b.status, labels: [...(b.labels ?? [])].sort() })),
    );

    // The seeded run/job are untouched (the sweep's OWN job row is new, hence the id filter).
    const runAfter = (await tdb.db.select().from(schema.runs)).find((r) => r.id === runBefore.id);
    const jobAfter = (await tdb.db.select().from(schema.jobs)).find((j) => j.id === jobBefore.id);
    expect(runAfter).toEqual(runBefore);
    expect(jobAfter).toEqual(jobBefore);
  });

  it("is idempotent — a second sweep over unchanged state stores the identical report", async () => {
    await sweep();
    const first = await getRunHealthReport(tdb.db, projectId);

    await sweep();
    const second = await getRunHealthReport(tdb.db, projectId);

    // One row per project, same findings in the same order — reports don't accumulate.
    const rows = await tdb.db.select().from(schema.runHealthReports);
    expect(rows).toHaveLength(1);
    expect(second!.findings).toEqual(first!.findings);
  });
});
