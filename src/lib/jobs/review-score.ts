/**
 * Where a self-review's scores LAND (anton-omum): one append-only bd comment per review round on the
 * run target, plus a `review-score:<n>` label carrying the latest value.
 *
 * The board — not this run's session logs — is the score history the UI trends over (anton-zetz), so
 * every round has to be written somewhere that outlives the worktree it was reviewed in. Comments are
 * append-only, so re-running the gate on a resume adds to the series rather than rewriting it; the
 * label is prefix-diffed, so "latest score" stays a single value.
 *
 * Writes are best-effort per round: a board hiccup degrades the history, and must never fail a run
 * whose work already landed.
 */
import { beads } from "../beads/bd";
import { findingLines, type ReviewFinding } from "./review-context";
import type { ReviewGateOutcome, ReviewGateResult, ReviewRound, ReviewScoreCap } from "./review-gate";

/**
 * What a single round settled on. Only the LAST round can carry the gate's outcome. Of the earlier
 * rounds, most reported blocking findings, dispatched a fix for them, and were re-reviewed, which is
 * exactly what `fixed` records — but a round the large-diff churn floor (anton-z8uv) forced to
 * continue reported NOTHING blocking and dispatched no fix at all, so it earns `floor-continued`
 * instead: `fixed` on that round would claim a repair that never happened.
 *
 * `interrupted` is the one verdict no gate OUTCOME produces: the gate died mid-round — a poison
 * worktree (an unrevertable reviewer commit, a fixer that switched branches), an exhausted quota, a
 * claude failure — and never returned a result at all, so the round it was in settled nothing. Named
 * for what the founder can tell from the comment alone: which of those it was is on the run row.
 */
export type ReviewRoundVerdict = ReviewGateOutcome | "fixed" | "floor-continued" | "interrupted";

/** The machine-readable payload of one round's comment — the shape the score UI reads back. */
export interface ReviewScoreEntry {
  round: number;
  /** Absent only when that round's reviewer broke the report protocol (no usable score). */
  score?: number;
  blocking: number;
  advisory: number;
  verdict: ReviewRoundVerdict;
  rationale?: string;
  /**
   * What the round actually found, so the report survives the worktree it was reviewed in. The
   * rework action (anton-4ocm) sends a selection of these back to a ticket as fix instructions;
   * with counts alone the founder would have to retype the reviewer's own words. Absent on a round
   * that reported nothing.
   */
  findings?: ReviewFinding[];
  /**
   * Set when `score` was capped down from what the reviewer reported (anton-re02) — the diff it
   * reviewed was truncated, so the board history states the cap and why rather than showing a bare
   * number the founder would otherwise read as the reviewer's own verdict.
   */
  scoreCap?: ReviewScoreCap;
  /**
   * Set when this round's diff cleared the operator's churn threshold (anton-z8uv) — on the round(s)
   * the floor forced as well as the final round that satisfied it. Carried through so the board says
   * why a clean large diff still took extra rounds, not just that it did (anton-z8uv's 4th criterion).
   */
  churnFloorApplied?: { churnLines: number; thresholdLines: number; minRounds: number };
  /**
   * The paths this round's reviewer named as unable to fully review (anton-0b1d) — carried from
   * `ReviewRound.unreviewedPaths` so the board states WHICH part of a large diff still has nobody's
   * eyes on it, not just that it was truncated and the score capped.
   */
  unreviewedPaths?: string[];
}

/** Marks a comment as anton's score payload, so a reader can skip every other comment on the bead. */
export const REVIEW_SCORE_KIND = "anton.review-score";

/** Every round of a finished gate, in order, ready to persist. */
export function reviewScoreEntries(result: ReviewGateResult): ReviewScoreEntry[] {
  return toEntries(result.rounds, result.outcome);
}

/**
 * The rounds a gate COMPLETED before it died mid-flight, ready to persist.
 *
 * A throwing exit returns no result, so without this the whole series is lost — including the earlier
 * rounds that reviewed, scored, and dispatched a fix perfectly well. Those rounds are exactly the
 * context the founder needs when they open the parked run to reset a stuck worktree by hand, and on
 * a retryable death (a usage limit) they are the only trace of the attempt at all: the run is
 * rescheduled and the resumed gate starts again at round 1.
 */
export function partialReviewScoreEntries(rounds: ReviewRound[]): ReviewScoreEntry[] {
  return toEntries(rounds, "interrupted");
}

function toEntries(rounds: ReviewRound[], final: ReviewRoundVerdict): ReviewScoreEntry[] {
  const last = rounds.length - 1;
  return rounds.map((r, i) => ({
    round: r.round,
    ...(r.score !== undefined ? { score: r.score } : {}),
    blocking: r.blocking,
    advisory: r.advisory,
    // Every non-final round either dispatched a fix (`fixSessionId` set) or was a clean round the
    // churn floor forced to continue (`churnFloorApplied` set, no fix session — anton-z8uv): those are
    // the only two ways a round can end without being the gate's last. Labelling the second one
    // `fixed` would claim a repair that was never dispatched.
    verdict: i === last ? final : r.fixSessionId ? ("fixed" as const) : ("floor-continued" as const),
    ...(r.rationale ? { rationale: r.rationale } : {}),
    ...(r.findings?.length ? { findings: r.findings } : {}),
    ...(r.scoreCap ? { scoreCap: r.scoreCap } : {}),
    ...(r.churnFloorApplied ? { churnFloorApplied: r.churnFloorApplied } : {}),
    ...(r.unreviewedPaths?.length ? { unreviewedPaths: r.unreviewedPaths } : {}),
  }));
}

/**
 * One round's comment: a line a human reads on the bead, then the payload a UI parses. Both, because
 * the same comment thread is the founder's board view and the trend chart's data source.
 */
export function formatReviewScoreComment(entry: ReviewScoreEntry): string {
  const score = entry.score === undefined ? "no valid score" : `score ${entry.score}/10`;
  const head =
    `anton self-review · round ${entry.round} · ${score} · ` +
    `${entry.blocking} blocking, ${entry.advisory} advisory · ${entry.verdict}`;
  return [
    head,
    ...(entry.scoreCap ? [`capped from ${entry.scoreCap.reported}/10 — ${entry.scoreCap.reason}`] : []),
    ...(entry.churnFloorApplied
      ? [
          `large diff (${entry.churnFloorApplied.churnLines} lines ≥ ${entry.churnFloorApplied.thresholdLines}) — ` +
            `the churn floor requires ${entry.churnFloorApplied.minRounds} round(s) of review before a clean exit`,
        ]
      : []),
    ...(entry.unreviewedPaths?.length
      ? [`unreviewed (truncated diff): ${entry.unreviewedPaths.join(", ")}`]
      : []),
    ...(entry.rationale ? ["", entry.rationale] : []),
    ...(entry.findings?.length ? ["", ...findingLines(entry.findings)] : []),
    "",
    "```json",
    JSON.stringify({ kind: REVIEW_SCORE_KIND, ...entry }),
    "```",
  ].join("\n");
}

/**
 * Persist a finished gate to the run target: a comment per round, then the latest score as a label.
 *
 * Called on every exit the gate RETURNS from — the PR path and the park path — because a run parked
 * on blocking findings is precisely the one whose score the founder needs on the board. The exit it
 * cannot cover is the one that throws; {@link persistPartialReviewScores} is that path.
 *
 * Returns the score this attempt earned, which its caller stamps on the run row.
 */
export async function persistReviewScores(
  repo: string,
  targetId: string,
  result: ReviewGateResult,
): Promise<number | undefined> {
  return persistEntries(repo, targetId, reviewScoreEntries(result));
}

/**
 * Persist the rounds of a gate that THREW — poison or retryable — so a mid-flight death still leaves
 * its history on the board rather than only in the run log. Returns that attempt's score, if any of
 * its finished rounds reported one.
 */
export async function persistPartialReviewScores(
  repo: string,
  targetId: string,
  rounds: ReviewRound[],
): Promise<number | undefined> {
  if (rounds.length === 0) return undefined;
  return persistEntries(repo, targetId, partialReviewScoreEntries(rounds));
}

/**
 * The score this attempt earned: the last round that actually reported one. A final protocol
 * violation must not erase the score the round before it earned, and must not invent one of its own.
 */
function latestReviewScore(entries: readonly ReviewScoreEntry[]): number | undefined {
  return [...entries].reverse().find((e) => e.score !== undefined)?.score;
}

/**
 * Writes the board history and returns the attempt's score — returned rather than only written,
 * because the RUN row records it too (anton-cekf): the board label is the target's latest score
 * across every attempt, so the score-regression breaker needs the one this attempt produced, and
 * needs it even on the pass where the best-effort board write did not land.
 */
async function persistEntries(
  repo: string,
  targetId: string,
  entries: ReviewScoreEntry[],
): Promise<number | undefined> {
  for (const entry of entries) {
    await safeWrite(`round ${entry.round} comment`, targetId, () =>
      beads.comment(repo, targetId, formatReviewScoreComment(entry)),
    );
  }

  const latest = latestReviewScore(entries);
  if (latest === undefined) return undefined;
  await safeWrite("score label", targetId, async () => {
    // A failed read costs the prefix-diff, not the label: an extra `review-score:*` reads ambiguous
    // until the next round rewrites it, which is far cheaper than losing the latest score entirely.
    const bead = await beads.show(repo, targetId).catch(() => undefined);
    await beads.setReviewScore(repo, targetId, latest, bead ? beads.reviewScoreLabels(bead) : []);
  });
  return latest;
}

async function safeWrite(what: string, targetId: string, fn: () => Promise<unknown>): Promise<void> {
  try {
    await fn();
  } catch (e) {
    console.error(`[review-score] could not write ${what} for ${targetId}`, e);
  }
}
