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
// Lets one test simulate a concurrent refresh landing in the gap between `readIssueSnapshot`
// resolving and its caller reading the result — the exact race window PR #274 review flagged.
// Defaults to the real implementation so every other test is unaffected.
const readIssueSnapshotMock = vi.fn();

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

vi.mock("./snapshot", async () => {
  const actual = await vi.importActual<typeof import("./snapshot")>("./snapshot");
  readIssueSnapshotMock.mockImplementation(
    (...args: Parameters<typeof actual.readIssueSnapshot>) => actual.readIssueSnapshot(...args),
  );
  return {
    ...actual,
    readIssueSnapshot: (...args: Parameters<typeof actual.readIssueSnapshot>) =>
      readIssueSnapshotMock(...args),
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
const { invalidateIssueSnapshot, issueSnapshotVersion, refreshIssueSnapshot, resetIssueSnapshots } =
  await import("./snapshot");

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

  it("retries rather than attach empty cycle evidence to a board whose own edges are pre-repair (P2 review on PR #274)", async () => {
    // `work`'s own read still carries a `blocks` edge — the cycle's other half sits on some other
    // bead this test doesn't need — that a concurrent repair removes in the gap before `bd dep
    // cycles` runs. Without the recheck, the empty cycles result would land on this stale, still-
    // cyclic-looking `board` as if it described the same revision.
    const other: Bead = { id: "t-2", title: "Other side of the cycle", status: "open", issue_type: "task" };
    const cyclic: Bead = {
      ...target,
      dependencies: [{ issue_id: "t-1", depends_on_id: "t-2", type: "blocks" }],
    };
    const repaired: Bead = { ...target, dependencies: [] };
    listMock
      .mockImplementationOnce(async () => [cyclic, other]) // this call's own work read
      .mockImplementationOnce(async () => [repaired, other]) // the recheck — the repair already landed
      .mockImplementationOnce(async () => [repaired, other]); // retry's work read — no blocks edge left,
    // so the retry's own recheck is skipped (nothing cyclic in this snapshot could be stale)
    cyclesMock.mockResolvedValue([]);

    const board = await loadAllIssues(REPO, { withCycles: true });

    expect(board).toEqual([repaired, other]);
    expect(cycleEvidenceFor(board)).toEqual([]);
    expect(listMock).toHaveBeenCalledTimes(3);
    expect(cyclesMock).toHaveBeenCalledTimes(2);
  });

  it("fails closed instead of retrying forever when the graph keeps moving on every read (P2 review on PR #274)", async () => {
    // Every work read disagrees with the one before it, so `sameBlocksEdges` never converges —
    // simulating sustained shaping/concurrent writers on a shared-server board. Without a retry
    // cap this recurses indefinitely, spawning `bd list`/`bd dep cycles` with no bound.
    let call = 0;
    listMock.mockImplementation(async () => {
      call += 1;
      return [{ ...target, dependencies: [{ issue_id: "t-1", depends_on_id: `g-${call}`, type: "blocks" }] }];
    });
    cyclesMock.mockResolvedValue([]);

    await expect(loadAllIssues(REPO, { withCycles: true })).rejects.toThrow(
      /dependency graph kept moving/,
    );
    // Bounded: one work read per attempt plus the recheck, capped rather than unbounded.
    expect(listMock.mock.calls.length).toBeLessThan(20);
  });

  it("skips the recheck entirely when cycles come back non-empty — already the fail-safe answer", async () => {
    listMock.mockResolvedValue([{ ...target, dependencies: [] }]);
    cyclesMock.mockResolvedValue([{ ids: ["t-1"], raw: { cycle: ["t-1"] } }]);

    await loadAllIssues(REPO, { withCycles: true });

    expect(listMock).toHaveBeenCalledTimes(1);
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

  it("does not reuse a cycles fetch started against the pre-refresh graph once the board's content moves (PR #274 review, round 8)", async () => {
    // A shared-server board can move because ANOTHER machine wrote it, discovered here by a plain
    // TTL/probe refresh with no local invalidation call in between. The generation guard exists to
    // stop a cycles fetch spawned against the graph BEFORE that move from being stamped onto the
    // board AFTER it — this reproduces the race directly rather than waiting out the real TTL.
    listMock.mockResolvedValue([{ ...target, dependencies: [] }]);
    await allIssues(REPO);

    let resolveFirst!: (v: unknown) => void;
    let resolveSecond!: (v: unknown) => void;
    cyclesMock
      .mockImplementationOnce(() => new Promise((resolve) => { resolveFirst = resolve; }))
      .mockImplementationOnce(() => new Promise((resolve) => { resolveSecond = resolve; }));

    // Reader A's cycles fetch starts against the current (pre-refresh) snapshot and stays in flight.
    const readerA = allIssues(REPO, { withCycles: true });
    await vi.waitFor(() => expect(cyclesMock).toHaveBeenCalledTimes(1));

    // The board moves while reader A's fetch is still pending.
    await refreshIssueSnapshot(REPO, async () => [{ ...target, id: "t-2", dependencies: [] }]);

    // Reader B enriches the NEW snapshot. Its generation differs from reader A's in-flight fetch, so
    // it must spawn its own `bd dep cycles` call instead of coalescing onto reader A's.
    const readerB = allIssues(REPO, { withCycles: true });
    await vi.waitFor(() => expect(cyclesMock).toHaveBeenCalledTimes(2));

    resolveFirst([{ ids: ["t-1"], raw: { cycle: ["t-1"] } }]);
    resolveSecond([]);

    const [boardA, boardB] = await Promise.all([readerA, readerB]);

    // Reader A's board predates the move: the generation guard refuses to stamp the stale-graph
    // result onto it, so it stays without evidence rather than report a cycle the current graph no
    // longer necessarily has.
    expect(cycleEvidenceFor(boardA)).toBeUndefined();
    // Reader B's board is the current one and gets its own, fresh evidence.
    expect(boardB.map((b) => b.id)).toEqual(["t-2"]);
    expect(cycleEvidenceFor(boardB)).toEqual([]);
  });

  it("retries readAllIssues rather than pair a pre-move board with the post-move version (PR #274 review)", async () => {
    // A refresh replaces the retained board in the gap between `readIssueSnapshot` resolving and
    // `readAllIssues` reading the generation that pairs with it — the race the review flagged:
    // capturing that generation via a fresh `issueSnapshotGeneration(cwd)` call after the fact can
    // observe the POST-move generation while still holding the PRE-move beads array, so the mismatch
    // check downstream trivially matches itself and never catches the move.
    listMock.mockResolvedValue([{ ...target, dependencies: [] }]);
    await allIssues(REPO);

    readIssueSnapshotMock.mockImplementationOnce(async (...args: unknown[]) => {
      const snapshot = await (
        await vi.importActual<typeof import("./snapshot")>("./snapshot")
      ).readIssueSnapshot(
        ...(args as Parameters<typeof import("./snapshot").readIssueSnapshot>),
      );
      await refreshIssueSnapshot(REPO, async () => [{ ...target, id: "t-2", dependencies: [] }]);
      return snapshot;
    });

    const result = await readAllIssues(REPO, { withCycles: true });

    // Must reflect the board that moved DURING the read, not the stale pre-move one — otherwise the
    // returned version would describe beads the caller never actually returned, and the next
    // `/board?version=...` poll would 304 against content the client never received.
    expect(result.beads.map((b) => b.id)).toEqual(["t-2"]);
    expect(cycleEvidenceFor(result.beads)).toEqual([]);
  });

  it("fails closed instead of retrying forever when the board keeps moving during cycle enrichment (P2 review on PR #274)", async () => {
    // Every enrichment attempt observes another move, just like the `loadAllIssues` consistency
    // retry above — simulating sustained shaping/concurrent writers on a shared-server board.
    // Without a retry cap, `readAllIssues` recurses on the mismatch indefinitely. Each simulated
    // move must actually change content (a fresh id), not just re-bump generation, since
    // `refreshIssueSnapshot` only advances the generation when the loaded content differs.
    //
    // Queued via `mockImplementationOnce` (not a persistent `mockImplementation`), one per attempt
    // the retry cap allows plus the one that trips it — a persistent override would keep forcing
    // moves on every OTHER test's reads too, since this mock isn't reset between tests.
    listMock.mockResolvedValue([{ ...target, dependencies: [] }]);
    await allIssues(REPO);

    const forceMove = (call: number) => async (...args: unknown[]) => {
      const snapshot = await (
        await vi.importActual<typeof import("./snapshot")>("./snapshot")
      ).readIssueSnapshot(
        ...(args as Parameters<typeof import("./snapshot").readIssueSnapshot>),
      );
      await refreshIssueSnapshot(REPO, async () => [
        { ...target, id: `moved-${call}`, dependencies: [] },
      ]);
      return snapshot;
    };
    for (let attempt = 0; attempt <= 3; attempt++) {
      readIssueSnapshotMock.mockImplementationOnce(forceMove(attempt));
    }

    await expect(readAllIssues(REPO, { withCycles: true })).rejects.toThrow(
      /dependency graph kept moving/,
    );
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

  it("re-fetches gates strictly when a concurrent non-strict refresh already claimed the shared loader (PR #274 review)", async () => {
    // Same race as the cycles case above, but for gates: `probeAllIssues`/a bare `refreshAllIssues`
    // reaches `refreshIssueSnapshot` first with a NON-strict loader, so its own internal gate read
    // degrades on failure (swallowed to []) instead of throwing. A caller that asked for
    // `strictGates` must not silently accept that degraded board — it must notice the still-dangling
    // blocker and re-fetch the gate strictly.
    listMock.mockImplementationOnce(async () => [target]); // the one shared work read
    listMock.mockImplementationOnce(async () => {
      throw new Error("bd: database is locked");
    }); // the shared loader's own (non-strict) gate read — degrades, swallowed
    listMock.mockImplementationOnce(async () => [gate]); // this call's own strict re-fetch — succeeds

    const ordinary = refreshAllIssues(REPO);
    const approval = refreshAllIssues(REPO, { strictGates: true });

    const [ordinaryBoard, approvalBoard] = await Promise.all([ordinary, approval]);

    // The plain caller still gets the degraded (pre-existing, intentional) behaviour.
    expect(ordinaryBoard.map((b) => b.id)).toEqual(["t-1"]);
    // The strict caller recovers the gate rather than reading the dangling edge as an open blocker.
    expect(approvalBoard.map((b) => b.id).sort()).toEqual(["g-1", "t-1"]);
  });

  it("keeps cycle evidence attached when the strictGates hydration branch rebuilds the array (PR #274 review)", async () => {
    // Same race as above, but this caller also asks for `withCycles`. The concurrent non-strict
    // refresh wins the shared loader with a gate-less, cycle-less board; this caller then attaches
    // cycle evidence directly onto that shared board (the `withCycles` block above the strictGates
    // one) before the strictGates branch rebuilds a NEW array via `dedupeById` to fold in the
    // recovered gate. `dedupeById` allocates a fresh array, and the cycle sidecar is WeakMap-keyed
    // on identity, so without re-attaching, the evidence just fetched is silently dropped from both
    // this function's return value and the retained snapshot it hydrates.
    listMock.mockImplementationOnce(async () => [target]); // the one shared work read
    listMock.mockImplementationOnce(async () => {
      throw new Error("bd: database is locked");
    }); // the shared loader's own (non-strict) gate read — degrades, swallowed
    listMock.mockImplementationOnce(async () => [gate]); // this call's own strict re-fetch — succeeds
    cyclesMock.mockResolvedValue([{ ids: ["t-1"], raw: { cycle: ["t-1"] } }]);

    const ordinary = refreshAllIssues(REPO);
    const approval = refreshAllIssues(REPO, { withCycles: true, strictGates: true });

    const [, approvalBoard] = await Promise.all([ordinary, approval]);

    expect(approvalBoard.map((b) => b.id).sort()).toEqual(["g-1", "t-1"]);
    expect(cycleEvidenceFor(approvalBoard)).toEqual([{ ids: ["t-1"], raw: { cycle: ["t-1"] } }]);
  });

  it("still throws under strictGates when the shared board is degraded and the re-fetch fails too", async () => {
    listMock.mockImplementationOnce(async () => [target]);
    listMock.mockImplementationOnce(async () => {
      throw new Error("bd: database is locked");
    }); // shared loader's gate read — degrades
    listMock.mockImplementationOnce(async () => {
      throw new Error("bd: database is locked");
    }); // this call's own strict re-fetch — also fails, and strict must let it reject

    const ordinary = refreshAllIssues(REPO);
    const approval = refreshAllIssues(REPO, { strictGates: true });

    await expect(approval).rejects.toThrow("database is locked");
    await expect(ordinary).resolves.toEqual([{ ...target }]);
  });

  it("retries instead of returning a stale hydration when a write lands during the strict re-fetch (PR #274 review)", async () => {
    // Same shared-loader race as above (ordinary wins with a non-strict, gate-less board), but this
    // time a write (`invalidateIssueSnapshot`) lands while the strict caller's own gate re-fetch is
    // still in flight. `hydrateIssueSnapshot`'s generation guard correctly refuses to stamp that
    // re-fetch's result onto the now-different entry — this call must notice the same mismatch and
    // retry against the current board, not hand back the array it built from beads read before the
    // write.
    listMock.mockImplementationOnce(async () => [target]); // shared work read
    listMock.mockImplementationOnce(async () => {
      throw new Error("bd: database is locked");
    }); // shared loader's own (non-strict) gate read — degrades, swallowed

    let resolveStrictRefetch!: (beads: Bead[]) => void;
    listMock.mockImplementationOnce(
      () => new Promise<Bead[]>((resolve) => { resolveStrictRefetch = resolve; }),
    ); // this call's own strict re-fetch — held open to land the write mid-flight

    // The post-retry read: a fresh board that already carries the gate (and the write's content
    // change), so no further gate re-fetch is needed.
    const updated: Bead = { ...target, title: "Ship it (updated)" };
    listMock.mockImplementationOnce(async () => [updated, gate]);

    const ordinary = refreshAllIssues(REPO);
    const approval = refreshAllIssues(REPO, { strictGates: true });

    await ordinary;
    invalidateIssueSnapshot(REPO, true);
    resolveStrictRefetch([gate]);

    const approvalBoard = await approval;

    expect(listMock).toHaveBeenCalledTimes(4);
    expect(approvalBoard.find((b) => b.id === "t-1")?.title).toEqual("Ship it (updated)");
    expect(approvalBoard.map((b) => b.id).sort()).toEqual(["g-1", "t-1"]);
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
