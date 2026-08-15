/**
 * Integration tests for the unstick pass (anton-wvcy): a real anton.db (in-memory, full migrated
 * schema) driving `unstickPass` end to end — report in, jobs and escalations out. Only `bd` is
 * stubbed, because the board read/note/sync are the pass's one external dependency.
 *
 * The acceptance property under test is IDEMPOTENCE ACROSS PASSES. This job is on an hourly cron, so
 * every case here runs the pass TWICE over unchanged state and asserts the second pass is a no-op:
 * a stall must produce one re-enqueue or one escalation in total, not one per hour. Running each
 * scenario once would pass while the loop it is meant to prevent still existed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";

import * as schema from "../db/schema";
import { makeTestDb, type TestDb } from "../db/testing";
import { LABELS, type Bead, type Gate } from "../beads/bd";
import type { PrActivity } from "../git/pr";
import { saveRunHealthReport, type RunHealthFinding } from "../run-health";
import type { Clock } from "./queue";

const listMock = vi.fn<(cwd: string, extra?: string[]) => Promise<Bead[]>>();
const noteMock = vi.fn<(cwd: string, id: string, text: string) => Promise<void>>();
const syncMock = vi.fn<(cwd: string) => Promise<void>>();
const pullMock = vi.fn<(cwd: string) => Promise<void>>();
/** The open gates the pass re-reads before escalating a `needs-human` finding. */
const gateListMock = vi.fn<(cwd: string) => Promise<Gate[]>>();

vi.mock("../beads/bd", async () => {
  const actual = await vi.importActual<typeof import("../beads/bd")>("../beads/bd");
  return {
    ...actual,
    beads: {
      ...actual.beads,
      list: (...args: [string, string[]?]) => listMock(...args),
      note: (...args: [string, string, string]) => noteMock(...args),
      sync: (...args: [string]) => syncMock(...args),
      pull: (...args: [string]) => pullMock(...args),
      gateList: (...args: [string]) => gateListMock(...args),
    },
  };
});

/**
 * The one job read the pass makes per `exhausted-job` finding, wrapped so a test can make it throw.
 * Defaults to the real implementation, so every other case runs against the real queue module.
 */
const getJobMock = vi.fn<typeof import("./queue").getJob>();

vi.mock("./queue", async () => {
  const actual = await vi.importActual<typeof import("./queue")>("./queue");
  return { ...actual, getJob: (...args: Parameters<typeof actual.getJob>) => getJobMock(...args) };
});

const { getJob: realGetJob } = await vi.importActual<typeof import("./queue")>("./queue");
const { resumeEpic, unstickPass } = await import("./unstick");

const NOW = 1_700_000_000_000;
const HOUR = 3_600_000;
const REPO = "/tmp/p1";
const clock: Clock = { now: () => NOW };

function secDate(ms: number): Date {
  return new Date(Math.floor(ms / 1000) * 1000);
}

let t: TestDb;

/** An epic on the board as the pass expects to find it: open, with no run-lease label. */
function openEpic(id: string): Bead {
  return { id, title: id, status: "open", issue_type: "epic", labels: [] };
}

/** An open human gate as `bd gate list` returns it — still waiting on a person. */
function openGate(id: string): Gate {
  return {
    id,
    title: `Ad-hoc gate ${id}`,
    status: "open",
    issue_type: "gate",
    await_type: "human",
    created_at: new Date(NOW - 3 * HOUR).toISOString(),
  };
}

/** The live PR the pass re-reads before escalating a `stale-pr` finding. Idle by default. */
const prActivityMock =
  vi.fn<(repo: string, number: number, signal?: AbortSignal) => Promise<PrActivity>>();

function prActivity(o: Partial<PrActivity> = {}): PrActivity {
  return {
    number: 42,
    state: "OPEN",
    url: "https://github.com/o/r/pull/42",
    updatedAtMs: NOW - 3 * 24 * HOUR,
    isDraft: false,
    ...o,
  };
}

beforeEach(() => {
  t = makeTestDb();
  t.db
    .insert(schema.projects)
    .values({ id: "p1", slug: "p1", name: "p1", repoPath: REPO })
    .run();
  // Every epic these tests reference, open and unleased. The pass pulls the board with `--status
  // all`, so a bead missing from it reads as DELETED and settles the finding — the default board has
  // to carry the epics under test, or nothing would ever be resumed or escalated.
  listMock.mockResolvedValue(["e-1", "e-2", "e-3", "e-9"].map(openEpic));
  noteMock.mockResolvedValue(undefined);
  syncMock.mockResolvedValue(undefined);
  pullMock.mockResolvedValue(undefined);
  // Every gate these tests reference, still open. The pass re-reads the open gates before escalating
  // a `needs-human` finding, so a gate missing from this list reads as RESOLVED and settles the wait.
  gateListMock.mockResolvedValue(["g-1", "g-2"].map(openGate));
  prActivityMock.mockResolvedValue(prActivity());
  getJobMock.mockImplementation(realGetJob);
});

afterEach(() => {
  t.close();
  vi.clearAllMocks();
});

/** A parked run of `epicBeadId`, stalled with `error` — the subject of a `parked-run` finding. */
function seedParkedRun(id: string, epicBeadId: string, error: string | null): void {
  t.db
    .insert(schema.runs)
    .values({
      id,
      projectId: "p1",
      epicBeadId,
      status: "parked",
      error,
      startedAt: secDate(NOW - 5 * HOUR),
      updatedAt: secDate(NOW - 4 * HOUR),
    })
    .run();
}

function seedReport(...findings: RunHealthFinding[]): Promise<void> {
  return saveRunHealthReport(t.db, clock, { projectId: "p1", findings });
}

/** A settled job the report's `exhausted-job` finding points at, re-read before escalating. */
function seedJob(id: string, o: { status: string; attempts: number; lastError: string }): void {
  t.db
    .insert(schema.jobs)
    .values({
      id,
      type: "execute-epic",
      projectId: "p1",
      payloadJson: JSON.stringify({ projectId: "p1", epicBeadId: "e-9" }),
      status: o.status,
      attempts: o.attempts,
      lastError: o.lastError,
      runAt: secDate(NOW - 4 * HOUR),
      createdAt: secDate(NOW - 5 * HOUR),
      updatedAt: secDate(NOW - 4 * HOUR),
    })
    .run();
}

function seedStalePrReport(): Promise<void> {
  return seedReport({
    kind: "stale-pr",
    key: "stale-pr:e-3:42",
    reason: "PR #42 idle 3d with the target still in review",
    since: NOW - 3 * 24 * HOUR,
    ageMs: 3 * 24 * HOUR,
    beadId: "e-3",
    prNumber: 42,
    prUrl: "https://github.com/o/r/pull/42",
  });
}

function seedExhaustedJobReport(...jobIds: string[]): Promise<void> {
  return seedReport(
    ...jobIds.map((jobId) => ({
      kind: "exhausted-job" as const,
      key: `exhausted-job:${jobId}`,
      reason: "execute-epic job parked",
      since: NOW - 4 * HOUR,
      ageMs: 4 * HOUR,
      jobId,
      beadId: "e-9",
    })),
  );
}

function seedHumanGateReport(gateId: string): Promise<void> {
  return seedReport({
    kind: "needs-human",
    key: `needs-human:${gateId}`,
    reason: "waiting on a human 3h: the founder wants to see the design first",
    since: NOW - 3 * HOUR,
    ageMs: 3 * HOUR,
    gateId,
    beadId: "t-1",
    targetBeadId: "e-2",
  });
}

function parkedRunFinding(runId: string, beadId: string, reason: string): RunHealthFinding {
  return {
    kind: "parked-run",
    key: `parked-run:${runId}`,
    reason,
    since: NOW - 4 * HOUR,
    ageMs: 4 * HOUR,
    runId,
    beadId,
  };
}

const sweep = (opts: { signal?: AbortSignal } = {}) =>
  unstickPass(
    {
      db: t.db,
      clock,
      readPrActivity: (repo, number, signal) => prActivityMock(repo, number, signal),
    },
    { projectId: "p1", repoPath: REPO, ...opts },
  );

function jobRows() {
  return t.db.select().from(schema.jobs).all();
}

function escalationRows() {
  return t.db.select().from(schema.escalations).all();
}

describe("resumable parks re-enqueue exactly once across two sweeps", () => {
  it("enqueues a fresh execute-epic job for a usage-limit park whose window has passed, then holds", async () => {
    seedParkedRun("r-1", "e-1", "usage-limit");
    await seedReport(parkedRunFinding("r-1", "e-1", "parked 4h ago: usage-limit"));

    const first = await sweep();
    expect(first).toMatchObject({ findings: 1, resumed: 1, escalated: 0, held: 0 });
    const afterFirst = jobRows();
    expect(afterFirst).toHaveLength(1);
    expect(afterFirst[0]).toMatchObject({ type: "execute-epic", status: "queued" });

    // The second pass sees its own enqueue as an active job owning the run — the idempotence the
    // hourly cron depends on. Without it, a stall that stays parked accrues a job every hour.
    const second = await sweep();
    expect(second).toMatchObject({ findings: 1, resumed: 0, escalated: 0, held: 1 });
    expect(jobRows()).toHaveLength(1);
    expect(escalationRows()).toEqual([]);
  });

  it("resumes the epic's own parked job rather than starting a duplicate", async () => {
    // A parked job already "covers" the epic, so `enqueueExecuteEpicIfAbsent` alone would no-op and
    // silently do nothing. The pass must un-park THAT job, reusing its open run and worktree.
    seedParkedRun("r-1", "e-1", "usage-limit");
    t.db
      .insert(schema.jobs)
      .values({
        id: "j-parked",
        type: "execute-epic",
        projectId: "p1",
        payloadJson: JSON.stringify({ projectId: "p1", epicBeadId: "e-1" }),
        status: "parked",
        // The quota window this park was waiting on closed an hour ago.
        lastError: `usage-limit: resumes at ${new Date(NOW - HOUR).toISOString()}`,
        runAt: secDate(NOW - HOUR),
        createdAt: secDate(NOW - 5 * HOUR),
        updatedAt: secDate(NOW - 4 * HOUR),
      })
      .run();
    await seedReport(parkedRunFinding("r-1", "e-1", "parked 4h ago: usage-limit"));

    expect(await sweep()).toMatchObject({ resumed: 1 });
    const jobs = jobRows();
    expect(jobs).toHaveLength(1); // resumed in place — no duplicate row
    expect(jobs[0]).toMatchObject({ id: "j-parked", status: "queued" });

    expect(await sweep()).toMatchObject({ resumed: 0, held: 1 });
    expect(jobRows()).toHaveLength(1);
  });

  it("re-enqueues a bead whose run-lease expired with no foreign holder, exactly once", async () => {
    listMock.mockResolvedValue([
      {
        id: "e-1",
        title: "e-1",
        status: "open",
        issue_type: "epic",
        labels: [LABELS.runLease(NOW - 2 * HOUR, "run-x")],
      },
    ]);
    await seedReport({
      kind: "dead-lease",
      key: "dead-lease:e-1",
      reason: "run-lease expired 2h ago",
      since: NOW - 2 * HOUR,
      ageMs: 2 * HOUR,
      beadId: "e-1",
    });

    expect(await sweep()).toMatchObject({ resumed: 1, escalated: 0 });
    expect(jobRows()).toHaveLength(1);

    expect(await sweep()).toMatchObject({ resumed: 0, held: 1 });
    expect(jobRows()).toHaveLength(1);
  });

  it("enqueues nothing for a dead lease the pull reveals was already cleared", async () => {
    // The owner didn't die: it settled and swept its own lease label, and the pull is what makes that
    // visible. With no lease left there is no dead run to revive — enqueuing here would start fresh
    // work on an epic nobody asked to run.
    listMock.mockResolvedValue([
      { id: "e-1", title: "e-1", status: "open", issue_type: "epic", labels: [] },
    ]);
    await seedReport({
      kind: "dead-lease",
      key: "dead-lease:e-1",
      reason: "run-lease expired 2h ago",
      since: NOW - 2 * HOUR,
      ageMs: 2 * HOUR,
      beadId: "e-1",
    });

    expect(await sweep()).toMatchObject({ findings: 1, resumed: 0, escalated: 0, held: 1 });
    expect(jobRows()).toEqual([]);
    expect(escalationRows()).toEqual([]);
  });

  it("pulls the shared board before judging any lease, and resumes nothing when the pull fails", async () => {
    // The local Dolt working set trails the remote by a sync heartbeat: without a pull, a lease
    // another machine renewed reads as absent and the resume below would double-run its work. A pull
    // that fails leaves that unknowable, so every lease-gated resume stands down for this pass.
    pullMock.mockRejectedValue(new Error("offline"));
    seedParkedRun("r-1", "e-1", "usage-limit");
    await seedReport(parkedRunFinding("r-1", "e-1", "parked 4h ago: usage-limit"));

    expect(await sweep()).toMatchObject({ findings: 1, resumed: 0, escalated: 0, held: 1 });
    expect(pullMock).toHaveBeenCalledWith(REPO);
    expect(jobRows()).toEqual([]);
    expect(escalationRows()).toEqual([]); // held, not escalated: nagging about this would be noise

    // The stall is not lost — the next pass, with the board back, does the resume it deferred.
    pullMock.mockResolvedValue(undefined);
    expect(await sweep()).toMatchObject({ resumed: 1 });
    expect(jobRows()).toHaveLength(1);
  });

  it("stands down on a parked run whose epic another machine has since leased", async () => {
    seedParkedRun("r-1", "e-1", "usage-limit");
    listMock.mockResolvedValue([
      {
        id: "e-1",
        title: "e-1",
        status: "open",
        issue_type: "epic",
        labels: [LABELS.runLease(NOW + HOUR, "run-elsewhere")],
      },
    ]);
    await seedReport(parkedRunFinding("r-1", "e-1", "parked 4h ago: usage-limit"));

    expect(await sweep()).toMatchObject({ resumed: 0, escalated: 0, held: 1 });
    expect(jobRows()).toEqual([]);
  });

  it("holds — enqueuing nothing and escalating nothing — while the usage window is still closed", async () => {
    seedParkedRun("r-1", "e-1", "usage-limit");
    t.db
      .insert(schema.jobs)
      .values({
        id: "j-parked",
        type: "execute-epic",
        projectId: "p1",
        payloadJson: JSON.stringify({ projectId: "p1", epicBeadId: "e-1" }),
        status: "parked",
        lastError: `usage-limit: resumes at ${new Date(NOW + 2 * HOUR).toISOString()}`,
        runAt: secDate(NOW + 2 * HOUR),
        createdAt: secDate(NOW - 5 * HOUR),
        updatedAt: secDate(NOW - HOUR),
      })
      .run();
    await seedReport(parkedRunFinding("r-1", "e-1", "parked 4h ago: usage-limit"));

    const summary = await sweep();
    expect(summary).toMatchObject({ findings: 1, resumed: 0, escalated: 0, held: 1 });
    // Still exactly the parked job it started with: this run is waiting, not stuck, so it must be
    // neither restarted (burning a closed quota) nor escalated (nagging about a self-healing wait).
    expect(jobRows().map((j) => j.status)).toEqual(["parked"]);
    expect(escalationRows()).toEqual([]);
    expect(noteMock).not.toHaveBeenCalled();
  });

  it("never revives an epic whose job an operator cancelled, however long the window has been open", async () => {
    // Cancelling the queued backoff job of a usage-limit park is an explicit stop, and `cancelJob`
    // promises no durability path revives it — but the run row stays parked, so the finding keeps
    // coming back. Without the cancelled-job check this pass would enqueue a fresh job every time.
    seedParkedRun("r-1", "e-1", "usage-limit");
    t.db
      .insert(schema.jobs)
      .values({
        id: "j-cancelled",
        type: "execute-epic",
        projectId: "p1",
        payloadJson: JSON.stringify({ projectId: "p1", epicBeadId: "e-1" }),
        status: "cancelled",
        lastError: "cancelled by operator",
        runAt: secDate(NOW - HOUR),
        createdAt: secDate(NOW - 5 * HOUR),
        updatedAt: secDate(NOW - HOUR),
      })
      .run();
    await seedReport(parkedRunFinding("r-1", "e-1", "parked 4h ago: usage-limit"));

    expect(await sweep()).toMatchObject({ findings: 1, resumed: 0, escalated: 0, held: 1 });
    expect(jobRows().map((j) => j.status)).toEqual(["cancelled"]);
    expect(escalationRows()).toEqual([]);
  });

  it("never revives a dead lease left behind by a cancelled job either", async () => {
    // The same operator stop, reaching the pass by the other route: the cancel terminalized the job
    // but its lease cleanup never landed on the shared board (a crash, a failed sync), so the label
    // expired into a `dead-lease`. `resumeEpic` cannot catch this on its own — a cancelled job is
    // outside its covering set, so it would enqueue a FRESH job and undo the cancel.
    listMock.mockResolvedValue([
      {
        id: "e-1",
        title: "e-1",
        status: "open",
        issue_type: "epic",
        labels: [LABELS.runLease(NOW - 2 * HOUR, "run-x")],
      },
    ]);
    t.db
      .insert(schema.jobs)
      .values({
        id: "j-cancelled",
        type: "execute-epic",
        projectId: "p1",
        payloadJson: JSON.stringify({ projectId: "p1", epicBeadId: "e-1" }),
        status: "cancelled",
        lastError: "cancelled by operator",
        runAt: secDate(NOW - HOUR),
        createdAt: secDate(NOW - 5 * HOUR),
        updatedAt: secDate(NOW - HOUR),
      })
      .run();
    await seedReport({
      kind: "dead-lease",
      key: "dead-lease:e-1",
      reason: "run-lease expired 2h ago",
      since: NOW - 2 * HOUR,
      ageMs: 2 * HOUR,
      beadId: "e-1",
    });

    expect(await sweep()).toMatchObject({ findings: 1, resumed: 0, escalated: 0, held: 1 });
    expect(jobRows().map((j) => j.status)).toEqual(["cancelled"]);
    expect(escalationRows()).toEqual([]);
  });

  it("leaves a run a live job already owns completely alone", async () => {
    seedParkedRun("r-1", "e-1", "usage-limit");
    t.db
      .insert(schema.jobs)
      .values({
        id: "j-running",
        type: "execute-epic",
        projectId: "p1",
        payloadJson: JSON.stringify({ projectId: "p1", epicBeadId: "e-1" }),
        status: "running",
        runAt: secDate(NOW - HOUR),
        createdAt: secDate(NOW - HOUR),
        updatedAt: secDate(NOW - HOUR),
      })
      .run();
    await seedReport(parkedRunFinding("r-1", "e-1", "parked 4h ago: usage-limit"));

    expect(await sweep()).toMatchObject({ resumed: 0, escalated: 0, held: 1 });
    expect(jobRows().map((j) => j.status)).toEqual(["running"]);
  });
});

describe("resumeEpic and a cancel that races it", () => {
  /** The parked execute-epic job `resumeEpic` would revive. */
  function seedParkedJob(id: string, epicBeadId: string): void {
    t.db
      .insert(schema.jobs)
      .values({
        id,
        type: "execute-epic",
        projectId: "p1",
        payloadJson: JSON.stringify({ projectId: "p1", epicBeadId }),
        status: "parked",
        lastError: "usage-limit",
        runAt: secDate(NOW - HOUR),
        createdAt: secDate(NOW - 5 * HOUR),
        updatedAt: secDate(NOW - 4 * HOUR),
      })
      .run();
  }

  it("does NOT enqueue a fresh job when the resumable one was cancelled under it", async () => {
    // The classifier's cancellation guard reads a snapshot taken earlier in the pass. An operator who
    // cancels in the window between that snapshot and this resume makes `resume` refuse — and a
    // cancelled row does not cover the epic, so falling through to the enqueue would hand them back
    // the exact job they just stopped.
    seedParkedJob("j-parked", "e-1");
    const resume = vi.fn(async (jobId: string) => {
      t.db
        .update(schema.jobs)
        .set({ status: "cancelled", lastError: "cancelled by operator" })
        .where(eq(schema.jobs.id, jobId))
        .run();
      return false;
    });
    const enqueueIfAbsent = vi.fn(() => "j-fresh");

    const outcome = await resumeEpic(t.db, clock, "p1", "e-1", { resume, enqueueIfAbsent });

    expect(outcome).toBe("job-cancelled");
    expect(enqueueIfAbsent).not.toHaveBeenCalled();
    expect(jobRows().map((j) => j.status)).toEqual(["cancelled"]);
  });

  it("does NOT enqueue when the cancel landed BEFORE the resumable lookup could see the job", async () => {
    // The other half of the same window: a cancelled row is outside the resumable set too, so the
    // lookup finds nothing at all and only the epic's latest job records that an operator said stop.
    seedParkedJob("j-parked", "e-1");
    t.db
      .update(schema.jobs)
      .set({ status: "cancelled", lastError: "cancelled by operator" })
      .where(eq(schema.jobs.id, "j-parked"))
      .run();
    const resume = vi.fn(async () => false);
    const enqueueIfAbsent = vi.fn(() => "j-fresh");

    const outcome = await resumeEpic(t.db, clock, "p1", "e-1", { resume, enqueueIfAbsent });

    expect(outcome).toBe("job-cancelled");
    expect(resume).not.toHaveBeenCalled();
    expect(enqueueIfAbsent).not.toHaveBeenCalled();
  });

  it("enqueues when a NEWER job settled after the cancel — the stop applied to the older attempt", async () => {
    seedParkedJob("j-old", "e-1");
    t.db
      .update(schema.jobs)
      .set({ status: "cancelled", updatedAt: secDate(NOW - 3 * HOUR) })
      .where(eq(schema.jobs.id, "j-old"))
      .run();
    t.db
      .insert(schema.jobs)
      .values({
        id: "j-done",
        type: "execute-epic",
        projectId: "p1",
        payloadJson: JSON.stringify({ projectId: "p1", epicBeadId: "e-1" }),
        status: "done",
        runAt: secDate(NOW - HOUR),
        createdAt: secDate(NOW - 2 * HOUR),
        updatedAt: secDate(NOW - HOUR),
      })
      .run();
    const enqueueIfAbsent = vi.fn(() => "j-fresh");

    const outcome = await resumeEpic(t.db, clock, "p1", "e-1", {
      resume: vi.fn(async () => false),
      enqueueIfAbsent,
    });

    expect(outcome).toBe("enqueued");
    expect(enqueueIfAbsent).toHaveBeenCalledWith("p1", "e-1");
  });

  it("honours a cancel that settled in the SAME SECOND as an older job", async () => {
    // Every job timestamp is truncated to whole seconds, so `updatedAt` alone cannot separate two
    // jobs settled inside one second — and without a total order SQLite may hand back the older
    // `done` row, losing the cancel and restarting work the operator explicitly stopped.
    const settledAt = secDate(NOW - HOUR);
    t.db
      .insert(schema.jobs)
      .values({
        id: "j-done",
        type: "execute-epic",
        projectId: "p1",
        payloadJson: JSON.stringify({ projectId: "p1", epicBeadId: "e-1" }),
        status: "done",
        runAt: secDate(NOW - 2 * HOUR),
        createdAt: secDate(NOW - 3 * HOUR),
        updatedAt: settledAt,
      })
      .run();
    seedParkedJob("j-cancelled", "e-1");
    t.db
      .update(schema.jobs)
      .set({ status: "cancelled", lastError: "cancelled by operator", updatedAt: settledAt })
      .where(eq(schema.jobs.id, "j-cancelled"))
      .run();
    const enqueueIfAbsent = vi.fn(() => "j-fresh");

    const outcome = await resumeEpic(t.db, clock, "p1", "e-1", {
      resume: vi.fn(async () => false),
      enqueueIfAbsent,
    });

    expect(outcome).toBe("job-cancelled");
    expect(enqueueIfAbsent).not.toHaveBeenCalled();
  });

  it("still enqueues when the resumable job merely vanished — only a cancel is an operator stop", async () => {
    seedParkedJob("j-parked", "e-1");
    const resume = vi.fn(async (jobId: string) => {
      t.db.delete(schema.jobs).where(eq(schema.jobs.id, jobId)).run();
      return false;
    });
    const enqueueIfAbsent = vi.fn(() => "j-fresh");

    const outcome = await resumeEpic(t.db, clock, "p1", "e-1", { resume, enqueueIfAbsent });

    expect(outcome).toBe("enqueued");
    expect(enqueueIfAbsent).toHaveBeenCalledWith("p1", "e-1");
  });
});

describe("non-resumable parks produce exactly one escalation and no enqueue", () => {
  it("holds a park whose epic has since been abandoned — a closed epic re-escalates forever", async () => {
    // An abandon raised from an `exhausted-job` escalation closes the bead but has no run id to
    // settle, so the run stays parked and this finding survives it. Escalating again would offer an
    // abandon that fails on the closed bead, leaving the row to come back every sweep.
    seedParkedRun("r-2", "e-2", "agent exited 1");
    listMock.mockResolvedValue([
      { id: "e-2", title: "e-2", status: "closed", issue_type: "epic", labels: [] },
    ]);
    await seedReport(parkedRunFinding("r-2", "e-2", "parked 4h ago: agent exited 1"));

    expect(await sweep()).toMatchObject({ findings: 1, resumed: 0, escalated: 0, held: 1 });
    expect(escalationRows()).toEqual([]);
    expect(jobRows()).toEqual([]);
    expect(noteMock).not.toHaveBeenCalled();
  });

  it("holds a park whose epic was DELETED — a deletion must not come back as a poison job", async () => {
    // The finding outlives the bead: the run row stays parked, and with the quota window long
    // reopened every other guard says resume. Enqueuing here hands execute-epic an id it can only
    // fail on (`bead ... not found`), which parks the fresh job as poison and escalates it — an
    // intentional deletion turned into founder-facing noise, every single hour.
    seedParkedRun("r-1", "e-1", "usage-limit");
    listMock.mockResolvedValue([]);
    await seedReport(parkedRunFinding("r-1", "e-1", "parked 4h ago: usage-limit"));

    expect(await sweep()).toMatchObject({ findings: 1, resumed: 0, escalated: 0, held: 1 });
    expect(jobRows()).toEqual([]);
    expect(escalationRows()).toEqual([]);
  });

  it("escalates an agent failure once across two sweeps, and never enqueues", async () => {
    seedParkedRun("r-2", "e-2", "agent exited 1");
    await seedReport(parkedRunFinding("r-2", "e-2", "parked 4h ago: agent exited 1"));

    const first = await sweep();
    expect(first).toMatchObject({ findings: 1, resumed: 0, escalated: 1, held: 0 });
    expect(jobRows()).toEqual([]);

    const rows = escalationRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      projectId: "p1",
      findingKey: "parked-run:r-2",
      kind: "parked-run",
      reason: "parked 4h ago: agent exited 1",
      beadId: "e-2",
      epicBeadId: "e-2", // the resume button's target: the run's epic
      runId: "r-2",
      status: "open",
      resolution: null,
    });
    // The evidence the panel renders is the whole finding, frozen at raise time.
    expect(JSON.parse(rows[0]!.evidenceJson)).toMatchObject({ ageMs: 4 * HOUR, key: "parked-run:r-2" });

    const second = await sweep();
    expect(second).toMatchObject({ escalated: 0, held: 1 });
    expect(escalationRows()).toHaveLength(1); // one board item per stall, not one per sweep
    expect(jobRows()).toEqual([]);
  });

  it("writes the board-native bd note once and pushes it, then stops retrying it", async () => {
    seedParkedRun("r-2", "e-2", "agent exited 1");
    await seedReport(parkedRunFinding("r-2", "e-2", "parked 4h ago: agent exited 1"));

    await sweep();
    expect(noteMock).toHaveBeenCalledTimes(1);
    const [cwd, beadId, text] = noteMock.mock.calls[0]!;
    expect([cwd, beadId]).toEqual([REPO, "e-2"]);
    expect(text).toContain("agent exited 1");
    expect(text).not.toContain("\n");
    expect(syncMock).toHaveBeenCalledWith(REPO); // the note reaches the remote, not just Dolt-local
    expect(escalationRows()[0]!.notedAt).not.toBeNull();

    await sweep();
    expect(noteMock).toHaveBeenCalledTimes(1);
  });

  it("retries the note on the next sweep when bd fails, without losing the escalation", async () => {
    seedParkedRun("r-2", "e-2", "agent exited 1");
    await seedReport(parkedRunFinding("r-2", "e-2", "parked 4h ago: agent exited 1"));
    noteMock.mockRejectedValueOnce(new Error("bd unavailable"));

    expect(await sweep()).toMatchObject({ escalated: 1 });
    expect(escalationRows()[0]!.notedAt).toBeNull(); // unstamped on purpose
    expect(syncMock).not.toHaveBeenCalled(); // nothing was written, so nothing is owed a push

    await sweep();
    expect(noteMock).toHaveBeenCalledTimes(2);
    expect(escalationRows()).toHaveLength(1);
    expect(escalationRows()[0]!.notedAt).not.toBeNull();
  });

  it.each([
    ["stale-pr", "PR #42 has had no activity for 3d"],
    ["exhausted-job", "spent 3/3 attempts: tests failed"],
  ] as const)("escalates %s without ever enqueuing a retry", async (kind, reason) => {
    await seedReport({
      kind,
      key: `${kind}:e-3`,
      reason,
      since: NOW - 3 * 24 * HOUR,
      ageMs: 3 * 24 * HOUR,
      beadId: "e-3",
      ...(kind === "stale-pr" ? { prNumber: 42, prUrl: "https://github.com/o/r/pull/42" } : {}),
    });

    expect(await sweep()).toMatchObject({ resumed: 0, escalated: 1 });
    expect(jobRows()).toEqual([]);
    expect(escalationRows()[0]).toMatchObject({ kind, reason, beadId: "e-3" });

    expect(await sweep()).toMatchObject({ escalated: 0, held: 1 });
    expect(escalationRows()).toHaveLength(1);
  });

  it("holds a stale-pr finding whose PR merged between the sweep and now", async () => {
    // The report named it idle; it has since landed. Escalating would ask the founder to judge —
    // and possibly abandon — work that is already delivered.
    prActivityMock.mockResolvedValue(prActivity({ state: "MERGED" }));
    await seedStalePrReport();

    expect(await sweep()).toMatchObject({ findings: 1, escalated: 0, held: 1 });
    expect(escalationRows()).toEqual([]);
    expect(prActivityMock).toHaveBeenCalledWith(REPO, 42, undefined);
  });

  it("holds a stale-pr finding whose PR someone has since touched", async () => {
    // Re-checked through the sweep's own detector, so "idle" means the same thing in both passes:
    // an hour-old review comment puts this PR well inside the 24h threshold.
    prActivityMock.mockResolvedValue(prActivity({ updatedAtMs: NOW - HOUR }));
    await seedStalePrReport();

    expect(await sweep()).toMatchObject({ escalated: 0, held: 1 });
    expect(escalationRows()).toEqual([]);
  });

  it.each([
    ["deleted from", [] as Bead[]],
    ["closed on", [{ id: "e-3", title: "e-3", status: "closed", issue_type: "epic", labels: [] }] as Bead[]],
  ])("holds a stale-pr finding whose target was %s the board", async (_how, board) => {
    // The PR is still open and idle, so the re-read alone would escalate work that already settled —
    // and its bd note would then fail on the gone bead, raising the same finding every sweep.
    listMock.mockResolvedValue(board);
    await seedStalePrReport();

    expect(await sweep()).toMatchObject({ findings: 1, escalated: 0, held: 1 });
    expect(escalationRows()).toEqual([]);
    expect(prActivityMock).not.toHaveBeenCalled(); // settled work costs no gh read either
    expect(await sweep()).toMatchObject({ escalated: 0, held: 1 });
  });

  it("still escalates a stale-pr finding whose bead is absent from an UNTRUSTED board", async () => {
    // A pull that didn't land means the local mirror may simply not have the bead yet, and a missed
    // escalation strands the stall the sweep exists to surface.
    pullMock.mockRejectedValue(new Error("offline"));
    listMock.mockResolvedValue([]);
    await seedStalePrReport();

    expect(await sweep()).toMatchObject({ escalated: 1 });
  });

  it("escalates a stale-pr finding the re-read confirms, and once the PR is unreadable", async () => {
    await seedStalePrReport();
    expect(await sweep()).toMatchObject({ escalated: 1 });

    // Fails OPEN: a gh outage must not silently drop the stall the sweep exists to surface.
    t.db.delete(schema.escalations).run();
    prActivityMock.mockRejectedValue(new Error("gh unavailable"));
    expect(await sweep()).toMatchObject({ escalated: 1 });
  });

  it("holds an exhausted-job finding whose job has since been resumed", async () => {
    // An operator un-parked it after the sweep. Escalating now would offer an "abandon" that
    // cancels a job which is live again.
    seedJob("j-9", { status: "queued", attempts: 3, lastError: "tests failed" });
    await seedExhaustedJobReport("j-9");

    expect(await sweep()).toMatchObject({ findings: 1, escalated: 0, held: 1 });
    expect(escalationRows()).toEqual([]);
  });

  it("holds an exhausted-job finding whose epic has since been abandoned", async () => {
    // An abandon closes the bead BEFORE cancelling the job, so a cancel that fails leaves the job
    // parked under a closed epic. Escalating it again offers an abandon whose `abandonTicket` now
    // throws on the closed bead — settling the escalation without settling the job, every sweep.
    seedJob("j-9", { status: "parked", attempts: 3, lastError: "failed 3×: tests failed" });
    listMock.mockResolvedValue([
      { id: "e-9", title: "e-9", status: "closed", issue_type: "epic", labels: [] },
    ]);
    await seedExhaustedJobReport("j-9");

    expect(await sweep()).toMatchObject({ findings: 1, escalated: 0, held: 1 });
    expect(escalationRows()).toEqual([]);
    expect(noteMock).not.toHaveBeenCalled();
  });

  it("escalates a job still parked out of attempts, and a poison park that never retried", async () => {
    seedJob("j-9", { status: "parked", attempts: 3, lastError: "failed 3×: tests failed" });
    seedJob("j-10", { status: "parked", attempts: 1, lastError: "poison: agent 'x' is disabled" });
    await seedExhaustedJobReport("j-9", "j-10");

    expect(await sweep()).toMatchObject({ findings: 2, escalated: 2, held: 0 });
    expect(escalationRows().map((r) => r.jobId).sort()).toEqual(["j-10", "j-9"]);
  });

  it("points a human-gate escalation at the RUN TARGET, not the ticket the gate blocks", async () => {
    // The resume button acts on `epicBeadId`, and jobs are keyed by run target — pointing it at the
    // gated ticket would enqueue work execute-epic never dispatches on its own.
    await seedReport({
      kind: "needs-human",
      key: "needs-human:g-1",
      reason: "waiting on a human 3h: the founder wants to see the design first",
      since: NOW - 3 * HOUR,
      ageMs: 3 * HOUR,
      gateId: "g-1",
      beadId: "t-1",
      targetBeadId: "e-2",
    });

    expect(await sweep()).toMatchObject({ findings: 1, resumed: 0, escalated: 1, held: 0 });
    expect(escalationRows()[0]).toMatchObject({
      findingKey: "needs-human:g-1",
      kind: "needs-human",
      beadId: "t-1", // where the wait is visible on the board — and where the note lands
      epicBeadId: "e-2",
    });
    expect(jobRows()).toEqual([]); // a human gate is never auto-resumed
  });

  it("names NO run target for a gate hung on work anton doesn't run", async () => {
    // A founder can gate anything — a molecule step, a bead this board read doesn't carry — and the
    // detector reports that wait with no `targetBeadId`. Falling back to the gated bead would point
    // resolve-and-resume at something execute-epic cannot run; empty lets it close the gate and stop.
    await seedReport({
      kind: "needs-human",
      key: "needs-human:g-2",
      reason: "waiting on a human 1h: no reason recorded on the gate",
      since: NOW - HOUR,
      ageMs: HOUR,
      gateId: "g-2",
      beadId: "step-3",
    });

    expect(await sweep()).toMatchObject({ findings: 1, escalated: 1 });
    expect(escalationRows()[0]).toMatchObject({ beadId: "step-3", epicBeadId: null });
  });

  it("holds a human-gate finding whose gate was resolved between the sweep and now", async () => {
    // The sweep runs on the hour and this pass at :10, so a founder who answers inside that gap would
    // otherwise get "Waiting on you" for a wait they already ended — and nothing retires it: later
    // reports just omit the finding while the escalation it opened stays on the board.
    gateListMock.mockResolvedValue([openGate("g-2")]);
    await seedHumanGateReport("g-1");

    expect(await sweep()).toMatchObject({ findings: 1, escalated: 0, held: 1 });
    expect(escalationRows()).toEqual([]);
    expect(noteMock).not.toHaveBeenCalled();
  });

  it("retires an OPEN gate wait once the gate is answered, even though the report has moved on", async () => {
    // The window the pre-raise re-check can't see: the founder answers AFTER the row was raised, so
    // the next sweep simply omits the finding and no later pass ever visits it again. Without this
    // the board would show "Waiting on you" for a wait that ended, and the only answers offered
    // would resolve an already-closed gate and restart work nobody asked to restart.
    await seedHumanGateReport("g-1");
    expect(await sweep()).toMatchObject({ escalated: 1, settled: 0 });

    gateListMock.mockResolvedValue([openGate("g-2")]);
    await seedReport(); // the gate is answered: the sweep no longer reports it at all

    expect(await sweep()).toMatchObject({ findings: 0, settled: 1 });
    expect(escalationRows()[0]).toMatchObject({ status: "resolved", resolution: "dismissed" });
    // Idempotent, like every other verb here: the second pass has nothing left to settle.
    expect(await sweep()).toMatchObject({ findings: 0, settled: 0 });
  });

  it("retires an open gate wait whose gate was resolved rather than deleted", async () => {
    // `bd gate list` defaults to open gates, but a resolved one that still shows up is over just the
    // same — judged by the sweep's own detector, so the two can't drift on what an open wait is.
    await seedHumanGateReport("g-1");
    await sweep();

    gateListMock.mockResolvedValue([{ ...openGate("g-1"), status: "closed" }]);
    await seedReport();

    expect(await sweep()).toMatchObject({ settled: 1 });
    expect(escalationRows()[0]).toMatchObject({ status: "resolved", resolution: "dismissed" });
  });

  it("keeps an open gate wait when the gate list can't be read", async () => {
    // Fails OPEN both ways: bd's silence is no evidence a wait ended, so the row stays on the board
    // and the next pass reconciles it.
    await seedHumanGateReport("g-1");
    await sweep();

    gateListMock.mockRejectedValue(new Error("bd exploded"));
    await seedReport();

    expect(await sweep()).toMatchObject({ settled: 0 });
    expect(escalationRows()[0]).toMatchObject({ status: "open" });
  });

  it("leaves an open gate wait alone while its gate is still waiting on somebody", async () => {
    await seedHumanGateReport("g-1");
    await sweep();
    await seedReport();

    expect(await sweep()).toMatchObject({ findings: 0, settled: 0 });
    expect(escalationRows()[0]).toMatchObject({ status: "open" });
  });

  it("settles nothing for escalations of other kinds, whatever the gates say", async () => {
    // Only a `needs-human` row hangs on a gate; a parked run's escalation is answered by the founder
    // and must never be retired by an unrelated gate resolving.
    seedParkedRun("r-2", "e-2", "agent exited 1");
    await seedReport(parkedRunFinding("r-2", "e-2", "parked 4h ago: agent exited 1"));
    await sweep();

    gateListMock.mockResolvedValue([]);
    await seedReport();

    expect(await sweep()).toMatchObject({ findings: 0, settled: 0 });
    expect(escalationRows()[0]).toMatchObject({ status: "open" });
    expect(gateListMock).toHaveBeenCalledTimes(0); // no gate wait open, so no gate read either
  });

  it("escalates on the report's word when the gate list can't be read", async () => {
    // Fails OPEN, like the PR and job re-checks: an unreadable board is no evidence a wait ended, and
    // a missed escalation strands the very human this finding exists to find.
    gateListMock.mockRejectedValue(new Error("bd exploded"));
    await seedHumanGateReport("g-1");

    expect(await sweep()).toMatchObject({ findings: 1, escalated: 1, held: 0 });
    expect(escalationRows()[0]).toMatchObject({ findingKey: "needs-human:g-1" });
  });

  it("raises a fresh escalation once a resolved one no longer covers the stall", async () => {
    // The open-only partial index is what allows this: a stall that recurs after the founder settled
    // it must be able to reach them again rather than being silenced by its own history.
    seedParkedRun("r-2", "e-2", "agent exited 1");
    await seedReport(parkedRunFinding("r-2", "e-2", "parked 4h ago: agent exited 1"));

    await sweep();
    t.db
      .update(schema.escalations)
      .set({ status: "resolved", resolution: "abandoned" })
      .where(eq(schema.escalations.findingKey, "parked-run:r-2"))
      .run();

    expect(await sweep()).toMatchObject({ escalated: 1 });
    expect(escalationRows().filter((r) => r.status === "open")).toHaveLength(1);
    expect(escalationRows()).toHaveLength(2);
  });
});

describe("a cancelled or timed-out pass", () => {
  it("hands the job's abort signal to the live PR re-read, so the gh child dies with the job", async () => {
    // Without this the `gh pr view` subprocess outlives the cancel for the whole CLI timeout.
    const controller = new AbortController();
    await seedStalePrReport();

    await sweep({ signal: controller.signal });

    expect(prActivityMock).toHaveBeenCalledWith(REPO, 42, controller.signal);
  });

  it("stops acting once aborted, rather than escalating on behalf of a cancelled job", async () => {
    seedParkedRun("r-2", "e-2", "agent exited 1");
    await seedReport(parkedRunFinding("r-2", "e-2", "parked 4h ago: agent exited 1"));

    await expect(sweep({ signal: AbortSignal.abort() })).rejects.toThrow();
    expect(escalationRows()).toEqual([]);
    expect(noteMock).not.toHaveBeenCalled();
  });

  it("does not turn an abort mid-PR-read into an escalation on the report's word", async () => {
    // The re-check fails OPEN for an unreadable PR — but an abort is the pass being stopped, not
    // evidence the PR is still idle, so it must propagate instead of raising a founder-facing row.
    const controller = new AbortController();
    controller.abort();
    prActivityMock.mockRejectedValue(new Error("aborted"));
    await seedStalePrReport();

    await expect(sweep({ signal: controller.signal })).rejects.toThrow();
    expect(escalationRows()).toEqual([]);
  });
});

describe("a transient read failure costs one finding, not the whole pass", () => {
  it("escalates on the report's word when the job re-read throws, and still acts on the rest", async () => {
    // The re-check is a local db read; a locked SQLite used to throw straight through the loop and
    // abandon every finding after it — losing resumes and escalations to one transient error.
    getJobMock.mockRejectedValue(new Error("database is locked"));
    seedParkedRun("r-1", "e-1", "usage-limit");
    seedJob("j-9", { status: "parked", attempts: 3, lastError: "failed 3×: tests failed" });
    await seedReport(
      {
        kind: "exhausted-job",
        key: "exhausted-job:j-9",
        reason: "execute-epic job parked",
        since: NOW - 4 * HOUR,
        ageMs: 4 * HOUR,
        jobId: "j-9",
        beadId: "e-9",
      },
      parkedRunFinding("r-1", "e-1", "parked 4h ago: usage-limit"),
    );

    expect(await sweep()).toMatchObject({ findings: 2, resumed: 1, escalated: 1, held: 0 });
    expect(escalationRows().map((r) => r.jobId)).toEqual(["j-9"]);
  });
});

describe("a mixed report", () => {
  it("resumes what is safe and escalates the rest in one pass", async () => {
    seedParkedRun("r-1", "e-1", "usage-limit");
    seedParkedRun("r-2", "e-2", "agent exited 1");
    await seedReport(
      parkedRunFinding("r-1", "e-1", "parked 4h ago: usage-limit"),
      parkedRunFinding("r-2", "e-2", "parked 4h ago: agent exited 1"),
    );

    expect(await sweep()).toMatchObject({ findings: 2, resumed: 1, escalated: 1, held: 0 });
    // The resume targets only the safe epic; the escalated one gets no job at all.
    expect(jobRows().map((j) => JSON.parse(j.payloadJson).epicBeadId)).toEqual(["e-1"]);
    expect(escalationRows().map((r) => r.epicBeadId)).toEqual(["e-2"]);
  });
});

describe("an idle pass", () => {
  it("does nothing at all when the sweep has never run for this project", async () => {
    // run-health ships off by default, so "no report" is the normal state, not an error.
    expect(await sweep()).toEqual({ findings: 0, resumed: 0, escalated: 0, held: 0, settled: 0 });
    expect(jobRows()).toEqual([]);
    expect(listMock).not.toHaveBeenCalled();
  });

  it("does nothing when the last sweep found nothing", async () => {
    await seedReport();
    expect(await sweep()).toMatchObject({ findings: 0 });
    expect(escalationRows()).toEqual([]);
  });

  it("holds a finding whose run has since moved on, rather than acting on a ghost", async () => {
    // The report names r-1, but no parked run by that id exists any more — it resumed, failed, or
    // finished between the sweep and now.
    await seedReport(parkedRunFinding("r-1", "e-1", "parked 4h ago: usage-limit"));

    expect(await sweep()).toMatchObject({ findings: 1, resumed: 0, escalated: 0, held: 1 });
    expect(jobRows()).toEqual([]);
    expect(escalationRows()).toEqual([]);
  });
});
