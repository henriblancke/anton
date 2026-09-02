/**
 * The seam the server itself uses (anton-pzfb): boot stamps what this process is running, and every
 * later read compares that stamp with the code on disk. What matters here is the round trip and the
 * silence — a server started from the current checkout must produce no verdict at all, and neither
 * must a process that never booted a server (every unit test in this repo is one).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * The search for servers no record accounts for enumerates the whole machine and fetches the page of
 * every listener of this checkout — including whatever `anton dev` the developer running these tests
 * has up. Stubbed by default, so a case says what it found rather than what the box happens to hold.
 */
vi.mock("./servers.mjs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./servers.mjs")>()),
  unstampedServers: vi.fn(async (): Promise<number[]> => []),
}));

let dir: string;
const realDb = process.env.ANTON_DB;

/** This process's own record — the one file `serverBuildDrift` is judged against. */
const recordPath = () => join(dir, `server-build.${process.pid}.json`);

/**
 * A fresh module instance per case, in a process that has not booted a server — and boot is what's
 * under test. Resetting the registry is not enough to un-boot one: the boot identity is anchored on
 * `globalThis` precisely so it survives that (it has to cross Next's module registries), so the
 * anchor is cleared too.
 */
function unboot() {
  delete (globalThis as unknown as Record<symbol, unknown>)[Symbol.for("anton.build.bootedFrom")];
}

function freshModule() {
  vi.resetModules();
  unboot();
  return import("./drift");
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "anton-drift-"));
  process.env.ANTON_DB = join(dir, "anton.db");
});

afterEach(() => {
  unboot(); // process-wide by design, so it outlives the module registry a case reset
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
    recordServerBuild({ runner: true });
    expect(serverBuildDrift()).toBeNull();
  });

  it("records beside anton.db, naming this process so a later reader can tell it is still up", async () => {
    const { recordServerBuild } = await freshModule();
    recordServerBuild({ runner: true });
    const record = JSON.parse(readFileSync(recordPath(), "utf8"));
    expect(record.pid).toBe(process.pid);
    expect(record.version).toMatch(/^\d+\.\d+\.\d+/);
    expect(record.bootedAt).toBeGreaterThan(0);
    // Whether THIS process runs the jobs is what makes its drift cost anything, so it is recorded
    // with the identity rather than inferred by a reader that cannot see the process (PR #217).
    expect(record.runner).toBe(true);
  });

  it("records a UI-only server as one the scheduled jobs do not run under", async () => {
    const { recordServerBuild } = await freshModule();
    recordServerBuild({ runner: false });
    expect(JSON.parse(readFileSync(recordPath(), "utf8")).runner).toBe(false);
  });

  // A saved edit does not make a dev server stale — `next dev` recompiles it — and a development
  // checkout is dirty by definition, so recording the digest there would pin a permanent "restart
  // the server" banner on the one person who least needs it. A production server has no recovery.
  it("records uncommitted work only for a production server", async () => {
    const record = () => JSON.parse(readFileSync(recordPath(), "utf8"));
    const dev = await freshModule();
    dev.recordServerBuild({ runner: true });
    expect(record().worktree).toBeNull();

    // A production server is judged on what its ARTIFACT was compiled from, so the digest comes from
    // the stamp inside `.next` rather than from a checkout that may have moved past it.
    const app = join(dir, "prod");
    mkdirSync(join(app, ".next"), { recursive: true });
    writeFileSync(join(app, "package.json"), JSON.stringify({ version: "0.4.0" }));
    writeFileSync(
      join(app, ".next", "anton-build.json"),
      JSON.stringify({ version: "0.4.0", revision: "a".repeat(40), worktree: "9f2c1a4", builtAt: 1 }),
    );
    vi.stubEnv("ANTON_APP_ROOT", app);
    vi.stubEnv("NODE_ENV", "production");
    const prod = await freshModule();
    prod.recordServerBuild({ runner: true });

    expect(record().worktree).toBe("9f2c1a4");
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
    recordServerBuild({ runner: true });

    expect(JSON.parse(readFileSync(recordPath(), "utf8")).version).toBe("0.3.9");
    const drift = serverBuildDrift();
    expect(drift?.state).toBe("outdated");
    expect(drift?.running?.version).toBe("0.3.9");
    expect(drift?.onDisk.version).toBe("0.4.0");
  });

  // An installed bundle ships a prebuilt `.next` with no stamp in it — `anton start` exempts it from
  // the rebuild every source install gets — and its RELEASE_VERSION identifies it exactly, so
  // reading the install itself is the only answer there is.
  it("falls back to the install on disk when a bundle's artifact carries no stamp", async () => {
    const app = join(dir, "bundle");
    mkdirSync(join(app, ".next"), { recursive: true });
    writeFileSync(join(app, "package.json"), JSON.stringify({ version: "0.4.0" }));
    writeFileSync(join(app, "RELEASE_VERSION"), "0.4.0\n");
    vi.stubEnv("ANTON_APP_ROOT", app);
    vi.stubEnv("NODE_ENV", "production");

    const { recordServerBuild, serverBuildDrift } = await freshModule();
    recordServerBuild({ runner: true });

    expect(JSON.parse(readFileSync(recordPath(), "utf8")).version).toBe("0.4.0");
    expect(serverBuildDrift()).toBeNull();
  });

  // The other side of that fallback (PR #217 review): a SOURCE install's `.next` is stamped by
  // `anton start` and by nothing else, so an unstamped one came from `bun run build && bun run
  // start` or from a stamp write that failed — and `next start` is serving it either way. Recording
  // the checkout there would vouch for the running process with code it may never have compiled,
  // and a pull landing between that build and this boot would read as current forever.
  it("records nothing identifiable when a source build left no stamp", async () => {
    const app = join(dir, "checkout");
    mkdirSync(join(app, ".next"), { recursive: true });
    writeFileSync(join(app, "package.json"), JSON.stringify({ version: "0.4.0" }));
    vi.stubEnv("ANTON_APP_ROOT", app);
    vi.stubEnv("NODE_ENV", "production");

    const { recordServerBuild, serverBuildDrift } = await freshModule();
    recordServerBuild({ runner: true });

    expect(JSON.parse(readFileSync(recordPath(), "utf8")).version).toBeNull();
    const drift = serverBuildDrift();
    expect(drift?.state).toBe("unstamped");
    expect(drift?.onDisk.version).toBe("0.4.0");
  });

  // An install with no git — a source tarball, `npm i -g anton` — has no commit to be judged on, so
  // the source digest its stamp carries is the ONLY evidence an edit landed under the running
  // build. `compareBuild` weighs a field only where both sides hold one, so a record that dropped it
  // could never be found stale (PR #217 review).
  it("carries the source digest of a git-less build's stamp into the record", async () => {
    const app = join(dir, "tarball");
    mkdirSync(join(app, ".next"), { recursive: true });
    writeFileSync(join(app, "package.json"), JSON.stringify({ version: "0.4.0" }));
    writeFileSync(join(app, "page.tsx"), "export default () => null;\n");
    const { readBuildIdentity } = await import("./identity.mjs");
    const compiled = readBuildIdentity(app).source;
    expect(compiled).toMatch(/^[0-9a-f]{12}$/);
    writeFileSync(
      join(app, ".next", "anton-build.json"),
      JSON.stringify({ version: "0.4.0", revision: null, source: compiled, builtAt: 1 }),
    );
    vi.stubEnv("ANTON_APP_ROOT", app);
    vi.stubEnv("NODE_ENV", "production");

    const { recordServerBuild, serverBuildDrift, checkoutMoved } = await freshModule();
    recordServerBuild({ runner: true });
    expect(JSON.parse(readFileSync(recordPath(), "utf8")).source).toBe(compiled);

    writeFileSync(join(app, "page.tsx"), "export default () => 1;\n");
    checkoutMoved(app); // the read taken at boot is what the TTL would otherwise still hand back
    expect(serverBuildDrift()?.state).toBe("modified");
  });

  // The 2026-08-17 shape, forced: the process is up and the record says it booted somewhere else.
  it("reports the drift once the code on disk is no longer what this process booted from", async () => {
    const { recordServerBuild, serverBuildDrift } = await freshModule();
    recordServerBuild({ runner: true });
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
    recordServerBuild({ runner: true });
    const path = recordPath();
    writeFileSync(path, JSON.stringify({ ...JSON.parse(readFileSync(path, "utf8")), version: "0.0.1" }));
    expect(serverBuildDrift()).not.toBeNull();

    recordServerBuild({ runner: true });

    expect(serverBuildDrift()).toBeNull();
  });

  // `anton update` replaces the runtime dir under the live server, so its cwd stops resolving and
  // `process.cwd()` throws ENOENT from then on. That upgrade is the drift being reported, so a read
  // taken while the directory still existed is what every later comparison has to run on — the
  // alternative is a health page that 500s and a nightly pass that aborts on the one night it
  // had something to say.
  it("keeps reporting after the runtime dir it booted from is deleted", async () => {
    const { recordServerBuild, serverBuildDrift } = await freshModule();
    recordServerBuild({ runner: true });
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
    recordServerBuild({ runner: true });
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
    recordServerBuild({ runner: true });
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
    recordServerBuild({ runner: true });
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

    recordServerBuild({ runner: true });

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

    recordServerBuild({ runner: true });
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

  // The TTL is a rate limit for readers that cannot know when the code moved. The nightly pass DOES
  // — it fast-forwards this checkout itself — and inside 15s of boot the cached read would have it
  // compare the server against the commit it started on and call itself current (PR #217 review).
  it("re-reads the code on disk when a caller says this checkout just moved", async () => {
    const app = join(dir, "app");
    vi.stubEnv("ANTON_APP_ROOT", app);
    let onDisk = { version: "0.4.0", revision: null };
    vi.resetModules();
    unboot();
    const identity = await vi.importActual<typeof import("./identity.mjs")>("./identity.mjs");
    vi.doMock("./identity.mjs", () => ({ ...identity, readBuildIdentity: () => onDisk }));
    const { checkoutMoved, recordServerBuild, serverBuildDrift } = await import("./drift");

    recordServerBuild({ runner: true });
    onDisk = { version: "0.4.1", revision: null };
    expect(serverBuildDrift()).toBeNull(); // the read taken at boot still stands

    // Another project's checkout advancing says nothing about the build this server runs.
    checkoutMoved(join(dir, "elsewhere"));
    expect(serverBuildDrift()).toBeNull();

    checkoutMoved(`${app}/`);

    expect(serverBuildDrift()?.state).toBe("outdated");
  });

  // `addProject` stores `resolve(repoPath)`, which never dereferences a symlink, so anton's own
  // checkout registered through one spells the same directory differently here. Read as somebody
  // else's project, the nightly's own fast-forward would leave the pre-pull read cached and the
  // scan firing inside the TTL would omit the stale-server warning (PR #217 review).
  it("re-reads when this checkout is named through a symlink to it", async () => {
    const app = join(dir, "app");
    mkdirSync(app);
    const link = join(dir, "link");
    symlinkSync(app, link);
    vi.stubEnv("ANTON_APP_ROOT", app);
    let onDisk = { version: "0.4.0", revision: null };
    vi.resetModules();
    unboot();
    const identity = await vi.importActual<typeof import("./identity.mjs")>("./identity.mjs");
    vi.doMock("./identity.mjs", () => ({ ...identity, readBuildIdentity: () => onDisk }));
    const { checkoutMoved, recordServerBuild, serverBuildDrift } = await import("./drift");

    recordServerBuild({ runner: true });
    onDisk = { version: "0.4.1", revision: null };
    expect(serverBuildDrift()).toBeNull();

    checkoutMoved(link);

    expect(serverBuildDrift()?.state).toBe("outdated");
  });
});

/**
 * The aggregate every operator-facing surface reads (PR #217 review). One install routinely runs two
 * servers — a UI-only `ANTON_RUNNER=off` one serving the pages, a second executing the scheduled jobs
 * — and a verdict about only the process answering the request is silent on the one that matters.
 */
describe("serverBuildDrifts", () => {
  /** A neighbour's record: a pid that is genuinely alive, so `recordAlive` keeps it. */
  function neighbour(pid: number, over: Record<string, unknown> = {}) {
    const mine = JSON.parse(readFileSync(recordPath(), "utf8"));
    writeFileSync(join(dir, `server-build.${pid}.json`), JSON.stringify({ ...mine, pid, startedAt: null, ...over }));
  }

  /** What the search beside the records finds — the servers too old to have written one. */
  async function searchFinds(pids: number[]) {
    const { unstampedServers } = await import("./servers.mjs");
    // The mock outlives a module reset, so a case counting searches must start from zero.
    vi.mocked(unstampedServers).mockClear().mockResolvedValue(pids);
    return vi.mocked(unstampedServers);
  }

  // The silence the reviewer found: the page renders in the UI-only process, which is current, while
  // the runner beside it grinds through nightlies on a build that shipped days ago.
  it("reports a stale runner beside a current process serving the page", async () => {
    const { recordServerBuild, serverBuildDrifts } = await freshModule();
    recordServerBuild({ runner: false });
    neighbour(process.ppid, { version: "0.0.1", runner: true });

    const drifts = await serverBuildDrifts();
    expect(drifts).toHaveLength(1);
    expect(drifts[0]).toMatchObject({ pid: process.ppid, self: false, runner: true });
    expect(drifts[0].drift.state).toBe("outdated");
    expect(drifts[0].drift.running?.version).toBe("0.0.1");
  });

  // The mirror image, and the false alarm: this process is stale but runs nothing scheduled, so the
  // reader must be able to say so rather than blame the nightlies on it.
  it("says a stale UI-only process is not the one the jobs run under", async () => {
    const { recordServerBuild, serverBuildDrifts } = await freshModule();
    recordServerBuild({ runner: false });
    const mine = JSON.parse(readFileSync(recordPath(), "utf8"));
    writeFileSync(recordPath(), JSON.stringify({ ...mine, version: "0.0.1" }));

    const drifts = await serverBuildDrifts();
    expect(drifts).toHaveLength(1);
    expect(drifts[0]).toMatchObject({ pid: process.pid, self: true, runner: false });
  });

  // A record predates the flag: neither claim is safe, so the reader is told nothing rather than
  // guessed at — the same rule the identity comparison follows field by field.
  it("leaves the runner unknown for a record written before the flag existed", async () => {
    const { recordServerBuild, serverBuildDrifts } = await freshModule();
    recordServerBuild({ runner: true });
    const mine = JSON.parse(readFileSync(recordPath(), "utf8"));
    delete mine.runner;
    writeFileSync(recordPath(), JSON.stringify({ ...mine, version: "0.0.1" }));

    expect((await serverBuildDrifts())[0]?.runner).toBeUndefined();
  });

  it("says nothing when every running server is the build on disk", async () => {
    const { recordServerBuild, serverBuildDrifts } = await freshModule();
    recordServerBuild({ runner: true });
    neighbour(process.ppid);

    expect(await serverBuildDrifts()).toEqual([]);
  });

  // Nothing deletes a record at exit, so a stopped server's leftover would banner the health page
  // forever — and no restart would clear it, because the process it names is already gone.
  it("ignores the leftover record of a server that has exited", async () => {
    const { recordServerBuild, serverBuildDrifts } = await freshModule();
    recordServerBuild({ runner: true });
    neighbour(999_999, { version: "0.0.1", pid: 999_999 });

    expect(await serverBuildDrifts()).toEqual([]);
  });

  // `ANTON_DB` deliberately points two checkouts at one database, and a neighbour's build says
  // nothing about the code in front of the operator reading this page.
  it("does not report a server of another install sharing this database", async () => {
    const { recordServerBuild, serverBuildDrifts } = await freshModule();
    recordServerBuild({ runner: true });
    neighbour(process.ppid, { version: "0.0.1", appRoot: join(dir, "elsewhere") });

    expect(await serverBuildDrifts()).toEqual([]);
  });

  // The state dir anton could not write to: no record exists for anyone, so the identity this
  // process kept in memory at boot is the only evidence there is — for itself alone.
  it("falls back to the identity it holds in memory when the record could not be written", async () => {
    writeFileSync(join(dir, "blocked"), "");
    process.env.ANTON_DB = join(dir, "blocked", "anton.db");

    let onDisk = { version: "0.4.0", revision: null };
    vi.resetModules();
    const identity = await vi.importActual<typeof import("./identity.mjs")>("./identity.mjs");
    vi.doMock("./identity.mjs", () => ({ ...identity, readBuildIdentity: () => onDisk }));
    const { recordServerBuild, serverBuildDrifts } = await import("./drift");

    recordServerBuild({ runner: true });
    expect(await serverBuildDrifts()).toEqual([]);

    onDisk = { version: "0.4.1", revision: null };
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 60_000); // past the TTL on both the on-disk read and this one

    const drifts = await serverBuildDrifts();
    expect(drifts).toHaveLength(1);
    expect(drifts[0]).toMatchObject({ pid: process.pid, self: true, runner: true });
    expect(drifts[0].drift.state).toBe("outdated");
  });

  // The registry split, on the one path the in-memory fallback exists for (PR #217 review): Next
  // compiles the instrumentation hook and the request graph separately, so the copy of this module
  // rendering the page is not the copy that booted. Held per module instance, the boot identity is
  // null in the copy that renders — which, with the record write failed and this process never a
  // search candidate, leaves the page calling a server it cannot name clean.
  it("reports the boot identity from the copy of this module that renders the page", async () => {
    writeFileSync(join(dir, "blocked"), "");
    process.env.ANTON_DB = join(dir, "blocked", "anton.db");

    let onDisk = { version: "0.4.0", revision: null };
    vi.resetModules();
    unboot();
    const identity = await vi.importActual<typeof import("./identity.mjs")>("./identity.mjs");
    vi.doMock("./identity.mjs", () => ({ ...identity, readBuildIdentity: () => onDisk }));
    const instrumentation = await import("./drift");
    instrumentation.recordServerBuild({ runner: true });
    expect(existsSync(join(dir, "blocked", `server-build.${process.pid}.json`))).toBe(false);

    onDisk = { version: "0.4.1", revision: null };
    vi.resetModules(); // the request graph — a second instance of this module, in the same process
    const requestGraph = await import("./drift");

    const drifts = await requestGraph.serverBuildDrifts();
    expect(drifts).toHaveLength(1);
    expect(drifts[0]).toMatchObject({ pid: process.pid, self: true, runner: true });
    expect(drifts[0].drift.state).toBe("outdated");
    expect(drifts[0].drift.running?.version).toBe("0.4.0");
  });

  // The other half of that split (PR #217 review): only the instrumentation graph ever calls
  // `checkoutMoved` — the nightly runner lives there — while the health page answers from the
  // request graph's own module-local caches. Cleared per instance, the page keeps handing back its
  // pre-pull verdict for the rest of the TTL, hiding the stale server the pull just created.
  it("invalidates the caches of the OTHER module registry when the checkout moves", async () => {
    const app = join(dir, "app");
    vi.stubEnv("ANTON_APP_ROOT", app);
    let onDisk = { version: "0.4.0", revision: null };
    vi.resetModules();
    unboot();
    const identity = await vi.importActual<typeof import("./identity.mjs")>("./identity.mjs");
    vi.doMock("./identity.mjs", () => ({ ...identity, readBuildIdentity: () => onDisk }));
    const instrumentation = await import("./drift");
    instrumentation.recordServerBuild({ runner: true });

    vi.resetModules(); // the request graph, with caches of its own
    const requestGraph = await import("./drift");
    expect(await requestGraph.serverBuildDrifts()).toEqual([]); // cached by the page, pre-pull

    onDisk = { version: "0.4.1", revision: null };
    instrumentation.checkoutMoved(app); // the nightly's own fast-forward, in the runner's graph

    const drifts = await requestGraph.serverBuildDrifts();
    expect(drifts).toHaveLength(1);
    expect(drifts[0].drift.state).toBe("outdated");
  });

  // The upgrade this whole module exists for: a server predating build stamps still up beside the
  // current one, with no record to its name. Reading records alone, this page calls the install
  // clean while that process goes on running the nightlies from code that shipped days ago.
  it("reports a server of this checkout that no record accounts for", async () => {
    const { recordServerBuild, serverBuildDrifts } = await freshModule();
    recordServerBuild({ runner: false });
    await searchFinds([424_242]);

    const drifts = await serverBuildDrifts();
    expect(drifts).toHaveLength(1);
    expect(drifts[0]).toMatchObject({ pid: 424_242, self: false, runner: undefined });
    expect(drifts[0].drift.state).toBe("unstamped");
    expect(drifts[0].drift.running).toBeNull();
  });

  // The search proves a listener is anton's by fetching its page, so handing it this process would
  // have the server fetch its own page from inside a render of that page.
  it("searches only past the processes already accounted for, this one included", async () => {
    const { recordServerBuild, serverBuildDrifts } = await freshModule();
    recordServerBuild({ runner: true });
    neighbour(process.ppid);
    const search = await searchFinds([]);

    await serverBuildDrifts();
    expect(search.mock.calls[0]?.[0]?.livePids).toEqual(new Set([process.pid, process.ppid]));
  });

  // The cache only spares the SECOND render. Concurrent ones miss together, and the search each one
  // would fire enumerates the machine's sockets and fetches a page per candidate port.
  it("collapses concurrent misses into one search", async () => {
    const { recordServerBuild, serverBuildDrifts } = await freshModule();
    recordServerBuild({ runner: true });
    const search = await searchFinds([]);

    const [first, second] = await Promise.all([serverBuildDrifts(), serverBuildDrifts()]);

    expect(search).toHaveBeenCalledOnce();
    expect(first).toBe(second);
  });

  // `checkoutMoved` clears the cache, but a read already in flight resolves AFTER it and would write
  // the pre-move verdict straight back — the health page then calls a now-stale server current for
  // the rest of the TTL, on the exact pass whose answer changed (PR #217 review).
  it("does not let a read started before the checkout moved repopulate the cache", async () => {
    const app = join(dir, "app");
    vi.stubEnv("ANTON_APP_ROOT", app);
    let onDisk = { version: "0.4.0", revision: null };
    vi.resetModules();
    unboot();
    const identity = await vi.importActual<typeof import("./identity.mjs")>("./identity.mjs");
    vi.doMock("./identity.mjs", () => ({ ...identity, readBuildIdentity: () => onDisk }));
    const { checkoutMoved, recordServerBuild, serverBuildDrifts } = await import("./drift");
    recordServerBuild({ runner: true });

    let release: (pids: number[]) => void = () => {};
    const search = await searchFinds([]);
    search.mockReturnValueOnce(new Promise<number[]>((resolve) => (release = resolve)));
    const inflight = serverBuildDrifts();

    onDisk = { version: "0.4.1", revision: null };
    checkoutMoved(app);
    release([]);
    expect(await inflight).toEqual([]); // answered as it was taken, from the read before the pull

    const drifts = await serverBuildDrifts();
    expect(drifts).toHaveLength(1);
    expect(drifts[0].drift.state).toBe("outdated");
  });

  // A failed read must not be replayed to every later caller for the rest of the TTL — the next one
  // retries it.
  it("retries after a search that threw rather than caching the failure", async () => {
    const { recordServerBuild, serverBuildDrifts } = await freshModule();
    recordServerBuild({ runner: true });
    const search = await searchFinds([]);
    search.mockRejectedValueOnce(new Error("lsof: command not found"));

    await expect(serverBuildDrifts()).rejects.toThrow("lsof");

    expect(await serverBuildDrifts()).toEqual([]);
    expect(search).toHaveBeenCalledTimes(2);
  });

  it("says nothing in a process that never booted a server", async () => {
    const { serverBuildDrifts } = await freshModule();
    expect(await serverBuildDrifts()).toEqual([]);
  });
});
