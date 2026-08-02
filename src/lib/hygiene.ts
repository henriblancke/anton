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
import { and, desc, eq, notInArray, sql } from "drizzle-orm";
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
 */
export async function saveHygieneReport(
  db: AntonDb,
  clock: Clock,
  input: SaveHygieneReportInput,
): Promise<string> {
  const findings = sortFindings(input.findings);
  const id = randomUUID();
  await db.insert(schema.hygieneReports).values({
    id,
    projectId: input.projectId,
    jobId: input.jobId ?? null,
    generatedAt: secDate(clock.now()),
    findingsJson: JSON.stringify(findings),
    closedEpicsJson: JSON.stringify(input.actions.closedEpics),
    rowsRecomputed: input.actions.rowsRecomputed,
    findingCount: findings.length,
    closedCount: input.actions.closedEpics.length,
  });
  await pruneHygieneReports(db, input.projectId);
  return id;
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
 */
function parseJson<T>(raw: string, fallback: T): T {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? (parsed as T) : fallback;
  } catch {
    return fallback;
  }
}

/** The project's most recent patrol report, or undefined when it has never been patrolled. */
export async function getHygieneReport(
  db: AntonDb,
  projectId: string,
): Promise<HygieneReport | undefined> {
  const rows = await db
    .select()
    .from(schema.hygieneReports)
    .where(eq(schema.hygieneReports.projectId, projectId))
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
    .where(eq(schema.hygieneReports.jobId, jobId))
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
    .where(eq(schema.hygieneReports.projectId, projectId))
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
 * A report's identity for the board's refresh token (anton-uwal). Report rows are append-only — a
 * patrol writes a new row and never rewrites an old one — so the row id IS the version: it changes
 * exactly when there is something new to show, which is what keeps the board's poll 304-friendly.
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
    .where(eq(schema.hygieneReports.projectId, projectId))
    .orderBy(desc(schema.hygieneReports.generatedAt), NEWEST_FIRST)
    .limit(1);
  return hygieneVersion(rows[0]);
}

/** UI read path over the shared anton.db. */
export function latestHygieneVersion(projectId: string): Promise<string> {
  return getHygieneVersion(getDb(), projectId);
}
