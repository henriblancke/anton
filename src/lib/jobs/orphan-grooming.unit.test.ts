/**
 * Unit tests for findOrphans (anton-3t2.4) — the pure "which tickets are loose" logic, exercised
 * without bd. Orphans = open, non-epic beads with no parent (inline or via a parent-child edge).
 */
import { describe, expect, it } from "vitest";
import type { Bead } from "../beads/bd";
import { findOrphans, ORPHAN_EPIC_LABEL } from "./orphan-grooming";

function bead(id: string, o: Partial<Bead> = {}): Bead {
  return { id, title: id, status: "open", issue_type: "task", ...o };
}

describe("findOrphans", () => {
  it("returns open non-epic beads with no parent", () => {
    const all: Bead[] = [
      bead("t-1"), // orphan
      bead("t-2", { parent: "e-1" }), // parented inline
      bead("e-1", { issue_type: "epic" }), // epic, never an orphan
      bead("t-3", { status: "closed" }), // closed, skip
    ];
    expect(findOrphans(all).map((b) => b.id)).toEqual(["t-1"]);
  });

  it("treats a parent-child edge as parented (not orphan)", () => {
    const all: Bead[] = [
      bead("t-1", {
        dependencies: [{ issue_id: "t-1", depends_on_id: "e-1", type: "parent-child" }],
      }),
      bead("e-1", { issue_type: "epic" }),
    ];
    expect(findOrphans(all)).toEqual([]);
  });

  it("excludes the grooming epic and anything tagged as its bucket", () => {
    const all: Bead[] = [
      bead("e-orphans", { issue_type: "epic", labels: [ORPHAN_EPIC_LABEL] }),
      bead("t-1", { labels: [ORPHAN_EPIC_LABEL] }), // defensively excluded
      bead("t-2"), // the real orphan
    ];
    expect(findOrphans(all).map((b) => b.id)).toEqual(["t-2"]);
  });

  it("does not treat a blocks edge as a parent", () => {
    const all: Bead[] = [
      bead("t-1", {
        dependencies: [{ issue_id: "t-1", depends_on_id: "t-2", type: "blocks" }],
      }),
      bead("t-2"),
    ];
    expect(findOrphans(all).map((b) => b.id).sort()).toEqual(["t-1", "t-2"]);
  });
});
