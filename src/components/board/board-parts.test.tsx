// @vitest-environment jsdom
/**
 * The board's alert slot, which owns the one thing the strip itself cannot: WHEN the breaker read
 * arrives (anton-7gxs).
 *
 * Deciding the WIP hold spawns a `gh pr view` per in-review PR, so the page hands the read over
 * unresolved and this slot suspends on it alone — behind its OWN boundary. That is the design: the
 * cards below never wait on GitHub, and no skeleton stands in for the line, because it is late
 * context and not a placeholder worth watching. A test boundary is mounted around it here purely to
 * prove the suspension is caught inside — an outer fallback that appeared would mean the slot had
 * let the board suspend with it.
 *
 * The fallback is the strip MINUS the breaker, not nothing (PR #261 review): the escalation and park
 * counts are already resolved, and blanking them for the length of a GitHub read is the regression
 * two of the cases below pin.
 *
 * The polled read takes over once one has landed, because a hold releases when a PR merges or
 * closes — an event nothing on an open board would otherwise notice.
 */
import { Suspense } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";

import { BoardAttentionSlot } from "@/components/board/board-parts";
import type { AutopilotBreaker } from "@/lib/autopilot-breaker";
import type { EscalationView } from "@/lib/types";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

afterEach(cleanup);

const hold: AutopilotBreaker = {
  kind: "hold",
  reason: "wip-limit",
  detail: "3 of 3 review slots are full",
};

const disarm: AutopilotBreaker = {
  kind: "disarm",
  reason: "score-regression",
  detail: "the last four runs scored below the floor",
  evidence: ["4.0", "3.5"],
};

const escalation: EscalationView = {
  id: "esc-1",
  findingKey: "parked-run:r-1",
  kind: "parked-run",
  reason: "parked 4h ago: agent exited 1",
  ageMs: 4 * 3_600_000,
  status: "open",
  noted: true,
  raisedAt: 0,
};

function mount(over: Partial<Parameters<typeof BoardAttentionSlot>[0]> = {}) {
  return render(
    <Suspense fallback={<p>the board, already rendered</p>}>
      <BoardAttentionSlot
        slug="anton"
        escalations={[]}
        onArmed={vi.fn()}
        polled={null}
        {...over}
      />
    </Suspense>,
  );
}

describe("BoardAttentionSlot", () => {
  it("keeps its own suspension to itself, showing nothing while the read is outstanding", () => {
    const { container } = mount({ streamed: new Promise<undefined>(() => {}) });
    // The inner boundary caught it: no outer fallback, and no line — not a skeleton either.
    expect(screen.queryByText("the board, already rendered")).toBeNull();
    expect(container.querySelector("section")).toBeNull();
  });

  it("shows the alerts it already knows while only the breaker is outstanding", () => {
    // The regression the fallback exists to stop (PR #261 review): a `null` fallback blanked the
    // WHOLE strip on a pending breaker, so a board with eight stopped runs said nothing at all for
    // as long as `gh pr view` took. The counts are resolved values — they must not wait on GitHub.
    mount({ escalations: [escalation], streamed: new Promise<undefined>(() => {}) });
    expect(screen.getByText("1 stopped")).toBeTruthy();
    expect(screen.queryByText("the board, already rendered")).toBeNull();
  });

  it("adds the breaker's chips to the line already standing, once the read answers", async () => {
    // The fallback and the resolved strip are the same component, so the line does not appear —
    // it gains a chip. Nothing that was on screen goes away to make room for it.
    await act(async () => {
      mount({ escalations: [escalation], streamed: Promise.resolve(hold) });
    });
    expect(screen.getByText("1 stopped")).toBeTruthy();
    expect(screen.getByText("Review queue is full")).toBeTruthy();
  });

  it("fills the line in once the read answers", async () => {
    await act(async () => {
      mount({ streamed: Promise.resolve(hold) });
    });
    expect(screen.getByText("Review queue is full")).toBeTruthy();
  });

  it("stays silent once the read answers that nothing is stopped", async () => {
    await act(async () => {
      mount({ streamed: Promise.resolve(undefined) });
    });
    expect(screen.queryByText("the board, already rendered")).toBeNull();
    expect(screen.queryByRole("region")).toBeNull();
  });

  it("prefers the polled answer over the page's, once one has landed", () => {
    // A hold releases on GitHub, with nothing on this board to notice it — so the poll, not the
    // page's first read, is what eventually tells the truth.
    mount({ polled: { value: disarm }, streamed: Promise.resolve(hold) });
    expect(screen.getByText("Review scores fell below the floor")).toBeTruthy();
    expect(screen.queryByText("Review queue is full")).toBeNull();
  });

  it("never suspends the board around it, however slow the read is", () => {
    // The property the whole arrangement exists for: an unanswerable GitHub read costs the alert
    // line and nothing else, so anything rendered beside this slot is unaffected.
    render(
      <Suspense fallback={<p>the board, already rendered</p>}>
        <>
          <p>a column of cards</p>
          <BoardAttentionSlot
            slug="anton"
            escalations={[escalation]}
            onArmed={vi.fn()}
            polled={null}
            streamed={new Promise<undefined>(() => {})}
          />
        </>
      </Suspense>,
    );
    expect(screen.getByText("a column of cards")).toBeTruthy();
    expect(screen.queryByText("the board, already rendered")).toBeNull();
  });
});
