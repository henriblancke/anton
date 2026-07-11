/**
 * Read-only access to the machine-local `runs` table. Runs are execution plumbing (worktree,
 * lease, model, agent); stage/PR live in beads. See DESIGN.md §3.
 */
import { desc, eq } from "drizzle-orm";
import { getDb, schema } from "./db";

export type RunStatus = "queued" | "running" | "parked" | "done" | "failed";

export interface RunSummary {
  id: string;
  epicBeadId: string;
  ticketBeadId?: string;
  worktreePath?: string;
  branch?: string;
  model?: string;
  agentTag?: string;
  status: RunStatus;
  attempts: number;
  startedAt?: number;
  endedAt?: number;
  updatedAt: number;
}

function toEpoch(value: unknown): number | undefined {
  if (value == null) return undefined;
  if (value instanceof Date) return Math.floor(value.getTime() / 1000);
  return Number(value);
}

function toSummary(row: typeof schema.runs.$inferSelect): RunSummary {
  return {
    id: row.id,
    epicBeadId: row.epicBeadId,
    ticketBeadId: row.ticketBeadId ?? undefined,
    worktreePath: row.worktreePath ?? undefined,
    branch: row.branch ?? undefined,
    model: row.model ?? undefined,
    agentTag: row.agentTag ?? undefined,
    status: row.status as RunStatus,
    attempts: row.attempts,
    startedAt: toEpoch(row.startedAt),
    endedAt: toEpoch(row.endedAt),
    updatedAt: toEpoch(row.updatedAt) ?? 0,
  };
}

export async function listRuns(projectId: string): Promise<RunSummary[]> {
  const rows = await getDb()
    .select()
    .from(schema.runs)
    .where(eq(schema.runs.projectId, projectId))
    .orderBy(desc(schema.runs.updatedAt));
  return rows.map(toSummary);
}
