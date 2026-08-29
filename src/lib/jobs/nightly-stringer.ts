/**
 * nightly-stringer job (anton-3t2.3). On its cron: run `stringer scan --delta` on the project repo,
 * then — if there are new signals — dispatch claude with the /scan-triage prompt to convert the few
 * worth doing into contract-shaped beads (claude writes them via `bd`). One scan → a handful of
 * beads per project, deduped and clustered by the prompt. See DESIGN §4/§6 and skills/scan-triage/SKILL.md.
 *
 * The handler composes the pass; each phase owns its own module (anton-xdgw): open the pass
 * (`-pass`), measure the tree that shipped (`-scan`), read the board and dispatch triage
 * (`-triage` / `-board`), land the health point (`-health`).
 *
 * Idempotent: `--delta` means a re-run (crash / quota backoff) doesn't re-triage signals a pass
 * already triaged; a pass that died BEFORE triage puts its baseline back, so the retry rescans that
 * window rather than skipping it. The worst case either way is claude re-reading a scan and deduping
 * against the board it already wrote.
 */
import { syncBoard } from "./nightly-stringer-board";
import { openPass, type NightlyPass } from "./nightly-stringer-pass";
import { restoreScanWindow, scanShippedTree, type ScanPass } from "./nightly-stringer-scan";
import { runTriage } from "./nightly-stringer-triage";
import { systemClock, type AntonDb, type Clock } from "./queue";
import type { JobContext, JobHandler } from "./runner";

export interface NightlyStringerPayload {
  projectId: string;
  scheduleId?: string;
}

export interface NightlyStringerDeps {
  db: AntonDb;
  clock?: Clock;
}

/**
 * Turn the scan's signals into beads, and record what this pass saw and did.
 *
 * No new signals is a success, not an error — and a real data point: a clean pass is what a falling
 * trend is made of, so it is recorded like any other, and nothing is dispatched over it.
 */
async function triageScan(pass: NightlyPass, scanned: ScanPass, ctx: JobContext): Promise<void> {
  if (scanned.counts.total === 0) {
    await pass.log(`[stringer] no new signals — nothing to triage\n`);
    await pass.recordHealth(scanned);
    return;
  }
  await pass.log(`[stringer] ${scanned.counts.total} signal(s) → /scan-triage\n`);

  const triage = await runTriage({
    project: pass.project,
    settings: pass.settings,
    scanFile: scanned.scanFile,
    logPath: pass.logPath,
    signal: ctx.signal,
    onEvent: pass.onEvent,
  });
  // Triage read the signals; from here the consumed --delta window is legitimately spent.
  pass.triaged = true;

  await pass.recordHealth(scanned, triage);
  // The triage session wrote its beads via `bd`; push them to the Dolt remote.
  await syncBoard(pass.project.repoPath);
}

/** One nightly pass, start to settled session — the sequence the job exists to run. */
async function runNightlyPass(db: AntonDb, clock: Clock, ctx: JobContext): Promise<void> {
  const { projectId } = ctx.payload as NightlyStringerPayload;
  const pass = await openPass(db, clock, ctx, projectId);

  // Held outside the try so the failure path can still record what this pass SAW: triage dying is
  // not the scan being wrong, and dropping the point would put a gap in the trend exactly where
  // something went wrong.
  let scanned: ScanPass | undefined;
  try {
    scanned = await scanShippedTree({
      project: pass.project,
      sessionId: pass.sessionId,
      logPath: pass.logPath,
      signal: ctx.signal,
    });
    await ctx.heartbeat();
    await triageScan(pass, scanned, ctx);
    await pass.end("done");
  } catch (e) {
    // A pass that scanned and then died still saw the repo. Record what it saw before the failure
    // propagates, so the trend keeps its point and the next scan's delta compares to reality.
    if (scanned) await pass.recordHealth(scanned);
    // Give the untriaged window back (see `restoreScanWindow`). A triage that ran and then errored
    // keeps its window spent: its beads are on the board, and §2 dedupes the rescan against the
    // fingerprints it wrote, whereas a silently dropped finding is not recoverable.
    const failure =
      scanned && !pass.triaged ? await restoreScanWindow(e, scanned, pass.logPath) : e;
    await pass.end("failed");
    throw failure; // let the runner apply job-level durability (quota backoff / retry / park)
  }
}

/** Build the runner handler bound to a db/clock. Register it as the "nightly-stringer" handler. */
export function makeNightlyStringerHandler(deps: NightlyStringerDeps): JobHandler {
  const db = deps.db;
  const clock = deps.clock ?? systemClock;
  return (ctx) => runNightlyPass(db, clock, ctx);
}
