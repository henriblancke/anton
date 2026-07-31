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
import { commitAll, diffAgainstBase, type BranchDiff } from "../git/ops";
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

  const rounds: ReviewRound[] = [];
  let reviewer: ReviewerSource = { kind: "default" };

  for (let round = 1; round <= config.maxRounds; round++) {
    await ctx.heartbeat();
    const diff = await readDiff(worktreePath, baseBranch);

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
      diff,
      round,
      maxRounds: config.maxRounds,
      claude,
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
  diff: BranchDiff;
  round: number;
  maxRounds: number;
  claude: (options: RunClaudeOptions) => Promise<ClaudeResult>;
}): Promise<{ sessionId: string; reviewer: ReviewerSource; report: ReviewReportResult }> {
  const { db, clock, ctx, projectId, runId, target, tickets, settings, worktreePath, diff, round, maxRounds, claude } =
    args;

  const { prompt, reviewer } = await buildReviewPrompt({
    target,
    tickets,
    diff,
    settings,
    projectDir: worktreePath,
  });

  const { sessionId, logPath, onEvent } = await startJobSession(db, clock, {
    projectId,
    runId,
    kind: "review",
    beadId: target.id,
  });
  ctx.report({ sessionId, cwd: worktreePath });

  try {
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

    const report = parseReviewFindings(result.text);
    await appendSessionLog(logPath, `[review] round ${round}/${maxRounds}: ${describeReport(report)}\n`);
    await endSession(db, clock, sessionId, "done");
    return { sessionId, reviewer, report };
  } catch (e) {
    await endSession(db, clock, sessionId, "failed");
    throw e; // propagate so the runner applies quota backoff / retry / park
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
