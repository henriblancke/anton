/**
 * How much of a verify gate's output anton ever inlines, and which end it keeps.
 *
 * Its own module (extracted from review-context.ts, anton-vynb8) so the three places that show gate
 * output — the reviewer's evidence, a re-attempt's dispatch prompt, and the failure recorded on the
 * run row — share ONE rule rather than three that drift, and so the row's recorder can apply it
 * without dragging the whole review-context dependency graph into `src/lib/runs.ts`.
 */

/**
 * Per verify gate. Enough for a runner's failure list and its summary, which is all the reviewer
 * needs from a check it did not have to run — and small enough that four green gates cannot crowd
 * out the diff they are evidence about. The same cap applies one stage earlier, to a gate failure
 * recorded for the next attempt, so what is stored is what can be shown.
 */
export const MAX_GATE_OUTPUT_CHARS = 3000;

/**
 * The LAST `max` characters, cut on a line boundary.
 *
 * A test runner prints its failures and its totals last and its progress dots first, so keeping the
 * head of a suite log keeps the part that says nothing. Cutting mid-line would leave a half-written
 * path that reads as a real one, so the cut moves forward to the next newline.
 *
 * Unless there ISN'T one (PR #254 review): a tail that holds no newline is a single long line — one
 * JSON blob, one minified stack — and the only ways to end it on a boundary are to keep the whole
 * line, which breaks the budget this function exists to enforce, or to drop it entirely, which
 * throws away the only output there is. So the cap wins and the cut lands mid-line; the
 * `… [earlier output omitted]` marker already tells the reader the text is truncated.
 */
export function tailLines(text: string, max: number): string {
  const trimmed = text.trim();
  if (!trimmed) return "(no output)";
  if (trimmed.length <= max) return trimmed;
  const cut = trimmed.length - max;
  const nl = trimmed.indexOf("\n", cut);
  return `… [earlier output omitted]\n${trimmed.slice(nl === -1 ? cut : nl + 1)}`;
}
