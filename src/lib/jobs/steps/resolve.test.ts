/**
 * Direct tests for resolution: a label becoming a handler, and a `step:claude` label becoming the
 * reasoning contract it dispatches.
 *
 * These drive `resolveStepIn` against a STUB registry, which is what makes the rules testable apart
 * from anton's own built-ins — the registry suite covers the built-ins themselves.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { CookedStep } from "../../beads/bd";
import { isPoisonError } from "../errors";
import type { StepContext } from "./context";
import type { StepDefinition } from "./result";
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

afterEach(() => rmSync(dir, { recursive: true, force: true }));

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

  it("reads a project prompt named by prompt:<id>", async () => {
    mkdirSync(join(dir, ".claude", "agents"), { recursive: true });
    writeFileSync(join(dir, ".claude", "agents", "audit.md"), "---\nname: audit\n---\nAudit it.");

    expect(await loadStepReasoning(ctx(["step:claude", "prompt:audit"]), "custom")).toBe("Audit it.");
  });

  it("reads a project skill named by skill:<id>", async () => {
    mkdirSync(join(dir, ".claude", "skills", "smoke"), { recursive: true });
    writeFileSync(join(dir, ".claude", "skills", "smoke", "SKILL.md"), "Run the smoke checks.");

    expect(await loadStepReasoning(ctx(["step:claude", "skill:smoke"]), "custom")).toBe(
      "Run the smoke checks.",
    );
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
