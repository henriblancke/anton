/**
 * The board primitives merge finalization is built on (anton-qeir). Their contract is what every
 * guarded write in the rehome depends on: a bd failure is evidence of NOTHING — it never reads as a
 * verdict, is never retried into one, and never lets an ancestry walk claim a ticket left the run.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Bead } from "../beads/bd";

const showMock = vi.fn();
const listMock = vi.fn();

vi.mock("../beads/bd", async () => {
  const actual =
    await vi.importActual<typeof import("../beads/bd")>("../beads/bd");
  return {
    ...actual,
    beads: {
      ...actual.beads,
      show: (...args: unknown[]) => showMock(...args),
      list: (...args: unknown[]) => listMock(...args),
    },
  };
});

const { memoisedShow, olderOf, ridesOn, safe, stateOf, tryList, tryShow } =
  await import("./review-fix-board");

const bead = (id: string, parent?: string, extra: Partial<Bead> = {}): Bead => ({
  id,
  title: id,
  status: "open",
  issue_type: "task",
  parent,
  ...extra,
});

beforeEach(() => {
  showMock.mockReset();
  listMock.mockReset();
});

describe("safe", () => {
  it("answers true when the effect completed", async () => {
    expect(await safe(async () => undefined)).toBe(true);
  });

  it("swallows a failure and answers false", async () => {
    expect(
      await safe(async () => {
        throw new Error("bd is down");
      }),
    ).toBe(false);
  });
});

describe("tryShow / tryList", () => {
  it("answer undefined rather than throwing when bd fails", async () => {
    showMock.mockRejectedValue(new Error("bd is down"));
    listMock.mockRejectedValue(new Error("bd is down"));
    expect(await tryShow("/repo", "t1")).toBeUndefined();
    expect(await tryList("/repo")).toBeUndefined();
  });

  it("reads the whole board, closed beads included", async () => {
    listMock.mockResolvedValue([bead("t1")]);
    expect(await tryList("/repo")).toEqual([bead("t1")]);
    expect(listMock).toHaveBeenCalledWith("/repo", ["--status", "all"]);
  });
});

describe("memoisedShow", () => {
  it("reads each bead once, however many walks ask for it", async () => {
    showMock.mockResolvedValue(bead("t1"));
    const read = memoisedShow("/repo", new Map());
    expect(await read("t1")).toEqual(bead("t1"));
    expect(await read("t1")).toEqual(bead("t1"));
    expect(showMock).toHaveBeenCalledTimes(1);
  });

  it("memoises a FAILED read too — unreadable is evidence, not something to retry per walk", async () => {
    showMock.mockRejectedValue(new Error("bd is down"));
    const read = memoisedShow("/repo", new Map());
    expect(await read("t1")).toBeUndefined();
    expect(await read("t1")).toBeUndefined();
    expect(showMock).toHaveBeenCalledTimes(1);
  });

  it("lets the caller drop an entry to take a read for a write it is about to make", async () => {
    const memo = new Map<string, Bead | undefined>();
    const read = memoisedShow("/repo", memo);
    showMock.mockResolvedValueOnce(bead("t1", "epic-1"));
    await read("t1");
    memo.delete("t1");
    showMock.mockResolvedValueOnce(bead("t1", "epic-2"));
    expect(await read("t1")).toEqual(bead("t1", "epic-2"));
  });
});

describe("ridesOn", () => {
  const subtree = (...beads: Bead[]) => new Map(beads.map((b) => [b.id, b]));

  it("finds a directly parented ticket on the target", async () => {
    const read = vi.fn();
    expect(
      await ridesOn(bead("t1", "epic-1"), "epic-1", subtree(), read),
    ).toBe("target");
    expect(read).not.toHaveBeenCalled();
  });

  it("walks the whole chain — a nested ticket still rides on the target", async () => {
    const mid = bead("t2", "epic-1");
    const read = vi.fn().mockResolvedValue(mid);
    expect(
      await ridesOn(bead("t1", "t2"), "epic-1", subtree(mid), read),
    ).toBe("target");
  });

  it("reads each link off the board, not the snapshot: a reparented ancestor is elsewhere", async () => {
    const snapshot = bead("t2", "epic-1");
    const read = vi.fn().mockResolvedValue(bead("t2", "someone-else"));
    expect(
      await ridesOn(bead("t1", "t2"), "epic-1", subtree(snapshot), read),
    ).toBe("elsewhere");
  });

  it("is elsewhere when the chain leaves the run's own ticket set", async () => {
    expect(
      await ridesOn(bead("t1", "other"), "epic-1", subtree(), vi.fn()),
    ).toBe("elsewhere");
  });

  it("is unknown when a link cannot be read — that proves nothing either way", async () => {
    const mid = bead("t2", "epic-1");
    const read = vi.fn().mockResolvedValue(undefined);
    expect(
      await ridesOn(bead("t1", "t2"), "epic-1", subtree(mid), read),
    ).toBe("unknown");
  });

  it("terminates on a parent cycle rather than hanging finalization", async () => {
    const a = bead("t1", "t2");
    const b = bead("t2", "t1");
    const read = vi.fn(async (id: string) => (id === "t1" ? a : b));
    expect(await ridesOn(a, "epic-1", subtree(a, b), read)).toBe("elsewhere");
  });
});

describe("olderOf", () => {
  it("picks the earlier creation time", () => {
    const a = bead("b", undefined, { created_at: "2026-01-01T00:00:00Z" });
    const b = bead("a", undefined, { created_at: "2026-02-01T00:00:00Z" });
    expect(olderOf(a, b).id).toBe("b");
    expect(olderOf(b, a).id).toBe("b");
  });

  it("breaks a tie on the id, so two racing processes reach the SAME bead", () => {
    const a = bead("a", undefined, { created_at: "2026-01-01T00:00:00Z" });
    const b = bead("b", undefined, { created_at: "2026-01-01T00:00:00Z" });
    expect(olderOf(a, b).id).toBe("a");
    expect(olderOf(b, a).id).toBe("a");
  });

  it("sorts a bead with no creation time oldest", () => {
    const a = bead("a", undefined, { created_at: "2026-01-01T00:00:00Z" });
    const undated = bead("z");
    expect(olderOf(a, undated).id).toBe("z");
  });
});

describe("stateOf", () => {
  it("names the status, and the holder when there is one", () => {
    expect(stateOf(bead("t1", undefined, { status: "blocked" }))).toBe(
      "`blocked`",
    );
    expect(
      stateOf(bead("t1", undefined, { status: "in_progress", assignee: "op-1" })),
    ).toBe("`in_progress` under op-1");
  });
});
