/**
 * This pass's point on the scan-health trend (anton-bz1w) — landed at most once, and never fatally.
 * Best-effort because the record is a monitor, not the work: an anton.db hiccup must not fail (or
 * retry) a scan whose beads already landed.
 *
 * The once-per-pass flag guards the call sites in ONE attempt; a retry runs a fresh recorder with
 * the flag back to false, so the durable half of the guarantee is `saveScanSummary` keying on the
 * job id — a retry rescans the window the failed attempt unwound and would otherwise chart a second
 * point for it. A pass is ONE point on the trend however many attempts it took: the retry's scan
 * REPLAYS the restored window, so its counts and its triage report replace the ones recorded here
 * rather than adding to them (`reconcileAttempt`), which is why the delta state travels with them —
 * it is what proves the retry started where the previous attempt did.
 */
import { saveScanSummary, summarizeScanLine, type TriageOutcome } from "../scan-health";
import { appendSessionLog } from "../sessions";
import type { ScanPass } from "./nightly-stringer-scan";
import type { AntonDb, Clock } from "./queue";

/** Record what this pass saw, and (when triage got that far) what it did about it. */
export type HealthRecorder = (pass: ScanPass, triage?: TriageOutcome) => Promise<void>;

export function makeHealthRecorder(opts: {
  db: AntonDb;
  clock: Clock;
  projectId: string;
  jobId: string;
  sessionId: string;
  logPath: string;
  slug: string;
}): HealthRecorder {
  let recorded = false;
  return async (pass, triage) => {
    if (recorded) return;
    recorded = true;
    try {
      const summary = await saveScanSummary(opts.db, opts.clock, {
        projectId: opts.projectId,
        jobId: opts.jobId,
        sessionId: opts.sessionId,
        counts: pass.counts,
        collectorFailures: pass.collectorFailures,
        scannedSha: pass.scannedSha,
        deltaState: pass.deltaState,
        ...(triage ? { triage } : {}),
      });
      await appendSessionLog(opts.logPath, `[stringer] health: ${summarizeScanLine(summary)}\n`);
    } catch (e) {
      console.error(`[nightly-stringer] ${opts.slug}: recording scan health failed`, e);
    }
  };
}
