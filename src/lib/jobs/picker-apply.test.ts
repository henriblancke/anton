/**
 * The apply step (anton-qlci / R1.5-R1.7), against a fake board that can be moved between the plan
 * and the write — which is the only way to exercise the windows this module exists to close.
 *
 * What is pinned here is the ORDER and the CONTINGENCY: the label never lands without the claim, the
 * claim is never taken from a human, a lost race writes nothing at all, and a board that would not
 * refresh starts nothing. The end-to-end proof against real bd lives in
 * board-picker.apply.integration.test.ts; these are the cases a real board cannot be made to produce
 * on demand.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { beads, LABELS } from "../beads/bd";
import { pinBoardMode, resetBoardModeCache } from "../beads/board-mode";
import type { Bead } from "../beads/types";
import * as schema from "../db/schema";
import type { TestDb } from "../db/testing";
import { makeProjectDb } from "@/lib/testing/project";
import { applyPickerPlan, POLICY_ACTOR } from "./picker-apply";
import type { Clock } from "./queue";

const REPO = "/tmp/picker-apply";
const NOW = 1_800_000_000_000;
const clock: Clock = { now: () => NOW };

/** The fake board every seam below reads and writes. */
const board = vi.hoisted(() => ({ current: new Map<string, Record<string, unknown>>() }));

vi.mock("../beads/issues", () => ({
  loadAllIssues: vi.fn(async () => [...board.current.values()]),
}));
vi.mock("../operator", () => ({ resolveOperator: async () => "anton-box" }));
// The publish half is the approve route's, already proven there; here it would reach the real
// anton.db singleton for its durable backstop job.
vi.mock("../beads/sync-nudge", () => ({ nudgeSync: vi.fn() }));

/** A dated, contract-shaped, unclaimed run target — nothing for the approve gate to fault. */
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

function put(...beads: Bead[]): void {
  for (const b of beads) board.current.set(b.id, { ...b } as Record<string, unknown>);
}

function read(id: string): Bead {
  return board.current.get(id) as unknown as Bead;
}

const notes: { id: string; text: string; actor?: string }[] = [];
let pullFails = false;
let pulls = 0;

function stubBd(): void {
  vi.spyOn(beads, "pull").mockImplementation(async () => {
    pulls += 1;
    if (pullFails) throw new Error("dolt remote unreachable");
  });
  vi.spyOn(beads, "show").mockImplementation(async (_cwd, id) => {
    const b = board.current.get(id);
    if (!b) throw new Error(`no such bead ${id}`);
    return { ...b } as unknown as Bead;
  });
  vi.spyOn(beads, "assign").mockImplementation(async (_cwd, id, actor) => {
    board.current.get(id)!.assignee = actor;
    return "";
  });
  vi.spyOn(beads, "unassign").mockImplementation(async (_cwd, id) => {
    board.current.get(id)!.assignee = undefined;
    return "";
  });
  vi.spyOn(beads, "tag").mockImplementation(async (_cwd, id, labels) => {
    const b = board.current.get(id)!;
    b.labels = [...new Set([...((b.labels as string[]) ?? []), ...labels])];
    return "";
  });
  vi.spyOn(beads, "untag").mockImplementation(async (_cwd, id, labels) => {
    const b = board.current.get(id)!;
    b.labels = ((b.labels as string[]) ?? []).filter((l) => !labels.includes(l));
    return "";
  });
  vi.spyOn(beads, "note").mockImplementation(async (_cwd, id, text, actor) => {
    notes.push({ id, text, ...(actor ? { actor } : {}) });
    return "";
  });
}

let t: TestDb;
beforeEach(() => {
  board.current = new Map();
  notes.length = 0;
  pullFails = false;
  pulls = 0;
  t = makeProjectDb({ id: "p1", slug: "p1", name: "p1", repoPath: REPO });
  stubBd();
});
afterEach(() => {
  vi.restoreAllMocks();
  resetBoardModeCache();
  t.close();
});

/** One apply pass over a plan whose top pick is `beadId`. */
function apply(beadId: string, ranked = 1) {
  const entries = [{ beadId, rank: 1, rule: "the work policy armed on this machine" }];
  for (let i = 2; i <= ranked; i += 1) {
    entries.push({ beadId: `filler-${i}`, rank: i, rule: "the work policy armed on this machine" });
  }
  return applyPickerPlan({ db: t.db, clock, projectId: "p1", repoPath: REPO, entries });
}

/** Every execute-epic job this project holds, whatever its status. */
async function jobs(): Promise<{ id: string; payloadJson: string }[]> {
  return t.db
    .select({ id: schema.jobs.id, payloadJson: schema.jobs.payloadJson })
    .from(schema.jobs);
}

describe("applyPickerPlan", () => {
  it("approves, claims and enqueues the top pick, and records the start as `policy`", async () => {
    put(bead("t1"));

    const outcome = await apply("t1", 3);

    expect(outcome).toMatchObject({ started: { beadId: "t1", rank: 1 } });
    const written = read("t1");
    expect(written.labels).toContain(LABELS.approved);
    expect(written.assignee).toBe("anton-box");
    expect(await jobs()).toHaveLength(1);
    // R1.7: the rule and the rank, attributed to nobody watching.
    expect(notes).toEqual([
      {
        id: "t1",
        actor: POLICY_ACTOR,
        text:
          "anton: started by POLICY — rank 1 of 3, admitted by the work policy armed on this " +
          "machine. Nobody approved this: this project's picker autonomy is set to apply.",
      },
    ]);
  });

  it("never takes a target a human claimed, and writes nothing when it finds one", async () => {
    // The plan was decided while it was free; a person claimed it in the window before the write.
    put(bead("t1", { assignee: "henri" }));

    const outcome = await apply("t1");

    expect(outcome).toMatchObject({ skipped: { beadId: "t1" } });
    expect((outcome as { skipped: { reason: string } }).skipped.reason).toContain("henri");
    expect(read("t1").labels ?? []).not.toContain(LABELS.approved);
    expect(read("t1").assignee).toBe("henri");
    expect(await jobs()).toHaveLength(0);
    expect(notes).toEqual([]);
  });

  it("leaves NO approved label behind when the claim CAS loses", async () => {
    // The stale-label leak, pinned: the label is contingent on the swap, so a claim that lands
    // between the guard's read and the assignee write must leave the bead exactly as it was.
    put(bead("t1"));
    const assign = vi.spyOn(beads, "assign").mockImplementation(async (_cwd, id) => {
      // Another machine's claim wins the race — our write does not survive it.
      board.current.get(id)!.assignee = "other-box";
      return "";
    });

    const outcome = await apply("t1");

    expect(assign).toHaveBeenCalled();
    expect(outcome).toMatchObject({
      skipped: { beadId: "t1", reason: "other-box claimed it first" },
    });
    expect(read("t1").labels ?? []).not.toContain(LABELS.approved);
    expect(await jobs()).toHaveLength(0);
    expect(notes).toEqual([]);
  });

  it("starts nothing on an embedded board whose pull did not land", async () => {
    // Fail closed: a stale mirror can only be wrong in the direction that double-approves, so a
    // refusal to refresh it stops the pass before it reads, let alone writes.
    put(bead("t1"));
    pullFails = true;

    const outcome = await apply("t1");

    expect(outcome).toMatchObject({ skipped: { beadId: "t1" } });
    expect((outcome as { skipped: { reason: string } }).skipped.reason).toContain(
      "could not be refreshed",
    );
    expect(read("t1").labels ?? []).not.toContain(LABELS.approved);
    expect(read("t1").assignee).toBeUndefined();
    expect(await jobs()).toHaveLength(0);
  });

  it("does not pull on a shared-server board — there is no mirror to refresh", async () => {
    pinBoardMode(REPO, { mode: "server", host: "db.test", port: 3306, database: "beads" });
    put(bead("t1"));

    expect(await apply("t1")).toMatchObject({ started: { beadId: "t1" } });
    expect(pulls).toBe(0);
  });

  it("enqueues exactly one run across two overlapping passes, and notes one start", async () => {
    put(bead("t1"));

    const outcomes = await Promise.all([apply("t1"), apply("t1")]);

    expect(outcomes.filter((o) => "started" in o)).toHaveLength(1);
    expect(await jobs()).toHaveLength(1);
    expect(notes).toHaveLength(1);
  });

  it("writes no second note when a run already covers the target", async () => {
    // The idempotence rule from the other side: a resumable job from an earlier pass covers the
    // epic, so this pass settles the approval and stops — a start that did not happen is not noted.
    put(bead("t1"));
    await apply("t1");
    notes.length = 0;

    // The target reads as claimed by US now, so free it the way a released reservation would be.
    board.current.get("t1")!.assignee = undefined;
    const outcome = await apply("t1");

    expect(outcome).toMatchObject({
      skipped: { beadId: "t1", reason: "a run already covers this target" },
    });
    expect(await jobs()).toHaveLength(1);
    expect(notes).toEqual([]);
  });

  it("takes back its own label and claim when the enqueue fails", async () => {
    // Otherwise the target is stranded: approved and self-claimed reads as work already under way,
    // to the next pass and to a human alike, with no run behind it.
    put(bead("t1"));
    const broken = {
      ...t.db,
      transaction: () => {
        throw new Error("anton.db is gone");
      },
    };

    const outcome = await applyPickerPlan({
      db: broken as unknown as TestDb["db"],
      clock,
      projectId: "p1",
      repoPath: REPO,
      entries: [{ beadId: "t1", rank: 1, rule: "the work policy armed on this machine" }],
    });

    expect(outcome).toMatchObject({ skipped: { beadId: "t1" } });
    expect(read("t1").labels ?? []).not.toContain(LABELS.approved);
    expect(read("t1").assignee).toBeUndefined();
    expect(notes).toEqual([]);
  });

  it("keeps a human's approval when its own enqueue fails", async () => {
    // The label was not ours to take back — a person approved this target and never started it.
    put(bead("t1", { labels: [LABELS.approved] }));
    const broken = {
      ...t.db,
      transaction: () => {
        throw new Error("anton.db is gone");
      },
    };

    await applyPickerPlan({
      db: broken as unknown as TestDb["db"],
      clock,
      projectId: "p1",
      repoPath: REPO,
      entries: [{ beadId: "t1", rank: 1, rule: "the work policy armed on this machine" }],
    });

    expect(read("t1").labels).toContain(LABELS.approved);
    expect(read("t1").assignee).toBeUndefined();
  });

  it("starts nothing on an empty plan", async () => {
    const outcome = await applyPickerPlan({
      db: t.db,
      clock,
      projectId: "p1",
      repoPath: REPO,
      entries: [],
    });

    expect(outcome).toEqual({ skipped: { reason: "the plan ranked nothing to start" } });
    expect(await jobs()).toHaveLength(0);
  });

  it("abandons a target that left the board between the plan and the write", async () => {
    const outcome = await apply("ghost");

    expect(outcome).toMatchObject({ skipped: { beadId: "ghost" } });
    expect(await jobs()).toHaveLength(0);
  });
});
