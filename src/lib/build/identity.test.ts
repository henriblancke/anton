/**
 * The build-drift comparison (anton-pzfb): can anton tell that the process it is running is older
 * than the code on disk?
 *
 * The claim the suite adds up to: drift is reported when — and only when — a LIVE process booted
 * from something other than what is on disk now, and the sentence it produces names both builds and
 * the restart. The failure this closes is silence: three nightly scans ran under a build predating
 * two shipped filters, and nothing anywhere said so.
 */
import { afterEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  buildDrift,
  buildMatchesCheckout,
  buildRecordFile,
  buildRecordPath,
  buildStampPath,
  compareBuild,
  describeBuildDrift,
  describeBuildIdentity,
  isBundleInstall,
  listBuildRecords,
  MAX_LINKED_ENTRIES,
  processStartedAt,
  pruneBuildRecords,
  readBuildIdentity,
  readBuildRecord,
  recordAlive,
  recordFromInstall,
  REVISION_UNREADABLE,
  sameCheckout,
  writeBuildRecord,
  writeBuildStamp,
} from "./identity.mjs";

const RUNNING = { version: "0.4.0", revision: "a".repeat(40), worktree: "clean" };

const dirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "anton-build-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const SOURCE = "export const a = 1;\n";

/** Commit as somebody, whatever the machine's git config says — CI boxes have no user.name. */
const AUTHOR = ["-c", "user.email=t@t", "-c", "user.name=t", "-c", "commit.gpgsign=false"];

/** A committed checkout — the only shape whose worktree is read, since only it is its own repo. */
function gitCheckout(version = "0.4.0"): string {
  const dir = tempDir();
  writeFileSync(join(dir, "package.json"), JSON.stringify({ version }));
  writeFileSync(join(dir, "src.ts"), SOURCE);
  spawnSync("git", ["init", "-q", dir]);
  spawnSync("git", ["-C", dir, "add", "-A"]);
  spawnSync("git", ["-C", dir, ...AUTHOR, "commit", "-qm", "initial"]);
  return dir;
}

describe("compareBuild", () => {
  it("says nothing when the running build is the build on disk", () => {
    expect(compareBuild(RUNNING, { ...RUNNING }).state).toBe("current");
  });

  it("calls a different version outdated — a release landed under the running process", () => {
    expect(compareBuild({ version: "0.3.9", revision: null }, { version: "0.4.0", revision: null }).state).toBe(
      "outdated",
    );
  });

  // The 2026-08-17 case: 0.4.0 on both sides, days of fixes apart. A version-only comparison
  // reports "current" here, which is exactly the silence this whole feature exists to end.
  it("calls the same version at another commit modified", () => {
    const verdict = compareBuild(RUNNING, { version: "0.4.0", revision: "b".repeat(40) });
    expect(verdict.state).toBe("modified");
    expect(verdict.running).toEqual(RUNNING);
  });

  it("compares versions alone when either side has no commit — a bundle carries no git", () => {
    expect(compareBuild({ version: "0.4.0", revision: null }, RUNNING).state).toBe("current");
    expect(compareBuild(RUNNING, { version: "0.4.0", revision: null }).state).toBe("current");
  });

  // A checkout that cannot name its own version is a broken install, not a release: calling it
  // "outdated" would tell the operator to restart a server that is running exactly what is there.
  it("does not call a running build outdated against a version the disk cannot name", () => {
    expect(compareBuild(RUNNING, { version: null, revision: RUNNING.revision }).state).toBe("current");
    expect(compareBuild(RUNNING, { version: null, revision: "b".repeat(40) }).state).toBe("modified");
  });

  // The dev-loop drift: same release, same commit, and `.next` compiled before the edit that is
  // sitting in the worktree. Nothing above this line can tell those two builds apart.
  it("calls the same commit carrying different uncommitted work modified", () => {
    const running = { ...RUNNING, worktree: "clean" };
    expect(compareBuild(running, { ...RUNNING, worktree: "9f2c1a4bb001" }).state).toBe("modified");
    expect(compareBuild(running, { ...RUNNING, worktree: "clean" }).state).toBe("current");
  });

  // A record written before the digest existed carries none, and reading that absence as drift
  // would demand one restart of every install on the upgrade that introduced it.
  it("ignores a worktree digest only one side carries", () => {
    const undigested = { version: RUNNING.version, revision: RUNNING.revision };
    expect(compareBuild(undigested, { ...RUNNING, worktree: "9f2c1a4bb001" }).state).toBe("current");
    expect(compareBuild({ ...RUNNING, worktree: "9f2c1a4bb001" }, undigested).state).toBe("current");
  });

  // A verdict is read from OUTSIDE the server — `anton doctor` in whatever shell the operator is
  // standing in — and that shell's inlined values say nothing about the code on disk. Comparing
  // them would demand a restart whenever doctor runs somewhere else, citing two identical builds.
  it("does not read the reader's own environment as drift", () => {
    const running = { ...RUNNING, env: "aa11bb22cc33" };
    expect(compareBuild(running, { ...RUNNING, env: "dd44ee55ff66" }).state).toBe("current");
    expect(compareBuild(running, { ...RUNNING, env: null }).state).toBe("current");
  });

  // A verdict answers "must the operator restart?", and a git call that timed out on one side is no
  // evidence either way. Calling it "modified" would demand a restart that changes nothing — the
  // unreadable commit has to block FRESHNESS instead (see sameCheckout).
  it("does not read a commit git could not name as a different commit", () => {
    expect(compareBuild(RUNNING, { ...RUNNING, revision: REVISION_UNREADABLE }).state).toBe("current");
    expect(compareBuild({ ...RUNNING, revision: REVISION_UNREADABLE }, RUNNING).state).toBe("current");
  });

  it("calls a build that recorded no version unstamped", () => {
    expect(compareBuild(null, RUNNING).state).toBe("unstamped");
    expect(compareBuild({ version: null, revision: null }, RUNNING).state).toBe("unstamped");
  });
});

describe("readBuildIdentity", () => {
  it("prefers a bundle's RELEASE_VERSION over the package.json beside it", () => {
    const dir = tempDir();
    writeFileSync(join(dir, "package.json"), JSON.stringify({ version: "0.4.0" }));
    writeFileSync(join(dir, "RELEASE_VERSION"), "0.9.1\n");
    expect(readBuildIdentity(dir).version).toBe("0.9.1");
  });

  it("falls back to the checkout's package.json version, and names no commit outside git", () => {
    const dir = tempDir();
    writeFileSync(join(dir, "package.json"), JSON.stringify({ version: "0.4.0" }));
    expect(readBuildIdentity(dir, {})).toEqual({ version: "0.4.0", revision: null, worktree: null, env: null });
  });

  // `git rev-parse` walks up until it finds ANY repository, so a bundle installed under a
  // git-tracked $HOME would otherwise wear the dotfiles repo's HEAD and be called "modified" — a
  // restart demanded of a current server after every unrelated dotfile commit.
  it("names no commit for a bundle unpacked inside someone else's repo", () => {
    const home = tempDir();
    spawnSync("git", ["init", "-q", home]);
    const identity = ["-c", "user.email=t@t", "-c", "user.name=t", "-c", "commit.gpgsign=false"];
    spawnSync("git", ["-C", home, ...identity, "commit", "--allow-empty", "-qm", "dotfiles"]);
    const bundle = join(home, "bundle");
    mkdirSync(bundle);
    writeFileSync(join(bundle, "RELEASE_VERSION"), "0.9.1\n");

    // Same guard covers the worktree digest: the bundle is itself untracked in that repo, so
    // reading it would report the dotfiles' dirt as this build's uncommitted work.
    expect(readBuildIdentity(bundle, {})).toEqual({ version: "0.9.1", revision: null, worktree: null, env: null });
  });

  it("calls a committed checkout clean, and digests the edits nobody committed", () => {
    const dir = gitCheckout();
    const clean = readBuildIdentity(dir);
    expect(clean.worktree).toBe("clean");

    writeFileSync(join(dir, "src.ts"), SOURCE.replace("1", "2"));
    const edited = readBuildIdentity(dir);
    expect(edited.revision).toBe(clean.revision);
    expect(edited.worktree).toMatch(/^[0-9a-f]{12}$/);

    // The edit a name-and-status digest misses: still `M src.ts`, still that commit, other code.
    writeFileSync(join(dir, "src.ts"), SOURCE.replace("1", "3"));
    expect(readBuildIdentity(dir).worktree).not.toBe(edited.worktree);

    // And back, so undoing an edit clears the verdict the way committing one does.
    writeFileSync(join(dir, "src.ts"), SOURCE);
    expect(readBuildIdentity(dir).worktree).toBe("clean");
  });

  // A new route file changes what a build produces while every tracked file stays where it was.
  it("counts a file that exists only on disk", () => {
    const dir = gitCheckout();
    writeFileSync(join(dir, "page.tsx"), "export default () => null;\n");
    expect(readBuildIdentity(dir).worktree).toMatch(/^[0-9a-f]{12}$/);
  });

  // The untracked half of the edit-twice blindness: no diff against HEAD can see this file at all,
  // so a digest built from its NAME is identical however many times it is rewritten — and `.next`
  // falls a whole edit behind while every surface calls the server current.
  it("digests an untracked file by content, not by name", () => {
    const dir = gitCheckout();
    writeFileSync(join(dir, "page.tsx"), "export default () => null;\n");
    const first = readBuildIdentity(dir).worktree;

    writeFileSync(join(dir, "page.tsx"), "export default () => <p>hi</p>;\n");
    const second = readBuildIdentity(dir).worktree;
    expect(second).toMatch(/^[0-9a-f]{12}$/);
    expect(second).not.toBe(first);

    // Same contents at the same path is the same build, so the digest is a function of the tree.
    writeFileSync(join(dir, "page.tsx"), "export default () => null;\n");
    expect(readBuildIdentity(dir).worktree).toBe(first);
  });

  // Next reads `.env*` at BUILD time and inlines every NEXT_PUBLIC_* value into the bundle, but the
  // file is gitignored — so without naming it back in, changing a compiled-in value leaves the
  // digest untouched and `anton start` serves the old value while calling the build current.
  it("counts an ignored .env file, which the build compiles in", () => {
    const dir = gitCheckout();
    writeFileSync(join(dir, ".gitignore"), ".env*\n");
    spawnSync("git", ["-C", dir, "add", "-A"]);
    spawnSync("git", ["-C", dir, ...AUTHOR, "commit", "-qm", "ignore env"]);
    expect(readBuildIdentity(dir).worktree).toBe("clean");

    writeFileSync(join(dir, ".env.production"), "NEXT_PUBLIC_API=https://one\n");
    const first = readBuildIdentity(dir).worktree;
    expect(first).toMatch(/^[0-9a-f]{12}$/);

    // By content, like every other input: an edited value is a different build.
    writeFileSync(join(dir, ".env.production"), "NEXT_PUBLIC_API=https://two\n");
    expect(readBuildIdentity(dir).worktree).not.toBe(first);
  });

  // A `textconv` filter is git's OTHER content conversion, documented apart from external diff
  // drivers — so `--no-ext-diff` alone does not disable it. With one configured, `git diff` compares
  // the CONVERTED text, and a driver that summarizes (a header, a size, a constant) reports no
  // change at all: the digest stays "clean" and `anton start` reuses a `.next` compiled from the
  // previous file.
  it("digests a tracked edit a configured textconv driver would summarize away", () => {
    const dir = gitCheckout();
    writeFileSync(join(dir, ".gitattributes"), "*.ts diff=flat\n");
    // Ignores the path git appends, so both sides of the diff convert to the same text.
    spawnSync("git", ["-C", dir, "config", "diff.flat.textconv", "sh -c 'echo constant'"]);
    spawnSync("git", ["-C", dir, "add", "-A"]);
    spawnSync("git", ["-C", dir, ...AUTHOR, "commit", "-qm", "textconv"]);
    expect(readBuildIdentity(dir).worktree).toBe("clean");

    writeFileSync(join(dir, "src.ts"), SOURCE.replace("1", "2"));
    expect(readBuildIdentity(dir).worktree).toMatch(/^[0-9a-f]{12}$/);
  });

  // A build input is often a LINK: `.env.local` pointing at a shared secrets file is the common
  // setup, and Next inlines what stands at the end of it. Hashing the link text alone would call
  // the build current after the file behind the link changed.
  it("follows a symlinked build input to the contents the build reads", () => {
    const dir = gitCheckout();
    writeFileSync(join(dir, ".gitignore"), ".env*\n");
    spawnSync("git", ["-C", dir, "add", "-A"]);
    spawnSync("git", ["-C", dir, ...AUTHOR, "commit", "-qm", "ignore env"]);
    const shared = join(tempDir(), "secrets.env");
    writeFileSync(shared, "NEXT_PUBLIC_API=https://one\n");
    symlinkSync(shared, join(dir, ".env.local"));
    const first = readBuildIdentity(dir).worktree;
    expect(first).toMatch(/^[0-9a-f]{12}$/);

    writeFileSync(shared, "NEXT_PUBLIC_API=https://two\n");
    expect(readBuildIdentity(dir).worktree).not.toBe(first);

    // A link that leads nowhere is still an input anton can name, so the read stays defined
    // rather than collapsing the whole digest to null.
    rmSync(shared);
    expect(readBuildIdentity(dir).worktree).toMatch(/^[0-9a-f]{12}$/);
  });

  // A linked DIRECTORY is a single path to git — `ls-files --others` reports the link and never
  // descends — while Next compiles every import under it. Hashing the link text alone would leave
  // an edit behind it invisible, and `anton start` would reuse the `.next` compiled from the old
  // source while calling that server current.
  it("follows a symlinked source directory to the files the build compiles", () => {
    const dir = gitCheckout();
    const shared = join(tempDir(), "shared");
    mkdirSync(shared);
    writeFileSync(join(shared, "lib.ts"), "export const n = 1;\n");
    symlinkSync(shared, join(dir, "linked"));
    const first = readBuildIdentity(dir).worktree;
    expect(first).toMatch(/^[0-9a-f]{12}$/);

    writeFileSync(join(shared, "lib.ts"), "export const n = 2;\n");
    const edited = readBuildIdentity(dir).worktree;
    expect(edited).not.toBe(first);

    // A file ADDED under the link is a build input the tracked diff cannot see either.
    writeFileSync(join(shared, "extra.ts"), "export const m = 3;\n");
    expect(readBuildIdentity(dir).worktree).not.toBe(edited);
  });

  // A tracked link is committed as its link TEXT, so `git diff HEAD` compares the path and never
  // the bytes behind it — the worktree stays "clean" however often the target is rewritten, and
  // `anton start` reuses a `.next` Next compiled through that link from the old contents.
  it("follows a tracked symlink out of the checkout to the contents the build reads", () => {
    const dir = gitCheckout();
    const shared = join(tempDir(), "lib.ts");
    writeFileSync(shared, "export const n = 1;\n");
    symlinkSync(shared, join(dir, "linked.ts"));
    spawnSync("git", ["-C", dir, "add", "-A"]);
    spawnSync("git", ["-C", dir, ...AUTHOR, "commit", "-qm", "track the link"]);
    const first = readBuildIdentity(dir).worktree;
    expect(first).toMatch(/^[0-9a-f]{12}$/);

    writeFileSync(shared, "export const n = 2;\n");
    const edited = readBuildIdentity(dir).worktree;
    expect(edited).not.toBe(first);

    // Same contents behind the same link is the same build, so the digest stays a function of it.
    writeFileSync(shared, "export const n = 1;\n");
    expect(readBuildIdentity(dir).worktree).toBe(first);
  });

  // A link pointing back into the checkout needs no walk of its own — its target is digested where
  // it stands — and walking one would drag every ignored file under it (`.next`, node_modules) past
  // the entry cap and collapse the digest on every read.
  it("leaves a tracked link that resolves back inside the checkout to the tracked diff", () => {
    const dir = gitCheckout();
    mkdirSync(join(dir, "src"));
    writeFileSync(join(dir, "src", "lib.ts"), SOURCE);
    symlinkSync(join(dir, "src"), join(dir, "linked"));
    spawnSync("git", ["-C", dir, "add", "-A"]);
    spawnSync("git", ["-C", dir, ...AUTHOR, "commit", "-qm", "track the link"]);
    expect(readBuildIdentity(dir).worktree).toBe("clean");

    // Still seen — as the tracked edit it is, through the diff rather than through the link.
    writeFileSync(join(dir, "src", "lib.ts"), SOURCE.replace("1", "2"));
    expect(readBuildIdentity(dir).worktree).toMatch(/^[0-9a-f]{12}$/);
  });

  // "Inside the checkout" is not proof the target is digested: an IGNORED in-checkout target is in
  // neither the diff nor the untracked listing, so dropping the link on location alone leaves the
  // bytes Next compiles through it invisible — the worktree reads "clean" however often they change.
  it("follows a tracked link whose in-checkout target git ignores", () => {
    const dir = gitCheckout();
    writeFileSync(join(dir, ".gitignore"), "generated/\n");
    mkdirSync(join(dir, "generated"));
    writeFileSync(join(dir, "generated", "shared.ts"), SOURCE);
    symlinkSync(join(dir, "generated", "shared.ts"), join(dir, "linked.ts"));
    spawnSync("git", ["-C", dir, "add", "-A"]);
    spawnSync("git", ["-C", dir, ...AUTHOR, "commit", "-qm", "track the link"]);
    const first = readBuildIdentity(dir).worktree;
    expect(first).toMatch(/^[0-9a-f]{12}$/);

    writeFileSync(join(dir, "generated", "shared.ts"), SOURCE.replace("1", "2"));
    const edited = readBuildIdentity(dir).worktree;
    expect(edited).not.toBe(first);

    // Same bytes behind the same link is the same build, so the digest stays a function of them.
    writeFileSync(join(dir, "generated", "shared.ts"), SOURCE);
    expect(readBuildIdentity(dir).worktree).toBe(first);
  });

  // A walk that stops at the entry cap hashes the same bytes however the entries past the cutoff
  // change, so an edit behind it would leave the identity unmoved and `buildMatchesCheckout` would
  // vouch for a `.next` compiled from the old contents. Unreadable is the honest verdict — it makes
  // the artifact unprovable, which is what forces the rebuild.
  it("cannot name a worktree whose linked tree is too large to read whole", () => {
    const dir = gitCheckout();
    const shared = join(tempDir(), "huge");
    mkdirSync(shared);
    // Named so the edited file sorts LAST — past the cutoff, where a truncated walk stops looking.
    const names = Array.from({ length: MAX_LINKED_ENTRIES + 4 }, (_, i) => `f${String(i).padStart(6, "0")}.ts`);
    for (const name of names) writeFileSync(join(shared, name), SOURCE);
    symlinkSync(shared, join(dir, "linked"));
    expect(readBuildIdentity(dir).worktree).toBeNull();

    // And an unprovable worktree is never a build anton will reuse.
    writeBuildStamp(dir, readBuildIdentity(dir));
    expect(buildMatchesCheckout(dir)).toBe(false);

    for (const name of names.slice(MAX_LINKED_ENTRIES)) rmSync(join(shared, name));
    expect(readBuildIdentity(dir).worktree).toMatch(/^[0-9a-f]{12}$/);
  });

  // Following links makes cycles reachable: a directory linking back to its own ancestor would
  // recurse forever, and the read has to still resolve to a digest.
  it("terminates on a linked directory that points back into itself", () => {
    const dir = gitCheckout();
    const shared = join(tempDir(), "shared");
    mkdirSync(shared);
    writeFileSync(join(shared, "lib.ts"), "export const n = 1;\n");
    symlinkSync(shared, join(shared, "self"));
    symlinkSync(shared, join(dir, "linked"));
    expect(readBuildIdentity(dir).worktree).toMatch(/^[0-9a-f]{12}$/);
  });

  // .gitignore is what keeps `.next` and node_modules — which every build rewrites — out of the
  // digest; without it a build would invalidate itself the moment it finished.
  it("ignores what git ignores", () => {
    const dir = gitCheckout();
    writeFileSync(join(dir, ".gitignore"), "junk/\n");
    spawnSync("git", ["-C", dir, "add", "-A"]);
    spawnSync("git", ["-C", dir, ...AUTHOR, "commit", "-qm", "ignore junk"]);
    expect(readBuildIdentity(dir).worktree).toBe("clean");

    mkdirSync(join(dir, "junk"));
    writeFileSync(join(dir, "junk", "build.log"), "noise\n");
    expect(readBuildIdentity(dir).worktree).toBe("clean");
  });
});

// Next inlines a `NEXT_PUBLIC_*` value at COMPILE time from wherever it reads it — and a `.env`
// file is only one of those places. `NEXT_PUBLIC_API_URL=x anton start` puts it straight in the
// build's environment, where no digest of the checkout can see it.
/**
 * "No commit" and "no readable commit" are opposite facts, and only the second one blocks (PR #217).
 * A `.git` git rejects reproduces every shape of the failure at once — a timed-out read, a briefly
 * unreadable `.git`, an object format this git cannot parse.
 */
describe("a checkout whose git identity cannot be read", () => {
  function unreadableCheckout(): string {
    const dir = tempDir();
    writeFileSync(join(dir, "package.json"), JSON.stringify({ version: "0.4.0" }));
    writeFileSync(join(dir, ".git"), "not a gitfile\n");
    return dir;
  }

  it("is unreadable, not a tarball that has no commit", () => {
    const identity = readBuildIdentity(unreadableCheckout(), {});
    expect(identity.revision).toBe(REVISION_UNREADABLE);
    // Nothing to digest past a commit nothing could name — and the same git would fail on it anyway.
    expect(identity.worktree).toBeNull();
  });

  it("still reads a real tarball — no .git at all — as having no commit", () => {
    const dir = tempDir();
    writeFileSync(join(dir, "package.json"), JSON.stringify({ version: "0.4.0" }));
    expect(readBuildIdentity(dir, {}).revision).toBeNull();
  });
});

describe("the build-time environment in an identity", () => {
  const app = () => {
    const dir = tempDir();
    writeFileSync(join(dir, "package.json"), JSON.stringify({ version: "0.4.0" }));
    return dir;
  };

  it("is nothing at all when the build compiles no inlined value in", () => {
    expect(readBuildIdentity(app(), { PATH: "/usr/bin" }).env).toBe(null);
  });

  it("digests an inlined value by content, so changing it is a different build", () => {
    const dir = app();
    const first = readBuildIdentity(dir, { NEXT_PUBLIC_API_URL: "https://one" }).env;
    expect(first).toMatch(/^[0-9a-f]{12}$/);
    expect(readBuildIdentity(dir, { NEXT_PUBLIC_API_URL: "https://two" }).env).not.toBe(first);
    // Same value again is the same build, so the digest is a function of the environment.
    expect(readBuildIdentity(dir, { NEXT_PUBLIC_API_URL: "https://one" }).env).toBe(first);
  });

  // The scope is the prefix Next documents as compiled in. Digesting the environment wholesale
  // would fold in PWD, TERM and every per-invocation variable, and rebuild on each one.
  it("ignores variables the build does not compile in", () => {
    const dir = app();
    const bare = readBuildIdentity(dir, { NEXT_PUBLIC_API_URL: "https://one" }).env;
    const noisy = readBuildIdentity(dir, { NEXT_PUBLIC_API_URL: "https://one", PWD: "/tmp/x", TERM: "dumb" }).env;
    expect(noisy).toBe(bare);
  });

  // Two variables whose name/value bytes could otherwise run together into one string, so no pair
  // of environments digests alike.
  it("frames each name from its value", () => {
    const dir = app();
    const a = readBuildIdentity(dir, { NEXT_PUBLIC_A: "b", NEXT_PUBLIC_AB: "" }).env;
    const b = readBuildIdentity(dir, { NEXT_PUBLIC_A: "", NEXT_PUBLIC_AB: "b" }).env;
    expect(a).not.toBe(b);
  });

  // Order is the shell's, not the build's: the same two values exported the other way round is the
  // same artifact, and rebuilding on it would be churn nobody can explain.
  it("does not depend on the order the shell exported them in", () => {
    const dir = app();
    expect(readBuildIdentity(dir, { NEXT_PUBLIC_A: "1", NEXT_PUBLIC_B: "2" }).env).toBe(
      readBuildIdentity(dir, { NEXT_PUBLIC_B: "2", NEXT_PUBLIC_A: "1" }).env,
    );
  });
});

describe("sameCheckout", () => {
  const IDENTITY = { version: "0.4.0", revision: "a".repeat(40), worktree: "clean" };

  it("is true for two reads of the same code", () => {
    expect(sameCheckout(IDENTITY, { ...IDENTITY })).toBe(true);
  });

  it("catches a save that landed while the build was compiling", () => {
    expect(sameCheckout(IDENTITY, { ...IDENTITY, worktree: "9f2c1a4bb001" })).toBe(false);
    expect(sameCheckout(IDENTITY, { ...IDENTITY, revision: "b".repeat(40) })).toBe(false);
    expect(sameCheckout(IDENTITY, { ...IDENTITY, version: "0.5.0" })).toBe(false);
  });

  // An install with no git and no readable package.json would otherwise rebuild forever, never able
  // to prove the tree held still.
  it("does not read an absence BOTH reads share as a change", () => {
    const nothing = { version: null, revision: null, worktree: null };
    expect(sameCheckout(nothing, { ...nothing })).toBe(true);
  });

  // The post-build read is the one that can fail on a moving tree: an edit saved mid-compile can
  // push the diff past GIT_MAX_BUFFER, or the git call can simply time out. Reading that silence as
  // agreement would stamp the pre-build identity onto an artifact that may not hold the edit.
  it("refuses to read a half-failed read as proof", () => {
    expect(sameCheckout(IDENTITY, { ...IDENTITY, worktree: null })).toBe(false);
    expect(sameCheckout(IDENTITY, { ...IDENTITY, revision: null })).toBe(false);
    expect(sameCheckout(IDENTITY, { ...IDENTITY, version: null })).toBe(false);
    expect(sameCheckout({ ...IDENTITY, worktree: null }, IDENTITY)).toBe(false);
  });

  // The failure that persists: a huge uncommitted diff overruns GIT_MAX_BUFFER on every read, so
  // both come back digest-less and agree with each other while naming nothing an edit would move.
  it("refuses two failed digest reads that agree only in what they could not read", () => {
    const noDigest = { ...IDENTITY, worktree: null };
    expect(sameCheckout(noDigest, { ...noDigest })).toBe(false);
  });

  // The reviewer's case (PR #217): both revision reads fail at once — git times out, `.git` is
  // briefly unreadable — so two absences agree and the tarball rule below would accept the artifact
  // on version alone, stamping an edit made mid-compile as current and reusing that `.next` on every
  // later start under the same failure.
  it("refuses two revision reads that failed rather than found no repository", () => {
    const unreadable = { ...IDENTITY, revision: REVISION_UNREADABLE, worktree: null };
    expect(sameCheckout(unreadable, { ...unreadable })).toBe(false);
    expect(sameCheckout(IDENTITY, unreadable)).toBe(false);
    expect(sameCheckout(unreadable, IDENTITY)).toBe(false);
  });

  // The reviewer's case (PR #217): the checkout never moved, but the value the build compiles in
  // did — accepting that stamp reuses a `.next` holding the OLD value while every drift surface
  // calls the server current.
  it("catches a build compiled with a different inlined value", () => {
    expect(sameCheckout({ ...IDENTITY, env: "aa11bb22cc33" }, { ...IDENTITY, env: "dd44ee55ff66" })).toBe(false);
    expect(sameCheckout({ ...IDENTITY, env: "aa11bb22cc33" }, { ...IDENTITY, env: "aa11bb22cc33" })).toBe(true);
  });

  // A stamp predating the field against a shell that sets nothing is two absences that agree, so
  // the field costs no existing install a rebuild on the upgrade that introduced it.
  it("does not read a stamp written before the env digest as a change", () => {
    expect(sameCheckout(IDENTITY, { ...IDENTITY, env: null })).toBe(true);
    // But a stamp that names no environment cannot vouch for one that now sets a value.
    expect(sameCheckout(IDENTITY, { ...IDENTITY, env: "aa11bb22cc33" })).toBe(false);
  });

  it("reads this repo's own version and HEAD", () => {
    const identity = readBuildIdentity(process.cwd());
    expect(identity.version).toMatch(/^\d+\.\d+\.\d+/);
    expect(identity.revision).toMatch(/^[0-9a-f]{40}$/);
  });
});

describe("the record a running server leaves", () => {
  it("round-trips through the path anton.db decides, named for the process that wrote it", () => {
    const dir = tempDir();
    const path = buildRecordPath(join(dir, "anton.db"));
    expect(path).toBe(join(dir, `server-build.${process.pid}.json`));
    const stamp = { pid: 4242, bootedAt: 1_700_000_000_000, startedAt: "when-4242-began", appRoot: "/opt/anton" };
    expect(writeBuildRecord(buildRecordPath(join(dir, "anton.db"), 4242), RUNNING, stamp)).toBe(true);
    expect(readBuildRecord(join(dir, "server-build.4242.json"))).toEqual({ ...RUNNING, ...stamp });
  });

  // The failure a shared filename causes: two servers from one install (a UI-only `ANTON_RUNNER=off`
  // one beside the runner) would have the LAST to boot speak for both, and a server that booted
  // after a pull would suppress the older one's stale verdict by matching the code on disk itself.
  it("keeps one record per process, so a second server cannot overwrite the first's identity", () => {
    const dir = tempDir();
    const db = join(dir, "anton.db");
    writeBuildRecord(buildRecordPath(db, 4242), { ...RUNNING, version: "0.3.9" }, { pid: 4242, bootedAt: 1 });
    writeBuildRecord(buildRecordPath(db, 4243), RUNNING, { pid: 4243, bootedAt: 2 });

    expect(readBuildRecord(buildRecordPath(db, 4242))).toMatchObject({ version: "0.3.9" });
    expect(listBuildRecords(db).map(({ record }) => record.pid)).toEqual([4242, 4243]);
  });

  // Nothing deletes a record when a server exits — a crash could not — so without this every boot
  // would leave one more file beside anton.db forever.
  it("drops the records of processes that are gone, and only those", () => {
    const dir = tempDir();
    const db = join(dir, "anton.db");
    writeBuildRecord(buildRecordPath(db, 4242), RUNNING, { pid: 4242, bootedAt: 1 });
    writeBuildRecord(buildRecordPath(db), RUNNING);
    writeFileSync(join(dir, "server-build.notapid.json"), "{}");

    pruneBuildRecords(db, (record) => record.pid === process.pid);

    expect(listBuildRecords(db).map(({ record }) => record.pid)).toEqual([process.pid]);
    // Only records are pruned: an unrelated file that merely starts with the prefix is not one.
    expect(readBuildRecord(join(dir, "server-build.notapid.json"))).toEqual({});
  });

  // A record's pid is what makes it that process's own, so a file whose name and contents disagree
  // (hand-edited, or copied between state dirs) is attributable to nothing and speaks for nobody.
  it("ignores a record whose filename and pid disagree", () => {
    const dir = tempDir();
    const db = join(dir, "anton.db");
    writeFileSync(buildRecordPath(db, 4242), JSON.stringify({ ...RUNNING, pid: 4243, bootedAt: 1 }));
    expect(listBuildRecords(db)).toEqual([]);
  });

  // A source checkout resolves the record to the repo root, so an unignored name would leave a pid
  // and a boot timestamp staged by the next routine `git add -A`.
  it("carries a name this repo ignores, so a boot never dirties the checkout", () => {
    const ignored = spawnSync("git", ["check-ignore", "-q", buildRecordFile(process.pid)], { cwd: process.cwd() });
    expect(ignored.status).toBe(0);
  });

  // Same hazard, same fix: the launcher's port note also lands at the repo root on a source
  // checkout, where an unignored name would enter the worktree digest and invalidate every build.
  it("keeps the launcher's port note out of the checkout too", () => {
    const ignored = spawnSync("git", ["check-ignore", "-q", "server-port"], { cwd: process.cwd() });
    expect(ignored.status).toBe(0);
  });

  // `ANTON_DB` can point two checkouts at one database, so the directory a record sits in does not
  // say whose server wrote it. Without the install on the record, every reader compares a
  // neighbour's running build against its own code and calls it stale or current (PR #217).
  it("names the install its server booted from, so a neighbour's record is not read as this one's", () => {
    const dir = tempDir();
    writeBuildRecord(buildRecordPath(join(dir, "anton.db"), 4242), RUNNING, { pid: 4242, appRoot: dir });

    const [{ record }] = listBuildRecords(join(dir, "anton.db"));
    expect(recordFromInstall(record, dir)).toBe(true);
    expect(recordFromInstall(record, join(dir, "elsewhere"))).toBe(false);
  });

  // An absence is not evidence — the same rule the comparison itself follows field by field — so a
  // record written before this field existed still answers for whoever reads it.
  it("reads a record with no install as this one's", () => {
    expect(recordFromInstall(RUNNING, "/anywhere")).toBe(true);
    expect(recordFromInstall(null, "/anywhere")).toBe(true);
  });

  // `anton update` deletes the runtime dir a server booted from, which is exactly the drift worth
  // reporting: requiring a resolvable path would drop the one record that matters most.
  it("still matches an install whose directory is already gone", () => {
    expect(recordFromInstall({ ...RUNNING, appRoot: "/gone/anton/runtime" }, "/gone/anton/runtime")).toBe(true);
  });

  it("creates the state dir on the way, so a first boot needs no setup step", () => {
    const dir = tempDir();
    expect(writeBuildRecord(join(dir, "anton.db", "nested", "rec.json"), RUNNING)).toBe(true);
  });

  // Best-effort is the whole contract: a state dir anton cannot write must cost it a stamp, not a
  // boot. `drift.ts` covers that gap with the identity it holds in memory.
  it("reports failure instead of throwing when the record cannot be written", () => {
    const dir = tempDir();
    writeFileSync(join(dir, "blocked"), "");
    expect(writeBuildRecord(join(dir, "blocked", "rec.json"), RUNNING)).toBe(false);
  });

  // A pid is not an identity: the OS reuses the number, and a record outlives the server that wrote
  // it. Without the birth stamp `anton doctor` vouches for — or demands a restart of — a process
  // that stopped hours ago and whose pid now belongs to something unrelated.
  it("holds a record to the process that wrote it, not to the number it was given", () => {
    const startedAt = processStartedAt(process.pid);
    expect(startedAt).toEqual(expect.any(String));
    expect(recordAlive({ ...RUNNING, pid: process.pid, startedAt })).toBe(true);
    expect(recordAlive({ ...RUNNING, pid: process.pid, startedAt: "a different process" })).toBe(false);
  });

  // `ps -o lstart=` prints a FORMATTED date, so an uncanonicalized read makes the same live process
  // wear a different stamp in every shell: start the daemon in Europe/Brussels, run `anton status`
  // under TZ=UTC, and the pidfile of a running server is deleted as somebody else's.
  it("reads the same birth stamp whatever time zone and locale the caller stands in", () => {
    const shells = [
      { TZ: "UTC", LC_ALL: "C" },
      { TZ: "Asia/Tokyo", LC_ALL: "de_DE.UTF-8" },
      { TZ: "America/Los_Angeles", LC_ALL: undefined },
    ];
    const stamps = shells.map((shell) => {
      const restore = { TZ: process.env.TZ, LC_ALL: process.env.LC_ALL };
      Object.assign(process.env, shell);
      if (shell.LC_ALL === undefined) delete process.env.LC_ALL;
      try {
        return processStartedAt(process.pid);
      } finally {
        Object.assign(process.env, restore);
        if (restore.TZ === undefined) delete process.env.TZ;
        if (restore.LC_ALL === undefined) delete process.env.LC_ALL;
      }
    });
    expect(stamps[0]).toEqual(expect.any(String));
    expect(new Set(stamps).size).toBe(1);
  });

  // Two absences, and neither is evidence: a machine that cannot read a birth time at all must not
  // start calling every live server stopped, and a record written before one could be read is
  // exactly as trustworthy as it was.
  it("falls back to the pid alone when no birth time can be established", () => {
    expect(recordAlive({ ...RUNNING, pid: process.pid })).toBe(true);
    expect(recordAlive({ ...RUNNING, pid: process.pid, startedAt: "unreadable" }, () => null)).toBe(true);
    expect(recordAlive({ ...RUNNING, pid: 999999, startedAt: null })).toBe(false);
    expect(recordAlive(null)).toBe(false);
  });

  it("treats an unreadable or absent record as no record", () => {
    const dir = tempDir();
    writeFileSync(join(dir, "junk.json"), "{not json");
    expect(readBuildRecord(join(dir, "junk.json"))).toBeNull();
    expect(readBuildRecord(join(dir, "absent.json"))).toBeNull();
  });
});

/**
 * The stamp on the COMPILED output. Everything else here compares the running process against the
 * checkout; this compares the checkout against the artifact `next start` would actually serve —
 * without it, a source start on a `.next` built at an older commit boots stamping the new commit and
 * every drift surface reports a stale server as current.
 */
// The line between the two kinds of install, and what decides who may be identified by VERSION
// alone (PR #217 review): a bundle's prebuilt `.next` is never stamped, so it keeps that fallback,
// while a source install's unstamped build is one nothing can name.
describe("isBundleInstall", () => {
  it("keys on the RELEASE_VERSION marker the launcher keys on", () => {
    const app = tempDir();
    writeFileSync(join(app, "package.json"), JSON.stringify({ version: "0.4.0" }));
    expect(isBundleInstall(app)).toBe(false);

    writeFileSync(join(app, "RELEASE_VERSION"), "0.4.0\n");

    expect(isBundleInstall(app)).toBe(true);
  });

  it("says no for a directory that is not there at all", () => {
    expect(isBundleInstall(join(tempDir(), "gone"))).toBe(false);
  });
});

describe("buildMatchesCheckout", () => {
  /** A checkout at `version`/`revision` whose `.next` was compiled from `builtFrom` (if given). */
  function checkout(onDisk: { version: string; revision: string | null; worktree?: string | null }, builtFrom?: object) {
    const app = tempDir();
    writeFileSync(join(app, "package.json"), JSON.stringify({ version: onDisk.version }));
    mkdirSync(join(app, ".next"));
    if (builtFrom) writeFileSync(buildStampPath(app), JSON.stringify(builtFrom));
    return app;
  }

  it("accepts a build stamped with the checkout that is on disk", () => {
    const app = checkout(RUNNING, RUNNING);
    expect(buildMatchesCheckout(app, RUNNING)).toBe(true);
  });

  it("rejects a build compiled at another commit — the case `next start` cannot see", () => {
    const app = checkout(RUNNING, { version: "0.4.0", revision: "b".repeat(40) });
    expect(buildMatchesCheckout(app, RUNNING)).toBe(false);
  });

  it("rejects a build another release produced", () => {
    const app = checkout(RUNNING, { version: "0.3.9", revision: RUNNING.revision });
    expect(buildMatchesCheckout(app, RUNNING)).toBe(false);
  });

  // What `next start` cannot see either, and what a commit-only comparison misses: the artifact
  // was compiled, then a tracked file was edited and never committed.
  it("rejects a build compiled before the edit sitting in the worktree", () => {
    const onDisk = { ...RUNNING, worktree: "9f2c1a4bb001" };
    expect(buildMatchesCheckout(checkout(onDisk, { ...RUNNING, worktree: "clean" }), onDisk)).toBe(false);
  });

  // The artifact side of the both-reads-failed case (PR #217): the stamp and the checkout are read
  // through the same broken git, so both used to come back `revision: null` — a tarball, accepted on
  // version alone — and every start under that failure reused a `.next` nothing could vouch for.
  it("rejects a build whose commit git could not read on either side", () => {
    const app = checkout(RUNNING);
    writeFileSync(join(app, ".git"), "not a gitfile\n");
    const identity = readBuildIdentity(app, {});
    expect(identity.revision).toBe(REVISION_UNREADABLE);
    writeFileSync(buildStampPath(app), JSON.stringify(identity));
    expect(buildMatchesCheckout(app, identity)).toBe(false);
  });

  // An unstamped `.next` is one anton cannot identify, and a build it cannot name is one it cannot
  // claim is current — rebuilding costs a build, serving it costs the whole verdict.
  it("rejects a build that carries no stamp at all", () => {
    expect(buildMatchesCheckout(checkout(RUNNING), RUNNING)).toBe(false);
  });

  // Freshness is a proof, so a git read that failed, timed out, or overran the buffer cap is a no.
  // Read as "no evidence" instead, a stamp written before an uncommitted edit would be accepted and
  // `anton start` would serve the pre-edit artifact.
  it("rejects a build when git could no longer describe the checkout", () => {
    const onDisk = { ...RUNNING, worktree: null };
    expect(buildMatchesCheckout(checkout(onDisk, RUNNING), onDisk)).toBe(false);
  });

  it("rejects a git checkout neither read could describe — unprovable is not current", () => {
    const onDisk = { ...RUNNING, worktree: null };
    expect(buildMatchesCheckout(checkout(onDisk, onDisk), onDisk)).toBe(false);
  });

  // A source install with no git names no commit on either side, and never could: holding it to a
  // digest it cannot produce would rebuild it on every single start.
  it("accepts a checkout with no git at all on its version alone", () => {
    const onDisk = { version: "0.4.0", revision: null, worktree: null };
    expect(buildMatchesCheckout(checkout(onDisk, onDisk), onDisk)).toBe(true);
  });

  // `NEXT_PUBLIC_API_URL=old anton start`, then `NEXT_PUBLIC_API_URL=new anton start`: the checkout
  // is byte-for-byte the same, and the artifact still holds the value Next inlined the first time.
  it("rejects a build compiled with a different inlined environment value", () => {
    const onDisk = { ...RUNNING, env: "dd44ee55ff66" };
    expect(buildMatchesCheckout(checkout(onDisk, { ...RUNNING, env: "aa11bb22cc33" }), onDisk)).toBe(false);
    expect(buildMatchesCheckout(checkout(onDisk, onDisk), onDisk)).toBe(true);
  });

  it("round-trips a fresh stamp, so the build it just made is accepted next start", () => {
    const app = checkout(RUNNING);
    expect(writeBuildStamp(app, RUNNING)).toBe(true);
    expect(readBuildRecord(buildStampPath(app))).toMatchObject(RUNNING);
    expect(buildMatchesCheckout(app, RUNNING)).toBe(true);
  });
});

describe("buildDrift", () => {
  /** An app root on disk plus the record a server left beside its database. */
  function install(onDisk: { version: string }, record?: object) {
    const app = tempDir();
    const state = tempDir();
    writeFileSync(join(app, "package.json"), JSON.stringify(onDisk));
    const recordPath = buildRecordPath(join(state, "anton.db"));
    if (record) writeFileSync(recordPath, JSON.stringify(record));
    return { appRoot: app, recordPath };
  }

  const alive = () => true;
  const dead = () => false;

  it("stays silent for a server started from the current checkout", () => {
    const paths = install({ version: "0.4.0" }, { version: "0.4.0", revision: null, pid: 1, bootedAt: 1 });
    expect(buildDrift({ ...paths, isAlive: alive })).toBeNull();
  });

  it("names both builds when the running one is older", () => {
    const paths = install({ version: "0.4.0" }, { version: "0.3.9", revision: null, pid: 1, bootedAt: 7 });
    const drift = buildDrift({ ...paths, isAlive: alive });
    expect(drift?.state).toBe("outdated");
    expect(drift?.running?.version).toBe("0.3.9");
    expect(drift?.onDisk.version).toBe("0.4.0");
    expect(drift?.bootedAt).toBe(7);
  });

  // A restart is the whole remediation, so a record whose process is gone must report nothing —
  // otherwise the verdict would outlive the server it describes and need a second cleanup step.
  it("goes quiet once the process that wrote the record is gone", () => {
    const paths = install({ version: "0.4.0" }, { version: "0.3.9", revision: null, pid: 999999, bootedAt: 1 });
    expect(buildDrift({ ...paths, isAlive: dead })).toBeNull();
  });

  // The leftover a restart does not clear: the server exited, the OS handed its number to something
  // else, and the default liveness test is what has to notice — a stale record must not be able to
  // stand in for a running server.
  it("goes quiet when the pid is alive but belongs to a different process now", () => {
    const paths = install(
      { version: "0.4.0" },
      { version: "0.3.9", revision: null, pid: process.pid, bootedAt: 1, startedAt: "some other process" },
    );
    expect(buildDrift(paths)).toBeNull();
  });

  it("says nothing about a missing record on an install with no server up", () => {
    expect(buildDrift({ ...install({ version: "0.4.0" }), isAlive: alive })).toBeNull();
  });

  // The first upgrade past this change: the running build is too old to have written a record, and
  // that absence is the only evidence there is — precisely the state that hid for three nights.
  it("reports a running server that left no record as unstamped", () => {
    const paths = install({ version: "0.4.0" });
    const drift = buildDrift({ ...paths, serverRunning: true, isAlive: alive });
    expect(drift?.state).toBe("unstamped");
    expect(drift?.running).toBeNull();
    expect(drift?.onDisk.version).toBe("0.4.0");
  });
});

describe("the sentence an operator reads", () => {
  it("names the running build, the one on disk, and the restart", () => {
    const said = describeBuildDrift({
      state: "modified",
      running: RUNNING,
      onDisk: { version: "0.4.0", revision: "b".repeat(40) },
      bootedAt: null,
    });
    expect(said).toContain("0.4.0 (aaaaaaa)");
    expect(said).toContain("0.4.0 (bbbbbbb)");
    expect(said).toContain("Restart the server");
  });

  it("says what cannot be established for an unstamped build, and still names the restart", () => {
    const said = describeBuildDrift({ state: "unstamped", running: null, onDisk: RUNNING, bootedAt: null });
    expect(said).toContain("no build identity");
    expect(said).toContain("Restart the server");
  });

  it("renders a bundle without a commit as its version alone", () => {
    expect(describeBuildIdentity({ version: "0.4.0", revision: null })).toBe("0.4.0");
    expect(describeBuildIdentity(RUNNING)).toBe("0.4.0 (aaaaaaa)");
  });

  // The sentinel is a fact about the READ, never a commit to print at the operator.
  it("names no commit for a build whose commit could not be read", () => {
    expect(describeBuildIdentity({ version: "0.4.0", revision: REVISION_UNREADABLE })).toBe("0.4.0");
  });

  // Both sides of an uncommitted drift sit at one commit, so without this the sentence would claim
  // that `0.4.0 (aaaaaaa)` differs from `0.4.0 (aaaaaaa)` and read as a bug.
  it("names uncommitted work, so the two builds it compares print differently", () => {
    expect(describeBuildIdentity({ ...RUNNING, worktree: "9f2c1a4bb001" })).toBe(
      "0.4.0 (aaaaaaa, uncommitted 9f2c1a4)",
    );
    expect(describeBuildIdentity({ ...RUNNING, worktree: "clean" })).toBe("0.4.0 (aaaaaaa)");
  });
});
