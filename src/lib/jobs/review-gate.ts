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
  restoreWorktreeState,
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
  /** The reviewer's one-line justification of the score, when it gave one. */
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
  /** Findings open at exit (the final review's), each carrying its severity. */
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
  /** Branch the run diverged from — the diff is taken against its merge base. */
  baseBranch: string;
  deps?: ReviewGateDeps;
}

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
 * any other exhausted-quota failure) after marking the in-flight session failed.
 */
export async function runReviewGate(args: ReviewGateArgs): Promise<ReviewGateResult> {
  const { db, clock, ctx, projectId, runId, target, tickets, settings, worktreePath, baseBranch } = args;
  const config = resolveReviewConfig(settings);
  const claude = args.deps?.runClaude ?? runClaude;
  const readDiff = args.deps?.diff ?? diffAgainstBase;
  const commit = args.deps?.commit ?? commitAll;
  const readState = args.deps?.readState ?? readWorktreeState;
  const restoreState = args.deps?.restoreState ?? restoreWorktreeState;

  const rounds: ReviewRound[] = [];
  let reviewer: ReviewerSource = { kind: "default" };

  for (let round = 1; round <= config.maxRounds; round++) {
    await ctx.heartbeat();

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
      baseBranch,
      readDiff,
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
        ? { score: review.report.score, ...(review.report.rationale ? { rationale: review.report.rationale } : {}) }
        : { violation: review.report.violation }),
    };
    rounds.push(entry);

    // A reviewer that never reported, or reported an unusable score, has told us nothing about the
    // work — the run is handed back with whatever findings were salvaged, never as a clean review.
    if (!review.report.ok) return { outcome: "protocol-violation", rounds, unresolved: findings, reviewer };
    if (blocking.length === 0) {
      return { outcome: "clean", rounds, unresolved: findings, reviewer, score: review.report.score };
    }
    if (round === config.maxRounds) {
      return { outcome: "unresolved", rounds, unresolved: findings, reviewer, score: review.report.score };
    }

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
    });
    entry.fixSessionId = fix.sessionId;
    entry.fixCommitted = fix.committed;

    // Nothing changed: the next review would read the identical diff and report the identical
    // findings. Stop and let the call-site decide, rather than burning the remaining rounds.
    if (!fix.committed) {
      return { outcome: "stalled", rounds, unresolved: findings, reviewer, score: review.report.score };
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
 * The revert runs on EVERY exit once the baseline is settled — a review that throws or reports an
 * error is exactly as capable of having written first, and its leftovers would otherwise outlive it
 * (see `discardReviewWrites`).
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
  baseBranch: string;
  readDiff: (worktreePath: string, base: string) => Promise<BranchDiff>;
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
      const diff = await args.readDiff(worktreePath, args.baseBranch);
      const { prompt, reviewer } = await buildReviewPrompt({
        target,
        tickets,
        diff,
        settings,
        projectDir: worktreePath,
      });
      await appendSessionLog(
        logPath,
        `[review] round ${round}/${maxRounds}: reviewing ${diff.files.length} changed file(s) as ` +
          `${describeReviewer(reviewer)}\n`,
      );

      const result = await claude({
        cwd: worktreePath,
        prompt,
        model: settings.model,
        permissionMode: settings.permissionMode ?? "bypassPermissions",
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
      await discardReviewWrites({
        worktreePath,
        before,
        logPath,
        round,
        maxRounds,
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

  await args.restoreState(worktreePath, { head: state.head, status: "" });
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
  if (after.head === before.head && after.status === before.status) return report;

  await args.restoreState(worktreePath, before);
  await appendSessionLog(
    logPath,
    `[review] round ${round}/${maxRounds}: the reviewer MODIFIED the worktree — the changes were ` +
      `reverted to ${before.head.slice(0, 12)} and the review is rejected: a review is read-only\n`,
  );
  return { ok: false, violation: "worktree-modified", findings: report.findings };
}

/**
 * The same revert, for the paths `enforceReadOnly` never reaches: the review threw (abort, quota) or
 * reported an error. A reviewer that wrote before it died is no less of a problem than one that
 * survived — worse, actually, because nothing rejects its round. Its leftovers would outlive the
 * failure and the runner's retry re-enters this worktree, where `settleBaseline` reads a committed
 * write as a settled tree, adopts it as the baseline, and a later clean review hands it to the PR.
 *
 * Best-effort by construction: a restore that itself fails must not replace the error the runner
 * needs to see (UsageLimitError in particular drives backoff), so it is logged and swallowed.
 */
async function discardReviewWrites(args: {
  worktreePath: string;
  before: WorktreeState;
  logPath: string;
  round: number;
  maxRounds: number;
  readState: (worktreePath: string) => Promise<WorktreeState>;
  restoreState: (worktreePath: string, state: WorktreeState) => Promise<void>;
}): Promise<void> {
  const { worktreePath, before, logPath, round, maxRounds } = args;

  try {
    const after = await args.readState(worktreePath);
    if (after.head === before.head && after.status === before.status) return;

    await args.restoreState(worktreePath, before);
    await appendSessionLog(
      logPath,
      `[review] round ${round}/${maxRounds}: the review FAILED after writing to the worktree — its ` +
        `changes were reverted to ${before.head.slice(0, 12)} so the next attempt cannot inherit them\n`,
    );
  } catch (e) {
    await appendSessionLog(
      logPath,
      `[review] round ${round}/${maxRounds}: could not revert the failed review's changes: ${String(e)}\n`,
    ).catch(() => {});
  }
}

/**
 * One fix: a fresh claude session over the round's blocking findings, the operator's verify gates,
 * then a commit onto the run's branch. Advisory findings are deliberately NOT dispatched — they are
 * surfaced to the founder, and letting the fixer roam past the blocking list widens the diff with
 * work no reviewer asked for.
 *
 * Gate order matches execution and review-fix: gates run BEFORE the commit, so a failing gate leaves
 * the attempted fix uncommitted in the worktree and fails the job rather than pushing red code.
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

    await runVerifyGates(
      resolveVerifyGates(settings),
      worktreePath,
      ctx.signal,
      logPath,
      (gate, code) => `${gate.label} gate failed after review round ${round} for ${target.id} (exit ${code})`,
    );

    const { committed } = await commit(worktreePath, `${target.id}: address self-review findings (round ${round})`);
    await appendSessionLog(
      logPath,
      committed
        ? `[review-fix] round ${round}/${maxRounds}: committed the fix\n`
        : `[review-fix] round ${round}/${maxRounds}: no changes produced — findings left unresolved\n`,
    );
    await endSession(db, clock, sessionId, "done");
    return { sessionId, committed };
  } catch (e) {
    await endSession(db, clock, sessionId, "failed");
    throw e; // propagate so the runner applies quota backoff / retry / park
  }
}

function describeReviewer(reviewer: ReviewerSource): string {
  return reviewer.kind === "agent" ? `agent ${reviewer.id}` : `the ${reviewer.kind} review contract`;
}

function describeReport(report: ReviewReportResult): string {
  const blocking = blockingFindings(report.findings).length;
  const counts = `${blocking} blocking, ${report.findings.length - blocking} advisory`;
  return report.ok
    ? `score ${report.score}/10 — ${counts}${report.rationale ? ` — ${report.rationale}` : ""}`
    : `protocol violation (${report.violation}) — ${counts} salvaged`;
}
