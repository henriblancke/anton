/**
 * anton-cjs: the layered execution system prompt — the base is always present and first, agent +
 * seed are appended only when non-empty, and the real base file loads with frontmatter stripped.
 */
import { describe, expect, it } from "vitest";

import { STAMP_LENGTH } from "./skill-stamp.mjs";
import {
  composeSystemPrompt,
  loadBaseSystemPrompt,
  buildExecutionSystemPrompt,
  systemPromptDigest,
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
    // The self-verification mandate: the agent runs the project's checks before declaring done.
    expect(base).toContain("Verify before you finish");
    // The outcome vocabulary the parser reads (anton-j5i8, anton-287p, anton-6l0q) — all four, and
    // the unchanged-tree rule must offer `satisfied` so it no longer forces a false `blocked`.
    expect(base).toContain("ANTON-RESULT: delivered");
    expect(base).toContain("ANTON-RESULT: blocked — <class> — <one-line reason>");
    expect(base).toContain("ANTON-RESULT: needs-human — <one-line ask>");
    expect(base).toContain("ANTON-RESULT: satisfied — <commit sha> —");
    expect(base).toMatch(/report `satisfied` with the commit that already did the work/);
    // The unchanged-tree rule must carve out the CONTINUATION exception (PR #255 review): a resume
    // whose previous attempt's work is already on the branch reports `delivered`, so the locked
    // contract can no longer forbid the one outcome the resume prompt and the delivery gate require.
    expect(base).toContain("CONTINUATION of this");
    expect(base).toMatch(/previous attempt at THIS ticket/);
  });
});

describe("buildExecutionSystemPrompt self-verification section", () => {
  it("carries the 'Verify before you finish' section into the composed prompt", async () => {
    _resetBaseSystemPromptCache();
    const out = await buildExecutionSystemPrompt({ agentPrompt: "AGENT-X", seedPrompt: "SEED-Y" });
    expect(out).toContain("Verify before you finish");
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

// The ledger records the prompt that RAN, and a prompt is edited in place — by the time anyone asks
// whether an edit helped, the text is gone. The digest is the only record of it, so it has to be
// stable across calls (or two runs of one prompt split into two cohorts) and sensitive to every
// layer (or a specialist swap disappears into the base's key).
describe("systemPromptDigest (anton-tw37r)", () => {
  const base = "BASE CONTRACT: anton owns git and beads.";
  const composed = (layers: Parameters<typeof composeSystemPrompt>[0]) =>
    systemPromptDigest(composeSystemPrompt(layers));

  it("digests a composed prompt to a stable 12-hex value", () => {
    const digest = composed({ base, agentPrompt: "AGENT", seedPrompt: "SEED" });
    expect(digest).toMatch(/^[0-9a-f]{12}$/);
    expect(composed({ base, agentPrompt: "AGENT", seedPrompt: "SEED" })).toBe(digest);
  });

  it("matches a fixed known-input vector, so the convention cannot drift silently", () => {
    // sha256("")[0..12) and sha256("BASE")[0..12) — pinned so a change of algorithm, encoding or
    // truncation length reddens here instead of silently re-keying every cohort already recorded.
    expect(systemPromptDigest("")).toBe("e3b0c44298fc");
    expect(systemPromptDigest("BASE")).toBe("cbf36a964ba8");
  });

  it("uses the same stamp length as every other digest anton takes", () => {
    expect(systemPromptDigest("anything")).toHaveLength(STAMP_LENGTH);
  });

  it("changes when the BASE layer changes", () => {
    expect(composed({ base: `${base} And one more rule.` })).not.toBe(composed({ base }));
  });

  it("changes when the AGENT layer changes, is added, or is removed", () => {
    const none = composed({ base });
    const nextjs = composed({ base, agentPrompt: "AGENT: nextjs" });
    const fastapi = composed({ base, agentPrompt: "AGENT: fastapi" });
    expect(nextjs).not.toBe(none);
    expect(fastapi).not.toBe(nextjs);
  });

  it("changes when the SEED layer changes, is added, or is removed", () => {
    const none = composed({ base });
    const seeded = composed({ base, seedPrompt: "SEED: prefer server components" });
    const edited = composed({ base, seedPrompt: "SEED: prefer client components" });
    expect(seeded).not.toBe(none);
    expect(edited).not.toBe(seeded);
  });

  // Two prompts that deliver the same text to claude are one cohort. A whitespace-only seed is not a
  // layer (composeSystemPrompt drops it), so it must not key a run away from the unseeded ones.
  it("is unchanged by anything composition itself discards", () => {
    const bare = composed({ base });
    expect(composed({ base: `  ${base}  ` })).toBe(bare);
    expect(composed({ base, agentPrompt: "   ", seedPrompt: "\n\t" })).toBe(bare);
  });

  // The layers are labeled and ordered by composition, so the same texts cannot be rearranged into
  // one another's slots — an agent prompt swapped with a seed is a different prompt, and digests so.
  it("distinguishes the same text in different layers", () => {
    expect(composed({ base, agentPrompt: "X" })).not.toBe(composed({ base, seedPrompt: "X" }));
  });

  it("is pure — no filesystem, no base-cache state", async () => {
    _resetBaseSystemPromptCache();
    const digest = composed({ base, seedPrompt: "SEED" });
    // The real base is loaded in between; the pure digest is unaffected by it.
    await loadBaseSystemPrompt();
    expect(composed({ base, seedPrompt: "SEED" })).toBe(digest);
  });
});
