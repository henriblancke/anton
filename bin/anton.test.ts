/**
 * Smoke tests for the anton CLI (anton-hji). Only exercises argument dispatch — the paths that
 * don't depend on external tools or a build — so it's deterministic in CI (where bd/gh/stringer
 * aren't installed). setup/start/doctor behavior is covered by the manual run + the prereq logic.
 */
import { afterEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { agentsFromArgs, nextArgs, provisionAgentsSkills, REQUIRED_SKILLS, resolvePort } from "./anton.mjs";

const CLI = join(dirname(fileURLToPath(import.meta.url)), "anton.mjs");
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

function run(args: string[]) {
  return spawnSync("node", [CLI, ...args], { encoding: "utf8" });
}

describe("anton CLI dispatch", () => {
  it("--help prints usage and exits 0", () => {
    const r = run(["--help"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("anton <command>");
    expect(r.stdout).toContain("setup");
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

describe("provisionAgentsSkills (into a temp ~/.claude)", () => {
  let claudeRoot: string;
  const skillPath = (name: string) => join(claudeRoot, "skills", name, "SKILL.md");

  afterEach(async () => {
    if (claudeRoot) await rm(claudeRoot, { recursive: true, force: true });
  });

  it("installs required skills + a selected agent, and is idempotent (no-clobber)", async () => {
    claudeRoot = await mkdtemp(join(tmpdir(), "anton-claude-"));

    // Non-interactive selection via flag so no TTY prompt is needed.
    const first = await provisionAgentsSkills(["--agents", "nextjs"], { claudeRoot, appRoot: REPO_ROOT });
    expect(first.installed).toBe(REQUIRED_SKILLS.length + 1); // 4 skills + 1 agent
    for (const req of REQUIRED_SKILLS) expect(await exists(skillPath(req))).toBe(true);
    expect(await exists(join(claudeRoot, "agents", "nextjs.md"))).toBe(true);

    // Re-run: everything already present, zero writes.
    const second = await provisionAgentsSkills(["--agents", "nextjs"], { claudeRoot, appRoot: REPO_ROOT });
    expect(second.installed).toBe(0);
    expect(second.skipped).toBe(REQUIRED_SKILLS.length + 1);
  });

  it("with --no-agents installs only the required skills", async () => {
    claudeRoot = await mkdtemp(join(tmpdir(), "anton-claude-"));
    const r = await provisionAgentsSkills(["--no-agents"], { claudeRoot, appRoot: REPO_ROOT });
    expect(r.installed).toBe(REQUIRED_SKILLS.length);
    expect(r.agents).toEqual([]);
    expect(await exists(join(claudeRoot, "agents"))).toBe(false);
  });
});
