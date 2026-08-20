/**
 * `anton server-mode` — the CLI half of pointing one project's board at a shared Dolt server
 * (anton-yvjd). Argument parsing in isolation, then the command end-to-end against a STUB `bd` on
 * PATH, since CI has neither bd nor a Dolt server.
 *
 * The judgement it drives is asserted in `src/lib/beads/server-mode.test.ts`; what belongs here is
 * the wiring the module cannot see — that the flags reach it, and that a refusal is a NON-ZERO exit
 * with the board left alone. anton's own runbook tells an operator to read that exit code.
 */
import { afterEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { parseServerModeArgs } from "./anton.mjs";

import { CLI, pathWith, tempDirs, writeFakeBd } from "./anton.fixture";

const dirs = tempDirs();
afterEach(() => dirs.cleanup());

const EMBEDDED = { database: "dolt", backend: "dolt", dolt_mode: "embedded", dolt_database: "probe", project_id: "abc-123" };

/**
 * A stub `bd` for the server-mode flow. The verification read is `bd export --all` on stdout (the
 * one read that carries comments and memories); it answers with the ids in `.beads/.fake-board`
 * (local ids, then the server's, separated by `|`) so a case can make the server's board differ
 * from the local one. `bd export --all -o <file>` is the backup, and `bd dolt test` fails when
 * `.beads/.fake-unreachable` exists — the two failures the command is built to catch.
 */
const FAKE_BD_SERVER = [
  "#!/usr/bin/env node",
  'const fs = require("node:fs");',
  'const path = require("node:path");',
  "const a = process.argv.slice(2);",
  'const beads = path.join(process.cwd(), ".beads");',
  'const read = (f, d) => { try { return fs.readFileSync(path.join(beads, f), "utf8").trim(); } catch { return d; } };',
  'if (a[0] === "--version" || a[0] === "--help") { console.log("bd version 1.1.2 (fake)"); process.exit(0); }',
  'if (a[0] === "export" && a.includes("-o")) { fs.writeFileSync(a[a.indexOf("-o") + 1], ""); process.exit(0); }',
  'if (a[0] === "export") {',
  '  const mode = JSON.parse(read("metadata.json", "{}")).dolt_mode;',
  '  const boards = read(".fake-board", "probe-1,probe-2,probe-3|probe-1,probe-2,probe-3").split("|");',
  '  const ids = (mode === "server" ? boards[1] : boards[0]).split(",").filter(Boolean);',
  '  for (const id of ids) console.log(JSON.stringify({ _type: "issue", id }));',
  "  process.exit(0);",
  "}",
  'if (a[0] === "dolt" && a[1] === "test") {',
  '  if (fs.existsSync(path.join(beads, ".fake-unreachable"))) { console.error("Connection failed"); process.exit(1); }',
  "  process.exit(0);",
  "}",
  "process.exit(0);",
].join("\n");

/** A repo dir with an embedded `.beads/`, a stub bd first on PATH, and a runner for the command. */
async function project(seed: Record<string, string> = {}) {
  const dir = await dirs.make("anton-server-mode-cli-");
  const beads = join(dir, ".beads");
  mkdirSync(beads, { recursive: true });
  writeFileSync(join(beads, "metadata.json"), JSON.stringify(EMBEDDED, null, 2));
  writeFileSync(join(beads, "config.yaml"), "prefix: probe\n");
  for (const [file, body] of Object.entries(seed)) writeFileSync(join(beads, file), body);

  const binDir = await dirs.make("anton-server-mode-bin-");
  writeFakeBd(binDir, FAKE_BD_SERVER);

  return {
    dir,
    metadata: () => JSON.parse(readFileSync(join(beads, "metadata.json"), "utf8")),
    raw: () => readFileSync(join(beads, "metadata.json"), "utf8"),
    run: (args: string[]) =>
      spawnSync("node", [CLI, "server-mode", dir, ...args], {
        encoding: "utf8",
        env: { ...process.env, PATH: pathWith(binDir) },
      }),
  };
}

const CONNECT = ["--host", "dolt.example.dev", "--port", "3306", "--user", "beads", "--database", "probe"];

describe("parseServerModeArgs", () => {
  it("defaults to the cwd, port-less, backing up, and not forcing", () => {
    expect(parseServerModeArgs([])).toEqual({
      path: null,
      host: null,
      port: null,
      user: null,
      database: null,
      backup: true,
      force: false,
      unknown: [],
      missing: [],
      extra: [],
    });
  });

  it("parses the connection in both `--flag <v>` and `--flag=<v>` forms, keeping the bare token as path", () => {
    expect(parseServerModeArgs(["/repos/foo", "--host", "h", "--port", "3307", "--user", "u", "--db", "d"])).toEqual({
      path: "/repos/foo",
      host: "h",
      port: "3307",
      user: "u",
      database: "d",
      backup: true,
      force: false,
      unknown: [],
      missing: [],
      extra: [],
    });
    // A flag VALUE is never mistaken for the path, whichever form it takes.
    expect(parseServerModeArgs(["--host=h", "--database=d", "/repos/foo"])).toMatchObject({
      path: "/repos/foo",
      host: "h",
      database: "d",
    });
    expect(parseServerModeArgs(["--host", "h", "/repos/foo"])).toMatchObject({ path: "/repos/foo", host: "h" });
  });

  it("parses the two escape hatches", () => {
    expect(parseServerModeArgs(["--no-backup", "--force"])).toMatchObject({ backup: false, force: true });
  });

  // Undeclared is its own answer, distinct from --no-tls: it means "inherit the ambient
  // BEADS_DOLT_SERVER_TLS", which is what a board configured before this flag existed relies on.
  it("parses the transport as declared, not-declared, or explicitly plaintext", () => {
    expect(parseServerModeArgs(["--tls"]).tls).toBe(true);
    expect(parseServerModeArgs(["--no-tls"]).tls).toBe(false);
    expect(parseServerModeArgs([]).tls).toBeUndefined();
    // Neither form is mistaken for the repo path or an unknown flag.
    expect(parseServerModeArgs(["/repos/foo", "--no-tls"])).toMatchObject({ path: "/repos/foo", tls: false, unknown: [] });
  });

  // Two repo paths is an ambiguous target: silently taking the first would rewrite and verify one
  // board's connection while the operator named two (PR #174 review).
  it("collects extra positional paths instead of discarding them", () => {
    expect(parseServerModeArgs(["/repos/a", "/repos/b", "--host", "h"])).toMatchObject({
      path: "/repos/a",
      extra: ["/repos/b"],
    });
    expect(parseServerModeArgs(["/repos/a", "--host", "h", "/repos/b", "/repos/c"]).extra).toEqual(["/repos/b", "/repos/c"]);
    // A flag's own value is still its value, never an extra path.
    expect(parseServerModeArgs(["/repos/a", "--host", "h", "--db", "d"]).extra).toEqual([]);
  });

  // A typo must not read as "use what the repo already has" — that is how a verified switch lands
  // on the wrong server (PR #174 review).
  it("collects unknown flags instead of ignoring them", () => {
    expect(parseServerModeArgs(["/repos/foo", "--hots", "new-host", "--database", "d"])).toMatchObject({
      unknown: ["--hots"],
      host: null,
      database: "d",
    });
    expect(parseServerModeArgs(["--hots=new-host"])).toMatchObject({ unknown: ["--hots"] });
    expect(parseServerModeArgs(["-h"])).toMatchObject({ unknown: ["-h"] });
  });

  // Same failure as a typo, by a different route: a value flag left empty reads as "omitted", and
  // an omitted field falls back to the repo's existing metadata — a verified switch to the wrong
  // target (PR #174 review).
  it("collects a value flag left without a value instead of reading it as omitted", () => {
    expect(parseServerModeArgs(["/repos/foo", "--database"])).toMatchObject({
      missing: ["--database"],
      database: null,
      path: "/repos/foo",
    });
    expect(parseServerModeArgs(["--host="])).toMatchObject({ missing: ["--host"], host: null });
    // The token behind it is a flag, not its value: both are read on their own terms.
    expect(parseServerModeArgs(["--host", "--port", "3307"])).toMatchObject({
      missing: ["--host"],
      host: null,
      port: "3307",
    });
  });
});

describe("anton server-mode (end to end over a stub bd)", () => {
  it("is listed in --help with its flags", () => {
    const r = spawnSync("node", [CLI, "--help"], { encoding: "utf8" });
    expect(r.stdout).toContain("server-mode");
    expect(r.stdout).toContain("--database");
  });

  it("writes the connection and exits 0 when the board reads back whole", async () => {
    const p = await project();
    const r = p.run(CONNECT);

    expect(r.status).toBe(0);
    expect(p.metadata()).toMatchObject({
      dolt_mode: "server",
      dolt_server_host: "dolt.example.dev",
      dolt_server_port: 3306,
      dolt_server_user: "beads",
      dolt_database: "probe",
      project_id: "abc-123",
    });
    expect(r.stdout).toContain("server mode configured");
  });

  // The transport has to travel in the project's own metadata: `BEADS_DOLT_SERVER_TLS` is one value
  // for every board this anton drives (PR #174 review).
  it("writes the transport --tls declares into this project's metadata", async () => {
    const p = await project();
    const r = p.run([...CONNECT, "--tls"]);

    expect(r.status).toBe(0);
    expect(p.metadata().dolt_server_tls).toBe(true);
    expect(r.stdout).toContain("over TLS");
  });

  it("refuses a misspelled flag rather than falling back on the repo's existing connection", async () => {
    const p = await project();
    const before = p.raw();

    const r = p.run(["--hots", "dolt.example.dev", "--database", "probe"]);

    expect(r.status).toBe(1);
    expect(r.stdout).toContain("unknown flag --hots");
    expect(p.raw()).toBe(before);
  });

  it("refuses a value flag with no value rather than silently reusing the repo's own connection", async () => {
    const p = await project();
    const before = p.raw();

    const r = p.run(["--host", "dolt.example.dev", "--database"]);

    expect(r.status).toBe(1);
    expect(r.stdout).toContain("missing value for --database");
    expect(p.raw()).toBe(before);
  });

  it("refuses a second repo path rather than configuring the first of two", async () => {
    const p = await project();
    const before = p.raw();

    // `p.run` already passes the repo dir, so this adds a second bare token.
    const r = p.run(["/repos/elsewhere", ...CONNECT]);

    expect(r.status).toBe(1);
    expect(r.stdout).toContain("unexpected argument /repos/elsewhere");
    expect(p.raw()).toBe(before);
  });

  it("exits non-zero and leaves the board alone when the server is unreachable", async () => {
    const p = await project({ ".fake-unreachable": "1" });
    const before = p.raw();

    const r = p.run(CONNECT);

    expect(r.status).toBe(1);
    expect(p.raw()).toBe(before);
    expect(r.stdout).toContain("NOT switched to server mode");
  });

  it("exits non-zero and points at the runbook when the server's board is missing issues", async () => {
    const p = await project({ ".fake-board": "probe-1,probe-2,probe-3|probe-4,probe-5,probe-6" });
    const before = p.raw();

    const r = p.run(CONNECT);

    expect(r.status).toBe(1);
    expect(p.raw()).toBe(before);
    expect(r.stdout).toContain("has not been copied onto the server yet");
    expect(r.stdout).toContain("embedded-board-to-shared-dolt-server");
  });
});
