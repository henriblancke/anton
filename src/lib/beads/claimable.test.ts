/**
 * The claimable-set query (anton-9anc): what any worker may claim, and in what order.
 *
 * Two properties matter here and both are asserted against fixture boards:
 *   1. the SET — container epics, child tickets and already-claimed or unapproved targets never
 *      appear, because a set that named them would send a worker at work anton refuses to run;
 *   2. the ORDER — priority, then unblocking value, then age, then id: one deterministic answer to
 *      "what does anton pick up next", identical on every machine reading the same board.
 */
import { describe, expect, it } from "vitest";
import { beads, buildClaimableReadyArgs, rankClaimableTargets, type Bead, type BeadDep } from "./bd";

const bead = (b: Partial<Bead>): Bead =>
  ({ id: "x", title: "x", status: "open", labels: ["approved"], ...b }) as Bead;

/** A `blocks` edge as `bd list --json` carries it: from = the dependent, to = the blocker. */
const blocks = (dependent: string, blocker: string): BeadDep => ({
  issue_id: dependent,
  depends_on_id: blocker,
  type: "blocks",
});

const ids = (targets: ReturnType<typeof rankClaimableTargets>) => targets.map((t) => t.bead.id);

describe("buildClaimableReadyArgs", () => {
  it("asks bd for approved, unassigned, unlimited ready work", () => {
    expect(buildClaimableReadyArgs()).toEqual([
      "ready",
      "--label",
      "approved",
      "--unassigned",
      "--json",
      "--limit",
      "0",
    ]);
  });
});

describe("rankClaimableTargets — the set", () => {
  it("keeps a feature under a container epic, and drops the epic itself", () => {
    // The container's features each run on their own (own worktree, own PR), so claiming the epic
    // would be one pickup launching N PRs.
    const epic = bead({ id: "e1", issue_type: "epic" });
    const feature = bead({ id: "f1", issue_type: "feature", parent: "e1" });
    const board = [epic, feature];

    expect(ids(rankClaimableTargets(board, board))).toEqual(["f1"]);
  });

  it("drops a child ticket — the task is the unit of execution, not of distribution", () => {
    const feature = bead({ id: "f1", issue_type: "feature" });
    const child = bead({ id: "t1", issue_type: "task", parent: "f1" });
    const board = [feature, child];

    expect(ids(rankClaimableTargets(board, board))).toEqual(["f1"]);
  });

  it("keeps a parentless task/bug — the epic-of-one", () => {
    const board = [
      bead({ id: "t1", issue_type: "task" }),
      bead({ id: "b1", issue_type: "bug" }),
      bead({ id: "c1", issue_type: "chore" }), // never runnable on its own
    ];

    expect(ids(rankClaimableTargets(board, board)).sort()).toEqual(["b1", "t1"]);
  });

  it("drops an assigned feature — a claim already held is not up for grabs", () => {
    const held = bead({ id: "f1", issue_type: "feature", assignee: "alice" });
    const free = bead({ id: "f2", issue_type: "feature" });
    // A whitespace-only assignee is bd's "unclaimed", not a holder.
    const blank = bead({ id: "f3", issue_type: "feature", assignee: "  " });
    const board = [held, free, blank];

    expect(ids(rankClaimableTargets(board, board)).sort()).toEqual(["f2", "f3"]);
  });

  it("drops an unapproved target — execute-epic would poison it", () => {
    const board = [
      bead({ id: "f1", issue_type: "feature", labels: [] }),
      bead({ id: "f2", issue_type: "feature" }),
    ];

    expect(ids(rankClaimableTargets(board, board))).toEqual(["f2"]);
  });

  it("drops an agent:human target — no agent can do it, at any priority", () => {
    // anton-mv70: `agent:human` resolves to no specialist prompt, so a claimed human target would
    // dispatch to the DEFAULT agent. Asserted at P0 and with no priority at all: the exclusion is a
    // property of the label, never of where the bead would have ranked.
    const board = [
      bead({ id: "f1", issue_type: "feature", priority: 0, labels: ["approved", "agent:human"] }),
      bead({ id: "t2", issue_type: "task", labels: ["approved", "agent:human"] }),
      bead({ id: "e3", issue_type: "epic", priority: 1, labels: ["approved", "agent:human"] }),
      bead({ id: "f4", issue_type: "feature", priority: 2, labels: ["approved", "agent:nextjs"] }),
    ];

    expect(ids(rankClaimableTargets(board, board))).toEqual(["f4"]);
  });

  it("leaves the ranking of every other target untouched when human work is on the board", () => {
    // The label removes its own bead and changes nothing else — same order, same unblocks counts.
    const others = [
      bead({ id: "f1", issue_type: "feature", priority: 1, created_at: "2026-01-01T00:00:00Z" }),
      bead({ id: "f2", issue_type: "feature", priority: 0, created_at: "2026-02-01T00:00:00Z" }),
      bead({ id: "t3", issue_type: "task", priority: 1, created_at: "2026-03-01T00:00:00Z" }),
    ];
    const human = bead({
      id: "h1",
      issue_type: "feature",
      priority: 0,
      created_at: "2026-01-01T00:00:00Z",
      labels: ["approved", "agent:human"],
    });

    const without = rankClaimableTargets(others, others);
    const withHuman = rankClaimableTargets([...others, human], [...others, human]);

    expect(withHuman).toEqual(without);
  });

  it("drops anything not open — closed, in_progress and deferred are nobody's free work", () => {
    const board = [
      bead({ id: "f1", issue_type: "feature", status: "closed" }),
      bead({ id: "f2", issue_type: "feature", status: "in_progress" }),
      bead({ id: "f3", issue_type: "feature", status: "deferred" }),
      bead({ id: "f4", issue_type: "feature" }),
    ];

    expect(ids(rankClaimableTargets(board, board))).toEqual(["f4"]);
  });

  it("keeps a legacy epic with no feature children — still a run target", () => {
    const epic = bead({ id: "e1", issue_type: "epic" });
    const child = bead({ id: "t1", issue_type: "task", parent: "e1" });
    const board = [epic, child];

    expect(ids(rankClaimableTargets(board, board))).toEqual(["e1"]);
  });

  it("narrows the pool bd hands it, without re-deriving readiness", () => {
    // bd already excluded the blocked feature from its ready answer; the board still carries it, and
    // nothing here may re-admit it.
    const blocked = bead({ id: "f2", issue_type: "feature" });
    const ready = bead({ id: "f1", issue_type: "feature" });
    const board = [ready, blocked];

    expect(ids(rankClaimableTargets([ready], board))).toEqual(["f1"]);
  });
});

describe("rankClaimableTargets — the order", () => {
  it("puts P0 first, whatever else is true of the board", () => {
    const board = [
      bead({ id: "f1", issue_type: "feature", priority: 2, created_at: "2026-01-01T00:00:00Z" }),
      bead({ id: "f2", issue_type: "feature", priority: 0, created_at: "2026-06-01T00:00:00Z" }),
      bead({ id: "f3", issue_type: "feature", priority: 1, created_at: "2026-01-01T00:00:00Z" }),
    ];

    expect(ids(rankClaimableTargets(board, board))).toEqual(["f2", "f3", "f1"]);
  });

  it("sorts a bead with no priority last, behind even an explicit P4", () => {
    // `.beads/PRIME.md`: "a bead with none sorts last" — unset is the absence of a decision, not a
    // synonym for bd's lowest. The full property lives in rank.test.ts.
    const board = [
      bead({ id: "f9", issue_type: "feature" }), // no priority
      bead({ id: "f2", issue_type: "feature", priority: 4 }),
      bead({ id: "f3", issue_type: "feature", priority: 3 }),
    ];

    const ranked = rankClaimableTargets(board, board);
    expect(ids(ranked)).toEqual(["f3", "f2", "f9"]);
    expect(ranked.map((t) => t.priority)).toEqual([3, 4, undefined]);
  });

  it("breaks a priority tie by how much open work the target unblocks, transitively", () => {
    // f1 unblocks f2, which unblocks t3 → 2 open beads. f4 unblocks only f5 → 1.
    const board = [
      bead({ id: "f1", issue_type: "feature", priority: 1 }),
      bead({ id: "f2", issue_type: "feature", priority: 1, dependencies: [blocks("f2", "f1")] }),
      bead({ id: "t3", issue_type: "task", priority: 1, dependencies: [blocks("t3", "f2")] }),
      bead({ id: "f4", issue_type: "feature", priority: 1 }),
      bead({ id: "f5", issue_type: "feature", priority: 1, dependencies: [blocks("f5", "f4")] }),
    ];

    const ranked = rankClaimableTargets(board, board);
    // f2/f5 are blocked in reality; bd would drop them from the pool. Rank the two heads only.
    const heads = ranked.filter((t) => ["f1", "f4"].includes(t.bead.id));
    expect(heads.map((t) => [t.bead.id, t.unblocks])).toEqual([
      ["f1", 2],
      ["f4", 1],
    ]);
    expect(ids(ranked).indexOf("f1")).toBeLessThan(ids(ranked).indexOf("f4"));
  });

  it("counts only open dependents, and survives a blocks cycle", () => {
    const board = [
      bead({ id: "f1", issue_type: "feature" }),
      bead({ id: "f2", issue_type: "feature", status: "closed", dependencies: [blocks("f2", "f1")] }),
      bead({ id: "f3", issue_type: "feature", dependencies: [blocks("f3", "f1")] }),
      // A malformed cycle f4 → f5 → f4 must not hang the traversal — or credit f1 for work that
      // holds itself no matter what f1 does.
      bead({ id: "f4", issue_type: "feature", dependencies: [blocks("f4", "f3"), blocks("f4", "f5")] }),
      bead({ id: "f5", issue_type: "feature", dependencies: [blocks("f5", "f4")] }),
    ];

    const byId = new Map(rankClaimableTargets(board, board).map((t) => [t.bead.id, t.unblocks]));
    expect(byId.get("f1")).toBe(1); // f3 alone: the closed f2 was never waiting, the cycle never frees
  });

  it("falls back to age, then id, so two machines agree exactly", () => {
    const board = [
      bead({ id: "f2", issue_type: "feature", priority: 1, created_at: "2026-02-01T00:00:00Z" }),
      bead({ id: "f1", issue_type: "feature", priority: 1, created_at: "2026-01-01T00:00:00Z" }),
      bead({ id: "f4", issue_type: "feature", priority: 1, created_at: "2026-02-01T00:00:00Z" }),
      // No timestamp — it must not jump ahead of work that has genuinely been waiting.
      bead({ id: "f0", issue_type: "feature", priority: 1 }),
    ];

    expect(ids(rankClaimableTargets(board, board))).toEqual(["f1", "f2", "f4", "f0"]);
  });
});

describe("beads.claimableTargets", () => {
  it("ranks bd's ready pool against the full board", async () => {
    const pool = [
      bead({ id: "f1", issue_type: "feature", priority: 2 }),
      bead({ id: "f2", issue_type: "feature", priority: 0 }),
      bead({ id: "e1", issue_type: "epic" }), // container — bd has no idea, we do
    ];
    const board = [...pool, bead({ id: "f3", issue_type: "feature", parent: "e1" })];

    const targets = await beads.claimableTargets("/repo", {
      ready: async () => pool,
      board: async () => board,
    });

    expect(ids(targets)).toEqual(["f2", "f1"]);
  });
});
