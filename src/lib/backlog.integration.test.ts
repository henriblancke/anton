/**
 * Real bd round-trip for the Add-work commit (anton-h1ds). The unit suite pins the argv this path
 * builds; only a real `bd` can prove what the board then HOLDS: a `feature` — the tier anton runs —
 * whose parent is the epic the founder chose, both passing `validateBeadContract` with zero
 * violations, and both classified the way the runner classifies them (`isRunTarget` on the feature,
 * `isContainer` on the epic). Before this ticket the same click produced an epic per PR, which
 * `/shape` had already stopped emitting.
 */
import { afterAll, beforeAll, expect, it } from "vitest";

import { describeBd, makeBdRepo, type BdRepo } from "@/lib/testing/integration";
import { createDraftFeature, DraftEpicError } from "./backlog";
import { beads, type Bead } from "./beads/bd";
import { ensureBeadFormula } from "./beads/config.mjs";
import { validateBeadContract } from "./beads/contract";
import type { Project } from "./types";

describeBd("Add-work commit (real bd · feature under an epic)", () => {
  let bdRepo: BdRepo;
  let project: Project;

  const FEATURE = {
    title: "Export a report view to CSV",
    goal: "A customer can take a report out of the app as CSV.",
    acceptance: "- [ ] every report view has a working CSV export button",
    context: "touches: src/app/reports; follow the pattern in src/lib/export.ts",
    outOfScope: "- PDF export, which is its own feature",
    verify: "unit test on the serializer, route test on the download",
  };

  const EPIC = {
    title: "Reports are shareable outside the app",
    goal: "Every report view leaves the app in a format a customer can open.",
    successCriteria: "- [ ] every report view exports",
    area: "reports",
  };

  beforeAll(() => {
    bdRepo = makeBdRepo();
    // The install step `anton init` / addProject runs — the formula both writes render from.
    expect(ensureBeadFormula(`${bdRepo.repo}/.beads`).status).toBe("installed");
    project = {
      id: "p",
      slug: "p",
      name: "p",
      repoPath: bdRepo.repo,
      defaultBranch: "main",
      hasBeads: true,
      createdAt: 0,
    };
  });

  afterAll(() => bdRepo.cleanup());

  const board = () => beads.list(bdRepo.repo, ["--status", "all"]);
  const find = (list: Bead[], id: string): Bead => {
    const bead = list.find((b) => b.id === id);
    if (!bead) throw new Error(`${id} is not on the board`);
    return bead;
  };

  it("lands a feature under the epic it shapes alongside it", async () => {
    const created = await createDraftFeature(project, {
      feature: FEATURE,
      epic: { kind: "new", epic: EPIC },
    });
    expect(created.epicCreated).toBe(true);

    const list = await board();
    const feature = find(list, created.id);
    const epic = find(list, created.epicId);

    expect(feature.issue_type).toBe("feature");
    expect(beads.parentOf(feature)).toBe(epic.id);
    expect(epic.issue_type).toBe("epic");
    expect(epic.labels).toContain(`area:${EPIC.area}`);

    // Both land shaped: no repair pass, no "unshaped" badge on a bead anton itself just created.
    expect(validateBeadContract(feature)).toEqual([]);
    expect(validateBeadContract(epic)).toEqual([]);

    // And they classify the way the runner classifies them: the feature is the run target, the
    // epic became a container the moment it landed under it.
    expect(beads.isRunTarget(feature, list)).toBe(true);
    expect(beads.isContainer(epic, list)).toBe(true);
    expect(beads.isRunTarget(epic, list)).toBe(false);
    // Unapproved and open — the board derives `backlog`, and approval stays the founder's gate.
    expect(feature.status).toBe("open");
    expect(beads.isApproved(feature)).toBe(false);
  });

  it("attaches a second feature to the epic already on the board", async () => {
    const epic = (await board()).find((b) => b.issue_type === "epic");
    if (!epic) throw new Error("expected the epic the first case created to still be on the board");
    const epicId = epic.id;

    const created = await createDraftFeature(project, {
      feature: { ...FEATURE, title: "Export a report view to PDF" },
      epic: { kind: "existing", id: epicId },
    });
    expect(created).toMatchObject({ epicId, epicCreated: false });

    const list = await board();
    expect(beads.parentOf(find(list, created.id))).toBe(epicId);
    expect(list.filter((b) => b.issue_type === "epic")).toHaveLength(1);
  });

  it("refuses an epic id the board does not hold, writing nothing", async () => {
    const before = (await board()).length;
    await expect(
      createDraftFeature(project, {
        feature: FEATURE,
        epic: { kind: "existing", id: "p-nope" },
      }),
    ).rejects.toThrow(DraftEpicError);
    expect((await board()).length).toBe(before);
  });
});
