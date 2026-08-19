/**
 * The three answers themselves — resume, abandon, dismiss — plus the project scoping and the guard
 * that decides which of them the panel may even send (anton-wvcy).
 *
 * The property under test is the ORDER: settle first, act second. Every sibling suite inherits the
 * same sandbox from `escalation-actions.fixture.ts`; this one covers the plain paths, where nothing
 * has moved under the escalation since the sweep froze it.
 */
import { describe, expect, it } from "vitest";

import type { Project } from "./types";
import {
  resumeStalledEpic,
  abandonTicket,
  cancelJob,
  actOnEscalation,
  isEscalationAction,
  getDb,
  settleEscalation,
  clock,
  project,
  finding,
  open,
  seedParkedRun,
  rowOf,
  runOf,
} from "./escalation-actions.fixture";

describe("actOnEscalation — resume", () => {
  it("re-enqueues the finding's EPIC and records the answer", async () => {
    const escalation = await open();

    const result = await actOnEscalation(project, escalation.id, "resume");

    expect(result).toMatchObject({ ok: true, action: "resume", detail: "enqueued" });
    // The epic, not the ticket bead the finding names — jobs are keyed by epic.
    expect(resumeStalledEpic).toHaveBeenCalledWith("p1", "anton-e1");
    expect(rowOf(escalation.id)).toMatchObject({ status: "resolved", resolution: "resumed" });
  });

  it("resumes ONCE when two clicks race — the loser is refused, not queued", async () => {
    const escalation = await open();

    const [a, b] = await Promise.all([
      actOnEscalation(project, escalation.id, "resume"),
      actOnEscalation(project, escalation.id, "resume"),
    ]);

    expect([a.ok, b.ok].filter(Boolean)).toHaveLength(1);
    expect(resumeStalledEpic).toHaveBeenCalledTimes(1);
    const loser = a.ok ? b : a;
    expect(loser).toEqual({ ok: false, reason: "not-open" });
  });

  it("refuses an escalation someone already settled", async () => {
    const escalation = await open();
    await settleEscalation(getDb(), clock, escalation.id, "abandoned");

    expect(await actOnEscalation(project, escalation.id, "resume")).toEqual({
      ok: false,
      reason: "not-open",
    });
    expect(resumeStalledEpic).not.toHaveBeenCalled();
  });

  it("refuses — without settling — when the finding names no epic to re-enqueue", async () => {
    const escalation = await open({ epicBeadId: undefined });

    expect(await actOnEscalation(project, escalation.id, "resume")).toEqual({
      ok: false,
      reason: "no-target",
    });
    // Still open: an escalation nothing can act on must stay visible rather than silently resolve.
    expect(rowOf(escalation.id)?.status).toBe("open");
  });
});

describe("actOnEscalation — abandon", () => {
  it("closes the finding's BEAD with the escalation's own evidence as the reason", async () => {
    const escalation = await open();

    const result = await actOnEscalation(project, escalation.id, "abandon");

    expect(result).toMatchObject({ ok: true, action: "abandon", detail: "abandoned" });
    const [, target, reason] = abandonTicket.mock.calls[0]!;
    expect(target).toBe("anton-t9"); // the stalled ticket, not the epic
    expect(reason).toContain("parked 4h ago: agent exited 1");
    expect(reason).toContain("parked-run");
    expect(rowOf(escalation.id)).toMatchObject({ status: "resolved", resolution: "abandoned" });
  });

  it("caps the recorded reason at bd's limit", async () => {
    const { MAX_ABANDON_REASON_CHARS } = await import("./types");
    const escalation = await open({ finding: finding({ reason: "x".repeat(2000) }) });

    await actOnEscalation(project, escalation.id, "abandon");

    expect(abandonTicket.mock.calls[0]![2].length).toBeLessThanOrEqual(MAX_ABANDON_REASON_CHARS);
  });

  it("refuses when the finding names no bead to close", async () => {
    const escalation = await open({ finding: finding({ beadId: undefined }) });

    expect(await actOnEscalation(project, escalation.id, "abandon")).toEqual({
      ok: false,
      reason: "no-target",
    });
    expect(abandonTicket).not.toHaveBeenCalled();
  });

  // `abandonTicket` kills only an ACTIVE (queued/running) job, but an escalation is raised precisely
  // against work that already stopped. Without these settles the bead closes while the local rows
  // stay exactly as the detectors see them, so the next sweep escalates an already-abandoned target.
  it("settles the parked RUN the escalation was raised against", async () => {
    seedParkedRun("r-1");
    const escalation = await open();

    expect(await actOnEscalation(project, escalation.id, "abandon")).toMatchObject({ ok: true });

    const run = runOf("r-1");
    expect(run?.status).toBe("failed"); // no longer a `detectParkedRuns` candidate
    expect(run?.error).toContain("parked 4h ago: agent exited 1");
    expect(run?.endedAt).toBeTruthy();
  });

  it("leaves a run that is no longer parked alone — the operator may have restarted it", async () => {
    seedParkedRun("r-1", "running");
    const escalation = await open();

    await actOnEscalation(project, escalation.id, "abandon");

    expect(runOf("r-1")?.status).toBe("running");
  });

  it("stops the parked/failed JOB an exhausted-job escalation names, alongside closing its bead", async () => {
    const escalation = await open({
      finding: finding({
        kind: "exhausted-job",
        key: "exhausted-job:j-1",
        runId: undefined,
        jobId: "j-1",
      }),
    });

    expect(await actOnEscalation(project, escalation.id, "abandon")).toMatchObject({ ok: true });

    expect(abandonTicket).toHaveBeenCalled();
    expect(cancelJob).toHaveBeenCalledWith("p1", "j-1", ["parked", "failed"]);
  });

  it("touches no run or job when the escalation names neither", async () => {
    const escalation = await open({ finding: finding({ runId: undefined }) });

    await actOnEscalation(project, escalation.id, "abandon");

    expect(cancelJob).not.toHaveBeenCalled();
  });
});

describe("actOnEscalation — dismiss", () => {
  // The answer for a stall anton has no verb for. A stale PR's work is already delivered and open
  // for review, so a "resume" would settle the row and change nothing about the PR — the panel must
  // not offer a resolution that resolves nothing.
  const stalePr = () =>
    finding({
      kind: "stale-pr",
      key: "stale-pr:anton-t9:42",
      reason: "PR #42 idle 3d with the target still in review",
      runId: undefined,
      prNumber: 42,
    });

  it("settles the row and touches neither the work nor the job", async () => {
    const escalation = await open({ finding: stalePr() });

    const result = await actOnEscalation(project, escalation.id, "dismiss");

    expect(result).toMatchObject({ ok: true, action: "dismiss", detail: "dismissed" });
    expect(rowOf(escalation.id)).toMatchObject({ status: "resolved", resolution: "dismissed" });
    expect(resumeStalledEpic).not.toHaveBeenCalled();
    expect(abandonTicket).not.toHaveBeenCalled();
    expect(cancelJob).not.toHaveBeenCalled();
  });

  it("needs no target at all — it is the settling move for a finding that names nothing", async () => {
    const escalation = await open({
      finding: finding({ beadId: undefined, runId: undefined }),
      epicBeadId: undefined,
    });

    expect(await actOnEscalation(project, escalation.id, "dismiss")).toMatchObject({ ok: true });
  });

  it("refuses a second dismissal, like every other answer", async () => {
    const escalation = await open({ finding: stalePr() });
    await actOnEscalation(project, escalation.id, "dismiss");

    expect(await actOnEscalation(project, escalation.id, "dismiss")).toEqual({
      ok: false,
      reason: "not-open",
    });
  });
});

describe("actOnEscalation — scoping", () => {
  it("reports not-found for an unknown id", async () => {
    expect(await actOnEscalation(project, "nope", "resume")).toEqual({
      ok: false,
      reason: "not-found",
    });
  });

  it("cannot settle another project's escalation by id", async () => {
    const escalation = await open();
    const other = { ...project, id: "p2" } as Project;

    expect(await actOnEscalation(other, escalation.id, "resume")).toEqual({
      ok: false,
      reason: "not-found",
    });
    expect(rowOf(escalation.id)?.status).toBe("open");
  });
});

describe("isEscalationAction", () => {
  it("accepts only the verbs the panel offers", () => {
    expect(["resume", "abandon", "dismiss"].every(isEscalationAction)).toBe(true);
    for (const bad of ["retry", "", null, undefined, 1, {}]) {
      expect(isEscalationAction(bad)).toBe(false);
    }
  });
});
