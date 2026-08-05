/**
 * The gardener patrol (anton-3nv7), driven through a REAL `JobRunner` against a real (in-memory)
 * anton.db, with only `bd` and the sync nudge stubbed — they are the pass's whole outside world.
 *
 * Three properties carry this job, and each is a way it could silently do harm:
 *   • the only beads it MUTATES are the two safe verbs' (anton-bci0 "Out of scope"). A judgment call
 *     — merging duplicates, retiring stale work, relinking orphans — is filed as a proposal bead for
 *     a human (anton-9qwq), never applied.
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
  SyncOutcome,
} from "../beads/bd";
import { GARDENER_OBSERVED_AT_KEY } from "../gardener/detections";
import { getHygieneReport, getHygieneReportForJob } from "../hygiene";
import { driveJob, expectJobStatus, makeJobRunner } from "@/lib/testing/jobs";
import type { Clock } from "./queue";

const pullMock = vi.fn<(cwd: string) => Promise<void>>();
const epicCloseMock = vi.fn<(cwd: string, opts?: { apply?: boolean }) => Promise<EpicCloseSweep>>();
const recomputeMock = vi.fn<(cwd: string) => Promise<number>>();
const lintMock = vi.fn<(cwd: string) => Promise<LintReport>>();
const staleMock = vi.fn<(cwd: string, opts?: StaleOpts) => Promise<Bead[]>>();
const orphansMock = vi.fn<(cwd: string) => Promise<OrphanBead[]>>();
const cyclesMock = vi.fn<(cwd: string) => Promise<DepCycle[]>>();
const duplicatesMock = vi.fn<(cwd: string) => Promise<DuplicateGroup[]>>();
const listMock = vi.fn<(cwd: string, extra?: string[]) => Promise<Bead[]>>();
const showMock = vi.fn<(cwd: string, id: string) => Promise<Bead>>();
const closeMock = vi.fn<(cwd: string, id: string, reason?: string) => Promise<string>>();
const createMock =
  vi.fn<
    (
      cwd: string,
      opts: { title: string; labels?: string[]; metadata?: Record<string, unknown> },
    ) => Promise<string>
  >();

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
      list: trace("list", (...a: [string, string[]?]) => listMock(...a)),
      show: trace("show", (...a: [string, string]) => showMock(...a)),
      close: trace("close", (...a: [string, string, string?]) => closeMock(...a)),
      create: trace(
        "create",
        (...a: [string, { title: string; labels?: string[]; metadata?: Record<string, unknown> }]) =>
          createMock(...a),
      ),
    },
  };
});

const { makeGardenerHandler, STALE_IN_PROGRESS_DAYS, STALE_OPEN_DAYS } = await import("./gardener");

const NOW = 1_700_000_000_000;
const REPO = "/tmp/gardener-repo";
// Mutable so a case can let time pass INSIDE a bd verb — which is how the premise fence is dated.
let now = NOW;
const clock: Clock = { now: () => now };

let t: TestDb;
let projectId: string;
const nudge = vi.fn();

/**
 * The emission-arbitration seam: the patrol publishes its proposals and re-reads the board to
 * withdraw a twin another machine filed for the same claim. Stubbed here for the same reason the
 * nudge is — the pass's outside world — with a settle that costs no wall-clock and a default of
 * "no remote", the truthful answer for a board that has no second patrol to race.
 */
const pushMock = vi.fn<(cwd: string) => Promise<SyncOutcome>>();
const arbitration = { push: (...a: [string]) => pushMock(...a), sleep: async () => {} };

function bead(id: string, o: Partial<Bead> = {}): Bead {
  return { id, title: id, status: "open", issue_type: "task", ...o };
}

/** One patrol, driven to settlement. Returns the job id so a caller can read its row/report. */
function runPatrol(): Promise<string> {
  return driveJob({
    db: t.db,
    clock,
    type: "gardener",
    handler: ({ db, clock: c }) => makeGardenerHandler({ db, clock: c, nudge, arbitration }),
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
  now = NOW;
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
  listMock.mockResolvedValue([]);
  // Fails closed: an unreadable bead makes every fold stand down, so only a case that stages a twin
  // can produce one.
  showMock.mockRejectedValue(new Error("no such bead"));
  closeMock.mockResolvedValue("");
  pushMock.mockResolvedValue("not-wired");
  createMock.mockImplementation(async () => "p-1");
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
      "list", // the judgment tier's board read, last: it sees everything the pass already did
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

  it("publishes what the FIRST attempt closed, even though the retry closes nothing", async () => {
    // Both safe verbs are idempotent, so a retry after a report-verb failure sweeps an already-swept
    // board. Reporting only the retry's (empty) sweep would leave the panel claiming "closed 0
    // epics" for a patrol that really did close one — the board's record of its own writes.
    epicCloseMock.mockResolvedValueOnce({ dryRun: false, eligible: [], closed: ["e-1"] });
    recomputeMock.mockResolvedValueOnce(2);
    orphansMock.mockRejectedValueOnce(new Error("bd orphans: output was not JSON"));

    let nowMs = NOW;
    const runner = makeJobRunner({
      db: t.db,
      clock: { now: () => nowMs },
      type: "gardener",
      handler: ({ db, clock: c }) => makeGardenerHandler({ db, clock: c, nudge, arbitration }),
    });
    const jobId = await runner.enqueue({ type: "gardener", projectId, payload: { projectId } });

    expect(await runner.tickOnce()).toBe(1);
    await runner.whenIdle();
    await expectJobStatus(t.db, jobId, "queued"); // retried, and nothing published
    expect(await getHygieneReport(t.db, projectId)).toBeUndefined();

    nowMs += 60_000; // past the retry backoff
    expect(await runner.tickOnce()).toBe(1);
    await runner.whenIdle();
    await expectJobStatus(t.db, jobId, "done");

    const report = await getHygieneReport(t.db, projectId);
    expect(report?.jobId).toBe(jobId);
    expect(report?.actions).toEqual({ closedEpics: ["e-1"], rowsRecomputed: 2 });
    // One patrol, one report — and one push: the retry wrote nothing new to propagate.
    expect(await getHygieneReportForJob(t.db, jobId)).toEqual(report);
    expect(nudge).toHaveBeenCalledTimes(1);
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

  it("files a proposal for the judgment the report can only describe — and pushes it", async () => {
    // An orphan is a report LINE bd owns; "close it, a commit shipped it" is a decision, so the
    // patrol asks instead of acting.
    orphansMock.mockResolvedValue([
      { id: "t-4", title: "shipped", status: "open", latestCommit: "abc1234" },
    ]);
    listMock.mockResolvedValue([bead("t-4", { title: "shipped" })]);

    const jobId = await runPatrol();
    await expectJobStatus(t.db, jobId, "done");

    expect(createMock).toHaveBeenCalledTimes(1);
    const [, draft] = createMock.mock.calls[0];
    expect(draft.title).toContain("t-4");
    expect(draft.labels?.some((l) => l.startsWith("gardener:shipped-orphan:"))).toBe(true);
    // t-4 itself is untouched — the proposal is the pass's only judgment-tier write.
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
      "list",
      "create",
    ]);
    expect(nudge).toHaveBeenCalledWith({ id: projectId, repoPath: REPO });
  });

  it("withdraws its own proposal when another machine had already filed the same claim", async () => {
    // The cross-machine race (anton-x4ks): suppression read a working set the rival's create had not
    // synced into, so the claim reached the board twice. The pass publishes, re-reads, and folds its
    // own twin — a day before the next patrol would have.
    orphansMock.mockResolvedValue([
      { id: "t-4", title: "shipped", status: "open", latestCommit: "abc1234" },
    ]);
    /** The board once both creates propagated: p-0 the rival's (filed first), p-1 ours. */
    const boardNow = (): Bead[] => {
      const [, draft] = createMock.mock.calls[0] ?? [];
      const shipped = bead("t-4", { title: "shipped" });
      if (!draft) return [shipped];
      const twin = (id: string) => bead(id, { title: draft.title, labels: draft.labels });
      return [shipped, twin("p-0"), twin("p-1")];
    };
    listMock.mockImplementation(async () => boardNow());
    showMock.mockImplementation(async (_cwd, id) => {
      const found = boardNow().find((b) => b.id === id);
      if (!found) throw new Error(`no such bead: ${id}`);
      return found;
    });
    pushMock.mockResolvedValue("synced");

    const jobId = await runPatrol();
    await expectJobStatus(t.db, jobId, "done");

    expect(pushMock).toHaveBeenCalledWith(REPO);
    expect(closeMock).toHaveBeenCalledTimes(1);
    const [, closedId, reason] = closeMock.mock.calls[0];
    expect(closedId).toBe("p-1"); // ours: the total order both machines compute keeps p-0
    expect(reason).toContain("p-0");
    // The withdrawal is a board write like any other — the other machines have to see it.
    expect(nudge).toHaveBeenCalledWith({ id: projectId, repoPath: REPO });
  });

  it("files its proposal and leaves it alone on a board with no remote", async () => {
    // Nothing to race, so the pass must not pay a propagation wait or a re-read for a rival that
    // structurally cannot exist.
    orphansMock.mockResolvedValue([
      { id: "t-4", title: "shipped", status: "open", latestCommit: "abc1234" },
    ]);
    listMock.mockResolvedValue([bead("t-4", { title: "shipped" })]);

    await expectJobStatus(t.db, await runPatrol(), "done");

    expect(createMock).toHaveBeenCalledTimes(1);
    expect(pushMock).toHaveBeenCalledWith(REPO);
    expect(closeMock).not.toHaveBeenCalled();
    expect(calls.filter((c) => c === "list")).toHaveLength(1); // no post-settle re-read
  });

  it("keeps the pass green when arbitration cannot publish", async () => {
    // Fails open: a duplicate the next patrol folds must never cost this pass the proposal it filed.
    orphansMock.mockResolvedValue([
      { id: "t-4", title: "shipped", status: "open", latestCommit: "abc1234" },
    ]);
    listMock.mockResolvedValue([bead("t-4", { title: "shipped" })]);
    pushMock.mockRejectedValue(new Error("dolt push exploded"));

    await expectJobStatus(t.db, await runPatrol(), "done");

    expect(createMock).toHaveBeenCalledTimes(1);
    expect(closeMock).not.toHaveBeenCalled();
  });

  it("fences the premise before the hygiene evidence its proposals rest on", async () => {
    // A retirement's premise IS a hygiene finding, so the fence has to predate the report verbs and
    // not just the board read: an edit landing while `orphansList` runs must date as UNSEEN. Were
    // the fence stamped after them, apply would read that edit as already observed and close a bead
    // that had been rescoped since the evidence was collected.
    orphansMock.mockImplementation(async () => {
      now += 60_000; // somebody rewrites the board mid-report
      return [{ id: "t-4", title: "shipped", status: "open", latestCommit: "abc1234" }];
    });
    listMock.mockResolvedValue([bead("t-4", { title: "shipped" })]);

    await expectJobStatus(t.db, await runPatrol(), "done");

    const [, draft] = createMock.mock.calls[0];
    expect(draft.metadata?.[GARDENER_OBSERVED_AT_KEY]).toBe(new Date(NOW).toISOString());
  });

  it("files proposals on a bd whose `list --status all` is unsupported", async () => {
    // The judgment tier runs AFTER the report, so a bare `--status all` that throws on such a bd
    // would park every pass with the report published and no proposal ever filed. The read goes
    // through `loadAllIssues`, which falls back to merging the open and closed listings.
    orphansMock.mockResolvedValue([
      { id: "t-4", title: "shipped", status: "open", latestCommit: "abc1234" },
    ]);
    listMock.mockImplementation(async (_cwd, extra = []) => {
      if (extra.includes("all")) throw new Error("unknown value for --status: all");
      return extra.includes("closed") ? [] : [bead("t-4", { title: "shipped" })];
    });

    const jobId = await runPatrol();
    await expectJobStatus(t.db, jobId, "done");

    expect(createMock).toHaveBeenCalledTimes(1);
    const [, draft] = createMock.mock.calls[0];
    expect(draft.labels?.some((l) => l.startsWith("gardener:shipped-orphan:"))).toBe(true);
  });

  it("asks once: a fingerprint already on the board files nothing the next pass", async () => {
    orphansMock.mockResolvedValue([
      { id: "t-4", title: "shipped", status: "open", latestCommit: "abc1234" },
    ]);
    listMock.mockResolvedValue([bead("t-4", { title: "shipped" })]);
    await runPatrol();

    const [, draft] = createMock.mock.calls[0];
    // The second patrol reads the board the first one wrote to.
    listMock.mockResolvedValue([
      bead("t-4", { title: "shipped" }),
      bead("p-1", { title: draft.title, labels: draft.labels }),
    ]);
    createMock.mockClear();
    nudge.mockClear();

    await runPatrol();
    expect(createMock).not.toHaveBeenCalled();
    expect(nudge).not.toHaveBeenCalled();
  });

  it("pushes the proposals that landed when a later create fails", async () => {
    // A create that fails part-way leaves the earlier proposals in the local working set only. If
    // the failing one keeps failing the pass parks, so the nudge has to happen on the way out.
    orphansMock.mockResolvedValue([
      { id: "t-4", title: "shipped", status: "open", latestCommit: "abc1234" },
      { id: "t-5", title: "also shipped", status: "open", latestCommit: "def5678" },
    ]);
    listMock.mockResolvedValue([
      bead("t-4", { title: "shipped" }),
      bead("t-5", { title: "also shipped" }),
    ]);
    createMock.mockImplementationOnce(async () => "p-1").mockImplementationOnce(async () => {
      throw new Error("bd create exploded");
    });

    const jobId = await runPatrol();
    const job = await expectJobStatus(t.db, jobId, "queued"); // retried, not settled
    expect(job.lastError).toContain("bd create exploded");
    expect(nudge).toHaveBeenCalledWith({ id: projectId, repoPath: REPO });
  });

  it("files nothing for a patrol cancelled while it read the board", async () => {
    // `ctx.heartbeat()` does not inspect the signal, so a cancel arriving during the judgment
    // tier's board read is invisible until the check that guards the first write.
    orphansMock.mockResolvedValue([
      { id: "t-4", title: "shipped", status: "open", latestCommit: "abc1234" },
    ]);
    const runner = makeJobRunner({
      db: t.db,
      clock,
      type: "gardener",
      handler: ({ db, clock: c }) => makeGardenerHandler({ db, clock: c, nudge, arbitration }),
    });
    const jobId = await runner.enqueue({ type: "gardener", projectId, payload: { projectId } });
    listMock.mockImplementation(async () => {
      await runner.cancel(jobId);
      return [bead("t-4", { title: "shipped" })];
    });

    expect(await runner.tickOnce()).toBe(1);
    await runner.whenIdle();

    await expectJobStatus(t.db, jobId, "cancelled");
    expect(createMock).not.toHaveBeenCalled();
  });

  it("parks without retrying when the project is gone", async () => {
    await t.db.delete(schema.projects);

    const jobId = await driveJob({
      db: t.db,
      clock,
      type: "gardener",
      handler: ({ db, clock: c }) => makeGardenerHandler({ db, clock: c, nudge, arbitration }),
      payload: { projectId },
    });

    const job = await expectJobStatus(t.db, jobId, "parked");
    expect(job.attempts).toBe(1);
    expect(calls).toEqual([]);
  });
});
