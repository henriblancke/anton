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

  it("ignores label, assignee, note and priority churn — anton's own bookkeeping, not the agent's work", () => {
    const before = fingerprintBoard([
      bead("a", { labels: ["stage:implementing"], assignee: "op-1", priority: 2, notes: "old" }),
    ]);
    const after = fingerprintBoard([
      bead("a", {
        labels: ["run-lease:123", "review-score:8"],
        assignee: "op-2",
        priority: 1,
        notes: "anton: something",
      }),
    ]);
    expect(boardEvidence(before, after)).toEqual([]);
  });
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
