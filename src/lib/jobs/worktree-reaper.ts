/**
 * worktree-reaper job wiring (anton-hrun.1). The job runner needs only a handler factory; the actual
 * decision + support layer — reading the board, building candidates, judging them, accounting for a
 * stopped run's teardown — lives in `worktree-reaper-pass.ts` (anton-ikl3), re-exported below so
 * existing callers and tests keep importing from this path.
 */
import { runWorktreeReaperPass, type WorktreeReaperDeps } from "./worktree-reaper-pass";
import type { JobContext, JobHandler } from "./runner";

export {
  beadStateOf,
  makeRevalidator,
  readBoardOrFail,
  reapSummary,
  releaseRunResources,
} from "./worktree-reaper-pass";
export type { WorktreeReaperDeps, WorktreeReaperPayload } from "./worktree-reaper-pass";

export function makeWorktreeReaperHandler(deps: WorktreeReaperDeps): JobHandler {
  return (ctx: JobContext) => runWorktreeReaperPass(ctx, deps);
}
