/**
 * A project's settled runs, each with its cause (anton-olvlt): every failed/parked `runs` row in a
 * window, classified once here so a trend fold (`trendSeries`, not yet built) only BUCKETS what
 * this returns and never re-derives a cause from `runs.error` itself. Keeping the classification
 * off the fold is what makes two runs of the fold over the same window byte-identical even if the
 * classifier's own patterns later change — the fold just reads what this recorded.
 */
import { and, eq, gte, inArray } from "drizzle-orm";
import { schema } from "./db";
import { toEpoch } from "./db/epoch";
import { classifyFailureCause, type FailureCause } from "./failure-cause";
import type { AntonDb } from "./jobs/queue";

/**
 * The park reason `execute-epic-settle.ts` writes verbatim on a quota park — `usage-limit`,
 * optionally trailed by an orphan-PR notice (see `unstick.ts`'s own `USAGE_LIMIT_PARK`). It is an
 * anton-internal marker, never one of the raw Claude usage banners `classifyFailureCause`'s
 * `QUOTA_RE` matches (that regex is scoped to `UsageLimitError.message` text, which this write path
 * deliberately discards in favor of the fixed marker). Checked before the general classifier so a
 * quota park is never left to whatever the classifier makes of a bare `usage-limit` string —
 * `unknown` today, and not guaranteed to stay off `agent` if that pattern's vocabulary ever grows.
 */
const QUOTA_PARK_PREFIX = "usage-limit";

const SETTLED_STATUSES = ["failed", "parked"] as const;

export interface RunCause {
  runId: string;
  cause: FailureCause;
  /** Epoch seconds — `runs.endedAt`, or `updatedAt` on a row written before it was recorded, exactly as {@link import("./runs").listDeliveriesByBead} falls back. */
  settledAt: number;
}

/** A parked row's cause: `quota` for the fixed park marker, else the general classifier. */
function causeOf(status: (typeof SETTLED_STATUSES)[number], error: string | null): FailureCause {
  if (status === "parked" && error?.startsWith(QUOTA_PARK_PREFIX)) return "quota";
  return classifyFailureCause(error);
}

/**
 * Every failed/parked run for `projectId` that settled on or after `since` (all time when
 * `undefined`), each with its cause and settle time.
 *
 * `updatedAt` is always at or after `endedAt` — both are stamped from the same settle write
 * (`updateRun`), and a park that never gets an `endedAt` still advances `updatedAt` on that same
 * write — so filtering the query on `updatedAt` is a safe INDEX PRE-FILTER: it can never exclude a
 * row whose true settle time (`endedAt` falling back to `updatedAt`) falls in the window. It is not
 * sufficient on its own, though: `updateRun` (runs.ts) bumps `updatedAt` to `clock.now()` on every
 * write to a row, not just the settling one, so a row that actually settled before `since` can still
 * have `updatedAt >= since` after a later, unrelated write (e.g. `execute-epic-claim.ts` recording
 * `baseForkSha`/`baseRefreshOutcome` on a row that can still be `parked`). The `settledAt < since`
 * check below drops exactly those rows in JS, so the query's `updatedAt` filter only ever narrows the
 * scan — the reported window is always enforced against the real settle time.
 */
export async function runsByCause(
  db: AntonDb,
  projectId: string,
  since: Date | undefined,
): Promise<RunCause[]> {
  const sinceEpoch = since ? toEpoch(since) : undefined;
  const rows = await db
    .select({
      id: schema.runs.id,
      status: schema.runs.status,
      error: schema.runs.error,
      endedAt: schema.runs.endedAt,
      updatedAt: schema.runs.updatedAt,
    })
    .from(schema.runs)
    .where(
      and(
        eq(schema.runs.projectId, projectId),
        inArray(schema.runs.status, [...SETTLED_STATUSES]),
        ...(since ? [gte(schema.runs.updatedAt, since)] : []),
      ),
    );
  const out: RunCause[] = [];
  for (const row of rows) {
    const settledAt = toEpoch(row.endedAt) ?? toEpoch(row.updatedAt);
    if (settledAt === undefined) continue;
    if (sinceEpoch !== undefined && settledAt < sinceEpoch) continue;
    out.push({
      runId: row.id,
      cause: causeOf(row.status as (typeof SETTLED_STATUSES)[number], row.error),
      settledAt,
    });
  }
  return out;
}
