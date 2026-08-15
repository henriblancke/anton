/**
 * `anton init` — the command that turns a git repo into a project anton can run (anton-k7q2, split
 * out of `anton.test.ts`). Its pieces first in isolation (argument parsing, the .gitignore, the
 * untracking of committed exports, the hooks-manager warning, project registration), then the whole
 * command end-to-end against a STUB `bd` on PATH, since CI has none.
 *
 * The Dolt-sync configuration lands here too: `configureBeadsDoltSync` is the single path shared by
 * `anton setup` and `anton init` (anton-8qx), and `normalizeRemoteUrl` is the URL-equality helper its
 * idempotency turns on — asserting either anywhere else would separate the claim from the code.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdir, readFile, rm, stat } from "node:fs/promises";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { ensureBeadsGitignore, parseInitArgs, registerProject, REQUIRED_SKILLS } from "./anton.mjs";

import {
  // The single Dolt-sync path (anton-8qx): one configureBeadsDoltSync shared by `anton setup`
  // (bin/anton.mjs) and `anton init` (via configureBeadsForRepo). normalizeRemoteUrl is its URL
  // equality helper.
  configureBeadsDoltSync,
  detectHooksManager,
  normalizeRemoteUrl,
  untrackBeadsExports,
} from "../src/lib/beads/config.mjs";

import {
  CLI,
  fakeBdVersion,
  gitInit,
  pathWith,
  REPO_ROOT,
  tempDir,
  tempDirs,
  withDb,
  writeFakeBd,
} from "./anton.fixture";

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
    dir = await tempDir("anton-gi-");
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
    dir = await tempDir("anton-gi-");
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

// anton-vqgw: .gitignore only suppresses UNTRACKED files. A repo that committed issues.jsonl before
// the ignore existed keeps shipping a frozen board snapshot to every clone and branch, which inbound
// tooling can replay over live state — so anton init has to untrack it, not just ignore it.
describe("untrackBeadsExports (anton init)", () => {
  let dir: string;

  function gitRepoWith(files: Record<string, string>): void {
    spawnSync("git", ["init", "-q"], { cwd: dir });
    spawnSync("git", ["config", "user.email", "t@example.com"], { cwd: dir });
    spawnSync("git", ["config", "user.name", "anton-test"], { cwd: dir });
    mkdirSync(join(dir, ".beads"), { recursive: true });
    for (const [rel, body] of Object.entries(files)) writeFileSync(join(dir, rel), body);
    spawnSync("git", ["add", "-A"], { cwd: dir });
    spawnSync("git", ["commit", "-qm", "seed"], { cwd: dir });
  }

  const tracked = (): string[] =>
    (spawnSync("git", ["ls-files", "--", ".beads/"], { cwd: dir, encoding: "utf8" }).stdout || "")
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);

  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it("untracks a committed issues.jsonl while leaving real config files tracked", async () => {
    dir = await tempDir("anton-untrack-");
    gitRepoWith({
      ".beads/issues.jsonl": '{"id":"x-1","status":"open"}\n',
      ".beads/config.yaml": "issue-prefix: x\n",
    });
    expect(tracked()).toContain(".beads/issues.jsonl");

    const r = untrackBeadsExports(dir);

    expect(r.untracked).toEqual([".beads/issues.jsonl"]);
    expect(tracked()).not.toContain(".beads/issues.jsonl");
    // config.yaml is team-config and must stay in git.
    expect(tracked()).toContain(".beads/config.yaml");
    // Untracked, not deleted — the export is still on disk for bd to use.
    await expect(stat(join(dir, ".beads/issues.jsonl"))).resolves.toBeDefined();
  });

  it("is a no-op when nothing is tracked", async () => {
    dir = await tempDir("anton-untrack-");
    gitRepoWith({ ".beads/config.yaml": "issue-prefix: x\n" });

    const r = untrackBeadsExports(dir);

    expect(r.untracked).toEqual([]);
    expect(tracked()).toEqual([".beads/config.yaml"]);
  });

  it("does not throw outside a git repo", async () => {
    dir = await tempDir("anton-untrack-");
    mkdirSync(join(dir, ".beads"), { recursive: true });
    expect(untrackBeadsExports(dir).untracked).toEqual([]);
  });
});

describe("detectHooksManager (anton init — hooks warning, anton-43b)", () => {
  let dir: string;
  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it("flags a husky repo by its committed .husky/ dir", async () => {
    dir = await tempDir("anton-hooks-");
    mkdirSync(join(dir, ".husky"), { recursive: true });
    expect(detectHooksManager(dir)).toEqual({ manager: "husky", path: ".husky" });
  });

  it("flags a lefthook repo by its committed config file", async () => {
    dir = await tempDir("anton-hooks-");
    writeFileSync(join(dir, "lefthook.yml"), "pre-commit:\n");
    expect(detectHooksManager(dir)).toEqual({ manager: "lefthook", path: "lefthook.yml" });
  });

  it("flags a bare custom core.hooksPath captured before bd init clobbered it", async () => {
    dir = await tempDir("anton-hooks-");
    expect(detectHooksManager(dir, ".config/hooks")).toEqual({ manager: "custom", path: ".config/hooks" });
  });

  it("does NOT flag a plain-git repo, nor bd's own .beads/hooks value", async () => {
    dir = await tempDir("anton-hooks-");
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
    dir = await tempDir("anton-dolt-");
    expect(configureBeadsDoltSync({ repoDir: dir })).toEqual({ status: "no-workspace" });
  });

  it("returns no-remote when the repo has no origin remote", async () => {
    dir = await tempDir("anton-dolt-");
    mkdirSync(join(dir, ".beads"), { recursive: true });
    spawnSync("git", ["-C", dir, "init"], { stdio: "ignore" });
    expect(configureBeadsDoltSync({ repoDir: dir })).toEqual({ status: "no-remote" });
  });
});

describe("registerProject (anton init → projects board, anton-uez)", () => {
  let dir: string;
  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it("registers a repo in anton.db + seeds schedules, idempotently by repoPath", async () => {
    dir = await tempDir("anton-reg-");
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

    withDb(dbPath, (sqlite) => {
      const projects = sqlite
        .prepare("SELECT COUNT(*) AS n FROM projects WHERE repo_path = ?")
        .get(repoPath) as { n: number };
      expect(projects.n).toBe(1);
      // The three default schedules are seeded once (idempotent per type).
      const schedules = sqlite.prepare("SELECT COUNT(*) AS n FROM schedules").get() as { n: number };
      expect(schedules.n).toBe(3);
    });
  });

  it("self-heals: re-registering backfills a missing default schedule (anton-mxy)", async () => {
    dir = await tempDir("anton-reg-heal-");
    const dbPath = join(dir, "anton.db");
    const repoPath = join(dir, "repo");
    mkdirSync(repoPath, { recursive: true });

    const first = registerProject(repoPath, { appRoot: REPO_ROOT, dbPath });
    expect(first.created).toBe(true);
    expect(first.backfilled).toBe(3);

    withDb(dbPath, (sqlite) => {
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
        .map((r) => (r as { type: string }).type);
      expect(types).toEqual(["nightly-stringer", "orphan-grooming", "review-fix"]);

      // A second re-register is now a clean no-op.
      expect(registerProject(repoPath, { appRoot: REPO_ROOT, dbPath }).backfilled).toBe(0);
    });
  });
});

describe("anton init (end-to-end, bd stubbed on PATH)", () => {
  const dirs = tempDirs();
  let fakeBin: string;
  let dbPath: string;

  beforeEach(async () => {
    fakeBin = await dirs.make("anton-fakebin-");
    writeFakeBd(fakeBin);
    dbPath = join(await dirs.make("anton-initdb-"), "anton.db");
  });

  afterEach(dirs.cleanup);

  // Spawn the CLI under the SAME runtime as this test (so its native better-sqlite3 — already proven
  // loadable in-process by the migration suite — matches), with the stub `bd` first on PATH and a
  // throwaway anton.db.
  function runInit(target: string, extra: string[] = []) {
    return spawnSync(process.execPath, [CLI, "init", target, ...extra], {
      encoding: "utf8",
      env: { ...process.env, PATH: pathWith(fakeBin), ANTON_DB: dbPath },
    });
  }

  function projectCount(repoPath?: string): number {
    return withDb(dbPath, (sqlite) => {
      const sql = repoPath
        ? "SELECT COUNT(*) AS n FROM projects WHERE repo_path = ?"
        : "SELECT COUNT(*) AS n FROM projects";
      const row = (repoPath ? sqlite.prepare(sql).get(repoPath) : sqlite.prepare(sql).get()) as { n: number };
      return row.n;
    });
  }

  it("fails loud on a non-git directory (no-git)", async () => {
    const dir = await dirs.make("anton-init-");
    const r = runInit(dir);
    expect(r.status).toBe(1);
    expect(r.stdout).toContain("not a git repository");
  });

  it("fails loud on a git repo with no origin remote (no-origin)", async () => {
    const dir = await dirs.make("anton-init-");
    gitInit(dir, false);
    const r = runInit(dir);
    expect(r.status).toBe(1);
    expect(r.stdout).toContain('no "origin" remote');
  });

  it("fails loud when bd is present but older than 1.1.0 (bd-too-old, anton-qwsq)", async () => {
    // Swap the on-PATH stub for one that reports an unsupported version. The version gate runs
    // before the git/origin checks, so a fully-wired repo still fails here with upgrade guidance.
    writeFakeBd(fakeBin, fakeBdVersion("1.0.4"));
    const dir = await dirs.make("anton-init-");
    gitInit(dir, true);
    const r = runInit(dir);
    expect(r.status).toBe(1);
    expect(r.stdout).toContain("bd 1.0.4 is too old");
    expect(r.stdout).toContain("1.1.0");
    expect(r.stdout).toContain("migration.md");
  });

  it("doctor's prereq check flags a too-old bd (anton-qwsq)", () => {
    writeFakeBd(fakeBin, fakeBdVersion("1.0.4"));
    const r = spawnSync(process.execPath, [CLI, "doctor"], {
      encoding: "utf8",
      env: { ...process.env, PATH: pathWith(fakeBin), ANTON_DB: dbPath },
    });
    expect(r.status).toBe(1);
    expect(r.stdout).toContain("need >= 1.1.0");
  });

  it("configures beads team-config + registers the repo on a fresh repo (fresh-init)", async () => {
    const dir = await dirs.make("anton-init-");
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
    // The .product/ layer is scaffolded so /shape + /scan-triage aren't left in a vacuum.
    expect(r.stdout).toContain("scaffolded .product/");
    expect(existsSync(join(dir, ".product", "PRODUCT.md"))).toBe(true);
    expect(existsSync(join(dir, ".product", "principles.md"))).toBe(true);
    // The repo is registered exactly once in the (temp) anton.db.
    expect(projectCount(resolve(dir))).toBe(1);
  });

  it("installs the required skills into the repo's own .claude/, no-clobber on re-run (skills-install)", async () => {
    const dir = await dirs.make("anton-init-");
    gitInit(dir, true);

    const first = runInit(dir);
    expect(first.status).toBe(0);
    // The required runtime skills land in the PROJECT .claude/ — not just the global ~/.claude that
    // `anton setup` provisions (anton-jvsd).
    for (const name of REQUIRED_SKILLS) {
      expect(existsSync(join(dir, ".claude", "skills", name, "SKILL.md"))).toBe(true);
    }

    // Re-run is a no-op: a pre-existing (user-modified) skill file is never overwritten.
    const marker = join(dir, ".claude", "skills", "bd", "SKILL.md");
    const edited = (await readFile(marker, "utf8")) + "\n<!-- user edit -->\n";
    writeFileSync(marker, edited);
    const second = runInit(dir);
    expect(second.status).toBe(0);
    expect(await readFile(marker, "utf8")).toBe(edited);
  });

  it("hydrates a fresh clone via bd bootstrap, then enforces team-config (fresh-clone)", async () => {
    const dir = await dirs.make("anton-init-");
    gitInit(dir, true);
    // A fresh clone: .beads/config.yaml arrived via git, but the gitignored local Dolt DB
    // (.beads/dolt/) never travels with the clone — the signal that init must bootstrap, not re-init.
    mkdirSync(join(dir, ".beads"), { recursive: true });
    writeFileSync(join(dir, ".beads", "config.yaml"), "# beads config (cloned)\nprefix: ex\n");

    const r = runInit(dir);
    expect(r.status).toBe(0);
    // bd bootstrap ran (not bd init) — its marker + the hydrated local Dolt DB are present.
    expect(existsSync(join(dir, ".beads", ".fake-bootstrapped"))).toBe(true);
    expect(existsSync(join(dir, ".beads", "dolt"))).toBe(true);
    expect(r.stdout).toContain("bd bootstrap");
    // Team-config is still enforced on top of the hydrated workspace.
    const cfg = await readFile(join(dir, ".beads", "config.yaml"), "utf8");
    expect(cfg).toContain("dolt.auto-commit: on");
    expect(cfg).toContain("export.auto: false");
  });

  it("is a no-op on re-run — no clobber, no duplicate registration (idempotent)", async () => {
    const dir = await dirs.make("anton-init-");
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
    const dir = await dirs.make("anton-init-");
    gitInit(dir, true);
    // A pre-existing workspace whose config.yaml has DRIFTED values + a missing key. Because .beads/
    // is present WITH a local Dolt DB, init skips `bd init`/`bd bootstrap` and only enforces the
    // team-config keys. export.auto: true is the inherited bd default anton must flip to false (anton-1th).
    mkdirSync(join(dir, ".beads", "dolt"), { recursive: true });
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

    // export.auto=false is enforced BEFORE any other `bd config set` write (anton-1th): each write is
    // itself a bd command that regenerates the JSONL while export.auto is still true, so disabling it
    // first closes that window. dolt.auto-commit here is drifted (off), so it too issues a write.
    const order = (await readFile(join(dir, ".beads", ".fake-config-set-order"), "utf8")).trim().split("\n");
    expect(order.indexOf("export.auto")).toBeGreaterThanOrEqual(0);
    expect(order.indexOf("export.auto")).toBeLessThan(order.indexOf("dolt.auto-commit"));
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
    const dir = await tempDir("anton-dolt-");
    await mkdir(join(dir, ".beads"), { recursive: true });
    return dir;
  }

  it("skips (no-workspace) when the root has no .beads", async () => {
    repoDir = await tempDir("anton-dolt-");
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
      "git ls-remote origin refs/dolt/data": { status: 0, stdout: "abc123\trefs/dolt/data\n" },
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
      "git ls-remote origin refs/dolt/data": { status: 0, stdout: "abc123\trefs/dolt/data\n" },
    });
    const r = configureBeadsDoltSync({ repoDir, exec });
    // First publish: nothing hydrated, but the push landed refs/dolt/data on origin.
    expect(r).toMatchObject({ status: "configured", pulled: false, pushed: true, firstPublish: true });
  });

  it("stops before push when pull fails for a reason other than a missing first-publish ref", async () => {
    repoDir = await beadsRepo();
    const { exec, calls } = fakeExec({
      "git remote get-url origin": { status: 0, stdout: "git@github.com:org/repo.git\n" },
      "bd dolt remote list": { status: 0, stdout: "No remotes configured.\n" },
      "bd dolt remote add origin": { status: 0 },
      "bd dolt pull": { status: 1, stderr: "authentication required" },
    });
    const r = configureBeadsDoltSync({ repoDir, exec });
    expect(r).toMatchObject({ status: "error", detail: expect.stringContaining("authentication required") });
    expect(calls.some((line) => line === "bd dolt push")).toBe(false);
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
      // A declared non-git remote isn't verifiable via `git ls-remote origin` — no ls-remote call.
    });
    const r = configureBeadsDoltSync({ repoDir, exec });
    expect(r).toMatchObject({ status: "configured", url: declared });
    expect(calls).toContain(`bd dolt remote add origin ${declared}`);
    // git origin is never consulted when the beads config declares the remote — neither to read the
    // URL nor to verify the push (a non-git remote isn't inspectable via `git ls-remote origin`).
    expect(calls.some((l) => l.startsWith("git remote get-url"))).toBe(false);
    expect(calls.some((l) => l.startsWith("git ls-remote"))).toBe(false);
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
      "git ls-remote origin refs/dolt/data": { status: 0, stdout: "abc123\trefs/dolt/data\n" },
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
      "git ls-remote origin refs/dolt/data": { status: 0, stdout: "abc123\trefs/dolt/data\n" },
    });
    const r = configureBeadsDoltSync({ repoDir, exec });
    expect(r).toMatchObject({ status: "configured", url: "git@github.com:org/new.git" });
    expect(calls).toContain("bd dolt remote add origin git@github.com:org/new.git");
  });

  it("reports a failed push (pushed: false) without hiding the remote configuration", async () => {
    repoDir = await beadsRepo();
    const { exec, calls } = fakeExec({
      "git remote get-url origin": { status: 0, stdout: "git@github.com:org/repo.git\n" },
      "bd dolt remote list": { status: 0, stdout: "No remotes configured.\n" },
      "bd dolt remote add origin": { status: 0 },
      "bd dolt pull": { status: 0 },
      "bd dolt push": { status: 1, stderr: "Error: push to origin/main: auth required" },
    });
    const r = configureBeadsDoltSync({ repoDir, exec });
    // The push is retried a bounded number of times before giving up (non-fatal).
    expect(r).toMatchObject({ status: "configured", pushed: false, pushAttempts: 3 });
    expect((r as { pushOutput: string }).pushOutput).toContain("auth required");
    expect(calls.filter((l) => l === "bd dolt push").length).toBe(3);
  });

  it("flags a failed FIRST publish loud (firstPublish) — an empty remote must not pass silently", async () => {
    repoDir = await beadsRepo();
    const { exec } = fakeExec({
      "git remote get-url origin": { status: 0, stdout: "git@github.com:org/repo.git\n" },
      "bd dolt remote list": { status: 0, stdout: "No remotes configured.\n" },
      "bd dolt remote add origin": { status: 0 },
      // Fresh origin: nothing to hydrate, so this is the first publish…
      "bd dolt pull": { status: 1, stderr: "remote ref refs/dolt/data not found" },
      // …and it never lands (no push access) — the remote stays empty.
      "bd dolt push": { status: 1, stderr: "auth required" },
    });
    const r = configureBeadsDoltSync({ repoDir, exec });
    expect(r).toMatchObject({ status: "configured", pulled: false, pushed: false, firstPublish: true });
  });

  it("retries when a push exits 0 but the ref never lands (verify beats a no-op push)", async () => {
    repoDir = await beadsRepo();
    const { exec, calls } = fakeExec({
      "git remote get-url origin": { status: 0, stdout: "git@github.com:org/repo.git\n" },
      "bd dolt remote list": { status: 0, stdout: "No remotes configured.\n" },
      "bd dolt remote add origin": { status: 0 },
      "bd dolt pull": { status: 0 },
      "bd dolt push": { status: 0 }, // exits 0…
      "git ls-remote origin refs/dolt/data": { status: 0, stdout: "" }, // …but nothing on origin
    });
    const r = configureBeadsDoltSync({ repoDir, exec });
    // Verification fails ⇒ not treated as published; retried up to the cap.
    expect(r).toMatchObject({ status: "configured", pushed: false, pushAttempts: 3 });
    expect(calls.filter((l) => l === "bd dolt push").length).toBe(3);
  });

  it("retries and reports failure when remote verification itself fails", async () => {
    repoDir = await beadsRepo();
    const { exec, calls } = fakeExec({
      "git remote get-url origin": { status: 0, stdout: "git@github.com:org/repo.git\n" },
      "bd dolt remote list": { status: 0, stdout: "No remotes configured.\n" },
      "bd dolt remote add origin": { status: 0 },
      "bd dolt pull": { status: 0 },
      "bd dolt push": { status: 0 },
      "git ls-remote origin refs/dolt/data": { status: 128, stderr: "authentication required" },
    });
    const r = configureBeadsDoltSync({ repoDir, exec });
    expect(r).toMatchObject({ status: "configured", pushed: false, pushAttempts: 3 });
    expect(calls.filter((line) => line === "bd dolt push").length).toBe(3);
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
