import { describe, expect, it } from "vitest";
import { createClaimGuard, type AssigneeStore } from "./claim";
import {
  assignableChildren,
  assignChildren,
  formatReservedChildren,
  releaseChildren,
} from "./child-assign";
import { LABELS, type Bead } from "./bd";

/** A fake board of `id → assignee`, recording every write the cascade makes against it. */
function fakeBoard(owners: Record<string, string | undefined>) {
  const state = new Map(Object.entries(owners));
  const calls: string[] = [];
  const store: AssigneeStore = {
    show: async (_cwd, id) => ({ id, assignee: state.get(id) }) as Bead,
    assign: async (_cwd, id, actor) => {
      calls.push(`assign ${id} ${actor}`);
      state.set(id, actor);
    },
    unassign: async (_cwd, id) => {
      calls.push(`unassign ${id}`);
      state.set(id, undefined);
    },
  };
  return { guard: createClaimGuard(store), calls, owner: (id: string) => state.get(id) };
}

const bead = (id: string, extra: Partial<Bead> = {}): Bead =>
  ({ id, status: "open", ...extra }) as Bead;

describe("assignableChildren", () => {
  it("skips beads whose outcome is already settled", () => {
    const children = [
      bead("t-open"),
      bead("t-running", { status: "in_progress" }),
      bead("t-closed", { status: "closed" }),
      bead("t-abandoned", { status: "closed", labels: [LABELS.abandoned] }),
    ];
    expect(assignableChildren(children).map((c) => c.id)).toEqual(["t-open", "t-running"]);
  });
});

describe("assignChildren", () => {
  it("reserves every open child for the claiming actor", async () => {
    const { guard, owner } = fakeBoard({ "t-1": undefined, "t-2": undefined });
    const result = await assignChildren("/repo", [bead("t-1"), bead("t-2")], "anton", guard);

    expect(result).toEqual({ held: ["t-1", "t-2"], reserved: [], failed: [] });
    expect(owner("t-1")).toBe("anton");
    expect(owner("t-2")).toBe("anton");
  });

  it("leaves a child another actor holds alone, and reports who holds it", async () => {
    const { guard, calls, owner } = fakeBoard({ "t-1": undefined, "t-human": "founder" });
    const result = await assignChildren("/repo", [bead("t-1"), bead("t-human")], "anton", guard);

    expect(result.held).toEqual(["t-1"]);
    expect(result.reserved).toEqual([{ id: "t-human", owner: "founder" }]);
    expect(owner("t-human")).toBe("founder");
    expect(calls).not.toContain("assign t-human anton");
  });

  // A prior attempt of the same run left its reservations behind; the resumed attempt must take
  // them back over so its own stop hands them back rather than stranding them assigned.
  it("adopts a child it already holds without a redundant write", async () => {
    const { guard, calls } = fakeBoard({ "t-1": "anton" });
    const result = await assignChildren("/repo", [bead("t-1")], "anton", guard);

    expect(result.held).toEqual(["t-1"]);
    expect(calls).toEqual([]);
  });

  it("never touches a settled child", async () => {
    const { guard, calls } = fakeBoard({ "t-closed": undefined });
    const result = await assignChildren(
      "/repo",
      [bead("t-closed", { status: "closed" })],
      "anton",
      guard,
    );

    expect(result).toEqual({ held: [], reserved: [], failed: [] });
    expect(calls).toEqual([]);
  });

  // A cascade that only half landed must still report what it TOOK: the caller stops the run over
  // the failure, and the stop can only hand back reservations it knows about.
  it("reports a failed reservation while keeping the ones it did take", async () => {
    const { guard, owner } = fakeBoard({ "t-1": undefined, "t-2": undefined });
    const flaky = {
      ...guard,
      setAssigneeIfOwner: (repo: string, id: string, expected?: string, next?: string) =>
        id === "t-2"
          ? Promise.reject(new Error("bd db is locked"))
          : guard.setAssigneeIfOwner(repo, id, expected, next),
    };
    const result = await assignChildren("/repo", [bead("t-1"), bead("t-2")], "anton", flaky);

    expect(result.held).toEqual(["t-1"]);
    expect(result.failed).toEqual([{ id: "t-2", error: "bd db is locked" }]);
    expect(owner("t-1")).toBe("anton");
  });
});

describe("releaseChildren", () => {
  it("hands back only the children the actor still holds", async () => {
    const { guard, calls, owner } = fakeBoard({ "t-1": "anton", "t-stolen": "founder" });
    const released = await releaseChildren("/repo", ["t-1", "t-stolen"], "anton", guard);

    expect(released).toEqual(["t-1"]);
    expect(owner("t-1")).toBeUndefined();
    expect(owner("t-stolen")).toBe("founder"); // a takeover mid-run keeps its new owner
    expect(calls).toEqual(["unassign t-1"]);
  });

  it("survives a bd write that fails, releasing the rest", async () => {
    const { guard } = fakeBoard({ "t-1": "anton", "t-2": "anton" });
    const flaky = {
      ...guard,
      setAssigneeIfOwner: (repo: string, id: string, expected?: string, next?: string) =>
        id === "t-1"
          ? Promise.reject(new Error("bd db is locked"))
          : guard.setAssigneeIfOwner(repo, id, expected, next),
    };
    await expect(releaseChildren("/repo", ["t-1", "t-2"], "anton", flaky)).resolves.toEqual([
      "t-2",
    ]);
  });
});

describe("formatReservedChildren", () => {
  it("names each child and who holds it", () => {
    expect(
      formatReservedChildren([
        { id: "t-1", owner: "founder" },
        { id: "t-2", owner: "teammate" },
      ]),
    ).toBe("t-1 → founder, t-2 → teammate");
  });
});
