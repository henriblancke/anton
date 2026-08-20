/**
 * A wait on a person, when the gated bead no longer hangs where the sweep froze it: the run target a
 * resume releases is re-derived from the gate's own `blocks` edge, and the dispatch rule is applied
 * to THAT target rather than the stale pointer (anton-wvcy).
 */
import { describe, expect, it } from "vitest";

import { LABELS, type Bead } from "./beads/bd";
import { GATE_RESUMED_LABEL } from "./jobs/gate-targets";
import {
  resumeStalledEpic,
  beadsPull,
  beadsShow,
  gateResolve,
  beadsTag,
  loadAllIssues,
  actOnEscalation,
  HOUR,
  project,
  bead,
  openGateWait,
  reparentedBoard,
} from "./escalation-actions.fixture";

describe("actOnEscalation — a wait on a person: the target the gate releases", () => {
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

  /** bd's answer for the frozen ancestor, with every other bead reading as the ordinary epic. */
  function showsFrozenEpicAs(answer: Bead | Error) {
    beadsShow.mockImplementation(async (_repo, id) => {
      if (id !== "anton-e1") return bead();
      if (answer instanceof Error) throw answer;
      return answer;
    });
  }

  it("resumes the bead's new home when the ancestor the sweep froze was DELETED", async () => {
    // The reparenting case the pre-settle read hides: the frozen `epicBeadId` is gone, so that half
    // reads "nothing left to act on" — while the gate's own `blocks` edge still names a ticket whose
    // new home anton runs. Deciding from the settled pointer would resolve the gate and restart
    // nothing, which is not what "Resolve & resume" says it does.
    showsFrozenEpicAs(
      Object.assign(new Error("Command failed"), {
        stderr: 'Error: no issue found matching "anton-e1"\n',
      }),
    );
    loadAllIssues.mockResolvedValue(reparentedBoard().filter((b) => b.id !== "anton-e1"));

    expect(await actOnEscalation(project, (await openGateWait()).id, "resume")).toMatchObject({
      ok: true,
      detail: "enqueued",
    });
    expect(resumeStalledEpic).toHaveBeenCalledWith("p1", "anton-e2");
    expect(beadsTag).toHaveBeenCalledWith(project.repoPath, "g-1", [GATE_RESUMED_LABEL]);
  });

  it("resumes it when that ancestor was CLOSED by hand too — same dropped pointer", async () => {
    showsFrozenEpicAs({ ...bead(), status: "closed" } as Bead);
    loadAllIssues.mockResolvedValue(
      reparentedBoard().map((b) => (b.id === "anton-e1" ? ({ ...b, status: "closed" } as Bead) : b)),
    );

    expect(await actOnEscalation(project, (await openGateWait()).id, "resume")).toMatchObject({
      ok: true,
      detail: "enqueued",
    });
    expect(resumeStalledEpic).toHaveBeenCalledWith("p1", "anton-e2");
    expect(resumeStalledEpic).not.toHaveBeenCalledWith("p1", "anton-e1");
  });

  it("re-derives even when the sweep could map the gate to no run target at all", async () => {
    // `epicBeadId` is empty by construction when the sweep's board read found nothing anton runs
    // above the gated bead. A reparent since then is exactly what gives it one, and the gate's own
    // edge is the only pointer to it either way.
    loadAllIssues.mockResolvedValue(reparentedBoard());
    const escalation = await openGateWait({ epicBeadId: undefined });

    expect(await actOnEscalation(project, escalation.id, "resume")).toMatchObject({
      ok: true,
      detail: "enqueued",
    });
    expect(resumeStalledEpic).toHaveBeenCalledWith("p1", "anton-e2");
    expect(beadsTag).toHaveBeenCalledWith(project.repoPath, "g-1", [GATE_RESUMED_LABEL]);
  });

  it("applies that same dispatch rule to the new home when the frozen one is gone", async () => {
    // A re-derived target is not a licence to run it: the board's own predicate still decides, and a
    // dropped pointer leaves nothing to fall back on that could say otherwise.
    showsFrozenEpicAs(
      Object.assign(new Error("Command failed"), {
        stderr: 'Error: no issue found matching "anton-e1"\n',
      }),
    );
    loadAllIssues.mockResolvedValue(
      reparentedBoard({ labels: [] }).filter((b) => b.id !== "anton-e1"),
    );

    expect(await actOnEscalation(project, (await openGateWait()).id, "resume")).toMatchObject({
      ok: true,
      detail: "gate-still-blocked",
    });
    expect(resumeStalledEpic).not.toHaveBeenCalled();
    expect(beadsTag).not.toHaveBeenCalled();
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
    // The upstream lease check judged the FROZEN target, so a bead the gate moved to was never
    // checked at all until this one — and a reparent can hand the gate to work already in flight.
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

  it("holds when another machine claimed the target while the gate was closing", async () => {
    // The pre-settle check cleared this target, but a gate close and a board load happen before
    // anything is enqueued — and every anton sharing this board sees the same closed gate, so its
    // gate-check can dispatch inside that window. Enqueueing anyway hands this machine a second
    // execute-epic that can only retry behind the foreign lease.
    loadAllIssues.mockResolvedValue([
      bead([LABELS.approved, LABELS.runLease(Date.now() + HOUR, "run-far")]),
    ]);

    expect(await actOnEscalation(project, (await openGateWait()).id, "resume")).toMatchObject({
      ok: true,
      detail: "gate-still-blocked",
    });
    expect(resumeStalledEpic).not.toHaveBeenCalled();
    // Closed and unmarked is the recovery: gate-check dispatches it once that run lets go.
    expect(beadsTag).not.toHaveBeenCalled();
  });

  it("pulls again before the dispatch read — the local mirror predates the gate close", async () => {
    await actOnEscalation(project, (await openGateWait()).id, "resume");

    // Twice: once for the pre-settle check, once here. A lease published on another machine since
    // that first pull reaches this mirror through the second one or not at all.
    expect(beadsPull).toHaveBeenCalledTimes(2);
    expect(beadsPull.mock.invocationCallOrder[1]).toBeLessThan(
      loadAllIssues.mock.invocationCallOrder[0]!,
    );
  });

  it("holds when THAT pull didn't land — an unrefreshed mirror can't rule a foreign run out", async () => {
    beadsPull.mockResolvedValueOnce(undefined).mockRejectedValue(new Error("dolt pull: unreachable"));

    expect(await actOnEscalation(project, (await openGateWait()).id, "resume")).toMatchObject({
      ok: true,
      detail: "gate-still-blocked",
    });
    // The wait still ended — that half is the founder's answer and it landed.
    expect(gateResolve).toHaveBeenCalled();
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
});
