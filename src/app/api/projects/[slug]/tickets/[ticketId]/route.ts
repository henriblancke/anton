import { NextResponse } from "next/server";
import { deleteTicket, getTicketDetail, updateTicket } from "@/lib/ticket-detail";
import { parseTicketPatch } from "@/lib/ticket-patch";
import { notFoundResponse, parseJsonBody, withProject } from "../../resolve-project";

export const dynamic = "force-dynamic";

export const GET = withProject<{ slug: string; ticketId: string }>(
  async (_request, { project, params }) => {
    try {
      const detail = await getTicketDetail(project, params.ticketId);
      return NextResponse.json({ detail });
    } catch {
      return notFoundResponse("Ticket not found");
    }
  },
);

export const PATCH = withProject<{ slug: string; ticketId: string }>(
  async (request, { project, params }) => {
    const { body, response: badBody } = await parseJsonBody(request);
    if (badBody) return badBody;

    const parsed = parseTicketPatch(body);
    if ("error" in parsed) {
      return NextResponse.json({ error: parsed.error }, { status: 400 });
    }

    try {
      const detail = await updateTicket(project, params.ticketId, parsed.patch);
      return NextResponse.json({ detail });
    } catch {
      return notFoundResponse("Ticket not found");
    }
  },
);

export const DELETE = withProject<{ slug: string; ticketId: string }>(
  async (_request, { project, params }) => {
    try {
      await deleteTicket(project, params.ticketId);
      return NextResponse.json({ ok: true });
    } catch {
      return notFoundResponse("Ticket not found");
    }
  },
);
