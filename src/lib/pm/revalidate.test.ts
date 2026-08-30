/**
 * Post-approval re-validation (anton-xg5y), over fixture boards.
 *
 * The claim worth proving here is narrow and total: an approval is only as good as the facts it was
 * given for, and this is what notices when those facts stop holding. So the cases are the four ways
 * the approve gate can start refusing work it already let through — a rubric edited away, a tier
 * shape broken under it, an ordering edge drawn in front of it, and the target ceasing to be one at
 * all — plus the two ways this pass must stay quiet: work no approval covers, and work a run already
 * owns.
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

/**
 * An approved feature whose named tickets each wait on a ticket of ANOTHER run target — the
 * cross-run gate of issue #58. By default only the tail child is held, so the run still has work
 * to dispatch; name every ticket to gate the whole target.
 */
function partiallyGatedBoard(gated: string[] = ["anton-t3"]): Bead[] {
  const ticket = (id: string): Bead =>
    child(id, "anton-fa", {
      acceptance_criteria: "- [ ] ok",
      dependencies: [
        { issue_id: id, depends_on_id: "anton-fa", type: "parent-child" },
        ...(gated.includes(id)
          ? [{ issue_id: id, depends_on_id: "anton-b1", type: "blocks" }]
          : []),
      ],
    });
  return [
    approved("anton-fa", { issue_type: "feature" }),
    ticket("anton-t1"),
    ticket("anton-t2"),
    ticket("anton-t3"),
    bead("anton-fb", { issue_type: "feature" }),
    child("anton-b1", "anton-fb", { acceptance_criteria: "- [ ] ok" }),
  ];
}

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

  it("leaves a PARTIALLY-gated target approved — the run starts, so nothing degraded", () => {
    // One cross-run-gated tail child, two ready siblings: the approve route runs this target
    // (issue #58). Judging it on the coarse target-level rollup here would file an `unapprove`
    // proposal claiming a worker cannot start it — false, and approving it strips the label off a
    // run that was shipping fine, every pass until someone gives in.
    expect(subjectsOf(partiallyGatedBoard())).toEqual([]);
  });

  it("still files on a FULLY gated target — zero tickets a worker could pick up", () => {
    const board = partiallyGatedBoard(["anton-t1", "anton-t2", "anton-t3"]);
    const [detection] = revalidateApprovals(board, NOW);
    expect(detection.subjects).toEqual(["anton-fa"]);
    expect(detection.evidence.join("\n")).toMatch(/blocked by anton-fb/);
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

  it("surfaces an approved epic that became a container — the rot that hides best", () => {
    // A feature landed under an epic approved as one unit of work. It is no longer a run target, so
    // the claimable set skips it and a dispatch would poison-park: the approval promises a run that
    // can never happen, and nothing else on the board says so.
    const board = [
      approved("anton-e", { issue_type: "epic" }),
      child("anton-f", "anton-e", { issue_type: "feature", acceptance_criteria: "- [ ] ok" }),
    ];
    const [detection, ...rest] = revalidateApprovals(board, NOW);

    expect(rest).toEqual([]);
    expect(detection.subjects).toEqual(["anton-e"]);
    expect(detection.evidence.join("\n")).toMatch(/no longer a run target/);
    expect(detection.evidence.join("\n")).toMatch(/container epic/);
    // Stated as the harm it actually is: nothing will come for it, not "a worker can pick it up".
    expect(detection.evidence.join("\n")).toMatch(/a worker that will never come/);
  });

  it("surfaces an approved bead re-parented into somebody else's ticket set", () => {
    // A parentless task approved on its own, since re-homed under a feature: it now runs as one of
    // that feature's tickets, so its own approval stops meaning anything.
    const board = [
      approved("anton-f", { issue_type: "feature" }),
      child("anton-t", "anton-f", { labels: [LABELS.approved], acceptance_criteria: "- [ ] ok" }),
    ];
    const [detection, ...rest] = revalidateApprovals(board, NOW);

    expect(rest).toEqual([]);
    expect(detection.subjects).toEqual(["anton-t"]);
    expect(detection.evidence.join("\n")).toMatch(/now sits under anton-f/);
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
