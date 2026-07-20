// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

import { TicketStateBar } from "@/components/ticket/ticket-state-bar";
import type { Stage, TicketDetail } from "@/lib/types";

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const detail = (over: { stage?: Stage; deferred?: boolean; abandoned?: boolean }) =>
  ({
    id: "t-1",
    title: "Do the thing",
    status: "open",
    stage: over.stage ?? "implementing",
    type: "task",
    deferred: over.deferred ?? false,
    abandoned: over.abandoned ?? false,
  }) as TicketDetail;

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("TicketStateBar", () => {
  it("POSTs the defer route when Snoozed is picked on an active ticket", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ detail: detail({ deferred: true }) }), { status: 200 }),
      );
    vi.stubGlobal("fetch", fetchMock);
    const onChanged = vi.fn();

    render(<TicketStateBar slug="anton" ticketId="t-1" detail={detail({})} onChanged={onChanged} />);
    fireEvent.click(screen.getByRole("button", { name: /Snoozed/ }));

    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("/api/projects/anton/tickets/t-1/defer");
    expect(init.method).toBe("POST");
  });

  it("DELETEs the defer route when Active is picked on a snoozed ticket", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ detail: detail({}) }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    render(
      <TicketStateBar
        slug="anton"
        ticketId="t-1"
        detail={detail({ deferred: true })}
        onChanged={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /Active/ }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(fetchMock.mock.calls[0]![1].method).toBe("DELETE");
  });

  it("requires a non-empty reason before abandoning, then POSTs it", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ detail: detail({ abandoned: true }) }), { status: 200 }),
      );
    vi.stubGlobal("fetch", fetchMock);
    const onChanged = vi.fn();

    render(<TicketStateBar slug="anton" ticketId="t-1" detail={detail({})} onChanged={onChanged} />);

    // Arm the reason form; Confirm is disabled until a reason is typed.
    fireEvent.click(screen.getByRole("button", { name: /Abandoned/ }));
    const confirm = screen.getByRole("button", { name: /Confirm abandon/ });
    expect((confirm as HTMLButtonElement).disabled).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();

    fireEvent.change(screen.getByLabelText("Reason for abandoning this ticket"), {
      target: { value: "superseded by the new flow" },
    });
    fireEvent.click(screen.getByRole("button", { name: /Confirm abandon/ }));

    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("/api/projects/anton/tickets/t-1/abandon");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({ reason: "superseded by the new flow" });
  });

  it("shows a static Done state (no resolution segment) for a shipped ticket", () => {
    render(
      <TicketStateBar
        slug="anton"
        ticketId="t-1"
        detail={detail({ stage: "done" })}
        onChanged={vi.fn()}
      />,
    );
    expect(screen.getByText("Done")).toBeDefined();
    expect(screen.queryByRole("button", { name: /Snoozed/ })).toBeNull();
  });

  it("locks the Active/Snoozed toggle once abandoned", () => {
    render(
      <TicketStateBar
        slug="anton"
        ticketId="t-1"
        detail={detail({ stage: "done", abandoned: true })}
        onChanged={vi.fn()}
      />,
    );
    expect((screen.getByRole("button", { name: /Active/ }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: /Snoozed/ }) as HTMLButtonElement).disabled).toBe(true);
  });
});
