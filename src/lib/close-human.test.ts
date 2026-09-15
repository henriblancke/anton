import { beforeEach, describe, expect, it, vi } from "vitest";
import { LABELS, type Bead } from "./beads/bd";
import type { Project } from "./types";

const showMock = vi.fn();
const listMock = vi.fn();
const closeMock = vi.fn();
const cancelRunMock = vi.fn();

vi.mock("./beads/bd", async () => {
  const actual = await vi.importActual<typeof import("./beads/bd")>("./beads/bd");
  return {
    ...actual,
    beads: {
      ...actual.beads,
      show: (...args: unknown[]) => showMock(...args),
      list: (...args: unknown[]) => listMock(...args),
      close: (...args: unknown[]) => closeMock(...args),
    },
  };
});

vi.mock("./jobs/service", () => ({
  cancelRunForTarget: (...args: unknown[]) => cancelRunMock(...args),
}));

vi.mock("./ticket-detail", () => ({
  freshDetail: vi.fn().mockResolvedValue({ id: "detail" }),
}));

vi.mock("./beads/sync-nudge", () => ({
  nudgeSync: vi.fn(),
}));

const { closeHumanTicket, NotCloseableError } = await import("./close-human");

function makeBead(overrides: Partial<Bead> & { id: string }): Bead {
  return {
    title: overrides.id,
    status: "open",
    issue_type: "task",
    labels: [LABELS.agentHuman],
    ...overrides,
  };
}

describe("closeHumanTicket", () => {
  const project: Project = {
    id: "p1",
    slug: "anton",
    name: "anton",
    repoPath: "/tmp/anton",
    defaultBranch: "main",
    hasBeads: true,
    createdAt: 0,
  };

  beforeEach(() => {
    showMock.mockReset();
    listMock.mockReset();
    closeMock.mockReset().mockResolvedValue(undefined);
    cancelRunMock.mockReset().mockResolvedValue(false);
  });

  it("rejects a held human child ticket without cancelling the run it lives under", async () => {
    // feature is an ordinary, active run target; ticket is its agent:human child, currently held
    // by a gate that same run armed on it (execute-epic-human-gate.ts's armHumanTicketGates).
    const ticket = makeBead({ id: "ticket", parent: "feature" });
    const feature = makeBead({
      id: "feature",
      issue_type: "feature",
      labels: [],
    });
    const gate = makeBead({ id: "gate-1", issue_type: "chore", labels: [], status: "open" });
    const board = [
      feature,
      { ...ticket, dependencies: [{ issue_id: "ticket", depends_on_id: "gate-1", type: "blocks" }] },
      gate,
    ];
    showMock.mockResolvedValue(ticket);
    listMock.mockResolvedValue(board);

    await expect(closeHumanTicket(project, "ticket")).rejects.toThrow(NotCloseableError);

    // The whole point: nothing was cancelled, and bd close was never even attempted — the caller
    // is told to resolve the gate instead of a destructive cancel-then-fail round trip.
    expect(cancelRunMock).not.toHaveBeenCalled();
    expect(closeMock).not.toHaveBeenCalled();
  });

  it("rejects an agent:human child of a live, open, ordinary target BEFORE its gate is armed", async () => {
    // feature is open and ordinary (not agent:human), and the run's human-ticket preflight has not
    // reached `ticket` yet — no `blocks` dependency exists on it at all, so openBlockersOf alone
    // would read it as clear. The target still holds a run that could reach it, so this must still
    // refuse rather than cancel that run out from under its other, unrelated work.
    const ticket = makeBead({ id: "ticket", parent: "feature" });
    const feature = makeBead({ id: "feature", issue_type: "feature", labels: [] });
    const board = [feature, ticket];
    showMock.mockResolvedValue(ticket);
    listMock.mockResolvedValue(board);

    await expect(closeHumanTicket(project, "ticket")).rejects.toThrow(NotCloseableError);

    expect(cancelRunMock).not.toHaveBeenCalled();
    expect(closeMock).not.toHaveBeenCalled();
  });

  it("closes an agent:human child once its target has settled (closed) — no run is coming for it", async () => {
    const ticket = makeBead({ id: "ticket", parent: "feature" });
    const feature = makeBead({ id: "feature", issue_type: "feature", labels: [], status: "closed" });
    const board = [feature, ticket];
    listMock.mockResolvedValue(board);
    showMock.mockResolvedValueOnce(ticket).mockResolvedValueOnce({ ...ticket, status: "closed" });

    await closeHumanTicket(project, "ticket");

    expect(cancelRunMock).toHaveBeenCalledWith("p1", "feature");
    expect(closeMock).toHaveBeenCalledWith("/tmp/anton", "ticket");
  });

  it("closes a human run target with no open blockers, cancelling only its own run", async () => {
    const target = makeBead({ id: "target" });
    listMock.mockResolvedValue([target]);
    showMock.mockResolvedValueOnce(target).mockResolvedValueOnce({ ...target, status: "closed" });

    await closeHumanTicket(project, "target");

    expect(cancelRunMock).toHaveBeenCalledWith("p1", "target");
    expect(closeMock).toHaveBeenCalledWith("/tmp/anton", "target");
  });

  it("lets a bd close infrastructure failure propagate instead of reading it as unclosable", async () => {
    const target = makeBead({ id: "target" });
    listMock.mockResolvedValue([target]);
    showMock.mockResolvedValue(target);
    closeMock.mockRejectedValue(new Error("bd: connection refused"));

    await expect(closeHumanTicket(project, "target")).rejects.toThrow("connection refused");
    await expect(closeHumanTicket(project, "target")).rejects.not.toBeInstanceOf(NotCloseableError);
  });

  it("maps bd's own close refusal (an open blocker it discovers itself) to NotCloseableError", async () => {
    const target = makeBead({ id: "target" });
    listMock.mockResolvedValue([target]);
    showMock.mockResolvedValue(target);
    closeMock.mockRejectedValue(new Error("blocked by open issues [gate-1] (use --force to override)"));

    await expect(closeHumanTicket(project, "target")).rejects.toThrow(NotCloseableError);
  });

  it("closes a task parented directly on a container epic — no run target in its ancestry", async () => {
    // PR #288 review: `runTargetOf`'s abandon-cascade fallback resolves the immediate parent when the
    // walk finds no run target at all, so a task sibling to a `feature` on a CONTAINER epic (one with
    // a feature child elsewhere) used to read the container as still "holding" a live run — 409ing
    // this route pointing at a target that can never itself run. The board's own `holdsRun` read
    // (ticket-detail.ts, operator-queue.ts) already answers false here; this route must agree.
    const epic = makeBead({ id: "epic", issue_type: "epic", labels: [] });
    const feature = makeBead({ id: "feature", issue_type: "feature", parent: "epic", labels: [] });
    const ticket = makeBead({ id: "ticket", issue_type: "task", parent: "epic" });
    const board = [epic, feature, ticket];
    listMock.mockResolvedValue(board);
    showMock.mockResolvedValueOnce(ticket).mockResolvedValueOnce({ ...ticket, status: "closed" });

    await closeHumanTicket(project, "ticket");

    expect(cancelRunMock).toHaveBeenCalledWith("p1", "epic");
    expect(closeMock).toHaveBeenCalledWith("/tmp/anton", "ticket");
  });

  it("does not refuse on a task poured under an open molecule — the whole pipeline subtree is pruned", async () => {
    // Codex review (PR #288): filtering only the molecule/gate NODES still left a poured `task` step
    // underneath them in `open`, so this route kept 409ing for the run's whole lifetime.
    const target = makeBead({ id: "target", issue_type: "feature" });
    const molecule = makeBead({ id: "mol-1", parent: "target", issue_type: "molecule", labels: [] });
    const step = makeBead({ id: "step-1", parent: "mol-1", issue_type: "task", labels: [] });
    const board = [target, molecule, step];
    listMock.mockResolvedValue(board);
    showMock.mockResolvedValueOnce(target).mockResolvedValueOnce({ ...target, status: "closed" });

    await closeHumanTicket(project, "target");

    expect(cancelRunMock).toHaveBeenCalledWith("p1", "target");
    expect(closeMock).toHaveBeenCalledWith("/tmp/anton", "target");
  });

  it("does not refuse on an open molecule/gate hung under the target — pipeline plumbing, not open work", async () => {
    // The poured-run shape (gate-molecule.integration.test.ts): a molecule root and its gate
    // children sit open under the feature for as long as its run does. A feature relabelled
    // agent:human mid-run must still be closeable rather than 409ing on its own run plumbing.
    const target = makeBead({ id: "target", issue_type: "feature" });
    const molecule = makeBead({ id: "mol-1", parent: "target", issue_type: "molecule", labels: [] });
    const gate = makeBead({ id: "gate-1", parent: "mol-1", issue_type: "gate", labels: [] });
    const board = [target, molecule, gate];
    listMock.mockResolvedValue(board);
    showMock.mockResolvedValueOnce(target).mockResolvedValueOnce({ ...target, status: "closed" });

    await closeHumanTicket(project, "target");

    expect(cancelRunMock).toHaveBeenCalledWith("p1", "target");
    expect(closeMock).toHaveBeenCalledWith("/tmp/anton", "target");
  });

  it("does not cancel the enclosing feature's run for an agent:human bead poured under a molecule", async () => {
    // Codex review (PR #288): `runTargetOf` walks straight through pipeline plumbing to the
    // enclosing feature, but that feature's ordinary run never dispatches a step poured under a
    // molecule — cancelling it here would kill a healthy, unrelated run.
    const feature = makeBead({ id: "feature", issue_type: "feature", labels: [], status: "open" });
    const molecule = makeBead({ id: "mol-1", parent: "feature", issue_type: "molecule", labels: [] });
    const step = makeBead({ id: "step-1", parent: "mol-1" });
    const board = [feature, molecule, step];
    listMock.mockResolvedValue(board);
    showMock.mockResolvedValueOnce(step).mockResolvedValueOnce({ ...step, status: "closed" });

    await closeHumanTicket(project, "step-1");

    expect(cancelRunMock).not.toHaveBeenCalled();
    expect(closeMock).toHaveBeenCalledWith("/tmp/anton", "step-1");
  });

  it("does not cancel a standalone task's run for its own agent:human child — that run never touches it", async () => {
    // Same mismatch, different shape (execute-epic-start.ts selectRunTickets / rework.test.ts): a
    // standalone task/bug's run executes only the parent itself, never its children.
    const solo = makeBead({ id: "solo", issue_type: "task", labels: [], status: "open" });
    const child = makeBead({ id: "child", parent: "solo" });
    const board = [solo, child];
    listMock.mockResolvedValue(board);
    showMock.mockResolvedValueOnce(child).mockResolvedValueOnce({ ...child, status: "closed" });

    await closeHumanTicket(project, "child");

    expect(cancelRunMock).not.toHaveBeenCalled();
    expect(closeMock).toHaveBeenCalledWith("/tmp/anton", "child");
  });
});
