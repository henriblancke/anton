import { NextResponse } from "next/server";
import { z } from "zod";

import { getDb } from "@/lib/db";
import { systemClock } from "@/lib/jobs/queue";
import type { TimelineEvent } from "@/lib/timeline";
import { readTimelineEvents } from "@/lib/timeline-read";
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
 * events landing mid-read are not marked as seen before anyone sees them. The window handed to the
 * readers is `[since, until)` — `until` itself excluded — so an event timestamped exactly `until`
 * is deferred to the NEXT read (whose `since` is this `until`, inclusive) rather than shown twice;
 * see the window-semantics note on timeline-sources.ts.
 *
 * The events themselves are folded by `foldTimeline` (anton-uxgze) over rows this route collects
 * from the per-source readers (anton-4ldxk), one bd board read shared across the bd-derived readers
 * and the feature resolution `foldTimeline` does for every event.
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

  const db = getDb();
  const mark = await getViewerMark(db, project.id);
  // `since` only widens the read BACKWARD — past the stored mark, never ahead of it. An unmarked
  // viewer's implicit mark is 0 (its default window is all history), not "no bound" — an explicit
  // `since` ahead of 0 is still ahead of the mark and would read `[since, until)` while still
  // handing back `until` as the next postable cursor, so a first mark-seen at `until` would strand
  // `[0, since)` permanently. Comparing against `mark?.seenAt ?? 0` catches that case the same way
  // it catches a stored mark.
  const markSeenAt = mark?.seenAt ?? 0;
  if (parsed.data.since !== undefined && parsed.data.since > markSeenAt) {
    return NextResponse.json(
      {
        error:
          `since (${parsed.data.since}) is ahead of the stored watermark (${markSeenAt}) — ` +
          `since can only look further back than the mark, never past it`,
      },
      { status: 400 },
    );
  }
  const since = parsed.data.since ?? mark?.seenAt ?? null;
  const until = Math.floor(systemClock.now() / 1000);

  let events: TimelineEvent[];
  try {
    events = await readTimelineEvents(db, project, { since: since ?? 0, until });
  } catch (err) {
    // A client that marks THIS `until` seen would bury every event this read could not resolve
    // (proposals, bead closes, PR merges all come off the bd board snapshot) permanently behind an
    // irreversible watermark — failing the request keeps `until` un-postable instead.
    return NextResponse.json(
      { error: `Failed to read project board: ${(err as Error).message}` },
      { status: 502 },
    );
  }

  return NextResponse.json({
    viewerId: DEFAULT_VIEWER_ID,
    since,
    until,
    mark: mark ?? null,
    events,
  });
});
