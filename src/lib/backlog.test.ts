/**
 * The Add-work commit path (anton-8mnr). The epic it lands is rendered from the project's bead
 * formula, so what these assert is the promise the board depends on: a draft the founder accepts
 * becomes a bead `validateBeadContract` passes with ZERO violations — no separate repair pass, no
 * "unshaped" badge on a bead anton itself just created.
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { buildEpicSkeleton, createDraftEpic, DraftContractError, knownAreas } from "./backlog";
import { validateBeadContract } from "./beads/contract";
import { projectBeadFormulaPath } from "./beads/formula";
import type { Bead } from "./beads/types";
import type { Project } from "./types";

const temps: string[] = [];
afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A project whose repo has no `.beads/formulas/` — so it resolves anton's bundled asset. */
function tempProject(): Project {
  const repoPath = mkdtempSync(join(tmpdir(), "anton-backlog-"));
  temps.push(repoPath);
  return {
    id: "p",
    slug: "p",
    name: "p",
    repoPath,
    defaultBranch: "main",
    hasBeads: true,
    createdAt: 0,
  };
}

const DRAFT = {
  title: "Reports are shareable outside the app",
  goal: "Every report view leaves the app in a format a customer can open.",
  successCriteria: "- [ ] every report view exports to CSV and PDF",
  area: "reports",
};

describe("buildEpicSkeleton", () => {
  it("renders an epic the contract validator passes with zero violations", async () => {
    const project = tempProject();
    const skeleton = await buildEpicSkeleton(project, DRAFT);

    const bead: Bead = {
      id: "x-1",
      title: DRAFT.title,
      status: "open",
      issue_type: skeleton.type,
      description: skeleton.description,
      acceptance_criteria: skeleton.acceptance,
      labels: [`area:${DRAFT.area}`],
      created_at: "2026-07-29T00:00:00Z",
    };
    expect(validateBeadContract(bead)).toEqual([]);
  });

  it("puts the outcome under `## Goal` so the board card can read it", async () => {
    const { description } = await buildEpicSkeleton(tempProject(), DRAFT);
    expect(description).toContain("## Goal");
    expect(description).toContain(DRAFT.goal);
    expect(description).toContain("## Success Criteria");
    // The founder filled every field, so no prompt survives into the bead.
    expect(description).not.toContain("TODO");
  });

  it("mirrors the success criteria into bd's own acceptance field", async () => {
    const skeleton = await buildEpicSkeleton(tempProject(), DRAFT);
    expect(skeleton.acceptance).toBe(DRAFT.successCriteria);
    expect(skeleton.type).toBe("epic");
  });

  it("renders from the PROJECT's formula when it has one", async () => {
    const project = tempProject();
    mkdirSync(join(project.repoPath, ".beads", "formulas"), { recursive: true });
    writeFileSync(
      projectBeadFormulaPath(project.repoPath),
      JSON.stringify({
        formula: "anton-bead",
        vars: {},
        steps: [
          { id: "epic", type: "epic", description: "## Goal\n\n{{outcome}}\n\n## House rule" },
          { id: "feature", description: "f" },
          { id: "ticket", description: "t" },
        ],
      }),
    );

    const { description } = await buildEpicSkeleton(project, DRAFT);
    expect(description).toContain("## House rule");
  });
});

describe("createDraftEpic — the contract gate ahead of bead creation", () => {
  // Both rejections throw BEFORE beads.create, so no bd repo is needed: the whole point is that a
  // placeholder draft never becomes a bead the board would immediately flag as unapprovable.
  it("rejects criteria that are still a TODO prompt — the bead would land contract-blocked", async () => {
    await expect(
      createDraftEpic(tempProject(), { ...DRAFT, successCriteria: "- [ ] TODO — decide later" }),
    ).rejects.toThrow(DraftContractError);
  });

  it("rejects a prompt-only goal too — Add-work lands zero-violation beads by construction", async () => {
    await expect(
      createDraftEpic(tempProject(), { ...DRAFT, goal: "TODO — the outcome, one line" }),
    ).rejects.toThrow(DraftContractError);
  });

  it("names the gap in the error so the route's 422 tells the founder what to fix", async () => {
    const rejection = await createDraftEpic(tempProject(), {
      ...DRAFT,
      successCriteria: "- [ ] TODO — decide later",
    }).then(
      () => undefined,
      (e: unknown) => e as DraftContractError,
    );
    expect(rejection?.violations.map((v) => v.section)).toEqual(["Success Criteria"]);
    expect(rejection?.message).toContain("Success Criteria");
  });
});

describe("knownAreas", () => {
  const bead = (labels: string[]): Bead => ({ id: "x", title: "t", status: "open", labels });

  it("collects the board's area: vocabulary, deduped and sorted", () => {
    expect(
      knownAreas([
        bead(["area:reports", "domain:eng"]),
        bead(["area:billing"]),
        bead(["area:reports"]),
        bead([]),
      ]),
    ).toEqual(["billing", "reports"]);
  });

  it("is empty on a board with no epics tagged yet", () => {
    expect(knownAreas([bead(["domain:eng"])])).toEqual([]);
  });
});
