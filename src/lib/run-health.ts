/**
 * The run-health report (anton-4ks0): the typed findings one sweep produces, and the anton.db row
 * that holds the latest report per project so the board can render it.
 *
 * A finding is a claim that a piece of work has stopped moving and nothing will restart it on its
 * own — a parked run, a PR nobody has touched, a run-lease whose owner died, a job that spent its
 * retries. The sweep that produces them is READ-ONLY over runs/jobs/beads; this row is its only
 * write. Acting on a finding is a separate job (anton-wvcy).
 *
 * db-injectable (like runs/schedules) so the sweep and its tests share one connection; the UI read
 * path goes through the shared anton.db.
 */
import { eq } from "drizzle-orm";
import { getDb, schema } from "./db";
import type { AntonDb, Clock } from "./jobs/queue";

/**
 * The ways a run stalls silently. Each maps to one detector in `jobs/run-health.ts`:
 *   • `parked-run`    — a `runs` row parked longer than the threshold; nothing re-dispatches it.
 *   • `stale-pr`      — an in-review target whose open PR has had no activity past the threshold.
 *   • `dead-lease`    — a bead still carrying an expired run-lease with no live job behind it.
 *   • `exhausted-job` — a job settled parked/failed having spent its whole attempt budget.
 */
export type RunHealthFindingKind = "parked-run" | "stale-pr" | "dead-lease" | "exhausted-job";

export interface RunHealthFinding {
  kind: RunHealthFindingKind;
  /**
   * Stable across sweeps for the same stall (`<kind>:<subject id>`), so the board can key rows and
   * the follow-up action job can tell a still-stuck finding from a new one.
   */
  key: string;
  /** Why it's stuck: the run's park reason, the PR's idle state, the job's last error. */
  reason: string;
  /** ms epoch the stall started — parked at / last PR activity / lease expiry / job settled. */
  since: number;
  /** How long it had been stuck when the sweep ran (ms). Frozen here so the report reads the same
   *  on every render — the board shows the age as OF the sweep, not as of page load. */
  ageMs: number;
  runId?: string;
  beadId?: string;
  jobId?: string;
  prNumber?: number;
  prUrl?: string;
}

export interface RunHealthReport {
  projectId: string;
  /** The sweep job that produced it; absent for a report written outside the job (tests). */
  jobId?: string;
  /** Unix seconds, matching every other timestamp this app hands the UI. */
  generatedAt: number;
  findings: RunHealthFinding[];
}

function secDate(ms: number): Date {
  return new Date(Math.floor(ms / 1000) * 1000);
}

function toEpoch(value: unknown): number {
  if (value instanceof Date) return Math.floor(value.getTime() / 1000);
  return Number(value ?? 0);
}

/**
 * Deterministic ordering for a report's findings: by kind, then by key. Two sweeps over unchanged
 * state must serialize byte-identically — that's what makes the persisted report idempotent rather
 * than merely "recomputed".
 */
export function sortFindings(findings: RunHealthFinding[]): RunHealthFinding[] {
  return [...findings].sort((a, b) => a.kind.localeCompare(b.kind) || a.key.localeCompare(b.key));
}

/**
 * Write the project's report, replacing the previous one. One row per project by construction, so
 * this is an upsert rather than an append — a sweep that finds nothing stores an empty report,
 * which is the signal "swept, all clear" and NOT "never swept".
 */
export async function saveRunHealthReport(
  db: AntonDb,
  clock: Clock,
  input: { projectId: string; jobId?: string; findings: RunHealthFinding[] },
): Promise<void> {
  const findings = sortFindings(input.findings);
  const row = {
    projectId: input.projectId,
    jobId: input.jobId ?? null,
    generatedAt: secDate(clock.now()),
    findingsJson: JSON.stringify(findings),
    findingCount: findings.length,
  };
  await db
    .insert(schema.runHealthReports)
    .values(row)
    .onConflictDoUpdate({ target: schema.runHealthReports.projectId, set: row });
}

/** The project's latest report, or undefined when it has never been swept. db-injectable. */
export async function getRunHealthReport(
  db: AntonDb,
  projectId: string,
): Promise<RunHealthReport | undefined> {
  const rows = await db
    .select()
    .from(schema.runHealthReports)
    .where(eq(schema.runHealthReports.projectId, projectId))
    .limit(1);
  const row = rows[0];
  if (!row) return undefined;
  let findings: RunHealthFinding[] = [];
  try {
    const parsed = JSON.parse(row.findingsJson) as unknown;
    if (Array.isArray(parsed)) findings = parsed as RunHealthFinding[];
  } catch {
    // A corrupt blob degrades to "no findings" rather than crashing the board — the count column
    // still shows the sweep saw something, so the discrepancy is visible instead of silent.
  }
  return {
    projectId: row.projectId,
    jobId: row.jobId ?? undefined,
    generatedAt: toEpoch(row.generatedAt),
    findings,
  };
}

/** UI read path over the shared anton.db. */
export function latestRunHealthReport(projectId: string): Promise<RunHealthReport | undefined> {
  return getRunHealthReport(getDb(), projectId);
}
