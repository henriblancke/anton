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
  AUTOPILOT_FAILURE_STREAK_RANGE,
  AUTOPILOT_SCORE_FLOOR_RANGE,
  AUTOPILOT_SCORE_WINDOW_RANGE,
  AUTOPILOT_WIP_LIMIT_RANGE,
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
  REVIEW_FIX_CONCURRENCY_RANGE,
  budgetPolicySchema,
  formulaVariantsSchema,
  modelRoutesSchema,
  pickerAutonomySchema,
  pickerPolicySchema,
  proposalAutonomySchema,
  repairAutonomySchema,
  runHealthThresholdsSchema,
  scanSeverityPolicySchema,
  valueLabelsSchema,
  type ProjectSettings,
} from "@/lib/projects";
import { QUOTA_SHARE_RANGE } from "@/lib/quota-share";
import { resolveProject } from "../resolve-project";
import {
  accept,
  applyFieldRules,
  booleanValue,
  boundedString,
  envVarName,
  fieldRule,
  httpUrl,
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
/** Upper bound on a gateway base URL (anton-n16m) — well past any real endpoint. */
const MAX_URL = 2000;
/** Upper bound on an env-var name (anton-n16m) — no shell allows one near this long. */
const MAX_ENV_NAME = 256;

const settingsField = <K extends keyof ProjectSettings & string>(
  key: K,
  parse: FieldParser<NonNullable<ProjectSettings[K]>>,
): FieldRule<ProjectSettings> => fieldRule<ProjectSettings, K>(key, parse);

/**
 * Numeric job-policy fields, including the autopilot breakers' thresholds. Several accept 0 as a
 * REAL value rather than a clear — it is how the operator turns that guard off: the score-regression
 * alarm (anton-i98r), the consecutive-failure breaker (anton-rgso), the score-regression breaker
 * (anton-cekf) and the WIP hold (anton-wy9y). The shared `null` / `""` clear leaves that intact.
 */
const JOB_POLICY_FIELDS: readonly FieldRule<ProjectSettings>[] = [
  settingsField("concurrency", integerInRange(CONCURRENCY_RANGE)),
  settingsField("reviewFixConcurrency", integerInRange(REVIEW_FIX_CONCURRENCY_RANGE)),
  settingsField("jobTimeoutMinutes", integerInRange(JOB_TIMEOUT_MINUTES_RANGE)),
  settingsField("ticketTimeoutMinutes", integerInRange(TICKET_TIMEOUT_MINUTES_RANGE)),
  settingsField("maxRetries", integerInRange(MAX_RETRIES_RANGE)),
  settingsField("reviewMaxRounds", integerInRange(REVIEW_MAX_ROUNDS_RANGE)),
  settingsField("reviewMinScore", integerInRange(REVIEW_MIN_SCORE_RANGE)),
  settingsField("reviewLowScoreRounds", integerInRange(REVIEW_LOW_SCORE_ROUNDS_RANGE)),
  settingsField("autopilotFailureStreak", integerInRange(AUTOPILOT_FAILURE_STREAK_RANGE)),
  settingsField("autopilotScoreFloor", integerInRange(AUTOPILOT_SCORE_FLOOR_RANGE)),
  settingsField("autopilotScoreWindow", integerInRange(AUTOPILOT_SCORE_WINDOW_RANGE)),
  settingsField("autopilotWipLimit", integerInRange(AUTOPILOT_WIP_LIMIT_RANGE)),
  // A declared quota share (R6.1). `0` is a real value here too — it parks a repo's spend without
  // disarming it — and a cleared field falls back to the equal split across governed projects.
  settingsField("quotaSharePct", integerInRange(QUOTA_SHARE_RANGE)),
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

    // Gateway routing (anton-n16m). The base URL is validated as http(s); the token env var as a
    // NAME, never a value — the secret stays in anton's environment. The base-url-needs-a-token
    // cross-check runs after this group in buildSettingsPatch.
    settingsField("claudeBaseUrl", httpUrl(MAX_URL)),
    settingsField("claudeAuthTokenEnv", envVarName(MAX_ENV_NAME)),
    settingsField("claudeGatewayModelDiscovery", booleanValue),

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
    // `reserve my share` (R6.5) — cleared, the share flows to whoever has work.
    settingsField("reserveQuotaShare", booleanValue),

    // Policy blobs. Each parsed partial is deep-merged into the stored policy by
    // updateProjectSettings, so a client that exposes one knob never wipes the others —
    // except valueLabels (replaced wholesale because its ORDER is the band order) and
    // pickerPolicy (below).
    settingsField("budgetPolicy", schemaValue(budgetPolicySchema, messageDetail("out of range"))),
    settingsField(
      "formulaVariants",
      schemaValue(formulaVariantsSchema, messageDetail("invalid entry"), {
        clearOnEmptyArray: true,
      }),
    ),
    // The model routing table (anton-uu7r). Replaced wholesale and cleared on `[]`, like the
    // variants above: the list's ORDER is its precedence, so a merge would make reordering — or
    // dropping a rule — silently impossible.
    settingsField(
      "modelRoutes",
      schemaValue(modelRoutesSchema, pathDetail, { clearOnEmptyArray: true }),
    ),
    settingsField("runHealth", schemaValue(runHealthThresholdsSchema, messageDetail("out of range"))),
    settingsField("scanSeverity", schemaValue(scanSeverityPolicySchema, pathDetail)),
    settingsField("proposalAutonomy", schemaValue(proposalAutonomySchema, pathDetail)),
    settingsField("repairAutonomy", schemaValue(repairAutonomySchema, pathDetail)),
    settingsField(
      "valueLabels",
      schemaValue(valueLabelsSchema, messageDetail("invalid label"), { clearOnEmptyArray: true }),
    ),

    // Cleared, the project goes back to NEVER ARMED: the panel proposes a fresh calibrated draft
    // and the picker starts nothing until one is accepted. Otherwise replaced WHOLESALE, never
    // merged — dropping a criterion is how a policy is widened, and a merge would make that edit
    // silently impossible.
    settingsField("pickerPolicy", schemaValue(pickerPolicySchema, pathDetail)),
    // Cleared, the project falls back to the level its policy implies — never to `apply`, which is
    // only ever an explicit choice (see resolvePickerAutonomy).
    settingsField(
      "pickerAutonomy",
      schemaValue(pickerAutonomySchema, messageDetail("unsupported level")),
    ),
  ];
}

const ALARM_KEYS = ["reviewMinScore", "reviewMaxRounds", "reviewLowScoreRounds"] as const;

/**
 * The score-regression alarm counts its streak over rounds the converge loop actually RUNS
 * (lib/jobs/review-alarm.ts), so a streak longer than the round cap can never trip: the loop hits
 * the cap and parks as `unresolved` — or opens the PR on a clean-but-low round — while the alarm
 * stays silently dead. Neither knob is wrong on its own, so the contradiction is only visible
 * against the values a run will resolve: the patched one, else the one standing at write time, else
 * the default.
 */
function checkReviewAlarmReachable(
  patch: Partial<ProjectSettings>,
  current: ProjectSettings,
): string | null {
  if (!ALARM_KEYS.some((key) => key in patch)) return null;
  const effective = (key: (typeof ALARM_KEYS)[number], fallback: number): number =>
    (key in patch ? patch[key] : current[key]) ?? fallback;
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
 * A gateway base URL is inert without the env var name anton reads its token from at spawn time
 * (anton-n16m): the driver would point at the gateway with no credential. Neither field is wrong on
 * its own, so — like the alarm cross-check — the contradiction is only visible against the values a
 * run will resolve: the patched one, else the one standing at write time.
 */
function checkGatewayCredentialed(
  patch: Partial<ProjectSettings>,
  current: ProjectSettings,
): string | null {
  if (!("claudeBaseUrl" in patch || "claudeAuthTokenEnv" in patch)) return null;
  const baseUrl = "claudeBaseUrl" in patch ? patch.claudeBaseUrl : current.claudeBaseUrl;
  const tokenEnv = "claudeAuthTokenEnv" in patch ? patch.claudeAuthTokenEnv : current.claudeAuthTokenEnv;
  if (baseUrl && !tokenEnv) {
    return (
      `claudeBaseUrl needs claudeAuthTokenEnv — the name of the env var anton reads the gateway ` +
      `token from at spawn time. Set the token env var name, or clear the base URL.`
    );
  }
  return null;
}

/**
 * The cross-field checks that read settings as they STAND. Both weigh a patched field against a
 * sibling that may not be in this patch, so they must run against the settings AT WRITE TIME — i.e.
 * inside `updateProjectSettingsIf`'s transaction — not a pre-write snapshot. Two overlapping PATCHes
 * could each pass against a snapshot and then commit a combination neither validated (e.g. one saves
 * `{baseUrl, tokenEnv}` while another clears `tokenEnv`, leaving a base URL with no credential).
 * Deciding under the write lock is what makes the refusal true (anton-n16m).
 */
export function checkSettingsCrossFields(
  patch: Partial<ProjectSettings>,
  current: ProjectSettings,
): string | null {
  return checkReviewAlarmReachable(patch, current) ?? checkGatewayCredentialed(patch, current);
}

/**
 * Validates the PATCH body into `patch`, returning the first 400 message or null. Field parsing only
 * — the cross-field checks that read a sibling's stored value run at write time via
 * {@link checkSettingsCrossFields}, so an overlapping write can't slip a contradiction past a stale
 * snapshot.
 */
export async function buildSettingsPatch(
  body: Record<string, unknown>,
  slug: string,
): Promise<{ patch: Partial<ProjectSettings> } | { error: string }> {
  const patch: Partial<ProjectSettings> = {};

  const numericError = await applyFieldRules(JOB_POLICY_FIELDS, body, patch);
  if (numericError) return { error: numericError };

  const fieldError = await applyFieldRules(projectFields(createAgentResolver(slug)), body, patch);
  if (fieldError) return { error: fieldError };

  return { patch };
}
