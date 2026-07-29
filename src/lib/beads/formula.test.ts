/**
 * The bead formula's whole promise (anton-8mnr): a bead poured from it passes the contract
 * validator BY CONSTRUCTION. That is asserted here against the SHIPPED asset — not a fixture — so
 * an edit to the formula that drops a section reddens this suite rather than quietly reintroducing
 * the unshaped beads the board then has to flag.
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { validateBeadContract } from "./contract";
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
      for (const section of ["Goal", "Acceptance", "Context", "Out of scope", "Verify"]) {
        expect(description, tier).toContain(`## ${section}`);
      }
    }
  });

  // The acceptance criterion in one assertion: what the formula renders is conformant before an
  // author has typed anything, so filling it in can only keep it conformant.
  it.each([["feature"], ["ticket"]] as const)(
    "renders a %s the contract validator passes with zero violations",
    async (tier) => {
      const skeleton = renderBeadSkeleton(await load(), tier);
      expect(validateBeadContract(beadFrom(skeleton))).toEqual([]);
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

  it("faults an epic with no area: — the one thing the formula cannot supply", async () => {
    const skeleton = renderBeadSkeleton(await load(), "epic");
    expect(validateBeadContract(beadFrom(skeleton)).map((v) => v.section)).toEqual(["area:"]);
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
  const formula = () =>
    parseBeadFormula(
      JSON.stringify({
        formula: "anton-bead",
        vars: { goal: { default: "STUB GOAL" } },
        steps: [
          { id: "epic", description: "## Goal\n\n{{goal}}" },
          { id: "feature", description: "## Goal\n\n{{goal}}" },
          { id: "ticket", description: "## Goal\n\n{{ goal }}\n\n## X\n\n{{unknown}}" },
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

  // Matches `bd cook --mode=runtime`: an unknown var stays visible instead of vanishing, so the
  // hole is obvious to whoever reads the bead.
  it("leaves an unknown var verbatim", () => {
    expect(renderBeadSkeleton(formula(), "ticket").description).toContain("{{unknown}}");
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
    expect(renderBeadSkeleton(await loadBeadFormula(repo), "ticket").description).toBe(
      "PROJECT LOCAL",
    );
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
