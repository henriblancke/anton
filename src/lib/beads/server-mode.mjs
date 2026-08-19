/**
 * Point ONE project's board at a shared `dolt sql-server` (anton-yvjd) — the code half of the
 * embedded → server move whose data half is `docs/runbooks/embedded-board-to-shared-dolt-server.md`.
 *
 * Per project, never per machine: the mode and the connection live in that project's
 * `.beads/metadata.json` (DESIGN.md §3a), so one anton can drive an embedded board and a
 * shared-server board side by side. Everything here takes a repo dir and touches nothing outside it.
 *
 * The command this module implements (`anton server-mode`) is deliberately NOT the migration. It
 * cannot be: the board's history is a Dolt database directory that has to reach the server's data
 * volume by a path anton has no business automating (the runbook streams it over ssh into the
 * container's volume — `bd dolt remote add` + `bd dolt push` cannot do it, because in server mode
 * the push executes ON THE SERVER, and the `dolt-sql-server` image ships no ssh client and no keys).
 * What this module owns is everything around that copy, which is where a board actually gets lost:
 *
 *   1. **Back up first.** A JSONL export of the board as it stands, before the flip. The embedded
 *      Dolt directory is left exactly where it is — it is the real history backup, and the escape
 *      hatch if the server goes away.
 *   2. **Write the connection, then prove it.** `bd dolt test` must connect, or the flip is undone.
 *   3. **Prove the board arrived.** The issue count before the flip is compared with the count read
 *      back from the server. Fewer issues means the data copy has not happened (or landed in
 *      another database) — the one mistake that makes an otherwise-successful switch look fine
 *      while the team stares at an empty board. It reverts rather than reports.
 *
 * On any of those failures `metadata.json` is restored byte-for-byte, so a failed attempt leaves a
 * working board rather than a project pointed at a server it cannot read.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  MIN_BD_VERSION,
  SPAWN_KILL_SIGNAL,
  bdVersion,
  bdVersionAtLeast,
  budgetMs,
  ensureBdConfig,
  ensureDoltConnection,
  failureDetail,
  readDoltMetadata,
  scopeBdEnv,
  scopedPasswordVar,
  teamConfigKeys,
} from "./config.mjs";

/** bd's own default MySQL port. Written explicitly — see `SERVER_METADATA_KEYS.port`. */
export const DEFAULT_DOLT_PORT = 3306;

/**
 * Absolute URL to the embedded → server migration runbook — the data half this command refuses to
 * do for you. A URL, not a repo-relative path, so it resolves from a bundle install that ships no
 * `docs/` (same reason as config.mjs's BD_MIGRATION_RUNBOOK).
 */
export const SERVER_MIGRATION_RUNBOOK =
  "https://github.com/henriblancke/anton/blob/main/docs/runbooks/embedded-board-to-shared-dolt-server.md";

/**
 * The `metadata.json` key each connection field lands in — bd's names, and what `readDoltMetadata`
 * reads back. `port` is always written even when it is the default: bd's own deprecation warning
 * notwithstanding, without it bd dials port 0 against a remote host (DESIGN.md §3a).
 */
export const SERVER_METADATA_KEYS = {
  host: "dolt_server_host",
  port: "dolt_server_port",
  user: "dolt_server_user",
  database: "dolt_database",
};

/** Where a pre-flip export lands. Self-ignoring, so a backup never becomes a commit. */
const BACKUP_DIR = "backups";

/**
 * The RAW `.beads/metadata.json` object, or `{}` when it is absent or unparseable.
 *
 * `readDoltMetadata` is the MODE reader and deliberately drops everything about an embedded board;
 * this path needs the file as written — both to default the database name from the embedded board's
 * own `dolt_database`, and to merge rather than replace (bd keeps `project_id`, `backend` and
 * friends in there, and losing them would sever the workspace's identity).
 */
export function readMetadataFile(dir) {
  try {
    const parsed = JSON.parse(readFileSync(join(dir, ".beads", "metadata.json"), "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * The connection to write, from what the project already declares plus what the caller passed.
 *
 * Flags win over the file, and the file is a real source of defaults rather than a formality: a
 * board being moved already names its database (`dolt_database`), and a re-run to correct one field
 * must not require re-typing the other three.
 *
 * Returns `{ connection, errors }`. `errors` names the missing FLAG, not the metadata key — the
 * reader is at a prompt, not in an editor.
 *
 * @param {Record<string, unknown>} raw from {@link readMetadataFile}
 * @param {{ host?: string, port?: number|string, user?: string, database?: string }} flags
 */
export function resolveServerConnection(raw, flags = {}) {
  const errors = [];
  const pick = (flag, key) => {
    const value = flags[flag] ?? raw[SERVER_METADATA_KEYS[key]];
    return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
  };

  const host = pick("host", "host");
  const database = pick("database", "database");
  const user = pick("user", "user");

  const rawPort = flags.port ?? raw[SERVER_METADATA_KEYS.port] ?? DEFAULT_DOLT_PORT;
  const port = Number(rawPort);

  if (!host) errors.push("no server host — pass --host <host>");
  if (!database) errors.push("no database — pass --database <name> (the database this project's board lives in)");
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    errors.push(`invalid port "${rawPort}" — pass --port <1-65535>`);
  }

  return { connection: { host, port, user, database }, errors };
}

/**
 * Write `connection` into `.beads/metadata.json` as server mode, preserving every other key.
 *
 * Returns `{ status: "already"|"written", changed, before }`, where `before` is the file's exact
 * prior text (or `null` when there was none) — what {@link restoreMetadata} puts back when the
 * verification below fails.
 */
export function writeServerModeMetadata(dir, connection) {
  const path = join(dir, ".beads", "metadata.json");
  const before = existsSync(path) ? readFileSync(path, "utf8") : null;
  const raw = readMetadataFile(dir);

  const next = { ...raw, dolt_mode: "server" };
  for (const [field, key] of Object.entries(SERVER_METADATA_KEYS)) {
    if (connection[field] !== undefined) next[key] = connection[field];
  }

  const changed = Object.keys(next).filter((k) => raw[k] !== next[k]);
  const text = `${JSON.stringify(next, null, 2)}\n`;
  if (before === text) return { status: "already", changed: [], before, path };

  writeFileSync(path, text);
  return { status: "written", changed, before, path };
}

/** Put back what {@link writeServerModeMetadata} replaced — `null` means the file did not exist. */
export function restoreMetadata(path, before) {
  if (before === null) rmSync(path, { force: true });
  else writeFileSync(path, before);
}

/**
 * A bd runner bound to `dir` and to `user`'s credentials: project identity stripped from the
 * environment and the password narrowed to that account, exactly as anton's own bd spawns are
 * scoped (`bd-env.ts`, anton-ffmw.1). Without it a `bd dolt test` here would verify whatever
 * `BEADS_DOLT_*` the operator's shell happens to export — i.e. verify nothing about this project.
 */
function bdRunner(dir, user, opts = {}) {
  if (opts.exec) return opts.exec;
  const env = scopeBdEnv(opts.env ?? process.env, user);
  return (cmd, args, timeoutMs = budgetMs("bd")) =>
    spawnSync(cmd, args, { cwd: dir, encoding: "utf8", env, timeout: timeoutMs, killSignal: SPAWN_KILL_SIGNAL });
}

/** Everything a bd invocation printed, both streams — bd puts its config warnings on stderr. */
const output = (r) => `${r?.stdout ?? ""}${r?.stderr ?? ""}`;

/**
 * How many issues this project's board holds right now, via `bd count --status all`.
 *
 * The one number that answers "did the history actually arrive": cheap on a large board (unlike a
 * full `bd list`), and identical either side of the flip, so before/after compare like for like.
 * Parsed from the first `{` because bd prefixes its JSON with deprecation warnings on some configs.
 *
 * Returns `{ ok: true, count }` or `{ ok: false, detail }` — a board that cannot be counted is
 * reported, never silently treated as zero.
 */
export function countBoard(dir, opts = {}) {
  const exec = bdRunner(dir, opts.user, opts);
  const ms = budgetMs("bd");
  const r = exec("bd", ["count", "--status", "all", "--json"], ms);
  if ((r?.status ?? 1) !== 0) return { ok: false, detail: failureDetail(r, ms, output(r)) };

  // stdout only, and only the outermost object in it: bd prefixes (and on some configs follows) its
  // JSON with deprecation warnings, so anything less careful reads a healthy board as unparseable.
  const text = r?.stdout ?? "";
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end < start) return { ok: false, detail: "bd count printed no JSON" };
  try {
    const count = JSON.parse(text.slice(start, end + 1)).count;
    return Number.isInteger(count) ? { ok: true, count } : { ok: false, detail: "bd count reported no count" };
  } catch {
    return { ok: false, detail: "bd count printed output this build can't parse" };
  }
}

/**
 * Export the board to JSONL before anything is changed — the safety net for the flip.
 *
 * `--all` because a partial export is a partial backup: infra beads, templates, gates and memories
 * are board state too. Written under `.beads/backups/`, which is made self-ignoring so a backup can
 * never be committed (a JSONL export of a private board is not a thing to push by accident).
 *
 * This is an interchange snapshot, NOT the history: only the Dolt directory carries commits. It
 * exists so a board can be rebuilt if the move goes wrong AND the embedded copy is gone — which is
 * why the runbook also says to keep that copy.
 *
 * Returns `{ status: "written"|"failed", path?, detail? }`.
 */
export function backupBoard(dir, opts = {}) {
  const exec = bdRunner(dir, opts.user, opts);
  const beadsDir = join(dir, ".beads");
  const dest = join(beadsDir, BACKUP_DIR);
  const stamp = (opts.now ?? (() => new Date()))().toISOString().replace(/[:.]/g, "-");
  const path = join(dest, `board-${stamp}.jsonl`);

  try {
    mkdirSync(dest, { recursive: true });
    writeFileSync(join(dest, ".gitignore"), "*\n");
  } catch (e) {
    return { status: "failed", detail: `could not create ${dest}: ${String(e?.message ?? e)}` };
  }

  // A large board's export reads every issue — the network budget, same as bd init/bootstrap.
  const ms = budgetMs("network");
  const r = exec("bd", ["export", "--all", "-o", path], ms);
  if ((r?.status ?? 1) !== 0) return { status: "failed", detail: failureDetail(r, ms, output(r)) };
  return { status: "written", path };
}

/**
 * `bd dolt test` against the configured server, with the hints an operator needs when it fails:
 * a connection this project cannot make is almost always a missing password variable, and the
 * variable's name is per-USER (anton-ffmw.1), so guessing it is a wasted hour.
 */
export function testDoltConnection(dir, connection, opts = {}) {
  const exec = bdRunner(dir, connection.user, opts);
  const ms = budgetMs("network");
  const r = exec("bd", ["dolt", "test"], ms);
  if ((r?.status ?? 1) === 0) return { ok: true };

  const hints = [
    connection.user
      ? `set ${scopedPasswordVar(connection.user)} (or BEADS_DOLT_PASSWORD) for the "${connection.user}" account`
      : "set BEADS_DOLT_PASSWORD for the database user",
    "add BEADS_DOLT_SERVER_TLS=true when the server sets require_secure_transport",
    `confirm the server is reachable at ${connection.host}:${connection.port} and serves the "${connection.database}" database`,
  ];
  return { ok: false, detail: failureDetail(r, ms, output(r)), hints };
}

/** One step of the flow, in the `{ name, status, detail? }` shape configureBeadsForRepo reports. */
const step = (name, status, detail) => (detail === undefined ? { name, status } : { name, status, detail });

/**
 * Configure THIS project for server mode and prove it works: back up → write the connection →
 * `bd dolt test` → confirm the board reads back whole → publish the connection as the team default.
 *
 * The first failure returns; a failure after `metadata.json` was written also reverts it, so the
 * project is never left pointing at a server it cannot read (in server mode there is no local copy
 * to fall back on — an unreachable server is a board outage, DESIGN.md §3a).
 *
 * @param {string} dir repo root
 * @param {{ host?: string, port?: number|string, user?: string, database?: string, backup?: boolean, force?: boolean }} flags
 *   `backup: false` skips the pre-flip export; `force: true` accepts a server board that holds
 *   FEWER issues than the board being moved (starting a deliberately fresh board).
 * @param {{ exec?: Function, env?: NodeJS.ProcessEnv, now?: () => Date, log?: (msg: string) => void,
 *   onStep?: (step: { name: string, status: string, detail?: string }) => void }} [opts]
 * @returns {{ ok, steps, connection?, errors, before?, counts?, backup? }}
 */
export function configureServerMode(dir, flags = {}, opts = {}) {
  const emit = typeof opts.log === "function" ? opts.log : () => {};
  const onStep = typeof opts.onStep === "function" ? opts.onStep : () => {};
  const steps = [];
  const errors = [];
  const beadsDir = join(dir, ".beads");
  const fail = (extra = {}) => ({ ok: false, steps, errors, ...extra });
  /** Record a step AND hand it to the caller as it happens — this flow is slow enough (an export,
   * two round trips to the server) that a terminal batching its output reads as a hang. */
  const record = (name, status, detail) => {
    const s = step(name, status, detail);
    steps.push(s);
    onStep(s);
    return s;
  };

  // 1. Preconditions. Notably NOT `beadsPrereqs`: that requires a git `origin`, which is the
  //    refs/dolt/data channel a server-mode board does not use. What it does need is bd and an
  //    initialized workspace to point at. The version probe goes through the project-scoped runner
  //    like every other bd call here, so an injected `exec` controls the whole flow.
  const probe = bdRunner(dir, undefined, opts);
  const version = bdVersion(() => probe("bd", ["--version"], budgetMs("probe")));
  if (!bdVersionAtLeast(version)) {
    errors.push(
      version
        ? `bd ${version.raw} is too old — anton requires bd ${MIN_BD_VERSION}+`
        : "bd not found on PATH — install it with `brew install gastownhall/tap/bd`",
    );
    return fail();
  }
  if (!existsSync(beadsDir)) {
    errors.push(`no .beads/ workspace at ${dir} — run \`anton init\` there first`);
    return fail();
  }

  // 2. What the project is now, and what it should become.
  const before = readDoltMetadata(dir);
  const { connection, errors: invalid } = resolveServerConnection(readMetadataFile(dir), flags);
  if (invalid.length) {
    errors.push(...invalid);
    return fail({ before });
  }

  // 3. Count the board while it is still pointed where it is now. This is the number the post-flip
  //    read is checked against — take it BEFORE the backup so a slow export can't sit between the
  //    measurement and the switch.
  const counts = {};
  const countedBefore = countBoard(dir, { ...opts, user: before.user });
  if (countedBefore.ok) {
    counts.before = countedBefore.count;
    record("board count", "ok", `${countedBefore.count} issues`);
  } else {
    // Not fatal: a board that cannot be counted (a stopped embedded server, say) can still be
    // pointed at a server. It costs the arrived-whole check, which is said out loud rather than
    // quietly skipped.
    record("board count", "skipped", countedBefore.detail);
    emit(`could not count the current board (${countedBefore.detail}) — skipping the arrived-whole check.`);
  }

  // 4. Back up before the flip. Only meaningful on an embedded board: a server board's data is not
  //    here, and exporting it would back up the very thing the move is leaving alone.
  let backup;
  if (before.mode !== "embedded") {
    record("backup", "skipped", "board is already on a shared server — its data is not local");
  } else if (flags.backup === false) {
    record("backup", "skipped", "--no-backup");
  } else {
    backup = backupBoard(dir, { ...opts, user: before.user });
    record("backup", backup.status === "written" ? "ok" : "failed", backup.detail ?? backup.path);
    if (backup.status !== "written") {
      // Refusing here is the point of the flag: an unbacked flip is exactly what --no-backup opts
      // into, and doing it by accident is not.
      errors.push(`board backup failed: ${backup.detail}`);
      return fail({ before, connection, counts, backup });
    }
  }

  // 5. Write the mode + connection. metadata.json is the ONLY place the mode can live: `bd config
  //    set dolt.mode` reports success while writing a nested block into a file of flat dotted keys,
  //    from bd's lowest-priority source, and has no effect (anton-4gd2).
  const written = writeServerModeMetadata(dir, connection);
  record("metadata.json", written.status, written.changed.join(", ") || undefined);

  /** Undo the write and report why — the board keeps working exactly as it did. */
  const revert = (reason) => {
    restoreMetadata(written.path, written.before);
    record("metadata.json", "reverted", `${reason} — the board is untouched`);
  };

  // 6. Prove the connection before anything else trusts it.
  const tested = testDoltConnection(dir, connection, opts);
  record("bd dolt test", tested.ok ? "ok" : "failed", tested.detail);
  if (!tested.ok) {
    errors.push(`bd dolt test could not connect: ${tested.detail}`);
    revert("could not connect");
    return fail({ before, connection, counts, backup, hints: tested.hints });
  }

  // 7. Prove the BOARD arrived, not just the server. A reachable server holding fewer issues than
  //    the board being moved means the Dolt directory was never copied (or went to another
  //    database) — the failure that otherwise looks like a clean switch onto an empty board.
  const countedAfter = countBoard(dir, { ...opts, user: connection.user });
  record("server board count", countedAfter.ok ? "ok" : "failed", countedAfter.ok ? `${countedAfter.count} issues` : countedAfter.detail);
  if (!countedAfter.ok) {
    // Fatal, unlike the pre-flip count: reading the board back IS the verification, and `bd dolt
    // test` does not stand in for it. A server can answer the connection test and still refuse the
    // database — bd's own project-identity guard does exactly that when the connection names a
    // database belonging to another project ("PROJECT IDENTITY MISMATCH — refusing to connect").
    errors.push(`the server accepted the connection but this project cannot read its board: ${countedAfter.detail}`);
    revert("board unreadable on the server");
    return fail({ before, connection, counts, backup });
  }
  counts.after = countedAfter.count;
  if (counts.before !== undefined && counts.after < counts.before && !flags.force) {
    errors.push(
      `the server's "${connection.database}" database holds ${counts.after} issues but this board has ${counts.before} — ` +
        "its history has not been copied onto the server yet",
    );
    revert("server board is missing issues");
    return fail({ before, connection, counts, backup });
  }

  // 8. Only now publish the team-wide defaults into config.yaml, so a reverted attempt leaves that
  //    file untouched too. `bd dolt set --update-config` refuses in embedded mode, which is why it
  //    comes after the metadata write rather than before it.
  // Both take the project-scoped runner: on a server board `bd config set` and `bd dolt set` talk
  // to the database, so they need the same narrowed credentials the test above proved.
  const exec = bdRunner(dir, connection.user, opts);
  for (const [key, want] of teamConfigKeys("server")) {
    const status = ensureBdConfig(dir, beadsDir, key, want, { exec });
    record(`${key}=${want}`, status);
    if (status === "failed") errors.push(`could not set ${key}=${want}`);
  }
  for (const published of ensureDoltConnection(dir, beadsDir, connection, { exec })) {
    steps.push(published);
    onStep(published);
    if (published.status === "missing" || published.status === "failed") errors.push(published.detail);
  }
  // A bd that cannot write the team defaults cannot open the database either (that is what those
  // commands do first), so this is the same class of failure as a refused connection — and gets the
  // same answer: the project goes back to what it was rather than staying half-switched.
  if (errors.length) {
    revert("could not publish the team-wide connection defaults");
    return fail({ before, connection, counts, backup });
  }

  return { ok: true, steps, errors, before, connection, counts, backup };
}
