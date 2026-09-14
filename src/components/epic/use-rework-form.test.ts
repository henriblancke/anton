// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { toast } from "sonner";

import type { ReviewReport, Ticket } from "@/lib/types";
import { useReworkForm, type ReworkFormOptions } from "@/components/epic/use-rework-form";

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const ticket = (id: string, over: Partial<Ticket> = {}): Ticket =>
  ({
    id,
    title: id,
    status: "closed",
    stage: "done",
    assignee: null,
    createdAt: "",
    createdBy: null,
    deferred: false,
    abandoned: false,
    ...over,
  }) as Ticket;

const TICKETS = [ticket("t-1"), ticket("t-2")];

const REPORT: ReviewReport = {
  rounds: [{ round: 1, score: 4, blocking: 1, advisory: 0, verdict: "unresolved" }],
  score: 4,
  findings: [{ severity: "blocking", location: "src/a.ts:12", note: "no null guard" }],
};

const RESULT = { mode: "reopen", ticketId: "t-1", reworkedId: "t-1", note: "", applied: true };

function render(options: Partial<ReworkFormOptions> = {}) {
  const onClose = vi.fn();
  const onReworked = vi.fn();
  const view = renderHook((props: ReworkFormOptions) => useReworkForm(props), {
    initialProps: {
      slug: "anton",
      targetId: "feat-1",
      tickets: TICKETS,
      onClose,
      onReworked,
      ...options,
    } satisfies ReworkFormOptions,
  });
  return { ...view, onClose, onReworked };
}

/** Hands back the resolver for each URL fetch was called with, so a response can be held open. */
function gatedFetch() {
  const gates = new Map<string, (res: Response) => void>();
  const fetchMock = vi.fn(
    (...[url]: [string, RequestInit?]) =>
      new Promise<Response>((resolve) => gates.set(url, resolve)),
  );
  vi.stubGlobal("fetch", fetchMock);
  const settle = async (url: string, res: Response) => {
    await act(async () => {
      gates.get(url)!(res);
    });
  };
  return { fetchMock, settle };
}

const reportRes = (report: ReviewReport) =>
  new Response(JSON.stringify({ report }), { status: 200 });

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("useReworkForm — reading the report", () => {
  it("reports the fetch as in flight, so an empty findings list is never claimed prematurely", async () => {
    const { settle } = gatedFetch();
    const { result } = render();

    expect(result.current.reportLoading).toBe(true);
    expect(result.current.findings).toEqual([]);
    expect(result.current.reportError).toBeNull();

    await settle("/api/projects/anton/epics/feat-1/review", reportRes(REPORT));

    expect(result.current.reportLoading).toBe(false);
    expect(result.current.findings).toEqual(REPORT.findings);
  });

  it("never loads when the page handed the report down", () => {
    const { fetchMock } = gatedFetch();
    const { result } = render({ report: REPORT });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.current.reportLoading).toBe(false);
    expect(result.current.findings).toEqual(REPORT.findings);
  });

  it("surfaces a failed read as an error and stops loading, leaving the submit usable", async () => {
    const { settle } = gatedFetch();
    const { result } = render();

    await settle("/api/projects/anton/epics/feat-1/review", new Response("nope", { status: 500 }));

    expect(result.current.reportLoading).toBe(false);
    expect(result.current.report).toBeNull();
    expect(result.current.reportError).toMatch(/Couldn't load the review report \(500\)/);

    act(() => result.current.patch({ summary: "not done", instructions: "Fix it." }));
    expect(result.current.canSubmit).toBe(true);
  });

  it("ignores a response for a target that is no longer the one being shown", async () => {
    const { settle } = gatedFetch();
    const { result, rerender } = render();

    rerender({
      slug: "anton",
      targetId: "feat-2",
      tickets: TICKETS,
      onClose: vi.fn(),
      onReworked: vi.fn(),
    });
    const later: ReviewReport = { rounds: [], findings: [{ ...REPORT.findings[0], note: "feat-2" }] };
    await settle("/api/projects/anton/epics/feat-2/review", reportRes(later));
    // The first target's read lands late — honouring it would show feat-1's findings under feat-2.
    await settle("/api/projects/anton/epics/feat-1/review", reportRes(REPORT));

    expect(result.current.findings).toEqual(later.findings);
  });
});

describe("useReworkForm — sending it back", () => {
  it("holds the form while the POST is in flight, then closes with the result", async () => {
    const { fetchMock, settle } = gatedFetch();
    const { result, onClose, onReworked } = render({ report: REPORT });

    act(() => result.current.patch({ summary: "not done", instructions: "Fix it." }));
    act(() => result.current.submit());

    await waitFor(() => expect(result.current.submitting).toBe(true));
    // The button is inert for the whole flight — a second submit would rework twice.
    expect(result.current.canSubmit).toBe(false);
    act(() => result.current.submit());
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await settle(
      "/api/projects/anton/epics/feat-1/rework",
      new Response(JSON.stringify({ result: RESULT }), { status: 200 }),
    );

    expect(result.current.submitting).toBe(false);
    expect(toast.success).toHaveBeenCalledWith("t-1 reopened with instructions", undefined);
    expect(onReworked).toHaveBeenCalledWith(RESULT);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("keeps the dialog open on failure so the typed instructions survive a retry", async () => {
    const { settle } = gatedFetch();
    const { result, onClose, onReworked } = render({ report: REPORT });

    act(() => result.current.patch({ summary: "not done", instructions: "Fix it." }));
    act(() => result.current.submit());
    await settle(
      "/api/projects/anton/epics/feat-1/rework",
      new Response(JSON.stringify({ error: "ticket already reopened" }), { status: 409 }),
    );

    expect(toast.error).toHaveBeenCalledWith("ticket already reopened");
    expect(onClose).not.toHaveBeenCalled();
    expect(onReworked).not.toHaveBeenCalled();
    expect(result.current.submitting).toBe(false);
    expect(result.current.draft.instructions).toBe("Fix it.");
    expect(result.current.canSubmit).toBe(true);
  });

  it("sends only the ticked findings, trimmed, and refuses an incomplete draft", () => {
    const { fetchMock } = gatedFetch();
    const { result } = render({ report: REPORT });

    act(() => result.current.submit());
    expect(fetchMock).not.toHaveBeenCalled();

    act(() => result.current.patch({ summary: "  not done  ", instructions: "  Fix it.  " }));
    act(() => result.current.toggleFinding("blocking\0src/a.ts:12\0no null guard"));
    expect(result.current.isSelected("blocking\0src/a.ts:12\0no null guard")).toBe(true);
    act(() => result.current.submit());

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/projects/anton/epics/feat-1/rework");
    expect(JSON.parse(init!.body as string)).toEqual({
      ticketId: "t-1",
      mode: "reopen",
      summary: "not done",
      instructions: "Fix it.",
      findings: REPORT.findings,
    });
  });
});
