/**
 * The two team-config profiles config.mjs enforces (anton-4gd2): the embedded default, and the
 * shared-server board whose config is a CONNECTION rather than the refs/dolt/data knobs.
 *
 * The embedded assertions are the point of the ticket, not padding — server mode is opt-in, so the
 * default must be provably byte-for-byte what it was. Everything here runs against stubbed `bd`
 * execs and temp directories: `bd dolt set` refuses to run in embedded mode and would otherwise
 * need a live server, and a unit test must not depend on either.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import {
  EMBEDDED_CONFIG_KEYS,
  MIN_BD_VERSION,
  PROJECT_SCOPED_BD_ENV,
  SERVER_CONFIG_KEYS,
  beadsPrereqs,
  checkSharedServer,
  configYamlHas,
  configYamlValue,
  configureBeadsDoltSync,
  configureBeadsForRepo,
  ensureDoltConnection,
  formatServerTarget,
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
    const dir = repo(
      JSON.stringify({
        dolt_mode: "server",
        dolt_server_host: 42,
        dolt_server_port: true,
        dolt_server_user: 7,
        dolt_database: [],
      }),
    );
    expect(readDoltMetadata(dir)).toEqual({
      mode: "server",
      host: undefined,
      port: undefined,
      user: undefined,
      database: undefined,
      tls: undefined,
    });
  });

  /**
   * bd writes metadata.json too, and `bd dolt set port <n> --update-config` re-serializes the port
   * as a STRING (server-mode.test.ts models exactly that rewrite). A number-only parse would lose
   * the port of every board bd has published: `anton init` reports it missing, preflight names the
   * target `host:?`, and the per-server password variable is looked up under a port-less name
   * nobody set (PR #174 review).
   */
  it("accepts bd's string-encoded port", () => {
    const dir = repo(JSON.stringify({ ...SERVER_METADATA, dolt_server_port: "3306" }));
    expect(readDoltMetadata(dir).port).toBe(3306);
  });

  // Forgiving the encoding must not forgive a value that is not a port: bd dialing a nonsense port
  // is the same outage as bd dialing port 0, and "missing" at least names the fix.
  it.each([
    ["a non-numeric string", "3306x"],
    ["an empty string", ""],
    ["a float", 3306.5],
    ["zero", 0],
    ["out of range", 70000],
  ])("drops %s as a port", (_label, written) => {
    const dir = repo(JSON.stringify({ ...SERVER_METADATA, dolt_server_port: written }));
    expect(readDoltMetadata(dir).port).toBeUndefined();
  });

  // Transport is per project (PR #174 review): declared either way it is read back, and left out it
  // stays undefined — which is what `bd-env.ts` reads as "inherit the ambient BEADS_DOLT_SERVER_TLS".
  it.each([
    ["true", true, true],
    ["false", false, false],
    ["a non-boolean", "yes", undefined],
  ])("reads dolt_server_tls: %s as %s", (_label, written, expected) => {
    const dir = repo(JSON.stringify({ ...SERVER_METADATA, dolt_server_tls: written }));
    expect(readDoltMetadata(dir).tls).toBe(expected);
  });

  it("leaves tls undefined when the project declares none", () => {
    expect(readDoltMetadata(repo(JSON.stringify(SERVER_METADATA))).tls).toBeUndefined();
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
    expect(teamConfigKeys("server")).toEqual([
      ["backup.enabled", "false"],
      ["dolt.auto-commit", "on"],
    ]);
    expect(teamConfigKeys("server")).toBe(SERVER_CONFIG_KEYS);
  });

  // bd's auto-backup registers its backup remote ON the shared server as the project's account,
  // which is not privileged for it — so left on it fails on every single write (anton-0tul).
  it("pins bd's auto-backup off in server mode, first, and leaves embedded alone", () => {
    expect(teamConfigKeys("server")[0]).toEqual(["backup.enabled", "false"]);
    expect(teamConfigKeys("embedded").map(([key]: string[]) => key)).not.toContain("backup.enabled");
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

  /**
   * An optional field dropped from metadata.json must be dropped from config.yaml too (PR #174
   * review). Left standing, bd falls back to that lower-priority value and connects as the old
   * account, while anton — reading metadata.json — scopes the spawn's credentials as if no user
   * were configured: the bd call authenticates as the wrong account, or not at all.
   */
  describe("an optional field metadata.json no longer declares", () => {
    const noUser = JSON.stringify({ ...SERVER_METADATA, dolt_server_user: undefined });
    const published = { host: "dolt.example.dev", port: 3306, database: "anton" };

    it.each([
      ["the flat encoding", "dolt.host: dolt.example.dev\ndolt.port: 3306\ndolt.database: anton\ndolt.user: beads\n"],
      ["the nested map bd writes since 1.1.0", "dolt:\n    host: dolt.example.dev\n    port: 3306\n    database: anton\n    user: beads\n"],
    ])("is retracted from config.yaml in %s", (_label, configYaml) => {
      const dir = repo(noUser, configYaml);
      const { calls, exec } = recordingExec();

      const steps = ensureDoltConnection(dir, join(dir, ".beads"), published, { exec });

      expect(calls).toEqual([["bd", "config", "unset", "dolt.user"]]);
      const retracted = steps[steps.length - 1];
      expect(retracted).toMatchObject({ name: "dolt.user", status: "cleared" });
      expect(retracted.detail).toContain("beads");
      // The stale line is struck out, not deleted, and the rest of the connection is untouched.
      const text = readFileSync(join(dir, ".beads", "config.yaml"), "utf8");
      expect(text).toContain("# ");
      expect(text).not.toMatch(/^\s*(dolt\.)?user: beads/m);
      expect(configYamlHas(join(dir, ".beads"), "dolt.host", "dolt.example.dev")).toBe(true);
    });

    // bd reports success even when it rewrote nothing, so the verdict comes from the file — which
    // also means a bd that refuses outright still ends with config.yaml corrected.
    it("is retracted even when bd's own unset fails", () => {
      const dir = repo(noUser, "dolt:\n    user: beads\n");
      const { exec } = recordingExec({ status: 1, stderr: "no such key" });

      const steps = ensureDoltConnection(dir, join(dir, ".beads"), published, { exec });

      expect(steps[steps.length - 1]).toMatchObject({ name: "dolt.user", status: "cleared" });
      expect(configYamlValue(join(dir, ".beads"), "dolt.user")).toBeUndefined();
    });

    it("stays a silent no-op when config.yaml publishes nothing for it", () => {
      const dir = repo(noUser, "dolt.host: dolt.example.dev\n");
      const { calls, exec } = recordingExec();

      const steps = ensureDoltConnection(dir, join(dir, ".beads"), published, { exec });

      expect(calls).not.toContainEqual(["bd", "config", "unset", "dolt.user"]);
      expect(steps[steps.length - 1]).toEqual({ name: "dolt.user", status: "unset" });
    });

    /**
     * Fail loud rather than leave a wrong account published: a config.yaml the strike-out cannot be
     * written to is reported with the line to remove by hand, and it fails the run like any other
     * unpublishable key. The failure comes from the WRITE, not from re-parsing the file afterwards
     * (PR #174 review) — and because the write is atomic, the file the retraction could not change
     * still holds every setting it held, rather than the truncation a half-finished write leaves.
     * Skipped as root, which ignores the permission bits this fails the write with.
     */
    it.skipIf(process.getuid?.() === 0)("reports a value it cannot remove instead of claiming it is gone", () => {
      const original = "dolt:\n    user: beads\n    host: dolt.example.dev\n";
      const dir = repo(noUser, original);
      const beadsDir = join(dir, ".beads");
      chmodSync(beadsDir, 0o555);
      try {
        const steps = ensureDoltConnection(dir, beadsDir, published, { exec: recordingExec().exec });

        const left = steps[steps.length - 1];
        expect(left).toMatchObject({ name: "dolt.user", status: "failed" });
        expect(left.detail).toContain("dolt.user");
        expect(left.detail).toContain("by hand");
        // Intact, not truncated: the rest of the connection survives the failed retraction.
        expect(readFileSync(join(beadsDir, "config.yaml"), "utf8")).toBe(original);
      } finally {
        chmodSync(beadsDir, 0o755);
      }
    });
  });
});

/**
 * Publishing the connection is FATAL, not advisory (PR #174 review). config.yaml is what a teammate's
 * clone inherits: unpublished, it either names no server or still names an earlier one, so reporting
 * `configured: true` is `anton init` exiting 0 — printing that team config was enforced — over a
 * board the next clone cannot reach, or reaches in the wrong place.
 */
describe("configureBeadsForRepo — a server connection that cannot be published fails the run", () => {
  let savedPath: string | undefined;

  beforeEach(() => {
    savedPath = process.env.PATH;
  });

  afterEach(() => {
    if (savedPath === undefined) delete process.env.PATH;
    else process.env.PATH = savedPath;
  });

  /** A stub `bd` first on PATH: answers the version gate and the server probe, `dolt set` per `publish`. */
  function stubBd(publish: { status: number; stderr?: string }) {
    const bin = mkdtempSync(join(tmpdir(), "anton-publish-bin-"));
    dirs.push(bin);
    const script = [
      "#!/usr/bin/env node",
      "const a = process.argv.slice(2);",
      `if (a[0] === "--version" || a[0] === "--help") { console.log("bd version ${MIN_BD_VERSION} (stub)"); process.exit(0); }`,
      `if (a[0] === "dolt" && a[1] === "set") { console.error(${JSON.stringify(publish.stderr ?? "")}); process.exit(${publish.status}); }`,
      "process.exit(0);",
    ].join("\n");
    writeFileSync(join(bin, "bd"), `${script}\n`);
    chmodSync(join(bin, "bd"), 0o755);
    process.env.PATH = `${bin}${delimiter}${savedPath ?? ""}`;
  }

  /** A git repo whose board is already declared to live on a shared server. */
  function serverRepo(): string {
    const dir = mkdtempSync(join(tmpdir(), "anton-publish-"));
    dirs.push(dir);
    spawnSync("git", ["-C", dir, "init"], { stdio: "ignore" });
    mkdirSync(join(dir, ".beads"), { recursive: true });
    writeFileSync(join(dir, ".beads", "metadata.json"), JSON.stringify(SERVER_METADATA));
    writeFileSync(join(dir, ".beads", "config.yaml"), "# empty\n");
    return dir;
  }

  it("reports configured: false, naming what bd said", () => {
    const dir = serverRepo();
    stubBd({ status: 1, stderr: "Access denied for user 'beads'" });

    const result = configureBeadsForRepo(dir, { log: () => {} });

    expect(result.configured).toBe(false);
    expect(result.skipped).toBe(false);
    expect(result.mode).toBe("server");
    expect(result.errors.join("\n")).toContain("Access denied");
    // It stops there: everything after this point drives bd against a database this project has
    // just proved it cannot address.
    expect(result.steps.map((s: { name: string }) => s.name)).not.toContain(".beads/.gitignore");
  });

  it("still reports configured: true when the connection lands", () => {
    const dir = serverRepo();
    stubBd({ status: 0 });

    const result = configureBeadsForRepo(dir, { log: () => {} });

    expect(result.configured).toBe(true);
    expect(result.errors).toEqual([]);
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

/**
 * The preflight (anton-eg46). Server mode is a hard dependency on a reachable server — there is no
 * local copy to fall back on — so `beadsPrereqs` must refuse the bootstrap with the target named,
 * rather than letting bd fail later with `unreachable at 127.0.0.1:0 … dolt is not installed`.
 *
 * Run against a real stub `bd` first on PATH over a real (origin-less) git repo, not an injected
 * exec: what is under test includes WHICH bd command is spawned and whether one is spawned at all.
 */
describe("beadsPrereqs — the mode decides what must be reachable (anton-eg46)", () => {
  let prevPath: string | undefined;

  beforeEach(() => {
    prevPath = process.env.PATH;
  });

  afterEach(() => {
    if (prevPath === undefined) delete process.env.PATH;
    else process.env.PATH = prevPath;
  });

  /** A git repo (no `origin`) whose `.beads/metadata.json` declares `metadata`. */
  function gitRepo(metadata?: Record<string, unknown>): string {
    const dir = repo(metadata === undefined ? undefined : JSON.stringify(metadata));
    spawnSync("git", ["-C", dir, "init"], { stdio: "ignore" });
    return dir;
  }

  /**
   * A stub `bd` first on PATH that answers the version gate, logs every invocation, and fails
   * `dolt test` when `unreachable` — the one failure this preflight exists to catch.
   */
  function stubBd({ unreachable }: { unreachable: boolean }) {
    const bin = mkdtempSync(join(tmpdir(), "anton-modes-bin-"));
    dirs.push(bin);
    const log = join(bin, "calls.log");
    const script = [
      "#!/usr/bin/env node",
      'const fs = require("node:fs");',
      "const a = process.argv.slice(2);",
      `fs.appendFileSync(${JSON.stringify(log)}, a.join(" ") + "\\n");`,
      `if (a[0] === "--version" || a[0] === "--help") { console.log("bd version ${MIN_BD_VERSION} (stub)"); process.exit(0); }`,
      ...(unreachable
        ? ['if (a[0] === "dolt" && a[1] === "test") { console.error("dial tcp 10.0.0.9:3306: connect: connection refused"); process.exit(1); }']
        : []),
      "process.exit(0);",
    ].join("\n");
    writeFileSync(join(bin, "bd"), `${script}\n`);
    chmodSync(join(bin, "bd"), 0o755);
    process.env.PATH = `${bin}${delimiter}${prevPath ?? ""}`;
    return {
      calls: () => {
        try {
          return readFileSync(log, "utf8").split("\n").filter(Boolean);
        } catch {
          return [];
        }
      },
    };
  }

  it("refuses a server-mode board whose server is unreachable, naming the target and both ways out", () => {
    const dir = gitRepo(SERVER_METADATA);
    stubBd({ unreachable: true });

    const { ok, error } = beadsPrereqs(dir);

    expect(ok).toBe(false);
    // The target the project configured, and why it failed — the raw bd error names neither.
    expect(error?.message).toContain("dolt.example.dev:3306/anton");
    expect(error?.message).toContain("connection refused");
    // Both ways out: reach the server (with the per-USER password variable, anton-ffmw.1), or fall
    // back to this machine's local copy.
    expect(error?.fix).toContain("BEADS_DOLT_PASSWORD_BEADS");
    expect(error?.fix).toContain('"dolt_mode": "embedded"');
    expect(error?.fix).toContain("metadata.json");
  });

  it("passes a server-mode board whose server answers — and never asks it for a git origin", () => {
    const dir = gitRepo(SERVER_METADATA);
    const bd = stubBd({ unreachable: false });

    // No `origin` was added: refs/dolt/data is the embedded profile's channel, and demanding it
    // here would fail a healthy server board for a channel it does not use.
    expect(beadsPrereqs(dir)).toEqual({ ok: true });
    expect(bd.calls()).toContain("dolt test");
  });

  it("leaves the embedded preflight exactly as it was: origin still required, server never probed", () => {
    const dir = gitRepo({ dolt_mode: "embedded", dolt_database: "anton" });
    const bd = stubBd({ unreachable: false });

    const { ok, error } = beadsPrereqs(dir);

    expect(ok).toBe(false);
    expect(error?.message).toMatch(/no "origin" remote/);
    expect(bd.calls()).not.toContain("dolt test");
  });

  it("passes an embedded board with an origin, still without probing any server", () => {
    const dir = gitRepo({ dolt_mode: "embedded" });
    spawnSync("git", ["-C", dir, "remote", "add", "origin", join(dir, "origin.git")], { stdio: "ignore" });
    const bd = stubBd({ unreachable: false });

    expect(beadsPrereqs(dir)).toEqual({ ok: true });
    expect(bd.calls()).not.toContain("dolt test");
  });

  /**
   * The preflight is part of the run, not a step in front of it: `configureBeadsForRepo` documents
   * `opts.exec` as replacing every bd spawn, so a probe that reached the host CLI anyway would fail
   * an injected-executor caller before its executor was ever used (PR #174 review).
   */
  it("routes configureBeadsForRepo's preflight through the caller's injected exec, not the host bd", () => {
    const dir = gitRepo(SERVER_METADATA);
    const bd = stubBd({ unreachable: true });
    const { calls, exec } = recordingExec();

    const result = configureBeadsForRepo(dir, { exec, log: () => {} });

    expect(result.skipped).toBe(false);
    expect(calls).toContainEqual(["bd", "dolt", "test"]);
    expect(bd.calls()).not.toContain("dolt test");
  });
});

describe("formatServerTarget", () => {
  it("renders host:port/database as an operator reads it", () => {
    expect(formatServerTarget({ host: "dolt.example.dev", port: 3306, database: "anton" })).toBe(
      "dolt.example.dev:3306/anton",
    );
  });

  // An undeclared field is itself a cause (bd dials port 0 without one), so it is shown, not hidden.
  it("marks what the project never declared instead of quietly dropping it", () => {
    expect(formatServerTarget({ port: 3306 })).toBe("?:3306");
    expect(formatServerTarget({})).toBe("?:?");
  });
});

describe("checkSharedServer", () => {
  it("probes with `bd dolt test` and reports the failure output an operator must act on", () => {
    const dir = repo(JSON.stringify(SERVER_METADATA));
    const { calls, exec } = recordingExec({ status: 1, stderr: "Access denied for user 'beads'" });

    expect(checkSharedServer(dir, { user: "beads" }, { exec })).toEqual({
      ok: false,
      detail: "Access denied for user 'beads'",
    });
    expect(calls).toEqual([["bd", "dolt", "test"]]);
  });

  it("reports ok when the server answers", () => {
    const dir = repo(JSON.stringify(SERVER_METADATA));
    const { exec } = recordingExec();
    expect(checkSharedServer(dir, {}, { exec })).toEqual({ ok: true });
  });
});

/**
 * The environment half of anton-ffmw.1. anton is one process configuring many projects' boards, and
 * bd reads `env > metadata.json > config.yaml` — so an ambient `BEADS_DOLT_*` (a launch directory's
 * .envrc, exported for project A) silently outranks the target project's own metadata.json. Every bd
 * `configureBeadsForRepo` spawns must therefore run with project identity stripped and the password
 * narrowed to THIS project's account.
 *
 * Run against a real stub `bd` first on PATH, because what is under test is the environment a real
 * spawn receives — an injected exec would prove nothing about it.
 */
describe("configureBeadsForRepo scopes every bd spawn to the target project (anton-ffmw.1)", () => {
  const AMBIENT = {
    // Project A's identity, as an .envrc would export it — none of it may reach project B's bd.
    BEADS_DOLT_SERVER_MODE: "1",
    BEADS_DOLT_SERVER_HOST: "a.example.dev",
    BEADS_DOLT_SERVER_DATABASE: "project_a",
    BEADS_DOLT_PASSWORD: "project-a-secret",
  };
  const TOUCHED = [...Object.keys(AMBIENT), "BEADS_DOLT_PASSWORD_BEADS", "PATH"];
  let saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    saved = Object.fromEntries(TOUCHED.map((k) => [k, process.env[k]]));
    Object.assign(process.env, AMBIENT);
  });

  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  type Call = { args: string[]; env: Record<string, string> };

  /**
   * A stub `bd` first on PATH that records every invocation's argv AND its `BEADS_DOLT_*` environment,
   * answers the version gate and the server probe, and creates the `.beads/` workspace on `init` the
   * way real bd does (the steps after init write into it).
   */
  function stubBd() {
    const bin = mkdtempSync(join(tmpdir(), "anton-scope-bin-"));
    dirs.push(bin);
    const log = join(bin, "calls.jsonl");
    const script = [
      "#!/usr/bin/env node",
      'const fs = require("node:fs");',
      'const path = require("node:path");',
      "const a = process.argv.slice(2);",
      'const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => k.startsWith("BEADS_DOLT_")));',
      `fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ args: a, env }) + "\\n");`,
      `if (a[0] === "--version" || a[0] === "--help") { console.log("bd version ${MIN_BD_VERSION} (stub)"); process.exit(0); }`,
      'if (a[0] === "init") { fs.mkdirSync(path.join(process.cwd(), ".beads"), { recursive: true }); fs.writeFileSync(path.join(process.cwd(), ".beads", "config.yaml"), "# stub\\n"); }',
      "process.exit(0);",
    ].join("\n");
    writeFileSync(join(bin, "bd"), `${script}\n`);
    chmodSync(join(bin, "bd"), 0o755);
    process.env.PATH = `${bin}${delimiter}${saved.PATH ?? ""}`;
    return {
      calls: (): Call[] => {
        try {
          return readFileSync(log, "utf8")
            .split("\n")
            .filter(Boolean)
            .map((line) => JSON.parse(line) as Call);
        } catch {
          return [];
        }
      },
    };
  }

  /** A git repo at `dir`, optionally with `.beads/metadata.json` and an `origin`. */
  function gitRepo({ metadata, origin }: { metadata?: Record<string, unknown>; origin?: boolean } = {}): string {
    const dir = mkdtempSync(join(tmpdir(), "anton-scope-"));
    dirs.push(dir);
    spawnSync("git", ["-C", dir, "init"], { stdio: "ignore" });
    if (metadata) {
      mkdirSync(join(dir, ".beads"), { recursive: true });
      writeFileSync(join(dir, ".beads", "metadata.json"), JSON.stringify(metadata));
      writeFileSync(join(dir, ".beads", "config.yaml"), "# empty\n");
    }
    if (origin) spawnSync("git", ["-C", dir, "remote", "add", "origin", join(dir, "origin.git")], { stdio: "ignore" });
    return dir;
  }

  /** `bd --version` opens no database, so the prereq probe is the one spawn identity cannot reach. */
  const boardCalls = (calls: Call[]) => calls.filter((c) => c.args[0] !== "--version");

  it("strips project identity from bd init — a new board is created where metadata.json says, not where the shell does", () => {
    const dir = gitRepo({ origin: true });
    const bd = stubBd();

    configureBeadsForRepo(dir, { log: () => {} });

    const calls = boardCalls(bd.calls());
    expect(calls.map((c) => c.args[0])).toContain("init");
    for (const call of calls) {
      expect(Object.keys(call.env).filter((k) => PROJECT_SCOPED_BD_ENV.includes(k))).toEqual([]);
      // Credentials are NOT stripped: a single shared account is still a valid deployment, and a bd
      // that cannot authenticate is a different (and worse) failure than one pointed at project A.
      expect(call.env.BEADS_DOLT_PASSWORD).toBe("project-a-secret");
    }
  });

  it("hands a server-mode board its own account's password, not the ambient one", () => {
    const dir = gitRepo({ metadata: SERVER_METADATA });
    process.env.BEADS_DOLT_PASSWORD_BEADS = "project-b-secret";
    const bd = stubBd();

    configureBeadsForRepo(dir, { log: () => {} });

    const calls = boardCalls(bd.calls());
    // The connection publish is the call that must authenticate as this project's user.
    expect(calls.some((c) => c.args[0] === "dolt" && c.args[1] === "set")).toBe(true);
    expect(calls.some((c) => c.args[0] === "config" && c.args[1] === "set")).toBe(true);
    for (const call of calls) {
      expect(call.env.BEADS_DOLT_PASSWORD).toBe("project-b-secret");
      expect(call.env.BEADS_DOLT_SERVER_DATABASE).toBeUndefined();
      expect(call.env.BEADS_DOLT_SERVER_HOST).toBeUndefined();
    }
  });

  // A caller that supplies `opts.env` supplies it for the WHOLE run. When the board's password lives
  // only there, a preflight probing under `process.env` would report a healthy server unreachable.
  it("scopes the preflight probe from opts.env too, not from the ambient process environment", () => {
    const dir = gitRepo({ metadata: SERVER_METADATA });
    const bd = stubBd();

    configureBeadsForRepo(dir, {
      log: () => {},
      env: { ...process.env, BEADS_DOLT_PASSWORD_BEADS: "from-opts-env" },
    });

    const probe = boardCalls(bd.calls()).find((c) => c.args[0] === "dolt" && c.args[1] === "test");
    expect(probe?.env.BEADS_DOLT_PASSWORD).toBe("from-opts-env");
  });
});
