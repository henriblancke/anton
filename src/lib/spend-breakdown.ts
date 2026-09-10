/**
 * Where the money and the tokens went (anton-1kdm): one project's ledger rows folded by MODEL and by
 * TASK, over a window.
 *
 * The sibling tickets made the facts recordable and priceable; this is the read that makes them
 * answerable. It exists as its own pure module rather than inside the page for the reason
 * `model-pricing` and `model-divergence` do: the server component, the test and any later CLI read
 * the same fold instead of three that drift.
 *
 * Three rules are load-bearing, and all three are about NOT lying with a number:
 *
 *  - MEASURED, not estimated. Every figure here is derived from counts a result event reported,
 *    which is the opposite of `quota-share`'s sampled attribution. It must therefore NEVER borrow
 *    that path's `≈` marker (see {@link formatUsd}) — the marker is what separates a pacing target
 *    from a ledger, and wearing it here would throw away the only thing this feature adds.
 *  - An unpriced model is TOKENS-ONLY, never free. A group anton has no price for reports its tokens
 *    and `usd: undefined`; folding it in as 0 would understate the project total with no sign
 *    anything was missing. The group carries `priced`/`unpriced` row counts so a partially-priced
 *    group can say so rather than quietly rounding down.
 *  - Nothing recorded is EMPTY, not zero. A project with no rows in the window returns
 *    `recorded: false` and no groups. "We measured nothing" and "we measured zero spend" are
 *    opposite facts about a project, and collapsing them is exactly the failure the whole feature
 *    was built to end.
 *
 * Pure and dependency-free — no db, no node builtins — so it is importable from a client component.
 */
import { DISPLAY_LOCALE } from "./time";
import { costOf, type GatewayPricing, type PriceableRow } from "./model-pricing";

/** The columns a breakdown row is folded from: the counts, plus the dimensions grouped on. */
export interface SpendRow extends PriceableRow {
  jobType: string | null;
  step: string | null;
  /** Reported for completeness. A SUBSET of `outputTokens`, so it is never added into a total. */
  thinkingTokens?: number | null;
}

/** Which dimension a breakdown groups on — the two questions the ticket names. */
export type SpendDimension = "model" | "task";

/** The token totals of one group. Summed across rows, so absent counts contribute nothing. */
export interface TokenTotals {
  input: number;
  output: number;
  /** Inside {@link output}, not additional to it — see model-pricing's header. */
  thinking: number;
  cacheRead: number;
  cacheWrite: number;
  webSearches: number;
  /** What a single "tokens" column shows: input + output + cache reads + cache writes. */
  total: number;
}

/** One row of a breakdown: a model, or a job type / pipeline step. */
export interface SpendGroup {
  /** The grouping value as stored — a model id, a job type, or a step. */
  key: string;
  /** How it reads in the UI. Falls back to a named placeholder when the dimension was null. */
  label: string;
  tokens: TokenTotals;
  /**
   * USD across the rows anton could price, or **undefined when it could price none of them**. Never
   * 0 for an unpriced group: see the header.
   */
  usd: number | undefined;
  /** Ledger rows in this group that produced a dollar figure. */
  priced: number;
  /** Rows that did not — an unknown model, or an invocation that reported no counts at all. */
  unpriced: number;
  /** Ledger rows folded into this group. `priced + unpriced`. */
  rows: number;
}

/** A whole breakdown: the groups, plus what the window itself says about its own completeness. */
export interface SpendBreakdown {
  dimension: SpendDimension;
  /** Groups, largest first — by cost where anton has one, then by tokens. */
  groups: SpendGroup[];
  /** The window's totals across every group, priced and unpriced alike. */
  tokens: TokenTotals;
  /** USD across every group anton could price. `undefined` when it could price nothing at all. */
  usd: number | undefined;
  /**
   * Whether the ledger holds ANY row for this window. False is the empty state — it must render as
   * "nothing recorded", never as `$0.00`.
   */
  recorded: boolean;
  rows: number;
  priced: number;
  unpriced: number;
  /**
   * The distinct model ids anton has no price for, most-seen first. The actionable half of an
   * incomplete total: it names what to add to the price table, or which gateway is unpriceable.
   */
  unpricedModels: string[];
}

/** How a null dimension reads. Named rather than blank — an unattributed row is still a fact. */
export const UNATTRIBUTED_LABEL = "unattributed";

/** How a row with no model reported reads: a crashed result, which measured nothing. */
export const UNKNOWN_MODEL_LABEL = "model not reported";

const ZERO_TOKENS: TokenTotals = {
  input: 0,
  output: 0,
  thinking: 0,
  cacheRead: 0,
  cacheWrite: 0,
  webSearches: 0,
  total: 0,
};

/** A reported count, or 0 — absent and unreadable both contribute nothing, as in model-pricing. */
function count(value: number | null | undefined): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

/** One row's counts added into a running total. Mutates on purpose; the caller owns the object. */
function addTokens(into: TokenTotals, row: SpendRow): void {
  into.input += count(row.inputTokens);
  into.output += count(row.outputTokens);
  into.thinking += count(row.thinkingTokens);
  into.cacheRead += count(row.cacheReadInputTokens);
  into.cacheWrite += count(row.cacheCreationInputTokens);
  into.webSearches += count(row.webSearchRequests);
  // Thinking is excluded deliberately: it is a subset of output, and adding it would double-count.
  into.total = into.input + into.output + into.cacheRead + into.cacheWrite;
}

/**
 * The grouping key and label for one row on one dimension.
 *
 * The TASK dimension prefers the pipeline step over the job type, because the step is the finer and
 * more actionable answer — "review cost more than implement" is a routing decision, "execute-epic
 * cost the most" is not. It falls back to the job type for the passes that run outside the ticket
 * pipeline (gardener, product-master), which carry no step at all.
 */
function groupKey(row: SpendRow, dimension: SpendDimension): { key: string; label: string } {
  if (dimension === "model") {
    const model = row.modelReported?.trim();
    return model ? { key: model, label: model } : { key: "", label: UNKNOWN_MODEL_LABEL };
  }
  const step = row.step?.trim();
  if (step) return { key: step, label: step };
  const jobType = row.jobType?.trim();
  return jobType ? { key: jobType, label: jobType } : { key: "", label: UNATTRIBUTED_LABEL };
}

/**
 * Whether this group can be priced AT ALL, which the model dimension answers per group and the task
 * dimension cannot: a `review` step that ran opus once and a gateway's own model once is partly
 * priceable, and its dollar figure is real but incomplete — hence `priced`/`unpriced` beside it.
 */
function accumulate(group: SpendGroup, row: SpendRow, cost: number | undefined): void {
  addTokens(group.tokens, row);
  group.rows += 1;
  if (cost === undefined) {
    group.unpriced += 1;
    return;
  }
  group.priced += 1;
  group.usd = (group.usd ?? 0) + cost;
}

/**
 * Cost first — it is the question asked — then tokens, then the label so ties are stable.
 *
 * An unpriced group sorts BELOW every priced one (the `-1`) and is ranked among its peers by tokens.
 * Deliberate: a dollar ordering that interleaved groups with no dollar figure would be ordering on a
 * number half the rows do not have. Those groups are flagged in the row itself, so they are found
 * rather than buried.
 */
function bySpend(a: SpendGroup, b: SpendGroup): number {
  return (
    (b.usd ?? -1) - (a.usd ?? -1) ||
    b.tokens.total - a.tokens.total ||
    a.label.localeCompare(b.label)
  );
}

/**
 * Fold one project's ledger rows into a breakdown on one dimension.
 *
 * Grain note: the rows are per (invocation, model), which is the right grain for BOTH dimensions —
 * an opus invocation's haiku sidecar belongs to haiku's row on the model breakdown and to its step's
 * row on the task breakdown, and it is billed at haiku's rates in each.
 */
export function breakdownBy(
  rows: readonly SpendRow[],
  dimension: SpendDimension,
  gatewayPricing?: GatewayPricing,
): SpendBreakdown {
  const groups = new Map<string, SpendGroup>();
  const tokens: TokenTotals = { ...ZERO_TOKENS };
  const unknownModels = new Map<string, number>();
  let usd: number | undefined;
  let priced = 0;

  for (const row of rows) {
    const cost = costOf(row.modelReported, row, row.endpointHost, gatewayPricing);
    const { key, label } = groupKey(row, dimension);
    const group = groups.get(key) ?? {
      key,
      label,
      tokens: { ...ZERO_TOKENS },
      usd: undefined,
      priced: 0,
      unpriced: 0,
      rows: 0,
    };
    accumulate(group, row, cost);
    groups.set(key, group);

    addTokens(tokens, row);
    if (cost === undefined) {
      // Only a NAMED model is worth reporting back — a row with no model names nothing to add.
      const model = row.modelReported?.trim();
      if (model) unknownModels.set(model, (unknownModels.get(model) ?? 0) + 1);
      continue;
    }
    usd = (usd ?? 0) + cost;
    priced += 1;
  }

  return {
    dimension,
    groups: [...groups.values()].sort(bySpend),
    tokens,
    usd,
    recorded: rows.length > 0,
    rows: rows.length,
    priced,
    unpriced: rows.length - priced,
    unpricedModels: [...unknownModels.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([model]) => model),
  };
}

/**
 * Whether a group's dollar figure covers everything in it.
 *
 * A partial figure is worse than no figure when it reads as a total, so the UI needs this to decide
 * between showing the number plainly and showing it as a floor.
 */
export function isCompletelyPriced(group: SpendGroup): boolean {
  return group.unpriced === 0 && group.priced > 0;
}

/**
 * Whether this group is unpriceable rather than merely unmeasured — the difference between "we know
 * the tokens but not the price" (a gateway's model: show tokens, no dollars) and "we know nothing"
 * (a crashed invocation: show a dash).
 */
export function hasMeasuredTokens(group: SpendGroup): boolean {
  return group.tokens.total > 0 || group.tokens.webSearches > 0;
}

/** The chosen windows. Named in days so the label and the cutoff cannot disagree. */
export const SPEND_WINDOWS = [
  { value: "24h", label: "Last 24 hours", hours: 24 },
  { value: "7d", label: "Last 7 days", hours: 24 * 7 },
  { value: "30d", label: "Last 30 days", hours: 24 * 30 },
  { value: "all", label: "All time", hours: null },
] as const;

export type SpendWindow = (typeof SPEND_WINDOWS)[number]["value"];

export const DEFAULT_SPEND_WINDOW: SpendWindow = "7d";

/** A URL value → a window, falling back to the default rather than rejecting. */
export function normalizeWindow(raw: string | null | undefined): SpendWindow {
  return SPEND_WINDOWS.some((w) => w.value === raw)
    ? (raw as SpendWindow)
    : DEFAULT_SPEND_WINDOW;
}

/** The window's cutoff, or undefined for all-time — the shape `invocationSpend` takes as `since`. */
export function windowSince(window: SpendWindow, now = Date.now()): Date | undefined {
  const hours = SPEND_WINDOWS.find((w) => w.value === window)?.hours;
  return hours == null ? undefined : new Date(now - hours * 3600 * 1000);
}

const TOKEN_FORMAT = new Intl.NumberFormat(DISPLAY_LOCALE, {
  notation: "compact",
  maximumFractionDigits: 1,
});

/**
 * A token count, compacted — `1.2M`, `84.3K`, `912`. Counts here run to millions on a single run,
 * and a full-precision figure in a dense table is read as noise rather than as a number.
 *
 * NO approximation marker, deliberately. The compaction rounds the DISPLAY, not the measurement; the
 * exact figure rides along in the cell's `title`. `≈` on this path would say the underlying number
 * is sampled, which is precisely the confusion this feature exists to remove.
 */
export function formatTokens(tokens: number): string {
  return TOKEN_FORMAT.format(tokens);
}

/** The exact count, for the hover title the compact figure abbreviates. */
export function formatExactTokens(tokens: number): string {
  return tokens.toLocaleString(DISPLAY_LOCALE);
}

/**
 * A derived dollar figure. `undefined` reads as "no price", NEVER as `$0.00` — an unknown price is
 * unknown, and the whole module exists to keep those apart.
 *
 * Sub-cent amounts get four decimals rather than rounding to `$0.00`: a single cheap invocation is
 * genuinely worth a fraction of a cent, and rounding it away reads as free.
 */
export function formatUsd(usd: number | undefined): string {
  if (usd === undefined) return "—";
  if (usd > 0 && usd < 0.01) return `$${usd.toFixed(4)}`;
  return `$${usd.toFixed(2)}`;
}
