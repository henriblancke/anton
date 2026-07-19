// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

import { TicketNotes } from "@/components/ticket/ticket-notes";
import type { TicketNote } from "@/lib/types";

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const human: TicketNote = {
  source: "human",
  author: "Henri Blancke",
  at: "2026-07-19T22:49:46.000Z",
  text: "reuse the existing helper",
};
const machine: TicketNote = {
  source: "system",
  author: "anton",
  text: "anton: run failed after committing work — needs review",
};

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("TicketNotes", () => {
  it("renders the note history with its authors", () => {
    render(<TicketNotes slug="anton" ticketId="t-1" notes={[machine, human]} onAppended={vi.fn()} />);
    expect(screen.getByText(/reuse the existing helper/)).toBeDefined();
    expect(screen.getByText(/needs review/)).toBeDefined();
    expect(screen.getByText("Henri Blancke")).toBeDefined();
  });

  it("submits the note and hands the refreshed history back to the dialog", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ notes: [human] }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const onAppended = vi.fn();

    render(<TicketNotes slug="anton" ticketId="t-1" notes={[]} onAppended={onAppended} />);
    const box = screen.getByLabelText("New note");
    fireEvent.change(box, { target: { value: "reuse the existing helper" } });
    fireEvent.click(screen.getByRole("button", { name: /add note/i }));

    await waitFor(() => expect(onAppended).toHaveBeenCalledWith([human]));
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("/api/projects/anton/tickets/t-1/notes");
    expect(JSON.parse(init.body)).toEqual({ text: "reuse the existing helper" });
    // The box clears so a second steer isn't accidentally sent twice.
    await waitFor(() => expect((box as HTMLTextAreaElement).value).toBe(""));
  });

  it("refuses to submit an empty note", () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    render(<TicketNotes slug="anton" ticketId="t-1" notes={[]} onAppended={vi.fn()} />);
    fireEvent.change(screen.getByLabelText("New note"), { target: { value: "   " } });
    fireEvent.click(screen.getByRole("button", { name: /add note/i }));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("keeps the text on a failed submit so the operator can retry", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: "boom" }), { status: 400 })),
    );
    const onAppended = vi.fn();
    render(<TicketNotes slug="anton" ticketId="t-1" notes={[]} onAppended={onAppended} />);
    const box = screen.getByLabelText("New note");
    fireEvent.change(box, { target: { value: "keep me" } });
    fireEvent.click(screen.getByRole("button", { name: /add note/i }));

    await waitFor(() => expect((box as HTMLTextAreaElement).value).toBe("keep me"));
    expect(onAppended).not.toHaveBeenCalled();
  });
});
