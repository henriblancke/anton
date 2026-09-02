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
import { nudgeSync } from "../beads/sync-nudge";
import { listPickerStarts } from "../picker-starts";
import { applyPickerPlan, POLICY_ACTOR, type ClaimSettleDeps } from "./picker-apply";
import type { Clock } from "./queue";

const REPO = "/tmp/picker-apply";
const NOW = 1_800_000_000_000;
const clock: Clock = { now: () => NOW };

/** The fake board every seam below reads and writes. */
const board = vi.hoisted(() => ({ current: new Map<string, Record<string, unknown>>() }));

vi.mock("../beads/issues", () => ({
  loadAllIssues: vi.fn(async () => [...board.current.values()]),
}));
/** This machine's claim identity — mutable, because a machine that has none must start nothing. */
const operator = vi.hoisted(() => ({ current: undefined as string | undefined }));
vi.mock("../operator", () => ({ resolveOperator: async () => operator.current }));
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
  // A board with no remote: nothing to settle against, so the settle is a single push and out.
  vi.spyOn(beads, "push").mockImplementation(async () => "not-wired");
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
  operator.current = "anton-box";
  notes.length = 0;
  pullFails = false;
  pulls = 0;
  t = makeProjectDb({ id: "p1", slug: "p1", name: "p1", repoPath: REPO });
  vi.mocked(nudgeSync).mockClear();
  stubBd();
});
afterEach(() => {
  vi.restoreAllMocks();
  resetBoardModeCache();
  t.close();
});

/** One apply pass over a plan whose top pick is `beadId`. */
function apply(beadId: string, ranked = 1, settle?: ClaimSettleDeps) {
  const entries = [{ beadId, rank: 1, rule: "the work policy armed on this machine" }];
  for (let i = 2; i <= ranked; i += 1) {
    entries.push({ beadId: `filler-${i}`, rank: i, rule: "the work policy armed on this machine" });
  }
  return applyPickerPlan({
    db: t.db,
    clock,
    projectId: "p1",
    repoPath: REPO,
    entries,
    ...(settle ? { settle } : {}),
  });
}

/** A wired board whose settle window costs nothing — the cross-machine race, without the wait. */
function wired(over: ClaimSettleDeps = {}): ClaimSettleDeps {
  return { push: async () => "synced", sleep: async () => {}, ...over };
}

/** Every execute-epic job this project holds, whatever its status. */
async function jobs(): Promise<{ id: string; payloadJson: string; status: string }[]> {
  return t.db
    .select({ id: schema.jobs.id, payloadJson: schema.jobs.payloadJson, status: schema.jobs.status })
    .from(schema.jobs);
}

/** A settled-but-recoverable run left on `t1` by an earlier attempt — what a parked epic looks like. */
async function settledJob(status: "parked" | "failed"): Promise<string> {
  const id = `job-${status}`;
  await t.db.insert(schema.jobs).values({
    id,
    type: "execute-epic",
    projectId: "p1",
    payloadJson: JSON.stringify({ projectId: "p1", epicBeadId: "t1" }),
    status,
    runAt: new Date(NOW),
    updatedAt: new Date(NOW),
  });
  return id;
}

/** Make every job CAS lose — the concurrent settle `resumeJob`'s guarded UPDATE exists to catch. */
function jobWritesLoseTheirRace(): void {
  vi.spyOn(t.db, "update").mockReturnValue({
    set: () => ({ where: () => ({ returning: async () => [] }) }),
  } as unknown as ReturnType<TestDb["db"]["update"]>);
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

  it("logs the start where the operator reads it, not only on the bead", async () => {
    // anton-vfvg: the bead note answers a reader already looking at the bead; the Health page's
    // decision log answers one who does not yet know anything happened.
    put(bead("t1"));

    const outcome = await apply("t1", 3);

    const jobId = (outcome as { started: { jobId: string } }).started.jobId;
    expect(await listPickerStarts(t.db, "p1")).toEqual([
      {
        beadId: "t1",
        rank: 1,
        ranked: 3,
        rule: "the work policy armed on this machine",
        jobId,
        startedAtMs: NOW,
      },
    ]);
  });

  it("logs nothing when the pass started nothing", async () => {
    put(bead("t1", { assignee: "henri" }));

    await apply("t1");

    expect(await listPickerStarts(t.db, "p1")).toEqual([]);
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

  it("takes its claim back when the approval itself fails", async () => {
    // The sharpest strand: the CAS moved the assignee and the label write threw, so without an
    // unwind the target reads as claimed to every later pass, with no approval and no run behind it.
    put(bead("t1"));
    vi.spyOn(beads, "tag").mockRejectedValue(new Error("bd update timed out"));

    const outcome = await apply("t1");

    expect(outcome).toMatchObject({ skipped: { beadId: "t1" } });
    expect((outcome as { skipped: { reason: string } }).skipped.reason).toContain(
      "could not be approved",
    );
    expect(read("t1").assignee).toBeUndefined();
    expect(read("t1").labels ?? []).not.toContain(LABELS.approved);
    expect(await jobs()).toHaveLength(0);
    expect(notes).toEqual([]);
    // The release still has to reach the other machines that can see the claim.
    expect(nudgeSync).toHaveBeenCalled();
  });

  it("publishes the approval and the claim when a run already covers the target", async () => {
    // The writes landed even though nothing started, and unpublished they are invisible to the
    // machine whose next pass would then read the target as free.
    put(bead("t1"));
    await apply("t1");
    board.current.get("t1")!.assignee = undefined;
    vi.mocked(nudgeSync).mockClear();

    await apply("t1");

    expect(nudgeSync).toHaveBeenCalledTimes(1);
  });

  it("enqueues nothing when the claim does not survive the board merge", async () => {
    // The local CAS ordered this process only: two machines can both refresh, both find the target
    // free and both write. Whoever loses the merge must not start a run on a claim it does not hold.
    put(bead("t1"));

    const outcome = await apply(
      "t1",
      1,
      wired({
        // The re-read after the settle window: the remote's merge kept the other machine's claim.
        pull: async () => {
          board.current.get("t1")!.assignee = "other-box";
        },
      }),
    );

    expect(outcome).toMatchObject({
      skipped: { beadId: "t1", reason: "other-box claimed it first" },
    });
    expect(await jobs()).toHaveLength(0);
    expect(notes).toEqual([]);
    // Not ours to unwind — the label merged too, and the reservation is the winner's now.
    expect(read("t1").assignee).toBe("other-box");
  });

  it("starts nothing when the claim cannot be published, and takes its writes back", async () => {
    // Fail closed, exactly like the pull that precedes the CAS: a claim no other machine can see is
    // not a claim, so it must not license a run.
    put(bead("t1"));

    const outcome = await apply(
      "t1",
      1,
      wired({
        push: async () => {
          throw new Error("dolt remote unreachable");
        },
      }),
    );

    expect(outcome).toMatchObject({ skipped: { beadId: "t1" } });
    expect((outcome as { skipped: { reason: string } }).skipped.reason).toContain(
      "could not be published",
    );
    expect(read("t1").assignee).toBeUndefined();
    expect(read("t1").labels ?? []).not.toContain(LABELS.approved);
    expect(await jobs()).toHaveLength(0);
  });

  it("starts the pick once the claim reads back as ours", async () => {
    put(bead("t1"));

    const outcome = await apply("t1", 1, wired());

    expect(outcome).toMatchObject({ started: { beadId: "t1" } });
    expect(await jobs()).toHaveLength(1);
  });

  it("does not settle a claim it never wrote", async () => {
    // A no-op swap (the target already reads as ours) took no reservation of its own, so there is
    // nothing to prove and no settle window to pay for.
    put(bead("t1", { assignee: "anton-box" }));
    const push = vi.fn(async () => "synced" as const);

    await apply("t1", 1, wired({ push }));

    expect(push).not.toHaveBeenCalled();
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

  it("starts nothing when this machine has no claim identity", async () => {
    // The assignee IS the cross-machine guard: with nobody to claim as, the CAS is a no-op that
    // proves nothing, and two pickers would both approve and both enqueue the same target.
    operator.current = undefined;
    put(bead("t1"));

    const outcome = await apply("t1");

    expect(outcome).toMatchObject({ skipped: { beadId: "t1" } });
    expect((outcome as { skipped: { reason: string } }).skipped.reason).toContain(
      "no claim identity",
    );
    expect(read("t1").labels ?? []).not.toContain(LABELS.approved);
    expect(read("t1").assignee).toBeUndefined();
    expect(await jobs()).toHaveLength(0);
    expect(notes).toEqual([]);
  });

  it("resumes a parked run rather than claiming a target nothing will run", async () => {
    // The operator fixed what parked the run and released its stale reservation. A parked job
    // COVERS the epic, so the enqueue withholds an id — and nothing redispatches it on its own.
    put(bead("t1"));
    const parked = await settledJob("parked");

    const outcome = await apply("t1");

    expect(outcome).toMatchObject({ started: { beadId: "t1", jobId: parked } });
    expect(await jobs()).toEqual([
      expect.objectContaining({ id: parked, status: "queued" }),
    ]);
    expect(read("t1").assignee).toBe("anton-box");
    expect(read("t1").labels).toContain(LABELS.approved);
    expect(notes).toHaveLength(1);
  });

  it("takes its writes back when no run could be started at all", async () => {
    // The unwind's whole point, from the enqueue's blind side: a covering job that could not be
    // resumed leaves an approved, self-claimed target with nothing behind it — which every later
    // pass reads as work already under way and never re-picks.
    put(bead("t1"));
    await settledJob("failed");
    jobWritesLoseTheirRace();

    const outcome = await apply("t1");

    expect(outcome).toMatchObject({
      skipped: { beadId: "t1", reason: "no run could be started for this target" },
    });
    expect(read("t1").assignee).toBeUndefined();
    expect(read("t1").labels ?? []).not.toContain(LABELS.approved);
    expect(notes).toEqual([]);
    expect(nudgeSync).toHaveBeenCalled();
  });

  it("keeps the claim standing when the approval it wrote will not come off", async () => {
    // Ordered, not best-effort: releasing on top of a failed unapproval publishes exactly the shape
    // any worker starts — approved and unclaimed — so the target waits for a person instead.
    put(bead("t1"));
    vi.spyOn(beads, "untag").mockRejectedValue(new Error("bd update timed out"));
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

    expect((outcome as { skipped: { reason: string } }).skipped.reason).toContain(
      "left approved and claimed",
    );
    expect(read("t1").labels).toContain(LABELS.approved);
    expect(read("t1").assignee).toBe("anton-box");
  });
});
