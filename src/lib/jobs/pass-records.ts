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
      const logPaths = sessions[job.id]?.logPaths ?? [];
      if (logPaths.length === 0) {
        return job.status === COMPLETED ? [job.id, { records: [], notes: [] }] : undefined;
      }
      return [job.id, await readAttempts(logPaths)];
    }),
  );
  return Object.fromEntries(summaries.filter((entry) => entry !== undefined));
}

/**
 * A job's whole record — EVERY attempt's log, oldest first, read as one account.
 *
 * A retry opens a new session, so the newest log holds only what the last attempt did. An attempt
 * that applied proposals unattended and then failed would otherwise vanish behind a clean retry,
 * which is the one thing this record exists to prevent: the writes are on the board either way.
 */
async function readAttempts(logPaths: string[]): Promise<PassRecordSummary> {
  const attempts = await Promise.all(logPaths.map((path, i) => readLog(path, i, logPaths.length)));
  return {
    records: attempts.flatMap((attempt) => attempt.records),
    notes: attempts.flatMap((attempt) => attempt.notes),
  };
}

/**
 * One attempt's record, scanned out of its whole log rather than its tail: the product-master pass
 * writes its revalidation tier's APPLY lines ahead of the claude transcript, so anything that read
 * only the end of the log would drop an unattended write and call the pass clean.
 *
 * Notes name their attempt once a job has more than one, because "the log could not be read" means
 * something different when the other three attempts read fine.
 */
async function readLog(logPath: string, index: number, of: number): Promise<PassRecordSummary> {
  const { lines, truncated, unreadable } = await readSessionLogLines(logPath, isPassLogLine);
  const summary = readPassRecords(lines.join("\n"));
  const attempt = of > 1 ? `attempt ${index + 1} of ${of}: ` : "";
  if (unreadable) {
    // The one silence that is NOT a result: the session row stands but its disposable log is gone
    // or would not read, so an empty summary here would render as "Clean pass" over a pass that may
    // have written to the board unattended — the only UI record of which is the file we just failed
    // to read.
    summary.notes.push(
      `${attempt}this pass's session log could not be read${lines.length > 0 ? " to the end" : ""} — ` +
        `whatever it applied, shadowed or refused is not recorded here`,
    );
  }
  if (truncated) {
    // Never a silent cap, for the same reason the write cap is not one: a record that shows some of
    // a pass's writes reads exactly like one that shows all of them.
    summary.notes.push(
      `${attempt}this pass wrote more record lines than the jobs page reads — ${lines.length} ` +
        `shown; open the session log for the rest`,
    );
  }
  return summary;
}
