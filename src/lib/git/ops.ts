/**
 * Git + PR operations for the execute-epic job (anton-dzh.4): commit a ticket's work in the
 * worktree, push the branch, and open one PR via `gh`. The `gh` binary is injectable
 * (ANTON_GH_BIN) so tests can point it at a fake. See DESIGN.md §4/§5.
 */
import type { ChildProcess } from "node:child_process";
import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { dirname as posixDirname, normalize as posixNormalizeRaw } from "node:path/posix";
import { StringDecoder } from "node:string_decoder";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** Override the GitHub CLI (tests point this at a fake that echoes a PR url). */
export const GH_BIN_ENV = "ANTON_GH_BIN";

/**
 * Resolve the effective `core.hooksPath` to override with when running git against `worktreePath`
 * (a worktree of `repoPath`, or `repoPath` itself when no worktree is involved) — or `undefined`
 * when unset. Every hook-firing git command anton runs against a worktree passes the result back in
 * as `-c core.hooksPath=<this>` (see {@link git}/{@link gitCommit}), so hooks fire from the right
 * source with no bridge, symlink, or `info/exclude` entry needed at all — replacing the earlier
 * symlink-into-the-worktree bridge entirely.
 *
 * Four things this must get right:
 *
 * 1. **Read from the worktree, not the base repo.** `core.hooksPath` can come from a shared config
 *    file selected by an `includeIf "onbranch:…"` condition that matches the WORKTREE's checked-out
 *    branch, not the base repo's (which may sit on `main` for the run's whole duration). Querying
 *    `repoPath` here would silently miss it — git-config(1): an `onbranch` condition is evaluated
 *    against the branch checked out in the repository the query runs against.
 * 2. **Expand `~`.** Git accepts `~/shared-hooks` in `core.hooksPath`; a plain `--get` returns it
 *    unexpanded, so absolutizing it naively would produce `<repo>/~/shared-hooks`. `--path` expands
 *    `~` to `$HOME` and leaves an already-relative or -absolute value untouched otherwise.
 * 3. **Prefer a worktree-local copy for a TRACKED relative directory.** A relative `core.hooksPath`
 *    pointing at a directory anton's own worktree carries its own copy of — content checked into
 *    git, so each worktree's checkout can genuinely differ (a PR that itself edits the hooks) — must
 *    resolve to that worktree's copy, not the base repo's. Only a GENERATED directory never committed
 *    to git at all (Husky's `.husky/_`, materialized by a local install anton's cold worktrees never
 *    ran) falls back to the base repo, because the worktree simply has no copy of its own to prefer.
 * 4. **Preserve whitespace.** A quoted `core.hooksPath` like `".hooks "` keeps its trailing space —
 *    git-config(1): whitespace inside a quoted value is preserved verbatim — so this reads git's
 *    output directly rather than through the shared {@link git} helper, whose blanket `.trim()`
 *    would silently rewrite `.hooks ` to `.hooks`, a directory that doesn't exist.
 * 5. **Don't revive a hooks directory the checked-out branch deleted.** A missing worktree copy has
 *    two different causes that must not be treated alike: a GENERATED directory (Husky's `.husky/_`)
 *    never existed there and the base repo's copy is genuinely the only source (point 3 above); but a
 *    TRACKED directory absent from the worktree means the feature branch itself removed or migrated
 *    it, and git would correctly run no hook at all for that — falling back to the base repo's stale
 *    copy would run a hook the branch intentionally deleted, and could block landing the very PR that
 *    deletes it. `git ls-files`, run against `repoPath`'s OWN checkout (which stays on its own branch
 *    throughout — the worktree's deletion never touches it), is what tells the two apart: a
 *    Husky-style directory is never committed at all (its own installer writes `.husky/_/.gitignore`
 *    on `prepare`, itself untracked — checking gitignore state instead would miss it, since the rule
 *    ignores the directory's contents without ever naming the directory itself), so `ls-files` finds
 *    nothing for it there either; a directory the worktree's branch deleted is still tracked in the
 *    base repo's checkout, since that deletion never happened there. Two things that probe must get
 *    right in turn (PR #263 review, round 2):
 *    - **A literal pathspec.** `relPath` reaches `ls-files` unescaped; a hooksPath containing a
 *      pathspec metacharacter (`.hooks*`) would otherwise match by GLOB rather than by name, and a
 *      coincidentally-matching tracked file elsewhere in the repo would report "tracked" for a
 *      directory nothing ever put there. Prefixed with `:(literal)`, the same guard this file already
 *      applies wherever a git-derived path reaches a pathspec position (see {@link blobModeAtRev}),
 *      so it can only ever match that exact path.
 *    - **Distinguish "not tracked" from "couldn't tell".** `--error-unmatch` turns a genuine no-match
 *      into exit code 1 with git's own "did not match any file(s)" message — recognizable, and the
 *      only case that legitimately means "generated, fall back". Anything else (a corrupt index, a
 *      timeout) is an operational failure with the WORKTREE still usable; swallowing it as "not
 *      tracked" would revive a base-repo hook the branch may have deleted on purpose. It must throw
 *      instead, same as the unguarded `execFileAsync` calls elsewhere in this file.
 *    - **Skip the probe for a path outside the repo entirely.** `core.hooksPath` may validly climb
 *      out via `..` — git-config(1) places no restriction on it — but such a path can never appear in
 *      ANY checkout's index, and `ls-files` rejects a pathspec outside the repository with exit 128,
 *      not the no-match exit 1 the code above depends on. Detected up front (before ever calling
 *      `ls-files`) via {@link relative}: it is never "tracked" by definition, so this falls straight
 *      to the base repo's copy — the only sensible source for a directory that lives outside either
 *      checkout to begin with.
 */
export async function resolveHooksPathOverride(
  repoPath: string,
  worktreePath?: string,
): Promise<string | undefined> {
  const queryFrom = worktreePath ?? repoPath;
  let raw: string;
  let scope: string;
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["-C", queryFrom, "config", "--show-scope", "--path", "--get", "core.hooksPath"],
      { timeout: 120_000, maxBuffer: 16 * 1024 * 1024 },
    );
    // `--show-scope` prefixes exactly one tab-delimited field before the value; the value itself may
    // contain no leading/trailing whitespace of its own to confuse with the separator (git-config(1)
    // documents the scope column as tab-separated), so split once and keep the remainder verbatim,
    // including the record terminator strip below.
    const tab = stdout.indexOf("\t");
    scope = stdout.slice(0, tab);
    raw = stdout.slice(tab + 1).replace(/\n$/, ""); // only git's record terminator, never whitespace
  } catch {
    return undefined; // unset, or unreadable — nothing to override with
  }
  if (!raw) return undefined;
  if (isAbsolute(raw)) return raw;

  if (!worktreePath) return resolve(repoPath, raw);

  const inWorktree = resolve(worktreePath, raw);
  // A `worktree`-scoped value (`git config --worktree core.hooksPath …`, requires
  // `extensions.worktreeConfig`) is deliberately PRIVATE to this checkout — git-config(1) documents
  // `--worktree` as exactly that, distinct from `local`'s repo-wide config file that every linked
  // worktree already inherits. Falling back to the base repo's copy for a missing worktree-scoped
  // path would run a hook this worktree specifically opted out of by choosing its own value, possibly
  // a same-named directory that exists in the base repo for an unrelated reason (PR #263 review,
  // round 11) — so a worktree-scoped value NEVER falls back; a missing worktree-scoped hooksPath
  // means git itself would fire no hook here either, and this returns that same nonexistent path.
  if (scope === "worktree") return inWorktree;

  // A DIRECTORY, never merely "exists": `.git` is git's one built-in relative core.hooksPath value
  // that is a real directory in the base repo but a plain FILE in every linked worktree (a "gitfile"
  // pointer to the shared gitdir — gitrepository-layout(5)). `existsSync` alone would accept that
  // file as the hooks directory and silently stop running any hook at all from a worktree, while the
  // base repo's own `.git` keeps working (PR #263 review) — `isDirectory()` falls through to the
  // tracked-check below instead, which correctly resolves `.git` to the base repo's real directory
  // (never tracked in git's index, so treated the same as any other generated path).
  //
  // A `core.hooksPath` that climbs out of the repo via `..` (valid — git-config(1) places no
  // restriction on it) can never be in ANY checkout's index, so neither `isTrackedInBaseRepo`'s
  // `ls-files` nor `uninitializedSubmoduleSha`'s `submodule status` below has anything meaningful to
  // answer for it — worse, git rejects a pathspec outside the repository outright (exit 128, not the
  // no-match exit 1 those helpers otherwise rely on), which would otherwise make them throw and abort
  // every commit/push using such a path (PR #263 review). Detected up front, before either probe ever
  // runs: it is never "tracked" or "a submodule" by definition, so this falls straight to the base
  // repo's copy, the only sensible source for a shared directory that lives outside either checkout.
  const rel = relative(repoPath, resolve(repoPath, raw));
  // `rel === ".."` or a `..` SEGMENT (`..${sep}`) means real traversal; a bare `startsWith("..")`
  // would also match a same-level name that merely begins with two dots, like `..hooks` — a valid
  // directory name path.relative can legitimately return unchanged (PR #263 review, round 4).
  const escapesRepo = rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel);
  if (escapesRepo && existsSync(inWorktree) && statSync(inWorktree).isDirectory()) return inWorktree;
  if (escapesRepo) return resolve(repoPath, raw);

  // A DIRECTORY THAT IS ACTUALLY AN UNINITIALIZED SUBMODULE is the other case `isDirectory()` alone
  // can't tell apart: `git worktree add` materializes a submodule's gitlink entry as a real, empty
  // directory in the new worktree regardless of whether that submodule has ever been initialized
  // there (`git submodule update --init` never runs for a worktree add) — so a `core.hooksPath`
  // naming a submodule root looks like a present, empty hooks directory instead of the tracked
  // directory it actually is. `uninitializedSubmoduleSha` is what tells the two apart (`raw` is
  // confirmed to resolve INSIDE the repo by this point — the `escapesRepo` check above already
  // returned otherwise — so an exit-128 failure it hits can only be a genuine operational failure,
  // e.g. a feature branch that dropped `.gitmodules` while keeping the gitlink, and it propagates
  // that rather than misreading it as "not a submodule" and silently accepting the broken worktree
  // copy — PR #263 review, round 14).
  //
  // The base repo's copy is trusted as a substitute only when `baseSubmoduleMatches` confirms it is
  // BOTH initialized AND checked out at the EXACT commit this worktree's tree records for the
  // gitlink — never merely "initialized somewhere". A feature branch may have bumped the gitlink to
  // a newer commit than whatever the base repo's own checkout happens to sit at (nothing keeps them
  // in lockstep), and running that STALE commit's hooks — silently missing a gate it added, or
  // applying behavior it deliberately changed — is worse than running none. A mismatch or an
  // uninitialized base copy falls through to the worktree's own (still empty) path instead, so no
  // hook fires at all rather than an outdated one (PR #263 review, round 18).
  if (existsSync(inWorktree) && statSync(inWorktree).isDirectory()) {
    const submoduleSha = await uninitializedSubmoduleSha(worktreePath, raw);
    if (submoduleSha && (await baseSubmoduleMatches(repoPath, raw, submoduleSha))) {
      return resolve(repoPath, raw);
    }
    return inWorktree;
  }

  // A hooksPath NESTED INSIDE an uninitialized submodule (`core.hooksPath=deps/hooks`, where `deps`
  // is the gitlink) is the other shape `existsSync` alone can't see: the superproject's tree records
  // only `deps` as a gitlink — never a `deps/hooks` entry of its own (gitsubmodules(7): a submodule's
  // CONTENTS are never part of the superproject's tree) — so `deps/hooks` is simply absent from both
  // `git ls-files` and `git log`, indistinguishable from a directory that was always generated on
  // EITHER branch. Left unhandled, this would fall straight to the tracked-somewhere check below,
  // find nothing tracking it (correctly — nothing ever could), and hand back the base repo's copy
  // completely unconditionally: none of round 18's staleness verification ever runs, because that
  // logic only ever triggers for a hooksPath that IS itself a gitlink. `ancestorSubmoduleSha` finds
  // the nearest containing gitlink so the exact same base-must-match-worktree check applies to a
  // nested path too (PR #263 review, round 20).
  const containing = await ancestorSubmoduleSha(worktreePath, raw);
  if (containing) {
    const matches = await baseSubmoduleMatches(repoPath, containing.submodulePath, containing.sha);
    return matches ? resolve(repoPath, raw) : inWorktree;
  }

  // Missing in the worktree — fall back to the base repo's copy only when NEITHER checkout has ever
  // tracked it (a generated directory like Husky's `.husky/_`, never committed at all). Either
  // checkout tracking it — now or at any point in its own history — means the worktree's branch
  // deleted or moved a REAL hooks directory on purpose, and `inWorktree` is still the right answer:
  // git runs no hook for a configured `core.hooksPath` that doesn't exist. `isTrackedInBaseRepo`
  // alone is not enough: the base checkout's index has no record of a directory this FEATURE branch
  // introduced and later deleted entirely — never present on base at all — which would otherwise be
  // indistinguishable from one that was always generated (PR #263 review, round 15); `everTrackedOnBranch`
  // catches that case by walking the worktree's own history instead of only its current index.
  const trackedSomewhere =
    (await isTrackedInBaseRepo(repoPath, raw)) || (await everTrackedOnBranch(worktreePath, raw));
  return trackedSomewhere ? inWorktree : resolve(repoPath, raw);
}

/**
 * Whether `relPath` is a path `repoPath`'s OWN checkout currently tracks in git — queried there
 * rather than the worktree, because the worktree's branch is exactly what may have deleted it, and
 * asking it would just confirm the deletion instead of revealing whether it was ever a real, tracked
 * hooks directory. `git ls-files` is what distinguishes "nobody ever committed this" (Husky's
 * `.husky/_`, generated by `prepare` and never checked in — even its own `.gitignore` is written
 * fresh on every install, so gitignore state can't be used as the signal either) from "a real hooks
 * directory the worktree's branch removed" (PR #263 review): the base repo still has the latter.
 */
async function isTrackedInBaseRepo(repoPath: string, relPath: string): Promise<boolean> {
  try {
    await execFileAsync(
      "git",
      ["-C", repoPath, "ls-files", "--error-unmatch", "--", `:(literal)${relPath}`],
      { timeout: 120_000, maxBuffer: 16 * 1024 * 1024 },
    );
    return true;
  } catch (e) {
    // Exit 1 is `--error-unmatch`'s documented signal for a genuine no-match — the only case that
    // legitimately means "generated, fall back to the base repo's copy". Anything else (a corrupt
    // index, a timeout, git missing) is an operational failure with the worktree itself still
    // perfectly usable; swallowing it here would revive a hook the worktree's branch may have deleted
    // on purpose, so {@link exitedWith} is what tells a real "not tracked" apart from that and lets
    // everything else propagate.
    if (exitedWith(e, 1)) return false;
    throw e;
  }
}

/**
 * Whether `relPath` has EVER been a real, committed path anywhere in `worktreePath`'s own branch
 * history — not just its current index (which {@link isTrackedInBaseRepo} checks for the base
 * checkout, and which `existsSync`/`ls-tree` above already ruled out for the worktree's PRESENT
 * tree). A path a feature branch introduced and later deleted entirely never appears in the base
 * checkout's index at all — the base branch never tracked it either — so `isTrackedInBaseRepo` alone
 * cannot tell that deletion apart from a directory that was always generated and never committed on
 * EITHER branch (PR #263 review, round 15): `git log`, walking the WORKTREE's own history, is what
 * distinguishes the two — a real, later-deleted directory has a commit touching it somewhere in that
 * history; a purely generated one (Husky's `.husky/_`) has none, on any branch, ever.
 */
async function everTrackedOnBranch(worktreePath: string, relPath: string): Promise<boolean> {
  const { stdout } = await execFileAsync(
    "git",
    ["-C", worktreePath, "log", "-1", "--format=%H", "--", `:(literal)${relPath}`],
    { timeout: 120_000, maxBuffer: 16 * 1024 * 1024 },
  );
  return stdout.trim().length > 0;
}

/**
 * The nearest ancestor of `relPath` (`relPath` itself included) that `rev`'s tree in `worktreePath`
 * records as a submodule gitlink (mode `160000`) — along with the commit that gitlink targets — or
 * `undefined` when no ancestor is one. A hooksPath NESTED inside a submodule (`core.hooksPath=
 * deps/hooks`, `deps` the gitlink) needs this because the superproject's tree never records anything
 * below the gitlink itself (gitsubmodules(7)): `deps/hooks` has no tree entry of its own to inspect
 * directly, uninitialized or not, so the only way to reason about it is to find what CONTAINS it.
 *
 * `rev` is a parameter, not always `HEAD`, because {@link resolveHooksPathOverrideForMerge} needs the
 * answer for an INCOMING ref rather than the worktree's current checkout — the same distinction
 * {@link checkedOutSubmoduleSha} draws for the direct-submodule case (PR #263 review, round 21).
 *
 * Walked with `git ls-tree` one path segment at a time from `relPath` up to the repo root, rather
 * than a single `-r` (recursive) call: a recursive listing only shows entries actually reachable
 * under a real tree, and a gitlink is a dead end to `ls-tree -r` by design (it does not recurse into
 * submodules) — checking each ancestor path individually is what correctly finds a gitlink at any
 * depth, not just an immediate parent.
 */
async function ancestorSubmoduleSha(
  worktreePath: string,
  relPath: string,
  rev = "HEAD",
): Promise<{ submodulePath: string; sha: string } | undefined> {
  let candidate = posixNormalize(relPath);
  while (candidate !== "." && candidate !== "/") {
    const { stdout } = await execFileAsync(
      "git",
      ["-C", worktreePath, "ls-tree", rev, "--", `:(literal)${candidate}`],
      { timeout: 120_000, maxBuffer: 16 * 1024 * 1024 },
    );
    const entry = stdout.split("\n")[0] ?? "";
    const tab = entry.indexOf("\t");
    if (tab !== -1) {
      const [mode, , sha] = entry.slice(0, tab).split(" ");
      if (mode === "160000" && sha) return { submodulePath: candidate, sha };
    }
    const parent = posixDirname(candidate);
    if (parent === candidate) break;
    candidate = parent;
  }
  return undefined;
}

/**
 * Whether `relPath` is a submodule gitlink in `worktreePath`'s index that has never been
 * initialized there — the one case `existsSync`+`isDirectory()` can't tell apart from a real,
 * populated hooks directory. `git worktree add` materializes every tracked path, submodule gitlinks
 * included, but never runs `submodule update --init` for the new worktree (that is a separate,
 * opt-in step) — so an uninitialized submodule shows up as a real, merely empty directory, exactly
 * as present on disk as a hooks directory with content (PR #263 review, round 13).
 *
 * `git submodule status` is what distinguishes the two: it prefixes exactly one status character per
 * line, and a leading `-` is documented as specifically "not initialized" (git-submodule(1)) — the
 * only prefix meaning this worktree's copy is the empty placeholder, not real hook content.
 *
 * Its `-- <path>` accepts a PATHSPEC FILTER, not an assertion that the operand itself is a gitlink
 * (git-submodule(1)): `relPath` naming an ordinary directory that merely CONTAINS an uninitialized
 * submodule (`core.hooksPath=.`, or any directory holding one nested inside) still returns that
 * descendant's own line with a leading `-`, which a bare `stdout.startsWith("-")` would misread as
 * `relPath` itself being the uninitialized submodule. Every reported line's OWN path column is
 * checked against `relPath` instead — only a line naming this exact path, not a filtered-in
 * descendant's, answers the question this helper exists to ask (PR #263 review, round 15).
 *
 * That comparison must be against `relPath`'s CANONICAL form, not its literal spelling: git always
 * reports a submodule's path canonically (`hooks`, never `./hooks` or `hooks/`), while `core.
 * hooksPath` — read via `git config --path`, which expands `~` but does no other normalization — can
 * be any of those valid, noncanonical spellings. Comparing against the raw string would then never
 * match a canonically-different-but-equal path, silently falling through to `false` and accepting
 * the worktree's empty placeholder (PR #263 review, round 16).
 *
 * Returns the gitlink's target commit — the sha this worktree's tree RECORDS for the submodule,
 * present in `submodule status`'s output even when uninitialized — rather than a bare boolean:
 * {@link resolveHooksPathOverride} needs it to confirm the base repo's own copy is actually checked
 * out at that same commit before trusting it as a substitute (a feature branch may have bumped the
 * gitlink to a commit the base repo's copy predates — PR #263 review, round 18).
 */
async function uninitializedSubmoduleSha(
  worktreePath: string,
  relPath: string,
): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["-C", worktreePath, "submodule", "status", "--", `:(literal)${relPath}`],
      { timeout: 120_000, maxBuffer: 16 * 1024 * 1024 },
    );
    const wanted = posixNormalize(relPath);
    for (const line of stdout.split("\n")) {
      const parsed = parseSubmoduleStatusLine(line);
      if (parsed.status === "-" && parsed.path === wanted) return parsed.sha;
    }
    return undefined;
  } catch (e) {
    // Exit 1 is `submodule status`'s documented no-match signal — `relPath` is a regular tracked
    // directory, not a submodule at all, the ordinary case this helper must say "false" for. Every
    // other exit code is an operational failure with the worktree itself still usable: notably exit
    // 128 covers BOTH a path that legitimately escapes the repo (already handled by the caller before
    // this ever runs, so ruled out here) AND a submodule gitlink whose `.gitmodules` mapping is
    // missing or corrupt — git reports the latter as "fatal: no submodule mapping found", a real
    // defect that must surface rather than be misread as "not a submodule" and silently accept the
    // worktree's placeholder directory in its place (PR #263 review, round 14).
    if (exitedWith(e, 1)) return undefined;
    throw e;
  }
}

/**
 * Whether the base repo's OWN checkout of the submodule at `relPath` is initialized and checked out
 * at exactly `wantSha` — the gate {@link resolveHooksPathOverride} applies before trusting the base
 * repo's copy as a substitute for the worktree's uninitialized one. Reusing `git submodule status`
 * here (rather than `git -C <submodule-dir> rev-parse HEAD`) is deliberate: run against an
 * UNINITIALIZED submodule directory — no `.git` of its own — a bare `git -C` command silently falls
 * through to the enclosing superproject's repository instead of failing, so a base repo whose own
 * copy is ALSO uninitialized would misreport the superproject's HEAD as if it were the submodule's,
 * a false match this function must not produce (PR #263 review, round 18). `git submodule status`
 * has no such ambiguity: its leading status character is always accurate to that path specifically.
 */
async function baseSubmoduleMatches(
  repoPath: string,
  relPath: string,
  wantSha: string,
): Promise<boolean> {
  let stdout: string;
  try {
    ({ stdout } = await execFileAsync(
      "git",
      ["-C", repoPath, "submodule", "status", "--", `:(literal)${relPath}`],
      { timeout: 120_000, maxBuffer: 16 * 1024 * 1024 },
    ));
  } catch (e) {
    // Exit 1 is `submodule status`'s documented no-match signal — the base repo does not track
    // `relPath` as a submodule at all, never a match. Anything else (a corrupt index, a timeout, git
    // missing) is an operational failure that must propagate rather than be misread as "no match",
    // same reasoning as {@link uninitializedSubmoduleSha}'s identical guard.
    if (exitedWith(e, 1)) return false;
    throw e;
  }
  const wanted = posixNormalize(relPath);
  for (const line of stdout.split("\n")) {
    const parsed = parseSubmoduleStatusLine(line);
    // An INITIALIZED submodule's line (the only kind that can match here — see below) carries a
    // ` (<describe>)` suffix `parseSubmoduleStatusLine` deliberately leaves attached, so the path
    // must be matched as either the whole string or that whole string plus the suffix — never by
    // trimming a suspected suffix off blindly, which would misparse a path whose own name legitimately
    // contains literal `" ("` text (the same ambiguity `uninitializedSubmoduleSha`'s `-`-only lines
    // never hit, since a submodule with no checkout has nothing to run `git describe` in at all).
    if (parsed.path === wanted || parsed.path.startsWith(`${wanted} (`)) {
      return parsed.status !== "-" && parsed.sha === wantSha;
    }
  }
  return false;
}

/**
 * Whether `relPath`'s submodule in `worktreePath` currently has ANY real, checked-out content that
 * could serve a hook — and if so, the exact commit it's at. `git submodule status`'s status
 * character is what distinguishes an actual checkout from a hollow placeholder: `-` (uninitialized)
 * reports the gitlink target with no checkout backing it at all, so it is deliberately excluded here
 * (`checkedOut: false`, `sha: undefined`) rather than reported as "checked out at the gitlink's own
 * commit" — a caller comparing shas alone would otherwise see an uninitialized submodule whose
 * gitlink happens to already equal the incoming one as a false "match" (PR #263 review, round 19,
 * building on round 15's same distinction). A normal match (` `) or a MISMATCH (`+`, git-submodule(1):
 * "the currently checked out submodule commit does not match the SHA-1 found in the index") both mean
 * real content exists, whatever commit it's at — reported as `checkedOut: true` with that `sha`.
 * `checkedOut: false, sha: undefined` also covers `relPath` naming no submodule at all.
 */
async function checkedOutSubmoduleSha(
  worktreePath: string,
  relPath: string,
): Promise<{ checkedOut: boolean; sha: string | undefined }> {
  let stdout: string;
  try {
    ({ stdout } = await execFileAsync(
      "git",
      ["-C", worktreePath, "submodule", "status", "--", `:(literal)${relPath}`],
      { timeout: 120_000, maxBuffer: 16 * 1024 * 1024 },
    ));
  } catch (e) {
    if (exitedWith(e, 1)) return { checkedOut: false, sha: undefined };
    throw e;
  }
  const wanted = posixNormalize(relPath);
  for (const line of stdout.split("\n")) {
    const parsed = parseSubmoduleStatusLine(line);
    if (parsed.path === wanted || parsed.path.startsWith(`${wanted} (`)) {
      return { checkedOut: parsed.status !== "-", sha: parsed.sha };
    }
  }
  return { checkedOut: false, sha: undefined };
}

/**
 * One `git submodule status` output line, split into its three parts — format `<status-char><sha>
 * <path>[ (<describe>)]` (git-submodule(1)): exactly one status character, then the object id, a
 * space, then the path.
 *
 * The sha is NOT assumed to be 40 hex characters: `git init --object-format=sha256` (git-init(1))
 * produces 64-character object ids, and hard-coding the sha1 width would misparse every line in such
 * a repository, leaving part of the hash attached to `path` instead — silently breaking every
 * comparison against it (PR #263 review, round 18). Split on the FIRST space after the status
 * character instead: a hex object id, of either length, can never itself contain one.
 *
 * `path` is left WHOLE rather than trimmed of an assumed trailing `(<describe>)` — every caller here
 * only ever matches a `-`-prefixed (uninitialized) line, and an uninitialized submodule's line never
 * carries a describe suffix in the first place (that comes from running `git describe` INSIDE the
 * submodule's own checkout, which doesn't exist yet). Trimming one anyway would misparse a path that
 * itself legitimately contains literal `" ("` text (`core.hooksPath="hooks (x)"`) as a shorter path
 * plus a fake suffix, breaking every exact-path comparison against it (PR #263 review, round 17).
 */
function parseSubmoduleStatusLine(line: string): { status: string; sha: string; path: string } {
  const status = line[0] ?? "";
  const spaceIndex = line.indexOf(" ", 1);
  return spaceIndex === -1
    ? { status, sha: line.slice(1), path: "" }
    : { status, sha: line.slice(1, spaceIndex), path: line.slice(spaceIndex + 1) };
}

/**
 * `relPath` in the canonical form git itself reports a path in — no `./` prefix, no interior `./`
 * segment, no trailing slash (`node:path/posix`'s `normalize` collapses the first two; the last is
 * stripped separately, since `normalize` only drops a trailing slash for the bare `.` case). Used to
 * compare a `core.hooksPath` value (read via `git config --path`, which expands `~` but performs no
 * other normalization, so `./hooks` and `hooks/` both pass through it unchanged) against
 * {@link submoduleStatusPath}'s output, which `git submodule status` always canonicalizes regardless
 * of how its own pathspec argument was spelled (PR #263 review, round 16).
 */
function posixNormalize(relPath: string): string {
  return posixNormalizeRaw(relPath).replace(/\/+$/, "");
}

/**
 * Whether a merge bringing `ref` (a fetched remote-tracking ref, typically) into `worktreePath` needs
 * an explicit `core.hooksPath` override to fire that merge's own `post-merge` correctly — the
 * question a caller doing exactly that merge needs answered BEFORE running it, which is narrower
 * than {@link resolveHooksPathOverride}'s "what does the CURRENT checkout need" (PR #263 review,
 * rounds 6-8). Two outcomes, and a caller must never guess wrong between them:
 *
 * - `false` (no override needed): `ref` itself carries the configured hooksPath — a reviewer's push
 *   that adds or edits a tracked `.githooks`, say. Git's native per-worktree resolution (≥ 2.43)
 *   already gets this right once the merge lands; passing a value resolved BEFORE the merge would
 *   necessarily be stale or point nowhere, since the tracked copy doesn't exist yet, and silently
 *   skip `post-merge` (round 6/7's bug).
 * - `true` (override needed): the hooksPath is unset, absolute, a relative path that climbs outside
 *   the repo via `..`, or a relative path `ref` does NOT carry — a GENERATED directory like Husky's
 *   `.husky/_`, which no ref ever tracks. No fetch introduces it, so there is nothing for native
 *   resolution to pick up post-merge either; the base repo's locally-installed copy (from
 *   {@link resolveHooksPathOverride}) is the only source, and omitting the override here means
 *   `post-merge` never fires at all (round 8's regression from unconditionally dropping it).
 *
 * A `..`-escaping path can never be tracked by ANY ref — git rejects a pathspec outside the
 * repository outright (exit 128), not the empty-output "not found" this function otherwise reads —
 * so it is detected up front, the same way and for the same reason as
 * {@link resolveHooksPathOverride}'s own escape check (PR #263 review, round 9: the check added
 * there does not cover this separate `ls-tree` probe).
 *
 * `ref` itself may not exist: a caller's own fetch of it can be best-effort (wrapped in a
 * swallow-and-continue helper upstream), so a missing remote-tracking ref reaching this function is
 * an expected, not exceptional, input — `ls-tree` rejects a missing `<tree-ish>` outright (exit 128,
 * same failure shape as the `..`-escape above), which would otherwise throw here even for an
 * ordinary, correctly-configured relative hooksPath, breaking every review-fix run whose sync fetch
 * happened to fail (PR #263 review, round 12). Checked with `rev-parse --verify` before ever running
 * `ls-tree`; a missing ref answers `true` (override needed) — harmless, since the merge this decision
 * feeds is about to fail on the same missing ref anyway, through its own best-effort handling.
 */
export async function needsHooksPathOverrideForMerge(
  repoPath: string,
  worktreePath: string,
  ref: string,
): Promise<boolean> {
  let raw: string;
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["-C", worktreePath, "config", "--path", "--get", "core.hooksPath"],
      { timeout: 120_000, maxBuffer: 16 * 1024 * 1024 },
    );
    raw = stdout.replace(/\n$/, "");
  } catch {
    return false; // unset — nothing to override with either way
  }
  if (!raw || isAbsolute(raw)) return false; // absolute is resolved already; never ref-trackable

  const rel = relative(repoPath, resolve(repoPath, raw));
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return true; // never ref-trackable

  try {
    await execFileAsync("git", ["-C", worktreePath, "rev-parse", "--verify", "--quiet", ref], {
      timeout: 120_000,
    });
  } catch {
    return true; // ref doesn't exist (or is unreadable) — nothing for it to track either way
  }

  const { stdout } = await execFileAsync(
    "git",
    ["-C", worktreePath, "ls-tree", ref, "--", `:(literal)${raw}`],
    { timeout: 120_000, maxBuffer: 16 * 1024 * 1024 },
  );
  const entry = stdout.split("\n")[0] ?? "";
  const tab = entry.indexOf("\t");
  if (tab === -1) return true; // ref doesn't carry it — override needed
  const [mode, , incomingSha] = entry.slice(0, tab).split(" ");
  // A plain tracked directory or file (`040000`/`100644`/`100755`, never `160000`) is exactly the
  // case the original logic already got right: `ref` carries it, so git's native per-worktree
  // resolution (≥ 2.43) picks it up correctly once the merge lands — no override needed. Only a
  // submodule gitlink needs the extra check below, since only a submodule's ACTUAL content can go on
  // being stale after the merge changes what the gitlink points to.
  if (mode !== "160000") return false;

  // `ref` carrying the gitlink is not the same as the merge actually populating it: a fast-forward
  // never runs `submodule update --init` on its own, so a hooksPath naming a submodule that is
  // initialized in the base checkout but UNINITIALIZED in this review worktree stays exactly that
  // empty placeholder after the merge lands — the same condition {@link resolveHooksPathOverride}
  // already detects for the CURRENT checkout via `git submodule status`. Skipping this check here
  // would read the ref's tracked gitlink as proof the merge's own `post-merge` will fire correctly,
  // when the worktree it actually runs against still has nothing checked out at that path
  // (PR #263 review, round 15).
  //
  // Nor is the CURRENT checkout matching its OWN gitlink proof enough on its own: `ref` may have
  // moved the gitlink to a newer commit than what this worktree currently has checked out — a
  // fast-forward changes the recorded gitlink but never touches the submodule's actual checkout on
  // disk, so a hooksPath that reads as "fine, currently initialized and matching" before the merge is
  // exactly the stale copy `post-merge` would fire against once the merge lands and the gitlink no
  // longer agrees with it. Comparing the CURRENT checkout against the INCOMING gitlink — not just the
  // current one — is what catches this: any mismatch, uninitialized or merely stale, means an
  // override is needed (PR #263 review, round 19).
  const current = await checkedOutSubmoduleSha(worktreePath, raw);
  return !current.checkedOut || current.sha !== incomingSha;
}

/**
 * The `core.hooksPath` value to actually pass into the fast-forward merge bringing `ref` into
 * `worktreePath` — called only once {@link needsHooksPathOverrideForMerge} has said `true`, i.e. an
 * override is needed. `undefined` means no safe value exists: the merge should run with NO override
 * (no hook fires) rather than a WRONG one.
 *
 * The mistake this exists to prevent: calling {@link resolveHooksPathOverride} for this purpose,
 * which answers "what does the CURRENT checkout need" — a different question. A review worktree
 * whose submodule-backed hooksPath is currently initialized and self-consistent (worktree's own
 * gitlink matches its own checkout) passes that check happily even though `ref` is about to move the
 * gitlink to a commit NEITHER the worktree's nor the base repo's checkout has ever seen — a
 * fast-forward changes the recorded gitlink but never re-runs `submodule update`, so `post-merge`
 * would fire against content from the OLD commit right after the merge changes what the gitlink
 * says. Every submodule check here is against the INCOMING (`ref`) gitlink specifically, never the
 * worktree's own pre-merge one, so the answer is right for the tree the merge is about to produce,
 * not the one that's about to be replaced (PR #263 review, round 21 — round 19 closed this same gap
 * for {@link needsHooksPathOverrideForMerge}'s own boolean, but the VALUE this function returns had
 * an identical hole: {@link resolveHooksPathOverride} was still being asked, and it answers for the
 * wrong tree).
 */
export async function resolveHooksPathOverrideForMerge(
  repoPath: string,
  worktreePath: string,
  ref: string,
): Promise<string | undefined> {
  let raw: string;
  let scope: string;
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["-C", worktreePath, "config", "--show-scope", "--path", "--get", "core.hooksPath"],
      { timeout: 120_000, maxBuffer: 16 * 1024 * 1024 },
    );
    const tab = stdout.indexOf("\t");
    scope = stdout.slice(0, tab);
    raw = stdout.slice(tab + 1).replace(/\n$/, "");
  } catch {
    return undefined; // unset — nothing to override with
  }
  if (!raw) return undefined;
  if (isAbsolute(raw)) return raw;

  // A `worktree`-scoped value (`git config --worktree core.hooksPath …`, requires
  // `extensions.worktreeConfig`) is deliberately PRIVATE to this checkout — resolved against
  // `worktreePath`, never `repoPath`, same as {@link resolveHooksPathOverride}'s identical scope
  // guard. Skipping this here would resolve a worktree-private relative path against the wrong base
  // entirely whenever the two checkouts don't share a parent directory a `../`-escape would
  // coincidentally land back inside — silently pointing the merge's hook at an unrelated directory,
  // or one that doesn't exist (PR #263 review, round 23).
  const inWorktree = resolve(worktreePath, raw);
  if (scope === "worktree") return inWorktree;

  // A `..`-escaping path can never be tracked by ANY ref (see needsHooksPathOverrideForMerge) — the
  // base repo's resolved copy is the only sensible source, same as resolveHooksPathOverride's
  // identical case, since such a path lives outside either checkout entirely.
  const rel = relative(repoPath, resolve(repoPath, raw));
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return resolve(repoPath, raw);

  // `ref` itself may not exist: the caller's own fetch of it can be best-effort, so a missing
  // remote-tracking ref reaching this function is expected input, not exceptional — the same reason
  // {@link needsHooksPathOverrideForMerge} guards its own `ls-tree` call the identical way. Without
  // this, a failed sync fetch would make `ls-tree` below throw OUTSIDE the `safe()` boundary this
  // function's only caller wraps its merge in, aborting the whole review-fix run instead of merely
  // skipping the override the failed sync already made moot (PR #263 review, round 22).
  try {
    await execFileAsync("git", ["-C", worktreePath, "rev-parse", "--verify", "--quiet", ref], {
      timeout: 120_000,
    });
  } catch {
    return undefined; // ref doesn't exist (or is unreadable) — no override to resolve either way
  }

  const { stdout } = await execFileAsync(
    "git",
    ["-C", worktreePath, "ls-tree", ref, "--", `:(literal)${raw}`],
    { timeout: 120_000, maxBuffer: 16 * 1024 * 1024 },
  );
  const entry = stdout.split("\n")[0] ?? "";
  const tab = entry.indexOf("\t");
  const [mode, , incomingSha] = tab === -1 ? [] : entry.slice(0, tab).split(" ");

  if (tab !== -1 && mode !== "160000") {
    // A plain tracked directory or file: git's native per-worktree resolution (≥ 2.43) gets this
    // right once the merge lands. No override needed at all — but `needsHooksPathOverrideForMerge`
    // already said one was, so this is reached only when its OWN answer disagreed for a different
    // path than this call is racing; return undefined defensively rather than a value nothing needs.
    return undefined;
  }

  const baseMatchesDirect =
    tab !== -1 && incomingSha ? await baseSubmoduleMatches(repoPath, raw, incomingSha) : false;
  if (baseMatchesDirect) return resolve(repoPath, raw);

  // Either the direct submodule check failed, OR `raw` had no tree entry of its own at all — the
  // NESTED case (`deps/hooks`, where `ref`'s tree records only `deps`), which must run this same
  // ancestor check rather than falling straight through to `resolveHooksPathOverride` (the
  // current-tree resolver, wrong question for a merge — see this function's own docstring): a nested
  // hooksPath whose containing submodule the incoming ref bumped is exactly as capable of pointing at
  // stale content as a hooksPath that IS itself the gitlink, and skipping this check here would read
  // "no direct tree entry" as proof of "generated, safe to ask the current-tree resolver" when it
  // might just as easily mean "nested inside a submodule ref is about to move"
  // (PR #263 review, round 22).
  const containing = await ancestorSubmoduleSha(worktreePath, raw, ref);
  if (containing) {
    const baseMatchesContaining = await baseSubmoduleMatches(
      repoPath,
      containing.submodulePath,
      containing.sha,
    );
    return baseMatchesContaining ? resolve(repoPath, raw) : undefined;
  }

  if (tab === -1) {
    // No containing gitlink anywhere in `ref`'s tree either — a GENERATED directory (Husky's
    // `.husky/_`), never tracked by any ref at all, exactly the case `resolveHooksPathOverride`'s
    // tracked-somewhere fallback already handles correctly and without any ref-specific reasoning (a
    // generated path's status doesn't depend on which ref is about to land) — reuse it rather than
    // duplicate that logic.
    return resolveHooksPathOverride(repoPath, worktreePath);
  }

  // `raw` itself is a submodule gitlink (mode 160000, tab !== -1) whose direct AND ancestor checks
  // both failed to find a verified match. No source is confirmed to match what `ref` will actually
  // check out: neither the base repo's copy nor (implicitly, since this function was only reached
  // because an override was needed) the worktree's own. Omitting the override is the safe choice —
  // no hook fires, rather than one built from stale content.
  return undefined;
}

async function git(cwd: string, args: string[], hooksPath?: string): Promise<string> {
  const configArgs = hooksPath ? ["-c", `core.hooksPath=${hooksPath}`] : [];
  const { stdout } = await execFileAsync("git", [...configArgs, "-C", cwd, ...args], {
    timeout: 120_000,
    maxBuffer: 16 * 1024 * 1024,
  });
  return stdout.trim();
}

/**
 * Paths from a `git diff --name-only`-style query, read exactly as they are on disk.
 *
 * `-z` is not a micro-optimization. Under git's default `core.quotePath`, a path holding a non-ASCII
 * byte, a quote, or a newline is printed C-QUOTED — `src/café/page.tsx` comes back as
 * `"src/caf\303\251/page.tsx"` — and every consumer here treats the result as a real path: the review
 * gate scopes the reviewer's binding instruction files by walking each changed path's ancestors, and
 * a mangled path walks the wrong chain, silently dropping a nested AGENTS.md the diff is bound by.
 * NUL-delimited output is the literal byte sequence, and it also survives a filename containing the
 * newline this would otherwise split on. Paths are NOT trimmed for the same reason — leading and
 * trailing whitespace are legal in a filename.
 */
async function diffPaths(cwd: string, args: string[]): Promise<string[]> {
  const { stdout } = await execFileAsync("git", ["-C", cwd, "diff", "-z", ...args], {
    timeout: 120_000,
    maxBuffer: 16 * 1024 * 1024,
  });
  return stdout.split("\0").filter(Boolean);
}

/**
 * Paths a SINGLE commit changed against its first parent, read exactly as on disk — the `git show`
 * analogue of {@link diffPaths}, untrimmed for the same reason: leading and trailing whitespace are
 * legal in a filename, so `git()`'s `stdout.trim()` would corrupt a path that begins or ends with
 * it (PR #255 review). ONE commit per call by design — a multi-commit `git show` interleaves a bare
 * `\n` between sections that `-z` does not suppress on every git, folding it onto the first path of
 * each later commit (PR #255 review).
 */
async function showPaths(cwd: string, sha: string): Promise<string[]> {
  const { stdout } = await execFileAsync(
    "git",
    ["-C", cwd, "show", "--name-only", "-z", "--format=", sha],
    { timeout: 120_000, maxBuffer: 16 * 1024 * 1024 },
  );
  return stdout.split("\0").filter(Boolean);
}

/**
 * Cap on the stderr kept from a spawned git. A command that fails on every path would otherwise
 * trade one unbounded buffer for another, and 4 KiB is plenty for the message a rejection carries.
 */
const MAX_STDERR_CHARS = 4096;

/**
 * Start collecting a spawned git's stderr, bounded at {@link MAX_STDERR_CHARS}; the returned getter
 * reads back what arrived, trimmed. Shared by every `spawn` here so the bound is stated once.
 */
function boundedStderr(child: ChildProcess): () => string {
  let text = "";
  child.stderr?.on("data", (chunk: Buffer) => {
    if (text.length < MAX_STDERR_CHARS) text += chunk.toString("utf8");
  });
  return () => text.trim();
}

/**
 * Run git and keep at most `maxChars` of its stdout, killing it the moment output overflows.
 *
 * For commands whose output has no useful upper bound. `git()` collects stdout through execFile's
 * fixed `maxBuffer` and THROWS on overflow, so a caller that means to truncate never gets the
 * chance: a generated lockfile or a vendored source update produces a patch past the cap and fails
 * the command outright. Cutting the stream puts the bound where the memory is actually spent, and
 * makes truncation the outcome rather than an error.
 *
 * The kill is not a failure: once the cap is reached the rest of the output is by definition
 * discarded, so the non-zero exit it produces is expected and `truncated` is the answer.
 */
function gitBounded(
  cwd: string,
  args: string[],
  maxChars: number,
): Promise<{ text: string; truncated: boolean }> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", ["-C", cwd, ...args], { timeout: 120_000 });
    // Decode incrementally so the cap counts characters, not bytes, and a multi-byte sequence split
    // across two chunks is never mangled.
    const decoder = new StringDecoder("utf8");
    const stderr = boundedStderr(child);
    let text = "";
    let truncated = false;
    let settled = false;
    const finish = (act: () => void) => {
      if (settled) return;
      settled = true;
      act();
    };

    child.stdout?.on("data", (chunk: Buffer) => {
      if (truncated) return;
      text += decoder.write(chunk);
      if (text.length <= maxChars) return;
      text = text.slice(0, maxChars);
      truncated = true;
      child.stdout?.destroy();
      child.kill("SIGKILL");
    });
    child.on("error", (e) => finish(() => reject(e)));
    child.on("close", (code) =>
      finish(() => {
        if (!truncated && code !== 0) {
          reject(new Error(`git ${args[0]} failed (exit ${code}): ${stderr()}`));
          return;
        }
        resolve({ text: truncated ? text : text + decoder.end(), truncated });
      }),
    );
  });
}

/**
 * Override the commit budget (tests shrink it so a hook that outlives the kill is reachable).
 * Read per call, so a change lands without a module reload.
 */
export const COMMIT_TIMEOUT_ENV = "ANTON_GIT_COMMIT_TIMEOUT_MS";

/** The same budget every other git call here runs under. */
const DEFAULT_COMMIT_TIMEOUT_MS = 120_000;

/** What a killed commit's group gets to tear itself down before SIGKILL follows. */
const COMMIT_KILL_GRACE_MS = 5_000;

/** How often a kill re-asks whether the commit's process group still has members. */
const REAP_POLL_MS = 25;

/**
 * Ceiling on waiting for a SIGKILLed group to disappear. SIGKILL is uncatchable, so anything still
 * standing past this is wedged in the kernel or has left the group by `setsid` — neither of which
 * more waiting fixes, and a run must never hang on it.
 */
const REAP_CEILING_MS = 2_000;

function commitTimeoutMs(): number {
  const raw = Number(process.env[COMMIT_TIMEOUT_ENV]);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_COMMIT_TIMEOUT_MS;
}

/**
 * Deliver `sig` to a commit's whole process GROUP — git and every hook it started — falling back to
 * the direct child handle when there is no group to signal (Windows, or a spawn that never formed
 * one).
 */
function signalCommitGroup(child: ChildProcess, sig: NodeJS.Signals): void {
  if (process.platform !== "win32" && child.pid) {
    try {
      process.kill(-child.pid, sig);
      return;
    } catch {
      // The group may never have formed (spawn failed); fall back to the direct child handle.
    }
  }
  child.kill(sig);
}

/** Whether every member of the commit's group is gone — git AND the hooks it started. */
function commitGroupGone(child: ChildProcess): boolean {
  if (!child.pid) return true; // spawn failed — there is no group to wait on
  if (process.platform === "win32") return child.exitCode !== null || child.signalCode !== null;
  try {
    process.kill(-child.pid, 0);
    return false;
  } catch (err) {
    // EPERM means members we cannot signal are still there; only ESRCH proves the group empty.
    return (err as NodeJS.ErrnoException).code === "ESRCH";
  }
}

/**
 * Kill a commit's process group and resolve only once it is GONE — SIGTERM, SIGKILL after the
 * grace, then poll until the group reports `ESRCH`.
 *
 * Bounded for the same reason `runShell`'s wait is: a group that cannot be reaped must not wedge the
 * run, and the caller's own cleanliness check is what catches whatever such a survivor writes. So
 * this ALWAYS resolves — the verdict it gates is the caller's to emit.
 */
function reapCommitGroup(child: ChildProcess): Promise<void> {
  return new Promise((done) => {
    signalCommitGroup(child, "SIGTERM");
    const escalate = setTimeout(() => {
      if (!commitGroupGone(child)) signalCommitGroup(child, "SIGKILL");
    }, COMMIT_KILL_GRACE_MS);
    const deadline = Date.now() + COMMIT_KILL_GRACE_MS + REAP_CEILING_MS;
    const wait = () => {
      if (commitGroupGone(child) || Date.now() >= deadline) {
        clearTimeout(escalate);
        done();
        return;
      }
      setTimeout(wait, REAP_POLL_MS);
    };
    wait();
  });
}

/**
 * The rejection a commit killed by its own budget carries. `killed: true` is load-bearing: callers
 * tell a timeout from git's own non-zero exit by it (see {@link exitedWith}).
 */
function commitTimedOut(args: string[], timeoutMs: number, stderr: string): Error {
  return Object.assign(
    new Error(
      `git ${args[0]} timed out after ${timeoutMs}ms and was killed with everything it spawned: ` +
        stderr,
    ),
    { killed: true },
  );
}

/** The rejection git's own non-zero exit carries, tagged with the status callers branch on. */
function commitFailed(args: string[], code: number | null, stderr: string): Error {
  return Object.assign(new Error(`git ${args[0]} failed (exit ${code}): ${stderr}`), { code });
}

/**
 * Run a `git commit` and return only once it — and every hook it spawned — is GONE (PR #228 review).
 *
 * Committing is the one git command anton runs that executes PROJECT code: `pre-commit` and
 * `commit-msg` hooks, run as children of git, free to write the worktree for as long as they like.
 * Under `execFile`'s timeout Node signals the direct `git` process alone, so a hook that outlives it
 * — one that traps SIGTERM, or that redirects the stdio it inherited and keeps going — is orphaned
 * ALIVE at the moment the caller is told the commit failed. That caller is the ticket-timeout
 * preserve, which reads the failure as a verdict and immediately hard-resets the worktree and checks
 * it clean: a late hook write then lands after the check and is swept into the next ticket's commit,
 * or is thrown away with the failed run's worktree.
 *
 * So the commit leads a process group of its own, and a timeout hands that group to
 * {@link reapCommitGroup} before any verdict is returned.
 *
 * Only the KILL path reaps. A commit that ends on its own already waited for its hooks — git runs
 * them synchronously — so there is nothing left to wait for.
 */
function gitCommit(cwd: string, args: string[], hooksPath?: string): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const configArgs = hooksPath ? ["-c", `core.hooksPath=${hooksPath}`] : [];
    // stdout is dropped rather than piped: nothing here reads it, and a chatty hook filling an
    // unread pipe would block the commit outright.
    const child = spawn("git", [...configArgs, "-C", cwd, ...args], {
      stdio: ["ignore", "ignore", "pipe"],
      detached: process.platform !== "win32",
    });
    const stderr = boundedStderr(child);
    const timeoutMs = commitTimeoutMs();
    let killing = false;
    let settled = false;
    const settle = (emit: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(budget);
      emit();
    };

    const budget = setTimeout(() => {
      killing = true;
      void reapCommitGroup(child).then(() =>
        settle(() => reject(commitTimedOut(args, timeoutMs, stderr()))),
      );
    }, timeoutMs);

    child.on("error", (err) => settle(() => reject(err)));
    child.on("close", (code) => {
      // A kill in flight owns the verdict: its group may still hold live writers.
      if (killing) return;
      settle(() => (code === 0 ? resolvePromise() : reject(commitFailed(args, code, stderr()))));
    });
  });
}

/** The tree mode of a symlink. Its blob holds the TARGET PATHNAME, not the linked file's content. */
const SYMLINK_MODE = "120000";

/**
 * Symlink hops followed before giving up. A rules file is one hop from its real home; a longer chain
 * — or a cycle — is not one, and returning undefined is the safe answer for every caller.
 */
const MAX_SYMLINK_HOPS = 4;

/**
 * Read one file as of `rev` (trimmed), or undefined when git reports it is not a file there.
 *
 * FAILS CLOSED: undefined means "git looked and it is absent", never "the read failed". A timeout, an
 * unreadable object, an unresolvable `rev` — anything but a successful absent answer — THROWS. The
 * callers are the review gate's trusted inputs (its reasoning contract and the rulebook it grades
 * against), and the reviewer is told the inlined rules are the only ones that grade the run: a
 * failure quietly returned as absence would swap the reviewer or drop binding rules, and pass work
 * that was never measured against them. Failing here parks the run for a human instead.
 *
 * For files the working tree must not be trusted to supply. `git show` serves the committed blob, so
 * a run that added or rewrote the path on its own branch cannot change what comes back.
 *
 * Symlinks are FOLLOWED inside the repo at the same `rev`, never returned raw: git stores a link as
 * a blob holding its target pathname, so a project that keeps `AGENTS.md` as a link to its real
 * rules file would otherwise hand the caller the one-line pathname where it asked for content — for
 * the review gate, an empty rulebook that reads as "this project states no rules".
 */
export async function readFileAtRev(
  worktreePath: string,
  rev: string,
  path: string,
): Promise<string | undefined> {
  return readBlobAtRev(worktreePath, rev, path, MAX_SYMLINK_HOPS);
}

async function readBlobAtRev(
  worktreePath: string,
  rev: string,
  path: string,
  hops: number,
): Promise<string | undefined> {
  const mode = await blobModeAtRev(worktreePath, rev, path);
  if (mode === undefined) return undefined;
  // `--` disambiguates a path that also parses as a revision. Deliberately uncaught: the tree above
  // just reported a blob at this path, so a `show` that fails is a failure to READ a file that is
  // there — a corrupt object, a timeout — and swallowing it would hand the caller the one answer it
  // must never infer, "this file does not exist".
  const text = await git(worktreePath, ["show", `${rev}:${path}`, "--"]);
  if (mode !== SYMLINK_MODE) return text;

  // Out-of-tree and runaway links resolve to nothing rather than to their pathname: there is no
  // content at `rev` to trust, and a caller that drops the path is right where one that inlines
  // "../../etc/rules.md" as the rules is not.
  if (hops <= 0) return undefined;
  const target = resolveRepoPath(path, text);
  return target ? readBlobAtRev(worktreePath, rev, target, hops - 1) : undefined;
}

/**
 * The tree mode of `path` at `rev`, or undefined when it is not a file there (missing, or a
 * directory). The mode is the only thing that tells a regular file from a symlink — both are blobs,
 * and `git show` reads them identically.
 *
 * An absent path is not an error to git: `ls-tree` exits 0 with EMPTY output for a pathspec that
 * matches nothing, which is what "not there" looks like here. So a rejection is something else
 * entirely — a rev that doesn't resolve, an unreadable object, a killed process — and it propagates
 * rather than being reported as absence (see {@link readFileAtRev}).
 */
async function blobModeAtRev(
  worktreePath: string,
  rev: string,
  path: string,
): Promise<string | undefined> {
  // -z: git quotes non-ASCII paths otherwise, and a quoted entry no longer splits on a literal tab.
  // `:(literal)`, because a pathspec is PARSED before it is matched: a repo whose directory name
  // starts with pathspec magic — `:(exclude)/rules.md` — makes git read the operand as an exclusion
  // and fail the command outright, which for the review gate means parking every run touching it.
  const out = await git(worktreePath, ["ls-tree", "-z", rev, "--", `:(literal)${path}`]);
  const entry = out.split("\0")[0];
  const tab = entry?.indexOf("\t") ?? -1;
  if (!entry || tab < 0) return undefined;
  const [mode, type] = entry.slice(0, tab).split(" ");
  return type === "blob" ? mode : undefined;
}

/**
 * Where a path written INSIDE the repo — a symlink's target, a rules file's `@path` import — points,
 * as a repo-relative path. Undefined when it leaves the repository: an absolute target, or one
 * climbing above the root.
 *
 * Resolved textually against `fromPath`'s own directory, because the answer must stay inside the
 * tree a `rev` names: following it out to the filesystem would read the machine anton happens to run
 * on, not the revision being read.
 */
export function resolveRepoPath(fromPath: string, target: string): string | undefined {
  const raw = target.trim();
  if (!raw || raw.startsWith("/")) return undefined;
  const resolved: string[] = [];
  for (const segment of [...fromPath.split("/").slice(0, -1), ...raw.split("/")]) {
    if (segment === "" || segment === ".") continue;
    if (segment !== "..") {
      resolved.push(segment);
      continue;
    }
    if (resolved.length === 0) return undefined;
    resolved.pop();
  }
  return resolved.length > 0 ? resolved.join("/") : undefined;
}

/**
 * Directories per `ls-tree` call. The command line is the bound: a diff touching thousands of
 * directories would otherwise hand the kernel an argument list past `ARG_MAX` and fail outright,
 * which for the review gate would silently mean "this project states no rules".
 */
const LS_TREE_BATCH = 500;

/**
 * Repo-relative paths of the FILES sitting directly in each of `dirs` as of `rev` — one tree read
 * per batch, so a caller can discover which of a set of files exist across many directories without
 * spawning a probe per candidate path.
 *
 * `""` reads the repo root. Directories absent at `rev` contribute nothing, and a directory NAMED
 * like the file being looked for is skipped (only blobs are returned), so a caller can treat every
 * path it gets back as readable content.
 *
 * FAILS CLOSED, like {@link readFileAtRev}: an empty result means git read the trees and found no
 * files, never that the read failed. `ls-tree` exits 0 with empty output for a directory absent at
 * `rev`, so anything that rejects — an unresolvable rev, an unreadable object, a killed process —
 * propagates. Swallowing it would tell the review gate this project states no rules, which is the
 * one conclusion it must never reach by accident.
 */
export async function listDirBlobsAtRev(
  worktreePath: string,
  rev: string,
  dirs: string[],
): Promise<string[]> {
  // `:(literal)`, for the same reason as {@link blobModeAtRev}: these operands are BUILT from the
  // diff's own directory names, and one that begins with pathspec magic (`:(exclude)/`) is parsed as
  // magic rather than matched as a directory — `fatal: outside repository`, which fails the read the
  // gate depends on instead of returning that scope's rules.
  const specs = dirs.map((dir) => `:(literal)${dir ? `${dir.replace(/\/+$/, "")}/` : "./"}`);
  const batches: string[][] = [];
  for (let i = 0; i < specs.length; i += LS_TREE_BATCH) batches.push(specs.slice(i, i + LS_TREE_BATCH));

  // -z: git quotes non-ASCII paths otherwise, and a quoted path matches nothing the caller asked for.
  const reads = await Promise.all(
    batches.map((batch) => git(worktreePath, ["ls-tree", "-z", rev, "--", ...batch])),
  );
  return reads.flatMap((text) =>
    text
      .split("\0")
      .map((line) => {
        const tab = line.indexOf("\t");
        if (tab < 0) return undefined;
        return line.slice(0, tab).split(" ")[1] === "blob" ? line.slice(tab + 1) : undefined;
      })
      .filter((path): path is string => path !== undefined),
  );
}

/**
 * The commit a branch forked from `base`, pinned as a SHA — or `base` itself when it names nothing
 * this repo can resolve, which is what the callers diffed against before and never a failure.
 *
 * Resolve ONCE and pass the SHA to everything that reads "at the base". A base like `origin/main`
 * is a MOVABLE ref: a concurrent run's fetch, or a resumed worktree, can advance it mid-review, and
 * a patch taken from the old fork point judged against rules read from the new tip is a review the
 * intervening commit silently rewrote the rules of.
 *
 * Which is why the no-merge-base case (unrelated histories — a resumed worktree whose base was
 * force-rewritten) still resolves the ref itself to a commit rather than handing the NAME back:
 * callers treat what they get as pinned, so returning `origin/main` would put every later read on
 * whatever that ref points at then, and a sibling run's fetch between two of them is exactly the
 * split baseline the pinning exists to rule out.
 *
 * A merge-base that FAILS rather than answers — a timeout, a killed process, an unreadable object —
 * THROWS when the base resolves anyway, instead of degrading to that fallback. The fallback returns
 * the base TIP, which on a base that has advanced is far past the real fork point: the gate would
 * review, and let the fixer rewrite, a diff measured against a commit the run never branched from.
 * Parking the run is the only honest answer to "I could not compute the fork point".
 */
export async function resolveMergeBase(worktreePath: string, base: string): Promise<string> {
  let brokenRead: unknown;
  try {
    return await git(worktreePath, ["merge-base", base, "HEAD"]);
  } catch (error) {
    // Exit 1 is merge-base's ANSWER — these histories share no commit — and falls through to the
    // pinning below. Any other rejection is the question failing; hold it, because the one thing
    // that still excuses it is a `base` that names nothing, which only `rev-parse` can settle.
    brokenRead = exitedWith(error, 1) ? undefined : error;
  }

  // `--verify --quiet`: exits 1 with no output when the ref doesn't resolve, instead of echoing the
  // argument back as if it were a revision. Its own operational failures propagate for the same
  // reason as merge-base's — an unpinned base name is not a safe answer to a read that broke.
  const pinned = await git(worktreePath, ["rev-parse", "--verify", "--quiet", `${base}^{commit}`]).catch(
    (error: unknown) => {
      if (exitedWith(error, 1)) return undefined;
      throw error;
    },
  );
  if (!pinned) return base;
  // The base DOES resolve, so a merge-base that failed was never "unrelated histories".
  if (brokenRead) throw brokenRead;
  return pinned;
}

/**
 * Whether a rejected git call is the command exiting with `code` — its own answer — rather than a
 * run that never got one. A process killed by a timeout carries `code: null` and a signal, and a
 * spawn failure carries a string errno, so neither is mistaken for an exit status.
 */
function exitedWith(error: unknown, code: number): boolean {
  const err = error as { code?: unknown; killed?: boolean } | null;
  return err?.code === code && err.killed !== true;
}

/**
 * Stage everything in the worktree and commit. Returns `{ committed: false }` when there is
 * nothing to commit (claude made no changes) — the caller decides whether that's acceptable.
 *
 * An empty index is NOT proof that nothing was delivered: an agent that committed its own work
 * (against the base contract, but it happens) leaves exactly the same empty index. Only HEAD tells
 * the two apart — see `commitStep`, which is the caller that has to.
 *
 * `bypassHooks` runs the commit with this project's hooks off, and a run's ordinary commits never
 * ask for it: hooks are the project's own gate on content, and anton has no standing to skip them.
 * Its one caller is the ticket-timeout preserve RETRYING a `WIP <id>:` commit that a hook refused
 * before anything landed (PR #228 review) — a tree the project's own verify gates have already
 * passed, on its way to a commit that is explicitly incomplete and in no pull request. That caller
 * proves the tree is still the verified one first, via {@link stageAllAndHashTree}: a hook that
 * EDITS before it rejects leaves a different tree, and `--no-verify` would commit those post-gate
 * edits under a proof that never covered them.
 */
export async function commitAll(
  worktreePath: string,
  message: string,
  options: { bypassHooks?: boolean; hooksPath?: string } = {},
): Promise<{ committed: boolean }> {
  await git(worktreePath, ["add", "-A"], options.hooksPath);
  const bypass = options.bypassHooks ? ["--no-verify"] : [];
  try {
    // Exits non-zero when there ARE staged changes → there is something to commit.
    await git(worktreePath, ["diff", "--cached", "--quiet"]);
    return { committed: false };
  } catch {
    await gitCommit(worktreePath, ["commit", ...bypass, "-m", message], options.hooksPath);
    return { committed: true };
  }
}

/**
 * Stage the whole worktree and return the hash of the tree a commit would write from it.
 *
 * How a caller tells the tree it VERIFIED from the tree it is about to commit. A `pre-commit` hook
 * that rewrites files and then rejects — lint-staged fixing one file and failing another — leaves
 * the working tree changed while HEAD stays put, so neither HEAD nor a rejection tells the two
 * apart; the tree hash does. Staging first because that is what `commitAll` commits from, and
 * untracked files count.
 */
export async function stageAllAndHashTree(worktreePath: string): Promise<string> {
  await git(worktreePath, ["add", "-A"]);
  return git(worktreePath, ["write-tree"]);
}

/**
 * True when `ancestor` is reachable from `descendant` — i.e. the branch only moved FORWARD between
 * them, adding commits without dropping or rewriting any.
 *
 * `step:commit` asks this before adopting work an agent committed itself: a moved HEAD is delivery
 * only if the commit the ticket started from is still on the branch. A `git reset --hard HEAD~1` or
 * an amend moves HEAD just as visibly while REMOVING history — on a multi-ticket run, possibly an
 * earlier ticket's commits — and adopting that would open a PR missing work anton has already
 * closed the bead for.
 *
 * Only git's own "no" (exit 1) is an answer; anything else propagates rather than reading as one.
 */
export async function isAncestor(
  worktreePath: string,
  ancestor: string,
  descendant: string,
): Promise<boolean> {
  try {
    await git(worktreePath, ["merge-base", "--is-ancestor", ancestor, descendant]);
    return true;
  } catch (e) {
    if (exitedWith(e, 1)) return false;
    throw e;
  }
}

/**
 * Record an EMPTY commit — a marker that carries a message and no diff.
 *
 * The callers are `step:commit` and the ticket-timeout preserve, both adopting work an agent
 * committed itself. Those commits are real and keep their own messages, but they don't carry the
 * `<ticketId>:` subject {@link worktreeHasCommitFor} reads (nor the `WIP <ticketId>:` one
 * {@link worktreeHasPreservedCommitFor} reads), so without a marker a resume cannot see that the
 * ticket's work is already on the branch and re-runs it — onto a tree where there is nothing left
 * to do.
 *
 * This project's hooks are ALWAYS bypassed here (PR #228 review). The marker is EMPTY by
 * construction, so there is no content for a `pre-commit` hook to have an opinion about and
 * no subject a `commit-msg` hook enforcing its own convention is entitled to cost a whole ticket's
 * work its only path back to a pull request. A hook that DID run could only do harm here: one that
 * stages files of its own — a formatter, a generator — either ships them under a message saying the
 * commit is empty, or leaves them loose in a worktree the NEXT ticket commits from, under a ticket
 * that never wrote them.
 *
 * `satisfies` names the OTHER tickets this commit's work also met (anton-6vxl), recorded as
 * {@link SATISFIES_TRAILER} trailers and read back by {@link readSatisfiedClaims}. Work often
 * lands under one ticket while completing a sibling's acceptance in full, and the `<id>:` subject
 * holds exactly one id — so the sibling is invisible to {@link worktreeHasCommitFor}, its run
 * zero-diffs, and a ticket that IS delivered is blocked as undelivered. Trailers carry the rest
 * without touching the subject, so the delivery and `WIP` prefixes keep the meanings every other
 * reader here depends on. The hook-bypass reasoning above applies unchanged: this is the same empty
 * marker, carrying more attribution in its body.
 */
export async function commitMarker(
  worktreePath: string,
  message: string,
  options: { satisfies?: string[]; hooksPath?: string } = {},
): Promise<void> {
  // `--allow-empty` PERMITS an empty commit; it does not FORCE one. Anything a caller happened to
  // leave staged would ship under a message saying this commit is empty, so the index is pinned to
  // HEAD first — the working tree is left alone, where a caller's cleanliness check can still see
  // whatever is in it.
  await git(worktreePath, ["reset", "--quiet", "--mixed", "HEAD"]);
  const body = withSatisfiesTrailers(message, options.satisfies);
  // `--no-verify` bypasses only `pre-commit` and `commit-msg` (git-commit(1)) — a generated,
  // base-only `post-commit` hook (Husky's `.husky/_`) still runs, and without `hooksPath` resolves
  // against this cold worktree, where it was never installed, silently skipping it (PR #263 review,
  // round 15) — the same gap {@link commitPreservedTree}'s bypass retry closed by passing its own
  // resolved path through instead of relying on `--no-verify` alone.
  await gitCommit(
    worktreePath,
    ["commit", "--allow-empty", "--no-verify", "-m", body],
    options.hooksPath,
  );
}

/**
 * The trailer key a marker records EXTRA ticket attribution under — the ids a commit's work
 * satisfied beyond the one named in its `<id>:` subject (anton-6vxl).
 *
 * A git trailer rather than more subject text, because the subject is already a load-bearing
 * protocol here: `<id>:` means delivered and `WIP <id>:` means preserved-and-incomplete, and both
 * are matched by PREFIX. A second id in the subject would either change what those prefixes mean or
 * be unreadable to the matchers; a trailer is invisible to them by construction. Git parses the
 * trailer block itself (`%(trailers:key=…)`), so anton is not writing a body-scraping parser of its
 * own.
 */
export const SATISFIES_TRAILER = "Anton-Satisfies";

/**
 * Append one {@link SATISFIES_TRAILER} line per satisfied ticket id, as its own trailer paragraph.
 *
 * One line per id, not a comma list: that is the trailer convention git's own parser is built for
 * (`Co-authored-by:` works the same way), so reading them back needs no splitting rule of anton's
 * invention. The block is separated by a blank line because git only recognises trailers in the
 * message's LAST paragraph — appended to the prose directly, they would be prose.
 *
 * Ids are validated rather than trusted: a value holding a newline would forge additional trailer
 * lines, and one holding a colon or leading whitespace can break the block's parse — so a malformed
 * id fails loudly here rather than silently recording attribution that reads back as something else.
 */
function withSatisfiesTrailers(message: string, satisfies: string[] | undefined): string {
  const ids = [...new Set(satisfies ?? [])];
  if (ids.length === 0) return message;
  for (const id of ids) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id)) {
      throw new Error(`${SATISFIES_TRAILER}: unusable ticket id ${JSON.stringify(id)}`);
    }
  }
  const trailers = ids.map((id) => `${SATISFIES_TRAILER}: ${id}`).join("\n");
  return `${message.replace(/\s+$/, "")}\n\n${trailers}\n`;
}

/**
 * The subject an ATTRIBUTION marker carries — the empty commit that credits `ticketId` to the
 * commit which actually did its work (PR #258 review).
 *
 * Deliberately not `<id>:` or `WIP <id>:`: both are matched by prefix and both mean a commit of the
 * ticket's OWN, which a satisfied ticket never produced. The satisfying commit is named in the
 * subject by FULL sha, so the marker is readable by a person at a glance and resolvable by
 * {@link satisfiedMarkerTarget} without a second lookup — the marker sits at the branch tip when it
 * is written, so the NEXT satisfied ticket's agent names IT, and following the reference is what
 * keeps every marker pointing at the work rather than at a chain of markers.
 */
export function satisfiedMarkerSubject(ticketId: string, commit: string): string {
  return `anton: ${ticketId} satisfied by ${commit}`;
}

/** Same id shape {@link withSatisfiesTrailers} accepts — anything else is not a marker anton wrote. */
const SATISFIED_MARKER_SUBJECT = /^anton: [A-Za-z0-9][A-Za-z0-9._-]* satisfied by ([0-9a-f]{40})$/;

/**
 * The commit an attribution marker credits, or `undefined` when this subject is not one.
 *
 * Read by the settlement so a ticket satisfied while a marker sat at the tip is recorded against
 * the WORK, not against the marker for a sibling. Only a full sha is followed: an abbreviation
 * cannot be told from prose that happens to end in hex, and the writer above always emits one.
 */
export function satisfiedMarkerTarget(subject: string): string | undefined {
  return SATISFIED_MARKER_SUBJECT.exec(subject.trim())?.[1];
}

/** A commit and the ticket ids its message claims to have satisfied (anton-6vxl). */
export interface SatisfiedClaim {
  /** Full sha of the commit making the claim — which commit said so, not merely that something did. */
  sha: string;
  subject: string;
  /** Every id claimed via {@link SATISFIES_TRAILER}, in the order the commit lists them. */
  ticketIds: string[];
}

/**
 * Every sibling-attribution claim on the branch, newest commit first — commits claiming nothing are
 * omitted entirely.
 *
 * Each claim carries its own sha, so a caller can say WHICH commit satisfied a ticket rather than
 * only that the branch holds such a commit somewhere: that sha is what a bead note, a PR body or an
 * operator investigating a skip is owed. Fails closed to none, exactly as {@link branchCommits}
 * does and for the same reason — a `git log` that failed is not proof a ticket was satisfied, and
 * the safe error here is re-running work rather than skipping it.
 */
export async function readSatisfiedClaims(
  worktreePath: string,
  options: { strict?: boolean } = {},
): Promise<SatisfiedClaim[]> {
  const commits = await branchCommits(worktreePath, options);
  return commits.flatMap((c) =>
    c.satisfies.length > 0 ? [{ sha: c.sha, subject: c.subject, ticketIds: c.satisfies }] : [],
  );
}

/**
 * True when some commit on the branch claims to have satisfied `ticketId` — the sibling-attribution
 * counterpart to {@link worktreeHasCommitFor}, which reads only the dispatched ticket's `<id>:`
 * subject.
 *
 * Returns the CLAIM, not a boolean: the caller that skips a ticket on this evidence has to be able
 * to say which commit it skipped on. Match is EXACT, never by prefix — `anton-jz1.2` satisfying
 * something says nothing about `anton-jz1`, the same collision {@link worktreeHasCommitFor} guards
 * against in its subject scan. Fails closed to `undefined` with {@link readSatisfiedClaims}.
 */
export async function branchSatisfiesTicket(
  worktreePath: string,
  ticketId: string,
  options: { strict?: boolean } = {},
): Promise<SatisfiedClaim | undefined> {
  const claims = await readSatisfiedClaims(worktreePath, options);
  return claims.find((c) => c.ticketIds.includes(ticketId));
}

export async function hasRemote(repoPath: string, name = "origin"): Promise<boolean> {
  try {
    await git(repoPath, ["remote", "get-url", name]);
    return true;
  } catch {
    return false;
  }
}

/**
 * Push `branch` to `origin`, run from `cwd` — the run's WORKTREE when the caller has one, never the
 * base repo checkout. `git push` itself only needs the shared object database (a worktree and its
 * base checkout are the same repository), so pushing from either succeeds identically — but a
 * project's own `pre-push` hook can't tell the difference: a hook that diffs the working tree against
 * the commits being pushed (a "did you forget to commit a fix" check) reads whatever branch happens
 * to be checked out at `cwd`. Run from the base repo, that is whatever the last execute-epic run left
 * it on — unrelated to the branch actually being pushed — so the hook compares two unrelated trees
 * and fails almost every push. Run from the worktree, `cwd`'s checkout IS the branch being pushed, so
 * the hook sees what it expects.
 */
export async function pushBranch(cwd: string, branch: string, hooksPath?: string): Promise<void> {
  await git(cwd, ["push", "-u", "origin", branch], hooksPath);
}

/**
 * Serialize `git fetch`es that write a SHARED tracking ref, per repository. git takes a per-ref lock
 * while updating a ref, so two fetches racing to write the SAME ref leave the loser dead with
 * `cannot lock ref '…' is at … but expected …`. {@link resolveFreshBase} and {@link refreshCheckout}
 * both write `refs/remotes/origin/<base>` so a later step can branch off it; chaining per repo keeps
 * that ref uncontended.
 *
 * The chain lives on `globalThis`, not in module scope: Next compiles the instrumentation/job-runner
 * bundle and the request graph into SEPARATE module registries (see lib/build/drift.ts), so a
 * module-local map is duplicated — a fetch in one registry cannot see the chain the other holds, and
 * the two race the ref lock anyway. A `Symbol.for`-keyed slot both registries read makes the
 * serialization process-wide (PR #257 review). It does NOT cover separate anton processes on the same
 * repo — those still contend at the git layer — but every caller here fails SAFE on a lost lock (a
 * fallback to the local base, a transient drift retried next pass), never open into stale code. The
 * freshness read that WAS fail-open ({@link distanceBehindUpstream}) no longer writes a shared ref at
 * all, so it needs no serialization: it fetches into a private per-read ref instead.
 */
const FETCH_CHAINS_KEY = Symbol.for("anton.git.fetchChains");
function fetchChains(): Map<string, Promise<void>> {
  const store = globalThis as unknown as Record<symbol, Map<string, Promise<void>> | undefined>;
  return (store[FETCH_CHAINS_KEY] ??= new Map());
}
function serializeFetch<T>(repoPath: string, fn: () => Promise<T>): Promise<T> {
  const chains = fetchChains();
  const prior = chains.get(repoPath) ?? Promise.resolve();
  // Run after any prior fetch SETTLES — success or failure — so the ref lock is never contended.
  const result = prior.then(fn, fn);
  // The chain tail must never reject, or one failed fetch would poison every fetch queued behind it.
  const tail = result.then(
    () => {},
    () => {},
  );
  chains.set(repoPath, tail);
  // Drop the entry once this is the last fetch queued, so the map does not grow one slot per repo forever.
  void tail.then(() => {
    if (chains.get(repoPath) === tail) chains.delete(repoPath);
  });
  return result;
}

/** Fetch refs from origin (all refs when none given). Serialized per repo — see {@link serializeFetch}. */
export async function fetchOrigin(repoPath: string, refs: string[] = []): Promise<void> {
  await serializeFetch(repoPath, () => git(repoPath, ["fetch", "origin", ...refs]));
}

/**
 * Resolve the freshest usable base ref for a new worktree (anton-l0h). Fetches `origin/<base>` and
 * returns `"origin/<base>"` so the job layer can branch off the remote tip. Best-effort: if the
 * repo has no `origin` remote, or the fetch fails (offline, auth, deleted ref), it logs loudly and
 * falls back to the local `<base>` so a run is never blocked on network access. Only updates the
 * remote-tracking ref — no local branch is mutated.
 */
export async function resolveFreshBase(repoPath: string, base: string): Promise<string> {
  if (!(await hasRemote(repoPath))) {
    // No origin (e.g. a local-only repo) — nothing to fetch; branch off the local base.
    return base;
  }
  const trackingRef = `refs/remotes/origin/${base}`;
  try {
    // Explicit destination refspec: a bare `git fetch origin <base>` honours origin's configured
    // fetch refspec, so in repos with a custom or missing refspec it can succeed while only
    // updating FETCH_HEAD — leaving `origin/<base>` stale or absent. Naming the destination forces
    // the remote-tracking ref to be written; `+` allows a non-fast-forward update.
    await fetchOrigin(repoPath, [`+refs/heads/${base}:${trackingRef}`]);
    // Confirm the ref actually resolves before branching a run off it (throws → fall back).
    await git(repoPath, ["rev-parse", "--verify", "--quiet", trackingRef]);
    return `origin/${base}`;
  } catch (e) {
    console.warn(
      `[git] fetch of origin/${base} in ${repoPath} failed; falling back to local ${base}`,
      e,
    );
    return base;
  }
}

/**
 * Merge `ref` into the branch checked out in `worktreePath`. A conflicted merge is left in
 * progress (markers in the tree, MERGE_HEAD set) and the conflicted paths are returned — the
 * caller has claude resolve the markers and a later `commitAll` concludes the merge. A merge that
 * fails for any other reason (e.g. untracked files in the way) is aborted and rethrown.
 */
export async function mergeIntoCurrent(
  worktreePath: string,
  ref: string,
  opts?: { ffOnly?: boolean; hooksPath?: string },
): Promise<{ ok: boolean; conflicts: string[] }> {
  try {
    await git(
      worktreePath,
      ["merge", "--no-edit", ...(opts?.ffOnly ? ["--ff-only"] : []), ref],
      opts?.hooksPath,
    );
    return { ok: true, conflicts: [] };
  } catch (e) {
    const conflicts = await diffPaths(worktreePath, ["--name-only", "--diff-filter=U"]).catch(() => []);
    if (conflicts.length === 0) {
      await git(worktreePath, ["merge", "--abort"]).catch(() => {});
      throw e;
    }
    return { ok: false, conflicts };
  }
}

/**
 * True when `branch` has local commits not yet on `origin/<branch>` — i.e. there is work to push.
 * Used by review-fix to decide whether a prior (crash/retry) fix is still unpushed even when the
 * current claude run produced no new commit. If the remote-tracking ref is unknown, assume ahead
 * (safer to attempt a no-op push than to silently skip real work).
 */
export async function branchAheadOfRemote(
  repoPath: string,
  branch: string,
  remote = "origin",
): Promise<boolean> {
  try {
    const out = await git(repoPath, ["rev-list", "--count", `${remote}/${branch}..${branch}`]);
    return Number(out.trim()) > 0;
  } catch {
    return true;
  }
}

/** How the checked-out branch stands against its configured upstream — see {@link distanceBehindUpstream}. */
export type UpstreamDistance =
  | { state: "current" }
  | { state: "behind"; behind: number; upstream: string }
  | { state: "no-upstream" }
  | { state: "unreachable"; reason: string };

/**
 * How far the checked-out branch trails its configured upstream — the git read behind the
 * self-freshness preflight (anton-vzhf): "is this checkout running the latest code its own remote
 * carries".
 *
 * Contacts the remote — a network READ that fetches the upstream branch into its tracking ref; it
 * never pushes — so the answer reflects what the remote holds NOW rather than whatever the last fetch
 * left cached. A fetch that fails is its OWN verdict (`unreachable`), never folded into "current": an
 * offline runner must not be told it is up to date. A branch with no upstream — a detached HEAD, an
 * unpushed branch, no `branch.<name>.remote` — is `no-upstream`, also distinct from current.
 *
 * Only the FETCH's failure is caught. Every other git failure propagates, so the caller reports the
 * check itself as broken rather than infer a distance from a read that never answered.
 */
export async function distanceBehindUpstream(repoPath: string): Promise<UpstreamDistance> {
  const branch = await git(repoPath, ["symbolic-ref", "--short", "--quiet", "HEAD"]).catch(
    (e: unknown) => {
      if (exitedWith(e, 1)) return ""; // detached HEAD — no branch to carry an upstream
      throw e;
    },
  );
  if (!branch) return { state: "no-upstream" };

  // `branch.<name>.remote` + `.merge` are the upstream, read straight from config rather than parsed
  // out of `@{upstream}`: a remote or branch name holding a `/` survives the split this way.
  const config = (key: string) =>
    git(repoPath, ["config", "--get", key]).catch((e: unknown) => {
      if (exitedWith(e, 1)) return ""; // unset key — the branch simply has no upstream
      throw e;
    });
  const [remote, mergeRef] = await Promise.all([
    config(`branch.${branch}.remote`),
    config(`branch.${branch}.merge`),
  ]);
  if (!remote || !mergeRef.startsWith("refs/heads/")) return { state: "no-upstream" };

  const remoteBranch = mergeRef.slice("refs/heads/".length);
  const upstream = `${remote}/${remoteBranch}`;
  // Fetch the upstream into a PRIVATE, per-read ref instead of the shared tracking ref, so this
  // freshness read never contends on a ref lock — not with a concurrent read in another Next module
  // registry (ops.ts is duplicated across bundles), nor with another anton process on the same repo.
  // Serializing per process could cover neither, and a lost lock here is caught as `unreachable` —
  // the indeterminate verdict the fail-open preflight lets a stale start through on (PR #257 review).
  // A unique destination ref means no two fetches ever write the same ref, so none can lose it.
  const scratchRef = `refs/anton/freshness/${randomUUID()}`;
  try {
    // `--refmap=` drops the remote's CONFIGURED refspec so this fetch writes ONLY the private ref
    // named on the command line — without it, git ALSO honours `+refs/heads/*:refs/remotes/origin/*`
    // and updates the shared tracking ref, reintroducing the very lock contention the unique ref
    // exists to avoid. `+` allows a non-fast-forward update of the private ref.
    await git(repoPath, ["fetch", "--refmap=", remote, `+${mergeRef}:${scratchRef}`]);
  } catch (e) {
    return { state: "unreachable", reason: e instanceof Error ? e.message : String(e) };
  }
  try {
    const behind = Number(await git(repoPath, ["rev-list", "--count", `HEAD..${scratchRef}`]));
    if (!Number.isFinite(behind)) throw new Error(`could not count commits behind ${upstream}`);
    return behind > 0 ? { state: "behind", behind, upstream } : { state: "current" };
  } finally {
    // Best-effort cleanup — a unique ref a crash leaves behind is harmless (nothing else reads it),
    // so a failed delete never changes the verdict.
    await git(repoPath, ["update-ref", "-d", scratchRef]).catch(() => {});
  }
}

/**
 * True when the branch checked out in `worktreePath` already contains the commit for `ticketId` —
 * a commit whose subject starts with `<ticketId>:` (the shape execute-epic's `commitAll` writes).
 *
 * execute-epic's ticket loop uses this to tell a ticket that is done AND whose work lives on THIS
 * branch apart from one merely marked done on the shared board (anton-jz1). Board state propagates
 * cross-machine via `bd sync`, but the branch is pushed only at PR time — so a ticket another
 * machine closed then crashed on (before opening the PR) has its commit solely in that machine's
 * local, never-pushed worktree. Skipping such a ticket on board state alone would open the epic's PR
 * missing that work. A run's own ticket commits are always at the branch tip, so bounding the scan
 * is safe. Fails closed to `false` (git error → treat as absent → re-run) rather than risk a skip.
 */
export async function worktreeHasCommitFor(
  worktreePath: string,
  ticketId: string,
): Promise<boolean> {
  return (await branchSubjects(worktreePath)).some((s) => s.startsWith(`${ticketId}:`));
}

/**
 * The subject prefix a timed-out ticket's PRESERVED work carries (anton-d967) — deliberately NOT
 * `<ticketId>:`, the delivery attribution {@link worktreeHasCommitFor} reads. Preserved work is on
 * the branch and is still nobody's delivery, so a resume must RUN the ticket rather than skip it.
 */
export function preservedCommitPrefix(ticketId: string): string {
  return `WIP ${ticketId}:`;
}

/**
 * True when the branch carries the commit a timed-out attempt preserved for this ticket.
 *
 * `step:commit` reads it on the resume that follows: the preserved commit IS this ticket's work, so
 * an agent that finds nothing left to do has delivered it, not delivered nothing. Without this read
 * the code-finished/bookkeeping-cut-short case can never reach a pull request — every resume ends in
 * a zero diff and parks the run again.
 *
 * `strict` is for the caller whose SAFE answer is the other one (PR #228 review). "No preserved
 * commit" lets the shape guard dispatch children onto this branch, so a `git log` that failed or
 * timed out must not be read as proof of absence — it is no answer at all, and the guard is owed
 * the failure rather than a permissive default.
 */
export async function worktreeHasPreservedCommitFor(
  worktreePath: string,
  ticketId: string,
  options: { strict?: boolean } = {},
): Promise<boolean> {
  const prefix = preservedCommitPrefix(ticketId);
  return (await branchSubjects(worktreePath, options)).some((s) => s.startsWith(prefix));
}

/**
 * True when the branch TIP is this ticket's preserved (`WIP <id>:`) commit — the question the
 * self-committed-work adoption asks before deciding a fresh marker is unnecessary (PR #255 review).
 *
 * History-wide presence ({@link worktreeHasPreservedCommitFor}) is NOT the same question, and using
 * it here loses work: an older marker sitting BENEATH newer self-commits does not cover them, so the
 * resume's newest `WIP` would no longer be the preserved tip and its `baseline..tip` range would omit
 * the latest commits. Only a marker AT the tip covers everything down to the baseline. Fails closed
 * to `false` — the answer that makes a marker, never the one that skips it — like
 * {@link worktreeHasPreservedCommitFor}.
 */
export async function worktreeTipIsPreservedCommitFor(
  worktreePath: string,
  ticketId: string,
  options: { strict?: boolean } = {},
): Promise<boolean> {
  const prefix = preservedCommitPrefix(ticketId);
  const [tip] = await branchCommits(worktreePath, options);
  return tip !== undefined && tip.subject.startsWith(prefix);
}

/** A timed-out attempt's preserved commit, as the resume's dispatch prompt describes it. */
export interface PreservedCommit {
  /** Full sha of the NEWEST preserved commit — the tip of this ticket's preserved work. */
  sha: string;
  subject: string;
  /**
   * The paths changed across the WHOLE preserved delta (anton-16pq): a ticket can time out more than
   * once, and each timeout adds only its own delta, so the newest commit alone omits what earlier
   * ones kept. With {@link baseline} known this is the single diff `baseline..sha`, which also
   * captures a first attempt's SELF-committed work living beneath an empty marker — a per-commit
   * union would see the (empty) marker and miss it (PR #255 review). `[]` is ambiguous — the marker
   * form (empty newest commit, work beneath) OR a range that nets to nothing though the newest
   * commit is non-empty (earlier edits undone by later ones) — so {@link newestEmpty} disambiguates
   * it for the prompt. `undefined` means the diff could NOT be read: a git failure is not an empty
   * commit, and the prompt must not present a failed read as proof nothing was kept.
   */
  files: string[] | undefined;
  /**
   * The OLDER preserved commits beneath {@link sha}, newest first — non-empty only when the ticket
   * timed out more than once. Their work is on the branch too, so the prompt sends the agent across
   * all of them rather than only the newest.
   */
  earlier: { sha: string; subject: string }[];
  /**
   * The ticket's fork point, when it resolved to a commit — the START of the range holding ALL of
   * this run's preserved work, self-committed commits included (anton-16pq). The prompt points
   * `git show baseline..sha` at it. Absent when the base could not be resolved; the prompt then
   * falls back to a marker-relative range.
   */
  baseline?: string;
  /**
   * Whether the NEWEST preserved commit is itself empty — the signal that disambiguates a `[]`
   * {@link files} (PR #255 review). An empty newest commit is the marker form: the work is in the
   * commits beneath it. A non-empty newest commit whose `baseline..sha` range still nets to `[]` is
   * NOT a marker — earlier attempts' edits were undone by later ones — and the prompt must not point
   * the agent beneath it. `undefined` when git could not be read (the newest commit's own diff), in
   * which case the prompt keeps the pre-existing marker wording rather than guess.
   */
  newestEmpty?: boolean;
}

/**
 * The preserved commits themselves, for the prompt that tells a RESUMED ticket its earlier attempts'
 * work is already on the branch (anton-16pq).
 *
 * ALL matching commits are collected, not just the newest: a ticket can time out more than once, and
 * each preserve holds only the delta since the last, so the newest commit alone hides what the
 * earlier ones kept — the agent must be pointed at the whole range. Fails closed to `undefined` for
 * the same reason {@link worktreeHasPreservedCommitFor} fails closed to `false` — a git read that
 * failed is not proof of absence, but the only cost here is a prompt that says nothing extra, and a
 * dispatch is never worth failing over a paragraph of prose. A diff that fails AFTER the history
 * lookup succeeds is carried as `files: undefined`, distinct from the marker's `[]`, so the prompt
 * never reads a failed read as an empty commit.
 *
 * `baseRef` is the fork point to measure the preserved delta against. Resolving it lets the prompt
 * point at `baseline..sha`, which — unlike a per-commit union — includes a first attempt's
 * self-committed work beneath an empty marker (PR #255 review). It is OPTIONAL and best-effort: a
 * base that will not resolve to a commit drops the range to the marker-relative fallback rather than
 * failing the read.
 */
export async function readPreservedCommitFor(
  worktreePath: string,
  ticketId: string,
  baseRef?: string,
): Promise<PreservedCommit | undefined> {
  const prefix = preservedCommitPrefix(ticketId);
  const matches = (await branchCommits(worktreePath)).filter((c) => c.subject.startsWith(prefix));
  const [newest, ...earlier] = matches;
  if (!newest) return undefined;
  // Only a fork point that resolved to a real commit is usable as a `git show` range endpoint —
  // resolveMergeBase hands back the base NAME verbatim when it names nothing, and that is no
  // revision to diff or show.
  const resolved = baseRef
    ? await resolveMergeBase(worktreePath, baseRef).catch(() => undefined)
    : undefined;
  const baseline = resolved && /^[0-9a-f]{40}$/.test(resolved) ? resolved : undefined;
  // The newest commit's OWN diff, kept apart from the aggregate `files`: only it tells a genuine
  // empty marker from a range that nets to nothing (PR #255 review).
  const newestOwnFiles = await showPaths(worktreePath, newest.sha).catch(() => undefined);
  return {
    sha: newest.sha,
    subject: newest.subject,
    earlier,
    baseline,
    files: await preservedFiles(worktreePath, matches, baseline),
    newestEmpty: newestOwnFiles === undefined ? undefined : newestOwnFiles.length === 0,
  };
}

/**
 * The union of paths changed across the whole preserved delta — `undefined` on a git failure (an
 * unknown/error state the prompt keeps distinct from a genuine empty marker), `[]` when nothing
 * changed.
 *
 * With `baseline` known, the answer is the single diff `baseline..newest`: it spans self-committed
 * work beneath an empty marker as well as the markers, which a per-commit union of the markers alone
 * would miss (PR #255 review). Without a fork point it falls back to a per-commit union — one
 * {@link showPaths} per marker, so a multi-commit `git show`'s inter-section `\n` never folds onto a
 * path. Both read paths are `-z` (under `core.quotePath` a non-ASCII path comes back C-quoted, and
 * the prompt would name a file not on disk) and untrimmed (leading/trailing whitespace is a legal
 * filename), and both fail closed to `undefined`.
 */
async function preservedFiles(
  worktreePath: string,
  commits: { sha: string }[],
  baseline: string | undefined,
): Promise<string[] | undefined> {
  const newest = commits[0]?.sha;
  if (!newest) return [];
  if (baseline) {
    return diffPaths(worktreePath, ["--name-only", "--no-renames", baseline, newest]).catch(
      () => undefined,
    );
  }
  const perCommit = await Promise.all(commits.map((c) => showPaths(worktreePath, c.sha))).catch(
    () => undefined,
  );
  return perCommit === undefined ? undefined : [...new Set(perCommit.flat())];
}

/**
 * How far back a branch scan reads. A run's own commits are always at the branch tip.
 *
 * Three NUL-separated fields per commit — sha, subject, and the {@link SATISFIES_TRAILER} values —
 * and `-z` to NUL-terminate each RECORD. A subject may contain anything a person can type, so every
 * printable separator is one a commit message could forge; NUL is the one byte git refuses to store
 * in a message at all ("a NUL byte in commit log message not allowed"), which is what makes this
 * framing unforgeable rather than merely unlikely. The trailer VALUES are joined by US (`%x1F`)
 * instead, since a NUL there would be indistinguishable from a field break.
 *
 * `%(trailers:…)` is git's own trailer parser, so a `Anton-Satisfies:`-looking line in the middle of
 * a prose body is correctly NOT a trailer — only the message's final block is.
 */
const BRANCH_LOG_ARGS = [
  "log",
  "-z",
  `--format=%H%x00%s%x00%(trailers:key=${SATISFIES_TRAILER},valueonly,separator=%x1F)`,
  "-n",
  "1000",
];

/** Splits the trailer field's US-joined values; a commit claiming nothing yields `[]`. */
const TRAILER_VALUE_SEPARATOR = "\u001f";

/**
 * The commits at the tip of the branch checked out in `worktreePath`, newest first, each with the
 * ticket ids its message claims to have satisfied. Fails closed to none (git error → treat as
 * absent) rather than risk a skip — except under `strict`, where absence is the permissive answer
 * and the caller has asked to see the failure instead.
 */
async function branchCommits(
  worktreePath: string,
  options: { strict?: boolean } = {},
): Promise<{ sha: string; subject: string; satisfies: string[] }[]> {
  const log = options.strict
    ? await git(worktreePath, BRANCH_LOG_ARGS)
    : await git(worktreePath, BRANCH_LOG_ARGS).catch(() => "");
  // `-z` NUL-TERMINATES each record and each `%x00` separates a field within it, so the stream is a
  // flat run of NUL-delimited fields, three per commit, with one empty segment left by the final
  // terminator. Grouping by threes is exact rather than heuristic: git stores no NUL in a commit
  // message, so no field can contain the delimiter and no commit can shift the grouping.
  const fields = log.split("\0");
  const commits: { sha: string; subject: string; satisfies: string[] }[] = [];
  for (let i = 0; i + 2 < fields.length; i += 3) {
    const [sha, subject, trailers] = [fields[i], fields[i + 1], fields[i + 2]];
    if (!sha || subject === undefined || trailers === undefined) continue;
    commits.push({
      sha,
      subject,
      satisfies: trailers
        .split(TRAILER_VALUE_SEPARATOR)
        .map((v) => v.trim())
        .filter(Boolean),
    });
  }
  return commits;
}

/** The branch's commit subjects — {@link branchCommits} for the readers that only match on text. */
async function branchSubjects(
  worktreePath: string,
  options: { strict?: boolean } = {},
): Promise<string[]> {
  return (await branchCommits(worktreePath, options)).map((c) => c.subject);
}

/**
 * True when `commit` is reachable from `branch` in `repoPath` — "the work is in what this run
 * ships", asked of git rather than inferred from a branch NAME (PR #227 review).
 *
 * anton's branches are deterministic per target, so a note recording a commit on `anton/<id>` says
 * nothing about this machine: a run resumed elsewhere derives the same name over a worktree cut from
 * origin, while the commit itself was never pushed and lives only where it was made — the same
 * cross-machine gap {@link worktreeHasCommitFor} closes for the dispatch loop. Asked of the
 * REPOSITORY, not a checkout, because worktrees share refs and objects: the answer holds for the
 * run's worktree whether or not it exists yet, and a branch this machine has never seen resolves
 * nowhere.
 *
 * Fails closed to `false` (unknown sha, missing branch, git error). "Absent" leaves the work in the
 * operator's hands; "present" is what licenses settling the board over it.
 */
export async function branchContainsCommit(
  repoPath: string,
  branch: string,
  commit: string,
): Promise<boolean> {
  return git(repoPath, ["merge-base", "--is-ancestor", commit, branch]).then(
    () => true,
    () => false,
  );
}

/**
 * True when `commit` is among the commits `branch` ADDED over `base` — reachable from the branch
 * and not from the base — asked of the repository exactly as {@link branchContainsCommit} is.
 *
 * This is the evidence behind a `satisfied` self-report (anton-nuft): the agent claims an EARLIER
 * commit of this run already did its step's work, and the gate settles on the branch, never on the
 * claim. "On the branch" alone is too weak a test, because every commit of the base is on the branch
 * too — the fork point, or anything merged in from `main` — and none of them is work this run did.
 * A claim naming one is the zero-diff false success the gate exists to catch, dressed as evidence.
 *
 * Fails closed to `false` on every git error: an unknown or ambiguous sha, a branch or base this
 * machine never had, an unreadable repository. Only git's own "not an ancestor of the base" (exit 1)
 * is the answer that settles the step; a broken read of the base is no evidence that the commit is
 * the run's own.
 */
export async function branchAddedCommit(
  repoPath: string,
  branch: string,
  base: string,
  commit: string,
): Promise<boolean> {
  if (!(await branchContainsCommit(repoPath, branch, commit))) return false;
  try {
    await git(repoPath, ["merge-base", "--is-ancestor", commit, base]);
    return false;
  } catch (e) {
    return exitedWith(e, 1);
  }
}

/**
 * The full sha and subject line of `ref`, as the repository resolves it — undefined when it names
 * nothing, or names more than one thing.
 *
 * This is what a satisfied step is RECORDED against (anton-8h4b): the agent names a commit by
 * whatever abbreviation it read off `git log`, and the gate accepts it on the strength of the branch
 * ({@link branchAddedCommit}). An abbreviation is unambiguous today and may not be next year, so the
 * bead and the pull request cite the full sha; the subject is the attribution a reader wants, since
 * anton subjects its own commits `<ticket-id>: <title>`.
 */
export async function describeCommit(
  repoPath: string,
  ref: string,
): Promise<{ sha: string; subject: string } | undefined> {
  try {
    const out = await git(repoPath, ["log", "-1", "--format=%H%n%s", `${ref}^{commit}`, "--"]);
    const [sha, subject = ""] = out.trim().split("\n");
    return sha && /^[0-9a-f]{40}$/.test(sha) ? { sha, subject: subject.trim() } : undefined;
  } catch {
    return undefined;
  }
}

/**
 * What git's history says became of `path` on this branch — the raw read behind the `ref-stale`
 * repair (anton-fzas / R5.4). It reports; it does not judge. Whether a single destination is a
 * rename anton may follow, or a pointer it must refuse to guess at, is
 * `gardener/repair-ref-stale.ts`'s call.
 */
export interface PathHistory {
  /**
   * Every DISTINCT path this one was renamed to, newest commit first. More than one means the name
   * has stood for more than one file over the branch's life — history the caller cannot resolve.
   */
  renamedTo: string[];
  /**
   * How many commits renamed the path AWAY — the occurrences behind `renamedTo`, before the
   * de-duplication (PR #223 review). Two renames to the SAME destination is not one rename: the
   * path had to be recreated in between, so the name has stood for two files exactly as two
   * distinct destinations would mean, and only the count says so.
   */
  renames: number;
  /** A commit removed the path with no rename paired to the removal. */
  deleted: boolean;
}

/** How far back the removal scan reads. A path removed more times than this is not a clean rename. */
const MAX_PATH_REMOVALS = 20;

/** `R<score>\told\tnew` / `D\told` — the only two name-status verbs this read cares about. */
const RENAME_STATUS = /^R\d*\t([^\t]+)\t([^\t]+)$/;
const DELETE_STATUS = /^D\t([^\t]+)$/;

/**
 * Follow a path that is gone from the tree to wherever git recorded it going.
 *
 * TWO commands, because pathspec filtering DISABLES git's rename detection: under `-- <path>` the
 * SOURCE side of a rename is reported as a plain `D` and the destination never appears at all. So
 * the pathspec is used only to find the commits where the path disappeared — cheap, and exactly the
 * candidate set — and each of those is re-diffed WITHOUT a pathspec, where `--find-renames` pairs
 * the delete with its add.
 *
 * `--follow` is what carries the read past a path's own earlier renames, which is why the scan is
 * ordered newest-first and bounded: a hot path removed a dozen times over is not the mechanical
 * rename this exists to resolve.
 *
 * `follow: false` reads the PATHNAME's own history instead, and the difference is not cosmetic (PR
 * #223 review). `--follow` walks backwards from whatever wears the name now, switching to the old
 * name at every rename it meets — so a file renamed INTO this path hides everything that happened to
 * the path before it arrived, including the deletion of the file that used to be there. A caller
 * asking "did this name ever stand for a different file" has to ask it of the name, not of the file.
 *
 * `core.quotePath=false` because git C-quotes a non-ASCII path by default (`"src/caf\303\251.ts"`),
 * and a quoted entry no longer splits on a literal tab — the parse would hand back a path that
 * exists nowhere. `:(literal)` for the same class of reason as {@link readFileAtRev}: a pathspec is
 * PARSED before it is matched, so a cited path that opens with pathspec magic would fail the
 * command outright rather than simply not resolving.
 */
export async function readPathHistory(
  repoPath: string,
  path: string,
  options: { follow?: boolean } = {},
): Promise<PathHistory> {
  const removals = (
    await git(repoPath, [
      "-c",
      "core.quotePath=false",
      "log",
      ...(options.follow === false ? [] : ["--follow"]),
      "--format=%H",
      "--diff-filter=D",
      "--",
      `:(literal)${path}`,
    ])
  )
    .split("\n")
    .map((sha) => sha.trim())
    .filter(Boolean)
    .slice(0, MAX_PATH_REMOVALS);

  // Read in parallel, but keep the newest-first ORDER of the results: `renamedTo` is ordered
  // history, and the caller reads its first entry as the most recent destination.
  const statuses = await Promise.all(
    removals.map((sha) =>
      git(repoPath, [
        "-c",
        "core.quotePath=false",
        "show",
        "--name-status",
        "--format=",
        "--find-renames",
        "--no-color",
        sha,
      ]),
    ),
  );

  const renamedTo: string[] = [];
  let renames = 0;
  let deleted = false;
  for (const status of statuses) {
    // A merge commit prints no name-status at all, so it contributes neither a rename nor a
    // delete — history the caller reads as unfollowable, which is the honest answer.
    for (const line of status.split("\n")) {
      const rename = RENAME_STATUS.exec(line);
      if (rename && rename[1] === path) {
        renames++;
        if (!renamedTo.includes(rename[2]!)) renamedTo.push(rename[2]!);
        continue;
      }
      if (DELETE_STATUS.exec(line)?.[1] === path) deleted = true;
    }
  }
  return { renamedTo, renames, deleted };
}

/** A branch's change set against its base: the changed paths plus the (possibly truncated) patch. */
export interface BranchDiff {
  /**
   * Paths the branch changed since it diverged from the base. Always complete — a rename lists BOTH
   * its old and its new path, since callers scope rules by path (see {@link diffAgainstBase}).
   */
  files: string[];
  /** Unified patch for those changes, cut at `maxPatchChars`. */
  patch: string;
  /** True when `patch` was cut short — the file list still names everything that changed. */
  truncated: boolean;
  /**
   * The DELETIONS-only patch, collected separately and only when `patch` was cut short: what the
   * truncated patch omits is recoverable from the worktree except for a file the branch removed,
   * which is gone from it. Its budget is spent per deleted file rather than as one stream, so the
   * first large removal cannot crowd out the ones after it. Absent when nothing was deleted (or
   * nothing was truncated).
   */
  deletions?: string;
  /**
   * True when the deletion rescue pass FAILED — git errored before it could collect (all of) the
   * removals. Reported rather than swallowed: the reviewer cannot open a deleted file and has no
   * `git` to fetch one, so a silent absence here reads as "this run deleted nothing" and the
   * removals it did make are approved by nobody. The caller must tell the reviewer instead.
   */
  deletionsIncomplete?: boolean;
  /**
   * How many deleted files the budget could only NAME — their content was never quoted. Zero-cost
   * when the budget stretches to every removal, but it cannot always: a floor slice worth reading
   * times the number of deletions can exceed the whole budget, and past that point some removals are
   * unreviewable however the share is cut. Reported as a count rather than left implicit in the
   * patch text, because the caller has to turn it into unverified-scope guidance — otherwise the
   * reviewer returns a clean verdict over removals it never saw.
   */
  deletionsUnshown?: number;
}

/**
 * Cap on the patch text {@link diffAgainstBase} returns. Generous enough to carry a whole run's
 * diff into a review prompt, bounded so one pathological change (a lockfile, a vendored blob)
 * can't blow the context window.
 */
export const DEFAULT_DIFF_PATCH_CHARS = 200_000;

/**
 * Cap on the deletions-only patch {@link diffAgainstBase} adds when the main patch is truncated,
 * shared out across the deleted files. Deliberately a fraction of the main cap: this is a rescue of
 * content the reviewer has no other way to see, not a second copy of the diff, and a run that
 * deletes a vendored tree must not blow the budget the surviving code needs.
 */
export const DEFAULT_DELETION_PATCH_CHARS = 40_000;

/**
 * The work a branch added on top of `base`: the changed files and the unified patch, for the
 * pre-PR self-review gate (anton-3apm) to review.
 *
 * Diffs from the MERGE BASE, not from the base tip, so commits that landed on the base after the
 * run branched are never mistaken for the run's own work. When no merge base exists (unrelated
 * histories) it falls back to diffing against `base` directly rather than failing the review.
 * A caller that also reads FILES at the base should resolve it once with {@link resolveMergeBase}
 * and pass that SHA here, so the patch and those files come from the same commit.
 *
 * The patch is cut at the source (`gitBounded`) rather than after collection: a run that touched a
 * lockfile or vendored tree can produce a patch of any size, and buffering it whole only to slice it
 * would fail the review on the exact change truncation exists for.
 *
 * The FILE LIST is collected with rename detection off, though the patch keeps it: a detected rename
 * names only its destination, and the list is what scopes the instruction files the reviewer is
 * judged against (`readInstructions` walks each path's ancestors). Code moved OUT of a directory
 * would take that directory's rules with it — while the reviewer is told the inlined rules are the
 * only ones binding the diff. Listing the rename as its removal plus its addition keeps both scopes.
 *
 * Truncation is survivable because the reviewer can open what the cut omits — with one exception: a
 * file the branch DELETED is not in the worktree to open, and the reviewer is denied `git` (see
 * `REVIEW_DENIED_TOOLS`), so a removed route or validation past the cut would be reviewed by nobody.
 * So a truncated patch is followed by a second pass over the deletions alone, bounded per deleted
 * file so that every removal is represented (see {@link deletionPatch}). That pass turns rename
 * detection off too, for the same reason the file list does: the old side of a rename is content the
 * branch removed, and with detection on it is not classified as a deletion to rescue.
 */
export async function diffAgainstBase(
  worktreePath: string,
  base: string,
  opts: { maxPatchChars?: number; maxDeletionChars?: number } = {},
): Promise<BranchDiff> {
  const from = await resolveMergeBase(worktreePath, base);
  const files = await diffPaths(worktreePath, ["--name-only", "--no-renames", from, "HEAD"]);

  const max = opts.maxPatchChars ?? DEFAULT_DIFF_PATCH_CHARS;
  const { text, truncated } = await gitBounded(worktreePath, ["diff", from, "HEAD"], max);
  if (!truncated) return { files, patch: text.trim(), truncated: false };

  const { patch: deletions, incomplete, unshown } = await deletionPatch(
    worktreePath,
    from,
    opts.maxDeletionChars ?? DEFAULT_DELETION_PATCH_CHARS,
  );
  return {
    files,
    patch: `${text}\n… [patch truncated at ${max} chars — read the files directly]`,
    truncated: true,
    ...(deletions ? { deletions } : {}),
    ...(incomplete ? { deletionsIncomplete: true } : {}),
    ...(unshown ? { deletionsUnshown: unshown } : {}),
  };
}

/**
 * Smallest slice of the deletion budget worth spending on one file: under this a "patch" is a diff
 * header and a line or two — a filename dressed up as content. It is a FLOOR on each slice, not a
 * cutoff on the even share: once what is LEFT of the budget can no longer buy this much, the files
 * still to come are NAMED instead, so the reviewer sees what it was not shown rather than reading a
 * partial list as the whole set.
 */
const MIN_DELETION_SLICE_CHARS = 500;

/**
 * The branch's deletions as their own bounded patch — `{}` when it deleted nothing.
 *
 * "Deleted" is judged with rename detection OFF. A file git scores as a rename is one `R*` entry
 * naming only its destination, so its old side is not a deletion and this pass would return nothing
 * for it — while the move may have dropped a guard or a route on the way, and the truncated patch is
 * the reviewer's only sight of the source it cannot open.
 *
 * The budget is allocated PER DELETED FILE, not spent as one stream: a single stream is exhausted by
 * whichever removal git emits first, leaving every route, guard, or validation deleted after it
 * represented by a filename alone — unreviewable, since those files are neither in the worktree nor
 * reachable without `git` (see `REVIEW_DENIED_TOOLS`). Each file draws an even share of what is left
 * — floored at {@link MIN_DELETION_SLICE_CHARS} — so a small removal hands its surplus to the ones
 * behind it and one huge removal costs only its own slice.
 *
 * The floor and the budget can still conflict: `max / MIN_DELETION_SLICE_CHARS` files is all a
 * usable slice buys, and a run that deletes more than that leaves the tail NAMED only — no cut of
 * the share fixes that, it is the budget being smaller than the content. Those files are counted out
 * (`unshown`) as well as named, so the caller can tell the reviewer its coverage was incomplete
 * instead of letting a clean verdict cover removals nobody read.
 *
 * A failure does not fail the review that already has the (truncated) patch it was mainly after —
 * but it is REPORTED (`incomplete`), never swallowed. The reviewer has no other route to a deleted
 * file, so an empty result it isn't warned about reads as "nothing was removed", and the removals it
 * never saw are approved by its verdict. Whatever the pass collected before the failure still ships.
 *
 * Exported for the unit tests, which drive the budget allocation a case at a time: reaching it
 * through {@link diffAgainstBase} costs a truncation-forcing filler commit per case and hides which
 * allocation rule a failure belongs to.
 */
export async function deletionPatch(
  worktreePath: string,
  from: string,
  max: number,
): Promise<{ patch?: string; incomplete?: boolean; unshown?: number }> {
  const parts: string[] = [];
  try {
    // `--no-renames`, to match the changed-file list: with detection on, a rename is one `R*` entry
    // and its old side is not a deletion at all, so the source of a moved file would be rescued by
    // nobody — the reviewer can open the destination but not what the move dropped on the way.
    const deleted = await diffPaths(worktreePath, [
      "--name-only",
      "--diff-filter=D",
      "--no-renames",
      from,
      "HEAD",
    ]);
    if (deleted.length === 0) return {};

    let remaining = max;
    let i = 0;
    for (; i < deleted.length; i++) {
      // The first file is always quoted, however small the budget: a caller that asks for less than
      // one slice wants the deletions bounded, not withheld.
      if (i > 0 && remaining < MIN_DELETION_SLICE_CHARS) break;
      // An even share under the floor buys a header, not content — so spend the floor rather than
      // stop at it. Stopping made the split cliff-edged: 81 deletions of the default 40k budget put
      // the even share at 493, which quoted ONE file and named the other eighty, when the budget can
      // in fact pay a usable slice for every one of them. Capped by what is left, so a caller whose
      // whole budget is under one slice still gets it honoured.
      const share = Math.max(
        Math.min(remaining, MIN_DELETION_SLICE_CHARS),
        Math.floor(remaining / (deleted.length - i)),
      );
      const path = deleted[i]!;
      const { text, truncated } = await gitBounded(
        worktreePath,
        // `:(literal)`, because a pathspec globs by default: these names come from git itself and
        // are exact, but one holding `*` or `[…]` would also match its NEIGHBOURS and spend this
        // file's slice of the budget quoting them.
        ["diff", "--diff-filter=D", "--no-renames", from, "HEAD", "--", `:(literal)${path}`],
        share,
      );
      if (!text.trim()) continue;
      remaining -= text.length;
      parts.push(truncated ? `${text}\n… [deletion of ${path} truncated at ${share} chars]` : text.trim());
    }

    const unshown = deleted.slice(i);
    if (unshown.length > 0) {
      parts.push(
        `… [${unshown.length} further deleted file(s) not shown — deletion budget of ${max} chars` +
          ` exhausted: ${unshown.join(", ")}]`,
      );
    }
    return {
      ...(parts.length > 0 ? { patch: parts.join("\n") } : {}),
      ...(unshown.length > 0 ? { unshown: unshown.length } : {}),
    };
  } catch (e) {
    console.warn(
      `[git] could not collect the deletions of ${from}..HEAD in ${worktreePath}: ${String(e)} — the` +
        ` review is told its deletion list is incomplete`,
    );
    return { ...(parts.length > 0 ? { patch: parts.join("\n") } : {}), incomplete: true };
  }
}

/** A worktree's checked-out branch and committed tip plus its working-tree dirt — the fingerprint a read-only phase guards. */
export interface WorktreeState {
  head: string;
  /**
   * The symbolic ref HEAD points at (`refs/heads/<branch>`), absent on a detached HEAD.
   *
   * Fingerprinted alongside `head` because a phase can move off the run's branch without moving
   * the commit: `git checkout -b scratch` leaves HEAD and the status identical, so a commit-only
   * fingerprint reads it as untouched — while every later commit lands on a branch the PR push
   * never sees.
   */
  ref?: string;
  /** `git status --porcelain` output; empty on a clean tree. */
  status: string;
}

/** True when two fingerprints describe the same branch, commit, and working-tree dirt. */
export function sameWorktreeState(a: WorktreeState, b: WorktreeState): boolean {
  return a.head === b.head && a.status === b.status && a.ref === b.ref;
}

/**
 * Fingerprint the worktree, so a phase that must not write can be caught having written.
 *
 * Scoped to git-visible state on purpose. Ignored paths are NOT fingerprinted: they never reach the
 * PR (the branch carries HEAD, and a finished run force-removes the worktree), and a read-only phase
 * is explicitly allowed to run the project's own checks — which rewrite exactly those paths
 * (`.next/`, `.eslintcache`, `*.tsbuildinfo`, coverage). Hashing them would fail every honest review
 * instead of catching a dishonest one.
 *
 * Scoped to this WORKTREE, too. The repository's other refs are deliberately absent: sibling
 * worktrees of concurrent runs share one ref store and churn it constantly, so a fingerprint there
 * could not tell their branches from a rogue phase's. A phase that must not write refs is denied
 * `git` instead — see `REVIEW_DENIED_TOOLS` in jobs/review-gate.
 */
export async function readWorktreeState(worktreePath: string): Promise<WorktreeState> {
  const [head, status, ref] = await Promise.all([
    git(worktreePath, ["rev-parse", "HEAD"]),
    git(worktreePath, ["status", "--porcelain"]),
    symbolicHeadRef(worktreePath),
  ]);
  return { head, status, ...(ref ? { ref } : {}) };
}

/**
 * The branch HEAD points at (`refs/heads/<branch>`), or `""` when HEAD is detached.
 *
 * Only git's "HEAD is not a symbolic ref" answer counts as detached: `symbolic-ref --quiet` prints
 * nothing and exits 1 for that, while an unusable repository exits 128 and a timeout or a spawn
 * failure carries no exit status at all. Reading those as "detached" writes a false baseline — the
 * post-review read then succeeds, the fingerprint differs on `ref` alone, and the gate reverts a
 * worktree nobody wrote to, detaching the run's branch on the way. Everything but exit 1 propagates
 * so the run parks instead.
 */
async function symbolicHeadRef(worktreePath: string): Promise<string> {
  try {
    return await git(worktreePath, ["symbolic-ref", "--quiet", "HEAD"]);
  } catch (e) {
    // execFile reports a clean non-zero exit as a numeric `code`; a spawn error carries the string
    // errno (`ENOENT`) and a timeout kills the process, leaving `code` null with a `signal` set.
    if ((e as { code?: unknown } | null)?.code === 1) return "";
    throw e;
  }
}

/**
 * Throw away everything the worktree gained since `state` was read: back onto that branch and
 * commit, then drop the untracked files left behind. Ignored paths (`node_modules`, build caches)
 * are deliberately kept — `clean -fd` without `-x` — so undoing a stray edit never costs a full
 * reinstall.
 *
 * Assumes `state` was captured on a COMMITTED tree (which is where the review gate runs): restoring
 * onto a dirty baseline would discard that dirt too.
 */
export async function restoreWorktreeState(
  worktreePath: string,
  state: WorktreeState,
): Promise<void> {
  // Same classification as the read above: an operational failure here must not pass for a detached
  // HEAD, or the restore skips the checkout that puts the run back on its branch.
  const current = await symbolicHeadRef(worktreePath);
  if (current !== (state.ref ?? "")) {
    // Back onto the recorded branch first — a reset alone would re-pin the commit while leaving
    // HEAD on whatever branch the stray checkout created, so later commits still miss the PR.
    // `--force` drops the stray checkout's edits; the reset below re-pins the commit either way.
    // A short name is required: `git checkout refs/heads/x` detaches instead of attaching.
    await git(
      worktreePath,
      state.ref
        ? ["checkout", "--force", state.ref.replace(/^refs\/heads\//, "")]
        : ["checkout", "--force", "--detach", state.head],
    );
  }
  await git(worktreePath, ["reset", "--hard", state.head]);
  await git(worktreePath, ["clean", "-fd"]);
}

export interface PullRequest {
  url: string;
  /** beads external-ref form: `gh-<number>` when the number is parseable, else the url. */
  ref: string;
  number?: number;
  /** Whether GitHub reports the PR as a draft — see {@link markPullRequestDraft}. */
  isDraft?: boolean;
  /**
   * Set when a REUSED PR still shows an earlier attempt's title/body because the refresh failed
   * (see {@link openPullRequest}). The body is where this run's advisory findings meet the founder,
   * so a caller holding them must put them somewhere that outlives the run rather than assume the PR
   * carries them.
   */
  bodyStale?: boolean;
}

function prFromUrl(url: string): PullRequest {
  const m = url.match(/\/pull\/(\d+)/);
  const number = m ? Number(m[1]) : undefined;
  // `gh pr create` is called without `--draft`, so a PR parsed out of its output is ready to merge.
  return { url, ref: number ? `gh-${number}` : url, number, isDraft: false };
}

/** What a lookup of a branch's open PR actually established — see {@link lookupOpenPullRequest}. */
export interface OpenPullRequestLookup {
  /** The open PR tracking the branch. Absent when gh answered and there is none, or when it failed. */
  pr?: PullRequest;
  /**
   * True when `gh` could not answer at all — auth, network, a missing binary, unparseable output.
   * Deliberately NOT folded into "no PR": the branch may well have one, and a caller that defuses an
   * orphaned PR before parking would otherwise report "no PR was opened" over a live, mergeable PR
   * carrying un-reviewed work.
   */
  failed?: boolean;
}

/**
 * Look up the open PR tracking `branch`, distinguishing "there is none" from "gh could not tell us".
 *
 * Uses `gh pr list` rather than `gh pr view <branch>` precisely for that: `pr view` exits non-zero
 * BOTH when the branch has no PR and when the call itself failed, so every transient error read as a
 * clean "no PR". `pr list` exits 0 with an empty array for a branch that has none, which makes an
 * absent PR something gh confirmed instead of something inferred from a failure.
 *
 * Idempotency guard for openPullRequest: a resumed execute-epic run re-reaches the PR step against a
 * branch whose PR already exists (the first run opened it), and `gh pr create` would otherwise error.
 *
 * Also how a run RECONCILES a PR the board lost (anton-3apm): `gh pr create` can land server-side
 * with its response — or the follow-up `setPrRef` — lost, leaving a live PR no bead ref points at.
 * The branch is the only surviving handle on it, so it's the one this looks up by.
 */
export async function lookupOpenPullRequest(
  repoPath: string,
  branch: string,
): Promise<OpenPullRequestLookup> {
  const gh = process.env[GH_BIN_ENV] ?? "gh";
  try {
    const { stdout } = await execFileAsync(
      gh,
      ["pr", "list", "--head", branch, "--state", "open", "--limit", "1", "--json", "url,number,isDraft"],
      { cwd: repoPath, timeout: 120_000, maxBuffer: 4 * 1024 * 1024 },
    );
    const [pr] = JSON.parse(stdout) as Array<{ url?: string; number?: number; isDraft?: boolean }>;
    if (!pr?.url) return {}; // gh looked and the branch has no open PR
    return {
      pr: {
        url: pr.url,
        ref: pr.number ? `gh-${pr.number}` : pr.url,
        number: pr.number,
        isDraft: pr.isDraft === true,
      },
    };
  } catch (e) {
    console.warn(
      `[git] could not check for an open PR on ${branch}: ${String(e)} — treated as UNKNOWN, not as` +
        ` "no PR"`,
    );
    return { failed: true };
  }
}

/**
 * The open PR tracking `branch`, or undefined when there is none — for callers whose next move is
 * the same either way. {@link openPullRequest} is one: it creates a PR when it finds none, and a
 * lookup that failed surfaces as the `gh pr create` error rather than as a silent skip. A caller
 * that must not mistake a failed lookup for an absent PR uses {@link lookupOpenPullRequest}.
 */
export async function findOpenPullRequest(
  repoPath: string,
  branch: string,
): Promise<PullRequest | undefined> {
  return (await lookupOpenPullRequest(repoPath, branch)).pr;
}

/** `gh pr ready [--undo]`, best-effort — returns whether GitHub confirmed the flip. */
async function setPullRequestDraft(
  repoPath: string,
  selector: string,
  draft: boolean,
): Promise<boolean> {
  const gh = process.env[GH_BIN_ENV] ?? "gh";
  // gh takes a number, url, or branch as the selector; the beads `gh-<n>` form is neither.
  const target = selector.startsWith("gh-") ? selector.slice(3) : selector;
  if (!target) return false;
  try {
    await execFileAsync(gh, ["pr", "ready", target, ...(draft ? ["--undo"] : [])], {
      cwd: repoPath,
      timeout: 120_000,
      maxBuffer: 4 * 1024 * 1024,
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Overwrite an existing PR's title and body, best-effort — returns whether gh confirmed the edit.
 *
 * The body is the founder's merge-gate surface: the review gate reports its advisories there and
 * nowhere else on the PR. A reused PR still carries the text of the attempt that OPENED it, and a
 * later attempt re-reviews from scratch — so inheriting that text would show the founder a stale
 * finding list while this run's advisories reach nobody.
 */
async function updatePullRequest(
  repoPath: string,
  selector: string,
  fields: { title: string; body: string },
): Promise<boolean> {
  const gh = process.env[GH_BIN_ENV] ?? "gh";
  // gh takes a number, url, or branch as the selector; the beads `gh-<n>` form is neither.
  const target = selector.startsWith("gh-") ? selector.slice(3) : selector;
  if (!target) return false;
  try {
    await execFileAsync(gh, ["pr", "edit", target, "--title", fields.title, "--body", fields.body], {
      cwd: repoPath,
      timeout: 120_000,
      maxBuffer: 4 * 1024 * 1024,
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Convert a PR to a draft. Returns whether GitHub confirmed it, so a caller can say so rather than
 * assume it (a failure here leaves the PR mergeable, which is the thing worth reporting).
 *
 * How the review gate defuses a PR the board lost (anton-3apm): a run that parks on blocking
 * findings must not leave un-reviewed work sitting mergeable at the founder's merge gate — the exact
 * state the gate exists to prevent. Draft rather than close, so the PR keeps its number, body, and
 * review threads and {@link openPullRequest} can hand it back ready once the gate passes.
 */
export async function markPullRequestDraft(repoPath: string, selector: string): Promise<boolean> {
  return setPullRequestDraft(repoPath, selector, true);
}

/** Lifecycle state of a GitHub PR, plus `unknown` when it can't be read (no remote/gh error). */
export type PullRequestState = "open" | "merged" | "closed" | "unknown";

/**
 * Report the lifecycle state of the PR named by a beads external ref (`gh-<n>`, a bare number, or
 * a PR url). Returns `"unknown"` when the state can't be determined — no `gh`, a network/CLI error,
 * or an unparseable ref — so callers can fail closed rather than mistake a transient failure for a
 * definitive state.
 *
 * Used by execute-epic to tell a STALE ref (a PR that was closed WITHOUT merging — which review-fix
 * deliberately leaves on the bead so a Run/Force run can recover the epic) apart from a ref that
 * proves another run already finished the epic (its PR is open or merged) (anton-jz1).
 */
export async function pullRequestState(
  repoPath: string,
  ref: string,
): Promise<PullRequestState> {
  // `gh pr view` accepts a number or url; `gh-<n>` is the beads form, so strip the prefix.
  const selector = ref.startsWith("gh-") ? ref.slice(3) : ref;
  if (!selector) return "unknown";
  const gh = process.env[GH_BIN_ENV] ?? "gh";
  try {
    const { stdout } = await execFileAsync(gh, ["pr", "view", selector, "--json", "state"], {
      cwd: repoPath,
      timeout: 120_000,
      maxBuffer: 4 * 1024 * 1024,
    });
    // gh reports state as OPEN | CLOSED | MERGED (a closed-then-merged PR reports MERGED).
    const state = (JSON.parse(stdout) as { state?: string }).state?.toUpperCase();
    if (state === "OPEN") return "open";
    if (state === "MERGED") return "merged";
    if (state === "CLOSED") return "closed";
    return "unknown";
  } catch {
    return "unknown";
  }
}

/**
 * Push the branch and open a PR with `gh`. Requires an `origin` remote. Parses the PR number
 * from the returned URL (…/pull/<n>). Throws a clear Error when there is no remote.
 *
 * Idempotent: if an open PR already tracks the branch (a resumed run that re-reaches this step),
 * the branch is still pushed (to carry any new commits) and the existing PR is reused instead of
 * calling `gh pr create`, which would error on a duplicate. A reused PR has its title and body
 * rewritten to this attempt's (see {@link updatePullRequest}) — the review that just ran is the one
 * the founder must read. A refresh `gh` refuses is REPORTED (`bodyStale`) rather than warned about
 * and dropped: the body is the only place the run's advisory findings are written, so the caller
 * holding them has to persist them somewhere that survives the run. A reused PR is also taken OUT of
 * draft:
 * reaching this step means the run's self-review passed, so a PR an earlier parked attempt drafted
 * (see {@link markPullRequestDraft}) must become mergeable again or the epic finishes un-mergeable.
 */
export async function openPullRequest(opts: {
  repoPath: string;
  /**
   * Where `branch` is actually checked out — the run's worktree. Pushed FROM here rather than
   * `repoPath` (see {@link pushBranch}); `gh` itself still runs against `repoPath`, since it talks to
   * GitHub, not the working tree. Defaults to `repoPath` for callers with no separate worktree.
   */
  worktreePath?: string;
  branch: string;
  base: string;
  title: string;
  body: string;
}): Promise<PullRequest> {
  if (!(await hasRemote(opts.repoPath))) {
    throw new Error(
      `no "origin" remote in ${opts.repoPath}; cannot open a PR. Add a remote or open it manually.`,
    );
  }
  const hooksPath = await resolveHooksPathOverride(opts.repoPath, opts.worktreePath);
  await pushBranch(opts.worktreePath ?? opts.repoPath, opts.branch, hooksPath);

  const existing = await findOpenPullRequest(opts.repoPath, opts.branch);
  if (existing) {
    // Refresh before returning it, drafted or not: this attempt re-ran the review, so the title and
    // body it was handed are the current ones and the PR's are the previous attempt's.
    const refreshed = await updatePullRequest(opts.repoPath, existing.ref, {
      title: opts.title,
      body: opts.body,
    });
    if (!refreshed) {
      console.warn(
        `[git] could not refresh the title/body of ${existing.url}; it still shows an earlier ` +
          `attempt's text — reported as bodyStale so the caller can preserve this run's findings`,
      );
    }
    if (!existing.isDraft) return { ...existing, bodyStale: !refreshed };
    // Report what actually happened: a flip gh refused leaves a draft PR the founder must ready by
    // hand, and the work is on the branch either way — not worth failing the run over. Logged as well
    // as returned, because the run goes on to finish `done` with the bead `in-review`: without a line
    // here the only visible trace of an un-mergeable PR is the draft badge on GitHub.
    const ready = await setPullRequestDraft(opts.repoPath, existing.ref, false);
    if (!ready) {
      console.warn(
        `[git] could not take ${existing.url} out of draft; the run's work is on ${opts.branch} but ` +
          `the PR stays un-mergeable until it is readied by hand`,
      );
    }
    return { ...existing, isDraft: !ready, bodyStale: !refreshed };
  }

  const gh = process.env[GH_BIN_ENV] ?? "gh";
  const { stdout } = await execFileAsync(
    gh,
    [
      "pr",
      "create",
      "--head",
      opts.branch,
      "--base",
      opts.base,
      "--title",
      opts.title,
      "--body",
      opts.body,
    ],
    { cwd: opts.repoPath, timeout: 120_000, maxBuffer: 4 * 1024 * 1024 },
  );

  const url = stdout.trim().split("\n").filter(Boolean).pop() ?? "";
  return prFromUrl(url);
}
