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
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";

/** Lock directory root. One subdirectory per lock name; `mkdir` is the atomic acquire. */
const LOCK_ROOT = join(tmpdir(), "anton-host-locks");

/** Default ceiling on waiting for a peer before giving up and running unlocked. */
const DEFAULT_MAX_WAIT_MS = 30 * 60_000;

/** How long a held lock may go unrefreshed before a peer treats it as abandoned. */
const STALE_AFTER_MS = 60_000;

/** Poll interval while waiting for a peer to release. */
const POLL_MS = 2_000;

interface LockFile {
  /** Unique acquisition identity, used to make reclaim and release ownership-safe. */
  token: string;
  pid: number;
  /** Refreshed while held, so a peer can tell "slow" from "dead" without trusting pid reuse. */
  heartbeatAt: number;
  label: string;
}

/**
 * Move an acquisition out of the live lock path without ever deleting whatever currently lives
 * there. Reclaim and release use the same token-specific destination. Once either wins, that
 * non-empty tombstone remains as a guard: a delayed actor for the old acquisition cannot rename a
 * successor over it. The tiny files live under the OS temp directory and are cleared on reboot.
 */
async function retire(dir: string, token: string): Promise<boolean> {
  // Holder metadata is in a host-writable temp directory. Accept only tokens this module creates so
  // a forged owner file cannot turn the rename destination into a path traversal.
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(token)) {
    return false;
  }
  try {
    await rename(dir, `${dir}.retired-${token}`);
    return true;
  } catch {
    return false;
  }
}

/**
 * Reclaim a directory that looked abandoned on an earlier, now-stale read. Metadata-less orphans
 * have no shared token to rename to, so each concurrent reclaimer used to mint its own random one —
 * meaning two peers could both "win" distinct tombstones, and a delayed peer's rename could steal
 * whatever now lives at `dir`, including a fresh acquisition that replaced the orphan in between.
 * `${dir}.reclaiming` is an exclusive mkdir gate: only the process that creates it gets to decide,
 * and it re-reads holder/mtime state under the gate rather than trusting the caller's stale read —
 * so a peer that loses the gate (or wins it late) always judges the *current* directory, never
 * mistakes a just-recreated live lock for the orphan that justified its own reclaim attempt.
 */
async function reclaim(dir: string, metaPath: string): Promise<boolean> {
  const gate = `${dir}.reclaiming`;
  try {
    await mkdir(gate);
  } catch {
    // Someone else holds the gate — either a live decision in progress, or a decider that was
    // killed between its own `mkdir(gate)` and the `finally`'s `rm(gate)`, orphaning it forever.
    // A live decision never outlives STALE_AFTER_MS (it's a handful of local fs ops), so reap a
    // gate older than that: worst case we race a genuinely live decider and lose the reap's own
    // mkdir, which is harmless since that decider's `finally` still removes it.
    const gateCreatedAt = await dirMtimeMs(gate);
    if (gateCreatedAt !== undefined && Date.now() - gateCreatedAt > STALE_AFTER_MS) {
      // Re-stat immediately before deleting. The check above and this reap are two separate
      // awaits, and a legitimate decider can reap this same stale gate and `mkdir` a fresh one
      // at this path in the gap between them. Deleting by pathname alone can't tell the two
      // apart; requiring the mtime to still match confirms we're removing the exact instance we
      // judged stale, never a live decider's gate — which would otherwise let two deciders run
      // the reclaim decision concurrently and break mutual exclusion on `dir`.
      if ((await dirMtimeMs(gate)) === gateCreatedAt) {
        await rm(gate, { recursive: true, force: true }).catch(() => {});
      }
    }
    return false; // let the caller's normal deadline/poll path retry reclaim() next iteration
  }
  try {
    const holder = await readHolder(metaPath);
    const dirCreatedAt = holder ? 0 : await dirMtimeMs(dir);
    if (dirCreatedAt === undefined || !isAbandoned(holder, dirCreatedAt, Date.now())) {
      return false;
    }
    const token = holder?.token ?? randomUUID();
    return await retire(dir, token);
  } finally {
    await rm(gate, { recursive: true, force: true }).catch(() => {});
  }
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
 * The directory's own mtime, used as the acquisition's age when there is no metadata to read yet.
 * Undefined when the directory has already vanished (a race with a release/reclaim elsewhere) —
 * callers should just retry the acquire rather than judging staleness against a value that no
 * longer describes anything.
 */
async function dirMtimeMs(dir: string): Promise<number | undefined> {
  try {
    return (await stat(dir)).mtimeMs;
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
  const token = randomUUID();

  await mkdir(LOCK_ROOT, { recursive: true });

  let held = false;
  let notifiedWait = false;

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
      // Metadata-less dirs (killed between mkdir and the owner.json write) have no heartbeat to
      // judge, so fall back to the directory's own mtime. A dir that just vanished out from under
      // us is neither abandoned nor live — its age is unknowable, so skip the reclaim judgment.
      const dirCreatedAt = holder ? 0 : await dirMtimeMs(dir);
      if (dirCreatedAt !== undefined && isAbandoned(holder, dirCreatedAt, Date.now())) {
        if (await reclaim(dir, metaPath)) {
          continue;
        }
        // Another peer is already reclaiming this dir, already won, or a fresh holder appeared by
        // the time we got the gate. Fall through to the normal deadline/poll path; spinning here
        // would defeat maxWaitMs.
      }
      if (dirCreatedAt === undefined) {
        // Usually a benign race with a peer's release/reclaim, but if LOCK_ROOT itself was swept
        // (e.g. a temp cleaner) mkdir(dir) would keep failing with ENOENT forever. Recreate it so
        // that can't happen, and fall through to the same deadline/poll check as any other
        // contended attempt instead of retrying unconditionally — an unconditional retry here
        // would never observe maxWaitMs and could spin indefinitely.
        await mkdir(LOCK_ROOT, { recursive: true }).catch(() => {});
      }
      const remaining = deadline - Date.now();
      if (opts.signal?.aborted || remaining <= 0) break; // advisory: run unlocked
      // Never sleep past the caller's own deadline — a fixed poll would make a short maxWaitMs
      // wait a full POLL_MS, so the "advisory" escape hatch would fire late (or not at all).
      await new Promise((r) => setTimeout(r, Math.min(POLL_MS, remaining)));
    }
  }

  if (!held) return fn();

  // Write-then-rename so a reader never observes a truncated mid-heartbeat file. A torn read would
  // parse as undefined and, since overwriting owner.json doesn't bump the directory's own mtime,
  // fall back to the (stale) dirCreatedAt — misreading a live, heartbeating holder as an orphan.
  // rename is atomic within one directory, so readHolder always sees a complete write or none.
  const tmpMetaPath = `${metaPath}.${token}.tmp`;
  const write = async () => {
    await writeFile(
      tmpMetaPath,
      JSON.stringify({ token, pid: process.pid, heartbeatAt: Date.now(), label: opts.label ?? "" }),
      "utf8",
    );
    await rename(tmpMetaPath, metaPath);
  };
  await write();
  // Keep the heartbeat fresh so a long-but-healthy hold is never mistaken for a crash. Unref'd so a
  // pending tick can't hold the process open.
  const beat = setInterval(() => void write().catch(() => {}), STALE_AFTER_MS / 3);
  beat.unref?.();

  try {
    return await fn();
  } finally {
    clearInterval(beat);
    // The token-specific tombstone also makes release safe if this acquisition was reclaimed: its
    // tombstone already exists, so a late release cannot move or delete the successor at `dir`.
    await retire(dir, token);
  }
}

/** The lock every full-suite verify gate shares. Exported so tests and callers can't drift. */
export const VERIFY_GATE_LOCK = "verify-gates";
