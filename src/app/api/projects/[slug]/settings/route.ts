import { NextResponse } from "next/server";
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
  updateProjectSettings,
  type ProjectSettings,
} from "@/lib/projects";
import { resolveProject } from "../resolve-project";

export const dynamic = "force-dynamic";

/** Models offered to the headless claude driver's `--model`. Empty value = CLI default. */
const ALLOWED_MODELS = new Set([
  "claude-opus-4-8",
  "claude-sonnet-5",
  "claude-haiku-4-5",
  "claude-fable-5",
]);

export async function GET(_request: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const settings = await getProjectSettingsBySlug(slug);
  return NextResponse.json({ settings });
}

/** Upper bound on operator-editable prompts — generous for guidance, guards a runaway payload. */
const MAX_SEED_PROMPT = 8000;
const MAX_REVIEW_FIX_PROMPT = 8000;
const MAX_REVIEW_PROMPT = 8000;
const MAX_PRODUCT_MASTER_PROMPT = 8000;
/** Upper bound on an operator verify-gate command (anton-3oh8) — generous for a chained gate. */
const MAX_COMMAND = 1000;

export async function PATCH(request: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const body = await request.json().catch(() => null);
  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "Invalid body" }, { status: 400 });
  }

  const patch: Partial<ProjectSettings> = {};

  // Numeric job-policy fields: null / "" clears to the default; a concrete value must be an
  // integer within range. Shared handling so all of them behave identically.
  const numericFields: {
    key:
      | "concurrency"
      | "jobTimeoutMinutes"
      | "ticketTimeoutMinutes"
      | "maxRetries"
      | "reviewMaxRounds"
      | "reviewMinScore"
      | "reviewLowScoreRounds";
    range: { min: number; max: number };
  }[] = [
    { key: "concurrency", range: CONCURRENCY_RANGE },
    { key: "jobTimeoutMinutes", range: JOB_TIMEOUT_MINUTES_RANGE },
    { key: "ticketTimeoutMinutes", range: TICKET_TIMEOUT_MINUTES_RANGE },
    { key: "maxRetries", range: MAX_RETRIES_RANGE },
    { key: "reviewMaxRounds", range: REVIEW_MAX_ROUNDS_RANGE },
    // 0 is a real value here, not a clear: it is how the operator turns the score-regression alarm
    // off (anton-i98r). `null` / "" still clears back to the default threshold.
    { key: "reviewMinScore", range: REVIEW_MIN_SCORE_RANGE },
    { key: "reviewLowScoreRounds", range: REVIEW_LOW_SCORE_ROUNDS_RANGE },
  ];
  for (const { key, range } of numericFields) {
    if (!(key in body)) continue;
    const raw = (body as Record<string, unknown>)[key];
    if (raw == null || raw === "") {
      patch[key] = undefined; // clear → falls back to the default
      continue;
    }
    const n = typeof raw === "number" ? raw : Number(raw);
    if (!Number.isInteger(n) || n < range.min || n > range.max) {
      return NextResponse.json(
        { error: `${key} must be an integer in [${range.min}, ${range.max}]` },
        { status: 400 },
      );
    }
    patch[key] = n;
  }

  // The score-regression alarm counts its streak over rounds the converge loop actually RUNS
  // (lib/jobs/review-alarm.ts), so a streak longer than the round cap can never trip: the loop hits
  // the cap and parks as `unresolved` — or opens the PR on a clean-but-low round — while the alarm
  // stays silently dead. Neither knob is wrong on its own, so the contradiction is only visible
  // against the values a run will resolve: the patched one, else the stored one, else the default.
  const alarmKeys = ["reviewMinScore", "reviewMaxRounds", "reviewLowScoreRounds"] as const;
  if (alarmKeys.some((key) => key in body)) {
    const stored = await getProjectSettingsBySlug(slug);
    const effective = (key: (typeof alarmKeys)[number], fallback: number): number =>
      (key in patch ? patch[key] : stored[key]) ?? fallback;
    const minScore = effective("reviewMinScore", DEFAULT_REVIEW_MIN_SCORE);
    const maxRounds = effective("reviewMaxRounds", DEFAULT_REVIEW_MAX_ROUNDS);
    const lowScoreRounds = effective("reviewLowScoreRounds", DEFAULT_REVIEW_LOW_SCORE_ROUNDS);
    // A minimum score of 0 is the alarm's off switch — an unreachable streak is moot while it's off.
    if (minScore > 0 && lowScoreRounds > maxRounds) {
      return NextResponse.json(
        {
          error:
            `reviewLowScoreRounds (${lowScoreRounds}) cannot exceed reviewMaxRounds (${maxRounds}) — ` +
            `the alarm would never fire, because the review loop stops at the round cap first`,
        },
        { status: 400 },
      );
    }
  }

  // Verify-gate commands (anton-3oh8): tests + operator-pinned lint/typecheck/build. "" / null
  // clears the gate (skipped); otherwise a bounded shell-command string. Shared handling so all
  // four behave identically.
  const commandFields: ("testCommand" | "lintCommand" | "typecheckCommand" | "buildCommand")[] = [
    "testCommand",
    "lintCommand",
    "typecheckCommand",
    "buildCommand",
  ];
  for (const key of commandFields) {
    if (!(key in body)) continue;
    const raw = (body as Record<string, unknown>)[key];
    if (raw == null || raw === "") {
      patch[key] = undefined; // clear → gate skipped
      continue;
    }
    if (typeof raw !== "string") {
      return NextResponse.json({ error: `${key} must be a string` }, { status: 400 });
    }
    if (raw.length > MAX_COMMAND) {
      return NextResponse.json(
        { error: `${key} too long (max ${MAX_COMMAND} chars)` },
        { status: 400 },
      );
    }
    patch[key] = raw;
  }

  if ("model" in body) {
    const model = body.model;
    // "" / null → clear (Default). A concrete value must be one we support.
    if (model == null || model === "") patch.model = undefined;
    else if (typeof model === "string" && ALLOWED_MODELS.has(model)) patch.model = model;
    else return NextResponse.json({ error: `Unsupported model: ${model}` }, { status: 400 });
  }

  if ("seedPrompt" in body) {
    const seed = body.seedPrompt;
    // "" / null → clear the seed (base + agent still apply). Otherwise a bounded string.
    if (seed == null || seed === "") patch.seedPrompt = undefined;
    else if (typeof seed !== "string") {
      return NextResponse.json({ error: "seedPrompt must be a string" }, { status: 400 });
    } else if (seed.length > MAX_SEED_PROMPT) {
      return NextResponse.json(
        { error: `seedPrompt too long (max ${MAX_SEED_PROMPT} chars)` },
        { status: 400 },
      );
    } else patch.seedPrompt = seed;
  }

  if ("reviewFixPrompt" in body) {
    const rf = body.reviewFixPrompt;
    // "" / null → clear the override (fall back to the shipped default). Otherwise a bounded string.
    if (rf == null || rf === "") patch.reviewFixPrompt = undefined;
    else if (typeof rf !== "string") {
      return NextResponse.json({ error: "reviewFixPrompt must be a string" }, { status: 400 });
    } else if (rf.length > MAX_REVIEW_FIX_PROMPT) {
      return NextResponse.json(
        { error: `reviewFixPrompt too long (max ${MAX_REVIEW_FIX_PROMPT} chars)` },
        { status: 400 },
      );
    } else patch.reviewFixPrompt = rf;
  }

  if ("productMasterPrompt" in body) {
    const pm = body.productMasterPrompt;
    // "" / null → clear the override (fall back to the shipped contract). Otherwise a bounded string.
    if (pm == null || pm === "") patch.productMasterPrompt = undefined;
    else if (typeof pm !== "string") {
      return NextResponse.json({ error: "productMasterPrompt must be a string" }, { status: 400 });
    } else if (pm.length > MAX_PRODUCT_MASTER_PROMPT) {
      return NextResponse.json(
        { error: `productMasterPrompt too long (max ${MAX_PRODUCT_MASTER_PROMPT} chars)` },
        { status: 400 },
      );
    } else patch.productMasterPrompt = pm;
  }

  if ("reviewPrompt" in body) {
    const rp = body.reviewPrompt;
    // "" / null → clear the override (fall back to the shipped review contract). Otherwise bounded.
    if (rp == null || rp === "") patch.reviewPrompt = undefined;
    else if (typeof rp !== "string") {
      return NextResponse.json({ error: "reviewPrompt must be a string" }, { status: 400 });
    } else if (rp.length > MAX_REVIEW_PROMPT) {
      return NextResponse.json(
        { error: `reviewPrompt too long (max ${MAX_REVIEW_PROMPT} chars)` },
        { status: 400 },
      );
    } else patch.reviewPrompt = rp;
  }

  // Agent ids this project can actually assign (bundled + its own .claude/agents, anton-dvo.1).
  // Resolved lazily and at most once: both the allowlist and the reviewer swap validate against it,
  // and most patches touch neither. A missing project falls through to updateProjectSettings' 400
  // below, so tolerate null here rather than 404 early.
  let knownAgents: Set<string> | undefined;
  async function knownAgentIds(): Promise<Set<string>> {
    if (!knownAgents) {
      const { project } = await resolveProject(slug);
      knownAgents = new Set((await discoverAgents(project?.repoPath)).map((a) => a.id));
    }
    return knownAgents;
  }

  if ("reviewAgent" in body) {
    const reviewAgent = body.reviewAgent;
    // "" / null → clear (review runs as the shipped contract). Otherwise an agent this project has.
    if (reviewAgent == null || reviewAgent === "") patch.reviewAgent = undefined;
    else if (typeof reviewAgent !== "string") {
      return NextResponse.json({ error: "reviewAgent must be an agent id" }, { status: 400 });
    } else if (!(await knownAgentIds()).has(reviewAgent)) {
      return NextResponse.json({ error: `Unknown agent: ${reviewAgent}` }, { status: 400 });
    } else patch.reviewAgent = reviewAgent;
  }

  if ("reviewEnabled" in body) {
    const reviewEnabled = body.reviewEnabled;
    // "" / null → clear (default: ON — absent means the gate runs). Otherwise strictly a boolean.
    if (reviewEnabled == null || reviewEnabled === "") patch.reviewEnabled = undefined;
    else if (typeof reviewEnabled !== "boolean") {
      return NextResponse.json({ error: "reviewEnabled must be a boolean" }, { status: 400 });
    } else patch.reviewEnabled = reviewEnabled;
  }

  if ("agents" in body) {
    const agents = body.agents;
    // "" / null → clear (fall back to the default active set). Otherwise an array of ids that this
    // project can actually assign (bundled + its own .claude/agents, anton-dvo.1); [] is a real
    // value ("no agents"), not a clear.
    if (agents == null || agents === "") patch.agents = undefined;
    else if (!Array.isArray(agents) || agents.some((a) => typeof a !== "string")) {
      return NextResponse.json(
        { error: "agents must be an array of agent ids" },
        { status: 400 },
      );
    } else if (agents.length > 0) {
      const discovered = await knownAgentIds();
      const unknown = agents.find((a) => !discovered.has(a));
      if (unknown !== undefined) {
        return NextResponse.json({ error: `Unknown agent: ${unknown}` }, { status: 400 });
      }
      patch.agents = [...new Set<string>(agents)];
    } else {
      patch.agents = []; // explicit "no agents active"
    }
  }

  if ("autonomy" in body) {
    const autonomy = body.autonomy;
    // "" / null → clear (default: autonomous). Otherwise strictly a boolean.
    if (autonomy == null || autonomy === "") patch.autonomy = undefined;
    else if (typeof autonomy !== "boolean") {
      return NextResponse.json({ error: "autonomy must be a boolean" }, { status: 400 });
    } else patch.autonomy = autonomy;
  }

  if ("conventionalCommits" in body) {
    const conventionalCommits = body.conventionalCommits;
    // "" / null → clear (default: OFF). Otherwise strictly a boolean.
    if (conventionalCommits == null || conventionalCommits === "") {
      patch.conventionalCommits = undefined;
    } else if (typeof conventionalCommits !== "boolean") {
      return NextResponse.json(
        { error: "conventionalCommits must be a boolean" },
        { status: 400 },
      );
    } else patch.conventionalCommits = conventionalCommits;
  }

  if ("keepProductMasterWeekly" in body) {
    const keep = body.keepProductMasterWeekly;
    // "" / null → clear (not yet asked, so the next arm offers again). Otherwise strictly a boolean.
    if (keep == null || keep === "") patch.keepProductMasterWeekly = undefined;
    else if (typeof keep !== "boolean") {
      return NextResponse.json(
        { error: "keepProductMasterWeekly must be a boolean" },
        { status: 400 },
      );
    } else patch.keepProductMasterWeekly = keep;
  }

  if ("budgetAware" in body) {
    const budgetAware = body.budgetAware;
    // "" / null → clear (default: OFF). Otherwise strictly a boolean.
    if (budgetAware == null || budgetAware === "") patch.budgetAware = undefined;
    else if (typeof budgetAware !== "boolean") {
      return NextResponse.json({ error: "budgetAware must be a boolean" }, { status: 400 });
    } else patch.budgetAware = budgetAware;
  }

  if ("budgetPolicy" in body) {
    const raw = (body as Record<string, unknown>).budgetPolicy;
    // "" / null → clear (fall back to DEFAULT_PROJECT_BUDGET_POLICY). Otherwise validate strictly:
    // out-of-range / unknown keys 400 (fail loud) rather than persisting a bad policy. The parsed
    // partial is deep-merged into the stored policy by updateProjectSettings, so a patch carrying
    // only the knobs a client exposes never wipes the ones it doesn't.
    if (raw == null || raw === "") {
      patch.budgetPolicy = undefined;
    } else {
      const parsed = budgetPolicySchema.safeParse(raw);
      if (!parsed.success) {
        const detail = parsed.error.issues[0]?.message ?? "out of range";
        return NextResponse.json({ error: `Invalid budgetPolicy: ${detail}` }, { status: 400 });
      }
      patch.budgetPolicy = parsed.data;
    }
  }

  if ("formulaVariants" in body) {
    const raw = (body as Record<string, unknown>).formulaVariants;
    // "" / null / [] → clear: an empty map IS "no variants", which is exactly the absent case (every
    // run walks the project's default), so it's stored as absent rather than as an empty array.
    // Otherwise validate strictly — a bad label→formula entry 400s rather than persisting a mapping
    // that would park every run carrying that label.
    if (raw == null || raw === "" || (Array.isArray(raw) && raw.length === 0)) {
      patch.formulaVariants = undefined;
    } else {
      const parsed = formulaVariantsSchema.safeParse(raw);
      if (!parsed.success) {
        const detail = parsed.error.issues[0]?.message ?? "invalid entry";
        return NextResponse.json({ error: `Invalid formulaVariants: ${detail}` }, { status: 400 });
      }
      patch.formulaVariants = parsed.data;
    }
  }

  if ("runHealth" in body) {
    const raw = (body as Record<string, unknown>).runHealth;
    // "" / null → clear (fall back to DEFAULT_RUN_HEALTH_THRESHOLDS). Otherwise validate strictly,
    // same posture as budgetPolicy: a bad threshold 400s rather than silently persisting a value
    // that would make the sweep report everything (or nothing). The parsed partial is deep-merged
    // into the stored thresholds by updateProjectSettings, so a patch carrying one knob leaves the
    // operator's other custom thresholds alone.
    if (raw == null || raw === "") {
      patch.runHealth = undefined;
    } else {
      const parsed = runHealthThresholdsSchema.safeParse(raw);
      if (!parsed.success) {
        const detail = parsed.error.issues[0]?.message ?? "out of range";
        return NextResponse.json({ error: `Invalid runHealth: ${detail}` }, { status: 400 });
      }
      patch.runHealth = parsed.data;
    }
  }

  if ("scanSeverity" in body) {
    const raw = (body as Record<string, unknown>).scanSeverity;
    // "" / null → clear (fall back to DEFAULT_SCAN_SEVERITY_POLICY). Otherwise validate strictly:
    // a bad rule 400s rather than persisting a mapping that would send every stringer bead to the
    // triage prompt with a label bd doesn't recognise. Deep-merged per severity by
    // updateProjectSettings, so re-weighting `critical` leaves the operator's other overrides alone.
    if (raw == null || raw === "") {
      patch.scanSeverity = undefined;
    } else {
      const parsed = scanSeverityPolicySchema.safeParse(raw);
      if (!parsed.success) {
        const issue = parsed.error.issues[0];
        const detail = issue ? `${issue.path.join(".") || "policy"}: ${issue.message}` : "invalid";
        return NextResponse.json({ error: `Invalid scanSeverity: ${detail}` }, { status: 400 });
      }
      patch.scanSeverity = parsed.data;
    }
  }

  if ("proposalAutonomy" in body) {
    const raw = (body as Record<string, unknown>).proposalAutonomy;
    // "" / null → clear (every kind back to `propose`). Otherwise validate strictly: an unknown kind
    // or an unknown level 400s rather than persisting an entry that would silently resolve back to
    // `propose` — an operator who thinks they armed a kind and didn't is the one failure this
    // setting cannot afford. Deep-merged per kind by updateProjectSettings.
    if (raw == null || raw === "") {
      patch.proposalAutonomy = undefined;
    } else {
      const parsed = proposalAutonomySchema.safeParse(raw);
      if (!parsed.success) {
        const issue = parsed.error.issues[0];
        const detail = issue ? `${issue.path.join(".") || "policy"}: ${issue.message}` : "invalid";
        return NextResponse.json(
          { error: `Invalid proposalAutonomy: ${detail}` },
          { status: 400 },
        );
      }
      patch.proposalAutonomy = parsed.data;
    }
  }

  if ("valueLabels" in body) {
    const raw = (body as Record<string, unknown>).valueLabels;
    // "" / null / [] → clear: nominating nothing IS the default (rank on native fields alone), so
    // it is stored as absent rather than as an empty array. Otherwise validate strictly — a
    // duplicate or over-long nomination 400s rather than persisting a tier that can never be
    // reached. Replaced wholesale, not merged: the array's ORDER is the band order an operator tunes.
    if (raw == null || raw === "" || (Array.isArray(raw) && raw.length === 0)) {
      patch.valueLabels = undefined;
    } else {
      const parsed = valueLabelsSchema.safeParse(raw);
      if (!parsed.success) {
        const detail = parsed.error.issues[0]?.message ?? "invalid label";
        return NextResponse.json({ error: `Invalid valueLabels: ${detail}` }, { status: 400 });
      }
      patch.valueLabels = parsed.data;
    }
  }

  try {
    const settings = await updateProjectSettings(slug, patch);
    return NextResponse.json({ settings });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to update settings";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
