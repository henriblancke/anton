/**
 * The board-picker handler (anton-albm): one pass = one board read, one decision, one recorded plan.
 *
 * The decision itself is pinned in picker-decision.test.ts. What is pinned here is the WIRING — that
 * arming the schedule actually produces a row a surface can read, at the job that produced it, and
 * that two overlapping passes leave one plan rather than two. A pass that resolved without writing
 * would be indistinguishable from an armed schedule that never fired.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeTestDb, type TestDb } from "../db/testing";
import * as schema from "../db/schema";
import { getBoardPickerPlan } from "../board-picker-plan";
import { activeDisarm } from "../autopilot-disarm";
import type { Bead } from "../beads/types";
import { PoisonError } from "./errors";
import type { Clock } from "./queue";
import type { JobContext } from "./runner";
import { makeBoardPickerHandler } from "./board-picker";

const board = vi.hoisted(() => ({ current: [] as Bead[], calls: [] as unknown[][] }));
vi.mock("../beads/issues", () => ({
  loadAllIssues: vi.fn(async (...args: unknown[]) => {
    board.calls.push(args);
    return board.current;
  }),
}));

const NOW = 1_800_000_000_000;
const clock: Clock = { now: () => NOW };

/** A dated, contract-shaped bead — nothing for the approve gate to fault. */
function bead(id: string, o: Partial<Bead> = {}): Bead {
  return {
    id,
    title: id,
    status: "open",
    issue_type: "task",
    created_at: "2026-08-01T00:00:00Z",
    description: "## Goal\n\nShip it.\n",
    acceptance_criteria: "- [ ] it ships",
    ...o,
  };
}

function fakeCtx(over: Partial<JobContext> = {}): JobContext {
  return {
    jobId: "job-1",
    type: "board-picker",
    projectId: "p1",
    payload: { projectId: "p1" },
    attempt: 1,
    heartbeat: async () => {},
    report: () => {},
    signal: new AbortController().signal,
    ...over,
  };
}

let t: TestDb;
beforeEach(() => {
  board.current = [];
  board.calls = [];
  t = makeTestDb();
  t.db
    .insert(schema.projects)
    .values({ id: "p1", slug: "p1", name: "p1", repoPath: "/tmp/p1" })
    .run();
});
afterEach(() => t.close());

describe("makeBoardPickerHandler", () => {
  it("records the pass's ranked plan, stamped with the board it decided over", async () => {
    board.current = [bead("t1", { priority: 2 }), bead("t2", { priority: 0 })];

    await makeBoardPickerHandler({ db: t.db, clock })(fakeCtx());

    const plan = await getBoardPickerPlan(t.db, "p1");
    expect(plan?.entries.map((e) => e.beadId)).toEqual(["t2", "t1"]);
    // Every entry names the rule that admitted it — a plan whose picks cannot be explained is one
    // an operator can only accept on faith.
    expect(plan?.entries.every((e) => e.rule.length > 0)).toBe(true);
    expect(plan?.jobId).toBe("job-1");
    expect(plan?.stamp.beadCount).toBe(2);
    expect(plan?.stamp.observedAtMs).toBe(NOW);
    expect(plan?.generatedAt).toBe(Math.floor(NOW / 1000));
  });

  it("reads the board strictly, so a gate-less read retries instead of recording it as blocked", async () => {
    await makeBoardPickerHandler({ db: t.db, clock })(fakeCtx());
    expect(board.calls[0]).toEqual(["/tmp/p1", { strictGates: true }]);
  });

  it("records an EMPTY plan on a board with nothing claimable", async () => {
    // "Decided, nothing to start" has to be storable: absent it, a lane cannot tell an idle board
    // from a schedule that never fired.
    board.current = [bead("t1", { status: "closed" })];

    await makeBoardPickerHandler({ db: t.db, clock })(fakeCtx());

    const plan = await getBoardPickerPlan(t.db, "p1");
    expect(plan?.entries).toEqual([]);
    expect(plan?.stamp.beadCount).toBe(1);
  });

  it("leaves one plan behind when two passes overlap", async () => {
    board.current = [bead("t1")];
    const handler = makeBoardPickerHandler({ db: t.db, clock });

    await Promise.all([handler(fakeCtx()), handler(fakeCtx({ jobId: "job-2" }))]);

    const rows = await t.db.select().from(schema.boardPickerPlans);
    expect(rows.length).toBe(1);
    expect(rows[0].entriesJson).toBe(
      JSON.stringify([{ beadId: "t1", rank: 1, rule: "any claimable run target" }]),
    );
  });

  it("heartbeats after the board read, so a slow `bd` isn't killed as no progress", async () => {
    board.current = [bead("t1")];
    const beats: string[] = [];

    await makeBoardPickerHandler({ db: t.db, clock })(
      fakeCtx({ heartbeat: async () => void beats.push("beat") }),
    );

    expect(beats).toEqual(["beat"]);
  });

  it("writes NOTHING once the pass is cancelled", async () => {
    // The plan is replaced whole, so a cancelled pass that still wrote would overwrite the last good
    // plan — and during project teardown resurrect a row the abort just deleted.
    board.current = [bead("t1")];
    const aborted = AbortSignal.abort();

    await expect(
      makeBoardPickerHandler({ db: t.db, clock })(fakeCtx({ signal: aborted })),
    ).rejects.toThrow();

    expect(await getBoardPickerPlan(t.db, "p1")).toBeUndefined();
  });

  it("disarms the project when its recent runs are a streak of failures, and still ranks", async () => {
    // The brake and the ranking are different jobs: the pass starts nothing, so the plan stays
    // useful reading while the latch is what the arming step refuses on (R4.4 / R1.5).
    board.current = [bead("t1")];
    for (const [i, id] of ["r1", "r2", "r3"].entries()) {
      const at = new Date(NOW - (3 - i) * 3_600_000);
      t.db
        .insert(schema.runs)
        .values({
          id,
          projectId: "p1",
          epicBeadId: `anton-${id}`,
          status: "failed",
          error: "verify gate failed",
          startedAt: at,
          endedAt: at,
          updatedAt: at,
        })
        .run();
    }

    await makeBoardPickerHandler({ db: t.db, clock })(fakeCtx());

    const disarm = await activeDisarm(t.db, "p1");
    expect(disarm?.reason).toBe("consecutive-failures");
    expect(disarm?.evidence).toHaveLength(3);
    expect((await getBoardPickerPlan(t.db, "p1"))?.entries.map((e) => e.beadId)).toEqual(["t1"]);
  });

  it("disarms the project when its delivered runs keep scoring below the floor", async () => {
    // The other quality brake (R4.3): these runs all DELIVERED, so the failure breaker sees nothing
    // — what stops the picker is the trend in what they shipped.
    const targets = ["anton-a", "anton-b", "anton-c"];
    board.current = [
      bead("t1"),
      ...targets.map((id, i) =>
        bead(id, { status: "closed", labels: [`review-score:${4 + i}`] }),
      ),
    ];
    for (const [i, id] of targets.entries()) {
      const at = new Date(NOW - (3 - i) * 3_600_000);
      t.db
        .insert(schema.runs)
        .values({
          id: `r${i}`,
          projectId: "p1",
          epicBeadId: id,
          status: "done",
          startedAt: at,
          endedAt: at,
          updatedAt: at,
        })
        .run();
    }

    await makeBoardPickerHandler({ db: t.db, clock })(fakeCtx());

    const disarm = await activeDisarm(t.db, "p1");
    expect(disarm?.reason).toBe("score-regression");
    expect(disarm?.evidence).toHaveLength(3);
    // The brake and the ranking remain different jobs, exactly as for the failure streak.
    expect((await getBoardPickerPlan(t.db, "p1"))?.entries.map((e) => e.beadId)).toEqual(["t1"]);
  });

  it("parks a payload naming a project that is gone rather than retrying it forever", async () => {
    const handler = makeBoardPickerHandler({ db: t.db, clock });
    await expect(handler(fakeCtx({ payload: { projectId: "ghost" } }))).rejects.toThrow(PoisonError);
  });
});
