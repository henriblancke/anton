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
import { formulaVariantsSchema } from "../projects";
import { PoisonEpic } from "./errors";
import { assertRunFormulaFloor } from "./formula-floor";
import {
  BUNDLED_FORMULA_SOURCE,
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

  // The name is constrained twice, a run apart: the settings API accepts the map, this loader turns
  // it into a path. Two copies of the rule would drift into a mapping that saves fine and then parks
  // mid-run (or the reverse), so both read FORMULA_NAME_PATTERN and this pins them to one verdict.
  it("accepts and rejects exactly the names the settings schema does", () => {
    const repo = repoWith(RUN_FORMULA_FILENAME, "heavy.formula.toml");
    const loaderAccepts = (formula: string) => {
      try {
        selectRunFormula(repo, ["risk:high"], [{ label: "risk:high", formula }]);
        return true;
      } catch (e) {
        // Only the NAME verdict is under test — a well-formed name whose file is missing still parks.
        return !/not a formula name/.test((e as Error).message);
      }
    };
    const schemaAccepts = (formula: string) =>
      formulaVariantsSchema.safeParse([{ label: "risk:high", formula }]).success;

    for (const formula of ["heavy", "anton-run.risk_high", "a", "../../etc/passwd", "nested/heavy", "..", "/abs/heavy", "-heavy", "heavy-"]) {
      expect([formula, schemaAccepts(formula)]).toEqual([formula, loaderAccepts(formula)]);
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

  // `condition` is a key bd supports and cooks through — so the dropped-key check passes it — but
  // anton's cooked-step seam doesn't carry it and the walker dispatches every step it was handed. A
  // step the project DISABLED would run: silently the opposite of what the file asks for.
  it("parks on a step `condition` — anton evaluates none, so a disabled step would run anyway", () => {
    const conditional = VALID.replace(
      `labels = ["step:implement"]`,
      `labels = ["step:implement"]\ncondition = "vars.mode == 'full'"`,
    );
    expect(() => parseRunFormulaSource(conditional, "/repo/f.toml")).toThrow(PoisonEpic);
    expect(() => parseRunFormulaSource(conditional, "/repo/f.toml")).toThrow(
      /makes step\(s\) "implement" \(`condition = "vars.mode == 'full'"`\) conditional/,
    );
  });

  it("names every conditional step, and addresses an id-less one by index", () => {
    const doc = `formula = "anton-run"\nversion = 1\n\n[[steps]]\ntitle = "A"\ncondition = "a"\n\n[[steps]]\nid = "b"\ntitle = "B"\ncondition = "b"\n`;
    expect(() => parseRunFormulaSource(doc, "/repo/f.toml")).toThrow(
      /step\(s\) "0" \(`condition = "a"`\), "b" \(`condition = "b"`\)/,
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

  // bd substitutes variables into a step's title/description/notes and copies `labels` through
  // verbatim — in runtime mode as much as in compile (pinned against a real bd in the integration
  // suite). Every piece of anton's per-step configuration rides on labels, so a placeholder there can
  // NEVER resolve: `prompt:{{prompt}}` would be looked up as a prompt named `{{prompt}}` and park at
  // dispatch, after the run had implemented and committed.
  it("parks on a `{{var}}` in a step's labels — bd never substitutes there, so it can't resolve", async () => {
    await expect(
      validateRunFormula("/repo", {
        vars: { target: "anton-1" },
        read: async () => VALID,
        cook: cookYielding([
          { id: "implement", labels: ["step:implement"] },
          { id: "commit", labels: ["step:commit"], needs: ["implement"] },
          { id: "extra", labels: ["step:claude", "prompt:{{prompt}}"], needs: ["commit"] },
        ]),
      }),
    ).rejects.toThrow(/parameterises the labels of step\(s\) "extra" \(`prompt:\{\{prompt\}\}`\)/);
  });

  it("cooks with the run's values so bd's own variable check fires before a worktree exists", async () => {
    const seen: Array<Record<string, string> | undefined> = [];
    await validateRunFormula("/repo", {
      vars: { target: "anton-1" },
      read: async () => VALID,
      cook: async (_repo, _path, vars) => {
        seen.push(vars);
        return { formula: "anton-run", steps: [{ id: "implement", labels: ["step:implement"] }] };
      },
    });
    expect(seen).toEqual([{ target: "anton-1" }]);
  });
});

// A run survives a crash, a quota backoff and an operator's un-park, and every attempt re-reads the
// board and the project's settings. Re-selecting per attempt would let ONE run walk two pipelines —
// the tickets that already committed on the old one, the rest on the new — while the run record
// claimed a single formula for all of it.
describe("validateRunFormula — a resumed run keeps the pipeline it recorded (anton-aa3m)", () => {
  const PINNED = "/repo/.beads/formulas/anton-run.formula.toml";
  const walkable = cookYielding([
    { id: "implement", labels: ["step:implement"] },
    { id: "commit", labels: ["step:commit"], needs: ["implement"] },
    { id: "pr", labels: ["step:pr"], needs: ["commit"] },
  ]);

  it("loads the recorded source, ignoring labels and a mapping that would now select otherwise", async () => {
    const cooked: string[] = [];
    const formula = await validateRunFormula("/repo", {
      // A label the run itself added, plus a mapping added since it started. Selection would pick
      // `heavy` — whose file doesn't exist, so it would throw — if it ran at all.
      labels: ["risk:high", "stage:implementing"],
      variants: [{ label: "risk:high", formula: "heavy" }],
      pinned: { source: PINNED },
      read: async () => VALID,
      cook: async (_repo, path) => {
        cooked.push(path);
        return walkable();
      },
    });
    expect(formula.source).toBe(PINNED);
    expect(formula.variant).toBeUndefined();
    expect(cooked).toEqual([PINNED]);
  });

  it("keeps the recorded variant label even after the mapping that chose it is gone", async () => {
    const formula = await validateRunFormula("/repo", {
      labels: ["risk:high"],
      variants: [],
      pinned: { source: "/repo/.beads/formulas/heavy.formula.toml", variant: "risk:high" },
      read: async () => VALID,
      cook: walkable,
    });
    expect(formula.source).toBe("/repo/.beads/formulas/heavy.formula.toml");
    expect(formula.variant).toBe("risk:high");
  });

  it("validates the pinned pipeline exactly like a selected one — no escape via resume", async () => {
    await expect(
      validateRunFormula("/repo", {
        pinned: { source: PINNED },
        read: async () => VALID,
        cook: cookYielding([{ id: "deploy", labels: ["step:deploy"] }]),
      }),
    ).rejects.toThrow(/names `step:deploy`, which maps to no anton handler/);
  });

  it("says the run is pinned when the recorded file has since gone missing", async () => {
    await expect(
      validateRunFormula("/repo", {
        pinned: { source: PINNED },
        read: async () => {
          throw new Error("ENOENT: no such file or directory");
        },
      }),
    ).rejects.toThrow(/This run already walked that pipeline/);
  });

  // The pin has to survive an anton upgrade that moves the install root. Recording the bundled
  // asset's absolute path would leave an in-flight run pinned to a file that only MOVED, parked with
  // "restore the file" and recoverable only by abandoning the run.
  it("records anton's bundled default as a sentinel, not the install's absolute path", async () => {
    const formula = await validateRunFormula("/no-such-repo", {
      read: async () => VALID,
      cook: walkable,
    });
    expect(formula.source).toBe(bundledRunFormulaPath());
    expect(formula.recorded).toBe(BUNDLED_FORMULA_SOURCE);
    expect(BUNDLED_FORMULA_SOURCE.startsWith("/")).toBe(false);
  });

  it("resolves a `bundled:` pin against THIS install rather than the path it was recorded under", async () => {
    const cooked: string[] = [];
    const formula = await validateRunFormula("/repo", {
      pinned: { source: BUNDLED_FORMULA_SOURCE },
      read: async () => VALID,
      cook: async (_repo, path) => {
        cooked.push(path);
        return walkable();
      },
    });
    expect(formula.source).toBe(bundledRunFormulaPath());
    expect(formula.recorded).toBe(BUNDLED_FORMULA_SOURCE);
    expect(cooked).toEqual([bundledRunFormulaPath()]);
  });

  it("records a project-local pipeline verbatim — its path is constant per project", async () => {
    const formula = await validateRunFormula("/repo", {
      pinned: { source: PINNED },
      read: async () => VALID,
      cook: walkable,
    });
    expect(formula.recorded).toBe(PINNED);
  });
});
