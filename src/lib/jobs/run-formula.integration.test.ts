/**
 * The run formula against a REAL bd (anton-hrql).
 *
 * `run-formula.test.ts` proves the loader's judgement with a fake cook, which keeps the unit gate
 * hermetic but says nothing about the installed binary. This is the pin, and it pins two things the
 * unit tests structurally cannot:
 *
 * 1. **The shipped default cooks clean** through the real seam, and every step resolves — so a
 *    formula that only LOOKS right, or a bd whose formula schema moved, reddens here.
 * 2. **The unknown-key allowlist matches bd.** A formula using every key the loader honors must
 *    round-trip through a real cook with none dropped (a key wrongly on the list would be reported as
 *    unknown and falsely park a run), and a fabricated key must be dropped silently (which is the
 *    whole reason the check exists — bd exits 0 and says nothing).
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";

import { describeBd, makeBdRepo, type BdRepo } from "@/lib/testing/integration";
import { bundledRunFormulaPath, projectRunFormulaPath, validateRunFormula } from "./run-formula";

/** Every key the loader's allowlist honors, spread over the scopes bd applies them in. */
const ALL_KEYS_TOML = `formula = "all-keys"
description = "every key bd honors"
type = "workflow"
version = 1

[vars]
[vars.withdefault]
description = "d"
default = "t"
type = "string"
enum = ["t", "u"]
pattern = "^[tu]$"
[vars.required_one]
description = "no default — a compile cook keeps the placeholder"
required = true

[[steps]]
id = "first"
type = "task"
title = "First"
description = "body"
labels = ["step:implement"]
priority = 2
assignee = "me"
notes = "n"
condition = "always"

[[steps]]
id = "second"
type = "task"
title = "Second"
needs = ["first"]
[steps.gate]
type = "gh:run"
await_id = "run-1"
timeout = "1h"

[[steps]]
id = "third"
type = "task"
title = "Third"
depends_on = ["second"]
`;

describeBd("run formula (real bd)", () => {
  let bdRepo: BdRepo;
  let repo: string;

  /** Raw `bd cook --json` — the loader reads the typed seam, but the allowlist pin needs bd's own
   * output, which is the only place a dropped key is observable. */
  const cookRaw = (path: string): Record<string, unknown> =>
    JSON.parse(execFileSync("bd", ["cook", path, "--mode=compile", "--json"], { cwd: repo, encoding: "utf8" }));

  /** Install a project-local pipeline — the file that wins over anton's bundled default. */
  const writeProjectFormula = (toml: string): string => {
    const path = projectRunFormulaPath(repo);
    mkdirSync(join(repo, ".beads", "formulas"), { recursive: true });
    writeFileSync(path, toml, "utf8");
    return path;
  };

  beforeAll(() => {
    bdRepo = makeBdRepo();
    repo = bdRepo.repo;
  });

  afterAll(() => bdRepo?.cleanup());

  it("cooks anton's shipped default clean, with every step resolving to a handler", async () => {
    const validated = await validateRunFormula(repo);

    expect(validated.source).toBe(bundledRunFormulaPath());
    expect(validated.cooked.formula).toBe("anton-run");
    expect(validated.steps.map((s) => s.step.id)).toEqual([
      "implement",
      "verify",
      "commit",
      "review",
      "pr",
    ]);
    expect(validated.steps.map((s) => s.definition.name)).toEqual([
      "implement",
      "verify",
      "commit",
      "review",
      "pr",
    ]);
  });

  it("keeps every key the allowlist honors through a real cook — none silently dropped", () => {
    const path = join(bdRepo.dir, "all-keys.formula.toml");
    writeFileSync(path, ALL_KEYS_TOML, "utf8");
    const cooked = cookRaw(path);

    const vars = cooked.vars as Record<string, Record<string, unknown>>;
    expect(Object.keys(vars.withdefault).sort()).toEqual([
      "default",
      "description",
      "enum",
      "pattern",
      "type",
    ]);
    expect(Object.keys(vars.required_one).sort()).toEqual(["description", "required"]);

    const steps = cooked.steps as Array<Record<string, unknown>>;
    expect(Object.keys(steps[0]).sort()).toEqual([
      "assignee",
      "condition",
      "description",
      "id",
      "labels",
      "notes",
      "priority",
      "title",
      "type",
    ]);
    expect(Object.keys(steps[1]).sort()).toEqual(["gate", "id", "needs", "title", "type"]);
    expect(Object.keys(steps[1].gate as object).sort()).toEqual(["await_id", "timeout", "type"]);
    expect(Object.keys(steps[2]).sort()).toEqual(["depends_on", "id", "title", "type"]);
  });

  it("proves bd drops an unrecognised key silently — the reason the loader checks at all", () => {
    const path = join(bdRepo.dir, "dropped.formula.toml");
    writeFileSync(
      path,
      `formula = "dropped"\ntype = "workflow"\nversion = 1\n\n[[steps]]\nid = "a"\ntype = "task"\ntitle = "A"\nlables = ["step:implement"]\n`,
      "utf8",
    );

    // Exit 0, no warning, and the misspelled key is simply gone — the step now names no handler.
    const step = (cookRaw(path).steps as Array<Record<string, unknown>>)[0];
    expect(step.lables).toBeUndefined();
    expect(step.labels).toBeUndefined();
  });

  it("lets a project-local formula win over the bundled default", async () => {
    const path = writeProjectFormula(
      `formula = "anton-run"\ntype = "workflow"\nversion = 1\n\n[[steps]]\nid = "implement"\ntype = "task"\ntitle = "Implement"\nlabels = ["step:implement"]\n\n[[steps]]\nid = "commit"\ntype = "task"\nneeds = ["implement"]\ntitle = "Commit"\nlabels = ["step:commit"]\n\n[[steps]]\nid = "ship"\ntype = "task"\nneeds = ["commit"]\ntitle = "Ship"\nlabels = ["step:pr"]\n`,
    );

    const validated = await validateRunFormula(repo);
    expect(validated.source).toBe(path);
    expect(validated.steps.map((s) => s.step.id)).toEqual(["implement", "commit", "ship"]);
    expect(validated.steps.map((s) => s.definition.name)).toEqual(["implement", "commit", "pr"]);
  });

  it("parks on a project-local step that maps to no handler, naming the file and the step", async () => {
    const path = writeProjectFormula(
      `formula = "anton-run"\ntype = "workflow"\nversion = 1\n\n[[steps]]\nid = "implement"\ntype = "task"\ntitle = "Implement"\nlabels = ["step:implement"]\n\n[[steps]]\nid = "deploy"\ntype = "task"\nneeds = ["implement"]\ntitle = "Deploy"\nlabels = ["step:deploy"]\n`,
    );

    await expect(validateRunFormula(repo)).rejects.toThrow(
      new RegExp(`formula step "deploy" in ${path}.*step:deploy`, "s"),
    );
  });

  it("parks on a project-local key bd would drop, before the cook ever reports success", async () => {
    const path = writeProjectFormula(
      `formula = "anton-run"\ntype = "workflow"\nversion = 1\n\n[[steps]]\nid = "implement"\ntype = "task"\ntitle = "Implement"\nlabels = ["step:implement"]\nestimate = "1d"\n`,
    );

    // bd cooks this file happily (proved above) — the loader is what refuses it.
    expect(() => cookRaw(path)).not.toThrow();
    await expect(validateRunFormula(repo)).rejects.toThrow(/steps\[implement\]\.estimate/);
  });

  it("parks on a project-local formula bd itself refuses to cook", async () => {
    // `needs` pointing at a step that doesn't exist: bd's own validation, surfaced with the file.
    const path = writeProjectFormula(
      `formula = "anton-run"\ntype = "workflow"\nversion = 1\n\n[[steps]]\nid = "implement"\ntype = "task"\ntitle = "Implement"\nneeds = ["nowhere"]\nlabels = ["step:implement"]\n`,
    );

    await expect(validateRunFormula(repo)).rejects.toThrow(
      new RegExp(`run formula ${path} could not be cooked`),
    );
  });
});
