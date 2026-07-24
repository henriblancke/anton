/**
 * Unit tests for agent discovery (anton-dvo.1): enumerating bundled + user `.claude/agents`
 * prompts, deduped by precedence, plus the tiny frontmatter parser that feeds the display text.
 */
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { AGENT_PROMPTS_DIR, USER_AGENTS_DIR } from "./claude/agent-prompt";
import { discoverAgents, parseFrontmatter } from "./agents-discovery";

describe("parseFrontmatter", () => {
  it("reads a plain scalar", () => {
    expect(parseFrontmatter("---\nname: nextjs\n---\nbody").name).toBe("nextjs");
  });

  it("reads a folded (>-) block scalar and joins lines with spaces", () => {
    const md = "---\nname: x\ndescription: >-\n  Line one\n  line two.\nmodel: sonnet\n---\n";
    expect(parseFrontmatter(md).description).toBe("Line one line two.");
  });

  it("strips surrounding quotes", () => {
    expect(parseFrontmatter('---\ndescription: "hi there"\n---').description).toBe("hi there");
  });

  it("returns empty for missing or unterminated frontmatter", () => {
    expect(parseFrontmatter("no frontmatter here")).toEqual({});
    expect(parseFrontmatter("---\nname: x\nstill going")).toEqual({});
  });

  it("ignores list/nested keys it doesn't need", () => {
    const md = "---\nname: x\ntools: [Read, Write]\n---";
    const out = parseFrontmatter(md);
    expect(out.name).toBe("x");
    expect(out.description).toBeUndefined();
  });
});

describe("discoverAgents", () => {
  let root: string;
  let bundledRoot: string;
  let homeDir: string;
  let repoPath: string;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "anton-agents-"));
    bundledRoot = join(root, "bundled");
    homeDir = join(root, "home");
    repoPath = join(root, "repo");

    const bundled = join(bundledRoot, AGENT_PROMPTS_DIR);
    const global = join(homeDir, USER_AGENTS_DIR);
    const project = join(repoPath, USER_AGENTS_DIR);
    await mkdir(bundled, { recursive: true });
    await mkdir(global, { recursive: true });
    await mkdir(project, { recursive: true });

    await writeFile(join(bundled, "nextjs.md"), "---\ndescription: bundled next\n---\nbody");
    await writeFile(join(bundled, "fastapi.md"), "no frontmatter");
    await writeFile(join(global, "graphql.md"), "---\ndescription: my global\n---\nbody");
    // Same id in project + bundled → project wins (higher precedence).
    await writeFile(join(project, "nextjs.md"), "---\ndescription: project override\n---\nbody");
    await writeFile(join(project, "README.txt"), "ignored — not .md");
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("lists all sources deduped by precedence, sorted by id", async () => {
    const agents = await discoverAgents(repoPath, { homeDir, bundledRoot });
    expect(agents.map((a) => a.id)).toEqual(["fastapi", "graphql", "nextjs"]);

    const byId = Object.fromEntries(agents.map((a) => [a.id, a]));
    expect(byId.nextjs).toMatchObject({ source: "project", description: "project override" });
    expect(byId.graphql).toMatchObject({ source: "global", description: "my global" });
    expect(byId.fastapi).toMatchObject({ source: "bundled" });
    expect(byId.fastapi.description).toBeUndefined();
  });

  it("skips missing source dirs and omits the project source when repoPath is absent", async () => {
    const agents = await discoverAgents(undefined, { homeDir, bundledRoot });
    expect(agents.map((a) => a.id)).toEqual(["fastapi", "graphql", "nextjs"]);
    // With no project dir, the bundled nextjs wins instead of the project override.
    expect(agents.find((a) => a.id === "nextjs")?.source).toBe("bundled");
  });
});

describe("discoverAgents — installed Claude Code plugins", () => {
  let root: string;
  let bundledRoot: string;
  let homeDir: string;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "anton-plugin-agents-"));
    bundledRoot = join(root, "bundled");
    homeDir = join(root, "home");
    await mkdir(join(bundledRoot, AGENT_PROMPTS_DIR), { recursive: true });
    // A bundled agent that a plugin also defines → bundled must win the name (stays gateable).
    await writeFile(join(bundledRoot, AGENT_PROMPTS_DIR, "nextjs.md"), "bundled body");

    // Two plugins: one carries a plugin-only agent (prompt-engineer) + a nextjs that must lose to
    // bundled; both define prompt-engineer to prove deterministic sorted-key resolution.
    const registry: { plugins: Record<string, { installPath: string }[]> } = { plugins: {} };
    for (const [key, ids] of [
      ["develop@market", ["prompt-engineer", "nextjs"]],
      ["zeta@market", ["prompt-engineer"]],
    ] as const) {
      const installPath = join(root, "plugins", key);
      await mkdir(join(installPath, "agents"), { recursive: true });
      for (const id of ids) {
        await writeFile(join(installPath, "agents", `${id}.md`), `---\ndescription: ${key}/${id}\n---\nb`);
      }
      registry.plugins[key] = [{ installPath }];
    }
    await mkdir(join(homeDir, ".claude/plugins"), { recursive: true });
    await writeFile(join(homeDir, ".claude/plugins/installed_plugins.json"), JSON.stringify(registry));
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("discovers plugin-only agents as source 'plugin', with bundled winning shared names", async () => {
    const agents = await discoverAgents(undefined, { homeDir, bundledRoot });
    expect(agents.map((a) => a.id)).toEqual(["nextjs", "prompt-engineer"]);
    // nextjs is bundled + plugin → bundled wins (stays in anton's gated namespace).
    expect(agents.find((a) => a.id === "nextjs")?.source).toBe("bundled");
    // prompt-engineer is plugin-only → source 'plugin', from the first plugin in sorted key order.
    expect(agents.find((a) => a.id === "prompt-engineer")).toMatchObject({
      source: "plugin",
      description: "develop@market/prompt-engineer",
    });
  });
});
