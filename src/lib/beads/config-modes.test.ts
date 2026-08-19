/**
 * The two team-config profiles config.mjs enforces (anton-4gd2): the embedded default, and the
 * shared-server board whose config is a CONNECTION rather than the refs/dolt/data knobs.
 *
 * The embedded assertions are the point of the ticket, not padding — server mode is opt-in, so the
 * default must be provably byte-for-byte what it was. Everything here runs against stubbed `bd`
 * execs and temp directories: `bd dolt set` refuses to run in embedded mode and would otherwise
 * need a live server, and a unit test must not depend on either.
 */
import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  EMBEDDED_CONFIG_KEYS,
  SERVER_CONFIG_KEYS,
  configureBeadsDoltSync,
  ensureDoltConnection,
  readDoltMetadata,
  teamConfigKeys,
} from "./config.mjs";

const SERVER_METADATA = {
  dolt_mode: "server",
  dolt_server_host: "dolt.example.dev",
  dolt_server_port: 3306,
  dolt_server_user: "beads",
  dolt_database: "anton",
};

const dirs: string[] = [];

/** A repo dir with `.beads/` holding the given metadata.json (raw string) and config.yaml. */
function repo(metadata?: string, configYaml?: string): string {
  const dir = mkdtempSync(join(tmpdir(), "anton-modes-"));
  dirs.push(dir);
  mkdirSync(join(dir, ".beads"), { recursive: true });
  if (metadata !== undefined) writeFileSync(join(dir, ".beads", "metadata.json"), metadata);
  if (configYaml !== undefined) writeFileSync(join(dir, ".beads", "config.yaml"), configYaml);
  return dir;
}

/** Records every command config.mjs would have spawned, and answers with a fixed result. */
function recordingExec(result: { status: number | null; stdout?: string; stderr?: string } = { status: 0 }) {
  const calls: string[][] = [];
  const exec = (cmd: string, args: string[]) => {
    calls.push([cmd, ...args]);
    return result;
  };
  return { calls, exec };
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("readDoltMetadata", () => {
  it("reads server mode and its connection from metadata.json", () => {
    expect(readDoltMetadata(repo(JSON.stringify(SERVER_METADATA)))).toEqual({
      mode: "server",
      host: "dolt.example.dev",
      port: 3306,
      user: "beads",
      database: "anton",
    });
  });

  // Degrading to embedded is the safe direction: embedded merely syncs when it need not, whereas a
  // wrong "server" verdict would silently disable a solo board's only propagation path.
  it.each([
    ["an explicitly embedded board", JSON.stringify({ dolt_mode: "embedded", dolt_database: "anton" })],
    ["metadata with no dolt_mode", JSON.stringify({ database: "dolt" })],
    ["an unrecognised mode", JSON.stringify({ dolt_mode: "sideways" })],
    ["malformed JSON", "{ not json"],
    ["no metadata.json at all", undefined],
  ])("reports embedded for %s, carrying no connection", (_label, metadata) => {
    expect(readDoltMetadata(repo(metadata))).toEqual({ mode: "embedded" });
  });

  it("drops connection fields of the wrong type rather than passing them through", () => {
    const dir = repo(JSON.stringify({ dolt_mode: "server", dolt_server_host: 42, dolt_server_port: "3306" }));
    expect(readDoltMetadata(dir)).toEqual({
      mode: "server",
      host: undefined,
      port: undefined,
      user: undefined,
      database: undefined,
    });
  });
});

describe("teamConfigKeys", () => {
  it("keeps the embedded profile exactly as it was — the default is unchanged", () => {
    expect(teamConfigKeys("embedded")).toEqual([
      ["export.auto", "false"],
      ["dolt.auto-commit", "on"],
      ["export.git-add", "false"],
      ["dolt.auto-push", "false"],
    ]);
    // export.auto stays FIRST: `bd config set` is itself a bd command, so leaving auto-export on
    // while the later keys are written regenerates the very JSONL churn the profile exists to stop.
    expect(teamConfigKeys("embedded")[0]?.[0]).toBe("export.auto");
    expect(teamConfigKeys("embedded")).toBe(EMBEDDED_CONFIG_KEYS);
  });

  it("falls back to the embedded profile for an unknown or absent mode", () => {
    expect(teamConfigKeys(undefined)).toBe(EMBEDDED_CONFIG_KEYS);
    expect(teamConfigKeys("sideways")).toBe(EMBEDDED_CONFIG_KEYS);
  });

  it("drops the refs/dolt/data-only knobs in server mode, keeping the Dolt commit knob", () => {
    const keys = teamConfigKeys("server").map(([key]: string[]) => key);
    expect(keys).not.toContain("dolt.auto-push");
    expect(keys.filter((k: string) => k.startsWith("export."))).toEqual([]);
    expect(teamConfigKeys("server")).toEqual([["dolt.auto-commit", "on"]]);
    expect(teamConfigKeys("server")).toBe(SERVER_CONFIG_KEYS);
  });
});

describe("ensureDoltConnection (server profile)", () => {
  const info = { host: "dolt.example.dev", port: 3306, user: "beads", database: "anton" };

  it("publishes host, port, database and user through bd's own primitive", () => {
    const dir = repo(JSON.stringify(SERVER_METADATA), "# empty\n");
    const { calls, exec } = recordingExec();

    const steps = ensureDoltConnection(dir, join(dir, ".beads"), info, { exec });

    // --update-config is what writes config.yaml (the team-wide default) alongside metadata.json.
    expect(calls).toEqual([
      ["bd", "dolt", "set", "host", "dolt.example.dev", "--update-config"],
      ["bd", "dolt", "set", "port", "3306", "--update-config"],
      ["bd", "dolt", "set", "database", "anton", "--update-config"],
      ["bd", "dolt", "set", "user", "beads", "--update-config"],
    ]);
    expect(steps.map((s: { status: string }) => s.status)).toEqual(["set", "set", "set", "set"]);
  });

  it("is a no-op when config.yaml already carries the connection, in either bd encoding", () => {
    // bd writes the first key flat and the rest under a nested `dolt:` map — both must read as set.
    const dir = repo(
      JSON.stringify(SERVER_METADATA),
      "dolt.host: dolt.example.dev\ndolt:\n    port: 3306\n    user: beads\n    database: anton\n",
    );
    const { calls, exec } = recordingExec();

    const steps = ensureDoltConnection(dir, join(dir, ".beads"), info, { exec });

    expect(calls).toEqual([]);
    expect(steps.map((s: { status: string }) => s.status)).toEqual(["already", "already", "already", "already"]);
  });

  it("re-points a stale connection rather than trusting what config.yaml already says", () => {
    const dir = repo(JSON.stringify(SERVER_METADATA), "dolt.host: old.example.dev\n");
    const { calls, exec } = recordingExec();

    ensureDoltConnection(dir, join(dir, ".beads"), info, { exec });

    expect(calls[0]).toEqual(["bd", "dolt", "set", "host", "dolt.example.dev", "--update-config"]);
  });

  it("reports a required field missing from metadata.json instead of guessing a default", () => {
    const dir = repo(JSON.stringify({ dolt_mode: "server" }), "# empty\n");
    const { calls, exec } = recordingExec();

    const steps = ensureDoltConnection(dir, join(dir, ".beads"), readDoltMetadata(dir), { exec });

    expect(calls).toEqual([]);
    expect(steps.map((s: { name: string; status: string }) => [s.name, s.status])).toEqual([
      ["dolt.host", "missing"],
      ["dolt.port", "missing"],
      ["dolt.database", "missing"],
      // `user` is optional — bd defaults to root, which is a real single-account setup.
      ["dolt.user", "unset"],
    ]);
    expect(steps[0].detail).toContain("metadata.json");
  });

  it("surfaces a failed bd call with its output rather than reporting success", () => {
    const dir = repo(JSON.stringify(SERVER_METADATA), "# empty\n");
    const { exec } = recordingExec({ status: 1, stderr: "not supported in embedded mode" });

    const steps = ensureDoltConnection(dir, join(dir, ".beads"), info, { exec });

    expect(steps[0]).toMatchObject({ status: "failed", detail: "not supported in embedded mode" });
  });
});

describe("configureBeadsDoltSync in server mode", () => {
  it("wires no refs/dolt/data remote — there is nothing to reconcile on a shared server", () => {
    const dir = repo(JSON.stringify(SERVER_METADATA));
    const { calls, exec } = recordingExec();

    expect(configureBeadsDoltSync({ repoDir: dir, exec })).toEqual({ status: "server-mode" });
    // Not one spawn: `bd dolt pull/push` runs ON the server, which cannot reach the git remote.
    expect(calls).toEqual([]);
  });

  it("still wires the remote on an embedded board (the default is untouched)", () => {
    const dir = repo(JSON.stringify({ dolt_mode: "embedded" }));
    const exec = (cmd: string, args: string[]) => {
      if (cmd === "git" && args[0] === "remote") return { status: 0, stdout: "git@example.com:org/repo.git\n" };
      if (cmd === "git" && args[0] === "ls-remote") return { status: 0, stdout: "abc123\trefs/dolt/data\n" };
      if (args[0] === "config") return { status: 0, stdout: "sync.remote (not set in config.yaml)" };
      if (args[1] === "remote" && args[2] === "list") return { status: 0, stdout: "" };
      return { status: 0, stdout: "" };
    };

    expect(configureBeadsDoltSync({ repoDir: dir, exec })).toMatchObject({ status: "configured", pushed: true });
  });
});
