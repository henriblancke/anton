// @vitest-environment jsdom
/**
 * The undo for a durable dismissal (anton-7gxs).
 *
 * A dismissed stall stays down until it changes — that is what makes clearing a storm worth doing.
 * A durable decision with no way back is a trap, so this section's existence IS the disclosure that
 * dismissal is not deletion, and the restore button is the property under test.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

import { DismissedSection } from "@/components/health/dismissed-section";
import type { EscalationView } from "@/lib/types";

const refresh = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => refresh() }) }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

function dismissed(o: Partial<EscalationView> = {}): EscalationView {
  return {
    id: "esc-1",
    findingKey: "exhausted-job:j-1",
    kind: "exhausted-job",
    reason: "claude exited 1: API Error 503",
    ageMs: 0,
    status: "resolved",
    resolution: "dismissed",
    dismissedAt: Math.floor(Date.now() / 1000) - 3600,
    noted: true,
    raisedAt: 0,
    ...o,
  };
}

describe("DismissedSection", () => {
  it("renders nothing when nothing has been dismissed", () => {
    const { container } = render(<DismissedSection slug="anton" dismissed={[]} />);
    expect(container.innerHTML).toBe("");
  });

  it("folds by default, so a record of past decisions never competes with live work", () => {
    render(<DismissedSection slug="anton" dismissed={[dismissed()]} />);
    expect(screen.getByText("Dismissed")).toBeTruthy();
    expect(screen.getByRole("button", { name: /Show/ })).toBeTruthy();
    // The rows exist but are hidden behind the fold — the disclosure keeps them mounted.
    expect(screen.getByText("claude exited 1: API Error 503")).toBeTruthy();
  });

  it("restores one alert, and re-reads rather than assuming the write landed", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({}), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

    render(<DismissedSection slug="anton" dismissed={[dismissed()]} />);
    fireEvent.click(screen.getByRole("button", { name: /Show/ }));
    fireEvent.click(screen.getByRole("button", { name: "Restore" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/projects/anton/escalations/esc-1");
    expect(JSON.parse(init.body as string)).toEqual({ action: "restore" });
    await waitFor(() => expect(refresh).toHaveBeenCalled());
  });

  it("re-reads on a refused restore too — usually the sweep raised it again, which is the point", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ error: "nothing to restore" }), { status: 409 }),
      ) as unknown as typeof fetch,
    );

    render(<DismissedSection slug="anton" dismissed={[dismissed()]} />);
    fireEvent.click(screen.getByRole("button", { name: /Show/ }));
    fireEvent.click(screen.getByRole("button", { name: "Restore" }));

    await waitFor(() => expect(refresh).toHaveBeenCalled());
  });
});
