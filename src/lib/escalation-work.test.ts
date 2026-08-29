/**
 * Unit tests for escalation-work.ts (anton-0ci7) — the WORK half of a founder's answer, exercised
 * directly rather than through `actOnEscalation`.
 *
 * The scenario suites reach this module only by walking a whole action, so the thing that decides
 * whether a founder's button may fire at all — {@link readTargetState}'s PRECEDENCE — was never
 * asserted on its own. It is an ordered rule, not a set of independent checks: existence outranks
 * liveness (a deleted bead has no lease to contest), evidence outranks a failed read, and an
 * unlanded pull downgrades an otherwise clear board to `unverified`. Each of those is pinned here
 * with the case where the two candidate answers disagree.
 *
 * Everything below the module is stubbed — no temp db, no bd, no runner — so a failure names this
 * module's decision and nothing else.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { LABELS, type Bead } from "./beads/bd";
import type { EscalationView } from "./escalations";
import { MAX_ABANDON_REASON_CHARS, type Project } from "./types";

const abandonTicket = vi.fn<(...args: unknown[]) => Promise<unknown>>();
const beadsPull = vi.fn<(repoPath: string) => Promise<void>>();
const beadsShow = vi.fn<(repoPath: string, id: string) => Promise<Bead | undefined>>();
const resumeStalledEpic = vi.fn<(projectId: string, epicBeadId: string) => Promise<string>>();
const resumeJob = vi.fn<(projectId: string, jobId: string) => Promise<boolean>>();
const cancelJob =
  vi.fn<(projectId: string, jobId: string, only?: readonly string[]) => Promise<{ ok: boolean }>>();
const runIsLiveForTarget = vi.fn<(projectId: string, epicBeadId: string) => boolean>();
const settleParkedRun = vi.fn<(...args: unknown[]) => Promise<boolean>>();
const getJob = vi.fn<(db: unknown, jobId: string) => Promise<{ status: string } | undefined>>();

vi.mock("./abandon", async () => {
  const actual = await vi.importActual<typeof import("./abandon")>("./abandon");
  return { ...actual, abandonTicket: (...args: unknown[]) => abandonTicket(...args) };
});
// The lease predicates stay REAL: they are pure label parsing, and the point of these tests is which
// bead this module asks them about, not how a lease is spelled (that is bd.test.ts's job).
vi.mock("./beads/bd", async () => {
  const actual = await vi.importActual<typeof import("./beads/bd")>("./beads/bd");
  return {
    ...actual,
    beads: {
      ...actual.beads,
      pull: (...args: [string]) => beadsPull(...args),
      show: (...args: [string, string]) => beadsShow(...args),
    },
  };
});
vi.mock("./db", () => ({ getDb: () => ({}) }));
vi.mock("./jobs/queue", async () => {
  const actual = await vi.importActual<typeof import("./jobs/queue")>("./jobs/queue");
  return {
    ...actual,
    systemClock: { now: () => NOW },
    getJob: (...args: [unknown, string]) => getJob(...args),
  };
});
vi.mock("./jobs/service", () => ({
  resumeStalledEpic: (...args: [string, string]) => resumeStalledEpic(...args),
  resumeJob: (...args: [string, string]) => resumeJob(...args),
  cancelJob: (...args: [string, string, (readonly string[])?]) => cancelJob(...args),
  runIsLiveForTarget: (...args: [string, string]) => runIsLiveForTarget(...args),
}));
vi.mock("./runs", () => ({ settleParkedRun: (...args: unknown[]) => settleParkedRun(...args) }));

const { actOnBead, actOnJob, readBead, readTargetState, restartedLocally } = await import(
  "./escalation-work"
);

const NOW = 1_700_000_000_000;
const HOUR = 3_600_000;
const project = { id: "p1", slug: "p1", name: "p1", repoPath: "/tmp/p1" } as Project;

const bead = (o: Partial<Bead> = {}): Bead =>
  ({ id: "anton-e1", title: "epic", status: "open", labels: [LABELS.approved], ...o }) as Bead;

/** A live lease owned by `owner` — what a run on another machine leaves on its run target. */
const leased = (id: string, owner?: string): Bead =>
  bead({ id, labels: [LABELS.approved, LABELS.runLease(NOW + HOUR, owner)] });

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

/** bd's answer per bead id, so the acted-on bead and the lease-carrying epic can differ. */
function shows(byId: Record<string, Bead | Error | undefined>): void {
  beadsShow.mockImplementation(async (_repo, id) => {
    const answer = byId[id];
    if (answer instanceof Error) throw answer;
    return answer;
  });
}

/** bd's own "no such issue" shape — the only failure that counts as evidence. */
const missingBeadError = () => Object.assign(new Error("issue not found: anton-t9"), { code: 1 });

beforeEach(() => {
  vi.clearAllMocks();
  beadsPull.mockResolvedValue(undefined);
  beadsShow.mockResolvedValue(bead());
  resumeStalledEpic.mockResolvedValue("enqueued");
  abandonTicket.mockResolvedValue(undefined);
  resumeJob.mockResolvedValue(true);
  cancelJob.mockResolvedValue({ ok: true });
  runIsLiveForTarget.mockReturnValue(false);
  settleParkedRun.mockResolvedValue(true);
  getJob.mockResolvedValue(undefined);
});

describe("readBead", () => {
  it("returns the row bd answered with", async () => {
    shows({ "anton-t9": bead({ id: "anton-t9" }) });

    expect(await readBead("/tmp/p1", "anton-t9")).toMatchObject({ id: "anton-t9" });
  });

  it("reads a lookup that names no issue as `missing`, same as bd's not-found exit", async () => {
    shows({});

    expect(await readBead("/tmp/p1", "anton-t9")).toBe("missing");
  });

  it("separates `missing` from `unreadable` — only the first is evidence", async () => {
    beadsShow.mockRejectedValueOnce(missingBeadError());
    expect(await readBead("/tmp/p1", "anton-t9")).toBe("missing");

    beadsShow.mockRejectedValueOnce(new Error("bd: connection refused"));
    expect(await readBead("/tmp/p1", "anton-t9")).toBe("unreadable");
  });
});

describe("readTargetState — the order the checks are applied in", () => {
  it("pulls the shared board BEFORE reading it, so a foreign write can be seen at all", async () => {
    const order: string[] = [];
    beadsPull.mockImplementation(async () => void order.push("pull"));
    beadsShow.mockImplementation(async () => {
      order.push("show");
      return bead();
    });

    await readTargetState(project, view(), "anton-e1", true);

    expect(order[0]).toBe("pull");
  });

  it("answers `clear` when the board landed and nothing holds the work", async () => {
    shows({ "anton-e1": bead() });

    expect(await readTargetState(project, view(), "anton-e1", true)).toBe("clear");
  });

  it("downgrades an otherwise clear board to `unverified` when the pull was rejected", async () => {
    beadsPull.mockRejectedValue(new Error("no remote answered"));
    shows({ "anton-e1": bead() });

    expect(await readTargetState(project, view(), "anton-e1", true)).toBe("unverified");
  });

  it("reports `gone` for a deleted bead and `closed` for one settled by hand", async () => {
    shows({});
    expect(await readTargetState(project, view(), "anton-t9", true)).toBe("gone");

    shows({ "anton-t9": bead({ id: "anton-t9", status: "closed" }) });
    expect(await readTargetState(project, view(), "anton-t9", true)).toBe("closed");
  });

  it("refuses on a bead bd could not answer for — a failed read is not a clear board", async () => {
    shows({ "anton-e1": new Error("bd: connection refused") });

    expect(await readTargetState(project, view(), "anton-e1", true)).toBe("unverified");
  });

  // Existence outranks liveness: a bead that is gone or closed has nothing left to contest, and
  // answering `contested` there would strand the row behind a refusal no sweep can retire.
  it("answers `gone` ahead of `contested`, even with a live foreign lease on the epic", async () => {
    shows({ "anton-e1": leased("anton-e1", "r-other") });

    expect(await readTargetState(project, view(), "anton-t9", true)).toBe("gone");
  });

  it("answers `closed` ahead of `unverified` from an unlanded pull", async () => {
    beadsPull.mockRejectedValue(new Error("no remote answered"));
    shows({ "anton-t9": bead({ id: "anton-t9", status: "closed" }) });

    expect(await readTargetState(project, view(), "anton-t9", true)).toBe("closed");
  });

  it("reports `contested` when ANOTHER run's lease is live on the epic", async () => {
    shows({ "anton-t9": bead({ id: "anton-t9" }), "anton-e1": leased("anton-e1", "r-other") });

    expect(await readTargetState(project, view(), "anton-t9", true)).toBe("contested");
  });

  it("exempts the stalled run's OWN leftover lease — that holder is this escalation", async () => {
    shows({ "anton-t9": bead({ id: "anton-t9" }), "anton-e1": leased("anton-e1", "r-1") });

    expect(await readTargetState(project, view({ runId: "r-1" }), "anton-t9", true)).toBe("clear");
  });

  it("treats ANY live lease as foreign for a finding with no run of its own", async () => {
    shows({ "anton-t9": bead({ id: "anton-t9" }), "anton-e1": leased("anton-e1", "r-1") });

    expect(await readTargetState(project, view({ runId: undefined }), "anton-t9", true)).toBe(
      "contested",
    );
  });

  it("reads the lease off the EPIC, not the ticket the verb acts on", async () => {
    shows({ "anton-t9": bead({ id: "anton-t9" }), "anton-e1": bead() });

    await readTargetState(project, view(), "anton-t9", true);

    expect(beadsShow.mock.calls.map(([, id]) => id)).toEqual(["anton-t9", "anton-e1"]);
  });

  it("costs no second read when the epic and the acted-on bead coincide", async () => {
    shows({ "anton-e1": leased("anton-e1", "r-other") });

    expect(await readTargetState(project, view(), "anton-e1", true)).toBe("contested");
    expect(beadsShow).toHaveBeenCalledTimes(1);
  });

  it("refuses when the EPIC is unreadable, even though the acted-on bead read fine", async () => {
    shows({ "anton-t9": bead({ id: "anton-t9" }), "anton-e1": new Error("bd: timeout") });

    expect(await readTargetState(project, view(), "anton-t9", true)).toBe("unverified");
  });

  it("still clears an abandon whose EPIC is gone — a missing epic carries no lease", async () => {
    shows({ "anton-t9": bead({ id: "anton-t9" }) });

    expect(await readTargetState(project, view(), "anton-t9", true)).toBe("clear");
  });

  // `judgeLease: false` is how a wait on a PERSON says the frozen ancestor is not what its verb
  // acts on — the lease read is skipped rather than answered off a pointer the gate has outlived.
  it("skips the lease read entirely when the caller does not judge it", async () => {
    shows({ "anton-t9": bead({ id: "anton-t9" }), "anton-e1": leased("anton-e1", "r-other") });

    expect(await readTargetState(project, view(), "anton-t9", false)).toBe("clear");
    expect(beadsShow.mock.calls.map(([, id]) => id)).toEqual(["anton-t9"]);
  });
});

describe("restartedLocally", () => {
  it("reports this machine's own live execute-epic for the run target", () => {
    runIsLiveForTarget.mockReturnValue(true);

    expect(restartedLocally("p1", "anton-e1")).toBe(true);
    expect(runIsLiveForTarget).toHaveBeenCalledWith("p1", "anton-e1");
  });

  it("is false when nothing is running here", () => {
    expect(restartedLocally("p1", "anton-e1")).toBe(false);
  });
});

describe("actOnBead", () => {
  it("resumes through the automatic path's own verb, keyed by the target it was given", async () => {
    expect(await actOnBead(project, "resume", view(), "anton-e1")).toBe("enqueued");

    expect(resumeStalledEpic).toHaveBeenCalledWith("p1", "anton-e1");
    expect(abandonTicket).not.toHaveBeenCalled();
  });

  it("abandons with `requireStopped` and the stalled run as its own-run exemption", async () => {
    expect(await actOnBead(project, "abandon", view(), "anton-t9")).toBe("abandoned");

    expect(abandonTicket).toHaveBeenCalledWith(project, "anton-t9", expect.any(String), {
      requireStopped: true,
      ownRunId: "r-1",
    });
  });

  it("records the escalation's own evidence as the reason, capped at bd's limit", async () => {
    await actOnBead(project, "abandon", view({ reason: "x".repeat(2000) }), "anton-t9");

    const reason = abandonTicket.mock.calls[0]![2] as string;
    expect(reason).toContain("parked-run");
    expect(reason.length).toBe(MAX_ABANDON_REASON_CHARS);
  });

  // `abandonTicket` kills only an ACTIVE job, but an escalation is raised precisely against work
  // that already stopped — so the stopped local rows are settled here or the next sweep re-raises.
  it("settles the parked run and the exhausted job the escalation named, after the bead", async () => {
    const order: string[] = [];
    abandonTicket.mockImplementation(async () => void order.push("bead"));
    cancelJob.mockImplementation(async () => {
      order.push("job");
      return { ok: true };
    });
    settleParkedRun.mockImplementation(async () => {
      order.push("run");
      return true;
    });

    await actOnBead(project, "abandon", view({ jobId: "j-1" }), "anton-t9");

    expect(order).toEqual(["bead", "job", "run"]);
    expect(cancelJob).toHaveBeenCalledWith("p1", "j-1", ["parked", "failed"]);
    expect(settleParkedRun).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      "p1",
      "r-1",
      expect.stringContaining("parked-run"),
    );
  });

  it("settles nothing local when the escalation named no run and no job", async () => {
    await actOnBead(project, "abandon", view({ runId: undefined, jobId: undefined }), "anton-t9");

    expect(cancelJob).not.toHaveBeenCalled();
    expect(settleParkedRun).not.toHaveBeenCalled();
  });
});

describe("actOnJob", () => {
  it("gives a resumed job a fresh retry budget", async () => {
    expect(await actOnJob("p1", "resume", "j-1")).toBe("resumed-job");
    expect(resumeJob).toHaveBeenCalledWith("p1", "j-1");
  });

  it("reports a job the runner would not resume rather than claiming it acted", async () => {
    resumeJob.mockResolvedValue(false);

    expect(await actOnJob("p1", "resume", "j-1")).toBe("job-not-resumable");
  });

  it("cancels only out of the statuses the finding was raised against", async () => {
    expect(await actOnJob("p1", "abandon", "j-1")).toBe("cancelled-job");
    expect(cancelJob).toHaveBeenCalledWith("p1", "j-1", ["parked", "failed"]);
  });

  // A stale button that hit a job someone restarted must say WHICH way it was refused, so the
  // operator learns their click landed on live work rather than on one that had merely stopped.
  it("says a refused cancel hit a job that is running again", async () => {
    cancelJob.mockResolvedValue({ ok: false });
    getJob.mockResolvedValue({ status: "running" });

    expect(await actOnJob("p1", "abandon", "j-1")).toBe("job-restarted");
  });

  it("says a refused cancel hit a job that had already settled", async () => {
    cancelJob.mockResolvedValue({ ok: false });
    getJob.mockResolvedValue({ status: "succeeded" });

    expect(await actOnJob("p1", "abandon", "j-1")).toBe("job-already-settled");
  });
});
