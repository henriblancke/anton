/**
 * The board-picker handler (anton-albm): one pass = one board read, one decision, one recorded plan.
 *
 * The decision itself is pinned in picker-decision.test.ts. What is pinned here is the WIRING — that
 * arming the schedule actually produces a row a surface can read, at the job that produced it, and
 * that two overlapping passes leave one plan rather than two. A pass that resolved without writing
 * would be indistinguishable from an armed schedule that never fired.
 */
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import type { TestDb } from "../db/testing";
import * as schema from "../db/schema";
import { getBoardPickerPlan, isPlanStale, stampBoard } from "../board-picker-plan";
import { PICKER_DEFER_WINDOW_MS, recordPickerVeto } from "../picker-veto";
import { EARNED_AUTONOMY_BARS, PICKER_AUTONOMY_TIER } from "../gardener/autonomy";
import { activeDisarm, listDisarms, reArmAutopilot } from "../autopilot-disarm";
import { listOpenEscalations } from "../escalations";
import { LABELS } from "../beads/bd";
import type { PrActivity } from "../git/pr";
import type { Bead } from "../beads/types";
import { loadAllIssues } from "../beads/issues";
import { PoisonError } from "./errors";
import type { Clock } from "./queue";
import type { JobContext } from "./runner";
import { makeBoardPickerHandler } from "./board-picker";
import type { PickerApplyInput, PickerApplyOutcome } from "./picker-apply";
import { makeProjectDb } from "@/lib/testing/project";

const board = vi.hoisted(() => ({ current: [] as Bead[], calls: [] as unknown[][] }));
vi.mock("../beads/issues", () => ({
  loadAllIssues: vi.fn(async (...args: unknown[]) => {
    board.calls.push(args);
    return board.current;
  }),
}));

/**
 * The apply step is mocked, not driven: what this suite pins is the GATING — which passes reach a
 * start at all — while what a start writes is picker-apply.test.ts's (and the e2e's).
 */
const applyPickerPlan = vi.hoisted(() =>
  vi.fn<(input: PickerApplyInput) => Promise<PickerApplyOutcome>>(async () => ({
    skipped: { reason: "stubbed" },
  })),
);
vi.mock("./picker-apply", () => ({ applyPickerPlan }));

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

/** Just the pass's hold lines — other modules log to console.info too. */
function holdLines(spy: MockInstance<typeof console.info>): string[] {
  return spy.mock.calls.map((args) => String(args[0])).filter((line) => line.includes("holding"));
}

/** Three failed runs, an hour apart and all settled before `NOW` — a streak at the default 3. */
function threeFailedRuns(t: TestDb): void {
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
}

/** A `gh pr view` stand-in for the WIP hold's PR confirmation. */
function prActivity(number: number, state: string): PrActivity {
  return { number, state, url: `https://example.test/pull/${number}`, updatedAtMs: 0, isDraft: false };
}

/**
 * A db that trips `controller` on the plan write — the one instant between the write's own signal
 * gate and the start, which is the window an abort has to be re-checked in.
 */
function abortOnPlanWrite(db: TestDb["db"], controller: AbortController): TestDb["db"] {
  return new Proxy(db, {
    get(target, prop) {
      const value = Reflect.get(target, prop) as unknown;
      if (typeof value !== "function") return value;
      const fn = value as (...args: unknown[]) => unknown;
      if (prop !== "insert") return fn.bind(target);
      return (...args: unknown[]) => {
        controller.abort();
        return fn.apply(target, args);
      };
    },
  }) as TestDb["db"];
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

/**
 * Arm the project: a policy, the autonomy level that lets a pass act on it, and — at `apply` — the
 * accept/veto record that level has to be EARNED on (anton-vkp9). All three are what "armed" means
 * to the pass, so a test about the brakes does not have to restate the gate it is not testing.
 */
function arm(
  t: TestDb,
  autonomy: string,
  { policy = { types: ["task"] } as unknown, record = true }: { policy?: unknown; record?: boolean } = {},
): void {
  t.db
    .update(schema.projects)
    .set({ settingsJson: JSON.stringify({ pickerPolicy: policy, pickerAutonomy: autonomy }) })
    .run();
  if (record) answerPicks(t, PICKER_BAR.minSettled, PICKER_BAR.minSettled);
}

/** The bar the picker's own record clears — read off the shared ladder, never restated here. */
const PICKER_BAR = EARNED_AUTONOMY_BARS[PICKER_AUTONOMY_TIER];

/**
 * `settled` answered picks, `accepted` of them released — the operator's record, written where the
 * release route and the veto route write it.
 */
function answerPicks(t: TestDb, settled: number, accepted: number): void {
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

let t: TestDb;
beforeEach(() => {
  board.current = [];
  board.calls = [];
  applyPickerPlan.mockClear();
  t = makeProjectDb({ id: "p1", slug: "p1", name: "p1", repoPath: "/tmp/p1" });
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

  // A pass ALWAYS writes a plan row, so the write is not the effect — the ranking is. An empty
  // board makes every ten-minute slot look like work if the two are conflated (anton-znoz).
  it("reports a ranked plan as work done and an empty one as nothing to do", async () => {
    board.current = [bead("t1", { priority: 2 })];
    expect(await makeBoardPickerHandler({ db: t.db, clock })(fakeCtx())).toEqual({
      changed: true,
      note: "ranked 1 target(s)",
    });

    board.current = [];
    expect(await makeBoardPickerHandler({ db: t.db, clock })(fakeCtx())).toEqual({
      changed: false,
      note: "nothing claimable to rank",
    });
  });

  it("keeps a vetoed target out of the NEXT pass's plan, until its window closes", async () => {
    // R3.9 end to end: the operator's veto is stored, the next pass reads it, and the target leaves
    // the plan — named as deferred, not silently absent — until the bounded window runs out.
    board.current = [bead("t1", { priority: 0 }), bead("t2", { priority: 1 })];
    const run = makeBoardPickerHandler({ db: t.db, clock });

    await run(fakeCtx());
    expect((await getBoardPickerPlan(t.db, "p1"))?.entries.map((e) => e.beadId)).toEqual([
      "t1",
      "t2",
    ]);

    await recordPickerVeto(t.db, clock, { projectId: "p1", beadId: "t1", action: "not-now" });

    await run(fakeCtx());
    const after = await getBoardPickerPlan(t.db, "p1");
    expect(after?.entries.map((e) => e.beadId)).toEqual(["t2"]);
    expect(after?.exclusions.find((e) => e.beadId === "t1")?.reason).toBe("deferred");

    // Past the window the pass offers it again — the hold expires on its own, and nothing about the
    // veto is a per-bead blocklist.
    const later: Clock = { now: () => NOW + PICKER_DEFER_WINDOW_MS + 1000 };
    await makeBoardPickerHandler({ db: t.db, clock: later })(fakeCtx());
    expect((await getBoardPickerPlan(t.db, "p1"))?.entries.map((e) => e.beadId)).toEqual([
      "t1",
      "t2",
    ]);
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

  it("starts NOTHING when the abort lands after the plan is written", async () => {
    // The plan write's own gate is not enough: `abortProject` aborts this pass AND deletes the
    // project's queued rows, so a start that ran in the window after it would write `approved` and a
    // claim to the real board and insert a job the teardown then trips over.
    board.current = [bead("t1")];
    arm(t, "apply");
    const controller = new AbortController();

    await expect(
      makeBoardPickerHandler({ db: abortOnPlanWrite(t.db, controller), clock })(
        fakeCtx({ signal: controller.signal }),
      ),
    ).rejects.toThrow();

    expect(applyPickerPlan).not.toHaveBeenCalled();
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

  it("narrows the plan with the policy the operator armed", async () => {
    // The settings panel says an accepted policy is what anton may start on; a plan that still
    // admitted everything would advertise a boundary anton does not keep.
    t.db
      .update(schema.projects)
      .set({ settingsJson: JSON.stringify({ pickerPolicy: { types: ["bug"] } }) })
      .run();
    board.current = [bead("t1", { issue_type: "bug" }), bead("t2", { issue_type: "task" })];

    await makeBoardPickerHandler({ db: t.db, clock })(fakeCtx());

    const plan = await getBoardPickerPlan(t.db, "p1");
    expect(plan?.entries.map((e) => e.beadId)).toEqual(["t1"]);
    // The refusal stays answerable: it is the policy's, not the board's, and it names the criterion.
    const refused = plan?.exclusions.find((e) => e.beadId === "t2");
    expect(refused?.reason).toBe("policy");
    expect(refused?.detail).toContain("the policy admits only bug");
  });

  it("keeps the structural default on a project that has armed nothing", async () => {
    board.current = [bead("t1", { issue_type: "task" })];

    await makeBoardPickerHandler({ db: t.db, clock })(fakeCtx());

    const plan = await getBoardPickerPlan(t.db, "p1");
    expect(plan?.entries).toEqual([{ beadId: "t1", rank: 1, rule: "any claimable run target" }]);
  });

  it("disarms the project when its recent runs are a streak of failures, and still ranks", async () => {
    // The brake and the ranking are different jobs: the pass starts nothing, so the plan stays
    // useful reading while the latch is what the arming step refuses on (R4.4 / R1.5).
    board.current = [bead("t1")];
    threeFailedRuns(t);

    await makeBoardPickerHandler({ db: t.db, clock })(fakeCtx());

    const disarm = await activeDisarm(t.db, "p1");
    expect(disarm?.reason).toBe("consecutive-failures");
    expect(disarm?.evidence).toHaveLength(3);
    expect((await getBoardPickerPlan(t.db, "p1"))?.entries.map((e) => e.beadId)).toEqual(["t1"]);
    // The freeze is also in the "Needs you" strip, carrying the same case (R4.6).
    expect(await listOpenEscalations(t.db, "p1")).toHaveLength(1);
  });

  it("leaves the project armed on the next pass once the operator re-arms it", async () => {
    // The other half of "a disarmed picker stays disarmed until re-armed": a re-arm has to STICK.
    // Nothing new has run, so the same three failures are still the most recent evidence — a pass
    // that re-read them would re-latch within one cadence and silently overrule the operator.
    board.current = [bead("t1")];
    threeFailedRuns(t);
    const pass = makeBoardPickerHandler({ db: t.db, clock });

    await pass(fakeCtx());
    expect(await reArmAutopilot(t.db, clock, { projectId: "p1", actor: "ops" })).toMatchObject({
      ok: true,
    });

    await pass(fakeCtx());

    expect(await activeDisarm(t.db, "p1")).toBeUndefined();
    // One freeze in the whole history, and no second row in the strip to clear.
    expect(await listDisarms(t.db, "p1")).toHaveLength(1);
    expect(await listOpenEscalations(t.db, "p1")).toHaveLength(0);
  });

  it("disarms the project when its delivered runs keep scoring below the floor", async () => {
    // The other quality brake (R4.3): these runs all DELIVERED, so the failure breaker sees nothing
    // — what stops the picker is the trend in what they shipped.
    const targets = ["anton-a", "anton-b", "anton-c"];
    board.current = [bead("t1"), ...targets.map((id) => bead(id, { status: "closed" }))];
    for (const [i, id] of targets.entries()) {
      const at = new Date(NOW - (3 - i) * 3_600_000);
      t.db
        .insert(schema.runs)
        .values({
          id: `r${i}`,
          projectId: "p1",
          epicBeadId: id,
          status: "done",
          // The score each ATTEMPT earned, as its review gate reported it (anton-cekf).
          reviewScore: 4 + i,
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

  it("holds — not disarms — while the operator's review queue is full, and says so as a limit", async () => {
    // The flow brake (R4.2). Nothing is latched and nothing is written: the pass still records its
    // ranking, because a hold stops STARTING work, not deciding what would start.
    const IN_REVIEW = LABELS.stage("in-review");
    const prs = [11, 12, 13];
    board.current = [
      bead("t1"),
      ...prs.map((n) =>
        bead(`anton-${n}`, { labels: [IN_REVIEW], metadata: { pr: `gh-${n}` } }),
      ),
    ];
    const info = vi.spyOn(console, "info").mockImplementation(() => {});

    await makeBoardPickerHandler({
      db: t.db,
      clock,
      readPrActivity: async (_repo, number) => prActivity(number, "OPEN"),
    })(fakeCtx());

    expect(await activeDisarm(t.db, "p1")).toBeUndefined();
    expect(holdLines(info)).toEqual([
      "[board-picker] p1: holding — 3 open PRs are waiting on review — " +
        "this project pauses new work at 3 (#11, #12, #13)",
    ]);
    // The brake and the ranking remain different jobs, exactly as for the two disarms.
    expect((await getBoardPickerPlan(t.db, "p1"))?.entries.map((e) => e.beadId)).toContain("t1");
    info.mockRestore();
  });

  it("stops holding on the next pass once one of those PRs merges", async () => {
    const IN_REVIEW = LABELS.stage("in-review");
    const prs = [11, 12, 13];
    board.current = [
      bead("t1"),
      ...prs.map((n) =>
        bead(`anton-${n}`, { labels: [IN_REVIEW], metadata: { pr: `gh-${n}` } }),
      ),
    ];
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    // #12 merges between the passes. The board is untouched — review-fix has not finalized the bead
    // yet — so the release can only come from the PR state itself.
    let merged = false;
    const pass = makeBoardPickerHandler({
      db: t.db,
      clock,
      readPrActivity: async (_repo, number) =>
        prActivity(number, merged && number === 12 ? "MERGED" : "OPEN"),
    });

    await pass(fakeCtx());
    expect(holdLines(info)).toHaveLength(1);

    merged = true;
    await pass(fakeCtx());

    // No second hold line, and nothing an operator had to clear to get there.
    expect(holdLines(info)).toHaveLength(1);
    expect((await getBoardPickerPlan(t.db, "p1"))?.entries.map((e) => e.beadId)).toContain("t1");
    info.mockRestore();
  });


  it("starts its top pick once the project is armed to apply", async () => {
    // R1.5 wiring: the pass hands the plan it just recorded to the apply step — the ranking is not
    // re-derived there, so the start and the lane can never name different targets.
    board.current = [bead("t1", { priority: 0 }), bead("t2", { priority: 2 })];
    arm(t, "apply");
    applyPickerPlan.mockResolvedValueOnce({
      started: { beadId: "t1", rank: 1, rule: "the work policy armed on this machine", jobId: "j1" },
    });

    const effect = await makeBoardPickerHandler({ db: t.db, clock })(fakeCtx());

    expect(applyPickerPlan).toHaveBeenCalledTimes(1);
    expect(applyPickerPlan.mock.calls[0][0]).toMatchObject({
      projectId: "p1",
      repoPath: "/tmp/p1",
      entries: [
        { beadId: "t1", rank: 1 },
        { beadId: "t2", rank: 2 },
      ],
    });
    // A start outranks "ranked N": it is the one outcome of this pass that moved something.
    expect(effect).toEqual({ changed: true, note: "started t1 (rank 1 of 2)" });
  });

  it("hands the start its cancellation and the runner's queue verbs", async () => {
    // The pre-call abort gate only proves the pass was live when the apply began (PR #218 review):
    // the apply itself spends seconds on `bd`, so it needs the signal to re-ask at its own seams —
    // and the runner's enqueue, whose quiesce barrier refuses a project mid-teardown.
    board.current = [bead("t1")];
    arm(t, "apply");
    const run = { enqueueIfAbsent: () => undefined, resume: async () => false };
    const ctx = fakeCtx();

    await makeBoardPickerHandler({ db: t.db, clock, run })(ctx);

    expect(applyPickerPlan.mock.calls[0][0]).toMatchObject({ signal: ctx.signal, run });
  });

  it("restamps the plan against the board its own start rewrote", async () => {
    // R3.5's apply lane is a LIVE PREVIEW: the start writes `approved` and the assignee, both inputs
    // to the plan's freshness fence, so the row saved before it reads stale the instant it lands —
    // and a stale plan withholds Up Next whole (PR #218 review). The pass therefore re-decides over
    // the post-write board, which drops the started target and leaves the survivors current.
    board.current = [bead("t1", { priority: 0 }), bead("t2", { priority: 2 })];
    arm(t, "apply");
    applyPickerPlan.mockImplementationOnce(async () => {
      board.current = [
        bead("t1", { priority: 0, assignee: "anton-box", labels: [LABELS.approved] }),
        bead("t2", { priority: 2 }),
      ];
      return {
        started: { beadId: "t1", rank: 1, rule: "the work policy armed on this machine", jobId: "j1" },
      };
    });

    await makeBoardPickerHandler({ db: t.db, clock })(fakeCtx());

    const plan = await getBoardPickerPlan(t.db, "p1");
    expect(plan?.entries.map((e) => e.beadId)).toEqual(["t2"]);
    expect(plan?.exclusions).toContainEqual(
      expect.objectContaining({ beadId: "t1", reason: "claimed" }),
    );
    // The whole point: the recorded plan describes the board as it now reads, so the lane survives.
    expect(isPlanStale(plan!, stampBoard(board.current, clock.now(), { types: ["task"] }))).toBe(
      false,
    );
  });

  it("keeps the start when the restamp fails, rather than retrying the pass", async () => {
    // The run is already enqueued: a throw here would retry the pass, and the retry — reading a
    // board whose top pick is now claimed — would start the NEXT target.
    board.current = [bead("t1", { priority: 0 })];
    arm(t, "apply");
    applyPickerPlan.mockResolvedValueOnce({
      started: { beadId: "t1", rank: 1, rule: "the work policy armed on this machine", jobId: "j1" },
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    // The pass's own read stands; the RESTAMP's re-read is the one that falls over.
    vi.mocked(loadAllIssues)
      .mockImplementationOnce(async () => board.current)
      .mockImplementationOnce(async () => {
        throw new Error("bd is gone");
      });

    const effect = await makeBoardPickerHandler({ db: t.db, clock })(fakeCtx());

    expect(effect).toEqual({ changed: true, note: "started t1 (rank 1 of 1)" });
    expect(warn.mock.calls.some((args) => String(args[0]).includes("restamped"))).toBe(true);
    warn.mockRestore();
  });

  it("still only ranks at shadow — the level below apply starts nothing", async () => {
    board.current = [bead("t1")];
    arm(t, "shadow");

    expect(await makeBoardPickerHandler({ db: t.db, clock })(fakeCtx())).toEqual({
      changed: true,
      note: "ranked 1 target(s)",
    });
    expect(applyPickerPlan).not.toHaveBeenCalled();
  });

  it("refuses to apply on a project that has armed no policy", async () => {
    // The structural default admits everything, so a pass that wrote `approved` off it would be
    // autopilot with no approval in it. The level floors to shadow rather than starting anything.
    board.current = [bead("t1")];
    t.db
      .update(schema.projects)
      .set({ settingsJson: JSON.stringify({ pickerAutonomy: "apply" }) })
      .run();

    await makeBoardPickerHandler({ db: t.db, clock })(fakeCtx());

    expect(applyPickerPlan).not.toHaveBeenCalled();
  });

  it("refuses to apply until this project's own picks have earned it (anton-vkp9)", async () => {
    // The second gate. A policy says what anton MAY start; nothing but the operator's own releases
    // says whether its picks have been worth starting — so an armed `apply` with no record ranks and
    // starts nothing, and the pass says what it is short of rather than ignoring the setting quietly.
    board.current = [bead("t1")];
    arm(t, "apply", { record: false });
    const info = vi.spyOn(console, "info").mockImplementation(() => {});

    await makeBoardPickerHandler({ db: t.db, clock })(fakeCtx());

    expect(applyPickerPlan).not.toHaveBeenCalled();
    expect(info.mock.calls.map((args) => String(args[0])).join("\n")).toContain(
      "apply not earned — no answered picks yet",
    );
    // Still a ranking: the floor freezes STARTING, not deciding.
    expect((await getBoardPickerPlan(t.db, "p1"))?.entries.map((e) => e.beadId)).toEqual(["t1"]);
    info.mockRestore();
  });

  it("returns an armed picker to shadow once its record degrades", async () => {
    // Re-asked on every pass over a rolling window, so vetoes the operator files after arming push
    // the record back below the bar and the next pass starts nothing — no latch, nothing to clear.
    board.current = [bead("t1")];
    arm(t, "apply");
    const pass = makeBoardPickerHandler({ db: t.db, clock });

    await pass(fakeCtx());
    expect(applyPickerPlan).toHaveBeenCalledTimes(1);

    const veto = (i: number) =>
      recordPickerVeto(t.db, clock, {
        projectId: "p1",
        beadId: `late-${i}`,
        action: "not-now",
        planId: `late-plan-${i}`,
      });

    // One veto still clears the bar — the floor is a threshold, not a hair trigger, and a pass that
    // stopped here would prove nothing about the one below.
    await veto(1);
    await pass(fakeCtx());
    expect(applyPickerPlan).toHaveBeenCalledTimes(2);

    // Two more displace releases out of the rolling window, and the record no longer supports apply.
    await veto(2);
    await veto(3);
    await pass(fakeCtx());
    expect(applyPickerPlan).toHaveBeenCalledTimes(2);
  });

  it("starts nothing while the project is disarmed, on this pass and every later one", async () => {
    // The latch is what the apply step refuses on (R4.4) — and it must keep refusing: the breaker
    // itself answers `undefined` once a disarm stands, so a pass reading only its verdict would
    // treat the second tick as armed again.
    board.current = [bead("t1")];
    arm(t, "apply");
    threeFailedRuns(t);
    const pass = makeBoardPickerHandler({ db: t.db, clock });

    await pass(fakeCtx());
    await pass(fakeCtx());

    expect(await activeDisarm(t.db, "p1")).toBeDefined();
    expect(applyPickerPlan).not.toHaveBeenCalled();
    // The ranking is still recorded — a disarm freezes starting, not deciding.
    expect((await getBoardPickerPlan(t.db, "p1"))?.entries.map((e) => e.beadId)).toEqual(["t1"]);
  });

  it("starts nothing while the WIP hold is on, and starts again once it releases", async () => {
    const IN_REVIEW = LABELS.stage("in-review");
    const prs = [11, 12, 13];
    board.current = [
      bead("t1"),
      ...prs.map((n) => bead(`anton-${n}`, { labels: [IN_REVIEW], metadata: { pr: `gh-${n}` } })),
    ];
    arm(t, "apply");
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    let merged = false;
    const pass = makeBoardPickerHandler({
      db: t.db,
      clock,
      readPrActivity: async (_repo, number) =>
        prActivity(number, merged && number === 12 ? "MERGED" : "OPEN"),
    });

    await pass(fakeCtx());
    expect(applyPickerPlan).not.toHaveBeenCalled();

    // Nothing was latched and nothing needed clearing: the next merge releases the hold by itself.
    merged = true;
    await pass(fakeCtx());
    expect(applyPickerPlan).toHaveBeenCalledTimes(1);
    info.mockRestore();
  });

  it("parks a payload naming a project that is gone rather than retrying it forever", async () => {
    const handler = makeBoardPickerHandler({ db: t.db, clock });
    await expect(handler(fakeCtx({ payload: { projectId: "ghost" } }))).rejects.toThrow(PoisonError);
  });
});
