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
import type { ReviewGateOutcome, ReviewGateResult, ReviewRound } from "./review-gate";

/**
 * What a single round settled on. Only the LAST round can carry the gate's outcome — every earlier
 * round reported blocking findings, dispatched a fix for them, and was re-reviewed, which is exactly
 * what `fixed` records.
 *
 * `poisoned` is the one verdict no gate OUTCOME produces: the gate died mid-round (an unrevertable
 * reviewer commit, a fixer that switched branches) and never returned a result at all, so the round
 * it was in settled nothing.
 */
export type ReviewRoundVerdict = ReviewGateOutcome | "fixed" | "poisoned";

/** The machine-readable payload of one round's comment — the shape the score UI reads back. */
export interface ReviewScoreEntry {
  round: number;
  /** Absent only when that round's reviewer broke the report protocol (no usable score). */
  score?: number;
  blocking: number;
  advisory: number;
  verdict: ReviewRoundVerdict;
  rationale?: string;
}

/** Marks a comment as anton's score payload, so a reader can skip every other comment on the bead. */
export const REVIEW_SCORE_KIND = "anton.review-score";

/** Every round of a finished gate, in order, ready to persist. */
export function reviewScoreEntries(result: ReviewGateResult): ReviewScoreEntry[] {
  return toEntries(result.rounds, result.outcome);
}

/**
 * The rounds a gate COMPLETED before it went poison mid-flight, ready to persist.
 *
 * A poison exit returns no result, so without this the whole series is lost — including the earlier
 * rounds that reviewed, scored, and dispatched a fix perfectly well. Those rounds are exactly the
 * context the founder needs when they open the parked run to reset a stuck worktree by hand.
 */
export function partialReviewScoreEntries(rounds: ReviewRound[]): ReviewScoreEntry[] {
  return toEntries(rounds, "poisoned");
}

function toEntries(rounds: ReviewRound[], final: ReviewRoundVerdict): ReviewScoreEntry[] {
  const last = rounds.length - 1;
  return rounds.map((r, i) => ({
    round: r.round,
    ...(r.score !== undefined ? { score: r.score } : {}),
    blocking: r.blocking,
    advisory: r.advisory,
    verdict: i === last ? final : ("fixed" as const),
    ...(r.rationale ? { rationale: r.rationale } : {}),
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
    ...(entry.rationale ? ["", entry.rationale] : []),
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
 */
export async function persistReviewScores(
  repo: string,
  targetId: string,
  result: ReviewGateResult,
): Promise<void> {
  return persistEntries(repo, targetId, reviewScoreEntries(result));
}

/**
 * Persist the rounds of a gate that THREW poison, so a mid-flight death still leaves its history on
 * the board rather than only in the run log.
 */
export async function persistPartialReviewScores(
  repo: string,
  targetId: string,
  rounds: ReviewRound[],
): Promise<void> {
  if (rounds.length === 0) return;
  return persistEntries(repo, targetId, partialReviewScoreEntries(rounds));
}

async function persistEntries(
  repo: string,
  targetId: string,
  entries: ReviewScoreEntry[],
): Promise<void> {
  for (const entry of entries) {
    await safeWrite(`round ${entry.round} comment`, targetId, () =>
      beads.comment(repo, targetId, formatReviewScoreComment(entry)),
    );
  }

  // The latest score is the last round that actually reported one: a final protocol violation must
  // not erase the score the round before it earned, and must not invent one of its own.
  const latest = [...entries].reverse().find((e) => e.score !== undefined)?.score;
  if (latest === undefined) return;
  await safeWrite("score label", targetId, async () => {
    // A failed read costs the prefix-diff, not the label: an extra `review-score:*` reads ambiguous
    // until the next round rewrites it, which is far cheaper than losing the latest score entirely.
    const bead = await beads.show(repo, targetId).catch(() => undefined);
    await beads.setReviewScore(repo, targetId, latest, bead ? beads.reviewScoreLabels(bead) : []);
  });
}

async function safeWrite(what: string, targetId: string, fn: () => Promise<unknown>): Promise<void> {
  try {
    await fn();
  } catch (e) {
    console.error(`[review-score] could not write ${what} for ${targetId}`, e);
  }
}
