#!/usr/bin/env node
/**
 * anton CLI (anton-hji) — the turn-key entry point, shipped via package.json `bin`. Like foolery,
 * anton is a local Next.js server; this launcher bootstraps and runs it from the installed package
 * dir (NOT the user's cwd), so `anton` works from anywhere once installed (`npm i -g` / `bunx`).
 *
 *   anton setup    prereq checks → drizzle migrate (creates/updates anton.db) → node-pty rebuild
 *   anton doctor   prereq checks only (non-destructive)
 *   anton dev      next dev  (runner + scheduler auto-start via src/instrumentation.ts)
 *   anton start    next build (if stale) → next start
 *   anton --help   usage
 *
 * Pure Node, zero deps. Native ESM.
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
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

function cmdSetup() {
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

  console.log(c.green("\n✓ Setup complete.") + " Next: " + c.bold("anton start") + c.dim(" (or `anton dev`)\n"));
  return 0;
}

function cmdDev() {
  console.log(c.dim("anton dev — starting Next.js dev server (runner + scheduler auto-start)…"));
  return runLocal("next", ["dev"]);
}

function cmdStart() {
  const built = existsSync(join(APP_ROOT, ".next"));
  if (!built) {
    console.log(c.dim("no build found — running `next build` first…"));
    const b = runLocal("next", ["build"]);
    if (b !== 0) return b;
  }
  console.log(c.dim("anton start — starting Next.js server (runner + scheduler auto-start)…"));
  return runLocal("next", ["start"]);
}

const USAGE = `${c.bold("anton")} — local autonomous-coding orchestrator

${c.bold("Usage:")} anton <command>

  ${c.bold("setup")}    check prereqs, run DB migrations, rebuild node-pty
  ${c.bold("doctor")}   check prereqs + anton.db (non-destructive)
  ${c.bold("dev")}      run the dev server (next dev)
  ${c.bold("start")}    build if needed, then run the server (next start)
  ${c.bold("--help")}   show this help

The runner + scheduler start automatically with the server (set ANTON_RUNNER=off to disable).
`;

function main(argv) {
  const cmd = argv[2];
  switch (cmd) {
    case "setup":
      return cmdSetup();
    case "doctor":
      return cmdDoctor();
    case "dev":
      return cmdDev();
    case "start":
      return cmdStart();
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

process.exit(main(process.argv));
