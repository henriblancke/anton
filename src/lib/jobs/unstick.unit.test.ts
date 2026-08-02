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
/** The dead-lease grace the sweep applied past expiry — the re-check must apply the same one. */
const GRACE = 30 * 60_000;

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
    formula: null,
    formulaVariant: null,
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
    // The epic under test, present and open. A board this pass pulled lists EVERY status, so an
    // empty one would mean "e-1 was deleted" — the default has to carry the bead the findings name.
    board: new Map<string, Bead>([["e-1", bead("e-1")]]),
    boardFresh: true,
    deadLeaseGraceMs: GRACE,
    usageWindowEndsAt: () => undefined,
    epicCancelled: () => false,
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

  it("HOLDS a park whose epic an operator cancelled — a cancel must survive the quota window", () => {
    // Cancelling the queued backoff job of a usage-limit park leaves the RUN row parked, so the
    // finding outlives the cancel. Resuming here would reverse an explicit stop with a fresh job.
    const verdict = classifyFinding(
      finding(),
      ctx({ usageWindowEndsAt: () => NOW - HOUR, epicCancelled: () => true }),
    );
    expect(verdict.disposition).toBe("hold");
    expect(verdict.why).toContain("cancelled");
  });

  it("escalates a park with any other reason — those are judgment calls", () => {
    const verdict = classifyFinding(
      finding({ reason: "parked 4h ago: agent exited 1" }),
      ctx({ parkedRuns: new Map([["r-1", run({ error: "agent exited 1" })]]) }),
    );
    expect(verdict).toMatchObject({ disposition: "escalate", why: "parked 4h ago: agent exited 1" });
  });

  it("HOLDS a park whose epic has since closed — an abandoned epic is not a stall to re-raise", () => {
    // An abandon from an `exhausted-job` escalation closes the bead but carries no run id, so it
    // can't settle the parked run row. Escalating that row again offers an "abandon" that now fails
    // on the closed bead, and the finding comes back every single sweep.
    const verdict = classifyFinding(
      finding({ reason: "parked 4h ago: agent exited 1" }),
      ctx({
        parkedRuns: new Map([["r-1", run({ error: "agent exited 1" })]]),
        board: new Map([["e-1", bead("e-1", { status: "closed" })]]),
      }),
    );
    expect(verdict.disposition).toBe("hold");
    expect(verdict.why).toContain("closed");
  });

  it("HOLDS a park whose epic was DELETED — a deletion is settled, not a stall to resume", () => {
    // The nastiest shape: the window has reopened, nothing holds a lease, so every other guard says
    // resume — and execute-epic then parks the fresh run on `bead ... not found`, turning an
    // intentional deletion into a poison job and an escalation. A pulled board lists every status,
    // so the bead's absence IS the deletion.
    const verdict = classifyFinding(
      finding(),
      ctx({ usageWindowEndsAt: () => NOW - HOUR, board: new Map() }),
    );
    expect(verdict.disposition).toBe("hold");
    expect(verdict.why).toContain("gone from the board");
  });

  it("still escalates a closed-epic park when the board could not be pulled", () => {
    // A "closed" read off a stale local mirror is not evidence the work is done, and an escalation
    // touches no shared state — so the untrusted board fails open here, unlike a resume.
    const verdict = classifyFinding(
      finding({ reason: "parked 4h ago: agent exited 1" }),
      ctx({
        boardFresh: false,
        parkedRuns: new Map([["r-1", run({ error: "agent exited 1" })]]),
        board: new Map([["e-1", bead("e-1", { status: "closed" })]]),
      }),
    );
    expect(verdict.disposition).toBe("escalate");
  });

  it("HOLDS a non-quota park another machine has since picked back up", () => {
    // The park is this machine's local row; the lease says the epic is executing elsewhere right
    // now. Escalating would hand the founder Resume/Abandon over live remote work — abandon closes
    // the bead underneath the running machine.
    const verdict = classifyFinding(
      finding({ reason: "parked 4h ago: agent exited 1" }),
      ctx({
        parkedRuns: new Map([["r-1", run({ error: "agent exited 1" })]]),
        board: new Map([["e-1", bead("e-1", { labels: [LABELS.runLease(NOW + HOUR, "run-x")] })]]),
      }),
    );
    expect(verdict.disposition).toBe("hold");
    expect(verdict.why).toContain("live run-lease");
  });

  it("escalates a non-quota park past this run's OWN leftover lease", () => {
    // A lease owned by the very run that parked is a crash leftover, not a foreign holder — treating
    // it as one would silently swallow the escalation the stall exists to raise.
    const verdict = classifyFinding(
      finding({ reason: "parked 4h ago: agent exited 1" }),
      ctx({
        parkedRuns: new Map([["r-1", run({ error: "agent exited 1" })]]),
        board: new Map([["e-1", bead("e-1", { labels: [LABELS.runLease(NOW + HOUR, "r-1")] })]]),
      }),
    );
    expect(verdict.disposition).toBe("escalate");
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
      ctx({
        parkedRuns: new Map([["r-1", run({ ticketBeadId: "t-9", epicBeadId: "e-7" })]]),
        board: new Map([["e-7", bead("e-7")]]),
      }),
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
    expect(classifyFinding(deadLease, ctx({ board: new Map() })).disposition).toBe("hold");
  });

  it("holds a bead whose lease has since been CLEARED — there is no dead run left to revive", () => {
    // The owner didn't die after all: it settled and swept its own lease label. Without re-running
    // the dead-lease predicate on the pulled bead, the absence of any lease reads as "uncontested"
    // and this pass starts fresh work on an epic nobody asked it to run.
    const verdict = classifyFinding(deadLease, withBoard(bead("e-1")));
    expect(verdict.disposition).toBe("hold");
    expect(verdict.why).toContain("cleared");
  });

  it("HOLDS a lease that expired inside the grace window — the sweep would not have raised it", () => {
    // The bead carries a REPLACEMENT lease: another machine took the work after the sweep and its
    // refresh is a minute late (or its clock skews). Presence alone is a weaker bar than the
    // detector's `expiry + grace <= now`, and resuming here double-runs a ticket still executing.
    const verdict = classifyFinding(deadLease, withBoard(leased(NOW - GRACE / 2)));
    expect(verdict.disposition).toBe("hold");
    expect(verdict.why).toContain("grace");
  });

  it("resumes once the grace has elapsed — the same bar the detector used", () => {
    const verdict = classifyFinding(deadLease, withBoard(leased(NOW - GRACE - 1)));
    expect(verdict.disposition).toBe("resume");
  });

  it("never touches a bead a live job already owns", () => {
    const verdict = classifyFinding(
      deadLease,
      withBoard(leased(NOW - 2 * HOUR), { activeEpicKeys: new Set(["p1::e-1"]) }),
    );
    expect(verdict.disposition).toBe("hold");
  });

  it("HOLDS a lease left behind by a job an operator cancelled — the cancel outlives its lease", () => {
    // A cancel settles the JOB; a process that dies (or fails its lease cleanup) right after leaves
    // the bead's lease to expire into exactly this finding. Resuming it would reverse the stop —
    // and `resumeEpic` can't catch that, since a cancelled job is outside its covering set.
    const verdict = classifyFinding(
      deadLease,
      withBoard(leased(NOW - 2 * HOUR), { epicCancelled: () => true }),
    );
    expect(verdict.disposition).toBe("hold");
    expect(verdict.why).toContain("cancelled");
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

  it("HOLDS an exhausted job whose epic has since closed — re-escalating it can never settle", () => {
    // An abandon closes the bead first and cancels the job second, so a failed cancel leaves the job
    // parked under a closed epic. Escalating it again offers an "abandon" that now throws on the
    // closed bead — settling the escalation while the job stays exactly as it was, every sweep.
    const verdict = classifyFinding(
      finding({ kind: "exhausted-job", key: "exhausted-job:j-1", jobId: "j-1" }),
      ctx({ board: new Map([["e-1", bead("e-1", { status: "closed" })]]) }),
    );
    expect(verdict.disposition).toBe("hold");
    expect(verdict.why).toContain("closed");
  });

  it("HOLDS an exhausted job whose epic was DELETED — its resume and abandon both dead-end", () => {
    // A pulled board lists every status, so an absent bead is a deletion. Escalating it offers a
    // resume that re-parks execute-epic on `bead ... not found` and an abandon whose `bd show`
    // throws — neither settles the job, so the same alert returns every sweep.
    const verdict = classifyFinding(
      finding({ kind: "exhausted-job", key: "exhausted-job:j-1", jobId: "j-1" }),
      ctx({ board: new Map() }),
    );
    expect(verdict.disposition).toBe("hold");
    expect(verdict.why).toContain("gone from the board");
  });

  it("still escalates a closed-epic exhausted job when the board could not be pulled", () => {
    const verdict = classifyFinding(
      finding({ kind: "exhausted-job", key: "exhausted-job:j-1", jobId: "j-1" }),
      ctx({ boardFresh: false, board: new Map([["e-1", bead("e-1", { status: "closed" })]]) }),
    );
    expect(verdict.disposition).toBe("escalate");
  });

  it("escalates a job-only exhausted finding — no bead id means no epic to be closed", () => {
    // sync-push / run-health / unstick jobs strand no bead, so the guard above must not swallow them.
    const verdict = classifyFinding(
      finding({ kind: "exhausted-job", key: "exhausted-job:j-1", jobId: "j-1", beadId: undefined }),
      ctx({ board: new Map([["e-1", bead("e-1", { status: "closed" })]]) }),
    );
    expect(verdict.disposition).toBe("escalate");
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
