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
import type { Stats } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";

/** Lock directory root. One subdirectory per lock name; `mkdir` is the atomic acquire. */
const LOCK_ROOT = join(tmpdir(), "anton-host-locks");

/** Default ceiling on waiting for a peer before giving up and running unlocked. */
const DEFAULT_MAX_WAIT_MS = 30 * 60_000;

/** How long a held lock may go unrefreshed before a peer treats it as abandoned. */
const STALE_AFTER_MS = 60_000;

/** Metadata filename inside a lock directory. */
const OWNER_FILE = "owner.json";

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
 *
 * `expected` is the caller's identity snapshot of `dir` from when it validated the retirement —
 * gate ownership, token match, whatever the caller checked. A prior version re-stated `dir` and
 * compared its identity in a check that ran, then separately awaited the `rename` two lines below —
 * which still left a gap: this whole call can be suspended between those two awaits (this lock is
 * advisory across independent host *processes*, so "suspended" means real wall-clock time in which
 * a peer process keeps running), during which a peer can retire this same directory under its own
 * token and let a successor `mkdir` a fresh one at `dir` before the rename here ever fires — moving
 * that successor under this call's tombstone instead of the orphan `expected` names. Renaming first
 * and verifying identity on what actually landed at the destination closes that gap: once the
 * rename completes, the object we hold at `dest` is ours alone (nothing else knows that path), so
 * the check that follows is authoritative rather than stale, and a mismatch means we grabbed a
 * successor's live directory by mistake — restore it immediately rather than stranding it under a
 * tombstone it never owned. Passing `expected` as `undefined` (the caller's own snapshot already
 * found `dir` gone) always fails without touching the filesystem: there is nothing to verify a
 * grabbed object against, so moving whatever now sits at `dir` could not be justified as retiring
 * what the caller intended.
 *
 * `verify`, when given, runs after the rename and the identity check both pass, against the
 * content that rename just moved atomically to `dest` — not against an earlier, separately
 * awaited read. A decision to retire (e.g. reclaim's abandonment judgment) is made from metadata
 * read before this call; `dir`'s own device+inode can't reveal a write that landed in between,
 * since content changes don't change identity. Binding the check to what actually got moved closes
 * that gap: a resumed creator either published before the rename (so `dest` now carries it, and
 * `verify` sees the mismatch) or after (so its own identity check against the now-vacated `dir`
 * fails first, per the write()/isOurDir() contract below). A verify failure restores `dest`, same
 * as an identity mismatch.
 */
async function retire(
  dir: string,
  token: string,
  expected: Stats | undefined,
  verify?: (dest: string) => Promise<boolean>,
): Promise<boolean> {
  // Holder metadata is in a host-writable temp directory. Accept only tokens this module creates so
  // a forged owner file cannot turn the rename destination into a path traversal.
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(token)) {
    return false;
  }
  if (expected === undefined) return false;
  const dest = `${dir}.retired-${token}`;
  try {
    await rename(dir, dest);
  } catch {
    return false;
  }
  if (!sameIdentity(expected, await safeStat(dest))) {
    // Grabbed a successor's live directory instead of the one `expected` names. That successor may
    // still be running its own protected section under the identity we just renamed away — it has no
    // idea `dir` moved, and it isn't a leaked tombstone we can leave for inspection later. Restore
    // unconditionally rather than checking `dir` for a new occupant first: a third process racing
    // `mkdir(dir)` into the gap this rename opened has (by construction) published nothing yet, so
    // POSIX allows rename to replace that still-empty directory outright, evicting it — the third
    // process's own identity check (the same one every other lost race in this file relies on) then
    // sees `dir` no longer matches what it created and falls back to running unlocked, same as any
    // other loser here. Only once an occupant has advanced far enough to publish metadata does the
    // directory stop being empty, and then the rename simply fails (caught below) and leaves the
    // grabbed successor stranded under this tombstone — the narrower residual window this file's
    // other retirements already accept, since no rename-if-absent primitive exists to close it
    // further.
    await rename(dest, dir).catch(() => {});
    return false;
  }
  if (verify && !(await verify(dest))) {
    // Identity matched — this is genuinely the directory `expected` names — but its content, moved
    // here atomically by the rename above, no longer matches the state that authorized retiring it.
    // Whoever published that content is the legitimate holder; restore rather than evict them.
    await rename(dest, dir).catch(() => {});
    return false;
  }
  return true;
}

/**
 * Remove a directory that looks abandoned without letting the destructive step itself resolve the
 * pathname fresh against whatever a peer put there in the meantime. Renaming to a reap-private
 * tombstone first means the actual `rm` always targets a name nothing else can be racing against —
 * it narrows, though (without an fd-relative removal syscall Node doesn't expose) can't fully close,
 * the window between the caller's identity check and the `rename` itself: a decider can reap this
 * same stale gate and `mkdir` a fresh one at this path in that gap, so the rename can move the
 * replacement rather than the gate `expected` names. Bind the reap to that checked identity by
 * re-verifying it against what actually got moved, and putting back anything that doesn't match
 * instead of deleting a gate that may be live.
 */
async function reapGate(gate: string, expected: Stats): Promise<void> {
  const tombstone = `${gate}.reaped-${randomUUID()}`;
  try {
    await rename(gate, tombstone);
  } catch {
    return; // already gone, or already reaped by someone else
  }
  if (!sameIdentity(expected, await safeStat(tombstone))) {
    // Moved a successor's fresh gate instead of the stale one `expected` names — restore it rather
    // than deleting a decider's live gate out from under it.
    await rename(tombstone, gate).catch(() => {});
    return;
  }
  await rm(tombstone, { recursive: true, force: true }).catch(() => {});
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
    const gateStat = await safeStat(gate);
    if (gateStat !== undefined && Date.now() - gateStat.mtimeMs > STALE_AFTER_MS) {
      // Re-check identity, not mtime, immediately before deleting. The age check above and this
      // reap are two separate awaits, and a legitimate decider can reap this same stale gate and
      // `mkdir` a fresh one at this path in the gap between them — comfortably within the same
      // mtime tick, so a repeated mtime comparison can mistake that successor's gate for the one
      // we judged stale. Device+inode identifies the exact instance, so it can't make that mistake
      // — which would otherwise let two deciders run the reclaim decision concurrently and break
      // mutual exclusion on `dir`.
      const recheck = await safeStat(gate);
      if (recheck !== undefined && sameIdentity(gateStat, recheck)) {
        await reapGate(gate, recheck);
      }
    }
    return false; // let the caller's normal deadline/poll path retry reclaim() next iteration
  }
  // This decider's own gate identity, captured right after our `mkdir` created it. If we (the
  // owner) pause past STALE_AFTER_MS before reaching `finally`, the reap branch above can treat
  // our gate as abandoned, remove it, and let a new decider `mkdir` a fresh one at the same path —
  // likely within the same mtime tick as ours, so comparing mtime alone can't tell our gate from
  // that successor's. Device+inode can: re-verify identity, not mtime, before removing.
  const ownGateStat = await safeStat(gate);
  try {
    const holder = await readHolder(metaPath);
    const dirCreatedAt = holder ? 0 : await dirMtimeMs(dir);
    if (dirCreatedAt === undefined || !isAbandoned(holder, dirCreatedAt, Date.now())) {
      return false;
    }
    // Re-verify this decider still owns the gate immediately before the destructive retire: if this
    // decider was suspended long enough for a peer to reap its gate as stale (or, transitively, for
    // reapGate's own restore-on-mismatch to lose a race and strand a *different* decider's gate —
    // see reapGate above), a fresh decider can already have reclaimed this same orphan under its own
    // token and re-acquired `dir` as a live successor. Retiring by pathname without this check would
    // rename that successor's live directory away instead of the orphan this decision was made
    // against.
    if (!sameIdentity(ownGateStat, await safeStat(gate))) {
      return false;
    }
    const token = holder?.token ?? randomUUID();
    // `dir`'s own device+inode doesn't change when a file inside it does, so retire()'s identity
    // check can't tell "still the orphan we judged abandoned" from "the same directory, but its
    // creator resumed, published owner.json, and entered `fn` in the gap since `holder` was read
    // above." Re-read the metadata immediately before the destructive retire as a cheap early exit —
    // still unpublished, or still the same stale heartbeat — so an obviously-renewed lease never
    // even reaches the rename below. This alone isn't sufficient: it's a separate awaited read, so a
    // creator resuming in the gap *after* this check but before retire()'s own rename would still
    // slip past it. The `verify` callback passed to retire() below closes that: it re-checks
    // authorization against the metadata retire()'s rename actually moved, atomically bound to the
    // retirement itself rather than to an earlier snapshot.
    const isStillAuthorized = (candidate: LockFile | undefined): boolean =>
      holder === undefined
        ? candidate === undefined
        : candidate?.token === holder.token && candidate.heartbeatAt === holder.heartbeatAt;
    if (!isStillAuthorized(await readHolder(metaPath))) {
      return false;
    }
    // Bind the retire to `dir`'s identity as of right now, not just the gate check above: if this
    // decider is suspended between here and retire()'s own rename, a peer can still reap this gate
    // and reclaim `dir` under a different token in that gap. retire() verifies this snapshot against
    // whatever its own rename actually grabbed, and restores it on a mismatch, so a successor's
    // fresh `mkdir` there gets moved back instead of being retired as if it were still the orphan
    // this decision was made against.
    return await retire(dir, token, await safeStat(dir), async (dest) =>
      isStillAuthorized(await readHolder(join(dest, OWNER_FILE))),
    );
  } finally {
    const ownRecheck = await safeStat(gate);
    if (ownRecheck !== undefined && sameIdentity(ownGateStat, ownRecheck)) {
      await reapGate(gate, ownRecheck);
    }
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
 * Full stat, used where a caller needs to tell "the exact same filesystem object" from "a
 * different one that now happens to sit at the same path" — mtime alone can't. A reclaim's
 * replacement directory (or gate) is created moments after the original is renamed away or
 * removed, comfortably within the same timestamp tick at typical filesystem mtime granularity, so
 * a repeated mtime comparison can mistake the successor for the instance it was compared against.
 * Device+inode can't be fooled the same way: the OS never hands the successor our original's
 * identity. Undefined when the path doesn't exist.
 */
async function safeStat(path: string): Promise<Stats | undefined> {
  try {
    return await stat(path);
  } catch {
    return undefined;
  }
}

/** True only when both stats exist and name the same filesystem object (device+inode). */
function sameIdentity(a: Stats | undefined, b: Stats | undefined): boolean {
  return a !== undefined && b !== undefined && a.dev === b.dev && a.ino === b.ino;
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
  const metaPath = join(dir, OWNER_FILE);
  const deadline = Date.now() + maxWaitMs;
  const token = randomUUID();

  await mkdir(LOCK_ROOT, { recursive: true });

  let held = false;
  let notifiedWait = false;
  // A reclaim decision in flight (see reclaim()) can hold `dir` moved aside at a restore tombstone
  // between retire()'s rename and its own mismatch/verify-failure restore — a window with no
  // process standing at `dir` at all. Racing a fresh mkdir(dir) into that vacancy would grab the
  // path out from under the pending restore and leave the legitimate holder (who may already be
  // running `fn`, believing it never lost the lock) stranded under the tombstone while we also
  // start running — two holders in the protected section at once. `${dir}.reclaiming` is mkdir'd
  // before the decision starts and only removed after retire() (including any restore) finishes, so
  // waiting out a *fresh* gate instead of racing narrows that vacancy down to the gap between this
  // check and our own mkdir(dir) below — the one remaining sliver is closed by rechecking the gate
  // again right after that mkdir succeeds, before this acquisition publishes anything. Only a fresh
  // gate counts: a live decision never outlives STALE_AFTER_MS (per reclaim()'s own reaping logic
  // below), so a gate older than that is an orphan from a killed decider, not a decision in progress
  // — falling through to the normal contended path lets reclaim()'s existing stale-gate reap run,
  // same as before this check existed. Treating every gate as a reason to wait would starve that
  // reap forever, since nothing here would ever attempt it.
  const reclaimGate = `${dir}.reclaiming`;

  while (!held) {
    const gateStat = await safeStat(reclaimGate);
    if (gateStat !== undefined && Date.now() - gateStat.mtimeMs <= STALE_AFTER_MS) {
      const remaining = deadline - Date.now();
      if (opts.signal?.aborted || remaining <= 0) break; // advisory: run unlocked
      await new Promise((r) => setTimeout(r, Math.min(POLL_MS, remaining)));
      continue;
    }
    try {
      // mkdir is atomic and fails when the directory exists — the acquire primitive.
      await mkdir(dir);
      const freshDirStat = await safeStat(dir);
      // The gate check above can still miss a decision that starts in the gap right before this
      // mkdir: retire() renames `dir` aside, we mkdir into the vacancy it opens, and — if the
      // holder it retired turns out to still be alive — its restore then races this still-
      // unpublished directory next. Recheck the gate now, before writing anything, so a pending
      // restore always finds `dir` either vacant or gone rather than colliding with metadata we
      // already wrote. Guard the abandon itself with an identity check: by the time we act, the
      // restore may already have replaced this same path with the holder it put back, and a blind
      // rm would destroy that instead of our own (still-empty) directory.
      const gateAfterMkdir = await safeStat(reclaimGate);
      if (gateAfterMkdir !== undefined && Date.now() - gateAfterMkdir.mtimeMs <= STALE_AFTER_MS) {
        if (sameIdentity(freshDirStat, await safeStat(dir))) {
          await rm(dir, { recursive: true, force: true }).catch(() => {});
        }
        continue;
      }
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

  // This acquisition's identity: `dir`'s device+inode captured once, right after our own `mkdir`
  // created it. A reclaim of a metadata-less orphan mints its own random token (there's no holder
  // token to read yet) and renames the whole directory away rather than editing it in place, so if
  // we were paused long enough to be reclaimed, a successor's fresh `mkdir` now lives at `dir` —
  // likely sharing our old mtime at typical filesystem timestamp granularity, but never our inode.
  // Because this value is a stable snapshot rather than something advanced after every write, a
  // write that fails outright can never leave the identity check out of sync with reality: each
  // check is independent and always compares against the same original snapshot.
  //
  // This snapshot is itself a plain pathname lookup performed after `mkdir` resolves, not bound to
  // the acquisition atomically (Node exposes no create+fstat primitive for directories) — a creator
  // suspended by the OS for longer than STALE_AFTER_MS across exactly that gap can still capture a
  // successor's inode here. write() and the release below cross-check the published token as an
  // independent second signal for that case — except in the narrow sub-window where the resumed
  // creator's write races in before the successor's own first write has published any metadata yet:
  // readHolder then returns undefined, the token check has nothing to compare against, and the
  // resumed creator can briefly publish its own stale token into the successor's directory. The
  // successor's own next write then sees the mismatch, backs off, and falls back to running
  // unlocked — the same advisory fallback as every other lost race here, not data corruption. Fully
  // closing it would need an atomic mkdir+fstat primitive Node doesn't expose, same as the
  // inode-snapshot gap above.
  const ourDirStat = await safeStat(dir);
  const isOurDir = async (): Promise<boolean> => sameIdentity(ourDirStat, await safeStat(dir));

  // Write-then-rename so a reader never observes a truncated mid-heartbeat file. A torn read would
  // parse as undefined and, since overwriting owner.json doesn't bump the directory's own mtime,
  // fall back to the (stale) dirCreatedAt — misreading a live, heartbeating holder as an orphan.
  // rename is atomic within one directory, so readHolder always sees a complete write or none.
  const tmpMetaPath = `${metaPath}.${token}.tmp`;
  const write = async (): Promise<boolean> => {
    if (!(await isOurDir())) return false;
    try {
      // A second, independent signal alongside the inode check above: if a reclaim already
      // published a successor's metadata under `dir`, its token can never equal ours. A creator
      // resumed from a long enough OS-level suspension can still have captured `ourDirStat` from
      // that same successor's fresh mkdir (the inode snapshot above is itself a separate pathname
      // lookup, not bound atomically to our own mkdir) — content ownership catches what inode
      // identity alone was fooled into missing, so this can't overwrite a live successor once that
      // successor has published its own metadata (see the docstring above for the narrower
      // pre-first-write sub-case this can't catch).
      const current = await readHolder(metaPath);
      if (current && current.token !== token) return false;
      await writeFile(
        tmpMetaPath,
        JSON.stringify({ token, pid: process.pid, heartbeatAt: Date.now(), label: opts.label ?? "" }),
        "utf8",
      );
      // Re-verify immediately before the rename that actually publishes into `dir`: a peer can fully
      // reclaim and recreate `dir` (or publish its own metadata) in the gap since the checks above,
      // and writeFile/rename resolve by pathname rather than by the directory identity checked
      // above — the writeFile just above can silently land its `.tmp` file inside a successor's
      // freshly recreated directory instead of ours. That's harmless on its own; skipping the rename
      // here is what stops it from going further and overwriting the successor's real owner.json.
      // This narrows, but — without an atomic rename-if-unchanged primitive Node doesn't expose —
      // can't fully close, the same class of residual gap already documented above.
      if (!(await isOurDir())) {
        await rm(tmpMetaPath, { force: true }).catch(() => {});
        return false;
      }
      const recheck = await readHolder(metaPath);
      if (recheck && recheck.token !== token) {
        await rm(tmpMetaPath, { force: true }).catch(() => {});
        return false;
      }
      await rename(tmpMetaPath, metaPath);
      return true;
    } catch {
      // `dir` can vanish between the checks above and this write (another reclaim, this time in
      // the gap write() itself introduces) — advisory fallback, same as every other lost race here.
      return false;
    }
  };
  if (!(await write())) {
    // write() also returns false when `dir` is still ours but the write itself failed outright (a
    // transient I/O error on writeFile/rename, caught above) — not just when a reclaim already took
    // `dir`. Left standing, that directory has no readable metadata and no heartbeat coming (we're
    // about to fall back to running unlocked), so every peer would misjudge it as "maybe mid-write"
    // for a full STALE_AFTER_MS before anyone could reclaim it. Retire it now, same identity/token
    // check as the normal release below, so a reclaim by a successor never took `dir` out from under
    // this check in the meantime.
    if (await isOurDir()) {
      const current = await readHolder(metaPath);
      if (!current || current.token === token) {
        // Pass ourDirStat, not just the isOurDir()/readHolder checks above: those can pass and
        // then this call still be suspended past a successor's reclaim before it reaches retire()'s
        // own rename. retire() verifies ourDirStat against whatever that rename actually grabbed and
        // restores it on a mismatch, so the successor is moved back instead of staying stranded.
        await retire(dir, token, ourDirStat);
      }
    }
    return fn();
  }
  // Keep the heartbeat fresh so a long-but-healthy hold is never mistaken for a crash. Unref'd so a
  // pending tick can't hold the process open. A heartbeat that loses the identity check above
  // silently no-ops — the lock then goes stale from a peer's view and gets reclaimed normally, and
  // the next tick re-checks independently rather than compounding a missed write into a stuck state.
  // Chained (never run concurrently) so `pendingWrite` always names every write still in flight, not
  // just the most recent tick's — awaiting it below can otherwise return before an earlier write,
  // still mid-syscall, has actually landed.
  let pendingWrite: Promise<unknown> = Promise.resolve();
  const beat = setInterval(() => {
    pendingWrite = pendingWrite.then(() => write().catch(() => {}));
  }, STALE_AFTER_MS / 3);
  beat.unref?.();

  try {
    return await fn();
  } finally {
    clearInterval(beat);
    // A heartbeat write already past write()'s own ownership/token checks when `fn` settles is still
    // racing this retire — clearInterval only stops *future* ticks. Left unawaited, that write's
    // writeFile+rename can land after this block retires `dir` and a successor acquires the same
    // path, publishing our stale token into the successor's metadata and wedging its heartbeat and
    // release. Wait for it (and anything chained after it) before touching `dir` again.
    await pendingWrite;
    // Re-verify identity before retiring, same as before writing: if a peer already reclaimed this
    // acquisition, `dir` now belongs to a successor and must not be retired out from under it. The
    // token-specific tombstone still protects the case where metadata existed at reclaim time
    // (reclaim reuses `holder.token`, so its rename destination collides with ours and fails).
    // Cross-check the published token too, same reasoning as in write(): the inode snapshot alone
    // can't be trusted if a resumed, long-suspended acquisition ever mis-bound it to a successor.
    if (await isOurDir()) {
      const current = await readHolder(metaPath);
      if (!current || current.token === token) {
        // Same binding as the fallback retirement above: retire() verifies ourDirStat against
        // whatever its rename actually grabbed, so a successor that reclaimed `dir` while this call
        // was suspended is moved back instead of staying stranded.
        await retire(dir, token, ourDirStat);
      }
    }
  }
}

/** The lock every full-suite verify gate shares. Exported so tests and callers can't drift. */
export const VERIFY_GATE_LOCK = "verify-gates";
