/**
 * The score-regression breaker's I/O end (anton-cekf / R4.3).
 *
 * The rules are pinned in autopilot-score-slide.test.ts. What is pinned HERE is the series the runs
 * are read into — one entry per target, newest attempt first, each carrying the score THAT attempt
 * earned — and the three ways that read can lie: a run that left no score (a gap, not a zero), one
 * epic's repeat attempts filling the window by themselves, and an unreviewed rerun inheriting what
 * an earlier attempt on the same target scored (which would judge a run on a review it never had,
 * and re-latch a disarm the operator had already overruled).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeTestDb, type TestDb } from "../db/testing";
import * as schema from "../db/schema";
import { activeDisarm, disarmAutopilot, reArmAutopilot } from "../autopilot-disarm";
import { listOpenEscalations, toEscalationView } from "../escalations";
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

/** A run on `epic` that settled `atMinutes` in, carrying the score its own review gate reported. */
async function run(input: {
  id: string;
  epic: string;
  atMinutes: number;
  status?: string;
  score?: number;
}): Promise<void> {
  const at = new Date(T0 + input.atMinutes * MINUTE);
  await t.db.insert(schema.runs).values({
    id: input.id,
    projectId: PROJECT,
    epicBeadId: input.epic,
    status: input.status ?? "done",
    reviewScore: input.score,
    startedAt: at,
    endedAt: at,
    updatedAt: at,
  });
}

/** Three delivered runs, oldest first, scoring below the default floor of 7. */
async function threeLowRuns(): Promise<void> {
  await run({ id: "r1", epic: "anton-a", atMinutes: 0, score: 6 });
  await run({ id: "r2", epic: "anton-b", atMinutes: 15, score: 5 });
  await run({ id: "r3", epic: "anton-c", atMinutes: 30, score: 4 });
}

beforeEach(() => {
  t = makeTestDb();
});
afterEach(() => t.close());

describe("checkScoreSlide", () => {
  it("latches the disarm with the series that triggered it", async () => {
    await project();
    await threeLowRuns();

    const outcome = await checkScoreSlide(t.db, clock, { projectId: PROJECT });

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
    await run({ id: "r1", epic: "anton-a", atMinutes: 0, score: 4 });
    await run({ id: "r2", epic: "anton-b", atMinutes: 15, score: 9 });
    await run({ id: "r3", epic: "anton-c", atMinutes: 30, score: 8 });

    const outcome = await checkScoreSlide(t.db, clock, { projectId: PROJECT });

    expect(outcome).toBeUndefined();
    expect(await activeDisarm(t.db, PROJECT)).toBeUndefined();
  });

  it("does not disarm on a run that left no score", async () => {
    await project();
    // The middle run never reached the review gate. Absence of evidence is not evidence.
    await run({ id: "r1", epic: "anton-a", atMinutes: 0, score: 6 });
    await run({ id: "r2", epic: "anton-b", atMinutes: 15 });
    await run({ id: "r3", epic: "anton-c", atMinutes: 30, score: 4 });

    expect(await checkScoreSlide(t.db, clock, { projectId: PROJECT })).toBeUndefined();
    expect(await activeDisarm(t.db, PROJECT)).toBeUndefined();
  });

  it("does not lend an earlier attempt's score to an unreviewed rerun of the same target", async () => {
    await project();
    await run({ id: "r1", epic: "anton-a", atMinutes: 0, score: 6 });
    await run({ id: "r2", epic: "anton-b", atMinutes: 15, score: 5 });
    await run({ id: "r3", epic: "anton-c", atMinutes: 30, score: 4 });
    // anton-c is re-run and settles without ever being reviewed. Its target still carries the 4 the
    // attempt before earned — but that review says nothing about THIS run, so the series has a gap.
    await run({ id: "r4", epic: "anton-c", atMinutes: 45, status: "failed" });

    expect(await checkScoreSlide(t.db, clock, { projectId: PROJECT })).toBeUndefined();
    expect(await activeDisarm(t.db, PROJECT)).toBeUndefined();
  });

  it("does not disarm before the window has that many finished runs", async () => {
    await project();
    await run({ id: "r1", epic: "anton-a", atMinutes: 0, score: 3 });
    await run({ id: "r2", epic: "anton-b", atMinutes: 15, score: 2 });

    expect(await checkScoreSlide(t.db, clock, { projectId: PROJECT })).toBeUndefined();
  });

  it("counts one score per target, however many attempts it took", async () => {
    await project();
    // Three run rows, one epic: a retry gets a fresh row, but the work being judged is one feature.
    // Counting each attempt would disarm the project off one bad review.
    await run({ id: "r1", epic: "anton-a", atMinutes: 0, status: "failed", score: 3 });
    await run({ id: "r2", epic: "anton-a", atMinutes: 15, status: "failed", score: 3 });
    await run({ id: "r3", epic: "anton-a", atMinutes: 30, score: 3 });

    expect(await checkScoreSlide(t.db, clock, { projectId: PROJECT })).toBeUndefined();
  });

  it("pages past one target's repeat attempts to reach the rest of the window", async () => {
    // Two heavily retried targets can fill any fixed read on their own — twenty rows, two entries.
    // Stopping there would report the series as short and let a third low-scoring delivery, sitting
    // one row further back, go unread on every pass.
    await project();
    await run({ id: "r-c", epic: "anton-c", atMinutes: 0, score: 4 });
    for (let i = 0; i < 10; i++) {
      await run({ id: `r-b${i}`, epic: "anton-b", atMinutes: 1 + i, status: "failed", score: 5 });
    }
    for (let i = 0; i < 10; i++) {
      await run({ id: `r-a${i}`, epic: "anton-a", atMinutes: 11 + i, status: "failed", score: 6 });
    }

    const outcome = await checkScoreSlide(t.db, clock, { projectId: PROJECT });

    expect(outcome?.latched).toBe(true);
    expect(outcome?.slide.runs.map((r) => r.targetBeadId)).toEqual([
      "anton-c",
      "anton-b",
      "anton-a",
    ]);
    expect((await activeDisarm(t.db, PROJECT))?.detail).toBe(
      "3 consecutive runs scored below 7/10 (4, 5, 6)",
    );
  });

  it("stops paging at the re-arm instead of walking the whole run history", async () => {
    // Every score this project has was already overruled. The read must reach the fence and stop —
    // paging on would cost the whole table, every ten minutes, to learn nothing.
    await project();
    await threeLowRuns();
    await checkScoreSlide(t.db, clock, { projectId: PROJECT });
    await reArmAutopilot(t.db, clock, { projectId: PROJECT, actor: "ops" });
    for (let i = 0; i < 60; i++) {
      await run({ id: `old-${i}`, epic: `anton-old-${i}`, atMinutes: -100 + i, score: 2 });
    }

    const selects = vi.spyOn(t.db, "select");
    expect(await checkScoreSlide(t.db, clock, { projectId: PROJECT })).toBeUndefined();
    const reads = selects.mock.calls.length;
    selects.mockRestore();

    expect(await activeDisarm(t.db, PROJECT)).toBeUndefined();
    // ONE page of runs, not four — plus the disarm, settings and re-arm lookups every pass makes.
    expect(reads).toBeLessThanOrEqual(5);
  });

  it("skips runs still in flight rather than reading them as gaps", async () => {
    await project();
    await threeLowRuns();
    await run({ id: "r4", epic: "anton-d", atMinutes: 45, status: "running" });

    expect((await checkScoreSlide(t.db, clock, { projectId: PROJECT }))?.latched).toBe(true);
  });

  it("is off when the operator zeroes the floor", async () => {
    await project({ autopilotScoreFloor: 0 });
    await threeLowRuns();

    expect(await checkScoreSlide(t.db, clock, { projectId: PROJECT })).toBeUndefined();
    expect(await activeDisarm(t.db, PROJECT)).toBeUndefined();
  });

  it("honours an operator-set floor and window", async () => {
    await project({ autopilotScoreFloor: 9, autopilotScoreWindow: 2 });
    await run({ id: "r1", epic: "anton-a", atMinutes: 0, score: 8 });
    await run({ id: "r2", epic: "anton-b", atMinutes: 15, score: 8 });

    const outcome = await checkScoreSlide(t.db, clock, { projectId: PROJECT });

    expect(outcome?.slide.runs).toHaveLength(2);
    expect((await activeDisarm(t.db, PROJECT))?.detail).toBe(
      "2 consecutive runs scored below 9/10 (8, 8)",
    );
  });

  it("repairs a half-written latch even with the floor zeroed", async () => {
    // The freeze landed and its strip row did not. Every breaker returns early once a latch exists,
    // so this pass is the only second chance the escalation write ever gets — and the latch outlives
    // the setting that raised it, so a disabled breaker must still finish the job.
    await project({ autopilotScoreFloor: 0 });
    await disarmAutopilot(t.db, clock, {
      projectId: PROJECT,
      reason: "score-regression",
      detail: "3 consecutive runs scored below 7/10 (6, 5, 4)",
      evidence: ["r1 · anton-a · 6/10"],
    });

    expect(await checkScoreSlide(t.db, clock, { projectId: PROJECT })).toBeUndefined();

    const open = (await listOpenEscalations(t.db, PROJECT)).map(toEscalationView);
    expect(open).toHaveLength(1);
    expect(open[0]?.kind).toBe("autopilot-disarm");
    expect((await activeDisarm(t.db, PROJECT))?.escalationId).toBe(open[0]?.id);
  });

  it("raises one escalation carrying the same series, and stamps it on the disarm", async () => {
    await project();
    await threeLowRuns();

    await checkScoreSlide(t.db, clock, { projectId: PROJECT });

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
    await threeLowRuns();
    expect((await checkScoreSlide(t.db, clock, { projectId: PROJECT }))?.latched).toBe(true);
    await reArmAutopilot(t.db, clock, { projectId: PROJECT, actor: "ops" });

    // Nothing new has been reviewed, so the same three low scores are still the whole series.
    // Re-latching here would revert the human decision within one picker cadence.
    expect(await checkScoreSlide(t.db, clock, { projectId: PROJECT })).toBeUndefined();
    expect(await activeDisarm(t.db, PROJECT)).toBeUndefined();
  });

  it("stays armed when the overruled targets are re-run without being re-scored", async () => {
    // The rerun settles AFTER the re-arm, so the floor lets its row in. Reading the target's old
    // score off the board would hand the breaker the very reviews the operator just overruled and
    // re-freeze the project on them — with nothing new reviewed at all.
    await project();
    await threeLowRuns();
    await checkScoreSlide(t.db, clock, { projectId: PROJECT });
    await reArmAutopilot(t.db, clock, { projectId: PROJECT, actor: "ops" });

    await run({ id: "r4", epic: "anton-a", atMinutes: 70, status: "failed" });
    await run({ id: "r5", epic: "anton-b", atMinutes: 85, status: "failed" });
    await run({ id: "r6", epic: "anton-c", atMinutes: 100, status: "failed" });

    expect(await checkScoreSlide(t.db, clock, { projectId: PROJECT })).toBeUndefined();
    expect(await activeDisarm(t.db, PROJECT)).toBeUndefined();
  });

  it("disarms again once NEW runs score below the floor after the re-arm", async () => {
    await project();
    await threeLowRuns();
    await checkScoreSlide(t.db, clock, { projectId: PROJECT });
    await reArmAutopilot(t.db, clock, { projectId: PROJECT, actor: "ops" });

    // Three fresh deliveries, all settled after the re-arm, all still under the floor.
    await run({ id: "r4", epic: "anton-d", atMinutes: 70, score: 6 });
    await run({ id: "r5", epic: "anton-e", atMinutes: 85, score: 5 });
    await run({ id: "r6", epic: "anton-f", atMinutes: 100, score: 4 });

    const again = await checkScoreSlide(t.db, clock, { projectId: PROJECT });
    expect(again?.latched).toBe(true);
    expect(again?.slide.runs.map((r) => r.id)).toEqual(["r4", "r5", "r6"]);
  });

  it("abstains while the project is already disarmed", async () => {
    await project();
    await threeLowRuns();
    await disarmAutopilot(t.db, clock, {
      projectId: PROJECT,
      reason: "consecutive-failures",
      detail: "already frozen",
    });

    expect(await checkScoreSlide(t.db, clock, { projectId: PROJECT })).toBeUndefined();
    // One latch, one thing to read, one thing to clear.
    expect((await activeDisarm(t.db, PROJECT))?.reason).toBe("consecutive-failures");
  });
});
