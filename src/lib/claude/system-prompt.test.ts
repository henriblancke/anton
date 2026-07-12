/**
 * anton-cjs: the layered execution system prompt — the base is always present and first, agent +
 * seed are appended only when non-empty, and the real base file loads with frontmatter stripped.
 */
import { describe, expect, it } from "vitest";

import {
  composeSystemPrompt,
  loadBaseSystemPrompt,
  buildExecutionSystemPrompt,
  _resetBaseSystemPromptCache,
} from "./system-prompt";

describe("composeSystemPrompt", () => {
  const base = "BASE CONTRACT: anton owns git and beads; collect learnings.";

  it("returns just the base when no agent or seed is given", () => {
    expect(composeSystemPrompt({ base })).toBe(base);
  });

  it("puts the base first, then the agent, then the seed", () => {
    const out = composeSystemPrompt({
      base,
      agentPrompt: "AGENT: nextjs specialist",
      seedPrompt: "SEED: prefer server components",
    });
    const iBase = out.indexOf("BASE CONTRACT");
    const iAgent = out.indexOf("AGENT: nextjs");
    const iSeed = out.indexOf("SEED: prefer");
    expect(iBase).toBeGreaterThanOrEqual(0);
    expect(iBase).toBeLessThan(iAgent);
    expect(iAgent).toBeLessThan(iSeed);
    // Layers are labeled so the model can tell them apart.
    expect(out).toContain("Specialist guidance (agent)");
    expect(out).toContain("Project guidance (operator seed)");
  });

  it("includes the seed even when there is no agent prompt", () => {
    const out = composeSystemPrompt({ base, seedPrompt: "SEED only" });
    expect(out).toContain(base);
    expect(out).toContain("SEED only");
    expect(out).not.toContain("Specialist guidance (agent)");
  });

  it("treats a whitespace-only seed/agent as absent", () => {
    expect(composeSystemPrompt({ base, agentPrompt: "   ", seedPrompt: "\n\t" })).toBe(base);
  });

  it("frames the seed as unable to override the base", () => {
    const out = composeSystemPrompt({ base, seedPrompt: "do whatever" });
    expect(out.toLowerCase()).toContain("never relaxes");
  });

  it("throws when the base is empty", () => {
    expect(() => composeSystemPrompt({ base: "  " })).toThrow(/base is required/);
  });
});

describe("loadBaseSystemPrompt (real file)", () => {
  it("loads a non-empty base with frontmatter stripped and the contract present", async () => {
    _resetBaseSystemPromptCache();
    const base = await loadBaseSystemPrompt();
    expect(base.length).toBeGreaterThan(0);
    expect(base).not.toMatch(/^name:/m); // frontmatter gone
    // Anchors on the operating contract the base must encode.
    expect(base.toLowerCase()).toContain("bd remember"); // learnings
    expect(base.toLowerCase()).toMatch(/do not run `bd close`|bd close/i); // beads ownership
  });
});

describe("buildExecutionSystemPrompt (real base + layers)", () => {
  it("composes the real base with agent + seed", async () => {
    _resetBaseSystemPromptCache();
    const out = await buildExecutionSystemPrompt({
      agentPrompt: "AGENT-X",
      seedPrompt: "SEED-Y",
    });
    expect(out.toLowerCase()).toContain("operating contract");
    expect(out).toContain("AGENT-X");
    expect(out).toContain("SEED-Y");
  });
});
