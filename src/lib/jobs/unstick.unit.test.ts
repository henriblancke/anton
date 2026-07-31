/**
 * Unit tests for the unstick classifier (anton-wvcy) — the pure "resume, escalate, or hold" decision,
 * on a FIXED clock and without db, bd, or a runner.
 *
 * This is the safety boundary of the whole feature: everything it calls `resume` gets restarted with
 * no human in the loop, so the tests hammer the cases where a resume would be WRONG — a stale
 * finding, a live job that already owns the work, a quota window that hasn't reopened yet, a lease
 * another machine has since re-taken. A missed escalation costs one glance; a wrong auto-resume
 * burns quota re-running work that will fail the same way.
 */
import { describe, expect, it } from "vitest";
import { LABELS, type Bead } from "../beads/bd";
import type { RunHealthFinding } from "../run-health";
import type { RunRow } from "../runs";
import { classifyFinding, escalationNote, usageWindowEnd, type UnstickContext } from "./unstick";

const NOW = 1_700_000_000_000;
const HOUR = 3_600_000;

function secDate(ms: number): Date {
  return new Date(Math.floor(ms / 1000) * 1000);
}

function run(o: Partial<RunRow> = {}): RunRow {
  return {
    id: "r-1",
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
    error: "usage-limit",
    startedAt: secDate(NOW - 4 * HOUR),
    endedAt: null,
    updatedAt: secDate(NOW - 4 * HOUR),
    ...o,
  };
}

function bead(id: string, o: Partial<Bead> = {}): Bead {
  return { id, title: id, status: "open", issue_type: "epic", labels: [], ...o };
}

function finding(o: Partial<RunHealthFinding> = {}): RunHealthFinding {
  return {
    kind: "parked-run",
    key: "parked-run:r-1",
    reason: "parked 4h ago: usage-limit",
    since: NOW - 4 * HOUR,
    ageMs: 4 * HOUR,
    runId: "r-1",
    beadId: "e-1",
    ...o,
  };
}

function ctx(o: Partial<UnstickContext> = {}): UnstickContext {
  return {
    projectId: "p1",
    nowMs: NOW,
    activeEpicKeys: new Set<string>(),
    parkedRuns: new Map([["r-1", run()]]),
    board: new Map<string, Bead>(),
    boardFresh: true,
    usageWindowEndsAt: () => undefined,
    stillStuck: () => true,
    ...o,
  };
}

describe("classifyFinding — parked runs", () => {
  it("resumes a usage-limit park whose quota window has passed", () => {
    const verdict = classifyFinding(finding(), ctx({ usageWindowEndsAt: () => NOW - HOUR }));
    expect(verdict).toMatchObject({ disposition: "resume", epicBeadId: "e-1" });
  });

  it("resumes when nothing ever recorded a window — an unknown window is a passed one", () => {
    // The runner only writes a `resumes at` marker while the quota is actually held; its absence on
    // a park this old means the backoff already elapsed and was cleared.
    expect(classifyFinding(finding(), ctx()).disposition).toBe("resume");
  });

  it("HOLDS a usage-limit park whose window has not reopened yet — it resumes itself", () => {
    // The single most important non-action: this run is not stuck, it is waiting. Escalating it
    // would nag the founder about something that fixes itself; resuming it would burn the retry
    // against a quota that is still closed.
    const verdict = classifyFinding(finding(), ctx({ usageWindowEndsAt: () => NOW + HOUR }));
    expect(verdict.disposition).toBe("hold");
    expect(verdict.why).toContain(new Date(NOW + HOUR).toISOString());
  });

  it("escalates a park with any other reason — those are judgment calls", () => {
    const verdict = classifyFinding(
      finding({ reason: "parked 4h ago: agent exited 1" }),
      ctx({ parkedRuns: new Map([["r-1", run({ error: "agent exited 1" })]]) }),
    );
    expect(verdict).toMatchObject({ disposition: "escalate", why: "parked 4h ago: agent exited 1" });
  });

  it("escalates a park that recorded no reason at all", () => {
    const verdict = classifyFinding(
      finding(),
      ctx({ parkedRuns: new Map([["r-1", run({ error: null })]]) }),
    );
    expect(verdict.disposition).toBe("escalate");
  });

  it("holds a finding whose run is no longer parked — the report is a candidate list, not truth", () => {
    const verdict = classifyFinding(finding(), ctx({ parkedRuns: new Map() }));
    expect(verdict).toMatchObject({ disposition: "hold" });
    expect(verdict.why).toContain("no longer parked");
  });

  it("never touches a run a live job already owns", () => {
    const verdict = classifyFinding(
      finding(),
      ctx({ activeEpicKeys: new Set(["p1::e-1"]) }),
    );
    expect(verdict.disposition).toBe("hold");
  });

  it("keys the live-job check per project, so another project's job can't mask a stall", () => {
    const verdict = classifyFinding(finding(), ctx({ activeEpicKeys: new Set(["other::e-1"]) }));
    expect(verdict.disposition).toBe("resume");
  });

  it("stands down when another machine took the epic while this run sat parked", () => {
    // Jobs are machine-local, so the live-job check above can't see the other machine's run — the
    // lease on the epic is the only evidence, and resuming past it double-runs the work.
    const verdict = classifyFinding(
      finding(),
      ctx({ board: new Map([["e-1", bead("e-1", { labels: [LABELS.runLease(NOW + HOUR, "run-x")] })]]) }),
    );
    expect(verdict.disposition).toBe("hold");
    expect(verdict.why).toContain("live run-lease");
  });

  it("resumes past this run's OWN leftover lease — reviving it is not double-running it", () => {
    // execute-epic publishes the lease under the run id, so a lease owned by the very run we are
    // reviving is a crash leftover, not a foreign holder.
    const verdict = classifyFinding(
      finding(),
      ctx({ board: new Map([["e-1", bead("e-1", { labels: [LABELS.runLease(NOW + HOUR, "r-1")] })]]) }),
    );
    expect(verdict.disposition).toBe("resume");
  });

  it("targets the RUN's epic, not the ticket bead the finding names", () => {
    // Jobs are keyed by epic; resuming the ticket id would enqueue work for a bead with no job.
    const verdict = classifyFinding(
      finding({ beadId: "t-9" }),
      ctx({ parkedRuns: new Map([["r-1", run({ ticketBeadId: "t-9", epicBeadId: "e-7" })]]) }),
    );
    expect(verdict.epicBeadId).toBe("e-7");
  });
});

describe("classifyFinding — dead leases", () => {
  const leased = (expiresAtMs: number, o: Partial<Bead> = {}) =>
    bead("e-1", { labels: [LABELS.runLease(expiresAtMs, "run-x")], ...o });

  const withBoard = (b: Bead, o: Partial<UnstickContext> = {}) =>
    ctx({ board: new Map([[b.id, b]]), ...o });

  const deadLease = finding({ kind: "dead-lease", key: "dead-lease:e-1", runId: undefined });

  it("resumes an expired lease with no foreign holder — the owning machine died", () => {
    const verdict = classifyFinding(deadLease, withBoard(leased(NOW - 2 * HOUR)));
    expect(verdict).toMatchObject({ disposition: "resume", epicBeadId: "e-1" });
  });

  it("stands down when another machine holds a LIVE lease — double-running is the one unsafe act", () => {
    // The sweep saw the lease expired; between then and now someone re-took it. Resuming here would
    // run the epic twice, which is exactly what the lease exists to prevent.
    const verdict = classifyFinding(deadLease, withBoard(leased(NOW + HOUR)));
    expect(verdict.disposition).toBe("hold");
    expect(verdict.why).toContain("live run-lease");
  });

  it("holds a bead that has since closed or vanished from the board", () => {
    expect(classifyFinding(deadLease, withBoard(leased(NOW - HOUR, { status: "closed" })))
      .disposition).toBe("hold");
    expect(classifyFinding(deadLease, ctx()).disposition).toBe("hold");
  });

  it("never touches a bead a live job already owns", () => {
    const verdict = classifyFinding(
      deadLease,
      withBoard(leased(NOW - 2 * HOUR), { activeEpicKeys: new Set(["p1::e-1"]) }),
    );
    expect(verdict.disposition).toBe("hold");
  });
});

describe("classifyFinding — an untrusted board fails CLOSED", () => {
  // The pass reads leases off a local Dolt mirror of the shared board. When the pull fails, that
  // mirror can be arbitrarily behind, so "no live lease" is no longer evidence of anything — and the
  // only wrong answer that costs more than an hour of stall is the one that double-runs.
  const stale = (o: Partial<UnstickContext> = {}) => ctx({ boardFresh: false, ...o });

  it("holds a parked run rather than resuming against lease state it cannot confirm", () => {
    const verdict = classifyFinding(finding(), stale());
    expect(verdict.disposition).toBe("hold");
    expect(verdict.why).toContain("could not be pulled");
  });

  it("holds a dead lease rather than resuming against lease state it cannot confirm", () => {
    const deadLease = finding({ kind: "dead-lease", key: "dead-lease:e-1", runId: undefined });
    const board = new Map([["e-1", bead("e-1", { labels: [LABELS.runLease(NOW - HOUR, "run-x")] })]]);
    expect(classifyFinding(deadLease, stale({ board })).disposition).toBe("hold");
  });

  it("still escalates — an escalation touches no shared state, so a stale board can't make it wrong", () => {
    const verdict = classifyFinding(
      finding({ reason: "parked 4h ago: agent exited 1" }),
      stale({ parkedRuns: new Map([["r-1", run({ error: "agent exited 1" })]]) }),
    );
    expect(verdict.disposition).toBe("escalate");
  });
});

describe("classifyFinding — the never-automatic kinds", () => {
  it.each(["stale-pr", "exhausted-job"] as const)(
    "escalates %s rather than retrying it",
    (kind) => {
      // A PR nobody reviewed needs a reviewer; a job that spent its whole retry budget already
      // proved that retrying does not fix it.
      const verdict = classifyFinding(
        finding({ kind, key: `${kind}:x`, reason: "no activity for 3d" }),
        ctx(),
      );
      expect(verdict).toMatchObject({ disposition: "escalate", why: "no activity for 3d" });
    },
  );

  it("holds a stale PR that has since merged, closed, or been picked back up", () => {
    // The report is a candidate list here too: escalating a PR that moved asks the founder to judge
    // work that is already done, and the abandon they might click closes it as won't-do.
    const verdict = classifyFinding(
      finding({ kind: "stale-pr", key: "stale-pr:e-1:42", prNumber: 42 }),
      ctx({ stillStuck: () => false }),
    );
    expect(verdict.disposition).toBe("hold");
    expect(verdict.why).toContain("merged");
  });

  it("holds an exhausted job that has since been resumed — abandoning it would cancel live work", () => {
    const verdict = classifyFinding(
      finding({ kind: "exhausted-job", key: "exhausted-job:j-1", jobId: "j-1" }),
      ctx({ stillStuck: () => false }),
    );
    expect(verdict.disposition).toBe("hold");
    expect(verdict.why).toContain("resumed");
  });
});

describe("usageWindowEnd", () => {
  const job = (o: { lastError?: string | null; runAt?: unknown } = {}) => ({
    lastError: o.lastError ?? null,
    runAt: "runAt" in o ? o.runAt : secDate(NOW + HOUR),
  });

  it("prefers the lastError marker — it survives a later runAt change", () => {
    const at = new Date(NOW + 3 * HOUR).toISOString();
    expect(usageWindowEnd(job({ lastError: `usage-limit: resumes at ${at}` }))).toBe(NOW + 3 * HOUR);
  });

  it("falls back to runAt when the error text was overwritten by a later settle", () => {
    expect(usageWindowEnd(job({ lastError: "some other failure" }))).toBe(NOW + HOUR);
  });

  it("falls back to runAt when the marker holds an unparseable date", () => {
    expect(usageWindowEnd(job({ lastError: "usage-limit: resumes at soon-ish" }))).toBe(NOW + HOUR);
  });

  it("reports no window for a missing job", () => {
    expect(usageWindowEnd(undefined)).toBeUndefined();
  });
});

describe("escalationNote", () => {
  const ESC_ID = "3f2a1b9c-0000-4000-8000-000000000001";

  it("says what stalled and that nothing will retry it", () => {
    const note = escalationNote(
      finding({ kind: "stale-pr", reason: "open 3d with no review" }),
      ESC_ID,
    );
    expect(note).toContain("stale-pr");
    expect(note).toContain("open 3d with no review");
    expect(note).toMatch(/Nothing will retry this automatically/);
  });

  it("carries the escalation id, so a note written twice reads as one escalation", () => {
    // bd notes are append-only with no dedupe: a note that lands while its `notedAt` stamp fails is
    // re-written next pass, and this token is what tells a human the entries aren't two stalls.
    expect(escalationNote(finding(), ESC_ID)).toContain("3f2a1b9c");
  });

  it("stays on ONE line — beads splits a note blob on newlines into separate entries", () => {
    const note = escalationNote(finding({ reason: "parked:\n  agent exited 1\n" }), ESC_ID);
    expect(note).not.toContain("\n");
    expect(note).toContain("parked: agent exited 1");
  });
});
