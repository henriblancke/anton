/**
 * Unit tests for escalation-actions.ts (anton-0ci7) — the module that owns the ORDER of a founder's
 * answer and nothing else: which handler an answer routes to, what the pre-settle board read may
 * refuse, and that the status CAS is claimed before anything acts.
 *
 * The sibling `escalation-actions.*.test.ts` suites drive the same entry point over a real temp
 * anton.db, which is what makes the settle a genuine CAS. That is deliberately NOT repeated here:
 * this suite stubs the store and both handlers so each assertion names a routing decision — a
 * dispatch that goes to the wrong handler, or a settle that lands on the wrong side of the act, is
 * a failure with one cause instead of a scenario that happens to end up in the right place.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { EscalationView } from "./escalations";
import type { Project } from "./types";

const getEscalation = vi.fn<(...args: unknown[]) => Promise<Record<string, unknown> | undefined>>();
const settleEscalation = vi.fn<(...args: unknown[]) => Promise<boolean>>();
const answerGateWait =
  vi.fn<(...args: unknown[]) => Promise<{ detail: string; note?: string }>>();
const actOnBead = vi.fn<(...args: unknown[]) => Promise<string>>();
const actOnJob = vi.fn<(...args: unknown[]) => Promise<string>>();
const readTargetState = vi.fn<(...args: unknown[]) => Promise<string>>();
const restartedLocally = vi.fn<(projectId: string, epicBeadId: string) => boolean>();

vi.mock("./db", async () => {
  const actual = await vi.importActual<typeof import("./db")>("./db");
  return { ...actual, getDb: () => ({}) };
});
vi.mock("./escalations", async () => {
  const actual = await vi.importActual<typeof import("./escalations")>("./escalations");
  return {
    ...actual,
    getEscalation: (...args: unknown[]) => getEscalation(...args),
    settleEscalation: (...args: unknown[]) => settleEscalation(...args),
    // The row IS the view in this suite: `toEscalationView` is escalations.test.ts's to own.
    toEscalationView: (row: unknown) => row as EscalationView,
  };
});
vi.mock("./escalation-gate", () => ({
  answerGateWait: (...args: unknown[]) => answerGateWait(...args),
}));
vi.mock("./escalation-work", () => ({
  actOnBead: (...args: unknown[]) => actOnBead(...args),
  actOnJob: (...args: unknown[]) => actOnJob(...args),
  readTargetState: (...args: unknown[]) => readTargetState(...args),
  restartedLocally: (...args: [string, string]) => restartedLocally(...args),
}));

const { actOnEscalation, isEscalationAction } = await import("./escalation-actions");
const { RunRestartedError } = await import("./abandon");

const NOW = 1_700_000_000_000;
const HOUR = 3_600_000;
const project = { id: "p1", slug: "p1", name: "p1", repoPath: "/tmp/p1" } as Project;

/** A promise the test releases by hand, so a step can be held mid-flight and observed there. */
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/** Drains the microtask queue, so everything not blocked on a held promise has run. */
const flush = () => new Promise((r) => setImmediate(r));

const view = (o: Partial<EscalationView> = {}): EscalationView =>
  ({
    id: "esc-1",
    findingKey: "parked-run:r-1",
    kind: "parked-run",
    reason: "parked 4h ago: agent exited 1",
    beadId: "anton-t9",
    epicBeadId: "anton-e1",
    runId: "r-1",
    ageMs: 4 * HOUR,
    status: "open",
    noted: false,
    raisedAt: Math.floor(NOW / 1000),
    ...o,
  }) as EscalationView;

/** Put one open escalation on the board this action reads. */
function open(o: Partial<EscalationView> = {}): EscalationView {
  const row = view(o);
  getEscalation.mockResolvedValue(row as unknown as Record<string, unknown>);
  return row;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  settleEscalation.mockResolvedValue(true);
  readTargetState.mockResolvedValue("clear");
  restartedLocally.mockReturnValue(false);
  actOnBead.mockResolvedValue("enqueued");
  actOnJob.mockResolvedValue("resumed-job");
  answerGateWait.mockResolvedValue({ detail: "gate-resolved" });
});

describe("isEscalationAction", () => {
  it("accepts exactly the three answers the panel may send", () => {
    expect(["resume", "abandon", "dismiss"].every(isEscalationAction)).toBe(true);
  });

  it.each([[""], ["RESUME"], ["close"], [null], [undefined], [1], [{}], [["resume"]]])(
    "rejects %s, which a direct POST could carry",
    (value) => {
      expect(isEscalationAction(value)).toBe(false);
    },
  );
});

describe("actOnEscalation — the row it may act on", () => {
  it("refuses an id this project does not own", async () => {
    getEscalation.mockResolvedValue(undefined);

    expect(await actOnEscalation(project, "esc-1", "resume")).toEqual({
      ok: false,
      reason: "not-found",
    });
    expect(getEscalation).toHaveBeenCalledWith(expect.anything(), "p1", "esc-1");
    expect(settleEscalation).not.toHaveBeenCalled();
  });

  it("refuses one somebody already settled", async () => {
    open({ status: "resolved", resolution: "resumed" });

    expect(await actOnEscalation(project, "esc-1", "resume")).toEqual({
      ok: false,
      reason: "not-open",
    });
    expect(actOnBead).not.toHaveBeenCalled();
  });

  it("refuses a verb when the finding names no bead, job or gate to act on", async () => {
    open({ beadId: undefined, epicBeadId: undefined, jobId: undefined, gateId: undefined });

    for (const action of ["resume", "abandon"] as const) {
      expect(await actOnEscalation(project, "esc-1", action)).toEqual({
        ok: false,
        reason: "no-target",
      });
    }
    // Still open: an escalation nothing can act on must stay visible rather than silently resolve.
    expect(settleEscalation).not.toHaveBeenCalled();
  });

  it("reports the loser of a race as `not-open` — the CAS is the lock", async () => {
    open();
    settleEscalation.mockResolvedValue(false);

    expect(await actOnEscalation(project, "esc-1", "resume")).toEqual({
      ok: false,
      reason: "not-open",
    });
    expect(actOnBead).not.toHaveBeenCalled();
  });
});

describe("actOnEscalation — settle first, act second", () => {
  // The CAS is held OPEN rather than resolved on call: a call order alone would also be produced by
  // starting the settle, running the verb while the claim is still in flight, and awaiting it after —
  // which is exactly the racing double-click the CAS exists to serialise.
  it("claims the decision BEFORE the verb runs", async () => {
    open();
    const order: string[] = [];
    const claim = deferred();
    settleEscalation.mockImplementation(async () => {
      order.push("settle");
      await claim.promise;
      return true;
    });
    actOnBead.mockImplementation(async () => {
      order.push("act");
      return "enqueued";
    });

    const acting = actOnEscalation(project, "esc-1", "resume");
    await flush();

    expect(order).toEqual(["settle"]);
    claim.resolve();

    await acting;
    expect(order).toEqual(["settle", "act"]);
  });

  // The read is held OPEN: settling while it is still in flight and awaiting it after would produce
  // the same call order while settling on an unread board — and a refusal that lands after the CAS
  // has already taken the row off the panel is precisely what this order prevents.
  it("re-reads the board BEFORE the settle, so a refusal leaves the row on the panel", async () => {
    open();
    const order: string[] = [];
    const read = deferred();
    readTargetState.mockImplementation(async () => {
      order.push("read");
      await read.promise;
      return "clear";
    });
    settleEscalation.mockImplementation(async () => {
      order.push("settle");
      return true;
    });

    const acting = actOnEscalation(project, "esc-1", "resume");
    await flush();

    expect(order).toEqual(["read"]);
    read.resolve();

    await acting;
    expect(order).toEqual(["read", "settle"]);
  });

  it("records each verb as its own resolution", async () => {
    open();
    await actOnEscalation(project, "esc-1", "resume");
    expect(settleEscalation).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.anything(),
      "esc-1",
      "resumed",
    );

    await actOnEscalation(project, "esc-1", "abandon");
    expect(settleEscalation).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.anything(),
      "esc-1",
      "abandoned",
    );
  });
});

describe("actOnEscalation — which target each verb acts on", () => {
  it("resumes the EPIC — jobs are keyed by run target, not by the ticket that stalled", async () => {
    open();

    expect(await actOnEscalation(project, "esc-1", "resume")).toMatchObject({
      ok: true,
      action: "resume",
      detail: "enqueued",
    });
    expect(actOnBead).toHaveBeenCalledWith(project, "resume", expect.anything(), "anton-e1");
  });

  it("abandons the finding's own BEAD, not the epic above it", async () => {
    open();
    actOnBead.mockResolvedValue("abandoned");

    expect(await actOnEscalation(project, "esc-1", "abandon")).toMatchObject({
      ok: true,
      detail: "abandoned",
    });
    expect(actOnBead).toHaveBeenCalledWith(project, "abandon", expect.anything(), "anton-t9");
  });

  it("routes a stall that names only a JOB to the jobs list's own verbs", async () => {
    open({ beadId: undefined, epicBeadId: undefined, jobId: "j-1" });

    expect(await actOnEscalation(project, "esc-1", "resume")).toMatchObject({
      ok: true,
      detail: "resumed-job",
    });
    expect(actOnJob).toHaveBeenCalledWith("p1", "resume", "j-1");
    expect(actOnBead).not.toHaveBeenCalled();
    // No bead to re-read — a job-only stall never touches the shared board.
    expect(readTargetState).not.toHaveBeenCalled();
  });

  it("routes a wait on a PERSON to the gate handler, which owns both verbs", async () => {
    open({ kind: "needs-human", gateId: "g-1", runId: undefined });
    answerGateWait.mockResolvedValue({ detail: "gate-still-blocked", note: "it is not approved" });

    expect(await actOnEscalation(project, "esc-1", "resume")).toMatchObject({
      ok: true,
      detail: "gate-still-blocked",
      note: "it is not approved",
    });
    expect(answerGateWait).toHaveBeenCalledWith(
      project,
      "resume",
      expect.anything(),
      "g-1",
      "anton-e1",
    );
    expect(actOnBead).not.toHaveBeenCalled();
  });
});

describe("actOnEscalation — dismiss", () => {
  it("settles the row and touches nothing else", async () => {
    open({ kind: "stale-pr" });

    expect(await actOnEscalation(project, "esc-1", "dismiss")).toMatchObject({
      ok: true,
      action: "dismiss",
      detail: "dismissed",
    });
    expect(settleEscalation).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      "esc-1",
      "dismissed",
    );
    expect(actOnBead).not.toHaveBeenCalled();
    expect(actOnJob).not.toHaveBeenCalled();
    expect(answerGateWait).not.toHaveBeenCalled();
  });

  it("needs no target and never consults the board", async () => {
    open({ kind: "stale-pr", beadId: undefined, epicBeadId: undefined, jobId: undefined });

    expect(await actOnEscalation(project, "esc-1", "dismiss")).toMatchObject({ ok: true });
    expect(readTargetState).not.toHaveBeenCalled();
  });

  // Settling a wait on a person settles nothing: the gate stays open and the very next sweep
  // bounces the same row back. The panel hides the button; a direct POST never passes the panel.
  it("is refused on a wait for a person, which settling alone cannot end", async () => {
    open({ kind: "needs-human", gateId: "g-1" });

    expect(await actOnEscalation(project, "esc-1", "dismiss")).toEqual({
      ok: false,
      reason: "not-dismissable",
    });
    expect(settleEscalation).not.toHaveBeenCalled();
  });
});

describe("actOnEscalation — the pre-settle board read", () => {
  it.each(["contested", "unverified"] as const)(
    "refuses on %s, without settling the row",
    async (state) => {
      open();
      readTargetState.mockResolvedValue(state);

      expect(await actOnEscalation(project, "esc-1", "resume")).toEqual({ ok: false, reason: state });
      expect(settleEscalation).not.toHaveBeenCalled();
      expect(actOnBead).not.toHaveBeenCalled();
    },
  );

  // Work that settled itself since the sweep leaves neither verb anything to do. That is recorded
  // as the no-op it is rather than refused: the panel offers Dismiss only on a stale PR, so a
  // refusal would strand this row with no move that could ever retire it.
  it.each([
    ["gone", "target-gone"],
    ["closed", "target-closed"],
  ] as const)("settles %s work as a dismissed no-op", async (state, detail) => {
    open();
    readTargetState.mockResolvedValue(state);

    expect(await actOnEscalation(project, "esc-1", "abandon")).toMatchObject({
      ok: true,
      action: "abandon",
      detail,
    });
    expect(settleEscalation).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      "esc-1",
      "dismissed",
    );
    expect(actOnBead).not.toHaveBeenCalled();
  });

  it("judges liveness on the epic a resume re-enqueues", async () => {
    open();

    await actOnEscalation(project, "esc-1", "resume");

    expect(readTargetState).toHaveBeenCalledWith(project, expect.anything(), "anton-e1", true);
  });

  // A local resume reuses the stalled run's id, so the shared lease reads as OURS by design. Only
  // an abandon consults this, because only an abandon would kill what that resume just started.
  it("refuses an abandon over work THIS machine restarted since the stall", async () => {
    open();
    restartedLocally.mockReturnValue(true);

    expect(await actOnEscalation(project, "esc-1", "abandon")).toEqual({
      ok: false,
      reason: "contested",
    });
    expect(restartedLocally).toHaveBeenCalledWith("p1", "anton-e1");
    expect(readTargetState).not.toHaveBeenCalled();
  });

  it("lets a resume through the same local restart — `resumeEpic` absorbs it as a no-op", async () => {
    open();
    restartedLocally.mockReturnValue(true);

    expect(await actOnEscalation(project, "esc-1", "resume")).toMatchObject({ ok: true });
  });

  // `readTargetState` awaits a bd pull that can take seconds; a resume landing inside that window
  // republishes the stalled run's own id, which the lease check exempts as this escalation's own.
  it("re-checks the local restart AFTER the board read, not only before it", async () => {
    open();
    readTargetState.mockImplementation(async () => {
      restartedLocally.mockReturnValue(true);
      return "clear";
    });

    expect(await actOnEscalation(project, "esc-1", "abandon")).toEqual({
      ok: false,
      reason: "contested",
    });
  });

  // A gate outlives a reparent, so the frozen ancestor is not what either verb acts on — the veto
  // moves to each verb's own re-derived target rather than being applied to a stale pointer.
  it("does not judge the frozen lease for a wait on a person", async () => {
    open({ kind: "needs-human", gateId: "g-1", runId: undefined });

    await actOnEscalation(project, "esc-1", "resume");

    expect(readTargetState).toHaveBeenCalledWith(project, expect.anything(), "anton-e1", false);
    expect(restartedLocally).not.toHaveBeenCalled();
  });

  it("acts on a gate wait whose frozen target has since been closed, dropping the pointer", async () => {
    open({ kind: "needs-human", gateId: "g-1", runId: undefined });
    readTargetState.mockResolvedValue("closed");

    expect(await actOnEscalation(project, "esc-1", "resume")).toMatchObject({ ok: true });
    // The gate re-derives what it releases now; the settled ancestor says nothing about it.
    expect(answerGateWait).toHaveBeenCalledWith(
      project,
      "resume",
      expect.anything(),
      "g-1",
      undefined,
    );
  });
});

describe("actOnEscalation — a verb that fails after the settle", () => {
  // The abandon's own boundary check caught a resume that landed after the settle: it refused
  // before touching anything, so this is the same answer the pre-settle checks give.
  it("reports `contested` when the abandon's boundary check refuses", async () => {
    open();
    actOnBead.mockRejectedValue(new RunRestartedError("anton-t9"));

    expect(await actOnEscalation(project, "esc-1", "abandon")).toEqual({
      ok: false,
      reason: "contested",
    });
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining("restarted first"));
  });

  it("rethrows any other failure, after logging the settled-but-not-acted state", async () => {
    open();
    actOnBead.mockRejectedValue(new Error("the runner is shutting down"));

    await expect(actOnEscalation(project, "esc-1", "resume")).rejects.toThrow("shutting down");
    // The row has already left the panel, so this line is the only place the two halves meet.
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining("settled as resumed"),
      expect.any(Error),
    );
  });
});
