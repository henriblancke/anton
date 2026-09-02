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
import { disarmAutopilot } from "../autopilot-disarm";
import { beads, LABELS } from "../beads/bd";
import { loadAllIssues } from "../beads/issues";
import { EARNED_AUTONOMY_BARS, PICKER_AUTONOMY_TIER } from "../gardener/autonomy";
import { pinBoardMode, resetBoardModeCache } from "../beads/board-mode";
import type { Bead } from "../beads/types";
import * as schema from "../db/schema";
import type { TestDb } from "../db/testing";
import { makeProjectDb } from "@/lib/testing/project";
import { nudgeSync } from "../beads/sync-nudge";
import { listPickerStarts } from "../picker-starts";
import {
  applyPickerPlan,
  pickerWipHold,
  POLICY_ACTOR,
  type ClaimSettleDeps,
  type ConfirmStart,
  type PickerApplyInput,
} from "./picker-apply";
import { enqueueExecuteEpicIfAbsent, type Clock } from "./queue";

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

/**
 * An open run target already waiting on review, pointing at its PR — what execute-epic leaves
 * behind, and what the flow brake counts as an occupied slot.
 */
function inReview(id: string, prNumber: number): Bead {
  return {
    id,
    title: id,
    status: "open",
    issue_type: "feature",
    labels: [LABELS.stage("in-review")],
    metadata: { pr: `gh-${prNumber}` },
  } as Bead;
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

/**
 * The STANCE every start rests on: an armed policy, `apply`, and the record that level has to be
 * earned on. Re-resolved by the apply itself at both its gates (`pickerStance`), so a test that
 * does not set it is testing a picker the operator switched off.
 *
 * The policy is empty on purpose — every criterion is optional, so `{}` is an armed policy that
 * admits its whole startable set. It leaves these cases about the CLAIM, and the narrowing ones
 * below arm a criterion of their own.
 */
function arm(policy: unknown = {}, autonomy = "apply"): void {
  t.db
    .update(schema.projects)
    .set({ settingsJson: JSON.stringify({ pickerPolicy: policy, pickerAutonomy: autonomy }) })
    .run();
}

/**
 * The operator's flow limit, written beside the stance because the settings blob holds both — a
 * partial write here would read as a picker switched off rather than a limit moved.
 */
function setWipLimit(limit: number): void {
  t.db
    .update(schema.projects)
    .set({
      settingsJson: JSON.stringify({
        pickerPolicy: {},
        pickerAutonomy: "apply",
        autopilotWipLimit: limit,
      }),
    })
    .run();
}

/** The bar the picker's own record clears — read off the shared ladder, never restated here. */
const PICKER_BAR = EARNED_AUTONOMY_BARS[PICKER_AUTONOMY_TIER];

/** Enough released picks for `apply` to be EARNED, written where the release route writes them. */
function answerPicks(settled = PICKER_BAR.minSettled, accepted = PICKER_BAR.minSettled): void {
  for (let i = 0; i < settled; i++) {
    t.db
      .insert(schema.pickerVerdicts)
      .values({
        id: `v${i}`,
        projectId: "p1",
        beadId: `answered-${i}`,
        verdict: i < accepted ? "accepted" : "declined",
        action: i < accepted ? "release" : "not-now",
        planId: `plan-${i}`,
        decidedAt: new Date(NOW - (settled - i) * 60_000),
      })
      .run();
  }
}

/**
 * The anton.db with its enqueue knocked out. Layered over the real handle rather than spread from
 * it: the apply also READS through this db (the stance it re-resolves), and a spread would drop
 * every method drizzle keeps on the prototype.
 */
function brokenDb(): TestDb["db"] {
  return Object.assign(Object.create(t.db) as TestDb["db"], {
    transaction: () => {
      throw new Error("anton.db is gone");
    },
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
  arm();
  answerPicks();
  vi.mocked(nudgeSync).mockClear();
  stubBd();
});
afterEach(() => {
  vi.restoreAllMocks();
  resetBoardModeCache();
  t.close();
});

/** One apply pass over a plan whose top pick is `beadId`. */
function apply(
  beadId: string,
  ranked = 1,
  settle?: ClaimSettleDeps,
  over: Pick<PickerApplyInput, "signal" | "run" | "held" | "wipLimit"> = {},
) {
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
    ...over,
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

  it("settles a shared-server claim without the sync legs that board cannot run", async () => {
    // There is no mirror to refresh and nothing to publish — `bd dolt pull/push` would run ON the
    // server — but the reservation is still a read-then-assign CAS two processes can both write, so
    // the settle window and the read-back stay.
    pinBoardMode(REPO, { mode: "server", host: "db.test", port: 3306, database: "beads" });
    put(bead("t1"));
    const push = vi.fn(async () => "synced" as const);

    const outcome = await apply("t1", 1, { push, sleep: async () => {} });

    expect(outcome).toMatchObject({ started: { beadId: "t1" } });
    expect(pulls).toBe(0);
    expect(push).not.toHaveBeenCalled();
  });

  it("enqueues nothing when a shared-server claim loses the last write", async () => {
    // The cross-process race the local CAS cannot order (beads/claim.ts): two pickers both read the
    // target free and both assign, last write standing. Re-reading after the window is what decides
    // it — the loser sees the winner's assignee and starts nothing.
    pinBoardMode(REPO, { mode: "server", host: "db.test", port: 3306, database: "beads" });
    put(bead("t1"));

    const outcome = await apply("t1", 1, {
      sleep: async () => {
        board.current.get("t1")!.assignee = "other-box";
      },
    });

    expect(outcome).toMatchObject({
      skipped: { beadId: "t1", reason: "other-box claimed it first" },
    });
    expect(await jobs()).toHaveLength(0);
    expect(notes).toEqual([]);
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
      // The approval and the claim STAND, so the caller's plan is as stale as after a start and it
      // is told so (PR #218 review).
      skipped: { beadId: "t1", reason: "a run already covers this target", wroteBoard: true },
    });
    expect(await jobs()).toHaveLength(1);
    expect(notes).toEqual([]);
  });

  it("hands back a re-check that unwinds when teardown deletes the run it deferred to", async () => {
    // The covered skip leaves the approval and the claim standing over a run this pass did not
    // start, and the caller then spends a board read of its own restamping the plan (PR #218
    // review). `abortProject` landing in there sweeps that covering run exactly as readily as a
    // fresh one, and the writes are just as orphaned — so this skip carries the same seam check a
    // start does.
    put(bead("t1"));
    await apply("t1");
    board.current.get("t1")!.assignee = undefined;
    const controller = new AbortController();
    const outcome = await apply("t1", 1, undefined, { signal: controller.signal });
    expect(outcome).toMatchObject({
      skipped: { reason: "a run already covers this target", wroteBoard: true },
    });

    // Teardown, inside the caller's restamp.
    controller.abort();
    await t.db.delete(schema.jobs);
    const swept = await (outcome as { confirmStart?: ConfirmStart }).confirmStart?.();

    expect(swept).toMatchObject({
      skipped: { beadId: "t1", reason: expect.stringContaining("removed with it") },
    });
    expect(read("t1").assignee).toBeUndefined();
  });

  it("takes back its own label and claim when the enqueue fails", async () => {
    // Otherwise the target is stranded: approved and self-claimed reads as work already under way,
    // to the next pass and to a human alike, with no run behind it.
    put(bead("t1"));
    const broken = brokenDb();

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
    const broken = brokenDb();

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

  it("hands the claim back when the claim write commits and then throws", async () => {
    // `bd assign` is ambiguous on failure: it can land the assignee and still reject. Left to
    // propagate, the rejection would skip the unwind entirely and strand the target as claimed with
    // no approval and no run — the same shape a failed label write leaves.
    put(bead("t1"));
    vi.spyOn(beads, "assign").mockImplementation(async (_cwd, id, actor) => {
      board.current.get(id)!.assignee = actor;
      throw new Error("bd assign timed out");
    });

    const outcome = await apply("t1");

    expect(outcome).toMatchObject({ skipped: { beadId: "t1" } });
    expect((outcome as { skipped: { reason: string } }).skipped.reason).toContain(
      "could not be claimed",
    );
    expect(read("t1").assignee).toBeUndefined();
    expect(read("t1").labels ?? []).not.toContain(LABELS.approved);
    expect(await jobs()).toHaveLength(0);
    expect(notes).toEqual([]);
  });

  it("names the target a human has to clear when the ambiguous claim will not come off", async () => {
    put(bead("t1"));
    vi.spyOn(beads, "assign").mockImplementation(async (_cwd, id, actor) => {
      board.current.get(id)!.assignee = actor;
      throw new Error("bd assign timed out");
    });
    vi.spyOn(beads, "unassign").mockRejectedValue(new Error("dolt is locked"));

    const outcome = await apply("t1");

    expect(outcome).toMatchObject({ skipped: { beadId: "t1", wroteBoard: true } });
    expect((outcome as { skipped: { reason: string } }).skipped.reason).toContain(
      "left claimed by anton",
    );
    expect(read("t1").assignee).toBe("anton-box");
    // The reservation is real to the other machines, so it has to reach them.
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

  it("releases the claim when the approval failed and the label was never written", async () => {
    // `wroteLabel` says the label is OURS to take back, not that it is THERE. The approve write
    // threw, so nothing is on the bead — and an untag that then refuses the missing label must not
    // gate the release, or the unwind leaves exactly the claimed-and-unapproved target it exists to
    // prevent.
    put(bead("t1"));
    vi.spyOn(beads, "tag").mockRejectedValue(new Error("bd update timed out"));
    const untag = vi
      .spyOn(beads, "untag")
      .mockRejectedValue(new Error("bd update: no such label `approved`"));

    const outcome = await apply("t1");

    expect(outcome).toMatchObject({ skipped: { beadId: "t1" } });
    expect((outcome as { skipped: { reason: string } }).skipped.reason).not.toContain("by hand");
    expect(untag).not.toHaveBeenCalled();
    expect(read("t1").assignee).toBeUndefined();
    expect(await jobs()).toHaveLength(0);
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

  it("enqueues nothing when the target stops being startable while the claim settles", async () => {
    // Winning the assignee proves the race was won, not that the prize is still worth having: the
    // holder check cannot see a close, a blocker or an `agent:human` label landing in the settle
    // window, and enqueueing anyway buys a run execute-epic only poison-parks.
    put(bead("t1"));

    const outcome = await apply(
      "t1",
      1,
      wired({
        pull: async () => {
          const b = board.current.get("t1")!;
          b.labels = [...((b.labels as string[]) ?? []), LABELS.agentHuman];
        },
      }),
    );

    expect(outcome).toMatchObject({ skipped: { beadId: "t1" } });
    expect((outcome as { skipped: { reason: string } }).skipped.reason).toContain(
      "stopped being startable",
    );
    expect(await jobs()).toHaveLength(0);
    expect(notes).toEqual([]);
    // Fail closed: the writes come off so the next pass re-decides against a free target.
    expect(read("t1").assignee).toBeUndefined();
    expect(read("t1").labels ?? []).not.toContain(LABELS.approved);
  });

  it("enqueues nothing when the approval is withdrawn while the claim settles", async () => {
    // The eligibility rule never asks about the label — the picker is its second WRITER — so a
    // withdrawal inside the settle window is invisible to both the holder check and the
    // re-validation, and the run it would buy only poison-parks as unapproved (PR #218 review).
    put(bead("t1"));

    const outcome = await apply(
      "t1",
      1,
      wired({
        pull: async () => {
          const b = board.current.get("t1")!;
          b.labels = ((b.labels as string[]) ?? []).filter((l) => l !== LABELS.approved);
        },
      }),
    );

    expect(outcome).toMatchObject({ skipped: { beadId: "t1" } });
    expect((outcome as { skipped: { reason: string } }).skipped.reason).toContain(
      "approval was withdrawn",
    );
    expect(await jobs()).toHaveLength(0);
    expect(notes).toEqual([]);
    // Fail closed: the claim comes off so the next pass re-decides against a free target.
    expect(read("t1").assignee).toBeUndefined();
  });

  describe("the standing approval behind the start", () => {
    /** The reason a skip carries, without the cast at every call site. */
    const why = (outcome: unknown) => (outcome as { skipped: { reason: string } }).skipped.reason;

    it("writes nothing when the picker was moved off apply between the plan and the write", async () => {
      // The stance was read once, before the ranking. An operator who steps back to `shadow` in that
      // window has withdrawn the standing approval this start rests on, and the board cannot say so.
      put(bead("t1"));
      arm({}, "shadow");

      const outcome = await apply("t1");

      expect(outcome).toMatchObject({ skipped: { beadId: "t1" } });
      expect(why(outcome)).toContain("no longer apply");
      expect(await jobs()).toHaveLength(0);
      expect(read("t1").assignee).toBeUndefined();
      expect(read("t1").labels ?? []).not.toContain(LABELS.approved);
    });

    it("writes nothing when the policy stopped admitting the target before the write", async () => {
      put(bead("t1", { issue_type: "task" }));
      arm({ types: ["bug"] });

      const outcome = await apply("t1");

      expect(outcome).toMatchObject({ skipped: { beadId: "t1" } });
      expect(why(outcome)).toContain("no longer admits it");
      expect(await jobs()).toHaveLength(0);
      expect(read("t1").assignee).toBeUndefined();
    });

    it("writes nothing when the record stopped earning apply before the write", async () => {
      // The EARNED floor is half the resolution, so it has to bite here exactly as it does where the
      // pass decided to call the apply at all — a record that degrades mid-pass is a demotion.
      put(bead("t1"));
      t.db.delete(schema.pickerVerdicts).run();

      const outcome = await apply("t1");

      expect(outcome).toMatchObject({ skipped: { beadId: "t1" } });
      expect(why(outcome)).toContain("no longer apply");
      expect(read("t1").assignee).toBeUndefined();
    });

    it("takes its writes back when the policy is narrowed while the claim settles", async () => {
      // The window the guard cannot cover: the settle is seconds long, and the approval this start
      // rests on can be withdrawn inside it as easily as the target can move under it.
      put(bead("t1", { issue_type: "task" }));

      const outcome = await apply("t1", 1, wired({ sleep: async () => arm({ types: ["bug"] }) }));

      expect(outcome).toMatchObject({ skipped: { beadId: "t1" } });
      expect(why(outcome)).toContain("standing approval was withdrawn");
      expect(await jobs()).toHaveLength(0);
      expect(notes).toEqual([]);
      // Fail closed, like every other settle refusal: the writes come off so the next pass re-decides.
      expect(read("t1").assignee).toBeUndefined();
      expect(read("t1").labels ?? []).not.toContain(LABELS.approved);
    });

    it("takes its writes back when the picker is moved off apply while the claim settles", async () => {
      put(bead("t1"));

      const outcome = await apply("t1", 1, wired({ sleep: async () => arm({}, "shadow") }));

      expect(outcome).toMatchObject({ skipped: { beadId: "t1" } });
      expect(why(outcome)).toContain("no longer apply");
      expect(await jobs()).toHaveLength(0);
      expect(read("t1").assignee).toBeUndefined();
      expect(read("t1").labels ?? []).not.toContain(LABELS.approved);
    });

    it("takes its writes back when a NOT-WIRED board's stance is withdrawn during the write", async () => {
      // The default local board publishes nowhere, so it skips the propagation window — but not the
      // re-validation (PR #218 review). The approve and the claim are two `bd` invocations wide, and
      // an operator stepping off `apply` inside them leaves this start resting on an approval that
      // no longer exists, with nothing else on this path re-asking.
      put(bead("t1"));

      const outcome = await apply("t1", 1, {
        board: async () => {
          arm({}, "shadow");
          return [...board.current.values()] as unknown as Bead[];
        },
      });

      expect(outcome).toMatchObject({ skipped: { beadId: "t1" } });
      expect(why(outcome)).toContain("no longer apply");
      expect(await jobs()).toHaveLength(0);
      expect(read("t1").assignee).toBeUndefined();
      expect(read("t1").labels ?? []).not.toContain(LABELS.approved);
    });

    it("re-validates a NOT-WIRED board without waiting out a window it has no remote for", async () => {
      // Skip the REMOTE half only: no push to settle, no pull to merge, no sleep — and still a
      // read-back the eligibility rule and the stance are judged against.
      put(bead("t1"));
      const sleep = vi.fn(async () => {});
      const pull = vi.fn(async () => {});

      const outcome = await apply("t1", 1, { sleep, pull });

      expect(outcome).toMatchObject({ started: { beadId: "t1" } });
      expect(sleep).not.toHaveBeenCalled();
      expect(pull).not.toHaveBeenCalled();
    });

    it("takes its writes back when a NOT-WIRED board's target stops being startable", async () => {
      put(bead("t1"));

      const outcome = await apply("t1", 1, {
        board: async () => {
          const b = board.current.get("t1")!;
          b.labels = [...((b.labels as string[]) ?? []), LABELS.agentHuman];
          return [...board.current.values()] as unknown as Bead[];
        },
      });

      expect(outcome).toMatchObject({ skipped: { beadId: "t1" } });
      expect(why(outcome)).toContain("stopped being startable");
      expect(await jobs()).toHaveLength(0);
      expect(read("t1").assignee).toBeUndefined();
      expect(read("t1").labels ?? []).not.toContain(LABELS.approved);
    });

    it("judges the settled target with its OWN reservation cleared, not as claimed work", async () => {
      // The startable projection the policy is evaluated over excludes claimed targets, so a
      // post-settle check that read the board as written would refuse every start it ever made.
      put(bead("t1"));

      const outcome = await apply("t1", 1, wired());

      expect(outcome).toMatchObject({ started: { beadId: "t1" } });
    });
  });

  describe("the safety brake behind the start", () => {
    const why = (outcome: unknown) => (outcome as { skipped: { reason: string } }).skipped.reason;

    /** Freeze the project exactly as a breaker does — the latch the caller read before the ranking. */
    const freeze = () =>
      disarmAutopilot(t.db, clock, {
        projectId: "p1",
        reason: "consecutive-failures",
        detail: "3 runs in a row stopped without delivering",
      });

    it("writes nothing when the project is disarmed between the plan and the write", async () => {
      // The caller cleared this pass against a latch read before the ranking; an overlapping pass's
      // breaker can trip in the window before the lock, and a freeze means start nothing.
      put(bead("t1"));
      await freeze();

      const outcome = await apply("t1");

      expect(outcome).toMatchObject({ skipped: { beadId: "t1" } });
      expect(why(outcome)).toContain("disarmed");
      expect(await jobs()).toHaveLength(0);
      expect(read("t1").assignee).toBeUndefined();
      expect(read("t1").labels ?? []).not.toContain(LABELS.approved);
    });

    it("takes its writes back when the project is disarmed while the claim settles", async () => {
      // The window nothing else covers: the stance re-asks the operator's settings and the settle
      // re-asks the board, but neither can see a breaker latching while this pass claims.
      put(bead("t1"));

      const outcome = await apply(
        "t1",
        1,
        wired({
          sleep: async () => {
            await freeze();
          },
        }),
      );

      expect(outcome).toMatchObject({ skipped: { beadId: "t1", wroteBoard: false } });
      expect(why(outcome)).toContain("disarmed");
      expect(await jobs()).toHaveLength(0);
      expect(notes).toEqual([]);
      // Fail closed, like every other late refusal: the writes come off so a re-armed project can
      // re-decide the target from scratch.
      expect(read("t1").assignee).toBeUndefined();
      expect(read("t1").labels ?? []).not.toContain(LABELS.approved);
    });

    it("takes its writes back when the project is disarmed while the review queue is checked", async () => {
      // The window the WIP check itself opens (PR #218 review): confirming a full queue is a `gh pr
      // view` per waiting PR, minutes wide at its ceiling, and a breaker tripping inside it would
      // otherwise fall straight through to the enqueue.
      put(bead("t1"));

      const outcome = await apply("t1", 1, wired(), {
        held: async () => {
          await freeze();
          return undefined;
        },
      });

      expect(outcome).toMatchObject({ skipped: { beadId: "t1", wroteBoard: false } });
      expect(why(outcome)).toContain("disarmed");
      expect(await jobs()).toHaveLength(0);
      expect(notes).toEqual([]);
      expect(read("t1").assignee).toBeUndefined();
      expect(read("t1").labels ?? []).not.toContain(LABELS.approved);
    });
  });

  describe("the flow brake behind the start", () => {
    const why = (outcome: unknown) => (outcome as { skipped: { reason: string } }).skipped.reason;
    const FULL = "3 open PRs are waiting on review — this project pauses new work at 3";

    it("takes its writes back when the review queue fills while the claim settles", async () => {
      // The hold is derived, never latched, so the verdict the caller cleared this pass against goes
      // stale the moment another run reaches `stage:in-review` — or the operator lowers the limit.
      put(bead("t1"));
      let full = false;

      const outcome = await apply(
        "t1",
        1,
        wired({
          sleep: async () => {
            full = true;
          },
        }),
        { held: async () => (full ? FULL : undefined) },
      );

      expect(outcome).toMatchObject({ skipped: { beadId: "t1", wroteBoard: false } });
      expect(why(outcome)).toContain("waiting on review");
      expect(await jobs()).toHaveLength(0);
      expect(notes).toEqual([]);
      // Reversible, like every other late refusal: the target is startable again on the pass after
      // the operator's next merge.
      expect(read("t1").assignee).toBeUndefined();
      expect(read("t1").labels ?? []).not.toContain(LABELS.approved);
    });

    it("judges the queue against the board the settle just read, then against the refreshed one", async () => {
      // The freshest board this pass holds, handed over rather than re-read: a second `bd list` at
      // the same instant could only cost a round trip to say the same thing. And once more against
      // the read taken on the far side of the confirmation, which is the only board that can show a
      // slot taken while those PRs were checked.
      put(bead("t1"));
      const seen: (Bead[] | undefined)[] = [];

      const outcome = await apply("t1", 1, wired(), {
        held: async (board) => {
          seen.push(board);
          return undefined;
        },
      });

      expect(outcome).toMatchObject({ started: { beadId: "t1" } });
      expect(seen).toHaveLength(2);
      expect(seen[0]?.map((b) => b.id)).toEqual(["t1"]);
      expect(seen[1]?.map((b) => b.id)).toEqual(["t1"]);
    });

    it("takes its writes back when the queue fills while its own PRs are confirmed", async () => {
      // The window the confirmation itself opens (PR #218 review): another run reaching
      // `stage:in-review` inside it fills the slot the first verdict cleared this pass into, so the
      // brake is re-asked against the read taken after that confirmation rather than trusted from
      // before it.
      put(bead("t1"));
      let asked = 0;

      const outcome = await apply("t1", 1, wired(), {
        held: async () => {
          asked += 1;
          return asked === 1 ? undefined : FULL;
        },
      });

      expect(asked).toBe(2);
      expect(outcome).toMatchObject({ skipped: { beadId: "t1", wroteBoard: false } });
      expect(why(outcome)).toContain("waiting on review");
      expect(await jobs()).toHaveLength(0);
      expect(notes).toEqual([]);
      expect(read("t1").assignee).toBeUndefined();
      expect(read("t1").labels ?? []).not.toContain(LABELS.approved);
    });

    it("enqueues nothing when the reservation changes hands while the queue is checked", async () => {
      // The final read observes the ownership change; every gate below it judges the target with the
      // claim CLEARED, so without this assertion the pass would read the loss and start anyway
      // (PR #218 review) — a second run on another machine's reservation.
      put(bead("t1"));

      const outcome = await apply("t1", 1, wired(), {
        held: async () => {
          board.current.get("t1")!.assignee = "other-box";
          return undefined;
        },
      });

      expect(outcome).toMatchObject({
        skipped: { beadId: "t1", reason: "other-box claimed it first", wroteBoard: true },
      });
      expect(await jobs()).toHaveLength(0);
      expect(notes).toEqual([]);
      // Not ours to unwind, exactly as after a lost merge: the approval belongs to the holder now.
      expect(read("t1").assignee).toBe("other-box");
      expect(read("t1").labels ?? []).toContain(LABELS.approved);
    });

    it("enqueues nothing when the reservation changes hands while the SECOND confirmation runs", async () => {
      // The window the re-ask itself opens (PR #218 review). That second call can block for exactly
      // as long as the first — a `gh pr view` per waiting PR — so the board it was handed is stale by
      // the time it clears, and a pass judging ownership off it would enqueue a run against another
      // machine's reservation. The gates below it therefore judge a read taken on its far side.
      put(bead("t1"));
      let asked = 0;

      const outcome = await apply("t1", 1, wired(), {
        held: async () => {
          asked += 1;
          if (asked === 2) board.current.get("t1")!.assignee = "other-box";
          return undefined;
        },
      });

      expect(asked).toBe(2);
      expect(outcome).toMatchObject({
        skipped: { beadId: "t1", reason: "other-box claimed it first", wroteBoard: true },
      });
      expect(await jobs()).toHaveLength(0);
      expect(notes).toEqual([]);
      // Not ours to unwind, exactly as after a lost merge: the approval belongs to the holder now.
      expect(read("t1").assignee).toBe("other-box");
      expect(read("t1").labels ?? []).toContain(LABELS.approved);
    });

    it("re-asks the brake when a run joins the review queue while the SECOND confirmation runs", async () => {
      // The slot the re-ask itself can age behind (PR #218 review). That second call confirms a `gh
      // pr view` per waiting PR; a run reaching `stage:in-review` inside it fills the very slot the
      // verdict cleared, and the read on its far side is the only thing that can see the new
      // occupant. Answering from the verdict alone would enqueue past the operator's limit.
      put(bead("t1"));
      let asked = 0;

      const outcome = await apply("t1", 1, wired(), {
        held: async () => {
          asked += 1;
          if (asked === 2) put(inReview("t2", 41));
          return asked >= 3 ? FULL : undefined;
        },
      });

      expect(asked).toBe(3);
      expect(outcome).toMatchObject({ skipped: { beadId: "t1", wroteBoard: false } });
      expect(why(outcome)).toContain("waiting on review");
      expect(await jobs()).toHaveLength(0);
      expect(notes).toEqual([]);
      expect(read("t1").assignee).toBeUndefined();
      expect(read("t1").labels ?? []).not.toContain(LABELS.approved);
    });

    it("stops re-asking once the queue adds nothing the standing verdict has not judged", async () => {
      // The other side of that loop: confirming can only SHRINK the queue, so a read that adds no
      // occupant is one the verdict already covers and the pass starts on it. Bounded by the board,
      // not by a fixed number of asks — a settled queue costs exactly one extra verdict, and only
      // the pass that actually saw a slot taken pays for it.
      put(bead("t1"));
      let asked = 0;

      const outcome = await apply("t1", 1, wired(), {
        held: async () => {
          asked += 1;
          if (asked === 2) put(inReview("t2", 41));
          return undefined;
        },
      });

      expect(asked).toBe(3);
      expect(outcome).toMatchObject({ started: { beadId: "t1" } });
      expect(await jobs()).toHaveLength(1);
    });

    it("re-asks the brake when an in-review target is relinked to a NEW PR", async () => {
      // A slot is a (target, PR) pair, not a target (PR #218 review): relinking t2 from the merged
      // PR the verdict cleared to a fresh open one keeps its bead id, so an id-only comparison would
      // report no drift and spend a verdict that judged the OLD reference — while the new PR sits in
      // the queue uncounted and the pass enqueues past the operator's limit.
      put(bead("t1"), inReview("t2", 41));
      let asked = 0;

      const outcome = await apply("t1", 1, wired(), {
        held: async () => {
          asked += 1;
          if (asked === 2) put(inReview("t2", 42));
          return asked >= 3 ? FULL : undefined;
        },
      });

      expect(asked).toBe(3);
      expect(outcome).toMatchObject({ skipped: { beadId: "t1", wroteBoard: false } });
      expect(why(outcome)).toContain("waiting on review");
      expect(await jobs()).toHaveLength(0);
    });

    it("re-asks the brake when the operator lowers the limit while the SECOND confirmation runs", async () => {
      // The verdict's other input, and the one no board read can fault (PR #218 review): the limit is
      // resolved when the brake is ASKED, ahead of its `gh pr view` per waiting PR, so an operator
      // lowering it inside that confirmation leaves a verdict judged against a rule the project no
      // longer has — with nothing new in the queue for `filledSince` to catch.
      put(bead("t1"));
      let asked = 0;

      const outcome = await apply("t1", 1, wired(), {
        held: async () => {
          asked += 1;
          if (asked === 2) setWipLimit(1);
          return asked >= 3 ? FULL : undefined;
        },
      });

      expect(asked).toBe(3);
      expect(outcome).toMatchObject({ skipped: { beadId: "t1", wroteBoard: false } });
      expect(why(outcome)).toContain("waiting on review");
      expect(await jobs()).toHaveLength(0);
      expect(notes).toEqual([]);
      expect(read("t1").assignee).toBeUndefined();
      expect(read("t1").labels ?? []).not.toContain(LABELS.approved);
    });

    it("starts once the brake re-asked on the moved limit clears", async () => {
      // The other side of that reconciliation: a limit the operator RAISED costs exactly one extra
      // verdict, and the pass starts on it. The re-ask is what makes the start rest on the setting
      // the project has now rather than the one it had when the confirmation began.
      put(bead("t1"));
      let asked = 0;

      const outcome = await apply("t1", 1, wired(), {
        held: async () => {
          asked += 1;
          if (asked === 2) setWipLimit(9);
          return undefined;
        },
      });

      expect(asked).toBe(3);
      expect(outcome).toMatchObject({ started: { beadId: "t1" } });
      expect(await jobs()).toHaveLength(1);
    });

    it("stands down when the limit keeps moving under the confirmation", async () => {
      // Bounded like the queue half, and worded for its own cause: a setting nobody can pin down is
      // not a queue that keeps filling, and the operator reading the skip has to be able to tell
      // which of the two it was.
      put(bead("t1"));
      let limit = 3;

      const outcome = await apply("t1", 1, wired(), {
        held: async () => undefined,
        wipLimit: async () => limit--,
      });

      expect(outcome).toMatchObject({ skipped: { beadId: "t1", wroteBoard: false } });
      expect(why(outcome)).toContain("limit kept changing");
      expect(await jobs()).toHaveLength(0);
      expect(read("t1").assignee).toBeUndefined();
      expect(read("t1").labels ?? []).not.toContain(LABELS.approved);
    });

    it("takes its writes back when the limit cannot be read at all", async () => {
      // Fails closed like every other unreadable answer in this window: a start cannot be taken
      // back, and a stand-down leaves the target startable next cadence.
      put(bead("t1"));

      const outcome = await apply("t1", 1, wired(), { wipLimit: async () => undefined });

      expect(outcome).toMatchObject({ skipped: { beadId: "t1", wroteBoard: false } });
      expect(why(outcome)).toContain("review limit could not be read");
      expect(await jobs()).toHaveLength(0);
      expect(notes).toEqual([]);
      expect(read("t1").assignee).toBeUndefined();
      expect(read("t1").labels ?? []).not.toContain(LABELS.approved);
    });

    it("stands down when the review queue fills faster than it can be confirmed", async () => {
      // The loop cannot chase a queue that grows under every confirmation, and a start is the one
      // thing here that cannot be taken back — so it fails closed rather than spinning `gh` at it.
      // The target is startable again next cadence.
      put(bead("t1"));
      let asked = 0;

      const outcome = await apply("t1", 1, wired(), {
        held: async () => {
          asked += 1;
          if (asked >= 2) put(inReview(`t${asked}`, 40 + asked));
          return undefined;
        },
      });

      expect(asked).toBe(3);
      expect(outcome).toMatchObject({ skipped: { beadId: "t1", wroteBoard: false } });
      expect(why(outcome)).toContain("kept filling");
      expect(await jobs()).toHaveLength(0);
      expect(notes).toEqual([]);
      expect(read("t1").assignee).toBeUndefined();
      expect(read("t1").labels ?? []).not.toContain(LABELS.approved);
    });

    it("takes its writes back when the target stops being startable while the SECOND confirmation runs", async () => {
      // The board-derived half of that same window: blocked, closed, or labelled `agent:human` while
      // the re-ask confirmed its PRs. Only the read on its far side can see it.
      put(bead("t1"));
      let asked = 0;

      const outcome = await apply("t1", 1, wired(), {
        held: async () => {
          asked += 1;
          if (asked === 2) {
            const b = board.current.get("t1")!;
            b.labels = [...((b.labels as string[]) ?? []), LABELS.agentHuman];
          }
          return undefined;
        },
      });

      expect(asked).toBe(2);
      expect(outcome).toMatchObject({ skipped: { beadId: "t1", wroteBoard: false } });
      expect(why(outcome)).toContain("stopped being startable");
      expect(await jobs()).toHaveLength(0);
      expect(notes).toEqual([]);
      expect(read("t1").assignee).toBeUndefined();
      expect(read("t1").labels ?? []).not.toContain(LABELS.approved);
    });

    it("takes its approval back when its claim is CLEARED while the queue is checked", async () => {
      // The other half of the same loss: a human clearing the assignee leaves the target unowned,
      // which the cleared-claim projection below cannot tell from a target this pass still holds.
      // And unlike a claim another worker WON, nothing is running on the approval this pass wrote —
      // left standing it would publish an approved, unassigned target, which is exactly what the
      // next worker starts on (PR #218 review).
      put(bead("t1"));

      const outcome = await apply("t1", 1, wired(), {
        held: async () => {
          board.current.get("t1")!.assignee = undefined;
          return undefined;
        },
      });

      expect(outcome).toMatchObject({ skipped: { beadId: "t1", wroteBoard: false } });
      expect(why(outcome)).toContain("released while the review queue was confirmed");
      expect(await jobs()).toHaveLength(0);
      expect(notes).toEqual([]);
      expect(read("t1").assignee).toBeUndefined();
      expect(read("t1").labels ?? []).not.toContain(LABELS.approved);
    });

    it("takes its writes back when the target stops being startable while the queue is checked", async () => {
      // The board-derived half of the same window (PR #218 review): confirming a full queue is a
      // `gh pr view` per waiting PR, and another client can block the target, close it or label it
      // `agent:human` inside it. Judged off the snapshot the confirmation began with, the pass would
      // enqueue work that is no longer claimable — so the board is re-read on its far side.
      put(bead("t1"));

      const outcome = await apply("t1", 1, wired(), {
        held: async () => {
          const b = board.current.get("t1")!;
          b.labels = [...((b.labels as string[]) ?? []), LABELS.agentHuman];
          return undefined;
        },
      });

      expect(outcome).toMatchObject({ skipped: { beadId: "t1", wroteBoard: false } });
      expect(why(outcome)).toContain("stopped being startable");
      expect(await jobs()).toHaveLength(0);
      expect(notes).toEqual([]);
      expect(read("t1").assignee).toBeUndefined();
      expect(read("t1").labels ?? []).not.toContain(LABELS.approved);
    });

    it("takes its writes back when the approval is withdrawn while the queue is checked", async () => {
      // The label the eligibility rule never asks about, over the same window: withdrawn mid-check,
      // the run it would buy only poison-parks as unapproved.
      put(bead("t1"));

      const outcome = await apply("t1", 1, wired(), {
        held: async () => {
          const b = board.current.get("t1")!;
          b.labels = ((b.labels as string[]) ?? []).filter((l) => l !== LABELS.approved);
          return undefined;
        },
      });

      expect(outcome).toMatchObject({ skipped: { beadId: "t1" } });
      expect(why(outcome)).toContain("approval was withdrawn");
      expect(await jobs()).toHaveLength(0);
      expect(read("t1").assignee).toBeUndefined();
    });

    it("takes its writes back when the picker is moved off apply while the queue is checked", async () => {
      // The stance is re-asked on the FAR side of the WIP check, not only before it (PR #218 review):
      // that check is the longest await in the window, and an operator stepping back to `shadow`
      // inside it has withdrawn the standing approval this start rests on.
      put(bead("t1"));

      const outcome = await apply("t1", 1, wired(), {
        held: async () => {
          arm({}, "shadow");
          return undefined;
        },
      });

      expect(outcome).toMatchObject({ skipped: { beadId: "t1", wroteBoard: false } });
      expect(why(outcome)).toContain("no longer apply");
      expect(await jobs()).toHaveLength(0);
      expect(notes).toEqual([]);
      expect(read("t1").assignee).toBeUndefined();
      expect(read("t1").labels ?? []).not.toContain(LABELS.approved);
    });

    it("takes its writes back when the policy is narrowed while the queue is checked", async () => {
      // The other half of the stance, over the same window: a criterion that stops admitting the
      // target mid-check is the standing approval narrowing past it.
      put(bead("t1", { issue_type: "task" }));

      const outcome = await apply("t1", 1, wired(), {
        held: async () => {
          arm({ types: ["bug"] });
          return undefined;
        },
      });

      expect(outcome).toMatchObject({ skipped: { beadId: "t1" } });
      expect(why(outcome)).toContain("no longer admits it");
      expect(read("t1").assignee).toBeUndefined();
    });
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

    const outcome = await apply("t1", 1, undefined, {
      run: {
        enqueueIfAbsent: (projectId, epicBeadId) =>
          enqueueExecuteEpicIfAbsent(t.db, clock, projectId, epicBeadId),
        // The job CAS loses: the concurrent settle `resumeJob`'s guarded UPDATE exists to catch —
        // an operator's cancel taking the covering row between the pick and the write.
        resume: async () => false,
      },
    });

    expect(outcome).toMatchObject({
      // Nothing of this pass's is left on the board, so the caller's plan still reads current.
      skipped: {
        beadId: "t1",
        reason: "no run could be started for this target",
        wroteBoard: false,
      },
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
    const broken = brokenDb();

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
    // An unwind that could not finish leaves writes behind, and the caller's plan is stale with them.
    expect(outcome).toMatchObject({ skipped: { wroteBoard: true } });
    expect(read("t1").labels).toContain(LABELS.approved);
    expect(read("t1").assignee).toBe("anton-box");
  });

  describe("cancellation", () => {
    // The pass's own signal, carried THROUGH the apply (PR #218 review). A cancel here is
    // `abortProject`: the project's rows are being deleted, so anything this pass wrote to the real
    // board has to come back off rather than outlive the project it was written for.

    it("writes nothing at all when the pass is already cancelled", async () => {
      put(bead("t1"));

      const outcome = await apply("t1", 1, undefined, { signal: AbortSignal.abort() });

      expect(outcome).toMatchObject({
        skipped: { beadId: "t1", reason: "the pass was cancelled before it claimed anything" },
      });
      // Not even the mirror refresh: the stand-down is before the CAS, so nothing was read or written.
      expect(pulls).toBe(0);
      expect(read("t1").labels ?? []).not.toContain(LABELS.approved);
      expect(read("t1").assignee).toBeUndefined();
      expect(await jobs()).toHaveLength(0);
    });

    it("takes its writes back when the cancel lands while the claim settles", async () => {
      // The window the pre-call gate cannot cover: the label and the claim are already on the board
      // when teardown starts, and the enqueue that would justify them has not happened yet.
      put(bead("t1"));
      const controller = new AbortController();

      const outcome = await apply("t1", 1, wired({ sleep: async () => controller.abort() }), {
        signal: controller.signal,
      });

      expect(outcome).toMatchObject({ skipped: { beadId: "t1" } });
      expect((outcome as { skipped: { reason: string } }).skipped.reason).toContain(
        "cancelled before its run was enqueued",
      );
      expect(read("t1").assignee).toBeUndefined();
      expect(read("t1").labels ?? []).not.toContain(LABELS.approved);
      expect(await jobs()).toHaveLength(0);
      expect(notes).toEqual([]);
      expect(nudgeSync).toHaveBeenCalled();
    });

    it("takes its writes back when the cancel lands while the brakes are re-asked", async () => {
      // The seam the settle-window gate cannot cover (PR #218 review): the freeze and the WIP hold
      // are two more awaits AFTER it, and a hold that answers "no hold" would otherwise fall
      // straight into the enqueue — where the post-insert sweep check keeps a run it finds active.
      put(bead("t1"));
      const controller = new AbortController();

      const outcome = await apply("t1", 1, wired(), {
        signal: controller.signal,
        held: async () => {
          controller.abort();
          return undefined;
        },
      });

      expect(outcome).toMatchObject({ skipped: { beadId: "t1" } });
      expect((outcome as { skipped: { reason: string } }).skipped.reason).toContain(
        "cancelled before its run was enqueued",
      );
      expect(read("t1").assignee).toBeUndefined();
      expect(read("t1").labels ?? []).not.toContain(LABELS.approved);
      expect(await jobs()).toHaveLength(0);
      expect(notes).toEqual([]);
    });

    it("takes its writes back when teardown deleted the run it had just enqueued", async () => {
      // The far side of the insert: `abortProject` sweeps the project's rows, and the row it deletes
      // is this pass's own. Left standing, the approval and the claim would cover nothing.
      put(bead("t1"));
      const controller = new AbortController();

      const outcome = await apply("t1", 1, undefined, {
        signal: controller.signal,
        run: {
          enqueueIfAbsent: () => {
            controller.abort();
            return "job-swept-by-teardown";
          },
          resume: async () => false,
        },
      });

      expect(outcome).toMatchObject({ skipped: { beadId: "t1" } });
      expect((outcome as { skipped: { reason: string } }).skipped.reason).toContain(
        "cancelled and its run removed with it",
      );
      expect(read("t1").assignee).toBeUndefined();
      expect(read("t1").labels ?? []).not.toContain(LABELS.approved);
      expect(notes).toEqual([]);
    });

    it("takes its writes back when teardown deleted the run while the audit line was writing", async () => {
      // The same sweep, one await later (PR #218 review): the note and the start log are two more
      // windows for `abortProject` to delete the row, and a start reported over a run that no longer
      // exists is the leftover the post-insert check was added to prevent.
      put(bead("t1"));
      const controller = new AbortController();
      vi.spyOn(beads, "note").mockImplementation(async () => {
        controller.abort();
        await t.db.delete(schema.jobs);
        return "";
      });

      const outcome = await apply("t1", 1, undefined, { signal: controller.signal });

      expect(outcome).toMatchObject({ skipped: { beadId: "t1" } });
      expect((outcome as { skipped: { reason: string } }).skipped.reason).toContain(
        "cancelled and its run removed with it",
      );
      expect(read("t1").assignee).toBeUndefined();
      expect(read("t1").labels ?? []).not.toContain(LABELS.approved);
      expect(await listPickerStarts(t.db, "p1")).toEqual([]);
    });

    it("keeps its writes when the cancel spared the run it enqueued", async () => {
      // Not every cancel is a teardown: a runner stop leaves the queued row behind, and the approval
      // and the claim are exactly what that run needs when it is re-leased.
      put(bead("t1"));
      const controller = new AbortController();

      const outcome = await apply("t1", 1, undefined, {
        signal: controller.signal,
        run: {
          enqueueIfAbsent: (projectId, epicBeadId) => {
            const id = enqueueExecuteEpicIfAbsent(t.db, clock, projectId, epicBeadId);
            controller.abort();
            return id;
          },
          resume: async () => false,
        },
      });

      expect(outcome).toMatchObject({ started: { beadId: "t1" } });
      expect(read("t1").assignee).toBe("anton-box");
      expect(read("t1").labels).toContain(LABELS.approved);
      expect(await jobs()).toHaveLength(1);
    });

    it("hands back a re-check that unwinds when teardown deletes the run after it returned", async () => {
      // The window this module cannot close from the inside (PR #218 review): the caller spends a
      // board read of its own restamping the plan once this returns, and `abortProject` landing in
      // there sweeps the row just enqueued. The seam check is handed back so that window unwinds
      // through the same path every earlier one does.
      put(bead("t1"));
      const controller = new AbortController();
      const outcome = await apply("t1", 1, undefined, { signal: controller.signal });
      expect(outcome).toMatchObject({ started: { beadId: "t1" } });

      // Teardown, inside the caller's restamp.
      controller.abort();
      await t.db.delete(schema.jobs);
      const swept = await (outcome as { confirmStart: ConfirmStart }).confirmStart();

      expect(swept).toMatchObject({
        skipped: { beadId: "t1", reason: expect.stringContaining("run removed with it") },
      });
      expect(read("t1").assignee).toBeUndefined();
      expect(read("t1").labels ?? []).not.toContain(LABELS.approved);
    });

    it("re-confirms a start whose run outlived the caller's awaits", async () => {
      // The common case: nothing was cancelled, so the re-check costs one lookup and the start
      // stands exactly as reported.
      put(bead("t1"));
      const outcome = await apply("t1");

      expect(await (outcome as { confirmStart: ConfirmStart }).confirmStart()).toBeUndefined();
      expect(read("t1").assignee).toBe("anton-box");
      expect(await jobs()).toHaveLength(1);
    });

    it("takes its writes back when the enqueue is refused for a project being deleted", async () => {
      // The quiesce barrier the runner's verbs add: a raw db-direct insert would strand an
      // execute-epic row in a project mid-teardown, and the bead approved and claimed beside it.
      put(bead("t1"));
      const error = vi.spyOn(console, "error").mockImplementation(() => {});

      const outcome = await apply("t1", 1, undefined, {
        run: {
          enqueueIfAbsent: () => {
            throw new Error("Project is being deleted: p1");
          },
          resume: async () => false,
        },
      });

      expect(outcome).toMatchObject({
        skipped: { beadId: "t1", reason: "the run could not be enqueued" },
      });
      expect(read("t1").assignee).toBeUndefined();
      expect(read("t1").labels ?? []).not.toContain(LABELS.approved);
      expect(await jobs()).toHaveLength(0);
      error.mockRestore();
    });
  });
});

/**
 * The flow brake's own re-check (PR #218 review) — the default the scheduled pass hands down.
 *
 * The arithmetic is pinned in autopilot-wip.test.ts and the join in picker-wip-hold.test.ts; what is
 * pinned here is the wording the apply stands down on, and that an unreadable queue fails CLOSED.
 */
describe("pickerWipHold", () => {
  const IN_REVIEW = LABELS.stage("in-review");

  /** An open run target in review, pointing at its PR — one occupied slot in the operator's queue. */
  function inReview(id: string, prNumber: number): Bead {
    return {
      id,
      title: id,
      status: "open",
      issue_type: "feature",
      labels: [IN_REVIEW],
      metadata: { pr: `gh-${prNumber}` },
    };
  }

  const open = async (_repo: string, number: number) => ({
    number,
    state: "OPEN",
    url: `https://example.test/pull/${number}`,
    updatedAtMs: 0,
    isDraft: false,
  });

  it("reports the hold in the copy every other surface shows it in", async () => {
    const held = pickerWipHold(t.db, {
      projectId: "p1",
      repoPath: REPO,
      readPrActivity: open,
    });

    const reason = await held([inReview("a", 11), inReview("b", 12), inReview("c", 13)]);

    expect(reason).toContain("pauses new work at 3");
    expect(reason).toContain("#11, #12, #13");
  });

  it("clears the start while the operator still has review bandwidth", async () => {
    const held = pickerWipHold(t.db, {
      projectId: "p1",
      repoPath: REPO,
      readPrActivity: open,
    });

    expect(await held([inReview("a", 11), inReview("b", 12)])).toBeUndefined();
  });

  it("reads its own board when the caller has none to hand over", async () => {
    put(inReview("a", 11), inReview("b", 12), inReview("c", 13));
    const held = pickerWipHold(t.db, {
      projectId: "p1",
      repoPath: REPO,
      readPrActivity: open,
    });

    expect(await held()).toContain("pauses new work at 3");
  });

  it("fails closed when the queue cannot be read at all", async () => {
    // A stand-down is reversible and a start is not, so an unanswerable brake refuses — the same
    // direction the pre-CAS refresh fails in.
    vi.mocked(loadAllIssues).mockRejectedValueOnce(new Error("bd is down"));
    const held = pickerWipHold(t.db, { projectId: "p1", repoPath: REPO, readPrActivity: open });

    expect(await held()).toContain("could not be checked before starting");
  });
});
