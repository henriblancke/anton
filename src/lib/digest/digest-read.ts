/**
 * The digest page's own read (anton-rokar): one project's since-you-looked window, assembled into
 * exactly what the page renders — the needs-you summary (anton-16s0t) and the feature cards grouped
 * by outcome (anton-y1uxp) — off ONE shared bd board snapshot ({@link readDigestBoard}), so a
 * feature's own events, its place in the operator queue, and its open proposals all judge the same
 * board state.
 *
 * The window itself always answers "since I last looked" — `since` is the viewer's own watermark,
 * never an explicit override — because the digest, unlike the raw events-since read it builds on,
 * has no "look further back" control of its own (out of scope for this ticket).
 */
import { digestNeedsYou, type DigestNeedsYouSummary } from "../attention";
import type { AutopilotBreaker } from "../autopilot-breaker";
import { currentBreaker } from "../autopilot-state";
import { openEscalations } from "../escalations";
import { systemClock } from "../jobs/queue";
import type { AntonDb } from "../jobs/queue";
import { operatorQueue, openProposals } from "../operator-queue";
import { readDigestBoard, readDigestBoardCached, readTimelineEventsForBoard } from "../timeline-read";
import type { Project } from "../types";
import { getViewerMark } from "../viewer-marks";
import { digestFeatureGroups } from "./feature-cards-read";
import type { DigestFeatureGroup } from "./feature-cards";
import { templateHeadline } from "./headline-template";

export interface ProjectDigest {
  /** The viewer's watermark this window started from — null means "has never looked". */
  since: number | null;
  /** This read's own upper bound — the exact instant to post back to mark-seen (anton-z8j4q). */
  until: number;
  /** The template one-liner over every event in the window (anton-qitea) — "No new activity" when
   * `since`..`until` held nothing, which {@link isEmpty} also keys off. */
  headline: string;
  needsYou: DigestNeedsYouSummary;
  /**
   * Whether the autopilot has stopped, streamed rather than resolved (PR #350 review): confirming a
   * WIP hold spawns a `gh pr view` per in-review PR, the same read the board already keeps off its
   * own critical path (see `(board)/page.tsx`). `needsYou` above is computed WITHOUT this — its
   * `breaker` count is always 0 here — so the page can decide `isEmpty` and paint the headline and
   * feature cards without waiting on GitHub; the breaker-derived needs-you row is unwrapped inside
   * its own Suspense boundary by `DigestNeedsYouHost`.
   */
  breaker: Promise<AutopilotBreaker | undefined>;
  /** `events.length` for this window — the board banner's "N things since you looked" (anton-16s0t). */
  activityCount: number;
  groups: DigestFeatureGroup[];
  /** Nothing happened AND nothing needs the operator — the page's empty-window state. */
  isEmpty: boolean;
}

/** `needsYou` plus the activity count — everything the board's digest banner needs (anton-16s0t). */
export interface DigestBoardSummary {
  needsYou: DigestNeedsYouSummary;
  activityCount: number;
}

/**
 * The since-you-looked window shared by {@link projectDigest} and {@link projectDigestSummary}: the
 * viewer's watermark, the board snapshot every bd-derived source judges against, the folded events,
 * and the needs-you queue off that same board.
 *
 * `escalations` and `breaker` read the same way the board page already does (see `(board)/page.tsx`)
 * — `breaker` is awaited here rather than streamed, because `digestNeedsYou` takes a resolved
 * `AutopilotBreaker`, not a promise: the digest is a single load, not a polled surface, so there is
 * no streaming boundary worth adding. A `gh pr view` failure degrades to no breaker rather than
 * failing the read, the same resilience the board gives it.
 *
 * Unwatched parks are deliberately NOT read here, unlike the board: {@link digestNeedsYou} has no
 * `parks` input at all (see attention.ts) — the digest's needs-you list only ever promotes a
 * disarmed breaker, a parked ask, a merge-ready PR, an open proposal, or an unblocked human ticket,
 * so a parks read here would pay for a signal nothing on this page shows.
 *
 * `freshBoard` (default true) picks {@link readDigestBoard}'s forced-fresh rescan vs
 * {@link readDigestBoardCached}'s stale-while-revalidate read. Only {@link projectDigest} needs the
 * fresh guarantee — it hands `until` back to the client as a cursor to post on mark-seen, and a
 * stale board here could omit a closure that then gets permanently stranded below the watermark.
 * {@link projectDigestSummary} commits no such cursor (PR #350 review), so it passes `false` and
 * joins the same cached snapshot `getBoard` already reads, instead of doubling the board page's
 * `bd` subprocess cost for a display-only count.
 *
 * `streamBreaker` (default false) keeps the breaker read OUT of the `needsYou` folded here, handing
 * it back unresolved instead (PR #350 review): only {@link projectDigest} streams it — it is the one
 * caller whose page awaits this window directly, so an unreachable or slow GitHub would otherwise
 * gate the headline and feature cards behind a check that is, at most, one optional row on the
 * page. {@link projectDigestSummary} leaves it false: the board page never awaits that call either
 * (it hands the whole thing down as a promise, same as this window's `breaker` would be), so there
 * is nothing to protect by deferring it twice, and its `needsYou.counts.breaker` must stay accurate
 * for the "autopilot stopped" chip on `DigestBanner` (board/attention-strip.tsx).
 *
 * `breaker` (optional) reuses an ALREADY-STARTED breaker read instead of starting a new one
 * (PR #350 review): the board page starts its own `currentBreaker` read for the attention strip
 * before calling {@link projectDigestSummary}, and `currentWipHold` inside that read can spawn a
 * `gh pr view` per in-review PR — starting a second, independent read here would double that
 * CLI/network fan-out on every board load and risk the two reads observing different states.
 */
async function readDigestWindow(
  db: AntonDb,
  project: Project,
  opts: {
    freshBoard?: boolean;
    streamBreaker?: boolean;
    breaker?: Promise<AutopilotBreaker | undefined>;
  } = {},
) {
  const mark = await getViewerMark(db, project.id);
  const since = mark?.seenAt ?? null;
  const until = Math.floor(systemClock.now() / 1000);

  const breakerRead =
    opts.breaker ??
    currentBreaker(project).catch((err) => {
      console.error(`[digest] autopilot breaker read failed for ${project.slug}`, err);
      return undefined;
    });

  const [board, escalations, breaker] = await Promise.all([
    opts.freshBoard === false ? readDigestBoardCached(project) : readDigestBoard(project),
    openEscalations(project.id),
    opts.streamBreaker ? Promise.resolve(undefined) : breakerRead,
  ]);

  const events = await readTimelineEventsForBoard(db, project, { since: since ?? 0, until }, board);

  const needsYou = digestNeedsYou({
    escalations,
    breaker,
    operatorQueue: operatorQueue(board),
    proposals: openProposals(board),
  });

  return { since, until, board, events, needsYou, breaker: breakerRead };
}

/** One project's digest, for the page to render directly. */
export async function projectDigest(db: AntonDb, project: Project): Promise<ProjectDigest> {
  const { since, until, board, events, needsYou, breaker } = await readDigestWindow(db, project, {
    streamBreaker: true,
  });
  const groups = (await digestFeatureGroups(db, project.id, events, { board })) ?? [];

  return {
    since,
    until,
    headline: templateHeadline(events),
    needsYou,
    breaker,
    activityCount: events.length,
    groups,
    isEmpty: needsYou.total === 0 && events.length === 0,
  };
}

/**
 * The board banner's own read (anton-16s0t) — the SAME window {@link projectDigest} serves the page
 * from, minus the feature-card assembly (`digestFeatureGroups`) the banner never renders: that read
 * spawns a `bd show` per changed feature, a cost worth paying once for the digest page but not on
 * every board load. Reads the board via the cached snapshot (`freshBoard: false`), not a forced
 * rescan, for the same reason (PR #350 review): a display-only count commits no cursor.
 *
 * `breaker`, when passed, is the caller's own already-started breaker read — see
 * {@link readDigestWindow}'s `breaker` option. The board page always has one in flight for the
 * attention strip, so pass it here rather than letting this call start its own.
 */
export async function projectDigestSummary(
  db: AntonDb,
  project: Project,
  breaker?: Promise<AutopilotBreaker | undefined>,
): Promise<DigestBoardSummary> {
  const { events, needsYou } = await readDigestWindow(db, project, { freshBoard: false, breaker });
  return { needsYou, activityCount: events.length };
}
