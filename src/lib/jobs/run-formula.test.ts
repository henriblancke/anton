/**
 * The run-formula loader (anton-hrql). Two things must hold for the pipeline to be safely
 * project-owned:
 *
 * 1. **The shipped default is the pipeline anton runs today** — implement → verify → commit →
 *    review → pr, every step resolving to a real handler. This asserts it from the ASSET, so a
 *    hand-edit of the file that breaks the pipeline reddens here rather than at the next run.
 * 2. **A broken project-local formula parks at run start**, naming the file and — where there is one
 *    — the offending step. Unknown TOML keys included: bd drops them silently, so the loader is the
 *    only thing standing between a typo and a pipeline that isn't the one written.
 *
 * 3. **Per-label variants (anton-aa3m) select exactly one pipeline, by a precedence that doesn't
 *    move.** Two mapped labels on one bead resolve the same way every time; no mapping resolves to
 *    the default; a mapping pointing at a file that isn't there parks instead of quietly running
 *    something else.
 *
 * The `bd cook` round-trip itself is pinned against a real bd in `run-formula.integration.test.ts`.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import type { CookedFormula } from "../beads/bd";
import { PoisonEpic } from "./errors";
import { assertRunFormulaFloor } from "./formula-floor";
import {
  bundledRunFormulaPath,
  orderFormulaSteps,
  parseRunFormulaSource,
  projectRunFormulaPath,
  resolveRunFormulaPath,
  selectRunFormula,
  unknownFormulaKeys,
  validateRunFormula,
  RUN_FORMULA_FILENAME,
} from "./run-formula";

/** The shipped asset, read from disk — the file `anton setup` actually installs. */
const shipped = () => readFileSync(bundledRunFormulaPath(), "utf8");

/** A minimal well-formed pipeline; tests mutate one thing at a time from here. */
const VALID = `formula = "anton-run"
type = "workflow"
version = 1

[[steps]]
id = "implement"
type = "task"
title = "Implement"
labels = ["step:implement"]

[[steps]]
id = "commit"
type = "task"
needs = ["implement"]
title = "Commit"
labels = ["step:commit"]
`;

/** A cook seam that returns the steps a test cares about, without shelling bd. */
const cookYielding = (steps: CookedFormula["steps"]) => async (): Promise<CookedFormula> => ({
  formula: "anton-run",
  steps,
});

describe("the shipped default (anton-hrql)", () => {
  it("declares TODAY's pipeline, in order, one handler label per step", () => {
    const doc = parseRunFormulaSource(shipped(), bundledRunFormulaPath());
    const steps = doc.steps as Array<Record<string, unknown>>;

    expect(steps.map((s) => s.id)).toEqual(["implement", "verify", "commit", "review", "pr"]);
    expect(steps.map((s) => s.labels)).toEqual([
      ["step:implement"],
      ["step:verify"],
      ["step:commit"],
      ["step:review"],
      ["step:pr"],
    ]);
    // Sequential: each step waits on the one before it, so the walk has a single total order.
    expect(steps.map((s) => s.needs)).toEqual([
      undefined,
      ["implement"],
      ["verify"],
      ["commit"],
      ["review"],
    ]);
    // `formula`, NOT `name` — a formula keyed `name` parses and then fails cook (anton-upfc).
    expect(doc.formula).toBe("anton-run");
    expect(doc.name).toBeUndefined();
  });

  it("resolves every step to a real handler", async () => {
    const doc = parseRunFormulaSource(shipped(), bundledRunFormulaPath());
    const steps = (doc.steps as Array<Record<string, unknown>>).map((s) => ({
      id: s.id as string,
      labels: s.labels as string[],
    }));

    const validated = await validateRunFormula("/repo", {
      read: async () => shipped(),
      cook: cookYielding(steps),
    });
    expect(validated.steps.map((s) => s.definition.name)).toEqual([
      "implement",
      "verify",
      "commit",
      "review",
      "pr",
    ]);
  });
});

describe("resolveRunFormulaPath", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  const repoWithFormula = (filename: string): string => {
    const repo = mkdtempSync(join(tmpdir(), "anton-run-formula-"));
    dirs.push(repo);
    mkdirSync(join(repo, ".beads", "formulas"), { recursive: true });
    writeFileSync(join(repo, ".beads", "formulas", filename), VALID);
    return repo;
  };

  it("falls back to anton's bundled asset for a project that never ran the installer", () => {
    expect(projectRunFormulaPath("/repo")).toBe(`/repo/.beads/formulas/${RUN_FORMULA_FILENAME}`);
    expect(resolveRunFormulaPath("/no-such-repo")).toBe(bundledRunFormulaPath());
    expect(bundledRunFormulaPath().endsWith(RUN_FORMULA_FILENAME)).toBe(true);
  });

  it("prefers the project's own copy", () => {
    const repo = repoWithFormula(RUN_FORMULA_FILENAME);
    expect(resolveRunFormulaPath(repo)).toBe(projectRunFormulaPath(repo));
  });

  it("parks on a .json sibling rather than silently walking anton's default instead", () => {
    // bd cooks either extension, so this file IS a pipeline the project wrote — passing over it
    // would run something else with no signal anywhere.
    const repo = repoWithFormula("anton-run.formula.json");
    expect(() => resolveRunFormulaPath(repo)).toThrow(/anton does not read/);
  });
});

describe("selectRunFormula — which pipeline this run walks (anton-aa3m)", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  /** A repo carrying the named formula files under `.beads/formulas/`. */
  const repoWith = (...filenames: string[]): string => {
    const repo = mkdtempSync(join(tmpdir(), "anton-formula-variant-"));
    dirs.push(repo);
    mkdirSync(join(repo, ".beads", "formulas"), { recursive: true });
    for (const f of filenames) writeFileSync(join(repo, ".beads", "formulas", f), VALID);
    return repo;
  };

  const variantPath = (repo: string, name: string) =>
    join(repo, ".beads", "formulas", `${name}.formula.toml`);

  it("uses the project's default when no variant is configured — invisible to a zero-config project", () => {
    const repo = repoWith(RUN_FORMULA_FILENAME);
    expect(selectRunFormula(repo, ["risk:high"], [])).toEqual({
      source: projectRunFormulaPath(repo),
    });
    // …and anton's bundled asset when the project never installed one, exactly as before.
    expect(selectRunFormula("/no-such-repo", ["risk:high"])).toEqual({
      source: bundledRunFormulaPath(),
    });
  });

  it("uses the default for a bead carrying none of the mapped labels", () => {
    const repo = repoWith(RUN_FORMULA_FILENAME, "anton-run-risk-high.formula.toml");
    expect(
      selectRunFormula(repo, ["risk:low", "size:S"], [
        { label: "risk:high", formula: "anton-run-risk-high" },
      ]),
    ).toEqual({ source: projectRunFormulaPath(repo) });
  });

  it("selects the mapped variant, recording the label that chose it", () => {
    const repo = repoWith(RUN_FORMULA_FILENAME, "anton-run-risk-high.formula.toml");
    expect(
      selectRunFormula(repo, ["domain:eng", "risk:high"], [
        { label: "risk:high", formula: "anton-run-risk-high" },
      ]),
    ).toEqual({ source: variantPath(repo, "anton-run-risk-high"), variant: "risk:high" });
  });

  it("resolves two mapped labels deterministically: the project's own order is the precedence", () => {
    const repo = repoWith("heavy.formula.toml", "light.formula.toml");
    const bead = ["size:S", "risk:high"];
    const riskFirst = [
      { label: "risk:high", formula: "heavy" },
      { label: "size:S", formula: "light" },
    ];
    // The BEAD's label order is irrelevant — only the project's list decides, so the same bead
    // resolves the same way on every run and every machine.
    expect(selectRunFormula(repo, bead, riskFirst).variant).toBe("risk:high");
    expect(selectRunFormula(repo, [...bead].reverse(), riskFirst).variant).toBe("risk:high");
    // Reordering the project's list — and only that — moves the winner.
    expect(selectRunFormula(repo, bead, [...riskFirst].reverse()).variant).toBe("size:S");
  });

  it("parks when a mapped variant's file is missing — never a silent fall back to the default", () => {
    const repo = repoWith(RUN_FORMULA_FILENAME);
    const select = () =>
      selectRunFormula(repo, ["risk:high"], [{ label: "risk:high", formula: "anton-run-risk-high" }]);
    expect(select).toThrow(PoisonEpic);
    expect(select).toThrow(/risk:high/);
    expect(select).toThrow(/anton-run-risk-high\.formula\.toml does not exist/);
  });

  it("parks on a variant written as `.json`, the pipeline bd cooks but anton doesn't read", () => {
    const repo = repoWith(RUN_FORMULA_FILENAME, "heavy.formula.json");
    expect(() => selectRunFormula(repo, ["risk:high"], [{ label: "risk:high", formula: "heavy" }])).toThrow(
      /anton does not read/,
    );
  });

  it("refuses a mapping that isn't a formula name — a variant can't point outside .beads/formulas", () => {
    const repo = repoWith(RUN_FORMULA_FILENAME);
    for (const formula of ["../../etc/passwd", "nested/heavy", "..", "/abs/heavy"]) {
      expect(() => selectRunFormula(repo, ["risk:high"], [{ label: "risk:high", formula }])).toThrow(
        /not a formula name/,
      );
    }
  });

  it("validates the selected variant exactly like the default — the floor is not escapable", async () => {
    // The whole safety argument for project-owned pipelines: selection changes WHICH file loads and
    // nothing else, so anton-6b99's floor still rejects a variant that would open a PR on nothing.
    const repo = repoWith(RUN_FORMULA_FILENAME, "no-pr.formula.toml");
    const formula = await validateRunFormula(repo, {
      labels: ["risk:high"],
      variants: [{ label: "risk:high", formula: "no-pr" }],
      cook: cookYielding([
        { id: "implement", labels: ["step:implement"] },
        { id: "commit", labels: ["step:commit"], needs: ["implement"] },
      ]),
    });
    expect(formula.source).toBe(variantPath(repo, "no-pr"));
    expect(formula.variant).toBe("risk:high");
    expect(() => assertRunFormulaFloor(formula)).toThrow(PoisonEpic);
    expect(() => assertRunFormulaFloor(formula)).toThrow(/no-pr\.formula\.toml/);
    expect(() => assertRunFormulaFloor(formula)).toThrow(/no step is labelled `step:pr`/);
  });
});

describe("unknownFormulaKeys — what bd would silently drop", () => {
  it("passes a formula that uses only keys bd honors", () => {
    expect(
      unknownFormulaKeys({
        formula: "x",
        description: "d",
        version: 1,
        type: "workflow",
        extends: ["base"],
        vars: { target: { description: "d", default: "t" } },
        steps: [
          {
            id: "a",
            title: "A",
            type: "task",
            description: "b",
            labels: ["step:implement"],
            needs: [],
            depends_on: [],
            priority: 2,
            assignee: "me",
            notes: "n",
            condition: "c",
            gate: { type: "human", await_id: "x", timeout: "1h" },
          },
        ],
      }),
    ).toEqual([]);
  });

  it("reports unknown keys at every scope, addressing each step by its id", () => {
    expect(
      unknownFormulaKeys({
        name: "anton-run", // the anton-upfc trap: parses, then fails cook with "name is required"
        steps: [
          { id: "implement", lables: ["step:implement"], gate: { type: "human", max_wait: "2h" } },
          { id: "pr", estimate: "1d" },
        ],
        vars: { target: { defualt: "t" } },
      }),
    ).toEqual([
      "name",
      "vars.target.defualt",
      "steps[implement].lables",
      "steps[implement].gate.max_wait",
      "steps[pr].estimate",
    ]);
  });

  it("addresses an id-less step by index, since bd's own rejection needs to be readable too", () => {
    expect(unknownFormulaKeys({ steps: [{ title: "A", estimate: "1d" }] })).toEqual([
      "steps[0].estimate",
    ]);
  });
});

describe("parseRunFormulaSource — the file as written", () => {
  it("accepts a well-formed pipeline", () => {
    expect(parseRunFormulaSource(VALID, "/repo/f.toml").formula).toBe("anton-run");
  });

  it("parks on unparseable TOML, naming the file", () => {
    const err = (() => {
      try {
        parseRunFormulaSource("formula = \n[[steps]\n", "/repo/.beads/formulas/anton-run.formula.toml");
      } catch (e) {
        return e as Error;
      }
    })();
    expect(err).toBeInstanceOf(PoisonEpic);
    expect(err!.message).toContain("/repo/.beads/formulas/anton-run.formula.toml");
    expect(err!.message).toMatch(/not valid TOML/);
  });

  it("parks on a key bd would drop, naming the key — never a silent drop", () => {
    const broken = VALID.replace('labels = ["step:implement"]', 'lables = ["step:implement"]');
    expect(() => parseRunFormulaSource(broken, "/repo/f.toml")).toThrow(PoisonEpic);
    expect(() => parseRunFormulaSource(broken, "/repo/f.toml")).toThrow(
      /steps\[implement\]\.lables/,
    );
  });

  // bd merges an inherited formula's steps into the cooked pipeline but anton only ever reads the
  // selected file, so every check above would cover half the pipeline it then walks — a `gtae` typo
  // in a base erases the gate assertNoStepGates would have parked on, silently.
  it("parks on `extends` — anton never scans the inherited source", () => {
    const inheriting = VALID.replace("version = 1", 'version = 1\nextends = ["base"]');
    expect(() => parseRunFormulaSource(inheriting, "/repo/f.toml")).toThrow(PoisonEpic);
    expect(() => parseRunFormulaSource(inheriting, "/repo/f.toml")).toThrow(/inherits from another formula/);
    expect(() => parseRunFormulaSource(inheriting, "/repo/f.toml")).toThrow(/base/);
  });

  // A formula that inherits ALL its steps declares none of its own — it must read as the `extends`
  // rejection, not as "declares no [[steps]]", or the operator is sent to fix the wrong thing.
  it("names `extends` ahead of the no-steps rejection", () => {
    expect(() =>
      parseRunFormulaSource(`formula = "anton-run"\nversion = 1\nextends = "base"\n`, "/repo/f.toml"),
    ).toThrow(/inherits from another formula/);
  });

  it("parks on a pipeline with no steps — it would implement, commit, and ship nothing", () => {
    expect(() => parseRunFormulaSource(`formula = "anton-run"\nversion = 1\n`, "/repo/f.toml")).toThrow(
      /declares no `\[\[steps\]\]`/,
    );
  });
});

describe("orderFormulaSteps — the order the walk runs (anton-lnkt)", () => {
  const ids = (steps: CookedFormula["steps"]) => steps.map((s) => s.id);

  it("keeps declaration order when a formula wires no `needs`", () => {
    const steps = [{ id: "a" }, { id: "b" }, { id: "c" }];
    expect(ids(orderFormulaSteps(steps, "/repo/f.toml"))).toEqual(["a", "b", "c"]);
  });

  it("sorts by `needs` — a step declared first still runs after what it waits on", () => {
    const steps = [
      { id: "pr", needs: ["commit"] },
      { id: "commit", needs: ["implement"] },
      { id: "implement" },
    ];
    expect(ids(orderFormulaSteps(steps, "/repo/f.toml"))).toEqual(["implement", "commit", "pr"]);
  });

  it("breaks ties by declaration order, so an unordered pair reads as the file writes it", () => {
    const steps = [
      { id: "implement" },
      { id: "lint", needs: ["implement"] },
      { id: "test", needs: ["implement"] },
    ];
    expect(ids(orderFormulaSteps(steps, "/repo/f.toml"))).toEqual(["implement", "lint", "test"]);
  });

  it("parks on a `needs` cycle — no order satisfies it, so there is no pipeline to walk", () => {
    const steps = [
      { id: "implement", needs: ["commit"] },
      { id: "commit", needs: ["implement"] },
    ];
    expect(() => orderFormulaSteps(steps, "/repo/f.toml")).toThrow(PoisonEpic);
    expect(() => orderFormulaSteps(steps, "/repo/f.toml")).toThrow(/cycle among "implement", "commit"/);
  });

  it("leaves duplicate ids in declaration order — the floor names the duplicate instead", () => {
    // `needs` can't address a repeated id unambiguously, so sorting would be guesswork; anton-6b99
    // rejects the formula right after this with a message an operator can act on.
    const steps = [{ id: "commit" }, { id: "implement" }, { id: "commit" }];
    expect(ids(orderFormulaSteps(steps, "/repo/f.toml"))).toEqual(["commit", "implement", "commit"]);
  });

  it("hands the ordered pipeline to the caller — cooked steps and resolved handlers alike", async () => {
    const validated = await validateRunFormula("/repo", {
      read: async () => VALID,
      cook: cookYielding([
        { id: "pr", labels: ["step:pr"], needs: ["commit"] },
        { id: "commit", labels: ["step:commit"], needs: ["implement"] },
        { id: "implement", labels: ["step:implement"] },
      ]),
    });
    expect(validated.steps.map((s) => s.definition.name)).toEqual(["implement", "commit", "pr"]);
    expect(ids(validated.cooked.steps)).toEqual(["implement", "commit", "pr"]);
  });
});

describe("validateRunFormula — the whole gate", () => {
  it("parks on a step whose `step:` label maps to no handler, naming the step and the file", async () => {
    await expect(
      validateRunFormula("/repo", {
        read: async () => VALID,
        cook: cookYielding([{ id: "deploy", labels: ["step:deploy"] }]),
      }),
    ).rejects.toThrow(/formula step "deploy" in [\s\S]*anton-run\.formula\.toml[\s\S]*step:deploy/);
  });

  it("parks on a step carrying no `step:` label at all", async () => {
    await expect(
      validateRunFormula("/repo", {
        read: async () => VALID,
        cook: cookYielding([{ id: "mystery", labels: ["domain:eng"] }]),
      }),
    ).rejects.toThrow(/carries no `step:<name>` label/);
  });

  it("parks — carrying bd's own reason — when the cook itself fails", async () => {
    await expect(
      validateRunFormula("/repo", {
        read: async () => VALID,
        cook: async () => {
          throw new Error("formula validation failed: name is required");
        },
      }),
    ).rejects.toThrow(/could not be cooked: formula validation failed: name is required/);
  });

  it("parks when the formula can't be read at all", async () => {
    await expect(
      validateRunFormula("/repo", {
        read: async () => {
          throw new Error("EACCES: permission denied");
        },
      }),
    ).rejects.toThrow(/could not be read \(EACCES: permission denied\)/);
  });

  // bd cooks a gate through, and anton's walker dispatches every step the moment the previous one
  // returns — so a gated step would run IMMEDIATELY. Parking is the only honest answer until gate
  // resolution exists: a gated `step:pr` that opens its PR anyway defeats the gate entirely.
  it("parks on a gated step — anton has no gate resolution, so it must not walk past the wait", async () => {
    await expect(
      validateRunFormula("/repo", {
        read: async () => VALID,
        cook: cookYielding([
          { id: "implement", labels: ["step:implement"] },
          { id: "commit", labels: ["step:commit"], needs: ["implement"] },
          {
            id: "ship",
            labels: ["step:pr"],
            needs: ["commit"],
            gate: { type: "human" },
          },
        ]),
      }),
    ).rejects.toThrow(/gates step\(s\) anton cannot wait on: "ship" \(`gate\.type = "human"`\)/);
  });

  it("names every gated step, so an operator clears the file in one pass", async () => {
    await expect(
      validateRunFormula("/repo", {
        read: async () => VALID,
        cook: cookYielding([
          { id: "implement", labels: ["step:implement"], gate: { type: "timer", timeout: "1h" } },
          { id: "commit", labels: ["step:commit"], needs: ["implement"] },
          { id: "ship", labels: ["step:pr"], needs: ["commit"], gate: { type: "gh:run" } },
        ]),
      }),
    ).rejects.toThrow(/"implement" \(`gate\.type = "timer"`\), "ship" \(`gate\.type = "gh:run"`\)/);
  });
});
