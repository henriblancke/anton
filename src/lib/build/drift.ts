/**
 * The server-side face of build drift (anton-pzfb): the running process records what it booted from,
 * and every operator-facing surface asks this module whether that still matches the code on disk.
 *
 * The comparison itself lives in `identity.mjs` — pure Node, because `bin/anton.mjs` (`anton doctor`)
 * runs before any build and must reach the same verdict the UI does. This file adds only the two
 * things a TypeScript caller needs: how THIS install resolves its paths, and the discriminated types
 * the UI narrows on.
 *
 * Paths follow anton.db exactly (`ANTON_DB`, else the cwd the server runs from), so a bundle install
 * — whose writable state lives outside the replaceable runtime dir — records beside the database
 * `anton setup` created rather than inside a directory the next update deletes.
 */
import { join } from "node:path";

import {
  buildDrift,
  buildRecordPath,
  compareBuild,
  describeBuildDrift,
  describeBuildIdentity,
  readBuildIdentity,
  readBuildRecord,
  writeBuildRecord,
} from "./identity.mjs";

export type BuildDriftState = "outdated" | "modified" | "unstamped";

export interface BuildIdentity {
  /** The bundle's RELEASE_VERSION, else the checkout's package.json version. */
  version: string | null;
  /** The commit the checkout held; null for an installed bundle (a tarball carries no git). */
  revision: string | null;
  /**
   * A digest of what the checkout holds beyond that commit — `"clean"` when nothing, null for a
   * bundle. Absent entirely on a record written before this field existed, which is why the
   * comparison treats it as evidence only when both sides carry one.
   */
  worktree?: string | null;
}

export interface BuildDrift {
  state: BuildDriftState;
  /** What the running process booted from; null when it recorded nothing ("unstamped"). */
  running: BuildIdentity | null;
  /** What is on disk now — the build a restart would adopt. */
  onDisk: BuildIdentity;
  /** Unix ms the running process booted, when it recorded one. */
  bootedAt: number | null;
}

function readCwd(): string | null {
  try {
    return process.cwd();
  } catch {
    return null;
  }
}

/**
 * The runtime directory, captured while it still exists.
 *
 * `anton update` (scripts/install.sh) moves the live runtime dir aside and deletes it, so a server
 * that booted from it is left with a cwd that no longer resolves — `process.cwd()` throws ENOENT
 * from then on. That upgrade is precisely the drift this module reports, so it must survive it:
 * holding the pathname keeps every later read pointed at the replacement that took its place.
 */
let appRootCache: string | null = readCwd();

function appRoot(): string | null {
  return (appRootCache ??= readCwd());
}

/**
 * This install's anton.db path — resolved exactly as `getDb` resolves it, so the record lands beside
 * it. Null only when the cwd was already gone before this module ever loaded and no `ANTON_DB` names
 * the state dir; there is nothing left to read a record from in that case.
 */
function dbPath(): string | null {
  if (process.env.ANTON_DB) return process.env.ANTON_DB;
  const root = appRoot();
  return root ? join(root, "anton.db") : null;
}

/**
 * What THIS process booted from, held in memory as the backstop for a record anton could not write.
 * Null in anything that never booted a server — a unit test, a script — which is what keeps those
 * silent: no boot identity and no record on disk means there is no running server to call stale.
 */
let bootedFrom: BuildIdentity | null = null;

/**
 * How long one read of the code on disk stands. `serverBuildDrift` runs on every health render and
 * `readBuildIdentity` spawns git SYNCHRONOUSLY — three reads, once the worktree digest is in it —
 * which would block the event loop on every request. Which build is on disk moves at the speed of a
 * deploy or a save, so a read a few seconds old is as true as a fresh one — and drift the operator
 * must act on stays visible within one page refresh.
 */
const ON_DISK_TTL_MS = 15_000;

let onDiskCache: { at: number; identity: BuildIdentity } | null = null;

function onDiskIdentity(): BuildIdentity {
  const now = Date.now();
  if (onDiskCache && now - onDiskCache.at < ON_DISK_TTL_MS) return onDiskCache.identity;
  const root = appRoot();
  const identity = root
    ? (readBuildIdentity(root) as BuildIdentity)
    : { version: null, revision: null, worktree: null };
  onDiskCache = { at: now, identity };
  return identity;
}

/**
 * Record what this process is running. Called once from the instrumentation hook, BEFORE the runner
 * starts: a UI-only server (`ANTON_RUNNER=off`) is just as capable of being stale, and a record
 * written only on the runner path would leave that one silently unstamped.
 *
 * The file is what makes the verdict readable from OUTSIDE the process (`anton doctor` is a separate,
 * short-lived one); the in-memory copy is what keeps it readable inside when the file write fails.
 */
export function recordServerBuild(): void {
  bootedFrom = bootIdentity();
  const db = dbPath();
  if (db) writeBuildRecord(buildRecordPath(db), bootedFrom);
}

/**
 * What this process is running — the code on disk, minus the worktree digest outside production.
 *
 * A saved edit does not make a dev server stale: `next dev` recompiles the file you just saved. In
 * a development session the checkout is dirty by definition, so recording the digest there would
 * put a permanent "restart the server" banner in front of the one person who least needs it.
 * Dropping it leaves the version/commit comparison, which is what a dev server can actually miss.
 */
function bootIdentity(): BuildIdentity {
  const identity = onDiskIdentity();
  return process.env.NODE_ENV === "production" ? identity : { ...identity, worktree: null };
}

/**
 * The drift verdict for the process serving this install, or null when it matches the code on disk.
 *
 * The record on disk is the primary read even in-process: Next.js bundles the instrumentation hook
 * separately from the request graph, so the module instance that stamped `bootedFrom` at boot is not
 * necessarily this one, and the file is the one thing both can see. `bootedFrom` answers only the
 * case the file cannot — a state dir anton could not write to.
 *
 * Silent when neither exists. In-process that means nothing here ever booted a server (a test, a
 * script), and inventing an "unstamped" verdict there would put a false warning on the health page
 * of every install. Saying so about a server that IS running but left no record is `anton doctor`'s
 * job — it has the pidfile to prove one is up.
 */
export function serverBuildDrift(): BuildDrift | null {
  const db = dbPath();
  const recordPath = db ? buildRecordPath(db) : null;
  const record = recordPath ? readBuildRecord(recordPath) : null;
  if (!record && bootedFrom) {
    const verdict = compareBuild(bootedFrom, onDiskIdentity());
    return verdict.state === "current" ? null : ({ ...verdict, bootedAt: null } as BuildDrift);
  }
  if (!recordPath) return null;
  return buildDrift({
    appRoot: appRoot(),
    recordPath,
    record,
    onDisk: onDiskIdentity(),
  }) as BuildDrift | null;
}

export { describeBuildDrift, describeBuildIdentity };
