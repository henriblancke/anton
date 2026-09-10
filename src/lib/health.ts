/**
 * The Health page's data (anton-4qf3 split): everything the board's old attention strip carried until
 * it was cut down to escalations alone (`EscalationStrip`) — hygiene's attention/housekeeping
 * findings, the worst review score, the patrol's applied actions, and the codebase scan trend —
 * assembled for the read-only report at `/projects/[slug]/health`.
 *
 * This composes {@link getBoard}'s existing reads and {@link openEscalations} rather than re-deriving
 * anything: bead filtering and the epic/card assembly stay owned by lib/board.ts, severity and order
 * stay owned by {@link rankAttention} (lib/attention.ts), and the trend math stays owned by
 * lib/review-trajectory.ts and lib/scan-health.ts. This module only decides what a page needs out of
 * what those already computed.
 *
 * Since anton-7gxs this page ALSO owns the alerts themselves — every open escalation with its
 * Resume/Dismiss/Abandon buttons, the autopilot breaker's evidence, and the unwatched-park warning.
 * They used to be three bands above the board; a burst of identical failures could push the columns
 * off the screen, so the board keeps a one-line summary and the rows come here, where a page is
 * allowed to be as long as the trouble is.
 *
 * `rankAttention` is still deliberately fed NO escalations: it decides whether this page calls
 * hygiene-and-review "clean", and a stopped run is a different claim about a different thing — one
 * upstream outage should not make the codebase look unhealthy, nor a clean codebase hide a stall.
 * The escalations travel beside its output, never through it (see {@link projectHealthFromBoard}).
 */
import { rankAttention, type AttentionItem } from "./attention";
import { currentBreaker } from "./autopilot-state";
import type { AutopilotBreaker } from "./autopilot-breaker";
import { getBoard } from "./board";
import { serverBuildDrifts, type ServerDrift } from "./build/drift";
import { dismissedEscalations, openEscalations } from "./escalations";
import { unwatchedParksForProject } from "./unwatched-parks";
import { PICKER_LOG_LIMIT, pickerLogEntries, type PickerLogEntry } from "./picker-log";
import { latestPickerStarts, type PickerStartRow } from "./picker-starts";
import { latestPickerDeclines, type PickerVerdictRow } from "./picker-veto";
import type {
  Board,
  EscalationView,
  HygieneReport,
  Project,
  ReviewTrajectory,
  ScanHealth,
  UnwatchedParks,
} from "./types";

export interface ProjectHealth {
  /** `attention`-severity items: hygiene's dep-cycle/stale-in-progress findings, and the worst
   * review-score target when it lands in the rework band. Worst first — `rankAttention`'s order. */
  worthALook: AttentionItem[];
  /** `housekeeping`-severity hygiene findings, folded behind the page's own disclosure. */
  housekeeping: AttentionItem[];
  /** The gardener's latest patrol, or undefined for a project that has never been patrolled. */
  hygiene: HygieneReport | undefined;
  /** The stringer trend, or undefined for a project that has never been scanned. */
  scanHealth: ScanHealth | undefined;
  /** Recent review scores, or undefined for a project nothing has ever scored. */
  trajectory: ReviewTrajectory | undefined;
  /**
   * How many alerts are open — the number the rail prints and the board's strip counts. The rows
   * themselves are `escalations` below; this is kept as its own field because most of the page only
   * ever asks "how much", and deriving it at each call site invites the two disagreeing.
   */
  stoppedCount: number;
  /**
   * Every open escalation, in full, with the evidence each one's decision is made on (anton-7gxs).
   * This is the list the board's strip only counts.
   */
  escalations: EscalationView[];
  /**
   * Alerts a human put down, newest first — the undo list for a durable dismissal. One page of them
   * (see {@link listDismissedEscalations}); `dismissedTotal` says how many there are in all, and the
   * section pages to the rest. This is a record of decisions, not a queue.
   */
  dismissed: EscalationView[];
  /**
   * How many alerts are dismissed in total — every one an active suppression, and so every one
   * something the operator must be able to reach and restore. Larger than `dismissed.length`
   * whenever there is an older page.
   */
  dismissedTotal: number;
  /**
   * Why the autopilot has stopped, if it has, with the evidence a re-arm is judged on. Undefined
   * while it is running.
   */
  breaker: AutopilotBreaker | undefined;
  /**
   * Parked work nothing is watching. Undefined — and so silent — when the watcher is armed or
   * nothing is parked; its presence IS the signal (see lib/unwatched-parks.ts).
   */
  parks: UnwatchedParks | undefined;
  /**
   * What the picker started unattended and what the operator vetoed, newest first (R3.10). Empty
   * for a project whose picker has never started anything and whose picks nobody has refused —
   * which the applied section reports by saying nothing, not by drawing an empty log.
   */
  pickerLog: PickerLogEntry[];
  /**
   * Every server of this install running something other than the code on disk (anton-pzfb), empty
   * when they all match. Not a property of this project at all — these are the processes every
   * project's jobs run under, which is exactly why they belong here: a nightly degraded by a stale
   * build shows up as this page's findings, so this page is where the reason has to be legible
   * without a CLI. One entry per process, because an install can run a UI-only server beside the
   * one executing the jobs and only the second explains a degraded nightly.
   */
  staleServers: ServerDrift[];
}

/**
 * Pure composition over shapes the page already has read, so it's unit-testable against fabricated
 * board/escalation data without a database (see health.test.ts). {@link getProjectHealth} is the
 * thin async wrapper that feeds it real reads.
 */
export function projectHealthFromBoard(
  board: Pick<Board, "hygiene" | "scanHealth" | "reviewTrajectory">,
  alerts: HealthAlerts,
  staleServers: ServerDrift[] = [],
  picker: { starts: PickerStartRow[]; verdicts: PickerVerdictRow[] } = { starts: [], verdicts: [] },
): ProjectHealth {
  const { items, housekeeping } = rankAttention({
    hygiene: board.hygiene,
    trajectory: board.reviewTrajectory,
  });
  return {
    worthALook: items,
    housekeeping,
    hygiene: board.hygiene,
    scanHealth: board.scanHealth,
    trajectory: board.reviewTrajectory,
    stoppedCount: alerts.escalations.length,
    escalations: alerts.escalations,
    dismissed: alerts.dismissed,
    dismissedTotal: alerts.dismissedTotal ?? alerts.dismissed.length,
    breaker: alerts.breaker,
    parks: alerts.parks,
    pickerLog: pickerLogEntries(picker),
    staleServers,
  };
}

/**
 * The four alert reads this page now owns, passed as one bag rather than four positional arguments.
 * They arrive together, they are all about "what has stopped", and a fifth positional `undefined`
 * in a call site is exactly how the wrong one gets passed.
 */
export interface HealthAlerts {
  escalations: EscalationView[];
  dismissed: EscalationView[];
  /** Total dismissed rows, not just the page in `dismissed`. Defaults to the page's own length. */
  dismissedTotal?: number;
  breaker?: AutopilotBreaker;
  parks?: UnwatchedParks;
}

/**
 * UI read path. Goes through {@link getBoard} rather than reading hygiene/scan-health directly, so a
 * failed anton.db read degrades to "never patrolled"/"never scanned" the same way the board itself
 * does (getBoard logs and returns undefined) instead of taking this page down with it. The board
 * read, the escalation read, the build-drift read and the picker's two records are independent, so
 * they run concurrently.
 */
export async function getProjectHealth(project: Project): Promise<ProjectHealth> {
  // Read the running builds live rather than from a stored report: which build is running is a fact
  // about this instant, and a patrol row written by a since-restarted process would report drift
  // that no longer exists.
  const [board, escalations, dismissed, breaker, parks, staleServers, starts, verdicts] =
    await Promise.all([
      getBoard(project),
      openEscalations(project.id),
      dismissedEscalations(project.id),
      // Degrades to "no band" rather than failing the page, exactly as the board does: deciding the
      // WIP hold spawns a `gh pr view` per in-review PR, so an unreachable GitHub must cost the
      // breaker band and nothing else. The board is the page's subject; this is context beside it.
      currentBreaker(project).catch((err) => {
        console.error(`[health] autopilot breaker read failed for ${project.slug}`, err);
        return undefined;
      }),
      unwatchedParksForProject(project.id),
      // Degrades to "no stale servers" like every other read here: drift detection shells out to the
      // process table, and a transient failure there must not take the page down.
      serverBuildDrifts().catch(() => [] as ServerDrift[]),
      latestPickerStarts(project.id),
      // Declines only, and no more of them than the log can show: the merge below keeps the newest
      // PICKER_LOG_LIMIT entries across both stores, so a wider read would only fetch rows it drops.
      latestPickerDeclines(project.id, PICKER_LOG_LIMIT),
    ]);
  return projectHealthFromBoard(
    board,
    { escalations, dismissed: dismissed.rows, dismissedTotal: dismissed.total, breaker, parks },
    staleServers,
    { starts, verdicts },
  );
}
