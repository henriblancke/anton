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
    return { response: notFoundResponse(notFoundMessage) };
  }
  return { project };
}

/** The standard `{ error }` 404 body shared by the `[slug]` routes' not-found paths. */
export function notFoundResponse(message: string): NextResponse {
  return NextResponse.json({ error: message }, { status: 404 });
}

/**
 * Wrap a `[slug]`-scoped route handler with the shared prelude: await `params`, resolve the
 * project, and short-circuit with resolveProject's 404 when the slug matches nothing. The handler
 * gets the resolved project alongside the awaited params:
 *
 *   export const GET = withProject<{ slug: string; epicId: string }>(
 *     async (_request, { project, params }) => { ... },
 *   );
 */
export function withProject<P extends { slug: string }>(
  handler: (
    request: Request,
    ctx: { project: Project; params: P },
  ) => Response | Promise<Response>,
): (request: Request, context: { params: Promise<P> }) => Promise<Response> {
  return async (request, context) => {
    const params = await context.params;
    const { project, response } = await resolveProject(params.slug);
    if (!project) return response;
    return handler(request, { project, params });
  };
}
