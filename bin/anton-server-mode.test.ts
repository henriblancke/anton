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
 * A stub `bd` for the server-mode flow. `bd count` answers with the contents of `.beads/.fake-count`
 * so a case can make the server's board differ from the local one, and `bd dolt test` fails when
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
  'if (a[0] === "count") {',
  '  const mode = JSON.parse(read("metadata.json", "{}")).dolt_mode;',
  '  const counts = read(".fake-count", "3|3").split("|");',
  '  console.log(JSON.stringify({ count: Number(mode === "server" ? counts[1] : counts[0]) }));',
  "  process.exit(0);",
  "}",
  'if (a[0] === "export") { fs.writeFileSync(a[a.indexOf("-o") + 1], ""); process.exit(0); }',
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

  it("exits non-zero and leaves the board alone when the server is unreachable", async () => {
    const p = await project({ ".fake-unreachable": "1" });
    const before = p.raw();

    const r = p.run(CONNECT);

    expect(r.status).toBe(1);
    expect(p.raw()).toBe(before);
    expect(r.stdout).toContain("NOT switched to server mode");
  });

  it("exits non-zero and points at the runbook when the server's board is missing issues", async () => {
    const p = await project({ ".fake-count": "12|0" });
    const before = p.raw();

    const r = p.run(CONNECT);

    expect(r.status).toBe(1);
    expect(p.raw()).toBe(before);
    expect(r.stdout).toContain("has not been copied onto the server yet");
    expect(r.stdout).toContain("embedded-board-to-shared-dolt-server");
  });
});
