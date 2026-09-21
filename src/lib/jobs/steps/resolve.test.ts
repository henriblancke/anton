/**
 * Direct tests for resolution: a label becoming a handler, and a `step:claude` label becoming the
 * reasoning contract it dispatches.
 *
 * These drive `resolveStepIn` against a STUB registry, which is what makes the rules testable apart
 * from anton's own built-ins — the registry suite covers the built-ins themselves.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { CookedStep } from "../../beads/bd";
import { isPoisonError } from "../errors";
import type { StepContext } from "./context";
import type { StepDefinition } from "./result";
import * as stamp from "../../claude/skill-stamp.mjs";
import { loadStepReasoning, resolveStepIn, stepName, STEP_LABEL_PREFIX } from "./resolve";

const FORMULA = ".beads/formulas/anton-run.formula.toml";

const definition = (name: string): StepDefinition => ({
  name,
  class: "additive",
  summary: `the ${name} step`,
  producesDiff: false,
  handler: async () => ({ ok: true }),
});

const REGISTRY = Object.freeze({ build: definition("build"), claude: definition("claude") });

const cooked = (id: string, labels: string[]): CookedStep => ({ id, labels });

const raise = (fn: () => unknown): Error => {
  try {
    fn();
  } catch (e) {
    return e as Error;
  }
  throw new Error("expected a rejection");
};

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "anton-steps-resolve-"));
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true });
});

describe("stepName", () => {
  it("reads the handler name off the step's labels", () => {
    expect(STEP_LABEL_PREFIX).toBe("step");
    expect(stepName(cooked("x", ["domain:eng", "step:build"]))).toBe("build");
    expect(stepName(cooked("x", ["domain:eng"]))).toBeUndefined();
  });
});

describe("resolveStepIn", () => {
  it("resolves against the registry it is given, not a hard-coded one", () => {
    expect(resolveStepIn(REGISTRY, cooked("b", ["step:build"]), FORMULA)).toBe(REGISTRY.build);
  });

  // A silent skip would let a formula define a run that quietly never opens a PR, so every
  // rejection names the step id, the offending label and the file it came from.
  it.each([
    ["no step: label at all", ["domain:eng"], "step:<name>"],
    ["two step: labels", ["step:build", "step:claude"], "exactly one handler"],
    ["a step nothing answers to", ["step:deploy"], "maps to no anton handler"],
    ["the deliberately-absent step:shell", ["step:shell"], "verify gate"],
    ["a step:claude naming no instruction", ["step:claude"], "prompt:<id>"],
    ["a step:claude naming two", ["step:claude", "prompt:a", "skill:b"], "instruction labels"],
  ])("parks on %s", (_what, labels, needle) => {
    const raised = raise(() => resolveStepIn(REGISTRY, cooked("subject", labels), FORMULA));

    expect(isPoisonError(raised)).toBe(true);
    expect(raised.message).toContain('"subject"');
    expect(raised.message).toContain(FORMULA);
    expect(raised.message).toContain(needle);
  });

  // A valueless `prompt:` names nothing to dispatch, so it must not push a step that DOES name one
  // into the ambiguity rejection.
  it("ignores a valueless instruction label when counting what a step:claude names", () => {
    expect(resolveStepIn(REGISTRY, cooked("a", ["step:claude", "prompt:", "skill:b"]), FORMULA)).toBe(
      REGISTRY.claude,
    );
  });
});

describe("loadStepReasoning", () => {
  const ctx = (labels: string[]): StepContext =>
    ({ worktreePath: dir, step: cooked("custom", labels) }) as StepContext;

  /** Write a project-local skill and return its resolved reasoning. */
  const projectSkill = async (id: string, body: string) => {
    mkdirSync(join(dir, ".claude", "skills", id), { recursive: true });
    writeFileSync(join(dir, ".claude", "skills", id, "SKILL.md"), body);
    return loadStepReasoning(ctx(["step:claude", `skill:${id}`]), "custom");
  };

  it("reads a project prompt named by prompt:<id>, and names it as what resolved", async () => {
    mkdirSync(join(dir, ".claude", "agents"), { recursive: true });
    writeFileSync(join(dir, ".claude", "agents", "audit.md"), "---\nname: audit\n---\nAudit it.");

    const resolved = await loadStepReasoning(ctx(["step:claude", "prompt:audit"]), "custom");
    // A prompt carries no SKILL digest: the pair is mutually exclusive, so `skillId` must stay absent.
    expect(resolved).toMatchObject({ text: "Audit it.", promptId: "audit" });
    expect(resolved.skillId).toBeUndefined();
    // But it IS versioned by its own content, exactly like a skill (PR #313 review) — an edit to the
    // agent file that ran must move the stamp, or "did the prompt edit help" is unanswerable.
    expect(resolved.promptBodyDigest).toMatch(/^[0-9a-f]{12}$/);
  });

  // The same `prompt:<id>` is different TEXT after an edit — an id alone would pool two cohorts that
  // ran different instructions under one key.
  it("moves the prompt digest when the prompt that runs is edited", async () => {
    mkdirSync(join(dir, ".claude", "agents"), { recursive: true });
    writeFileSync(join(dir, ".claude", "agents", "audit.md"), "Audit it.");
    const before = await loadStepReasoning(ctx(["step:claude", "prompt:audit"]), "custom");

    writeFileSync(join(dir, ".claude", "agents", "audit.md"), "Audit it twice.");
    const after = await loadStepReasoning(ctx(["step:claude", "prompt:audit"]), "custom");

    expect(after.promptBodyDigest).not.toBe(before.promptBodyDigest);
  });

  it("reads a project skill named by skill:<id>, and names it with the version that ran", async () => {
    const resolved = await projectSkill("smoke", "Run the smoke checks.");

    expect(resolved).toMatchObject({ text: "Run the smoke checks.", skillId: "smoke" });
    expect(resolved.promptId).toBeUndefined();
    expect(resolved.skillDigest).toMatch(/^[0-9a-f]{12}$/);
  });

  // The same `skill:<id>` is different TEXT in another repo, and different text here after an edit
  // — an id alone would pool two cohorts that ran different instructions under one key.
  it("digests a project-local skill apart from the bundled one of the same name", async () => {
    const local = await projectSkill("review", "Review it our way.");
    const bundled = await loadStepReasoning(
      { worktreePath: join(dir, "empty"), step: cooked("custom", ["step:claude", "skill:review"]) } as StepContext,
      "custom",
    );

    expect(local.skillId).toBe(bundled.skillId);
    expect(local.text).not.toBe(bundled.text);
    expect(local.skillDigest).not.toBe(bundled.skillDigest);
    expect(bundled.skillDigest).toMatch(/^[0-9a-f]{12}$/);
  });

  // An edit to the copy that runs must move the stamp, or "did the reviewer skill edit help" is
  // unanswerable: both cohorts would carry the same key.
  it("moves the digest when the skill that runs is edited", async () => {
    const before = await projectSkill("smoke", "Run the smoke checks.");
    const after = await projectSkill("smoke", "Run the smoke checks twice.");

    expect(after.skillDigest).not.toBe(before.skillDigest);
  });

  // The digest is a ledger dimension, and recording never fails a run: a directory that cannot be
  // hashed costs the cohort key, never the dispatch that was about to run from text in hand.
  it("still dispatches when the skill's digest cannot be taken", async () => {
    const resolved = await projectSkill("smoke", "Run the smoke checks.");
    vi.spyOn(stamp, "skillDigest").mockImplementation(() => {
      throw new Error("unreadable");
    });

    const degraded = await loadStepReasoning(ctx(["step:claude", "skill:smoke"]), "custom");
    expect(degraded).toEqual({ text: resolved.text, skillId: "smoke", skillDigest: undefined });
  });

  // An agent dispatched with no instruction would burn a session and report whatever it invented.
  it("parks on a name that resolves nowhere", async () => {
    const raised = await loadStepReasoning(ctx(["step:claude", "prompt:ghost"]), "custom").catch(
      (e) => e,
    );

    expect(isPoisonError(raised)).toBe(true);
    expect((raised as Error).message).toContain("prompt:ghost");
  });
});
