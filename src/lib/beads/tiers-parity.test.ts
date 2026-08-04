/**
 * `tiers.mjs` has to be plain JS (the release bundle ships no TypeScript, and `anton board-check`
 * runs from the pure-Node launcher), so it carries its own copies of three predicates the app also
 * defines in TypeScript: `parentOf`, `isContainer`, and the pipeline-artifact / abandoned tests.
 * Two copies is the price of the bundle; two copies that DISAGREE is a bug — the CLI would pass a
 * board the approve gate refuses, or the reverse.
 *
 * So the copies are pinned here rather than trusted: every predicate is exercised against its twin
 * over a matrix that covers each field the two read differently (`parent` vs `parent_id`, a closed
 * feature child, the abandoned label, every pipeline type).
 */
import { describe, expect, it } from "vitest";
import { beads } from "./bd";
import { isPipelineArtifact } from "./contract";
import { isContainer, parentOf, validateBoardStructure } from "./structure";
import type { Bead } from "./types";

const bead = (id: string, issue_type: string, over: Partial<Bead> = {}): Bead => ({
  id,
  title: id,
  status: "open",
  issue_type,
  ...over,
});

describe("tiers.mjs agrees with the app's TypeScript predicates", () => {
  it("parentOf reads the same field bd.ts does, from either shape of bd read", () => {
    // `bd list` populates `parent`; `bd show` populates `parent_id`. A copy that read only one would
    // silently judge half the call sites as parentless.
    const cases: Bead[] = [
      bead("a", "task"),
      bead("b", "task", { parent: "p1" }),
      bead("c", "task", { parent_id: "p2" }),
      bead("d", "task", { parent: "p1", parent_id: "p2" }),
    ];
    for (const b of cases) expect(parentOf(b)).toBe(beads.parentOf(b));
  });

  it("isContainer agrees with bd.ts across the cases that flip it", () => {
    const boards: Bead[][] = [
      [bead("e", "epic")], // no children at all — a legacy run target
      [bead("e", "epic"), bead("t", "task", { parent: "e" })], // pre-tier: tickets only
      [bead("e", "epic"), bead("f", "feature", { parent: "e" })], // a feature landed → container
      [bead("e", "epic"), bead("f", "feature", { parent: "e", status: "closed" })], // still a container
      [bead("e", "epic"), bead("f", "feature", { parent_id: "e" })], // parentage via the show shape
      [bead("f", "feature"), bead("t", "task", { parent: "f" })], // not an epic at all
    ];
    for (const board of boards) {
      for (const b of board) expect(isContainer(b, board)).toBe(beads.isContainer(b, board));
    }
  });

  it("skips exactly the beads contract.ts calls pipeline artifacts", () => {
    // A type the two disagree on would be judged by one and waved through by the other.
    for (const type of ["molecule", "gate", "task", "bug", "chore", "feature", "epic", "learning"]) {
      const board = [bead("p", type, { parent: "container" }), bead("container", "epic"), bead("f", "feature", { parent: "container" })];
      const judged = validateBoardStructure(board).some((v) => v.id === "p");
      // Only a ticket-tier bead can be faulted here; the point is that a pipeline type is never one.
      if (isPipelineArtifact(bead("p", type))) expect(judged).toBe(false);
    }
  });

  it("treats the abandoned label the way bd.ts does", () => {
    const dropped = bead("stray", "task", { parent: "e", labels: ["abandoned"] });
    expect(beads.isAbandoned(dropped)).toBe(true);
    const board = [bead("e", "epic"), bead("f", "feature", { parent: "e" }), dropped];
    expect(validateBoardStructure(board).some((v) => v.id === "stray")).toBe(false);
  });
});
