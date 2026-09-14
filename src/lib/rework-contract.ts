/**
 * The rework request, the five ways it can be refused, and the checks that decide it is malformed at
 * all (anton-4ocm).
 *
 * Kept apart from the action itself ({@link reworkTicket}, lib/rework.ts) because this is the
 * vocabulary the layers ABOVE share: the route maps these five errors onto status codes and never
 * touches the board, while the action is the only thing that writes. Importing the errors from here
 * costs a caller nothing else — no bd, no `gh`, no board read.
 */
import type { ReviewFinding } from "./jobs/review-context";
import {
  MAX_REWORK_INSTRUCTIONS_CHARS,
  MAX_REWORK_SUMMARY_CHARS,
  type ReworkMode,
} from "./types";

/** The founder's decision, as the route receives it. */
export interface ReworkInput {
  /** The ticket being sent back — the run target itself, or one of the tickets under it. */
  ticketId: string;
  mode: ReworkMode;
  /** One line: the reopen's `--reason`, or the follow-up bead's title. */
  summary: string;
  /** What to actually do — inlined verbatim into the implementer's prompt. */
  instructions: string;
  /** Findings the founder selected from the review report, appended to the instructions. */
  findings?: ReviewFinding[];
}

/** The request itself is malformed (missing/oversized text) — the caller's fault (400). */
export class ReworkInvalidError extends Error {}

/** The bead exists but this rework can't apply to it (422): not a run target, not one of its tickets. */
export class ReworkNotAllowedError extends Error {}

/**
 * The target moved under this request, so the send-back would race it (409). Two ways that happens:
 * a run is executing the target right now ({@link assertNoLiveRun}, lib/rework-target.ts), or its
 * pull request stopped being open while the writes were landing ({@link retireFinishedRun},
 * lib/rework-pipeline.ts). Both are answered the same way — look again and send it back — which is
 * what makes them one status.
 */
export class ReworkConflictError extends Error {}

/** Nothing on the board answers to that id (404). */
export class ReworkNotFoundError extends Error {}

/**
 * The target's PR state can't be read, so this send-back can't be decided — or, once its writes had
 * landed, stood behind (503). Whether that PR merged is the difference between re-running the target
 * and opening the work as its own target, and guessing either way strands the send-back — so it
 * fails loud instead, before the writes ({@link assertPrStillOpen}) or by undoing them
 * ({@link retireFinishedRun}). Distinct from {@link ReworkConflictError} throughout: an unreadable
 * `gh` is not evidence the PR moved, and the fix is `gh`, not another send-back.
 */
export class ReworkUnavailableError extends Error {}

/**
 * A request that has passed {@link validateReworkInput}: every field trimmed, non-empty and within
 * its bound, the mode one of the two this module implements, and the findings list defaulted — so no
 * path below has to ask any of it again.
 */
export interface ReworkRequest {
  ticketId: string;
  mode: ReworkMode;
  summary: string;
  instructions: string;
  findings: ReviewFinding[];
}

/**
 * Refuse a malformed request before anything is read off the board.
 *
 * The id is checked FIRST and on its own: a missing one is a malformed request (400), not a rework
 * that can't apply (422) — without this it would fall through to the membership check and be
 * reported as `'' is not part of <target>'s run`.
 */
export function validateReworkInput(input: ReworkInput): ReworkRequest {
  const ticketId = input.ticketId?.trim() ?? "";
  if (!ticketId) throw new ReworkInvalidError("A ticket to send back is required");
  const summary = boundedText(input.summary, MAX_REWORK_SUMMARY_CHARS, {
    missing: "A one-line summary is required",
    tooLong: "Summary is too long",
  });
  const instructions = boundedText(input.instructions, MAX_REWORK_INSTRUCTIONS_CHARS, {
    missing: "Fix instructions are required",
    tooLong: "Instructions are too long",
  });
  return {
    ticketId,
    mode: knownMode(input.mode),
    summary,
    instructions,
    findings: input.findings ?? [],
  };
}

/**
 * A required free-text field, bounded. Both limits are the founder's own text landing verbatim in an
 * implementer's prompt, so they are refused here rather than truncated somewhere downstream.
 */
function boundedText(
  raw: string | undefined,
  max: number,
  refusal: { missing: string; tooLong: string },
): string {
  const text = raw?.trim() ?? "";
  if (!text) throw new ReworkInvalidError(refusal.missing);
  if (text.length > max) {
    throw new ReworkInvalidError(`${refusal.tooLong} (${text.length} > ${max} characters)`);
  }
  return text;
}

/**
 * The mode is never inferred: which of reopen and follow-up is right is a judgement about whether the
 * ticket lied about being done, and only a human reading the review can make it — so an unknown one
 * is refused rather than guessed at.
 */
function knownMode(mode: ReworkMode): ReworkMode {
  if (mode !== "reopen" && mode !== "follow-up") {
    throw new ReworkInvalidError(`Unknown rework mode "${String(mode)}"`);
  }
  return mode;
}
