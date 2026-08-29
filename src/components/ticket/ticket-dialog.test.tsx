// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

import { TicketDialog } from "@/components/ticket/ticket-dialog";
import type { TicketDetail } from "@/lib/types";

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
    createdAt: new Date().toISOString(),
    createdBy: null,
    approved: false,
    deferred: false,
    abandoned: false,
    notes: [],
    ...over,
  }) as TicketDetail;

/** Routes every call the dialog can make; the ticket GET/PATCH answers with `current`. */
function stubFetch(
  current: TicketDetail,
  over: { patched?: TicketDetail; getStatus?: number; holdDelete?: Promise<void> } = {},
) {
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    if (url === "/api/operator") return json({ operator: "hb" });
    if (url.endsWith("/approve")) return json({ ok: true });
    if (method === "DELETE") {
      await over.holdDelete;
      return json({ ok: true });
    }
    if (method === "PATCH") return json({ detail: over.patched ?? current });
    if (over.getStatus) return json({ error: "nope" }, over.getStatus);
    return json({ detail: current });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

/** The dialog's fields are all labelled, so every read goes through the accessible name. */
const field = (label: string) => screen.findByLabelText(label);

function open(props: Partial<React.ComponentProps<typeof TicketDialog>> = {}) {
  return render(
    <TicketDialog slug="anton" ticketId="bd-1" open onClose={vi.fn()} {...props} />,
  );
}

/** The one call that carries a body — the dialog's whole save contract. */
const patchBody = (fetchMock: ReturnType<typeof stubFetch>) => {
  const call = fetchMock.mock.calls.find(([, init]) => init?.method === "PATCH")!;
  return JSON.parse(String(call[1]!.body)) as Record<string, unknown>;
};

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("TicketDialog", () => {
  it("renders the loaded ticket's contract fields", async () => {
    stubFetch(detail());
    open();

    expect(await field("Title")).toHaveProperty("value", "Do the thing");
    expect(await field("Goal")).toHaveProperty("value", "Ship it");
    expect(await field("Acceptance")).toHaveProperty("value", "- [ ] it ships");
    // The rest of the description, with the contract sections stripped out.
    expect(await field("Description")).toHaveProperty("value", "## Context\n\nbackground");
    // Collapsed Details still summarises the label fields it hides.
    expect(screen.getByText(/Open · P2 · nextjs · risk:low · size:M/)).toBeTruthy();
  });

  it("keeps Save and Reset dead until the draft actually changes", async () => {
    stubFetch(detail());
    open();

    const save = await screen.findByRole("button", { name: "Save" });
    expect(save.hasAttribute("disabled")).toBe(true);
    expect(screen.getByRole("button", { name: "Reset" }).hasAttribute("disabled")).toBe(true);

    fireEvent.change(screen.getByLabelText("Title"), { target: { value: "Renamed" } });
    expect(save.hasAttribute("disabled")).toBe(false);
  });

  it("PATCHes only the fields that changed and reports the save", async () => {
    const fetchMock = stubFetch(detail(), { patched: detail({ title: "Renamed" }) });
    const onSaved = vi.fn();
    open({ onSaved });

    fireEvent.change(await field("Title"), { target: { value: "Renamed" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    expect(patchBody(fetchMock)).toEqual({ title: "Renamed" });
    // The saved detail becomes the new baseline, so there is nothing left to save.
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Save" }).hasAttribute("disabled")).toBe(true),
    );
  });

  it("rewrites the whole contract when a section is edited", async () => {
    const fetchMock = stubFetch(detail());
    open();

    fireEvent.change(await field("Acceptance"), {
      target: { value: "- [ ] it really ships" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(patchBody(fetchMock).acceptance).toBe("- [ ] it really ships"));
    expect(patchBody(fetchMock).description).toContain("## Acceptance Criteria");
  });

  it("throws unsaved edits away on Reset", async () => {
    stubFetch(detail());
    open();

    const title = await field("Title");
    fireEvent.change(title, { target: { value: "Renamed" } });
    fireEvent.click(screen.getByRole("button", { name: "Reset" }));

    expect(title).toHaveProperty("value", "Do the thing");
  });

  it("approves a standalone task as its run trigger", async () => {
    const fetchMock = stubFetch(detail());
    open();

    fireEvent.click(await screen.findByRole("button", { name: "Approve & run" }));

    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some(([url]) => url === "/api/projects/anton/epics/bd-1/approve"),
      ).toBe(true),
    );
  });

  it("offers Force run once the target is approved", async () => {
    stubFetch(detail({ approved: true }));
    open();

    expect(await screen.findByRole("button", { name: "Force run" })).toBeTruthy();
  });

  it("hides the run affordance for a child ticket, a done target and a snoozed one", async () => {
    for (const over of [{ epicId: "ep-1" }, { stage: "done" as const }, { deferred: true }]) {
      stubFetch(detail(over));
      open();

      await field("Title");
      expect(screen.queryByRole("button", { name: /Approve & run|Force run/ })).toBeNull();
      cleanup();
    }
  });

  it("shows a blocked run instead of failing the approve on a contract gap", async () => {
    stubFetch(
      detail({
        contract: {
          blocking: [{ severity: "blocking", section: "Acceptance", message: "no acceptance" }],
          advisory: [],
        } as TicketDetail["contract"],
      }),
    );
    open();

    const blocked = await screen.findByRole("button", { name: /Approve & run: Can't approve/ });
    expect(blocked.hasAttribute("disabled")).toBe(true);
  });

  it("shows a snoozed ticket's status read-only", async () => {
    stubFetch(detail({ deferred: true }));
    open();

    const status = (await field("Status")) as HTMLSelectElement;
    expect(status.value).toBe("deferred");
    expect(status.disabled).toBe(true);
  });

  it("deletes the bead behind the inline confirm", async () => {
    const fetchMock = stubFetch(detail());
    const onDeleted = vi.fn();
    const onClose = vi.fn();
    open({ onDeleted, onClose });

    fireEvent.click(await screen.findByRole("button", { name: "Delete ticket" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm delete" }));

    await waitFor(() => expect(onDeleted).toHaveBeenCalledWith("bd-1"));
    expect(onClose).toHaveBeenCalled();
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === "DELETE")).toBe(true);
  });

  it("shows the confirm's pending label while the delete is in flight", async () => {
    // The dialog must hand the confirm button a promise to await, or its "Deleting…" state never shows.
    let release = () => {};
    const holdDelete = new Promise<void>((resolve) => {
      release = resolve;
    });
    stubFetch(detail(), { holdDelete });
    const onDeleted = vi.fn();
    open({ onDeleted });

    fireEvent.click(await screen.findByRole("button", { name: "Delete ticket" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm delete" }));

    expect(await screen.findByRole("button", { name: "Deleting…" })).toBeTruthy();
    // Still pending several ticks later: a fire-and-forget delete would have settled by now.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(screen.queryByRole("button", { name: "Deleting…" })).not.toBeNull();
    release();
    await waitFor(() => expect(onDeleted).toHaveBeenCalledWith("bd-1"));
  });

  it("offers a retry when the read fails", async () => {
    const fetchMock = stubFetch(detail(), { getStatus: 500 });
    open();

    expect(await screen.findByText("Failed to load ticket (500)")).toBeTruthy();
    const readsBefore = fetchMock.mock.calls.filter(([, init]) => (init?.method ?? "GET") === "GET").length;

    fireEvent.click(screen.getByRole("button", { name: "Try again" }));

    await waitFor(() =>
      expect(
        fetchMock.mock.calls.filter(([, init]) => (init?.method ?? "GET") === "GET").length,
      ).toBeGreaterThan(readsBefore),
    );
  });
});
