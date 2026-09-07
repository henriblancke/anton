/**
 * Which projects can spend right now — the denominator of the live quota split (R6.4).
 *
 * One definition, shared by the settings panel and the governor, because the two must never
 * disagree about whether a repo is idle: a panel that says "your share is in use elsewhere" while
 * the governor still holds that share back is worse than either answer alone. For the same reason
 * it answers with the runner's OWN claim gates: queued work the runner would refuse to lease — an
 * execute-epic under an autonomy-off project, a scheduled job whose schedule is disabled — is not
 * startable, whatever its `runAt` says (PR #248 review).
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
import { disabledScheduleKeys, scheduleGateKey, type AntonDb, type JobType } from "./jobs/queue";

/** Per-project eligibility; a project absent from the map was never observed, which is not `false`. */
export type WorkEligibility = ReadonlyMap<string, boolean>;

/** What this machine can observe about who holds eligible work, by project id. */
export async function observedWorkEligibility(
  db: AntonDb,
  now: number = Date.now(),
): Promise<WorkEligibility> {
  const [plans, inFlight, autonomyOff, disabledSchedules] = await Promise.all([
    db
      .select({
        projectId: schema.boardPickerPlans.projectId,
        targetCount: schema.boardPickerPlans.targetCount,
      })
      .from(schema.boardPickerPlans),
    db
      .select({
        projectId: schema.jobs.projectId,
        type: schema.jobs.type,
        status: schema.jobs.status,
      })
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
    autonomyOffProjects(db),
    disabledScheduleKeys(db),
  ]);

  // The picker only ever starts execute-epic work, so its ranking is no claim on the quota where
  // the autonomy switch would leave every start it makes queued.
  const eligibility = new Map(
    plans.map((p) => [p.projectId, p.targetCount > 0 && !autonomyOff.has(p.projectId)]),
  );
  for (const job of inFlight) {
    // A job with no project is anton's own plumbing and belongs to nobody's share.
    if (!job.projectId) continue;
    // Plumbing costs no quota, so a queued sync-push is not a claim on anyone's share.
    if (!burnsClaudeQuota(job.type as JobType)) continue;
    // A running row is spending whatever the switches say — both gate the CLAIM, not the run. A
    // queued one the runner holds at cap 0 (`tickOnce`) cannot spend until an operator flips the
    // switch back, which is an operator action, not the idle window's business.
    if (job.status === "queued" && isHeld(job.type, job.projectId, autonomyOff, disabledSchedules)) {
      continue;
    }
    eligibility.set(job.projectId, true);
  }
  return eligibility;
}

/** The runner's hard holds: autonomy off parks every execute-epic; a disabled schedule parks its type. */
function isHeld(
  type: string,
  projectId: string,
  autonomyOff: ReadonlySet<string>,
  disabledSchedules: ReadonlySet<string>,
): boolean {
  if (type === "execute-epic" && autonomyOff.has(projectId)) return true;
  return disabledSchedules.has(scheduleGateKey(type, projectId));
}

/**
 * Projects whose autonomy master-switch is OFF. Read off the raw settings blob rather than through
 * `getProjectSettings`: projects.ts is a consumer of this module, and one boolean is not worth the
 * import cycle. Same lenient parse as there — an unparseable blob reads as defaults (autonomy on).
 */
async function autonomyOffProjects(db: AntonDb): Promise<Set<string>> {
  const rows = await db
    .select({ id: schema.projects.id, settingsJson: schema.projects.settingsJson })
    .from(schema.projects);
  const off = new Set<string>();
  for (const row of rows) {
    try {
      if ((JSON.parse(row.settingsJson) as { autonomy?: unknown }).autonomy === false) off.add(row.id);
    } catch {
      // Unparseable settings resolve to defaults everywhere else too.
    }
  }
  return off;
}

/** One project's eligibility as the split reads it: `null` where nothing observed it. */
export function eligibilityOf(eligibility: WorkEligibility | null, projectId: string): boolean | null {
  return eligibility?.get(projectId) ?? null;
}
