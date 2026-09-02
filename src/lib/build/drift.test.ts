/**
 * The seam the server itself uses (anton-pzfb): boot stamps what this process is running, and every
 * later read compares that stamp with the code on disk. What matters here is the round trip and the
 * silence — a server started from the current checkout must produce no verdict at all, and neither
 * must a process that never booted a server (every unit test in this repo is one).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let dir: string;
const realDb = process.env.ANTON_DB;

/** This process's own record — the one file `serverBuildDrift` is judged against. */
const recordPath = () => join(dir, `server-build.${process.pid}.json`);

/** A fresh module instance per case — `bootedFrom` is module state, and boot is what's under test. */
function freshModule() {
  vi.resetModules();
  return import("./drift");
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "anton-drift-"));
  process.env.ANTON_DB = join(dir, "anton.db");
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.useRealTimers();
  vi.doUnmock("./identity.mjs");
  process.env.ANTON_DB = realDb;
  rmSync(dir, { recursive: true, force: true });
});

describe("recordServerBuild / serverBuildDrift", () => {
  it("reports no drift for a server booted from the checkout it is reading", async () => {
    const { recordServerBuild, serverBuildDrift } = await freshModule();
    recordServerBuild();
    expect(serverBuildDrift()).toBeNull();
  });

  it("records beside anton.db, naming this process so a later reader can tell it is still up", async () => {
    const { recordServerBuild } = await freshModule();
    recordServerBuild();
    const record = JSON.parse(readFileSync(recordPath(), "utf8"));
    expect(record.pid).toBe(process.pid);
    expect(record.version).toMatch(/^\d+\.\d+\.\d+/);
    expect(record.bootedAt).toBeGreaterThan(0);
  });

  // A saved edit does not make a dev server stale — `next dev` recompiles it — and a development
  // checkout is dirty by definition, so recording the digest there would pin a permanent "restart
  // the server" banner on the one person who least needs it. A production server has no recovery.
  it("records uncommitted work only for a production server", async () => {
    const record = () => JSON.parse(readFileSync(recordPath(), "utf8"));
    const dev = await freshModule();
    dev.recordServerBuild();
    expect(record().worktree).toBeNull();

    vi.stubEnv("NODE_ENV", "production");
    const prod = await freshModule();
    prod.recordServerBuild();

    expect(record().worktree).toEqual(expect.any(String));
  });

  // The window `anton start` cannot close: it proves `.next` fresh, THEN spawns the server, and a
  // pull landing in between reaches the checkout this hook reads but never the code `next start` is
  // serving. Recording the checkout there would stamp the process with a build it does not run and
  // call the stale server current — so what the artifact says it was compiled from is what counts.
  it("records what the compiled artifact was built from, not a checkout that moved past it", async () => {
    const app = join(dir, "app");
    mkdirSync(join(app, ".next"), { recursive: true });
    writeFileSync(join(app, "package.json"), JSON.stringify({ version: "0.4.0" }));
    writeFileSync(
      join(app, ".next", "anton-build.json"),
      JSON.stringify({ version: "0.3.9", revision: "a".repeat(40), worktree: "clean", builtAt: 1 }),
    );
    vi.stubEnv("ANTON_APP_ROOT", app);
    vi.stubEnv("NODE_ENV", "production");

    const { recordServerBuild, serverBuildDrift } = await freshModule();
    recordServerBuild();

    expect(JSON.parse(readFileSync(recordPath(), "utf8")).version).toBe("0.3.9");
    const drift = serverBuildDrift();
    expect(drift?.state).toBe("outdated");
    expect(drift?.running?.version).toBe("0.3.9");
    expect(drift?.onDisk.version).toBe("0.4.0");
  });

  // An installed bundle ships a prebuilt `.next` with no stamp in it, and its RELEASE_VERSION already
  // identifies it exactly — reading the install itself is the only answer there is.
  it("falls back to the install on disk when the artifact carries no stamp", async () => {
    const app = join(dir, "bundle");
    mkdirSync(join(app, ".next"), { recursive: true });
    writeFileSync(join(app, "package.json"), JSON.stringify({ version: "0.4.0" }));
    vi.stubEnv("ANTON_APP_ROOT", app);
    vi.stubEnv("NODE_ENV", "production");

    const { recordServerBuild, serverBuildDrift } = await freshModule();
    recordServerBuild();

    expect(JSON.parse(readFileSync(recordPath(), "utf8")).version).toBe("0.4.0");
    expect(serverBuildDrift()).toBeNull();
  });

  // The 2026-08-17 shape, forced: the process is up and the record says it booted somewhere else.
  it("reports the drift once the code on disk is no longer what this process booted from", async () => {
    const { recordServerBuild, serverBuildDrift } = await freshModule();
    recordServerBuild();
    const path = recordPath();
    const record = JSON.parse(readFileSync(path, "utf8"));
    writeFileSync(path, JSON.stringify({ ...record, version: "0.0.1" }));

    const drift = serverBuildDrift();
    expect(drift?.state).toBe("outdated");
    expect(drift?.running?.version).toBe("0.0.1");
    expect(drift?.onDisk.version).toBe(record.version);
  });

  // Restart is the whole remediation: a new boot overwrites the record, and the verdict is gone.
  it("clears on the next boot with nothing else done", async () => {
    const { recordServerBuild, serverBuildDrift } = await freshModule();
    recordServerBuild();
    const path = recordPath();
    writeFileSync(path, JSON.stringify({ ...JSON.parse(readFileSync(path, "utf8")), version: "0.0.1" }));
    expect(serverBuildDrift()).not.toBeNull();

    recordServerBuild();

    expect(serverBuildDrift()).toBeNull();
  });

  // `anton update` replaces the runtime dir under the live server, so its cwd stops resolving and
  // `process.cwd()` throws ENOENT from then on. That upgrade is the drift being reported, so a read
  // taken while the directory still existed is what every later comparison has to run on — the
  // alternative is a health page that 500s and a nightly pass that aborts on the one night it
  // had something to say.
  it("keeps reporting after the runtime dir it booted from is deleted", async () => {
    const { recordServerBuild, serverBuildDrift } = await freshModule();
    recordServerBuild();
    const path = recordPath();
    writeFileSync(path, JSON.stringify({ ...JSON.parse(readFileSync(path, "utf8")), version: "0.0.1" }));

    vi.spyOn(process, "cwd").mockImplementation(() => {
      throw Object.assign(new Error("ENOENT: no such file or directory, uv_cwd"), { code: "ENOENT" });
    });
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 60_000); // past the TTL, so the on-disk read is taken again

    const drift = serverBuildDrift();
    expect(drift?.state).toBe("outdated");
    expect(drift?.running?.version).toBe("0.0.1");
  });

  // The other half of that upgrade, and the one a module-level cache cannot cover: Next bundles the
  // instrumentation hook and the request graph into SEPARATE module registries, so the copy of this
  // module that renders the health page may first load long after boot — and if that is after
  // `anton update` deleted the directory the server booted from, its cwd never resolved once. The
  // launcher publishes the pathname in the environment, which is the one thing both registries see.
  it("resolves the runtime dir from the environment when the cwd is already gone at load", async () => {
    vi.stubEnv("ANTON_APP_ROOT", process.cwd());
    vi.spyOn(process, "cwd").mockImplementation(() => {
      throw Object.assign(new Error("ENOENT: no such file or directory, uv_cwd"), { code: "ENOENT" });
    });

    const { recordServerBuild, serverBuildDrift } = await freshModule();
    recordServerBuild();
    const path = recordPath();
    const record = JSON.parse(readFileSync(path, "utf8"));
    expect(record.version).toMatch(/^\d+\.\d+\.\d+/); // it read the checkout, not an empty identity
    writeFileSync(path, JSON.stringify({ ...record, version: "0.0.1" }));

    const drift = serverBuildDrift();
    expect(drift?.state).toBe("outdated");
    expect(drift?.onDisk.version).toBe(record.version);
  });

  // Two servers, one install — a UI-only `ANTON_RUNNER=off` server beside the runner, or two ports
  // across a hand-over. Under one shared record the LAST to boot spoke for both: a server started
  // after a pull matched the code on disk and silently cleared the older process's stale verdict.
  it("is not silenced by a second server that booted from the current checkout", async () => {
    const { recordServerBuild, serverBuildDrift } = await freshModule();
    recordServerBuild();
    const mine = JSON.parse(readFileSync(recordPath(), "utf8"));
    writeFileSync(recordPath(), JSON.stringify({ ...mine, version: "0.0.1" }));
    // The neighbour: booted later, running exactly what is on disk — which under a shared filename
    // is the record every reader would have found.
    writeFileSync(
      join(dir, `server-build.${process.pid + 1}.json`),
      JSON.stringify({ ...mine, pid: process.pid + 1, bootedAt: mine.bootedAt + 1 }),
    );

    const drift = serverBuildDrift();
    expect(drift?.state).toBe("outdated");
    expect(drift?.running?.version).toBe("0.0.1");
  });

  // The mirror image, and the one that would put a false banner on the health page: a NEIGHBOUR is
  // stale, this process is not, and only the process being asked about is the one described.
  it("does not report a neighbouring server's drift as its own", async () => {
    const { recordServerBuild, serverBuildDrift } = await freshModule();
    recordServerBuild();
    const mine = JSON.parse(readFileSync(recordPath(), "utf8"));
    writeFileSync(
      join(dir, `server-build.${process.pid + 1}.json`),
      JSON.stringify({ ...mine, pid: process.pid + 1, version: "0.0.1" }),
    );

    expect(serverBuildDrift()).toBeNull();
  });

  // Nothing deletes a record at exit, so without a sweep every boot leaves one more file beside
  // anton.db — in a source checkout, at the repo root.
  it("clears the records of servers that are no longer running when it boots", async () => {
    writeFileSync(join(dir, "server-build.999999.json"), JSON.stringify({ version: "0.0.1", pid: 999999, bootedAt: 1 }));
    const { recordServerBuild } = await freshModule();

    recordServerBuild();

    expect(existsSync(join(dir, "server-build.999999.json"))).toBe(false);
    expect(existsSync(recordPath())).toBe(true);
  });

  it("says nothing in a process that never booted a server", async () => {
    const { serverBuildDrift } = await freshModule();
    expect(serverBuildDrift()).toBeNull();
  });

  // The one case the file cannot answer: a state dir anton could not write to leaves no record for
  // anyone — including this process — so the identity it kept in memory at boot is the only evidence
  // that the server is running something other than what is on disk.
  it("falls back to the identity it holds in memory when the record could not be written", async () => {
    writeFileSync(join(dir, "blocked"), "");
    process.env.ANTON_DB = join(dir, "blocked", "anton.db");

    let onDisk = { version: "0.4.0", revision: null };
    vi.resetModules();
    const identity = await vi.importActual<typeof import("./identity.mjs")>("./identity.mjs");
    vi.doMock("./identity.mjs", () => ({ ...identity, readBuildIdentity: () => onDisk }));
    const { recordServerBuild, serverBuildDrift } = await import("./drift");

    recordServerBuild();
    expect(existsSync(join(dir, "blocked", `server-build.${process.pid}.json`))).toBe(false);
    expect(serverBuildDrift()).toBeNull();

    onDisk = { version: "0.4.1", revision: null };
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 60_000); // past the TTL on the on-disk read
    const drift = serverBuildDrift();

    expect(drift?.state).toBe("outdated");
    expect(drift?.running?.version).toBe("0.4.0");
    expect(drift?.onDisk.version).toBe("0.4.1");
    expect(drift?.bootedAt).toBeNull();
  });
});
