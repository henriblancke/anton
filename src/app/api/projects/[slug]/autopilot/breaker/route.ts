import { NextResponse } from "next/server";

import { currentBreaker } from "@/lib/autopilot-state";
import { withProject } from "../../resolve-project";

export const dynamic = "force-dynamic";

/**
 * What has stopped this project's autopilot right now (anton-5c8h / R4.5) — the board's poll of the
 * same read the page server-renders.
 *
 * The band exists to promise a hold "releases itself when one PR merges or closes", and the event
 * that releases it happens somewhere else entirely: nothing on an open board changes when a PR
 * merges, so without a poll the promise is only kept for an operator who happens to reload.
 *
 * `null` means the autopilot is running. An error is NOT flattened to `null`: the read spawns `gh`
 * and reads the board, and answering a transient failure with "nothing is stopped" would clear a
 * live disarm off the screen. The caller keeps the band it has instead.
 */
export const GET = withProject<{ slug: string }>(async (_request, { project }) => {
  return NextResponse.json({ breaker: (await currentBreaker(project)) ?? null });
});
