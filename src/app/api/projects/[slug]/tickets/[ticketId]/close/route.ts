import { NextResponse } from "next/server";
import { closeHumanTicket, NotCloseableError } from "@/lib/close-human";
import { resolveProject } from "../../../resolve-project";

export const dynamic = "force-dynamic";

/**
 * Mark an `agent:human` ticket done (anton-fgqr) — the operator's control for the one kind of work
 * no run ever closes (a human target is poisoned before dispatch, execute-epic-human-gate.ts). Until
 * now the operator queue only named the `bd close` CLI (PR #214); this replaces that with a route. A
 * sub-resource POST for the same reason abandon is: settling an outcome, not editing a field.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ slug: string; ticketId: string }> },
) {
  const { slug, ticketId } = await params;
  const { project, response } = await resolveProject(slug);
  if (!project) return response;

  try {
    const detail = await closeHumanTicket(project, ticketId);
    return NextResponse.json({ detail });
  } catch (err) {
    if (err instanceof NotCloseableError) {
      return NextResponse.json({ error: err.message }, { status: 409 });
    }
    return NextResponse.json({ error: "Ticket not found" }, { status: 404 });
  }
}
