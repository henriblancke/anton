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
import { beads, LABELS, ownerOf, type BatchOp, type Bead } from "../beads/bd";
import { releaseChildren } from "../beads/child-assign";
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
} from "../git/pr";
import {
  createWorktree,
  findWorktree,
  removeWorktree,
  worktreePathFor,
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
import { findOpenRunForEpic, updateRun } from "../runs";
import { runTickets } from "../ticket-view";
import { appendSessionLog, endSession, startJobSession } from "../sessions";
import {
  buildReviewFixPrompt,
  parseThreadReport,
  type ThreadOutcome,
} from "./review-fix-context";
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
        consoleLog.error(
          `epic ${epic.id} (PR fix) failed; continuing sweep`,
          e,
        );
      }
    }
    // The claude sessions above may have written beads (notes, bd remember); push them.
    // Logged, not thrown — a sync hiccup must not shadow (or fabricate) a sweep failure.
    await beads
      .sync(repo)
      .catch((e) =>
        consoleLog.error("beads dolt sync failed after review-fix sweep", e),
      );

    // Surface a non-quota failure so the job retries/parks — but only after trying every epic.
    if (lastError) {
      throw lastError instanceof Error
        ? lastError
        : new Error(String(lastError));
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

  // Re-materialize the worktree from the PR branch (execute-epic removes it after opening the PR),
  // sync it with origin, and pre-merge the base if GitHub reports a conflict.
  const { worktree, conflicts } = await prepareFixWorktree({
    ctx,
    repo,
    branch,
    settings,
    baseBranch,
    pr,
    number,
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

  const worktree = await createWorktree({
    repoPath: repo,
    branch,
    baseBranch: settings.baseBranch,
    warm: false,
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

  let conflicts: string[] = [];
  if (pr.mergeable === "CONFLICTING" && baseBranch) {
    try {
      const merge = await mergeIntoCurrent(
        worktree.path,
        `origin/${baseBranch}`,
      );
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
    const note =
      item.reply?.trim() ||
      (item.outcome === "fixed"
        ? "addressed in the latest push"
        : "left as-is");
    await safe(() =>
      replyToReviewComment(
        repo,
        number,
        anchor.id,
        `${ANTON_MARK} ${note}`,
        signal,
      ),
    );
    if (item.outcome === "fixed") {
      await safe(() => resolveReviewThread(repo, thread.id, signal));
    }
    await appendSessionLog(
      logPath,
      `[review-fix] thread ${thread.id}: ${item.outcome} — ${note}\n`,
    );
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
  await safe(() =>
    reRequestReview(repo, number, reviewersRequestingChanges(pr), signal),
  );
}

// ── merge finalization (anton-ner.5) ──

/** A child whose commit is on the branch — `in_progress` included, see {@link undeliveredAtMerge}. */
const DELIVERED_AT_MERGE = new Set(["closed", "in_progress"]);

/**
 * Delivery evidence: a status that means a commit landed, and no verdict on top of it saying
 * otherwise. An abandoned child is closed but explicitly undelivered (execute-epic drops it from
 * `live` for the same reason), and a `not-delivered` child is the run that passed it over saying
 * so in as many words — neither carries a mechanism for the tickets behind it.
 */
const deliveredAtMerge = (b: Bead | undefined): boolean =>
  !!b &&
  DELIVERED_AT_MERGE.has(b.status) &&
  !beads.isAbandoned(b) &&
  !beads.isNotDelivered(b);

/**
 * The children a merged target must NOT close — the tickets its run deliberately left for a human
 * (anton-67xj). A merge says the branch shipped, not that every ticket under the target ran, and
 * closing one that never ran turns the bd note it carries into a pointer at work the board now
 * reads as delivered.
 *
 * Two seeds, one rule. A ticket the run BLOCKED says so in its status — its budget ran out and its
 * work was rolled back (anton-t1mo), or it delivered nothing / self-reported blocked. Two narrower
 * sub-shapes — a timeout that fired after the commit, and a post-commit failure — do leave work on
 * the branch; they are held back for the same reason all the same, because their note asks a human
 * to review and close by hand, not because nothing landed. Held back is as far as it goes for them:
 * {@link safeToRerunAtMerge} keeps them off the rerun path, since their work is in the diff. A
 * ticket the run SKIPPED behind one of
 * those says so in its `not-delivered` label instead: it was never dispatched, so it keeps the
 * `open` status the board keeps offering it under and carries no other mark of its own.
 *
 * Then the transitive closure over the run own `blocks` edges, which catches what neither seed can
 * — a dependent skipped by a run too old to write the label, or one whose marker never landed.
 *
 * A DELIVERED dependent stops the walk. Its commit is on the branch whatever its blocker did — the
 * run carries on past a timeout, so a ticket behind one still gets dispatched — and the tickets
 * behind IT have the mechanism they were written against. Delivery is `closed`, or `in_progress`:
 * a child close write is best-effort (execute-epic), so a transient bd failure leaves a ticket
 * that committed claimed and mid-stage. Reading that bookkeeping failure as "never ran" would
 * strand shipped work open, when the merge is precisely what repairs it. An ABANDONED child is the
 * exception (deliveredAtMerge): closed on a won't-do, with no commit behind it, so the walk passes
 * straight through to whatever waited on it.
 */
/**
 * Of the children a merge preserves ({@link undeliveredAtMerge}), the ones anton may hand back to
 * the queue — nothing of theirs can be in the merged diff, so re-running them cannot redo shipped
 * work. Everything else stays on the manual-review path the run's own note already asks for.
 *
 * `not-delivered` is the only positive evidence of absence there is, and a run writes it exactly
 * when it rolled the ticket's work back or never dispatched it — a timeout or a failure that fired
 * AFTER the commit deliberately omits it, because that commit is on the branch. So a `blocked`
 * child without the marker is one whose work the merge may already carry (post-commit timeout,
 * post-commit failure) or one a human must rule on anyway (zero delivery, agent-declared blocked):
 * reopening and rehoming it would advertise a rerun that duplicates or conflicts with the diff.
 *
 * So the lane is an ALLOWLIST of the states that earn a rerun, never "not blocked" (anton-67xj):
 * `open` — a dependent that was never dispatched — and the marker-bearing timed-out ticket whose
 * work was rolled back. That one is normally `blocked`, but need not be: the timeout writes the
 * status best-effort while it RETRIES the marker, so a run whose `blocked` write failed leaves the
 * ticket on the claim it was dispatched under, `in_progress` and marked. Rejecting that shape would
 * strand a ticket with nothing in the diff on the manual-review path over a bookkeeping failure — so
 * it earns the rerun too, but only while the claim is still the dead run's own (or already gone).
 * Any other status a preserved ticket can be in is somebody's own decision about it — a `deferred`
 * snooze, an `in_progress` claim held by another operator — and rehoming or reopening one would
 * overwrite that decision with a rerun nobody asked for.
 */
const safeToRerunAtMerge = (b: Bead, runOwner: string | undefined): boolean => {
  if (b.status === "open") return true;
  if (!beads.isNotDelivered(b)) return false;
  if (b.status === "blocked") return true;
  const owner = ownerOf(b);
  return (
    b.status === "in_progress" && (owner === undefined || owner === runOwner)
  );
};

export function undeliveredAtMerge(children: Bead[]): Set<string> {
  const byId = new Map(children.map((c) => [c.id, c]));
  const keep = new Set(
    children
      .filter((c) => c.status === "blocked" || beads.isNotDelivered(c))
      .map((c) => c.id),
  );
  // blocker id → the run's own tickets waiting on it; edges leaving the run are another gate's
  // business (a ticket held on an outside blocker was never in this run's dispatch set).
  const dependents = new Map<string, string[]>();
  for (const e of beads.edgesOf(children)) {
    if (e.type !== "blocks" || !byId.has(e.from) || !byId.has(e.to)) continue;
    dependents.set(e.to, [...(dependents.get(e.to) ?? []), e.from]);
  }
  const queue = [...keep];
  while (queue.length) {
    for (const dependent of dependents.get(queue.shift()!) ?? []) {
      if (keep.has(dependent) || deliveredAtMerge(byId.get(dependent)))
        continue;
      keep.add(dependent); // never revisited, so a cycle terminates
      queue.push(dependent);
    }
  }
  return keep;
}

/**
 * What a preserved ticket's note says about a reservation finalization did not clear — either an
 * assignee that is not the run's own (deliberately left alone) or this run's own claim that bd
 * refused to release. Silent when ownership is settled. `blocksClaim` is the per-lane consequence
 * clause, since only the rerun lane is stopped by a stale claim.
 */
function ownershipNote(
  bead: Bead,
  owner: string | undefined,
  args: { stillOwned: boolean; foreignOwner: boolean; blocksClaim: string },
): string {
  if (!args.stillOwned) return "";
  return args.foreignOwner
    ? ` It is also assigned to ${owner}, not to the actor this run reserved it for — anton ` +
        `releases only its own claim, so that reservation was left intact${args.blocksClaim}. If ` +
        `it is stale, clear it with \`bd assign ${bead.id} ""\`.`
    : ` It is also still assigned to ${owner} and could not be released${args.blocksClaim}: clear ` +
        `that with \`bd assign ${bead.id} ""\`.`;
}

/**
 * Return a rerunnable preserved ticket to a claimable `open`, and answer the sentence its note must
 * add when that did not happen (empty once the ticket is claimable).
 *
 * The re-read is the point (anton-67xj). `bead` comes off the sweep's snapshot and a PR can sit in
 * review for days: if another worker claimed, reopened onto its own path, or closed this ticket in
 * that window, writing `open` would downgrade their live work — or reopen finished work and
 * advertise it for a second run — on the strength of a status that was already stale. So the
 * transition lands only on a ticket a fresh read still finds exactly where the run left it and held
 * by nobody but that run (which is nobody at all once the release above succeeded). Anything else is
 * another worker's state: left alone, and named in the note instead.
 *
 * A read that fails writes nothing either — the snapshot is not evidence enough to move a status —
 * and falls back to the same manual remedy a failed write leaves behind.
 */
async function reopenPreserved(
  repo: string,
  bead: Bead,
  runOwner: string | undefined,
): Promise<string> {
  const manualRemedy = (status: string): string =>
    ` Its status is also still \`${status}\`, which bd refuses to claim, so a run would stop at ` +
    `that gate: clear it with \`bd update ${bead.id} --status open\`.`;
  if (bead.status === "open") return "";
  const fresh = await beads.show(repo, bead.id).catch(() => undefined);
  if (!fresh) return manualRemedy(bead.status);
  if (fresh.status === "open") return "";
  const owner = ownerOf(fresh);
  if (
    fresh.status !== bead.status ||
    (owner !== undefined && owner !== runOwner)
  )
    return (
      ` Its status is now \`${fresh.status}\`${owner ? ` under ${owner}` : ""} — that changed after ` +
      `the run stopped it, so anton left the status alone rather than reopening a ticket someone ` +
      `else has moved on.`
    );
  const reopened = await safe(() => beads.setStatus(repo, bead.id, "open"));
  return reopened ? "" : manualRemedy(fresh.status);
}

/**
 * Finalize an epic whose PR merged: close the epic + the child tickets it delivered, rehome the
 * ones it did not ({@link undeliveredAtMerge}) onto a fresh run target, drop the `stage:in-review`
 * label, remove the merged branch + its worktree, and finalize the run row.
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
  /**
   * The run target's whole ticket subtree (runTickets), carrying its inline `blocks` edges. Open
   * ones close alongside the epic unless the run left them undelivered ({@link undeliveredAtMerge}).
   */
  children: Bead[];
  /** The merged PR's head branch — the local branch + worktree to clean up. */
  branch: string;
  /** The full board — only for resolving the follow-up epic's `area:` ({@link areaLabelOf}). */
  all: Bead[];
}): Promise<void> {
  const { db, clock, repo, projectId, epic, children, branch, all } = args;

  // 1. Close the remaining open tickets and the target in ONE bd transaction (anton-aijz), children
  //    first. All-or-nothing: a failure part-way leaves every bead exactly as it was, rather than a
  //    half-closed unit no reader can interpret. Only drop the in-review stage once that
  //    transaction lands — a transient failure (swallowed by `safe`) must leave the label in place
  //    so the next review-fix sweep re-selects the epic (inReviewEpics) and retries, rather than
  //    orphaning a still-open ticket/epic behind a run already marked done.
  //
  //    A merged PR does NOT mean every child shipped in it (anton-67xj). A run that absorbed a
  //    ticket timeout opens its PR for the work that DID land and leaves the rest undelivered —
  //    those beads are in no diff, so closing them here would file work that was never done as
  //    shipped and lose it silently, against the note on the bead telling the operator to run it.
  //    They are left open instead, and rehomed for a rerun when nothing of theirs can be in the
  //    diff (1b); the target itself still closes, since the PR it
  //    points at is merged and terminal. The target is never itself "preserved": a leaf run target
  //    marked undelivered has no merged PR to finalize, and excluding it from the close would leave
  //    `stage:in-review` on forever, re-selecting this epic on every sweep.
  const undelivered = undeliveredAtMerge(children);
  const preserved = children.filter(
    (b) => b.id !== epic.id && b.status !== "closed" && undelivered.has(b.id),
  );
  const skip = new Set(preserved.map((b) => b.id));
  const stillOpen = new Map(
    [...children, epic]
      .filter((b) => b.status !== "closed" && !skip.has(b.id))
      .map((b) => [b.id, b]),
  ); // by id: a leaf run target is its own ticket, so it can appear on both sides
  const closed = await safe(() =>
    beads.batch(
      repo,
      [...stillOpen.keys()].map((id): BatchOp => ({ op: "close", id })),
    ),
  );
  if (closed) await safe(() => beads.untag(repo, epic.id, [IN_REVIEW]));

  // 1b. Rehome the preserved tickets that are safe to RE-RUN under a NEW run target, hand each one
  //     back in a claimable state, then say on each of them that the feature shipped without it —
  //     the operator meets this ticket long after the run that skipped it, under a target that now
  //     reads as done.
  //
  //     Rehoming is what makes the instruction actionable (anton-67xj). Left where they are these
  //     tickets are unreachable: a task/bug WITH a parent is never a run target (beads.isRunTarget),
  //     and the parent they hang off has just closed carrying a MERGED PR ref, which execute-epic
  //     short-circuits on as an already-finished run. So neither the ticket nor its old home can be
  //     claimed, and "re-run this" would mean restructuring the board by hand.
  // The actor the finished run reserved its children for: execute-epic's claim cascade assigns every
  // child to the same operator it claimed the target for, so the target's own assignee names it.
  const runOwner = ownerOf(epic);
  const rerunnable = preserved.filter((b) => safeToRerunAtMerge(b, runOwner));
  const followUp = await rehomePreserved(
    repo,
    epic,
    rerunnable,
    preserved,
    children,
    areaLabelOf(epic, all),
    runOwner,
  );
  const rerun = new Set(rerunnable.map((b) => b.id));
  for (const bead of preserved) {
    // Release the reservation the run that skipped this ticket still holds. Its own unassign at
    // skip time is best-effort (and older runs had none), and a claim that outlives its run hides
    // the ticket from `bd ready --unassigned` and refuses the claim cascade of whoever approves the
    // follow-up — so the rerun path the note advertises works only once ownership is cleared. When
    // it cannot be, the note says so rather than pointing at a target no one can claim through.
    // A ticket on the manual path is released too: nobody is running it, and a dead run's claim
    // only misreports who owns the review it is waiting for.
    //
    // ONLY this run's own claim, matched by actor and swapped under a CAS (anton-67xj). A PR can sit
    // in review for days, and an operator who picked a preserved ticket up in that window is doing
    // live work: clearing THAT assignee would advertise their ticket as claimable and invite a
    // second run of it. So an owner that is not the run's own — including any owner at all when the
    // run had no identity to reserve under — is left exactly as it is and named in the note
    // instead. The CAS closes the same window one step narrower: `bead` came off the sweep's
    // snapshot, so a takeover that landed since it was read loses nothing here either.
    const owner = ownerOf(bead);
    const foreignOwner = owner !== undefined && owner !== runOwner;
    const released =
      owner !== undefined &&
      !foreignOwner &&
      (await releaseChildren(repo, [bead.id], owner)).released.length > 0;
    const stillOwned = owner !== undefined && !released;
    // Return the ticket to a claimable status. A timed-out one carries `blocked` from the run that
    // stopped it, and bd refuses to claim a bead in that status — so an operator who approves the
    // follow-up target would watch every attempt die at execute-epic's claim gate before this work
    // could run. The parent makes the ticket reachable; the status is what makes it runnable. A
    // ticket already `open` (a dependent skipped behind the timeout) is left untouched, and one on
    // the manual path stays `blocked` on purpose — it must not become runnable.
    // …unless another operator moved it out of this target since the sweep read the board
    // (rehomePreserved): the ticket is theirs now, and its status is part of the state they are
    // running it in.
    // …or moved on in place: a ticket someone has since claimed, closed or snoozed keeps the status
    // they put it in, so the reopen is skipped for the same reason the reparent was.
    const takenOver = followUp.elsewhere.has(bead.id);
    const movedOn = followUp.changed.get(bead.id);
    const statusNote =
      rerun.has(bead.id) && !takenOver && !movedOn
        ? await reopenPreserved(repo, bead, runOwner)
        : "";
    // Three lanes, three different things to tell the operator who meets this ticket later: the
    // rerun lane, the post-commit lane (no marker — its work IS in the merged diff), and a ticket
    // whose status is somebody's own decision, which anton neither reruns nor asks a human to
    // review against the branch.
    const decidedElsewhere = !rerun.has(bead.id) && beads.isNotDelivered(bead);
    await safe(() =>
      beads.note(
        repo,
        bead.id,
        decidedElsewhere
          ? `anton: the pull request for ${epic.id} merged WITHOUT this ticket — the run did not ` +
              `deliver it (see the note above), so none of its work is in that diff. Its status is ` +
              `\`${bead.status}\`, which is someone's own decision about this ticket rather than ` +
              `the run's, so anton left it under ${epic.id} and did NOT queue it for a rerun. Once ` +
              `that is settled, move it onto a fresh run target ` +
              `(\`bd update ${bead.id} --parent <new-epic>\`) to have anton pick the work back up.` +
              ownershipNote(bead, owner, {
                stillOwned,
                foreignOwner,
                blocksClaim: "",
              })
          : !rerun.has(bead.id)
            ? `anton: the pull request for ${epic.id} merged while this ticket was still ` +
              `\`${bead.status}\` — the run stopped it and carried on (see the note above). It ` +
              `is NOT marked \`${LABELS.notDelivered}\`, so whatever it committed before it ` +
              `stopped is in that merged diff. Left on the board rather than closed, and ` +
              `deliberately NOT queued for a rerun: re-running it would redo work the merge ` +
              `already shipped. Review the branch against the note above, then close this by hand ` +
              `if it is complete, or file the remainder as a new ticket.` +
              ownershipNote(bead, owner, {
                stillOwned,
                foreignOwner,
                blocksClaim: "",
              })
            : `anton: the pull request for ${epic.id} merged WITHOUT this ticket — the run did ` +
              `not deliver it (see the note above), so none of its work is in that diff. Left ` +
              `open on purpose: closing it here would file work that was never done as shipped. ` +
              (takenOver
                ? `Another operator moved it under ` +
                  `${followUp.elsewhere.get(bead.id) ?? "a different target"} while the pull ` +
                  `request was in review, so anton left it there rather than rehoming it — that ` +
                  `target owns this work now.`
                : movedOn
                  ? `Its status is now ${movedOn} — someone's own decision about this ticket ` +
                    `rather than the run's, so anton left it under ${epic.id}, status untouched, ` +
                    `rather than queueing a rerun on top of it. Once that is settled, ` +
                    `move it onto a fresh run target (\`bd update ${bead.id} --parent ` +
                    `<new-epic>\`) to have anton pick the work back up.`
                  : followUp.id && followUp.nested.has(bead.id)
                    ? `It stays nested under ${followUp.nested.get(bead.id)}, which anton moved ` +
                      `onto ${followUp.id}, a fresh run target — approve that target to have anton ` +
                      `pick this work back up.`
                    : followUp.id && followUp.moved.has(bead.id)
                      ? `It now lives under ${followUp.id}, a fresh run target — approve that ` +
                        `target to have anton pick this work back up.`
                      : followUp.pinned.has(bead.id)
                        ? `It was NOT rehomed: ${followUp.pinned.get(bead.id)} still hangs off ` +
                          `it, and anton left that ticket where it is — moving this one would ` +
                          `have carried it onto a fresh target too. Settle that ticket first, ` +
                          `then move this one under a new epic ` +
                          `(\`bd update ${bead.id} --parent <new-epic>\`) to have anton pick the ` +
                          `work back up.`
                        : `It could NOT be rehomed onto a fresh run target, so nothing anton ` +
                          `runs reaches it yet: move it under a new epic ` +
                          `(\`bd update ${bead.id} --parent <new-epic>\`) or clear its parent ` +
                          `to make it a run target of its own.`) +
              ownershipNote(bead, owner, {
                stillOwned,
                foreignOwner,
                blocksClaim: ", so no other operator can claim it",
              }) +
              statusNote,
      ),
    );
  }

  // 2. Remove the merged branch and its worktree. If the worktree is already gone (the common case),
  //    removeWorktree still prunes and deletes the local branch off a synthetic descriptor.
  const wt: Worktree = (await findWorktree(repo, branch)) ?? {
    path: worktreePathFor(repo, branch),
    branch,
    baseBranch: branch,
    repoPath: repo,
  };
  await safe(() => removeWorktree(wt, { deleteBranch: true }));

  // 3. Finalize the run row if one is still open (a run already marked done at PR-open is left as-is).
  const run = await findOpenRunForEpic(db, projectId, epic.id);
  if (run)
    await updateRun(db, clock, run.id, {
      status: "done",
      endedAt: clock.now(),
      error: null,
    });
}

/**
 * Move the tickets a merged PR did not contain, and that are safe to run again
 * ({@link safeToRerunAtMerge}), under a NEW epic — and answer that epic's id (undefined when there
 * is nothing to rehome, or bd refused). An epic with no `feature` children is a run target, so the
 * preserved work becomes claimable and runnable again — see the caller for why leaving it under the
 * merged target does not.
 *
 * Deliberately NOT `approved`: approval is the founder's gate, and re-running work a run already
 * failed to deliver — after a timeout, possibly needing re-scoping first — is exactly the decision
 * that gate exists for. It carries the epic-tier contract (an outcome and Success Criteria) so the
 * approve route and execute-epic's own gate admit it rather than refusing a target anton wrote.
 *
 * Nesting is preserved: only the ROOTS of the rehomed forest are reparented, and a ticket that
 * hangs off another moving ticket rides along on it. `subtree` is the run's whole ticket set
 * (runTickets), which is what tells a legitimately nested ticket apart from one another operator
 * moved onto a target of their own. The ride-along cuts both ways, so a ticket that still carries a
 * preserved descendant anton is NOT moving stays put as well ({@link Rehomed.pinned}), and a
 * DELIVERED descendant is detached back onto the merged target before its ancestor moves — its work
 * is in that merged diff, and carrying it onto a fresh branch is how a squash-merged ticket gets
 * re-run (pass 1c).
 *
 * Best-effort, like every other write here: a failure leaves the tickets parented where they were —
 * still open, still noted with the manual remedy — rather than aborting a finalization whose closes
 * have already landed. An epic that ends up with no children at all is deleted again, since a
 * childless epic is a poison run rather than a home.
 */
async function rehomePreserved(
  repo: string,
  epic: Bead,
  rerunnable: Bead[],
  preserved: Bead[],
  subtree: Bead[],
  area: string | undefined,
  runOwner: string | undefined,
): Promise<Rehomed> {
  const none: Rehomed = {
    moved: new Set(),
    nested: new Map(),
    elsewhere: new Map(),
    changed: new Map(),
    pinned: new Map(),
  };
  if (rerunnable.length === 0) return none;
  const ids = rerunnable.map((b) => b.id).join(", ");
  let followUp: string;
  try {
    followUp = await beads.create(repo, {
      title: `${epic.title} — undelivered tickets`,
      type: "epic",
      // The roadmap groups by `area:`, and the contract wants exactly one: inherit the merged
      // target's so the follow-up lands in the same column its work was always meant to ship in.
      labels: area ? [area] : [],
      description:
        `The pull request for ${epic.id} merged without ${ids}. The run that opened it ran out of ` +
        `time, so that work is in no diff — this epic is its home, because a ticket parented to an ` +
        `already-merged target is not something anton can run.\n\n` +
        `Approve this epic to have anton pick the work back up; re-scope or close the tickets ` +
        `first if the timeout means they were too big.`,
      acceptance: `- [ ] Every ticket below is delivered, or closed as no longer wanted.`,
    });
  } catch {
    return none;
  }
  const moved = new Set<string>();
  const nested = new Map<string, string>();
  const elsewhere = new Map<string, string | undefined>();
  const changed = new Map<string, string>();

  // Belonging is ANCESTRY, not the direct parent (anton-67xj). A run owns every working-layer
  // descendant of its target (runTickets), and bd nesting is arbitrary-depth — so a ticket hanging
  // off another ticket is legitimately part of this run while its parent is not the epic. Reading
  // the direct parent filed every one of those as work another operator had moved: a nested ticket
  // whose parent shipped stayed stranded under the merged target, and one whose parent moved too
  // followed it without ever passing through reopenPreserved, so nothing could claim it.
  // The whole chain is re-read, not just the candidate. `subtree` is the sweep's snapshot, and an
  // ANCESTOR another operator reparented since carries every ticket beneath it out of this run:
  // resolving the walk from the snapshot answers "still on the merged target" for work that is now
  // somebody else's, and reparents it out of their target into this follow-up. Every read is
  // memoised, so a chain shared by several candidates costs one `bd show` per bead, not one per walk.
  const bySubtreeId = new Map(subtree.map((b) => [b.id, b]));
  const fresh = new Map<string, Bead | undefined>();
  const readFresh = async (id: string): Promise<Bead | undefined> => {
    if (!fresh.has(id))
      fresh.set(id, await beads.show(repo, id).catch(() => undefined));
    return fresh.get(id);
  };
  const liveParentOf = async (bead: Bead): Promise<string | undefined> =>
    beads.parentOf((await readFresh(bead.id)) ?? bead);
  const ridesOnTarget = async (
    candidate: Bead,
  ): Promise<"target" | "elsewhere" | "unknown"> => {
    const seen = new Set<string>([candidate.id]);
    let parentId = beads.parentOf(candidate);
    while (parentId && !seen.has(parentId)) {
      if (parentId === epic.id) return "target";
      seen.add(parentId); // a parent cycle terminates rather than hanging finalization
      if (!bySubtreeId.has(parentId)) return "elsewhere"; // left the subtree — another target owns it
      const parent = await readFresh(parentId);
      if (!parent) return "unknown"; // an unreadable link proves nothing either way
      parentId = beads.parentOf(parent);
    }
    return "elsewhere";
  };

  // Pass 1 — re-read every candidate and decide which ones the follow-up may still take
  // (anton-67xj). `rerunnable` comes off the sweep's snapshot and a PR can sit in review for days:
  // if another operator has reparented this ticket onto a target of their own since, moving it here
  // steals it out from under a run that may already be executing it — which then trips that run's
  // own ticket-set drift check and parks it. A read that fails moves nothing either, for the same
  // reason the status write doesn't: the snapshot is not evidence enough on its own.
  const takeable = new Map<string, Bead>();
  for (const bead of rerunnable) {
    const candidate = await readFresh(bead.id);
    if (!candidate) continue;
    const belonging = await ridesOnTarget(candidate);
    // An unreadable ancestor decides nothing — neither that the ticket still rides on the merged
    // target nor that somebody took it — so it moves nothing and claims neither in its note.
    if (belonging === "unknown") continue;
    if (belonging === "elsewhere") {
      elsewhere.set(bead.id, beads.parentOf(candidate));
      continue;
    }
    // The parent is only half of what went stale. In the same window the ticket can have been
    // claimed, closed or snoozed in place, or taken over by another operator — and a rerun lane
    // earned by the snapshot is not one the board still grants: moving a now-active ticket hands a
    // second run the work someone is doing, and moving a closed one puts finished work under a
    // follow-up branch that carries no commit for it, which execute-epic then reads as a
    // cross-machine resume and runs again. So the allowlist is re-applied to the fresh read, and a
    // claim that changed hands since the snapshot disqualifies it however it reads.
    //
    // Ownership is checked here on its own, not left to the allowlist: `safeToRerunAtMerge` weighs
    // the assignee only on the `in_progress` lane, so an `open` or `blocked` ticket another
    // operator had already reserved BEFORE the sweep read the board passes it — and reads as no
    // takeover either, since the snapshot carries the same foreign owner. Reparenting that one
    // advertises work somebody holds under a second target. Any owner but the dead run's own is a
    // live reservation, whenever it landed.
    const freshOwner = ownerOf(candidate);
    const heldByOther = freshOwner !== undefined && freshOwner !== runOwner;
    const tookOver = freshOwner !== undefined && freshOwner !== ownerOf(bead);
    if (!safeToRerunAtMerge(candidate, runOwner) || heldByOther || tookOver) {
      changed.set(bead.id, stateOf(candidate));
      continue;
    }
    takeable.set(bead.id, candidate);
  }

  // Pass 1b — a reparent is an edge on the ANCESTOR alone (anton-67xj). A ticket pass 1 refused
  // keeps its own parent, so moving that parent carries it onto the follow-up regardless: a
  // reservation another operator holds, or a status a human set, ends up advertised under a target
  // anton wrote — and the note telling them anton left it under the merged target becomes false. So
  // a ticket carrying one stays where it is, named with what pinned it; its own takeable descendants
  // still flatten onto the follow-up in pass 2, exactly as when bd refuses a reparent.
  //
  // Only the PRESERVED tickets can pin. Everything else in the subtree closed with the merge, so it
  // holds no reservation and no pending decision — it is detached in 1c instead, while blocking on
  // delivered work would strand a parent merely because part of it shipped.
  const pinned = new Map<string, string>();
  const pinAncestors = async (bead: Bead): Promise<void> => {
    const seen = new Set<string>([bead.id]);
    let parentId = await liveParentOf(bead);
    while (parentId && !seen.has(parentId)) {
      seen.add(parentId); // a parent cycle terminates rather than hanging finalization
      if (takeable.has(parentId) && !pinned.has(parentId))
        pinned.set(parentId, bead.id);
      const parent = bySubtreeId.get(parentId);
      if (!parent) break; // the chain left the run's subtree — nothing moving carries this ticket
      parentId = await liveParentOf(parent);
    }
  };
  for (const bead of preserved) {
    if (takeable.has(bead.id)) continue;
    await pinAncestors(bead);
  }

  // Pass 1c — a DELIVERED descendant is taken off its ancestor BEFORE that ancestor moves
  // (anton-67xj). The reparent carries the whole subtree with it, so a ticket that shipped in this
  // merge would land under the follow-up too — and a squash-merge leaves none of its `<id>:` commit
  // subjects on the follow-up's fresh branch, so execute-epic reads that closed ticket as a
  // cross-machine resume: it reopens it and re-runs work the merge already shipped. Detaching it
  // onto the merged target keeps it with the diff that carries it, on a closed and terminal home
  // nothing anton runs reaches again.
  //
  // Only DIRECT children need a write — detaching one carries its own descendants with it — and a
  // detach that does not land pins the ancestor exactly as an undelivered descendant does: a move
  // anton cannot make safe must not happen at all.
  const preservedIds = new Set(preserved.map((b) => b.id));
  for (const bead of subtree) {
    if (preservedIds.has(bead.id)) continue;
    const parentId = beads.parentOf(bead);
    if (!parentId || !takeable.has(parentId) || pinned.has(parentId)) continue;
    const shipped = await readFresh(bead.id);
    // Still the sweep's evidence until the board confirms it: a ticket another operator has since
    // moved off this ancestor rides on nothing, and detaching would rewrite an edge that is theirs.
    if (shipped && beads.parentOf(shipped) !== parentId) continue;
    if (shipped && (await safe(() => beads.reparent(repo, bead.id, epic.id))))
      continue;
    await pinAncestors(bead);
  }

  // Pass 2 — move them ancestors first. A ticket whose own parent is moving rides along on it
  // rather than being flattened onto the follow-up: the nesting is how its work was scoped, and
  // reparenting it separately would hand the same subtree two homes. Ordering is what makes that
  // safe — the ride-along is decided on what actually MOVED, so a parent whose reparent bd refused
  // leaves its descendant to take a home of its own rather than staying stranded behind it.
  for (const mover of ancestorsFirst(takeable)) {
    if (pinned.has(mover.id)) continue;
    const parentId = beads.parentOf(mover);
    if (parentId && moved.has(parentId)) {
      nested.set(mover.id, parentId);
      moved.add(mover.id);
      continue;
    }
    if (await safe(() => beads.reparent(repo, mover.id, followUp)))
      moved.add(mover.id);
  }
  if (moved.size > 0)
    return { id: followUp, moved, nested, elsewhere, changed, pinned };
  // Nothing moved — the new epic is an empty run target no one asked for. Take it back off the board.
  await safe(() => beads.delete(repo, followUp));
  return { moved: new Set(), nested, elsewhere, changed, pinned };
}

/**
 * The beads of a rehome set ordered so a ticket always follows every ancestor that is moving with
 * it — depth within the set, which is stable under a sort that preserves board order among peers.
 */
function ancestorsFirst(takeable: Map<string, Bead>): Bead[] {
  const depth = (bead: Bead): number => {
    const seen = new Set<string>([bead.id]);
    let steps = 0;
    let parentId = beads.parentOf(bead);
    while (parentId && !seen.has(parentId)) {
      const parent = takeable.get(parentId);
      if (!parent) break;
      seen.add(parentId); // a parent cycle terminates rather than hanging finalization
      steps++;
      parentId = beads.parentOf(parent);
    }
    return steps;
  };
  return [...takeable.values()].sort((a, b) => depth(a) - depth(b));
}

/** A ticket's live state as a note fragment: the status, and who holds it when anyone does. */
function stateOf(bead: Bead): string {
  const owner = ownerOf(bead);
  return `\`${bead.status}\`${owner ? ` under ${owner}` : ""}`;
}

/**
 * The `area:` label a merged target's follow-up epic inherits: the target's own, else the nearest
 * ancestor that carries one.
 *
 * Walking up is what makes this work for the normal shape (anton-67xj). A `feature` run target
 * carries no `area:` of its own — the Add-work path puts it on the PRODUCT EPIC above the feature
 * (lib/backlog.ts) and every roadmap/board reader resolves it from there. Reading only the merged
 * target's labels would leave the follow-up arealess: ungrouped on the roadmap, missing the Linear
 * routing key, and flagged by the contract validator — and it has no parent of its own to derive
 * one from, since it lands top-level.
 */
function areaLabelOf(bead: Bead, all: Bead[]): string | undefined {
  const seen = new Set<string>();
  let current: Bead | undefined = bead;
  while (current && !seen.has(current.id)) {
    seen.add(current.id); // a parent cycle terminates rather than hanging finalization
    const area = (current.labels ?? []).find((l) => l.startsWith("area:"));
    if (area) return area;
    const parent = beads.parentOf(current);
    current = parent ? all.find((b) => b.id === parent) : undefined;
  }
  return undefined;
}

/** Where {@link rehomePreserved} got to: the new target's id, and which tickets actually reached it. */
interface Rehomed {
  id?: string;
  /** Every ticket that ended up beneath the follow-up — reparented onto it, or {@link nested}. */
  moved: Set<string>;
  /**
   * Ticket id → the ticket it stayed nested under, which anton moved onto the follow-up. These
   * reached the new target without a reparent of their own, so their note must name the parent
   * they ride on rather than claim they sit directly under the follow-up.
   */
  nested: Map<string, string>;
  /**
   * Tickets a fresh read found outside the merged target's subtree — another operator rehomed them
   * while the PR sat in review. Left exactly where they are, and told apart from a move that merely
   * failed: their note must not hand the operator a `--parent` command that would undo that.
   */
  elsewhere: Map<string, string | undefined>;
  /**
   * Tickets a fresh read no longer finds rerunnable — claimed, closed or snoozed since the sweep,
   * or reserved by an operator other than the run's own whenever that claim landed. Left where
   * they are, status untouched, and named by their live state in the note.
   */
  changed: Map<string, string>;
  /**
   * Ticket id → the preserved ticket hanging off it that anton is NOT moving. Reparenting would
   * carry that descendant onto the follow-up on its own parent edge, so the ancestor stays under
   * the merged target instead, and its note names what pinned it rather than the generic remedy.
   */
  pinned: Map<string, string>;
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
