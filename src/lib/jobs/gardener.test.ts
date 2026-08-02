/**
 * The gardener patrol (anton-3nv7), driven through a REAL `JobRunner` against a real (in-memory)
 * anton.db, with only `bd` and the sync nudge stubbed — they are the pass's whole outside world.
 *
 * Three properties carry this job, and each is a way it could silently do harm:
 *   • it writes ONLY the two safe verbs. A patrol that merged duplicates or "fixed" orphans would be
 *     making judgment calls nobody asked it to make (anton-bci0 "Out of scope").
 *   • the report is complete or absent. A partial report REPLACES what the board shows, so a verb
 *     that fails must fail the pass rather than persist a clean bill of health.
 *   • it pulls before reading and nudges after writing — and only after writing, so a clean board
 *     stays quiet on the remote.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";

import * as schema from "../db/schema";
import { makeTestDb, type TestDb } from "../db/testing";
import type {
  Bead,
  DuplicateGroup,
  EpicCloseSweep,
  LintReport,
  OrphanBead,
  DepCycle,
  StaleOpts,
} from "../beads/bd";
import { getHygieneReport, getHygieneReportForJob } from "../hygiene";
import { driveJob, expectJobStatus } from "@/lib/testing/jobs";
import type { Clock } from "./queue";

const pullMock = vi.fn<(cwd: string) => Promise<void>>();
const epicCloseMock = vi.fn<(cwd: string, opts?: { apply?: boolean }) => Promise<EpicCloseSweep>>();
const recomputeMock = vi.fn<(cwd: string) => Promise<number>>();
const lintMock = vi.fn<(cwd: string) => Promise<LintReport>>();
const staleMock = vi.fn<(cwd: string, opts?: StaleOpts) => Promise<Bead[]>>();
const orphansMock = vi.fn<(cwd: string) => Promise<OrphanBead[]>>();
const cyclesMock = vi.fn<(cwd: string) => Promise<DepCycle[]>>();
const duplicatesMock = vi.fn<(cwd: string) => Promise<DuplicateGroup[]>>();

/** Every bd verb the patrol calls, in call order — the evidence for "only the safe verbs write". */
const calls: string[] = [];
function trace<A extends unknown[], R>(name: string, fn: (...args: A) => Promise<R>) {
  return (...args: A): Promise<R> => {
    calls.push(name);
    return fn(...args);
  };
}

vi.mock("../beads/bd", async () => {
  const actual = await vi.importActual<typeof import("../beads/bd")>("../beads/bd");
  return {
    ...actual,
    beads: {
      ...actual.beads,
      pull: trace("pull", (...a: [string]) => pullMock(...a)),
      epicCloseEligible: trace("epicCloseEligible", (...a: [string, { apply?: boolean }?]) =>
        epicCloseMock(...a),
      ),
      recomputeBlocked: trace("recomputeBlocked", (...a: [string]) => recomputeMock(...a)),
      lintReport: trace("lintReport", (...a: [string]) => lintMock(...a)),
      staleList: trace("staleList", (...a: [string, StaleOpts?]) => staleMock(...a)),
      orphansList: trace("orphansList", (...a: [string]) => orphansMock(...a)),
      depCycles: trace("depCycles", (...a: [string]) => cyclesMock(...a)),
      duplicateGroups: trace("duplicateGroups", (...a: [string]) => duplicatesMock(...a)),
    },
  };
});

const { makeGardenerHandler, STALE_IN_PROGRESS_DAYS, STALE_OPEN_DAYS } = await import("./gardener");

const NOW = 1_700_000_000_000;
const REPO = "/tmp/gardener-repo";
const clock: Clock = { now: () => NOW };

let t: TestDb;
let projectId: string;
const nudge = vi.fn();

function bead(id: string, o: Partial<Bead> = {}): Bead {
  return { id, title: id, status: "open", issue_type: "task", ...o };
}

/** One patrol, driven to settlement. Returns the job id so a caller can read its row/report. */
function runPatrol(): Promise<string> {
  return driveJob({
    db: t.db,
    clock,
    type: "gardener",
    handler: ({ db, clock: c }) => makeGardenerHandler({ db, clock: c, nudge }),
    projectId,
  });
}

beforeEach(async () => {
  t = makeTestDb();
  projectId = randomUUID();
  await t.db.insert(schema.projects).values({
    id: projectId,
    slug: "sandbox",
    name: "sandbox",
    repoPath: REPO,
    defaultBranch: "main",
  });

  calls.length = 0;
  nudge.mockClear();
  // A clean board by default; each test seeds only the rot it is about.
  pullMock.mockResolvedValue(undefined);
  epicCloseMock.mockResolvedValue({ dryRun: false, eligible: [], closed: [] });
  recomputeMock.mockResolvedValue(0);
  lintMock.mockResolvedValue({ warnings: 0, issues: 0, violations: [] });
  staleMock.mockResolvedValue([]);
  orphansMock.mockResolvedValue([]);
  cyclesMock.mockResolvedValue([]);
  duplicatesMock.mockResolvedValue([]);
});

afterEach(() => {
  t.close();
  vi.clearAllMocks();
});

describe("gardener patrol", () => {
  it("applies the safe verbs, then reports — and records both on a report row keyed to the job", async () => {
    epicCloseMock.mockResolvedValue({ dryRun: false, eligible: [], closed: ["e-1", "e-2"] });
    recomputeMock.mockResolvedValue(3);
    lintMock.mockResolvedValue({
      warnings: 2,
      issues: 1,
      violations: [
        { id: "t-1", title: "no acceptance", type: "task", missing: ["## Acceptance Criteria"], warnings: 1 },
      ],
    });
    staleMock.mockImplementation(async (_cwd, opts) =>
      opts?.status === "open" ? [bead("t-2")] : [bead("t-3", { status: "in_progress", assignee: "someone" })],
    );
    orphansMock.mockResolvedValue([
      { id: "t-4", title: "shipped", status: "open", latestCommit: "abc1234" },
    ]);
    duplicatesMock.mockResolvedValue([
      {
        title: "same title",
        target: "t-5",
        sources: ["t-6"],
        members: [
          { id: "t-5", title: "same title", status: "open", references: 1, isMergeTarget: true },
          { id: "t-6", title: "same title", status: "open", references: 0, isMergeTarget: false },
        ],
      },
    ]);

    const jobId = await runPatrol();
    await expectJobStatus(t.db, jobId, "done");

    // The safe verbs ran BEFORE the report verbs, so the report describes the post-sweep board.
    expect(calls).toEqual([
      "pull",
      "epicCloseEligible",
      "recomputeBlocked",
      "lintReport",
      "staleList",
      "staleList",
      "orphansList",
      "depCycles",
      "duplicateGroups",
    ]);
    expect(epicCloseMock).toHaveBeenCalledWith(REPO, { apply: true });
    expect(staleMock).toHaveBeenCalledWith(REPO, { status: "open", days: STALE_OPEN_DAYS });
    expect(staleMock).toHaveBeenCalledWith(REPO, {
      status: "in_progress",
      days: STALE_IN_PROGRESS_DAYS,
    });

    const report = await getHygieneReportForJob(t.db, jobId);
    expect(report?.actions).toEqual({ closedEpics: ["e-1", "e-2"], rowsRecomputed: 3 });
    expect(report?.counts).toEqual({
      lint: 1,
      "stale-open": 1,
      "stale-in-progress": 1,
      orphan: 1,
      "dep-cycle": 0,
      duplicate: 1,
    });
    expect(report?.findings.map((f) => f.key).sort()).toEqual([
      "duplicate:t-5+t-6",
      "lint:t-1",
      "orphan:t-4",
      "stale-in-progress:t-3",
      "stale-open:t-2",
    ]);
    // The duplicate finding names bd's suggested target; it never merges.
    expect(report?.findings.find((f) => f.kind === "duplicate")?.detail).toContain("keeping t-5");
  });

  it("pulls the shared board before it reads, and nudges the coalescer after it writes", async () => {
    epicCloseMock.mockResolvedValue({ dryRun: false, eligible: [], closed: ["e-1"] });

    await runPatrol();

    expect(pullMock).toHaveBeenCalledWith(REPO);
    expect(calls[0]).toBe("pull");
    expect(nudge).toHaveBeenCalledWith({ id: projectId, repoPath: REPO });
  });

  it("stays quiet on the remote when it changed nothing", async () => {
    await runPatrol();
    expect(nudge).not.toHaveBeenCalled();
  });

  it("nudges for a recompute alone — a repaired blocked flag is a board write like any other", async () => {
    recomputeMock.mockResolvedValue(2);
    await runPatrol();
    expect(nudge).toHaveBeenCalledTimes(1);
  });

  it("patrols on regardless when the pull fails — the local board is still worth tending", async () => {
    pullMock.mockRejectedValue(new Error("remote unreachable"));

    const jobId = await runPatrol();
    await expectJobStatus(t.db, jobId, "done");
    expect(await getHygieneReport(t.db, projectId)).toBeDefined();
  });

  it("fails the pass rather than persist a partial report", async () => {
    // A report the patrol could not finish collecting would read as "board is clean" on the UI.
    orphansMock.mockRejectedValue(new Error("bd orphans: output was not JSON"));

    const jobId = await runPatrol();
    const job = await expectJobStatus(t.db, jobId, "queued"); // retried, not settled
    expect(job.lastError).toContain("bd orphans");
    expect(await getHygieneReport(t.db, projectId)).toBeUndefined();
  });

  it("writes an empty report on a clean board — patrolled is not the same as never patrolled", async () => {
    const jobId = await runPatrol();

    const report = await getHygieneReport(t.db, projectId);
    expect(report?.jobId).toBe(jobId);
    expect(report?.findings).toEqual([]);
    expect(report?.actions).toEqual({ closedEpics: [], rowsRecomputed: 0 });
  });

  it("keeps a history: two patrols leave two rows, newest first", async () => {
    epicCloseMock.mockResolvedValueOnce({ dryRun: false, eligible: [], closed: ["e-1"] });
    const first = await runPatrol();
    const second = await runPatrol();

    expect((await getHygieneReportForJob(t.db, first))?.actions.closedEpics).toEqual(["e-1"]);
    expect((await getHygieneReport(t.db, projectId))?.jobId).toBe(second);
  });

  it("parks without retrying when the project is gone", async () => {
    await t.db.delete(schema.projects);

    const jobId = await driveJob({
      db: t.db,
      clock,
      type: "gardener",
      handler: ({ db, clock: c }) => makeGardenerHandler({ db, clock: c, nudge }),
      payload: { projectId },
    });

    const job = await expectJobStatus(t.db, jobId, "parked");
    expect(job.attempts).toBe(1);
    expect(calls).toEqual([]);
  });
});
