/**
 * Requested vs served (anton-r0y6): did the model anton ASKED for answer the invocation?
 *
 * A gateway's whole value proposition is silent fallback — 9Router's documented behaviour is a
 * three-tier drop from subscription to cheap to free — so a request for a strong model can be
 * served by a weak one with no error and no failed run. A routing table tuned against silently
 * substituted models is superstition, so the ledger's two model columns are compared rather than
 * assumed equal, and the verdict rides along with the spend read.
 *
 * Two rules are load-bearing:
 *
 *  - The verdict is per INVOCATION, never per row. The fact table's grain is (invocation, model),
 *    and a perfectly ordinary opus invocation reports a `claude-haiku-*` row too — the sidecar model
 *    Claude Code runs for its own small tasks. Comparing a single row's `model_reported` against its
 *    `model_requested` therefore flags every run ever recorded, which is precisely the noise
 *    criterion 3 forbids. An invocation is SERVED when any model it reported matches the request.
 *  - Matching is normalized, not string equality. The request is anton's spelling (`claude-opus-4-8`,
 *    or a `--model` alias), while the report is the serving side's (`claude-opus-4-8-20260115`,
 *    `anthropic/claude-opus-4-8`, a Bedrock arn-ish id). Comparing raw would call every unrouted
 *    project diverged, which is the same false alarm from the other direction.
 *
 * Derived on READ rather than stored on write, deliberately: normalization is the part of this that
 * will keep learning new id spellings, and a stored verdict would freeze today's rules into rows
 * nobody can revise. It also keeps the answer out of a column nobody queries.
 *
 * Pure and dependency-free — no db, no node builtins — so a server component and the read path can
 * share one definition of "diverged" instead of drifting apart.
 */

/** Whether the requested model is the one that answered. */
export type ModelDivergence =
  /** A reported model matched the request. */
  | "served"
  /** A request, models reported, and none of them was it — the gateway substituted. */
  | "diverged"
  /**
   * The question cannot be asked: the invocation reported no model at all (a crashed or
   * startup-error result), or anton named none and took the CLI's own default. Never "diverged" —
   * an unanswerable question is not a finding.
   */
  | "unknown";

/** The columns a divergence verdict is read from. Structural, so it takes a row or a test fixture. */
export interface InvocationModelRow {
  modelRequested: string | null;
  modelReported: string | null;
}

/** Everything shared by the rows of ONE invocation — what regroups them without an invocation id. */
export interface InvocationDimensionRow extends InvocationModelRow {
  projectId: string | null;
  jobType: string | null;
  jobId: string | null;
  step: string | null;
  runId: string | null;
  beadId: string | null;
  claudeSessionId: string | null;
  endpointHost: string | null;
  outcome: string;
  recordedAt: Date;
}

/** One invocation's rows, regrouped, with the requested-vs-served verdict attached. */
export interface InvocationFact<Row extends InvocationDimensionRow> {
  /** The rows this invocation wrote — one per model it reported usage under. */
  rows: Row[];
  /** The model anton asked for, null when it took claude's default. */
  modelRequested: string | null;
  /** Every model the result reported usage under, in row order. Empty when usage was unknown. */
  modelsReported: string[];
  divergence: ModelDivergence;
  runId: string | null;
  beadId: string | null;
  step: string | null;
  jobType: string | null;
  endpointHost: string | null;
  outcome: string;
  recordedAt: Date;
}

/** One requested → served substitution, and how often it was observed. */
export interface Substitution {
  requested: string;
  /** What answered instead, as the serving side spelled it. */
  served: string[];
  count: number;
}

/** What a spend read says about routing over its window. */
export interface DivergenceSummary {
  /** Invocations in the window — NOT rows, which are per model and would overstate the count. */
  invocations: number;
  diverged: number;
  /** Invocations that could not be judged: no model reported, or none requested. */
  unknown: number;
  /** Every substitution seen, most frequent first. EMPTY when nothing diverged — the quiet case. */
  substitutions: Substitution[];
}

/** Vendor and route prefixes: `anthropic/`, `us.anthropic.`, `claude-`. Stripped repeatedly. */
const VENDOR_PREFIX = /^(?:[a-z]{2,4}\.)?anthropic[./-]|^claude[.-]/;

/**
 * Suffixes that name the same model: a pinned release date, `-latest`, a Bedrock `-v1:0` revision,
 * and the bracketed context-window variant (`[1m]`). The variant is deliberately ignored — a 1M
 * request served at the standard window is the model anton asked for, and calling that a
 * substitution would bury the gateway swaps this exists to find.
 */
const ALIAS_SUFFIX = /(?:\[[^\]]*\]|[-@:](?:\d{8}|latest|preview|v\d+(?::\d+)*))$/;

/** Trailing separators left behind once a suffix comes off. */
const TRAILING_SEPARATOR = /[-._:]+$/;

/**
 * A model id reduced to what identifies the MODEL — lowercased, with the serving side's route,
 * vendor and release spellings removed. `cc/claude-opus-5[1m]`, `claude-opus-5-20260115` and
 * `anthropic/claude-opus-5` all reduce to `opus-5`.
 *
 * Lossy on purpose. It answers "is this the same model", never "which exact build served it" — the
 * raw ids are still on the rows for anyone who needs the second question.
 */
export function normalizeModelId(raw: string | null | undefined): string {
  let id = (raw ?? "").trim().toLowerCase();
  // The route, not the model: `cc/claude-opus-5`, `anthropic/claude-opus-5`, a gateway's own path.
  const slash = id.lastIndexOf("/");
  if (slash >= 0) id = id.slice(slash + 1);

  // Prefixes and suffixes come off until nothing more does — a Bedrock id carries two of each.
  for (let previous = ""; previous !== id; ) {
    previous = id;
    id = id.replace(VENDOR_PREFIX, "").replace(ALIAS_SUFFIX, "").replace(TRAILING_SEPARATOR, "");
  }
  return id;
}

/** `b` extends `a` at a segment boundary — `opus` covers `opus-4-8`, but never `opusx`. */
function extendsAtSegment(a: string, b: string): boolean {
  return b.startsWith(a) && (b.length === a.length || /[-._:]/.test(b[a.length]));
}

/**
 * The requested and the reported id name the same model.
 *
 * Equality after normalization, plus segment-boundary containment either way — that is what lets the
 * alias anton requests (`opus`, `claude-opus-4-8`) match the pinned id a result reports, without
 * letting `opus-4-8` match `opus-4-5`.
 */
export function modelsMatch(requested: string | null, reported: string | null): boolean {
  const a = normalizeModelId(requested);
  const b = normalizeModelId(reported);
  if (!a || !b) return false;
  return extendsAtSegment(a, b) || extendsAtSegment(b, a);
}

/**
 * The verdict for ONE invocation, from the model it asked for and every model it reported.
 *
 * `unknown` covers both unanswerable shapes — nothing reported, or nothing requested — because
 * neither is evidence of a substitution, and reporting one as a divergence is the noise that makes
 * an operator stop reading the column.
 */
export function classifyDivergence(
  requested: string | null,
  reported: readonly (string | null)[],
): ModelDivergence {
  const served = reported.filter((model): model is string => Boolean(model?.trim()));
  if (!requested?.trim() || served.length === 0) return "unknown";
  return served.some((model) => modelsMatch(requested, model)) ? "served" : "diverged";
}

/**
 * The dimensions that are identical across one invocation's rows, as a grouping key.
 *
 * The fact table has no invocation id — one invocation writes N rows that differ only in the model
 * and its counts — so identity is reconstructed from everything the rows share, `recorded_at`
 * included (it is stamped once per invocation, not once per row). Two invocations that agreed on
 * every dimension AND landed in the same second would merge; they would also share one verdict, so
 * the merge costs the count and never the answer.
 */
function invocationKey(row: InvocationDimensionRow): string {
  return JSON.stringify([
    row.projectId,
    row.jobType,
    row.jobId,
    row.step,
    row.runId,
    row.beadId,
    row.claudeSessionId,
    row.modelRequested,
    row.endpointHost,
    row.outcome,
    row.recordedAt?.getTime() ?? null,
  ]);
}

/**
 * Ledger rows → one {@link InvocationFact} per invocation, in first-seen row order.
 *
 * This is the regrouping the per-row grain forces: the verdict is a property of the invocation, and
 * a row on its own cannot answer it (a subagent's haiku row would read as a substitution in every
 * opus run ever recorded).
 */
export function groupInvocations<Row extends InvocationDimensionRow>(
  rows: readonly Row[],
): InvocationFact<Row>[] {
  const byInvocation = new Map<string, InvocationFact<Row>>();

  for (const row of rows) {
    const key = invocationKey(row);
    const fact = byInvocation.get(key);
    if (fact) {
      fact.rows.push(row);
      if (row.modelReported) fact.modelsReported.push(row.modelReported);
      continue;
    }
    byInvocation.set(key, {
      rows: [row],
      modelRequested: row.modelRequested,
      modelsReported: row.modelReported ? [row.modelReported] : [],
      // Provisional: replaced below, once every row of the invocation has been seen.
      divergence: "unknown",
      runId: row.runId,
      beadId: row.beadId,
      step: row.step,
      jobType: row.jobType,
      endpointHost: row.endpointHost,
      outcome: row.outcome,
      recordedAt: row.recordedAt,
    });
  }

  return [...byInvocation.values()].map((fact) => ({
    ...fact,
    divergence: classifyDivergence(fact.modelRequested, fact.modelsReported),
  }));
}

/** Only the invocations a gateway served with something else. Empty for an unrouted project. */
export function divergedInvocations<Row extends InvocationDimensionRow>(
  facts: readonly InvocationFact<Row>[],
): InvocationFact<Row>[] {
  return facts.filter((fact) => fact.divergence === "diverged");
}

/**
 * What the spend read reports about routing: how many invocations were judged, how many were served
 * by something else, and which substitutions those were.
 *
 * A project whose models always agree summarizes to zero diverged and NO substitutions — the
 * silence is the point. Unknowns are counted separately rather than folded into either side.
 */
export function divergenceSummary<Row extends InvocationDimensionRow>(
  facts: readonly InvocationFact<Row>[],
): DivergenceSummary {
  const substitutions = new Map<string, Substitution>();

  for (const fact of divergedInvocations(facts)) {
    // Keyed by the raw spellings, not the normalized ones: an operator deciding whether to keep a
    // route needs to see the id the gateway actually answered with.
    const key = JSON.stringify([fact.modelRequested, fact.modelsReported]);
    const seen = substitutions.get(key);
    if (seen) seen.count += 1;
    else {
      substitutions.set(key, {
        requested: fact.modelRequested ?? "",
        served: [...fact.modelsReported],
        count: 1,
      });
    }
  }

  return {
    invocations: facts.length,
    diverged: facts.filter((fact) => fact.divergence === "diverged").length,
    unknown: facts.filter((fact) => fact.divergence === "unknown").length,
    substitutions: [...substitutions.values()].sort(
      (a, b) => b.count - a.count || a.requested.localeCompare(b.requested),
    ),
  };
}
