/**
 * The disarm latch and the re-arm that lifts it (anton-5c8h). Two properties carry the feature:
 *
 *   • the latch survives passes — a disarm that a detector could re-derive away would let the next
 *     pass start the work the quality signal just stopped;
 *   • the re-arm has an AUTHOR — lifting a frozen policy is the most consequential click on the
 *     board, and "who decided the scores were fine again" is the question asked afterwards.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeTestDb, type TestDb } from "@/lib/db/testing";
import { schema } from "@/lib/db";
import {
  activeDisarm,
  disarmAutopilot,
  listDisarms,
  reArmAutopilot,
} from "@/lib/autopilot-disarm";
import type { Clock } from "@/lib/jobs/queue";

const PROJECT = "p-brake";
const OTHER = "p-other";
const T0 = 1_800_000_000_000;

let test: TestDb;
let ticks: number;
const clock: Clock = { now: () => T0 + ticks };

beforeEach(async () => {
  ticks = 0;
  test = makeTestDb();
  for (const id of [PROJECT, OTHER]) {
    await test.db
      .insert(schema.projects)
      .values({ id, slug: id, name: id, repoPath: `/tmp/${id}` });
  }
});

afterEach(() => test.close());

function scoreRegression(projectId = PROJECT) {
  return disarmAutopilot(test.db, clock, {
    projectId,
    reason: "score-regression" as const,
    detail: "The rolling review score fell below the floor of 7.",
    evidence: ["anton-abc1 · 8.5", "anton-def2 · 5.5"],
    escalationId: "esc-1",
  });
}

describe("disarmAutopilot", () => {
  it("latches the project, carrying the detector's reason and evidence", async () => {
    const { created } = await scoreRegression();
    expect(created).toBe(true);

    const view = await activeDisarm(test.db, PROJECT);
    expect(view).toEqual({
      kind: "disarm",
      reason: "score-regression",
      detail: "The rolling review score fell below the floor of 7.",
      evidence: ["anton-abc1 · 8.5", "anton-def2 · 5.5"],
      escalationId: "esc-1",
      since: Math.floor(T0 / 1000),
    });
  });

  it("is idempotent while latched — a second detector does not stack a second freeze", async () => {
    await scoreRegression();
    ticks = 60_000;
    const second = await disarmAutopilot(test.db, clock, {
      projectId: PROJECT,
      reason: "consecutive-failures",
      detail: "3 runs in a row ended parked.",
    });

    // The operator has ONE thing to read and ONE thing to clear, not a queue of freezes.
    expect(second.created).toBe(false);
    expect((await activeDisarm(test.db, PROJECT))?.reason).toBe("score-regression");
    expect(await listDisarms(test.db, PROJECT)).toHaveLength(1);
  });

  it("is per-project — one project's brake never stops another's", async () => {
    await scoreRegression();
    expect(await activeDisarm(test.db, OTHER)).toBeUndefined();
  });
});

describe("reArmAutopilot", () => {
  it("clears the breaker and records who did it", async () => {
    await scoreRegression();
    ticks = 3_600_000;

    const result = await reArmAutopilot(test.db, clock, {
      projectId: PROJECT,
      actor: "Henri Blancke",
    });

    expect(result).toEqual({
      ok: true,
      reason: "score-regression",
      actor: "Henri Blancke",
      at: Math.floor((T0 + 3_600_000) / 1000),
    });
    expect(await activeDisarm(test.db, PROJECT)).toBeUndefined();

    // The record outlives the freeze: who lifted it, and when, are still on the row.
    const [row] = await listDisarms(test.db, PROJECT);
    expect(row!.rearmedBy).toBe("Henri Blancke");
    expect(row!.rearmedAt).not.toBeNull();
  });

  it("refuses a second re-arm rather than overwriting the author of the first", async () => {
    await scoreRegression();
    await reArmAutopilot(test.db, clock, { projectId: PROJECT, actor: "Henri Blancke" });

    const second = await reArmAutopilot(test.db, clock, { projectId: PROJECT, actor: "somebody" });

    expect(second).toEqual({ ok: false, failure: "not-disarmed" });
    const [row] = await listDisarms(test.db, PROJECT);
    expect(row!.rearmedBy).toBe("Henri Blancke");
  });

  it("refuses when the autopilot was never disarmed", async () => {
    expect(await reArmAutopilot(test.db, clock, { projectId: PROJECT, actor: "Henri" })).toEqual({
      ok: false,
      failure: "not-disarmed",
    });
  });

  it("lets a later disarm latch again, and keeps both in the history", async () => {
    // A re-arm is not a promise the signal won't trip again — it is one decision, on one freeze.
    await scoreRegression();
    await reArmAutopilot(test.db, clock, { projectId: PROJECT, actor: "Henri Blancke" });
    ticks = 7_200_000;

    const again = await disarmAutopilot(test.db, clock, {
      projectId: PROJECT,
      reason: "consecutive-failures",
      detail: "3 runs in a row ended parked.",
      evidence: ["r-1 parked", "r-2 failed", "r-3 parked"],
    });

    expect(again.created).toBe(true);
    expect((await activeDisarm(test.db, PROJECT))?.reason).toBe("consecutive-failures");
    expect(await listDisarms(test.db, PROJECT)).toHaveLength(2);
  });
});

describe("evidence blob", () => {
  it("degrades to a disarm with no case rather than to no disarm", async () => {
    // Losing the latch to a JSON error would start the work the detector stopped — the safety
    // property outranks the prose attached to it.
    await scoreRegression();
    test.sqlite.prepare("UPDATE autopilot_disarms SET evidence_json = ?").run("{not json");

    const view = await activeDisarm(test.db, PROJECT);
    expect(view?.reason).toBe("score-regression");
    expect(view?.evidence).toEqual([]);
  });
});
