/**
 * The PRIME rank order (anton-higu). Property-style, because the properties are the requirement:
 * the queue must be the same on two machines reading the same board, so what is asserted here is
 * invariance (input order cannot change the answer) and totality (nothing ties), not one hand-read
 * example of a good ordering.
 *
 * The set — which beads are eligible at all — is asserted in claimable.test.ts and in the picker's
 * own eligibility tests. This module only orders what it is handed.
 */
import { describe, expect, it } from "vitest";
import { comparePrimeOrder, rankTargets, unblockCounter, type RankedTarget } from "./rank";
import type { Bead, BeadDep } from "./types";

const bead = (b: Partial<Bead>): Bead => ({ id: "x", title: "x", status: "open", ...b }) as Bead;

/** A `blocks` edge as `bd list --json` carries it: from = the dependent, to = the blocker. */
const blocks = (dependent: string, blocker: string): BeadDep => ({
  issue_id: dependent,
  depends_on_id: blocker,
  type: "blocks",
});

const ids = (targets: RankedTarget[]) => targets.map((t) => t.bead.id);

/** `Math.sign` without its signed zero, which no comparator distinguishes. */
const sign = (n: number) => (n < 0 ? -1 : n > 0 ? 1 : 0);

/** Seeded so a failure is reproducible: a shuffle nobody can replay proves nothing. */
function shuffled<T>(items: T[], seed: number): T[] {
  let state = seed;
  const next = () => (state = (state * 1103515245 + 12345) % 2147483648);
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = next() % (i + 1);
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/** A board wide enough that every rank criterion is exercised, and several beads tie on each. */
const MIXED_BOARD: Bead[] = [
  bead({ id: "f1", priority: 1, created_at: "2026-01-01T00:00:00Z" }),
  bead({ id: "f2", priority: 1, created_at: "2026-01-01T00:00:00Z" }),
  bead({ id: "f3", priority: 0, created_at: "2026-05-01T00:00:00Z" }),
  bead({ id: "f4", priority: 2, created_at: "2026-02-01T00:00:00Z" }),
  bead({ id: "f5", created_at: "2026-01-01T00:00:00Z" }), // no priority
  bead({ id: "f6", priority: 4, created_at: "2026-09-01T00:00:00Z" }),
  bead({ id: "f7", priority: 2 }), // no created_at
  bead({ id: "f8", priority: 2, created_at: "2026-02-01T00:00:00Z", dependencies: [] }),
  bead({ id: "d1", priority: 3, dependencies: [blocks("d1", "f4")] }),
  bead({ id: "d2", priority: 3, dependencies: [blocks("d2", "d1")] }),
];

describe("rankTargets — invariance", () => {
  it("returns the same order however the input is shuffled", () => {
    const expected = ids(rankTargets(MIXED_BOARD, MIXED_BOARD));

    for (let seed = 1; seed <= 25; seed++) {
      // The board read is shuffled too: two reads of an unchanged board may return the beads in
      // any order, and the unblocking count must not notice.
      const scrambled = shuffled(MIXED_BOARD, seed);
      expect(ids(rankTargets(scrambled, shuffled(MIXED_BOARD, seed * 31)))).toEqual(expected);
    }
  });

  it("ranks a snapshot twice to an identical queue, facts included", () => {
    const once = rankTargets(MIXED_BOARD, MIXED_BOARD);
    const twice = rankTargets(MIXED_BOARD, MIXED_BOARD);

    expect(JSON.stringify(twice)).toEqual(JSON.stringify(once));
  });

  it("does not reorder the eligible set it was handed", () => {
    const eligible = shuffled(MIXED_BOARD, 7);
    const before = eligible.map((b) => b.id);

    rankTargets(eligible, MIXED_BOARD);

    expect(eligible.map((b) => b.id)).toEqual(before);
  });
});

describe("comparePrimeOrder — totality", () => {
  const ranked = rankTargets(MIXED_BOARD, MIXED_BOARD);

  it("never calls two distinct beads equal", () => {
    for (const a of ranked) {
      for (const b of ranked) {
        if (a.bead.id === b.bead.id) continue;
        expect(comparePrimeOrder(a, b)).not.toBe(0);
      }
    }
  });

  it("is antisymmetric and reflexive, so any sort of it agrees", () => {
    for (const a of ranked) {
      expect(comparePrimeOrder(a, a)).toBe(0);
      for (const b of ranked) {
        expect(sign(comparePrimeOrder(a, b))).toBe(sign(-comparePrimeOrder(b, a)));
      }
    }
  });

  it("is transitive across the whole board", () => {
    for (const a of ranked) {
      for (const b of ranked) {
        for (const c of ranked) {
          if (comparePrimeOrder(a, b) < 0 && comparePrimeOrder(b, c) < 0) {
            expect(comparePrimeOrder(a, c)).toBeLessThan(0);
          }
        }
      }
    }
  });

  it("breaks an otherwise perfect tie by id", () => {
    const twin = (id: string): RankedTarget => ({
      bead: bead({ id }),
      priority: 2,
      unblocks: 3,
      createdAt: "2026-01-01T00:00:00Z",
    });

    expect(comparePrimeOrder(twin("anton-aaa"), twin("anton-zzz"))).toBeLessThan(0);
  });
});

describe("rankTargets — the criteria, in order", () => {
  it("puts P0 first, whatever else is true of the board", () => {
    const board = [
      bead({ id: "f1", priority: 2, created_at: "2020-01-01T00:00:00Z" }),
      bead({ id: "f2", priority: 0, created_at: "2026-06-01T00:00:00Z" }),
      bead({ id: "f3", priority: 1, created_at: "2020-01-01T00:00:00Z" }),
    ];

    expect(ids(rankTargets(board, board))).toEqual(["f2", "f3", "f1"]);
  });

  it("sorts a bead with no priority after one with any — including an explicit P4", () => {
    // `.beads/PRIME.md`: "a bead with none sorts last". Unset is the absence of a decision, so it
    // must not tie with work somebody deliberately ranked lowest — and the age tiebreak, which the
    // unranked bead would win here, must never get the chance to promote it.
    const board = [
      bead({ id: "f9", created_at: "2020-01-01T00:00:00Z" }), // no priority, and the oldest
      bead({ id: "f4", priority: 4, created_at: "2026-01-01T00:00:00Z" }),
      bead({ id: "f3", priority: 3, created_at: "2026-01-01T00:00:00Z" }),
    ];

    const ranked = rankTargets(board, board);
    expect(ids(ranked)).toEqual(["f3", "f4", "f9"]);
    expect(ranked.map((t) => t.priority)).toEqual([3, 4, undefined]);
  });

  it("breaks a priority tie by how much open work the target unblocks, transitively", () => {
    // f1 → f2 → t3 releases two open beads; f4 → f5 releases one.
    const board = [
      bead({ id: "f4", priority: 1 }),
      bead({ id: "f1", priority: 1 }),
      bead({ id: "f2", priority: 1, dependencies: [blocks("f2", "f1")] }),
      bead({ id: "t3", priority: 1, dependencies: [blocks("t3", "f2")] }),
      bead({ id: "f5", priority: 1, dependencies: [blocks("f5", "f4")] }),
    ];

    const ranked = rankTargets([board[0], board[1]], board);
    expect(ranked.map((t) => [t.bead.id, t.unblocks])).toEqual([
      ["f1", 2],
      ["f4", 1],
    ]);
  });

  it("falls back to age, oldest first, then to id", () => {
    const board = [
      bead({ id: "f2", priority: 1, created_at: "2026-02-01T00:00:00Z" }),
      bead({ id: "f1", priority: 1, created_at: "2026-01-01T00:00:00Z" }),
      bead({ id: "f4", priority: 1, created_at: "2026-02-01T00:00:00Z" }),
      // No timestamp — it must not jump ahead of work that has genuinely been waiting.
      bead({ id: "f0", priority: 1 }),
    ];

    expect(ids(rankTargets(board, board))).toEqual(["f1", "f2", "f4", "f0"]);
  });
});

describe("unblockCounter", () => {
  it("counts a diamond's shared tail once", () => {
    // head unblocks left and right, which both unblock tail: three beads released, not four.
    const board = [
      bead({ id: "head" }),
      bead({ id: "left", dependencies: [blocks("left", "head")] }),
      bead({ id: "right", dependencies: [blocks("right", "head")] }),
      bead({ id: "tail", dependencies: [blocks("tail", "left"), blocks("tail", "right")] }),
    ];

    expect(unblockCounter(board)("head")).toBe(3);
  });

  it("counts only open dependents", () => {
    const board = [
      bead({ id: "f1" }),
      bead({ id: "done", status: "closed", dependencies: [blocks("done", "f1")] }),
      bead({ id: "waiting", dependencies: [blocks("waiting", "f1")] }),
    ];

    expect(unblockCounter(board)("f1")).toBe(1);
  });

  it("skips a deferred dependent but counts a blocked or in-progress one", () => {
    // `deferred` is a human's "not now", so releasing it is worth nothing this pass — while a
    // dependent bd reports as `blocked` (or one somebody started anyway) is precisely the waiting
    // work the target releases. Counting by `status === "open"` alone would invert both.
    const board = [
      bead({ id: "f1" }),
      bead({ id: "snoozed", status: "deferred", dependencies: [blocks("snoozed", "f1")] }),
      bead({ id: "waiting", status: "blocked", dependencies: [blocks("waiting", "f1")] }),
      bead({ id: "started", status: "in_progress", dependencies: [blocks("started", "f1")] }),
    ];

    expect(unblockCounter(board)("f1")).toBe(2);
  });

  it("ignores every edge type but `blocks`", () => {
    const board = [
      bead({ id: "e1" }),
      bead({ id: "t1", dependencies: [{ issue_id: "t1", depends_on_id: "e1", type: "parent-child" }] }),
    ];

    expect(unblockCounter(board)("e1")).toBe(0);
  });

  it("terminates on a `blocks` cycle instead of hanging", () => {
    // A malformed board is not a hypothetical one; a picker that hung on it would take the pass
    // down with it. Each bead sees the other two, itself excluded.
    const board = [
      bead({ id: "a", dependencies: [blocks("a", "c")] }),
      bead({ id: "b", dependencies: [blocks("b", "a")] }),
      bead({ id: "c", dependencies: [blocks("c", "b")] }),
    ];

    const counts = unblockCounter(board);
    expect([counts("a"), counts("b"), counts("c")]).toEqual([2, 2, 2]);
    expect(ids(rankTargets(board, board))).toEqual(["a", "b", "c"]);
  });

  it("stops at a deferred dependent instead of crediting the target for what it blocks", () => {
    // f1 → snoozed → downstream. Completing f1 cannot release `downstream`; the deferral still
    // holds it. Counting past `snoozed` would let f1 outrank a target that frees live work.
    const board = [
      bead({ id: "f1" }),
      bead({ id: "snoozed", status: "deferred", dependencies: [blocks("snoozed", "f1")] }),
      bead({ id: "downstream", status: "blocked", dependencies: [blocks("downstream", "snoozed")] }),
    ];

    expect(unblockCounter(board)("f1")).toBe(0);
  });

  it("stops at a closed dependent — whatever it blocked, it stopped blocking when it closed", () => {
    const board = [
      bead({ id: "f1" }),
      bead({ id: "done", status: "closed", dependencies: [blocks("done", "f1")] }),
      bead({ id: "downstream", dependencies: [blocks("downstream", "done")] }),
    ];

    expect(unblockCounter(board)("f1")).toBe(0);
  });

  it("does not credit a target for a dependent another open bead still blocks", () => {
    // `shared` is held by f1 AND by g1, which f1 does not touch. Closing f1 leaves it blocked, so
    // f1 is worth exactly the one bead it frees — otherwise it outranks a target that frees work.
    const board = [
      bead({ id: "f1" }),
      bead({ id: "g1" }),
      bead({ id: "own", dependencies: [blocks("own", "f1")] }),
      bead({ id: "shared", dependencies: [blocks("shared", "f1"), blocks("shared", "g1")] }),
    ];

    expect(unblockCounter(board)("f1")).toBe(1);
  });

  it("credits a dependent whose every remaining blocker is inside the target's closure", () => {
    // f1 → mid, and `tail` is held by f1 and mid: finishing f1 releases mid, and mid's release is
    // what frees tail. Both are f1's to claim, unlike the independent blocker above.
    const board = [
      bead({ id: "f1" }),
      bead({ id: "mid", dependencies: [blocks("mid", "f1")] }),
      bead({ id: "tail", dependencies: [blocks("tail", "f1"), blocks("tail", "mid")] }),
    ];

    expect(unblockCounter(board)("f1")).toBe(2);
  });

  it("ignores a closed blocker when deciding a dependent is released", () => {
    // `done` let go of `tail` when it closed, so the live arm alone releases it: the diamond's
    // shared tail must not be lost to an edge that no longer holds anything.
    const board = [
      bead({ id: "f1" }),
      bead({ id: "done", status: "closed" }),
      bead({ id: "live", dependencies: [blocks("live", "f1")] }),
      bead({ id: "tail", dependencies: [blocks("tail", "done"), blocks("tail", "live")] }),
    ];

    expect(unblockCounter(board)("f1")).toBe(2);
  });

  it("leaves a bead a deferred blocker still holds to the deferral", () => {
    // `live` frees its arm of the diamond, but `snoozed` keeps holding `tail` — a deferral is not
    // lifted by finishing f1, so f1 is worth one bead here, not two.
    const board = [
      bead({ id: "f1" }),
      bead({ id: "snoozed", status: "deferred", dependencies: [blocks("snoozed", "f1")] }),
      bead({ id: "live", dependencies: [blocks("live", "f1")] }),
      bead({ id: "tail", dependencies: [blocks("tail", "snoozed"), blocks("tail", "live")] }),
    ];

    expect(unblockCounter(board)("f1")).toBe(1);
  });

  it("traverses a dependent that is not on the board without counting it", () => {
    // `ghost` is off this snapshot but its edge is on f1, and it in turn blocks a bead that IS
    // here: the walk must reach `beyond` while counting only the open work it can see.
    const board = [
      bead({ id: "f1", dependencies: [blocks("ghost", "f1")] }),
      bead({ id: "beyond", dependencies: [blocks("beyond", "ghost")] }),
    ];

    expect(unblockCounter(board)("f1")).toBe(1);
  });
});

/**
 * The refactoring guard (anton-jesm): one board wide enough to exercise every rule the walk has —
 * a diamond, a dependent an unrelated blocker still holds, a deferred and a closed dead end, and an
 * off-board bead — pinned to the exact queue and the exact counts it produced before the walk was
 * extracted from the counting. The behaviour tests above say what each rule IS; this one says the
 * whole ranking did not move, so a future rewrite of the walk that keeps every rule passing and
 * still reorders the queue is caught here.
 */
describe("rankTargets — the fixed board ranks byte-identically", () => {
  const GOLDEN_BOARD: Bead[] = [
    bead({ id: "anton-aaa", priority: 1, created_at: "2026-03-01T00:00:00Z" }),
    bead({ id: "anton-bbb", priority: 1, created_at: "2026-03-01T00:00:00Z" }),
    bead({ id: "anton-ccc", priority: 0, created_at: "2026-07-01T00:00:00Z" }),
    bead({ id: "anton-ddd", priority: 2, created_at: "2026-01-01T00:00:00Z" }),
    bead({ id: "anton-eee", created_at: "2026-01-01T00:00:00Z" }),
    bead({ id: "anton-fff", priority: 2 }),
    // anton-aaa → left, right → tail: a diamond whose shared tail is released once.
    bead({ id: "left", priority: 3, created_at: "2026-02-01T00:00:00Z", dependencies: [blocks("left", "anton-aaa")] }),
    bead({ id: "right", priority: 3, created_at: "2026-02-01T00:00:00Z", dependencies: [blocks("right", "anton-aaa")] }),
    bead({ id: "tail", status: "blocked", dependencies: [blocks("tail", "left"), blocks("tail", "right")] }),
    // Held by two unrelated targets, so neither may claim it.
    bead({ id: "shared", dependencies: [blocks("shared", "anton-bbb"), blocks("shared", "anton-ddd")] }),
    // A deferred dead end and a closed one: both stop the walk short of what they block.
    bead({ id: "snoozed", status: "deferred", dependencies: [blocks("snoozed", "anton-ccc")] }),
    bead({ id: "beyond-snooze", status: "blocked", dependencies: [blocks("beyond-snooze", "snoozed")] }),
    bead({ id: "done", status: "closed", dependencies: [blocks("done", "anton-ddd")] }),
    // `ghost` is off the board: traversed, not counted, and `ghost-tail` behind it still is.
    bead({ id: "ghost-tail", dependencies: [blocks("ghost-tail", "ghost")] }),
    bead({
      id: "anton-ggg",
      priority: 4,
      created_at: "2026-05-01T00:00:00Z",
      dependencies: [blocks("ghost", "anton-ggg")],
    }),
  ];

  it("produces the queue and the counts it produced before the walk was extracted", () => {
    const ranked = rankTargets(GOLDEN_BOARD, GOLDEN_BOARD);

    expect(ranked.map((t) => [t.bead.id, t.priority ?? null, t.unblocks, t.createdAt])).toEqual([
      ["anton-ccc", 0, 0, "2026-07-01T00:00:00Z"],
      ["anton-aaa", 1, 3, "2026-03-01T00:00:00Z"],
      ["anton-bbb", 1, 0, "2026-03-01T00:00:00Z"],
      ["anton-ddd", 2, 0, "2026-01-01T00:00:00Z"],
      ["anton-fff", 2, 0, ""],
      ["left", 3, 0, "2026-02-01T00:00:00Z"],
      ["right", 3, 0, "2026-02-01T00:00:00Z"],
      ["anton-ggg", 4, 1, "2026-05-01T00:00:00Z"],
      ["snoozed", null, 1, ""],
      ["anton-eee", null, 0, "2026-01-01T00:00:00Z"],
      ["beyond-snooze", null, 0, ""],
      ["done", null, 0, ""],
      ["ghost-tail", null, 0, ""],
      ["shared", null, 0, ""],
      ["tail", null, 0, ""],
    ]);
  });

  it("ranks the same board the same way however the read is shuffled", () => {
    const expected = JSON.stringify(rankTargets(GOLDEN_BOARD, GOLDEN_BOARD));

    for (let seed = 1; seed <= 25; seed++) {
      const scrambled = shuffled(GOLDEN_BOARD, seed);
      expect(JSON.stringify(rankTargets(scrambled, shuffled(GOLDEN_BOARD, seed * 17)))).toEqual(expected);
    }
  });
});
