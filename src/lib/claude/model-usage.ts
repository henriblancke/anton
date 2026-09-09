/**
 * The result event's `modelUsage` map, normalized (anton-77l9): the measured per-model token counts
 * one `claude` invocation actually spent, which is the only honest input to what a task cost.
 *
 * Two properties of the field drive everything here, both stated by Claude Code's own stream-json
 * contract:
 *
 *  - It is CUMULATIVE over the session, not per turn. The latest result event's map is the session's
 *    total, so it is READ and never summed — adding two results of one session double-counts every
 *    token the first one already reported. The driver latches only the final `result` line
 *    (`captureMarkers`), so this module is handed the latest map by construction.
 *  - It is BEST-EFFORT. It is omitted entirely on crash/startup-error results, arrives as `{}` when
 *    the model never ran, and a gateway may key it by ids anton has never seen. So every field is
 *    validated independently and a map that cannot be read yields NO entries rather than a throw —
 *    an invocation with unknown usage is still an invocation, and losing the row loses the fact that
 *    it happened at all.
 */

/** One model's measured spend within an invocation. Every count is absent when it wasn't reported. */
export interface ModelUsageEntry {
  /** The model id the result reported the usage UNDER — a gateway's spelling, not anton's request. */
  model: string;
  inputTokens?: number;
  outputTokens?: number;
  thinkingTokens?: number;
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
  webSearchRequests?: number;
}

/** The count fields, in the order a row records them. */
const COUNT_FIELDS = [
  "inputTokens",
  "outputTokens",
  "thinkingTokens",
  "cacheReadInputTokens",
  "cacheCreationInputTokens",
  "webSearchRequests",
] as const;

/**
 * A reported count, or undefined when it is anything else. Negative values are refused along with
 * non-numbers: a token count cannot be negative, and a stored one would price as a credit.
 */
function countOf(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

/**
 * One `modelUsage` entry, or undefined when its value is not an object. An entry whose counts are
 * ALL unreadable is still kept: the result named that model, which is a fact worth a row even
 * without figures on it.
 */
function entryOf(model: string, value: unknown): ModelUsageEntry | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  const entry: ModelUsageEntry = { model };
  for (const field of COUNT_FIELDS) {
    const count = countOf(raw[field]);
    if (count !== undefined) entry[field] = count;
  }
  return entry;
}

/**
 * The result event's `modelUsage` → one entry per model it reported, in the map's own key order.
 *
 * Returns an empty array for every way the field can fail to say anything — absent, null, `{}`, a
 * string, an array, or a map whose values are not objects. The caller records that as an invocation
 * with UNKNOWN usage; it is never an error, because the alternative is dropping the invocation.
 */
export function parseModelUsage(raw: unknown): ModelUsageEntry[] {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return [];
  return Object.entries(raw as Record<string, unknown>).flatMap(([model, value]) => {
    if (!model) return [];
    const entry = entryOf(model, value);
    return entry ? [entry] : [];
  });
}
