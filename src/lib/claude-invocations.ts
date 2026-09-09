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
import { and, desc, eq, gte } from "drizzle-orm";
import { ANTHROPIC_BASE_URL_ENV } from "./claude/endpoint";
import type { ClaudeResult, RunClaudeOptions } from "./claude/driver";
import type { ModelUsageEntry } from "./claude/model-usage";
import { getDb, schema } from "./db";
import {
  divergenceSummary,
  groupInvocations,
  type DivergenceSummary,
  type InvocationFact,
} from "./model-divergence";
import { totalCost, type SpendCost } from "./model-pricing";
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
}

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
    projectId: dimensions.projectId ?? null,
    jobType: dimensions.jobType ?? null,
    jobId: dimensions.jobId ?? null,
    step: dimensions.step ?? null,
    runId: dimensions.runId ?? null,
    beadId: dimensions.beadId ?? null,
    claudeSessionId: result.sessionId ?? null,
    modelRequested: dimensions.modelRequested ?? null,
    endpointHost: hostOf(dimensions.baseUrl) ?? null,
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
  projectId: string,
  opts: { since?: Date; limit?: number } = {},
): Promise<ClaudeInvocationRow[]> {
  const where = opts.since
    ? and(
        eq(schema.claudeInvocations.projectId, projectId),
        gte(schema.claudeInvocations.recordedAt, opts.since),
      )
    : eq(schema.claudeInvocations.projectId, projectId);
  const query = db
    .select()
    .from(schema.claudeInvocations)
    .where(where)
    .orderBy(desc(schema.claudeInvocations.recordedAt));
  return opts.limit === undefined ? query : query.limit(opts.limit);
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
  projectId: string,
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
 * Wrap a claude driver so every invocation THROUGH it is metered (anton-77l9).
 *
 * A wrapper rather than a call inside each dispatch, for the reason `dispatchClaude` itself is
 * shared: the ledger's value is that it holds EVERY invocation, and a per-site recording call is one
 * a new dispatch site forgets. Shaped exactly like the driver, so it composes with the resume-aware
 * driver the run already wraps (`resilientClaude`) and drops into the same `deps.runClaude` seam.
 *
 * The grain is one recorded invocation per RESULT. A dispatch whose transient death is retried
 * in-session produces one result and one recorded invocation, which is honest in both directions: a
 * mid-stream death emits no result event at all, so its usage is not merely unrecorded but unknown,
 * and its tokens are already inside the resumed session's cumulative `modelUsage`.
 *
 * A throw passes straight through — the ledger records what was spent, never what failed; the run
 * row and the session log own the failure.
 */
export function metered(
  db: AntonDb,
  clock: Clock,
  dimensions: InvocationDimensions,
  driver: (options: RunClaudeOptions) => Promise<ClaudeResult>,
): (options: RunClaudeOptions) => Promise<ClaudeResult> {
  return async (options) => {
    const result = await driver(options);
    await recordInvocation(db, clock, {
      ...dimensions,
      // The model as SPAWNED, which is what the result's usage answers for — the caller's dimension
      // is only the default for a driver invoked with no model of its own.
      modelRequested: options.model ?? dimensions.modelRequested,
      baseUrl: dimensions.baseUrl ?? process.env[ANTHROPIC_BASE_URL_ENV],
    }, result);
    return result;
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
