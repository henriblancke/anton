/**
 * Build drift (anton-pzfb) — how anton tells that the PROCESS it is running is older than the code
 * on disk.
 *
 * A server is a snapshot: it holds whatever JavaScript existed when it booted, and nothing about a
 * later `git pull` or `anton update` reaches it. Between 2026-08-19 and 2026-08-21 three nightly
 * scans ran under a process predating the two guards that would have dropped their one non-low
 * signal — the fix was on disk, shipped, and simply not running. Nothing in anton said so, so each
 * night's triage re-diagnosed it by hand and closed with "restart the server", advice the operator
 * never saw.
 *
 * The mechanism is the same shape as skill stamps (claude/skill-stamp.mjs): the running server
 * writes what it booted from, and any later reader compares that record against what is on disk
 * NOW. The verdicts deliberately mirror `skillState`'s, because they answer the same question —
 * whether the difference is a release anton can name or something it can only report:
 *
 *   "current"   — the record matches the code on disk. Nothing to say.
 *   "outdated"  — a different VERSION is on disk: a release landed under the running process.
 *   "modified"  — the same version at a different COMMIT: the source checkout moved under it. This
 *                 is the 08-17 case — 0.4.0 both sides, days of fixes apart.
 *   "unstamped" — something is running that recorded no identity (a build predating this file, or a
 *                 record anton could not write). What it is running cannot be established.
 *
 * Read-only by construction, exactly like the skill-drift check it copies: every surface here
 * REPORTS drift and names the restart. anton never restarts itself — a live process may be
 * mid-run, and killing a run to adopt a build is the operator's call, not anton's.
 *
 * Pure Node, no deps: bin/anton.mjs (the launcher, which runs before any build) imports this.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/** Short form of a commit sha in operator-facing copy — long enough to be unambiguous, short enough to read. */
const SHORT_SHA = 7;

/** The record's filename. It lives beside anton.db, the one directory both the server and the CLI resolve identically. */
export const BUILD_RECORD_FILE = "server-build.json";

/** Where the running server records what it booted from, given the anton.db path that install uses. */
export function buildRecordPath(dbPath) {
  return join(dirname(dbPath), BUILD_RECORD_FILE);
}

/** The installed bundle's version, else the checkout's package.json version, else null. */
function readVersion(appRoot) {
  try {
    const release = readFileSync(join(appRoot, "RELEASE_VERSION"), "utf8").trim();
    if (release) return release;
  } catch {}
  try {
    return JSON.parse(readFileSync(join(appRoot, "package.json"), "utf8")).version ?? null;
  } catch {
    return null;
  }
}

/**
 * The commit `appRoot` holds, or null when it isn't a git checkout (every installed bundle — a
 * release tarball carries no .git, and its RELEASE_VERSION already identifies it exactly).
 */
function readRevision(appRoot) {
  const r = spawnSync("git", ["-C", appRoot, "rev-parse", "HEAD"], { encoding: "utf8", timeout: 5000 });
  if (r.status !== 0) return null;
  const sha = (r.stdout ?? "").trim();
  return /^[0-9a-f]{7,40}$/.test(sha) ? sha : null;
}

/** What the code at `appRoot` IS right now: `{ version, revision }` (either may be null). */
export function readBuildIdentity(appRoot) {
  return { version: readVersion(appRoot), revision: readRevision(appRoot) };
}

/** Record what this process booted from. Best-effort: a state dir anton can't write is not fatal. */
export function writeBuildRecord(path, identity, { pid = process.pid, bootedAt = Date.now() } = {}) {
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify({ ...identity, pid, bootedAt }, null, 2)}\n`);
    return true;
  } catch {
    return false;
  }
}

/** The record a running server left, or null when there is none (or it is unreadable/malformed). */
export function readBuildRecord(path) {
  try {
    const record = JSON.parse(readFileSync(path, "utf8"));
    return record && typeof record === "object" ? record : null;
  } catch {
    return null;
  }
}

/** Does this pid name a live process? Signal 0 is the existence check every pidfile reader uses. */
export function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * The verdict for one (running, on-disk) pair — the whole comparison, free of files and processes so
 * it can be exercised over fixtures. Returns `{ state, running, onDisk }`.
 *
 * A missing revision on EITHER side makes the comparison version-only: an installed bundle has no
 * git to name a commit, and inventing drift from an absence would nag every bundle install forever.
 */
export function compareBuild(running, onDisk) {
  const verdict = (state) => ({ state, running: running ?? null, onDisk });
  if (!running || !running.version) return verdict("unstamped");
  if (running.version !== onDisk.version) return verdict("outdated");
  if (running.revision && onDisk.revision && running.revision !== onDisk.revision) {
    return verdict("modified");
  }
  return verdict("current");
}

/**
 * The drift a reader should report, or null when there is nothing to say — the entry point every
 * surface (doctor, the health page, the nightly job) goes through.
 *
 * `serverRunning` is what an ABSENT record means. A record only exists once a build that knows about
 * drift has booted, so its absence is either "nothing is running" (silent — the common case on a
 * fresh install) or "something is running that can't say what it is" (the first upgrade past this
 * change, and precisely the state that hid the stale process for three nights).
 *
 * A record whose pid is dead is a stopped server's leftover: silent, which is what makes a restart
 * the only action needed to clear any verdict here.
 */
export function buildDrift({ appRoot, recordPath, serverRunning = false, isAlive = pidAlive }) {
  const record = readBuildRecord(recordPath);
  if (!record) return serverRunning ? { ...compareBuild(null, readBuildIdentity(appRoot)), bootedAt: null } : null;
  if (!isAlive(record.pid)) return null;
  const verdict = compareBuild(record, readBuildIdentity(appRoot));
  if (verdict.state === "current") return null;
  return { ...verdict, bootedAt: typeof record.bootedAt === "number" ? record.bootedAt : null };
}

/** One build in operator-facing copy: `0.4.0 (a1b2c3d)`, or `0.4.0` where no commit names it. */
export function describeBuildIdentity(identity) {
  if (!identity || !identity.version) return "an unrecorded build";
  const rev = identity.revision ? ` (${identity.revision.slice(0, SHORT_SHA)})` : "";
  return `${identity.version}${rev}`;
}

/**
 * The drift as one sentence naming both builds and the single action that clears it. Shared by
 * doctor and the nightly session log so the operator reads the same claim wherever it surfaces.
 */
export function describeBuildDrift(drift) {
  const onDisk = describeBuildIdentity(drift.onDisk);
  if (drift.state === "unstamped") {
    return (
      `the running anton server recorded no build identity — it predates build-drift reporting, so ` +
      `nothing can say whether it matches the code on disk (${onDisk}). Restart the server to be sure`
    );
  }
  const what = drift.state === "outdated" ? "the runtime on disk is" : "the checkout is now";
  return (
    `the running anton server is ${describeBuildIdentity(drift.running)} but ${what} ${onDisk} — ` +
    `nothing shipped since it booted is running. Restart the server to run it`
  );
}
