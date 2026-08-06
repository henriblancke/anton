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
 * `rankAttention` is deliberately fed NO escalations here: an escalation is answered inline on the
 * board (Resume/Dismiss/Abandon), never on this page, so folding one in would let an unrelated stall
 * decide whether this page calls hygiene-and-review "clean" — see {@link projectHealthFromBoard}. The
 * open count still reaches the page, but only as a number the right rail points back at the board
 * with, never as a row rendered here.
 */
import { rankAttention, type AttentionItem } from "./attention";
import { getBoard } from "./board";
import { openEscalations } from "./escalations";
import type { Board, HygieneReport, Project, ReviewTrajectory, ScanHealth } from "./types";

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
  /** Open, stopped escalations — answered on the board, named here only as a count. */
  stoppedCount: number;
}

/**
 * Pure composition over shapes the page already has read, so it's unit-testable against fabricated
 * board/escalation data without a database (see health.test.ts). {@link getProjectHealth} is the
 * thin async wrapper that feeds it real reads.
 */
export function projectHealthFromBoard(
  board: Pick<Board, "hygiene" | "scanHealth" | "reviewTrajectory">,
  stoppedCount: number,
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
    stoppedCount,
  };
}

/**
 * UI read path. Goes through {@link getBoard} rather than reading hygiene/scan-health directly, so a
 * failed anton.db read degrades to "never patrolled"/"never scanned" the same way the board itself
 * does (getBoard logs and returns undefined) instead of taking this page down with it. The board read
 * and the escalation read are independent, so they run concurrently.
 */
export async function getProjectHealth(project: Project): Promise<ProjectHealth> {
  const [board, escalations] = await Promise.all([getBoard(project), openEscalations(project.id)]);
  return projectHealthFromBoard(board, escalations.length);
}
