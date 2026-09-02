/**
 * The unattended-start log (anton-vfvg). What these pin is what the decision log promises: a start
 * survives the plan that decided it, two starts of one target are two entries and not one, the log
 * reads newest first, and a project's history is bounded without eating its neighbour's.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeTestDb, type TestDb } from "./db/testing";
import * as schema from "./db/schema";
import { PICKER_START_RETENTION, listPickerStarts, recordPickerStart } from "./picker-starts";
import type { Clock } from "./jobs/queue";

const NOW = 1_800_000_000_000;
const PROJECT = "p-starts";
const OTHER = "p-other";

let test: TestDb;
let clock: Clock;
let nowMs: number;

beforeEach(async () => {
  test = makeTestDb();
  nowMs = NOW;
  clock = { now: () => nowMs };
  await test.db.insert(schema.projects).values([
    { id: PROJECT, slug: "starts", name: "starts", repoPath: "/tmp/starts" },
    { id: OTHER, slug: "other", name: "other", repoPath: "/tmp/other" },
  ]);
});

afterEach(() => test.close());

function start(over: Partial<Parameters<typeof recordPickerStart>[2]> = {}) {
  return recordPickerStart(test.db, clock, {
    projectId: PROJECT,
    beadId: "anton-a",
    rank: 1,
    ranked: 4,
    rule: "the work policy armed on this machine",
    jobId: "job-1",
    ...over,
  });
}

describe("recording a start", () => {
  it("records the pick, the rule and the run it enqueued", async () => {
    await start();

    expect(await listPickerStarts(test.db, PROJECT)).toEqual([
      {
        beadId: "anton-a",
        rank: 1,
        ranked: 4,
        rule: "the work policy armed on this machine",
        jobId: "job-1",
        startedAtMs: NOW,
      },
    ]);
  });

  it("appends: starting the same target twice is two things anton did", async () => {
    await start();
    nowMs = NOW + 60_000;
    await start();

    const log = await listPickerStarts(test.db, PROJECT);
    expect(log.map((row) => row.startedAtMs)).toEqual([NOW + 60_000, NOW]);
  });

  it("reads newest first, so the log matches the order the page renders", async () => {
    await start({ beadId: "anton-old" });
    nowMs = NOW + 600_000;
    await start({ beadId: "anton-new" });

    expect((await listPickerStarts(test.db, PROJECT)).map((row) => row.beadId)).toEqual([
      "anton-new",
      "anton-old",
    ]);
  });

  it("carries no run id when the enqueue reported none", async () => {
    await start({ jobId: undefined });
    expect((await listPickerStarts(test.db, PROJECT))[0]?.jobId).toBeUndefined();
  });
});

describe("retention", () => {
  it("keeps the newest window and drops what fell out of it", async () => {
    for (let i = 0; i < PICKER_START_RETENTION + 5; i++) {
      nowMs = NOW + i * 60_000;
      await start({ beadId: `anton-${i}` });
    }

    const log = await listPickerStarts(test.db, PROJECT, PICKER_START_RETENTION + 10);
    expect(log).toHaveLength(PICKER_START_RETENTION);
    // The newest survives and the oldest is gone — a prune must never take the row about to render.
    expect(log[0]?.beadId).toBe(`anton-${PICKER_START_RETENTION + 4}`);
    expect(log.map((row) => row.beadId)).not.toContain("anton-0");
  });

  it("prunes only its own project's history", async () => {
    await start({ projectId: OTHER, beadId: "anton-theirs" });
    for (let i = 0; i < PICKER_START_RETENTION + 3; i++) {
      nowMs = NOW + i * 60_000;
      await start({ beadId: `anton-${i}` });
    }

    expect((await listPickerStarts(test.db, OTHER)).map((row) => row.beadId)).toEqual([
      "anton-theirs",
    ]);
  });
});
