/**
 * Read-only view over the durable `jobs` table for the runs UI (anton-ner.3). The jobs table is
 * the single source of truth the runner mutates (queue.ts), so reading it directly keeps the UI
 * status consistent with the runner — including job types that never write a `runs` row
 * (review-fix, nightly-stringer, orphan-grooming) and parked/failed jobs kept for audit.
 *
 * Mirrors runs.ts: uses the shared `getDb()` connection and exposes a pure row→summary mapper so
 * the field extraction (JSON payload parse, timestamp normalization) is unit-testable.
 */
import { desc, eq } from "drizzle-orm";
import { getDb, schema } from "./db";
import type { JobStatus, JobType } from "./jobs/queue";

export type { JobStatus, JobType } from "./jobs/queue";

export interface JobSummary {
  id: string;
  type: JobType;
  status: JobStatus;
  projectId?: string;
  /** Epic the job targets, when the payload names one (execute-epic, scoped review-fix). */
  epicBeadId?: string;
  /** Schedule that fired this job, when cron-enqueued (nightly-stringer, orphan-grooming, review-fix). */
  scheduleId?: string;
  attempts: number;
  lastError?: string;
  /** Epoch seconds. When the job entered the queue — its start marker. */
  createdAt: number;
  /** Epoch seconds. Last transition; for terminal jobs (done/parked/failed) this is the end. */
  updatedAt: number;
}

/** Statuses that are still in flight — active vs. terminal (kept for audit) grouping. */
const ACTIVE_JOB_STATUSES: JobStatus[] = ["queued", "running", "parked"];

export function isActiveJob(status: JobStatus): boolean {
  return ACTIVE_JOB_STATUSES.includes(status);
}

function toEpoch(value: unknown): number {
  if (value == null) return 0;
  if (value instanceof Date) return Math.floor(value.getTime() / 1000);
  return Number(value);
}

/** Pull a string field out of the JSON payload without throwing on malformed data. */
function stringFromPayload(
  payloadJson: string | null | undefined,
  key: "epicBeadId" | "scheduleId",
): string | undefined {
  if (!payloadJson) return undefined;
  try {
    const parsed = JSON.parse(payloadJson) as Record<string, unknown>;
    return typeof parsed[key] === "string" ? (parsed[key] as string) : undefined;
  } catch {
    return undefined;
  }
}

export function toJobSummary(row: typeof schema.jobs.$inferSelect): JobSummary {
  return {
    id: row.id,
    type: row.type as JobType,
    status: row.status as JobStatus,
    projectId: row.projectId ?? undefined,
    epicBeadId: stringFromPayload(row.payloadJson, "epicBeadId"),
    scheduleId: stringFromPayload(row.payloadJson, "scheduleId"),
    attempts: row.attempts,
    lastError: row.lastError ?? undefined,
    createdAt: toEpoch(row.createdAt),
    updatedAt: toEpoch(row.updatedAt),
  };
}

/** All jobs for a project, newest activity first, across every type and status. */
export async function listJobs(projectId: string): Promise<JobSummary[]> {
  const rows = await getDb()
    .select()
    .from(schema.jobs)
    .where(eq(schema.jobs.projectId, projectId))
    .orderBy(desc(schema.jobs.updatedAt));
  return rows.map(toJobSummary);
}
