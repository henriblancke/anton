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
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { serverBuildDrift, type BuildDrift, type BuildDriftState } from "../build/drift";
import { distanceBehindUpstream } from "../git/ops";

/** Where the checkout stands against its upstream — plus `unknown` for a check that could not run. */
export type CheckoutFreshness =
  | { state: "current" }
  | { state: "behind"; behind: number; upstream: string }
  | { state: "no-upstream" }
  | { state: "unreachable"; reason: string }
  | { state: "unknown"; reason: string };

/** Whether the installed packages still match the lockfile — plus `unknown` when it cannot be told. */
export type DependencyFreshness =
  | { state: "match" }
  | { state: "drift"; packages: string[] }
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
 * stamped none — a unit test, a script — which keeps those silent, exactly as `build/drift` does.
 */
export type BuildFreshness =
  | { state: "current" }
  | { state: "drifted"; drift: BuildDriftState };

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
 * How a caller supplies the build drift the verdict is judged against — self by default
 * ({@link serverBuildDrift}). The board passes the RUNNER's drift instead ({@link runnerBuildDrift}),
 * because a UI-only process rendering the stale band is not the process whose start gate defers work
 * (PR #257 review).
 */
export type BuildDriftSource = () => BuildDrift | null | Promise<BuildDrift | null>;

/**
 * All three halves of the freshness answer for anton's own checkout at `repoPath`, read in parallel.
 * The checkout and dependency halves read the filesystem, shared by every process of the install; the
 * build half is process-specific, so the caller says WHOSE it wants. It defaults to this process's own
 * ({@link serverBuildDrift}) — right for the runner's start gate, which asks about itself — while the
 * board injects the runner's ({@link runnerBuildDrift}), since it renders in a process that may not be
 * the runner. Both pass {@link selfRepoRoot} for the filesystem halves, the root `build/drift` records
 * against.
 */
export async function checkSelfFreshness(
  repoPath: string,
  buildDrift: BuildDriftSource = serverBuildDrift,
): Promise<SelfFreshness> {
  const [checkout, dependencies, drift] = await Promise.all([
    checkoutFreshness(repoPath),
    dependencyFreshness(repoPath),
    Promise.resolve(buildDrift()),
  ]);
  return { checkout, dependencies, build: toBuildFreshness(drift) };
}

/**
 * A build drift, as the freshness verdict reads it. A `git pull`/`bun install` clears the checkout and
 * dependency halves at once but never reaches the modules a live process already loaded; a drift keeps
 * freshness stale until the restart that adopts them.
 */
function toBuildFreshness(drift: BuildDrift | null): BuildFreshness {
  return drift ? { state: "drifted", drift: drift.state } : { state: "current" };
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
 */
function parseBunLock(text: string): BunLock {
  return JSON.parse(text.replace(/,(\s*[}\]])/g, "$1")) as BunLock;
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
 * Whether node_modules still matches the lockfile. Compares the ROOT workspace's direct deps — the
 * ones a pulled fix adds or bumps — against their installed versions; a missing or mismatched package
 * is drift. Transitive-only churn is deliberately out of scope (the ticket's "rather than resolving
 * the full dependency tree"): resolving it costs a full install, which no per-start check can afford.
 */
async function dependencyFreshness(repoPath: string): Promise<DependencyFreshness> {
  let lock: BunLock;
  try {
    lock = parseBunLock(await readFile(join(repoPath, "bun.lock"), "utf8"));
  } catch (e) {
    return { state: "unknown", reason: `bun.lock could not be read (${reason(e)})` };
  }

  const root = lock.workspaces?.[""] ?? {};
  const declared = { ...root.dependencies, ...root.devDependencies };
  const drifted: string[] = [];
  await Promise.all(
    Object.keys(declared).map(async (name) => {
      const locked = lockedVersion(lock, name);
      if (!locked) return; // the lockfile pins nothing to compare against
      if ((await installedVersion(repoPath, name)) !== locked) drifted.push(name);
    }),
  );

  return drifted.length > 0 ? { state: "drift", packages: drifted.sort() } : { state: "match" };
}
