// @vitest-environment jsdom
/**
 * One answer per pick (PR #212 review).
 *
 * A ranked card offers both `[Release]` and the two vetoes, and they are the same decision seen from
 * two sides. What is pinned here is that only ONE of them can settle: without the shared lock a slow
 * request lets the operator start work they just deferred, or record a decline against a plan the
 * release already accepted — two contradictory verdicts on one pick.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

import { EpicCard } from "@/components/board/epic-card";
import { makeEpic } from "@/components/board/epic.fixture";
import { PickDecisionProvider } from "@/components/board/pick-decision";
import { ReleaseAction } from "@/components/board/release-action";
import { StandaloneChip } from "@/components/board/standalone-chip";
import { makeStandaloneItem } from "@/components/board/standalone-item.fixture";
import { VetoActions } from "@/components/board/veto-actions";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }));
vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn(), message: vi.fn() },
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

/** The pick as the lane draws it: the vetoes above, `[Release]` inside the card below. */
function mountPick() {
  return render(
    <PickDecisionProvider>
      <VetoActions slug="anton" beadId="anton-a" title="Ship the lane" />
      <ReleaseAction slug="anton" beadId="anton-a" title="Ship the lane" />
    </PickDecisionProvider>,
  );
}

/** What the picker's mark looks like on a card the lane ranked. */
const PICK = { kind: "policy" as const, ref: "labels:domain", detail: "the armed policy" };

/**
 * The same pick on a BUDGET-AWARE project, where `Queue` sits beside `[Release]` inside the card.
 * Queue is the answer with no server-side backstop — it approves with `release: false`, so it writes
 * no accept for the veto's store-side guard to collide with — which is exactly why it must take the
 * same lock (PR #212 review).
 */
function mountBudgetPick() {
  return render(
    <PickDecisionProvider>
      <VetoActions slug="anton" beadId="anton-a" title="Ship the lane" />
      <EpicCard slug="anton" epic={makeEpic({ id: "anton-a", provenance: [PICK] })} budgetAware />
    </PickDecisionProvider>,
  );
}

/** The same pick as an epic-of-one: a standalone chip renders its own Queue from its own hook. */
function mountBudgetChip() {
  return render(
    <PickDecisionProvider>
      <VetoActions slug="anton" beadId="t-1" title="Loose task" />
      <StandaloneChip slug="anton" item={makeStandaloneItem({ provenance: [PICK] })} budgetAware />
    </PickDecisionProvider>,
  );
}

const veto = () => screen.getByRole("button", { name: /not now/i });
const release = () => screen.getByRole("button", { name: /Release/i });
const queue = () => screen.getByRole("button", { name: /Queue/i });
const called = (fetchMock: ReturnType<typeof vi.fn>, fragment: string) =>
  fetchMock.mock.calls.some(([url]) => String(url).includes(fragment));

/** A fetch whose answer for `fragment` lands only when the returned resolver is called. */
function heldFetch(fragment: string, body: unknown, status = 200) {
  let land: (() => void) | undefined;
  const held = new Promise<Response>((resolve) => {
    land = () => resolve(new Response(JSON.stringify(body), { status }));
  });
  const fetchMock = vi.fn(async (url: RequestInfo | URL) => {
    if (String(url).includes(fragment)) return held;
    return new Response(JSON.stringify({}), { status: 200 });
  });
  vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);
  return { fetchMock, land: () => land?.() };
}

describe("a pick with a decision in flight", () => {
  it("withholds Release while a veto is out — the deferred target must not start", async () => {
    const { fetchMock, land } = heldFetch("/picker/veto", { deferredUntil: Date.now() + 1000 });
    mountPick();

    fireEvent.click(veto());
    await waitFor(() => expect(release().hasAttribute("disabled")).toBe(true));

    fireEvent.click(release());
    expect(called(fetchMock, "/approve")).toBe(false);

    // And it stays withheld once the decline lands: the pick has its answer.
    land();
    await waitFor(() => expect(called(fetchMock, "/picker/veto")).toBe(true));
    expect(release().hasAttribute("disabled")).toBe(true);
  });

  it("withholds the vetoes while a release is out — the started run cannot also be declined", async () => {
    const { fetchMock, land } = heldFetch("/approve", { jobId: "j1" });
    mountPick();

    fireEvent.click(release());
    await waitFor(() => expect(veto().hasAttribute("disabled")).toBe(true));

    fireEvent.click(veto());
    expect(called(fetchMock, "/picker/veto")).toBe(false);

    land();
    await waitFor(() => expect(called(fetchMock, "/approve")).toBe(true));
    expect(veto().hasAttribute("disabled")).toBe(true);
  });
});

describe("a pick with a Queue beside it", () => {
  it("withholds Queue while a veto is out — a paced run is still a run on the deferred target", async () => {
    const { fetchMock, land } = heldFetch("/picker/veto", { deferredUntil: Date.now() + 1000 });
    mountBudgetPick();

    fireEvent.click(veto());
    await waitFor(() => expect(queue().hasAttribute("disabled")).toBe(true));

    fireEvent.click(queue());
    expect(called(fetchMock, "/approve")).toBe(false);

    land();
    await waitFor(() => expect(called(fetchMock, "/picker/veto")).toBe(true));
    expect(queue().hasAttribute("disabled")).toBe(true);
  });

  it("withholds the vetoes while a Queue is out — the queued run cannot also be declined", async () => {
    const { fetchMock, land } = heldFetch("/approve", {});
    mountBudgetPick();

    fireEvent.click(queue());
    await waitFor(() => expect(veto().hasAttribute("disabled")).toBe(true));

    fireEvent.click(veto());
    expect(called(fetchMock, "/picker/veto")).toBe(false);

    land();
    await waitFor(() => expect(called(fetchMock, "/approve")).toBe(true));
    expect(veto().hasAttribute("disabled")).toBe(true);
  });

  it("holds a standalone chip's Queue to the same one answer", async () => {
    const { fetchMock, land } = heldFetch("/picker/veto", { deferredUntil: Date.now() + 1000 });
    mountBudgetChip();

    fireEvent.click(veto());
    await waitFor(() => expect(queue().hasAttribute("disabled")).toBe(true));

    fireEvent.click(queue());
    expect(called(fetchMock, "/approve")).toBe(false);

    land();
    await waitFor(() => expect(called(fetchMock, "/picker/veto")).toBe(true));
    expect(queue().hasAttribute("disabled")).toBe(true);
  });
});

describe("a decision that did not land", () => {
  it("hands the pick back after a failed veto", async () => {
    const { land } = heldFetch("/picker/veto", { error: "anton.db is locked" }, 500);
    mountPick();

    fireEvent.click(veto());
    land();

    await waitFor(() => expect(release().hasAttribute("disabled")).toBe(false));
    expect(veto().hasAttribute("disabled")).toBe(false);
  });

  it("hands the pick back when the approval started no run — its own copy says to try again", async () => {
    // 200 with no `jobId`: the approval stands but nothing runs, and `[Release]` tells the operator
    // to release again. Settling the pick there would shut the only control that can.
    const { land } = heldFetch("/approve", {});
    mountPick();

    fireEvent.click(release());
    land();

    await waitFor(() => expect(screen.getByRole("alert")).toBeTruthy());
    expect(release().hasAttribute("disabled")).toBe(false);
    expect(veto().hasAttribute("disabled")).toBe(false);
  });
});
