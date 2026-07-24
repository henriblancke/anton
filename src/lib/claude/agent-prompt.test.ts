/**
 * Agent prompt loading (anton-dzh.3, anton-3n5.4): frontmatter stripping and tag-to-file
 * resolution. Resolution honors user-provided agents by precedence: target-project
 * `.claude/agents/<tag>.md` > global `~/.claude/agents/<tag>.md` > anton bundled
 * `src/prompts/agents/<tag>.md`.
 */
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  PLUGINS_DIR,
  USER_AGENTS_DIR,
  loadAgentPrompt,
  pluginAgentDirs,
  stripFrontmatter,
} from "./agent-prompt";

describe("stripFrontmatter", () => {
  it("removes a --- delimited frontmatter block and leaves the body", () => {
    const md = "---\nname: nextjs\ndescription: something\n---\n\n# body\n\ntext here\n";
    const result = stripFrontmatter(md);
    expect(result).not.toMatch(/name:/);
    expect(result).toMatch(/# body/);
    expect(result).toMatch(/text here/);
  });

  it("passes through plain markdown with no frontmatter", () => {
    const md = "# just a heading\n\nno frontmatter here\n";
    expect(stripFrontmatter(md)).toBe(md);
  });
});

describe("loadAgentPrompt", () => {
  it("returns a non-empty string for a real bundled tag, with frontmatter stripped", async () => {
    const prompt = await loadAgentPrompt("nextjs");
    expect(prompt).toBeDefined();
    expect(prompt!.length).toBeGreaterThan(0);
    expect(prompt).not.toMatch(/^name:/m);
  });

  it("returns undefined for an unknown tag", async () => {
    expect(await loadAgentPrompt("does-not-exist")).toBeUndefined();
  });

  it("returns undefined for an empty or undefined tag", async () => {
    expect(await loadAgentPrompt("")).toBeUndefined();
    expect(await loadAgentPrompt(undefined)).toBeUndefined();
  });
});

describe("loadAgentPrompt precedence", () => {
  let projectDir: string;
  let homeDir: string;
  let bundledRoot: string;

  /** Write `<root>/<agentsDir>/<tag>.md` with the given body, creating parents. */
  async function writeAgent(root: string, agentsDir: string, tag: string, body: string) {
    const dir = join(root, agentsDir);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, `${tag}.md`), body, "utf8");
  }

  beforeEach(async () => {
    projectDir = await mkdtemp(join(tmpdir(), "anton-project-"));
    homeDir = await mkdtemp(join(tmpdir(), "anton-home-"));
    bundledRoot = await mkdtemp(join(tmpdir(), "anton-bundled-"));
  });

  afterEach(async () => {
    await Promise.all(
      [projectDir, homeDir, bundledRoot].map((d) => rm(d, { recursive: true, force: true })),
    );
  });

  it("bundled-only: falls back to the shipped prompt when no user override exists", async () => {
    await writeAgent(bundledRoot, "src/prompts/agents", "nextjs", "---\nname: n\n---\nbundled body");
    const prompt = await loadAgentPrompt("nextjs", { projectDir, homeDir, bundledRoot });
    expect(prompt).toBe("bundled body");
  });

  it("user-project-overrides-bundled: the project .claude agent wins", async () => {
    await writeAgent(projectDir, USER_AGENTS_DIR, "nextjs", "---\nname: n\n---\nproject body");
    await writeAgent(homeDir, USER_AGENTS_DIR, "nextjs", "global body");
    await writeAgent(bundledRoot, "src/prompts/agents", "nextjs", "bundled body");
    const prompt = await loadAgentPrompt("nextjs", { projectDir, homeDir, bundledRoot });
    expect(prompt).toBe("project body");
  });

  it("global fallback: the ~/.claude agent wins over bundled when no project override exists", async () => {
    await writeAgent(homeDir, USER_AGENTS_DIR, "nextjs", "---\nname: n\n---\nglobal body");
    await writeAgent(bundledRoot, "src/prompts/agents", "nextjs", "bundled body");
    const prompt = await loadAgentPrompt("nextjs", { projectDir, homeDir, bundledRoot });
    expect(prompt).toBe("global body");
  });

  it("none-found: returns undefined when no source has the tag", async () => {
    const prompt = await loadAgentPrompt("nextjs", { projectDir, homeDir, bundledRoot });
    expect(prompt).toBeUndefined();
  });

  /** Write a plugin registry under `homeDir` mapping each key to an installPath, and drop a
   *  `<tag>.md` into each plugin's `agents/` dir. Mirrors ~/.claude/plugins/installed_plugins.json. */
  async function writePlugins(specs: { key: string; tag: string; body: string }[]) {
    const registry: { plugins: Record<string, { installPath: string }[]> } = { plugins: {} };
    for (const { key, tag, body } of specs) {
      const installPath = join(homeDir, "plugins-cache", key);
      await writeAgent(installPath, "agents", tag, body);
      (registry.plugins[key] ||= []).push({ installPath });
    }
    const dir = join(homeDir, PLUGINS_DIR);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "installed_plugins.json"), JSON.stringify(registry), "utf8");
  }

  it("plugin fallback: an installed plugin's agent resolves when no .claude/agents or bundled has it", async () => {
    await writePlugins([{ key: "develop@market", tag: "prompt-engineer", body: "---\nname: pe\n---\nplugin body" }]);
    const prompt = await loadAgentPrompt("prompt-engineer", { projectDir, homeDir, bundledRoot });
    expect(prompt).toBe("plugin body");
  });

  it("bundled wins over plugin: anton's shipped prompt keeps its name", async () => {
    await writeAgent(bundledRoot, "src/prompts/agents", "nextjs", "bundled body");
    await writePlugins([{ key: "develop@market", tag: "nextjs", body: "plugin body" }]);
    const prompt = await loadAgentPrompt("nextjs", { projectDir, homeDir, bundledRoot });
    expect(prompt).toBe("bundled body");
  });

  it("plugin collision resolves deterministically by sorted plugin key (first wins)", async () => {
    await writePlugins([
      { key: "zeta@market", tag: "prompt-engineer", body: "zeta body" },
      { key: "develop@market", tag: "prompt-engineer", body: "develop body" },
    ]);
    const prompt = await loadAgentPrompt("prompt-engineer", { projectDir, homeDir, bundledRoot });
    expect(prompt).toBe("develop body"); // "develop@market" < "zeta@market"
  });
});

describe("pluginAgentDirs", () => {
  it("returns [] when the registry is absent or malformed", async () => {
    const home = await mkdtemp(join(tmpdir(), "anton-noplugins-"));
    try {
      expect(await pluginAgentDirs(home)).toEqual([]);
      await mkdir(join(home, PLUGINS_DIR), { recursive: true });
      await writeFile(join(home, PLUGINS_DIR, "installed_plugins.json"), "{ not json", "utf8");
      expect(await pluginAgentDirs(home)).toEqual([]);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
});
