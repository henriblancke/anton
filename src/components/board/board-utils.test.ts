import { describe, expect, it } from "vitest";
import {
  STAGE_ACCENT_DOT,
  STAGE_LABELS,
  badgeVariant,
  isExternalUrl,
  moveEpicBetweenColumns,
  ticketBadges,
  ticketDotTitle,
} from "@/components/board/board-utils";
import { STAGES, type Epic, type Stage, type Ticket } from "@/lib/types";

describe("STAGE_LABELS", () => {
  it("has a human label for every stage", () => {
    for (const stage of STAGES) {
      expect(STAGE_LABELS[stage]).toBeTruthy();
    }
  });
});

describe("STAGE_ACCENT_DOT", () => {
  it("has an accent class for every stage", () => {
    for (const stage of STAGES) {
      expect(STAGE_ACCENT_DOT[stage]).toBeTruthy();
    }
  });
});

describe("ticketBadges", () => {
  const base: Ticket = { id: "bd-1", title: "Do the thing", status: "open", stage: "backlog" };

  it("returns no badges when no fields are set", () => {
    expect(ticketBadges(base)).toEqual([]);
  });

  it("includes agent, risk, and size when present, in order", () => {
    const ticket: Ticket = { ...base, agent: "fastapi", risk: "high", size: "m" };
    expect(ticketBadges(ticket)).toEqual([
      { key: "agent", label: "fastapi" },
      { key: "risk", label: "risk:high" },
      { key: "size", label: "size:m" },
    ]);
  });

  it("skips unset fields", () => {
    const ticket: Ticket = { ...base, size: "l" };
    expect(ticketBadges(ticket)).toEqual([{ key: "size", label: "size:l" }]);
  });
});

describe("badgeVariant", () => {
  it("flags risk:high as destructive", () => {
    expect(badgeVariant({ key: "risk", label: "risk:high" })).toBe("destructive");
  });

  it("keeps other risk levels and agent/size badges neutral", () => {
    expect(badgeVariant({ key: "risk", label: "risk:low" })).toBe("outline");
    expect(badgeVariant({ key: "agent", label: "fastapi" })).toBe("outline");
    expect(badgeVariant({ key: "size", label: "size:m" })).toBe("outline");
  });
});

describe("ticketDotTitle", () => {
  const base: Ticket = { id: "bd-1", title: "Do the thing", status: "open", stage: "backlog" };

  it("includes only the title when no metadata is set", () => {
    expect(ticketDotTitle(base)).toBe("Do the thing");
  });

  it("appends agent and risk when present", () => {
    const ticket: Ticket = { ...base, agent: "fastapi", risk: "high" };
    expect(ticketDotTitle(ticket)).toBe("Do the thing · agent:fastapi · risk:high");
  });
});

describe("isExternalUrl", () => {
  it("recognizes http(s) URLs", () => {
    expect(isExternalUrl("https://github.com/org/repo/pull/123")).toBe(true);
    expect(isExternalUrl("http://example.com")).toBe(true);
  });

  it("rejects bare bead external-refs", () => {
    expect(isExternalUrl("gh-123")).toBe(false);
    expect(isExternalUrl("")).toBe(false);
  });
});

describe("moveEpicBetweenColumns", () => {
  function makeColumns(): Record<Stage, Epic[]> {
    return {
      backlog: [{ id: "e1", title: "Epic 1", approved: false, stage: "backlog", tickets: [] }],
      implementing: [],
      "in-review": [],
      done: [],
    };
  }

  it("moves the epic to the target stage and updates its stage field", () => {
    const next = moveEpicBetweenColumns(makeColumns(), "e1", "implementing");
    expect(next.backlog).toEqual([]);
    expect(next.implementing).toHaveLength(1);
    expect(next.implementing[0]).toMatchObject({ id: "e1", stage: "implementing" });
  });

  it("is a no-op when the epic id doesn't exist", () => {
    const columns = makeColumns();
    const next = moveEpicBetweenColumns(columns, "missing", "done");
    expect(next).toEqual(columns);
  });

  it("prepends the moved epic in the destination column", () => {
    const columns = makeColumns();
    columns.done.push({ id: "e2", title: "Epic 2", approved: true, stage: "done", tickets: [] });
    const next = moveEpicBetweenColumns(columns, "e1", "done");
    expect(next.done.map((e) => e.id)).toEqual(["e1", "e2"]);
  });
});
