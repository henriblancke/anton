/**
 * The project's review-score trajectory — where the work is TRENDING, not how one run went
 * (anton-tprv).
 *
 * A per-card score answers "was this good"; a founder deciding whether the loop is healthy needs
 * the other question: are recent runs holding up, and what is the worst thing that shipped lately.
 * Both are read straight off the `review-score:<n>` labels the board snapshot already carries, so
 * the trajectory costs no bd call — per card or otherwise.
 *
 * Recency is the bead's own last-write stamp, because the snapshot carries no per-score timestamp:
 * the round comments that do are on each target's hydrated thread, which is exactly the per-card
 * read this must not make. A stamp moved by an unrelated edit can therefore reorder the window; it
 * cannot invent a score, and the window is a trend indicator, not an audit trail.
 */
import type { Bead } from "./beads/types";
import { reviewScoreOf } from "./ticket-view";

/**
 * How many recently-scored run targets the trajectory averages over. Small on purpose: this is the
 * "how are we doing lately" number, and a mean over the project's whole history would take a month
 * of good runs to move.
 */
export const RECENT_SCORED_TARGETS = 8;

/** One run target's latest score, as the trajectory reports it. */
export interface ScoredTarget {
  id: string;
  title: string;
  /** The `review-score:<n>` label's value — always a real score; never a stand-in for "unreviewed". */
  score: number;
  /** bd's last-write stamp for the bead, when it carried one. */
  at?: string;
}

/** The project's recent review scores, rolled up. Only ever built from targets that WERE reviewed. */
export interface ReviewTrajectory {
  /** The most recently touched scored targets, newest first, capped at {@link RECENT_SCORED_TARGETS}. */
  recent: ScoredTarget[];
  /** Mean of `recent`, to one decimal. */
  average: number;
  /** The lowest-scoring target in `recent` — the one worth opening first. */
  worst: ScoredTarget;
  /** How many run targets on the whole board carry a score, so `recent` reads as the sample it is. */
  scored: number;
}

/**
 * The trajectory over every run target the board holds, or `undefined` when none was ever reviewed.
 *
 * Undefined rather than a zeroed shape: "no run has been scored yet" and "recent runs average 0"
 * are opposite claims about a project, and only one of them means something is wrong.
 */
export function reviewTrajectory(targets: Bead[]): ReviewTrajectory | undefined {
  const scored = targets.flatMap((bead): ScoredTarget[] => {
    const score = reviewScoreOf(bead);
    if (score === undefined) return [];
    const at = stampOf(bead);
    return [{ id: bead.id, title: bead.title, score, ...(at ? { at } : {}) }];
  });
  if (scored.length === 0) return undefined;

  const recent = [...scored].sort(byRecencyThenId).slice(0, RECENT_SCORED_TARGETS);
  const sum = recent.reduce((total, t) => total + t.score, 0);
  return {
    recent,
    average: Math.round((sum / recent.length) * 10) / 10,
    // Ties resolve to the more recent target: `recent` is already newest-first and the comparison is
    // strict, so the first of two equal lows wins — the one the founder can still act on.
    worst: recent.reduce((low, t) => (t.score < low.score ? t : low)),
    scored: scored.length,
  };
}

/** Newest first; a target bd gave no stamp for sorts last, then by id so the window is stable. */
function byRecencyThenId(a: ScoredTarget, b: ScoredTarget): number {
  if (a.at !== b.at) {
    if (!a.at) return 1;
    if (!b.at) return -1;
    return a.at > b.at ? -1 : 1;
  }
  return a.id < b.id ? -1 : 1;
}

/** bd's last-write stamp, falling back to creation — a bead written before either is simply undated. */
function stampOf(bead: Bead): string | undefined {
  const updated = bead.updated_at;
  if (typeof updated === "string" && updated) return updated;
  return typeof bead.created_at === "string" && bead.created_at ? bead.created_at : undefined;
}
