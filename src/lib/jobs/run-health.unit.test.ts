/**
 * Unit tests for the run-health detectors (anton-4ks0) — the pure "what has stalled" logic, on a
 * FIXED clock and without db, bd, or gh. Each detector owns one stall class; the sweep is only ever
 * as trustworthy as these boundaries, so the tests hammer the edges (exactly-at-threshold, missing
 * reason, closed bead, live lease, attempts still on the clock).
 */
import { describe, expect, it } from "vitest";
import type { Bead } from "../beads/bd";
import { LABELS } from "../beads/bd";
import {
  detectDeadLeases,
  detectExhaustedJobs,
  detectParkedRuns,
  detectStalePrs,
  inReviewTargets,
  type InReviewPr,
} from "./run-health";
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
    worktreePath: null,
    branch: null,
    model: null,
    agentTag: null,
    status: "parked",
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
