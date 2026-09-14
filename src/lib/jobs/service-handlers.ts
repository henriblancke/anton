/**
 * The job-type → handler table (anton-6fo2). One import per job type is this module's entire
 * reason to exist and its only reason to change, so a new job type widens the fan-out HERE rather
 * than in service.ts or in the runner's lifecycle wiring.
 *
 * That makes this module's fan-out intrinsic, and stringer reports it as high coupling — recorded
 * so it is not re-litigated. Grouping the twelve factories behind barrel modules would buy the
 * threshold back and nothing else: the table would still name every job type, one indirection
 * further from the runner it registers on. The coupling that mattered was service.ts's, where the
 * table sat NEXT TO the public job API and the boot lifecycle; that is what moved.
 */
import { makeExecuteEpicHandler } from "./execute-epic";
import { makeReviewFixHandler, makeReviewFixPrHandler } from "./review-fix";
import { makeNightlyStringerHandler } from "./nightly-stringer";
import { makeOrphanGroomingHandler } from "./orphan-grooming";
import { makeSyncPushHandler } from "./sync-push";
import { makeRunHealthHandler } from "./run-health";
import { makeUnstickHandler } from "./unstick";
import { makeGateCheckHandler } from "./gate-check";
import { makeBoardPickerHandler } from "./board-picker";
import { makeWorktreeReaperHandler } from "./worktree-reaper";
import { makeGardenerHandler } from "./gardener";
import { makeProductMasterHandler } from "./product-master";
import type { AntonDb } from "./queue";
import type { JobRunner } from "./runner";

/** Register every built-in job handler on a freshly constructed runner. */
export function registerJobHandlers(runner: JobRunner, db: AntonDb): void {
  runner.registerHandler("execute-epic", makeExecuteEpicHandler({ db }));
  runner.registerHandler("review-fix", makeReviewFixHandler({ db }));
  runner.registerHandler("review-fix-pr", makeReviewFixPrHandler({ db }));
  runner.registerHandler("nightly-stringer", makeNightlyStringerHandler({ db }));
  runner.registerHandler("orphan-grooming", makeOrphanGroomingHandler({ db }));
  runner.registerHandler("sync-push", makeSyncPushHandler({ db }));
  runner.registerHandler("run-health", makeRunHealthHandler({ db }));
  runner.registerHandler("unstick", makeUnstickHandler({ db }));
  runner.registerHandler("gate-check", makeGateCheckHandler({ db }));
  runner.registerHandler("gardener", makeGardenerHandler({ db }));
  runner.registerHandler("product-master", makeProductMasterHandler({ db }));
  // The picker's start is the one scheduled path that inserts an execute-epic row, so its queue
  // verbs go through the runner: the quiesce barrier a project deletion raises is checked in the
  // same synchronous step as the insert, which db-direct verbs cannot do.
  runner.registerHandler(
    "board-picker",
    makeBoardPickerHandler({
      db,
      run: {
        enqueueIfAbsent: (projectId, epicBeadId) =>
          runner.enqueueExecuteEpicIfAbsent(projectId, epicBeadId),
        // A policy resume, so the operator's "run now" flag comes off inside the resume's own CAS
        // rather than beside it (PR #218 review).
        resume: (jobId) => runner.resume(jobId, { stripBypassBudget: true }),
      },
    }),
  );
  runner.registerHandler("worktree-reaper", makeWorktreeReaperHandler({ db }));
}
