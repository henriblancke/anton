/**
 * Tests for the stringer wrapper (anton-3t2.3): arg construction (esp. the vendored-dir excludes
 * that keep a scan off a huge node_modules and away from the 10-minute timeout) and signal counting,
 * against a fake stringer binary that records its argv and writes a canned scan file.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_SCAN_EXCLUDES, STRINGER_BIN_ENV, discoverRepoExcludes, scan } from "./stringer";

let dir: string;
let prevBin: string | undefined;

/** Fake stringer: records argv (minus node/script) to argvDump, writes canned signals to the -o path. */
function writeFakeStringer(argvDump: string, signals: unknown[]): string {
  const path = join(dir, "fake-stringer");
  const body = [
    "#!/usr/bin/env node",
    "const fs = require('fs');",
    `fs.writeFileSync(${JSON.stringify(argvDump)}, JSON.stringify(process.argv.slice(2)));`,
    "const i = process.argv.indexOf('-o');",
    `if (i !== -1) fs.writeFileSync(process.argv[i + 1], JSON.stringify(${JSON.stringify(signals)}));`,
    "process.exit(0);",
    "",
  ].join("\n");
  writeFileSync(path, body, "utf8");
  chmodSync(path, 0o755);
  return path;
}

/**
 * A real git repo with the shape that broke the nightly scan: an ignored dir holding worktree copies
 * (`.wt/`) and a NESTED build dir (`packages/web/.next/`) that a root-relative `.next/**` can't match.
 */
function makeRepo(): string {
  const repo = join(dir, "repo");
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", repo, ...args], { stdio: "pipe", encoding: "utf8" });

  mkdirSync(join(repo, "packages", "web", ".next"), { recursive: true });
  mkdirSync(join(repo, ".wt", "copy"), { recursive: true });
  mkdirSync(join(repo, "src"), { recursive: true });
  writeFileSync(join(repo, ".gitignore"), ".wt/\n.next/\n", "utf8");
  writeFileSync(join(repo, "src", "a.ts"), "export const a = 1;\n", "utf8");
  // Tracked source beside the build dir, so git reports the nested `.next/` itself rather than
  // collapsing all of `packages/` (which it does when a dir holds nothing but ignored content).
  writeFileSync(join(repo, "packages", "web", "index.ts"), "export const w = 1;\n", "utf8");
  writeFileSync(join(repo, "packages", "web", ".next", "chunk.js"), "// built\n", "utf8");
  writeFileSync(join(repo, ".wt", "copy", "b.ts"), "// copy\n", "utf8");

  execFileSync("git", ["init", "-q", repo], { stdio: "pipe" });
  git("add", "-A");
  git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init");
  return repo;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "anton-stringer-"));
  prevBin = process.env[STRINGER_BIN_ENV];
});

afterEach(() => {
  if (prevBin === undefined) delete process.env[STRINGER_BIN_ENV];
  else process.env[STRINGER_BIN_ENV] = prevBin;
  rmSync(dir, { recursive: true, force: true });
});

describe("scan", () => {
  function argvOf(dump: string): string[] {
    return JSON.parse(readFileSync(dump, "utf8")) as string[];
  }

  it("excludes build/cache dirs (root-relative) and caps each collector so a scan can't hang", async () => {
    const argvDump = join(dir, "argv.json");
    process.env[STRINGER_BIN_ENV] = writeFakeStringer(argvDump, [{ id: 1 }, { id: 2 }]);

    const result = await scan({ repoPath: "/repo", scanFile: join(dir, "scan.json") });

    const argv = argvOf(argvDump);
    expect(argv).toContain("--exclude");
    const globs = argv[argv.indexOf("--exclude") + 1].split(",");
    // Root-relative (stringer's glob dialect) — the .next build dir was the measured culprit.
    expect(globs).toContain(".next/**");
    expect(globs).toContain("node_modules/**");
    expect(globs.some((g) => g.startsWith("**/"))).toBe(false); // no doublestar prefix (unsupported)
    expect(DEFAULT_SCAN_EXCLUDES.every((g) => globs.includes(g))).toBe(true);
    // Collector-timeout backstop present.
    expect(argv).toContain("--collector-timeout");
    expect(argv[argv.indexOf("--collector-timeout") + 1]).toMatch(/^\d+[a-z]+$/);
    expect(argv).toContain("--delta"); // delta on by default
    expect(result.signalCount).toBe(2);
  });

  it("appends caller-supplied excludes after the defaults", async () => {
    const argvDump = join(dir, "argv.json");
    process.env[STRINGER_BIN_ENV] = writeFakeStringer(argvDump, []);

    await scan({ repoPath: "/repo", scanFile: join(dir, "s.json"), exclude: ["fixtures/**"] });

    const globs = argvOf(argvDump)[argvOf(argvDump).indexOf("--exclude") + 1].split(",");
    expect(globs).toContain("fixtures/**");
    expect(globs).toContain(".next/**");
  });

  it("omits --delta when delta is false", async () => {
    const argvDump = join(dir, "argv.json");
    process.env[STRINGER_BIN_ENV] = writeFakeStringer(argvDump, []);

    await scan({ repoPath: "/repo", scanFile: join(dir, "s.json"), delta: false });

    expect(argvOf(argvDump)).not.toContain("--delta");
  });

  it("adds the excludes git reports for the repo, deduped against the defaults", async () => {
    const repo = makeRepo();
    const argvDump = join(dir, "argv.json");
    process.env[STRINGER_BIN_ENV] = writeFakeStringer(argvDump, []);

    await scan({ repoPath: repo, scanFile: join(dir, "s.json") });

    const globs = argvOf(argvDump)[argvOf(argvDump).indexOf("--exclude") + 1].split(",");
    expect(globs).toContain(".wt/**"); // gitignored dir the static list can't know about
    expect(globs).toContain("packages/web/.next/**"); // nested build dir — the whole point
    expect(new Set(globs).size).toBe(globs.length); // deduped against DEFAULT_SCAN_EXCLUDES
  });

  it("reports zero signals when the scan file is missing or unparseable", async () => {
    // Fake writes no -o file (drop the flag by not passing it) → scan() tolerates it as 0 signals.
    const bin = join(dir, "noop-stringer");
    writeFileSync(bin, "#!/usr/bin/env node\nprocess.exit(0);\n", "utf8");
    chmodSync(bin, 0o755);
    process.env[STRINGER_BIN_ENV] = bin;

    const result = await scan({ repoPath: "/repo", scanFile: join(dir, "missing.json") });
    expect(result.signalCount).toBe(0);
  });
});

describe("discoverRepoExcludes", () => {
  it("returns ignored dirs at any depth, as root-relative globs", async () => {
    const globs = await discoverRepoExcludes(makeRepo());

    expect(globs).toContain(".wt/**");
    expect(globs).toContain("packages/web/.next/**"); // nested — unreachable by the static list
    // Never the doublestar prefix: stringer silently matches nothing on `**/x/**`.
    expect(globs.some((g) => g.startsWith("**/"))).toBe(false);
    // Directories only — listing every ignored file would bloat the argv for no gain.
    expect(globs.every((g) => g.endsWith("/**"))).toBe(true);
  });

  it("excludes worktrees checked out inside the repo, but not anton's own external ones", async () => {
    const repo = makeRepo();
    const inside = join(repo, "nested-wt");
    const outside = join(dir, "external-wt");
    for (const [path, branch] of [
      [inside, "in"],
      [outside, "out"],
    ]) {
      execFileSync("git", ["-C", repo, "worktree", "add", "-q", "-b", branch, path], {
        stdio: "pipe",
      });
    }

    const globs = await discoverRepoExcludes(repo);

    expect(globs).toContain("nested-wt/**");
    // A worktree outside the tree is never walked, so excluding it would be noise (and its absolute
    // path isn't even expressible as a root-relative glob).
    expect(globs.some((g) => g.includes("external-wt"))).toBe(false);
  });

  it("returns nothing rather than throwing when the path isn't a git repo", async () => {
    expect(await discoverRepoExcludes(join(dir, "not-a-repo"))).toEqual([]);
  });
});
