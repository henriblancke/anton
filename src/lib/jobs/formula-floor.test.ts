/**
 * anton's invariant floor (anton-6b99). Two things have to hold for a project-owned pipeline to be
 * safe to allow:
 *
 * 1. **Omission and mis-ordering are rejected, each naming the offending step** — a formula with no
 *    `pr`, or one that opens the PR before it commits, must never run. The table below is the whole
 *    rejection surface, proved without a filesystem, bd, or execute-epic.
 * 2. **Extension is always accepted.** A project adding steps beyond the floor is the point of the
 *    formula being project-owned; the floor constrains what may be left out, not what may be added.
 *
 * The shipped default is checked against the floor from the ASSET, so an edit to anton's own
 * pipeline that breaks its guarantees reddens here.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import type { CookedFormula, CookedStep } from "../beads/bd";
import { PoisonEpic } from "./errors";
import { assertRunFormulaFloor, checkFormulaFloor, type StepRegistry } from "./formula-floor";
import { bundledRunFormulaPath, parseRunFormulaSource } from "./run-formula";
import { BUILTIN_STEPS } from "./step-registry";

/** A cooked step, written the way a formula names its handler: an id plus one `step:<name>` label. */
const step = (id: string, name: string): CookedStep => ({ id, labels: [`step:${name}`] });

const formula = (steps: CookedStep[]): CookedFormula => ({ formula: "anton-run", steps });

const check = (steps: CookedStep[]) => checkFormulaFloor(formula(steps), BUILTIN_STEPS);

/** Today's shipped pipeline, as the cooked steps the walker sees. */
const DEFAULT_STEPS: CookedStep[] = [
  step("implement", "implement"),
  step("verify", "verify"),
  step("commit", "commit"),
  step("review", "review"),
  step("pr", "pr"),
];

describe("the floor accepts", () => {
  it("anton's shipped default, read from the asset it installs", () => {
    const doc = parseRunFormulaSource(readFileSync(bundledRunFormulaPath(), "utf8"), bundledRunFormulaPath());
    const steps = (doc.steps as Array<Record<string, unknown>>).map((s) => ({
      id: s.id as string,
      labels: s.labels as string[],
    }));

    expect(checkFormulaFloor(formula(steps), BUILTIN_STEPS)).toEqual({ ok: true, violations: [] });
  });

  it("the bare floor: implement → commit → pr and nothing else", () => {
    expect(check([step("i", "implement"), step("c", "commit"), step("p", "pr")]).ok).toBe(true);
  });

  it("a formula that ADDS three steps beyond the floor", () => {
    const extended = [
      step("plan", "claude"),
      step("implement", "implement"),
      step("docs", "claude"),
      step("verify", "verify"),
      step("commit", "commit"),
      step("review", "review"),
      step("recheck", "verify"),
      step("pr", "pr"),
    ];

    expect(check(extended)).toEqual({ ok: true, violations: [] });
  });

  it("a formula that drops the default-on steps — that costs quality, never the run's integrity", () => {
    expect(check([step("implement", "implement"), step("commit", "commit"), step("pr", "pr")]).ok).toBe(
      true,
    );
  });
});

describe("the floor rejects an omitted required step, naming it", () => {
  // One case per required step: drop it, and only it, from today's default.
  it.each([
    { omitted: "implement", summary: /dispatch the ticket's agent/ },
    { omitted: "commit", summary: /evidence of record/ },
    { omitted: "pr", summary: /single pull request/ },
  ])("rejects a pipeline with no `step:$omitted`", ({ omitted, summary }) => {
    const { ok, violations } = check(DEFAULT_STEPS.filter((s) => s.id !== omitted));

    expect(ok).toBe(false);
    expect(violations).toHaveLength(1);
    expect(violations[0].kind).toBe("missing-required-step");
    expect(violations[0].step).toBe(`step:${omitted}`);
    expect(violations[0].detail).toContain(`step:${omitted}`);
    expect(violations[0].detail).toMatch(summary);
  });

  it("reports EVERY omission at once, so the file is fixed in one pass", () => {
    const { violations } = check([step("implement", "implement")]);

    expect(violations.map((v) => v.step)).toEqual(["step:commit", "step:pr"]);
  });
});

describe("the floor rejects broken ordering", () => {
  it("a PR opened before the commit", () => {
    const { ok, violations } = check([
      step("implement", "implement"),
      step("ship", "pr"),
      step("commit", "commit"),
    ]);

    expect(ok).toBe(false);
    expect(violations.map((v) => v.kind)).toEqual(["pr-before-commit"]);
    expect(violations[0].step).toBe("ship");
    expect(violations[0].detail).toContain('"ship"');
    expect(violations[0].detail).toContain('"commit"');
  });

  it("a step that writes to the worktree after the commit — its work would be thrown away", () => {
    const { ok, violations } = check([
      step("implement", "implement"),
      step("commit", "commit"),
      step("polish", "claude"),
      step("pr", "pr"),
    ]);

    expect(ok).toBe(false);
    expect(violations.map((v) => v.kind)).toEqual(["diff-after-commit"]);
    expect(violations[0].step).toBe("polish");
    expect(violations[0].detail).toContain("never be committed");
  });

  it("implement placed after the commit — the same rule, applied to a required step", () => {
    const { violations } = check([
      step("commit", "commit"),
      step("implement", "implement"),
      step("pr", "pr"),
    ]);

    expect(violations.map((v) => [v.kind, v.step])).toEqual([["diff-after-commit", "implement"]]);
  });

  it("but accepts the review gate after the commit — it commits its own fixes", () => {
    expect(
      check([step("implement", "implement"), step("commit", "commit"), step("review", "review"), step("pr", "pr")])
        .ok,
    ).toBe(true);
  });
});

describe("the floor rejects a step declared twice", () => {
  it("a duplicate step id — `needs` and the run log could not tell them apart", () => {
    const { ok, violations } = check([
      step("implement", "implement"),
      step("implement", "claude"),
      step("commit", "commit"),
      step("pr", "pr"),
    ]);

    expect(ok).toBe(false);
    expect(violations.map((v) => v.kind)).toContain("duplicate-step-id");
    expect(violations.find((v) => v.kind === "duplicate-step-id")?.step).toBe("implement");
  });

  it("a required step declared twice — one run is one commit point and one PR", () => {
    const { ok, violations } = check([
      step("implement", "implement"),
      step("commit", "commit"),
      step("pr", "pr"),
      step("pr-again", "pr"),
    ]);

    expect(ok).toBe(false);
    expect(violations.map((v) => v.kind)).toEqual(["duplicate-required-step"]);
    expect(violations[0].step).toBe("pr, pr-again");
  });

  it("but accepts an additive step used as many times as the project likes", () => {
    expect(
      check([
        step("scout", "claude"),
        step("implement", "implement"),
        step("docs", "claude"),
        step("commit", "commit"),
        step("pr", "pr"),
      ]).ok,
    ).toBe(true);
  });
});

describe("the floor rejects a step it cannot classify", () => {
  it("a `step:` label that maps to no handler", () => {
    const { ok, violations } = check([
      step("implement", "implement"),
      step("commit", "commit"),
      step("deploy", "deploy"),
      step("pr", "pr"),
    ]);

    expect(ok).toBe(false);
    expect(violations.map((v) => [v.kind, v.step])).toEqual([["unresolved-step", "deploy"]]);
    expect(violations[0].detail).toContain("step:deploy");
  });

  it("a step carrying no `step:` label at all", () => {
    const { violations } = check([
      { id: "mystery", labels: ["priority:1"] },
      step("implement", "implement"),
      step("commit", "commit"),
      step("pr", "pr"),
    ]);

    expect(violations.map((v) => [v.kind, v.step])).toEqual([["unresolved-step", "mystery"]]);
  });

  it("a pipeline with no steps at all", () => {
    const { ok, violations } = check([]);

    expect(ok).toBe(false);
    expect(violations.map((v) => v.step)).toEqual(["step:implement", "step:commit", "step:pr"]);
  });
});

describe("the check reads the registry it is given, not a list of its own", () => {
  // The floor is made of the registry's CLASSES (anton-4npr). Promoting a step to `required` in the
  // registry must move the floor with it — otherwise the two definitions drift.
  const verifyIsRequired: StepRegistry = {
    ...BUILTIN_STEPS,
    verify: { ...BUILTIN_STEPS.verify, class: "required" },
  };

  it("enforces a step the given registry marks required", () => {
    const bare = formula([step("implement", "implement"), step("commit", "commit"), step("pr", "pr")]);

    expect(checkFormulaFloor(bare, BUILTIN_STEPS).ok).toBe(true);
    expect(checkFormulaFloor(bare, verifyIsRequired).violations.map((v) => v.step)).toEqual([
      "step:verify",
    ]);
  });

  it("holds a step to the diff rule only when the registry says it writes to the worktree", () => {
    const reviewWrites: StepRegistry = {
      ...BUILTIN_STEPS,
      review: { ...BUILTIN_STEPS.review, producesDiff: true },
    };
    const afterCommit = formula([
      step("implement", "implement"),
      step("commit", "commit"),
      step("review", "review"),
      step("pr", "pr"),
    ]);

    expect(checkFormulaFloor(afterCommit, BUILTIN_STEPS).ok).toBe(true);
    expect(checkFormulaFloor(afterCommit, reviewWrites).violations.map((v) => v.kind)).toEqual([
      "diff-after-commit",
    ]);
  });
});

describe("assertRunFormulaFloor", () => {
  const source = "/repo/.beads/formulas/anton-run.formula.toml";

  it("passes a formula that meets the floor", () => {
    expect(() =>
      assertRunFormulaFloor({ source, cooked: formula(DEFAULT_STEPS) }),
    ).not.toThrow();
  });

  it("parks with the file, every offending step, and what the floor requires", () => {
    let thrown: unknown;
    try {
      // Two faults at once: no `implement` step, and the PR opens before the commit.
      assertRunFormulaFloor({
        source,
        cooked: formula([step("ship", "pr"), step("commit", "commit")]),
      });
    } catch (e) {
      thrown = e;
    }

    // Poison, so the runner parks for a human instead of burning retry attempts on a config problem.
    expect(thrown).toBeInstanceOf(PoisonEpic);
    const message = (thrown as Error).message;
    expect(message).toContain(source);
    expect(message).toContain('"ship"'); // the mis-ordered step
    expect(message).toContain("step:implement"); // the omitted one
    expect(message).toMatch(/implement, commit, and open a PR, in that order/);
    // Actionable: the operator is told the way back.
    expect(message).toMatch(/delete it to fall back to anton's default/);
  });
});
