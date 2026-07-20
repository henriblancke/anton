/**
 * Host-wide advisory lock (anton-0oi). anton runs epics concurrently in separate worktrees on one
 * machine, so two runs can reach their verify gates at the same time and each start a full test
 * suite. The suites then starve each other and fail on timeouts that belong to neither change —
 * observed as a whole integration file blowing its per-test budget under 2x load, which then gets
 * mis-diagnosed as a flaky test and "fixed" by raising timeouts.
 *
 * This serializes those sections across every anton process on the host. It is advisory and
 * best-effort by design: a caller that cannot acquire within its budget runs anyway rather than
 * failing the epic, because a slow check is better than a stuck queue.
 */
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

/** Lock directory root. One subdirectory per lock name; `mkdir` is the atomic acquire. */
const LOCK_ROOT = join(tmpdir(), "anton-host-locks");

/** Default ceiling on waiting for a peer before giving up and running unlocked. */
const DEFAULT_MAX_WAIT_MS = 30 * 60_000;

/** How long a held lock may go unrefreshed before a peer treats it as abandoned. */
const STALE_AFTER_MS = 60_000;

/** Poll interval while waiting for a peer to release. */
const POLL_MS = 2_000;

interface LockFile {
  pid: number;
  /** Refreshed while held, so a peer can tell "slow" from "dead" without trusting pid reuse. */
  heartbeatAt: number;
  label: string;
}

export interface HostLockOptions {
  /** Give up waiting after this long and run anyway (advisory). Default 30 min. */
  maxWaitMs?: number;
  /** Abort waiting when the run is cancelled. */
  signal?: AbortSignal;
  /** Human-readable owner, recorded in the lock file for debugging. */
  label?: string;
  /** Called once when the lock is contended, so callers can log the wait. */
  onWait?: (holder: LockFile | undefined) => void;
}

function isAlive(pid: number): boolean {
  try {
    // Signal 0 performs the permission/existence check without delivering a signal.
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Read the holder's metadata; undefined when unreadable (mid-write, or already released). */
async function readHolder(metaPath: string): Promise<LockFile | undefined> {
  try {
    return JSON.parse(await readFile(metaPath, "utf8")) as LockFile;
  } catch {
    return undefined;
  }
}

/**
 * A holder is abandoned when its process is gone, or when it stopped heartbeating long enough that
 * a crash mid-hold is the only explanation. Unreadable metadata is treated as abandoned only once
 * it is also old, so a peer that is mid-write is never stolen from.
 */
function isAbandoned(holder: LockFile | undefined, dirCreatedAt: number, now: number): boolean {
  if (!holder) return now - dirCreatedAt > STALE_AFTER_MS;
  if (!isAlive(holder.pid)) return true;
  return now - holder.heartbeatAt > STALE_AFTER_MS;
}

/**
 * Run `fn` while holding the named host lock. Always runs `fn` exactly once — on timeout or a
 * stolen/abandoned lock it proceeds unlocked rather than throwing, so contention can never wedge a
 * run. Releases the lock even if `fn` throws.
 */
export async function withHostLock<T>(
  name: string,
  fn: () => Promise<T>,
  opts: HostLockOptions = {},
): Promise<T> {
  const maxWaitMs = opts.maxWaitMs ?? DEFAULT_MAX_WAIT_MS;
  const dir = join(LOCK_ROOT, name);
  const metaPath = join(dir, "owner.json");
  const deadline = Date.now() + maxWaitMs;

  await mkdir(LOCK_ROOT, { recursive: true });

  let held = false;
  let notifiedWait = false;
  let dirCreatedAt = Date.now();

  while (!held) {
    try {
      // mkdir is atomic and fails when the directory exists — the acquire primitive.
      await mkdir(dir);
      held = true;
      break;
    } catch {
      const holder = await readHolder(metaPath);
      if (!notifiedWait) {
        opts.onWait?.(holder);
        notifiedWait = true;
      }
      if (isAbandoned(holder, dirCreatedAt, Date.now())) {
        // Reclaim: drop the corpse and retry immediately. Two peers may race here; the loser's
        // mkdir simply fails and it keeps waiting, so at most one winner proceeds.
        await rm(dir, { recursive: true, force: true });
        dirCreatedAt = Date.now();
        continue;
      }
      const remaining = deadline - Date.now();
      if (opts.signal?.aborted || remaining <= 0) break; // advisory: run unlocked
      // Never sleep past the caller's own deadline — a fixed poll would make a short maxWaitMs
      // wait a full POLL_MS, so the "advisory" escape hatch would fire late (or not at all).
      await new Promise((r) => setTimeout(r, Math.min(POLL_MS, remaining)));
    }
  }

  if (!held) return fn();

  const write = () =>
    writeFile(metaPath, JSON.stringify({ pid: process.pid, heartbeatAt: Date.now(), label: opts.label ?? "" }), "utf8");
  await write();
  // Keep the heartbeat fresh so a long-but-healthy hold is never mistaken for a crash. Unref'd so a
  // pending tick can't hold the process open.
  const beat = setInterval(() => void write().catch(() => {}), STALE_AFTER_MS / 3);
  beat.unref?.();

  try {
    return await fn();
  } finally {
    clearInterval(beat);
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/** The lock every full-suite verify gate shares. Exported so tests and callers can't drift. */
export const VERIFY_GATE_LOCK = "verify-gates";
