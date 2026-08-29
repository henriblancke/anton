/**
 * Direct unit tests for the approve gate (anton-ixl1): the four promises approval makes, asserted on
 * THIS module rather than sideways through gardener/apply.ts and pm/revalidate.ts — where a changed
 * rule used to surface as someone else's failure, or as none at all.
 *
 * The gate is pure over a board snapshot, so a literal `Bead[]` is a complete test of what it would
 * say. Every case therefore states its whole board, and asserts the `ApprovalGap` — rule AND message
 * — because the message is the evidence a proposal carries and the refusal an operator reads.
 */
import { describe, expect, it } from "vitest";

import { approvalGaps, formatApprovalGaps, makeApprovalGate, notRunnableWhy } from "./approval-gate";
import type { Bead } from "./beads/bd";

/** Any bd stamp: without one a bead never came from a bd read, and the contract never judges it. */
const STAMP = "2026-08-01T00:00:00Z";

/**
 * A conformant bead by default — acceptance present — so a case's fixture states only what it takes
 * AWAY. `acceptance_criteria: undefined` is how a case strips the rubric.
 */
function bead(id: string, extra: Partial<Bead> = {}): Bead {
  return {
    id,
    title: id,
    status: "open",
    issue_type: "task",
    updated_at: STAMP,
    acceptance_criteria: "- [ ] it does the one thing",
    ...extra,
  };
}

/** An epic carries the one `area:` label the roadmap groups by, so it is clean unless a case isn't. */
const epic = (id: string, extra: Partial<Bead> = {}): Bead =>
  bead(id, { issue_type: "epic", labels: ["area:codehealth"], ...extra });

const feature = (id: string, parent?: string, extra: Partial<Bead> = {}): Bead =>
  bead(id, { issue_type: "feature", parent, ...extra });

const ticket = (id: string, parent: string, extra: Partial<Bead> = {}): Bead =>
  bead(id, { parent, ...extra });

/** A `blocks` edge as `bd list --json` carries it: `id` waits on `blocker`. */
const waitsOn = (id: string, ...blockers: string[]): Partial<Bead> => ({
  dependencies: blockers.map((depends_on_id) => ({ issue_id: id, depends_on_id, type: "blocks" })),
});

const of = (target: Bead, board: Bead[]) => approvalGaps(target, board);
const rulesOf = (gaps: { rule: string }[]) => gaps.map((g) => g.rule);

/**
 * The board every `makeApprovalGate` case shares: a container epic over one clean feature and one
 * whose ticket lost its rubric. Three shapes in one read — a run target with gaps, a clean one, and
 * beads that are not run targets at all.
 */
function fixtureBoard(): Bead[] {
  return [
    epic("anton-e"),
    feature("anton-clean", "anton-e"),
    ticket("anton-t1", "anton-clean"),
    ticket("anton-t2", "anton-clean"),
    feature("anton-gappy", "anton-e"),
    ticket("anton-t3", "anton-gappy", { acceptance_criteria: undefined }),
    ticket("anton-t4", "anton-gappy"),
  ];
}

const find = (board: Bead[], id: string): Bead => {
  const found = board.find((b) => b.id === id);
  if (!found) throw new Error(`no bead ${id} on this fixture`);
  return found;
};

describe("the `runnable` rule — nothing can dispatch this target any more", () => {
  it("faults an epic that gained a feature child and became a container", () => {
    const board = [epic("anton-e"), feature("anton-f", "anton-e"), ticket("anton-t1", "anton-f")];
    const gaps = of(find(board, "anton-e"), board);

    expect(gaps).toEqual([
      {
        rule: "runnable",
        message:
          "anton-e → no longer a run target: it has feature children and is now a container epic — " +
          "approve one of its features instead; each is its own run and its own PR",
      },
    ]);
  });

  it("faults a task re-parented under a run target, which now runs as one of its tickets", () => {
    const board = [feature("anton-f"), ticket("anton-t1", "anton-f"), ticket("anton-t2", "anton-f")];
    const gaps = of(find(board, "anton-t1"), board);

    expect(gaps).toEqual([
      {
        rule: "runnable",
        message:
          "anton-t1 → no longer a run target: it now sits under anton-f and runs as one of that " +
          "target's tickets, not on its own",
      },
    ]);
  });

  it("faults a type nothing runs, naming the types that do", () => {
    const board = [bead("anton-l", { issue_type: "learning" })];
    const gaps = of(find(board, "anton-l"), board);

    expect(gaps).toEqual([
      {
        rule: "runnable",
        message:
          'anton-l → no longer a run target: type "learning" is not runnable — only a feature, a ' +
          "parentless task/bug, or an epic with no feature children can be approved to run",
      },
    ]);
  });

  it("stays silent on each of the three shapes a run CAN target", () => {
    const board = [
      epic("anton-e"),
      ticket("anton-t1", "anton-e"),
      feature("anton-f"),
      bead("anton-s"),
    ];

    expect(notRunnableWhy(find(board, "anton-e"), board)).toBeUndefined();
    expect(notRunnableWhy(find(board, "anton-f"), board)).toBeUndefined();
    expect(notRunnableWhy(find(board, "anton-s"), board)).toBeUndefined();
  });
});

describe("the `contract` rule — the spec the run would be dispatched against", () => {
  it("judges the ticket set the run would dispatch, not the target alone", () => {
    const board = [
      feature("anton-f"),
      ticket("anton-t1", "anton-f"),
      ticket("anton-t2", "anton-f", { acceptance_criteria: undefined }),
    ];
    const gaps = of(find(board, "anton-f"), board);

    expect(rulesOf(gaps)).toEqual(["contract"]);
    expect(gaps[0].message).toMatch(/^anton-t2 → no Acceptance criteria/);
    // The remedy travels with the fault, so the refusal and the fix read together.
    expect(gaps[0].message).toContain("bd update --acceptance");
  });

  it("files ONE gap per offending bead, each naming its own id", () => {
    const board = [
      feature("anton-f", undefined, { acceptance_criteria: undefined }),
      ticket("anton-t1", "anton-f", { acceptance_criteria: undefined }),
      ticket("anton-t2", "anton-f", { acceptance_criteria: undefined }),
    ];
    const gaps = of(find(board, "anton-f"), board);

    expect(rulesOf(gaps)).toEqual(["contract", "contract", "contract"]);
    expect(gaps.map((g) => g.message.split(" →")[0])).toEqual([
      "anton-f",
      "anton-t1",
      "anton-t2",
    ]);
  });

  it("holds an epic to its own tier — Success Criteria, not Acceptance", () => {
    const board = [
      epic("anton-e", { acceptance_criteria: undefined }),
      ticket("anton-t1", "anton-e"),
    ];
    const gaps = of(find(board, "anton-e"), board);

    expect(rulesOf(gaps)).toEqual(["contract"]);
    expect(gaps[0].message).toMatch(/^anton-e → no Success Criteria/);
  });

  it("reports nothing advisory — only what actually refuses the run", () => {
    // No `area:` label is an advisory contract violation on an epic; the gate is the blocking set.
    const board = [epic("anton-e", { labels: [] }), ticket("anton-t1", "anton-e")];

    expect(of(find(board, "anton-e"), board)).toEqual([]);
  });
});

describe("the `structure` rule — the tier shape under the target", () => {
  it("faults a feature parented under a feature, which ships the same work twice", () => {
    const board = [
      epic("anton-e"),
      feature("anton-f", "anton-e"),
      feature("anton-f2", "anton-f"),
    ];
    const gaps = of(find(board, "anton-f"), board);

    expect(rulesOf(gaps)).toEqual(["structure"]);
    expect(gaps[0].message).toMatch(/^anton-f2 → parented to anton-f \(feature\), not an epic/);
  });

  it("faults a ticket stranded under a container epic, scoped to the container", () => {
    const board = [
      epic("anton-e"),
      feature("anton-f", "anton-e"),
      ticket("anton-t1", "anton-f"),
      ticket("anton-stray", "anton-e"),
    ];
    const gaps = of(find(board, "anton-e"), board);

    // The container is not runnable either — the structure gap is the second, not the only, fault.
    expect(rulesOf(gaps)).toEqual(["runnable", "structure"]);
    expect(gaps[1].message).toMatch(/^anton-stray → parented to container epic anton-e/);
  });

  it("scopes to the target's own subtree — a broken shape elsewhere is not its fault", () => {
    const board = [
      epic("anton-e"),
      feature("anton-f", "anton-e"),
      ticket("anton-t1", "anton-f"),
      ticket("anton-t2", "anton-f"),
      epic("anton-e2"),
      feature("anton-g", "anton-e2"),
      feature("anton-g2", "anton-g"),
    ];

    expect(of(find(board, "anton-f"), board)).toEqual([]);
  });
});

describe("the `blocked` rule — no worker could start this yet", () => {
  it("faults a standalone target held by its own open `blocks` edge", () => {
    const board = [bead("anton-a", waitsOn("anton-a", "anton-b1")), bead("anton-b1")];
    const gaps = of(find(board, "anton-a"), board);

    expect(gaps).toEqual([
      {
        rule: "blocked",
        message:
          "anton-a → blocked by anton-b1 — approval is the run trigger, and a worker cannot start " +
          "it until those land",
      },
    ]);
  });

  it("names every open blocker in ONE gap, not one gap per edge", () => {
    const board = [
      bead("anton-a", waitsOn("anton-a", "anton-b1", "anton-b2")),
      bead("anton-b1"),
      bead("anton-b2"),
    ];
    const gaps = of(find(board, "anton-a"), board);

    expect(rulesOf(gaps)).toEqual(["blocked"]);
    expect(gaps[0].message).toContain("blocked by anton-b1, anton-b2");
  });

  it("clears once the blocker closes", () => {
    const board = [
      bead("anton-a", waitsOn("anton-a", "anton-b1")),
      bead("anton-b1", { status: "closed" }),
    ];

    expect(of(find(board, "anton-a"), board)).toEqual([]);
  });

  it("faults a unit whose every ticket is held by another run target", () => {
    const board = gatedBoard(["anton-t1", "anton-t2", "anton-t3"]);
    const gaps = of(find(board, "anton-fa"), board);

    expect(rulesOf(gaps)).toEqual(["blocked"]);
    expect(gaps[0].message).toMatch(/^anton-fa → blocked by anton-fb — approval is the run trigger/);
  });

  it("stays silent on a PARTIALLY blocked unit — the run still has work to dispatch (issue #58)", () => {
    // One gated tail child. Judging this on the coarse rollup would strip `approved` off a run that
    // was starting fine.
    const board = gatedBoard(["anton-t3"]);
    expect(of(find(board, "anton-fa"), board)).toEqual([]);
  });
});

/**
 * An approved feature whose `gated` tickets each wait on a ticket of ANOTHER run target — the
 * cross-run gate of issue #58. Gate every ticket to hold the whole target; gate one for the partial
 * case the gate must let through.
 */
function gatedBoard(gated: string[]): Bead[] {
  const child = (id: string): Bead =>
    ticket(id, "anton-fa", gated.includes(id) ? waitsOn(id, "anton-b1") : {});
  return [
    feature("anton-fa"),
    child("anton-t1"),
    child("anton-t2"),
    child("anton-t3"),
    feature("anton-fb"),
    ticket("anton-b1", "anton-fb"),
    ticket("anton-b2", "anton-fb"),
  ];
}

describe("makeApprovalGate over one board read", () => {
  it("answers for a run target with gaps, a clean one, and beads that are not run targets", () => {
    const board = fixtureBoard();
    const gate = makeApprovalGate(board);

    const gappy = gate.gapsFor(find(board, "anton-gappy"));
    expect(rulesOf(gappy)).toEqual(["contract"]);
    expect(gappy[0].message).toMatch(/^anton-t3 → no Acceptance criteria/);

    expect(gate.gapsFor(find(board, "anton-clean"))).toEqual([]);

    // A ticket of a run target, and the container epic above both features: neither is dispatchable.
    expect(rulesOf(gate.gapsFor(find(board, "anton-t1")))).toEqual(["runnable"]);
    expect(rulesOf(gate.gapsFor(find(board, "anton-e")))).toEqual(["runnable"]);
  });

  it("reports the same verdict across repeated calls — the bound snapshot is not consumed", () => {
    const board = fixtureBoard();
    const gate = makeApprovalGate(board);
    const target = find(board, "anton-gappy");

    expect(gate.gapsFor(target)).toEqual(gate.gapsFor(target));
  });

  it("orders gaps worst-scoped first: runnable, contract, structure, blocked", () => {
    // One bead that breaks all four: a task stranded under a container epic, its rubric gone and an
    // ordering edge in front of it.
    const board = [
      epic("anton-e"),
      feature("anton-f", "anton-e"),
      ticket("anton-t1", "anton-f"),
      ticket("anton-t2", "anton-f"),
      ticket("anton-stray", "anton-e", {
        acceptance_criteria: undefined,
        ...waitsOn("anton-stray", "anton-x"),
      }),
      bead("anton-x"),
    ];

    expect(rulesOf(of(find(board, "anton-stray"), board))).toEqual([
      "runnable",
      "contract",
      "structure",
      "blocked",
    ]);
  });

  it("approvalGaps agrees with the bound gate for the same target", () => {
    const board = fixtureBoard();
    const target = find(board, "anton-gappy");

    expect(approvalGaps(target, board)).toEqual(makeApprovalGate(board).gapsFor(target));
  });
});

describe("formatApprovalGaps — the string a human reads at the gate", () => {
  it("renders nothing when the target still clears the gate", () => {
    expect(formatApprovalGaps([])).toBe("");
  });

  it("renders a single gap as its message verbatim", () => {
    expect(formatApprovalGaps([{ rule: "blocked", message: "anton-a → blocked by anton-b1" }])).toBe(
      "anton-a → blocked by anton-b1",
    );
  });

  it("joins gaps with `; ` in the order the gate reports them", () => {
    expect(
      formatApprovalGaps([
        { rule: "contract", message: "anton-t1 → no Acceptance criteria" },
        { rule: "structure", message: "anton-f2 → parented to anton-f" },
      ]),
    ).toBe("anton-t1 → no Acceptance criteria; anton-f2 → parented to anton-f");
  });

  it("renders a real gate verdict as one line naming every offending bead", () => {
    const board = [
      feature("anton-f", undefined, { acceptance_criteria: undefined }),
      ticket("anton-t1", "anton-f", { acceptance_criteria: undefined }),
      ticket("anton-t2", "anton-f"),
    ];
    const line = formatApprovalGaps(of(find(board, "anton-f"), board));

    expect(line.split("; ")).toHaveLength(2);
    expect(line).toContain("anton-f → no Acceptance criteria");
    expect(line).toContain("anton-t1 → no Acceptance criteria");
    expect(line).not.toContain("anton-t2");
  });
});
