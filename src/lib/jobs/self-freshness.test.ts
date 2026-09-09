/**
 * Real-git + real-fixture round-trip for {@link checkSelfFreshness} (anton-vzhf): each verdict is
 * exercised against a checkout or a node_modules built to produce it — behind, up to date, no
 * upstream, an unreachable remote, and a lockfile that matches or has drifted. Skipped when `git`
 * isn't installed.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  checkSelfFreshness,
  readBootDependencies,
  resetSelfFreshnessCache,
  type RunningProcess,
} from "./self-freshness";

function has(cmd: string): boolean {
  try {
    execFileSync(cmd, ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

const suite = has("git") ? describe : describe.skip;

/**
 * A bun.lock (lockfileVersion 1) pinning `deps` (name → exact version) as root workspace deps.
 * Hand-emitted WITH trailing commas, exactly as bun writes them, so the fixture exercises the
 * parser's one tolerance rather than a plain-JSON happy path.
 */
function writeLockfile(dir: string, deps: Record<string, string>, lockfileVersion = 1): void {
  const depLines = Object.keys(deps)
    .map((name) => `        ${JSON.stringify(name)}: ${JSON.stringify(`^${deps[name]}`)},`)
    .join("\n");
  const pkgLines = Object.entries(deps)
    .map(([name, v]) => `    ${JSON.stringify(name)}: [${JSON.stringify(`${name}@${v}`)}, "", {}, "sha512-x"],`)
    .join("\n");
  const body = `{
  "lockfileVersion": ${lockfileVersion},
  "workspaces": {
    "": {
      "name": "fixture",
      "dependencies": {
${depLines}
      },
    },
  },
  "packages": {
${pkgLines}
  },
}
`;
  writeFileSync(join(dir, "bun.lock"), body);
}

/** Install `name`@`version` into node_modules exactly as bun would leave its manifest. */
function installPackage(dir: string, name: string, version: string): void {
  const pkgDir = join(dir, "node_modules", name);
  mkdirSync(pkgDir, { recursive: true });
  writeFileSync(join(pkgDir, "package.json"), JSON.stringify({ name, version }));
}

suite("checkSelfFreshness (real git + fixtures)", () => {
  let sandbox: string;
  let bare: string;
  let repo: string;
  let other: string;

  const git = (cwd: string, args: string[]): string =>
    execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();

  const commitAndPush = (cwd: string, file: string): void => {
    writeFileSync(join(cwd, file), `${file}\n`);
    git(cwd, ["add", "-A"]);
    git(cwd, ["commit", "-q", "-m", `add ${file}`]);
    git(cwd, ["push", "-q", "origin", "main"]);
  };

  beforeEach(() => {
    sandbox = mkdtempSync(join(tmpdir(), "anton-freshness-"));
    bare = join(sandbox, "remote.git");
    repo = join(sandbox, "repo");
    other = join(sandbox, "other");
    execFileSync("git", ["init", "--bare", "-q", "-b", "main", bare], { stdio: "ignore" });

    mkdirSync(repo);
    git(repo, ["init", "-q", "-b", "main"]);
    git(repo, ["config", "user.email", "t@example.com"]);
    git(repo, ["config", "user.name", "anton-test"]);
    git(repo, ["remote", "add", "origin", bare]);
    writeFileSync(join(repo, "README.md"), "# sandbox\n");
    git(repo, ["add", "-A"]);
    git(repo, ["commit", "-q", "-m", "init"]);
    // -u sets the upstream, so `main` tracks `origin/main`.
    git(repo, ["push", "-q", "-u", "origin", "main"]);

    execFileSync("git", ["clone", "-q", bare, other], { stdio: "ignore" });
    git(other, ["config", "user.email", "t@example.com"]);
    git(other, ["config", "user.name", "anton-test"]);

    // A matching lockfile/install by default, so the checkout assertions read a clean dependency half.
    writeLockfile(repo, { "left-pad": "1.3.0" });
    installPackage(repo, "left-pad", "1.3.0");
  });

  afterEach(() => {
    rmSync(sandbox, { recursive: true, force: true });
    // The memo lives on globalThis and is keyed by process + path, so it outlives the sandbox it
    // describes — a leaked entry would serve one case's verdict to the next.
    resetSelfFreshnessCache();
  });

  it("reports how far HEAD is behind its upstream", async () => {
    commitAndPush(other, "one.ts");
    commitAndPush(other, "two.ts");

    const { checkout } = await checkSelfFreshness(repo);

    expect(checkout).toEqual({ state: "behind", behind: 2, upstream: "origin/main" });
  });

  it("reports a checkout that holds the upstream tip as current", async () => {
    const { checkout, build } = await checkSelfFreshness(repo);
    expect(checkout).toEqual({ state: "current" });
    // No server booted in this process, so the build half has no recorded identity to call stale —
    // exactly what keeps a test or script silent (anton-vzhf).
    expect(build).toEqual({ state: "current" });
  });

  it("reports a branch with no upstream rather than a distance", async () => {
    git(repo, ["checkout", "-q", "-b", "detached-work"]);

    const { checkout } = await checkSelfFreshness(repo);

    expect(checkout).toEqual({ state: "no-upstream" });
  });

  it("reports an unreachable remote as its own verdict, never as behind", async () => {
    // The upstream still resolves in config, but the remote it names is gone.
    rmSync(bare, { recursive: true, force: true });

    const { checkout } = await checkSelfFreshness(repo);

    expect(checkout.state).toBe("unreachable");
  });

  it("reports installed dependencies matching the lockfile", async () => {
    const { dependencies } = await checkSelfFreshness(repo);
    expect(dependencies).toEqual({ state: "match" });
  });

  it("reports drift when an installed version differs from the lockfile", async () => {
    installPackage(repo, "left-pad", "1.2.0"); // downgrade out from under the lockfile

    const { dependencies } = await checkSelfFreshness(repo);

    expect(dependencies).toEqual({ state: "drift", packages: ["left-pad"] });
  });

  it("reports drift when a locked dependency is not installed at all", async () => {
    rmSync(join(repo, "node_modules", "left-pad"), { recursive: true, force: true });

    const { dependencies } = await checkSelfFreshness(repo);

    expect(dependencies).toEqual({ state: "drift", packages: ["left-pad"] });
  });

  it("reports unknown, not match, when there is no lockfile to read", async () => {
    rmSync(join(repo, "bun.lock"), { force: true });

    const { dependencies } = await checkSelfFreshness(repo);

    expect(dependencies.state).toBe("unknown");
  });

  it("reports unknown, not a drift, when the lockfile format is one it cannot read", async () => {
    // A future bun bumps the format: every field this parser reads is a version-1 assumption, so the
    // honest answer is "could not tell", never a package list derived from a shape that moved.
    writeLockfile(repo, { "left-pad": "1.3.0" }, 2);

    const { dependencies } = await checkSelfFreshness(repo);

    expect(dependencies.state).toBe("unknown");
  });

  /**
   * The P1 this half exists for (PR #257 review): `bun install` is the remedy the drift verdict
   * displays, and running it makes node_modules match the lockfile while moving NO other half —
   * `readBuildIdentity` excludes node_modules, so the build verdict stays current too. Latched
   * against what the process booted with, the stop survives the reinstall until the restart.
   */
  describe("the reinstall a running process has not adopted (PR #257 review)", () => {
    const running = (dependencies: string | null): RunningProcess => ({
      id: "self",
      buildDrift: () => null,
      bootDependencies: () => dependencies,
    });

    it("stays stale after the very `bun install` that clears the lockfile drift", async () => {
      installPackage(repo, "left-pad", "1.2.0"); // the stale install the server booted with
      const booted = await readBootDependencies(repo);
      expect((await checkSelfFreshness(repo, running(booted))).dependencies).toEqual({
        state: "drift",
        packages: ["left-pad"],
      });

      installPackage(repo, "left-pad", "1.3.0"); // the operator runs the displayed remedy

      const { dependencies, build } = await checkSelfFreshness(repo, running(booted));
      // The files are fixed and the build identity never moved — this is the only half that can say
      // the running process is still importing the old packages.
      expect(build).toEqual({ state: "current" });
      expect(dependencies).toEqual({ state: "replaced" });
    });

    it("clears on the restart that adopts them, and nothing else", async () => {
      installPackage(repo, "left-pad", "1.2.0");
      const before = await readBootDependencies(repo);
      installPackage(repo, "left-pad", "1.3.0");
      // The restarted process snapshots what IT imported, so it agrees with itself.
      const after = await readBootDependencies(repo);
      expect(after).not.toBe(before);

      expect((await checkSelfFreshness(repo, running(after))).dependencies).toEqual({ state: "match" });
    });

    it("claims nothing when the process recorded no snapshot", async () => {
      // A unit test, a script, or a server predating the field: an absence is not evidence, so it
      // must not latch a stop that only a restart could clear.
      expect((await checkSelfFreshness(repo, running(null))).dependencies).toEqual({ state: "match" });
    });

    it("reports unknown, not match, when the running process's packages could not be read", async () => {
      const { dependencies } = await checkSelfFreshness(repo, {
        id: "self",
        buildDrift: () => null,
        bootDependencies: () => {
          throw new Error("lsof: command not found");
        },
      });

      expect(dependencies.state).toBe("unknown");
    });

    // A snapshot is only comparable against the same lockfile's direct deps, so a package the
    // lockfile no longer pins must not read as a reinstall on its own.
    it("does not read a lockfile change alone as a reinstall", async () => {
      const booted = await readBootDependencies(repo);
      writeLockfile(repo, { "left-pad": "1.3.0", "right-pad": "2.0.0" });
      installPackage(repo, "right-pad", "2.0.0");

      // The new package IS a genuine reinstall under the running process — what must not happen is
      // the opposite: a verdict that cannot tell the two apart.
      expect((await checkSelfFreshness(repo, running(booted))).dependencies).toEqual({
        state: "replaced",
      });
    });

    it("leaves no snapshot to latch on when the lockfile cannot be read", async () => {
      rmSync(join(repo, "bun.lock"), { force: true });
      expect(await readBootDependencies(repo)).toBeNull();
    });
  });

  /**
   * The build half is asked through a caller-supplied source, and the runner's enumerates the
   * machine's sockets — so it can throw. A throw must be a verdict on THAT half, never an exception
   * out of a module whose whole contract is to answer (PR #257 review).
   */
  describe("a build source that fails", () => {
    it("reads a synchronous throw as unknown rather than escaping the check", async () => {
      const { build, checkout } = await checkSelfFreshness(repo, {
        id: "self",
        buildDrift: () => {
          throw new Error("spawnSync lsof EAGAIN");
        },
        bootDependencies: () => null,
      });

      expect(build).toEqual({ state: "unknown", reason: "spawnSync lsof EAGAIN" });
      // The halves that DID answer still do.
      expect(checkout).toEqual({ state: "current" });
    });

    it("reads a rejection as unknown too", async () => {
      const { build } = await checkSelfFreshness(repo, {
        id: "self",
        buildDrift: () => Promise.reject(new Error("lsof: command not found")),
        bootDependencies: () => null,
      });

      expect(build).toEqual({ state: "unknown", reason: "lsof: command not found" });
    });
  });
  /**
   * The board reads this on every paint and every breaker poll, once per project, and each pass runs
   * a `git fetch` — so a caller may name the age it will accept (PR #257 review). The start gate
   * names none and always pays; only an in-flight pass is shared with it, since joining one is a
   * read of the state right now either way.
   */
  describe("a verdict a caller will reuse", () => {
    /** Counts passes by counting the process-specific half each pass reads exactly once. */
    const counting = (): RunningProcess & { passes: () => number } => {
      let passes = 0;
      return {
        id: "self",
        buildDrift: () => {
          passes += 1;
          return null;
        },
        bootDependencies: () => null,
        passes: () => passes,
      };
    };

    it("fetches once for two reads inside the window", async () => {
      const running = counting();

      const first = await checkSelfFreshness(repo, running, { maxAgeMs: 60_000 });
      const second = await checkSelfFreshness(repo, running, { maxAgeMs: 60_000 });

      expect(second).toEqual(first);
      expect(running.passes()).toBe(1);
    });

    it("fetches again once the window has passed", async () => {
      const running = counting();

      await checkSelfFreshness(repo, running, { maxAgeMs: 1 });
      await new Promise((r) => setTimeout(r, 5));
      await checkSelfFreshness(repo, running, { maxAgeMs: 1 });

      expect(running.passes()).toBe(2);
    });

    // The gate that defers work must never admit or defer a run on a verdict taken before the pull
    // that changed it, so it accepts no age at all.
    it("never reuses a settled verdict for a caller that names no window", async () => {
      const running = counting();

      await checkSelfFreshness(repo, running);
      await checkSelfFreshness(repo, running);

      expect(running.passes()).toBe(2);
    });

    // Two `git fetch` of the same ref racing each other is the thing this shares away; joining costs
    // the strict caller nothing, because it is a read of the current state either way.
    it("joins an in-flight pass even for a caller that names no window", async () => {
      const running = counting();

      const [a, b] = await Promise.all([
        checkSelfFreshness(repo, running),
        checkSelfFreshness(repo, running),
      ]);

      expect(b).toEqual(a);
      expect(running.passes()).toBe(1);
    });

    // The two verdicts answer about DIFFERENT processes, so one must never be served for the other.
    it("keeps the self and runner verdicts apart", async () => {
      const self = counting();
      const runner = { ...counting(), id: "runner" as const };

      await checkSelfFreshness(repo, self, { maxAgeMs: 60_000 });
      await checkSelfFreshness(repo, runner, { maxAgeMs: 60_000 });

      expect(self.passes()).toBe(1);
      expect(runner.passes()).toBe(1);
    });
  });
});
