/**
 * What each project has spent of this week's quota, as far as this machine can tell (R6.3).
 *
 * A quota meter does not report a project-specific spend total. The estimate is built the only way
 * the recorded data allows: charge every Claude-burning ATTEMPT a project made this week at that
 * project's own sampled burn
 * average for the job type (`getProjectBurnAverage`). Attempts, not completed jobs, because the
 * runner samples every attempt — a retried, parked, failed or cancelled job burned real quota, and a
 * meter that counted only successes would let a repeatedly failing project spend the account dry
 * while its own share read zero. Rates are per project, not per type globally, because the same job
 * type costs different repos different amounts — charging one project at its neighbour's measured
 * rate would throttle it on spend it never made.
 *
 * Both halves are approximations — the averages come from `burn_samples`, which only records a
 * window when a job ran ALONE, and a type under its sample window is still blended with a static
 * tier seed — so the figure is a pacing estimate and every surface that renders it must mark it as
 * one (see {@link formatApproxPct}).
 *
 * The window follows the QUOTA's week, not a trailing seven days: the meter resets at
 * `weeklyResetAt`, and an operator comparing this figure against the usage pill the day after a reset
 * would otherwise see a week of pre-reset spend counted against a meter that no longer holds it. With
 * usage unreadable there is no reset to anchor to, and a trailing week is the honest fallback.
 */
import { and, eq, gte, sql } from "drizzle-orm";

import { getProjectBurnAverage, burnsClaudeQuota, type BurnAverage } from "./burn";
import { getClaudeUsageCached, type ClaudeUsage } from "./claude/usage";
import { getRouterUsageCached } from "./claude/router-usage";
import { getDb, schema } from "./db";
import type { AntonDb, JobType } from "./jobs/queue";
import { getProjectSettings, listProjects } from "./projects";
import { quotaMeterKey } from "./quota-meter";
import { eligibilityOf, observedWorkEligibility } from "./quota-eligibility";
import { defaultQuotaSharePct, type QuotaShareProject } from "./quota-share";

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * When the current quota week began: one week back from the meter's own reset instant, else a
 * trailing week when the meter cannot be read.
 */
export function weeklyWindowStart(usage: ClaudeUsage | null, now: number): number {
  const resetAt = usage?.weeklyResetAt ? Date.parse(usage.weeklyResetAt) : NaN;
  return Number.isFinite(resetAt) ? resetAt - WEEK_MS : now - WEEK_MS;
}

/**
 * Attempts per (project, type) since `since` — the units the estimate charges. Every status counts:
 * an attempt burned quota whether it ended `done`, `failed`, `parked` or `cancelled`, and one still
 * `running` has already spent most of what it will. Rows with no attempt yet contribute nothing, so
 * a project that has only ENQUEUED work stays unattributed rather than reading as a measured zero.
 *
 * Summed from `spentAttempts`, not `attempts`: the latter is the retry budget, and `resumeJob` zeroes
 * it so an un-parked job gets a fresh run at `maxAttempts`. A meter on that column forgot every
 * attempt a job had burned the moment it was resumed, and each park/resume cycle handed the project
 * its share back (PR #248 review).
 */
async function attemptsByProject(
  db: AntonDb,
  since: number,
  meterKey: string,
  projectId?: string,
): Promise<Map<string, Map<string, number>>> {
  const rows = await db
    .select({
      projectId: schema.quotaAttempts.projectId,
      type: schema.quotaAttempts.jobType,
      attempts: sql<number>`count(*)`,
    })
    .from(schema.quotaAttempts)
    .where(
      and(
        gte(schema.quotaAttempts.createdAt, new Date(since)),
        eq(schema.quotaAttempts.meterKey, meterKey),
        ...(projectId ? [eq(schema.quotaAttempts.projectId, projectId)] : []),
      ),
    )
    .groupBy(schema.quotaAttempts.projectId, schema.quotaAttempts.jobType);

  const byProject = new Map<string, Map<string, number>>();
  for (const row of rows) {
    // A job with no project is anton's own plumbing and belongs to nobody's share.
    if (!row.projectId) continue;
    const attempts = Number(row.attempts);
    if (!attempts) continue;
    const types = byProject.get(row.projectId) ?? new Map<string, number>();
    types.set(row.type, attempts);
    byProject.set(row.projectId, types);
  }
  return byProject;
}

/**
 * The rate THIS project's attempts are charged at — its own samples for each type, never the global
 * per-type average. A project with no samples of its own falls back to the tier seed and reports
 * `seeded`, which is the honest answer; borrowing a neighbour's measured rate is not.
 */
async function burnAveragesFor(
  db: AntonDb,
  projectId: string,
  meterKey: string,
  types: Iterable<string>,
) {
  const charged = [...new Set(types)].filter((type): type is JobType =>
    burnsClaudeQuota(type as JobType),
  );
  return new Map(
    await Promise.all(
      charged.map(
        async (type) => [type, await getProjectBurnAverage(db, projectId, type, meterKey)] as const,
      ),
    ),
  );
}

/** Charge one project's attempts at those rates. `null` stays `null`: unattributed is not zero. */
function chargeSpend(
  types: Map<string, number> | undefined,
  averages: Map<JobType, BurnAverage>,
): { spentWeeklyPct: number | null; seeded: boolean } {
  let spentWeeklyPct: number | null = null;
  let seeded = false;
  for (const [type, count] of types ?? []) {
    const average = averages.get(type as JobType);
    if (!average) continue;
    spentWeeklyPct = (spentWeeklyPct ?? 0) + average.weeklyAvg * count;
    seeded ||= average.seeded;
  }
  return { spentWeeklyPct, seeded };
}

/**
 * What ONE project has spent of this quota week — the meter the governor measures its share ceiling
 * against (R6.1). The account-wide reading `budgetGate` takes cannot serve: every repo on this
 * machine, plus the operator's own sessions, move that one number, so a share can only be enforced
 * against the spend actually attributable to the project.
 *
 * Deliberately the same estimate {@link quotaShareProjects} renders in the Quota shares panel, off
 * the same window and the same per-project averages, so the panel can never show a project room its
 * governor is about to deny. `null` means nothing is attributable yet — never zero.
 */
export async function projectWeeklySpendPct(
  db: AntonDb,
  projectId: string,
  usage: ClaudeUsage | null,
  now: number = Date.now(),
  meterKey: string = "anthropic",
): Promise<number | null> {
  const byProject = await attemptsByProject(db, weeklyWindowStart(usage, now), meterKey, projectId);
  const types = byProject.get(projectId);
  return chargeSpend(types, await burnAveragesFor(db, projectId, meterKey, types?.keys() ?? []))
    .spentWeeklyPct;
}

/**
 * Every project's position in the quota split, resolved against this machine's own records.
 *
 * Ungoverned projects (budget-aware execution off) are listed but sit outside the split: they spend
 * unpaced, so counting them in the denominator would quietly shrink everyone else's share to fund a
 * project no share binds.
 */
export async function quotaShareProjects(now: number = Date.now()): Promise<QuotaShareProject[]> {
  const db = getDb();
  const projects = await listProjects();
  const settings = await Promise.all(projects.map((p) => getProjectSettings(db, p.id)));

  const hasAnthropicMeter = settings.some(
    (stored) => !stored.claudeBaseUrl?.trim() || !stored.routerConnectionId?.trim(),
  );
  const [accountUsage, eligible] = await Promise.all([
    hasAnthropicMeter ? getClaudeUsageCached().catch(() => null) : Promise.resolve(null),
    // A failed read leaves every project UNOBSERVED, not idle: nobody's share moves on a query that
    // did not answer.
    observedWorkEligibility(db, now).catch(() => null),
  ]);
  const meterUsage = await Promise.all(
    settings.map(async (stored) => {
      if (!stored.claudeBaseUrl?.trim() || !stored.routerConnectionId?.trim()) return accountUsage;
      return getRouterUsageCached(stored).catch(() => null);
    }),
  );
  // One connection can have credentials that differ between projects. A rejected credential must not
  // replace a successful read of that same meter's reset window merely because it was listed later.
  const usageByMeter = new Map<string, ClaudeUsage | null>();
  for (const [index, stored] of settings.entries()) {
    const meterKey = quotaMeterKey(stored);
    const usage = meterUsage[index] ?? null;
    if (!usageByMeter.has(meterKey) || (usage && !usageByMeter.get(meterKey))) {
      usageByMeter.set(meterKey, usage);
    }
  }
  const meterWindows = new Map(
    [...usageByMeter].map(([meterKey, usage]) => [meterKey, weeklyWindowStart(usage, now)]),
  );
  const attemptsByMeter = new Map(
    await Promise.all(
      [...meterWindows].map(async ([meterKey, since]) => [
        meterKey,
        await attemptsByProject(db, since, meterKey).catch(() => new Map<string, Map<string, number>>()),
      ] as const),
    ),
  );

  const governedCounts = new Map<string, number>();
  for (const stored of settings) {
    if (stored.budgetAware === true) {
      const meter = quotaMeterKey(stored);
      governedCounts.set(meter, (governedCounts.get(meter) ?? 0) + 1);
    }
  }

  return Promise.all(projects.map(async (project, index) => {
    const stored = settings[index];
    const meterKey = quotaMeterKey(stored);
    const attempts = attemptsByMeter.get(meterKey) ?? new Map();
    const types = attempts.get(project.id);
    const { spentWeeklyPct, seeded } = chargeSpend(
      types,
      await burnAveragesFor(db, project.id, meterKey, types?.keys() ?? []),
    );
    return {
      id: project.id,
      slug: project.slug,
      name: project.name,
      sharePct: stored.quotaSharePct ?? defaultQuotaSharePct(governedCounts.get(quotaMeterKey(stored)) ?? 0),
      declared: stored.quotaSharePct !== undefined,
      governed: stored.budgetAware === true,
      meterKey,
      reserved: stored.reserveQuotaShare === true,
      eligible: eligibilityOf(eligible, project.id),
      spentWeeklyPct,
      seeded,
    };
  }));
}
