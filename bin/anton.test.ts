/**
 * Smoke tests for the anton CLI (anton-hji). Only exercises argument dispatch — the paths that
 * don't depend on external tools or a build — so it's deterministic in CI (where bd/gh/stringer
 * aren't installed). setup/start/doctor behavior is covered by the manual run + the prereq logic.
 *
 * This file holds the launcher's own surface: dispatch and flag parsing, `board-check`, and
 * `doctor`. The rest of the CLI is asserted in the sibling suites the file was split into
 * (anton-k7q2) — `anton-init.test.ts`, `anton-skills.test.ts`, `anton-migrations.test.ts`,
 * `anton-release.test.ts` — over the harness they all share, `anton.fixture.ts`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { createServer, type Server } from "node:http";
import { delimiter, dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";

import {
  agentsFromArgs,
  cmdStop,
  daemonState,
  ensureFreshBuild,
  lifecycleVerdict,
  nextArgs,
  procfsListeningEndpoints,
  resolveAntonDb,
  resolvePort,
  runningPid,
  serverPort,
  stoppedFor,
  unstampedServers,
  writePidFile,
} from "./anton.mjs";

import { processStartedAt } from "../src/lib/build/identity.mjs";

import { CLI, REPO_ROOT, run, seedOtherRelease, tempDirs, writeFakeBd } from "./anton.fixture";

describe("anton CLI dispatch", () => {
  it("--help prints usage and exits 0", () => {
    const r = run(["--help"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("anton <command>");
    expect(r.stdout).toContain("setup");
    expect(r.stdout).toContain("init");
    expect(r.stdout).toContain("start");
  });

  it("no command prints usage and exits non-zero", () => {
    const r = run([]);
    expect(r.status).toBe(1);
    expect(r.stdout).toContain("Usage:");
  });

  it("unknown command exits non-zero with an error", () => {
    const r = run(["bogus"]);
    expect(r.status).toBe(1);
    expect(r.stdout).toContain("unknown command: bogus");
  });

  it("--help documents the port override", () => {
    const r = run(["--help"]);
    expect(r.stdout).toContain("--port");
  });
});

describe("port resolution", () => {
  const savedPort = process.env.PORT;
  afterEach(() => {
    if (savedPort === undefined) delete process.env.PORT;
    else process.env.PORT = savedPort;
  });

  it("returns undefined with no flag or PORT env", () => {
    delete process.env.PORT;
    expect(resolvePort([])).toBeUndefined();
    expect(nextArgs("start", [])).toEqual(["start"]);
  });

  it("parses --port <n>, --port=<n>, and -p <n>", () => {
    delete process.env.PORT;
    expect(resolvePort(["--port", "4000"])).toBe("4000");
    expect(resolvePort(["--port=4001"])).toBe("4001");
    expect(resolvePort(["-p", "4002"])).toBe("4002");
    expect(nextArgs("dev", ["-p", "4002"])).toEqual(["dev", "-p", "4002"]);
  });

  it("falls back to PORT env, but an explicit flag wins", () => {
    process.env.PORT = "5000";
    expect(resolvePort([])).toBe("5000");
    expect(resolvePort(["--port", "6000"])).toBe("6000");
    expect(nextArgs("start", [])).toEqual(["start", "-p", "5000"]);
  });
});

/**
 * A relative `ANTON_DB` names a different file for every reader unless one directory settles it
 * (PR #217). The server always runs with the app root as its cwd, so its build record lands beside
 * the app-root-relative database — and doctor invoked from any other directory used to scan the
 * caller's, reporting "no running server recorded" over a live, stale server.
 */
describe("the ANTON_DB override", () => {
  const declared = process.env.ANTON_DB;

  afterEach(() => {
    if (declared === undefined) delete process.env.ANTON_DB;
    else process.env.ANTON_DB = declared;
  });

  it("resolves a relative path against the app root, not the caller's cwd", () => {
    process.env.ANTON_DB = "state/anton.db";
    expect(resolveAntonDb()).toBe(join(REPO_ROOT, "state", "anton.db"));
  });

  it("leaves an absolute path exactly as given", () => {
    process.env.ANTON_DB = join(tmpdir(), "elsewhere.db");
    expect(resolveAntonDb()).toBe(join(tmpdir(), "elsewhere.db"));
  });
});

describe("agentsFromArgs", () => {
  it("returns null when unspecified, [] for --no-agents, csv/all otherwise", () => {
    expect(agentsFromArgs([])).toBeNull();
    expect(agentsFromArgs(["--no-agents"])).toEqual([]);
    expect(agentsFromArgs(["--agents", "nextjs,fastapi"])).toBe("nextjs,fastapi");
    expect(agentsFromArgs(["--agents=all"])).toBe("all");
  });
});

// `anton board-check` against a STUB `bd` on PATH — the same process-boundary seam the init tests
// use. What's under test is the READ, not the tier rules (those are unit-tested off literal boards
// in src/lib/beads/structure.test.ts): which bd invocations the checker survives.
describe("anton board-check (bd stubbed on PATH)", () => {
  const dirs = tempDirs();
  let repo: string;

  /** A `bd` whose `list` serves BOARD, optionally refusing `--status all` the way lean builds do. */
  async function fakeBd(board: unknown[], { rejectsStatusAll = false } = {}): Promise<string> {
    const bin = await dirs.make("anton-bdbin-");
    const open = board.filter((b) => (b as { status?: string }).status !== "closed");
    const closed = board.filter((b) => (b as { status?: string }).status === "closed");
    writeFakeBd(
      bin,
      [
        "#!/usr/bin/env node",
        "const a = process.argv.slice(2);",
        `const open = ${JSON.stringify(JSON.stringify(open))};`,
        `const closed = ${JSON.stringify(JSON.stringify(closed))};`,
        `const all = ${JSON.stringify(JSON.stringify(board))};`,
        'const i = a.indexOf("--status");',
        'const status = i >= 0 ? a[i + 1] : "";',
        `if (status === "all" && ${rejectsStatusAll}) {`,
        '  console.error("unknown value for --status: all");',
        "  process.exit(2);",
        "}",
        'console.log(status === "all" ? all : status === "closed" ? closed : open);',
        "process.exit(0);",
      ].join("\n"),
    );
    return bin;
  }

  function runCheck(bin: string | null, extraEnv: Record<string, string> = {}) {
    return spawnSync(process.execPath, [CLI, "board-check", repo], {
      encoding: "utf8",
      // A PATH holding ONLY the stub (plus node, which the stub's shebang resolves through) — so
      // `bin: null` reproduces "bd is not installed", where spawnSync reports ENOENT on `error` with
      // a null `stderr`.
      env: {
        ...process.env,
        ...extraEnv,
        PATH: [bin, dirname(process.execPath)].filter(Boolean).join(delimiter),
      },
    });
  }

  beforeEach(async () => {
    repo = await dirs.make("anton-boardcheck-");
    mkdirSync(join(repo, ".beads"), { recursive: true });
  });

  afterEach(dirs.cleanup);

  const HEALTHY = [
    { id: "e1", issue_type: "epic", status: "open" },
    { id: "f1", issue_type: "feature", status: "open", parent: "e1" },
    { id: "t1", issue_type: "task", status: "open", parent: "f1" },
    { id: "t2", issue_type: "task", status: "open", parent: "f1" },
  ];
  // A ticket hung straight off a container epic: the dead bead the exit code exists for.
  const STRAY = { id: "stray", issue_type: "task", status: "open", parent: "e1" };

  it("reports a clean board and exits 0", async () => {
    const r = runCheck(await fakeBd(HEALTHY));
    expect(r.stdout).toContain("epic → feature → ticket holds");
    expect(r.status).toBe(0);
  });

  it("exits non-zero on a dead bead", async () => {
    const r = runCheck(await fakeBd([...HEALTHY, STRAY]));
    expect(r.stdout).toContain("stray");
    expect(r.status).toBe(1);
  });

  // Some bd builds reject `--status all`; src/lib/beads/issues.ts already treats that as a supported
  // variation. Without the same fallback here, /shape's mandatory Phase 5 audit failed having
  // checked nothing at all on exactly those installs.
  it("falls back to open + closed when bd rejects --status all", async () => {
    const board = [...HEALTHY, STRAY, { id: "gone", issue_type: "task", status: "closed", parent: "f1" }];
    const r = runCheck(await fakeBd(board, { rejectsStatusAll: true }));
    expect(r.stdout).toContain("stray");
    // The closed bead is read (so container-ness sees the whole graph) but never judged: 5 live of 6.
    expect(r.stdout).toContain("5 live beads");
    expect(r.status).toBe(1);
  });

  // The form rate belongs to `bun scripts/contract-report.ts` alone (anton-5ltn). board-check judges
  // TIERS, and its advisory stream stays that signal: the board carries ~104 beads whose rubric lives
  // only in bd's field, and printing those here would bury the handful of tier faults this command
  // exists to show. One board described two ways — the output may not move.
  it("says nothing about description form, however the beads are written", async () => {
    const SHAPED = [
      "## Goal",
      "Ship it.",
      "## Acceptance Criteria",
      "- [ ] it works",
      "## Context",
      "touches: nothing",
      "## Out of scope",
      "- the other thing",
      "## Verify",
      "- a test covers it",
    ].join("\n");
    // A lone ticket under a feature: an ADVISORY tier fault, so the stream under test is non-empty.
    const board = [
      { id: "e1", issue_type: "epic", status: "open" },
      { id: "f1", issue_type: "feature", status: "open", parent: "e1" },
      { id: "t1", issue_type: "task", status: "open", parent: "f1" },
    ];
    const described = board.map((b) => ({ ...b, description: SHAPED }));
    // The drifted shape: same beads, rubric in bd's field only and no contract sections at all.
    const drifted = board.map((b) => ({ ...b, acceptance_criteria: "- [ ] it works" }));

    const formed = runCheck(await fakeBd(described));
    const bare = runCheck(await fakeBd(drifted));
    expect(formed.stdout).toContain("[feature-under-ticket-budget]");
    expect(bare.stdout).toBe(formed.stdout);
    expect(bare.status).toBe(0);
    expect(formed.status).toBe(0);
  });

  // The ENOENT is on `error`, never on `stderr` — reporting stderr alone printed a bare failure and
  // left a user without bd installed nothing to act on.
  it("says bd is missing rather than failing with an empty reason", () => {
    const r = runCheck(null);
    expect(r.stderr).toContain("bd not found");
    expect(r.status).toBe(1);
  });

  /**
   * board-check's spawn is project-scoped like every other bd anton runs (anton-ffmw.1, PR #174
   * review). It takes MANY repos in one invocation, so an ambient `BEADS_DOLT_*` — a launch
   * directory's `.envrc` exported for some other project — would have each of them listed out of
   * whichever database that names, and a project whose account has its own
   * `BEADS_DOLT_PASSWORD_<USER>` would never receive it and simply fail to authenticate.
   *
   * Asserted against a real stub on PATH, because what is under test is the environment a real
   * spawn receives — an injected exec would prove nothing about it.
   */
  it("strips ambient project identity and delivers the per-user password to its bd", async () => {
    writeFileSync(
      join(repo, ".beads", "metadata.json"),
      JSON.stringify({
        dolt_mode: "server",
        dolt_server_host: "dolt.example.dev",
        dolt_server_port: 3306,
        dolt_server_user: "beads",
        dolt_database: "this-project",
      }),
    );
    const bin = await dirs.make("anton-bdenv-");
    const log = join(bin, "env.json");
    writeFakeBd(
      bin,
      [
        "#!/usr/bin/env node",
        'const fs = require("node:fs");',
        'const seen = Object.fromEntries(Object.entries(process.env).filter(([k]) => k.startsWith("BEADS_DOLT_")));',
        `fs.writeFileSync(${JSON.stringify(log)}, JSON.stringify(seen));`,
        "console.log(JSON.stringify([]));",
        "process.exit(0);",
      ].join("\n"),
    );

    runCheck(bin, {
      // Another project's identity and the shared credential, as an .envrc would export them.
      BEADS_DOLT_SERVER_DATABASE: "someone-elses-board",
      BEADS_DOLT_SERVER_HOST: "elsewhere.example.dev",
      BEADS_DOLT_PASSWORD: "shared-account-secret",
      BEADS_DOLT_PASSWORD_BEADS: "this-projects-secret",
    });

    const seen = JSON.parse(readFileSync(log, "utf8")) as Record<string, string>;
    // Identity is stripped, so THIS repo's metadata.json decides which database is opened.
    expect(seen.BEADS_DOLT_SERVER_DATABASE).toBeUndefined();
    expect(seen.BEADS_DOLT_SERVER_HOST).toBeUndefined();
    // ...and the credential is the one this project's account needs, not the ambient fallback.
    expect(seen.BEADS_DOLT_PASSWORD).toBe("this-projects-secret");
  });
});

// End-to-end via the real command, against the REAL bundled skills: doctor is the only thing that
// sees the user-level ~/.claude shadow copy every plain `claude` session resolves (anton-gsyh), and
// it must report it without ever writing to it.
describe("anton doctor — skill drift", () => {
  const dirs = tempDirs();

  afterEach(dirs.cleanup);

  /** Run `anton doctor` with HOME and cwd pointed at throwaway roots so both scopes are ours. */
  function runDoctor(home: string, cwd: string) {
    return spawnSync(process.execPath, [CLI, "doctor"], {
      encoding: "utf8",
      cwd,
      env: { ...process.env, HOME: home, ANTON_DB: join(home, "anton.db") },
    });
  }

  /** Seed `<root>/.claude/skills/bd/SKILL.md` and return its path. */
  function seedCopy(root: string, write: (dir: string) => void): string {
    const dir = join(root, ".claude", "skills", "bd");
    mkdirSync(dir, { recursive: true });
    write(dir);
    return join(dir, "SKILL.md");
  }

  it("warns on a user-level copy that predates stamps, and does not touch it", async () => {
    const home = await dirs.make("anton-home-");
    const path = seedCopy(home, (dir) => writeFileSync(join(dir, "SKILL.md"), "# the pre-tier copy\n"));

    const r = runDoctor(home, await dirs.make("anton-cwd-"));

    expect(r.stdout).toContain("bd (global)");
    expect(r.stdout).toContain("predates version stamps");
    expect(r.stdout).toContain("--force-skills");
    expect(readFileSync(path, "utf8")).toBe("# the pre-tier copy\n"); // read-only, always
  });

  it("names an untouched copy of another release as refreshable by a plain re-run", async () => {
    const home = await dirs.make("anton-home-");
    const cwd = await dirs.make("anton-cwd-");
    const path = seedCopy(cwd, (dir) => seedOtherRelease(dir, "# an older release\n"));
    const before = readFileSync(path, "utf8");

    const r = runDoctor(home, cwd);

    expect(r.stdout).toContain("bd (project)");
    expect(r.stdout).toContain("another release's copy");
    expect(r.stdout).toContain("anton init");
    expect(readFileSync(path, "utf8")).toBe(before);
  });

  it("says nothing is drifted when no copy is installed at either scope", async () => {
    const r = runDoctor(await dirs.make("anton-home-"), await dirs.make("anton-cwd-"));
    expect(r.stdout).toContain("installed copies match the bundle");
  });
});

/**
 * Whose server the liveness evidence belongs to (anton-pzfb), and which servers a live record is
 * allowed to speak for (PR #217). Both signals are shared across installs — the pidfile sits in the
 * global state dir, and any anton can hold a port — so each mode may read only its own, and a
 * stamped record answers for its own process alone. The end-to-end cases below all run from this
 * source checkout, which is why bundle mode is asserted on the unit here.
 */
describe("anton doctor — servers no record accounts for", () => {
  const answers = () => Promise.resolve(true);
  const silent = () => Promise.resolve(false);
  const listening = (...pids: number[]) => () => pids.map((pid, i) => ({ pid, port: 4000 + i }));

  it("trusts only the daemon pidfile in bundle mode", async () => {
    expect(await unstampedServers({ isBundle: true, pid: () => 42, servers: listening(7), answering: answers })).toEqual([42]);
    // A separate source checkout serving anton's page is not this bundle's stopped daemon.
    expect(await unstampedServers({ isBundle: true, pid: () => null, servers: listening(7), answering: answers })).toEqual([]);
  });

  it("trusts only this checkout's listeners in source mode", async () => {
    expect(await unstampedServers({ isBundle: false, pid: () => 42, servers: listening(7), answering: answers })).toEqual([7]);
    // `anton dev` writes no pidfile, so the one on disk is the installed bundle's.
    expect(await unstampedServers({ isBundle: false, pid: () => 42, servers: listening(7), answering: silent })).toEqual([]);
  });

  // A record proves what ONE process is running. A second, older server — the pre-stamp one an
  // upgrade leaves behind on another port — is exactly what nothing else can see.
  it("keeps the servers a live record already speaks for out of the answer", async () => {
    const livePids = new Set([7]);
    expect(await unstampedServers({ isBundle: false, livePids, servers: listening(7), answering: answers })).toEqual([]);
    expect(await unstampedServers({ isBundle: false, livePids, servers: listening(7, 9), answering: answers })).toEqual([9]);
    expect(await unstampedServers({ isBundle: true, livePids: new Set([42]), pid: () => 42, answering: answers })).toEqual([]);
  });
});

/**
 * The daemon pidfile is a liveness CLAIM, and a pid is not an identity (PR #217). A daemon that
 * crashed without clearing its pidfile leaves a number the OS hands to something else, and every
 * caller here acts on it — `anton stop` signals it, doctor names it an unstamped anton and tells the
 * operator to stop it. So the file carries the pid's birth stamp and the read proves it.
 */
describe("the daemon pidfile", () => {
  const dirs = tempDirs();

  afterEach(dirs.cleanup);

  const pidFile = async () => join(await dirs.make("anton-state-"), "anton.pid");

  // A stamp from THIS machine's birth-time reader naming some other process — the reuse case. The
  // reader's tag has to be the local one: a stamp from the OTHER reader is not comparable, and so
  // proves nothing either way (PR #217 review).
  const reusedStamp = () =>
    `${(processStartedAt(process.pid) ?? "ps:").split(":", 1)[0]}:a process that has exited`;

  it("answers with the pid it recorded while that process is the one running", async () => {
    const path = await pidFile();
    writePidFile(process.pid, path);
    expect(readFileSync(path, "utf8").split("\n")[0]).toBe(String(process.pid));
    expect(runningPid(path)).toBe(process.pid);
  });

  // The reuse case: the pid is alive, and it is not anton's. Answering with it would send `anton
  // stop` at a stranger.
  it("does not answer with a live pid that is no longer the process it recorded", async () => {
    const path = await pidFile();
    writeFileSync(path, `${process.pid}\n${reusedStamp()}\n`);
    expect(runningPid(path)).toBeNull();
    expect(existsSync(path)).toBe(false);
  });

  // A pidfile written by an older anton carries no stamp. An absence is not evidence — it degrades
  // to the bare pid check, which is exactly what this always was.
  it("still answers on the pid alone for a pidfile written before the stamp existed", async () => {
    const path = await pidFile();
    writeFileSync(path, String(process.pid));
    expect(runningPid(path)).toBe(process.pid);
  });

  it("reads a dead pid as stopped and clears the file", async () => {
    const path = await pidFile();
    // Spawned and reaped, so the number named a process and now names nothing.
    const dead = spawnSync("node", ["-e", "process.exit(0)"]);
    writeFileSync(path, `${dead.pid}\n`);
    expect(runningPid(path)).toBeNull();
    expect(existsSync(path)).toBe(false);
  });

  /**
   * What `anton start`, `anton update` and `anton uninstall` act on (PR #217 review). Those three
   * read a null pid as "nothing is running" and then do something irreversible to a daemon that may
   * be alive — spawn a duplicate over its pidfile, swap the runtime under it, delete it. So the
   * unverifiable case is reported as its own state and they abort instead.
   */
  describe("a daemon that cannot be verified either way", () => {
    it("names the recorded pid so a lifecycle command can refuse to act", async () => {
      const path = await pidFile();
      writePidFile(process.pid, path);
      expect(lifecycleVerdict(path, () => null)).toEqual({ pid: null, unverifiable: process.pid });
    });

    it("names nobody once the read settles it — live, reused, dead, or absent", async () => {
      const path = await pidFile();
      writePidFile(process.pid, path);
      expect(lifecycleVerdict(path).unverifiable).toBeNull();

      writeFileSync(path, `${process.pid}\n${reusedStamp()}\n`);
      expect(lifecycleVerdict(path).unverifiable).toBeNull();

      const dead = spawnSync("node", ["-e", "process.exit(0)"]);
      writeFileSync(path, `${dead.pid}\n`);
      expect(lifecycleVerdict(path).unverifiable).toBeNull();

      expect(lifecycleVerdict(join(await dirs.make("anton-state-"), "absent.pid")).unverifiable).toBeNull();
    });

    /**
     * The two fields have to be ONE read (PR #217 review). Split across two, a birth time that
     * resolves once and fails the next second clears the pre-flight and then reports no daemon —
     * and `update` swaps the runtime out from under the live server it just decided was absent.
     */
    it("answers both halves of the decision from a single birth-time read", async () => {
      const path = await pidFile();
      writePidFile(process.pid, path);
      const reads: number[] = [];
      // Resolves for the pre-flight, fails for anything asking a second time.
      const flaky = (pid: number) => {
        reads.push(pid);
        return reads.length === 1 ? processStartedAt(pid) : null;
      };

      const verdict = lifecycleVerdict(path, flaky);

      expect(reads).toHaveLength(1);
      expect(verdict).toEqual({ pid: process.pid, unverifiable: null });
      expect(existsSync(path)).toBe(true);
    });
  });

  /**
   * What `anton stop` acts on, in both directions. `runningPid` going quiet is not the daemon
   * exiting: a birth time that cannot be reread mid-wait leaves a live daemon unnameable, and stop
   * reading that as death would drop its SIGKILL and delete the pidfile — stranding a server no
   * later stop can find. Nor is "not gone" proof the pid is still the daemon's: the same silence
   * over a pid the OS has since reused would aim that SIGKILL at a stranger (PR #217 review). So
   * the unverifiable case answers neither.
   */
  describe("proving the daemon gone", () => {
    it("proves neither for a pid that is merely unverifiable", async () => {
      const path = await pidFile();
      writePidFile(process.pid, path);
      expect(daemonState(process.pid, path, () => null)).toBe("unproven");
      expect(existsSync(path)).toBe(true); // and so the file `anton stop` needs is still there
    });

    it("proves neither once the pidfile names some other daemon", async () => {
      const path = await pidFile();
      writePidFile(process.pid, path);
      expect(daemonState(process.pid + 1, path)).toBe("unproven");
    });

    it("is running while the recorded process is still the one stop signalled", async () => {
      const path = await pidFile();
      writePidFile(process.pid, path);
      expect(daemonState(process.pid, path)).toBe("running");
    });

    it("is proven by a dead pid, by a reused one, and by a file that is gone", async () => {
      const path = await pidFile();
      const dead = spawnSync("node", ["-e", "process.exit(0)"]);
      writeFileSync(path, `${dead.pid}\n`);
      expect(daemonState(dead.pid, path)).toBe("exited");

      writeFileSync(path, `${process.pid}\n${reusedStamp()}\n`);
      expect(daemonState(process.pid, path)).toBe("exited");

      expect(daemonState(process.pid, join(await dirs.make("anton-state-"), "absent.pid"))).toBe("exited");
    });
  });

  /**
   * `anton stop` reporting success is what `update` and `uninstall` go on to destroy a runtime over
   * (PR #217 review). Only the unverifiable branches are exercised here: both return before any
   * signal is sent, so the suite never SIGTERMs its own process to assert them.
   */
  describe("stopping a daemon that cannot be verified either way", () => {
    it("fails rather than reporting a stop it never attempted", async () => {
      const path = await pidFile();
      writePidFile(process.pid, path);
      expect(await cmdStop(path, () => null)).toBe(1);
      expect(existsSync(path)).toBe(true); // kept, so the next stop can still name the daemon
    });

    it("reports nothing running only where the pidfile names nobody", async () => {
      expect(await cmdStop(join(await dirs.make("anton-state-"), "absent.pid"))).toBe(0);
    });

    it("blocks the lifecycle commands that would destroy the runtime under it", async () => {
      const path = await pidFile();
      writePidFile(process.pid, path);
      expect(await stoppedFor("update", path, () => null)).toBe(false);

      expect(await stoppedFor("uninstall", join(await dirs.make("anton-state-"), "absent.pid"))).toBe(true);
    });
  });

  /**
   * The URL `anton status` prints belongs to the pid it just named. The port used to live in one
   * note per install, which whatever started LAST overwrote: `anton start --foreground --port 4100`
   * beside a running daemon made status print the daemon's pid against the foreground server's URL,
   * and go on printing it after that process exited (PR #217 review). Recorded on the pidfile, the
   * port is the port of the process being reported, and it is gone when that record is.
   */
  describe("the port a status line names", () => {
    beforeEach(() => {
      delete process.env.PORT;
    });

    afterEach(() => {
      delete process.env.PORT;
    });

    it("is the one the daemon recorded when it started", async () => {
      const path = await pidFile();
      writePidFile(process.pid, path, "4100");
      expect(serverPort([], path)).toBe("4100");
      expect(runningPid(path)).toBe(process.pid); // and the record still proves whose port it is
    });

    it("is Next's default where the record names no port", async () => {
      const path = await pidFile();
      writePidFile(process.pid, path);
      expect(serverPort([], path)).toBe("3000");
    });

    // A status line describes a process that is ALREADY running, so this invocation's own
    // environment cannot outrank the record that process left: `PORT=4200 anton status` combined a
    // validated daemon pid with a URL nothing was listening on — the very line the pid-scoped port
    // record exists to prevent (PR #217 review).
    it("is the recorded one even where this invocation names another port", async () => {
      const path = await pidFile();
      writePidFile(process.pid, path, "4100");
      process.env.PORT = "4200";
      expect(serverPort([], path)).toBe("4100");
      expect(serverPort(["--port", "4300"], path)).toBe("4100");
    });

    // Only a pidfile written before the port was recorded there leaves the caller's environment as
    // the best evidence available.
    it("falls back to this invocation's port where a legacy record names none", async () => {
      const path = await pidFile();
      writePidFile(process.pid, path);
      expect(serverPort(["--port", "4200"], path)).toBe("4200");
      process.env.PORT = "4300";
      expect(serverPort([], path)).toBe("4300");
    });

    it("is gone once the daemon's record is, rather than outliving the server", async () => {
      const path = await pidFile();
      writePidFile(process.pid, path, "4100");
      rmSync(path);
      expect(serverPort([], path)).toBe("3000");
    });
  });
});

/**
 * Port ownership on Linux is read from procfs, not from lsof (anton-pzfb): anton neither installs
 * lsof nor declares it a prereq, and most distros ship without it — an enumerator that is merely
 * absent would answer "nothing is listening" about every live source server on those boxes.
 */
describe("listeningEndpoints — procfs", () => {
  const dirs = tempDirs();

  afterEach(dirs.cleanup);

  const row = (portHex: string, inode: string, state = "0A") =>
    `   0: 0100007F:${portHex} 00000000:0000 ${state} 00000000:00000000 00:00000000 00000000  1000        0 ${inode} 1 0000000000000000 100 0 0 10 0`;
  const table = (...rows: string[]) =>
    ["  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode", ...rows, ""].join("\n");

  /** A procfs with the given tcp table, and one process per [pid, inode] holding that socket. */
  const fakeProc = async (tcp: string, owners: Array<[number, string]> = []) => {
    const root = await dirs.make("anton-proc-");
    mkdirSync(join(root, "net"), { recursive: true });
    writeFileSync(join(root, "net", "tcp"), tcp);
    for (const [pid, inode] of owners) {
      mkdirSync(join(root, String(pid), "fd"), { recursive: true });
      symlinkSync(`socket:[${inode}]`, join(root, String(pid), "fd", "3"));
    }
    return root;
  };

  it("resolves the pid and port of each listening socket", async () => {
    const root = await fakeProc(table(row("0BB8", "99001"), row("0FA0", "99002")), [
      [4242, "99001"],
      [4243, "99002"],
    ]);
    expect(procfsListeningEndpoints(root)).toEqual([
      { pid: 4242, port: 3000 },
      { pid: 4243, port: 4000 },
    ]);
  });

  it("says nothing is listening when no socket is in LISTEN", async () => {
    const root = await fakeProc(table(row("0BB8", "99001", "01")), [[4242, "99001"]]);
    expect(procfsListeningEndpoints(root)).toEqual([]);
  });

  it("cannot say when there is no procfs to read", async () => {
    expect(procfsListeningEndpoints(await dirs.make("anton-noproc-"))).toBeNull();
  });

  // "Found, owned by someone else" is not "not listening": the socket is real, so the port is not
  // free — it just belongs to a process anton cannot attribute, which is no evidence about it.
  it("names the port but no pid when the socket belongs to a process anton can't read", async () => {
    // Another user's server: the socket is in the table, but no readable fd links back to it.
    const root = await fakeProc(table(row("0BB8", "99001")));
    expect(procfsListeningEndpoints(root)).toEqual([{ pid: null, port: 3000 }]);
  });

  // One server holds a socket per address family, and both have to resolve back to it — stopping at
  // the first match would leave whatever it holds beyond that one unattributed.
  it("attributes every socket a process holds, not just the first", async () => {
    const root = await fakeProc(table(row("0BB8", "99001"), row("0FA0", "99002")));
    mkdirSync(join(root, "4242", "fd"), { recursive: true });
    symlinkSync("socket:[99001]", join(root, "4242", "fd", "3"));
    symlinkSync("socket:[99002]", join(root, "4242", "fd", "4"));
    expect(procfsListeningEndpoints(root)).toEqual([
      { pid: 4242, port: 3000 },
      { pid: 4242, port: 4000 },
    ]);
  });
});

/**
 * `anton doctor` on the RUNNING server (anton-pzfb). A server holds the code it booted with, so a
 * fix can ship, sit on disk, and never run — which is how three nightly scans re-filed a signal two
 * landed filters already dropped. Doctor is the CLI half of saying so, and like the skill-drift
 * check beside it, it only ever reports: a restart can kill an in-flight run.
 */
describe("anton doctor — stale server build", () => {
  const dirs = tempDirs();

  afterEach(dirs.cleanup);

  const servers: Server[] = [];

  afterEach(async () => {
    await Promise.all(servers.splice(0).map((s) => new Promise((done) => s.close(done))));
  });

  /**
   * Serve `body` on a free port, so doctor's liveness probe has something real to ask.
   *
   * In-process on purpose: the probe now also asks WHERE the listener runs from, and this process's
   * cwd is the checkout doctor is diagnosing — which is what a source-mode `anton dev` looks like.
   */
  async function serve(body: string): Promise<number> {
    const server = createServer((_req, res) => res.end(body));
    servers.push(server);
    await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
    return (server.address() as { port: number }).port;
  }

  const strangers: ChildProcess[] = [];

  afterEach(() => {
    for (const child of strangers.splice(0)) child.kill();
  });

  /** The same page served from ANOTHER directory — a second anton install holding this port. */
  async function serveFrom(body: string, cwd: string): Promise<number> {
    const script =
      'require("node:http").createServer((_q, r) => r.end(process.env.BODY)).listen(0, "127.0.0.1", function () {\n' +
      "  console.log(this.address().port);\n" +
      "});";
    const child = spawn(process.execPath, ["-e", script], {
      cwd,
      env: { ...process.env, BODY: body },
      stdio: ["ignore", "pipe", "ignore"],
    });
    strangers.push(child);
    child.stdout.setEncoding("utf8");
    return new Promise((ready) => child.stdout.once("data", (chunk) => ready(Number(String(chunk).trim()))));
  }

  /**
   * Point doctor's state dir at a temp dir and leave `record` there as the running server's stamp.
   *
   * No port is pinned, because doctor no longer probes one: it enumerates the servers listening
   * from this checkout (PR #217). A case that must find nothing running therefore serves nothing,
   * and one that must find a server serves it from this process — whose cwd IS the checkout doctor
   * is diagnosing, so an `anton dev` of your own in THIS worktree would join the answer.
   */
  async function runDoctorWith(
    record: { pid: number } | ({ pid: number } | null)[] | null,
    { daemonPid }: { daemonPid?: number } = {},
  ) {
    const records = (Array.isArray(record) ? record : [record]).filter((one) => one !== null);
    const home = await dirs.make("anton-home-");
    const state = await dirs.make("anton-state-");
    // Records are named for the process that wrote them, so doctor reads the record and the pid it
    // claims as one thing — a name that disagrees with the contents names no process at all.
    for (const one of records) writeFileSync(join(state, `server-build.${one.pid}.json`), JSON.stringify(one));
    if (daemonPid) writeFileSync(join(state, "anton.pid"), String(daemonPid));
    // Spawned ASYNCHRONOUSLY on purpose: doctor asks the servers it finds for anton's page, and
    // `spawnSync` would block this process's event loop — the very loop the stubs above answer from.
    const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, ANTON_DB: join(state, "anton.db"), ANTON_STATE_DIR: state };
    const child = spawn(process.execPath, [CLI, "doctor"], { cwd: await dirs.make("anton-cwd-"), env });
    let stdout = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.resume();
    await new Promise((done) => child.on("close", done));
    return { stdout };
  }

  // The vitest process itself stands in for the running server: its pid is alive, which is the only
  // thing that makes a record a claim about NOW rather than a leftover.
  const running = (over: object) => ({ version: "0.4.0", revision: null, pid: process.pid, bootedAt: Date.now(), ...over });

  /** The identity of the code doctor will read on disk — what a server has to match to be current. */
  const current = () => ({
    version: JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8")).version,
    revision: spawnSync("git", ["-C", REPO_ROOT, "rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim(),
  });

  it("names the running build, the one on disk, and the restart that clears it", async () => {
    const r = await runDoctorWith(running({ version: "0.0.1" }));
    expect(r.stdout).toContain("is running 0.0.1");
    expect(r.stdout).toContain(String(JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8")).version));
    expect(r.stdout).toContain("Restart it to run the build on disk");
  });

  it("says nothing is running when no record and no daemon exist", async () => {
    const r = await runDoctorWith(null);
    expect(r.stdout).toContain("no running server recorded");
    expect(r.stdout).not.toContain("Restart it");
  });

  // The pidfile lives under the GLOBAL state dir and only the bundle's daemon writes one, so a
  // source checkout that read it would call the installed bundle's server its own — and print
  // source-mode restart instructions for a process `anton stop` owns.
  it("does not read the installed bundle's daemon as this checkout's server", async () => {
    const r = await runDoctorWith(null, { daemonPid: process.pid });
    expect(r.stdout).toContain("no running server recorded");
    expect(r.stdout).not.toContain("Restart it");
  });

  // A source checkout's `anton dev` / `anton start` writes no pidfile, so on the first upgrade past
  // this change — an old server, no record, no daemon — the listener is the only evidence anton
  // has. Without it doctor calls that exact case "nothing running" and the stale server stays
  // silent. The port is whatever the stub took, which is the point: nothing on disk names it.
  it("reports a source-mode server that is up but left no record", async () => {
    await serve("<html><head><title>anton</title></head>");
    const r = await runDoctorWith(null);
    expect(r.stdout).toContain("recorded no build identity");
    expect(r.stdout).toContain("Restart it to run the build on disk");
  });

  // Any dev server can hold a port. Claiming a stranger's is anton would send the operator to
  // restart a server that was never up.
  it("does not claim another app on the port is a stale anton", async () => {
    await serve("<html><head><title>grafana</title></head>");
    const r = await runDoctorWith(null);
    expect(r.stdout).toContain("no running server recorded");
    expect(r.stdout).not.toContain("Restart it");
  });

  // Any anton can hold a port, and the page it serves is the same page — so the response alone
  // attributes a neighbouring install's server (a bundle, a second worktree) to this checkout, and
  // hands the operator restart instructions for an install they are not in.
  it("does not claim another anton install's server", async () => {
    const elsewhere = await dirs.make("anton-elsewhere-");
    await serveFrom("<html><head><title>anton</title></head>", elsewhere);
    const r = await runDoctorWith(null);
    expect(r.stdout).toContain("no running server recorded");
    expect(r.stdout).not.toContain("Restart it");
  });

  it("stays silent for a server started from the current checkout", async () => {
    const r = await runDoctorWith(running(current()));
    expect(r.stdout).toContain("running the build on disk");
    expect(r.stdout).not.toContain("Restart it");
  });

  // A record outlives the server that wrote it, and the pid it names gets reused. Read as live it
  // would both vouch for a build nothing is serving AND stand in for the liveness check — so the
  // one server that IS up, too old to have left a record of its own, stays invisible.
  it("does not let a stopped server's leftover record answer for a server that is running", async () => {
    await serve("<html><head><title>anton</title></head>");
    const r = await runDoctorWith(running({ pid: process.pid, startedAt: "a process that has exited" }));
    expect(r.stdout).toContain("recorded no build identity");
    expect(r.stdout).toContain("Restart it to run the build on disk");
  });

  // A live record proves what ONE process is running and nothing about a second, older one. The
  // upgrade this check exists for leaves a pre-stamp server up while the operator, having pulled,
  // starts a current one on the next free port — and that stale process keeps running the nightly
  // jobs. Behind the records it has no line at all; beside them it has its own.
  it("names a running server no live record accounts for, beside the ones that do", async () => {
    await serve("<html><head><title>anton</title></head>");
    // The parent of this test process stands in for the recorded server; this one, which holds the
    // listening socket, is the server nothing recorded.
    const r = await runDoctorWith([{ ...running(current()), pid: process.ppid }]);
    expect(r.stdout).toContain(`pid ${process.ppid} running the build on disk`);
    expect(r.stdout).toContain(`pid ${process.pid} is running but recorded no build identity`);
    expect(r.stdout).toContain("Restart it to run the build on disk");
  });

  // `ANTON_DB` deliberately points two checkouts at one database — a runner and an
  // `ANTON_RUNNER=off` UI, or two worktrees — so a record beside it is not necessarily this
  // checkout's. Compared against this one it prints a stale-or-current verdict about a repo the
  // operator is not standing in.
  it("does not compare a neighbouring install's record against this checkout", async () => {
    const elsewhere = await dirs.make("anton-elsewhere-");
    const r = await runDoctorWith(running({ version: "0.0.1", appRoot: elsewhere }));
    expect(r.stdout).toContain("no running server recorded");
    expect(r.stdout).not.toContain("0.0.1");
  });

  it("still answers for a record that names this checkout as the install it booted from", async () => {
    const r = await runDoctorWith(running({ version: "0.0.1", appRoot: REPO_ROOT }));
    expect(r.stdout).toContain("is running 0.0.1");
  });

  // Two servers from one install — a UI-only `ANTON_RUNNER=off` one beside the runner. Each is its
  // own answer: under a shared record the newer one spoke for both and the stale one went unnamed.
  it("answers for every running server, not just the last one to boot", async () => {
    const r = await runDoctorWith([
      running({ version: "0.0.1", bootedAt: 1 }),
      // The parent of this test process: a second pid that is genuinely alive.
      { ...running(current()), pid: process.ppid, bootedAt: 2 },
    ]);
    expect(r.stdout).toContain(`pid ${process.pid} is running 0.0.1`);
    expect(r.stdout).toContain(`pid ${process.ppid} running the build on disk`);
    expect(r.stdout).toContain("Restart it to run the build on disk");
  });
});

/**
 * `anton doctor` on a shared-server board (anton-eg46). Server mode keeps no local copy, so a server
 * this machine cannot reach is a board outage, not slow sync — doctor probes it and fails, because
 * doctor is where an operator looks first and bd's own error names neither the target nor the fix.
 *
 * Every required tool is stubbed on PATH: what is asserted is the exit code, so a CI box without
 * `bd`/`claude` must not be what decides it.
 */
describe("anton doctor — shared-server board reachability", () => {
  const dirs = tempDirs();

  afterEach(dirs.cleanup);

  const SERVER_METADATA = {
    database: "dolt",
    backend: "dolt",
    dolt_mode: "server",
    dolt_server_host: "dolt.example.dev",
    dolt_server_port: 3306,
    dolt_server_user: "beads",
    dolt_database: "anton",
  };

  /**
   * A bd stub answering the version gate and the two health probes. `board` picks which one fails:
   * `"unreachable"` refuses the connection, `"unreadable"` accepts it and then refuses the board the
   * way bd's project-identity guard does — the case `bd dolt test` alone cannot see.
   */
  function fakeBdServer(board: "ok" | "unreachable" | "unreadable"): string {
    return [
      "#!/usr/bin/env node",
      "const a = process.argv.slice(2);",
      'if (a[0] === "--version" || a[0] === "--help") { console.log("bd version 1.1.2 (fake)"); process.exit(0); }',
      ...(board === "unreachable"
        ? ['if (a[0] === "dolt" && a[1] === "test") { console.error("dial tcp 10.0.0.9:3306: connect: connection refused"); process.exit(1); }']
        : []),
      ...(board === "unreadable"
        ? ['if (a[0] === "count") { console.error("PROJECT IDENTITY MISMATCH — refusing to connect"); process.exit(1); }']
        : []),
      "process.exit(0);",
    ].join("\n");
  }

  /** A repo with the given board metadata, and `doctor` run in it against stubbed tools. */
  async function runDoctorIn(metadata: Record<string, unknown> | null, board: "ok" | "unreachable" | "unreadable" = "ok") {
    const home = await dirs.make("anton-home-");
    const cwd = await dirs.make("anton-board-");
    if (metadata) {
      mkdirSync(join(cwd, ".beads"), { recursive: true });
      writeFileSync(join(cwd, ".beads", "metadata.json"), JSON.stringify(metadata, null, 2));
    }
    const bin = await dirs.make("anton-bin-");
    writeFakeBd(bin, fakeBdServer(board));
    // The other required tools, so a missing `claude` in CI can't be what fails the check.
    for (const tool of ["git", "claude"]) {
      writeFileSync(join(bin, tool), `#!/usr/bin/env node\nprocess.exit(0);\n`);
      chmodSync(join(bin, tool), 0o755);
    }
    return spawnSync(process.execPath, [CLI, "doctor"], {
      encoding: "utf8",
      cwd,
      env: { ...process.env, PATH: `${bin}${delimiter}${process.env.PATH ?? ""}`, HOME: home, ANTON_DB: join(home, "anton.db") },
    });
  }

  it("fails with the configured host/port and both ways out when the server is unreachable", async () => {
    const r = await runDoctorIn(SERVER_METADATA, "unreachable");

    expect(r.status).toBe(1);
    expect(r.stdout).toContain("dolt.example.dev:3306/anton");
    expect(r.stdout).toContain("UNREACHABLE");
    expect(r.stdout).toContain("connection refused");
    // The per-USER password variable, and the escape hatch back to the local copy.
    expect(r.stdout).toContain("BEADS_DOLT_PASSWORD_BEADS");
    expect(r.stdout).toContain('"dolt_mode": "embedded"');
  });

  /**
   * The gap `bd dolt test` cannot see (PR #174 review): it names no database and reads nothing, so a
   * connection is accepted over a database that is missing, unmigrated, or another project's. Server
   * mode keeps no local copy behind it, so a doctor that stopped at the connection test would exit 0
   * on a board where no operation works.
   */
  it("fails when the server answers but will not serve this project's board", async () => {
    const r = await runDoctorIn(SERVER_METADATA, "unreadable");

    expect(r.status).toBe(1);
    expect(r.stdout).toContain("WILL NOT SERVE this board");
    expect(r.stdout).toContain("PROJECT IDENTITY MISMATCH");
    // Named for the database, not the network: host, port and account were just proven to work, and
    // sending the reader back to them is the wasted hour this wording exists to avoid.
    expect(r.stdout).toContain('names the database this board lives in (now "anton")');
    expect(r.stdout).not.toContain("Start the server");
    expect(r.stdout).toContain('"dolt_mode": "embedded"');
  });

  it("passes and names the server when it serves the board", async () => {
    const r = await runDoctorIn(SERVER_METADATA);

    expect(r.status).toBe(0);
    expect(r.stdout).toContain("dolt.example.dev:3306/anton serving this board");
  });

  it("says nothing — and probes nothing — on an embedded board", async () => {
    const r = await runDoctorIn({ dolt_mode: "embedded", dolt_database: "anton" });

    expect(r.status).toBe(0);
    expect(r.stdout).not.toContain("shared Dolt server");
    expect(r.stdout).toContain("All required tools present");
  });
});

/**
 * What `anton start` will actually serve (anton-pzfb). `next start` never checks which code produced
 * `.next`, so the launcher has to: it rebuilds a checkout that moved, and — since a build takes
 * minutes — proves the tree held still across the compile before stamping the artifact with it.
 */
describe("anton start — the build it will serve", () => {
  const dirs = tempDirs();
  afterEach(dirs.cleanup);

  /** Nullable throughout: every field is a read that git or the filesystem can fail to answer. */
  type Identity = { version: string | null; revision: string | null; worktree: string | null };
  const CHECKOUT: Identity = { version: "0.4.0", revision: "a".repeat(40), worktree: "clean" };
  const EDITED = { ...CHECKOUT, worktree: "9f2c1a4bb001" };

  /** A checkout whose `.next` was compiled from `stamp` — omitted, it has never been built. */
  async function checkout(stamp?: object): Promise<string> {
    const dir = await dirs.make("anton-app-");
    if (stamp) {
      mkdirSync(join(dir, ".next"), { recursive: true });
      writeFileSync(join(dir, ".next", "anton-build.json"), JSON.stringify(stamp));
    }
    return dir;
  }

  const stampOf = (dir: string) => JSON.parse(readFileSync(join(dir, ".next", "anton-build.json"), "utf8"));

  /** Feed the identity reader a scripted sequence: one read before the build, one after each. */
  const reads = (...seq: Identity[]) => () => (seq.length > 1 ? seq.shift()! : seq[0]);

  it("builds and stamps the checkout it compiled when nothing is built", async () => {
    const dir = await checkout();
    const builds: number[] = [];
    const code = ensureFreshBuild({
      appRoot: dir,
      isBundle: false,
      build: () => (builds.push(1), 0),
      readIdentity: reads(CHECKOUT, CHECKOUT),
    });
    expect(code).toBe(0);
    expect(builds).toHaveLength(1);
    expect(stampOf(dir)).toMatchObject(CHECKOUT);
  });

  // A stamp anton could not write leaves a server that IS this checkout unable to prove it, and
  // every drift surface then reports the freshly-started process as unstamped. Starting is still
  // right — the code is current — but doing it silently makes that false alarm unreadable.
  it("starts, saying so, when the stamp cannot be written", async () => {
    const dir = await dirs.make("anton-app-");
    writeFileSync(join(dir, ".next"), ""); // a file where the build goes: every write under it fails
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const code = ensureFreshBuild({
        appRoot: dir,
        isBundle: false,
        build: () => 0,
        readIdentity: reads(CHECKOUT, CHECKOUT),
      });
      expect(code).toBe(0);
      expect(log.mock.calls.flat().join("\n")).toContain("anton-build.json");
    } finally {
      log.mockRestore();
    }
  });

  // `next build` rewrites `.next` IN PLACE, and a running `next start` loads its route chunks from
  // there as requests arrive — so compiling underneath one breaks the responses it is mid-way through
  // serving, and this process could not take the occupied port afterwards either (PR #217 review).
  it("refuses to rebuild .next while a server is still serving out of it", async () => {
    const dir = await checkout(EDITED);
    const build = vi.fn(() => 0);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const code = ensureFreshBuild({
        appRoot: dir,
        isBundle: false,
        build,
        readIdentity: () => CHECKOUT,
        liveServers: () => [{ path: join(dir, "server-build.4242.json"), record: { pid: 4242 } }],
      });
      expect(code).toBe(1);
      expect(build).not.toHaveBeenCalled();
      // The operator is told which process holds it, and left to stop it: a restart can kill a run.
      expect(log.mock.calls.flat().join("\n")).toContain("4242");
    } finally {
      log.mockRestore();
    }
  });

  // Two servers from one install stay supported — a UI-only `ANTON_RUNNER=off` one beside the runner
  // — because the refusal is of the REBUILD, not of the start: a `.next` that already matches this
  // checkout is one a second server can serve from without anything being rewritten under the first.
  it("starts a second server against a .next that already matches, without building", async () => {
    const dir = await checkout(CHECKOUT);
    const build = vi.fn(() => 0);
    const code = ensureFreshBuild({
      appRoot: dir,
      isBundle: false,
      build,
      readIdentity: () => CHECKOUT,
      liveServers: () => [{ path: join(dir, "server-build.4242.json"), record: { pid: 4242 } }],
    });
    expect(code).toBe(0);
    expect(build).not.toHaveBeenCalled();
  });

  // ...and with nothing serving, the rebuild is exactly as it was.
  it("rebuilds when the checkout moved and no server is serving from .next", async () => {
    const dir = await checkout(EDITED);
    const build = vi.fn(() => 0);
    const code = ensureFreshBuild({
      appRoot: dir,
      isBundle: false,
      build,
      readIdentity: reads(CHECKOUT, CHECKOUT),
      liveServers: () => [],
    });
    expect(code).toBe(0);
    expect(build).toHaveBeenCalledTimes(1);
  });

  it("starts without building when .next is already this checkout", async () => {
    const dir = await checkout(CHECKOUT);
    const build = vi.fn(() => 0);
    expect(ensureFreshBuild({ appRoot: dir, isBundle: false, build, readIdentity: () => CHECKOUT })).toBe(0);
    expect(build).not.toHaveBeenCalled();
  });

  it("rebuilds a .next compiled before the edit sitting in the worktree", async () => {
    const dir = await checkout(CHECKOUT);
    const build = vi.fn(() => 0);
    expect(ensureFreshBuild({ appRoot: dir, isBundle: false, build, readIdentity: reads(EDITED, EDITED) })).toBe(0);
    expect(build).toHaveBeenCalledTimes(1);
    expect(stampOf(dir)).toMatchObject(EDITED);
  });

  // The stale artifact nothing else catches: a save lands after Next has compiled that file, so the
  // build is pre-edit while the server boots recording the post-edit checkout — and every drift
  // surface then calls that stale process current.
  it("rebuilds when a save lands mid-compile, and stamps only the tree that survived one", async () => {
    const dir = await checkout();
    const build = vi.fn(() => 0);
    expect(ensureFreshBuild({ appRoot: dir, isBundle: false, build, readIdentity: reads(CHECKOUT, EDITED, EDITED) })).toBe(0);
    expect(build).toHaveBeenCalledTimes(2);
    expect(stampOf(dir)).toMatchObject(EDITED);
  });

  // Rebuilding forever behind someone who is still typing is worse than saying so: an unstamped
  // `.next` is what makes the next `anton start` rebuild rather than serve code nobody can name.
  it("refuses to start a checkout that never stops moving", async () => {
    const dir = await checkout();
    let n = 0;
    const build = vi.fn(() => 0);
    const code = ensureFreshBuild({
      appRoot: dir,
      isBundle: false,
      build,
      readIdentity: () => ({ ...CHECKOUT, worktree: `edit${n++}` }),
    });
    expect(code).toBe(1);
    expect(build).toHaveBeenCalledTimes(3);
    expect(existsSync(join(dir, ".next", "anton-build.json"))).toBe(false);
  });

  // The post-build read is what catches a save that landed mid-compile — so a read that came back
  // with nothing to say is not agreement, it is the check failing open. (Git times out, or an edit
  // made during the build pushed the diff past GIT_MAX_BUFFER.) Starting there would serve an
  // artifact that may predate the edit while stamping it as current.
  it("refuses to start when the post-build read cannot say what the checkout holds", async () => {
    const dir = await checkout();
    const build = vi.fn(() => 0);
    const code = ensureFreshBuild({
      appRoot: dir,
      isBundle: false,
      build,
      readIdentity: reads(CHECKOUT, { ...CHECKOUT, worktree: null }),
    });
    expect(code).toBe(1);
    expect(build).toHaveBeenCalledTimes(3);
    expect(existsSync(join(dir, ".next", "anton-build.json"))).toBe(false);
  });

  it("gives up when the build itself fails", async () => {
    const dir = await checkout();
    expect(ensureFreshBuild({ appRoot: dir, isBundle: false, build: () => 2, readIdentity: () => CHECKOUT })).toBe(2);
  });

  // A bundle ships its own prebuilt .next and no toolchain to rebuild with, and its RELEASE_VERSION
  // already identifies it exactly.
  it("leaves a bundle's prebuilt .next alone", async () => {
    const dir = await checkout({ version: "0.9.1", revision: null });
    const build = vi.fn(() => 0);
    const readIdentity = vi.fn(() => CHECKOUT);
    expect(ensureFreshBuild({ appRoot: dir, isBundle: true, build, readIdentity })).toBe(0);
    expect(build).not.toHaveBeenCalled();
    expect(readIdentity).not.toHaveBeenCalled();
  });
});
