/**
 * Smoke tests for the anton CLI (anton-hji). Only exercises argument dispatch — the paths that
 * don't depend on external tools or a build — so it's deterministic in CI (where bd/gh/stringer
 * aren't installed). setup/start/doctor behavior is covered by the manual run + the prereq logic.
 */
import { afterEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import { mkdirSync, writeFileSync } from "node:fs";
import {
  agentsFromArgs,
  applyMigrations,
  compareVersions,
  ensureBeadsGitignore,
  ensureBetterSqlite3,
  nextArgs,
  parseInitArgs,
  platformLabel,
  provisionAgentsSkills,
  registerProject,
  REQUIRED_SKILLS,
  resolvePort,
} from "./anton.mjs";

import {
  configureBeadsDoltSync,
  detectHooksManager,
} from "../src/lib/beads/config.mjs";

const CLI = join(dirname(fileURLToPath(import.meta.url)), "anton.mjs");
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

function run(args: string[]) {
  return spawnSync("node", [CLI, ...args], { encoding: "utf8" });
}

describe("anton CLI dispatch", () => {
  it("--help prints usage and exits 0", () => {
    const r = run(["--help"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("anton <command>");
    expect(r.stdout).toContain("setup");
    expect(r.stdout).toContain("init");
    expect(r.stdout).toContain("start");
  });

  it("no command prints usage and exits non-zero", () => {
    const r = run([]);
    expect(r.status).toBe(1);
    expect(r.stdout).toContain("Usage:");
  });

  it("unknown command exits non-zero with an error", () => {
    const r = run(["bogus"]);
    expect(r.status).toBe(1);
    expect(r.stdout).toContain("unknown command: bogus");
  });

  it("--help documents the port override", () => {
    const r = run(["--help"]);
    expect(r.stdout).toContain("--port");
  });
});

describe("port resolution", () => {
  const savedPort = process.env.PORT;
  afterEach(() => {
    if (savedPort === undefined) delete process.env.PORT;
    else process.env.PORT = savedPort;
  });

  it("returns undefined with no flag or PORT env", () => {
    delete process.env.PORT;
    expect(resolvePort([])).toBeUndefined();
    expect(nextArgs("start", [])).toEqual(["start"]);
  });

  it("parses --port <n>, --port=<n>, and -p <n>", () => {
    delete process.env.PORT;
    expect(resolvePort(["--port", "4000"])).toBe("4000");
    expect(resolvePort(["--port=4001"])).toBe("4001");
    expect(resolvePort(["-p", "4002"])).toBe("4002");
    expect(nextArgs("dev", ["-p", "4002"])).toEqual(["dev", "-p", "4002"]);
  });

  it("falls back to PORT env, but an explicit flag wins", () => {
    process.env.PORT = "5000";
    expect(resolvePort([])).toBe("5000");
    expect(resolvePort(["--port", "6000"])).toBe("6000");
    expect(nextArgs("start", [])).toEqual(["start", "-p", "5000"]);
  });
});

describe("agentsFromArgs", () => {
  it("returns null when unspecified, [] for --no-agents, csv/all otherwise", () => {
    expect(agentsFromArgs([])).toBeNull();
    expect(agentsFromArgs(["--no-agents"])).toEqual([]);
    expect(agentsFromArgs(["--agents", "nextjs,fastapi"])).toBe("nextjs,fastapi");
    expect(agentsFromArgs(["--agents=all"])).toBe("all");
  });
});

describe("parseInitArgs (anton init)", () => {
  it("defaults path/prefix to null and parses a bare path", () => {
    expect(parseInitArgs([])).toEqual({ path: null, prefix: null });
    expect(parseInitArgs(["/repos/foo"])).toEqual({ path: "/repos/foo", prefix: null });
  });

  it("parses --prefix <p>, --prefix=<p>, and -p <p>, keeping the first bare token as path", () => {
    expect(parseInitArgs(["/repos/foo", "--prefix", "acme"])).toEqual({ path: "/repos/foo", prefix: "acme" });
    expect(parseInitArgs(["--prefix=acme", "/repos/foo"])).toEqual({ path: "/repos/foo", prefix: "acme" });
    expect(parseInitArgs(["-p", "acme"])).toEqual({ path: null, prefix: "acme" });
    // The prefix value is not mistaken for the path.
    expect(parseInitArgs(["--prefix", "acme", "/repos/foo"])).toEqual({ path: "/repos/foo", prefix: "acme" });
  });
});

describe("ensureBeadsGitignore (anton init)", () => {
  let dir: string;
  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it("appends missing entries, preserves existing content, and is idempotent (no-clobber)", async () => {
    dir = await mkdtemp(join(tmpdir(), "anton-gi-"));
    const beadsDir = join(dir, ".beads");
    mkdirSync(beadsDir, { recursive: true });
    // A bd-init-style .gitignore already covers the Dolt runtime, but not the JSONL exports.
    writeFileSync(join(beadsDir, ".gitignore"), "dolt/\nembeddeddolt/\n");

    const first = ensureBeadsGitignore(beadsDir);
    expect(first.added).toEqual(["issues.jsonl", "interactions.jsonl"]);
    const after = await readFile(join(beadsDir, ".gitignore"), "utf8");
    expect(after).toContain("dolt/"); // pre-existing content preserved
    expect(after).toContain("issues.jsonl");
    expect(after).toContain("interactions.jsonl");

    // Re-run: everything present → no additions, file byte-identical.
    const second = ensureBeadsGitignore(beadsDir);
    expect(second.added).toEqual([]);
    expect(await readFile(join(beadsDir, ".gitignore"), "utf8")).toBe(after);
  });

  it("creates the file with all required entries when absent", async () => {
    dir = await mkdtemp(join(tmpdir(), "anton-gi-"));
    const beadsDir = join(dir, ".beads");
    mkdirSync(beadsDir, { recursive: true });

    const r = ensureBeadsGitignore(beadsDir);
    expect(r.added).toEqual(["issues.jsonl", "interactions.jsonl", "dolt/", "embeddeddolt/"]);
    const text = await readFile(join(beadsDir, ".gitignore"), "utf8");
    for (const e of ["issues.jsonl", "interactions.jsonl", "dolt/", "embeddeddolt/"]) {
      expect(text).toContain(e);
    }
  });
});

describe("detectHooksManager (anton init — hooks warning, anton-43b)", () => {
  let dir: string;
  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it("flags a husky repo by its committed .husky/ dir", async () => {
    dir = await mkdtemp(join(tmpdir(), "anton-hooks-"));
    mkdirSync(join(dir, ".husky"), { recursive: true });
    expect(detectHooksManager(dir)).toEqual({ manager: "husky", path: ".husky" });
  });

  it("flags a lefthook repo by its committed config file", async () => {
    dir = await mkdtemp(join(tmpdir(), "anton-hooks-"));
    writeFileSync(join(dir, "lefthook.yml"), "pre-commit:\n");
    expect(detectHooksManager(dir)).toEqual({ manager: "lefthook", path: "lefthook.yml" });
  });

  it("flags a bare custom core.hooksPath captured before bd init clobbered it", async () => {
    dir = await mkdtemp(join(tmpdir(), "anton-hooks-"));
    expect(detectHooksManager(dir, ".config/hooks")).toEqual({ manager: "custom", path: ".config/hooks" });
  });

  it("does NOT flag a plain-git repo, nor bd's own .beads/hooks value", async () => {
    dir = await mkdtemp(join(tmpdir(), "anton-hooks-"));
    expect(detectHooksManager(dir, null)).toBeNull();
    expect(detectHooksManager(dir, ".beads/hooks")).toBeNull();
    expect(detectHooksManager(dir, ".git/hooks")).toBeNull();
  });
});

describe("configureBeadsDoltSync (anton init — skip branches, anton-43b)", () => {
  let dir: string;
  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it("returns no-workspace when there is no .beads/", async () => {
    dir = await mkdtemp(join(tmpdir(), "anton-dolt-"));
    expect(configureBeadsDoltSync({ repoDir: dir })).toEqual({ status: "no-workspace" });
  });

  it("returns no-remote when the repo has no origin remote", async () => {
    dir = await mkdtemp(join(tmpdir(), "anton-dolt-"));
    mkdirSync(join(dir, ".beads"), { recursive: true });
    spawnSync("git", ["-C", dir, "init"], { stdio: "ignore" });
    expect(configureBeadsDoltSync({ repoDir: dir })).toEqual({ status: "no-remote" });
  });
});

describe("compareVersions", () => {
  it("orders dotted versions, tolerating a leading v", () => {
    expect(compareVersions("0.2.0", "0.1.9")).toBe(1);
    expect(compareVersions("v1.0.0", "1.0.1")).toBe(-1);
    expect(compareVersions("0.1.0", "0.1.0")).toBe(0);
    expect(compareVersions("1.2", "1.2.0")).toBe(0); // missing parts treated as 0
    expect(compareVersions("1.10.0", "1.9.0")).toBe(1); // numeric, not lexical
  });
});

describe("platformLabel", () => {
  it("is a <os>-<arch> label matching the running platform", () => {
    const label = platformLabel();
    expect(label).toMatch(/^[a-z0-9]+-[a-z0-9]+$/);
    expect(label).toContain(process.arch === "x64" ? "x64" : process.arch);
  });
});

describe("ensureBetterSqlite3", () => {
  it("returns 'ok' when the shipped binary matches the running Node (repo build)", () => {
    // The repo's better-sqlite3 was built for this exact Node, so no ABI fix is needed.
    expect(ensureBetterSqlite3(REPO_ROOT)).toBe("ok");
  });
});

describe("applyMigrations (in-process, no drizzle-kit)", () => {
  let dir: string;
  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it("applies the real migration set to a temp DB, idempotently", async () => {
    dir = await mkdtemp(join(tmpdir(), "anton-mig-"));
    const dbPath = join(dir, "anton.db");

    // Uses the repo's real drizzle/*.sql + better-sqlite3 (appRoot = REPO_ROOT).
    const first = applyMigrations(dbPath, { appRoot: REPO_ROOT });
    expect(first.total).toBeGreaterThan(0);
    expect(first.ran).toBe(first.total);
    expect(await exists(dbPath)).toBe(true);

    // Second run is a no-op — the journal records what's applied.
    const second = applyMigrations(dbPath, { appRoot: REPO_ROOT });
    expect(second.ran).toBe(0);
    expect(second.total).toBe(first.total);

    // The schema is really there: journal table + more than one user table.
    const require = createRequire(join(REPO_ROOT, "package.json"));
    const Database = require("better-sqlite3");
    const sqlite = new Database(dbPath);
    try {
      const journal = sqlite.prepare("SELECT COUNT(*) AS n FROM __anton_migrations").get() as { n: number };
      expect(journal.n).toBe(first.total);
      const tables = sqlite
        .prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table'")
        .get() as { n: number };
      expect(tables.n).toBeGreaterThan(1);
    } finally {
      sqlite.close();
    }
  });
});

describe("registerProject (anton init → projects board, anton-uez)", () => {
  let dir: string;
  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it("registers a repo in anton.db + seeds schedules, idempotently by repoPath", async () => {
    dir = await mkdtemp(join(tmpdir(), "anton-reg-"));
    const dbPath = join(dir, "anton.db");
    const repoPath = join(dir, "repo");
    mkdirSync(repoPath, { recursive: true });

    const first = registerProject(repoPath, { appRoot: REPO_ROOT, dbPath });
    expect(first.ok).toBe(true);
    expect(first.created).toBe(true);
    expect(first.slug).toBe("repo");

    // Re-registering the same repoPath is a no-op — no duplicate row.
    const second = registerProject(repoPath, { appRoot: REPO_ROOT, dbPath });
    expect(second.ok).toBe(true);
    expect(second.created).toBe(false);
    expect(second.slug).toBe("repo");

    const require = createRequire(join(REPO_ROOT, "package.json"));
    const Database = require("better-sqlite3");
    const sqlite = new Database(dbPath);
    try {
      const projects = sqlite
        .prepare("SELECT COUNT(*) AS n FROM projects WHERE repo_path = ?")
        .get(repoPath) as { n: number };
      expect(projects.n).toBe(1);
      // The three default schedules are seeded once (idempotent per type).
      const schedules = sqlite.prepare("SELECT COUNT(*) AS n FROM schedules").get() as { n: number };
      expect(schedules.n).toBe(3);
    } finally {
      sqlite.close();
    }
  });
});

describe("provisionAgentsSkills (into a temp ~/.claude)", () => {
  let claudeRoot: string;
  const skillPath = (name: string) => join(claudeRoot, "skills", name, "SKILL.md");

  afterEach(async () => {
    if (claudeRoot) await rm(claudeRoot, { recursive: true, force: true });
  });

  it("installs required skills + a selected agent, and is idempotent (no-clobber)", async () => {
    claudeRoot = await mkdtemp(join(tmpdir(), "anton-claude-"));

    // Non-interactive selection via flag so no TTY prompt is needed.
    const first = await provisionAgentsSkills(["--agents", "nextjs"], { claudeRoot, appRoot: REPO_ROOT });
    expect(first.installed).toBe(REQUIRED_SKILLS.length + 1); // 4 skills + 1 agent
    for (const req of REQUIRED_SKILLS) expect(await exists(skillPath(req))).toBe(true);
    expect(await exists(join(claudeRoot, "agents", "nextjs.md"))).toBe(true);

    // Re-run: everything already present, zero writes.
    const second = await provisionAgentsSkills(["--agents", "nextjs"], { claudeRoot, appRoot: REPO_ROOT });
    expect(second.installed).toBe(0);
    expect(second.skipped).toBe(REQUIRED_SKILLS.length + 1);
  });

  it("with --no-agents installs only the required skills", async () => {
    claudeRoot = await mkdtemp(join(tmpdir(), "anton-claude-"));
    const r = await provisionAgentsSkills(["--no-agents"], { claudeRoot, appRoot: REPO_ROOT });
    expect(r.installed).toBe(REQUIRED_SKILLS.length);
    expect(r.agents).toEqual([]);
    expect(await exists(join(claudeRoot, "agents"))).toBe(false);
  });
});
