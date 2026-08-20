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
 *   anton server-mode  point ONE project's board at a shared Dolt server: back up → write
 *                  .beads/metadata.json → bd dolt test → read the board back → publish the
 *                  connection as the team default (reverts the write on any failure)
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
  bdVersion,
  bdVersionAtLeast,
  checkSharedServer,
  configureBeadsDoltSync,
  configureBeadsForRepo,
  ensureBeadFormula,
  ensureBeadsGitignore,
  ensureRunFormula,
  formatServerTarget,
  hasBeadsDir,
  passwordVarHint,
  readDoltMetadata,
  BEAD_FORMULA_FILENAME,
  RUN_FORMULA_FILENAME,
  MIN_BD_VERSION,
} from "../src/lib/beads/config.mjs";
import { configureServerMode, SERVER_MIGRATION_RUNBOOK } from "../src/lib/beads/server-mode.mjs";
import { buildStructureReport, formatStructureReport } from "../src/lib/beads/tiers.mjs";
import { listFiles, skillState } from "../src/lib/claude/skill-stamp.mjs";
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

// ── Agents & skills provisioning (anton setup + anton init) ─────────────────────────────────
// The authoritative installer (anton-jvsd), dependency-free so the launcher stays pure Node and
// runs before any build. Two install targets, chosen by the caller's `claudeRoot`: `anton setup`
// provisions the GLOBAL ~/.claude (discoverable from every repo), while `anton init` provisions a
// project's own <repo>/.claude/ (project scope wins when `claude` runs there). The invariant is that
// no local WORK is ever overwritten: an agent prompt (yours to tune) and an edited skill are left
// exactly as they are, while a skill copy whose version stamp proves it untouched is re-synced from
// the bundle (see installSkillDir). Keep REQUIRED_SKILLS / INSTALLED_SKILLS in sync
// with src/lib/claude/prompt.ts — the launcher must stay pure Node (no TS import), so the lists are
// duplicated here and pinned equal by a cross-list assertion in bin/anton.test.ts. A skill anton's
// runtime loads but the installer never copies is a job that dies on a missing SKILL.md.
const AGENTS_SRC = join(APP_ROOT, "src", "prompts", "agents");
const SKILLS_SRC = join(APP_ROOT, "skills");
const REQUIRED_SKILLS = ["shape", "bd", "scan-triage", "review-fix", "review", "product-master"];
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

/**
 * Remove now-empty subdirectories under `root` (never `root` itself), depth-first. Cosmetic only —
 * the digest lists files, so an empty `templates/` left by a refresh would not affect any verdict,
 * but it reads as debris in a directory the user browses.
 */
function pruneEmptyDirs(root) {
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const abs = join(root, entry.name);
    pruneEmptyDirs(abs);
    if (readdirSync(abs).length === 0) rmSync(abs, { recursive: true, force: true });
  }
}

/**
 * Install a whole skill DIRECTORY (SKILL.md + any bundled assets, e.g. setup's templates/).
 *
 * No-clobber is right for a file a user tunes and wrong for one anton's runtime reads as a contract:
 * a skill installed once used to stay frozen at that release forever, with every later `anton setup`
 * printing "already present" over it (anton-tier-invariants — a three-week-old `/shape` shaped
 * against a taxonomy the bundle had already replaced). The `version:` stamp every shipped skill
 * carries (src/lib/claude/skill-stamp.mjs) is what makes the difference actionable: it says whether
 * the installed copy is untouched (anton's to refresh) or hand-edited (the user's to keep).
 *
 *   "installed" — nothing was there; the whole skill was written.
 *   "skipped"   — present and byte-identical to the bundle. Nothing to do.
 *   "refreshed" — present, different, and PRISTINE (stamp matches its own content) — some other
 *                 release's copy with no local work in it. Re-synced from the bundle, and reported.
 *   "stale"     — present, different, and either hand-edited or pre-stamp. Left untouched and the
 *                 caller warns with the fix; only `force` overwrites it.
 *   "updated"   — as "stale", but `force` was set: every drifted bundled file overwritten. Files the
 *                 user added that the bundle doesn't ship are left alone.
 *
 * A refresh also DELETES files the bundle no longer ships, which `force` deliberately does not: only
 * on the refresh path does the pristine stamp prove those leftovers are an older bundle's rather
 * than the user's. Leaving them would keep the refreshed copy's own digest off the stamp it just
 * received, so it would read as hand-edited from then on and never auto-refresh again.
 */
function installSkillDir(srcDir, destDir, { force = false } = {}) {
  const { state, drifted, extra } = skillState(srcDir, destDir);
  if (state === "missing") {
    for (const rel of drifted) installFile(join(srcDir, rel), join(destDir, rel));
    return "installed";
  }
  if (state === "current") return "skipped";
  if (state !== "outdated" && !force) return "stale";
  for (const rel of drifted) {
    const dest = join(destDir, rel);
    mkdirSync(dirname(dest), { recursive: true });
    copyFileSync(join(srcDir, rel), dest);
  }
  if (state === "outdated") {
    for (const rel of extra) rmSync(join(destDir, rel), { force: true });
    pruneEmptyDirs(destDir);
  }
  return state === "outdated" ? "refreshed" : "updated";
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
 * global ~/.claude (or, from `anton init`, a repo's own .claude/). Agents and any file carrying
 * local work are never overwritten; a skill copy left behind by another release IS refreshed, since
 * its version stamp proves nothing of the user's is in it (installSkillDir). Best-effort — a missing
 * bundled asset warns but doesn't fail setup, since anton also loads its skills from the package dir.
 */
async function provisionAgentsSkills(args, opts = {}) {
  const claudeRoot = opts.claudeRoot ?? CLAUDE_ROOT;
  const skillsSrc = opts.skillsSrc ?? (opts.appRoot ? join(opts.appRoot, "skills") : SKILLS_SRC);
  const agentsSrc =
    opts.agentsSrc ?? (opts.appRoot ? join(opts.appRoot, "src", "prompts", "agents") : AGENTS_SRC);

  // `--force-skills` re-syncs installed SKILLS to the bundled copies. Deliberately not the default
  // and deliberately not `--force`: it discards local edits, and it is the answer to the stale-skill
  // warning below rather than something a routine setup should do behind the user's back.
  const force = args.includes("--force-skills");
  console.log(
    c.bold("\nInstalling agents & skills into ") +
      c.bold(claudeRoot) +
      c.dim(force ? " (--force-skills: skills re-synced from bundle):" : " (edited files kept):"),
  );
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
  let updated = 0;
  const stale = [];
  const refreshed = [];
  for (const job of jobs) {
    if (!existsSync(job.sentinel)) {
      console.log(`  ${c.yellow("!")} ${job.kind} ${c.bold(job.name)} ${c.yellow("missing from package")} ${c.dim(job.src)}`);
      continue;
    }
    // Only skills are drift-checked. An agent prompt is exactly the file a user is meant to tune, so
    // reporting their edits as staleness would nag them for using the product as intended; a skill
    // is a runtime contract anton's own jobs read, so a stale one is a real defect.
    const outcome =
      job.kind === "skill" ? installSkillDir(job.src, job.dest, { force }) : installFile(job.src, job.dest);
    if (outcome === "installed") installed++;
    else if (outcome === "updated") updated++;
    else if (outcome === "refreshed") refreshed.push(job.name);
    else if (outcome === "stale") stale.push(job.name);
    else skipped++;
    const marks = {
      installed: [c.green("✓"), c.green("installed")],
      updated: [c.green("↑"), c.green("updated from bundle")],
      refreshed: [c.green("↻"), c.green("refreshed — was another release's copy")],
      stale: [c.yellow("!"), c.yellow("differs from bundle — left as-is")],
      skipped: ["·", c.dim("already present")],
    };
    const [mark, tag] = marks[outcome];
    const req = job.required ? c.dim(" (required)") : "";
    console.log(`  ${mark} ${job.kind.padEnd(5)} ${c.bold(job.name.padEnd(12))} ${tag}${req}`);
  }
  const counts = [
    `${installed} installed`,
    ...(refreshed.length > 0 ? [c.green(`${refreshed.length} refreshed`)] : []),
    ...(updated > 0 ? [`${updated} updated`] : []),
    `${skipped} already current`,
    ...(stale.length > 0 ? [c.yellow(`${stale.length} stale`)] : []),
  ].join(", ");
  console.log(c.dim(`  → ${counts}. Your own edits are never overwritten.`));
  if (refreshed.length > 0) {
    console.log(
      c.green(`  ↻ ${refreshed.join(", ")} re-synced from the bundle`) +
        c.dim(" — those copies were untouched (their version stamp\n") +
        c.dim("    matched their content), so they carried no edits to lose."),
    );
  }
  if (stale.length > 0) {
    console.log(
      c.yellow(`  ! ${stale.join(", ")} differ from the bundled version`) +
        c.dim(" — and carry edits (or predate version stamps), so\n") +
        c.dim("    anton won't touch them. A stale copy shapes work against rules this release has\n") +
        c.dim("    replaced. Re-run with ") +
        c.bold("--force-skills") +
        c.dim(" to overwrite (your edits are lost)."),
    );
  }
  return { installed, skipped, updated, stale, refreshed, agents: selected };
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

/** First non-empty GitHub token from the env (anton-specific wins, then the standard names). */
function githubToken() {
  for (const name of ["ANTON_GITHUB_TOKEN", "GH_TOKEN", "GITHUB_TOKEN"]) {
    const v = process.env[name];
    if (v && v.trim()) return v.trim();
  }
  return null;
}

/** Auth header for GitHub requests when a token is set (never logged). */
function githubAuthHeader() {
  const token = githubToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

/**
 * Fetch the latest GitHub release metadata for owner/repo.
 * Returns a discriminated result: `{ release }` on success, or `{ error }` describing the cause
 * (`rate_limit` with reset epoch seconds, `timeout`, `not_found`, `http` with status, `network`).
 */
async function fetchLatestRelease() {
  const url = `https://api.github.com/repos/${RELEASE_OWNER}/${RELEASE_REPO}/releases/latest`;
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": "anton-cli", Accept: "application/vnd.github+json", ...githubAuthHeader() },
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) {
      // GitHub signals rate-limit exhaustion with 403/429 + x-ratelimit-remaining: 0.
      if ((res.status === 403 || res.status === 429) && res.headers.get("x-ratelimit-remaining") === "0") {
        const reset = Number(res.headers.get("x-ratelimit-reset"));
        return { error: { kind: "rate_limit", reset: Number.isFinite(reset) ? reset : null } };
      }
      if (res.status === 404) return { error: { kind: "not_found" } };
      return { error: { kind: "http", status: res.status } };
    }
    return { release: await res.json() };
  } catch (e) {
    if (e?.name === "TimeoutError") return { error: { kind: "timeout" } };
    return { error: { kind: "network", message: e?.message ?? String(e) } };
  }
}

/** Render a fetchLatestRelease `error` object as a user-facing line. */
function describeReleaseError(error) {
  switch (error.kind) {
    case "rate_limit": {
      const when = error.reset ? new Date(error.reset * 1000).toLocaleString() : "later";
      const hint = githubToken() ? "" : " Set ANTON_GITHUB_TOKEN (or GH_TOKEN/GITHUB_TOKEN) to raise the limit.";
      return `GitHub API rate limit exceeded — resets at ${when}.${hint}`;
    }
    case "timeout":
      return "request to GitHub timed out — try again later.";
    case "not_found":
      return `no releases found for ${RELEASE_OWNER}/${RELEASE_REPO}.`;
    case "http":
      return `GitHub returned HTTP ${error.status}.`;
    default:
      return `could not reach GitHub releases — ${error.message ?? "try again later."}`;
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
  const result = await fetchLatestRelease();
  if (result.error) {
    console.log(c.red(describeReleaseError(result.error)));
    return 1;
  }
  const rel = result.release;
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
      headers: { "User-Agent": "anton-cli", ...githubAuthHeader() },
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
    // bd is version-gated: anton requires >= 1.1.0 (anton-qwsq). A present-but-too-old bd fails the
    // required check just like a missing one, with the version and the upgrade guidance.
    const v = present && p.cmd === "bd" ? bdVersion() : null;
    const bdTooOld = present && p.cmd === "bd" && !bdVersionAtLeast(v);
    const tag = !present
      ? p.required
        ? c.red("MISSING")
        : c.yellow("missing")
      : bdTooOld
        ? c.red(`${v ? v.raw : "unknown"} — need >= ${MIN_BD_VERSION}`)
        : c.green(p.cmd === "bd" && v ? `found ${v.raw}` : "found");
    console.log(`  ${present && !bdTooOld ? "✓" : "✗"} ${p.cmd.padEnd(9)} ${tag}  ${c.dim(p.why)}`);
    if ((!present || bdTooOld) && p.required) ok = false;
  }
  const node = process.versions.node.split(".").map(Number);
  const nodeOk = node[0] >= 20;
  console.log(
    `  ${nodeOk ? "✓" : "✗"} ${"node".padEnd(9)} ${nodeOk ? c.green(process.versions.node) : c.red(process.versions.node + " (need ≥20)")}`,
  );
  return ok && nodeOk;
}

/**
 * Is the board this command runs against actually readable? Reported alongside the tool prereqs, and
 * only meaningful in SERVER mode: an embedded board is a local Dolt directory, so there is nothing
 * to reach and nothing to say. A shared-server board keeps no local copy, which makes an unreachable
 * server a board outage rather than stalled sync (DESIGN.md §3a) — so it is probed with `bd dolt
 * test` and the failure names the configured target and both ways out.
 *
 * Returns true when the board is fine OR the question does not apply (no `.beads/`, embedded mode),
 * so only a genuinely unreachable server fails the caller.
 */
function checkBoard(dir = process.cwd()) {
  if (!hasBeadsDir(dir)) return true;
  const board = readDoltMetadata(dir);
  if (board.mode !== "server") return true;

  const target = formatServerTarget(board);
  const probe = checkSharedServer(dir, board);
  if (probe.ok) {
    console.log(`  ${c.green("✓")} ${"board".padEnd(9)} ${c.green(`shared Dolt server ${target} reachable`)}  ${c.dim("bd dolt test")}`);
    return true;
  }
  console.log(`  ${c.red("✗")} ${"board".padEnd(9)} ${c.red(`shared Dolt server ${target} UNREACHABLE`)}  ${c.dim("bd dolt test")}`);
  // bd's own failure is often several lines (its config warnings ride along); indent every one, so
  // the cause reads as part of this report rather than as stray output.
  for (const line of probe.detail.split("\n")) console.log(c.dim(`    ${line}`));
  console.log(c.dim(`    Start the server (or restore the route to ${target}), check .beads/metadata.json`));
  console.log(c.dim(`    names the right host/port/user, and set ${passwordVarHint(board.user)} in this shell.`));
  console.log(c.dim('    Or set "dolt_mode": "embedded" there to work from this machine\'s local copy meanwhile.'));
  return false;
}

/** One `bd list` in `repo`, always JSON and never truncated (bd caps at 50 by default). */
function bdList(repo, extra) {
  return spawnSync("bd", ["-C", repo, "list", ...extra, "--json", "--limit", "0"], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
}

/** bd's listing as an array, or null when this build's output can't be parsed. */
function parseBoard(stdout) {
  try {
    const parsed = JSON.parse(stdout || "[]");
    // bd omits the key entirely on an empty board rather than emitting [].
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return null;
  }
}

/**
 * The WHOLE board — closed beads included, because container-ness is read off the parent graph and
 * an epic whose only feature child is closed still strands its loose tickets.
 *
 * `--status all` first, then the fallback the app already relies on: some bd builds reject that
 * flag, and `src/lib/beads/issues.ts` treats it as a supported CLI variation by merging the default
 * open listing with `--status closed`. This checker is invoked from `/shape`'s mandatory Phase 5, so
 * without the same fallback it would fail there having checked nothing.
 *
 * Returns `{ board }` or `{ error }` — never both.
 */
function readBoard(repo) {
  const all = bdList(repo, ["--status", "all"]);
  // bd missing altogether is not a flag problem, and there is no point retrying: `spawnSync` reports
  // ENOENT on `error` with a NULL `stderr`, so reporting stderr alone printed a bare "bd list
  // failed" and left a user without bd installed with nothing to act on.
  if (all.error) {
    return {
      error:
        all.error.code === "ENOENT"
          ? "bd not found on PATH — install it with `brew install gastownhall/tap/bd`"
          : all.error.message,
    };
  }
  if (all.status === 0) {
    const board = parseBoard(all.stdout);
    return board ? { board } : { error: "bd returned output this build can't parse." };
  }

  const [open, closed] = [bdList(repo, []), bdList(repo, ["--status", "closed"])];
  const failed = [open, closed].some((r) => r.error || r.status !== 0);
  // Report the ORIGINAL failure: the fallback is a guess about which bd this is, and if it fails too
  // the useful message is why `--status all` was refused, not why the second guess was.
  if (failed) return { error: (all.stderr ?? "").trim() || `bd list exited ${all.status}` };

  const listings = [parseBoard(open.stdout), parseBoard(closed.stdout)];
  if (listings.some((l) => l === null)) return { error: "bd returned output this build can't parse." };
  const byId = new Map();
  for (const bead of listings.flat()) if (!byId.has(bead.id)) byId.set(bead.id, bead);
  return { board: [...byId.values()] };
}

/**
 * `anton board-check [path...]` — every live bead whose place in `epic → feature → ticket` is wrong.
 *
 * The mechanical half of `/shape`'s Phase 5, and it lives on the CLI rather than in an npm script
 * for one reason: `/shape` runs inside the USER's repo, from an installed bundle that ships no
 * TypeScript and no package scripts. A `npm run …` in the skill would have resolved against
 * whatever `package.json` that repo happens to have (anton-i4al). The judgement itself is
 * `src/lib/beads/tiers.mjs`, shared byte-for-byte with the approve gate — the command and the gate
 * cannot disagree.
 *
 * Exit code is the point: non-zero means the board carries a DEAD bead — one no run target and no
 * ticket sweep will ever reach. Advisory faults (a feature with no epic, with no tickets, past its
 * ticket budget) print and exit 0; they cost later, they do not strand work.
 *
 * Read-only: it never writes a bead. Repair is authoring work — the report names the bead in the
 * wrong place and the command that moves it, never what the right shape of the work is.
 */
function cmdBoardCheck(args) {
  const paths = args.filter((a) => !a.startsWith("-"));
  const repos = paths.length > 0 ? paths.map((p) => resolve(p)) : [process.cwd()];

  let blocking = 0;
  for (const repo of repos) {
    if (!hasBeadsDir(repo)) {
      console.error(c.red(`No .beads/ at ${repo}`) + c.dim(" — run `anton init` there, or pass a repo path."));
      return 1;
    }
    const { board, error } = readBoard(repo);
    if (error) {
      console.error(c.red(`bd list failed in ${repo}`) + c.dim(`\n${error}`));
      return 1;
    }

    const report = buildStructureReport(board);
    blocking += report.blocking;
    console.log(formatStructureReport(report, repos.length > 1 ? repo : ""));
    console.log("");
  }
  return blocking > 0 ? 1 : 0;
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

/**
 * Which installed skills differ from the bundled ones, checked at BOTH scopes anton installs into:
 * the global ~/.claude (every repo resolves it) and this repo's own .claude/ (which wins locally).
 * A skill is a runtime contract — a copy frozen at an old release keeps shaping work against rules
 * the bundle has replaced, and until now nothing ever said so out loud (anton-tier-invariants).
 * Returns `[{ scope, name, state, installed, bundled }]` — `state` is the skill-stamp verdict
 * ("outdated" | "modified" | "unstamped"), which is what decides whether a refresh is anton's call
 * or the user's. Empty when everything is current or nothing is installed. Read-only by
 * construction: doctor reports drift, it never writes a skill file.
 *
 * Both roots are injectable so this can be exercised against fixture directories — matching
 * `provisionAgentsSkills`, which already takes `opts.claudeRoot`. `cmdDoctor` passes neither and
 * gets the real ones; without the seam the only way to test drift detection was to `chdir` the
 * process. `projectRoot` defaults at CALL time rather than module load, because `process.cwd()` is
 * what "this repo" means for the command being run.
 */
function staleSkills(skillsSrc = SKILLS_SRC, { claudeRoot = CLAUDE_ROOT, projectRoot = process.cwd() } = {}) {
  const scopes = [
    ["global", claudeRoot],
    ["project", join(projectRoot, ".claude")],
  ];
  const out = [];
  for (const [scope, root] of scopes) {
    for (const name of INSTALLED_SKILLS) {
      const src = join(skillsSrc, name);
      const dest = join(root, "skills", name);
      if (!existsSync(join(src, "SKILL.md")) || !existsSync(join(dest, "SKILL.md"))) continue;
      const { state, installed, bundled } = skillState(src, dest);
      if (state !== "current") out.push({ scope, name, state, installed, bundled });
    }
  }
  return out;
}

function cmdDoctor() {
  const ok = checkPrereqs();
  const stale = staleSkills();
  if (stale.length === 0) {
    console.log(`  ${c.green("✓")} ${"skills".padEnd(9)} ${c.green("installed copies match the bundle")}`);
  } else {
    // A user-level ~/.claude copy is the dangerous one: every plain `claude` session in every repo
    // resolves it, so a pre-tier copy there silently reintroduces retired conventions (anton-gsyh).
    // Doctor names each drift and its fix — and mutates nothing, at either scope.
    for (const { scope, name, state, installed, bundled } of stale) {
      const why = {
        outdated: `is another release's copy (${installed} → ${bundled}) — untouched, so a refresh loses nothing`,
        modified: `differs from the bundled version and carries local edits`,
        unstamped: `differs from the bundled version and predates version stamps`,
      }[state];
      console.log(`  ${c.yellow("!")} ${"skills".padEnd(9)} ${c.yellow(`${name} (${scope}) ${why}`)}`);
    }
    const scopeFix = (scope) => (scope === "global" ? "anton setup" : "anton init");
    if (stale.some((s) => s.state === "outdated")) {
      const cmds = [...new Set(stale.filter((s) => s.state === "outdated").map((s) => scopeFix(s.scope)))];
      console.log(c.dim(`    Refresh untouched copies by re-running \`${cmds.join("` / `")}\` — no flag needed.`));
    }
    if (stale.some((s) => s.state !== "outdated")) {
      console.log(
        c.dim("    anton won't overwrite an edited (or pre-stamp) copy. Adopt this release's with\n") +
          c.dim("    `anton setup --force-skills` (global) or `anton init --force-skills` (this repo);\n") +
          c.dim("    skip it if the difference is your own deliberate edit — forcing discards it."),
      );
    }
  }
  // Resolve the DB the same way the server does: in a bundle it lives in the persistent state dir
  // (where `anton setup` creates it), NOT under the runtime dir — so doctor must check there too.
  const dbPath = IS_BUNDLE ? bundleStateEnv().ANTON_DB : (process.env.ANTON_DB ?? join(APP_ROOT, "anton.db"));
  console.log(
    `  ${existsSync(dbPath) ? "✓" : c.yellow("·")} ${"anton.db".padEnd(9)} ${existsSync(dbPath) ? c.green(dbPath) : c.yellow("not created — run `anton setup`")}`,
  );
  // Last, because it is the only check that leaves the machine: a board on a shared server that
  // nothing here can reach is as fatal as a missing tool, and doctor is where an operator looks first.
  // Gated on the tool check: probing a board with no usable bd would report an "unreachable server"
  // whose real cause is the missing tool named two lines above.
  const boardOk = ok ? checkBoard() : true;
  if (!ok) console.log(c.red("\nMissing required tools — install them, then re-run.\n"));
  else if (!boardOk) console.log(c.red("\nThis repo's board is on a shared Dolt server this machine can't reach — see above.\n"));
  else console.log(c.green("\nAll required tools present.\n"));
  return ok && boardOk ? 0 : 1;
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
    case "server-mode":
      // Not a degradation: a shared-server board has no refs/dolt/data to wire (anton-4gd2).
      console.log(c.dim("  board is on a shared Dolt server — no refs/dolt/data remote to wire."));
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
      } else if (dolt.firstPublish) {
        // Loud: a failed FIRST publish leaves the remote EMPTY — the next clone has nothing to
        // bootstrap from. Non-fatal (local wiring is done) but never silent.
        console.log(c.red(`  ✗ bd dolt push failed after ${dolt.pushAttempts} attempts — origin has NO refs/dolt/data yet (empty remote).`));
        console.log(c.dim("    Nothing can bootstrap from this remote until you publish. Once auth/network is up, run:"));
        console.log(c.dim("      bd dolt pull && bd dolt push"));
        const lastLine = (dolt.pushOutput ?? "").split("\n").filter(Boolean).at(-1);
        if (lastLine) console.log(c.dim(`    (${lastLine})`));
      } else {
        console.log(c.yellow(`  ! bd dolt push failed after ${dolt.pushAttempts} attempts — once auth/network is available, run:`));
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

  // anton's formulas: the bead skeleton every bead anton creates is rendered from (anton-8mnr) and
  // the run pipeline anton walks (anton-hrql). Both live in the repo's `.beads/`, so a project-local
  // copy always wins and a re-run never clobbers it.
  // Only lands when the package root already IS a beads workspace (anton's own dev checkout) — a
  // release bundle has none, and the installers refuse to fabricate one there (the Dolt-sync step
  // below reads a bare `.beads/` as a workspace and would abort setup for having no git origin).
  // Registered projects get their formulas from configureBeadsForRepo (`anton init` / addProject),
  // which is the path shaping and the run pipeline actually read.
  for (const asset of [
    { label: "Bead formula", filename: BEAD_FORMULA_FILENAME, install: ensureBeadFormula },
    { label: "Run formula", filename: RUN_FORMULA_FILENAME, install: ensureRunFormula },
  ]) {
    const formula = asset.install(join(APP_ROOT, ".beads"));
    if (formula.status === "missing-asset") {
      console.log(c.yellow(`\n! ${asset.label.toLowerCase()} missing from this install — skipping ${asset.filename}.`));
    } else if (formula.status === "failed") {
      // Best-effort, like the missing asset above: setup carries on and anton falls back to its
      // packaged copy, so an unwritable `.beads/formulas/` is a warning, not a failed setup.
      console.log(c.yellow(`\n! could not install the ${asset.label.toLowerCase()}: ${formula.detail}`));
    } else if (formula.status !== "no-workspace") {
      console.log(
        c.bold(`\n${asset.label}:`) +
          ` .beads/formulas/${asset.filename} ` +
          (formula.status === "installed" ? c.green("installed") : c.dim("already present")),
      );
    }
  }

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
        // A failed FIRST publish leaves the remote EMPTY (nothing for the next clone to bootstrap
        // from), so surface that case LOUD (red) rather than as a routine retry note.
        console.log(c.green("✓ Dolt remote wired") + c.dim(` — origin (${sync.url})`));
        if (sync.firstPublish) {
          console.log(c.red(`✗ bd dolt push failed after ${sync.pushAttempts} attempts — origin has NO refs/dolt/data yet (empty remote).`));
          console.log(c.dim("  Nothing can bootstrap from this remote until you publish. Once auth/network is up, run:"));
          console.log(c.dim("    bd dolt pull && bd dolt push"));
        } else {
          console.log(c.yellow(`! bd dolt push failed after ${sync.pushAttempts} attempts — run \`bd dolt pull && bd dolt push\` once auth/network is available.`));
        }
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
    case "server-mode":
      console.log(c.dim("• board is on a shared Dolt server — no refs/dolt/data remote to wire."));
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

/** The bundled `.product/` templates `/setup` scaffolds — they travel with the `setup` skill dir. */
const PRODUCT_TEMPLATES_SRC = join(SKILLS_SRC, "setup", "templates", ".product");

/**
 * Scaffold `.product/` into `dir` from the bundled templates so `/shape` and `/scan-triage` — which
 * read a project-local `.product/` layer before doing anything — aren't left in a vacuum after
 * `anton init`. No-clobber and idempotent (skips any file that already exists), mirroring how the
 * `/setup` skill generates the same layer; a re-run or a repo that already ran `/setup` is a no-op.
 * Returns `{ created: string[], skipped: string[], missing: boolean }` (missing → templates absent).
 */
function scaffoldProductDir(dir) {
  if (!existsSync(PRODUCT_TEMPLATES_SRC)) return { created: [], skipped: [], missing: true };
  const destRoot = join(dir, ".product");
  const created = [];
  const skipped = [];
  for (const rel of listFiles(PRODUCT_TEMPLATES_SRC)) {
    const status = installFile(join(PRODUCT_TEMPLATES_SRC, rel), join(destRoot, rel));
    (status === "installed" ? created : skipped).push(rel);
  }
  return { created, skipped, missing: false };
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
  // Naming the profile makes the board's mode visible where it was applied — a server-mode repo
  // enforces a connection, not the refs/dolt/data knobs, and the two shouldn't look alike.
  const profile = beads.mode === "server" ? "shared Dolt server board" : "embedded board";
  console.log(c.green("\n✓ beads team-config enforced.") + c.dim(` (${dir} — ${profile})`));

  // Dolt remote wiring outcome — render every status branch, matching cmdSetup (anton-43b).
  renderDoltSync(beads.doltSync);

  // Hooks are optional for anton-driven repos (runDoltSync() pushes Dolt explicitly on every write).
  // Under a husky/lefthook hooksPath only post-merge/post-checkout HYDRATION is lost, which is a
  // good thing here — hydration can replay an older snapshot over beads closed since (anton-vqgw).
  renderHooksWarning(beads.hooksWarning);

  // Scaffold the project-local .product/ layer so /shape and /scan-triage have the contract they
  // read — same layer /setup generates, no-clobber so an existing one (or a prior /setup) is kept.
  const product = scaffoldProductDir(dir);
  if (product.missing) {
    console.log(c.yellow("! .product/ templates not found — run /setup to scaffold the project layer."));
  } else if (product.created.length) {
    console.log(c.green("✓ scaffolded .product/") + c.dim(` — ${product.created.length} file${product.created.length === 1 ? "" : "s"} (run /setup to fill PRODUCT.md)`));
  } else {
    console.log(c.dim("• .product/ already present — left untouched."));
  }

  // Install anton's required skills (+ any --agents selection) into the repo's OWN .claude/ so
  // `claude` resolves them at project scope when it runs here — not just the global ~/.claude that
  // `anton setup` provisions (anton-jvsd). Best-effort: a missing bundled asset or a user-modified
  // file is left untouched (an untouched older copy is refreshed, anton-gsyh), and a skills-install
  // hiccup never fails an otherwise-good beads init.
  try {
    await provisionAgentsSkills(args, { claudeRoot: join(dir, ".claude") });
  } catch (e) {
    console.log(c.yellow(`\n! could not install skills into ${join(dir, ".claude")}: ${String(e?.message ?? e)}`));
    console.log(c.dim("  beads is configured; run `anton setup` to install anton's skills globally."));
  }

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

// ── Per-project server mode (anton server-mode — anton-yvjd) ─────────────────────────────────
// Points ONE project's board at a shared `dolt sql-server` and proves the switch: back up, write
// `.beads/metadata.json`, `bd dolt test`, confirm the board reads back whole, publish the connection
// as the team default. The judgement lives in src/lib/beads/server-mode.mjs; this is its terminal.
//
// It configures the connection — it does NOT move the data. Copying an existing board's Dolt
// history onto the server is docs/runbooks/embedded-board-to-shared-dolt-server.md, which a human
// runs; this command is what makes that copy safe to point at (and refuses when it hasn't happened).

/** The flags `server-mode` accepts — one source for `--help` and for the unknown-flag refusal. */
const SERVER_MODE_FLAGS =
  "[path] --host <h> [--port <n>] [--user <u>] --database <db> [--tls|--no-tls] [--no-backup] [--force]";

/**
 * Parse `anton server-mode` args: the first bare token is the target repo (default: cwd), the rest
 * name the connection. `--flag <v>` and `--flag=<v>` both work, matching parseInitArgs. Anything
 * else lands in `unknown`, a value flag left without a value lands in `missing`, and a second bare
 * token lands in `extra` — the command refuses on any of the three rather than running a half-read
 * connection or an ambiguous target.
 */
function parseServerModeArgs(args) {
  const VALUE_FLAGS = {
    "--host": "host",
    "--port": "port",
    "--user": "user",
    "--database": "database",
    "--db": "database",
  };
  const out = {
    path: null,
    host: null,
    port: null,
    user: null,
    database: null,
    // Undefined, not false: only a project that DECLARES a transport gets one written, so a repo
    // configured before `--tls` existed keeps inheriting the ambient BEADS_DOLT_SERVER_TLS.
    tls: undefined,
    backup: true,
    force: false,
    unknown: [],
    missing: [],
    extra: [],
  };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--no-backup") {
      out.backup = false;
      continue;
    }
    if (a === "--force") {
      out.force = true;
      continue;
    }
    if (a === "--tls" || a === "--no-tls") {
      out.tls = a === "--tls";
      continue;
    }
    const eq = a.match(/^(--[a-z-]+)=(.*)$/);
    const flag = eq ? eq[1] : a;
    const key = VALUE_FLAGS[flag];
    if (key) {
      const value = eq ? eq[2] : args[i + 1];
      // A value flag with nothing usable behind it is a typo, not an omission — and it must not read
      // as one: resolveServerConnection falls back to the repo's existing metadata for every field
      // left null, so a trailing `--database` would verify and publish the OLD database and still
      // exit 0 (PR #174 review). The next token is left unconsumed when it is itself a flag, so it
      // still gets parsed on its own terms.
      if (value === undefined || value === "" || (!eq && value.startsWith("-"))) {
        out.missing.push(flag);
        continue;
      }
      out[key] = value;
      if (!eq) i++;
      continue;
    }
    // A typo is collected, never ignored: on a repo that already carries a connection, ignoring
    // `--hots new-host` would verify and publish the OLD host and still exit 0 (PR #174 review).
    if (a.startsWith("-")) {
      out.unknown.push(flag);
      continue;
    }
    // A second bare token is an ambiguous target, not a spare word. Keeping the first would rewrite
    // and verify ONE repo's board connection while the operator named two, and still exit 0
    // (PR #174 review) — so every extra positional is collected and the command refuses.
    if (out.path === null) out.path = a;
    else out.extra.push(a);
  }
  return out;
}

/** Keep a multi-line tool message inside the report's left margin instead of breaking out of it. */
const indent = (text) => String(text).split("\n").join("\n  ");

/** How each step status prints. Anything unrecognised prints plainly rather than being swallowed. */
const SERVER_MODE_MARKS = {
  ok: () => c.green("✓"),
  set: () => c.green("✓"),
  written: () => c.green("✓"),
  already: () => c.dim("·"),
  unset: () => c.dim("·"),
  skipped: () => c.dim("·"),
  reverted: () => c.yellow("↩"),
  failed: () => c.red("✗"),
  missing: () => c.red("✗"),
  unreadable: () => c.red("✗"),
};

async function cmdServerMode(args = []) {
  const parsed = parseServerModeArgs(args);
  const malformed = [
    parsed.unknown.length ? `unknown flag${parsed.unknown.length === 1 ? "" : "s"} ${parsed.unknown.join(", ")}` : null,
    parsed.missing.length ? `missing value for ${parsed.missing.join(", ")}` : null,
    parsed.extra.length
      ? `unexpected argument${parsed.extra.length === 1 ? "" : "s"} ${parsed.extra.join(", ")} (one repo path at a time)`
      : null,
  ].filter(Boolean);
  if (malformed.length) {
    for (const m of malformed) console.log(c.red(`anton server-mode: ${m}`));
    console.log(c.dim(`  usage: anton server-mode ${SERVER_MODE_FLAGS}\n`));
    return 1;
  }
  const dir = resolve(parsed.path ?? process.cwd());
  console.log(c.bold("anton server-mode") + c.dim(` ${dir}`));

  // Steps print as they happen: an export plus two round trips to the server is long enough that a
  // batched render reads as a hang. bd's own output is multi-line — its first line is the headline,
  // the rest is repeated in full under the error below, where the reader is actually looking.
  const renderStep = (s) => {
    const mark = (SERVER_MODE_MARKS[s.status] ?? (() => c.dim("·")))();
    const lines = String(s.detail ?? "").split("\n").filter(Boolean);
    const detail = lines.length ? `${lines[0]}${lines.length > 1 ? " …" : ""}` : "";
    console.log(`  ${mark} ${s.name}${detail ? c.dim(` — ${detail}`) : c.dim(` (${s.status})`)}`);
  };

  const result = configureServerMode(dir, parsed, {
    log: (m) => console.log(c.dim(`    ${m}`)),
    onStep: renderStep,
  });

  if (!result.ok) {
    console.log(c.red("\n✗ this project was NOT switched to server mode."));
    for (const e of result.errors) console.log(c.red(`  ${indent(e)}`));
    for (const h of result.hints ?? []) console.log(c.dim(`  → ${h}`));
    // The two arrived-whole guards are the failures with a runbook behind them: the server is fine,
    // the data simply is not on it yet — or the copy that is on it predates this board.
    if (result.missing?.length || result.stale?.length) {
      console.log(c.dim("  → copy the board's Dolt history onto the server first:"));
      console.log(c.dim(`    ${SERVER_MIGRATION_RUNBOOK}`));
    }
    console.log("");
    return 1;
  }

  const { host, port, user, database, tls } = result.connection;
  const transport = tls === undefined ? "" : tls ? " over TLS" : " without TLS";
  console.log(
    c.green("\n✓ server mode configured.") +
      c.dim(` ${user ? `${user}@` : ""}${host}:${port}/${database}${transport}`),
  );
  if (result.counts?.after !== undefined) console.log(c.dim(`  board reads ${result.counts.after} issues from the server.`));
  if (result.backup?.path) console.log(c.dim(`  pre-switch backup: ${result.backup.path}`));
  console.log(
    c.dim("  Next: run the same command on every other machine (the connection travels in config.yaml,\n" +
      "        the password does not — set it in each shell), then `anton start`.\n"),
  );
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

  ${c.bold("setup")}    check prereqs, migrate DB, rebuild node-pty, install/refresh agents & skills, wire beads Dolt sync  ${c.dim("[--agents <a,b,c>|all] [--force-skills]")}
  ${c.bold("init")}     configure beads in a target repo + register it with anton  ${c.dim("[path] [--prefix <p>] [--force-skills]")}
  ${c.bold("server-mode")} point ONE project's board at a shared Dolt server + verify it  ${c.dim(SERVER_MODE_FLAGS)}
  ${c.bold("doctor")}   check prereqs + anton.db + stale skills (non-destructive)
  ${c.bold("board-check")} report beads that break epic → feature → ticket  ${c.dim("[path...] (default: cwd)")}
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
    case "board-check":
      return cmdBoardCheck(rest);
    case "server-mode":
      return cmdServerMode(rest);
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
  parseServerModeArgs,
  ensureBeadsGitignore,
  registerProject,
  resolveAntonDb,
  agentsFromArgs,
  provisionAgentsSkills,
  installSkillDir,
  staleSkills,
  REQUIRED_SKILLS,
  INSTALLED_SKILLS,
  compareVersions,
  platformLabel,
  fetchLatestRelease,
  applyMigrations,
  ensureMigrated,
  ensureBetterSqlite3,
};
