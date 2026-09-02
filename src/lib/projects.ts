/**
 * Registry over the `projects` table — machine-local project metadata only.
 * The shareable truth (epics/tickets, approval, stage, PR) lives in beads. See DESIGN.md §3.
 */
import { existsSync } from "node:fs";
import { unlink } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { getDb, schema } from "./db";
import { removeWorktree } from "./git/worktree";
import { FORMULA_NAME_PATTERN, configureBeadsForRepo } from "./beads/config.mjs";
import { DEFAULT_BUDGET_POLICY, type BudgetPolicy } from "./jobs/budget";
import { GARDENER_DETECTION_KINDS } from "./gardener/detections";
import {
  PROPOSAL_AUTONOMY_LEVELS,
  resolveProposalAutonomyPolicy,
  type ProposalAutonomyOverrides,
  type ProposalAutonomyPolicy,
} from "./gardener/autonomy";
import {
  DEFAULT_SCAN_SEVERITY_POLICY,
  resolveScanSeverityPolicy,
  type ScanSeverityOverrides,
  type ScanSeverityPolicy,
} from "./scan-severity";
import {
  POLICY_BOUND_MAX,
  POLICY_CONTROL_NAMESPACES,
  POLICY_CRITERION_VALUES_MAX,
  POLICY_LABEL_CRITERIA_MAX,
  POLICY_PRIORITY_MAX,
  POLICY_TEXT_MAX,
  POLICY_TYPES_MAX,
  PICKER_AUTONOMY_LEVELS,
  type PickerAutonomy,
  type Policy,
} from "./policy/types";
import type { FailureBreakerConfig } from "./autopilot-failure-streak";
import type { ScoreBreakerConfig } from "./autopilot-score-slide";
import type { WipLimitConfig } from "./autopilot-wip";
import type { ScoreAlarm } from "./jobs/review-alarm";
import type { FormulaVariant } from "./jobs/run-formula";
import type { AntonDb } from "./jobs/queue";
import type { Project } from "./types";

const execFileAsync = promisify(execFile);

function toSlug(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

async function uniqueSlug(base: string): Promise<string> {
  const rows = await getDb().select({ slug: schema.projects.slug }).from(schema.projects);
  const taken = new Set(rows.map((r) => r.slug));
  let slug = base || "project";
  let n = 2;
  while (taken.has(slug)) {
    slug = `${base}-${n}`;
    n += 1;
  }
  return slug;
}

async function detectDefaultBranch(repoPath: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["-C", repoPath, "symbolic-ref", "--short", "HEAD"],
      { timeout: 10_000 },
    );
    const branch = stdout.trim();
    return branch || "main";
  } catch {
    return "main";
  }
}

function toProject(row: typeof schema.projects.$inferSelect): Project {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    repoPath: row.repoPath,
    defaultBranch: row.defaultBranch,
    hasBeads: existsSync(join(row.repoPath, ".beads")),
    createdAt: Math.floor(
      row.createdAt instanceof Date ? row.createdAt.getTime() / 1000 : Number(row.createdAt),
    ),
  };
}

export async function listProjects(): Promise<Project[]> {
  const rows = await getDb().select().from(schema.projects);
  return rows.map(toProject);
}

export async function getProjectBySlug(slug: string): Promise<Project | null> {
  const rows = await getDb()
    .select()
    .from(schema.projects)
    .where(eq(schema.projects.slug, slug))
    .limit(1);
  return rows[0] ? toProject(rows[0]) : null;
}

/** db-injectable lookup by id (the runner/handler shares its connection). */
export async function getProjectById(db: AntonDb, id: string): Promise<Project | null> {
  const rows = await db.select().from(schema.projects).where(eq(schema.projects.id, id)).limit(1);
  return rows[0] ? toProject(rows[0]) : null;
}

/** Parsed project settings (settingsJson). All optional; sensible defaults applied by callers. */
export interface ProjectSettings {
  model?: string;
  testCommand?: string;
  /**
   * Optional operator-pinned verify gates (anton-3oh8), run in the worktree after the agent and
   * before commit alongside `testCommand`. Each is a shell command; a non-zero exit fails the
   * ticket exactly like the test gate. Absent → skipped (no behavior change). These are the
   * deterministic hard backstop complementing the agent's own self-verification (sibling ticket).
   */
  lintCommand?: string;
  typecheckCommand?: string;
  buildCommand?: string;
  permissionMode?: "default" | "acceptEdits" | "bypassPermissions" | "plan";
  baseBranch?: string;
  /**
   * Operator-editable seed prompt layered onto the locked base contract for autonomous runs
   * (anton-cjs). Customizes how epics are approached; cannot override the base. Empty = none.
   */
  seedPrompt?: string;
  /**
   * Operator-editable reasoning prompt for the review-fix job (anton-f5n). Overrides the default
   * `skills/review-fix/SKILL.md` when set; anton appends the concrete PR context beneath it. Empty
   * = use the shipped default.
   */
  reviewFixPrompt?: string;
  /**
   * Pre-PR self-review gate (anton-3apm): whether each run is reviewed against its own diff before
   * the PR opens. Absent → ON, so the founder's merge gate is trustworthy without opting in; set
   * false to skip the gate entirely (the run goes straight from the ticket loop to the PR).
   */
  reviewEnabled?: boolean;
  /**
   * Swap the reviewer for a named agent (anton-3apm): any id `discoverAgents` resolves for this
   * project — anton's bundled specialists or the operator's own `.claude/agents`. Absent → the
   * shipped review contract. Validated at the API boundary, so a stale id can only come from an
   * agent deleted after it was saved; the reviewer falls back to the shipped contract in that case.
   */
  reviewAgent?: string;
  /**
   * Operator-editable reasoning prompt for the reviewer, mirroring {@link reviewFixPrompt}: it
   * replaces the shipped review contract, and anton appends the concrete run context beneath it.
   * Empty = shipped default. Ranks BELOW {@link reviewAgent} — a resolvable named agent brings its
   * own contract, so this prompt is what runs when no agent is named or the saved one is gone.
   */
  reviewPrompt?: string;
  /**
   * Cap on review → fix → re-review rounds before the loop stops converging (anton-3apm). Bounds
   * the gate: a reviewer that keeps reporting the same finding hits the cap instead of looping
   * forever. Absent → DEFAULT_REVIEW_MAX_ROUNDS.
   */
  reviewMaxRounds?: number;
  /**
   * Score-regression alarm threshold (anton-i98r): a review round scoring BELOW this counts toward
   * the low-score streak. `0` turns the alarm off outright — no score is below zero — which is the
   * single knob an operator flips to opt out. Absent → DEFAULT_REVIEW_MIN_SCORE.
   */
  reviewMinScore?: number;
  /**
   * How many CONSECUTIVE rounds below {@link reviewMinScore} park the run for the founder
   * (anton-i98r). A round at or above the threshold zeroes the streak. Absent →
   * DEFAULT_REVIEW_LOW_SCORE_ROUNDS.
   */
  reviewLowScoreRounds?: number;
  /**
   * How many runs in a row ending parked, failed, or abandoned disarm the picker for this project
   * (anton-rgso / R4.4). A delivered run resets the count; a run an operator CANCELLED is not
   * counted at all. `0` turns the breaker off outright — the single knob for an operator who would
   * rather anton kept trying. Absent → DEFAULT_AUTOPILOT_FAILURE_STREAK.
   */
  autopilotFailureStreak?: number;
  /**
   * The review-score floor the picker disarms below (anton-cekf / R4.3). A finished run whose target
   * scored BELOW this counts toward the slide; {@link autopilotScoreWindow} consecutive such runs
   * disarm the project. `0` turns the breaker off outright — no score is below zero. Absent →
   * DEFAULT_AUTOPILOT_SCORE_FLOOR.
   *
   * Distinct from {@link reviewMinScore}, which parks ONE run mid-gate on its own rounds. This floor
   * judges the trend across runs that already shipped, so it is set higher: work good enough to
   * leave the gate can still be getting worse.
   */
  autopilotScoreFloor?: number;
  /**
   * How many consecutive scored runs below {@link autopilotScoreFloor} disarm the picker
   * (anton-cekf). A run at or above the floor resets it; a settled run that left NO score voids the
   * window entirely rather than being read through. Absent → DEFAULT_AUTOPILOT_SCORE_WINDOW.
   */
  autopilotScoreWindow?: number;
  /**
   * How many unmerged PRs in review HOLD the picker for this project (anton-wy9y / R4.2). Not a
   * disarm: nothing is wrong, in-flight work is untouched, and the next merge or close releases it
   * with no human act. `0` turns the hold off outright — the single knob for an operator who
   * reviews faster than anton ships. Absent → DEFAULT_AUTOPILOT_WIP_LIMIT.
   */
  autopilotWipLimit?: number;
  /**
   * Max concurrent execute-epic runs for this project (anton-xbk). The runner gates approved-epic
   * execution per project against this; other job types (review-fix/nightly) don't count against
   * it. Absent → DEFAULT_CONCURRENCY.
   */
  concurrency?: number;
  /**
   * How long a job attempt may go WITHOUT PROGRESS before the runner aborts it, in minutes
   * (anton-xbk; re-scoped from a total wall clock in anton-t1mo). Measured from the handler's last
   * `ctx.heartbeat()` — a wedge backstop, NOT the per-task budget. On expiry the run is aborted and
   * retried/parked like any other failure. Absent → DEFAULT_JOB_TIMEOUT_MINUTES (2h).
   *
   * A handler that reports no progress is bounded exactly as before (its last heartbeat is its
   * dispatch). For execute-epic — whose length is a function of how many tickets the feature has —
   * {@link ticketTimeoutMinutes} is the budget that actually bounds the work.
   */
  jobTimeoutMinutes?: number;
  /**
   * Wall-clock budget for ONE ticket, in minutes (anton-t1mo) — the per-task control. A ticket that
   * outlives it is aborted alone: its partial work is rolled back, the bead is blocked with a note
   * for a human, and the run CONTINUES with the next ticket. Absent →
   * DEFAULT_TICKET_TIMEOUT_MINUTES (45).
   *
   * Deliberately not fatal to the run. One ticket that can't converge — an endpoint that never
   * answers, an agent looping on a gate — used to end the whole feature, so the tickets behind it
   * never ran at all. Blocking that one and carrying on delivers the rest and leaves exactly one
   * thing on the board for a human.
   */
  ticketTimeoutMinutes?: number;
  /**
   * Max attempts for a job before it is parked for a human (anton-xbk). A failed ticket fails the
   * execute-epic job, which retries and resumes past already-closed tickets — so this is the
   * effective per-task retry budget. Absent → DEFAULT_MAX_RETRIES.
   */
  maxRetries?: number;
  /**
   * Active-agents allowlist (anton-46w): which of anton's BUNDLED specialist prompts dispatch may
   * assign. Each entry is a bundled agent id (discoverAgents in src/lib/agents-discovery.ts).
   * Enforced by dispatch (anton-dm7, execute-epic): a run whose ticket needs a disabled bundled
   * agent is PARKED with a clear reason — never silently run with the default agent. Absent (never
   * persisted / cleared) → all bundled agents active; empty `[]` → no bundled agent active (the
   * operator toggled every one off), so a ticket needing a bundled agent is parked. The UI seeds
   * "all bundled on" when this is absent, so a no-op save stays all-active.
   *
   * The project's OWN `.claude/agents` (project + global sources) are NOT part of this allowlist:
   * they always run, never parked (the anton-dvo.1 reversal — the operator brought them and labels
   * tickets with them deliberately). A stored value may still contain a stale user-agent id from
   * before the reversal; dispatch ignores it (user agents aren't gated) and the UI prunes it on the
   * next save.
   */
  agents?: string[];
  /**
   * Autonomy master-switch (anton-46w): whether approved epics execute without asking. Absent →
   * true (autonomous). Enforced by the runner's claim gate (anton-y3l): off leaves execute-epic
   * jobs `queued` (approval still enqueues), and turning it back on resumes them.
   */
  autonomy?: boolean;
  /**
   * Conventional-commit PR titles (anton-41d): when true, execute-epic prefixes the epic PR title
   * with a deterministic `<type>(<scope>): ` derived from the target bead (bug→fix, epic/task→feat;
   * scope = the `agent:` label when present). Absent → OFF (opt-in): the title stays the historical
   * `<title> (<id>)`, so existing projects' PR titles are unchanged until enabled.
   */
  conventionalCommits?: boolean;
  /**
   * Budget-aware execution master-switch (anton-7mpv.1). OFF by default: only when a project turns
   * this on does the runner's budget governor pace/defer that project's autonomous work against the
   * Claude plan (see `resolveBudgetPolicy` in ./jobs/service and the governor in ./jobs/budget).
   * Kept deliberately separate from `budgetPolicy` (the knobs): the knobs may be pre-set while the
   * feature stays off. Default off is also what keeps the runner from reading Claude usage at all —
   * so the nav usage pill isn't starved of the shared cache — until an operator opts in.
   */
  budgetAware?: boolean;
  /**
   * Operator-tunable budget policy (anton-egrg): the subset of the governor's full
   * {@link BudgetPolicy} the operator controls per project. Absent → DEFAULT_PROJECT_BUDGET_POLICY;
   * a stored value need only carry the fields the operator touched (the rest fall back to default
   * on resolve). Validated with {@link budgetPolicySchema} at the API boundary. Only consulted when
   * {@link budgetAware} is on.
   */
  budgetPolicy?: ProjectBudgetPolicy;
  /**
   * Per-label pipeline variants (anton-aa3m): bead label → the run formula a target carrying it
   * walks, in PRECEDENCE ORDER (first match wins — see `selectRunFormula`). Lets risk and size drive
   * process, so `risk:high` can carry a design step or a sign-off gate while a docs-only ticket
   * skips verify, instead of one pipeline being conservative enough for the worst case. Absent/empty
   * ⇒ every run walks the project's `anton-run.formula.toml` (else anton's bundled default), so this
   * is invisible to a zero-config project. Validated with {@link formulaVariantsSchema} at the API
   * boundary; every selected variant is held to the same invariant floor as the default.
   */
  formulaVariants?: FormulaVariant[];
  /**
   * How long a run may sit stuck before the run-health sweep (anton-4ks0) calls it a finding.
   * Absent → {@link DEFAULT_RUN_HEALTH_THRESHOLDS}; a stored value need only carry the knobs the
   * operator touched. Only consulted by the `run-health` schedule, which is off by default.
   */
  runHealth?: RunHealthThresholds;
  /**
   * How /scan-triage must label a bead it files from a stringer signal of a given severity
   * (anton-bz1w): the `risk:` label and the bd priority. Absent → {@link
   * DEFAULT_SCAN_SEVERITY_POLICY}; a stored value need only carry the severities the operator
   * re-weighted. Resolved by the nightly-stringer job and injected into the triage prompt, so what
   * a project configures is what the triaging agent actually applies.
   */
  scanSeverity?: ScanSeverityOverrides;
  /**
   * Operator-editable reasoning prompt for the product-master pass (anton-d2sx), mirroring
   * {@link reviewFixPrompt}: it replaces anton's shipped `product-master` contract, and anton
   * appends the board context and the report protocol beneath it. Empty = shipped default.
   *
   * Only the JUDGMENT is overridable. What the pass may propose, and the wire format anton parses
   * its answer from, stay anton's — see `lib/pm/context.ts`. Only consulted by the `product-master`
   * schedule, which is off by default.
   */
  productMasterPrompt?: string;
  /**
   * How far a pass may go with the proposals it files, per detection kind (anton-nbyy). Absent → the
   * shipped {@link DEFAULT_PROPOSAL_AUTONOMY_POLICY} (`propose` for everything, i.e. no behaviour
   * change); a stored value need only carry the kinds the operator armed. Validated with
   * {@link proposalAutonomySchema} at the API boundary and resolved through
   * {@link resolveAutonomyPolicy}, which drops entries anton no longer recognises rather than
   * failing a pass over a hand-edited settings blob.
   *
   * Distinct from {@link autonomy}, which is the run-execution master switch. This one is about board
   * state a pass proposes; that one is about whether approved epics execute at all.
   */
  proposalAutonomy?: ProposalAutonomyOverrides;
  /**
   * The operator's standing answer to the cadence offer arming the board-picker makes (anton-3xa9,
   * design R7.1): true = keep product-master weekly, and never ask again. Absent = not yet asked.
   *
   * Stored rather than dismissed in the session because the offer is per DECISION, not per visit:
   * an operator who said "keep weekly" and then toggled the picker off and on again would otherwise
   * be asked the same question forever. Nothing reads this but the settings panel — the cadence
   * itself lives on the schedule row, which is the one place a cadence is meant to be legible.
   */
  keepProductMasterWeekly?: boolean;
  /**
   * Bead labels this project nominates as value signals (anton-prng), highest tier first — the input
   * to `jobValueScore`, which is what ranks governed work for admission. anton ships NO vocabulary:
   * absent/empty means work ranks on its native fields alone (age), because a label anton guessed at
   * would silently rank a board that never uses it. The order is the band order, so a project can
   * nominate more than two tiers. Validated with {@link valueLabelsSchema} at the API boundary.
   */
  valueLabels?: string[];
  /**
   * The standing policy narrowing what anton may start on its own (anton-c7iv, R2.1). MACHINE-LOCAL:
   * it lives here rather than on the board because two machines on one repo may legitimately hold
   * different policies, and bd's claim protocol — not a shared setting — resolves the race.
   *
   * Absent is load-bearing: it means the operator has never armed this project, which is what makes
   * first arm propose a calibrated draft (`policy/calibrate.ts`) instead of a blank form. Nothing
   * writes it but an explicit accept. Validated with {@link pickerPolicySchema} at the API boundary.
   */
  pickerPolicy?: Policy;
  /**
   * How far the picker may go with the plan it decides (R3.5) — the level {@link
   * resolvePickerAutonomy} floors before anything acts on it. Absent means the operator has never
   * chosen one, which is NOT the same as `propose`: an armed project defaults to `shadow`, where
   * the picker offers its picks and the operator's releases and vetoes become the record `apply` is
   * earned on. Validated with {@link pickerAutonomySchema} at the API boundary.
   */
  pickerAutonomy?: PickerAutonomy;
}

/** A resolved verify gate (anton-3oh8): a stable label (for logs/errors) + the shell command. */
export interface VerifyGate {
  label: string;
  command: string;
}

/**
 * The ordered verify gates configured for a project (anton-3oh8): tests, then lint, typecheck,
 * build. Unset commands are skipped, so an empty result means "no gates" → unchanged behavior.
 * Shared by execute-epic and review-fix so both enforce the same operator backstop identically.
 */
export function resolveVerifyGates(settings: ProjectSettings): VerifyGate[] {
  const gates: VerifyGate[] = [];
  if (settings.testCommand) gates.push({ label: "tests", command: settings.testCommand });
  if (settings.lintCommand) gates.push({ label: "lint", command: settings.lintCommand });
  if (settings.typecheckCommand) {
    gates.push({ label: "typecheck", command: settings.typecheckCommand });
  }
  if (settings.buildCommand) gates.push({ label: "build", command: settings.buildCommand });
  return gates;
}

/** Defaults for the per-project job policy when a setting is unset. */
export const DEFAULT_CONCURRENCY = 3;
export const DEFAULT_JOB_TIMEOUT_MINUTES = 120; // 2 hours without progress
export const DEFAULT_TICKET_TIMEOUT_MINUTES = 45;
export const DEFAULT_MAX_RETRIES = 3;
/** Two rounds: the reviewer's first pass plus one chance to confirm the fixes landed. */
export const DEFAULT_REVIEW_MAX_ROUNDS = 2;
/**
 * Below 5 on the review contract's anchored scale (skills/review) is "substantial rework" or worse:
 * criteria unmet, a real bug, the `## Verify` tests missing. A 5-6 is mixed and genuinely wants
 * another fix round, so it deliberately does NOT count as low.
 */
export const DEFAULT_REVIEW_MIN_SCORE = 5;
/** Twice is a trend, once is a round the fix loop exists to answer. */
export const DEFAULT_REVIEW_LOW_SCORE_ROUNDS = 2;
/**
 * Three is the smallest count that can only be a pattern. One failure is a hard ticket; two in a row
 * is bad luck often enough that disarming on it would train an operator to re-arm without reading.
 */
export const DEFAULT_AUTOPILOT_FAILURE_STREAK = 3;
/**
 * The picker's score floor, read off what this project has actually shipped rather than picked to
 * sound strict: across 59 scored run targets on anton's own board the scores are 8s and 9s (mean
 * 8.8, minimum 8) — the review contract's "ships as-is" band. Below 7 is therefore under everything
 * a healthy run here has ever produced, and on the anchored scale (skills/review) it is the 5-6
 * "needs another round" band or worse. A 7 itself is acceptable work, so it deliberately does not
 * count: the breaker fires on work that would have been sent back, not on work a reviewer merely
 * had notes about.
 */
export const DEFAULT_AUTOPILOT_SCORE_FLOOR = 7;
/**
 * Three, for the reason {@link DEFAULT_AUTOPILOT_FAILURE_STREAK} is three: it is the smallest count
 * that can only be a pattern. One low score is a hard feature; two is a bad week — and unlike the
 * within-run alarm, nothing downstream re-reviews these, so a breaker that cried wolf would train an
 * operator to re-arm without reading the series.
 */
export const DEFAULT_AUTOPILOT_SCORE_WINDOW = 3;
/**
 * Three unmerged PRs is already a full sitting for one reviewer, and it is the same number as
 * {@link DEFAULT_CONCURRENCY} on purpose: a project running flat out can carry every one of its
 * concurrent runs through to review before the brake bites. So the hold fires on the queue growing
 * past what anton can produce at once — a review backlog — rather than on anton's own concurrency.
 */
export const DEFAULT_AUTOPILOT_WIP_LIMIT = 3;

/** Allowed ranges for the numeric job-policy settings (validated at the API boundary). */
export const CONCURRENCY_RANGE = { min: 1, max: 6 } as const;
export const JOB_TIMEOUT_MINUTES_RANGE = { min: 5, max: 720 } as const; // 5 min … 12 h
export const TICKET_TIMEOUT_MINUTES_RANGE = { min: 5, max: 240 } as const; // 5 min … 4 h
export const MAX_RETRIES_RANGE = { min: 1, max: 10 } as const;
export const REVIEW_MAX_ROUNDS_RANGE = { min: 1, max: 5 } as const;
/** `0` is in range on purpose: it is how the operator turns the score-regression alarm off. */
export const REVIEW_MIN_SCORE_RANGE = { min: 0, max: 10 } as const;
export const REVIEW_LOW_SCORE_ROUNDS_RANGE = { min: 1, max: 5 } as const;
/** `0` is in range on purpose: it is how the operator turns the consecutive-failure breaker off. */
export const AUTOPILOT_FAILURE_STREAK_RANGE = { min: 0, max: 10 } as const;
/** `0` is in range on purpose: it is how the operator turns the score-regression breaker off. */
export const AUTOPILOT_SCORE_FLOOR_RANGE = { min: 0, max: 10 } as const;
export const AUTOPILOT_SCORE_WINDOW_RANGE = { min: 1, max: 10 } as const;
/** `0` is in range on purpose: it is how the operator turns the WIP hold off. */
export const AUTOPILOT_WIP_LIMIT_RANGE = { min: 0, max: 20 } as const;

/** A project's resolved self-review configuration (anton-3apm) — never partial. */
export interface ReviewConfig {
  enabled: boolean;
  /** A discoverable agent id to review as; absent → the shipped review contract. */
  agent?: string;
  /** Operator prompt replacing the shipped contract when no {@link agent} resolves; absent → shipped. */
  prompt?: string;
  maxRounds: number;
  /**
   * The score-regression alarm (anton-i98r); absent when the operator turned it off with a
   * `reviewMinScore` of 0.
   */
  scoreAlarm?: ScoreAlarm;
}

/**
 * The self-review gate's settings with defaults applied (anton-3apm). The single seam the review
 * builder and the execute-epic gate read, so "absent means on" and the round cap can't drift
 * between them.
 */
export function resolveReviewConfig(settings: ProjectSettings): ReviewConfig {
  const minScore = settings.reviewMinScore ?? DEFAULT_REVIEW_MIN_SCORE;
  return {
    enabled: settings.reviewEnabled ?? true,
    agent: settings.reviewAgent || undefined,
    prompt: settings.reviewPrompt || undefined,
    maxRounds: settings.reviewMaxRounds ?? DEFAULT_REVIEW_MAX_ROUNDS,
    // Resolved to absent rather than to a threshold of 0, so the gate reads "no alarm" as a shape
    // instead of having to know that 0 is the off switch.
    ...(minScore > 0
      ? {
          scoreAlarm: {
            minScore,
            rounds: settings.reviewLowScoreRounds ?? DEFAULT_REVIEW_LOW_SCORE_ROUNDS,
          },
        }
      : {}),
  };
}

/**
 * The consecutive-failure breaker's configuration, with the default applied (anton-rgso).
 *
 * Resolved to ABSENT rather than to a threshold of 0, so the picker pass reads "no breaker" as a
 * shape instead of having to know that 0 is the off switch — the same seam `resolveReviewConfig`
 * gives the score alarm, and for the same reason.
 */
export function resolveFailureBreaker(
  settings: ProjectSettings,
): FailureBreakerConfig | undefined {
  const threshold = settings.autopilotFailureStreak ?? DEFAULT_AUTOPILOT_FAILURE_STREAK;
  return threshold > 0 ? { threshold } : undefined;
}

/**
 * The score-regression breaker's configuration, with the defaults applied (anton-cekf).
 *
 * Absent rather than a floor of 0, the same seam its two siblings give their detectors — the picker
 * pass reads "no breaker" as a shape rather than having to know that 0 is the off switch.
 */
export function resolveScoreBreaker(settings: ProjectSettings): ScoreBreakerConfig | undefined {
  const floor = settings.autopilotScoreFloor ?? DEFAULT_AUTOPILOT_SCORE_FLOOR;
  if (floor <= 0) return undefined;
  return { floor, window: settings.autopilotScoreWindow ?? DEFAULT_AUTOPILOT_SCORE_WINDOW };
}

/**
 * The WIP hold's configuration, with the default applied (anton-wy9y).
 *
 * Absent rather than a limit of 0, the same seam its three siblings give their detectors — the
 * picker pass reads "no hold" as a shape rather than having to know that 0 is the off switch.
 */
export function resolveWipLimit(settings: ProjectSettings): WipLimitConfig | undefined {
  const limit = settings.autopilotWipLimit ?? DEFAULT_AUTOPILOT_WIP_LIMIT;
  return limit > 0 ? { limit } : undefined;
}

/** A project's resolved product-master configuration (anton-d2sx) — never partial. */
export interface ProductMasterConfig {
  /** Operator prompt replacing anton's shipped contract; absent → the shipped `product-master` skill. */
  prompt?: string;
}

/**
 * The product-master pass's settings with defaults applied. A seam of its own, tiny as it is, so the
 * prompt builder reads the same "empty means shipped default" rule the settings API writes — the
 * pattern `resolveReviewConfig` establishes for every swappable contract.
 */
export function resolveProductMasterConfig(settings: ProjectSettings): ProductMasterConfig {
  return { prompt: settings.productMasterPrompt?.trim() || undefined };
}

/**
 * Per-kind proposal autonomy as submitted (anton-nbyy). Keyed by the detection kinds and valued by
 * the levels the policy module owns, so a kind added to `detections.ts` is accepted here the moment
 * it exists rather than after someone remembers to widen a second list. Partial (an operator arms
 * one kind at a time) and strict about both halves: an unknown kind or an unknown level 400s instead
 * of persisting a policy that would silently resolve back to `propose`.
 */
export const proposalAutonomySchema = z.partialRecord(
  z.enum(GARDENER_DETECTION_KINDS),
  z.enum(PROPOSAL_AUTONOMY_LEVELS),
);

/**
 * How far each detection kind's proposals may go for this project — the shipped policy with the
 * operator's overrides applied, never partial. The single seam the passes read, so "absent means
 * propose" and the split/targetless-reparent floor can't drift between the gardener and the product
 * master.
 */
export function resolveAutonomyPolicy(settings: ProjectSettings): ProposalAutonomyPolicy {
  return resolveProposalAutonomyPolicy(settings.proposalAutonomy);
}

/**
 * One ticket's wall-clock budget in ms (anton-t1mo) — see {@link ProjectSettings.ticketTimeoutMinutes}.
 *
 * A non-finite or non-positive stored value means "no per-ticket bound", the pre-anton-t1mo
 * behaviour: the ticket runs until the job's own no-progress timeout catches it. Only reachable by
 * hand-editing settings (the API range-checks the field), and honoured rather than coerced so an
 * operator who deliberately unbounds a long ticket isn't silently put back on the default.
 */
export function resolveTicketTimeoutMs(settings: ProjectSettings): number {
  const minutes = settings.ticketTimeoutMinutes ?? DEFAULT_TICKET_TIMEOUT_MINUTES;
  return Number.isFinite(minutes) && minutes > 0 ? minutes * 60_000 : Infinity;
}

/** A 0–100 integer percentage — the same scale the governor's {@link BudgetPolicy} uses. */
const pctSchema = z.number().int().min(0).max(100);

/**
 * Operator-facing budget policy (anton-egrg): the tunable subset of the governor's full
 * {@link BudgetPolicy}. Every field optional so a patch can carry just the knobs the operator
 * touched; each is strictly range-checked (fail loud on out-of-range), and unknown keys are
 * rejected. `dayWindow` is a local `[startHour, endHour)` pair with `start < end`.
 */
export const budgetPolicySchema = z
  .object({
    dayWindow: z
      .tuple([z.number().int().min(0).max(23), z.number().int().min(0).max(23)])
      .refine(([start, end]) => start < end, {
        message: "dayWindow start hour must be before end hour",
      }),
    daytimeReservePct: pctSchema,
    // Zero is rejected for the weekly target specifically: `computePace` treats a target <= 0 as
    // "no pace data", so 0 would silently DISABLE weekly pacing rather than target zero usage.
    weeklyTargetPct: z
      .number()
      .int()
      .min(1, { message: "weeklyTargetPct must be at least 1 (0 would disable pacing, not stop work)" })
      .max(100),
    minSessionHeadroomPct: pctSchema,
    preferNightForHeavy: z.boolean(),
  })
  .partial()
  .strict();

export type ProjectBudgetPolicy = z.infer<typeof budgetPolicySchema>;

/**
 * Safe defaults applied when a policy (or one of its fields) is absent. The daytime reserve is the
 * configurable knob the founder asked for; the weekly target drives the governor's pace-line.
 */
export const DEFAULT_PROJECT_BUDGET_POLICY: Required<ProjectBudgetPolicy> = {
  dayWindow: [9, 18],
  daytimeReservePct: 15,
  weeklyTargetPct: 90,
  minSessionHeadroomPct: 5,
  preferNightForHeavy: true,
};

/** Overlay the stored (possibly partial) operator policy onto the defaults — never a partial out. */
export function resolveProjectBudgetPolicy(
  settings: ProjectSettings,
): Required<ProjectBudgetPolicy> {
  return { ...DEFAULT_PROJECT_BUDGET_POLICY, ...(settings.budgetPolicy ?? {}) };
}

/**
 * Project a project's settings onto the governor's full {@link BudgetPolicy}: the operator's knobs
 * ride on top of {@link DEFAULT_BUDGET_POLICY}, so fields the operator can't set keep the governor's
 * shipped defaults. `preferNightForHeavy` off zeroes the night value discount, so heavy jobs are no
 * longer preferentially deferred to night. This is the hook the admission gate (anton-szld) consumes.
 *
 * `dayWindow` is documented as LOCAL hours, so the governor's fixed UTC offset comes from this
 * machine's timezone (anton runs on the operator's box — machine-local IS operator-local). Resolved
 * per call rather than baked into a constant so a DST shift is picked up at the next gate check
 * while `budgetGate` itself stays pure on a fixed offset.
 */
export function resolveBudgetPolicy(settings: ProjectSettings): BudgetPolicy {
  const p = resolveProjectBudgetPolicy(settings);
  return {
    ...DEFAULT_BUDGET_POLICY,
    minSessionHeadroomPct: p.minSessionHeadroomPct,
    daytimeReservePct: p.daytimeReservePct,
    dayStartHour: p.dayWindow[0],
    dayEndHour: p.dayWindow[1],
    // getTimezoneOffset() is minutes to ADD to local to reach UTC (e.g. 420 for PDT) — the
    // governor's offset is the inverse (local = UTC + offset), hence the negation.
    utcOffsetMinutes: -new Date().getTimezoneOffset(),
    weeklyTargetPct: p.weeklyTargetPct,
    nightValueDiscount: p.preferNightForHeavy ? DEFAULT_BUDGET_POLICY.nightValueDiscount : 0,
    // Board vocabulary, not a budget knob — carried on the policy because the value gate is what
    // consumes it. Absent nominations rank on age alone rather than on labels anton assumed.
    valueLabels: resolveValueLabels(settings),
  };
}

/**
 * A project's nominated value labels (anton-prng). An ORDERED list, not a set, because the order IS
 * the band order `jobValueScore` ranks by: the first entry is the top tier. Bounded like every other
 * operator list, and duplicate-free — a label already nominated can never be reached a second time,
 * so a repeat is a mistake, not a lower tier.
 */
export const valueLabelsSchema = z
  .array(z.string().trim().min(1).max(120))
  .max(8)
  .refine((labels) => new Set(labels).size === labels.length, {
    message: "each label may be nominated once",
  });

/** The project's nominations, in band order — empty when it has nominated none (the default). */
export function resolveValueLabels(settings: ProjectSettings): string[] {
  return settings.valueLabels ?? [];
}

/**
 * The standing work policy (anton-c7iv). Strict on every field, because a policy that fails to parse
 * is a policy that silently admits everything: absent means "never armed", and the picker treats
 * that as "start nothing", so a malformed store must 400 at the boundary rather than round-trip.
 *
 * `values` may not be empty. An empty membership set matches NOTHING (criteria fail closed, R2.5),
 * so it is never what an operator meant — dropping the namespace is how you stop constraining it.
 * Bounded like every other operator list.
 *
 * Both ends of each ordered native field are accepted, but nothing here rejects a pair that crosses
 * (`minPriority` above `maxPriority`): an empty window is a legible policy that admits nothing, and
 * the editor's live match count already says so louder than a 400 would.
 */
export const pickerPolicySchema = z
  .object({
    // A membership set, so duplicate-free like every other one here: a repeat is a test the first
    // entry already answered, and it burns a slot against POLICY_TYPES_MAX — which the editor reads
    // as a ceiling reached, disabling every type the operator has not already selected.
    types: z
      .array(z.string().trim().min(1).max(POLICY_TEXT_MAX.type))
      .min(1)
      .max(POLICY_TYPES_MAX)
      .refine((ts) => new Set(ts).size === ts.length, {
        message: "each type may be listed once",
      }),
    // bd's priority NUMBER, not the printed label: P0 is 0 and larger is less urgent, so `max` is
    // the floor and `min` the ceiling.
    maxPriority: z.number().int().min(0).max(POLICY_PRIORITY_MAX),
    minPriority: z.number().int().min(0).max(POLICY_PRIORITY_MAX),
    // Parent hops above the bead — 0 is top-level. Bounded rather than open-ended because a board
    // nests epic → feature → ticket, and a depth beyond that is a typo, not a policy.
    maxParentDepth: z.number().int().min(0).max(POLICY_BOUND_MAX.parentDepth),
    minParentDepth: z.number().int().min(0).max(POLICY_BOUND_MAX.parentDepth),
    // Whole days. A year is the outer edge of a rule an operator could mean by "old".
    minAgeDays: z.number().int().min(0).max(POLICY_BOUND_MAX.minAgeDays),
    maxAgeDays: z.number().int().min(0).max(POLICY_BOUND_MAX.maxAgeDays),
    labels: z
      .array(
        z
          .object({
            // Never one of anton's own bookkeeping namespaces. The editor already keeps them out of
            // the offered criteria, and the boundary has to agree: a criterion over a namespace
            // anton rewrites mid-run tests a label set that moves under the picker, so the symptom
            // is "policy armed, picker starts nothing" — unreadable from the plan output.
            namespace: z
              .string()
              .trim()
              .min(1)
              .max(POLICY_TEXT_MAX.namespace)
              .refine((ns) => !POLICY_CONTROL_NAMESPACES.has(ns), {
                message: "cannot constrain an anton bookkeeping namespace",
              }),
            // ORDERED when `ranked` — the drag order the operator gave these values (R2.3), which is
            // why nothing on this path sorts them. Duplicate-free: a repeat is a second membership
            // test the first already answered, and under a ranking it is a value at two positions at
            // once — which `admittedValues` resolves by its first, so a bound could admit a slice
            // the stored order does not show.
            values: z
              .array(z.string().trim().min(1).max(POLICY_TEXT_MAX.value))
              .min(1)
              .max(POLICY_CRITERION_VALUES_MAX)
              .refine((vs) => new Set(vs).size === vs.length, {
                message: "each value may be listed once",
              }),
            ranked: z.boolean().optional(),
            // A `≤`/`≥` over that ranking. Rejected without `ranked`, and rejected when it names a
            // value the ranking does not carry: the predicate fails such a criterion CLOSED against
            // every bead (R2.5), so persisting one would arm a policy that admits nothing and says
            // so only per bead.
            compare: z
              .object({
                op: z.enum(["lte", "gte"]),
                value: z.string().trim().min(1).max(POLICY_TEXT_MAX.value),
              })
              .strict()
              .optional(),
          })
          .strict()
          .refine((c) => !c.compare || (c.ranked && c.values.includes(c.compare.value)), {
            message: "a comparison needs a ranking that contains its bound",
          }),
      )
      .max(POLICY_LABEL_CRITERIA_MAX)
      .refine((cs) => new Set(cs.map((c) => c.namespace)).size === cs.length, {
        message: "each namespace may be constrained once",
      }),
    requireUnblocked: z.boolean(),
  })
  .partial()
  .strict();

/** The armed policy, or undefined when this project has never been armed (the first-arm case). */
export function resolvePickerPolicy(settings: ProjectSettings): Policy | undefined {
  return settings.pickerPolicy;
}

/** The stored autonomy level. Strict, because an unrecognised level must not resolve to `apply`. */
export const pickerAutonomySchema = z.enum(PICKER_AUTONOMY_LEVELS);

/**
 * How far the picker may go on this project, with the one structural floor applied here so no caller
 * has to remember it: `apply` requires an ARMED POLICY.
 *
 * Without one the pass falls back to the structural default, which admits every claimable run target
 * — and a pass that wrote `approved` off THAT would be autopilot with no approval in it, the one
 * thing the design refuses (see `picker-decision.ts`'s ADMIT_ALL_POLICY). An operator who set `apply`
 * and then cleared their policy lands on `shadow`: still offered its picks, starting none of them.
 *
 * The EARNED floor — a level a project's own record does not yet support — sits above this one and is
 * the arming gate's (anton-vkp9), not this function's.
 */
export function resolvePickerAutonomy(settings: ProjectSettings): PickerAutonomy {
  const armed = !!settings.pickerPolicy;
  const stored = settings.pickerAutonomy;
  if (!stored) return armed ? "shadow" : "propose";
  return stored === "apply" && !armed ? "shadow" : stored;
}

/**
 * Per-label pipeline variants (anton-aa3m). An ORDERED list, not a map, because the order IS the
 * documented precedence: a bead carrying two mapped labels walks the one the project listed first.
 *
 * `formula` is a name under `.beads/formulas/` (`<name>.formula.toml`), constrained by the same
 * {@link FORMULA_NAME_PATTERN} the loader enforces — no separators, and `..` can't match — so a
 * mapping can't point the loader outside the project's own formulas, and a map that passes this
 * boundary cannot park at that one. Duplicate labels are rejected rather than silently shadowed:
 * a second entry for a label the list already carries can never be selected, so it is a mistake, not
 * a precedence. Bounded in size for the same reason every other operator field is.
 */
export const formulaVariantsSchema = z
  .array(
    z
      .object({
        label: z.string().trim().min(1).max(120),
        formula: z
          .string()
          .trim()
          .min(1)
          .max(120)
          .regex(FORMULA_NAME_PATTERN, {
            message:
              "formula must be a formula name under .beads/formulas/ (letters, digits, . - _)",
          }),
      })
      .strict(),
  )
  .max(20)
  .refine((entries) => new Set(entries.map((e) => e.label)).size === entries.length, {
    message: "each label may map to at most one formula",
  });

/**
 * How stale each class of stall must be before the run-health sweep reports it (anton-4ks0). Every
 * field optional so a patch carries only the knobs the operator touched; each is range-checked (fail
 * loud) and unknown keys rejected, matching {@link budgetPolicySchema}.
 */
export const runHealthThresholdsSchema = z
  .object({
    parkedRunMinutes: z.number().int().min(1).max(10_080), // 1 min … 7 days
    stalePrHours: z.number().int().min(1).max(720), // 1 h … 30 days
    deadLeaseMinutes: z.number().int().min(1).max(10_080),
  })
  .partial()
  .strict();

export type RunHealthThresholds = z.infer<typeof runHealthThresholdsSchema>;

/**
 * Defaults tuned to "longer than the work could plausibly still be moving": a run parked for two
 * hours is not about to un-park itself, a PR untouched for a day has lost its reviewer, and a
 * run-lease is refreshed on a heartbeat so 30 minutes past expiry means the owner is gone.
 */
export const DEFAULT_RUN_HEALTH_THRESHOLDS: Required<RunHealthThresholds> = {
  parkedRunMinutes: 120,
  stalePrHours: 24,
  deadLeaseMinutes: 30,
};

/**
 * A project's stringer severity → `risk:`/priority mapping (anton-bz1w). Optional per SEVERITY, but
 * each override carries BOTH knobs: a half-specified rule ("high is now P0", label unstated) is a
 * question the triage prompt can't answer, and the merge that applies these is per severity.
 */
const severityRuleSchema = z
  .object({
    risk: z.enum(["low", "high"]),
    // bd's own priority scale: 0 = critical … 4 = backlog.
    priority: z.number().int().min(0).max(4),
  })
  .strict();

export const scanSeverityPolicySchema = z
  .object({
    critical: severityRuleSchema,
    high: severityRuleSchema,
    medium: severityRuleSchema,
    low: severityRuleSchema,
  })
  .partial()
  .strict();

/** The shipped mapping with this project's overrides applied — never partial. */
export function resolveScanSeverity(settings: ProjectSettings): ScanSeverityPolicy {
  return resolveScanSeverityPolicy(settings.scanSeverity);
}

export { DEFAULT_SCAN_SEVERITY_POLICY };

/** Overlay the stored (possibly partial) thresholds onto the defaults — never a partial out. */
export function resolveRunHealthThresholds(
  settings: ProjectSettings,
): Required<RunHealthThresholds> {
  return { ...DEFAULT_RUN_HEALTH_THRESHOLDS, ...(settings.runHealth ?? {}) };
}

/** A stored settings blob, or `{}` for a missing row and for one no longer parseable. */
function parseSettings(settingsJson: string | undefined): ProjectSettings {
  if (settingsJson === undefined) return {};
  try {
    return JSON.parse(settingsJson) as ProjectSettings;
  } catch {
    return {};
  }
}

export async function getProjectSettings(db: AntonDb, id: string): Promise<ProjectSettings> {
  const rows = await db
    .select({ settingsJson: schema.projects.settingsJson })
    .from(schema.projects)
    .where(eq(schema.projects.id, id))
    .limit(1);
  return parseSettings(rows[0]?.settingsJson);
}

/** Read this project's settings via the shared anton.db (UI/API read path). */
export async function getProjectSettingsBySlug(slug: string): Promise<ProjectSettings> {
  const p = await getProjectBySlug(slug);
  if (!p) return {};
  return getProjectSettings(getDb(), p.id);
}

/**
 * Whether ANY project has budget-aware execution turned on (anton-7mpv.1). The shaping nudge is a
 * workspace-wide glance, so it's gated on the feature being enabled *somewhere* rather than for a
 * single project. Fail-soft: a project with unparseable settingsJson is treated as off, and the
 * default (no project opted in) returns false — the nudge stays hidden.
 */
export async function isBudgetAwareEnabledAnywhere(): Promise<boolean> {
  const rows = await getDb().select({ settingsJson: schema.projects.settingsJson }).from(schema.projects);
  return rows.some((row) => {
    try {
      return (JSON.parse(row.settingsJson) as ProjectSettings).budgetAware === true;
    } catch {
      return false;
    }
  });
}

/**
 * The resolved governor policies of every budget-aware project (anton-7mpv.1). The shaping nudge
 * evaluates pace/headroom against these — the SAME knobs (`resolveBudgetPolicy`) the per-project
 * governor applies — rather than a hard-coded default, so an operator who tunes `weeklyTargetPct`
 * or `daytimeReservePct` sees the nudge agree with what the runner actually admits. Empty when no
 * project has opted in (the nudge's hide gate); a project with unparseable settingsJson is treated
 * as off, mirroring {@link isBudgetAwareEnabledAnywhere}.
 */
export async function budgetAwareProjectPolicies(): Promise<BudgetPolicy[]> {
  const rows = await getDb().select({ settingsJson: schema.projects.settingsJson }).from(schema.projects);
  const policies: BudgetPolicy[] = [];
  for (const row of rows) {
    try {
      const settings = JSON.parse(row.settingsJson) as ProjectSettings;
      if (settings.budgetAware === true) policies.push(resolveBudgetPolicy(settings));
    } catch {
      // unparseable settings → not budget-aware; skip
    }
  }
  return policies;
}

/** Apply a patch to a settings blob, key by key. Pure — the store's read/write is the caller's. */
function mergeSettings(
  current: ProjectSettings,
  patch: Partial<ProjectSettings>,
): ProjectSettings {
  // Drop keys explicitly set to undefined so "Default" clears rather than persists.
  const next: ProjectSettings = { ...current };
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined || v === "") delete (next as Record<string, unknown>)[k];
    // budgetPolicy and runHealth are partial-by-design nested objects: merge the patched knobs into
    // the stored value so an update carrying only e.g. `weeklyTargetPct` (or `stalePrHours`) can't
    // silently revert the ones the UI/API didn't send to their defaults. Clearing the whole object
    // stays `undefined` above.
    else if (k === "budgetPolicy") next.budgetPolicy = { ...current.budgetPolicy, ...(v as object) };
    else if (k === "runHealth") next.runHealth = { ...current.runHealth, ...(v as object) };
    // Same reasoning, one level down: the merge is per SEVERITY, and each severity's rule carries
    // both knobs (the schema requires it), so re-weighting `critical` can't half-write `high`.
    else if (k === "scanSeverity") next.scanSeverity = { ...current.scanSeverity, ...(v as object) };
    // Per KIND, for the same reason: a client that renders only the kinds it knows must not disarm
    // the ones it didn't send. Setting a kind back to `propose` is an explicit value, not an absence.
    else if (k === "proposalAutonomy") {
      next.proposalAutonomy = { ...current.proposalAutonomy, ...(v as object) };
    }
    else (next as Record<string, unknown>)[k] = v;
  }
  return next;
}

/**
 * Merge a settings patch into the project's settingsJson. Returns the merged settings.
 *
 * The read, the merge and the write happen inside ONE immediate transaction, synchronously, because
 * every writer here rewrites the WHOLE blob and the settings page has several of them: the global
 * Save, the automation table (which saves on change) and the work-policy panel each PATCH on their
 * own. Two in flight at once would otherwise both read the pre-save row, and the later write would
 * silently erase the earlier one's keys while both requests reported success.
 */
export async function updateProjectSettings(
  slug: string,
  patch: Partial<ProjectSettings>,
): Promise<ProjectSettings> {
  const db = getDb();
  const p = await getProjectBySlug(slug);
  if (!p) throw new Error(`Project not found: ${slug}`);
  return db.transaction(
    (tx) => {
      const row = tx
        .select({ settingsJson: schema.projects.settingsJson })
        .from(schema.projects)
        .where(eq(schema.projects.id, p.id))
        .limit(1)
        .get();
      const next = mergeSettings(parseSettings(row?.settingsJson), patch);
      tx
        .update(schema.projects)
        .set({ settingsJson: JSON.stringify(next) })
        .where(eq(schema.projects.id, p.id))
        .run();
      return next;
    },
    // The write lock is taken up front: a deferred transaction would read first and only then try to
    // upgrade, which is the shape that loses to SQLITE_BUSY under exactly the concurrency this
    // guards against.
    { behavior: "immediate" },
  );
}

/** What the shared beads config path reports back — the one seam the log helpers below read. */
type BeadsConfigResult = ReturnType<typeof configureBeadsForRepo>;

/**
 * Whether the config path got the repo all the way there. A partial run is logged, never thrown:
 * the projects row is valid without a board, and the operator needs to see which step fell over.
 */
function logBeadsConfig(repoPath: string, result: BeadsConfigResult): void {
  if (result.errors.length) {
    console.warn(`[projects] beads config partial for ${repoPath}: ${result.errors.join("; ")}`);
  } else if (result.configured && result.ranInit) {
    console.log(`[projects] beads configured for ${repoPath}`);
  }
}

/**
 * Why a wired Dolt remote still has no `refs/dolt/data` on origin. A failed FIRST publish leaves the
 * remote EMPTY — nothing for the next clone to bootstrap from — so it reads louder than a retry note
 * on a remote that already carries history.
 */
function doltPushFailureWarning(
  repoPath: string,
  dolt: Pick<NonNullable<BeadsConfigResult["doltSync"]>, "firstPublish" | "pushAttempts">,
): string {
  if (dolt.firstPublish) {
    return (
      `[projects] Dolt remote wired for ${repoPath} but the FIRST publish failed after ` +
      `${dolt.pushAttempts} attempts — origin has no refs/dolt/data yet (empty remote); ` +
      `retry \`bd dolt pull && bd dolt push\` once auth/network is available`
    );
  }
  return (
    `[projects] Dolt remote wired for ${repoPath} — bd dolt push failed after ` +
    `${dolt.pushAttempts} attempts; retry once auth/network is available`
  );
}

/**
 * Push is non-fatal but reported (anton-8qx): the remote is wired locally even when the publish push
 * fails (e.g. no push access yet), so only claim refs/dolt/data is on origin when it actually is.
 */
function logDoltSync(repoPath: string, result: BeadsConfigResult): void {
  const dolt = result.doltSync;
  if (dolt?.status !== "configured") return;
  if (dolt.pushed !== false) {
    console.log(`[projects] Dolt remote wired for ${repoPath} (refs/dolt/data on origin)`);
    return;
  }
  console.warn(doltPushFailureWarning(repoPath, dolt));
}

/**
 * Hooks are optional for anton-driven repos (the runner pushes Dolt explicitly); just note the
 * manager so bd's post-merge/post-checkout hydration loss under it isn't a silent surprise.
 */
function logHooksWarning(repoPath: string, result: BeadsConfigResult): void {
  if (!result.hooksWarning) return;
  console.warn(
    `[projects] ${result.hooksWarning.manager} owns core.hooksPath in ${repoPath}; ` +
      `bd hydration hooks won't run — chain 'bd hooks run <hook>' manually if you rely on them.`,
  );
}

/**
 * Best-effort beads self-heal for a registered repo (anton-uez). Runs the shared config path
 * (bd init + config.yaml enforcement + .gitignore [+ Dolt wiring via anton-43b]) so a repo added
 * through the UI/API converges to the same end state as one configured via `anton init`. Never
 * throws: a plain directory with no git/origin is skipped, and a beads-config failure is surfaced
 * (logged) but leaves the projects row intact. Returns whether `.beads/` exists afterwards.
 *
 * `prefix` (anton-ivtj) is threaded to `bd init` for a fresh repo with no `.beads/` yet, so the
 * board's ticket-ID prefix is the operator's choice rather than bd's silent dir-name default. It is
 * ignored once a workspace exists (enforcement-only re-run), so passing it on every add is safe.
 */
function healBeads(repoPath: string, prefix?: string): boolean {
  try {
    // appRoot: this runs inside the Next server bundle, where config.mjs's module-relative package
    // root points at a build chunk. The server's cwd IS the release root (bin/anton.mjs launches it
    // with cwd: APP_ROOT — the same anchor formula.ts uses), so UI registration installs the bundled
    // bead formula just like `anton init` instead of reporting `missing-asset`.
    const result = configureBeadsForRepo(repoPath, { prefix, appRoot: process.cwd() });
    logBeadsConfig(repoPath, result);
    logDoltSync(repoPath, result);
    logHooksWarning(repoPath, result);
    return result.hasBeads;
  } catch (err) {
    console.warn(`[projects] beads self-heal failed for ${repoPath}: ${String(err)}`);
    return existsSync(join(repoPath, ".beads"));
  }
}

async function branchExists(repoPath: string, branch: string): Promise<boolean> {
  try {
    await execFileAsync(
      "git",
      ["-C", repoPath, "show-ref", "--verify", "--quiet", `refs/heads/${branch}`],
      { timeout: 10_000 },
    );
    return true;
  } catch {
    return false;
  }
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** A projects row as stored — what each teardown step is handed instead of re-reading it. */
type ProjectRow = typeof schema.projects.$inferSelect;

/** One anton-created worktree recorded on a run, with the branch to delete alongside it. */
interface ProjectWorktree {
  path: string;
  branch: string;
}

/**
 * Teardown step 1 — stop live work before anything else. Raise BOTH enqueue barriers, then drain: a
 * scheduler tick or approval that already crossed the barrier is caught by `quiesceProject`'s abort
 * sweep, anything later is rejected, so the runner can't re-claim this project mid-teardown.
 *
 * Dynamic import — the service statically imports this module for its policy resolver, so a static
 * import here would cycle.
 */
async function quiesceProjectWork(slug: string, projectId: string): Promise<void> {
  try {
    const { getRunner, getScheduler } = await import("./jobs/service");
    getScheduler().quiesceProject(projectId);
    await getRunner().quiesceProject(projectId);
  } catch (e) {
    throw new Error(`deleteProject(${slug}): aborting in-flight jobs failed: ${errMsg(e)}`);
  }
}

/** The distinct worktrees this project's runs created — never the repo's own working tree. */
async function projectWorktrees(db: AntonDb, project: ProjectRow): Promise<ProjectWorktree[]> {
  const runRows = await db
    .select({ worktreePath: schema.runs.worktreePath, branch: schema.runs.branch })
    .from(schema.runs)
    .where(eq(schema.runs.projectId, project.id));
  const worktrees = new Map<string, ProjectWorktree>();
  for (const run of runRows) {
    if (!run.worktreePath) continue;
    // Paranoia guard: never operate on the repo's own working tree, whatever the row says.
    if (resolve(run.worktreePath) === resolve(project.repoPath)) continue;
    worktrees.set(run.worktreePath, { path: run.worktreePath, branch: run.branch ?? "" });
  }
  return [...worktrees.values()];
}

/** What survived removal. `removeWorktree` is best-effort internally, so the result is verified. */
async function worktreeResidue(
  repoPath: string,
  worktrees: ProjectWorktree[],
): Promise<string[]> {
  const residue: string[] = [];
  for (const wt of worktrees) {
    if (existsSync(wt.path)) residue.push(`worktree ${wt.path}`);
    if (wt.branch && (await branchExists(repoPath, wt.branch))) {
      residue.push(`branch ${wt.branch}`);
    }
  }
  return residue;
}

/**
 * Teardown step 2 — remove every anton-created worktree + branch recorded on this project's runs,
 * then fail loud BEFORE any row is touched. If a worktree or branch survived, the DB state is kept
 * so a retry can finish the cleanup instead of deleting the only record of where the residue lives.
 */
async function removeProjectWorktrees(
  db: AntonDb,
  slug: string,
  project: ProjectRow,
): Promise<void> {
  const worktrees = await projectWorktrees(db, project);
  for (const wt of worktrees) {
    await removeWorktree(
      { path: wt.path, branch: wt.branch, baseBranch: wt.branch, repoPath: project.repoPath },
      { deleteBranch: Boolean(wt.branch) },
    );
  }
  const residue = await worktreeResidue(project.repoPath, worktrees);
  if (residue.length > 0) {
    throw new Error(
      `deleteProject(${slug}): worktree cleanup left residue (${residue.join(", ")}); ` +
        `rows kept so a retry can complete the teardown`,
    );
  }
}

/** Teardown step 3 — session logs are disposable local diagnostics: best-effort, never blocking. */
async function deleteSessionLogs(db: AntonDb, projectId: string): Promise<void> {
  const sessionRows = await db
    .select({ logPath: schema.sessions.logPath })
    .from(schema.sessions)
    .where(eq(schema.sessions.projectId, projectId));
  for (const session of sessionRows) {
    if (!session.logPath) continue;
    await unlink(session.logPath).catch(() => {});
  }
}

/**
 * Teardown step 4 — drop the project's anton.db rows atomically, children before parents (no ON
 * DELETE CASCADE in the schema): sessions → runs → jobs → schedules → run-health → picker plan →
 * picker verdicts → hygiene → scan summaries → autopilot disarms → escalations → projects.
 */
function deleteProjectRows(db: AntonDb, slug: string, projectId: string): void {
  try {
    db.transaction((tx) => {
      tx.delete(schema.sessions).where(eq(schema.sessions.projectId, projectId)).run();
      tx.delete(schema.runs).where(eq(schema.runs.projectId, projectId)).run();
      tx.delete(schema.jobs).where(eq(schema.jobs.projectId, projectId)).run();
      tx.delete(schema.schedules).where(eq(schema.schedules.projectId, projectId)).run();
      tx.delete(schema.runHealthReports).where(eq(schema.runHealthReports.projectId, projectId)).run();
      tx
        .delete(schema.boardPickerPlans)
        .where(eq(schema.boardPickerPlans.projectId, projectId))
        .run();
      tx
        .delete(schema.pickerVerdicts)
        .where(eq(schema.pickerVerdicts.projectId, projectId))
        .run();
      tx.delete(schema.hygieneReports).where(eq(schema.hygieneReports.projectId, projectId)).run();
      tx.delete(schema.scanSummaries).where(eq(schema.scanSummaries.projectId, projectId)).run();
      // Before the escalations they point at, and before the project they reference: a project
      // disarmed even once keeps its whole disarm history, so leaving these behind fails the
      // project DELETE on the foreign key and rolls the entire teardown back.
      tx
        .delete(schema.autopilotDisarms)
        .where(eq(schema.autopilotDisarms.projectId, projectId))
        .run();
      tx.delete(schema.escalations).where(eq(schema.escalations.projectId, projectId)).run();
      tx.delete(schema.projects).where(eq(schema.projects.id, projectId)).run();
    });
  } catch (e) {
    throw new Error(`deleteProject(${slug}): deleting anton.db rows failed: ${errMsg(e)}`);
  }
}

/**
 * Full local teardown for a project (anton-adt), in the order the steps below must run: stop live
 * work, remove every anton-created worktree + branch, delete its session logs, then drop its
 * anton.db rows. Leaves the repo itself pristine — the only git commands run are `worktree
 * remove/prune` and `branch -D` on anton's own branches; nothing touches the repo's working tree,
 * tracked files, or `.beads/`.
 *
 * Idempotent-by-absence: a second call (or an unknown slug) throws the clear not-found error, with
 * nothing left to clean. Fails loud mid-way: if a step leaves residue (a worktree/branch that
 * survived removal), the project's rows are kept and the error names the residue so a retry can
 * finish the job instead of silently orphaning it.
 */
export async function deleteProject(slug: string): Promise<void> {
  const db = getDb();
  const rows = await db
    .select()
    .from(schema.projects)
    .where(eq(schema.projects.slug, slug))
    .limit(1);
  const project = rows[0];
  if (!project) throw new Error(`Project not found: ${slug}`);

  await quiesceProjectWork(slug, project.id);
  await removeProjectWorktrees(db, slug, project);
  await deleteSessionLogs(db, project.id);
  deleteProjectRows(db, slug, project.id);
}

/** The row registration writes: a unique slug and the repo's own default branch, resolved once. */
async function insertProjectRow(
  db: AntonDb,
  repoPath: string,
  requestedName?: string,
): Promise<Omit<Project, "hasBeads" | "createdAt">> {
  const name = requestedName?.trim() || basename(repoPath);
  const slug = await uniqueSlug(toSlug(name) || "project");
  const defaultBranch = await detectDefaultBranch(repoPath);
  const id = randomUUID();
  await db.insert(schema.projects).values({ id, slug, name, repoPath, defaultBranch });
  return { id, slug, name, repoPath, defaultBranch };
}

/**
 * Seed the default background-job schedules (nightly stringer, review-fix poll, orphan grooming) so
 * the Phase 2 jobs run without manual setup. Best-effort — a scheduling hiccup must not fail project
 * creation, and schedules can be added later.
 */
async function seedProjectSchedules(db: AntonDb, projectId: string): Promise<void> {
  try {
    const { seedDefaultSchedules } = await import("./schedules");
    const { systemClock } = await import("./jobs/queue");
    await seedDefaultSchedules(db, systemClock, projectId);
  } catch {
    // non-fatal — schedules can be added later.
  }
}

export async function addProject(input: {
  name?: string;
  repoPath: string;
  /** Ticket-ID prefix for a fresh `bd init` (anton-ivtj). Ignored when the repo already has a board. */
  prefix?: string;
}): Promise<Project> {
  const repoPath = resolve(input.repoPath);
  if (!existsSync(repoPath)) {
    throw new Error(`repoPath does not exist: ${repoPath}`);
  }

  const db = getDb();

  // Idempotent (anton-uez): a repo already registered returns its existing row rather than creating
  // a duplicate — an `anton init` re-run, or POST /api/projects on a known repo, is a safe no-op.
  // Still run the self-heal so a previously-misconfigured repo converges on every add.
  const existing = await db
    .select()
    .from(schema.projects)
    .where(eq(schema.projects.repoPath, repoPath))
    .limit(1);
  if (existing[0]) {
    healBeads(repoPath, input.prefix);
    return toProject(existing[0]);
  }

  const row = await insertProjectRow(db, repoPath, input.name);
  await seedProjectSchedules(db, row.id);

  // Self-heal beads so a UI/API-added repo converges to the same end state as `anton init`
  // (anton-uez). Best-effort; `hasBeads` reflects the post-heal reality. The chosen prefix
  // (anton-ivtj) is threaded to `bd init` so a fresh board gets the operator's ticket-ID prefix.
  const hasBeads = healBeads(repoPath, input.prefix);

  return { ...row, hasBeads, createdAt: Math.floor(Date.now() / 1000) };
}
