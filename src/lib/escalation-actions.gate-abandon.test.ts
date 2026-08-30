/**
 * A wait on a person, answered by everything other than a plain resume: the abandon, the closes that
 * are the whole answer on their own, pushing the closed gate to the shared board, and the dismiss the
 * gate refuses (anton-wvcy).
 */
import { describe, expect, it, vi } from "vitest";

import { LABELS } from "./beads/bd";
import {
  resumeStalledEpic,
  abandonTicket,
  beadsShow,
  gateResolve,
  beadsTag,
  loadAllIssues,
  nudgeSync,
  actOnEscalation,
  RunRestartedError,
  HOUR,
  project,
  bead,
  seedExecuteEpicJob,
  rowOf,
  openGateWait,
  showsGateAs,
  closedGate,
  reparentedBoard,
} from "./escalation-actions.fixture";

describe("actOnEscalation — a wait on a person: the abandon and the gate close", () => {
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
      // Reported as what it is. This hold is not a blocker at all — it is anton failing to read the
      // board — and telling the founder to wait for it to "clear" hides a fault behind a feature.
      note: "its board could not be read",
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

  it("gives the abandon no own-run exemption — a wait on a person names no run of ours", async () => {
    // `detectOpenHumanGates` records no runId, so there is no leftover lease of ours for the
    // boundary check to mistake for a holder: every live lease it finds is another machine's.
    await actOnEscalation(project, (await openGateWait()).id, "abandon");

    expect(abandonTicket).toHaveBeenCalledWith(project, "anton-t9", expect.any(String), {
      requireStopped: true,
      ownRunId: undefined,
    });
  });

  it("leaves the gate OPEN when the abandon refuses on a run another machine holds", async () => {
    // The frozen ancestor the pre-settle lease check judged is not the run target the abandon
    // executes under once the bead has been reparented — only `abandonTicket`'s own boundary sees
    // that one. It refuses before the bead closes, and the gate close that follows never runs, so
    // the wait is still on the board for the next sweep to raise (anton-mivh).
    const logged = vi.spyOn(console, "warn").mockImplementation(() => {});
    abandonTicket.mockRejectedValue(
      new RunRestartedError("anton-e2", "is being executed on another machine"),
    );
    const escalation = await openGateWait();

    expect(await actOnEscalation(project, escalation.id, "abandon")).toEqual({
      ok: false,
      reason: "contested",
    });
    expect(gateResolve).not.toHaveBeenCalled();
    logged.mockRestore();
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

  it("does not veto the resume on a run holding the ancestor the gate LEFT", async () => {
    // The reparent case the frozen pointer gets backwards: `anton-e1` is running again, but the gated
    // ticket moved to `anton-e2` and that run has nothing to do with this wait. Vetoing on it would
    // refuse the founder's answer — with no dismiss offered on a wait for a person — until unrelated
    // work stopped. The live target is the one that decides, and it is clear (anton-mivh).
    const leased = () => bead([LABELS.runLease(Date.now() + HOUR, "run-elsewhere")]);
    beadsShow.mockImplementation(async (_repo, id) => (id === "anton-e1" ? leased() : bead()));
    // The same rows the lease read sees, so the two halves cannot be read as disagreeing boards.
    loadAllIssues.mockResolvedValue(
      reparentedBoard().map((b) => (b.id === "anton-e1" ? leased() : b)),
    );
    const escalation = await openGateWait();

    expect(await actOnEscalation(project, escalation.id, "resume")).toMatchObject({
      ok: true,
      detail: "enqueued",
    });
    expect(resumeStalledEpic).toHaveBeenCalledWith("p1", "anton-e2");
    expect(gateResolve).toHaveBeenCalled();
  });

  it("does not veto the abandon on a LOCAL run of that ancestor either", async () => {
    // The same pointer, the machine-local half: an execute-epic running `anton-e1` is not the run this
    // abandon would kill once the ticket hangs elsewhere. `abandonTicket` re-derives the target and
    // refuses at the cancel boundary if THAT one is live (see the RunRestartedError case below).
    seedExecuteEpicJob("running");
    loadAllIssues.mockResolvedValue(reparentedBoard());
    const escalation = await openGateWait();

    expect(await actOnEscalation(project, escalation.id, "abandon")).toMatchObject({
      ok: true,
      detail: "abandoned",
    });
    expect(abandonTicket).toHaveBeenCalledWith(project, "anton-t9", expect.any(String), {
      requireStopped: true,
      ownRunId: undefined,
    });
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
