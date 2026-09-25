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
 * (anton-omum) parks on unresolved blocking findings — or on a score regression the loop refused to
 * keep grinding at — and proceeds with advisory ones. Keeping the converge loop free of execute-epic
 * wiring is what makes it unit-testable against a fake driver.
 */
import { beads, labelValueOf, type Bead } from "../beads/bd";
import { isServerMode } from "../beads/board-mode";
import { metered, type ReasoningAttribution } from "../claude-invocations";
import { resolveModel } from "./model-routing";
import { claudeRouting, runClaude, type ClaudeResult, type RunClaudeOptions } from "../claude/driver";
import { quotaMeterKey } from "../quota-meter";
import {
  commitAll,
  diffAgainstBase,
  git,
  gitCommonDir,
  readWorktreeState,
  resolveMergeBase,
  restoreWorktreeState,
  sameWorktreeState,
  stageAllAndHashTree,
  type BranchDiff,
  type WorktreeState,
} from "../git/ops";
import { resolveCommitTimeoutMs, resolveReviewConfig, resolveVerifyGates, type ProjectSettings } from "../projects";
import { appendSessionLog, endSession, startJobSession } from "../sessions";
import { PoisonError } from "./errors";
import type { AntonDb, Clock } from "./queue";
import {
  boardEvidence,
  fingerprintBoard,
  hydrateDescriptions,
  persistReviewGateBoardBaseline,
  readReviewGateBoardBaseline,
  releaseReviewGateBoardBaseline,
  type BoardFingerprint,
} from "./execute-epic-board-evidence";
import { mustPersist, mustRead, mustReadBoard, mustReadClosureVersion } from "./execute-epic-persist";
import { detectScoreRegression, type ScoreRegression } from "./review-alarm";
import {
  buildFindingsFixPrompt,
  buildReviewPrompt,
  hasBoardOnlyTicket,
  isBoardOnlyDelivery,
  parseReviewFindings,
  resolveReviewerContract,
  type ReviewFinding,
  type ReviewProtocolViolation,
  type ReviewReportResult,
  type ReviewerSource,
} from "./review-context";
import { resolveReviewSandbox, type ReviewSandboxSettings } from "./review-sandbox";
import type { JobContext } from "./runner";
import { captureVerifyGates, type VerifyGateOutcome } from "./shell";

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
  /**
   * The findings this round reported, verbatim — always set by the gate. Counts alone tell the
   * founder a round went badly; only the findings themselves can be sent back to a ticket as fix
   * instructions (anton-4ocm), and the worktree they were reviewed in is gone by then, so they ride
   * to the board with the score. Optional because a round replayed from an OLDER board (written
   * before this field existed) legitimately carries none.
   */
  findings?: ReviewFinding[];
  /** The recorded fix session, when this round's blocking findings were dispatched for repair. */
  fixSessionId?: string;
  /** Whether the fix session actually changed (and so committed) anything. */
  fixCommitted?: boolean;
  /**
   * Set when this round's `score` was capped down from what the reviewer reported (anton-re02): the
   * diff it reviewed was truncated, so the anchored scale's ships-as-is band (8+) — "all criteria met
   * and verified" — is a claim no partial read can support, whatever the reviewer itself believed.
   * Applied by the gate from `BranchDiff.truncated`, never trusted to a reviewer that self-limits its
   * own number. Absent whenever the round's diff was complete, so `score` there is the reported value
   * untouched.
   */
  scoreCap?: ReviewScoreCap;
  /**
   * Set when this round's diff cleared the operator's churn threshold (anton-z8uv) — on a round the
   * floor forced (nothing blocking, but the minimum round count wasn't met yet) as well as on the
   * final round that satisfied it. Carried through to the board (review-score.ts) so a round the floor
   * extended reads as that, distinct from `fixed`: no fix was ever dispatched for it, so labelling it
   * `fixed` would claim a repair that never happened.
   */
  churnFloorApplied?: { churnLines: number; thresholdLines: number; minRounds: number };
  /**
   * The paths this round's reviewer named as unable to fully review (anton-0b1d), carried through from
   * `review.report.unreviewedPaths` so the board can say WHICH files still have nobody's eyes on them —
   * not just that the diff was truncated and the score capped. Set only on a truncated round whose
   * report passed the coverage check (`unreviewedPaths` is otherwise mandatory there).
   */
  unreviewedPaths?: string[];
}

/** Why and how much a round's score was capped — carried on {@link ReviewRound} and the board history it feeds. */
export interface ReviewScoreCap {
  /** The reviewer's own number, before the cap. */
  reported: number;
  /** One line a founder reads on the board next to the capped score. */
  reason: string;
}

/** The lowest score the anchored scale (skills/review/SKILL.md) reserves for "ships as-is". */
export const REVIEW_SHIPS_AS_IS_SCORE = 8;

/** The highest score a review of a truncated diff may record — one band below ships-as-is. */
export const REVIEW_TRUNCATED_SCORE_CAP = REVIEW_SHIPS_AS_IS_SCORE - 1;

/**
 * Cap a round's score from the DIFF it reviewed, never from the reviewer's own claim to have limited
 * itself (anton-re02): a review of a truncated diff cannot record a score in the ships-as-is band —
 * PRs over the patch budget self-scored 8 and 9 on a partial read and then took a median of 33
 * external findings; #238 scored 8 on a truncated diff and took 73 P1s. An untruncated review's score
 * is returned exactly as reported.
 */
export function capTruncatedScore(score: number, truncated: boolean): { score: number; cap?: ReviewScoreCap } {
  if (!truncated || score < REVIEW_SHIPS_AS_IS_SCORE) return { score };
  return {
    score: REVIEW_TRUNCATED_SCORE_CAP,
    cap: {
      reported: score,
      reason:
        `the diff was truncated, so this round could not read all of it — a ships-as-is score ` +
        `(${REVIEW_SHIPS_AS_IS_SCORE}+) claims coverage a partial read cannot support`,
    },
  };
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
  | "protocol-violation"
  /** K consecutive rounds scored below the operator's threshold (anton-i98r). */
  | "score-regression";

export interface ReviewGateResult {
  outcome: ReviewGateOutcome;
  /**
   * The fork-point commit every round was judged against — pinned once, up front (see the comment
   * at its resolution below), so a caller persisting a resume key off a `clean` verdict reuses this
   * SHA rather than re-resolving the movable branch ref after the gate returns.
   */
  baseRev: string;
  /** Every round that ran, in order — each with its validated score for the call-site to persist. */
  rounds: ReviewRound[];
  /**
   * Findings open at exit, each carrying its severity: the final review's — it is shown every
   * advisory still open from earlier rounds (and from an earlier `step:review`, via
   * {@link ReviewGateArgs.carried}) and restates the ones that still apply — plus, when that review
   * broke the protocol and so settled nothing, the earlier advisories (see {@link withCarried}).
   */
  unresolved: ReviewFinding[];
  /** Which reasoning contract reviewed: a named agent, the operator's prompt, or the shipped default. */
  reviewer: ReviewerSource;
  /** The final round's validated score, when that review spoke the protocol. */
  score?: number;
  /** Set with the `score-regression` outcome: the low scores that tripped the alarm (anton-i98r). */
  regression?: ScoreRegression;
  /**
   * Set on a `clean` exit whose diff cleared the operator's churn threshold (anton-z8uv) — how a
   * founder tells a large-diff run apart from an ordinary clean exit, and how many rounds the floor
   * demanded of it.
   */
  churnFloorApplied?: { churnLines: number; thresholdLines: number; minRounds: number };
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
  commit?: (
    worktreePath: string,
    message: string,
    options: { timeoutMs?: number; signal?: AbortSignal },
  ) => Promise<{ committed: boolean }>;
  /** Fingerprint the worktree around a review — the read-only guard's before/after. */
  readState?: (worktreePath: string) => Promise<WorktreeState>;
  /** Undo whatever a review wrote, back to the fingerprint taken before it ran. */
  restoreState?: (worktreePath: string, state: WorktreeState) => Promise<void>;
  /** The ref store the review session's sandbox pins shut — see `resolveReviewSandbox`. */
  gitCommonDir?: (worktreePath: string) => Promise<string>;
  /** Hash the tree a commit would write — the fix session's proof across its own commit hooks. */
  hashTree?: (worktreePath: string) => Promise<string>;
  /**
   * Read the live board's content fingerprint — a board-only fix session's before/after progress
   * signal (see {@link readBoardFingerprint}). Overridable so a test can fake the board without
   * shelling out to a real `bd`, exactly like every other side effect in this list.
   */
  readBoardFingerprint?: (repoPath: string, ticketId: string) => Promise<BoardFingerprint | undefined>;
  /**
   * Confirm a board-only fix's write actually reached the remote — the gate a board-only round's
   * progress signal is required to clear (PR #284 review round 14). Overridable so a test can fake
   * the sync channel without shelling out to a real `bd`, exactly like {@link readBoardFingerprint}.
   */
  syncBoard?: (repoPath: string) => Promise<boolean>;
  /** Total changed lines from `baseRev` to HEAD — the large-diff round floor's measure (anton-z8uv). */
  churn?: (worktreePath: string, baseRev: string) => Promise<number>;
}

/** The slice of the runner's JobContext the gate needs — narrow, so tests can fake it in two lines. */
export type ReviewGateContext = Pick<
  JobContext,
  "signal" | "heartbeat" | "report" | "claudeReached" | "jobId" | "type"
>;

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
  /** See {@link import("./steps/context").StepContext.boardEvidenceByTicket}. */
  boardEvidenceByTicket?: ReadonlyMap<string, string[]>;
  /**
   * See {@link import("./steps/context").StepContext.repoPath} — the live board's repo path, never
   * the worktree. Handed to the reviewer so a board-only ticket's evidence can be read fresh instead
   * of off this worktree's own frozen, unsynced beads copy (PR #284 review round 12), and to a
   * board-only fix session so its `bd` writes land on the board anton's own evidence check actually
   * reads (round 13) rather than being stranded in the worktree's copy.
   */
  repoPath?: string;
  /**
   * The cooked pipeline's content digest, stamped on the gate's invocations (anton-jpmdw). Absent
   * for a caller driving the gate directly, which records it as the absence it is.
   */
  formulaDigest?: string;
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
  /**
   * Advisories an EARLIER `step:review` in the same run left open, seeded as this gate's round-0
   * carry so its first review is shown them exactly as a second round would be.
   *
   * A formula may name `step:review` more than once (the floor constrains omission and order, never
   * extension), and each step is its own gate: without this seam the second gate would start blind,
   * and the caller's `unresolved` — which REPLACES, on the strength of the reviewer having been
   * shown the open set — would silently drop every advisory the first gate reported. Seeded, the
   * replacement stays honest: this gate's reviewer decides their fate against the diff as it stands.
   */
  carried?: ReviewFinding[];
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
 * `Bash` itself stays here, because the review contract asks the reviewer to run the project's own
 * read-only checks — and a shell writes bytes with none of the tools above, so this list is only
 * half the guard. The other half is not a tool filter at all: the session runs under Claude Code's
 * Bash sandbox with the repository's ref store denied at the OS level (anton-t6tu, see
 * jobs/review-sandbox). {@link reviewDeniedTools} widens this base list to drop `Bash` too on a
 * server-backed board, where that OS-level sandbox cannot reach the board at all — see there for why.
 */
export const REVIEW_DENIED_TOOLS = ["Write", "Edit", "MultiEdit", "NotebookEdit", "Bash(git:*)"];

/**
 * `REVIEW_DENIED_TOOLS`, widened to deny `Bash` OUTRIGHT when the project's board is `dolt_mode:
 * server` (PR #284 review, "Block server-backed board writes during review"; hardened per PR #284
 * review round 18, "Deny Bash instead of only the bd command prefix").
 *
 * The OS-level sandbox (`jobs/review-sandbox`) pins the ref store AND `<repoPath>/.beads` shut, but
 * that only contains a FILESYSTEM-backed board — a server-backed one is mutated over a connection
 * string, invisible to a filesystem deny rule by construction. This used to deny only the `Bash(bd:*)`
 * TOOL, on the theory that `boardEvidenceSection` (review-context.ts) is the only thing that teaches
 * this session the `bd` invocation syntax. That denial is a PREFIX rule on the literal command string
 * Claude Code hands to Bash, not a parse of what the shell actually runs — `cd /tmp && bd -C <repo>
 * update ...`, a wrapper script, an alias, or any other command that doesn't itself start with `bd`
 * sails straight past it, and the session keeps unrestricted Bash under `bypassPermissions` to run it
 * with. No enumeration of prefixes closes that: a shell can invoke the same binary in unboundedly many
 * shapes. Denying `Bash` itself removes the shell entirely, which is the only rule a shell cannot route
 * around. The cost is real — the reviewer can no longer run the project's own checks itself on a
 * server-mode-board project — and is paid deliberately: `readOnlySection` (review-context.ts) tells the
 * reviewer explicitly it has no shell here and to judge from anton's own already-run gate results (or
 * their absence) instead of trying to reach for one.
 */
export function reviewDeniedTools(repoPath: string | undefined): string[] {
  return repoPath && isServerMode(repoPath) ? [...REVIEW_DENIED_TOOLS, "Bash"] : REVIEW_DENIED_TOOLS;
}

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
  // Whether the FIX SESSION this gate may dispatch needs board-fix handling (PR #284 review round
  // 15): decided once, off the same bead pair the reviewer's own {@link diffSection} judges — never
  // re-derived per round, since the tickets' labels don't change mid-gate. Deliberately the "any
  // ticket" predicate ({@link hasBoardOnlyTicket}), not the "every ticket" one
  // ({@link isBoardOnlyDelivery}) `diffSection` uses to decide how to render the diff: a MIXED run
  // (some tickets git-delivered, one `delivery:board`) fails the all-tickets rule, but a fix session
  // repairing a blocking finding against that one board-only ticket still needs the live-board
  // instructions and board-progress handling, or it runs `bd` against the worktree's frozen copy and
  // a correct repair that writes no git diff gets misclassified as stalled.
  const boardOnly = hasBoardOnlyTicket({ target, tickets });
  const driver = args.deps?.runClaude ?? runClaude;
  const readDiff = args.deps?.diff ?? diffAgainstBase;
  const mergeBase = args.deps?.mergeBase ?? resolveMergeBase;
  const commit =
    args.deps?.commit ??
    ((commitWorktreePath: string, message: string, options: { timeoutMs?: number; signal?: AbortSignal }) =>
      commitAll(commitWorktreePath, message, options));
  const readState = args.deps?.readState ?? readWorktreeState;
  const restoreState = args.deps?.restoreState ?? restoreWorktreeState;
  const hashTree = args.deps?.hashTree ?? stageAllAndHashTree;
  const readBoard = args.deps?.readBoardFingerprint ?? defaultReadBoardFingerprint;
  const syncBoard = args.deps?.syncBoard ?? defaultSyncBoard;
  const churn = args.deps?.churn ?? diffChurnLines;

  // Resolved ONCE, before the first session is recorded: the repository's ref store does not move
  // between rounds, and an unsandboxable host must fail the gate outright rather than after a review
  // has already run unconfined.
  const sandbox = await resolveReviewSandbox({
    worktreePath,
    readGitCommonDir: args.deps?.gitCommonDir ?? gitCommonDir,
    // Denies the live board's checkout too (PR #284 review, "protect the live board from
    // review-session writes"): `boardEvidenceSection` hands the reviewer the exact `bd -C
    // <repoPath>` syntax to READ confirmed evidence, and a stray write-capable command against
    // that same path would mutate the canonical board unseen by `enforceReadOnly`, which only
    // watches this worktree.
    repoPath: args.repoPath,
  });

  // Pin the fork point once, for every round: `baseBranch` is a MOVABLE ref (`origin/<base>`), and a
  // sibling run's fetch or a resumed worktree can advance it while this gate runs. Re-resolving it
  // per read would let the patch come from the old fork point while the reviewer's own inputs — its
  // contract, the principles, the instruction files — come from a newer tip, so a base commit that
  // deleted a rule would quietly stop that rule from grading this branch. One SHA, one baseline.
  const baseRev = await mergeBase(worktreePath, baseBranch);

  // The large-diff round floor's measure (anton-ecdl / anton-z8uv), taken once against the pinned
  // fork point: the RUN's own diff, not whatever size the gate's own fix commits grow it to as
  // rounds proceed. Skipped when the operator turned the floor off, so a project that never enables
  // it pays no extra git call — the same "no added cost on small diffs" the floor itself promises.
  const churnLines = config.churnRoundFloor ? await churn(worktreePath, baseRev) : undefined;

  // Resolved once, up front, to stamp the REVIEW meter with who actually reviews (PR #313 review),
  // and handed to every round's `buildReviewPrompt` below instead of letting it re-resolve: `config`
  // and `baseRev` are fixed for the whole gate, but `resolveReviewerContract` still reads LIVE
  // sources for the reasoning text itself (a project-local agent prompt, the operator's saved review
  // prompt, anton's own bundled `review` skill on disk) that can change between rounds — a
  // multi-round gate can run long enough for an edited reviewer or a redeployed skill to land
  // mid-gate. Re-resolving per round would then dispatch different reasoning text than the meter
  // (built once, below) was stamped with, misattributing that round's cost/quality to the wrong
  // producer. One resolution, reused everywhere, keeps the ledger and the actual prompt in lockstep.
  const reviewerContract = await resolveReviewerContract(settings, worktreePath, baseRev);
  const { reviewer: initialReviewer, attribution: reviewAttribution } = reviewerContract;

  // The gate's two kinds of session are metered apart (anton-77l9). They are dispatched from one
  // driver but spend very differently — a review reads a diff, a fix rewrites the tree and re-runs
  // the gates — and a ledger that filed both under one step could not tell which half of a run's
  // review budget went where.
  const meter = (step: string, agentTag: string | undefined, attribution?: ReasoningAttribution) =>
    metered(db, clock, {
      projectId,
      jobType: ctx.type,
      jobId: ctx.jobId,
      step,
      // The gate IS the `review` handler however a project's formula spelled the step that called
      // it, so the handler is the constant here rather than a lookup: the fix dispatch is this same
      // handler's own correction round, which the phase fold reads by `step` (anton-234ja).
      stepHandler: "review",
      runId,
      beadId: target.id,
      modelRequested: settings.model,
      agentTag,
      formulaDigest: args.formulaDigest,
      ...attribution,
    }, driver);
  // The REVIEW session is metered under the specialist that actually reviewed — a configured
  // `reviewAgent` is a different reasoning contract than the target's implementer, and stamping it
  // with the target's tag pools two incompatible cohorts (PR #313 review). No named agent (an
  // operator prompt or the shipped default) records no agent tag, same as a target with none. The
  // reviewer's own attribution rides beside it (`reviewAttribution`) — the REVIEW driver call sets
  // no `appendSystemPrompt`, so `metered`'s own digest never reaches this text (PR #313 review). The
  // FIX session really does run as the target's own agent repairing its own work, so it keeps that
  // tag, and its own reasoning is already covered — `buildFindingsFixPrompt` composes the target's
  // execution system prompt, which `metered` digests unaided.
  const claude = meter(
    "review",
    initialReviewer.kind === "agent" ? initialReviewer.id : undefined,
    reviewAttribution,
  );
  const fixClaude = meter("review-fix", labelValueOf(target.labels, "agent"));

  let reviewer: ReviewerSource = initialReviewer;
  /**
   * Advisories still open from earlier rounds — shown to the next review, which settles them. Seeded
   * from an earlier `step:review`'s open set when the formula runs more than one gate, so round 1
   * here is handed what that gate left rather than starting blind (see {@link ReviewGateArgs.carried}).
   */
  let carried: ReviewFinding[] = args.carried ?? [];
  /**
   * Gate evidence still valid for the tree the next round will read. Undefined on round 1 (the
   * review session runs them), then carried from each fix session, which already runs the gates on
   * exactly the content it commits — so a converging review never runs the suite twice per round.
   */
  let verified: VerifyGateOutcome[] | undefined;
  /**
   * The blocking findings the immediately preceding round reported — undefined on round 1. Handed to
   * the next round's reviewer so it can tell a finding it raised itself apart from one this fix
   * session was actually dispatched to close (see {@link ReviewRun.previousBlocking}).
   */
  let previousBlocking: ReviewFinding[] | undefined;
  /**
   * The run's board-only per-ticket evidence, extended as each fix round confirms a NEW board write
   * (chatgpt-codex-connector, PR #284 review, "carry board-fix IDs into the confirming review"):
   * without this, a blocking finding that requires creating or modifying a bead outside the
   * original evidence set left the next round's reviewer with only the stale ids from before this
   * gate ever ran — no git diff records a board-only repair either, so the reviewer had nothing
   * telling it which live-board state to inspect and could repeat the finding or clear it blind.
   */
  let boardEvidenceByTicket = args.boardEvidenceByTicket;

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
      boardEvidenceByTicket,
      repoPath: args.repoPath,
      settings,
      worktreePath,
      baseRev,
      readDiff,
      carried,
      round,
      maxRounds: config.maxRounds,
      claude,
      reviewerContract,
      sandbox,
      readState,
      restoreState,
      verified,
      previousBlocking,
      ...(args.assertLeaseHeld ? { assertLeaseHeld: args.assertLeaseHeld } : {}),
    });
    reviewer = review.reviewer;

    const findings = review.report.findings;
    const blocking = blockingFindings(findings);
    // Capped here, from the diff THIS round actually read — not from anything the reviewer claimed
    // about its own coverage — so every score `rounds` carries from this point on is already the
    // honest one (anton-re02).
    const scoreCap = review.report.ok ? capTruncatedScore(review.report.score, review.truncated) : undefined;
    const roundScore = scoreCap?.score;
    const entry: ReviewRound = {
      round,
      reviewSessionId: review.sessionId,
      blocking: blocking.length,
      advisory: findings.length - blocking.length,
      findings,
      ...(review.report.ok
        ? {
            score: roundScore,
            rationale: review.report.rationale,
            ...(scoreCap!.cap ? { scoreCap: scoreCap!.cap } : {}),
            ...(review.report.unreviewedPaths?.length
              ? { unreviewedPaths: review.report.unreviewedPaths }
              : {}),
          }
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
    if (!review.report.ok) return { outcome: "protocol-violation", baseRev, rounds, unresolved, reviewer };

    // The score-regression alarm (anton-i98r), read across every round so far. Checked BEFORE the
    // clean and cap exits, and so ahead of both: a run the reviewer has scored low K times running
    // is the founder's call whichever of them it would otherwise have taken. Ahead of `clean`
    // because "nothing blocks, and it is still 3/10" is exactly the verdict that must not reach a
    // merge gate wearing a self-reviewed badge; ahead of the cap because the alarm's reason (a
    // score that isn't moving) is the more useful thing to say about why the run stopped.
    const regression = detectScoreRegression(rounds, config.scoreAlarm);
    if (regression) {
      return { outcome: "score-regression", baseRev, rounds, unresolved, reviewer, score: roundScore, regression };
    }

    if (blocking.length === 0) {
      // Above the operator's threshold, {@link DEFAULT_REVIEW_CHURN_ROUND_FLOOR}'s whole point:
      // PR #238 (+13,507/-273) exited clean on round 1 and then took 73 P1 findings from external
      // review — a single fresh-context look is not enough scrutiny for a diff this size. Never
      // consulted below the threshold, so a small diff's clean round 1 is byte-identical to before
      // this floor existed.
      const churnExceeded =
        config.churnRoundFloor !== undefined &&
        churnLines !== undefined &&
        churnLines >= config.churnRoundFloor.thresholdLines;
      const churnFloorApplied = churnExceeded
        ? {
            churnLines: churnLines!,
            thresholdLines: config.churnRoundFloor!.thresholdLines,
            minRounds: config.churnRoundFloor!.minRounds,
          }
        : undefined;
      // Stamped on the ROUND itself, not just returned on a `clean` exit: a round the floor forces to
      // continue never reaches that return, and without this the board (review-score.ts) has no way
      // to tell it apart from a round that genuinely dispatched a fix (anton-re02 follow-up).
      if (churnFloorApplied) entry.churnFloorApplied = churnFloorApplied;
      // The floor demands more rounds only while both hold: it hasn't cleared its minimum yet, AND
      // another round still fits under the operator's cap — the floor raises the bar, it never
      // pushes the loop past `maxRounds` (anton-z8uv).
      const floorPending =
        churnExceeded && round < config.churnRoundFloor!.minRounds && round < config.maxRounds;
      if (!floorPending) {
        return {
          outcome: "clean",
          baseRev,
          rounds,
          unresolved,
          reviewer,
          score: roundScore,
          ...(churnFloorApplied ? { churnFloorApplied } : {}),
        };
      }
      // No fix to dispatch — nothing was reported blocking — so the next iteration runs a REAL
      // review round (a fresh claude session over the diff as it stands) rather than re-parsing
      // this round's report. Advisories still carry forward exactly as they would ahead of a fix.
      carried = findings.filter((f) => f.severity === "advisory");
      previousBlocking = blocking;
      continue;
    }
    if (round === config.maxRounds) {
      return { outcome: "unresolved", baseRev, rounds, unresolved, reviewer, score: roundScore };
    }

    // Replaces, never accumulates: this round was shown the previous carry and restated whatever
    // still applied, so its advisories are the whole open set going into the next round.
    carried = findings.filter((f) => f.severity === "advisory");
    // This round's blocking findings become the NEXT round's `previousBlocking` — the fix session
    // below is dispatched against exactly this set, so the reviewer that reads its result next is
    // told which class it was asked to close.
    previousBlocking = blocking;
    args.assertLeaseHeld?.(); // don't write a fix under a lease that lapsed while reviewing
    const fix = await runGateFixSession({
      db,
      clock,
      ctx,
      projectId,
      runId,
      target,
      tickets,
      settings,
      worktreePath,
      findings: blocking,
      round,
      maxRounds: config.maxRounds,
      claude: fixClaude,
      commit,
      readState,
      restoreState,
      hashTree,
      boardOnly,
      repoPath: args.repoPath,
      readBoardFingerprint: readBoard,
      syncBoard,
    });
    entry.fixSessionId = fix.sessionId;
    entry.fixCommitted = fix.committed;
    // The fix ran the gates on what it committed, so the next round is handed that evidence rather
    // than re-running the suite to learn the same thing.
    verified = fix.verified;
    // Merge this round's confirmed board write into every board-only ticket's evidence entry
    // (chatgpt-codex-connector, PR #284 review, "carry board-fix IDs into the confirming review") —
    // attributed to every board-only ticket in this run rather than one specific ticket, since a fix
    // session repairs findings against the whole `tickets` set and this diff cannot tell which of
    // them the write was actually for. Unioned with whatever the run already carried, not replaced,
    // so an earlier ticket's confirmed evidence from before this gate ran is never dropped.
    if (fix.boardEvidenceIds?.length) {
      const units = tickets.length > 0 ? tickets : [target];
      const boardOnlyUnits = units.filter((t) => beads.isBoardOnly(t) || beads.isBoardOnly(target));
      const merged = new Map(boardEvidenceByTicket ?? []);
      for (const t of boardOnlyUnits) {
        merged.set(t.id, [...new Set([...(merged.get(t.id) ?? []), ...fix.boardEvidenceIds])].toSorted());
      }
      boardEvidenceByTicket = merged;
      // Durably persisted onto every board-only ticket (PR #284 review, "Persist board-fix evidence
      // IDs across review retries") — `merged` otherwise lives only in this loop's local variable,
      // and a process death after this round's board sync but before a later round (or the PR step)
      // finishes would leave a resumed attempt reconstructing `boardEvidenceByTicket` from scratch
      // off each ticket's `boardEvidenceConfirmed` metadata (see `execute-epic-dispatch.ts`'s ledger
      // build) — which never learned about a bead this FIX round created or first touched, recreating
      // the blind-review problem this merge exists to close. Writing it into the SAME durable field
      // every other board-evidence path already reads on resume, rather than a parallel mechanism,
      // means a resumed run's dispatch ledger picks this up for free the moment it re-reads each
      // ticket. `repo` is always set here in practice — `fix.boardEvidenceIds` is only ever populated
      // when `runGateFixSession` was itself given a `repoPath` (see its own `boardBefore` gate) — but
      // checked rather than asserted so a future caller without one degrades to the in-memory-only
      // behavior this replaces instead of throwing. `merged.get(t.id) ?? []` always passes the FULL
      // known set, never just `fix.boardEvidenceIds` alone: `setBoardEvidenceConfirmed` is not
      // idempotent on its `ids` argument (see that function's own docstring), so a narrower write
      // here would overwrite already-durable evidence with less. NOT best-effort (chatgpt-codex-
      // connector, PR #284 review, "Fail when board-fix evidence cannot be persisted"): every
      // `mustPersist` result is checked and the confirming push must report `synced`/`shared-server`
      // like every other board-evidence write in this codebase — a discarded failure here would
      // leave this round's confirmed IDs living only in the in-memory `merged` map, so a process
      // death before the next round (or the PR step) reads back only the stale
      // `boardEvidenceConfirmed` metadata and can no longer tell the reviewer which beads THIS
      // round's fix touched, defeating the crash-recovery purpose documented above.
      const repo = args.repoPath;
      if (repo) {
        // Preserve the closure fence this extends (chatgpt-codex-connector, PR #284 review,
        // "Preserve the closure fence when extending evidence") — a ticket already carrying a
        // stored closure keeps it; a closed ticket with none yet (this round's own fix just
        // closed it) gets the current episode, same as `clearBoardEvidencePending` computes it.
        // Writing `{ ids }` with no closure would erase the fence `confirmedForThisCycle`
        // (execute-epic-dispatch.ts) relies on, letting a later reopen-and-reclose before this
        // run redispatches the ticket pass as "same cycle" with no new evidence.
        //
        // Derived off a FRESH read, never `t` itself (chatgpt-codex-connector review, "Re-read
        // tickets before preserving closure fences") — `t` is `tickets`/`target` as passed into
        // this whole gate, a snapshot from before ANY round's fix ran. When THIS round's fix just
        // closed the ticket, `t.status` still reads open/in_progress and carries no confirmed
        // closure, so deriving off `t` would resolve `closure` to `undefined` and overwrite an
        // existing `{ ids, closure }` confirmation with an unfenced `{ ids }`. An unreadable live
        // ticket (after retries) fails this write rather than guess off the stale snapshot.
        //
        // The closure READ itself goes through `mustReadClosureVersion`, retried like every other
        // guarded read here — NOT a bare `readCurrentClosureVersion(...).catch(() => undefined)`
        // (chatgpt-codex-connector, PR #284 review, "Fail closed when the review-fix closure read
        // fails"): a closed ticket with no stored closure yet (this round's own fix just closed it)
        // that hits a transient `bd history` failure would otherwise persist an unfenced `{ ids }`
        // confirmation, and `confirmedForThisCycle` (execute-epic-dispatch.ts) treats an absent
        // closure as "cannot verify, pass anyway" — the same tolerance meant for a confirmation
        // written before the fence existed — so a later reopen-and-reclose could reuse these ids as
        // this new cycle's evidence with no new board delta ever checked. An unavailable read (after
        // retries) fails this ticket's persist the same as an unreadable bead does, rather than
        // silently produce the exact fenceless shape the closure fence exists to prevent.
        const persisted = await Promise.all(
          boardOnlyUnits.map(async (t) => {
            const live = await mustRead(repo, t.id);
            if (!live) return false;
            const storedClosure = beads.confirmedBoardEvidenceClosure(live);
            let closure = storedClosure;
            if (storedClosure === undefined && live.status === "closed") {
              const read = await mustReadClosureVersion(repo, t.id);
              // `read.read` alone is not enough (chatgpt-codex-connector, PR #284 review, "Reject
              // empty closure histories before confirming fixes"): `bd history` can answer
              // successfully with no closed version at all — an imported/legacy closed bead with
              // empty history — leaving `read.closure` `undefined` even though the read itself
              // succeeded. Persisting that as `{ ids }` with no closure would land exactly the
              // unfenced confirmation this whole block exists to prevent: `confirmedForThisCycle`
              // (execute-epic-dispatch.ts) treats a missing closure as "cannot verify, pass
              // anyway", so a later reopen-and-reclose could reuse this round's ids as the new
              // cycle's evidence with no further board delta ever checked. Mirrors the same guard
              // in `clearBoardEvidencePending` (execute-epic-board-evidence.ts) and
              // `stampConfirmedClosures` (review-fix-finalize.ts).
              if (!read.read || read.closure === undefined) return false;
              closure = read.closure;
            }
            // Still open (no closure yet): this write extends whatever unfenced confirmation `live`
            // already carries, so its stored `origin` — the prior closure `stampConfirmedClosures`
            // (review-fix-finalize.ts) will later compare against — must ride along too (chatgpt-
            // codex-connector, PR #284 review, "Preserve the confirmation origin when extending
            // evidence"). Dropping it here would replace `{ ids, origin }` with a bare `{ ids }`,
            // erasing the identity that fence relies on and leaving a second-lifecycle standalone
            // target's confirmation permanently unfenceable once it does close.
            const origin = closure === undefined ? beads.confirmedBoardEvidenceOrigin(live) : undefined;
            const wrote = await mustPersist(() =>
              beads.setBoardEvidenceConfirmed(repo, t.id, merged.get(t.id) ?? [], closure, origin),
            );
            if (!wrote) return false;
            // A concurrent writer can close a still-open standalone unit between the `live` read
            // above and this write (chatgpt-codex-connector, PR #284 review, "Fence review-fix
            // confirmation after the write") — mirrors the same post-write recheck
            // `clearBoardEvidencePending` (execute-epic-board-evidence.ts) already runs after ITS
            // confirming write. Left as `{ ids }` with no closure, `confirmedForThisCycle`
            // (execute-epic-dispatch.ts) treats a missing closure as "cannot verify, pass anyway" —
            // the same tolerance meant for a confirmation written before this fence existed — so a
            // later reopen-and-reclose of this exact ticket could pass this stale confirmation off
            // as the new cycle's own evidence with no fresh board delta ever checked. Its OWN result
            // is checked (chatgpt-codex-connector, PR #284 review, "Require the post-write review
            // fence to persist") — an exhausted retry here used to be discarded, so this block
            // returned `true` believing it had fenced the confirmation when it had not, letting the
            // caller push and report the round as durably confirmed with `{ ids, origin }` still
            // unfenced. Mirrors `closureFenceFailed` in `clearBoardEvidencePending`.
            if (closure === undefined) {
              const recheck = await mustRead(repo, t.id);
              if (!recheck) {
                // The reread itself is exhausted (after retries) — trusting a missing read as "still
                // open" would fall through and `return true`, pushing an unfenced `{ ids }`
                // confirmation a later reopen-and-reclose could reuse (chatgpt-codex-connector, PR
                // #284 review, "Reject review confirmation when its status reread fails"). Same
                // failure shape as the unreadable-closure-history branch just below.
                return false;
              }
              if (recheck.status === "closed") {
                const read = await mustReadClosureVersion(repo, t.id);
                // `read.priorClosure` must still match `origin` (chatgpt-codex-connector, PR #284
                // review, "Validate the origin before fencing review-fix evidence") — mirrors the
                // same guard `clearBoardEvidencePending` (execute-epic-board-evidence.ts) already
                // applies to this identical shape. Without it, a ticket that closes, reopens, and
                // closes AGAIN in the gap between the unfenced write above and this recheck would
                // have `read.closure` name the second close while `read.priorClosure` names the
                // first — neither of which `merged.get(t.id)`'s ids were ever checked against — and
                // this write would still stamp `read.closure` onto them, letting a later resume
                // accept those stale ids as the latest cycle's evidence.
                if (read.read && read.closure !== undefined && read.priorClosure === origin) {
                  const fenced = await mustPersist(() =>
                    beads.setBoardEvidenceConfirmed(repo, t.id, merged.get(t.id) ?? [], read.closure),
                  );
                  if (!fenced) return false;
                } else {
                  // Closed on recheck but its closure version is unreadable (after retries), its
                  // history is empty, or an extra reopen-and-reclose landed between the unfenced
                  // write and this recheck (the `origin` mismatch above) — the same ambiguity the
                  // earlier `mustReadClosureVersion` call above already fails closed on. Falling
                  // through here would `return true` and push an unfenced `{ ids }` confirmation a
                  // later reopen-and-reclose could reuse.
                  return false;
                }
              }
            }
            return true;
          }),
        );
        const synced = await beads
          .push(repo)
          .then((outcome) => outcome === "synced" || outcome === "shared-server")
          .catch(() => false);
        if (persisted.some((ok) => !ok) || !synced) {
          const allPersisted = persisted.every(Boolean);
          throw new PoisonError(
            `${target.id}'s board-fix evidence from review round ${round} could not be durably ` +
              `confirmed: ${
                allPersisted
                  ? "every ticket's write landed locally, but the confirming push could not verify " +
                    "it reached the remote"
                  : "bd refused a read or write for at least one board-only ticket (after retries)"
              } — the run stopped rather than let a resumed attempt rebuild this round's evidence ` +
              `from stale metadata with no record of which beads this fix changed. Check the beads ` +
              `DB${allPersisted ? " and the sync channel" : ""}, then resume the run.`,
          );
        }
      }
    }

    // Nothing changed: the next review would read the identical diff and report the identical
    // findings. Stop and let the call-site decide, rather than burning the remaining rounds.
    if (!fix.committed) {
      return { outcome: "stalled", baseRev, rounds, unresolved, reviewer, score: roundScore };
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
 * tree byte-identical. A shell reaches that ref store without `git`, so the session also runs
 * SANDBOXED, with the common dir denied at the OS level (see `resolveReviewSandbox`). And the
 * session is loaded from the operator's settings only ({@link REVIEW_SETTING_SOURCES}), so the
 * branch under review cannot configure — or hook — the session judging it.
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
  /** See {@link ReviewGateArgs.boardEvidenceByTicket}. */
  boardEvidenceByTicket?: ReadonlyMap<string, string[]>;
  /** See {@link ReviewGateArgs.repoPath}. */
  repoPath?: string;
  settings: ProjectSettings;
  worktreePath: string;
  /** The pinned fork-point commit: the patch AND the reviewer's trusted inputs both come from it. */
  baseRev: string;
  readDiff: (worktreePath: string, base: string) => Promise<BranchDiff>;
  /** Advisories still open from earlier rounds — this review restates or settles each. */
  carried: ReviewFinding[];
  /** The BLOCKING findings the immediately preceding round reported. See {@link ReviewRun.previousBlocking}. */
  previousBlocking?: ReviewFinding[];
  round: number;
  maxRounds: number;
  claude: (options: RunClaudeOptions) => Promise<ClaudeResult>;
  /**
   * The reviewer contract `runReviewGate` resolved once and stamped its meter with — threaded
   * through to `buildReviewPrompt` so every round dispatches exactly the reasoning text the ledger
   * recorded, even if the underlying agent prompt or bundled skill changes on disk mid-gate.
   */
  reviewerContract: { reasoning: string; reviewer: ReviewerSource; attribution: ReasoningAttribution };
  /** OS-level filesystem containment for this session — resolved once per gate (anton-t6tu). */
  sandbox: ReviewSandboxSettings;
  readState: (worktreePath: string) => Promise<WorktreeState>;
  restoreState: (worktreePath: string, state: WorktreeState) => Promise<void>;
  /** Re-assert the run lease after the gates, before the reviewer session is spent. */
  assertLeaseHeld?: () => void;
  /**
   * Gate evidence already fresh for this tree — the previous round's fix session ran them after its
   * repair. Absent on round 1, and after any round whose evidence a commit has since invalidated:
   * this session then runs them itself.
   */
  verified?: VerifyGateOutcome[];
}): Promise<{ sessionId: string; reviewer: ReviewerSource; report: ReviewReportResult; truncated: boolean }> {
  const { db, clock, ctx, projectId, runId, target, tickets, settings, worktreePath, round, maxRounds, claude } = args;

  const { sessionId, logPath, onEvent } = await startJobSession(db, clock, {
    projectId,
    runId,
    kind: "review",
    beadId: target.id,
  });
  // Pin the report to this run's routing (anton-7poz) so an investigate terminal hits the endpoint
  // under review even on an all-tickets-skipped resume, where openTicketSession never seeded it.
  ctx.report({ sessionId, cwd: worktreePath, routing: claudeRouting(settings) });

  try {
    const settled = await settleBaseline({
      worktreePath,
      logPath,
      round,
      maxRounds,
      readState: args.readState,
      restoreState: args.restoreState,
    });

    // The project's gates, run HERE rather than by the reviewer (anton-3jwh's fallout): under the
    // host-wide verify lock, on the settled tree, with their output handed to the reviewer as
    // evidence. A reviewer left to run the suite itself takes no lock, so it competes with every
    // run anton is serializing — and the loser backgrounds the suite and ends its turn waiting for
    // a notification a headless session cannot receive, which parks a finished run.
    // `stopOnFail: false` because these outcomes are EVIDENCE, not enforcement (PR #254 review):
    // the section below tells the reviewer the project's checks were run for it, and stopping at a
    // red `tests` would make that a lie about the lint, typecheck and build that never ran — with
    // the reviewer explicitly permitted to judge a red gate pre-existing and pass.
    const captured =
      args.verified ??
      (await captureVerifyGates(resolveVerifyGates(settings), worktreePath, ctx.signal, logPath, {
        stopOnFail: false,
      }));

    // A gate that wrote something GIT CAN SEE is DISCARDED, not adopted (PR #254 review).
    //
    // Adopting it as the baseline was wrong twice over. `readDiff` describes committed HEAD and
    // `openPullRequest` pushes HEAD, so gate-written content is content the reviewer can read off
    // disk and grade while the PR will never carry it — a clean verdict covering work that does not
    // ship. And the residue it was meant to excuse is not even visible: `readWorktreeState` reads
    // `git status --porcelain`, which excludes ignored files, so the build caches and coverage a
    // suite writes never reach the fingerprint at all. What survives the filter is a tracked-file
    // edit or a non-ignored artifact — precisely the content that must not stand.
    //
    // Discarding is also cheap: `restoreWorktreeState` cleans with `-fd` and no `-x`, so the ignored
    // caches the next gate run wants are left exactly where they are.
    //
    // Gated on the gates having actually RUN here: handed-down evidence (round 2+) means nothing
    // executed in this session, and a project that pins none has nothing to discard or wait for.
    const ranGates = !args.verified && captured.length > 0;
    let verified = captured;
    // Set when the gates dirtied the tree: the writes are reverted AND their outcomes go with them.
    let gatesDiscarded = false;
    if (ranGates) {
      const afterGates = await args.readState(worktreePath);
      if (!sameWorktreeState(afterGates, settled)) {
        // The OUTCOMES are void too, not just the writes (PR #254 review). `captureVerifyGates` runs
        // the whole sequence before this check, so a gate that produced an artifact a LATER gate
        // consumed makes that later `passed` describe the dirty tree — the build succeeded because
        // the generated file was there, and it is about to not be. Reporting it would be the same
        // false claim as adopting the writes, one step further in.
        //
        // Discarded rather than re-run on the restored tree: a gate that dirties does so
        // deterministically — a generator generates again — so the retry buys a second full suite
        // and the same verdict. Throwing the evidence away degrades to the honest answer, which the
        // prompt then states outright: anton ran the gates, the results did not describe this tree,
        // so run what you need yourself.
        gatesDiscarded = true;
        verified = [];
        await args.restoreState(worktreePath, settled);
        await appendSessionLog(
          logPath,
          `[review] round ${round}/${maxRounds}: the verify gates left changes git can see — ` +
            `reverted, and their results discarded with them, because a gate that writes can also ` +
            `have fed a later gate:\n${afterGates.status}\n`,
        );
      }
    }
    const before = settled;

    // The gates can run for many minutes — the suite itself, plus any wait on the host verify lock —
    // so the round's own lease check is stale by now (PR #254 review). Re-assert before spending a
    // reviewer session: another machine may already hold this run, and a verdict persisted under a
    // lapsed lease speaks for work this process no longer owns.
    if (ranGates) args.assertLeaseHeld?.();

    try {
      const diff = await args.readDiff(worktreePath, args.baseRev);
      const { prompt, reviewer } = await buildReviewPrompt({
        target,
        tickets,
        diff,
        boardEvidenceByTicket: args.boardEvidenceByTicket,
        repoPath: args.repoPath,
        settings,
        projectDir: worktreePath,
        // Literally the same commit the diff is taken from — a pinned SHA, not the movable base ref
        // it was resolved from: everything the reviewer is handed comes from one revision this run's
        // own diff could not have written, and that no commit landing on the base mid-review moves.
        baseRev: args.baseRev,
        carriedAdvisories: args.carried,
        previousBlocking: args.previousBlocking,
        verified,
        gatesDiscarded,
        reviewerContract: args.reviewerContract,
      });
      await appendSessionLog(
        logPath,
        `[review] round ${round}/${maxRounds}: reviewing ${diff.files.length} changed file(s) against ` +
          `${args.baseRev.slice(0, 12)} as ${describeReviewer(reviewer)}\n`,
      );

      const reviewRouting = claudeRouting(settings);
      await ctx.claudeReached(quotaMeterKey(settings));
      const result = await claude({
        cwd: worktreePath,
        prompt,
        model: resolveModel(settings, {
          jobType: "execute-epic",
          step: "review",
          labels: [target, ...tickets].flatMap((bead) => bead.labels ?? []),
        }),
        routing: reviewRouting,
        permissionMode: settings.permissionMode ?? "bypassPermissions",
        disallowedTools: reviewDeniedTools(args.repoPath),
        settingSources: [...REVIEW_SETTING_SOURCES],
        // Outranks the `user` sources above, so the machine's own config cannot relax the sandbox
        // this session is contained by.
        settingsJson: JSON.stringify(args.sandbox),
        signal: ctx.signal,
        onEvent,
      });
      if (!result.ok) {
        throw new Error(`claude reported an error reviewing ${target.id}: ${result.text ?? "unknown"}`);
      }

      const report = await enforceReadOnly({
        report: parseReviewFindings(result.text, { truncated: diff.truncated }),
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
      return { sessionId, reviewer, report, truncated: diff.truncated };
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
 * Total changed lines (insertions + deletions) from `baseRev` to HEAD — the large-diff round
 * floor's measure (anton-z8uv).
 *
 * A `git diff --shortstat`, not the review patch {@link runReviewSession} reads: that patch is cut
 * at {@link DEFAULT_DIFF_PATCH_CHARS}, and the runs the floor exists to catch — PR #238's
 * +13,507/-273 — are exactly the ones that cut hides most of. `--shortstat` costs one cheap git call
 * and reports the true total regardless of patch size.
 */
async function diffChurnLines(worktreePath: string, baseRev: string): Promise<number> {
  const stdout = await git(worktreePath, ["diff", "--shortstat", baseRev, "HEAD"]);
  const insertions = Number(/(\d+) insertion/.exec(stdout)?.[1] ?? 0);
  const deletions = Number(/(\d+) deletion/.exec(stdout)?.[1] ?? 0);
  return insertions + deletions;
}

/**
 * The tree a commit would write from this worktree, or `undefined` when git could not say.
 *
 * The hash decides ONLY whether the fix session's gate outcomes still describe the committed tree,
 * so failing to take it must never fail a session that has already verified and committed its work.
 * An unreadable hash degrades to "unproven", and the next review round runs the gates itself.
 */
async function hashTreeOrUnknown(
  hashTree: (worktreePath: string) => Promise<string>,
  worktreePath: string,
): Promise<string | undefined> {
  try {
    return await hashTree(worktreePath);
  } catch {
    return undefined;
  }
}

/** A tree hash for the log line, naming the unreadable case rather than printing `undefined`. */
function describeTree(tree: string | undefined): string {
  return tree ? tree.slice(0, 12) : "unreadable";
}

/**
 * The board's content fingerprint, read fresh off `repoPath` — the anti-stall signal a board-only
 * fix session's round needs (PR #284 review round 13), NOT the authoritative delivery evidence
 * ({@link import("./execute-epic-board-evidence").readBoardEvidence}, which this deliberately
 * doesn't call: that check owns a baseline/pending/sync-confirmation protocol scoped to a ticket's
 * one-time settlement, and reusing it here — inside a converging review loop that can run several
 * times per ticket — would race its own retry/persist bookkeeping for a question this loop only
 * needs a best-effort answer to). `ticketId` excludes THAT bead's own assignee from the fingerprint,
 * the same exclusion {@link fingerprintBoard} applies for the ticket currently being dispatched, so
 * anton's own claim/heartbeat rewrites never read as this round's fix. Returns `undefined` on a read
 * failure (after `mustReadBoard`'s own retries) — folded by the caller into "no board signal this
 * round", same as it would answer before this existed.
 *
 * Descriptions are hydrated the same way {@link import("./execute-epic-board-evidence").readBoardEvidence}
 * does before fingerprinting (PR #284 review): on a `bd` variant whose `bd list --json` omits
 * `description`, every bead would otherwise fingerprint that field as `""` on both the before and
 * after read, so a fixer whose sole repair is a description edit would fingerprint as unchanged and
 * this loop would read a genuine repair as a stalled round. A hydration failure folds to `undefined`
 * exactly like an unreadable board — this signal is best-effort, never a reason to fabricate a diff.
 */
export async function defaultReadBoardFingerprint(repoPath: string, ticketId: string): Promise<BoardFingerprint | undefined> {
  const board = await mustReadBoard(repoPath);
  const hydrated = board && (await hydrateDescriptions(repoPath, board));
  return hydrated && fingerprintBoard(hydrated, ticketId);
}

/**
 * Confirm a board write actually reached the remote (PR #284 review round 14) — the same
 * persisted-and-synced check {@link import("./execute-epic-board-evidence").readBoardEvidence} uses
 * before trusting a board-only delivery. `false` on anything short of a confirmed push, including a
 * push that fails outright: an unconfirmed write is not this round's progress, whatever the reason.
 */
export async function defaultSyncBoard(repoPath: string): Promise<boolean> {
  return beads
    .push(repoPath)
    .then((outcome) => outcome === "synced" || outcome === "shared-server")
    .catch(() => false);
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
  tickets: Bead[];
  settings: ProjectSettings;
  worktreePath: string;
  findings: ReviewFinding[];
  round: number;
  maxRounds: number;
  claude: (options: RunClaudeOptions) => Promise<ClaudeResult>;
  commit: (
    worktreePath: string,
    message: string,
    options: { timeoutMs?: number; signal?: AbortSignal },
  ) => Promise<{ committed: boolean }>;
  readState: (worktreePath: string) => Promise<WorktreeState>;
  restoreState: (worktreePath: string, state: WorktreeState) => Promise<void>;
  /** Hash the tree a commit would write — how the gate proves the committed tree is the tested one. */
  hashTree: (worktreePath: string) => Promise<string>;
  /** See {@link ReviewGateArgs.repoPath} — computed once by {@link runReviewGate} for the whole run. */
  boardOnly?: boolean;
  /** See {@link ReviewGateArgs.repoPath}. Only read when {@link boardOnly} is set. */
  repoPath?: string;
  /** See {@link ReviewGateDeps.readBoardFingerprint}. Only called when {@link boardOnly} and {@link repoPath} are both set. */
  readBoardFingerprint: (repoPath: string, ticketId: string) => Promise<BoardFingerprint | undefined>;
  /** See {@link ReviewGateDeps.syncBoard}. Only called when the board actually changed this round. */
  syncBoard: (repoPath: string) => Promise<boolean>;
}): Promise<{
  sessionId: string;
  committed: boolean;
  verified?: VerifyGateOutcome[];
  /** The bead ids this round's confirmed board write touched (chatgpt-codex-connector, PR #284
   * review, "carry board-fix IDs into the confirming review") — empty/absent when the board did not
   * change this round. See {@link runReviewGate}'s merge into the next round's `boardEvidenceByTicket`. */
  boardEvidenceIds?: string[];
}> {
  const { db, clock, ctx, projectId, runId, target, tickets, settings, worktreePath, findings, round, maxRounds, claude, commit } =
    args;
  const { boardOnly, repoPath } = args;
  // `boardOnly` above is `hasBoardOnlyTicket`'s "any ticket" read — right for deciding whether this
  // fix session needs the live-board plumbing at all, wrong for deciding how strongly to word the
  // carve-out: a MIXED run (some tickets git-delivered, one `delivery:board`) still has findings
  // against the ordinary ticket(s) that need a real code change, so the system prompt must not tell
  // the whole session "editing the tree is neither required nor expected" the way a run where EVERY
  // ticket is board-only ({@link isBoardOnlyDelivery}) safely can (chatgpt-codex-connector, PR #284
  // review, "Avoid the board-only system contract for mixed runs").
  const mixedBoardOnly = boardOnly && !isBoardOnlyDelivery({ target, tickets });

  const { prompt, appendSystemPrompt } = await buildFindingsFixPrompt({
    target,
    findings,
    settings,
    projectDir: worktreePath,
    round,
    maxRounds,
    boardOnly,
    mixedBoardOnly,
    repoPath,
  });

  const { sessionId, logPath, onEvent } = await startJobSession(db, clock, {
    projectId,
    runId,
    kind: "review-fix",
    beadId: target.id,
  });
  ctx.report({ sessionId, cwd: worktreePath, routing: claudeRouting(settings) });

  try {
    await appendSessionLog(
      logPath,
      `[review-fix] round ${round}/${maxRounds}: fixing ${findings.length} blocking finding(s)\n`,
    );
    const before = await args.readState(worktreePath);
    // The board's OWN "before", read alongside the tree's (PR #284 review round 13) — only for a
    // board-only run, whose fixer's actual deliverable is a bd write this worktree's git state can
    // never show. A prior, interrupted round's own persisted snapshot (see below) is preferred over
    // a fresh read (chatgpt-codex-connector, PR #284 review, "Persist the self-review board baseline
    // before dispatch") — a fresh read after a crash mid-round would already contain whatever the
    // fixer wrote before this process died, permanently hiding that delta from every later diff.
    const boardBefore = boardOnly && repoPath
      ? (readReviewGateBoardBaseline(target) ?? (await args.readBoardFingerprint(repoPath, target.id)))
      : undefined;
    // A board-only round is refused BEFORE dispatch when that baseline could not be read (PR #284
    // review round 15), the same fail-closed rule `execute-epic-ticket.ts` already applies before a
    // ticket's own first dispatch. Letting the fixer run anyway risks it making the very bd writes
    // this round exists to repair with no baseline to diff against: `boardAfter` below is only read
    // when `boardBefore` is set, so an unreadable baseline would make `boardChanged` read false no
    // matter what the fixer wrote, misclassifying a genuine board-only repair as stalled — and a
    // resumed attempt's fresh baseline would then silently absorb that write, so the round's own
    // progress could never be proven either way.
    if (boardOnly && repoPath && !boardBefore) {
      throw new PoisonError(
        `the review fix for ${target.id} could not read a board-only baseline before round ${round} — ` +
          `\`mustReadBoard\` exhausted its retries. Refusing to dispatch: without that baseline this ` +
          `round's board writes (if any) could never be told apart from no progress, so a real repair ` +
          `would misclassify as stalled while a resumed attempt takes a fresh baseline that already ` +
          `absorbed it. Resolve the board read, then resume.`,
      );
    }
    // Durably anchored BEFORE the fixer ever runs (chatgpt-codex-connector, PR #284 review, "Persist
    // the self-review board baseline before dispatch") — otherwise this baseline lives only in this
    // process's memory until the post-run read further down, and a process/host death after a live
    // board write but before that read (or the catch-block audit) leaves nothing durable for a
    // resumed attempt to diff against. Run unconditionally, including when `boardBefore` was just
    // reused from a preserved value above: the write is then a no-op, but the confirming push still
    // reconfirms it reached the remote.
    if (
      boardOnly &&
      repoPath &&
      boardBefore &&
      !(await persistReviewGateBoardBaseline(repoPath, target.id, boardBefore))
    ) {
      throw new PoisonError(
        `the review fix for ${target.id} read a board-only baseline before round ${round} but could ` +
          `not persist it before dispatch — refusing to dispatch: without a durable copy, a crash ` +
          `after the fixer's own board write could never be told apart from no progress. Resolve the ` +
          `board write, then resume.`,
      );
    }
    // Flips once the gates have passed AND the work is committed: past that point the round's output
    // is verified, and the rollback below must not touch it however the session ends.
    let verified = false;

    try {
      const fixRouting = claudeRouting(settings);
      await ctx.claudeReached(quotaMeterKey(settings));
      const result = await claude({
        cwd: worktreePath,
        prompt,
        appendSystemPrompt,
        model: resolveModel(settings, {
          jobType: "execute-epic",
          step: "review",
          labels: [target, ...tickets].flatMap((bead) => bead.labels ?? []),
        }),
        routing: fixRouting,
        permissionMode: settings.permissionMode ?? "bypassPermissions",
        signal: ctx.signal,
        onEvent,
      });
      if (!result.ok) {
        throw new Error(
          `claude reported an error fixing review findings for ${target.id}: ${result.text ?? "unknown"}`,
        );
      }

      // The board's "after" (PR #284 review round 13) — read right alongside the tree's, before the
      // gates run: nothing between here and the gate suite can touch the board, so there is no
      // reason to delay it, and doing so keeps this read next to the baseline it is diffed against.
      const boardAfter = boardBefore ? await args.readBoardFingerprint(repoPath!, target.id) : undefined;
      // An unreadable post-fix fingerprint is refused the same way an unreadable pre-fix baseline is
      // (PR #284 review round 16): folding it into "no board change" would let a board-capable
      // fixer's real write pass as a stalled round — skipping `syncBoard` below, and leaving a retry
      // to take a fresh baseline that silently absorbs the unconfirmed mutation before any review
      // sees it.
      //
      // Thrown as a plain `Error`, NOT `PoisonError` (PR #284 review, "restore git state before
      // poisoning on an unreadable board") — a mixed fixer that also touched the git tree has an
      // UNVERIFIED tree at this point (no gates have run, nothing is committed), and `PoisonError`
      // is exactly what the catch below leaves untouched, on the assumption that a poison always
      // means legitimate work parked on a stray branch. This one isn't that: routing it through the
      // ordinary catch instead runs `discardSessionWrites` first, exactly as a red gate would, and
      // its own board-only handling below re-reads the fingerprint and escalates to `PoisonError`
      // itself if that confirms (or still can't rule out) a live board write — see the fail-closed
      // handling there.
      if (boardBefore && !boardAfter) {
        throw new Error(
          `the review fix for ${target.id} could not read the board fingerprint after round ${round} — ` +
            `\`mustReadBoard\` exhausted its retries. Refusing to treat this as no board change: a ` +
            `board-only fixer may have written directly to the live board, and without this read that ` +
            `write can never be told apart from no progress.`,
        );
      }
      // Whether the fixer actually wrote to the board, for a board-only run only: `boardEvidence`
      // is the same pure diff `execute-epic-board-evidence.ts` uses for the run's OWN delivery
      // check, reused here only as an anti-stall SIGNAL for this loop — never as proof for anton's
      // authoritative board-evidence gate, which still runs at ticket settlement regardless of what
      // this round observed.
      const changedBoardIds = boardBefore && boardAfter ? boardEvidence(boardBefore, boardAfter) : [];
      const boardChanged = changedBoardIds.length > 0;
      // A board-only fix's write only reaches another machine — and this run's own best-effort final
      // sync in `concludeRunAttempt`, which logs a push failure rather than surfacing it — once it is
      // actually pushed (PR #284 review). Confirmed here rather than assumed: without this, a change
      // that landed only in this worktree's LOCAL Dolt DB would still count as the round's progress,
      // a subsequent clean review could open the PR on the strength of that unconfirmed write, and
      // another machine (or `concludeRunAttempt`'s own failed sync) could settle the ticket having
      // never actually seen the fix. Only attempted when the board actually changed — nothing to
      // confirm otherwise.
      const boardSynced = boardChanged ? await args.syncBoard(repoPath!) : false;

      // A detected-but-unsynced board change is a poisoned board-writing failure, never a normal
      // no-progress return (PR #284 review round 15) — thrown as a plain error so it runs through the
      // SAME catch below that a red gate or a failed commit does: `discardSessionWrites` still cleans
      // up any incidental git dirt, and the board-still-changed check re-reads the fingerprint and
      // escalates to `PoisonError` from the one place that already knows how to phrase it. Reported as
      // `committed: false` instead, this round would read as merely "stalled" and leave the unconfirmed
      // local mutation standing on the board for a resume — or this run's OWN best-effort final
      // `beads.sync` in `concludeRunAttempt`, which logs a push failure rather than surfacing it — to
      // publish later with no confirming review ever having looked at the repair.
      if (boardChanged && !boardSynced) {
        throw new Error(
          `the review fix for ${target.id} wrote directly to the board but the write could not be ` +
            `confirmed synced against the remote`,
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
            `would read it and pass. Move the commits back onto the run's branch by hand, then resume.` +
            // `boardChanged` (PR #284 review, "Audit board changes even when the fixer switches
            // branches") is already computed above, and reaching here means it is also `boardSynced`
            // — the unsynced case throws before this branch check ever runs. The fixer's commits stay
            // exactly where they are (parked, not reverted), but a board-capable fixer's bd writes
            // already escaped to the shared board regardless of the stray branch, and this poison must
            // say so — the outer catch's `!(e instanceof PoisonError)` skips the board-failure audit
            // below entirely for a `PoisonError` like this one.
            (boardChanged
              ? ` This round also wrote directly to the live board before switching branches — bead(s) ` +
                `${changedBoardIds.join(", ")} changed and are already confirmed synced, so review ` +
                `those writes by hand too before resuming.`
              : ""),
        );
      }

      // Captured, not merely enforced: these gates run on exactly the content committed below, so
      // they are also the evidence the NEXT round's reviewer is handed — which is what spares that
      // reviewer from running the suite again to learn what this session just learned.
      const gates = await captureVerifyGates(resolveVerifyGates(settings), worktreePath, ctx.signal, logPath);
      const red = gates.find((g) => !g.ok);
      if (red) {
        throw new Error(
          `${red.label} gate failed after review round ${round} for ${target.id} (exit ${red.code})`,
        );
      }

      // The gates ran on the tree as it stands; `commitAll` then runs the PROJECT'S HOOKS, and a
      // lint-staged that rewrites files leaves HEAD holding content those gates never saw —
      // git/ops.ts documents exactly this hazard, and this repo's own pre-commit hook does it.
      // Hashing either side of the commit is how the evidence proves it describes the committed
      // tree; when it does not, it is dropped and the next round runs the gates itself.
      const testedTree = await hashTreeOrUnknown(args.hashTree, worktreePath);
      const { committed } = await commit(worktreePath, `${target.id}: address self-review findings (round ${round})`, {
        timeoutMs: resolveCommitTimeoutMs(settings),
        signal: ctx.signal,
      });
      // Set the instant the commit lands, BEFORE the second hash: past here the round's work is
      // verified and committed, and the rollback below must not touch it however this session ends.
      // Hashing after it would otherwise put a good, gate-passing fix behind `discardSessionWrites`.
      verified = true;
      const committedTree = await hashTreeOrUnknown(args.hashTree, worktreePath);
      // Proven only when both hashes were readable AND equal. An unreadable hash is evidence that
      // cannot be trusted, which is the same answer as evidence that is stale.
      const treeProven = testedTree !== undefined && testedTree === committedTree;
      // Nothing staged is only "no progress" if HEAD also stood still — otherwise the fixer committed
      // its own work and the branch already carries the repair the next review will read.
      const selfCommitted = !committed && afterFix.head !== before.head;
      // Built now, before the finalization calls below (chatgpt-codex-connector, PR #284 review,
      // "Persist board-fix IDs before settling the session"): everything this result carries —
      // `committed`, `treeProven`, `changedBoardIds` — is already known, and a confirmed board write
      // must reach the caller regardless of what happens next. `runReviewGate` only merges
      // `boardEvidenceIds` into `boardEvidenceByTicket`, and durably persists it via
      // `setBoardEvidenceConfirmed`, off this function's RETURN value — a thrown error here instead
      // means the caller never sees this round's confirmed ids at all, and a resumed attempt
      // reconstructs its evidence ledger from the stale `boardEvidenceConfirmed` metadata, omitting a
      // bead this round itself repaired (especially costly for a server-backed board, where the
      // reviewer has no shell to independently discover what changed).
      const fixResult = {
        sessionId,
        // `boardChanged` is this round's progress signal for a board-only run (PR #284 review round
        // 13): its fix leaves no git diff by design, so `committed`/`selfCommitted` alone would read
        // a genuine bd repair as `!committed` and the caller's stall check would park a healthy round
        // as stalled — exactly the false negative this thread reported. Reaching here with
        // `boardChanged` true already guarantees `boardSynced` (PR #284 review round 15) — the
        // unconfirmed case is thrown above as a poisoned failure rather than reaching this return, so
        // an unconfirmed local-only write can never masquerade as this round's progress.
        committed: committed || selfCommitted || boardChanged,
        ...(treeProven ? { verified: gates } : {}),
        ...(boardChanged ? { boardEvidenceIds: changedBoardIds } : {}),
      };
      // Session bookkeeping only, past this point: the fix is verified, committed, and (if
      // board-capable) confirmed synced, so a failure writing the session log or marking the session
      // row `done` must not cost the caller `fixResult` above — swallowed here rather than thrown, so
      // this function still returns it instead of losing it to the same board-evidence gap this
      // comment opens with.
      //
      // The log append and `endSession` are in SEPARATE try/catches (PR #284 review, "End the fix
      // session despite final log failures"): a single shared try meant a log write failure (full
      // disk, unwritable session dir) jumped straight past `endSession`, leaving the session row
      // stuck `running` forever — `pickAttachSession` prefers a `running` row, so the run UI would
      // attach to this dead session instead of a later one.
      try {
        await appendSessionLog(
          logPath,
          committed
            ? `[review-fix] round ${round}/${maxRounds}: committed the fix\n`
            : selfCommitted
              ? `[review-fix] round ${round}/${maxRounds}: the fixer committed its own changes — nothing left to stage\n`
              // Reaching here with `boardChanged` true means it is also `boardSynced` — the unsynced
              // case is thrown above as a poisoned board-writing failure before this log line runs.
              : boardChanged
                ? `[review-fix] round ${round}/${maxRounds}: no git changes — the board changed and is ` +
                  `confirmed synced, which is this run's actual deliverable (delivery:board)\n`
                : `[review-fix] round ${round}/${maxRounds}: no changes produced — findings left unresolved\n`,
        );
        if (!treeProven) {
          await appendSessionLog(
            logPath,
            `[review-fix] round ${round}/${maxRounds}: the gates' evidence is not provably the committed ` +
              `tree (${describeTree(testedTree)} → ${describeTree(committedTree)}) — a commit hook that ` +
              `rewrites files does exactly this — so the next review runs them itself rather than ` +
              `trusting evidence for a tree it is not reading\n`,
          );
        }
      } catch (logError) {
        console.error(
          `[review-fix] round ${round}/${maxRounds}: session log append failed for ${target.id} after ` +
            `a verified fix — settling the session anyway: ${String(logError)}`,
        );
      }
      try {
        await endSession(db, clock, sessionId, "done");
      } catch (finalizeError) {
        console.error(
          `[review-fix] round ${round}/${maxRounds}: session finalization failed for ${target.id} after ` +
            `a verified fix — returning the fix's result anyway: ${String(finalizeError)}`,
        );
      }
      // Released only now — after the board write (if any) is confirmed synced and this round's
      // outcome is logged and settled (chatgpt-codex-connector, PR #284 review, "Persist the
      // self-review board baseline before dispatch" / mirrors the PR-fix path's "Retain the PR-fix
      // baseline until the repair is durable"). Releasing any earlier would leave a process/host
      // death in that window with no durable snapshot for a resumed round to diff against.
      if (boardOnly && repoPath && !(await releaseReviewGateBoardBaseline(repoPath, target.id))) {
        throw new Error(
          `the review fix for ${target.id} confirmed its board evidence for round ${round} but could ` +
            `not release its own pre-dispatch baseline — a later round for this ticket could misread ` +
            `it as still describing the current pre-dispatch state`,
        );
      }
      return fixResult;
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
        // A board-only fix writes directly to the LIVE board — there is no worktree copy of it for
        // the revert above to touch (PR #284 review). A failure past that point (a stray branch, a
        // red gate, a failed commit) can therefore leave unverified bd writes standing on the shared
        // board with none of this round's own gates having passed on them. There is no generic
        // un-apply for every write shape `bd` supports (labels, dependency edges, custom metadata,
        // reparenting…) to safely restore from the fingerprint diff alone, so rather than let a
        // later round — or this run's own best-effort final sync in `concludeRunAttempt` — silently
        // treat that state as settled, the run parks here for a human to inspect and repair the
        // board by hand.
        if (boardOnly && repoPath && boardBefore) {
          const boardOnFailure = await args.readBoardFingerprint(repoPath, target.id);
          // An unreadable failure-audit read is poisoned, never read as proof the board is
          // unchanged (PR #284 review, "poison when the failed-fix board audit is unreadable") —
          // the same fail-closed rule the pre-fix baseline and post-fix "after" reads already
          // follow above. Folding an exhausted `mustReadBoard` into `[]` here would let a fixer
          // that mutated the board and THEN failed — e.g. because `syncBoard` itself returned
          // false — escape with its write untold apart from no progress: the original error would
          // propagate as an ordinary retryable failure, and a resumed attempt's fresh baseline
          // would silently absorb the locally-mutated, unreviewed state before any later sync
          // published it.
          if (!boardOnFailure) {
            throw new PoisonError(
              `the review fix for ${target.id} FAILED and the post-failure board audit could not be read ` +
                `— \`mustReadBoard\` exhausted its retries. Refusing to treat this as no board change: the ` +
                `fixer may have written directly to the live board before failing, and without this read ` +
                `that write can never be told apart from no progress. Inspect and repair the board by ` +
                `hand, then resume. The fixer itself failed with: ${String(e)}`,
            );
          }
          const changedOnFailure = boardEvidence(boardBefore, boardOnFailure);
          if (changedOnFailure.length > 0) {
            throw new PoisonError(
              `the review fix for ${target.id} FAILED after writing directly to the board — bead(s) ` +
                `${changedOnFailure.join(", ")} changed and cannot be safely auto-reverted. Parked ` +
                `instead of retried — a retry could read that state as this round's own unverified fix ` +
                `and count it as progress, and this run's own best-effort final sync could publish it ` +
                `before anyone reviews it. Inspect and repair the board by hand, then resume. The ` +
                `fixer itself failed with: ${String(e)}`,
            );
            // Left standing deliberately (never released on this branch): this IS the recovery
            // snapshot a human's eventual resume needs to tell the just-parked write apart from
            // whatever the board looks like by the time anyone gets to it.
          } else if (!(await releaseReviewGateBoardBaseline(repoPath, target.id))) {
            // No board change of its own — an ordinary retryable failure, EXCEPT the baseline this
            // round persisted before dispatch is now stale and could not be cleared. Left standing,
            // a LATER round for this same ticket would wrongly reuse it as its own pre-dispatch
            // state instead of taking a fresh read, so this failure is escalated to a park rather
            // than left to retry silently past it.
            throw new PoisonError(
              `the review fix for ${target.id} FAILED for round ${round} with no board change of its ` +
                `own, but its pre-dispatch board baseline could not be released — a later round for ` +
                `this ticket could misread it as still describing the current pre-dispatch state. ` +
                `Inspect and repair the board by hand, then resume. The fixer itself failed with: ${String(e)}`,
            );
          }
        }
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
