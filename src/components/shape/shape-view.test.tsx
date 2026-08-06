// @vitest-environment jsdom
/**
 * The Add-work surface end to end (anton-bm4.2). The surface is now two panes with separate state —
 * the live pty and the draft epic — so these pin the seams between them: the seed handed over when
 * shaping starts, the gate that keeps an unshaped bead off the board, and the pty teardown that must
 * happen on the way out.
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

const SEED = "Reports are shareable outside the app\nevery view exports to something openable";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

function renderView() {
  render(<ShapeView slug="anton" projectName="anton" areas={["reports"]} />);
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

/** Drive the surface to a live session, resolving the shape POST with `sessionId`. */
async function startShaping(fetchMock: ReturnType<typeof vi.fn>, seed = SEED) {
  vi.stubGlobal("fetch", fetchMock);
  renderView();
  fireEvent.change(screen.getByRole("textbox", { name: "Describe an epic" }), {
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
    expect(screen.getByText("Lands as an open bead · unapproved")).toBeTruthy();
  });

  it("Start shaping posts the description, swaps in the terminal, and seeds the draft", async () => {
    const fetchMock = vi.fn().mockResolvedValue(json({ sessionId: "s-1" }));
    await startShaping(fetchMock);

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("/api/projects/anton/sessions/shape");
    expect(JSON.parse(init.body)).toEqual({ description: SEED });
    expect(screen.getByTestId("pty").textContent).toBe("s-1");

    // The seed's first line becomes the title, the whole seed the outcome — the founder refines
    // from something, not from an empty panel.
    expect((screen.getByRole("textbox", { name: /^Title/ }) as HTMLInputElement).value).toBe(
      "Reports are shareable outside the app",
    );
    expect((screen.getByRole("textbox", { name: /^Outcome/ }) as HTMLTextAreaElement).value).toBe(
      SEED,
    );
  });

  it("⌘↵ in the composer starts shaping, and an empty description can't", async () => {
    const fetchMock = vi.fn().mockResolvedValue(json({ sessionId: "s-1" }));
    vi.stubGlobal("fetch", fetchMock);
    renderView();

    const composer = screen.getByRole("textbox", { name: "Describe an epic" });
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

    fireEvent.change(screen.getByRole("textbox", { name: "Describe an epic" }), {
      target: { value: SEED },
    });
    fireEvent.click(screen.getByRole("button", { name: "Start shaping" }));

    await waitFor(() => expect(error).toHaveBeenCalledWith("no claude binary"));
    expect(screen.queryByTestId("pty")).toBeNull();
    expect(screen.getByRole("button", { name: "Start shaping" })).toBeTruthy();
  });

  it("kills the pty when the surface unmounts before the session id comes back", async () => {
    let landStart: (res: Response) => void = () => {};
    const fetchMock = vi
      .fn()
      .mockImplementationOnce(() => new Promise<Response>((resolve) => (landStart = resolve)))
      .mockResolvedValue(json({}));
    vi.stubGlobal("fetch", fetchMock);
    renderView();

    fireEvent.change(screen.getByRole("textbox", { name: "Describe an epic" }), {
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

  it("gates Send on the epic contract and names what is missing", async () => {
    await startShaping(vi.fn().mockResolvedValue(json({ sessionId: "s-1" })));

    // Title and outcome came from the seed; the rest of the contract has not been filled in.
    expect(sendButton().hasAttribute("disabled")).toBe(true);
    expect(screen.getByText("Needs success criteria, an area")).toBeTruthy();

    typeInto(/^Success criteria/, "- [ ] every report view exports");
    fireEvent.change(areaInput(), { target: { value: "two words" } });
    // A malformed area leaves no gap, so without its own line the panel would read as ready.
    expect(sendButton().hasAttribute("disabled")).toBe(true);
    expect(screen.getByText("Area must be a single label-safe word")).toBeTruthy();

    fireEvent.change(areaInput(), { target: { value: "reports" } });
    expect(sendButton().hasAttribute("disabled")).toBe(false);
    expect(screen.getByText("Lands as an open bead · unapproved")).toBeTruthy();
  });

  it("Send to backlog posts the trimmed draft, kills the pty, and leaves for the board", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(json({ sessionId: "s-1" }))
      .mockResolvedValueOnce(json({ id: "anton-1" }, 201))
      .mockResolvedValue(json({}));
    await startShaping(fetchMock, "Reports are shareable");

    typeInto(/^Success criteria/, "  - [ ] every report view exports  ");
    fireEvent.change(areaInput(), { target: { value: " reports " } });
    fireEvent.click(sendButton());

    await waitFor(() => expect(push).toHaveBeenCalledWith("/projects/anton"));
    const [backlogUrl, backlogInit] = fetchMock.mock.calls[1]!;
    expect(backlogUrl).toBe("/api/projects/anton/backlog");
    expect(JSON.parse(backlogInit.body)).toEqual({
      title: "Reports are shareable",
      goal: "Reports are shareable",
      successCriteria: "- [ ] every report view exports",
      area: "reports",
    });

    // The pty outlives this page unless the surface kills it on the way out.
    const [ptyUrl, ptyInit] = fetchMock.mock.calls[2]!;
    expect(ptyUrl).toBe("/api/projects/anton/sessions/s-1/pty");
    expect(ptyInit.method).toBe("DELETE");
    expect(ptyInit.keepalive).toBe(true);
    expect(success).toHaveBeenCalledWith("Draft landed in backlog — approve it when you're ready.");
  });

  it("keeps the draft on the surface when the create fails", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(json({ sessionId: "s-1" }))
      .mockResolvedValueOnce(json({ error: "bd write failed" }, 500));
    await startShaping(fetchMock, "Reports are shareable");

    typeInto(/^Success criteria/, "- [ ] every report view exports");
    fireEvent.change(areaInput(), { target: { value: "reports" } });
    fireEvent.click(sendButton());

    await waitFor(() => expect(error).toHaveBeenCalledWith("bd write failed"));
    expect(push).not.toHaveBeenCalled();
    // Send is live again — the founder can retry without retyping the draft.
    await waitFor(() => expect(sendButton().hasAttribute("disabled")).toBe(false));
    expect(areaInput().value).toBe("reports");
  });
});
