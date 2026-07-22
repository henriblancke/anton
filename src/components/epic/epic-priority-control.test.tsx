// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

import { EpicPriorityControl } from "@/components/epic/epic-priority-control";

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("EpicPriorityControl", () => {
  it("renders the epic's current priority as the selected value", () => {
    render(<EpicPriorityControl slug="anton" epicId="e-1" priority={2} />);
    const select = screen.getByLabelText("Priority") as HTMLSelectElement;
    expect(select.value).toBe("2");
  });

  it("PATCHes { priority } to the epic route when a new priority is picked", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ detail: {} }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const onChanged = vi.fn();

    render(<EpicPriorityControl slug="anton" epicId="e-1" priority={2} onChanged={onChanged} />);
    fireEvent.change(screen.getByLabelText("Priority"), { target: { value: "0" } });

    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("/api/projects/anton/epics/e-1");
    expect(init.method).toBe("PATCH");
    expect(JSON.parse(init.body as string)).toEqual({ priority: 0 });
  });

  it("does not PATCH when the picked value matches the current priority", () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    render(<EpicPriorityControl slug="anton" epicId="e-1" priority={3} />);
    fireEvent.change(screen.getByLabelText("Priority"), { target: { value: "3" } });

    expect(fetchMock).not.toHaveBeenCalled();
  });
});
