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
import { PickDecisionProvider, PlanGenerationProvider } from "@/components/board/pick-decision";

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

  it("names the plan generation on screen, so the accept answers the pick the operator saw", async () => {
    // A later pass can re-pick the same bead between the render and the click. Without the
    // generation the route resolves the pick from whatever plan is current, and records an accept
    // for a decision nobody was shown (PR #212 review).
    const fetchMock = stubFetch({ jobId: "job-1" });
    render(
      <PickDecisionProvider planId="plan-a">
        <ReleaseAction slug="anton" beadId="anton-a" title="Resumable crawl checkpoints" />
      </PickDecisionProvider>,
    );

    release();

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(fetchMock.mock.calls[0]?.[1]).toEqual(
      expect.objectContaining({
        body: JSON.stringify({ release: true, immediate: true, planId: "plan-a" }),
      }),
    );
  });

  it("names the generation the SURFACE carries when the pick has no row of its own", async () => {
    // The epic swimlanes render picks in their epic's Backlog slice, with no lane row to hold the
    // generation. Without the surface's own the accept would be resolved from whatever plan is
    // current by then — a decision the operator never saw (PR #212 review).
    const fetchMock = stubFetch({ jobId: "job-1" });
    render(
      <PlanGenerationProvider planId="plan-a">
        <ReleaseAction slug="anton" beadId="anton-a" title="Resumable crawl checkpoints" />
      </PlanGenerationProvider>,
    );

    release();

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(fetchMock.mock.calls[0]?.[1]).toEqual(
      expect.objectContaining({
        body: JSON.stringify({ release: true, immediate: true, planId: "plan-a" }),
      }),
    );
  });

  it("keeps the pick's OWN generation when it has one, over the surface's", async () => {
    // A lane row names the decision it drew; a surface further out may already be showing a newer
    // plan. The nearer answer is the one the operator looked at.
    const fetchMock = stubFetch({ jobId: "job-1" });
    render(
      <PlanGenerationProvider planId="plan-b">
        <PickDecisionProvider planId="plan-a">
          <ReleaseAction slug="anton" beadId="anton-a" title="Resumable crawl checkpoints" />
        </PickDecisionProvider>
      </PlanGenerationProvider>,
    );

    release();

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(fetchMock.mock.calls[0]?.[1]).toEqual(
      expect.objectContaining({
        body: JSON.stringify({ release: true, immediate: true, planId: "plan-a" }),
      }),
    );
  });

  it("names none from a card that came from no plan, leaving the route its own resolution", async () => {
    const fetchMock = stubFetch({ jobId: "job-1" });
    mount();

    release();

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(fetchMock.mock.calls[0]?.[1]).toEqual(
      expect.objectContaining({ body: JSON.stringify({ release: true, immediate: true }) }),
    );
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

    settle(new Response(JSON.stringify({ jobId: "job-1" }), { status: 200 }));
    await waitFor(() => expect(success).toHaveBeenCalled());
  });
});

describe("a release the approve route could not start", () => {
  /**
   * Approve enqueues best-effort: it answers 200 with `jobId` omitted rather than failing an
   * approval it has already written. Nothing is running, so nothing may say so.
   */
  it("refuses to report a run the response carries no job for", async () => {
    stubFetch({ epic: { id: "anton-a", approved: true } });
    const onReleased = vi.fn();
    const onApprovedWithoutRun = vi.fn();
    mount({ onReleased, onApprovedWithoutRun });

    release();

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("no run started");
    expect(error).toHaveBeenCalledWith(expect.stringContaining("no run started"));
    // The card must not lock its affordances behind a run that does not exist…
    expect(onReleased).not.toHaveBeenCalled();
    expect(success).not.toHaveBeenCalled();
    // …but the approval itself landed, so the surface is behind on the card either way.
    await waitFor(() => expect(refresh).toHaveBeenCalled());
    expect(screen.getByRole("button", { name: /release/i }).hasAttribute("disabled")).toBe(false);
    // …and the surface is told to KEEP this control through that re-read: it hides the run on
    // `approved`, and the copy above just sent the operator back to press it (PR #212 review).
    expect(onApprovedWithoutRun).toHaveBeenCalled();
  });

  it("says so too when the 200 body cannot be read at all", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("<html>gateway</html>", { status: 200 })),
    );
    mount();

    release();

    expect((await screen.findByRole("alert")).textContent).toContain("no run started");
    expect(success).not.toHaveBeenCalled();
  });
});

describe("a release a run on another machine already covers", () => {
  /**
   * The enqueue withholds a job id ON PURPOSE when the shared board shows a live run elsewhere
   * (anton-jz1) — nothing was started here because nothing needed to be. Reading that as a failed
   * enqueue would push the operator to release again, into a second concurrent run.
   */
  it("reports it as running, not as a release to retry", async () => {
    stubFetch({ run: "elsewhere" });
    const onReleased = vi.fn();
    const onApprovedWithoutRun = vi.fn();
    mount({ onReleased, onApprovedWithoutRun });

    release();

    await waitFor(() => expect(success).toHaveBeenCalled());
    expect(success.mock.calls[0]?.[0]).toContain("already running on another machine");
    expect(error).not.toHaveBeenCalled();
    expect(screen.queryByRole("alert")).toBeNull();
    // The target is running, so the card locks its affordances and the lane re-reads onto the run.
    expect(onReleased).toHaveBeenCalled();
    // Nothing to retry, so the run affordance retires exactly as an ordinary approval retires it.
    expect(onApprovedWithoutRun).not.toHaveBeenCalled();
    await waitFor(() => expect(refresh).toHaveBeenCalled());
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
