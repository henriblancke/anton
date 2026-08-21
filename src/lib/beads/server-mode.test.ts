/**
 * `anton server-mode` — pointing ONE project's board at a shared Dolt server (anton-yvjd).
 *
 * The claims worth asserting are the SAFETY ones, because the command's whole reason to exist is
 * that the manual version of it loses boards: metadata.json is merged rather than replaced, every
 * failure after the write puts the file back byte-for-byte, and a server that answers `bd dolt test`
 * but cannot serve this project's board is a failure, not a success. bd is stubbed through the
 * injected `exec` — the real one needs a live server, and a unit test must not.
 */
import { afterEach, describe, expect, it } from "vitest";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { configYamlValue } from "./config.mjs";
import {
  DEFAULT_DOLT_PORT,
  backupBoard,
  configureServerMode,
  prepareServerModeMetadata,
  readBoardRecords,
  readMetadataFile,
  resolveServerConnection,
  restoreFile,
  testDoltConnection,
  writeFileAtomic,
  writeServerModeMetadata,
} from "./server-mode.mjs";

const EMBEDDED = {
  database: "dolt",
  backend: "dolt",
  dolt_mode: "embedded",
  dolt_database: "probe",
  project_id: "8040cdee-1234",
};

const CONNECTION = { host: "dolt.example.dev", port: 3306, user: "beads", database: "probe" };

/** The board being moved, as ids — what the server's copy is checked against. */
const BOARD = ["probe-1", "probe-2", "probe-3", "probe-4", "probe-5", "probe-6", "probe-7"];

const dirs: string[] = [];

/** A repo dir with `.beads/` holding `metadata.json` (when given) and an empty config.yaml. */
function repo(metadata?: object | string): string {
  const dir = mkdtempSync(join(tmpdir(), "anton-server-mode-"));
  dirs.push(dir);
  mkdirSync(join(dir, ".beads"), { recursive: true });
  writeFileSync(join(dir, ".beads", "config.yaml"), "prefix: probe\n");
  if (metadata !== undefined) {
    writeFileSync(join(dir, ".beads", "metadata.json"), typeof metadata === "string" ? metadata : JSON.stringify(metadata, null, 2));
  }
  return dir;
}

const metadataPath = (dir: string) => join(dir, ".beads", "metadata.json");
const readMetadata = (dir: string) => JSON.parse(readFileSync(metadataPath(dir), "utf8"));

type Result = { status: number | null; stdout?: string; stderr?: string };

/**
 * `bd export --all` as bd prints it: one JSON record per line, with a warning on stdout in front of
 * them (some bd versions put their deprecation notices there). An EMPTY board exports nothing at
 * all, which is what an empty `records` models.
 */
const exported = (records: object[]) =>
  records.length ? `Warning: deprecated\n${records.map((r) => JSON.stringify(r)).join("\n")}\n` : "";

/** The export of a board holding exactly these issue ids and nothing else. */
const listing = (ids: string[]) => exported(ids.map((id) => ({ _type: "issue", id, title: id })));

/**
 * The verification read, told apart from the backup: both are `bd export --all`, and only the
 * backup redirects to a file with `-o`.
 */
const isRead = (args: string[]) => args[0] === "export" && !args.includes("-o");

/**
 * A stub `bd` that records every invocation and answers by subcommand. The board read answers from
 * the board the project is CURRENTLY pointed at — `after` once metadata.json says server, `before`
 * until then — rather than from a call counter, so a case stays correct however many times the flow
 * reads either side (it reads the source twice: once to measure, once again right before the flip
 * to catch a concurrent write). `dir` is what makes that readable; without it every read is
 * `before`.
 */
function fakeBd(
  opts: { dir?: string; before?: string[]; after?: string[]; test?: Result; export?: Result; version?: string } = {},
) {
  const calls: string[][] = [];
  const exec = (cmd: string, args: string[]): Result => {
    calls.push([cmd, ...args]);
    if (args[0] === "--version") return { status: 0, stdout: `bd version ${opts.version ?? "1.1.2"} (fake)` };
    if (isRead(args)) {
      const onServer = opts.dir !== undefined && readMetadataFile(opts.dir).raw.dolt_mode === "server";
      const board = onServer ? (opts.after ?? opts.before) : opts.before;
      return board === undefined ? { status: 1, stderr: "no board" } : { status: 0, stdout: listing(board) };
    }
    if (args[0] === "export") return opts.export ?? { status: 0 };
    if (args[0] === "dolt" && args[1] === "test") return opts.test ?? { status: 0, stdout: "✓ Connection successful" };
    return { status: 0 };
  };
  return { calls, exec };
}

/** Every bd invocation as a flat string, for `toContain`-style assertions. */
const cmdline = (calls: string[][]) => calls.map((c) => c.join(" "));

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("resolveServerConnection", () => {
  it("takes flags over metadata, and metadata over nothing", () => {
    const raw = { dolt_server_host: "old.example.dev", dolt_server_port: 3307, dolt_database: "probe" };
    expect(resolveServerConnection(raw, { host: "new.example.dev", user: "beads" }).connection).toEqual({
      host: "new.example.dev",
      port: 3307,
      user: "beads",
      database: "probe",
    });
  });

  // The database name is the one field a board being MOVED already knows — re-typing it is how a
  // project ends up pointed at a database that isn't its own.
  it("defaults the database from an embedded board's own dolt_database", () => {
    const { connection, errors } = resolveServerConnection(EMBEDDED, { host: "dolt.example.dev" });
    expect(errors).toEqual([]);
    expect(connection).toEqual({ host: "dolt.example.dev", port: DEFAULT_DOLT_PORT, user: undefined, database: "probe" });
  });

  // Transport is per project (PR #174 review), and silence is not a declaration: a board configured
  // before --tls existed must keep inheriting the ambient BEADS_DOLT_SERVER_TLS.
  it("carries the declared transport, and none when neither the flags nor the file names one", () => {
    expect(resolveServerConnection(EMBEDDED, { host: "h", database: "d", tls: true }).connection.tls).toBe(true);
    expect(resolveServerConnection({ ...EMBEDDED, dolt_server_tls: true }, { host: "h", database: "d" }).connection.tls).toBe(true);
    // A flag beats the file in both directions.
    expect(resolveServerConnection({ ...EMBEDDED, dolt_server_tls: true }, { host: "h", database: "d", tls: false }).connection.tls).toBe(false);
    expect(resolveServerConnection(EMBEDDED, { host: "h", database: "d" }).connection.tls).toBeUndefined();
  });

  it.each([
    ["no host", {}, /--host/],
    ["no database", { host: "dolt.example.dev" }, /--database/],
    ["a non-numeric port", { host: "h", database: "d", port: "http" }, /--port/],
    ["a port out of range", { host: "h", database: "d", port: 70000 }, /--port/],
  ])("reports %s as an error naming the flag", (_label, flags, expected) => {
    const { errors } = resolveServerConnection({}, flags);
    expect(errors.some((e: string) => expected.test(e))).toBe(true);
  });
});

/**
 * The flip is prepared BEFORE the board is read one last time and written straight after it, so the
 * span between "nothing is writing this board" and "this project no longer reads it" is a single
 * write rather than a re-read and re-merge of metadata.json. bd has no writer lock to hold across
 * the two, so that span is the whole of the protection this side can offer (PR #174 review).
 */
describe("prepareServerModeMetadata", () => {
  it("computes the flip without touching the file", () => {
    const dir = repo(EMBEDDED);
    const original = readFileSync(metadataPath(dir), "utf8");

    const prepared = prepareServerModeMetadata(dir, CONNECTION);

    expect(prepared.status).toBe("prepared");
    expect(readFileSync(metadataPath(dir), "utf8")).toBe(original);
    expect(prepared.before).toBe(original);
    // The text is the whole merged file, ready to land in one write.
    expect(JSON.parse(String(prepared.text))).toEqual({
      ...EMBEDDED,
      dolt_mode: "server",
      dolt_server_host: CONNECTION.host,
      dolt_server_port: CONNECTION.port,
      dolt_server_user: CONNECTION.user,
      dolt_database: CONNECTION.database,
    });
  });

  it("reports a file that already says exactly this, and one it cannot parse", () => {
    const dir = repo(EMBEDDED);
    writeServerModeMetadata(dir, CONNECTION);
    expect(prepareServerModeMetadata(dir, CONNECTION).status).toBe("already");

    const broken = repo("{ not json");
    const prepared = prepareServerModeMetadata(broken, CONNECTION);
    expect(prepared.status).toBe("unreadable");
    expect(prepared.text).toBeUndefined();
    expect(readFileSync(metadataPath(broken), "utf8")).toBe("{ not json");
  });

  /**
   * The rollback snapshot is taken with the SAME guarded read as the parse (PR #174 review). A
   * metadata.json that exists and cannot be read — a permissions change, a path that is somehow a
   * directory — used to throw out of the bare `readFileSync` taking the snapshot, past every revert
   * path, so the CLI died on an uncaught rejection instead of refusing.
   */
  it("reports a file it cannot READ rather than throwing out of the snapshot", () => {
    const dir = repo(EMBEDDED);
    rmSync(metadataPath(dir));
    mkdirSync(metadataPath(dir));

    const prepared = prepareServerModeMetadata(dir, CONNECTION);
    expect(prepared.status).toBe("unreadable");
    expect(prepared.detail).toMatch(/could not read .*metadata\.json/);
    // No snapshot means no restore — which is itself the reason to refuse rather than continue.
    expect(prepared.before).toBeNull();
    expect(prepared.text).toBeUndefined();
    expect(() => writeServerModeMetadata(dir, CONNECTION)).not.toThrow();
  });
});

describe("writeServerModeMetadata", () => {
  it("sets the mode + connection and PRESERVES every other key", () => {
    const dir = repo(EMBEDDED);
    const written = writeServerModeMetadata(dir, CONNECTION);

    expect(written.status).toBe("written");
    expect(readMetadata(dir)).toEqual({
      ...EMBEDDED,
      dolt_mode: "server",
      dolt_server_host: "dolt.example.dev",
      dolt_server_port: 3306,
      dolt_server_user: "beads",
      dolt_database: "probe",
    });
    // project_id is bd's workspace identity — losing it is how a board stops recognising its database.
    expect(readMetadata(dir).project_id).toBe(EMBEDDED.project_id);
  });

  it("is a true no-op when the file already says exactly this", () => {
    const dir = repo(EMBEDDED);
    writeServerModeMetadata(dir, CONNECTION);
    const before = readFileSync(metadataPath(dir), "utf8");

    const second = writeServerModeMetadata(dir, CONNECTION);
    expect(second.status).toBe("already");
    expect(second.changed).toEqual([]);
    expect(readFileSync(metadataPath(dir), "utf8")).toBe(before);
  });

  it("restores the exact prior bytes, and removes a file it created", () => {
    const dir = repo("{\n  \"dolt_mode\": \"embedded\"\n}");
    const original = readFileSync(metadataPath(dir), "utf8");
    const written = writeServerModeMetadata(dir, CONNECTION);
    restoreFile(written.path, written.before);
    expect(readFileSync(metadataPath(dir), "utf8")).toBe(original);

    const fresh = repo();
    const created = writeServerModeMetadata(fresh, CONNECTION);
    restoreFile(created.path, created.before);
    expect(existsSync(metadataPath(fresh))).toBe(false);
  });

  /**
   * The write MERGES into metadata.json, so a file it cannot parse must not be read as `{}` — that
   * turns the merge into a replace and drops `project_id`, `backend` and every key bd keeps there
   * on a board whose only actual problem was its mode (PR #174 review).
   */
  it("tells an ABSENT metadata.json from an unreadable one, and refuses to overwrite the latter", () => {
    expect(readMetadataFile(repo())).toEqual({ status: "absent", raw: {} });
    expect(readMetadataFile(repo(EMBEDDED))).toEqual({ status: "read", raw: EMBEDDED });

    for (const bad of ["{ not json", '["an", "array"]', "null"]) {
      const dir = repo(bad);
      const read = readMetadataFile(dir);
      expect(read.status, `${bad} read as ${read.status}`).toBe("unreadable");
      expect(read.raw).toEqual({});

      const written = writeServerModeMetadata(dir, CONNECTION);
      expect(written.status).toBe("unreadable");
      expect(written.detail).toContain("metadata.json");
      // Not one byte written — the refusal is the whole point.
      expect(readFileSync(metadataPath(dir), "utf8")).toBe(bad);
    }
  });
});

/**
 * A plain `writeFileSync` truncates before it can fail, so a full disk or a read-only mount would
 * leave metadata.json empty — connection details a workspace can no longer read, lost by the one
 * command that exists not to lose boards (PR #174 review). Root ignores the permission bits this
 * simulates the failure with, so the case is skipped there rather than asserted falsely.
 */
describe.skipIf(process.getuid?.() === 0)("writeFileAtomic", () => {
  it("leaves the previous contents intact when the write fails, and drops its temp file", () => {
    const dir = repo(EMBEDDED);
    const original = readFileSync(metadataPath(dir), "utf8");
    const beadsDir = join(dir, ".beads");
    chmodSync(beadsDir, 0o555);
    try {
      expect(() => writeFileAtomic(metadataPath(dir), "replacement\n")).toThrow();
      expect(readFileSync(metadataPath(dir), "utf8")).toBe(original);
    } finally {
      chmodSync(beadsDir, 0o755);
    }
    expect(readdirSync(beadsDir).filter((f) => f.includes(".tmp"))).toEqual([]);
  });
});

describe("readBoardRecords", () => {
  /** The parse, without the digests — those are asserted on their own below. */
  const keys = (stdout: string) => {
    const read = readBoardRecords(repo(EMBEDDED), { exec: () => ({ status: 0, stdout }) });
    return read.ok ? { ok: read.ok, keys: read.keys } : read;
  };

  /**
   * The read is `bd export --all`, NOT `bd list --json`, and that is the finding it answers (PR
   * #174 review): a listing prints issue projections, so an edited comment and a persistent memory
   * are invisible to it — durable state a flip would strand while every check stayed green.
   * `--all` is also what carries closed issues, gates, infra beads and templates.
   */
  it("reads the board with `bd export --all`, the one read that carries comments and memories", () => {
    const calls: string[][] = [];
    const exec = (cmd: string, args: string[]) => {
      calls.push([cmd, ...args]);
      return { status: 0, stdout: listing(["probe-1"]) };
    };
    expect(readBoardRecords(repo(EMBEDDED), { exec }).keys).toEqual(["probe-1"]);
    expect(calls[0].join(" ")).toBe("bd export --all");
  });

  // Memories are board state with no bead to hang off, so they are keyed under their own type —
  // a memory named like a bead must not pass for it.
  it("keys issues by their bd id and every other record by type", () => {
    const stdout = exported([
      { _type: "issue", id: "probe-1", title: "t" },
      { _type: "memory", key: "probe-1", value: "a fact" },
    ]);
    expect(keys(stdout)).toEqual({ ok: true, keys: ["probe-1", "memory:probe-1"] });
  });

  /**
   * The digests are what the drift and arrived-whole checks compare, and keys alone cannot answer
   * either: a writer that updates an existing issue leaves the key set identical (PR #174 review).
   * Labels, dependencies, the comment THREAD and a memory's value are all content, and the export
   * carries every one of them.
   */
  it("fingerprints each record's content — labels, comments and memory values included", () => {
    /** `probe-1`'s fingerprint as bd printed it — throwing rather than comparing two undefineds. */
    const fingerprint = (record: object, key = "probe-1"): string => {
      const read = readBoardRecords(repo(EMBEDDED), { exec: () => ({ status: 0, stdout: exported([record]) }) });
      const fp = read.digests?.get(key);
      if (!fp) throw new Error(`no digest for ${key}: ${read.detail ?? "board read as empty"}`);
      return fp;
    };
    const issue = (over: object = {}) => ({
      _type: "issue",
      id: "probe-1",
      title: "t",
      status: "open",
      labels: ["approved"],
      comments: [{ id: "c1", text: "a durable review note" }],
      ...over,
    });

    const open = fingerprint(issue());
    expect(fingerprint(issue({ status: "closed" }))).not.toBe(open);
    expect(fingerprint(issue({ title: "T" }))).not.toBe(open);
    expect(fingerprint(issue({ labels: ["approved", "risk:low"] }))).not.toBe(open);
    // The comment thread: an EDITED comment leaves bd's own comment_count identical, which is the
    // whole reason a listing cannot stand in for the export here.
    expect(fingerprint(issue({ comments: [{ id: "c1", text: "an edited note" }] }))).not.toBe(open);
    expect(fingerprint(issue({ comments: [] }))).not.toBe(open);
    // And a memory is content like any other.
    const remembered = fingerprint({ _type: "memory", key: "k", value: "a fact" }, "memory:k");
    expect(fingerprint({ _type: "memory", key: "k", value: "another fact" }, "memory:k")).not.toBe(remembered);

    // Unchanged content fingerprints the same, whatever order bd prints the fields and comments in
    // — a reordered export must not read as a mid-flip edit and refuse the switch.
    expect(fingerprint(issue())).toBe(open);
    expect(fingerprint({ comments: [{ text: "a durable review note", id: "c1" }], labels: ["approved"], status: "open", title: "t", id: "probe-1", _type: "issue" })).toBe(open);
  });

  // bd's own deprecation warnings land on stdout on some versions, and JSONL makes them a line that
  // simply does not parse — never brackets a scan has to tell apart from a record's own.
  it("steps over a warning bd printed on stdout, on either side of the records", () => {
    const payload = JSON.stringify({ _type: "issue", id: "probe-1" });
    expect(keys(`warning: use {dolt.auto-commit} instead\n${payload}\n`)).toEqual({ ok: true, keys: ["probe-1"] });
    expect(keys(`${payload}\nwarning: use {dolt.auto-commit} instead\n`)).toEqual({ ok: true, keys: ["probe-1"] });
  });

  // An issue's own text is free to carry brackets and quotes; one record per line means none of it
  // needs interpreting.
  it("reads a board whose issue text carries brackets of its own", () => {
    const stdout = exported([{ _type: "issue", id: "probe-1", title: "use {dolt.auto-commit} [now]" }]);
    expect(keys(stdout)).toEqual({ ok: true, keys: ["probe-1"] });
  });

  it("reports a failed or unreadable board rather than calling it empty", () => {
    expect(readBoardRecords(repo(EMBEDDED), { exec: () => ({ status: 1, stderr: "connection refused" }) })).toEqual({
      ok: false,
      detail: "connection refused",
    });
    expect(keys("no json here").ok).toBe(false);
    // A record with nothing to key it by cannot be compared, and dropping it quietly is how state
    // gets stranded — the whole read is reported as unusable instead.
    expect(keys(JSON.stringify({ _type: "issue", title: "no id" })).ok).toBe(false);
    expect(keys(JSON.stringify({ _type: "memory", value: "no key" })).ok).toBe(false);
  });

  /**
   * An empty board really does export nothing, and that is a usable answer — but only when stdout
   * held nothing else. Zero records alongside output this could not parse is a read that went
   * wrong, and calling it "empty" would make the arrived-whole check pass over ANY server board.
   */
  it("accepts a genuinely empty export, and refuses one that is only warnings", () => {
    expect(keys("")).toEqual({ ok: true, keys: [] });
    expect(keys("\n\n")).toEqual({ ok: true, keys: [] });
    expect(keys("warning: deprecated\n")).toEqual({ ok: false, detail: "bd export printed no readable board" });
  });
});

describe("backupBoard", () => {
  it("exports EVERYTHING into a self-ignoring .beads/backups/", () => {
    const dir = repo(EMBEDDED);
    const { calls, exec } = fakeBd();
    const backup = backupBoard(dir, { exec, now: () => new Date("2026-08-18T12:00:00Z") });

    expect(backup.status).toBe("written");
    expect(backup.path).toBe(join(dir, ".beads", "backups", "board-2026-08-18T12-00-00-000Z.jsonl"));
    // --all, or the "backup" silently omits infra beads, templates, gates and memories.
    expect(cmdline(calls)).toContainEqual(`bd export --all -o ${backup.path}`);
    expect(readFileSync(join(dir, ".beads", "backups", ".gitignore"), "utf8")).toBe("*\n");
  });

  it("reports a failed export instead of returning a path to nothing", () => {
    const { exec } = fakeBd({ export: { status: 1, stderr: "export failed" } });
    expect(backupBoard(repo(EMBEDDED), { exec })).toEqual({ status: "failed", detail: "export failed" });
  });

  /**
   * The second run onto a directory that already holds exports must not rewrite the rule that hides
   * them: a plain write truncates before it can fail, so one ENOSPC would leave an empty .gitignore
   * beside every earlier board export — all of it visible to git (PR #174 review). An ignore file
   * that already carries the rule is left exactly as it is, comments and all.
   */
  it("leaves an ignore file that already hides the backups exactly as it found it", () => {
    const dir = repo(EMBEDDED);
    const backups = join(dir, ".beads", "backups");
    mkdirSync(backups, { recursive: true });
    const existing = "# never commit a board export\n*\n";
    writeFileSync(join(backups, ".gitignore"), existing);
    writeFileSync(join(backups, "board-2026-08-17T00-00-00-000Z.jsonl"), "{}\n");

    const { exec } = fakeBd();
    expect(backupBoard(dir, { exec }).status).toBe("written");
    expect(readFileSync(join(backups, ".gitignore"), "utf8")).toBe(existing);
  });

  /**
   * Git resolves a path by the LAST pattern that matches it, so a `*` undone by a later `!*.jsonl`
   * hides nothing — `git status -uall` lists the export (PR #174 review). The catch-all is appended
   * so it has the last word, and the rules already there are kept.
   */
  it("appends the catch-all when a later re-inclusion un-hides the exports", () => {
    const dir = repo(EMBEDDED);
    const backups = join(dir, ".beads", "backups");
    mkdirSync(backups, { recursive: true });
    writeFileSync(join(backups, ".gitignore"), "*\n!*.jsonl\n");

    const { exec } = fakeBd();
    expect(backupBoard(dir, { exec }).status).toBe("written");
    expect(readFileSync(join(backups, ".gitignore"), "utf8")).toBe("*\n!*.jsonl\n*\n");
  });

  /**
   * And when the rule DOES have to be written and the write fails, the previous ignore file is still
   * there — {@link writeFileAtomic} renames a finished temp file over it rather than truncating it.
   * Skipped as root, for whom a read-only directory is not read-only.
   */
  it.skipIf(process.getuid?.() === 0)("keeps the previous ignore file when the rewrite fails", () => {
    const dir = repo(EMBEDDED);
    const backups = join(dir, ".beads", "backups");
    mkdirSync(backups, { recursive: true });
    // No `*` rule, so the write is attempted — into a directory nothing may write to.
    const stale = "# an older rule that does not hide anything\n";
    writeFileSync(join(backups, ".gitignore"), stale);
    chmodSync(backups, 0o555);
    try {
      const { exec } = fakeBd();
      const backup = backupBoard(dir, { exec });
      expect(backup.status).toBe("failed");
      expect(backup.detail).toContain(".gitignore");
      expect(readFileSync(join(backups, ".gitignore"), "utf8")).toBe(stale);
    } finally {
      chmodSync(backups, 0o755);
    }
  });

  /**
   * An ignore file that exists but cannot be READ is not an absent one: replacing it with a bare
   * `*` would throw away whatever rules and comments it carries, in a directory whose parent still
   * permits the rename (PR #174 review). Only ENOENT means "write the rule".
   */
  it.skipIf(process.getuid?.() === 0)("refuses the backup when the ignore file cannot be read", () => {
    const dir = repo(EMBEDDED);
    const backups = join(dir, ".beads", "backups");
    mkdirSync(backups, { recursive: true });
    const ignore = join(backups, ".gitignore");
    const existing = "# rules this process may not read\n!*.jsonl\n";
    writeFileSync(ignore, existing);
    chmodSync(ignore, 0o000);
    try {
      const { calls, exec } = fakeBd();
      const backup = backupBoard(dir, { exec });
      expect(backup.status).toBe("failed");
      expect(backup.detail).toContain(".gitignore");
      // And nothing was exported into a directory git might not be hiding.
      expect(cmdline(calls).some((c) => c.startsWith("bd export"))).toBe(false);
      chmodSync(ignore, 0o644);
      expect(readFileSync(ignore, "utf8")).toBe(existing);
    } finally {
      chmodSync(ignore, 0o644);
    }
  });
});

describe("testDoltConnection", () => {
  it("names the PER-USER password variable in its hints", () => {
    const { exec } = fakeBd({ test: { status: 1, stderr: "Connection failed" } });
    const result = testDoltConnection(repo(EMBEDDED), CONNECTION, { exec });
    expect(result.ok).toBe(false);
    expect(result.stage).toBe("connect");
    const hints = (result.hints ?? []).join("\n");
    expect(hints).toContain("BEADS_DOLT_PASSWORD_BEADS");
    expect(hints).toContain("dolt.example.dev:3306");
  });

  /**
   * A board that refused the READ has already proven host, port, account and transport work, so
   * repeating the credential and TLS hints sends the operator to check what the probe just cleared.
   * What is left is the database: named wrongly, never copied across, or another project's.
   */
  it("drops the credential hints when the connection worked and the BOARD refused", () => {
    const { exec } = fakeBd({});
    const readRefused = (cmd: string, args: string[]) =>
      args[0] === "count" ? { status: 1, stderr: "PROJECT IDENTITY MISMATCH" } : exec(cmd, args);

    const result = testDoltConnection(repo(EMBEDDED), CONNECTION, { exec: readRefused });

    expect(result.ok).toBe(false);
    expect(result.stage).toBe("read");
    const hints = (result.hints ?? []).join("\n");
    expect(hints).toContain('confirm "probe" is the database');
    expect(hints).toContain("embedded-board-to-shared-dolt-server.md");
    expect(hints).not.toContain("BEADS_DOLT_PASSWORD_BEADS");
  });
});

describe("configureServerMode", () => {
  const flags = { host: "dolt.example.dev", port: 3306, user: "beads", database: "probe" };

  it("backs up, writes the connection, verifies it, and publishes the team defaults", () => {
    const dir = repo(EMBEDDED);
    const { calls, exec } = fakeBd({ dir, before: BOARD });

    const result = configureServerMode(dir, flags, { exec });

    expect(result.ok).toBe(true);
    expect(result.counts).toEqual({ before: 7, after: 7 });
    expect(result.missing).toEqual([]);
    expect(readMetadata(dir).dolt_mode).toBe("server");
    const ran = cmdline(calls);
    expect(ran.some((c) => c.includes("bd export --all -o"))).toBe(true);
    expect(ran).toContainEqual("bd dolt test");
    // The connection reaches config.yaml as the team-wide default so the next clone inherits it.
    expect(ran).toContainEqual("bd dolt set host dolt.example.dev --update-config");
    expect(ran).toContainEqual("bd dolt set database probe --update-config");
    expect(ran).toContainEqual("bd config set dolt.auto-commit on");
    // bd's auto-backup would register its remote on the shared server as this project's account,
    // which is not privileged for it — every write would warn (anton-0tul).
    expect(ran).toContainEqual("bd config set backup.enabled false");
  });

  it("reverts metadata.json byte-for-byte when the server refuses the connection", () => {
    const dir = repo(EMBEDDED);
    const original = readFileSync(metadataPath(dir), "utf8");
    const { calls, exec } = fakeBd({ dir, before: BOARD, test: { status: 1, stderr: "Connection failed" } });

    const result = configureServerMode(dir, flags, { exec });

    expect(result.ok).toBe(false);
    expect(readFileSync(metadataPath(dir), "utf8")).toBe(original);
    expect(result.steps.some((s: { status: string }) => s.status === "reverted")).toBe(true);
    // What the caller prints its headline from: the switch is out of the file, so the project is
    // back on the embedded board it started on.
    expect(result.after).toMatchObject({ mode: "embedded" });
    expect(result.switchStillWritten).toBe(false);
    // Nothing was published: a board that cannot connect must not leave a team default behind.
    expect(cmdline(calls).some((c) => c.includes("--update-config"))).toBe(false);
  });

  /**
   * A switch to bd's DEFAULT account (no `dolt_server_user`) over a config.yaml that still carries
   * an older `dolt.user` is a switch bd makes as that older account: metadata.json outranks
   * config.yaml but does not erase it. Retracted with the rest of the publication it would come too
   * late — the probe tests the stale identity, fails to authenticate, and rolls back a switch that
   * was correct, leaving the move impossible without hand-editing config.yaml first (PR #174
   * review). It is retracted first.
   */
  describe("a stale config.yaml user the switch stops declaring", () => {
    const stale = "prefix: probe\ndolt.user: old-account\n";
    const toDefaultUser = { ...flags, user: undefined };

    it("is cleared BEFORE the connection is probed", () => {
      const dir = repo(EMBEDDED);
      const beadsDir = join(dir, ".beads");
      writeFileSync(join(beadsDir, "config.yaml"), stale);
      const base = fakeBd({ dir, before: BOARD });
      // Read at the probe itself: the ordering claim is about what bd sees, not about call order.
      let userAtProbe: string | undefined = "unprobed";
      const exec = (cmd: string, args: string[]): Result => {
        if (args[0] === "dolt" && args[1] === "test") userAtProbe = configYamlValue(beadsDir, "dolt.user");
        return base.exec(cmd, args);
      };

      const result = configureServerMode(dir, toDefaultUser, { exec });

      expect(result.ok).toBe(true);
      expect(userAtProbe).toBeUndefined();
      const cleared = result.steps.filter((s: { name: string; status: string }) => s.name === "dolt.user");
      expect(cleared[0]).toMatchObject({ status: "cleared" });
      const ran = cmdline(base.calls);
      expect(ran).toContainEqual("bd config unset dolt.user");
      expect(ran.indexOf("bd config unset dolt.user")).toBeLessThan(ran.indexOf("bd dolt test"));
    });

    // Clearing it is a write like any other this run makes, so a failure downstream puts it back —
    // a rolled-back switch leaves config.yaml exactly as it found it.
    it("is put back when the switch is rolled back", () => {
      const dir = repo(EMBEDDED);
      const configPath = join(dir, ".beads", "config.yaml");
      writeFileSync(configPath, stale);
      const { exec } = fakeBd({ dir, before: BOARD, test: { status: 1, stderr: "Connection failed" } });

      const result = configureServerMode(dir, toDefaultUser, { exec });

      expect(result.ok).toBe(false);
      expect(readFileSync(configPath, "utf8")).toBe(stale);
    });
  });

  /**
   * The flip is the one write that happens before `revert` exists. A plain write that fails part-way
   * — a full disk, a read-only `.beads/` — would truncate metadata.json AND take the command out
   * through a stack trace, leaving a workspace whose connection details no longer parse (PR #174
   * review). Skipped as root, which ignores the permission bits this fails the write with.
   */
  it.skipIf(process.getuid?.() === 0)("refuses cleanly when the flip's own write fails, leaving metadata.json intact", () => {
    const dir = repo(EMBEDDED);
    const original = readFileSync(metadataPath(dir), "utf8");
    const beadsDir = join(dir, ".beads");
    const { calls, exec } = fakeBd({ dir, before: BOARD });

    chmodSync(beadsDir, 0o555);
    let result;
    try {
      result = configureServerMode(dir, { ...flags, backup: false }, { exec });
    } finally {
      chmodSync(beadsDir, 0o755);
    }

    expect(result.ok).toBe(false);
    expect(result.errors.some((e: string) => e.includes("could not write"))).toBe(true);
    expect(readFileSync(metadataPath(dir), "utf8")).toBe(original);
    // The board never moved, so nothing downstream of the flip ran — and there is nothing to revert.
    expect(cmdline(calls)).not.toContainEqual("bd dolt test");
    expect(result.steps.some((s: { status: string }) => s.status === "reverted")).toBe(false);
  });

  /**
   * The rollback itself runs on the failure path, where a full disk or a read-only `.beads/` is
   * often the very thing being rolled back. A throw from the restore would escape the flow and take
   * the CLI out on a stack trace — no structured report, and metadata.json left pointing at the
   * server that was just rejected with nothing saying so (PR #174 review). Skipped as root, which
   * ignores the permission bits this fails the restore with.
   */
  it.skipIf(process.getuid?.() === 0)("reports the mode it is left in when the rollback's own write fails", () => {
    const dir = repo(EMBEDDED);
    const beadsDir = join(dir, ".beads");
    const base = fakeBd({ dir, before: BOARD });
    // `.beads/` goes read-only at the connection test: the flip has landed, and the restore that
    // answers the refused connection is the write that fails.
    const exec = (cmd: string, args: string[]): Result => {
      if (args[0] === "dolt" && args[1] === "test") {
        chmodSync(beadsDir, 0o555);
        return { status: 1, stderr: "Connection failed" };
      }
      return base.exec(cmd, args);
    };

    let result;
    try {
      result = configureServerMode(dir, { ...flags, backup: false }, { exec });
    } finally {
      chmodSync(beadsDir, 0o755);
    }

    expect(result.ok).toBe(false);
    // The switch is still in the file — so the report has to name it, not claim a clean revert.
    expect(readMetadata(dir).dolt_mode).toBe("server");
    expect(result.steps.some((s: { status: string }) => s.status === "reverted")).toBe(false);
    expect(result.errors.some((e: string) => e.includes("could not be put back"))).toBe(true);
    expect(result.errors.some((e: string) => e.includes("dolt.example.dev:3306"))).toBe(true);
    // And says it in the two fields the terminal writes its headline from, rather than leaving the
    // caller to announce a project that was "not switched" while it reads the server.
    expect(result.after).toMatchObject({ mode: "server", host: "dolt.example.dev", database: "probe" });
    expect(result.switchStillWritten).toBe(true);
  });

  /**
   * Publication writes config.yaml one key at a time, so a failure part-way through leaves the file
   * carrying half a server connection — and the command reports the board as untouched. Both files
   * roll back together, or the report is a lie the next clone inherits.
   */
  it("restores config.yaml too when publishing the team defaults fails half-way", () => {
    const dir = repo(EMBEDDED);
    const configPath = join(dir, ".beads", "config.yaml");
    const original = readFileSync(configPath, "utf8");
    const metadataOriginal = readFileSync(metadataPath(dir), "utf8");
    // A bd that patches config.yaml for real (as the live one does) and then refuses one key.
    const exec = (_cmd: string, args: string[]): Result => {
      if (args[0] === "--version") return { status: 0, stdout: "bd version 1.1.2" };
      if (isRead(args)) return { status: 0, stdout: listing(BOARD) };
      if (args[0] === "config" && args[1] === "set") {
        writeFileSync(configPath, `${readFileSync(configPath, "utf8")}${args[2]}: ${args[3]}\n`);
        return { status: 0 };
      }
      if (args[0] === "dolt" && args[1] === "set") {
        if (args[2] === "database") return { status: 1, stderr: "Access denied for user 'beads'" };
        writeFileSync(configPath, `${readFileSync(configPath, "utf8")}dolt.${args[2]}: ${args[3]}\n`);
        return { status: 0 };
      }
      return { status: 0 };
    };

    const result = configureServerMode(dir, flags, { exec });

    expect(result.ok).toBe(false);
    expect(readFileSync(configPath, "utf8")).toBe(original);
    expect(readFileSync(metadataPath(dir), "utf8")).toBe(metadataOriginal);
  });

  /**
   * `bd dolt set --update-config` writes metadata.json as well as config.yaml, so by the time a
   * later publication step fails, the file no longer holds the exact bytes the flip wrote — with
   * nobody else touching it. A byte-only comparison reads bd's own rewrite as a concurrent editor
   * and declines the rollback, leaving `dolt_mode: server` behind under a report saying the project
   * was not switched (PR #174 review). The rewrite is recognized as this run's, and rolled back.
   */
  it("rolls metadata.json back when bd's own --update-config rewrote it before publishing failed", () => {
    const dir = repo(EMBEDDED);
    const configPath = join(dir, ".beads", "config.yaml");
    const original = readFileSync(metadataPath(dir), "utf8");
    // bd as it really behaves: --update-config patches config.yaml AND re-serializes metadata.json
    // in bd's own encoding — reordered keys, no trailing newline, the port as a string.
    const exec = (_cmd: string, args: string[]): Result => {
      if (args[0] === "--version") return { status: 0, stdout: "bd version 1.1.2" };
      if (isRead(args)) return { status: 0, stdout: listing(BOARD) };
      if (args[0] === "dolt" && args[1] === "set") {
        if (args[2] === "database") return { status: 1, stderr: "Access denied for user 'beads'" };
        const meta = readMetadata(dir);
        const rewritten = { dolt_mode: meta.dolt_mode, ...meta, dolt_server_port: String(meta.dolt_server_port) };
        writeFileSync(metadataPath(dir), JSON.stringify(rewritten));
        writeFileSync(configPath, `${readFileSync(configPath, "utf8")}dolt.${args[2]}: ${args[3]}\n`);
        return { status: 0 };
      }
      return { status: 0 };
    };

    const result = configureServerMode(dir, flags, { exec });

    expect(result.ok).toBe(false);
    expect(readFileSync(metadataPath(dir), "utf8")).toBe(original);
    expect(result.steps.some((s: { status: string }) => s.status === "reverted")).toBe(true);
    expect(result.steps.some((s: { status: string }) => s.status === "kept")).toBe(false);
  });

  /**
   * Forgiving bd's rewrite must not forgive everyone else's. An edit that lands DURING publication
   * and changes something bd does not write is still a file this run no longer owns.
   */
  it("still keeps metadata.json when a real edit lands during publication", () => {
    const dir = repo(EMBEDDED);
    const exec = (_cmd: string, args: string[]): Result => {
      if (args[0] === "--version") return { status: 0, stdout: "bd version 1.1.2" };
      if (isRead(args)) return { status: 0, stdout: listing(BOARD) };
      if (args[0] === "dolt" && args[1] === "set") {
        if (args[2] === "database") return { status: 1, stderr: "Access denied for user 'beads'" };
        const meta = readMetadata(dir);
        writeFileSync(metadataPath(dir), `${JSON.stringify({ ...meta, project_id: "corrected-9999" }, null, 2)}\n`);
        return { status: 0 };
      }
      return { status: 0 };
    };

    const result = configureServerMode(dir, flags, { exec });

    expect(result.ok).toBe(false);
    expect(readMetadata(dir).project_id).toBe("corrected-9999");
    expect(result.steps.some((s: { status: string }) => s.status === "kept")).toBe(true);
    expect(result.warnings.some((w: string) => w.includes("edited after this command wrote the switch"))).toBe(true);
    // A declined rollback leaves the switch standing just as a failed one does — same report.
    expect(result.after).toMatchObject({ mode: "server", host: "dolt.example.dev" });
    expect(result.switchStillWritten).toBe(true);
  });

  /**
   * The forgiveness covers bd re-encoding the keys this run WROTE — not a key appearing out of
   * nowhere. An optional field the flip left out (`dolt_server_tls` here) can only have been added
   * by somebody else, and restoring the pre-flip text over it would discard that edit silently
   * (PR #174 review).
   */
  it("keeps metadata.json when an optional connection key it never wrote appears during publication", () => {
    const dir = repo(EMBEDDED);
    const exec = (_cmd: string, args: string[]): Result => {
      if (args[0] === "--version") return { status: 0, stdout: "bd version 1.1.2" };
      if (isRead(args)) return { status: 0, stdout: listing(BOARD) };
      if (args[0] === "dolt" && args[1] === "set") {
        if (args[2] === "database") return { status: 1, stderr: "Access denied for user 'beads'" };
        const meta = readMetadata(dir);
        writeFileSync(metadataPath(dir), `${JSON.stringify({ ...meta, dolt_server_tls: true }, null, 2)}\n`);
        return { status: 0 };
      }
      return { status: 0 };
    };

    const result = configureServerMode(dir, flags, { exec });

    expect(result.ok).toBe(false);
    expect(readMetadata(dir).dolt_server_tls).toBe(true);
    expect(result.steps.some((s: { status: string }) => s.status === "kept")).toBe(true);
    expect(result.steps.some((s: { status: string }) => s.status === "reverted")).toBe(false);
    expect(result.warnings.some((w: string) => w.includes("edited after this command wrote the switch"))).toBe(true);
  });

  /**
   * A rollback must not become the thing that loses work (PR #174 review). Everything after the flip
   * — the connection test, the server's export, the publication — takes long enough for another
   * clone's switch or a person fixing the connection to edit metadata.json, and restoring the
   * pre-flip text over that edit would discard it with no way back. The run keeps the file and says
   * the project is still pointed at the server instead.
   */
  it("does NOT roll metadata.json back over an edit that landed after the flip", () => {
    const dir = repo(EMBEDDED);
    const exec = (_cmd: string, args: string[]): Result => {
      if (args[0] === "--version") return { status: 0, stdout: "bd version 1.1.2" };
      if (isRead(args)) return { status: 0, stdout: listing(BOARD) };
      if (args[0] === "dolt" && args[1] === "test") {
        const meta = JSON.parse(readFileSync(metadataPath(dir), "utf8"));
        writeFileSync(metadataPath(dir), `${JSON.stringify({ ...meta, project_id: "corrected-9999" }, null, 2)}\n`);
        return { status: 1, stderr: "Connection failed" };
      }
      return { status: 0 };
    };

    const result = configureServerMode(dir, flags, { exec });

    expect(result.ok).toBe(false);
    // The concurrent edit is still there, mode and all — nothing overwrote it.
    expect(readMetadata(dir).project_id).toBe("corrected-9999");
    expect(result.steps.some((s: { status: string }) => s.status === "reverted")).toBe(false);
    expect(result.steps.some((s: { status: string }) => s.status === "kept")).toBe(true);
    expect(result.warnings.some((w: string) => w.includes("edited after this command wrote the switch"))).toBe(true);
  });

  /** Nothing has written config.yaml before step 9, so a revert before it has nothing to put back. */
  it("leaves config.yaml alone when it reverts before publishing", () => {
    const dir = repo(EMBEDDED);
    const configPath = join(dir, ".beads", "config.yaml");
    const edited = "prefix: probe\nsome.other.key: set-by-someone-else\n";
    const exec = (_cmd: string, args: string[]): Result => {
      if (args[0] === "--version") return { status: 0, stdout: "bd version 1.1.2" };
      if (isRead(args)) return { status: 0, stdout: listing(BOARD) };
      if (args[0] === "dolt" && args[1] === "test") {
        writeFileSync(configPath, edited);
        return { status: 1, stderr: "Connection failed" };
      }
      return { status: 0 };
    };

    const result = configureServerMode(dir, flags, { exec });

    expect(result.ok).toBe(false);
    expect(readFileSync(configPath, "utf8")).toBe(edited);
  });

  /**
   * The config.yaml rollback snapshot is taken immediately before publication, not before the flip:
   * an edit that landed in the window between them is part of the file the publication is undone
   * back to, rather than something the undo throws away (PR #174 review).
   */
  it("rolls config.yaml back to what it held when publishing STARTED, keeping a concurrent edit", () => {
    const dir = repo(EMBEDDED);
    const configPath = join(dir, ".beads", "config.yaml");
    const edited = "prefix: probe\nsome.other.key: set-by-someone-else\n";
    const exec = (_cmd: string, args: string[]): Result => {
      if (args[0] === "--version") return { status: 0, stdout: "bd version 1.1.2" };
      if (isRead(args)) return { status: 0, stdout: listing(BOARD) };
      if (args[0] === "dolt" && args[1] === "test") {
        // Lands after the flip, before a single team default is published.
        writeFileSync(configPath, edited);
        return { status: 0, stdout: "✓ Connection successful" };
      }
      if (args[0] === "config" && args[1] === "set") {
        writeFileSync(configPath, `${readFileSync(configPath, "utf8")}${args[2]}: ${args[3]}\n`);
        return { status: 0 };
      }
      if (args[0] === "dolt" && args[1] === "set") {
        if (args[2] === "database") return { status: 1, stderr: "Access denied for user 'beads'" };
        writeFileSync(configPath, `${readFileSync(configPath, "utf8")}dolt.${args[2]}: ${args[3]}\n`);
        return { status: 0 };
      }
      return { status: 0 };
    };

    const result = configureServerMode(dir, flags, { exec });

    expect(result.ok).toBe(false);
    expect(readFileSync(configPath, "utf8")).toBe(edited);
  });

  /**
   * Taking the snapshot late narrows that window; it does not close it. An edit landing WHILE bd is
   * patching config.yaml is not in the snapshot, and restoring the snapshot over it would discard it
   * silently (PR #174 review). Bytes cannot tell bd's own patches from somebody else's edit — keys
   * can, because this run only ever asks bd for the team-config and `dolt.*` connection keys.
   */
  it("keeps config.yaml when an edit under a key this run never writes lands during publication", () => {
    const dir = repo(EMBEDDED);
    const configPath = join(dir, ".beads", "config.yaml");
    const append = (line: string) => writeFileSync(configPath, `${readFileSync(configPath, "utf8")}${line}\n`);
    const exec = (_cmd: string, args: string[]): Result => {
      if (args[0] === "--version") return { status: 0, stdout: "bd version 1.1.2" };
      if (isRead(args)) return { status: 0, stdout: listing(BOARD) };
      if (args[0] === "config" && args[1] === "set") {
        append(`${args[2]}: ${args[3]}`);
        // A teammate's edit lands between two of bd's own patches — after the snapshot was taken.
        append("some.other.key: set-by-someone-else");
        return { status: 0 };
      }
      if (args[0] === "dolt" && args[1] === "set") {
        if (args[2] === "database") return { status: 1, stderr: "Access denied for user 'beads'" };
        append(`dolt.${args[2]}: ${args[3]}`);
        return { status: 0 };
      }
      return { status: 0 };
    };

    const result = configureServerMode(dir, flags, { exec });

    expect(result.ok).toBe(false);
    // Left exactly as it stands — half a published connection and all — rather than rolled back
    // over an edit nothing here could put back.
    expect(readFileSync(configPath, "utf8")).toContain("some.other.key: set-by-someone-else");
    expect(configYamlValue(join(dir, ".beads"), "backup.enabled")).toBe("false");
    expect(result.steps.some((s: { name: string; status: string }) => s.name === "config.yaml" && s.status === "kept")).toBe(true);
    expect(result.warnings.join("\n")).toMatch(/carries a change this command did not make \(some\.other\.key\)/);
    // Named as the thing to reconcile, with the command that shows it.
    expect(result.warnings.join("\n")).toMatch(/git diff -- \.beads\/config\.yaml/);
  });

  /**
   * The same window, under a key whose value is a SEQUENCE. The rollback compares the two texts
   * through bd's flat scalar parser, which holds no list at all — so an item appended under a
   * list-valued key would leave that diff empty and the whole-file restore would discard the edit
   * while reporting a clean revert (PR #174 review). Every line the flat map drops is compared too.
   */
  it("keeps config.yaml when a concurrent edit lands in a list the flat parser cannot represent", () => {
    const dir = repo(EMBEDDED);
    const configPath = join(dir, ".beads", "config.yaml");
    // A list-valued key already in the file when this run takes its snapshot.
    writeFileSync(configPath, `${readFileSync(configPath, "utf8")}repos:\n  additional:\n    - one\n`);
    const append = (line: string) => writeFileSync(configPath, `${readFileSync(configPath, "utf8")}${line}\n`);
    const exec = (_cmd: string, args: string[]): Result => {
      if (args[0] === "--version") return { status: 0, stdout: "bd version 1.1.2" };
      if (isRead(args)) return { status: 0, stdout: listing(BOARD) };
      if (args[0] === "config" && args[1] === "set") {
        append(`${args[2]}: ${args[3]}`);
        // A teammate adds a second repo to the list, after the snapshot was taken. Not a scalar:
        // the item lands under the existing header rather than as a `key: value` line of its own.
        const text = readFileSync(configPath, "utf8").replace("    - one\n", "    - one\n    - two\n");
        writeFileSync(configPath, text);
        return { status: 0 };
      }
      if (args[0] === "dolt" && args[1] === "set") {
        if (args[2] === "database") return { status: 1, stderr: "Access denied for user 'beads'" };
        append(`dolt.${args[2]}: ${args[3]}`);
        return { status: 0 };
      }
      return { status: 0 };
    };

    const result = configureServerMode(dir, flags, { exec });

    expect(result.ok).toBe(false);
    expect(readFileSync(configPath, "utf8")).toContain("    - two");
    expect(result.steps.some((s: { name: string; status: string }) => s.name === "config.yaml" && s.status === "kept")).toBe(true);
    expect(result.warnings.join("\n")).toMatch(/carries a change this command did not make \(repos\.additional\)/);
  });

  /**
   * The same window, as a COMMENT. A comment is an edit somebody made — a documented reason for a
   * setting, a block being commented in or out — and both of the parsers the rollback diffs through
   * drop it, so a comment-only edit would leave the diff empty and the whole-file restore would
   * discard it while reporting a clean revert (PR #174 review).
   */
  it("keeps config.yaml when the only concurrent edit is a comment", () => {
    const dir = repo(EMBEDDED);
    const configPath = join(dir, ".beads", "config.yaml");
    const append = (line: string) => writeFileSync(configPath, `${readFileSync(configPath, "utf8")}${line}\n`);
    const exec = (_cmd: string, args: string[]): Result => {
      if (args[0] === "--version") return { status: 0, stdout: "bd version 1.1.2" };
      if (isRead(args)) return { status: 0, stdout: listing(BOARD) };
      if (args[0] === "config" && args[1] === "set") {
        append(`${args[2]}: ${args[3]}`);
        // A teammate documents why a setting is what it is, after the snapshot was taken.
        append("# shared board: auto-push is the server's job, not ours");
        return { status: 0 };
      }
      if (args[0] === "dolt" && args[1] === "set") {
        if (args[2] === "database") return { status: 1, stderr: "Access denied for user 'beads'" };
        append(`dolt.${args[2]}: ${args[3]}`);
        return { status: 0 };
      }
      return { status: 0 };
    };

    const result = configureServerMode(dir, flags, { exec });

    expect(result.ok).toBe(false);
    expect(readFileSync(configPath, "utf8")).toContain("# shared board: auto-push is the server's job");
    expect(result.steps.some((s: { name: string; status: string }) => s.name === "config.yaml" && s.status === "kept")).toBe(true);
    expect(result.warnings.join("\n")).toContain("carries a change this command did not make ((top level))");
  });

  /**
   * And the comment this run makes ITSELF is not somebody else's: a retraction strikes a key out
   * rather than deleting it, so a rollback that read every new comment as foreign would decline to
   * put back the very file it had just edited (PR #174 review).
   */
  it("still reverts config.yaml when the only new comment is this run's own strike-out", () => {
    const dir = repo(EMBEDDED);
    const configPath = join(dir, ".beads", "config.yaml");
    // A nested `dolt.user` — the encoding `bd config unset` reports success on without touching, so
    // the strike-out below is anton's own.
    const original = "prefix: probe\ndolt:\n  user: old-account\n";
    writeFileSync(configPath, original);
    const { exec } = fakeBd({ dir, before: BOARD, test: { status: 1, stderr: "Connection failed" } });

    const result = configureServerMode(dir, { ...flags, user: undefined }, { exec });

    expect(result.ok).toBe(false);
    expect(readFileSync(configPath, "utf8")).toBe(original);
    expect(result.steps.some((s: { name: string; status: string }) => s.name === "config.yaml" && s.status === "reverted")).toBe(true);
  });

  /**
   * But only the strike-out this run actually made. Another process commenting the same key out over
   * a DIFFERENT value is its edit, and forgiving every strike-out by key would leave the scalar diff
   * seeing exactly the absence this run asked for — so the restore would put the old account back
   * over their line and report a clean revert (PR #174 review).
   */
  it("keeps config.yaml when another process strikes a retracted key out over a value this run never saw", () => {
    const dir = repo(EMBEDDED);
    const configPath = join(dir, ".beads", "config.yaml");
    writeFileSync(configPath, "prefix: probe\ndolt:\n  user: old-account\n");
    const { exec: base } = fakeBd({ dir, before: BOARD, test: { status: 1, stderr: "Connection failed" } });
    const exec = (cmd: string, args: string[]): Result => {
      if (args[0] === "config" && args[1] === "unset" && args[2] === "dolt.user") {
        // Somebody else repoints the account and comments it out, in the window this run is
        // retracting the key it found there.
        writeFileSync(configPath, readFileSync(configPath, "utf8").replace("  user: old-account", "  # user: new-account"));
        return { status: 0 };
      }
      return base(cmd, args);
    };

    const result = configureServerMode(dir, { ...flags, user: undefined }, { exec });

    expect(result.ok).toBe(false);
    expect(readFileSync(configPath, "utf8")).toContain("# user: new-account");
    expect(result.steps.some((s: { name: string; status: string }) => s.name === "config.yaml" && s.status === "kept")).toBe(true);
    expect(result.warnings.join("\n")).toMatch(/carries a change this command did not make \(dolt\)/);
  });

  /**
   * The same window, under a key this run DOES write. Owning the key is not owning the value
   * (PR #174 review): a `dolt.user` another process repoints at a different account while a later
   * publication step fails is that process's edit, and a rollback that claimed every difference on
   * an owned key would restore the snapshot straight over it. What this run handed bd is the
   * evidence — the file holds something else, so it is left standing.
   */
  it("keeps config.yaml when another process changes a key this run writes to a value it never wrote", () => {
    const dir = repo(EMBEDDED);
    const configPath = join(dir, ".beads", "config.yaml");
    const append = (line: string) => writeFileSync(configPath, `${readFileSync(configPath, "utf8")}${line}\n`);
    const exec = (_cmd: string, args: string[]): Result => {
      if (args[0] === "--version") return { status: 0, stdout: "bd version 1.1.2" };
      if (isRead(args)) return { status: 0, stdout: listing(BOARD) };
      if (args[0] === "config" && args[1] === "set") {
        append(`${args[2]}: ${args[3]}`);
        // Somebody else repoints the account this switch is publishing, after the snapshot.
        append("dolt.user: someone-else");
        return { status: 0 };
      }
      if (args[0] === "dolt" && args[1] === "set") {
        // The key that carries the concurrent edit is the one whose publication then fails, so this
        // run never writes a `dolt.user` of its own over it.
        if (args[2] === "user") return { status: 1, stderr: "Access denied for user 'beads'" };
        append(`dolt.${args[2]}: ${args[3]}`);
        return { status: 0 };
      }
      return { status: 0 };
    };

    const result = configureServerMode(dir, flags, { exec });

    expect(result.ok).toBe(false);
    expect(configYamlValue(join(dir, ".beads"), "dolt.user")).toBe("someone-else");
    expect(result.steps.some((s: { name: string; status: string }) => s.name === "config.yaml" && s.status === "kept")).toBe(true);
    expect(result.warnings.join("\n")).toMatch(/carries a change this command did not make \(dolt\.user\)/);
  });

  /**
   * The same window again, under a key this run wants and never writes. A concurrent editor setting
   * `dolt.user` to the very account this switch was about to publish leaves the publication with
   * nothing to do — the value already matches, so no `bd dolt set` runs and the step reports
   * "already". Those bytes are therefore theirs, and a rollback claiming every key on the
   * publication list would restore the snapshot straight over them while reporting a clean revert
   * (PR #174 review). Ownership is claimed from the commands that RAN.
   */
  it("keeps config.yaml when a concurrent edit sets a key to the value this run would have published", () => {
    const dir = repo(EMBEDDED);
    const configPath = join(dir, ".beads", "config.yaml");
    const append = (line: string) => writeFileSync(configPath, `${readFileSync(configPath, "utf8")}${line}\n`);
    let landed = false;
    const exec = (_cmd: string, args: string[]): Result => {
      if (args[0] === "--version") return { status: 0, stdout: "bd version 1.1.2" };
      if (isRead(args)) return { status: 0, stdout: listing(BOARD) };
      if (args[0] === "config" && args[1] === "set") {
        append(`${args[2]}: ${args[3]}`);
        if (!landed) {
          // Somebody else publishes the account this switch is about to, after the snapshot.
          append(`dolt.user: ${flags.user}`);
          landed = true;
        }
        return { status: 0 };
      }
      if (args[0] === "dolt" && args[1] === "set") {
        // `user` is published last, so the failure that triggers the rollback lands before it.
        if (args[2] === "database") return { status: 1, stderr: "Access denied for user 'beads'" };
        append(`dolt.${args[2]}: ${args[3]}`);
        return { status: 0 };
      }
      return { status: 0 };
    };

    const result = configureServerMode(dir, flags, { exec });

    expect(result.ok).toBe(false);
    // Never written by this run, so never rolled back over.
    expect(configYamlValue(join(dir, ".beads"), "dolt.user")).toBe(flags.user);
    expect(result.steps.some((s: { name: string; status: string }) => s.name === `dolt.user=${flags.user}` && s.status === "already")).toBe(
      true,
    );
    expect(result.steps.some((s: { name: string; status: string }) => s.name === "config.yaml" && s.status === "kept")).toBe(true);
    expect(result.warnings.join("\n")).toMatch(/carries a change this command did not make \(dolt\.user\)/);
  });

  /**
   * The failure this command exists to catch. `bd dolt test` connects to the SERVER; it says nothing
   * about whether this project can open its database there — bd's own project-identity guard refuses
   * a database belonging to another project long after the connection test has passed.
   */
  it("fails and reverts when the server connects but the board cannot be read back", () => {
    const dir = repo(EMBEDDED);
    const original = readFileSync(metadataPath(dir), "utf8");
    const exec = (_cmd: string, args: string[]): Result => {
      if (args[0] === "--version") return { status: 0, stdout: "bd version 1.1.2" };
      if (isRead(args)) {
        // The pre-switch read succeeds; the post-switch one hits the identity guard.
        return readMetadataFile(dir).raw.dolt_mode === "server"
          ? { status: 1, stderr: "PROJECT IDENTITY MISMATCH — refusing to connect" }
          : { status: 0, stdout: listing(BOARD) };
      }
      return { status: 0 };
    };

    const result = configureServerMode(dir, flags, { exec });

    expect(result.ok).toBe(false);
    expect(result.errors.join("\n")).toContain("PROJECT IDENTITY MISMATCH");
    expect(readFileSync(metadataPath(dir), "utf8")).toBe(original);
  });

  /**
   * A source board that cannot be read leaves NOTHING to check the server's copy against, so the
   * arrived-whole guard silently passes on an empty set (PR #174 review). Refusing keeps `ok: true`
   * meaning "this board arrived"; --force is the deliberate way to switch anyway.
   */
  it("refuses to switch when the board being moved cannot be read — unless forced", () => {
    const dir = repo(EMBEDDED);
    const original = readFileSync(metadataPath(dir), "utf8");
    // The local board is unreadable; the server answers with a board that is not this one.
    const exec = (_cmd: string, args: string[]): Result => {
      if (args[0] === "--version") return { status: 0, stdout: "bd version 1.1.2" };
      if (isRead(args)) {
        return readMetadataFile(dir).raw.dolt_mode === "server"
          ? { status: 0, stdout: listing(["other-1"]) }
          : { status: 1, stderr: "database is locked" };
      }
      return { status: 0 };
    };

    const refused = configureServerMode(dir, flags, { exec });
    expect(refused.ok).toBe(false);
    expect(refused.errors.join("\n")).toMatch(/could not read the board being moved: .*database is locked/);
    expect(refused.errors.join("\n")).toContain("--force");
    // It refuses BEFORE touching anything — no backup, no metadata write to revert.
    expect(readFileSync(metadataPath(dir), "utf8")).toBe(original);

    const forced = configureServerMode(dir, { ...flags, force: true }, { exec });
    expect(forced.ok).toBe(true);
    expect(readMetadata(dir).dolt_mode).toBe("server");
    expect(forced.counts).toEqual({ after: 1 });
  });

  it("refuses a server board missing issues the board being moved has — unless forced", () => {
    const dir = repo(EMBEDDED);
    const original = readFileSync(metadataPath(dir), "utf8");

    const refused = configureServerMode(dir, flags, { exec: fakeBd({ dir, before: BOARD, after: [] }).exec });
    expect(refused.ok).toBe(false);
    expect(refused.errors.join("\n")).toMatch(/missing 7 of this board's 7 records/);
    expect(refused.missing).toEqual(BOARD);
    expect(readFileSync(metadataPath(dir), "utf8")).toBe(original);

    const forced = configureServerMode(dir, { ...flags, force: true }, { exec: fakeBd({ dir, before: BOARD, after: [] }).exec });
    expect(forced.ok).toBe(true);
    expect(readMetadata(dir).dolt_mode).toBe("server");
  });

  /**
   * The ids are read before the backup, so they age across an export that takes minutes on a big
   * board — and anton's scheduler or a stray shell is free to write the board in that window. An
   * issue created there is absent from the server AND absent from the set the arrived-whole check
   * runs over, so the move would report a clean arrival over a bead nobody sees again. The source is
   * read once more immediately before the flip, and a board that moved is refused (PR #174 review).
   */
  it("refuses when the board being moved changes while the switch is being prepared", () => {
    const dir = repo(EMBEDDED);
    const original = readFileSync(metadataPath(dir), "utf8");
    // A writer that was never stopped files one bead between the measurement and the flip.
    let reads = 0;
    const exec = (_cmd: string, args: string[]): Result => {
      if (args[0] === "--version") return { status: 0, stdout: "bd version 1.1.2" };
      if (isRead(args)) {
        reads += 1;
        return { status: 0, stdout: listing(reads === 1 ? BOARD : [...BOARD, "probe-8"]) };
      }
      return { status: 0 };
    };

    const result = configureServerMode(dir, flags, { exec });

    expect(result.ok).toBe(false);
    expect(result.drifted).toEqual(["probe-8"]);
    expect(result.errors.join("\n")).toMatch(/changed while the switch was being prepared/);
    // The fix is naming the writer, not re-running into the same race.
    expect(result.errors.join("\n")).toContain("anton stop");
    // Refused BEFORE the flip: metadata.json was never written, so there is nothing to revert.
    expect(readFileSync(metadataPath(dir), "utf8")).toBe(original);
    expect(result.steps.some((s: { name: string; status: string }) => s.name === "board unchanged" && s.status === "failed")).toBe(true);
  });

  /**
   * The half a key-set comparison cannot see (PR #174 review): a writer that UPDATES an existing
   * bead — closes it, retitles it, moves a label, takes the assignment — leaves the keys identical,
   * so the drift check passed, the arrived-whole check (keys again) passed, and the switch reported
   * a clean move while that update stayed behind in the embedded database nobody reads any more.
   * The per-record content digests are what catch it.
   */
  it("refuses when an existing issue is EDITED while the switch is being prepared", () => {
    const dir = repo(EMBEDDED);
    const original = readFileSync(metadataPath(dir), "utf8");
    // Same board, same ids, both reads — an agent just closed probe-3 between them.
    let reads = 0;
    const rows = (closed: boolean) =>
      exported(BOARD.map((id) => ({ _type: "issue", id, title: id, status: closed && id === "probe-3" ? "closed" : "open" })));
    const exec = (_cmd: string, args: string[]): Result => {
      if (args[0] === "--version") return { status: 0, stdout: "bd version 1.1.2" };
      if (isRead(args)) return { status: 0, stdout: rows(++reads > 1) };
      return { status: 0 };
    };

    const result = configureServerMode(dir, flags, { exec });

    expect(result.ok).toBe(false);
    expect(result.drifted).toEqual(["probe-3"]);
    expect(result.errors.join("\n")).toMatch(/appeared, disappeared or were edited/);
    // Refused BEFORE the flip, like every other drift: the board keeps working as it did.
    expect(readFileSync(metadataPath(dir), "utf8")).toBe(original);
  });

  /**
   * The state a LISTING cannot see at all, and the finding this read exists to answer (PR #174
   * review). `bd list --json` prints an issue's comment COUNT, so a comment edited in place reads
   * as identical, and it never prints persistent memories. Both are durable board state; both would
   * be stranded in the database this project is about to stop reading. The export catches them.
   */
  it.each([
    [
      "a comment edited in place",
      (edited: boolean) => [
        { _type: "issue", id: "probe-1", title: "probe-1", comments: [{ id: "c1", text: edited ? "an edited note" : "a note" }] },
      ],
      "probe-1",
    ],
    [
      "a memory written by `bd remember`",
      (edited: boolean) => [
        { _type: "issue", id: "probe-1", title: "probe-1" },
        ...(edited ? [{ _type: "memory", key: "a-fact", value: "remembered mid-flip" }] : []),
      ],
      "memory:a-fact",
    ],
  ])("refuses when %s lands while the switch is being prepared", (_label, board, key) => {
    const dir = repo(EMBEDDED);
    const original = readFileSync(metadataPath(dir), "utf8");
    let reads = 0;
    const exec = (_cmd: string, args: string[]): Result => {
      if (args[0] === "--version") return { status: 0, stdout: "bd version 1.1.2" };
      if (isRead(args)) return { status: 0, stdout: exported(board(++reads > 1)) };
      return { status: 0 };
    };

    const result = configureServerMode(dir, flags, { exec });

    expect(result.ok).toBe(false);
    expect(result.drifted).toEqual([key]);
    expect(readFileSync(metadataPath(dir), "utf8")).toBe(original);
  });

  // A source that becomes unreadable between the two reads is the same refusal, not a shrug: the
  // arrived-whole check would be running against a set nothing can confirm any more.
  it("refuses when the board being moved becomes unreadable before the flip", () => {
    const dir = repo(EMBEDDED);
    const original = readFileSync(metadataPath(dir), "utf8");
    let reads = 0;
    const exec = (_cmd: string, args: string[]): Result => {
      if (args[0] === "--version") return { status: 0, stdout: "bd version 1.1.2" };
      if (isRead(args)) {
        reads += 1;
        return reads === 1 ? { status: 0, stdout: listing(BOARD) } : { status: 1, stderr: "database is locked" };
      }
      return { status: 0 };
    };

    const result = configureServerMode(dir, flags, { exec });

    expect(result.ok).toBe(false);
    expect(result.errors.join("\n")).toMatch(/became unreadable while the switch was being prepared: .*database is locked/);
    expect(readFileSync(metadataPath(dir), "utf8")).toBe(original);
  });

  // --force has already switched the arrived-whole check off, so the re-read that refines it is a
  // full board listing spent on nothing — skipped rather than paid for.
  it("re-reads the source before the flip, and skips that read under --force", () => {
    const dir = repo(EMBEDDED);
    const checked = fakeBd({ dir, before: BOARD });
    expect(configureServerMode(dir, flags, { exec: checked.exec }).ok).toBe(true);
    // Source (measure) → source (re-check) → server (arrived-whole).
    expect(cmdline(checked.calls).filter((c) => c === "bd export --all").length).toBe(3);

    const forcedDir = repo(EMBEDDED);
    const forced = fakeBd({ dir: forcedDir, before: BOARD });
    expect(configureServerMode(forcedDir, { ...flags, force: true }, { exec: forced.exec }).ok).toBe(true);
    expect(cmdline(forced.calls).filter((c) => c === "bd export --all").length).toBe(2);
  });

  /**
   * The reason cardinality is not the check (PR #174 review). A stale or divergent copy of the SAME
   * project on the server — same size, or bigger — passes a count comparison while missing work
   * this board holds, and every write after the flip compounds onto that incomplete copy.
   */
  it("refuses a divergent server board that matches on count but not on identity", () => {
    const dir = repo(EMBEDDED);
    const original = readFileSync(metadataPath(dir), "utf8");
    // Same seven ids minus the two newest, plus three the server picked up on its own: MORE issues
    // than the board being moved, and still not this board.
    const divergent = [...BOARD.slice(0, 5), "probe-8", "probe-9", "probe-10"];

    const result = configureServerMode(dir, flags, { exec: fakeBd({ dir, before: BOARD, after: divergent }).exec });

    expect(result.ok).toBe(false);
    expect(result.counts).toEqual({ before: 7, after: 8 });
    expect(result.missing).toEqual(["probe-6", "probe-7"]);
    expect(result.errors.join("\n")).toMatch(/missing 2 of this board's 7 records \(probe-6, probe-7\)/);
    expect(readFileSync(metadataPath(dir), "utf8")).toBe(original);
  });

  /**
   * The blind spot a key-set check has on the DESTINATION side, and the mirror of the drift check
   * (PR #174 review): Phase 1 copies a snapshot taken before the last few edits, so every key is on
   * the server while a title, status, label, dependency, assignee or comment there predates the
   * board being moved. Membership passes; flipping strands those updates in the database nobody
   * reads again.
   */
  describe("the server's copy is checked by CONTENT, not just key membership", () => {
    /** Source and server boards of the same seven ids, differing only in `probe-3`. */
    const boards = (server: object, local: object = {}) => {
      const rows = (issues: object[]) => ({ status: 0, stdout: exported(issues) });
      const base = BOARD.map((id) => ({ _type: "issue", id, title: id, status: "open", updated_at: "2026-08-18T12:00:00Z" }));
      const here = base.map((i) => (i.id === "probe-3" ? { ...i, ...local } : i));
      const there = base.map((i) => (i.id === "probe-3" ? { ...i, ...server } : i));
      return (dir: string) =>
        (_cmd: string, args: string[]): Result => {
          if (args[0] === "--version") return { status: 0, stdout: "bd version 1.1.2" };
          if (isRead(args)) return rows(readMetadataFile(dir).raw.dolt_mode === "server" ? there : here);
          return { status: 0 };
        };
    };

    it("refuses and reverts when the server holds an OLDER copy of an issue it does hold", () => {
      const dir = repo(EMBEDDED);
      const original = readFileSync(metadataPath(dir), "utf8");
      // Copied before probe-3 was closed here: same id, same count, stale content.
      const exec = boards({ status: "open", updated_at: "2026-08-01T09:00:00Z" })(dir);

      const result = configureServerMode(dir, flags, { exec });

      expect(result.ok).toBe(false);
      expect(result.diverged).toEqual(["probe-3"]);
      expect(result.missing).toEqual([]);
      expect(result.errors.join("\n")).toMatch(/1 of them says something different there \(probe-3\)/);
      expect(result.errors.join("\n")).toContain("The copy on the server predates this board");
      // Reverted, not merely reported — the project keeps reading the board that is current.
      expect(readFileSync(metadataPath(dir), "utf8")).toBe(original);
      expect(result.steps.some((s: { status: string }) => s.status === "reverted")).toBe(true);
    });

    // Content that differs with nothing to order it by proves nothing about which side is ahead —
    // and "cannot tell" is not a reason to switch onto it.
    it("refuses differing content that carries no stamp to order the two copies by", () => {
      const dir = repo(EMBEDDED);
      const exec = (_cmd: string, args: string[]): Result => {
        if (args[0] === "--version") return { status: 0, stdout: "bd version 1.1.2" };
        if (isRead(args)) {
          const onServer = readMetadataFile(dir).raw.dolt_mode === "server";
          return {
            status: 0,
            stdout: exported(BOARD.map((id) => ({ _type: "issue", id, title: onServer && id === "probe-3" ? "an older title" : id }))),
          };
        }
        return { status: 0 };
      };

      const result = configureServerMode(dir, flags, { exec });
      expect(result.ok).toBe(false);
      expect(result.diverged).toEqual(["probe-3"]);
    });

    // A whole board reading as stale is not a stale board — it is the two sides describing the same
    // rows differently, and the message says so rather than sending the operator back to Phase 1.
    it("says so when EVERY record differs, which is an export mismatch and not a stale snapshot", () => {
      const dir = repo(EMBEDDED);
      const exec = (_cmd: string, args: string[]): Result => {
        if (args[0] === "--version") return { status: 0, stdout: "bd version 1.1.2" };
        if (isRead(args)) {
          const onServer = readMetadataFile(dir).raw.dolt_mode === "server";
          return {
            status: 0,
            stdout: exported(
              BOARD.map((id) => (onServer ? { _type: "issue", id, title: id, extra_column: null } : { _type: "issue", id, title: id })),
            ),
          };
        }
        return { status: 0 };
      };

      const result = configureServerMode(dir, flags, { exec });
      expect(result.ok).toBe(false);
      expect(result.diverged).toEqual(BOARD);
      expect(result.errors.join("\n")).toContain("EVERY record on the board");
    });

    /**
     * The direction a timestamp check waves through, and the reason there is no timestamp check any
     * more (PR #174 review). This board closed probe-3 at t1; the server's stale copy of the SAME
     * bead was retitled at t2 > t1. The server's row is newer and still does not contain the close,
     * so accepting it on the stamp alone strands exactly the update this check exists to protect.
     */
    it("refuses a server copy that is NEWER but was edited apart from this board's", () => {
      const dir = repo(EMBEDDED);
      const original = readFileSync(metadataPath(dir), "utf8");
      const exec = boards(
        { title: "retitled on the server", updated_at: "2026-08-19T09:00:00Z" },
        { status: "closed", updated_at: "2026-08-18T12:00:00Z" },
      )(dir);

      const result = configureServerMode(dir, flags, { exec });

      expect(result.ok).toBe(false);
      expect(result.diverged).toEqual(["probe-3"]);
      // Named for what it is, so the operator reaches for the two exports rather than Phase 1.
      expect(result.errors.join("\n")).toContain("written LAST on the server");
      expect(result.errors.join("\n")).toContain("does not merge them");
      expect(readFileSync(metadataPath(dir), "utf8")).toBe(original);
    });

    /**
     * The auxiliary board state a listing would have waved through, and the finding this answers
     * (PR #174 review). A `bd comment` or `bd remember` written after Phase 1 copied the database
     * lives ONLY in the embedded board: every issue row can still match — `bd list` prints a
     * comment COUNT and no memories at all — so a projection-based check would flip and strand the
     * review history and the persistent knowledge in the database being left behind.
     */
    it.each([
      [
        "a comment thread only the embedded board carries",
        [{ _type: "issue", id: "probe-1", comments: [{ id: "c1", text: "why we chose this" }] }],
        [{ _type: "issue", id: "probe-1", comments: [] }],
        { diverged: ["probe-1"], missing: [] },
      ],
      [
        "a memory only the embedded board carries",
        [{ _type: "issue", id: "probe-1" }, { _type: "memory", key: "a-fact", value: "learned the hard way" }],
        [{ _type: "issue", id: "probe-1" }],
        // An absent record fails the membership check, which returns before content is compared at
        // all — hence no `diverged` list on this one.
        { diverged: undefined, missing: ["memory:a-fact"] },
      ],
    ])("refuses and reverts when the server's copy is missing %s", (_label, here, there, expected) => {
      const dir = repo(EMBEDDED);
      const original = readFileSync(metadataPath(dir), "utf8");
      const exec = (_cmd: string, args: string[]): Result => {
        if (args[0] === "--version") return { status: 0, stdout: "bd version 1.1.2" };
        if (isRead(args)) {
          return { status: 0, stdout: exported(readMetadataFile(dir).raw.dolt_mode === "server" ? there : here) };
        }
        return { status: 0 };
      };

      const result = configureServerMode(dir, flags, { exec });

      expect(result.ok).toBe(false);
      expect(result.diverged).toEqual(expected.diverged);
      expect(result.missing).toEqual(expected.missing);
      // Reverted, not merely reported — that state is unrecoverable once the project stops reading
      // the database holding it.
      expect(readFileSync(metadataPath(dir), "utf8")).toBe(original);
      expect(result.steps.some((s: { status: string }) => s.status === "reverted")).toBe(true);
    });

    // Identical content is the one thing that proves the copy arrived — the flip needs no stamp.
    it("accepts a server copy that says exactly what this board says", () => {
      const dir = repo(EMBEDDED);
      const result = configureServerMode(dir, flags, { exec: boards({})(dir) });

      expect(result.ok).toBe(true);
      expect(result.diverged).toEqual([]);
      expect(readMetadata(dir).dolt_mode).toBe("server");
    });

    // --force already accepts a server board that is missing issues outright; a divergent one is
    // the same deliberate override, and the same flag.
    it("switches anyway under --force", () => {
      const dir = repo(EMBEDDED);
      const exec = boards({ status: "open", updated_at: "2026-08-01T09:00:00Z" })(dir);
      expect(configureServerMode(dir, { ...flags, force: true }, { exec }).ok).toBe(true);
      expect(readMetadata(dir).dolt_mode).toBe("server");
    });
  });

  /**
   * The DESTINATION-only direction (PR #174 review). A server that carries every issue AND has moved
   * on is not a failure — the board being moved is whole on the other side, which is the question
   * this check asks — but those extra ids are not self-explanatory either: they are a teammate's new
   * work, OR an issue deleted here after Phase 1 copied the database, which the flip resurrects.
   * bd prints no ancestry and no tombstone, so the run reports them instead of guessing, and does
   * not refuse: unlike a missing or divergent id, nothing of this board's is stranded by them, and
   * refusing would send the runbook's second machine to --force, which switches off the checks that
   * guard the half that IS unrecoverable.
   */
  describe("keys only the SERVER holds", () => {
    it("accepts a server board that holds every issue plus newer ones, and names the extras", () => {
      const dir = repo(EMBEDDED);
      const exec = fakeBd({ dir, before: BOARD, after: [...BOARD, "probe-8", "probe-9"] }).exec;

      const result = configureServerMode(dir, flags, { exec });

      expect(result.ok).toBe(true);
      expect(result.missing).toEqual([]);
      expect(result.diverged).toEqual([]);
      expect(result.extra).toEqual(["probe-8", "probe-9"]);
      expect(result.counts).toEqual({ before: 7, after: 9 });
      // Named, with BOTH readings — an operator who deleted an epic here has to be able to tell.
      expect(result.warnings.join("\n")).toMatch(/holds 2 records this board does not \(probe-8, probe-9\)/);
      expect(result.warnings.join("\n")).toMatch(/deleted HERE after the copy/);
      expect(result.steps.find((s: { name: string }) => s.name === "server-only records")).toMatchObject({
        status: "skipped",
      });
      // Reported, not refused: the switch stands.
      expect(readMetadata(dir).dolt_mode).toBe("server");
    });

    it("says nothing when the server holds exactly this board", () => {
      const dir = repo(EMBEDDED);
      const result = configureServerMode(dir, flags, { exec: fakeBd({ dir, before: BOARD, after: BOARD }).exec });

      expect(result.ok).toBe(true);
      expect(result.extra).toEqual([]);
      expect(result.warnings).toEqual([]);
      expect(result.steps.some((s: { name: string }) => s.name === "server-only records")).toBe(false);
    });

    /**
     * On a project already reading the server both listings come from it, so an id in one and not
     * the other is a teammate writing between two reads — nothing to do with a copy that may or may
     * not have resurrected something, and warning about it would train operators to ignore this.
     */
    it("does not warn when both listings come from the server anyway", () => {
      const dir = repo({ ...EMBEDDED, dolt_mode: "server", dolt_server_host: "dolt.example.dev", dolt_server_port: 3306 });
      let reads = 0;
      const exec = (_cmd: string, args: string[]): Result => {
        if (args[0] === "--version") return { status: 0, stdout: "bd version 1.1.2" };
        if (isRead(args)) {
          // Reads 1 and 2 are the drift check and must agree; the third is the read-back, where a
          // teammate's issue has landed in between.
          reads += 1;
          return { status: 0, stdout: listing(reads < 3 ? BOARD : [...BOARD, "probe-8"]) };
        }
        return { status: 0 };
      };

      const result = configureServerMode(dir, flags, { exec });

      expect(result.ok).toBe(true);
      expect(result.extra).toEqual([]);
      expect(result.warnings).toEqual([]);
    });

    /**
     * Being in server mode is NOT the same as reading the same board twice (PR #174 review).
     * Repointing an existing server board at another database compares two different boards, so a
     * destination-only key is once again either work created there or work deleted on the board
     * being left behind — the very thing this warning exists to surface.
     */
    it("warns when the flags repoint an existing server board at a different database", () => {
      const dir = repo({ ...EMBEDDED, dolt_mode: "server", dolt_server_host: CONNECTION.host, dolt_server_port: 3306, dolt_database: "probe-old" });
      let reads = 0;
      const exec = (_cmd: string, args: string[]): Result => {
        if (args[0] === "--version") return { status: 0, stdout: "bd version 1.1.2" };
        if (isRead(args)) {
          // Reads 1 and 2 are the drift check against the OLD database; the third is the read-back
          // from the new one, which carries a record the old board never had.
          reads += 1;
          return { status: 0, stdout: listing(reads < 3 ? BOARD : [...BOARD, "probe-8"]) };
        }
        return { status: 0 };
      };

      const result = configureServerMode(dir, flags, { exec });

      expect(result.ok).toBe(true);
      expect(result.extra).toEqual(["probe-8"]);
      expect(result.warnings.join("\n")).toMatch(/holds 1 record this board does not \(probe-8\)/);
      expect(readMetadata(dir).dolt_database).toBe("probe");
    });
  });

  /**
   * A re-run that keeps the same host, port and database — changing only the account or the
   * transport — reads ONE database twice, so there is no copy to check for arrival. A teammate
   * closing a bead or deleting one between the two reads is ordinary traffic on a shared board, and
   * comparing anyway reports records as missing or divergent from the very database that holds them,
   * then rolls back a switch that was correct (PR #174 review).
   */
  describe("a re-run that keeps the same server database", () => {
    const serverRepo = () =>
      repo({
        ...EMBEDDED,
        dolt_mode: "server",
        dolt_server_host: CONNECTION.host,
        dolt_server_port: 3306,
        dolt_database: "probe",
        dolt_server_user: "old-account",
      });

    /** Reads 1 and 2 are the drift check and must agree; the third is the read-back. */
    const readsThen = (later: string) => {
      let reads = 0;
      return (_cmd: string, args: string[]): Result => {
        if (args[0] === "--version") return { status: 0, stdout: "bd version 1.1.2" };
        if (isRead(args)) {
          reads += 1;
          return { status: 0, stdout: reads < 3 ? listing(BOARD) : later };
        }
        return { status: 0 };
      };
    };

    it("does not report a teammate's deletion as a board that never arrived", () => {
      const dir = serverRepo();

      const result = configureServerMode(dir, flags, { exec: readsThen(listing(BOARD.slice(1))) });

      expect(result.ok).toBe(true);
      expect(result.missing).toEqual([]);
      expect(result.counts).toEqual({ before: 7, after: 6 });
      expect(result.steps.find((s: { name: string }) => s.name === "arrived-whole check")).toMatchObject({
        status: "skipped",
      });
      // The switch stands — this run only ever changed the account it connects as.
      expect(readMetadata(dir).dolt_server_user).toBe("beads");
    });

    it("does not report a teammate's edit as divergence", () => {
      const dir = serverRepo();
      const retitled = exported(BOARD.map((id) => ({ _type: "issue", id, title: id === "probe-2" ? "retitled there" : id })));

      const result = configureServerMode(dir, flags, { exec: readsThen(retitled) });

      expect(result.ok).toBe(true);
      expect(result.diverged).toEqual([]);
      expect(result.errors).toEqual([]);
      expect(readMetadata(dir).dolt_server_user).toBe("beads");
    });
  });

  it("refuses to flip when the pre-switch backup fails, and skips it only on request", () => {
    const dir = repo(EMBEDDED);
    const original = readFileSync(metadataPath(dir), "utf8");

    const failed = configureServerMode(dir, flags, { exec: fakeBd({ dir, before: BOARD, export: { status: 1, stderr: "disk full" } }).exec });
    expect(failed.ok).toBe(false);
    expect(failed.errors.join("\n")).toContain("disk full");
    // The flip never happened, so there is nothing to revert — the file was never touched.
    expect(readFileSync(metadataPath(dir), "utf8")).toBe(original);

    const skipped = fakeBd({ dir, before: BOARD });
    expect(configureServerMode(dir, { ...flags, backup: false }, { exec: skipped.exec }).ok).toBe(true);
    expect(cmdline(skipped.calls).some((c) => c.includes("bd export --all -o"))).toBe(false);
  });

  it("skips the backup for a board already on a server — its data is not local to export", () => {
    const dir = repo({ ...EMBEDDED, dolt_mode: "server", dolt_server_host: "old.example.dev", dolt_server_port: 3306 });
    const { calls, exec } = fakeBd({ dir, before: BOARD });

    const result = configureServerMode(dir, flags, { exec });

    expect(result.ok).toBe(true);
    expect(cmdline(calls).some((c) => c.includes("bd export --all -o"))).toBe(false);
    expect(readMetadata(dir).dolt_server_host).toBe("dolt.example.dev");
  });

  /**
   * metadata.json is TRACKED, so one machine's flip reaches every clone on `git pull` — and from
   * then on that clone's own `anton server-mode` reads the server on BOTH sides of every check,
   * passing while whatever it wrote embedded-side sits unmerged in .beads/ (PR #174 review). The
   * run cannot tell that database from the leftover the runbook says to keep, so it must not report
   * a verification it did not make: it names the local board it did not compare.
   */
  it("warns when a clone that already reads the server still holds a local embedded board", () => {
    const dir = repo({ ...EMBEDDED, dolt_mode: "server", dolt_server_host: "dolt.example.dev", dolt_server_port: 3306 });
    mkdirSync(join(dir, ".beads", "embeddeddolt", "probe"), { recursive: true });

    const result = configureServerMode(dir, flags, { exec: fakeBd({ dir, before: BOARD }).exec });

    expect(result.ok).toBe(true);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toMatch(/local embedded Dolt database/);
    expect(result.warnings[0]).toMatch(/tracked by git/);
    // And it says so in the step list too, where an operator watching the run is looking.
    expect(result.steps.find((s: { name: string }) => s.name === "local board")).toMatchObject({ status: "skipped" });
  });

  // The runbook's second machine — a clone that hydrates nothing — has no local board to strand, so
  // the trivial pass is the honest answer there and warning about it would be noise.
  it("does not warn when the clone has no local Dolt database at all", () => {
    const dir = repo({ ...EMBEDDED, dolt_mode: "server", dolt_server_host: "dolt.example.dev", dolt_server_port: 3306 });

    const result = configureServerMode(dir, flags, { exec: fakeBd({ dir, before: BOARD }).exec });

    expect(result.ok).toBe(true);
    expect(result.warnings).toEqual([]);
    expect(result.steps.find((s: { name: string }) => s.name === "local board")).toMatchObject({ status: "ok" });
  });

  /**
   * The flip is prepared before the last board read and written straight after it, so metadata.json
   * is merged exactly once — outside the window that matters — and the write itself is a byte
   * comparison plus a rename (PR #174 review).
   */
  it("prepares the flip before the final read, and writes only once that read is in", () => {
    const dir = repo(EMBEDDED);
    const seen: string[] = [];
    const { exec } = fakeBd({ dir, before: BOARD });
    const wrapped = (cmd: string, args: string[]) => {
      if (isRead(args)) seen.push(readFileSync(metadataPath(dir), "utf8"));
      return exec(cmd, args);
    };

    const result = configureServerMode(dir, flags, { exec: wrapped });

    expect(result.ok).toBe(true);
    // Both source reads ran against the board as it was — the flip came after them.
    expect(seen.slice(0, 2).every((text) => JSON.parse(text).dolt_mode === "embedded")).toBe(true);
    expect(readMetadata(dir)).toMatchObject({ dolt_mode: "server", project_id: EMBEDDED.project_id });
  });

  /**
   * Preparing the merge early buys a small window and opens another one: the text was computed from
   * metadata.json as it read BEFORE a board export that may run for the whole network budget. An
   * edit that lands in between — here a corrected project_id — would be replaced wholesale by a
   * merge that never saw it, and a rename is not something the losing edit comes back from
   * (PR #174 review). The bytes are compared against the prepare's snapshot and the switch refused.
   */
  it("refuses when metadata.json changes while the switch is being prepared", () => {
    const dir = repo(EMBEDDED);
    const corrected = { ...EMBEDDED, project_id: "8040cdee-corrected" };
    let reads = 0;
    const { calls, exec } = fakeBd({ dir, before: BOARD });
    const wrapped = (cmd: string, args: string[]) => {
      // While the drift read is in flight — after the prepare, before the write.
      if (isRead(args) && ++reads === 2) writeFileSync(metadataPath(dir), `${JSON.stringify(corrected, null, 2)}\n`);
      return exec(cmd, args);
    };

    const result = configureServerMode(dir, flags, { exec: wrapped });

    expect(result.ok).toBe(false);
    expect(result.errors.join("\n")).toMatch(/metadata\.json changed while the switch was being prepared/);
    expect(result.errors.join("\n")).toContain("Nothing was written");
    // The concurrent edit is still there, and the board still reads the database it always did.
    expect(readMetadata(dir)).toEqual(corrected);
    // It never reached the flip, so it never reached the server either.
    expect(cmdline(calls).some((c) => c.includes("dolt test"))).toBe(false);
  });

  /** The same guard, for a metadata.json that stops being READABLE in that window. */
  it("refuses when metadata.json becomes unreadable while the switch is being prepared", () => {
    const dir = repo(EMBEDDED);
    let reads = 0;
    const { calls, exec } = fakeBd({ dir, before: BOARD });
    const wrapped = (cmd: string, args: string[]) => {
      if (isRead(args) && ++reads === 2) {
        rmSync(metadataPath(dir), { recursive: true, force: true });
        mkdirSync(metadataPath(dir));
      }
      return exec(cmd, args);
    };

    const result = configureServerMode(dir, flags, { exec: wrapped });

    expect(result.ok).toBe(false);
    expect(result.errors.join("\n")).toMatch(/could not read .*metadata\.json/);
    expect(result.errors.join("\n")).toContain("nothing was written");
    expect(cmdline(calls).some((c) => c.includes("dolt test"))).toBe(false);
  });


  /**
   * config.yaml is half of what a failed switch is rolled back from. Snapshotted AFTER the flip, an
   * unreadable one threw with the project already pointed at an unverified server and no revert on
   * the way out (PR #174 review) — so the read happens while there is still nothing to undo.
   */
  it("refuses before the flip when the rollback snapshot of config.yaml cannot be read", () => {
    const dir = repo(EMBEDDED);
    const original = readFileSync(metadataPath(dir), "utf8");
    // A config.yaml that exists and cannot be read: readFileSync throws EISDIR on a directory.
    const configPath = join(dir, ".beads", "config.yaml");
    rmSync(configPath);
    mkdirSync(configPath);

    const result = configureServerMode(dir, flags, { exec: fakeBd({ dir, before: BOARD }).exec });

    expect(result.ok).toBe(false);
    expect(result.errors.join("\n")).toMatch(/could not read .*config\.yaml/);
    expect(readFileSync(metadataPath(dir), "utf8")).toBe(original);
    expect(readMetadata(dir).dolt_mode).toBe("embedded");
  });

  /**
   * The other half of the same rollback snapshot. metadata.json passes step 2's validation and then
   * stops being readable — a permissions change, a path replaced by a directory — before step 5a
   * takes its prior bytes. That read goes through the guarded parser too, so the run refuses
   * loudly instead of exiting on an uncaught rejection (PR #174 review).
   */
  it("refuses before the flip when the rollback snapshot of metadata.json cannot be read", () => {
    const dir = repo(EMBEDDED);
    const { calls, exec } = fakeBd({ dir, before: BOARD });
    const breaking = (cmd: string, args: string[]): Result => {
      const result = exec(cmd, args);
      // Right after the board read of step 3, i.e. inside the window step 2 cannot cover.
      if (isRead(args) && existsSync(metadataPath(dir))) {
        rmSync(metadataPath(dir), { recursive: true, force: true });
        mkdirSync(metadataPath(dir));
      }
      return result;
    };

    const result = configureServerMode(dir, flags, { exec: breaking });

    expect(result.ok).toBe(false);
    expect(result.errors.join("\n")).toMatch(/could not read .*metadata\.json/);
    expect(result.errors.join("\n")).toContain("nothing was written");
    // It never reached the flip, so it never reached the server either.
    expect(cmdline(calls).some((c) => c.includes("dolt test"))).toBe(false);
  });

  /**
   * One anton drives many boards, and `BEADS_DOLT_SERVER_TLS` is one value for every one of them —
   * so the transport has to be the project's own (PR #174 review). `bd-env.ts` applies what lands
   * here; this is where it gets written.
   */
  it("writes the transport --tls/--no-tls declares, and leaves an undeclared one alone", () => {
    const dir = repo(EMBEDDED);

    expect(configureServerMode(dir, { ...flags, tls: true }, { exec: fakeBd({ dir, before: BOARD }).exec }).ok).toBe(true);
    expect(readMetadata(dir).dolt_server_tls).toBe(true);

    // A re-run that says nothing about the transport keeps what the project already declared.
    expect(configureServerMode(dir, flags, { exec: fakeBd({ dir, before: BOARD }).exec }).ok).toBe(true);
    expect(readMetadata(dir).dolt_server_tls).toBe(true);

    expect(configureServerMode(dir, { ...flags, tls: false }, { exec: fakeBd({ dir, before: BOARD }).exec }).ok).toBe(true);
    expect(readMetadata(dir).dolt_server_tls).toBe(false);
  });

  // A board written before the key existed declares nothing, and inherits the ambient variable —
  // which is what keeps the documented single-server deployment working.
  it("adds no transport key when neither the flags nor the file names one", () => {
    const dir = repo(EMBEDDED);
    expect(configureServerMode(dir, flags, { exec: fakeBd({ dir, before: BOARD }).exec }).ok).toBe(true);
    expect("dolt_server_tls" in readMetadata(dir)).toBe(false);
  });

  /**
   * The flip writes metadata.json by MERGING into it, so a file it cannot parse is a file it would
   * REPLACE — losing bd's `project_id` and `backend` on a board whose only problem was its mode (PR
   * #174 review). Not even --force gets through: the refusal is about not destroying the file.
   */
  it("refuses an unreadable metadata.json rather than overwriting it, --force included", () => {
    for (const force of [false, true]) {
      const dir = repo('{ "project_id": "8040cdee-1234"');
      const original = readFileSync(metadataPath(dir), "utf8");
      const { calls, exec } = fakeBd({ dir, before: BOARD });

      const result = configureServerMode(dir, { ...flags, force }, { exec });

      expect(result.ok).toBe(false);
      expect(result.errors.join("\n")).toMatch(/is not valid JSON/);
      expect(result.errors.join("\n")).toContain("project_id");
      expect(readFileSync(metadataPath(dir), "utf8")).toBe(original);
      // It stops before the board is even read: nothing to back up, nothing to revert.
      expect(cmdline(calls)).toEqual(["bd --version"]);
    }
  });

  it("validates before touching anything — a missing flag writes no file and spawns no bd", () => {
    const dir = repo(EMBEDDED);
    const original = readFileSync(metadataPath(dir), "utf8");
    const { calls, exec } = fakeBd({ dir, before: BOARD });

    const result = configureServerMode(dir, { port: 3306 }, { exec });

    expect(result.ok).toBe(false);
    expect(result.errors.join("\n")).toContain("--host");
    expect(readFileSync(metadataPath(dir), "utf8")).toBe(original);
    expect(cmdline(calls)).toEqual(["bd --version"]);
  });

  it("fails loud on an old bd and on a directory with no beads workspace", () => {
    const old = configureServerMode(repo(EMBEDDED), flags, { exec: fakeBd({ version: "1.0.4" }).exec });
    expect(old.ok).toBe(false);
    expect(old.errors.join("\n")).toContain("too old");

    const bare = mkdtempSync(join(tmpdir(), "anton-server-mode-bare-"));
    dirs.push(bare);
    const missing = configureServerMode(bare, flags, { exec: fakeBd().exec });
    expect(missing.ok).toBe(false);
    expect(missing.errors.join("\n")).toContain("anton init");
  });
});
