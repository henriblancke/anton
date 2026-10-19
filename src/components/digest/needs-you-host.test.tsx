// @vitest-environment jsdom
/**
 * `DigestNeedsYouHost` (anton-rokar): the digest page's one client boundary for `DigestNeedsYou`.
 * `DigestNeedsYou` and `TicketDialog` are both exhaustively tested elsewhere — this file only
 * proves the wiring between them: a ticket id reaches the dialog, and a landed Mark done refreshes
 * the page.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import { DigestNeedsYouHost } from "@/components/digest/needs-you-host";
import type { DigestNeedsYouSummary } from "@/lib/attention";

const refresh = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh }) }));

vi.mock("@/components/health/needs-you-section", () => ({
  DigestNeedsYou: ({
    onOpenTicket,
    onDone,
  }: {
    onOpenTicket: (id: string) => void;
    onDone?: () => void;
  }) => (
    <div>
      <button onClick={() => onOpenTicket("anton-t1")}>open ticket</button>
      <button onClick={() => onDone?.()}>mark done</button>
    </div>
  ),
}));

vi.mock("@/components/ticket/ticket-dialog", () => ({
  TicketDialog: ({
    ticketId,
    open,
    onSaved,
    onDeleted,
  }: {
    ticketId: string | null;
    open: boolean;
    onSaved?: () => void;
    onDeleted?: () => void;
  }) => (
    <div data-testid="dialog" data-open={open} data-ticket={ticketId ?? ""}>
      <button onClick={() => onSaved?.()}>save ticket</button>
      <button onClick={() => onDeleted?.()}>delete ticket</button>
    </div>
  ),
}));

afterEach(() => {
  cleanup();
  refresh.mockClear();
});

const summary: DigestNeedsYouSummary = {
  items: [],
  counts: { breaker: 0, "parked-ask": 0, "merge-ready-pr": 0, proposal: 0, "human-ticket": 0 },
  total: 0,
};

describe("DigestNeedsYouHost", () => {
  it("starts with the dialog closed", () => {
    render(<DigestNeedsYouHost slug="anton" summary={summary} />);
    const dialog = screen.getByTestId("dialog");
    expect(dialog.dataset.open).toBe("false");
  });

  it("opens the shared ticket dialog on the id DigestNeedsYou hands it", () => {
    render(<DigestNeedsYouHost slug="anton" summary={summary} />);

    fireEvent.click(screen.getByText("open ticket"));

    const dialog = screen.getByTestId("dialog");
    expect(dialog.dataset.open).toBe("true");
    expect(dialog.dataset.ticket).toBe("anton-t1");
  });

  it("refreshes the page when a queued ticket's Mark done lands", () => {
    render(<DigestNeedsYouHost slug="anton" summary={summary} />);

    fireEvent.click(screen.getByText("mark done"));

    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("refreshes the page when a parented human ticket is saved in the dialog", () => {
    render(<DigestNeedsYouHost slug="anton" summary={summary} />);

    fireEvent.click(screen.getByText("save ticket"));

    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("refreshes the page when a parented human ticket is deleted in the dialog", () => {
    render(<DigestNeedsYouHost slug="anton" summary={summary} />);

    fireEvent.click(screen.getByText("delete ticket"));

    expect(refresh).toHaveBeenCalledTimes(1);
  });
});
