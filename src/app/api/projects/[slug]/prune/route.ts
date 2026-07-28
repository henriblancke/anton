import { NextResponse } from "next/server";
import { beads, type PruneAge } from "@/lib/beads/bd";
import { nudgeSync } from "@/lib/beads/sync-nudge";
import { resolveProject } from "../resolve-project";

export const dynamic = "force-dynamic";

const AGES = new Set<string>(["30d", "90d", "all"] satisfies PruneAge[]);

/**
 * Prune closed beads for a project (anton-uobe). POST { age, force? }: without `force` it's a
 * dry-run preview returning how many closed beads would be pruned; with `force: true` it
 * permanently deletes them (bd only ever touches closed, non-ephemeral, non-pinned beads).
 * Preview and delete share one handler so the UI's confirm path can't drift from its preview.
 */
export async function POST(request: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const { project, response } = await resolveProject(slug);
  if (!project) return response;

  const body = (await request.json().catch(() => null)) as
    | { age?: unknown; force?: unknown }
    | null;
  const age = body?.age;
  if (typeof age !== "string" || !AGES.has(age)) {
    return NextResponse.json({ error: "age must be one of 30d, 90d, all" }, { status: 400 });
  }
  const force = body?.force === true;

  try {
    const count = await beads.prune(project.repoPath, age as PruneAge, { force });
    if (force) {
      // A destructive prune already landed locally, so don't block the response on a `bd dolt
      // pull/commit/push` a slow/unreachable remote could stall. nudgeSync fires the immediate push
      // AND enqueues the durable sync-push backstop (anton-nowq) so the deletion can't be stranded
      // locally — it either reaches the remote or parks for a human. Previews write nothing.
      nudgeSync({ id: project.id, repoPath: project.repoPath }, "prune");
    }
    return NextResponse.json({ count, pruned: force });
  } catch (err) {
    const message = err instanceof Error ? err.message : "bd prune failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
