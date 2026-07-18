import { NextResponse } from "next/server";
import { deleteTicket, getTicketDetail, updateTicket } from "@/lib/ticket-detail";
import { parseTicketPatch } from "@/lib/ticket-patch";
import { resolveProject } from "../../resolve-project";

export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ slug: string; ticketId: string }> },
) {
  const { slug, ticketId } = await params;
  const { project, response } = await resolveProject(slug);
  if (!project) return response;

  try {
    const detail = await getTicketDetail(project, ticketId);
    return NextResponse.json({ detail });
  } catch {
    return NextResponse.json({ error: "Ticket not found" }, { status: 404 });
  }
}

export async function PATCH(
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

  const parsed = parseTicketPatch(body);
  if ("error" in parsed) {
    return NextResponse.json({ error: parsed.error }, { status: 400 });
  }

  try {
    const detail = await updateTicket(project, ticketId, parsed.patch);
    return NextResponse.json({ detail });
  } catch {
    return NextResponse.json({ error: "Ticket not found" }, { status: 404 });
  }
}

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ slug: string; ticketId: string }> },
) {
  const { slug, ticketId } = await params;
  const { project, response } = await resolveProject(slug);
  if (!project) return response;

  try {
    await deleteTicket(project, ticketId);
    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json({ error: "Ticket not found" }, { status: 404 });
  }
}
