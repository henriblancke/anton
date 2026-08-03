// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

import { ReworkDialog } from "@/components/epic/rework-dialog";
import type { ReviewReport, Ticket } from "@/lib/types";

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const ticket = (over: Partial<Ticket> & { id: string }): Ticket =>
  ({
    title: over.id,
    status: "closed",
    stage: "done",
    assignee: null,
    createdAt: "",
    createdBy: null,
    deferred: false,
    abandoned: false,
    ...over,
  }) as Ticket;

const TICKETS = [
  ticket({ id: "t-1", title: "First ticket" }),
  ticket({ id: "t-2", title: "Second ticket" }),
];

const REPORT: ReviewReport = {
  rounds: [{ round: 1, score: 4, blocking: 1, advisory: 1, verdict: "unresolved" }],
  score: 4,
  findings: [
    { severity: "blocking", location: "src/a.ts:12", note: "no null guard" },
    { severity: "advisory", location: "(general)", note: "naming drifts" },
  ],
};

/** GET the report, then POST the rework — the dialog's only two calls, in that order. */
function stubFetch(postBody: unknown = { result: { mode: "reopen", ticketId: "t-1", reworkedId: "t-1", applied: true } }) {
  const fetchMock = vi.fn(async (_url: string, init?: RequestInit) =>
    init?.method === "POST"
      ? new Response(JSON.stringify(postBody), { status: 200 })
      : new Response(JSON.stringify({ report: REPORT }), { status: 200 }),
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function open(props: Partial<React.ComponentProps<typeof ReworkDialog>> = {}) {
  return render(
    <ReworkDialog
      slug="anton"
      targetId="feat-1"
      tickets={TICKETS}
      open
      onClose={vi.fn()}
      {...props}
    />,
  );
}

const fill = (summary: string, instructions: string) => {
  fireEvent.change(screen.getByLabelText(/Reason \(one line\)|Follow-up title/), {
    target: { value: summary },
  });
  fireEvent.change(screen.getByLabelText("Fix instructions"), { target: { value: instructions } });
};

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("ReworkDialog", () => {
  it("POSTs a reopen with the ticket, the reason and the ticked findings", async () => {
    const fetchMock = stubFetch();
    const onReworked = vi.fn();
    open({ onReworked });

    await screen.findByText("no null guard");
    fireEvent.change(screen.getByLabelText("Ticket"), { target: { value: "t-2" } });
    fill("  not actually done  ", "  Add the missing test.  ");
    fireEvent.click(screen.getByRole("checkbox", { name: /no null guard/ }));
    fireEvent.click(screen.getByRole("button", { name: "Send back" }));

    await waitFor(() => expect(onReworked).toHaveBeenCalled());
    const post = fetchMock.mock.calls.find(([, init]) => (init as RequestInit)?.method === "POST")!;
    expect(post[0]).toBe("/api/projects/anton/epics/feat-1/rework");
    expect(JSON.parse((post[1] as RequestInit).body as string)).toEqual({
      ticketId: "t-2",
      mode: "reopen",
      summary: "not actually done",
      instructions: "Add the missing test.",
      // Only the ticked one — the founder chooses which findings become instructions.
      findings: [{ severity: "blocking", location: "src/a.ts:12", note: "no null guard" }],
    });
  });

  it("sends the follow-up mode when the founder picks acceptance-met", async () => {
    const fetchMock = stubFetch({
      result: { mode: "follow-up", ticketId: "t-1", reworkedId: "new-1", applied: true },
    });
    open();

    await screen.findByText("no null guard");
    fireEvent.click(screen.getByRole("radio", { name: /Acceptance met/ }));
    fill("Cap the backoff", "Bound it at 30s.");
    fireEvent.click(screen.getByRole("button", { name: "Send back" }));

    await waitFor(() =>
      expect(fetchMock.mock.calls.some(([, init]) => (init as RequestInit)?.method === "POST")).toBe(true),
    );
    const post = fetchMock.mock.calls.find(([, init]) => (init as RequestInit)?.method === "POST")!;
    expect(JSON.parse((post[1] as RequestInit).body as string).mode).toBe("follow-up");
  });

  it("keeps Send back inert until there is both a reason and an instruction", async () => {
    const fetchMock = stubFetch();
    open();
    await screen.findByText("no null guard");

    const submit = screen.getByRole("button", { name: "Send back" });
    expect(submit.hasAttribute("disabled")).toBe(true);
    fill("a reason", "");
    expect(submit.hasAttribute("disabled")).toBe(true);
    fireEvent.click(submit);
    expect(fetchMock.mock.calls.filter(([, init]) => (init as RequestInit)?.method === "POST")).toHaveLength(0);
  });

  it("double-click sends ONE request — the button locks while the first is in flight", async () => {
    let resolvePost: (r: Response) => void = () => {};
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) =>
      init?.method === "POST"
        ? new Promise<Response>((resolve) => {
            resolvePost = resolve;
          })
        : new Response(JSON.stringify({ report: REPORT }), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    open();
    await screen.findByText("no null guard");

    fill("not done", "Fix it.");
    const submit = screen.getByRole("button", { name: "Send back" });
    fireEvent.click(submit);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Sending back…" }).hasAttribute("disabled")).toBe(true),
    );
    fireEvent.click(screen.getByRole("button", { name: "Sending back…" }));

    expect(fetchMock.mock.calls.filter(([, init]) => (init as RequestInit)?.method === "POST")).toHaveLength(1);
    resolvePost(
      new Response(JSON.stringify({ result: { mode: "reopen", ticketId: "t-1", reworkedId: "t-1", applied: true } })),
    );
  });

  it("stays usable when the report can't be read — the instructions are still the founder's to write", async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) =>
      init?.method === "POST"
        ? new Response(JSON.stringify({ result: { mode: "reopen", ticketId: "t-1", reworkedId: "t-1", applied: true } }))
        : new Response("nope", { status: 500 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    open();

    await screen.findByText(/Couldn't load the review report/);
    fill("not done", "Fix it.");
    expect(screen.getByRole("button", { name: "Send back" }).hasAttribute("disabled")).toBe(false);
  });

  it("says nothing was written when the server reports a double-submit", async () => {
    const { toast } = await import("sonner");
    stubFetch({ result: { mode: "reopen", ticketId: "t-1", reworkedId: "t-1", applied: false } });
    open();
    await screen.findByText("no null guard");

    fill("not done", "Fix it.");
    fireEvent.click(screen.getByRole("button", { name: "Send back" }));
    await waitFor(() =>
      expect(toast.success).toHaveBeenCalledWith(expect.stringContaining("Already sent back"), undefined),
    );
  });
});
