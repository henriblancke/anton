/**
 * The pre-PR self-review gate (anton-cbak): review the run's own diff in a FRESH claude context,
 * auto-fix the blocking findings, re-review, and converge within a bounded number of rounds.
 *
 * Modelled on review-fix.ts's `runFixSession` — every claude invocation is its own recorded session
 * (so the UI can follow it), verify gates run before the fix is committed, and errors propagate so
 * the runner applies quota backoff / retry / park. The reviewer never resumes a claude session: a
 * reviewer that inherits the implementer's context is not a second opinion.
 *
 * This module DECIDES NOTHING about parking. It returns the rounds it ran (each with the validated
 * score) plus the findings still unresolved at exit, each carrying its severity; the call-site
 * (anton-omum) parks on unresolved blocking findings or proceeds with advisory ones. Keeping the
 * converge loop free of execute-epic wiring is what makes it unit-testable against a fake driver.
 */
import { type Bead } from "../beads/bd";
import { runClaude, type ClaudeResult, type RunClaudeOptions } from "../claude/driver";
import {
  commitAll,
  diffAgainstBase,
  readWorktreeState,
  resolveMergeBase,
  restoreWorktreeState,
  sameWorktreeState,
  type BranchDiff,
  type WorktreeState,
} from "../git/ops";
import { resolveReviewConfig, resolveVerifyGates, type ProjectSettings } from "../projects";
import { appendSessionLog, endSession, startJobSession } from "../sessions";
import { PoisonError } from "./errors";
import type { AntonDb, Clock } from "./queue";
import {
  buildFindingsFixPrompt,
  buildReviewPrompt,
  parseReviewFindings,
  type ReviewFinding,
  type ReviewProtocolViolation,
  type ReviewReportResult,
  type ReviewerSource,
} from "./review-context";
import type { JobContext } from "./runner";
import { runVerifyGates } from "./shell";

/** One review (and the fix it dispatched, if any) — the record the call-site persists per round. */
export interface ReviewRound {
  /** 1-based round number. */
  round: number;
  /** The recorded review session — always present, so the UI can open the reviewer's log. */
  reviewSessionId: string;
  /** The reviewer's validated 0-10 score; absent only on a protocol violation. */
  score?: number;
  /** The reviewer's one-line justification of the score — present whenever `score` is. */
  rationale?: string;
  /** Set instead of `score` when the report never came / carried an unusable score. */
  violation?: ReviewProtocolViolation;
  blocking: number;
  advisory: number;
  /** The recorded fix session, when this round's blocking findings were dispatched for repair. */
  fixSessionId?: string;
  /** Whether the fix session actually changed (and so committed) anything. */
  fixCommitted?: boolean;
}

/**
 * Why the loop stopped. Every value except `clean` leaves work for a human to judge; which of them
 * blocks the PR is the CALL-SITE's decision (severity-split), not this module's.
 */
export type ReviewGateOutcome =
  /** The final review reported no blocking findings — `unresolved` holds any advisory ones. */
  | "clean"
  /** Blocking findings survived the round cap. */
  | "unresolved"
  /** A fix session left the tree unchanged, so re-reviewing the same diff cannot change anything. */
  | "stalled"
  /** The final review never spoke the report protocol — silence is not a clean review. */
  | "protocol-violation";

export interface ReviewGateResult {
  outcome: ReviewGateOutcome;
  /** Every round that ran, in order — each with its validated score for the call-site to persist. */
  rounds: ReviewRound[];
  /**
   * Findings open at exit, each carrying its severity: the final review's — it is shown every
   * advisory still open from earlier rounds and restates the ones that still apply — plus, when that
   * review broke the protocol and so settled nothing, the earlier advisories (see
   * {@link withCarried}).
   */
  unresolved: ReviewFinding[];
  /** Which reasoning contract reviewed: a named agent, the operator's prompt, or the shipped default. */
  reviewer: ReviewerSource;
  /** The final round's validated score, when that review spoke the protocol. */
  score?: number;
}

/**
 * The seams a unit test replaces (a fake claude driver, an in-memory diff, a no-op commit) so the
 * converge loop can be exercised without a real repo or a real agent. Production passes none of them.
 */
export interface ReviewGateDeps {
  runClaude?: (options: RunClaudeOptions) => Promise<ClaudeResult>;
  diff?: (worktreePath: string, base: string) => Promise<BranchDiff>;
  /** Pin the movable base branch to the fork-point commit every round is judged against. */
  mergeBase?: (worktreePath: string, base: string) => Promise<string>;
  commit?: (worktreePath: string, message: string) => Promise<{ committed: boolean }>;
  /** Fingerprint the worktree around a review — the read-only guard's before/after. */
  readState?: (worktreePath: string) => Promise<WorktreeState>;
  /** Undo whatever a review wrote, back to the fingerprint taken before it ran. */
  restoreState?: (worktreePath: string, state: WorktreeState) => Promise<void>;
}

/** The slice of the runner's JobContext the gate needs — narrow, so tests can fake it in two lines. */
export type ReviewGateContext = Pick<JobContext, "signal" | "heartbeat" | "report">;

export interface ReviewGateArgs {
  db: AntonDb;
  clock: Clock;
  ctx: ReviewGateContext;
  projectId: string;
  /** The run row the sessions hang off, for UI linkage. */
  runId?: string;
  /** The run target — the epic, or the single bead of a standalone run. */
  target: Bead;
  /** Every ticket the run implemented, in execution order. */
  tickets: Bead[];
  settings: ProjectSettings;
  /** The run's worktree: where the diff is read and the fixes land. */
  worktreePath: string;
  /**
   * Branch the run diverged from. Resolved to its merge-base COMMIT once, up front, and every round
   * reads both the patch and the trusted inputs from that SHA (see {@link runReviewGate}).
   */
  baseBranch: string;
  /**
   * Re-assert the caller's cross-machine run-lease; throws when it has lapsed.
   *
   * Called at every review and fix dispatch, not just on the way in: a review → fix → re-review
   * sequence outlives the lease TTL, so a gate checked only at its edges can keep dispatching for
   * minutes after the shared label expired and another machine started the same epic.
   */
  assertLeaseHeld?: () => void;
  /**
   * Where the gate records each COMPLETED round as it runs — the caller's only view of them when the
   * gate THROWS.
   *
   * A gate that dies mid-flight returns no result, and its error has to reach the runner as the type
   * it was thrown as: the quota backoff, the retry, and the poison park are all keyed off that, so
   * wrapping the error to carry the rounds out would trade the run's recovery for its history. Both
   * matter — a round-3 death still owes the founder rounds 1 and 2, and a rescheduled run's resumed
   * gate restarts at round 1 with nothing of the previous attempt on the board — so the rounds ride
   * on an accumulator the caller owns instead of on the error.
   */
  rounds?: ReviewRound[];
  deps?: ReviewGateDeps;
}

/**
 * Tools denied to a review session — deny rules bind ahead of `bypassPermissions`, which is what
 * makes them a guard rather than a request.
 *
 * Every file-WRITING tool, because a review writes nothing: the guard below reverts what a reviewer
 * touched, but reverting is after the fact, and the tools cost the review nothing to lose. Naming
 * them is bounded and stable, unlike enumerating a shell's writing commands.
 *
 * `git` in full, because the worktree fingerprint cannot see the repository the worktree belongs to:
 * `git branch anton/<future-bead> HEAD` writes a ref while HEAD, the symbolic ref, and porcelain
 * status all stay identical, and `createWorktree` adopts an existing branch instead of cutting one
 * from the base — so a reviewer could plant commits in an unrelated later run's PR and still pass the
 * read-only guard. Denied rather than fingerprinted-and-restored because the ref store is SHARED:
 * anton runs several epics per project concurrently in sibling worktrees, and they legitimately
 * create branches, commit, and update `refs/remotes/*` throughout a review. Snapshotting refs could
 * not tell a sibling run's branch from a reviewer's, so restoring would delete a branch another
 * worktree has checked out, and merely detecting would park healthy runs. All of `git`, not its
 * writing subcommands: an enumeration rots into a gap the next git release opens, and the reviewer
 * needs none of it — anton hands it the diff, the file list, and the beads.
 *
 * KNOWN RESIDUAL (anton-t6tu): `Bash` itself stays, because the review contract asks the reviewer to
 * run the project's own read-only checks. A shell can still write bytes anywhere — `printf <sha> >
 * <repo>/.git/refs/heads/anton/<future-bead>` plants exactly the branch the git deny rule exists to
 * prevent, with no `git` process and no visible change to this worktree. No tool-name filter closes
 * that; it needs OS-level filesystem containment for the session, which is that bead's work.
 */
export const REVIEW_DENIED_TOOLS = ["Write", "Edit", "MultiEdit", "NotebookEdit", "Bash(git:*)"];

/**
 * Settings sources a review session loads: the operator's `user` settings only.
 *
 * `project` (`.claude/settings.json`) and `local` (`.claude/settings.local.json`) are read from the
 * worktree — the tree under review. Project settings are source-controlled, so a run that adds or
 * edits them configures the session that judges it, and settings register HOOKS, which run shell
 * commands: a `Stop` or tool hook could steer the verdict, or reach git indirectly and write a ref
 * the worktree fingerprint cannot see ({@link REVIEW_DENIED_TOOLS}). Dropping the two branch-owned
 * sources leaves the reviewer configured only by the machine anton runs on.
 *
 * The same flag is what isolates the reviewer from the branch's MEMORY. Claude Code gates project
 * memory on the setting sources, not just settings files: under `--setting-sources user` it loads
 * neither the worktree's root `CLAUDE.md` / `AGENTS.md` nor the nested per-directory files it would
 * otherwise pick up as the reviewer reads changed files (verified against Claude Code 2.1.220). So a
 * run that rewrites its own memory cannot instruct the session grading it — those edits reach the
 * reviewer as patch content, like every other change. What the reviewer can still do is OPEN one of
 * those files itself, which is why the prompt also says plainly which text carries authority (see
 * `rulesCaveat` in review-context).
 *
 * The FIX session keeps the default sources: it is an implementer, and the project's own hooks
 * (formatters, guards) are supposed to apply to the code it writes.
 */
export const REVIEW_SETTING_SOURCES = ["user"] as const;

/** Findings that hold the PR back. The call-site's park decision reads exactly this. */
export function blockingFindings(findings: ReviewFinding[]): ReviewFinding[] {
  return findings.filter((f) => f.severity === "blocking");
}

/** How the last round broke the protocol, when it did — what the call-site's park reason reads. */
export function finalViolation(result: ReviewGateResult): ReviewProtocolViolation | undefined {
  return result.rounds[result.rounds.length - 1]?.violation;
}

/**
 * Review → fix → re-review until the reviewer reports nothing blocking or the round cap is reached.
 *
 * A fix is only dispatched while a further round remains: a fix nobody re-reviews has no evidence it
 * worked, so the last round is a review, not a repair. With the default cap of 2 that is the
 * intended shape — one review, one fix, one confirming review.
 *
 * Propagates whatever claude throws (notably UsageLimitError, which parks/reschedules the run like
 * any other exhausted-quota failure) after marking the in-flight session failed — unwrapped, so the
 * runner still classifies it. The rounds that completed before such a death are handed back on
 * {@link ReviewGateArgs.rounds}, which is why nothing needs wrapping.
 */
export async function runReviewGate(args: ReviewGateArgs): Promise<ReviewGateResult> {
  // Appended to as each round finishes rather than built at the end, so the caller's accumulator
  // holds what completed even when this throws.
  const rounds: ReviewRound[] = args.rounds ?? [];
  const { db, clock, ctx, projectId, runId, target, tickets, settings, worktreePath, baseBranch } = args;
  const config = resolveReviewConfig(settings);
  const claude = args.deps?.runClaude ?? runClaude;
  const readDiff = args.deps?.diff ?? diffAgainstBase;
  const mergeBase = args.deps?.mergeBase ?? resolveMergeBase;
  const commit = args.deps?.commit ?? commitAll;
  const readState = args.deps?.readState ?? readWorktreeState;
  const restoreState = args.deps?.restoreState ?? restoreWorktreeState;

  // Pin the fork point once, for every round: `baseBranch` is a MOVABLE ref (`origin/<base>`), and a
  // sibling run's fetch or a resumed worktree can advance it while this gate runs. Re-resolving it
  // per read would let the patch come from the old fork point while the reviewer's own inputs — its
  // contract, the principles, the instruction files — come from a newer tip, so a base commit that
  // deleted a rule would quietly stop that rule from grading this branch. One SHA, one baseline.
  const baseRev = await mergeBase(worktreePath, baseBranch);

  let reviewer: ReviewerSource = { kind: "default" };
  /** Advisories still open from earlier rounds — shown to the next review, which settles them. */
  let carried: ReviewFinding[] = [];

  for (let round = 1; round <= config.maxRounds; round++) {
    await ctx.heartbeat();
    args.assertLeaseHeld?.(); // don't review under a lease that lapsed during an earlier round

    const review = await runReviewSession({
      db,
      clock,
      ctx,
      projectId,
      runId,
      target,
      tickets,
      settings,
      worktreePath,
      baseRev,
      readDiff,
      carried,
      round,
      maxRounds: config.maxRounds,
      claude,
      readState,
      restoreState,
    });
    reviewer = review.reviewer;

    const findings = review.report.findings;
    const blocking = blockingFindings(findings);
    const entry: ReviewRound = {
      round,
      reviewSessionId: review.sessionId,
      blocking: blocking.length,
      advisory: findings.length - blocking.length,
      ...(review.report.ok
        ? { score: review.report.score, rationale: review.report.rationale }
        : { violation: review.report.violation }),
    };
    rounds.push(entry);

    // A review that spoke the protocol read the carried advisories (they are in its prompt) against
    // the diff as it stands now, so its report IS the disposition: one it did not restate is settled
    // — typically by a blocking fix that shared the advisory's root cause. A broken report settles
    // nothing, so there the earlier advisories still ride along.
    const unresolved = review.report.ok ? findings : withCarried(findings, carried);

    // A reviewer that never reported, or reported an unusable score, has told us nothing about the
    // work — the run is handed back with whatever findings were salvaged, never as a clean review.
    if (!review.report.ok) return { outcome: "protocol-violation", rounds, unresolved, reviewer };
    if (blocking.length === 0) {
      return { outcome: "clean", rounds, unresolved, reviewer, score: review.report.score };
    }
    if (round === config.maxRounds) {
      return { outcome: "unresolved", rounds, unresolved, reviewer, score: review.report.score };
    }

    // Replaces, never accumulates: this round was shown the previous carry and restated whatever
    // still applied, so its advisories are the whole open set going into the next round.
    carried = findings.filter((f) => f.severity === "advisory");
    args.assertLeaseHeld?.(); // don't write a fix under a lease that lapsed while reviewing
    const fix = await runGateFixSession({
      db,
      clock,
      ctx,
      projectId,
      runId,
      target,
      settings,
      worktreePath,
      findings: blocking,
      round,
      maxRounds: config.maxRounds,
      claude,
      commit,
      readState,
      restoreState,
    });
    entry.fixSessionId = fix.sessionId;
    entry.fixCommitted = fix.committed;

    // Nothing changed: the next review would read the identical diff and report the identical
    // findings. Stop and let the call-site decide, rather than burning the remaining rounds.
    if (!fix.committed) {
      return { outcome: "stalled", rounds, unresolved, reviewer, score: review.report.score };
    }
  }

  // Only reachable with a cap below 1 — a configuration that asks for a review gate and then forbids
  // it from ever reviewing. Poison, so the run parks for a human instead of passing as reviewed.
  throw new PoisonError(
    `review gate for ${target.id} ran no rounds: reviewMaxRounds is ${config.maxRounds} (must be at least 1)`,
  );
}

/**
 * One review: a FRESH claude session (never a resume, no execution system prompt — the reviewer gets
 * the reasoning contract and the run context, nothing the implementer was told) plus the parsed
 * report. The session is recorded before the dispatch and closed either way, so a mid-review failure
 * leaves a `failed` session rather than a stuck `running` one.
 *
 * The review is READ-ONLY, and enforced rather than merely asked for: the worktree is fingerprinted
 * around the dispatch, and a reviewer that wrote anything has its changes reverted and its report
 * rejected. A reviewer runs unattended with the same permissions as the implementer — nothing but
 * this stops a swapped, implementation-minded agent from silently repairing what it is grading and
 * then passing it. Its fix would be thrown away (the branch anton pushes is the reviewed HEAD) or,
 * worse, ride along uninspected in the next fix session's commit.
 *
 * The fingerprint covers the worktree, so `git` is denied outright ({@link REVIEW_DENIED_TOOLS}) to
 * cover what it cannot see: the repository the worktree belongs to, where a written ref leaves the
 * tree byte-identical. And the session is loaded from the operator's settings only
 * ({@link REVIEW_SETTING_SOURCES}), so the branch under review cannot configure — or hook — the
 * session judging it.
 *
 * The revert runs on EVERY exit once the baseline is settled — a review that throws or reports an
 * error is exactly as capable of having written first, and its leftovers would otherwise outlive it
 * (see `discardSessionWrites`).
 *
 * The diff and the prompt are read INSIDE the session, after the baseline is settled, so what the
 * reviewer is shown and what it can read on disk are the same tree.
 */
async function runReviewSession(args: {
  db: AntonDb;
  clock: Clock;
  ctx: ReviewGateContext;
  projectId: string;
  runId?: string;
  target: Bead;
  tickets: Bead[];
  settings: ProjectSettings;
  worktreePath: string;
  /** The pinned fork-point commit: the patch AND the reviewer's trusted inputs both come from it. */
  baseRev: string;
  readDiff: (worktreePath: string, base: string) => Promise<BranchDiff>;
  /** Advisories still open from earlier rounds — this review restates or settles each. */
  carried: ReviewFinding[];
  round: number;
  maxRounds: number;
  claude: (options: RunClaudeOptions) => Promise<ClaudeResult>;
  readState: (worktreePath: string) => Promise<WorktreeState>;
  restoreState: (worktreePath: string, state: WorktreeState) => Promise<void>;
}): Promise<{ sessionId: string; reviewer: ReviewerSource; report: ReviewReportResult }> {
  const { db, clock, ctx, projectId, runId, target, tickets, settings, worktreePath, round, maxRounds, claude } = args;

  const { sessionId, logPath, onEvent } = await startJobSession(db, clock, {
    projectId,
    runId,
    kind: "review",
    beadId: target.id,
  });
  ctx.report({ sessionId, cwd: worktreePath });

  try {
    const before = await settleBaseline({
      worktreePath,
      logPath,
      round,
      maxRounds,
      readState: args.readState,
      restoreState: args.restoreState,
    });

    try {
      const diff = await args.readDiff(worktreePath, args.baseRev);
      const { prompt, reviewer } = await buildReviewPrompt({
        target,
        tickets,
        diff,
        settings,
        projectDir: worktreePath,
        // Literally the same commit the diff is taken from — a pinned SHA, not the movable base ref
        // it was resolved from: everything the reviewer is handed comes from one revision this run's
        // own diff could not have written, and that no commit landing on the base mid-review moves.
        baseRev: args.baseRev,
        carriedAdvisories: args.carried,
      });
      await appendSessionLog(
        logPath,
        `[review] round ${round}/${maxRounds}: reviewing ${diff.files.length} changed file(s) against ` +
          `${args.baseRev.slice(0, 12)} as ${describeReviewer(reviewer)}\n`,
      );

      const result = await claude({
        cwd: worktreePath,
        prompt,
        model: settings.model,
        permissionMode: settings.permissionMode ?? "bypassPermissions",
        disallowedTools: REVIEW_DENIED_TOOLS,
        settingSources: [...REVIEW_SETTING_SOURCES],
        signal: ctx.signal,
        onEvent,
      });
      if (!result.ok) {
        throw new Error(`claude reported an error reviewing ${target.id}: ${result.text ?? "unknown"}`);
      }

      const report = await enforceReadOnly({
        report: parseReviewFindings(result.text),
        worktreePath,
        before,
        logPath,
        round,
        maxRounds,
        readState: args.readState,
        restoreState: args.restoreState,
      });
      await appendSessionLog(logPath, `[review] round ${round}/${maxRounds}: ${describeReport(report)}\n`);
      await endSession(db, clock, sessionId, "done");
      return { sessionId, reviewer, report };
    } catch (e) {
      // Throws PoisonError of its own when the reviewer's COMMIT could not be reverted — the one case
      // where retrying this worktree is more dangerous than losing the original error's backoff.
      await discardSessionWrites({
        copy: {
          tag: "review",
          actor: "review",
          parkRisk: "a retry would read that state as a settled baseline and open a PR on code no reviewer ever saw",
        },
        worktreePath,
        targetId: target.id,
        before,
        logPath,
        round,
        maxRounds,
        cause: e,
        readState: args.readState,
        restoreState: args.restoreState,
      });
      throw e;
    }
  } catch (e) {
    await endSession(db, clock, sessionId, "failed");
    throw e; // propagate so the runner applies quota backoff / retry / park
  }
}

/**
 * Settle the tree the review runs on: a COMMITTED baseline, matching the branch anton pushes.
 *
 * Uncommitted changes here are leftovers from an attempt that died before its commit — typically a
 * fix session whose verify gates failed, whose job the runner then retried into this same worktree.
 * Reviewing around them is unsound in both directions: the diff is taken from HEAD, so the reviewer
 * would grade a patch that omits files it can read (and can pass work the PR will never carry, since
 * `openPullRequest` pushes only HEAD and the finished run force-removes the worktree), while the
 * read-only guard below would adopt that dirt as its baseline and discard it on any restore anyway.
 *
 * So the leftovers are dropped, loudly, before anything is read. Nothing is lost that the loop can't
 * recreate: the discarded fix never passed its gates, and the review that follows re-reports the
 * findings it was attempting, which the next fix round dispatches again.
 */
async function settleBaseline(args: {
  worktreePath: string;
  logPath: string;
  round: number;
  maxRounds: number;
  readState: (worktreePath: string) => Promise<WorktreeState>;
  restoreState: (worktreePath: string, state: WorktreeState) => Promise<void>;
}): Promise<WorktreeState> {
  const { worktreePath, logPath, round, maxRounds } = args;

  const state = await args.readState(worktreePath);
  if (!state.status) return state;

  await args.restoreState(worktreePath, { ...state, status: "" });
  await appendSessionLog(
    logPath,
    `[review] round ${round}/${maxRounds}: the worktree carried UNCOMMITTED changes from an earlier ` +
      `attempt — discarded back to ${state.head.slice(0, 12)} so the review reads what the PR would ` +
      `push:\n${state.status}\n`,
  );
  return args.readState(worktreePath);
}

/**
 * The read-only guard: leave the worktree exactly as the reviewer found it, and reject the report of
 * a reviewer that touched it. Reverting alone is not enough — a verdict reached on code the reviewer
 * then edited says nothing about the code anton is about to push — so the round becomes a
 * `worktree-modified` protocol violation, which the call-site parks on. The reviewer's own findings
 * are carried through anyway, since they are what tells the founder why it was reaching for the
 * keyboard.
 */
async function enforceReadOnly(args: {
  report: ReviewReportResult;
  worktreePath: string;
  before: WorktreeState;
  logPath: string;
  round: number;
  maxRounds: number;
  readState: (worktreePath: string) => Promise<WorktreeState>;
  restoreState: (worktreePath: string, state: WorktreeState) => Promise<void>;
}): Promise<ReviewReportResult> {
  const { report, worktreePath, before, logPath, round, maxRounds } = args;

  const after = await args.readState(worktreePath);
  if (sameWorktreeState(after, before)) return report;

  await args.restoreState(worktreePath, before);
  await appendSessionLog(
    logPath,
    `[review] round ${round}/${maxRounds}: the reviewer MODIFIED the worktree — the changes were ` +
      `reverted to ${before.head.slice(0, 12)} and the review is rejected: a review is read-only\n`,
  );
  return { ok: false, violation: "worktree-modified", findings: report.findings };
}

/** How `discardSessionWrites` names the session it is cleaning up after, in logs and park reasons. */
interface DiscardCopy {
  /** Log tag: `review` or `review-fix`. */
  tag: string;
  /** Names the writer, article-free so the templates can supply one — "review", "review fix". */
  actor: string;
  /** What a retry would wrongly do with a rogue HEAD it cannot revert. */
  parkRisk: string;
}

/**
 * Undo what a session that died left behind, for both the review and the fix.
 *
 * For the REVIEW this is the revert `enforceReadOnly` never reaches: the review threw (abort, quota)
 * or reported an error. A reviewer that wrote before it died is no less of a problem than one that
 * survived — worse, actually, because nothing rejects its round.
 *
 * For the FIX it is the gate's own guarantee. Gates run before the commit so a failure leaves the
 * attempt uncommitted, but a fixer that committed its own work first (which project instructions
 * routinely tell an agent to do) breaks that: the gate failure would leave a verified-by-nothing
 * commit on the branch.
 *
 * Either way the leftovers would outlive the failure and the runner's retry re-enters this worktree,
 * where `settleBaseline` reads a committed write as a settled tree, adopts it as the baseline, and a
 * later clean review hands it to the PR. Rolling back to the pre-session fingerprint also makes a
 * self-committing fixer fail exactly like one that left its fix unstaged — same baseline, and the
 * gates run again on the next attempt.
 *
 * A restore that itself fails is best-effort ONLY while the write is uncommitted: the next attempt's
 * `settleBaseline` discards working-tree dirt before it reads anything, so the failure costs nothing
 * and must not replace the error the runner needs to see (UsageLimitError in particular drives
 * backoff). A session that COMMITTED — or that left HEAD on a branch of its own — is the opposite:
 * an unrevertable rogue HEAD reads as a settled tree, and a stray branch silently diverts every later
 * commit off the branch `openPullRequest` pushes. Those cases park the run as poison — deliberately
 * overriding backoff, since no retry may accept this worktree — and carry the original failure in the
 * message so the reason it died isn't lost.
 *
 * Which of the two it is can only be told from the post-session fingerprint, so a fingerprint that
 * cannot be READ does not short-circuit the restore: the reset to `before` runs anyway, and an
 * unreadable state is treated as the poison case only if that reset ALSO fails. Skipping the restore
 * on an unreadable read is what would let a self-committed, gate-failing fix survive as the next
 * attempt's baseline.
 */
async function discardSessionWrites(args: {
  copy: DiscardCopy;
  worktreePath: string;
  targetId: string;
  before: WorktreeState;
  logPath: string;
  round: number;
  maxRounds: number;
  /** The failure that brought us here — folded into the park reason when the revert can't undo it. */
  cause: unknown;
  readState: (worktreePath: string) => Promise<WorktreeState>;
  restoreState: (worktreePath: string, state: WorktreeState) => Promise<void>;
}): Promise<void> {
  const { copy, worktreePath, targetId, before, logPath, round, maxRounds, cause } = args;

  let after: WorktreeState | undefined;
  let readError: unknown;
  try {
    after = await args.readState(worktreePath);
  } catch (e) {
    readError = e; // Unknown state, not a clean one: fall through and reset unconditionally.
  }
  if (after && sameWorktreeState(after, before)) return;

  try {
    await args.restoreState(worktreePath, before);
  } catch (e) {
    // A moved HEAD or a switched branch survives a failed revert as a plausible-looking baseline;
    // uncommitted dirt does not (the next attempt discards it), so only these two park — as does a
    // state nobody could read, which may be either.
    const stuck = after === undefined || after.head !== before.head || after.ref !== before.ref;
    const left = after ? `left at ${describeRef(after)}` : `left in a state that could not be read (${String(readError)})`;
    await appendSessionLog(
      logPath,
      `[${copy.tag}] round ${round}/${maxRounds}: could not revert the failed ${copy.actor}'s changes: ${String(e)}` +
        (stuck ? ` — the worktree is stuck on its own commit/branch, so the run is parked` : ``) +
        `\n`,
    ).catch(() => {});
    if (stuck) {
      throw new PoisonError(
        `the ${copy.actor} of ${targetId} WROTE to its own worktree and the revert failed (${String(e)}): ` +
          `${worktreePath} is ${left}, not the settled ${describeRef(before)}. ` +
          `Parked instead of retried — ${copy.parkRisk}. Reset the worktree by hand, then resume. ` +
          `The ${copy.actor} itself failed with: ${String(cause)}`,
      );
    }
    return;
  }
  await appendSessionLog(
    logPath,
    after
      ? `[${copy.tag}] round ${round}/${maxRounds}: the ${copy.actor} FAILED after writing to the worktree — its ` +
          `changes were reverted to ${before.head.slice(0, 12)} so the next attempt cannot inherit them\n`
      : `[${copy.tag}] round ${round}/${maxRounds}: the ${copy.actor} FAILED and its post-session state could not be ` +
          `read (${String(readError)}) — the worktree was reset to ${before.head.slice(0, 12)} regardless, so the ` +
          `next attempt cannot inherit anything it may have written\n`,
  ).catch(() => {});
}

/**
 * One fix: a fresh claude session over the round's blocking findings, the operator's verify gates,
 * then a commit onto the run's branch. Advisory findings are deliberately NOT dispatched — they are
 * surfaced to the founder, and letting the fixer roam past the blocking list widens the diff with
 * work no reviewer asked for.
 *
 * Gate order matches execution and review-fix: gates run BEFORE the commit, so a failing gate leaves
 * the attempted fix uncommitted in the worktree and fails the job rather than pushing red code. That
 * ordering is not enough on its own — a fixer that committed its own work first would keep the commit
 * through the failure — so the failure path rolls the worktree back to the pre-fix fingerprint
 * (`discardSessionWrites`), leaving nothing a later round could mistake for a verified baseline.
 *
 * "Committed" means the ROUND made progress, not that `commitAll` did the committing. A fixer that
 * commits its own work — which project instructions routinely tell an agent to do, whatever this
 * prompt asks — leaves nothing staged, and reading that empty index as "no changes" would stall the
 * gate and park a run whose fix is already on the branch. So HEAD is compared across the session too.
 *
 * That only holds while HEAD stays on the run's branch: `openPullRequest` pushes a branch NAME, so a
 * fix committed onto a branch of the fixer's own is invisible to the PR even though the confirming
 * review can read it. That case parks rather than counting as progress.
 */
async function runGateFixSession(args: {
  db: AntonDb;
  clock: Clock;
  ctx: ReviewGateContext;
  projectId: string;
  runId?: string;
  target: Bead;
  settings: ProjectSettings;
  worktreePath: string;
  findings: ReviewFinding[];
  round: number;
  maxRounds: number;
  claude: (options: RunClaudeOptions) => Promise<ClaudeResult>;
  commit: (worktreePath: string, message: string) => Promise<{ committed: boolean }>;
  readState: (worktreePath: string) => Promise<WorktreeState>;
  restoreState: (worktreePath: string, state: WorktreeState) => Promise<void>;
}): Promise<{ sessionId: string; committed: boolean }> {
  const { db, clock, ctx, projectId, runId, target, settings, worktreePath, findings, round, maxRounds, claude, commit } =
    args;

  const { prompt, appendSystemPrompt } = await buildFindingsFixPrompt({
    target,
    findings,
    settings,
    projectDir: worktreePath,
    round,
    maxRounds,
  });

  const { sessionId, logPath, onEvent } = await startJobSession(db, clock, {
    projectId,
    runId,
    kind: "review-fix",
    beadId: target.id,
  });
  ctx.report({ sessionId, cwd: worktreePath });

  try {
    await appendSessionLog(
      logPath,
      `[review-fix] round ${round}/${maxRounds}: fixing ${findings.length} blocking finding(s)\n`,
    );
    const before = await args.readState(worktreePath);
    // Flips once the gates have passed AND the work is committed: past that point the round's output
    // is verified, and the rollback below must not touch it however the session ends.
    let verified = false;

    try {
      const result = await claude({
        cwd: worktreePath,
        prompt,
        appendSystemPrompt,
        model: settings.model,
        permissionMode: settings.permissionMode ?? "bypassPermissions",
        signal: ctx.signal,
        onEvent,
      });
      if (!result.ok) {
        throw new Error(
          `claude reported an error fixing review findings for ${target.id}: ${result.text ?? "unknown"}`,
        );
      }

      // Checked before the gates and the commit: work is only a fix if it lands where the PR looks.
      // The fixer's commits are legitimate, so they are parked for a human rather than reverted —
      // gating and committing onto the stray branch would only bury them deeper.
      const afterFix = await args.readState(worktreePath);
      if (afterFix.ref !== before.ref) {
        throw new PoisonError(
          `the review fix for ${target.id} left ${worktreePath} on a branch of its own: ${describeRef(afterFix)}, ` +
            `not the run's ${describeRef(before)}. Parked instead of retried — anton pushes the run's branch by ` +
            `name, so the fix (and every later commit) would never reach the PR, while the confirming review ` +
            `would read it and pass. Move the commits back onto the run's branch by hand, then resume.`,
        );
      }

      await runVerifyGates(
        resolveVerifyGates(settings),
        worktreePath,
        ctx.signal,
        logPath,
        (gate, code) => `${gate.label} gate failed after review round ${round} for ${target.id} (exit ${code})`,
      );

      const { committed } = await commit(worktreePath, `${target.id}: address self-review findings (round ${round})`);
      verified = true;
      // Nothing staged is only "no progress" if HEAD also stood still — otherwise the fixer committed
      // its own work and the branch already carries the repair the next review will read.
      const selfCommitted = !committed && afterFix.head !== before.head;
      await appendSessionLog(
        logPath,
        committed
          ? `[review-fix] round ${round}/${maxRounds}: committed the fix\n`
          : selfCommitted
            ? `[review-fix] round ${round}/${maxRounds}: the fixer committed its own changes — nothing left to stage\n`
            : `[review-fix] round ${round}/${maxRounds}: no changes produced — findings left unresolved\n`,
      );
      await endSession(db, clock, sessionId, "done");
      return { sessionId, committed: committed || selfCommitted };
    } catch (e) {
      // Gates run before the commit so a failure leaves the fix uncommitted — unless the fixer
      // committed its own work first, which project instructions routinely tell an agent to do. Then
      // the failure would strand an unverified commit on the run's branch, and the runner's retry
      // reuses this worktree: `settleBaseline` discards dirt but adopts a COMMIT as the settled
      // baseline, so the next round reviews that fix clean and opens the PR with the gate it failed
      // never having passed. Rolling back to the pre-fix fingerprint closes that, and makes a
      // self-committing fixer fail exactly like one that left the fix unstaged.
      //
      // PoisonError passes through untouched: it means the fixer committed onto a branch of its own,
      // which is already parked for a human — and those commits must survive for them to move.
      // Throws a PoisonError of its own when a COMMIT could not be reverted.
      if (!verified && !(e instanceof PoisonError)) {
        await discardSessionWrites({
          copy: {
            tag: "review-fix",
            actor: "review fix",
            parkRisk:
              "a retry would read that state as a settled baseline and open a PR carrying a fix whose verify gates never passed",
          },
          worktreePath,
          targetId: target.id,
          before,
          logPath,
          round,
          maxRounds,
          cause: e,
          readState: args.readState,
          restoreState: args.restoreState,
        });
      }
      throw e;
    }
  } catch (e) {
    await endSession(db, clock, sessionId, "failed");
    throw e; // propagate so the runner applies quota backoff / retry / park
  }
}

/**
 * The salvage path for a round that BROKE the protocol: its findings, then the earlier advisories it
 * did not restate.
 *
 * Only used there. Only BLOCKING findings are dispatched to a fix session, so no session is ever
 * asked to resolve an advisory, and a round that reports properly is handed the open advisories in
 * its prompt and settles them by restating or omitting each. A round that never reported — or
 * reported an unusable score — settled nothing, and dropping the earlier advisories would lose
 * findings nobody addressed from the very run a human is being asked to look at.
 */
function withCarried(findings: ReviewFinding[], carried: ReviewFinding[]): ReviewFinding[] {
  const seen = new Set(findings.map(findingKey));
  return [...findings, ...carried.filter((f) => !seen.has(findingKey(f)))];
}

/**
 * Dedupe key for a finding across rounds. Location + note, whitespace- and case-normalized: two
 * reviewers wording the same problem differently still list twice, which is only noise in the PR
 * body — dropping a finding nobody resolved is the failure worth avoiding.
 */
function findingKey(f: ReviewFinding): string {
  return `${f.location}\0${f.note}`.toLowerCase().replace(/\s+/g, " ");
}

/** A fingerprint as a human reads it in a park reason: `abc123def456 (on anton/foo)`. */
function describeRef(state: WorktreeState): string {
  const branch = state.ref?.replace(/^refs\/heads\//, "");
  return `${state.head.slice(0, 12)}${branch ? ` (on ${branch})` : ` (detached)`}`;
}

function describeReviewer(reviewer: ReviewerSource): string {
  return reviewer.kind === "agent" ? `agent ${reviewer.id}` : `the ${reviewer.kind} review contract`;
}

function describeReport(report: ReviewReportResult): string {
  const blocking = blockingFindings(report.findings).length;
  const counts = `${blocking} blocking, ${report.findings.length - blocking} advisory`;
  return report.ok
    ? `score ${report.score}/10 — ${counts} — ${report.rationale}`
    : `protocol violation (${report.violation}) — ${counts} salvaged`;
}
