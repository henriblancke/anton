import { NextResponse } from "next/server";
import { beads, type PruneAge } from "@/lib/beads/bd";
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
      // Fire-and-forget, exactly like deleteEpic: the prune already landed locally, so don't block
      // the response on a `bd dolt pull/commit/push` a slow/unreachable remote could stall. A failed
      // push is recorded as failing/unpushed in the sync-status registry and retried by the E1
      // heartbeat backstop — this catch only keeps the rejection from floating.
      void beads
        .sync(project.repoPath)
        .catch((e) => console.error(`[prune] beads dolt sync failed after pruning ${slug}`, e));
    }
    return NextResponse.json({ count, pruned: force });
  } catch (err) {
    const message = err instanceof Error ? err.message : "bd prune failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
