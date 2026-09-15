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
const cyclesMock = vi.fn();

vi.mock("./bd", async () => {
  const actual = await vi.importActual<typeof import("./bd")>("./bd");
  return {
    ...actual,
    beads: {
      ...actual.beads,
      list: (...args: unknown[]) => listMock(...args),
      depCycles: (...args: unknown[]) => cyclesMock(...args),
    },
  };
});

const {
  allIssues,
  loadAllIssues,
  probeCycleEvidence,
  readAllIssues,
  refreshAllIssues,
  resetCycleProbes,
} = await import("./issues");
const { cycleEvidenceFor } = await import("./cycle-evidence");
const { issueSnapshotVersion, resetIssueSnapshots } = await import("./snapshot");

const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

beforeEach(() => {
  resetIssueSnapshots();
  resetCycleProbes();
  listMock.mockReset();
  cyclesMock.mockReset();
  cyclesMock.mockResolvedValue([]);
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

  it("attaches cycle evidence to the cached board, so approval projections cannot read it cycle-free", async () => {
    listMock.mockResolvedValue([{ ...target, dependencies: [] }]);
    cyclesMock.mockResolvedValue([{ ids: ["t-1"], raw: { cycle: ["t-1"] } }]);

    const board = await allIssues(REPO, { withCycles: true });

    expect(cycleEvidenceFor(board)).toEqual([{ ids: ["t-1"], raw: { cycle: ["t-1"] } }]);
    expect(cyclesMock).toHaveBeenCalledWith(REPO);
  });

  it("keeps cycle evidence on a forced refresh for release re-derivation", async () => {
    listMock.mockResolvedValue([{ ...target, dependencies: [] }]);
    cyclesMock.mockResolvedValue([{ ids: ["t-1"], raw: { cycle: ["t-1"] } }]);

    const board = await refreshAllIssues(REPO, { withCycles: true });

    expect(cycleEvidenceFor(board)).toEqual([{ ids: ["t-1"], raw: { cycle: ["t-1"] } }]);
    expect(cyclesMock).toHaveBeenCalledWith(REPO);
  });

  it("bumps the version when a concurrent non-cycled refresh wins the shared loader race", async () => {
    // Warm the snapshot first so the race below reloads IDENTICAL content — isolating the assertion
    // from the ordinary "first load ever" version bump every cold snapshot gets regardless of cycles.
    listMock.mockResolvedValue([{ ...target, dependencies: [] }]);
    await refreshAllIssues(REPO);
    const before = issueSnapshotVersion(REPO);

    // The shared loader in `refreshIssueSnapshot` is claimed by whichever caller reaches it first
    // (issues.ts:188's own comment: "a concurrent non-authoritative refresh may have won the
    // snapshot loader"). Deterministically stage that race: `refreshAllIssues(REPO)` (no cycles)
    // is called first and claims the in-flight loader before `refreshAllIssues(REPO, {withCycles})`
    // ever runs its own.
    let resolveList!: (value: Bead[]) => void;
    listMock.mockImplementationOnce(
      () => new Promise<Bead[]>((resolve) => { resolveList = resolve; }),
    );
    cyclesMock.mockResolvedValue([{ ids: ["t-1"], raw: { cycle: ["t-1"] } }]);

    const ordinary = refreshAllIssues(REPO);
    const approval = refreshAllIssues(REPO, { withCycles: true });

    resolveList([{ ...target, dependencies: [] }]);
    const [ordinaryBoard, approvalBoard] = await Promise.all([ordinary, approval]);

    expect(approvalBoard).toBe(ordinaryBoard);
    expect(cycleEvidenceFor(approvalBoard)).toEqual([{ ids: ["t-1"], raw: { cycle: ["t-1"] } }]);
    // Content is identical to the warmed baseline, so this bump can only come from the evidence
    // recovery itself — landed OUTSIDE `refreshIssueSnapshot`'s own recovery bump (its loader
    // returned a board with none, so from its point of view nothing changed). Without it a poller
    // stuck on missing evidence would never see a fresh token for a recovery that lands this way.
    expect(issueSnapshotVersion(REPO)).toBeGreaterThan(before);
  });

  it("enriches a warm ordinary snapshot when an approval projection needs cycle evidence", async () => {
    listMock.mockResolvedValue([{ ...target, dependencies: [] }]);
    cyclesMock.mockResolvedValue([{ ids: ["t-1"], raw: { cycle: ["t-1"] } }]);

    const ordinary = await allIssues(REPO);
    const approval = await allIssues(REPO, { withCycles: true });

    expect(approval).toBe(ordinary);
    expect(cycleEvidenceFor(approval)).toEqual([{ ids: ["t-1"], raw: { cycle: ["t-1"] } }]);
    expect(cyclesMock).toHaveBeenCalledTimes(1);
  });

  it("bumps the snapshot version when a synchronous retry recovers evidence a prior read missed", async () => {
    listMock.mockResolvedValue([{ ...target, dependencies: [] }]);
    cyclesMock.mockRejectedValueOnce(new Error("bd: dep cycles timed out"));

    // First read warms the snapshot with no evidence attached (degraded, per the test above).
    await allIssues(REPO, { withCycles: true });
    const before = issueSnapshotVersion(REPO);

    // A later read's retry succeeds — a poller that already matched `before` must see a new token,
    // or it 304s the same empty-startability board until unrelated bead content changes.
    cyclesMock.mockResolvedValueOnce([{ ids: ["t-1"], raw: { cycle: ["t-1"] } }]);
    const board = await allIssues(REPO, { withCycles: true });

    expect(cycleEvidenceFor(board)).toEqual([{ ids: ["t-1"], raw: { cycle: ["t-1"] } }]);
    expect(issueSnapshotVersion(REPO)).toBe(before + 1);
  });

  it("enriches a versioned board read before it reaches a policy projection", async () => {
    listMock.mockResolvedValue([{ ...target, dependencies: [] }]);
    cyclesMock.mockResolvedValue([{ ids: ["t-1"], raw: { cycle: ["t-1"] } }]);

    const snapshot = await readAllIssues(REPO, { withCycles: true });

    expect(cycleEvidenceFor(snapshot.beads)).toEqual([{ ids: ["t-1"], raw: { cycle: ["t-1"] } }]);
    expect(cyclesMock).toHaveBeenCalledWith(REPO);
  });

  it("readAllIssues degrades to a board without cycle evidence rather than fail the whole read", async () => {
    listMock.mockResolvedValue([{ ...target, dependencies: [] }]);
    cyclesMock.mockRejectedValue(new Error("bd: dep cycles timed out"));

    const snapshot = await readAllIssues(REPO, { withCycles: true });

    expect(snapshot.beads.map((b) => b.id)).toEqual(["t-1"]);
    expect(cycleEvidenceFor(snapshot.beads)).toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain("bd: dep cycles timed out");
  });

  it("allIssues degrades to a board without cycle evidence rather than fail the whole read", async () => {
    listMock.mockResolvedValue([{ ...target, dependencies: [] }]);
    cyclesMock.mockRejectedValue(new Error("bd: dep cycles timed out"));

    const board = await allIssues(REPO, { withCycles: true });

    expect(board.map((b) => b.id)).toEqual(["t-1"]);
    expect(cycleEvidenceFor(board)).toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("coalesces concurrent best-effort enrichments into one dep-cycles call and one version bump (PR #274 review, round 6)", async () => {
    // Warm the snapshot with no evidence first, matching several cold page renders sharing one load.
    listMock.mockResolvedValue([{ ...target, dependencies: [] }]);
    await allIssues(REPO);
    const before = issueSnapshotVersion(REPO);

    let resolveCycles!: (evidence: unknown) => void;
    cyclesMock.mockImplementationOnce(
      () => new Promise((resolve) => { resolveCycles = resolve; }),
    );

    // Two independent readers of the same repo — `readAllIssues` and `allIssues` — both observe
    // missing evidence before either enrichment finishes.
    const viaRead = readAllIssues(REPO, { withCycles: true });
    const viaAll = allIssues(REPO, { withCycles: true });

    await vi.waitFor(() => expect(cyclesMock).toHaveBeenCalledTimes(1));
    resolveCycles([{ ids: ["t-1"], raw: { cycle: ["t-1"] } }]);

    const [snapshot, board] = await Promise.all([viaRead, viaAll]);

    expect(cyclesMock).toHaveBeenCalledTimes(1);
    expect(cycleEvidenceFor(snapshot.beads)).toEqual([{ ids: ["t-1"], raw: { cycle: ["t-1"] } }]);
    expect(cycleEvidenceFor(board)).toEqual([{ ids: ["t-1"], raw: { cycle: ["t-1"] } }]);
    expect(issueSnapshotVersion(REPO)).toBe(before + 1);
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

describe("probeCycleEvidence (PR #274 review, round 3)", () => {
  it("shares one in-flight probe per repository instead of spawning one per call", async () => {
    listMock.mockResolvedValue([{ ...target, dependencies: [] }]);
    let resolveCycles!: (evidence: unknown) => void;
    cyclesMock.mockImplementationOnce(
      () => new Promise((resolve) => { resolveCycles = resolve; }),
    );

    // Warm the snapshot without cycle evidence first, matching what the poll route does.
    await allIssues(REPO);

    probeCycleEvidence(REPO);
    probeCycleEvidence(REPO);

    // Both calls landed before the CLI call settled — only the first should have spawned it.
    await vi.waitFor(() => expect(cyclesMock).toHaveBeenCalledTimes(1));

    resolveCycles([{ ids: ["t-1"], raw: { cycle: ["t-1"] } }]);
    await vi.waitFor(async () =>
      expect(cycleEvidenceFor(await allIssues(REPO))).toEqual([
        { ids: ["t-1"], raw: { cycle: ["t-1"] } },
      ]),
    );
  });

  it("bumps the snapshot version only for the probe that attaches evidence, not every success", async () => {
    listMock.mockResolvedValue([{ ...target, dependencies: [] }]);
    cyclesMock.mockResolvedValue([{ ids: ["t-1"], raw: { cycle: ["t-1"] } }]);

    await allIssues(REPO);
    const before = issueSnapshotVersion(REPO);

    probeCycleEvidence(REPO);
    await vi.waitFor(() => expect(issueSnapshotVersion(REPO)).toBe(before + 1));
    expect(cyclesMock).toHaveBeenCalledTimes(1);

    // Evidence is already attached to the retained board, so this probe must not re-fetch or
    // bump the version again.
    probeCycleEvidence(REPO);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(cyclesMock).toHaveBeenCalledTimes(1);
    expect(issueSnapshotVersion(REPO)).toBe(before + 1);
  });
});
