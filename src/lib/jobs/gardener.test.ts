/**
 * The gardener patrol (anton-3nv7), driven through a REAL `JobRunner` against a real (in-memory)
 * anton.db, with only `bd` and the sync nudge stubbed — they are the pass's whole outside world.
 *
 * Three properties carry this job, and each is a way it could silently do harm:
 *   • the only beads it MUTATES are the two safe verbs' (anton-bci0 "Out of scope"). A judgment call
 *     — merging duplicates, retiring stale work, relinking orphans — is filed as a proposal bead for
 *     a human (anton-9qwq), and applied by the pass ONLY for a kind an operator armed by hand
 *     (anton-4ab3, the last describe here); at every other level nothing but the proposal is written.
 *   • the report is complete or absent. A partial report REPLACES what the board shows, so a verb
 *     that fails must fail the pass rather than persist a clean bill of health.
 *   • it pulls before reading and nudges after writing — and only after writing, so a clean board
 *     stays quiet on the remote.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
import { LABELS } from "../beads/bd";
import type { ApplyDecision, ApplyMoment } from "../gardener/apply";
import { MAX_APPLIES_PER_PASS } from "../gardener/emit";
import {
  GARDENER_OBSERVED_AT_KEY,
  parseGardenerPlan,
  type GardenerPlan,
} from "../gardener/detections";
import { passRecordCounts, readPassRecords } from "../gardener/record";
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
const noteMock = vi.fn<(cwd: string, id: string, text: string) => Promise<string>>();
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
      note: trace("note", (...a: [string, string, string]) => noteMock(...a)),
      create: trace(
        "create",
        (...a: [string, { title: string; labels?: string[]; metadata?: Record<string, unknown> }]) =>
          createMock(...a),
      ),
    },
  };
});

/**
 * The decision seam, spied rather than replaced: shadow mode's whole claim is that it asks the SAME
 * `planApply` an approval asks, so the default is the real one and only the "it threw" case swaps it.
 */
const planApplyMock =
  vi.fn<(plan: GardenerPlan, board: Bead[], at: ApplyMoment) => ApplyDecision>();

vi.mock("../gardener/apply", async () => {
  const actual = await vi.importActual<typeof import("../gardener/apply")>("../gardener/apply");
  return {
    ...actual,
    planApply: (...a: [GardenerPlan, Bead[], ApplyMoment]) => planApplyMock(...a),
  };
});

const { planApply: realPlanApply } =
  await vi.importActual<typeof import("../gardener/apply")>("../gardener/apply");

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

/** Arm a kind at a level for this project — the operator's stored autonomy policy (anton-nbyy). */
async function arm(overrides: Record<string, string>): Promise<void> {
  await t.db
    .update(schema.projects)
    .set({ settingsJson: JSON.stringify({ proposalAutonomy: overrides }) });
}

/** The patrol's session log, or "" for a pass that never opened one. */
async function sessionLog(): Promise<string> {
  const [row] = await t.db.select().from(schema.sessions);
  return row?.logPath ? readFileSync(row.logPath, "utf8") : "";
}

let sessionsDir: string;
let priorSessionsRoot: string | undefined;

beforeEach(async () => {
  sessionsDir = mkdtempSync(join(tmpdir(), "anton-gardener-"));
  priorSessionsRoot = process.env.ANTON_SESSIONS_ROOT;
  process.env.ANTON_SESSIONS_ROOT = join(sessionsDir, "sessions");
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
  planApplyMock.mockImplementation(realPlanApply);
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
  noteMock.mockResolvedValue("");
  pushMock.mockResolvedValue("not-wired");
  createMock.mockImplementation(async () => "p-1");
});

afterEach(() => {
  t.close();
  vi.clearAllMocks();
  if (priorSessionsRoot === undefined) delete process.env.ANTON_SESSIONS_ROOT;
  else process.env.ANTON_SESSIONS_ROOT = priorSessionsRoot;
  rmSync(sessionsDir, { recursive: true, force: true });
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

  it("settles the session a failed pass opened before it ever reached the proposals", async () => {
    // The write-budget read opens the row itself when an earlier attempt spent part of the cap — it
    // writes a note saying so. Anything that throws after that (a report verb here) has to settle
    // the row, or the jobs page shows a session "running" under a job that stopped hours ago.
    const runner = makeJobRunner({
      db: t.db,
      clock,
      type: "gardener",
      handler: ({ db, clock: c }) => makeGardenerHandler({ db, clock: c, nudge, arbitration }),
    });
    const jobId = await runner.enqueue({ type: "gardener", projectId, payload: { projectId } });
    const logPath = join(sessionsDir, "prior-attempt.log");
    writeFileSync(
      logPath,
      "[gardener] APPLY p-9 (shipped-orphan) retire/close t-9 — APPLIED: closed t-9 as shipped\n",
    );
    await t.db.insert(schema.sessions).values({
      id: "s-prior",
      projectId,
      jobId,
      kind: "gardener",
      status: "failed",
      logPath,
      startedAt: new Date(NOW - 60_000),
    });
    orphansMock.mockRejectedValue(new Error("bd orphans: output was not JSON"));

    expect(await runner.tickOnce()).toBe(1);
    await runner.whenIdle();
    await expectJobStatus(t.db, jobId, "queued"); // retried, not settled

    const opened = (await t.db.select().from(schema.sessions)).filter((s) => s.id !== "s-prior");
    expect(opened.map((s) => s.status)).toEqual(["failed"]);
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

  it("says the proposals that landed will never be settled, rather than leaving a clean record", async () => {
    // The retry cannot pick them up: the fingerprints of what DID file now suppress the re-file, so
    // the shadow and armed walks never see them again and an armed kind is silently skipped for the
    // rest of that proposal's life. Neither is written out of a failing pass — but an operator who
    // armed a kind and finds an untouched bead must be able to tell "the policy refused it" from
    // "the policy never reached it".
    await arm({ "shipped-orphan": "apply" });
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

    await expectJobStatus(t.db, await runPatrol(), "queued");

    const log = await sessionLog();
    expect(log).toContain("[gardener] APPLY skipped for 1 filed proposal(s)");
    expect(log).toContain("no later pass re-decides them (p-1)");
    // Said, not done: a pass whose board writes are already failing does not start applying.
    expect(closeMock).not.toHaveBeenCalled();
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

/**
 * Shadow mode (anton-lmps): the patrol says what arming a kind WOULD have done, and writes nothing
 * to say it.
 *
 * The trace below is the evidence. `calls` is every bd verb the pass made, so "the shadow added one
 * READ and no write" is an assertion rather than a claim — and the refusal case checks the logged
 * reason against `planApply`'s own string, because an operator arms a kind on the strength of those
 * words and a paraphrase is anton deciding for them.
 */
describe("gardener patrol · shadow mode", () => {
  /** The orphan bd's report names and the patrol proposes retiring: shipped by a commit, still open. */
  const ORPHAN = { id: "t-4", title: "shipped", status: "open", latestCommit: "abc1234" };
  /** Untouched since well before the patrol read the board, so the premise fence still holds. */
  const cold = bead("t-4", { title: "shipped", updated_at: "2023-01-01T00:00:00Z" });

  /** The reads and the ONE create a patrol makes, plus the shadow's fresh board read at the end. */
  const READS = [
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
  ];

  beforeEach(async () => {
    orphansMock.mockResolvedValue([ORPHAN]);
    listMock.mockResolvedValue([cold]);
    await arm({ "shipped-orphan": "shadow" });
  });

  it("records the move it would have applied, and writes nothing to record it", async () => {
    await expectJobStatus(t.db, await runPatrol(), "done");

    // The proposal, the kind, the verb and the subject — the whole ask, without opening the bead.
    expect(await sessionLog()).toContain(
      "[gardener] SHADOW p-1 (shipped-orphan) retire/close t-4 — WOULD APPLY: closed t-4 as shipped\n",
    );
    // One create (the proposal) and one extra read (the fresh board the shadow decided against).
    // Nothing else: t-4 is never closed, deferred or updated by a pass that only says what it would do.
    expect(calls).toEqual([...READS, "create", "list"]);
    expect(closeMock).not.toHaveBeenCalled();
  });

  it("lands the record on a session the jobs page already knows how to show", async () => {
    const jobId = await runPatrol();
    await expectJobStatus(t.db, jobId, "done");

    const [session] = await t.db.select().from(schema.sessions);
    expect(session.kind).toBe("gardener");
    expect(session.projectId).toBe(projectId);
    // Settled, not left running: the patrol is over, and a session stuck on "running" reads as a
    // pass still in flight.
    expect(session.status).toBe("done");
    // Linked to the job that opened it. The patrol opens its session in its last seconds and the
    // runner's live handle dies with the job, so WITHOUT this row the record a founder reads the
    // morning after a 03:00 pass is a .log file on disk with no route to it from the jobs page.
    expect(session.jobId).toBe(jobId);
  });

  it("names the move's counterpart — a move recorded without its other end is not a record", async () => {
    // A duplicate whose twin already landed: the ask is "supersede t-6 BY t-5", and the survivor is
    // half of what an operator is deciding about.
    const member = (id: string, status = "open") => ({
      id,
      title: "same title",
      status,
      references: 0,
      isMergeTarget: false,
    });
    orphansMock.mockResolvedValue([]);
    duplicatesMock.mockResolvedValue([
      {
        title: "same title",
        target: "t-5",
        sources: ["t-6"],
        members: [member("t-5", "closed"), member("t-6")],
      },
    ]);
    listMock.mockResolvedValue([
      bead("t-5", { status: "closed", updated_at: "2023-01-01T00:00:00Z" }),
      bead("t-6", { updated_at: "2023-01-01T00:00:00Z" }),
    ]);
    await arm({ superseded: "shadow" });

    await expectJobStatus(t.db, await runPatrol(), "done");

    expect(await sessionLog()).toContain(
      "SHADOW p-1 (superseded) retire/supersede t-6 → t-5 — WOULD APPLY:",
    );
    expect(closeMock).not.toHaveBeenCalled();
  });

  it("carries planApply's refusal verbatim — the reason is what an operator arms on", async () => {
    // A bead with no write stamp: the premise fence cannot prove it went untouched since the read,
    // so apply refuses. The point is not WHICH refusal — it is that the log carries the real one.
    listMock.mockResolvedValue([bead("t-4", { title: "shipped" })]);

    await expectJobStatus(t.db, await runPatrol(), "done");

    const plan = parseGardenerPlan(createMock.mock.calls[0][1].metadata?.gardener) as GardenerPlan;
    const decision = realPlanApply(plan, [bead("t-4", { title: "shipped" })], {
      nowMs: NOW,
      observedAtMs: NOW,
    });
    expect(decision.status).toBe("refuse");
    expect(await sessionLog()).toContain(
      `SHADOW p-1 (shipped-orphan) retire/close t-4 — WOULD REFUSE: ` +
        `${decision.status === "refuse" ? decision.reason : ""}\n`,
    );
    expect(calls).toEqual([...READS, "create", "list"]);
  });

  it("dates the fence on bd's one-second grid, so a same-second write reads as the tie apply refuses", async () => {
    // The shadow holds the pass's raw wall-clock reading; the armed path reads its fence back off
    // the proposal bead, where `observedAtOf` has floored it to bd's whole-second stamp grid. Left
    // unfloored here, a subject written in the SAME second as the read orders as "before the
    // observation" and shadows as WOULD APPLY — permission for a move the approval refuses.
    now = NOW + 500; // the patrol reads the board 500ms into the second bd stamps as NOW
    const sameSecond = bead("t-4", { title: "shipped", updated_at: new Date(NOW).toISOString() });
    listMock.mockResolvedValue([sameSecond]);

    await expectJobStatus(t.db, await runPatrol(), "done");

    const plan = parseGardenerPlan(createMock.mock.calls[0][1].metadata?.gardener) as GardenerPlan;
    // What the armed apply decides against the same board — its fence already on the grid.
    const armed = realPlanApply(plan, [sameSecond], { nowMs: now, observedAtMs: NOW });
    expect(armed.status).toBe("refuse");
    expect(await sessionLog()).toContain(
      `SHADOW p-1 (shipped-orphan) retire/close t-4 — WOULD REFUSE: ` +
        `${armed.status === "refuse" ? armed.reason : ""}\n`,
    );
    expect(closeMock).not.toHaveBeenCalled();
  });

  it("shadows nothing for a kind left at propose — and opens no session to say so", async () => {
    await arm({ stale: "shadow" }); // armed, but not the kind this patrol files

    await expectJobStatus(t.db, await runPatrol(), "done");

    expect(createMock).toHaveBeenCalledTimes(1);
    expect(calls).toEqual([...READS, "create"]); // no second board read: nothing to decide
    expect(await t.db.select().from(schema.sessions)).toEqual([]);
  });

  it("keeps the pass green when planApply throws — the proposals are the work, the shadow is not", async () => {
    planApplyMock.mockImplementation(() => {
      throw new Error("indexBoard exploded");
    });

    await expectJobStatus(t.db, await runPatrol(), "done");

    expect(await sessionLog()).toContain(
      "SHADOW p-1 (shipped-orphan) retire/close t-4 — COULD NOT SHADOW: indexBoard exploded\n",
    );
    expect(createMock).toHaveBeenCalledTimes(1); // the proposal still stands
  });

  it("keeps the pass green when the shadow's own board read fails", async () => {
    // The patrol's own read succeeds; the shadow's fresh one does not. Losing the record must not
    // cost the pass the proposal it just filed.
    let reads = 0;
    listMock.mockImplementation(async () => {
      if (++reads > 1) throw new Error("bd list exploded");
      return [cold];
    });

    await expectJobStatus(t.db, await runPatrol(), "done");

    expect(await sessionLog()).toContain("SHADOW could not read the board");
    expect(createMock).toHaveBeenCalledTimes(1);
  });
});

/**
 * ARMED mode (anton-4ab3): the patrol APPLIES what it just filed, for the kinds an operator armed —
 * the same `applyProposal` an approval runs, under a write cap of its own and recorded as a policy
 * write.
 *
 * The bd seam answers every read after the creates with the board AS THE PASS LEFT IT: the subjects
 * plus the proposals it just filed, carrying the fingerprint label and the plan metadata a real `bd
 * create` stores. Without that, apply would find no readable move and every case here would prove
 * only that an unreadable proposal refuses.
 */
describe("gardener patrol · armed", () => {
  /** A bead a commit already shipped, still open — the ask the patrol files and this suite arms. */
  const orphan = (id: string) => ({ id, title: id, status: "open", latestCommit: "abc1234" });
  /** Its board row: untouched since well before the patrol read, so the premise fence holds. */
  const cold = (id: string) => bead(id, { updated_at: "2023-01-01T00:00:00Z" });

  /** The proposals this patrol has filed so far, as the board hands them back. */
  const filed = (): Bead[] =>
    createMock.mock.calls.map(([, draft], i) =>
      bead(`p-${i + 1}`, {
        title: draft.title,
        labels: draft.labels,
        metadata: draft.metadata,
        created_at: new Date(now).toISOString(),
      }),
    );

  /** Every read answers with these subjects plus whatever the patrol has filed about them. */
  function boardIs(subjects: () => Bead[]): void {
    const board = () => [...subjects(), ...filed()];
    listMock.mockImplementation(async () => board());
    showMock.mockImplementation(async (_cwd, id) => {
      const found = board().find((b) => b.id === id);
      if (!found) throw new Error(`no such bead: ${id}`);
      return found;
    });
  }

  /** The armed loop's lines, in the order the pass recorded them. */
  const applyLines = async (): Promise<string[]> =>
    (await sessionLog()).split("\n").filter((l) => l.includes("APPLY "));

  /**
   * What the pass ENDED UP recording about one move. Each apply writes twice — the `APPLYING` line
   * that buys the write against the cap, then its outcome (gardener/armed.ts) — so the last line
   * mentioning a move is the verdict, and the first is the reservation for it.
   */
  const outcomeOf = (lines: string[], move: string): string =>
    lines.filter((l) => l.includes(move)).at(-1) ?? "";

  /** Which proposal a line is about — the ids are hash-ordered, so no case may assume one. */
  const proposalIn = (line = ""): string => line.match(/p-\d+/)?.[0] ?? "";
  const closedIds = (): string[] => closeMock.mock.calls.map(([, id]) => id);

  beforeEach(async () => {
    let n = 0;
    createMock.mockImplementation(async () => `p-${++n}`);
    await arm({ "shipped-orphan": "apply" });
  });

  it("applies the ask it just filed, and names POLICY as the actor that did it", async () => {
    orphansMock.mockResolvedValue([orphan("t-4")]);
    boardIs(() => [cold("t-4")]);

    await expectJobStatus(t.db, await runPatrol(), "done");

    // The move, then the settlement: the subject closed, the proposal closed as applied. Both
    // through `applyProposal` — the patrol re-implements no precondition of its own.
    expect(closedIds()).toEqual(["t-4", "p-1"]);
    // An approve-route note says only "applied". An unattended one has to be readable as a write
    // nobody was asked about, and name the setting that made it — that is where a founder who finds
    // a bead moved overnight goes to change their mind.
    const [, noted, text] = noteMock.mock.calls[0];
    expect(noted).toBe("p-1");
    expect(text).toContain("applied by POLICY");
    expect(text).toContain("`shipped-orphan` is set to apply");
    expect(await sessionLog()).toContain(
      "[gardener] APPLY p-1 (shipped-orphan) retire/close t-4 — APPLIED: closed t-4 as shipped\n",
    );
    // An unattended write no other machine can see is half a write.
    expect(nudge).toHaveBeenCalledWith({ id: projectId, repoPath: REPO });
  });

  it("buys the write before it makes it — the spend is recorded ahead of the board", async () => {
    // The next attempt of this job reconstructs the cap from these lines (pass-budget.ts), so an
    // apply recorded AFTER its board write leaves a window in which the move is real and the record
    // is not: a retry landing in it spends a cap this pass has already spent.
    orphansMock.mockResolvedValue([orphan("t-4")]);
    boardIs(() => [cold("t-4")]);
    let logAtWrite = "";
    closeMock.mockImplementation(async (_cwd, id) => {
      if (id === "t-4" && !logAtWrite) logAtWrite = await sessionLog();
      return "";
    });

    await expectJobStatus(t.db, await runPatrol(), "done");

    expect(logAtWrite).toContain("[gardener] APPLY p-1 (shipped-orphan) retire/close t-4 — APPLYING:");
    // And the outcome supersedes it, so the record reads as one apply rather than two.
    expect(passRecordCounts(readPassRecords(await sessionLog()))).toMatchObject({
      applied: 1,
      unrecorded: 0,
    });
  });

  it("applies only the armed kind, and leaves the same pass's other ask standing", async () => {
    // Two kinds in ONE pass, armed differently. The levels are disjoint by construction — a kind
    // resolves to exactly one of them — but nothing pins that within a pass until one files both:
    // a policy that leaked across kinds would write a bead the operator only asked to be shown.
    await arm({ "shipped-orphan": "apply", stale: "shadow" });
    orphansMock.mockResolvedValue([orphan("t-4")]);
    staleMock.mockImplementation(async (_cwd, opts) => (opts?.status === "open" ? [cold("t-9")] : []));
    boardIs(() => [cold("t-4"), cold("t-9")]);

    await expectJobStatus(t.db, await runPatrol(), "done");

    expect(createMock).toHaveBeenCalledTimes(2); // one ask per kind
    const applied = outcomeOf(await applyLines(), "retire/close t-4");
    expect(applied).toContain("— APPLIED: closed t-4 as shipped");
    const shadowed =
      (await sessionLog()).split("\n").find((l) => l.includes("SHADOW ") && l.includes("(stale)")) ??
      "";
    expect(shadowed).toContain("retire/defer t-9");

    // The armed kind settled both ends — its subject and its ask. The shadowed one settled neither:
    // t-9 is untouched and its proposal is still an open ask waiting for a human.
    expect(closedIds()).toEqual(["t-4", proposalIn(applied)]);
    expect(proposalIn(shadowed)).not.toBe("");
    expect(closedIds()).not.toContain(proposalIn(shadowed));
  });

  it("stops at the write cap, and the overflow stays open as an ordinary ask — named", async () => {
    const subjects = ["t-1", "t-2", "t-3", "t-4"]; // one more than a pass may write
    orphansMock.mockResolvedValue(subjects.map(orphan));
    boardIs(() => subjects.map(cold));

    await expectJobStatus(t.db, await runPatrol(), "done");

    // The emission cap is the OTHER budget: all four asks are filed, only three are written.
    expect(createMock).toHaveBeenCalledTimes(4);
    const lines = await applyLines();
    expect(lines.filter((l) => l.includes("APPLIED:"))).toHaveLength(MAX_APPLIES_PER_PASS);

    // By count AND by id: an operator has to be able to answer what the cap held back without
    // diffing the board against the log.
    const held = lines.find((l) => l.includes("held back"));
    expect(held).toContain(
      `held back 1 armed proposal(s) — one pass applies at most ${MAX_APPLIES_PER_PASS}`,
    );
    expect(held).toContain("they stay open as ordinary asks");
    // Held back means untouched — still an ask, not a deferred write.
    expect(closedIds()).not.toContain(proposalIn(held));
  });

  it("refuses a subject a run claimed since filing, and applies the one behind it anyway", async () => {
    orphansMock.mockResolvedValue([orphan("t-4"), orphan("t-7")]);
    // The race the whole apply path re-reads for: t-4 is free when the patrol detects and files, and
    // a run holds it by the time the armed loop gets there.
    const leased = bead("t-4", {
      updated_at: "2023-01-01T00:00:00Z",
      assignee: "runner-1",
      labels: [LABELS.runLease(Date.now() + 600_000, "run-9")],
    });
    let claimed = false;
    boardIs(() => {
      const subjects = [claimed ? leased : cold("t-4"), cold("t-7")];
      claimed = true; // a run claims it the moment the patrol has read the board
      return subjects;
    });

    await expectJobStatus(t.db, await runPatrol(), "done");

    const lines = await applyLines();
    const refused = outcomeOf(lines, "retire/close t-4");
    expect(refused).toContain("— REFUSED: cannot apply");
    // The board declining one ask must not cost the pass the next: the run holds t-4, not t-7.
    expect(outcomeOf(lines, "retire/close t-7")).toContain("— APPLIED: closed t-7 as shipped");
    expect(closedIds()).toContain("t-7");
    expect(closedIds()).not.toContain("t-4");
    // The ask survives with the reason on it, so the human who decides about a bead a run took finds
    // the same explanation on the bead as in the log.
    expect(closedIds()).not.toContain(proposalIn(refused));
    expect(
      noteMock.mock.calls.some(
        ([, id, text]) => id === proposalIn(refused) && text.includes("apply FAILED"),
      ),
    ).toBe(true);
  });

  it("summarises an all-refused pass as refusals, never as 'applied 0'", async () => {
    // The console line is what an operator greps the morning after a 03:00 pass. A board that
    // declined every ask is the armed path WORKING; leading with "applied 0 proposal(s)
    // unattended" reads at a glance like a setting that never took.
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    orphansMock.mockResolvedValue([orphan("t-4")]);
    const leased = bead("t-4", {
      updated_at: "2023-01-01T00:00:00Z",
      assignee: "runner-1",
      labels: [LABELS.runLease(Date.now() + 600_000, "run-9")],
    });
    let claimed = false;
    boardIs(() => {
      const subjects = [claimed ? leased : cold("t-4")];
      claimed = true;
      return subjects;
    });

    await expectJobStatus(t.db, await runPatrol(), "done");

    const summary = log.mock.calls.map(([line]) => String(line)).find((l) => l.includes("refused"));
    expect(summary).toBe("[gardener] 1 refused");
    log.mockRestore();
  });

  it("applies nothing at all once its record will not write — a cap it cannot count", async () => {
    // The record IS the accounting: a retry of this job reconstructs what earlier attempts spent
    // from these lines (pass-budget.ts). A pass whose log will not take them cannot make a write it
    // can account for — and unaccounted writes are how one scheduled patrol ends up applying
    // several caps' worth across its attempts.
    const blocked = join(sessionsDir, "not-a-directory");
    writeFileSync(blocked, "");
    process.env.ANTON_SESSIONS_ROOT = join(blocked, "sessions");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const subjects = ["t-1", "t-2", "t-3"];
    orphansMock.mockResolvedValue(subjects.map(orphan));
    boardIs(() => subjects.map(cold));

    await expectJobStatus(t.db, await runPatrol(), "done");

    // NOTHING moved: the attempt is bought with its record line, so a log that will not take one
    // stops the pass before the board write rather than after it. There is no window in which a
    // subject has moved and no line accounts for it.
    expect(closedIds().filter((id) => subjects.includes(id))).toHaveLength(0);
    expect(error.mock.calls.map((args) => args.join(" ")).join("\n")).toContain(
      "stopped applying — the attempt at",
    );
    warn.mockRestore();
    error.mockRestore();
  });

  it("keeps the pass green when an apply blows up, and still writes the ones behind it", async () => {
    orphansMock.mockResolvedValue([orphan("t-4"), orphan("t-7")]);
    boardIs(() => [cold("t-4"), cold("t-7")]);
    closeMock.mockImplementation(async (_cwd, id) => {
      if (id === "t-4") throw new Error("bd close exploded");
      return "";
    });

    await expectJobStatus(t.db, await runPatrol(), "done");

    const lines = await applyLines();
    // Whichever order the two are attempted in, one broken apply is one broken apply: it is a line
    // in the log, not a failed patrol and not a skipped queue behind it.
    expect(outcomeOf(lines, "retire/close t-4")).toContain("— COULD NOT APPLY: applying");
    expect(outcomeOf(lines, "retire/close t-7")).toContain("— APPLIED:");
    expect(closedIds()).toContain("t-7");
  });
});
