/**
 * The since-you-looked READ, split out of events-since/route.ts (anton-rokar) so a Server Component
 * — the digest page — can read the exact same board snapshot and folded events the route serves,
 * without asking its own API route to do it over HTTP (the same "import the lib, don't fetch
 * yourself" discipline every other page here follows — see board.ts, health.ts).
 *
 * Split in two rather than kept as one function: the digest page also needs the RAW board snapshot
 * itself, for `operatorQueue`/`openProposals` (operator-queue.ts) and `digestFeatureGroups`
 * (digest/feature-cards-read.ts) — all three must judge the SAME snapshot the events were folded
 * from, or a feature's "last 5 events" could disagree with whether its run target still shows up in
 * the operator queue. {@link readDigestBoard} is the one board read; {@link readTimelineEventsForBoard}
 * folds it. {@link readTimelineEvents} composes both for a caller (the events-since route) that only
 * wants the events.
 */
import { readAllIssues, refreshAllIssues } from "./beads/issues";
import type { Bead } from "./beads/bd";
import { foldTimeline, type TimelineEvent } from "./timeline";
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
} from "./timeline-sources";
import type { AntonDb } from "./jobs/queue";
import type { Project } from "./types";

export type { TimelineWindow } from "./timeline-sources";

/**
 * The bd board snapshot a since-you-looked read judges events against.
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
 * is otherwise single-flight and loader-blind — if a refresh was already running when the caller
 * minted its `until`, a plain call here would join THAT read instead of starting its own. If the
 * in-flight read had snapshotted the board before a bead closed but the closure landed before the
 * caller's `until`, the response would omit the closure while still handing out a cursor that
 * permanently strands it once marked seen. `requireFreshRead` waits out any in-flight read first,
 * then always starts a new one — guaranteeing this call's own board read began no earlier than the
 * `until` the caller already minted.
 */
export function readDigestBoard(project: Pick<Project, "repoPath">): Promise<Bead[]> {
  return refreshAllIssues(project.repoPath, { strictGates: true, requireFreshRead: true });
}

/**
 * The CACHED counterpart to {@link readDigestBoard} — the same stale-while-revalidate snapshot
 * `getBoard` itself reads (`readAllIssues`, not `refreshAllIssues`), for a caller that commits no
 * cursor and so has none of the staleness risk the doc above guards against. Gates come back
 * best-effort, not strict — `readAllIssues` has no strict-gate option to give it, the same as
 * `getBoard`'s own call.
 *
 * `projectDigestSummary` (the board banner's read, PR #350 review) is the one caller: it hands out
 * no `until` for a client to post back as seen, so there is no cursor a stale snapshot or a
 * degraded gate listing could silently strand. Paying for `readDigestBoard`'s forced fresh `bd`
 * rescan there bought nothing — it only doubled the subprocess cost of every board page load, on
 * top of `getBoard`'s own read of the same underlying snapshot.
 */
export async function readDigestBoardCached(project: Pick<Project, "repoPath">): Promise<Bead[]> {
  return (await readAllIssues(project.repoPath)).beads;
}

/**
 * Every event in `window`, off `board` plus each anton.db source. The board is shared across every
 * bd-derived row (readProposalRows, readBeadBoardRows) and `foldTimeline`'s own feature resolution —
 * the same one-read-per-request contract operator-queue.ts and feature-ledger.ts hold.
 *
 * `readRunRows` and `readEscalationRows` widen their SQL seek with an OR against `updatedAt` (see
 * the module header on timeline-sources.ts), which can hand back a row whose OWN `startedAt`/
 * `raisedAt` sits outside `window` — fetched only because its lifecycle's other half landed inside
 * it. `foldTimeline` has no window to filter against (it's pure over rows, by design), so the final
 * filter here is what turns that overfetch back into exactly the events `[since, until)` asked for.
 */
export async function readTimelineEventsForBoard(
  db: AntonDb,
  project: Pick<Project, "id">,
  window: TimelineWindow,
  board: Bead[],
): Promise<TimelineEvent[]> {
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

/**
 * {@link readDigestBoard} plus {@link readTimelineEventsForBoard} for a caller that only wants the
 * events — the events-since route's own shape, kept as a single call so it reads exactly as it did
 * before this module existed.
 *
 * Propagates a `bd` failure rather than degrading to an empty board: the bd-derived rows are not an
 * enhancement to a DB-only timeline, they're entire event categories (proposals, bead closes, PR
 * merges) with no other source, and a caller minting a postable cursor must not hand one out over a
 * read that silently dropped all of them.
 */
export async function readTimelineEvents(
  db: AntonDb,
  project: Pick<Project, "id" | "repoPath">,
  window: TimelineWindow,
): Promise<TimelineEvent[]> {
  const board = await readDigestBoard(project);
  return readTimelineEventsForBoard(db, project, window, board);
}
