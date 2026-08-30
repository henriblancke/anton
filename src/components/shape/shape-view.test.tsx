// @vitest-environment jsdom
/**
 * The Add-work surface end to end (anton-bm4.2, anton-h1ds). The surface is two panes with separate
 * state — the live pty and the draft FEATURE — so these pin the seams between them: the seed handed
 * over when shaping starts, the gate that keeps an unshaped or parentless bead off the board, and
 * the pty teardown that must happen on the way out.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

import { ShapeView } from "@/components/shape/shape-view";

const push = vi.fn();
const success = vi.fn();
const error = vi.fn();

vi.mock("next/navigation", () => ({ useRouter: () => ({ push }) }));
vi.mock("sonner", () => ({
  toast: {
    success: (...a: unknown[]) => success(...a),
    error: (...a: unknown[]) => error(...a),
  },
}));
// xterm touches `window` on construction and is irrelevant here — the pane only has to swap to it.
vi.mock("@/components/pty/pty-terminal", () => ({
  PtyTerminal: ({ sessionId }: { sessionId: string }) => <div data-testid="pty">{sessionId}</div>,
}));

const SEED = "Export a report view to CSV\nevery view exports to something openable";

const EPICS = [
  { id: "anton-1", title: "Reports are shareable", area: "reports", looseTickets: 0 },
  { id: "anton-2", title: "Legacy billing", looseTickets: 2 },
];

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

function renderView() {
  render(<ShapeView slug="anton" projectName="anton" areas={["reports"]} epics={EPICS} />);
}

function sendButton() {
  return screen.getByRole("button", { name: "Send to backlog" });
}

function typeInto(name: RegExp, value: string) {
  fireEvent.change(screen.getByRole("textbox", { name }), { target: { value } });
}

/** Area is a datalist input, so it answers to combobox rather than textbox. */
function areaInput() {
  return screen.getByRole("combobox", { name: /^Area/ }) as HTMLInputElement;
}

/** The epic picker — the only combobox whose label opens with "Epic" (Area is the other one). */
function epicSelect() {
  return screen.getByRole("combobox", { name: /^Epic/ }) as HTMLSelectElement;
}

/** Fill the feature's sections the seed doesn't cover, so only the epic is left to choose. */
function fillFeature() {
  typeInto(/^Acceptance criteria/, "- [ ] every report view has a CSV export button");
  typeInto(/^Context/, "touches: src/app/reports");
  typeInto(/^Out of scope/, "- PDF export");
  typeInto(/^Verify/, "unit test on the serializer");
}

/** Drive the surface to a live session, resolving the shape POST with `sessionId`. */
async function startShaping(fetchMock: ReturnType<typeof vi.fn>, seed = SEED) {
  vi.stubGlobal("fetch", fetchMock);
  renderView();
  fireEvent.change(screen.getByRole("textbox", { name: "Describe the work" }), {
    target: { value: seed },
  });
  fireEvent.click(screen.getByRole("button", { name: "Start shaping" }));
  await screen.findByTestId("pty");
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  push.mockClear();
  success.mockClear();
  error.mockClear();
});

describe("ShapeView", () => {
  it("starts on the composer, with Send disabled and saying what it would land", () => {
    renderView();

    expect(screen.getByRole("button", { name: "Start shaping" }).hasAttribute("disabled")).toBe(
      true,
    );
    expect(screen.queryByTestId("pty")).toBeNull();
    expect(screen.getByText("not started")).toBeTruthy();
    expect(sendButton().hasAttribute("disabled")).toBe(true);
    expect(screen.getByText("Lands as an open feature · unapproved")).toBeTruthy();
  });

  it("Start shaping posts the description, swaps in the terminal, and seeds the draft", async () => {
    const fetchMock = vi.fn().mockResolvedValue(json({ sessionId: "s-1" }));
    await startShaping(fetchMock);

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("/api/projects/anton/sessions/shape");
    expect(JSON.parse(init.body)).toEqual({ description: SEED });
    expect(screen.getByTestId("pty").textContent).toBe("s-1");

    // The seed's first line becomes the feature's title, the whole seed its goal — the founder
    // refines from something, not from an empty panel.
    expect((screen.getByRole("textbox", { name: /^Title/ }) as HTMLInputElement).value).toBe(
      "Export a report view to CSV",
    );
    expect((screen.getByRole("textbox", { name: /^Goal/ }) as HTMLTextAreaElement).value).toBe(SEED);
  });

  it("⌘↵ in the composer starts shaping, and an empty description can't", async () => {
    const fetchMock = vi.fn().mockResolvedValue(json({ sessionId: "s-1" }));
    vi.stubGlobal("fetch", fetchMock);
    renderView();

    const composer = screen.getByRole("textbox", { name: "Describe the work" });
    fireEvent.keyDown(composer, { key: "Enter", metaKey: true });
    expect(fetchMock).not.toHaveBeenCalled();

    fireEvent.change(composer, { target: { value: SEED } });
    fireEvent.keyDown(composer, { key: "Enter", metaKey: true });
    await screen.findByTestId("pty");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("keeps the composer and toasts the route's message when the session won't start", async () => {
    const fetchMock = vi.fn().mockResolvedValue(json({ error: "no claude binary" }, 500));
    vi.stubGlobal("fetch", fetchMock);
    renderView();

    fireEvent.change(screen.getByRole("textbox", { name: "Describe the work" }), {
      target: { value: SEED },
    });
    fireEvent.click(screen.getByRole("button", { name: "Start shaping" }));

    await waitFor(() => expect(error).toHaveBeenCalledWith("no claude binary"));
    expect(screen.queryByTestId("pty")).toBeNull();
    expect(screen.getByRole("button", { name: "Start shaping" })).toBeTruthy();
  });

  it("keeps the composer when the route answers 200 without a session id", async () => {
    const fetchMock = vi.fn().mockResolvedValue(json({}));
    vi.stubGlobal("fetch", fetchMock);
    renderView();

    fireEvent.change(screen.getByRole("textbox", { name: "Describe the work" }), {
      target: { value: SEED },
    });
    fireEvent.click(screen.getByRole("button", { name: "Start shaping" }));

    // Without the guard the start silently "succeeds" with no id: no toast, no terminal, and the
    // founder is left staring at the composer wondering why nothing happened.
    await waitFor(() => expect(error).toHaveBeenCalledTimes(1));
    expect(screen.queryByTestId("pty")).toBeNull();
    expect(screen.getByRole("button", { name: "Start shaping" }).hasAttribute("disabled")).toBe(
      false,
    );
  });

  it("kills the pty when the surface unmounts before the session id comes back", async () => {
    let landStart: (res: Response) => void = () => {};
    const fetchMock = vi
      .fn()
      .mockImplementationOnce(() => new Promise<Response>((resolve) => (landStart = resolve)))
      .mockResolvedValue(json({}));
    vi.stubGlobal("fetch", fetchMock);
    renderView();

    fireEvent.change(screen.getByRole("textbox", { name: "Describe the work" }), {
      target: { value: SEED },
    });
    fireEvent.click(screen.getByRole("button", { name: "Start shaping" }));

    // The founder navigates away while the pty is still spawning: the session id arrives with
    // nothing left to hold it, so the surface has to tear the pty down on its way out.
    cleanup();
    landStart(json({ sessionId: "s-1" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    const [ptyUrl, ptyInit] = fetchMock.mock.calls[1]!;
    expect(ptyUrl).toBe("/api/projects/anton/sessions/s-1/pty");
    expect(ptyInit.method).toBe("DELETE");
    expect(error).not.toHaveBeenCalled();
  });

  it("gates Send on the feature contract AND its epic, naming what is missing", async () => {
    await startShaping(vi.fn().mockResolvedValue(json({ sessionId: "s-1" })));

    // Title and goal came from the seed; the rest of the contract has not been filled in.
    expect(sendButton().hasAttribute("disabled")).toBe(true);
    expect(screen.getByText("Needs an epic, acceptance criteria, context + 2 more")).toBeTruthy();

    fillFeature();
    // Everything but the epic — the gap this ticket exists to close.
    expect(sendButton().hasAttribute("disabled")).toBe(true);
    expect(screen.getByText("Needs an epic")).toBeTruthy();

    fireEvent.change(epicSelect(), { target: { value: "anton-1" } });
    expect(sendButton().hasAttribute("disabled")).toBe(false);
    expect(screen.getByText("Lands as an open feature · unapproved")).toBeTruthy();
  });

  it("warns when the chosen epic still carries loose tickets it would strand", async () => {
    await startShaping(vi.fn().mockResolvedValue(json({ sessionId: "s-1" })));

    fireEvent.change(epicSelect(), { target: { value: "anton-1" } });
    expect(screen.queryByText(/stop being runnable/)).toBeNull();

    fireEvent.change(epicSelect(), { target: { value: "anton-2" } });
    expect(screen.getByText(/2 tickets hang directly off this epic/)).toBeTruthy();
  });

  it("asks for the epic's own contract when the founder creates one, and sends it along", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(json({ sessionId: "s-1" }))
      .mockResolvedValueOnce(json({ id: "anton-9", epicId: "anton-8" }, 201))
      .mockResolvedValue(json({}));
    await startShaping(fetchMock, "Export a report view to CSV");

    fillFeature();
    fireEvent.change(epicSelect(), { target: { value: "__new__" } });
    expect(screen.getByText("Needs an epic title, an epic outcome, epic success criteria + 1 more"))
      .toBeTruthy();

    typeInto(/^Epic title/, "Reports are shareable outside the app");
    typeInto(/^Epic outcome/, "Every report leaves the app in a format a customer can open.");
    typeInto(/^Epic success criteria/, "- [ ] every report view exports");
    // A malformed area leaves no gap, so without its own line the panel would read as ready.
    fireEvent.change(areaInput(), { target: { value: "two words" } });
    expect(sendButton().hasAttribute("disabled")).toBe(true);
    expect(screen.getByText("Area must be a single label-safe word")).toBeTruthy();

    fireEvent.change(areaInput(), { target: { value: " reports " } });
    fireEvent.click(sendButton());

    await waitFor(() => expect(push).toHaveBeenCalledWith("/projects/anton"));
    const [, backlogInit] = fetchMock.mock.calls[1]!;
    expect(JSON.parse(backlogInit.body).epic).toEqual({
      kind: "new",
      epic: {
        title: "Reports are shareable outside the app",
        goal: "Every report leaves the app in a format a customer can open.",
        successCriteria: "- [ ] every report view exports",
        area: "reports",
      },
    });
  });

  it("Send to backlog posts the trimmed feature under its epic, kills the pty, and leaves", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(json({ sessionId: "s-1" }))
      .mockResolvedValueOnce(json({ id: "anton-9", epicId: "anton-1" }, 201))
      .mockResolvedValue(json({}));
    await startShaping(fetchMock, "Export a report view to CSV");

    typeInto(/^Acceptance criteria/, "  - [ ] every report view has a CSV export button  ");
    typeInto(/^Context/, "touches: src/app/reports");
    typeInto(/^Out of scope/, "- PDF export");
    typeInto(/^Verify/, "unit test on the serializer");
    fireEvent.change(epicSelect(), { target: { value: "anton-1" } });
    fireEvent.click(sendButton());

    await waitFor(() => expect(push).toHaveBeenCalledWith("/projects/anton"));
    const [backlogUrl, backlogInit] = fetchMock.mock.calls[1]!;
    expect(backlogUrl).toBe("/api/projects/anton/backlog");
    expect(JSON.parse(backlogInit.body)).toEqual({
      feature: {
        title: "Export a report view to CSV",
        goal: "Export a report view to CSV",
        acceptance: "- [ ] every report view has a CSV export button",
        context: "touches: src/app/reports",
        outOfScope: "- PDF export",
        verify: "unit test on the serializer",
      },
      epic: { kind: "existing", id: "anton-1" },
    });

    // The pty outlives this page unless the surface kills it on the way out.
    const [ptyUrl, ptyInit] = fetchMock.mock.calls[2]!;
    expect(ptyUrl).toBe("/api/projects/anton/sessions/s-1/pty");
    expect(ptyInit.method).toBe("DELETE");
    expect(ptyInit.keepalive).toBe(true);
    expect(success).toHaveBeenCalledWith(
      "Feature landed in backlog — approve it when you're ready.",
    );
  });

  it("keeps the draft on the surface when the create fails", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(json({ sessionId: "s-1" }))
      .mockResolvedValueOnce(json({ error: "epic anton-1 is not on the board" }, 400));
    await startShaping(fetchMock, "Export a report view to CSV");

    fillFeature();
    fireEvent.change(epicSelect(), { target: { value: "anton-1" } });
    fireEvent.click(sendButton());

    await waitFor(() => expect(error).toHaveBeenCalledWith("epic anton-1 is not on the board"));
    expect(push).not.toHaveBeenCalled();
    // Send is live again — the founder can retry (or pick another epic) without retyping the draft.
    await waitFor(() => expect(sendButton().hasAttribute("disabled")).toBe(false));
    expect(epicSelect().value).toBe("anton-1");
  });
});
