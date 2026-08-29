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
import type { DeltaState } from "./stringer";
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
   * Against the previous scan. Absent unless this scan measured arrivals since exactly the baseline
   * that scan left ({@link deltaState}) — a scan that established the baseline counts the whole repo
   * rather than an arrival rate, and the two are not the same quantity — and unless BOTH scans ran
   * every collector ({@link collectorFailures}), since two undercounts from different collector sets
   * difference to the outage, not the repo. Absent is "not comparable", a different claim from
   * "no change".
   */
  delta?: ScanDelta;
  /**
   * The `stringer --delta` baseline this scan LEFT — where the next window starts, whatever basis
   * this scan itself measured on. Absent only when anton could not identify stringer's state.
   *
   * It proves CONTIGUITY, and contiguity alone: a retry measuring from exactly this state scanned
   * the window that begins where this point's ends ({@link reconcileAttempt}), and so does the next
   * nightly. Subtracting two points — or folding a retry's window into one — additionally requires
   * this one's counts to be an arrival rate ({@link baselineScan} `=== false`): a baseline scan
   * leaves a baseline behind too, and nothing may be measured against, or added to, ITS standing
   * total.
   */
  deltaState?: string;
  /**
   * The `stringer --delta` baseline this scan STARTED from — where this point's window OPENS.
   * Absent when there was none anton could read (a whole-repo pass, or an unidentified state).
   *
   * It is what tells a retry's rescan apart from a continuation: a pass that dies before triage puts
   * the baseline BACK (src/lib/jobs/nightly-stringer-scan.ts), so the retry measures from THIS value
   * again and REPLAYS the same window — see {@link reconcileAttempt}. A whole-repo pass opens at no
   * baseline, so absent here plus an observed {@link baselineScan} is that same proof. Written once,
   * at insert: neither a replay nor a fold moves where the window opens.
   */
  deltaStateBefore?: string;
  /**
   * True when these counts are a whole-repo STANDING TOTAL, not the arrival rate every incremental
   * point measures — the scan established `--delta`'s baseline, or ran without `--delta`. The trend
   * has to keep the two apart: charting them on one scale reads a baseline followed by two quiet
   * nights as a dramatic improvement out of measurements that were never comparable.
   *
   * Absent is "not known" — a row predating the flag, or a scan whose basis anton could not identify
   * ({@link DeltaState.baselineScan}). It renders as incremental: a point is only set apart with
   * evidence, and an unidentified basis is not evidence of a baseline.
   */
  baselineScan?: boolean;
  /**
   * Absent when triage never ran (a scan with no new signals) or when the session broke the report
   * protocol. Absent means "not reported", never "created nothing".
   */
  triage?: TriageOutcome;
  /** Collectors that died mid-scan — every one is a hole in the counts above (see lib/stringer). */
  collectorFailures: number;
  /**
   * The commit the scanned tree held (anton-qor2) — what makes this point a measurement of a
   * NAMED tree rather than of whatever the checkout happened to be. Absent on rows written before
   * it was recorded, and on a point whose measurement no longer names one tree (see
   * {@link reconcileAttempt}).
   */
  scannedSha?: string;
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

/** Two abutting scan windows as one — what a single scan over their union would have counted. */
function addCounts(a: ScanCounts, b: ScanCounts): ScanCounts {
  const bySeverity = emptySeverityCounts();
  for (const severity of SCAN_SEVERITIES) {
    bySeverity[severity] = a.bySeverity[severity] + b.bySeverity[severity];
  }
  const byClass = emptyClassCounts();
  for (const cls of SIGNAL_CLASSES) byClass[cls] = a.byClass[cls] + b.byClass[cls];
  return { total: a.total + b.total, bySeverity, byClass };
}

/**
 * A stored delta carried onto counts that just moved: it was `counts - previous`, and the previous
 * point hasn't moved, so the delta over the new counts is `delta + moved` — no re-read needed.
 * Signed, because a retry does not only widen a window: one that REPLAYED it can re-measure the
 * same window lower (see {@link reconcileAttempt}).
 */
function extendDelta(delta: ScanDelta, moved: ScanDelta): ScanDelta {
  const bySeverity = emptySeverityCounts();
  for (const severity of SCAN_SEVERITIES) {
    bySeverity[severity] = delta.bySeverity[severity] + moved.bySeverity[severity];
  }
  return { total: delta.total + moved.total, bySeverity };
}

/**
 * Every axis, not just the total: a replayed window can come back with the same number of signals
 * split differently (one fixed, one arrived), and that is a rewrite the chart has to see.
 */
function sameCounts(a: ScanCounts, b: ScanCounts): boolean {
  return (
    a.total === b.total &&
    SCAN_SEVERITIES.every((s) => a.bySeverity[s] === b.bySeverity[s]) &&
    SIGNAL_CLASSES.every((c) => a.byClass[c] === b.byClass[c])
  );
}

/**
 * Two attempts' reports as one. A folded point spans both windows, so its outcome is what each
 * attempt filed for the window it triaged — the pass's beads, counted once each.
 */
function addTriage(
  a: TriageOutcome | undefined,
  b: TriageOutcome | undefined,
): TriageOutcome | undefined {
  if (!a || !b) return a ?? b;
  return { created: a.created + b.created, deduped: a.deduped + b.deduped };
}

function sameTriage(a: TriageOutcome | undefined, b: TriageOutcome | undefined): boolean {
  return a?.created === b?.created && a?.deduped === b?.deduped;
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
  /** The baselines the scan consumed and left, as `lib/stringer` read them — what makes a delta honest. */
  deltaState?: DeltaState;
  /** The commit the scanned tree held — see {@link ScanSummary.scannedSha}. */
  scannedSha?: string;
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
 * WHICH WINDOW a later attempt scanned — the one question every correction in
 * {@link reconcileAttempt} reads off. The point names both ends of its own
 * ({@link ScanSummary.deltaStateBefore}, {@link ScanSummary.deltaState}), so a rescan that REPLAYED
 * the point's window and one that CONTINUED past it can't be confused. Neither moves where the
 * window opens, so that end is written once and never corrected.
 */
interface AttemptWindow {
  /**
   * The attempt ran stringer, so `--delta`'s state has advanced past the one the point publishes and
   * the retained value is a claim nothing holds — including where anton could not identify the state
   * the attempt left, which clears the point's rather than leaving a stale one.
   *
   * Requires the point to name where its own window ENDED: absent, nothing can be proven contiguous,
   * and advancing to the retry's state would hand the next scan a baseline to measure from while the
   * counts it would be differenced against silently exclude the retry's window.
   */
  rescanned: boolean;
  /** {@link attemptReplays} — the retry re-measured the window this point already holds. */
  replays: boolean;
  /** {@link attemptAbuts} — the retry measured the window that starts where this point's ends. */
  abuts: boolean;
  /** Contiguous AND an arrival rate: the only case where two windows' counts sum. */
  folds: boolean;
}

/**
 * The retry measured from exactly where this point's window OPENS, so it rescanned that window
 * whole. That is the ordinary shape of a retry, not an oddity: a pass that dies before triage hands
 * its window back (src/lib/jobs/nightly-stringer-scan.ts), precisely so the retry rescans it rather than
 * closing green over untriaged findings.
 *
 * A pass that ESTABLISHED the baseline replays the same way and names neither end: its window opens
 * at no baseline at all, so handing it back DELETES stringer's state file (lib/stringer) and the
 * retry scanned the whole repo from absent again. Both ends must be an OBSERVED baseline scan
 * ({@link ScanSummary.baselineScan}) — a missing `before` on a basis anton never identified is not
 * evidence the window reopened where this one did.
 */
function attemptReplays(existing: ScanSummary, attempt: DeltaState | undefined): boolean {
  const reopened = attempt?.before !== undefined && attempt.before === existing.deltaStateBefore;
  const rebaselined =
    attempt?.baselineScan === true &&
    attempt.before === undefined &&
    existing.baselineScan === true &&
    existing.deltaStateBefore === undefined;
  return reopened || rebaselined;
}

/**
 * The retry measured from exactly the state this point ended at: proof its window starts where the
 * point's ends, and the only case where their counts can be one measurement. This is the shape of a
 * pass that already triaged and then died — nothing was handed back, so the retry scanned the next
 * window along.
 */
function attemptAbuts(existing: ScanSummary, attempt: DeltaState | undefined): boolean {
  return attempt?.before !== undefined && attempt.before === existing.deltaState;
}

/**
 * A point whose counts are a whole-repo STANDING TOTAL never folds, however cleanly the windows
 * abut. `--delta` reports what stringer newly OBSERVED, never what was REMOVED, so a standing total
 * plus the arrivals since it is an upper bound rather than the repo at the retry's end: 100
 * outstanding, 20 fixed and 3 arrived is 83 in the repo, and 103 is a quantity nobody measured. The
 * retained total IS a measurement — the repo as that scan saw it — so it stands, and the retry's
 * window goes uncounted. The hole costs the trend nothing it could have used: a standing total is
 * charted apart from the arrival columns and licenses no subtraction, so those arrivals were never
 * going to move a trend line, where inflating the column misstates the one thing it does say.
 * Folding is the same class of claim as subtracting and takes the same proof — `baselineScan ===
 * false`, an arrival rate, where two abutting windows' arrivals sum EXACTLY. (A standing total still
 * abuts for {@link publishedState}: the state it hands on can be consumed into no wrong number,
 * since both the delta and the fold demand that same proof of it.) A REPLAY needs no such guard: it
 * never adds to a total, it replaces one measured over the same window — and a point that names
 * where its window opens read a baseline off the repo to begin with, which is what makes it
 * incremental (`lib/stringer`).
 */
function classifyAttempt(existing: ScanSummary, input: SaveScanSummaryInput): AttemptWindow {
  const attempt = input.deltaState;
  const replays = attemptReplays(existing, attempt);
  // A replay wins the tie a point whose window opened and closed on the same state would otherwise
  // create — nothing was consumed there, so there is no second window to add.
  const abuts = !replays && attemptAbuts(existing, attempt);
  return {
    rescanned: attempt !== undefined && existing.deltaState !== undefined,
    replays,
    abuts,
    folds: abuts && existing.baselineScan === false,
  };
}

/**
 * THE WINDOW THE POINT MEASURED. A retry that ran stringer again consumed a window of its own, and
 * those signals are gone from stringer's baseline — no later scan will ever report them. Dropping
 * them would leave a hole in the series exactly where a pass was slow (a long quota backoff is where
 * the retry's window is most likely to be a real day's arrivals, not an empty re-check). So when the
 * windows ABUT, fold its counts in and the point measures the whole pass, start to finish. Without
 * that proof of contiguity there is no union to count: a retry that re-established the baseline
 * emitted a standing total, which double-counts the retained signals.
 *
 * A REPLAY re-measured everything this point holds, plus whatever arrived during the backoff, so its
 * numbers SUPERSEDE the retained ones. Adding them instead would double-count the window; keeping
 * the retained ones would strand a real day's arrivals. A replay can also come back LOWER (fixed in
 * the meantime), which is a fact about the repo and belongs on the point.
 */
function reconciledCounts(
  existing: ScanSummary,
  input: SaveScanSummaryInput,
  attemptWindow: AttemptWindow,
): ScanCounts {
  if (attemptWindow.replays) return input.counts;
  return attemptWindow.folds ? addCounts(existing.counts, input.counts) : existing.counts;
}

/**
 * COMPLETENESS. A folded window brings its collector outages with it, so the failures add — the
 * union is whole only if BOTH attempts ran every collector. A replay re-measured the whole window,
 * so its collectors alone decide whether the point is whole.
 */
function reconciledFailures(
  existing: ScanSummary,
  input: SaveScanSummaryInput,
  attemptWindow: AttemptWindow,
): number {
  if (attemptWindow.replays) return input.collectorFailures ?? 0;
  return existing.collectorFailures + (attemptWindow.folds ? (input.collectorFailures ?? 0) : 0);
}

/**
 * TRIAGE. An outcome covers the WINDOW it triaged, not the point. An attempt that consumed no window
 * of its own reported on the retained signals, so it backfills a report the first attempt never got
 * out. An attempt carrying a window of its own reported on THAT window: it joins the first attempt's
 * outcome when its signals folded in, and is dropped when they didn't — nothing on the point is what
 * it triaged. A replay triaged the point's whole window, so its report is the point's, and the
 * retained one described a measurement that no longer stands however it came out.
 */
function reconciledTriage(
  existing: ScanSummary,
  input: SaveScanSummaryInput,
  attemptWindow: AttemptWindow,
): TriageOutcome | undefined {
  if (attemptWindow.replays) return input.triage;
  // A scan window of its own is what makes this attempt's report someone else's.
  const backfill = input.deltaState === undefined && !existing.triage ? input.triage : undefined;
  const retained = existing.triage ?? backfill;
  const folded = attemptWindow.folds ? input.triage : undefined;
  // The point keeps an outcome only while every window it counts has one: a point whose nine folded
  // signals include seven nobody reported on stays "not reported", rather than showing all nine
  // triaged into the two beads the last two produced. An empty window is covered by nobody having
  // triaged it, since there was nothing there to triage.
  const covered =
    (retained !== undefined || existing.counts.total === 0) &&
    (!attemptWindow.folds || folded !== undefined || input.counts.total === 0);
  return covered ? addTriage(retained, folded) : undefined;
}

/**
 * THE BASELINE THE POINT LEAVES: a value to publish, `null` to clear it, `undefined` to leave it
 * alone. The retry scanned again, so the state the first attempt published is stale. What replaces
 * it depends on whether the windows ABUT. They do, and the state the retry left is where the next
 * window honestly starts: the point publishes it and the next nightly measures an honest delta from
 * it — where keeping the stale one would leave that scan unable to prove comparability, suppressing
 * a delta that was there to be had. They don't, and the retry consumed a window this point counts
 * nothing of: publishing where that window ended would sell the next scan a contiguity proof across
 * the hole, and it would difference its arrivals against counts from an unrelated window — a trend
 * move nothing in the codebase caused. So the point publishes NO baseline at all. Absent is "nothing
 * after this point can be proven contiguous", which is exactly true of a point with a gap behind it.
 *
 * A replay re-measured the whole window, so where it ended is where the point ends.
 */
function publishedState(
  input: SaveScanSummaryInput,
  attemptWindow: AttemptWindow,
): string | null | undefined {
  if (attemptWindow.replays) return input.deltaState?.after ?? null;
  if (!attemptWindow.rescanned) return undefined;
  return attemptWindow.abuts ? (input.deltaState?.after ?? null) : null;
}

/**
 * The point the delta was measured against hasn't moved, so however these counts moved — widened by
 * a fold, re-measured by a replay over the same starting baseline — the stored delta moves with them
 * ({@link extendDelta}). Dropped when the point is an undercount, which is not comparable in either
 * direction — the same rule {@link saveScanSummary} applies across adjacent scans. A point that HAD
 * none stays without one even where the retry made it whole again: the predecessor's counts are not
 * in hand here, and understating comparability costs a delta where inventing one would cost the
 * trend.
 */
function reconciledDelta(
  existing: ScanSummary,
  counts: ScanCounts,
  collectorFailures: number,
): ScanDelta | undefined {
  if (collectorFailures > 0) return undefined;
  if (!existing.delta || sameCounts(counts, existing.counts)) return existing.delta;
  return extendDelta(existing.delta, computeDelta(counts, existing.counts));
}

/**
 * THE TREE THE POINT NAMES. A SHA describes the measurement, so it moves exactly when the
 * measurement does: a replay re-measured this window against the tree the retry checked out, and a
 * fold extends the point to the window that tree ended, so both name it. An attempt whose signals
 * were dropped left the retained measurement standing, tree included.
 *
 * A moved measurement whose tree anton could not name CLEARS the SHA (`null`) rather than keeping
 * the old one: a point holding a tree it no longer measured is the precise claim this column exists
 * to make impossible.
 */
function reconciledTree(
  input: SaveScanSummaryInput,
  attemptWindow: AttemptWindow,
): string | null | undefined {
  if (!attemptWindow.replays && !attemptWindow.folds) return undefined;
  return input.scannedSha ?? null;
}

/** The point after a later attempt folded in — every fact {@link reconcileAttempt} can move. */
interface Reconciled {
  counts: ScanCounts;
  collectorFailures: number;
  triage: TriageOutcome | undefined;
  /** What the point now publishes as the baseline it left — see {@link publishedState}. */
  left: string | null | undefined;
  /** The tree the point now names — see {@link reconciledTree}. */
  tree: string | null | undefined;
  delta: ScanDelta | undefined;
}

/** Which of them actually moved — nothing else is written, and none moving writes nothing at all. */
interface Moved {
  counts: boolean;
  failures: boolean;
  triage: boolean;
  state: boolean;
  tree: boolean;
}

function movedBy(existing: ScanSummary, next: Reconciled): Moved {
  return {
    tree: next.tree !== undefined && (next.tree ?? undefined) !== existing.scannedSha,
    // Every axis: a replay can re-measure the same total over a different split, and the chart draws
    // both. A fold only ever grows the counts, so this reads as "grew" there.
    counts: !sameCounts(next.counts, existing.counts),
    failures: next.collectorFailures !== existing.collectorFailures,
    triage: !sameTriage(next.triage, existing.triage),
    state: next.left !== undefined && next.left !== existing.deltaState,
  };
}

async function writeReconciled(
  db: AntonDb,
  existing: ScanSummary,
  next: Reconciled,
  moved: Moved,
): Promise<void> {
  await db
    .update(schema.scanSummaries)
    .set({
      ...(moved.triage
        ? { beadsCreated: next.triage?.created ?? null, beadsDeduped: next.triage?.deduped ?? null }
        : {}),
      ...(moved.state ? { deltaState: next.left } : {}),
      ...(moved.tree ? { scannedSha: next.tree } : {}),
      ...(moved.failures ? { collectorFailures: next.collectorFailures } : {}),
      ...(moved.counts
        ? {
            totalSignals: next.counts.total,
            bySeverityJson: JSON.stringify(next.counts.bySeverity),
            byClassJson: JSON.stringify(next.counts.byClass),
          }
        : {}),
      ...(next.delta === existing.delta
        ? {}
        : { deltaJson: next.delta ? JSON.stringify(next.delta) : null }),
    })
    .where(eq(schema.scanSummaries.id, existing.id));
}

/** The reconciled row as the caller sees it, without a re-read. */
function mergeReconciled(existing: ScanSummary, next: Reconciled, moved: Moved): ScanSummary {
  const reconciled: ScanSummary = {
    ...existing,
    counts: next.counts,
    collectorFailures: next.collectorFailures,
  };
  if (next.delta) reconciled.delta = next.delta;
  else delete reconciled.delta;
  if (next.triage) reconciled.triage = next.triage;
  else delete reconciled.triage;
  if (moved.state) {
    if (next.left === null) delete reconciled.deltaState;
    else reconciled.deltaState = next.left;
  }
  if (moved.tree) {
    if (next.tree === null) delete reconciled.scannedSha;
    else reconciled.scannedSha = next.tree;
  }
  return reconciled;
}

/**
 * A later attempt adds only what the first one died before knowing, and corrects what it
 * invalidated.
 *
 * {@link classifyAttempt} decides which window the attempt scanned; each step below is that one
 * decision applied to a single fact about the point — what it measured ({@link reconciledCounts}),
 * who triaged it ({@link reconciledTriage}), whether it is whole ({@link reconciledFailures}), and
 * where its window now ends ({@link publishedState}).
 */
async function reconcileAttempt(
  db: AntonDb,
  existing: ScanSummary,
  input: SaveScanSummaryInput,
): Promise<ScanSummary> {
  const attemptWindow = classifyAttempt(existing, input);
  const counts = reconciledCounts(existing, input, attemptWindow);
  const collectorFailures = reconciledFailures(existing, input, attemptWindow);
  const next: Reconciled = {
    counts,
    collectorFailures,
    triage: reconciledTriage(existing, input, attemptWindow),
    left: publishedState(input, attemptWindow),
    tree: reconciledTree(input, attemptWindow),
    delta: reconciledDelta(existing, counts, collectorFailures),
  };

  const moved = movedBy(existing, next);
  if (!moved.counts && !moved.failures && !moved.triage && !moved.state && !moved.tree) {
    return existing;
  }

  await writeReconciled(db, existing, next, moved);
  return mergeReconciled(existing, next, moved);
}

/**
 * This scan against the point it lands on top of. Comparable ONLY when this scan measured arrivals
 * since exactly the baseline that point left, and that point measured an arrival rate itself. A scan
 * with no baseline to measure against emits everything in the repo — a standing total, not the
 * arrival rate every incremental point measures — and subtracting the two charts a move that never
 * happened (a 100-signal baseline after one quiet night reads "+99, debt pouring in"). Counting
 * predecessors can't tell them apart (anton-3flx): stringer's baseline lives in the REPO while this
 * series lives in a disposable anton.db, so either is reset without the other — a rebuilt anton.db
 * would suppress two honest deltas, and a re-established baseline mid-series would sail straight
 * through the count and chart a regression.
 *
 * A scan that lost a collector is not comparable either, in either direction: its total covers only
 * the collectors that survived, so differencing it against a scan built from another set measures
 * the outage rather than the repo — a collector dying reads as "problems arriving more slowly" and
 * its recovery as a regression. Both adjacent scans must be whole.
 */
function comparableDelta(
  input: SaveScanSummaryInput,
  previous: ScanSummary | undefined,
): ScanDelta | undefined {
  const consumed = input.deltaState?.before;
  const whole = (input.collectorFailures ?? 0) === 0 && previous?.collectorFailures === 0;
  // Two conditions, not one: the windows must be contiguous (this scan measured from exactly where
  // that point's ended) AND the point must hold an arrival rate of its own. `baselineScan === false`
  // is that proof — absent is an unidentified basis, which is not evidence of one.
  return consumed && whole && previous?.deltaState === consumed && previous?.baselineScan === false
    ? computeDelta(input.counts, previous.counts)
    : undefined;
}

/** This pass as a point on the series, delta already decided ({@link comparableDelta}). */
function newScanSummary(
  clock: Clock,
  input: SaveScanSummaryInput,
  delta: ScanDelta | undefined,
): ScanSummary {
  // Recorded by every scan that left a state anton could read, a baseline scan included: it says
  // where the next window STARTS, which is as true of a whole-repo pass as of an incremental one —
  // and dropping it left a retry of a baseline pass unable to prove its own window abutted, so a
  // real day's arrivals were stranded (see reconcileAttempt). What it does NOT do is license a
  // subtraction: `baselineScan` decides that.
  const deltaState = input.deltaState?.after;
  // Where this point's window OPENS, recorded so a retry's rescan is legible: measuring from here
  // again means the failure path handed the window back and the retry REPLAYED it, where measuring
  // from `deltaState` means it scanned the next window along (see reconcileAttempt).
  const deltaStateBefore = input.deltaState?.before;
  // Recorded rather than re-derived at read time: the same fact keeps the trend from scaling
  // incremental columns against a whole-repo total long after the baseline itself is gone. Taken as
  // the scan OBSERVED it rather than inferred from a missing `before` — a scan whose basis anton
  // couldn't identify is unknown, and outlining it as a baseline would claim a measurement nobody made.
  const baselineScan = input.deltaState?.baselineScan;
  return {
    id: randomUUID(),
    projectId: input.projectId,
    ...(input.jobId ? { jobId: input.jobId } : {}),
    ...(input.sessionId ? { sessionId: input.sessionId } : {}),
    generatedAt: Math.floor(clock.now() / 1000),
    counts: input.counts,
    ...(delta ? { delta } : {}),
    ...(deltaState ? { deltaState } : {}),
    ...(deltaStateBefore ? { deltaStateBefore } : {}),
    ...(baselineScan === undefined ? {} : { baselineScan }),
    ...(input.triage ? { triage: input.triage } : {}),
    collectorFailures: input.collectorFailures ?? 0,
    // The tree these counts describe. Written at insert and only moved with the measurement itself
    // (see {@link reconciledTree}) — a point names the tree it measured or names none.
    ...(input.scannedSha ? { scannedSha: input.scannedSha } : {}),
  };
}

async function insertScanSummary(db: AntonDb, summary: ScanSummary): Promise<void> {
  await db.insert(schema.scanSummaries).values({
    id: summary.id,
    projectId: summary.projectId,
    jobId: summary.jobId ?? null,
    sessionId: summary.sessionId ?? null,
    // The summary's own second-resolution stamp, so the row and the object it came from agree.
    generatedAt: new Date(summary.generatedAt * 1000),
    totalSignals: summary.counts.total,
    bySeverityJson: JSON.stringify(summary.counts.bySeverity),
    byClassJson: JSON.stringify(summary.counts.byClass),
    deltaJson: summary.delta ? JSON.stringify(summary.delta) : null,
    deltaState: summary.deltaState ?? null,
    deltaStateBefore: summary.deltaStateBefore ?? null,
    baselineScan: summary.baselineScan ?? null,
    beadsCreated: summary.triage?.created ?? null,
    beadsDeduped: summary.triage?.deduped ?? null,
    collectorFailures: summary.collectorFailures,
    scannedSha: summary.scannedSha ?? null,
  });
}

/**
 * Append this scan's summary and prune the project back to {@link SCAN_SUMMARY_RETENTION} rows.
 * The delta is computed HERE, against the row this one lands on top of when the two are provably
 * comparable, and stored — so a point still names what it changed once the scan it was compared to
 * has aged out of the window.
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
    if (already) return reconcileAttempt(db, already, input);
  }

  const previous = await getLatestScanSummary(db, input.projectId);
  const summary = newScanSummary(clock, input, comparableDelta(input, previous));
  await insertScanSummary(db, summary);
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
    ...(row.deltaState ? { deltaState: row.deltaState } : {}),
    ...(row.deltaStateBefore ? { deltaStateBefore: row.deltaStateBefore } : {}),
    ...(row.baselineScan === null ? {} : { baselineScan: row.baselineScan }),
    ...(triage ? { triage } : {}),
    collectorFailures: row.collectorFailures,
    ...(row.scannedSha ? { scannedSha: row.scannedSha } : {}),
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
  /**
   * This column counts the whole repo, not what arrived — see {@link ScanSummary.baselineScan}. The
   * chart must render it apart from the incremental columns and never scale them against it.
   */
  baseline?: boolean;
  /**
   * At least one collector died on this scan, so the column is a floor rather than a measurement —
   * see {@link ScanSummary.collectorFailures}. It travels with every point, not just the latest one:
   * suppressing the delta keeps the outage out of the TREND, but the raw column stays on the chart
   * forever, and drawn like a whole scan an incomplete zero becomes the clean-pass tick — the next
   * scan then reads as a regression from an improvement that never happened.
   */
  incomplete?: boolean;
  triage?: TriageOutcome;
  /**
   * The commit the scanned tree held — see {@link ScanSummary.scannedSha}. Rendered so a column
   * names the tree it measured: a scan of a checkout behind its remote looks exactly like a scan of
   * the shipped code otherwise, and the trend that follows is about a tree nobody works on.
   */
  sha?: string;
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
    ...(summary.baselineScan ? { baseline: true } : {}),
    ...(summary.collectorFailures > 0 ? { incomplete: true } : {}),
    ...(summary.triage ? { triage: summary.triage } : {}),
    ...(summary.scannedSha ? { sha: summary.scannedSha } : {}),
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

/** The counts the chart draws, on every axis, in one comparable component. */
function countsStamp(counts: ScanCounts): string {
  return [
    counts.total,
    ...SCAN_SEVERITIES.map((s) => counts.bySeverity[s]),
    ...SIGNAL_CLASSES.map((c) => counts.byClass[c]),
  ].join(".");
}

/**
 * The newest row's identity for the board's refresh token. The id alone is not enough: a retried job
 * rewrites the existing row ({@link reconcileAttempt}) — backfilling or clearing triage counts,
 * folding a contiguous retry's signals and collector outages into the point's own, replacing the
 * whole measurement when the retry replayed the window — so a token built from the id would keep
 * matching and a board polling between the two writes would never show either. The counts are
 * stamped on every axis rather than by their total, because a replay can come back with the same
 * number of signals split differently and the chart draws the split. The failure count is stamped in
 * its own right, since a retry can mark the column incomplete (and drop its delta) without moving a
 * single count. The remaining value a retry rewrites — the baseline the point left — is bookkeeping
 * the board never renders, so stamping the visible mutable fields keeps the poll 304-friendly while
 * still moving when there is something new to render.
 *
 * The scanned tree is stamped for the same reason as the counts: a replay can re-measure the same
 * window against a DIFFERENT checkout and come back with an identical split, and the section names
 * the tree — so without it the board would keep 304ing over a point that now describes another commit.
 */
function scanVersion(
  id: string,
  counts: ScanCounts,
  triage: TriageOutcome | undefined,
  collectorFailures: number,
  scannedSha: string | null | undefined,
): string {
  return (
    `${id}:${countsStamp(counts)}:${collectorFailures}` +
    `${triage ? `:${triage.created}:${triage.deduped}` : ""}${scannedSha ? `:${scannedSha}` : ""}`
  );
}

/** The series' identity for the board's refresh token. */
export function scanHealthVersion(health: ScanHealth | undefined): string {
  if (!health) return NO_SCAN_HEALTH;
  const { latest } = health;
  const counts = { total: latest.total, bySeverity: latest.bySeverity, byClass: health.byClass };
  return scanVersion(latest.id, counts, latest.triage, health.collectorFailures, latest.sha);
}

/**
 * The version without paying to read the whole window — one row. The newest row's splits are parsed
 * through the same {@link parseCounts} the served view uses, so the cheap token and the served one
 * are the same string for the same row (a poll compares them; two spellings would 304 forever or
 * never).
 */
export async function latestScanHealthVersion(projectId: string): Promise<string> {
  const rows = await getDb()
    .select({
      id: schema.scanSummaries.id,
      totalSignals: schema.scanSummaries.totalSignals,
      bySeverityJson: schema.scanSummaries.bySeverityJson,
      byClassJson: schema.scanSummaries.byClassJson,
      beadsCreated: schema.scanSummaries.beadsCreated,
      beadsDeduped: schema.scanSummaries.beadsDeduped,
      collectorFailures: schema.scanSummaries.collectorFailures,
      scannedSha: schema.scanSummaries.scannedSha,
    })
    .from(schema.scanSummaries)
    .where(eq(schema.scanSummaries.projectId, projectId))
    .orderBy(desc(schema.scanSummaries.generatedAt), NEWEST_FIRST)
    .limit(1);
  const row = rows[0];
  if (!row) return NO_SCAN_HEALTH;
  const counts: ScanCounts = {
    total: row.totalSignals,
    bySeverity: parseCounts(row.bySeverityJson, emptySeverityCounts()),
    byClass: parseCounts(row.byClassJson, emptyClassCounts()),
  };
  return scanVersion(row.id, counts, rowTriage(row), row.collectorFailures, row.scannedSha);
}

/** One-line summary for the job log: what this scan found, and how it moved. */
export function summarizeScanLine(summary: ScanSummary): string {
  const split = SCAN_SEVERITIES.filter((s) => summary.counts.bySeverity[s] > 0)
    .map((s) => `${summary.counts.bySeverity[s]} ${s}`)
    .join(", ");
  const delta =
    summary.delta !== undefined
      ? `${summary.delta.total >= 0 ? "+" : ""}${summary.delta.total} vs previous scan`
      : summary.baselineScan
        ? "baseline scan — the whole repo, not new arrivals; no delta"
        : summary.collectorFailures > 0
          ? "collector failures — counts are an undercount, not comparable; no delta"
          : "no comparable previous scan — no delta";
  const triage = summary.triage
    ? `; triage created ${summary.triage.created}, deduped ${summary.triage.deduped}`
    : "";
  // The tree, named on the line itself: a scan of a stale checkout otherwise reads exactly like a
  // scan of the shipped code (anton-qor2).
  const tree = summary.scannedSha ? ` at ${summary.scannedSha.slice(0, 8)}` : "";
  return `${summary.counts.total} signal(s)${split ? ` (${split})` : ""}${tree}; ${delta}${triage}`;
}
