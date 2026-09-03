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
  ENV_UNPROVABLE,
  isBundleInstall,
  listBuildRecords,
  liveBuildRecords,
  MAX_LINKED_ENTRIES,
  MAX_ROUTE_ENTRIES,
  MAX_SOURCE_ENTRIES,
  processStartedAt,
  pruneBuildRecords,
  readBuildIdentity,
  readBuildRecord,
  recordAlive,
  recordFromInstall,
  recordVerdict,
  REVISION_UNREADABLE,
  sameCheckout,
  writeBuildRecord,
  writeBuildStamp,
} from "./identity.mjs";

const RUNNING = { version: "0.4.0", revision: "a".repeat(40), worktree: "clean" };

// A stamp from THIS machine's birth-time reader naming some other process — the reuse case. The
// reader's tag has to be the local one: a stamp from the OTHER reader is not comparable, and so
// proves nothing either way (PR #217 review).
const reusedStamp = () => `${(processStartedAt(process.pid) ?? "ps:").split(":", 1)[0]}:some other process`;

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

/** A committed submodule under `dir` — the vendored-source shape a build compiles through. */
function submodule(dir: string, path: string): string {
  const origin = tempDir();
  writeFileSync(join(origin, "lib.ts"), SOURCE);
  spawnSync("git", ["init", "-q", origin]);
  spawnSync("git", ["-C", origin, "add", "-A"]);
  spawnSync("git", ["-C", origin, ...AUTHOR, "commit", "-qm", "vendored"]);
  // A local clone over the file transport is what `protocol.file.allow` gates.
  const allow = ["-c", "protocol.file.allow=always"];
  spawnSync("git", ["-C", dir, ...AUTHOR, ...allow, "submodule", "add", "-q", origin, path]);
  spawnSync("git", ["-C", dir, ...AUTHOR, "commit", "-qm", "vendor"]);
  return origin;
}

/**
 * A git long-running filter process (protocol v2, pkt-line over stdio) that answers every `clean`
 * with the same constant — the lossy shape that makes `git diff HEAD` blind to a rewritten file.
 * Written into the checkout under test and named by `filter.<driver>.process`.
 */
const PROCESS_FILTER = `import { readSync, writeSync } from "node:fs";

let buf = Buffer.alloc(0);
function need(n) {
  while (buf.length < n) {
    const chunk = Buffer.alloc(65536);
    const read = readSync(0, chunk, 0, chunk.length, null);
    if (!read) process.exit(0);
    buf = Buffer.concat([buf, chunk.subarray(0, read)]);
  }
}
function readPacket() {
  need(4);
  const len = parseInt(buf.subarray(0, 4).toString(), 16);
  if (len === 0) { buf = buf.subarray(4); return null; }
  need(len);
  const payload = buf.subarray(4, len);
  buf = buf.subarray(len);
  return payload;
}
function readUntilFlush() {
  const out = [];
  for (let p = readPacket(); p !== null; p = readPacket()) out.push(Buffer.from(p));
  return out;
}
function write(text) {
  const payload = Buffer.from(text);
  const head = Buffer.from((payload.length + 4).toString(16).padStart(4, "0"));
  writeSync(1, Buffer.concat([head, payload]));
}
function flush() { writeSync(1, Buffer.from("0000")); }

readUntilFlush();
write("git-filter-server\\n");
write("version=2\\n");
flush();
readUntilFlush();
write("capability=clean\\n");
write("capability=smudge\\n");
flush();

for (;;) {
  const head = readUntilFlush();
  if (!head.length) process.exit(0);
  readUntilFlush();
  const command = head.map(String).find((line) => line.startsWith("command="))?.slice(8).trim();
  write("status=success\\n");
  flush();
  if (command === "clean") write("constant\\n");
  flush();
  flush();
}
`;

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
  // The same evidence for an install no git can describe: its source digest is the only thing a
  // verdict there has past the version (PR #217 review).
  it("calls a git-less install whose source moved under the server modified", () => {
    const running = { version: "0.4.0", revision: null, source: "aa11bb22cc33" };
    expect(compareBuild(running, { ...running, source: "dd44ee55ff66" }).state).toBe("modified");
    expect(compareBuild(running, { ...running }).state).toBe("current");
    // And an absence stays no evidence: a record written before the field must not demand a restart.
    expect(compareBuild(running, { ...running, source: null }).state).toBe("current");
  });

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
    // No commit to diff against, so what such an install holds is read as a source digest instead.
    expect(readBuildIdentity(dir, {})).toEqual({
      version: "0.4.0",
      revision: null,
      worktree: null,
      source: expect.stringMatching(/^[0-9a-f]{12}$/),
      env: null,
    });
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
    // And the source walk is skipped with it: RELEASE_VERSION identifies a bundle exactly, so the
    // digest would only cost every read of one a walk of the whole install.
    expect(readBuildIdentity(bundle, {})).toEqual({
      version: "0.9.1",
      revision: null,
      worktree: null,
      source: null,
      env: null,
    });
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
    const edited = readBuildIdentity(dir).worktree;
    expect(edited).not.toBe(first);

    // The production files only, the same ones a git-less install's `source` digest names back in:
    // `anton start` builds in production mode, where Next never loads `.env.development` — hashing
    // it called the running server modified and rebuilt it for configuration the artifact cannot
    // hold (PR #217 review).
    writeFileSync(join(dir, ".env.development"), "NEXT_PUBLIC_API=https://dev\n");
    expect(readBuildIdentity(dir).worktree).toBe(edited);
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

  // A clean FILTER converts worktree contents to their canonical repository form BEFORE git compares
  // them, so `git diff HEAD` sees the driver's output on both sides — a conversion `--no-textconv`
  // and `--no-ext-diff` do not reach, since neither disables anything outside diff time. A lossy
  // driver therefore reports no change however often the file is rewritten, while Next compiles the
  // raw bytes on disk and `anton start` reuses a `.next` built from the previous ones.
  it("digests a tracked edit a configured clean filter would canonicalize away", () => {
    const dir = gitCheckout();
    writeFileSync(join(dir, ".gitattributes"), "*.ts filter=flat\n");
    spawnSync("git", ["-C", dir, "config", "filter.flat.clean", "sh -c 'echo constant'"]);
    spawnSync("git", ["-C", dir, "add", "-A"]);
    spawnSync("git", ["-C", dir, ...AUTHOR, "commit", "-qm", "clean filter"]);
    const first = readBuildIdentity(dir).worktree;
    expect(first).toMatch(/^[0-9a-f]{12}$/);

    writeFileSync(join(dir, "src.ts"), SOURCE.replace("1", "2"));
    expect(readBuildIdentity(dir).worktree).not.toBe(first);
  });

  // A long-running `filter.<driver>.process` is the OTHER way to configure a conversion — git asks
  // the process for its `clean` capability and diffs THAT output, so a lossy process-only driver
  // (git-lfs's shape) hides a rewritten file exactly as a `clean` command does. Discovering only
  // `.clean` drivers left those paths out of the raw-content inputs, and a stale `.next` then passed
  // as this checkout (PR #217 review).
  it("digests a tracked edit a process-only filter driver would canonicalize away", () => {
    const dir = gitCheckout();
    const filter = join(dir, "filter.mjs");
    writeFileSync(filter, PROCESS_FILTER);
    writeFileSync(join(dir, ".gitattributes"), "*.ts filter=proc\n");
    spawnSync("git", ["-C", dir, "config", "filter.proc.process", `${process.execPath} ${filter}`]);
    spawnSync("git", ["-C", dir, "add", "-A"]);
    // src.ts was committed before the attribute existed, so only a renormalize runs the driver over it.
    spawnSync("git", ["-C", dir, "add", "--renormalize", "."]);
    spawnSync("git", ["-C", dir, ...AUTHOR, "commit", "-qm", "process filter"]);
    // The driver hides the edit from the diff, so only the raw-content read can tell these apart.
    const first = readBuildIdentity(dir).worktree;
    expect(first).toMatch(/^[0-9a-f]{12}$/);
    writeFileSync(join(dir, "src.ts"), SOURCE.replace("1", "2"));
    expect(spawnSync("git", ["-C", dir, "diff", "HEAD"]).stdout.toString()).toBe("");

    expect(readBuildIdentity(dir).worktree).not.toBe(first);
  });

  // `ident` is git's BUILT-IN canonicalization: check-in rewrites an expanded `$Id: <sha> $` back to
  // the bare `$Id$`, so every worktree byte between those markers is converted away before the diff
  // ever runs. Two different files therefore diff identically, and reading only configured filter
  // drivers left them out of the raw-content inputs — a stale `.next` then passed as this checkout
  // (PR #217 review).
  it("digests a tracked edit the ident attribute would canonicalize away", () => {
    const dir = gitCheckout();
    writeFileSync(join(dir, ".gitattributes"), "*.ts ident\n");
    writeFileSync(join(dir, "src.ts"), `// $Id$\n${SOURCE}`);
    spawnSync("git", ["-C", dir, "add", "-A"]);
    spawnSync("git", ["-C", dir, ...AUTHOR, "commit", "-qm", "ident"]);

    writeFileSync(join(dir, "src.ts"), `// $Id: aaaaaaa $\n${SOURCE}`);
    expect(spawnSync("git", ["-C", dir, "diff", "HEAD"]).stdout.toString()).toBe("");
    const first = readBuildIdentity(dir).worktree;
    expect(first).toMatch(/^[0-9a-f]{12}$/);

    writeFileSync(join(dir, "src.ts"), `// $Id: bbbbbbb $\n${SOURCE}`);
    expect(readBuildIdentity(dir).worktree).not.toBe(first);
  });

  // Git documents the `text` attribute as normalizing line endings in the index, so `git diff HEAD`
  // compares CONVERTED content: rewriting a tracked file from LF to CRLF moves nothing there while
  // the raw bytes the build reads did move. Reading only the diff left those paths out of the
  // raw-content inputs, and a stale `.next` then passed as this checkout (PR #217 review).
  it("digests a tracked edit line-ending normalization would hide", () => {
    const dir = gitCheckout();
    writeFileSync(join(dir, ".gitattributes"), "*.ts text\n");
    spawnSync("git", ["-C", dir, "add", "-A"]);
    spawnSync("git", ["-C", dir, ...AUTHOR, "commit", "-qm", "text"]);
    const first = readBuildIdentity(dir).worktree;
    expect(first).toMatch(/^[0-9a-f]{12}$/);

    writeFileSync(join(dir, "src.ts"), SOURCE.replace(/\n/g, "\r\n"));
    expect(spawnSync("git", ["-C", dir, "diff", "HEAD"]).stdout.toString()).toBe("");
    expect(readBuildIdentity(dir).worktree).not.toBe(first);
  });

  // `core.autocrlf` asks for the same normalization on every path no attribute speaks for — git's
  // own Windows default — so the hole is open in a checkout carrying no `.gitattributes` at all.
  it("digests a tracked edit core.autocrlf would normalize away", () => {
    const dir = gitCheckout();
    spawnSync("git", ["-C", dir, "config", "core.autocrlf", "input"]);
    const first = readBuildIdentity(dir).worktree;
    expect(first).toMatch(/^[0-9a-f]{12}$/);

    writeFileSync(join(dir, "src.ts"), SOURCE.replace(/\n/g, "\r\n"));
    expect(spawnSync("git", ["-C", dir, "diff", "HEAD"]).stdout.toString()).toBe("");
    expect(readBuildIdentity(dir).worktree).not.toBe(first);
  });

  // `-text` is the setting that refuses the conversion outright, so the diff does vouch for those
  // paths and re-reading them would cost every checkout that declares it.
  it("leaves a path marked -text to the diff", () => {
    const dir = gitCheckout();
    writeFileSync(join(dir, ".gitattributes"), "* -text\n");
    spawnSync("git", ["-C", dir, "add", "-A"]);
    spawnSync("git", ["-C", dir, ...AUTHOR, "commit", "-qm", "no text"]);
    expect(readBuildIdentity(dir).worktree).toBe("clean");

    writeFileSync(join(dir, "src.ts"), SOURCE.replace("1", "2"));
    expect(readBuildIdentity(dir).worktree).toMatch(/^[0-9a-f]{12}$/);
  });

  // An index flag is the one thing that stops git looking at the worktree AT ALL: git documents
  // both `--assume-unchanged` and `--skip-worktree` (what sparse checkout sets) as suppressing that
  // inspection, so `git diff HEAD` reports nothing however often the file is rewritten. Reading only
  // the diff left those paths out of the raw-content inputs, and a stale `.next` then passed as this
  // checkout (PR #217 review).
  it.each([["assume-unchanged"], ["skip-worktree"]])("digests a tracked edit %s hides from the diff", (flag) => {
    const dir = gitCheckout();
    spawnSync("git", ["-C", dir, "update-index", `--${flag}`, "src.ts"]);
    expect(readBuildIdentity(dir).worktree).toMatch(/^[0-9a-f]{12}$/);
    const first = readBuildIdentity(dir).worktree;

    writeFileSync(join(dir, "src.ts"), SOURCE.replace("1", "2"));
    expect(spawnSync("git", ["-C", dir, "diff", "HEAD"]).stdout.toString()).toBe("");
    expect(readBuildIdentity(dir).worktree).not.toBe(first);
  });

  // The sparse-checkout shape: skip-worktree on a path that is not on disk. The file's absence is
  // itself an input, so the identity stays provable — and moves the moment the path is there.
  it("digests a skip-worktree path that is not on disk", () => {
    const dir = gitCheckout();
    spawnSync("git", ["-C", dir, "update-index", "--skip-worktree", "src.ts"]);
    rmSync(join(dir, "src.ts"));
    const absent = readBuildIdentity(dir).worktree;
    expect(absent).toMatch(/^[0-9a-f]{12}$/);

    writeFileSync(join(dir, "src.ts"), SOURCE);
    expect(readBuildIdentity(dir).worktree).not.toBe(absent);
  });

  // Only a driver with a `clean` command configured converts anything: the attribute on its own
  // leaves the bytes alone, the diff already covers them, and re-reading the tree for that would
  // cost every checkout declaring a filter it has no driver for.
  it("leaves a filter attribute with no configured driver to the diff", () => {
    const dir = gitCheckout();
    writeFileSync(join(dir, ".gitattributes"), "*.ts filter=absent\n");
    spawnSync("git", ["-C", dir, "add", "-A"]);
    spawnSync("git", ["-C", dir, ...AUTHOR, "commit", "-qm", "attribute only"]);
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

  // Contents alone do not identify an entry: an empty file and an empty directory both fold in
  // nothing, so a `config` replaced by a `config/` under a linked source tree would digest the same
  // while Next compiles something else — and `buildMatchesCheckout` would hand back the old `.next`.
  it("tells an empty file apart from an empty directory of the same name", () => {
    const dir = gitCheckout();
    const shared = join(tempDir(), "shared");
    mkdirSync(shared);
    writeFileSync(join(shared, "config"), "");
    symlinkSync(shared, join(dir, "linked"));
    const asFile = readBuildIdentity(dir).worktree;
    expect(asFile).toMatch(/^[0-9a-f]{12}$/);

    rmSync(join(shared, "config"));
    mkdirSync(join(shared, "config"));
    expect(readBuildIdentity(dir).worktree).not.toBe(asFile);
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

  // A submodule is a gitlink: `git diff HEAD` compares the COMMIT it points at and flattens
  // everything uncommitted inside it to the suffix `-dirty`, so a checkout compiling through a
  // vendored submodule reports the identical line however often a file in there is rewritten — and
  // `anton start` reuses a `.next` compiled from the previous contents while calling it current.
  it("digests the uncommitted contents of a submodule worktree", () => {
    const dir = gitCheckout();
    submodule(dir, "vendor");
    expect(readBuildIdentity(dir).worktree).toBe("clean");

    writeFileSync(join(dir, "vendor", "lib.ts"), SOURCE.replace("1", "2"));
    const first = readBuildIdentity(dir).worktree;
    expect(first).toMatch(/^[0-9a-f]{12}$/);

    // The edit the `-dirty` suffix cannot tell from the one before it.
    writeFileSync(join(dir, "vendor", "lib.ts"), SOURCE.replace("1", "3"));
    const second = readBuildIdentity(dir).worktree;
    expect(second).not.toBe(first);

    // Untracked inside the submodule: the parent's `ls-files --others` stops at the boundary.
    writeFileSync(join(dir, "vendor", "extra.ts"), "export const m = 3;\n");
    expect(readBuildIdentity(dir).worktree).not.toBe(second);

    // And back — undoing work inside a submodule clears the verdict as undoing it here does.
    rmSync(join(dir, "vendor", "extra.ts"));
    writeFileSync(join(dir, "vendor", "lib.ts"), SOURCE);
    expect(readBuildIdentity(dir).worktree).toBe("clean");
  });

  // Deinitializing a clean submodule leaves the gitlink and the parent diff untouched — `git status`
  // reports nothing — while the source the build compiled through is gone from disk. Skipping an
  // empty worktree made that state and a checked-out clean one the same digest, so `anton start`
  // would hand back a `.next` built from code the machine no longer has.
  it("digests whether a submodule is checked out at all", () => {
    const dir = gitCheckout();
    submodule(dir, "vendor");
    expect(readBuildIdentity(dir).worktree).toBe("clean");

    spawnSync("git", ["-C", dir, "submodule", "--quiet", "deinit", "-f", "vendor"]);
    expect(readBuildIdentity(dir).worktree).toMatch(/^[0-9a-f]{12}$/);

    // And back: the source is on disk again, so the build compiled through it is provable again.
    const allow = ["-c", "protocol.file.allow=always"];
    spawnSync("git", ["-C", dir, ...allow, "submodule", "update", "--init", "-q", "vendor"]);
    expect(readBuildIdentity(dir).worktree).toBe("clean");
  });

  // The commit a submodule points at is the parent's own tracked content, so moving it is drift the
  // parent diff sees — provided config cannot hide the gitlink line from that diff.
  it("digests a submodule moved to a different commit, whatever the repo asks git to ignore", () => {
    const dir = gitCheckout();
    const origin = submodule(dir, "vendor");
    spawnSync("git", ["-C", dir, "config", "diff.ignoreSubmodules", "all"]);
    spawnSync("git", ["-C", dir, "config", "submodule.vendor.ignore", "all"]);
    expect(readBuildIdentity(dir).worktree).toBe("clean");

    writeFileSync(join(origin, "lib.ts"), SOURCE.replace("1", "2"));
    spawnSync("git", ["-C", origin, "add", "-A"]);
    spawnSync("git", ["-C", origin, ...AUTHOR, "commit", "-qm", "second"]);
    spawnSync("git", ["-C", join(dir, "vendor"), "fetch", "-q", "origin"]);
    spawnSync("git", ["-C", join(dir, "vendor"), "checkout", "-q", "FETCH_HEAD"]);
    expect(readBuildIdentity(dir).worktree).toMatch(/^[0-9a-f]{12}$/);
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

    // The edge of that rule, asserted so crossing it has to be a decision: an ignored module the
    // build would IMPORT is a miss anton accepts (PR #217 review). Digesting the ignored tree to
    // catch it would move the digest on every anton.db write and every `.DS_Store` macOS drops —
    // a restart banner with no release behind it, which costs more than the miss does.
    writeFileSync(join(dir, "junk", "config.ts"), "export const url = 'old';\n");
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
    // Nor is it the git-less shape: a checkout whose git is momentarily unreadable has a commit,
    // and `sameCheckout` blocks on that rather than substituting a digest of the tree.
    expect(identity.source).toBeNull();
  });

  it("still reads a real tarball — no .git at all — as having no commit", () => {
    const dir = tempDir();
    writeFileSync(join(dir, "package.json"), JSON.stringify({ version: "0.4.0" }));
    expect(readBuildIdentity(dir, {}).revision).toBeNull();
  });

  /**
   * A `git init` with nothing committed fails `rev-parse HEAD` exactly as a corrupt repository
   * does, and reading it as unreadable left the checkout with no digest of any kind: `sameCheckout`
   * then rejected its own pre/post-build identities, so `anton start` built three times and refused
   * to start (PR #217 review).
   */
  it("reads a checkout with no commit yet as having none, and digests its source", () => {
    const dir = tempDir();
    writeFileSync(join(dir, "package.json"), JSON.stringify({ version: "0.4.0" }));
    writeFileSync(join(dir, "src.ts"), SOURCE);
    spawnSync("git", ["init", "-q", dir]);

    const identity = readBuildIdentity(dir, {});
    expect(identity.revision).toBeNull();
    expect(identity.worktree).toBeNull(); // nothing to diff an unborn HEAD against
    expect(identity.source).toMatch(/^[0-9a-f]{12}$/);
    // Which is what makes it buildable: two reads of an unchanged tree are the same checkout.
    expect(sameCheckout(identity, readBuildIdentity(dir, {}))).toBe(true);

    writeFileSync(join(dir, "src.ts"), SOURCE.replace("1", "2"));
    expect(readBuildIdentity(dir, {}).source).not.toBe(identity.source);
  });

  it("goes back to reading the commit once that checkout has one", () => {
    const dir = gitCheckout();
    const identity = readBuildIdentity(dir, {});
    expect(identity.revision).toMatch(/^[0-9a-f]{7,64}$/);
    expect(identity.source).toBeNull();
  });
});

// An install with no `.git` — an extracted source tarball, or the `npm i -g anton` the README
// documents — has no commit to diff against, so version was its whole identity: editing any
// ordinary file left both sides equal and `anton start` reused a `.next` compiled from the code the
// operator had just replaced (PR #217 review).
describe("the source digest of an install no git can describe", () => {
  /** That shape: a package.json, source beside it, and neither a `.git` nor a RELEASE_VERSION. */
  function tarball(): string {
    const dir = tempDir();
    writeFileSync(join(dir, "package.json"), JSON.stringify({ version: "0.4.0" }));
    mkdirSync(join(dir, "src"));
    writeFileSync(join(dir, "src", "page.tsx"), SOURCE);
    return dir;
  }

  it("moves when an ordinary source file is edited, and is a function of the tree", () => {
    const dir = tarball();
    const first = readBuildIdentity(dir, {}).source;
    expect(first).toMatch(/^[0-9a-f]{12}$/);

    writeFileSync(join(dir, "src", "page.tsx"), SOURCE.replace("1", "2"));
    expect(readBuildIdentity(dir, {}).source).not.toBe(first);

    // Same bytes at the same path is the same build, so undoing an edit clears the verdict.
    writeFileSync(join(dir, "src", "page.tsx"), SOURCE);
    expect(readBuildIdentity(dir, {}).source).toBe(first);
  });

  it("counts a file that is only added, and one only removed", () => {
    const dir = tarball();
    const first = readBuildIdentity(dir, {}).source;
    writeFileSync(join(dir, "src", "route.ts"), SOURCE);
    expect(readBuildIdentity(dir, {}).source).not.toBe(first);
    rmSync(join(dir, "src", "route.ts"));
    expect(readBuildIdentity(dir, {}).source).toBe(first);
  });

  // The digest has to be a fact about the CODE. anton writes its database and one record per running
  // server beside its own source, and Next rewrites `.next` on every build — a digest that read any
  // of them would move on its own, and a restart banner with no release behind it is one nobody
  // reads.
  it("ignores build output, dependencies and the state a running anton writes beside its code", () => {
    const dir = tarball();
    const first = readBuildIdentity(dir, {}).source;

    writeFileSync(join(dir, "anton.db"), "sqlite");
    writeFileSync(join(dir, "anton.db-wal"), "wal");
    writeFileSync(join(dir, buildRecordFile(process.pid)), "{}");
    writeFileSync(join(dir, "tsconfig.tsbuildinfo"), "{}");
    mkdirSync(join(dir, ".anton"));
    writeFileSync(join(dir, ".anton", "session.log"), "noise");
    mkdirSync(join(dir, ".next"));
    writeFileSync(join(dir, ".next", "build-manifest.json"), "{}");
    mkdirSync(join(dir, "node_modules"));
    writeFileSync(join(dir, "node_modules", "dep.js"), SOURCE);
    mkdirSync(join(dir, "coverage"));
    writeFileSync(join(dir, "coverage", "index.html"), "<p>");

    expect(readBuildIdentity(dir, {}).source).toBe(first);
  });

  // Those same names are ordinary source further down — anton's own drift modules live in
  // `src/lib/build/` — so excluding them by name at any depth made an edit to them invisible and let
  // a git-less install serve a `.next` compiled before it (PR #217 review).
  it("walks a source directory that shares a name with a build output root", () => {
    const dir = tarball();
    mkdirSync(join(dir, "src", "lib", "build"), { recursive: true });
    const nested = join(dir, "src", "lib", "build", "drift.ts");
    writeFileSync(nested, SOURCE);
    const first = readBuildIdentity(dir, {}).source;

    writeFileSync(nested, SOURCE.replace("1", "2"));
    expect(readBuildIdentity(dir, {}).source).not.toBe(first);
    writeFileSync(nested, SOURCE);
    expect(readBuildIdentity(dir, {}).source).toBe(first);

    // The root ones stay out: that is where the build writes, and a digest reading them would move
    // on its own.
    mkdirSync(join(dir, "dist"));
    writeFileSync(join(dir, "dist", "bundle.js"), SOURCE);
    expect(readBuildIdentity(dir, {}).source).toBe(first);

    // A nested dependency tree is a dependency wherever it sits, so that one name is skipped at
    // every depth.
    mkdirSync(join(dir, "src", "node_modules"));
    writeFileSync(join(dir, "src", "node_modules", "dep.js"), SOURCE);
    expect(readBuildIdentity(dir, {}).source).toBe(first);
  });

  // Same shape one level over: what a running anton rewrites is dot-named AND lives at the root, so
  // skipping dot-entries at every depth only hid real build inputs — a config importing
  // `./src/.config/flavor.mjs` compiled that module while the digest stayed put (PR #217 review).
  it("walks a dot-named source directory below the install root", () => {
    const dir = tarball();
    mkdirSync(join(dir, "src", ".config"));
    const nested = join(dir, "src", ".config", "flavor.mjs");
    writeFileSync(nested, SOURCE);
    const first = readBuildIdentity(dir, {}).source;

    writeFileSync(nested, SOURCE.replace("1", "2"));
    expect(readBuildIdentity(dir, {}).source).not.toBe(first);
    writeFileSync(nested, SOURCE);
    expect(readBuildIdentity(dir, {}).source).toBe(first);

    // The names that are state wherever they sit stay out at depth too: a vendored submodule carries
    // its own `.git`, a nested app its own `.next`, and Finder writes `.DS_Store` anywhere.
    mkdirSync(join(dir, "src", ".git"));
    writeFileSync(join(dir, "src", ".git", "index"), "churn");
    mkdirSync(join(dir, "src", ".next"));
    writeFileSync(join(dir, "src", ".next", "build-manifest.json"), "{}");
    writeFileSync(join(dir, "src", ".DS_Store"), "finder");
    expect(readBuildIdentity(dir, {}).source).toBe(first);
  });

  // `readEnvDigest` hashes these files too, but only freshness reads that field — a drift VERDICT
  // cannot weigh one whose other half is the reading shell's own environment. So while the dot-skip
  // hid them, a git-less install could edit `.env.local` under a running server, go on serving the
  // `NEXT_PUBLIC_*` value it no longer holds, and have doctor and the health page both call that
  // server current (PR #217 review). A checkout never had the hole: `ignoredEnvFiles` puts the same
  // files in the worktree digest, which is compared.
  it("moves when an env file the production build inlines from is edited", () => {
    const dir = tarball();
    const clean = readBuildIdentity(dir, {}).source;

    writeFileSync(join(dir, ".env.local"), "NEXT_PUBLIC_URL=old\n");
    const running = readBuildIdentity(dir, {});
    expect(running.source).not.toBe(clean);

    writeFileSync(join(dir, ".env.local"), "NEXT_PUBLIC_URL=new\n");
    const onDisk = readBuildIdentity(dir, {});
    expect(onDisk.source).not.toBe(running.source);
    expect(compareBuild(running, onDisk).state).toBe("modified");

    // Named one by one, not `.env*` wholesale: only these reach a production build, and the other
    // modes hold per-developer values that would rebuild it for nothing.
    writeFileSync(join(dir, ".env.development"), "NEXT_PUBLIC_URL=dev\n");
    expect(readBuildIdentity(dir, {}).source).toBe(onDisk.source);
  });

  // A dot-name at the root is not state by virtue of the dot: `next.config.mjs` importing
  // `./.build-flavor.mjs` compiles that module in, and skipping every root dot-entry left the digest
  // put while the artifact changed (PR #217 review). Only the names a running anton and its
  // toolchain rewrite are skipped, one by one.
  it("walks a root dot-file the build compiles from, and still skips the state beside it", () => {
    const dir = tarball();
    const flavor = join(dir, ".build-flavor.mjs");
    writeFileSync(flavor, "export default 'one';\n");
    const first = readBuildIdentity(dir, {}).source;

    writeFileSync(flavor, "export default 'two';\n");
    expect(readBuildIdentity(dir, {}).source).not.toBe(first);
    writeFileSync(flavor, "export default 'one';\n");
    expect(readBuildIdentity(dir, {}).source).toBe(first);

    // Tracked dot-trees are source too — a checkout digests them, so a git-less install must.
    mkdirSync(join(dir, ".github", "workflows"), { recursive: true });
    writeFileSync(join(dir, ".github", "workflows", "ci.yml"), "on: push\n");
    expect(readBuildIdentity(dir, {}).source).not.toBe(first);
    rmSync(join(dir, ".github"), { recursive: true });
    expect(readBuildIdentity(dir, {}).source).toBe(first);

    // What a running anton writes is what stays out: the board rewrites `.dolt` on every command,
    // and `.claude` holds whole isolation worktrees.
    mkdirSync(join(dir, ".dolt"));
    writeFileSync(join(dir, ".dolt", "manifest"), "churn");
    mkdirSync(join(dir, ".claude"));
    writeFileSync(join(dir, ".claude", "session.json"), "{}");
    mkdirSync(join(dir, ".beads"));
    writeFileSync(join(dir, ".beads", "issues.jsonl"), "{}");
    expect(readBuildIdentity(dir, {}).source).toBe(first);
  });

  it("is not read where git can answer, nor for a bundle that needs no rebuild", () => {
    expect(readBuildIdentity(gitCheckout(), {}).source).toBeNull();
    const bundle = tempDir();
    writeFileSync(join(bundle, "RELEASE_VERSION"), "0.9.1\n");
    writeFileSync(join(bundle, "server.js"), SOURCE);
    expect(readBuildIdentity(bundle, {}).source).toBeNull();
  });

  // Same rule as every other read here: a tree anton could only read part of is one it rebuilds
  // rather than vouches for, since a truncated walk hashes the same bytes however the entries past
  // the cutoff change.
  it("abandons a tree too large to read whole, which makes the build unprovable", () => {
    const dir = tarball();
    // Named so they sort LAST — past the cutoff, where a truncated walk stops looking.
    for (let i = 0; i <= MAX_SOURCE_ENTRIES; i++) writeFileSync(join(dir, `z${String(i).padStart(6, "0")}.ts`), "");
    expect(readBuildIdentity(dir, {}).source).toBeNull();

    mkdirSync(join(dir, ".next"));
    writeBuildStamp(dir, readBuildIdentity(dir, {}));
    expect(buildMatchesCheckout(dir, readBuildIdentity(dir, {}))).toBe(false);
  });

  it("names nothing for a directory that is not there at all", () => {
    expect(readBuildIdentity(join(tempDir(), "gone"), {}).source).toBeNull();
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

  // The FILE side of the digest, and the only side an install with no `.git` has: `readWorktreeDigest`
  // never runs there, so nothing else in the identity ever reads these bytes (PR #217 review).
  it("digests the env files themselves, on an install no git can describe", () => {
    const dir = app();
    writeFileSync(join(dir, ".env.local"), "NEXT_PUBLIC_URL=old\n");
    const first = readBuildIdentity(dir, { PATH: "/usr/bin" }).env;
    expect(first).toMatch(/^[0-9a-f]{12}$/);
    writeFileSync(join(dir, ".env.local"), "NEXT_PUBLIC_URL=new\n");
    expect(readBuildIdentity(dir, { PATH: "/usr/bin" }).env).not.toBe(first);
  });

  // Same bytes under a different name is a different build: Next loads `.env.local` over `.env`, and
  // moving a value between them changes which one wins.
  it("frames each env file from its contents", () => {
    const one = app();
    writeFileSync(join(one, ".env"), "NEXT_PUBLIC_URL=x\n");
    const other = app();
    writeFileSync(join(other, ".env.local"), "NEXT_PUBLIC_URL=x\n");
    expect(readBuildIdentity(one, {}).env).not.toBe(readBuildIdentity(other, {}).env);
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

  // Next resolves `$API_HOST` from the BUILD's environment before inlining the public value, so the
  // env file that names it holds the same bytes while what it compiles in moves (PR #217 review).
  it("digests a variable an env file expands into an inlined value", () => {
    const dir = app();
    writeFileSync(join(dir, ".env.local"), "NEXT_PUBLIC_API_URL=$API_HOST\n");
    const first = readBuildIdentity(dir, { API_HOST: "https://one" }).env;
    expect(first).toMatch(/^[0-9a-f]{12}$/);
    expect(readBuildIdentity(dir, { API_HOST: "https://two" }).env).not.toBe(first);
  });

  // A reference to something the build environment does not set expands to nothing, so it adds
  // nothing past the file's own bytes — which the digest already carries either way.
  it("names an expanded variable only where the environment sets one", () => {
    const dir = app();
    writeFileSync(join(dir, ".env"), "NEXT_PUBLIC_API_URL=${API_HOST}\n");
    const unset = readBuildIdentity(dir, { PATH: "/usr/bin" }).env;
    expect(readBuildIdentity(dir, { PATH: "/usr/other" }).env).toBe(unset);
    expect(readBuildIdentity(dir, { API_HOST: "https://one" }).env).not.toBe(unset);
  });

  // `next.config.ts` is ordinary JavaScript that runs at build time, so a variable it reads decides
  // what Next compiles while every file on disk stays put — and it wears no `NEXT_PUBLIC_` prefix
  // and appears in no env file, so nothing else in the identity sees it (PR #217 review).
  it("digests a variable the Next config reads", () => {
    const dir = app();
    writeFileSync(join(dir, "next.config.ts"), "export default { env: { FLAVOR: process.env.BUILD_FLAVOR } };\n");
    const first = readBuildIdentity(dir, { BUILD_FLAVOR: "one" }).env;
    expect(first).toMatch(/^[0-9a-f]{12}$/);
    expect(readBuildIdentity(dir, { BUILD_FLAVOR: "two" }).env).not.toBe(first);
    expect(readBuildIdentity(dir, { BUILD_FLAVOR: "one" }).env).toBe(first);
  });

  // `const { BUILD_FLAVOR } = process.env` reads the same variable without ever spelling
  // `process.env.NAME`, so a name-only scan missed it and `anton start` accepted a `.next` holding
  // the previous configuration (PR #217 review).
  it("reads a variable the config destructures out of the environment", () => {
    const dir = app();
    writeFileSync(
      join(dir, "next.config.mjs"),
      "const { BUILD_FLAVOR } = process.env;\nexport default { env: { F: BUILD_FLAVOR } };\n",
    );
    const first = readBuildIdentity(dir, { BUILD_FLAVOR: "one" }).env;
    expect(first).toMatch(/^[0-9a-f]{12}$/);
    expect(readBuildIdentity(dir, { BUILD_FLAVOR: "two" }).env).not.toBe(first);
  });

  // A binding may be renamed or defaulted on its way out of the destructure — what names the
  // variable is the KEY, never the local it lands in.
  it("reads a destructured variable that is renamed or defaulted", () => {
    const dir = app();
    writeFileSync(
      join(dir, "next.config.ts"),
      'const { BUILD_FLAVOR: flavor = "dev", ANALYZE } = process.env;\nexport default { env: { flavor }, analyze: ANALYZE };\n',
    );
    const base = { BUILD_FLAVOR: "one", ANALYZE: "0" };
    expect(readBuildIdentity(dir, { ...base, BUILD_FLAVOR: "two" }).env).not.toBe(readBuildIdentity(dir, base).env);
    expect(readBuildIdentity(dir, { ...base, ANALYZE: "1" }).env).not.toBe(readBuildIdentity(dir, base).env);
  });

  // `const env = process.env` puts the whole environment behind a local, and every read through it
  // is invisible to a pattern anchored on `process.env` — the config compiles a different artifact
  // and the digest never moves (PR #217 review).
  it("reads a variable the config takes through an alias of process.env", () => {
    const dir = app();
    writeFileSync(
      join(dir, "next.config.ts"),
      "const env = process.env;\nexport default { env: { FLAVOR: env.BUILD_FLAVOR, A: env[\"ANALYZE\"] } };\n",
    );
    const base = { BUILD_FLAVOR: "one", ANALYZE: "0" };
    expect(readBuildIdentity(dir, { ...base, BUILD_FLAVOR: "two" }).env).not.toBe(readBuildIdentity(dir, base).env);
    expect(readBuildIdentity(dir, { ...base, ANALYZE: "1" }).env).not.toBe(readBuildIdentity(dir, base).env);
  });

  // The two routes compose: an alias may itself be destructured, which names a variable at two
  // removes from anything spelling `process.env`.
  it("reads a variable destructured out of an alias of process.env", () => {
    const dir = app();
    writeFileSync(
      join(dir, "next.config.mjs"),
      "const env = process.env;\nconst { BUILD_FLAVOR } = env;\nexport default { env: { F: BUILD_FLAVOR } };\n",
    );
    expect(readBuildIdentity(dir, { BUILD_FLAVOR: "one" }).env).not.toBe(readBuildIdentity(dir, { BUILD_FLAVOR: "two" }).env);
  });

  // `process.env?.BUILD_FLAVOR` is the same read with an optional chain in it, and compiles the same
  // value in — a pattern stopping at the `?` recorded nothing and let `ensureFreshBuild` reuse an
  // artifact built with the old configuration (PR #217 review).
  it("reads a variable the config takes through an optional chain", () => {
    const dir = app();
    writeFileSync(
      join(dir, "next.config.mjs"),
      'const env = process?.env;\nexport default { env: { F: process.env?.BUILD_FLAVOR, A: process.env?.["ANALYZE"], M: env?.MODE } };\n',
    );
    const base = { BUILD_FLAVOR: "one", ANALYZE: "0", MODE: "fast" };
    expect(readBuildIdentity(dir, { ...base, BUILD_FLAVOR: "two" }).env).not.toBe(readBuildIdentity(dir, base).env);
    expect(readBuildIdentity(dir, { ...base, ANALYZE: "1" }).env).not.toBe(readBuildIdentity(dir, base).env);
    expect(readBuildIdentity(dir, { ...base, MODE: "slow" }).env).not.toBe(readBuildIdentity(dir, base).env);
  });

  it("reads the same variable through an indexed access", () => {
    const dir = app();
    writeFileSync(join(dir, "next.config.mjs"), 'export default { env: { F: process.env["BUILD_FLAVOR"] } };\n');
    expect(readBuildIdentity(dir, { BUILD_FLAVOR: "one" }).env).not.toBe(readBuildIdentity(dir, { BUILD_FLAVOR: "two" }).env);
  });

  // Same rule as an expanded env-file name: a variable the config names but the environment does
  // not set compiles nothing in, so it must not rebuild on every unrelated shell.
  it("names a config variable only where the environment sets one", () => {
    const dir = app();
    writeFileSync(join(dir, "next.config.js"), "module.exports = { env: { F: process.env.BUILD_FLAVOR } };\n");
    expect(readBuildIdentity(dir, { PATH: "/usr/bin" }).env).toBe(null);
    expect(readBuildIdentity(dir, { BUILD_FLAVOR: "one" }).env).toMatch(/^[0-9a-f]{12}$/);
  });

  // Static generation EXECUTES route code, so a prerendered page reading a variable bakes its value
  // into the artifact while every file on disk stays put — and it wears no `NEXT_PUBLIC_` prefix, is
  // in no env file and is named in no config, so nothing else in the identity sees it (PR #217 review).
  it("digests a variable the route tree reads", () => {
    const dir = app();
    mkdirSync(join(dir, "src", "app"), { recursive: true });
    writeFileSync(
      join(dir, "src", "app", "page.tsx"),
      "export default function Page() {\n  return <p>{process.env.BUILD_FLAVOR}</p>;\n}\n",
    );
    const first = readBuildIdentity(dir, { BUILD_FLAVOR: "one" }).env;
    expect(first).toMatch(/^[0-9a-f]{12}$/);
    expect(readBuildIdentity(dir, { BUILD_FLAVOR: "two" }).env).not.toBe(first);
    expect(readBuildIdentity(dir, { BUILD_FLAVOR: "one" }).env).toBe(first);
  });

  // Next resolves the App Router at the root as readily as under `src/`, and a build-time read is a
  // build-time read wherever the route file sits — including a nested route segment.
  it("reads the route tree at the install root too", () => {
    const dir = app();
    mkdirSync(join(dir, "app", "projects", "[id]"), { recursive: true });
    writeFileSync(
      join(dir, "app", "projects", "[id]", "page.tsx"),
      "export function generateStaticParams() {\n  return [{ id: process.env.BUILD_FLAVOR }];\n}\n",
    );
    expect(readBuildIdentity(dir, { BUILD_FLAVOR: "one" }).env).not.toBe(
      readBuildIdentity(dir, { BUILD_FLAVOR: "two" }).env,
    );
  });

  // Same rule as an expanded env-file name: a variable a route names but the environment does not
  // set compiles nothing in, so it must not rebuild on every unrelated shell.
  it("names a route variable only where the environment sets one", () => {
    const dir = app();
    mkdirSync(join(dir, "src", "app"), { recursive: true });
    writeFileSync(join(dir, "src", "app", "layout.tsx"), "export const F = process.env.BUILD_FLAVOR;\n");
    expect(readBuildIdentity(dir, { PATH: "/usr/bin" }).env).toBe(null);
    expect(readBuildIdentity(dir, { BUILD_FLAVOR: "one" }).env).toMatch(/^[0-9a-f]{12}$/);
  });

  // The scope stops at the route tree on purpose. Most of an app's server code reads its environment
  // at RUNTIME, and folding those names in would rebuild whenever a shell set one differently — a
  // runner and an `ANTON_RUNNER=off` UI sharing an install would each rebuild over the other's `.next`.
  it("ignores a variable only a library module outside the route tree reads", () => {
    const dir = app();
    mkdirSync(join(dir, "src", "lib"), { recursive: true });
    writeFileSync(join(dir, "src", "lib", "db.ts"), "export const db = process.env.ANTON_DB;\n");
    expect(readBuildIdentity(dir, { ANTON_DB: "/one/anton.db" }).env).toBe(null);
  });

  // Same rule as every other walk here: a route tree anton could only read part of is one it
  // rebuilds rather than vouches for. A scan that stopped at its ceiling names the same variables
  // however the routes past the cutoff change, so a prerendered page reading one beyond it would
  // leave the digest identical and `buildMatchesCheckout` would reuse the artifact built with the
  // old value (PR #217 review).
  it("cannot name the environment of a route tree too large to scan whole", () => {
    const dir = app();
    const routes = join(dir, "src", "app");
    mkdirSync(routes, { recursive: true });
    for (let i = 0; i <= MAX_ROUTE_ENTRIES; i++) writeFileSync(join(routes, `p${String(i).padStart(6, "0")}.tsx`), "");
    const shell = { BUILD_FLAVOR: "one" };
    const identity = readBuildIdentity(dir, shell);
    expect(identity.env).toBe(ENV_UNPROVABLE);

    // And two reads that both come up unprovable agree on nothing: the build is compiled again
    // rather than accepted.
    expect(sameCheckout(identity, readBuildIdentity(dir, shell))).toBe(false);
    mkdirSync(join(dir, ".next"));
    writeBuildStamp(dir, identity);
    expect(buildMatchesCheckout(dir, readBuildIdentity(dir, shell))).toBe(false);
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

  // An install with no git proves itself with its source digest instead. Two reads that agree on
  // one are the same code however little else either can name — including the version, which an
  // unreadable package.json leaves null on both sides.
  it("accepts a git-less install on the source digest it can produce", () => {
    const nothing = { version: null, revision: null, worktree: null, source: "9f2c1a4bb001" };
    expect(sameCheckout(nothing, { ...nothing })).toBe(true);
    expect(sameCheckout(nothing, { ...nothing, source: "aa11bb22cc33" })).toBe(false);
  });

  // The reviewer's case (PR #217): version alone was proof there, so an edited source file left
  // both sides equal and `anton start` reused a `.next` compiled from the code just replaced. A
  // walk that produced nothing is the same no as a git read that failed — two of them agree in
  // what neither could read.
  it("refuses a git-less install neither read could describe", () => {
    const nothing = { version: "0.4.0", revision: null, worktree: null, source: null };
    expect(sameCheckout(nothing, { ...nothing })).toBe(false);
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
    const stamp = {
      pid: 4242,
      bootedAt: 1_700_000_000_000,
      startedAt: "when-4242-began",
      appRoot: "/opt/anton",
      runner: true,
    };
    expect(writeBuildRecord(buildRecordPath(join(dir, "anton.db"), 4242), RUNNING, stamp)).toBe(true);
    expect(readBuildRecord(join(dir, "server-build.4242.json"))).toEqual({ ...RUNNING, ...stamp });
  });

  // A record written before the runner flag existed says nothing about the jobs either way, so the
  // absence is written as null rather than guessed at as false (PR #217 review).
  it("leaves the runner unclaimed when the caller does not say", () => {
    const dir = tempDir();
    writeBuildRecord(buildRecordPath(join(dir, "anton.db"), 4242), RUNNING, { pid: 4242 });
    expect(readBuildRecord(join(dir, "server-build.4242.json"))?.runner).toBeNull();
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

    pruneBuildRecords(db, (record) => ({ alive: record.pid === process.pid, stale: record.pid !== process.pid }));

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

  // What every reader reporting on "the running anton" starts from, shared so doctor and the health
  // page cannot answer differently: a neighbouring install's record and a dead server's leftover are
  // dropped, and everything still up is kept — including a second server of this install.
  it("keeps only the live servers of this install", () => {
    const dir = tempDir();
    const db = join(dir, "anton.db");
    writeBuildRecord(buildRecordPath(db, 4242), RUNNING, { pid: 4242, bootedAt: 1, appRoot: dir });
    writeBuildRecord(buildRecordPath(db, 4243), RUNNING, { pid: 4243, bootedAt: 2, appRoot: dir });
    writeBuildRecord(buildRecordPath(db, 4244), RUNNING, { pid: 4244, bootedAt: 3, appRoot: join(dir, "elsewhere") });

    const live = liveBuildRecords(db, dir, (record) => record.pid !== 4243);

    expect(live.map(({ record }) => record.pid)).toEqual([4242]);
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
    expect(recordAlive({ ...RUNNING, pid: process.pid, startedAt: reusedStamp() })).toBe(false);
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
  it("falls back to the pid alone when no birth time was ever recorded", () => {
    expect(recordAlive({ ...RUNNING, pid: process.pid })).toBe(true);
    expect(recordAlive({ ...RUNNING, pid: process.pid, startedAt: null }, () => null)).toBe(true);
    expect(recordAlive({ ...RUNNING, pid: 999999, startedAt: null })).toBe(false);
    expect(recordAlive(null)).toBe(false);
  });

  // A STAMPED record is the opposite case: the stamp is there because this machine could read birth
  // times at boot, so a lookup failing now leaves a reused pid indistinguishable from the live one.
  // Vouching for it hands doctor an unrelated process as anton's server (PR #217 review).
  it("refuses to vouch for a stamped record whose birth time cannot be rechecked", () => {
    const unverifiable = { ...RUNNING, pid: process.pid, startedAt: "born-then" };
    expect(recordAlive(unverifiable, () => null)).toBe(false);
    // ...and is not deleted for it: unproven is not proven dead, so the next read that CAN resolve
    // the stamp names the server again rather than finding its record gone.
    expect(recordVerdict(unverifiable, () => null)).toEqual({ alive: false, stale: false });
    expect(recordVerdict(unverifiable, () => "born-now")).toEqual({ alive: false, stale: true });
    expect(recordVerdict(unverifiable, () => "born-then")).toEqual({ alive: true, stale: false });
  });

  // The two birth-time readers spell the same instant differently — procfs in clock ticks, `ps` as a
  // formatted date — so a daemon stamped from procfs whose later `/proc/<pid>/stat` read fails falls
  // through to `ps` and compares unequal against ITSELF. Reading that as pid reuse deletes a live
  // server's record and lets `update` move the runtime under it (PR #217 review).
  it("treats a stamp from the other birth-time reader as unproven, not as a different process", () => {
    const fromProcfs = { ...RUNNING, pid: process.pid, startedAt: "proc:4212345" };
    expect(recordVerdict(fromProcfs, () => "ps:Wed Sep  2 07:16:57 2026")).toEqual({ alive: false, stale: false });
    // Within one reader the comparison still proves reuse — the tag narrows nothing else.
    expect(recordVerdict(fromProcfs, () => "proc:9999999")).toEqual({ alive: false, stale: true });
    expect(recordVerdict(fromProcfs, () => "proc:4212345")).toEqual({ alive: true, stale: false });
  });

  it("tags the birth stamp it reads with the reader that produced it", () => {
    expect(processStartedAt(process.pid)).toMatch(/^(proc|ps):/);
  });

  // The prune is the only writer here, so it stands on the STALE half: a record kept one boot too
  // long costs a file, while deleting a live server's own leaves that process unaccounted for.
  it("keeps a record it cannot verify and deletes only one proven stale", () => {
    const dir = tempDir();
    const db = join(dir, "anton.db");
    writeBuildRecord(buildRecordPath(db, 4242), RUNNING, { pid: 4242, bootedAt: 1, startedAt: "born-then" });
    writeBuildRecord(buildRecordPath(db, 4243), RUNNING, { pid: 4243, bootedAt: 2, startedAt: "born-then" });

    pruneBuildRecords(db, (record) =>
      record.pid === 4242 ? { alive: false, stale: false } : { alive: false, stale: true },
    );

    expect(listBuildRecords(db).map(({ record }) => record.pid)).toEqual([4242]);
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

  // A source install with no git names no commit on either side and never could — so what it holds
  // is read straight off disk, and the stamp is accepted only against the same source.
  it("accepts a git-less install against the source it was compiled from", () => {
    const app = checkout({ version: "0.4.0", revision: null });
    writeFileSync(join(app, "src.ts"), SOURCE);
    writeFileSync(buildStampPath(app), JSON.stringify(readBuildIdentity(app, {})));
    expect(buildMatchesCheckout(app, readBuildIdentity(app, {}))).toBe(true);
  });

  // The hole the reviewer named (PR #217): nothing in the identity moved when an ordinary source
  // file did, so `next start` served the code the operator had just replaced.
  it("rejects a git-less install whose source changed under the build", () => {
    const app = checkout({ version: "0.4.0", revision: null });
    writeFileSync(join(app, "src.ts"), SOURCE);
    writeFileSync(buildStampPath(app), JSON.stringify(readBuildIdentity(app, {})));
    writeFileSync(join(app, "src.ts"), SOURCE.replace("1", "2"));
    expect(buildMatchesCheckout(app, readBuildIdentity(app, {}))).toBe(false);
  });

  // The same install once it holds an `.env.local`: version alone stops being its whole identity,
  // because no worktree digest is ever read there to see those bytes move (PR #217 review).
  it("rejects a git-less install whose env file changed under the build", () => {
    const app = checkout({ version: "0.4.0", revision: null });
    writeFileSync(join(app, ".env.local"), "NEXT_PUBLIC_URL=old\n");
    writeFileSync(buildStampPath(app), JSON.stringify(readBuildIdentity(app, {})));
    expect(buildMatchesCheckout(app, readBuildIdentity(app, {}))).toBe(true);
    writeFileSync(join(app, ".env.local"), "NEXT_PUBLIC_URL=new\n");
    expect(buildMatchesCheckout(app, readBuildIdentity(app, {}))).toBe(false);
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
      { version: "0.3.9", revision: null, pid: process.pid, bootedAt: 1, startedAt: reusedStamp() },
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

  // The same problem one install shape over: a git-less install names no commit at all, so its
  // source digest is the only thing that tells the two builds in the sentence apart.
  it("names the source of an install no git can describe", () => {
    expect(describeBuildIdentity({ version: "0.4.0", revision: null, source: "9f2c1a4bb001" })).toBe(
      "0.4.0 (sources 9f2c1a4)",
    );
  });
});
