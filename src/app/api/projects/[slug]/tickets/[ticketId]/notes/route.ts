import { NextResponse } from "next/server";
import { addTicketNote } from "@/lib/ticket-detail";
import { resolveOperator } from "@/lib/operator";
import { resolveProject } from "../../../resolve-project";

export const dynamic = "force-dynamic";

/**
 * Append a human note to a ticket (anton-bfy4) — the steering channel between the two gates. The
 * note is attributed to this instance's operator and returned as the refreshed history, so the
 * dialog renders the append without a second fetch. The executor reads it at dispatch; nothing
 * about the ticket's status or approval changes here.
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

  const text = (body as { text?: unknown })?.text;
  if (typeof text !== "string" || !text.trim()) {
    return NextResponse.json({ error: "Note text is required" }, { status: 400 });
  }

  // An unresolvable identity is not a reason to refuse a steer (unlike a claim, a note takes
  // nothing from anyone) — formatHumanNote falls back to a generic author.
  const author = (await resolveOperator()) ?? "";

  try {
    const notes = await addTicketNote(project, ticketId, text, author);
    return NextResponse.json({ notes });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to add note";
    // Only the note's own validation is the caller's fault; anything else is an unknown ticket.
    const badRequest = /^Note is (empty|too long)/.test(message);
    return NextResponse.json(
      { error: badRequest ? message : "Ticket not found" },
      { status: badRequest ? 400 : 404 },
    );
  }
}
