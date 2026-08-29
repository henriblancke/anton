/**
 * Unit tests for what a send-back is allowed to touch (anton-51oq): the run target named in the URL,
 * the ticket of its run the founder picked, and the refusal for each way that pair can be wrong.
 *
 * The board read and the local run registry are faked; the classification itself (`isRunTarget`,
 * `runTickets`, the run-lease) is the real one, because that agreement is the point — a rework must
 * not disagree with the runner about what a run contains.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Bead } from "./beads/bd";
import type { Project } from "./types";

const refreshMock = vi.fn<(cwd: string) => Promise<Bead[]>>();
const runIsLiveMock = vi.fn<(projectId: string, targetId: string) => boolean>();

vi.mock("./beads/issues", () => ({
  refreshAllIssues: (cwd: string) => refreshMock(cwd),
}));

vi.mock("./jobs/service", () => ({
  runIsLiveForTarget: (...args: [string, string]) => runIsLiveMock(...args),
}));

const { assertNoLiveRun, resolveReworkScope, runMembers } = await import("./rework-target");
const { ReworkConflictError, ReworkNotAllowedError, ReworkNotFoundError } = await import(
  "./rework-contract"
);

const project: Project = { id: "p1", slug: "p", name: "p", repoPath: "/repo" } as Project;

function makeBead(over: Partial<Bead> & { id: string }): Bead {
  return { title: over.id, status: "open", issue_type: "task", labels: [], ...over };
}

const feature = () => makeBead({ id: "feat", issue_type: "feature", labels: ["approved"] });
const ticketA = () => makeBead({ id: "t1", title: "Ticket one", parent: "feat" });
const ticketB = () => makeBead({ id: "t2", title: "Ticket two", parent: "feat" });

function board(...beadsOnBoard: Bead[]): void {
  refreshMock.mockResolvedValue(beadsOnBoard);
}

/** A live lease held by another machine, and one whose run has long since stopped. */
const liveLease = () => `run-lease:${Date.now() + 60_000}:other-run`;
const lapsedLease = () => `run-lease:${Date.now() - 60_000}:dead-run`;

beforeEach(() => {
  vi.clearAllMocks();
  runIsLiveMock.mockReturnValue(false);
  board(feature(), ticketA(), ticketB());
});

describe("runMembers", () => {
  it("is the feature's tickets when it groups children", () => {
    const all = [feature(), ticketA(), ticketB()];
    expect(runMembers(all[0]!, all).map((b) => b.id)).toEqual(["t1", "t2"]);
  });

  it("is a standalone target itself — it is its own one unit of work", () => {
    const solo = makeBead({ id: "solo" });
    expect(runMembers(solo, [solo]).map((b) => b.id)).toEqual(["solo"]);
  });

  it("is a childless FEATURE itself — a feature shaped as one unit is its own ticket", () => {
    const lone = feature();
    expect(runMembers(lone, [lone]).map((b) => b.id)).toEqual(["feat"]);
  });

  it("reaches a nested ticket, because the run that ships it does", () => {
    const all = [feature(), ticketA(), makeBead({ id: "t1a", parent: "t1" })];
    expect(runMembers(all[0]!, all).map((b) => b.id)).toEqual(["t1", "t1a"]);
  });

  it("is EMPTY for an epic with nothing under it — a run with no work has nothing to send back", () => {
    const epic = makeBead({ id: "ep", issue_type: "epic" });
    expect(runMembers(epic, [epic])).toEqual([]);
  });

  it("never reaches another target's tickets", () => {
    const all = [
      feature(),
      ticketA(),
      makeBead({ id: "other", issue_type: "feature" }),
      makeBead({ id: "t9", parent: "other" }),
    ];
    expect(runMembers(all[0]!, all).map((b) => b.id)).toEqual(["t1"]);
  });
});

describe("assertNoLiveRun", () => {
  it("refuses while THIS machine holds a run on the target", () => {
    runIsLiveMock.mockReturnValue(true);
    expect(() => assertNoLiveRun("p1", feature())).toThrow(ReworkConflictError);
    expect(() => assertNoLiveRun("p1", feature())).toThrow(/run in flight/);
    expect(runIsLiveMock).toHaveBeenCalledWith("p1", "feat");
  });

  it("refuses on another machine's unexpired run-lease — the only evidence of a foreign run", () => {
    const leased = makeBead({ id: "feat", issue_type: "feature", labels: [liveLease()] });
    expect(() => assertNoLiveRun("p1", leased)).toThrow(ReworkConflictError);
    expect(() => assertNoLiveRun("p1", leased)).toThrow(/another machine/);
  });

  it("proceeds past a LAPSED lease — an expired lease is a stopped run, not a live one", () => {
    const lapsed = makeBead({ id: "feat", issue_type: "feature", labels: [lapsedLease()] });
    expect(() => assertNoLiveRun("p1", lapsed)).not.toThrow();
  });

  it("is silent when no run holds the target on either machine", () => {
    expect(() => assertNoLiveRun("p1", feature())).not.toThrow();
  });
});

describe("resolveReworkScope", () => {
  it("re-reads the board rather than taking a warm one, and returns the pair it vetted", async () => {
    const scope = await resolveReworkScope(project, "feat", "t1");
    expect(refreshMock).toHaveBeenCalledWith("/repo");
    expect(scope.target.id).toBe("feat");
    expect(scope.ticket.id).toBe("t1");
    expect(scope.all.map((b) => b.id)).toEqual(["feat", "t1", "t2"]);
  });

  it("resolves a standalone target as its own ticket", async () => {
    board(makeBead({ id: "solo" }));
    const scope = await resolveReworkScope(project, "solo", "solo");
    expect(scope.target.id).toBe("solo");
    expect(scope.ticket.id).toBe("solo");
  });

  it("404s an id the board doesn't carry", async () => {
    await expect(resolveReworkScope(project, "nope", "t1")).rejects.toBeInstanceOf(
      ReworkNotFoundError,
    );
  });

  it("422s a container epic — rework is decided against a run, and a container never runs", async () => {
    board(
      makeBead({ id: "container", issue_type: "epic" }),
      makeBead({ id: "feat", issue_type: "feature", parent: "container" }),
      ticketA(),
    );
    await expect(resolveReworkScope(project, "container", "t1")).rejects.toBeInstanceOf(
      ReworkNotAllowedError,
    );
    await expect(resolveReworkScope(project, "container", "t1")).rejects.toThrow(
      /not a run target/,
    );
  });

  it("422s a child ticket named as the target — its run is the feature above it", async () => {
    await expect(resolveReworkScope(project, "t1", "t1")).rejects.toThrow(/not a run target/);
  });

  it("422s a ticket that belongs to another run target", async () => {
    board(feature(), ticketA(), makeBead({ id: "stranger" }));
    await expect(resolveReworkScope(project, "feat", "stranger")).rejects.toBeInstanceOf(
      ReworkNotAllowedError,
    );
    await expect(resolveReworkScope(project, "feat", "stranger")).rejects.toThrow(
      /not part of feat's run/,
    );
  });

  it("409s once the pair is known good and a run holds the target", async () => {
    runIsLiveMock.mockReturnValue(true);
    await expect(resolveReworkScope(project, "feat", "t1")).rejects.toBeInstanceOf(
      ReworkConflictError,
    );
  });

  it("tells the founder what is wrong with their REQUEST before telling them to wait for a run", async () => {
    // A founder acting on a stale report gets the membership refusal, not "come back later" — the
    // live-run check runs last, on a pair already known to be real.
    runIsLiveMock.mockReturnValue(true);
    await expect(resolveReworkScope(project, "feat", "gone")).rejects.toBeInstanceOf(
      ReworkNotAllowedError,
    );
    await expect(resolveReworkScope(project, "missing", "t1")).rejects.toBeInstanceOf(
      ReworkNotFoundError,
    );
  });

  it("409s on another machine's lease too, without a local run", async () => {
    board(makeBead({ id: "feat", issue_type: "feature", labels: [liveLease()] }), ticketA());
    await expect(resolveReworkScope(project, "feat", "t1")).rejects.toThrow(/another machine/);
  });
});
