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
 *   3. **Prove the board arrived.** The issue IDs read before the flip are compared with the IDs
 *      read back from the server: every one of them must be there. A missing issue means the data
 *      copy has not happened, landed in another database, or left a stale copy of this project on
 *      the server — the one class of mistake that makes an otherwise-successful switch look fine
 *      while the team stares at a board with work missing from it. It reverts rather than reports.
 *
 * On any of those failures `metadata.json` AND `.beads/config.yaml` are restored byte-for-byte, so a
 * failed attempt leaves a working board rather than a project pointed at a server it cannot read.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  MIN_BD_VERSION,
  bdVersion,
  bdVersionAtLeast,
  budgetMs,
  checkSharedServer,
  ensureBdConfig,
  ensureDoltConnection,
  failureDetail,
  passwordVarHint,
  readDoltMetadata,
  scopedBdRunner,
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
 * prior text (or `null` when there was none) — what {@link restoreFile} puts back when the
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

/**
 * Put back a file this flow replaced — `before` is its exact prior text, `null` when it did not
 * exist (in which case the file is removed). Used for both `metadata.json` and `config.yaml`.
 */
export function restoreFile(path, before) {
  if (before === null) rmSync(path, { force: true });
  else writeFileSync(path, before);
}

/** Everything a bd invocation printed, both streams — bd puts its config warnings on stderr. */
const output = (r) => `${r?.stdout ?? ""}${r?.stderr ?? ""}`;

/**
 * How many candidate spans {@link parseJsonPayload} will parse before giving up. Each attempt
 * parses a slice that is megabytes on a large board, so an stdout that holds no payload at all must
 * fail fast rather than square its own length.
 */
const MAX_JSON_SPANS = 100;

/**
 * The JSON payload in `text` that `accept` recognises, or `undefined`.
 *
 * Neither "first `{` to last `}`" nor "the last span that parses" is safe on its own: bd brackets
 * its `--json` output with deprecation warnings free to contain brackets of their own (`use
 * {dolt.auto-commit} instead`), so the first would swallow a warning, while the second would hand
 * back an issue's OWN nested object or array. Every `{`/`[` start is tried left-to-right against
 * every matching close right-to-left (widest span first) — and `accept` alone decides that a span
 * is the payload, because "it parsed" plainly is not enough to know that it is.
 *
 * `accept` is handed the parsed value and its raw span, and returns the value to hand back, or
 * `undefined` to keep scanning.
 */
function parseJsonPayload(text, accept) {
  let attempts = 0;
  for (let i = 0; i < text.length; i++) {
    const open = text[i];
    if (open !== "{" && open !== "[") continue;
    const close = open === "{" ? "}" : "]";
    // `e > i` also guards the walk: `lastIndexOf(close, -1)` clamps its start to 0 rather than
    // giving up, so a close at index 0 would otherwise be handed back forever.
    for (let e = text.lastIndexOf(close); e > i; e = text.lastIndexOf(close, e - 1)) {
      if (++attempts > MAX_JSON_SPANS) return undefined;
      const span = text.slice(i, e + 1);
      let parsed;
      try {
        parsed = JSON.parse(span);
      } catch {
        continue; // not this span — narrow the close, then keep walking the start right
      }
      const taken = accept(parsed, span);
      if (taken !== undefined) return taken;
    }
  }
  return undefined;
}

/**
 * The arguments that list EVERY issue on this project's board, ids and all.
 *
 * `--all` plus the three `--include-*` flags mirror the backup's `bd export --all`: closed issues,
 * gates, infra beads and templates are board state too, and a check that skipped them would call a
 * board arrived while a third of it was still at home. `--limit 0` because bd truncates at 50 by
 * default, and `--skip-labels` because only the ids are read — label hydration is the expensive
 * half of the query. Every flag exists in bd 1.1.0, anton's floor (MIN_BD_VERSION).
 */
const LIST_ALL_IDS_ARGS = [
  "list",
  "--all",
  "--json",
  "--limit",
  "0",
  "--skip-labels",
  "--include-gates",
  "--include-infra",
  "--include-templates",
];

/**
 * Every issue ID this project's board holds right now.
 *
 * IDENTITY, not cardinality, is what answers "did the history actually arrive". A count proves only
 * that SOME board is on the other end: a server holding a stale or divergent copy of the same
 * project can match — or beat — the local count while missing issues the board being moved has, and
 * the flip would accept it and keep writing into the divergent copy. Comparing the id sets catches
 * that; comparing two numbers cannot. This runs once, on a one-time migration, so reading the ids
 * is worth what it costs over `bd count`.
 *
 * Returns `{ ok: true, ids }` or `{ ok: false, detail }` — a board that cannot be read is reported,
 * never silently treated as empty.
 */
export function readBoardIds(dir, opts = {}) {
  const exec = scopedBdRunner(dir, opts.user, opts);
  const ms = budgetMs("bd");
  const r = exec("bd", LIST_ALL_IDS_ARGS, ms);
  if ((r?.status ?? 1) !== 0) return { ok: false, detail: failureDetail(r, ms, output(r)) };

  // stdout only — bd's warnings go to stderr, and the ones that don't are stepped over by the scan.
  // bd answers with a bare array on some boards and `{ issues: [...] }` on others; both are the
  // payload, and anything else (a nested array of dependency ids, say) is not.
  const stdout = r?.stdout ?? "";
  const ids = parseJsonPayload(stdout, (parsed, span) => {
    const wrapped = !Array.isArray(parsed) && Array.isArray(parsed?.issues);
    const issues = Array.isArray(parsed) ? parsed : wrapped ? parsed.issues : undefined;
    if (!issues) return undefined;
    // An EMPTY bare array is the one span that proves nothing about itself — it would match a stray
    // `[]` anywhere in the output. Taken only when it is the whole of stdout; the `{ issues: [] }`
    // form names itself and needs no such guard.
    if (issues.length === 0 && !wrapped && span.trim() !== stdout.trim()) return undefined;
    const found = issues.map((i) => (i && typeof i === "object" ? i.id : undefined));
    return found.every((id) => typeof id === "string" && id !== "") ? found : undefined;
  });
  return ids ? { ok: true, ids } : { ok: false, detail: "bd list printed no readable board" };
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
  const exec = scopedBdRunner(dir, opts.user, opts);
  const beadsDir = join(dir, ".beads");
  const dest = join(beadsDir, BACKUP_DIR);
  const stamp = (opts.now ?? (() => new Date()))().toISOString().replace(/[:.]/g, "-");
  const path = join(dest, `board-${stamp}.jsonl`);

  // Separate catches so the detail names the thing that actually failed — an unwritable .gitignore
  // in a directory that was created fine is a different fix from a directory that cannot be made.
  try {
    mkdirSync(dest, { recursive: true });
  } catch (e) {
    return { status: "failed", detail: `could not create ${dest}: ${String(e?.message ?? e)}` };
  }
  const ignore = join(dest, ".gitignore");
  try {
    writeFileSync(ignore, "*\n");
  } catch (e) {
    return { status: "failed", detail: `could not write ${ignore}: ${String(e?.message ?? e)}` };
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
  // The probe itself is config.mjs's, shared with the `anton init`/`doctor` preflight (anton-eg46)
  // so a connection this command accepts is one those will too. Only the hints are this command's:
  // it is mid-flip, with the connection it just wrote in hand.
  const probe = checkSharedServer(dir, connection, { ...opts, exec: scopedBdRunner(dir, connection.user, opts) });
  if (probe.ok) return { ok: true };

  const hints = [
    `set ${passwordVarHint(connection.user)}${connection.user ? ` for the "${connection.user}" account` : " for the database user"}`,
    "add BEADS_DOLT_SERVER_TLS=true when the server sets require_secure_transport",
    `confirm the server is reachable at ${connection.host}:${connection.port} and serves the "${connection.database}" database`,
  ];
  return { ok: false, detail: probe.detail, hints };
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
 *   `backup: false` skips the pre-flip export; `force: true` accepts a server board that is MISSING
 *   issues the board being moved has (starting a deliberately fresh board).
 * @param {{ exec?: Function, env?: NodeJS.ProcessEnv, now?: () => Date, log?: (msg: string) => void,
 *   onStep?: (step: { name: string, status: string, detail?: string }) => void }} [opts]
 * @returns {{ ok, steps, connection?, errors, before?, counts?, backup?, missing? }} `missing` is
 *   the ids this board holds that the server's copy does not — empty once the check has passed.
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
  const probe = scopedBdRunner(dir, undefined, opts);
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

  // 3. Read the board's issue IDs while it is still pointed where it is now. This is the set the
  //    post-flip read is checked against — take it BEFORE the backup so a slow export can't sit
  //    between the measurement and the switch.
  const counts = {};
  const idsBefore = readBoardIds(dir, { ...opts, user: before.user });
  if (idsBefore.ok) {
    counts.before = idsBefore.ids.length;
    record("board issues", "ok", `${idsBefore.ids.length} issues`);
  } else {
    // Not fatal: a board that cannot be read (a stopped embedded server, say) can still be pointed
    // at a server. It costs the arrived-whole check, which is said out loud rather than quietly
    // skipped.
    record("board issues", "skipped", idsBefore.detail);
    emit(`could not read the current board (${idsBefore.detail}) — skipping the arrived-whole check.`);
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

  // Snapshot config.yaml too, BEFORE step 8 starts publishing into it: `bd config set` and `bd dolt
  // set --update-config` write one key at a time, so a failure part-way through would otherwise
  // leave a half-published server default behind a report that says the board is untouched.
  const configPath = join(beadsDir, "config.yaml");
  const configBefore = existsSync(configPath) ? readFileSync(configPath, "utf8") : null;

  /** Undo both writes and report why — the board keeps working exactly as it did. */
  const revert = (reason) => {
    restoreFile(written.path, written.before);
    restoreFile(configPath, configBefore);
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

  // 7. Prove THIS board arrived, not just that some board answers. The server's copy is checked by
  //    identity: a stale or divergent copy of the same project can hold as many issues as the board
  //    being moved — more, even — while missing the ones written here since it diverged, and a
  //    count would wave it through onto an incomplete board every later write then compounds.
  const idsAfter = readBoardIds(dir, { ...opts, user: connection.user });
  record("server board issues", idsAfter.ok ? "ok" : "failed", idsAfter.ok ? `${idsAfter.ids.length} issues` : idsAfter.detail);
  if (!idsAfter.ok) {
    // Fatal, unlike the pre-flip read: reading the board back IS the verification, and `bd dolt
    // test` does not stand in for it. A server can answer the connection test and still refuse the
    // database — bd's own project-identity guard does exactly that when the connection names a
    // database belonging to another project ("PROJECT IDENTITY MISMATCH — refusing to connect").
    errors.push(`the server accepted the connection but this project cannot read its board: ${idsAfter.detail}`);
    revert("board unreadable on the server");
    return fail({ before, connection, counts, backup });
  }
  counts.after = idsAfter.ids.length;

  const onServer = new Set(idsAfter.ids);
  const missing = idsBefore.ok ? idsBefore.ids.filter((id) => !onServer.has(id)) : [];
  if (missing.length && !flags.force) {
    errors.push(
      `the server's "${connection.database}" database is missing ${missing.length} of this board's ` +
        `${counts.before} issues (${missing.slice(0, 5).join(", ")}${missing.length > 5 ? ", …" : ""}) — ` +
        "its history has not been copied onto the server yet",
    );
    revert("server board is missing issues");
    return fail({ before, connection, counts, backup, missing });
  }

  // 8. Only now publish the team-wide defaults into config.yaml — `revert` restores the file from
  //    the snapshot above, so a failed attempt leaves it exactly as it was rather than carrying
  //    half a connection. `bd dolt set --update-config` refuses in embedded mode, which is why this
  //    comes after the metadata write rather than before it.
  // Both take the project-scoped runner: on a server board `bd config set` and `bd dolt set` talk
  // to the database, so they need the same narrowed credentials the test above proved.
  const exec = scopedBdRunner(dir, connection.user, opts);
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
    return fail({ before, connection, counts, backup, missing });
  }

  return { ok: true, steps, errors, before, connection, counts, backup, missing };
}
