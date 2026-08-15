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
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { delimiter, dirname, join } from "node:path";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";

import { agentsFromArgs, nextArgs, resolvePort } from "./anton.mjs";

import { CLI, run, seedOtherRelease, tempDirs, writeFakeBd } from "./anton.fixture";

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

  function runCheck(bin: string | null) {
    return spawnSync(process.execPath, [CLI, "board-check", repo], {
      encoding: "utf8",
      // A PATH holding ONLY the stub (plus node, which the stub's shebang resolves through) — so
      // `bin: null` reproduces "bd is not installed", where spawnSync reports ENOENT on `error` with
      // a null `stderr`.
      env: {
        ...process.env,
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
