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
 *   4. **Prove nobody wrote it meanwhile.** The board is read once to measure and once more
 *      immediately before the flip, and every issue's CONTENT is compared, not just the id set: an
 *      update the server's copy predates would otherwise sail through step 3 and be stranded in the
 *      database this project is about to stop reading. What remains is the flip itself — a single
 *      `metadata.json` write, milliseconds rather than the minutes an export takes.
 *
 * On any of those failures `metadata.json` AND `.beads/config.yaml` are restored byte-for-byte, so a
 * failed attempt leaves a working board rather than a project pointed at a server it cannot read.
 */
import { createHash } from "node:crypto";
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
  serverScopedPasswordVar,
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
  // Transport, and the reason it is written HERE: bd reads `dolt_server_tls` per directory, while
  // `BEADS_DOLT_SERVER_TLS` is one process-wide value that outranks it — so one anton driving a TLS
  // server and a plaintext one needs each project to declare its own (PR #174 review, `bd-env.ts`).
  tls: "dolt_server_tls",
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
 * @param {{ host?: string, port?: number|string, user?: string, database?: string, tls?: boolean }} flags
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

  // Left undefined unless something declares it: an unasked-for `false` would strip the ambient
  // BEADS_DOLT_SERVER_TLS that a single-server deployment is documented to rely on.
  const rawTls = flags.tls ?? raw[SERVER_METADATA_KEYS.tls];
  const tls = typeof rawTls === "boolean" ? rawTls : undefined;

  if (!host) errors.push("no server host — pass --host <host>");
  if (!database) errors.push("no database — pass --database <name> (the database this project's board lives in)");
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    errors.push(`invalid port "${rawPort}" — pass --port <1-65535>`);
  }

  return { connection: { host, port, user, database, tls }, errors };
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
 * How many candidate openers {@link parseJsonPayload} will parse before giving up. One attempt per
 * opener, never per close: a budget spent enumerating the closes behind a single opener is a budget
 * a warning's stray `{` can exhaust before the real payload is ever reached (PR #174 review).
 *
 * 100 is chosen well above the bracket-bearing preamble any bd version has been seen to print
 * (single digits — one or two deprecation lines), and the cost of being wrong is bounded either
 * way: exceed it and the symptom is a refused flip with "no readable board", never a wrong board
 * accepted. Safe to raise if some future bd gets chattier.
 */
const MAX_JSON_CANDIDATES = 100;

/**
 * Index of the bracket that closes the one at `start`, or -1 when nothing does.
 *
 * String-aware, because an issue's own text is free to contain a `}`. The walk starts fresh at
 * `start` rather than tracking quotes across the whole of stdout, so an odd quote in a warning
 * printed BEFORE the payload cannot desynchronise the payload's own scan.
 */
function matchingClose(text, start) {
  let depth = 0;
  let inString = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (ch === "\\") i++;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{" || ch === "[") depth++;
    else if ((ch === "}" || ch === "]") && --depth === 0) return i;
  }
  return -1;
}

/**
 * The JSON payload in `text` that `accept` recognises, or `undefined`.
 *
 * Neither "first `{` to last `}`" nor "the last span that parses" is safe on its own: bd brackets
 * its `--json` output with deprecation warnings free to contain brackets of their own (`use
 * {dolt.auto-commit} instead`), so the first would swallow a warning, while the second would hand
 * back an issue's OWN nested object or array. So each `{`/`[` is tried left-to-right against the
 * ONE close that balances it — and `accept` alone decides that a span is the payload, because "it
 * parsed" plainly is not enough to know that it is.
 *
 * Balancing rather than guessing the close is also what keeps the budget honest: a warning's stray
 * bracket costs one attempt, however many issues follow it.
 *
 * `accept` is handed the parsed value and its raw span, and returns the value to hand back, or
 * `undefined` to keep scanning.
 */
function parseJsonPayload(text, accept) {
  let attempts = 0;
  for (let i = 0; i < text.length; i++) {
    const open = text[i];
    if (open !== "{" && open !== "[") continue;
    if (++attempts > MAX_JSON_CANDIDATES) return undefined;
    const end = matchingClose(text, i);
    if (end < 0) continue; // an unbalanced bracket — a warning's, never a payload's
    const span = text.slice(i, end + 1);
    let parsed;
    try {
      parsed = JSON.parse(span);
    } catch {
      continue; // balanced but not JSON — keep walking the openers right
    }
    const taken = accept(parsed, span);
    if (taken !== undefined) return taken;
  }
  return undefined;
}

/**
 * The arguments that list EVERY issue on this project's board, ids and all.
 *
 * `--all` plus the three `--include-*` flags mirror the backup's `bd export --all`: closed issues,
 * gates, infra beads and templates are board state too, and a check that skipped them would call a
 * board arrived while a third of it was still at home. `--limit 0` because bd truncates at 50 by
 * default. Every flag exists in bd 1.1.0, anton's floor (MIN_BD_VERSION).
 *
 * `--skip-labels` is dropped for a CONTENT read only. Label hydration is the expensive half of the
 * query and the arrived-whole check compares ids alone — but the drift check compares what each
 * issue SAYS, and a label written mid-flip is a change like any other (PR #174 review).
 */
const listAllArgs = (content) => [
  "list",
  "--all",
  "--json",
  "--limit",
  "0",
  ...(content ? [] : ["--skip-labels"]),
  "--include-gates",
  "--include-infra",
  "--include-templates",
];

/** JSON with object keys sorted at every depth, and every array ordered by its own serialization:
 * bd's field order and its row order are presentation, not board content, so neither may read as a
 * mid-flip edit. */
function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).sort().join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stableJson(value[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/**
 * A fingerprint of one issue as bd printed it — EVERY field, not a chosen few, so a status, title,
 * assignee, label or dependency written while the switch is being prepared cannot slip past the
 * drift check by leaving the id set intact (PR #174 review). Hashed rather than kept, so a
 * fingerprint per issue costs 40 bytes on a board of any size.
 */
const issueDigest = (issue) => createHash("sha1").update(stableJson(issue)).digest("hex");

/**
 * Every issue this project's board holds right now: its ids, and a content fingerprint per id.
 *
 * IDENTITY, not cardinality, is what answers "did the history actually arrive". A count proves only
 * that SOME board is on the other end: a server holding a stale or divergent copy of the same
 * project can match — or beat — the local count while missing issues the board being moved has, and
 * the flip would accept it and keep writing into the divergent copy. Comparing the id sets catches
 * that; comparing two numbers cannot. This runs once, on a one-time migration, so reading the ids
 * is worth what it costs over `bd count`.
 *
 * The `digests` answer the other question — "is this the same board it was a minute ago" — which
 * ids alone cannot: a writer that UPDATES an existing issue leaves the id set identical.
 *
 * Returns `{ ok: true, ids, digests }` or `{ ok: false, detail }` — a board that cannot be read is
 * reported, never silently treated as empty.
 *
 * @param {string} dir repo root
 * @param {{ board?: object, content?: boolean, exec?: Function, env?: NodeJS.ProcessEnv }} [opts]
 *   `board` is the connection bd runs under (credentials + transport) — the board's own before the
 *   flip, the server's after it. `content: true` hydrates labels too, so the digests cover them;
 *   pass it for any read whose digests are compared.
 */
export function readBoardIds(dir, opts = {}) {
  const exec = scopedBdRunner(dir, opts.board, opts);
  // The network budget, not the local `bd` one: in server mode this listing crosses the wire to the
  // Dolt server, exactly like the export in `backupBoard`. On a large board over a slow link the
  // 60s local budget times out — and a timeout here is not a warning, it is a refused flip before
  // it and a full revert after it (PR #174 review).
  const ms = budgetMs("network");
  const r = exec("bd", listAllArgs(opts.content === true), ms);
  if ((r?.status ?? 1) !== 0) return { ok: false, detail: failureDetail(r, ms, output(r)) };

  // stdout only — bd's warnings go to stderr, and the ones that don't are stepped over by the scan.
  // bd answers with a bare array on some boards and `{ issues: [...] }` on others; both are the
  // payload, and anything else (a nested array of dependency ids, say) is not.
  const stdout = r?.stdout ?? "";
  const rows = parseJsonPayload(stdout, (parsed, span) => {
    const wrapped = !Array.isArray(parsed) && Array.isArray(parsed?.issues);
    const issues = Array.isArray(parsed) ? parsed : wrapped ? parsed.issues : undefined;
    if (!issues) return undefined;
    // An EMPTY bare array is the one span that proves nothing about itself — it would match a stray
    // `[]` anywhere in the output. Taken only when it is the whole of stdout; the `{ issues: [] }`
    // form names itself and needs no such guard.
    //
    // Known cost, deliberately paid (PR #174 review): an EMPTY board that bd wraps in a stdout
    // warning ("some warning\n[]\n") falls through to `{ ok: false }` and reads as unreadable. The
    // alternative — accepting a bare `[]` from anywhere in the output — would let a warning's own
    // brackets pass as "the board is empty", and an empty source set makes the arrived-whole check
    // in configureServerMode pass over ANY server board. A misleading message on an empty board is
    // recoverable (--force, which that step names); a silently unverified flip is not.
    if (issues.length === 0 && !wrapped && span.trim() !== stdout.trim()) return undefined;
    const found = issues.map((i) => (i && typeof i === "object" ? i.id : undefined));
    return found.every((id) => typeof id === "string" && id !== "") ? issues : undefined;
  });
  if (!rows) return { ok: false, detail: "bd list printed no readable board" };
  return { ok: true, ids: rows.map((i) => i.id), digests: new Map(rows.map((i) => [i.id, issueDigest(i)])) };
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
 *
 * @param {string} dir repo root
 * @param {{ board?: object, exec?: Function, env?: NodeJS.ProcessEnv, now?: () => Date }} [opts]
 *   `board` is the connection bd runs under — see {@link readBoardIds}.
 */
export function backupBoard(dir, opts = {}) {
  const exec = scopedBdRunner(dir, opts.board, opts);
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
  const probe = checkSharedServer(dir, connection, { ...opts, exec: scopedBdRunner(dir, connection, opts) });
  if (probe.ok) return { ok: true };

  const perServer = serverScopedPasswordVar(connection);
  const hints = [
    `set ${passwordVarHint(connection.user)}${connection.user ? ` for the "${connection.user}" account` : " for the database user"}`,
    // The rung above, named only here: it exists for the operator who drives two servers whose
    // accounts happen to share a name, and that operator is the one standing in front of this
    // failure (PR #174 review).
    ...(perServer ? [`or ${perServer}, when another project uses the same "${connection.user}" account on a different server`] : []),
    "pass --tls when the server sets require_secure_transport (--no-tls when it does not) — that is " +
      "THIS project's transport, where a process-wide BEADS_DOLT_SERVER_TLS is one value for every project",
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
 * @param {{ host?: string, port?: number|string, user?: string, database?: string, tls?: boolean,
 *   backup?: boolean, force?: boolean }} flags
 *   `tls` declares the transport in this project's metadata.json (undefined leaves it undeclared,
 *   inheriting the ambient `BEADS_DOLT_SERVER_TLS`); `backup: false` skips the pre-flip export;
 *   `force: true` accepts a server board that is MISSING issues the board being moved has (starting
 *   a deliberately fresh board), and is the only way to switch when the board being moved cannot be
 *   read at all — with no source ids, nothing verifies what arrived.
 * @param {{ exec?: Function, env?: NodeJS.ProcessEnv, now?: () => Date, log?: (msg: string) => void,
 *   onStep?: (step: { name: string, status: string, detail?: string }) => void }} [opts]
 * @returns {{ ok, steps, connection?, errors, before?, counts?, backup?, missing?, drifted? }}
 *   `missing` is the ids this board holds that the server's copy does not — empty once the check
 *   has passed. `drifted` is the ids that appeared, disappeared or were EDITED on the board being
 *   moved while the switch was being prepared, i.e. a writer that was never stopped.
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
  //    post-flip read is checked against, and it is taken BEFORE the backup so every id in it is
  //    one the export below also carries. Step 5b re-reads it against the flip, so the ageing this
  //    ordering costs is caught rather than trusted.
  const counts = {};
  const idsBefore = readBoardIds(dir, { ...opts, board: before, content: true });
  if (idsBefore.ok) {
    counts.before = idsBefore.ids.length;
    record("board issues", "ok", `${idsBefore.ids.length} issues`);
  } else if (!flags.force) {
    // Fatal without --force. The arrived-whole check in step 7 is the only thing standing between
    // this project and a stale or unrelated copy on the server, and it needs these ids to run —
    // with no source set to compare, a successful switch says nothing about what arrived. Treating
    // that as "nothing missing" is how an unverified board gets reported as a clean move.
    record("board issues", "failed", idsBefore.detail);
    errors.push(
      `could not read the board being moved: ${idsBefore.detail} — without its issue ids the ` +
        "server's copy cannot be checked for what this board holds. Fix the read, or re-run with " +
        "--force to accept the server's board unverified — which is also the answer for a board " +
        "that is genuinely EMPTY, since an empty listing bd prints warnings around is not " +
        "distinguishable from no listing at all (readBoardIds).",
    );
    return fail({ before, connection, counts });
  } else {
    record("board issues", "skipped", `${idsBefore.detail} — --force`);
    emit(`could not read the current board (${idsBefore.detail}) — --force: skipping the arrived-whole check.`);
  }

  // 4. Back up before the flip. Only meaningful on an embedded board: a server board's data is not
  //    here, and exporting it would back up the very thing the move is leaving alone.
  let backup;
  if (before.mode !== "embedded") {
    record("backup", "skipped", "board is already on a shared server — its data is not local");
  } else if (flags.backup === false) {
    record("backup", "skipped", "--no-backup");
  } else {
    backup = backupBoard(dir, { ...opts, board: before });
    record("backup", backup.status === "written" ? "ok" : "failed", backup.detail ?? backup.path);
    if (backup.status !== "written") {
      // Refusing here is the point of the flag: an unbacked flip is exactly what --no-backup opts
      // into, and doing it by accident is not.
      errors.push(`board backup failed: ${backup.detail}`);
      return fail({ before, connection, counts, backup });
    }
  }

  // 5. Take the config.yaml snapshot FIRST — before the flip, not just before step 9 publishes into
  //    it. It is half of what `revert` puts back, and a snapshot that cannot be read (a permissions
  //    change, a path that is somehow a directory) is a rollback that cannot happen: taken after the
  //    metadata write, that read throws with the project already switched to an unverified server
  //    and no revert on the way out (PR #174 review). Read it while there is still nothing to undo.
  const configPath = join(beadsDir, "config.yaml");
  let configBefore = null;
  try {
    configBefore = existsSync(configPath) ? readFileSync(configPath, "utf8") : null;
  } catch (e) {
    record("config.yaml", "failed", String(e?.message ?? e));
    errors.push(
      `could not read ${configPath}: ${String(e?.message ?? e)} — it is half of what a failed ` +
        "switch is rolled back from, so the flip is refused rather than made unrevertable",
    );
    return fail({ before, connection, counts, backup });
  }

  // 5b. Re-read the board immediately before the flip and refuse if it moved. The reading in step 3
  //     ages across the backup — minutes of `bd export` on a big board — and nothing stops anton's
  //     scheduler or another shell from writing the embedded board in that window. An issue created
  //     there is missing from the server AND missing from the set step 8 checks, so the command
  //     would report a clean arrival over a bead nobody sees again; the later backup can even
  //     contain it without the verification ever noticing. The runbook's first instruction is to
  //     stop every writer — this is what proves it happened (PR #174 review).
  //     CONTENT, not just ids: a writer that closes a bead, retitles it, moves a label or adds a
  //     dependency leaves the id set identical, and step 8's arrived-whole check — ids again —
  //     would wave the stale server copy through, stranding that update in a database this project
  //     is about to stop reading. Comparing the per-issue digests catches every such write.
  //     Skipped under --force, which already accepts the server's board unverified: the second read
  //     costs a full board listing and would only refine a check that flag has switched off.
  if (idsBefore.ok && !flags.force) {
    const idsNow = readBoardIds(dir, { ...opts, board: before, content: true });
    if (!idsNow.ok) {
      record("board unchanged", "failed", idsNow.detail);
      errors.push(
        `the board being moved became unreadable while the switch was being prepared: ${idsNow.detail} ` +
          "— nothing has been changed. Fix the read and re-run, or re-run with --force to accept the " +
          "server's board unverified.",
      );
      return fail({ before, connection, counts, backup });
    }
    // One comparison covers all three shapes of drift: an id only the later read has (created), one
    // only the earlier read has (deleted), and one both hold under different digests (updated).
    const drifted = [...new Set([...idsBefore.ids, ...idsNow.ids])].filter(
      (id) => idsBefore.digests.get(id) !== idsNow.digests.get(id),
    );
    if (drifted.length) {
      record("board unchanged", "failed", `${drifted.length} issue${drifted.length === 1 ? "" : "s"} changed`);
      errors.push(
        `the board being moved changed while the switch was being prepared — ${drifted.length} issue` +
          `${drifted.length === 1 ? "" : "s"} appeared, disappeared or were edited (${drifted.slice(0, 5).join(", ")}` +
          `${drifted.length > 5 ? ", …" : ""}). Something is still writing this board, so neither the ` +
          "backup nor the arrived-whole check covers it. Stop anton (`anton stop`) and any agent or " +
          "shell writing here, then re-run.",
      );
      return fail({ before, connection, counts, backup, drifted });
    }
    record("board unchanged", "ok", `${idsNow.ids.length} issues, unchanged since the read`);
  }

  // 6. Write the mode + connection. metadata.json is the ONLY place the mode can live: `bd config
  //    set dolt.mode` reports success while writing a nested block into a file of flat dotted keys,
  //    from bd's lowest-priority source, and has no effect (anton-4gd2).
  const written = writeServerModeMetadata(dir, connection);
  record("metadata.json", written.status, written.changed.join(", ") || undefined);

  /** Undo both writes and report why — the board keeps working exactly as it did. */
  const revert = (reason) => {
    restoreFile(written.path, written.before);
    restoreFile(configPath, configBefore);
    record("metadata.json", "reverted", `${reason} — the board is untouched`);
  };

  // 7. Prove the connection before anything else trusts it.
  const tested = testDoltConnection(dir, connection, opts);
  record("bd dolt test", tested.ok ? "ok" : "failed", tested.detail);
  if (!tested.ok) {
    errors.push(`bd dolt test could not connect: ${tested.detail}`);
    revert("could not connect");
    return fail({ before, connection, counts, backup, hints: tested.hints });
  }

  // 8. Prove THIS board arrived, not just that some board answers. The server's copy is checked by
  //    identity: a stale or divergent copy of the same project can hold as many issues as the board
  //    being moved — more, even — while missing the ones written here since it diverged, and a
  //    count would wave it through onto an incomplete board every later write then compounds.
  const idsAfter = readBoardIds(dir, { ...opts, board: connection });
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

  // 9. Only now publish the team-wide defaults into config.yaml — `revert` restores the file from
  //    the snapshot above, so a failed attempt leaves it exactly as it was rather than carrying
  //    half a connection. `bd dolt set --update-config` refuses in embedded mode, which is why this
  //    comes after the metadata write rather than before it.
  // Both take the project-scoped runner: on a server board `bd config set` and `bd dolt set` talk
  // to the database, so they need the same narrowed credentials the test above proved.
  const exec = scopedBdRunner(dir, connection, opts);
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
