/**
 * The review-fix protocol helpers moved to review-fix-context.ts (anton-l6u); their tests live in
 * review-fix-context.test.ts. This spec keeps a smoke check that the parser is still re-exported
 * from ./review-fix so existing importers keep working. The end-to-end flow is covered by
 * review-fix.integration.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as schema from "../db/schema";
import { makeProjectDb, type TestProjectDb } from "@/lib/testing/project";
import { driveJob } from "@/lib/testing/jobs";
import { getJob, type Clock } from "./queue";
import type { JobContext } from "./runner";
import { GH_BIN_ENV } from "../git/ops";
import { ANTON_MARK, type PrReview, type ReviewThread } from "../git/pr";
import type { Worktree } from "../git/worktree";
import {
  allWaitingThreadsAnswered,
  applyThreadOutcomes,
  claimOwnerFor,
  fingerprintHasNonThreadReasons,
  inReviewEpics,
  makeReviewFixHandler,
  notifyGateParked,
  parseThreadReport,
  prepareFixWorktree,
  refreshFixRoundsBody,
  resolveReviewFixModel,
  runTestGate,
  type ThreadOutcome,
} from "./review-fix";
import { NON_THREAD_REPORT_ID } from "./review-fix-context";
import { LABELS, type Bead } from "../beads/bd";
import { PoisonError } from "./errors";
import type { ProjectSettings } from "../projects";

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
const warmWorktreeBestEffortMock = vi.fn();
vi.mock("../git/worktree", () => ({
  createWorktree: (...a: unknown[]) => createWorktreeMock(...a),
  warmWorktreeBestEffort: (...a: unknown[]) => warmWorktreeBestEffortMock(...a),
  withWorktreeClaim: vi.fn(),
}));
const runClaudeMock = vi.fn();
vi.mock("../claude/driver", () => ({ runClaude: (...a: unknown[]) => runClaudeMock(...a) }));

// prepareFixWorktree's own git steps (sync + premerge) — none of them under test here, so they're
// no-ops rather than hitting a real repo the mocked `createWorktree` above never actually made.
// `isAncestor` defaults to true (already caught up with the base) so premergeBase is a no-op by
// default — the mocked `worktreePath` below is a plain temp dir, not a real git repo, so the REAL
// `isAncestor` would otherwise reject and premergeBase's own `.catch(() => false)` would read that
// as "behind" and merge on every test regardless of what's actually under test.
const isAncestorMock = vi.fn();
const mergeIntoCurrentMock = vi.fn();
// Defaults to rejecting like the real `rev-parse` would against the plain temp dir `worktreePath`
// stands in for (not a real git repo) — tests that care about the base-ref check override this.
const resolveCommitShaMock = vi.fn().mockRejectedValue(new Error("not a git repo"));
vi.mock("../git/ops", async () => {
  const actual = await vi.importActual<typeof import("../git/ops")>("../git/ops");
  return {
    ...actual,
    fetchOrigin: vi.fn().mockResolvedValue(undefined),
    mergeIntoCurrent: (...a: unknown[]) => mergeIntoCurrentMock(...a),
    isAncestor: (...a: unknown[]) => isAncestorMock(...a),
    branchAheadOfRemote: vi.fn().mockResolvedValue(false),
    needsHooksPathOverrideForMerge: vi.fn().mockResolvedValue(false),
    resolveHooksPathOverrideForMerge: vi.fn().mockResolvedValue(undefined),
    resolveCommitSha: (...a: unknown[]) => resolveCommitShaMock(...a),
  };
});

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

it("routes the pipeline-free per-PR fix session by target label", () => {
  expect(
    resolveReviewFixModel(
      {
        model: "fallback",
        modelRoutes: [{ jobType: "review-fix-pr", label: "risk:high", model: "safe" }],
      },
      { labels: ["risk:high"] },
    ),
  ).toBe("safe");
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
 * anton-u02rt: prepareFixWorktree used to materialize the fix worktree with `warm: false` and
 * nothing after it, so a reused checkout landed a review-fix session with `node_modules` never
 * installed for a lockfile that had just changed — a gate then fails on a module the lockfile
 * plainly declares. The fix threads the project's resolved warm config through exactly like the
 * run path (execute-epic-claim.ts) does.
 */
describe("prepareFixWorktree (anton-u02rt)", () => {
  const fakeCtx = (): JobContext =>
    ({
      jobId: "job-test",
      type: "review-fix-pr",
      payload: {},
      attempt: 1,
      heartbeat: async () => {},
      signal: new AbortController().signal,
    }) as JobContext;

  let worktreePath: string;

  beforeEach(() => {
    vi.clearAllMocks();
    worktreePath = mkdtempSync(join(tmpdir(), "anton-review-fix-warm-"));
    createWorktreeMock.mockResolvedValue({
      path: worktreePath,
      branch: "anton/fix-7",
      baseBranch: "main",
      createdBranch: false,
      repoPath: "/repo",
    } satisfies Worktree);
    warmWorktreeBestEffortMock.mockResolvedValue(undefined);
    // Already caught up with the base by default — see the mock's own doc comment. Individual tests
    // that care about the premerge itself override this.
    isAncestorMock.mockResolvedValue(true);
    mergeIntoCurrentMock.mockResolvedValue({ conflicts: [] });
  });

  afterEach(() => {
    rmSync(worktreePath, { recursive: true, force: true });
  });

  const run = (settings: ProjectSettings) =>
    prepareFixWorktree({
      ctx: fakeCtx(),
      repo: "/repo",
      branch: "anton/fix-7",
      settings,
      baseBranch: "main",
      number: 7,
      claimOwner: "review-fix:job-test",
      expectedHeadSha: "",
      expectedBaseRefOid: undefined,
    });

  it("a review-fix gate failing on a module the lockfile declares", async () => {
    const settings = { warmCommand: "pnpm install --frozen-lockfile" } as ProjectSettings;

    await run(settings);

    expect(warmWorktreeBestEffortMock).toHaveBeenCalledTimes(1);
    const [warmedWorktree, , warmConfig] = warmWorktreeBestEffortMock.mock.calls[0]!;
    expect(warmedWorktree).toMatchObject({ path: worktreePath });
    expect(warmConfig).toEqual({ command: "pnpm install --frozen-lockfile", enabled: true });
  });

  it("a warm that throws still returns a usable worktree and the job proceeds", async () => {
    warmWorktreeBestEffortMock.mockRejectedValueOnce(new Error("install boom"));

    const result = await run({} as ProjectSettings);

    expect(result.worktree.path).toBe(worktreePath);
    expect(warmWorktreeBestEffortMock).toHaveBeenCalledTimes(1);
  });

  it("warming disabled by config does not install", async () => {
    const settings = { warmEnabled: false } as ProjectSettings;

    await run(settings);

    expect(warmWorktreeBestEffortMock).toHaveBeenCalledTimes(1);
    const [, , warmConfig] = warmWorktreeBestEffortMock.mock.calls[0]!;
    expect(warmConfig).toEqual({ command: undefined, enabled: false });
  });

  // anton-091jr review round 2 (chatgpt-codex-connector): a MERGEABLE-but-behind base commit can
  // change dependency metadata without `node_modules` reflecting it, because warming ran BEFORE the
  // base premerge landed. Re-warming after a clean (conflict-free) premerge closes that gap.
  it("re-warms after a clean base premerge lands, so the gates see the merged tree's dependencies", async () => {
    isAncestorMock.mockResolvedValue(false); // behind the base → premergeBase actually merges
    mergeIntoCurrentMock.mockResolvedValue({ conflicts: [] }); // clean auto-merge, no conflicts
    const settings = { warmCommand: "pnpm install --frozen-lockfile" } as ProjectSettings;

    await run(settings);

    expect(warmWorktreeBestEffortMock).toHaveBeenCalledTimes(2);
    for (const call of warmWorktreeBestEffortMock.mock.calls) {
      expect(call[0]).toMatchObject({ path: worktreePath });
      expect(call[2]).toEqual({ command: "pnpm install --frozen-lockfile", enabled: true });
    }
  });

  it("does NOT re-warm when the base premerge lands conflicts still needing resolution", async () => {
    isAncestorMock.mockResolvedValue(false);
    mergeIntoCurrentMock.mockResolvedValue({ conflicts: ["src/a.ts"] });
    const settings = { warmCommand: "pnpm install --frozen-lockfile" } as ProjectSettings;

    const result = await run(settings);

    expect(result.conflicts).toEqual(["src/a.ts"]);
    expect(warmWorktreeBestEffortMock).toHaveBeenCalledTimes(1);
  });

  it("does NOT re-warm when the branch is already caught up with the base (no merge to do)", async () => {
    isAncestorMock.mockResolvedValue(true);
    const settings = { warmCommand: "pnpm install --frozen-lockfile" } as ProjectSettings;

    await run(settings);

    expect(warmWorktreeBestEffortMock).toHaveBeenCalledTimes(1);
    // The one `mergeIntoCurrent` call is the unconditional origin/<branch> sync; premergeBase's own
    // merge is never attempted once `isAncestor` says the base is already caught up.
    expect(mergeIntoCurrentMock).toHaveBeenCalledTimes(1);
  });

  // PR #338 review, chatgpt-codex-connector, round 3: `headSynced` (now `refsSynced`) used to check
  // only the worktree's own head, so a `fetchOrigin` that fetched the head branch fine but silently
  // failed for the base branch still reported "synced" — the premerge then ran against a STALE
  // `origin/<baseBranch>`, yet the fingerprint got persisted as if the PR's advertised base had
  // actually been tested.
  describe("refsSynced also verifies the fetched base ref against pr.baseRefOid", () => {
    const runWithBase = (expectedBaseRefOid: string | undefined) =>
      prepareFixWorktree({
        ctx: fakeCtx(),
        repo: "/repo",
        branch: "anton/fix-7",
        settings: {} as ProjectSettings,
        baseBranch: "main",
        number: 7,
        claimOwner: "review-fix:job-test",
        expectedHeadSha: "", // isolate the assertion to the base-ref half of the check
        expectedBaseRefOid,
      });

    it("is true when the fetched origin/<base> resolves to the PR's reported baseRefOid", async () => {
      resolveCommitShaMock.mockResolvedValue("base-sha-current");

      const result = await runWithBase("base-sha-current");

      expect(result.refsSynced).toBe(true);
    });

    it("is false when origin/<base> resolves to a STALE sha (fetchOrigin silently failed for it)", async () => {
      resolveCommitShaMock.mockResolvedValue("base-sha-stale");

      const result = await runWithBase("base-sha-current");

      expect(result.refsSynced).toBe(false);
    });

    it("is false when resolving origin/<base> fails outright", async () => {
      resolveCommitShaMock.mockRejectedValue(new Error("unknown revision"));

      const result = await runWithBase("base-sha-current");

      expect(result.refsSynced).toBe(false);
    });

    it("trusts the sync unconditionally when the caller has no baseRefOid to verify against", async () => {
      resolveCommitShaMock.mockResolvedValue("whatever-it-resolves-to");

      const result = await runWithBase(undefined);

      expect(result.refsSynced).toBe(true);
    });

    it("trusts the sync unconditionally when there is no baseBranch at all (nothing gets premerged)", async () => {
      resolveCommitShaMock.mockResolvedValue("irrelevant");

      const result = await prepareFixWorktree({
        ctx: fakeCtx(),
        repo: "/repo",
        branch: "anton/fix-7",
        settings: {} as ProjectSettings,
        baseBranch: undefined,
        number: 7,
        claimOwner: "review-fix:job-test",
        expectedHeadSha: "",
        expectedBaseRefOid: "base-sha-current",
      });

      expect(result.refsSynced).toBe(true);
      expect(resolveCommitShaMock).not.toHaveBeenCalled();
    });
  });

  // PR #338 review, chatgpt-codex-connector, round 4: the resume path (anton-2wklm) leaves unpushed
  // operator/prior-attempt commits on the local branch, so the ff-only sync above is a no-op and
  // `syncedHead` legitimately sits ahead of `expectedHeadSha` rather than equal to it. Treating that
  // as unsynced deleted the job's attempt identity every pass, so a parked gate could never be
  // matched by a later sweep.
  describe("refsSynced treats a descendant checkout as synced, not just an exact match", () => {
    // `readWorktreeState` is real (only `git/ops` functions named in the mock above are stubbed) and
    // `worktreePath` is a plain temp dir, not a real git repo, so it always resolves to "" here —
    // `isAncestorMock` is what stands in for "is the checkout ahead of `expectedHeadSha`".
    const runWithHead = (expectedHeadSha: string) =>
      prepareFixWorktree({
        ctx: fakeCtx(),
        repo: "/repo",
        branch: "anton/fix-7",
        settings: {} as ProjectSettings,
        baseBranch: "main",
        number: 7,
        claimOwner: "review-fix:job-test",
        expectedHeadSha,
        expectedBaseRefOid: undefined, // isolate the assertion to the head half of the check
      });

    it("is true when the checkout is a descendant of expectedHeadSha (not equal to it)", async () => {
      isAncestorMock.mockResolvedValue(true); // stands in for both premergeBase's own check and this one

      const result = await runWithHead("expected-head-sha");

      expect(result.refsSynced).toBe(true);
      expect(isAncestorMock).toHaveBeenCalledWith(worktreePath, "expected-head-sha", "");
    });

    it("is false when the checkout is neither equal to nor a descendant of expectedHeadSha", async () => {
      isAncestorMock.mockResolvedValue(false);

      const result = await runWithHead("expected-head-sha");

      expect(result.refsSynced).toBe(false);
    });

    it("is false when the ancestry check itself fails outright", async () => {
      isAncestorMock.mockRejectedValue(new Error("not a git repo"));

      const result = await runWithHead("expected-head-sha");

      expect(result.refsSynced).toBe(false);
    });
  });

  // PR #338 review, chatgpt-codex-connector, round 4: a fetched head/base that both match GitHub
  // exactly are still not "synced" if `premergeBase` then fails outright (a transient git error, a
  // hook failure) — the advertised base tree never actually landed in the tree the gates ran
  // against, so persisting an attempt fingerprint would misrepresent that revision as tested.
  describe("refsSynced folds in a failed (not just conflicting) base premerge", () => {
    it("is false when the base merge fails outright, even though the fetched refs matched", async () => {
      isAncestorMock.mockResolvedValue(false); // behind the base → premergeBase actually merges
      mergeIntoCurrentMock.mockRejectedValue(new Error("hook failed"));

      const result = await run({} as ProjectSettings); // expectedHeadSha/BaseRefOid unset → trivially matched

      expect(result.refsSynced).toBe(false);
      expect(result.conflicts).toEqual([]);
    });

    it("stays true when the base merge succeeds cleanly", async () => {
      isAncestorMock.mockResolvedValue(false);
      mergeIntoCurrentMock.mockResolvedValue({ conflicts: [] });

      const result = await run({} as ProjectSettings);

      expect(result.refsSynced).toBe(true);
    });
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
    baseRefName: "main",
    headSha: `sha-${number}`,
    url: `https://example.test/pull/${number}`,
    reviews: [],
    failingChecks: [],
    failingCheckAttempts: [],
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

  // anton-bzm7s: a parked job at the SAME head must suppress re-dispatch — and the pass's own note
  // must let an operator tell that suppressed target apart from a merely-idle one (a clean PR that
  // never reaches this branch at all, and so never contributes to either count).
  it("suppresses a target parked at the current PR head, and says so distinctly from an idle target", async () => {
    listMock.mockResolvedValue([target("e-1", 1), target("e-2", 2)]);
    getPrReviewMock.mockImplementation(async (_repo: string, number: number) =>
      number === 1 ? openPr(1, { reviewDecision: "CHANGES_REQUESTED" }) : openPr(2), // e-2 stays clean
    );

    await dispatch();
    t.db
      .update(schema.jobs)
      .set({ status: "parked" })
      .where(eq(schema.jobs.type, "review-fix-pr"))
      .run();

    const job = await getJob(t.db, await dispatch());
    expect(dispatchedTargets()).toEqual(["e-1"]); // still the one row from the first pass
    expect(job?.outcomeNote).toBe(
      "examined 2 PR(s) in review, dispatched 0, suppressed 1 (parked, unchanged head)",
    );
  });

  it("admits a fresh job once the PR head SHA moves past a parked attempt", async () => {
    listMock.mockResolvedValue([target("e-1", 1)]);
    getPrReviewMock.mockResolvedValue(openPr(1, { reviewDecision: "CHANGES_REQUESTED" }));

    await dispatch();
    t.db
      .update(schema.jobs)
      .set({ status: "parked" })
      .where(eq(schema.jobs.type, "review-fix-pr"))
      .run();

    getPrReviewMock.mockResolvedValue(
      openPr(1, { reviewDecision: "CHANGES_REQUESTED", headSha: "sha-new" }),
    );
    await dispatch();
    const rows = t.db.select().from(schema.jobs).where(eq(schema.jobs.type, "review-fix-pr")).all();
    expect(rows).toHaveLength(2);
    expect(rows.some((r) => r.status === "queued")).toBe(true);
  });

  /** A `done` row simulating an answered round (anton-dfuvz) — what actually settles it is out of this suite's scope. */
  const markAnswered = (epicBeadId: string, headSha: string, answeredFingerprint: string[]) =>
    t.db
      .update(schema.jobs)
      .set({
        status: "done",
        payloadJson: JSON.stringify({ projectId: t.projectId, epicBeadId, headSha, answeredFingerprint }),
      })
      .where(eq(schema.jobs.type, "review-fix-pr"))
      .run();

  // anton-dfuvz: checks no code change can satisfy (a PR-body waiver line, a CI check stuck
  // re-evaluating the same commit) keep classifyReview actionable forever — a fixer session that
  // answered the feedback without pushing must not be handed a fresh one every scheduled pass.
  it("suppresses a target that answered at the current PR head with unchanged reasons, and says so distinctly", async () => {
    listMock.mockResolvedValue([target("e-1", 1), target("e-2", 2)]);
    getPrReviewMock.mockImplementation(async (_repo: string, number: number) =>
      number === 1 ? openPr(1, { reviewDecision: "CHANGES_REQUESTED" }) : openPr(2), // e-2 stays clean
    );

    await dispatch();
    markAnswered("e-1", "sha-1", ["changes requested by a reviewer", "base:unknown"]);

    const job = await getJob(t.db, await dispatch());
    expect(dispatchedTargets()).toEqual(["e-1"]); // still the one row from the first pass
    expect(job?.outcomeNote).toBe(
      "examined 2 PR(s) in review, dispatched 0, suppressed 1 (answered, unchanged)",
    );
  });

  it("admits a fresh job once the PR head moves past an answered attempt, even with unchanged reasons", async () => {
    listMock.mockResolvedValue([target("e-1", 1)]);
    getPrReviewMock.mockResolvedValue(openPr(1, { reviewDecision: "CHANGES_REQUESTED" }));

    await dispatch();
    markAnswered("e-1", "sha-1", ["changes requested by a reviewer"]);

    getPrReviewMock.mockResolvedValue(
      openPr(1, { reviewDecision: "CHANGES_REQUESTED", headSha: "sha-new" }),
    );
    await dispatch();
    const rows = t.db.select().from(schema.jobs).where(eq(schema.jobs.type, "review-fix-pr")).all();
    expect(rows).toHaveLength(2);
    expect(rows.some((r) => r.status === "queued")).toBe(true);
  });

  it("admits a fresh job once a new unresolved review thread appears, even at the unchanged head", async () => {
    listMock.mockResolvedValue([target("e-1", 1)]);
    getPrReviewMock.mockResolvedValue(openPr(1, { reviewDecision: "CHANGES_REQUESTED" }));

    await dispatch();
    markAnswered("e-1", "sha-1", ["changes requested by a reviewer"]);

    getPrReviewMock.mockResolvedValue(
      openPr(1, {
        reviewDecision: "CHANGES_REQUESTED",
        threads: [
          {
            id: "RT_new",
            isResolved: false,
            isOutdated: false,
            comments: [{ id: 1, author: "alice", body: "one more thing" }],
          },
        ],
      }),
    );
    await dispatch();
    const rows = t.db.select().from(schema.jobs).where(eq(schema.jobs.type, "review-fix-pr")).all();
    expect(rows).toHaveLength(2);
    expect(rows.some((r) => r.status === "queued")).toBe(true);
  });

  // anton-091jr review (chatgpt-codex-connector): a reviewer's new reply on the SAME thread anton
  // already answered must not be swallowed by a stale answered row just because the coarse thread
  // COUNT is unchanged — the fingerprint has to key on the thread's actual comment identity.
  it("admits a fresh job when a reviewer replies again on an already-answered thread, even with the same thread count and head", async () => {
    listMock.mockResolvedValue([target("e-1", 1)]);
    const threadWithComment = (commentId: number) => ({
      id: "RT_1",
      isResolved: false,
      isOutdated: false,
      comments: [{ id: commentId, author: "alice", body: "please fix" }],
    });
    getPrReviewMock.mockResolvedValue(openPr(1, { threads: [threadWithComment(1)] }));

    await dispatch();
    // What classifyReview's fingerprint actually stores for one thread whose last comment is #1.
    markAnswered("e-1", "sha-1", ["thread:RT_1:1"]);

    // Same head, same thread, but the reviewer posted a NEW comment on it — still 1 unresolved
    // thread by count, but a different fingerprint.
    getPrReviewMock.mockResolvedValue(openPr(1, { threads: [threadWithComment(2)] }));
    await dispatch();
    const rows = t.db.select().from(schema.jobs).where(eq(schema.jobs.type, "review-fix-pr")).all();
    expect(rows).toHaveLength(2);
    expect(rows.some((r) => r.status === "queued")).toBe(true);
  });

  it("admits a fresh job for a MERGED target even though a prior answered attempt matches its head", async () => {
    listMock.mockResolvedValue([target("e-1", 1)]);
    getPrReviewMock.mockResolvedValue(openPr(1, { reviewDecision: "CHANGES_REQUESTED" }));

    await dispatch();
    markAnswered("e-1", "sha-1", ["changes requested by a reviewer"]);

    // Merged, same head as the stale answered round — classifyReview never runs for it, so it
    // carries no `reasons` and the answered check (which requires both) never applies.
    getPrReviewMock.mockResolvedValue(openPr(1, { state: "MERGED" }));
    const job = await getJob(t.db, await dispatch());
    const rows = t.db.select().from(schema.jobs).where(eq(schema.jobs.type, "review-fix-pr")).all();
    expect(rows).toHaveLength(2);
    expect(rows.some((r) => r.status === "queued")).toBe(true);
    expect(job?.outcomeNote).toBe("examined 1 PR(s) in review, dispatched 1");
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

/**
 * The calibration reaction (anton-iwum0): each triaged finding's anchor comment gets a reaction
 * mirroring its outcome, alongside the existing reply. `applyThreadOutcomes` is exercised directly
 * against a fake `gh` binary — real `replyToReviewComment` / `reactToReviewComment` /
 * `resolveReviewThread` run, and every invocation is logged so a test can assert on it.
 */
describe("applyThreadOutcomes (reactions)", () => {
  let sandbox: string;
  let binDir: string;
  let logFile: string;
  let prevGh: string | undefined;
  let prevFail: string | undefined;
  let prevFailReplies: string | undefined;

  /** Fake gh: answers `repo view`, and logs every other invocation's argv as one JSON line. Fails
   * any call touching `/reactions` when ANTON_TEST_FAIL_REACTIONS=1, or `/replies` when
   * ANTON_TEST_FAIL_REPLIES=1, so each leg's best-effort contract can be proven without a real
   * network failure. */
  function installFakeGh(): void {
    const fakeGh = join(binDir, "gh");
    writeFileSync(
      fakeGh,
      `#!/usr/bin/env node
const fs = require('fs');
const a = process.argv.slice(2);
if (a[0] === 'repo' && a[1] === 'view') { process.stdout.write('o/r\\n'); process.exit(0); }
fs.appendFileSync(process.env.ANTON_TEST_GH_LOG, JSON.stringify(a) + '\\n');
if (process.env.ANTON_TEST_FAIL_REACTIONS === '1' && a.some((x) => x.includes('/reactions'))) {
  process.stderr.write('boom');
  process.exit(1);
}
if (process.env.ANTON_TEST_FAIL_REPLIES === '1' && a.some((x) => x.includes('/replies'))) {
  process.stderr.write('boom');
  process.exit(1);
}
process.exit(0);
`,
    );
    chmodSync(fakeGh, 0o755);
  }

  /** Every gh invocation logged so far, as argv arrays. */
  const ghCalls = (): string[][] =>
    readFileSync(logFile, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as string[]);

  function thread(overrides: Partial<ReviewThread> = {}): ReviewThread {
    return {
      id: "RT_1",
      isResolved: false,
      isOutdated: false,
      path: "src/a.ts",
      line: 3,
      comments: [{ id: 100, author: "alice", body: "please fix" }],
      ...overrides,
    };
  }

  function pr(threads: ReviewThread[]): PrReview {
    return {
      number: 7,
      state: "OPEN",
      reviewDecision: "CHANGES_REQUESTED",
      mergeable: "MERGEABLE",
      headRefName: "anton/epic-1",
      baseRefName: "main",
      headSha: "sha1",
      url: "https://github.com/o/r/pull/7",
      reviews: [],
      failingChecks: [],
      failingCheckAttempts: [],
      pendingChecks: 0,
      threads,
    };
  }

  const run = (report: ThreadOutcome[], threads: ReviewThread[], pushed: boolean) =>
    applyThreadOutcomes({
      repo: sandbox,
      number: 7,
      pr: pr(threads),
      report,
      pushed,
      signal: new AbortController().signal,
      logPath: join(sandbox, "session.log"),
    });

  beforeEach(() => {
    sandbox = mkdtempSync(join(tmpdir(), "anton-thread-outcomes-"));
    binDir = join(sandbox, "bin");
    mkdirSync(binDir);
    logFile = join(sandbox, "gh-calls.log");
    writeFileSync(logFile, "");
    installFakeGh();
    prevGh = process.env[GH_BIN_ENV];
    prevFail = process.env.ANTON_TEST_FAIL_REACTIONS;
    prevFailReplies = process.env.ANTON_TEST_FAIL_REPLIES;
    process.env[GH_BIN_ENV] = join(binDir, "gh");
    process.env.ANTON_TEST_GH_LOG = logFile;
    delete process.env.ANTON_TEST_FAIL_REACTIONS;
    delete process.env.ANTON_TEST_FAIL_REPLIES;
  });

  afterEach(() => {
    if (prevGh === undefined) delete process.env[GH_BIN_ENV];
    else process.env[GH_BIN_ENV] = prevGh;
    if (prevFail === undefined) delete process.env.ANTON_TEST_FAIL_REACTIONS;
    else process.env.ANTON_TEST_FAIL_REACTIONS = prevFail;
    if (prevFailReplies === undefined) delete process.env.ANTON_TEST_FAIL_REPLIES;
    else process.env.ANTON_TEST_FAIL_REPLIES = prevFailReplies;
    delete process.env.ANTON_TEST_GH_LOG;
    rmSync(sandbox, { recursive: true, force: true });
  });

  it("reacts +1 on a fixed finding's anchor comment, and resolves the thread", async () => {
    await run([{ id: "RT_1", outcome: "fixed", reply: "renamed foo to bar" }], [thread()], true);

    const reaction = ghCalls().find((c) => c.some((x) => x.includes("/reactions")));
    expect(reaction).toBeDefined();
    expect(reaction!.join(" ")).toContain("repos/o/r/pulls/comments/100/reactions");
    expect(reaction).toContain("content=+1");
    expect(ghCalls().some((c) => c.some((x) => x.includes("mutation")))).toBe(true);
    const reply = ghCalls().find((c) => c.some((x) => x.includes("/replies")));
    expect(reply).toBeDefined();
  });

  it("reacts -1 on a declined (left) finding's anchor comment, without resolving the thread", async () => {
    await run([{ id: "RT_1", outcome: "left", reply: "style-only, skipped" }], [thread()], true);

    const reaction = ghCalls().find((c) => c.some((x) => x.includes("/reactions")));
    expect(reaction).toBeDefined();
    expect(reaction).toContain("content=-1");
    // no resolveReviewThread mutation for a left thread
    expect(ghCalls().some((c) => c.some((x) => x.includes("mutation")))).toBe(false);
    const reply = ghCalls().find((c) => c.some((x) => x.includes("/replies")));
    expect(reply).toBeDefined();
  });

  it("reacts eyes on a needs-human finding — handled explicitly, distinct from fixed/left", async () => {
    await run([{ id: "RT_1", outcome: "needs-human", reply: "needs a product call" }], [thread()], true);

    const reaction = ghCalls().find((c) => c.some((x) => x.includes("/reactions")));
    expect(reaction).toContain("content=eyes");
  });

  it("posts no reaction (and no reply) for a fabricated fix — claimed fixed with nothing pushed", async () => {
    await run([{ id: "RT_1", outcome: "fixed", reply: "renamed foo to bar" }], [thread()], false);

    expect(ghCalls()).toEqual([]);
  });

  it("a reaction failure is best-effort — the reply still lands, and the thread counts as answered", async () => {
    process.env.ANTON_TEST_FAIL_REACTIONS = "1";

    const answered = await run(
      [{ id: "RT_1", outcome: "fixed", reply: "renamed foo to bar" }],
      [thread()],
      true,
    );
    expect(answered).toEqual(new Set(["RT_1"]));

    const reply = ghCalls().find((c) => c.some((x) => x.includes("/replies")));
    expect(reply).toBeDefined();
  });

  it("a reply-delivery failure is NOT answered — even though the report named the thread", async () => {
    process.env.ANTON_TEST_FAIL_REPLIES = "1";

    const answered = await run(
      [{ id: "RT_1", outcome: "left", reply: "style-only, skipped" }],
      [thread()],
      true,
    );
    expect(answered.size).toBe(0);
  });
});

/**
 * `allWaitingThreadsAnswered` gates `recordReviewFixAnswered` in both the main dispatch path and the
 * already-ahead fast path (PR #338 review, chatgpt-codex-connector + @claude): a round must not be
 * recorded "answered" on anything less than real, delivered evidence for every reason it was
 * actionable for, thread or not.
 */
describe("allWaitingThreadsAnswered", () => {
  it("requires the non-thread sentinel when hasNonThreadReasons is true, even with no waiting threads", () => {
    expect(allWaitingThreadsAnswered(new Set(), new Set(), [], true, false)).toBe(false);
  });

  it("accepts a 'left' sentinel as real evidence for a non-thread reason", () => {
    const report: ThreadOutcome[] = [{ id: NON_THREAD_REPORT_ID, outcome: "left", reply: "flaky infra" }];
    expect(allWaitingThreadsAnswered(new Set(), new Set(), report, true, false)).toBe(true);
  });

  it("rejects a 'fixed' sentinel when nothing was pushed — a fabricated claim", () => {
    const report: ThreadOutcome[] = [{ id: NON_THREAD_REPORT_ID, outcome: "fixed", reply: "fixed the build" }];
    expect(allWaitingThreadsAnswered(new Set(), new Set(), report, true, false)).toBe(false);
  });

  it("rejects a 'needs-human' sentinel — nothing ever posts it anywhere a human would see it", () => {
    const report: ThreadOutcome[] = [
      { id: NON_THREAD_REPORT_ID, outcome: "needs-human", reply: "needs a product call" },
    ];
    // Even with a push, and even with every real thread answered, a needs-human sentinel must never
    // count as evidence the non-thread reason was actually handled.
    expect(allWaitingThreadsAnswered(new Set(), new Set(), report, true, true)).toBe(false);
    expect(allWaitingThreadsAnswered(new Set(["RT_1"]), new Set(["RT_1"]), report, true, true)).toBe(
      false,
    );
  });

  it("a real thread's own delivered needs-human reply still counts — only the sentinel is rejected", () => {
    // No non-thread reason here: `hasNonThreadReasons` is false, so only the per-thread evidence
    // matters, and a delivered reply (whatever its outcome) satisfies it.
    expect(allWaitingThreadsAnswered(new Set(["RT_1"]), new Set(["RT_1"]), [], false, false)).toBe(true);
  });

  it("ignores hasNonThreadReasons once something was pushed (caller only consults this when !pushed)", () => {
    // The fast path in runFixSession only calls this to decide the unpushed case; it short-circuits
    // on `pushed` itself before ever reaching here. This spec pins that this function alone does not
    // — `pushed` here only feeds `fabricatedFix`'s own check on the sentinel.
    const report: ThreadOutcome[] = [{ id: NON_THREAD_REPORT_ID, outcome: "fixed", reply: "fixed it" }];
    expect(allWaitingThreadsAnswered(new Set(), new Set(), report, true, true)).toBe(true);
  });
});

/**
 * `fingerprintHasNonThreadReasons` feeds `allWaitingThreadsAnswered` as `hasNonThreadReasons` (PR
 * #338 review, chatgpt-codex-connector + @claude): `classifyReview` (src/lib/git/pr.ts) appends a
 * `base:<oid>` entry to every nonempty fingerprint as a pure cache-buster, not a real reason — a
 * thread-only round's fingerprint is `["thread:...", "base:..."]`, and treating that `base:` entry
 * as a non-thread reason would demand a `NON_THREAD_REPORT_ID` sentinel that never has anything real
 * to report, silently defeating the answered-unchanged suppression for the most common actionable
 * shape: a PR whose only feedback is inline review comments.
 */
describe("fingerprintHasNonThreadReasons", () => {
  it("is false for a thread-only fingerprint, even with the base cache-buster appended", () => {
    expect(fingerprintHasNonThreadReasons(["thread:RT_1:C_1", "base:sha-1"])).toBe(false);
  });

  it("is true when a real non-thread reason (a failing check) is present", () => {
    expect(fingerprintHasNonThreadReasons(["check:build", "base:sha-1"])).toBe(true);
  });

  it("is true for a bare merge-conflict reason with no thread/check entries", () => {
    expect(fingerprintHasNonThreadReasons(["merge conflicts with the base branch", "base:sha-1"])).toBe(
      true,
    );
  });

  it("is false for an empty fingerprint", () => {
    expect(fingerprintHasNonThreadReasons([])).toBe(false);
  });
});

/**
 * `refreshFixRoundsBody` (anton-te6nr) exercised directly against a fake `gh` binary — real
 * `readPullRequestBody` / `updatePullRequestBody` run, and every invocation is logged so a test can
 * assert on it. `nextFixRoundsRegion`'s content-building is covered at the unit level in
 * review-fix-body.test.ts; this spec is about when `gh` is (and is not) reached, and what happens
 * when it fails.
 */
describe("refreshFixRoundsBody (anton-te6nr)", () => {
  let sandbox: string;
  let binDir: string;
  let logFile: string;
  let bodyStore: string;
  let logPath: string;
  let prevGh: string | undefined;
  let prevFailRead: string | undefined;
  let prevFailWrite: string | undefined;

  /** Fake gh: `pr view --json body` reads `bodyStore`, `pr edit --body` overwrites it. Each call is
   * logged as one JSON argv line so a test can assert exactly what (and how often) gh was reached.
   * Either leg can be made to fail via an env toggle, to prove the best-effort contract. */
  function installFakeGh(): void {
    const fakeGh = join(binDir, "gh");
    writeFileSync(
      fakeGh,
      `#!/usr/bin/env node
const fs = require('fs');
const a = process.argv.slice(2);
fs.appendFileSync(process.env.ANTON_TEST_GH_LOG, JSON.stringify(a) + '\\n');
if (a[0] === 'pr' && a[1] === 'view') {
  if (process.env.ANTON_TEST_FAIL_BODY_READ === '1') { process.stderr.write('boom'); process.exit(1); }
  let body = '';
  try { body = fs.readFileSync(process.env.ANTON_TEST_BODY_STORE, 'utf8'); } catch {}
  process.stdout.write(JSON.stringify({ body }));
  process.exit(0);
}
if (a[0] === 'pr' && a[1] === 'edit') {
  if (process.env.ANTON_TEST_FAIL_BODY_WRITE === '1') { process.stderr.write('boom'); process.exit(1); }
  fs.writeFileSync(process.env.ANTON_TEST_BODY_STORE, a[a.indexOf('--body') + 1]);
  process.exit(0);
}
process.exit(0);
`,
    );
    chmodSync(fakeGh, 0o755);
  }

  const ghCalls = (): string[][] =>
    readFileSync(logFile, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as string[]);

  const sessionLog = (): string => {
    try {
      return readFileSync(logPath, "utf8");
    } catch {
      return "";
    }
  };

  const run = (report: ThreadOutcome[], pushed: boolean) =>
    refreshFixRoundsBody({
      repo: sandbox,
      number: 7,
      report,
      pushed,
      now: new Date("2026-09-23T12:00:00Z"),
      logPath,
    });

  beforeEach(() => {
    sandbox = mkdtempSync(join(tmpdir(), "anton-fix-rounds-body-"));
    binDir = join(sandbox, "bin");
    mkdirSync(binDir);
    logFile = join(sandbox, "gh-calls.log");
    bodyStore = join(sandbox, "body.txt");
    logPath = join(sandbox, "session.log");
    writeFileSync(logFile, "");
    writeFileSync(bodyStore, "Some narrative.\n");
    installFakeGh();
    prevGh = process.env[GH_BIN_ENV];
    prevFailRead = process.env.ANTON_TEST_FAIL_BODY_READ;
    prevFailWrite = process.env.ANTON_TEST_FAIL_BODY_WRITE;
    process.env[GH_BIN_ENV] = join(binDir, "gh");
    process.env.ANTON_TEST_GH_LOG = logFile;
    process.env.ANTON_TEST_BODY_STORE = bodyStore;
    delete process.env.ANTON_TEST_FAIL_BODY_READ;
    delete process.env.ANTON_TEST_FAIL_BODY_WRITE;
  });

  afterEach(() => {
    if (prevGh === undefined) delete process.env[GH_BIN_ENV];
    else process.env[GH_BIN_ENV] = prevGh;
    if (prevFailRead === undefined) delete process.env.ANTON_TEST_FAIL_BODY_READ;
    else process.env.ANTON_TEST_FAIL_BODY_READ = prevFailRead;
    if (prevFailWrite === undefined) delete process.env.ANTON_TEST_FAIL_BODY_WRITE;
    else process.env.ANTON_TEST_FAIL_BODY_WRITE = prevFailWrite;
    delete process.env.ANTON_TEST_GH_LOG;
    delete process.env.ANTON_TEST_BODY_STORE;
    rmSync(sandbox, { recursive: true, force: true });
  });

  it("refreshes the PR body with a dated round after a pushing round", async () => {
    await run([{ id: "RT_1", outcome: "fixed", reply: "renamed foo to bar" }], true);

    expect(ghCalls().some((c) => c[0] === "pr" && c[1] === "view")).toBe(true);
    expect(ghCalls().some((c) => c[0] === "pr" && c[1] === "edit")).toBe(true);
    const written = readFileSync(bodyStore, "utf8");
    expect(written).toContain("Some narrative."); // everything outside the region survives
    expect(written).toContain("### Review-fix rounds");
    expect(written).toContain("- 2026-09-23: renamed foo to bar");
  });

  it("a round that pushes nothing does not call gh at all", async () => {
    await run([{ id: "RT_1", outcome: "fixed", reply: "would-be fix" }], false);

    expect(ghCalls()).toEqual([]);
    expect(readFileSync(bodyStore, "utf8")).toBe("Some narrative.\n"); // untouched
  });

  it("a round that fixed nothing worth naming does not call gh either", async () => {
    await run([{ id: "RT_1", outcome: "left", reply: "declined" }], true);

    expect(ghCalls()).toEqual([]);
  });

  it("a failed body read is logged and the round still completes successfully", async () => {
    process.env.ANTON_TEST_FAIL_BODY_READ = "1";

    await expect(
      run([{ id: "RT_1", outcome: "fixed", reply: "renamed foo to bar" }], true),
    ).resolves.toBeUndefined();

    expect(sessionLog()).toContain("could not read PR #7's body");
    // Never reached the write leg, since there was nothing to amend.
    expect(ghCalls().some((c) => c[0] === "pr" && c[1] === "edit")).toBe(false);
  });

  it("a failed body write is logged and the round still completes successfully", async () => {
    process.env.ANTON_TEST_FAIL_BODY_WRITE = "1";

    await expect(
      run([{ id: "RT_1", outcome: "fixed", reply: "renamed foo to bar" }], true),
    ).resolves.toBeUndefined();

    expect(sessionLog()).toContain("could not write the review-fix-rounds update");
    // The store was never overwritten — the failure left the PR body as gh last had it.
    expect(readFileSync(bodyStore, "utf8")).toBe("Some narrative.\n");
  });

  it("accumulates a second round onto the first, oldest first", async () => {
    await run([{ id: "RT_1", outcome: "fixed", reply: "first round fix" }], true);
    await run(
      [{ id: "RT_2", outcome: "fixed", reply: "second round fix" }],
      true,
    );

    const written = readFileSync(bodyStore, "utf8");
    const firstIdx = written.indexOf("first round fix");
    const secondIdx = written.indexOf("second round fix");
    expect(firstIdx).toBeGreaterThan(-1);
    expect(secondIdx).toBeGreaterThan(firstIdx);
  });
});

// anton-h0hwc: a review-fix session already ran and already committed everything it has
// authority over, so a red gate here can only be reproduced identically by a retry — poison it on
// attempt 1 instead of burning three attempts (fati-87h). A genuinely transient failure (abort,
// kill) must still retry.
describe("runTestGate (anton-h0hwc)", () => {
  let dir: string;
  let logPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "anton-review-fix-gate-test-"));
    logPath = join(dir, "session.log");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("resolves when every gate exits zero", async () => {
    const settings = { testCommand: "true" };
    await expect(
      runTestGate(settings, dir, new AbortController().signal, logPath, 7),
    ).resolves.toBeUndefined();
  });

  it("raises a PoisonError on the first attempt, naming the gate, its exit code and output tail", async () => {
    const settings = { testCommand: "echo boom-output && exit 3" };
    const err = await runTestGate(settings, dir, new AbortController().signal, logPath, 7).catch(
      (e) => e,
    );
    expect(err).toBeInstanceOf(PoisonError);
    // Opening sentence is unchanged — existing readers of this message keep working.
    expect(err.message.startsWith("tests gate failed after review-fix for PR #7 (exit 3)")).toBe(
      true,
    );
    expect(err.message).toContain("boom-output");
  });

  it("does not poison an aborted signal — the runner still retries it", async () => {
    const ac = new AbortController();
    const promise = runTestGate({ testCommand: "sleep 5" }, dir, ac.signal, logPath, 7);
    ac.abort();
    const err: unknown = await promise.catch((e) => e);
    expect(err).not.toBeInstanceOf(PoisonError);
    expect((err as { name?: string })?.name).toBe("AbortError");
  });
});

// anton-gvqk3: a gate parking the fix session must say so on the PR itself — the run-log entry
// runTestGate already produces is invisible to a human reading only the PR, who otherwise sees a
// stale CONFLICTING/CI badge and nothing about why anton stopped.
describe("notifyGateParked (anton-gvqk3)", () => {
  let sandbox: string;
  let binDir: string;
  let logFile: string;
  let storeFile: string;
  let prevGh: string | undefined;

  // Fake gh with just enough state to prove dedup: posted comment bodies persist to `storeFile`, and
  // `pr view --json comments` reads them back — so a second `notifyGateParked` call sees exactly what
  // the first one posted, the same way the real PR would.
  function installFakeGh(): void {
    const fakeGh = join(binDir, "gh");
    writeFileSync(
      fakeGh,
      `#!/usr/bin/env node
const fs = require('fs');
const a = process.argv.slice(2);
const store = process.env.ANTON_TEST_COMMENTS_STORE;
if (a[0] === 'repo' && a[1] === 'view') { process.stdout.write('o/r\\n'); process.exit(0); }
if (a[0] === 'pr' && a[1] === 'view' && a.includes('comments')) {
  let bodies = [];
  try { bodies = JSON.parse(fs.readFileSync(store, 'utf8')); } catch {}
  process.stdout.write(JSON.stringify({ comments: bodies.map((b) => ({ body: b })) }));
  process.exit(0);
}
if (a[0] === 'pr' && a[1] === 'comment') {
  const body = a[a.indexOf('--body') + 1];
  let bodies = [];
  try { bodies = JSON.parse(fs.readFileSync(store, 'utf8')); } catch {}
  bodies.push(body);
  fs.writeFileSync(store, JSON.stringify(bodies));
  fs.appendFileSync(process.env.ANTON_TEST_GH_LOG, JSON.stringify(a) + '\\n');
  process.exit(0);
}
process.exit(0);
`,
    );
    chmodSync(fakeGh, 0o755);
  }

  const ghCalls = (): string[][] =>
    readFileSync(logFile, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as string[]);

  const postedComments = () => ghCalls().filter((c) => c[0] === "pr" && c[1] === "comment");

  beforeEach(() => {
    sandbox = mkdtempSync(join(tmpdir(), "anton-notify-parked-"));
    binDir = join(sandbox, "bin");
    mkdirSync(binDir);
    logFile = join(sandbox, "gh-calls.log");
    storeFile = join(sandbox, "comments.json");
    writeFileSync(logFile, "");
    writeFileSync(storeFile, "[]");
    installFakeGh();
    prevGh = process.env[GH_BIN_ENV];
    process.env[GH_BIN_ENV] = join(binDir, "gh");
    process.env.ANTON_TEST_GH_LOG = logFile;
    process.env.ANTON_TEST_COMMENTS_STORE = storeFile;
  });

  afterEach(() => {
    if (prevGh === undefined) delete process.env[GH_BIN_ENV];
    else process.env[GH_BIN_ENV] = prevGh;
    delete process.env.ANTON_TEST_GH_LOG;
    delete process.env.ANTON_TEST_COMMENTS_STORE;
    rmSync(sandbox, { recursive: true, force: true });
  });

  it("posts exactly one comment naming the gate, starting with the anton marker", async () => {
    const error = new PoisonError(
      "tests gate failed after review-fix for PR #7 (exit 3)\n\nboom-output",
    );
    await notifyGateParked({
      repo: sandbox,
      number: 7,
      error,
      conflicts: ["src/a.ts"],
      signal: new AbortController().signal,
    });

    const posted = postedComments();
    expect(posted).toHaveLength(1);
    const body = posted[0]![posted[0]!.indexOf("--body") + 1]!;
    expect(body.startsWith(ANTON_MARK)).toBe(true);
    expect(body).toContain("tests gate failed after review-fix for PR #7");
    // Tells the reader the base merge is already resolved and committed locally, not just untouched.
    expect(body).toContain("resolved and committed locally");
  });

  it("omits the base-merge note when the park had no base-branch conflicts to resolve", async () => {
    const error = new PoisonError("tests gate failed after review-fix for PR #7 (exit 3)\n\nboom");
    await notifyGateParked({
      repo: sandbox,
      number: 7,
      error,
      conflicts: [],
      signal: new AbortController().signal,
    });

    const body = postedComments()[0]![postedComments()[0]!.indexOf("--body") + 1]!;
    expect(body).not.toContain("resolved and committed locally");
  });

  it("a resumed job parking on the same gate does not repost an identical comment", async () => {
    const error = new PoisonError(
      "tests gate failed after review-fix for PR #7 (exit 3)\n\nboom-output",
    );
    const args = {
      repo: sandbox,
      number: 7,
      error,
      conflicts: [] as string[],
      signal: new AbortController().signal,
    };

    await notifyGateParked(args);
    await notifyGateParked(args); // a resume hitting the same red gate a second time

    expect(postedComments()).toHaveLength(1);
  });

  it("a different gate failure on a later park still gets its own comment", async () => {
    await notifyGateParked({
      repo: sandbox,
      number: 7,
      error: new PoisonError("tests gate failed after review-fix for PR #7 (exit 3)\n\nboom"),
      conflicts: [],
      signal: new AbortController().signal,
    });
    await notifyGateParked({
      repo: sandbox,
      number: 7,
      error: new PoisonError("lint gate failed after review-fix for PR #7 (exit 1)\n\nbad style"),
      conflicts: [],
      signal: new AbortController().signal,
    });

    expect(postedComments()).toHaveLength(2);
  });
});
