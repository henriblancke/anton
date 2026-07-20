#!/usr/bin/env node
/**
 * anton CLI (anton-hji) — the turn-key entry point, shipped via package.json `bin`. Like foolery,
 * anton is a local Next.js server; this launcher bootstraps and runs it from the installed package
 * dir (NOT the user's cwd), so `anton` works from anywhere once installed (`npm i -g` / `bunx`).
 *
 *   anton setup    prereq checks → drizzle migrate (creates/updates anton.db) → node-pty rebuild →
 *                  install required skills + selected agents into global ~/.claude (interactive;
 *                  `--agents <a,b,c>` / `--agents all` / `--no-agents` for non-interactive/CI) →
 *                  wire beads Dolt sync (git origin as Dolt remote + initial refs/dolt push)
 *   anton doctor   prereq checks only (non-destructive)
 *   anton dev      next dev  (runner + scheduler auto-start via src/instrumentation.ts)
 *   anton start    next build (if stale) → next start
 *   anton --help   usage
 *
 * `dev`/`start` accept `--port <n>` (alias `-p`, or `PORT=<n>` in the env) to run on a
 * non-default port; without it the server listens on 3000.
 *
 * Pure Node, zero deps. Native ESM.
 */
import { spawn, spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { arch as osArch, homedir, platform as osPlatform } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import {
  beadsPrereqs,
  configureBeadsDoltSync,
  configureBeadsForRepo,
  ensureBeadsGitignore,
} from "../src/lib/beads/config.mjs";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";

const __dirname = dirname(fileURLToPath(import.meta.url));
/** The anton package root = parent of bin/. All commands run here, not in the user's cwd. */
const APP_ROOT = join(__dirname, "..");
const BIN = join(APP_ROOT, "node_modules", ".bin");

// ── Distribution / bundle mode (anton-1xp) ──────────────────────────────────────────────────
// A prebuilt release bundle carries a RELEASE_VERSION marker at its root; a source checkout does
// not. In bundle mode `start` daemonizes and `stop`/`status`/`update`/`uninstall` manage the
// installed runtime, and — because the runtime dir is REPLACED wholesale on update — all writable
// state (anton.db, sessions, scans, logs, pid) lives under a persistent state dir, never in APP_ROOT.
const RELEASE_VERSION_FILE = join(APP_ROOT, "RELEASE_VERSION");
const IS_BUNDLE = existsSync(RELEASE_VERSION_FILE);
const INSTALL_ROOT = process.env.ANTON_HOME ?? join(homedir(), ".local", "share", "anton");
const STATE_DIR = process.env.ANTON_STATE_DIR ?? join(homedir(), ".local", "state", "anton");
const LOG_DIR = join(STATE_DIR, "logs");
const PID_FILE = join(STATE_DIR, "anton.pid");
const BIN_LINK = process.env.ANTON_BIN_LINK ?? join(homedir(), ".local", "bin", "anton");
const RELEASE_OWNER = process.env.ANTON_RELEASE_OWNER ?? "henriblancke";
const RELEASE_REPO = process.env.ANTON_RELEASE_REPO ?? "anton";

/** The release-asset platform label (`<os>-<arch>`), matching scripts/build-bundle.mjs. */
function platformLabel() {
  const os = { darwin: "darwin", linux: "linux" }[osPlatform()] ?? osPlatform();
  const arch = { arm64: "arm64", x64: "x64" }[osArch()] ?? osArch();
  return `${os}-${arch}`;
}

/** The installed bundle's version (from RELEASE_VERSION), or null in a source checkout. */
function bundleVersion() {
  try {
    return readFileSync(RELEASE_VERSION_FILE, "utf8").trim();
  } catch {
    return null;
  }
}

/** Env that redirects anton's writable state OUT of the (replaceable) runtime dir in bundle mode. */
function bundleStateEnv() {
  return {
    ANTON_DB: process.env.ANTON_DB ?? join(STATE_DIR, "anton.db"),
    ANTON_SESSIONS_ROOT: process.env.ANTON_SESSIONS_ROOT ?? join(STATE_DIR, "sessions"),
    ANTON_SCANS_ROOT: process.env.ANTON_SCANS_ROOT ?? join(STATE_DIR, "scans"),
  };
}

/** Compare dotted versions. Returns 1 if a>b, -1 if a<b, 0 if equal (non-numeric parts ignored). */
function compareVersions(a, b) {
  const pa = String(a).replace(/^v/, "").split(".").map((n) => parseInt(n, 10) || 0);
  const pb = String(b).replace(/^v/, "").split(".").map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d) return d > 0 ? 1 : -1;
  }
  return 0;
}

/** Read the daemon PID if the process is actually alive; clears a stale pidfile otherwise. */
function runningPid() {
  let pid;
  try {
    pid = parseInt(readFileSync(PID_FILE, "utf8").trim(), 10);
  } catch {
    return null;
  }
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try {
    process.kill(pid, 0); // signal 0 = existence check
    return pid;
  } catch {
    try { unlinkSync(PID_FILE); } catch {}
    return null;
  }
}

/** Poll until the server answers on the port, or timeout. Best-effort (uses global fetch). */
async function waitForReady(port, timeoutMs = 30000) {
  const url = `http://127.0.0.1:${port}/`;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await fetch(url, { signal: AbortSignal.timeout(1500) });
      return true;
    } catch {
      await sleep(500);
    }
  }
  return false;
}

const c = {
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
};

/** External CLIs anton drives at runtime. `required` ones fail setup/doctor; others just warn. */
const PREREQS = [
  { cmd: "git", required: true, why: "worktrees, commits, push" },
  { cmd: "bd", required: true, why: "beads — the work source of truth" },
  { cmd: "claude", required: true, why: "the executor (headless + interactive)" },
  { cmd: "gh", required: false, why: "PRs + review-fix" },
  { cmd: "stringer", required: false, why: "nightly scan → beads" },
];

/** True if `cmd --version` (or `--help`) runs. Tolerates tools that lack --version. */
function onPath(cmd) {
  for (const probe of [["--version"], ["--help"]]) {
    const r = spawnSync(cmd, probe, { stdio: "ignore" });
    if (!r.error && (r.status === 0 || r.status === 1)) return true;
  }
  // Last resort: `command -v` via the shell.
  const r = spawnSync("sh", ["-c", `command -v ${cmd}`], { stdio: "ignore" });
  return r.status === 0;
}

/**
 * Resolve the port for `dev`/`start` from CLI args, falling back to `PORT`, then Next's own default
 * (3000, applied by next when we pass nothing). Accepts `--port 4000`, `--port=4000`, or `-p 4000`.
 * An explicit flag wins over `PORT`. Returns undefined when neither is set (let next default it).
 */
function resolvePort(args) {
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--port" || a === "-p") return args[i + 1];
    const m = a.match(/^(?:--port|-p)=(.+)$/);
    if (m) return m[1];
  }
  return process.env.PORT || undefined;
}

/** Build the `next` arg list for `dev`/`start`, appending `-p <port>` when a port is resolved. */
function nextArgs(sub, args) {
  const port = resolvePort(args);
  return port ? [sub, "-p", String(port)] : [sub];
}

/** Run a local package bin (next / drizzle-kit) from APP_ROOT, inheriting stdio. Returns exit code. */
function runLocal(bin, args, env = {}) {
  const exe = join(BIN, bin);
  const target = existsSync(exe) ? exe : bin; // fall back to PATH if not vendored
  const r = spawnSync(target, args, {
    cwd: APP_ROOT,
    stdio: "inherit",
    env: { ...process.env, ...env },
  });
  return r.status ?? 1;
}

// ── Agents & skills provisioning (anton setup) ──────────────────────────────────────────────
// Mirrors src/lib/setup/installer.ts (which the in-app UI uses), reimplemented dependency-free so
// the launcher stays pure Node and runs before any build. Install target is the user's GLOBAL
// ~/.claude, so anton's agents/skills are discoverable from every repo `claude` runs in. No-clobber
// is the invariant: an existing destination (a prior install OR the user's own file) is never
// overwritten. Keep these in sync with REQUIRED_SKILLS / INSTALLED_SKILLS in src/lib/claude/prompt.ts.
const AGENTS_SRC = join(APP_ROOT, "src", "prompts", "agents");
const SKILLS_SRC = join(APP_ROOT, "skills");
const REQUIRED_SKILLS = ["shape", "bd", "scan-triage", "review-fix"];
// The full set installed into a project (non-deselectable): the runtime-required skills + the
// founder-run `setup` scaffolder. `setup` isn't runtime-loaded, but must be installed so `/setup`
// resolves; it ships its `.product/` templates under skills/setup/templates/, copied with it.
const INSTALLED_SKILLS = [...REQUIRED_SKILLS, "setup"];
const CLAUDE_ROOT = join(homedir(), ".claude");

/** Bundled specialist agent tags (basenames of src/prompts/agents/*.md), sorted. */
function listBundledAgents(agentsSrc = AGENTS_SRC) {
  try {
    return readdirSync(agentsSrc)
      .filter((f) => f.endsWith(".md"))
      .map((f) => f.slice(0, -".md".length))
      .sort();
  } catch {
    return [];
  }
}

/** Best-effort one-line description: frontmatter `description:`, else first non-empty body line. */
function shortDescription(path) {
  let md;
  try {
    md = readFileSync(path, "utf8");
  } catch {
    return "";
  }
  if (md.startsWith("---\n")) {
    const end = md.indexOf("\n---", 4);
    if (end !== -1) {
      for (const line of md.slice(4, end).split("\n")) {
        const m = line.match(/^description:\s*(.+)$/);
        if (m) return m[1].replace(/^["']|["']$/g, "").trim();
      }
    }
  }
  const body = md.replace(/^---\n[\s\S]*?\n---\n?/, "");
  for (const line of body.split("\n")) {
    const t = line.replace(/^#+\s*/, "").trim();
    if (t) return t;
  }
  return "";
}

/** Copy src→dest unless dest exists (no-clobber). Returns "installed" | "skipped". */
function installFile(src, dest) {
  if (existsSync(dest)) return "skipped";
  mkdirSync(dirname(dest), { recursive: true });
  copyFileSync(src, dest);
  return "installed";
}

/** Recursively list every file under `dir` as paths relative to `dir` (files only). */
function walkFiles(dir, base = dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkFiles(abs, base));
    else if (entry.isFile()) out.push(abs.slice(base.length + 1));
  }
  return out;
}

/**
 * Install a whole skill DIRECTORY (SKILL.md + any bundled assets, e.g. setup's templates/) no-clobber.
 * The SKILL.md is the presence sentinel: if it already exists the skill is left untouched ("skipped");
 * otherwise every file under the bundled skill dir is copied. Returns "installed" | "skipped".
 */
function installSkillDir(srcDir, destDir) {
  if (existsSync(join(destDir, "SKILL.md"))) return "skipped";
  for (const rel of walkFiles(srcDir)) installFile(join(srcDir, rel), join(destDir, rel));
  return "installed";
}

/** Parse `--agents <csv|all>` / `--no-agents` from the setup args, or null if unspecified. */
function agentsFromArgs(args) {
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--no-agents") return [];
    if (args[i] === "--agents") return args[i + 1];
    const m = args[i].match(/^--agents=(.*)$/);
    if (m) return m[1];
  }
  return null;
}

/** Interactive single-shot agent picker over a plain TTY (no arrow-key deps). */
async function pickAgents(agents, agentsSrc = AGENTS_SRC) {
  console.log(c.bold("\nBundled specialist agents") + c.dim(" — pick the ones matching your stack:"));
  agents.forEach((tag, i) => {
    const desc = shortDescription(join(agentsSrc, `${tag}.md`));
    const truncated = desc.length > 60 ? desc.slice(0, 57) + "…" : desc;
    console.log(`  ${String(i + 1).padStart(2)}. ${c.bold(tag.padEnd(11))} ${c.dim(truncated)}`);
  });
  console.log(c.dim("  Enter numbers (e.g. 1 3 5), 'a' for all, or press Enter for none."));

  const rl = createInterface({ input: stdin, output: stdout });
  let answer;
  try {
    answer = (await rl.question(c.bold("agents> "))).trim();
  } finally {
    rl.close();
  }

  if (answer === "") return [];
  if (/^a(ll)?$/i.test(answer)) return agents;
  const picked = new Set();
  for (const tok of answer.split(/[\s,]+/).filter(Boolean)) {
    const n = Number(tok);
    if (Number.isInteger(n) && n >= 1 && n <= agents.length) picked.add(agents[n - 1]);
    else console.log(c.yellow(`  (ignoring "${tok}" — not a listed number)`));
  }
  return [...picked];
}

/** Resolve which agents to install: CLI flag > interactive TTY prompt > none (non-TTY). */
async function resolveAgentSelection(args, agentsSrc = AGENTS_SRC) {
  const bundled = listBundledAgents(agentsSrc);
  if (bundled.length === 0) return [];

  const flag = agentsFromArgs(args);
  if (flag !== null) {
    if (Array.isArray(flag)) return flag; // --no-agents
    if (/^all$/i.test(flag)) return bundled;
    const requested = flag.split(",").map((s) => s.trim()).filter(Boolean);
    const known = requested.filter((t) => bundled.includes(t));
    for (const t of requested.filter((t) => !bundled.includes(t))) {
      console.log(c.yellow(`  (skipping unknown agent "${t}")`));
    }
    return known;
  }

  if (!stdin.isTTY) {
    console.log(c.dim("\nNon-interactive (no TTY): installing required skills only; skipping agent picker."));
    console.log(c.dim("  Pass --agents <a,b,c> or --agents all to select agents non-interactively."));
    return [];
  }
  return pickAgents(bundled, agentsSrc);
}

/**
 * Provision anton's required skills (always) + the selected specialist agents into the user's
 * global ~/.claude, never overwriting existing files. Returns 0 (best-effort — a missing bundled
 * asset warns but doesn't fail setup, since anton also loads its own skills from the package dir).
 */
async function provisionAgentsSkills(args, opts = {}) {
  const claudeRoot = opts.claudeRoot ?? CLAUDE_ROOT;
  const skillsSrc = opts.skillsSrc ?? (opts.appRoot ? join(opts.appRoot, "skills") : SKILLS_SRC);
  const agentsSrc =
    opts.agentsSrc ?? (opts.appRoot ? join(opts.appRoot, "src", "prompts", "agents") : AGENTS_SRC);

  console.log(c.bold("\nInstalling agents & skills into ") + c.bold(claudeRoot) + c.dim(" (no-clobber):"));
  const selected = await resolveAgentSelection(args, agentsSrc);

  const jobs = [
    ...INSTALLED_SKILLS.map((name) => ({
      kind: "skill",
      name,
      required: true,
      src: join(skillsSrc, name), // a skill is a directory (SKILL.md + any bundled assets)
      dest: join(claudeRoot, "skills", name),
      // The SKILL.md is the presence sentinel for both the missing-source check and no-clobber.
      sentinel: join(skillsSrc, name, "SKILL.md"),
    })),
    ...selected.map((tag) => ({
      kind: "agent",
      name: tag,
      required: false,
      src: join(agentsSrc, `${tag}.md`),
      dest: join(claudeRoot, "agents", `${tag}.md`),
      sentinel: join(agentsSrc, `${tag}.md`),
    })),
  ];

  let installed = 0;
  let skipped = 0;
  for (const job of jobs) {
    if (!existsSync(job.sentinel)) {
      console.log(`  ${c.yellow("!")} ${job.kind} ${c.bold(job.name)} ${c.yellow("missing from package")} ${c.dim(job.src)}`);
      continue;
    }
    const outcome =
      job.kind === "skill" ? installSkillDir(job.src, job.dest) : installFile(job.src, job.dest);
    if (outcome === "installed") installed++;
    else skipped++;
    const tag = outcome === "installed" ? c.green("installed") : c.dim("already present");
    const req = job.required ? c.dim(" (required)") : "";
    console.log(`  ${outcome === "installed" ? c.green("✓") : "·"} ${job.kind.padEnd(5)} ${c.bold(job.name.padEnd(12))} ${tag}${req}`);
  }
  console.log(
    c.dim(`  → ${installed} installed, ${skipped} already present. Existing files are never overwritten.`),
  );
  return { installed, skipped, agents: selected };
}

// The Beads Dolt sync provisioning (anton-pns) lives in ../src/lib/beads/config.mjs as the single
// `configureBeadsDoltSync`, shared by `anton setup` (cmdSetup) and `anton init` (configureBeadsForRepo)
// so both wire the remote identically (anton-8qx). renderDoltSyncOutcome below renders its result.

// ── Bundle-mode migrations + daemon lifecycle (anton-1xp) ───────────────────────────────────

/**
 * Ensure better-sqlite3's native binary matches the RUNNING Node's ABI. It's a per-ABI addon (not
 * N-API), so a prebuilt bundle's binary is locked to the Node major it was built against; on a
 * machine with a different Node major it fails with a NODE_MODULE_VERSION error. We recover WITHOUT
 * a compiler by running the bundled `prebuild-install` to download the ABI-matched prebuilt binary.
 * Returns "ok" | "rebuilt". Non-ABI errors re-throw. (node-pty is N-API, so it needs no such fix.)
 */
function ensureBetterSqlite3(appRoot = APP_ROOT) {
  const require = createRequire(join(appRoot, "package.json"));
  // better-sqlite3 loads its native addon LAZILY — on first `new Database()`, not at require() —
  // so we must actually open a DB to surface an ABI mismatch (a bare require would falsely pass).
  const probe = () => new (require("better-sqlite3"))(":memory:").close();
  try {
    probe();
    return "ok";
  } catch (e) {
    const msg = String((e && e.message) || e);
    if (!/NODE_MODULE_VERSION|different Node\.js version|was compiled against/i.test(msg)) throw e;
    const bsqlDir = dirname(require.resolve("better-sqlite3/package.json"));
    const prebuild = join(appRoot, "node_modules", "prebuild-install", "bin.js");
    const manualFix = `run:  cd ${bsqlDir} && npm rebuild better-sqlite3`;
    if (!existsSync(prebuild)) {
      throw new Error(`better-sqlite3 was built for a different Node version and prebuild-install isn't bundled — ${manualFix}`);
    }
    console.log(c.yellow("  better-sqlite3 was built for a different Node — fetching a matching prebuilt binary…"));
    const r = spawnSync(process.execPath, [prebuild], { cwd: bsqlDir, stdio: "inherit" });
    if ((r.status ?? 1) !== 0) {
      throw new Error(`no prebuilt better-sqlite3 for Node ${process.version} on this platform — ${manualFix}`);
    }
    probe(); // re-verify the freshly downloaded binary actually opens (a failed addon load isn't cached)
    console.log(c.green("  ✓ better-sqlite3 binary now matches Node ") + process.version);
    return "rebuilt";
  }
}

/**
 * Apply the committed drizzle migration SQL directly via better-sqlite3 (a production dep), so a
 * prebuilt bundle needs no drizzle-kit (a devDep we don't ship). Idempotent: tracks applied files
 * in `__anton_migrations` and only runs new ones. Mirrors the SQL-splitting in src/lib/db/testing.ts.
 */
function applyMigrations(dbPath, opts = {}) {
  const appRoot = opts.appRoot ?? APP_ROOT;
  ensureBetterSqlite3(appRoot); // heal an ABI mismatch before the server (which also uses it) starts
  const require = createRequire(join(appRoot, "package.json"));
  const Database = require("better-sqlite3");
  mkdirSync(dirname(dbPath), { recursive: true });
  const sqlite = new Database(dbPath);
  try {
    sqlite.pragma("foreign_keys = ON");
    sqlite.exec("CREATE TABLE IF NOT EXISTS __anton_migrations (name TEXT PRIMARY KEY, applied_at INTEGER)");
    const applied = new Set(sqlite.prepare("SELECT name FROM __anton_migrations").all().map((r) => r.name));
    const dir = join(appRoot, "drizzle");
    const files = readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();
    let ran = 0;
    for (const file of files) {
      if (applied.has(file)) continue;
      const raw = readFileSync(join(dir, file), "utf8");
      const sql = raw.split("--> statement-breakpoint").map((s) => s.trim()).filter(Boolean).join(";\n");
      const tx = sqlite.transaction(() => {
        sqlite.exec(sql);
        sqlite.prepare("INSERT INTO __anton_migrations (name, applied_at) VALUES (?, ?)").run(file, Date.now());
      });
      tx();
      ran++;
    }
    return { ran, total: files.length };
  } finally {
    sqlite.close();
  }
}

/**
 * Apply any pending DB migrations before the server serves — so `anton start` never runs on a
 * stale schema and operators don't have to remember `anton setup`. Mirrors cmdSetup's branching:
 * a prebuilt bundle applies the committed SQL in-process (no drizzle-kit devDep is shipped), while
 * a source checkout uses drizzle-kit. Idempotent — a start with nothing pending is a clean no-op.
 * Throws on failure so the caller can abort rather than serve a stale schema. (The bundle DAEMON
 * path migrates in startDaemon; this covers source `start` and bundle `--foreground`.)
 */
function ensureMigrated(opts = {}) {
  const isBundle = opts.isBundle ?? IS_BUNDLE;
  if (isBundle) {
    const dbPath = opts.dbPath ?? bundleStateEnv().ANTON_DB;
    const { ran } = applyMigrations(dbPath, { appRoot: opts.appRoot });
    if (ran) console.log(c.dim(`applied ${ran} migration(s) → ${dbPath}`));
    return { ran };
  }
  // Source checkout: drizzle-kit tracks applied migrations in __drizzle_migrations, so re-running
  // with nothing pending is a no-op. A non-zero exit (bad SQL, unreachable DB) must fail start.
  const rc = runLocal("drizzle-kit", ["migrate"]);
  if (rc !== 0) throw new Error("drizzle-kit migrate failed — see output above");
  return { ran: null };
}

/** Daemonize `next start` from the bundle, redirecting output to the persistent state log dir. */
async function startDaemon(args) {
  const running = runningPid();
  const port = resolvePort(args) ?? "3000";
  if (running) {
    console.log(c.yellow("anton is already running") + c.dim(` (pid ${running}) → http://localhost:${port}`));
    return 0;
  }

  // Heal the native ABI + ensure the schema exists before the server touches the DB. If this fails
  // the server would only serve 500s (its every route needs better-sqlite3), so abort loudly here
  // rather than daemonize a broken process.
  const stateEnv = bundleStateEnv();
  try {
    const { ran } = applyMigrations(stateEnv.ANTON_DB);
    if (ran) console.log(c.dim(`applied ${ran} migration(s) → ${stateEnv.ANTON_DB}`));
  } catch (e) {
    console.log(c.red("\n✗ Cannot start: the database layer failed to initialize."));
    console.log(c.red(`  ${String(e.message ?? e)}`));
    console.log(c.dim("  (fix the above, then re-run `anton start`. This usually means a native-module ABI issue.)"));
    return 1;
  }

  mkdirSync(LOG_DIR, { recursive: true });
  const out = openSync(join(LOG_DIR, "stdout.log"), "a");
  const err = openSync(join(LOG_DIR, "stderr.log"), "a");

  // A standalone bundle runs its traced `server.js` (reads PORT/HOSTNAME from the env); a source
  // checkout falls back to the `next start` binary (-p flag). HOSTNAME is pinned explicitly so we
  // never inherit the shell's ambient $HOSTNAME (often the machine name) as a bind address.
  const standaloneServer = join(APP_ROOT, "server.js");
  const useStandalone = existsSync(standaloneServer);
  const spawnArgs = useStandalone
    ? [standaloneServer]
    : [join(APP_ROOT, "node_modules", "next", "dist", "bin", "next"), "start", "-p", String(port)];
  const child = spawn("node", spawnArgs, {
    cwd: APP_ROOT,
    detached: true,
    stdio: ["ignore", out, err],
    env: {
      ...process.env,
      NODE_ENV: "production",
      PORT: String(port),
      HOSTNAME: process.env.ANTON_HOST ?? "127.0.0.1",
      ...stateEnv,
    },
  });
  child.unref();
  mkdirSync(STATE_DIR, { recursive: true });
  writeFileSync(PID_FILE, String(child.pid));
  console.log(c.dim(`anton starting (pid ${child.pid})…`));

  const ready = await waitForReady(port);
  if (ready) {
    console.log(c.green("✓ anton is up") + ` → ${c.bold(`http://localhost:${port}`)}`);
  } else {
    console.log(c.yellow(`started (pid ${child.pid}) but not answering yet`) + c.dim(` — see ${join(LOG_DIR, "stderr.log")}`));
  }
  return 0;
}

/** Stop the running daemon (SIGTERM, then SIGKILL if it lingers). */
async function cmdStop() {
  const pid = runningPid();
  if (!pid) {
    console.log(c.dim("anton is not running."));
    return 0;
  }
  try { process.kill(pid, "SIGTERM"); } catch {}
  for (let i = 0; i < 20 && runningPid(); i++) await sleep(150); // up to ~3s grace
  if (runningPid()) {
    try { process.kill(pid, "SIGKILL"); } catch {}
  }
  try { unlinkSync(PID_FILE); } catch {}
  console.log(c.green("✓ anton stopped") + c.dim(` (pid ${pid})`));
  return 0;
}

/** Print install/runtime/state paths and whether the daemon is running. */
function cmdStatus(args) {
  const pid = runningPid();
  const port = resolvePort(args) ?? "3000";
  console.log(c.bold("anton status"));
  console.log(`  version   ${bundleVersion() ?? c.dim("(source checkout)")}`);
  console.log(`  runtime   ${APP_ROOT}`);
  console.log(`  state     ${STATE_DIR}`);
  if (pid) console.log(`  server    ${c.green("running")}${c.dim(` (pid ${pid}) → http://localhost:${port}`)}`);
  else console.log(`  server    ${c.dim("stopped")}`);
  return 0;
}

/** Fetch the latest GitHub release metadata for owner/repo (best-effort; returns null on failure). */
async function fetchLatestRelease() {
  const url = `https://api.github.com/repos/${RELEASE_OWNER}/${RELEASE_REPO}/releases/latest`;
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": "anton-cli", Accept: "application/vnd.github+json" },
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

/** Download the platform bundle for the newest release and swap the runtime dir in place. */
async function cmdUpdate() {
  if (!IS_BUNDLE) {
    console.log(c.yellow("`anton update` applies to an installed bundle only.") + c.dim(" (source checkout — use git.)"));
    return 1;
  }
  const current = bundleVersion();
  console.log(c.dim(`current version: ${current}. Checking ${RELEASE_OWNER}/${RELEASE_REPO}…`));
  const rel = await fetchLatestRelease();
  if (!rel || !rel.tag_name) {
    console.log(c.red("could not reach GitHub releases — try again later."));
    return 1;
  }
  const latest = String(rel.tag_name).replace(/^v/, "");
  if (compareVersions(latest, current) <= 0) {
    console.log(c.green(`✓ already up to date (v${current}).`));
    return 0;
  }
  const asset = (rel.assets ?? []).find((a) => a.name === `anton-${platformLabel()}.tar.gz`);
  if (!asset) {
    console.log(c.red(`no asset anton-${platformLabel()}.tar.gz in release ${rel.tag_name}.`));
    return 1;
  }

  console.log(c.dim(`downloading ${asset.name} (v${latest})…`));
  const tmp = join(INSTALL_ROOT, ".update");
  rmSync(tmp, { recursive: true, force: true });
  mkdirSync(tmp, { recursive: true });
  const tarball = join(tmp, asset.name);
  try {
    const res = await fetch(asset.browser_download_url, {
      headers: { "User-Agent": "anton-cli" },
      signal: AbortSignal.timeout(120000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    writeFileSync(tarball, Buffer.from(await res.arrayBuffer()));
  } catch (e) {
    console.log(c.red(`download failed: ${e.message ?? e}`));
    return 1;
  }

  const extractRc = spawnSync("tar", ["-xzf", tarball, "-C", tmp], { stdio: "inherit" }).status ?? 1;
  const extracted = join(tmp, `anton-${platformLabel()}`);
  if (extractRc !== 0 || !existsSync(extracted)) {
    console.log(c.red("extract failed."));
    return 1;
  }

  const wasRunning = !!runningPid();
  if (wasRunning) await cmdStop();

  const runtime = join(INSTALL_ROOT, "runtime");
  const backup = join(INSTALL_ROOT, "runtime.old");
  rmSync(backup, { recursive: true, force: true });
  if (existsSync(runtime)) spawnSync("mv", [runtime, backup], { stdio: "inherit" });
  spawnSync("mv", [extracted, runtime], { stdio: "inherit" });
  rmSync(backup, { recursive: true, force: true });
  rmSync(tmp, { recursive: true, force: true });
  console.log(c.green(`✓ updated ${current} → ${latest}.`));

  if (wasRunning) {
    console.log(c.dim("restarting…"));
    // Re-exec the freshly installed launcher so the new runtime serves.
    spawnSync("node", [join(runtime, "bin", "anton.mjs"), "start"], { stdio: "inherit" });
  }
  return 0;
}

/** Remove the installed runtime + launcher symlink. Keeps state unless --purge is passed. */
async function cmdUninstall(args = []) {
  if (!IS_BUNDLE) {
    console.log(c.yellow("`anton uninstall` applies to an installed bundle only."));
    return 1;
  }
  if (runningPid()) await cmdStop();
  rmSync(INSTALL_ROOT, { recursive: true, force: true });
  try { unlinkSync(BIN_LINK); } catch {}
  if (args.includes("--purge")) {
    rmSync(STATE_DIR, { recursive: true, force: true });
    console.log(c.green("✓ anton uninstalled") + c.dim(` (state purged: ${STATE_DIR})`));
  } else {
    console.log(c.green("✓ anton uninstalled."));
    console.log(c.dim(`  Your data was kept at ${STATE_DIR} — delete it manually, or re-run with --purge.`));
  }
  return 0;
}

/** Prereq check. Returns true when all *required* tools are present. */
function checkPrereqs() {
  console.log(c.bold("\nChecking prerequisites:"));
  let ok = true;
  for (const p of PREREQS) {
    const present = onPath(p.cmd);
    const tag = present
      ? c.green("found")
      : p.required
        ? c.red("MISSING")
        : c.yellow("missing");
    console.log(`  ${present ? "✓" : "✗"} ${p.cmd.padEnd(9)} ${tag}  ${c.dim(p.why)}`);
    if (!present && p.required) ok = false;
  }
  const node = process.versions.node.split(".").map(Number);
  const nodeOk = node[0] >= 20;
  console.log(
    `  ${nodeOk ? "✓" : "✗"} ${"node".padEnd(9)} ${nodeOk ? c.green(process.versions.node) : c.red(process.versions.node + " (need ≥20)")}`,
  );
  return ok && nodeOk;
}

/** Print anton's version — the bundle's RELEASE_VERSION when installed, else package.json. */
function cmdVersion() {
  let v = bundleVersion();
  if (!v) {
    try {
      v = JSON.parse(readFileSync(join(APP_ROOT, "package.json"), "utf8")).version;
    } catch {
      v = "unknown";
    }
  }
  console.log(v);
  return 0;
}

function cmdDoctor() {
  const ok = checkPrereqs();
  // Resolve the DB the same way the server does: in a bundle it lives in the persistent state dir
  // (where `anton setup` creates it), NOT under the runtime dir — so doctor must check there too.
  const dbPath = IS_BUNDLE ? bundleStateEnv().ANTON_DB : (process.env.ANTON_DB ?? join(APP_ROOT, "anton.db"));
  console.log(
    `  ${existsSync(dbPath) ? "✓" : c.yellow("·")} ${"anton.db".padEnd(9)} ${existsSync(dbPath) ? c.green(dbPath) : c.yellow("not created — run `anton setup`")}`,
  );
  console.log(ok ? c.green("\nAll required tools present.\n") : c.red("\nMissing required tools — install them, then re-run.\n"));
  return ok ? 0 : 1;
}

/**
 * Render the Dolt remote wiring outcome from the shared configureBeadsDoltSync (anton-8qx) for
 * `anton setup`. Consumes the unified result shape `{ status, url, pulled, pushed, pushOutput }`.
 * Returns `true` when setup may proceed, `false` when it must abort (no origin / failed remote add);
 * a failed push is NON-fatal — reported here, not aborted (first-time setup without push access
 * still wires the remote locally).
 */
function renderDoltSyncOutcome(dolt) {
  switch (dolt.status) {
    case "no-workspace":
      console.log(c.dim("  no .beads workspace at the package root — skipping."));
      return true;
    case "no-remote":
      console.log(c.red("  ✗ .beads exists but git has no `origin` remote — Dolt sync has nowhere to push."));
      console.log(c.dim("    Add one (git remote add origin <url>), then re-run `anton setup`."));
      return false;
    case "error":
      console.log(c.red(`  ✗ bd dolt remote add failed: ${dolt.detail}`));
      return false;
    case "already":
      console.log(`  · Dolt remote ${c.bold("origin")} already → ${dolt.url} ${c.dim("(unchanged)")}`);
      return true;
    case "configured":
      console.log(`  ${c.green("✓")} Dolt remote ${c.bold("origin")} → ${dolt.url}`);
      if (dolt.pulled) {
        console.log(`  ${c.green("✓")} bd dolt pull — board hydrated from refs/dolt/data`);
      } else {
        console.log(c.dim("  · bd dolt pull found nothing to hydrate (fine on a first-ever setup)"));
      }
      if (dolt.pushed) {
        console.log(`  ${c.green("✓")} bd dolt push — refs/dolt/data is on origin`);
      } else {
        console.log(c.yellow("  ! bd dolt push failed — once auth/network is available, run:"));
        console.log(c.dim("      bd dolt pull && bd dolt push"));
        const lastLine = (dolt.pushOutput ?? "").split("\n").filter(Boolean).at(-1);
        if (lastLine) console.log(c.dim(`    (${lastLine})`));
      }
      return true;
    default:
      return true;
  }
}

async function cmdSetup(args = []) {
  console.log(c.bold("anton setup"));
  const ok = checkPrereqs();
  if (!ok) {
    console.log(c.red("\nInstall the MISSING required tools above, then re-run `anton setup`.\n"));
    return 1;
  }

  if (IS_BUNDLE) {
    // Prebuilt bundle: no drizzle-kit (devDep) is shipped, so apply migrations in-process to the
    // PERSISTENT state DB, and skip the node-pty rebuild (it was built for this platform already).
    const dbPath = bundleStateEnv().ANTON_DB;
    console.log(c.bold("\nApplying database migrations:") + c.dim(` ${dbPath}`));
    try {
      const { ran, total } = applyMigrations(dbPath);
      console.log(c.dim(`  ${ran} applied, ${total - ran} already current.`));
    } catch (e) {
      console.log(c.red(`migration failed: ${e.message ?? e}`));
      return 1;
    }
  } else {
    console.log(c.bold("\nApplying database migrations (drizzle-kit migrate):"));
    const migrated = runLocal("drizzle-kit", ["migrate"]);
    if (migrated !== 0) {
      console.log(c.red("migration failed — see output above."));
      return migrated;
    }

    // node-pty ships prebuilts that don't always match the local node ABI (DESIGN setup note).
    // Rebuild it best-effort so the interactive xterm works; a failure here is a warning, not fatal.
    console.log(c.bold("\nRebuilding node-pty for this node ABI:"));
    const rebuilt = spawnSync("npm", ["rebuild", "node-pty"], { cwd: APP_ROOT, stdio: "inherit" });
    if ((rebuilt.status ?? 1) !== 0) {
      console.log(c.yellow("node-pty rebuild skipped/failed — interactive sessions may not work until you run:"));
      console.log(c.dim("  cd node_modules/node-pty && npx node-gyp rebuild"));
    }
  }

  await provisionAgentsSkills(args);

  // Beads Dolt sync (anton-pns): the Dolt remote is per-machine (gitignored) state, so every
  // machine re-applies it here; the first push publishes refs/dolt/data to the git remote.
  console.log(c.bold("\nConfiguring beads Dolt sync (git origin ↔ refs/dolt):"));
  const dolt = configureBeadsDoltSync({ repoDir: APP_ROOT });
  // A push failure is non-fatal + reported (anton-8qx); only a missing origin or a failed remote
  // add is fatal for `anton setup` (there's nothing to push to / the remote isn't wired).
  if (!renderDoltSyncOutcome(dolt)) return 1;

  console.log(c.green("\n✓ Setup complete.") + " Next: " + c.bold("anton start") + c.dim(" (or `anton dev`)\n"));
  return 0;
}

// ── Per-project init (anton init — anton-9bo / anton-uez) ────────────────────────────────────
// `anton init <repo>` does two things: (1) enforce anton's committed beads team-config so the
// executor can drive its board deterministically, and (2) register the repo with anton so it shows
// on the projects board. Prereqs (bd + git repo + origin remote) fail loud with the fix. The
// beads-config path is shared with `addProject` (src/lib/beads/config.mjs) so a repo configured here
// and one added through the UI/API converge to the SAME end state — `bd init` (when absent) →
// config.yaml enforcement → .beads/.gitignore → [Dolt remote wiring, anton-43b]. Every step is
// idempotent, so a re-run — or a run on an already-configured/registered repo — is a no-op.

/** Parse `anton init` args: first bare token is the target path; `--prefix <p>` / `-p <p>` the bd prefix. */
function parseInitArgs(args) {
  let path = null;
  let prefix = null;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--prefix" || a === "-p") {
      prefix = args[++i] ?? null;
      continue;
    }
    const m = a.match(/^(?:--prefix|-p)=(.*)$/);
    if (m) {
      prefix = m[1];
      continue;
    }
    if (a.startsWith("-")) continue; // unknown flag — ignore
    if (path === null) path = a;
  }
  return { path, prefix };
}

/** The anton.db the server reads — env override, else the persistent state dir (bundle) / APP_ROOT. */
function resolveAntonDb() {
  if (process.env.ANTON_DB) return process.env.ANTON_DB;
  return IS_BUNDLE ? join(STATE_DIR, "anton.db") : join(APP_ROOT, "anton.db");
}

/** The repo's current branch, defaulting to "main" (mirrors detectDefaultBranch in projects.ts). */
function detectRepoDefaultBranch(dir) {
  const r = spawnSync("git", ["-C", dir, "symbolic-ref", "--short", "HEAD"], { encoding: "utf8" });
  return (r.stdout ?? "").trim() || "main";
}

/** Slugify a name the same way projects.ts's toSlug does. */
function slugify(input) {
  return input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

// Mirror of DEFAULT_SCHEDULES in src/lib/schedules.ts — kept in sync manually (the pure-node CLI
// can't import the TS). Seeded with next_run_at = now so the scheduler fires each once on its next
// tick and then advances to the real cron slot; the same three rows addProject seeds via drizzle.
const DEFAULT_SCHEDULE_DEFS = [
  { type: "review-fix", cron: "*/15 * * * *" },
  { type: "nightly-stringer", cron: "0 3 * * *" },
  { type: "orphan-grooming", cron: "0 4 * * 1" },
];

/**
 * Register `dir` in anton.db so it appears on the projects board (anton-uez). The pure-node CLI
 * can't import the TypeScript addProject, so — like applyMigrations — it writes anton.db directly
 * via better-sqlite3, producing an equivalent projects row + default schedules. Idempotent by
 * repo_path: re-registering an existing repo doesn't duplicate the project, but DOES backfill any
 * missing default schedules (self-heal for projects registered before seeding existed, anton-mxy).
 * Returns { ok, created, slug, backfilled } or { ok:false, error } — a registration failure is
 * surfaced by the caller but never undoes the beads config.
 */
function registerProject(dir, opts = {}) {
  const appRoot = opts.appRoot ?? APP_ROOT;
  const dbPath = opts.dbPath ?? resolveAntonDb();
  try {
    applyMigrations(dbPath, { appRoot }); // ensure anton.db exists + schema is current (idempotent)
    const require = createRequire(join(appRoot, "package.json"));
    const Database = require("better-sqlite3");
    const db = new Database(dbPath);
    try {
      db.pragma("foreign_keys = ON");
      const repoPath = resolve(dir);
      const nowSec = Math.floor(Date.now() / 1000);

      // NOT EXISTS guard makes schedule seeding idempotent per (project, type) — matching ensureSchedule.
      const insertSchedule = db.prepare(
        "INSERT INTO schedules (id, project_id, type, cron, enabled, next_run_at) " +
          "SELECT ?, ?, ?, ?, 1, ? WHERE NOT EXISTS " +
          "(SELECT 1 FROM schedules WHERE project_id = ? AND type = ?)",
      );
      /** Seed any missing default schedules for a project; returns how many rows were added. */
      const seedSchedules = (projectId) => {
        let added = 0;
        for (const s of DEFAULT_SCHEDULE_DEFS) {
          added += insertSchedule.run(randomUUID(), projectId, s.type, s.cron, nowSec, projectId, s.type).changes;
        }
        return added;
      };

      const existing = db.prepare("SELECT id, slug FROM projects WHERE repo_path = ?").get(repoPath);
      if (existing) {
        // Self-heal: a project registered before schedule seeding existed (or one that lost a
        // default to an older version) has no rows to enqueue its background jobs. Backfill the
        // missing defaults — idempotent, so a fully-seeded project stays a no-op.
        const backfilled = db.transaction(() => seedSchedules(existing.id))();
        return { ok: true, created: false, slug: existing.slug, backfilled };
      }

      // Unique slug from the repo basename (matches addProject's toSlug + uniqueSlug).
      const base = slugify(basename(repoPath)) || "project";
      const taken = new Set(db.prepare("SELECT slug FROM projects").all().map((r) => r.slug));
      let slug = base;
      for (let n = 2; taken.has(slug); n++) slug = `${base}-${n}`;

      const id = randomUUID();
      const branch = detectRepoDefaultBranch(repoPath);
      const insertProject = db.prepare(
        "INSERT INTO projects (id, slug, name, repo_path, default_branch) VALUES (?, ?, ?, ?, ?)",
      );
      const backfilled = db.transaction(() => {
        insertProject.run(id, slug, basename(repoPath), repoPath, branch);
        return seedSchedules(id);
      })();
      return { ok: true, created: true, slug, backfilled };
    } finally {
      db.close();
    }
  } catch (e) {
    return { ok: false, error: String(e?.message ?? e) };
  }
}

/**
 * Render the Dolt remote wiring outcome (from configureBeadsDoltSync). Every status branch is
 * handled so `anton init` reports exactly what happened — configured, a no-op re-run, a skip when
 * prereqs are absent, or a loud failure with the underlying detail (anton-43b).
 */
function renderDoltSync(sync) {
  if (!sync) return;
  switch (sync.status) {
    case "configured":
      if (sync.pushed === false) {
        // Push is non-fatal + reported (anton-8qx): the remote is wired locally, just not published.
        console.log(c.green("✓ Dolt remote wired") + c.dim(` — origin (${sync.url})`));
        console.log(c.yellow("! bd dolt push failed — run `bd dolt pull && bd dolt push` once auth/network is available."));
        const lastLine = (sync.pushOutput ?? "").split("\n").filter(Boolean).at(-1);
        if (lastLine) console.log(c.dim(`  (${lastLine})`));
      } else {
        console.log(c.green("✓ Dolt remote wired") + c.dim(` — refs/dolt/data published to origin (${sync.url})`));
      }
      break;
    case "already":
      console.log(c.dim("• Dolt remote already configured — nothing to do."));
      break;
    case "no-remote":
      console.log(c.yellow("! no origin remote — skipped Dolt remote wiring.") + c.dim(" beads syncs over the git remote."));
      break;
    case "no-workspace":
      console.log(c.yellow("! no .beads/ workspace — skipped Dolt remote wiring."));
      break;
    case "error":
      console.log(c.yellow(`! Dolt remote wiring failed: ${sync.detail}`));
      console.log(c.dim("  beads is configured; retry with `bd dolt remote add origin <url>` then `bd dolt push`."));
      break;
  }
}

/**
 * Note when a git-hooks manager (husky/lefthook) or a custom core.hooksPath owns the repo's hooks:
 * bd's post-merge/post-checkout Dolt HYDRATION won't fire under it. For an anton-driven repo that
 * is the DESIRABLE outcome, so this is reassurance, not a warning (anton-43b, anton-vqgw).
 *
 * anton used to print steps for chaining `bd hooks run post-merge` back in. That advice was wrong:
 * hydration is redundant here (the runner pushes Dolt explicitly on every write) and it is
 * destructive — an inbound import replaces local rows from an older snapshot, so a bead closed
 * after that snapshot silently reverts to open. Repos that followed the old advice saw closed
 * epics flip back to open across merges. Never recommend chaining the hydration hooks.
 */
function renderHooksWarning(warning) {
  if (!warning) return;
  console.log(
    c.green(`\n✓ git hooks are managed by ${warning.manager}`) +
      c.dim(` (${warning.path}) — bd's hydration hooks won't run under it.`),
  );
  console.log(c.dim("  That's what you want. anton pushes Dolt explicitly on every write, so inbound"));
  console.log(c.dim("  hydration is redundant — and it can revert beads you already closed by replaying"));
  console.log(c.dim("  an older snapshot over them. Do NOT chain `bd hooks run post-merge/post-checkout`."));
  console.log(c.dim("  Export/push hooks (pre-commit, pre-push) are safe to chain if you want them."));
}

async function cmdInit(args = []) {
  const { path: rawPath, prefix } = parseInitArgs(args);
  const dir = resolve(rawPath ?? process.cwd());
  console.log(c.bold("anton init") + c.dim(` ${dir}`));

  // Prereqs — fail loud, each with the fix (shared with addProject's self-heal gate).
  const pre = beadsPrereqs(dir);
  if (!pre.ok) {
    console.log(c.red(`\n✗ ${pre.error.message}`));
    if (pre.error.fix) console.log(c.dim(`  ${pre.error.fix}`));
    return 1;
  }

  // Enforce beads team-config via the shared config path (bd init when absent → config.yaml → .gitignore).
  const beads = configureBeadsForRepo(dir, { prefix, log: (m) => console.log(c.dim(`  ${m}`)) });
  if (!beads.configured) {
    console.log(c.red("\n✗ beads config failed — see output above."));
    return 1;
  }
  for (const e of beads.errors) console.log(c.yellow(`  ${e}`));
  console.log(c.green("\n✓ beads team-config enforced.") + c.dim(` (${dir})`));

  // Dolt remote wiring outcome — render every status branch, matching cmdSetup (anton-43b).
  renderDoltSync(beads.doltSync);

  // Hooks are optional for anton-driven repos (runDoltSync() pushes Dolt explicitly on every write).
  // Under a husky/lefthook hooksPath only post-merge/post-checkout HYDRATION is lost, which is a
  // good thing here — hydration can replay an older snapshot over beads closed since (anton-vqgw).
  renderHooksWarning(beads.hooksWarning);

  // Register with anton so the repo shows on the projects board — in the same command (anton-uez).
  const reg = registerProject(dir);
  if (reg.ok) {
    const backfill =
      !reg.created && reg.backfilled > 0
        ? c.green(` — backfilled ${reg.backfilled} missing schedule${reg.backfilled === 1 ? "" : "s"}`)
        : "";
    console.log(
      (reg.created ? c.green("✓ registered with anton") : c.dim("• already registered")) +
        c.dim(` — project "${reg.slug}"`) +
        backfill,
    );
  } else {
    console.log(c.yellow(`\n! could not register with anton: ${reg.error}`));
    console.log(c.dim("  beads is configured; run `anton setup`, then add the repo from the UI."));
  }

  console.log("");
  return 0;
}

function cmdDev(args) {
  console.log(c.dim("anton dev — starting Next.js dev server (runner + scheduler auto-start)…"));
  return runLocal("next", nextArgs("dev", args));
}

async function cmdStart(args) {
  // Installed bundle: run as a background daemon (foolery-style) unless --foreground is passed.
  // (startDaemon applies pending migrations before spawning the server.)
  if (IS_BUNDLE && !args.includes("--foreground")) {
    return startDaemon(args);
  }

  // Apply pending migrations before serving so start never runs on a stale schema and operators
  // don't have to remember `anton setup`. Fail loud — a stale-schema server would only serve 500s.
  try {
    ensureMigrated();
  } catch (e) {
    console.log(c.red("\n✗ Cannot start: database migrations failed."));
    console.log(c.red(`  ${String(e.message ?? e)}`));
    console.log(c.dim("  (fix the above, then re-run `anton start`.)"));
    return 1;
  }

  const built = existsSync(join(APP_ROOT, ".next"));
  if (!built) {
    console.log(c.dim("no build found — running `next build` first…"));
    const b = runLocal("next", ["build"]);
    if (b !== 0) return b;
  }
  console.log(c.dim("anton start — starting Next.js server (runner + scheduler auto-start)…"));
  // In bundle mode the server's writable state — including the DB getDb() opens — must point at
  // STATE_DIR (the same env startDaemon passes), so it opens the DB ensureMigrated() just migrated
  // rather than falling back to a stray anton.db under the cwd. Source checkouts resolve their own DB.
  const serverEnv = IS_BUNDLE ? bundleStateEnv() : {};
  return runLocal("next", nextArgs("start", args), serverEnv);
}

const USAGE = `${c.bold("anton")} — local autonomous-coding orchestrator

${c.bold("Usage:")} anton <command>

  ${c.bold("setup")}    check prereqs, migrate DB, rebuild node-pty, install agents & skills, wire beads Dolt sync  ${c.dim("[--agents <a,b,c>|all]")}
  ${c.bold("init")}     configure beads in a target repo + register it with anton  ${c.dim("[path] [--prefix <p>]")}
  ${c.bold("doctor")}   check prereqs + anton.db (non-destructive)
  ${c.bold("dev")}      run the dev server (next dev)          ${c.dim("[--port <n>]")}
  ${c.bold("start")}    run the server ${c.dim("(installed: background; source: foreground)")}  ${c.dim("[--port <n>] [--foreground]")}
  ${c.bold("stop")}     stop the background server             ${c.dim("(installed bundle)")}
  ${c.bold("status")}   show version, paths, and whether the server is running
  ${c.bold("update")}   download & install the latest release  ${c.dim("(installed bundle)")}
  ${c.bold("uninstall")} remove the installed runtime + launcher ${c.dim("[--purge] (keeps data by default)")}
  ${c.bold("version")}  print the anton version ${c.dim("(alias --version, -v)")}
  ${c.bold("--help")}   show this help

${c.dim("Port: dev/start default to 3000; override with --port <n> (alias -p) or PORT=<n>.")}
The runner + scheduler start automatically with the server (set ANTON_RUNNER=off to disable).
`;

function main(argv) {
  const cmd = argv[2];
  const rest = argv.slice(3);
  switch (cmd) {
    case "setup":
      return cmdSetup(rest);
    case "init":
      return cmdInit(rest);
    case "doctor":
      return cmdDoctor();
    case "dev":
      return cmdDev(rest);
    case "start":
      return cmdStart(rest);
    case "stop":
      return cmdStop();
    case "status":
      return cmdStatus(rest);
    case "update":
    case "upgrade":
      return cmdUpdate();
    case "uninstall":
      return cmdUninstall(rest);
    case "version":
    case "--version":
    case "-v":
      return cmdVersion();
    case "-h":
    case "--help":
    case "help":
    case undefined:
      console.log(USAGE);
      return cmd === undefined ? 1 : 0;
    default:
      console.log(c.red(`unknown command: ${cmd}`));
      console.log(USAGE);
      return 1;
  }
}

// Run only when invoked as a script (`anton …`), not when imported by tests. The bin is reached
// through a symlink (node_modules/.bin or ~/.bun/bin), so compare realpaths.
const invokedDirectly =
  process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) Promise.resolve(main(process.argv)).then((code) => process.exit(code ?? 0));

export {
  resolvePort,
  nextArgs,
  main,
  parseInitArgs,
  ensureBeadsGitignore,
  registerProject,
  resolveAntonDb,
  agentsFromArgs,
  provisionAgentsSkills,
  REQUIRED_SKILLS,
  INSTALLED_SKILLS,
  compareVersions,
  platformLabel,
  applyMigrations,
  ensureMigrated,
  ensureBetterSqlite3,
};
