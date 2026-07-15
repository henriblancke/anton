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

/** The `origin` remote's URL, or "" when there is none. */
export function originRemoteUrl(dir) {
  const r = spawnSync("git", ["-C", dir, "remote", "get-url", "origin"], { encoding: "utf8" });
  return (r.status ?? 1) === 0 ? (r.stdout || "").trim() : "";
}

/** Read a single git config value for `dir`, or "" when unset. */
function gitConfigGet(dir, key) {
  const r = spawnSync("git", ["-C", dir, "config", "--get", key], { encoding: "utf8" });
  return (r.status ?? 1) === 0 ? (r.stdout || "").trim() : "";
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

/** The config.yaml keys anton's team-config enforces (Dolt-first model). `dolt.auto-push false`
 * because anton owns push cadence (write-nudged full passes, pull-only heartbeats): bd 1.0.2
 * auto-pushes after every write once a remote named `origin` exists, which both double-pushes
 * and re-creates the concurrent-push manifest-corruption risk (beads GH#2466) anton avoids. */
const CONFIG_KEYS = [
  ["dolt.auto-commit", "on"],
  ["export.git-add", "false"],
  ["dolt.auto-push", "false"],
];

/** True when a Dolt remote named `name` is already configured in `dir`'s workspace. */
export function doltRemoteConfigured(dir, name = "origin") {
  const r = spawnSync("bd", ["dolt", "remote", "list"], { cwd: dir, encoding: "utf8" });
  if ((r.status ?? 1) !== 0) return false;
  const out = r.stdout || "";
  if (/no remotes configured/i.test(out)) return false;
  // Lines look like: "origin               git+file:///…" — first whitespace token is the remote name.
  return out.split("\n").some((l) => l.trim().split(/\s+/)[0] === name);
}

/**
 * The URL of the Dolt remote named `name` in `dir`'s workspace, or null when it isn't configured.
 * `bd dolt remote list` prints `<name>  <url>` lines ("No remotes configured." when empty).
 *
 * @param {string} dir
 * @param {string} [name]
 */
export function doltRemoteUrl(dir, name = "origin") {
  const r = spawnSync("bd", ["dolt", "remote", "list"], { cwd: dir, encoding: "utf8" });
  if ((r.status ?? 1) !== 0) return null;
  const out = r.stdout || "";
  if (/no remotes configured/i.test(out)) return null;
  for (const line of out.split("\n")) {
    const [n, url] = line.trim().split(/\s+/);
    if (n === name && url) return url;
  }
  return null;
}

/**
 * Normalize a Dolt/git remote URL for equality checks against what `bd dolt remote list` reports.
 * bd rewrites URLs when storing them — a `git+` scheme prefix, and scp form (`git@host:org/repo`)
 * becomes `git+ssh://git@host/./org/repo.git` — so a byte compare would re-point on every run.
 * A declared non-git remote (e.g. `aws://…`) passes through the git-specific steps unchanged.
 *
 * @param {string} url
 */
export function normalizeRemoteUrl(url) {
  let s = url.trim().replace(/^git\+/, "").replace(/^file:\/\//, "");
  const scp = s.match(/^([^@/]+@[^:/]+):(.+)$/);
  if (scp) s = `ssh://${scp[1]}/${scp[2]}`;
  return s.replace(/\/\.\//g, "/").replace(/\.git$/, "").replace(/\/+$/, "");
}

/** Best-effort `{stderr||stdout}` detail from a spawnSync result, for surfacing a failed step. */
function stepDetail(r) {
  return (r.stderr || r.stdout || "").trim() || `exit ${r.status ?? "?"}`;
}

/**
 * The project's declared Dolt remote from beads config (`sync.remote` in .beads/config.yaml) —
 * e.g. knowledge-layer declares an `aws://` remote there. IMPORTANT: `bd config get` exits 0
 * with "sync.remote (not set in config.yaml)" when unset (verified on bd 1.0.2), so detection
 * parses the output text, never the exit code. Returns the URL or null.
 *
 * @param {string} dir
 */
export function configuredSyncRemote(dir) {
  const r = spawnSync("bd", ["config", "get", "sync.remote"], { cwd: dir, encoding: "utf8" });
  if ((r.status ?? 1) !== 0) return null;
  const out = (r.stdout || "").trim();
  if (!out || /\(not set/i.test(out)) return null;
  // Output is "sync.remote = <url>" or a bare value line — take the first URL-shaped token.
  const token = out.split(/\s+/).find((t) => /^[a-z+]+:\/\//i.test(t) || t.startsWith("git@"));
  return token ?? null;
}

/**
 * Wire the git-backed Dolt remote for `repoDir`, reusing bd's own `dolt` subcommands — no new sync
 * code. beads stores issues in Dolt and syncs them over the git remote as `refs/dolt/data`; adding
 * the remote points `bd dolt push/pull` at the repo's `origin` URL (bd records it as `git+<url>`).
 *
 * Steps (idempotent): remote add → hydrate pull → publish push. The pull is best-effort — a fresh
 * origin has no `refs/dolt/data` yet, so it exits non-zero ("no branches found"); that's expected on
 * the first machine, not an error. The push publishes local Dolt commits so `refs/dolt/data` exists
 * on origin for the next machine to hydrate from. Dolt remotes live in `.beads/dolt/` (gitignored),
 * so this must run once per machine — a clone doesn't inherit the remote config.
 *
 * Returns `{ status, ... }` where status is one of, matching cmdSetup's rendering:
 *   - "no-workspace" — no `.beads/` (nothing to wire)
 *   - "no-remote"    — repo has no `origin` remote
 *   - "already"      — the Dolt `origin` remote is already configured (no-op)
 *   - "configured"   — remote added + published (`{ url }`)
 *   - "error"        — a step failed (`{ detail }`)
 *
 * @param {{ repoDir: string, log?: (msg: string) => void }} opts
 */
export function configureBeadsDoltSync(opts = {}) {
  const { repoDir: dir, log } = opts;
  const emit = typeof log === "function" ? log : () => {};

  if (!existsSync(join(dir, ".beads"))) return { status: "no-workspace" };

  // Remote choice is dynamic per project: a `sync.remote` declared in .beads/config.yaml (e.g.
  // an aws:// remote) wins over the git-origin fallback — anton drives whatever the project's
  // beads config declares, it never forces git-origin over a declared remote.
  const declared = configuredSyncRemote(dir);
  const url = declared ?? originRemoteUrl(dir);
  if (!url) return { status: "no-remote" };

  // Only a no-op when the existing Dolt remote already points at THIS url. A repo first wired to
  // git origin and later given a declared `sync.remote` (e.g. aws://) must be re-pointed, not left
  // pulling/pushing the stale remote — otherwise the declared shared backlog is silently ignored
  // (anton-live-sync review). `bd dolt remote add` upserts, so the add below re-points a stale url.
  const existing = doltRemoteUrl(dir, "origin");
  if (existing && normalizeRemoteUrl(existing) === normalizeRemoteUrl(url)) {
    emit("Dolt remote 'origin' already configured — no-op.");
    return { status: "already", url };
  }
  if (existing) emit(`Dolt remote 'origin' points at ${existing} — repointing to ${url}`);
  else if (declared) emit(`sync.remote declared in beads config — wiring ${declared}`);

  const add = spawnSync("bd", ["dolt", "remote", "add", "origin", url], { cwd: dir, encoding: "utf8" });
  if ((add.status ?? 1) !== 0) return { status: "error", detail: stepDetail(add) };
  emit(`bd dolt remote add origin ${url}`);

  // Hydrate: pull any existing refs/dolt/data (best-effort — a fresh remote has none yet).
  const pull = spawnSync("bd", ["dolt", "pull"], { cwd: dir, encoding: "utf8" });
  emit((pull.status ?? 1) === 0 ? "bd dolt pull — hydrated from origin" : "bd dolt pull — nothing to hydrate yet");

  // Publish: push local Dolt commits so refs/dolt/data lands on origin for the next machine.
  const push = spawnSync("bd", ["dolt", "push"], { cwd: dir, encoding: "utf8" });
  if ((push.status ?? 1) !== 0) return { status: "error", detail: stepDetail(push) };
  emit("bd dolt push — published refs/dolt/data to origin");

  return { status: "configured", url };
}

/** Config files that mark a third-party git-hooks manager owning core.hooksPath. */
const HOOK_MANAGERS = [
  { manager: "husky", files: [".husky"] },
  { manager: "lefthook", files: ["lefthook.yml", "lefthook.yaml", ".lefthook.yml", ".lefthook.yaml"] },
];

/**
 * Detect a git-hooks manager (husky/lefthook) — or any custom `core.hooksPath` override — that would
 * displace bd's own hooks. bd's native install points `core.hooksPath` at `.beads/hooks` and, when a
 * manager already claims that setting, `bd init` silently CLOBBERS it (verified: husky's `.husky` →
 * `.beads/hooks`). Either way one side wins: under a manager's hooksPath, bd's post-merge/post-checkout
 * Dolt HYDRATION won't fire on pull/checkout. We only warn — anton never rewrites the user's hooks.
 *
 * Detection is by committed artifacts (a `.husky/` dir, a `lefthook.*` config) so it survives bd
 * clobbering `core.hooksPath`; `priorHooksPath` (captured before `bd init` ran) catches a bare custom
 * override with no manager config. Returns `{ manager, path } | null`.
 *
 * @param {string} dir
 * @param {string|null} [priorHooksPath] core.hooksPath as it was BEFORE bd init (optional)
 */
export function detectHooksManager(dir, priorHooksPath = null) {
  for (const { manager, files } of HOOK_MANAGERS) {
    for (const f of files) {
      if (existsSync(join(dir, f))) return { manager, path: f };
    }
  }
  const p = (priorHooksPath || "").replace(/\/+$/, "");
  if (p && !p.endsWith(".beads/hooks") && p !== ".git/hooks") {
    return { manager: "custom", path: priorHooksPath };
  }
  return null;
}

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

  // Capture core.hooksPath BEFORE bd init — bd's hooks install overwrites it with .beads/hooks, so a
  // husky/lefthook (or bare custom) override is only observable here (anton-43b).
  const priorHooksPath = gitConfigGet(dir, "core.hooksPath") || null;

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

  // 4. Wire the git-backed Dolt remote (remote add → hydrate pull → publish push). Shared here so
  //    both `anton init` and addProject inherit it (anton-43b). A failure is collected, not thrown.
  const doltSync = configureBeadsDoltSync({ repoDir: dir, log: emit });
  steps.push({ name: "dolt remote sync", status: doltSync.status, detail: doltSync.detail });
  if (doltSync.status === "error") {
    errors.push(`dolt remote sync failed: ${doltSync.detail}`);
  }

  // 5. Hooks are OPTIONAL for anton-driven repos — runDoltSync() pushes Dolt on every write, so the
  //    pre-push hook is redundant and only post-merge/post-checkout hydration is lost under a hooks
  //    manager. Detect husky/lefthook (or a custom hooksPath) and WARN; never auto-rewrite hooks.
  //    A plain-git repo relies on bd init's native hooks install and needs nothing extra.
  const hooksWarning = detectHooksManager(dir, priorHooksPath);
  if (hooksWarning) {
    emit(`core.hooksPath is managed by ${hooksWarning.manager} — bd hydration hooks won't run under it.`);
  }

  return {
    configured: true,
    skipped: false,
    ranInit,
    steps,
    errors,
    hasBeads: existsSync(beadsDir),
    doltSync,
    hooksWarning,
  };
}
