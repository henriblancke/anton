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
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  BUILD_RECORD_FILE,
  buildDrift,
  buildMatchesCheckout,
  buildRecordPath,
  buildStampPath,
  compareBuild,
  describeBuildDrift,
  describeBuildIdentity,
  readBuildIdentity,
  readBuildRecord,
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
    expect(readBuildIdentity(dir)).toEqual({ version: "0.4.0", revision: null, worktree: null });
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
    expect(readBuildIdentity(bundle)).toEqual({ version: "0.9.1", revision: null, worktree: null });
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

  it("reads this repo's own version and HEAD", () => {
    const identity = readBuildIdentity(process.cwd());
    expect(identity.version).toMatch(/^\d+\.\d+\.\d+/);
    expect(identity.revision).toMatch(/^[0-9a-f]{40}$/);
  });
});

describe("the record a running server leaves", () => {
  it("round-trips through the path anton.db decides", () => {
    const dir = tempDir();
    const path = buildRecordPath(join(dir, "anton.db"));
    expect(path).toBe(join(dir, "server-build.json"));
    expect(writeBuildRecord(path, RUNNING, { pid: 4242, bootedAt: 1_700_000_000_000 })).toBe(true);
    expect(readBuildRecord(path)).toEqual({ ...RUNNING, pid: 4242, bootedAt: 1_700_000_000_000 });
  });

  // A source checkout resolves the record to the repo root, so an unignored name would leave a pid
  // and a boot timestamp staged by the next routine `git add -A`.
  it("carries a name this repo ignores, so a boot never dirties the checkout", () => {
    const ignored = spawnSync("git", ["check-ignore", "-q", BUILD_RECORD_FILE], { cwd: process.cwd() });
    expect(ignored.status).toBe(0);
  });

  // Same hazard, same fix: the launcher's port note also lands at the repo root on a source
  // checkout, where an unignored name would enter the worktree digest and invalidate every build.
  it("keeps the launcher's port note out of the checkout too", () => {
    const ignored = spawnSync("git", ["check-ignore", "-q", "server-port"], { cwd: process.cwd() });
    expect(ignored.status).toBe(0);
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

  // Both sides of an uncommitted drift sit at one commit, so without this the sentence would claim
  // that `0.4.0 (aaaaaaa)` differs from `0.4.0 (aaaaaaa)` and read as a bug.
  it("names uncommitted work, so the two builds it compares print differently", () => {
    expect(describeBuildIdentity({ ...RUNNING, worktree: "9f2c1a4bb001" })).toBe(
      "0.4.0 (aaaaaaa, uncommitted 9f2c1a4)",
    );
    expect(describeBuildIdentity({ ...RUNNING, worktree: "clean" })).toBe("0.4.0 (aaaaaaa)");
  });
});
