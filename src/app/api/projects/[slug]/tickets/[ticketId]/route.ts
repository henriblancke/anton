import { NextResponse } from "next/server";
import { getProjectBySlug } from "@/lib/projects";
import { getTicketDetail, updateTicket } from "@/lib/ticket-detail";
import { parseTicketPatch } from "@/lib/ticket-patch";

export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ slug: string; ticketId: string }> },
) {
  const { slug, ticketId } = await params;
  const project = await getProjectBySlug(slug);
  if (!project) {
    return NextResponse.json({ error: "Project not found" }, { status: 404 });
  }

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
  const project = await getProjectBySlug(slug);
  if (!project) {
    return NextResponse.json({ error: "Project not found" }, { status: 404 });
  }

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
