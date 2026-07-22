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
 * the JSONL is a passive export): dolt.auto-commit "on", export.auto false, export.git-add false, and
 * a .gitignore that keeps the derived exports + Dolt runtime state out of git.
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
export function bdVersion(run = () => spawnSync("bd", ["--version"], { encoding: "utf8" })) {
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
  const r = spawnSync("git", ["-C", dir, "rev-parse", "--is-inside-work-tree"], { stdio: "ignore" });
  return r.status === 0;
}

/** True when `dir`'s repo has an `origin` remote configured. */
export function hasOriginRemote(dir) {
  const r = spawnSync("git", ["-C", dir, "remote", "get-url", "origin"], { stdio: "ignore" });
  return r.status === 0;
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
  const ls = spawnSync("git", ["ls-files", "--", ...paths], { cwd: dir, encoding: "utf8" });
  if ((ls.status ?? 1) !== 0) return { untracked: [] };
  const tracked = (ls.stdout || "")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  if (tracked.length === 0) return { untracked: [] };

  // -r so a tracked directory form (dolt/, embeddeddolt/) is removed too.
  const rm = spawnSync("git", ["rm", "--cached", "-r", "-q", "--", ...tracked], { cwd: dir, encoding: "utf8" });
  if ((rm.status ?? 1) !== 0) return { untracked: [], error: (rm.stderr || "").trim() };
  return { untracked: tracked };
}

/**
 * Parse `.beads/config.yaml` into a flat `dotted.path → value` map (surrounding quotes stripped),
 * accepting BOTH encodings bd has shipped. bd 1.0.4 appends flat dotted lines (`export.auto: false`);
 * bd 1.1.0 writes `export.*` and `dolt.*` as nested maps (`export:` / `    auto: false`) while keeping
 * `sync.remote` flat. Both must resolve to the same dotted path so team-config enforcement doesn't
 * keep re-setting keys it already set (anton-qhoz). Nesting is tracked purely by indentation; blank
 * and comment lines are ignored. A later line for the same path wins (bd appends, so this reflects the
 * effective value).
 */
function parseConfigYaml(text) {
  const map = {};
  const stack = []; // parent map headers currently in scope, outermost first: { indent, key }
  for (const raw of text.split("\n")) {
    const line = raw.replace(/\r$/, "");
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
      map[path] = value.replace(/^["']|["']$/g, "");
    }
  }
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
  let text = "";
  try {
    text = readFileSync(join(beadsDir, "config.yaml"), "utf8");
  } catch {
    return false;
  }
  return parseConfigYaml(text)[key] === want;
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
const CONFIG_KEYS = [
  ["export.auto", "false"],
  ["dolt.auto-commit", "on"],
  ["export.git-add", "false"],
  ["dolt.auto-push", "false"],
];

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
 *   - { status: "no-remote" }                   — no declared/origin remote to use
 *   - { status: "already", url }                — Dolt `origin` already points here
 *   - { status: "configured", url, pulled, pushed, pushAttempts, firstPublish, pushOutput } — remote
 *       (re)pointed; pull + verified/retried push attempted. `pushed:false` reports a push that could
 *       not land after `pushAttempts` tries (non-fatal); `firstPublish:true` means the remote is still
 *       empty and the failure must be surfaced loud.
 *   - { status: "error", detail }               — `bd dolt remote add` itself failed
 *
 * @param {{ repoDir: string, log?: (msg: string) => void, exec?: (cmd: string, args: string[]) => { status: number|null, stdout?: string, stderr?: string } }} opts
 */
export function configureBeadsDoltSync(opts = {}) {
  const { repoDir: dir, log } = opts;
  const emit = typeof log === "function" ? log : () => {};
  const exec = opts.exec ?? ((cmd, args) => spawnSync(cmd, args, { cwd: dir, encoding: "utf8" }));

  if (!existsSync(join(dir, ".beads"))) return { status: "no-workspace" };

  // Remote choice is dynamic per project: a `sync.remote` declared in .beads/config.yaml (e.g. an
  // aws:// remote) wins over the git-origin fallback — anton drives whatever the project's beads
  // config declares, it never forces git-origin over a declared remote. NOTE `bd config get` exits 0
  // with "sync.remote (not set in config.yaml)" when unset — parse the text, never the exit code.
  const cfg = exec("bd", ["config", "get", "sync.remote"]);
  const cfgOut = ((cfg.status ?? 1) === 0 ? (cfg.stdout ?? "") : "").trim();
  const declared = /\(not set/i.test(cfgOut)
    ? undefined
    : cfgOut.split(/\s+/).find((t) => /^[a-z+]+:\/\//i.test(t) || t.startsWith("git@"));

  let url = declared;
  if (!url) {
    const origin = exec("git", ["remote", "get-url", "origin"]);
    url = (origin.stdout ?? "").trim();
    if ((origin.status ?? 1) !== 0 || !url) return { status: "no-remote" };
  }

  // Only a no-op when the existing Dolt remote already points at THIS url. A repo first wired to
  // git origin and later given a declared `sync.remote` (e.g. aws://) must be re-pointed, not left
  // pulling/pushing the stale remote — otherwise the declared shared backlog is silently ignored
  // (anton-live-sync review). `bd dolt remote list` prints `<name>  <url>` lines; `bd dolt remote
  // add` upserts, so the add below re-points a stale url.
  const list = exec("bd", ["dolt", "remote", "list"]);
  const existing = ((list.stdout ?? "").match(/^origin\s+(\S+)$/m) ?? [])[1];
  if (existing && normalizeRemoteUrl(existing) === normalizeRemoteUrl(url)) {
    emit("Dolt remote 'origin' already configured — no-op.");
    return { status: "already", url };
  }
  if (existing) emit(`Dolt remote 'origin' points at ${existing} — repointing to ${url}`);
  else if (declared) emit(`sync.remote declared in beads config — wiring ${declared}`);

  const add = exec("bd", ["dolt", "remote", "add", "origin", url]);
  if ((add.status ?? 1) !== 0) {
    return { status: "error", detail: `${add.stdout ?? ""}${add.stderr ?? ""}`.trim() || `exit ${add.status ?? "?"}` };
  }
  emit(`bd dolt remote add origin ${url}`);

  // Hydrate before publishing: with the JSONL exports untracked (anton-hg9), a fresh clone's board
  // comes from refs/dolt/data, not from files in the clone. Fails benignly when the remote has no
  // refs/dolt/data yet (first setup ever) — the push below then publishes it.
  const pull = exec("bd", ["dolt", "pull"]);
  const pulled = (pull.status ?? 1) === 0;
  const pullOutput = `${pull.stdout ?? ""}${pull.stderr ?? ""}`.trim();
  const firstPublish = !pulled && isFirstPublishPullOutput(pullOutput);
  if (!pulled && !firstPublish) {
    const detail = pullOutput || `exit ${pull.status ?? "?"}`;
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
    push = exec("bd", ["dolt", "push"]);
    if ((push.status ?? 1) === 0) {
      // Confirm the ref really landed — `bd dolt push` can exit 0 as a no-op. If the check can't run
      // (offline / local test remote), trust bd's exit code rather than falsely flagging failure.
      if (!verifyViaGitOrigin) {
        pushed = true;
      } else {
        const ls = exec("git", ["ls-remote", "origin", "refs/dolt/data"]);
        // Verification must fail closed: an unreachable/auth-failing remote cannot prove the ref
        // landed, even when `bd dolt push` itself returned zero.
        pushed = (ls.status ?? 1) === 0 && /\S/.test((ls.stdout ?? "").trim());
      }
      if (pushed) break;
    }
    // Reconcile before retrying — a concurrent writer may have advanced refs/dolt/data.
    if (pushAttempts < MAX_PUSH_ATTEMPTS) exec("bd", ["dolt", "pull"]);
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
 * no-op) → config.yaml enforcement → `.beads/.gitignore` → Dolt remote wiring. Every step is
 * best-effort and its outcome is collected in `steps`/`errors` rather than thrown — the caller
 * decides how loud to be (the CLI prints each step; addProject logs a summary) and a step failure
 * never aborts the caller.
 *
 * Returns:
 *   { configured, skipped, reason?, ranInit, ranBootstrap, steps: [{name,status,detail?}], errors, hasBeads }
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
    const r = spawnSync("bd", initArgs, { cwd: dir, encoding: "utf8" });
    if ((r.status ?? 1) !== 0) {
      const detail = (r.stderr || r.stdout || "").trim() || `exit ${r.status ?? "?"}`;
      steps.push({ name: "bd init", status: "failed", detail });
      errors.push(`bd init failed: ${detail}`);
      return { configured: false, skipped: false, ranInit: false, steps, errors, hasBeads: existsSync(beadsDir) };
    }
    ranInit = true;
    steps.push({ name: "bd init", status: "ok" });
  } else if (!hasLocalDoltDb(beadsDir)) {
    emit("bd bootstrap --non-interactive (fresh clone — hydrating the Dolt DB from origin)");
    const r = spawnSync("bd", ["bootstrap", "--non-interactive"], { cwd: dir, encoding: "utf8" });
    if ((r.status ?? 1) !== 0) {
      const detail = (r.stderr || r.stdout || "").trim() || `exit ${r.status ?? "?"}`;
      steps.push({ name: "bd bootstrap", status: "failed", detail });
      errors.push(`bd bootstrap failed: ${detail}`);
      return { configured: false, skipped: false, ranInit: false, steps, errors, hasBeads: existsSync(beadsDir) };
    }
    ranBootstrap = true;
    steps.push({ name: "bd bootstrap", status: "ok" });
    // A freshly hydrated clone never ran the local writes / post-pull scoped recompute that
    // maintain the denormalized `is_blocked` flag, so it can arrive stale — and `bd ready` trusts
    // that flag, silently hiding ready work or surfacing blocked work (bd 1.1.0). Repair it once,
    // right after bootstrap. Best-effort: idempotent on a consistent DB, and a failure here must
    // never abort an otherwise-good clone setup.
    const rc = spawnSync("bd", ["recompute-blocked"], { cwd: dir, encoding: "utf8" });
    steps.push({ name: "bd recompute-blocked", status: (rc.status ?? 1) === 0 ? "ok" : "skipped" });
  } else {
    emit(".beads/ present with a local Dolt DB — enforcing team-config only (no re-init).");
    steps.push({ name: "bd init", status: "already" });
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
    ranBootstrap,
    steps,
    errors,
    hasBeads: existsSync(beadsDir),
    doltSync,
    hooksWarning,
  };
}
