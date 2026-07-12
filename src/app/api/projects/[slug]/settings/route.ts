import { NextResponse } from "next/server";
import { getProjectSettingsBySlug, updateProjectSettings } from "@/lib/projects";

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

/** Upper bound on the operator seed prompt — generous for guidance, guards a runaway payload. */
const MAX_SEED_PROMPT = 8000;

export async function PATCH(request: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const body = await request.json().catch(() => null);
  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "Invalid body" }, { status: 400 });
  }

  const patch: Record<string, string | undefined> = {};
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

  try {
    const settings = await updateProjectSettings(slug, patch);
    return NextResponse.json({ settings });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to update settings";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
