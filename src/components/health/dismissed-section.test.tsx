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

  /**
   * A dismissal suppresses its stall for as long as its row exists, and this section is the only
   * surface with a `Restore`. So a row past the first page is not a hidden archive entry — it is a
   * live suppression with no way back, which is what the page cap used to create (PR #261 review).
   */
  describe("older pages", () => {
    it("says how many are still suppressed rather than reporting the page as the whole list", () => {
      render(<DismissedSection slug="anton" dismissed={[dismissed()]} total={53} />);
      // The count in the header is the TOTAL, not the page: 53 standing suppressions, not "1".
      expect(screen.getByText("53")).toBeTruthy();
      fireEvent.click(screen.getByRole("button", { name: /^Show$/ }));
      expect(screen.getByRole("button", { name: /Show older/ })).toBeTruthy();
      expect(screen.getByText(/1 of 53 — the rest are still suppressed/)).toBeTruthy();
    });

    it("offers no Show older once the whole list is on screen", () => {
      render(<DismissedSection slug="anton" dismissed={[dismissed()]} total={1} />);
      fireEvent.click(screen.getByRole("button", { name: /^Show$/ }));
      expect(screen.queryByRole("button", { name: /Show older/ })).toBeNull();
    });

    it("pages in the rest, so every suppression becomes restorable", async () => {
      const older = {
        ...dismissed({ id: "esc-2" }),
        reason: "run parked 9h: usage limit",
      };
      const fetchMock = vi.fn(
        async () =>
          new Response(JSON.stringify({ dismissed: [older], total: 2 }), {
            status: 200,
          }),
      );
      vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

      render(<DismissedSection slug="anton" dismissed={[dismissed()]} total={2} />);
      fireEvent.click(screen.getByRole("button", { name: /^Show$/ }));
      fireEvent.click(screen.getByRole("button", { name: /Show older/ }));

      await waitFor(() => expect(screen.getByText("run parked 9h: usage limit")).toBeTruthy());
      const [url] = fetchMock.mock.calls[0] as unknown as [string];
      // Offset is what is already on screen, so the next page starts where this one ended.
      expect(url).toBe("/api/projects/anton/escalations/dismissed?offset=1");
      // And the row that arrived carries its own way back — the point of reaching it at all.
      expect(screen.getAllByRole("button", { name: "Restore" })).toHaveLength(2);
      // Nothing left to ask for.
      expect(screen.queryByRole("button", { name: /Show older/ })).toBeNull();
    });

    it("shows a row once when a refresh pulls a paged-in row into the first page", async () => {
      // Restoring re-renders the server page, which can hand back a row `older` already holds.
      const both = [dismissed(), dismissed({ id: "esc-2", reason: "second" })];
      const fetchMock = vi.fn(
        async () =>
          new Response(JSON.stringify({ dismissed: [both[1]], total: 2 }), {
            status: 200,
          }),
      );
      vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

      const { rerender } = render(
        <DismissedSection slug="anton" dismissed={[both[0]]} total={2} />,
      );
      fireEvent.click(screen.getByRole("button", { name: /^Show$/ }));
      fireEvent.click(screen.getByRole("button", { name: /Show older/ }));
      await waitFor(() => expect(screen.getByText("second")).toBeTruthy());

      rerender(<DismissedSection slug="anton" dismissed={both} total={2} />);
      // One row, not two: a repeated key here would also offer the same decision twice.
      expect(screen.getAllByText("second")).toHaveLength(1);
    });

    it("stops offering a restored row from an older page", async () => {
      // `router.refresh()` re-renders the server's FIRST page only, so a paged-in row lives in
      // client state the refresh never reaches. Left there, it keeps a `Restore` that can only 409.
      const older = { ...dismissed({ id: "esc-2" }), reason: "run parked 9h: usage limit" };
      const fetchMock = vi.fn(async (url: string) =>
        url.includes("/dismissed?offset=")
          ? new Response(JSON.stringify({ dismissed: [older], total: 2 }), { status: 200 })
          : new Response(JSON.stringify({}), { status: 200 }),
      );
      vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

      render(<DismissedSection slug="anton" dismissed={[dismissed()]} total={2} />);
      fireEvent.click(screen.getByRole("button", { name: /^Show$/ }));
      fireEvent.click(screen.getByRole("button", { name: /Show older/ }));
      await waitFor(() => expect(screen.getByText("run parked 9h: usage limit")).toBeTruthy());

      // Restore the PAGED-IN row, not the server-rendered one.
      fireEvent.click(screen.getAllByRole("button", { name: "Restore" })[1]);

      await waitFor(() => expect(screen.queryByText("run parked 9h: usage limit")).toBeNull());
      expect(screen.getAllByRole("button", { name: "Restore" })).toHaveLength(1);
    });

    it("keeps the list it has when an older page fails to load", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn(
          async () => new Response(JSON.stringify({ error: "nope" }), { status: 500 }),
        ) as unknown as typeof fetch,
      );

      render(<DismissedSection slug="anton" dismissed={[dismissed()]} total={2} />);
      fireEvent.click(screen.getByRole("button", { name: /^Show$/ }));
      fireEvent.click(screen.getByRole("button", { name: /Show older/ }));

      // The button comes back rather than sticking on "Loading…" — the operator can try again.
      await waitFor(() => expect(screen.getByRole("button", { name: /Show older/ })).toBeTruthy());
      expect(screen.getByText("claude exited 1: API Error 503")).toBeTruthy();
    });
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
