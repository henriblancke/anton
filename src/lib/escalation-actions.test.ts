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
import type { RunHealthFinding } from "./run-health";
import type { Project } from "./types";

const resumeStalledEpic = vi.fn<(projectId: string, epicBeadId: string) => Promise<string>>();
const abandonTicket = vi.fn<(project: Project, id: string, reason: string) => Promise<unknown>>();
const resumeJob = vi.fn<(projectId: string, jobId: string) => Promise<boolean>>();
const cancelJob =
  vi.fn<
    (projectId: string, jobId: string, only?: readonly string[]) => Promise<{ ok: boolean }>
  >();

vi.mock("./jobs/service", () => ({
  resumeStalledEpic: (...args: [string, string]) => resumeStalledEpic(...args),
  resumeJob: (...args: [string, string]) => resumeJob(...args),
  cancelJob: (...args: [string, string, (readonly string[])?]) => cancelJob(...args),
}));
vi.mock("./abandon", async () => {
  const actual = await vi.importActual<typeof import("./abandon")>("./abandon");
  return { ...actual, abandonTicket: (...args: [Project, string, string]) => abandonTicket(...args) };
});

// The cross-machine half: the pre-settle re-check pulls the shared board and reads the epic's
// run-lease. Stubbed so the lease is the only variable — the real lease parsing is bd.test.ts's job.
const beadsPull = vi.fn<(repoPath: string) => Promise<void>>();
const beadsShow = vi.fn<(repoPath: string, id: string) => Promise<Bead>>();
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

let fileDb: FileDb;
let actOnEscalation: typeof import("./escalation-actions").actOnEscalation;
let isEscalationAction: typeof import("./escalation-actions").isEscalationAction;
let getDb: typeof import("./db").getDb;
let schema: typeof import("./db/schema");
let raiseEscalation: typeof import("./escalations").raiseEscalation;
let settleEscalation: typeof import("./escalations").settleEscalation;

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
});

/** The epic bead the re-check reads the run-lease off; unlabelled means nobody is running it. */
function bead(labels: string[] = []): Bead {
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

  it("falls back to the local snapshot when bd can't answer — the panel stays usable offline", async () => {
    beadsShow.mockRejectedValue(new Error("bd: database is locked"));
    const escalation = await open();

    expect(await actOnEscalation(project, escalation.id, "abandon")).toMatchObject({ ok: true });
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

describe("actOnEscalation — the work was deleted after the stall was raised", () => {
  // A deleted bead is a deliberate settle, and neither verb has anything left to act on: a resume
  // hands execute-epic an id it can only park back on with `bead ... not found` — an intentional
  // deletion turned into a poison job — and an abandon's `abandonTicket` throws on the gone bead
  // AFTER the settle. bd saying "no issue found" is the evidence; bd failing to answer is not.
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

  it("does NOT read a bd that could not answer as a deletion — that is the offline path", async () => {
    beadsShow.mockRejectedValue(new Error("bd: database is locked"));
    const escalation = await open();

    expect(await actOnEscalation(project, escalation.id, "resume")).toMatchObject({
      ok: true,
      detail: "enqueued",
    });
    expect(resumeStalledEpic).toHaveBeenCalledWith("p1", "anton-e1");
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
