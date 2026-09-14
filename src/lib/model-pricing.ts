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
  cacheRead?: number;
  /** Writing the 5-minute cache: 1.25x base input. What Claude Code's own caching uses. */
  cacheWrite5m?: number;
  /** Writing the 1-hour cache: 2x base input. Recorded for completeness; see {@link costOf}. */
  cacheWrite1h?: number;
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

/** Pricing fetched from a gateway's own pricing API for one endpoint host. */
export interface GatewayPricing {
  endpointHost: string;
  prices: Readonly<Record<string, ModelPrice>>;
}

function finiteNonNegative(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

/**
 * Convert 9Router's `/api/pricing` response into the rate shape used by the ledger.
 *
 * 9Router returns `{ provider: { model: { input, output, cached, cache_creation } } }`, with
 * values in dollars per million tokens. Provider-qualified spellings are always safe. A bare model
 * spelling is added only when precisely one provider offered it: otherwise it would assign whichever
 * provider happened to arrive first in the response.
 */
export function parse9RouterPricing(payload: unknown): Readonly<Record<string, ModelPrice>> {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return {};

  const prices: Record<string, ModelPrice> = {};
  const aliases = new Map<string, ModelPrice | undefined>();
  const addAlias = (key: string, price: ModelPrice) => {
    if (!key) return;
    if (!aliases.has(key)) {
      aliases.set(key, price);
      return;
    }
    // A bare id tells us no provider. Never let object iteration choose one for it.
    aliases.set(key, undefined);
  };
  for (const [provider, models] of Object.entries(payload)) {
    if (!models || typeof models !== "object" || Array.isArray(models)) continue;
    for (const [model, value] of Object.entries(models)) {
      if (!value || typeof value !== "object" || Array.isArray(value)) continue;
      const rate = value as Record<string, unknown>;
      const input = finiteNonNegative(rate.input);
      const output = finiteNonNegative(rate.output);
      if (input === undefined || output === undefined) continue;

      const price: ModelPrice = {
        input,
        output,
        cacheRead: finiteNonNegative(rate.cached),
        cacheWrite5m: finiteNonNegative(rate.cache_creation),
      };
      prices[`${provider}/${model}`] = price;
      addAlias(model, price);
      const normalized = normalizeModelId(model);
      if (normalized !== model) addAlias(normalized, price);
    }
  }
  for (const [alias, price] of aliases) if (price) prices[alias] = price;
  return prices;
}

/** Read 9Router's current pricing without making the spend page depend on its availability. */
export async function fetch9RouterPricing(args: {
  baseUrl?: string;
  authTokenEnv?: string;
  fetchImpl?: typeof fetch;
}): Promise<GatewayPricing | undefined> {
  const baseUrl = args.baseUrl?.trim();
  const token = args.authTokenEnv ? process.env[args.authTokenEnv] : undefined;
  if (!baseUrl || !args.authTokenEnv || !token) return undefined;

  let endpoint: URL;
  try {
    endpoint = new URL(baseUrl);
    endpoint.pathname = "/api/pricing";
    endpoint.search = "";
    endpoint.hash = "";
  } catch {
    return undefined;
  }

  try {
    const response = await (args.fetchImpl ?? fetch)(endpoint, {
      headers: {
        Authorization: `Bearer ${token}`,
        "x-api-key": token,
      },
      cache: "no-store",
      signal: AbortSignal.timeout(2_000),
    });
    if (!response.ok) return undefined;
    const prices = parse9RouterPricing(await response.json());
    return Object.keys(prices).length > 0
      ? { endpointHost: endpoint.host, prices }
      : undefined;
  } catch {
    return undefined;
  }
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
 *  - The price table does not know the model, or the ledger does not establish API billing. An
 *    unknown price is unknown, not free. In particular, an unrouted row (`null`) may be a Claude
 *    subscription call, which is not token-billed at Anthropic API list rates.
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
  endpointHost?: string | null,
  gatewayPricing?: GatewayPricing,
): number | undefined {
  // `undefined` is retained for pure callers that deliberately ask for an API-rate equivalent.
  // Persisted rows always carry `null` or a host. Null means the CLI used its default transport,
  // whose billing mode (subscription vs API key) is unknown; do not invent a charge. A supplied
  // gateway table is therefore an explicit, caller-owned rate snapshot, never an implicit lookup.
  const price = endpointHost === undefined
    ? priceOf(model)
    : endpointHost === null
      ? undefined
      : endpointHost === "api.anthropic.com"
        ? priceOf(model)
        : gatewayPricing?.endpointHost === endpointHost
          ? gatewayPricing.prices[model ?? ""] ?? gatewayPricing.prices[normalizeModelId(model)]
          : undefined;
  if (!price || !hasAnyCount(counts)) return undefined;

  const input = count(counts.inputTokens);
  const output = count(counts.outputTokens);
  const cacheRead = count(counts.cacheReadInputTokens);
  const cacheWrite = count(counts.cacheCreationInputTokens);
  if ((cacheRead > 0 && price.cacheRead === undefined) ||
      (cacheWrite > 0 && price.cacheWrite5m === undefined)) return undefined;

  const tokens =
    input * price.input +
    output * price.output +
    cacheRead * (price.cacheRead ?? 0) +
    cacheWrite * (price.cacheWrite5m ?? 0);

  return tokens / PER_MILLION + count(counts.webSearchRequests) * WEB_SEARCH_USD_PER_REQUEST;
}

/** A ledger row as this module reads it: the model it reported usage under, plus the counts. */
export interface PriceableRow extends TokenCounts {
  modelReported: string | null;
  /** A routed endpoint has its own billing contract and is unpriced until anton knows its rates. */
  endpointHost?: string | null;
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
export function totalCost(rows: readonly PriceableRow[], gatewayPricing?: GatewayPricing): SpendCost {
  const unknown = new Map<string, number>();
  let usd = 0;
  let priced = 0;

  for (const row of rows) {
    const cost = costOf(row.modelReported, row, row.endpointHost, gatewayPricing);
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
