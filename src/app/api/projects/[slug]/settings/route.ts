import { NextResponse } from "next/server";
import { getProjectSettingsBySlug, updateProjectSettings } from "@/lib/projects";
import { buildSettingsPatch } from "./settings-patch";

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
    const settings = await updateProjectSettings(slug, result.patch);
    return NextResponse.json({ settings });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to update settings";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
