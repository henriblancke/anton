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
 *   "modified"  — the same version at a different COMMIT, or the same commit with different
 *                 UNCOMMITTED work: the source checkout moved under it. This is the 08-17 case —
 *                 0.4.0 both sides, days of fixes apart.
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
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/** Short form of a commit sha in operator-facing copy — long enough to be unambiguous, short enough to read. */
const SHORT_SHA = 7;

/** The worktree digest for a checkout with nothing uncommitted. A literal, so it never reads as a hash. */
const WORKTREE_CLEAN = "clean";

/**
 * Cap on one git read. A digest anton cannot compute degrades to "no evidence" (see `compareBuild`),
 * so the limit only has to be far above any plausible uncommitted diff.
 */
const GIT_MAX_BUFFER = 64 * 1024 * 1024;

/**
 * One build's identity — what a comparison here is between. Written to both stamps, so a record
 * left by an older anton legitimately carries no `worktree` at all.
 *
 * @typedef {object} BuildIdentity
 * @property {string|null} version
 * @property {string|null} revision
 * @property {string|null} [worktree]
 */

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

/** Do two paths name the same directory? Resolved, because a symlinked state dir is still that dir. */
function sameDirectory(a, b) {
  try {
    return realpathSync(a) === realpathSync(b);
  } catch {
    return false;
  }
}

/**
 * The commit `appRoot` ITSELF holds, or null when it is not the root of a git checkout (every
 * installed bundle — a release tarball carries no .git, and its RELEASE_VERSION already identifies
 * it exactly).
 *
 * The toplevel check is what makes that "itself": `git rev-parse` walks UP the tree until it finds
 * any repository, so a bundle installed under a git-tracked $HOME would otherwise report the
 * dotfiles repo's HEAD — an unrelated sha on both sides of the comparison, flipping to "modified"
 * and demanding a restart of a current server after every dotfile commit.
 */
function readRevision(appRoot) {
  const out = git(appRoot, ["rev-parse", "--show-toplevel", "HEAD"]);
  if (out === null) return null;
  const [top, sha] = out.trim().split("\n", 2);
  if (!top || !sha || !/^[0-9a-f]{7,40}$/.test(sha.trim())) return null;
  return sameDirectory(top.trim(), appRoot) ? sha.trim() : null;
}

/** One git read at `appRoot`: its stdout, or null when git failed, timed out, or ran away. */
function git(appRoot, args) {
  const r = spawnSync("git", ["-C", appRoot, ...args], {
    encoding: "utf8",
    timeout: 5000,
    maxBuffer: GIT_MAX_BUFFER,
  });
  return r.status === 0 && !r.error ? (r.stdout ?? "") : null;
}

/**
 * A digest of everything the checkout holds that HEAD does not — `WORKTREE_CLEAN` when it holds
 * nothing, null when git could not say.
 *
 * The commit alone cannot answer "is the artifact stale?" in the loop anton is actually developed
 * in: edit a tracked file without committing and `.next` was compiled from code that no longer
 * exists, at the same version and the same HEAD. So the comparison has to reach past HEAD — and
 * name-and-status alone (`git status` on its own) is not enough either, because editing one file
 * twice reports "M src/x.ts" both times while the artifact falls a whole edit behind.
 *
 * Hence both reads: the diff (`--binary`, so a changed asset is content and not "Binary files
 * differ"; `--no-ext-diff`, so a configured diff driver cannot summarize content away) for what
 * tracked files now say, and the untracked list for files that exist only on disk — a new
 * `page.tsx` changes the build while no tracked file moves.
 */
function readWorktreeDigest(appRoot) {
  const untracked = git(appRoot, ["status", "--porcelain", "--untracked-files=all"]);
  if (untracked === null) return null;
  const diff = git(appRoot, ["diff", "--binary", "--no-ext-diff", "HEAD"]);
  if (diff === null) return null;
  if (!untracked && !diff) return WORKTREE_CLEAN;
  return createHash("sha256").update(untracked).update("\0").update(diff).digest("hex").slice(0, 12);
}

/**
 * What the code at `appRoot` IS right now: `{ version, revision, worktree }` (any may be null).
 *
 * The worktree digest is read only where a revision was: `readRevision`'s toplevel check is what
 * proves `appRoot` is its own checkout, and without it a bundle unpacked in a git-tracked $HOME
 * would wear that repo's uncommitted dotfile edits.
 *
 * @returns {BuildIdentity}
 */
export function readBuildIdentity(appRoot) {
  const revision = readRevision(appRoot);
  return {
    version: readVersion(appRoot),
    revision,
    worktree: revision ? readWorktreeDigest(appRoot) : null,
  };
}

/** Write one stamp. Best-effort: a directory anton can't write to is not fatal for either caller. */
function writeStampFile(path, value) {
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
    return true;
  } catch {
    return false;
  }
}

/**
 * Record what this process booted from. Best-effort: a state dir anton can't write is not fatal.
 *
 * @param {string} path
 * @param {BuildIdentity} identity
 */
export function writeBuildRecord(path, identity, { pid = process.pid, bootedAt = Date.now() } = {}) {
  return writeStampFile(path, { ...identity, pid, bootedAt });
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

/** The stamp a source build leaves inside the artifact it produced, naming the checkout it compiled. */
export const BUILD_STAMP_FILE = "anton-build.json";

/** Where that stamp lives: inside `.next`, so it is deleted with the build it describes. */
export function buildStampPath(appRoot) {
  return join(appRoot, ".next", BUILD_STAMP_FILE);
}

/**
 * Stamp a fresh build with the checkout that produced it. Best-effort, like the boot record.
 *
 * @param {string} appRoot
 * @param {BuildIdentity} [identity]
 */
export function writeBuildStamp(appRoot, identity = readBuildIdentity(appRoot)) {
  return writeStampFile(buildStampPath(appRoot), { ...identity, builtAt: Date.now() });
}

/**
 * Can anton prove the compiled `.next` was built from the checkout on disk?
 *
 * `next start` serves whatever `.next` already holds — it never checks which code produced it — so
 * a checkout that moved after its last build (a commit, or an edit nobody committed) boots as the
 * NEW code while serving the old one, and
 * every drift surface then reports a stale server as current. An unstamped build is a no: a build
 * anton cannot identify is one it cannot claim is current, and rebuilding is the cheap side of that
 * bet (the alternative is serving code nobody can name).
 *
 * @param {string} appRoot
 * @param {BuildIdentity} [onDisk]
 */
export function buildMatchesCheckout(appRoot, onDisk = readBuildIdentity(appRoot)) {
  const stamp = readBuildRecord(buildStampPath(appRoot));
  if (!stamp) return false;
  return compareBuild(stamp, onDisk).state === "current";
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
 * An absence on either side is never evidence of drift. A missing revision makes the comparison
 * version-only — an installed bundle has no git to name a commit, and inventing drift from an
 * absence would nag every bundle install forever. Likewise a checkout that cannot name its own
 * version (no RELEASE_VERSION, no readable package.json) cannot prove a release landed: comparing
 * against null would report "outdated" and send the operator to restart a server that is fine, when
 * the fault is the install on disk. The revision comparison below still stands on its own there.
 *
 * The worktree digest follows the same rule and needs it more: a record written before this field
 * existed carries none, and calling that "modified" would demand one restart of every install on
 * the upgrade that introduced it.
 *
 * @param {BuildIdentity|null|undefined} running
 * @param {BuildIdentity} onDisk
 */
export function compareBuild(running, onDisk) {
  const verdict = (state) => ({ state, running: running ?? null, onDisk });
  if (!running || !running.version) return verdict("unstamped");
  if (onDisk.version && running.version !== onDisk.version) return verdict("outdated");
  if (running.revision && onDisk.revision && running.revision !== onDisk.revision) {
    return verdict("modified");
  }
  if (running.worktree && onDisk.worktree && running.worktree !== onDisk.worktree) {
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
 *
 * `record` and `onDisk` let a caller that already holds either one pass it in rather than pay for a
 * second read — `readBuildIdentity` spawns git, and a request-path caller reads both once. Both are
 * resolved lazily, so a verdict that needs neither (a dead pid) still costs nothing.
 */
export function buildDrift({
  appRoot,
  recordPath,
  serverRunning = false,
  isAlive = pidAlive,
  record = /** @type {any} */ (undefined),
  onDisk = /** @type {any} */ (undefined),
}) {
  const identity = () => onDisk ?? readBuildIdentity(appRoot);
  const found = record === undefined ? readBuildRecord(recordPath) : record;
  if (!found) return serverRunning ? { ...compareBuild(null, identity()), bootedAt: null } : null;
  if (!isAlive(found.pid)) return null;
  const verdict = compareBuild(found, identity());
  if (verdict.state === "current") return null;
  return { ...verdict, bootedAt: typeof found.bootedAt === "number" ? found.bootedAt : null };
}

/**
 * One build in operator-facing copy: `0.4.0 (a1b2c3d)`, or `0.4.0` where no commit names it.
 *
 * Uncommitted work is named too — `0.4.0 (a1b2c3d, uncommitted 9f2c1a4)` — because that is the one
 * drift where both sides otherwise print the same string, and a sentence claiming two identical
 * builds differ reads as a bug rather than as the restart it is asking for.
 *
 * @param {BuildIdentity|null|undefined} identity
 */
export function describeBuildIdentity(identity) {
  if (!identity || !identity.version) return "an unrecorded build";
  const parts = [];
  if (identity.revision) parts.push(identity.revision.slice(0, SHORT_SHA));
  if (identity.worktree && identity.worktree !== WORKTREE_CLEAN) {
    parts.push(`uncommitted ${identity.worktree.slice(0, SHORT_SHA)}`);
  }
  return parts.length ? `${identity.version} (${parts.join(", ")})` : identity.version;
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
