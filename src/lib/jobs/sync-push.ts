/**
 * sync-push job (anton-nowq). The durable half of beads push sync: a local write enqueues a deduped
 * sync-push job (queue.ts), and this handler drives the repo's unpushed commits to the Dolt remote,
 * retrying with backoff and parking for a human once the runner's retry budget is exhausted — a
 * stuck remote becomes a visible, resumable parked job rather than work silently stranded locally.
 *
 * A STRONGER ALTERNATIVE to the E1 heartbeat backstop (anton-sr8f): it pushes through the SAME
 * per-repo coalescer (`beads.backstop` → doltSync), so a job push, a write-nudged full pass, and the
 * heartbeat backstop can never overlap — no concurrent-push Dolt manifest corruption (beads GH#2466)
 * and no double-push. When a prior inline push already landed the work, `backstop` resolves to a
 * pull-only no-op and the job completes cleanly (idempotent belt-and-suspenders).
 */
import { beads } from "../beads/bd";
import { getProjectById } from "../projects";
import { PoisonError } from "./errors";
import type { AntonDb } from "./queue";
import type { JobContext, JobHandler } from "./runner";

export interface SyncPushPayload {
  projectId: string;
}

export interface SyncPushDeps {
  db: AntonDb;
  /** The push pass, injectable for tests. Defaults to the shared coalescer via beads.backstop. */
  push?: (repoPath: string) => Promise<void>;
}

/** Build the runner handler bound to a db/clock. Register it as the "sync-push" handler. */
export function makeSyncPushHandler(deps: SyncPushDeps): JobHandler {
  const db = deps.db;
  const push = deps.push ?? ((repoPath: string) => beads.backstop(repoPath));

  return async function syncPush(ctx: JobContext): Promise<void> {
    const { projectId } = ctx.payload as SyncPushPayload;
    // A vanished project can never sync — poison so it parks at once rather than burning retries.
    const project = await getProjectById(db, projectId);
    if (!project) throw new PoisonError(`project ${projectId} not found`);

    // Route through the coalescer. A real push failure REJECTS with bd's output, so the runner
    // applies its retry/backoff/park policy; a caught-up repo resolves pull-only and completes.
    await push(project.repoPath);
  };
}
