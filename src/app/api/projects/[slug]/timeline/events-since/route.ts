import { NextResponse } from "next/server";
import { z } from "zod";

import { getDb } from "@/lib/db";
import { systemClock } from "@/lib/jobs/queue";
import { DEFAULT_VIEWER_ID, getViewerMark } from "@/lib/viewer-marks";
import { withProject } from "../../resolve-project";

export const dynamic = "force-dynamic";

const querySchema = z.object({
  /**
   * Look further back than the watermark without disturbing it — "show me yesterday again". Epoch
   * seconds; absent means "since I last looked".
   */
  since: z.coerce.number().int().min(0).optional(),
});

/**
 * The since-you-looked WINDOW for one project (anton-z8j4q): where a timeline read starts, and the
 * instant it is current as of.
 *
 * The window is resolved server-side rather than by the client, because its lower bound is stored
 * state — the viewer's watermark — and its upper bound must come from the same clock the mark-seen
 * write stamps. A client deriving `until` from its own clock would mark seen past events it was
 * never shown whenever the two drift.
 *
 * `since: null` is "has never looked", and means the whole history rather than nothing — a project
 * that predates the watermark table has no row, and showing such an operator an empty timeline
 * would be the silence this feature exists to end.
 *
 * `until` is what a caller posts back to mark-seen: it names exactly the window it was handed, so
 * events landing mid-read are not marked as seen before anyone sees them.
 *
 * The events themselves are deliberately not folded here — the event model and the per-source
 * readers are their own beads (anton-uxgze, anton-4ldxk) and they fold over this window. This route
 * owns only the boundary, which is the half that needs the stored mark.
 */
export const GET = withProject<{ slug: string }>(async (request, { project }) => {
  const parsed = querySchema.safeParse(
    Object.fromEntries(new URL(request.url).searchParams.entries()),
  );
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Expected since to be epoch seconds (a non-negative integer)" },
      { status: 400 },
    );
  }

  const mark = await getViewerMark(getDb(), project.id);
  const since = parsed.data.since ?? mark?.seenAt ?? null;

  return NextResponse.json({
    viewerId: DEFAULT_VIEWER_ID,
    since,
    until: Math.floor(systemClock.now() / 1000),
    mark: mark ?? null,
  });
});
