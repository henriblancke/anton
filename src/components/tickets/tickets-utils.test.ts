import { describe, expect, it } from "vitest";

import type { TicketFilters, TicketRow } from "@/lib/types";
import {
  TICKET_FILTER_FIELDS,
  TICKET_FILTER_KEYS,
  filtersFromSearchParams,
  hasActiveFilters,
  searchParamsFromFilters,
  sortTicketsByCreated,
  ticketsQueryString,
  uniqueEpicOptions,
  uniqueFieldOptions,
} from "@/components/tickets/tickets-utils";

const base: TicketRow = {
  id: "bd-1",
  title: "Do the thing",
  status: "open",
  stage: "backlog",
  type: "task",
  assignee: null,
  createdAt: "",
  createdBy: null,
  deferred: false,
  abandoned: false,
};

describe("filtersFromSearchParams", () => {
  it("reads known filter keys and drops empty/blank values", () => {
    const params = new URLSearchParams({
      agent: "nextjs",
      risk: "  ",
      q: "  billing  ",
      unknown: "ignored",
    });
    expect(filtersFromSearchParams(params)).toEqual({ agent: "nextjs", q: "billing" });
  });

  it("returns an empty object when nothing is set", () => {
    expect(filtersFromSearchParams(new URLSearchParams())).toEqual({});
  });
});

describe("searchParamsFromFilters", () => {
  it("only serializes truthy, trimmed filter values", () => {
    const filters: TicketFilters = { agent: "nextjs", risk: "", q: "  auth  " };
    const params = searchParamsFromFilters(filters);
    expect(params.get("agent")).toBe("nextjs");
    expect(params.has("risk")).toBe(false);
    expect(params.get("q")).toBe("auth");
  });
});

describe("ticketsQueryString", () => {
  it("round-trips through filtersFromSearchParams", () => {
    const filters: TicketFilters = { agent: "nextjs", epic: "bd-epic-1" };
    const qs = ticketsQueryString(filters);
    expect(qs.startsWith("?")).toBe(true);
    const parsed = filtersFromSearchParams(new URLSearchParams(qs.slice(1)));
    expect(parsed).toEqual(filters);
  });

  it("is empty for no filters", () => {
    expect(ticketsQueryString({})).toBe("");
  });
});

describe("hasActiveFilters", () => {
  it("is false for empty/blank filters and true once one is set", () => {
    expect(hasActiveFilters({})).toBe(false);
    expect(hasActiveFilters({ q: "   " })).toBe(false);
    expect(hasActiveFilters({ risk: "high" })).toBe(true);
  });
});

describe("uniqueFieldOptions", () => {
  it("returns sorted, deduped, defined values for a field", () => {
    const rows: TicketRow[] = [
      { ...base, id: "bd-1", agent: "nextjs" },
      { ...base, id: "bd-2", agent: "fastapi" },
      { ...base, id: "bd-3", agent: "nextjs" },
      { ...base, id: "bd-4", agent: undefined },
    ];
    expect(uniqueFieldOptions(rows, "agent")).toEqual(["fastapi", "nextjs"]);
  });
});

describe("uniqueEpicOptions", () => {
  it("dedupes by epic id and sorts by title", () => {
    const rows: TicketRow[] = [
      { ...base, id: "bd-1", epicId: "ep-2", epicTitle: "Zebra" },
      { ...base, id: "bd-2", epicId: "ep-1", epicTitle: "Alpha" },
      { ...base, id: "bd-3", epicId: "ep-2", epicTitle: "Zebra" },
      { ...base, id: "bd-4", epicId: undefined },
    ];
    expect(uniqueEpicOptions(rows)).toEqual([
      { id: "ep-1", title: "Alpha" },
      { id: "ep-2", title: "Zebra" },
    ]);
  });
});

describe("sortTicketsByCreated", () => {
  const rows: TicketRow[] = [
    { ...base, id: "old", createdAt: "2026-07-10T12:00:00Z" },
    { ...base, id: "new", createdAt: "2026-07-13T12:00:00Z" },
    { ...base, id: "mid", createdAt: "2026-07-11T12:00:00Z" },
  ];

  it("orders newest first for created-desc", () => {
    expect(sortTicketsByCreated(rows, "created-desc").map((t) => t.id)).toEqual(["new", "mid", "old"]);
  });

  it("orders oldest first for created-asc", () => {
    expect(sortTicketsByCreated(rows, "created-asc").map((t) => t.id)).toEqual(["old", "mid", "new"]);
  });

  it("does not mutate the input array", () => {
    const input = [...rows];
    sortTicketsByCreated(input, "created-desc");
    expect(input.map((t) => t.id)).toEqual(["old", "new", "mid"]);
  });

  it("sinks rows with missing/unparseable timestamps to the bottom in both directions", () => {
    const withGaps: TicketRow[] = [
      { ...base, id: "missing", createdAt: "" },
      { ...base, id: "old", createdAt: "2026-07-10T12:00:00Z" },
      { ...base, id: "bad", createdAt: "not-a-date" },
      { ...base, id: "new", createdAt: "2026-07-13T12:00:00Z" },
    ];
    expect(sortTicketsByCreated(withGaps, "created-desc").map((t) => t.id)).toEqual([
      "new",
      "old",
      "missing",
      "bad",
    ]);
    const asc = sortTicketsByCreated(withGaps, "created-asc").map((t) => t.id);
    expect(asc.slice(0, 2)).toEqual(["old", "new"]);
    expect(asc.slice(2).sort()).toEqual(["bad", "missing"]);
  });
});

describe("TICKET_FILTER_FIELDS", () => {
  it("covers every select-driven filter field", () => {
    expect(TICKET_FILTER_FIELDS.map((f) => f.key).sort()).toEqual(
      ["agent", "assigned", "domain", "epic", "outcome", "risk", "size", "status", "type"].sort(),
    );
  });

  // Every select-driven field must also be a serialized key, or the toolbar would render a control
  // whose value is dropped from the URL and never reaches getTickets — the bug that left `outcome`
  // wired to nothing in the page and the API route.
  it("only offers fields that round-trip through the query string", () => {
    for (const field of TICKET_FILTER_FIELDS) {
      expect(TICKET_FILTER_KEYS).toContain(field.key);
    }
  });

  it("serializes and reads back the unassigned filter", () => {
    expect(ticketsQueryString({ assigned: "unassigned" })).toBe("?assigned=unassigned");
    expect(
      filtersFromSearchParams(new URLSearchParams("assigned=unassigned")).assigned,
    ).toBe("unassigned");
  });
});
