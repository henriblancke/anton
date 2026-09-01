import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Bead } from "./beads/bd";
import { STAGES } from "./types";
import type { ScanHealth } from "./scan-health";
import type { HygieneReport, Project } from "./types";

const listMock = vi.fn();

vi.mock("./beads/bd", async () => {
  const actual = await vi.importActual<typeof import("./beads/bd")>("./beads/bd");
  return {
    ...actual,
    beads: {
      ...actual.beads,
      list: (...args: unknown[]) => listMock(...args),
    },
  };
});

// The board folds the gardener's latest report (and its version) into its payload and freshness
// token. Stubbed at the module seam so these tests need no anton.db; `hygieneReport` is what the
// project has been patrolled with, and every test but the hygiene ones runs un-patrolled.
let hygieneReport: HygieneReport | undefined;

vi.mock("./hygiene", async () => {
  const actual = await vi.importActual<typeof import("./hygiene")>("./hygiene");
  return {
    ...actual,
    latestHygieneReport: async () => hygieneReport,
    latestHygieneVersion: async () => actual.hygieneVersion(hygieneReport),
  };
});

// Same seam, same reason, for the nightly stringer's scan series: the board folds the latest scan
// into its payload and freshness token, so an unstubbed read here reaches the real anton.db —
// whatever the developer's last nightly left behind locally, and a schema-less file CI creates on
// the spot (the read then degrades to "never scanned" and logs, which is what made these suites
// print SqliteError noise on a green run). `scanHealth` is what the project has been scanned with,
// and every test here runs un-scanned.
let scanHealth: ScanHealth | undefined;

vi.mock("./scan-health", async () => {
  const actual = await vi.importActual<typeof import("./scan-health")>("./scan-health");
  return {
    ...actual,
    latestScanHealth: async () => scanHealth,
    latestScanHealthVersion: async () => actual.scanHealthVersion(scanHealth),
  };
});

// Same seam, same reason, for the picker vetoes the board folds into its cards and its freshness
// token (anton-jqvy): an unstubbed read reaches the real anton.db. `deferrals` is what this
// project's operator has set aside, and every test but the veto ones runs with nothing deferred.
let deferrals = new Map<string, number>();

vi.mock("./picker-veto", async () => {
  const actual = await vi.importActual<typeof import("./picker-veto")>("./picker-veto");
  return {
    ...actual,
    latestPickerDeferrals: async () => deferrals,
  };
});

// Same seam, same reason, for the two reads a card's provenance badges come from (anton-cqxd): the
// picker's recorded plan and the policy it was picked under both live in anton.db. `pickerPlan` is
// what the picker last decided here, and every test but the provenance ones runs with no plan.
let pickerPlan: import("./board-picker-plan").BoardPickerPlan | undefined;

vi.mock("./board-picker-plan", async () => {
  const actual =
    await vi.importActual<typeof import("./board-picker-plan")>("./board-picker-plan");
  return { ...actual, latestBoardPickerPlan: async () => pickerPlan };
});

// Whether a board-picker pass still runs here (anton-t9m4): the lane is a projection of what that
// pass would start next, and the badge is derived from a plan only while one is being kept. Stubbed
// at the schedule seam so no test needs anton.db; armed is the default, as it is for a project the
// operator has never switched off.
let pickerArmed = true;

vi.mock("./schedules", async () => {
  const actual = await vi.importActual<typeof import("./schedules")>("./schedules");
  return { ...actual, isScheduleEnabled: async () => pickerArmed };
});

// The policy armed on this machine (anton-t9m4 review): half of the plan's freshness fence, so a
// test can move it without touching a bead. Unarmed by default, as a project that never set one.
let projectSettings: { pickerPolicy?: import("./policy/types").Policy } = {};

vi.mock("./projects", async () => {
  const actual = await vi.importActual<typeof import("./projects")>("./projects");
  return { ...actual, getProjectSettings: async () => projectSettings };
});

const { deriveStage, getBoard, getBoardVersion } = await import("./board");
const { resetIssueSnapshots } = await import("./beads/snapshot");
const { contractBlocks, validateBeadContract } = await import("./beads/contract");
const { stampBoard } = await import("./board-picker-plan");

beforeEach(() => {
  resetIssueSnapshots();
  listMock.mockReset();
  hygieneReport = undefined;
  scanHealth = undefined;
  deferrals = new Map();
  pickerPlan = undefined;
  pickerArmed = true;
  projectSettings = {};
});

function makeBead(overrides: Partial<Bead> & { id: string; title: string }): Bead {
  return {
    status: "open",
    issue_type: "task",
    labels: [],
    ...overrides,
  };
}

const project: Project = {
  id: "p1",
  slug: "anton",
  name: "anton",
  repoPath: "/tmp/anton",
  defaultBranch: "main",
  hasBeads: true,
  createdAt: 0,
};

describe("deriveStage", () => {
  it("returns done for closed beads", () => {
    expect(deriveStage(makeBead({ id: "b-1", title: "t", status: "closed" }))).toBe("done");
  });

  it("returns in-review when stage:in-review label present", () => {
    expect(
      deriveStage(
        makeBead({ id: "b-2", title: "t", status: "open", labels: ["stage:in-review"] }),
      ),
    ).toBe("in-review");
  });

  it("returns in-review when metadata.pr is set (the PR seam)", () => {
    expect(
      deriveStage(makeBead({ id: "b-3", title: "t", status: "open", metadata: { pr: "gh-1" } })),
    ).toBe("in-review");
  });

  it("returns in-review for a legacy gh-* external_ref (pre-migration fallback)", () => {
    expect(
      deriveStage(makeBead({ id: "b-3b", title: "t", status: "open", external_ref: "gh-1" })),
    ).toBe("in-review");
  });

  it("does NOT read a non-gh external_ref (a tracker URL) as in-review", () => {
    expect(
      deriveStage(
        makeBead({
          id: "b-3c",
          title: "t",
          status: "open",
          external_ref: "https://tracker.example/ISSUE-7",
        }),
      ),
    ).toBe("backlog");
  });

  it("returns implementing when status is in_progress", () => {
    expect(
      deriveStage(makeBead({ id: "b-4", title: "t", status: "in_progress" })),
    ).toBe("implementing");
  });

  it("returns implementing when stage:implementing label present", () => {
    expect(
      deriveStage(
        makeBead({ id: "b-5", title: "t", status: "open", labels: ["stage:implementing"] }),
      ),
    ).toBe("implementing");
  });

  it("returns backlog otherwise", () => {
    expect(deriveStage(makeBead({ id: "b-6", title: "t", status: "open" }))).toBe("backlog");
  });
});

describe("getBoard", () => {
  it("groups epics by stage, parses goal, and surfaces orphan tasks as standalone chips", async () => {
    const epic1 = makeBead({
      id: "epic-1",
      title: "Epic One",
      issue_type: "epic",
      status: "open",
      description: "## Goal\nShip the thing.\n\n## Out of scope\nEverything else.",
      acceptance: "It ships.",
      labels: ["approved"],
      assignee: "carol",
      created_at: "2026-07-12T09:00:00Z",
      created_by: "dave",
    });
    const epic2 = makeBead({
      id: "epic-2",
      title: "Epic Two",
      issue_type: "epic",
      status: "closed",
      description: "intro\n## Goal\nDone deal.\n",
    });
    const ticket1 = makeBead({
      id: "ticket-1",
      title: "Ticket One",
      status: "in_progress",
      parent: "epic-1",
      labels: ["agent:nextjs", "risk:high", "size:S"],
      acceptance: "Works.",
      assignee: "alice",
      created_at: "2026-07-13T10:00:00Z",
      created_by: "bob",
    });
    const ticket2 = makeBead({
      id: "ticket-2",
      title: "Ticket Two",
      status: "closed",
      parent: "epic-2",
      metadata: { pr: "gh-42" },
    });
    const orphan = makeBead({
      id: "orphan-1",
      title: "Orphan Task",
      status: "open",
      labels: ["approved"],
    });

    listMock.mockResolvedValue([epic1, epic2, ticket1, ticket2, orphan]);

    const board = await getBoard(project);

    expect(board.projectSlug).toBe("anton");
    expect(Object.keys(board.columns).sort()).toEqual(
      ["backlog", "implementing", "in-review", "done"].sort(),
    );

    const backlogEpic = board.columns.backlog.find((e) => e.id === "epic-1");
    expect(backlogEpic).toBeDefined();
    expect(backlogEpic!.goal).toBe("Ship the thing.");
    expect(backlogEpic!.acceptance).toBe("It ships.");
    expect(backlogEpic!.approved).toBe(true);
    expect(backlogEpic!.tickets).toHaveLength(1);
    expect(backlogEpic!.tickets[0]).toMatchObject({
      id: "ticket-1",
      agent: "nextjs",
      risk: "high",
      size: "S",
      acceptance: "Works.",
      stage: "implementing",
      assignee: "alice",
      createdAt: "2026-07-13T10:00:00Z",
      createdBy: "bob",
    });
    // The epic itself carries the same claimed-by + created metadata.
    expect(backlogEpic!).toMatchObject({
      assignee: "carol",
      createdAt: "2026-07-12T09:00:00Z",
      createdBy: "dave",
    });

    const doneEpic = board.columns.done.find((e) => e.id === "epic-2");
    expect(doneEpic).toBeDefined();
    expect(doneEpic!.goal).toBe("Done deal.");
    expect(doneEpic!.tickets[0]).toMatchObject({ id: "ticket-2", prRef: "gh-42", stage: "done" });

    // The orphan task is NOT wrapped as a fake epic — it surfaces as a standalone chip carrying
    // its real issue_type, grouped under its derived stage.
    expect(board.columns.backlog.some((e) => e.id === "orphan-1")).toBe(false);
    const orphanItem = board.standalone.backlog.find((i) => i.id === "orphan-1");
    expect(orphanItem).toBeDefined();
    expect(orphanItem!.type).toBe("task");
    expect(orphanItem!.approved).toBe(true);
    expect(orphanItem!.stage).toBe("backlog");
    expect(orphanItem!.unread).toBe(false); // an approved task is never an unread bug
    // Null-safe: an unclaimed orphan has no assignee/created_by and an empty createdAt.
    expect(orphanItem!).toMatchObject({ assignee: null, createdAt: "", createdBy: null });
  });

  it("carries issue_type through and groups standalone items by derived stage", async () => {
    const backlogBug = makeBead({ id: "bug-1", title: "Loose bug", issue_type: "bug", status: "open" });
    const workingTask = makeBead({
      id: "task-1",
      title: "Loose task in flight",
      issue_type: "task",
      status: "in_progress",
    });
    // A task WITH a parent epic is a child, never standalone.
    const parentEpic = makeBead({ id: "epic-x", title: "Epic X", issue_type: "epic", status: "open" });
    const child = makeBead({ id: "child-1", title: "Child", issue_type: "task", parent: "epic-x" });

    listMock.mockResolvedValue([backlogBug, workingTask, parentEpic, child]);

    const board = await getBoard(project);

    const bug = board.standalone.backlog.find((i) => i.id === "bug-1");
    expect(bug?.type).toBe("bug");
    expect(board.standalone.implementing.map((i) => i.id)).toEqual(["task-1"]);
    expect(board.standalone.implementing[0].type).toBe("task");
    // The child ticket rides on its epic, not the standalone group.
    expect(board.standalone.backlog.some((i) => i.id === "child-1")).toBe(false);
    expect(board.standalone.implementing.some((i) => i.id === "child-1")).toBe(false);
    expect(board.columns.backlog.find((e) => e.id === "epic-x")?.tickets.map((t) => t.id)).toEqual([
      "child-1",
    ]);
  });

  it("attaches the parent epic to a card — the swimlane grouping key", async () => {
    const outcome = makeBead({
      id: "epic-o",
      title: "Ontology editing",
      issue_type: "epic",
      status: "open",
      labels: ["area:ontology"],
    });
    const under = makeBead({
      id: "epic-u",
      title: "Term merge",
      issue_type: "epic",
      parent: "epic-o",
      status: "open",
    });

    listMock.mockResolvedValue([outcome, under]);

    const board = await getBoard(project);

    // The crumb carries the epic's `area:` too — the board's Area facet reads it off the card.
    expect(board.columns.backlog.find((e) => e.id === "epic-u")?.epic).toEqual({
      id: "epic-o",
      title: "Ontology editing",
      area: "ontology",
    });
    // A top-level card has no epic above it, so the board collects it in the "No epic" lane.
    expect(board.columns.backlog.find((e) => e.id === "epic-o")?.epic).toBeUndefined();
  });

  it("does not surface a parentless non-runnable type (learning/chore) as a chip", async () => {
    // A parentless `learning` is not a run target (beads.isRunTarget → false), so a chip for it
    // would advertise `Approve & run` yet the approve route + runner reject it — a permanent 422.
    // It must not appear on the board at all (no fake epic, no standalone chip).
    const learning = makeBead({ id: "learn-1", title: "A loose learning", issue_type: "learning" });
    const bug = makeBead({ id: "bug-1", title: "Runnable bug", issue_type: "bug", status: "open" });

    listMock.mockResolvedValue([learning, bug]);

    const board = await getBoard(project);

    const allStandalone = STAGES.flatMap((s) => board.standalone[s]);
    expect(allStandalone.some((i) => i.id === "learn-1")).toBe(false);
    const allColumns = STAGES.flatMap((s) => board.columns[s]);
    expect(allColumns.some((e) => e.id === "learn-1")).toBe(false);
    // The runnable bug is unaffected.
    expect(allStandalone.some((i) => i.id === "bug-1")).toBe(true);
  });

  it("keys cards off run targets: a 3-level tree drops nothing and each bead lands under its parent", async () => {
    // epic → feature → task → subtask. The feature is the run target (the card); the epic above it
    // is a container (badge/swimlane key only, since approving it 422s); the working layer rides the
    // feature's card, however deep. Before this keying the task and subtask matched neither the
    // epic-child join nor the parentless-chip rule and disappeared from the board entirely.
    const epic = makeBead({ id: "epic-p", title: "Product outcome", issue_type: "epic" });
    const feature = makeBead({
      id: "feat-1",
      title: "Resumable crawl checkpoints",
      issue_type: "feature",
      parent: "epic-p",
      description: "## Goal\nCheckpoint the crawl.",
    });
    const task = makeBead({ id: "task-1", title: "Write the checkpoint", parent: "feat-1" });
    const subtask = makeBead({ id: "sub-1", title: "Serialise the cursor", parent: "task-1" });
    const chip = makeBead({ id: "loose-1", title: "Loose task", issue_type: "task" });

    listMock.mockResolvedValue([epic, feature, task, subtask, chip]);

    const board = await getBoard(project);

    const cards = STAGES.flatMap((s) => board.columns[s]);
    const chips = STAGES.flatMap((s) => board.standalone[s]);
    // The feature is the card, and it carries its whole working layer — including the grandchild.
    expect(cards.map((c) => c.id)).toEqual(["feat-1"]);
    const featureCard = cards.find((c) => c.id === "feat-1")!;
    expect(featureCard.goal).toBe("Checkpoint the crawl.");
    expect(featureCard.tickets.map((t) => t.id)).toEqual(["task-1", "sub-1"]);
    // The container epic is not a card — it reaches the card as the badge/swimlane crumb instead.
    expect(featureCard.epic).toEqual({ id: "epic-p", title: "Product outcome", area: undefined });
    // ...and no working-layer bead leaked into the chip group (they belong to the feature's run).
    expect(chips.map((c) => c.id)).toEqual(["loose-1"]);

    // Nothing is dropped: every bead is a card, a card's ticket, a chip, or the container epic that
    // groups them.
    const rendered = new Set([
      ...cards.map((c) => c.id),
      ...cards.flatMap((c) => c.tickets.map((t) => t.id)),
      ...chips.map((c) => c.id),
      ...cards.flatMap((c) => (c.epic ? [c.epic.id] : [])),
    ]);
    expect([...rendered].sort()).toEqual(["epic-p", "feat-1", "loose-1", "sub-1", "task-1"]);
  });

  it("keeps a legacy epic with no feature children as a card carrying its tasks", async () => {
    // The migration-free half of the runnable rule: an epic only steps back to a container once a
    // feature lands under it. A legacy epic keeps running (and rendering) exactly as it did.
    const legacy = makeBead({
      id: "epic-legacy",
      title: "Legacy epic",
      issue_type: "epic",
      description: "## Goal\nStill runs.",
    });
    const legacyTask = makeBead({ id: "legacy-task", title: "Its ticket", parent: "epic-legacy" });
    // A migrated epic in the same board must not change how the legacy one reads.
    const migrated = makeBead({ id: "epic-new", title: "Migrated epic", issue_type: "epic" });
    const feature = makeBead({
      id: "feat-new",
      title: "Its feature",
      issue_type: "feature",
      parent: "epic-new",
    });

    listMock.mockResolvedValue([legacy, legacyTask, migrated, feature]);

    const board = await getBoard(project);

    const cards = STAGES.flatMap((s) => board.columns[s]);
    expect(cards.map((c) => c.id).sort()).toEqual(["epic-legacy", "feat-new"]);
    const legacyCard = cards.find((c) => c.id === "epic-legacy")!;
    expect(legacyCard.goal).toBe("Still runs.");
    expect(legacyCard.tickets.map((t) => t.id)).toEqual(["legacy-task"]);
    // A legacy epic has no epic above it — the board collects it in the "No epic" lane.
    expect(legacyCard.epic).toBeUndefined();
    // Its ticket stays a ticket, never a chip.
    expect(STAGES.flatMap((s) => board.standalone[s])).toHaveLength(0);
  });

  it("does not surface a container epic itself, as a card or a chip", async () => {
    // An epic with a feature child can't be approved or run (the approve/claim routes 422 it via
    // isRunTarget), so a card for it would advertise a run that never happens. It reaches the board
    // only as the badge/swimlane key on its features.
    const container = makeBead({ id: "epic-c", title: "Container", issue_type: "epic" });
    const feature = makeBead({
      id: "feat-c",
      title: "Feature",
      issue_type: "feature",
      parent: "epic-c",
      status: "in_progress",
    });

    listMock.mockResolvedValue([container, feature]);

    const board = await getBoard(project);

    expect(STAGES.flatMap((s) => board.columns[s]).map((c) => c.id)).toEqual(["feat-c"]);
    expect(STAGES.flatMap((s) => board.standalone[s])).toHaveLength(0);
    expect(board.columns.implementing.map((c) => c.id)).toEqual(["feat-c"]);
  });

  it("marks a self-filed, untouched bug unread and sorts unread chips first", async () => {
    const unread = makeBead({
      id: "bug-unread",
      title: "Self-filed bug",
      issue_type: "bug",
      status: "open",
      labels: ["source:stringer"],
      created_at: "2026-07-10T00:00:00Z",
    });
    // Same source, but claimed → engaged → no longer unread.
    const claimed = makeBead({
      id: "bug-claimed",
      title: "Claimed self-filed bug",
      issue_type: "bug",
      status: "open",
      labels: ["source:stringer"],
      assignee: "alice",
      created_at: "2026-07-14T00:00:00Z",
    });
    // A human-filed bug (no source label) is never "unread".
    const human = makeBead({
      id: "bug-human",
      title: "Human bug",
      issue_type: "bug",
      status: "open",
      created_at: "2026-07-15T00:00:00Z",
    });

    listMock.mockResolvedValue([human, claimed, unread]);

    const board = await getBoard(project);
    const ids = board.standalone.backlog.map((i) => i.id);
    // Unread first, then newest-created.
    expect(ids).toEqual(["bug-unread", "bug-human", "bug-claimed"]);
    expect(board.standalone.backlog.find((i) => i.id === "bug-unread")!.unread).toBe(true);
    expect(board.standalone.backlog.find((i) => i.id === "bug-claimed")!.unread).toBe(false);
    expect(board.standalone.backlog.find((i) => i.id === "bug-human")!.unread).toBe(false);
  });

  it("attaches ready/blockedBy and sorts the backlog so a blocker precedes what it blocks", async () => {
    // epic-late is blocked by epic-early (a direct epic→epic blocks edge). The runtime's bd-ready
    // would skip epic-late, so the board must mark it blocked and sink it below its blocker.
    const early = makeBead({ id: "epic-early", title: "Blocker", issue_type: "epic" });
    const late = makeBead({
      id: "epic-late",
      title: "Blocked",
      issue_type: "epic",
      dependencies: [{ issue_id: "epic-late", depends_on_id: "epic-early", type: "blocks" }],
    });

    listMock.mockResolvedValue([late, early]);

    const board = await getBoard(project);

    const ids = board.columns.backlog.map((e) => e.id);
    expect(ids).toEqual(["epic-early", "epic-late"]);

    const blocker = board.columns.backlog.find((e) => e.id === "epic-early")!;
    const blocked = board.columns.backlog.find((e) => e.id === "epic-late")!;
    expect(blocker.ready).toBe(true);
    expect(blocker.blockedBy).toEqual([]);
    expect(blocked.ready).toBe(false);
    expect(blocked.blockedBy).toEqual(["epic-early"]);
    expect(blocker.rank).toBeLessThan(blocked.rank);
  });

  it("marks an epic blocked by an open standalone task not-ready (the rollup drops that edge)", async () => {
    // A parentless task blocks the epic. computeEpicGraph's rollup can't attribute a standalone
    // blocker to an epic, so it drops the edge — the board must fold it back in via
    // epicStandaloneBlockers, matching the readiness the approve route enforces (409 while open).
    const blockerTask = makeBead({ id: "task-block", title: "Prereq task", issue_type: "task" });
    const epic = makeBead({
      id: "epic-x",
      title: "Depends on a loose task",
      issue_type: "epic",
      dependencies: [{ issue_id: "epic-x", depends_on_id: "task-block", type: "blocks" }],
    });

    listMock.mockResolvedValue([epic, blockerTask]);

    const board = await getBoard(project);

    const built = board.columns.backlog.find((e) => e.id === "epic-x")!;
    expect(built.ready).toBe(false);
    expect(built.blockedBy).toEqual(["task-block"]);
  });

  it("does not treat a closed non-work (molecule) blocker as still-open", async () => {
    // `molecule` beads are filtered off the board, but a `blocks` edge to one still lives on the
    // epic. Blocker readiness must be derived against the UNFILTERED bead list — otherwise the
    // filtered-out (and here already-closed) molecule reads as a phantom open blocker via the
    // helper's missing-bead fail-safe, wrongly marking the epic not-ready and 409ing approval.
    const doneMolecule = makeBead({
      id: "mol-done",
      title: "Coordination artifact",
      issue_type: "molecule",
      status: "closed",
    });
    const epic = makeBead({
      id: "epic-m",
      title: "Depends on a done molecule",
      issue_type: "epic",
      dependencies: [{ issue_id: "epic-m", depends_on_id: "mol-done", type: "blocks" }],
    });

    listMock.mockResolvedValue([epic, doneMolecule]);

    const board = await getBoard(project);

    // The molecule itself never lands on the board...
    const allIds = STAGES.flatMap((s) => [
      ...board.columns[s].map((e) => e.id),
      ...board.standalone[s].map((i) => i.id),
    ]);
    expect(allIds).not.toContain("mol-done");
    // ...and its closed edge doesn't block the epic.
    const built = board.columns.backlog.find((e) => e.id === "epic-m")!;
    expect(built.blockedBy).toEqual([]);
    expect(built.ready).toBe(true);
  });

  it("carries ready/blockedBy onto a standalone item so a blocked chip can't be approved", async () => {
    // Two parentless tasks: task-b blocks task-a. task-a is a standalone run target whose readiness
    // isn't in the epic rollup, so the board derives it from its own blocks edge (standaloneBlockers).
    const blocker = makeBead({ id: "task-b", title: "Prereq", issue_type: "task" });
    const blocked = makeBead({
      id: "task-a",
      title: "Blocked standalone",
      issue_type: "task",
      dependencies: [{ issue_id: "task-a", depends_on_id: "task-b", type: "blocks" }],
    });

    listMock.mockResolvedValue([blocked, blocker]);

    const board = await getBoard(project);

    const a = board.standalone.backlog.find((i) => i.id === "task-a")!;
    const b = board.standalone.backlog.find((i) => i.id === "task-b")!;
    expect(a.ready).toBe(false);
    expect(a.blockedBy).toEqual(["task-b"]);
    expect(b.ready).toBe(true);
    expect(b.blockedBy).toEqual([]);
  });

  it("falls back to merging open + closed lists when --status all fails", async () => {
    const openEpic = makeBead({ id: "epic-open", title: "Open Epic", issue_type: "epic" });
    const closedEpic = makeBead({
      id: "epic-closed",
      title: "Closed Epic",
      issue_type: "epic",
      status: "closed",
    });

    listMock.mockImplementation(async (_cwd: string, extra: string[] = []) => {
      if (extra.includes("all")) throw new Error("unsupported flag");
      if (extra.includes("closed")) return [closedEpic];
      return [openEpic];
    });

    const board = await getBoard(project);

    expect(board.columns.backlog.some((e) => e.id === "epic-open")).toBe(true);
    expect(board.columns.done.some((e) => e.id === "epic-closed")).toBe(true);
  });
});

describe("getBoard contract marking", () => {
  // The four advisory sections, so a fixture can leave out exactly the one under test.
  const GOAL = "## Goal\nSurface the gap before Approve.";
  const CONTEXT = "## Context\ntouches: src/lib/board.ts";
  const OUT_OF_SCOPE = "## Out of scope\n- Editing beads from the board.";
  const VERIFY = "## Verify\n- board.test.ts covers it.";
  const SHAPED = [GOAL, CONTEXT, OUT_OF_SCOPE, VERIFY].join("\n\n");

  /** What the shared validator says, split the way the view model carries it. */
  const contractOf = (bead: Bead) => ({
    blocking: validateBeadContract(bead).filter((v) => v.severity === "blocking"),
    advisory: validateBeadContract(bead).filter((v) => v.severity === "advisory"),
  });

  it("marks a card with a blocking violation and never advertises it as approvable", async () => {
    // Fully shaped prose but no Acceptance anywhere — the run would have no definition of done, so
    // approval refuses it. The board has to say so where it is cheap to fix, not at the 422.
    const unshaped = makeBead({
      id: "feat-unshaped",
      title: "No definition of done",
      issue_type: "feature",
      created_at: "2026-07-20T00:00:00.000Z",
      description: SHAPED,
    });

    listMock.mockResolvedValue([unshaped]);

    const board = await getBoard(project);

    const card = board.columns.backlog.find((e) => e.id === "feat-unshaped")!;
    expect(card.contract!.blocking.map((v) => v.section)).toEqual(["Acceptance"]);
    expect(contractBlocks(card.contract)).toBe(true);
    // Dependency-readiness is untouched — this card is blocked by a gap, not by a prerequisite.
    expect(card.ready).toBe(true);
  });

  it("leaves an advisory-only card approvable, carrying the gap as a nudge", async () => {
    // Acceptance is present (bd's own field), only `## Verify` is missing: the run is startable, so
    // nothing may withhold Approve — the gap rides along as advisory.
    const nudged = makeBead({
      id: "feat-nudge",
      title: "Runnable, thinner than it could be",
      issue_type: "feature",
      created_at: "2026-07-20T00:00:00.000Z",
      description: [GOAL, CONTEXT, OUT_OF_SCOPE].join("\n\n"),
      acceptance_criteria: "- [ ] the board marks unshaped beads",
    });

    listMock.mockResolvedValue([nudged]);

    const board = await getBoard(project);

    const card = board.columns.backlog.find((e) => e.id === "feat-nudge")!;
    expect(contractBlocks(card.contract)).toBe(false);
    expect(card.contract!.advisory.map((v) => v.section)).toEqual(["Verify"]);
  });

  it("derives the marking from the shared validator, not a board-local check", async () => {
    // The whole point of the contract module: one judgement, three sites (board, approve, runner).
    // Assert equality against the validator itself so a board-local re-implementation can't drift.
    const card = makeBead({
      id: "feat-partial",
      title: "Half shaped",
      issue_type: "feature",
      created_at: "2026-07-20T00:00:00.000Z",
      description: GOAL,
    });
    const chip = makeBead({
      id: "task-unshaped",
      title: "Loose task, no acceptance",
      issue_type: "task",
      created_at: "2026-07-20T00:00:00.000Z",
      description: [GOAL, VERIFY].join("\n\n"),
    });

    listMock.mockResolvedValue([card, chip]);

    const board = await getBoard(project);

    expect(board.columns.backlog.find((e) => e.id === "feat-partial")!.contract).toEqual(
      contractOf(card),
    );
    const item = board.standalone.backlog.find((i) => i.id === "task-unshaped")!;
    expect(item.contract).toEqual(contractOf(chip));
    // A standalone chip is gated exactly like a card — same validator, same severity split.
    expect(contractBlocks(item.contract)).toBe(true);
    expect(item.contract!.blocking.map((v) => v.section)).toEqual(["Acceptance"]);
  });

  it("marks a conformant card whose open ticket is unshaped — the gate judges the whole run", async () => {
    // Approval refuses `[target, ...open tickets]`, so a card that reported only its own status
    // rendered no marker, kept Approve enabled, and 422'd on click. The child's id rides in the
    // message: the section is missing on the ticket, not on the card's own bead.
    const card = makeBead({
      id: "feat-parent",
      title: "Shaped target, unshaped ticket",
      issue_type: "feature",
      created_at: "2026-07-20T00:00:00.000Z",
      description: `${SHAPED}\n\n## Acceptance\n- [ ] it works`,
    });
    const child = makeBead({
      id: "task-thin",
      title: "No definition of done",
      parent: "feat-parent",
      created_at: "2026-07-20T00:00:00.000Z",
      description: SHAPED,
    });

    listMock.mockResolvedValue([card, child]);

    const board = await getBoard(project);

    const built = board.columns.backlog.find((e) => e.id === "feat-parent")!;
    expect(contractBlocks(built.contract)).toBe(true);
    expect(built.contract!.blocking.map((v) => v.section)).toEqual(["Acceptance"]);
    expect(built.contract!.blocking[0].message).toContain("task-thin");
  });

  it("leaves a card whose only unshaped ticket is closed approvable", async () => {
    // The runner resume-skips a closed ticket, and so does the approve gate — a delivered ticket's
    // missing spec must not withhold the run the board is advertising.
    const card = makeBead({
      id: "feat-delivered",
      title: "Shaped target, delivered ticket",
      issue_type: "feature",
      created_at: "2026-07-20T00:00:00.000Z",
      description: `${SHAPED}\n\n## Acceptance\n- [ ] it works`,
    });
    const done = makeBead({
      id: "task-done",
      title: "Already delivered",
      parent: "feat-delivered",
      status: "closed",
      created_at: "2026-07-20T00:00:00.000Z",
      description: SHAPED,
    });

    listMock.mockResolvedValue([card, done]);

    const board = await getBoard(project);

    const built = board.columns.backlog.find((e) => e.id === "feat-delivered")!;
    expect(contractBlocks(built.contract)).toBe(false);
  });

  it("leaves a conformant target unmarked and a never-judged one unjudged", async () => {
    const conformant = makeBead({
      id: "feat-clean",
      title: "Shaped",
      issue_type: "feature",
      created_at: "2026-07-20T00:00:00.000Z",
      description: `${SHAPED}\n\n## Acceptance\n- [ ] it works`,
    });
    // No description, no acceptance, no bd stamps: nothing was read, so nothing may be faulted —
    // an absent status means "not judged", which contractBlocks must not read as a violation.
    const unread = makeBead({ id: "task-bare", title: "Bare projection", issue_type: "task" });

    listMock.mockResolvedValue([conformant, unread]);

    const board = await getBoard(project);

    const card = board.columns.backlog.find((e) => e.id === "feat-clean")!;
    expect(card.contract).toEqual({ blocking: [], advisory: [] });
    expect(contractBlocks(card.contract)).toBe(false);

    const item = board.standalone.backlog.find((i) => i.id === "task-bare")!;
    expect(item.contract).toBeUndefined();
    expect(contractBlocks(item.contract)).toBe(false);
  });
});

/**
 * Pipeline plumbing on the board (anton-ve2r). The fixture mirrors the shape `bd mol pour` really
 * produces — a `molecule` root, typed `task` step children, and one `gate` child per gated step —
 * plus the ad-hoc gate `bd gate create --blocks <bead>` hangs off a bead. That shape is pinned
 * against real bd in src/lib/gate-molecule.integration.test.ts, so this fixture can't quietly drift
 * from what bd pours.
 *
 * Gates are IN this list on purpose: `loadAllIssues` reads them (`--type gate` is bd's only listing
 * that carries them) because their status is what tells a `blocks` edge from a resolved gate apart
 * from an open one. Reaching the list is exactly why they must never reach a card.
 */
describe("getBoard excludes pipeline plumbing (gate + molecule)", () => {
  const pouredBoard = (gateStatus: "open" | "closed") => [
    makeBead({ id: "feat-1", title: "Ship the exporter", issue_type: "feature" }),
    makeBead({
      id: "task-1",
      title: "Write the exporter",
      parent: "feat-1",
      dependencies: [{ issue_id: "task-1", depends_on_id: "gate-adhoc", type: "blocks" }],
    }),
    makeBead({ id: "gate-adhoc", title: "Gate: human", issue_type: "gate", parent: "task-1", status: gateStatus }),
    makeBead({ id: "mol-1", title: "release", issue_type: "molecule", parent: "feat-1" }),
    makeBead({ id: "step-1", title: "build", parent: "mol-1" }),
    makeBead({
      id: "step-2",
      title: "review",
      parent: "mol-1",
      dependencies: [{ issue_id: "step-2", depends_on_id: "gate-poured", type: "blocks" }],
    }),
    makeBead({ id: "gate-poured", title: "Gate: human", issue_type: "gate", parent: "mol-1" }),
  ];

  const card = async () => {
    const board = await getBoard(project);
    return board.columns.backlog.find((e) => e.id === "feat-1")!;
  };

  it("renders no gate or molecule as a card, a ticket, or a chip", async () => {
    listMock.mockResolvedValue(pouredBoard("open"));

    const board = await getBoard(project);
    const rendered = STAGES.flatMap((s) => [
      ...board.columns[s].map((e) => e.id),
      ...board.columns[s].flatMap((e) => e.tickets.map((t) => t.id)),
      ...board.standalone[s].map((i) => i.id),
    ]);

    expect(rendered).toContain("feat-1");
    expect(rendered).not.toContain("gate-adhoc");
    expect(rendered).not.toContain("gate-poured");
    expect(rendered).not.toContain("mol-1");
  });

  it("counts only real tickets — the poured steps ride on their molecule, not on the feature", async () => {
    // `bd mol current` counts a molecule's gates and steps as its own progress; anton must not
    // inherit them onto the run target the molecule happens to hang under, whose run would dispatch
    // them in one worktree with their gates ignored.
    listMock.mockResolvedValue(pouredBoard("open"));

    expect((await card()).tickets.map((t) => t.id)).toEqual(["task-1"]);
  });

  it("keeps a run target blocked while its gate is open", async () => {
    listMock.mockResolvedValue(pouredBoard("open"));

    const built = await card();
    expect(built.blockedBy).toEqual(["gate-adhoc"]);
    expect(built.ready).toBe(false);
    // The per-child verdict agrees: the gate holds the run's only ticket.
    expect(built.childReadiness).toBe("blocked");
    expect(built.blockedChildren).toEqual(["task-1"]);
  });

  it("releases it the moment the gate resolves — a gate is a wait, not a permanent blocker", async () => {
    // The regression: a gate absent from the bead list hits the blocker helpers' missing-bead
    // fail-safe and reads as open FOREVER, so `bd gate resolve` never returns the target to ready
    // and its approve route 409s permanently.
    listMock.mockResolvedValue(pouredBoard("closed"));

    const built = await card();
    expect(built.blockedBy).toEqual([]);
    expect(built.ready).toBe(true);
    // Same fail-safe, same permanence, one derivation over: the per-child readiness must be built
    // over the gate-carrying list too, or the card dims and approve 409s with an EMPTY blocker list
    // — a refusal with nothing on screen to explain it.
    expect(built.childReadiness).toBe("ready");
    expect(built.readyChildren).toEqual(["task-1"]);
    expect(built.blockedChildren).toEqual([]);
  });

  it("never reports a target held by its OWN gh:pr merge gate — that is waiting on itself", async () => {
    // anton arms this gate on every run target when it opens the target's PR, and bd leaves it open
    // forever when that PR is closed unmerged. `isOwnMergeWait` can only recognise it from the gate
    // BEAD, so without gates in the read every in-review card reads blocked and the Force/recovery
    // run the unmerged PR needs is refused permanently.
    listMock.mockResolvedValue([
      makeBead({
        id: "feat-1",
        title: "Ship the exporter",
        issue_type: "feature",
        labels: ["stage:in-review"],
        dependencies: [{ issue_id: "feat-1", depends_on_id: "gate-pr", type: "blocks" }],
      }),
      makeBead({ id: "task-1", title: "Write the exporter", parent: "feat-1" }),
      // `await_type` rides on the Gate shape bd's `--type gate` listing carries, not on Bead.
      { ...makeBead({ id: "gate-pr", title: "Gate: gh:pr", issue_type: "gate" }), await_type: "gh:pr" },
    ]);

    const board = await getBoard(project);
    const built = board.columns["in-review"].find((e) => e.id === "feat-1")!;
    expect(built.blockedBy).toEqual([]);
    expect(built.childReadiness).toBe("ready");
    expect(built.readyChildren).toEqual(["task-1"]);
  });

  it("pays a second `--type gate` read only when an edge points at a bead the listing omits", async () => {
    // bd's real asymmetry: the ordinary listing carries the gate's `blocks` edge but not the gate.
    // Resolving it costs a read on the operator's critical path, so it is spent only on a board
    // that actually holds a dangling edge — a board without one keeps the single read anton-hwkx
    // trimmed approve down to.
    const ordinary = pouredBoard("closed").filter((b) => b.issue_type !== "gate");
    const gates = pouredBoard("closed").filter((b) => b.issue_type === "gate");
    listMock.mockImplementation(async (_cwd: string, extra: string[] = []) =>
      extra.includes("gate") ? gates : ordinary,
    );

    expect((await card()).ready, "the resolved gate is found by the second read").toBe(true);
    expect(listMock.mock.calls.some((c) => (c[1] as string[]).includes("gate"))).toBe(true);

    // Same board with the gate edge gone: nothing dangles, so nothing beyond the one read is spent.
    resetIssueSnapshots();
    listMock.mockClear();
    listMock.mockImplementation(async () => ordinary.map((b) => ({ ...b, dependencies: [] })));

    await getBoard(project);
    expect(listMock).toHaveBeenCalledTimes(1);
  });
});

describe("hygiene report on the board (anton-uwal)", () => {
  function report(id: string, overrides: Partial<HygieneReport> = {}): HygieneReport {
    return {
      id,
      projectId: project.id,
      generatedAt: 1_700_000_000,
      actions: { closedEpics: [], rowsRecomputed: 0 },
      findings: [],
      counts: {
        lint: 0,
        "stale-open": 0,
        "stale-in-progress": 0,
        orphan: 0,
        "dep-cycle": 0,
        duplicate: 0,
      },
      ...overrides,
    };
  }

  beforeEach(() => {
    listMock.mockResolvedValue([makeBead({ id: "t-1", title: "Loose task" })]);
  });

  it("carries the latest patrol report in the board payload", async () => {
    hygieneReport = report("r-1", {
      actions: { closedEpics: ["epic-9"], rowsRecomputed: 2 },
      findings: [{ kind: "orphan", key: "orphan:t-1", beadId: "t-1", detail: "shipped, still open" }],
    });

    const board = await getBoard(project);
    expect(board.hygiene?.id).toBe("r-1");
    expect(board.hygiene?.actions.closedEpics).toEqual(["epic-9"]);
    expect(board.hygiene?.findings[0]?.beadId).toBe("t-1");
  });

  it("leaves hygiene absent for a project that has never been patrolled", async () => {
    // Distinct from an empty report, which is the claim "patrolled, board is clean".
    expect((await getBoard(project)).hygiene).toBeUndefined();
  });

  it("changes the refresh token when a new report lands", async () => {
    // The poll 304s on an unchanged token, so a patrol that didn't move the token would stay
    // invisible on the board until something else (a bead write, a sync pass) happened to change it.
    const unpatrolled = (await getBoard(project)).version;

    resetIssueSnapshots();
    hygieneReport = report("r-1");
    const first = (await getBoard(project)).version;
    expect(first).not.toBe(unpatrolled);

    resetIssueSnapshots();
    hygieneReport = report("r-2", { generatedAt: 1_700_000_600 });
    const second = (await getBoard(project)).version;
    expect(second).not.toBe(first);
  });

  it("keeps the token stable while the same report is the latest one", async () => {
    hygieneReport = report("r-1");
    const first = (await getBoard(project)).version;
    resetIssueSnapshots();
    expect((await getBoard(project)).version).toBe(first);
  });

  it("agrees with the version the poll path compares against", async () => {
    // getBoardVersion is what the 304 check reads; a shape that disagreed with the board's own
    // stamp would make every poll a full download.
    hygieneReport = report("r-1");
    const board = await getBoard(project);
    expect(await getBoardVersion(project)).toBe(board.version);
  });
});

describe("review scores on the board (anton-tprv)", () => {
  it("carries each run target's latest score — cards and standalone chips alike", async () => {
    listMock.mockResolvedValue([
      makeBead({
        id: "feat-1",
        title: "Scored feature",
        issue_type: "feature",
        labels: ["review-score:9"],
        updated_at: "2026-08-02T00:00:00Z",
      }),
      makeBead({ id: "t-1", title: "Its ticket", parent: "feat-1" }),
      makeBead({
        id: "task-1",
        title: "Scored standalone",
        labels: ["review-score:4"],
        updated_at: "2026-08-01T00:00:00Z",
      }),
    ]);

    const board = await getBoard(project);

    expect(board.columns.backlog.find((e) => e.id === "feat-1")?.reviewScore).toBe(9);
    expect(board.standalone.backlog.find((i) => i.id === "task-1")?.reviewScore).toBe(4);
    // Read off labels the snapshot already carries — one bd list for the whole board, no per-card read.
    expect(listMock).toHaveBeenCalledTimes(1);
  });

  it("leaves an unreviewed target with no score at all, never a zero", async () => {
    listMock.mockResolvedValue([
      makeBead({ id: "feat-1", title: "Never reviewed", issue_type: "feature" }),
      makeBead({ id: "task-1", title: "Never reviewed either" }),
      // A malformed label is not a score either — it must not read as 0/10 on a card.
      makeBead({ id: "task-2", title: "Garbled", labels: ["review-score:oops"] }),
    ]);

    const board = await getBoard(project);

    expect(board.columns.backlog[0].reviewScore).toBeUndefined();
    expect(board.standalone.backlog.map((i) => i.reviewScore)).toEqual([undefined, undefined]);
    expect(board.reviewTrajectory).toBeUndefined();
  });

  it("rolls the scores up into the project's trajectory, worst target named", async () => {
    listMock.mockResolvedValue([
      makeBead({
        id: "feat-1",
        title: "Shipped well",
        issue_type: "feature",
        labels: ["review-score:9"],
        updated_at: "2026-08-03T00:00:00Z",
      }),
      makeBead({
        id: "feat-2",
        title: "Shipped badly",
        issue_type: "feature",
        labels: ["review-score:3"],
        updated_at: "2026-08-02T00:00:00Z",
      }),
      makeBead({
        id: "task-1",
        title: "Standalone run",
        labels: ["review-score:6"],
        updated_at: "2026-08-01T00:00:00Z",
      }),
    ]);

    const trajectory = (await getBoard(project)).reviewTrajectory;

    expect(trajectory?.recent.map((t) => t.id)).toEqual(["feat-1", "feat-2", "task-1"]);
    expect(trajectory?.average).toBe(6);
    expect(trajectory?.worst).toMatchObject({ id: "feat-2", score: 3, title: "Shipped badly" });
    expect(trajectory?.scored).toBe(3);
  });

  it("does not count a ticket's score — only run targets have runs to score", async () => {
    // A ticket can carry a stale label from a run in which it was the target; it rides on a card
    // now, so counting it would double-count that card's own run.
    listMock.mockResolvedValue([
      makeBead({ id: "feat-1", title: "Target", issue_type: "feature", labels: ["review-score:8"] }),
      makeBead({ id: "t-1", title: "Ticket", parent: "feat-1", labels: ["review-score:1"] }),
    ]);

    const trajectory = (await getBoard(project)).reviewTrajectory;

    expect(trajectory?.scored).toBe(1);
    expect(trajectory?.worst.id).toBe("feat-1");
  });
});

/**
 * A vetoed target reads as SET ASIDE on the board rather than silently gone (anton-jqvy). The hold
 * is machine-local anton.db state, so it also has to move the freshness token — including when it
 * expires, which is not a write anything else would notice.
 */
describe("picker vetoes on the board (anton-jqvy)", () => {
  const UNTIL = 1_800_086_400_000;

  it("marks a deferred card and a deferred chip, leaving both on the board", async () => {
    listMock.mockResolvedValue([
      makeBead({ id: "f-1", title: "A feature", issue_type: "feature" }),
      makeBead({ id: "t-1", title: "A loose task" }),
    ]);
    deferrals = new Map([
      ["f-1", UNTIL],
      ["t-1", UNTIL],
    ]);

    const board = await getBoard(project);
    expect(board.columns.backlog.find((e) => e.id === "f-1")?.notNowUntil).toBe(UNTIL);
    expect(board.standalone.backlog.find((i) => i.id === "t-1")?.notNowUntil).toBe(UNTIL);
  });

  it("leaves a target anton was never vetoed on unmarked", async () => {
    listMock.mockResolvedValue([makeBead({ id: "t-1", title: "A loose task" })]);
    expect((await getBoard(project)).standalone.backlog[0]?.notNowUntil).toBeUndefined();
  });

  it("moves the refresh token when a veto lands AND when its window closes", async () => {
    listMock.mockResolvedValue([makeBead({ id: "t-1", title: "A loose task" })]);
    const clean = (await getBoard(project)).version;

    resetIssueSnapshots();
    deferrals = new Map([["t-1", UNTIL]]);
    const held = (await getBoard(project)).version;
    expect(held).not.toBe(clean);

    // An expiry is not a write: the active set shrinks on its own, and the token has to follow it
    // or the card stays drawn as deferred until something unrelated moves.
    resetIssueSnapshots();
    deferrals = new Map();
    expect((await getBoard(project)).version).toBe(clean);
  });

  it("agrees with the version the poll path compares against", async () => {
    listMock.mockResolvedValue([makeBead({ id: "t-1", title: "A loose task" })]);
    deferrals = new Map([["t-1", UNTIL]]);
    const board = await getBoard(project);
    expect(await getBoardVersion(project)).toBe(board.version);
  });
});

/**
 * Provenance badges (anton-cqxd / R3.7) are joined onto the cards the board serves, so every surface
 * that renders a card renders them — the lane is one reader of this data, never its owner.
 */
describe("provenance on the board (anton-cqxd)", () => {
  /** Stamped over the board it ranks — an unstale plan, as a pass that just ran would have left. */
  const planFor = (board: Bead[], beadId: string): import("./board-picker-plan").BoardPickerPlan => ({
    projectId: "p1",
    generatedAt: 1_770_000_000,
    stamp: stampBoard(board, 1_770_000_000_000),
    entries: [{ beadId, rank: 1, rule: "any claimable run target" }],
    exclusions: [],
  });

  it("marks the picker's pick on a card and on a chip alike", async () => {
    const board = [
      makeBead({ id: "f-1", title: "A feature", issue_type: "feature" }),
      makeBead({ id: "t-1", title: "A loose task" }),
    ];
    listMock.mockResolvedValue(board);
    pickerPlan = {
      ...planFor(board, "f-1"),
      entries: [
        { beadId: "f-1", rank: 1, rule: "any claimable run target" },
        { beadId: "t-1", rank: 2, rule: "any claimable run target" },
      ],
    };

    const served = await getBoard(project);
    expect(served.columns.backlog.find((e) => e.id === "f-1")?.provenance).toEqual([
      { kind: "policy", detail: "any claimable run target" },
    ]);
    expect(served.standalone.backlog.find((i) => i.id === "t-1")?.provenance).toEqual([
      { kind: "policy", detail: "any claimable run target" },
    ]);
  });

  it("stops badging picks once the pass that would refresh them is switched off", async () => {
    const board = [makeBead({ id: "t-1", title: "A loose task" })];
    listMock.mockResolvedValue(board);
    pickerPlan = planFor(board, "t-1");
    pickerArmed = false;

    // The badge is what `[Release]` is derived from (isPickerPick), so a plan left behind by a
    // disabled schedule would keep offering to record accepts against a pass that no longer runs.
    expect((await getBoard(project)).standalone.backlog[0]?.provenance).toBeUndefined();
  });

  it("never badges a done target — provenance is about whether to run it", async () => {
    const board = [
      makeBead({ id: "f-1", title: "A shipped feature", issue_type: "feature", status: "closed" }),
    ];
    listMock.mockResolvedValue(board);
    pickerPlan = planFor(board, "f-1");

    expect((await getBoard(project)).columns.done[0]?.provenance).toBeUndefined();
  });

  it("leaves a target no unattended writer touched unmarked", async () => {
    listMock.mockResolvedValue([makeBead({ id: "t-1", title: "A loose task" })]);
    expect((await getBoard(project)).standalone.backlog[0]?.provenance).toBeUndefined();
  });

  it("moves the refresh token when the picker records a new plan", async () => {
    const board = [makeBead({ id: "t-1", title: "A loose task" })];
    listMock.mockResolvedValue(board);
    const clean = (await getBoard(project)).version;

    resetIssueSnapshots();
    pickerPlan = planFor(board, "t-1");
    const picked = (await getBoard(project)).version;
    expect(picked).not.toBe(clean);

    // The poll path compares against the same token, or the badge never reaches the tab.
    expect(await getBoardVersion(project)).toBe(picked);
  });

  it("holds the refresh token still while the pass is switched off", async () => {
    const board = [makeBead({ id: "t-1", title: "A loose task" })];
    listMock.mockResolvedValue(board);
    pickerArmed = false;
    const quiet = await getBoardVersion(project);

    // A disarmed board carries no provenance at all, so a plan row written before the pass was
    // switched off cannot change what is served. A token that still moved on it would break the
    // poll's 304 and spend a full board read to hand back byte-identical data.
    resetIssueSnapshots();
    pickerPlan = planFor(board, "t-1");
    expect(await getBoardVersion(project)).toBe(quiet);
    // And the two halves still agree: the poll's token is the one the served board carries.
    const served = await getBoard(project);
    expect(await getBoardVersion(project)).toBe(served.version);
  });
});

/**
 * The Up Next lane's server half (anton-t9m4 / R3.1–R3.4). The lane claims this is the order anton
 * would start work in NOW — a stricter promise than the badge beside it, which only records the rule
 * a target WAS picked under. So it is withheld whole on every fact that makes the recorded ranking
 * no longer that: a disarmed pass, a board the plan predates, and — per pick — a veto since.
 */
describe("the Up Next lane on the board (anton-t9m4)", () => {
  const feature = () => makeBead({ id: "f-1", title: "A feature", issue_type: "feature" });

  /** A plan recorded against exactly this board — what a pass that just ran would have written. */
  function planOver(board: Bead[], beadId: string): import("./board-picker-plan").BoardPickerPlan {
    return {
      projectId: "p1",
      generatedAt: 1_770_000_000,
      stamp: stampBoard(board, 1_770_000_000_000),
      entries: [{ beadId, rank: 1, rule: "any claimable run target" }],
      exclusions: [],
    };
  }

  it("projects the lane from a plan the board still matches", async () => {
    const board = [feature()];
    listMock.mockResolvedValue(board);
    pickerPlan = planOver(board, "f-1");

    expect((await getBoard(project)).upNext).toEqual([
      { beadId: "f-1", rank: 1, type: "feature", unblocks: 0, createdAt: "" },
    ]);
  });

  it("withholds the lane when the board has moved past the plan", async () => {
    const board = [feature()];
    listMock.mockResolvedValue(board);
    // The pass ranked a board this one no longer is — a target claimed, blocked or reprioritized
    // since. Showing the old order would answer "what is next?" with a board that has gone.
    pickerPlan = {
      ...planOver(board, "f-1"),
      stamp: { observedAtMs: 1_770_000_000_000, digest: "stale", beadCount: 1 },
    };

    expect((await getBoard(project)).upNext).toBeUndefined();
  });

  it("withholds the lane while the picker is disarmed", async () => {
    const board = [feature()];
    listMock.mockResolvedValue(board);
    pickerPlan = planOver(board, "f-1");
    pickerArmed = false;

    expect((await getBoard(project)).upNext).toBeUndefined();
  });

  it("drops a pick the operator vetoed since the pass ran", async () => {
    const board = [feature()];
    listMock.mockResolvedValue(board);
    pickerPlan = planOver(board, "f-1");
    deferrals = new Map([["f-1", 1_770_000_100_000]]);

    // Out of the lane, but still on the board: a set-aside target returns to Backlog, it does not
    // vanish. And the lane is ABSENT rather than empty (Board.upNext) — an "Up Next" heading over
    // nothing would read as "anton has nothing to start".
    const served = await getBoard(project);
    expect(served.upNext).toBeUndefined();
    expect("upNext" in served).toBe(false);
    expect(served.columns.backlog.map((e) => e.id)).toEqual(["f-1"]);
  });

  it("withholds the lane once a hold the pass acted on runs out", async () => {
    const board = [feature(), makeBead({ id: "f-2", title: "Set aside", issue_type: "feature" })];
    listMock.mockResolvedValue(board);
    // A pass that ran while `f-2` was vetoed: the target is in the plan only as an exclusion, and no
    // hashed input changes when its window closes. Without the deferral half of the fence the lane
    // would keep presenting a ranking that cannot offer `f-2` until the next pass rewrote it.
    pickerPlan = {
      ...planOver(board, "f-1"),
      exclusions: [{ beadId: "f-2", reason: "deferred", detail: "you set this aside" }],
    };
    deferrals = new Map([["f-2", 1_770_000_100_000]]);
    expect((await getBoard(project)).upNext).toHaveLength(1);

    resetIssueSnapshots();
    deferrals = new Map();
    expect((await getBoard(project)).upNext).toBeUndefined();
  });

  it("withholds the lane when the operator narrows the policy without touching a bead", async () => {
    const board = [feature()];
    listMock.mockResolvedValue(board);
    // Recorded by a pass that ran under NO policy — the fence covers both halves of that decision.
    pickerPlan = planOver(board, "f-1");
    expect((await getBoard(project)).upNext).toHaveLength(1);

    resetIssueSnapshots();
    // A settings save admits or excludes targets while every bead digest stays byte-identical. The
    // plan now ranks under a rule the operator has replaced, so it is not what anton would start.
    projectSettings = { pickerPolicy: { types: ["bug"] } };
    expect((await getBoard(project)).upNext).toBeUndefined();
  });

  it("moves the refresh token on a policy save, so the poll cannot 304 past the withdrawal", async () => {
    const board = [feature()];
    listMock.mockResolvedValue(board);
    pickerPlan = planOver(board, "f-1");
    const armed = await getBoardVersion(project);

    projectSettings = { pickerPolicy: { types: ["bug"] } };
    expect(await getBoardVersion(project)).not.toBe(armed);
  });
});

/**
 * `[Release]` is derived from the `◈ policy` badge (isPickerPick), and the badge outlives the plan it
 * came from — it records the rule a target WAS picked under. The button claims something stronger:
 * that this is what anton would start NOW. So the mark carries the freshness verdict the lane is
 * withheld on, and the two can never disagree.
 */
describe("a pick the board has moved past (anton-t9m4)", () => {
  const feature = () => makeBead({ id: "f-1", title: "A feature", issue_type: "feature" });

  it("keeps the badge but flags it stale once the board no longer matches the plan", async () => {
    const board = [feature()];
    listMock.mockResolvedValue(board);
    pickerPlan = {
      projectId: "p1",
      generatedAt: 1_770_000_000,
      stamp: { observedAtMs: 1_770_000_000_000, digest: "stale", beadCount: 1 },
      entries: [{ beadId: "f-1", rank: 1, rule: "any claimable run target" }],
      exclusions: [],
    };

    const served = await getBoard(project);
    expect(served.upNext).toBeUndefined();
    expect(served.columns.backlog[0]?.provenance).toEqual([
      { kind: "policy", detail: "any claimable run target", stale: true },
    ]);
  });

  it("leaves the mark unflagged while the plan still describes the board", async () => {
    const board = [feature()];
    listMock.mockResolvedValue(board);
    pickerPlan = {
      projectId: "p1",
      generatedAt: 1_770_000_000,
      stamp: stampBoard(board, 1_770_000_000_000),
      entries: [{ beadId: "f-1", rank: 1, rule: "any claimable run target" }],
      exclusions: [],
    };

    expect((await getBoard(project)).columns.backlog[0]?.provenance).toEqual([
      { kind: "policy", detail: "any claimable run target" },
    ]);
  });
});
