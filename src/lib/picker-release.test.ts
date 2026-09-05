/**
 * Which pick a release answers (anton-d2h6, anton-k4qr).
 *
 * The route around this is held by `approve-release.route.integration.test.ts`; what is pinned HERE
 * is the verdict itself, per branch — and above all the one anton-k4qr changed: a release naming a
 * generation that has since been replaced no longer drops the operator's answer on the floor. It
 * re-decides the plan from the board and either records against what now stands, or refuses the
 * start outright. Every other skip is unchanged, which is half of what these cases are for.
 */
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { makeTestDb, type TestDb } from "./db/testing";
import * as schema from "./db/schema";
import type { Bead } from "./beads/bd";
import {
  getBoardPickerPlan,
  saveBoardPickerPlan,
  stampBoard,
  type PickerPlanEntry,
} from "./board-picker-plan";
import { STRUCTURAL_RULE } from "./jobs/picker-decision";
import { listPickerVerdicts, recordPickerVeto } from "./picker-veto";
import { recordRelease, resolveRelease } from "./picker-release";

const PROJECT = "p-release";
const CLOCK = { now: () => 1_800_000_000_000 };

let test: TestDb;

/** A bead a real `bd` read produced: dated (the ranking's age input) and contract-shaped, so the
 *  approve gate has nothing to fault and each case tests the one rule it is about. */
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

/** A board the picker ranks `urgent` ahead of `target` on — so a rank read off the FRESH generation
 *  is distinguishable from the `rank: 1` every recorded plan below hands out. */
const BOARD = [bead("urgent", { priority: 0 }), bead("target", { priority: 2 })];

/** Record one generation and answer with its id — what a release names as the decision it answers. */
async function record(entries: PickerPlanEntry[], board = BOARD): Promise<string> {
  await saveBoardPickerPlan(test.db, CLOCK, {
    projectId: PROJECT,
    stamp: stampBoard(board, CLOCK.now()),
    entries,
    exclusions: [],
  });
  return (await getBoardPickerPlan(test.db, PROJECT))!.planId;
}

const displayedPlan = (beadId = "target") =>
  record([{ beadId, rank: 1, rule: "the rule the operator saw" }]);

const resolve = (displayedPlanId?: string, board = BOARD, beadId = "target") =>
  resolveRelease(test.db, {
    projectId: PROJECT,
    beadId,
    board,
    ...(displayedPlanId ? { displayedPlanId } : {}),
  });

beforeEach(async () => {
  test = makeTestDb();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  await test.db.insert(schema.projects).values({
    id: PROJECT,
    slug: "release",
    name: "release",
    repoPath: "/tmp/release",
    // `shadow` is the level that OFFERS the picker's picks (R3.5) — `propose` is its own case below.
    settingsJson: JSON.stringify({ pickerAutonomy: "shadow" }),
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  test.close();
});

describe("the generation the operator answered still stands", () => {
  it("answers with that generation's own rank and rule", async () => {
    const planId = await displayedPlan();

    expect(await resolve(planId)).toEqual({
      accept: { planId, rank: 1, rule: "the rule the operator saw" },
    });
  });

  it("falls back to the recorded plan when the client names no generation", async () => {
    // Every caller that predates the field: the plan on the row is the only decision there is.
    const planId = await displayedPlan();

    expect(await resolve()).toEqual({
      accept: { planId, rank: 1, rule: "the rule the operator saw" },
    });
  });

  it("skips a pick the generation names no entry for", async () => {
    // The lane is DERIVED, so a release can name the very generation on screen for a bead that
    // generation never picked. Naming the right plan is not agreeing with a decision it contains.
    const planId = await displayedPlan("someone-else");

    expect(await resolve(planId)).toEqual({ skip: "no recorded plan picks this target" });
  });

  it("skips once the board has moved past the plan that picked the target", async () => {
    const planId = await record([{ beadId: "target", rank: 1, rule: "stale" }], [bead("gone")]);

    expect(await resolve(planId)).toEqual({
      skip: "the plan that picked it is no longer the decision anton stands behind",
    });
  });
});

describe("a superseded generation", () => {
  it("re-derives against the board and records against the generation that now stands", async () => {
    // The tab still shows A; something has since written B over it. The pick may well have survived
    // that — so the question is asked of the board rather than dropped, and the answer names the
    // generation the re-derivation left standing, with ITS rank and ITS rule.
    const displayed = await displayedPlan();
    await record([{ beadId: "urgent", rank: 1, rule: "whatever the next pass ranked it under" }]);

    const verdict = await resolve(displayed);

    const now = (await getBoardPickerPlan(test.db, PROJECT))!;
    expect(now.planId).not.toBe(displayed);
    expect(verdict).toEqual({
      accept: { planId: now.planId, rank: 2, rule: STRUCTURAL_RULE },
    });
    // Rank 2, not the displayed plan's 1: the ranking the board produces now puts `urgent` first.
    expect(now.entries.map((e) => e.beadId)).toEqual(["urgent", "target"]);
  });

  it("keeps the standing generation when the re-derivation restates it", async () => {
    // `saveBoardPickerPlan` is idempotent per DECISION: a re-derivation that agrees with the row
    // must not retire the generation the surface is still offering.
    const displayed = await displayedPlan();
    await record([{ beadId: "urgent", rank: 1, rule: "the pass that replaced it" }]);
    const derived = await resolve(displayed);
    const minted = "accept" in derived ? derived.accept.planId : undefined;

    expect(await resolve(displayed)).toEqual({
      accept: { planId: minted, rank: 2, rule: STRUCTURAL_RULE },
    });
  });

  it("refuses the start when the ranking no longer carries the target, naming why", async () => {
    // Work only a PERSON can do is never anton's to start, so the fresh ranking leaves it out —
    // and a release is a request to start the pick, not merely to record one. Refusing here is what
    // keeps the approval and the enqueue from landing on a decision anton would not make.
    const board = [BOARD[0]!, bead("target", { labels: ["agent:human"] })];
    const displayed = await record([{ beadId: "target", rank: 1, rule: "before it was flagged" }], board);
    await record([{ beadId: "urgent", rank: 1, rule: "the pass that replaced it" }], board);

    const verdict = await resolve(displayed, board);

    expect(verdict).toMatchObject({
      refuse: expect.stringContaining("no longer one of anton's picks") as unknown as string,
    });
    expect("refuse" in verdict && verdict.refuse).toContain("needs-human");
    // Refusing writes no evidence either: the operator's click started nothing to answer for.
    expect(await listPickerVerdicts(test.db, PROJECT)).toHaveLength(0);
  });

  it.each([
    ["a claim landed first", { assignee: "another-operator" }, "held by another-operator"],
    ["its run already started", { status: "in_progress" as const }, "in_progress"],
  ])("refuses a target that was already settled — %s — without advising a second approval", async (
    _case,
    moved,
    detail,
  ) => {
    // The other half of a refusal (PR #236 review): `claimed` and `not-open` do not mean the pick
    // was retired, they mean someone else got there — often a release from another tab. Telling the
    // operator to approve it directly would file a second approval on a start that already exists,
    // so the copy names the stale surface instead, matching the client's 409 → `router.refresh()`.
    const board = [BOARD[0]!, bead("target", { priority: 2, ...moved })];
    const displayed = await record([{ beadId: "target", rank: 1, rule: "before it moved" }], board);
    await record([{ beadId: "urgent", rank: 1, rule: "the pass that replaced it" }], board);

    const verdict = await resolve(displayed, board);

    const refusal = "refuse" in verdict ? verdict.refuse : "";
    expect(refusal).toContain("already taken");
    expect(refusal).toContain(detail);
    expect(refusal).not.toContain("approve it directly");
    expect(await listPickerVerdicts(test.db, PROJECT)).toHaveLength(0);
  });

  it("skips rather than refuses a pick the operator has vetoed", async () => {
    // A veto excludes the target from any re-derivation, so without this ordering the operator's own
    // pacing would read back as "anton no longer picks this" — a different answer with a different
    // remedy, on a run that is still theirs to have.
    const displayed = await displayedPlan();
    await record([{ beadId: "urgent", rank: 1, rule: "the pass that replaced it" }]);
    await recordPickerVeto(test.db, CLOCK, {
      projectId: PROJECT,
      beadId: "target",
      action: "not-now",
    });

    expect(await resolve(displayed)).toEqual({ skip: "the operator vetoed this pick" });
  });
});

describe("the brakes a release is never taken past", () => {
  it("skips while the picker's schedule is off", async () => {
    const planId = await displayedPlan();
    await test.db.insert(schema.schedules).values({
      id: "sched-off",
      projectId: PROJECT,
      type: "board-picker",
      cron: "*/10 * * * *",
      enabled: false,
    });

    expect(await resolve(planId)).toEqual({ skip: "the picker is disarmed" });
  });

  it("skips while the picker is at propose — it offers no picks to answer", async () => {
    const planId = await displayedPlan();
    await test.db
      .update(schema.projects)
      .set({ settingsJson: JSON.stringify({ pickerAutonomy: "propose" }) });

    expect(await resolve(planId)).toEqual({
      skip: "the picker is at propose — it offers no picks to answer",
    });
  });

  it("skips when no plan has ever been recorded — including for a superseded id", async () => {
    // Nothing to supersede and nothing to re-derive against: a release here answers no decision at
    // all, which is a skip and never a refusal.
    expect(await resolve("a-generation-that-never-existed")).toEqual({
      skip: "no recorded plan picks this target",
    });
  });
});

describe("filing the accept", () => {
  it("records the pick's rank, rule and generation", async () => {
    const planId = await displayedPlan();

    const id = await recordRelease(test.db, {
      projectId: PROJECT,
      beadId: "target",
      pick: { planId, rank: 1, rule: "the rule the operator saw" },
    });

    expect(id).toBeTruthy();
    expect(await listPickerVerdicts(test.db, PROJECT)).toEqual([
      expect.objectContaining({
        beadId: "target",
        verdict: "accepted",
        action: "release",
        rank: 1,
        planId,
        rule: "the rule the operator saw",
      }),
    ]);
  });

  it("files nothing a second time — one accept per pick, not per click", async () => {
    const planId = await displayedPlan();
    const pick = { planId, rank: 1 };

    expect(await recordRelease(test.db, { projectId: PROJECT, beadId: "target", pick })).toBeTruthy();
    expect(await recordRelease(test.db, { projectId: PROJECT, beadId: "target", pick })).toBeUndefined();
    expect(await listPickerVerdicts(test.db, PROJECT)).toHaveLength(1);
  });

  it("loses to a veto that already answered the pick — one verdict, never two", async () => {
    const planId = await displayedPlan();
    await recordPickerVeto(test.db, CLOCK, {
      projectId: PROJECT,
      beadId: "target",
      action: "not-now",
      planId,
    });

    expect(
      await recordRelease(test.db, { projectId: PROJECT, beadId: "target", pick: { planId, rank: 1 } }),
    ).toBeUndefined();
    expect((await listPickerVerdicts(test.db, PROJECT)).map((r) => r.verdict)).toEqual(["declined"]);
  });
});
