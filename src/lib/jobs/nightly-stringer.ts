/**
 * nightly-stringer job (anton-3t2.3). On its cron: run `stringer scan --delta` on the project repo,
 * then — if there are new signals — dispatch claude with the /scan-triage prompt to convert the few
 * worth doing into contract-shaped beads (claude writes them via `bd`). One scan → a handful of
 * beads per project, deduped and clustered by the prompt. See DESIGN §4/§6 and skills/scan-triage/SKILL.md.
 *
 * Idempotent: `--delta` means a re-run (crash / quota backoff) doesn't re-triage signals a pass
 * already triaged; a pass that died BEFORE triage puts its baseline back, so the retry rescans that
 * window rather than skipping it. The worst case either way is claude re-reading a scan and deduping
 * against the board it already wrote.
 */
import { join } from "node:path";
import { beads } from "../beads/bd";
import { getProjectById, getProjectSettings, resolveScanSeverity } from "../projects";
import { loadSkill } from "../claude/prompt";
import { runClaude } from "../claude/driver";
import {
  describeCollectorFailure,
  rejectWithBaselineRestored,
  scan,
  type DeltaState,
} from "../stringer";
import {
  ANTON_CLASS_KEY,
  ANTON_SEVERITY_KEY,
  formatScanSeverityPolicy,
} from "../scan-severity";
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
import { refreshCheckout } from "../git/refresh";
import type { Project } from "../types";
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
 * and a closed EPIC is itself a placement candidate (§4.1 reopens one rather than duplicating it).
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
      `[stringer] board context: ${ctx.features.length} open feature(s), ${ctx.epics.length} epic(s), ` +
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
async function bringCheckoutForward(project: Project, logPath: string): Promise<string> {
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
     * back to false, so the durable half of the guarantee is `saveScanSummary` keying on the job id —
     * a retry rescans the window this attempt unwound (see below) and would otherwise chart a second
     * point for it. A pass is ONE point on the trend however many attempts it took: the retry's scan
     * REPLAYS the restored window, so its counts and its triage report replace the ones recorded
     * here rather than adding to them (`reconcileAttempt`), which is why the delta state travels
     * with them — it is what proves the retry started where this attempt did.
     */
    let recorded = false;
    const recordHealth = async (counts: ScanCounts, opts: {
      failures: number;
      triage?: TriageOutcome;
      deltaState?: DeltaState;
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
          ...(scannedSha ? { scannedSha } : {}),
          ...(opts.deltaState ? { deltaState: opts.deltaState } : {}),
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
    let deltaState: DeltaState | undefined;
    /** The commit the scan measured, once the checkout is known to be the tree that shipped. */
    let scannedSha: string | undefined;

    /**
     * The scan's `--delta` unwind, and whether the pass got far enough to owe nothing to it.
     *
     * A delta scan CONSUMES its window: stringer advances the baseline on its way out, so signals
     * this pass saw are not in the next scan. That is only sound once triage has actually read them —
     * a pass that scanned and then died before triage (quota, abort, a crash between the two) would
     * otherwise leave the retry rescanning the window AFTER the findings, seeing nothing new, and
     * closing green over signals nobody ever triaged. So the failure path puts the baseline back.
     *
     * `triaged` flips only once triage returned ok. A triage that ran and then errored still replays:
     * its beads are on the board, and §2 dedupes the rescan against the fingerprints it wrote — a
     * duplicate bead is recoverable, a silently dropped finding is not.
     */
    let restoreScanBaseline: (() => Promise<string | undefined>) | undefined;
    let triaged = false;

    try {
      // 0. Measure the tree that SHIPPED (anton-qor2). anton pulls the BOARD before it reads it but
      //    never the checkout, so the scan ran against whatever the last human left: the 2026-08-06
      //    nightly measured a tree 6 commits behind origin/main and spent 87% of its signals — and
      //    its whole --delta window — on code merged away hours earlier.
      //
      //    A checkout anton cannot bring forward is NOT scanned. Standing down costs one night's
      //    pass; scanning anyway costs the window (`--delta` consumes it) and re-files debt the repo
      //    no longer carries. Nothing ran here, so the window is untouched and the next pass sees it.
      scannedSha = await bringCheckoutForward(project, logPath);

      // 1. Scan the repo for new signals.
      const scanFile = scanFilePath(sessionId);
      await appendSessionLog(logPath, `[stringer] scan --delta ${project.repoPath} @ ${scannedSha}\n`);
      const result = await scan({ repoPath: project.repoPath, scanFile, signal: ctx.signal });
      // Summarized from the signals the scan already parsed — the dispatch decision below and this
      // point on the trend must describe the same read, or the next delta is computed off a baseline
      // that never existed.
      counts = summarizeSignals(result.signals);
      collectorFailures = result.collectorFailures.length;
      deltaState = result.deltaState;
      restoreScanBaseline = result.restoreBaseline;
      await ctx.heartbeat();

      // The trend can only subtract two scans that measured against the same stringer baseline, and
      // that proof is the baseline anton read off the repo. If it isn't where anton looks, every
      // point stays uncomparable — say so, rather than letting the trend quietly lose its deltas.
      if (!deltaState.after) {
        const detail =
          `stringer's --delta baseline was not found under ${project.repoPath} — this scan's point ` +
          `carries no comparison, and none will until anton can identify it`;
        await appendSessionLog(logPath, `[stringer] WARNING: ${detail}\n`);
        console.warn(`[nightly-stringer] ${project.slug}: ${detail}`);
      }

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
        await recordHealth(counts, {
          failures: collectorFailures,
          ...(deltaState ? { deltaState } : {}),
        });
        await endSession(db, clock, sessionId, "done");
        return;
      }
      await appendSessionLog(logPath, `[stringer] ${counts.total} signal(s) → /scan-triage\n`);

      // 3. Dispatch claude with the scan-triage prompt to turn signals into beads (via bd). Three
      // things ride along resolved rather than left to the agent: each signal's severity (stamped
      // onto the scan file itself by lib/stringer, so the bead's label and this pass's health point
      // read the same signal the same way), the project's severity mapping (anton-bz1w — the skill
      // documents the default, only the project says how to label), and the board itself
      // (anton-ol1l — the structure a signal routes into and the fingerprints every producer
      // already filed, so an unattended scan can't miss a read and duplicate work).
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
        `Every signal in that file carries \`${ANTON_SEVERITY_KEY}\` and \`${ANTON_CLASS_KEY}\` — anton's own derivation,`,
        `the same one this pass's health record counts by. Take a signal's severity from`,
        `\`${ANTON_SEVERITY_KEY}\`; do NOT re-derive one from its \`Priority\`/\`Kind\`/\`Source\`, or a bead's label`,
        `will contradict the trend the board charts for the same signal.`,
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
      // Triage read the signals; from here the consumed --delta window is legitimately spent.
      triaged = true;

      // 4. What triage did with the signals, out of its own closing report (skills/scan-triage §6).
      // A session that skipped the line records no counts rather than a fabricated zero.
      const triage = parseTriageOutcome(claudeResult.text);
      await recordHealth(counts, {
        failures: collectorFailures,
        ...(deltaState ? { deltaState } : {}),
        ...(triage ? { triage } : {}),
      });

      // The triage session wrote its beads via `bd`; push them to the Dolt remote.
      await beads
        .sync(project.repoPath)
        .catch((e) => console.error("[nightly-stringer] beads dolt sync failed", e));

      await endSession(db, clock, sessionId, "done");
    } catch (e) {
      // A pass that scanned and then died still saw the repo. Record what it saw before the failure
      // propagates, so the trend keeps its point and the next scan's delta compares to reality.
      if (counts) {
        await recordHealth(counts, {
          failures: collectorFailures,
          ...(deltaState ? { deltaState } : {}),
        });
      }
      // Give the untriaged window back (see `restoreScanBaseline`). When it can't go back, this
      // returns poison and the runner parks for a human rather than retrying past lost findings —
      // including past a quota backoff, whose retry would be the one closing green over them.
      let failure = e;
      if (!triaged && restoreScanBaseline) {
        failure = await rejectWithBaselineRestored(e, restoreScanBaseline);
        await appendSessionLog(
          logPath,
          failure === e
            ? `[stringer] triage did not complete — --delta baseline restored; the retry rescans this window\n`
            : `[stringer] ERROR: ${failure instanceof Error ? failure.message : String(failure)}\n`,
        );
      }
      await endSession(db, clock, sessionId, "failed");
      throw failure; // let the runner apply job-level durability (quota backoff / retry / park)
    }
  };
}
