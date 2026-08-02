/**
 * The hygiene report (anton-3nv7): what one gardener patrol did to the board, and everything it
 * found that a human still has to judge.
 *
 * The patrol has two tiers and this row records both. The MECHANICAL tier is what bd can prove safe
 * to apply — an epic whose children are all closed, a stale `is_blocked` flag — and it is recorded
 * as ACTIONS (the ids closed, the rows repaired). Everything else is a FINDING: a claim that
 * something on the board is off, with no move anton is entitled to make. Merging duplicates,
 * retiring stale work and re-linking orphans are judgment calls (anton-bci0's "Out of scope"), so
 * they are reported and nothing more.
 *
 * db-injectable (like runs/run-health) so the patrol and its tests share one connection; the UI read
 * path goes through the shared anton.db.
 */
import { randomUUID } from "node:crypto";
import { and, desc, eq, isNotNull, isNull, notInArray, sql } from "drizzle-orm";
import { getDb, schema } from "./db";
import type { AntonDb, Clock } from "./jobs/queue";

/**
 * The classes of board rot the patrol reports. Each maps to one bd verb (see `beads.*` in
 * beads/bd.ts):
 *   • `lint`               — a bead missing the template sections its type requires (`bd lint`).
 *   • `stale-open`         — an open bead untouched past the open threshold (`bd stale`).
 *   • `stale-in-progress`  — an in_progress bead untouched past its (shorter) threshold: work that
 *                            was started and abandoned, which reads as in-flight to every other
 *                            reader of the board.
 *   • `orphan`             — a bead a commit shipped and nobody closed (`bd orphans`).
 *   • `dep-cycle`          — a cycle in the dependency graph (`bd dep cycles`).
 *   • `duplicate`          — a group of beads with identical content (`bd duplicates`).
 */
export type HygieneFindingKind =
  | "lint"
  | "stale-open"
  | "stale-in-progress"
  | "orphan"
  | "dep-cycle"
  | "duplicate";

export const HYGIENE_FINDING_KINDS: readonly HygieneFindingKind[] = [
  "lint",
  "stale-open",
  "stale-in-progress",
  "orphan",
  "dep-cycle",
  "duplicate",
];

export interface HygieneFinding {
  kind: HygieneFindingKind;
  /**
   * Stable across patrols for the same subject (`<kind>:<subject id>`), so the board can key rows
   * and a later proposals pass (anton-e42l) can tell a still-rotten finding from a new one.
   */
  key: string;
  /** What is wrong, in one sentence — the line a human reads first. */
  detail: string;
  /** The bead the finding is about, when it is about exactly one. */
  beadId?: string;
  title?: string;
  /** Every bead the finding spans — a duplicate group's members, a cycle's ring. */
  ids?: string[];
}

/** The mechanical tier's output: the only two writes the patrol is allowed to make. */
export interface HygieneActions {
  /** Epic ids `bd epic close-eligible` closed this pass (all children already closed). */
  closedEpics: string[];
  /** Stale `is_blocked` rows `bd recompute-blocked` repaired. 0 means the graph was consistent. */
  rowsRecomputed: number;
}

/** Per-kind finding counts — the report summary, so a caller needn't walk the findings. */
export type HygieneCounts = Record<HygieneFindingKind, number>;

export interface HygieneReport {
  id: string;
  projectId: string;
  /** The patrol job that produced it; absent for a report written outside a job (tests). */
  jobId?: string;
  /** Unix seconds, matching every other timestamp this app hands the UI. */
  generatedAt: number;
  actions: HygieneActions;
  findings: HygieneFinding[];
  counts: HygieneCounts;
}

/**
 * How many patrol reports to keep per project. A short audit trail — enough to answer "what closed
 * that epic, and when did this lint violation first appear" across a couple of weeks of daily
 * patrols — without an append-only log that grows forever.
 */
export const HYGIENE_REPORT_RETENTION = 20;

/**
 * Insertion order, newest first — the tiebreak every read here applies after `generatedAt`, because
 * the timestamps are second-granular and two patrols settling inside the same second must still have
 * a defined "latest". SQLite's implicit `rowid` is that order (this table is not WITHOUT ROWID);
 * the row `id` is a uuid, so sorting on it would pick a winner at random.
 */
const NEWEST_FIRST = sql`rowid desc`;

/** Only a landed report is a report — an in-flight one is nobody's answer to "how is the board?". */
const COMPLETED = isNotNull(schema.hygieneReports.completedAt);

function secDate(ms: number): Date {
  return new Date(Math.floor(ms / 1000) * 1000);
}

function toEpoch(value: unknown): number {
  if (value instanceof Date) return Math.floor(value.getTime() / 1000);
  return Number(value ?? 0);
}

/**
 * Deterministic ordering: by kind, then by key. Two patrols over unchanged state serialize
 * byte-identically, which is what makes "did the board actually change?" answerable by comparing
 * two reports instead of re-reading the board.
 */
export function sortFindings(findings: HygieneFinding[]): HygieneFinding[] {
  return [...findings].sort((a, b) => a.kind.localeCompare(b.kind) || a.key.localeCompare(b.key));
}

/** Per-kind counts with every kind present — an absent kind counts 0, never `undefined`. */
export function countFindings(findings: HygieneFinding[]): HygieneCounts {
  const counts = Object.fromEntries(HYGIENE_FINDING_KINDS.map((k) => [k, 0])) as HygieneCounts;
  for (const finding of findings) {
    if (finding.kind in counts) counts[finding.kind] += 1;
  }
  return counts;
}

/**
 * One-line summary of a patrol, for the job log: what it changed, and what it wants eyes on. Kept
 * here beside the counts so the log line and the persisted row can never disagree.
 */
export function summarizeReport(report: Pick<HygieneReport, "actions" | "findings">): string {
  const { closedEpics, rowsRecomputed } = report.actions;
  const counts = countFindings(report.findings);
  const found = HYGIENE_FINDING_KINDS.filter((k) => counts[k] > 0)
    .map((k) => `${counts[k]} ${k}`)
    .join(", ");
  return (
    `closed ${closedEpics.length} epic(s)${closedEpics.length ? ` (${closedEpics.join(", ")})` : ""}, ` +
    `recomputed ${rowsRecomputed} blocked row(s); ` +
    (found ? `${report.findings.length} finding(s): ${found}` : "no findings")
  );
}

export interface SaveHygieneReportInput {
  projectId: string;
  jobId?: string;
  actions: HygieneActions;
  findings: HygieneFinding[];
}

/**
 * Append this patrol's report and prune the project back to {@link HYGIENE_REPORT_RETENTION} rows.
 * Returns the row id so a caller can read back exactly what it wrote.
 *
 * A patrol that found nothing still writes a row: an empty report is the signal "patrolled, board is
 * clean", which is a different claim from "never patrolled" — and the board (anton-uwal) must be
 * able to tell them apart.
 *
 * The one-shot form, for a caller that has both tiers in hand. The gardener job instead
 * {@link startHygieneReport}s its actions and {@link completeHygieneReport}s the findings, so a
 * failing report tier can't lose what the sweep already did.
 */
export async function saveHygieneReport(
  db: AntonDb,
  clock: Clock,
  input: SaveHygieneReportInput,
): Promise<string> {
  const { id } = await startHygieneReport(db, clock, input);
  await completeHygieneReport(db, clock, id, input.findings);
  return id;
}

/** An opened report row: its id, and the actions it now holds (merged across attempts). */
export interface OpenHygieneReport {
  id: string;
  actions: HygieneActions;
}

export interface StartHygieneReportInput {
  projectId: string;
  jobId?: string;
  actions: HygieneActions;
}

/**
 * Open this patrol's report row with the mechanical tier already recorded — the writes the sweep
 * made, persisted BEFORE the (fallible, retried) report tier runs.
 *
 * The row stays invisible to every read here until {@link completeHygieneReport} lands its findings,
 * because a findings-less report REPLACES what the board shows and would read as a clean bill of
 * health. What it buys is honesty across a retry: the patrol's writes are idempotent, so a second
 * attempt's sweep closes nothing and would otherwise report "closed 0 epics" for a pass that closed
 * work. Re-opening the same `jobId` MERGES into that attempt's row instead — the union of every
 * attempt's closures, which is what the patrol actually did.
 */
export async function startHygieneReport(
  db: AntonDb,
  clock: Clock,
  input: StartHygieneReportInput,
): Promise<OpenHygieneReport> {
  const open = input.jobId ? await findOpenReportForJob(db, input.jobId) : undefined;
  if (open) {
    const actions: HygieneActions = {
      closedEpics: [
        ...new Set([...parseJson<string[]>(open.closedEpicsJson, []), ...input.actions.closedEpics]),
      ],
      // Summed, not replaced: each attempt repaired the rows IT found stale.
      rowsRecomputed: open.rowsRecomputed + input.actions.rowsRecomputed,
    };
    await db
      .update(schema.hygieneReports)
      .set({
        closedEpicsJson: JSON.stringify(actions.closedEpics),
        closedCount: actions.closedEpics.length,
        rowsRecomputed: actions.rowsRecomputed,
      })
      .where(eq(schema.hygieneReports.id, open.id));
    return { id: open.id, actions };
  }

  const id = randomUUID();
  await db.insert(schema.hygieneReports).values({
    id,
    projectId: input.projectId,
    jobId: input.jobId ?? null,
    generatedAt: secDate(clock.now()),
    completedAt: null,
    closedEpicsJson: JSON.stringify(input.actions.closedEpics),
    rowsRecomputed: input.actions.rowsRecomputed,
    closedCount: input.actions.closedEpics.length,
  });
  return { id, actions: input.actions };
}

/**
 * Land the report tier's findings on an open row and publish it — the point at which the patrol
 * becomes visible to the board. `generatedAt` is stamped here, not at open, so the report is dated
 * when it was produced and a later-completing patrol always sorts newer.
 */
export async function completeHygieneReport(
  db: AntonDb,
  clock: Clock,
  id: string,
  findings: HygieneFinding[],
): Promise<void> {
  const sorted = sortFindings(findings);
  const at = secDate(clock.now());
  const [row] = await db
    .update(schema.hygieneReports)
    .set({
      generatedAt: at,
      completedAt: at,
      findingsJson: JSON.stringify(sorted),
      findingCount: sorted.length,
    })
    .where(eq(schema.hygieneReports.id, id))
    .returning({ projectId: schema.hygieneReports.projectId });
  if (row) await pruneHygieneReports(db, row.projectId);
}

/** The still-open row a previous attempt of this job left behind, if any. */
async function findOpenReportForJob(db: AntonDb, jobId: string) {
  const rows = await db
    .select()
    .from(schema.hygieneReports)
    .where(and(eq(schema.hygieneReports.jobId, jobId), isNull(schema.hygieneReports.completedAt)))
    .orderBy(desc(schema.hygieneReports.generatedAt), NEWEST_FIRST)
    .limit(1);
  return rows[0];
}

/** Keep only the newest {@link HYGIENE_REPORT_RETENTION} reports for a project. */
async function pruneHygieneReports(db: AntonDb, projectId: string): Promise<void> {
  const keep = await db
    .select({ id: schema.hygieneReports.id })
    .from(schema.hygieneReports)
    .where(eq(schema.hygieneReports.projectId, projectId))
    .orderBy(desc(schema.hygieneReports.generatedAt), NEWEST_FIRST)
    .limit(HYGIENE_REPORT_RETENTION);
  if (keep.length < HYGIENE_REPORT_RETENTION) return;
  await db.delete(schema.hygieneReports).where(
    and(
      eq(schema.hygieneReports.projectId, projectId),
      notInArray(
        schema.hygieneReports.id,
        keep.map((r) => r.id),
      ),
    ),
  );
}

function toReport(row: typeof schema.hygieneReports.$inferSelect): HygieneReport {
  const findings = parseJson<HygieneFinding[]>(row.findingsJson, []);
  return {
    id: row.id,
    projectId: row.projectId,
    jobId: row.jobId ?? undefined,
    generatedAt: toEpoch(row.generatedAt),
    actions: {
      closedEpics: parseJson<string[]>(row.closedEpicsJson, []),
      rowsRecomputed: row.rowsRecomputed,
    },
    findings,
    counts: countFindings(findings),
  };
}

/**
 * A corrupt blob degrades to the empty value rather than crashing the board — the denormalized
 * counts still show the patrol saw something, so the discrepancy is visible instead of silent.
 *
 * Both persisted blobs are arrays, so the fallback covers valid-JSON-but-not-an-array too; the
 * `T extends unknown[]` bound keeps that runtime guard and the caller's type in step.
 */
function parseJson<T extends unknown[]>(raw: string, fallback: T): T {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? (parsed as T) : fallback;
  } catch {
    return fallback;
  }
}

/**
 * The project's most recent COMPLETED patrol report, or undefined when it has never been patrolled.
 * A patrol still collecting its findings is not a report yet (see {@link startHygieneReport}).
 */
export async function getHygieneReport(
  db: AntonDb,
  projectId: string,
): Promise<HygieneReport | undefined> {
  const rows = await db
    .select()
    .from(schema.hygieneReports)
    .where(and(eq(schema.hygieneReports.projectId, projectId), COMPLETED))
    .orderBy(desc(schema.hygieneReports.generatedAt), NEWEST_FIRST)
    .limit(1);
  return rows[0] ? toReport(rows[0]) : undefined;
}

/** What one patrol job did — the report row that job wrote, read back by its job id. */
export async function getHygieneReportForJob(
  db: AntonDb,
  jobId: string,
): Promise<HygieneReport | undefined> {
  const rows = await db
    .select()
    .from(schema.hygieneReports)
    .where(and(eq(schema.hygieneReports.jobId, jobId), COMPLETED))
    .limit(1);
  return rows[0] ? toReport(rows[0]) : undefined;
}

/** The project's patrol history, newest first — bounded by {@link HYGIENE_REPORT_RETENTION}. */
export async function listHygieneReports(
  db: AntonDb,
  projectId: string,
): Promise<HygieneReport[]> {
  const rows = await db
    .select()
    .from(schema.hygieneReports)
    .where(and(eq(schema.hygieneReports.projectId, projectId), COMPLETED))
    .orderBy(desc(schema.hygieneReports.generatedAt), NEWEST_FIRST);
  return rows.map(toReport);
}

/** UI read path over the shared anton.db. */
export function latestHygieneReport(projectId: string): Promise<HygieneReport | undefined> {
  return getHygieneReport(getDb(), projectId);
}

/** The refresh-token contribution of a project that has never been patrolled. */
export const NO_HYGIENE_REPORT = "none";

/**
 * A report's identity for the board's refresh token (anton-uwal). A row is served only once it
 * completes and is never rewritten after that — a patrol publishes a new row rather than editing the
 * last one — so the row id IS the version: it changes exactly when there is something new to show,
 * which is what keeps the board's poll 304-friendly.
 */
export function hygieneVersion(report: Pick<HygieneReport, "id"> | undefined): string {
  return report?.id ?? NO_HYGIENE_REPORT;
}

/**
 * The latest report's version without paying to read (or parse) its findings blob — this runs on
 * every board poll, where the answer is almost always "unchanged, 304".
 */
export async function getHygieneVersion(db: AntonDb, projectId: string): Promise<string> {
  const rows = await db
    .select({ id: schema.hygieneReports.id })
    .from(schema.hygieneReports)
    .where(and(eq(schema.hygieneReports.projectId, projectId), COMPLETED))
    .orderBy(desc(schema.hygieneReports.generatedAt), NEWEST_FIRST)
    .limit(1);
  return hygieneVersion(rows[0]);
}

/** UI read path over the shared anton.db. */
export function latestHygieneVersion(projectId: string): Promise<string> {
  return getHygieneVersion(getDb(), projectId);
}
