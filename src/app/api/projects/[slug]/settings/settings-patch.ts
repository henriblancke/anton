/**
 * Validation for the settings PATCH body: which keys a project may set, and what each accepts.
 *
 * Every field follows one rule — absent means "leave untouched", `null` / `""` clears back to the
 * default, and a concrete value is validated strictly (a bad value 400s rather than persisting
 * something a run would then misbehave on). The list settings whose empty state IS the absent state
 * (`formulaVariants`, `valueLabels`) clear on `[]` too; `agents` does not, because `[]` there is a
 * real value ("no agents active").
 */
import { discoverAgents } from "@/lib/agents-discovery";
import {
  CONCURRENCY_RANGE,
  DEFAULT_REVIEW_LOW_SCORE_ROUNDS,
  DEFAULT_REVIEW_MAX_ROUNDS,
  DEFAULT_REVIEW_MIN_SCORE,
  JOB_TIMEOUT_MINUTES_RANGE,
  TICKET_TIMEOUT_MINUTES_RANGE,
  MAX_RETRIES_RANGE,
  REVIEW_LOW_SCORE_ROUNDS_RANGE,
  REVIEW_MAX_ROUNDS_RANGE,
  REVIEW_MIN_SCORE_RANGE,
  budgetPolicySchema,
  formulaVariantsSchema,
  proposalAutonomySchema,
  runHealthThresholdsSchema,
  scanSeverityPolicySchema,
  valueLabelsSchema,
  getProjectSettingsBySlug,
  type ProjectSettings,
} from "@/lib/projects";
import { resolveProject } from "../resolve-project";
import {
  accept,
  applyFieldRules,
  booleanValue,
  boundedString,
  fieldRule,
  integerInRange,
  isClear,
  messageDetail,
  oneOf,
  pathDetail,
  reject,
  schemaValue,
  type FieldParser,
  type FieldRule,
} from "./field-rules";

/** Models offered to the headless claude driver's `--model`. Empty value = CLI default. */
const ALLOWED_MODELS = new Set([
  "claude-opus-4-8",
  "claude-sonnet-5",
  "claude-haiku-4-5",
  "claude-fable-5",
]);

/** Upper bound on operator-editable prompts — generous for guidance, guards a runaway payload. */
const MAX_PROMPT = 8000;
/** Upper bound on an operator verify-gate command (anton-3oh8) — generous for a chained gate. */
const MAX_COMMAND = 1000;

const settingsField = <K extends keyof ProjectSettings & string>(
  key: K,
  parse: FieldParser<NonNullable<ProjectSettings[K]>>,
): FieldRule<ProjectSettings> => fieldRule<ProjectSettings, K>(key, parse);

/**
 * Numeric job-policy fields. `reviewMinScore` accepts 0 as a real value — it is how the operator
 * turns the score-regression alarm off (anton-i98r) — which the shared `null` / `""` clear leaves
 * intact.
 */
const JOB_POLICY_FIELDS: readonly FieldRule<ProjectSettings>[] = [
  settingsField("concurrency", integerInRange(CONCURRENCY_RANGE)),
  settingsField("jobTimeoutMinutes", integerInRange(JOB_TIMEOUT_MINUTES_RANGE)),
  settingsField("ticketTimeoutMinutes", integerInRange(TICKET_TIMEOUT_MINUTES_RANGE)),
  settingsField("maxRetries", integerInRange(MAX_RETRIES_RANGE)),
  settingsField("reviewMaxRounds", integerInRange(REVIEW_MAX_ROUNDS_RANGE)),
  settingsField("reviewMinScore", integerInRange(REVIEW_MIN_SCORE_RANGE)),
  settingsField("reviewLowScoreRounds", integerInRange(REVIEW_LOW_SCORE_ROUNDS_RANGE)),
];

/**
 * Agent ids this project can actually assign (bundled + its own .claude/agents, anton-dvo.1).
 * Resolved lazily and at most once per request: both the allowlist and the reviewer swap validate
 * against it, and most patches touch neither. A missing project falls through to
 * updateProjectSettings' 400, so tolerate null here rather than 404 early.
 */
function createAgentResolver(slug: string): () => Promise<Set<string>> {
  let known: Set<string> | undefined;
  return async () => {
    if (!known) {
      const { project } = await resolveProject(slug);
      known = new Set((await discoverAgents(project?.repoPath)).map((a) => a.id));
    }
    return known;
  };
}

const knownAgent =
  (agentIds: () => Promise<Set<string>>): FieldParser<string> =>
  async (raw, key) => {
    if (isClear(raw)) return accept(undefined);
    if (typeof raw !== "string") return reject(`${key} must be an agent id`);
    if (!(await agentIds()).has(raw)) return reject(`Unknown agent: ${raw}`);
    return accept(raw);
  };

const knownAgentList =
  (agentIds: () => Promise<Set<string>>): FieldParser<string[]> =>
  async (raw, key) => {
    if (isClear(raw)) return accept(undefined);
    if (!Array.isArray(raw) || raw.some((a) => typeof a !== "string")) {
      return reject(`${key} must be an array of agent ids`);
    }
    const ids = raw as string[];
    if (ids.length > 0) {
      const discovered = await agentIds();
      const unknown = ids.find((a) => !discovered.has(a));
      if (unknown !== undefined) return reject(`Unknown agent: ${unknown}`);
    }
    // `[]` survives as an explicit "no agents active" — distinct from a clear.
    return accept([...new Set(ids)]);
  };

function projectFields(agentIds: () => Promise<Set<string>>): readonly FieldRule<ProjectSettings>[] {
  return [
    // Verify-gate commands (anton-3oh8): tests + operator-pinned lint/typecheck/build. Cleared =
    // gate skipped.
    settingsField("testCommand", boundedString(MAX_COMMAND)),
    settingsField("lintCommand", boundedString(MAX_COMMAND)),
    settingsField("typecheckCommand", boundedString(MAX_COMMAND)),
    settingsField("buildCommand", boundedString(MAX_COMMAND)),

    settingsField("model", oneOf(ALLOWED_MODELS)),

    // Operator prompt overrides — cleared, each falls back to the shipped contract.
    settingsField("seedPrompt", boundedString(MAX_PROMPT)),
    settingsField("reviewFixPrompt", boundedString(MAX_PROMPT)),
    settingsField("productMasterPrompt", boundedString(MAX_PROMPT)),
    settingsField("reviewPrompt", boundedString(MAX_PROMPT)),

    settingsField("reviewAgent", knownAgent(agentIds)),
    settingsField("reviewEnabled", booleanValue),
    settingsField("agents", knownAgentList(agentIds)),
    settingsField("autonomy", booleanValue),
    settingsField("conventionalCommits", booleanValue),
    // Cleared = not yet asked, so the next arm offers the weekly cadence again.
    settingsField("keepProductMasterWeekly", booleanValue),
    settingsField("budgetAware", booleanValue),

    // Policy blobs. Each parsed partial is deep-merged into the stored policy by
    // updateProjectSettings, so a client that exposes one knob never wipes the others —
    // except valueLabels, replaced wholesale because its ORDER is the band order.
    settingsField("budgetPolicy", schemaValue(budgetPolicySchema, messageDetail("out of range"))),
    settingsField(
      "formulaVariants",
      schemaValue(formulaVariantsSchema, messageDetail("invalid entry"), {
        clearOnEmptyArray: true,
      }),
    ),
    settingsField("runHealth", schemaValue(runHealthThresholdsSchema, messageDetail("out of range"))),
    settingsField("scanSeverity", schemaValue(scanSeverityPolicySchema, pathDetail)),
    settingsField("proposalAutonomy", schemaValue(proposalAutonomySchema, pathDetail)),
    settingsField(
      "valueLabels",
      schemaValue(valueLabelsSchema, messageDetail("invalid label"), { clearOnEmptyArray: true }),
    ),
  ];
}

const ALARM_KEYS = ["reviewMinScore", "reviewMaxRounds", "reviewLowScoreRounds"] as const;

/**
 * The score-regression alarm counts its streak over rounds the converge loop actually RUNS
 * (lib/jobs/review-alarm.ts), so a streak longer than the round cap can never trip: the loop hits
 * the cap and parks as `unresolved` — or opens the PR on a clean-but-low round — while the alarm
 * stays silently dead. Neither knob is wrong on its own, so the contradiction is only visible
 * against the values a run will resolve: the patched one, else the stored one, else the default.
 */
async function checkReviewAlarmReachable(
  body: Record<string, unknown>,
  patch: Partial<ProjectSettings>,
  slug: string,
): Promise<string | null> {
  if (!ALARM_KEYS.some((key) => key in body)) return null;
  const stored = await getProjectSettingsBySlug(slug);
  const effective = (key: (typeof ALARM_KEYS)[number], fallback: number): number =>
    (key in patch ? patch[key] : stored[key]) ?? fallback;
  const minScore = effective("reviewMinScore", DEFAULT_REVIEW_MIN_SCORE);
  const maxRounds = effective("reviewMaxRounds", DEFAULT_REVIEW_MAX_ROUNDS);
  const lowScoreRounds = effective("reviewLowScoreRounds", DEFAULT_REVIEW_LOW_SCORE_ROUNDS);
  // A minimum score of 0 is the alarm's off switch — an unreachable streak is moot while it's off.
  if (minScore > 0 && lowScoreRounds > maxRounds) {
    return (
      `reviewLowScoreRounds (${lowScoreRounds}) cannot exceed reviewMaxRounds (${maxRounds}) — ` +
      `the alarm would never fire, because the review loop stops at the round cap first`
    );
  }
  return null;
}

/**
 * Validates the PATCH body into `patch`, returning the first 400 message or null. The alarm
 * cross-check runs between the two groups because it reads the job-policy numbers this patch sets
 * against the ones already stored.
 */
export async function buildSettingsPatch(
  body: Record<string, unknown>,
  slug: string,
): Promise<{ patch: Partial<ProjectSettings> } | { error: string }> {
  const patch: Partial<ProjectSettings> = {};

  const numericError = await applyFieldRules(JOB_POLICY_FIELDS, body, patch);
  if (numericError) return { error: numericError };

  const alarmError = await checkReviewAlarmReachable(body, patch, slug);
  if (alarmError) return { error: alarmError };

  const fieldError = await applyFieldRules(projectFields(createAgentResolver(slug)), body, patch);
  if (fieldError) return { error: fieldError };

  return { patch };
}
