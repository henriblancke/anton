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
import { beads, type Bead } from "../beads/bd";
import { runClaude } from "../claude/driver";
import {
  branchAheadOfRemote,
  commitAll,
  fetchOrigin,
  mergeIntoCurrent,
  pushBranch,
} from "../git/ops";
import {
  ANTON_MARK,
  classifyReview,
  commentOnPr,
  getPrReview,
  prNumberFromRef,
  reRequestReview,
  replyToReviewComment,
  resolveReviewThread,
  reviewersRequestingChanges,
  threadsNeedingAttention,
  type Actionable,
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
  resolveVerifyGates,
  type ProjectSettings,
} from "../projects";
import { runVerifyGates } from "./shell";
import { findOpenRunForEpic } from "../runs";
import { runTickets } from "../ticket-view";
import { appendSessionLog, endSession, startJobSession } from "../sessions";
import {
  buildReviewFixPrompt,
  parseThreadReport,
  type ThreadOutcome,
} from "./review-fix-context";
import { IN_REVIEW, safe } from "./review-fix-board";
import { finalizeMergedEpic } from "./review-fix-finalize";
import { PoisonError } from "./errors";
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
    const { worktree, conflicts } = await prepareFixWorktree({
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
}): Promise<{ worktree: Worktree; conflicts: string[] }> {
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
  await safe(() =>
    mergeIntoCurrent(worktree.path, `origin/${branch}`, { ffOnly: true }),
  );

  const conflicts = await premergeBase(worktree.path, pr, baseBranch, number);
  await ctx.heartbeat();
  return { worktree, conflicts };
}

/** The base merge GitHub says this PR needs — its conflicts are what claude is asked to resolve. */
async function premergeBase(
  worktreePath: string,
  pr: PrReview,
  baseBranch: string | undefined,
  number: number,
): Promise<string[]> {
  if (pr.mergeable !== "CONFLICTING" || !baseBranch) return [];
  try {
    const merge = await mergeIntoCurrent(worktreePath, `origin/${baseBranch}`);
    return merge.conflicts; // clean auto-merge → a merge commit is pushed below
  } catch (e) {
    consoleLog.error(`PR #${number}: merging origin/${baseBranch} failed`, e);
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
  // in-flight session + worktree.
  ctx.report({ sessionId, cwd: worktree.path });

  try {
    await appendSessionLog(
      logPath,
      `[review-fix] PR #${number}: ${verdict.reasons.join("; ")}\n`,
    );

    const { prompt, appendSystemPrompt } = await buildReviewFixPrompt({
      epic,
      pr,
      reasons: verdict.reasons,
      conflicts,
      settings,
      projectDir: worktree.path,
    });

    const result = await runClaude({
      cwd: worktree.path,
      prompt,
      appendSystemPrompt,
      model: settings.model,
      permissionMode: settings.permissionMode ?? "bypassPermissions",
      signal: ctx.signal,
      onEvent,
    });
    if (!result.ok) {
      throw new Error(
        `claude reported an error resolving PR #${number}: ${result.text ?? "unknown"}`,
      );
    }

    await runTestGate(settings, worktree.path, ctx.signal, logPath, number);

    const pushed = await commitAndPushFix(
      repo,
      worktree.path,
      epic.id,
      branch,
      number,
    );

    await applyThreadOutcomes({
      repo,
      number,
      pr,
      report: parseThreadReport(result.text),
      pushed,
      signal: ctx.signal,
      logPath,
    });

    if (!pushed) {
      await appendSessionLog(
        logPath,
        `[review-fix] no changes produced; leaving PR #${number} as-is\n`,
      );
      await endSession(db, clock, sessionId, "done");
      return false;
    }

    await notifyReReview({
      repo,
      number,
      pr,
      reasons: verdict.reasons,
      signal: ctx.signal,
    });
    await endSession(db, clock, sessionId, "done");
    return true;
  } catch (e) {
    await endSession(db, clock, sessionId, "failed");
    throw e; // propagate so the runner applies quota backoff / retry / park
  }
}

/**
 * Optional verify gates before pushing (same mechanism as execution, anton-3oh8): tests +
 * operator-pinned lint/typecheck/build. Absent → no gates run. Throws on the first non-zero exit.
 */
async function runTestGate(
  settings: ProjectSettings,
  cwd: string,
  signal: AbortSignal,
  logPath: string,
  number: number,
): Promise<void> {
  await runVerifyGates(
    resolveVerifyGates(settings),
    cwd,
    signal,
    logPath,
    (gate, code) =>
      `${gate.label} gate failed after review-fix for PR #${number} (exit ${code})`,
  );
}

/**
 * Commit claude's fix and push the branch. Pushes if this run committed OR a prior attempt left
 * commits unpushed (e.g. a push failed after committing, then the retry's claude produced no new
 * diff). Otherwise there is genuinely nothing to send — a clean no-op, not a silent skip of
 * pending work. Returns whether anything was pushed.
 */
async function commitAndPushFix(
  repo: string,
  worktreePath: string,
  epicId: string,
  branch: string,
  number: number,
): Promise<boolean> {
  const { committed } = await commitAll(
    worktreePath,
    `${epicId}: address review feedback (PR #${number})`,
  );
  const pushed = committed || (await branchAheadOfRemote(repo, branch));
  if (pushed) await pushBranch(repo, branch);
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
 * Reply to each reported inline thread, resolving the fixed ones. Replying to declined threads
 * (even when nothing was pushed) is what stops them being re-triaged every sweep — an unresolved
 * thread whose last comment is anton's is no longer actionable (see threadsNeedingAttention). A
 * "fixed" claim without a push is a fabrication — leave that thread untouched.
 */
async function applyThreadOutcomes(args: {
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

/** A "fixed" claim with nothing pushed behind it — left untouched rather than answered. */
const fabricatedFix = (item: ThreadOutcome, pushed: boolean): boolean =>
  item.outcome === "fixed" && !pushed;

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
  if (item.outcome === "fixed")
    await safe(() => resolveReviewThread(repo, thread.id, signal));
  await appendSessionLog(
    logPath,
    `[review-fix] thread ${thread.id}: ${item.outcome} — ${note}\n`,
  );
}

/** What anton says on a thread claude reported without a reply of its own. */
const defaultReply = (outcome: ThreadOutcome["outcome"]): string =>
  outcome === "fixed" ? "addressed in the latest push" : "left as-is";

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
