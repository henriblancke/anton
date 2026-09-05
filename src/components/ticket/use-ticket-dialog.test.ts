// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { toast } from "sonner";

import { useTicketDialog } from "@/components/ticket/use-ticket-dialog";
import type { TicketDetail, TicketNote } from "@/lib/types";

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() },
}));

const detail = (over: Partial<TicketDetail> = {}): TicketDetail =>
  ({
    id: "bd-1",
    title: "Do the thing",
    status: "open",
    stage: "backlog",
    type: "task",
    priority: 2,
    agent: "nextjs",
    risk: "low",
    size: "M",
    goal: "Ship it",
    acceptance: "- [ ] it ships",
    description: "## Goal\n\nShip it\n\n## Context\n\nbackground",
    assignee: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    createdBy: null,
    approved: false,
    deferred: false,
    abandoned: false,
    notes: [],
    ...over,
  }) as TicketDetail;

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

const fetchMock = vi.fn();

/** Answers the ticket GET/PATCH with `current` unless a route override says otherwise. */
function stubFetch(
  current: TicketDetail,
  over: { patched?: TicketDetail; getStatus?: number; patchStatus?: number } = {},
) {
  fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    if (String(url).endsWith("/approve")) return json({ ok: true });
    if (method === "DELETE") return json({ ok: true });
    if (method === "PATCH") {
      if (over.patchStatus) return json({ error: "nope" }, over.patchStatus);
      return json({ detail: over.patched ?? current });
    }
    if (over.getStatus) return json({ error: "nope" }, over.getStatus);
    return json({ detail: current });
  });
  return fetchMock;
}

/** Mounts the hook alone — no dialog markup, so only the model's own transitions are under test. */
function mount(options: Partial<Parameters<typeof useTicketDialog>[0]> = {}) {
  return renderHook(() =>
    useTicketDialog({ slug: "anton", ticketId: "bd-1", onClose: vi.fn(), ...options }),
  );
}

/** The one call that carries a body — the hook's whole save contract. */
const patchBody = () => {
  const call = fetchMock.mock.calls.find(([, init]) => init?.method === "PATCH")!;
  return JSON.parse(String(call[1]!.body)) as Record<string, unknown>;
};

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("the ticket read", () => {
  it("seeds the draft from the fetched detail, with nothing to save yet", async () => {
    stubFetch(detail());
    const { result } = mount();

    await waitFor(() => expect(result.current.loaded).not.toBeNull());
    expect(result.current.loaded!.detail.id).toBe("bd-1");
    expect(result.current.loaded!.draft).toMatchObject({
      title: "Do the thing",
      status: "open",
      priority: 2,
      agent: "nextjs",
      risk: "low",
      size: "M",
      goal: "Ship it",
      acceptance: "- [ ] it ships",
      // The contract sections are lifted out of the description; only "the rest" stays in body.
      body: "## Context\n\nbackground",
    });
    expect(result.current.changed).toBe(false);
    expect(result.current.error).toBeNull();
  });

  it("reports the failed read and clears it on retry", async () => {
    stubFetch(detail(), { getStatus: 500 });
    const { result } = mount();

    await waitFor(() => expect(result.current.error).toBe("Failed to load ticket (500)"));
    expect(result.current.loaded).toBeNull();

    stubFetch(detail());
    act(() => result.current.retry());

    await waitFor(() => expect(result.current.loaded).not.toBeNull());
    expect(result.current.error).toBeNull();
  });
});

describe("draft edits", () => {
  it("marks the draft dirty only for a field the PATCH would carry", async () => {
    stubFetch(detail());
    const { result } = mount();
    await waitFor(() => expect(result.current.loaded).not.toBeNull());

    // Clearing a label is not a change — the API can set a label but not clear one.
    act(() => result.current.set("agent", ""));
    expect(result.current.changed).toBe(false);

    act(() => result.current.set("title", "Do it better"));
    expect(result.current.changed).toBe(true);
  });

  it("throws the edits away on reset, back to the loaded detail", async () => {
    stubFetch(detail());
    const { result } = mount();
    await waitFor(() => expect(result.current.loaded).not.toBeNull());

    act(() => result.current.set("title", "Do it better"));
    act(() => result.current.set("goal", "Ship it twice"));
    expect(result.current.changed).toBe(true);

    act(() => result.current.reset());
    expect(result.current.loaded!.draft.title).toBe("Do the thing");
    expect(result.current.loaded!.draft.goal).toBe("Ship it");
    expect(result.current.changed).toBe(false);
  });
});

describe("save", () => {
  it("PATCHes only the changed fields and adopts the server's answer", async () => {
    const saved = detail({ title: "Do it better" });
    stubFetch(detail(), { patched: saved });
    const onSaved = vi.fn();
    const { result } = mount({ onSaved });
    await waitFor(() => expect(result.current.loaded).not.toBeNull());

    act(() => result.current.set("title", "Do it better"));
    await act(async () => {
      await result.current.save();
    });

    expect(patchBody()).toEqual({ title: "Do it better" });
    expect(onSaved).toHaveBeenCalledWith(saved);
    // The fresh truth reseeds the draft, so there is nothing left to save.
    expect(result.current.loaded!.detail.title).toBe("Do it better");
    expect(result.current.changed).toBe(false);
    expect(result.current.saving).toBe(false);
    expect(toast.success).toHaveBeenCalledWith("Ticket updated");
  });

  it("sends nothing when the draft is clean", async () => {
    stubFetch(detail());
    const { result } = mount();
    await waitFor(() => expect(result.current.loaded).not.toBeNull());

    await act(async () => {
      await result.current.save();
    });

    expect(fetchMock.mock.calls.some(([, init]) => init?.method === "PATCH")).toBe(false);
  });

  it("keeps the edits and surfaces the server's error when the save fails", async () => {
    stubFetch(detail(), { patchStatus: 500 });
    const onSaved = vi.fn();
    const { result } = mount({ onSaved });
    await waitFor(() => expect(result.current.loaded).not.toBeNull());

    act(() => result.current.set("title", "Do it better"));
    await act(async () => {
      await result.current.save();
    });

    expect(toast.error).toHaveBeenCalledWith("nope");
    expect(onSaved).not.toHaveBeenCalled();
    expect(result.current.loaded!.draft.title).toBe("Do it better");
    expect(result.current.changed).toBe(true);
    expect(result.current.saving).toBe(false);
  });
});

describe("delete", () => {
  it("closes the dialog and tells the parent once the ticket is gone", async () => {
    stubFetch(detail());
    const onDeleted = vi.fn();
    const onClose = vi.fn();
    const { result } = mount({ onDeleted, onClose });
    await waitFor(() => expect(result.current.loaded).not.toBeNull());

    await act(async () => {
      await result.current.remove();
    });

    const call = fetchMock.mock.calls.find(([, init]) => init?.method === "DELETE")!;
    expect(call[0]).toBe("/api/projects/anton/tickets/bd-1");
    expect(onDeleted).toHaveBeenCalledWith("bd-1");
    expect(onClose).toHaveBeenCalled();
  });

  it("keeps the dialog open when the delete fails", async () => {
    stubFetch(detail());
    const onDeleted = vi.fn();
    const onClose = vi.fn();
    const { result } = mount({ onDeleted, onClose });
    await waitFor(() => expect(result.current.loaded).not.toBeNull());

    fetchMock.mockImplementation(async () => json({ error: "still referenced" }, 409));
    await act(async () => {
      await result.current.remove();
    });

    expect(toast.error).toHaveBeenCalledWith("still referenced");
    expect(onDeleted).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });
});

describe("state moved elsewhere in the dialog", () => {
  it("keeps unsaved edits when snooze/abandon hands back a fresh detail", async () => {
    stubFetch(detail());
    const onSaved = vi.fn();
    const { result } = mount({ onSaved });
    await waitFor(() => expect(result.current.loaded).not.toBeNull());

    act(() => result.current.set("title", "Do it better"));
    const snoozed = detail({ deferred: true, status: "deferred" });
    act(() => result.current.onStateChanged(snoozed));

    expect(result.current.loaded!.detail.deferred).toBe(true);
    expect(result.current.loaded!.draft.title).toBe("Do it better");
    // Status follows the new truth so the Status select doesn't offer to patch it back.
    expect(result.current.loaded!.draft.status).toBe("deferred");
    expect(onSaved).toHaveBeenCalledWith(snoozed);
  });

  it("merges appended notes without touching the draft", async () => {
    stubFetch(detail());
    const { result } = mount();
    await waitFor(() => expect(result.current.loaded).not.toBeNull());

    act(() => result.current.set("title", "Do it better"));
    const notes = [{ id: "n-1", body: "steering" }] as unknown as TicketNote[];
    act(() => result.current.onNotesAppended(notes));

    expect(result.current.loaded!.detail.notes).toEqual(notes);
    expect(result.current.loaded!.draft.title).toBe("Do it better");
  });

  it("refetches after a PR link, and swallows a failed reload", async () => {
    stubFetch(detail());
    const onSaved = vi.fn();
    const { result } = mount({ onSaved });
    await waitFor(() => expect(result.current.loaded).not.toBeNull());

    const linked = detail({ prRef: "gh-44", stage: "in-review" });
    stubFetch(linked);
    await act(async () => {
      await result.current.reloadAfterLink();
    });
    expect(result.current.loaded!.detail.prRef).toBe("gh-44");
    expect(onSaved).toHaveBeenCalledWith(linked);

    // The link already landed server-side, so a failed read leaves the last good detail alone.
    stubFetch(linked, { getStatus: 500 });
    await act(async () => {
      await result.current.reloadAfterLink();
    });
    expect(result.current.loaded!.detail.prRef).toBe("gh-44");
    expect(result.current.error).toBeNull();
  });
});

describe("approve & run", () => {
  it("flips to approved optimistically and names the run in the toast", async () => {
    stubFetch(detail());
    const { result } = mount();
    await waitFor(() => expect(result.current.loaded).not.toBeNull());
    expect(result.current.approved).toBe(false);

    await act(async () => {
      await result.current.run();
    });

    const call = fetchMock.mock.calls.find(([url]) => String(url).endsWith("/approve"))!;
    expect(call[0]).toBe("/api/projects/anton/epics/bd-1/approve");
    expect(call[1]!.method).toBe("POST");
    expect(result.current.approved).toBe(true);
    expect(result.current.running).toBe(false);
    expect(toast.success).toHaveBeenCalledWith('Approved & running "Do the thing"');
  });

  it("reverts the optimistic approval when the approve route rejects it", async () => {
    stubFetch(detail());
    const { result } = mount();
    await waitFor(() => expect(result.current.loaded).not.toBeNull());

    fetchMock.mockImplementation(async (url: string) =>
      String(url).endsWith("/approve")
        ? json({ error: "missing an acceptance section" }, 422)
        : json({ detail: detail() }),
    );
    await act(async () => {
      await result.current.run();
    });

    expect(result.current.approved).toBe(false);
    expect(result.current.running).toBe(false);
    expect(toast.error).toHaveBeenCalledWith("missing an acceptance section");
  });

  it("reads an already-approved ticket as a re-run", async () => {
    stubFetch(detail({ approved: true }));
    const { result } = mount();
    await waitFor(() => expect(result.current.loaded).not.toBeNull());
    expect(result.current.approved).toBe(true);

    await act(async () => {
      await result.current.run();
    });

    expect(toast.success).toHaveBeenCalledWith('Re-running "Do the thing"');
  });
});
