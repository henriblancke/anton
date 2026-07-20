import { describe, expect, it } from "vitest";
import { applyFilters } from "./tickets";
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

  it("combines multiple filters (AND semantics)", () => {
    expect(applyFilters(rows, { domain: "eng", risk: "high" }).map((r) => r.id)).toEqual(["t-2"]);
  });

  it("returns an empty array when nothing matches", () => {
    expect(applyFilters(rows, { agent: "does-not-exist" })).toEqual([]);
  });
});
