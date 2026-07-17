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
 * merge finalization on its next poll without re-seeding schedules.
 *
 * Enqueued per-project by the scheduler (a polling job): each run sweeps every in-review epic once.
 * Idempotent — a PR with nothing actionable is skipped, claude's fixes are plain commits on the
 * existing branch (a re-run just pushes whatever is left), and finalizing a merge clears
 * `stage:in-review` so a later sweep no longer treats the epic as in-review (never finalized twice).
 */
import { randomUUID } from "node:crypto";
import { beads, LABELS, type Bead } from "../beads/bd";
import { runClaude, type ClaudeEvent } from "../claude/driver";
import { branchAheadOfRemote, commitAll, fetchOrigin, mergeIntoCurrent, pushBranch } from "../git/ops";
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
} from "../git/pr";
import { createWorktree, findWorktree, removeWorktree, worktreePathFor, type Worktree } from "../git/worktree";
import { resolveOperator } from "../operator";
import { getProjectById, getProjectSettings, type ProjectSettings } from "../projects";
import { runShell } from "./shell";
import { findOpenRunForEpic, updateRun } from "../runs";
import { appendSessionLog, createSession, endSession, sessionLogPath } from "../sessions";
import { buildReviewFixPrompt, parseThreadReport, type ThreadOutcome } from "./review-fix-context";
import { isUsageLimitError, PoisonError } from "./errors";
import type { AntonDb, Clock } from "./queue";
import { systemClock } from "./queue";
import type { JobContext, JobHandler, RunnerLogger } from "./runner";

// The per-thread report parser is a review-fix protocol concern; re-export so existing importers
// (and unit tests) can keep reaching it via this module.
export { parseThreadReport, type ThreadOutcome } from "./review-fix-context";

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

const IN_REVIEW = LABELS.stage("in-review");

/** Handlers get no logger from the runner; fall back to console so swallowed errors are visible. */
const consoleLog: RunnerLogger = {
  info: (m, meta) => console.log(`[review-fix] ${m}`, meta ?? ""),
  error: (m, meta) => console.error(`[review-fix] ${m}`, meta ?? ""),
};

/**
 * Does the current operator own this epic? On a shared board an operator may only fix/finalize the
 * in-review PRs it claimed (or unclaimed ones) — never another operator's. `assignee` is the claim
 * execute-epic stamps (beads.claim → `bd update --claim`, actor = resolveOperator); unclaimed beads
 * carry null/absent/empty. resolveOperator resolves the same identity — down to bd's $USER fallback
 * (anton-g3v) — that stamped the claim, so a claim this instance made always matches. `operator`
 * is undefined only in the degenerate case where even $USER is unset; then nothing but unclaimed
 * epics match, so an anton that genuinely can't name itself never races a claimed PR.
 */
function ownedByOperator(b: Bead, operator: string | undefined): boolean {
  const assignee = (b.assignee ?? undefined)?.trim() || undefined;
  if (!assignee) return true; // unclaimed — free to take
  return assignee === operator; // claimed-by-me; a different operator's claim is excluded
}

/**
 * In-review run targets = open run targets tagged stage:in-review that carry a PR external-ref,
 * filtered to the ones this operator may act on. A run target is an epic OR a standalone parentless
 * task/bug (an epic-of-one) — both open a PR and sit in review until it merges, so both must be
 * swept here. A standalone target has no children, so `handleEpic`/`finalizeMergedEpic` treat it as
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
      !beads.isRunTarget(b) ||
      b.status === "closed" ||
      !(b.labels?.includes(IN_REVIEW) ?? false) ||
      prNumberFromRef(b.external_ref) === undefined
    ) {
      return false;
    }
    if (epicBeadId) return b.id === epicBeadId; // targeted run — ownership bypassed
    return ownedByOperator(b, operator);
  });
}

/** Build the runner handler bound to a db/clock. Register it as the "review-fix" handler. */
export function makeReviewFixHandler(deps: ReviewFixDeps): JobHandler {
  const db = deps.db;
  const clock = deps.clock ?? systemClock;
  const branchPrefix = deps.branchPrefix ?? "anton";

  return async function reviewFix(ctx: JobContext): Promise<void> {
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
    if (epics.length === 0) return; // nothing in review for this operator — done.

    // Sweep each in-review PR. One epic's failure shouldn't abort the others, but a usage limit
    // must propagate so the runner backs the WHOLE job off (you can't retry an exhausted quota).
    let lastError: unknown;
    for (const epic of epics) {
      await ctx.heartbeat();
      try {
        await handleEpic({
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
      } catch (e) {
        if (isUsageLimitError(e)) throw e; // stop the sweep; runner reschedules past the reset.
        lastError = e;
        consoleLog.error(`epic ${epic.id} (PR fix) failed; continuing sweep`, e);
      }
    }
    // The claude sessions above may have written beads (notes, bd remember); push them.
    // Logged, not thrown — a sync hiccup must not shadow (or fabricate) a sweep failure.
    await beads
      .sync(repo)
      .catch((e) => consoleLog.error("beads dolt sync failed after review-fix sweep", e));

    // Surface a non-quota failure so the job retries/parks — but only after trying every epic.
    if (lastError) {
      throw lastError instanceof Error ? lastError : new Error(String(lastError));
    }
  };
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
  const { db, clock, ctx, repo, projectId, epic, settings, branchPrefix, baseBranch, all } = args;
  const number = prNumberFromRef(epic.external_ref);
  if (number === undefined) return;

  const pr = await getPrReview(repo, number, ctx.signal);
  const branch = pr.headRefName || `${branchPrefix}/${epic.id}`;

  // A merged PR is terminal — finalize the epic (done + cleanup) rather than fixing feedback. A PR
  // merely CLOSED (not merged) falls through to classifyReview, which treats any non-OPEN state as
  // not-actionable, so it is left untouched.
  if (pr.state === "MERGED") {
    await finalizeMergedEpic({
      db,
      clock,
      repo,
      projectId,
      epic,
      children: childrenOf(all, epic.id),
      branch,
    });
    return;
  }

  const verdict = classifyReview(pr);
  if (!verdict.actionable) return; // nothing to fix on this PR yet.

  // Re-materialize the worktree from the PR branch (execute-epic removes it after opening the PR),
  // sync it with origin, and pre-merge the base if GitHub reports a conflict.
  const { worktree, conflicts } = await prepareFixWorktree({ ctx, repo, branch, settings, baseBranch, pr, number });

  await runFixSession({ db, clock, ctx, repo, projectId, epic, settings, worktree, pr, verdict, conflicts, branch, number });
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
}): Promise<{ worktree: Worktree; conflicts: string[] }> {
  const { ctx, repo, branch, settings, baseBranch, pr, number } = args;

  const worktree = await createWorktree({ repoPath: repo, branch, baseBranch: settings.baseBranch, warm: false });
  await ctx.heartbeat();

  await safe(() => fetchOrigin(worktree.path, baseBranch ? [baseBranch, branch] : [branch]));
  await safe(() => mergeIntoCurrent(worktree.path, `origin/${branch}`, { ffOnly: true }));

  let conflicts: string[] = [];
  if (pr.mergeable === "CONFLICTING" && baseBranch) {
    try {
      const merge = await mergeIntoCurrent(worktree.path, `origin/${baseBranch}`);
      conflicts = merge.conflicts; // clean auto-merge → a merge commit is pushed below
    } catch (e) {
      consoleLog.error(`PR #${number}: merging origin/${baseBranch} failed`, e);
    }
  }
  await ctx.heartbeat();
  return { worktree, conflicts };
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
  const { db, clock, ctx, repo, projectId, epic, settings, worktree, pr, verdict, conflicts, branch, number } = args;

  const sessionId = randomUUID();
  const logPath = sessionLogPath(sessionId);
  // Resume the epic's open run if present (for UI linkage); review-fix doesn't create runs itself.
  const run = await findOpenRunForEpic(db, projectId, epic.id);
  await createSession(db, clock, {
    id: sessionId,
    projectId,
    runId: run?.id,
    kind: "review-fix",
    beadId: epic.id,
    logPath,
  });
  const onEvent = (e: ClaudeEvent) => {
    const line = e.text ? `[${e.type}] ${e.text}\n` : `[${e.type}]\n`;
    void appendSessionLog(logPath, line).catch(() => {});
  };

  try {
    await appendSessionLog(logPath, `[review-fix] PR #${number}: ${verdict.reasons.join("; ")}\n`);

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
      throw new Error(`claude reported an error resolving PR #${number}: ${result.text ?? "unknown"}`);
    }

    await runTestGate(settings, worktree.path, ctx.signal, logPath, number);

    const pushed = await commitAndPushFix(repo, worktree.path, epic.id, branch, number);

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
      await appendSessionLog(logPath, `[review-fix] no changes produced; leaving PR #${number} as-is\n`);
      await endSession(db, clock, sessionId, "done");
      return;
    }

    await notifyReReview({ repo, number, pr, reasons: verdict.reasons, signal: ctx.signal });
    await endSession(db, clock, sessionId, "done");
  } catch (e) {
    await endSession(db, clock, sessionId, "failed");
    throw e; // propagate so the runner applies quota backoff / retry / park
  }
}

/** Optional test gate before pushing (same gate as execution). Throws if the tests fail. */
async function runTestGate(
  settings: ProjectSettings,
  cwd: string,
  signal: AbortSignal,
  logPath: string,
  number: number,
): Promise<void> {
  if (!settings.testCommand) return;
  const test = await runShell(settings.testCommand, cwd, signal);
  await appendSessionLog(logPath, `\n[tests] ${settings.testCommand}\n${test.output}\n`);
  if (!test.ok) throw new Error(`tests failed after review-fix for PR #${number} (exit ${test.code})`);
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
  const { committed } = await commitAll(worktreePath, `${epicId}: address review feedback (PR #${number})`);
  const pushed = committed || (await branchAheadOfRemote(repo, branch));
  if (pushed) await pushBranch(repo, branch);
  return pushed;
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
  const { repo, number, pr, report, pushed, signal, logPath } = args;
  const waiting = threadsNeedingAttention(pr);
  for (const item of report) {
    const thread = waiting.find((t) => t.id === item.id);
    const anchor = thread?.comments[0];
    if (!thread || !anchor) continue;
    if (item.outcome === "fixed" && !pushed) continue;
    const note = item.reply?.trim() || (item.outcome === "fixed" ? "addressed in the latest push" : "left as-is");
    await safe(() => replyToReviewComment(repo, number, anchor.id, `${ANTON_MARK} ${note}`, signal));
    if (item.outcome === "fixed") {
      await safe(() => resolveReviewThread(repo, thread.id, signal));
    }
    await appendSessionLog(logPath, `[review-fix] thread ${thread.id}: ${item.outcome} — ${note}\n`);
  }
}

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
  await safe(() => reRequestReview(repo, number, reviewersRequestingChanges(pr), signal));
}

// ── merge finalization (anton-ner.5) ──

/** Children of an epic — beads whose parent (inline on `bd list --json`) is the epic. */
function childrenOf(all: Bead[], epicId: string): Bead[] {
  return all.filter((b) => ((b.parent ?? b.parent_id) as string | undefined) === epicId);
}

/**
 * Finalize an epic whose PR merged: close the epic + any still-open child tickets, drop the
 * `stage:in-review` label, remove the merged branch + its worktree, and finalize the run row.
 *
 * Idempotent by construction. Dropping `stage:in-review` (only once every close succeeds) means the
 * next review-fix sweep no longer treats the epic as in-review (inReviewEpics filters it out), so it
 * is never finalized twice; if a close fails transiently the label is left in place and the epic is
 * re-selected next sweep to retry. Every step here is individually safe to repeat — already-closed
 * beads are skipped, removeWorktree
 * is a no-op when the worktree/branch are already gone (execute-epic removes the worktree at PR
 * open, so it is usually already gone by merge time), and an already-finalized run leaves no open
 * run to touch.
 */
export async function finalizeMergedEpic(args: {
  db: AntonDb;
  clock: Clock;
  repo: string;
  projectId: string;
  epic: Bead;
  /** The epic's child tickets (open ones are closed alongside the epic). */
  children: Bead[];
  /** The merged PR's head branch — the local branch + worktree to clean up. */
  branch: string;
}): Promise<void> {
  const { db, clock, repo, projectId, epic, children, branch } = args;

  // 1. Close remaining open tickets, then the epic. Only drop the in-review stage once every close
  //    has actually succeeded — a transient `bd close` failure (swallowed by `safe`) must leave the
  //    label in place so the next review-fix sweep re-selects the epic (inReviewEpics) and retries,
  //    rather than orphaning a still-open ticket/epic behind a run already marked done.
  let allClosed = true;
  for (const ticket of children) {
    if (ticket.status !== "closed") allClosed = (await safe(() => beads.close(repo, ticket.id))) && allClosed;
  }
  if (epic.status !== "closed") allClosed = (await safe(() => beads.close(repo, epic.id))) && allClosed;
  if (allClosed) await safe(() => beads.untag(repo, epic.id, [IN_REVIEW]));

  // 2. Remove the merged branch and its worktree. If the worktree is already gone (the common case),
  //    removeWorktree still prunes and deletes the local branch off a synthetic descriptor.
  const wt: Worktree =
    (await findWorktree(repo, branch)) ??
    { path: worktreePathFor(repo, branch), branch, baseBranch: branch, repoPath: repo };
  await safe(() => removeWorktree(wt, { deleteBranch: true }));

  // 3. Finalize the run row if one is still open (a run already marked done at PR-open is left as-is).
  const run = await findOpenRunForEpic(db, projectId, epic.id);
  if (run) await updateRun(db, clock, run.id, { status: "done", endedAt: clock.now(), error: null });
}

// ── helpers ──

/** Run a best-effort side effect, swallowing failures. Returns true iff `fn` completed. */
async function safe(fn: () => Promise<unknown>): Promise<boolean> {
  try {
    await fn();
    return true;
  } catch {
    // best-effort
    return false;
  }
}
