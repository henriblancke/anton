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
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  BUILD_RECORD_FILE,
  buildDrift,
  buildRecordPath,
  compareBuild,
  describeBuildDrift,
  describeBuildIdentity,
  readBuildIdentity,
  readBuildRecord,
  writeBuildRecord,
} from "./identity.mjs";

const RUNNING = { version: "0.4.0", revision: "a".repeat(40) };

const dirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "anton-build-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

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
    expect(readBuildIdentity(dir)).toEqual({ version: "0.4.0", revision: null });
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

  it("survives an unwritable state dir and an unreadable record without throwing", () => {
    const dir = tempDir();
    expect(writeBuildRecord(join(dir, "anton.db", "nested", "rec.json"), RUNNING)).toBe(true);
    writeFileSync(join(dir, "junk.json"), "{not json");
    expect(readBuildRecord(join(dir, "junk.json"))).toBeNull();
    expect(readBuildRecord(join(dir, "absent.json"))).toBeNull();
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
});
