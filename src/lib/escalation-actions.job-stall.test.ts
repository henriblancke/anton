/**
 * A stall that names only a JOB — an exhausted `sync-push`/`run-health`/`unstick`, which strands no
 * bead. Answered with the jobs list's own resume/cancel, because without that path such an
 * escalation would have no settling move at all and would sit on the board forever (anton-wvcy).
 */
import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";

import {
  resumeJob,
  cancelJob,
  actOnEscalation,
  getDb,
  schema,
  project,
  finding,
  open,
  seedJob,
  rowOf,
} from "./escalation-actions.fixture";

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
