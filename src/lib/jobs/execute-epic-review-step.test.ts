/**
 * The resume key (anton-qmuyt): a clean verdict is keyed to the tree it judged, so a resume that
 * recomputes the same key skips the gate — and a resume with no recorded key, or a mismatched one,
 * always reviews in full. Unit-tested against fakes, the same way execute-epic-run-phase's own
 * leaf behavior is (see execute-epic-run-phase.retirement.test.ts): no real git, bd, or claude.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Bead } from "../beads/bd";
import type { EpicRun } from "./execute-epic-run";
import type { RunPreparation } from "./execute-epic-prepare";
import type { RunPhaseCarry, RunStepDispatch } from "./execute-epic-run-step";
import type { ReviewFinding } from "./review-context";
import type { ReviewGateResult } from "./review-gate";
import type { ReviewKey } from "./review-key";

const updateRunMock = vi.fn();
const findRunReviewKeyForBranchMock = vi.fn();
const beadsNoteMock = vi.fn();
const computeReviewKeyMock = vi.fn<(...args: unknown[]) => Promise<ReviewKey>>();
const reviewKeyTokenMock = vi.fn<(key: ReviewKey) => string>();
const parseRecordedAdvisoriesMock = vi.fn<(raw: string | null | undefined) => ReviewFinding[]>();
const deferPassSessionMock = vi.fn();
const sessionLogMock = vi.fn(async () => {});
const sessionEndMock = vi.fn(async () => {});
const persistReviewScoresMock = vi.fn<(...args: unknown[]) => Promise<number | undefined>>();
const persistPartialReviewScoresMock = vi.fn<(...args: unknown[]) => Promise<number | undefined>>();
const resolveReviewConfigMock = vi.fn();
const reconcileOrphanPullRequestMock = vi.fn();
const resolveMergeBaseMock = vi.fn<(...args: unknown[]) => Promise<string>>();

vi.mock("../runs", async () => {
  const actual = await vi.importActual<typeof import("../runs")>("../runs");
  return {
    ...actual,
    updateRun: (...a: unknown[]) => updateRunMock(...a),
    findRunReviewKeyForBranch: (...a: unknown[]) => findRunReviewKeyForBranchMock(...a),
  };
});

vi.mock("../beads/bd", async () => {
  const actual = await vi.importActual<typeof import("../beads/bd")>("../beads/bd");
  return { ...actual, beads: { ...actual.beads, note: (...a: unknown[]) => beadsNoteMock(...a) } };
});

vi.mock("../projects", async () => {
  const actual = await vi.importActual<typeof import("../projects")>("../projects");
  return { ...actual, resolveReviewConfig: (...a: unknown[]) => resolveReviewConfigMock(...a) };
});

vi.mock("../git/ops", () => ({
  resolveMergeBase: (...a: unknown[]) => resolveMergeBaseMock(...a),
}));

vi.mock("./review-key", () => ({
  computeReviewKey: (...a: unknown[]) => computeReviewKeyMock(...a),
  reviewKeyToken: (...a: [ReviewKey]) => reviewKeyTokenMock(...a),
  parseRecordedAdvisories: (...a: [string | null | undefined]) => parseRecordedAdvisoriesMock(...a),
}));

vi.mock("./pass-preamble", () => ({
  deferPassSession: (...a: unknown[]) => deferPassSessionMock(...a),
}));

vi.mock("./execute-epic-review", async () => {
  const actual = await vi.importActual<typeof import("./execute-epic-review")>("./execute-epic-review");
  return {
    ...actual,
    reconcileOrphanPullRequest: (...a: unknown[]) => reconcileOrphanPullRequestMock(...a),
  };
});

vi.mock("./review-score", () => ({
  persistReviewScores: (...a: unknown[]) => persistReviewScoresMock(...a),
  persistPartialReviewScores: (...a: unknown[]) => persistPartialReviewScoresMock(...a),
}));

const { runReviewStep } = await import("./execute-epic-review-step");

const REPO = "/tmp/anton";
const TARGET = "anton-epic1";
const RUN_ID = "run-1";

function target(): Bead {
  return { id: TARGET, issue_type: "feature", status: "open", labels: [] } as unknown as Bead;
}

function epicRun(
  existing?: Partial<{ reviewKey: string | null; reviewKeyAdvisories: string | null; reviewScore: number | null }>,
): EpicRun {
  return {
    db: {},
    clock: { now: () => Date.now() },
    ctx: {},
    projectId: "p1",
    repo: REPO,
    runId: RUN_ID,
    targetId: TARGET,
    branch: `anton/${TARGET}`,
    settings: {},
    existing: existing
      ? { id: RUN_ID, reviewKey: null, reviewKeyAdvisories: null, reviewScore: null, ...existing }
      : undefined,
    orphanNotice: "",
  } as unknown as EpicRun;
}

function prep(): Extract<RunPreparation, { done: false }> {
  return {
    done: false,
    worktree: { path: "/tmp/anton-worktree", branch: `anton/${TARGET}`, baseBranch: "main" },
  } as unknown as Extract<RunPreparation, { done: false }>;
}

function dispatch(handler: (ctx: unknown) => Promise<unknown>): RunStepDispatch {
  return {
    cooked: { id: "step:review" },
    definition: { name: "review", handler },
    stepCtx: {
      worktreePath: "/tmp/anton-worktree",
      baseRef: "origin/main",
      tickets: [target()],
    },
  } as unknown as RunStepDispatch;
}

function carry(): RunPhaseCarry {
  return { advisories: [], staleBodyFallback: null };
}

function cleanResult(unresolved: ReviewFinding[] = []): ReviewGateResult {
  return {
    outcome: "clean",
    baseRev: "gate-pinned-base",
    rounds: [{ round: 1, reviewSessionId: "s1", blocking: 0, advisory: unresolved.length }],
    unresolved,
    reviewer: { kind: "default" },
    score: 9,
  };
}

function blockedResult(): ReviewGateResult {
  return {
    outcome: "unresolved",
    baseRev: "gate-pinned-base",
    rounds: [{ round: 1, reviewSessionId: "s1", blocking: 1, advisory: 0 }],
    unresolved: [{ severity: "blocking", location: "x.ts:1", note: "bad" }],
    reviewer: { kind: "default" },
    score: 2,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  resolveReviewConfigMock.mockReturnValue({ enabled: true, maxRounds: 2 });
  deferPassSessionMock.mockReturnValue({ log: sessionLogMock, end: sessionEndMock });
  persistReviewScoresMock.mockResolvedValue(undefined);
  persistPartialReviewScoresMock.mockResolvedValue(undefined);
  reconcileOrphanPullRequestMock.mockResolvedValue(undefined);
  resolveMergeBaseMock.mockResolvedValue("resolved-base");
  updateRunMock.mockResolvedValue(undefined);
  findRunReviewKeyForBranchMock.mockResolvedValue(undefined);
  beadsNoteMock.mockResolvedValue("");
});

describe("runReviewStep — resume key", () => {
  it("skips the gate when the resumed row's key matches the current tree", async () => {
    computeReviewKeyMock.mockResolvedValue({ baseRev: "base1", head: "head1", fingerprint: "fp1" });
    reviewKeyTokenMock.mockReturnValue("base1:head1:fp1");
    const recorded: ReviewFinding[] = [{ severity: "advisory", location: "y.ts:2", note: "nit" }];
    parseRecordedAdvisoriesMock.mockReturnValue(recorded);

    const handler = vi.fn();
    const run = epicRun({ reviewKey: "base1:head1:fp1", reviewKeyAdvisories: "[...]", reviewScore: 8 });
    const c = carry();

    await runReviewStep(run, prep(), dispatch(handler), c);

    expect(handler).not.toHaveBeenCalled();
    expect(c.advisories).toEqual(recorded);
    // `existing` on the row is consulted first — a branch-wide scan is unnecessary work when this
    // attempt resumed the very row that earned the verdict.
    expect(findRunReviewKeyForBranchMock).not.toHaveBeenCalled();
    expect(deferPassSessionMock).toHaveBeenCalledWith(
      run.db,
      run.clock,
      expect.objectContaining({ runId: RUN_ID, kind: "review-skip" }),
    );
    expect(sessionLogMock).toHaveBeenCalled();
    expect(sessionEndMock).toHaveBeenCalledWith("done");
    // The recorded attempt already owns the board labels — a skip touches neither. It DOES restore
    // the score onto this row (anton-nyz1v), since `openRunRow` reset it to null on resume and a
    // skip that left it there would read as an unreviewed gap to the score-regression breaker.
    expect(updateRunMock).toHaveBeenCalledTimes(1);
    expect(updateRunMock).toHaveBeenCalledWith(run.db, run.clock, RUN_ID, { reviewScore: 8 });
    expect(persistReviewScoresMock).not.toHaveBeenCalled();
  });

  it("skips the gate off a branch-scoped key when the retry opened a fresh row (anton-nyz1v)", async () => {
    // A git fault at step:pr settles the row `failed`, so the runner's retry finds no open run
    // (`existing` is undefined) even though it reuses the same branch and worktree an earlier
    // attempt already reviewed clean. The key must still be found — off the branch, not the row.
    computeReviewKeyMock.mockResolvedValue({ baseRev: "base5", head: "head5", fingerprint: "fp5" });
    reviewKeyTokenMock.mockReturnValue("base5:head5:fp5");
    const recorded: ReviewFinding[] = [{ severity: "advisory", location: "w.ts:1", note: "nit" }];
    parseRecordedAdvisoriesMock.mockReturnValue(recorded);
    findRunReviewKeyForBranchMock.mockResolvedValue({
      reviewKey: "base5:head5:fp5",
      reviewKeyAdvisories: "[...]",
      reviewScore: 7,
    });

    const handler = vi.fn();
    const run = epicRun(undefined);
    const c = carry();

    await runReviewStep(run, prep(), dispatch(handler), c);

    expect(findRunReviewKeyForBranchMock).toHaveBeenCalledWith(
      run.db,
      run.projectId,
      TARGET,
      run.branch,
      RUN_ID,
    );
    expect(handler).not.toHaveBeenCalled();
    expect(c.advisories).toEqual(recorded);
    expect(updateRunMock).toHaveBeenCalledWith(run.db, run.clock, RUN_ID, { reviewScore: 7 });
    expect(sessionEndMock).toHaveBeenCalledWith("done");
  });

  it("reviews in full when the recorded key no longer matches the tree", async () => {
    computeReviewKeyMock.mockResolvedValue({ baseRev: "base2", head: "head2", fingerprint: "fp2" });
    reviewKeyTokenMock.mockReturnValue("base2:head2:fp2");

    const handler = vi.fn(async () => ({ facts: { review: cleanResult() } }));
    const run = epicRun({ reviewKey: "base1:head1:fp1", reviewKeyAdvisories: null });

    await runReviewStep(run, prep(), dispatch(handler), carry());

    expect(handler).toHaveBeenCalledTimes(1);
    expect(deferPassSessionMock).not.toHaveBeenCalled();
  });

  it("reviews in full when the branch-scoped key no longer matches the tree", async () => {
    computeReviewKeyMock.mockResolvedValue({ baseRev: "base6", head: "head6", fingerprint: "fp6" });
    reviewKeyTokenMock.mockReturnValue("base6:head6:fp6");
    findRunReviewKeyForBranchMock.mockResolvedValue({
      reviewKey: "stale:key:fp",
      reviewKeyAdvisories: null,
      reviewScore: 3,
    });

    const handler = vi.fn(async () => ({ facts: { review: cleanResult() } }));
    const run = epicRun(undefined);

    await runReviewStep(run, prep(), dispatch(handler), carry());

    expect(handler).toHaveBeenCalledTimes(1);
    expect(deferPassSessionMock).not.toHaveBeenCalled();
  });

  it("reviews in full when the row carries no recorded key at all", async () => {
    computeReviewKeyMock.mockResolvedValue({ baseRev: "base4", head: "head4", fingerprint: "fp4" });
    reviewKeyTokenMock.mockReturnValue("base4:head4:fp4");
    const handler = vi.fn(async () => ({ facts: { review: cleanResult() } }));
    const run = epicRun(undefined);

    await runReviewStep(run, prep(), dispatch(handler), carry());

    expect(handler).toHaveBeenCalledTimes(1);
    // No key to compare against up front, so the gate ran unconditionally — the only call to
    // compute one is the clean verdict's OWN write below, not a resume-key check that skipped it.
    expect(computeReviewKeyMock).toHaveBeenCalledTimes(1);
    expect(deferPassSessionMock).not.toHaveBeenCalled();
  });

  it("persists the resume key and advisories on a clean verdict", async () => {
    computeReviewKeyMock.mockResolvedValue({ baseRev: "base3", head: "head3", fingerprint: "fp3" });
    reviewKeyTokenMock.mockReturnValue("base3:head3:fp3");
    const advisory: ReviewFinding = { severity: "advisory", location: "z.ts:3", note: "consider" };
    const handler = vi.fn(async () => ({ facts: { review: cleanResult([advisory]) } }));
    const run = epicRun(undefined);
    const c = carry();

    await runReviewStep(run, prep(), dispatch(handler), c);

    expect(c.advisories).toEqual([advisory]);
    // The resume key persisted for a clean verdict reuses the SHA the gate itself pinned and
    // judged against — never a fresh resolution of `baseRef`, which is a movable ref a sibling
    // run could have advanced between the verdict and this write (anton-nyz1v).
    expect(computeReviewKeyMock).toHaveBeenLastCalledWith(
      expect.objectContaining({ baseRev: "gate-pinned-base" }),
    );
    expect(updateRunMock).toHaveBeenCalledWith(run.db, run.clock, RUN_ID, {
      reviewKey: "base3:head3:fp3",
      reviewKeyAdvisories: JSON.stringify([advisory]),
    });
  });

  it("does not persist a resume key on a blocked verdict", async () => {
    const handler = vi.fn(async () => ({ facts: { review: blockedResult() } }));
    const run = epicRun(undefined);

    await expect(runReviewStep(run, prep(), dispatch(handler), carry())).rejects.toThrow();

    expect(computeReviewKeyMock).not.toHaveBeenCalled();
    expect(updateRunMock).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ reviewKey: expect.anything() }),
    );
  });
});
