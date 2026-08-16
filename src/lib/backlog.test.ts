/**
 * The Add-work commit path (anton-8mnr, anton-h1ds). What lands is a `feature` under an epic — the
 * tier anton runs — rendered from the project's bead formula. So what these assert is the promise
 * the board depends on: a draft the founder accepts becomes beads `validateBeadContract` passes with
 * ZERO violations, parented, with no separate repair pass and no "unshaped" badge on a bead anton
 * itself just created. A draft naming no epic never reaches bd at all.
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Bead } from "./beads/types";
import type { Project } from "./types";

const { boardRef, allIssues, refreshAllIssues, loadAllIssues } = vi.hoisted(() => {
  const boardRef = { current: [] as Bead[] };
  return {
    boardRef,
    allIssues: vi.fn(async () => boardRef.current),
    refreshAllIssues: vi.fn(async () => boardRef.current),
    loadAllIssues: vi.fn(async () => boardRef.current),
  };
});
vi.mock("./beads/issues", () => ({ allIssues, refreshAllIssues, loadAllIssues }));

import { beads } from "./beads/bd";
import { withBeadWriteLock } from "./beads/claim-lock";
import {
  buildEpicSkeleton,
  buildFeatureSkeleton,
  createDraftFeature,
  DraftContractError,
  DraftEpicError,
  epicChoices,
  knownAreas,
} from "./backlog";
import { validateBeadContract } from "./beads/contract";
import { projectBeadFormulaPath } from "./beads/formula";

const temps: string[] = [];
afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
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

const EPIC = {
  title: "Reports are shareable outside the app",
  goal: "Every report view leaves the app in a format a customer can open.",
  successCriteria: "- [ ] every report view exports to CSV and PDF",
  area: "reports",
};

const FEATURE = {
  title: "Export a report view to CSV",
  goal: "A customer can take a report out of the app as CSV.",
  acceptance: "- [ ] every report view has a working CSV export button",
  context: "touches: src/app/reports; follow the pattern in src/lib/export.ts",
  outOfScope: "- PDF export, which is its own feature",
  verify: "unit test on the serializer, route test on the download",
};

const bead = (over: Partial<Bead> & { id: string }): Bead => ({
  title: over.title ?? "t",
  status: "open",
  ...over,
});

/** The board the issue reads answer with for the epic resolution + picker tests. */
function boardIs(...list: Bead[]): void {
  boardRef.current = list;
}

beforeEach(() => {
  boardIs();
  allIssues.mockClear();
  refreshAllIssues.mockClear();
  loadAllIssues.mockClear();
});

/**
 * Stand in for `bd create --graph`, landing every planned node on the mocked board and answering
 * bd's key → id map. Keeps the whole plan atomic the way bd is: one call, all or nothing.
 */
function graphLands() {
  let n = 0;
  return vi.spyOn(beads, "createGraph").mockImplementation(async (_cwd, plan) => {
    const ids: Record<string, string> = {};
    for (const node of plan.nodes) {
      const id = `p-${10 + n}`;
      n += 1;
      ids[node.key] = id;
      boardRef.current = [
        ...boardRef.current,
        bead({ id, title: node.title, issue_type: node.type, labels: node.labels }),
      ];
    }
    return ids;
  });
}

describe("buildEpicSkeleton", () => {
  it("renders an epic the contract validator passes with zero violations", async () => {
    const project = tempProject();
    const skeleton = await buildEpicSkeleton(project, EPIC);

    expect(
      validateBeadContract({
        id: "x-1",
        title: EPIC.title,
        status: "open",
        issue_type: skeleton.type,
        description: skeleton.description,
        acceptance_criteria: skeleton.acceptance,
        labels: [`area:${EPIC.area}`],
        created_at: "2026-07-29T00:00:00Z",
      }),
    ).toEqual([]);
  });

  it("puts the outcome under `## Goal` so the board card can read it", async () => {
    const { description } = await buildEpicSkeleton(tempProject(), EPIC);
    expect(description).toContain("## Goal");
    expect(description).toContain(EPIC.goal);
    expect(description).toContain("## Success Criteria");
    // The founder filled every field, so no prompt survives into the bead.
    expect(description).not.toContain("TODO");
  });

  it("mirrors the success criteria into bd's own acceptance field", async () => {
    const skeleton = await buildEpicSkeleton(tempProject(), EPIC);
    expect(skeleton.acceptance).toBe(EPIC.successCriteria);
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

    const { description } = await buildEpicSkeleton(project, EPIC);
    expect(description).toContain("## House rule");
  });
});

describe("buildFeatureSkeleton", () => {
  it("renders a feature the contract validator passes with zero violations", async () => {
    const skeleton = await buildFeatureSkeleton(tempProject(), FEATURE);

    expect(skeleton.type).toBe("feature");
    expect(
      validateBeadContract({
        id: "x-2",
        title: FEATURE.title,
        status: "open",
        issue_type: skeleton.type,
        description: skeleton.description,
        acceptance_criteria: skeleton.acceptance,
        created_at: "2026-08-16T00:00:00Z",
      }),
    ).toEqual([]);
  });

  it("carries all five sections the run and its self-review read", async () => {
    const { description, acceptance } = await buildFeatureSkeleton(tempProject(), FEATURE);
    for (const heading of [
      "## Goal",
      "## Acceptance Criteria",
      "## Context",
      "## Out of scope",
      "## Verify",
    ]) {
      expect(description).toContain(heading);
    }
    expect(description).toContain(FEATURE.outOfScope);
    expect(description).not.toContain("TODO");
    expect(acceptance).toBe(FEATURE.acceptance);
  });
});

describe("createDraftFeature — what the Add-work commit lands", () => {
  const project = () => tempProject();

  it("creates a FEATURE parented to the chosen epic, not an epic of its own", async () => {
    boardIs(bead({ id: "p-1", issue_type: "epic", title: "Reports are shareable" }));
    const create = vi.spyOn(beads, "create").mockResolvedValue("p-9");

    const created = await createDraftFeature(project(), {
      feature: FEATURE,
      epic: { kind: "existing", id: "p-1" },
    });

    expect(created).toEqual({ id: "p-9", epicId: "p-1", epicCreated: false });
    expect(create).toHaveBeenCalledTimes(1);
    expect(create.mock.calls[0]![1]).toMatchObject({
      type: "feature",
      deps: ["parent-child:p-1"],
      acceptance: FEATURE.acceptance,
    });
  });

  // The whole tree goes in ONE bd write. Two sequential creates cannot be made atomic, and the
  // failure was not hypothetical: a feature write that timed out stranded the epic it had just
  // minted, and the unchanged retry minted a second one beside it (codex review, PR #151).
  it("shapes a new epic and its feature as one atomic graph plan, never two writes", async () => {
    const createGraph = graphLands();
    const create = vi.spyOn(beads, "create");

    const created = await createDraftFeature(project(), {
      feature: FEATURE,
      epic: { kind: "new", epic: EPIC },
    });

    expect(created).toEqual({ id: "p-11", epicId: "p-10", epicCreated: true });
    expect(createGraph).toHaveBeenCalledTimes(1);
    expect(create).not.toHaveBeenCalled();
    expect(createGraph.mock.calls[0]![1].nodes).toEqual([
      expect.objectContaining({ key: "epic", type: "epic", labels: ["area:reports"] }),
      expect.objectContaining({ key: "feature", type: "feature", parent_key: "epic" }),
    ]);
  });

  // bd rolls a failed plan back whole, so a rejection means nothing landed — no orphan epic to name,
  // and the founder's unchanged retry is the right next move rather than a duplicate-maker.
  it("leaves no epic behind when the graph write fails", async () => {
    vi.spyOn(beads, "createGraph").mockRejectedValueOnce(new Error("bd exploded"));

    await expect(
      createDraftFeature(project(), { feature: FEATURE, epic: { kind: "new", epic: EPIC } }),
    ).rejects.toThrow("bd exploded");
    expect(boardRef.current).toEqual([]);
  });

  it("refuses a draft that names no epic — never a parentless feature", async () => {
    const create = vi.spyOn(beads, "create");
    await expect(
      createDraftFeature(project(), { feature: FEATURE, epic: { kind: "existing", id: "  " } }),
    ).rejects.toThrow(DraftEpicError);
    expect(create).not.toHaveBeenCalled();
  });

  it("refuses an epic the board no longer holds, naming it", async () => {
    boardIs(bead({ id: "p-1", issue_type: "epic" }));
    const create = vi.spyOn(beads, "create");

    const rejection = await createDraftFeature(project(), {
      feature: FEATURE,
      epic: { kind: "existing", id: "p-404" },
    }).then(
      () => undefined,
      (e: unknown) => e as Error,
    );
    expect(rejection).toBeInstanceOf(DraftEpicError);
    expect(rejection?.message).toContain("p-404");
    expect(create).not.toHaveBeenCalled();
  });

  it("refuses to parent a feature under a bead that is not an epic", async () => {
    boardIs(bead({ id: "p-2", issue_type: "feature" }));
    const create = vi.spyOn(beads, "create");

    await expect(
      createDraftFeature(project(), { feature: FEATURE, epic: { kind: "existing", id: "p-2" } }),
    ).rejects.toThrow(DraftEpicError);
    expect(create).not.toHaveBeenCalled();
  });

  // The board can move while the shape page is open, so the picker's eligibility rule is re-checked
  // against a fresh read at submit — otherwise a stale selection writes exactly what the picker
  // refuses to offer.
  it.each([
    ["closed", bead({ id: "p-1", issue_type: "epic", status: "closed" }), "closed"],
    ["abandoned", bead({ id: "p-1", issue_type: "epic", labels: ["abandoned"] }), "abandoned"],
    [
      "approved and running as its own target",
      bead({ id: "p-1", issue_type: "epic", labels: ["approved"] }),
      "approved and running",
    ],
    [
      "claimed and running as its own target",
      bead({ id: "p-1", issue_type: "epic", status: "in_progress" }),
      "claimed and running",
    ],
    // A human reservation on a standalone epic is the same hazard one step earlier: converting it to
    // a container leaves an assignee the claim route (isRunTarget 422) can no longer release.
    [
      "reserved by a human claim",
      bead({ id: "p-1", issue_type: "epic", assignee: "ada" }),
      "reserved by ada",
    ],
  ])("refuses an epic that went %s after the page rendered", async (_state, epic, message) => {
    boardIs(epic);
    const create = vi.spyOn(beads, "create");

    const rejection = await createDraftFeature(project(), {
      feature: FEATURE,
      epic: { kind: "existing", id: "p-1" },
    }).then(
      () => undefined,
      (e: unknown) => e as Error,
    );
    expect(rejection).toBeInstanceOf(DraftEpicError);
    expect(rejection?.message).toContain(message);
    expect(create).not.toHaveBeenCalled();
  });

  // The warm snapshot the picker rendered from is the very thing that can be stale here — serving it
  // back would re-check eligibility against the same answer that produced the stale selection. Nor
  // the snapshot REFRESH, which answers with the retained board when another write bumps its
  // generation mid-flight: last-good data is right for a view and wrong for a gate about to write.
  it("re-checks eligibility against a raw bd read, never a snapshot-backed one", async () => {
    boardIs(bead({ id: "p-1", issue_type: "epic" }));
    vi.spyOn(beads, "create").mockResolvedValue("p-9");
    const target = project();

    await createDraftFeature(target, { feature: FEATURE, epic: { kind: "existing", id: "p-1" } });

    expect(loadAllIssues).toHaveBeenCalledWith(target.repoPath);
    expect(allIssues).not.toHaveBeenCalled();
    expect(refreshAllIssues).not.toHaveBeenCalled();
  });

  // The re-check is a read, so on its own it only narrows the window: an approve or a claim landing
  // between it and the child write still converts a live run target into a container behind its
  // runner's back. Both halves therefore run on the epic's write chain — the one approve and claim
  // queue on — so nothing can move the epic between the verdict and the write it authorized.
  it("holds the epic's write lock across the re-check and the child write", async () => {
    boardIs(bead({ id: "p-1", issue_type: "epic" }));
    const target = project();
    const order: string[] = [];

    let checking!: () => void;
    const checkStarted = new Promise<void>((resolve) => (checking = resolve));
    loadAllIssues.mockImplementationOnce(async () => {
      checking();
      return boardRef.current;
    });
    // The write is given real duration on purpose: an approve queued mid-check runs within
    // microtasks when nothing orders it, so a zero-cost write would let this pass unlocked.
    vi.spyOn(beads, "create").mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      order.push("create");
      return "p-9";
    });

    const commit = createDraftFeature(target, {
      feature: FEATURE,
      epic: { kind: "existing", id: "p-1" },
    });
    // Queued while the commit sits mid-check: unlocked, this approve would run in that very window.
    await checkStarted;
    const approve = withBeadWriteLock(target.repoPath, "p-1", async () => {
      order.push("approve");
    });

    await expect(commit).resolves.toMatchObject({ id: "p-9", epicId: "p-1" });
    await approve;
    expect(order).toEqual(["create", "approve"]);
  });

  // The NEW-epic path needs no lock and no re-check: the epic is never on the shared board without
  // its child, so there is no childless window for an approve or a claim to land in. Reading the
  // board at all here would only be a chance to refuse a draft for something the plan makes
  // unreachable.
  it("neither locks nor re-reads the board for an epic it creates in the same plan", async () => {
    const target = project();
    graphLands();
    const locked: string[] = [];
    // Held for the whole commit: a path that queued on the epic's chain would deadlock behind this.
    const held = withBeadWriteLock(target.repoPath, "p-10", async () => {
      locked.push("holder");
      await new Promise((resolve) => setTimeout(resolve, 20));
    });

    await expect(
      createDraftFeature(target, { feature: FEATURE, epic: { kind: "new", epic: EPIC } }),
    ).resolves.toMatchObject({ id: "p-11", epicId: "p-10", epicCreated: true });
    expect(loadAllIssues).not.toHaveBeenCalled();
    await held;
    expect(locked).toEqual(["holder"]);
  });

  it("still accepts an approved epic that already groups features — it is not the run target", async () => {
    boardIs(
      bead({ id: "p-1", issue_type: "epic", labels: ["approved"] }),
      bead({ id: "p-2", issue_type: "feature", parent: "p-1" }),
    );
    vi.spyOn(beads, "create").mockResolvedValue("p-9");

    await expect(
      createDraftFeature(project(), { feature: FEATURE, epic: { kind: "existing", id: "p-1" } }),
    ).resolves.toMatchObject({ id: "p-9", epicId: "p-1" });
  });

  // The contract gate throws BEFORE any bd write: a placeholder draft never becomes a bead the
  // board would immediately flag as unapprovable, and never strands a half-written tree.
  it("rejects prompt-only acceptance criteria before writing anything", async () => {
    boardIs(bead({ id: "p-1", issue_type: "epic" }));
    const create = vi.spyOn(beads, "create");

    await expect(
      createDraftFeature(project(), {
        feature: { ...FEATURE, acceptance: "- [ ] TODO — decide later" },
        epic: { kind: "existing", id: "p-1" },
      }),
    ).rejects.toThrow(DraftContractError);
    expect(create).not.toHaveBeenCalled();
  });

});

// The epic half is judged with the same validator, and — like the feature's — ahead of the single
// write that would land it, so a placeholder draft never becomes a bead the board immediately flags
// as unapprovable.
describe("the NEW epic's contract gate, ahead of the graph write", () => {
  const shapeEpic = (over: Partial<typeof EPIC>) => {
    const createGraph = vi.spyOn(beads, "createGraph");
    return createDraftFeature(tempProject(), {
      feature: FEATURE,
      epic: { kind: "new", epic: { ...EPIC, ...over } },
    }).then(
      () => {
        throw new Error("expected the draft to be refused");
      },
      (e: unknown) => {
        expect(createGraph).not.toHaveBeenCalled();
        return e as DraftContractError;
      },
    );
  };

  it("rejects criteria that are still a TODO prompt — the bead would land contract-blocked", async () => {
    await expect(shapeEpic({ successCriteria: "- [ ] TODO — decide later" })).resolves.toBeInstanceOf(
      DraftContractError,
    );
  });

  it("rejects a prompt-only goal too — Add-work lands zero-violation beads by construction", async () => {
    await expect(shapeEpic({ goal: "TODO — the outcome, one line" })).resolves.toBeInstanceOf(
      DraftContractError,
    );
  });

  it("names the gap in the error so the route's 422 tells the founder what to fix", async () => {
    const rejection = await shapeEpic({ successCriteria: "- [ ] TODO — decide later" });
    expect(rejection.violations.map((v) => v.section)).toEqual(["Success Criteria"]);
    expect(rejection.message).toContain("Success Criteria");
  });
});

describe("epicChoices", () => {
  it("offers the live epics, titled and sorted, with their area", () => {
    expect(
      epicChoices([
        bead({ id: "p-2", issue_type: "epic", title: "Reports", labels: ["area:reports"] }),
        bead({ id: "p-1", issue_type: "epic", title: "Billing", labels: ["area:billing"] }),
        bead({ id: "p-3", issue_type: "feature", title: "A feature" }),
      ]),
    ).toEqual([
      { id: "p-1", title: "Billing", area: "billing", looseTickets: 0 },
      { id: "p-2", title: "Reports", area: "reports", looseTickets: 0 },
    ]);
  });

  it("drops closed and abandoned epics — new work never attaches to a finished outcome", () => {
    const choices = epicChoices([
      bead({ id: "p-1", issue_type: "epic", title: "Done", status: "closed" }),
      bead({ id: "p-2", issue_type: "epic", title: "Dropped", labels: ["abandoned"] }),
      bead({ id: "p-3", issue_type: "epic", title: "Live" }),
    ]);
    expect(choices.map((c) => c.id)).toEqual(["p-3"]);
  });

  // A ticket under a container epic never runs, so the picker has to be able to warn: landing a
  // feature here is what turns those tickets into dead beads.
  it("counts the tickets hanging directly off each epic", () => {
    const choices = epicChoices([
      bead({ id: "p-1", issue_type: "epic", title: "Legacy" }),
      bead({ id: "p-2", issue_type: "task", parent: "p-1" }),
      bead({ id: "p-3", issue_type: "bug", parent: "p-1" }),
      bead({ id: "p-4", issue_type: "feature", parent: "p-1" }),
      bead({ id: "p-5", issue_type: "task", parent: "p-4" }),
    ]);
    expect(choices).toEqual([{ id: "p-1", title: "Legacy", area: undefined, looseTickets: 2 }]);
  });

  // A shipped or dropped ticket strands nothing, so warning about it would steer the founder away
  // from the epic their feature actually belongs under.
  it("ignores settled tickets in the loose-ticket count", () => {
    const choices = epicChoices([
      bead({ id: "p-1", issue_type: "epic", title: "Legacy" }),
      bead({ id: "p-2", issue_type: "task", parent: "p-1", status: "closed" }),
      bead({ id: "p-3", issue_type: "bug", parent: "p-1", status: "closed", labels: ["abandoned"] }),
      bead({ id: "p-4", issue_type: "task", parent: "p-1" }),
    ]);
    expect(choices).toEqual([{ id: "p-1", title: "Legacy", area: undefined, looseTickets: 1 }]);
  });

  // Landing a feature under a legacy epic anton is already running turns it into a container
  // mid-flight: its queued run is poison-parked, an in-review one strands its PR.
  it("drops epics anton is already running as targets of their own", () => {
    const choices = epicChoices([
      bead({ id: "p-1", issue_type: "epic", title: "Approved", labels: ["approved"] }),
      bead({ id: "p-2", issue_type: "epic", title: "Claimed", status: "in_progress" }),
      bead({ id: "p-3", issue_type: "epic", title: "Backlog" }),
      // Approved but already a container — features run beneath it, so it is not the run target.
      bead({ id: "p-4", issue_type: "epic", title: "Grouping", labels: ["approved"] }),
      bead({ id: "p-5", issue_type: "feature", parent: "p-4" }),
    ]);
    expect(choices.map((c) => c.id)).toEqual(["p-3", "p-4"]);
  });

  // An open, unapproved epic someone has reserved is still a run target of its own: converting it to
  // a container strands the reservation on a bead the claim route refuses to release, while the new
  // feature lands unclaimed for anyone else to take.
  it("drops standalone epics a human has reserved, keeping ones that already group features", () => {
    const choices = epicChoices([
      bead({ id: "p-1", issue_type: "epic", title: "Reserved", assignee: "ada" }),
      // Whitespace is bd's "unclaimed" (ownerOf), not a holder.
      bead({ id: "p-2", issue_type: "epic", title: "Blank claim", assignee: "  " }),
      // Reserved but already a container — the assignee was never on a run target here.
      bead({ id: "p-3", issue_type: "epic", title: "Grouping", assignee: "ada" }),
      bead({ id: "p-4", issue_type: "feature", parent: "p-3" }),
    ]);
    expect(choices.map((c) => c.id)).toEqual(["p-2", "p-3"]);
  });
});

describe("knownAreas", () => {
  const labelled = (labels: string[]): Bead => ({ id: "x", title: "t", status: "open", labels });

  it("collects the board's area: vocabulary, deduped and sorted", () => {
    expect(
      knownAreas([
        labelled(["area:reports", "domain:eng"]),
        labelled(["area:billing"]),
        labelled(["area:reports"]),
        labelled([]),
      ]),
    ).toEqual(["billing", "reports"]);
  });

  it("is empty on a board with no epics tagged yet", () => {
    expect(knownAreas([labelled(["domain:eng"])])).toEqual([]);
  });
});
