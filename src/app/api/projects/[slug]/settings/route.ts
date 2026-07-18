import { NextResponse } from "next/server";
import { discoverAgents } from "@/lib/agents-discovery";
import {
  CONCURRENCY_RANGE,
  JOB_TIMEOUT_MINUTES_RANGE,
  MAX_RETRIES_RANGE,
  getProjectBySlug,
  getProjectSettingsBySlug,
  updateProjectSettings,
  type ProjectSettings,
} from "@/lib/projects";

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
      const project = await getProjectBySlug(slug);
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

  try {
    const settings = await updateProjectSettings(slug, patch);
    return NextResponse.json({ settings });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to update settings";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
