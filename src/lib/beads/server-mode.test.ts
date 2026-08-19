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
  countBoard,
  readMetadataFile,
  resolveServerConnection,
  restoreMetadata,
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
 * A stub `bd` that records every invocation and answers by subcommand. `counts` is consumed in
 * order, so a case can hand back one number before the switch and another after it.
 */
function fakeBd(opts: { counts?: number[]; test?: Result; export?: Result; version?: string } = {}) {
  const calls: string[][] = [];
  const counts = [...(opts.counts ?? [])];
  const exec = (cmd: string, args: string[]): Result => {
    calls.push([cmd, ...args]);
    if (args[0] === "--version") return { status: 0, stdout: `bd version ${opts.version ?? "1.1.2"} (fake)` };
    if (args[0] === "count") {
      const next = counts.length > 1 ? counts.shift() : counts[0];
      return next === undefined
        ? { status: 1, stderr: "no board" }
        : { status: 0, stdout: `{\n  "count": ${next},\n  "schema_version": 1\n}\n` };
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
    restoreMetadata(written.path, written.before);
    expect(readFileSync(metadataPath(dir), "utf8")).toBe(original);

    const fresh = repo();
    const created = writeServerModeMetadata(fresh, CONNECTION);
    restoreMetadata(created.path, created.before);
    expect(existsSync(metadataPath(fresh))).toBe(false);
  });

  it("reads unparseable metadata as empty rather than throwing", () => {
    const dir = repo("{ not json");
    expect(readMetadataFile(dir)).toEqual({});
    expect(writeServerModeMetadata(dir, CONNECTION).status).toBe("written");
  });
});

describe("countBoard", () => {
  it("parses the count out of stdout even when bd prefixes it with warnings", () => {
    const exec = () => ({ status: 0, stdout: 'Warning: deprecated\n{\n  "count": 42\n}\n', stderr: "Warning: also deprecated" });
    expect(countBoard(repo(EMBEDDED), { exec })).toEqual({ ok: true, count: 42 });
  });

  it("reports a failed or unreadable count rather than calling it zero", () => {
    expect(countBoard(repo(EMBEDDED), { exec: () => ({ status: 1, stderr: "connection refused" }) })).toEqual({
      ok: false,
      detail: "connection refused",
    });
    expect(countBoard(repo(EMBEDDED), { exec: () => ({ status: 0, stdout: "no json here" }) }).ok).toBe(false);
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
    const { calls, exec } = fakeBd({ counts: [7] });

    const result = configureServerMode(dir, flags, { exec });

    expect(result.ok).toBe(true);
    expect(result.counts).toEqual({ before: 7, after: 7 });
    expect(readMetadata(dir).dolt_mode).toBe("server");
    const ran = cmdline(calls);
    expect(ran.some((c) => c.startsWith("bd export --all"))).toBe(true);
    expect(ran).toContainEqual("bd dolt test");
    // The connection reaches config.yaml as the team-wide default so the next clone inherits it.
    expect(ran).toContainEqual("bd dolt set host dolt.example.dev --update-config");
    expect(ran).toContainEqual("bd dolt set database probe --update-config");
    expect(ran).toContainEqual("bd config set dolt.auto-commit on");
  });

  it("reverts metadata.json byte-for-byte when the server refuses the connection", () => {
    const dir = repo(EMBEDDED);
    const original = readFileSync(metadataPath(dir), "utf8");
    const { calls, exec } = fakeBd({ counts: [7], test: { status: 1, stderr: "Connection failed" } });

    const result = configureServerMode(dir, flags, { exec });

    expect(result.ok).toBe(false);
    expect(readFileSync(metadataPath(dir), "utf8")).toBe(original);
    expect(result.steps.some((s: { status: string }) => s.status === "reverted")).toBe(true);
    // Nothing was published: a board that cannot connect must not leave a team default behind.
    expect(cmdline(calls).some((c) => c.includes("--update-config"))).toBe(false);
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
      if (args[0] === "count") {
        // The pre-switch read succeeds; the post-switch one hits the identity guard.
        return readMetadataFile(dir).dolt_mode === "server"
          ? { status: 1, stderr: "PROJECT IDENTITY MISMATCH — refusing to connect" }
          : { status: 0, stdout: '{"count": 7}' };
      }
      return { status: 0 };
    };

    const result = configureServerMode(dir, flags, { exec });

    expect(result.ok).toBe(false);
    expect(result.errors.join("\n")).toContain("PROJECT IDENTITY MISMATCH");
    expect(readFileSync(metadataPath(dir), "utf8")).toBe(original);
  });

  it("refuses a server board holding fewer issues than the board being moved — unless forced", () => {
    const dir = repo(EMBEDDED);
    const original = readFileSync(metadataPath(dir), "utf8");

    const refused = configureServerMode(dir, flags, { exec: fakeBd({ counts: [7, 0] }).exec });
    expect(refused.ok).toBe(false);
    expect(refused.errors.join("\n")).toMatch(/holds 0 issues but this board has 7/);
    expect(readFileSync(metadataPath(dir), "utf8")).toBe(original);

    const forced = configureServerMode(dir, { ...flags, force: true }, { exec: fakeBd({ counts: [7, 0] }).exec });
    expect(forced.ok).toBe(true);
    expect(readMetadata(dir).dolt_mode).toBe("server");
  });

  it("refuses to flip when the pre-switch backup fails, and skips it only on request", () => {
    const dir = repo(EMBEDDED);
    const original = readFileSync(metadataPath(dir), "utf8");

    const failed = configureServerMode(dir, flags, { exec: fakeBd({ counts: [7], export: { status: 1, stderr: "disk full" } }).exec });
    expect(failed.ok).toBe(false);
    expect(failed.errors.join("\n")).toContain("disk full");
    // The flip never happened, so there is nothing to revert — the file was never touched.
    expect(readFileSync(metadataPath(dir), "utf8")).toBe(original);

    const skipped = fakeBd({ counts: [7] });
    expect(configureServerMode(dir, { ...flags, backup: false }, { exec: skipped.exec }).ok).toBe(true);
    expect(cmdline(skipped.calls).some((c) => c.startsWith("bd export"))).toBe(false);
  });

  it("skips the backup for a board already on a server — its data is not local to export", () => {
    const dir = repo({ ...EMBEDDED, dolt_mode: "server", dolt_server_host: "old.example.dev", dolt_server_port: 3306 });
    const { calls, exec } = fakeBd({ counts: [7] });

    const result = configureServerMode(dir, flags, { exec });

    expect(result.ok).toBe(true);
    expect(cmdline(calls).some((c) => c.startsWith("bd export"))).toBe(false);
    expect(readMetadata(dir).dolt_server_host).toBe("dolt.example.dev");
  });

  it("validates before touching anything — a missing flag writes no file and spawns no bd", () => {
    const dir = repo(EMBEDDED);
    const original = readFileSync(metadataPath(dir), "utf8");
    const { calls, exec } = fakeBd({ counts: [7] });

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
