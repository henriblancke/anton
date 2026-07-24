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
import { getProjectById, getProjectSettings } from "../projects";
import { loadSkill } from "../claude/prompt";
import { runClaude } from "../claude/driver";
import { scan } from "../stringer";
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

    try {
      // 1. Scan the repo for new signals.
      const scanFile = scanFilePath(sessionId);
      await appendSessionLog(logPath, `[stringer] scan --delta ${project.repoPath}\n`);
      const result = await scan({ repoPath: project.repoPath, scanFile, signal: ctx.signal });
      await ctx.heartbeat();

      // 2. No new signals → nothing to triage. That's a success, not an error.
      if (result.signalCount === 0) {
        await appendSessionLog(logPath, `[stringer] no new signals — nothing to triage\n`);
        await endSession(db, clock, sessionId, "done");
        return;
      }
      await appendSessionLog(logPath, `[stringer] ${result.signalCount} signal(s) → /scan-triage\n`);

      // 3. Dispatch claude with the scan-triage prompt to turn signals into beads (via bd).
      const triagePrompt = await loadSkill("scan-triage");
      const prompt = [
        triagePrompt,
        ``,
        `---`,
        ``,
        `The stringer scan file to triage is: ${scanFile}`,
        `Create the beads in this repository's beads tracker using \`bd\`. Report your summary line at the end.`,
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

      // The triage session wrote its beads via `bd`; push them to the Dolt remote.
      await beads
        .sync(project.repoPath)
        .catch((e) => console.error("[nightly-stringer] beads dolt sync failed", e));

      await endSession(db, clock, sessionId, "done");
    } catch (e) {
      await endSession(db, clock, sessionId, "failed");
      throw e; // let the runner apply job-level durability (quota backoff / retry / park)
    }
  };
}
