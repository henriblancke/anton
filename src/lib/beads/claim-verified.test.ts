/**
 * The verified claim (anton-9anc) — the sequence that turns "we wrote an assignee" into "we hold
 * this bead", against a fake board that can be interleaved the way two machines actually interleave.
 *
 * What's asserted: the leg ORDER (a claim published after the verify would prove nothing), that a
 * lost race is a value rather than a throw, that every unprovable outcome fails CLOSED, and that the
 * sequence shares the human-claim guard's per-bead lock instead of running beside it.
 */
import { describe, expect, it, vi } from "vitest";
import { beads, type Bead, type ClaimVerifiedDeps, type SyncOutcome } from "./bd";
import { createClaimGuard, type AssigneeStore } from "./claim";

const REPO = "/repo";
const ID = "bd-1";

/**
 * A fake board plus a log of the legs driven against it. `claim` mirrors bd's own semantics: it
 * refuses a bead another actor holds and is idempotent for the same one.
 */
function fakeBoard(opts: { owner?: string; push?: SyncOutcome } = {}) {
  let owner = opts.owner;
  const legs: string[] = [];
  const deps: ClaimVerifiedDeps = {
    settleMs: 0,
    sleep: async () => {
      legs.push("settle");
    },
    pull: async () => {
      legs.push("pull");
    },
    push: async () => {
      legs.push("push");
      return opts.push ?? "synced";
    },
    claim: async (_cwd, _id, actor) => {
      legs.push(`claim ${actor}`);
      if (owner && owner !== actor) throw new Error(`issue already claimed by ${owner}`);
      owner = actor;
    },
    show: async (_cwd, id) => {
      legs.push("show");
      return { id, assignee: owner } as Bead;
    },
  };
  return { deps, legs, owner: () => owner, setOwner: (next: string | undefined) => (owner = next) };
}

describe("beads.claimVerified — the happy path", () => {
  it("pulls, claims, publishes, settles, re-reads, then asserts the assignee", async () => {
    const board = fakeBoard();

    const result = await beads.claimVerified(REPO, ID, "alice", board.deps);

    expect(result).toEqual({ ok: true, bead: { id: ID, assignee: "alice" } });
    expect(board.legs).toEqual(["pull", "claim alice", "push", "settle", "pull", "show"]);
  });

  it("waits the run-lease propagation window before trusting its own read", async () => {
    const board = fakeBoard();
    const sleep = vi.fn(async () => {});

    await beads.claimVerified(REPO, ID, "alice", { ...board.deps, sleep, settleMs: undefined });

    // The 2s constant is shared with the run-lease arbitration — same board, same propagation lag.
    expect(sleep).toHaveBeenCalledWith(2_000);
  });

  it("skips the settle on a board with no remote — there is no rival to wait for", async () => {
    const board = fakeBoard({ push: "not-wired" });

    await expect(beads.claimVerified(REPO, ID, "alice", board.deps)).resolves.toMatchObject({
      ok: true,
    });
    expect(board.legs).toEqual(["pull", "claim alice", "push", "show"]);
  });

  it("re-claiming your own target is idempotent", async () => {
    const board = fakeBoard({ owner: "alice" });

    await expect(beads.claimVerified(REPO, ID, "alice", board.deps)).resolves.toMatchObject({
      ok: true,
    });
  });

  it("trims the actor it asserts, and refuses a blank one", async () => {
    const board = fakeBoard();
    await expect(beads.claimVerified(REPO, ID, " alice ", board.deps)).resolves.toMatchObject({
      ok: true,
    });
    expect(board.owner()).toBe("alice");

    expect(() => beads.claimVerified(REPO, ID, "  ", board.deps)).toThrow(/actor is required/);
  });
});

describe("beads.claimVerified — losing the race", () => {
  it("loses without writing when bd refuses a claim another actor holds", async () => {
    const board = fakeBoard({ owner: "bob" });

    const result = await beads.claimVerified(REPO, ID, "alice", board.deps);

    expect(result).toEqual({ ok: false, reason: "lost", owner: "bob" });
    expect(board.owner()).toBe("bob"); // never stomped
    expect(board.legs).not.toContain("push"); // nothing of ours to publish
  });

  it("loses when the post-settle re-read shows another machine's claim won the merge", async () => {
    // The window the settle exists for: both machines claimed against their own local board, and
    // the merge picked bob. A worker that trusted its own write here would double-run the feature.
    const board = fakeBoard();
    board.deps.sleep = async () => {
      board.setOwner("bob"); // bob's claim reaches the remote while we settle
    };

    await expect(beads.claimVerified(REPO, ID, "alice", board.deps)).resolves.toEqual({
      ok: false,
      reason: "lost",
      owner: "bob",
    });
  });

  it("reports a released bead as lost with no owner rather than as ours", async () => {
    const board = fakeBoard();
    board.deps.sleep = async () => {
      board.setOwner(undefined); // the holder released it while we settled
    };

    await expect(beads.claimVerified(REPO, ID, "alice", board.deps)).resolves.toEqual({
      ok: false,
      reason: "lost",
      owner: undefined,
    });
  });
});

describe("beads.claimVerified — failing closed", () => {
  const unverified = async (deps: ClaimVerifiedDeps, match: RegExp) => {
    const result = await beads.claimVerified(REPO, ID, "alice", deps);
    expect(result).toMatchObject({ ok: false, reason: "unverified" });
    expect((result as { detail: string }).detail).toMatch(match);
  };

  it("never throws — every failure is a verdict the caller can branch on", async () => {
    const board = fakeBoard();
    board.deps.pull = async () => {
      throw new Error("dolt remote unreachable");
    };
    await unverified(board.deps, /could not refresh the board before claiming/);
  });

  it("is unverified — not lost — when bd fails for a reason other than an existing claim", async () => {
    const board = fakeBoard();
    board.deps.claim = async () => {
      throw new Error("database is locked");
    };
    await unverified(board.deps, /bd refused the claim/);
  });

  it("is unverified when the claim landed locally but could not be published", async () => {
    const board = fakeBoard();
    board.deps.push = async () => {
      throw new Error("push rejected");
    };
    await unverified(board.deps, /could not publish the claim/);
    expect(board.owner()).toBe("alice"); // ours locally; the retry re-claims idempotently
  });

  it("is unverified when the verifying re-read fails", async () => {
    const board = fakeBoard();
    board.deps.show = async () => {
      throw new Error("bd exploded");
    };
    await unverified(board.deps, /could not re-read the bead/);
  });
});

describe("beads.claimVerified — composition with the human-claim guard", () => {
  it("queues on the same per-bead lock, so an operator's Claim can't interleave", async () => {
    // One shared owner cell, driven by both seams — the worker's claimVerified and the route's CAS.
    let owner: string | undefined;
    const order: string[] = [];
    const board = fakeBoard();
    board.deps.claim = async (_cwd, _id, actor) => {
      if (owner && owner !== actor) throw new Error(`issue already claimed by ${owner}`);
      owner = actor;
    };
    board.deps.show = async (_cwd, id) => ({ id, assignee: owner }) as Bead;
    board.deps.sleep = async () => {
      await new Promise((r) => setTimeout(r, 20)); // long enough that an unlocked CAS would win
    };

    const store: AssigneeStore = {
      show: async (_cwd, id) => ({ id, assignee: owner }) as Bead,
      assign: async (_cwd, _id, actor) => {
        owner = actor;
      },
      unassign: async () => {
        owner = undefined;
      },
    };
    const guard = createClaimGuard(store);

    const worker = beads.claimVerified(REPO, ID, "anton", board.deps).then((r) => {
      order.push("worker");
      return r;
    });
    const human = guard.setAssigneeIfOwner(REPO, ID, undefined, "alice").then((r) => {
      order.push("human");
      return r;
    });

    await expect(worker).resolves.toMatchObject({ ok: true });
    // alice gated on an unclaimed snapshot, but the worker owns it by the time her swap runs.
    await expect(human).resolves.toEqual({ ok: false, owner: "anton" });
    expect(order).toEqual(["worker", "human"]);
    expect(owner).toBe("anton");
  });

  it("does not serialize claims on different beads", async () => {
    const one = fakeBoard();
    const two = fakeBoard();
    one.deps.sleep = async () => {
      await new Promise((r) => setTimeout(r, 20));
    };

    const [a, b] = await Promise.all([
      beads.claimVerified(REPO, "bd-a", "alice", one.deps),
      beads.claimVerified(REPO, "bd-b", "bob", two.deps),
    ]);

    expect([a.ok, b.ok]).toEqual([true, true]);
  });
});
