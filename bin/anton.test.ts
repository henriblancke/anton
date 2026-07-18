/**
 * Smoke tests for the anton CLI (anton-hji). Only exercises argument dispatch — the paths that
 * don't depend on external tools or a build — so it's deterministic in CI (where bd/gh/stringer
 * aren't installed). setup/start/doctor behavior is covered by the manual run + the prereq logic.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { delimiter, dirname, join, resolve } from "node:path";
import { createRequire } from "node:module";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import {
  agentsFromArgs,
  applyMigrations,
  compareVersions,
  ensureBeadsGitignore,
  ensureBetterSqlite3,
  ensureMigrated,
  nextArgs,
  parseInitArgs,
  platformLabel,
  provisionAgentsSkills,
  registerProject,
  INSTALLED_SKILLS,
  resolvePort,
} from "./anton.mjs";

import {
  // The single Dolt-sync path (anton-8qx): one configureBeadsDoltSync shared by `anton setup`
  // (bin/anton.mjs) and `anton init` (via configureBeadsForRepo). normalizeRemoteUrl is its URL
  // equality helper.
  configureBeadsDoltSync,
  detectHooksManager,
  normalizeRemoteUrl,
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

describe("ensureMigrated (bundle mode → in-process apply, before serving)", () => {
  let dir: string;
  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it("applies pending migrations, then is a clean no-op on the next start", async () => {
    dir = await mkdtemp(join(tmpdir(), "anton-start-mig-"));
    const dbPath = join(dir, "anton.db");

    // Bundle branch: apply the real committed SQL in-process (no drizzle-kit), like `anton start`.
    const first = ensureMigrated({ isBundle: true, dbPath, appRoot: REPO_ROOT });
    expect(first.ran).toBeGreaterThan(0);
    expect(await exists(dbPath)).toBe(true);

    // Re-running start with nothing pending applies zero migrations.
    const second = ensureMigrated({ isBundle: true, dbPath, appRoot: REPO_ROOT });
    expect(second.ran).toBe(0);
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

  it("self-heals: re-registering backfills a missing default schedule (anton-mxy)", async () => {
    dir = await mkdtemp(join(tmpdir(), "anton-reg-heal-"));
    const dbPath = join(dir, "anton.db");
    const repoPath = join(dir, "repo");
    mkdirSync(repoPath, { recursive: true });

    const first = registerProject(repoPath, { appRoot: REPO_ROOT, dbPath });
    expect(first.created).toBe(true);
    expect(first.backfilled).toBe(3);

    const require = createRequire(join(REPO_ROOT, "package.json"));
    const Database = require("better-sqlite3");
    const sqlite = new Database(dbPath);
    try {
      // Simulate a project that predates seeding one of its types (e.g. the anton project).
      sqlite.prepare("DELETE FROM schedules WHERE type = 'nightly-stringer'").run();
      expect((sqlite.prepare("SELECT COUNT(*) AS n FROM schedules").get() as { n: number }).n).toBe(2);

      // Re-registering the existing repo backfills only the missing type.
      const healed = registerProject(repoPath, { appRoot: REPO_ROOT, dbPath });
      expect(healed.created).toBe(false);
      expect(healed.backfilled).toBe(1);

      const types = sqlite
        .prepare("SELECT type FROM schedules ORDER BY type")
        .all()
        .map((r: { type: string }) => r.type);
      expect(types).toEqual(["nightly-stringer", "orphan-grooming", "review-fix"]);

      // A second re-register is now a clean no-op.
      expect(registerProject(repoPath, { appRoot: REPO_ROOT, dbPath }).backfilled).toBe(0);
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
    expect(first.installed).toBe(INSTALLED_SKILLS.length + 1); // 5 skills (incl. setup) + 1 agent
    for (const req of INSTALLED_SKILLS) expect(await exists(skillPath(req))).toBe(true);
    expect(await exists(join(claudeRoot, "agents", "nextjs.md"))).toBe(true);
    // setup's bundled templates travel with the skill directory (anton-olh).
    expect(
      await exists(join(claudeRoot, "skills", "setup", "templates", ".product", "PRODUCT.md")),
    ).toBe(true);

    // Re-run: everything already present, zero writes.
    const second = await provisionAgentsSkills(["--agents", "nextjs"], { claudeRoot, appRoot: REPO_ROOT });
    expect(second.installed).toBe(0);
    expect(second.skipped).toBe(INSTALLED_SKILLS.length + 1);
  });

  it("with --no-agents installs only the required skills", async () => {
    claudeRoot = await mkdtemp(join(tmpdir(), "anton-claude-"));
    const r = await provisionAgentsSkills(["--no-agents"], { claudeRoot, appRoot: REPO_ROOT });
    expect(r.installed).toBe(INSTALLED_SKILLS.length);
    expect(r.agents).toEqual([]);
    expect(await exists(join(claudeRoot, "agents"))).toBe(false);
  });
});

// `bd` isn't installed in CI, so the init flow is exercised end-to-end against a STUB `bd` placed
// first on PATH (git stays real, run over a throwaway temp repo). The stub mutates the real .beads/
// files (config.yaml, dolt-remote state) so config.mjs's file-reading logic — configYamlHas, the
// idempotency skips, the drift patch — sees a realistic workspace. This is the "inject exec" seam the
// ticket calls for, applied at the process boundary rather than by forking config.mjs's spawnSync.
const FAKE_BD = [
  "#!/usr/bin/env node",
  'const fs = require("node:fs");',
  'const path = require("node:path");',
  "const a = process.argv.slice(2);",
  'const beads = path.join(process.cwd(), ".beads");',
  'const cfg = path.join(beads, "config.yaml");',
  'const marker = path.join(beads, ".fake-dolt-remotes");',
  // onPath() probes --version/--help.
  'if (a[0] === "--version" || a[0] === "--help") { console.log("bd 0.0.0-fake"); process.exit(0); }',
  // `bd init` creates the workspace; the team-config keys are intentionally left OUT so the
  // subsequent `bd config set` calls (config.yaml enforcement) are exercised.
  'if (a[0] === "init") {',
  "  fs.mkdirSync(beads, { recursive: true });",
  '  const pi = a.indexOf("--prefix");',
  '  const prefix = pi >= 0 ? a[pi + 1] : "bd";',
  '  if (!fs.existsSync(cfg)) fs.writeFileSync(cfg, "# beads config (fake)\\nprefix: " + prefix + "\\n");',
  "  process.exit(0);",
  "}",
  // `bd config set` patches an existing uncommented `key:` line in place (drift), else appends it.
  'if (a[0] === "config" && a[1] === "set") {',
  "  const key = a[2], val = a[3];",
  '  let text = ""; try { text = fs.readFileSync(cfg, "utf8"); } catch {}',
  '  const lines = text.split("\\n");',
  "  let replaced = false;",
  "  for (let i = 0; i < lines.length; i++) {",
  "    const t = lines[i].trimStart();",
  '    if (!t.startsWith("#") && t.startsWith(key + ":")) { lines[i] = key + ": " + val; replaced = true; break; }',
  "  }",
  '  const out = replaced ? lines.join("\\n") : (text.length && !text.endsWith("\\n") ? text + "\\n" : text) + key + ": " + val + "\\n";',
  "  fs.writeFileSync(cfg, out);",
  "  process.exit(0);",
  "}",
  // Dolt remote state is tracked in a marker file so `remote list` reflects prior `remote add`s.
  'if (a[0] === "dolt" && a[1] === "remote" && a[2] === "list") {',
  '  let r = []; try { r = JSON.parse(fs.readFileSync(marker, "utf8")); } catch {}',
  '  if (!r.length) console.log("no remotes configured");',
  '  else for (const x of r) console.log(x.name + "\\t" + x.url);',
  "  process.exit(0);",
  "}",
  'if (a[0] === "dolt" && a[1] === "remote" && a[2] === "add") {',
  '  let r = []; try { r = JSON.parse(fs.readFileSync(marker, "utf8")); } catch {}',
  "  r.push({ name: a[3], url: a[4] });",
  "  fs.writeFileSync(marker, JSON.stringify(r));",
  "  process.exit(0);",
  "}",
  'if (a[0] === "dolt" && (a[1] === "pull" || a[1] === "push")) process.exit(0);',
  "process.exit(0);",
].join("\n");

describe("anton init (end-to-end, bd stubbed on PATH)", () => {
  let fakeBin: string;
  let dbPath: string;
  const cleanups: string[] = [];

  async function tmp(prefix: string): Promise<string> {
    const d = await mkdtemp(join(tmpdir(), prefix));
    cleanups.push(d);
    return d;
  }

  beforeEach(async () => {
    fakeBin = await tmp("anton-fakebin-");
    const bd = join(fakeBin, "bd");
    writeFileSync(bd, FAKE_BD);
    chmodSync(bd, 0o755);
    dbPath = join(await tmp("anton-initdb-"), "anton.db");
  });

  afterEach(async () => {
    for (const d of cleanups.splice(0)) await rm(d, { recursive: true, force: true });
  });

  // Spawn the CLI under the SAME runtime as this test (so its native better-sqlite3 — already proven
  // loadable in-process above — matches), with the stub `bd` first on PATH and a throwaway anton.db.
  function runInit(target: string, extra: string[] = []) {
    return spawnSync(process.execPath, [CLI, "init", target, ...extra], {
      encoding: "utf8",
      env: { ...process.env, PATH: `${fakeBin}${delimiter}${process.env.PATH ?? ""}`, ANTON_DB: dbPath },
    });
  }

  function gitInit(dir: string, withOrigin: boolean) {
    spawnSync("git", ["-C", dir, "init"], { stdio: "ignore" });
    if (withOrigin) {
      spawnSync("git", ["-C", dir, "remote", "add", "origin", join(dir, "origin.git")], { stdio: "ignore" });
    }
  }

  function projectCount(repoPath?: string): number {
    const require = createRequire(join(REPO_ROOT, "package.json"));
    const Database = require("better-sqlite3");
    const sqlite = new Database(dbPath);
    try {
      const sql = repoPath
        ? "SELECT COUNT(*) AS n FROM projects WHERE repo_path = ?"
        : "SELECT COUNT(*) AS n FROM projects";
      const row = (repoPath ? sqlite.prepare(sql).get(repoPath) : sqlite.prepare(sql).get()) as { n: number };
      return row.n;
    } finally {
      sqlite.close();
    }
  }

  it("fails loud on a non-git directory (no-git)", async () => {
    const dir = await tmp("anton-init-");
    const r = runInit(dir);
    expect(r.status).toBe(1);
    expect(r.stdout).toContain("not a git repository");
  });

  it("fails loud on a git repo with no origin remote (no-origin)", async () => {
    const dir = await tmp("anton-init-");
    gitInit(dir, false);
    const r = runInit(dir);
    expect(r.status).toBe(1);
    expect(r.stdout).toContain('no "origin" remote');
  });

  it("configures beads team-config + registers the repo on a fresh repo (fresh-init)", async () => {
    const dir = await tmp("anton-init-");
    gitInit(dir, true);

    const r = runInit(dir);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("beads team-config enforced");
    expect(r.stdout).toContain("registered with anton");

    // config.yaml carries the enforced Dolt-first keys…
    const cfg = await readFile(join(dir, ".beads", "config.yaml"), "utf8");
    expect(cfg).toContain("dolt.auto-commit: on");
    // export.auto AND export.git-add are both disabled — export.auto stops the periodic JSONL
    // regeneration itself, export.git-add only stops staging it (anton-1th).
    expect(cfg).toContain("export.auto: false");
    expect(cfg).toContain("export.git-add: false");
    // …and .gitignore untracks the derived exports + Dolt runtime state.
    const gi = await readFile(join(dir, ".beads", ".gitignore"), "utf8");
    for (const e of ["issues.jsonl", "interactions.jsonl", "dolt/", "embeddeddolt/"]) {
      expect(gi).toContain(e);
    }
    // The repo is registered exactly once in the (temp) anton.db.
    expect(projectCount(resolve(dir))).toBe(1);
  });

  it("is a no-op on re-run — no clobber, no duplicate registration (idempotent)", async () => {
    const dir = await tmp("anton-init-");
    gitInit(dir, true);

    const first = runInit(dir);
    expect(first.status).toBe(0);
    const cfgAfterFirst = await readFile(join(dir, ".beads", "config.yaml"), "utf8");

    const second = runInit(dir);
    expect(second.status).toBe(0);
    expect(second.stdout).toContain("already registered");
    // config.yaml is byte-identical — no key re-written on the second pass.
    expect(await readFile(join(dir, ".beads", "config.yaml"), "utf8")).toBe(cfgAfterFirst);
    // Still exactly one project row (idempotent by repo_path).
    expect(projectCount()).toBe(1);
  });

  it("patches a drifted config.yaml key without clobbering the file (config-drift patch)", async () => {
    const dir = await tmp("anton-init-");
    gitInit(dir, true);
    // A pre-existing workspace whose config.yaml has DRIFTED values + a missing key. Because .beads/
    // is present, init skips `bd init` and only enforces the team-config keys. export.auto: true is
    // the inherited bd default anton must flip to false (anton-1th).
    mkdirSync(join(dir, ".beads"), { recursive: true });
    writeFileSync(join(dir, ".beads", "config.yaml"), "# beads config\ndolt.auto-commit: off\nexport.auto: true\n");

    const r = runInit(dir);
    expect(r.status).toBe(0);

    const cfg = await readFile(join(dir, ".beads", "config.yaml"), "utf8");
    expect(cfg).toContain("dolt.auto-commit: on"); // drift patched in place…
    expect(cfg).not.toContain("dolt.auto-commit: off"); // …not left alongside the stale value
    expect(cfg).toContain("export.auto: false"); // export.auto=true flipped to false…
    expect(cfg).not.toContain("export.auto: true"); // …patched in place, not duplicated
    expect((cfg.match(/^export\.auto:/gm) ?? []).length).toBe(1); // exactly one export.auto key
    expect(cfg).toContain("export.git-add: false"); // missing key appended
  });
});

describe("normalizeRemoteUrl", () => {
  it("equates the git-origin form with what bd dolt remote list reports", () => {
    // bd rewrites scp form to git+ssh:// with a literal /./ path segment.
    expect(normalizeRemoteUrl("git@github.com:henriblancke/anton.git")).toBe(
      normalizeRemoteUrl("git+ssh://git@github.com/./henriblancke/anton.git"),
    );
    expect(normalizeRemoteUrl("https://github.com/org/repo.git")).toBe(
      normalizeRemoteUrl("git+https://github.com/org/repo.git"),
    );
    expect(normalizeRemoteUrl("/tmp/remote.git")).toBe(normalizeRemoteUrl("git+file:///tmp/remote.git"));
    expect(normalizeRemoteUrl("https://github.com/a/b")).not.toBe(normalizeRemoteUrl("https://github.com/a/c"));
  });
});

describe("configureBeadsDoltSync (bd/git stubbed — CI has no bd)", () => {
  let repoDir: string;
  afterEach(async () => {
    if (repoDir) await rm(repoDir, { recursive: true, force: true });
  });

  /** A fake exec keyed by "<cmd> <subcommand…>" prefix; records every invocation. Unless a test
   * overrides it, `sync.remote` reads as unset — bd's real "(not set…)" prose with exit 0. */
  function fakeExec(responses: Record<string, { status: number; stdout?: string; stderr?: string }>) {
    const calls: string[] = [];
    const withDefaults = {
      "bd config get sync.remote": { status: 0, stdout: "sync.remote (not set in config.yaml)\n" },
      ...responses,
    };
    const exec = (cmd: string, args: string[]) => {
      const line = [cmd, ...args].join(" ");
      calls.push(line);
      for (const [prefix, res] of Object.entries(withDefaults)) {
        if (line.startsWith(prefix)) return Object.assign({ stdout: "", stderr: "" }, res);
      }
      throw new Error(`unexpected exec: ${line}`);
    };
    return { exec, calls };
  }

  async function beadsRepo(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "anton-dolt-"));
    await mkdir(join(dir, ".beads"), { recursive: true });
    return dir;
  }

  it("skips (no-workspace) when the root has no .beads", async () => {
    repoDir = await mkdtemp(join(tmpdir(), "anton-dolt-"));
    const { exec } = fakeExec({});
    expect(configureBeadsDoltSync({ repoDir, exec })).toEqual({ status: "no-workspace" });
  });

  it("fails loud (no-remote) when .beads exists but git has no origin", async () => {
    repoDir = await beadsRepo();
    const { exec } = fakeExec({
      "git remote get-url origin": { status: 2, stderr: "error: No such remote 'origin'" },
    });
    expect(configureBeadsDoltSync({ repoDir, exec })).toEqual({ status: "no-remote" });
  });

  it("adds the git origin as Dolt remote, hydrates (pull), and pushes refs/dolt", async () => {
    repoDir = await beadsRepo();
    const { exec, calls } = fakeExec({
      "git remote get-url origin": { status: 0, stdout: "git@github.com:org/repo.git\n" },
      "bd dolt remote list": { status: 0, stdout: "No remotes configured.\n" },
      "bd dolt remote add origin": { status: 0, stdout: 'Added remote "origin"' },
      "bd dolt pull": { status: 0, stdout: "Everything up-to-date." },
      "bd dolt push": { status: 0, stdout: "Push complete." },
    });
    const r = configureBeadsDoltSync({ repoDir, exec });
    expect(r).toMatchObject({
      status: "configured",
      url: "git@github.com:org/repo.git",
      pulled: true,
      pushed: true,
    });
    expect(calls).toContain("bd dolt remote add origin git@github.com:org/repo.git");
    // A fresh clone has no JSONL to hydrate from (anton-hg9): the board must come from
    // refs/dolt/data, so the pull runs before the push can publish anything local.
    expect(calls.indexOf("bd dolt pull")).toBeLessThan(calls.indexOf("bd dolt push"));
  });

  it("treats a failed pull as benign (first-ever setup: no refs/dolt/data on the remote)", async () => {
    repoDir = await beadsRepo();
    const { exec } = fakeExec({
      "git remote get-url origin": { status: 0, stdout: "git@github.com:org/repo.git\n" },
      "bd dolt remote list": { status: 0, stdout: "No remotes configured.\n" },
      "bd dolt remote add origin": { status: 0 },
      "bd dolt pull": { status: 1, stderr: "remote ref refs/dolt/data not found" },
      "bd dolt push": { status: 0 },
    });
    const r = configureBeadsDoltSync({ repoDir, exec });
    expect(r).toMatchObject({ status: "configured", pulled: false, pushed: true });
  });

  it("is idempotent: skips add+push when origin already matches (bd's rewritten form)", async () => {
    repoDir = await beadsRepo();
    const { exec, calls } = fakeExec({
      "git remote get-url origin": { status: 0, stdout: "git@github.com:org/repo.git\n" },
      "bd dolt remote list": {
        status: 0,
        stdout: "origin               git+ssh://git@github.com/./org/repo.git\n",
      },
    });
    const r = configureBeadsDoltSync({ repoDir, exec });
    expect(r).toEqual({ status: "already", url: "git@github.com:org/repo.git" });
    expect(calls.some((l) => l.startsWith("bd dolt remote add"))).toBe(false);
    expect(calls.some((l) => l.startsWith("bd dolt push"))).toBe(false);
  });

  it("respects a declared sync.remote (aws://) over the git origin — dynamic per project", async () => {
    repoDir = await beadsRepo();
    const declared = "aws://[optura-beads-dolt-manifest:optura-beads]/some-project";
    const { exec, calls } = fakeExec({
      "bd config get sync.remote": { status: 0, stdout: `sync.remote = ${declared}\n` },
      "bd dolt remote list": { status: 0, stdout: "No remotes configured.\n" },
      "bd dolt remote add origin": { status: 0 },
      "bd dolt pull": { status: 0 },
      "bd dolt push": { status: 0 },
    });
    const r = configureBeadsDoltSync({ repoDir, exec });
    expect(r).toMatchObject({ status: "configured", url: declared });
    expect(calls).toContain(`bd dolt remote add origin ${declared}`);
    // git origin is never consulted when the beads config declares the remote.
    expect(calls.some((l) => l.startsWith("git remote get-url"))).toBe(false);
  });

  it("treats bd's '(not set in config.yaml)' prose as absent — exit code is 0 either way", async () => {
    repoDir = await beadsRepo();
    const { exec, calls } = fakeExec({
      "bd config get sync.remote": { status: 0, stdout: "sync.remote (not set in config.yaml)\n" },
      "git remote get-url origin": { status: 0, stdout: "git@github.com:org/repo.git\n" },
      "bd dolt remote list": { status: 0, stdout: "No remotes configured.\n" },
      "bd dolt remote add origin": { status: 0 },
      "bd dolt pull": { status: 0 },
      "bd dolt push": { status: 0 },
    });
    const r = configureBeadsDoltSync({ repoDir, exec });
    expect(r).toMatchObject({ status: "configured", url: "git@github.com:org/repo.git" });
    expect(calls).toContain("bd dolt remote add origin git@github.com:org/repo.git");
  });

  it("re-points a stale Dolt remote at the current git origin", async () => {
    repoDir = await beadsRepo();
    const { exec, calls } = fakeExec({
      "git remote get-url origin": { status: 0, stdout: "git@github.com:org/new.git\n" },
      "bd dolt remote list": { status: 0, stdout: "origin  git+ssh://git@github.com/./org/old.git\n" },
      "bd dolt remote add origin": { status: 0 },
      "bd dolt pull": { status: 0 },
      "bd dolt push": { status: 0 },
    });
    const r = configureBeadsDoltSync({ repoDir, exec });
    expect(r).toMatchObject({ status: "configured", url: "git@github.com:org/new.git" });
    expect(calls).toContain("bd dolt remote add origin git@github.com:org/new.git");
  });

  it("reports a failed push (pushed: false) without hiding the remote configuration", async () => {
    repoDir = await beadsRepo();
    const { exec } = fakeExec({
      "git remote get-url origin": { status: 0, stdout: "git@github.com:org/repo.git\n" },
      "bd dolt remote list": { status: 0, stdout: "No remotes configured.\n" },
      "bd dolt remote add origin": { status: 0 },
      "bd dolt pull": { status: 0 },
      "bd dolt push": { status: 1, stderr: "Error: push to origin/main: auth required" },
    });
    const r = configureBeadsDoltSync({ repoDir, exec });
    expect(r).toMatchObject({ status: "configured", pushed: false });
    expect((r as { pushOutput: string }).pushOutput).toContain("auth required");
  });

  it("surfaces a bd dolt remote add failure as an error", async () => {
    repoDir = await beadsRepo();
    const { exec } = fakeExec({
      "git remote get-url origin": { status: 0, stdout: "git@github.com:org/repo.git\n" },
      "bd dolt remote list": { status: 0, stdout: "No remotes configured.\n" },
      "bd dolt remote add origin": { status: 1, stderr: "dolt server unreachable" },
    });
    const r = configureBeadsDoltSync({ repoDir, exec });
    expect(r).toMatchObject({ status: "error" });
    expect((r as { detail: string }).detail).toContain("dolt server unreachable");
  });
});
