/**
 * Real bd round-trip for the bead formula (anton-8mnr). Two things only a real `bd` can prove:
 *
 * 1. **No drift.** anton renders the skeleton in-process (so a unit test can assert conformance
 *    without a Dolt workspace). This pins that renderer to `bd cook --mode=runtime` on the SAME
 *    shipped formula — if bd's interpolation ever diverges from ours, this reddens.
 * 2. **By construction, end to end.** A bead materialised with ordinary `bd create` from the cooked
 *    skeleton comes BACK from `bd show` passing `validateBeadContract` with zero violations. Cook
 *    and create — never `bd mol pour`, whose molecule root is a type anton has no tier for.
 * 3. **The `bd list` projection is contract-complete.** The approve route, the executor, and the
 *    board all judge beads read from `bd list --json`, on the strength of it carrying every home
 *    the contract lives in — description and `acceptance_criteria` — whenever they are non-empty
 *    (ticket-view.ts). That is a property of bd's output, so only a real bd can pin it.
 * 4. **bd's own validator agrees.** anton reads either spelling of the rubric heading; bd does not
 *    (`bd create --validate` demands `## Acceptance Criteria` on a task/feature, `## Success
 *    Criteria` on an epic), so which spelling the formula cooks is a fact only bd can settle. Every
 *    tier is cooked by bd and created with `--validate` — the forcing function that makes the
 *    heading un-revertable (anton-szul): `bd lint` passes either spelling, so only `--validate`
 *    reddens when the shipped formula stops satisfying bd.
 * 5. **…and what bd's validator does NOT agree to.** Its scope is that one heading, nothing more: a
 *    body of only the rubric passes, and so does a skeleton whose every var is still the formula's
 *    TODO prompt. skills/bd/SKILL.md is loaded verbatim into /shape and /scan-triage, so selling
 *    `--validate` as a contract check ships TODO-stub beads; these two tests keep the sentence
 *    honest, and name anton's own gate as the thing that actually refuses them.
 */
import { execFileSync } from "node:child_process";
import { afterAll, beforeAll, expect, it } from "vitest";

import { describeBd, makeBdRepo, type BdRepo } from "@/lib/testing/integration";
import { beads } from "./bd";
import { ensureBeadFormula } from "./config.mjs";
import { contractGaps, validateBeadContract } from "./contract";
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

  interface CookedStep {
    id: string;
    type: string;
    description: string;
  }

  const cook = (): { steps: CookedStep[] } => {
    const args = [
      "cook",
      BEAD_FORMULA_NAME,
      "--mode=runtime",
      ...Object.entries(VARS).flatMap(([k, v]) => ["--var", `${k}=${v}`]),
    ];
    return JSON.parse(execFileSync("bd", args, { cwd: repo, encoding: "utf8" }));
  };

  /** `bd create --validate` — bd judging the cooked description by its OWN required section: the
   * rubric heading, and (per the two tests at the end) nothing else. */
  const createValidated = (type: string, description: string): string =>
    JSON.parse(
      execFileSync(
        "bd",
        ["create", VARS.title, "--type", type, "--description", description, "--validate", "--json"],
        { cwd: repo, encoding: "utf8", stdio: "pipe" },
      ),
    ).id;

  /** What bd itself cooked, per tier — the description AND the bd type each tier materialises as. */
  let cooked: Map<string, CookedStep>;

  beforeAll(() => {
    bdRepo = makeBdRepo();
    repo = bdRepo.repo;
    // The install step `anton init` / addProject runs — proving bd itself discovers what we ship.
    expect(ensureBeadFormula(`${repo}/.beads`).status).toBe("installed");
    cooked = new Map(cook().steps.map((s) => [s.id, { ...s, description: s.description.trim() }]));
  });

  /** The cooked step for `tier`, failing loud rather than validating an `undefined` description. */
  const cookedTier = (tier: BeadTier): CookedStep => {
    const step = cooked.get(tier);
    expect(step, `bd cook emitted no \`${tier}\` step`).toBeDefined();
    return step!;
  };

  afterAll(() => bdRepo.cleanup());

  it("is discoverable by bd from .beads/formulas/", () => {
    const listed = execFileSync("bd", ["formula", "list"], { cwd: repo, encoding: "utf8" });
    expect(listed).toContain(BEAD_FORMULA_NAME);
  });

  it("renders byte-identically to `bd cook --mode=runtime`", async () => {
    const formula = await loadBeadFormula(repo);

    for (const tier of ["epic", "feature", "ticket"] as BeadTier[]) {
      expect(cookedTier(tier).description, tier).toBe(
        renderBeadSkeleton(formula, tier, VARS).description,
      );
    }
  });

  // Why the rubric heading is spelled bd's way (anton-dji7, pinned by anton-szul). anton's own
  // reader takes either spelling, so only bd can say which one bd wants. Driven off bd's OWN cooked
  // output rather than anton's renderer: what ships is the formula, so the thing that must satisfy
  // `--validate` is what bd cooks from it — respelling the heading back reddens all three tiers.
  it.each(["epic", "feature", "ticket"] as BeadTier[])(
    "cooks a %s that bd's own `--validate` accepts onto the board",
    (tier) => {
      const { type, description } = cookedTier(tier);
      expect(createValidated(type, description)).toMatch(/\S/);
    },
  );

  // …and the negative case pins that the flag is actually judging rather than passing everything.
  it("proves `--validate` refuses the heading anton used to cook", () => {
    const { type, description } = cookedTier("ticket");
    expect(() =>
      createValidated(type, description.replace("## Acceptance Criteria", "## Acceptance")),
    ).toThrow(/Acceptance Criteria/);
  });

  // What `--validate` does NOT check. skills/bd/SKILL.md is instruction text anton loads verbatim
  // into /shape and /scan-triage, and it once told an agent the flag "refuses a body missing the
  // sections that type requires" — so a green `--validate` read as a complete contract and TODO-stub
  // beads shipped to the board, to be caught only at the approve gate. bd's real scope is the ONE
  // rubric heading: everything else is anton's own gate, below.
  it("accepts a body that is nothing BUT the rubric heading", () => {
    expect(createValidated("task", "## Acceptance Criteria\n- [ ] the rubric is the whole body")).toMatch(
      /\S/,
    );
  });

  it("accepts a cooked-but-unfilled skeleton that anton's contract gate refuses", async () => {
    // Every var left at its `TODO —` default: the exact bead the skill elsewhere calls worse than an
    // absent rubric. bd creates it; validateBeadContract blocks it.
    const skeleton = renderBeadSkeleton(await loadBeadFormula(repo), "ticket", {});
    expect(skeleton.description).toContain("TODO —");

    const id = createValidated(skeleton.type, skeleton.description);
    const bead = await beads.show(repo, id);
    expect(validateBeadContract(bead).filter((v) => v.severity === "blocking")).not.toEqual([]);
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

  it("judges field-only Acceptance off the `bd list` projection — the read the gates and board use", async () => {
    // The `bd update --acceptance` repair the blocking gap prescribes writes bd's own field and
    // leaves the description without an `## Acceptance` section. Every gate call site is list-fed,
    // so if bd ever dropped `acceptance_criteria` from the list projection, the repaired bead would
    // stay blocked despite the repair — this pins the projection the comment in ticket-view.ts
    // documents (measured against bd 1.1.2).
    const rubric = "- [ ] the list-fed gate reads this rubric";
    const id = await beads.create(repo, {
      title: "field-only acceptance",
      type: "task",
      description: "## Goal\nProve the list projection is contract-complete.",
      acceptance: rubric,
    });

    const listed = (await beads.list(repo, ["--status", "all"])).find((b) => b.id === id);
    expect(listed).toBeDefined();
    expect(listed?.acceptance_criteria).toBe(rubric);
    expect(listed?.description).toContain("## Goal");
    expect(contractGaps([listed!], "blocking")).toEqual([]);
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
