// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

import { AbandonButton } from "@/components/ticket/abandon-button";
import type { TicketDetail } from "@/lib/types";

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const detail = { id: "t-1", title: "Won't do", abandoned: true } as TicketDetail;

function arm() {
  fireEvent.click(screen.getByRole("button", { name: "Abandon" }));
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("AbandonButton", () => {
  it("POSTs the ticket abandon route with the typed reason once confirmed", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ detail }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const onAbandoned = vi.fn();

    render(<AbandonButton slug="anton" targetId="t-1" kind="ticket" onAbandoned={onAbandoned} />);
    arm();
    fireEvent.change(screen.getByLabelText("Reason for abandoning this ticket"), {
      target: { value: "  superseded by anton-9  " },
    });
    fireEvent.click(screen.getByRole("button", { name: /Confirm abandon/ }));

    await waitFor(() => expect(onAbandoned).toHaveBeenCalledWith({ kind: "ticket", detail }));
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("/api/projects/anton/tickets/t-1/abandon");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body)).toEqual({ reason: "superseded by anton-9" });
  });

  it("refuses to submit without a reason — the reason IS the confirmation", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    render(<AbandonButton slug="anton" targetId="t-1" kind="ticket" />);
    arm();
    const confirm = screen.getByRole("button", { name: /Confirm abandon/ });
    expect(confirm).toHaveProperty("disabled", true);

    // Whitespace is not a reason.
    fireEvent.change(screen.getByLabelText("Reason for abandoning this ticket"), {
      target: { value: "   " },
    });
    fireEvent.click(confirm);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("calls the epic route and reports the ids the cascade settled", async () => {
    const abandoned = { epicId: "e-1", children: ["t-1", "t-2"] };
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(JSON.stringify({ abandoned }), { status: 200 })),
    );
    const onAbandoned = vi.fn();

    render(<AbandonButton slug="anton" targetId="e-1" kind="epic" onAbandoned={onAbandoned} />);
    arm();
    fireEvent.change(screen.getByLabelText("Reason for abandoning this epic"), {
      target: { value: "not shipping this quarter" },
    });
    fireEvent.click(screen.getByRole("button", { name: /Confirm abandon/ }));

    await waitFor(() =>
      expect(onAbandoned).toHaveBeenCalledWith({ kind: "epic", ...abandoned }),
    );
  });

  it("keeps the typed reason armed when the write fails, so a retry doesn't retype it", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          new Response(JSON.stringify({ error: "already closed" }), { status: 409 }),
        ),
    );
    const onAbandoned = vi.fn();

    render(<AbandonButton slug="anton" targetId="t-1" kind="ticket" onAbandoned={onAbandoned} />);
    arm();
    const input = screen.getByLabelText("Reason for abandoning this ticket");
    fireEvent.change(input, { target: { value: "dead end" } });
    fireEvent.click(screen.getByRole("button", { name: /Confirm abandon/ }));

    await waitFor(() => expect(onAbandoned).not.toHaveBeenCalled());
    expect(screen.getByLabelText("Reason for abandoning this ticket")).toHaveProperty(
      "value",
      "dead end",
    );
  });
});
