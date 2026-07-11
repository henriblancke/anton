/**
 * Agent prompt loading (anton-dzh.3): frontmatter stripping and tag-to-file resolution against
 * the real prompts under src/prompts/agents.
 */
import { describe, expect, it } from "vitest";
import { loadAgentPrompt, stripFrontmatter } from "./agent-prompt";

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
  it("returns a non-empty string for a real tag, with frontmatter stripped", async () => {
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
