// @vitest-environment jsdom
/**
 * `MarkSeenFooter` (anton-rokar): the digest's own mark-seen affordance. The property under test is
 * the acceptance criterion itself — the button and reaching the end of the page both call mark-seen,
 * and simply opening the page (however short it is) never does.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

import { MarkSeenFooter } from "@/components/digest/mark-seen-footer";

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

/** A fake IntersectionObserver that hands the test direct control over each callback. */
class FakeIntersectionObserver {
  static instances: FakeIntersectionObserver[] = [];
  callback: IntersectionObserverCallback;
  constructor(callback: IntersectionObserverCallback) {
    this.callback = callback;
    FakeIntersectionObserver.instances.push(this);
  }
  observe = vi.fn();
  unobserve = vi.fn();
  disconnect = vi.fn();
  /** Fire the observer's callback as the browser would, with just the one `isIntersecting` flag the
   * component reads. */
  fire(isIntersecting: boolean) {
    this.callback(
      [{ isIntersecting } as IntersectionObserverEntry],
      this as unknown as IntersectionObserver,
    );
  }
}

let fetchMock: ReturnType<typeof vi.fn>;

/** Mocks the sentinel's geometry: `top`/`bottom` relative to jsdom's default 768px viewport. */
function mockSentinelRect(rect: { top: number; bottom: number }) {
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
    ...rect,
    left: 0,
    right: 0,
    width: 0,
    height: rect.bottom - rect.top,
    x: 0,
    y: rect.top,
    toJSON() {
      return this;
    },
  } as DOMRect);
}

beforeEach(() => {
  FakeIntersectionObserver.instances = [];
  vi.stubGlobal("IntersectionObserver", FakeIntersectionObserver);
  fetchMock = vi.fn(async () => new Response(JSON.stringify({ mark: {}, moved: true }), { status: 200 }));
  vi.stubGlobal("fetch", fetchMock);
  // Off-screen by default — most tests care about the scroll trigger, not the mount-time geometry
  // check. Tests that exercise that check mock their own rect.
  mockSentinelRect({ top: 2000, bottom: 2050 });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("MarkSeenFooter", () => {
  it("never calls mark-seen just from mounting, even when the sentinel starts on screen", () => {
    // A short/empty digest can already have this footer in view the instant it mounts — the
    // mount-time geometry check (not the observer's first callback) is what should recognize that.
    mockSentinelRect({ top: 100, bottom: 150 });
    render(<MarkSeenFooter slug="anton" until={1000} />);
    FakeIntersectionObserver.instances[0]!.fire(true);

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("calls mark-seen when a fast scroll already shows intersecting on the very first callback", () => {
    // The sentinel is off-screen at mount, but the observer's first (always-async) callback can
    // still land after the operator has already scrolled past it (PR #350 review) — there is no
    // later callback to catch this once the scroll settles, so the first one must count.
    render(<MarkSeenFooter slug="anton" until={2000} />);
    FakeIntersectionObserver.instances[0]!.fire(true);

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("processes every entry in a batch, not just the first", () => {
    // A fast scroll can coalesce the baseline and the entering transition into one callback
    // delivery with two entries for this single target (PR #350 review).
    render(<MarkSeenFooter slug="anton" until={3000} />);
    const observer = FakeIntersectionObserver.instances[0]!;
    observer.callback(
      [{ isIntersecting: false } as IntersectionObserverEntry, { isIntersecting: true } as IntersectionObserverEntry],
      observer as unknown as IntersectionObserver,
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("calls mark-seen when the operator clicks the button", async () => {
    render(<MarkSeenFooter slug="anton" until={1234} />);

    fireEvent.click(screen.getByRole("button", { name: "Mark all as seen" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/projects/anton/timeline/mark-seen",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ seenAt: 1234 }),
      }),
    );
    await waitFor(() => expect(screen.getByText("Marked as seen")).toBeTruthy());
  });

  it("calls mark-seen when the operator actually scrolls to the end, after the page has settled", async () => {
    render(<MarkSeenFooter slug="anton" until={5678} />);
    const observer = FakeIntersectionObserver.instances[0]!;

    // The initial read — not yet visible — is ignored the same as a start-visible one would be.
    observer.fire(false);
    expect(fetchMock).not.toHaveBeenCalled();

    // A later callback, after the operator actually scrolled, is the real signal.
    observer.fire(true);

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/projects/anton/timeline/mark-seen",
      expect.objectContaining({ body: JSON.stringify({ seenAt: 5678 }) }),
    );
  });

  it("does not post twice when the button and the scroll trigger both fire", async () => {
    render(<MarkSeenFooter slug="anton" until={10} />);
    const observer = FakeIntersectionObserver.instances[0]!;
    observer.fire(false);

    fireEvent.click(screen.getByRole("button", { name: "Mark all as seen" }));
    observer.fire(true);

    await waitFor(() => expect(screen.getByText("Marked as seen")).toBeTruthy());
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
