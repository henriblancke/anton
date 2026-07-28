/**
 * config.mjs is a SYNCHRONOUS bootstrap path: every probe it runs blocks the calling thread outright,
 * so an unbounded one freezes anton with no timer that could ever fire (anton-jfjw.4). These tests
 * pin both halves of the fix — every spawn carries a budget, and a probe that blows its budget is
 * treated as a failed/negative result rather than a silent success.
 *
 * The probes run against real hanging `git`/`bd` stubs on PATH (not a mocked child_process) with the
 * budgets capped to a few hundred ms via ANTON_BEADS_SPAWN_TIMEOUT_MS, so a regression that drops a
 * timeout hangs the test instead of quietly passing.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  SPAWN_BUDGETS_MS,
  beadsPrereqs,
  configureBeadsDoltSync,
  configureBeadsForRepo,
  ensureBdConfig,
  hasOriginRemote,
  isGitWorkTree,
  untrackBeadsExports,
} from "./config.mjs";

const CONFIG_SRC = join(process.cwd(), "src/lib/beads/config.mjs");

/** Budget cap for the hang tests: long enough to clear node startup, short enough to stay a unit test. */
const CAP_MS = "400";
/** A killed probe must return in ~CAP_MS; anything near this bound is a lost timeout, not slowness. */
const NO_HANG_MS = 15_000;

let binDir: string;
let repo: string;
const cleanups: string[] = [];
let prevPath: string | undefined;
let prevCap: string | undefined;

/** Put an executable node script named `name` first on PATH. */
function stub(name: string, body: string[]): void {
  const path = join(binDir, name);
  writeFileSync(path, ["#!/usr/bin/env node", ...body, ""].join("\n"), "utf8");
  chmodSync(path, 0o755);
}

/** A stub that never exits — the wedged-probe the budget has to cut off. */
const HANGS = ["setTimeout(() => {}, 60000);"];

/** A stub that answers `--version` instantly and hangs on everything else. */
const ANSWERS_VERSION_THEN_HANGS = [
  'if (process.argv[2] === "--version") { console.log("0.0.0-stub"); process.exit(0); }',
  ...HANGS,
];

function elapsed<T>(fn: () => T): { result: T; ms: number } {
  const t0 = Date.now();
  const result = fn();
  return { result, ms: Date.now() - t0 };
}

beforeEach(() => {
  binDir = mkdtempSync(join(tmpdir(), "anton-bin-"));
  repo = mkdtempSync(join(tmpdir(), "anton-repo-"));
  cleanups.push(binDir, repo);
  prevPath = process.env.PATH;
  prevCap = process.env.ANTON_BEADS_SPAWN_TIMEOUT_MS;
  process.env.PATH = `${binDir}:${process.env.PATH ?? ""}`;
  process.env.ANTON_BEADS_SPAWN_TIMEOUT_MS = CAP_MS;
});

afterEach(() => {
  if (prevPath === undefined) delete process.env.PATH;
  else process.env.PATH = prevPath;
  if (prevCap === undefined) delete process.env.ANTON_BEADS_SPAWN_TIMEOUT_MS;
  else process.env.ANTON_BEADS_SPAWN_TIMEOUT_MS = prevCap;
  while (cleanups.length) rmSync(cleanups.pop()!, { recursive: true, force: true });
});

describe("spawn budgets", () => {
  // A source-level gate, not a behavioral one: a new unbounded spawnSync would only show up in the
  // field as a frozen bootstrap, which no unit test of the new call site would catch.
  it("every spawnSync call site passes a timeout and an explicit killSignal", () => {
    const src = readFileSync(CONFIG_SRC, "utf8");
    const sites: string[] = [];
    for (let i = src.indexOf("spawnSync("); i !== -1; i = src.indexOf("spawnSync(", i + 1)) {
      let depth = 0;
      let end = i;
      for (let j = src.indexOf("(", i); j < src.length; j++) {
        if (src[j] === "(") depth++;
        else if (src[j] === ")" && --depth === 0) {
          end = j;
          break;
        }
      }
      sites.push(src.slice(i, end + 1));
    }

    expect(sites.length).toBeGreaterThanOrEqual(11); // every probe in the file
    for (const site of sites) {
      expect(site, `unbounded spawnSync: ${site}`).toMatch(/\btimeout:/);
      expect(site, `spawnSync without an explicit killSignal: ${site}`).toMatch(/\bkillSignal:/);
    }
  });

  it("budgets are proportionate — local probe < bd command < network", () => {
    expect(SPAWN_BUDGETS_MS.probe).toBeLessThan(SPAWN_BUDGETS_MS.bd);
    expect(SPAWN_BUDGETS_MS.bd).toBeLessThan(SPAWN_BUDGETS_MS.network);
  });

  it("gives bd init and bd bootstrap the network budget, not the probe budget", () => {
    const src = readFileSync(CONFIG_SRC, "utf8");
    for (const marker of ["const initMs = budgetMs(", "const bootstrapMs = budgetMs("]) {
      expect(src.slice(src.indexOf(marker))).toMatch(new RegExp(`^${escape(marker)}"network"\\)`));
    }
  });
});

function escape(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

describe("a probe that blows its budget", () => {
  it("makes isGitWorkTree / hasOriginRemote answer false instead of blocking the thread", () => {
    stub("git", HANGS);

    const tree = elapsed(() => isGitWorkTree(repo));
    const origin = elapsed(() => hasOriginRemote(repo));

    expect(tree.result).toBe(false);
    expect(origin.result).toBe(false);
    expect(tree.ms).toBeLessThan(NO_HANG_MS);
    expect(origin.ms).toBeLessThan(NO_HANG_MS);
  });

  it("fails the prereq check (and configureBeadsForRepo skips) rather than hanging bootstrap", () => {
    stub("bd", ANSWERS_VERSION_THEN_HANGS);
    stub("git", HANGS);

    const pre = elapsed(() => beadsPrereqs(repo));
    expect(pre.result.ok).toBe(false);
    expect(pre.result.error?.message).toMatch(/not a git repository/);
    expect(pre.ms).toBeLessThan(NO_HANG_MS);

    const run = elapsed(() => configureBeadsForRepo(repo));
    expect(run.result).toMatchObject({ configured: false, skipped: true });
    expect(run.ms).toBeLessThan(NO_HANG_MS);
  });

  it("reports `git ls-files` as a failure — a killed probe never reads as 'nothing tracked'", () => {
    stub("git", HANGS);

    const { result, ms } = elapsed(() => untrackBeadsExports(repo));

    expect(result.untracked).toEqual([]);
    expect(result.error).toMatch(/timed out after \d+ms \(killed with SIG/);
    expect(ms).toBeLessThan(NO_HANG_MS);
  });

  it("reports a killed `git rm --cached` with a non-empty detail (the caller keys off truthiness)", () => {
    stub("git", [
      'if (process.argv[2] === "ls-files") { console.log(".beads/issues.jsonl"); process.exit(0); }',
      ...HANGS,
    ]);

    const { result, ms } = elapsed(() => untrackBeadsExports(repo));

    expect(result.untracked).toEqual([]);
    expect(result.error).toMatch(/timed out after \d+ms/);
    expect(ms).toBeLessThan(NO_HANG_MS);
  });

  it("marks a killed `bd config set` failed, never 'set'", () => {
    stub("bd", HANGS);

    const { result, ms } = elapsed(() => ensureBdConfig(repo, join(repo, ".beads"), "export.auto", "false"));

    expect(result).toBe("failed");
    expect(ms).toBeLessThan(NO_HANG_MS);
  });

  it("leaves the Dolt sync unwired rather than blocking on a wedged bd/git", () => {
    mkdirSync(join(repo, ".beads"), { recursive: true });
    stub("bd", HANGS);
    stub("git", HANGS);

    const { result, ms } = elapsed(() => configureBeadsDoltSync({ repoDir: repo }));

    // No remote could be resolved (both probes were killed) — a negative result, not a wiring claim.
    expect(result.status).toBe("no-remote");
    expect(ms).toBeLessThan(NO_HANG_MS);
  });
});

describe("the injectable exec seam", () => {
  it("still drives configureBeadsDoltSync — the per-call budget is an ignorable extra argument", () => {
    mkdirSync(join(repo, ".beads"), { recursive: true });
    const calls: string[][] = [];
    // Deliberately arity-2, as every existing stub is: the budget the default exec applies must not
    // leak into the seam's contract.
    const exec = (cmd: string, args: string[]) => {
      calls.push([cmd, ...args]);
      if (cmd === "bd" && args[0] === "config") {
        return { status: 0, stdout: "sync.remote (not set in config.yaml)" };
      }
      if (cmd === "git") return { status: 0, stdout: "git@example.com:org/repo.git" };
      return { status: 0, stdout: "origin\tgit+ssh://git@example.com/./org/repo.git" };
    };

    const result = configureBeadsDoltSync({ repoDir: repo, exec });

    expect(result).toMatchObject({ status: "already" });
    expect(calls).toContainEqual(["bd", "dolt", "remote", "list"]);
  });
});
