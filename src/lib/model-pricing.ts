/**
 * What the tokens cost (anton-j9lf): dollars derived by anton from the measured token counts in the
 * ledger and a price table anton owns.
 *
 * The ledger stores the CLI's own `cost_usd` as reported, and this module never reads it. That field
 * is priced against the model name Claude Code believes it called, which means nothing once a
 * gateway is in the path: a request for opus served by a gateway's own provider still reports a
 * cost as if Anthropic had billed opus rates. Deriving from counts anton measured, at prices anton
 * states, is the only figure that survives a routed call.
 *
 * Three rules are load-bearing:
 *
 *  - An unknown model yields NO cost, never a zero. A gateway's providers are priced differently or
 *    not at all, and a zero silently reads as free — it would sum into a project total that
 *    understates real spend with no sign anything is missing. `undefined` forces the caller to
 *    decide what to do about it, which is the whole point (see {@link totalCost}).
 *  - Cached reads are priced at the CACHE-READ rate, an order of magnitude below fresh input (0.1x
 *    base, 0.025x on the Fable/Mythos 5.1 pair). Folding them into input overstates a long agentic
 *    run by most of its bill, since nearly all of its input is re-read context.
 *  - Thinking tokens are NOT priced. They are a SUBSET of the billed output tokens, not an
 *    additional charge — the API documents `thinking_tokens` as "how many of the billed output
 *    tokens were internal reasoning". Adding them to output double-charges every thinking model, and
 *    on a real opus run (29,177 output including 10,732 thinking) that is a ~37% overstatement.
 *
 * Pure and dependency-free, like `model-divergence` it shares `normalizeModelId` with: a server
 * component, the read path and a test all price identically instead of drifting apart.
 */
import { normalizeModelId } from "./model-divergence";

/**
 * WHERE THESE NUMBERS CAME FROM AND WHEN — the provenance criterion. A price table without this is
 * indistinguishable from a stale one, and a stale price is worse than a missing one because it still
 * produces a confident number. Re-read the source and bump the date; do not edit a rate in place
 * without it.
 */
export const PRICES_SOURCE = "https://platform.claude.com/docs/en/about-claude/pricing";

/** The date {@link MODEL_PRICES} was last verified against {@link PRICES_SOURCE}. */
export const PRICES_AS_OF = "2026-09-09";

/** One model's list prices, in USD per MILLION tokens — the unit the source publishes. */
export interface ModelPrice {
  input: number;
  output: number;
  /** A cache hit. 0.1x base input on every model but the 5.1 pair, which is 0.025x. */
  cacheRead: number;
  /** Writing the 5-minute cache: 1.25x base input. What Claude Code's own caching uses. */
  cacheWrite5m: number;
  /** Writing the 1-hour cache: 2x base input. Recorded for completeness; see {@link costOf}. */
  cacheWrite1h: number;
}

/** USD per MTok, keyed by {@link normalizeModelId} — verified {@link PRICES_AS_OF}. */
export const MODEL_PRICES: Readonly<Record<string, ModelPrice>> = {
  // Fable/Mythos 5.1: the only models whose cache reads are 0.025x base rather than 0.1x.
  "fable-5-1": { input: 10, output: 50, cacheRead: 0.25, cacheWrite5m: 12.5, cacheWrite1h: 20 },
  "mythos-5-1": { input: 10, output: 50, cacheRead: 0.25, cacheWrite5m: 12.5, cacheWrite1h: 20 },
  "fable-5": { input: 10, output: 50, cacheRead: 1, cacheWrite5m: 12.5, cacheWrite1h: 20 },
  "mythos-5": { input: 10, output: 50, cacheRead: 1, cacheWrite5m: 12.5, cacheWrite1h: 20 },
  "opus-5": { input: 5, output: 25, cacheRead: 0.5, cacheWrite5m: 6.25, cacheWrite1h: 10 },
  "opus-4-8": { input: 5, output: 25, cacheRead: 0.5, cacheWrite5m: 6.25, cacheWrite1h: 10 },
  "opus-4-7": { input: 5, output: 25, cacheRead: 0.5, cacheWrite5m: 6.25, cacheWrite1h: 10 },
  "opus-4-6": { input: 5, output: 25, cacheRead: 0.5, cacheWrite5m: 6.25, cacheWrite1h: 10 },
  "opus-4-5": { input: 5, output: 25, cacheRead: 0.5, cacheWrite5m: 6.25, cacheWrite1h: 10 },
  // $2/$10 is the STANDARD price: the increase to $3/$15 scheduled for 2026-09-01 was cancelled,
  // and the launch "introductory" rate became permanent.
  "sonnet-5": { input: 2, output: 10, cacheRead: 0.2, cacheWrite5m: 2.5, cacheWrite1h: 4 },
  "sonnet-4-6": { input: 3, output: 15, cacheRead: 0.3, cacheWrite5m: 3.75, cacheWrite1h: 6 },
  "sonnet-4-5": { input: 3, output: 15, cacheRead: 0.3, cacheWrite5m: 3.75, cacheWrite1h: 6 },
  "haiku-4-5": { input: 1, output: 5, cacheRead: 0.1, cacheWrite5m: 1.25, cacheWrite1h: 2 },
};

/**
 * Web search, billed per SEARCH rather than per token ($10 per 1,000). Model-independent, and the
 * one non-token charge the ledger records a count for.
 */
export const WEB_SEARCH_USD_PER_REQUEST = 0.01;

/** Per-million rates → per-token. Kept as a named constant so the unit conversion is stated once. */
const PER_MILLION = 1_000_000;

/**
 * One model's price, or undefined when the table does not know it.
 *
 * Lookup is EXACT on the normalized id — no nearest-match, no tier guessing. `normalizeModelId`
 * already folds the spellings that name the same model (`cc/claude-opus-5[1m]`,
 * `claude-opus-5-20260401` and `anthropic/claude-opus-5` all reduce to `opus-5`), so anything left
 * unmatched is genuinely a model anton has no price for — a gateway's own provider, or one released
 * since {@link PRICES_AS_OF}. Guessing it a price is exactly the silent error this exists to avoid.
 */
export function priceOf(model: string | null | undefined): ModelPrice | undefined {
  const id = normalizeModelId(model);
  return id ? MODEL_PRICES[id] : undefined;
}

/** Whether anton can price this model at all — the question a UI asks before showing a dash. */
export function isPriced(model: string | null | undefined): boolean {
  return priceOf(model) !== undefined;
}

/**
 * The measured counts one ledger row carries. Structural and all-optional, so it takes a row, a
 * {@link import("./claude/model-usage").ModelUsageEntry}, or a test fixture — and so an absent
 * count is distinguishable from a zero one.
 *
 * `thinkingTokens` is deliberately ABSENT: it is already inside `outputTokens` (see the header).
 */
export interface TokenCounts {
  inputTokens?: number | null;
  outputTokens?: number | null;
  cacheReadInputTokens?: number | null;
  cacheCreationInputTokens?: number | null;
  webSearchRequests?: number | null;
}

/** The count fields that carry a dollar figure — everything {@link costOf} reads. */
const PRICED_FIELDS = [
  "inputTokens",
  "outputTokens",
  "cacheReadInputTokens",
  "cacheCreationInputTokens",
  "webSearchRequests",
] as const;

/** A reported count, or 0. Absent and unreadable both contribute nothing to the sum. */
function count(value: number | null | undefined): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

/** Whether ANY priced count was actually reported — what separates "measured zero" from "unknown". */
function hasAnyCount(counts: TokenCounts): boolean {
  return PRICED_FIELDS.some((field) => typeof counts[field] === "number");
}

/**
 * What one (invocation, model) row cost in USD, or **undefined when that cannot be known**.
 *
 * Undefined has exactly two causes, and neither is a zero:
 *
 *  - The price table does not know the model. An unknown price is unknown, not free.
 *  - The row reported no counts at all — the unknown-usage row a crashed result writes. Nothing was
 *    measured, so nothing can be derived; `0` would claim a free invocation that in fact spent
 *    tokens nobody can see.
 *
 * A row with SOME counts prices what it has, treating absent components as zero — an invocation that
 * reported input but no cache reads did not read cache, and that is a measurement, not a gap.
 *
 * Cache creation is priced at the 5-MINUTE write rate. The ledger stores one
 * `cache_creation_input_tokens` figure without the TTL that produced it, and 5m is what Claude Code
 * writes; a 1h write would be understated by a factor of 1.6 (2x vs 1.25x base). Recorded here
 * rather than hidden in a caller.
 *
 * No rounding — the value is a float and often smaller than a cent. Round at the display edge, where
 * the number of decimal places is a presentation choice.
 */
export function costOf(
  model: string | null | undefined,
  counts: TokenCounts,
): number | undefined {
  const price = priceOf(model);
  if (!price || !hasAnyCount(counts)) return undefined;

  const tokens =
    count(counts.inputTokens) * price.input +
    count(counts.outputTokens) * price.output +
    count(counts.cacheReadInputTokens) * price.cacheRead +
    count(counts.cacheCreationInputTokens) * price.cacheWrite5m;

  return tokens / PER_MILLION + count(counts.webSearchRequests) * WEB_SEARCH_USD_PER_REQUEST;
}

/** A ledger row as this module reads it: the model it reported usage under, plus the counts. */
export interface PriceableRow extends TokenCounts {
  modelReported: string | null;
}

/** What a set of rows cost, with what could NOT be priced kept visible beside the total. */
export interface SpendCost {
  /** USD across every row anton could price. Never includes a guess for one it could not. */
  usd: number;
  /** Rows that produced a figure. */
  priced: number;
  /**
   * Rows that did not — an unknown model, or no counts. NOT folded into `usd` as zero: a total that
   * hides them reads as complete when it is partial, which is the failure this whole module exists
   * to prevent.
   */
  unpriced: number;
  /**
   * The distinct model ids that had no price, as the serving side spelled them, most-seen first.
   * The actionable half: it names what to add to the table, or which gateway is unpriceable.
   */
  unpricedModels: string[];
}

/**
 * Sum what a window of ledger rows cost, keeping the unpriceable remainder in view.
 *
 * Deliberately NOT a plain number. A single total cannot say "this is most of your spend but not
 * all of it", and a project routed through a gateway is exactly the case where the difference
 * decides whether the figure means anything.
 */
export function totalCost(rows: readonly PriceableRow[]): SpendCost {
  const unknown = new Map<string, number>();
  let usd = 0;
  let priced = 0;

  for (const row of rows) {
    const cost = costOf(row.modelReported, row);
    if (cost === undefined) {
      // Only a NAMED model is worth reporting back; a row with no model reported is the
      // unknown-usage row, and it names nothing to add to the table.
      const model = row.modelReported?.trim();
      if (model) unknown.set(model, (unknown.get(model) ?? 0) + 1);
      continue;
    }
    usd += cost;
    priced += 1;
  }

  return {
    usd,
    priced,
    unpriced: rows.length - priced,
    unpricedModels: [...unknown.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([model]) => model),
  };
}
