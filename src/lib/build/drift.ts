/**
 * The server-side face of build drift (anton-pzfb): the running process records what it booted from,
 * and every operator-facing surface asks this module whether that still matches the code on disk.
 *
 * The comparison itself lives in `identity.mjs` — pure Node, because `bin/anton.mjs` (`anton doctor`)
 * runs before any build and must reach the same verdict the UI does. This file adds only the two
 * things a TypeScript caller needs: how THIS install resolves its paths, and the discriminated types
 * the UI narrows on.
 *
 * Paths follow anton.db exactly (`ANTON_DB`, else the runtime dir the server runs from), so a bundle install
 * — whose writable state lives outside the replaceable runtime dir — records beside the database
 * `anton setup` created rather than inside a directory the next update deletes.
 */
import { join } from "node:path";

import {
  buildRecordPath,
  buildStampPath,
  compareBuild,
  describeBuildDrift,
  describeBuildIdentity,
  isBundleInstall,
  pruneBuildRecords,
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
  /**
   * A digest of the `NEXT_PUBLIC_*` values a build compiles in — null when none are set. Recorded
   * so a stamp names the environment it was built with; only the freshness check (`sameCheckout`)
   * compares it, never the drift verdict, whose reader stands in a different shell.
   */
  env?: string | null;
}

export interface BuildDrift {
  state: BuildDriftState;
  /**
   * What the running process booted from; null when it recorded nothing. An identity carrying no
   * version is the same claim — a build that names nothing — and reads as "unstamped" too.
   */
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
 * Where this install's runtime directory is published, so it outlives the directory itself.
 *
 * `anton update` (scripts/install.sh) moves the live runtime dir aside and deletes it, so a server
 * that booted from it is left with a cwd that no longer resolves — `process.cwd()` throws ENOENT
 * from then on. That upgrade is precisely the drift this module reports, so it must survive it:
 * holding the pathname keeps every later read pointed at the replacement that took its place.
 *
 * A module-level cache alone is not enough to hold it. Next bundles the instrumentation hook and
 * the request graph into SEPARATE module registries (see lib/jobs/service), so the copy of this
 * module that renders the health page may first load long after boot — and if that is after the
 * upgrade, its cache is seeded from a cwd that is already gone. `process.env` is the one thing both
 * registries share: the launcher sets this before spawning the server, and a boot that finds it
 * unset writes the cwd back while it still resolves.
 */
const APP_ROOT_ENV = "ANTON_APP_ROOT";

function resolveAppRoot(): string | null {
  const declared = process.env[APP_ROOT_ENV];
  if (declared) return declared;
  const cwd = readCwd();
  if (cwd) process.env[APP_ROOT_ENV] = cwd;
  return cwd;
}

let appRootCache: string | null = resolveAppRoot();

function appRoot(): string | null {
  return (appRootCache ??= resolveAppRoot());
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
 * `readBuildIdentity` spawns git SYNCHRONOUSLY — five reads at minimum on a clean-path miss (the
 * revision, the untracked listing, the diff, the tracked listing, and the ignored env files), plus
 * one per tracked symlink resolving back inside the checkout and one read set per initialized
 * submodule, each capped at git's 5s timeout — which would block the event loop on every request.
 * Which build is on disk moves at the speed of a deploy or a save, so a read a few seconds old is as
 * true as a fresh one — and drift the operator must act on stays visible within one page refresh.
 */
const ON_DISK_TTL_MS = 15_000;

let onDiskCache: { at: number; identity: BuildIdentity } | null = null;

function onDiskIdentity(): BuildIdentity {
  const now = Date.now();
  if (onDiskCache && now - onDiskCache.at < ON_DISK_TTL_MS) return onDiskCache.identity;
  const root = appRoot();
  const identity = root
    ? (readBuildIdentity(root) as BuildIdentity)
    : { version: null, revision: null, worktree: null, env: null };
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
 *
 * It is named for this pid, so a second server booting from the same install cannot overwrite what
 * this one is judged against — and the boot that wrote it is also where the records of servers that
 * have since exited get dropped, since nothing deletes one at exit.
 *
 * The install this process booted from is recorded with it: the database these records sit beside
 * may be shared with another checkout (`ANTON_DB`), and a reader that cannot tell whose server a
 * record describes compares a neighbour's build against its own code.
 */
export function recordServerBuild(): void {
  bootedFrom = bootIdentity();
  const db = dbPath();
  if (!db) return;
  writeBuildRecord(buildRecordPath(db), bootedFrom, { appRoot: appRoot() });
  pruneBuildRecords(db);
}

/**
 * What this process is running.
 *
 * In production that is the ARTIFACT, not the checkout. `next start` serves the `.next` it found at
 * boot, and `anton start` proved that artifact fresh BEFORE spawning it — a pull or a save landing
 * in the gap between those two moments reaches the checkout this hook reads but never reaches the
 * running code. Recording the checkout there would stamp the process with a build it is not
 * serving, and every drift surface would report the stale server as current: the failure this
 * module exists to end. The build's own stamp names the checkout it was compiled from, so recording
 * that instead makes the late pull surface as the drift it is.
 *
 * Outside production the checkout IS the truth — `next dev` recompiles what you save — minus the
 * worktree digest: a development checkout is dirty by definition, so recording the digest would put
 * a permanent "restart the server" banner in front of the one person who least needs it. Dropping
 * it leaves the version/commit comparison, which is what a dev server can actually miss.
 *
 * A production artifact carrying NO stamp is recorded as nothing at all, not as the checkout beside
 * it (PR #217 review). `anton start` stamps every source build it makes, so an unstamped `.next` in
 * a checkout came from something else — `bun run build && bun run start`, or a stamp write that
 * failed — and `next start` is still serving that older artifact. Reading the checkout there is the
 * same false "current" one paragraph up, by another route. Only an installed bundle keeps the
 * version fallback: `ensureFreshBuild` deliberately leaves its prebuilt `.next` unstamped, and its
 * RELEASE_VERSION identifies it exactly.
 *
 * That leaves one gap open deliberately (PR #217 review): the job runner is started once from the
 * instrumentation hook and deliberately survives hot reloads (lib/jobs/service), so a scheduled job
 * under `anton dev` can keep executing pre-edit code while this reports the server current. A digest
 * that moves on every save would banner the entire session and be ignored long before the one
 * moment it mattered — a dev runner running old code is fixed by the restart the developer is
 * already doing, not by a warning they have learned to dismiss.
 */
function bootIdentity(): BuildIdentity {
  const identity = onDiskIdentity();
  if (process.env.NODE_ENV !== "production") return { ...identity, worktree: null };
  const stamp = artifactIdentity();
  if (stamp) return stamp;
  const root = appRoot();
  return root && isBundleInstall(root) ? identity : UNIDENTIFIED;
}

/** A build nothing can name — what `compareBuild` reads as "unstamped", since it carries no version. */
const UNIDENTIFIED: BuildIdentity = { version: null, revision: null, worktree: null, env: null };

/**
 * The checkout the compiled `.next` says it was built from, or null when nothing there says.
 *
 * Absent for an installed bundle (its `.next` ships prebuilt, and RELEASE_VERSION already identifies
 * it exactly) and for a `.next` produced outside `anton start`. A stamp too incomplete to name a
 * version says nothing either — an identity with no version is exactly what `compareBuild` calls
 * unstamped — so it is discarded rather than adopted. What that absence MEANS is `bootIdentity`'s
 * call, and it differs by install.
 */
function artifactIdentity(): BuildIdentity | null {
  const root = appRoot();
  if (!root) return null;
  const stamp = readBuildRecord(buildStampPath(root)) as BuildIdentity | null;
  if (!stamp?.version) return null;
  return {
    version: stamp.version,
    revision: stamp.revision ?? null,
    worktree: stamp.worktree ?? null,
    env: stamp.env ?? null,
  };
}

/**
 * The drift verdict for THIS process, or null when what it booted from matches the code on disk.
 *
 * The identity compared is always this process's own, never another server's. `buildRecordPath`
 * keys on `process.pid`, so a second server on the same install — a UI-only `ANTON_RUNNER=off` one
 * beside the runner, or a hand-over across two ports — writes its own record and cannot overwrite
 * the one this verdict stands on. Nothing here checks liveness either: the process asking is the
 * process being described.
 *
 * The record is read from disk rather than taken from `bootedFrom` because Next.js bundles the
 * instrumentation hook separately from the request graph, so the module instance that stamped
 * `bootedFrom` at boot is not necessarily this one — the file is the one thing both copies see.
 * `bootedFrom` answers only the case the file cannot: a state dir anton could not write to.
 *
 * Silent when neither exists. In-process that means nothing here ever booted a server (a test, a
 * script), and inventing an "unstamped" verdict there would put a false warning on the health page
 * of every install. Saying so about a server that IS running but left no record is `anton doctor`'s
 * job — it has the pidfile and the port to prove one is up.
 */
export function serverBuildDrift(): BuildDrift | null {
  const db = dbPath();
  const record = db ? (readBuildRecord(buildRecordPath(db)) as (BuildIdentity & { bootedAt?: unknown }) | null) : null;
  const running = record ?? bootedFrom;
  if (!running) return null;
  const verdict = compareBuild(running, onDiskIdentity());
  if (verdict.state === "current") return null;
  const bootedAt = record && typeof record.bootedAt === "number" ? record.bootedAt : null;
  return { ...verdict, bootedAt } as BuildDrift;
}

export { describeBuildDrift, describeBuildIdentity };
