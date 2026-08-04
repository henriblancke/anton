import { describe, expect, it } from "vitest";
import type { Bead } from "./types";
import {
  FEATURE_TICKET_BUDGET,
  buildStructureReport,
  formatStructureReport,
  formatStructureViolations,
  structureGaps,
  validateBoardStructure,
  type StructureRule,
} from "./structure";

const bead = (id: string, issue_type: string, over: Partial<Bead> = {}): Bead => ({
  id,
  title: id,
  status: "open",
  issue_type,
  ...over,
});

const epic = (id: string, over: Partial<Bead> = {}) => bead(id, "epic", over);
const feature = (id: string, parent?: string, over: Partial<Bead> = {}) =>
  bead(id, "feature", { ...(parent ? { parent } : {}), ...over });
const task = (id: string, parent?: string, over: Partial<Bead> = {}) =>
  bead(id, "task", { ...(parent ? { parent } : {}), ...over });

/** Rules broken by `id`, so an assertion names the rule rather than matching prose. */
const rulesFor = (board: Bead[], id: string): StructureRule[] =>
  validateBoardStructure(board)
    .filter((v) => v.id === id)
    .map((v) => v.rule);

/** The canonical healthy shape: one outcome, one PR under it, its steps under that. */
const HEALTHY = [epic("e1"), feature("f1", "e1"), task("t1", "f1"), task("t2", "f1")];

describe("validateBoardStructure", () => {
  it("passes the canonical epic → feature → ticket board", () => {
    expect(validateBoardStructure(HEALTHY)).toEqual([]);
  });

  describe("blocking — the bead can never run", () => {
    it("faults a ticket parented to a container epic", () => {
      const board = [...HEALTHY, task("stray", "e1")];
      expect(rulesFor(board, "stray")).toEqual(["ticket-under-container-epic"]);
      expect(validateBoardStructure(board)[0].severity).toBe("blocking");
    });

    it("leaves a pre-tier epic's own tickets alone (no feature children → still a run target)", () => {
      // The migration story: an epic with task children runs them exactly as before the tier split,
      // so faulting them would condemn every board shaped before the taxonomy landed.
      const board = [epic("legacy"), task("l1", "legacy"), task("l2", "legacy")];
      expect(validateBoardStructure(board)).toEqual([]);
    });

    it("faults those same tickets once a feature lands under the epic", () => {
      const board = [epic("legacy"), task("l1", "legacy"), feature("new", "legacy"), task("n1", "new")];
      expect(rulesFor(board, "l1")).toEqual(["ticket-under-container-epic"]);
    });

    it("counts a CLOSED feature child as making its epic a container", () => {
      const board = [epic("e1"), feature("done", "e1", { status: "closed" }), task("stray", "e1")];
      expect(rulesFor(board, "stray")).toEqual(["ticket-under-container-epic"]);
    });

    it("faults a feature parented to anything but an epic", () => {
      const board = [epic("e1"), feature("f1", "e1"), task("t1", "f1"), feature("nested", "f1")];
      expect(rulesFor(board, "nested")).toContain("feature-under-non-epic");
      expect(rulesFor(board, "nested")).not.toContain("feature-without-epic");
    });

    it("faults a parentless chore but not a parentless task or bug", () => {
      const board = [bead("c1", "chore"), bead("t1", "task"), bead("b1", "bug")];
      expect(rulesFor(board, "c1")).toEqual(["parentless-chore"]);
      expect(rulesFor(board, "t1")).toEqual([]);
      expect(rulesFor(board, "b1")).toEqual([]);
    });
  });

  describe("advisory — it runs, but the shape costs later", () => {
    it("warns on a feature with no tickets without blocking it", () => {
      // anton's runtime reads a childless feature as its own single ticket (beads.groupsChildren),
      // so this must never harden into a refusal.
      const board = [epic("e1"), feature("solo", "e1")];
      const [violation] = validateBoardStructure(board);
      expect(violation.rule).toBe("feature-without-tickets");
      expect(violation.severity).toBe("advisory");
    });

    it("does not count closed or abandoned tickets toward a feature's children", () => {
      const board = [
        epic("e1"),
        feature("f1", "e1"),
        task("t1", "f1", { status: "closed" }),
        task("t2", "f1", { labels: ["abandoned"] }),
      ];
      expect(rulesFor(board, "f1")).toEqual(["feature-without-tickets"]);
    });

    it("warns on a parentless feature", () => {
      const board = [feature("f1"), task("t1", "f1"), task("t2", "f1")];
      expect(rulesFor(board, "f1")).toEqual(["feature-without-epic"]);
    });

    it("warns past the ticket budget but not at it", () => {
      const kids = (n: number) => Array.from({ length: n }, (_, i) => task(`t${i}`, "f1"));
      const at = [epic("e1"), feature("f1", "e1"), ...kids(FEATURE_TICKET_BUDGET)];
      const over = [epic("e1"), feature("f1", "e1"), ...kids(FEATURE_TICKET_BUDGET + 1)];
      expect(rulesFor(at, "f1")).toEqual([]);
      expect(rulesFor(over, "f1")).toEqual(["feature-over-ticket-budget"]);
    });

    it("warns on a 1-ticket feature — the budget's lower half, which the skills also state", () => {
      // `skills/bd/SKILL.md`: "A feature with 1 ticket is a shape question — you probably described
      // the same work twice." Silence here would have the checker call a board clean that the skill
      // an agent just read calls malformed.
      const board = [epic("e1"), feature("thin", "e1"), task("t1", "thin")];
      expect(rulesFor(board, "thin")).toEqual(["feature-under-ticket-budget"]);
      expect(validateBoardStructure(board)[0].severity).toBe("advisory");
    });

    describe("the ticket count is the run's, not the direct children's", () => {
      // execute-epic dispatches `ticket-view.runTickets` — every working-layer DESCENDANT — so a
      // budget counting direct children only reads a seven-ticket PR as a one-ticket one.
      it("counts nested tickets toward the budget", () => {
        const nested = Array.from({ length: FEATURE_TICKET_BUDGET }, (_, i) => task(`n${i}`, "t1"));
        const board = [epic("e1"), feature("f1", "e1"), task("t1", "f1"), ...nested];
        expect(rulesFor(board, "f1")).toEqual(["feature-over-ticket-budget"]);
      });

      it("stops at a nested run target — it owns its own subtree and its own PR", () => {
        // `inner` is a `feature-under-non-epic` fault of its own; its tickets are NOT f1's.
        const board = [
          epic("e1"),
          feature("f1", "e1"),
          task("t1", "f1"),
          task("t2", "f1"),
          feature("inner", "f1"),
          ...Array.from({ length: FEATURE_TICKET_BUDGET }, (_, i) => task(`i${i}`, "inner")),
        ];
        expect(rulesFor(board, "f1")).toEqual([]);
      });

      it("descends THROUGH a closed ticket without counting it", () => {
        // The closed task's open subtask still ships in this feature's run (boardCards.cardOf
        // ignores status), so it counts — while the closed task itself does not.
        const board = [
          epic("e1"),
          feature("f1", "e1"),
          task("done", "f1", { status: "closed" }),
          task("live", "done"),
        ];
        expect(rulesFor(board, "f1")).toEqual(["feature-under-ticket-budget"]);
      });
    });

    it("names a parent that isn't on the board rather than passing the bead silently", () => {
      // A dangling ref: `cardOf` stops dead at the missing parent, so nothing owns this ticket and
      // no run reaches it — yet every other rule tests `parent` or `!parentId` and would miss it.
      const board = [...HEALTHY, task("orphan", "ghost")];
      expect(rulesFor(board, "orphan")).toEqual(["dangling-parent"]);
      const [violation] = validateBoardStructure(board);
      expect(violation.severity).toBe("advisory");
      expect(violation.message).toContain("ghost");
    });
  });

  describe("what is never judged", () => {
    it("skips closed and abandoned offenders", () => {
      const board = [
        ...HEALTHY,
        task("closed-stray", "e1", { status: "closed" }),
        task("dropped-stray", "e1", { labels: ["abandoned"] }),
      ];
      expect(validateBoardStructure(board)).toEqual([]);
    });

    it("skips pipeline plumbing", () => {
      expect(validateBoardStructure([bead("m1", "molecule"), bead("g1", "gate")])).toEqual([]);
    });
  });

  it("names the offending bead and the bd command that fixes it", () => {
    const board = [...HEALTHY, task("stray", "e1")];
    const line = formatStructureViolations(validateBoardStructure(board));
    expect(line).toContain("stray");
    expect(line).toContain("bd update stray --parent");
  });
});

describe("structureGaps", () => {
  const BOARD = [
    epic("e1"),
    feature("f1", "e1"),
    task("t1", "f1"),
    task("t1b", "f1"),
    feature("f2", "e1"),
    task("t2", "f2"),
    task("t2b", "f2"),
    task("stray", "e1"),
  ];

  it("returns a target's own subtree faults", () => {
    const board = [...BOARD, feature("nested", "f1")];
    expect(structureGaps("f1", board).blocking.map((v) => v.id)).toEqual(["nested"]);
  });

  it("does not strand a healthy sibling over a fault elsewhere on the board", () => {
    expect(structureGaps("f2", BOARD)).toEqual({ blocking: [], advisory: [] });
  });

  it("rolls a stray child up to the epic that owns it", () => {
    expect(structureGaps("e1", BOARD).blocking.map((v) => v.id)).toEqual(["stray"]);
  });

  it("returns both severities from one call, so no caller walks the board twice", () => {
    const board = [...BOARD, feature("thin", "e1"), task("only", "thin")];
    const gaps = structureGaps("e1", board);
    expect(gaps.blocking.map((v) => v.id)).toEqual(["stray"]);
    expect(gaps.advisory.map((v) => v.id)).toEqual(["thin"]);
  });

  it("terminates on a parent cycle", () => {
    const cyclic = [feature("a", "b"), feature("b", "a")];
    expect(() => structureGaps("a", cyclic)).not.toThrow();
  });
});

describe("the report", () => {
  it("counts live beads, not the whole board", () => {
    const report = buildStructureReport([...HEALTHY, task("gone", "f1", { status: "closed" })]);
    expect(report.judged).toBe(HEALTHY.length);
    expect(report.blocking).toBe(0);
    expect(formatStructureReport(report)).toContain("epic → feature → ticket holds");
  });

  it("lists blocking violations before advisory ones", () => {
    const board = [epic("e1"), feature("solo", "e1"), task("stray", "e1")];
    const text = formatStructureReport(buildStructureReport(board), "repo");
    expect(text.indexOf("stray")).toBeLessThan(text.indexOf("solo"));
    expect(text).toContain("repo:");
  });
});
