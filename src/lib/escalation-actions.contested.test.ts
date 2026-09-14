/**
 * The board moved under the escalation: the work was picked back up (here or on another machine),
 * or it settled itself — and the answers that must refuse rather than act on a frozen snapshot
 * (anton-wvcy). Plus the one case where the action fails AFTER the settle has landed.
 */
import { describe, expect, it, vi } from "vitest";

import { LABELS, type Bead } from "./beads/bd";
import {
  resumeStalledEpic,
  abandonTicket,
  cancelJob,
  beadsPull,
  beadsShow,
  actOnEscalation,
  RunRestartedError,
  HOUR,
  project,
  bead,
  finding,
  open,
  seedExecuteEpicJob,
  rowOf,
} from "./escalation-actions.fixture";

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

    // `ownRunId` carries the exemption down with it: the checks above read the lease through the
    // stalled run's own leftover, and the boundary check must read it the same way — the run target
    // it re-derives is not the ancestor judged here (anton-mivh).
    expect(abandonTicket).toHaveBeenCalledWith(project, "anton-t9", expect.any(String), {
      requireStopped: true,
      ownRunId: "r-1",
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
