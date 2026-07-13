/**
 * Inventory (anton-3n5.1): builds fixture `.claude/` directories in a throwaway project + fake home
 * and asserts each classification bucket — available, installed-by-anton (byte-identical copy),
 * pre-existing-user (a modified bundled item or an agent/skill anton doesn't bundle). Bundled
 * sources come from the real repo (process.cwd()).
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  CLAUDE_AGENTS_DIR,
  CLAUDE_SKILLS_DIR,
  REQUIRED_SKILLS,
} from "./installer";
import { type Inventory, buildInventory } from "./inventory";

const bundledRoot = process.cwd();

/** Copy anton's bundled agent verbatim into a scope root's `.claude/agents/<tag>.md`. */
async function installAgent(root: string, tag: string): Promise<void> {
  const src = await readFile(join(bundledRoot, "src/prompts/agents", `${tag}.md`), "utf8");
  const dest = join(root, CLAUDE_AGENTS_DIR, `${tag}.md`);
  await mkdir(join(root, CLAUDE_AGENTS_DIR), { recursive: true });
  await writeFile(dest, src);
}

/** Copy anton's bundled skill verbatim into a scope root's `.claude/skills/<name>/SKILL.md`. */
async function installSkill(root: string, name: string): Promise<void> {
  const src = await readFile(join(bundledRoot, "skills", name, "SKILL.md"), "utf8");
  const dest = join(root, CLAUDE_SKILLS_DIR, name, "SKILL.md");
  await mkdir(join(root, CLAUDE_SKILLS_DIR, name), { recursive: true });
  await writeFile(dest, src);
}

async function writeAgentFile(root: string, tag: string, body: string): Promise<string> {
  const dest = join(root, CLAUDE_AGENTS_DIR, `${tag}.md`);
  await mkdir(join(root, CLAUDE_AGENTS_DIR), { recursive: true });
  await writeFile(dest, body);
  return dest;
}

async function writeSkillFile(root: string, name: string, body: string): Promise<string> {
  const dest = join(root, CLAUDE_SKILLS_DIR, name, "SKILL.md");
  await mkdir(join(root, CLAUDE_SKILLS_DIR, name), { recursive: true });
  await writeFile(dest, body);
  return dest;
}

const agent = (inv: Inventory, name: string) => inv.agents.find((a) => a.name === name);
const skill = (inv: Inventory, name: string) => inv.skills.find((s) => s.name === name);

describe("buildInventory", () => {
  let projectDir: string;
  let homeDir: string;

  beforeEach(async () => {
    projectDir = await mkdtemp(join(tmpdir(), "anton-inv-proj-"));
    homeDir = await mkdtemp(join(tmpdir(), "anton-inv-home-"));
  });

  afterEach(async () => {
    await rm(projectDir, { recursive: true, force: true });
    await rm(homeDir, { recursive: true, force: true });
  });

  it("empty .claude/: every bundled agent + required skill is available-to-install", async () => {
    const inv = await buildInventory({ projectDir, homeDir, bundledRoot });

    // Bundled agents include the known anton set, each with a description and marked available.
    expect(inv.agents.map((a) => a.name)).toEqual(
      expect.arrayContaining(["nextjs", "fastapi", "supabase", "terraform"]),
    );
    for (const a of inv.agents) {
      expect(a.bundled).toBe(true);
      expect(a.required).toBe(false);
      expect(a.classification).toBe("available");
      expect(a.description && a.description.length).toBeGreaterThan(0);
      expect(a.present).toEqual([]);
    }

    // Required skills are all present, flagged required, and available on an empty install.
    expect(inv.skills.map((s) => s.name).sort()).toEqual([...REQUIRED_SKILLS].sort());
    for (const s of inv.skills) {
      expect(s.required).toBe(true);
      expect(s.classification).toBe("available");
    }

    expect(inv.availableToInstall.length).toBe(inv.agents.length + inv.skills.length);
    expect(inv.installedByAnton).toEqual([]);
    expect(inv.preExistingUser).toEqual([]);
  });

  it("byte-identical project copy → installed-by-anton, and drops out of available", async () => {
    await installAgent(projectDir, "nextjs");
    await installSkill(projectDir, "shape");

    const inv = await buildInventory({ projectDir, homeDir, bundledRoot });

    const nextjs = agent(inv, "nextjs");
    expect(nextjs?.classification).toBe("installed-by-anton");
    expect(nextjs?.present).toEqual([
      { scope: "project", path: join(projectDir, CLAUDE_AGENTS_DIR, "nextjs.md"), matchesBundled: true },
    ]);

    const shape = skill(inv, "shape");
    expect(shape?.classification).toBe("installed-by-anton");
    expect(shape?.present[0]?.matchesBundled).toBe(true);

    expect(inv.installedByAnton.map((i) => i.name).sort()).toEqual(["nextjs", "shape"]);
    expect(inv.availableToInstall.find((i) => i.name === "nextjs")).toBeUndefined();
    expect(inv.availableToInstall.find((i) => i.name === "shape")).toBeUndefined();
    expect(inv.preExistingUser).toEqual([]);
  });

  it("modified bundled agent → pre-existing-user (do-not-touch), never available", async () => {
    const path = await writeAgentFile(
      projectDir,
      "nextjs",
      "---\nname: nextjs\ndescription: my own nextjs agent\n---\n\nMY OWN AGENT — hands off\n",
    );

    const inv = await buildInventory({ projectDir, homeDir, bundledRoot });

    const nextjs = agent(inv, "nextjs");
    expect(nextjs?.classification).toBe("user");
    expect(nextjs?.bundled).toBe(true); // it's still one anton bundles — just overridden
    expect(nextjs?.present).toEqual([{ scope: "project", path, matchesBundled: false }]);
    expect(inv.preExistingUser.map((i) => i.name)).toContain("nextjs");
    expect(inv.availableToInstall.find((i) => i.name === "nextjs")).toBeUndefined();
    expect(inv.installedByAnton.find((i) => i.name === "nextjs")).toBeUndefined();
  });

  it("agent/skill anton doesn't bundle → reported as bundled=false user item with its own description", async () => {
    await writeAgentFile(
      projectDir,
      "my-custom",
      "---\nname: my-custom\ndescription: bespoke local agent\n---\n\nbody\n",
    );
    await writeSkillFile(projectDir, "my-skill", "---\nname: my-skill\ndescription: bespoke skill\n---\n\nbody\n");

    const inv = await buildInventory({ projectDir, homeDir, bundledRoot });

    const custom = agent(inv, "my-custom");
    expect(custom).toBeDefined();
    expect(custom?.bundled).toBe(false);
    expect(custom?.classification).toBe("user");
    expect(custom?.description).toBe("bespoke local agent");

    const mySkill = skill(inv, "my-skill");
    expect(mySkill?.bundled).toBe(false);
    expect(mySkill?.required).toBe(false);
    expect(mySkill?.classification).toBe("user");

    expect(inv.preExistingUser.map((i) => i.name)).toEqual(
      expect.arrayContaining(["my-custom", "my-skill"]),
    );
    // Non-bundled items never appear as installable.
    expect(inv.availableToInstall.find((i) => i.name === "my-custom")).toBeUndefined();
  });

  it("records the scope of each present copy (project vs global)", async () => {
    await installAgent(projectDir, "nextjs"); // anton-installed in the project
    await installAgent(homeDir, "fastapi"); // identical copy globally

    const inv = await buildInventory({ projectDir, homeDir, bundledRoot });

    expect(agent(inv, "nextjs")?.present.map((p) => p.scope)).toEqual(["project"]);

    const fastapi = agent(inv, "fastapi");
    expect(fastapi?.present.map((p) => p.scope)).toEqual(["global"]);
    // No project copy but an identical global one → still classified installed-by-anton.
    expect(fastapi?.classification).toBe("installed-by-anton");
  });

  it("project override wins over global when classifying an item", async () => {
    // User has their own nextjs in the project, but a pristine anton copy sits globally.
    const projPath = await writeAgentFile(projectDir, "nextjs", "totally custom\n");
    await installAgent(homeDir, "nextjs");

    const inv = await buildInventory({ projectDir, homeDir, bundledRoot });
    const nextjs = agent(inv, "nextjs");

    // The install target is the project, whose differing copy makes it a user override.
    expect(nextjs?.classification).toBe("user");
    expect(nextjs?.present).toEqual(
      expect.arrayContaining([
        { scope: "project", path: projPath, matchesBundled: false },
        { scope: "global", path: join(homeDir, CLAUDE_AGENTS_DIR, "nextjs.md"), matchesBundled: true },
      ]),
    );
  });
});
