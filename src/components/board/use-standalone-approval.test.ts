// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";
import { toast } from "sonner";

import type { StandaloneItem } from "@/lib/types";
import { makeStandaloneItem } from "@/components/board/standalone-item.fixture";
import { useStandaloneApproval } from "@/components/board/use-standalone-approval";

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() },
}));

const ok = (body: unknown = {}) =>
  new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });

function render(item: StandaloneItem = makeStandaloneItem()) {
  return renderHook((props: StandaloneItem) => useStandaloneApproval("anton", props), {
    initialProps: item,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("useStandaloneApproval", () => {
  it("follows the server truth for approval and snooze until something is clicked", () => {
    const { result } = render(makeStandaloneItem({ approved: true, deferred: true }));
    expect(result.current.approved).toBe(true);
    expect(result.current.deferred).toBe(true);
    expect(result.current.running).toBe(false);
  });

  it("hides the run affordance immediately on approve and posts the run-directly choice", async () => {
    const fetchMock = vi.fn(async () => ok());
    vi.stubGlobal("fetch", fetchMock);
    const { result } = render();

    await act(async () => {
      await result.current.approveRun(false);
    });

    expect(result.current.approved).toBe(true);
    expect(result.current.running).toBe(false);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/projects/anton/epics/t-1/approve");
    expect(JSON.parse(String(init.body))).toEqual({ immediate: false });
    expect(toast.success).toHaveBeenCalledWith('Queued "Loose task" for optimal usage');
  });

  it("runs now by default, and surfaces the advisory gaps the approve reported", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ok({ advisory: ["t-1 — missing Verify"] })));
    const { result } = render();

    await act(async () => {
      await result.current.approveRun();
    });

    expect(toast.success).toHaveBeenCalledWith('Approved & running "Loose task"');
    // The run started thin; the operator is told once, here.
    expect(toast.warning).toHaveBeenCalled();
  });

  it("reverts the optimistic approval and surfaces the route's reason when approve fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ error: "still blocked by t-9" }), { status: 409 })),
    );
    const { result } = render();

    await act(async () => {
      await result.current.approveRun();
    });

    expect(result.current.approved).toBe(false);
    expect(result.current.running).toBe(false);
    expect(toast.error).toHaveBeenCalledWith("still blocked by t-9");
  });

  it("keeps another operator's approval visible — the flag only ever adds to the server truth", () => {
    const { result, rerender } = render();
    expect(result.current.approved).toBe(false);
    rerender(makeStandaloneItem({ approved: true }));
    expect(result.current.approved).toBe(true);
  });

  it("holds a snooze until the board's poll agrees, then hands control back to the server", () => {
    const { result, rerender } = render();

    act(() => result.current.setDeferred(true));
    expect(result.current.deferred).toBe(true);

    // A poll that hasn't caught up yet must not un-snooze the chip under the operator.
    rerender(makeStandaloneItem({ deferred: false }));
    expect(result.current.deferred).toBe(true);

    // Once the server agrees the override retires…
    rerender(makeStandaloneItem({ deferred: true }));
    expect(result.current.deferred).toBe(true);

    // …so another operator's un-snooze is no longer masked by our stale click.
    rerender(makeStandaloneItem({ deferred: false }));
    expect(result.current.deferred).toBe(false);
  });
});
