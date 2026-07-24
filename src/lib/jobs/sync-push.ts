/**
 * sync-push job (anton-nowq). The durable half of beads push sync: a local write enqueues a deduped
 * sync-push job (queue.ts), and this handler drives the repo's unpushed commits to the Dolt remote,
 * retrying with backoff and parking for a human once the runner's retry budget is exhausted — a
 * stuck remote becomes a visible, resumable parked job rather than work silently stranded locally.
 *
 * A STRONGER ALTERNATIVE to the E1 heartbeat backstop (anton-sr8f): it pushes through the SAME
 * per-repo coalescer (`beads.push` → doltSync), so a job push, a write-nudged full pass, and the
 * heartbeat backstop can never overlap — no concurrent-push Dolt manifest corruption (beads GH#2466)
 * and no double-push. Unlike `backstop`, the job forces a full push unconditionally: a backstop
 * snapshots the unpushed count at call time, so a job that coalesces behind a still-in-flight write
 * push reads 0 and drops to pull-only, letting a push that then fails go unretried by the very job
 * meant to retry/park it. `beads.push` always retries the push without inflating the backlog count;
 * when the work already landed it's a no-op push and the job completes cleanly (idempotent).
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
  /** The push pass, injectable for tests. Defaults to the shared coalescer via beads.push. */
  push?: (repoPath: string) => Promise<void>;
}

/** Build the runner handler bound to a db/clock. Register it as the "sync-push" handler. */
export function makeSyncPushHandler(deps: SyncPushDeps): JobHandler {
  const db = deps.db;
  const push = deps.push ?? ((repoPath: string) => beads.push(repoPath));

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
