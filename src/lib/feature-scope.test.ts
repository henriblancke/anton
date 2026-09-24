/**
 * The ledger's scope resolution (anton-x72fk), tested where it can under- or over-report.
 *
 * Every claim here is about WHICH ids a feature's spend is summed over, and each failure mode is a
 * wrong total that still looks like a total: a nested descendant left out under-reports the features
 * that decomposed furthest, a nested feature pulled in double-counts across two ledgers, and a root
 * dropped for not being on the board loses every run-phase invocation stamped against the target.
 */
import { describe, expect, it } from "vitest";
import { currentRunTargetOf, hasLedgerScope, ledgerScope } from "./feature-scope";
import type { Bead } from "./beads/bd";

function makeBead(overrides: Partial<Bead> & { id: string }): Bead {
  return { title: overrides.id, status: "open", issue_type: "task", labels: [], ...overrides };
}

/** epic → feature → task → subtask, plus a second feature that owns its own run. */
const board: Bead[] = [
  makeBead({ id: "epic-p", issue_type: "epic" }),
  makeBead({ id: "feat-1", issue_type: "feature", parent: "epic-p" }),
  makeBead({ id: "task-1", parent: "feat-1" }),
  makeBead({ id: "sub-1", parent: "task-1" }),
  makeBead({ id: "bug-1", issue_type: "bug", parent: "feat-1" }),
  makeBead({ id: "feat-2", issue_type: "feature", parent: "epic-p" }),
  makeBead({ id: "task-2", parent: "feat-2" }),
];

describe("ledgerScope", () => {
  it("resolves a feature to itself plus its working-layer descendants, nested ones included", () => {
    // `sub-1` is two hops down and ships in feat-1's worktree and PR, so its invocations are part of
    // what feat-1 cost. A direct-children scope would silently under-report exactly this shape.
    const scope = ledgerScope(board, "feat-1");
    expect(scope.ids).toEqual(["feat-1", "task-1", "sub-1", "bug-1"]);
    expect(scope.beadId).toBe("feat-1");
    expect(scope.childIds).toEqual(["task-1", "sub-1", "bug-1"]);
    expect(scope.target?.id).toBe("feat-1");
  });

  it("leaves a sibling feature's tickets out", () => {
    expect(ledgerScope(board, "feat-1").ids).not.toContain("task-2");
    expect(ledgerScope(board, "feat-2").ids).toEqual(["feat-2", "task-2"]);
  });

  it("stops at a nested feature — it owns its own ledger, and would otherwise be counted twice", () => {
    const nested: Bead[] = [
      makeBead({ id: "outer", issue_type: "feature" }),
      makeBead({ id: "task-a", parent: "outer" }),
      makeBead({ id: "inner", issue_type: "feature", parent: "outer" }),
      makeBead({ id: "task-b", parent: "inner" }),
    ];
    expect(ledgerScope(nested, "outer").ids).toEqual(["outer", "task-a"]);
    expect(ledgerScope(nested, "inner").ids).toEqual(["inner", "task-b"]);
  });

  it("scopes a standalone target to itself — it is its own single ticket", () => {
    const standalone = [makeBead({ id: "task-solo" })];
    expect(ledgerScope(standalone, "task-solo").ids).toEqual(["task-solo"]);
    expect(ledgerScope(standalone, "task-solo").childIds).toEqual([]);
  });

  it("gives a container epic only itself — its features each hold their own ledger", () => {
    expect(ledgerScope(board, "epic-p").ids).toEqual(["epic-p"]);
  });

  it("carries a legacy epic's whole ticket subtree", () => {
    const legacy: Bead[] = [
      makeBead({ id: "epic-l", issue_type: "epic" }),
      makeBead({ id: "task-1", parent: "epic-l" }),
      makeBead({ id: "sub-1", parent: "task-1" }),
    ];
    expect(ledgerScope(legacy, "epic-l").ids).toEqual(["epic-l", "task-1", "sub-1"]);
  });

  it("keeps the root even when the board does not carry it, and reports no target", () => {
    // Run-phase steps (describe, self-review, PR-fix) stamp the run TARGET's id, so dropping the root
    // would lose whole phases of spend. `target` absent is how a caller tells "purged" from "free".
    const scope = ledgerScope(board, "anton-gone");
    expect(scope.ids).toEqual(["anton-gone"]);
    expect(scope.target).toBeUndefined();
  });

  it("closed tickets stay in scope — their spend is history, not absent", () => {
    const settled: Bead[] = [
      makeBead({ id: "feat-x", issue_type: "feature" }),
      makeBead({ id: "task-done", parent: "feat-x", status: "closed" }),
    ];
    expect(ledgerScope(settled, "feat-x").ids).toEqual(["feat-x", "task-done"]);
  });

  it("excludes pipeline plumbing — a gate coordinates work and never spends against it", () => {
    const poured: Bead[] = [
      makeBead({ id: "feat-y", issue_type: "feature" }),
      makeBead({ id: "gate-1", issue_type: "gate", parent: "feat-y" }),
      makeBead({ id: "mol-1", issue_type: "molecule", parent: "feat-y" }),
      makeBead({ id: "step-1", parent: "mol-1" }),
    ];
    expect(ledgerScope(poured, "feat-y").ids).toEqual(["feat-y"]);
  });

  it("re-parenting moves the spend, by design (§D1) — the scope is never frozen", () => {
    const moved = board.map((b) => (b.id === "task-1" ? { ...b, parent: "feat-2" } : b));
    expect(ledgerScope(moved, "feat-1").ids).toEqual(["feat-1", "bug-1"]);
    // `sub-1` rides along on its parent, exactly as the run would carry it.
    expect(ledgerScope(moved, "feat-2").ids).toEqual(["feat-2", "task-1", "sub-1", "task-2"]);
  });

  it("makes no bd call of its own — the parentage comes from the passed-in snapshot", async () => {
    // The whole point of taking a board: a page holding one already must not pay a bd spawn per
    // feature. Asserted rather than trusted, because a convenience `await beads.list()` added later
    // would be invisible in the returned ids.
    const { beads } = await import("./beads/bd");
    const reads = (beads as unknown as Record<string, unknown>);
    const spied = ["list", "show", "listWithDeps", "children"].filter(
      (fn) => typeof reads[fn] === "function",
    );
    expect(spied.length).toBeGreaterThan(0);

    const calls: string[] = [];
    const original = new Map(spied.map((fn) => [fn, reads[fn]]));
    for (const fn of spied) {
      reads[fn] = (...args: unknown[]) => {
        calls.push(fn);
        return (original.get(fn) as (...a: unknown[]) => unknown)(...args);
      };
    }
    try {
      ledgerScope(board, "feat-1");
      hasLedgerScope(board, "feat-1");
    } finally {
      for (const [fn, impl] of original) reads[fn] = impl;
    }

    expect(calls).toEqual([]);
  });
});

describe("hasLedgerScope", () => {
  it("admits the beads anton opens one PR for", () => {
    expect(hasLedgerScope(board, "feat-1")).toBe(true);
    expect(hasLedgerScope([makeBead({ id: "task-solo" })], "task-solo")).toBe(true);
  });

  it("refuses a container epic, a child ticket, and a bead off the board", () => {
    // A container's features each run on their own, so a total labelled as its cost would be a sum
    // over PRs it never opened.
    expect(hasLedgerScope(board, "epic-p")).toBe(false);
    expect(hasLedgerScope(board, "task-1")).toBe(false);
    expect(hasLedgerScope(board, "anton-gone")).toBe(false);
  });
});

describe("currentRunTargetOf", () => {
  it("walks a working ticket up to the feature that owns it right now", () => {
    expect(currentRunTargetOf(board, "task-1")).toBe("feat-1");
    // Two hops down, same as `ledgerScope`'s own walk — the reverse of the same card index.
    expect(currentRunTargetOf(board, "sub-1")).toBe("feat-1");
  });

  it("returns a run target unchanged — it owns itself, nothing sits above it", () => {
    expect(currentRunTargetOf(board, "feat-1")).toBe("feat-1");
  });

  it("follows a re-parented ticket to its NEW feature, never the one it was raised under", () => {
    // The whole reason this exists beside `ledgerScope` (§D1 already moves the scope on re-parent):
    // a source that froze `task-1`'s owner in a column at some earlier point must be re-resolved
    // through the board, not trusted, or it keeps naming feat-1 forever (PR #322 review).
    const moved = board.map((b) => (b.id === "task-1" ? { ...b, parent: "feat-2" } : b));
    expect(currentRunTargetOf(moved, "task-1")).toBe("feat-2");
  });

  it("leaves an id unresolved when the board holds no card above it", () => {
    // A purged bead and a task parented directly on a container epic (not under either feature)
    // both have no run target: the id comes back unchanged, matching no scope's `beadId` — the same
    // "orphaned" reading `ledgerScope` gives a root the board no longer carries.
    expect(currentRunTargetOf(board, "anton-gone")).toBe("anton-gone");
    const underContainer: Bead[] = [
      makeBead({ id: "epic-c", issue_type: "epic" }),
      makeBead({ id: "feat-c", issue_type: "feature", parent: "epic-c" }),
      makeBead({ id: "task-c", parent: "epic-c" }),
    ];
    expect(currentRunTargetOf(underContainer, "task-c")).toBe("task-c");
  });
});
