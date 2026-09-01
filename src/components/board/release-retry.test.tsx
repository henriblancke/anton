// @vitest-environment jsdom
/**
 * A release whose approve landed with no run (PR #212 review).
 *
 * The failure copy tells the operator to release again — and the approve route supports exactly
 * that, re-enqueuing for a target already approved. But both surfaces draw the run affordance behind
 * a `!approved` gate, and that approve DID land, so the next board read would take the retry away
 * and strand an approved target with no run and no way to start one. These pin that the control
 * survives the board catching up, on both surfaces, and only for this outcome.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

import { EpicCard } from "@/components/board/epic-card";
import { makeEpic } from "@/components/board/epic.fixture";
import { ApproveRunAction } from "@/components/board/standalone-chip-actions";
import { makeStandaloneItem } from "@/components/board/standalone-item.fixture";
import type { StandaloneApproval } from "@/components/board/use-standalone-approval";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }));
vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn(), message: vi.fn() },
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

/** The picker's own provenance — what puts `[Release]` on a card in place of the plain Approve. */
const pick = { kind: "policy" as const, ref: "labels:domain", detail: "the armed policy" };

function stubFetch(body: unknown) {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify(body), { status: 200 })));
}

const release = () => fireEvent.click(screen.getByRole("button", { name: /release/i }));
const releaseButton = () => screen.queryByRole("button", { name: /release/i });

const approval = (over: Partial<StandaloneApproval> = {}): StandaloneApproval => ({
  approved: false,
  deferred: false,
  running: false,
  locked: false,
  approveRun: vi.fn(),
  setApproved: vi.fn(),
  setDeferred: vi.fn(),
  ...over,
});

describe("an epic card whose release approved but started nothing", () => {
  it("keeps offering the release once the board reports the target approved", async () => {
    // The enqueue threw: approve answers 200 with no job id, so the approval stands and nothing runs.
    stubFetch({ epic: { id: "anton-1", approved: true }, run: "failed" });
    const { rerender } = render(<EpicCard slug="anton" epic={makeEpic({ provenance: [pick] })} />);

    release();
    await screen.findByRole("alert");

    // The poll lands: the target is approved now, which is what normally retires this control.
    rerender(<EpicCard slug="anton" epic={makeEpic({ provenance: [pick], approved: true })} />);
    expect(releaseButton()).not.toBeNull();
    expect(releaseButton()?.hasAttribute("disabled")).toBe(false);
  });

  it("retires it as usual once a release does start a run", async () => {
    stubFetch({ jobId: "job-1", run: "started" });
    const { rerender } = render(<EpicCard slug="anton" epic={makeEpic({ provenance: [pick] })} />);

    release();
    await waitFor(() => expect(releaseButton()).toBeNull()); // locked optimistically

    rerender(<EpicCard slug="anton" epic={makeEpic({ provenance: [pick], approved: true })} />);
    expect(releaseButton()).toBeNull();
  });
});

describe("a standalone chip whose release approved but started nothing", () => {
  it("keeps offering the release once the board reports the item approved", async () => {
    stubFetch({ item: { id: "t-1", approved: true }, run: "failed" });
    const item = makeStandaloneItem({ provenance: [pick] });
    const { rerender } = render(
      <ApproveRunAction slug="anton" item={item} budgetAware={false} approval={approval()} />,
    );

    release();
    await screen.findByRole("alert");

    rerender(
      <ApproveRunAction
        slug="anton"
        item={{ ...item, approved: true }}
        budgetAware={false}
        approval={approval({ approved: true })}
      />,
    );
    expect(releaseButton()).not.toBeNull();
  });

  it("still withholds the run from an item that was simply approved elsewhere", () => {
    // The reopening is specific to a release this chip drove that started nothing — a target someone
    // else approved is not this chip's to re-offer.
    render(
      <ApproveRunAction
        slug="anton"
        item={makeStandaloneItem({ provenance: [pick], approved: true })}
        budgetAware={false}
        approval={approval({ approved: true })}
      />,
    );
    expect(releaseButton()).toBeNull();
  });
});
