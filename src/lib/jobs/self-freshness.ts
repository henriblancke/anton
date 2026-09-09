/**
 * One honest answer to "is this process running its own latest code" (anton-vzhf), covering both
 * halves of what a start actually executes: the CHECKOUT (is HEAD behind the tree its remote carries)
 * and the INSTALLED DEPENDENCIES (does node_modules still match the lockfile). anton pulls before it
 * starts, but a fix merged after the last pull, or a lockfile bump nobody reinstalled, both leave the
 * running process a step behind its own repairs.
 *
 * It only REPORTS — reacting to the verdict (refusing a start, surfacing it) is the sibling tickets'
 * job. So every failure is its own verdict, never dressed up as "behind": a remote it cannot reach,
 * an unreadable lockfile, a git read that broke — each says exactly what it could not establish, so a
 * caller never refuses a start on the strength of a check that never ran.
 *
 * Cheap enough to run before every start: the checkout half fetches a single upstream ref (a network
 * READ, never a push), and the dependency half compares the lockfile's DIRECT deps against what is
 * installed — no `bun install`, no dependency-tree resolution.
 *
 * Both remedies land on the FILESYSTEM, which the running process does not follow, so two halves
 * describe the process rather than the disk: the build it booted from, and the packages it imported
 * ({@link readBootDependencies}). Without them the very `git pull` / `bun install` this gate
 * prescribes would clear it while the process went on executing the old code (PR #257 review).
 */
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import {
  runnerBootDependencies,
  runnerBuildDrift,
  selfBootDependencies,
  serverBuildDrift,
  type BuildDrift,
  type BuildDriftState,
} from "../build/drift";
import { distanceBehindUpstream } from "../git/ops";

/** Where the checkout stands against its upstream — plus `unknown` for a check that could not run. */
export type CheckoutFreshness =
  | { state: "current" }
  | { state: "behind"; behind: number; upstream: string }
  | { state: "no-upstream" }
  | { state: "unreachable"; reason: string }
  | { state: "unknown"; reason: string };

/**
 * Whether the installed packages still match the lockfile — plus `unknown` when it cannot be told,
 * and `replaced` for the half a reinstall cannot clear.
 *
 * `replaced` is the dependency mirror of {@link BuildFreshness} (PR #257 review): `bun install` makes
 * `node_modules` match the lockfile the instant it lands, but the running process keeps the modules
 * it imported at boot, and `readBuildIdentity` deliberately excludes `node_modules` — so installing
 * packages moves NO other half of this verdict. Without this state the very remedy the stale band
 * displays would clear the stop while the process still executes the old install. It latches on the
 * boot snapshot ({@link readBootDependencies}), so only a restart clears it.
 */
export type DependencyFreshness =
  | { state: "match" }
  | { state: "drift"; packages: string[] }
  | { state: "replaced" }
  | { state: "unknown"; reason: string };

/**
 * Whether the RUNNING process still executes the build on disk. The checkout and dependency halves
 * read the filesystem, which an operator's `git pull`/`bun install` makes current the instant it
 * lands — but the live Next process and job runner keep the modules they compiled at boot until a
 * restart. So on the very remedy this gate displays, both filesystem halves can clear while the
 * process is still running its old code; this half stays `drifted` across that gap, so freshness
 * cannot clear merely because the files underneath the process changed (PR #257 review).
 *
 * Sourced from the boot identity `build/drift` already records. `current` covers a process that
 * stamped none — a unit test, a script — which keeps those silent, exactly as `build/drift` does,
 * while `unknown` is a read that FAILED (the runner's drift enumerates the machine's sockets), kept
 * apart from `current` for the reason every other half here keeps its failure apart from its answer.
 */
export type BuildFreshness =
  | { state: "current" }
  | { state: "drifted"; drift: BuildDriftState }
  | { state: "unknown"; reason: string };

export interface SelfFreshness {
  checkout: CheckoutFreshness;
  dependencies: DependencyFreshness;
  build: BuildFreshness;
}

function reason(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Where build/drift.ts publishes anton's OWN install root, so a moved runtime dir is still found. */
const APP_ROOT_ENV = "ANTON_APP_ROOT";

/**
 * anton's own install root — the checkout the self-freshness verdict is read against, NOT the project
 * checkout a run operates on. Both the start-time preflight and the board's stale-breaker read resolve
 * it here, so "which tree is anton itself" is answered in exactly one place.
 */
export function selfRepoRoot(): string {
  return process.env[APP_ROOT_ENV] ?? process.cwd();
}

/**
 * WHOSE process the two process-specific halves describe — the build it booted from, and the
 * packages it imported. Both are per-process, and neither is readable off the filesystem the other
 * two halves share, so the caller says which process it means.
 *
 * {@link SELF} is right for the start gate, which asks about the process that would run the work.
 * The board passes {@link RUNNER}, because a UI-only process rendering the stale band is not the
 * process whose start gate defers work (PR #257 review).
 */
export interface RunningProcess {
  /** Which process this describes — the cache key half that keeps the two verdicts apart. */
  id: "self" | "runner";
  buildDrift: () => BuildDrift | null | Promise<BuildDrift | null>;
  bootDependencies: () => string | null | Promise<string | null>;
}

/**
 * This process — what the runner's own start gate asks about.
 *
 * Its build drift is read UNCACHED (PR #257 review). `build/drift` holds one read of the code on
 * disk for 15s, a rate limit for surfaces that repaint; a gate is not one. A source-only `git pull`
 * completing inside that window leaves the checkout half reading current (HEAD moved, the fetch is
 * live) and the dependency half untouched, while this half still compares the running build against
 * the pre-pull disk — so all three say current and {@link checkSelfFreshness}'s own `maxAgeMs: 0`
 * buys nothing: the gate admits a run onto the process the pull just made stale.
 */
export const SELF: RunningProcess = {
  id: "self",
  buildDrift: () => serverBuildDrift({ fresh: true }),
  bootDependencies: selfBootDependencies,
};

/** The process that executes the scheduled jobs, whichever one that is. */
export const RUNNER: RunningProcess = {
  id: "runner",
  buildDrift: runnerBuildDrift,
  bootDependencies: runnerBootDependencies,
};

/**
 * All three halves of the freshness answer for anton's own checkout at `repoPath`. The checkout half
 * and the lockfile comparison read the filesystem, shared by every process of the install; the build
 * half and the dependency LATCH are process-specific, so the caller says WHOSE it wants
 * ({@link RunningProcess}). The two filesystem reads run together and the process comparison follows
 * them, so a pull landing mid-pass cannot leave the halves describing different disks
 * ({@link checkFreshnessUncached}). It defaults to {@link SELF} — right for the runner's start gate,
 * which asks about itself — while the board injects {@link RUNNER}, since it renders in a process
 * that may not be the runner. Both pass {@link selfRepoRoot} for the filesystem halves, the root
 * `build/drift` records against.
 *
 * `maxAgeMs` is how old a verdict the CALLER will accept, and it defaults to 0 — no reuse of any
 * kind — because the two callers want opposite things (PR #257 review). The start gate must never
 * defer or admit a run on a verdict taken before the pull that changed it, so it takes the default
 * and pays the fetch. The board, which reads this on every render and every breaker poll once per
 * project, passes a window: the answer only moves when someone merges or an operator pulls, and a
 * per-render fetch per project bought nothing for it.
 *
 * A caller naming no window does not even JOIN a pass already in flight (PR #257 review). An
 * in-flight pass is not "the state right now": it may have fetched the upstream tip before this
 * caller's own preflight began and still be reading the dependency and build halves, so joining it
 * hands the gate a checkout verdict captured BEFORE the pull it exists to catch — the same staleness
 * `maxAgeMs: 0` refuses in a settled verdict. Two concurrent passes cost two fetches and nothing
 * else: `distanceBehindUpstream` writes a private per-read ref, so neither can contend on a ref lock
 * with the other.
 */
export async function checkSelfFreshness(
  repoPath: string,
  running: RunningProcess = SELF,
  { maxAgeMs = 0 }: { maxAgeMs?: number } = {},
): Promise<SelfFreshness> {
  const key = `${running.id}\0${repoPath}`;
  const cache = freshnessCache();
  const hit = cache.get(key);
  // A pass already in flight is shared only with a caller that named a WINDOW. Such a pass began
  // before this call did, so its fetch may predate the caller's own preflight — which is exactly the
  // reuse `maxAgeMs: 0` exists to refuse, in-flight or settled.
  if (maxAgeMs > 0 && hit && (hit.inFlight || Date.now() - hit.at < maxAgeMs)) return await hit.verdict;

  const verdict = checkFreshnessUncached(repoPath, running);
  const entry: FreshnessEntry = { at: Date.now(), verdict, inFlight: true };
  cache.set(key, entry);
  try {
    return await verdict;
  } catch (e) {
    // A rejection is not an answer, so it must never be served to a later caller. (Each of the three
    // halves catches its own failure, so this only fires on a genuine bug in one of them.)
    if (cache.get(key) === entry) cache.delete(key);
    throw e;
  } finally {
    // Stamped on COMPLETION, not on start: a slow pass must not hand back a verdict that has already
    // spent most of its own window.
    entry.at = Date.now();
    entry.inFlight = false;
  }
}

/**
 * The two filesystem halves run in parallel; the PROCESS comparison is read LAST (PR #257 review).
 *
 * Read concurrently, the build half could compare the running process against the PRE-pull disk and
 * answer `current`, while the checkout half — whose network fetch takes far longer — counted its
 * distance AFTER a source-only `git pull` landed and answered `current` too. With dependencies
 * untouched, all three halves say current and the gate admits a run onto the process the pull just
 * made stale: a torn verdict, assembled from halves that saw different disks.
 *
 * Reading the process comparison after both filesystem reads have settled removes the tear. Any pull
 * that lands during the pass is now seen by the LAST read to touch the disk: the build half compares
 * the running process against the post-pull tree and answers `drifted`. A pull that lands entirely
 * after the pass is not this function's problem — no half could have seen it, and the start gate
 * takes `maxAgeMs: 0` precisely so the next start reads it fresh.
 */
async function checkFreshnessUncached(
  repoPath: string,
  running: RunningProcess,
): Promise<SelfFreshness> {
  const [checkout, dependencies] = await Promise.all([
    checkoutFreshness(repoPath),
    dependencyFreshness(repoPath, running.bootDependencies),
  ]);
  const build = await buildFreshness(running.buildDrift);
  return { checkout, dependencies, build };
}

interface FreshnessEntry {
  /** ms epoch this verdict SETTLED — the age clock `maxAgeMs` is read against. */
  at: number;
  verdict: Promise<SelfFreshness>;
  /** Whether the pass is still running — a windowed caller joins it rather than starting another. */
  inFlight: boolean;
}

/**
 * Held on `globalThis` for the reason `build/drift.ts` holds its boot identity there: Next compiles
 * the instrumentation-started runner and the request graph into SEPARATE module registries, so a
 * module-level Map would give the board and the start gate a cache each — and a board render would
 * then miss the pass its own poll is already running.
 */
const CACHE_KEY = Symbol.for("anton.jobs.selfFreshness");

function freshnessCache(): Map<string, FreshnessEntry> {
  const holder = globalThis as unknown as Record<symbol, Map<string, FreshnessEntry> | undefined>;
  return (holder[CACHE_KEY] ??= new Map());
}

/** Drop every memoized verdict. Tests only — production entries age out on the caller's `maxAgeMs`. */
export function resetSelfFreshnessCache(): void {
  freshnessCache().clear();
}

/**
 * A build drift, as the freshness verdict reads it. A `git pull`/`bun install` clears the checkout and
 * dependency halves at once but never reaches the modules a live process already loaded; a drift keeps
 * freshness stale until the restart that adopts them.
 *
 * The source is called through this rather than in the `Promise.all` array (PR #257 review), so a
 * failure reads as a verdict on THIS half instead of escaping the whole check. Two ways it could
 * escape: the source type admits a SYNCHRONOUS implementation, whose throw would land before
 * `Promise.all` ever saw the array, and an async one's rejection had no catch either — while the
 * runner's drift genuinely can throw, since finding the servers no record names enumerates the
 * machine's sockets (health.ts already guards the same read). Either way the caller got an exception
 * where the module promises a verdict, which is the one thing the checkout and dependency halves are
 * built never to do.
 *
 * A failure is its own verdict (`unknown`), never dressed up as either answer — the rule the other
 * two halves already follow, so a caller neither refuses a start on a check that never ran nor reads
 * a failed read as proof the process is current.
 */
async function buildFreshness(buildDrift: RunningProcess["buildDrift"]): Promise<BuildFreshness> {
  try {
    const drift = await buildDrift();
    return drift ? { state: "drifted", drift: drift.state } : { state: "current" };
  } catch (e) {
    return { state: "unknown", reason: reason(e) };
  }
}

async function checkoutFreshness(repoPath: string): Promise<CheckoutFreshness> {
  try {
    // Every state distanceBehindUpstream returns — current, behind, no-upstream, unreachable — is a
    // verdict in its own right. Only an unexpected throw is the check itself failing.
    return await distanceBehindUpstream(repoPath);
  } catch (e) {
    return { state: "unknown", reason: reason(e) };
  }
}

/** The subset of a bun.lock (lockfileVersion 1) this check reads. */
interface BunLock {
  workspaces?: Record<
    string,
    { dependencies?: Record<string, string>; devDependencies?: Record<string, string> }
  >;
  /** name → [ "name@version", registry, deps, integrity ]. The resolved version lives in element 0. */
  packages?: Record<string, [string, ...unknown[]]>;
}

/**
 * Parse a bun text lockfile. It is JSON with trailing commas (no comments), which `JSON.parse`
 * rejects — so the sole tolerance is stripping a comma that sits right before a `}` or `]`. bun.lock
 * values are version strings, registry urls, and integrity hashes, none of which carry that byte
 * sequence, so the strip touches only structural commas.
 *
 * A lockfile declaring a version this parser does not know about is REFUSED rather than read on the
 * chance its shape still fits (PR #257 review): every field below is a version-1 assumption, and a
 * format bump that moved them would yield a package list that is confidently wrong. The throw lands
 * in {@link dependencyFreshness}'s catch, so an unrecognised format reads as `unknown` — the
 * fail-open verdict this module gives every check that could not answer, never a false `match` and
 * never a fabricated drift.
 */
function parseBunLock(text: string): BunLock {
  const parsed = JSON.parse(text.replace(/,(\s*[}\]])/g, "$1")) as BunLock & {
    lockfileVersion?: number;
  };
  if (parsed.lockfileVersion !== undefined && parsed.lockfileVersion !== 1) {
    throw new Error(`unsupported bun.lock lockfileVersion ${parsed.lockfileVersion}`);
  }
  return parsed;
}

/** The exact version the lockfile pins for `name`, or undefined when it pins nothing for it. */
function lockedVersion(lock: BunLock, name: string): string | undefined {
  const spec = lock.packages?.[name]?.[0];
  if (!spec) return undefined;
  // "name@version" / "@scope/name@version" — the version starts after the LAST "@" (a scope's own
  // "@" sits at index 0, never at the split point).
  const at = spec.lastIndexOf("@");
  return at > 0 ? spec.slice(at + 1) : undefined;
}

/** The version currently installed for `name`, or undefined when it is not installed / unreadable. */
async function installedVersion(repoPath: string, name: string): Promise<string | undefined> {
  try {
    const pkg = JSON.parse(
      await readFile(join(repoPath, "node_modules", name, "package.json"), "utf8"),
    ) as { version?: string };
    return pkg.version;
  } catch {
    // Missing dir, unreadable manifest — the package is not installed as the lockfile pins it, which
    // is exactly the drift the caller wants surfaced.
    return undefined;
  }
}

/**
 * A digest of what is installed for the lockfile's direct deps — the one field that tells a
 * reinstall apart from the install a running process actually imported.
 */
function digestDeps(deps: { name: string; installed: string | undefined }[]): string {
  const digest = createHash("sha256");
  for (const { name, installed } of deps) {
    digest.update(name).update("\0").update(installed ?? "").update("\0");
  }
  return digest.digest("hex").slice(0, 12);
}

/**
 * The dependency identity a booting process records beside its build identity — the fix for the one
 * staleness nothing else could see (PR #257 review).
 *
 * A server that boots with a current `bun.lock` and a stale `node_modules` shows `drift` and the
 * `bun install` remedy the stale band displays. Running it makes the lockfile comparison return
 * `match` — and moves NOTHING else: `readBuildIdentity` excludes `node_modules` at every depth, so
 * the build half reads `current` too. The stop therefore cleared on the very command that fixed the
 * FILES while the process went on executing the modules it imported from the OLD install, which is
 * exactly the code this gate exists to keep out of the trunk. Latched against this snapshot, the
 * verdict instead stays `replaced` until the restart that adopts them.
 *
 * Null when the lockfile cannot be read: best-effort like every stamp it mirrors, and an absence is
 * read as no evidence rather than as a fabricated drift.
 */
export async function readBootDependencies(repoPath: string = selfRepoRoot()): Promise<string | null> {
  try {
    const lock = parseBunLock(await readFile(join(repoPath, "bun.lock"), "utf8"));
    return digestDeps(await installedDirectDeps(repoPath, lock));
  } catch {
    return null;
  }
}

/**
 * The direct deps the lockfile pins, with what is installed for each — the pair this half compares
 * and the pair the boot snapshot digests, read once so both stand on the same view of node_modules.
 */
async function installedDirectDeps(
  repoPath: string,
  lock: BunLock,
): Promise<{ name: string; locked: string; installed: string | undefined }[]> {
  const root = lock.workspaces?.[""] ?? {};
  const declared = { ...root.dependencies, ...root.devDependencies };
  const pairs = await Promise.all(
    Object.keys(declared)
      .sort()
      .map(async (name) => {
        const locked = lockedVersion(lock, name);
        // The lockfile pins nothing to compare against — no drift to claim, and nothing to digest.
        if (!locked) return null;
        return { name, locked, installed: await installedVersion(repoPath, name) };
      }),
  );
  return pairs.filter((pair) => pair !== null);
}

/**
 * Whether node_modules still matches the lockfile. Compares the ROOT workspace's direct deps — the
 * ones a pulled fix adds or bumps — against their installed versions; a missing or mismatched package
 * is drift. Transitive-only churn is deliberately out of scope (the ticket's "rather than resolving
 * the full dependency tree"): resolving it costs a full install, which no per-start check can afford.
 */
async function dependencyFreshness(
  repoPath: string,
  bootDependencies: RunningProcess["bootDependencies"],
): Promise<DependencyFreshness> {
  let lock: BunLock;
  try {
    lock = parseBunLock(await readFile(join(repoPath, "bun.lock"), "utf8"));
  } catch (e) {
    return { state: "unknown", reason: `bun.lock could not be read (${reason(e)})` };
  }

  const deps = await installedDirectDeps(repoPath, lock);
  const drifted = deps.filter((dep) => dep.installed !== dep.locked).map((dep) => dep.name);
  if (drifted.length > 0) return { state: "drift", packages: drifted };

  // node_modules matches the lockfile — but the RUNNING process may still hold the install it
  // imported at boot (PR #257 review), which only a restart replaces.
  let booted: string | null;
  try {
    booted = await bootDependencies();
  } catch (e) {
    return { state: "unknown", reason: `the running process's dependencies could not be read (${reason(e)})` };
  }
  // No snapshot is no evidence — a test, a script, or a server predating this field is silent rather
  // than latched on an absence.
  return booted !== null && booted !== digestDeps(deps) ? { state: "replaced" } : { state: "match" };
}
