/**
 * Reusable beads team-config for a target repo (anton-uez). The single config path shared by the
 * `anton init` CLI (bin/anton.mjs) and `addProject` (src/lib/projects.ts) so a repo configured from
 * the terminal and one added through the UI/API converge to the SAME end state: bd init (when
 * absent) → config.yaml enforcement → .beads/.gitignore → formulas (bead skeleton anton-8mnr, run
 * pipeline anton-hrql) → [Dolt remote wiring — anton-43b].
 *
 * Plain JS, node built-ins only (fs + child_process), so it imports cleanly from both the pure-node
 * CLI and the TypeScript server. See DESIGN.md §3 (beads is the work source of truth).
 *
 * The correct team-config is the Dolt-first model (issues live in Dolt, synced over refs/dolt/data;
 * the JSONL is a passive export): dolt.auto-commit "on", export.auto false, export.git-add false, and
 * a .gitignore that keeps the derived exports + Dolt runtime state out of git.
 *
 * That is the EMBEDDED profile — the default. A board can instead live on one shared `dolt
 * sql-server` (DESIGN.md §3a), where the refs/dolt/data knobs describe a sync channel that does not
 * exist; there the team-config is the CONNECTION instead. Both profiles live below in
 * `teamConfigKeys` / `SERVER_CONNECTION_KEYS`, selected by the mode this file reads from
 * `.beads/metadata.json` (anton-4gd2).
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

/**
 * Wall-clock budgets for the synchronous probes below (anton-jfjw.4). `spawnSync` BLOCKS the calling
 * thread, so an unbounded probe — `git ls-files` or `git remote get-url` against a repo whose git
 * wedges on a dead peer — freezes the caller outright, with no timer that could ever fire. Every
 * call site here passes one of these budgets plus SPAWN_KILL_SIGNAL.
 *
 * Proportionate to the work: `command -v` / `git rev-parse` / `git config --get` are local,
 * millisecond probes; a `bd` command against the local Dolt workspace is slower; `bd init` /
 * `bd bootstrap` and the Dolt pull/push talk to the remote and legitimately take minutes on a large
 * board — a budget short enough to cut those off would break setup, not protect it.
 *
 * NOTE `timeout` only signals the DIRECT child (spawnSync has no detached/process-group option).
 * That's the accepted trade here: these are short-lived local probes and the goal is bounding the
 * calling thread, not reaping descendants — see bd() (bd.ts) and runShell (src/lib/jobs/shell.ts)
 * for the async paths that do need process-group cleanup.
 */
export const SPAWN_BUDGETS_MS = {
  /** Local, no network: command -v, git rev-parse/config/ls-files/rm. */
  probe: 15_000,
  /** A bd command against the local Dolt workspace (config get/set, dolt remote add/list). */
  bd: 60_000,
  /** Talks to the remote: bd init/bootstrap, bd dolt pull/push, git ls-remote. */
  network: 300_000,
};

/**
 * SIGKILL, not spawnSync's SIGTERM default: a budget only bounds the calling thread if the child
 * cannot ignore the kill. These probes hold no state worth a graceful shutdown.
 */
export const SPAWN_KILL_SIGNAL = "SIGKILL";

/**
 * Resolve a budget, capped by ANTON_BEADS_SPAWN_TIMEOUT_MS when set (tests use a few hundred ms; also
 * an ops escape hatch). A cap rather than an override so production keeps the proportions above.
 * Read per call so a change lands without a module reload.
 */
export function budgetMs(kind) {
  const raw = Number(process.env.ANTON_BEADS_SPAWN_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? Math.min(SPAWN_BUDGETS_MS[kind], raw) : SPAWN_BUDGETS_MS[kind];
}

/** True when spawnSync killed this child at its budget — status is null and no output was flushed. */
function timedOut(r) {
  return r?.error?.code === "ETIMEDOUT";
}

/**
 * Why a spawn failed, in a form an operator can act on. A budget kill leaves status null and empty
 * output, which would otherwise surface as an opaque `exit ?` and send the reader hunting a cause
 * that isn't there (the anton-be1s misreport). `output` is the caller's own stdout/stderr pick.
 */
export function failureDetail(r, timeoutMs, output) {
  if (timedOut(r)) return `timed out after ${timeoutMs}ms (killed with ${r.signal ?? SPAWN_KILL_SIGNAL})`;
  return output.trim() || `exit ${r.status ?? "?"}`;
}

/** True when `cmd` answers on PATH (probes --version/--help, then `command -v`). */
export function onPath(cmd) {
  for (const probe of [["--version"], ["--help"]]) {
    const r = spawnSync(cmd, probe, {
      stdio: "ignore",
      timeout: budgetMs("probe"),
      killSignal: SPAWN_KILL_SIGNAL,
    });
    if (!r.error && (r.status === 0 || r.status === 1)) return true;
  }
  const r = spawnSync("sh", ["-c", `command -v ${cmd}`], {
    stdio: "ignore",
    timeout: budgetMs("probe"),
    killSignal: SPAWN_KILL_SIGNAL,
  });
  return r.status === 0;
}

/**
 * The floor bd version anton requires (anton-qwsq / epic anton-x7la). 1.1.0 ships the correctness
 * and perf features anton now depends on — `--skip-labels` reads, automatic post-pull is_blocked
 * recompute, and `bd bootstrap` for fresh clones — and, critically, guards the remote-backed schema
 * migration (a bare `bd migrate` refuses without BD_ALLOW_REMOTE_MIGRATE=1). Running anton against an
 * older bd is unsupported; every preflight fails loud rather than limping on.
 *
 * Kept in sync by hand with bd-bin.ts MIN_BD_VERSION/MIN_BD (`.mjs` and `.ts` can't share a const):
 * the server-startup preflight and the CLI preflight must agree, so bump both together.
 */
export const MIN_BD_VERSION = "1.1.0";
const MIN_BD = { major: 1, minor: 1, patch: 0 };

/**
 * Absolute URL to the one-clone migration runbook — a URL, not a repo-relative path, so it resolves
 * for npm/bundle installs where `docs/` isn't shipped. Keep in sync with bd-bin.ts BD_MIGRATION_RUNBOOK.
 */
export const BD_MIGRATION_RUNBOOK =
  "https://github.com/henriblancke/anton/blob/main/docs/runbooks/bd-1.0.4-to-1.1.0-migration.md";

/**
 * Parse a `bd --version` line (`bd version 1.1.0 (hash)`) into `{ major, minor, patch, raw }`, or
 * null when no dotted version is present. `run` is injectable for tests; the default spawns bd.
 *
 * @param {() => { status?: number|null, stdout?: string, stderr?: string, error?: unknown }} [run]
 */
export function bdVersion(
  run = () =>
    spawnSync("bd", ["--version"], {
      encoding: "utf8",
      timeout: budgetMs("probe"),
      killSignal: SPAWN_KILL_SIGNAL,
    }),
) {
  const r = run();
  if (!r || r.error || (r.status ?? 1) !== 0) return null;
  const m = `${r.stdout ?? ""}${r.stderr ?? ""}`.match(/(\d+)\.(\d+)\.(\d+)/);
  if (!m) return null;
  return { major: +m[1], minor: +m[2], patch: +m[3], raw: `${m[1]}.${m[2]}.${m[3]}` };
}

/** True when parsed version `v` is >= `min` (semver-ish major/minor/patch compare). null → false. */
export function bdVersionAtLeast(v, min = MIN_BD) {
  if (!v) return false;
  if (v.major !== min.major) return v.major > min.major;
  if (v.minor !== min.minor) return v.minor > min.minor;
  return v.patch >= min.patch;
}

/** True when `dir` is inside a git work tree. */
export function isGitWorkTree(dir) {
  const r = spawnSync("git", ["-C", dir, "rev-parse", "--is-inside-work-tree"], {
    stdio: "ignore",
    timeout: budgetMs("probe"),
    killSignal: SPAWN_KILL_SIGNAL,
  });
  return r.status === 0;
}

/** True when `dir`'s repo has an `origin` remote configured. */
export function hasOriginRemote(dir) {
  const r = spawnSync("git", ["-C", dir, "remote", "get-url", "origin"], {
    stdio: "ignore",
    timeout: budgetMs("probe"),
    killSignal: SPAWN_KILL_SIGNAL,
  });
  return r.status === 0;
}

/**
 * Read a single git config value for `dir`: "" when the key is unset, `null` when the read could not
 * be completed (budget kill). An UNREADABLE config is not an unset one — collapsing the two would let
 * a wedged `git config` report a confident "no core.hooksPath" and hide a real override (PR #89).
 */
function gitConfigGet(dir, key) {
  const r = spawnSync("git", ["-C", dir, "config", "--get", key], {
    encoding: "utf8",
    timeout: budgetMs("probe"),
    killSignal: SPAWN_KILL_SIGNAL,
  });
  if (timedOut(r)) return null;
  return (r.status ?? 1) === 0 ? (r.stdout || "").trim() : "";
}

/** True when `dir` already carries a beads workspace (`.beads/`). */
export function hasBeadsDir(dir) {
  return existsSync(join(dir, ".beads"));
}

/**
 * Check the prereqs beads config needs (bd on PATH, an existing git repo, and — per board mode —
 * either an origin remote or a reachable shared server).
 *
 * Returns { ok } or { ok:false, error:{ message, fix } } — the CLI renders the fix loudly; the
 * self-heal path (addProject) uses it to skip cleanly on a repo that can't be configured (e.g. a
 * plain directory with no git), never corrupting the projects row.
 *
 * The last check is the mode-dependent one, because the two profiles depend on different things
 * (DESIGN.md §3a): an embedded board reconciles per-machine copies over `refs/dolt/data` and so
 * needs `origin`, while a server board has no local copy at all and so needs the SERVER. Checking
 * an embedded board's origin on a server board would fail it for a channel it does not use; not
 * checking the server would let the bootstrap proceed and die later, mid-run, inside bd.
 *
 * @param {string} dir repo root
 * @param {{ exec?: Function, env?: NodeJS.ProcessEnv }} [opts] the `checkSharedServer` seam
 */
export function beadsPrereqs(dir, opts = {}) {
  if (!onPath("bd")) {
    return {
      ok: false,
      error: {
        message: "bd not found on PATH — beads is anton's work source of truth.",
        fix: `Install bd >= ${MIN_BD_VERSION}, then re-run: https://github.com/gastownhall/beads`,
      },
    };
  }
  const v = bdVersion();
  if (!bdVersionAtLeast(v)) {
    return {
      ok: false,
      error: {
        message: v
          ? `bd ${v.raw} is too old — anton requires bd >= ${MIN_BD_VERSION}.`
          : `could not read the bd version — anton requires bd >= ${MIN_BD_VERSION}.`,
        fix: `Upgrade bd (https://github.com/gastownhall/beads). For a remote-backed board, follow ${BD_MIGRATION_RUNBOOK} — one clone migrates, the rest \`bd bootstrap\`.`,
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
  const board = readDoltMetadata(dir);
  if (board.mode === "server") {
    const target = formatServerTarget(board);
    const reachable = checkSharedServer(dir, board, opts);
    if (reachable.ok) return { ok: true };
    // Fail loud HERE rather than let bd fail later: in server mode there is no local copy, so an
    // unreachable server is a board outage, and bd's own error names neither the configured target
    // nor the way out ("unreachable at 127.0.0.1:0 … dolt is not installed").
    return {
      ok: false,
      error: {
        message: `this project's board is on a shared Dolt server at ${target}, which is unreachable — server mode keeps no local copy, so nothing here can read the board. (${reachable.detail})`,
        fix:
          `Start the server (or restore the route to ${target}), confirm ${join(dir, ".beads", "metadata.json")} ` +
          `names the right host/port/user, and set ${passwordVarHint(board.user)} in this shell — ` +
          `or set "dolt_mode": "embedded" there to work from this machine's local copy until it's back.`,
      },
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
 * Untrack beads exports that are ALREADY in git (anton-vqgw). `.gitignore` only suppresses
 * *untracked* files, so a repo that committed `issues.jsonl` before the ignore was added keeps
 * carrying it — and then every clone/branch ships a frozen snapshot of the board that inbound
 * tooling can replay over live state. Idempotent: a no-op when nothing is tracked.
 *
 * Stages the removal (`git rm --cached`) rather than committing — the caller's next commit picks it
 * up, and anton never commits on the user's behalf. Returns { untracked: string[] }.
 */
export function untrackBeadsExports(dir, entries = BEADS_GITIGNORE_ENTRIES) {
  const paths = entries.map((e) => `.beads/${e}`);
  const probeMs = budgetMs("probe");
  const ls = spawnSync("git", ["ls-files", "--", ...paths], {
    cwd: dir,
    encoding: "utf8",
    timeout: probeMs,
    killSignal: SPAWN_KILL_SIGNAL,
  });
  // A killed probe proves nothing about what's tracked, so it must NOT read as the empty "nothing to
  // untrack" result the caller records as a clean step — report it as the failure it is.
  if (timedOut(ls)) return { untracked: [], error: failureDetail(ls, probeMs, "") };
  if ((ls.status ?? 1) !== 0) return { untracked: [] };
  const tracked = (ls.stdout || "")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  if (tracked.length === 0) return { untracked: [] };

  // -r so a tracked directory form (dolt/, embeddeddolt/) is removed too.
  const rm = spawnSync("git", ["rm", "--cached", "-r", "-q", "--", ...tracked], {
    cwd: dir,
    encoding: "utf8",
    timeout: probeMs,
    killSignal: SPAWN_KILL_SIGNAL,
  });
  // The detail must never be empty — the caller keys "did this fail?" off its truthiness, so a
  // killed `git rm` (status null, no stderr) would otherwise be recorded as a clean no-op.
  if ((rm.status ?? 1) !== 0) return { untracked: [], error: failureDetail(rm, probeMs, rm.stderr || "") };
  return { untracked: tracked };
}

/** The bead-formula asset's filename — how it lands in `.beads/formulas/` and how bd addresses it. */
export const BEAD_FORMULA_FILENAME = "anton-bead.formula.json";

/**
 * The run-formula asset's filename (anton-hrql) — the PIPELINE anton walks, as opposed to the bead
 * SKELETON above. Same install shape, same no-clobber rule, same `.beads/formulas/` home, so a
 * project owns its pipeline the way it already owns its bead shape.
 */
export const RUN_FORMULA_FILENAME = "anton-run.formula.toml";

/**
 * What a formula NAME may be — the `<name>` in `<name>.formula.toml`, as a project's per-label
 * variant map (anton-aa3m) addresses it. Letters, digits, `.`, `-` and `_`, starting and ending
 * alphanumeric: no path separator, and `..` cannot match, so a mapping can never point the loader
 * outside `.beads/formulas/`.
 *
 * Lives here, with the formula filenames it is the other half of, because it is enforced at two
 * boundaries a run apart — the settings API that accepts the map, and the loader that reads the file
 * — and two copies would drift into a mapping that passes one and parks at the other.
 */
export const FORMULA_NAME_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/;

/**
 * Path segments of a bundled formula, relative to anton's package root (anton-8mnr). Both ride along
 * in the `setup` skill's template tree so `/setup`, `anton setup`, and `anton init` all install the
 * SAME files, and the server-side loaders resolve the same segments against the server's cwd.
 */
const formulaRelpath = (filename) => ["skills", "setup", "templates", ".beads", "formulas", filename];

export const BEAD_FORMULA_RELPATH = formulaRelpath(BEAD_FORMULA_FILENAME);
export const RUN_FORMULA_RELPATH = formulaRelpath(RUN_FORMULA_FILENAME);

/** anton's package root, resolved from this module rather than cwd (the CLI runs from anywhere). */
const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

/** Absolute path to the bundled bead formula shipped with this anton install. */
export function bundledBeadFormulaPath(appRoot = PACKAGE_ROOT) {
  return join(appRoot, ...BEAD_FORMULA_RELPATH);
}

/** Absolute path to the bundled run formula shipped with this anton install (anton-hrql). */
export function bundledRunFormulaPath(appRoot = PACKAGE_ROOT) {
  return join(appRoot, ...RUN_FORMULA_RELPATH);
}

/**
 * Install a bundled formula into `<repo>/.beads/formulas/`, NO-CLOBBER (anton-8mnr). A project-local
 * copy always wins: once a team has tuned its own bead shape or pipeline, re-running setup must never
 * overwrite it. Living under `.beads/` (which git tracks — only the JSONL exports and the Dolt runtime
 * are ignored) is what carries it to every clone and teammate.
 *
 * Never CREATES the workspace: a formula under a `.beads/` that no `bd init` made is a half-
 * workspace, and every downstream probe reads the directory's mere existence as "this is a beads
 * repo" (configureBeadsDoltSync does exactly that, then aborts `anton setup` for having no git
 * origin). So an absent `.beads/` is a skip, not a mkdir.
 *
 * Returns { status, detail? } — "installed" | "already" | "missing-asset" (the bundled file isn't in
 * this install — a warning, never fatal: anton's own loaders fall back to their packaged copy) |
 * "no-workspace" | "failed".
 *
 * A filesystem error (read-only checkout, no write permission, transient I/O) is REPORTED as
 * "failed", never thrown: this is one best-effort step among a dozen in setup/registration, and an
 * unwritable `.beads/formulas/` must not abort the whole run over an asset anton can fall back to.
 */
function ensureFormula(beadsDir, filename, src) {
  const dest = join(beadsDir, "formulas", filename);
  if (existsSync(dest)) return { status: "already" };
  if (!existsSync(beadsDir)) return { status: "no-workspace" };
  if (!existsSync(src)) return { status: "missing-asset" };
  try {
    mkdirSync(dirname(dest), { recursive: true });
    copyFileSync(src, dest);
  } catch (err) {
    return { status: "failed", detail: err?.message || String(err) };
  }
  return { status: "installed" };
}

/** Install the bead skeleton every bead anton creates is rendered from (anton-8mnr). */
export function ensureBeadFormula(beadsDir, src = bundledBeadFormulaPath()) {
  return ensureFormula(beadsDir, BEAD_FORMULA_FILENAME, src);
}

/** Install the run pipeline anton walks (anton-hrql). */
export function ensureRunFormula(beadsDir, src = bundledRunFormulaPath()) {
  return ensureFormula(beadsDir, RUN_FORMULA_FILENAME, src);
}

/**
 * Walk a `.beads/config.yaml`'s uncommented `key: value` lines, yielding `{ line, path, value }` for
 * each — the ONE reader of both encodings bd has shipped, so nothing below can disagree about what a
 * line means. bd 1.0.4 appends flat dotted lines (`export.auto: false`); bd 1.1.0 writes `export.*`
 * and `dolt.*` as nested maps (`export:` / `    auto: false`) while keeping `sync.remote` flat. Both
 * must resolve to the same dotted path so team-config enforcement doesn't keep re-setting keys it
 * already set (anton-qhoz). Nesting is tracked purely by indentation; blank and comment lines are
 * ignored. `line` is the 0-based index into `text.split("\n")`, for callers that rewrite the file.
 */
function* configYamlEntries(text) {
  const stack = []; // parent map headers currently in scope, outermost first: { indent, key }
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].replace(/\r$/, "");
    if (line.trim() === "" || line.trimStart().startsWith("#")) continue;
    const m = line.match(/^(\s*)([^:#]+):\s*(.*)$/);
    if (!m) continue;
    const indent = m[1].length;
    const key = m[2].trim();
    const value = m[3].trim();
    // Unwind to the parent whose children sit at a deeper indent than this line.
    while (stack.length && stack[stack.length - 1].indent >= indent) stack.pop();
    const path = [...stack.map((s) => s.key), key].join(".");
    if (value === "") {
      // A bare `key:` opens a nested map (bd 1.1.0's `export:`/`dolt:`) — remember it as a parent.
      stack.push({ indent, key });
    } else {
      yield { line: i, path, value: value.replace(/^["']|["']$/g, "") };
    }
  }
}

/**
 * Parse `.beads/config.yaml` into a flat `dotted.path → value` map (surrounding quotes stripped).
 * A later line for the same path wins (bd appends, so this reflects the effective value).
 *
 * Exported because a rollback has to compare two TEXTS — the file as a run found it against the file
 * as it stands — rather than the file on disk against one key (PR #174 review).
 */
export function parseConfigYaml(text) {
  const map = {};
  for (const { path, value } of configYamlEntries(text)) map[path] = value;
  return map;
}

/**
 * True when `.beads/config.yaml` carries an *uncommented* setting for `key` (given as a dotted path,
 * e.g. `export.auto`) whose value equals `want` (surrounding quotes tolerated, e.g.
 * `dolt.auto-commit: "on"`). Matches the flat (`export.auto: false`) AND nested (`export:` /
 * `  auto: false`) encodings — bd switched `export.*`/`dolt.*` to nested at 1.1.0 (anton-qhoz). We
 * check the FILE — not `bd config get` — because the team-config must be committed to config.yaml to
 * travel to every clone; `bd config get` also reflects the Dolt DB (where `bd init --dolt-auto-commit
 * on` lands it), which is not portable.
 */
export function configYamlHas(beadsDir, key, want) {
  return configYamlValue(beadsDir, key) === want;
}

/**
 * The value `.beads/config.yaml` publishes for `key` (dotted path), or `undefined` when the file is
 * missing, unreadable, or says nothing about it.
 */
export function configYamlValue(beadsDir, key) {
  try {
    return parseConfigYaml(readFileSync(join(beadsDir, "config.yaml"), "utf8"))[key];
  } catch {
    return undefined;
  }
}

/**
 * Comment out every line `.beads/config.yaml` devotes to `key`, returning whether the file changed.
 * Commenting rather than deleting is `bd config unset`'s own strike-out style, and it leaves the old
 * value readable as history instead of vanishing from a committed file.
 */
function retractConfigYamlKey(beadsDir, key) {
  const path = join(beadsDir, "config.yaml");
  let lines;
  try {
    lines = readFileSync(path, "utf8").split("\n");
  } catch {
    return false;
  }
  let changed = false;
  for (const entry of configYamlEntries(lines.join("\n"))) {
    if (entry.path !== key) continue;
    lines[entry.line] = lines[entry.line].replace(/^(\s*)/, "$1# ");
    changed = true;
  }
  if (!changed) return false;
  try {
    writeFileSync(path, lines.join("\n"));
  } catch {
    return false;
  }
  return true;
}

/**
 * Idempotently ensure config.yaml carries `key: want`. `bd config set` patches config.yaml (appends a
 * single key line, never clobbering the rest); we skip the write when the file already matches so a
 * re-run is a true no-op. Returns "already" | "set" | "failed".
 *
 * `opts.exec` is the same seam `ensureDoltConnection` takes: a caller that must run bd under a
 * project-scoped environment (server-mode.mjs) passes its own runner rather than inheriting the
 * ambient one.
 */
export function ensureBdConfig(dir, beadsDir, key, want, opts = {}) {
  if (configYamlHas(beadsDir, key, want)) return "already";
  const ms = budgetMs("bd");
  const r = opts.exec
    ? opts.exec("bd", ["config", "set", key, want], ms)
    : spawnSync("bd", ["config", "set", key, want], {
        cwd: dir,
        stdio: "ignore",
        timeout: ms,
        killSignal: SPAWN_KILL_SIGNAL,
      });
  return (r.status ?? 1) === 0 ? "set" : "failed";
}

/**
 * `dolt_server_port` as a number, whatever JSON type it arrives as.
 *
 * bd writes this file too, and `bd dolt set port <n> --update-config` re-serializes the port as a
 * STRING — so a number-only parse loses the port of every board bd has already published, which is
 * every board this command has successfully switched (PR #174 review). What follows is not a
 * warning but three silent failures: `anton init` reports the required port missing, the preflight
 * names the target as `host:?`, and the per-server password variable is looked up under a
 * port-less name no operator was told to set, so the next bd call cannot authenticate.
 *
 * Only a whole port number is accepted, in either encoding. Anything else — a float, a blank, a
 * `"3306x"`, a value out of range — is still dropped rather than passed through: bd dialing a
 * nonsense port is the same outage as bd dialing port 0, and the "missing" verdict at least names
 * the fix.
 */
function asPort(value) {
  const n = typeof value === "string" && /^\s*\d+\s*$/.test(value) ? Number(value) : value;
  return typeof n === "number" && Number.isInteger(n) && n > 0 && n <= 65535 ? n : undefined;
}

/**
 * The board mode + connection a project declares in `.beads/metadata.json` — `embedded` (a Dolt
 * database under `.beads/`, one copy per machine, reconciled over refs/dolt/data) or `server` (one
 * shared `dolt sql-server` every machine reads and writes). See DESIGN.md §3a.
 *
 * metadata.json, not config.yaml or the environment: it is bd's per-directory source of truth, so it
 * describes THIS project no matter which process asks or what that process was launched with. (The
 * environment outranks it in bd's own precedence, which is exactly why anton scopes a bd spawn's env
 * per project — see bd-env.ts, anton-ffmw.1.)
 *
 * Anything absent, unreadable, unparseable, or unrecognised resolves to `embedded`. That is the safe
 * direction: embedded merely syncs when it need not, whereas a wrong "server" verdict would silently
 * disable a solo board's only propagation path. Never throws — callers gate setup on it.
 *
 * The typed accessor `board-mode.ts` delegates here, so there is ONE parser of this file.
 *
 * @param {string} dir repo root (the directory containing `.beads/`)
 * @returns {{ mode: "embedded"|"server", host?: string, port?: number, user?: string, database?: string,
 *   tls?: boolean }}
 */
export function readDoltMetadata(dir) {
  try {
    const meta = JSON.parse(readFileSync(join(dir, ".beads", "metadata.json"), "utf8"));
    if (meta?.dolt_mode !== "server") return { mode: "embedded" };
    return {
      mode: "server",
      host: typeof meta.dolt_server_host === "string" ? meta.dolt_server_host : undefined,
      port: asPort(meta.dolt_server_port),
      user: typeof meta.dolt_server_user === "string" ? meta.dolt_server_user : undefined,
      database: typeof meta.dolt_database === "string" ? meta.dolt_database : undefined,
      // bd's own key (`dolt_server_tls`), left undefined when the project declares nothing — which
      // is what {@link applyBoardTls} reads as "inherit the ambient setting".
      tls: typeof meta.dolt_server_tls === "boolean" ? meta.dolt_server_tls : undefined,
    };
  } catch {
    return { mode: "embedded" };
  }
}

/**
 * Env vars that name WHICH project/database bd talks to. Never inherited by a bd spawned against a
 * different project — an inherited value silently overrides that project's own metadata.json
 * (anton-ffmw.1; `bd-env.ts` carries the field report).
 *
 * Credentials and transport (`BEADS_DOLT_PASSWORD`, `BEADS_DOLT_SERVER_TLS`) are deliberately
 * absent: they answer "may I connect", not "connect to what", and a blanket strip would leave every
 * spawn unable to authenticate. They are resolved per project instead — the password by
 * {@link resolveBdPassword}, the transport by {@link applyBoardTls}.
 *
 * Defined here rather than in `bd-env.ts` so the pure-node CLI — which cannot import TypeScript —
 * scopes its own bd spawns off the same list the server uses. `bd-env.ts` re-exports it.
 */
export const PROJECT_SCOPED_BD_ENV = [
  // Whether to reach for a server at all, and which one.
  "BEADS_DOLT_SERVER_MODE",
  "BEADS_DOLT_SHARED_SERVER",
  "BEADS_DOLT_PROXIED_SERVER",
  "BEADS_DOLT_SERVER_HOST",
  "BEADS_DOLT_SERVER_PORT",
  "BEADS_DOLT_SERVER_USER",
  "BEADS_DOLT_SERVER_DATABASE",
  "BEADS_DOLT_SERVER_SOCKET",
  // Embedded-mode routing: the data directory, and the ports of the per-project server bd starts
  // over it. An inherited port dials another project's server exactly as a host/database would.
  "BEADS_DOLT_DATA_DIR",
  "BEADS_DOLT_PORT",
  "BEADS_DOLT_REMOTESAPI_PORT",
];

/** The one credential var bd reads. Scoped per project rather than stripped — see the note above. */
export const BD_PASSWORD_VAR = "BEADS_DOLT_PASSWORD";

/** bd's transport switch. Per project via `dolt_server_tls` — see {@link applyBoardTls}. */
export const BD_TLS_VAR = "BEADS_DOLT_SERVER_TLS";

/**
 * A value as an env-var name fragment: uppercased, every non-alphanumeric run folded to `_`.
 *
 * Deliberately lossy, not reversible: this is the name an OPERATOR types into their shell, and it is
 * documented as derivable by hand (README, DESIGN.md §, the runbook, the /setup skill), which an
 * escaped or hashed encoding would end. The cost is that identities differing only in WHICH
 * non-alphanumerics they use (`db-a.example.com` vs `db.a-example.com`) fold to one token — two
 * hosts one operator would have to own simultaneously, sharing an account name, with different
 * passwords, before it could matter (PR #174 review).
 */
const envToken = (value) => String(value).toUpperCase().replace(/[^A-Z0-9]+/g, "_");

/**
 * The board a bd spawn is being pointed at, as the env scoper needs it. A bare string is the
 * user-only form kept for the many call sites that know nothing else about the target.
 *
 * @param {string|{ user?: string, host?: string, port?: number|string, tls?: boolean }|undefined} board
 */
function asBoard(board) {
  return typeof board === "string" ? { user: board } : (board ?? {});
}

/**
 * The env var holding `user`'s password: `BEADS_DOLT_PASSWORD_<USER>`, uppercased with every
 * non-alphanumeric run folded to `_` so a user like `anton-bot` maps to a legal var name.
 *
 * Keyed by USER alone: the password belongs to the account, so two projects that legitimately share
 * one account need one var, not two copies that can drift apart. When an account name is reused on
 * DIFFERENT servers with different passwords, {@link serverScopedPasswordVar} is the rung above.
 */
export function scopedPasswordVar(user) {
  return `${BD_PASSWORD_VAR}_${envToken(user)}`;
}

/**
 * The env var holding `user`'s password *on this server*:
 * `BEADS_DOLT_PASSWORD_<HOST>_<PORT>_<USER>` — or `undefined` when the board names no host/user.
 *
 * A credential belongs to an account ON a server, and a common account name (`beads`) is exactly
 * what two teams' servers both tend to have. Scoped by user alone, those two passwords collide on
 * one variable and one anton cannot hold both, so every bd call for one project authenticates with
 * the other server's secret (PR #174 review). The port is part of the identity for the same reason
 * the host is: two servers on one box are two servers.
 *
 * @param {string|{ user?: string, host?: string, port?: number|string }} board
 */
export function serverScopedPasswordVar(board) {
  const { user, host, port } = asBoard(board);
  if (!user || !host) return undefined;
  return `${BD_PASSWORD_VAR}_${envToken(host)}${port === undefined ? "" : `_${envToken(port)}`}_${envToken(user)}`;
}

/**
 * The password to hand a bd spawn against `board`, or `undefined` to leave whatever the parent
 * holds — most specific first: this account on THIS server, then the account anywhere, then the
 * ambient `BEADS_DOLT_PASSWORD` (a single shared account is still a valid deployment, and only an
 * operator who has actually created per-project users should see any change).
 *
 * @param {NodeJS.ProcessEnv} parentEnv
 * @param {string|{ user?: string, host?: string, port?: number|string }} board
 */
export function resolveBdPassword(parentEnv, board) {
  const { user } = asBoard(board);
  if (!user) return undefined;
  const perServer = serverScopedPasswordVar(board);
  return (perServer !== undefined ? parentEnv[perServer] : undefined) ?? parentEnv[scopedPasswordVar(user)];
}

/**
 * Apply `board`'s declared transport to `env`, in place.
 *
 * TLS is per project — bd reads `dolt_server_tls` from the target's own `.beads/metadata.json` —
 * but `BEADS_DOLT_SERVER_TLS` outranks that file in bd's precedence, so one anton driving a TLS
 * server and a plaintext one breaks whichever project the ambient value does not describe: TLS
 * requested but server does not support TLS, or its inverse (PR #174 review).
 *
 * So a project that declares a transport gets it, and only a project that declares NONE inherits
 * the ambient setting — which is what keeps the documented single-server `BEADS_DOLT_SERVER_TLS=true`
 * working for boards written before the key existed.
 *
 * @param {NodeJS.ProcessEnv} env mutated
 * @param {string|{ tls?: boolean }} board
 */
export function applyBoardTls(env, board) {
  const { tls } = asBoard(board);
  if (tls === true) env[BD_TLS_VAR] = "true";
  else if (tls === false) delete env[BD_TLS_VAR];
  return env;
}

/**
 * `parentEnv` with project identity stripped, the password narrowed to the target's account, and the
 * transport set from what the target declares — the environment ONE bd invocation against one
 * project gets.
 *
 * `bd-env.ts` layers call-site overrides on top of these same rules for the server; the CLI uses it
 * directly.
 *
 * @param {NodeJS.ProcessEnv} parentEnv
 * @param {string|{ user?: string, host?: string, port?: number|string, tls?: boolean }|undefined} board
 *   the target project's connection (a bare string is its database user)
 */
export function scopeBdEnv(parentEnv, board) {
  const env = { ...parentEnv };
  for (const key of PROJECT_SCOPED_BD_ENV) delete env[key];
  const password = resolveBdPassword(parentEnv, board);
  if (password !== undefined) env[BD_PASSWORD_VAR] = password;
  return applyBoardTls(env, board);
}

/**
 * A bd/git runner bound to `dir` and to `board`'s credentials — the ONE way anton spawns bd against
 * a project it is configuring. The environment carries no project identity of its own, so the
 * target's `.beads/metadata.json` decides which database is opened, while the password and the
 * transport are narrowed to that project's connection (anton-ffmw.1; `bd-env.ts` carries the field
 * report).
 *
 * `opts.exec` short-circuits it, so every caller keeps the injectable seam its tests use.
 *
 * Output is capped at {@link BD_MAX_OUTPUT_BYTES} rather than spawnSync's 1 MiB default: a full
 * `bd list --json` of a few hundred issues already clears 1 MiB, and the default silently truncates
 * to a payload that no longer parses — a board read as unreadable because it is BIG.
 *
 * @param {string} dir cwd for the spawn (the target repo)
 * @param {string|{ user?: string, host?: string, port?: number|string, tls?: boolean }|undefined} board
 *   the project's connection (a bare string is its database user)
 * @param {{ exec?: (cmd: string, args: string[], timeoutMs?: number) => { status: number|null, stdout?: string, stderr?: string },
 *   env?: NodeJS.ProcessEnv }} [opts]
 */
/** Per-stream output ceiling for a spawned bd, matching the 64 MiB the TypeScript wrappers use. */
const BD_MAX_OUTPUT_BYTES = 64 * 1024 * 1024;

export function scopedBdRunner(dir, board, opts = {}) {
  if (opts.exec) return opts.exec;
  const env = scopeBdEnv(opts.env ?? process.env, board);
  return (cmd, args, timeoutMs = budgetMs("bd")) =>
    spawnSync(cmd, args, {
      cwd: dir,
      encoding: "utf8",
      env,
      timeout: timeoutMs,
      killSignal: SPAWN_KILL_SIGNAL,
      maxBuffer: BD_MAX_OUTPUT_BYTES,
    });
}

/**
 * Which env var must hold `user`'s password — the per-user form when the project names a user, the
 * shared fallback otherwise. Naming the wrong one is the difference between a one-line fix and a
 * lost hour, so every "cannot reach the server" message routes through here (`bd-env.ts` wraps it
 * for the server, which looks the user up from a repo path).
 *
 * The per-SERVER rung ({@link serverScopedPasswordVar}) is deliberately not listed here: it only
 * matters when one account name is reused across servers, and naming three variables in every
 * connection failure buries the one an ordinary deployment needs. `anton server-mode` names it
 * where that case actually shows up.
 */
export function passwordVarHint(user) {
  return user ? `${scopedPasswordVar(user)} (or ${BD_PASSWORD_VAR})` : BD_PASSWORD_VAR;
}

/**
 * The configured server as an operator reads it — `host:port/database`, with `?` standing in for a
 * field the project never declared (an undeclared host is itself a cause, and hiding it sends the
 * reader looking for a network fault that isn't there). Shared with the runtime preflight in
 * `bd.ts` so both failures name the same target the same way.
 *
 * @param {{ host?: string, port?: number|string, database?: string }} [connection]
 */
export function formatServerTarget(connection = {}) {
  const { host, port, database } = connection;
  return `${host ?? "?"}:${port ?? "?"}${database ? `/${database}` : ""}`;
}

/**
 * `bd dolt test` against the shared server `connection` names — the one probe that answers "can this
 * machine reach this project's board at all". Returns `{ ok: true }` or `{ ok: false, detail }`;
 * never throws, because callers gate a bootstrap on it.
 *
 * Spawned under the project-scoped environment, like every other bd call anton makes: an ambient
 * `BEADS_DOLT_*` would otherwise have this verify some OTHER project's server (anton-ffmw.1).
 *
 * @param {string} dir repo root
 * @param {{ host?: string, port?: number, user?: string, database?: string, tls?: boolean }} connection
 * @param {{ exec?: (cmd: string, args: string[], timeoutMs?: number) => { status: number|null, stdout?: string, stderr?: string },
 *   env?: NodeJS.ProcessEnv }} [opts]
 */
export function checkSharedServer(dir, connection = {}, opts = {}) {
  const ms = budgetMs("network");
  const exec = scopedBdRunner(dir, connection, opts);

  const r = exec("bd", ["dolt", "test"], ms);
  if ((r?.status ?? 1) === 0) return { ok: true };
  return { ok: false, detail: failureDetail(r, ms, `${r?.stdout ?? ""}${r?.stderr ?? ""}`) };
}

/** The config.yaml keys anton's team-config enforces on an EMBEDDED board — the default profile,
 * and the Dolt-first model (see `teamConfigKeys` for the server-mode one). `dolt.auto-push false`
 * because anton owns push cadence (write-nudged full passes, pull-only heartbeats): bd 1.0.2
 * auto-pushes after every write once a remote named `origin` exists, which both double-pushes
 * and re-creates the concurrent-push manifest-corruption risk (beads GH#2466) anton avoids.
 *
 * `export.auto false` and `export.git-add false` are DISTINCT knobs and both are needed (anton-1th):
 *   - export.auto governs whether bd regenerates the JSONL snapshot at all. Left at its default
 *     (true), ordinary commands (bd ready/show) periodically rewrite issues.jsonl + export-state.json
 *     once the export interval elapses — working-tree churn and latency for a file we only keep as a
 *     passive recovery artifact.
 *   - export.git-add only governs whether that regenerated snapshot is auto-STAGED. It does not stop
 *     the regeneration, so on its own it leaves the churn/latency in place.
 * Team sync never travels through the JSONL — it flows through Dolt over refs/dolt/data (bd dolt
 * commit/push/pull) — so disabling the automatic export costs nothing. Manual `bd export` stays
 * available for explicit recovery or interchange.
 *
 * `export.auto false` is enforced FIRST: `bd config set` writes are themselves ordinary bd commands,
 * so a drifted earlier key (e.g. dolt.auto-commit off on an existing workspace) would, while
 * export.auto is still at its default (true), regenerate the JSONL snapshot as a side effect of its
 * own write. Disabling auto-export up front closes that window so the enforcement pass never emits
 * the very churn it exists to stop. */
export const EMBEDDED_CONFIG_KEYS = [
  ["export.auto", "false"],
  ["dolt.auto-commit", "on"],
  ["export.git-add", "false"],
  ["dolt.auto-push", "false"],
];

/**
 * The server-mode profile (anton-4gd2). Everything the embedded profile enforces about
 * refs/dolt/data — `dolt.auto-push`, and the passive JSONL export that exists to back it
 * (`export.auto`, `export.git-add`) — describes a sync channel a shared-server board does not have,
 * so anton does not impose it: `bd dolt push/pull` runs ON THE SERVER, which cannot reach the git
 * remote at all (DESIGN.md §3a). What survives is `dolt.auto-commit`: each write still becomes a
 * Dolt commit, which is what gives the team a history on the shared database.
 *
 * `backup.enabled false` is the same class as those knobs (anton-0tul). bd's Dolt-native auto-backup
 * registers a backup remote before each backup, and in server mode that registration runs ON THE
 * SERVER as the project's database account — which is not privileged to do it, so every single bd
 * write ends in `Warning: auto-backup failed: register backup remote: … command denied to user`.
 * The warning is noise, not data risk (the write itself landed on the shared database), and noise on
 * every write is how an operator learns to stop reading warnings. bd's own default is already false;
 * pinning it is what keeps an inherited setting — or a future default flip — from re-creating that.
 * It is enforced FIRST because each `bd config set` is itself a bd write, so a profile pass over a
 * board that HAS auto-backup on would otherwise emit the very warning it exists to stop.
 *
 * Enforcement only ever ADDS keys, so a board moved from embedded keeps the export knobs it already
 * carries — this is the profile for a project that has never been anything but server-mode.
 */
export const SERVER_CONFIG_KEYS = [
  ["backup.enabled", "false"],
  ["dolt.auto-commit", "on"],
];

/** The config.yaml keys enforced for `mode`. Embedded is the default and the fallback. */
export function teamConfigKeys(mode) {
  return mode === "server" ? SERVER_CONFIG_KEYS : EMBEDDED_CONFIG_KEYS;
}

/**
 * The shared server's connection, as `bd dolt set <key>` names each field. Written from
 * `.beads/metadata.json` (the per-directory truth) into `.beads/config.yaml` as `dolt.<key>`, so a
 * teammate's clone inherits the target instead of being told to type it — config.yaml is bd's
 * lowest-priority source, which is what makes it the right place for a team DEFAULT.
 *
 * `required` marks what a board cannot connect without: no host and no database is not a default to
 * fall back on, it is a broken server config, and it is reported as an error rather than skipped.
 * `port` is required for the same reason DESIGN.md §3a insists it stay in metadata.json despite bd's
 * deprecation warning — absent it, bd dials port 0 against a remote host. `user` is optional: bd
 * defaults to `root`, which is a real (if unadvisable) single-account setup — but an optional field
 * metadata.json drops is RETRACTED from config.yaml rather than left standing, see
 * {@link retractStaleConnectionKey}.
 */
const SERVER_CONNECTION_KEYS = [
  { key: "host", metaKey: "dolt_server_host", required: true },
  { key: "port", metaKey: "dolt_server_port", required: true },
  { key: "database", metaKey: "dolt_database", required: true },
  { key: "user", metaKey: "dolt_server_user", required: false },
];

/**
 * Every dotted `config.yaml` key a switch INTO `mode` may write — the team-config knobs plus, in
 * server mode, the `dolt.*` connection fields (published on the way in, retracted when
 * metadata.json stops declaring one).
 *
 * This is what lets a rollback tell its own writes from somebody else's edit (PR #174 review). bd
 * patches config.yaml key by key — `bd config set` appends one line, `bd dolt set --update-config`
 * one per field, `bd config unset` strikes one out — so a difference under any OTHER key was made
 * by something that is not this run, and is not a difference a revert may quietly overwrite.
 */
export function publishedConfigKeys(mode) {
  const team = teamConfigKeys(mode).map(([key]) => key);
  return mode === "server" ? [...team, ...SERVER_CONNECTION_KEYS.map(({ key }) => `dolt.${key}`)] : team;
}

/**
 * Retract a `dolt.<key>` config.yaml still publishes for an OPTIONAL field metadata.json no longer
 * declares, reported as `{ name, status: "unset" | "cleared" | "failed", detail? }`.
 *
 * Skipping it is not enough. metadata.json outranks config.yaml but does not erase it, so a
 * leftover `dolt.user: beads` keeps bd connecting as that account while anton — which reads the
 * connection from metadata.json — scopes the spawn's credentials as if no user were configured. The
 * bd call then authenticates as the wrong account, or fails outright (PR #174 review). Both files
 * are committed, so the stale key travels to every clone until someone notices.
 *
 * `bd config unset` first, because config.yaml is bd's file — then our own strike-out, because bd
 * only rewrites the FLAT encoding while reporting success either way, so a key under the nested
 * `dolt:` map bd itself writes since 1.1.0 survives an exit-0 "Unset dolt.user (in config.yaml)".
 * The verdict is read back from the FILE for that reason: a value that outlives both is reported as
 * a failure naming the hand fix, never assumed gone.
 */
export function retractStaleConnectionKey(beadsDir, key, metaKey, exec, timeoutMs) {
  const path = `dolt.${key}`;
  const stale = configYamlValue(beadsDir, path);
  if (stale === undefined) return { name: path, status: "unset" };

  exec("bd", ["config", "unset", path], timeoutMs);
  if (configYamlValue(beadsDir, path) !== undefined) retractConfigYamlKey(beadsDir, path);

  const left = configYamlValue(beadsDir, path);
  const declares = `.beads/metadata.json declares no "${metaKey}"`;
  return left === undefined
    ? { name: path, status: "cleared", detail: `dropped stale ${path}: ${stale} — ${declares}` }
    : {
        name: path,
        status: "failed",
        detail: `.beads/config.yaml still publishes ${path}: ${left} but ${declares} — remove that line by hand`,
      };
}

/**
 * The OPTIONAL connection keys `.beads/config.yaml` still publishes that `info` no longer declares
 * — exactly what {@link retractStaleConnectionKey} would clear, named before anything is written.
 *
 * Separated from the retraction itself so a caller that has to snapshot config.yaml for a rollback
 * only pays for the snapshot when there is in fact a write coming, and so the retraction can be
 * ordered ahead of a connection PROBE rather than behind it (`server-mode.mjs`): a stale
 * `dolt.user` makes bd authenticate as the wrong account, so a probe run before the retraction
 * tests the wrong identity and fails a switch that would have worked.
 *
 * @param {string} beadsDir `<dir>/.beads`
 * @param {{ host?: string, port?: number, user?: string, database?: string }} info from readDoltMetadata
 */
export function staleConnectionKeys(beadsDir, info) {
  return SERVER_CONNECTION_KEYS.filter(({ key, required }) => {
    const raw = info?.[key];
    const declared = !(raw === undefined || raw === null || raw === "");
    return !required && !declared && configYamlValue(beadsDir, `dolt.${key}`) !== undefined;
  });
}

/**
 * Publish the server-mode connection from `.beads/metadata.json` to `.beads/config.yaml` as the
 * team-wide default, via bd's own primitive: `bd dolt set <key> <value> --update-config` (it writes
 * BOTH files, keeping them from drifting apart). Idempotent — a key config.yaml already carries is
 * not re-set, so a re-run is a true no-op.
 *
 * Server mode only. `bd dolt set` refuses outright in embedded mode ("not supported in embedded
 * mode (no Dolt server)"), so calling it there would turn a healthy embedded board into a wall of
 * failed steps.
 *
 * Returns one `{ name, status, detail? }` step per field: "already" | "set" | "failed" | "missing"
 * (required, absent from metadata) | "unset" (optional, published nowhere) | "cleared" (optional,
 * retracted from config.yaml — see {@link retractStaleConnectionKey}).
 *
 * @param {string} dir repo root
 * @param {string} beadsDir `<dir>/.beads`
 * @param {{ host?: string, port?: number, user?: string, database?: string }} info from readDoltMetadata
 * @param {{ exec?: (cmd: string, args: string[], timeoutMs?: number) => { status: number|null, stdout?: string, stderr?: string } }} [opts]
 */
export function ensureDoltConnection(dir, beadsDir, info, opts = {}) {
  const localMs = budgetMs("bd");
  const exec =
    opts.exec ??
    ((cmd, args, timeoutMs = localMs) =>
      spawnSync(cmd, args, { cwd: dir, encoding: "utf8", timeout: timeoutMs, killSignal: SPAWN_KILL_SIGNAL }));

  return SERVER_CONNECTION_KEYS.map(({ key, metaKey, required }) => {
    const raw = info?.[key];
    if (raw === undefined || raw === null || raw === "") {
      // Named as the fix, not as the symptom: what to add, and where.
      return required
        ? { name: `dolt.${key}`, status: "missing", detail: `server mode declares no "${metaKey}" in .beads/metadata.json` }
        : retractStaleConnectionKey(beadsDir, key, metaKey, exec, localMs);
    }
    const want = String(raw);
    const name = `dolt.${key}=${want}`;
    if (configYamlHas(beadsDir, `dolt.${key}`, want)) return { name, status: "already" };
    const r = exec("bd", ["dolt", "set", key, want, "--update-config"], localMs);
    if ((r.status ?? 1) === 0) return { name, status: "set" };
    return { name, status: "failed", detail: failureDetail(r, localMs, `${r.stdout ?? ""}${r.stderr ?? ""}`) };
  });
}

/**
 * The ONE reconciled `bd init` flag set shared by every anton init path — `configureBeadsForRepo`
 * (anton init / addProject) and the `/setup` skill (skills/setup/SKILL.md keeps its prose in sync).
 * There used to be two divergent sets; converging them avoids the surprise where a repo initialized
 * from the CLI differs from one scaffolded by `/setup`.
 *
 *   --non-interactive     never drop into a setup wizard (auto-detected under CI/non-TTY, passed
 *                         explicitly so init is safe however it's invoked).
 *   --skip-hooks          bd's native hooks install repoints core.hooksPath at .beads/hooks, which
 *                         silently CLOBBERS an existing husky/lefthook/custom-hooksPath setup. Skip
 *                         it — anton pushes Dolt explicitly on every write, so the hydration hooks
 *                         are redundant here anyway (see detectHooksManager).
 *   --skip-agents         a bare `bd init` writes/overwrites AGENTS.md; never edit the repo's agent
 *                         instructions uninvited (the /setup skill proposes a pointer under consent).
 *   --dolt-auto-commit on commit-after-each-write from the very first write, matching the portable
 *                         dolt.auto-commit=on later enforced in .beads/config.yaml (CONFIG_KEYS).
 */
export const BD_INIT_FLAGS = ["--non-interactive", "--skip-hooks", "--skip-agents", "--dolt-auto-commit", "on"];

/**
 * True when `.beads/` carries a LOCAL Dolt database (the workspace's runtime state), not just the
 * committed config. The Dolt runtime lives in `.beads/dolt/` (or `.beads/embeddeddolt/`) and is
 * gitignored, so a FRESH CLONE arrives with a committed `.beads/config.yaml` but no DB — that
 * absence is the signal that the clone needs `bd bootstrap` to hydrate from origin's refs/dolt/data
 * before any other bd command (config set, dolt remote add) can run against it.
 */
export function hasLocalDoltDb(beadsDir) {
  return existsSync(join(beadsDir, "dolt")) || existsSync(join(beadsDir, "embeddeddolt"));
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

/** The only benign `bd dolt pull` failure: the remote has never published refs/dolt/data. */
const FIRST_PUBLISH_PULL_OUTPUT = [
  /no branches found in remote/i,
  /(?:could ?n['’]t|could not) find remote ref/i,
  /remote ref .*does not exist/i,
  /remote ref .*not found/i,
];

export function isFirstPublishPullOutput(output) {
  return FIRST_PUBLISH_PULL_OUTPUT.some((re) => re.test(output));
}

/**
 * Wire the git-backed Dolt remote for `repoDir`, reusing bd's own `dolt` subcommands — no new sync
 * code. beads stores issues in Dolt and syncs them over the git remote as `refs/dolt/data`; adding
 * the remote points `bd dolt push/pull` at the repo's `origin` URL (bd records it as `git+<url>`).
 *
 * The single Dolt-sync path shared by `anton setup` (bin/anton.mjs) and `anton init`/`addProject`
 * (via configureBeadsForRepo) so both wire the remote with IDENTICAL behavior + result shape
 * (anton-8qx). All external calls go through an injectable `exec` seam so tests can stub bd/git
 * (CI has neither); the default binds `repoDir` as cwd.
 *
 * Steps (idempotent): remote add → hydrate pull → publish push. The pull is best-effort — a fresh
 * origin has no `refs/dolt/data` yet, so it exits non-zero ("no branches found"); that's expected on
 * the first machine, not an error. The push is VERIFIED (the ref must actually land on origin) and
 * RETRIED a bounded number of times; it stays NON-fatal so first-time setup without push access still
 * completes the local wiring, but a failed FIRST publish (`firstPublish:true`) is surfaced LOUD so an
 * empty remote never passes silently. Dolt remotes live in `.beads/dolt/` (gitignored), so this must
 * run once per machine — a clone doesn't inherit the remote config.
 *
 * Returns `{ status, ... }`:
 *   - { status: "no-workspace" }                — no `.beads/` (nothing to wire)
 *   - { status: "server-mode" }                 — the board lives on a shared Dolt server (anton-4gd2)
 *   - { status: "no-remote" }                   — no declared/origin remote to use
 *   - { status: "already", url }                — Dolt `origin` already points here
 *   - { status: "configured", url, pulled, pushed, pushAttempts, firstPublish, pushOutput } — remote
 *       (re)pointed; pull + verified/retried push attempted. `pushed:false` reports a push that could
 *       not land after `pushAttempts` tries (non-fatal); `firstPublish:true` means the remote is still
 *       empty and the failure must be surfaced loud.
 *   - { status: "error", detail }               — reading `sync.remote`, or `bd dolt remote add`
 *       itself, failed (a budget kill included — never a silent fallback to git origin)
 *
 * @param {{ repoDir: string, log?: (msg: string) => void, exec?: (cmd: string, args: string[], timeoutMs?: number) => { status: number|null, stdout?: string, stderr?: string } }} opts
 */
export function configureBeadsDoltSync(opts = {}) {
  const { repoDir: dir, log } = opts;
  const emit = typeof log === "function" ? log : () => {};
  // Budgets are per call (a local `bd config get` is not a network `bd dolt push`); an injected test
  // exec simply ignores the third argument, so the seam is unchanged for callers that stub it.
  const localMs = budgetMs("bd");
  const netMs = budgetMs("network");
  const exec =
    opts.exec ??
    ((cmd, args, timeoutMs = netMs) =>
      spawnSync(cmd, args, {
        cwd: dir,
        encoding: "utf8",
        timeout: timeoutMs,
        killSignal: SPAWN_KILL_SIGNAL,
      }));

  if (!existsSync(join(dir, ".beads"))) return { status: "no-workspace" };

  // A shared-server board has no refs/dolt/data to wire, and the attempt does not merely waste work:
  // `bd dolt push/pull` executes ON THE SERVER, whose image ships no ssh client and no keys, so a
  // `git+ssh://` remote is unreachable from there by construction (DESIGN.md §3a). Skipping is the
  // config, not a degradation — the runtime sync nudges are neutralized separately (anton-0tul).
  if (readDoltMetadata(dir).mode === "server") {
    emit("board is on a shared Dolt server — skipping refs/dolt/data remote wiring (nothing to reconcile).");
    return { status: "server-mode" };
  }

  // Remote choice is dynamic per project: a `sync.remote` declared in .beads/config.yaml (e.g. an
  // aws:// remote) wins over the git-origin fallback — anton drives whatever the project's beads
  // config declares, it never forces git-origin over a declared remote. NOTE `bd config get` exits 0
  // with "sync.remote (not set in config.yaml)" when unset — parse the text, never the exit code.
  const cfg = exec("bd", ["config", "get", "sync.remote"], localMs);
  // A killed probe flushes no output, which would read exactly like "not set" and silently wire the
  // git origin over a deliberately declared remote. Fail loud instead — the budget kill is the news.
  if (timedOut(cfg)) return { status: "error", detail: failureDetail(cfg, localMs, "") };
  const cfgOut = ((cfg.status ?? 1) === 0 ? (cfg.stdout ?? "") : "").trim();
  const declared = /\(not set/i.test(cfgOut)
    ? undefined
    : cfgOut.split(/\s+/).find((t) => /^[a-z+]+:\/\//i.test(t) || t.startsWith("git@"));

  let url = declared;
  if (!url) {
    const origin = exec("git", ["remote", "get-url", "origin"], budgetMs("probe"));
    url = (origin.stdout ?? "").trim();
    if ((origin.status ?? 1) !== 0 || !url) return { status: "no-remote" };
  }

  // Only a no-op when the existing Dolt remote already points at THIS url. A repo first wired to
  // git origin and later given a declared `sync.remote` (e.g. aws://) must be re-pointed, not left
  // pulling/pushing the stale remote — otherwise the declared shared backlog is silently ignored
  // (anton-live-sync review). `bd dolt remote list` prints `<name>  <url>` lines; `bd dolt remote
  // add` upserts, so the add below re-points a stale url.
  const list = exec("bd", ["dolt", "remote", "list"], localMs);
  const existing = ((list.stdout ?? "").match(/^origin\s+(\S+)$/m) ?? [])[1];
  if (existing && normalizeRemoteUrl(existing) === normalizeRemoteUrl(url)) {
    emit("Dolt remote 'origin' already configured — no-op.");
    return { status: "already", url };
  }
  if (existing) emit(`Dolt remote 'origin' points at ${existing} — repointing to ${url}`);
  else if (declared) emit(`sync.remote declared in beads config — wiring ${declared}`);

  const add = exec("bd", ["dolt", "remote", "add", "origin", url], localMs);
  if ((add.status ?? 1) !== 0) {
    return { status: "error", detail: failureDetail(add, localMs, `${add.stdout ?? ""}${add.stderr ?? ""}`) };
  }
  emit(`bd dolt remote add origin ${url}`);

  // Hydrate before publishing: with the JSONL exports untracked (anton-hg9), a fresh clone's board
  // comes from refs/dolt/data, not from files in the clone. Fails benignly when the remote has no
  // refs/dolt/data yet (first setup ever) — the push below then publishes it.
  const pull = exec("bd", ["dolt", "pull"], netMs);
  const pulled = (pull.status ?? 1) === 0;
  const pullOutput = `${pull.stdout ?? ""}${pull.stderr ?? ""}`.trim();
  const firstPublish = !pulled && isFirstPublishPullOutput(pullOutput);
  if (!pulled && !firstPublish) {
    const detail = failureDetail(pull, netMs, pullOutput);
    emit(`bd dolt pull — failed: ${detail}`);
    return { status: "error", detail: `bd dolt pull failed: ${detail}` };
  }
  emit(pulled ? "bd dolt pull — hydrated from origin" : "bd dolt pull — nothing to hydrate yet");

  // Publish: push local Dolt commits so refs/dolt/data lands on origin for the next machine. A
  // FAILED FIRST publish (the remote had no refs/dolt/data to hydrate from) is the dangerous case —
  // it leaves an EMPTY remote, so the next clone/machine finds nothing to bootstrap from. So the
  // push is VERIFIED (the ref must actually appear on origin) and RETRIED a bounded number of times,
  // reconciling with a pull between attempts. A push that still can't land stays NON-fatal (the local
  // wiring is done, anton-8qx) but is surfaced LOUD via `firstPublish` so it's retried once auth/
  // network is up rather than silently leaving the remote empty.
  // Only the git-origin path is verifiable with `git ls-remote origin refs/dolt/data`: a declared
  // non-git `sync.remote` (e.g. aws://) pushes Dolt data somewhere git can't inspect, so there we
  // trust bd's exit code rather than falsely flagging an empty remote.
  const verifyViaGitOrigin = !declared;
  const MAX_PUSH_ATTEMPTS = 3;
  let push;
  let pushed = false;
  let pushAttempts = 0;
  while (pushAttempts < MAX_PUSH_ATTEMPTS) {
    pushAttempts++;
    push = exec("bd", ["dolt", "push"], netMs);
    if ((push.status ?? 1) === 0) {
      // Confirm the ref really landed — `bd dolt push` can exit 0 as a no-op. If the check can't run
      // (offline / local test remote), trust bd's exit code rather than falsely flagging failure.
      if (!verifyViaGitOrigin) {
        pushed = true;
      } else {
        const ls = exec("git", ["ls-remote", "origin", "refs/dolt/data"], netMs);
        // Verification must fail closed: an unreachable/auth-failing remote cannot prove the ref
        // landed, even when `bd dolt push` itself returned zero.
        pushed = (ls.status ?? 1) === 0 && /\S/.test((ls.stdout ?? "").trim());
      }
      if (pushed) break;
    }
    // Reconcile before retrying — a concurrent writer may have advanced refs/dolt/data.
    if (pushAttempts < MAX_PUSH_ATTEMPTS) exec("bd", ["dolt", "pull"], netMs);
  }
  const pushOutput = `${push.stdout ?? ""}${push.stderr ?? ""}`.trim();
  emit(
    pushed
      ? `bd dolt push — published refs/dolt/data to origin${pushAttempts > 1 ? ` (after ${pushAttempts} attempts)` : ""}`
      : firstPublish
        ? `bd dolt push — FIRST publish failed after ${pushAttempts} attempts; origin has no refs/dolt/data yet — retry with \`bd dolt pull && bd dolt push\``
        : `bd dolt push — failed after ${pushAttempts} attempts (non-fatal); retry with \`bd dolt pull && bd dolt push\``,
  );

  return { status: "configured", url, pulled, pushed, pushAttempts, firstPublish, pushOutput };
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
 * Run the full beads team-config path for `dir`, idempotently. Steps: workspace creation
 * (`bd init` when `.beads/` is absent, `bd bootstrap` for a fresh clone with no local Dolt DB, else
 * no-op) → config.yaml enforcement → `.beads/.gitignore` → formulas (bead skeleton + run pipeline) →
 * Dolt remote wiring. Every step is best-effort and its outcome is collected in `steps`/`errors`
 * rather than thrown — the caller decides how loud to be (the CLI prints each step; addProject logs
 * a summary) and a step failure never aborts the caller.
 *
 * The steps that describe refs/dolt/data — hydrating a fresh clone, the enforced sync knobs, the
 * remote wiring — are the EMBEDDED profile. A server-mode board (DESIGN.md §3a) gets its connection
 * published as the team default instead; see `teamConfigKeys` / `ensureDoltConnection` (anton-4gd2).
 * That publication is one of the three FATAL steps (with `bd init` and `bd bootstrap`): a connection
 * that did not reach config.yaml leaves the next clone dialling nothing, or an older server.
 *
 * Returns:
 *   { configured, skipped, reason?, mode, ranInit, ranBootstrap, steps: [{name,status,detail?}], errors, hasBeads }
 *
 * When prereqs aren't met (no bd / not a git repo / no origin) it returns early with
 * `{ configured:false, skipped:true, reason, hasBeads }` and does nothing — so calling it on a plain
 * directory is a safe no-op.
 *
 * @param {string} dir absolute path to the target repo
 * @param {{ prefix?: string|null, log?: (msg: string) => void, appRoot?: string, env?: NodeJS.ProcessEnv,
 *   exec?: (cmd: string, args: string[], timeoutMs?: number) => { status: number|null, stdout?: string, stderr?: string } }} [opts]
 *   `env` is the parent environment every bd spawn is scoped from (default `process.env`); `exec`
 *   replaces the spawn entirely, the seam the unit tests drive.
 *   `appRoot` anchors the bundled formula assets. Default: this module's package root — right
 *   for the CLI, which runs from anywhere. A caller inside the Next server bundle MUST pass its
 *   own anchor (`process.cwd()`): there `import.meta.url` points at a build chunk, so the default
 *   resolves nowhere and registration reports `missing-asset` instead of installing the formula.
 */
export function configureBeadsForRepo(dir, opts = {}) {
  const { prefix = null, log, appRoot } = opts;
  const emit = typeof log === "function" ? log : () => {};
  const beadsDir = join(dir, ".beads");
  const steps = [];
  const errors = [];

  // Which profile applies. Read once, up front: every branch below is the same decision, and a
  // repo with no `.beads/` yet reads as embedded — which is right, since `bd init` creates exactly
  // that (server mode is opt-in, entered by editing metadata.json).
  const { mode, ...connection } = readDoltMetadata(dir);

  // Every bd below runs under THIS project's identity, never anton's ambient `BEADS_DOLT_*` — which
  // is whatever board the launch directory's .envrc last exported, and outranks the target's own
  // metadata.json in bd's precedence (anton-ffmw.1). Built once, from the connection just read, so
  // init, bootstrap and the config writes all address the same database with the same credentials.
  const exec = scopedBdRunner(dir, connection, opts);

  // The preflight runs through the SAME runner as everything below it. Its server-mode leg spawns a
  // real `bd dolt test`, so left unscoped it would probe with `process.env` — reporting a board
  // unreachable whenever the password lives only in `opts.env`, and reaching the host CLI even when
  // the caller injected an executor precisely to avoid that.
  const pre = beadsPrereqs(dir, { ...opts, exec });
  if (!pre.ok) {
    return {
      configured: false,
      skipped: true,
      reason: pre.error.message,
      mode,
      ranInit: false,
      steps,
      errors,
      hasBeads: existsSync(beadsDir),
    };
  }

  // Capture core.hooksPath BEFORE bd init — bd's hooks install overwrites it with .beads/hooks, so a
  // husky/lefthook (or bare custom) override is only observable here (anton-43b). A read we couldn't
  // complete is said out loud: the manager-artifact scan below still runs, but a bare custom override
  // would go unseen, and silence would read as "checked, nothing there".
  const priorHooksPath = gitConfigGet(dir, "core.hooksPath");
  if (priorHooksPath === null) {
    emit("could not read core.hooksPath (git config timed out) — a custom hooks override may go undetected.");
    steps.push({ name: "core.hooksPath", status: "unknown", detail: "git config --get timed out" });
  }

  // 1. Bring a Dolt workspace into being, choosing the right entry point for the repo's state:
  //    - no .beads/ at all              → `bd init` (reconciled BD_INIT_FLAGS)
  //    - .beads/ committed but no DB    → FRESH CLONE: `bd bootstrap` hydrates the DB + wires the
  //                                       Dolt remote from origin's refs/dolt/data (the gitignored
  //                                       .beads/dolt/ never travels with the clone).
  //    - .beads/ with a local Dolt DB   → existing workspace: enforce team-config only, no re-init.
  //    A failure in either creation path is fatal for this run (nothing downstream can apply without
  //    a workspace) but collected, not thrown. NOTE: bd's global `-C` mis-resolves for init/bootstrap
  //    ("no beads project found"); run with the target as cwd instead — equivalent, and it works. (bd 1.0.4)
  let ranInit = false;
  let ranBootstrap = false;
  if (!existsSync(beadsDir)) {
    const initArgs = ["init", ...BD_INIT_FLAGS];
    if (prefix) initArgs.push("--prefix", prefix);
    emit(`bd ${initArgs.join(" ")}`);
    // The long budget: init creates the Dolt workspace and can reach the remote.
    const initMs = budgetMs("network");
    const r = exec("bd", initArgs, initMs);
    if ((r.status ?? 1) !== 0) {
      const detail = failureDetail(r, initMs, r.stderr || r.stdout || "");
      steps.push({ name: "bd init", status: "failed", detail });
      errors.push(`bd init failed: ${detail}`);
      return { configured: false, skipped: false, mode, ranInit: false, steps, errors, hasBeads: existsSync(beadsDir) };
    }
    ranInit = true;
    steps.push({ name: "bd init", status: "ok" });
  } else if (mode === "server") {
    // A server-mode board keeps NO local Dolt DB — the database is the shared server — so the
    // missing `.beads/dolt/` is the steady state here, not the fresh-clone signal it is on embedded.
    // Bootstrapping would hydrate from refs/dolt/data, which this board does not use.
    emit(".beads/ present and the board is on a shared Dolt server — enforcing team-config only (no bootstrap).");
    steps.push({ name: "bd init", status: "already" });
  } else if (!hasLocalDoltDb(beadsDir)) {
    emit("bd bootstrap --non-interactive (fresh clone — hydrating the Dolt DB from origin)");
    // Hydrating a fresh clone pulls the whole board over refs/dolt/data — the long budget.
    const bootstrapMs = budgetMs("network");
    const r = exec("bd", ["bootstrap", "--non-interactive"], bootstrapMs);
    if ((r.status ?? 1) !== 0) {
      const detail = failureDetail(r, bootstrapMs, r.stderr || r.stdout || "");
      steps.push({ name: "bd bootstrap", status: "failed", detail });
      errors.push(`bd bootstrap failed: ${detail}`);
      return { configured: false, skipped: false, mode, ranInit: false, steps, errors, hasBeads: existsSync(beadsDir) };
    }
    ranBootstrap = true;
    steps.push({ name: "bd bootstrap", status: "ok" });
    // A freshly hydrated clone never ran the local writes / post-pull scoped recompute that
    // maintain the denormalized `is_blocked` flag, so it can arrive stale — and `bd ready` trusts
    // that flag, silently hiding ready work or surfacing blocked work (bd 1.1.0). Repair it once,
    // right after bootstrap. Best-effort: idempotent on a consistent DB, and a failure here must
    // never abort an otherwise-good clone setup. timeout: a hung recompute (e.g. a Dolt DB lock)
    // must not stall the configure flow — the kill surfaces as rc.error/non-zero, i.e. "skipped".
    const rc = exec("bd", ["recompute-blocked"], budgetMs("bd"));
    steps.push({ name: "bd recompute-blocked", status: (rc.status ?? 1) === 0 ? "ok" : "skipped" });
  } else {
    emit(".beads/ present with a local Dolt DB — enforcing team-config only (no re-init).");
    steps.push({ name: "bd init", status: "already" });
  }

  // 2. Patch config.yaml idempotently (never clobber), with the profile this board's mode calls for.
  for (const [key, want] of teamConfigKeys(mode)) {
    const status = ensureBdConfig(dir, beadsDir, key, want, { exec });
    steps.push({ name: `${key}=${want}`, status });
    if (status === "failed") {
      emit(`could not set ${key}=${want}`);
      errors.push(`could not set ${key}=${want}`);
    } else {
      emit(`${key}=${want} (${status})`);
    }
  }

  // 2b. Server mode only: publish the connection as the team-wide default so a teammate's clone
  //     inherits the target instead of being told to type it. A required field missing from
  //     metadata.json is an ERROR, not a silence — the board cannot reach its server without it.
  //     And it FAILS the run, unlike the portable keys above: an unpublished connection is not a
  //     degraded config, it is the wrong one. config.yaml is either missing the target or still
  //     carrying an earlier server's, so the next clone connects somewhere else or not at all —
  //     reported as `configured: true`, that is `anton init` exiting 0 over a board nobody can
  //     reach (PR #174 review). Return here rather than collecting: everything below runs bd
  //     against a database this project has just proved it cannot address.
  if (mode === "server") {
    let published = true;
    for (const step of ensureDoltConnection(dir, beadsDir, connection, { exec })) {
      steps.push(step);
      if (step.status === "missing" || step.status === "failed") {
        emit(`${step.name} — ${step.detail}`);
        errors.push(step.detail);
        published = false;
      } else {
        emit(`${step.name} (${step.status})`);
      }
    }
    if (!published) {
      return { configured: false, skipped: false, mode, ranInit, ranBootstrap, steps, errors, hasBeads: existsSync(beadsDir) };
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

  // 3b. .gitignore only suppresses UNTRACKED files — a repo that committed an export before the
  // ignore existed keeps shipping it. Untrack them for real (anton-vqgw).
  const ut = untrackBeadsExports(dir);
  if (ut.error) {
    errors.push(`could not untrack committed beads exports: ${ut.error}`);
    steps.push({ name: "untrack exports", status: "failed", detail: ut.error });
  } else if (ut.untracked.length) {
    emit(`untracked (staged for removal): ${ut.untracked.join(", ")}`);
    steps.push({ name: "untrack exports", status: "set", detail: ut.untracked.join(", ") });
  } else {
    steps.push({ name: "untrack exports", status: "already" });
  }

  // 3c. Install anton's formulas: the bead skeleton, so every bead this project creates starts
  //     contract-shaped (anton-8mnr), and the run pipeline anton walks (anton-hrql). No-clobber —
  //     a project that tuned either one keeps it.
  for (const asset of [
    { label: "bead formula", filename: BEAD_FORMULA_FILENAME, src: bundledBeadFormulaPath(appRoot), install: ensureBeadFormula },
    { label: "run formula", filename: RUN_FORMULA_FILENAME, src: bundledRunFormulaPath(appRoot), install: ensureRunFormula },
  ]) {
    const formula = asset.install(beadsDir, asset.src);
    steps.push({ name: asset.label, status: formula.status, detail: formula.detail });
    if (formula.status === "missing-asset") {
      emit(`${asset.label} asset missing from this install (${asset.src}) — skipping.`);
    } else if (formula.status === "no-workspace") {
      // Only reachable if the init/bootstrap above reported success without producing `.beads/`.
      emit(`no .beads workspace to install the ${asset.label} into — skipping.`);
    } else if (formula.status === "failed") {
      emit(`could not install the ${asset.label}: ${formula.detail}`);
      errors.push(`could not install the ${asset.label}: ${formula.detail}`);
    } else {
      emit(`.beads/formulas/${asset.filename} (${formula.status})`);
    }
  }

  // 4. Wire the git-backed Dolt remote (remote add → hydrate pull → publish push). Shared here so
  //    both `anton init` and addProject inherit it (anton-43b). A failure is collected, not thrown.
  const doltSync = configureBeadsDoltSync({ repoDir: dir, log: emit, exec });
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
    mode,
    ranInit,
    ranBootstrap,
    steps,
    errors,
    hasBeads: existsSync(beadsDir),
    doltSync,
    hooksWarning,
  };
}
