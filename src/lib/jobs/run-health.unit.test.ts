/**
 * Unit tests for the run-health detectors (anton-4ks0) — the pure "what has stalled" logic, on a
 * FIXED clock and without db, bd, or gh. Each detector owns one stall class; the sweep is only ever
 * as trustworthy as these boundaries, so the tests hammer the edges (exactly-at-threshold, missing
 * reason, closed bead, live lease, attempts still on the clock).
 */
import { describe, expect, it } from "vitest";
import type { Bead, Gate } from "../beads/bd";
import { LABELS } from "../beads/bd";
import {
  detectDeadLeases,
  detectExhaustedJobs,
  detectOpenHumanGates,
  detectParkedRuns,
  detectStalePrs,
  inReviewTargets,
  settledExecuteEpicJobsByEpic,
  sweepOutcome,
  withoutGateBlockedJobs,
  type InReviewPr,
} from "./run-health";
import { blockedByPoison } from "./errors";
import { POISON_PARK_PREFIX } from "./runner";
import { sortFindings, type RunHealthFinding } from "../run-health";
import type { RunRow } from "../runs";
import type { JobRow } from "./queue";

/** A fixed "now" — every age in these tests is measured against this instant. */
const NOW = 1_700_000_000_000;
const MINUTE = 60_000;
const HOUR = 3_600_000;

function secDate(ms: number): Date {
  return new Date(Math.floor(ms / 1000) * 1000);
}

function run(id: string, o: Partial<RunRow> = {}): RunRow {
  return {
    id,
    projectId: "p1",
    epicBeadId: "e-1",
    ticketBeadId: null,
    jobId: null,
    writeSeq: null,
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
    error: null,
    startedAt: secDate(NOW - 4 * HOUR),
    endedAt: null,
    updatedAt: secDate(NOW - 4 * HOUR),
    ...o,
  };
}

function job(id: string, o: Partial<JobRow> = {}): JobRow {
  return {
    id,
    type: "execute-epic",
    projectId: "p1",
    payloadJson: JSON.stringify({ projectId: "p1", epicBeadId: "e-1" }),
    status: "parked",
    runAt: secDate(NOW - HOUR),
    leaseExpiresAt: null,
    attempts: 3,
    lastError: null,
    outcome: null,
    outcomeNote: null,
    createdAt: secDate(NOW - 4 * HOUR),
    updatedAt: secDate(NOW - HOUR),
    ...o,
  };
}

function bead(id: string, o: Partial<Bead> = {}): Bead {
  return { id, title: id, status: "open", issue_type: "epic", ...o };
}

describe("detectParkedRuns", () => {
  it("reports a run parked past the threshold, carrying its park reason and age", () => {
    const rows = [run("r-1", { error: "usage-limit", updatedAt: secDate(NOW - 3 * HOUR) })];

    const [finding, ...rest] = detectParkedRuns(rows, NOW, 2 * HOUR);

    expect(rest).toEqual([]);
    expect(finding).toMatchObject({ kind: "parked-run", key: "parked-run:r-1", runId: "r-1" });
    expect(finding.reason).toContain("usage-limit");
    expect(finding.ageMs).toBe(3 * HOUR);
    expect(finding.since).toBe(NOW - 3 * HOUR);
  });

  it("ignores runs inside the threshold and runs that aren't parked", () => {
    const rows = [
      run("young", { updatedAt: secDate(NOW - HOUR) }),
      run("exactly-at", { updatedAt: secDate(NOW - 2 * HOUR) }), // threshold is exclusive
      run("running", { status: "running", updatedAt: secDate(NOW - 10 * HOUR) }),
      run("done", { status: "done", updatedAt: secDate(NOW - 10 * HOUR) }),
    ];
    expect(detectParkedRuns(rows, NOW, 2 * HOUR)).toEqual([]);
  });

  it("says so plainly when a park recorded no reason, rather than reporting an empty one", () => {
    const rows = [run("r-1", { error: "  ", updatedAt: secDate(NOW - 3 * HOUR) })];
    expect(detectParkedRuns(rows, NOW, 2 * HOUR)[0].reason).toContain("no reason recorded");
  });

  it("links the ticket bead when the run was working one, else the epic", () => {
    const rows = [
      run("r-1", { ticketBeadId: "t-9", updatedAt: secDate(NOW - 3 * HOUR) }),
      run("r-2", { updatedAt: secDate(NOW - 3 * HOUR) }),
    ];
    expect(detectParkedRuns(rows, NOW, 2 * HOUR).map((f) => f.beadId)).toEqual(["t-9", "e-1"]);
  });

  it("carries the settled job behind the run, so an abandon can cancel it too", () => {
    const rows = [run("r-1", { updatedAt: secDate(NOW - 3 * HOUR) })];
    const jobs = settledExecuteEpicJobsByEpic([job("j-parked")]);

    expect(detectParkedRuns(rows, NOW, 2 * HOUR, jobs)[0].jobId).toBe("j-parked");
  });

  it("leaves the job pointer unset when the epic has no settled job to cancel", () => {
    const rows = [run("r-1", { updatedAt: secDate(NOW - 3 * HOUR) })];
    const jobs = settledExecuteEpicJobsByEpic([
      job("j-other", { payloadJson: JSON.stringify({ epicBeadId: "e-2" }) }),
    ]);

    expect(detectParkedRuns(rows, NOW, 2 * HOUR, jobs)[0].jobId).toBeUndefined();
  });
});

describe("settledExecuteEpicJobsByEpic", () => {
  it("keys execute-epic jobs by their epic, ignoring other job types", () => {
    const byEpic = settledExecuteEpicJobsByEpic([
      job("j-1"),
      job("j-2", { payloadJson: JSON.stringify({ epicBeadId: "e-2" }) }),
      job("j-push", { type: "sync-push", payloadJson: "{}" }),
    ]);

    expect([...byEpic.keys()].sort()).toEqual(["e-1", "e-2"]);
    expect(byEpic.get("e-1")!.id).toBe("j-1");
  });

  it("keeps the newest attempt, and breaks a same-second tie deterministically", () => {
    const older = job("j-old", { updatedAt: secDate(NOW - 3 * HOUR) });
    const newer = job("j-new", { updatedAt: secDate(NOW - HOUR) });
    expect(settledExecuteEpicJobsByEpic([newer, older]).get("e-1")!.id).toBe("j-new");
    expect(settledExecuteEpicJobsByEpic([older, newer]).get("e-1")!.id).toBe("j-new");

    // Timestamps are second-granular, so two jobs settled in the same second must not make the
    // report depend on row order — the sweep is upserted per project and has to converge.
    const tied = [job("j-a"), job("j-b")];
    expect(settledExecuteEpicJobsByEpic(tied).get("e-1")!.id).toBe("j-b");
    expect(settledExecuteEpicJobsByEpic([...tied].reverse()).get("e-1")!.id).toBe("j-b");
  });
});

describe("detectStalePrs", () => {
  const pr = (o: Partial<InReviewPr["activity"]> = {}): InReviewPr => ({
    beadId: "e-1",
    activity: {
      number: 42,
      state: "OPEN",
      url: "https://github.com/o/r/pull/42",
      updatedAtMs: NOW - 3 * 24 * HOUR,
      isDraft: false,
      ...o,
    },
  });

  it("reports an open PR idle past the threshold, with its number and url", () => {
    const [finding] = detectStalePrs([pr()], NOW, 24 * HOUR);
    expect(finding).toMatchObject({
      kind: "stale-pr",
      key: "stale-pr:e-1:42",
      beadId: "e-1",
      prNumber: 42,
      prUrl: "https://github.com/o/r/pull/42",
    });
    expect(finding.ageMs).toBe(3 * 24 * HOUR);
  });

  it("leaves merged and closed PRs alone — those are outcomes, not stalls", () => {
    const prs = [pr({ state: "MERGED" }), pr({ state: "CLOSED" })];
    expect(detectStalePrs(prs, NOW, 24 * HOUR)).toEqual([]);
  });

  it("ignores a PR touched inside the threshold", () => {
    expect(detectStalePrs([pr({ updatedAtMs: NOW - 2 * HOUR })], NOW, 24 * HOUR)).toEqual([]);
  });

  it("notes draft status in the reason so the operator can judge it", () => {
    expect(detectStalePrs([pr({ isDraft: true })], NOW, 24 * HOUR)[0].reason).toContain("draft");
  });
});

describe("detectDeadLeases", () => {
  const leased = (id: string, expiry: number, o: Partial<Bead> = {}) =>
    bead(id, { labels: [LABELS.runLease(expiry, "run-x")], ...o });

  it("reports a lease expired past the grace window with no job behind it", () => {
    const board = [leased("e-1", NOW - 2 * HOUR)];

    const [finding] = detectDeadLeases(board, new Set(), {
      projectId: "p1",
      nowMs: NOW,
      graceMs: 30 * MINUTE,
    });

    expect(finding).toMatchObject({ kind: "dead-lease", key: "dead-lease:e-1", beadId: "e-1" });
    expect(finding.since).toBe(NOW - 2 * HOUR);
    expect(finding.ageMs).toBe(2 * HOUR);
  });

  it("leaves a still-live lease and one inside the grace window alone", () => {
    const board = [leased("live", NOW + HOUR), leased("grace", NOW - 10 * MINUTE)];
    const findings = detectDeadLeases(board, new Set(), {
      projectId: "p1",
      nowMs: NOW,
      graceMs: 30 * MINUTE,
    });
    expect(findings).toEqual([]);
  });

  it("skips a bead an active execute-epic job will resume — that run is coming back", () => {
    const board = [leased("e-1", NOW - 2 * HOUR)];
    const findings = detectDeadLeases(board, new Set(["p1::e-1"]), {
      projectId: "p1",
      nowMs: NOW,
      graceMs: 30 * MINUTE,
    });
    expect(findings).toEqual([]);
  });

  it("keys the active-job check per project, so another project's job doesn't mask a stall", () => {
    const board = [leased("e-1", NOW - 2 * HOUR)];
    const findings = detectDeadLeases(board, new Set(["other::e-1"]), {
      projectId: "p1",
      nowMs: NOW,
      graceMs: 30 * MINUTE,
    });
    expect(findings.map((f) => f.beadId)).toEqual(["e-1"]);
  });

  it("skips closed beads and beads with no lease at all", () => {
    const board = [
      leased("closed", NOW - 2 * HOUR, { status: "closed" }),
      bead("no-lease", { labels: ["approved"] }),
    ];
    expect(
      detectDeadLeases(board, new Set(), { projectId: "p1", nowMs: NOW, graceMs: 30 * MINUTE }),
    ).toEqual([]);
  });

  it("links the bead's PR when it has one", () => {
    const board = [leased("e-1", NOW - 2 * HOUR, { metadata: { pr: "gh-7" } })];
    const [finding] = detectDeadLeases(board, new Set(), {
      projectId: "p1",
      nowMs: NOW,
      graceMs: 30 * MINUTE,
    });
    expect(finding.prNumber).toBe(7);
  });
});

describe("detectExhaustedJobs", () => {
  it("reports a parked job that spent its whole attempt budget, with error and epic link", () => {
    const [finding] = detectExhaustedJobs([job("j-1", { lastError: "tests failed" })], 3, NOW);
    expect(finding).toMatchObject({
      kind: "exhausted-job",
      key: "exhausted-job:j-1",
      jobId: "j-1",
      beadId: "e-1",
    });
    expect(finding.reason).toContain("tests failed");
    expect(finding.reason).toContain("3/3 attempts");
  });

  it("ignores a job parked with attempts still on the clock — those come back on their own", () => {
    // A quota/lease park refunds the attempt, so it is NOT exhausted.
    expect(detectExhaustedJobs([job("j-1", { attempts: 1 })], 3, NOW)).toEqual([]);
  });

  it("keeps reporting a job that exhausted an OLDER budget after maxRetries is raised", () => {
    // Raising the setting doesn't restart a parked job — nothing re-dispatches one — so judging it
    // against today's value alone would hide permanently stuck work. The runner's `failed N×:` park
    // marker is the durable evidence of the budget it actually gave up under. Especially load-
    // bearing for a non-execute job like `sync-push`, which strands no parked run for the other
    // detectors to catch.
    const [finding] = detectExhaustedJobs(
      [job("j-1", { type: "sync-push", attempts: 3, lastError: "failed 3×: push rejected" })],
      10,
      NOW,
    );
    expect(finding).toMatchObject({ kind: "exhausted-job", jobId: "j-1" });
    // Reported against the budget it spent, not the new one: "3/10" would read as retries left.
    expect(finding.reason).toContain("3/3 attempts");
    expect(finding.reason).toContain("push rejected");
  });

  it("still ignores a mid-budget park that carries no exhaustion marker", () => {
    // A quota backoff records `usage-limit: resumes at …` and refunds the attempt — no marker, so
    // the current budget is the only bar, and it is not met.
    const jobs = [job("j-1", { attempts: 1, lastError: "usage-limit: resumes at 2026-01-01T00:00:00Z" })];
    expect(detectExhaustedJobs(jobs, 3, NOW)).toEqual([]);
  });

  it("reports a POISON park regardless of attempts — it skipped the retry budget entirely", () => {
    // execute-epic poisons on a blocker, a disabled agent, a contract gap: permanent conditions the
    // runner parks on at attempt 1. Several fire before a run row exists, so if the attempt count
    // gated this finding, nothing would surface work that is waiting on a human forever.
    const [finding] = detectExhaustedJobs(
      [job("j-1", { attempts: 1, lastError: "poison: agent 'svelte' is disabled for this project" })],
      3,
      NOW,
    );
    expect(finding).toMatchObject({ kind: "exhausted-job", jobId: "j-1" });
    expect(finding.reason).toContain("agent 'svelte' is disabled");
    expect(finding.reason).toContain("without retrying");
    expect(finding.reason).not.toContain("1/3 attempts");
  });

  it("ignores jobs that are still live or already terminal-good", () => {
    const jobs = [
      job("queued", { status: "queued", attempts: 5 }),
      job("running", { status: "running", attempts: 5 }),
      job("done", { status: "done", attempts: 5 }),
      job("cancelled", { status: "cancelled", attempts: 5 }),
    ];
    expect(detectExhaustedJobs(jobs, 3, NOW)).toEqual([]);
  });

  it("covers failed jobs too, and tolerates a payload with no epic", () => {
    const [finding] = detectExhaustedJobs(
      [job("j-1", { status: "failed", type: "sync-push", payloadJson: "{not json" })],
      3,
      NOW,
    );
    expect(finding).toMatchObject({ kind: "exhausted-job", jobId: "j-1", beadId: undefined });
    expect(finding.reason).toContain("sync-push");
  });
});

describe("detectOpenHumanGates", () => {
  /** A gate bead as `bd gate list --json` returns it — reason INSIDE the description, as bd stores it. */
  function gate(id: string, o: Partial<Gate> = {}): Gate {
    return {
      id,
      title: "Gate: human",
      status: "open",
      issue_type: "gate",
      await_type: "human",
      description: "Ad-hoc gate blocking t-1\n\nReason: needs a design call",
      created_at: new Date(NOW - 3 * HOUR).toISOString(),
      ...o,
    };
  }

  /** A ticket gated under a feature — the shape a resume has to climb out of. */
  const gatedBoard = (gateId = "g-1"): Bead[] => [
    bead("f-1", { issue_type: "feature" }),
    bead("t-1", {
      issue_type: "task",
      parent: "f-1",
      dependencies: [{ issue_id: "t-1", depends_on_id: gateId, type: "blocks" }],
    }),
  ];

  it("reports an open human gate, with its reason, its age, and what it blocks", () => {
    const [finding, ...rest] = detectOpenHumanGates([gate("g-1")], gatedBoard(), NOW);

    expect(rest).toEqual([]);
    expect(finding).toMatchObject({
      kind: "needs-human",
      key: "needs-human:g-1",
      gateId: "g-1",
      // The bead the wait is ON, and the bead a resume would re-enqueue — the feature above it,
      // never the gated ticket, which anton never dispatches on its own.
      beadId: "t-1",
      targetBeadId: "f-1",
    });
    expect(finding.reason).toContain("needs a design call");
    expect(finding.since).toBe(NOW - 3 * HOUR);
    expect(finding.ageMs).toBe(3 * HOUR);
  });

  it("says so plainly when the gate carries no reason, rather than reporting nothing", () => {
    const bare = gate("g-1", { description: "Ad-hoc gate blocking t-1" });

    const [finding] = detectOpenHumanGates([bare], gatedBoard(), NOW);

    expect(finding).toMatchObject({ kind: "needs-human", gateId: "g-1" });
    expect(finding.reason).toContain("no reason recorded");
  });

  it("ignores a closed gate — that wait is over", () => {
    expect(detectOpenHumanGates([gate("g-1", { status: "closed" })], gatedBoard(), NOW)).toEqual([]);
  });

  it("ignores the gates bd resolves by itself — only a human gate needs a human", () => {
    const machine: Gate[] = [
      gate("g-timer", { await_type: "timer" }),
      gate("g-run", { await_type: "gh:run" }),
      gate("g-pr", { await_type: "gh:pr" }),
    ];
    expect(detectOpenHumanGates(machine, gatedBoard("g-timer"), NOW)).toEqual([]);
  });

  it("still reports a gate whose blocked bead has no run target above it", () => {
    // A gated step of a poured molecule: `runTargetAbove` stops at the plumbing, so anton has
    // nothing to re-enqueue — but a person is still being waited on, which is the whole finding.
    const board = [
      bead("m-1", { issue_type: "molecule" }),
      bead("s-1", {
        issue_type: "task",
        parent: "m-1",
        dependencies: [{ issue_id: "s-1", depends_on_id: "g-1", type: "blocks" }],
      }),
    ];

    const [finding] = detectOpenHumanGates([gate("g-1")], board, NOW);

    expect(finding).toMatchObject({ kind: "needs-human", beadId: "s-1" });
    expect(finding.targetBeadId).toBeUndefined();
  });

  it("still reports a gate whose blocked bead this board read doesn't carry", () => {
    const [finding] = detectOpenHumanGates([gate("g-1")], [], NOW);
    expect(finding).toMatchObject({ kind: "needs-human", gateId: "g-1" });
    expect(finding.beadId).toBeUndefined();
    expect(finding.targetBeadId).toBeUndefined();
  });

  it("reads a gate with no timestamp as new, not as a 1970 stall", () => {
    const [finding] = detectOpenHumanGates(
      [gate("g-1", { created_at: undefined })],
      gatedBoard(),
      NOW,
    );
    expect(finding.since).toBe(NOW);
    expect(finding.ageMs).toBe(0);
  });

  it("serializes identically over two sweeps of unchanged state, whatever order bd lists gates in", () => {
    const gates = [gate("g-2"), gate("g-1")];
    const board = gatedBoard();

    const first = sortFindings(detectOpenHumanGates(gates, board, NOW));
    const second = sortFindings(detectOpenHumanGates([...gates].reverse(), board, NOW));

    expect(first.map((f) => f.key)).toEqual(["needs-human:g-1", "needs-human:g-2"]);
    expect(JSON.stringify(second)).toEqual(JSON.stringify(first));
  });

  it("keeps the key stable as the wait ages, so one wait is one escalation", () => {
    // The sweep re-runs on a schedule and the escalation table dedupes on this key alone — a key
    // that moved with the clock (or with the age in the reason) would raise a fresh escalation
    // every single pass.
    const later = sortFindings(detectOpenHumanGates([gate("g-1")], gatedBoard(), NOW + 12 * HOUR));

    expect(later.map((f) => f.key)).toEqual(["needs-human:g-1"]);
    expect(later[0].ageMs).toBe(15 * HOUR);
  });
});

describe("inReviewTargets", () => {
  const IN_REVIEW = LABELS.stage("in-review");

  it("selects open in-review run targets carrying a PR pointer", () => {
    const board = [
      bead("with-pr", { labels: [IN_REVIEW], metadata: { pr: "gh-3" } }),
      bead("no-pr", { labels: [IN_REVIEW] }),
      bead("not-in-review", { metadata: { pr: "gh-4" } }),
      bead("closed", { status: "closed", labels: [IN_REVIEW], metadata: { pr: "gh-5" } }),
    ];
    expect(inReviewTargets(board)).toEqual([{ bead: board[0], prNumber: 3 }]);
  });

  it("skips a container epic someone PR-linked by hand — its children own the review", () => {
    // An epic with a `feature` child is a container: the feature opens the PR, not the epic.
    const container = bead("container", { labels: [IN_REVIEW], metadata: { pr: "gh-9" } });
    const board = [
      container,
      bead("feat", { issue_type: "feature", parent: "container" }),
    ];
    expect(inReviewTargets(board)).toEqual([]);
  });
});

describe("withoutGateBlockedJobs", () => {
  /** The park a run takes when execute-epic's readiness re-check finds an open blocker. */
  function blockedPark(...blockers: string[]): JobRow {
    return job("j-1", {
      attempts: 1,
      lastError: `${POISON_PARK_PREFIX} ${blockedByPoison("e-1", blockers).message}`,
    });
  }

  const gateWait = (gateId: string): RunHealthFinding => ({
    kind: "needs-human",
    key: `needs-human:${gateId}`,
    reason: "waiting on a human 3h: needs a design call",
    since: NOW - 3 * HOUR,
    ageMs: 3 * HOUR,
    gateId,
  });

  it("drops the job a gate poison-parked — one wait must not raise two escalations", () => {
    // A gate hung after the job was queued parks it on that gate, so both detectors see the SAME
    // stall. Reported twice, resolve-and-resume settles only the gate row and leaves the "retries
    // spent" one open as a false failure with a stale Abandon on it.
    const findings = [
      ...detectExhaustedJobs([blockedPark("g-1")], 3, NOW),
      gateWait("g-1"),
    ];
    expect(withoutGateBlockedJobs(findings).map((f) => f.kind)).toEqual(["needs-human"]);
  });

  it("keeps a job also held by an ordinary prerequisite — answering the gate won't free it", () => {
    const findings = [
      ...detectExhaustedJobs([blockedPark("g-1", "anton-dep")], 3, NOW),
      gateWait("g-1"),
    ];
    expect(withoutGateBlockedJobs(findings).map((f) => f.kind)).toEqual([
      "exhausted-job",
      "needs-human",
    ]);
  });

  it("keeps a job blocked by a DIFFERENT gate than the one waiting on a human", () => {
    const findings = [...detectExhaustedJobs([blockedPark("g-2")], 3, NOW), gateWait("g-1")];
    expect(withoutGateBlockedJobs(findings)).toHaveLength(2);
  });

  it("keeps every other poison park — only a blocker refusal is the gate's own wait", () => {
    const other = job("j-2", {
      attempts: 1,
      lastError: `${POISON_PARK_PREFIX} agent 'svelte' is disabled for this project`,
    });
    const findings = [...detectExhaustedJobs([other], 3, NOW), gateWait("g-1")];
    expect(withoutGateBlockedJobs(findings)).toHaveLength(2);
  });

  it("reports the blocked job again once the gate is gone — nothing else surfaces it", () => {
    // The mirror case: a gate resolved off-board (`bd gate resolve`) with no resume leaves the job
    // parked, and with no gate wait left to speak for it the finding has to come back.
    const findings = detectExhaustedJobs([blockedPark("g-1")], 3, NOW);
    expect(withoutGateBlockedJobs(findings).map((f) => f.kind)).toEqual(["exhausted-job"]);
  });
});

describe("sweepOutcome", () => {
  it("calls a complete sweep with nothing wrong a clean bill of health", () => {
    expect(sweepOutcome(0, 0)).toEqual({ changed: false, note: "no stalls found" });
  });

  it("refuses to claim 'no stalls' for a sweep that never checked every PR", () => {
    // A `gh` read that failed (unauthenticated, rate-limited) means that PR was never checked for
    // staleness — reporting the pass as clean would be a false all-clear.
    const effect = sweepOutcome(0, 2);
    expect(effect.changed).toBe(false);
    expect(effect.note).toContain("partial sweep");
    expect(effect.note).toContain("2 PR check(s) skipped");
  });

  it("carries the skipped count beside the findings a partial sweep did produce", () => {
    expect(sweepOutcome(3, 1)).toEqual({
      changed: true,
      note: "3 finding(s); 1 PR check(s) skipped",
    });
  });

  it("says nothing about skips when there were none", () => {
    expect(sweepOutcome(3, 0)).toEqual({ changed: true, note: "3 finding(s)" });
  });
});
