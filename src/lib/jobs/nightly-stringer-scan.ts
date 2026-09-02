/**
 * The nightly pass's measuring half: bring the checkout onto the tree that shipped, run
 * `stringer scan --delta` over it, say out loud what the scan dropped or lost, and — when the pass
 * dies before triage reads the findings — give the consumed `--delta` window back.
 *
 * Extracted from the job handler (anton-xdgw) so the window rules live in one testable place: every
 * one of them is about the seam between "this pass saw signals" and "someone triaged them", and
 * they are only correct together.
 */
import { join } from "node:path";
import { appendSessionLog } from "../sessions";
import { checkoutMoved, describeBuildDrift, serverBuildDrift } from "../build/drift";
import { refreshCheckout } from "../git/refresh";
import { describeCouplingFilter } from "../scan-coupling";
import { describeDuplicationFilter } from "../scan-duplication";
import { summarizeSignals, type ScanCounts } from "../scan-health";
import {
  describeCollectorFailure,
  describeUntrackedFilter,
  rejectWithBaselineRestored,
  scan,
  type DeltaState,
  type ScanResult,
} from "../stringer";
import type { Project } from "../types";
import { PoisonError } from "./errors";

/** What one scan measured, and what the pass still owes its `--delta` window. */
export interface ScanPass {
  /** Absolute path to the annotated scan file triage reads. */
  scanFile: string;
  /** The commit the scan measured — the tree that shipped. */
  scannedSha: string;
  counts: ScanCounts;
  collectorFailures: number;
  deltaState: DeltaState;
  /** Put the `--delta` baseline back where this scan found it (see {@link restoreScanWindow}). */
  restoreBaseline: () => Promise<string | undefined>;
  /**
   * Say what the scan dropped or lost. Deliberately NOT run inside {@link scanShippedTree}: these
   * are session-log writes, and a log write can fail (a full disk, a session dir removed mid-pass)
   * long after the scan consumed its `--delta` window. Called by the caller once it holds this
   * handle, so such a failure lands in a catch that can still hand the window back.
   */
  reportDiagnostics: () => Promise<void>;
}

/** Where a scan file lands — under anton's own dir, disposable with anton.db. */
function scanFilePath(id: string): string {
  const root = process.env.ANTON_SCANS_ROOT ?? join(process.cwd(), ".anton", "scans");
  return join(root, `${id}.json`);
}

/**
 * Fast-forward the project checkout onto its remote default branch and return the commit the scan
 * will measure — or THROW, so the pass stands down before consuming its `--delta` window.
 *
 * Throwing is how "do not scan a stale tree" is enforced: the scan is what consumes the window, and
 * anything short of a hard stop here leaves a later edit free to reintroduce the silent triage this
 * exists to prevent. A checkout anton could not read or fetch is a plain error — the runner retries
 * it, and the next attempt may well reach the remote. A dirty, diverged, or remote-less checkout is
 * POISON: no retry changes it, only a human, and burning the attempt budget nightly would bury the
 * one line that says what to fix (see {@link refreshCheckout} — anton never resolves it itself).
 */
export async function bringCheckoutForward(project: Project, logPath: string): Promise<string> {
  const refresh = await refreshCheckout(project.repoPath, project.defaultBranch);
  if (!refresh.drift && refresh.head) {
    if (refresh.advancedFrom) {
      await appendSessionLog(
        logPath,
        `[stringer] checkout fast-forwarded ${refresh.advancedFrom} → ${refresh.head} ` +
          `(origin/${project.defaultBranch})\n`,
      );
    }
    return refresh.head;
  }

  const detail =
    `checkout drift — ${refresh.drift ?? "git could not name the commit this checkout holds"}. ` +
    `Standing down BEFORE the scan: nothing ran, so the --delta window is untouched and the next ` +
    `pass still sees it. A scan here would measure a tree that is not what shipped`;
  await appendSessionLog(logPath, `[stringer] ERROR: ${detail}\n`);
  console.warn(`[nightly-stringer] ${project.slug}: ${detail}`);
  throw refresh.transient ? new Error(detail) : new PoisonError(detail);
}

/**
 * Everything the scan silently lost or dropped, said on the session BEFORE the no-signals early
 * return: a pass whose collector died, or whose only findings were phantoms, must read as a damaged
 * or filtered scan rather than as a clean nothing-to-do.
 *
 * Reached through {@link ScanPass.reportDiagnostics}, never from the scan itself — see there for
 * why the window handle must escape first.
 */
async function reportScanDiagnostics(
  result: ScanResult,
  project: Project,
  logPath: string,
): Promise<void> {
  // The trend can only subtract two scans that measured against the same stringer baseline, and
  // that proof is the baseline anton read off the repo. If it isn't where anton looks, every
  // point stays uncomparable — say so, rather than letting the trend quietly lose its deltas.
  if (!result.deltaState.after) {
    const detail =
      `stringer's --delta baseline was not found under ${project.repoPath} — this scan's point ` +
      `carries no comparison, and none will until anton can identify it`;
    await appendSessionLog(logPath, `[stringer] WARNING: ${detail}\n`);
    console.warn(`[nightly-stringer] ${project.slug}: ${detail}`);
  }

  // A dead collector still exits 0 (anton-uspu) — a scan that lost gitlog must not read as clean.
  for (const failure of result.collectorFailures) {
    const detail = describeCollectorFailure(failure);
    await appendSessionLog(logPath, `[stringer] WARNING: ${detail}\n`);
    console.warn(`[nightly-stringer] ${project.slug}: ${detail}`);
  }

  // Signals dropped for naming a file git doesn't track (anton-j2zg).
  const untrackedLine = describeUntrackedFilter(result.untracked);
  if (untrackedLine) {
    const prefix = result.untracked.unavailable ? "WARNING: " : "";
    await appendSessionLog(logPath, `[stringer] ${prefix}${untrackedLine}\n`);
    if (result.untracked.unavailable) {
      console.warn(`[nightly-stringer] ${project.slug}: ${untrackedLine}`);
    }
  }

  // Coupling signals whose edges only the type system can see (anton-yvx9). Said out loud for the
  // same reason: a dropped architecture finding must read as a filtered scan, and the log is the
  // only place the drop and its proof still exist.
  const couplingLine = describeCouplingFilter(result.coupling);
  if (couplingLine) await appendSessionLog(logPath, `[stringer] ${couplingLine}\n`);

  // Duplication signals over blocks that hold no statement (anton-vb2h). This filter can remove
  // most of a scan, so it says so out loud: silence here would be indistinguishable from a
  // duplication collector that found nothing.
  const duplicationLine = describeDuplicationFilter(result.duplication);
  if (duplicationLine) await appendSessionLog(logPath, `[stringer] ${duplicationLine}\n`);
}

/**
 * Name the stale process on the session, beside the line recording what this pass invoked
 * (anton-pzfb). The pass runs the code THIS SERVER booted with, not the code in the checkout it just
 * fast-forwarded, so a guard that shipped days ago may simply not be in it — three nightlies in a
 * row filed a signal two landed filters already dropped, and the only tell was a log line the
 * running build was too old to write. The claim belongs on the log because that is where the run is
 * reconstructed afterwards; the scan proceeds either way.
 *
 * The verdict has to stand on the tree the fast-forward just left, not on a read taken before it
 * (PR #217 review): drift caches the code on disk for 15s, and a schedule firing that soon after
 * boot would compare this server against the commit it started on and call itself current.
 */
async function reportStaleServer(project: Project, logPath: string): Promise<void> {
  checkoutMoved(project.repoPath);
  const drift = serverBuildDrift();
  if (!drift) return;
  const detail = describeBuildDrift(drift);
  await appendSessionLog(logPath, `[stringer] WARNING: ${detail}\n`);
  console.warn(`[nightly-stringer] ${project.slug}: ${detail}`);
}

/**
 * Measure the tree that SHIPPED (anton-qor2). anton pulls the BOARD before it reads it but never
 * the checkout, so the scan ran against whatever the last human left: the 2026-08-06 nightly
 * measured a tree 6 commits behind origin/main and spent 87% of its signals — and its whole
 * `--delta` window — on code merged away hours earlier.
 *
 * A checkout anton cannot bring forward is NOT scanned. Standing down costs one night's pass;
 * scanning anyway costs the window (`--delta` consumes it) and re-files debt the repo no longer
 * carries. Nothing ran in that case, so the window is untouched and the next pass sees it.
 */
export async function scanShippedTree(opts: {
  project: Project;
  sessionId: string;
  logPath: string;
  signal: AbortSignal;
}): Promise<ScanPass> {
  const { project, logPath } = opts;
  const scannedSha = await bringCheckoutForward(project, logPath);

  const scanFile = scanFilePath(opts.sessionId);
  await appendSessionLog(logPath, `[stringer] scan --delta ${project.repoPath} @ ${scannedSha}\n`);
  await reportStaleServer(project, logPath);
  const result = await scan({ repoPath: project.repoPath, scanFile, signal: opts.signal });

  // Nothing that can throw may run between the scan and this return: the scan has already consumed
  // the --delta window, and only this handle can give it back.
  return {
    scanFile: result.scanFile,
    scannedSha,
    // Summarized from the signals the scan already parsed — the dispatch decision and this pass's
    // point on the trend must describe the same read, or the next delta is computed off a baseline
    // that never existed.
    counts: summarizeSignals(result.signals),
    collectorFailures: result.collectorFailures.length,
    deltaState: result.deltaState,
    restoreBaseline: result.restoreBaseline,
    reportDiagnostics: () => reportScanDiagnostics(result, project, logPath),
  };
}

/**
 * Give an untriaged `--delta` window back, and return the failure the runner should see.
 *
 * A delta scan CONSUMES its window: stringer advances the baseline on its way out, so signals this
 * pass saw are not in the next scan. That is only sound once triage has actually read them — a pass
 * that scanned and then died before triage (quota, abort, a crash between the two) would otherwise
 * leave the retry rescanning the window AFTER the findings, seeing nothing new, and closing green
 * over signals nobody ever triaged.
 *
 * When the window can't go back this returns poison, and the runner parks for a human rather than
 * retrying past lost findings — including past a quota backoff, whose retry would be the one
 * closing green over them.
 */
export async function restoreScanWindow(
  err: unknown,
  pass: ScanPass,
  logPath: string,
): Promise<unknown> {
  const failure = await rejectWithBaselineRestored(err, pass.restoreBaseline);
  await appendSessionLog(
    logPath,
    failure === err
      ? `[stringer] triage did not complete — --delta baseline restored; the retry rescans this window\n`
      : `[stringer] ERROR: ${failure instanceof Error ? failure.message : String(failure)}\n`,
  );
  return failure;
}
