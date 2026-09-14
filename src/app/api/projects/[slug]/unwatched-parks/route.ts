import { NextResponse } from "next/server";

import { unwatchedParksForProject } from "@/lib/unwatched-parks";
import { withProject } from "../resolve-project";

export const dynamic = "force-dynamic";

/**
 * Parked work with nothing watching it (anton-kh98) — the board's poll of the read the page
 * server-renders.
 *
 * Both edges of this signal are events an open board has no other way to notice: a job parks from a
 * run happening outside this tab, and the watcher is armed from settings or from another tab. Held
 * at the first paint the band would either stay silent through the hours work was actually stopped,
 * or keep warning about a blind spot somebody already closed — the two false states it exists to end.
 *
 * `null` means there is nothing to report: the watcher is armed, or nothing is parked. A failure is
 * NOT flattened into that — these are two indexed local reads, so the caller keeps the band it has
 * rather than reading a blip as "somebody is watching".
 */
export const GET = withProject<{ slug: string }>(async (_request, { project }) => {
  return NextResponse.json({ parks: (await unwatchedParksForProject(project.id)) ?? null });
});
