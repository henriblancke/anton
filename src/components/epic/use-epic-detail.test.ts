// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";

import { runOutcomeMessage, useEpicDetail } from "@/components/epic/use-epic-detail";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

describe("runOutcomeMessage", () => {
  it("says a forced run is a re-run, whatever pacing it was given", () => {
    // Force run only appears on an implementing target: the job resumes, it does not start.
    expect(runOutcomeMessage({ force: true, immediate: true, title: "Loose task" })).toBe(
      'Re-running "Loose task"',
    );
  });

  it("distinguishes running now from queuing for the budget governor", () => {
    expect(runOutcomeMessage({ immediate: true, title: "Loose task" })).toBe(
      'Run started for "Loose task"',
    );
    expect(runOutcomeMessage({ immediate: false, title: "Loose task" })).toBe(
      'Queued "Loose task" for optimal usage',
    );
  });
});

describe("the self-review history's retry", () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("reads as loading, not as failed, while a retry is in flight", async () => {
    // The detail read is not what is under test; keep it permanently pending so only the review
    // read's states move.
    let releaseReview!: (res: Response) => void;
    fetchMock.mockImplementation((url: string) => {
      if (!url.endsWith("/review")) return new Promise(() => {});
      if (fetchMock.mock.calls.filter((c) => String(c[0]).endsWith("/review")).length === 1) {
        return Promise.resolve(new Response("nope", { status: 500 }));
      }
      return new Promise<Response>((resolve) => {
        releaseReview = resolve;
      });
    });

    const { result } = renderHook(() => useEpicDetail({ slug: "tmp", epicId: "anton-1" }));

    await waitFor(() =>
      expect(result.current.reviewError).toBe("Couldn't load the self-review history (500)"),
    );
    expect(result.current.reviewLoading).toBe(false);

    act(() => result.current.refresh());

    // The stale failure is cleared before the retry goes out, so the panel shows a spinner rather
    // than the error it is busy retrying.
    await waitFor(() => expect(result.current.reviewLoading).toBe(true));
    expect(result.current.reviewError).toBeNull();

    await act(async () => {
      releaseReview(
        new Response(JSON.stringify({ report: { scores: [] } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    });

    await waitFor(() => expect(result.current.reviewLoading).toBe(false));
    expect(result.current.reviewError).toBeNull();
    expect(result.current.review).toBeDefined();
  });
});
