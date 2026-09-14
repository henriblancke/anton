// @vitest-environment jsdom
/**
 * Clearing a storm in one gesture (anton-7gxs).
 *
 * The two properties that matter: it sends ONE request for the whole group (thirty single-row calls
 * would settle thirty rows one at a time and leave a half-cleared group behind any failure), and it
 * asks twice — dismissing is durable now, and buying that much silence on one click is exactly the
 * accident this guard exists for.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

import { DismissAllButton } from "@/components/health/dismiss-all-button";

const refresh = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => refresh() }) }));
const toastSuccess = vi.fn();
const toastError = vi.fn();
vi.mock("sonner", () => ({
  toast: {
    success: (...args: unknown[]) => toastSuccess(...args),
    error: (...args: unknown[]) => toastError(...args),
  },
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

const IDS = ["esc-1", "esc-2", "esc-3"];

function mount() {
  return render(<DismissAllButton slug="anton" ids={IDS} label="Retries spent" />);
}

describe("DismissAllButton", () => {
  it("asks before putting a whole group down, and names the count in the confirm", () => {
    mount();
    fireEvent.click(screen.getByRole("button", { name: /Dismiss all/ }));
    // The count is IN the confirm label, so the second click is made against the number.
    expect(screen.getByRole("button", { name: "Dismiss all 3" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeTruthy();
  });

  it("sends the whole group as one request", async () => {
    const fetchMock = vi.fn(
      async () => new Response(JSON.stringify({ dismissed: 3, skipped: [] }), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

    mount();
    fireEvent.click(screen.getByRole("button", { name: /Dismiss all/ }));
    fireEvent.click(screen.getByRole("button", { name: "Dismiss all 3" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/projects/anton/escalations");
    expect(JSON.parse(init.body as string)).toEqual({ action: "dismiss", ids: IDS });
    await waitFor(() => expect(refresh).toHaveBeenCalled());
  });

  it("reports what the server left alone rather than claiming the whole group went down", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ dismissed: 2, skipped: [{ id: "esc-3" }] }), {
            status: 200,
          }),
      ) as unknown as typeof fetch,
    );

    mount();
    fireEvent.click(screen.getByRole("button", { name: /Dismiss all/ }));
    fireEvent.click(screen.getByRole("button", { name: "Dismiss all 3" }));

    await waitFor(() => expect(toastSuccess).toHaveBeenCalled());
    const [headline, opts] = toastSuccess.mock.calls[0] as [string, { description: string }];
    expect(headline).toContain("2");
    expect(opts.description).toContain("1 left alone");
  });

  it("re-reads on failure, so a stale group can't be clicked twice into an error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ error: "nope" }), { status: 500 })) as
        unknown as typeof fetch,
    );

    mount();
    fireEvent.click(screen.getByRole("button", { name: /Dismiss all/ }));
    fireEvent.click(screen.getByRole("button", { name: "Dismiss all 3" }));

    await waitFor(() => expect(toastError).toHaveBeenCalled());
    expect(refresh).toHaveBeenCalled();
  });
});
