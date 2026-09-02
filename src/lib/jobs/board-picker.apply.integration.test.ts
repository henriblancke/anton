/**
 * End-to-end proof of anton-qlci's acceptance, against REAL bd and the REAL board-picker handler:
 * an armed project starts exactly ONE run per pass, through the approve route's own approve+claim
 * sequence, and records that start on the bead as `policy`.
 *
 * Three properties, and each of them is only meaningful against a real board:
 *
 *   • the label and the claim land TOGETHER on the top-ranked target and on nothing else;
 *   • two OVERLAPPING passes enqueue one run and write one note — the plan is a view of the board,
 *     never a queue of events;
 *   • a target a human claimed is never taken, and never approved.
 *
 * A repo per test: the pass ranks the WHOLE board, so leftovers from a previous case would compete
 * with the one under test for the single start each pass makes.
 *
 * Skipped without bd.
 */
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { describeBd, makeBdRepo, type BdRepo } from "@/lib/testing/integration";
import { makeProjectDb, type TestProjectDb } from "@/lib/testing/project";
import { beads, ownerOf } from "../beads/bd";
import * as schema from "../db/schema";
import { getBoardPickerPlan } from "../board-picker-plan";
import { EARNED_AUTONOMY_BARS, PICKER_AUTONOMY_TIER } from "../gardener/autonomy";
import { makeBoardPickerHandler } from "./board-picker";
import { systemClock } from "./queue";
import type { JobContext } from "./runner";

// The sandbox has no Dolt remote, so publishing is a no-op that still spawns `bd dolt sync` — a
// subprocess that outlives the test and races the temp-dir cleanup. The nudge itself is the approve
// route's, proven there; what this suite is about is what lands on the board.
vi.mock("../beads/sync-nudge", () => ({ nudgeSync: vi.fn() }));

/** An unapproved, unclaimed, contract-shaped run target at the given bd priority. */
async function target(repo: string, title: string, priority: number): Promise<string> {
  const id = await beads.create(repo, {
    title,
    type: "task",
    description: "## Goal\n\nShip it.\n",
    acceptance: "- [ ] it ships",
  });
  await beads.update(repo, id, { priority });
  return id;
}

function fakeCtx(jobId = "job-1", projectId = "p1"): JobContext {
  return {
    jobId,
    type: "board-picker",
    projectId,
    payload: { projectId },
    attempt: 1,
    heartbeat: async () => {},
    report: () => {},
    signal: new AbortController().signal,
  };
}

let bdRepo: BdRepo;
let repo: string;
let t: TestProjectDb;

beforeEach(() => {
  bdRepo = makeBdRepo();
  repo = bdRepo.repo;
  t = makeProjectDb({ id: "p1", slug: "p1", name: "p1", repoPath: repo });
  // Armed, and armed to APPLY: a policy over the board's own vocabulary, the level that lets the
  // pass act on it, and the accept/veto record that level is earned on (anton-vkp9). Without all
  // three, the pass ranks and stops.
  t.db
    .update(schema.projects)
    .set({
      settingsJson: JSON.stringify({ pickerPolicy: { types: ["task"] }, pickerAutonomy: "apply" }),
    })
    .where(eq(schema.projects.id, "p1"))
    .run();
  earnApply();
});

/** A full window of released picks — this project's operator has answered, and kept saying yes. */
function earnApply(): void {
  const bar = EARNED_AUTONOMY_BARS[PICKER_AUTONOMY_TIER];
  for (let i = 0; i < bar.minSettled; i++) {
    t.db
      .insert(schema.pickerVerdicts)
      .values({
        id: `v${i}`,
        projectId: "p1",
        beadId: `answered-${i}`,
        verdict: "accepted",
        action: "release",
        planId: `plan-${i}`,
        decidedAt: new Date(Date.now() - (bar.minSettled - i) * 60_000),
      })
      .run();
  }
}

afterEach(() => {
  t.close();
  bdRepo.cleanup();
});

/** Every execute-epic job this project holds, with the epic each one names. */
async function startedEpics(): Promise<string[]> {
  const rows = await t.db
    .select({ payloadJson: schema.jobs.payloadJson, type: schema.jobs.type })
    .from(schema.jobs);
  return rows
    .filter((row) => row.type === "execute-epic")
    .map((row) => (JSON.parse(row.payloadJson) as { epicBeadId: string }).epicBeadId);
}

describeBd("board-picker apply e2e (real handler · real bd)", () => {
  it("starts exactly one target per pass — approved, claimed and noted as `policy`", async () => {
    const first = await target(repo, "urgent work", 0);
    const second = await target(repo, "later work", 2);
    const third = await target(repo, "much later work", 3);

    const effect = await makeBoardPickerHandler({ db: t.db, clock: systemClock })(fakeCtx());

    // ONE start, and it is the top of the ranking the same pass recorded.
    expect(await startedEpics()).toEqual([first]);
    expect(effect).toMatchObject({ changed: true });
    const plan = await getBoardPickerPlan(t.db, "p1");
    expect(plan?.entries[0]?.beadId).toBe(first);

    // The label and the claim landed together on that one bead.
    const started = await beads.show(repo, first);
    expect(beads.isApproved(started)).toBe(true);
    expect(ownerOf(started)).toBeTruthy();

    // R1.7: the note names the rule and the rank, and bd attributes it to nobody watching.
    expect(String(started.notes ?? "")).toContain("started by POLICY — rank 1 of 3");
    expect(String(started.notes ?? "")).toContain(plan!.entries[0].rule);

    // And nothing else moved: the ranked-but-not-started targets are untouched backlog.
    for (const id of [second, third]) {
      const untouched = await beads.show(repo, id);
      expect(beads.isApproved(untouched)).toBe(false);
      expect(ownerOf(untouched)).toBeUndefined();
      expect(String(untouched.notes ?? "")).not.toContain("POLICY");
    }
  });

  it("enqueues exactly one run and writes one note across two overlapping passes", async () => {
    // R1.6: two passes reading the same board must leave one run, not two. Only one eligible target
    // exists, so whichever pass loses the claim lock has the same pick to abandon.
    const only = await target(repo, "the only work", 0);

    await Promise.all([
      makeBoardPickerHandler({ db: t.db, clock: systemClock })(fakeCtx("job-1")),
      makeBoardPickerHandler({ db: t.db, clock: systemClock })(fakeCtx("job-2")),
    ]);

    expect(await startedEpics()).toEqual([only]);
    const started = await beads.show(repo, only);
    const notes = String(started.notes ?? "");
    expect(notes.split("started by POLICY")).toHaveLength(2);
  });

  it("never takes a target a human claimed, and leaves it unapproved", async () => {
    const claimed = await target(repo, "mine", 0);
    await beads.assign(repo, claimed, "henri");
    const free = await target(repo, "anton's", 2);

    await makeBoardPickerHandler({ db: t.db, clock: systemClock })(fakeCtx());

    // The pass started the target below it instead, and the human's reservation is intact.
    expect(await startedEpics()).toEqual([free]);
    const held = await beads.show(repo, claimed);
    expect(ownerOf(held)).toBe("henri");
    expect(beads.isApproved(held)).toBe(false);
    // And the plan says WHY it was skipped, rather than leaving it silently absent.
    const plan = await getBoardPickerPlan(t.db, "p1");
    expect(plan?.exclusions.find((e) => e.beadId === claimed)).toMatchObject({ reason: "claimed" });
  });

  it("starts nothing at shadow, however good the plan is", async () => {
    // The level is the whole difference between a lane an operator releases from and an autopilot.
    const only = await target(repo, "the only work", 0);
    t.db
      .update(schema.projects)
      .set({
        settingsJson: JSON.stringify({
          pickerPolicy: { types: ["task"] },
          pickerAutonomy: "shadow",
        }),
      })
      .where(eq(schema.projects.id, "p1"))
      .run();

    await makeBoardPickerHandler({ db: t.db, clock: systemClock })(fakeCtx());

    expect(await startedEpics()).toEqual([]);
    const untouched = await beads.show(repo, only);
    expect(beads.isApproved(untouched)).toBe(false);
    expect(ownerOf(untouched)).toBeUndefined();
    // The ranking is still there for the operator to release by hand.
    expect((await getBoardPickerPlan(t.db, "p1"))?.entries[0]?.beadId).toBe(only);
  });
});
