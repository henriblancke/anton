/**
 * Real `bd cook` round-trip for the formula seam (anton-brdg).
 *
 * bd.test.ts parses a RECORDED `bd cook --json` fixture, which keeps the unit gate hermetic but can
 * silently drift from the installed binary. This is the pin: the same six-step pipeline, cooked by a
 * real bd, must produce the same typed shape the fixture asserts — step order, `needs` edges, the
 * `step:*` labels, the gate object, and `{{var}}` substitution in runtime mode. If bd's output
 * changes (a renamed key, a dropped field, a different gate encoding), this reddens instead of the
 * seam quietly returning steps with everything optional missing.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";

import { describeBd, makeBdRepo, type BdRepo } from "@/lib/testing/integration";
import { beads } from "./bd";

/**
 * A pipeline in the shape anton-hrql will ship. `formula`, NOT `name`: a formula keyed `name` parses
 * and then fails cook with "name is required" (anton-upfc). Step configuration rides on `labels`
 * because bd drops step keys it doesn't recognise.
 */
const PIPELINE_TOML = `formula = "anton-run-seam-test"
description = "cook seam fixture"
type = "workflow"
version = 1

[vars]
[vars.target]
description = "The run target bead"
default = "TODO"

[[steps]]
id = "implement"
type = "task"
title = "Implement {{target}}"
labels = ["step:implement"]

[[steps]]
id = "commit"
type = "task"
needs = ["implement"]
title = "Commit {{target}}"
labels = ["step:commit"]

[[steps]]
id = "signoff"
type = "task"
needs = ["commit"]
title = "Human sign-off on {{target}}"
[steps.gate]
type = "human"

[[steps]]
id = "pr"
type = "task"
needs = ["signoff"]
title = "Open the PR for {{target}}"
labels = ["step:pr"]
`;

describeBd("bd cook seam (real bd)", () => {
  let bdRepo: BdRepo;
  let repo: string;
  let formula: string;

  beforeAll(() => {
    bdRepo = makeBdRepo();
    repo = bdRepo.repo;
    formula = join(repo, "anton-run-seam-test.formula.toml");
    writeFileSync(formula, PIPELINE_TOML, "utf8");
  });

  afterAll(() => bdRepo?.cleanup());

  it("cooks compile-time: placeholders intact, with type/labels/needs/gate on every step", async () => {
    const cooked = await beads.cook(repo, formula);

    expect(cooked.formula).toBe("anton-run-seam-test");
    expect(cooked.description).toBe("cook seam fixture");
    expect(cooked.source).toBe(formula);
    expect(cooked.steps.map((s) => s.id)).toEqual(["implement", "commit", "signoff", "pr"]);
    expect(cooked.steps[0]).toEqual({
      id: "implement",
      title: "Implement {{target}}",
      type: "task",
      labels: ["step:implement"],
    });
    expect(cooked.steps.map((s) => s.needs)).toEqual([
      undefined,
      ["implement"],
      ["commit"],
      ["signoff"],
    ]);
    // The gate is reported, never resolved — gate verbs belong to anton-uk95.
    expect(cooked.steps[2].gate).toEqual({ type: "human" });
  });

  it("cooks runtime: every {{var}} is substituted from the values passed", async () => {
    const cooked = await beads.cook(repo, formula, { vars: { target: "anton-ev6d" } });

    expect(cooked.steps.map((s) => s.title)).toEqual([
      "Implement anton-ev6d",
      "Commit anton-ev6d",
      "Human sign-off on anton-ev6d",
      "Open the PR for anton-ev6d",
    ]);
    expect(JSON.stringify(cooked)).not.toContain("{{");
  });

  it("rejects — carrying bd's own reason — when a runtime cook has no value for a variable", async () => {
    const missing = join(repo, "missing-var.formula.toml");
    writeFileSync(
      missing,
      `formula = "missing-var"
type = "workflow"
version = 1

[vars]
[vars.needed]
description = "no default, so a runtime cook cannot resolve it"

[[steps]]
id = "a"
type = "task"
title = "A {{needed}}"
`,
      "utf8",
    );
    await expect(beads.cook(repo, missing, { mode: "runtime" })).rejects.toThrow(
      /runtime mode requires all variables/,
    );
  });

  it("cooks a formula by NAME out of .beads/formulas — bd's own search path", async () => {
    // The shipped default lands there (anton-hrql), so the seam must accept a bare name too.
    const formulas = join(repo, ".beads", "formulas");
    mkdirSync(formulas, { recursive: true });
    writeFileSync(join(formulas, "anton-run-seam-test.formula.toml"), PIPELINE_TOML, "utf8");
    const cooked = await beads.cook(repo, "anton-run-seam-test");
    expect(cooked.steps.map((s) => s.id)).toEqual(["implement", "commit", "signoff", "pr"]);
  });
});
