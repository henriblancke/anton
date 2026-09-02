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
import {
  closeSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, sep } from "node:path";

/** Short form of a commit sha in operator-facing copy — long enough to be unambiguous, short enough to read. */
const SHORT_SHA = 7;

/** The worktree digest for a checkout with nothing uncommitted. A literal, so it never reads as a hash. */
const WORKTREE_CLEAN = "clean";

/**
 * `revision` for a checkout git could not name a commit for — the `.git` is there, the read failed.
 * A literal, so it can never collide with a sha.
 *
 * Kept apart from `null` because the two absences mean opposite things (PR #217 review). A tarball
 * HAS no commit, so version alone is its whole identity and comparing it against itself is proof.
 * A checkout whose git read timed out, or whose `.git` was briefly unreadable, has a commit anton
 * simply could not see — and reading that silence as "no commit exists" lets `sameCheckout` accept
 * an artifact compiled from code that may already have moved, on both sides of the same failure.
 */
export const REVISION_UNREADABLE = "unreadable";

/**
 * Cap on one git read. A digest anton cannot compute degrades to "no evidence" (see `compareBuild`),
 * so the limit only has to be far above any plausible uncommitted diff.
 */
const GIT_MAX_BUFFER = 64 * 1024 * 1024;

/** Read size for hashing an untracked file — bounded, so an oversized one costs time and not memory. */
const READ_CHUNK = 64 * 1024;

/**
 * One build's identity — what a comparison here is between. Written to both stamps, so a record
 * left by an older anton legitimately carries no `worktree` at all.
 *
 * @typedef {object} BuildIdentity
 * @property {string|null} version
 * @property {string|null} revision the commit, `REVISION_UNREADABLE`, or null where there is none
 * @property {string|null} [worktree]
 * @property {string|null} [env]
 */

/**
 * One record per PROCESS — `server-build.<pid>.json`, beside anton.db, the one directory both the
 * server and the CLI resolve identically.
 *
 * Keyed by pid because a single install can be running more than one server: the production one
 * plus a UI-only `ANTON_RUNNER=off` server, or two ports across a hand-over. Under one shared
 * filename whichever booted LAST would speak for all of them — a server booting after a pull would
 * overwrite an older server's record, and every surface reading it would then compare the NEW
 * identity against the code on disk, find them equal, and call the older process current. That is
 * exactly the silence this module exists to end.
 *
 * So each process owns a record nothing else can overwrite: `buildRecordPath()` with no pid names
 * this process's own, and `listBuildRecords` is how an outside reader (`anton doctor`) sees them all.
 */
export const BUILD_RECORD_PREFIX = "server-build";

/** The record filename one pid writes. */
export function buildRecordFile(pid) {
  return `${BUILD_RECORD_PREFIX}.${pid}.json`;
}

const BUILD_RECORD_NAME = new RegExp(`^${BUILD_RECORD_PREFIX}\\.(\\d+)\\.json$`);

/** Where a running server records what it booted from — this process's record unless a pid is named. */
export function buildRecordPath(dbPath, pid = process.pid) {
  return join(dirname(dbPath), buildRecordFile(pid));
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
export function sameDirectory(a, b) {
  try {
    return realpathSync(a) === realpathSync(b);
  } catch {
    return false;
  }
}

/**
 * The commit `appRoot` ITSELF holds, `REVISION_UNREADABLE` when it is a checkout git could not read,
 * or null when it is not the root of a git checkout (every installed bundle — a release tarball
 * carries no .git, and its RELEASE_VERSION already identifies it exactly).
 *
 * The toplevel check is what makes that "itself": `git rev-parse` walks UP the tree until it finds
 * any repository, so a bundle installed under a git-tracked $HOME would otherwise report the
 * dotfiles repo's HEAD — an unrelated sha on both sides of the comparison, flipping to "modified"
 * and demanding a restart of a current server after every dotfile commit.
 */
function readRevision(appRoot) {
  const out = git(appRoot, ["rev-parse", "--show-toplevel", "HEAD"]);
  if (out === null) return unreadableOrAbsent(appRoot);
  const [top, sha] = out.trim().split("\n", 2);
  // 7..64 hex: a SHA-256 repository names HEAD in 64 characters, and rejecting those as malformed
  // would report every such checkout as a tarball with no commit at all.
  if (!top || !sha || !/^[0-9a-f]{7,64}$/.test(sha.trim())) return unreadableOrAbsent(appRoot);
  return sameDirectory(top.trim(), appRoot) ? sha.trim() : null;
}

/**
 * What a failed revision read MEANS: `REVISION_UNREADABLE` where `appRoot` holds a `.git` of its
 * own, else null.
 *
 * The `.git` entry answers the same question `readRevision`'s toplevel check does — is this
 * directory a checkout in its own right — without needing the git that just failed. A worktree's
 * `.git` is a file rather than a directory, hence lstat over any directory test.
 */
function unreadableOrAbsent(appRoot) {
  try {
    lstatSync(join(appRoot, ".git"));
    return REVISION_UNREADABLE;
  } catch {
    return null;
  }
}

/** The commit a read can actually name — an unreadable one is no evidence, not a different sha. */
function namedRevision(identity) {
  const revision = identity?.revision ?? null;
  return revision === REVISION_UNREADABLE ? null : revision;
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
 * nothing, null when git could not say or an input pulled in more than `MAX_LINKED_ENTRIES` (a
 * partial read of a tree is not an identity for it).
 *
 * The commit alone cannot answer "is the artifact stale?" in the loop anton is actually developed
 * in: edit a tracked file without committing and `.next` was compiled from code that no longer
 * exists, at the same version and the same HEAD. So the comparison has to reach past HEAD — and
 * name-and-status alone (`git status` on its own) is not enough either, because editing one file
 * twice reports "M src/x.ts" both times while the artifact falls a whole edit behind.
 *
 * Hence both reads: the diff (`--binary`, so a changed asset is content and not "Binary files
 * differ"; `--no-ext-diff` AND `--no-textconv`, because git documents the two conversions
 * separately and either one — an external driver or a `textconv` filter — can summarize the content
 * away and leave two different files diffing identically) for what tracked files now say, and the
 * untracked files, which no diff against HEAD can see — a new `page.tsx` changes the build while no
 * tracked file moves.
 *
 * Untracked files are digested by CONTENT, not by name: a listing is the same "?? page.tsx" however
 * many times that file is rewritten, which is the same edit-twice blindness the diff exists to close
 * on the tracked side. `git ls-files --others --exclude-standard` names them (honouring .gitignore,
 * so `.next` and node_modules never enter the digest) and this reads them — bounded chunks folded
 * into a per-file hash, so the fixed-width digest also frames path from content unambiguously.
 *
 * `--exclude-standard` hides one class of file the build DOES depend on, so `ignoredEnvFiles` names
 * that class back in, and the diff hides another, so `uncoveredTrackedLinks` names that one back.
 * Both read git, and a read git could not answer collapses the digest exactly as the two above do:
 * a digest missing an input vouches for a build compiled from something else (PR #217 review).
 */
function readWorktreeDigest(appRoot) {
  const listed = git(appRoot, ["ls-files", "--others", "--exclude-standard", "-z"]);
  if (listed === null) return null;
  const diff = git(appRoot, ["diff", "--binary", "--no-ext-diff", "--no-textconv", "HEAD"]);
  if (diff === null) return null;
  const links = uncoveredTrackedLinks(appRoot);
  if (links === null) return null;
  const envFiles = ignoredEnvFiles(appRoot);
  if (envFiles === null) return null;
  const inputs = [...listed.split("\0").filter(Boolean), ...envFiles, ...links];
  const files = [...new Set(inputs)].sort();
  if (!files.length && !diff) return WORKTREE_CLEAN;
  const digest = createHash("sha256").update(diff).update("\0");
  for (const path of files) {
    const entry = hashFile(join(appRoot, path));
    if (entry === null) return null;
    digest.update(path).update("\0").update(entry);
  }
  return digest.digest("hex").slice(0, 12);
}

/**
 * The TRACKED symlinks nothing else in the digest covers — build inputs the tracked diff cannot
 * see, and the untracked listing never names.
 *
 * A tracked link is committed as its link TEXT, so `git diff HEAD` compares the path it points at
 * and never the bytes at the end of it: a committed `linked.ts -> ../shared/lib.ts`, or a
 * force-added `.env.local`, leaves the worktree "clean" however often its target is rewritten
 * (PR #217 review). Next compiles through that link, so `anton start` would accept the previous
 * `.next` and serve the old target while every drift surface calls the server current — the same
 * blindness the untracked-symlink walk already closes, on the half of the tree git DOES track.
 *
 * A link resolving back INSIDE the checkout is dropped only once its target is PROVEN digested
 * where it stands (PR #217 review) — tracked targets by the diff, untracked ones by the listing —
 * because a third kind hides there: an IGNORED in-checkout target is in neither, so a committed
 * `linked.ts -> generated/shared.ts` under an ignored `generated/` would leave the worktree "clean"
 * however often those bytes change. `ignoredUnder` is that proof: nothing ignored at the target,
 * nothing to name back in. Proven ones are dropped because following them would hash the same bytes
 * twice — and a link to a whole source tree would drag every ignored file under it, `.next` and
 * node_modules included, past `MAX_LINKED_ENTRIES`, which collapses the digest and forces the
 * rebuild rather than vouching for a partial read. A link resolving nowhere counts as uncovered,
 * which keeps its text in the digest.
 *
 * `ls-files -s` is the only listing that reports MODE, and mode 120000 is git's symlink. A read git
 * could not answer collapses the digest rather than returning a partial input set, for the reason
 * the walk cap does: a digest missing an input vouches for a build compiled from something else.
 */
function uncoveredTrackedLinks(appRoot) {
  const listed = git(appRoot, ["ls-files", "-s", "-z"]);
  if (listed === null) return null;
  let root;
  try {
    root = realpathSync(appRoot);
  } catch {
    return null;
  }
  const links = listed
    .split("\0")
    .filter((entry) => entry.startsWith("120000 "))
    .map((entry) => entry.slice(entry.indexOf("\t") + 1));
  const uncovered = [];
  for (const path of links) {
    const inside = resolvedInside(root, join(appRoot, path));
    if (inside === null) {
      uncovered.push(path);
      continue;
    }
    const hidden = ignoredUnder(appRoot, [inside === "" ? "." : `:(literal)${inside}`]);
    if (hidden === null) return null;
    if (hidden.length) uncovered.push(path);
  }
  return uncovered;
}

/**
 * Where under `root` does `path` lead — as a root-relative path, or null when it leads out.
 *
 * The relative form is what git can be asked about: a pathspec is how the caller proves the target
 * is already an input. A link leading nowhere leads out, and the empty string means the root itself.
 */
function resolvedInside(root, path) {
  try {
    const target = realpathSync(path);
    if (target === root) return "";
    return target.startsWith(root + sep) ? target.slice(root.length + sep.length) : null;
  } catch {
    return null;
  }
}

/** The ignored paths git hides at `pathspecs` — the build inputs `--exclude-standard` leaves out. */
function ignoredUnder(appRoot, pathspecs) {
  const listed = git(appRoot, ["ls-files", "--others", "--ignored", "--exclude-standard", "-z", "--", ...pathspecs]);
  return listed === null ? null : listed.split("\0").filter(Boolean);
}

/**
 * The IGNORED env files Next compiles into the artifact, named back into the digest that
 * `--exclude-standard` just hid.
 *
 * `.env*` is gitignored here (and by the template Next ships), so the untracked listing never sees
 * it — yet Next reads `.env`, `.env.local` and `.env.<mode>` at BUILD time and inlines every
 * `NEXT_PUBLIC_*` value into the bundle. Change one and the compiled build serves a value the
 * checkout no longer holds while both digests still match: `anton start` accepts the stale `.next`
 * and every drift surface calls the server current.
 *
 * Asked for by name rather than by un-ignoring everything but `.next`/node_modules: anton.db, .dolt
 * and the session logs all live under the app root and are all ignored too, and folding those in
 * would re-digest the tree on every write — a permanent "restart the server" banner. Top level
 * only, because that is the only place Next looks; tracked env files are left to the diff.
 *
 * A read git could not answer is null, not an empty list (PR #217 review): the two say opposite
 * things. Empty means "no env file here", and a digest that treats a timed-out or lock-blocked git
 * as that would hash an `.env.local` edit into the same digest as the unedited file — `anton start`
 * reusing a `.next` compiled from the old value, the staleness this function exists to prevent.
 */
function ignoredEnvFiles(appRoot) {
  return ignoredUnder(appRoot, [".env", ".env.*"]);
}

/**
 * Ceiling on the entries one listed path can pull in through a directory symlink. Nothing bounds
 * what a link points AT — `shared -> ~/work` would walk a whole home directory on every read, and
 * unlike the checkout itself that tree carries no .gitignore anton can honour. A linked SOURCE
 * directory (the shape Next actually compiles through) fits inside the cap many times over.
 *
 * Hitting it abandons the digest rather than truncating it (PR #217 review): a walk that stopped at
 * a lexicographic cutoff hashes the same bytes however the entries past that point change, so an
 * edit behind the cutoff would leave the identity identical and `buildMatchesCheckout` would reuse
 * a `.next` compiled from the old contents. Unreadable is the honest answer — it forces the
 * rebuild, where a truncated digest silently vouches for a stale one.
 */
export const MAX_LINKED_ENTRIES = 4096;

/**
 * One listed build input as a fixed-width digest — its contents, or a whole tree's when the input
 * is a link to one. Null only when the walk ran past `MAX_LINKED_ENTRIES` and so read part of a
 * tree; an input that cannot be read (it vanished between the listing and the read) is still
 * counted as present under its path, so the marker keeps the digest defined rather than collapsing
 * the whole worktree read.
 *
 * A symlink is BOTH its target path and what stands at the end of it: `.env.local` pointing at a
 * shared secrets file is the common shape here, and Next inlines what that file holds at build
 * time — so hashing the link alone would call the build current after the secrets behind it moved.
 * The link text stays in the digest because repointing it is a change too.
 *
 * A link to a DIRECTORY is followed for the same reason (PR #217 review). `git ls-files --others`
 * reports it as one path and never descends, so hashing the link text alone leaves every file under
 * it invisible: Next compiles imports through a linked source directory, and an edit under an
 * unchanged target would leave the digest identical — `anton start` would then reuse the old `.next`
 * and every drift surface would call that server current.
 */
function hashFile(path) {
  const budget = { left: MAX_LINKED_ENTRIES, seen: new Set(), truncated: false };
  const digest = hashEntry(path, budget);
  return budget.truncated ? null : digest;
}

/** One entry — file, directory, or link to either — under a walk budget shared with its children. */
function hashEntry(path, budget) {
  const hash = createHash("sha256");
  try {
    let entry = lstatSync(path);
    if (entry.isSymbolicLink()) {
      hash.update(readlinkSync(path)).update("\0");
      entry = statSync(path);
    }
    if (entry.isDirectory()) hashTree(hash, path, budget);
    else if (entry.isFile()) hashContents(hash, path);
  } catch {
    return hash.update("\0unreadable").digest();
  }
  return hash.digest();
}

/**
 * Every entry under `dir`, in a fixed order so the digest is a function of the tree and not of
 * readdir's.
 *
 * Cycles are what a followed link makes possible — a directory linking back to its own ancestor
 * would recurse forever — so each directory is entered once per walk, keyed by its resolved path.
 */
function hashTree(hash, dir, budget) {
  const resolved = realpathSync(dir);
  if (budget.seen.has(resolved)) {
    hash.update("\0cycle");
    return;
  }
  budget.seen.add(resolved);
  for (const name of readdirSync(dir).sort()) {
    if (budget.left <= 0) {
      budget.truncated = true;
      return;
    }
    budget.left -= 1;
    hash.update(name).update("\0").update(hashEntry(join(dir, name), budget));
  }
}

/** One file's bytes, folded in as bounded chunks so an oversized input costs time and not memory. */
function hashContents(hash, path) {
  const fd = openSync(path, "r");
  try {
    const buf = Buffer.allocUnsafe(READ_CHUNK);
    for (let n = 0; (n = readSync(fd, buf, 0, READ_CHUNK, null)) > 0; ) hash.update(buf.subarray(0, n));
  } finally {
    closeSync(fd);
  }
}

/** The prefix Next inlines from the BUILD's environment into the bundle it compiles. */
const INLINED_ENV_PREFIX = "NEXT_PUBLIC_";

/**
 * A digest of the build-time environment values Next compiles in — null when none are set.
 *
 * `ignoredEnvFiles` closes this hole on the FILE side only, and a `.env` file is not the only place
 * Next reads an inlined value from: `NEXT_PUBLIC_API_URL=x anton start` puts it straight in the
 * build's environment, and Next inlines it just the same. Without it in the identity, re-running
 * with a different value finds a stamp that still matches the checkout, reuses the `.next` compiled
 * from the OLD value, and every drift surface calls that server current (PR #217 review).
 *
 * The prefix is the whole scope, deliberately: it is the one class of variable Next documents as
 * compiled into the artifact, and it is stable per shell. Digesting the environment wholesale would
 * fold in `PWD`, `TERM` and every per-invocation variable, and rebuild on each one.
 *
 * `\0` frames name from value because neither can contain one, so no pair of variables can digest
 * into the same bytes as another.
 */
function readEnvDigest(env) {
  const names = Object.keys(env)
    .filter((name) => name.startsWith(INLINED_ENV_PREFIX) && env[name] !== undefined)
    .sort();
  if (!names.length) return null;
  const digest = createHash("sha256");
  for (const name of names) digest.update(name).update("\0").update(env[name]).update("\0");
  return digest.digest("hex").slice(0, 12);
}

/**
 * What the code at `appRoot` IS right now: `{ version, revision, worktree, env }` (any may be null).
 *
 * The worktree digest is read only where a revision was: `readRevision`'s toplevel check is what
 * proves `appRoot` is its own checkout, and without it a bundle unpacked in a git-tracked $HOME
 * would wear that repo's uncommitted dotfile edits. The env digest carries no such condition — it
 * is a read of this process's own environment, which is exactly the environment `anton start` hands
 * the `next build` it spawns (`runLocal` inherits it).
 *
 * @param {string} appRoot
 * @param {Record<string, string|undefined>} [env] the environment a build from this process compiles with
 * @returns {BuildIdentity}
 */
export function readBuildIdentity(appRoot, env = process.env) {
  const revision = readRevision(appRoot);
  return {
    version: readVersion(appRoot),
    revision,
    worktree: revision && revision !== REVISION_UNREADABLE ? readWorktreeDigest(appRoot) : null,
    env: readEnvDigest(env),
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
 * `startedAt` is the pid's birth stamp, written so a LATER reader can tell this process from an
 * unrelated one the OS handed the same pid after it exited (see `recordAlive`).
 *
 * `appRoot` is the install the process booted FROM, written so a reader can tell whose server a
 * record describes (see `recordFromInstall`) — the directory is not implied by where the record
 * sits, since `ANTON_DB` can point two checkouts at one database.
 *
 * @param {string} path
 * @param {BuildIdentity} identity
 * @param {{pid?: number, bootedAt?: number, startedAt?: string|null, appRoot?: string|null}} [stamp]
 */
export function writeBuildRecord(
  path,
  identity,
  { pid = process.pid, bootedAt = Date.now(), startedAt = processStartedAt(pid), appRoot = null } = {},
) {
  return writeStampFile(path, { ...identity, pid, bootedAt, startedAt, appRoot });
}

/**
 * Was this record written by a server of the install at `appRoot`?
 *
 * Records live beside anton.db, and that database is not per-checkout: `ANTON_DB` deliberately
 * points a runner and an `ANTON_RUNNER=off` UI — or two worktrees — at one file. Without this every
 * reader compares a NEIGHBOUR's running build against its own code on disk and prints a stale or
 * current verdict about a checkout the operator is not standing in (PR #217).
 *
 * A record carrying no `appRoot` (one written before this field existed) still answers for whoever
 * reads it: an absence is not evidence, the same rule `compareBuild` follows field by field.
 *
 * Paths are compared resolved, then literally. `anton update` deletes the runtime dir a server
 * booted from, so requiring a resolvable path would drop precisely the record whose install moved
 * under it — the drift this module exists to report.
 *
 * @param {{[key: string]: unknown}|null|undefined} record
 * @param {string} appRoot
 */
export function recordFromInstall(record, appRoot) {
  const declared = record?.appRoot;
  if (!declared || typeof declared !== "string") return true;
  return declared === appRoot || sameDirectory(declared, appRoot);
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

/**
 * Every well-formed record beside `dbPath`, oldest boot first — what an OUTSIDE reader sees when an
 * install is running more than one server. Each carries the path it was read from, so a caller that
 * finds one dead can drop it.
 *
 * A record whose filename and `pid` field disagree is skipped rather than trusted: the name is what
 * makes a record this process's own, so one that does not match its contents names nothing.
 *
 * Records of OTHER installs sharing this database are returned too — `recordFromInstall` is that
 * judgement, and it belongs to the caller: a reader must drop them, while the prune below must see
 * every dead record beside the database, whoever left it.
 */
export function listBuildRecords(dbPath) {
  const dir = dirname(dbPath);
  let names;
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const out = [];
  for (const name of names) {
    const match = BUILD_RECORD_NAME.exec(name);
    if (!match) continue;
    const path = join(dir, name);
    const record = readBuildRecord(path);
    if (record && record.pid === Number(match[1])) out.push({ path, record });
  }
  return out.sort((a, b) => (a.record.bootedAt ?? 0) - (b.record.bootedAt ?? 0));
}

/**
 * Delete the records of servers that are no longer running. Called at boot, so a machine that
 * restarts its server all day does not accumulate one file per boot forever — and never at read
 * time, where deleting the evidence a concurrent reader is mid-way through would be a race.
 *
 * Best-effort by construction: a record anton cannot delete is one every reader already ignores.
 */
export function pruneBuildRecords(dbPath, isAlive = recordAlive) {
  for (const { path, record } of listBuildRecords(dbPath)) {
    if (isAlive(record)) continue;
    try {
      unlinkSync(path);
    } catch {}
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
  return provesSameCheckout(stamp, onDisk);
}

/**
 * Does the stamp inside `.next` PROVE it was compiled from the code on disk?
 *
 * `sameCheckout` is the whole comparison; this adds the one requirement a STAMP carries that two
 * live reads do not — a build that could not name its own version identifies nothing, so it cannot
 * vouch for an artifact. (Two live reads that both come up null are one unidentifiable checkout
 * compared against itself, which is still worth starting; a stamp is a claim about the past.)
 *
 * @param {BuildIdentity} stamp
 * @param {BuildIdentity} onDisk
 */
function provesSameCheckout(stamp, onDisk) {
  if (!stamp.version || !onDisk.version) return false;
  return sameCheckout(stamp, onDisk);
}

/** Does this pid name a live process? Signal 0 is the existence check every pidfile reader uses. */
function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * The environment `ps` formats the birth stamp under — fixed, so the stamp is a function of the
 * process and not of the shell that asked. `TZ` pins the clock, `LC_ALL` the month and day names.
 */
const BIRTH_STAMP_ENV = { TZ: "UTC", LC_ALL: "C" };

/**
 * When the process holding `pid` was born, as an opaque stamp — null when this machine cannot say.
 *
 * A pid is not an identity: the OS reuses the number, and a record left by a server that exited
 * days ago names whatever took it. The birth time is what separates the two, and it is stable for
 * the life of a process, so comparing the stamp a record carries with the one the pid wears NOW
 * turns "some process exists" into "that process is still running".
 *
 * procfs first (no spawn, and the field is the kernel's own value in clock ticks since boot), then
 * `ps -o lstart=`, which macOS and procps both support. Neither is required: a platform that
 * answers with neither degrades to the bare pid check, which is where this started.
 *
 * The `ps` fallback is read under a FIXED locale and time zone (PR #217 review). `lstart` is a
 * formatted date, not a token: the same live process prints `Wed Sep  2 07:16:57 2026` to a shell
 * in Europe/Brussels and `11:16:57` to one in UTC, in German month names under `LC_TIME=de_DE`.
 * Comparing a daemon's stamp against one read from a differently-configured shell would then say
 * "different process" about the process itself — `runningPid` would delete a live server's pidfile
 * and `recordAlive` would reject its record, letting a second daemon start over a first anton can
 * no longer stop.
 */
export function processStartedAt(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try {
    // Field 22 of /proc/<pid>/stat, counted past the comm field — which is parenthesised and may
    // itself contain spaces, so the split has to start after its closing paren.
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const started = stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19];
    if (/^\d+$/.test(started ?? "")) return started;
  } catch {}
  const r = spawnSync("ps", ["-o", "lstart=", "-p", String(pid)], {
    encoding: "utf8",
    timeout: 5000,
    env: { ...process.env, ...BIRTH_STAMP_ENV },
  });
  const out = r.status === 0 && !r.error ? (r.stdout ?? "").trim() : "";
  return out || null;
}

/**
 * Is the process that wrote this record still the one running? The liveness test every reader here
 * uses, in place of the bare pid check.
 *
 * A record outlives the server that wrote it — nothing deletes it at exit, and a crash could not —
 * so "the pid is alive" alone reports a stopped server as running the moment the OS reuses its
 * number, which on a busy machine is hours. Doctor would then either vouch for a build nothing is
 * serving or demand a restart of a server that is already down, and in bundle mode the leftover
 * would also stand in for the daemon pidfile and stop the real liveness check from ever running.
 *
 * A record with no birth stamp (one this machine could not read at boot) still counts as alive on
 * the pid alone: an absence is not evidence, and the pid check is exactly as good as it ever was.
 */
export function recordAlive(record, startedAt = processStartedAt) {
  if (!record || !pidAlive(record.pid)) return false;
  if (!record.startedAt) return true;
  const now = startedAt(record.pid);
  return now === null || now === record.startedAt;
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
 * A revision anton could not READ (`REVISION_UNREADABLE`) is no evidence either, and is normalised
 * away rather than compared: a git call that timed out on one side of the comparison is not a
 * different commit, and reporting it as "modified" would demand a restart that changes nothing.
 * Freshness is where an unreadable commit has to block — see `sameCheckout`.
 *
 * The worktree digest follows the same rule and needs it more: a record written before this field
 * existed carries none, and calling that "modified" would demand one restart of every install on
 * the upgrade that introduced it.
 *
 * The env digest is not compared at all, though both sides carry one. A verdict is read from
 * OUTSIDE the running server — `anton doctor` in whatever shell the operator is standing in — and
 * that shell's `NEXT_PUBLIC_*` values are not a fact about the code on disk. Comparing them would
 * report drift whenever doctor runs in a different shell from the one that started the server, and
 * print two identical build strings as the evidence. Freshness is where the env belongs, and
 * `sameCheckout` reads it there: `anton start` compares the stamp against its OWN environment,
 * which is the environment its `next build` would compile with.
 *
 * @param {BuildIdentity|null|undefined} running
 * @param {BuildIdentity} onDisk
 */
export function compareBuild(running, onDisk) {
  const verdict = (state) => ({ state, running: running ?? null, onDisk });
  if (!running || !running.version) return verdict("unstamped");
  if (onDisk.version && running.version !== onDisk.version) return verdict("outdated");
  const ranAt = namedRevision(running);
  const onDiskAt = namedRevision(onDisk);
  if (ranAt && onDiskAt && ranAt !== onDiskAt) return verdict("modified");
  if (running.worktree && onDisk.worktree && running.worktree !== onDisk.worktree) {
    return verdict("modified");
  }
  return verdict("current");
}

/**
 * Are two reads of the same checkout the same code? What `anton start` asks after `next build`
 * returns, to prove the tree did not move while it was compiling — an edit saved mid-build lands in
 * `.next` only if Next had not read that file yet, so the artifact belongs to a checkout that no
 * longer exists.
 *
 * This is the freshness question, and it takes the opposite of `compareBuild`'s answer to a missing
 * field. A drift VERDICT reads an absence as "no evidence" and stays quiet, because inventing a
 * restart out of one would nag every bundle install forever. Freshness has to prove a negative
 * instead, so an absence here is only "unchanged" when it is SYMMETRIC:
 *
 * - A field one read named and the other could not is a failed read, not agreement — the git call
 *   timed out, or an edit made during the compile pushed the diff past GIT_MAX_BUFFER. Accepting
 *   that silence would stamp the artifact with the PRE-build identity and start a server serving
 *   code that edit may never have reached, the exact staleness this file exists to catch.
 * - A checkout git CAN name a commit for must also name what it holds past that commit, or the one
 *   field an uncommitted edit moves is the one nothing read. Two failed digest reads in a row agree
 *   with each other and still prove nothing.
 * - A commit NEITHER read could name (`REVISION_UNREADABLE` — git timed out, `.git` was briefly
 *   unreadable) is the same trap one step earlier: two failures agree, and the tarball rule below
 *   would then accept the artifact on version alone while an edit made during the compile goes
 *   unseen — and every later start under the same failure reuses that `.next`.
 *
 * Either way `ensureFreshBuild` builds again and, if the reads never resolve, refuses to start —
 * which is the honest end, since nothing can then say what `.next` holds. A checkout with no git at
 * all (a source tarball) names neither field on either side and stays a version comparison, as it
 * always was.
 *
 * The env digest is compared here and NOWHERE else, because freshness is the only question it
 * answers. A stamp carrying none (written before the field existed) against a process with no
 * `NEXT_PUBLIC_*` set is two absences that agree — the common case, so the field costs no install a
 * rebuild on the upgrade that introduced it — while a stamp with none against an environment that
 * now sets one is a build that cannot be shown to hold that value, and is compiled again.
 *
 * @param {BuildIdentity} a
 * @param {BuildIdentity} b
 */
export function sameCheckout(a, b) {
  const agree = (x, y) => (x ?? null) === (y ?? null);
  if (
    !agree(a.version, b.version) ||
    !agree(a.revision, b.revision) ||
    !agree(a.worktree, b.worktree) ||
    !agree(a.env, b.env)
  ) {
    return false;
  }
  if (a.revision === REVISION_UNREADABLE || b.revision === REVISION_UNREADABLE) return false;
  return !b.revision || (b.worktree ?? null) !== null;
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
 * A record whose process is gone is a stopped server's leftover: silent, which is what makes a
 * restart the only action needed to clear any verdict here. Gone means `recordAlive` — the pid
 * alone would keep vouching for the record after the OS handed that number to something else.
 *
 * `record` and `onDisk` let a caller that already holds either one pass it in rather than pay for a
 * second read — `readBuildIdentity` spawns git, and a request-path caller reads both once. Both are
 * resolved lazily, so a verdict that needs neither (a dead pid) still costs nothing.
 */
export function buildDrift({
  appRoot,
  recordPath,
  serverRunning = false,
  isAlive = recordAlive,
  record = /** @type {any} */ (undefined),
  onDisk = /** @type {any} */ (undefined),
}) {
  const identity = () => onDisk ?? readBuildIdentity(appRoot);
  const found = record === undefined ? readBuildRecord(recordPath) : record;
  if (!found) return serverRunning ? { ...compareBuild(null, identity()), bootedAt: null } : null;
  if (!isAlive(found)) return null;
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
  const revision = namedRevision(identity);
  if (revision) parts.push(revision.slice(0, SHORT_SHA));
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
