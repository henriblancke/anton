/**
 * Tests for the founder's answers to an escalation (anton-wvcy), over a real temp anton.db.
 *
 * The property under test is the ORDER: settle first, act second. `settleEscalation`'s status CAS is
 * the lock, so whoever flips `open → resolved` owns the decision — that is what makes a double-click
 * (or two operators on one board) resume the epic once rather than twice. The verbs themselves are
 * stubbed; that they are the SAME verbs the automatic path uses is a wiring fact, asserted here by
 * checking each is called with the right target.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";

import { makeFileDb, type FileDb } from "@/lib/testing/integration";
import { LABELS, type Bead } from "./beads/bd";
import { GATE_RESUMED_LABEL } from "./jobs/gate-targets";
import type { RunHealthFinding } from "./run-health";
import type { Project } from "./types";

const resumeStalledEpic = vi.fn<(projectId: string, epicBeadId: string) => Promise<string>>();
const abandonTicket =
  vi.fn<
    (
      project: Project,
      id: string,
      reason: string,
      opts?: { requireStopped?: boolean },
    ) => Promise<unknown>
  >();
const resumeJob = vi.fn<(projectId: string, jobId: string) => Promise<boolean>>();
const cancelJob =
  vi.fn<
    (projectId: string, jobId: string, only?: readonly string[]) => Promise<{ ok: boolean }>
  >();

vi.mock("./jobs/service", async () => {
  // The liveness read stays REAL against the temp db — the seeded job rows are the whole point of
  // the abandon guard's tests; only the verbs it gates are stubbed.
  const { activeExecuteEpicId } =
    await vi.importActual<typeof import("./jobs/queue")>("./jobs/queue");
  const { getDb: db } = await import("./db");
  return {
    resumeStalledEpic: (...args: [string, string]) => resumeStalledEpic(...args),
    resumeJob: (...args: [string, string]) => resumeJob(...args),
    cancelJob: (...args: [string, string, (readonly string[])?]) => cancelJob(...args),
    runIsLiveForTarget: (projectId: string, epicBeadId: string) =>
      activeExecuteEpicId(db(), projectId, epicBeadId) !== undefined,
  };
});
vi.mock("./abandon", async () => {
  const actual = await vi.importActual<typeof import("./abandon")>("./abandon");
  return {
    ...actual,
    abandonTicket: (...args: Parameters<typeof actual.abandonTicket>) => abandonTicket(...args),
  };
});

// The cross-machine half: the pre-settle re-check pulls the shared board and reads the epic's
// run-lease. Stubbed so the lease is the only variable — the real lease parsing is bd.test.ts's job.
const beadsPull = vi.fn<(repoPath: string) => Promise<void>>();
const beadsShow = vi.fn<(repoPath: string, id: string) => Promise<Bead>>();
const gateResolve = vi.fn<(repoPath: string, id: string, reason?: string) => Promise<string>>();
const beadsTag = vi.fn<(repoPath: string, id: string, labels: string[]) => Promise<unknown>>();
vi.mock("./beads/bd", async () => {
  const actual = await vi.importActual<typeof import("./beads/bd")>("./beads/bd");
  return {
    ...actual,
    beads: {
      ...actual.beads,
      pull: (...args: [string]) => beadsPull(...args),
      show: (...args: [string, string]) => beadsShow(...args),
      gateResolve: (...args: [string, string, string?]) => gateResolve(...args),
      tag: (...args: [string, string, string[]]) => beadsTag(...args),
    },
  };
});

// The ownership half of the dispatch rule reads this machine's identity; pinned so a test box's git
// config can't decide whether a claimed target is "ours".
vi.mock("./operator", () => ({
  resolveOperator: async () => "alice",
  resetOperatorCache: () => {},
}));

// The blocker re-check a resolve-and-resume runs before it re-queues anything reads the whole board.
// Stubbed to a board where the gate just closed was the last thing holding the target, so each test
// that cares states its own answer.
const loadAllIssues = vi.fn<(repo: string, opts?: { strictGates?: boolean }) => Promise<Bead[]>>();
vi.mock("./beads/issues", async () => {
  const actual = await vi.importActual<typeof import("./beads/issues")>("./beads/issues");
  return {
    ...actual,
    loadAllIssues: (...args: [string, { strictGates?: boolean }?]) => loadAllIssues(...args),
  };
});

// Closing a gate is a board write, so it must reach teammates like every other one (anton-nowq).
const nudgeSync = vi.fn<(project: Project, label?: string) => void>();
vi.mock("./beads/sync-nudge", () => ({
  nudgeSync: (...args: [Project, string?]) => nudgeSync(...args),
}));

let fileDb: FileDb;
let actOnEscalation: typeof import("./escalation-actions").actOnEscalation;
let isEscalationAction: typeof import("./escalation-actions").isEscalationAction;
let getDb: typeof import("./db").getDb;
let schema: typeof import("./db/schema");
let raiseEscalation: typeof import("./escalations").raiseEscalation;
let settleEscalation: typeof import("./escalations").settleEscalation;
let RunRestartedError: typeof import("./abandon").RunRestartedError;

const NOW = 1_700_000_000_000;
const HOUR = 3_600_000;
const clock = { now: () => NOW };

const project = { id: "p1", slug: "p1", name: "p1", repoPath: "/tmp/p1" } as Project;

beforeAll(async () => {
  // MUST precede the getDb-touching imports: the db path is resolved at import time.
  fileDb = makeFileDb();
  ({ getDb } = await import("./db"));
  schema = await import("./db/schema");
  ({ raiseEscalation, settleEscalation } = await import("./escalations"));
  ({ RunRestartedError } = await import("./abandon"));
  ({ actOnEscalation, isEscalationAction } = await import("./escalation-actions"));
});

afterAll(() => fileDb.cleanup());

beforeEach(() => {
  getDb().delete(schema.escalations).run();
  getDb().delete(schema.jobs).run();
  getDb().delete(schema.runs).run();
  getDb().delete(schema.projects).run();
  getDb()
    .insert(schema.projects)
    .values({ id: "p1", slug: "p1", name: "p1", repoPath: "/tmp/p1" })
    .run();
  resumeStalledEpic.mockResolvedValue("enqueued");
  abandonTicket.mockResolvedValue(undefined);
  resumeJob.mockResolvedValue(true);
  cancelJob.mockResolvedValue({ ok: true });
  beadsPull.mockResolvedValue(undefined);
  beadsShow.mockResolvedValue(bead());
  gateResolve.mockResolvedValue("✓ Gate resolved");
  beadsTag.mockResolvedValue(undefined);
  loadAllIssues.mockResolvedValue([bead()]);
});

/**
 * The epic bead the re-check reads the run-lease off; no run-lease label means nobody is running it.
 * Approved by default because that is what a run target anton would dispatch looks like — the gate
 * resume applies the automatic path's full dispatch rule, which refuses unapproved work.
 */
function bead(labels: string[] = [LABELS.approved]): Bead {
  return { id: "anton-e1", title: "epic", status: "open", labels } as Bead;
}

afterEach(() => vi.clearAllMocks());

function finding(o: Partial<RunHealthFinding> = {}): RunHealthFinding {
  return {
    kind: "parked-run",
    key: "parked-run:r-1",
    reason: "parked 4h ago: agent exited 1",
    since: NOW - 4 * HOUR,
    ageMs: 4 * HOUR,
    runId: "r-1",
    beadId: "anton-t9",
    ...o,
  };
}

async function open(o: { finding?: RunHealthFinding; epicBeadId?: string } = {}) {
  const { escalation } = await raiseEscalation(getDb(), clock, {
    projectId: "p1",
    finding: o.finding ?? finding(),
    epicBeadId: "epicBeadId" in o ? o.epicBeadId : "anton-e1",
  });
  return escalation;
}

/** A real job row, so the refused-cancel path can read the status it reports back to the operator. */
function seedJob(id: string, status: string): void {
  getDb()
    .insert(schema.jobs)
    .values({ id, type: "sync-push", projectId: "p1", status })
    .run();
}

/** An ACTIVE execute-epic job for the escalation's epic — what a local resume leaves behind. */
function seedExecuteEpicJob(status: string): void {
  getDb()
    .insert(schema.jobs)
    .values({
      id: "j-epic",
      type: "execute-epic",
      projectId: "p1",
      status,
      payloadJson: JSON.stringify({ projectId: "p1", epicBeadId: "anton-e1" }),
    })
    .run();
}

/** The run a `parked-run` escalation was raised against — real, because abandon settles it. */
function seedParkedRun(id: string, status = "parked"): void {
  getDb()
    .insert(schema.runs)
    .values({ id, projectId: "p1", epicBeadId: "anton-e1", status, error: "agent exited 1" })
    .run();
}

const rowOf = (id: string) =>
  getDb().select().from(schema.escalations).where(eq(schema.escalations.id, id)).get();

const runOf = (id: string) =>
  getDb().select().from(schema.runs).where(eq(schema.runs.id, id)).get();

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

describe("actOnEscalation — a stall that names only a job", () => {
  // An exhausted `sync-push`/`run-health`/`unstick` job strands no bead, so neither verb has a work
  // item to act on. Answering on the JOB is what keeps such an escalation settleable at all — and it
  // moves the job out of parked/failed, which is the only state the sweep re-reports.
  const jobFinding = () =>
    finding({
      kind: "exhausted-job",
      key: "exhausted-job:j-1",
      reason: "sync-push job parked after 3/3 attempts: dolt push rejected",
      runId: undefined,
      beadId: undefined,
      jobId: "j-1",
    });

  const openJobEscalation = () => open({ finding: jobFinding(), epicBeadId: undefined });

  it("resume gives the job a fresh retry budget", async () => {
    const escalation = await openJobEscalation();

    const result = await actOnEscalation(project, escalation.id, "resume");

    expect(result).toMatchObject({ ok: true, detail: "resumed-job" });
    expect(resumeJob).toHaveBeenCalledWith("p1", "j-1");
    expect(rowOf(escalation.id)).toMatchObject({ status: "resolved", resolution: "resumed" });
  });

  it("abandon cancels the job so it never runs again — but only from parked/failed", async () => {
    const escalation = await openJobEscalation();

    const result = await actOnEscalation(project, escalation.id, "abandon");

    expect(result).toMatchObject({ ok: true, detail: "cancelled-job" });
    // The status guard travels WITH the cancel, so a job resumed since the raise is refused by the
    // same CAS that terminalizes a still-parked one — not by a read that could race it.
    expect(cancelJob).toHaveBeenCalledWith("p1", "j-1", ["parked", "failed"]);
    expect(rowOf(escalation.id)).toMatchObject({ status: "resolved", resolution: "abandoned" });
  });

  it("refuses to stop a job someone resumed since the escalation was raised", async () => {
    // The unstick pass re-validates before RAISING, but the button lives on the board until it is
    // clicked. Cancelling here would abort a live child on the strength of a stale control.
    cancelJob.mockResolvedValue({ ok: false });
    seedJob("j-1", "running");
    const escalation = await openJobEscalation();

    const result = await actOnEscalation(project, escalation.id, "abandon");

    expect(result).toMatchObject({ ok: true, detail: "job-restarted" });
    expect(rowOf(escalation.id)).toMatchObject({ status: "resolved", resolution: "abandoned" });
  });

  it("still reports a job that simply moved on as settled, not as restarted", async () => {
    cancelJob.mockResolvedValue({ ok: false });
    seedJob("j-1", "done");
    const escalation = await openJobEscalation();

    expect(await actOnEscalation(project, escalation.id, "abandon")).toMatchObject({
      detail: "job-already-settled",
    });
  });

  it("reports a job that has since moved on rather than claiming an action it didn't take", async () => {
    resumeJob.mockResolvedValue(false);
    const escalation = await openJobEscalation();

    expect(await actOnEscalation(project, escalation.id, "resume")).toMatchObject({
      ok: true,
      detail: "job-not-resumable",
    });
  });

  it("still refuses when the finding names no bead AND no job", async () => {
    const escalation = await open({
      finding: jobFinding(),
      epicBeadId: undefined,
    });
    // Strip the job pointer the fallback depends on.
    getDb()
      .update(schema.escalations)
      .set({ jobId: null })
      .where(eq(schema.escalations.id, escalation.id))
      .run();

    expect(await actOnEscalation(project, escalation.id, "resume")).toEqual({
      ok: false,
      reason: "no-target",
    });
    expect(rowOf(escalation.id)?.status).toBe("open");
  });
});

describe("actOnEscalation — the work was picked back up elsewhere", () => {
  // The escalation is a frozen snapshot of the stall, but the button lives on the board until it is
  // clicked. Jobs and runs are machine-local, so the epic's run-lease is the only record that
  // another machine restarted the work in between — and later sweeps hold the finding without ever
  // resolving the open row, so nothing else retires the stale control.
  // Lease expiries are judged against the real clock (the module settles on `systemClock`), so
  // these are wall-time relative — unlike the frozen NOW the escalation rows are seeded at.
  const lease = (offsetMs: number, owner: string) => bead([LABELS.runLease(Date.now() + offsetMs, owner)]);
  const foreignLease = () => lease(HOUR, "run-elsewhere");

  it("refuses an abandon that would close the bead underneath a live remote run", async () => {
    beadsShow.mockResolvedValue(foreignLease());
    const escalation = await open();

    expect(await actOnEscalation(project, escalation.id, "abandon")).toEqual({
      ok: false,
      reason: "contested",
    });
    expect(abandonTicket).not.toHaveBeenCalled();
    // Unsettled: the row stays on the panel for the next sweep to re-judge.
    expect(rowOf(escalation.id)?.status).toBe("open");
  });

  it("refuses a resume too — re-running an epic another machine owns is a duplicate PR", async () => {
    beadsShow.mockResolvedValue(foreignLease());
    const escalation = await open();

    expect(await actOnEscalation(project, escalation.id, "resume")).toEqual({
      ok: false,
      reason: "contested",
    });
    expect(resumeStalledEpic).not.toHaveBeenCalled();
  });

  it("pulls the shared board first — a local mirror trails the lease by a sync heartbeat", async () => {
    const escalation = await open();

    await actOnEscalation(project, escalation.id, "abandon");

    expect(beadsPull).toHaveBeenCalledWith(project.repoPath);
    // The EPIC carries the lease, not the ticket the finding names.
    expect(beadsShow).toHaveBeenCalledWith(project.repoPath, "anton-e1");
  });

  it("acts through the stalled run's OWN leftover lease — that is a crash remnant, not a holder", async () => {
    beadsShow.mockResolvedValue(lease(HOUR, "r-1"));
    const escalation = await open();

    expect(await actOnEscalation(project, escalation.id, "abandon")).toMatchObject({ ok: true });
  });

  it("acts through an EXPIRED foreign lease — the machine that held it is gone", async () => {
    beadsShow.mockResolvedValue(lease(-HOUR, "run-elsewhere"));
    const escalation = await open();

    expect(await actOnEscalation(project, escalation.id, "abandon")).toMatchObject({ ok: true });
  });

  it("refuses when bd can't answer for the lease bead — an unread board rules nothing out", async () => {
    beadsShow.mockRejectedValue(new Error("bd: database is locked"));
    const escalation = await open();

    expect(await actOnEscalation(project, escalation.id, "abandon")).toEqual({
      ok: false,
      reason: "unverified",
    });
    expect(abandonTicket).not.toHaveBeenCalled();
    // Deferred, not lost: the row stays on the panel for the next click or sweep.
    expect(rowOf(escalation.id)?.status).toBe("open");
  });

  it("refuses when the PULL didn't land — the local mirror can't show a lease it never received", async () => {
    // The reads all succeed and show no lease; that is only evidence if the pull that would have
    // brought a foreign one in actually ran. A workspace with no remote resolves `not-wired` here
    // rather than rejecting, so a single-machine board is unaffected.
    beadsPull.mockRejectedValue(new Error("dolt pull: remote unreachable"));
    const escalation = await open();

    expect(await actOnEscalation(project, escalation.id, "resume")).toEqual({
      ok: false,
      reason: "unverified",
    });
    expect(resumeStalledEpic).not.toHaveBeenCalled();
    expect(rowOf(escalation.id)?.status).toBe("open");
  });

  it("still lets a dismiss through on an unreadable board — it touches neither the work nor the lease", async () => {
    beadsPull.mockRejectedValue(new Error("dolt pull: remote unreachable"));
    beadsShow.mockRejectedValue(new Error("bd: database is locked"));
    const escalation = await open();

    expect(await actOnEscalation(project, escalation.id, "dismiss")).toMatchObject({ ok: true });
  });

  // The window the pre-read guard alone leaves open: `readTargetState` awaits a bd pull that can
  // take seconds, and a resume landing inside it republishes the stalled run's OWN id, which the
  // lease check exempts as this escalation's leftover.
  it("refuses an abandon when the local resume lands DURING the board read", async () => {
    beadsShow.mockResolvedValue(lease(HOUR, "r-1")); // the resumed run's own lease — not foreign
    beadsPull.mockImplementation(async () => {
      seedExecuteEpicJob("running");
    });
    const escalation = await open();

    expect(await actOnEscalation(project, escalation.id, "abandon")).toEqual({
      ok: false,
      reason: "contested",
    });
    expect(abandonTicket).not.toHaveBeenCalled();
    expect(rowOf(escalation.id)?.status).toBe("open");
  });

  // The same run resuming HERE is the case the lease can't see: execute-epic republishes it under
  // the stalled run's own id, so it reads as our crash remnant above while the work is live again.
  it("refuses an abandon after the same run resumed on this machine", async () => {
    beadsShow.mockResolvedValue(lease(HOUR, "r-1")); // the resumed run's own lease — not foreign
    seedExecuteEpicJob("running");
    const escalation = await open();

    expect(await actOnEscalation(project, escalation.id, "abandon")).toEqual({
      ok: false,
      reason: "contested",
    });
    // The cancel inside abandonTicket would have killed the resumed job and closed the bead under it.
    expect(abandonTicket).not.toHaveBeenCalled();
    expect(rowOf(escalation.id)?.status).toBe("open");
  });

  // The last window the pre-settle checks cannot close: the settle itself awaits, so the abandon
  // re-reads liveness where the kill would land and refuses there (`requireStopped`).
  it("reports a resume that lands AFTER the settle as contested, having destroyed nothing", async () => {
    abandonTicket.mockRejectedValue(new RunRestartedError("anton-e1"));
    const escalation = await open();

    expect(await actOnEscalation(project, escalation.id, "abandon")).toEqual({
      ok: false,
      reason: "contested",
    });
    // The abandon refused before writing, so nothing settles the rows the live run now owns.
    expect(cancelJob).not.toHaveBeenCalled();
    // The row is spent — the CAS already claimed it — but the work it named is untouched and alive.
    expect(rowOf(escalation.id)).toMatchObject({ status: "resolved", resolution: "abandoned" });
  });

  it("asks the abandon to enforce the guard itself, not to trust the snapshot above it", async () => {
    const escalation = await open();

    await actOnEscalation(project, escalation.id, "abandon");

    expect(abandonTicket).toHaveBeenCalledWith(project, "anton-t9", expect.any(String), {
      requireStopped: true,
    });
  });

  it("refuses the abandon on a merely QUEUED resume too — the job is about to be leased", async () => {
    seedExecuteEpicJob("queued");
    const escalation = await open();

    expect(await actOnEscalation(project, escalation.id, "abandon")).toEqual({
      ok: false,
      reason: "contested",
    });
  });

  it("still abandons when the epic's job has since parked again — that is stopped work", async () => {
    seedExecuteEpicJob("parked");
    const escalation = await open();

    expect(await actOnEscalation(project, escalation.id, "abandon")).toMatchObject({ ok: true });
    expect(abandonTicket).toHaveBeenCalled();
  });

  it("lets a resume through against a live local job — resumeEpic absorbs it as a no-op", async () => {
    resumeStalledEpic.mockResolvedValue("already-active");
    seedExecuteEpicJob("running");
    const escalation = await open();

    expect(await actOnEscalation(project, escalation.id, "resume")).toMatchObject({
      ok: true,
      detail: "already-active",
    });
  });

  it("never gates a job-only stall or a dismiss — neither touches the shared board", async () => {
    const jobOnly = await open({
      finding: finding({ kind: "exhausted-job", key: "exhausted-job:j-1", runId: undefined, beadId: undefined, jobId: "j-1" }),
      epicBeadId: undefined,
    });
    expect(await actOnEscalation(project, jobOnly.id, "abandon")).toMatchObject({ ok: true });

    beadsShow.mockResolvedValue(foreignLease());
    const dismissable = await open({ finding: finding({ key: "parked-run:r-2", runId: "r-2" }) });
    expect(await actOnEscalation(project, dismissable.id, "dismiss")).toMatchObject({ ok: true });

    expect(beadsShow).not.toHaveBeenCalled();
  });
});

describe("actOnEscalation — the work settled itself after the stall was raised", () => {
  // A deleted or hand-closed bead is a deliberate settle, and neither verb has anything left to act
  // on: a resume hands execute-epic an id it can only park back on with `bead ... not found` — an
  // intentional deletion turned into a poison job — or restarts work someone explicitly ended, and
  // an abandon's `abandonTicket` throws on either AFTER the settle. bd saying "no issue found" is
  // the evidence; bd failing to answer is not.
  const notFound = (id: string) =>
    Object.assign(new Error(`Command failed: bd show ${id} --json\n`), {
      stderr: `Error: no issue found matching "${id}"\n`,
    });

  it("refuses to re-enqueue a deleted epic, and settles the row instead of stranding it", async () => {
    beadsShow.mockRejectedValue(notFound("anton-e1"));
    const escalation = await open();

    expect(await actOnEscalation(project, escalation.id, "resume")).toMatchObject({
      ok: true,
      detail: "target-gone",
    });
    expect(resumeStalledEpic).not.toHaveBeenCalled();
    // Dismissed, not "resumed": the row must not claim a restart that never happened. The panel
    // offers Dismiss only on a stale PR, so refusing outright would leave this escalation with no
    // move that could ever retire it.
    expect(rowOf(escalation.id)).toMatchObject({ status: "resolved", resolution: "dismissed" });
  });

  it("refuses an abandon of a deleted ticket the same way", async () => {
    beadsShow.mockRejectedValue(notFound("anton-t9"));
    const escalation = await open();

    expect(await actOnEscalation(project, escalation.id, "abandon")).toMatchObject({
      ok: true,
      detail: "target-gone",
    });
    expect(abandonTicket).not.toHaveBeenCalled();
    expect(rowOf(escalation.id)).toMatchObject({ status: "resolved", resolution: "dismissed" });
  });

  it("treats a lookup that returns no issue as the same answer as bd's not-found exit", async () => {
    beadsShow.mockResolvedValue(undefined as unknown as Bead);
    const escalation = await open();

    expect(await actOnEscalation(project, escalation.id, "resume")).toMatchObject({
      detail: "target-gone",
    });
  });

  it("still abandons the ticket when only its EPIC is gone — existence is read on the verb's own target", async () => {
    beadsShow.mockImplementation(async (_repo, id) => {
      if (id === "anton-e1") throw notFound(id);
      return bead();
    });
    const escalation = await open();

    expect(await actOnEscalation(project, escalation.id, "abandon")).toMatchObject({
      ok: true,
      detail: "abandoned",
    });
  });

  it("refuses to re-enqueue an epic someone closed by hand, however unleased it looks", async () => {
    // The unstick classifier holds on exactly this (`epicSettled`); without the same rule here a
    // stale Resume click settles the escalation and hands execute-epic a closed epic, which passes
    // its runnable gates and starts work that was explicitly called done.
    beadsShow.mockResolvedValue({ ...bead(), status: "closed" });
    const escalation = await open();

    expect(await actOnEscalation(project, escalation.id, "resume")).toMatchObject({
      ok: true,
      detail: "target-closed",
    });
    expect(resumeStalledEpic).not.toHaveBeenCalled();
    expect(rowOf(escalation.id)).toMatchObject({ status: "resolved", resolution: "dismissed" });
  });

  it("refuses an abandon of an already-closed ticket, which `abandonTicket` would throw on", async () => {
    beadsShow.mockResolvedValue({ ...bead(), id: "anton-t9", status: "closed" });
    const escalation = await open();

    expect(await actOnEscalation(project, escalation.id, "abandon")).toMatchObject({
      ok: true,
      detail: "target-closed",
    });
    expect(abandonTicket).not.toHaveBeenCalled();
    expect(rowOf(escalation.id)).toMatchObject({ status: "resolved", resolution: "dismissed" });
  });

  it("does NOT read a bd that could not answer as a deletion — it refuses instead of settling", async () => {
    // A failed read is not evidence either way: settling the row as `target-gone` would retire a
    // stall that may still be live work, so the escalation waits for a board it can actually read.
    beadsShow.mockRejectedValue(new Error("bd: database is locked"));
    const escalation = await open();

    expect(await actOnEscalation(project, escalation.id, "resume")).toEqual({
      ok: false,
      reason: "unverified",
    });
    expect(resumeStalledEpic).not.toHaveBeenCalled();
    expect(rowOf(escalation.id)?.status).toBe("open");
  });
});

describe("actOnEscalation — the action fails after the settle", () => {
  it("leaves a server-side breadcrumb, because the settled row is already gone from the panel", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    resumeStalledEpic.mockRejectedValue(new Error("runner refused: project is being deleted"));
    const escalation = await open();

    await expect(actOnEscalation(project, escalation.id, "resume")).rejects.toThrow("runner refused");

    // Settled by the CAS that owns the decision — the stall itself returns via the next sweep.
    expect(rowOf(escalation.id)).toMatchObject({ status: "resolved", resolution: "resumed" });
    expect(logged.mock.calls[0]?.[0]).toContain(escalation.id);
    expect(logged.mock.calls[0]?.[0]).toContain("re-surfaces on the next run-health sweep");
    logged.mockRestore();
  });
});

describe("actOnEscalation — a wait on a person", () => {
  // The one stall that is stuck BY DESIGN. Its answer is not really about the run: the wait hangs on
  // a gate, and nothing in anton ever closes a human one — so every answer here has to close it, or
  // the sweep raises this same row again forever.
  const gateFinding = (o: Partial<RunHealthFinding> = {}) =>
    finding({
      kind: "needs-human",
      key: "needs-human:g-1",
      reason: "waiting on a human 3h: the founder wants to see the design first",
      runId: undefined,
      beadId: "anton-t9",
      gateId: "g-1",
      targetBeadId: "anton-e1",
      ...o,
    });

  const openGateWait = (o: { epicBeadId?: string } = { epicBeadId: "anton-e1" }) =>
    open({ finding: gateFinding(), ...o });

  /** bd's answer per bead, so a gate read can differ from the run target's lease read. */
  function showsGateAs(gate: Bead | Error) {
    beadsShow.mockImplementation(async (_repo, id) => {
      if (id !== "g-1") return bead();
      if (gate instanceof Error) throw gate;
      return gate;
    });
  }

  const closedGate = () => ({ id: "g-1", title: "Gate: human", status: "closed" }) as Bead;

  it("closes the gate and resumes the run target as one answer", async () => {
    const escalation = await openGateWait();

    const result = await actOnEscalation(project, escalation.id, "resume");

    expect(result).toMatchObject({ ok: true, action: "resume", detail: "enqueued" });
    expect(gateResolve).toHaveBeenCalledWith(project.repoPath, "g-1", expect.any(String));
    expect(resumeStalledEpic).toHaveBeenCalledWith("p1", "anton-e1");
    expect(rowOf(escalation.id)).toMatchObject({ status: "resolved", resolution: "resumed" });
  });

  it("closes the gate BEFORE the resume — execute-epic re-reads the board", async () => {
    // A run enqueued against a still-open gate parks straight back on the same wait: the row would
    // settle, nothing would move, and the next sweep would raise it again.
    await actOnEscalation(project, (await openGateWait()).id, "resume");

    expect(gateResolve.mock.invocationCallOrder[0]).toBeLessThan(
      resumeStalledEpic.mock.invocationCallOrder[0]!,
    );
  });

  it("resolves and resumes ONCE when two clicks race", async () => {
    const escalation = await openGateWait();

    const [a, b] = await Promise.all([
      actOnEscalation(project, escalation.id, "resume"),
      actOnEscalation(project, escalation.id, "resume"),
    ]);

    expect([a.ok, b.ok].filter(Boolean)).toHaveLength(1);
    expect(gateResolve).toHaveBeenCalledTimes(1);
    expect(resumeStalledEpic).toHaveBeenCalledTimes(1);
    expect(a.ok ? b : a).toEqual({ ok: false, reason: "not-open" });
  });

  it("settles cleanly when someone already resolved the gate elsewhere", async () => {
    // bd 1.1.2 resolves a closed gate idempotently, so this is the belt-and-braces path: whatever
    // bd says, a gate that IS closed is the end state the click asked for.
    gateResolve.mockRejectedValue(new Error("bd: gate already resolved"));
    showsGateAs(closedGate());
    const escalation = await openGateWait();

    expect(await actOnEscalation(project, escalation.id, "resume")).toMatchObject({ ok: true });
    expect(resumeStalledEpic).toHaveBeenCalledWith("p1", "anton-e1");
  });

  it("treats a gate that no longer exists as a wait already over", async () => {
    gateResolve.mockRejectedValue(new Error("Error: gate not found: g-1"));
    showsGateAs(
      Object.assign(new Error("Command failed: bd show g-1 --json\n"), {
        stderr: 'Error: no issue found matching "g-1"\n',
      }),
    );

    expect(await actOnEscalation(project, (await openGateWait()).id, "resume")).toMatchObject({
      ok: true,
      detail: "enqueued",
    });
  });

  it("keeps the failure when bd cannot answer for the gate at all", async () => {
    // An unreadable gate proves nothing: the wait may still be open, so the resume must not claim it
    // ended. The row is spent, and the next sweep raises the still-open gate again.
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    gateResolve.mockRejectedValue(new Error("bd: database is locked"));
    showsGateAs(new Error("bd: database is locked"));
    const escalation = await openGateWait();

    await expect(actOnEscalation(project, escalation.id, "resume")).rejects.toThrow("locked");

    expect(resumeStalledEpic).not.toHaveBeenCalled();
    expect(rowOf(escalation.id)).toMatchObject({ status: "resolved", resolution: "resumed" });
    logged.mockRestore();
  });

  it("closes the gate but holds the resume while another blocker is still open", async () => {
    // Two waits on one target raise two rows naming the SAME run target. Answering one and resuming
    // hands execute-epic work its own start-of-job check refuses: it parks on the remaining blocker,
    // turning a wait somebody asked for into a job needing a second human answer. The gate still
    // closes — that IS the founder's answer — and gate-check dispatches once the last blocker lands.
    loadAllIssues.mockResolvedValue([
      {
        ...bead(),
        dependencies: [{ issue_id: "anton-e1", depends_on_id: "g-2", type: "blocks" }],
      } as Bead,
      { id: "g-2", title: "Gate: human", issue_type: "gate", status: "open" } as Bead,
    ]);
    const escalation = await openGateWait();

    expect(await actOnEscalation(project, escalation.id, "resume")).toMatchObject({
      ok: true,
      detail: "gate-still-blocked",
    });
    expect(gateResolve).toHaveBeenCalledWith(project.repoPath, "g-1", expect.any(String));
    expect(resumeStalledEpic).not.toHaveBeenCalled();
    expect(rowOf(escalation.id)).toMatchObject({ status: "resolved", resolution: "resumed" });
  });

  it("refuses to resume work the founder never approved", async () => {
    // A human gate can be hung on ANY bead, so this row can name an unapproved run target — and
    // execute-epic's own claim check refuses one, which would turn the founder's click into a poison
    // job. The wait still ends; the run waits for the approval.
    loadAllIssues.mockResolvedValue([{ ...bead([]) } as Bead]);
    const escalation = await openGateWait();

    expect(await actOnEscalation(project, escalation.id, "resume")).toMatchObject({
      ok: true,
      detail: "gate-still-blocked",
    });
    expect(gateResolve).toHaveBeenCalled();
    expect(resumeStalledEpic).not.toHaveBeenCalled();
    expect(beadsTag).not.toHaveBeenCalled();
  });

  it("refuses to resume a target another operator holds", async () => {
    // The board is shared but jobs are machine-local: queueing here would race the machine that
    // actually claimed the work. Its own gate-check picks the closed, unmarked gate up instead.
    loadAllIssues.mockResolvedValue([{ ...bead(), assignee: "bob" } as Bead]);

    expect(await actOnEscalation(project, (await openGateWait()).id, "resume")).toMatchObject({
      ok: true,
      detail: "gate-still-blocked",
    });
    expect(resumeStalledEpic).not.toHaveBeenCalled();
  });

  it("refuses to resume a target whose PR is already in review", async () => {
    // Its implementation is done; a fresh execute-epic reaches the PR short-circuit and exits, while
    // the merge path owns what happens next.
    loadAllIssues.mockResolvedValue([bead([LABELS.approved, LABELS.stage("in-review")])]);

    expect(await actOnEscalation(project, (await openGateWait()).id, "resume")).toMatchObject({
      ok: true,
      detail: "gate-still-blocked",
    });
    expect(resumeStalledEpic).not.toHaveBeenCalled();
  });

  it("marks the gate handed back once the resume lands, and pushes the mark", async () => {
    // A resolved gate stays on its bead forever, so without the marker gate-check's `plainGateResumes`
    // re-dispatches this same target every ten minutes — re-running a resume the founder made once.
    await actOnEscalation(project, (await openGateWait()).id, "resume");

    expect(beadsTag).toHaveBeenCalledWith(project.repoPath, "g-1", [GATE_RESUMED_LABEL]);
    expect(beadsTag.mock.invocationCallOrder[0]).toBeGreaterThan(
      resumeStalledEpic.mock.invocationCallOrder[0]!,
    );
    expect(nudgeSync).toHaveBeenCalledWith(project, "gate-resumed");
  });

  it("leaves the gate unmarked when the resume was held back", async () => {
    // The unmarked gate IS the recovery: gate-check dispatches it once the remaining blocker lands.
    loadAllIssues.mockResolvedValue([
      {
        ...bead(),
        dependencies: [{ issue_id: "anton-e1", depends_on_id: "g-2", type: "blocks" }],
      } as Bead,
      { id: "g-2", title: "Gate: human", issue_type: "gate", status: "open" } as Bead,
    ]);

    await actOnEscalation(project, (await openGateWait()).id, "resume");

    expect(beadsTag).not.toHaveBeenCalled();
  });

  it("leaves the gate unmarked when the resume failed", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    resumeStalledEpic.mockRejectedValue(new Error("runner refused: project is being deleted"));

    await expect(
      actOnEscalation(project, (await openGateWait()).id, "resume"),
    ).rejects.toThrow("runner refused");

    // Marking here would strand the work: the resume never landed, and the mark is what stops
    // gate-check from being the thing that recovers it.
    expect(beadsTag).not.toHaveBeenCalled();
    logged.mockRestore();
  });

  it("reports the resume as done even when the mark could not be written", async () => {
    // The resume LANDED. Failing the action would claim otherwise; the cost of an unwritten mark is
    // one redundant gate-check dispatch, which `resumeEpic` absorbs.
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    beadsTag.mockRejectedValue(new Error("bd: database is locked"));

    expect(await actOnEscalation(project, (await openGateWait()).id, "resume")).toMatchObject({
      ok: true,
      detail: "enqueued",
    });
    expect(logged.mock.calls[0]?.[0]).toContain("g-1");
    logged.mockRestore();
  });

  /**
   * The board after the gated ticket was reparented — a supported move (the gardener, `beads.reparent`)
   * that the escalation's frozen `epicBeadId` cannot follow. The gate's own `blocks` edge stays on the
   * ticket, so the run target above it is the only live answer to "what does closing this release?".
   */
  function reparentedBoard(newHome: Partial<Bead> = {}): Bead[] {
    return [
      {
        id: "anton-t9",
        title: "ticket",
        status: "open",
        issue_type: "task",
        parent: "anton-e2",
        dependencies: [{ issue_id: "anton-t9", depends_on_id: "g-1", type: "blocks" }],
      } as Bead,
      {
        id: "anton-e2",
        title: "its new home",
        status: "open",
        issue_type: "feature",
        labels: [LABELS.approved],
        ...newHome,
      } as Bead,
      { id: "g-1", title: "Gate: human", issue_type: "gate", status: "closed" } as Bead,
      bead(),
    ];
  }

  it("resumes the target the gated bead hangs under NOW, not the frozen ancestor", async () => {
    // Reparenting between the sweep and the click moves the run: resuming the frozen ancestor would
    // run the wrong feature AND mark the gate, which is exactly what stops gate-check from ever
    // releasing the real one.
    loadAllIssues.mockResolvedValue(reparentedBoard());

    expect(await actOnEscalation(project, (await openGateWait()).id, "resume")).toMatchObject({
      ok: true,
      detail: "enqueued",
    });
    expect(resumeStalledEpic).toHaveBeenCalledWith("p1", "anton-e2");
    expect(resumeStalledEpic).not.toHaveBeenCalledWith("p1", "anton-e1");
    expect(beadsTag).toHaveBeenCalledWith(project.repoPath, "g-1", [GATE_RESUMED_LABEL]);
  });

  it("applies the dispatch rule to the target the gate moved to, not the one it left", async () => {
    // The frozen ancestor is approved and clear; the bead's new home is not. Reading approval off the
    // stale pointer would enqueue work the founder never approved.
    loadAllIssues.mockResolvedValue(reparentedBoard({ labels: [] }));

    expect(await actOnEscalation(project, (await openGateWait()).id, "resume")).toMatchObject({
      ok: true,
      detail: "gate-still-blocked",
    });
    expect(resumeStalledEpic).not.toHaveBeenCalled();
    expect(beadsTag).not.toHaveBeenCalled();
  });

  it("holds a moved target another machine is already running", async () => {
    // The upstream lease check judged the FROZEN target, where a live lease can be this escalation's
    // own leftover. On a bead the gate moved to there is no such leftover to exempt.
    loadAllIssues.mockResolvedValue(
      reparentedBoard({ labels: [LABELS.approved, LABELS.runLease(Date.now() + HOUR, "run-far")] }),
    );

    expect(await actOnEscalation(project, (await openGateWait()).id, "resume")).toMatchObject({
      ok: true,
      detail: "gate-still-blocked",
    });
    expect(resumeStalledEpic).not.toHaveBeenCalled();
    expect(beadsTag).not.toHaveBeenCalled();
  });

  it("resumes nothing when the gated bead was moved under work anton never dispatches", async () => {
    // A molecule step's gates are bd's to sequence, so there is no run target above it — and no
    // recovery to preserve either, which is why the wait simply ends.
    loadAllIssues.mockResolvedValue([
      {
        id: "anton-t9",
        title: "step",
        status: "open",
        issue_type: "task",
        parent: "m-1",
        dependencies: [{ issue_id: "anton-t9", depends_on_id: "g-1", type: "blocks" }],
      } as Bead,
      { id: "m-1", title: "poured molecule", issue_type: "molecule", status: "open" } as Bead,
      bead(),
    ]);

    expect(await actOnEscalation(project, (await openGateWait()).id, "resume")).toMatchObject({
      ok: true,
      detail: "gate-resolved",
    });
    expect(resumeStalledEpic).not.toHaveBeenCalled();
    expect(beadsTag).not.toHaveBeenCalled();
  });

  it("does not mark the gate on abandon — the work is closed, not handed back", async () => {
    await actOnEscalation(project, (await openGateWait()).id, "abandon");

    expect(beadsTag).not.toHaveBeenCalled();
  });

  it("holds the resume when the board read that would clear it fails", async () => {
    // An unread board is no evidence the way is clear, and every blocker helper reads an unknown
    // blocker as open. Costs one gate-check pass of delay; resuming costs a parked job.
    loadAllIssues.mockRejectedValue(new Error("bd: database is locked"));
    const escalation = await openGateWait();

    expect(await actOnEscalation(project, escalation.id, "resume")).toMatchObject({
      ok: true,
      detail: "gate-still-blocked",
    });
    expect(gateResolve).toHaveBeenCalled();
    expect(resumeStalledEpic).not.toHaveBeenCalled();
  });

  it("closes the gate and stops there when it blocks nothing anton runs", async () => {
    // A gate hung on a molecule step (or on a bead this board read doesn't carry) has no run target
    // above it, so `epicBeadId` is empty by construction — the wait is on the person regardless.
    const escalation = await openGateWait({ epicBeadId: undefined });

    expect(await actOnEscalation(project, escalation.id, "resume")).toMatchObject({
      ok: true,
      detail: "gate-resolved",
    });
    expect(gateResolve).toHaveBeenCalledWith(project.repoPath, "g-1", expect.any(String));
    expect(resumeStalledEpic).not.toHaveBeenCalled();
  });

  it("closes the gate even when the work it blocked has since been deleted", async () => {
    // Without this the row would report "nothing to act on" while leaving the gate open — and the
    // sweep would raise the very same wait on the next pass, unanswerable forever.
    beadsShow.mockImplementation(async (_repo, id) => {
      if (id === "anton-e1") {
        throw Object.assign(new Error("Command failed"), {
          stderr: 'Error: no issue found matching "anton-e1"\n',
        });
      }
      return bead();
    });
    const escalation = await openGateWait();

    expect(await actOnEscalation(project, escalation.id, "resume")).toMatchObject({
      ok: true,
      detail: "gate-resolved",
    });
    expect(gateResolve).toHaveBeenCalled();
    expect(resumeStalledEpic).not.toHaveBeenCalled();
    expect(rowOf(escalation.id)).toMatchObject({ status: "resolved", resolution: "resumed" });
  });

  it("closes the gate on abandon too when the blocked bead has since been deleted", async () => {
    // The mirror of the resume above, through the same empty-target path: with nothing left to close,
    // the gate IS the whole answer. A tightened guard on the gate branch would otherwise silently
    // turn this into "nothing to act on" with the wait still open.
    beadsShow.mockImplementation(async (_repo, id) => {
      if (id === "anton-t9") {
        throw Object.assign(new Error("Command failed"), {
          stderr: 'Error: no issue found matching "anton-t9"\n',
        });
      }
      return bead();
    });
    const escalation = await openGateWait();

    expect(await actOnEscalation(project, escalation.id, "abandon")).toMatchObject({
      ok: true,
      detail: "gate-resolved",
    });
    expect(gateResolve).toHaveBeenCalledWith(project.repoPath, "g-1", expect.any(String));
    expect(abandonTicket).not.toHaveBeenCalled();
    expect(rowOf(escalation.id)).toMatchObject({ status: "resolved", resolution: "abandoned" });
  });

  it("abandons the bead FIRST and closes the gate second", async () => {
    // The other order hands the work straight back: a gate that closes over an open bead is exactly
    // what gate-check's own resume dispatches.
    const escalation = await openGateWait();

    expect(await actOnEscalation(project, escalation.id, "abandon")).toMatchObject({
      ok: true,
      detail: "abandoned",
    });
    expect(abandonTicket.mock.invocationCallOrder[0]).toBeLessThan(
      gateResolve.mock.invocationCallOrder[0]!,
    );
    expect(gateResolve).toHaveBeenCalledWith(project.repoPath, "g-1", expect.any(String));
  });

  it("logs a resolve that landed with a resume that didn't, and leaves it recoverable", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    resumeStalledEpic.mockRejectedValue(new Error("runner refused: project is being deleted"));
    const escalation = await openGateWait();

    await expect(actOnEscalation(project, escalation.id, "resume")).rejects.toThrow(
      "runner refused",
    );

    // The gate is closed over runnable work, which is precisely what gate-check's `plainGateResumes`
    // picks up — so the half that landed is the half that makes the rest recoverable.
    expect(gateResolve).toHaveBeenCalled();
    expect(rowOf(escalation.id)).toMatchObject({ status: "resolved", resolution: "resumed" });
    expect(logged.mock.calls[0]?.[0]).toContain(escalation.id);
    logged.mockRestore();
  });

  it("pushes the closed gate to the shared board", async () => {
    // The close lands in the local Dolt working set and heartbeats are pull-only, so without this
    // teammates keep seeing the wait open — and keep raising this same escalation against it.
    await actOnEscalation(project, (await openGateWait()).id, "resume");

    expect(nudgeSync).toHaveBeenCalledWith(project, "gate-resolve");
    expect(nudgeSync.mock.invocationCallOrder[0]).toBeGreaterThan(
      gateResolve.mock.invocationCallOrder[0]!,
    );
  });

  it("pushes it even when the gate blocks nothing anton runs", async () => {
    // The case with no other cover at all: no run target means no downstream board write, so this
    // nudge is the ONLY thing that ever gets the resolution off this machine.
    const escalation = await openGateWait({ epicBeadId: undefined });

    expect(await actOnEscalation(project, escalation.id, "resume")).toMatchObject({ ok: true });
    expect(nudgeSync).toHaveBeenCalledWith(project, "gate-resolve");
  });

  it("pushes the abandon's gate close too — the abandon's own nudge fired before it", async () => {
    await actOnEscalation(project, (await openGateWait()).id, "abandon");

    expect(nudgeSync).toHaveBeenCalledWith(project, "gate-resolve");
    expect(nudgeSync.mock.invocationCallOrder[0]).toBeGreaterThan(
      gateResolve.mock.invocationCallOrder[0]!,
    );
  });

  it("pushes no CLOSE when the gate was already settled by someone else", async () => {
    // bd refused and the gate is closed anyway: no close of ours landed, so there is nothing of the
    // close to propagate — whoever closed it owns pushing it. The hand-back mark is ours either way,
    // and the resume it records happened here.
    gateResolve.mockRejectedValue(new Error("bd: gate already resolved"));
    showsGateAs(closedGate());

    expect(await actOnEscalation(project, (await openGateWait()).id, "resume")).toMatchObject({
      ok: true,
    });
    expect(nudgeSync).not.toHaveBeenCalledWith(project, "gate-resolve");
    expect(nudgeSync.mock.calls).toEqual([[project, "gate-resumed"]]);
  });

  it("still refuses when the board says another machine picked the work back up", async () => {
    beadsShow.mockResolvedValue(bead([LABELS.runLease(Date.now() + HOUR, "run-elsewhere")]));
    const escalation = await openGateWait();

    expect(await actOnEscalation(project, escalation.id, "resume")).toEqual({
      ok: false,
      reason: "contested",
    });
    // Nothing was touched: the gate is the founder's to close once, not on every stale click.
    expect(gateResolve).not.toHaveBeenCalled();
    expect(rowOf(escalation.id)?.status).toBe("open");
  });

  it("refuses a dismiss — settling the row over an open gate just re-raises it", async () => {
    // The panel offers no Dismiss here, but a direct POST bypasses the panel: settled as dismissed,
    // the gate is still open, so the next sweep raises this same wait and the board bounces
    // "Waiting on you" forever with no server-side way to end it.
    const escalation = await openGateWait();

    expect(await actOnEscalation(project, escalation.id, "dismiss")).toEqual({
      ok: false,
      reason: "not-dismissable",
    });
    expect(rowOf(escalation.id)?.status).toBe("open");
    expect(gateResolve).not.toHaveBeenCalled();
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
