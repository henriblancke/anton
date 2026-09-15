import { describe, expect, it, vi } from "vitest";
import type { Bead } from "../beads/bd";

const listMock = vi.fn<(repo: string, args?: string[]) => Promise<Bead[]>>();
const pushMock = vi.fn<(repo: string) => Promise<string>>();

vi.mock("../beads/bd", async () => {
  const actual = await vi.importActual<typeof import("../beads/bd")>("../beads/bd");
  return {
    ...actual,
    beads: { ...actual.beads, list: listMock, push: pushMock },
  };
});

const {
  boardEvidence,
  fingerprintBoard,
  readBoardBaseline,
  readBoardEvidence,
} = await import("./execute-epic-board-evidence");

function bead(id: string, over: Partial<Bead> = {}): Bead {
  return { id, title: `title-${id}`, status: "open", description: "desc", ...over } as Bead;
}

describe("fingerprintBoard / boardEvidence (anton-fc5x)", () => {
  it("reports nothing changed between two identical reads", () => {
    const before = fingerprintBoard([bead("a"), bead("b")]);
    const after = fingerprintBoard([bead("a"), bead("b")]);
    expect(boardEvidence(before, after)).toEqual([]);
  });

  it("catches an edited description — the anton-f5f3 vocabulary-sweep shape", () => {
    const before = fingerprintBoard([bead("a", { description: "old wording" })]);
    const after = fingerprintBoard([bead("a", { description: "new wording" })]);
    expect(boardEvidence(before, after)).toEqual(["a"]);
  });

  it("catches a newly created bead", () => {
    const before = fingerprintBoard([bead("a")]);
    const after = fingerprintBoard([bead("a"), bead("b")]);
    expect(boardEvidence(before, after)).toEqual(["b"]);
  });

  it("catches a bead that disappeared (deleted or superseded away)", () => {
    const before = fingerprintBoard([bead("a"), bead("b")]);
    const after = fingerprintBoard([bead("a")]);
    expect(boardEvidence(before, after)).toEqual(["b"]);
  });

  it("catches a status change (e.g. a superseded bead closed)", () => {
    const before = fingerprintBoard([bead("a", { status: "open" })]);
    const after = fingerprintBoard([bead("a", { status: "closed" })]);
    expect(boardEvidence(before, after)).toEqual(["a"]);
  });

  it("ignores bookkeeping-label, assignee and note churn — anton's own writes, not the agent's work", () => {
    const before = fingerprintBoard([
      bead("a", { labels: ["stage:implementing"], assignee: "op-1", notes: "old" }),
    ]);
    const after = fingerprintBoard([
      bead("a", {
        labels: ["run-lease:123", "review-score:8"],
        assignee: "op-2",
        notes: "anton: something",
      }),
    ]);
    expect(boardEvidence(before, after)).toEqual([]);
  });

  it("catches a priority change — a board-only ticket may exist to reprioritize a batch (anton-fc5x review round 1)", () => {
    const before = fingerprintBoard([bead("a", { priority: 2 })]);
    const after = fingerprintBoard([bead("a", { priority: 0 })]);
    expect(boardEvidence(before, after)).toEqual(["a"]);
  });

  it("catches a content label change — a board-only ticket may exist to relabel/reparent (anton-fc5x review round 1)", () => {
    const before = fingerprintBoard([bead("a", { labels: ["domain:eng"] })]);
    const after = fingerprintBoard([bead("a", { labels: ["domain:eng", "size:M"] })]);
    expect(boardEvidence(before, after)).toEqual(["a"]);
  });

  it("still ignores bookkeeping labels layered on top of a real content-label change", () => {
    const before = fingerprintBoard([bead("a", { labels: ["domain:eng", "stage:implementing"] })]);
    const after = fingerprintBoard([bead("a", { labels: ["domain:eng", "run-lease:123"] })]);
    expect(boardEvidence(before, after)).toEqual([]);
  });

  it("does not read a reordering of the same labels as a change", () => {
    const before = fingerprintBoard([bead("a", { labels: ["size:M", "domain:eng"] })]);
    const after = fingerprintBoard([bead("a", { labels: ["domain:eng", "size:M"] })]);
    expect(boardEvidence(before, after)).toEqual([]);
  });

  it(
    "KNOWN GAP (anton-fc5x review round 1, finding 2): a write landing on the board from anything " +
      "other than this ticket's own agent — a sibling run, a gardener apply pass — is indistinguishable " +
      "from this ticket's own evidence, because bd exposes no per-edit actor to filter on (see the module " +
      "docstring). Pinned here so a future bd capability that closes this gap is a deliberate change to " +
      "this test, not a silent behavior shift.",
    () => {
      const before = fingerprintBoard([bead("unrelated", { priority: 2 })]);
      // A write this ticket's agent never made — e.g. a concurrent gardener repriotization pass.
      const after = fingerprintBoard([bead("unrelated", { priority: 0 })]);
      expect(boardEvidence(before, after)).toEqual(["unrelated"]);
    },
  );
});

describe("readBoardBaseline / readBoardEvidence (anton-fc5x)", () => {
  it("returns null when the baseline read fails, so the caller fails closed rather than skip the check", async () => {
    listMock.mockRejectedValueOnce(new Error("bd unreachable"));
    await expect(readBoardBaseline("/repo")).resolves.toBeNull();
  });

  it("reports not-found and skips the sync probe when nothing changed", async () => {
    listMock.mockResolvedValueOnce([bead("a")]);
    const baseline = (await readBoardBaseline("/repo"))!;
    listMock.mockResolvedValueOnce([bead("a")]);
    const result = await readBoardEvidence("/repo", baseline);
    expect(result).toEqual({ found: false, ids: [], synced: false });
    expect(pushMock).not.toHaveBeenCalled();
  });

  it("reports found + synced once a real write lands and the push confirms it", async () => {
    listMock.mockResolvedValueOnce([bead("a", { description: "old" })]);
    const baseline = (await readBoardBaseline("/repo"))!;
    listMock.mockResolvedValueOnce([bead("a", { description: "swept" })]);
    pushMock.mockResolvedValueOnce("synced");
    const result = await readBoardEvidence("/repo", baseline);
    expect(result).toEqual({ found: true, ids: ["a"], synced: true });
  });

  it("reports found on a shared Dolt server too — propagation is inherent there", async () => {
    listMock.mockResolvedValueOnce([bead("a", { description: "old" })]);
    const baseline = (await readBoardBaseline("/repo"))!;
    listMock.mockResolvedValueOnce([bead("a", { description: "swept" })]);
    pushMock.mockResolvedValueOnce("shared-server");
    const result = await readBoardEvidence("/repo", baseline);
    expect(result.synced).toBe(true);
  });

  it("reports found but UNSYNCED when the push cannot confirm it — never trusts presence alone", async () => {
    listMock.mockResolvedValueOnce([bead("a", { description: "old" })]);
    const baseline = (await readBoardBaseline("/repo"))!;
    listMock.mockResolvedValueOnce([bead("a", { description: "swept" })]);
    pushMock.mockResolvedValueOnce("not-wired");
    const result = await readBoardEvidence("/repo", baseline);
    expect(result).toEqual({ found: true, ids: ["a"], synced: false });
  });

  it("reports found but unsynced when the push itself throws, rather than crashing the ticket walk", async () => {
    listMock.mockResolvedValueOnce([bead("a", { description: "old" })]);
    const baseline = (await readBoardBaseline("/repo"))!;
    listMock.mockResolvedValueOnce([bead("a", { description: "swept" })]);
    pushMock.mockRejectedValueOnce(new Error("push failed: auth"));
    const result = await readBoardEvidence("/repo", baseline);
    expect(result).toEqual({ found: true, ids: ["a"], synced: false });
  });
});
