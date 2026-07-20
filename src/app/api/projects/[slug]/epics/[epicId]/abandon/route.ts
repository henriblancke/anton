import { NextResponse } from "next/server";
import { abandonEpic, NotAbandonableError } from "@/lib/abandon";
import { resolveProject } from "../../../resolve-project";

export const dynamic = "force-dynamic";

/**
 * Abandon an epic and everything still open under it (anton-6xj0). Mirrors the DELETE cascade in
 * ../route.ts — same "the children go with the epic" shape — but keeps the beads instead of
 * destroying them: each is closed with the reason and tagged `abandoned`. Returns the ids it
 * settled so the caller can reconcile its board without a full refetch.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ slug: string; epicId: string }> },
) {
  const { slug, epicId } = await params;
  const { project, response } = await resolveProject(slug);
  if (!project) return response;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const reason = (body as { reason?: unknown })?.reason;
  if (typeof reason !== "string" || !reason.trim()) {
    return NextResponse.json({ error: "Abandon reason is required" }, { status: 400 });
  }

  try {
    const result = await abandonEpic(project, epicId, reason);
    return NextResponse.json({ abandoned: result });
  } catch (err) {
    if (err instanceof NotAbandonableError) {
      return NextResponse.json({ error: err.message }, { status: 409 });
    }
    const message = err instanceof Error ? err.message : "Failed to abandon epic";
    // Only the reason's own validation is the caller's fault; anything else is an unknown epic.
    const badRequest = /^Abandon reason is/.test(message);
    return NextResponse.json(
      { error: badRequest ? message : "Epic not found" },
      { status: badRequest ? 400 : 404 },
    );
  }
}
