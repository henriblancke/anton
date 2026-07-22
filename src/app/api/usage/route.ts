import { NextResponse } from "next/server";

import { getDisplayUsage } from "@/lib/claude/usage";

export const dynamic = "force-dynamic";

/**
 * Live Claude usage for the global nav pill (anton-1nc). Reads through a short-TTL server-side
 * cache so many page loads collapse to one upstream fetch. Fail-soft: when the pill is off, creds
 * are missing, or the endpoint is unavailable, the underlying read returns null and we answer
 * `204 No Content` — the pill hides itself rather than error a render. Uses the display read
 * (last-known-good fallback, anton-7mpv.1) so a background reader's transient blip never darkens it.
 */
export async function GET() {
  const usage = await getDisplayUsage();
  if (!usage) return new NextResponse(null, { status: 204 });
  return NextResponse.json(usage, {
    headers: { "Cache-Control": "private, max-age=30" },
  });
}
