/**
 * The gate-check pass phase by phase (anton-m2e8). The pass is four moves — evaluate, surface,
 * decide, apply — and this suite drives each one on its own against a real anton.db and a stubbed
 * bd, so a seam can be proved (and broken) without running the whole job. The end-to-end proof that
 * the four compose stays in gate-check.integration.test.ts; the decision half lives in
 * gate-targets.test.ts and gate-check.unit.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import * as schema from "../db/schema";
import { makeTestDb, type TestDb } from "../db/testing";
import { LABELS, type Bead, type Gate, type GateCheckResult } from "../beads/bd";
import type { Clock } from "./queue";
import type { JobContext } from "./runner";

const gateListMock = vi.fn<(repo: string, opts?: { all?: boolean }) => Promise<Gate[]>>();
const gateCheckMock =
  vi.fn<(repo: string, opts?: { scope?: string }) => Promise<GateCheckResult>>();
const noteMock = vi.fn<(repo: string, id: string, text: string) => Promise<void>>();
const tagMock = vi.fn<(repo: string, id: string, labels: string[]) => Promise<void>>();

vi.mock("../beads/bd", async () => {
  const actual = await vi.importActual<typeof import("../beads/bd")>("../beads/bd");
  return {
    ...actual,
    beads: {
      ...actual.beads,
      gateList: (...args: [string, { all?: boolean }?]) => gateListMock(...args),
      gateCheck: (...args: [string, { scope?: string }?]) => gateCheckMock(...args),
      note: (...args: [string, string, string]) => noteMock(...args),
      tag: (...args: [string, string, string[]]) => tagMock(...args),
    },
  };
});

const {
  GATE_EXPIRED_LABEL,
  GATE_RESUMED_LABEL,
  dispatchMerged,
  dispatchReleased,
  dispatchUngated,
  evaluateGates,
  surfaceStalls,
  unmatchedGatedReport,
  wroteToBoard,
  gatePassEffect,
} = await import("./gate-check");
type PassContext = import("./gate-check").PassContext;
type GatePassCounts = import("./gate-check").GatePassCounts;
type GateEvaluation = import("./gate-check").GateEvaluation;
type ResumePlan = import("./gate-targets").ResumePlan;

const NOW = 1_700_000_000_000;
const HOURS = (n: number) => n * 3_600 * 1e9; // bd stores gate timeouts in nanoseconds
const REPO = "/tmp/p1";
const clock: Clock = { now: () => NOW };

let t: TestDb;
let pass: PassContext;

beforeEach(() => {
  t = makeTestDb();
  t.db
    .insert(schema.projects)
    .values({ id: "p1", slug: "p1", name: "p1", repoPath: REPO })
    .run();
  pass = { db: t.db, clock, projectId: "p1", repo: REPO };
  gateListMock.mockReset().mockResolvedValue([]);
  gateCheckMock
    .mockReset()
    .mockResolvedValue({ checked: 0, resolved: 0, escalated: 0, errors: 0, dryRun: false });
  noteMock.mockReset().mockResolvedValue(undefined);
  tagMock.mockReset().mockResolvedValue(undefined);
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  t.close();
});

function gate(id: string, o: Partial<Gate> = {}): Gate {
  return {
    id,
    title: `Gate: ${id}`,
    status: "open",
    issue_type: "gate",
    await_type: "gh:pr",
    created_at: new Date(NOW - 3 * 3_600_000).toISOString(),
    ...o,
  };
}

function bead(id: string, o: Partial<Bead> = {}): Bead {
  return { id, title: id, status: "open", issue_type: "task", labels: [LABELS.approved], ...o };
}

/** A JobContext thin enough for the phases that take one — only the heartbeat is ever called. */
function jobCtx(heartbeat = vi.fn().mockResolvedValue(undefined)): JobContext {
  return {
    jobId: "j1",
    type: "gate-check",
    projectId: "p1",
    payload: { projectId: "p1" },
    attempt: 1,
    heartbeat,
    signal: new AbortController().signal,
    report: () => {},
  };
}

const jobsOfType = async (type: string) =>
  (await t.db.select().from(schema.jobs).where(eq(schema.jobs.type, type))).map(
    (j) => JSON.parse(j.payloadJson).epicBeadId as string,
  );

describe("evaluateGates (phase 1)", () => {
  it("spawns no check at all for a project with no gates — the idle-pass cost", async () => {
    const evaluation = await evaluateGates(pass, jobCtx());
    expect(gateCheckMock).not.toHaveBeenCalled();
    expect(evaluation).toEqual({ openGates: [], scopes: [], resolved: 0, errors: 0 });
  });

  it("checks one scope per open gate FLAVOUR and sums what each returned", async () => {
    gateListMock.mockResolvedValue([gate("g1", { await_type: "timer" }), gate("g2")]);
    gateCheckMock.mockResolvedValue({
      checked: 1,
      resolved: 1,
      escalated: 0,
      errors: 2,
      dryRun: false,
    });
    const heartbeat = vi.fn().mockResolvedValue(undefined);

    const evaluation = await evaluateGates(pass, jobCtx(heartbeat));

    expect(gateCheckMock.mock.calls.map((c) => c[1]?.scope)).toEqual(["timer", "gh"]);
    expect(evaluation.resolved).toBe(2);
    expect(evaluation.errors).toBe(4);
    // The lease is extended per scope: a `gh` check can outlast it on its own.
    expect(heartbeat).toHaveBeenCalledTimes(2);
  });

  it("never scopes a check at the human gates it lists — those are the founder's", async () => {
    gateListMock.mockResolvedValue([gate("g1", { await_type: "human" })]);
    const evaluation = await evaluateGates(pass, jobCtx());
    expect(gateCheckMock).not.toHaveBeenCalled();
    expect(evaluation.openGates).toHaveLength(1);
  });
});

describe("surfaceStalls (phase 2)", () => {
  // A `bead` gate: the one flavour this bd can never resolve, so its deadline is all there is.
  const blown = gate("g1", { await_type: "bead" as Gate["await_type"], timeout: HOURS(1) });
  const board = [
    bead("t-1", { dependencies: [{ issue_id: "t-1", depends_on_id: "g1", type: "blocks" }] }),
  ];
  const ran: GateEvaluation = { openGates: [], scopes: ["timer"], resolved: 1, errors: 0 };
  const idle = (gates: Gate[]): GateEvaluation => ({
    openGates: gates,
    scopes: [],
    resolved: 0,
    errors: 0,
  });

  it("notes the bead the gate blocks, then marks the gate so it is raised once", async () => {
    const surfaced = await surfaceStalls(pass, board, idle([blown]), NOW);

    expect(surfaced).toBe(1);
    expect(noteMock.mock.calls[0]?.[1]).toBe("t-1");
    expect(noteMock.mock.calls[0]?.[2]).toContain("needs a human");
    expect(tagMock).toHaveBeenCalledWith(REPO, "g1", [GATE_EXPIRED_LABEL]);
  });

  it("re-reads the gates when a check ran — the ones it closed are no longer stalls", async () => {
    gateListMock.mockResolvedValue([]);
    expect(await surfaceStalls(pass, board, ran, NOW)).toBe(0);
    expect(gateListMock).toHaveBeenCalledTimes(1);
  });

  it("spends no bd call re-reading when no check ran", async () => {
    await surfaceStalls(pass, board, idle([]), NOW);
    expect(gateListMock).not.toHaveBeenCalled();
  });

  it("leaves an unnoted stall unmarked, so the next pass retries it", async () => {
    noteMock.mockRejectedValue(new Error("bd down"));
    expect(await surfaceStalls(pass, board, idle([blown]), NOW)).toBe(0);
    expect(tagMock).not.toHaveBeenCalled();
  });

  it("counts a stall whose MARK failed — the note still has to reach the shared board", async () => {
    // Surfaced is what decides the dolt push: a note this pass wrote but never pushed is invisible
    // to every other reader, so a failed tag must not suppress it. The gate carries no marker, so
    // the next pass re-notes it — one duplicate versus a stall nobody else can see.
    tagMock.mockRejectedValue(new Error("bd down"));
    expect(await surfaceStalls(pass, board, idle([blown]), NOW)).toBe(1);
  });
});

describe("dispatchUngated (phase 4a)", () => {
  it("enqueues one execute-epic per released target, and nothing on a second pass", async () => {
    expect(await dispatchUngated(pass, [bead("e-1"), bead("e-2")])).toBe(2);
    expect((await jobsOfType("execute-epic")).sort()).toEqual(["e-1", "e-2"]);

    // The overlap guarantee: `resumeEpic` refuses a target an active job already covers — and a
    // refusal is not work, so the pass must not report it as a run it put back in flight.
    expect(await dispatchUngated(pass, [bead("e-1"), bead("e-2")])).toBe(0);
    expect((await jobsOfType("execute-epic")).sort()).toEqual(["e-1", "e-2"]);
  });
});

describe("dispatchReleased (phase 4b)", () => {
  const resume = (id: string, gateId: string) => ({ gate: gate(gateId), target: bead(id) });

  it("dispatches the target and marks its gate, counting the marks that landed", async () => {
    const dispatched = await dispatchReleased(pass, [resume("t-1", "g-1")]);

    expect(dispatched).toEqual({ handedBack: 1, resumed: 1 });
    expect(await jobsOfType("execute-epic")).toEqual(["t-1"]);
    expect(tagMock).toHaveBeenCalledWith(REPO, "g-1", [GATE_RESUMED_LABEL]);
  });

  it("keeps going when one mark fails, and leaves that gate uncounted", async () => {
    tagMock.mockRejectedValueOnce(new Error("bd down"));
    const dispatched = await dispatchReleased(pass, [resume("t-1", "g-1"), resume("t-2", "g-2")]);

    // The mark is what the board push depends on; the resume is what the queue did. A failed mark
    // must not erase a run this pass actually put back in flight.
    expect(dispatched).toEqual({ handedBack: 1, resumed: 2 });
    expect((await jobsOfType("execute-epic")).sort()).toEqual(["t-1", "t-2"]);
  });

  it("counts no resume for a target an active job already covers", async () => {
    await dispatchReleased(pass, [resume("t-1", "g-1")]);
    expect(await dispatchReleased(pass, [resume("t-1", "g-1")])).toEqual({
      handedBack: 1,
      resumed: 0,
    });
  });
});

describe("dispatchMerged (phase 4c)", () => {
  it("hands each merged target to review-fix, deduped against the live job", async () => {
    expect(await dispatchMerged(pass, [bead("e-1")])).toBe(1);
    expect(await dispatchMerged(pass, [bead("e-1")])).toBe(0);
    expect(await jobsOfType("review-fix")).toEqual(["e-1"]);
  });
});

describe("unmatchedGatedReport", () => {
  const plan = (o: Partial<ResumePlan>): ResumePlan => ({
    gated: [],
    targets: [],
    released: [],
    merged: [],
    ...o,
  });

  it("names the ungated steps anton chose not to run", () => {
    const report = unmatchedGatedReport(
      plan({ gated: [{ molecule_id: "m-1", ready_step: bead("s-1") }, { molecule_id: "m-2" }] }),
    );
    expect(report).toContain("2 ungated step(s)");
    expect(report).toContain("s-1, m-2");
  });

  it("says nothing when there was nothing gated, or when a target did match", () => {
    expect(unmatchedGatedReport(plan({}))).toBeUndefined();
    expect(
      unmatchedGatedReport(plan({ gated: [{ molecule_id: "m-1" }], targets: [bead("e-1")] })),
    ).toBeUndefined();
  });
});

describe("wroteToBoard", () => {
  it("is false for an idle pass — the common case on this cadence, and no reason to push", () => {
    expect(wroteToBoard(0, 0, 0)).toBe(false);
  });

  it("is true for any board write, including a hand-back mark", () => {
    expect(wroteToBoard(1, 0, 0)).toBe(true);
    expect(wroteToBoard(0, 1, 0)).toBe(true);
    expect(wroteToBoard(0, 0, 1)).toBe(true);
  });
});

describe("gatePassEffect", () => {
  const counts = (over: Partial<GatePassCounts> = {}): GatePassCounts => ({
    resolved: 0,
    surfaced: 0,
    handedBack: 0,
    resumed: 0,
    dispatched: 0,
    ...over,
  });

  it("reads an idle slot as nothing to do — the normal case on a ten-minute cadence", () => {
    expect(gatePassEffect(counts())).toEqual({ changed: false, note: "no gate closed" });
  });

  // The note has to name every count that made `changed` true, or the dot says work happened while
  // the words say nothing did.
  it("names each action the pass took, not just the gates it closed", () => {
    expect(gatePassEffect(counts({ surfaced: 1, handedBack: 2 }))).toEqual({
      changed: true,
      note: "surfaced 1 stall(s), handed back 2 gate(s)",
    });
    expect(gatePassEffect(counts({ resolved: 2, surfaced: 1, handedBack: 1 })).note).toBe(
      "closed 2 gate(s), surfaced 1 stall(s), handed back 1 gate(s)",
    );
  });

  // A gate resolved on another machine leaves this pass with no board write of its own — but the
  // queue moved, and reporting that as a no-op hides the slot that mattered.
  it("counts work put back in flight even when the pass wrote nothing to the board", () => {
    expect(gatePassEffect(counts({ resumed: 1, dispatched: 2 }))).toEqual({
      changed: true,
      note: "resumed 1 run(s), dispatched 2 merged run(s) to review-fix",
    });
  });
});
