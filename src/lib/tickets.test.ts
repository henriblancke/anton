import { describe, expect, it } from "vitest";
import { applyFilters, buildTicketRows, isUnassigned } from "./tickets";
import type { Bead } from "./beads/bd";
import type { TicketRow } from "./types";

function makeRow(overrides: Partial<TicketRow> & { id: string; title: string }): TicketRow {
  return {
    status: "open",
    stage: "backlog",
    type: "task",
    assignee: null,
    createdAt: "",
    createdBy: null,
    deferred: false,
    abandoned: false,
    ...overrides,
  };
}

describe("applyFilters", () => {
  const rows: TicketRow[] = [
    makeRow({
      id: "t-1",
      title: "Add export button",
      agent: "nextjs",
      risk: "low",
      size: "S",
      domain: "eng",
      status: "open",
      type: "task",
      epicId: "epic-1",
      epicTitle: "CSV export",
    }),
    makeRow({
      id: "t-2",
      title: "Fix flaky CI",
      agent: "fastapi",
      risk: "high",
      size: "M",
      domain: "eng",
      status: "in_progress",
      type: "bug",
      epicId: "epic-2",
      epicTitle: "Stability",
    }),
    makeRow({
      id: "t-3",
      title: "Research pricing",
      status: "closed",
      type: "task",
      domain: "research",
    }),
  ];

  it("returns all rows when no filters are given", () => {
    expect(applyFilters(rows, {})).toHaveLength(3);
  });

  it("filters by exact agent match", () => {
    expect(applyFilters(rows, { agent: "nextjs" }).map((r) => r.id)).toEqual(["t-1"]);
  });

  it("filters by exact risk match", () => {
    expect(applyFilters(rows, { risk: "high" }).map((r) => r.id)).toEqual(["t-2"]);
  });

  it("filters by exact size match", () => {
    expect(applyFilters(rows, { size: "S" }).map((r) => r.id)).toEqual(["t-1"]);
  });

  it("filters by exact domain match", () => {
    expect(applyFilters(rows, { domain: "research" }).map((r) => r.id)).toEqual(["t-3"]);
  });

  it("filters by exact status match", () => {
    expect(applyFilters(rows, { status: "closed" }).map((r) => r.id)).toEqual(["t-3"]);
  });

  it("filters by exact type match", () => {
    expect(applyFilters(rows, { type: "bug" }).map((r) => r.id)).toEqual(["t-2"]);
  });

  it("filters by exact epic match", () => {
    expect(applyFilters(rows, { epic: "epic-1" }).map((r) => r.id)).toEqual(["t-1"]);
  });

  it("excludes rows without the epic when filtering by epic", () => {
    expect(applyFilters(rows, { epic: "epic-1" }).map((r) => r.id)).not.toContain("t-3");
  });

  it("filters by case-insensitive title substring", () => {
    expect(applyFilters(rows, { q: "export" }).map((r) => r.id)).toEqual(["t-1"]);
    expect(applyFilters(rows, { q: "EXPORT" }).map((r) => r.id)).toEqual(["t-1"]);
  });

  it("keeps abandoned rows by default, and hides or isolates them on the outcome filter", () => {
    const withDropped = [...rows, makeRow({ id: "t-4", title: "Dropped idea", abandoned: true })];
    expect(applyFilters(withDropped, {}).map((r) => r.id)).toContain("t-4");
    expect(applyFilters(withDropped, { outcome: "active" }).map((r) => r.id)).not.toContain("t-4");
    expect(applyFilters(withDropped, { outcome: "abandoned" }).map((r) => r.id)).toEqual(["t-4"]);
  });

  it("combines multiple filters (AND semantics)", () => {
    expect(applyFilters(rows, { domain: "eng", risk: "high" }).map((r) => r.id)).toEqual(["t-2"]);
  });

  it("returns an empty array when nothing matches", () => {
    expect(applyFilters(rows, { agent: "does-not-exist" })).toEqual([]);
  });
});

describe("buildTicketRows (three-tier grouping)", () => {
  function bead(id: string, over: Partial<Bead> = {}): Bead {
    return { id, title: id, status: "open", issue_type: "task", ...over } as Bead;
  }

  const epic = bead("e-1", { title: "Ontology editing", issue_type: "epic" });
  const feature = bead("f-1", { title: "Inline editor", issue_type: "feature", parent: "e-1" });
  const task = bead("t-1", { title: "Wire the form", parent: "f-1" });
  const bug = bead("b-1", { title: "Fix the save race", issue_type: "bug", parent: "f-1" });

  it("keeps a feature's own tickets under the epic, grouped and filterable", () => {
    const rows = buildTicketRows([epic, feature, task, bug]);
    expect(rows.map((r) => r.id)).toEqual(["e-1", "f-1", "t-1", "b-1"]);
    // The nearest epic ancestor, resolved THROUGH the feature — not the immediate parent.
    expect(rows.map((r) => r.epicId)).toEqual([undefined, "e-1", "e-1", "e-1"]);
    expect(rows.find((r) => r.id === "t-1")?.epicTitle).toBe("Ontology editing");
    expect(applyFilters(rows, { epic: "e-1" }).map((r) => r.id)).toEqual(["f-1", "t-1", "b-1"]);
  });

  it("still groups a legacy epic's direct children and trails beads with no epic ancestor", () => {
    const direct = bead("t-2", { parent: "e-1" });
    const loose = bead("t-3");
    const rows = buildTicketRows([epic, direct, loose]);
    expect(rows.map((r) => r.id)).toEqual(["e-1", "t-2", "t-3"]);
    expect(rows.map((r) => r.epicId)).toEqual([undefined, "e-1", undefined]);
  });

  it("emits every bead exactly once when a parent chain cycles", () => {
    const a = bead("c-1", { parent: "c-2" });
    const b = bead("c-2", { parent: "c-1" });
    const rows = buildTicketRows([epic, feature, a, b]);
    expect(rows.map((r) => r.id).sort()).toEqual(["c-1", "c-2", "e-1", "f-1"]);
  });

  it("carries the nearest FEATURE ancestor, resolved through arbitrary depth", () => {
    const subtask = bead("s-1", { title: "Nested step", parent: "t-1" });
    const rows = buildTicketRows([epic, feature, task, subtask]);
    const byId = new Map(rows.map((r) => [r.id, r]));
    expect(byId.get("f-1")?.featureId).toBeUndefined(); // a feature is not its own feature
    expect(byId.get("t-1")?.featureId).toBe("f-1");
    expect(byId.get("t-1")?.featureTitle).toBe("Inline editor");
    // Two hops up: the subtask ships in the same worktree and PR as the task above it.
    expect(byId.get("s-1")?.featureId).toBe("f-1");
  });

  it("finds the feature above a ticket even when NO epic holds that feature", () => {
    // The row-ordering descent starts at epics, so a parentless feature's subtree never enters it.
    const loose = bead("f-2", { title: "Orphan feature", issue_type: "feature" });
    const child = bead("t-9", { parent: "f-2" });
    const rows = buildTicketRows([loose, child]);
    const byId = new Map(rows.map((r) => [r.id, r]));
    expect(byId.get("t-9")?.featureId).toBe("f-2");
    expect(byId.get("t-9")?.epicId).toBeUndefined();
  });
});

describe("isUnassigned", () => {
  it("never treats an epic as unassigned — it is the top tier", () => {
    expect(isUnassigned(makeRow({ id: "e-1", title: "Outcome", type: "epic" }))).toBe(false);
  });

  it("treats a feature with no epic above it as unassigned", () => {
    expect(isUnassigned(makeRow({ id: "f-1", title: "F", type: "feature" }))).toBe(true);
    expect(
      isUnassigned(makeRow({ id: "f-2", title: "F", type: "feature", epicId: "e-1" })),
    ).toBe(false);
  });

  it("treats a working-layer bead with no feature above it as unassigned", () => {
    expect(isUnassigned(makeRow({ id: "t-1", title: "T" }))).toBe(true);
    expect(isUnassigned(makeRow({ id: "t-2", title: "T", featureId: "f-1" }))).toBe(false);
  });

  it("flags a ticket parented straight to a container epic — it rides no card and ships in no PR", () => {
    // Has an epic but no feature: the exact shape the tier model calls a dead bead.
    expect(isUnassigned(makeRow({ id: "t-3", title: "T", epicId: "e-1" }))).toBe(true);
  });
});

describe("applyFilters: assigned", () => {
  const rows = [
    makeRow({ id: "e-1", title: "Outcome", type: "epic" }),
    makeRow({ id: "f-1", title: "Held feature", type: "feature", epicId: "e-1" }),
    makeRow({ id: "f-2", title: "Loose feature", type: "feature" }),
    makeRow({ id: "t-1", title: "Held task", featureId: "f-1", epicId: "e-1" }),
    makeRow({ id: "t-2", title: "Loose task" }),
    makeRow({ id: "t-3", title: "Task under a container epic", epicId: "e-1" }),
  ];

  it("shows only work no epic or feature holds", () => {
    expect(applyFilters(rows, { assigned: "unassigned" }).map((r) => r.id)).toEqual([
      "f-2",
      "t-2",
      "t-3",
    ]);
  });

  it("shows only work that is held, epics included", () => {
    expect(applyFilters(rows, { assigned: "assigned" }).map((r) => r.id)).toEqual([
      "e-1",
      "f-1",
      "t-1",
    ]);
  });

  it("shows everything when unset, and composes with the other filters", () => {
    expect(applyFilters(rows, {})).toHaveLength(6);
    expect(
      applyFilters(rows, { assigned: "unassigned", type: "feature" }).map((r) => r.id),
    ).toEqual(["f-2"]);
  });
});
