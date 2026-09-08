/**
 * The review-fix protocol helpers moved to review-fix-context.ts (anton-l6u); their tests live in
 * review-fix-context.test.ts. This spec keeps a smoke check that the parser is still re-exported
 * from ./review-fix so existing importers keep working. The end-to-end flow is covered by
 * review-fix.integration.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import * as schema from "../db/schema";
import { makeProjectDb, type TestProjectDb } from "@/lib/testing/project";
import { driveJob } from "@/lib/testing/jobs";
import { getJob, type Clock } from "./queue";
import type { PrReview } from "../git/pr";
import { claimOwnerFor, inReviewEpics, makeReviewFixHandler, parseThreadReport } from "./review-fix";
import { LABELS, type Bead } from "../beads/bd";

/** The board read the dispatcher triages off. Everything else in beads stays real. */
const listMock = vi.fn();
vi.mock("../beads/bd", async () => {
  const actual = await vi.importActual<typeof import("../beads/bd")>("../beads/bd");
  return { ...actual, beads: { ...actual.beads, list: (...a: unknown[]) => listMock(...a), sync: vi.fn() } };
});

/** The one `gh` read per target. `classifyReview` stays real — the verdict is what is under test. */
const getPrReviewMock = vi.fn();
vi.mock("../git/pr", async () => {
  const actual = await vi.importActual<typeof import("../git/pr")>("../git/pr");
  return { ...actual, getPrReview: (...a: unknown[]) => getPrReviewMock(...a) };
});

const resolveOperatorMock = vi.fn();
vi.mock("../operator", () => ({ resolveOperator: (...a: unknown[]) => resolveOperatorMock(...a) }));

// Stubbed so an assertion can prove the dispatcher never reaches them — the whole point of the
// split is that triage costs a board read and one `gh` call per PR, nothing heavier.
const createWorktreeMock = vi.fn();
vi.mock("../git/worktree", () => ({
  createWorktree: (...a: unknown[]) => createWorktreeMock(...a),
  withWorktreeClaim: vi.fn(),
}));
const runClaudeMock = vi.fn();
vi.mock("../claude/driver", () => ({ runClaude: (...a: unknown[]) => runClaudeMock(...a) }));

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

  it("selects a feature — the tier that owns the worktree and the PR", () => {
    const epic = bead({ id: "epic-1", issue_type: "epic" });
    const feature = bead({ id: "feat-1", issue_type: "feature", parent: "epic-1" });
    expect(inReviewEpics([epic, feature]).map((b) => b.id)).toEqual(["feat-1"]);
  });

  it("excludes a container epic — its features carry their own PRs, and a merge would close them", () => {
    // A container epic can be PR-linked by hand. Classifying it against the full list keeps it out
    // of the sweep: finalizeMergedEpic would otherwise close its feature children (anton-9pkk review).
    const epic = bead({ id: "epic-1", issue_type: "epic" });
    const feature = bead({ id: "feat-1", issue_type: "feature", parent: "epic-1", labels: [] });
    expect(inReviewEpics([epic, feature]).map((b) => b.id)).toEqual([]);
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

describe("claimOwnerFor", () => {
  // Two anton instances sharing a board can each hold a review-fix-pr job for the same target
  // (jobs are machine-local). A shared owner string would let the second reuse the first's checkout
  // — the worktree claim only refuses an owner that DIFFERS from the caller — so both would drive
  // git, claude, commit and push over one directory.
  it("gives each job a distinct owner, under a readable prefix", () => {
    const a = claimOwnerFor("11111111-1111-4111-8111-111111111111");
    const b = claimOwnerFor("22222222-2222-4222-8222-222222222222");
    expect(a).not.toBe(b);
    expect(a.startsWith("review-fix")).toBe(true);
    expect(a).toContain("11111111-1111-4111-8111-111111111111");
  });

  it("has no whitespace, so it survives the git lock reason round-trip", () => {
    // claimLockReason writes `anton-claim <owner> pid=… host=…` and parses the owner back as \S+.
    expect(claimOwnerFor("job-1")).not.toMatch(/\s/);
  });
});

/**
 * The dispatcher (anton-mcbp). The scheduled poll's whole job is now triage: read the board, read
 * each in-review PR once, and hand every target that is MERGED or actionable to its own
 * `review-fix-pr` job. It must materialize no worktree and drive no claude session — that is what
 * keeps it inside its own slot, and what stops a long fix on one PR from serializing the rest.
 */
describe("makeReviewFixHandler (the dispatcher)", () => {
  const target = (id: string, prNumber: number): Bead => ({
    id,
    title: id,
    status: "in_progress",
    issue_type: "epic",
    labels: [LABELS.stage("in-review")],
    metadata: { pr: `gh-${prNumber}` },
  });

  const openPr = (number: number, over: Partial<PrReview> = {}): PrReview => ({
    number,
    state: "OPEN",
    reviewDecision: "APPROVED",
    mergeable: "MERGEABLE",
    headRefName: `anton/pr-${number}`,
    url: `https://example.test/pull/${number}`,
    reviews: [],
    failingChecks: [],
    pendingChecks: 0,
    threads: [],
    ...over,
  });

  let t: TestProjectDb;
  const clock: Clock = { now: () => 1_700_000_000_000 };

  beforeEach(() => {
    t = makeProjectDb();
    vi.clearAllMocks();
    resolveOperatorMock.mockResolvedValue("alice");
  });
  afterEach(() => t.close());

  /** Every review-fix-pr row the dispatcher queued, by the target it names. */
  const dispatchedTargets = () =>
    t.db
      .select()
      .from(schema.jobs)
      .where(eq(schema.jobs.type, "review-fix-pr"))
      .all()
      .map((j) => JSON.parse(j.payloadJson).epicBeadId as string);

  const dispatch = () =>
    driveJob({
      db: t.db,
      clock,
      type: "review-fix",
      handler: makeReviewFixHandler,
      projectId: t.projectId,
      config: { leaseMs: 30_000 },
    });

  it("dispatches one job per actionable or merged target, and none for a clean PR", async () => {
    listMock.mockResolvedValue([target("e-1", 1), target("e-2", 2), target("e-3", 3)]);
    getPrReviewMock.mockImplementation(async (_repo: string, number: number) => {
      if (number === 1) return openPr(1, { reviewDecision: "CHANGES_REQUESTED" });
      if (number === 2) return openPr(2, { state: "MERGED" });
      return openPr(3); // approved, green — nothing to do
    });

    const jobId = await dispatch();
    const job = await getJob(t.db, jobId);
    expect(job?.status).toBe("done");
    expect(job?.outcomeNote).toBe("examined 3 PR(s) in review, dispatched 2");
    expect(dispatchedTargets().sort()).toEqual(["e-1", "e-2"]);
    // Triage is one `gh` read per target — no worktree, no claude, no verify gate.
    expect(createWorktreeMock).not.toHaveBeenCalled();
    expect(runClaudeMock).not.toHaveBeenCalled();
  });

  it("dispatches nothing when every PR is clean, and reports the poll as unchanged", async () => {
    listMock.mockResolvedValue([target("e-1", 1)]);
    getPrReviewMock.mockResolvedValue(openPr(1));

    const job = await getJob(t.db, await dispatch());
    expect(job?.status).toBe("done");
    expect(job?.outcome).toBe("noop");
    expect(dispatchedTargets()).toEqual([]);
  });

  it("does not double-dispatch a target a live job already covers", async () => {
    listMock.mockResolvedValue([target("e-1", 1)]);
    getPrReviewMock.mockResolvedValue(openPr(1, { reviewDecision: "CHANGES_REQUESTED" }));

    await dispatch();
    await dispatch();
    expect(dispatchedTargets()).toEqual(["e-1"]);
  });

  // One unreadable PR must not cost the others their dispatch — but the failure still surfaces, so
  // the poll retries rather than reporting a clean pass over a target it never actually triaged.
  it("keeps fanning out past a PR it cannot read, then surfaces the failure", async () => {
    listMock.mockResolvedValue([target("e-1", 1), target("e-2", 2)]);
    getPrReviewMock.mockImplementation(async (_repo: string, number: number) => {
      if (number === 1) throw new Error("gh: could not read PR #1");
      return openPr(2, { reviewDecision: "CHANGES_REQUESTED" });
    });

    const job = await getJob(t.db, await dispatch());
    expect(job?.status).toBe("queued"); // retried, not settled clean
    expect(job?.lastError).toContain("could not read PR #1");
    expect(dispatchedTargets()).toEqual(["e-2"]);
  });

  it("skips a target another operator has claimed", async () => {
    const theirs: Bead = { ...target("theirs", 1), assignee: "bob" };
    listMock.mockResolvedValue([theirs]);
    getPrReviewMock.mockResolvedValue(openPr(1, { reviewDecision: "CHANGES_REQUESTED" }));

    await dispatch();
    expect(dispatchedTargets()).toEqual([]);
    expect(getPrReviewMock).not.toHaveBeenCalled(); // not even read — ownership is decided first
  });
});
