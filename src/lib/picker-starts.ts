/**
 * THE UNATTENDED START (anton-vfvg / R1.5): what the picker began with nobody watching, kept where
 * the operator can read it later.
 *
 * `picker-apply.ts` already leaves two traces of a policy start — a bead note actored `policy`, and
 * an `execute-epic` job — and neither is a record an operator reads. The note lives on the bead they
 * would have to already suspect, and the job says a run exists, not that anton chose to begin it. So
 * the start is logged here, beside the vetoes in `picker-veto.ts`, and the two are rendered together
 * as the Health page's decision log: action and disagreement in one place.
 *
 * It cannot be derived from the plan. The plan is one row per project, replaced whole every pass, so
 * the decision that started a run is overwritten ten minutes later — the log has to outlive it.
 *
 * db-injectable, like the plan and the verdicts: the pass and its tests share one connection, and the
 * UI read path goes through the shared anton.db.
 */
import { randomUUID } from "node:crypto";
import { and, desc, eq, notInArray, sql } from "drizzle-orm";
import { getDb, schema } from "./db";
import type { AntonDb, Clock } from "./jobs/queue";

/**
 * How many starts a project keeps.
 *
 * The same window the picker's track record reads (`PICKER_RECORD_WINDOW`), and for the same reason:
 * the log answers "what has anton been doing lately", which a hundred rows answer worse than twenty.
 * Deliberately NOT a time-based expiry — a project whose picker ran once a month would show nothing
 * at all under one, which is the same silence this record exists to end.
 */
export const PICKER_START_RETENTION = 20;

/**
 * The tie-break behind `startedAt`, which is stored whole-second: two starts settled in the same
 * second must not leave their order to SQLite's row order, and the id cannot break the tie because
 * a random UUID sorts lexically and says nothing about which start came first (PR #218 review) —
 * the log would read them backwards, and the prune would keep the older of the two at the window
 * boundary. `rowid` is assigned in INSERT order, so descending it IS chronological for a tie, the
 * same deterministic fallback the run list uses. Rows are append-only and the prune only ever takes
 * the oldest, so a project's newest row keeps the highest rowid for its whole life.
 */
const NEWEST_FIRST = sql`rowid desc`;

/** One unattended start: the pick, the rule that admitted it, and the run it enqueued. */
export interface PickerStartRow {
  beadId: string;
  /** Where the target stood in the plan that started it, and how many targets that plan ranked. */
  rank: number;
  ranked: number;
  rule: string;
  jobId?: string;
  startedAtMs: number;
}

export interface RecordStartInput {
  projectId: string;
  beadId: string;
  rank: number;
  ranked: number;
  rule: string;
  jobId?: string;
}

function secDate(ms: number): Date {
  return new Date(Math.floor(ms / 1000) * 1000);
}

function msOf(value: unknown): number | undefined {
  if (value instanceof Date) return value.getTime();
  if (typeof value === "number") return value * 1000;
  return undefined;
}

/**
 * Append one start and prune the project back to {@link PICKER_START_RETENTION} rows.
 *
 * Append-only: two starts of the same target days apart are two things anton did, and collapsing
 * them onto one row would turn a log into a projection of current state — which is exactly what the
 * plan already is, and exactly why this table exists beside it.
 *
 * The prune keeps the NEWEST rows, by the same order the read below returns them, so what a reader
 * loses is always the oldest and never a row the page was about to show.
 *
 * Insert AND prune in one IMMEDIATE transaction (PR #218 review), the same way the veto settles its
 * own race: two passes recording starts for one project can otherwise interleave, and a prune that
 * read its keep-list before the other's insert would delete that newer row for being absent from a
 * snapshot taken before it existed — silently losing the newest entry in the very log that exists to
 * report the newest unattended start. Taking the write lock before the keep-list is read is what
 * makes the delete judge a table nothing can have appended to.
 */
export async function recordPickerStart(
  db: AntonDb,
  clock: Clock,
  input: RecordStartInput,
): Promise<void> {
  const startedAt = secDate(clock.now());
  db.transaction(
    (tx) => {
      tx.insert(schema.pickerStarts)
        .values({
          id: randomUUID(),
          projectId: input.projectId,
          beadId: input.beadId,
          rank: input.rank,
          ranked: input.ranked,
          rule: input.rule,
          jobId: input.jobId ?? null,
          startedAt,
        })
        .run();
      prunePickerStarts(tx, input.projectId);
    },
    { behavior: "immediate" },
  );
}

/**
 * Drop everything past the retention window for one project.
 *
 * Scoped to the project, like the hygiene prune it mirrors: retention is per project, and a global
 * prune would let a busy board evict a quiet one's whole history. Runs inside its caller's
 * transaction, so the keep-list it reads is the table the delete acts on.
 */
function prunePickerStarts(
  tx: Pick<AntonDb, "select" | "delete">,
  projectId: string,
): void {
  const kept = tx
    .select({ id: schema.pickerStarts.id })
    .from(schema.pickerStarts)
    .where(eq(schema.pickerStarts.projectId, projectId))
    .orderBy(desc(schema.pickerStarts.startedAt), NEWEST_FIRST)
    .limit(PICKER_START_RETENTION)
    .all();
  if (kept.length < PICKER_START_RETENTION) return;
  tx.delete(schema.pickerStarts)
    .where(
      and(
        eq(schema.pickerStarts.projectId, projectId),
        notInArray(
          schema.pickerStarts.id,
          kept.map((row) => row.id),
        ),
      ),
    )
    .run();
}

/** This project's unattended starts, newest first. */
export async function listPickerStarts(
  db: AntonDb,
  projectId: string,
  limit: number = PICKER_START_RETENTION,
): Promise<PickerStartRow[]> {
  const rows = await db
    .select()
    .from(schema.pickerStarts)
    .where(eq(schema.pickerStarts.projectId, projectId))
    .orderBy(desc(schema.pickerStarts.startedAt), NEWEST_FIRST)
    .limit(limit);
  return rows.map((row) => ({
    beadId: row.beadId,
    rank: row.rank,
    ranked: row.ranked,
    rule: row.rule,
    ...(row.jobId ? { jobId: row.jobId } : {}),
    startedAtMs: msOf(row.startedAt) ?? 0,
  }));
}

/** UI read path over the shared anton.db. */
export function latestPickerStarts(
  projectId: string,
  limit?: number,
): Promise<PickerStartRow[]> {
  return listPickerStarts(getDb(), projectId, limit);
}
