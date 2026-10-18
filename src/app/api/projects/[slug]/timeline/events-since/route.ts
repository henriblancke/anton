import { NextResponse } from "next/server";
import { z } from "zod";

import { refreshAllIssues } from "@/lib/beads/issues";
import { getDb } from "@/lib/db";
import type { AntonDb } from "@/lib/jobs/queue";
import { systemClock } from "@/lib/jobs/queue";
import { foldTimeline, type TimelineEvent } from "@/lib/timeline";
import {
  readAutopilotDisarmRows,
  readBeadBoardRows,
  readEscalationRows,
  readPickerStartRows,
  readPickerVerdictRows,
  readProposalRows,
  readRunAttemptRows,
  readRunRows,
  readScanSummaryRows,
  type TimelineWindow,
} from "@/lib/timeline-sources";
import type { Project } from "@/lib/types";
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
  // `since` only widens the read BACKWARD — past the stored mark, never ahead of it. A `since`
  // beyond the watermark would read `[since, until)` while still handing back `until` as the next
  // postable cursor, so marking it seen would advance the watermark straight past `[mark, since)`
  // without ever returning those events, stranding them permanently.
  if (parsed.data.since !== undefined && mark && parsed.data.since > mark.seenAt) {
    return NextResponse.json(
      {
        error:
          `since (${parsed.data.since}) is ahead of the stored watermark (${mark.seenAt}) — ` +
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

/**
 * Every event in `window`, off the project's bd board snapshot plus each anton.db source. The board
 * is read once and reused for both the bd-derived rows (readProposalRows, readBeadBoardRows) and
 * `foldTimeline`'s own feature resolution — the same one-read-per-request contract operator-queue.ts
 * and feature-ledger.ts hold.
 *
 * Propagates a `bd` failure rather than degrading to an empty board: the bd-derived rows are not an
 * enhancement to a DB-only timeline, they're entire event categories (proposals, bead closes, PR
 * merges) with no other source, and the caller above refuses to hand out a cursor an operator could
 * mark seen over a read that silently dropped all of them.
 *
 * Reads via `refreshAllIssues`, not `allIssues` (PR #346 review, P1): `allIssues` serves the
 * retained stale-while-revalidate snapshot (up to `ISSUE_SNAPSHOT_MAX_AGE_MS` old) and only
 * refreshes in the background, so a bead closed after that snapshot was cached but before this
 * request's `until` would be omitted here and then permanently stranded below the watermark once
 * the client marks `until` seen. `strictGates: true` for the same cursor-safety reason (PR #346
 * review, P1): a degraded gate listing would let `prActuallyMerged` read a merge-wait gate as
 * absent and silently suppress a `pr.merged` event behind that same irreversible cursor.
 *
 * `requireFreshRead: true` for the same reason again (PR #346 review, round 2): `refreshAllIssues`
 * is otherwise single-flight and loader-blind — if a refresh was already running when this request
 * minted `until` above, a plain call here would join THAT read instead of starting its own. If the
 * in-flight read had snapshotted the board before a bead closed but the closure landed before this
 * request's `until`, the response would omit the closure while still handing out a cursor that
 * permanently strands it once marked seen. `requireFreshRead` waits out any in-flight read first,
 * then always starts a new one — guaranteeing this call's own board read began no earlier than the
 * `until` minted above.
 *
 * `readRunRows` and `readEscalationRows` widen their SQL seek with an OR against `updatedAt` (see
 * the module header on timeline-sources.ts), which can hand back a row whose OWN `startedAt`/
 * `raisedAt` sits outside `window` — fetched only because its lifecycle's other half landed inside
 * it. `foldTimeline` has no window to filter against (it's pure over rows, by design), so the final
 * filter here is what turns that overfetch back into exactly the events `[since, until)` asked for.
 */
async function readTimelineEvents(
  db: AntonDb,
  project: Pick<Project, "id" | "repoPath">,
  window: TimelineWindow,
): Promise<TimelineEvent[]> {
  const board = await refreshAllIssues(project.repoPath, {
    strictGates: true,
    requireFreshRead: true,
  });

  const [
    runRows,
    runAttemptRows,
    escalationRows,
    pickerStartRows,
    pickerVerdictRows,
    autopilotDisarmRows,
    scanSummaryRows,
  ] = await Promise.all([
    readRunRows(db, project.id, window, board),
    readRunAttemptRows(db, project.id, window),
    readEscalationRows(db, project.id, window),
    readPickerStartRows(db, project.id, window),
    readPickerVerdictRows(db, project.id, window),
    readAutopilotDisarmRows(db, project.id, window),
    readScanSummaryRows(db, project.id, window),
  ]);

  const proposalRows = readProposalRows(board, project.id, window);
  const { closed: beadClosedRows, merged: prMergedRows } = readBeadBoardRows(
    board,
    project.id,
    window,
  );

  const events = foldTimeline(
    [
      ...runRows,
      ...runAttemptRows,
      ...escalationRows,
      ...pickerStartRows,
      ...pickerVerdictRows,
      ...autopilotDisarmRows,
      ...scanSummaryRows,
      ...proposalRows,
      ...beadClosedRows,
      ...prMergedRows,
    ],
    board,
  );
  return events.filter((e) => e.at >= window.since && e.at < window.until);
}
