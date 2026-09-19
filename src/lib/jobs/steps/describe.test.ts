/**
 * Direct tests for `step:describe` (anton-aucch): the describer dispatches over the run's committed
 * diff under a swappable contract, and NEVER fails or parks the run — a throw, a timeout, an
 * exhausted quota, or an unparseable report all cost the narrative and nothing else.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { UsageLimitError } from "../errors";
import { describeStep, parseNarrativeReport } from "./describe";
import { clock, fakeClaude, target } from "./step.fixture";
import { schema } from "../../db";
import { makeProjectDb } from "@/lib/testing/project";
import type { StepContext } from "./context";

/** An id no bundled/global agent or skill can shadow, so precedence is measured, not guessed. */
const AGENT_ID = "anton-aucch-test-describer";
const SKILL_ID = "anton-aucch-test-skill";

describe("step:describe", () => {
  let dir: string;
  let sessionsRoot: string;
  let priorSessionsRoot: string | undefined;
  let tdb: ReturnType<typeof makeProjectDb>;
  let runId: string;

  function git(...args: string[]): void {
    execFileSync("git", ["-C", dir, ...args], { stdio: "pipe" });
  }

  /** Write a file in the worktree and commit it onto the checked-out branch. */
  function commitFile(relPath: string, contents: string): void {
    const full = join(dir, relPath);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, contents);
    git("add", "-A");
    git("commit", "-qm", `add ${relPath}`);
  }

  function agentFile(id: string, body: string): string {
    return `---\nname: ${id}\n---\n\n${body}\n`;
  }

  function skillFile(id: string, body: string): string {
    return `---\nname: ${id}\ndescription: test\n---\n\n${body}\n`;
  }

  function ctx(overrides: Partial<StepContext> = {}): StepContext {
    return {
      db: tdb.db,
      clock,
      ctx: {
        signal: new AbortController().signal,
        heartbeat: async () => {},
        report: () => {},
        claudeReached: async () => {},
        jobId: "job-test",
        type: "execute-epic",
      },
      projectId: tdb.projectId,
      runId,
      repoPath: dir,
      worktreePath: dir,
      branch: "run",
      baseBranch: "base",
      baseRef: "base",
      baseForkSha: "f0f0f0forkcommit",
      target,
      tickets: [target],
      settings: {},
      ...overrides,
    };
  }

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "anton-steps-describe-"));
    priorSessionsRoot = process.env.ANTON_SESSIONS_ROOT;
    // BESIDE the worktree, never inside it. Session logs are anton's own state, and in production
    // they live under `.anton/` — gitignored, and outside the run's worktree entirely. Writing them
    // into the tree under test would make every dispatch dirty it, which the read-only guard
    // (`enforceDescriberReadOnly`) would then correctly report as the describer having written.
    sessionsRoot = mkdtempSync(join(tmpdir(), "anton-steps-describe-sessions-"));
    process.env.ANTON_SESSIONS_ROOT = sessionsRoot;
    tdb = makeProjectDb({ repoPath: dir });
    runId = randomUUID();
    await tdb.db.insert(schema.runs).values({
      id: runId,
      projectId: tdb.projectId,
      epicBeadId: target.id,
      branch: "run",
      status: "running",
    });

    git("init", "--quiet", "-b", "base");
    git("config", "user.email", "test@example.com");
    git("config", "user.name", "test");
    commitFile("README.md", "# project\n");
    // `baseRef` names this branch pointer — tests that need HEAD to diverge from it (a real diff, or
    // base-rev isolation) call `checkoutRun()` after committing whatever belongs on `base` itself.
  });

  /** Branch off `base` so further commits are "the run's own diff" instead of moving `base` itself. */
  function checkoutRun(): void {
    git("checkout", "-q", "-b", "run");
  }

  afterEach(() => {
    tdb.close();
    if (priorSessionsRoot === undefined) delete process.env.ANTON_SESSIONS_ROOT;
    else process.env.ANTON_SESSIONS_ROOT = priorSessionsRoot;
    rmSync(dir, { recursive: true, force: true });
    rmSync(sessionsRoot, { recursive: true, force: true });
  });

  /** The narrative's required JSON envelope, ready to interpolate a payload into. */
  const report = (payload: string) => `Done.\n\n\`\`\`json\n${payload}\n\`\`\`\n`;

  describe("a well-formed report", () => {
    it("yields the narrative in StepFacts", async () => {
      const claude = fakeClaude(
        report(
          JSON.stringify({
            narrative: { summary: "Adds X.", spotlight: "src/x.ts — the new entry point.", risks: "None found." },
          }),
        ),
      );

      const result = await describeStep(ctx({ deps: { runClaude: claude.run } }));

      expect(result.ok).toBe(true);
      expect(result.facts?.narrative).toEqual({
        summary: "Adds X.",
        spotlight: "src/x.ts — the new entry point.",
        risks: "None found.",
      });
    });

    it("dispatches once, over the target and its tickets, and records the session", async () => {
      const ticketA = { ...target, id: "anton-a", title: "ticket A" };
      const claude = fakeClaude(report(JSON.stringify({ narrative: { summary: "did stuff" } })));

      const result = await describeStep(ctx({ tickets: [ticketA], deps: { runClaude: claude.run } }));

      expect(claude.calls).toHaveLength(1);
      expect(claude.calls[0].prompt).toContain(target.id);
      expect(claude.calls[0].prompt).toContain(ticketA.id);
      expect(result.facts?.sessionIds).toHaveLength(1);
    });

    it("carries the run's committed diff (merge-base..HEAD)", async () => {
      checkoutRun();
      commitFile("src/feature.ts", "export const feature = true;\n");
      const claude = fakeClaude(report(JSON.stringify({ narrative: { summary: "did stuff" } })));

      await describeStep(ctx({ deps: { runClaude: claude.run } }));

      expect(claude.calls[0].prompt).toContain("src/feature.ts");
      expect(claude.calls[0].prompt).toContain("export const feature = true;");
    });
  });

  describe("the describer is read-only", () => {
    it("denies every write-shaped tool, the shell included", async () => {
      const claude = fakeClaude(report(JSON.stringify({ narrative: { summary: "did stuff" } })));

      await describeStep(ctx({ deps: { runClaude: claude.run } }));

      // Deny rules outrank the permission mode, so these BIND a `bypassPermissions` session.
      expect(claude.calls[0].disallowedTools).toEqual([
        "Write",
        "Edit",
        "MultiEdit",
        "NotebookEdit",
        "Bash",
      ]);
    });

    it("reverts a describer that edited the tree anyway, and drops its narrative", async () => {
      checkoutRun();
      commitFile("src/feature.ts", "export const feature = true;\n");
      const head = execFileSync("git", ["-C", dir, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
      const claude = fakeClaude({
        ok: true,
        text: report(JSON.stringify({ narrative: { summary: "and I tidied up while I was in there" } })),
        modelUsage: [],
      });
      // The describer writes while it runs — the tool filter is only as good as the names it lists,
      // so the fingerprint is what proves the tree is untouched.
      const writing = async (options: Parameters<typeof claude.run>[0]) => {
        writeFileSync(join(dir, "src/feature.ts"), "export const feature = false; // helpfully fixed\n");
        return claude.run(options);
      };

      const result = await describeStep(ctx({ deps: { runClaude: writing } }));

      // Never fails the run — a write costs the narrative, like every other describer failure.
      expect(result.ok).toBe(true);
      expect(result.facts?.narrative).toBeUndefined();
      expect(result.detail).toContain("MODIFIED the worktree");
      // The tree the PR step is about to push is exactly the tree the review gate graded.
      expect(execFileSync("git", ["-C", dir, "status", "--porcelain"], { encoding: "utf8" })).toBe("");
      expect(execFileSync("git", ["-C", dir, "rev-parse", "HEAD"], { encoding: "utf8" }).trim()).toBe(head);
    });

    it("reverts a describer that COMMITTED, so nothing bypasses the review gate", async () => {
      checkoutRun();
      commitFile("src/feature.ts", "export const feature = true;\n");
      const head = execFileSync("git", ["-C", dir, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
      const committing = async (): Promise<{ ok: true; text: string; modelUsage: [] }> => {
        commitFile("src/sneaky.ts", "export const ungraded = true;\n");
        return { ok: true, text: report(JSON.stringify({ narrative: { summary: "done" } })), modelUsage: [] };
      };

      const result = await describeStep(ctx({ deps: { runClaude: committing } }));

      expect(result.ok).toBe(true);
      expect(result.facts?.narrative).toBeUndefined();
      // The commit is gone: a push here would otherwise carry code the review gate never saw.
      expect(execFileSync("git", ["-C", dir, "rev-parse", "HEAD"], { encoding: "utf8" }).trim()).toBe(head);
    });

    it("leaves an honest describer's tree and narrative alone", async () => {
      checkoutRun();
      commitFile("src/feature.ts", "export const feature = true;\n");
      const claude = fakeClaude(report(JSON.stringify({ narrative: { summary: "Adds the feature." } })));

      const result = await describeStep(ctx({ deps: { runClaude: claude.run } }));

      expect(result.facts?.narrative?.summary).toBe("Adds the feature.");
      expect(result.detail).toBe("wrote the run narrative");
    });
  });

  describe("model routing", () => {
    it("routes on the run's whole label context, not its ticket count", async () => {
      // An epic with exactly ONE child is the case the ticket-phase default gets wrong: it would
      // route on the child's labels, so this `describe` route on the target would never fire.
      const claude = fakeClaude(report(JSON.stringify({ narrative: { summary: "did stuff" } })));

      await describeStep(
        ctx({
          step: { id: "describe", labels: ["step:describe"] },
          target: { ...target, labels: ["risk:high"] },
          tickets: [{ ...target, id: "anton-a", labels: ["risk:low"] }],
          settings: {
            model: "fallback",
            modelRoutes: [{ jobType: "execute-epic", step: "describe", label: "risk:high", model: "careful" }],
          },
          deps: { runClaude: claude.run },
        }),
      );

      expect(claude.calls[0].model).toBe("careful");
    });

    it("routes the same way once the run grows a second ticket", async () => {
      const claude = fakeClaude(report(JSON.stringify({ narrative: { summary: "did stuff" } })));

      await describeStep(
        ctx({
          step: { id: "describe", labels: ["step:describe"] },
          target: { ...target, labels: ["risk:high"] },
          tickets: [
            { ...target, id: "anton-a", labels: ["risk:low"] },
            { ...target, id: "anton-b", labels: ["risk:low"] },
          ],
          settings: {
            model: "fallback",
            modelRoutes: [{ jobType: "execute-epic", step: "describe", label: "risk:high", model: "careful" }],
          },
          deps: { runClaude: claude.run },
        }),
      );

      // The model follows the work described, not how many beads it was split into.
      expect(claude.calls[0].model).toBe("careful");
    });
  });

  describe("a describer that fails costs the narrative and nothing else", () => {
    it("a throwing describer reports ok:true with no narrative", async () => {
      const claude = fakeClaude(new Error("the model process died"));

      const result = await describeStep(ctx({ deps: { runClaude: claude.run } }));

      expect(result.ok).toBe(true);
      expect(result.facts?.narrative).toBeUndefined();
    });

    it("a timed-out describer (an aborted dispatch) reports ok:true with no narrative", async () => {
      const aborted = new Error("The operation was aborted");
      aborted.name = "AbortError";
      const claude = fakeClaude(aborted);

      const result = await describeStep(ctx({ deps: { runClaude: claude.run } }));

      expect(result.ok).toBe(true);
      expect(result.facts?.narrative).toBeUndefined();
    });

    it("a quota-exhausted describer reports ok:true with no narrative — never re-thrown", async () => {
      const claude = fakeClaude(new UsageLimitError("quota exhausted"));

      const result = await describeStep(ctx({ deps: { runClaude: claude.run } }));

      expect(result.ok).toBe(true);
      expect(result.facts?.narrative).toBeUndefined();
    });

    it("a FAILED claude result yields no narrative, even when its text carries one", async () => {
      // `dispatchClaude` returns `{ ok: false }` for a claude result that failed without throwing —
      // a non-transient error result, a session the driver settled `failed`. Its text can still
      // contain a narrative-shaped block: a report the agent began and abandoned, or diagnostic
      // prose quoting the format. Publishing that as the run's authoritative narrative while the
      // session is recorded failed contradicts this step's contract (PR #303 review).
      const claude = fakeClaude({
        ok: false,
        text: report(JSON.stringify({ narrative: { summary: "half-written, then the model errored" } })),
        modelUsage: [],
      });

      const result = await describeStep(ctx({ deps: { runClaude: claude.run } }));

      expect(result.ok).toBe(true);
      expect(result.facts?.narrative).toBeUndefined();
      // The step still reports WHY, so the run log distinguishes a failed describer from a silent one.
      expect(result.detail).toContain("describer reported an error");
    });

    it("a broken worktree (no git repo at all) reports ok:true with no narrative", async () => {
      rmSync(join(dir, ".git"), { recursive: true, force: true });
      const claude = fakeClaude("never reached");

      const result = await describeStep(ctx({ deps: { runClaude: claude.run } }));

      expect(result.ok).toBe(true);
      expect(claude.calls).toHaveLength(0);
      expect(result.facts?.narrative).toBeUndefined();
    });
  });

  describe("malformed or partial reports yield no narrative, never a violation", () => {
    it("no report at all", async () => {
      const claude = fakeClaude("I wrote the description in prose above, no block.");
      const result = await describeStep(ctx({ deps: { runClaude: claude.run } }));
      expect(result.ok).toBe(true);
      expect(result.facts?.narrative).toBeUndefined();
    });

    it("garbled json", async () => {
      const claude = fakeClaude("```json\n{not valid json\n```\n");
      const result = await describeStep(ctx({ deps: { runClaude: claude.run } }));
      expect(result.ok).toBe(true);
      expect(result.facts?.narrative).toBeUndefined();
    });

    it("a report missing the required summary field", async () => {
      const claude = fakeClaude(report(JSON.stringify({ narrative: { spotlight: "only this" } })));
      const result = await describeStep(ctx({ deps: { runClaude: claude.run } }));
      expect(result.ok).toBe(true);
      expect(result.facts?.narrative).toBeUndefined();
    });

    it("no narrative key at all in the block", async () => {
      const claude = fakeClaude(report(JSON.stringify({ score: 10 })));
      const result = await describeStep(ctx({ deps: { runClaude: claude.run } }));
      expect(result.ok).toBe(true);
      expect(result.facts?.narrative).toBeUndefined();
    });
  });

  describe("sanitization", () => {
    it("caps an oversized field", async () => {
      const huge = "x".repeat(5000);
      const claude = fakeClaude(report(JSON.stringify({ narrative: { summary: huge } })));

      const result = await describeStep(ctx({ deps: { runClaude: claude.run } }));

      expect(result.facts?.narrative?.summary.length).toBeLessThan(5000);
      expect(result.facts?.narrative?.summary).toContain("[truncated]");
    });

    it("strips control bytes and invisible unicode", async () => {
      // Built from code points, deliberately, rather than written as literal characters or string
      // escapes: a BEL (C0 control byte), a ZWSP and an RLO/PDF bidi-override pair are exactly what
      // this repo's own control-bytes / invisible-unicode gate rejects in TRACKED source — building
      // them at runtime keeps this file itself clean of the bytes it is testing the strip of.
      const bel = String.fromCharCode(0x07);
      const zwsp = String.fromCodePoint(0x200b);
      const rlo = String.fromCodePoint(0x202e);
      const pdf = String.fromCodePoint(0x202c);
      const dirty = `clean${bel}text${zwsp}with${rlo}hidden${pdf}stuff`;
      const claude = fakeClaude(report(JSON.stringify({ narrative: { summary: dirty } })));

      const result = await describeStep(ctx({ deps: { runClaude: claude.run } }));

      const summary = result.facts?.narrative?.summary ?? "";
      expect(summary).not.toMatch(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/);
      expect(summary).not.toContain(zwsp);
      expect(summary).not.toContain(rlo);
      expect(summary).toBe("cleantextwithhiddenstuff");
    });
  });

  describe("contract precedence", () => {
    it("falls back to anton's shipped describe skill when nothing is configured", async () => {
      const claude = fakeClaude(report(JSON.stringify({ narrative: { summary: "did stuff" } })));

      await describeStep(ctx({ deps: { runClaude: claude.run } }));

      expect(claude.calls[0].prompt).toContain("# Describing a run's PR");
    });

    it("a project describePrompt setting beats the shipped skill", async () => {
      const claude = fakeClaude(report(JSON.stringify({ narrative: { summary: "did stuff" } })));

      await describeStep(
        ctx({ settings: { describePrompt: "OPERATOR DESCRIBE CONTRACT." }, deps: { runClaude: claude.run } }),
      );

      expect(claude.calls[0].prompt).toContain("OPERATOR DESCRIBE CONTRACT.");
      expect(claude.calls[0].prompt).not.toContain("# Describing a run's PR");
    });

    it("a prompt: label on the step beats the project setting and the shipped skill", async () => {
      commitFile(`.claude/agents/${AGENT_ID}.md`, agentFile(AGENT_ID, "DESCRIBE AS THE NAMED AGENT."));
      const claude = fakeClaude(report(JSON.stringify({ narrative: { summary: "did stuff" } })));

      await describeStep(
        ctx({
          step: { id: "describe", labels: ["step:describe", `prompt:${AGENT_ID}`] },
          settings: { describePrompt: "OPERATOR DESCRIBE CONTRACT." },
          deps: { runClaude: claude.run },
        }),
      );

      expect(claude.calls[0].prompt).toContain("DESCRIBE AS THE NAMED AGENT.");
      expect(claude.calls[0].prompt).not.toContain("OPERATOR DESCRIBE CONTRACT.");
      // Frontmatter is stripped.
      expect(claude.calls[0].prompt).not.toContain(`name: ${AGENT_ID}`);
    });

    it("a skill: label on the step beats the project setting and the shipped skill", async () => {
      commitFile(`.claude/skills/${SKILL_ID}/SKILL.md`, skillFile(SKILL_ID, "DESCRIBE AS THE NAMED SKILL."));
      const claude = fakeClaude(report(JSON.stringify({ narrative: { summary: "did stuff" } })));

      await describeStep(
        ctx({
          step: { id: "describe", labels: ["step:describe", `skill:${SKILL_ID}`] },
          settings: { describePrompt: "OPERATOR DESCRIBE CONTRACT." },
          deps: { runClaude: claude.run },
        }),
      );

      expect(claude.calls[0].prompt).toContain("DESCRIBE AS THE NAMED SKILL.");
      expect(claude.calls[0].prompt).not.toContain("OPERATOR DESCRIBE CONTRACT.");
    });

    it("falls through to the next tier when the named prompt resolves to nothing", async () => {
      const claude = fakeClaude(report(JSON.stringify({ narrative: { summary: "did stuff" } })));

      await describeStep(
        ctx({
          step: { id: "describe", labels: ["step:describe", "prompt:no-such-agent-anywhere"] },
          settings: { describePrompt: "OPERATOR DESCRIBE CONTRACT." },
          deps: { runClaude: claude.run },
        }),
      );

      expect(claude.calls[0].prompt).toContain("OPERATOR DESCRIBE CONTRACT.");
    });

    it("reads the prompt: label's content at the BASE revision, never from the worktree", async () => {
      // Committed on `base` — this is what the run forked from.
      commitFile(`.claude/agents/${AGENT_ID}.md`, agentFile(AGENT_ID, "BASE CONTRACT."));
      // The run's OWN diff then rewrites the very file that describes it, on its own branch.
      checkoutRun();
      commitFile(`.claude/agents/${AGENT_ID}.md`, agentFile(AGENT_ID, "REWRITTEN BY THE RUN'S OWN DIFF."));

      const claude = fakeClaude(report(JSON.stringify({ narrative: { summary: "did stuff" } })));

      await describeStep(
        ctx({
          step: { id: "describe", labels: ["step:describe", `prompt:${AGENT_ID}`] },
          baseRef: "base",
          deps: { runClaude: claude.run },
        }),
      );

      // `baseRef` ("base") still points at the first commit, since it was never moved — merge-base
      // against the run's own later commit resolves back to it. Check only the RESOLVED CONTRACT —
      // the part before the run context — since the diff section further down legitimately quotes
      // the rewrite as part of what this run changed; that is not the reasoning contract itself.
      const [reasoning] = claude.calls[0].prompt.split("\n\n---\n\n");
      expect(reasoning).toBe("BASE CONTRACT.");
    });
  });
});

describe("parseNarrativeReport", () => {
  it("reads the LAST fenced json block", () => {
    const text = [
      "```json",
      JSON.stringify({ narrative: { summary: "first draft" } }),
      "```",
      "actually, let me redo that.",
      "```json",
      JSON.stringify({ narrative: { summary: "final" } }),
      "```",
    ].join("\n");
    expect(parseNarrativeReport(text)?.summary).toBe("final");
  });

  it("returns undefined for undefined text", () => {
    expect(parseNarrativeReport(undefined)).toBeUndefined();
  });
});
