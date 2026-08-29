/**
 * The score-regression breaker's I/O end (anton-cekf / R4.3).
 *
 * The rules are pinned in autopilot-score-slide.test.ts. What is pinned HERE is the JOIN the series
 * is built from — a run row for the sequence, the target's `review-score:<n>` label for the number —
 * and the two ways that join can lie: a target the board carries no score for (a gap, not a zero),
 * and one epic's repeat attempts, whose single label would otherwise fill the window by itself.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeTestDb, type TestDb } from "../db/testing";
import * as schema from "../db/schema";
import { activeDisarm, disarmAutopilot, reArmAutopilot } from "../autopilot-disarm";
import { listOpenEscalations, toEscalationView } from "../escalations";
import type { Bead } from "../beads/types";
import type { Clock } from "./queue";
import { checkScoreSlide } from "./picker-score-breaker";

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

/** A run on `epic` that settled `atMinutes` in. */
async function run(input: {
  id: string;
  epic: string;
  atMinutes: number;
  status?: string;
}): Promise<void> {
  const at = new Date(T0 + input.atMinutes * MINUTE);
  await t.db.insert(schema.runs).values({
    id: input.id,
    projectId: PROJECT,
    epicBeadId: input.epic,
    status: input.status ?? "done",
    startedAt: at,
    endedAt: at,
    updatedAt: at,
  });
}

/** A run target carrying (or not) the score label review-score.ts writes. */
function target(id: string, score?: number): Bead {
  return {
    id,
    title: id,
    status: "closed",
    labels: score === undefined ? [] : [`review-score:${score}`],
  };
}

/** Three delivered runs, oldest first, scoring below the default floor of 7. */
async function threeLowRuns(): Promise<Bead[]> {
  await run({ id: "r1", epic: "anton-a", atMinutes: 0 });
  await run({ id: "r2", epic: "anton-b", atMinutes: 15 });
  await run({ id: "r3", epic: "anton-c", atMinutes: 30 });
  return [target("anton-a", 6), target("anton-b", 5), target("anton-c", 4)];
}

beforeEach(() => {
  t = makeTestDb();
});
afterEach(() => t.close());

describe("checkScoreSlide", () => {
  it("latches the disarm with the series that triggered it", async () => {
    await project();
    const board = await threeLowRuns();

    const outcome = await checkScoreSlide(t.db, clock, { projectId: PROJECT, board });

    expect(outcome?.latched).toBe(true);
    const disarm = await activeDisarm(t.db, PROJECT);
    expect(disarm?.reason).toBe("score-regression");
    expect(disarm?.detail).toBe("3 consecutive runs scored below 7/10 (6, 5, 4)");
    expect(disarm?.evidence).toEqual([
      "r1 · anton-a · 6/10",
      "r2 · anton-b · 5/10",
      "r3 · anton-c · 4/10",
    ]);
  });

  it("does nothing while the runs are scoring at or above the floor", async () => {
    await project();
    await run({ id: "r1", epic: "anton-a", atMinutes: 0 });
    await run({ id: "r2", epic: "anton-b", atMinutes: 15 });
    await run({ id: "r3", epic: "anton-c", atMinutes: 30 });

    const outcome = await checkScoreSlide(t.db, clock, {
      projectId: PROJECT,
      board: [target("anton-a", 4), target("anton-b", 9), target("anton-c", 8)],
    });

    expect(outcome).toBeUndefined();
    expect(await activeDisarm(t.db, PROJECT)).toBeUndefined();
  });

  it("does not disarm on a run the board carries no score for", async () => {
    await project();
    const board = await threeLowRuns();
    // The middle run never reached the review gate. Absence of evidence is not evidence.
    const withGap = board.map((b) => (b.id === "anton-b" ? target("anton-b") : b));

    expect(await checkScoreSlide(t.db, clock, { projectId: PROJECT, board: withGap })).toBeUndefined();
    expect(await activeDisarm(t.db, PROJECT)).toBeUndefined();
  });

  it("does not disarm before the window has that many finished runs", async () => {
    await project();
    await run({ id: "r1", epic: "anton-a", atMinutes: 0 });
    await run({ id: "r2", epic: "anton-b", atMinutes: 15 });

    const board = [target("anton-a", 3), target("anton-b", 2)];
    expect(await checkScoreSlide(t.db, clock, { projectId: PROJECT, board })).toBeUndefined();
  });

  it("counts one score per target, however many attempts it took", async () => {
    await project();
    // Three run rows, one epic: a retry gets a fresh row, but the label is the target's single
    // latest score. Counting it three times would disarm the project off one bad review.
    await run({ id: "r1", epic: "anton-a", atMinutes: 0, status: "failed" });
    await run({ id: "r2", epic: "anton-a", atMinutes: 15, status: "failed" });
    await run({ id: "r3", epic: "anton-a", atMinutes: 30 });

    expect(
      await checkScoreSlide(t.db, clock, { projectId: PROJECT, board: [target("anton-a", 3)] }),
    ).toBeUndefined();
  });

  it("skips runs still in flight rather than reading them as gaps", async () => {
    await project();
    const board = await threeLowRuns();
    await run({ id: "r4", epic: "anton-d", atMinutes: 45, status: "running" });

    expect((await checkScoreSlide(t.db, clock, { projectId: PROJECT, board }))?.latched).toBe(true);
  });

  it("is off when the operator zeroes the floor", async () => {
    await project({ autopilotScoreFloor: 0 });
    const board = await threeLowRuns();

    expect(await checkScoreSlide(t.db, clock, { projectId: PROJECT, board })).toBeUndefined();
    expect(await activeDisarm(t.db, PROJECT)).toBeUndefined();
  });

  it("honours an operator-set floor and window", async () => {
    await project({ autopilotScoreFloor: 9, autopilotScoreWindow: 2 });
    await run({ id: "r1", epic: "anton-a", atMinutes: 0 });
    await run({ id: "r2", epic: "anton-b", atMinutes: 15 });

    const outcome = await checkScoreSlide(t.db, clock, {
      projectId: PROJECT,
      board: [target("anton-a", 8), target("anton-b", 8)],
    });

    expect(outcome?.slide.runs).toHaveLength(2);
    expect((await activeDisarm(t.db, PROJECT))?.detail).toBe(
      "2 consecutive runs scored below 9/10 (8, 8)",
    );
  });

  it("raises one escalation carrying the same series, and stamps it on the disarm", async () => {
    await project();
    const board = await threeLowRuns();

    await checkScoreSlide(t.db, clock, { projectId: PROJECT, board });

    const open = (await listOpenEscalations(t.db, PROJECT)).map(toEscalationView);
    expect(open).toHaveLength(1);
    expect(open[0]?.kind).toBe("autopilot-disarm");
    expect(open[0]?.reason).toBe("3 consecutive runs scored below 7/10 (6, 5, 4)");
    expect(open[0]?.evidence).toEqual([
      "r1 · anton-a · 6/10",
      "r2 · anton-b · 5/10",
      "r3 · anton-c · 4/10",
    ]);
    expect((await activeDisarm(t.db, PROJECT))?.escalationId).toBe(open[0]?.id);
  });

  it("stays armed after a re-arm — those scores are the ones the operator overruled", async () => {
    await project();
    const board = await threeLowRuns();
    expect((await checkScoreSlide(t.db, clock, { projectId: PROJECT, board }))?.latched).toBe(true);
    await reArmAutopilot(t.db, clock, { projectId: PROJECT, actor: "ops" });

    // Nothing new has been reviewed, so the same three low scores are still the whole series.
    // Re-latching here would revert the human decision within one picker cadence.
    expect(await checkScoreSlide(t.db, clock, { projectId: PROJECT, board })).toBeUndefined();
    expect(await activeDisarm(t.db, PROJECT)).toBeUndefined();
  });

  it("disarms again once NEW runs score below the floor after the re-arm", async () => {
    await project();
    const board = await threeLowRuns();
    await checkScoreSlide(t.db, clock, { projectId: PROJECT, board });
    await reArmAutopilot(t.db, clock, { projectId: PROJECT, actor: "ops" });

    // Three fresh deliveries, all settled after the re-arm, all still under the floor.
    await run({ id: "r4", epic: "anton-d", atMinutes: 70 });
    await run({ id: "r5", epic: "anton-e", atMinutes: 85 });
    await run({ id: "r6", epic: "anton-f", atMinutes: 100 });
    const next = [...board, target("anton-d", 6), target("anton-e", 5), target("anton-f", 4)];

    const again = await checkScoreSlide(t.db, clock, { projectId: PROJECT, board: next });
    expect(again?.latched).toBe(true);
    expect(again?.slide.runs.map((r) => r.id)).toEqual(["r4", "r5", "r6"]);
  });

  it("abstains while the project is already disarmed", async () => {
    await project();
    const board = await threeLowRuns();
    await disarmAutopilot(t.db, clock, {
      projectId: PROJECT,
      reason: "consecutive-failures",
      detail: "already frozen",
    });

    expect(await checkScoreSlide(t.db, clock, { projectId: PROJECT, board })).toBeUndefined();
    // One latch, one thing to read, one thing to clear.
    expect((await activeDisarm(t.db, PROJECT))?.reason).toBe("consecutive-failures");
  });
});
