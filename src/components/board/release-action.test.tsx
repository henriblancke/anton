// @vitest-environment jsdom
/**
 * `[Release]` (anton-d2h6 / R3.5). What these pin is the two things the button owes the operator:
 * it starts the pick through the APPROVE route — never a parallel "just run it" path — and a release
 * that loses a claim race says so ON THE CARD and re-reads the lane, rather than leaving a dead pick
 * on screen behind a toast that has already gone.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

import { ReleaseAction } from "@/components/board/release-action";

const refresh = vi.fn();
const success = vi.fn();
const error = vi.fn();

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh, push: vi.fn() }) }));
vi.mock("sonner", () => ({
  toast: {
    success: (...a: unknown[]) => success(...a),
    error: (...a: unknown[]) => error(...a),
    warning: vi.fn(),
  },
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

function stubFetch(body: unknown, status = 200) {
  const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(body), { status }));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function mount(over: Partial<Parameters<typeof ReleaseAction>[0]> = {}) {
  return render(
    <ReleaseAction slug="anton" beadId="anton-a" title="Resumable crawl checkpoints" {...over} />,
  );
}

const release = () => fireEvent.click(screen.getByRole("button", { name: /release/i }));

describe("releasing one pick", () => {
  it("starts it through the approve route — the same gate, claim and enqueue every approval runs", async () => {
    const fetchMock = stubFetch({ jobId: "job-1" });
    const onReleased = vi.fn();
    mount({ onReleased });

    release();

    await waitFor(() => expect(onReleased).toHaveBeenCalled());
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/projects/anton/epics/anton-a/approve",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ release: true, immediate: true }),
      }),
    );
    // One target, one call — there is no bulk release, and no second endpoint to reconcile.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(success).toHaveBeenCalledWith('Released "Resumable crawl checkpoints" — running now');
    await waitFor(() => expect(refresh).toHaveBeenCalled());
  });

  it("says nothing started while the request is in flight, and never fires twice", async () => {
    let settle: (res: Response) => void = () => {};
    const fetchMock = vi.fn().mockReturnValue(new Promise<Response>((r) => (settle = r)));
    vi.stubGlobal("fetch", fetchMock);
    mount();

    const button = screen.getByRole("button", { name: /release/i });
    fireEvent.click(button);

    await waitFor(() => expect(button.hasAttribute("disabled")).toBe(true));
    expect(button.textContent).toBe("Releasing…");
    // A second click on an in-flight release must not start a second run.
    fireEvent.click(button);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    settle(new Response("{}", { status: 200 }));
    await waitFor(() => expect(success).toHaveBeenCalled());
  });
});

describe("a release that loses the claim race", () => {
  it("fails loudly on the card and re-reads the lane", async () => {
    stubFetch(
      { error: "anton-a was claimed by bob while this request was in flight — reload and retry", owner: "bob" },
      409,
    );
    const onReleased = vi.fn();
    mount({ onReleased });

    release();

    // Loud where the operator is looking: beside the button, not only in a toast that scrolls away.
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("claimed by bob");
    expect(error).toHaveBeenCalledWith(expect.stringContaining("claimed by bob"));
    // Our copy of the board is provably behind, so the lane re-reads…
    await waitFor(() => expect(refresh).toHaveBeenCalled());
    // …and nothing reads as started.
    expect(onReleased).not.toHaveBeenCalled();
    expect(success).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: /release/i }).hasAttribute("disabled")).toBe(false);
  });
});

describe("a release the board refused for another reason", () => {
  it("names the refusal on the card and leaves the surface alone", async () => {
    stubFetch({ error: "anton-a does not meet the bead contract: needs Acceptance" }, 422);
    mount();

    release();

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("needs Acceptance");
    // A contract gap did not move the board, so there is nothing staler about this surface.
    expect(refresh).not.toHaveBeenCalled();
  });

  it("still reports a failure the response could not explain", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network down")));
    mount();

    release();

    await waitFor(() => expect(error).toHaveBeenCalledWith("network down"));
    expect((await screen.findByRole("alert")).textContent).toContain("network down");
  });
});
