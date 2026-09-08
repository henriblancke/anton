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

import { checkSelfFreshness } from "./self-freshness";

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
function writeLockfile(dir: string, deps: Record<string, string>): void {
  const depLines = Object.keys(deps)
    .map((name) => `        ${JSON.stringify(name)}: ${JSON.stringify(`^${deps[name]}`)},`)
    .join("\n");
  const pkgLines = Object.entries(deps)
    .map(([name, v]) => `    ${JSON.stringify(name)}: [${JSON.stringify(`${name}@${v}`)}, "", {}, "sha512-x"],`)
    .join("\n");
  const body = `{
  "lockfileVersion": 1,
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
});
