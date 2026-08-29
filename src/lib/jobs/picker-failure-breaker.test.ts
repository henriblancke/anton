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
import { activeDisarm, disarmAutopilot, reArmAutopilot } from "../autopilot-disarm";
import { listOpenEscalations, toEscalationView } from "../escalations";
import type { Bead } from "../beads/types";
import type { Clock } from "./queue";
import { checkFailureStreak } from "./picker-failure-breaker";

const PROJECT = "p1";
const T0 = 1_800_000_000_000;
const MINUTE = 60_000;

let t: TestDb;
const clock: Clock = { now: () => T0 + 60 * MINUTE };

async function project(settings: Record<string, unknown> = {}): Promise<void> {
  await t.db.insert(schema.projects).values({
    id: PROJECT,
    slug: "p1",
    name: "P1",
    repoPath: "/repo",
    settingsJson: JSON.stringify(settings),
  });
}

/** A run that started `startedMinutes` in and settled ten minutes later. */
async function run(input: {
  id: string;
  epic: string;
  status: string;
  startedMinutes: number;
  error?: string;
  ticket?: string;
}): Promise<void> {
  const startedAt = new Date(T0 + input.startedMinutes * MINUTE);
  const endedAt = new Date(T0 + (input.startedMinutes + 10) * MINUTE);
  await t.db.insert(schema.runs).values({
    id: input.id,
    projectId: PROJECT,
    epicBeadId: input.epic,
    ticketBeadId: input.ticket,
    status: input.status,
    error: input.error,
    startedAt,
    endedAt,
    updatedAt: endedAt,
  });
}

/** A job an operator force-stopped `atMinutes` in — the cancel the breaker must subtract. */
async function cancelledJob(epic: string, atMinutes: number): Promise<void> {
  await t.db.insert(schema.jobs).values({
    id: `job-${epic}-${atMinutes}`,
    type: "execute-epic",
    projectId: PROJECT,
    payloadJson: JSON.stringify({ epicBeadId: epic }),
    status: "cancelled",
    runAt: new Date(T0),
    updatedAt: new Date(T0 + atMinutes * MINUTE),
  });
}

function bead(id: string, labels: string[] = []): Bead {
  return { id, title: id, status: "closed", labels };
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
    await project();
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
    await project();
    await run({ id: "r1", epic: "anton-a", status: "failed", startedMinutes: 0 });
    await run({ id: "r2", epic: "anton-b", status: "parked", startedMinutes: 15 });

    expect(await checkFailureStreak(t.db, clock, { projectId: PROJECT, board: [] })).toBeUndefined();
    expect(await activeDisarm(t.db, PROJECT)).toBeUndefined();
  });

  it("does not count a run whose job the operator cancelled", async () => {
    await project();
    await threeFailures();
    // The middle run's epic was force-stopped while that run was executing.
    await cancelledJob("anton-b", 20);

    expect(await checkFailureStreak(t.db, clock, { projectId: PROJECT, board: [] })).toBeUndefined();
    expect(await activeDisarm(t.db, PROJECT)).toBeUndefined();
  });

  it("still counts a run whose epic was cancelled at some OTHER time", async () => {
    await project();
    await threeFailures();
    // A cancel of anton-b from long before that run existed — a different attempt entirely.
    await cancelledJob("anton-b", -600);

    expect(await checkFailureStreak(t.db, clock, { projectId: PROJECT, board: [] })).toBeDefined();
  });

  it("counts an abandoned run, whose job the abandon also cancelled", async () => {
    await project();
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
    await project();
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

  it("resets on a delivered run", async () => {
    await project();
    await threeFailures();
    await run({ id: "r4", epic: "anton-d", status: "done", startedMinutes: 45 });

    expect(await checkFailureStreak(t.db, clock, { projectId: PROJECT, board: [] })).toBeUndefined();
  });

  it("is off when the operator set the streak to 0", async () => {
    await project({ autopilotFailureStreak: 0 });
    await threeFailures();

    expect(await checkFailureStreak(t.db, clock, { projectId: PROJECT, board: [] })).toBeUndefined();
  });

  it("honours an operator's longer streak", async () => {
    await project({ autopilotFailureStreak: 4 });
    await threeFailures();

    expect(await checkFailureStreak(t.db, clock, { projectId: PROJECT, board: [] })).toBeUndefined();
  });

  it("leaves an already-disarmed project alone — a latch is never re-decided", async () => {
    await project();
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
    await project();
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
    await project();
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
    await project();
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

  it("counts a failure double under the caller's weigher", async () => {
    await project();
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
