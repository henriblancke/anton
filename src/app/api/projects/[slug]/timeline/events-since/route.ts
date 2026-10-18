import { NextResponse } from "next/server";
import { z } from "zod";

import { allIssues } from "@/lib/beads/issues";
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
 * events landing mid-read are not marked as seen before anyone sees them.
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
  const since = parsed.data.since ?? mark?.seenAt ?? null;
  const until = Math.floor(systemClock.now() / 1000);

  const events = await readTimelineEvents(db, project, { since: since ?? 0, until });

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
 * Fails soft to an empty board on a `bd` error: a timeline that cannot resolve features is still
 * worth showing, degraded to `featureId: null` everywhere, rather than failing the whole read.
 */
async function readTimelineEvents(
  db: AntonDb,
  project: Pick<Project, "id" | "repoPath">,
  window: TimelineWindow,
): Promise<TimelineEvent[]> {
  const board = await allIssues(project.repoPath).catch(() => []);

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

  return foldTimeline(
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
}
