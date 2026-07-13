#!/usr/bin/env node
/**
 * anton CLI (anton-hji) — the turn-key entry point, shipped via package.json `bin`. Like foolery,
 * anton is a local Next.js server; this launcher bootstraps and runs it from the installed package
 * dir (NOT the user's cwd), so `anton` works from anywhere once installed (`npm i -g` / `bunx`).
 *
 *   anton setup    prereq checks → drizzle migrate (creates/updates anton.db) → node-pty rebuild →
 *                  install required skills + selected agents into global ~/.claude (interactive;
 *                  `--agents <a,b,c>` / `--agents all` / `--no-agents` for non-interactive/CI)
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
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
/** The anton package root = parent of bin/. All commands run here, not in the user's cwd. */
const APP_ROOT = join(__dirname, "..");
const BIN = join(APP_ROOT, "node_modules", ".bin");

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
// overwritten. Keep REQUIRED_SKILLS in sync with REQUIRED_SKILLS in src/lib/claude/prompt.ts.
const AGENTS_SRC = join(APP_ROOT, "src", "prompts", "agents");
const SKILLS_SRC = join(APP_ROOT, "skills");
const REQUIRED_SKILLS = ["shape", "bd", "scan-triage", "review-fix"];
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
    ...REQUIRED_SKILLS.map((name) => ({
      kind: "skill",
      name,
      required: true,
      src: join(skillsSrc, name, "SKILL.md"),
      dest: join(claudeRoot, "skills", name, "SKILL.md"),
    })),
    ...selected.map((tag) => ({
      kind: "agent",
      name: tag,
      required: false,
      src: join(agentsSrc, `${tag}.md`),
      dest: join(claudeRoot, "agents", `${tag}.md`),
    })),
  ];

  let installed = 0;
  let skipped = 0;
  for (const job of jobs) {
    if (!existsSync(job.src)) {
      console.log(`  ${c.yellow("!")} ${job.kind} ${c.bold(job.name)} ${c.yellow("missing from package")} ${c.dim(job.src)}`);
      continue;
    }
    const outcome = installFile(job.src, job.dest);
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

function cmdDoctor() {
  const ok = checkPrereqs();
  const dbPath = process.env.ANTON_DB ?? join(APP_ROOT, "anton.db");
  console.log(
    `  ${existsSync(dbPath) ? "✓" : c.yellow("·")} ${"anton.db".padEnd(9)} ${existsSync(dbPath) ? c.green(dbPath) : c.yellow("not created — run `anton setup`")}`,
  );
  console.log(ok ? c.green("\nAll required tools present.\n") : c.red("\nMissing required tools — install them, then re-run.\n"));
  return ok ? 0 : 1;
}

async function cmdSetup(args = []) {
  console.log(c.bold("anton setup"));
  const ok = checkPrereqs();
  if (!ok) {
    console.log(c.red("\nInstall the MISSING required tools above, then re-run `anton setup`.\n"));
    return 1;
  }

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

  await provisionAgentsSkills(args);

  console.log(c.green("\n✓ Setup complete.") + " Next: " + c.bold("anton start") + c.dim(" (or `anton dev`)\n"));
  return 0;
}

function cmdDev(args) {
  console.log(c.dim("anton dev — starting Next.js dev server (runner + scheduler auto-start)…"));
  return runLocal("next", nextArgs("dev", args));
}

function cmdStart(args) {
  const built = existsSync(join(APP_ROOT, ".next"));
  if (!built) {
    console.log(c.dim("no build found — running `next build` first…"));
    const b = runLocal("next", ["build"]);
    if (b !== 0) return b;
  }
  console.log(c.dim("anton start — starting Next.js server (runner + scheduler auto-start)…"));
  return runLocal("next", nextArgs("start", args));
}

const USAGE = `${c.bold("anton")} — local autonomous-coding orchestrator

${c.bold("Usage:")} anton <command>

  ${c.bold("setup")}    check prereqs, migrate DB, rebuild node-pty, install agents & skills  ${c.dim("[--agents <a,b,c>|all]")}
  ${c.bold("doctor")}   check prereqs + anton.db (non-destructive)
  ${c.bold("dev")}      run the dev server (next dev)          ${c.dim("[--port <n>]")}
  ${c.bold("start")}    build if needed, then run the server   ${c.dim("[--port <n>]")}
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
    case "doctor":
      return cmdDoctor();
    case "dev":
      return cmdDev(rest);
    case "start":
      return cmdStart(rest);
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

export { resolvePort, nextArgs, main, agentsFromArgs, provisionAgentsSkills, REQUIRED_SKILLS };
