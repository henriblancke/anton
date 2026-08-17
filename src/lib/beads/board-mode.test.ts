/**
 * Board-mode detection and the two behaviours that hang off it (anton-4gd2, anton-0tul,
 * anton-ffmw.1).
 *
 * The embedded-mode assertions are not padding: every change here is gated on mode precisely so
 * that a board WITHOUT a shared server keeps its existing sync behaviour, and these are what hold
 * that line.
 */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runDoltSync } from "./bd";
import { PROJECT_SCOPED_BD_ENV, isServerMode, readBoardMode, resetBoardModeCache } from "./board-mode";

/** Mirrors bd.ts's internal BdExec seam; kept local so the test does not widen that module's API. */
type TestExec = (cwd: string, args: string[]) => Promise<string>;

const dirs: string[] = [];

function repo(metadata: Record<string, unknown> | null): string {
  const dir = mkdtempSync(join(tmpdir(), "board-mode-"));
  dirs.push(dir);
  if (metadata) {
    mkdirSync(join(dir, ".beads"), { recursive: true });
    writeFileSync(join(dir, ".beads", "metadata.json"), JSON.stringify(metadata));
  }
  resetBoardModeCache();
  return dir;
}

afterEach(() => {
  resetBoardModeCache();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("readBoardMode", () => {
  it("reads server mode and its connection details from metadata.json", () => {
    const dir = repo({
      dolt_mode: "server",
      dolt_server_host: "dolt.example.dev",
      dolt_server_port: 3306,
      dolt_database: "anton",
    });
    expect(readBoardMode(dir)).toEqual({
      mode: "server",
      host: "dolt.example.dev",
      port: 3306,
      database: "anton",
    });
  });

  it("reports embedded for an explicitly embedded board", () => {
    expect(readBoardMode(repo({ dolt_mode: "embedded" })).mode).toBe("embedded");
  });

  // Degrading to "embedded" is the safe direction: embedded syncs, and a spurious sync is noise,
  // whereas a wrong "server" verdict would silently disable a solo board's only propagation path.
  it.each([
    ["no .beads directory at all", null],
    ["metadata without dolt_mode", { database: "dolt" } as Record<string, unknown>],
    ["an unrecognised mode", { dolt_mode: "sideways" } as Record<string, unknown>],
  ])("falls back to embedded given %s", (_label, meta) => {
    expect(readBoardMode(repo(meta)).mode).toBe("embedded");
  });

  it("falls back to embedded on malformed JSON rather than throwing", () => {
    const dir = mkdtempSync(join(tmpdir(), "board-mode-"));
    dirs.push(dir);
    mkdirSync(join(dir, ".beads"), { recursive: true });
    writeFileSync(join(dir, ".beads", "metadata.json"), "{ not json");
    resetBoardModeCache();
    expect(() => readBoardMode(dir)).not.toThrow();
    expect(readBoardMode(dir).mode).toBe("embedded");
  });
});

describe("runDoltSync — server mode is a no-op (anton-0tul)", () => {
  it("spawns no bd process and reports shared-server", async () => {
    const dir = repo({ dolt_mode: "server", dolt_server_host: "h", dolt_server_port: 3306 });
    const calls: string[][] = [];
    const exec: TestExec = async (_cwd: string, args: string[]) => {
      calls.push(args);
      return "";
    };
    // The preflight is the one permitted call; it is `dolt test`, never pull/commit/push.
    await expect(runDoltSync(dir, exec, "full")).resolves.toBe("shared-server");
    expect(calls.map((a) => a.join(" "))).not.toContain("dolt pull");
    expect(calls.map((a) => a.join(" "))).not.toContain("dolt push");
  });

  it("still runs the full pull/commit/push in embedded mode", async () => {
    const dir = repo({ dolt_mode: "embedded" });
    const calls: string[][] = [];
    const exec: TestExec = async (_cwd: string, args: string[]) => {
      calls.push(args);
      return "";
    };
    await expect(runDoltSync(dir, exec, "full")).resolves.toBe("synced");
    expect(calls.map((a) => a.join(" "))).toEqual(["dolt pull", "dolt commit", "dolt push"]);
  });

  it("still runs a pull-only pass in embedded mode", async () => {
    const dir = repo({ dolt_mode: "embedded" });
    const calls: string[][] = [];
    const exec: TestExec = async (_cwd: string, args: string[]) => {
      calls.push(args);
      return "";
    };
    await expect(runDoltSync(dir, exec, "pull")).resolves.toBe("synced");
    expect(calls.map((a) => a.join(" "))).toEqual(["dolt pull"]);
  });
});

describe("PROJECT_SCOPED_BD_ENV (anton-ffmw.1)", () => {
  it("covers the vars that select a project's database", () => {
    // These are the ones that routed anton's bd calls at the wrong database. Credentials are
    // deliberately absent: they are shared across projects on a server, and stripping them would
    // leave every spawned bd unable to authenticate.
    expect(PROJECT_SCOPED_BD_ENV).toContain("BEADS_DOLT_SERVER_DATABASE");
    expect(PROJECT_SCOPED_BD_ENV).toContain("BEADS_DOLT_SERVER_HOST");
    expect(PROJECT_SCOPED_BD_ENV).toContain("BEADS_DOLT_SERVER_USER");
    expect(PROJECT_SCOPED_BD_ENV).not.toContain("BEADS_DOLT_PASSWORD");
    expect(PROJECT_SCOPED_BD_ENV).not.toContain("BEADS_DOLT_SERVER_TLS");
  });
});

describe("isServerMode", () => {
  it("is a thin predicate over readBoardMode", () => {
    expect(isServerMode(repo({ dolt_mode: "server" }))).toBe(true);
    expect(isServerMode(repo({ dolt_mode: "embedded" }))).toBe(false);
  });
});
