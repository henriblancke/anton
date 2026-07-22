import { NextResponse } from "next/server";
import { discoverAgents } from "@/lib/agents-discovery";
import {
  CONCURRENCY_RANGE,
  JOB_TIMEOUT_MINUTES_RANGE,
  MAX_RETRIES_RANGE,
  budgetPolicySchema,
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
  // integer within range. Shared handling so all three behave identically.
  const numericFields: {
    key: "concurrency" | "jobTimeoutMinutes" | "maxRetries";
    range: { min: number; max: number };
  }[] = [
    { key: "concurrency", range: CONCURRENCY_RANGE },
    { key: "jobTimeoutMinutes", range: JOB_TIMEOUT_MINUTES_RANGE },
    { key: "maxRetries", range: MAX_RETRIES_RANGE },
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
      // Resolve for the project's repoPath only — a missing project falls through to
      // updateProjectSettings' 400 below, so tolerate null here rather than 404 early.
      const { project } = await resolveProject(slug);
      const discovered = new Set((await discoverAgents(project?.repoPath)).map((a) => a.id));
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
    // out-of-range / unknown keys 400 (fail loud) rather than persisting a bad policy.
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

  try {
    const settings = await updateProjectSettings(slug, patch);
    return NextResponse.json({ settings });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to update settings";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
