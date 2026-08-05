/**
 * Post-approval re-validation (anton-xg5y), over fixture boards.
 *
 * The claim worth proving here is narrow and total: an approval is only as good as the facts it was
 * given for, and this is what notices when those facts stop holding. So the cases are the three ways
 * the approve gate can start refusing work it already let through — a rubric edited away, a tier
 * shape broken under it, an ordering edge drawn in front of it — plus the two ways this pass must
 * stay quiet: work no approval covers, and work a run already owns.
 *
 * Pure over the board, so a fixture is a complete test of what a pass would find.
 */
import { describe, expect, it } from "vitest";

import { LABELS, type Bead } from "../beads/bd";
import { revalidateApprovals } from "./revalidate";

const NOW = Date.parse("2026-08-03T00:00:00Z");
/** Any bd stamp: without one a bead never came from a bd read, and the contract never judges it. */
const STAMP = "2026-08-01T00:00:00Z";

function bead(id: string, extra: Partial<Bead> = {}): Bead {
  return { id, title: id, status: "open", issue_type: "task", updated_at: STAMP, ...extra };
}

/** A bead the founder approved. Sound unless a case takes something away from it. */
function approved(id: string, extra: Partial<Bead> = {}): Bead {
  return bead(id, {
    labels: [LABELS.approved],
    acceptance_criteria: "- [ ] it does the one thing",
    ...extra,
  });
}

/** A `blocks` edge as `bd list --json` carries it: `id` waits on `blocker`. */
const waitsOn = (id: string, blocker: string, extra: Partial<Bead> = {}): Partial<Bead> => ({
  dependencies: [{ issue_id: id, depends_on_id: blocker, type: "blocks" }],
  ...extra,
});

const child = (id: string, parent: string, extra: Partial<Bead> = {}): Bead =>
  bead(id, {
    parent,
    dependencies: [{ issue_id: id, depends_on_id: parent, type: "parent-child" }],
    ...extra,
  });

const subjectsOf = (board: Bead[]): string[][] =>
  revalidateApprovals(board, NOW).map((d) => d.subjects);

describe("re-validating approvals the board has moved past", () => {
  it("files exactly one proposal for an approved bead whose Acceptance was stripped", () => {
    const board = [approved("anton-a", { acceptance_criteria: undefined }), approved("anton-b")];
    const [detection, ...rest] = revalidateApprovals(board, NOW);

    expect(rest).toEqual([]);
    expect(detection).toMatchObject({ kind: "degraded-approval", move: "unapprove", subjects: ["anton-a"] });
    expect(detection.fingerprint).toMatch(/^pm:degraded-approval:[0-9a-f]{12}$/);
    // The specific violation IS the evidence — an approver must be able to check the claim without
    // re-deriving it from the board.
    expect(detection.evidence.join("\n")).toMatch(/no Acceptance criteria/);
    expect(detection.evidence.join("\n")).toMatch(/removes the `approved` label/);
  });

  it("judges the ticket set a run would dispatch, not the target alone", () => {
    // The target itself is conformant; the child the run would hand an agent is not. That is the set
    // the approve gate judges, so it is the set a re-check has to judge.
    const board = [
      approved("anton-f", { issue_type: "feature" }),
      child("anton-t1", "anton-f", { acceptance_criteria: "- [ ] done" }),
      child("anton-t2", "anton-f"),
    ];
    const [detection] = revalidateApprovals(board, NOW);
    expect(detection.subjects).toEqual(["anton-f"]);
    expect(detection.evidence.join("\n")).toMatch(/anton-t2 → no Acceptance criteria/);
  });

  it("surfaces a tier shape that broke under an approved target", () => {
    // A feature landed under the approved feature since it was approved. Both are run targets, so
    // the same work now ships twice — the tier refusal the approve gate backstops.
    const board = [
      approved("anton-f", { issue_type: "feature" }),
      child("anton-f2", "anton-f", { issue_type: "feature", acceptance_criteria: "- [ ] ok" }),
    ];
    const detections = revalidateApprovals(board, NOW);
    expect(detections.map((d) => d.subjects)).toEqual([["anton-f"]]);
    expect(detections[0].evidence.join("\n")).toMatch(/anton-f2 → parented to anton-f/);
  });

  it("surfaces an ordering edge drawn after the approval", () => {
    const board = [
      approved("anton-a", waitsOn("anton-a", "anton-b")),
      bead("anton-b", { acceptance_criteria: "- [ ] ok" }),
    ];
    const [detection] = revalidateApprovals(board, NOW);
    expect(detection.subjects).toEqual(["anton-a"]);
    expect(detection.evidence.join("\n")).toMatch(/blocked by anton-b/);
  });

  it("asks ONCE per bead however many ways it degraded", () => {
    const board = [
      approved("anton-a", { acceptance_criteria: undefined, ...waitsOn("anton-a", "anton-b") }),
      bead("anton-b", { acceptance_criteria: "- [ ] ok" }),
    ];
    const detections = revalidateApprovals(board, NOW);
    expect(detections).toHaveLength(1);
    // Both gaps still travel as evidence — one ask, the whole picture.
    expect(detections[0].evidence.join("\n")).toMatch(/no Acceptance criteria/);
    expect(detections[0].evidence.join("\n")).toMatch(/blocked by anton-b/);
  });

  it("files nothing for a board whose approvals all still hold", () => {
    expect(revalidateApprovals([approved("anton-a"), approved("anton-b")], NOW)).toEqual([]);
  });

  it("says nothing about work no approval covers — an unapproved gap is not rot", () => {
    // Identical bead, no `approved` label: nothing promised it would run, so there is nothing to
    // withdraw. Shaping it is `/shape`'s job and the gardener's, not this pass's.
    expect(subjectsOf([bead("anton-a")])).toEqual([]);
  });

  it("leaves work a run already owns alone — withdrawing approval under a run kills it", () => {
    const claimed = approved("anton-a", {
      acceptance_criteria: undefined,
      status: "in_progress",
      assignee: "runner-1",
    });
    const inReview = approved("anton-b", {
      acceptance_criteria: undefined,
      labels: [LABELS.approved, LABELS.stage("in-review")],
    });
    expect(subjectsOf([claimed, inReview])).toEqual([]);
  });

  it("never proposes against a child ticket or a container epic — only what anton runs", () => {
    // The ticket is unrunnable on its own and the epic launches one PR per feature, so neither is a
    // bead approval covers. Only the feature between them is a run target.
    const board = [
      approved("anton-e", { issue_type: "epic", acceptance_criteria: undefined }),
      child("anton-f", "anton-e", { issue_type: "feature", labels: [LABELS.approved] }),
      child("anton-t", "anton-f", { labels: [LABELS.approved] }),
    ];
    expect(subjectsOf(board)).toEqual([["anton-f"]]);
  });

  it("skips a settled bead: a closed target's approval queues nothing", () => {
    const board = [approved("anton-a", { acceptance_criteria: undefined, status: "closed" })];
    expect(revalidateApprovals(board, NOW)).toEqual([]);
  });

  it("is deterministic: two passes over one board produce identical asks", () => {
    const board = [
      approved("anton-a", { acceptance_criteria: undefined }),
      approved("anton-b", { acceptance_criteria: undefined }),
    ];
    expect(revalidateApprovals(board, NOW)).toEqual(revalidateApprovals(board, NOW));
  });
});
