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
  commitAttemptMode,
  commitParentShas,
  exitedWith,
  git,
  isAncestor,
  readWorktreeState,
  fetchOrigin,
  mergeIntoCurrent,
  needsHooksPathOverrideForMerge,
  pushBranch,
  readPullRequestBody,
  resolveCommitSha,
  resolveHooksPathOverride,
  resolveHooksPathOverrideForMerge,
  stageAll,
  updatePullRequestBody,
} from "../git/ops";
import {
  ANTON_MARK,
  classifyReview,
  commentOnPr,
  getPrActivity,
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
  warmWorktreeBestEffort,
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
  resolveWarmConfig,
  type ProjectSettings,
} from "../projects";
import { captureVerifyGates, type VerifyGateOutcome } from "./shell";
import { tailLines } from "./review-context";
import { findOpenRunForEpic, type RunRow } from "../runs";
import { runTickets } from "../ticket-view";
import { appendSessionLog, endSession, startJobSession } from "../sessions";
import type { ClaudeEvent } from "../claude/driver";
import {
  buildReviewFixPrompt,
  fabricatedFix,
  NON_THREAD_REPORT_ID,
  parseThreadReport,
  triageOutcomes,
  type ThreadOutcome,
} from "./review-fix-context";
import {
  recordPrReopened,
  recordPrTerminalState,
  recordReviewRound,
  unsettledPrNumbers,
} from "../review-rounds";
import {
  fallbackReasonsFor,
  fixRoundFrom,
  nextFixRoundsRegion,
  sentinelFixEntry,
} from "./review-fix-body";
import { upsertBodyRegion } from "./steps/prompts";
import { IN_REVIEW } from "./review-fix-board";
import { safe } from "./safe";
import { finalizeMergedEpic } from "./review-fix-finalize";
import { isPoisonError, PoisonError } from "./errors";
import type { AntonDb, Clock } from "./queue";
import {
  invalidateReviewFixAttempt,
  recordReviewFixAnswered,
  recordReviewFixAttempt,
  reviewFixPrAnsweredUnchanged,
  reviewFixPrParkedAtHead,
  systemClock,
} from "./queue";
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
  const clock = deps.clock ?? systemClock;
  return (ctx: JobContext) => dispatchInReview({ db, clock, ctx });
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
async function dispatchInReview(args: {
  db: AntonDb;
  clock: Clock;
  ctx: JobContext;
}): Promise<JobEffect> {
  const { db, clock, ctx } = args;
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

  let dispatched = 0;
  // A target the dispatcher declined to (re-)dispatch even though it needs a fix (anton-bzm7s): a
  // `parked` row for it already sits at this exact PR head, so a fresh attempt would just fail
  // identically — counted apart from `dispatched` so an operator reading the pass's note can tell
  // this suppressed target from a merely-idle one (a clean PR never reaches this loop's insides).
  let suppressedParked = 0;
  // A target whose last round ANSWERED the review feedback (replied to threads, maybe re-requested
  // review) but pushed no commit, at the SAME head and the SAME actionable reasons as right now
  // (anton-dfuvz) — some reasons no code change can satisfy (a PR-body waiver line, a CI check stuck
  // re-evaluating the same commit), so re-dispatching every pass would burn a full session on the
  // same answer forever. Counted apart from both `dispatched` and `suppressedParked` for the same
  // reason those are counted apart from each other.
  let suppressedAnswered = 0;
  // A row `recordPrReopened` actually unsettled — a reopened, still-clean PR whose only effect this
  // pass is that write (anton PR #335 follow-up review): without counting it, `changed` below would
  // report `false` even though a row moved, contradicting `JobEffect.changed`'s contract.
  let reopened = 0;
  // A CLOSED target this pass actually stamped a terminal row for (anton PR #335 review): a
  // closed-and-never-dispatched PR whose only effect this pass is that stamp would otherwise fall
  // through to `changed: false`, the same contradiction `reopened` above exists to avoid — counted
  // apart from `reconciled` since that counter is the orphan sweep's own transitions, not a target's.
  let closedStamped = 0;
  let lastError: unknown;
  for (const target of targets) {
    await ctx.heartbeat();
    try {
      const triage = await needsFix(repo, target, ctx.signal);
      // A CLOSED-unmerged PR ends here (anton-z5e3g): it is not actionable, so it is never
      // dispatched, and this triage read is the ONLY place anton observes the close at all. The
      // target keeps its `stage:in-review` and PR ref for a recovery run, so it is re-read every
      // pass — the stamp is first-observation-wins and writes nothing once it has landed.
      if (triage.state === "CLOSED" && triage.prNumber !== undefined) {
        if (
          await recordPrTerminalState(db, clock, {
            projectId,
            prNumber: triage.prNumber,
            state: "closed",
          })
        ) {
          closedStamped += 1;
        }
      }
      // The counterpart observation (PR #335 review): a PR that reopens, stays clean, and closes
      // again would otherwise leave no evidence of the reopen for the next close to find.
      if (triage.state === "OPEN" && triage.prNumber !== undefined) {
        if (await recordPrReopened(db, { projectId, prNumber: triage.prNumber })) {
          reopened += 1;
        }
      }
      if (!triage.needsFix) continue;
      // Through the runner, not the queue helper: the `gh` read above yields, and a project delete
      // landing inside it must refuse this insert or teardown fails over the row (PR #250 review).
      // The head SHA lets the runner's dedupe suppress a doomed retry — see `enqueueReviewFixPrIfAbsent`.
      // `fingerprint` is only ever set for the classifyReview (non-merged) branch, so a merged
      // target's dispatch is never caught by the answered check either.
      const jobId = ctx.enqueueReviewFixPr(projectId, target.id, triage.headSha, triage.fingerprint);
      if (jobId) {
        dispatched += 1;
        continue;
      }
      if (
        triage.headSha &&
        reviewFixPrParkedAtHead(db, projectId, target.id, triage.headSha, triage.fingerprint)
      ) {
        suppressedParked += 1;
        consoleLog.info(
          `epic ${target.id}: suppressed — parked review-fix-pr at unchanged head ${triage.headSha}`,
        );
      } else if (
        triage.headSha &&
        triage.fingerprint &&
        reviewFixPrAnsweredUnchanged(db, projectId, target.id, triage.headSha, triage.fingerprint)
      ) {
        suppressedAnswered += 1;
        consoleLog.info(
          `epic ${target.id}: suppressed — answered at unchanged head ${triage.headSha} with the same actionable reasons`,
        );
      }
    } catch (e) {
      // One unreadable PR must not cost the others their dispatch; the failure is surfaced below.
      lastError = e;
      consoleLog.error(`epic ${target.id}: triage failed; continuing fan-out`, e);
    }
  }

  // Terminal reconciliation, independent of board membership (PR #335 review): a round's own
  // post-insert freshness check (`handleEpic`, below) can still race a merge that another instance
  // finalizes mid-`getPrReview` — that instance's `finalizeMergedTarget` clears `stage:in-review` and
  // closes the epic before this row is even inserted, so the PR never appears in `targets` again (not
  // even as an empty pass — `targets.length === 0` used to return before this ran at all) and its
  // row's `pr_state` would stay null forever. Reconcile every PR this project has an unsettled round
  // for that this pass did NOT already triage above (those are already covered) by reading it
  // directly — one `gh` read per orphaned PR, which is rare by construction. Only on the untargeted,
  // whole-project sweep: a single-epic run (`epicBeadId` set) has no reason to scan every PR.
  //
  // Reads `getPrActivity` (state only), not `getPrReview` (reviews + CI rollup + paginated thread
  // GraphQL): reconciliation only ever inspects `.state`, and a `closed` orphan is kept in
  // `unsettledPrNumbers` indefinitely for a possible reopen/merge, so every recurring untargeted
  // sweep would otherwise pay `getPrReview`'s full cost for every historical closed PR forever
  // (PR #335 review).
  let reconciled = 0;
  if (!epicBeadId) {
    const triagedNumbers = new Set(
      targets.map((t) => prNumberFromRef(beads.getPrRef(t))).filter((n): n is number => n !== undefined),
    );
    // `targets` already dropped any epic a DIFFERENT operator claimed (`ownedByOperator`, above) —
    // that PR is still actively worked by its owner, not orphaned, and its round row commonly still
    // has `pr_state` null while that work is in flight. Without excluding it too, every operator on
    // a shared board would re-read every OTHER operator's in-review PR here on every pass, scaling
    // with total shared-board activity instead of true orphans (PR #335 review).
    //
    // Restricted to ACTIVE in-review targets (open, run-target, still tagged in-review), not every
    // bead a different operator has ever been assigned (PR #335 review): an epic another operator
    // finished and closed keeps its assignee forever, so scoping this from `all` unfiltered would
    // exclude that PR from reconciliation permanently — even though no operator's dispatch loop will
    // ever touch it again once it's closed, and its round row could be stuck with a null `pr_state`.
    const claimedByOtherOperator = new Set(
      all
        .filter(
          (b) =>
            beads.isRunTarget(b, all) &&
            b.status !== "closed" &&
            (b.labels?.includes(IN_REVIEW) ?? false) &&
            !ownedByOperator(b, operator),
        )
        .map((b) => prNumberFromRef(beads.getPrRef(b)))
        .filter((n): n is number => n !== undefined),
    );
    const orphaned = (await unsettledPrNumbers(db, projectId, clock)).filter(
      (n) => !triagedNumbers.has(n) && !claimedByOtherOperator.has(n),
    );
    for (const prNumber of orphaned) {
      await ctx.heartbeat();
      try {
        const latest = await getPrActivity(repo, prNumber, ctx.signal);
        if (latest.state === "MERGED") {
          if (await recordPrTerminalState(db, clock, { projectId, prNumber, state: "merged" })) {
            reconciled += 1;
          }
        } else if (latest.state === "CLOSED") {
          if (await recordPrTerminalState(db, clock, { projectId, prNumber, state: "closed" })) {
            reconciled += 1;
          }
        } else if (latest.state === "OPEN") {
          // The orphan's own counterpart to the per-target OPEN observation above (PR #335 review):
          // an orphan stamped `closed` that GitHub now reports reopened has no null row for the next
          // close to find (nothing here ever writes a fresh round), so without this the state chain
          // has no OPEN branch and a second close reads as a repeated poll of the first.
          if (await recordPrReopened(db, { projectId, prNumber })) {
            reopened += 1;
          }
        }
      } catch (e) {
        // `heartbeat()` never throws for an aborted signal, so without this check a no-progress
        // timeout firing mid-read looks like an ordinary unreadable PR and the pass can settle as
        // done instead of retrying (PR #335 review).
        if (ctx.signal.aborted) throw e;
        // One unreadable orphaned PR must not block reconciling the rest — it stays null and is
        // retried next pass, the same as any other best-effort read in this job.
        consoleLog.error(`PR #${prNumber}: orphaned-round reconciliation read failed`, e);
      }
    }
  }

  // Surface the failure so the job retries/parks — but only after triaging every target, so a
  // reported pass never claims a clean sweep over a PR it could not actually read.
  if (lastError !== undefined) {
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  if (targets.length === 0 && reconciled === 0 && reopened === 0 && closedStamped === 0) {
    return { changed: false, note: "nothing in review" };
  }

  // The dispatch is the effect: an examined PR with nothing to do is a poll that correctly did
  // nothing, and the counts together are what an operator checks the poll against.
  const suppressedParts: string[] = [];
  if (suppressedParked > 0) suppressedParts.push(`suppressed ${suppressedParked} (parked, unchanged head)`);
  if (suppressedAnswered > 0) suppressedParts.push(`suppressed ${suppressedAnswered} (answered, unchanged)`);
  const suppressedNote = suppressedParts.length > 0 ? `, ${suppressedParts.join(", ")}` : "";
  const reconciledNote = reconciled > 0 ? `, reconciled ${reconciled} orphaned PR(s)` : "";
  const reopenedNote = reopened > 0 ? `, reopened ${reopened} PR(s)` : "";
  const closedNote = closedStamped > 0 ? `, closed ${closedStamped} PR(s)` : "";
  return {
    changed: dispatched > 0 || reconciled > 0 || reopened > 0 || closedStamped > 0,
    note: `examined ${targets.length} PR(s) in review, dispatched ${dispatched}${suppressedNote}${reconciledNote}${reopenedNote}${closedNote}`,
  };
}

/** What one target's triage decided, and the PR head it decided it against (anton-bzm7s). */
interface FixTriage {
  needsFix: boolean;
  /** The PR head's commit SHA — undefined only if the PR could not be identified. */
  headSha?: string;
  /**
   * `classifyReview`'s fingerprint for the current PR state (anton-dfuvz) — what
   * `enqueueReviewFixPrIfAbsent` keys its answered suppression on, alongside `headSha`. Only ever
   * set on the classifyReview (non-merged) branch: a merged target's finalization must never be
   * suppressed by a stale answered round from before it merged.
   */
  fingerprint?: string[];
  /** OPEN | MERGED | CLOSED as the triage read it; undefined when there is no PR to read. */
  state?: string;
  /** The PR this triage read, undefined when the target names none. */
  prNumber?: number;
}

/**
 * Does this target need a fix job? MERGED (finalization is pending) or an actionable review —
 * anything else is a clean PR that costs nothing to leave alone. One `gh` read per target, the same
 * read `handleEpic` repeats when the dispatched job actually runs: PR state can change in between,
 * and the fix re-decides against what it finds rather than trusting this triage. The head SHA rides
 * along on the same read — it is what `enqueueReviewFixPrIfAbsent` keys its park and answered
 * suppressions on.
 */
async function needsFix(
  repo: string,
  target: Bead,
  signal: AbortSignal,
): Promise<FixTriage> {
  const number = prNumberFromRef(beads.getPrRef(target));
  if (number === undefined) return { needsFix: false };
  const pr = await getPrReview(repo, number, signal);
  const headSha = pr.headSha || undefined;
  if (pr.state === "MERGED") {
    return { needsFix: true, headSha, state: pr.state, prNumber: number };
  }
  const verdict = classifyReview(pr);
  return {
    needsFix: verdict.actionable,
    headSha,
    fingerprint: verdict.fingerprint,
    state: pr.state,
    prNumber: number,
  };
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
    const { outcome, ledgerChanged } = await handleEpic({
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
    // A "clean" or "incomplete" outcome (nothing pushed, nothing resolved) can still have stamped
    // a terminal/reopen row below (PR #335 review) — that write is this pass's only effect, so
    // `changed` must reflect it or automation history claims a job that moved the ledger did
    // nothing. Neither outcome is itself a change: "incomplete" means the round left the feedback
    // unaddressed (PR #338 review, chatgpt-codex-connector), so it must not read as progress any
    // more than "clean" does.
    const isNoOp = outcome === "clean" || outcome === "incomplete";
    return {
      changed: !isNoOp || ledgerChanged,
      note: `${epic.id}: ${OUTCOME_NOTE[outcome]}`,
    };
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
type PrFixOutcome = "merged" | "pushed" | "answered" | "incomplete" | "clean";

const OUTCOME_NOTE: Record<PrFixOutcome, string> = {
  merged: "PR merged — finalized",
  pushed: "pushed a fix for the review feedback",
  // Claude produced no diff, but the threads it triaged were still answered — saying "fixed" here
  // would claim a push that never happened.
  answered: "answered the review feedback; nothing to push",
  // Nothing pushed AND the thread report was missing/partial — the feedback is still genuinely
  // waiting on anton. Must read differently from "answered" (PR #338 review, chatgpt-codex-
  // connector): that note claims the round finished, which automation history would otherwise
  // treat as this PR being settled when it is not.
  incomplete: "round left review feedback unaddressed — no report and nothing pushed",
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
  /**
   * Fallback base branch for conflict pre-merges (project setting, else the repo's default
   * branch) — used only when the PR's own `baseRefName` is unavailable; the PR's actual base
   * always wins once `pr` is fetched (see `prBaseBranch` below).
   */
  baseBranch: string | undefined;
  all: Bead[];
}): Promise<{ outcome: PrFixOutcome; ledgerChanged: boolean }> {
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
  if (number === undefined) return { outcome: "clean", ledgerChanged: false };

  const pr = await getPrReview(repo, number, ctx.signal);
  const branch = pr.headRefName || `${branchPrefix}/${epic.id}`;
  // The PR's OWN base on GitHub, not the project's configured/default branch — a retargeted PR or a
  // project whose default branch setting changed after the PR opened leaves those two diverging,
  // and premerging the project's setting would merge the wrong branch into the PR (anton-091jr
  // review, chatgpt-codex-connector). Falls back to the project setting only when `gh` didn't report
  // one (a synthetic PrReview in tests).
  const prBaseBranch = pr.baseRefName || baseBranch;

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
      prNumber: number,
      branch,
      all,
    });
    return { outcome: "merged", ledgerChanged: true };
  }

  // A PR that CLOSED between the dispatch and now (anton-z5e3g). `classifyReview` below treats it as
  // not-actionable and the target is left untouched, so this read would otherwise be discarded — and
  // the dispatcher, which re-reads every in-review target each pass, would be the only site to ever
  // record the close. Stamping here too means whichever job first reads the end is the one that
  // records it; the write is first-observation-wins, so the two sites cannot disagree.
  //
  // Both branches feed `ledgerChanged` (PR #335 review): a CLOSED PR always falls through to
  // `!verdict.actionable` below and returns "clean", so without this a stamp that is this call's
  // only effect would report `changed: false` and contradict the `JobEffect` contract.
  let ledgerChanged = false;
  if (pr.state === "CLOSED") {
    ledgerChanged = await recordPrTerminalState(db, clock, {
      projectId,
      prNumber: number,
      state: "closed",
    });
  }

  // The counterpart observation (PR #335 review), mirrored from the dispatcher's own OPEN branch: a
  // job queued while the PR was open can run after a later dispatcher pass already stamped a close
  // and the PR has since reopened. Without this, `recordPrTerminalState`'s null-row heuristic sees no
  // evidence of that reopen and a subsequent close silently preserves the stale first-close timestamp.
  if (pr.state === "OPEN") {
    ledgerChanged = (await recordPrReopened(db, { projectId, prNumber: number })) || ledgerChanged;
  }

  const verdict = classifyReview(pr);
  if (!verdict.actionable) return { outcome: "clean", ledgerChanged }; // nothing to fix on this PR yet.

  // Claim the checkout for the whole fix. review-fix writes no run row, so without it the branch
  // reads as nobody's: the execute run's teardown (its bead is still open, so it releases the
  // worktree) would force-remove the directory claude is fixing in, discarding the fix and failing
  // the commit and push behind it.
  const claimOwner = claimOwnerFor(ctx.jobId);
  const outcome = await withWorktreeClaim(repo, branch, claimOwner, async () => {
    // Re-materialize the worktree from the PR branch (execute-epic removes it after opening the
    // PR), sync it with origin, and pre-merge the base if GitHub reports a conflict.
    const { worktree, conflicts, alreadyAhead, preSessionHead, refsSynced } =
      await prepareFixWorktree({
        ctx,
        repo,
        branch,
        settings,
        baseBranch: prBaseBranch,
        number,
        claimOwner,
        expectedHeadSha: pr.headSha,
        expectedBaseRefOid: pr.baseRefOid,
      });

    // Refuse to run the session at all when the worktree isn't provably on what GitHub reports as
    // the PR's current head/base (PR #338 review, chatgpt-codex-connector, round 7): a green gate
    // run against a stale fetch is worse than no run, since `commitAndPushFix` would then push a
    // "fix" that was only ever tested against the wrong tree. Clear the job's own enqueue-time
    // snapshot too, not just skip recording a new one — otherwise a stale headSha/fingerprint pair
    // that still matches the (unmoved) GitHub head survives on this row and, if a LATER attempt
    // parks, wrongly suppresses a future retry at a revision this attempt never actually tested.
    // NOT best-effort: swallowing a failure here and continuing into the fix session would leave
    // that stale pair in place, so let it throw and fail this attempt outright — the runner retries
    // the whole job, and a transient failure (e.g. a brief SQLite lock) clears on that next attempt.
    if (!refsSynced) {
      invalidateReviewFixAttempt(db, ctx.jobId);
      consoleLog.info(
        `PR #${number}: origin sync did not reach reported head ${pr.headSha} / base ${pr.baseRefOid ?? "unknown"} — skipping this round's fix session rather than gating/pushing against a potentially stale base`,
      );
      return "incomplete";
    }

    // Refresh the job's own payload to what THIS attempt actually saw before it can hit a
    // `PoisonError` and park — see `recordReviewFixAttempt`'s doc (PR #338 review,
    // chatgpt-codex-connector).
    try {
      recordReviewFixAttempt(db, ctx.jobId, pr.headSha, verdict.fingerprint);
    } catch (e) {
      // A failed write here is worse than a skipped one: the row still carries whatever
      // `enqueueReviewFixPrIfAbsent` snapshotted at enqueue time, which this session is about to
      // run past without having recorded. If that stale pair still matches the (unmoved) GitHub
      // head, a later park would wrongly suppress a revision this attempt never tested (PR #338
      // review, chatgpt-codex-connector). Invalidate rather than merely log so the stale snapshot
      // can't outlive this attempt; let `invalidateReviewFixAttempt`'s own failure propagate and
      // fail this attempt outright.
      consoleLog.error("recordReviewFixAttempt failed before PR fix — invalidating stale snapshot", e);
      invalidateReviewFixAttempt(db, ctx.jobId);
    }

    const { pushed, answeredAllThreads } = await runFixSession({
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
      preSessionHead,
      branch,
      number,
    });
    if (!pushed && answeredAllThreads) {
      // No commit landed, so the next dispatcher pass would re-triage this exact PR state as
      // actionable again — record what this round answered so a fresh triage matching BOTH the head
      // and this fingerprint is suppressed instead of handed a brand new session (anton-dfuvz).
      // Gated on `answeredAllThreads` (anton-091jr review, chatgpt-codex-connector): a report that
      // never arrived (a claude error text with no reporting contract) or left some of the threads
      // this round was actually asked about untouched must NOT be recorded as answered — that thread
      // is still genuinely waiting on anton, and marking the round "answered" would suppress a fresh
      // attempt at it forever (same head, same fingerprint) instead of a real reply ever reaching it.
      // `refsSynced` is unconditionally true here — the early return above sends an unsynced round
      // home before it ever reaches `runFixSession` (PR #338 review, chatgpt-codex-connector, round 7).
      //
      // Friction classification (ADR-0001 clause 5, anton-tuf4l): this job settles `done`, not
      // parked or cancelled, so it is NOT anton failing and NOT a human touch — nobody was asked
      // anything and nothing is waiting on a person. It still counts toward `prFixRounds` (this PR
      // really did need a round of attention), but contributes zero to every anton-failing/
      // human-touch counter. The later suppression this enables (declining to re-dispatch at the
      // same head + fingerprint) creates no job row of its own, so it needs no counter beyond this
      // one. Best-effort like the beads sync above: a write hiccup here must not turn a legitimately
      // successful "answered, nothing to push" round into a job failure (anton-tuf4l).
      //
      // Stored WITHOUT `thread:` entries (anton-091jr review, chatgpt-codex-connector): `verdict`
      // was classified BEFORE this round replied, so its fingerprint still names every thread that
      // was waiting then. `answeredAllThreads` just proved every one of those got a real, delivered
      // reply — anton is now each thread's last commenter, so `threadsNeedingAttention` drops all of
      // them on the very next sweep and a fresh `classifyReview` fingerprint would never include
      // them either. Storing the pre-reply fingerprint verbatim would compare against a shape the
      // next sweep can never reproduce, so the suppression check would always miss and hand this PR
      // a brand new fix session despite nothing about it having changed.
      const postReplyFingerprint = verdict.fingerprint.filter((f) => !f.startsWith("thread:"));
      try {
        recordReviewFixAnswered(db, ctx.jobId, pr.headSha, postReplyFingerprint);
      } catch (e) {
        consoleLog.error("recordReviewFixAnswered failed after PR fix", e);
      }
    } else if (!pushed) {
      consoleLog.info(
        `PR #${number}: round left thread(s) unaddressed (no/incomplete report) — not recording answered`,
      );
    }
    // "answered" requires answeredAllThreads: `!pushed` alone doesn't prove the report was
    // complete, and reporting a partial/missing round as "answered" (PR #338 review,
    // chatgpt-codex-connector) would tell automation history the feedback was addressed when
    // it is genuinely still waiting on anton.
    if (pushed) return "pushed";
    return answeredAllThreads ? "answered" : "incomplete";
  });
  return { outcome, ledgerChanged };
}

/**
 * Materialize the PR branch into a fresh worktree and get it ready for claude: fetch origin (a
 * reviewer may have pushed), fast-forward to the remote branch, and — whenever the branch is
 * behind its base — pre-merge the base so the verify gates below run against the same tree GitHub
 * would merge, and claude has only conflict markers (if any) left to resolve. Every git step is
 * best-effort: a repo with no reachable origin still gets the review-comment flow.
 */
export async function prepareFixWorktree(args: {
  ctx: JobContext;
  repo: string;
  branch: string;
  settings: ProjectSettings;
  /** Base branch for conflict pre-merges (project setting, else the repo's default branch). */
  baseBranch: string | undefined;
  number: number;
  /** This job's claim on the branch — createWorktree hands the checkout to nobody else. */
  claimOwner: string;
  /**
   * `pr.headSha` the caller classified its fix attempt against — compared against what the sync
   * below actually lands on, so a best-effort `fetchOrigin` failure can be told apart from a real
   * sync (see `refsSynced` below). Empty when the caller has no head to verify against (e.g. a
   * synthetic `PrReview` in tests) — `refsSynced` is unconditionally true for this half of the
   * check in that case, since there is nothing to compare.
   */
  expectedHeadSha: string;
  /**
   * `pr.baseRefOid` the caller classified its fix attempt against — compared against what
   * `origin/<baseBranch>` actually resolves to after the fetch below, for the same reason
   * `expectedHeadSha` is checked against the synced head: `fetchOrigin` below fetches the base
   * branch too, and is just as best-effort. A silent failure there leaves `origin/<baseBranch>`
   * stale, so `premergeBase` merges an old base commit and the gates run against a tree that
   * doesn't match what GitHub reports as the PR's current base — even though the head fetch
   * succeeded and `syncedHead === expectedHeadSha` (PR #338 review, chatgpt-codex-connector,
   * round 3). Undefined/empty when the caller has no base to verify against (e.g. a synthetic
   * `PrReview` in tests, or no `baseBranch` at all) — that half of the check is then
   * unconditionally true, matching `expectedHeadSha`'s own fallback.
   */
  expectedBaseRefOid: string | undefined;
}): Promise<{
  worktree: Worktree;
  conflicts: string[];
  alreadyAhead: boolean;
  /**
   * Worktree HEAD once this function is done touching it — i.e. BEFORE claude or the gate
   * follow-up runs. A clean, conflict-free base premerge lands its own commit right here, inside
   * this function, well before any review-fix work happens (see `premergeBase`'s "clean
   * auto-merge" comment) — so this is the boundary `runFixSession` diffs against to tell "this
   * round's session/gate follow-up actually changed something" apart from "the branch merely sits
   * ahead of origin because of a base sync that has nothing to do with the review feedback"
   * (PR #338 review, chatgpt-codex-connector: a clean base-only premerge otherwise makes
   * `commitAndPushFix` return `pushed: true` for a round where claude changed nothing, which
   * `fabricatedFix` then can't tell apart from a genuine fix).
   *
   * `undefined` when the best-effort read below fails — never a fallback sha, and never compared
   * as equal OR unequal to anything: a caller must treat "unknown" as "no change" (fail closed),
   * or a transient git hiccup here would make every later diff against it read as "changed" and
   * validate a "fixed" claim the round never actually earned (PR #338 review, chatgpt-codex-
   * connector, round 8).
   */
  preSessionHead: string | undefined;
  /**
   * Did the fetch above actually land the worktree's HEAD on `expectedHeadSha` AND
   * `origin/<baseBranch>` on `expectedBaseRefOid`? Both git steps are best-effort (a repo with no
   * reachable origin still gets the review-comment flow) — when `fetchOrigin` fails silently for
   * either ref, that ref just resolves to whatever it last was locally, which can be stale. `false`
   * here tells the caller the session below (if any) ran, and any gate it hit failed, against code
   * that was NOT what GitHub reports as the PR's current head or base — so persisting an attempt
   * fingerprint keyed on `expectedHeadSha`/`expectedBaseRefOid` would misrepresent that revision as
   * tested (PR #338 review, chatgpt-codex-connector, rounds 2-3). Also `false` when the fetched refs
   * DO match but `premergeBase` below fails outright partway through the merge (round 4 of the same
   * review) — the advertised base tree never actually landed in the worktree the gates ran against,
   * so that's just as untested as a stale fetch. A checkout that sits AHEAD of `expectedHeadSha`
   * (contains it as an ancestor, e.g. unpushed operator/prior-attempt commits on a resumed branch)
   * still counts as synced, not stale.
   */
  refsSynced: boolean;
}> {
  const {
    ctx,
    repo,
    branch,
    settings,
    baseBranch,
    number,
    claimOwner,
    expectedHeadSha,
    expectedBaseRefOid,
  } = args;

  const worktree = await createWorktree({
    repoPath: repo,
    branch,
    baseBranch: settings.baseBranch,
    // Warmed explicitly below, once the worktree is confirmed to exist — createWorktree's own
    // `warm: true` would run the install with no project config, silently ignoring an operator's
    // pinned command or opt-out (see resolveWarmConfig below and worktree.ts:1601).
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
  // Reused checkouts land here with the lockfile already declaring modules `node_modules` never
  // linked (verified on #1698) — `safe()` on top of `warmWorktreeBestEffort`'s own internal catch
  // (belt and suspenders, matching every other best-effort step in this function) so a stuck install
  // can never block the fix from proceeding.
  await safe(() => warmWorktreeBestEffort(worktree, ctx.signal, resolveWarmConfig(settings)));
  await ctx.heartbeat();

  // Snapshot "local branch already ahead of origin" BEFORE the fetch/sync below can move
  // `origin/<branch>` — the only way to tell "this worktree already carried commits past
  // `expectedHeadSha` before we asked origin for anything" (the supported resume path, see
  // `alreadyAhead` below) apart from "origin answered with a tip newer than what `getPrReview`
  // reported, and the ff-only merge below just fast-forwarded local onto it" (a race between that
  // read and this fetch). Both leave `syncedHead` strictly ahead of `expectedHeadSha`; only the
  // resume case is safe to trust as "synced", since in the race case the checks/reviews/fingerprint
  // the caller classified are for a commit that is no longer the branch's real tip (PR #338 review,
  // chatgpt-codex-connector, round 9) — a plain ff-only merge otherwise has no local-only commits to
  // land it ahead of a freshly-fetched `origin/<branch>`, so seeing it ahead only *after* the fetch
  // can't distinguish the two.
  //
  // `branchAheadOfRemote` alone isn't enough evidence: it deliberately returns `true` when
  // `origin/<branch>` is absent locally or its `rev-list` fails (fail-open, so a repo with no
  // reachable origin doesn't block the review-comment flow elsewhere) — that "unknown" case reads
  // identically to a genuine resume, so it can't tell apart from the race above either. Requiring the
  // pre-fetch tracking ref to have actually resolved, AND to already equal `expectedHeadSha` — the
  // head `getPrReview` reported — proves the local repo's knowledge of origin was both real and
  // current at that moment, so any extra local commits on top of it are trustworthy resume work, not
  // a raced fetch dressed up by the fallback (PR #338 review, chatgpt-codex-connector, round 10).
  // Skipped entirely when `expectedHeadSha === ""` (a synthetic `PrReview` in tests) — `headMatches`
  // below trusts the sync unconditionally in that case, so `aheadBeforeFetch`'s value can't affect it.
  const preFetchTrackingSha =
    expectedHeadSha === ""
      ? undefined
      : await resolveCommitSha(repo, `origin/${branch}`).catch(() => undefined);
  const aheadBeforeFetch =
    expectedHeadSha !== "" &&
    preFetchTrackingSha === expectedHeadSha &&
    (await branchAheadOfRemote(repo, branch));

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

  // Read RIGHT after the sync above, before the premerge can land its own commit and move HEAD
  // again — this is the one point where the worktree's actual position can be checked against what
  // `fetchOrigin`/the ff-only merge were SUPPOSED to reach. `expectedHeadSha === ""` (no head to
  // verify against, e.g. a synthetic `PrReview` in tests) trusts the sync unconditionally, matching
  // this function's pre-existing behavior before this check existed.
  const syncedHead = await readWorktreeState(worktree.path).then(
    (s) => s.head,
    () => "",
  );
  // A checkout that is a DESCENDANT of `expectedHeadSha` — not just equal to it — also counts as
  // synced: the supported resume path leaves unpushed operator or prior-attempt commits on the
  // local branch, so the ff-only merge above is a no-op against `origin/<branch>` and `syncedHead`
  // legitimately sits ahead of what GitHub reports (PR #338 review, chatgpt-codex-connector, round
  // 4). Treating that as unsynced deleted the job's attempt identity every single pass, so a parked
  // gate could never be matched by a later sweep and kept re-dispatching against the same commits.
  //
  // But that descendant allowance only holds when the LOCAL branch was already ahead of origin
  // BEFORE this function fetched anything (`aheadBeforeFetch` above) — i.e. the extra commits are
  // known to be the resume path's own unpushed work, not something the fetch just pulled in. Without
  // that guard, a PR branch that advances remotely between the caller's `getPrReview` and the fetch
  // above produces the exact same shape: a freshly fetched `origin/<branch>` that is a descendant of
  // `expectedHeadSha`, fast-forwarded onto local by the ff-only merge — and accepting it as synced
  // would run the checks/reviews/fingerprint the caller classified against a commit that is no
  // longer the branch's real tip (PR #338 review, chatgpt-codex-connector, round 9). When
  // `aheadBeforeFetch` is false, only an exact match counts as synced — anything else forces a fresh
  // PR read on the next pass instead.
  const headMatches =
    expectedHeadSha === "" ||
    syncedHead === expectedHeadSha ||
    (aheadBeforeFetch &&
      (await isAncestor(worktree.path, expectedHeadSha, syncedHead).catch(() => false)));

  // Same check for the base ref `fetchOrigin` above also fetched (best-effort, just like the head
  // fetch above) — resolved directly via `rev-parse` rather than `readWorktreeState` since the
  // worktree's own HEAD hasn't merged it in yet (that's `premergeBase`, below). No `baseBranch`
  // (nothing gets premerged, so a stale base ref can't feed the gates) or no `expectedBaseRefOid`
  // (a synthetic `PrReview` in tests) trusts the sync unconditionally, matching `expectedHeadSha`'s
  // own fallback.
  const baseMatches =
    !baseBranch ||
    !expectedBaseRefOid ||
    (await resolveCommitSha(worktree.path, `origin/${baseBranch}`).catch(() => "")) ===
      expectedBaseRefOid;

  // Refs matching GitHub is necessary but not sufficient — `premergeBase` below still has to
  // actually land that base content in the tree the gates run against. Final `refsSynced` folds in
  // its outcome too (see below).
  const refsFetched = headMatches && baseMatches;

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
  const { conflicts, merged, failed: baseMergeFailed } = await premergeBase(
    repo,
    worktree.path,
    branch,
    baseBranch,
    number,
  );
  await ctx.heartbeat();
  // Folded in here, after `premergeBase` returns, rather than into `refsFetched` above: a fetched
  // head/base that match GitHub exactly are still not "synced" if the merge landing that base
  // content then fails outright (a transient git error, a hook failure) — without this, `refsSynced`
  // stayed true and the caller recorded an attempt fingerprint for a tree that never actually got the
  // base merged in, so a red gate parked a suppression that looked identical to a real, tested
  // failure (PR #338 review, chatgpt-codex-connector, round 4).
  const refsSynced = refsFetched && !baseMergeFailed;
  // A clean (conflict-free) base merge can change dependency metadata (lockfile, package.json)
  // without updating `node_modules`, which was warmed above BEFORE this merge landed — the verify
  // gates below would then fail solely because the install reflects the pre-merge tree (anton-091jr
  // review round 2, chatgpt-codex-connector). Skipped when conflicts remain: claude resolves those
  // first, and warming against unresolved conflict markers would install nonsense.
  if (merged && conflicts.length === 0) {
    await safe(() => warmWorktreeBestEffort(worktree, ctx.signal, resolveWarmConfig(settings)));
    await ctx.heartbeat();
  }
  // Read AFTER the premerge above, not before — a clean auto-merge already landed its own commit by
  // this point (see the field's own doc on the return type), and that commit must count as part of
  // the pre-session baseline, not as evidence of a session-produced change. Best-effort like every
  // other git read on this path: a failed read falls back to `undefined` (never a sha, so it can
  // never equal OR differ from a later-read sha) rather than aborting a fix over a HEAD read anton
  // doesn't strictly need yet — the same tolerance `branchAheadOfRemote` above already applies to a
  // git hiccup here. `undefined`, not `""` (PR #338 review, chatgpt-codex-connector, round 8): `""`
  // reads as unequal to any real sha, silently turning an unreadable baseline into fabricated
  // "changed" evidence; every comparison against this field below must instead treat `undefined` as
  // "no change" explicitly.
  const preSessionHead = await readWorktreeState(worktree.path).then(
    (s) => s.head,
    () => undefined,
  );
  return { worktree, conflicts, alreadyAhead, preSessionHead, refsSynced };
}

/**
 * The base merge the verify gates need underneath them — brought in whenever the branch doesn't
 * already carry the base's tip, regardless of what GitHub's own `mergeable` field says. The gates
 * below (e.g. check-migration-ordering) diff against `origin/<base>` directly, so a MERGEABLE-but-
 * behind branch (fast-forwardable, no textual conflict) still needs this merge — without it the
 * gates judge a tree that's missing base commits and can pass against files the base already
 * superseded (#2141). Conflicts, when they happen, are what claude is asked to resolve.
 */
async function premergeBase(
  repo: string,
  worktreePath: string,
  branch: string,
  baseBranch: string | undefined,
  number: number,
): Promise<{ conflicts: string[]; merged: boolean; failed: boolean }> {
  if (!baseBranch) return { conflicts: [], merged: false, failed: false };
  const baseRef = `origin/${baseBranch}`;
  // Already caught up → no merge to do. Best-effort like every other git read on this path (see
  // prepareFixWorktree's doc): a failed read (origin/<base> didn't resolve, a transient git error)
  // reads as "can't confirm we're caught up" rather than aborting the premerge — the merge attempt
  // below tolerates a no-op fine on its own.
  const upToDate = await isAncestor(worktreePath, baseRef, "HEAD").catch(() => false);
  if (upToDate) return { conflicts: [], merged: false, failed: false };
  const hooksPath = (await needsHooksPathOverrideForMerge(repo, worktreePath, baseRef))
    ? await resolveHooksPathOverrideForMerge(repo, worktreePath, baseRef)
    : undefined;
  // Read BEFORE the merge below can move HEAD (PR #338 review, chatgpt-codex-connector, round 5): a
  // clean auto-merge lands its own commit via `mergeIntoCurrent`, entirely bypassing `commitFix`'s
  // marker check. If the tip this merges on top of was itself a hook-bypassed boundary commit (a
  // prior attempt parked one and the base has since advanced), the merge commit's tree still carries
  // that unverified content, but the note stays attached to the OLD tip — not the new merge commit
  // that `findUnverifiedBoundaryAncestor` actually inspects afterward. Left unpropagated, the
  // "already ahead" fast path in `runFixSession` finds no marker on the new HEAD, skips the re-verify
  // amend in `commitAndPushFix`, and pushes the original --no-verify commit's content straight past
  // the project's hooks. Searches the whole unpushed range, not just literal `HEAD` (round 6): the
  // tip this merges onto can itself be a plain commit stacked on an older, still-unpushed boundary.
  const preMergeHead = await readWorktreeState(worktreePath).then((s) => s.head, () => "");
  const hadUnverifiedBoundary =
    (await findUnverifiedBoundaryAncestor(worktreePath, branch)) !== undefined;
  try {
    const merge = await mergeIntoCurrent(worktreePath, baseRef, { hooksPath });
    if (merge.conflicts.length === 0 && hadUnverifiedBoundary) {
      // The merge committed cleanly on top of a still-unverified tip — carry the marker forward onto
      // the new merge commit so it isn't lost.
      try {
        await markUnverifiedBoundary(worktreePath);
      } catch (error) {
        // The merge landed cleanly even though writing its marker failed (concurrent note-ref lock
        // contention, say) — left in place, `HEAD` would carry the still-unverified content with no
        // note attached, and a resumed "already ahead" fast path would treat it as re-verified and
        // push it straight past the project's hooks (PR #338 review, chatgpt-codex-connector, round
        // 6; `commitFix` rolls back for the identical reason when IT hits this same failure while
        // creating the marker). `reset --hard` (not `--soft`, unlike `commitFix`'s rollback) because
        // there is no follow-up work staged on top to preserve — only the merge itself, which a
        // retry redoes from scratch. No rollback target (the best-effort read above failed) is
        // itself poison — silently leaving the merge on HEAD unmarked is exactly what this rollback
        // exists to prevent.
        if (!preMergeHead) {
          throw new PoisonError(
            `PR #${number}: auto-merge of ${baseRef} committed but its unverified-boundary marker ` +
              `failed to write, and the pre-merge HEAD needed to roll it back was never read — the ` +
              `worktree may be left with an unmarked bypass commit`,
            { cause: error },
          );
        }
        try {
          await git(worktreePath, ["reset", "--hard", preMergeHead]);
        } catch (restoreError) {
          throw new PoisonError(
            `PR #${number}: auto-merge of ${baseRef} committed but its unverified-boundary ` +
              `marker failed to write, and restoring HEAD to ${preMergeHead} afterward also ` +
              `failed — the worktree may be left with an unmarked bypass commit: ` +
              `${(restoreError as Error).message}`,
            { cause: error },
          );
        }
        consoleLog.error(
          `PR #${number}: marking auto-merge of ${baseRef} as an unverified boundary failed`,
          error,
        );
        return { conflicts: [], merged: false, failed: true };
      }
    }
    return { conflicts: merge.conflicts, merged: true, failed: false }; // clean auto-merge → a merge commit is pushed below
  } catch (e) {
    // The inner rollback above throws `PoisonError` when it can't safely undo an unmarked
    // bypass commit (no readable pre-merge HEAD, or the `reset --hard` itself failed) — that
    // must reach the runner so the checkout is parked, not swallowed into an ordinary "retry
    // me" failure that leaves the unsafe checkout to be auto-retried (PR #338 review,
    // chatgpt-codex-connector).
    if (isPoisonError(e)) throw e;
    consoleLog.error(`PR #${number}: merging ${baseRef} failed`, e);
    // `failed: true` (not just `merged: false`, which also covers the ordinary "already caught up"
    // case above) — this branch means the merge was actually attempted and blew up (transient git
    // error, hook failure), so the base content the gates need never landed even though the refs
    // fetched cleanly. The caller folds this into `refsSynced` so that failure can't be recorded as
    // a tested attempt (PR #338 review, chatgpt-codex-connector, round 4).
    return { conflicts: [], merged: false, failed: true };
  }
}

/** What one fix session decided (see {@link runFixSession}). */
interface RunFixSessionResult {
  /** Did this round push a commit to the remote? */
  pushed: boolean;
  /**
   * Did every thread that was waiting on anton BEFORE this session started end up with a real
   * (non-fabricated) outcome? Only meaningful when `!pushed` — {@link handleEpic} gates
   * `recordReviewFixAnswered` on it so a malformed/partial thread report, or a fast path that never
   * looked at threads at all, is never mistaken for an actually-answered round (anton-091jr review,
   * chatgpt-codex-connector).
   */
  answeredAllThreads: boolean;
}

/**
 * Do EVERY thread `waitingIds` named (the PR's own unresolved-and-not-yet-replied-to set, read
 * BEFORE this round touched anything) now have a real, DELIVERED outcome — i.e. is there nothing
 * left that this round was asked about but never actually answered? `answeredIds` is
 * `applyThreadOutcomes`'s own return value: the ids whose GitHub reply actually landed. A
 * `fabricatedFix` "fixed" claim never reaches that set (same rule `applyThreadOutcomes` uses to
 * skip replying to it), and neither does a thread whose reply call failed — a report entry alone
 * isn't enough, since `replyToReviewComment` failing is swallowed by `safe()` and must not read as
 * "answered" (anton-091jr review, chatgpt-codex-connector).
 *
 * `hasNonThreadReasons` names whether `verdict.fingerprint` carries any entry besides `thread:*` —
 * a failing check, a merge conflict, or a reviewer summary. Whenever it's true (whether or not
 * threads were ALSO waiting — a mixed round), a claude run that finished without error is not
 * evidence it actually handled that reason: treating it as such would let `recordReviewFixAnswered`
 * suppress a genuinely still-broken PR at this head+fingerprint forever (anton-091jr review round 2
 * and PR #338 review, chatgpt-codex-connector — the latter caught this check only firing when
 * `waitingIds` was empty, so a mixed round with both threads and a non-thread reason could report
 * every thread and never once be asked about the failing check/summary). Positive evidence is
 * `report` naming the {@link NON_THREAD_REPORT_ID} sentinel with a non-fabricated outcome:
 * - same `fabricatedFix` rule `applyThreadOutcomes` applies to a real thread reply, so a claude run
 *   can't claim "fixed" on the sentinel when nothing was actually pushed (PR #338 review,
 *   chatgpt-codex-connector).
 * - a `needs-human` sentinel counts the same as `left`: the sentinel id matches no real GitHub
 *   thread, so `applyThreadOutcomes` never posts it — but the unpushed caller in `runFixSession`
 *   publishes it as a top-level PR comment via `publishUnpushedSentinel` and ANDs that publish's
 *   own success into its `answeredAllThreads` result. This function only ever sees the sentinel
 *   after it was already asked for, so treating its mere presence as real evidence relies on that
 *   caller-side gate, not a second one here (PR #338 review, chatgpt-codex-connector: publication
 *   succeeding while this function still hard-rejected `needs-human` meant the request was visible
 *   on the PR yet every sweep kept dispatching a fresh session against it anyway).
 */
export function allWaitingThreadsAnswered(
  waitingIds: ReadonlySet<string>,
  answeredIds: ReadonlySet<string>,
  report: ThreadOutcome[],
  hasNonThreadReasons: boolean,
  pushed: boolean,
): boolean {
  if (hasNonThreadReasons) {
    const sentinel = report.find((r) => r.id === NON_THREAD_REPORT_ID);
    if (!sentinel || fabricatedFix(sentinel, pushed)) return false;
  }
  for (const id of waitingIds) {
    if (!answeredIds.has(id)) return false;
  }
  return true;
}

/**
 * Does `verdict.fingerprint` carry an actionable reason besides an unresolved thread? Excludes
 * `thread:*` (fed to {@link allWaitingThreadsAnswered} as per-thread evidence instead) AND `base:*`
 * — `classifyReview` (src/lib/git/pr.ts) appends a `base:<oid>` entry to every nonempty fingerprint
 * as a pure cache-busting key, not a real reason. Without excluding it too, a PR whose only
 * actionable reason is an unresolved inline thread would always read as having a non-thread reason,
 * demanding a {@link NON_THREAD_REPORT_ID} sentinel for a check/conflict/summary that never existed
 * (PR #338 review, chatgpt-codex-connector and claude).
 */
export function fingerprintHasNonThreadReasons(fingerprint: readonly string[]): boolean {
  return fingerprint.some((f) => !f.startsWith("thread:") && !f.startsWith("base:"));
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
  /**
   * Worktree HEAD before claude/the gate follow-up ran — see {@link prepareFixWorktree}. `undefined`
   * when that read failed; every comparison against it below must treat that as "no change", never
   * as a sha that happens to differ from whatever's read later.
   */
  preSessionHead: string | undefined;
  branch: string;
  number: number;
}): Promise<RunFixSessionResult> {
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
    preSessionHead,
    branch,
    number,
  } = args;

  // Snapshot BEFORE this round touches anything — what `answeredAllThreads` (in every return below)
  // checks a thread report against. `pr` is the same read `verdict` was classified from, so this
  // matches exactly what made the round actionable in the first place.
  const waitingIds = new Set(threadsNeedingAttention(pr).map((t) => t.id));
  // Does this round need answering for something besides those threads — a failing check, a merge
  // conflict, or a reviewer summary? Drives both the prompt (ask for the sentinel even in a mixed
  // round) and `allWaitingThreadsAnswered` (require it), so the two can never drift apart (PR #338
  // review, chatgpt-codex-connector).
  const hasNonThreadReasons = fingerprintHasNonThreadReasons(verdict.fingerprint);

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
  // Set the instant the one bounded follow-up round is dispatched (anton-pwekp), so a PoisonError
  // that reaches the catch below can tell the PR whether a fix round was already attempted.
  let gateFollowUpAttempted = false;

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
      await runGatesWithFollowUp({
        db,
        clock,
        ctx,
        projectId,
        epic,
        settings,
        worktree,
        pr,
        run,
        number,
        logPath,
        onEvent,
        onFollowUpAttempted: () => {
          gateFollowUpAttempted = true;
        },
      });
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
      // This path never dispatches claude, so there's no thread report to parse — `verdict.reasons`
      // is the only summary of what this round pushed (PR #321 review).
      await refreshFixRoundsBody({
        repo,
        number,
        report: [],
        pushed,
        now: new Date(clock.now()),
        logPath,
        reasons: verdict.reasons,
      });
      await notifyReReview({ repo, number, pr, reasons: verdict.reasons, signal: ctx.signal });
      // This path never dispatches claude, so nothing here ever looked at (let alone replied to)
      // any thread, nor reported the non-thread sentinel. Route the unpushed case through the same
      // `allWaitingThreadsAnswered` the main path uses (with an empty report/answered set, since
      // nothing was ever asked) rather than a hand-rolled `waitingIds.size === 0` check — that check
      // alone ignored `hasNonThreadReasons` and could credit this fast path as "fully answered" for a
      // failing check or reviewer summary nothing ever verified, if `pushed` ever came back false
      // despite the branch being ahead (PR #338 review, @claude).
      return {
        pushed,
        answeredAllThreads:
          pushed || allWaitingThreadsAnswered(waitingIds, new Set(), [], hasNonThreadReasons, pushed),
      };
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
      hasNonThreadReasons,
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

    // Commit the main round's own work NOW, before gates (and the possible gate-fix follow-up)
    // touch the tree. This used to be gated on `conflicts.length > 0` — premergeBase leaves any
    // base-merge conflicts uncommitted (conflict markers, MERGE_HEAD set) for this same session to
    // resolve, and that resolution needed landing before a red gate below could throw and park the
    // branch (anton-vtex7) — but `commitFix` stages everything and only actually commits when the
    // tree is dirty, so calling it unconditionally still no-ops for a conflict-free, nothing-to-fix
    // round while ALSO covering the conflict case. Doing it unconditionally is what makes
    // `preGateHead` below a real boundary: without it, a conflict-free round's own edits would sit
    // uncommitted straight through the gate run, and the follow-up's commit (if any) would be
    // indistinguishable from this round's. Nothing is pushed here — publication stays behind the
    // gates.
    //
    // `bypassHooks: true` (PR #338 review, chatgpt-codex-connector): this is an internal boundary
    // marker, not publication — the tree still gets a real hook-enforced commit below, in
    // `commitAndPushFix`, once it is actually about to be pushed. A project whose pre-commit hook
    // runs the SAME lint/typecheck/test command as a configured verify gate would otherwise have
    // this commit rejected by the hook before `runGatesWithFollowUp` ever runs — exiting via the
    // plain (retryable) error `commitFix` throws when nothing landed, which skips straight past the
    // bounded gate-fix follow-up round below and re-dispatches a whole new review session against
    // the exact same failure instead.
    //
    // This commit is marked as an unverified boundary (see `markUnverifiedBoundary`), so
    // `commitAndPushFix` below re-verifies it via `commitFix`'s own marker check even when the
    // follow-up round makes no further changes — a clean index would otherwise mean `commitAll`
    // never invokes git at all, letting this hook-bypassed commit reach the remote unverified.
    await commitFix(repo, worktree.path, epic.id, branch, number, settings, ctx.signal, {
      bypassHooks: true,
    });
    // Snapshot the boundary BEFORE gates/the follow-up round can touch anything — see
    // `mainRoundProducedChange` below for why this, not `postSessionHead`, is what `report`'s own
    // claims get checked against.
    const { head: preGateHead } = await readWorktreeState(worktree.path);

    await runGatesWithFollowUp({
      db,
      clock,
      ctx,
      projectId,
      epic,
      settings,
      worktree,
      pr,
      run,
      number,
      logPath,
      onEvent,
      onFollowUpAttempted: () => {
        gateFollowUpAttempted = true;
      },
    });

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

    // `pushed` alone is not proof this round's claude/gate-follow-up work produced anything: a clean
    // base premerge (see `prepareFixWorktree`'s `preSessionHead` doc) can already have HEAD ahead of
    // origin before claude ever ran, so `commitAndPushFix` returns `pushed: true` for that merge
    // alone even when claude changed nothing. `sessionProducedChange` names whether ANYTHING beyond
    // that ambient base sync went out this round (claude's own edits OR the gate-fix follow-up's) —
    // good enough for `notifyReReview` below (a follow-up-only push still deserves a re-review ping)
    // but NOT for `report`'s own claims (next).
    const { head: postSessionHead } = await readWorktreeState(worktree.path);
    // `preSessionHead !== undefined` guards both comparisons below: an unreadable baseline (PR #338
    // review, chatgpt-codex-connector, round 8) must read as "no change", never as a sha that
    // trivially differs from whatever got read afterward — the fail-closed half of the fix, so a
    // transient git hiccup can never itself manufacture push evidence for a claim claude never earned.
    const sessionProducedChange = preSessionHead !== undefined && postSessionHead !== preSessionHead;
    // `report` is parsed from `result.text` — the main round's OWN final message, produced before
    // gates (and any gate-fix follow-up) ever ran. Whether a "fixed" claim in it is real must be
    // checked against what THAT round committed, not what the whole session ended up pushing: the
    // follow-up's prompt carries the gate's failure output and nothing about review feedback, so its
    // edits are evidence the *gate* got fixed, never evidence for any claim in this report. Using
    // `sessionProducedChange` here let a gate-only follow-up validate a fabricated "fixed" claim on
    // an inline thread the follow-up never looked at (PR #338 review, chatgpt-codex-connector).
    const mainRoundProducedChange = preSessionHead !== undefined && preGateHead !== preSessionHead;

    const report = parseThreadReport(result.text);
    // `delivered` is the subset of `report` whose reply actually posted (PR #335 review) — what
    // both the round record and the PR body below must count, not the raw model report, since a
    // GitHub failure mid-reply leaves that thread still waiting on anton regardless of what claude
    // claimed. Gated on `mainRoundProducedChange`, not raw `pushed` (PR #338 review,
    // chatgpt-codex-connector): a gate-only follow-up push must not validate a "fixed" claim this
    // report made about review feedback the follow-up never looked at.
    const delivered = await applyThreadOutcomes({
      repo,
      number,
      pr,
      report,
      pushed: mainRoundProducedChange,
      signal: ctx.signal,
      logPath,
    });
    const answeredIds = new Set(delivered.map((d) => d.id));
    // The round's own record (anton-z5e3g): what GitHub's reviewers handed this round and how anton
    // answered it, from the values already in hand. AFTER the outcomes are applied, and only on this
    // path — a session that threw replied to no thread, so its findings are still waiting on anton
    // and the retry's row carries them; recording both would count the same review twice. The write
    // never throws (see `recordReviewRound`), so the fix above cannot be lost to a meter. `pushed`
    // here matches `applyThreadOutcomes`'s own — `recordReviewRound`'s internal re-triage must agree
    // with what actually got a delivered reply, for the same reason given above.
    await recordReviewRound(db, clock, {
      projectId,
      beadId: epic.id,
      jobId: ctx.jobId,
      prNumber: number,
      pr,
      report: delivered,
      pushed: mainRoundProducedChange,
    });
    // Recheck the terminal state right after the insert above, against a FRESH read rather than the
    // `pr` snapshot fetched before this session's claude dispatch (PR #335 review). On a shared board,
    // a second anton instance (its own local review_rounds db) can observe MERGED/CLOSED and move the
    // target out of in-review while this session was still running — this instance then never revisits
    // the PR (it has left in-review), so the row just inserted would otherwise be the last one this
    // instance ever writes for it and would permanently miss the terminal stamp.
    //
    // `getPrActivity`, not `getPrReview` (PR #335 review): this recheck only ever inspects `.state`,
    // same as the dispatcher's own orphan reconciliation above — paying for reviews + CI rollup + a
    // full paginated GraphQL thread fetch here buys nothing this call reads.
    const latest = await getPrActivity(repo, number, ctx.signal).catch((e): undefined => {
      // Same guard as the orphan-reconciliation read above: a no-progress timeout aborting this call
      // must not settle as best-effort undefined, or the runner never sees the throw it needs to
      // treat this pass as retryable (PR #335 review).
      if (ctx.signal.aborted) throw e;
      return undefined;
    });
    if (latest?.state === "MERGED") {
      await recordPrTerminalState(db, clock, { projectId, prNumber: number, state: "merged" });
    } else if (latest?.state === "CLOSED") {
      await recordPrTerminalState(db, clock, { projectId, prNumber: number, state: "closed" });
    }
    // AFTER the push (`pushed` is already settled above) — anton-te6nr — so the body never claims a
    // fix that isn't on the remote yet. `verdict.reasons` backs the fallback entry for a round with
    // no thread report (CI-only/conflict-only/no-inline-threads trigger). Gated on
    // `mainRoundProducedChange`, not `sessionProducedChange` or raw `pushed` — same reason as
    // `applyThreadOutcomes` above: this region renders straight from `report`'s own claims, so it
    // needs the same narrow evidence, not credit for a gate-only follow-up's unrelated edit.
    // The sentinel is injected as its own report entry, not routed through `reasons` — it must
    // survive alongside a real thread entry in the same round (PR #338 review, chatgpt-codex-
    // connector), and `fallbackReasonsFor`'s generic fallback only fires when the report is
    // otherwise completely empty.
    const sentinelEntry = sentinelFixEntry(report, verdict.reasons);
    await refreshFixRoundsBody({
      repo,
      number,
      report: sentinelEntry ? [...delivered, sentinelEntry] : delivered,
      pushed: mainRoundProducedChange,
      now: new Date(clock.now()),
      logPath,
      reasons: fallbackReasonsFor(report, verdict.reasons),
    });

    if (!pushed) {
      await appendSessionLog(
        logPath,
        `[review-fix] no changes produced; leaving PR #${number} as-is\n`,
      );
      // `refreshFixRoundsBody` above returned immediately for an unpushed round — its explanation
      // never reached the PR body. Without publishing it here, a "left" or "needs-human" sentinel
      // that `allWaitingThreadsAnswered` is about to accept as answered (below) would suppress this
      // fingerprint+headSha forever while the reviewer never learns why nothing changed (PR #338
      // review, @chatgpt-codex-connector) — and for "needs-human" specifically, treat a successful
      // publish as the round's answer rather than forcing a retry every sweep even though the human
      // request is already visible on the PR (PR #338 review, chatgpt-codex-connector).
      const sentinel = report.find((r) => r.id === NON_THREAD_REPORT_ID);
      // Defaults to true: when there's no sentinel to publish (or it's fabricated),
      // `allWaitingThreadsAnswered` below already rejects it on its own — this flag only needs to
      // veto the case where a real sentinel existed but the comment never reached GitHub.
      let sentinelPublished = true;
      if (sentinel && !fabricatedFix(sentinel, pushed)) {
        sentinelPublished = await publishUnpushedSentinel({
          repo,
          number,
          sentinel,
          signal: ctx.signal,
          logPath,
        });
      }
      return {
        pushed: false,
        answeredAllThreads:
          sentinelPublished &&
          allWaitingThreadsAnswered(waitingIds, answeredIds, report, hasNonThreadReasons, pushed),
      };
    }

    // Gated on `sessionProducedChange`, not raw `pushed` — same reason as `applyThreadOutcomes` and
    // `refreshFixRoundsBody` above: a base-sync-only push must not tell reviewers anton "pushed a
    // fix" when the session itself left every reported thread unanswered (PR #338 review,
    // @chatgpt-codex-connector).
    if (sessionProducedChange) {
      await notifyReReview({
        repo,
        number,
        pr,
        reasons: verdict.reasons,
        signal: ctx.signal,
      });
    } else {
      await appendSessionLog(
        logPath,
        `[review-fix] PR #${number}: push was a base-branch sync only; skipping re-review notification\n`,
      );
    }
    return { pushed: true, answeredAllThreads: true };
  } catch (e) {
    if (!sessionSettled) await endSession(db, clock, sessionId, "failed");
    // Poison means this attempt is parked for a human — the PR's own CONFLICTING/CI badges say
    // nothing about THAT (they don't know a gate ever ran), so without this comment the reader sees
    // only a stale badge, not why anton stopped (anton-gvqk3).
    if (isPoisonError(e)) {
      await notifyGateParked({
        repo,
        number,
        error: e,
        conflicts,
        fixRoundAttempted: gateFollowUpAttempted,
        signal: ctx.signal,
      });
    }
    throw e; // propagate so the runner applies quota backoff / retry / park
  }
}

/**
 * Tell the PR why anton stopped: the gate/blocker a poison park named, plus whether a base-branch
 * merge is already resolved and committed locally (unpushed) so the reader isn't left guessing what
 * state the branch is in, and whether a bounded follow-up round already tried to fix the gate
 * (anton-pwekp) — so the reader isn't left assuming a retry would help. Carries {@link ANTON_MARK}
 * like every other anton comment, so the review sweep's own `threadsNeedingAttention` never mistakes
 * it for a human's. Idempotent against the PR's comment history rather than any local state — a
 * resumed job parking on the SAME gate is a fresh process with nothing of its own to remember, but
 * the PR remembers what was already said on it.
 */
export async function notifyGateParked(args: {
  repo: string;
  number: number;
  error: Error;
  conflicts: string[];
  /** Did the one bounded follow-up round already run against this gate before it parked? */
  fixRoundAttempted?: boolean;
  signal: AbortSignal;
}): Promise<void> {
  const { repo, number, error, conflicts, fixRoundAttempted, signal } = args;
  const mergeNote =
    conflicts.length > 0
      ? " The base branch merge was resolved and committed locally (not yet pushed)."
      : "";
  const fixRoundNote = fixRoundAttempted
    ? " A follow-up fix round already ran against this gate; it failed again."
    : "";
  const body = `${ANTON_MARK} anton stopped fixing PR #${number} — ${error.message}${mergeNote}${fixRoundNote}`;
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
async function captureRedGate(
  settings: ProjectSettings,
  cwd: string,
  signal: AbortSignal,
  logPath: string,
): Promise<VerifyGateOutcome | undefined> {
  const outcomes = await captureVerifyGates(resolveVerifyGates(settings), cwd, signal, logPath);
  return outcomes.find((o) => !o.ok);
}

/**
 * Opening sentence unchanged (existing readers parse it) — the gate output tail is appended.
 *
 * Friction classification (ADR-0001 clause 5, anton-tuf4l): this poison parks the job through the
 * runner's ordinary non-quota path, so it counts toward `failureParkCount` — anton failing, a human
 * has to clear it — same as any other poison park. No new counter: a gate still red after the one
 * bounded follow-up round (anton-pwekp) is exactly the "job parked (non-quota)" row in the gap-3
 * taxonomy, not a new kind of stop.
 */
function gateFailurePoison(red: VerifyGateOutcome, number: number): PoisonError {
  return new PoisonError(
    `${red.label} gate failed after review-fix for PR #${number} (exit ${red.code})\n\n` +
      tailLines(red.output, GATE_FAILURE_OUTPUT_CHARS),
  );
}

export async function runTestGate(
  settings: ProjectSettings,
  cwd: string,
  signal: AbortSignal,
  logPath: string,
  number: number,
): Promise<void> {
  const red = await captureRedGate(settings, cwd, signal, logPath);
  if (red) throw gateFailurePoison(red, number);
}

/**
 * Run the verify gates; on red, give the fix ONE bounded follow-up claude round — in the same
 * worktree, with the gate's own label + tailed output in its prompt — and re-run the gates before
 * giving up (anton-pwekp). A deterministic gate failure the agent could fix (a migration
 * re-stamp, a lint error) reaches it exactly once: green after the follow-up returns normally so
 * the caller pushes as usual; still red parks with the SECOND run's output, exactly as a first-try
 * red would have without this round. Called from both the normal dispatch path and the
 * already-ahead fast path in `runFixSession`, each call site gets at most one follow-up — there is
 * no loop here to bound.
 *
 * Transient failures (an aborted signal, a killed process) never reach the follow-up at all:
 * `captureRedGate` (via `captureVerifyGates`) REJECTS for those rather than returning a red
 * outcome, so they propagate as an ordinary retryable error out of this function without spending
 * the round.
 */
async function runGatesWithFollowUp(args: {
  db: AntonDb;
  clock: Clock;
  ctx: JobContext;
  projectId: string;
  epic: Bead;
  settings: ProjectSettings;
  worktree: Worktree;
  pr: PrReview;
  run: RunRow | undefined;
  number: number;
  logPath: string;
  onEvent: (event: ClaudeEvent) => void;
  /** Called once the follow-up round is actually dispatched, so the caller can note it for the park comment. */
  onFollowUpAttempted: () => void;
}): Promise<void> {
  const {
    db,
    clock,
    ctx,
    projectId,
    epic,
    settings,
    worktree,
    pr,
    run,
    number,
    logPath,
    onEvent,
    onFollowUpAttempted,
  } = args;

  const red = await captureRedGate(settings, worktree.path, ctx.signal, logPath);
  if (!red) return;

  await appendSessionLog(
    logPath,
    `[review-fix] PR #${number}: ${red.label} gate failed (exit ${red.code}); running one follow-up fix round before parking\n`,
  );
  onFollowUpAttempted();
  // The main round plus the first gate can already have burned most of a bounded
  // `jobTimeoutMinutes` — reset the no-progress clock before spending it on the follow-up round and
  // the gate re-run below, since `ctx.claudeReached()` is a no-op after the first spawn and can't do
  // it for us (PR #338 review, chatgpt-codex-connector).
  await ctx.heartbeat();
  await runGateFixFollowUp({
    db,
    clock,
    ctx,
    projectId,
    epic,
    settings,
    worktree,
    pr,
    run,
    number,
    onEvent,
    red,
  });
  await ctx.heartbeat();

  const red2 = await captureRedGate(settings, worktree.path, ctx.signal, logPath);
  if (red2) throw gateFailurePoison(red2, number);
}

/**
 * The bounded follow-up round itself: one claude dispatch over the gate's own label + tailed
 * output, via the same `reviewFixContext` protocol as the main fix (so the gate-failure section
 * sits beside conflicts/threads rather than needing a parallel prompt). Mirrors the main dispatch
 * in `runFixSession` (routing, model, metering, permission mode) so this round is billed and
 * routed identically; an unsuccessful claude result throws a plain (retryable) error, same as the
 * main dispatch — only the SECOND gate run decides whether this attempt parks.
 */
async function runGateFixFollowUp(args: {
  db: AntonDb;
  clock: Clock;
  ctx: JobContext;
  projectId: string;
  epic: Bead;
  settings: ProjectSettings;
  worktree: Worktree;
  pr: PrReview;
  run: RunRow | undefined;
  number: number;
  onEvent: (event: ClaudeEvent) => void;
  red: VerifyGateOutcome;
}): Promise<void> {
  const { db, clock, ctx, projectId, epic, settings, worktree, pr, run, number, onEvent, red } = args;

  const { prompt, appendSystemPrompt, attribution } = await buildReviewFixPrompt({
    epic,
    pr,
    reasons: [`the ${red.label} gate failed after the fix (exit ${red.code})`],
    conflicts: [],
    gateFailure: { label: red.label, output: tailLines(red.output, GATE_FAILURE_OUTPUT_CHARS) },
    settings,
    projectDir: worktree.path,
  });

  const routing = claudeRouting(settings);
  await ctx.claudeReached(quotaMeterKey(settings));
  const result = await metered(
    db,
    clock,
    {
      projectId,
      jobType: ctx.type,
      jobId: ctx.jobId,
      step: "review-fix-gate",
      stepHandler: "review-fix",
      runId: run?.id,
      beadId: epic.id,
      modelRequested: settings.model,
      agentTag: labelValueOf(epic.labels, "agent"),
      ...attribution,
    },
    runClaude,
  )({
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
      `claude reported an error fixing the ${red.label} gate for PR #${number}: ${result.text ?? "unknown"}`,
    );
  }
}

/**
 * A git note — never pushed, see `pushBranch`'s own `git push` args below, which name only `branch`
 * — marking the commit it's attached to as a hook-bypassed boundary commit `commitFix` hasn't yet
 * re-verified. Written by `commitFix` itself right after it makes one (see below) and read back by
 * `commitFix` on every OTHER call, so a boundary commit's unverified status survives past the
 * runFixSession call graph that created it — a job retry, or a resumed "already ahead" fast path,
 * is a brand-new process with none of this round's in-memory state, and used to trust an
 * `amendToVerifyHooks`/`boundaryCommitted` flag that only ever reflected what THIS call happened to
 * know, not what the worktree's actual HEAD carries (PR #338 review round 3, chatgpt-codex-connector:
 * a hook rejecting the re-verify commit restores HEAD to that same unverified boundary commit, and
 * the next dispatch — finding the branch already ahead of origin — took the fast path and pushed it
 * exactly as rejected). A note survives because it lives on the commit object itself, in a ref this
 * file never pushes. A commit that gets genuinely re-verified USUALLY lands under a new sha (an
 * ordinary `git commit`, or `commitAll`'s own reset + recommit) that the marker simply doesn't carry
 * forward onto — but `commitAll`'s amend path can reproduce the exact same tree, parents, message, and
 * author, and within the same one-second git timestamp resolution that reproduces the IDENTICAL sha
 * too (PR #338 review round 4, chatgpt-codex-connector). `commitFix` therefore explicitly removes the
 * marker via {@link clearUnverifiedBoundaryMarker} once a re-verify commit lands, rather than relying
 * on the sha having changed.
 */
const UNVERIFIED_BOUNDARY_NOTES_REF = "refs/notes/anton-review-fix-boundary";

async function markUnverifiedBoundary(worktreePath: string): Promise<void> {
  await git(worktreePath, [
    "notes",
    `--ref=${UNVERIFIED_BOUNDARY_NOTES_REF}`,
    "add",
    "-f",
    "-m",
    "hooks bypassed for this commit; not yet re-verified",
    "HEAD",
  ]);
}

async function commitCarriesUnverifiedBoundaryMarker(
  worktreePath: string,
  commit: string,
): Promise<boolean> {
  try {
    await git(worktreePath, ["notes", `--ref=${UNVERIFIED_BOUNDARY_NOTES_REF}`, "show", commit]);
    return true;
  } catch (error) {
    if (exitedWith(error, 1)) return false;
    throw error;
  }
}

/**
 * Every commit on `branch` not yet on `origin/<branch>`, oldest first — the range a marker search
 * must cover, not just literal `HEAD` (PR #338 review, chatgpt-codex-connector, round 6): an
 * operator's own plain commit landed on top of a parked, hook-bypassed boundary while resuming — the
 * explicitly supported "already ahead" resume flow — shifts `HEAD` off the marked commit without the
 * branch becoming any less unverified.
 *
 * Propagates when the range can't be resolved (PR #338 review round 9, chatgpt-codex-connector),
 * rather than silently narrowing the search to literal `HEAD`: a prior fallback did that and missed
 * exactly the ancestor-marker case above whenever `origin/<branch>` was momentarily unresolvable,
 * while `branchAheadOfRemote` treats that same missing ref as "ahead" — the combination let an
 * already-ahead resume push a hook-rejected boundary straight past re-verification. Failing loud
 * here instead surfaces the lookup failure to `findUnverifiedBoundaryAncestor`'s own caller, which
 * must fail closed rather than proceed as if no marker existed. review-fix only ever runs against a
 * branch that already has an open PR, so `origin/<branch>` normally exists; an unresolvable range is
 * not the expected path.
 *
 * `--first-parent` (PR #338 review, chatgpt-codex-connector, round 7): a premerge of the base
 * creates a merge commit whose second parent is the base tip, so a plain `origin/<branch>..HEAD`
 * range also enumerates every commit reachable only through that side — the branch's own unpushed
 * commits AND the base's entire intervening history. Each would then get its own `git notes show`
 * call below, so a long-lived PR merging a base with hundreds of commits makes every marker check
 * needlessly slow. Restricting to the first-parent chain keeps this to the branch's own mainline.
 */
async function unpushedCommitsOldestFirst(worktreePath: string, branch: string): Promise<string[]> {
  const out = await git(worktreePath, [
    "rev-list",
    "--first-parent",
    "--reverse",
    `origin/${branch}..HEAD`,
  ]);
  return out
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

/**
 * The oldest unpushed commit still carrying an unverified-boundary marker, if any — what
 * `commitFix`'s re-verify amend must reset PAST so the project's hooks see that commit's FULL
 * bypassed diff, not just what a commit stacked on top of it later changed. Searching only `HEAD`
 * (this file's original check) missed exactly the scenario an operator's own resume commit creates:
 * the note stays on the parent while `HEAD` moves off it (PR #338 review, chatgpt-codex-connector,
 * round 6).
 */
async function findUnverifiedBoundaryAncestor(
  worktreePath: string,
  branch: string,
): Promise<string | undefined> {
  for (const commit of await unpushedCommitsOldestFirst(worktreePath, branch)) {
    if (await commitCarriesUnverifiedBoundaryMarker(worktreePath, commit)) return commit;
  }
  return undefined;
}

/**
 * Remove the marker from HEAD once its commit has actually been re-verified by the project's real
 * hooks (PR #338 review round 4, chatgpt-codex-connector). The doc comment on
 * {@link UNVERIFIED_BOUNDARY_NOTES_REF} used to assume a re-verified commit always lands under a new
 * sha, so the marker would simply not carry forward — but `commitAll`'s amend path resets to the
 * boundary's own parent and recommits the SAME tree, message, and author; within the same one-second
 * git timestamp resolution that reproduces the IDENTICAL sha, leaving the note still attached to a
 * commit that has since been pushed as verified. A later round would then find `HEAD` still "marked",
 * force a fresh (and now diverging) boundary commit on top of it, and fail to push as a non-fast-
 * forward against what's already on the remote. Exit 1 (no note on this object) is the expected case
 * when the sha DID change and is silently fine; anything else is a real failure to surface.
 */
async function clearUnverifiedBoundaryMarker(worktreePath: string): Promise<void> {
  try {
    await git(worktreePath, ["notes", `--ref=${UNVERIFIED_BOUNDARY_NOTES_REF}`, "remove", "HEAD"]);
  } catch (error) {
    if (exitedWith(error, 1)) return;
    throw error;
  }
}

/**
 * Stage whatever is in the worktree and commit it, with the recovery a commit timeout needs. Split
 * out of `commitAndPushFix` (anton-vtex7) so `runFixSession` can land a resolved base merge BEFORE
 * the verify gates run, while the push itself still waits behind them. Returns whether a commit
 * exists to push (this call made one, or the tree had nothing new to add) and the hooksPath
 * resolved for it, which `commitAndPushFix` reuses for the push.
 *
 * `bypassHooks` (PR #338 review, chatgpt-codex-connector): only `runFixSession`'s pre-gate boundary
 * commit passes this — it exists to snapshot "what the main round changed" before gates run, not to
 * publish anything, and a project's own pre-commit hook enforcing the same check a verify gate does
 * would otherwise reject it before the gate (and its bounded follow-up round) ever gets a chance.
 * `commitAndPushFix`'s own call never bypasses. A commit made this way is marked with
 * {@link markUnverifiedBoundary} so every later call — this round's own, or a future retry's —
 * knows to re-verify it.
 *
 * `amendToVerifyHooks` covers the case that boundary commit's doc comment used to promise but didn't
 * keep (PR #338 review, chatgpt-codex-connector, round 2): when the follow-up round adds nothing new
 * to stage, there is nothing left for `commitAndPushFix`'s call to actually commit, so the
 * hook-bypassed boundary commit would otherwise reach the remote having never had the project's real
 * hooks run over it. The caller need not pass this explicitly for that case — whenever
 * `bypassHooks` is unset, this function checks {@link findUnverifiedBoundaryAncestor} itself
 * and forces it on, so a fresh process picks up exactly where an in-memory flag would have (round 3
 * of the same review).
 */
async function commitFix(
  repo: string,
  worktreePath: string,
  epicId: string,
  branch: string,
  number: number,
  settings: ProjectSettings,
  signal: AbortSignal,
  options: { bypassHooks?: boolean; amendToVerifyHooks?: boolean } = {},
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
  // See this function's own doc comment: a bypass call never needs this (it's about to BECOME the
  // unverified boundary, not verify one), but every other call must ask the worktree itself, not
  // trust whatever this round happens to remember. Searches the whole unpushed range, not just
  // literal HEAD (PR #338 review, chatgpt-codex-connector, round 6) — an operator's own plain commit
  // stacked on a parked boundary while resuming leaves HEAD unmarked without making the branch any
  // less unverified.
  const boundaryAncestor = options.bypassHooks
    ? undefined
    : await findUnverifiedBoundaryAncestor(worktreePath, branch);
  const amendToVerifyHooks = options.amendToVerifyHooks || boundaryAncestor !== undefined;
  let committed: boolean;
  try {
    ({ committed } = await commitAll(
      worktreePath,
      `${epicId}: address review feedback (PR #${number})`,
      {
        hooksPath,
        bypassHooks: options.bypassHooks,
        amendToVerifyHooks,
        // Reset PAST the marked ancestor itself, not just HEAD's own parent, so the hook sees its
        // FULL diff even when it sits behind commits `commitFix` never made itself (round 6). `undefined`
        // when the caller asked for `amendToVerifyHooks` explicitly without an ancestor found —
        // `commitAll` then falls back to treating HEAD itself as the boundary, matching prior behavior.
        verifyFrom: boundaryAncestor,
        timeoutMs: resolveCommitTimeoutMs(settings),
        signal,
      },
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
    // `amendToVerifyHooks` above is what this call ASKED FOR, not necessarily what `commitAll`
    // actually ran: it only takes the amend path when nothing new was staged, so a gate follow-up
    // that DID stage new changes on top of a prior boundary commit gets an ordinary commit even when
    // this was passed (PR #338 review round 2, chatgpt-codex-connector). Trust the mode `commitAll`
    // tagged the error with over the request; only the request survives a non-commit failure (e.g.
    // `stageAll` itself throwing, which never reaches either `gitCommit` call inside `commitAll`).
    const requestedMode = amendToVerifyHooks ? "amend" : "commit";
    const attemptedAmend = (commitAttemptMode(error) ?? requestedMode) === "amend";
    if (attemptedAmend) {
      // An amend REPLACES the tip rather than adding on top of it, so `before.head` is never an
      // ancestor of `after.head` even when it landed cleanly — `isAncestor` below would wrongly
      // poison every timed-out-but-actually-landed amend. Confirm instead that only the tip itself
      // changed: the new tip's parent(s) must be exactly what the boundary's were — `boundaryAncestor`
      // when the amend reset past a marked commit BEHIND HEAD (round 6), else `before.head` itself,
      // matching what `commitAll` actually reset against in either case.
      const [beforeParents, afterParents] = await Promise.all([
        commitParentShas(worktreePath, boundaryAncestor ?? before.head),
        commitParentShas(worktreePath, after.head),
      ]);
      const sameParents =
        beforeParents.length === afterParents.length &&
        beforeParents.every((p, i) => p === afterParents[i]);
      if (!sameParents) {
        throw new PoisonError(
          `review fix for PR #${number} rewrote ${branch} instead of amending its boundary commit`,
          { cause: error },
        );
      }
    } else if (!(await isAncestor(worktreePath, before.head, after.head))) {
      throw new PoisonError(
        `review fix for PR #${number} rewrote ${branch} instead of adding its commit`,
        { cause: error },
      );
    }
    committed = true;
  }
  if (committed && options.bypassHooks) {
    try {
      await markUnverifiedBoundary(worktreePath);
    } catch (error) {
      // The commit above already landed even though writing its marker failed (PR #338 review round
      // 4, chatgpt-codex-connector: e.g. concurrent note-ref lock contention). Left in place, HEAD
      // would carry a hook-bypassed commit indistinguishable from a genuinely re-verified one, and the
      // next attempt's "already ahead" fast path would push it straight past this project's hooks.
      // `reset --soft` back to `before.head` undoes only that commit, keeping the index/tree intact so
      // nothing claude produced is lost — the caller's retry restages and recommits from scratch,
      // trying the note write again.
      try {
        await git(worktreePath, ["reset", "--soft", before.head]);
      } catch (restoreError) {
        throw new PoisonError(
          `review fix for PR #${number} committed a hook-bypassed boundary commit but failed to ` +
            `mark it unverified, and restoring HEAD to ${before.head} afterward also failed — the ` +
            `worktree may be left with an unmarked bypass commit: ${(restoreError as Error).message}`,
          { cause: error },
        );
      }
      throw error;
    }
  }
  if (committed && amendToVerifyHooks) {
    await clearUnverifiedBoundaryMarker(worktreePath);
  }
  return { committed, hooksPath };
}

/**
 * Commit claude's fix and push the branch. Pushes if this run committed (here, or already via the
 * pre-gate `commitFix` call in `runFixSession` for a conflicted PR) OR a prior attempt left commits
 * unpushed (e.g. a push failed after committing, then the retry's claude produced no new diff).
 * Otherwise there is genuinely nothing to send — a clean no-op, not a silent skip of pending work.
 * Returns whether anything was pushed.
 *
 * Re-verification of a hook-bypassed boundary commit (PR #338 review, chatgpt-codex-connector,
 * rounds 2-3) is entirely `commitFix`'s own concern now — see
 * {@link findUnverifiedBoundaryAncestor} — so this function no longer needs a
 * `boundaryCommitted` flag threaded in from the caller's own call graph; that flag only ever
 * reflected THIS round's memory, not the worktree, and so missed the case of a retry that never
 * re-ran `runFixSession`'s pre-gate `commitFix` call at all (the "already ahead" fast path).
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
 *
 * Returns only the outcomes that actually reached the PR in a way that stops the thread being
 * re-triaged: a posted reply, or — for a "fixed" outcome — a resolve that went through on its own
 * (a resolved thread is gone from `threadsNeedingAttention` regardless of whether the reply landed,
 * so its delivery must be counted here or nowhere; PR #335 review). A GitHub failure on both must
 * not report as delivered: the thread is still waiting on anton and would otherwise be counted as
 * answered nowhere anyone can see it. Callers that persist "what this round did"
 * (`recordReviewRound`, `refreshFixRoundsBody`) must use this return value, not the raw report.
 */
export async function applyThreadOutcomes(args: {
  repo: string;
  number: number;
  pr: PrReview;
  report: ThreadOutcome[];
  pushed: boolean;
  signal: AbortSignal;
  logPath: string;
}): Promise<ThreadOutcome[]> {
  const delivered: ThreadOutcome[] = [];
  for (const { item, thread, anchor } of triageOutcomes(args.pr, args.report, args.pushed)) {
    if (await recordThreadOutcome(args, thread, anchor.id, item)) delivered.push(item);
  }
  return delivered;
}

/** Reply on the thread, resolve it when the fix landed, and log what was said. Returns whether
 * the outcome reached GitHub in a way that makes the thread stop being actionable: either the
 * reply posted, or — for a "fixed" outcome — the resolve went through even though the reply
 * itself failed (a resolved thread never resurfaces for a later round to retry, so its delivery
 * would otherwise be lost from every round/PR-body count for good). The reaction stays best-effort
 * on top of both. */
async function recordThreadOutcome(
  args: ThreadReplyArgs,
  thread: ReviewThread,
  anchorId: number,
  item: ThreadOutcome,
): Promise<boolean> {
  const { repo, number, signal, logPath } = args;
  const note = item.reply?.trim() || defaultReply(item.outcome);
  const replied = await safe(() =>
    replyToReviewComment(repo, number, anchorId, `${ANTON_MARK} ${note}`, signal),
  );
  await safe(() => reactToReviewComment(repo, anchorId, reactionForOutcome(item.outcome), signal));
  const resolved =
    item.outcome === "fixed" && (await safe(() => resolveReviewThread(repo, thread.id, signal)));
  // Best-effort: a diagnostic log write must never cost an already-delivered outcome (PR #335 review).
  await appendSessionLog(
    logPath,
    `[review-fix] thread ${thread.id}: ${item.outcome} — ${note}\n`,
  ).catch(() => {});
  return replied || resolved;
}

/**
 * Refresh the PR body's review-fix-rounds region with what THIS round fixed (anton-te6nr), reusing
 * the fixer's own per-thread report rather than a fresh LLM call. Runs strictly AFTER the push (the
 * caller only reaches this once `pushed` is known), so the body never claims a fix that isn't on
 * the remote yet — and touches `gh` not at all for a round that pushed nothing, or has nothing
 * worth naming: {@link fixRoundFrom} answers that cheaply, before any network call. `reasons` names
 * this round's own trigger and backs a fallback entry when the report has no thread outcomes at all
 * (a CI-only or merge-conflict-only round, which never emits a reporting contract to parse).
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
  /** Verdict reasons this round acted on — the fallback entry when no thread report survives. */
  reasons?: string[];
}): Promise<void> {
  const { repo, number, report, pushed, now, logPath, reasons = [] } = args;
  if (!pushed) return;
  if (!fixRoundFrom(report, pushed, now, reasons)) return; // nothing to say this round — no gh call
  const selector = String(number);
  const currentBody = await readPullRequestBody(repo, selector);
  if (currentBody === undefined) {
    await appendSessionLog(
      logPath,
      `[review-fix] could not read PR #${number}'s body to refresh its review-fix rounds\n`,
    );
    return;
  }
  const content = nextFixRoundsRegion(currentBody, report, pushed, now, reasons);
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

/**
 * Publish the {@link NON_THREAD_REPORT_ID} sentinel's explanation as a normal PR comment for an
 * unpushed round — the only case where `refreshFixRoundsBody` never runs (it returns immediately
 * when nothing pushed), so the sentinel's reply would otherwise never reach anywhere a reviewer can
 * see it, even though `allWaitingThreadsAnswered` is about to treat it as a real answer and
 * suppress this fingerprint+headSha for good. Idempotent against the PR's comment history, same as
 * `notifyGateParked` — a resumed job re-parsing the same report has nothing local to remember.
 *
 * Returns whether the explanation actually reached GitHub (already posted, or posted just now) —
 * the caller must not let `allWaitingThreadsAnswered` credit this round when a transient
 * `gh pr comment` failure meant nobody ever saw why nothing changed (PR #338 review,
 * @chatgpt-codex-connector).
 */
async function publishUnpushedSentinel(args: {
  repo: string;
  number: number;
  sentinel: ThreadOutcome;
  signal: AbortSignal;
  logPath: string;
}): Promise<boolean> {
  const { repo, number, sentinel, signal, logPath } = args;
  const note = sentinel.reply?.trim() || defaultReply(sentinel.outcome);
  const body = `${ANTON_MARK} anton did not push a fix for PR #${number} (${sentinel.outcome}) — ${note}`;
  const existing = await getPrComments(repo, number, signal).catch((): string[] => []);
  if (existing.includes(body)) return true;
  const posted = await safe(() => commentOnPr(repo, number, body, signal));
  if (posted) {
    await appendSessionLog(logPath, `[review-fix] PR #${number}: published unpushed-round outcome — ${note}\n`);
  }
  return posted;
}

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
