/**
 * Reusable beads team-config for a target repo (anton-uez). The single config path shared by the
 * `anton init` CLI (bin/anton.mjs) and `addProject` (src/lib/projects.ts) so a repo configured from
 * the terminal and one added through the UI/API converge to the SAME end state: bd init (when
 * absent) → config.yaml enforcement → .beads/.gitignore → [Dolt remote wiring — anton-43b].
 *
 * Plain JS, node built-ins only (fs + child_process), so it imports cleanly from both the pure-node
 * CLI and the TypeScript server. See DESIGN.md §3 (beads is the work source of truth).
 *
 * The correct team-config is the Dolt-first model (issues live in Dolt, synced over refs/dolt/data;
 * the JSONL is a passive export): dolt.auto-commit "on", export.git-add false, and a .gitignore that
 * keeps the derived exports + Dolt runtime state out of git.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

/** True when `cmd` answers on PATH (probes --version/--help, then `command -v`). */
export function onPath(cmd) {
  for (const probe of [["--version"], ["--help"]]) {
    const r = spawnSync(cmd, probe, { stdio: "ignore" });
    if (!r.error && (r.status === 0 || r.status === 1)) return true;
  }
  const r = spawnSync("sh", ["-c", `command -v ${cmd}`], { stdio: "ignore" });
  return r.status === 0;
}

/** True when `dir` is inside a git work tree. */
export function isGitWorkTree(dir) {
  const r = spawnSync("git", ["-C", dir, "rev-parse", "--is-inside-work-tree"], { stdio: "ignore" });
  return r.status === 0;
}

/** True when `dir`'s repo has an `origin` remote configured. */
export function hasOriginRemote(dir) {
  const r = spawnSync("git", ["-C", dir, "remote", "get-url", "origin"], { stdio: "ignore" });
  return r.status === 0;
}

/** True when `dir` already carries a beads workspace (`.beads/`). */
export function hasBeadsDir(dir) {
  return existsSync(join(dir, ".beads"));
}

/**
 * Check the prereqs beads config needs (bd on PATH, an existing git repo with an origin remote).
 * Returns { ok } or { ok:false, error:{ message, fix } } — the CLI renders the fix loudly; the
 * self-heal path (addProject) uses it to skip cleanly on a repo that can't be configured (e.g. a
 * plain directory with no git), never corrupting the projects row.
 */
export function beadsPrereqs(dir) {
  if (!onPath("bd")) {
    return {
      ok: false,
      error: {
        message: "bd not found on PATH — beads is anton's work source of truth.",
        fix: "Install it, then re-run: https://github.com/gastownhall/beads",
      },
    };
  }
  if (!existsSync(dir)) {
    return { ok: false, error: { message: `no such directory: ${dir}`, fix: null } };
  }
  if (!isGitWorkTree(dir)) {
    return {
      ok: false,
      error: { message: `${dir} is not a git repository.`, fix: `git -C ${dir} init` },
    };
  }
  if (!hasOriginRemote(dir)) {
    return {
      ok: false,
      error: {
        message: `no "origin" remote in ${dir} — beads syncs its Dolt data over the git remote.`,
        fix: `git -C ${dir} remote add origin <url>`,
      },
    };
  }
  return { ok: true };
}

/** The `.beads/.gitignore` entries anton's team-config requires: derived exports + Dolt runtime state. */
export const BEADS_GITIGNORE_ENTRIES = ["issues.jsonl", "interactions.jsonl", "dolt/", "embeddeddolt/"];

/**
 * Idempotently ensure `.beads/.gitignore` untracks the JSONL exports + Dolt runtime state. Appends
 * only the missing entries (never clobbers existing lines/content) and creates the file if absent.
 * Returns { path, added } — `added` is empty on a no-op.
 */
export function ensureBeadsGitignore(beadsDir, entries = BEADS_GITIGNORE_ENTRIES) {
  const path = join(beadsDir, ".gitignore");
  let existing = "";
  try {
    existing = readFileSync(path, "utf8");
  } catch {
    existing = "";
  }
  const present = new Set(existing.split("\n").map((l) => l.trim()));
  const added = entries.filter((e) => !present.has(e));
  if (added.length === 0) return { path, added };

  const header = "# anton: beads exports are derived from Dolt — never commit them";
  const sep = existing.length === 0 ? "" : existing.endsWith("\n") ? "\n" : "\n\n";
  writeFileSync(path, existing + sep + header + "\n" + added.join("\n") + "\n");
  return { path, added };
}

/**
 * True when `.beads/config.yaml` carries an *uncommented* `key: value` matching `want` (surrounding
 * quotes tolerated, e.g. `dolt.auto-commit: "on"`). We check the FILE — not `bd config get` — because
 * the team-config must be committed to config.yaml to travel to every clone; `bd config get` also
 * reflects the Dolt DB (where `bd init --dolt-auto-commit on` lands it), which is not portable.
 */
export function configYamlHas(beadsDir, key, want) {
  let text = "";
  try {
    text = readFileSync(join(beadsDir, "config.yaml"), "utf8");
  } catch {
    return false;
  }
  const esc = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`^\\s*${esc}:\\s*(.+?)\\s*$`);
  for (const line of text.split("\n")) {
    if (line.trimStart().startsWith("#")) continue;
    const m = line.match(re);
    if (m) return m[1].replace(/^["']|["']$/g, "") === want;
  }
  return false;
}

/**
 * Idempotently ensure config.yaml carries `key: want`. `bd config set` patches config.yaml (appends a
 * single key line, never clobbering the rest); we skip the write when the file already matches so a
 * re-run is a true no-op. Returns "already" | "set" | "failed".
 */
export function ensureBdConfig(dir, beadsDir, key, want) {
  if (configYamlHas(beadsDir, key, want)) return "already";
  const r = spawnSync("bd", ["config", "set", key, want], { cwd: dir, stdio: "ignore" });
  return (r.status ?? 1) === 0 ? "set" : "failed";
}

/** The config.yaml keys anton's team-config enforces (Dolt-first model). */
const CONFIG_KEYS = [
  ["dolt.auto-commit", "on"],
  ["export.git-add", "false"],
];

/**
 * Run the full beads team-config path for `dir`, idempotently. Steps: `bd init` (only when `.beads/`
 * is absent) → config.yaml enforcement → `.beads/.gitignore`. Every step is best-effort and its
 * outcome is collected in `steps`/`errors` rather than thrown — the caller decides how loud to be
 * (the CLI prints each step; addProject logs a summary) and a step failure never aborts the caller.
 *
 * Returns:
 *   { configured, skipped, reason?, ranInit, steps: [{name,status,detail?}], errors: [], hasBeads }
 *
 * When prereqs aren't met (no bd / not a git repo / no origin) it returns early with
 * `{ configured:false, skipped:true, reason, hasBeads }` and does nothing — so calling it on a plain
 * directory is a safe no-op.
 *
 * @param {string} dir absolute path to the target repo
 * @param {{ prefix?: string|null, log?: (msg: string) => void }} [opts]
 */
export function configureBeadsForRepo(dir, opts = {}) {
  const { prefix = null, log } = opts;
  const emit = typeof log === "function" ? log : () => {};
  const beadsDir = join(dir, ".beads");
  const steps = [];
  const errors = [];

  const pre = beadsPrereqs(dir);
  if (!pre.ok) {
    return {
      configured: false,
      skipped: true,
      reason: pre.error.message,
      ranInit: false,
      steps,
      errors,
      hasBeads: existsSync(beadsDir),
    };
  }

  // 1. bd init — only when .beads/ is absent (prefix from caller, else bd auto-detects from dir name).
  let ranInit = false;
  if (existsSync(beadsDir)) {
    emit(".beads/ present — enforcing team-config only (no re-init).");
    steps.push({ name: "bd init", status: "already" });
  } else {
    const initArgs = ["init", "--non-interactive", "--dolt-auto-commit", "on"];
    if (prefix) initArgs.push("--prefix", prefix);
    emit(`bd ${initArgs.join(" ")}`);
    // NOTE: bd's global `-C` flag mis-resolves for `init` ("no beads project found"); run with the
    // target as cwd instead — equivalent, and it's what actually works. (bd 1.0.4)
    const r = spawnSync("bd", initArgs, { cwd: dir, encoding: "utf8" });
    if ((r.status ?? 1) !== 0) {
      const detail = (r.stderr || r.stdout || "").trim() || `exit ${r.status ?? "?"}`;
      steps.push({ name: "bd init", status: "failed", detail });
      errors.push(`bd init failed: ${detail}`);
      // Without a workspace the remaining steps can't apply — stop here but don't throw.
      return { configured: false, skipped: false, ranInit: false, steps, errors, hasBeads: existsSync(beadsDir) };
    }
    ranInit = true;
    steps.push({ name: "bd init", status: "ok" });
  }

  // 2. Patch config.yaml idempotently (never clobber).
  for (const [key, want] of CONFIG_KEYS) {
    const status = ensureBdConfig(dir, beadsDir, key, want);
    steps.push({ name: `${key}=${want}`, status });
    if (status === "failed") {
      emit(`could not set ${key}=${want}`);
      errors.push(`could not set ${key}=${want}`);
    } else {
      emit(`${key}=${want} (${status})`);
    }
  }

  // 3. Ensure .beads/.gitignore untracks the derived exports + Dolt runtime state.
  const gi = ensureBeadsGitignore(beadsDir);
  if (gi.added.length) {
    emit(`.beads/.gitignore += ${gi.added.join(", ")}`);
    steps.push({ name: ".beads/.gitignore", status: "set", detail: gi.added.join(", ") });
  } else {
    emit(".beads/.gitignore already untracks exports + Dolt state");
    steps.push({ name: ".beads/.gitignore", status: "already" });
  }

  // Dolt remote wiring (configureBeadsDoltSync) is added to THIS path by anton-43b so both callers
  // inherit it automatically.

  return {
    configured: true,
    skipped: false,
    ranInit,
    steps,
    errors,
    hasBeads: existsSync(beadsDir),
  };
}
