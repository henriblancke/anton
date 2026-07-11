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

  try {
    const settings = await updateProjectSettings(slug, patch);
    return NextResponse.json({ settings });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to update settings";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
