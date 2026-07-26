/**
 * The review-fix protocol helpers moved to review-fix-context.ts (anton-l6u); their tests live in
 * review-fix-context.test.ts. This spec keeps a smoke check that the parser is still re-exported
 * from ./review-fix so existing importers keep working. The end-to-end flow is covered by
 * review-fix.integration.test.ts.
 */
import { describe, expect, it } from "vitest";
import { inReviewEpics, parseThreadReport } from "./review-fix";
import { LABELS, type Bead } from "../beads/bd";

describe("parseThreadReport (re-exported from ./review-fix)", () => {
  it("parses the fenced json report block", () => {
    const text = [
      "I renamed foo to bar and left the style nit.",
      "```json",
      '{"threads":[{"id":"RT_1","outcome":"fixed","reply":"renamed foo to bar"},{"id":"RT_2","outcome":"left","reply":"style-only; skipped"}]}',
      "```",
    ].join("\n");
    expect(parseThreadReport(text)).toEqual([
      { id: "RT_1", outcome: "fixed", reply: "renamed foo to bar" },
      { id: "RT_2", outcome: "left", reply: "style-only; skipped" },
    ]);
  });

  it("uses the LAST report block when several json blocks appear", () => {
    const text = [
      "```json",
      '{"threads":[{"id":"RT_stale","outcome":"fixed"}]}',
      "```",
      "actually, final report:",
      "```json",
      '{"threads":[{"id":"RT_1","outcome":"needs-human","reply":"product call needed"}]}',
      "```",
    ].join("\n");
    expect(parseThreadReport(text)).toEqual([
      { id: "RT_1", outcome: "needs-human", reply: "product call needed" },
    ]);
  });

  it("skips a trailing non-report json block and finds the report before it", () => {
    const text = [
      "```json",
      '{"threads":[{"id":"RT_1","outcome":"fixed"}]}',
      "```",
      "for reference, the config I touched:",
      "```json",
      '{"compilerOptions":{"strict":true}}',
      "```",
    ].join("\n");
    expect(parseThreadReport(text)).toEqual([{ id: "RT_1", outcome: "fixed" }]);
  });

  it("drops malformed entries but keeps valid ones", () => {
    const text = [
      "```json",
      '{"threads":[{"id":"RT_1","outcome":"fixed"},{"outcome":"left"},{"id":"RT_3","outcome":"maybe"},"junk"]}',
      "```",
    ].join("\n");
    expect(parseThreadReport(text)).toEqual([{ id: "RT_1", outcome: "fixed" }]);
  });

  it("returns [] for missing / malformed / absent reports", () => {
    expect(parseThreadReport(undefined)).toEqual([]);
    expect(parseThreadReport("all done, no threads to report")).toEqual([]);
    expect(parseThreadReport("```json\n{not json\n```")).toEqual([]);
    expect(parseThreadReport('```json\n{"threads":"nope"}\n```')).toEqual([]);
  });
});

describe("inReviewEpics", () => {
  const IN_REVIEW = LABELS.stage("in-review");
  const bead = (over: Partial<Bead>): Bead => ({
    id: over.id ?? "b1",
    title: "t",
    status: "in_progress",
    labels: [IN_REVIEW],
    metadata: { pr: "gh-1" }, // the PR pointer lives at metadata.pr (anton-76ej), read via getPrRef
    ...over,
  });

  it("selects in-review run targets: epics AND standalone (parentless) task/bug PR targets", () => {
    // anton-cmz review: a standalone task/bug runs as an epic-of-one and stays open + in-review +
    // PR ref until its PR merges. review-fix must sweep it too, else its PR falls out of the
    // automated review/finalization path and the board derives it Done while the PR is still open.
    const epic = bead({ id: "epic-1", issue_type: "epic" });
    const task = bead({ id: "task-1", issue_type: "task" }); // parentless → run target
    const bug = bead({ id: "bug-1", issue_type: "bug" }); // parentless → run target
    const selected = inReviewEpics([epic, task, bug]).map((b) => b.id);
    expect(selected).toEqual(["epic-1", "task-1", "bug-1"]);
  });

  it("excludes child tickets, closed beads, non-in-review, and PR-ref-less beads", () => {
    const child = bead({ id: "child-1", issue_type: "task", parent: "epic-1" }); // has a parent
    const closed = bead({ id: "closed-1", issue_type: "epic", status: "closed" });
    const noLabel = bead({ id: "nolabel-1", issue_type: "bug", labels: [] });
    const noRef = bead({ id: "noref-1", issue_type: "epic", metadata: undefined });
    expect(inReviewEpics([child, closed, noLabel, noRef])).toEqual([]);
  });

  it("a tracker URL in external_ref (no metadata.pr) is NOT swept — external_ref is not the PR channel", () => {
    // anton-76ej: enabling a tracker integration (e.g. Linear) parks its URL in external_ref. The
    // sweep reads the PR pointer through getPrRef, which honors only metadata.pr or a legacy gh-* ref
    // — a tracker URL there must never read as an open PR, or Linear would silently trip the sweep.
    const linear = bead({
      id: "linear-1",
      issue_type: "epic",
      metadata: undefined,
      external_ref: "https://linear.app/acme/issue/ACME-42",
    });
    expect(inReviewEpics([linear])).toEqual([]);
  });

  it("honors a legacy gh-* external_ref as a PR pointer until the metadata.pr backfill (anton-76ej)", () => {
    const legacy = bead({ id: "legacy-1", issue_type: "epic", metadata: undefined, external_ref: "gh-9" });
    expect(inReviewEpics([legacy]).map((b) => b.id)).toEqual(["legacy-1"]);
  });

  // Ownership matrix (anton-zoh): on a shared board an operator may only act on epics it claimed
  // or unclaimed ones. `assignee` is the claim execute-epic stamps; a DIFFERENT operator's claim
  // is excluded, and an unresolved identity (operator undefined) sees ONLY unclaimed epics.
  describe("operator ownership filter", () => {
    const unclaimed = bead({ id: "unclaimed", issue_type: "epic", assignee: null });
    const mine = bead({ id: "mine", issue_type: "epic", assignee: "alice" });
    const theirs = bead({ id: "theirs", issue_type: "epic", assignee: "bob" });
    const board = [unclaimed, mine, theirs];

    it("selects unclaimed AND claimed-by-me, excludes claimed-by-another", () => {
      expect(inReviewEpics(board, { operator: "alice" }).map((b) => b.id)).toEqual([
        "unclaimed",
        "mine",
      ]);
    });

    it("selects ONLY unclaimed when the operator is unresolved (undefined)", () => {
      expect(inReviewEpics(board, { operator: undefined }).map((b) => b.id)).toEqual(["unclaimed"]);
    });

    it("treats an empty-string / whitespace assignee as unclaimed", () => {
      const blank = bead({ id: "blank", issue_type: "epic", assignee: "  " });
      expect(inReviewEpics([blank], { operator: "alice" }).map((b) => b.id)).toEqual(["blank"]);
    });

    it("a targeted epicBeadId BYPASSES ownership — another operator's epic still selected", () => {
      expect(
        inReviewEpics(board, { operator: "alice", epicBeadId: "theirs" }).map((b) => b.id),
      ).toEqual(["theirs"]);
    });

    it("a targeted epicBeadId still respects the in-review/run-target/PR-ref gates", () => {
      const closedTheirs = bead({ id: "theirs", issue_type: "epic", assignee: "bob", status: "closed" });
      expect(inReviewEpics([closedTheirs], { epicBeadId: "theirs" })).toEqual([]);
    });
  });
});
