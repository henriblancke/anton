/**
 * A wait on a person: closing the gate, the resume that follows it, and the hand-back mark that
 * stops gate-check from resuming the same target again (anton-wvcy).
 */
import { describe, expect, it, vi } from "vitest";

import { LABELS, type Bead } from "./beads/bd";
import { GATE_RESUMED_LABEL } from "./jobs/gate-targets";
import {
  resumeStalledEpic,
  gateResolve,
  beadsTag,
  loadAllIssues,
  nudgeSync,
  actOnEscalation,
  project,
  bead,
  rowOf,
  openGateWait,
  showsGateAs,
  closedGate,
} from "./escalation-actions.fixture";

describe("actOnEscalation — a wait on a person: the gate close and the resume", () => {
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
      // The one hold the panel's bare copy describes correctly — and it still names WHICH blocker,
      // because "another blocker" left unnamed is not something the founder can go and clear.
      note: "it is still blocked by g-2",
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

    // The reason travels WITH the detail. `gate-still-blocked` on its own reads as "a blocker will
    // clear" — but nothing clears here until the founder approves the target, so a panel with only
    // the detail to go on sends them off to wait for an event that never fires.
    expect(await actOnEscalation(project, escalation.id, "resume")).toMatchObject({
      ok: true,
      detail: "gate-still-blocked",
      note: "it is not approved",
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
      // Names the holder: this hold ends on another machine, not on anything here.
      note: "it is claimed by bob",
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
      note: "its PR is in review",
    });
    expect(resumeStalledEpic).not.toHaveBeenCalled();
  });

  it("marks the gate handed back once the resume lands, and pushes the mark", async () => {
    // A resolved gate stays on its bead forever, so without the marker gate-check's `plainGateResumes`
    // re-dispatches this same target every ten minutes — re-running a resume the founder made once.
    // No `note` either: it exists to explain a HOLD, so a resume that LANDED carries none and the
    // panel shows the plain success line with no stray "Held because …" under it.
    expect(await actOnEscalation(project, (await openGateWait()).id, "resume")).toMatchObject({
      ok: true,
      note: undefined,
    });

    expect(beadsTag).toHaveBeenCalledWith(project.repoPath, "g-1", [GATE_RESUMED_LABEL]);
    expect(beadsTag.mock.invocationCallOrder[0]).toBeGreaterThan(
      resumeStalledEpic.mock.invocationCallOrder[0]!,
    );
    expect(nudgeSync).toHaveBeenCalledWith(project, "gate-resumed");
  });

  /**
   * Two human gates over ONE run target, answered one at a time: the first close held the resume (the
   * second gate was still open) and left its gate closed-and-unmarked on purpose, so by the time the
   * founder answers `g-1` the board carries `g-0` closed and unmarked as well. `g-2` hangs over a
   * different target and is nobody's to mark here.
   */
  function twoGatesOverOneTarget(): Bead[] {
    const ticket = (id: string, gateId: string, parent: string): Bead =>
      ({
        id,
        title: "ticket",
        status: "open",
        issue_type: "task",
        parent,
        dependencies: [{ issue_id: id, depends_on_id: gateId, type: "blocks" }],
      }) as Bead;
    const gate = (id: string): Bead =>
      ({ id, title: "Gate: human", issue_type: "gate", status: "closed" }) as Bead;
    const target = (id: string, title: string): Bead =>
      ({
        id,
        title,
        status: "open",
        issue_type: "feature",
        labels: [LABELS.approved],
      }) as Bead;
    return [
      ticket("anton-t9", "g-1", "anton-e1"),
      ticket("anton-t8", "g-0", "anton-e1"),
      ticket("anton-t7", "g-2", "anton-e2"),
      target("anton-e1", "epic"),
      target("anton-e2", "other work"),
      gate("g-1"),
      gate("g-0"),
      gate("g-2"),
    ];
  }

  it("marks EVERY closed gate the resumed target covers, not just the one answered", async () => {
    // Answering the second of two waits on one target is what finally releases it — so the run this
    // starts covers the first gate too. Marking only `g-1` would leave `g-0` closed and unmarked over
    // running work, and gate-check's `plainGateResumes` would resume the target again the moment that
    // run parked or failed — behind the escalation/retry decision's back.
    loadAllIssues.mockResolvedValue(twoGatesOverOneTarget());

    expect(await actOnEscalation(project, (await openGateWait()).id, "resume")).toMatchObject({
      ok: true,
      detail: "enqueued",
    });
    expect(resumeStalledEpic).toHaveBeenCalledTimes(1);
    expect(beadsTag).toHaveBeenCalledWith(project.repoPath, "g-1", [GATE_RESUMED_LABEL]);
    expect(beadsTag).toHaveBeenCalledWith(project.repoPath, "g-0", [GATE_RESUMED_LABEL]);
    // A gate over other work is released by that work's own resume, not by this one.
    expect(beadsTag).not.toHaveBeenCalledWith(project.repoPath, "g-2", [GATE_RESUMED_LABEL]);
    // One push for the batch — the marks travel together.
    expect(nudgeSync.mock.calls.filter(([, r]) => r === "gate-resumed")).toHaveLength(1);
  });

  it("marks the gates it could when one of the marks fails", async () => {
    // Each mark is independent: a bd failure on one must not strand the others unmarked, which would
    // hand gate-check the re-dispatch this whole marker exists to prevent.
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    loadAllIssues.mockResolvedValue(twoGatesOverOneTarget());
    beadsTag.mockImplementation(async (_repo, id) => {
      if (id === "g-1") throw new Error("bd: database is locked");
    });

    expect(await actOnEscalation(project, (await openGateWait()).id, "resume")).toMatchObject({
      ok: true,
      detail: "enqueued",
    });
    expect(beadsTag).toHaveBeenCalledWith(project.repoPath, "g-0", [GATE_RESUMED_LABEL]);
    expect(logged.mock.calls[0]?.[0]).toContain("g-1");
    logged.mockRestore();
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
});
