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
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  DEFAULT_DOLT_PORT,
  backupBoard,
  configureServerMode,
  prepareServerModeMetadata,
  readBoardIds,
  readMetadataFile,
  resolveServerConnection,
  restoreFile,
  testDoltConnection,
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

/** `bd list --json` as bd prints it: the ids wrapped in the object form, warnings and all. */
const listing = (ids: string[]) =>
  `Warning: deprecated\n${JSON.stringify({ issues: ids.map((id) => ({ id, title: id })) }, null, 2)}\n`;

/**
 * A stub `bd` that records every invocation and answers by subcommand. `bd list` answers from the
 * board the project is CURRENTLY pointed at — `after` once metadata.json says server, `before`
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
    if (args[0] === "list") {
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

describe("readBoardIds", () => {
  /** The parse, without the digests — those are asserted on their own below. */
  const ids = (stdout: string) => {
    const read = readBoardIds(repo(EMBEDDED), { exec: () => ({ status: 0, stdout }) });
    return read.ok ? { ok: read.ok, ids: read.ids } : read;
  };

  // Closed issues, gates, infra beads and templates are board state too: a check that skipped them
  // would call a board arrived while a third of it was still at home.
  it("asks bd for EVERY issue — closed, gates, infra and templates included, unlimited", () => {
    const calls: string[][] = [];
    const exec = (cmd: string, args: string[]) => {
      calls.push([cmd, ...args]);
      return { status: 0, stdout: listing(["probe-1"]) };
    };
    expect(readBoardIds(repo(EMBEDDED), { exec }).ids).toEqual(["probe-1"]);
    const ran = calls[0].join(" ");
    for (const flag of ["--all", "--limit 0", "--include-gates", "--include-infra", "--include-templates"]) {
      expect(ran).toContain(flag);
    }
    // Labels are hydrated on EVERY read: each one is compared against another by content digest,
    // and a read that skipped them would report the whole board as changed.
    expect(ran).not.toContain("--skip-labels");
  });

  /**
   * The digests are what the drift check compares, and ids alone cannot answer it: a writer that
   * updates an existing issue leaves the id set identical (PR #174 review). Labels are part of that
   * content, so a content read hydrates them.
   */
  it("fingerprints each issue's content, labels included, for the drift check", () => {
    const calls: string[][] = [];
    /** `probe-1`'s fingerprint as bd printed it — throwing rather than comparing two undefineds. */
    const fingerprint = (issue: object): string => {
      const read = readBoardIds(repo(EMBEDDED), {
        exec: (cmd: string, args: string[]) => {
          calls.push([cmd, ...args]);
          return { status: 0, stdout: JSON.stringify({ issues: [issue] }) };
        },
      });
      const fp = read.digests?.get("probe-1");
      if (!fp) throw new Error(`no digest for probe-1: ${read.detail ?? "board read as empty"}`);
      return fp;
    };

    const open = fingerprint({ id: "probe-1", title: "t", status: "open", labels: ["approved"] });
    expect(fingerprint({ id: "probe-1", title: "t", status: "closed", labels: ["approved"] })).not.toBe(open);
    expect(fingerprint({ id: "probe-1", title: "T", status: "open", labels: ["approved"] })).not.toBe(open);
    expect(fingerprint({ id: "probe-1", title: "t", status: "open", labels: ["approved", "risk:low"] })).not.toBe(open);

    // Unchanged content fingerprints the same, whatever order bd prints the fields and labels in —
    // a reordered listing must not read as a mid-flip edit and refuse the switch.
    expect(fingerprint({ id: "probe-1", title: "t", status: "open", labels: ["approved"] })).toBe(open);
    expect(fingerprint({ labels: ["approved"], status: "open", title: "t", id: "probe-1" })).toBe(open);

    for (const call of calls) expect(call.join(" ")).not.toContain("--skip-labels");
  });

  it("reads both shapes bd answers with — a bare array and the { issues } wrapper", () => {
    expect(ids('[{"id": "probe-1"}, {"id": "probe-2"}]')).toEqual({ ok: true, ids: ["probe-1", "probe-2"] });
    expect(ids('{"issues": [{"id": "probe-1"}]}')).toEqual({ ok: true, ids: ["probe-1"] });
    expect(ids("[]")).toEqual({ ok: true, ids: [] });
  });

  // The pre-flip read is the ONLY input to the arrived-whole check — a warning bd decides to print
  // with brackets in it must not turn a healthy board into "no readable board" and skip that check.
  it("steps over a warning that contains brackets of its own, on either side of the JSON", () => {
    const payload = '{"issues": [{"id": "probe-1"}]}';
    expect(ids(`warning: use {dolt.auto-commit} instead\n${payload}\n`)).toEqual({ ok: true, ids: ["probe-1"] });
    expect(ids(`${payload}\nwarning: use {dolt.auto-commit} instead\n`)).toEqual({ ok: true, ids: ["probe-1"] });
    expect(ids(`warning: pass [--all] instead\n${payload}\n`)).toEqual({ ok: true, ids: ["probe-1"] });
  });

  // The scan budget belongs to the payload, not to the warning in front of it: a bounded search
  // that spends every attempt on the closes behind a warning's stray `{` reports "no readable
  // board" on exactly the large boards this migration exists for (PR #174 review).
  it("still finds the board behind a brace-bearing warning when the board is large", () => {
    const many = Array.from({ length: 250 }, (_, n) => ({ id: `probe-${n + 1}` }));
    const stdout = `warning: use {dolt.auto-commit} instead\n${JSON.stringify({ issues: many })}\n`;
    expect(ids(stdout)).toEqual({ ok: true, ids: many.map((i) => i.id) });
  });

  /**
   * The budget is finite, so where it runs out is pinned here rather than discovered in the field
   * (PR #174 review). 100 openers is far past the one or two bracket-bearing lines any bd has been
   * seen to print, and the failure beyond it is the safe one: a board that reads as UNREADABLE — a
   * refused flip — never a different board accepted as this one.
   */
  it("reads past a warning preamble up to the scan budget, and fails loud beyond it", () => {
    const payload = '{"issues": [{"id": "probe-1"}]}';
    const noise = (n: number) => Array.from({ length: n }, (_, i) => `warning: {opt-${i}} is deprecated`).join("\n");

    expect(ids(`${noise(99)}\n${payload}\n`)).toEqual({ ok: true, ids: ["probe-1"] });
    expect(ids(`${noise(200)}\n${payload}\n`)).toEqual({ ok: false, detail: "bd list printed no readable board" });
  });

  // A `}` inside an issue's own text is not the end of the payload.
  it("reads a board whose issue text carries brackets of its own", () => {
    expect(ids('{"issues": [{"id": "probe-1", "title": "use {dolt.auto-commit} [now]"}]}')).toEqual({
      ok: true,
      ids: ["probe-1"],
    });
  });

  // An issue's own nested arrays parse perfectly well and are not the board — "it parsed" is not
  // enough, or a board would be read as its first issue's dependency list.
  it("does not mistake an issue's nested array for the board", () => {
    expect(ids('{"issues": [{"id": "probe-1", "dependencies": []}]}')).toEqual({ ok: true, ids: ["probe-1"] });
  });

  it("reports a failed or unreadable board rather than calling it empty", () => {
    expect(readBoardIds(repo(EMBEDDED), { exec: () => ({ status: 1, stderr: "connection refused" }) })).toEqual({
      ok: false,
      detail: "connection refused",
    });
    expect(ids("no json here").ok).toBe(false);
    // Issues without ids are not a board this can compare — reported, never silently empty.
    expect(ids('{"issues": [{"title": "no id"}]}').ok).toBe(false);
    // The documented cost of that (PR #174 review): a bare `[]` with anything printed around it is
    // indistinguishable from a warning's own brackets, so an EMPTY board bd wraps in a stdout
    // warning reads as unreadable. Deliberate — an empty source set would make the arrived-whole
    // check pass over ANY server board, and configureServerMode names --force as the way through.
    expect(ids("warning: deprecated\n[]\n").ok).toBe(false);
    expect(ids('warning: deprecated\n{"issues": []}\n')).toEqual({ ok: true, ids: [] });
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
});

describe("testDoltConnection", () => {
  it("names the PER-USER password variable in its hints", () => {
    const { exec } = fakeBd({ test: { status: 1, stderr: "Connection failed" } });
    const result = testDoltConnection(repo(EMBEDDED), CONNECTION, { exec });
    expect(result.ok).toBe(false);
    const hints = (result.hints ?? []).join("\n");
    expect(hints).toContain("BEADS_DOLT_PASSWORD_BEADS");
    expect(hints).toContain("dolt.example.dev:3306");
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
    expect(ran.some((c) => c.startsWith("bd export --all"))).toBe(true);
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
    // Nothing was published: a board that cannot connect must not leave a team default behind.
    expect(cmdline(calls).some((c) => c.includes("--update-config"))).toBe(false);
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
      if (args[0] === "list") return { status: 0, stdout: listing(BOARD) };
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
   * The failure this command exists to catch. `bd dolt test` connects to the SERVER; it says nothing
   * about whether this project can open its database there — bd's own project-identity guard refuses
   * a database belonging to another project long after the connection test has passed.
   */
  it("fails and reverts when the server connects but the board cannot be read back", () => {
    const dir = repo(EMBEDDED);
    const original = readFileSync(metadataPath(dir), "utf8");
    const exec = (_cmd: string, args: string[]): Result => {
      if (args[0] === "--version") return { status: 0, stdout: "bd version 1.1.2" };
      if (args[0] === "list") {
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
      if (args[0] === "list") {
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
    expect(refused.errors.join("\n")).toMatch(/missing 7 of this board's 7 issues/);
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
      if (args[0] === "list") {
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
   * The half an id-set comparison cannot see (PR #174 review): a writer that UPDATES an existing
   * bead — closes it, retitles it, moves a label, takes the assignment — leaves the ids identical,
   * so the drift check passed, the arrived-whole check (ids again) passed, and the switch reported
   * a clean move while that update stayed behind in the embedded database nobody reads any more.
   * The per-issue content digests are what catch it.
   */
  it("refuses when an existing issue is EDITED while the switch is being prepared", () => {
    const dir = repo(EMBEDDED);
    const original = readFileSync(metadataPath(dir), "utf8");
    // Same board, same ids, both reads — an agent just closed probe-3 between them.
    let reads = 0;
    const rows = (closed: boolean) =>
      JSON.stringify({
        issues: BOARD.map((id) => ({ id, title: id, status: closed && id === "probe-3" ? "closed" : "open" })),
      });
    const exec = (_cmd: string, args: string[]): Result => {
      if (args[0] === "--version") return { status: 0, stdout: "bd version 1.1.2" };
      if (args[0] === "list") return { status: 0, stdout: rows(++reads > 1) };
      return { status: 0 };
    };

    const result = configureServerMode(dir, flags, { exec });

    expect(result.ok).toBe(false);
    expect(result.drifted).toEqual(["probe-3"]);
    expect(result.errors.join("\n")).toMatch(/appeared, disappeared or were edited/);
    // Refused BEFORE the flip, like every other drift: the board keeps working as it did.
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
      if (args[0] === "list") {
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
    expect(cmdline(checked.calls).filter((c) => c.startsWith("bd list")).length).toBe(3);

    const forcedDir = repo(EMBEDDED);
    const forced = fakeBd({ dir: forcedDir, before: BOARD });
    expect(configureServerMode(forcedDir, { ...flags, force: true }, { exec: forced.exec }).ok).toBe(true);
    expect(cmdline(forced.calls).filter((c) => c.startsWith("bd list")).length).toBe(2);
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
    expect(result.errors.join("\n")).toMatch(/missing 2 of this board's 7 issues \(probe-6, probe-7\)/);
    expect(readFileSync(metadataPath(dir), "utf8")).toBe(original);
  });

  /**
   * The blind spot an id-set check has on the DESTINATION side, and the mirror of the drift check
   * (PR #174 review): Phase 1 copies a snapshot taken before the last few edits, so every id is on
   * the server while a title, status, label, dependency or assignee there predates the board being
   * moved. Membership passes; flipping strands those updates in the database nobody reads again.
   */
  describe("the server's copy is checked by CONTENT, not just id membership", () => {
    /** Source and server boards of the same seven ids, differing only in `probe-3`. */
    const boards = (server: object, local: object = {}) => {
      const rows = (issues: object[]) => ({ status: 0, stdout: JSON.stringify({ issues }) });
      const base = BOARD.map((id) => ({ id, title: id, status: "open", updated_at: "2026-08-18T12:00:00Z" }));
      const here = base.map((i) => (i.id === "probe-3" ? { ...i, ...local } : i));
      const there = base.map((i) => (i.id === "probe-3" ? { ...i, ...server } : i));
      return (dir: string) =>
        (_cmd: string, args: string[]): Result => {
          if (args[0] === "--version") return { status: 0, stdout: "bd version 1.1.2" };
          if (args[0] === "list") return rows(readMetadataFile(dir).raw.dolt_mode === "server" ? there : here);
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
      expect(result.errors.join("\n")).toMatch(/1 issue says something different there \(probe-3\)/);
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
        if (args[0] === "list") {
          const onServer = readMetadataFile(dir).raw.dolt_mode === "server";
          return {
            status: 0,
            stdout: JSON.stringify({
              issues: BOARD.map((id) => ({ id, title: onServer && id === "probe-3" ? "an older title" : id })),
            }),
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
    it("says so when EVERY issue differs, which is a listing mismatch and not a stale snapshot", () => {
      const dir = repo(EMBEDDED);
      const exec = (_cmd: string, args: string[]): Result => {
        if (args[0] === "--version") return { status: 0, stdout: "bd version 1.1.2" };
        if (args[0] === "list") {
          const onServer = readMetadataFile(dir).raw.dolt_mode === "server";
          return {
            status: 0,
            stdout: JSON.stringify({
              issues: BOARD.map((id) => (onServer ? { id, title: id, extra_column: null } : { id, title: id })),
            }),
          };
        }
        return { status: 0 };
      };

      const result = configureServerMode(dir, flags, { exec });
      expect(result.ok).toBe(false);
      expect(result.diverged).toEqual(BOARD);
      expect(result.errors.join("\n")).toContain("EVERY issue on the board");
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
      // Named for what it is, so the operator reaches for the two listings rather than Phase 1.
      expect(result.errors.join("\n")).toContain("written LAST on the server");
      expect(result.errors.join("\n")).toContain("does not merge them");
      expect(readFileSync(metadataPath(dir), "utf8")).toBe(original);
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

  // A server that carries every issue AND has moved on (another machine already writing to it) is
  // not a failure — the board being moved is whole on the other side, which is the whole question.
  it("accepts a server board that holds every issue plus newer ones", () => {
    const dir = repo(EMBEDDED);
    const result = configureServerMode(dir, flags, { exec: fakeBd({ dir, before: BOARD, after: [...BOARD, "probe-8"] }).exec });

    expect(result.ok).toBe(true);
    expect(result.missing).toEqual([]);
    expect(result.counts).toEqual({ before: 7, after: 8 });
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
    expect(cmdline(skipped.calls).some((c) => c.startsWith("bd export"))).toBe(false);
  });

  it("skips the backup for a board already on a server — its data is not local to export", () => {
    const dir = repo({ ...EMBEDDED, dolt_mode: "server", dolt_server_host: "old.example.dev", dolt_server_port: 3306 });
    const { calls, exec } = fakeBd({ dir, before: BOARD });

    const result = configureServerMode(dir, flags, { exec });

    expect(result.ok).toBe(true);
    expect(cmdline(calls).some((c) => c.startsWith("bd export"))).toBe(false);
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
   * is read and merged exactly once — well outside the window that matters. Proven by making the
   * file unparseable DURING that read: the switch still lands the text prepared from the good file,
   * because nothing re-reads it at write time (PR #174 review).
   */
  it("prepares the flip before the final read, so the write itself re-reads nothing", () => {
    const dir = repo(EMBEDDED);
    const seen: string[] = [];
    let reads = 0;
    const { exec } = fakeBd({ dir, before: BOARD });
    const wrapped = (cmd: string, args: string[]) => {
      if (args[0] === "list") {
        seen.push(readFileSync(metadataPath(dir), "utf8"));
        // Clobber the file while the drift read is in flight — after the prepare, before the write.
        if (++reads === 2) writeFileSync(metadataPath(dir), "{ clobbered");
      }
      return exec(cmd, args);
    };

    const result = configureServerMode(dir, flags, { exec: wrapped });

    expect(result.ok).toBe(true);
    // Both source reads ran against the board as it was — the flip came after them.
    expect(seen.slice(0, 2).every((text) => JSON.parse(text).dolt_mode === "embedded")).toBe(true);
    expect(readMetadata(dir)).toMatchObject({ dolt_mode: "server", project_id: EMBEDDED.project_id });
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
