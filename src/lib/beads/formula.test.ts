/**
 * The bead formula's whole promise (anton-8mnr): STRUCTURE by construction, content by the author.
 * A bead poured from it and filled in passes the contract validator without anyone remembering a
 * heading — and one poured but never filled is faulted, because its defaults are prompts and a run
 * against a TODO rubric is the false green the contract exists to prevent. Both halves are asserted
 * against the SHIPPED asset — not a fixture — so an edit to the formula that drops a section (or
 * turns a prompt into fake content) reddens this suite rather than quietly reintroducing the
 * unshaped beads the board then has to flag.
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { ACCEPTANCE_HEADING, validateBeadContract } from "./contract";
import {
  BEAD_FORMULA_FILENAME,
  bundledBeadFormulaPath,
  loadBeadFormula,
  parseBeadFormula,
  projectBeadFormulaPath,
  renderBeadSkeleton,
  resolveBeadFormulaPath,
  type BeadTier,
} from "./formula";
import type { Bead } from "./types";

const temps: string[] = [];
afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A temp dir removed after the test — a repo with no `.beads/` unless one is written into it. */
function tempRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "anton-formula-"));
  temps.push(dir);
  return dir;
}

/** A temp repo carrying its own `.beads/formulas/` copy of `contents`. */
function repoWithFormula(contents: string): string {
  const dir = tempRepo();
  mkdirSync(join(dir, ".beads", "formulas"), { recursive: true });
  writeFileSync(projectBeadFormulaPath(dir), contents);
  return dir;
}

/** The bead a creation path would hand bd, as `validateBeadContract` sees it after a read back. */
function beadFrom(
  skeleton: { type: string; description: string; acceptance: string },
  labels: string[] = [],
): Bead {
  return {
    id: "x-1",
    title: "T",
    status: "open",
    issue_type: skeleton.type,
    description: skeleton.description,
    acceptance_criteria: skeleton.acceptance,
    labels,
    created_at: "2026-07-29T00:00:00Z",
  };
}

describe("the shipped bead formula", () => {
  const load = () => loadBeadFormula(tempRepo());

  it("parses, and carries one step per tier", async () => {
    const formula = await load();
    expect(formula.formula).toBe("anton-bead");
    expect(formula.steps.map((s) => s.id)).toEqual(["epic", "feature", "ticket"]);
    expect(formula.source).toBe(bundledBeadFormulaPath());
  });

  it("templates the five contract sections on both run tiers", async () => {
    const formula = await load();
    for (const tier of ["feature", "ticket"] as BeadTier[]) {
      const { description } = renderBeadSkeleton(formula, tier);
      for (const section of ["Goal", ACCEPTANCE_HEADING, "Context", "Out of scope", "Verify"]) {
        expect(description, tier).toContain(`## ${section}`);
      }
      // The rubric heading is pinned to bd's own spelling (anton-dji7): `bd create --validate` and
      // `bd lint` demand "Acceptance Criteria" on a task/feature, so the bare `## Acceptance` we
      // used to cook — which anton's own reader still accepts — would fail bd's.
      expect(description, tier).not.toMatch(/^## Acceptance\s*$/m);
    }
  });

  // The acceptance criterion in one assertion: the formula supplies the STRUCTURE, so a bead an
  // author fills through it is conformant without them remembering a single heading.
  it.each([["feature"], ["ticket"]] as const)(
    "renders a %s the contract validator passes once its vars are authored",
    async (tier) => {
      const skeleton = renderBeadSkeleton(await load(), tier, {
        goal: "Reports leave the app in a format a customer can open.",
        acceptance: "- [ ] the export button ships",
        context: "touches: app/reports/*; follow app/reports/pdf.ts",
        out_of_scope: "- not the PDF path",
        verify: "- unit test covers the CSV writer",
      });
      expect(validateBeadContract(beadFrom(skeleton))).toEqual([]);
    },
  );

  // The other half of "prompts, not content" (anton-8mnr): the skeleton is a form, not a filled one.
  // The validator has to say so, or `bd cook anton-bead` alone would produce a bead that approves
  // and runs against a TODO rubric.
  it.each([["feature"], ["ticket"]] as const)(
    "renders an UNAUTHORED %s the validator faults on Acceptance",
    async (tier) => {
      const violations = validateBeadContract(beadFrom(renderBeadSkeleton(await load(), tier)));
      expect(violations.filter((v) => v.severity === "blocking").map((v) => v.section)).toEqual([
        "Acceptance",
      ]);
    },
  );

  it("renders an epic the validator passes once its area: label is set", async () => {
    const skeleton = renderBeadSkeleton(await load(), "epic", {
      outcome: "Reports leave the app in a format a customer can open.",
      success_criteria: "- [ ] every report view exports",
    });
    expect(skeleton.type).toBe("epic");
    expect(validateBeadContract(beadFrom(skeleton, ["area:reports"]))).toEqual([]);
  });

  it("faults an unauthored epic on its outcome, its Success Criteria AND its area: label", async () => {
    // The area: label is the one thing the formula cannot supply; the outcome and the criteria are
    // the two only an author can write — and the skeleton's `## Goal` prompt is not an outcome.
    const skeleton = renderBeadSkeleton(await load(), "epic");
    expect(validateBeadContract(beadFrom(skeleton)).map((v) => v.section).sort()).toEqual([
      "Outcome",
      "Success Criteria",
      "area:",
    ]);
  });

  it("mirrors the tier's acceptance text for bd's own field", async () => {
    const formula = await load();
    expect(renderBeadSkeleton(formula, "ticket", { acceptance: "- [ ] it works" })).toMatchObject({
      type: "task",
      acceptance: "- [ ] it works",
    });
    expect(
      renderBeadSkeleton(formula, "epic", { success_criteria: "- [ ] shipped" }).acceptance,
    ).toBe("- [ ] shipped");
  });

  it("ships prompts, not content — every default is visibly unfilled", async () => {
    const { description } = renderBeadSkeleton(await load(), "ticket");
    expect(description).toContain("TODO");
  });
});

describe("interpolation", () => {
  const formula = (ticketDescription = "## Goal\n\n{{ goal }}") =>
    parseBeadFormula(
      JSON.stringify({
        formula: "anton-bead",
        vars: { goal: { default: "STUB GOAL" }, acceptance: { default: "- [ ] TODO — stub" } },
        steps: [
          { id: "epic", description: "## Goal\n\n{{goal}}" },
          { id: "feature", description: "## Goal\n\n{{goal}}" },
          { id: "ticket", description: ticketDescription },
        ],
      }),
      "test",
    );

  it("prefers the supplied value, falls back to the default", () => {
    expect(renderBeadSkeleton(formula(), "ticket", { goal: "Ship it" }).description).toContain(
      "Ship it",
    );
    expect(renderBeadSkeleton(formula(), "ticket").description).toContain("STUB GOAL");
  });

  it("treats a blank value as unsupplied rather than collapsing the section", () => {
    expect(renderBeadSkeleton(formula(), "ticket", { goal: "   " }).description).toContain(
      "STUB GOAL",
    );
  });

  // A literal `{{criteria}}` reads as WRITTEN text to the contract validator, so materializing it
  // would pass the gate while every view rendered the token instead of the authored criteria. A
  // misspelled or custom placeholder must fail the render, not become a bead.
  it("fails loud on an unresolved var instead of materializing the token", () => {
    expect(() => renderBeadSkeleton(formula("## X\n\n{{unknown}}"), "ticket")).toThrow(
      /unresolved \{\{unknown\}\} in the `ticket` template/,
    );
  });

  it("fails loud when the tier's acceptance var has no value and no default", () => {
    const doc = JSON.stringify({
      formula: "anton-bead",
      vars: {},
      steps: [
        { id: "epic", description: "e" },
        { id: "feature", description: "f" },
        { id: "ticket", description: "## Acceptance\n\n{{acceptance}}" },
      ],
    });
    expect(() => renderBeadSkeleton(parseBeadFormula(doc, "test"), "ticket")).toThrow(
      /unresolved \{\{acceptance\}\}/,
    );
    expect(
      renderBeadSkeleton(parseBeadFormula(doc, "test"), "ticket", { acceptance: "- [ ] ok" })
        .acceptance,
    ).toBe("- [ ] ok");
  });

  // A formula that renders fine while DROPPING what the founder submitted is the subtler breakage:
  // a static Goal replacing `{{outcome}}` (or a static Success Criteria section) validates — static
  // text reads as written — while the submitted value vanishes, the static section even shadowing
  // the mirrored acceptance field in display precedence. Supplied contract vars must be consumed.
  it("fails loud when the tier's template never references a supplied contract var", () => {
    const doc = JSON.stringify({
      formula: "anton-bead",
      vars: { success_criteria: { default: "- [ ] TODO — stub" } },
      steps: [
        { id: "epic", description: "## Goal\n\nA static goal.\n\n## Success Criteria\n\n{{success_criteria}}" },
        { id: "feature", description: "f" },
        { id: "ticket", description: "t" },
      ],
    });
    expect(() =>
      renderBeadSkeleton(parseBeadFormula(doc, "test"), "epic", {
        outcome: "Reports leave the app.",
        success_criteria: "- [ ] every report exports",
      }),
    ).toThrow(/the `epic` template never references \{\{outcome\}\}/);
  });

  it("does not count a var referenced only in the step title — the skeleton never emits it", () => {
    // `renderBeadSkeleton` renders description + mirrored acceptance only; the Add-work commit uses
    // the draft's own title. A `{{outcome}}` living solely in `step.title` is still discarded.
    const doc = JSON.stringify({
      formula: "anton-bead",
      vars: { success_criteria: { default: "- [ ] TODO — stub" } },
      steps: [
        {
          id: "epic",
          title: "{{outcome}}",
          description: "## Goal\n\nA static goal.\n\n## Success Criteria\n\n{{success_criteria}}",
        },
        { id: "feature", description: "f" },
        { id: "ticket", description: "t" },
      ],
    });
    expect(() =>
      renderBeadSkeleton(parseBeadFormula(doc, "test"), "epic", {
        outcome: "Reports leave the app.",
        success_criteria: "- [ ] every report exports",
      }),
    ).toThrow(/the `epic` template never references \{\{outcome\}\}/);
  });

  it("fails loud when a static criteria section would shadow the submitted criteria", () => {
    // An unreferencing template still preserves the acceptance var through the mirrored bd field —
    // but a static WRITTEN criteria section in the description takes display precedence over that
    // field (acceptanceBody), so the founder's submitted criteria would never render.
    const doc = JSON.stringify({
      formula: "anton-bead",
      vars: {},
      steps: [
        {
          id: "epic",
          description: "## Goal\n\n{{outcome}}\n\n## Success Criteria\n\n- [ ] a static, already-written box",
        },
        { id: "feature", description: "f" },
        { id: "ticket", description: "t" },
      ],
    });
    expect(() =>
      renderBeadSkeleton(parseBeadFormula(doc, "test"), "epic", {
        outcome: "Reports leave the app.",
        success_criteria: "- [ ] every report exports",
      }),
    ).toThrow(/the `epic` template never references \{\{success_criteria\}\}/);
  });

  it("fails loud when the only reference to a contract var hides inside an HTML comment", () => {
    // A raw-template scan counted `<!-- {{outcome}} -->` as consumption, but interpolation puts the
    // founder's outcome only in invisible markup — the validator strips the comment and accepts the
    // static Goal, so the submitted outcome silently vanished from every rendered view.
    const doc = JSON.stringify({
      formula: "anton-bead",
      vars: {},
      steps: [
        {
          id: "epic",
          description:
            "## Goal\n\nA static, already-written goal.\n<!-- {{outcome}} -->\n\n## Success Criteria\n\n{{success_criteria}}",
        },
        { id: "feature", description: "f" },
        { id: "ticket", description: "t" },
      ],
    });
    expect(() =>
      renderBeadSkeleton(parseBeadFormula(doc, "test"), "epic", {
        outcome: "Reports leave the app.",
        success_criteria: "- [ ] every report exports",
      }),
    ).toThrow(/the `epic` template never references \{\{outcome\}\}/);
  });

  it("counts a reference inside fenced code — fenced content renders literally, so it survives", () => {
    // The inverse guard: a `{{outcome}}` inside a ``` block IS output-bearing (renderedLines keeps
    // fenced content), so the consumption check must not fault a template that renders it there.
    const doc = JSON.stringify({
      formula: "anton-bead",
      vars: {},
      steps: [
        {
          id: "epic",
          description: "## Goal\n\n```\n{{outcome}}\n```\n\n## Success Criteria\n\n{{success_criteria}}",
        },
        { id: "feature", description: "f" },
        { id: "ticket", description: "t" },
      ],
    });
    const skeleton = renderBeadSkeleton(parseBeadFormula(doc, "test"), "epic", {
      outcome: "Reports leave the app.",
      success_criteria: "- [ ] every report exports",
    });
    expect(skeleton.description).toContain("Reports leave the app.");
  });

  it("ignores another tier's vars in the bag — one bag renders every tier, as `bd cook --var` does", () => {
    const doc = JSON.stringify({
      formula: "anton-bead",
      vars: { acceptance: { default: "- [ ] TODO — stub" } },
      steps: [
        { id: "epic", description: "## Goal\n\n{{outcome}}\n\n## Success Criteria\n\n{{success_criteria}}" },
        { id: "feature", description: "f" },
        { id: "ticket", description: "t" },
      ],
    });
    const skeleton = renderBeadSkeleton(parseBeadFormula(doc, "test"), "epic", {
      outcome: "Reports leave the app.",
      success_criteria: "- [ ] every report exports",
      goal: "a ticket-tier var the epic template rightly ignores",
      context: "another one",
    });
    expect(skeleton.description).toContain("Reports leave the app.");
    expect(skeleton.description).not.toContain("rightly ignores");
  });
});

describe("resolution", () => {
  it("prefers the project's own copy over anton's bundled asset", () => {
    const repo = repoWithFormula("{}");
    expect(resolveBeadFormulaPath(repo)).toBe(projectBeadFormulaPath(repo));
    expect(projectBeadFormulaPath(repo).endsWith(join(".beads", "formulas", BEAD_FORMULA_FILENAME)))
      .toBe(true);
  });

  it("falls back to the bundled asset when the project has none", () => {
    expect(resolveBeadFormulaPath(tempRepo())).toBe(bundledBeadFormulaPath());
  });

  it("loads the project copy's content, not the bundled one", async () => {
    const repo = repoWithFormula(
      JSON.stringify({
        formula: "anton-bead",
        vars: {},
        steps: [
          { id: "epic", description: "e" },
          { id: "feature", description: "f" },
          { id: "ticket", type: "task", description: "PROJECT LOCAL" },
        ],
      }),
    );
    expect((await loadBeadFormula(repo)).steps).toHaveLength(3);
    expect(
      renderBeadSkeleton(await loadBeadFormula(repo), "ticket", { acceptance: "- [ ] ok" })
        .description,
    ).toBe("PROJECT LOCAL");
  });
});

describe("parseBeadFormula fails loud", () => {
  it("on malformed JSON", () => {
    expect(() => parseBeadFormula("{not json", "p")).toThrow(/not valid JSON/);
  });

  it("on a missing steps array", () => {
    expect(() => parseBeadFormula("{}", "p")).toThrow(/no `steps` array/);
  });

  it("on a missing tier", () => {
    const doc = JSON.stringify({ steps: [{ id: "ticket", description: "x" }] });
    expect(() => parseBeadFormula(doc, "p")).toThrow(/no `epic` step/);
  });

  it("on a tier with an empty description template", () => {
    const doc = JSON.stringify({
      steps: [
        { id: "epic", description: "e" },
        { id: "feature", description: "  " },
        { id: "ticket", description: "t" },
      ],
    });
    expect(() => parseBeadFormula(doc, "p")).toThrow(/step `feature` has no description/);
  });
});
