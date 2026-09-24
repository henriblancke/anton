/**
 * review-fix (anton-3t2.2), in TWO job types since anton-3jwh:
 *
 *   • `review-fix` — the scheduled DISPATCHER. A cheap read: list the board, select the in-review
 *     run targets this operator owns, read each PR once (`gh`), and enqueue one `review-fix-pr` job
 *     per target that is MERGED or carries actionable feedback. It materializes no worktree, drives
 *     no claude session and runs no verify gates, so it finishes inside its own poll slot.
 *   • `review-fix-pr` — ONE PR, carried through the whole existing path: worktree claim, claude,
 *     verify gates, commit/push, thread replies, re-request review — then `beads.sync`, because it
 *     is the writer now.
 *
 * Splitting them is what makes PR feedback parallel. Before it, one sequential sweep carried every
 * PR: measured on anton's own history (10062 completed review-fix jobs), 505 sweeps outlived their
 * own 15-minute poll interval — each costing a skipped slot, because the scheduler coalesces on job
 * TYPE — and 7-PR sweeps averaged 45 minutes. A fix on one PR now delays no other PR's, and the
 * dispatcher's slot is never swallowed by the work it dispatched (the child carries its own type).
 *
 * For a project's in-review epics (open PR linked on the bead), the fix polls the PR via `gh` for
 * requested changes + failing CI; when actionable, it re-materializes the epic's worktree, dispatches
 * claude to resolve the feedback, commits, pushes, and re-requests review. See DESIGN §2/§4 and
 * git/pr.ts.
 *
 * The same path also finalizes MERGED PRs (anton-ner.5): a merged PR is terminal, so instead of
 * fixing review feedback the epic + its remaining open tickets move to done, `stage:in-review` is
 * cleared, and the merged branch/worktree + run row are cleaned up. A PR merely CLOSED (not merged)
 * is left alone. Living here — rather than in a new job type — means every existing project gets
 * merge finalization on its next poll without re-seeding schedules. What that finalization DOES is
 * review-fix-finalize.ts; this module decides when it runs (anton-qeir).
 *
 * HOW A MERGE IS LEARNED changed in anton-k0kj; what is DONE about it did not. execute-epic arms a
 * `gh:pr` gate on the target when it opens the PR, gate-check settles every merge wait in the
 * project with one `bd gate check`, and a closed gate dispatches a `review-fix-pr` job for that one
 * target — so the merge arrives as a board event instead of being discovered by re-reading every
 * open PR. The `pr.state === "MERGED"` branch below is unchanged and stays the executor of it.
 *
 * THE REVIEW-EVENT POLL SURVIVES, BY DESIGN. It is the one wait gates cannot replace: a `gh:pr` gate
 * resolves on MERGE and escalates on CLOSE, its whole GitHub read is `gh pr view <id> --json
 * state,title`, and bd offers no review-flavoured gate type at all (`--type` = human|timer|gh:run|
 * gh:pr). Requested changes, a new review comment and red CI are therefore invisible to the gate
 * model, so the periodic sweep below remains the trigger for them. See
 * .product/decisions/2026-08-02-pr-merge-as-gh-pr-gate.md.
 *
 * The dispatcher is enqueued per-project by the scheduler (a polling job): each run examines every
 * in-review epic once. Idempotent throughout — a PR with nothing actionable is not dispatched,
 * a target already covered by a queued/running `review-fix-pr` is not dispatched twice,
 * claude's fixes are plain commits on the existing branch (a re-run just pushes whatever is left),
 * and finalizing a merge clears `stage:in-review` so a later pass no longer treats the epic as
 * in-review (never finalized twice).
 */
import { existsSync } from "node:fs";
import { beads, labelValueOf, type Bead } from "../beads/bd";
import { metered } from "../claude-invocations";
import { claudeRouting, runClaude } from "../claude/driver";
import { quotaMeterKey } from "../quota-meter";
import { resolveModel } from "./model-routing";
import {
  branchAheadOfRemote,
  commitAll,
  isAncestor,
  readWorktreeState,
  fetchOrigin,
  mergeIntoCurrent,
  needsHooksPathOverrideForMerge,
  pushBranch,
  readPullRequestBody,
  resolveHooksPathOverride,
  resolveHooksPathOverrideForMerge,
  stageAll,
  updatePullRequestBody,
} from "../git/ops";
import {
  ANTON_MARK,
  classifyReview,
  commentOnPr,
  getPrComments,
  getPrReview,
  prNumberFromRef,
  reactToReviewComment,
  reRequestReview,
  replyToReviewComment,
  resolveReviewThread,
  reviewersRequestingChanges,
  threadsNeedingAttention,
  type Actionable,
  type PrReactionContent,
  type PrReview,
  type ReviewThread,
} from "../git/pr";
import {
  createWorktree,
  withWorktreeClaim,
  type Worktree,
} from "../git/worktree";
import { resolveOperator } from "../operator";
import {
  getProjectById,
  getProjectSettings,
  resolveCommitTimeoutMs,
  resolvePushTimeoutMs,
  resolveVerifyGates,
  type ProjectSettings,
} from "../projects";
import { captureVerifyGates } from "./shell";
import { tailLines } from "./review-context";
import { findOpenRunForEpic } from "../runs";
import { runTickets } from "../ticket-view";
import { appendSessionLog, endSession, startJobSession } from "../sessions";
import {
  buildReviewFixPrompt,
  fabricatedFix,
  parseThreadReport,
  type ThreadOutcome,
} from "./review-fix-context";
import { fixRoundFrom, nextFixRoundsRegion } from "./review-fix-body";
import { upsertBodyRegion } from "./steps/prompts";
import { IN_REVIEW } from "./review-fix-board";
import { safe } from "./safe";
import { finalizeMergedEpic } from "./review-fix-finalize";
import { isPoisonError, PoisonError } from "./errors";
import type { AntonDb, Clock } from "./queue";
import { systemClock } from "./queue";
import type { JobContext, JobEffect, JobHandler, RunnerLogger } from "./runner";

// The per-thread report parser is a review-fix protocol concern; re-export so existing importers
// (and unit tests) can keep reaching it via this module.
export { parseThreadReport, type ThreadOutcome } from "./review-fix-context";
// Merge finalization moved to its own module (anton-qeir); it is still reached through here.
export {
  finalizeMergedEpic,
  type FinalizeMergedEpicArgs,
} from "./review-fix-finalize";
export { undeliveredAtMerge } from "./review-fix-delivery";

export interface ReviewFixPayload {
  projectId: string;
  scheduleId?: string;
  /**
   * The run target this job is about. REQUIRED on a `review-fix-pr` job — it is the one PR being
   * fixed. On the dispatcher it is optional and narrows the fan-out to that one target (which is
   * also how a `review-fix` row queued by an older anton still reaches the new path).
   */
  epicBeadId?: string;
}

export interface ReviewFixDeps {
  db: AntonDb;
  clock?: Clock;
  branchPrefix?: string;
}

/** Handlers get no logger from the runner; fall back to console so swallowed errors are visible. */
const consoleLog: RunnerLogger = {
  info: (m, meta) => console.log(`[review-fix] ${m}`, meta ?? ""),
  error: (m, meta) => console.error(`[review-fix] ${m}`, meta ?? ""),
};

/**
 * Does the current operator own this epic? On a shared board an operator may only fix/finalize the
 * in-review PRs it claimed (or unclaimed ones) — never another operator's. Exported because
 * gate-check applies the SAME test before it dispatches a merged target by id: its discovery is the
 * shared board, so every instance sees the same closed gate, and a targeted dispatch bypasses the
 * filter below (anton-k0kj). `assignee` is the claim
 * execute-epic stamps (beads.claim → `bd update --claim`, actor = resolveOperator); unclaimed beads
 * carry null/absent/empty. resolveOperator resolves the same identity — down to bd's $USER fallback
 * (anton-g3v) — that stamped the claim, so a claim this instance made always matches. `operator`
 * is undefined only in the degenerate case where even $USER is unset; then nothing but unclaimed
 * epics match, so an anton that genuinely can't name itself never races a claimed PR.
 */
export function ownedByOperator(
  b: Bead,
  operator: string | undefined,
): boolean {
  const assignee = (b.assignee ?? undefined)?.trim() || undefined;
  if (!assignee) return true; // unclaimed — free to take
  return assignee === operator; // claimed-by-me; a different operator's claim is excluded
}

/**
 * In-review run targets = open run targets tagged stage:in-review that carry a PR external-ref,
 * filtered to the ones this operator may act on. A run target is a feature, a legacy epic with no
 * feature children, OR a standalone parentless task/bug (an epic-of-one) — each opens a PR and sits
 * in review until it merges, so each must be swept here. Classification reads the full list (`all`)
 * so a container epic someone PR-linked by hand is NOT swept: it has no PR of its own, and
 * `finalizeMergedEpic` would close its feature children on merge.
 * A standalone target has no children, so `handleEpic`/`finalizeMergedEpic` treat it as
 * an epic with an empty ticket set: fixing feedback runs against its PR branch as usual, and a merge
 * closes the bead itself. (Kept named `inReviewEpics` — the exported handle importers/tests use.)
 *
 * Ownership (anton-zoh): an epic is selected only when unclaimed OR claimed by `options.operator`;
 * a DIFFERENT operator's claim is excluded so two antons sharing a board never race the same PR. A
 * targeted `options.epicBeadId` (an explicit single-epic run) bypasses the ownership filter — an
 * operator asking for a specific epic gets it regardless of claim.
 */
export function inReviewEpics(
  all: Bead[],
  options: { operator?: string; epicBeadId?: string } = {},
): Bead[] {
  const { operator, epicBeadId } = options;
  return all.filter((b) => {
    if (
      !beads.isRunTarget(b, all) ||
      b.status === "closed" ||
      !(b.labels?.includes(IN_REVIEW) ?? false) ||
      prNumberFromRef(beads.getPrRef(b)) === undefined
    ) {
      return false;
    }
    if (epicBeadId) return b.id === epicBeadId; // targeted run — ownership bypassed
    return ownedByOperator(b, operator);
  });
}

/**
 * Who this job is, as the worktree claim records it. The same name goes to `createWorktree`, which
 * refuses to hand a claimed checkout to anyone but its holder.
 *
 * The job id is part of it because "review-fix" alone is not one holder: two anton instances sharing
 * a board can each hold a `review-fix-pr` job for the same target (jobs are machine-local, and a
 * gate-check dispatch by id reaches every instance that sees the closed gate), and a claim they
 * share is no claim at all — `conflictingClaim` only rejects a holder whose owner differs from the
 * caller, so the second job would reuse the checkout and interleave its fetch/merge/claude/commit/
 * push with the first's in one directory. Distinct owners make that the conflict it is; the readable
 * prefix keeps refusal logs legible.
 */
export function claimOwnerFor(jobId: string): string {
  return `review-fix#${jobId}`;
}

/** Build the DISPATCHER handler bound to a db/clock. Register it as the "review-fix" handler. */
export function makeReviewFixHandler(deps: ReviewFixDeps): JobHandler {
  const db = deps.db;
  return (ctx: JobContext) => dispatchInReview({ db, ctx });
}

/** Build the PER-PR handler bound to a db/clock. Register it as the "review-fix-pr" handler. */
export function makeReviewFixPrHandler(deps: ReviewFixDeps): JobHandler {
  const db = deps.db;
  const clock = deps.clock ?? systemClock;
  const branchPrefix = deps.branchPrefix ?? "anton";
  return (ctx: JobContext) => fixOnePr({ db, clock, branchPrefix, ctx });
}

/**
 * One dispatcher pass: triage every in-review PR this operator owns and hand each one that needs
 * work to its own job. Reads the board once and each PR once — no worktree, no claude, no gates —
 * so the pass costs seconds and always fits inside its poll slot.
 */
async function dispatchInReview(args: { db: AntonDb; ctx: JobContext }): Promise<JobEffect> {
  const { db, ctx } = args;
  const { projectId, epicBeadId } = ctx.payload as ReviewFixPayload;
  const project = await getProjectById(db, projectId);
  if (!project) throw new PoisonError(`project ${projectId} not found`);
  const repo = project.repoPath;

  const all = await beads.list(repo, ["--status", "all"]);
  // Scope the pass to epics this operator owns (anton-zoh): unclaimed or claimed-by-me, so a
  // shared board doesn't have two antons racing the same in-review PR. A targeted epicBeadId
  // (single-epic run) bypasses ownership — the operator explicitly asked for that epic. Identity
  // comes from the same resolveOperator that execute-epic claims with, so "mine" matches the claim.
  // The ownership test lives HERE, not in the per-PR job, because gate-check applies the same test
  // before dispatching a merged target by id (anton-k0kj).
  const operator = await resolveOperator();
  const targets = inReviewEpics(all, { operator, epicBeadId });
  if (targets.length === 0) return { changed: false, note: "nothing in review" };

  let dispatched = 0;
  let lastError: unknown;
  for (const target of targets) {
    await ctx.heartbeat();
    try {
      if (!(await needsFix(repo, target, ctx.signal))) continue;
      // Through the runner, not the queue helper: the `gh` read above yields, and a project delete
      // landing inside it must refuse this insert or teardown fails over the row (PR #250 review).
      if (ctx.enqueueReviewFixPr(projectId, target.id)) dispatched += 1;
    } catch (e) {
      // One unreadable PR must not cost the others their dispatch; the failure is surfaced below.
      lastError = e;
      consoleLog.error(`epic ${target.id}: triage failed; continuing fan-out`, e);
    }
  }

  // Surface the failure so the job retries/parks — but only after triaging every target, so a
  // reported pass never claims a clean sweep over a PR it could not actually read.
  if (lastError !== undefined) {
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  // The dispatch is the effect: an examined PR with nothing to do is a poll that correctly did
  // nothing, and the two counts together are what an operator checks the poll against.
  return {
    changed: dispatched > 0,
    note: `examined ${targets.length} PR(s) in review, dispatched ${dispatched}`,
  };
}

/**
 * Does this target need a fix job? MERGED (finalization is pending) or an actionable review —
 * anything else is a clean PR that costs nothing to leave alone. One `gh` read per target, the same
 * read `handleEpic` repeats when the dispatched job actually runs: PR state can change in between,
 * and the fix re-decides against what it finds rather than trusting this triage.
 */
async function needsFix(
  repo: string,
  target: Bead,
  signal: AbortSignal,
): Promise<boolean> {
  const number = prNumberFromRef(beads.getPrRef(target));
  if (number === undefined) return false;
  const pr = await getPrReview(repo, number, signal);
  return pr.state === "MERGED" || classifyReview(pr).actionable;
}

/**
 * One PR, carried the whole way. This is where the worktree, the claude session and the verify
 * gates live, so a long fix on this PR delays no other PR's — and, carrying its own job type, it
 * never suppresses the dispatcher's next scheduled slot.
 */
async function fixOnePr(args: {
  db: AntonDb;
  clock: Clock;
  branchPrefix: string;
  ctx: JobContext;
}): Promise<JobEffect> {
  const { db, clock, branchPrefix, ctx } = args;
  const { projectId, epicBeadId } = ctx.payload as ReviewFixPayload;
  if (!epicBeadId) {
    throw new PoisonError("review-fix-pr job has no epicBeadId — nothing to fix");
  }
  const project = await getProjectById(db, projectId);
  if (!project) throw new PoisonError(`project ${projectId} not found`);
  const repo = project.repoPath;
  const settings = await getProjectSettings(db, projectId);

  const all = await beads.list(repo, ["--status", "all"]);
  // Targeted, so ownership is bypassed exactly as it is today: whoever dispatched this job already
  // applied the test. A target that left review between dispatch and now is a clean no-op — the
  // fix landed, or a human closed it out.
  const [epic] = inReviewEpics(all, { epicBeadId });
  if (!epic) return { changed: false, note: `${epicBeadId} is no longer in review` };

  try {
    const outcome = await handleEpic({
      db,
      clock,
      ctx,
      repo,
      projectId,
      epic,
      settings,
      branchPrefix,
      baseBranch: settings.baseBranch ?? project.defaultBranch,
      all,
    });
    return { changed: outcome !== "clean", note: `${epic.id}: ${OUTCOME_NOTE[outcome]}` };
  } finally {
    // The claude session above may have written beads (notes, bd remember); push them. This job is
    // the writer now, so the sync moved here with the writes. Logged, not thrown — a sync hiccup
    // must not shadow (or fabricate) a fix failure, which is also why it runs on the failure path.
    await beads
      .sync(repo)
      .catch((e) => consoleLog.error("beads dolt sync failed after PR fix", e));
  }
}

/** What one PR's pass did — the note an operator reads off the jobs list. */
type PrFixOutcome = "merged" | "pushed" | "answered" | "clean";

const OUTCOME_NOTE: Record<PrFixOutcome, string> = {
  merged: "PR merged — finalized",
  pushed: "pushed a fix for the review feedback",
  // Claude produced no diff, but the threads it triaged were still answered — saying "fixed" here
  // would claim a push that never happened.
  answered: "answered the review feedback; nothing to push",
  clean: "nothing actionable on the PR",
};

async function handleEpic(args: {
  db: AntonDb;
  clock: Clock;
  ctx: JobContext;
  repo: string;
  projectId: string;
  epic: Bead;
  settings: ProjectSettings;
  branchPrefix: string;
  /** Base branch for conflict pre-merges (project setting, else the repo's default branch). */
  baseBranch: string | undefined;
  all: Bead[];
}): Promise<PrFixOutcome> {
  const {
    db,
    clock,
    ctx,
    repo,
    projectId,
    epic,
    settings,
    branchPrefix,
    baseBranch,
    all,
  } = args;
  const number = prNumberFromRef(beads.getPrRef(epic));
  if (number === undefined) return "clean";

  const pr = await getPrReview(repo, number, ctx.signal);
  const branch = pr.headRefName || `${branchPrefix}/${epic.id}`;

  // A merged PR is terminal — finalize the epic (done + cleanup) rather than fixing feedback. A PR
  // merely CLOSED (not merged) falls through to classifyReview, which treats any non-OPEN state as
  // not-actionable, so it is left untouched — PR ref and all, which is what a recovery re-run reads
  // (execute-epic step 0a). Its merge gate stays open for the same reason: bd never resolves a
  // gh:pr gate on a closed-unmerged PR, so nothing here or in gate-check can mistake it for done.
  if (pr.state === "MERGED") {
    await finalizeMergedEpic({
      db,
      clock,
      repo,
      projectId,
      epic,
      children: runTickets(all, epic.id),
      branch,
      all,
    });
    return "merged";
  }

  const verdict = classifyReview(pr);
  if (!verdict.actionable) return "clean"; // nothing to fix on this PR yet.

  // Claim the checkout for the whole fix. review-fix writes no run row, so without it the branch
  // reads as nobody's: the execute run's teardown (its bead is still open, so it releases the
  // worktree) would force-remove the directory claude is fixing in, discarding the fix and failing
  // the commit and push behind it.
  const claimOwner = claimOwnerFor(ctx.jobId);
  return withWorktreeClaim(repo, branch, claimOwner, async () => {
    // Re-materialize the worktree from the PR branch (execute-epic removes it after opening the
    // PR), sync it with origin, and pre-merge the base if GitHub reports a conflict.
    const { worktree, conflicts, alreadyAhead } = await prepareFixWorktree({
      ctx,
      repo,
      branch,
      settings,
      baseBranch,
      pr,
      number,
      claimOwner,
    });

    const pushed = await runFixSession({
      db,
      clock,
      ctx,
      repo,
      projectId,
      epic,
      settings,
      worktree,
      pr,
      verdict,
      conflicts,
      alreadyAhead,
      branch,
      number,
    });
    return pushed ? "pushed" : "answered";
  });
}

/**
 * Materialize the PR branch into a fresh worktree and get it ready for claude: fetch origin (a
 * reviewer may have pushed), fast-forward to the remote branch, and — when GitHub reports the PR
 * CONFLICTING — pre-merge the base so claude only has conflict markers to resolve. Every git step
 * is best-effort: a repo with no reachable origin still gets the review-comment flow.
 */
async function prepareFixWorktree(args: {
  ctx: JobContext;
  repo: string;
  branch: string;
  settings: ProjectSettings;
  /** Base branch for conflict pre-merges (project setting, else the repo's default branch). */
  baseBranch: string | undefined;
  pr: PrReview;
  number: number;
  /** This job's claim on the branch — createWorktree hands the checkout to nobody else. */
  claimOwner: string;
}): Promise<{ worktree: Worktree; conflicts: string[]; alreadyAhead: boolean }> {
  const { ctx, repo, branch, settings, baseBranch, pr, number, claimOwner } =
    args;

  const worktree = await createWorktree({
    repoPath: repo,
    branch,
    baseBranch: settings.baseBranch,
    warm: false,
    claimedBy: claimOwner,
  });
  // Fail loudly here rather than letting a missing worktree ride through the best-effort git steps
  // below — `safe()` swallows their errors, so the first thing to actually report the problem would
  // be `spawn <claude> ENOENT` from the cwd, which names the wrong culprit entirely (anton-2wvb).
  if (!existsSync(worktree.path)) {
    throw new Error(
      `PR #${number}: worktree for ${branch} is missing after creation (${worktree.path}) — refusing to run claude against a non-existent cwd`,
    );
  }
  await ctx.heartbeat();

  await safe(() =>
    fetchOrigin(worktree.path, baseBranch ? [baseBranch, branch] : [branch]),
  );

  // Override `core.hooksPath` for the fast-forward below ONLY when the incoming ref itself doesn't
  // carry it (see needsHooksPathOverrideForMerge) — a value resolved before this merge is either
  // exactly right (a generated directory like Husky's `.husky/_`, never tracked by any ref) or
  // guaranteed stale (a tracked directory the merge is about to introduce or change), and using it in
  // the wrong case silently skips or misfires this merge's own `post-merge` (PR #263 review, rounds
  // 6-8). The VALUE, once an override is needed, comes from resolveHooksPathOverrideForMerge rather
  // than resolveHooksPathOverride: the latter answers "what does the CURRENT checkout need", which
  // can pass for a submodule-backed hooksPath that is self-consistent right now but about to go stale
  // the instant this merge changes the gitlink — resolveHooksPathOverrideForMerge validates any
  // submodule substitute against the INCOMING ref specifically (PR #263 review, round 21).
  const syncRef = `origin/${branch}`;
  const syncHooksPath = (await needsHooksPathOverrideForMerge(repo, worktree.path, syncRef))
    ? await resolveHooksPathOverrideForMerge(repo, worktree.path, syncRef)
    : undefined;
  await safe(() =>
    mergeIntoCurrent(worktree.path, syncRef, { ffOnly: true, hooksPath: syncHooksPath }),
  );

  // Snapshot "ahead of origin" right after the fast-forward sync above and BEFORE the premerge
  // below — the premerge's own auto-merge commit (see its "clean auto-merge" comment) would
  // otherwise put the branch ahead for a reason that has nothing to do with a prior session's or
  // operator's own commits, and the caller uses this specifically to recognize THAT: a resume whose
  // branch already carries committed work (anton-2wklm).
  const alreadyAhead = await branchAheadOfRemote(repo, branch);

  // This premerge brings in a DIFFERENT ref than the sync above (`origin/${baseBranch}`, the PR's
  // base, not `origin/${branch}`), so it needs the identical incoming-ref-aware resolution — the
  // sync's own comment explains why resolveHooksPathOverride (answering "what does the CURRENT
  // checkout need") is wrong for a merge that hasn't run yet. An earlier round resolved this
  // premerge's override against the current checkout instead of `origin/${baseBranch}`, which is the
  // same bug in a new spot: a conflicting PR's base can introduce or advance a tracked hooks
  // directory/submodule the feature worktree doesn't have, and the stale current-checkout answer
  // would skip a newly-introduced `post-merge` or run an old submodule checkout `git merge` never
  // updates on its own (PR #263 review, round 30). `needsHooksPathOverrideForMerge` asks only whether
  // the incoming ref changes something about the hooksPath directory/submodule relative to the
  // current checkout — nothing in it assumes the resulting merge is fast-forward-only, so it applies
  // equally to this non-`ffOnly` premerge. Resolution is done inside `premergeBase` itself, after its
  // own `baseBranch` guard, rather than unconditionally here — there is no `origin/${baseBranch}` ref
  // to resolve against (nor any point doing the work) when there is no conflict to premerge at all.
  const conflicts = await premergeBase(repo, worktree.path, pr, baseBranch, number);
  await ctx.heartbeat();
  return { worktree, conflicts, alreadyAhead };
}

/** The base merge GitHub says this PR needs — its conflicts are what claude is asked to resolve. */
async function premergeBase(
  repo: string,
  worktreePath: string,
  pr: PrReview,
  baseBranch: string | undefined,
  number: number,
): Promise<string[]> {
  if (pr.mergeable !== "CONFLICTING" || !baseBranch) return [];
  const baseRef = `origin/${baseBranch}`;
  const hooksPath = (await needsHooksPathOverrideForMerge(repo, worktreePath, baseRef))
    ? await resolveHooksPathOverrideForMerge(repo, worktreePath, baseRef)
    : undefined;
  try {
    const merge = await mergeIntoCurrent(worktreePath, baseRef, { hooksPath });
    return merge.conflicts; // clean auto-merge → a merge commit is pushed below
  } catch (e) {
    consoleLog.error(`PR #${number}: merging ${baseRef} failed`, e);
    return [];
  }
}

/**
 * Drive claude to resolve the review feedback, then commit/push the fix and notify the reviewers.
 * Wrapped in a recorded session so the UI can follow it and a mid-flight failure marks the session
 * failed before propagating (the runner then applies quota backoff / retry / park). Answers whether
 * anything was actually pushed, which is what the job's note may and may not claim.
 */
async function runFixSession(args: {
  db: AntonDb;
  clock: Clock;
  ctx: JobContext;
  repo: string;
  projectId: string;
  epic: Bead;
  settings: ProjectSettings;
  worktree: Worktree;
  pr: PrReview;
  verdict: Actionable;
  conflicts: string[];
  /** Ahead of origin before this run touched anything — see {@link prepareFixWorktree}. */
  alreadyAhead: boolean;
  branch: string;
  number: number;
}): Promise<boolean> {
  const {
    db,
    clock,
    ctx,
    repo,
    projectId,
    epic,
    settings,
    worktree,
    pr,
    verdict,
    conflicts,
    alreadyAhead,
    branch,
    number,
  } = args;

  // Resume the epic's open run if present (for UI linkage); review-fix doesn't create runs itself.
  const run = await findOpenRunForEpic(db, projectId, epic.id);
  const { sessionId, logPath, onEvent } = await startJobSession(db, clock, {
    projectId,
    runId: run?.id,
    kind: "review-fix",
    beadId: epic.id,
  });
  // Live handle (anton-susu): review-fix writes no run row, so this is how observe finds the
  // in-flight session + worktree. The captured routing rides along (anton-7poz) so an investigate
  // terminal hits the SAME gateway this fix session does, even if settings drift mid-run.
  ctx.report({ sessionId, cwd: worktree.path, routing: claudeRouting(settings) });

  // Once a push's outcome is durably recorded (`endSession` below), the catch at the bottom must
  // not overwrite it back to `failed` just because a LATER fallible step (thread replies, the
  // re-review notification) throws — that would erase delivery evidence for a push that already
  // reached the remote (PR #320 review).
  let sessionSettled = false;

  try {
    // A resume can land here with the fix already committed on the branch — an operator resolving
    // what a red gate named (a migration re-stamp, say) and hitting resume rather than a fresh
    // claude session re-diagnosing feedback that's already handled. Detecting that BEFORE the claude
    // dispatch is what makes the human loop cheap: the gates still gate (a red one parks exactly as
    // it would after a claude run), but a green one pushes the operator's own commits straight
    // through instead of paying for a session that would just re-produce them. `alreadyAhead` is
    // snapshotted before `prepareFixWorktree`'s own premerge step, which can itself land an unpushed
    // auto-merge commit — that must still go through claude + gates normally, not take this shortcut.
    //
    // `alreadyAhead` only says the branch carries prior commits — it says nothing about that same
    // premerge step, which runs unconditionally and can hand back a FRESH, unresolved conflict
    // (literal markers + MERGE_HEAD) alongside it. Nothing in this fast path can resolve those
    // markers — only claude does that, via the prompt built below — so a fresh conflict must fall
    // through to the normal dispatch path even when the branch is already ahead. Skipping claude
    // here would otherwise let the gate run against literal conflict text and, on a red result,
    // have the next worktree reap silently discard the unresolved merge while notifyGateParked
    // claims it was "resolved and committed locally".
    if (alreadyAhead && conflicts.length === 0) {
      await appendSessionLog(
        logPath,
        `[review-fix] PR #${number}: branch already ahead of origin; running gates and pushing without claude\n`,
      );
      await runTestGate(settings, worktree.path, ctx.signal, logPath, number);
      const pushed = await commitAndPushFix(
        repo,
        worktree.path,
        epic.id,
        branch,
        number,
        settings,
        ctx.signal,
      );
      // Persist the push BEFORE the fallible notification below — a delivery that reached the
      // remote must count toward lead-time/repair weighting even if notifyReReview never returns
      // (network stall, process kill) (PR #320 review).
      await endSession(db, clock, sessionId, "done", pushed);
      sessionSettled = true;
      await notifyReReview({ repo, number, pr, reasons: verdict.reasons, signal: ctx.signal });
      return pushed;
    }

    await appendSessionLog(
      logPath,
      `[review-fix] PR #${number}: ${verdict.reasons.join("; ")}\n`,
    );

    const { prompt, appendSystemPrompt, attribution } = await buildReviewFixPrompt({
      epic,
      pr,
      reasons: verdict.reasons,
      conflicts,
      settings,
      projectDir: worktree.path,
    });

    const routing = claudeRouting(settings);
    await ctx.claudeReached(quotaMeterKey(settings));
    const result = await metered(db, clock, {
      projectId,
      jobType: ctx.type,
      jobId: ctx.jobId,
      step: "review-fix",
      // This job IS the pr-fix phase; the handler names it for the fold the same way an in-formula
      // step does, so both correction paths classify alike (anton-234ja).
      stepHandler: "review-fix",
      runId: run?.id,
      beadId: epic.id,
      modelRequested: settings.model,
      // The specialist the epic named — `buildReviewFixPrompt` above composed this session's system
      // prompt from that same tag, and `metered` digests that composed text from the spawn options.
      agentTag: labelValueOf(epic.labels, "agent"),
      // The review-fix REASONING contract's own identity (PR #313 review) — see
      // `buildReviewFixPrompt`'s doc: it rides in `prompt`, which `metered` never digests.
      ...attribution,
    }, runClaude)({
      cwd: worktree.path,
      prompt,
      appendSystemPrompt,
      model: resolveReviewFixModel(settings, epic),
      routing,
      permissionMode: settings.permissionMode ?? "bypassPermissions",
      signal: ctx.signal,
      onEvent,
    });
    if (!result.ok) {
      throw new Error(
        `claude reported an error resolving PR #${number}: ${result.text ?? "unknown"}`,
      );
    }

    // premergeBase left any base-merge conflicts uncommitted (conflict markers, MERGE_HEAD set) for
    // this same session to resolve alongside the review feedback. Commit that resolution NOW, before
    // the gates run: a red gate below still throws and parks the branch, but the merge itself is
    // already landed rather than sitting as an uncommitted resolution the next re-run's fresh
    // worktree would simply discard (anton-vtex7). Nothing is pushed here — publication stays behind
    // the gates. No conflicts to resolve → nothing to commit yet → this run is unchanged.
    if (conflicts.length > 0) {
      await commitFix(repo, worktree.path, epic.id, branch, number, settings, ctx.signal);
    }

    await runTestGate(settings, worktree.path, ctx.signal, logPath, number);

    const pushed = await commitAndPushFix(
      repo,
      worktree.path,
      epic.id,
      branch,
      number,
      settings,
      ctx.signal,
    );

    // Persist the outcome BEFORE the fallible thread/notification work below — a push that reached
    // the remote must count toward lead-time/repair weighting even if `applyThreadOutcomes` or
    // `notifyReReview` never returns (network stall, GitHub outage, process kill), and the catch
    // below must not then downgrade this durable state back to `failed` (PR #320 review).
    await endSession(db, clock, sessionId, "done", pushed);
    sessionSettled = true;

    const report = parseThreadReport(result.text);
    await applyThreadOutcomes({ repo, number, pr, report, pushed, signal: ctx.signal, logPath });
    // AFTER the push (`pushed` is already settled above) — anton-te6nr — so the body never claims a
    // fix that isn't on the remote yet.
    await refreshFixRoundsBody({ repo, number, report, pushed, now: new Date(clock.now()), logPath });

    if (!pushed) {
      await appendSessionLog(
        logPath,
        `[review-fix] no changes produced; leaving PR #${number} as-is\n`,
      );
      return false;
    }

    await notifyReReview({
      repo,
      number,
      pr,
      reasons: verdict.reasons,
      signal: ctx.signal,
    });
    return true;
  } catch (e) {
    if (!sessionSettled) await endSession(db, clock, sessionId, "failed");
    // Poison means this attempt is parked for a human — the PR's own CONFLICTING/CI badges say
    // nothing about THAT (they don't know a gate ever ran), so without this comment the reader sees
    // only a stale badge, not why anton stopped (anton-gvqk3).
    if (isPoisonError(e)) {
      await notifyGateParked({ repo, number, error: e, conflicts, signal: ctx.signal });
    }
    throw e; // propagate so the runner applies quota backoff / retry / park
  }
}

/**
 * Tell the PR why anton stopped: the gate/blocker a poison park named, plus whether a base-branch
 * merge is already resolved and committed locally (unpushed) so the reader isn't left guessing what
 * state the branch is in. Carries {@link ANTON_MARK} like every other anton comment, so the review
 * sweep's own `threadsNeedingAttention` never mistakes it for a human's. Idempotent against the PR's
 * comment history rather than any local state — a resumed job parking on the SAME gate is a fresh
 * process with nothing of its own to remember, but the PR remembers what was already said on it.
 */
export async function notifyGateParked(args: {
  repo: string;
  number: number;
  error: Error;
  conflicts: string[];
  signal: AbortSignal;
}): Promise<void> {
  const { repo, number, error, conflicts, signal } = args;
  const mergeNote =
    conflicts.length > 0
      ? " The base branch merge was resolved and committed locally (not yet pushed)."
      : "";
  const body = `${ANTON_MARK} anton stopped fixing PR #${number} — ${error.message}${mergeNote}`;
  const existing = await getPrComments(repo, number, signal).catch((): string[] => []);
  if (existing.includes(body)) return;
  await safe(() => commentOnPr(repo, number, body, signal));
}

/** The per-PR worker has no pipeline step; its target labels are its routing context. */
export function resolveReviewFixModel(settings: ProjectSettings, epic: Pick<Bead, "labels">) {
  return resolveModel(settings, { jobType: "review-fix-pr", labels: epic.labels });
}

/** Cap on the gate output a poison park carries — enough to act on, not the whole log. */
const GATE_FAILURE_OUTPUT_CHARS = 3000;

/**
 * Optional verify gates before pushing (same mechanism as execution, anton-3oh8): tests +
 * operator-pinned lint/typecheck/build. Absent → no gates run.
 *
 * A red gate here poisons on the spot instead of throwing a plain (retryable) error. Unlike a
 * ticket attempt, this fix session already ran and already committed everything it has authority
 * over — a retry re-dispatches claude against the exact same tree and base, which can only
 * reproduce the exact same failure (fati-87h burned three identical attempts on a deterministic
 * gate this way). `captureVerifyGates` (not `runVerifyGates`) is called directly so the failure
 * carries the gate's output, not just its label and exit code.
 *
 * Genuinely transient failures — an aborted signal, a killed process — never reach the check
 * below: `captureVerifyGates` REJECTS for those (it never returns a red outcome for them), so they
 * propagate as an ordinary error the runner still retries.
 */
export async function runTestGate(
  settings: ProjectSettings,
  cwd: string,
  signal: AbortSignal,
  logPath: string,
  number: number,
): Promise<void> {
  const outcomes = await captureVerifyGates(resolveVerifyGates(settings), cwd, signal, logPath);
  const red = outcomes.find((o) => !o.ok);
  if (!red) return;
  // Opening sentence unchanged (existing readers parse it) — the gate output tail is appended.
  throw new PoisonError(
    `${red.label} gate failed after review-fix for PR #${number} (exit ${red.code})\n\n` +
      tailLines(red.output, GATE_FAILURE_OUTPUT_CHARS),
  );
}

/**
 * Stage whatever is in the worktree and commit it, with the recovery a commit timeout needs. Split
 * out of `commitAndPushFix` (anton-vtex7) so `runFixSession` can land a resolved base merge BEFORE
 * the verify gates run, while the push itself still waits behind them. Returns whether a commit
 * exists to push (this call made one, or the tree had nothing new to add) and the hooksPath
 * resolved for it, which `commitAndPushFix` reuses for the push.
 */
async function commitFix(
  repo: string,
  worktreePath: string,
  epicId: string,
  branch: string,
  number: number,
  settings: ProjectSettings,
  signal: AbortSignal,
): Promise<{ committed: boolean; hooksPath: string | undefined }> {
  // Staged BEFORE `resolveHooksPathOverride` is asked anything (PR #263 review, round 37) — the
  // same fix `commitStep` applies for the same reason: its submodule-staleness check reads the
  // INDEX, and claude's fix session may have checked a hooks-path submodule out at a new commit
  // without staging it itself, relying on `commitAll`'s own `git add -A` below to pick it up. Asked
  // before that staging happens, the check would see the old, unstaged gitlink and disable hooks for
  // a commit that, by the time it actually runs, legitimately carries the new one. See `commitAll`'s
  // doc comment for the full ordering bug. `commitAll`'s own `git add -A` is a no-op now that this
  // has already staged everything.
  await stageAll(worktreePath);
  const hooksPath = await resolveHooksPathOverride(repo, worktreePath);
  // `post-commit` runs after HEAD advances. A timeout can therefore reject `commitAll` after the
  // fix landed; recognize only a forward move on this run's branch, never an unrelated rewrite.
  const before = await readWorktreeState(worktreePath);
  let committed: boolean;
  try {
    ({ committed } = await commitAll(
      worktreePath,
      `${epicId}: address review feedback (PR #${number})`,
      { hooksPath, timeoutMs: resolveCommitTimeoutMs(settings), signal },
    ));
  } catch (error) {
    // An operator cancellation stops the entire review-fix lifecycle: do not push, resolve threads,
    // or mark its session done merely because Git had already advanced HEAD.
    if (signal.aborted) throw error;
    const after = await readWorktreeState(worktreePath);
    if (after.head === before.head) throw error;
    if (after.ref !== `refs/heads/${branch}`) {
      throw new PoisonError(
        `review fix for PR #${number} left HEAD on ${after.ref ?? `a detached HEAD (${after.head})`} ` +
          `instead of the run's ${branch}`,
        { cause: error },
      );
    }
    if (!(await isAncestor(worktreePath, before.head, after.head))) {
      throw new PoisonError(
        `review fix for PR #${number} rewrote ${branch} instead of adding its commit`,
        { cause: error },
      );
    }
    committed = true;
  }
  return { committed, hooksPath };
}

/**
 * Commit claude's fix and push the branch. Pushes if this run committed (here, or already via the
 * pre-gate `commitFix` call in `runFixSession` for a conflicted PR) OR a prior attempt left commits
 * unpushed (e.g. a push failed after committing, then the retry's claude produced no new diff).
 * Otherwise there is genuinely nothing to send — a clean no-op, not a silent skip of pending work.
 * Returns whether anything was pushed.
 */
async function commitAndPushFix(
  repo: string,
  worktreePath: string,
  epicId: string,
  branch: string,
  number: number,
  settings: ProjectSettings,
  signal: AbortSignal,
): Promise<boolean> {
  const { committed, hooksPath } = await commitFix(
    repo,
    worktreePath,
    epicId,
    branch,
    number,
    settings,
    signal,
  );
  const pushed = committed || (await branchAheadOfRemote(repo, branch));
  // From the worktree, not `repo` (the base checkout) — see pushBranch's doc comment: a project's
  // pre-push hook that inspects the working tree must see the branch actually being pushed. The
  // resolved hooksPath above is ALSO read from the worktree (resolveHooksPathOverride(repo,
  // worktreePath) queries worktreePath when given, per its own contract) — the same "read from the
  // worktree, not the base repo" behavior this file's onbranch-includeIf reasoning depends on
  // elsewhere, not the base checkout's config.
  if (pushed) {
    await pushBranch(worktreePath, branch, hooksPath, resolvePushTimeoutMs(settings), signal);
  }
  return pushed;
}

/** What one reported thread's reply is written against. */
interface ThreadReplyArgs {
  repo: string;
  number: number;
  signal: AbortSignal;
  logPath: string;
}

/**
 * Reply to each reported inline thread, react on it, and resolve the fixed ones. Replying to
 * declined threads (even when nothing was pushed) is what stops them being re-triaged every sweep
 * — an unresolved thread whose last comment is anton's is no longer actionable (see
 * threadsNeedingAttention); the reaction is the free calibration signal on top, not a substitute
 * for the reply. A "fixed" claim without a push is a fabrication — leave that thread untouched,
 * reply and reaction both.
 */
export async function applyThreadOutcomes(args: {
  repo: string;
  number: number;
  pr: PrReview;
  report: ThreadOutcome[];
  pushed: boolean;
  signal: AbortSignal;
  logPath: string;
}): Promise<void> {
  const waiting = threadsNeedingAttention(args.pr);
  for (const item of args.report) {
    const thread = waiting.find((t) => t.id === item.id);
    const anchor = thread?.comments[0];
    if (!thread || !anchor) continue;
    if (fabricatedFix(item, args.pushed)) continue;
    await recordThreadOutcome(args, thread, anchor.id, item);
  }
}

/** Reply on the thread, resolve it when the fix landed, and log what was said. */
async function recordThreadOutcome(
  args: ThreadReplyArgs,
  thread: ReviewThread,
  anchorId: number,
  item: ThreadOutcome,
): Promise<void> {
  const { repo, number, signal, logPath } = args;
  const note = item.reply?.trim() || defaultReply(item.outcome);
  await safe(() =>
    replyToReviewComment(repo, number, anchorId, `${ANTON_MARK} ${note}`, signal),
  );
  await safe(() => reactToReviewComment(repo, anchorId, reactionForOutcome(item.outcome), signal));
  if (item.outcome === "fixed")
    await safe(() => resolveReviewThread(repo, thread.id, signal));
  await appendSessionLog(
    logPath,
    `[review-fix] thread ${thread.id}: ${item.outcome} — ${note}\n`,
  );
}

/**
 * Refresh the PR body's review-fix-rounds region with what THIS round fixed (anton-te6nr), reusing
 * the fixer's own per-thread report rather than a fresh LLM call. Runs strictly AFTER the push (the
 * caller only reaches this once `pushed` is known), so the body never claims a fix that isn't on
 * the remote yet — and touches `gh` not at all for a round that pushed nothing, or fixed nothing
 * worth naming: {@link fixRoundFrom} answers that cheaply, before any network call.
 *
 * Every `gh` step here is best-effort by construction (`readPullRequestBody`/`updatePullRequestBody`
 * already catch and report a boolean, same as `bodyStale` in `openPullRequest`) — a failure is
 * logged and this function returns normally, exactly like the review gate's own refusal-is-reported
 * precedent. The caller's session has already been marked `done` by the time this runs, so nothing
 * here can turn a delivered push into a failed job.
 */
export async function refreshFixRoundsBody(args: {
  repo: string;
  number: number;
  report: ThreadOutcome[];
  pushed: boolean;
  now: Date;
  logPath: string;
}): Promise<void> {
  const { repo, number, report, pushed, now, logPath } = args;
  if (!pushed) return;
  if (!fixRoundFrom(report, pushed, now)) return; // nothing fixed this round — no gh call at all
  const selector = String(number);
  const currentBody = await readPullRequestBody(repo, selector);
  if (currentBody === undefined) {
    await appendSessionLog(
      logPath,
      `[review-fix] could not read PR #${number}'s body to refresh its review-fix rounds\n`,
    );
    return;
  }
  const content = nextFixRoundsRegion(currentBody, report, pushed, now);
  if (!content) return; // defensive; fixRoundFrom above already confirmed there's something to say
  const { body, skipped } = upsertBodyRegion(currentBody, content);
  if (skipped) return; // upsertBodyRegion already warned why
  if (!(await updatePullRequestBody(repo, selector, body))) {
    await appendSessionLog(
      logPath,
      `[review-fix] could not write the review-fix-rounds update to PR #${number}'s body\n`,
    );
  }
}

/** What anton says on a thread claude reported without a reply of its own. */
const defaultReply = (outcome: ThreadOutcome["outcome"]): string =>
  outcome === "fixed" ? "addressed in the latest push" : "left as-is";

/** The reaction that turns a triaged outcome into the reviewer's free calibration signal. */
const reactionForOutcome = (outcome: ThreadOutcome["outcome"]): PrReactionContent => {
  switch (outcome) {
    case "fixed":
      return "+1";
    case "left":
      return "-1";
    case "needs-human":
      return "eyes";
  }
};

/** Post the PR-level "pushed a fix, please re-review" comment and re-request the change reviewers. */
async function notifyReReview(args: {
  repo: string;
  number: number;
  pr: PrReview;
  reasons: string[];
  signal: AbortSignal;
}): Promise<void> {
  const { repo, number, pr, reasons, signal } = args;
  await safe(() =>
    commentOnPr(
      repo,
      number,
      `${ANTON_MARK} anton pushed a fix for the review feedback (${reasons.join("; ")}). Please re-review.`,
      signal,
    ),
  );
  await safe(() =>
    reRequestReview(repo, number, reviewersRequestingChanges(pr), signal),
  );
}
