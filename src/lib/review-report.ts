/**
 * The self-review report, read back off the BOARD (anton-4ocm).
 *
 * A run's reviewer speaks once, into a worktree that is force-removed when the run finishes — so the
 * only durable copy of what it found is the append-only comment each round leaves on the run target
 * (lib/jobs/review-score.ts). This module is the reader for that thread: it replays the rounds a
 * finished review appended, so the founder can send a ticket back carrying the reviewer's own words
 * instead of retyping them.
 *
 * Deliberately tolerant. A comment that isn't anton's, a payload from a future anton with fields
 * this build doesn't know, a hand-edited fence — none of them may lose the rounds around them, so
 * every entry is parsed independently and an unparseable one is skipped rather than thrown on.
 */
import { beads, type Bead, type BeadComment } from "./beads/bd";
import type { ReviewFinding } from "./jobs/review-context";
import { REVIEW_SCORE_KIND, type ReviewScoreEntry } from "./jobs/review-score";

/** One replayed round: the score payload it recorded, plus when the board received it. */
export interface ReviewReportRound extends ReviewScoreEntry {
  /** bd's own timestamp for the comment — the only ordering the board can vouch for. */
  at?: string;
}

export interface ReviewReport {
  /** Every round anton recorded on this target, oldest first. Empty when it was never reviewed. */
  rounds: ReviewReportRound[];
  /** The findings the LAST round that reported any left open — what a rework is selected from. */
  findings: ReviewFinding[];
  /** The latest round that carried a valid score, for the header line. */
  score?: number;
}

/** Fenced ```json blocks in a comment body, innermost content only. */
const JSON_FENCE = /```json\s*\n([\s\S]*?)\n?```/g;

/**
 * The score payload of one comment, or undefined when it carries none. A round is identified by the
 * `kind` marker, never by position: anton's own park notes, a human's reply and a future comment
 * flavour all share this thread.
 */
export function parseReviewScoreComment(comment: BeadComment): ReviewReportRound | undefined {
  const text = typeof comment?.text === "string" ? comment.text : "";
  for (const [, body] of text.matchAll(JSON_FENCE)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      continue; // a fence that isn't JSON is somebody else's; keep looking
    }
    const entry = parsed as Partial<ReviewScoreEntry> & { kind?: unknown };
    if (entry?.kind !== REVIEW_SCORE_KIND || typeof entry.round !== "number") continue;
    return {
      round: entry.round,
      ...(typeof entry.score === "number" ? { score: entry.score } : {}),
      blocking: typeof entry.blocking === "number" ? entry.blocking : 0,
      advisory: typeof entry.advisory === "number" ? entry.advisory : 0,
      verdict: entry.verdict ?? "interrupted",
      ...(typeof entry.rationale === "string" ? { rationale: entry.rationale } : {}),
      findings: normalizeFindings(entry.findings),
      ...(typeof comment.created_at === "string" ? { at: comment.created_at } : {}),
    };
  }
  return undefined;
}

/**
 * Findings as this build understands them. Written before {@link ReviewRound.findings} existed, a
 * round carries none — which is a report with nothing to select, not a broken one.
 */
function normalizeFindings(raw: unknown): ReviewFinding[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((f): ReviewFinding[] => {
    const finding = f as Partial<ReviewFinding>;
    if (typeof finding?.note !== "string" || !finding.note.trim()) return [];
    return [
      {
        severity: finding.severity === "blocking" ? "blocking" : "advisory",
        location: typeof finding.location === "string" && finding.location ? finding.location : "(general)",
        note: finding.note,
      },
    ];
  });
}

/** Replay a hydrated bead's comment thread — the pure half, so callers can test without bd. */
export function reviewReportOf(target: Bead): ReviewReport {
  const rounds = (target.comments ?? [])
    .map(parseReviewScoreComment)
    .filter((r): r is ReviewReportRound => r !== undefined);
  // The board records rounds in the order they ran, but a resumed gate restarts at round 1, so the
  // round NUMBER is not a total order across attempts — the last comment written is the last word.
  const latest = [...rounds].reverse();
  return {
    rounds,
    findings: latest.find((r) => (r.findings?.length ?? 0) > 0)?.findings ?? [],
    score: latest.find((r) => r.score !== undefined)?.score,
  };
}

/**
 * This run target's review report, read fresh. The comment thread is hydrated explicitly (the
 * default `bd show` withholds it), so this costs one bd spawn and is called only when a surface
 * actually renders the report.
 */
export async function getReviewReport(repoPath: string, targetId: string): Promise<ReviewReport> {
  return reviewReportOf(await beads.showWithComments(repoPath, targetId));
}
