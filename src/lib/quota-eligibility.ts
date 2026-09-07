/**
 * Which projects can spend right now — the denominator of the live quota split (R6.4).
 *
 * One definition, shared by the settings panel and the governor, because the two must never
 * disagree about whether a repo is idle: a panel that says "your share is in use elsewhere" while
 * the governor still holds that share back is worse than either answer alone.
 *
 * The answer is THREE-VALUED, and that is the whole care of this module. `true` = the picker ranks
 * startable work here, or quota-burning work is already startable — running, or queued and due.
 * `false` = the picker looked and found nothing. ABSENT = nobody looked — the board-picker pass
 * ships disabled, so a project that never armed it has no observation at all, and reading that
 * silence as "idle" would strip a busy repo's share on a question this machine never asked.
 *
 * Work in flight counts alongside the picker's ranking because that is what makes reclaim prompt: a
 * repo that wakes up on Friday is back in the denominator the moment work is DUE, rather than
 * waiting for the next scheduled pass to re-rank its board.
 */
import { and, eq, lte, or } from "drizzle-orm";

import { burnsClaudeQuota } from "./burn";
import { schema } from "./db";
import type { AntonDb, JobType } from "./jobs/queue";

/** Per-project eligibility; a project absent from the map was never observed, which is not `false`. */
export type WorkEligibility = ReadonlyMap<string, boolean>;

/** What this machine can observe about who holds eligible work, by project id. */
export async function observedWorkEligibility(
  db: AntonDb,
  now: number = Date.now(),
): Promise<WorkEligibility> {
  const [plans, inFlight] = await Promise.all([
    db
      .select({
        projectId: schema.boardPickerPlans.projectId,
        targetCount: schema.boardPickerPlans.targetCount,
      })
      .from(schema.boardPickerPlans),
    db
      .select({ projectId: schema.jobs.projectId, type: schema.jobs.type })
      .from(schema.jobs)
      // The same definition of "startable" the queue itself leases on (`leaseDue`): running, or
      // queued AND DUE. A queued row pushed to a future `runAt` — a retry backoff, a usage-limit
      // reschedule, a budget deferral — cannot start before then, so counting it holds the project
      // in the denominator while none of its work can spend, blocking the very reallocation that
      // window exists to allow, and telling the settings panel it has work ready when it has none.
      .where(
        or(
          eq(schema.jobs.status, "running"),
          and(eq(schema.jobs.status, "queued"), lte(schema.jobs.runAt, new Date(now))),
        ),
      ),
  ]);

  const eligibility = new Map(plans.map((p) => [p.projectId, p.targetCount > 0]));
  for (const job of inFlight) {
    // A job with no project is anton's own plumbing and belongs to nobody's share.
    if (!job.projectId) continue;
    // Plumbing costs no quota, so a queued sync-push is not a claim on anyone's share.
    if (!burnsClaudeQuota(job.type as JobType)) continue;
    eligibility.set(job.projectId, true);
  }
  return eligibility;
}

/** One project's eligibility as the split reads it: `null` where nothing observed it. */
export function eligibilityOf(eligibility: WorkEligibility | null, projectId: string): boolean | null {
  return eligibility?.get(projectId) ?? null;
}
