// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

import { SnoozeButton } from "@/components/ticket/snooze-button";
import type { TicketDetail } from "@/lib/types";

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const detail = (deferred: boolean) => ({ id: "t-1", title: "Not now", deferred }) as TicketDetail;

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("SnoozeButton", () => {
  it("POSTs the defer route to snooze an active ticket", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ detail: detail(true) }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const onChanged = vi.fn();

    render(<SnoozeButton slug="anton" ticketId="t-1" deferred={false} onChanged={onChanged} />);
    fireEvent.click(screen.getByRole("button", { name: "Snooze" }));

    await waitFor(() => expect(onChanged).toHaveBeenCalledWith(detail(true)));
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("/api/projects/anton/tickets/t-1/defer");
    expect(init.method).toBe("POST");
  });

  it("DELETEs it to restore a snoozed ticket, and labels itself Un-snooze", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ detail: detail(false) }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const onChanged = vi.fn();

    render(<SnoozeButton slug="anton" ticketId="t-1" deferred onChanged={onChanged} />);
    fireEvent.click(screen.getByRole("button", { name: "Un-snooze" }));

    await waitFor(() => expect(onChanged).toHaveBeenCalledWith(detail(false)));
    expect(fetchMock.mock.calls[0]![1].method).toBe("DELETE");
  });

  it("keeps the state unchanged when the write fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: "nope" }), { status: 404 })),
    );
    const onChanged = vi.fn();

    render(<SnoozeButton slug="anton" ticketId="t-1" deferred={false} onChanged={onChanged} />);
    fireEvent.click(screen.getByRole("button", { name: "Snooze" }));

    await waitFor(() => expect(screen.getByRole("button", { name: "Snooze" })).toBeDefined());
    expect(onChanged).not.toHaveBeenCalled();
  });
});
