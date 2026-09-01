// @vitest-environment jsdom
/**
 * The operator queue band (anton-qfso.1).
 *
 * Two things are load-bearing here. The row has to be answerable WITHOUT opening the bead — what is
 * asked, how old the ask is, and whether a run is sitting held behind it — because a queue you must
 * click through row by row is a queue you skip. And an empty queue renders nothing at all: "nothing
 * is waiting on you" is a claim, and the honest form of it is silence (the same rule the escalation
 * strip and `rankAttention`'s `reported` flag encode).
 *
 * Which beads reach this band, and in what order, is the read's job — see operator-queue.test.ts.
 */
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

import { OperatorQueue } from "@/components/board/operator-queue";
import type { OperatorQueueItem } from "@/lib/types";

afterEach(cleanup);

function item(o: Partial<OperatorQueueItem> = {}): OperatorQueueItem {
  return {
    id: "anton-t1",
    title: "Buy the domain",
    stage: "backlog",
    createdAt: new Date(Date.now() - 3 * 86_400_000).toISOString(),
    ...o,
  };
}

describe("OperatorQueue", () => {
  it("renders nothing when no work is yours", () => {
    // Not an empty state: a band saying "nothing waiting on you" claims the queue was checked and
    // found clear, which is indistinguishable here from a board that simply has no human work.
    const { container } = render(<OperatorQueue slug="anton" items={[]} />);
    expect(container.innerHTML).toBe("");
  });

  it("says what the ask is, how old it is, and why it is here", () => {
    render(
      <OperatorQueue
        slug="anton"
        items={[item({ goal: "Register anton.dev before the launch post.", risk: "low", size: "S" })]}
      />,
    );
    expect(screen.getByText("Yours to do")).toBeTruthy();
    expect(screen.getByText("1 waiting")).toBeTruthy();
    expect(screen.getByText("Register anton.dev before the launch post.")).toBeTruthy();
    expect(screen.getByText("risk:low")).toBeTruthy();
    expect(screen.getByText("size:S")).toBeTruthy();
    expect(screen.getByText("3d ago")).toBeTruthy();
  });

  it("links each row to its bead, where the controls already live", () => {
    render(<OperatorQueue slug="anton" items={[item()]} />);
    const link = screen.getByRole("link", { name: "Buy the domain" });
    expect(link.getAttribute("href")).toBe("/projects/anton/epics/anton-t1");
  });

  it("separates a run nothing will start from a run already held", () => {
    // The two cost a founder different things: a human target is simply not moving, while a held
    // ticket has a run parked on it — so the row says which, and links the run it holds.
    render(
      <OperatorQueue
        slug="anton"
        items={[
          item({ id: "anton-f1.1", runTarget: { id: "anton-f1", title: "Ship billing" } }),
          item({ id: "anton-t2", title: "Sign the contract" }),
        ]}
      />,
    );
    expect(screen.getByText("holds a run")).toBeTruthy();
    expect(screen.getByText("no agent will start it")).toBeTruthy();
    expect(screen.getByRole("link", { name: "anton-f1" }).getAttribute("href")).toBe(
      "/projects/anton/epics/anton-f1",
    );
  });

  it("renders the rows in the order it was handed, newest ask first", () => {
    render(
      <OperatorQueue
        slug="anton"
        items={[
          item({ id: "anton-t3", title: "Newest" }),
          item({ id: "anton-t2", title: "Older" }),
          item({ id: "anton-t1", title: "Oldest" }),
        ]}
      />,
    );
    const titles = screen
      .getAllByRole("listitem")
      .map((row) => row.querySelector("a")?.textContent);
    expect(titles).toEqual(["Newest", "Older", "Oldest"]);
  });
});
