/**
 * The write-sync nudge (anton-nowq). Every operator board write funnels through here so a change
 * reaches teammates two ways at once:
 *
 *   1. An immediate fire-and-forget `beads.sync` — the low-latency path (A2), so the change usually
 *      ships within the request without blocking the response on a slow/unreachable remote.
 *   2. A durable, deduped sync-push job (E2) — the safety net: if the inline push fails, the job
 *      retries with backoff and PARKS for a human on exhaustion, so a local write is never silently
 *      stranded. When the inline push already landed the work, the job resolves to a pull-only no-op.
 *
 * Both pushes route through the SAME per-repo coalescer, so they can never overlap or double-push
 * (beads GH#2466). Neither is awaited — the caller's write already landed locally; this only
 * schedules propagation. Enqueue failures are swallowed (logged), never surfaced into the request.
 */
import { beads } from "./bd";
import { getDb } from "../db";
import { enqueueSyncPushDeduped, systemClock } from "../jobs/queue";

export interface NudgeTarget {
  id: string;
  repoPath: string;
}

export function nudgeSync(project: NudgeTarget, label = "sync"): void {
  // Immediate best-effort push; a failure is recorded as unpushed in the sync-status registry and
  // retried by the durable job below (and the E1 heartbeat) — this catch only keeps it from floating.
  void beads
    .sync(project.repoPath)
    .catch((e) => console.error(`[${label}] beads dolt sync failed for ${project.repoPath}`, e));

  // Durable backstop: one deduped push job per repo drives the change to the remote or parks.
  try {
    void Promise.resolve(enqueueSyncPushDeduped(getDb(), systemClock, project.id)).catch((e) =>
      console.error(`[${label}] enqueue sync-push failed for ${project.id}`, e),
    );
  } catch (e) {
    console.error(`[${label}] enqueue sync-push failed for ${project.id}`, e);
  }
}
