/**
 * Unit tests for findOrphans (anton-3t2.4) — the pure "which tickets are loose" logic, exercised
 * without bd. Orphans = open, ticket-tier, NON-runnable beads with no parent (inline or via a
 * parent-child edge). Parentless task/bug beads are runnable standalone targets, so grooming leaves
 * them alone (anton-cmz); the loose tickets we bucket are non-runnable ticket types like `chore`.
 * Exempt types (`learning`, `molecule`, custom) ride on no run, so grooming leaves them loose too.
 */
import { describe, expect, it } from "vitest";
import type { Bead } from "../beads/bd";
import { validateBeadContract } from "../beads/contract";
import {
  findOrphans,
  ORPHAN_EPIC_DESCRIPTION,
  ORPHAN_EPIC_LABEL,
  ORPHAN_EPIC_TITLE,
} from "./orphan-grooming";

function bead(id: string, o: Partial<Bead> = {}): Bead {
  return { id, title: id, status: "open", issue_type: "chore", ...o };
}

describe("findOrphans", () => {
  it("returns open non-epic, non-runnable beads with no parent", () => {
    const all: Bead[] = [
      bead("c-1"), // orphan (chore — not runnable standalone)
      bead("c-2", { parent: "e-1" }), // parented inline
      bead("e-1", { issue_type: "epic" }), // epic, never an orphan
      bead("c-3", { status: "closed" }), // closed, skip
    ];
    expect(findOrphans(all).map((b) => b.id)).toEqual(["c-1"]);
  });

  it("excludes parentless task/bug beads — they are runnable standalone targets", () => {
    const all: Bead[] = [
      bead("t-1", { issue_type: "task" }), // runnable standalone — not groomed
      bead("b-1", { issue_type: "bug" }), // runnable standalone — not groomed
      bead("c-1"), // the real orphan
    ];
    expect(findOrphans(all).map((b) => b.id)).toEqual(["c-1"]);
  });

  it("leaves exempt-type beads loose — a run never dispatches them, so bucketing would strand them", () => {
    // A `learning`/`molecule`/custom-type child is not a run ticket (isTicketTier → false): parented
    // under the grooming epic it would sit undispatched while the epic's run completes around it.
    const all: Bead[] = [
      bead("l-1", { issue_type: "learning" }),
      bead("m-1", { issue_type: "molecule" }),
      bead("x-1", { issue_type: "custom" }),
      bead("u-1", { issue_type: undefined }), // typeless read — unclassifiable, never bucketed
      bead("c-1"), // chore — ticket tier, still groomed
    ];
    expect(findOrphans(all).map((b) => b.id)).toEqual(["c-1"]);
  });

  it("still buckets a parented task/bug once it's no longer standalone", () => {
    // A task WITH a parent isn't a run target, but it's also already parented, so it's not loose.
    const all: Bead[] = [bead("t-1", { issue_type: "task", parent: "e-1" }), bead("e-1", { issue_type: "epic" })];
    expect(findOrphans(all)).toEqual([]);
  });

  it("treats a parent-child edge as parented (not orphan)", () => {
    const all: Bead[] = [
      bead("c-1", {
        dependencies: [{ issue_id: "c-1", depends_on_id: "e-1", type: "parent-child" }],
      }),
      bead("e-1", { issue_type: "epic" }),
    ];
    expect(findOrphans(all)).toEqual([]);
  });

  it("excludes the grooming epic and anything tagged as its bucket", () => {
    const all: Bead[] = [
      bead("e-orphans", { issue_type: "epic", labels: [ORPHAN_EPIC_LABEL] }),
      bead("c-1", { labels: [ORPHAN_EPIC_LABEL] }), // defensively excluded
      bead("c-2"), // the real orphan
    ];
    expect(findOrphans(all).map((b) => b.id)).toEqual(["c-2"]);
  });

  it("does not treat a blocks edge as a parent", () => {
    const all: Bead[] = [
      bead("c-1", {
        dependencies: [{ issue_id: "c-1", depends_on_id: "c-2", type: "blocks" }],
      }),
      bead("c-2"),
    ];
    expect(findOrphans(all).map((b) => b.id).sort()).toEqual(["c-1", "c-2"]);
  });
});

describe("the grooming epic anton writes for itself", () => {
  const epic: Bead = {
    id: "e-orphans",
    title: ORPHAN_EPIC_TITLE,
    status: "open",
    issue_type: "epic",
    labels: [ORPHAN_EPIC_LABEL],
    description: ORPHAN_EPIC_DESCRIPTION,
  };

  it("uses the epic tier's rubric heading, not a ticket's `## Acceptance`", () => {
    // `bd create --validate` refuses an epic without `## Success Criteria`, and gardener's lint
    // sweep would file this self-created epic as a standing hygiene finding on every run.
    expect(ORPHAN_EPIC_DESCRIPTION).toContain("## Success Criteria");
    expect(ORPHAN_EPIC_DESCRIPTION).not.toContain("## Acceptance");
  });

  it("satisfies the epic contract anton enforces on every other bead", () => {
    const blocking = validateBeadContract(epic).filter((v) => v.severity === "blocking");
    expect(blocking).toEqual([]);
  });
});
