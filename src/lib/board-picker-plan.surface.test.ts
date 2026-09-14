/**
 * End-to-end for the record's whole reason to exist (anton-it5i): a pass ranks a board, records the
 * plan, and the SURFACE read path — `latestBoardPickerPlan` over the real `getDb()` singleton and a
 * migrated on-disk anton.db — hands back exactly what the ranking returned. Not the in-memory
 * db-injected path the unit tests use: the lane reads the shared database, and a round-trip that
 * only holds against a hand-passed connection would prove nothing about what an operator sees.
 *
 * The ranking here is a deterministic stand-in for the PRIME order (anton-higu). What is under test
 * is the property that outlives whichever comparator lands: what comes back out is what went in,
 * in the order the ranking put it.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makeFileDb, type FileDb } from "@/lib/testing/integration";
import type { Bead } from "./beads/types";

let fileDb: FileDb;
let plan: typeof import("./board-picker-plan");
let getDb: typeof import("./db").getDb;
let schema: typeof import("./db/schema");

const PROJECT_ID = "p-surface";
const NOW = 1_800_000_000_000;
const OBSERVED = NOW - 2_500;

// Points ANTON_DB at a temp, fully migrated database BEFORE the modules that resolve the singleton
// are loaded — the same ordering every other file-db suite in this repo relies on.
beforeAll(async () => {
  fileDb = makeFileDb();
  plan = await import("./board-picker-plan");
  getDb = (await import("./db")).getDb;
  schema = await import("./db/schema");
  await getDb()
    .insert(schema.projects)
    .values({ id: PROJECT_ID, slug: "surface", name: "surface", repoPath: "/tmp/surface" });
});

afterAll(() => fileDb.cleanup());

function bead(id: string, priority: number | undefined, createdAt: string): Bead {
  return {
    id,
    title: id,
    status: "open",
    issue_type: "feature",
    priority,
    created_at: createdAt,
    labels: ["approved"],
  };
}

/** Priority first (a bead with none sorts last), then age, then id — total, like the real one. */
function rank(board: Bead[]): import("./board-picker-plan").PickerPlanEntry[] {
  return [...board]
    .sort(
      (a, b) =>
        (a.priority ?? Number.MAX_SAFE_INTEGER) - (b.priority ?? Number.MAX_SAFE_INTEGER) ||
        Date.parse(a.created_at!) - Date.parse(b.created_at!) ||
        a.id.localeCompare(b.id),
    )
    .map((b, i) => ({ beadId: b.id, rank: i + 1, rule: `priority ≥ P${b.priority ?? "?"}` }));
}

describe("the recorded plan is what the pass decided", () => {
  const board = [
    bead("anton-mid", 2, "2026-08-02T00:00:00Z"),
    bead("anton-none", undefined, "2026-07-01T00:00:00Z"),
    bead("anton-top", 0, "2026-08-05T00:00:00Z"),
    bead("anton-old", 2, "2026-07-15T00:00:00Z"),
  ];

  it("hands the surface the ranking's own output, in the ranking's own order", async () => {
    const ranked = rank(board);
    const excluded = [
      { beadId: "anton-held", reason: "claimed" as const, detail: "held by henri" },
      { beadId: "anton-wait", reason: "blocked" as const, detail: "waits on anton-top" },
    ];

    await plan.saveBoardPickerPlan(
      getDb(),
      { now: () => NOW },
      {
        projectId: PROJECT_ID,
        jobId: "job-picker-1",
        stamp: plan.stampBoard(board, OBSERVED),
        entries: ranked,
        exclusions: excluded,
      },
    );

    const recorded = await plan.latestBoardPickerPlan(PROJECT_ID);

    expect(recorded!.entries).toEqual(ranked);
    expect(recorded!.entries.map((e) => e.beadId)).toEqual([
      "anton-top",
      "anton-old",
      "anton-mid",
      "anton-none",
    ]);
    expect(recorded!.exclusions).toEqual(plan.sortExclusions(excluded));
    expect(recorded!.jobId).toBe("job-picker-1");
  });

  it("reads current against the board it was ranked from, and stale once that board moves", async () => {
    const recorded = await plan.latestBoardPickerPlan(PROJECT_ID);

    expect(plan.isPlanStale(recorded!, plan.stampBoard(board, OBSERVED + 900_000))).toBe(false);

    const claimed = board.map((b) => (b.id === "anton-top" ? { ...b, assignee: "henri" } : b));
    expect(plan.isPlanStale(recorded!, plan.stampBoard(claimed, OBSERVED + 1))).toBe(true);
  });

  it("still answers with one row after the next pass — the surface reads the current plan, not a log", async () => {
    const next = [board[0], board[3]];

    await plan.saveBoardPickerPlan(
      getDb(),
      { now: () => NOW + 600_000 },
      {
        projectId: PROJECT_ID,
        jobId: "job-picker-2",
        stamp: plan.stampBoard(next, OBSERVED + 600_000),
        entries: rank(next),
        exclusions: [],
      },
    );

    expect(await getDb().select().from(schema.boardPickerPlans)).toHaveLength(1);
    const recorded = await plan.latestBoardPickerPlan(PROJECT_ID);
    expect(recorded!.jobId).toBe("job-picker-2");
    expect(recorded!.entries.map((e) => e.beadId)).toEqual(["anton-old", "anton-mid"]);
  });
});
