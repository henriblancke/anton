import { NextResponse } from "next/server";

import { getProjectBySlug } from "@/lib/projects";
import type { Project } from "@/lib/types";

type ResolveProjectResult =
  | { project: Project; response?: undefined }
  | { project?: undefined; response: NextResponse };

/**
 * Shared project-lookup guard for the `[slug]` API routes. Returns the resolved project, or a
 * ready-to-return 404 `NextResponse` when the slug matches nothing:
 *
 *   const { project, response } = await resolveProject(slug);
 *   if (!project) return response;
 *
 * `notFoundMessage` preserves each route's existing 404 body verbatim — the DELETE route echoes
 * the slug (`Project not found: <slug>`), every other route uses the bare "Project not found".
 */
export async function resolveProject(
  slug: string,
  notFoundMessage: string = "Project not found",
): Promise<ResolveProjectResult> {
  const project = await getProjectBySlug(slug);
  if (!project) {
    return {
      response: NextResponse.json({ error: notFoundMessage }, { status: 404 }),
    };
  }
  return { project };
}
