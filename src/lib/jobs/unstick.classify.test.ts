/**
 * Unit tests for the per-kind classifiers `classifyFinding` delegates to (anton-fbzx). One suite per
 * STUCK SHAPE, driven directly against a synthetic context — no db, no runner, no board — because
 * the judgment is pure and the safety rules are what these have to pin down. The end-to-end
 * behaviour they add up to (idempotence across passes, the escalation writes) stays in
 * unstick.test.ts.
 */
import { describe, expect, it } from "vitest";

import { LABELS, type Bead } from "../beads/bd";
import type { RunHealthFinding } from "../run-health";
import type { RunRow } from "../runs";
import {
  classifyDeadLease,
  classifyExhaustedJob,
  classifyFinding,
  classifyNeedsHuman,
  classifyNonQuotaPark,
  classifyParkedRun,
  classifyQuotaPark,
  classifyStalePr,
  type UnstickContext,
} from "./unstick";

const NOW = 1_700_000_000_000;
const HOUR = 3_600_000;
const GRACE = 10 * 60_000;

function openEpic(id: string, labels: string[] = []): Bead {
  return { id, title: id, status: "open", issue_type: "epic", labels };
}

function ctxOf(o: Partial<UnstickContext> = {}): UnstickContext {
  return {
    projectId: "p1",
    nowMs: NOW,
    activeEpicKeys: new Set(),
    parkedRuns: new Map(),
    board: new Map([["e-1", openEpic("e-1")]]),
    boardFresh: true,
    deadLeaseGraceMs: GRACE,
    usageWindowEndsAt: () => undefined,
    epicCancelled: () => false,
    stillStuck: () => true,
    ...o,
  };
}

/** A parked run row as the pass reads it — a quota park unless a test says otherwise. */
function parkedRun(o: Partial<RunRow> = {}): RunRow {
  return {
    id: "run-1",
    projectId: "p1",
    epicBeadId: "e-1",
    ticketBeadId: null,
    jobId: null,
    worktreePath: null,
    branch: null,
    model: null,
    agentTag: null,
    formula: null,
    formulaVariant: null,
    status: "parked",
    reviewScore: null,
    attempts: 1,
    leaseExpiresAt: null,
    error: "usage-limit",
    startedAt: new Date(NOW - 4 * HOUR),
    endedAt: null,
    updatedAt: new Date(NOW - HOUR),
    writeSeq: 1,
    ...o,
  };
}

function finding(o: Partial<RunHealthFinding> & Pick<RunHealthFinding, "kind">): RunHealthFinding {
  return {
    key: `${o.kind}:subject`,
    reason: "the reported reason",
    since: NOW - 4 * HOUR,
    ageMs: 4 * HOUR,
    ...o,
  };
}

/** A context carrying exactly one parked run, plus the finding that points at it. */
function parked(run: RunRow, o: Partial<UnstickContext> = {}) {
  return {
    finding: finding({ kind: "parked-run", runId: run.id, beadId: run.epicBeadId }),
    ctx: ctxOf({ parkedRuns: new Map([[run.id, run]]), ...o }),
  };
}

describe("classifyParkedRun — a run execute-epic parked and never came back to", () => {
  it("resumes a usage-limit park whose quota window has already passed", () => {
    const { finding: f, ctx } = parked(parkedRun(), {
      usageWindowEndsAt: () => NOW - HOUR,
    });
    expect(classifyParkedRun(f, ctx)).toEqual({
      disposition: "resume",
      why: "parked on usage-limit and the quota window has passed",
      epicBeadId: "e-1",
    });
  });

  it("holds a finding whose run is no longer parked — the report is a candidate list", () => {
    const f = finding({ kind: "parked-run", runId: "run-gone" });
    expect(classifyParkedRun(f, ctxOf())).toMatchObject({
      disposition: "hold",
      why: "the run is no longer parked",
    });
  });

  it("holds when a live job on this machine already owns the run", () => {
    const { finding: f, ctx } = parked(parkedRun(), {
      activeEpicKeys: new Set(["p1::e-1"]),
    });
    expect(classifyParkedRun(f, ctx)).toMatchObject({ disposition: "hold" });
    expect(classifyParkedRun(f, ctx).why).toContain("a live job already owns this run");
  });

  it("holds when the epic has since closed, so a resume would park on a closed bead", () => {
    const { finding: f, ctx } = parked(parkedRun(), {
      board: new Map([["e-1", { ...openEpic("e-1"), status: "closed" }]]),
    });
    expect(classifyParkedRun(f, ctx).why).toBe("the epic has since closed");
  });

  it("holds when the epic is gone from a freshly pulled board", () => {
    const { finding: f, ctx } = parked(parkedRun(), { board: new Map() });
    expect(classifyParkedRun(f, ctx).why).toBe("the epic is gone from the board");
  });

  it("holds a park of any reason once an operator cancelled the epic's job", () => {
    for (const error of ["usage-limit", "the agent failed"]) {
      const { finding: f, ctx } = parked(parkedRun({ error }), { epicCancelled: () => true });
      expect(classifyParkedRun(f, ctx)).toMatchObject({
        disposition: "hold",
        why: "this epic's latest job was cancelled by an operator",
      });
    }
  });

  it("routes a non-quota park to a human rather than resuming it", () => {
    const { finding: f, ctx } = parked(parkedRun({ error: "the agent failed" }));
    expect(classifyParkedRun(f, ctx)).toEqual({
      disposition: "escalate",
      why: "the reported reason",
    });
  });
});

describe("classifyQuotaPark — a park that was only ever a wait for quota", () => {
  it("holds while the window it is waiting for has not reopened", () => {
    const ctx = ctxOf({ usageWindowEndsAt: () => NOW + HOUR });
    expect(classifyQuotaPark(parkedRun(), ctx)).toMatchObject({
      disposition: "hold",
      why: `the usage window reopens at ${new Date(NOW + HOUR).toISOString()}`,
    });
  });

  it("resumes past its own leftover lease — execute-epic publishes it under the run id", () => {
    const ctx = ctxOf({
      board: new Map([["e-1", openEpic("e-1", [LABELS.runLease(NOW + HOUR, "run-1")])]]),
    });
    expect(classifyQuotaPark(parkedRun(), ctx)).toMatchObject({ disposition: "resume" });
  });

  it("holds when another machine holds a live run-lease on the epic", () => {
    const ctx = ctxOf({
      board: new Map([["e-1", openEpic("e-1", [LABELS.runLease(NOW + HOUR, "run-elsewhere")])]]),
    });
    expect(classifyQuotaPark(parkedRun(), ctx)).toMatchObject({
      disposition: "hold",
      why: "another machine holds a live run-lease",
    });
  });

  it("stands down when the board could not be pulled — an unreadable lease is not an absent one", () => {
    const ctx = ctxOf({ boardFresh: false });
    expect(classifyQuotaPark(parkedRun(), ctx).why).toContain("could not be pulled");
  });
});

describe("classifyNonQuotaPark — a park that proved retrying does not fix it", () => {
  it("escalates with the finding's own evidence", () => {
    const f = finding({ kind: "parked-run", runId: "run-1", reason: "agent exited 1" });
    expect(classifyNonQuotaPark(f, parkedRun({ error: "agent exited 1" }), ctxOf())).toEqual({
      disposition: "escalate",
      why: "agent exited 1",
    });
  });

  it("holds only on a CONFIRMED foreign lease — work executing elsewhere is not the founder's call", () => {
    const ctx = ctxOf({
      board: new Map([["e-1", openEpic("e-1", [LABELS.runLease(NOW + HOUR, "run-elsewhere")])]]),
    });
    const f = finding({ kind: "parked-run", runId: "run-1" });
    expect(classifyNonQuotaPark(f, parkedRun({ error: "boom" }), ctx)).toMatchObject({
      disposition: "hold",
    });
  });

  it("still escalates on an untrusted board — a missed escalation strands the stall", () => {
    const f = finding({ kind: "parked-run", runId: "run-1" });
    const ctx = ctxOf({ boardFresh: false });
    expect(classifyNonQuotaPark(f, parkedRun({ error: "boom" }), ctx)).toMatchObject({
      disposition: "escalate",
    });
  });
});

describe("classifyDeadLease — a bead still holding the lease of a machine that died", () => {
  const dead = (labels: string[], o: Partial<UnstickContext> = {}) => ({
    finding: finding({ kind: "dead-lease", beadId: "e-1" }),
    ctx: ctxOf({ board: new Map([["e-1", openEpic("e-1", labels)]]), ...o }),
  });

  it("resumes a lease that expired past the grace with no foreign holder", () => {
    const { finding: f, ctx } = dead([LABELS.runLease(NOW - 2 * HOUR, "run-dead")]);
    expect(classifyDeadLease(f, ctx)).toEqual({
      disposition: "resume",
      why: "the run-lease expired with no foreign holder",
      epicBeadId: "e-1",
    });
  });

  it("holds when the bead is gone from the board", () => {
    const f = finding({ kind: "dead-lease", beadId: "e-9" });
    expect(classifyDeadLease(f, ctxOf()).why).toBe("the bead is gone from the board");
  });

  it("holds when the bead has since closed", () => {
    const f = finding({ kind: "dead-lease", beadId: "e-1" });
    const ctx = ctxOf({ board: new Map([["e-1", { ...openEpic("e-1"), status: "closed" }]]) });
    expect(classifyDeadLease(f, ctx).why).toBe("the bead has since closed");
  });

  it("holds when a live job on this machine already owns the run", () => {
    const { finding: f, ctx } = dead([LABELS.runLease(NOW - 2 * HOUR, "run-dead")], {
      activeEpicKeys: new Set(["p1::e-1"]),
    });
    expect(classifyDeadLease(f, ctx).why).toBe("a live job already owns this run");
  });

  it("holds when an operator cancelled the epic's job — a cancel is never reversed by a resume", () => {
    const { finding: f, ctx } = dead([LABELS.runLease(NOW - 2 * HOUR, "run-dead")], {
      epicCancelled: () => true,
    });
    expect(classifyDeadLease(f, ctx).why).toBe("this epic's latest job was cancelled by an operator");
  });

  it("holds when the lease has since been cleared — there is no dead run left to revive", () => {
    const { finding: f, ctx } = dead([]);
    expect(classifyDeadLease(f, ctx).why).toBe("the run-lease has since been cleared");
  });

  it("holds when the lease is live again — a machine picked the work back up after the sweep", () => {
    const { finding: f, ctx } = dead([LABELS.runLease(NOW + HOUR, "run-new")]);
    expect(classifyDeadLease(f, ctx).why).toBe("another machine holds a live run-lease");
  });

  it("holds a lease that lapsed inside the dead-lease grace the detector applies", () => {
    const { finding: f, ctx } = dead([LABELS.runLease(NOW - GRACE / 2, "run-slow")]);
    expect(classifyDeadLease(f, ctx).why).toBe(
      "the run-lease expired inside the dead-lease grace window",
    );
  });
});

describe("classifyStalePr — a PR nobody reviewed", () => {
  it("escalates one the live re-read still finds idle", () => {
    const f = finding({ kind: "stale-pr", beadId: "e-1", prNumber: 42, reason: "idle 3d" });
    expect(classifyStalePr(f, ctxOf())).toEqual({ disposition: "escalate", why: "idle 3d" });
  });

  it("holds one that merged, closed, or was picked back up since the sweep", () => {
    const f = finding({ kind: "stale-pr", beadId: "e-1", prNumber: 42 });
    expect(classifyStalePr(f, ctxOf({ stillStuck: () => false })).why).toBe(
      "the PR has since merged, closed, or been picked back up",
    );
  });
});

describe("classifyExhaustedJob — a job that spent its whole retry budget", () => {
  it("escalates one the live job row still reports as exhausted", () => {
    const f = finding({ kind: "exhausted-job", jobId: "j-1", reason: "retries spent" });
    expect(classifyExhaustedJob(f, ctxOf())).toEqual({
      disposition: "escalate",
      why: "retries spent",
    });
  });

  it("holds one an operator resumed between the sweep and now", () => {
    const f = finding({ kind: "exhausted-job", jobId: "j-1" });
    expect(classifyExhaustedJob(f, ctxOf({ stillStuck: () => false })).why).toBe(
      "the job has since been resumed or settled",
    );
  });

  it("holds one whose epic settled off-board, whose abandon would throw on the gone bead", () => {
    const f = finding({ kind: "exhausted-job", jobId: "j-1", beadId: "e-1" });
    const ctx = ctxOf({ board: new Map([["e-1", { ...openEpic("e-1"), status: "closed" }]]) });
    expect(classifyExhaustedJob(f, ctx).why).toBe("the epic has since closed");
  });
});

describe("classifyNeedsHuman — a run waiting on a person", () => {
  it("escalates a gate still waiting on somebody", () => {
    const f = finding({ kind: "needs-human", gateId: "g-1", reason: "Waiting on you" });
    expect(classifyNeedsHuman(f, ctxOf())).toEqual({
      disposition: "escalate",
      why: "Waiting on you",
    });
  });

  it("holds a gate answered in the gap between the sweep and this pass", () => {
    const f = finding({ kind: "needs-human", gateId: "g-1" });
    expect(classifyNeedsHuman(f, ctxOf({ stillStuck: () => false })).why).toBe(
      "the gate has since been resolved or removed",
    );
  });
});

describe("classifyFinding — the dispatch over every stuck shape", () => {
  it("routes each kind to its own classifier", () => {
    const run = parkedRun();
    const ctx = ctxOf({
      parkedRuns: new Map([[run.id, run]]),
      usageWindowEndsAt: () => NOW - HOUR,
      board: new Map([["e-1", openEpic("e-1", [LABELS.runLease(NOW - 2 * HOUR, "run-dead")])]]),
    });
    const of = (f: RunHealthFinding) => classifyFinding(f, ctx);
    expect(of(finding({ kind: "parked-run", runId: "run-1" }))).toMatchObject({
      disposition: "resume",
    });
    expect(of(finding({ kind: "dead-lease", beadId: "e-1" }))).toMatchObject({
      disposition: "resume",
    });
    expect(of(finding({ kind: "stale-pr", beadId: "e-1", prNumber: 42 }))).toMatchObject({
      disposition: "escalate",
    });
    expect(of(finding({ kind: "exhausted-job", jobId: "j-1" }))).toMatchObject({
      disposition: "escalate",
    });
    expect(of(finding({ kind: "needs-human", gateId: "g-1" }))).toMatchObject({
      disposition: "escalate",
    });
  });

  it("escalates a kind nobody taught it to judge rather than holding it silently", () => {
    // A kind the union does not carry yet — the shape a future detector adds before anyone teaches
    // the pass to judge it.
    const f = {
      ...finding({ kind: "parked-run" }),
      kind: "from-the-future",
    } as unknown as RunHealthFinding;
    expect(classifyFinding(f, ctxOf())).toEqual({
      disposition: "escalate",
      why: "the reported reason",
    });
  });
});
