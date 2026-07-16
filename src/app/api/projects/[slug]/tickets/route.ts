import { NextResponse, type NextRequest } from "next/server";
import { getTickets } from "@/lib/tickets";
import type { TicketFilters } from "@/lib/types";
import { resolveProject } from "../resolve-project";

export const dynamic = "force-dynamic";

const FILTER_KEYS: (keyof TicketFilters)[] = [
  "agent",
  "risk",
  "size",
  "domain",
  "status",
  "type",
  "epic",
  "q",
];

function parseFilters(searchParams: URLSearchParams): TicketFilters {
  const filters: TicketFilters = {};
  for (const key of FILTER_KEYS) {
    const value = searchParams.get(key);
    if (value) filters[key] = value;
  }
  return filters;
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ slug: string }> },
) {
  const { slug } = await params;
  const { project, response } = await resolveProject(slug);
  if (!project) return response;

  const tickets = await getTickets(project, parseFilters(request.nextUrl.searchParams));
  return NextResponse.json({ tickets });
}
