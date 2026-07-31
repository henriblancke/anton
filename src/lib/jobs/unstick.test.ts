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
import { LABELS, type Bead } from "../beads/bd";
import { saveRunHealthReport, type RunHealthFinding } from "../run-health";
import type { Clock } from "./queue";

const listMock = vi.fn<(cwd: string, extra?: string[]) => Promise<Bead[]>>();
const noteMock = vi.fn<(cwd: string, id: string, text: string) => Promise<void>>();
const syncMock = vi.fn<(cwd: string) => Promise<void>>();
const pullMock = vi.fn<(cwd: string) => Promise<void>>();

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
    },
  };
});

const { unstickPass } = await import("./unstick");

const NOW = 1_700_000_000_000;
const HOUR = 3_600_000;
const REPO = "/tmp/p1";
const clock: Clock = { now: () => NOW };

function secDate(ms: number): Date {
  return new Date(Math.floor(ms / 1000) * 1000);
}

let t: TestDb;

beforeEach(() => {
  t = makeTestDb();
  t.db
    .insert(schema.projects)
    .values({ id: "p1", slug: "p1", name: "p1", repoPath: REPO })
    .run();
  listMock.mockResolvedValue([]);
  noteMock.mockResolvedValue(undefined);
  syncMock.mockResolvedValue(undefined);
  pullMock.mockResolvedValue(undefined);
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

const sweep = () => unstickPass({ db: t.db, clock }, { projectId: "p1", repoPath: REPO });

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

describe("non-resumable parks produce exactly one escalation and no enqueue", () => {
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
    expect(await sweep()).toEqual({ findings: 0, resumed: 0, escalated: 0, held: 0 });
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
