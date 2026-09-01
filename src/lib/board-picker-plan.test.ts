/**
 * The picker's recorded plan (anton-it5i): the snapshot stamp that makes staleness detectable, and
 * the one-row-per-project persistence three surfaces read instead of re-ranking the board. What
 * these tests pin is what those surfaces depend on — a plan replaced rather than appended, a stamp
 * that round-trips, a digest that moves only when the answer could, and a read that never shells out.
 */
import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { makeTestDb, type TestDb } from "./db/testing";
import * as schema from "./db/schema";
import {
  getBoardPickerPlan,
  isPlanStale,
  saveBoardPickerPlan,
  sortExclusions,
  stampBoard,
  type BoardStamp,
  type PickerExclusion,
  type PickerPlanEntry,
} from "./board-picker-plan";
import { eligibleTargets } from "./jobs/picker-targets";
import type { Bead } from "./beads/types";
import type { Clock } from "./jobs/queue";

// Hoisted so the `node:child_process` mock below — which vitest lifts above the imports — can close
// over it. Nothing in the read path may spawn a process; `bd` is the one that would.
const spawned = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  spawn: spawned,
}));

const NOW = 1_800_000_000_000;
const OBSERVED = NOW - 4_000;
const clock: Clock = { now: () => NOW };

function bead(o: Partial<Bead> = {}): Bead {
  return {
    id: "anton-a",
    title: "a target",
    status: "open",
    issue_type: "feature",
    priority: 1,
    created_at: "2026-08-01T00:00:00Z",
    labels: ["approved", "domain:eng"],
    ...o,
  };
}

/** A bead whose contract holds — the state the approve gate admits, so a gap opened in it is a real
 *  flip from eligible to `approval-gap`. */
const SHAPED_BODY = [
  "## Goal",
  "Ship the thing",
  "",
  "## Context",
  "It lives in src/lib",
  "",
  "## Out of scope",
  "Everything else",
  "",
  "## Verify",
  "bun run test",
].join("\n");

function shaped(o: Partial<Bead> = {}): Bead {
  return bead({ description: SHAPED_BODY, acceptance_criteria: "- [ ] it works", ...o });
}

function stamp(o: Partial<BoardStamp> = {}): BoardStamp {
  return { observedAtMs: OBSERVED, digest: "cafebabecafebabe", beadCount: 3, ...o };
}

const entry = (o: Partial<PickerPlanEntry> = {}): PickerPlanEntry => ({
  beadId: "anton-a",
  rank: 1,
  rule: "type ∈ {feature} ∧ priority ≥ P1",
  ...o,
});

const excluded = (o: Partial<PickerExclusion> = {}): PickerExclusion => ({
  beadId: "anton-z",
  reason: "claimed",
  detail: "held by henri",
  ...o,
});

describe("board stamp", () => {
  it("is independent of the order the board was read in", () => {
    const board = [bead({ id: "anton-a" }), bead({ id: "anton-b" }), bead({ id: "anton-c" })];
    const shuffled = [board[2], board[0], board[1]];

    expect(stampBoard(shuffled, OBSERVED).digest).toBe(stampBoard(board, OBSERVED).digest);
  });

  it("carries the observation moment and the snapshot's size verbatim", () => {
    const stamped = stampBoard([bead(), bead({ id: "anton-b" })], OBSERVED);

    expect(stamped).toMatchObject({ observedAtMs: OBSERVED, beadCount: 2 });
    expect(stamped.digest).toMatch(/^[0-9a-f]{16}$/);
  });

  // Everything eligibility and the PRIME ranking read. A move in any of them can change the answer,
  // so a plan computed before it is no longer about this board.
  it.each([
    ["status", { status: "closed" }],
    ["type", { issue_type: "epic" }],
    ["priority", { priority: 0 }],
    ["assignee", { assignee: "henri" }],
    ["parent", { parent: "anton-epic" }],
    ["labels", { labels: ["approved", "domain:eng", "risk:high"] }],
    ["blocks edges", { dependencies: [{ issue_id: "anton-a", depends_on_id: "anton-b", type: "blocks" }] }],
  ])("moves when a bead's %s changes", (_field, change) => {
    const before = stampBoard([bead()], OBSERVED);

    expect(stampBoard([bead(change)], OBSERVED).digest).not.toBe(before.digest);
  });

  // The contract lives in prose, but eligibility reads it: the approve gate faults a cleared
  // Acceptance as `approval-gap`, so a digest blind to the description would hold still across the
  // one edit that flips rank 1 out of the plan entirely.
  it.each([
    ["its Acceptance criteria are cleared", { acceptance_criteria: undefined }],
    ["its Acceptance heading is deleted from the description", { description: "## Goal\nShip the thing" }],
    ["a section still holds the formula's prompt", { acceptance_criteria: "TODO — state the criteria" }],
  ])("moves when %s", (_edit, change) => {
    const before = stampBoard([shaped()], OBSERVED);

    expect(stampBoard([shaped(change)], OBSERVED).digest).not.toBe(before.digest);
  });

  it("moves when a bead joins or leaves the board", () => {
    const one = stampBoard([bead()], OBSERVED);
    const two = stampBoard([bead(), bead({ id: "anton-b" })], OBSERVED);

    expect(two.digest).not.toBe(one.digest);
  });

  // Otherwise a typo fix marks every plan stale on a board the pass re-reads every ten minutes, and
  // "the board moved" stops carrying any information. The contract enters the digest as a verdict,
  // not as its text, so reworded prose under intact headings reads as the same board.
  it("holds still when prose moves but nothing the decision reads does", () => {
    const before = stampBoard([shaped()], OBSERVED);

    const after = stampBoard(
      [
        shaped({
          title: "a target, renamed",
          description: SHAPED_BODY.replace("Ship the thing", "Ship the thing, spelled right"),
          acceptance_criteria: "- [ ] it works, restated",
          updated_at: "2026-08-19T09:00:00Z",
        }),
      ],
      OBSERVED + 60_000,
    );

    expect(after.digest).toBe(before.digest);
  });

  it("holds still when the same labels and edges arrive in a different order", () => {
    const deps = [
      { issue_id: "anton-a", depends_on_id: "anton-b", type: "blocks" },
      { issue_id: "anton-a", depends_on_id: "anton-c", type: "blocks" },
    ];
    const before = stampBoard([bead({ labels: ["a", "b"], dependencies: deps })], OBSERVED);

    const after = stampBoard(
      [bead({ labels: ["b", "a"], dependencies: [deps[1], deps[0]] })],
      OBSERVED,
    );

    expect(after.digest).toBe(before.digest);
  });
});

describe("staleness", () => {
  const plan = {
    projectId: "p1",
    generatedAt: Math.floor(NOW / 1000),
    stamp: stampBoard([bead()], OBSERVED),
    entries: [entry()],
    exclusions: [],
  };

  it("is a claim about the board, not about the clock", () => {
    const muchLater = stampBoard([bead()], OBSERVED + 86_400_000);

    expect(isPlanStale(plan, muchLater)).toBe(false);
  });

  it("catches a board that moved a second after the plan was computed", () => {
    const moved = stampBoard([bead({ assignee: "henri" })], OBSERVED + 1);

    expect(isPlanStale(plan, moved)).toBe(true);
  });

  // The invariant the fence exists for, stated against the real eligibility predicate rather than
  // against a field list: any edit that changes who may be started must read as a moved board, or a
  // surface presents as rank 1 a target the gate now refuses.
  it("catches an edit that flips a target out of the eligible set", () => {
    const before = [shaped()];
    const after = [shaped({ acceptance_criteria: undefined })];
    expect(eligibleTargets(before).eligible).toHaveLength(1);
    expect(eligibleTargets(after)).toMatchObject({
      eligible: [],
      exclusions: [{ beadId: "anton-a", reason: "approval-gap" }],
    });

    const shapedPlan = { ...plan, stamp: stampBoard(before, OBSERVED) };

    expect(isPlanStale(shapedPlan, stampBoard(after, OBSERVED + 1))).toBe(true);
  });

  /**
   * The other half of the decision. An operator editing `pickerPolicy` changes who may be started
   * without touching a bead, so a fence over the beads alone would keep calling the old plan current
   * — and the lane would go on offering a start the new policy refuses until the next pass ran.
   */
  it("catches a policy saved after the plan was computed", () => {
    const board = [bead()];
    const unarmed = { ...plan, stamp: stampBoard(board, OBSERVED) };

    expect(isPlanStale(unarmed, stampBoard(board, OBSERVED + 1, { types: ["bug"] }))).toBe(true);
  });

  it("holds still when the policy is re-saved unchanged", () => {
    const board = [bead()];
    const policy = { types: ["feature", "bug"], labels: [{ namespace: "domain", values: ["eng"] }] };
    const armed = { ...plan, stamp: stampBoard(board, OBSERVED, policy) };

    // Same criteria, authored in another order — the same policy, so the same fence.
    const resaved = {
      types: ["bug", "feature"],
      labels: [{ namespace: "domain", values: ["eng"] }],
    };
    expect(isPlanStale(armed, stampBoard(board, OBSERVED + 1, resaved))).toBe(false);
  });

  it("catches an armed policy being cleared", () => {
    const board = [bead()];
    const armed = { ...plan, stamp: stampBoard(board, OBSERVED, { types: ["feature"] }) };

    expect(isPlanStale(armed, stampBoard(board, OBSERVED + 1))).toBe(true);
  });
});

describe("plan storage", () => {
  let tdb: TestDb;
  const projectId = "p1";

  beforeEach(async () => {
    spawned.mockClear();
    tdb = makeTestDb();
    await tdb.db
      .insert(schema.projects)
      .values({ id: projectId, slug: "p1", name: "p1", repoPath: "/tmp/p1" });
  });

  afterEach(() => tdb.close());

  it("round-trips the ranked targets, their rules, and every exclusion reason", async () => {
    const entries = [entry(), entry({ beadId: "anton-b", rank: 2, rule: "type ∈ {bug}" })];
    const exclusions = [
      excluded(),
      excluded({ beadId: "anton-y", reason: "blocked", detail: "waits on anton-x" }),
    ];

    await saveBoardPickerPlan(tdb.db, clock, {
      projectId,
      jobId: "job-1",
      stamp: stamp(),
      entries,
      exclusions,
    });

    const plan = await getBoardPickerPlan(tdb.db, projectId);
    expect(plan).toMatchObject({ projectId, jobId: "job-1", generatedAt: Math.floor(NOW / 1000) });
    expect(plan!.entries).toEqual(entries);
    expect(plan!.exclusions).toEqual(sortExclusions(exclusions));
  });

  it("round-trips the board stamp, keeping the observation moment at millisecond precision", async () => {
    const observedAtMs = OBSERVED + 137;

    await saveBoardPickerPlan(tdb.db, clock, {
      projectId,
      stamp: stamp({ observedAtMs, digest: "0123456789abcdef", beadCount: 42 }),
      entries: [],
      exclusions: [],
    });

    const plan = await getBoardPickerPlan(tdb.db, projectId);
    expect(plan!.stamp).toEqual({ observedAtMs, digest: "0123456789abcdef", beadCount: 42 });
  });

  it("replaces the previous plan rather than appending — one row per project", async () => {
    await saveBoardPickerPlan(tdb.db, clock, {
      projectId,
      stamp: stamp({ digest: "1111111111111111" }),
      entries: [entry(), entry({ beadId: "anton-b", rank: 2 })],
      exclusions: [excluded()],
    });

    await saveBoardPickerPlan(tdb.db, clock, {
      projectId,
      stamp: stamp({ digest: "2222222222222222" }),
      entries: [entry({ beadId: "anton-c" })],
      exclusions: [],
    });

    const rows = await tdb.db.select().from(schema.boardPickerPlans);
    expect(rows).toHaveLength(1);
    expect(rows[0].targetCount).toBe(1);
    const plan = await getBoardPickerPlan(tdb.db, projectId);
    expect(plan!.entries.map((e) => e.beadId)).toEqual(["anton-c"]);
    expect(plan!.exclusions).toEqual([]);
    expect(plan!.stamp.digest).toBe("2222222222222222");
  });

  it("keeps one row per project, not one per board", async () => {
    await tdb.db
      .insert(schema.projects)
      .values({ id: "p2", slug: "p2", name: "p2", repoPath: "/tmp/p2" });

    await saveBoardPickerPlan(tdb.db, clock, { projectId, stamp: stamp(), entries: [entry()], exclusions: [] });
    await saveBoardPickerPlan(tdb.db, clock, {
      projectId: "p2",
      stamp: stamp(),
      entries: [entry({ beadId: "other-a" })],
      exclusions: [],
    });

    expect(await tdb.db.select().from(schema.boardPickerPlans)).toHaveLength(2);
    expect((await getBoardPickerPlan(tdb.db, projectId))!.entries[0].beadId).toBe("anton-a");
  });

  // "Never ran" and "ran, admitted nothing" are different answers, and the lane says different
  // things about them — an empty lane under an armed policy is not an unswept one.
  it("distinguishes a project the picker has never run for from a pass that admitted nothing", async () => {
    expect(await getBoardPickerPlan(tdb.db, projectId)).toBeUndefined();

    await saveBoardPickerPlan(tdb.db, clock, {
      projectId,
      stamp: stamp(),
      entries: [],
      exclusions: [excluded({ reason: "policy", detail: "no rule admits it" })],
    });

    const plan = await getBoardPickerPlan(tdb.db, projectId);
    expect(plan).toBeTruthy();
    expect(plan!.entries).toEqual([]);
    expect(plan!.exclusions).toHaveLength(1);
  });

  it("stores the queue in rank order however the caller assembled it", async () => {
    await saveBoardPickerPlan(tdb.db, clock, {
      projectId,
      stamp: stamp(),
      entries: [entry({ beadId: "anton-c", rank: 3 }), entry({ beadId: "anton-a", rank: 1 }), entry({ beadId: "anton-b", rank: 2 })],
      exclusions: [],
    });

    const plan = await getBoardPickerPlan(tdb.db, projectId);
    expect(plan!.entries.map((e) => e.beadId)).toEqual(["anton-a", "anton-b", "anton-c"]);
  });

  // Idempotence: two passes over an unchanged board must leave byte-identical blobs, or the row
  // "changes" every tick and anything watching it for movement is watching noise.
  it("serializes two passes over an unchanged board identically", async () => {
    const input = {
      projectId,
      stamp: stamp(),
      entries: [entry(), entry({ beadId: "anton-b", rank: 2 })],
      exclusions: [excluded({ beadId: "anton-z" }), excluded({ beadId: "anton-y", reason: "blocked" })],
    };

    await saveBoardPickerPlan(tdb.db, clock, input);
    const first = (await tdb.db.select().from(schema.boardPickerPlans))[0];

    await saveBoardPickerPlan(tdb.db, clock, {
      ...input,
      exclusions: [...input.exclusions].reverse(),
    });
    const second = (await tdb.db.select().from(schema.boardPickerPlans))[0];

    expect(second.entriesJson).toBe(first.entriesJson);
    expect(second.exclusionsJson).toBe(first.exclusionsJson);
  });

  it("degrades a corrupt blob to nothing recorded, leaving the count to show the discrepancy", async () => {
    await saveBoardPickerPlan(tdb.db, clock, { projectId, stamp: stamp(), entries: [entry()], exclusions: [] });
    await tdb.db.update(schema.boardPickerPlans).set({ entriesJson: "{ not json" });

    const plan = await getBoardPickerPlan(tdb.db, projectId);
    expect(plan!.entries).toEqual([]);
    expect((await tdb.db.select().from(schema.boardPickerPlans))[0].targetCount).toBe(1);
  });

  // The reason the plan is recorded at all: a surface answers "what runs next?" from anton.db, so
  // rendering the lane can never cost a board read or block on bd.
  it("reads back without shelling out to bd", async () => {
    await saveBoardPickerPlan(tdb.db, clock, { projectId, stamp: stamp(), entries: [entry()], exclusions: [excluded()] });

    const plan = await getBoardPickerPlan(tdb.db, projectId);

    expect(plan!.entries).toHaveLength(1);
    expect(spawned).not.toHaveBeenCalled();
  });
});
