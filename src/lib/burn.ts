/**
 * Per-job Claude burn sampler (anton-w8ny). Records how much subscription quota each job TYPE
 * actually burns, so pacing and prioritization can reason about cost.
 *
 * The runner samples live usage immediately before and after each job and persists the
 * session%/weekly% delta attributed to the job's type. The runner only opens a window when the job
 * runs alone (nothing else in flight, and nothing dispatched across the window), so under
 * concurrency > 1 overlapping jobs record NO sample rather than double-counting each other's burn —
 * every recorded delta is unambiguously one job's cost. The closing read bypasses the usage cache
 * (see getClaudeUsageFresh): a cached read would subtract a cache entry from itself for any job
 * finishing inside the TTL and record a bogus zero. Reads are fail-soft — a missing/reset meter
 * records NO sample and never touches the job. Sampling is gated behind the project's budget-aware
 * opt-in (anton-7mpv.1): burn data only feeds budget pacing, so in the default feature-off state the
 * runner takes no usage reads on the sampler's behalf.
 *
 * `getBurnAverage` returns a rolling average over the most recent {@link BURN_SAMPLE_WINDOW} samples
 * for a type; until that many real samples accrue it blends the samples it has with a static per-tier
 * seed (padding the empty slots with the seed), so real measurements count from the first one. Everything
 * is db-injectable (like schedules.ts) so the runner and tests share one connection.
 *
 * Scope: no per-request/token accounting, no cross-machine aggregation — each machine keeps its own
 * averages in its disposable anton.db.
 */
import { randomUUID } from "node:crypto";
import { desc, eq } from "drizzle-orm";
import { schema } from "./db";
import type { AntonDb, Clock, JobType } from "./jobs/queue";
import type { ClaudeUsage } from "./claude/usage";

/** How many real samples a type needs before its rolling average replaces the tier seed. */
export const BURN_SAMPLE_WINDOW = 5;

/** Cost tiers — a rough size for a job type's burn until real data replaces the guess. */
export type BurnTier = "S" | "M" | "L";

/**
 * Seed burn per tier (session%/weekly% points) used until a type has {@link BURN_SAMPLE_WINDOW} real
 * samples. Estimates, not measurements: enough to let pacing rank job types day one. Weekly seeds are
 * far smaller than session — the 7-day window dilutes a single job far more than the 5-hour one.
 */
export const TIER_SEEDS: Record<BurnTier, { sessionPct: number; weeklyPct: number }> = {
  S: { sessionPct: 2, weeklyPct: 0.3 },
  M: { sessionPct: 8, weeklyPct: 1.2 },
  L: { sessionPct: 20, weeklyPct: 3 },
};

/**
 * Static tier per job type (ticket: stringer=S, review-fix=M, execute-epic=L; grooming is cheap).
 * sync-push is a deterministic `git push` of dolt refs — it invokes no Claude, so it burns nothing (S).
 */
export const JOB_TYPE_TIER: Record<JobType, BurnTier> = {
  "nightly-stringer": "S",
  "review-fix": "M",
  "execute-epic": "L",
  "orphan-grooming": "S",
  "sync-push": "S",
};

export interface BurnSample {
  sessionDelta: number;
  weeklyDelta: number;
}

/**
 * The burn between two usage reads, or `null` when there's no attributable sample: either read
 * missing (creds gone / offline), or a meter that went *down* — the 5-hour session (or the weekly)
 * limit reset mid-job, so the delta spans a boundary and can't be attributed. A skipped sample is a
 * clean no-op, never a job failure.
 */
export function burnDelta(
  before: ClaudeUsage | null,
  after: ClaudeUsage | null,
): BurnSample | null {
  if (!before || !after) return null;
  const sessionDelta = after.sessionPct - before.sessionPct;
  const weeklyDelta = after.weeklyPct - before.weeklyPct;
  if (sessionDelta < 0 || weeklyDelta < 0) return null;
  return { sessionDelta, weeklyDelta };
}

/** Persist one burn sample for a job type. */
export async function recordBurnSample(
  db: AntonDb,
  clock: Clock,
  jobType: JobType,
  sample: BurnSample,
): Promise<void> {
  await db.insert(schema.burnSamples).values({
    id: randomUUID(),
    jobType,
    sessionDelta: sample.sessionDelta,
    weeklyDelta: sample.weeklyDelta,
    createdAt: new Date(Math.floor(clock.now() / 1000) * 1000),
  });
}

export interface BurnAverage {
  jobType: JobType;
  /** Rolling mean session%-delta over the window; while under-sampled, real samples blended with the tier seed. */
  sessionAvg: number;
  /** Rolling mean weekly%-delta over the window; while under-sampled, real samples blended with the tier seed. */
  weeklyAvg: number;
  /** Real samples counted (capped at the window). */
  sampleCount: number;
  /** True while under-sampled, so the average still leans on the tier seed rather than being fully measured. */
  seeded: boolean;
  tier: BurnTier;
}

/**
 * Rolling per-type burn average over the most recent `window` samples. Under-sampled types blend the
 * real samples they have with the tier seed (empty slots padded with the seed), so callers always get
 * a usable number that tracks real burn from the first sample. Read path via the shared anton.db by
 * default; the runner/tests inject their own connection.
 */
export async function getBurnAverage(
  db: AntonDb,
  jobType: JobType,
  window: number = BURN_SAMPLE_WINDOW,
): Promise<BurnAverage> {
  const tier = JOB_TYPE_TIER[jobType];
  const rows = await db
    .select({
      sessionDelta: schema.burnSamples.sessionDelta,
      weeklyDelta: schema.burnSamples.weeklyDelta,
    })
    .from(schema.burnSamples)
    .where(eq(schema.burnSamples.jobType, jobType))
    .orderBy(desc(schema.burnSamples.createdAt))
    .limit(window);

  if (rows.length < window) {
    // Ramp-up: pad the missing slots with the tier seed rather than discarding the real samples we
    // do have. Each real measurement pulls the average toward reality (weighted by rows.length/window)
    // so an execute-epic that actually burns 40% isn't stuck reporting the 20% seed until sample #5.
    // With zero rows this collapses to the pure seed.
    const seed = TIER_SEEDS[tier];
    const pad = window - rows.length;
    const sessionAvg = (rows.reduce((s, r) => s + r.sessionDelta, 0) + pad * seed.sessionPct) / window;
    const weeklyAvg = (rows.reduce((s, r) => s + r.weeklyDelta, 0) + pad * seed.weeklyPct) / window;
    return { jobType, sessionAvg, weeklyAvg, sampleCount: rows.length, seeded: true, tier };
  }

  const sessionAvg = rows.reduce((s, r) => s + r.sessionDelta, 0) / rows.length;
  const weeklyAvg = rows.reduce((s, r) => s + r.weeklyDelta, 0) / rows.length;
  return { jobType, sessionAvg, weeklyAvg, sampleCount: rows.length, seeded: false, tier };
}

/**
 * Sample a job's burn: compare a `before` usage read against a fresh read taken after the job, and
 * persist the delta for its type. Fail-soft by contract — a null read or a reset meter records
 * nothing, and any error (a failed usage read, a DB hiccup) is swallowed so burn accounting can
 * NEVER fail a job. Returns the recorded sample, or `null` when none was.
 *
 * `read` is injected (the runner passes its TTL-bypassing fresh read) so tests drive it
 * deterministically.
 */
export async function sampleJobBurn(
  db: AntonDb,
  clock: Clock,
  jobType: JobType,
  before: ClaudeUsage | null,
  read: () => Promise<ClaudeUsage | null>,
): Promise<BurnSample | null> {
  try {
    const after = await read();
    const sample = burnDelta(before, after);
    if (!sample) return null;
    await recordBurnSample(db, clock, jobType, sample);
    return sample;
  } catch {
    return null;
  }
}
