/**
 * What a review-fix round writes into the one PR-body region anton owns (anton-te6nr), on top of
 * the marker mechanics {@link upsertBodyRegion} in `steps/prompts.ts` already built (anton-gkjb6):
 * a dated line per round naming what got fixed, drawn straight from the per-thread outcomes the
 * fixer already reported — no new LLM call.
 *
 * Pure and file-local: this module only turns a report + the region's current text into the
 * region's NEXT text. Fetching that text from GitHub, writing it back, and deciding whether a gh
 * call is warranted at all are `review-fix.ts`'s job — this module owns none of that.
 */
import { BODY_REGION_END, BODY_REGION_START } from "./steps/prompts";
import { fabricatedFix, type ThreadOutcome } from "./review-fix-context";

/** One review-fix round: the date it pushed, and one line per thread it actually fixed. */
export interface FixRound {
  /** ISO calendar date (YYYY-MM-DD) the round pushed. */
  date: string;
  fixed: string[];
}

/**
 * How many rounds the region keeps. Past this, the OLDEST are dropped — a PR still open after this
 * many review-fix rounds is one nobody is reading round-by-round anymore, and the region exists to
 * inform the founder at the merge gate, not to be a full audit log (that's the session history).
 */
const MAX_ROUNDS = 20;

const ROUND_LINE = /^- (\d{4}-\d{2}-\d{2}): (.+)$/;

/**
 * What this round fixed, straight from the fixer's own per-thread report. A "fixed" claim with
 * nothing pushed behind it is excluded — the exact rule `applyThreadOutcomes` already answers
 * threads with ({@link fabricatedFix}), shared rather than reimplemented. `undefined` when nothing
 * survives: an empty (or entirely fabricated/non-fixed) report renders nothing, so the caller never
 * writes — or even reads towards — an empty round.
 */
export function fixRoundFrom(
  report: ThreadOutcome[],
  pushed: boolean,
  now: Date,
): FixRound | undefined {
  const fixed = report
    .filter((item) => item.outcome === "fixed" && !fabricatedFix(item, pushed))
    .map((item) => item.reply?.trim() || `thread ${item.id}`);
  if (fixed.length === 0) return undefined;
  return { date: now.toISOString().slice(0, 10), fixed };
}

/**
 * Parse the rounds already written into the region, oldest first — the same order they render in.
 * Tolerant by design: a line that doesn't match the round shape (the heading, the blank spacer, a
 * dropped-rounds marker, or hand-edited text) is silently skipped rather than treated as an error,
 * since this only ever reads back what {@link renderFixRounds} itself wrote.
 */
export function parseFixRounds(regionContent: string | undefined): FixRound[] {
  if (!regionContent) return [];
  const rounds: FixRound[] = [];
  for (const raw of regionContent.split("\n")) {
    const m = ROUND_LINE.exec(raw.trim());
    if (!m) continue;
    const [, date, fixed] = m;
    if (!date || !fixed) continue;
    rounds.push({ date, fixed: fixed.split("; ") });
  }
  return rounds;
}

/** The region's current raw content, or undefined when `body` carries no well-formed region yet. */
export function extractFixRoundsRegion(body: string | undefined): string | undefined {
  if (!body) return undefined;
  const startIdx = body.indexOf(BODY_REGION_START);
  const endIdx = body.indexOf(BODY_REGION_END);
  if (startIdx === -1 || endIdx === -1 || endIdx <= startIdx) return undefined;
  return body.slice(startIdx + BODY_REGION_START.length, endIdx).trim();
}

/**
 * Render the accumulated rounds, oldest first, capped at {@link MAX_ROUNDS} — past the cap the
 * oldest are dropped and a marker line says so, rather than the region growing without limit for
 * the life of a long-running PR. `[]` renders `""`: nothing has ever been fixed, so the region says
 * nothing rather than an empty heading.
 */
export function renderFixRounds(rounds: FixRound[]): string {
  if (rounds.length === 0) return "";
  const capped = rounds.length > MAX_ROUNDS ? rounds.slice(rounds.length - MAX_ROUNDS) : rounds;
  const dropped = rounds.length - capped.length;
  const lines = ["### Review-fix rounds", ""];
  if (dropped > 0) lines.push(`… ${dropped} earlier round${dropped === 1 ? "" : "s"} dropped`, "");
  lines.push(...capped.map((r) => `- ${r.date}: ${r.fixed.join("; ")}`));
  return lines.join("\n");
}

/**
 * The region's NEXT text after this round: the rounds already in `currentBody`'s region, plus what
 * this round fixed. `undefined` when this round fixed nothing — the caller's signal to leave the
 * body, and gh, untouched.
 */
export function nextFixRoundsRegion(
  currentBody: string | undefined,
  report: ThreadOutcome[],
  pushed: boolean,
  now: Date,
): string | undefined {
  const round = fixRoundFrom(report, pushed, now);
  if (!round) return undefined;
  const rounds = [...parseFixRounds(extractFixRoundsRegion(currentBody)), round];
  return renderFixRounds(rounds);
}
