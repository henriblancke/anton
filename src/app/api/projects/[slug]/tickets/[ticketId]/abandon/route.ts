import { NextResponse } from "next/server";
import { abandonTicket, NotAbandonableError } from "@/lib/abandon";
import { resolveProject } from "../../../resolve-project";

export const dynamic = "force-dynamic";

/**
 * Abandon a ticket (anton-6xj0) — the won't-do outcome. Kills the run still executing it, closes
 * the bead with the required reason, and tags it `abandoned` so nothing downstream reads it as
 * shipped. A sub-resource POST rather than a status patch because abandoning is an outcome
 * decision with side effects (a killed job), not a field edit. Returns the refreshed detail so the
 * dialog and board card re-render without a refetch.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ slug: string; ticketId: string }> },
) {
  const { slug, ticketId } = await params;
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
    const detail = await abandonTicket(project, ticketId, reason);
    return NextResponse.json({ detail });
  } catch (err) {
    if (err instanceof NotAbandonableError) {
      return NextResponse.json({ error: err.message }, { status: 409 });
    }
    const message = err instanceof Error ? err.message : "Failed to abandon ticket";
    // Only the reason's own validation is the caller's fault; anything else is an unknown ticket.
    const badRequest = /^Abandon reason is/.test(message);
    return NextResponse.json(
      { error: badRequest ? message : "Ticket not found" },
      { status: badRequest ? 400 : 404 },
    );
  }
}
