/**
 * Build drift (anton-pzfb) — how anton tells that the PROCESS it is running is not the code that is
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
 *   "unstamped" — something is running that recorded no identity (a build predating this file, an
 *                 artifact no `anton start` stamped, or a record anton could not write). What it is
 *                 running cannot be established.
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
import { basename, dirname, join, resolve, sep } from "node:path";

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
 * @property {string|null} [source] the source digest of an install no git can describe
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

/**
 * Is `appRoot` an installed release bundle rather than a source install? Keyed on the same
 * `RELEASE_VERSION` marker the launcher is (bin/anton.mjs), so the two agree on what an install is.
 *
 * It is the line that decides who may be identified by VERSION alone: `ensureFreshBuild` exempts a
 * bundle from the rebuild-and-stamp every source install goes through, so a bundle legitimately
 * serves a `.next` no stamp names — while an unstamped source build is one nothing can identify.
 */
export function isBundleInstall(appRoot) {
  try {
    return statSync(join(appRoot, "RELEASE_VERSION")).isFile();
  } catch {
    return false;
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
 * or null when it holds no commit to name — it is not the root of a git checkout (every installed
 * bundle — a release tarball carries no .git, and its RELEASE_VERSION already identifies it
 * exactly), or it is one whose first commit has yet to be made (see `unbornHead`).
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
 * Is `dir` a checkout in its own right? The `.git` entry answers the same question
 * `readRevision`'s toplevel check does, without needing a git that may just have failed. A linked
 * worktree's and a submodule's `.git` is a FILE rather than a directory, hence lstat over any
 * directory test.
 */
function isCheckout(dir) {
  try {
    lstatSync(join(dir, ".git"));
    return true;
  } catch {
    return false;
  }
}

/**
 * Is `appRoot` a checkout git reads perfectly well that simply has no commit yet? `git init` with
 * nothing committed leaves HEAD pointing at a branch that does not exist, and `rev-parse HEAD`
 * fails on it exactly as a corrupt repository does.
 *
 * The two have to be told apart (PR #217 review). Read as unreadable, a fresh checkout gets no
 * revision, no worktree digest and — because that field is read only where there is no commit at
 * all — no source digest either, so `sameCheckout` rejects its own pre/post-build identities and
 * `anton start` rebuilds three times and then refuses to start.
 *
 * A symbolic HEAD that resolves to nothing is what makes it unborn rather than broken: a git that
 * cannot read the repository fails both reads, and a detached HEAD is not symbolic.
 */
function unbornHead(appRoot) {
  const top = git(appRoot, ["rev-parse", "--show-toplevel"]);
  if (top === null || !sameDirectory(top.trim(), appRoot)) return false;
  return (
    git(appRoot, ["symbolic-ref", "--quiet", "HEAD"]) !== null &&
    git(appRoot, ["rev-parse", "--verify", "--quiet", "HEAD"]) === null
  );
}

/**
 * What a failed revision read MEANS: null where there is no commit to name — no `.git` of its own,
 * or a checkout whose first commit has yet to be made — and `REVISION_UNREADABLE` where there is
 * one this git could not read.
 */
function unreadableOrAbsent(appRoot) {
  if (!isCheckout(appRoot)) return null;
  return unbornHead(appRoot) ? null : REVISION_UNREADABLE;
}

/** The commit a read can actually name — an unreadable one is no evidence, not a different sha. */
function namedRevision(identity) {
  const revision = identity?.revision ?? null;
  return revision === REVISION_UNREADABLE ? null : revision;
}

/** One git read at `appRoot`: its stdout, or null when git failed, timed out, or ran away. */
function git(appRoot, args, input) {
  const r = spawnSync("git", ["-C", appRoot, ...args], {
    encoding: "utf8",
    input,
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
 * that class back in; the diff hides three more — what a tracked link points at, the bytes git
 * canonicalizes (a clean filter, the `ident` attribute, line-ending normalization) before it ever
 * compares them, and the paths an index flag tells git not to look at on disk at all — so
 * `uncoveredTrackedLinks`, `convertedTrackedPaths` and `hiddenTrackedPaths` name those back; and it
 * flattens a fifth to a single line, so `submoduleDigests` reads those worktrees itself. All of them
 * read git, and a read git could not answer collapses the digest exactly as the two above do: a
 * digest missing an input vouches for a build compiled from something else (PR #217 review).
 *
 * Every OTHER ignored file stays out, and that is this digest's deliberate edge: an ignored
 * generated module the build imports moves the artifact without moving the digest (PR #217 review).
 * Naming the ignored tree back in costs more than it buys — `ignoredEnvFiles` lists the state files
 * that would then re-digest the tree on every write, and `.DS_Store`, which macOS rewrites whenever
 * a folder is opened, would do it from outside anton entirely. A restart banner with no release
 * behind it is one nobody reads, which is the failure this whole module exists to end. A generated
 * build input belongs in the tree or behind a tracked link — both of which this already digests.
 *
 * `--ignore-submodules=none` because that flattened line is the only record of a submodule moving to
 * a different commit, and either repository's config (`diff.ignoreSubmodules`,
 * `submodule.<name>.ignore`) can otherwise suppress it.
 */
function readWorktreeDigest(appRoot) {
  const listed = git(appRoot, ["ls-files", "--others", "--exclude-standard", "-z"]);
  if (listed === null) return null;
  const diff = git(appRoot, ["diff", "--binary", "--no-ext-diff", "--no-textconv", "--ignore-submodules=none", "HEAD"]);
  if (diff === null) return null;
  const tracked = git(appRoot, ["ls-files", "-s", "-z"]);
  if (tracked === null) return null;
  const links = uncoveredTrackedLinks(appRoot, trackedPaths(tracked, SYMLINK_MODE));
  if (links === null) return null;
  const converted = convertedTrackedPaths(appRoot, trackedPaths(tracked, ...FILE_MODES));
  if (converted === null) return null;
  const envFiles = ignoredEnvFiles(appRoot);
  if (envFiles === null) return null;
  const submodules = submoduleDigests(appRoot, trackedPaths(tracked, GITLINK_MODE));
  if (submodules === null) return null;
  const hidden = hiddenTrackedPaths(appRoot);
  if (hidden === null) return null;
  const inputs = [...listed.split("\0").filter(Boolean), ...envFiles, ...links, ...converted, ...hidden];
  const files = [...new Set(inputs)].sort();
  if (!files.length && !diff && !submodules.length) return WORKTREE_CLEAN;
  const digest = createHash("sha256").update(diff).update("\0");
  for (const path of files) {
    const entry = hashFile(join(appRoot, path));
    if (entry === null) return null;
    digest.update(path).update("\0").update(entry);
  }
  for (const [path, worktree] of submodules) digest.update(path).update("\0").update(worktree).update("\0");
  return digest.digest("hex").slice(0, 12);
}

/** git's mode for a symlink, and for a submodule — the two `ls-files -s` reports and no read shows. */
const SYMLINK_MODE = "120000 ";
const GITLINK_MODE = "160000 ";

/** git's modes for a regular file — the only entries git runs a content conversion over. */
const FILE_MODES = ["100644 ", "100755 "];

/** The paths `ls-files -s` reported at any of `modes`, in the order git listed them (sorted by path). */
function trackedPaths(listed, ...modes) {
  return listed
    .split("\0")
    .filter((entry) => modes.some((mode) => entry.startsWith(mode)))
    .map((entry) => entry.slice(entry.indexOf("\t") + 1));
}

/**
 * The tracked files git CANONICALIZES on the way into the diff, named back into the digest by
 * CONTENT — the last class of tracked input `git diff HEAD` cannot vouch for (PR #217 review).
 *
 * Three conversions put one there, and `--no-ext-diff` / `--no-textconv` reach none of them, since
 * all happen before diff time rather than during it:
 *
 * `filter` — git documents a clean command as converting worktree contents to their canonical
 * repository form, and the diff compares that OUTPUT on both sides. So a lossy driver — a stripper,
 * a redactor, anything that summarizes — reports no change however often the file is rewritten,
 * while Next compiles the raw bytes on disk.
 *
 * `ident` — git documents check-in as rewriting an expanded `$Id: <sha> $` back to the bare `$Id$`,
 * so every worktree byte between those markers is canonicalized away too: two files differing only
 * there diff identically and leave the worktree `WORKTREE_CLEAN`, while Next reads what is actually
 * on disk (PR #217 review).
 *
 * `text`/`eol` — git documents the `text` attribute as normalizing line endings in the index, and
 * `core.autocrlf` asks for the same normalization on every path no attribute speaks for. The diff
 * therefore compares NORMALIZED content: rewriting a tracked file from LF to CRLF leaves it empty
 * and the worktree `WORKTREE_CLEAN`, while the raw bytes the build reads did move (PR #217 review).
 *
 * Only paths a CONFIGURED filter driver converts count. `filter=x` with neither a `filter.x.clean`
 * command nor a `filter.x.process` one leaves the bytes alone, so the diff already covers them — and
 * re-reading every tracked file in a repo that merely declares the attribute would hash the whole
 * tree for nothing. `ident` needs no such check: it is a built-in conversion, set is set. Line-ending
 * normalization is the one that legitimately DOES reach the whole tree — `* text=auto` and
 * `core.autocrlf` really do put a conversion in front of every tracked file, and a digest that skips
 * them vouches for bytes it never read. Regular files only, for the same reason as ever: git runs
 * none of the three over a symlink or a gitlink, both of which the digest already covers on their
 * own terms.
 */
function convertedTrackedPaths(appRoot, paths) {
  if (!paths.length) return [];
  const config = conversionConfig(appRoot);
  if (config === null) return null;
  const attrs = git(appRoot, ["check-attr", "--stdin", "-z", "filter", "ident", "text", "eol"], paths.join("\0"));
  if (attrs === null) return null;
  // `<path>\0<attribute>\0<value>` per path per attribute, in the order the attributes were asked
  // for: the attribute's setting, or "unspecified"/"unset"/"set" where it carries no value of its own.
  const fields = attrs.split("\0");
  const settings = new Map();
  for (let i = 0; i + 2 < fields.length; i += 3) {
    const [path, attribute, value] = fields.slice(i, i + 3);
    const values = settings.get(path) ?? {};
    values[attribute] = value;
    settings.set(path, values);
  }
  const converted = [];
  for (const [path, values] of settings) {
    const canonicalized =
      config.drivers.has(values.filter) || values.ident === "set" || normalizesEol(values, config.autocrlf);
    if (canonicalized) converted.push(path);
  }
  return converted;
}

/**
 * Whether git normalizes THIS path's line endings on the way into the diff.
 *
 * `-text` is the one setting that refuses the conversion outright; `text` and `text=auto` ask for it;
 * and a path no attribute speaks for takes `core.autocrlf`, which git documents as the same
 * normalization by config. An `eol` value marks a path as text where nothing else does.
 *
 * `text=auto` skips a file git detects as binary and this does not, deliberately: over-including one
 * path costs a read, while excluding one vouches for bytes nobody compared.
 */
function normalizesEol({ text, eol }, autocrlf) {
  if (text === "unset") return false;
  if (text === "set" || text === "auto") return true;
  return eol === "crlf" || eol === "lf" || autocrlf;
}

/**
 * The two config settings that put a conversion in front of the diff — the filter drivers this repo
 * has configured a command for, and whether `core.autocrlf` normalizes line endings. Read from the
 * merged config, because either can just as well come from the user's global file as from the
 * checkout's own.
 *
 * A long-running `filter.<driver>.process` counts alongside `filter.<driver>.clean`: git asks the
 * process filter for its `clean` capability and diffs that canonicalized output, so a lossy
 * process-only driver — the shape git-lfs and its kind ship — hides a rewritten file exactly as a
 * `clean` command does, and matching only `.clean` would omit those paths from the digest and let
 * `buildMatchesCheckout` accept a stale artifact (PR #217 review).
 *
 * `core.autocrlf` is read the way git reads a boolean that also takes `input`: every spelling but a
 * false one converts something, so an unfamiliar value hashes more rather than vouching for less.
 */
function conversionConfig(appRoot) {
  const listed = git(appRoot, ["config", "--list", "-z"]);
  if (listed === null) return null;
  const drivers = new Set();
  let autocrlf = false;
  for (const record of listed.split("\0")) {
    // `<key>\n<value>`, or the key alone where it was set without one — which git reads as true.
    const split = record.indexOf("\n");
    const key = split === -1 ? record : record.slice(0, split);
    const driver = /^filter\.(.+)\.(?:clean|process)$/.exec(key);
    if (driver) drivers.add(driver[1]);
    // Later records win, exactly as git resolves the same key set in two files.
    if (key === "core.autocrlf") autocrlf = split === -1 || !GIT_FALSE.has(record.slice(split + 1).toLowerCase());
  }
  return { drivers, autocrlf };
}

/** How git spells a false boolean — every other spelling of `core.autocrlf` converts something. */
const GIT_FALSE = new Set(["false", "no", "off", "0", ""]);

/**
 * The tracked paths an INDEX FLAG hides from the diff, named back into the digest by CONTENT — the
 * class of tracked input `git diff HEAD` never even looks on disk for (PR #217 review).
 *
 * `git update-index --assume-unchanged` and `--skip-worktree` both tell git to trust the index over
 * the worktree, and git documents both as suppressing the normal worktree inspection the diff
 * stands on — sparse checkout sets the second on every path it leaves out. So a flagged file
 * reports no change however often it is rewritten, and `anton start` would reuse a `.next` compiled
 * before the edit while every drift surface calls the server current.
 *
 * `ls-files -v` is the listing that reports those flags: `S` for skip-worktree, and the entry's tag
 * lowercased for assume-unchanged. A flagged path that is not on disk — the sparse-checkout shape —
 * folds in the absence marker `hashFile` returns rather than collapsing the read, so such a
 * checkout stays provable and still moves the digest if the file appears.
 */
function hiddenTrackedPaths(appRoot) {
  const listed = git(appRoot, ["ls-files", "-v", "-z"]);
  if (listed === null) return null;
  const hidden = [];
  for (const entry of listed.split("\0")) {
    // `<tag><space><path>`, and an unflagged tag is uppercase.
    const path = entry.slice(2);
    const tag = entry[0];
    if (path && (tag === SKIP_WORKTREE_TAG || tag !== tag.toUpperCase())) hidden.push(path);
  }
  return hidden;
}

/** `ls-files -v`'s tag for skip-worktree — the one flag it does not report by lowercasing the tag. */
const SKIP_WORKTREE_TAG = "S";

/**
 * What each DIRTY submodule worktree holds that its own HEAD does not, as `[path, digest]` pairs —
 * the build inputs the parent's diff flattens to one line — plus a marker for every gitlink with no
 * worktree at all. A clean, checked-out one contributes nothing, so a checkout whose submodules are
 * all present and committed still reads `WORKTREE_CLEAN`.
 *
 * A submodule is a gitlink: `git diff HEAD` in the parent compares the COMMIT it points at and
 * summarizes everything uncommitted inside it as the suffix `-dirty` (PR #217 review). So a source
 * checkout that compiles through a submodule — the vendored-package shape — reports the identical
 * line however often a file in there is rewritten, and `buildMatchesCheckout` reuses a `.next`
 * compiled from the previous contents while every drift surface calls the server current: the same
 * edit-twice blindness the untracked listing and the tracked-link walk close elsewhere.
 *
 * Each worktree is read the way this checkout is, recursively, rather than through
 * `--submodule=diff`: the recursion covers what the parent's inline diff would (tracked edits) plus
 * what it would still only NAME — untracked files, ignored `.env` files, links leading out — and it
 * reaches a submodule nested inside a submodule on the same terms. The parent's own diff already
 * carries the commit each one points at, so nothing is hashed twice.
 *
 * An uninitialized submodule has nothing to read — `git -C` inside that empty directory would walk
 * up and answer for the PARENT repository instead — so it is named by the marker `SUBMODULE_ABSENT`
 * rather than skipped (PR #217 review). Deinitializing a clean submodule moves neither the gitlink
 * nor the parent's diff, so skipping it made "checked out" and "gone from disk" the same digest, and
 * `buildMatchesCheckout` would reuse a `.next` compiled through source no longer on the machine.
 * Marking only the absent state keeps the ordinary checkout — every submodule present and committed
 * — reading `WORKTREE_CLEAN`.
 */
function submoduleDigests(appRoot, paths) {
  const digests = [];
  for (const path of paths) {
    const root = join(appRoot, path);
    if (!isCheckout(root)) {
      digests.push([path, SUBMODULE_ABSENT]);
      continue;
    }
    const worktree = readWorktreeDigest(root);
    if (worktree === null) return null;
    if (worktree !== WORKTREE_CLEAN) digests.push([path, worktree]);
  }
  return digests;
}

/** What a gitlink with no worktree hashes as — no digest can collide, they are 12 hex characters. */
const SUBMODULE_ABSENT = "absent";

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
 * `links` comes from `ls-files -s`, the only listing that reports MODE, which the caller reads once
 * for both the symlinks here and the gitlinks `submoduleDigests` needs. A read git could not answer
 * collapses the digest rather than returning a partial input set, for the reason the walk cap does:
 * a digest missing an input vouches for a build compiled from something else.
 */
function uncoveredTrackedLinks(appRoot, links) {
  let root;
  try {
    root = realpathSync(appRoot);
  } catch {
    return null;
  }
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
 * it — yet `next build` reads `BUILD_ENV_FILES` and inlines every `NEXT_PUBLIC_*` value into the
 * bundle. Change one and the compiled build serves a value the checkout no longer holds while both
 * digests still match: `anton start` accepts the stale `.next` and every drift surface calls the
 * server current.
 *
 * Asked for by name rather than by un-ignoring everything but `.next`/node_modules: anton.db, .dolt
 * and the session logs all live under the app root and are all ignored too, and folding those in
 * would re-digest the tree on every write — a permanent "restart the server" banner. Top level
 * only, because that is the only place Next looks; tracked env files are left to the diff.
 *
 * The PRODUCTION files only, not `.env.*` wholesale (PR #217 review) — the same list
 * `skipsSourceEntry` names back into a git-less install's digest, so both shapes weigh the same
 * inputs. `anton start` compiles in production mode, where Next never loads `.env.development` or
 * `.env.test`; digesting them reported the running server modified and rebuilt it for
 * configuration the artifact cannot contain.
 *
 * A read git could not answer is null, not an empty list (PR #217 review): the two say opposite
 * things. Empty means "no env file here", and a digest that treats a timed-out or lock-blocked git
 * as that would hash an `.env.local` edit into the same digest as the unedited file — `anton start`
 * reusing a `.next` compiled from the old value, the staleness this function exists to prevent.
 */
function ignoredEnvFiles(appRoot) {
  return ignoredUnder(
    appRoot,
    BUILD_ENV_FILES.map((file) => `:(literal)${file}`),
  );
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

/**
 * One entry — file, directory, or link to either — under a walk budget shared with its children.
 *
 * The TYPE goes in ahead of the contents (PR #217 review), because contents alone do not tell two
 * kinds of entry apart: an empty file and an empty directory both fold in nothing, so a `config`
 * that becomes `config/` under a linked source tree would digest identically while Next compiles
 * something else entirely — and `buildMatchesCheckout` would hand back the old `.next`.
 */
function hashEntry(path, budget, depth = 0) {
  const hash = createHash("sha256");
  try {
    let entry = lstatSync(path);
    if (entry.isSymbolicLink()) {
      hash.update(readlinkSync(path)).update("\0");
      entry = statSync(path);
    }
    if (entry.isDirectory()) {
      hash.update("\0dir");
      hashTree(hash, path, budget, depth);
    } else if (entry.isFile()) {
      hash.update("\0file");
      hashContents(hash, path);
    } else {
      // A socket, fifo or device node has no contents a build reads — its being there is the fact.
      hash.update("\0other");
    }
  } catch {
    return hash.update("\0unreadable").digest();
  }
  return hash.digest();
}

/**
 * Every entry under `dir`, in a fixed order so the digest is a function of the tree and not of
 * readdir's. `budget.skip` names the entries a walk never enters (see `readSourceDigest`); a walk
 * with none set reads everything. It is asked with the entry's DEPTH — 0 for the entries of the
 * directory the walk started from — because the names a build writes and the names it compiles
 * overlap: `build/` at the root is output, while `src/lib/build/` is source (PR #217 review).
 *
 * It is asked with the RESOLVED directory too, because the state a running anton writes is placed
 * by configuration rather than by convention: `ANTON_DB` may name any directory in the tree, and
 * only the containing path tells that database from a source file of the same name (PR #217 review).
 *
 * Cycles are what a followed link makes possible — a directory linking back to its own ancestor
 * would recurse forever — so each directory is entered once per walk, keyed by its resolved path.
 */
function hashTree(hash, dir, budget, depth = 0) {
  const resolved = realpathSync(dir);
  if (budget.seen.has(resolved)) {
    hash.update("\0cycle");
    return;
  }
  budget.seen.add(resolved);
  for (const name of readdirSync(dir).sort()) {
    if (budget.skip?.(name, depth, resolved)) continue;
    if (budget.left <= 0) {
      budget.truncated = true;
      return;
    }
    budget.left -= 1;
    hash.update(name).update("\0").update(hashEntry(join(dir, name), budget, depth + 1));
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

/**
 * Ceiling on a source walk. Larger than `MAX_LINKED_ENTRIES` because this one is a whole
 * application rather than one linked input, and it collapses the same way for the same reason: an
 * install anton could only read part of is one it rebuilds, never one it vouches for.
 */
export const MAX_SOURCE_ENTRIES = 16384;

/**
 * What a source walk never enters AT THE ROOT: build output, and the state a running anton writes
 * beside its own code. Every one of these is in .gitignore as well — this is that list applied by
 * hand, because the installs needing this digest are the ones with no git to apply it for them.
 *
 * Root-level, not by name at any depth (PR #217 review). These names are output only where a build
 * puts them; further down they are ordinary source. This repo compiles `src/lib/build/` — including
 * these very modules — so excluding every directory called `build` left an edit to them invisible,
 * and a git-less install could serve a `.next` compiled before it.
 */
const OUTPUT_AT_ROOT = new Set(["coverage", "out", "build", "dist"]);

/**
 * The env files `next build` loads in production — the mode `anton start` compiles in. Each one
 * reaches the artifact twice: as the bytes Next inlines from, and as the names of build-ENVIRONMENT
 * variables its values expand.
 */
const BUILD_ENV_FILES = [".env.production.local", ".env.local", ".env.production", ".env"];

/**
 * What no walk enters at ANY depth, dot-named because that is what these are. `.git` is rewritten by
 * every git command — and a vendored submodule carries one of its own, well below the root — `.next`
 * names build output wherever a build puts it, and `.DS_Store` is written by a Finder window
 * anywhere at all. A digest reading one of them would move on its own.
 */
const STATE_AT_ANY_DEPTH = new Set([".git", ".next", ".DS_Store"]);

/**
 * The dot-named state a running anton and its toolchain rewrite beside the code, named one by one
 * rather than skipped as "every root dot-entry" (PR #217 review). Each is written by something other
 * than an edit — the board's database on every `bd` command, `.anton`/`.stringer` on every run,
 * `.claude` on every agent session (and it holds whole isolation worktrees), the tool caches on
 * every build — so a digest reading them would move without the source moving.
 *
 * A dot-name that is NOT on this list is ordinary source: `.build-flavor.mjs` imported by
 * `next.config.mjs`, `.github/`, `.husky/`, `.product/`. The blanket skip hid every one of them, so
 * editing one left `readBuildIdentity().source` unchanged and `buildMatchesCheckout` reused a
 * `.next` compiled from the previous configuration. A checkout has no such hole — those files are
 * tracked, so the worktree digest reads them — and this is what matches a git-less install to it.
 */
const STATE_AT_ROOT = new Set([
  ".anton",
  ".beads",
  ".beads-credential-key",
  ".dolt",
  ".stringer",
  ".claude",
  ".vercel",
  ".turbo",
  ".swc",
  ".cache",
  ".eslintcache",
]);

/**
 * Is this entry outside the source a build compiles from? `depth` is 0 for the entries of the
 * install root itself.
 *
 * State is skipped by NAME and at the ROOT (PR #217 review). Both halves were once broader and both
 * hid real build inputs: excluding a name at every depth made an edit to this repo's own
 * `src/lib/build/` invisible, and excluding every root dot-entry hid a config's `./.build-flavor.mjs`
 * and its `.github/` alike. What a running anton rewrites is dot-named AND lives at the install root,
 * which is exactly what `STATE_AT_ROOT` lists; a dot-named directory below it is source (this repo
 * ships `skills/setup/templates/.product` itself).
 *
 * `.env*` is the one family still skipped wholesale at the root, minus the files a production build
 * LOADS, which are named back in (PR #217 review). `readEnvDigest` carries those too, but that field
 * answers freshness only — `compareBuild` never weighs it, because its other half is the reading
 * shell's own environment. So a git-less install editing `.env.local` under a running server moved
 * nothing a VERDICT reads: the dot-skip hid the file from `source`, and both doctor and the health
 * page called the server current while a `NEXT_PUBLIC_*` value it no longer holds stayed live in the
 * served bundle. A checkout never had that hole — `ignoredEnvFiles` folds the same files into the
 * worktree digest, which is compared — so naming them here is what makes a git-less install's
 * evidence match. The other `.env.<mode>` files reach no production build at all, and hold
 * per-developer values that would rebuild it for nothing.
 *
 * `node_modules` is skipped at every depth for the same reason as the state above: nested ones hold
 * dependencies too, and a dependency is never the source this install is judged on. What anton
 * itself writes — the database, its per-process build records — lands beside the install root by
 * DEFAULT, so it is excluded there and nowhere else. Where configuration moves it (`ANTON_DB` naming
 * a subdirectory), `runtimeStatePaths` excludes it wherever it actually resolves; these fixed names
 * cannot, since only the containing path tells that state from source (PR #217 review).
 */
function skipsSourceEntry(name, depth) {
  if (depth === 0 && BUILD_ENV_FILES.includes(name)) return false;
  return (
    name === "node_modules" ||
    name.endsWith(".tsbuildinfo") ||
    STATE_AT_ANY_DEPTH.has(name) ||
    (depth === 0 &&
      (STATE_AT_ROOT.has(name) ||
        name.startsWith(".env") ||
        OUTPUT_AT_ROOT.has(name) ||
        isDatabaseEntry(name, DEFAULT_DB_NAME) ||
        BUILD_RECORD_NAME.test(name)))
  );
}

/** Where `bundleStateEnv` puts the database when nothing has moved it. */
const DEFAULT_DB_NAME = "anton.db";

/** What SQLite writes beside a database file. Everything else sharing that prefix is somebody's source. */
const SQLITE_SIDECARS = ["-wal", "-shm", "-journal"];

/**
 * Is this entry the database or one of its sidecars? Matched by NAME, never by prefix (PR #217
 * review): a prefix test also swallowed a sibling `anton.db-client.ts`, and a build input excluded
 * from `source` is one whose edit moves no digest — leaving `buildMatchesCheckout` to hand back a
 * `.next` compiled before it.
 */
function isDatabaseEntry(entry, name) {
  return entry === name || SQLITE_SIDECARS.some((suffix) => entry === name + suffix);
}

/**
 * The runtime state a running anton writes INSIDE the install, when configuration puts it there —
 * a map from resolved directory to the predicates naming the entries under it a source walk skips.
 *
 * `skipsSourceEntry` can only exclude state at the ROOT, because that is the only place its names
 * are fixed. Every one of these paths is an operator's choice: `ANTON_DB=state/anton.db` on a
 * git-less source install puts the database — and the per-process `server-build.<pid>.json` records
 * `buildRecordPath` writes beside it — one level down, where the root rule never looks. The server
 * writes its record at boot and every job writes the database, so the digest moved within seconds of
 * the stamp it is compared against: doctor and the health page reported the running server modified
 * forever, and every later `anton start` rebuilt an artifact that was already current (PR #217
 * review). The sessions and scans roots are the same choice — `bundleStateEnv` redirects all three
 * together — and churn the same way when they are pointed into the tree.
 *
 * Relative values resolve against `appRoot`, exactly as `antonDbOverride` resolves them, so both
 * readers name one file. Registration does NOT depend on the directory existing yet, and the
 * DIRECTORIES between the install root and a configured path are reported alongside the predicates
 * (PR #217 review). A path one level down that nothing has created — `ANTON_SESSIONS_ROOT=var/
 * sessions` on a fresh install — used to register nothing at all; the first run then created the
 * whole hierarchy, and while the leaf was excluded from that point on, its brand-new PARENT entered
 * the digest and reported the running server modified. `holdsOnlyState` is what closes that: an
 * ancestor holding nothing a walk reads weighs the same whether or not it is there.
 *
 * Each predicate is registered under the directory's lexical path AND its resolved one, because the
 * walk asks with whatever `realpathSync` gave it: the lexical key is the one that survives a
 * directory that does not exist yet, and the resolved key is the one that matches when a link in
 * the tree points state somewhere else.
 */
function runtimeStatePaths(appRoot, env) {
  const byDir = new Map();
  const ancestors = new Set();
  let root;
  try {
    root = realpathSync(appRoot);
  } catch {
    return { byDir, ancestors };
  }
  const exclude = (configured, matches) => {
    const path = resolve(root, configured);
    // State an operator put OUTSIDE the install is state no source walk ever reaches.
    if (!path.startsWith(root + sep)) return;
    const dir = dirname(path);
    const name = basename(path);
    for (const key of pathKeys(dir)) {
      const existing = byDir.get(key);
      if (existing) existing.push((entry) => matches(entry, name));
      else byDir.set(key, [(entry) => matches(entry, name)]);
    }
    for (let at = dir; at !== root; at = dirname(at)) for (const key of pathKeys(at)) ancestors.add(key);
  };

  // The database, the sidecars SQLite writes beside it, and the build records that share its
  // directory — the one place `listBuildRecords` looks.
  if (env?.ANTON_DB) {
    exclude(env.ANTON_DB, (entry, name) => isDatabaseEntry(entry, name) || BUILD_RECORD_NAME.test(entry));
  }
  for (const key of ["ANTON_SESSIONS_ROOT", "ANTON_SCANS_ROOT"]) {
    if (env?.[key]) exclude(env[key], (entry, name) => entry === name);
  }
  return { byDir, ancestors };
}

/** A directory as both readers of it spell it: lexically, and resolved — where it exists to resolve. */
function pathKeys(dir) {
  const keys = new Set([dir]);
  try {
    keys.add(realpathSync(dir));
  } catch {}
  return keys;
}

/**
 * What a source walk skips for this install: the fixed root names, plus whatever runtime state the
 * environment has placed inside the tree.
 */
function sourceSkip(appRoot, env) {
  const { byDir, ancestors } = runtimeStatePaths(appRoot, env);
  if (byDir.size === 0) return skipsSourceEntry;
  const skip = (name, depth, dir) => {
    if (skipsSourceEntry(name, depth)) return true;
    const matchers = byDir.get(dir);
    if (matchers !== undefined && matchers.some((matches) => matches(name))) return true;
    const path = join(dir, name);
    return ancestors.has(path) && holdsOnlyState(path, skip, depth + 1);
  };
  return skip;
}

/**
 * Does this directory on the way to a configured state path hold nothing a source walk reads?
 *
 * Only then is it skipped, so an ancestor weighs the same before and after a run creates it — which
 * is the whole point — while the same directory holding real source stays an input. `ANTON_DB=state/
 * anton.db` beside a `state/schema.ts` is exactly that: the database and its sidecars are skipped,
 * the module is not, and `state` therefore counts.
 *
 * An empty directory holds nothing either, so it reads the same as one that is not there yet.
 * Unreadable is not "nothing" — a directory a walk cannot list is one whose contents cannot be
 * vouched for, and `readSourceDigest` folds that in as the fact it is.
 */
function holdsOnlyState(dir, skip, depth) {
  try {
    const resolved = realpathSync(dir);
    return readdirSync(dir).every((entry) => skip(entry, depth, resolved));
  } catch {
    return false;
  }
}

/**
 * A digest of the source an install with no git holds — null when the tree could not be walked in
 * full.
 *
 * `readWorktreeDigest` is how anton sees an edit nobody committed, and it needs a commit to diff
 * against. An install with no `.git` — an extracted source tarball, or the `npm i -g anton` the
 * README documents, which builds locally too — has none, so version was its whole identity: editing
 * any ordinary source file left both sides identical, `buildMatchesCheckout` accepted the previous
 * `.next`, and `anton start` served the code the operator had just replaced (PR #217 review).
 *
 * Only that shape pays for the walk. A checkout has git for this, and a release bundle is exempt
 * from the rebuild entirely — its RELEASE_VERSION identifies it exactly, and it ships no toolchain
 * to compile with.
 */
function readSourceDigest(appRoot, env = process.env) {
  const budget = { left: MAX_SOURCE_ENTRIES, seen: new Set(), truncated: false, skip: sourceSkip(appRoot, env) };
  const digest = createHash("sha256");
  try {
    hashTree(digest, appRoot, budget);
  } catch {
    return null;
  }
  return budget.truncated ? null : digest.digest("hex").slice(0, 12);
}

/** The prefix Next inlines from the BUILD's environment into the bundle it compiles. */
const INLINED_ENV_PREFIX = "NEXT_PUBLIC_";

/**
 * One expansion in an env-file value: `$NAME` or `${NAME}`, unless the `$` is escaped.
 *
 * The single-character lookbehind is the one `@next/env`'s bundled expander uses itself
 * (`(?!(?<=\\))\$`), so this names a variable exactly when the build expands one: a `$` behind a
 * backslash expands nothing there either, however many backslashes precede it (PR #217 review).
 */
const ENV_EXPANSION = /(?<!\\)\$\{?([A-Za-z_][A-Za-z0-9_]*)/g;

/**
 * The config files Next loads a build's configuration from (`CONFIG_FILES`, next 16). `.cjs`/`.cts`
 * are deliberately absent: Next refuses to start on them. Every one present is read, rather than
 * only the one Next resolves first — a sibling naming a variable this build ignores costs at most a
 * rebuild, while guessing the resolution order wrong costs the value.
 */
const NEXT_CONFIG_FILES = ["next.config.js", "next.config.mjs", "next.config.ts", "next.config.mts"];

/**
 * How `process.env` itself is spelled — the source every read below hangs off, with the optional
 * chain `process?.env` spelled too (PR #217 review): it is valid, it compiles the same value in, and
 * a pattern stopping at the `?` records nothing for it.
 */
const PROCESS_ENV = String.raw`process\s*\??\.\s*env`;

/** A quoted key, in any of the three string delimiters: the `["NAME"]` half of an env read. */
const QUOTED_KEY = "[\"'`]([^\"'`]+)[\"'`]";

/**
 * One read off `source`: `source.NAME` or `source["NAME"]`, each in its optional-chained spelling
 * too — `source?.NAME`, `source?.["NAME"]` (PR #217 review). Reading a variable through `?.` has the
 * same build-time effect as reading it directly, so a name it spells has to be recorded the same.
 */
const envRead = (source) =>
  new RegExp(`${source}\\s*(?:\\??\\.\\s*([A-Za-z_$][\\w$]*)|(?:\\?\\.)?\\s*\\[\\s*${QUOTED_KEY}\\s*\\])`, "g");

/**
 * The bindings of a destructured read — `const { BUILD_FLAVOR } = process.env` — which names a
 * variable without ever spelling `process.env.NAME` (PR #217 review). Everything up to the `=` is
 * captured and the names picked out of it separately, since a binding may be renamed, defaulted or
 * quoted.
 *
 * The trailing guard is `(?![\w$])` rather than `\b`, because an alias may END in `$` (`const env$ =
 * process.env`) and `\b` after a `$` demands a word character follow it — the read would match
 * nothing (PR #217 review).
 */
const envDestructure = (source) =>
  new RegExp(String.raw`\{([^{}]*)\}\s*(?::[^=]+)?=\s*${source}(?![\w$])`, "g");

/**
 * A local standing in for the whole environment — `const env = process.env` — through which
 * `env.BUILD_FLAVOR` names a variable no pattern anchored on `process.env` can see (PR #217 review).
 * The binding's own name is captured and the reads above are run against it too, so an alias costs
 * one extra pass rather than a blind spot.
 */
const ENV_ALIAS = new RegExp(
  String.raw`(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*${PROCESS_ENV}\b`,
  "g",
);

/**
 * One captured alias, as a pattern the reads above can be anchored on: its `$`s escaped, behind a
 * lookbehind rather than a `\b` — a `$` is not a word character, so `\b$env` would match nothing
 * even escaped, while the lookbehind still refuses a match inside a longer identifier.
 */
const aliasSource = (alias) => String.raw`(?<![\w$])` + alias.replaceAll("$", () => String.raw`\$`);

/**
 * One bound name in that pattern: whatever sits in KEY position — at the start or after a comma —
 * as `NAME`, `NAME: alias`, `NAME = fallback` or `"NAME": alias`.
 *
 * A `...rest` binding matches nothing, deliberately: it reads the whole environment, which no set of
 * names can stand for. A default value holding a comma (`{ A = f(x, y) }`) names one variable too
 * many, which costs a rebuild only if this environment happens to set it — the trade every other
 * read here makes.
 */
const DESTRUCTURED_KEY = /(?:^|,)\s*(?:["'`]([^"'`]+)["'`]|([A-Za-z_$][\w$]*))/g;

/**
 * The build-environment variables the NEXT CONFIG reads — the third route a value takes into the
 * artifact (PR #217 review).
 *
 * `next.config.ts` is ordinary JavaScript that runs at build time, so `env: { FLAVOR:
 * process.env.BUILD_FLAVOR }` or a webpack branch behind `process.env.ANALYZE` compiles a different
 * artifact from the same files. Neither digest moved for it: the config's bytes are unchanged, and
 * the variable wears no `NEXT_PUBLIC_` prefix and appears in no env file. The stamp compared equal
 * and `anton start` reused the `.next` holding the previous configuration.
 *
 * Names only, read off the config's own text — the caller folds in just those this environment
 * SETS, and the config's bytes are digested by the worktree (or source) read. What a config reads
 * through an imported module stays invisible, so this narrows the hole rather than closing it: a
 * build input the digest cannot see belongs in the config file or behind a variable named there.
 */
function configEnvNames(appRoot) {
  const names = new Set();
  for (const file of NEXT_CONFIG_FILES) {
    try {
      envNamesIn(readFileSync(join(appRoot, file), "utf8"), names);
    } catch {}
  }
  return names;
}

/** Every build-environment variable one file's text names, folded into `names`. */
function envNamesIn(text, names) {
  // A JavaScript identifier may contain `$`, which is a regex anchor — `const $env = process.env`
  // interpolated raw compiles a pattern matching nothing, and the reads through that alias go
  // unrecorded (PR #217 review). `$` is the only metacharacter the capture admits.
  const aliases = [...text.matchAll(ENV_ALIAS)].map(([, alias]) => aliasSource(alias));
  for (const source of [PROCESS_ENV, ...aliases]) {
    for (const [, dotted, indexed] of text.matchAll(envRead(source))) names.add(dotted ?? indexed);
    for (const [, bindings] of text.matchAll(envDestructure(source)))
      for (const [, quoted, bare] of bindings.matchAll(DESTRUCTURED_KEY)) names.add(quoted ?? bare);
  }
  return names;
}

/** Where Next resolves the App Router tree from — one of the two wins, and reading both costs nothing. */
const APP_DIRECTORIES = ["app", "src/app"];

/** The modules Next evaluates from that tree: a route file is JavaScript or TypeScript, never `.cjs`. */
const ROUTE_SOURCE = /\.(?:m?[jt]sx?)$/;

/**
 * `env` for a build environment anton could only read PART of — the route scan ran past its ceiling,
 * so some build-evaluated route file went unread. A literal, so it can never collide with a digest.
 *
 * Kept apart from every real value for the reason `REVISION_UNREADABLE` is: two partial reads agree
 * with each other and prove nothing, so `sameCheckout` refuses this one on either side rather than
 * let a scan that stopped early vouch for an artifact.
 */
export const ENV_UNPROVABLE = "unprovable";

/**
 * Ceiling on the route-tree scan. Generous against any real app dir, since the walk reads text
 * rather than hashing it and a route tree is a fraction of a source tree.
 *
 * Hitting it abandons the environment digest rather than truncating it (PR #217 review), exactly as
 * `MAX_LINKED_ENTRIES` abandons a worktree read: a scan that stopped at a cutoff names the same
 * variables however the routes past it change, so a statically generated page reading
 * `BUILD_FLAVOR` beyond the cutoff would leave the digest identical and `buildMatchesCheckout` would
 * hand back the `.next` compiled with the previous value. `ENV_UNPROVABLE` is the honest answer — it
 * forces the rebuild, where a partial scan silently vouches for a stale build.
 */
export const MAX_ROUTE_ENTRIES = 4096;

/**
 * The build-environment variables the ROUTE TREE reads — the fourth route a value takes into the
 * artifact (PR #217 review).
 *
 * Static generation EXECUTES application code: a prerendered Server Component or a
 * `generateStaticParams` reading `process.env.BUILD_FLAVOR` bakes that value into the prerendered
 * HTML and RSC payload. Nothing else here sees it — the variable wears no `NEXT_PUBLIC_` prefix,
 * appears in no env file and is named in no config — so the stamp compared equal and
 * `buildMatchesCheckout` reused a `.next` holding the previous value.
 *
 * Scoped to the route tree, and deliberately not to the modules it imports. Every module a route
 * imports is build-evaluated too, so the import closure is the theoretically correct set — and
 * following it is what makes this digest unusable (PR #217 review). Measured on this checkout, 99
 * route files reach 525 modules, and the variables those modules name include `PATH`, `USER`,
 * `NAME`, `NODE_ENV`, `ANTON_DB`, `ANTON_STATE_DIR`, `ANTON_OPERATOR` and `ANTON_MAX_CONCURRENT` —
 * routes import the same libraries the server runs on, and those read the environment at RUNTIME.
 * Every one of them holds a different value in a different shell, and `sameCheckout` compares this
 * digest against the stamp: `PATH` alone would run a full `next build` on every start from a shell
 * that loaded a different toolchain, and a runner beside an `ANTON_RUNNER=off` UI would rebuild over
 * each other's `.next` forever.
 *
 * So this narrows the hole the way `configEnvNames` does rather than closing it, and what stays open
 * is named: a statically rendered page importing a module that reads `process.env.BUILD_FLAVOR`
 * moves no digest, so changing only `BUILD_FLAVOR` reuses the prerendered output. A build input this
 * digest can see belongs in a route file, the config, or behind a variable named in one.
 *
 * A symlinked directory is not entered — `isDirectory()` is false for the link itself — which is
 * also what keeps the walk acyclic.
 */
function routeEnvNames(appRoot) {
  const names = new Set();
  const budget = { left: MAX_ROUTE_ENTRIES, truncated: false };
  for (const dir of APP_DIRECTORIES) walkRoutes(join(appRoot, dir), budget, names);
  return { names, truncated: budget.truncated };
}

function walkRoutes(dir, budget, names) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (budget.left <= 0) {
      budget.truncated = true;
      return;
    }
    budget.left -= 1;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== "node_modules") walkRoutes(path, budget, names);
    } else if (entry.isFile() && ROUTE_SOURCE.test(entry.name)) {
      try {
        envNamesIn(readFileSync(path, "utf8"), names);
      } catch {}
    }
  }
}

/** The env files present at `appRoot`, as `[file, contents]` pairs — read once for both their routes. */
function readEnvFiles(appRoot) {
  const files = [];
  for (const file of BUILD_ENV_FILES) {
    try {
      files.push([file, readFileSync(join(appRoot, file), "utf8")]);
    } catch {}
  }
  return files;
}

/**
 * The build-environment variables the loaded env files EXPAND — the second route a value Next
 * inlines takes into the artifact (PR #217 review).
 *
 * `NEXT_PUBLIC_API_URL=$API_HOST` in `.env.local` compiles the value of `API_HOST` into the bundle,
 * and neither digest moves when that value does: the file's bytes are unchanged, and `API_HOST`
 * wears no `NEXT_PUBLIC_` prefix. `anton start` accepts the previous stamp and serves the old URL.
 *
 * Every reference is named, not only those in public assignments: dotenv expands transitively
 * (`NEXT_PUBLIC_URL=$API_HOST` over `API_HOST=$REGION_HOST`), and a `$` inside single quotes expands
 * nothing at all. Both are over-inclusive by the width of one name, and the caller folds in only
 * names this environment actually SETS — a rebuild too many costs one build, while a missed one
 * serves a value the checkout no longer holds.
 */
function expandedEnvNames(files) {
  const names = new Set();
  for (const [, text] of files) {
    for (const [, name] of text.matchAll(ENV_EXPANSION)) names.add(name);
  }
  return names;
}

/**
 * A digest of everything Next compiles in from the build's environment: the env FILES it loads and
 * the values of the process environment that reach the artifact — null when there is neither.
 *
 * Both halves, because either alone leaves a hole. `NEXT_PUBLIC_API_URL=x anton start` puts a value
 * straight in the build's environment where no file holds it; and the files' own bytes reach no
 * other digest on every install shape — `readWorktreeDigest` (through `ignoredEnvFiles`) reads them
 * only where git can answer, `readSourceDigest` only where there is no git at all, and a checkout
 * whose git read failed has neither. So a tarball editing `.env.local` from `NEXT_PUBLIC_URL=old` to
 * `=new` left both identities identical, and `anton start` reused the `.next` holding the old
 * inlined value (PR #217 review).
 *
 * Freshness is all this field answers, though — `compareBuild` cannot weigh it, since the
 * environment half belongs to whatever shell is reading. The file half is mirrored into those two
 * digests for exactly that reason, which is what lets a drift VERDICT see an env-file edit too.
 *
 * The environment half stays scoped to the prefix plus whatever the files expand into one and
 * whatever the Next config or the route tree reads: those are the variables that reach the artifact,
 * and they are stable per shell. Digesting the environment wholesale would fold in `PWD`, `TERM` and every
 * per-invocation variable, and rebuild on each one.
 *
 * A `\0`-framed tag leads each entry because no path, name or value can contain one — so no pair of
 * files or variables can digest into the same bytes as another, and a file cannot digest as a
 * variable that happens to spell its name.
 *
 * A route scan that ran past its ceiling answers `ENV_UNPROVABLE` instead of a digest of the part it
 * managed to read: the names it did not reach are exactly the ones a partial answer would hide.
 */
function readEnvDigest(env, appRoot) {
  // A scan that stopped at its ceiling read an unknown part of the route tree, so no set of names
  // stands for this environment and no digest built from one may be compared (see MAX_ROUTE_ENTRIES).
  const routes = routeEnvNames(appRoot);
  if (routes.truncated) return ENV_UNPROVABLE;
  const files = readEnvFiles(appRoot);
  const inlined = new Set(Object.keys(env).filter((name) => name.startsWith(INLINED_ENV_PREFIX)));
  for (const name of expandedEnvNames(files)) inlined.add(name);
  for (const name of configEnvNames(appRoot)) inlined.add(name);
  for (const name of routes.names) inlined.add(name);
  const names = [...inlined].filter((name) => env[name] !== undefined).sort();
  if (!names.length && !files.length) return null;
  const digest = createHash("sha256");
  for (const [file, text] of files) digest.update("\0file\0").update(file).update("\0").update(text);
  for (const name of names) digest.update("\0var\0").update(name).update("\0").update(env[name]);
  return digest.digest("hex").slice(0, 12);
}

/**
 * What the code at `appRoot` IS right now: `{ version, revision, worktree, source, env }` (any may
 * be null).
 *
 * The worktree digest is read only where a revision was: `readRevision`'s toplevel check is what
 * proves `appRoot` is its own checkout, and without it a bundle unpacked in a git-tracked $HOME
 * would wear that repo's uncommitted dotfile edits. The source digest is its mirror image, read
 * only where there is no commit AND no bundle marker — the one install shape nothing else can
 * describe. The two never both stand: git is the better read wherever there is one.
 *
 * The env digest carries no such condition, and must not: it reads the env files directly plus this
 * process's own environment — exactly the environment `anton start` hands the `next build` it spawns
 * (`runLocal` inherits it) — so it is the only thing that sees an inlined value move on an install
 * whose files did not.
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
    source: revision === null && !isBundleInstall(appRoot) ? readSourceDigest(appRoot, env) : null,
    env: readEnvDigest(env, appRoot),
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
 * `runner` is whether THIS process executes the scheduled jobs (`ANTON_RUNNER` is not `off`), written
 * because that is the whole consequence of the drift: a stale runner runs the nightlies from old
 * code, while a stale `ANTON_RUNNER=off` UI beside it only draws an old page (PR #217 review). A
 * record written before this field existed carries null — unknown, which no reader may read as
 * either answer.
 *
 * @param {string} path
 * @param {BuildIdentity} identity
 * @param {{pid?: number, bootedAt?: number, startedAt?: string|null, appRoot?: string|null, runner?: boolean|null}} [stamp]
 */
export function writeBuildRecord(
  path,
  identity,
  {
    pid = process.pid,
    bootedAt = Date.now(),
    startedAt = processStartedAt(pid),
    appRoot = null,
    runner = null,
  } = {},
) {
  return writeStampFile(path, { ...identity, pid, bootedAt, startedAt, appRoot, runner });
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
 * Every server of THIS install that is still up — the set any reader reporting on "the running
 * anton" has to start from, shared so doctor and the health page cannot answer differently.
 *
 * Two filters, both load-bearing: `recordFromInstall` drops a neighbouring checkout sharing this
 * database, and `recordAlive` drops the leftover of a server that has since exited. What remains is
 * every process the operator would have to restart, which on an install running a runner beside an
 * `ANTON_RUNNER=off` UI is more than one.
 *
 * @param {string} dbPath
 * @param {string} appRoot
 * @param {(record: {[key: string]: unknown}) => boolean} [isAlive]
 */
export function liveBuildRecords(dbPath, appRoot, isAlive = recordAlive) {
  return listBuildRecords(dbPath).filter(({ record }) => recordFromInstall(record, appRoot) && isAlive(record));
}

/**
 * Delete the records of servers that are no longer running. Called at boot, so a machine that
 * restarts its server all day does not accumulate one file per boot forever — and never at read
 * time, where deleting the evidence a concurrent reader is mid-way through would be a race.
 *
 * Only a record PROVEN stale is deleted, never merely one that could not be verified: a birth-time
 * read that fails this second says nothing about the server, and deleting its record would strand a
 * live process no later read could name (see `recordVerdict`).
 *
 * Best-effort by construction: a record anton cannot delete is one every reader already ignores.
 *
 * @param {string} dbPath
 * @param {(record: {[key: string]: unknown}) => {alive: boolean, stale: boolean}} [verdict]
 */
export function pruneBuildRecords(dbPath, verdict = recordVerdict) {
  for (const { path, record } of listBuildRecords(dbPath)) {
    if (!verdict(record).stale) continue;
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
 *
 * Each stamp is PREFIXED with the reader that produced it (PR #217 review), because the two readers
 * speak different languages: procfs answers `4212345` clock ticks since boot, `ps` a formatted date.
 * A daemon stamped from procfs whose `/proc/<pid>/stat` read later fails — a remounted procfs,
 * `hidepid` — falls through to `ps` here, and an untagged comparison would read the two spellings of
 * the SAME birth time as proof of pid reuse: the live daemon's pidfile deleted, `update` and
 * `uninstall --purge` free to move the runtime under a server still serving from it. The tag makes
 * that case answerable as what it is — not comparable, hence unproven (see `birthStampVerdict`).
 */
export function processStartedAt(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try {
    // Field 22 of /proc/<pid>/stat, counted past the comm field — which is parenthesised and may
    // itself contain spaces, so the split has to start after its closing paren.
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const started = stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19];
    if (/^\d+$/.test(started ?? "")) return `proc:${started}`;
  } catch {}
  const r = spawnSync("ps", ["-o", "lstart=", "-p", String(pid)], {
    encoding: "utf8",
    timeout: 5000,
    env: { ...process.env, ...BIRTH_STAMP_ENV },
  });
  const out = r.status === 0 && !r.error ? (r.stdout ?? "").trim() : "";
  return out ? `ps:${out}` : null;
}

/** The readers `processStartedAt` tags its stamps with — the only prefixes that name a source. */
const BIRTH_STAMP_SOURCES = new Set(["proc", "ps"]);

/**
 * Which reader produced a stamp, or null for one that names none — a pidfile written by an earlier
 * anton, or a test fixture. An unknown source compares only with another unknown one.
 */
function birthStampSource(stamp) {
  const tag = stamp.slice(0, stamp.indexOf(":"));
  return BIRTH_STAMP_SOURCES.has(tag) ? tag : null;
}

/**
 * What a stamp read NOW says about a stored one: `"same"` process, a `"different"` one, or
 * `"unknown"` — the two cannot be compared at all, so nothing is proven either way.
 *
 * `unknown` covers both ways a recheck comes up empty (PR #217 review): the read failed outright, or
 * it answered from the OTHER reader, whose spelling of the same birth time differs by construction.
 * Callers fail closed on it — the pid names nobody — but must not treat it as proof of death, since
 * deleting the record or pidfile of a live server is the one outcome here that cannot be undone.
 *
 * @param {string} stored
 * @param {string|null} now
 * @returns {"same"|"different"|"unknown"}
 */
export function birthStampVerdict(stored, now) {
  if (now === null) return "unknown";
  if (now === stored) return "same";
  return birthStampSource(stored) === birthStampSource(now) ? "different" : "unknown";
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
 *
 * A record that HAS one and cannot be rechecked — the read failed, or it came back from the other
 * birth-time reader, whose stamps do not compare — is the opposite case and fails closed, exactly as
 * the daemon pidfile does (see `pidFileVerdict`): the stamp exists because this machine could read
 * birth times at boot, so a lookup failing now leaves a reused pid indistinguishable from the live
 * one, and vouching for it attributes an unrelated process to anton — a drift surface then reports
 * a server that no longer exists as current. Unproven is not alive.
 *
 * @param {{[key: string]: unknown}|null|undefined} record
 * @param {(pid: number) => string|null} [startedAt]
 */
export function recordAlive(record, startedAt = processStartedAt) {
  return recordVerdict(record, startedAt).alive;
}

/**
 * What a record PROVES about the server it names: `alive` while the recorded process is still the
 * one running, and `stale` whether it is proven not to be — the cue to delete the file.
 *
 * The two are separate for the reason the pidfile splits them (PR #217 review): a stamped record
 * whose birth time cannot be reread this second names nobody a reader may trust, but it is not
 * proven dead either, and pruning it would delete a live server's own record — leaving that process
 * unaccounted for on every later read, when the next read that CAN resolve the stamp would have
 * named it again.
 *
 * @param {{[key: string]: unknown}|null|undefined} record
 * @param {(pid: number) => string|null} [startedAt]
 * @returns {{alive: boolean, stale: boolean}}
 */
export function recordVerdict(record, startedAt = processStartedAt) {
  if (!record || !pidAlive(record.pid)) return { alive: false, stale: true };
  if (!record.startedAt) return { alive: true, stale: false };
  const verdict = birthStampVerdict(
    /** @type {string} */ (record.startedAt),
    startedAt(/** @type {number} */ (record.pid)),
  );
  if (verdict === "same") return { alive: true, stale: false };
  return { alive: false, stale: verdict === "different" };
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
 * the upgrade that introduced it. The source digest — the same evidence for an install no git can
 * describe — is compared on the same terms, and is the only thing that lets a verdict there say
 * anything past the version.
 *
 * The env digest is not compared at all, though both sides carry one. A verdict is read from
 * OUTSIDE the running server — `anton doctor` in whatever shell the operator is standing in — and
 * that shell's `NEXT_PUBLIC_*` values are not a fact about the code on disk (the env FILES it also
 * digests are, but the two are one field and the shell half decides it). Comparing them would
 * report drift whenever doctor runs in a different shell from the one that started the server, and
 * print two identical build strings as the evidence. Freshness is where the env belongs, and
 * `sameCheckout` reads it there: `anton start` compares the stamp against its OWN environment,
 * which is the environment its `next build` would compile with.
 *
 * The FILE half is still compared here — through the digests above rather than through that field
 * (PR #217 review). An env file on disk is a fact about the install whatever shell reads it, so a
 * checkout folds it into its worktree digest (`ignoredEnvFiles`) and a git-less install into its
 * source digest (`skipsSourceEntry`), and an edit to `.env.local` under a running server moves the
 * one thing this comparison weighs.
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
  if (running.source && onDisk.source && running.source !== onDisk.source) return verdict("modified");
  if (replacedInPlace(running, onDisk)) return verdict("modified");
  return verdict("current");
}

/**
 * Did the SHAPE of the install change under the server — a git checkout replaced in place by a
 * git-less source tree, or the reverse (PR #217 review)?
 *
 * Every comparison above pairs a field with ITSELF, so a pair carrying different KINDS of evidence
 * slips past all of them: a running checkout names `revision` and `worktree`, a source tree on disk
 * names `source`, neither field stands on both sides, and the version alone then reads "current"
 * over code that may be entirely different. The two digests cannot be compared to each other — one
 * is a diff against HEAD, the other a walk of the tree — so that the evidence changed KIND is the
 * whole finding, and "modified" is the only honest reading of it.
 *
 * Both digests must be present, which keeps this off the absences the rest of the function refuses
 * to read as drift: a bundle and a record written before either field carry neither, and a checkout
 * whose git read failed carries neither either — `readBuildIdentity` gates `worktree` on a revision
 * it could name and `source` on there being no revision at all — so none of them reaches here.
 *
 * The cost is one restart on a checkout whose FIRST commit lands under a running server: an unborn
 * HEAD names no revision, so that install reads as source-backed before the commit exists and
 * checkout-backed after, with the same code on disk throughout. One prompt, once, on an install
 * shape almost nobody starts anton from — against a replacement this comparison would otherwise
 * call current for as long as the process lives.
 */
function replacedInPlace(a, b) {
  return Boolean((a.worktree && b.source) || (a.source && b.worktree));
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
 * - A build environment NEITHER read could establish (`ENV_UNPROVABLE` — the route scan ran past
 *   `MAX_ROUTE_ENTRIES`) is that trap again on the one field an env change moves: both reads name
 *   the same unknown, while a statically generated route past the scan's cutoff may have baked a
 *   different value into `.next`.
 *
 * Either way `ensureFreshBuild` builds again and, if the reads never resolve, refuses to start —
 * which is the honest end, since nothing can then say what `.next` holds. An install with no git at
 * all (a source tarball, `npm i -g anton`) names neither field and answers with its source digest
 * instead: version alone was never proof there — it does not move when a source file is edited, so
 * the artifact was accepted after the code under it was replaced (PR #217 review). A digest that
 * walk could not produce is the same no as a git read that failed. Only a release BUNDLE is
 * identified by version alone, and it never reaches here: `ensureFreshBuild` exempts it before any
 * comparison, since it ships its `.next` prebuilt and no toolchain to rebuild with.
 *
 * The env digest is compared here and NOWHERE else, because freshness is the only question it
 * answers. A stamp carrying none (written before the field existed) against an install with no env
 * file and no `NEXT_PUBLIC_*` set is two absences that agree — the common case, so the field costs
 * such an install no rebuild on the upgrade that introduced it — while a stamp with none against an environment that
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
    !agree(a.source, b.source) ||
    !agree(a.env, b.env)
  ) {
    return false;
  }
  if (a.revision === REVISION_UNREADABLE || b.revision === REVISION_UNREADABLE) return false;
  if (a.env === ENV_UNPROVABLE || b.env === ENV_UNPROVABLE) return false;
  return b.revision ? (b.worktree ?? null) !== null : (b.source ?? null) !== null;
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
 * builds differ reads as a bug rather than as the restart it is asking for. The source digest of a
 * git-less install (`0.4.0 (sources 9f2c1a4)`) is named for exactly that reason: it is the only
 * evidence such an install has, so leaving it out prints the version twice.
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
  if (identity.source) parts.push(`sources ${identity.source.slice(0, SHORT_SHA)}`);
  return parts.length ? `${identity.version} (${parts.join(", ")})` : identity.version;
}

/**
 * The drift as one sentence naming both builds and the single action that clears it. Shared by
 * doctor and the nightly session log so the operator reads the same claim wherever it surfaces.
 *
 * The claim is that the two builds DIFFER, never that the one on disk is the newer of them (PR #217
 * review). `compareBuild` compares versions, commits and digests for equality and nothing
 * establishes an order: a checkout reset to an ancestor, an install rolled back, or a switch to a
 * divergent branch all read exactly like an upgrade. Telling the operator that shipped work is
 * missing states the reverse of what happened in each of those, and the restart that clears it is
 * the same either way.
 */
export function describeBuildDrift(drift) {
  const onDisk = describeBuildIdentity(drift.onDisk);
  if (drift.state === "unstamped") {
    return (
      `the running anton server recorded no build identity — its build predates build-drift ` +
      `reporting or was compiled outside \`anton start\`, so nothing can say whether it matches the ` +
      `code on disk (${onDisk}). Restart the server to be sure`
    );
  }
  const what = drift.state === "outdated" ? "the runtime on disk is" : "the checkout is now";
  return (
    `the running anton server is ${describeBuildIdentity(drift.running)} but ${what} ${onDisk} — ` +
    `the build it is running is not the one on disk. Restart the server to run it`
  );
}
