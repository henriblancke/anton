import { describe, expect, it } from "vitest";
import { conflictBody, createClaimGuard, ownerOf, type AssigneeStore } from "./claim";
import type { Bead } from "./bd";

/** The guard's one-shot CAS, bound to a fake board — what most of these tests exercise. */
const createAssigneeSwap = (store: AssigneeStore) => createClaimGuard(store).setAssigneeIfOwner;

/**
 * A fake board keyed by bead id (so beads don't share an assignee the way one bead's claim
 * holders do), recording the writes a swap makes against it. `initial` seeds "bd-1", the bead
 * the single-target tests operate on; `owner()` reads it back.
 */
function fakeStore(initial?: string) {
  const owners = new Map<string, string | undefined>([["bd-1", initial]]);
  const calls: string[] = [];
  const store: AssigneeStore = {
    show: async (_cwd, id) => {
      calls.push(`show ${id}`);
      return { id, assignee: owners.get(id) } as Bead;
    },
    assign: async (_cwd, id, actor) => {
      calls.push(`assign ${id} ${actor}`);
      owners.set(id, actor);
    },
    unassign: async (_cwd, id) => {
      calls.push(`unassign ${id}`);
      owners.set(id, undefined);
    },
  };
  return { store, calls, owner: (id = "bd-1") => owners.get(id) };
}

describe("ownerOf", () => {
  it("normalizes a blank or whitespace assignee to unclaimed", () => {
    expect(ownerOf({ id: "x", assignee: "  " } as Bead)).toBeUndefined();
    expect(ownerOf({ id: "x" } as Bead)).toBeUndefined();
    expect(ownerOf(undefined)).toBeUndefined();
    expect(ownerOf({ id: "x", assignee: " alice " } as Bead)).toBe("alice");
  });
});

describe("createAssigneeSwap", () => {
  it("claims an unclaimed target", async () => {
    const { store, owner } = fakeStore(undefined);
    const swap = createAssigneeSwap(store);
    await expect(swap("/repo", "bd-1", undefined, "alice")).resolves.toEqual({ ok: true });
    expect(owner()).toBe("alice");
  });

  it("refuses when the assignee changed since the caller's snapshot, naming the winner", async () => {
    const { store, calls } = fakeStore("bob"); // bob claimed after the route read `undefined`
    const swap = createAssigneeSwap(store);
    await expect(swap("/repo", "bd-1", undefined, "alice")).resolves.toEqual({
      ok: false,
      owner: "bob",
    });
    expect(calls).not.toContain("assign bd-1 alice"); // bob's claim is never stomped
  });

  it("refuses a steal authorized against an owner who no longer holds the claim", async () => {
    const { store, owner } = fakeStore("carol"); // the operator was shown bob, but carol holds it
    const swap = createAssigneeSwap(store);
    await expect(swap("/repo", "bd-1", "bob", "alice")).resolves.toEqual({
      ok: false,
      owner: "carol",
    });
    expect(owner()).toBe("carol");
  });

  it("completes a steal authorized against the owner who still holds the claim", async () => {
    const { store, owner } = fakeStore("bob");
    const swap = createAssigneeSwap(store);
    await expect(swap("/repo", "bd-1", "bob", "alice")).resolves.toEqual({ ok: true });
    expect(owner()).toBe("alice");
  });

  it("re-claiming your own target is a verified no-op — no bd write", async () => {
    const { store, calls } = fakeStore("alice");
    const swap = createAssigneeSwap(store);
    await expect(swap("/repo", "bd-1", "alice", "alice")).resolves.toEqual({ ok: true });
    expect(calls.filter((c) => c.startsWith("assign"))).toEqual([]);
  });

  it("is idempotent when a duplicate same-actor claim raced off the same unclaimed snapshot", async () => {
    // Two requests from one operator (Claim in two tabs, or Claim and Approve together) both gated on
    // `undefined`. The first swap already set the assignee to alice; the second re-reads alice as the
    // owner and must report success — the owner it wanted already holds it — not a 409, even though
    // `before` (alice) no longer matches its `expectedOwner` (undefined).
    const { store, calls } = fakeStore("alice");
    const swap = createAssigneeSwap(store);
    await expect(swap("/repo", "bd-1", undefined, "alice")).resolves.toEqual({ ok: true });
    expect(calls.filter((c) => c.startsWith("assign"))).toEqual([]); // no redundant write
  });

  it("releases a claim, and refuses to release one that changed hands", async () => {
    const held = fakeStore("alice");
    const releaseSwap = createAssigneeSwap(held.store);
    await expect(releaseSwap("/repo", "bd-1", "alice", undefined)).resolves.toEqual({ ok: true });
    expect(held.owner()).toBeUndefined();

    const moved = fakeStore("bob");
    const stale = createAssigneeSwap(moved.store);
    await expect(stale("/repo", "bd-1", "alice", undefined)).resolves.toEqual({
      ok: false,
      owner: "bob",
    });
    expect(moved.owner()).toBe("bob");
  });

  it("serializes concurrent claims on one bead: the loser is told who won, not silently stomped", async () => {
    const { store, owner } = fakeStore(undefined);
    const swap = createAssigneeSwap(store);

    // Both operators gated on the same pre-write snapshot (unclaimed) and fire together — the exact
    // shape the review flagged, where both requests previously returned 200.
    const [first, second] = await Promise.all([
      swap("/repo", "bd-1", undefined, "alice"),
      swap("/repo", "bd-1", undefined, "bob"),
    ]);

    const results = [first, second];
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    const loser = results.find((r) => !r.ok);
    expect(loser).toEqual({ ok: false, owner: owner() });
    expect(owner()).toMatch(/alice|bob/);
  });

  it("does not serialize across different beads", async () => {
    const one = fakeStore(undefined);
    const swapOne = createAssigneeSwap(one.store);
    const [a, b] = await Promise.all([
      swapOne("/repo", "bd-1", undefined, "alice"),
      swapOne("/repo", "bd-2", undefined, "bob"),
    ]);
    expect([a, b]).toEqual([{ ok: true }, { ok: true }]);
  });

  it("reports a conflict when another bd client overwrites the assignee after our write", async () => {
    const { store, owner } = fakeStore(undefined);
    const swap = createAssigneeSwap(store);
    // The post-write read is where an out-of-process writer (a teammate's CLI, the runner) surfaces:
    // the in-process lock can't order it, so the verification must catch it rather than report 200.
    const original = store.show;
    let reads = 0;
    store.show = async (cwd, id) => {
      const bead = await original(cwd, id);
      if (++reads === 2) return { ...bead, assignee: "bob" } as Bead;
      return bead;
    };
    await expect(swap("/repo", "bd-1", undefined, "alice")).resolves.toEqual({
      ok: false,
      owner: "bob",
    });
    expect(owner()).toBe("alice"); // our write landed, but bob's came after — not our claim
  });

  it("a failed swap doesn't wedge the bead's write chain", async () => {
    const { store, owner } = fakeStore(undefined);
    const swap = createAssigneeSwap(store);
    const realAssign = store.assign;
    store.assign = async () => {
      throw new Error("bd exploded");
    };
    await expect(swap("/repo", "bd-1", undefined, "alice")).rejects.toThrow("bd exploded");

    store.assign = realAssign;
    await expect(swap("/repo", "bd-1", undefined, "alice")).resolves.toEqual({ ok: true });
    expect(owner()).toBe("alice");
  });
});

describe("withClaimLock", () => {
  it("holds the lock across work that follows the swap, so a concurrent claim can't interleave", async () => {
    // The approve-vs-claim window: approve swaps the assignee, then labels the bead `approved`, and
    // the label is what locks the reservation. A claim landing between the two would be legal (not
    // approved yet) and would leave the run executing under an owner who never approved it.
    const { store, owner } = fakeStore(undefined);
    const guard = createClaimGuard(store);
    const order: string[] = [];

    const approving = guard.withClaimLock("/repo", "bd-1", async (swap) => {
      const result = await swap(undefined, "alice");
      // Stand in for `beads.approve` — slow enough that an unlocked claim would win the race.
      await new Promise((r) => setTimeout(r, 20));
      order.push("labelled");
      return result;
    });
    const stealing = guard.setAssigneeIfOwner("/repo", "bd-1", undefined, "bob").then((r) => {
      order.push("claim");
      return r;
    });

    await expect(approving).resolves.toEqual({ ok: true });
    // bob gated on `undefined`, but alice owns it by the time his swap runs — he loses, not stomps.
    await expect(stealing).resolves.toEqual({ ok: false, owner: "alice" });
    expect(order).toEqual(["labelled", "claim"]); // the label completed before the claim ran at all
    expect(owner()).toBe("alice");
  });

  it("releases the lock when the body throws, leaving the bead writable", async () => {
    const { store, owner } = fakeStore(undefined);
    const guard = createClaimGuard(store);
    await expect(
      guard.withClaimLock("/repo", "bd-1", async () => {
        throw new Error("approve exploded");
      }),
    ).rejects.toThrow("approve exploded");

    await expect(guard.setAssigneeIfOwner("/repo", "bd-1", undefined, "alice")).resolves.toEqual({
      ok: true,
    });
    expect(owner()).toBe("alice");
  });
});

describe("conflictBody", () => {
  it("names the new owner when one holds the claim", () => {
    const body = conflictBody("bd-1", "bob");
    expect(body.owner).toBe("bob");
    expect(body.error).toContain("bob");
  });

  it("omits the owner when the claim was released mid-flight", () => {
    const body = conflictBody("bd-1", undefined);
    expect(body.owner).toBeUndefined();
    expect(body.error).toContain("bd-1");
  });
});
