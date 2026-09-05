/**
 * The two-read board load (anton-ve2r) and, above all, WHO gets to swallow its failure.
 *
 * bd omits gate beads from every ordinary listing while carrying the `blocks` edge a gate puts on
 * the bead it gates, so the second `--type gate` read is the only thing that can tell a resolved
 * gate from an open blocker. Losing it is survivable for a page render and NOT survivable for a job:
 * a run target's own `gh:pr` merge gate is a `blocks` edge on the target, and without the gate bead
 * execute-epic reads it as a real blocker and poisons the run — on a PR closed without merging, a
 * park no later pass can undo. Hence `strictGates`.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Bead } from "./bd";

const listMock = vi.fn();

vi.mock("./bd", async () => {
  const actual = await vi.importActual<typeof import("./bd")>("./bd");
  return {
    ...actual,
    beads: { ...actual.beads, list: (...args: unknown[]) => listMock(...args) },
  };
});

const { loadAllIssues } = await import("./issues");

const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

beforeEach(() => {
  listMock.mockReset();
  warn.mockClear();
});

const REPO = "/tmp/anton";

/** A target carrying the `blocks` edge of a gate the ordinary listing omits. */
const target: Bead = {
  id: "t-1",
  title: "Ship it",
  status: "open",
  issue_type: "task",
  dependencies: [{ issue_id: "t-1", depends_on_id: "g-1", type: "blocks" }],
};
const gate: Bead = { id: "g-1", title: "Gate: gh:pr", status: "closed", issue_type: "gate" };

const isGateRead = (extra: string[] = []) => extra.includes("gate");

describe("loadAllIssues", () => {
  it("folds the gate listing into the board when an edge dangles", async () => {
    listMock.mockImplementation(async (_cwd: string, extra: string[] = []) =>
      isGateRead(extra) ? [gate] : [target],
    );

    expect((await loadAllIssues(REPO)).map((b) => b.id)).toEqual(["t-1", "g-1"]);
  });

  it("degrades to a gate-less board by default — a page render must not fail on it", async () => {
    listMock.mockImplementation(async (_cwd: string, extra: string[] = []) =>
      isGateRead(extra) ? Promise.reject(new Error("bd: database is locked")) : [target],
    );

    expect((await loadAllIssues(REPO)).map((b) => b.id)).toEqual(["t-1"]);
  });

  it("says so once — degrading silently would hide the bead-count drop the ranking is built on", async () => {
    listMock.mockImplementation(async (_cwd: string, extra: string[] = []) =>
      isGateRead(extra) ? Promise.reject(new Error("bd: database is locked")) : [target],
    );

    expect((await loadAllIssues(REPO)).map((b) => b.id)).toEqual(["t-1"]);
    expect(warn).toHaveBeenCalledTimes(1);
    const line = String(warn.mock.calls[0]?.[0]);
    expect(line).toContain(REPO);
    expect(line).toContain("bd: database is locked");
    // The drop itself: how many blockers stay unresolved, and which.
    expect(line).toContain("1 blocker(s)");
    expect(line).toContain("g-1");
  });

  it("stays quiet when the gate listing succeeds", async () => {
    listMock.mockImplementation(async (_cwd: string, extra: string[] = []) =>
      isGateRead(extra) ? [gate] : [target],
    );

    await loadAllIssues(REPO);
    expect(warn).not.toHaveBeenCalled();
  });

  it("leaves the strict failure to the caller rather than logging it as degradation", async () => {
    listMock.mockImplementation(async (_cwd: string, extra: string[] = []) =>
      isGateRead(extra) ? Promise.reject(new Error("bd: database is locked")) : [target],
    );

    await expect(loadAllIssues(REPO, { strictGates: true })).rejects.toThrow();
    expect(warn).not.toHaveBeenCalled();
  });

  it("surfaces that same failure under strictGates, so a job retries instead of poisoning", async () => {
    // The regression: swallowed here, the target's own merge-gate edge stays dangling and
    // execute-epic's fail-safe reads the unknown id as a real blocker → PoisonEpic, parked for a
    // human over a transient CLI failure.
    listMock.mockImplementation(async (_cwd: string, extra: string[] = []) =>
      isGateRead(extra) ? Promise.reject(new Error("bd: database is locked")) : [target],
    );

    await expect(loadAllIssues(REPO, { strictGates: true })).rejects.toThrow("database is locked");
  });

  it("spends no second read — and so cannot fail strictly — on a board with no gate edge", async () => {
    listMock.mockImplementation(async () => [{ ...target, dependencies: [] }]);

    expect((await loadAllIssues(REPO, { strictGates: true })).map((b) => b.id)).toEqual(["t-1"]);
    expect(listMock).toHaveBeenCalledTimes(1);
  });

  it("dedupes, so a bd that starts carrying gates in the ordinary listing doesn't double them", async () => {
    // Two gate edges, one of whose gates the ordinary listing already carries: the other still
    // dangles, so the second read fires and hands back both.
    const second: Bead = { id: "g-2", title: "Gate: timer", status: "open", issue_type: "gate" };
    const blocked: Bead = {
      ...target,
      dependencies: [
        { issue_id: "t-1", depends_on_id: "g-1", type: "blocks" },
        { issue_id: "t-1", depends_on_id: "g-2", type: "blocks" },
      ],
    };
    listMock.mockImplementation(async (_cwd: string, extra: string[] = []) =>
      isGateRead(extra) ? [gate, second] : [blocked, gate],
    );

    expect((await loadAllIssues(REPO)).map((b) => b.id)).toEqual(["t-1", "g-1", "g-2"]);
  });
});
