/**
 * anton-cjs: the layered execution system prompt — the base is always present and first, agent +
 * seed are appended only when non-empty, and the real base file loads with frontmatter stripped.
 */
import { describe, expect, it } from "vitest";

import {
  composeSystemPrompt,
  loadBaseSystemPrompt,
  buildExecutionSystemPrompt,
  shellQuotePath,
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

  // PR #284 review: a board-only ticket's deliverable is bd writes, never a git diff, so the base's
  // "never report delivered on an unchanged tree" rule — written for the tree-based ticket it always
  // used to be — leaves a compliant agent no outcome but a false `blocked`. The carve-out rides ahead
  // of the agent/seed layers since it is a fact about THIS run's classification, not a customization.
  it("adds the board-only carve-out ahead of the agent/seed layers when boardOnly is set", () => {
    const out = composeSystemPrompt({
      base,
      agentPrompt: "AGENT: nextjs specialist",
      seedPrompt: "SEED: prefer server components",
      boardOnly: true,
    });
    expect(out).toContain("This ticket is board-only");
    expect(out).toContain("ANTON-RESULT: delivered");
    expect(out.toLowerCase()).toContain("unchanged");
    const iBase = out.indexOf("BASE CONTRACT");
    const iBoardOnly = out.indexOf("This ticket is board-only");
    const iAgent = out.indexOf("AGENT: nextjs");
    expect(iBase).toBeLessThan(iBoardOnly);
    expect(iBoardOnly).toBeLessThan(iAgent);
  });

  it("omits the board-only carve-out when boardOnly is not set", () => {
    const out = composeSystemPrompt({ base });
    expect(out).not.toContain("This ticket is board-only");
  });

  // PR #284 review (P1): the worktree's embedded Dolt copy is not what anton's board-evidence check
  // reads — a `bd` write left at the worktree's own cwd can be stranded there forever on a
  // non-server board. The carve-out must tell the agent to point writes at the live board explicitly.
  it("tells a board-only agent to redirect bd writes at the live repo path via -C", () => {
    const out = composeSystemPrompt({ base, boardOnly: true, repoPath: "/live/repo" });
    expect(out).toContain("bd -C '/live/repo' update <id> --status done");
    expect(out.toLowerCase()).toContain("separate, unsynced copy");
  });

  it("omits the -C redirect instruction when boardOnly is set without a repoPath", () => {
    const out = composeSystemPrompt({ base, boardOnly: true });
    expect(out).toContain("This ticket is board-only");
    expect(out).not.toContain("-C");
  });

  // PR #284 review (P2): a registered repo path may contain whitespace (src/lib/projects.test.ts
  // exercises `addProject` against a path named "Repo One") — an unquoted path here would be split
  // by the agent's shell into multiple arguments, silently misdirecting the `-C` flag.
  it("shell-quotes a repo path containing whitespace in the -C example", () => {
    const out = composeSystemPrompt({ base, boardOnly: true, repoPath: "/tmp/Repo One" });
    expect(out).toContain("bd -C '/tmp/Repo One' update <id> --status done");
  });

  // chatgpt-codex-connector, PR #284 review, "Avoid the board-only system contract for mixed runs":
  // a MIXED run (some tickets git-delivered, one delivery:board) must not tell the whole fix session
  // "editing the tree is neither required nor expected" — that carve-out is only safe when EVERY
  // ticket the session might be fixing is board-only.
  it("softens the carve-out for a MIXED run instead of the unconditional single-ticket wording", () => {
    const out = composeSystemPrompt({ base, boardOnly: true, mixedBoardOnly: true });
    expect(out).toContain("This run includes a board-only ticket");
    expect(out).not.toContain("This ticket is board-only");
    // Never states the blanket claim a mixed run cannot back: this ticket-scoped phrasing (from the
    // full carve-out) must not survive into the mixed wording.
    expect(out).not.toContain("this ticket's work");
    expect(out.toLowerCase()).toContain("must still make a real code change");
    expect(out).toContain("ANTON-RESULT: delivered");
  });

  it("uses the unconditional single-ticket carve-out when boardOnly is set without mixedBoardOnly", () => {
    const out = composeSystemPrompt({ base, boardOnly: true, mixedBoardOnly: false });
    expect(out).toContain("This ticket is board-only");
    expect(out).not.toContain("This run includes a board-only ticket");
  });

  it("keeps the live-board -C redirect instruction in the mixed-run wording too", () => {
    const out = composeSystemPrompt({ base, boardOnly: true, mixedBoardOnly: true, repoPath: "/live/repo" });
    expect(out).toContain("bd -C '/live/repo' update <id> --status done");
  });
});

describe("shellQuotePath", () => {
  it("wraps a plain path in single quotes", () => {
    expect(shellQuotePath("/live/repo")).toBe("'/live/repo'");
  });

  it("wraps a path containing whitespace so a shell reads it as one argument", () => {
    expect(shellQuotePath("/tmp/Repo One")).toBe("'/tmp/Repo One'");
  });

  it("escapes an embedded single quote", () => {
    expect(shellQuotePath("/tmp/it's-a-repo")).toBe("'/tmp/it'\\''s-a-repo'");
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
