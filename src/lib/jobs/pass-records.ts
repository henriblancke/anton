/**
 * What each pass on the jobs page applied, shadowed and refused (anton-hzce) — read straight off the
 * session logs the passes already write.
 *
 * No new store and no new route: the board is the memory and the log is the record, so this is only
 * the seam that gets one to the other. What it adds over a bare read is the shape the page needs — an
 * entry for EVERY pass job, including the ones that opened no session at all, because a gardener
 * patrol over a clean board deliberately leaves no session row behind (pass-preamble.ts
 * `deferPassSession`) and a missing entry would render as a broken row rather than as a quiet pass.
 */
import { readPassRecords, type PassRecordSummary } from "../gardener/record";
import { readSessionLogTail, type JobSessionLink } from "../sessions";
import type { JobType } from "./queue";

/** The job types that file proposals — the only ones with a record to show. */
const PASS_JOB_TYPES: ReadonlySet<JobType> = new Set<JobType>(["gardener", "product-master"]);

export function isPassJob(type: JobType): boolean {
  return PASS_JOB_TYPES.has(type);
}

/**
 * The record for each pass job in `jobs`, keyed by job id. Logs are read concurrently — one page is
 * at most a page's worth of small files, and reading them in series would put the jobs list behind
 * every one of them.
 */
export async function passRecordsByJob(
  jobs: readonly { id: string; type: JobType }[],
  sessions: Record<string, JobSessionLink>,
): Promise<Record<string, PassRecordSummary>> {
  const passes = jobs.filter((job) => isPassJob(job.type));
  const summaries = await Promise.all(
    passes.map(async (job): Promise<[string, PassRecordSummary]> => {
      const logPath = sessions[job.id]?.logPath;
      // No session is the ordinary shape of a patrol with nothing to say, not a failure — an empty
      // record is the honest answer, and the page reads it as the clean pass it was.
      if (!logPath) return [job.id, { records: [], notes: [] }];
      return [job.id, readPassRecords(await readSessionLogTail(logPath))];
    }),
  );
  return Object.fromEntries(summaries);
}
