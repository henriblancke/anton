/**
 * review-fix job (anton-3t2.2). For a project's in-review epics (open PR linked on the bead), poll
 * the PR via `gh` for requested changes + failing CI; when actionable, re-materialize the epic's
 * worktree, dispatch claude to resolve the feedback, commit, push, and re-request review. See
 * DESIGN §2/§4 and git/pr.ts.
 *
 * This same sweep also finalizes MERGED PRs (anton-ner.5): a merged PR is terminal, so instead of
 * fixing review feedback the epic + its remaining open tickets move to done, `stage:in-review` is
 * cleared, and the merged branch/worktree + run row are cleaned up. A PR merely CLOSED (not merged)
 * is left alone. Living here — rather than in a new job type — means every existing project gets
 * merge finalization on its next poll without re-seeding schedules. What that finalization DOES is
 * review-fix-finalize.ts; this module decides when it runs (anton-qeir).
 *
 * HOW A MERGE IS LEARNED changed in anton-k0kj; what is DONE about it did not. execute-epic arms a
 * `gh:pr` gate on the target when it opens the PR, gate-check settles every merge wait in the
 * project with one `bd gate check`, and a closed gate dispatches this job scoped to that one target
 * (`epicBeadId`) — so the merge arrives as a board event instead of being discovered by re-reading
 * every open PR. The `pr.state === "MERGED"` branch below is unchanged and stays the executor of it.
 *
 * THE REVIEW-EVENT POLL SURVIVES, BY DESIGN. It is the one wait gates cannot replace: a `gh:pr` gate
 * resolves on MERGE and escalates on CLOSE, its whole GitHub read is `gh pr view <id> --json
 * state,title`, and bd offers no review-flavoured gate type at all (`--type` = human|timer|gh:run|
 * gh:pr). Requested changes, a new review comment and red CI are therefore invisible to the gate
 * model, so the periodic sweep below remains the trigger for them. See
 * .product/decisions/2026-08-02-pr-merge-as-gh-pr-gate.md.
 *
 * Enqueued per-project by the scheduler (a polling job): each run sweeps every in-review epic once.
 * Idempotent — a PR with nothing actionable is skipped, claude's fixes are plain commits on the
 * existing branch (a re-run just pushes whatever is left), and finalizing a merge clears
 * `stage:in-review` so a later sweep no longer treats the epic as in-review (never finalized twice).
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
import { isUsageLimitError, PoisonError } from "./errors";
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
  /** Optional: restrict to one epic (else sweep all in-review epics). */
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
 * The job id is part of it because "review-fix" alone is not one holder: the project-wide sweep and
 * a gate-check's targeted fix for the same epic are two jobs that `enqueueReviewFixIfAbsent`
 * deliberately allows to coexist, and a claim they share is no claim at all — `conflictingClaim`
 * only rejects a holder whose owner differs from the caller, so the second job would reuse the
 * checkout and interleave its fetch/merge/claude/commit/push with the first's in one directory.
 * Distinct owners make that the conflict it is; the readable prefix keeps refusal logs legible.
 */
export function claimOwnerFor(jobId: string): string {
  return `review-fix#${jobId}`;
}

/** Build the runner handler bound to a db/clock. Register it as the "review-fix" handler. */
export function makeReviewFixHandler(deps: ReviewFixDeps): JobHandler {
  const db = deps.db;
  const clock = deps.clock ?? systemClock;
  const branchPrefix = deps.branchPrefix ?? "anton";
  return (ctx: JobContext) => sweepInReview({ db, clock, branchPrefix, ctx });
}

/** One sweep: every in-review PR this operator owns, once. */
async function sweepInReview(args: {
  db: AntonDb;
  clock: Clock;
  branchPrefix: string;
  ctx: JobContext;
}): Promise<JobEffect> {
  const { db, clock, branchPrefix, ctx } = args;
  const { projectId, epicBeadId } = ctx.payload as ReviewFixPayload;
  const project = await getProjectById(db, projectId);
  if (!project) throw new PoisonError(`project ${projectId} not found`);
  const repo = project.repoPath;
  const settings = await getProjectSettings(db, projectId);

  const all = await beads.list(repo, ["--status", "all"]);
  // Scope the sweep to epics this operator owns (anton-zoh): unclaimed or claimed-by-me, so a
  // shared board doesn't have two antons racing the same in-review PR. A targeted epicBeadId
  // (single-epic run) bypasses ownership — the operator explicitly asked for that epic. Identity
  // comes from the same resolveOperator that execute-epic claims with, so "mine" matches the claim.
  const operator = await resolveOperator();
  const epics = inReviewEpics(all, { operator, epicBeadId });
  if (epics.length === 0) return { changed: false, note: "nothing in review" };

  const failure = await fixEachEpic({
    db,
    clock,
    ctx,
    repo,
    projectId,
    settings,
    branchPrefix,
    baseBranch: settings.baseBranch ?? project.defaultBranch,
    epics,
    all,
  });

  // The claude sessions above may have written beads (notes, bd remember); push them.
  // Logged, not thrown — a sync hiccup must not shadow (or fabricate) a sweep failure.
  await beads
    .sync(repo)
    .catch((e) =>
      consoleLog.error("beads dolt sync failed after review-fix sweep", e),
    );

  // Surface a non-quota failure so the job retries/parks — but only after trying every epic.
  if (failure) throw failure;

  // Sweeping a PR is the effect, whether or not the review had anything actionable on it: the
  // count is what an operator checks the poll against. A sweep of zero epics returned above.
  return { changed: true, note: `swept ${epics.length} PR(s) in review` };
}

/**
 * Fix every epic in the sweep, answering the failure the job must surface (undefined when all of
 * them came through). One epic's failure shouldn't abort the others, but a usage limit must
 * propagate so the runner backs the WHOLE job off — you can't retry an exhausted quota.
 */
async function fixEachEpic(args: {
  db: AntonDb;
  clock: Clock;
  ctx: JobContext;
  repo: string;
  projectId: string;
  settings: ProjectSettings;
  branchPrefix: string;
  baseBranch: string | undefined;
  epics: Bead[];
  all: Bead[];
}): Promise<Error | undefined> {
  let lastError: unknown;
  for (const epic of args.epics) {
    await args.ctx.heartbeat();
    try {
      await handleEpic({ ...args, epic });
    } catch (e) {
      if (isUsageLimitError(e)) throw e; // stop the sweep; runner reschedules past the reset.
      lastError = e;
      consoleLog.error(`epic ${epic.id} (PR fix) failed; continuing sweep`, e);
    }
  }
  if (lastError === undefined) return undefined;
  return lastError instanceof Error ? lastError : new Error(String(lastError));
}

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
}): Promise<void> {
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
  if (number === undefined) return;

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
    return;
  }

  const verdict = classifyReview(pr);
  if (!verdict.actionable) return; // nothing to fix on this PR yet.

  // Claim the checkout for the whole fix. review-fix writes no run row, so without it the branch
  // reads as nobody's: the execute run's teardown (its bead is still open, so it releases the
  // worktree) would force-remove the directory claude is fixing in, discarding the fix and failing
  // the commit and push behind it.
  const claimOwner = claimOwnerFor(ctx.jobId);
  await withWorktreeClaim(repo, branch, claimOwner, async () => {
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

    await runFixSession({
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
 * failed before propagating (the runner then applies quota backoff / retry / park).
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
}): Promise<void> {
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
      return;
    }

    await notifyReReview({
      repo,
      number,
      pr,
      reasons: verdict.reasons,
      signal: ctx.signal,
    });
    await endSession(db, clock, sessionId, "done");
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
