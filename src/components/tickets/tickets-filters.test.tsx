// @vitest-environment jsdom
/**
 * The tickets filter toolbar (anton-xhm4 regression anchor): the bar's ids and options after the
 * native select moved to `@/components/ui/filter-select`. Its empty option is the bare facet name —
 * the board's reads "Epic: All" — so the shared control must not normalize one into the other.
 *
 * next/navigation MUST be mocked — under jsdom there's no App Router provider, so the real
 * `useSearchParams()` returns null (typed non-null, so tsc happily lets the suite die at runtime).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import type { TicketRow } from "@/lib/types";
import { TicketsFilters } from "@/components/tickets/tickets-filters";

const push = vi.fn();
let search = "";
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push }),
  usePathname: () => "/projects/anton/tickets",
  useSearchParams: () => new URLSearchParams(search),
}));

function ticket(over: Partial<TicketRow> = {}): TicketRow {
  return {
    id: "anton-1",
    title: "Split apply.test.ts",
    status: "open",
    stage: "backlog",
    type: "task",
    assignee: null,
    createdAt: "2026-08-01T00:00:00.000Z",
    createdBy: null,
    deferred: false,
    abandoned: false,
    ...over,
  };
}

const TICKETS: TicketRow[] = [
  ticket({ agent: "nextjs", risk: "low", epicId: "anton-epc", epicTitle: "Code health" }),
  ticket({ id: "anton-2", agent: "fastapi", risk: "high", type: "bug" }),
];

beforeEach(() => {
  push.mockClear();
  search = "";
});

afterEach(() => {
  cleanup();
});

describe("TicketsFilters", () => {
  it("gives every facet a ticket-scoped id and the bare facet name as its empty option", () => {
    render(<TicketsFilters tickets={TICKETS} />);

    const agent = screen.getByLabelText("Agent") as HTMLSelectElement;
    expect(agent.id).toBe("ticket-filter-agent");
    expect([...agent.options].map((o) => o.text)).toEqual(["Agent", "fastapi", "nextjs"]);

    // Fixed-choice fields keep their own list; derived ones read off the rows.
    expect((screen.getByLabelText("Epic/feature") as HTMLSelectElement).id).toBe(
      "ticket-filter-assigned",
    );
    expect([...(screen.getByLabelText("Outcome") as HTMLSelectElement).options].map((o) => o.text)).toEqual([
      "Outcome",
      "Hide abandoned",
      "Abandoned only",
    ]);
    expect([...(screen.getByLabelText("Epic") as HTMLSelectElement).options].map((o) => o.text)).toEqual([
      "Epic",
      "Code health",
    ]);
  });

  it("stacks each label above its select", () => {
    render(<TicketsFilters tickets={TICKETS} />);
    const wrapper = (screen.getByLabelText("Risk") as HTMLSelectElement).parentElement!;
    expect(wrapper.className).toBe("flex flex-col gap-1");
  });

  it("pushes the picked facet alongside the filters already in the URL", () => {
    search = "agent=nextjs";
    render(<TicketsFilters tickets={TICKETS} />);

    expect((screen.getByLabelText("Agent") as HTMLSelectElement).value).toBe("nextjs");
    fireEvent.change(screen.getByLabelText("Risk"), { target: { value: "high" } });
    expect(push).toHaveBeenCalledWith("/projects/anton/tickets?agent=nextjs&risk=high", {
      scroll: false,
    });
  });

  it("drops a facet from the URL when it is cleared", () => {
    search = "agent=nextjs&risk=high";
    render(<TicketsFilters tickets={TICKETS} />);

    fireEvent.change(screen.getByLabelText("Agent"), { target: { value: "" } });
    expect(push).toHaveBeenCalledWith("/projects/anton/tickets?risk=high", { scroll: false });
  });
});
