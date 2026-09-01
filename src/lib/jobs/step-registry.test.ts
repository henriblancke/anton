/**
 * Unit tests for the pipeline step registry (anton-4npr): what a `step:<name>` label resolves to,
 * what parks when it resolves to nothing, and how the generic `step:claude` extension point behaves.
 *
 * The claude driver is FAKE (the `deps.runClaude` seam) but the db is real (an in-memory anton.db),
 * so "the step records a session" is asserted on the rows the UI reads rather than on a spy.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { schema } from "../db";
import type { Bead } from "../beads/bd";
import type { ClaudeResult, RunClaudeOptions } from "../claude/driver";
import type { ProjectSettings } from "../projects";
import { ANTON_REPO_URL } from "../repo";
import { isPoisonError, isUsageLimitError, RunAlreadyLiveError, UsageLimitError } from "./errors";
import type { Clock } from "./queue";
import {
  BUILTIN_STEPS,
  REQUIRED_STEP_NAMES,
  claudeStep,
  commitStep,
  implementStep,
  prBody,
  prStep,
  resolveStep,
  reviewStep,
  stepName,
  stepSubject,
  verifyStep,
  type CookedStep,
  type StepContext,
} from "./step-registry";
import { makeProjectDb, type TestProjectDb } from "@/lib/testing/project";

const FORMULA = ".beads/formulas/anton-run.formula.toml";

class FixedClock implements Clock {
  constructor(private t: number) {}
  now() {
    return this.t;
  }
}

const target: Bead = {
  id: "anton-step1",
  title: "Ship the registry",
  status: "in_progress",
  issue_type: "feature",
  description: "## Goal\n\nSteps resolve.\n\n## Acceptance\n\n- [ ] they do\n",
};

/** A fake claude driver: scripted replies plus the options each dispatch actually received. */
function fakeClaude(...replies: Array<string | ClaudeResult | Error>) {
  const calls: RunClaudeOptions[] = [];
  const run = async (options: RunClaudeOptions): Promise<ClaudeResult> => {
    calls.push(options);
    const next = replies[calls.length - 1];
    if (next === undefined) throw new Error(`unscripted claude dispatch #${calls.length}`);
    if (next instanceof Error) throw next;
    return typeof next === "string" ? { ok: true, text: next } : next;
  };
  return { run, calls };
}

let dir: string;
let tdb: TestProjectDb;
let projectId: string;
let runId: string;
let priorSessionsRoot: string | undefined;
const clock = new FixedClock(1_700_000_000_000);
const settings: ProjectSettings = {};

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "anton-step-registry-"));
  priorSessionsRoot = process.env.ANTON_SESSIONS_ROOT;
  process.env.ANTON_SESSIONS_ROOT = join(dir, "sessions");
  tdb = makeProjectDb({ repoPath: dir });
  projectId = tdb.projectId;
  runId = randomUUID();
  await tdb.db.insert(schema.runs).values({
    id: runId,
    projectId,
    epicBeadId: target.id,
    branch: "anton/anton-step1",
    status: "running",
  });
});

afterEach(() => {
  tdb.close();
  if (priorSessionsRoot === undefined) delete process.env.ANTON_SESSIONS_ROOT;
  else process.env.ANTON_SESSIONS_ROOT = priorSessionsRoot;
  rmSync(dir, { recursive: true, force: true });
});

function context(overrides: Partial<StepContext> = {}): StepContext {
  return {
    db: tdb.db,
    clock,
    ctx: { signal: new AbortController().signal, heartbeat: async () => {}, report: () => {} },
    projectId,
    runId,
    repoPath: dir,
    worktreePath: dir,
    branch: "anton/anton-step1",
    baseBranch: "main",
    baseRef: "origin/main",
    target,
    tickets: [target],
    settings,
    ...overrides,
  };
}

/** A formula step as the cooked formula carries it. */
function cooked(id: string, labels: string[]): CookedStep {
  return { id, labels };
}

/** Write a project-local prompt (`.claude/agents/<id>.md`) into the worktree. */
function writeProjectPrompt(id: string, body: string): void {
  mkdirSync(join(dir, ".claude", "agents"), { recursive: true });
  writeFileSync(join(dir, ".claude", "agents", `${id}.md`), body);
}

describe("resolveStep", () => {
  it("resolves every built-in label to its handler", () => {
    const expected: Array<[string, unknown, string[]]> = [
      ["implement", implementStep, []],
      ["verify", verifyStep, []],
      ["review", reviewStep, []],
      ["commit", commitStep, []],
      ["pr", prStep, []],
      // The extension point only resolves once it names what to dispatch (below).
      ["claude", claudeStep, ["prompt:smoke"]],
    ];
    for (const [name, handler, extra] of expected) {
      const definition = resolveStep(cooked(name, [`step:${name}`, ...extra]), FORMULA);
      expect(definition.name).toBe(name);
      expect(definition.handler).toBe(handler);
    }
  });

  // Without this the step resolves cleanly and the run parks only when the step is REACHED — after
  // `implement` has already committed work to the worktree, which is the halfway failure run-start
  // validation exists to prevent.
  it("parks at resolution on a step:claude that names neither a prompt nor a skill", () => {
    let raised: unknown;
    try {
      resolveStep(cooked("custom", ["step:claude"]), FORMULA);
    } catch (e) {
      raised = e;
    }
    expect(isPoisonError(raised)).toBe(true);
    const message = (raised as Error).message;
    expect(message).toContain('"custom"');
    expect(message).toContain(FORMULA);
    expect(message).toContain("prompt:<id>");
    expect(message).toContain("skill:<id>");
  });

  it("resolves a step:claude that names either a prompt or a skill", () => {
    expect(resolveStep(cooked("a", ["step:claude", "prompt:smoke"]), FORMULA).name).toBe("claude");
    expect(resolveStep(cooked("b", ["step:claude", "skill:review"]), FORMULA).name).toBe("claude");
  });

  // Dispatch reads `prompt:` first and takes the first label of a prefix by array order, so a second
  // instruction would be silently dropped — which one depending on how the labels happened to sort.
  it.each([
    ["a prompt and a skill", ["step:claude", "prompt:security", "skill:release"]],
    ["two prompts", ["step:claude", "prompt:security", "prompt:release"]],
    ["two skills", ["step:claude", "skill:security", "skill:release"]],
  ])("parks on a step:claude naming %s, rather than picking by order", (_what, labels) => {
    let raised: unknown;
    try {
      resolveStep(cooked("custom", labels), FORMULA);
    } catch (e) {
      raised = e;
    }
    expect(isPoisonError(raised)).toBe(true);
    const message = (raised as Error).message;
    expect(message).toContain('"custom"');
    expect(message).toContain(FORMULA);
    // Both instructions are named, so the operator can see which two they wrote.
    for (const label of labels.slice(1)) expect(message).toContain(label);
  });

  // A valueless `prompt:` names nothing to dispatch, so it must read as "names no prompt" rather
  // than pushing a step that DOES name one into the ambiguity rejection.
  it("ignores a valueless instruction label when counting what a step:claude names", () => {
    expect(resolveStep(cooked("a", ["step:claude", "prompt:", "skill:review"]), FORMULA).name).toBe(
      "claude",
    );
    let raised: unknown;
    try {
      resolveStep(cooked("bare", ["step:claude", "prompt:"]), FORMULA);
    } catch (e) {
      raised = e;
    }
    expect(isPoisonError(raised)).toBe(true);
    expect((raised as Error).message).toContain("prompt:<id>");
  });

  // `["step:implement", "step:verify"]` would resolve to implement by array order alone and silently
  // never verify — and the floor, seeing a resolved implement, would pass the formula.
  it("parks on a step carrying more than one step: label, rather than picking by order", () => {
    let raised: unknown;
    try {
      resolveStep(cooked("both", ["step:implement", "step:verify"]), FORMULA);
    } catch (e) {
      raised = e;
    }
    expect(isPoisonError(raised)).toBe(true);
    const message = (raised as Error).message;
    expect(message).toContain('"both"');
    expect(message).toContain("step:implement");
    expect(message).toContain("step:verify");
    expect(message).toContain(FORMULA);
  });

  it("declares the class of each built-in — required, default-on, additive", () => {
    expect(BUILTIN_STEPS.implement.class).toBe("required");
    expect(BUILTIN_STEPS.commit.class).toBe("required");
    expect(BUILTIN_STEPS.pr.class).toBe("required");
    expect(BUILTIN_STEPS.verify.class).toBe("default-on");
    expect(BUILTIN_STEPS.review.class).toBe("default-on");
    expect(BUILTIN_STEPS.claude.class).toBe("additive");
    // The floor the validator (anton-6b99) enforces — a formula may not omit these.
    expect([...REQUIRED_STEP_NAMES].sort()).toEqual(["commit", "implement", "pr"]);
  });

  it("parks on an unregistered step, naming the step id, the label and the formula file", () => {
    let raised: unknown;
    try {
      resolveStep(cooked("deploy", ["step:deploy", "domain:eng"]), FORMULA);
    } catch (e) {
      raised = e;
    }
    expect(isPoisonError(raised)).toBe(true);
    const message = (raised as Error).message;
    expect(message).toContain('"deploy"');
    expect(message).toContain("step:deploy");
    expect(message).toContain(FORMULA);
    // Fail loud means telling the operator the way out, not just that it broke.
    expect(message).toContain("step:claude");
  });

  it("parks on a step carrying no step: label at all", () => {
    expect(() => resolveStep(cooked("mystery", ["domain:eng"]), FORMULA)).toThrow(/no `step:<name>`/);
  });

  it("names verify gates when a formula reaches for the deliberately-absent step:shell", () => {
    expect(() => resolveStep(cooked("smoke", ["step:shell"]), FORMULA)).toThrow(/verify gate/i);
  });

  it("reads the handler name off the step's labels", () => {
    expect(stepName(cooked("x", ["domain:eng", "step:implement"]))).toBe("implement");
    expect(stepName(cooked("x", ["domain:eng"]))).toBeUndefined();
  });
});

describe("stepSubject — which bead a step speaks for", () => {
  const ticket = (id: string): Bead => ({ ...target, id, title: `ticket ${id}` });

  it("names the ticket when a step covers exactly one — the walk's ticket phase", () => {
    expect(stepSubject({ target, tickets: [ticket("anton-a")] }).id).toBe("anton-a");
  });

  // A run-phase step (verify moved after the commit, the review gate, the PR) is handed every live
  // ticket and covers all of them, so its session and failure message must not be filed under
  // whichever ticket happened to be first.
  it("names the run target when a step covers several — the walk's run phase", () => {
    expect(stepSubject({ target, tickets: [ticket("anton-a"), ticket("anton-b")] }).id).toBe(
      target.id,
    );
  });

  it("falls back to the target when a step covers no tickets at all", () => {
    expect(stepSubject({ target, tickets: [] }).id).toBe(target.id);
  });
});

describe("step:verify", () => {
  // A formula that moves `step:verify` after the commit runs it in the RUN phase, where no session
  // is handed in — so this handler opens its own. Without a report, the job's live handle keeps
  // naming the last ticket's already-ended session and observe/investigate attaches to stale output
  // for the whole of a potentially long run-wide gate.
  it("reports the session it opened, so the live handle names the gates' own output", async () => {
    const reported: Array<{ sessionId?: string; cwd?: string }> = [];
    const ctx = context({ settings: { testCommand: "exit 0" } });
    const result = await verifyStep({
      ...ctx,
      ctx: { ...ctx.ctx, report: (info) => reported.push(info) },
    });

    expect(result.ok).toBe(true);
    const sessionId = result.facts?.sessionIds?.[0];
    expect(sessionId).toBeTruthy();
    expect(reported).toEqual([{ sessionId, cwd: ctx.worktreePath }]);
  });

  // No gates ⇒ nothing runs and no session is opened, so there is nothing to point the handle at.
  it("reports nothing when the project pinned no gates", async () => {
    const reported: unknown[] = [];
    const ctx = context();
    const result = await verifyStep({
      ...ctx,
      ctx: { ...ctx.ctx, report: (info) => reported.push(info) },
    });

    expect(result.ok).toBe(true);
    expect(reported).toEqual([]);
  });
});

describe("step:claude", () => {
  it("dispatches the project-named prompt and records a session", async () => {
    writeProjectPrompt("design-check", "---\nname: design-check\n---\nCheck the design system.");
    const claude = fakeClaude("done here\n\nANTON-RESULT: delivered");

    const result = await claudeStep(
      context({
        step: cooked("design", ["step:claude", "prompt:design-check"]),
        deps: { runClaude: claude.run },
      }),
    );

    expect(result.ok).toBe(true);
    expect(claude.calls).toHaveLength(1);
    const dispatch = claude.calls[0];
    // The project's prompt is the reasoning contract, and the run context rides below it.
    expect(dispatch.prompt).toContain("Check the design system.");
    expect(dispatch.prompt).toContain(target.id);
    expect(dispatch.cwd).toBe(dir);
    // The operating contract still binds — the step never dispatches without the base system prompt.
    expect(dispatch.appendSystemPrompt).toBeTruthy();
    // The agent's self-report is parsed out of the final message, as for any other dispatch.
    expect(result.facts?.selfReport?.outcome).toBe("delivered");

    const sessions = await tdb.db.select().from(schema.sessions);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({ projectId, runId, kind: "execute", status: "done" });
  });

  it("resolves a project skill when the step names one", async () => {
    mkdirSync(join(dir, ".claude", "skills", "smoke"), { recursive: true });
    writeFileSync(join(dir, ".claude", "skills", "smoke", "SKILL.md"), "Run the smoke checks.");
    const claude = fakeClaude("ANTON-RESULT: delivered");

    await claudeStep(
      context({
        step: cooked("smoke", ["step:claude", "skill:smoke"]),
        deps: { runClaude: claude.run },
      }),
    );

    expect(claude.calls[0].prompt).toContain("Run the smoke checks.");
  });

  it("parks when the step names no prompt at all", async () => {
    const claude = fakeClaude("never dispatched");
    await expect(
      claudeStep(context({ step: cooked("mystery", ["step:claude"]), deps: { runClaude: claude.run } })),
    ).rejects.toSatisfy(isPoisonError);
    expect(claude.calls).toHaveLength(0);
  });

  // The backstop for a caller invoking the handler directly: run-start validation rejects this, but
  // dispatching one of the two by label order would be the silent drop it exists to prevent.
  it("parks when the step names two instructions", async () => {
    writeProjectPrompt("design-check", "Check the design system.");
    const claude = fakeClaude("never dispatched");
    await expect(
      claudeStep(
        context({
          step: cooked("ambiguous", ["step:claude", "prompt:design-check", "skill:smoke"]),
          deps: { runClaude: claude.run },
        }),
      ),
    ).rejects.toSatisfy(isPoisonError);
    expect(claude.calls).toHaveLength(0);
  });

  it("parks when the named prompt resolves nowhere", async () => {
    const claude = fakeClaude("never dispatched");
    await expect(
      claudeStep(
        context({
          step: cooked("ghost", ["step:claude", "prompt:not-a-real-prompt"]),
          deps: { runClaude: claude.run },
        }),
      ),
    ).rejects.toSatisfy(isPoisonError);
    expect(claude.calls).toHaveLength(0);
  });

  it("honours the run lease — a lapsed lease yields before any dispatch", async () => {
    writeProjectPrompt("design-check", "Check the design system.");
    const claude = fakeClaude("never dispatched");

    await expect(
      claudeStep(
        context({
          step: cooked("design", ["step:claude", "prompt:design-check"]),
          assertLeaseHeld: () => {
            throw new RunAlreadyLiveError("lease lapsed", "unproven");
          },
          deps: { runClaude: claude.run },
        }),
      ),
    ).rejects.toThrow(/lease lapsed/);
    expect(claude.calls).toHaveLength(0);
  });

  it("propagates a usage limit unchanged, so the runner parks and reschedules", async () => {
    writeProjectPrompt("design-check", "Check the design system.");
    const claude = fakeClaude(new UsageLimitError("Claude AI usage limit reached", 1_700_000_600));

    const raised = await claudeStep(
      context({
        step: cooked("design", ["step:claude", "prompt:design-check"]),
        deps: { runClaude: claude.run },
      }),
    ).catch((e) => e);

    // Unwrapped: the runner keys its quota backoff off the error's TYPE.
    expect(isUsageLimitError(raised)).toBe(true);
    expect((raised as UsageLimitError).resetAt).toBe(1_700_000_600);
    // The session it opened is closed as failed rather than left running.
    const sessions = await tdb.db.select().from(schema.sessions);
    expect(sessions).toHaveLength(1);
    expect(sessions[0].status).toBe("failed");
  });

  it("records into the caller's session when one is handed in, and leaves it open", async () => {
    writeProjectPrompt("design-check", "Check the design system.");
    const claude = fakeClaude("ANTON-RESULT: delivered");
    const { startJobSession } = await import("../sessions");
    const session = await startJobSession(tdb.db, clock, {
      projectId,
      runId,
      kind: "execute",
      beadId: target.id,
    });

    await claudeStep(
      context({
        step: cooked("design", ["step:claude", "prompt:design-check"]),
        session,
        deps: { runClaude: claude.run },
      }),
    );

    const sessions = await tdb.db.select().from(schema.sessions);
    expect(sessions).toHaveLength(1);
    // The caller owns its lifecycle — the step must not close a session it did not open.
    expect(sessions[0].status).toBe("running");
  });
});

describe("prBody — the attribution footer", () => {
  // Pinned literally: a bare https://github.com/ still renders as a working link in the PR, so only
  // an exact assertion catches the attribution silently pointing at GitHub's homepage (anton-ztv7).
  it("links [anton] at the public repo, not GitHub's homepage", () => {
    const footer = "🤖 Generated with [anton](https://github.com/henriblancke/anton) autonomous execution";

    expect(prBody(target, [target]).split("\n").at(-1)).toBe(footer);
    // Also tied to the constant, so moving the repo moves the footer with it.
    expect(footer).toContain(`[anton](${ANTON_REPO_URL})`);
  });
});
