/**
 * Real bd round-trip for the bead formula (anton-8mnr). Two things only a real `bd` can prove:
 *
 * 1. **No drift.** anton renders the skeleton in-process (so a unit test can assert conformance
 *    without a Dolt workspace). This pins that renderer to `bd cook --mode=runtime` on the SAME
 *    shipped formula — if bd's interpolation ever diverges from ours, this reddens.
 * 2. **By construction, end to end.** A bead materialised with ordinary `bd create` from the cooked
 *    skeleton comes BACK from `bd show` passing `validateBeadContract` with zero violations. Cook
 *    and create — never `bd mol pour`, whose molecule root is a type anton has no tier for.
 */
import { execFileSync } from "node:child_process";
import { afterAll, beforeAll, expect, it } from "vitest";

import { describeBd, makeBdRepo, type BdRepo } from "@/lib/testing/integration";
import { beads } from "./bd";
import { ensureBeadFormula } from "./config.mjs";
import { validateBeadContract } from "./contract";
import {
  BEAD_FORMULA_NAME,
  loadBeadFormula,
  renderBeadSkeleton,
  type BeadTier,
} from "./formula";

describeBd("bead formula (real bd · cook + create)", () => {
  let bdRepo: BdRepo;
  let repo: string;

  const VARS: Record<string, string> = {
    title: "Add CSV export button",
    goal: "Let users export the reports view so they can share numbers.",
    acceptance: "- [ ] button on /reports exports the current view as CSV",
    context: "touches: app/reports/*, lib/csv.ts",
    out_of_scope: "- no server-side generation",
    verify: "unit test lib/csv.ts formatting",
    outcome: "Reports leave the app in a format a customer can open.",
    success_criteria: "- [ ] every report view exports",
  };

  const cook = (): { steps: Array<{ id: string; description: string }> } => {
    const args = [
      "cook",
      BEAD_FORMULA_NAME,
      "--mode=runtime",
      ...Object.entries(VARS).flatMap(([k, v]) => ["--var", `${k}=${v}`]),
    ];
    return JSON.parse(execFileSync("bd", args, { cwd: repo, encoding: "utf8" }));
  };

  beforeAll(() => {
    bdRepo = makeBdRepo();
    repo = bdRepo.repo;
    // The install step `anton init` / addProject runs — proving bd itself discovers what we ship.
    expect(ensureBeadFormula(`${repo}/.beads`).status).toBe("installed");
  });

  afterAll(() => bdRepo.cleanup());

  it("is discoverable by bd from .beads/formulas/", () => {
    const listed = execFileSync("bd", ["formula", "list"], { cwd: repo, encoding: "utf8" });
    expect(listed).toContain(BEAD_FORMULA_NAME);
  });

  it("renders byte-identically to `bd cook --mode=runtime`", async () => {
    const formula = await loadBeadFormula(repo);
    const cooked = new Map(cook().steps.map((s) => [s.id, s.description]));

    for (const tier of ["epic", "feature", "ticket"] as BeadTier[]) {
      expect(cooked.get(tier)?.trim(), tier).toBe(renderBeadSkeleton(formula, tier, VARS).description);
    }
  });

  it("materialises a ticket that reads back contract-conformant", async () => {
    const skeleton = renderBeadSkeleton(await loadBeadFormula(repo), "ticket", VARS);
    const id = await beads.create(repo, {
      title: VARS.title,
      type: skeleton.type,
      description: skeleton.description,
      acceptance: skeleton.acceptance,
      labels: ["domain:eng", "risk:low"],
    });

    const bead = await beads.show(repo, id);
    expect(bead.issue_type).toBe("task");
    expect(bead.labels).toContain("domain:eng");
    expect(validateBeadContract(bead)).toEqual([]);
  });

  it("materialises an epic that reads back contract-conformant", async () => {
    const skeleton = renderBeadSkeleton(await loadBeadFormula(repo), "epic", VARS);
    const id = await beads.create(repo, {
      title: VARS.outcome,
      type: skeleton.type,
      description: skeleton.description,
      acceptance: skeleton.acceptance,
      labels: ["area:reports"],
    });

    expect(validateBeadContract(await beads.show(repo, id))).toEqual([]);
  });
});
