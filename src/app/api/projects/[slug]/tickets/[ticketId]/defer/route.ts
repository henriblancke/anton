import { NextResponse } from "next/server";
import { setTicketDeferred } from "@/lib/ticket-detail";
import { resolveProject } from "../../../resolve-project";

export const dynamic = "force-dynamic";

/**
 * Snooze a ticket (anton-ywi8): POST defers it (out of `bd ready`, so the runtime stops seeing it),
 * DELETE undefers it. Modelled as a sub-resource rather than a status patch because deferring is a
 * queue decision, not a field edit — and because bd owns the transition (`bd defer`/`bd undefer`).
 * Both return the refreshed detail so the dialog and board card can re-render without a refetch.
 */
async function setDeferred(
  slug: string,
  ticketId: string,
  deferred: boolean,
): Promise<NextResponse> {
  const { project, response } = await resolveProject(slug);
  if (!project) return response;

  try {
    const detail = await setTicketDeferred(project, ticketId, deferred);
    return NextResponse.json({ detail });
  } catch {
    return NextResponse.json({ error: "Ticket not found" }, { status: 404 });
  }
}

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ slug: string; ticketId: string }> },
) {
  const { slug, ticketId } = await params;
  return setDeferred(slug, ticketId, true);
}

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ slug: string; ticketId: string }> },
) {
  const { slug, ticketId } = await params;
  return setDeferred(slug, ticketId, false);
}
