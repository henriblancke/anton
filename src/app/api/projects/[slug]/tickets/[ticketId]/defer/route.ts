import { NextResponse } from "next/server";
import { setTicketDeferred } from "@/lib/ticket-detail";
import type { Project } from "@/lib/types";
import { notFoundResponse, withProject } from "../../../resolve-project";

export const dynamic = "force-dynamic";

/**
 * Snooze a ticket (anton-ywi8): POST defers it (out of `bd ready`, so the runtime stops seeing it),
 * DELETE undefers it. Modelled as a sub-resource rather than a status patch because deferring is a
 * queue decision, not a field edit — and because bd owns the transition (`bd defer`/`bd undefer`).
 * Both return the refreshed detail so the dialog and board card can re-render without a refetch.
 */
async function setDeferred(
  project: Project,
  ticketId: string,
  deferred: boolean,
): Promise<NextResponse> {
  try {
    const detail = await setTicketDeferred(project, ticketId, deferred);
    return NextResponse.json({ detail });
  } catch {
    return notFoundResponse("Ticket not found");
  }
}

export const POST = withProject<{ slug: string; ticketId: string }>(
  (_request, { project, params }) => setDeferred(project, params.ticketId, true),
);

export const DELETE = withProject<{ slug: string; ticketId: string }>(
  (_request, { project, params }) => setDeferred(project, params.ticketId, false),
);
