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
 *   3. **Prove the board arrived, whole and current.** The board read before the flip is compared
 *      with the one read back from the server: every record must be there, and must say on the
 *      server exactly what it says here. A record is a `bd export` line — an issue with its labels,
 *      dependencies and full comment thread, or a persistent memory — because a comment and a
 *      `bd remember` are durable board state a listing never shows, and stranding them is as
 *      permanent as stranding a bead (PR #174 review). A missing record means the data copy has not
 *      happened or landed in another database; one whose content differs means the server's copy and
 *      this board were edited apart — in EITHER direction, because a later `updated_at` on the
 *      server orders two writes without merging them and so is no proof its row carries this
 *      board's edit. Both are the class of mistake that makes an otherwise-successful switch look
 *      fine while the team stares at a board with work missing from it. It reverts rather than
 *      reports.
 *   4. **Prove nobody wrote it meanwhile.** The board is read once to measure and once more
 *      immediately before the flip, and every record's CONTENT is compared, not just the key set: an
 *      update the server's copy predates would otherwise sail through step 3 and be stranded in the
 *      database this project is about to stop reading. What remains is the flip itself — a single
 *      `metadata.json` write, milliseconds rather than the minutes an export takes.
 *
 * On any of those failures `metadata.json` AND `.beads/config.yaml` are restored byte-for-byte, so a
 * failed attempt leaves a working board rather than a project pointed at a server it cannot read.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
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
  hasLocalDoltDb,
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
 * The RAW `.beads/metadata.json` as `{ status, raw, detail? }` — `status` is `"absent"` (no file
 * yet), `"read"` (parsed into `raw`), or `"unreadable"` (the file is there and cannot be used).
 *
 * `readDoltMetadata` is the MODE reader and deliberately drops everything about an embedded board;
 * this path needs the file as written — both to default the database name from the embedded board's
 * own `dolt_database`, and to merge rather than replace (bd keeps `project_id`, `backend` and
 * friends in there, and losing them would sever the workspace's identity).
 *
 * Which is exactly why "absent" and "unreadable" are told apart rather than both folded to `{}`:
 * the write below MERGES over `raw`, so an unreadable file read as empty would silently REPLACE
 * every key in it with the connection alone — losing `project_id` and `backend` to fix a mode (PR
 * #174 review). An absent file has nothing to lose; an unparseable one has everything, so it is
 * reported and the caller refuses.
 */
export function readMetadataFile(dir) {
  const path = join(dir, ".beads", "metadata.json");
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch (e) {
    // ENOENT alone is "not written yet". Anything else — a permissions change, a path that is
    // somehow a directory — is a file this cannot see, not a file that is not there.
    if (e?.code === "ENOENT") return { status: "absent", raw: {} };
    return { status: "unreadable", raw: {}, detail: `could not read ${path}: ${String(e?.message ?? e)}` };
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    return { status: "unreadable", raw: {}, detail: `${path} is not valid JSON: ${String(e?.message ?? e)}` };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { status: "unreadable", raw: {}, detail: `${path} is not a JSON object` };
  }
  return { status: "read", raw: parsed };
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
 * @param {Record<string, unknown>} raw the `raw` of {@link readMetadataFile}
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
 * Everything the flip needs, computed without touching a thing: `{ status, changed, before, path,
 * text, detail? }`. `status` is `"prepared"` (write `text` and the mode is server), `"already"` (the
 * file says exactly this already) or `"unreadable"` — which prepares NOTHING, because merging over a
 * file this cannot parse would replace it wholesale (see {@link readMetadataFile}). `before` is the
 * file's exact prior text, or `null` when there was none — what {@link restoreFile} puts back when a
 * verification fails.
 *
 * Split from the write because ORDER is the protection here (PR #174 review). The board is read one
 * last time immediately before the flip to prove no writer is still going, and anything that runs
 * between that read and the write is a window in which an edit lands in the database this project is
 * about to stop reading. bd offers no writer lock to hold across the two — there is no `bd lock`,
 * and its `--readonly` binds only the invocation it is passed to — so the window is made as small as
 * a window can be: reading `metadata.json`, merging it and serializing it all happen BEFORE that
 * read, leaving the flip itself a byte comparison and a single `writeFileSync`. The comparison is
 * what `before` is for on the caller's side too: preparing early means the merge can age against
 * the file it was computed from, so the caller re-reads the bytes and refuses rather than writing
 * over an edit that landed in between. Stopping every writer first, which the runbook demands and
 * the drift check verifies, is what actually closes the window.
 */
/**
 * A file's exact bytes as `{ ok: true, text }`, with `text: null` for one that does not exist —
 * `{ ok: false, detail }` for one that exists and cannot be read. Reads rather than
 * tests-then-reads: a file that turned into a directory, or lost its read permission, since the
 * caller last looked is a controlled refusal here, where a bare `readFileSync` would throw past
 * every revert path and take the CLI out on an uncaught rejection (PR #174 review). No snapshot
 * also means no restore, which is itself the reason to refuse rather than continue.
 */
function readFileSnapshot(path) {
  try {
    return { ok: true, text: readFileSync(path, "utf8") };
  } catch (e) {
    if (e?.code === "ENOENT") return { ok: true, text: null };
    return { ok: false, detail: `could not read ${path}: ${String(e?.message ?? e)}` };
  }
}

export function prepareServerModeMetadata(dir, connection) {
  const path = join(dir, ".beads", "metadata.json");
  // The restore snapshot goes through the same guarded read as the parse below.
  const snapshot = readFileSnapshot(path);
  if (!snapshot.ok) return { status: "unreadable", changed: [], before: null, path, detail: snapshot.detail };
  const before = snapshot.text;
  const meta = readMetadataFile(dir);
  if (meta.status === "unreadable") return { status: "unreadable", changed: [], before, path, detail: meta.detail };
  const raw = meta.raw;

  const next = { ...raw, dolt_mode: "server" };
  for (const [field, key] of Object.entries(SERVER_METADATA_KEYS)) {
    if (connection[field] !== undefined) next[key] = connection[field];
  }

  const changed = Object.keys(next).filter((k) => raw[k] !== next[k]);
  const text = `${JSON.stringify(next, null, 2)}\n`;
  if (before === text) return { status: "already", changed: [], before, path, text };
  return { status: "prepared", changed, before, path, text };
}

/**
 * Replace a file's contents so that a failure leaves the previous ones intact: the new text goes to
 * a sibling temp file, which is renamed over the target only once it is fully written. A plain
 * `writeFileSync` truncates its target before it can fail, so a full disk, a read-only mount or an
 * I/O error part-way through leaves `metadata.json` empty or half-written — a workspace whose
 * connection details no longer parse, from a command whose whole point is not to lose boards
 * (PR #174 review). `rename` is atomic within a filesystem, and the temp file is kept in the same
 * directory to stay on one. The error still propagates; only the damage does not.
 */
export function writeFileAtomic(path, text) {
  const tmp = `${path}.anton-${process.pid}.tmp`;
  try {
    writeFileSync(tmp, text);
    renameSync(tmp, path);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
}

/**
 * {@link prepareServerModeMetadata} and then the write — `{ status: "already"|"written"|"unreadable",
 * changed, before, path }`. The one-call form, for callers with no read to sequence against.
 */
export function writeServerModeMetadata(dir, connection) {
  const prepared = prepareServerModeMetadata(dir, connection);
  if (prepared.status !== "prepared") return prepared;
  writeFileAtomic(prepared.path, prepared.text);
  return { ...prepared, status: "written" };
}

/**
 * Put back a file this flow replaced — `before` is its exact prior text, `null` when it did not
 * exist (in which case the file is removed). Used for both `metadata.json` and `config.yaml`.
 */
export function restoreFile(path, before) {
  if (before === null) rmSync(path, { force: true });
  else writeFileAtomic(path, before);
}

/** Everything a bd invocation printed, both streams — bd puts its config warnings on stderr. */
const output = (r) => `${r?.stdout ?? ""}${r?.stderr ?? ""}`;

/**
 * The arguments that read EVERY durable thing this project's board holds, as JSONL on stdout.
 *
 * `bd export`, NOT `bd list --json`, and that is the whole of the point (PR #174 review). A listing
 * carries issue projections: it counts an issue's comments without printing them, and it does not
 * print persistent memories (`bd remember`) at all. Both are durable board state — a review thread
 * is the reasoning behind a decision, a memory is what the next session inherits — so a comment
 * EDITED in place, or a memory written on either side of the copy, is a difference every check
 * below would score as "identical" before flipping the project onto a database that does not hold
 * it. `bd export` is the one read that carries all of it: one line per record, an issue with its
 * labels, dependencies and full comment thread, or a `{"_type":"memory"}` row.
 *
 * `--all` is what widens it past regular issues to infra beads, templates, gates AND memories
 * (memories are excluded by default because they can carry agent context); closed issues come as
 * standard. It is also exactly what {@link backupBoard} writes, so what is verified and what is
 * backed up are the same board. `bd export --all` exists in bd 1.1.0, anton's floor
 * (MIN_BD_VERSION).
 */
const exportAllArgs = () => ["export", "--all"];

/**
 * The key one exported record is compared under, or `undefined` when it carries nothing to compare
 * it by. An issue keeps its own bd id — the thing an operator pastes into `bd show` when a message
 * names it — and every other record type is namespaced by its `_type`, so a memory keyed `probe-3`
 * cannot pass for the bead of that name.
 */
function recordKey(record) {
  if (!record || typeof record !== "object" || Array.isArray(record)) return undefined;
  const id = typeof record.id === "string" && record.id !== "" ? record.id : undefined;
  const type = typeof record._type === "string" && record._type !== "" ? record._type : undefined;
  // No `_type` is bd's older export shape, which wrote issues alone.
  if (type === undefined || type === "issue") return id;
  const own = typeof record.key === "string" && record.key !== "" ? record.key : id;
  return own === undefined ? undefined : `${type}:${own}`;
}

/** JSON with object keys sorted at every depth, and every array ordered by its own serialization:
 * bd's field order and its row order — including the order it prints an issue's comments in — are
 * presentation, not board content, so none of them may read as a mid-flip edit. */
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
 * A fingerprint of one exported record as bd printed it — EVERY field, not a chosen few, so a
 * status, title, assignee, label, dependency, COMMENT or memory value written while the switch is
 * being prepared cannot slip past the drift check by leaving the key set intact (PR #174 review).
 * Hashed rather than kept, so a fingerprint per record costs 40 bytes on a board of any size.
 */
const recordDigest = (record) => createHash("sha1").update(stableJson(record)).digest("hex");

/**
 * bd's own last-write stamp for one record as epoch ms, or `undefined` when it carries none this can
 * order (a memory carries none). It names, but never excuses, a content difference across the
 * migration boundary: a server copy BEHIND this board is a snapshot copied before the last edits,
 * one AHEAD of it is a board someone kept writing after the copy. Both are divergence — ordering two
 * writes is not merging them — so the stamp chooses which fix the message names, not whether the
 * flip is allowed (PR #174 review).
 */
const recordUpdatedAt = (record) => {
  const ms = typeof record?.updated_at === "string" ? Date.parse(record.updated_at) : Number.NaN;
  return Number.isNaN(ms) ? undefined : ms;
};

/**
 * Everything this project's board holds right now: one key per record, and a content fingerprint
 * per key. A record is an issue (with its labels, dependencies and comment thread) or a persistent
 * memory — see {@link exportAllArgs} for why the read is an export rather than a listing.
 *
 * IDENTITY, not cardinality, is what answers "did the history actually arrive". A count proves only
 * that SOME board is on the other end: a server holding a stale or divergent copy of the same
 * project can match — or beat — the local count while missing issues the board being moved has, and
 * the flip would accept it and keep writing into the divergent copy. Comparing the key sets catches
 * that; comparing two numbers cannot. This runs once, on a one-time migration, so reading the whole
 * board is worth what it costs over `bd count`.
 *
 * The `digests` answer the other question — "is this the same board" — which keys alone cannot: a
 * writer that UPDATES an existing issue, or edits a comment on one, leaves the key set identical,
 * and so does a server snapshot copied before that update was made. `updated` orders two differing
 * copies of one record, which is how the second case can say which side was written last — not
 * whether the difference is safe.
 *
 * Returns `{ ok: true, keys, digests, updated }` or `{ ok: false, detail }` — a board that cannot be
 * read is reported, never silently treated as empty.
 *
 * @param {string} dir repo root
 * @param {{ board?: object, exec?: Function, env?: NodeJS.ProcessEnv }} [opts]
 *   `board` is the connection bd runs under (credentials + transport) — the board's own before the
 *   flip, the server's after it.
 */
export function readBoardRecords(dir, opts = {}) {
  const exec = scopedBdRunner(dir, opts.board, opts);
  // The network budget, not the local `bd` one: in server mode this read crosses the wire to the
  // Dolt server, exactly like the export in `backupBoard`. On a large board over a slow link the
  // 60s local budget times out — and a timeout here is not a warning, it is a refused flip before
  // it and a full revert after it (PR #174 review).
  const ms = budgetMs("network");
  const r = exec("bd", exportAllArgs(), ms);
  if ((r?.status ?? 1) !== 0) return { ok: false, detail: failureDetail(r, ms, output(r)) };

  // stdout only — bd's warnings go to stderr, and JSONL turns the ones that don't into a line that
  // simply does not parse, rather than brackets a scan has to tell apart from the payload's.
  const digests = new Map();
  const updated = new Map();
  let noise = false;
  for (const line of (r?.stdout ?? "").split("\n")) {
    if (line.trim() === "") continue;
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      noise = true; // a warning bd printed on stdout, not a record
      continue;
    }
    const key = recordKey(record);
    if (key === undefined) {
      // A record with nothing to compare it under cannot be verified, and dropping it quietly is
      // precisely how state gets stranded — so the whole read is reported as unusable instead.
      if (record && typeof record === "object" && !Array.isArray(record)) {
        return { ok: false, detail: "bd export printed a record with no id or key to compare it under" };
      }
      noise = true; // a bare string or number: bd talking, not exporting
      continue;
    }
    digests.set(key, recordDigest(record));
    updated.set(key, recordUpdatedAt(record));
  }

  // No records is a real answer — an empty board exports nothing — but ONLY when stdout held
  // nothing else either. Zero records alongside output this could not parse is a read that went
  // wrong, and calling that "the board is empty" would make the arrived-whole check in
  // configureServerMode pass over ANY server board. --force is the deliberate way through, and the
  // step that needs it names it.
  if (digests.size === 0 && noise) return { ok: false, detail: "bd export printed no readable board" };
  return { ok: true, keys: [...digests.keys()], digests, updated };
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
 *   `board` is the connection bd runs under — see {@link readBoardRecords}.
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

  // A large board's export reads every record — the network budget, same as bd init/bootstrap.
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
 *   `force: true` accepts a server board that is MISSING records the board being moved has, or that
 *   says something DIFFERENT about them in either direction (starting a deliberately fresh board,
 *   or switching a machine whose local board is a leftover copy), and is the only way to switch when
 *   the board being moved cannot be read at all — with no source read, nothing verifies what
 *   arrived. It does NOT get past an unreadable `metadata.json`: that refusal is about not
 *   destroying the file, which no amount of intent makes safe.
 * @param {{ exec?: Function, env?: NodeJS.ProcessEnv, now?: () => Date, log?: (msg: string) => void,
 *   onStep?: (step: { name: string, status: string, detail?: string }) => void }} [opts]
 * @returns {{ ok, steps, connection?, errors, warnings, before?, counts?, backup?, missing?,
 *   diverged?, extra?, drifted? }}
 *   Every key list below is {@link readBoardRecords}'s: a bead id for an issue (comment thread
 *   included), `memory:<key>` for a persistent memory.
 *   `missing` is the keys this board holds that the server's copy does not; `diverged` the keys it
 *   does hold but says something different about, in either direction — both empty once the checks
 *   have passed. `extra` is the other direction — keys only the SERVER has, which pass (they strand
 *   nothing) and are warned about, since they are either work created there or work deleted here
 *   that the flip brings back, and nothing bd prints tells those apart (see step 8c).
 *   `warnings` is what the run could NOT verify, on a run that otherwise succeeded — a project
 *   already reading the server verifies nothing about the embedded board still sitting next to it
 *   (see step 3), and a key only the server holds is not decidable from either read (step 8c).
 *   Callers must show them: they are the only notice an operator gets.
 *   `drifted` is the keys that appeared, disappeared or were EDITED on the board being moved while
 *   the switch was being prepared, i.e. a writer that was never stopped.
 */
export function configureServerMode(dir, flags = {}, opts = {}) {
  const emit = typeof opts.log === "function" ? opts.log : () => {};
  const onStep = typeof opts.onStep === "function" ? opts.onStep : () => {};
  const steps = [];
  const errors = [];
  const warnings = [];
  const beadsDir = join(dir, ".beads");
  const fail = (extra = {}) => ({ ok: false, steps, errors, warnings, ...extra });
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

  // 2. What the project is now, and what it should become. A metadata.json that EXISTS and cannot
  //    be parsed stops the command dead — and not even --force gets through, because the flip's own
  //    write merges over that file: reading it as empty would replace bd's `project_id`, `backend`
  //    and every key this module does not know about with the connection alone (PR #174 review).
  //    An unreadable file is a board with a broken identity, which is not a thing to fix by
  //    overwriting it.
  const meta = readMetadataFile(dir);
  if (meta.status === "unreadable") {
    record("metadata.json", "failed", meta.detail);
    errors.push(
      `${meta.detail} — switching writes this file by MERGING into it, so an unreadable one would ` +
        "be replaced outright, losing project_id, backend and anything else bd keeps there. " +
        "Repair or restore it (`.beads/backups/`, or git) and re-run.",
    );
    return fail();
  }
  const before = readDoltMetadata(dir);
  const { connection, errors: invalid } = resolveServerConnection(meta.raw, flags);
  if (invalid.length) {
    errors.push(...invalid);
    return fail({ before });
  }

  // 3. Read the board — every issue, comment thread and memory — while it is still pointed where it
  //    is now. This is the set the post-flip read is checked against, and it is taken BEFORE the
  //    backup so everything in it is something the export below also carries (both are `bd export
  //    --all`, so that is exact). Step 5b re-reads it against the flip, so the ageing this ordering
  //    costs is caught rather than trusted.
  //    WHOSE board that is, is the question a clone has to answer for itself. In server mode it is
  //    the SERVER's — so every check below compares the server with itself and proves nothing about
  //    any board on this machine. On a clone that never held the board that is the ordinary case
  //    (the runbook's second-machine step, which passes trivially by design). On a clone that DID,
  //    it is a trap: `.beads/metadata.json` is TRACKED, so the flip reaches every clone on `git
  //    pull` — before anyone checks that clone — and whatever it wrote embedded-side stays in
  //    `.beads/`, absent from the server's copy (PR #174 review). Nothing here can tell a leftover
  //    database deliberately abandoned after the move (the runbook keeps it, on every machine) from
  //    one holding edits that never travelled: comparison shows divergence either way. So the run
  //    reports what it did NOT verify instead of claiming a check it cannot make.
  const sourceIsServer = before.mode === "server";
  // Whether both reads come from the SAME board — which `sourceIsServer` alone does NOT say. A
  // re-run that repoints an existing server board at another host or database reads one server
  // before the flip and a different one after, so the copy-arrived question is live again and the
  // comparisons below must all apply (PR #174 review). Compared on what selects a board — host,
  // port, database — and conservatively: anything undeclared or unequal counts as a different
  // target, so doubt costs a warning rather than silence.
  const sameServerTarget =
    sourceIsServer &&
    typeof before.host === "string" &&
    typeof connection.host === "string" &&
    before.host.trim().toLowerCase() === connection.host.trim().toLowerCase() &&
    (before.port ?? DEFAULT_DOLT_PORT) === connection.port &&
    before.database !== undefined &&
    before.database === connection.database;
  if (sourceIsServer) {
    const local = hasLocalDoltDb(beadsDir);
    record(
      "local board",
      local ? "skipped" : "ok",
      local
        ? "present and NOT compared — this project already reads the server"
        : "none on this machine — nothing local to strand",
    );
    if (local) {
      warnings.push(
        "this project's metadata.json already says server mode, so the checks below read a server on " +
          `both sides — and ${beadsDir} still holds a local embedded Dolt database that nothing ` +
          "here has compared with either. metadata.json is tracked by git: the switch reaches every clone " +
          "on `git pull`, ahead of anyone checking that clone, so anything written here before the " +
          "pull is still in the local database and not on the server. To check it, put `dolt_mode` " +
          'back to "embedded" in .beads/metadata.json (git stash / git checkout the pulled change), ' +
          "run `bd export --all`, compare it with the server's, then re-run this command. " +
          "Nothing to do if that database is the leftover the runbook says to keep.",
      );
    }
  }

  const counts = {};
  const recordsBefore = readBoardRecords(dir, { ...opts, board: before });
  if (recordsBefore.ok) {
    counts.before = recordsBefore.keys.length;
    record("board records", "ok", `${recordsBefore.keys.length} records${sourceIsServer ? ", read from the server" : ""}`);
  } else if (!flags.force) {
    // Fatal without --force. The arrived-whole check in step 8 is the only thing standing between
    // this project and a stale or unrelated copy on the server, and it needs this read to run —
    // with no source set to compare, a successful switch says nothing about what arrived. Treating
    // that as "nothing missing" is how an unverified board gets reported as a clean move.
    record("board records", "failed", recordsBefore.detail);
    errors.push(
      `could not read the board being moved: ${recordsBefore.detail} — without it the server's copy ` +
        "cannot be checked for what this board holds. Fix the read, or re-run with --force to accept " +
        "the server's board unverified — which is also the answer for a board that is genuinely " +
        "EMPTY, since an export bd printed warnings on stdout around is not distinguishable from no " +
        "export at all (readBoardRecords).",
    );
    return fail({ before, connection, counts });
  } else {
    record("board records", "skipped", `${recordsBefore.detail} — --force`);
    emit(`could not read the current board (${recordsBefore.detail}) — --force: skipping the arrived-whole check.`);
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

  // 5a. Compute the flip — the merged metadata.json text, and the prior text a revert restores —
  //     BEFORE the re-read below rather than after it. That read is what proves no writer is still
  //     going, and everything between it and the write is a window in which an edit lands in the
  //     database this project is about to stop reading. There is no lock to hold across the two: bd
  //     exposes none (no `bd lock`; `--readonly` binds only the invocation it is passed to), and a
  //     lock anton invented would be honoured by nothing that writes this board (PR #174 review).
  //     So the window is made as small as one can be — reading, merging and serializing the file all
  //     happen here, leaving step 6 a byte comparison and a single `writeFileSync` — and the checks
  //     below refuse on any drift they did see, in the board (5b) and in the file itself (6a).
  //     Stopping every writer first, which the runbook demands, is what closes it.
  //     Preparing here also moves the unreadable-metadata refusal ahead of the work it would waste.
  const prepared = prepareServerModeMetadata(dir, connection);
  // Step 2 read the same file; this catches the window between — and keeps a refusal from reading as
  // a success to anything that calls the write directly.
  if (prepared.status === "unreadable") {
    record("metadata.json", "unreadable", prepared.detail);
    errors.push(`${prepared.detail} — nothing was written, so the board is untouched`);
    return fail({ before, connection, counts, backup });
  }

  // 5b. Re-read the board immediately before the flip and refuse if it moved. The reading in step 3
  //     ages across the backup — minutes of `bd export` on a big board — and nothing stops anton's
  //     scheduler or another shell from writing the embedded board in that window. An issue created
  //     there is missing from the server AND missing from the set step 8 checks, so the command
  //     would report a clean arrival over a bead nobody sees again; the later backup can even
  //     contain it without the verification ever noticing. The runbook's first instruction is to
  //     stop every writer — this is what proves it happened (PR #174 review).
  //     CONTENT, not just keys: a writer that closes a bead, retitles it, moves a label, adds a
  //     dependency, files a COMMENT or writes a memory leaves the key set identical or nearly so, so
  //     a check on keys alone would pass here AND on the server (step 8b compares content precisely
  //     because of this), stranding that write in a database this project is about to stop reading.
  //     The per-record digests catch every one.
  //     Skipped under --force, which already accepts the server's board unverified: the second read
  //     costs a full board export and would only refine a check that flag has switched off.
  if (recordsBefore.ok && !flags.force) {
    const recordsNow = readBoardRecords(dir, { ...opts, board: before });
    if (!recordsNow.ok) {
      record("board unchanged", "failed", recordsNow.detail);
      errors.push(
        `the board being moved became unreadable while the switch was being prepared: ${recordsNow.detail} ` +
          "— nothing has been changed. Fix the read and re-run, or re-run with --force to accept the " +
          "server's board unverified.",
      );
      return fail({ before, connection, counts, backup });
    }
    // One comparison covers all three shapes of drift: a key only the later read has (created), one
    // only the earlier read has (deleted), and one both hold under different digests (updated).
    const drifted = [...new Set([...recordsBefore.keys, ...recordsNow.keys])].filter(
      (key) => recordsBefore.digests.get(key) !== recordsNow.digests.get(key),
    );
    if (drifted.length) {
      record("board unchanged", "failed", `${drifted.length} record${drifted.length === 1 ? "" : "s"} changed`);
      errors.push(
        `the board being moved changed while the switch was being prepared — ${drifted.length} record` +
          `${drifted.length === 1 ? "" : "s"} appeared, disappeared or were edited (${drifted.slice(0, 5).join(", ")}` +
          `${drifted.length > 5 ? ", …" : ""}). Something is still writing this board, so neither the ` +
          "backup nor the arrived-whole check covers it. Stop anton (`anton stop`) and any agent or " +
          "shell writing here, then re-run.",
      );
      return fail({ before, connection, counts, backup, drifted });
    }
    record("board unchanged", "ok", `${recordsNow.keys.length} records, unchanged since the read`);
  }

  // 6. The flip: ONE write, immediately after the read that proved the board stood still — nothing
  //    between them but the comparison itself (see 5a). metadata.json is the only place the mode can
  //    live: `bd config set dolt.mode` reports success while writing a nested block into a file of
  //    flat dotted keys, from bd's lowest-priority source, and has no effect (anton-4gd2).
  //    Written atomically, and a failure reported rather than thrown: this is the one write that
  //    happens before `revert` exists, so an unhandled ENOSPC/EROFS/EIO here would leave the CLI
  //    exiting on a stack trace over a metadata.json a plain write had already truncated
  //    (PR #174 review). {@link writeFileAtomic} keeps the previous file intact through the
  //    failure, so there is nothing to roll back — config.yaml is not published until step 9 — and
  //    the flow returns the same structured refusal every other pre-flip check does.
  if (prepared.status === "prepared") {
    // 6a. The merge in step 5a was computed over metadata.json as it read THEN, and the board
    //     re-read since can run for the whole network budget. An edit that landed in that window —
    //     a project_id correction, a TLS or connection fix, another clone's switch — is text this
    //     write would replace with a merge that never saw it, and a rename is not something the
    //     losing edit comes back from (PR #174 review). The board's own drift check refuses on the
    //     same evidence; this is the file's. Bytes, not parsed keys: what a revert restores is
    //     bytes, so anything that would not restore identically counts as drift.
    const current = readFileSnapshot(prepared.path);
    if (!current.ok) {
      record("metadata.json", "failed", current.detail);
      errors.push(`${current.detail} — nothing was written, so the board is untouched`);
      return fail({ before, connection, counts, backup });
    }
    if (current.text !== prepared.before) {
      const detail = "changed while the switch was being prepared";
      record("metadata.json", "failed", detail);
      errors.push(
        `${prepared.path} ${detail} — something else edited it, and writing the switch computed ` +
          "from its earlier contents would drop that edit. Nothing was written, so the board is " +
          "untouched. Stop anton (`anton stop`) and any agent or shell writing here, then re-run " +
          "to merge the switch over the current file.",
      );
      return fail({ before, connection, counts, backup });
    }
    try {
      writeFileAtomic(prepared.path, prepared.text);
    } catch (e) {
      const detail = String(e?.message ?? e);
      record("metadata.json", "failed", detail);
      errors.push(
        `could not write ${prepared.path}: ${detail} — the file still holds its previous contents ` +
          "and the board is untouched. Free up space or fix the permissions on `.beads/`, then re-run.",
      );
      return fail({ before, connection, counts, backup });
    }
  }
  record("metadata.json", prepared.status === "prepared" ? "written" : prepared.status, prepared.changed.join(", ") || undefined);

  /** Undo both writes and report why — the board keeps working exactly as it did. */
  const revert = (reason) => {
    restoreFile(prepared.path, prepared.before);
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
  //    identity: a stale or divergent copy of the same project can hold as many records as the board
  //    being moved — more, even — while missing the ones written here since it diverged, and a
  //    count would wave it through onto an incomplete board every later write then compounds.
  //    And by CONTENT, because key membership has the same blind spot on this side of the boundary
  //    as it does on the other one (step 5b): a server snapshot copied from an older export holds
  //    every key while its titles, statuses, labels, dependencies, assignees and comment threads
  //    predate the board being moved, and a keys-only check would flip onto it and strand every one
  //    of those updates in the database this project is about to stop reading (PR #174 review).
  const recordsAfter = readBoardRecords(dir, { ...opts, board: connection });
  record(
    "server board records",
    recordsAfter.ok ? "ok" : "failed",
    recordsAfter.ok ? `${recordsAfter.keys.length} records` : recordsAfter.detail,
  );
  if (!recordsAfter.ok) {
    // Fatal, unlike the pre-flip read: reading the board back IS the verification, and `bd dolt
    // test` does not stand in for it. A server can answer the connection test and still refuse the
    // database — bd's own project-identity guard does exactly that when the connection names a
    // database belonging to another project ("PROJECT IDENTITY MISMATCH — refusing to connect").
    errors.push(`the server accepted the connection but this project cannot read its board: ${recordsAfter.detail}`);
    revert("board unreadable on the server");
    return fail({ before, connection, counts, backup });
  }
  counts.after = recordsAfter.keys.length;

  const onServer = new Set(recordsAfter.keys);
  const missing = recordsBefore.ok ? recordsBefore.keys.filter((key) => !onServer.has(key)) : [];
  if (missing.length && !flags.force) {
    errors.push(
      `the server's "${connection.database}" database is missing ${missing.length} of this board's ` +
        `${counts.before} records (${missing.slice(0, 5).join(", ")}${missing.length > 5 ? ", …" : ""}) — ` +
        "its history has not been copied onto the server yet",
    );
    revert("server board is missing records");
    return fail({ before, connection, counts, backup, missing });
  }

  // 8b. Every key the server DOES hold, compared by content against the board being moved. A copy
  //     whose digest matches is the same record; ANY difference is divergence and refuses, in both
  //     directions. A NEWER `updated_at` on the server is not the exception it looks like (PR #174
  //     review): it says the server's row was written last, not that it carries this board's edit.
  //     Close a bead here at t1 while the stale server copy is retitled at t2 and the server wins
  //     on timestamp while missing the close — flipping onto it strands exactly the update the
  //     check exists to protect. Nothing bd prints proves the server's row descends from this one,
  //     so content equality is the only evidence accepted; `--force` remains the deliberate
  //     override, and the key check still accepts keys the server holds and this board does not.
  const diverged = recordsBefore.ok
    ? recordsBefore.keys.filter((key) => onServer.has(key) && recordsAfter.digests.get(key) !== recordsBefore.digests.get(key))
    : [];
  // The stamp picks the fix to name, not the verdict: behind → the copy is old, re-run Phase 1;
  // ahead → both sides were written after the copy, so the two boards have to be reconciled by a
  // human (or forced, if this board is the leftover of a machine that already switched).
  const ahead = diverged.filter((key) => {
    const here = recordsBefore.updated.get(key);
    const there = recordsAfter.updated.get(key);
    return here !== undefined && there !== undefined && there > here;
  });
  if (diverged.length && !flags.force) {
    const n = diverged.length;
    errors.push(
      `the server's "${connection.database}" database holds all of this board's records but ${n} ` +
        `of them say${n === 1 ? "s" : ""} something different there ` +
        `(${diverged.slice(0, 5).join(", ")}${n > 5 ? ", …" : ""}) — a title, a status, a label, a ` +
        "dependency, a comment or a memory value. The copy on the server and this " +
        "board were edited apart, so switching would strand every one of those differences in the " +
        "database being left behind. " +
        (ahead.length === n
          ? "Those rows were written LAST on the server, which does not mean they contain this " +
            "board's edits — a later timestamp orders two writes, it does not merge them. Reconcile " +
            "the two boards (compare a `bd export --all` from each); --force is right only when this " +
            "machine's board is a leftover copy nobody has written since it was copied."
          : ahead.length
            ? `${ahead.length} of them (${ahead.slice(0, 5).join(", ")}${ahead.length > 5 ? ", …" : ""}) ` +
              "were written last on the server, which orders the two writes without merging them; the " +
              "rest are older there. Re-run Phase 1 of the runbook with a current copy, or reconcile " +
              "the two boards before forcing."
            : "The copy on the server predates this board. Re-run Phase 1 of the runbook with a " +
              "current copy.") +
        // EVERY record differing is not a stale snapshot — nothing edits a whole board — it is the
        // two sides describing the same rows differently. Named, because the fix is the opposite
        // one (look at the exports, then --force) and an operator should not have to guess.
        (n === recordsBefore.keys.length
          ? " (That is EVERY record on the board, which usually means the two sides print the same " +
            "rows differently rather than that the boards really diverged — compare a `bd export " +
            "--all` from each before reaching for --force.)"
          : ""),
    );
    revert("server board differs from this one");
    return fail({ before, connection, counts, backup, missing, diverged });
  }

  // 8c. Keys the SERVER holds and this board does not. Two different things wear that shape and
  //     nothing bd prints tells them apart (PR #174 review): a teammate's issue created on the
  //     server after Phase 1 copied it — the ordinary case for a machine joining a board others
  //     already moved onto — or an issue deleted HERE after that copy (`bd delete`, an epic removed
  //     with --cascade), which the server still carries and the flip would bring back. Deciding
  //     would need ancestry or a tombstone; bd exposes neither, so the run does not decide.
  //     Reported rather than refused, because the two directions are not the same failure: a
  //     missing or divergent record is this board's work stranded in a database about to be
  //     abandoned, which nothing recovers — one only the server has is work that survives the flip
  //     either way, and a resurrected bead is deleted again in one command. Refusing would also push
  //     the runbook's second machine onto --force, which switches off the checks above that guard
  //     the unrecoverable half. So the keys are named and the operator decides.
  //     Suppressed only when both reads hit the SAME server database: there a key in one and not
  //     the other is a teammate writing between two reads — nothing to do with a copy, and the
  //     warning would be pure noise. Being in server mode is not enough to claim that (PR #174
  //     review): repointing a server board at another host or database compares two different
  //     boards, where a destination-only key is once again either new work or work deleted on the
  //     board being left — exactly what this warning is for.
  const here = new Set(recordsBefore.ok ? recordsBefore.keys : []);
  const extra = recordsBefore.ok && !sameServerTarget ? recordsAfter.keys.filter((key) => !here.has(key)) : [];
  if (extra.length) {
    const n = extra.length;
    const named = `${extra.slice(0, 5).join(", ")}${n > 5 ? ", …" : ""}`;
    record("server-only records", "skipped", `${n} not compared — present there, absent here`);
    warnings.push(
      `the server's "${connection.database}" database holds ${n} record${n === 1 ? "" : "s"} this ` +
        `board does not (${named}). Everything this board holds arrived intact — these are the other ` +
        "direction, and nothing here can say which of two things they are: work created on the " +
        `server since it was copied (normal — the board moved on without this machine), or work ` +
        `deleted HERE after the copy, which the server still carries and this switch has just brought ` +
        "back. Check them (`bd show <id>`): keep them, or delete them again on the now-shared board.",
    );
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
    return fail({ before, connection, counts, backup, missing, diverged, extra });
  }

  return { ok: true, steps, errors, warnings, before, connection, counts, backup, missing, diverged, extra };
}
