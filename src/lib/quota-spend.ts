/**
 * What each project has spent of this week's quota, as far as this machine can tell (R6.3).
 *
 * There is no per-project meter to read. The estimate is built the only way the recorded data allows:
 * charge every Claude-burning job a project completed this week at that job TYPE's sampled burn
 * average (`getBurnAverage`). Both halves are approximations — the averages come from `burn_samples`,
 * which only records a window when a job ran ALONE, and a type under its sample window is still
 * blended with a static tier seed — so the figure is a pacing estimate and every surface that renders
 * it must mark it as one (see {@link formatApproxPct}).
 *
 * The window follows the QUOTA's week, not a trailing seven days: the meter resets at
 * `weeklyResetAt`, and an operator comparing this figure against the usage pill the day after a reset
 * would otherwise see a week of pre-reset spend counted against a meter that no longer holds it. With
 * usage unreadable there is no reset to anchor to, and a trailing week is the honest fallback.
 */
import { and, eq, gte, sql } from "drizzle-orm";

import { getBurnAverage, burnsClaudeQuota } from "./burn";
import { getClaudeUsageCached, type ClaudeUsage } from "./claude/usage";
import { getDb, schema } from "./db";
import type { AntonDb, JobType } from "./jobs/queue";
import { getProjectSettings, listProjects } from "./projects";
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

/** Completed jobs per (project, type) since `since` — the units the estimate charges. */
async function completedJobsByProject(
  db: AntonDb,
  since: number,
): Promise<Map<string, Map<string, number>>> {
  const rows = await db
    .select({
      projectId: schema.jobs.projectId,
      type: schema.jobs.type,
      count: sql<number>`count(*)`,
    })
    .from(schema.jobs)
    .where(and(eq(schema.jobs.status, "done"), gte(schema.jobs.updatedAt, new Date(since))))
    .groupBy(schema.jobs.projectId, schema.jobs.type);

  const byProject = new Map<string, Map<string, number>>();
  for (const row of rows) {
    // A job with no project is anton's own plumbing and belongs to nobody's share.
    if (!row.projectId) continue;
    const types = byProject.get(row.projectId) ?? new Map<string, number>();
    types.set(row.type, Number(row.count));
    byProject.set(row.projectId, types);
  }
  return byProject;
}

/** Which projects the picker currently ranks work for — the denominator of the live split (R6.4). */
async function projectsWithEligibleWork(db: AntonDb): Promise<Set<string>> {
  const rows = await db
    .select({
      projectId: schema.boardPickerPlans.projectId,
      targetCount: schema.boardPickerPlans.targetCount,
    })
    .from(schema.boardPickerPlans);
  return new Set(rows.filter((r) => r.targetCount > 0).map((r) => r.projectId));
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

  const [usage, eligible] = await Promise.all([
    getClaudeUsageCached().catch(() => null),
    projectsWithEligibleWork(db).catch(() => new Set<string>()),
  ]);
  const jobsByProject = await completedJobsByProject(db, weeklyWindowStart(usage, now)).catch(
    () => new Map<string, Map<string, number>>(),
  );

  // One average per type, shared across projects — the rate every project's completions are charged
  // at, and the reason the whole figure is an estimate.
  const chargedTypes = [
    ...new Set([...jobsByProject.values()].flatMap((types) => [...types.keys()])),
  ].filter((type): type is JobType => burnsClaudeQuota(type as JobType));
  const averages = new Map(
    await Promise.all(
      chargedTypes.map(async (type) => [type, await getBurnAverage(db, type)] as const),
    ),
  );

  const governedCount = settings.filter((s) => s.budgetAware === true).length;
  const equalSplit = defaultQuotaSharePct(governedCount);

  return projects.map((project, index) => {
    const stored = settings[index];
    const types = jobsByProject.get(project.id);
    let spentWeeklyPct: number | null = null;
    let seeded = false;
    for (const [type, count] of types ?? []) {
      const average = averages.get(type as JobType);
      if (!average) continue;
      spentWeeklyPct = (spentWeeklyPct ?? 0) + average.weeklyAvg * count;
      seeded ||= average.seeded;
    }
    return {
      id: project.id,
      slug: project.slug,
      name: project.name,
      sharePct: stored.quotaSharePct ?? equalSplit,
      declared: stored.quotaSharePct !== undefined,
      governed: stored.budgetAware === true,
      reserved: stored.reserveQuotaShare === true,
      eligible: eligible.has(project.id),
      spentWeeklyPct,
      seeded,
    };
  });
}
