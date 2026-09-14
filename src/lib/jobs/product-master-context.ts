/**
 * What the product-master session is handed to judge (anton-l4do): the board it just read, the runs
 * behind it, and the review-score history the board line alone cannot show.
 *
 * Split out of product-master.ts because assembling the evidence and running the judgment are
 * different jobs with different failure modes — everything here is best-effort per bead, while the
 * pass around it fails loud.
 */
import { beads, type Bead } from "../beads/bd";
import { isOpenWork, stampMsOf } from "../gardener/board-index";
import { MAX_RUNS, type PmBoardInput } from "../pm/context";
import { reviewReportOf } from "../review-report";
import { listRecentRuns } from "../runs";
import { reviewScoreOf } from "../ticket-view";
import { messageOf, type PassScope } from "./pass-preamble";
import type { AntonDb } from "./queue";

/**
 * How many reviewed run targets get their score SERIES hydrated. The `review-score:<n>` label on
 * every bead is free (it rides the board read); the round-by-round history behind it is one `bd show
 * --include-comments` each, and that series is the pass's strongest evidence — "three reviews at 4,
 * 3, 2" is a case, "currently 2" is a snapshot. Bounded because a board with a hundred reviewed
 * targets would otherwise cost a hundred bd spawns per pass; the most recently written are taken
 * first, which is where the judgment usually is.
 */
export const MAX_HYDRATED_SCORE_SERIES = 15;

export interface BoardInputRequest {
  db: AntonDb;
  board: Bead[];
  /** The premise fence — the stamp of the read the session judges, not a fresh clock. */
  observedAtMs: number;
}

/** Everything the prompt renders, gathered around the board snapshot the pass already holds. */
export async function collectBoardInput(
  scope: PassScope,
  input: BoardInputRequest,
): Promise<PmBoardInput> {
  const { db, board, observedAtMs } = input;
  return {
    board,
    scores: await scoreSeries(scope, board),
    runs: await listRecentRuns(db, scope.project.id, MAX_RUNS),
    now: observedAtMs,
  };
}

/**
 * The per-bead review-score series, hydrated for the most recently written reviewed targets.
 *
 * Best-effort per bead: a comment thread that will not load costs that bead its history, not the
 * pass its judgment — the label-derived score is still on the board line either way. Returns
 * undefined for a board with nothing reviewed, so the context renders no series rather than an empty
 * one (a bead with no reviews and a bead that scored nothing are opposite claims).
 */
async function scoreSeries(
  scope: PassScope,
  board: Bead[],
): Promise<Map<string, number[]> | undefined> {
  // Open work only: the board context renders scores for open, non-proposal beads, so a closed or
  // abandoned bead that carries a `review-score:` label would spend one of the cap's bd spawns on a
  // series the session never sees — and push an open bead's history out of the window to do it.
  const reviewed = board
    .filter((b) => isOpenWork(b) && reviewScoreOf(b) !== undefined)
    .sort((a, b) => (stampMsOf(b) ?? 0) - (stampMsOf(a) ?? 0))
    .slice(0, MAX_HYDRATED_SCORE_SERIES);
  if (reviewed.length === 0) return undefined;

  const series = new Map<string, number[]>();
  for (const bead of reviewed) {
    try {
      const show = await beads.showWithComments(scope.project.repoPath, bead.id);
      const rounds = reviewReportOf(show).rounds;
      const scores = rounds.flatMap((r) => (r.score === undefined ? [] : [r.score]));
      // Fall back to the label when the thread carries no readable round: the latest score is still
      // real evidence, and an empty series would read as "never reviewed".
      series.set(bead.id, scores.length > 0 ? scores : [reviewScoreOf(bead) as number]);
    } catch (e) {
      await scope.log(
        `[product-master] WARNING: could not read ${bead.id}'s review history — ${messageOf(e)}\n`,
      );
      console.warn(`[product-master] ${scope.slug}: could not read ${bead.id}'s review history`);
      series.set(bead.id, [reviewScoreOf(bead) as number]);
    }
  }
  return series;
}
