/**
 * The per-invocation spend ledger (anton-77l9): what each `claude` invocation actually cost, in
 * tokens, measured from the result event rather than estimated after the fact.
 *
 * One row per (invocation, model), written once as the invocation ends. It is a FACT table — rows
 * are append-only and are never revised, because the dimensions they carry (the requested model, the
 * endpoint, the formula step) are only true at the moment the invocation ran and are gone by the
 * time anyone asks. That is the same reason `runs` stores `model`/`formula` rather than deriving
 * them, one level finer.
 *
 * Two rules are load-bearing and both come from the field itself:
 *
 *  - `modelUsage` is CUMULATIVE per session. What is recorded is the latest result's map, so two
 *    results in one session record the latest figures and never their sum (see claude/model-usage.ts).
 *    A resumed invocation is its own invocation and gets its own rows.
 *  - Recording NEVER fails a run. Unknown usage is recorded as one row with null counts, and a write
 *    that throws is swallowed: a run that did the work must not fail because a meter could not be
 *    written. Losing the row loses the fact that the invocation happened at all, which is worse than
 *    a row with nothing but its dimensions on it.
 *
 * `cost_usd` is what claude itself reported, stored as reported and NEVER read back as anton's
 * answer to what something cost — see `model-pricing.ts`, which derives dollars from these token
 * counts and a price table anton owns. That column is kept only as the vendor's claim.
 *
 * db-injectable, like `runs` and `picker-starts`: the handler and its tests share one connection.
 */
import { randomUUID } from "node:crypto";
import { and, desc, eq, gte, inArray, sql } from "drizzle-orm";
import { selfBuildVersion } from "./build/drift";
import type { ClaudeResult, RunClaudeOptions } from "./claude/driver";
import type { ModelUsageEntry } from "./claude/model-usage";
import { systemPromptDigest } from "./claude/system-prompt";
import { getDb, schema } from "./db";
import {
  divergenceSummary,
  groupInvocations,
  type DivergenceSummary,
  type InvocationFact,
} from "./model-divergence";
import { totalCost, type GatewayPricing, type SpendCost } from "./model-pricing";
import { breakdownBy, type SpendBreakdown } from "./spend-breakdown";
import type { AntonDb, Clock } from "./jobs/queue";

/** How an invocation ended, as claude itself reported it. */
export type InvocationOutcome = "ok" | "error";

/**
 * The dimensions of ONE invocation — everything about it that is not measured. Every field but the
 * project is optional: the passes outside the ticket pipeline have no run, ticket or formula step to
 * name, and recording their spend without those is the point of the nulls.
 */
export interface InvocationDimensions {
  projectId?: string;
  /** The queue job type that dispatched it, so a project's spend splits by what anton was doing. */
  jobType?: string;
  jobId?: string;
  /** The formula step (`implement`, `review`, a project's own `step:claude` id), or a pass's name. */
  step?: string;
  runId?: string;
  beadId?: string;
  /** The model anton asked for — absent when the invocation took claude's default. */
  modelRequested?: string;
  /**
   * The gateway base URL this invocation was routed to, if any. Reduced to its HOST before storage
   * (see {@link hostOf}) — a base URL can carry a path or a query, and neither is worth the risk of
   * a credential in one.
   */
  baseUrl?: string;
  /**
   * The specialist that ran: the ticket's resolved `agent:<tag>`, absent when it named none.
   *
   * Per-INVOCATION rather than per-run, unlike `runs.agent_tag`. `agent:` is a per-ticket label, so
   * a run whose three tickets used three specialists records one of them at the run grain — and
   * "was this agent worth its cost" is unanswerable from a dimension that coarse.
   */
  agentTag?: string;
  /**
   * The reasoning text a `step:claude` resolved — WHICH instruction, and (for a skill) at what
   * version. Mutually exclusive by construction: `loadStepReasoning` dispatches exactly one.
   *
   * Versioned because a skill resolves project-local-first and is edited in place, so the same
   * `skill:review` is different text in another repo and different text in this one next week.
   * Recording only the id would pool two cohorts that ran different instructions under one key.
   */
  promptId?: string;
  /**
   * 12-hex content digest of the resolved PROMPT body a `prompt:<id>` step named — the sibling of
   * {@link skillDigest}. `promptId` resolves project-local-first and is edited in place, so the id
   * alone would pool two cohorts that ran different instructions under one key, exactly as an
   * unversioned `skillId` would. Distinct from {@link promptDigest}, which digests the composed
   * SYSTEM prompt (base + agent + seed) rather than this step's USER-prompt instruction text.
   */
  promptBodyDigest?: string;
  skillId?: string;
  skillDigest?: string;
  /**
   * 12-hex digest of the COMPOSED system prompt this invocation ran with (anton-tw37r). Passed by
   * the caller that composed it, never re-composed here: the text is edited in place, so a second
   * composition could digest a prompt that never ran.
   */
  promptDigest?: string;
  /**
   * 12-hex content digest of the cooked pipeline the run walked (anton-jpmdw). `runs.formula` is a
   * path, and a path says nothing about a formula edited between two runs that both name it.
   */
  formulaDigest?: string;
  /**
   * The resolved `stepName(step)` — the HANDLER, not the author's step id already in {@link step}.
   * A project formula names its steps freely, so the id matches no phase predicate, and the id →
   * handler mapping is itself editable: the classification cannot be reconstructed later.
   */
  stepHandler?: string;
  /**
   * The anton release + revision that ran it. Resolved INSIDE {@link metered} when a caller omits
   * it, so a site that passes no stamps at all still records which anton produced the row.
   */
  antonVersion?: string;
}

/**
 * The identity of a resolved reasoning contract that rides in `options.prompt` rather than
 * `appendSystemPrompt` — self-review, PR-fix, product-master, scan-triage (anton-z33ia, PR #313
 * review). `metered` only digests the composed SYSTEM prompt; a pass whose editable contract (an
 * operator's override text, or one of anton's shipped skills) instead sits in the USER prompt beside
 * mutable run context (a diff, a board, a scan) would otherwise leave every such row un-attributed
 * to what it actually ran under — a rewritten skill or a changed operator prompt pools silently into
 * the same cohort as before.
 *
 * A skill id/digest pair, or a prompt id/digest pair, identifies a NAMED, versioned source (mirrors
 * `StepReasoning`); a bare `promptBodyDigest` with no `promptId` covers free-form operator text with
 * no id of its own (`step:describe`'s `describePrompt` setting, `resolveReviewerContract`'s operator
 * prompt). `promptId`/`skillId` are mutually exclusive by construction — a resolver returns one
 * named source or the other, never both — and either may be absent, which is the free-form case.
 */
export type ReasoningAttribution = Pick<
  InvocationDimensions,
  "promptId" | "promptBodyDigest" | "skillId" | "skillDigest"
>;

/**
 * A base URL → its host, or undefined when there is none or it does not parse. Deliberately lossy:
 * the dimension worth grouping spend by is WHICH endpoint served it, and the host answers that
 * without storing anything a URL's path or query might carry.
 */
export function hostOf(baseUrl: string | undefined): string | undefined {
  if (!baseUrl?.trim()) return undefined;
  try {
    return new URL(baseUrl).host || undefined;
  } catch {
    return undefined;
  }
}

/** The rows one invocation produces, before ids and timestamps — the pure half, so it is testable. */
export function invocationRows(
  dimensions: InvocationDimensions,
  result: Pick<
    ClaudeResult,
    "ok" | "sessionId" | "numTurns" | "costUsd" | "modelUsage" | "durationMs" | "durationApiMs"
  >,
): Array<Omit<typeof schema.claudeInvocations.$inferInsert, "id" | "recordedAt">> {
  const shared = {
    invocationId: randomUUID(),
    projectId: dimensions.projectId ?? null,
    jobType: dimensions.jobType ?? null,
    jobId: dimensions.jobId ?? null,
    step: dimensions.step ?? null,
    runId: dimensions.runId ?? null,
    beadId: dimensions.beadId ?? null,
    claudeSessionId: result.sessionId ?? null,
    modelRequested: dimensions.modelRequested ?? null,
    endpointHost: hostOf(dimensions.baseUrl) ?? null,
    // The attribution stamps (anton-z33ia), each null when genuinely absent. A NULL here is a fact
    // about the invocation — nothing resolved one — and never a placeholder a later read may fill
    // in: rows written before these columns existed carry nulls forever, so every reader tolerates
    // them already.
    promptDigest: dimensions.promptDigest ?? null,
    formulaDigest: dimensions.formulaDigest ?? null,
    antonVersion: dimensions.antonVersion ?? null,
    stepHandler: dimensions.stepHandler ?? null,
    agentTag: dimensions.agentTag ?? null,
    skillId: dimensions.skillId ?? null,
    skillDigest: dimensions.skillDigest ?? null,
    promptId: dimensions.promptId ?? null,
    promptBodyDigest: dimensions.promptBodyDigest ?? null,
    numTurns: result.numTurns ?? null,
    costUsd: result.costUsd ?? null,
    durationMs: result.durationMs ?? null,
    durationApiMs: result.durationApiMs ?? null,
    outcome: (result.ok ? "ok" : "error") satisfies InvocationOutcome,
  };

  // An invocation that reported no readable usage still gets exactly ONE row. The alternative —
  // no row — silently understates the project's spend and erases the invocation itself, which is
  // the fact the table exists to hold.
  if (result.modelUsage.length === 0) return [{ ...shared, modelReported: null }];

  return result.modelUsage.map((usage: ModelUsageEntry) => ({
    ...shared,
    modelReported: usage.model,
    inputTokens: usage.inputTokens ?? null,
    outputTokens: usage.outputTokens ?? null,
    thinkingTokens: usage.thinkingTokens ?? null,
    cacheReadInputTokens: usage.cacheReadInputTokens ?? null,
    cacheCreationInputTokens: usage.cacheCreationInputTokens ?? null,
    webSearchRequests: usage.webSearchRequests ?? null,
  }));
}

/**
 * Record one finished invocation: one row per model it reported usage for, or a single
 * unknown-usage row when it reported none.
 *
 * Best-effort by contract — it NEVER throws. A meter that cannot be written must not fail a run
 * that did its work, and every caller sits on the success path of a dispatch that has already
 * spent the quota this row would have accounted for.
 */
export async function recordInvocation(
  db: AntonDb,
  clock: Clock,
  dimensions: InvocationDimensions,
  result: Parameters<typeof invocationRows>[1],
): Promise<void> {
  try {
    const recordedAt = new Date(Math.floor(clock.now() / 1000) * 1000);
    const rows = invocationRows(dimensions, result).map((row) => ({
      ...row,
      id: randomUUID(),
      recordedAt,
    }));
    await db.insert(schema.claudeInvocations).values(rows);
  } catch {
    // Swallowed on purpose — see the contract above.
  }
}

export type ClaudeInvocationRow = typeof schema.claudeInvocations.$inferSelect;

/** One project's invocations, newest first — the read every spend question starts from. */
export async function listInvocations(
  db: AntonDb,
  projectId: string | undefined,
  opts: { since?: Date; limit?: number } = {},
): Promise<ClaudeInvocationRow[]> {
  const projectFilter = projectId
    ? eq(schema.claudeInvocations.projectId, projectId)
    : undefined;
  const sinceFilter = opts.since
    ? gte(schema.claudeInvocations.recordedAt, opts.since)
    : undefined;
  const where = projectFilter && sinceFilter
    ? and(projectFilter, sinceFilter)
    : projectFilter ?? sinceFilter;
  const rows = await db
    .select()
    .from(schema.claudeInvocations)
    .where(where)
    // Timestamps are intentionally whole-second values, so ties use SQLite's append-only rowid
    // rather than a random UUID. That keeps an invocation limit chronological even under bursts.
    .orderBy(desc(schema.claudeInvocations.recordedAt), desc(sql`rowid`));
  // The table is per (invocation, model), but a caller's limit is in complete driver calls. Slice
  // after regrouping so a sidecar row cannot be shown without the requested model that ran beside it.
  return opts.limit === undefined
    ? rows
    : groupInvocations(rows)
        .slice(0, opts.limit)
        .flatMap((invocation) => invocation.rows);
}

/**
 * One project's invocations for a SET of beads, unordered — the feature ledger's own seek
 * (`claude_invocations_bead_idx`, added for exactly this read). A feature rolls up its whole life,
 * so there is no window to bound this by the way {@link listInvocations} bounds a project's.
 */
export async function invocationsForBeads(
  db: AntonDb,
  projectId: string,
  beadIds: readonly string[],
): Promise<ClaudeInvocationRow[]> {
  if (beadIds.length === 0) return [];
  return db
    .select()
    .from(schema.claudeInvocations)
    .where(
      and(
        eq(schema.claudeInvocations.projectId, projectId),
        inArray(schema.claudeInvocations.beadId, [...new Set(beadIds)]),
      ),
    );
}

/** One project's spend over a window, read as invocations rather than as rows. */
export interface InvocationSpend {
  /**
   * Every invocation in the window, newest first, each carrying its requested-vs-served verdict
   * (anton-r0y6). Regrouped from the per-(invocation, model) rows, which cannot answer it alone.
   */
  invocations: InvocationFact<ClaudeInvocationRow>[];
  /**
   * What the window says about routing. `diverged: 0` with no substitutions for an unrouted
   * project — the read carries the verdict, so it is not a column someone has to think to query.
   */
  divergence: DivergenceSummary;
  /**
   * What the window cost, DERIVED by anton from the stored token counts (anton-j9lf) — never the
   * result event's `cost_usd`, which is priced against a model name that means nothing once a
   * gateway is in the path. Carries its own unpriced remainder, so a routed project's total cannot
   * silently read as complete.
   */
  cost: SpendCost;
}

/**
 * The spend read (anton-r0y6): one project's invocations over a window, with the model anton asked
 * for checked against the model that answered.
 *
 * Divergence rides WITH the spend rather than sitting in its own column, because the question it
 * answers — is this per-model figure attributed to the model I actually chose — is one nobody thinks
 * to ask before reading the numbers, and by then the wrong conclusion is already drawn.
 */
export async function invocationSpend(
  db: AntonDb,
  projectId: string | undefined,
  opts: { since?: Date; limit?: number } = {},
): Promise<InvocationSpend> {
  const rows = await listInvocations(db, projectId, opts);
  const invocations = groupInvocations(rows);
  return {
    invocations,
    divergence: divergenceSummary(invocations),
    // Priced per ROW, not per invocation: the grain that carries the counts is (invocation, model),
    // and an opus invocation's haiku sidecar is billed at haiku's rates.
    cost: totalCost(rows),
  };
}

/**
 * Resolve one attribution stamp, or nothing (anton-234ja). A resolver that THROWS costs that stamp
 * and nothing else — never the row, and never the run that produced it.
 *
 * The ledger's standing rule, applied one level in from {@link recordInvocation}'s own swallow. That
 * one covers a write that fails; this covers the read that feeds it, which is the newer risk: every
 * stamp is resolved from something mutable — a prompt file, a formula, a git checkout — so a broken
 * repository or an unreadable file is a perfectly ordinary way for one to fail. An invocation that
 * did the work must not be lost to it, and a delivery must not be lost to it either.
 *
 * Exported for the call sites, not only for {@link metered}: a site that resolves a stamp of its own
 * does so OUTSIDE this wrapper, where an unguarded throw would reach the dispatch rather than the
 * ledger. The six that exist today pass values already in hand — a label read, a digest the run
 * cooked once — so none needs it yet; a site that grows a resolver must wrap it in this.
 */
export function stampOf<T>(resolve: () => T | undefined): T | undefined {
  try {
    return resolve();
  } catch {
    // Swallowed on purpose — a stamp is a dimension, never a precondition. See the contract above.
    return undefined;
  }
}

/**
 * Wrap a claude driver so every invocation THROUGH it is metered (anton-77l9).
 *
 * A wrapper rather than a call inside each dispatch, for the reason `dispatchClaude` itself is
 * shared: the ledger's value is that it holds EVERY invocation, and a per-site recording call is one
 * a new dispatch site forgets. Shaped exactly like the driver, so it composes with the resume-aware
 * driver the run already wraps (`resilientClaude`) and drops into the same `deps.runClaude` seam.
 *
 * The grain is one recorded invocation per driver call. A dispatch whose transient death is retried
 * in-session produces an error row for the interrupted call and a result row for the retry. A
 * mid-stream death has no result event, so its token usage is unknown — but omitting the invocation
 * entirely would systematically understate spend.
 *
 * The attribution stamps (anton-z33ia) are resolved HERE, not asked of each caller, for the reason
 * the wrapper exists at all: a per-site stamp is one a new dispatch site forgets, exactly as a
 * per-site recording call would be. What a caller already holds it passes (the composed prompt's
 * digest, the run's formula digest, the ticket's agent tag), because re-resolving could answer
 * differently from the resolution that actually ran; what nothing but process state can answer —
 * `anton_version` — this wrapper resolves, so a site passing no stamps at all still records which
 * anton produced the row.
 */
export function metered(
  db: AntonDb,
  clock: Clock,
  dimensions: InvocationDimensions,
  driver: (options: RunClaudeOptions) => Promise<ClaudeResult>,
): (options: RunClaudeOptions) => Promise<ClaudeResult> {
  return async (options) => {
    const invocationDimensions = {
      ...dimensions,
      // The model as SPAWNED, which is what the result's usage answers for — the caller's dimension
      // is only the default for a driver invoked with no model of its own.
      modelRequested: options.model ?? dimensions.modelRequested,
      // Record the route this invocation actually received. A routed child gets its endpoint via
      // the spawn-only env delta, so anton's own process.env is deliberately not authoritative.
      baseUrl:
        dimensions.baseUrl ??
        (options.routing.routed ? options.routing.baseUrl : undefined),
      // The one stamp no call site can be asked for: it is a fact about the PROCESS, not about the
      // dispatch. Guarded, because it reads a git checkout that a broken repository can fail.
      antonVersion: dimensions.antonVersion ?? stampOf(() => selfBuildVersion() ?? undefined),
      // Digested from the text this invocation is SPAWNED with, for the same reason `modelRequested`
      // is taken from the options: that string is what claude actually received. Resolving it here
      // rather than per site is what stamps the sites no shared dispatch covers — every resumed
      // ticket attempt among them (PR #311 review).
      //
      // This covers only `appendSystemPrompt` (the composed base+agent+seed layer). A pass whose
      // OWN editable reasoning contract rides in `options.prompt` instead — self-review, PR-fix,
      // product-master, scan-triage — is not reachable from here at all: that string also carries
      // the run's diff/board/scan context, so digesting the whole thing would mint a fresh cohort
      // per invocation rather than identify the contract. Those callers resolve their own
      // {@link ReasoningAttribution} (`promptBodyDigest`/`skillId`/`skillDigest`) and pass it in
      // `dimensions` before this wrapper ever sees the call (PR #313 review).
      promptDigest:
        dimensions.promptDigest ??
        stampOf(() =>
          options.appendSystemPrompt ? systemPromptDigest(options.appendSystemPrompt) : undefined,
        ),
    };
    try {
      const result = await driver(options);
      await recordInvocation(db, clock, invocationDimensions, result);
      return result;
    } catch (error) {
      // A rejected driver may have consumed tokens before losing its result event. Preserve that
      // fact as unknown usage; the error itself remains the driver's responsibility.
      await recordInvocation(db, clock, invocationDimensions, { ok: false, modelUsage: [] });
      throw error;
    }
  };
}

/** UI/read path over the shared anton.db. */
export function projectInvocations(
  projectId: string,
  opts?: { since?: Date; limit?: number },
): Promise<ClaudeInvocationRow[]> {
  return listInvocations(getDb(), projectId, opts);
}

/** UI/read path for the spend read, verdict included — see {@link invocationSpend}. */
export function projectSpend(
  projectId: string,
  opts?: { since?: Date; limit?: number },
): Promise<InvocationSpend> {
  return invocationSpend(getDb(), projectId, opts);
}

/**
 * One project's spend over a window, folded BOTH ways (anton-1kdm) — the read the spend page makes.
 *
 * Both dimensions come from one query rather than two. They are folds of the same rows, and issuing
 * two reads would let the model total and the task total disagree whenever an invocation lands
 * between them — two numbers that must sum to the same dollar figure, visibly not doing so.
 *
 * NO `limit`: a breakdown that silently dropped the oldest rows of its own window would report a
 * total that is not the window's total, which is the failure mode this whole feature exists to end.
 */
export async function spendBreakdowns(
  db: AntonDb,
  projectId: string | undefined,
  opts: { since?: Date; gatewayPricing?: GatewayPricing } = {},
): Promise<{ model: SpendBreakdown; task: SpendBreakdown; divergence: DivergenceSummary }> {
  const rows = await listInvocations(db, projectId, opts);
  return {
    model: breakdownBy(rows, "model", opts.gatewayPricing),
    task: breakdownBy(rows, "task", opts.gatewayPricing),
    // Carried along for the same reason `invocationSpend` carries it: a per-model figure attributed
    // to a model that did not serve the call is worse than no figure, and nobody thinks to ask.
    divergence: divergenceSummary(groupInvocations(rows)),
  };
}

/** UI/read path for the two breakdowns over the shared anton.db — see {@link spendBreakdowns}. */
export function projectSpendBreakdowns(
  projectId: string,
  opts?: { since?: Date; gatewayPricing?: GatewayPricing },
): Promise<{ model: SpendBreakdown; task: SpendBreakdown; divergence: DivergenceSummary }> {
  return spendBreakdowns(getDb(), projectId, opts);
}
