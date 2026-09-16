import { NextResponse } from "next/server";

import { getProjectSettings } from "@/lib/projects";
import { getRouterUsageView } from "@/lib/claude/router-usage-view";
import { getDb } from "@/lib/db";
import { resolveProject } from "../resolve-project";

export const dynamic = "force-dynamic";

/**
 * The project view's routed meter (anton-ds7e) — distinct from `/api/usage`, which stays
 * machine-wide and unchanged. A project with no gateway configured answers `204`, same as the pill
 * does for "nothing to show" — the project view treats that as "not routed" and renders nothing
 * here rather than a meter for a project that isn't metered by a router at all.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ slug: string }> },
) {
  const { slug } = await params;
  const { project, response } = await resolveProject(slug);
  if (!project) return response;

  const settings = await getProjectSettings(getDb(), project.id);
  const view = await getRouterUsageView(settings);
  if (view.state === "unrouted") return new NextResponse(null, { status: 204 });
  return NextResponse.json(view, { headers: { "Cache-Control": "private, max-age=30" } });
}
