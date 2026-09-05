/**
 * The consecutive-failure breaker's I/O end (anton-rgso / R4.4).
 *
 * The arithmetic is pinned in autopilot-failure-streak.test.ts. What is pinned HERE is the reading
 * of the two facts a run row cannot answer about itself — was the job behind it cancelled by an
 * operator, was the work it carried abandoned — plus the latch it produces. Getting either wrong
 * turns an operator tidying up into a frozen project, or a run of give-ups into an idle week.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeTestDb, type TestDb } from "../db/testing";
import * as schema from "../db/schema";
import {
  activeDisarm,
  disarmAutopilot,
  disarmWithEscalation,
  reArmAutopilot,
} from "../autopilot-disarm";
import { listOpenEscalations, toEscalationView } from "../escalations";
import type { Bead } from "../beads/types";
import type { Clock } from "./queue";
import { repairLabel } from "../gardener/repair";
import { checkFailureStreak } from "./picker-failure-breaker";
import { insertProject } from "@/lib/testing/project";

const PROJECT = "p1";
const T0 = 1_800_000_000_000;
const MINUTE = 60_000;

let t: TestDb;
const clock: Clock = { now: () => T0 + 60 * MINUTE };

function project(settings: Record<string, unknown> = {}): void {
  insertProject(t.db, {
    id: PROJECT,
    slug: "p1",
    name: "P1",
    repoPath: "/repo",
    settingsJson: JSON.stringify(settings),
  });
}

/**
 * A run that started `startedMinutes` in and settled ten minutes later. `job` names the job behind
 * it — omitted for a row written before that column existed, which is what pins the legacy join.
 * `attemptMinutes` is when the attempt that settled it BEGAN: given only for a row a resume picked
 * back up, and omitted (⇒ null, falling back to `startedAt`) for the same legacy reason.
 */
async function run(input: {
  id: string;
  epic: string;
  status: string;
  startedMinutes: number;
  attemptMinutes?: number;
  error?: string;
  ticket?: string;
  job?: string;
}): Promise<void> {
  const startedAt = new Date(T0 + input.startedMinutes * MINUTE);
  const endedAt = new Date(T0 + ((input.attemptMinutes ?? input.startedMinutes) + 10) * MINUTE);
  await t.db.insert(schema.runs).values({
    id: input.id,
    projectId: PROJECT,
    epicBeadId: input.epic,
    ticketBeadId: input.ticket,
    jobId: input.job,
    status: input.status,
    error: input.error,
    startedAt,
    attemptStartedAt:
      input.attemptMinutes === undefined ? null : new Date(T0 + input.attemptMinutes * MINUTE),
    endedAt,
    updatedAt: endedAt,
  });
}

/**
 * A ticket's own `execute` session, settled `done` `atMinutes` in — the delivery evidence a run row
 * cannot carry, since a child commits while the run around it goes on to review and PR.
 */
async function deliveredSession(beadId: string, atMinutes: number): Promise<void> {
  await t.db.insert(schema.sessions).values({
    id: `s-${beadId}-${atMinutes}`,
    projectId: PROJECT,
    kind: "execute",
    beadId,
    status: "done",
    startedAt: new Date(T0 + atMinutes * MINUTE),
    endedAt: new Date(T0 + atMinutes * MINUTE),
  });
}

/**
 * A job an operator force-stopped `atMinutes` in — the cancel the breaker must subtract. Returns
 * the job id, which is what a run written with `job` is matched on.
 */
async function cancelledJob(epic: string, atMinutes: number): Promise<string> {
  const id = `job-${epic}-${atMinutes}`;
  await t.db.insert(schema.jobs).values({
    id,
    type: "execute-epic",
    projectId: PROJECT,
    payloadJson: JSON.stringify({ epicBeadId: epic }),
    status: "cancelled",
    runAt: new Date(T0),
    updatedAt: new Date(T0 + atMinutes * MINUTE),
  });
  return id;
}

function bead(id: string, labels: string[] = []): Bead {
  return { id, title: id, status: "closed", labels };
}

/** The bead as an auto-repair leaves it: the guard stamp, made `minutes` into the window. */
function repairedBead(id: string, minutes: number): Bead {
  return { id, title: id, status: "open", labels: [repairLabel(id, "ref-stale", T0 + minutes * MINUTE)] };
}

/** Three failing runs, ten minutes apart — a streak at the default threshold. */
async function threeFailures(): Promise<void> {
  await run({ id: "r1", epic: "anton-a", status: "failed", startedMinutes: 0, error: "boom" });
  await run({ id: "r2", epic: "anton-b", status: "failed", startedMinutes: 15, error: "boom" });
  await run({ id: "r3", epic: "anton-c", status: "failed", startedMinutes: 30, error: "boom" });
}

beforeEach(() => {
  t = makeTestDb();
});
afterEach(() => t.close());

describe("checkFailureStreak", () => {
  it("latches the disarm with the runs and the point they share", async () => {
    project();
    await threeFailures();

    const outcome = await checkFailureStreak(t.db, clock, { projectId: PROJECT, board: [] });
    expect(outcome?.latched).toBe(true);

    const disarm = await activeDisarm(t.db, PROJECT);
    expect(disarm?.reason).toBe("consecutive-failures");
    expect(disarm?.detail).toContain("3 runs in a row ended without delivering");
    expect(disarm?.detail).toContain("boom");
    expect(disarm?.evidence).toEqual([
      "r1 · anton-a · failed · boom",
      "r2 · anton-b · failed · boom",
      "r3 · anton-c · failed · boom",
    ]);
  });

  it("holds at N-1", async () => {
    project();
    await run({ id: "r1", epic: "anton-a", status: "failed", startedMinutes: 0 });
    await run({ id: "r2", epic: "anton-b", status: "parked", startedMinutes: 15 });

    expect(await checkFailureStreak(t.db, clock, { projectId: PROJECT, board: [] })).toBeUndefined();
    expect(await activeDisarm(t.db, PROJECT)).toBeUndefined();
  });

  it("does not count a parked run whose job was cancelled long after it last moved", async () => {
    // The case a timestamp window cannot see: the job parked (usage limit, awaiting the operator),
    // so the run stopped moving, and the operator stopped it hours later. Matched on the job id the
    // run carries, so the delay is irrelevant.
    project();
    await run({ id: "r1", epic: "anton-a", status: "failed", startedMinutes: 0, error: "boom" });
    await run({
      id: "r2",
      epic: "anton-b",
      status: "parked",
      startedMinutes: 15,
      error: "usage limit",
      job: "job-anton-b-600",
    });
    await run({ id: "r3", epic: "anton-c", status: "failed", startedMinutes: 30, error: "boom" });
    await cancelledJob("anton-b", 600);

    expect(await checkFailureStreak(t.db, clock, { projectId: PROJECT, board: [] })).toBeUndefined();
    expect(await activeDisarm(t.db, PROJECT)).toBeUndefined();
  });

  it("still counts a run when the cancel was of a DIFFERENT job on its epic", async () => {
    // A queued retry the operator stopped before it ever ran, cancelled inside the earlier run's
    // slack window. The id join refuses it; the timestamp window alone would have excused the
    // failure it never touched.
    project();
    await run({ id: "r1", epic: "anton-a", status: "failed", startedMinutes: 0, error: "boom" });
    await run({
      id: "r2",
      epic: "anton-b",
      status: "failed",
      startedMinutes: 15,
      error: "boom",
      job: "job-anton-b-1",
    });
    await run({ id: "r3", epic: "anton-c", status: "failed", startedMinutes: 30, error: "boom" });
    await cancelledJob("anton-b", 25);

    const outcome = await checkFailureStreak(t.db, clock, { projectId: PROJECT, board: [] });
    expect(outcome?.streak.runs.map((r) => r.id)).toEqual(["r1", "r2", "r3"]);
  });

  it("does not count a run whose job the operator cancelled", async () => {
    project();
    await threeFailures();
    // Rows from before `runs.job_id` existed, so the epic + the instant is all there is to join on.
    // The middle run's epic was force-stopped while that run was executing.
    await cancelledJob("anton-b", 20);

    expect(await checkFailureStreak(t.db, clock, { projectId: PROJECT, board: [] })).toBeUndefined();
    expect(await activeDisarm(t.db, PROJECT)).toBeUndefined();
  });

  it("still counts a run whose epic was cancelled at some OTHER time", async () => {
    project();
    await threeFailures();
    // A cancel of anton-b from long before that run existed — a different attempt entirely.
    await cancelledJob("anton-b", -600);

    expect(await checkFailureStreak(t.db, clock, { projectId: PROJECT, board: [] })).toBeDefined();
  });

  it("gives one cancel to the attempt it hit, not to the retry before it", async () => {
    // A cancel of the RETRY lands inside the previous attempt's slack window when the retry started
    // seconds after that attempt settled. Letting both claim it erases a genuine failure.
    project({ autopilotFailureStreak: 2 });
    await run({ id: "r1", epic: "anton-a", status: "failed", startedMinutes: 0, error: "boom" });
    await run({ id: "r2", epic: "anton-b", status: "failed", startedMinutes: 15, error: "boom" });
    await run({ id: "r3", epic: "anton-b", status: "failed", startedMinutes: 25.5, error: "boom" });
    await cancelledJob("anton-b", 25.7);

    const outcome = await checkFailureStreak(t.db, clock, { projectId: PROJECT, board: [] });
    expect(outcome?.streak.runs.map((r) => r.id)).toEqual(["r1", "r2"]);
  });

  it("gives one cancel to the retry that was running, not to the same job's earlier attempt", async () => {
    // The runner's automatic retry REUSES the job row and opens a fresh run, so one job id spans
    // both attempts. Cancelling the retry must not reach back and excuse the failure before it.
    project({ autopilotFailureStreak: 2 });
    const job = await cancelledJob("anton-b", 30);
    await run({ id: "r1", epic: "anton-a", status: "failed", startedMinutes: 0, error: "boom" });
    await run({ id: "r2", epic: "anton-b", status: "failed", startedMinutes: 15, error: "boom", job });
    await run({ id: "r3", epic: "anton-b", status: "failed", startedMinutes: 26, error: "boom", job });

    const outcome = await checkFailureStreak(t.db, clock, { projectId: PROJECT, board: [] });
    expect(outcome?.streak.runs.map((r) => r.id)).toEqual(["r1", "r2"]);
  });

  it("counts the failure whose QUEUED retry the operator cancelled", async () => {
    // The retry reuses the job row and opens its own run only once it starts, so a cancel during
    // the backoff has no next attempt to be bounded by. Handing it back to the attempt that failed
    // before it would excuse a genuine failure and keep the breaker from ever firing.
    project({ autopilotFailureStreak: 2 });
    const job = await cancelledJob("anton-b", 40);
    await run({ id: "r1", epic: "anton-a", status: "failed", startedMinutes: 0, error: "boom" });
    await run({
      id: "r2",
      epic: "anton-b",
      status: "failed",
      startedMinutes: 15,
      error: "boom",
      job,
    });

    const outcome = await checkFailureStreak(t.db, clock, { projectId: PROJECT, board: [] });
    expect(outcome?.streak.runs.map((r) => r.id)).toEqual(["r1", "r2"]);
  });

  it("counts a failure whose retry was cancelled inside the legacy slack window", async () => {
    // The same hole on the pre-`job_id` join: the retry backoff starts at seconds, so a cancel of
    // the queued retry lands well inside the slack an INTERRUPTING cancel needs — and the failure
    // that settled before it is not what the operator stopped.
    project({ autopilotFailureStreak: 2 });
    await run({ id: "r1", epic: "anton-a", status: "failed", startedMinutes: 0, error: "boom" });
    await run({ id: "r2", epic: "anton-b", status: "failed", startedMinutes: 15, error: "boom" });
    await cancelledJob("anton-b", 25.5);

    const outcome = await checkFailureStreak(t.db, clock, { projectId: PROJECT, board: [] });
    expect(outcome?.streak.runs.map((r) => r.id)).toEqual(["r1", "r2"]);
  });

  it("counts an abandoned run, whose job the abandon also cancelled", async () => {
    project();
    await threeFailures();
    await cancelledJob("anton-b", 20);

    const board = [bead("anton-b", ["abandoned"])];
    const outcome = await checkFailureStreak(t.db, clock, { projectId: PROJECT, board });
    expect(outcome?.streak.runs.map((r) => r.id)).toEqual(["r1", "r2", "r3"]);
    expect((await activeDisarm(t.db, PROJECT))?.evidence?.[1]).toBe(
      "r2 · anton-b · abandoned · boom",
    );
  });

  it("counts a run whose TICKET was abandoned under it", async () => {
    project();
    await threeFailures();
    await run({
      id: "r4",
      epic: "anton-d",
      ticket: "anton-d.1",
      status: "running",
      startedMinutes: 45,
    });

    const board = [bead("anton-d.1", ["abandoned"])];
    const outcome = await checkFailureStreak(t.db, clock, { projectId: PROJECT, board });
    expect(outcome?.streak.runs.map((r) => r.id)).toEqual(["r1", "r2", "r3", "r4"]);
  });

  it("pages past a run of cancels to the failure a fixed window would have hidden", async () => {
    // Cancels are skipped rather than treated as a reset, so a single fixed-size read can stop one
    // row short of a still-consecutive failure — and the project stays armed on a streak that has
    // already tripped.
    project();
    await run({ id: "r1", epic: "anton-a", status: "failed", startedMinutes: 0, error: "boom" });
    for (let i = 0; i < 18; i += 1) {
      const epic = `anton-x${i}`;
      const job = await cancelledJob(epic, 20 + i * 5);
      await run({
        id: `c${i}`,
        epic,
        status: "failed",
        startedMinutes: 15 + i * 5,
        error: "stopped",
        job,
      });
    }
    await run({ id: "r2", epic: "anton-b", status: "failed", startedMinutes: 200, error: "boom" });
    await run({ id: "r3", epic: "anton-c", status: "failed", startedMinutes: 215, error: "boom" });

    const outcome = await checkFailureStreak(t.db, clock, { projectId: PROJECT, board: [] });
    expect(outcome?.latched).toBe(true);
    expect(outcome?.streak.runs.map((r) => r.id)).toEqual(["r1", "r2", "r3"]);
  });

  it("keeps paging past more cancels than any row cap would read", async () => {
    // The same bug as above at a larger size: a cap on ROWS READ, rather than on the evidence, lets
    // a long enough run of cancels hide the streak's oldest member and leave the project armed.
    project();
    await run({ id: "r1", epic: "anton-a", status: "failed", startedMinutes: 0, error: "boom" });
    for (let i = 0; i < 210; i += 1) {
      const epic = `anton-x${i}`;
      const job = await cancelledJob(epic, 20 + i * 5);
      await run({
        id: `c${i}`,
        epic,
        status: "failed",
        startedMinutes: 15 + i * 5,
        error: "stopped",
        job,
      });
    }
    await run({ id: "r2", epic: "anton-b", status: "failed", startedMinutes: 1100, error: "boom" });
    await run({ id: "r3", epic: "anton-c", status: "failed", startedMinutes: 1115, error: "boom" });

    const outcome = await checkFailureStreak(t.db, clock, { projectId: PROJECT, board: [] });
    expect(outcome?.latched).toBe(true);
    expect(outcome?.streak.runs.map((r) => r.id)).toEqual(["r1", "r2", "r3"]);
  });

  it("resets on a delivered run", async () => {
    project();
    await threeFailures();
    await run({ id: "r4", epic: "anton-d", status: "done", startedMinutes: 45 });

    expect(await checkFailureStreak(t.db, clock, { projectId: PROJECT, board: [] })).toBeUndefined();
  });

  it("is off when the operator set the streak to 0", async () => {
    project({ autopilotFailureStreak: 0 });
    await threeFailures();

    expect(await checkFailureStreak(t.db, clock, { projectId: PROJECT, board: [] })).toBeUndefined();
  });

  it("settles a stranded strip row even with the breaker switched off", async () => {
    // The re-arm lifted the latch but its own settle never landed, and the operator then turned the
    // breaker off. Nothing else repairs that row — re-arming can only answer `not-disarmed`, and the
    // strip refuses to dismiss the kind — so gating the repair behind the config strands it in
    // "Needs you" for good.
    project({ autopilotFailureStreak: 0 });
    await disarmWithEscalation(t.db, clock, {
      projectId: PROJECT,
      reason: "consecutive-failures",
      detail: "3 runs in a row ended without delivering",
    });
    await t.db
      .update(schema.autopilotDisarms)
      .set({ rearmedAt: new Date(T0 + 30 * MINUTE), rearmedBy: "ops" });
    expect(await listOpenEscalations(t.db, PROJECT)).toHaveLength(1);

    expect(await checkFailureStreak(t.db, clock, { projectId: PROJECT, board: [] })).toBeUndefined();

    expect(await listOpenEscalations(t.db, PROJECT)).toHaveLength(0);
  });

  it("honours an operator's longer streak", async () => {
    project({ autopilotFailureStreak: 4 });
    await threeFailures();

    expect(await checkFailureStreak(t.db, clock, { projectId: PROJECT, board: [] })).toBeUndefined();
  });

  it("leaves an already-disarmed project alone — a latch is never re-decided", async () => {
    project();
    await threeFailures();
    await disarmAutopilot(t.db, clock, {
      projectId: PROJECT,
      reason: "score-regression",
      detail: "scores fell below the floor",
    });

    expect(await checkFailureStreak(t.db, clock, { projectId: PROJECT, board: [] })).toBeUndefined();
    expect((await activeDisarm(t.db, PROJECT))?.reason).toBe("score-regression");
  });

  it("raises one escalation carrying the same evidence, and stamps it on the disarm", async () => {
    project();
    await threeFailures();

    const outcome = await checkFailureStreak(t.db, clock, { projectId: PROJECT, board: [] });

    const open = (await listOpenEscalations(t.db, PROJECT)).map(toEscalationView);
    expect(open).toHaveLength(1);
    expect(open[0]?.kind).toBe("autopilot-disarm");
    expect(open[0]?.reason).toContain("3 runs in a row ended without delivering");
    expect(open[0]?.evidence).toEqual([
      "r1 · anton-a · failed · boom",
      "r2 · anton-b · failed · boom",
      "r3 · anton-c · failed · boom",
    ]);
    // The strip row and the lane header are two views of ONE decision, joined by this id.
    expect((await activeDisarm(t.db, PROJECT))?.escalationId).toBe(open[0]?.id);
    expect(outcome?.disarmId).toBeDefined();
  });

  it("stays armed after a re-arm — the runs it read were the ones the operator overruled", async () => {
    project();
    await threeFailures();
    expect((await checkFailureStreak(t.db, clock, { projectId: PROJECT, board: [] }))?.latched).toBe(
      true,
    );
    await reArmAutopilot(t.db, clock, { projectId: PROJECT, actor: "ops" });

    // The very next pass: nothing new has finished, so the same three runs are still the most
    // recent ones. Re-latching here would revert the human decision within one picker cadence.
    expect(await checkFailureStreak(t.db, clock, { projectId: PROJECT, board: [] })).toBeUndefined();
    expect(await activeDisarm(t.db, PROJECT)).toBeUndefined();
  });

  it("disarms again once NEW runs fail after the re-arm", async () => {
    project();
    await threeFailures();
    await checkFailureStreak(t.db, clock, { projectId: PROJECT, board: [] });
    await reArmAutopilot(t.db, clock, { projectId: PROJECT, actor: "ops" });

    // Three fresh failures, all settled after the re-arm — the toolchain was not fixed after all.
    await run({ id: "r4", epic: "anton-d", status: "failed", startedMinutes: 60, error: "boom" });
    await run({ id: "r5", epic: "anton-e", status: "failed", startedMinutes: 75, error: "boom" });
    await run({ id: "r6", epic: "anton-f", status: "failed", startedMinutes: 90, error: "boom" });

    const again = await checkFailureStreak(t.db, clock, { projectId: PROJECT, board: [] });
    expect(again?.latched).toBe(true);
    expect(again?.streak.runs.map((r) => r.id)).toEqual(["r4", "r5", "r6"]);
  });

  /**
   * The R5.8 half of the loop guard, end to end over real run rows: a run that failed AFTER anton
   * repaired its bead is two failures, not one, so the breaker reaches the operator's threshold in
   * fewer runs than a streak of honest parks would take.
   */
  describe("after an auto-repair", () => {
    /** The block, then the failure that followed the repair — two runs on one bead. */
    async function blockThenFailAgain(): Promise<void> {
      await run({ id: "r1", epic: "anton-a", status: "failed", startedMinutes: 0, error: "blocked: ref-stale" });
      await run({ id: "r2", epic: "anton-a", status: "failed", startedMinutes: 15, error: "blocked: ref-stale" });
    }

    it("trips the breaker sooner than the same two failures unrepaired", async () => {
      project();
      await blockThenFailAgain();

      // Two failures at the default threshold of 3: not yet a broken environment.
      expect(
        await checkFailureStreak(t.db, clock, { projectId: PROJECT, board: [bead("anton-a")] }),
      ).toBeUndefined();

      // The same two runs, with anton's repair stamped between them.
      const outcome = await checkFailureStreak(t.db, clock, {
        projectId: PROJECT,
        board: [repairedBead("anton-a", 12)],
      });
      expect(outcome?.latched).toBe(true);
      expect(outcome?.streak.weight).toBe(3);
      expect(outcome?.streak.runs.map((r) => r.id)).toEqual(["r1", "r2"]);
    });

    it("prices a RESUMED attempt's failure against the repair that parked it", async () => {
      project();
      // What a `dep-missing` repair leaves behind: it parks the run behind the edge it drew, and
      // the blocker-completion resume reuses that same row. The row started before the repair; the
      // attempt that failed began after it, and that is the one being weighed.
      await run({
        id: "r1",
        epic: "anton-a",
        status: "failed",
        startedMinutes: 0,
        attemptMinutes: 20,
        error: "blocked: dep-missing",
      });
      await run({ id: "r2", epic: "anton-b", status: "failed", startedMinutes: 35, error: "boom" });

      const outcome = await checkFailureStreak(t.db, clock, {
        projectId: PROJECT,
        board: [repairedBead("anton-a", 12), bead("anton-b")],
      });
      expect(outcome?.latched).toBe(true);
      expect(outcome?.streak.weight).toBe(3);
    });

    it("does not count the block that provoked the repair double", async () => {
      project();
      await blockThenFailAgain();

      // Repaired AFTER both runs — nothing in this streak followed it, so nothing weighs double.
      expect(
        await checkFailureStreak(t.db, clock, {
          projectId: PROJECT,
          board: [repairedBead("anton-a", 90)],
        }),
      ).toBeUndefined();
    });

    it("prices a repair made on the TICKET a grouped run stopped inside", async () => {
      project();
      await run({ id: "r1", epic: "anton-epic", status: "failed", startedMinutes: 0, error: "boom" });
      await run({
        id: "r2",
        epic: "anton-epic",
        ticket: "anton-t1",
        status: "failed",
        startedMinutes: 15,
        error: "boom",
      });

      const outcome = await checkFailureStreak(t.db, clock, {
        projectId: PROJECT,
        board: [bead("anton-epic"), repairedBead("anton-t1", 12)],
      });
      expect(outcome?.latched).toBe(true);
      expect(outcome?.streak.weight).toBe(3);
    });

    it("stops weighing the repair once the bead has DELIVERED", async () => {
      project();
      // The block, the repair at minute 12, the delivery that proved it — then the ticket is
      // reopened for rework (rework-modes.ts) and fails again. The rework failure is a new story:
      // the streak behind it ended when the work landed.
      await run({ id: "r1", epic: "anton-a", status: "failed", startedMinutes: 0, error: "blocked: ref-stale" });
      await run({ id: "r2", epic: "anton-a", status: "done", startedMinutes: 15 });
      await run({ id: "r3", epic: "anton-a", status: "failed", startedMinutes: 30, error: "boom" });
      await run({ id: "r4", epic: "anton-b", status: "failed", startedMinutes: 45, error: "boom" });

      expect(
        await checkFailureStreak(t.db, clock, {
          projectId: PROJECT,
          board: [repairedBead("anton-a", 12), bead("anton-b")],
        }),
      ).toBeUndefined();

      // The same runs with the repair stamped AFTER the delivery: that one is still unanswered.
      const outcome = await checkFailureStreak(t.db, clock, {
        projectId: PROJECT,
        board: [repairedBead("anton-a", 27), bead("anton-b")],
      });
      expect(outcome?.latched).toBe(true);
      expect(outcome?.streak.weight).toBe(3);
      expect(outcome?.streak.runs.map((r) => r.id)).toEqual(["r3", "r4"]);
    });

    it("spends the repair on a delivery the failing run itself made", async () => {
      project();
      // The retry did deliver the repaired ticket — its `execute` session settled `done` at minute
      // 20, inside a run that started at 15 and settled at 25 — and the run failed afterwards in a
      // review or PR step. Ordered against the run's START that delivery is invisible and the two
      // runs weigh 3; ordered against its SETTLEMENT the repair is spent and they weigh 2.
      await run({ id: "r1", epic: "anton-a", status: "failed", startedMinutes: 0, error: "blocked: ref-stale" });
      await run({ id: "r2", epic: "anton-a", status: "failed", startedMinutes: 15, error: "review failed" });
      await deliveredSession("anton-a", 20);

      expect(
        await checkFailureStreak(t.db, clock, {
          projectId: PROJECT,
          board: [repairedBead("anton-a", 12)],
        }),
      ).toBeUndefined();
    });

    it("ignores a delivery from after the failing run settled", async () => {
      project();
      // The same two runs, with the delivery landing at minute 40 — well past r2's settlement at 25,
      // so it belongs to some later attempt and answers nothing about this streak.
      await run({ id: "r1", epic: "anton-a", status: "failed", startedMinutes: 0, error: "blocked: ref-stale" });
      await run({ id: "r2", epic: "anton-a", status: "failed", startedMinutes: 15, error: "review failed" });
      await deliveredSession("anton-a", 40);

      const outcome = await checkFailureStreak(t.db, clock, {
        projectId: PROJECT,
        board: [repairedBead("anton-a", 12)],
      });
      expect(outcome?.latched).toBe(true);
      expect(outcome?.streak.weight).toBe(3);
    });

    it("leaves a board with no repairs weighing every failure once", async () => {
      project();
      await blockThenFailAgain();
      expect(
        await checkFailureStreak(t.db, clock, {
          projectId: PROJECT,
          board: [bead("anton-a"), repairedBead("anton-unrelated", 12)],
        }),
      ).toBeUndefined();
    });
  });

  it("counts a failure double under the caller's weigher", async () => {
    project();
    await run({ id: "r1", epic: "anton-a", status: "failed", startedMinutes: 0, error: "boom" });
    await run({ id: "r2", epic: "anton-b", status: "failed", startedMinutes: 15, error: "boom" });

    const plain = await checkFailureStreak(t.db, clock, { projectId: PROJECT, board: [] });
    expect(plain).toBeUndefined();

    const weighted = await checkFailureStreak(t.db, clock, {
      projectId: PROJECT,
      board: [],
      weigh: (r) => (r.epicBeadId === "anton-b" ? 2 : 1),
    });
    expect(weighted?.streak.weight).toBe(3);
    expect(weighted?.latched).toBe(true);
  });
});
