/**
 * nightly-stringer job (anton-3t2.3). On its cron: run `stringer scan --delta` on the project repo,
 * then — if there are new signals — dispatch claude with the /scan-triage prompt to convert the few
 * worth doing into contract-shaped beads (claude writes them via `bd`). One scan → a handful of
 * beads per project, deduped and clustered by the prompt. See DESIGN §4/§6 and skills/scan-triage/SKILL.md.
 *
 * Idempotent: `--delta` means a re-run (crash / quota backoff) doesn't re-triage signals already
 * seen; the worst case is claude re-reading a scan and deduping against the board it already wrote.
 */
import { join } from "node:path";
import { beads } from "../beads/bd";
import { getProjectById, getProjectSettings, resolveScanSeverity } from "../projects";
import { loadSkill } from "../claude/prompt";
import { runClaude } from "../claude/driver";
import { describeCollectorFailure, scan } from "../stringer";
import { formatScanSeverityPolicy } from "../scan-severity";
import {
  buildBoardContext,
  formatBoardContext,
  formatBoardContextUnavailable,
} from "../board-context";
import {
  parseTriageOutcome,
  saveScanSummary,
  summarizeScanLine,
  summarizeSignals,
  type ScanCounts,
  type TriageOutcome,
} from "../scan-health";
import { appendSessionLog, endSession, startJobSession } from "../sessions";
import { PoisonError } from "./errors";
import type { AntonDb, Clock } from "./queue";
import { systemClock } from "./queue";
import type { JobContext, JobHandler } from "./runner";

export interface NightlyStringerPayload {
  projectId: string;
  scheduleId?: string;
}

export interface NightlyStringerDeps {
  db: AntonDb;
  clock?: Clock;
}

/** Where a scan file lands — under anton's own dir, disposable with anton.db. */
function scanFilePath(id: string): string {
  const root = process.env.ANTON_SCANS_ROOT ?? join(process.cwd(), ".anton", "scans");
  return join(root, `${id}.json`);
}

/**
 * The board section of the triage prompt (anton-ol1l). Read from the whole board — `--status all`,
 * because a feature's children and an epic's tier are only legible with closed beads in the read,
 * and buildBoardContext offers only the open ones as routing targets.
 *
 * A failed read degrades to an explicit UNAVAILABLE notice rather than an omitted section: triage
 * still has `bd` and can read the board itself, whereas silence would read as an empty board and
 * every signal would mint a fresh orphan cluster.
 *
 * Pulled first, as the gardener does before any board-derived write: this checkout's local Dolt
 * state can be a sync heartbeat behind another machine's push, and a bead invisible here is a
 * fingerprint and a touch surface triage will not dedupe against. Best-effort — an unreachable
 * remote costs freshness, not the section, and every verdict below is still correct against the
 * local board.
 */
async function readBoardContext(repoPath: string, logPath: string, slug: string): Promise<string> {
  try {
    await appendSessionLog(logPath, `[stringer] board pull before read\n`);
    await beads.pull(repoPath).catch(async (e) => {
      const reason = e instanceof Error ? e.message : String(e);
      await appendSessionLog(logPath, `[stringer] WARNING: board pull failed — ${reason}\n`);
      console.warn(`[nightly-stringer] ${slug}: board pull failed — ${reason}`);
    });
    const board = await beads.list(repoPath, ["--status", "all"]);
    const ctx = buildBoardContext(board);
    await appendSessionLog(
      logPath,
      `[stringer] board context: ${ctx.features.length} open feature(s), ${ctx.epics.length} open epic(s), ` +
        `${ctx.producers.length} producer-filed bead(s)\n`,
    );
    return formatBoardContext(ctx);
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    await appendSessionLog(logPath, `[stringer] WARNING: board context unavailable — ${reason}\n`);
    console.warn(`[nightly-stringer] ${slug}: board context unavailable — ${reason}`);
    return formatBoardContextUnavailable(reason);
  }
}

/** Build the runner handler bound to a db/clock. Register it as the "nightly-stringer" handler. */
export function makeNightlyStringerHandler(deps: NightlyStringerDeps): JobHandler {
  const db = deps.db;
  const clock = deps.clock ?? systemClock;

  return async function nightlyStringer(ctx: JobContext): Promise<void> {
    const { projectId } = ctx.payload as NightlyStringerPayload;
    const project = await getProjectById(db, projectId);
    if (!project) throw new PoisonError(`project ${projectId} not found`);
    const settings = await getProjectSettings(db, projectId);

    const { sessionId, logPath, onEvent } = await startJobSession(db, clock, {
      projectId,
      kind: "nightly-stringer",
    });
    // Live handle (anton-susu): nightly-stringer writes no run row, so this is how observe finds
    // the in-flight session. It runs claude directly in the project repo — no worktree.
    ctx.report({ sessionId, cwd: project.repoPath });

    /**
     * Land this pass's health record (anton-bz1w) — at most once, and never fatally. Best-effort
     * because the record is a monitor, not the work: an anton.db hiccup must not fail (or retry) a
     * scan whose beads already landed.
     *
     * The flag guards the two call sites in THIS attempt; a retry runs a fresh handler with the flag
     * back to false, so the durable half of the guarantee is `saveScanSummary` keying on the job id
     * (a retried scan finds a baseline the first attempt already consumed, and would otherwise chart
     * a phantom zero-signal point). A pass is ONE point on the trend however many attempts it took.
     */
    let recorded = false;
    const recordHealth = async (counts: ScanCounts, opts: {
      failures: number;
      triage?: TriageOutcome;
    }): Promise<void> => {
      if (recorded) return;
      recorded = true;
      try {
        const summary = await saveScanSummary(db, clock, {
          projectId,
          jobId: ctx.jobId,
          sessionId,
          counts,
          collectorFailures: opts.failures,
          ...(opts.triage ? { triage: opts.triage } : {}),
        });
        await appendSessionLog(logPath, `[stringer] health: ${summarizeScanLine(summary)}\n`);
      } catch (e) {
        console.error(`[nightly-stringer] ${project.slug}: recording scan health failed`, e);
      }
    };

    // Held outside the try so the failure path can still record what this pass SAW: triage dying is
    // not the scan being wrong, and dropping the point would put a gap in the trend exactly where
    // something went wrong.
    let counts: ScanCounts | undefined;
    let collectorFailures = 0;

    try {
      // 1. Scan the repo for new signals.
      const scanFile = scanFilePath(sessionId);
      await appendSessionLog(logPath, `[stringer] scan --delta ${project.repoPath}\n`);
      const result = await scan({ repoPath: project.repoPath, scanFile, signal: ctx.signal });
      // Summarized from the signals the scan already parsed — the dispatch decision below and this
      // point on the trend must describe the same read, or the next delta is computed off a baseline
      // that never existed.
      counts = summarizeSignals(result.signals);
      collectorFailures = result.collectorFailures.length;
      await ctx.heartbeat();

      // 1b. A dead collector still exits 0 (anton-uspu) — say so on the session, before the
      // no-signals early return, so a scan that lost gitlog doesn't read as a clean nothing-to-do.
      for (const failure of result.collectorFailures) {
        const detail = describeCollectorFailure(failure);
        await appendSessionLog(logPath, `[stringer] WARNING: ${detail}\n`);
        console.warn(`[nightly-stringer] ${project.slug}: ${detail}`);
      }

      // 2. No new signals → nothing to triage. That's a success, not an error — and a real data
      // point: a clean pass is what a falling trend is made of, so it is recorded like any other.
      if (counts.total === 0) {
        await appendSessionLog(logPath, `[stringer] no new signals — nothing to triage\n`);
        await recordHealth(counts, { failures: collectorFailures });
        await endSession(db, clock, sessionId, "done");
        return;
      }
      await appendSessionLog(logPath, `[stringer] ${counts.total} signal(s) → /scan-triage\n`);

      // 3. Dispatch claude with the scan-triage prompt to turn signals into beads (via bd). Two
      // things ride along resolved rather than left to the agent: the project's severity mapping
      // (anton-bz1w — the skill documents the default, only the project says how to label), and the
      // board itself (anton-ol1l — the structure a signal routes into and the fingerprints every
      // producer already filed, so an unattended scan can't miss a read and duplicate work).
      const triagePrompt = await loadSkill("scan-triage");
      const boardSection = await readBoardContext(project.repoPath, logPath, project.slug);
      const prompt = [
        triagePrompt,
        ``,
        `---`,
        ``,
        `The stringer scan file to triage is: ${scanFile}`,
        `Create the beads in this repository's beads tracker using \`bd\`. Report your summary line at the end.`,
        ``,
        `This project's severity mapping — label and prioritize every bead you file by it:`,
        ``,
        formatScanSeverityPolicy(resolveScanSeverity(settings)),
        ``,
        boardSection,
      ].join("\n");

      const claudeResult = await runClaude({
        cwd: project.repoPath,
        prompt,
        model: settings.model,
        permissionMode: settings.permissionMode ?? "bypassPermissions",
        signal: ctx.signal,
        onEvent,
      });
      if (!claudeResult.ok) {
        throw new Error(`scan-triage reported an error: ${claudeResult.text ?? "unknown"}`);
      }

      // 4. What triage did with the signals, out of its own closing report (skills/scan-triage §6).
      // A session that skipped the line records no counts rather than a fabricated zero.
      const triage = parseTriageOutcome(claudeResult.text);
      await recordHealth(counts, { failures: collectorFailures, ...(triage ? { triage } : {}) });

      // The triage session wrote its beads via `bd`; push them to the Dolt remote.
      await beads
        .sync(project.repoPath)
        .catch((e) => console.error("[nightly-stringer] beads dolt sync failed", e));

      await endSession(db, clock, sessionId, "done");
    } catch (e) {
      // A pass that scanned and then died still saw the repo. Record what it saw before the failure
      // propagates, so the trend keeps its point and the next scan's delta compares to reality.
      if (counts) await recordHealth(counts, { failures: collectorFailures });
      await endSession(db, clock, sessionId, "failed");
      throw e; // let the runner apply job-level durability (quota backoff / retry / park)
    }
  };
}
