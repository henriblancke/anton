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
import { join, resolve } from "node:path";

import {
  buildRecordPath,
  buildStampPath,
  compareBuild,
  describeBuildDrift,
  describeBuildIdentity,
  isBundleInstall,
  liveBuildRecords,
  pruneBuildRecords,
  readBuildIdentity,
  readBuildRecord,
  sameDirectory,
  writeBuildRecord,
} from "./identity.mjs";
import { antonPidFile, livePid, unstampedServers } from "./servers.mjs";

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
   * A digest of the source an install with NO git holds — the one shape neither the commit nor the
   * worktree digest can describe (a source tarball, `npm i -g anton`). Null wherever git can answer
   * and for a bundle, whose RELEASE_VERSION identifies it exactly.
   */
  source?: string | null;
  /**
   * A digest of the values a build compiles in — the `NEXT_PUBLIC_*` ones, plus whatever the
   * checkout's env files expand into them and whatever `next.config` reads — null when none are
   * set. Recorded so a stamp names the environment it was built with; only the freshness check
   * (`sameCheckout`) compares it, never the drift verdict, whose reader stands in a different shell.
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

/** One drifting server of this install, with the two facts a reader needs to say WHOSE drift it is. */
export interface ServerDrift {
  /** The process this verdict describes. */
  pid: number;
  /** True for the process answering the request — the only one whose in-memory identity can stand in. */
  self: boolean;
  /**
   * Whether this process executes the scheduled jobs. Undefined when nothing says — a record
   * predating the field, or a server too old to have written one at all — where a reader must claim
   * neither: attributing a nightly to a UI-only server is the mistake this field exists to prevent.
   */
  runner: boolean | undefined;
  drift: BuildDrift;
}

/** What a boot record holds beyond the identity itself — `listBuildRecords` proves the pid a number. */
type BuildRecord = BuildIdentity & { pid: number; bootedAt?: unknown; runner?: unknown };

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

/** What THIS process booted from, and whether it is the server that runs the scheduled jobs. */
interface Boot {
  identity: BuildIdentity;
  runner: boolean;
}

/**
 * Anchored on `globalThis` rather than in module scope, for the reason `APP_ROOT_ENV` above is:
 * Next compiles the instrumentation hook and the request graph into SEPARATE module registries, so
 * the copy that stamped this at boot is never the copy a health render reads from. A module-level
 * `let` would therefore hold the boot identity in the one place nothing asks, and the fallback it
 * exists to be would cover nothing: with the record write failed, the rendering copy finds no
 * record, a null boot identity, and — since this process is never a candidate in the search beside
 * the records — no neighbour either, so the page calls a server it cannot name clean (PR #217
 * review). `Symbol.for` keyed, matching the convention for process-wide state here.
 */
const BOOT_KEY = Symbol.for("anton.build.bootedFrom");

/**
 * The backstop for a record anton could not write. Null in anything that never booted a server — a
 * unit test, a script — which is what keeps those silent: no boot identity and no record on disk
 * means there is no running server to call stale.
 */
function booted(): Boot | null {
  return (globalThis as unknown as Record<symbol, Boot | undefined>)[BOOT_KEY] ?? null;
}

/**
 * How long one read of the code on disk stands. `serverBuildDrift` runs on every health render and
 * `readBuildIdentity` spawns git SYNCHRONOUSLY — six reads at minimum on a clean-path miss (the
 * revision, the untracked listing, the diff, the tracked listing, the merged config naming the
 * converting filter drivers, and the ignored env files), plus one attribute read when such a driver
 * is configured, one per tracked symlink resolving back inside the checkout and one read set per
 * initialized submodule, each capped at git's 5s timeout — which would block the event loop on
 * every request.
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
    : { version: null, revision: null, worktree: null, source: null, env: null };
  onDiskCache = { at: now, identity };
  return identity;
}

/**
 * Forget what this module last read off disk, because the caller just moved the code there
 * (PR #217 review).
 *
 * The TTL above is a rate limit for readers that cannot know when a deploy lands. A caller that
 * fast-forwarded the checkout ITSELF does know, and comparing against a read taken before its own
 * pull is the silence this module exists to end, one layer up: the nightly pass refreshes anton's
 * checkout and then asks whether the server is running that code — inside 15s of boot, on the exact
 * pass whose answer changed, the cached read still says yes.
 *
 * Naming a path other than this install's checkout changes nothing: the projects anton scans are
 * usually somebody else's repo, and their commits say nothing about the build this server runs.
 *
 * The two paths are compared literally and then CANONICALLY (PR #217 review). `addProject` stores
 * `resolve(repoPath)`, which never dereferences a symlink, so anton's own checkout registered
 * through one — `~/src/anton -> /Volumes/work/anton` — spells the same directory differently here.
 * Read as another project, the pull would leave the pre-pull read cached and the scan firing inside
 * the TTL would omit the stale-server warning: the exact silence this exists to end.
 */
export function checkoutMoved(repoPath: string): void {
  const root = appRoot();
  if (!root) return;
  if (resolve(repoPath) !== resolve(root) && !sameDirectory(repoPath, root)) return;
  onDiskCache = null;
  driftsCache = null;
  driftsGeneration += 1;
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
 *
 * `runner` says whether this process is the one that will execute the scheduled jobs. The caller
 * passes it rather than this module re-reading `ANTON_RUNNER`, so the record and the gate that
 * actually starts the runner can never disagree — and a reader can then say which of an install's
 * servers a stale build is costing anything (PR #217 review).
 */
export function recordServerBuild({ runner }: { runner: boolean }): void {
  const identity = bootIdentity();
  (globalThis as unknown as Record<symbol, Boot>)[BOOT_KEY] = { identity, runner };
  const db = dbPath();
  if (!db) return;
  writeBuildRecord(buildRecordPath(db), identity, { appRoot: appRoot(), runner });
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
 * worktree and source digests: a development checkout is dirty by definition and every save moves
 * one of the two, so recording either would put a permanent "restart the server" banner in front of
 * the one person who least needs it. Dropping them leaves the version/commit comparison, which is
 * what a dev server can actually miss.
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
  if (process.env.NODE_ENV !== "production") return { ...identity, worktree: null, source: null };
  const stamp = artifactIdentity();
  if (stamp) return stamp;
  const root = appRoot();
  return root && isBundleInstall(root) ? identity : UNIDENTIFIED;
}

/** A build nothing can name — what `compareBuild` reads as "unstamped", since it carries no version. */
const UNIDENTIFIED: BuildIdentity = { version: null, revision: null, worktree: null, source: null, env: null };

/**
 * The checkout the compiled `.next` says it was built from, or null when nothing there says.
 *
 * Absent for an installed bundle (its `.next` ships prebuilt, and RELEASE_VERSION already identifies
 * it exactly) and for a `.next` produced outside `anton start`. A stamp too incomplete to name a
 * version says nothing either — an identity with no version is exactly what `compareBuild` calls
 * unstamped — so it is discarded rather than adopted. What that absence MEANS is `bootIdentity`'s
 * call, and it differs by install.
 *
 * Every digest the stamp carries is carried through, the source one included (PR #217 review):
 * `compareBuild` weighs a field only when both identities hold it, so dropping `source` here left a
 * git-less production server with nothing to compare — the one install shape where that digest is
 * the ONLY evidence of an edit — and every drift surface called it current.
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
    source: stamp.source ?? null,
    env: stamp.env ?? null,
  };
}

/**
 * The drift verdict for THIS process, or null when what it booted from matches the code on disk.
 * What a caller running INSIDE the process it is reporting on wants — the nightly job naming the
 * build its own pass executed. A surface reporting on "the anton server" wants
 * {@link serverBuildDrifts}, which answers for every process of this install rather than one.
 *
 * The identity compared is always this process's own, never another server's. `buildRecordPath`
 * keys on `process.pid`, so a second server on the same install — a UI-only `ANTON_RUNNER=off` one
 * beside the runner, or a hand-over across two ports — writes its own record and cannot overwrite
 * the one this verdict stands on. Nothing here checks liveness either: the process asking is the
 * process being described.
 *
 * The record is read from disk rather than taken from the boot identity because only the file
 * carries the boot time a reader dates the drift by. The in-memory copy answers the one case the
 * file cannot: a state dir anton could not write to.
 *
 * Silent when neither exists. In-process that means nothing here ever booted a server (a test, a
 * script), and inventing an "unstamped" verdict there would put a false warning on the health page
 * of every install. Saying so about a server that IS running but left no record is `anton doctor`'s
 * job — it has the pidfile and the port to prove one is up.
 */
export function serverBuildDrift(): BuildDrift | null {
  const db = dbPath();
  const record = db ? (readBuildRecord(buildRecordPath(db)) as (BuildIdentity & { bootedAt?: unknown }) | null) : null;
  const running = record ?? booted()?.identity ?? null;
  if (!running) return null;
  const verdict = compareBuild(running, onDiskIdentity());
  if (verdict.state === "current") return null;
  const bootedAt = record && typeof record.bootedAt === "number" ? record.bootedAt : null;
  return { ...verdict, bootedAt } as BuildDrift;
}

/**
 * Held for the same window as the on-disk read, and for the same reason: this runs on every health
 * render, and what it stands on is not free — a `ps` per record on a platform without procfs to
 * prove it alive, plus one enumeration of the machine's listening sockets and a fetch per candidate
 * to find the servers no record names.
 */
let driftsCache: { at: number; drifts: ServerDrift[] } | null = null;

/**
 * The read currently running, shared with every caller that arrives while it does (PR #217 review).
 * The cache alone only spares the SECOND render: concurrent ones all miss together, and each then
 * fires the whole neighbour search independently — one enumeration of the machine's sockets and a
 * fetch per candidate port, multiplied by the requests in flight.
 */
let inflightDrifts: Promise<ServerDrift[]> | null = null;

/**
 * Bumped by every invalidation, so a read that STARTED before one cannot store its result after it
 * (PR #217 review). `checkoutMoved` clears the cache, but a read already in flight resolves later
 * and would write the pre-move verdict straight back — leaving the health page calling a
 * now-stale server current for the rest of the TTL, on the exact pass whose answer changed.
 */
let driftsGeneration = 0;

/**
 * Every server of this install that is running something other than the code on disk — empty when
 * they all match, which is the ordinary case.
 *
 * The per-process verdict above is not enough for an operator-facing surface (PR #217 review). One
 * install routinely runs TWO servers: a UI-only `ANTON_RUNNER=off` one serving the pages and a
 * second one executing the scheduled jobs. Asked only about the process rendering the request, the
 * health page stays silent while the runner grinds through nightlies on a build that shipped days
 * ago — the exact silence this module exists to end — and, mirrored, banners a stale UI process with
 * a claim about jobs that a current runner is executing perfectly well. So every live record is read
 * and each is reported as its own process, `runner` saying which one the jobs are actually costing.
 *
 * Liveness is checked here, unlike above: a record of a server that has exited is a leftover, and
 * only the process asking can be assumed to still be up.
 *
 * The boot identity covers this process when the state dir could not be written, the same fallback
 * the per-process read has — and it is process-wide, so the copy of this module rendering the page
 * sees what the copy that booted the server stamped. A NEIGHBOUR whose record is missing has no such
 * stand-in, so it is found the only way it can be — as a live process of this checkout
 * ({@link unstampedNeighbours}).
 */
export async function serverBuildDrifts(): Promise<ServerDrift[]> {
  const now = Date.now();
  if (driftsCache && now - driftsCache.at < ON_DISK_TTL_MS) return driftsCache.drifts;
  const generation = driftsGeneration;
  // Dropped in `finally`, so a read that threw is retried by the next caller rather than replayed
  // to every one of them for the rest of the TTL.
  inflightDrifts ??= readServerDrifts()
    .then((drifts) => {
      if (driftsGeneration === generation) driftsCache = { at: Date.now(), drifts };
      return drifts;
    })
    .finally(() => {
      inflightDrifts = null;
    });
  return inflightDrifts;
}

async function readServerDrifts(): Promise<ServerDrift[]> {
  const db = dbPath();
  const root = appRoot();
  const records: BuildRecord[] =
    db && root ? liveBuildRecords(db, root).map(({ record }: { record: BuildRecord }) => record) : [];
  const drifts: ServerDrift[] = [];
  for (const record of records) {
    const drift = driftOf(record, typeof record.bootedAt === "number" ? record.bootedAt : null);
    if (drift) drifts.push({ pid: record.pid, self: record.pid === process.pid, runner: runsJobs(record), drift });
  }
  const boot = booted();
  if (boot && !records.some((record) => record.pid === process.pid)) {
    const drift = driftOf(boot.identity, null);
    if (drift) drifts.push({ pid: process.pid, self: true, runner: boot.runner, drift });
  }
  for (const pid of await unstampedNeighbours(root, records)) {
    drifts.push({ pid, self: false, runner: undefined, drift: unstampedDrift() });
  }
  return drifts;
}

/**
 * The servers of this install that no record above accounts for — the pre-stamp ones (PR #217
 * review).
 *
 * The records answer for the processes that WROTE one, and the upgrade this module exists for is
 * precisely the case where one did not: a server predating build stamps stays up running the
 * nightlies while the operator, having pulled, starts a current one on the next free port. Reading
 * records alone, this page calls that install clean and the stale runner goes on shipping old
 * verdicts — the silence, one process over. `anton doctor` already looks beside its records, and the
 * two must not answer differently about the same machine, so both stand on `unstampedServers`.
 *
 * THIS process is never a candidate, whatever the records say. The search proves a listener is
 * anton's by fetching its page, and a server fetching its own page from inside a render of that page
 * would recurse; the process asking is also the one case a record can never be needed for, since the
 * process-wide boot identity already stands in for it — which is exactly why that identity may not
 * be module state (see {@link BOOT_KEY}): held per registry it would be null here, and dropping the
 * pid on the strength of a stand-in that does not exist is how an unstamped self goes unreported.
 */
async function unstampedNeighbours(root: string | null, records: BuildRecord[]): Promise<number[]> {
  if (!root) return [];
  const accounted = new Set<number>([process.pid, ...records.map((record) => record.pid)]);
  return unstampedServers({
    isBundle: isBundleInstall(root),
    appRoot: root,
    livePids: accounted,
    pid: () => livePid(antonPidFile()),
  });
}

function driftOf(running: BuildIdentity, bootedAt: number | null): BuildDrift | null {
  const verdict = compareBuild(running, onDiskIdentity());
  if (verdict.state === "current") return null;
  return { ...verdict, bootedAt } as BuildDrift;
}

/**
 * The verdict for a server that recorded nothing: running, and unable to say what it is running.
 * Never "current" — an identity with no version is what `compareBuild` reads as unstamped — and it
 * carries no boot time, because the only thing that would have written one is the record it lacks.
 */
function unstampedDrift(): BuildDrift {
  return { ...compareBuild(null, onDiskIdentity()), bootedAt: null } as BuildDrift;
}

/** Whether a record claims its process runs the jobs — undefined when it predates the field. */
function runsJobs(record: BuildRecord): boolean | undefined {
  return typeof record.runner === "boolean" ? record.runner : undefined;
}

export { describeBuildDrift, describeBuildIdentity };
