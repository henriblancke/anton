/**
 * What each pass on the jobs page applied, shadowed and refused (anton-hzce) — read straight off the
 * session logs the passes already write.
 *
 * No new store and no new route: the board is the memory and the log is the record, so this is only
 * the seam that gets one to the other. What it adds over a bare read is the shape the page needs — an
 * entry for every pass that COMPLETED, including the ones that opened no session at all, because a
 * gardener patrol over a clean board deliberately leaves no session row behind (pass-preamble.ts
 * `deferPassSession`) and a missing entry would render as a broken row rather than as a quiet pass.
 */
import { isPassLogLine, readPassRecords, type PassRecordSummary } from "../gardener/record";
import { readSessionLogLines, type JobSessionLink } from "../sessions";
import type { JobStatus, JobType } from "./queue";

/** The job types that file proposals — the only ones with a record to show. */
const PASS_JOB_TYPES: ReadonlySet<JobType> = new Set<JobType>(["gardener", "product-master"]);

export function isPassJob(type: JobType): boolean {
  return PASS_JOB_TYPES.has(type);
}

/** The one job status whose silence is a RESULT: this pass ran to the end and wrote nothing. */
const COMPLETED: JobStatus = "done";

/** One pass job, as the page holds it — the status is what makes a missing log readable. */
export interface PassJob {
  id: string;
  type: JobType;
  status: JobStatus;
}

/**
 * The record for each pass job in `jobs`, keyed by job id. Logs are read concurrently — one page is
 * at most a page's worth of files, and reading them in series would put the jobs list behind every
 * one of them.
 *
 * A pass with no session gets an entry only when it COMPLETED. A queued pass has not started, a
 * running one has not finished, and a failed one may have died before its deferred session was ever
 * opened (mid-`applySafeVerbs`, mid-`collectFindings`) — calling any of those a clean pass would put
 * "nothing applied, shadowed or refused" under a job that never reached the point of deciding. They
 * get no entry at all, and the row renders without a record panel.
 */
export async function passRecordsByJob(
  jobs: readonly PassJob[],
  sessions: Record<string, JobSessionLink>,
): Promise<Record<string, PassRecordSummary>> {
  const passes = jobs.filter((job) => isPassJob(job.type));
  const summaries = await Promise.all(
    passes.map(async (job): Promise<[string, PassRecordSummary] | undefined> => {
      const logPath = sessions[job.id]?.logPath;
      if (!logPath) {
        return job.status === COMPLETED ? [job.id, { records: [], notes: [] }] : undefined;
      }
      return [job.id, await readLog(logPath)];
    }),
  );
  return Object.fromEntries(summaries.filter((entry) => entry !== undefined));
}

/**
 * One pass's record, scanned out of its whole log rather than its tail: the product-master pass
 * writes its revalidation tier's APPLY lines ahead of the claude transcript, so anything that read
 * only the end of the log would drop an unattended write and call the pass clean.
 */
async function readLog(logPath: string): Promise<PassRecordSummary> {
  const { lines, truncated } = await readSessionLogLines(logPath, isPassLogLine);
  const summary = readPassRecords(lines.join("\n"));
  if (truncated) {
    // Never a silent cap, for the same reason the write cap is not one: a record that shows some of
    // a pass's writes reads exactly like one that shows all of them.
    summary.notes.push(
      `this pass wrote more record lines than the jobs page reads — ${lines.length} shown; ` +
        `open the session log for the rest`,
    );
  }
  return summary;
}
