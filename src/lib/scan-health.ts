/**
 * Per-scan codebase health (anton-bz1w): what each nightly stringer pass found, kept as an
 * append-only series so the board can answer the question one scan can't — is this codebase getting
 * healthier, or is new debt arriving faster than it's paid down?
 *
 * WHERE IT LANDS — anton.db, one row per nightly-stringer run, pruned to a window (the
 * `hygiene_reports` pattern), NOT a bd comment thread (the review-score pattern). A review score
 * describes a BEAD: it has to outlive the worktree it was earned in and be readable on whatever
 * machine opens the board, so the board is its only honest home. A scan summary describes the REPO
 * AT A MOMENT, and it is measured against `stringer --delta`'s baseline — which is machine-local,
 * per checkout. Two machines scanning the same repo produce two independent series; interleaving
 * them on a shared monitor bead would render a trend that is the artifact of which machine's cron
 * fired, not of the codebase. So the series lives beside the scan files it summarizes, and is
 * disposable with them.
 *
 * WHAT THE NUMBERS MEAN — `--delta` restricts every scan to signals NEW since the last one, so a
 * point is the arrival rate of new problems, not the total outstanding. Healthy is falling, and a
 * zero-signal scan is a real (good) data point. The UI must say this out loud; the counts read as a
 * backlog otherwise.
 */
import { randomUUID } from "node:crypto";
import { and, desc, eq, notInArray, sql } from "drizzle-orm";
import { getDb, schema } from "./db";
import type { AntonDb, Clock } from "./jobs/queue";
import {
  SCAN_SEVERITIES,
  SIGNAL_CLASSES,
  classOfSignal,
  severityOfSignal,
  type ScanSeverity,
  type ScanSignal,
  type SignalClass,
} from "./scan-severity";

export type SeverityCounts = Record<ScanSeverity, number>;
export type ClassCounts = Record<SignalClass, number>;

/** One scan's signal counts, on both axes. Every key is present — an absent kind counts 0. */
export interface ScanCounts {
  total: number;
  bySeverity: SeverityCounts;
  byClass: ClassCounts;
}

/** This scan against the one before it. Signed: negative is fewer new signals, which is better. */
export interface ScanDelta {
  total: number;
  bySeverity: SeverityCounts;
}

/** What triage did with the scan — parsed from the /scan-triage session's own report line. */
export interface TriageOutcome {
  created: number;
  deduped: number;
}

/** One nightly-stringer pass, as the health series records it. */
export interface ScanSummary {
  id: string;
  projectId: string;
  /** The nightly-stringer job that produced it, so a point traces back to its job row. */
  jobId?: string;
  /** That job's claude/scan session, so a point traces back to the log and the scan file. */
  sessionId?: string;
  /** Unix seconds, matching every other timestamp this app hands the UI. */
  generatedAt: number;
  counts: ScanCounts;
  /**
   * Against the previous scan. Absent until there is a COMPARABLE one — the first scan has nothing
   * before it, and the second's predecessor is a baseline counting the whole repo rather than an
   * arrival rate. Absent is "not comparable yet", a different claim from "no change".
   */
  delta?: ScanDelta;
  /**
   * Absent when triage never ran (a scan with no new signals) or when the session broke the report
   * protocol. Absent means "not reported", never "created nothing".
   */
  triage?: TriageOutcome;
  /** Collectors that died mid-scan — every one is a hole in the counts above (see lib/stringer). */
  collectorFailures: number;
}

/**
 * How many scans to keep per project. Nightly by default, so this is roughly two months of trend —
 * long enough to see a quarter's worth of direction, short enough to stay a bounded local table.
 */
export const SCAN_SUMMARY_RETENTION = 60;

/**
 * How many of them the board charts. A trend the eye can read in one glance: two weeks of nightlies
 * shows whether the last change moved anything, where two months of columns would just be texture.
 */
export const SCAN_HEALTH_WINDOW = 14;

/** Insertion order, newest first — the tiebreak for two scans landing inside the same second. */
const NEWEST_FIRST = sql`rowid desc`;

function secDate(ms: number): Date {
  return new Date(Math.floor(ms / 1000) * 1000);
}

function toEpoch(value: unknown): number {
  if (value instanceof Date) return Math.floor(value.getTime() / 1000);
  return Number(value ?? 0);
}

export function emptySeverityCounts(): SeverityCounts {
  return Object.fromEntries(SCAN_SEVERITIES.map((s) => [s, 0])) as SeverityCounts;
}

function emptyClassCounts(): ClassCounts {
  return Object.fromEntries(SIGNAL_CLASSES.map((c) => [c, 0])) as ClassCounts;
}

export function emptyScanCounts(): ScanCounts {
  return { total: 0, bySeverity: emptySeverityCounts(), byClass: emptyClassCounts() };
}

/** Count a scan's signals on both axes. Unknown collectors land in `other`/`medium`, never dropped. */
export function summarizeSignals(signals: ScanSignal[]): ScanCounts {
  const counts = emptyScanCounts();
  for (const signal of signals) {
    counts.total += 1;
    counts.bySeverity[severityOfSignal(signal)] += 1;
    counts.byClass[classOfSignal(signal)] += 1;
  }
  return counts;
}

/**
 * The bead counts out of the /scan-triage session's closing report (skills/scan-triage §6):
 * `created: N (F features, T tickets) · epics: … · deduped: D · …`.
 *
 * Undefined when the line isn't there — a session that skipped its own protocol reported nothing,
 * and recording a zero would put "triage created no beads" on the chart for a pass that may well
 * have created several.
 *
 * BOTH counters are required, not either: the report is written by an agent, so partial protocol
 * compliance is a live failure mode, and half a line is still an unreported outcome. Defaulting the
 * missing half to 0 would assert a triage result the session never claimed — which is the one thing
 * "not reported" exists to avoid.
 */
export function parseTriageOutcome(text: string | undefined): TriageOutcome | undefined {
  if (!text) return undefined;
  // `created:` appears before its number; the epic line's "C created" puts the number FIRST, so an
  // anchored `created:\s*(\d+)` can only match the bead count.
  const created = /created:\s*(\d+)/i.exec(text);
  const deduped = /deduped:\s*(\d+)/i.exec(text);
  if (!created || !deduped) return undefined;
  return { created: Number(created[1]), deduped: Number(deduped[1]) };
}

/** This scan minus the previous one, per severity and in total. */
export function computeDelta(counts: ScanCounts, previous: ScanCounts): ScanDelta {
  const bySeverity = emptySeverityCounts();
  for (const severity of SCAN_SEVERITIES) {
    bySeverity[severity] = counts.bySeverity[severity] - previous.bySeverity[severity];
  }
  return { total: counts.total - previous.total, bySeverity };
}

export interface SaveScanSummaryInput {
  projectId: string;
  jobId?: string;
  sessionId?: string;
  counts: ScanCounts;
  triage?: TriageOutcome;
  collectorFailures?: number;
}

/**
 * The point a job already landed, if it landed one. One scheduled pass is ONE point on the trend
 * however many attempts it took: the runner retries a failed job under the same job id with a fresh
 * handler, and a retry rescans a baseline the first attempt already consumed — so a second insert
 * would chart a phantom zero-signal scan and hand the next delta a baseline that never existed,
 * distorting both the trend and the retention window.
 */
async function findScanSummaryByJob(
  db: AntonDb,
  projectId: string,
  jobId: string,
): Promise<ScanSummary | undefined> {
  const rows = await db
    .select()
    .from(schema.scanSummaries)
    .where(
      and(eq(schema.scanSummaries.projectId, projectId), eq(schema.scanSummaries.jobId, jobId)),
    )
    .limit(1);
  return rows[0] ? toSummary(rows[0]) : undefined;
}

/**
 * A later attempt adds only what the first one died before knowing. The first attempt's counts are
 * the ones measured against the baseline the pass began with, so they stand — but an attempt that
 * finally got a triage report out of the session contributes it, rather than leaving the point
 * claiming triage never reported.
 */
async function backfillTriage(
  db: AntonDb,
  existing: ScanSummary,
  triage: TriageOutcome | undefined,
): Promise<ScanSummary> {
  if (!triage || existing.triage) return existing;
  await db
    .update(schema.scanSummaries)
    .set({ beadsCreated: triage.created, beadsDeduped: triage.deduped })
    .where(eq(schema.scanSummaries.id, existing.id));
  return { ...existing, triage };
}

/**
 * Append this scan's summary and prune the project back to {@link SCAN_SUMMARY_RETENTION} rows.
 * The delta is computed HERE, against the row this one lands on top of, and stored — so a point
 * still names what it changed once the scan it was compared to has aged out of the window.
 *
 * Every pass writes one, including a scan that found nothing: "scanned, clean" is the data point
 * that makes a falling trend readable, and skipping it would leave the chart claiming the last
 * noisy scan is still the state of the repo.
 *
 * ONE point per job, however many attempts it took — see {@link findScanSummaryByJob}.
 */
export async function saveScanSummary(
  db: AntonDb,
  clock: Clock,
  input: SaveScanSummaryInput,
): Promise<ScanSummary> {
  if (input.jobId) {
    const already = await findScanSummaryByJob(db, input.projectId, input.jobId);
    if (already) return backfillTriage(db, already, input.triage);
  }

  // A project's FIRST scan has no `--delta` baseline, so stringer emits everything in the repo:
  // that point is a standing total, not the arrival rate every later point measures. Subtracting it
  // from the first genuinely incremental scan charts a collapse that never happened — a 100-signal
  // baseline followed by one new signal would read "−99, problems arriving more slowly". So the
  // trend starts comparing at the scan AFTER the baseline, where both sides are the same quantity.
  const [previous, beforeThat] = await listScanSummaries(db, input.projectId, 2);
  const delta = previous && beforeThat ? computeDelta(input.counts, previous.counts) : undefined;
  const summary: ScanSummary = {
    id: randomUUID(),
    projectId: input.projectId,
    ...(input.jobId ? { jobId: input.jobId } : {}),
    ...(input.sessionId ? { sessionId: input.sessionId } : {}),
    generatedAt: Math.floor(clock.now() / 1000),
    counts: input.counts,
    ...(delta ? { delta } : {}),
    ...(input.triage ? { triage: input.triage } : {}),
    collectorFailures: input.collectorFailures ?? 0,
  };

  await db.insert(schema.scanSummaries).values({
    id: summary.id,
    projectId: summary.projectId,
    jobId: summary.jobId ?? null,
    sessionId: summary.sessionId ?? null,
    generatedAt: secDate(clock.now()),
    totalSignals: summary.counts.total,
    bySeverityJson: JSON.stringify(summary.counts.bySeverity),
    byClassJson: JSON.stringify(summary.counts.byClass),
    deltaJson: delta ? JSON.stringify(delta) : null,
    beadsCreated: summary.triage?.created ?? null,
    beadsDeduped: summary.triage?.deduped ?? null,
    collectorFailures: summary.collectorFailures,
  });
  await pruneScanSummaries(db, summary.projectId);
  return summary;
}

/** Keep only the newest {@link SCAN_SUMMARY_RETENTION} summaries for a project. */
async function pruneScanSummaries(db: AntonDb, projectId: string): Promise<void> {
  const keep = await db
    .select({ id: schema.scanSummaries.id })
    .from(schema.scanSummaries)
    .where(eq(schema.scanSummaries.projectId, projectId))
    .orderBy(desc(schema.scanSummaries.generatedAt), NEWEST_FIRST)
    .limit(SCAN_SUMMARY_RETENTION);
  if (keep.length < SCAN_SUMMARY_RETENTION) return;
  await db.delete(schema.scanSummaries).where(
    and(
      eq(schema.scanSummaries.projectId, projectId),
      notInArray(
        schema.scanSummaries.id,
        keep.map((r) => r.id),
      ),
    ),
  );
}

/**
 * A corrupt blob degrades to zeroed counts rather than crashing the board — `totalSignals` is
 * denormalized, so a discrepancy between the total and its split stays visible instead of silent.
 */
function parseCounts<T extends object>(raw: string, fallback: T): T {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? { ...fallback, ...(parsed as T) }
      : fallback;
  } catch {
    return fallback;
  }
}

/** The two triage columns as they are stored — the only mutable part of an otherwise append-only row. */
interface TriageColumns {
  beadsCreated: number | null;
  beadsDeduped: number | null;
}

/**
 * Both counters are written from one {@link TriageOutcome}, so a row carrying only one of them is a
 * half-written outcome — the case {@link parseTriageOutcome} refuses for the same reason. Filling the
 * missing half with 0 would assert a triage result no session ever reported.
 */
function rowTriage(row: TriageColumns): TriageOutcome | undefined {
  return row.beadsCreated !== null && row.beadsDeduped !== null
    ? { created: row.beadsCreated, deduped: row.beadsDeduped }
    : undefined;
}

function toSummary(row: typeof schema.scanSummaries.$inferSelect): ScanSummary {
  const delta = row.deltaJson
    ? parseCounts<ScanDelta>(row.deltaJson, { total: 0, bySeverity: emptySeverityCounts() })
    : undefined;
  const triage = rowTriage(row);
  return {
    id: row.id,
    projectId: row.projectId,
    ...(row.jobId ? { jobId: row.jobId } : {}),
    ...(row.sessionId ? { sessionId: row.sessionId } : {}),
    generatedAt: toEpoch(row.generatedAt),
    counts: {
      total: row.totalSignals,
      bySeverity: parseCounts(row.bySeverityJson, emptySeverityCounts()),
      byClass: parseCounts(row.byClassJson, emptyClassCounts()),
    },
    ...(delta ? { delta } : {}),
    ...(triage ? { triage } : {}),
    collectorFailures: row.collectorFailures,
  };
}

/** The project's most recent scan summary, or undefined when it has never been scanned. */
export async function getLatestScanSummary(
  db: AntonDb,
  projectId: string,
): Promise<ScanSummary | undefined> {
  const rows = await db
    .select()
    .from(schema.scanSummaries)
    .where(eq(schema.scanSummaries.projectId, projectId))
    .orderBy(desc(schema.scanSummaries.generatedAt), NEWEST_FIRST)
    .limit(1);
  return rows[0] ? toSummary(rows[0]) : undefined;
}

/** The project's scan history, newest first — bounded by {@link SCAN_SUMMARY_RETENTION}. */
export async function listScanSummaries(
  db: AntonDb,
  projectId: string,
  limit = SCAN_HEALTH_WINDOW,
): Promise<ScanSummary[]> {
  const rows = await db
    .select()
    .from(schema.scanSummaries)
    .where(eq(schema.scanSummaries.projectId, projectId))
    .orderBy(desc(schema.scanSummaries.generatedAt), NEWEST_FIRST)
    .limit(limit);
  return rows.map(toSummary);
}

/** One column of the trend. */
export interface ScanHealthPoint {
  id: string;
  /** Unix seconds. */
  at: number;
  total: number;
  bySeverity: SeverityCounts;
  triage?: TriageOutcome;
}

/** The board's view of the series — oldest → newest, because a trend is read left to right. */
export interface ScanHealth {
  points: ScanHealthPoint[];
  /** The most recent scan; always the last of {@link points}. */
  latest: ScanHealthPoint;
  /** What the latest scan changed. Absent until a comparable predecessor exists (see ScanSummary). */
  delta?: ScanDelta;
  /** The latest scan's class split — what KIND of problems arrived, beside how many. */
  byClass: ClassCounts;
  /** Collectors that died in the latest scan: its counts are that much of an undercount. */
  collectorFailures: number;
}

function toPoint(summary: ScanSummary): ScanHealthPoint {
  return {
    id: summary.id,
    at: summary.generatedAt,
    total: summary.counts.total,
    bySeverity: summary.counts.bySeverity,
    ...(summary.triage ? { triage: summary.triage } : {}),
  };
}

/**
 * The trend over a project's scan history, or `undefined` when it has never been scanned.
 *
 * Undefined rather than an empty series: "never scanned" and "scanned, nothing found" are opposite
 * claims about a repo, and a panel that rendered both as an empty chart would say the wrong one.
 *
 * @param summaries newest-first, as {@link listScanSummaries} returns them.
 */
export function scanHealth(summaries: ScanSummary[]): ScanHealth | undefined {
  const [latest] = summaries;
  if (!latest) return undefined;
  return {
    points: [...summaries].reverse().map(toPoint),
    latest: toPoint(latest),
    ...(latest.delta ? { delta: latest.delta } : {}),
    byClass: latest.counts.byClass,
    collectorFailures: latest.collectorFailures,
  };
}

/** UI read path over the shared anton.db. */
export async function latestScanHealth(projectId: string): Promise<ScanHealth | undefined> {
  return scanHealth(await listScanSummaries(getDb(), projectId));
}

/** The refresh-token contribution of a project that has never been scanned. */
export const NO_SCAN_HEALTH = "none";

/**
 * The newest row's identity for the board's refresh token. The id alone is not enough: a retried job
 * backfills triage counts INTO the existing row ({@link backfillTriage}), so a token built from the
 * id would keep matching and a board polling between the two writes would never show the
 * created/deduped figures. Everything else about a row is append-only, so stamping the one mutable
 * pair keeps the poll 304-friendly while still moving when there is something new to render.
 */
function scanVersion(id: string, triage: TriageOutcome | undefined): string {
  return triage ? `${id}:${triage.created}:${triage.deduped}` : id;
}

/** The series' identity for the board's refresh token. */
export function scanHealthVersion(health: ScanHealth | undefined): string {
  const latest = health?.latest;
  return latest ? scanVersion(latest.id, latest.triage) : NO_SCAN_HEALTH;
}

/** The version without paying to read the whole window — one row, no blob parse. */
export async function latestScanHealthVersion(projectId: string): Promise<string> {
  const rows = await getDb()
    .select({
      id: schema.scanSummaries.id,
      beadsCreated: schema.scanSummaries.beadsCreated,
      beadsDeduped: schema.scanSummaries.beadsDeduped,
    })
    .from(schema.scanSummaries)
    .where(eq(schema.scanSummaries.projectId, projectId))
    .orderBy(desc(schema.scanSummaries.generatedAt), NEWEST_FIRST)
    .limit(1);
  const row = rows[0];
  return row ? scanVersion(row.id, rowTriage(row)) : NO_SCAN_HEALTH;
}

/** One-line summary for the job log: what this scan found, and how it moved. */
export function summarizeScanLine(summary: ScanSummary): string {
  const split = SCAN_SEVERITIES.filter((s) => summary.counts.bySeverity[s] > 0)
    .map((s) => `${summary.counts.bySeverity[s]} ${s}`)
    .join(", ");
  const delta =
    summary.delta === undefined
      ? "no comparable previous scan — no delta"
      : `${summary.delta.total >= 0 ? "+" : ""}${summary.delta.total} vs previous scan`;
  const triage = summary.triage
    ? `; triage created ${summary.triage.created}, deduped ${summary.triage.deduped}`
    : "";
  return `${summary.counts.total} signal(s)${split ? ` (${split})` : ""}; ${delta}${triage}`;
}
