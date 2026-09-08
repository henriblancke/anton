/**
 * Which projects can spend right now — the denominator of the live quota split (R6.4).
 *
 * One definition, shared by the settings panel and the governor, because the two must never
 * disagree about whether a repo is idle: a panel that says "your share is in use elsewhere" while
 * the governor still holds that share back is worse than either answer alone. For the same reason
 * it answers with the runner's OWN claim gates: work the runner would refuse to lease — a queued row
 * or an expired running lease under an autonomy-off project's execute-epic bucket or a disabled
 * schedule — is not startable, whatever its `runAt` says (PR #248 review).
 *
 * The answer is THREE-VALUED, and that is the whole care of this module. `true` = the picker ranks
 * startable work here, or quota-burning work is already startable — running, or queued and due.
 * `false` = the picker looked and found nothing, or what it found nothing here can start — its own
 * schedule or the autonomy switch is off. ABSENT = nobody looked — the board-picker pass ships
 * disabled, so a project that never armed it has no observation at all, and reading that silence
 * as "idle" would strip a busy repo's share on a question this machine never asked.
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
        leaseExpiresAt: schema.jobs.leaseExpiresAt,
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
  // the autonomy switch would leave every start it makes queued. Nor where the picker itself is
  // switched OFF: disabling its schedule leaves the last plan row in place (only teardown deletes
  // it) and stops every refresh — the cron and the board-change nudge both refuse — so a nonempty
  // plan there is a stale ranking nothing will act on, and reading it as a claim would hold the
  // project in the denominator for as long as the switch stays off.
  const eligibility = new Map(
    plans.map((p) => [
      p.projectId,
      p.targetCount > 0 &&
        !autonomyOff.has(p.projectId) &&
        !disabledSchedules.has(scheduleGateKey("board-picker", p.projectId)),
    ]),
  );
  for (const job of inFlight) {
    // A job with no project is anton's own plumbing and belongs to nobody's share.
    if (!job.projectId) continue;
    // Plumbing costs no quota, so a queued sync-push is not a claim on anyone's share.
    if (!burnsClaudeQuota(job.type as JobType)) continue;
    // A live running row is spending whatever the switches say — both gate the CLAIM, not the run.
    // A queued one the runner holds at cap 0 (`tickOnce`) cannot spend until an operator flips the
    // switch back, which is an operator action, not the idle window's business. A running row whose
    // lease has EXPIRED is a reclaim — the runner leases it through the same held-bucket filter as a
    // queued row — so it holds no share either: a restart expires every surviving lease, and the
    // held project would otherwise sit in the denominator until the operator's next visit.
    const reclaimable =
      job.status === "queued" ||
      (job.leaseExpiresAt !== null && job.leaseExpiresAt.getTime() <= now);
    if (reclaimable && isHeld(job.type, job.projectId, autonomyOff, disabledSchedules)) continue;
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
