import { describe, expect, it } from "vitest";
import { STAGE_LABELS, isExternalUrl, ticketBadges } from "@/components/board/board-utils";
import { STAGES, type Ticket } from "@/lib/types";

describe("STAGE_LABELS", () => {
  it("has a human label for every stage", () => {
    for (const stage of STAGES) {
      expect(STAGE_LABELS[stage]).toBeTruthy();
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
