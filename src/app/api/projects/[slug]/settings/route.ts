import { NextResponse } from "next/server";
import { getProjectSettingsBySlug, updateProjectSettingsIf } from "@/lib/projects";
import { buildSettingsPatch, checkSettingsCrossFields } from "./settings-patch";

export const dynamic = "force-dynamic";

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

  const result = await buildSettingsPatch(body as Record<string, unknown>, slug);
  if ("error" in result) {
    return NextResponse.json({ error: result.error }, { status: 400 });
  }

  try {
    // The cross-field checks decide under the write lock, against the settings as they stand, so two
    // overlapping PATCHes can't each pass a stale snapshot and commit a combination neither validated.
    const outcome = await updateProjectSettingsIf(slug, (current) => {
      const crossError = checkSettingsCrossFields(result.patch, current);
      return crossError ? { refuse: crossError } : { write: result.patch };
    });
    if (!outcome.applied) {
      return NextResponse.json({ error: outcome.refused }, { status: 400 });
    }
    return NextResponse.json({ settings: outcome.settings });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to update settings";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
