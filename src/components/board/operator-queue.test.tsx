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
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

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
    const { container } = render(<OperatorQueue slug="anton" items={[]} onOpenTicket={() => {}} />);
    expect(container.innerHTML).toBe("");
  });

  it("says what the ask is, how old it is, and why it is here", () => {
    render(
      <OperatorQueue
        slug="anton"
        items={[item({ goal: "Register anton.dev before the launch post.", risk: "low", size: "S" })]}
        onOpenTicket={() => {}}
      />,
    );
    expect(screen.getByText("Yours to do")).toBeTruthy();
    expect(screen.getByText("1 waiting")).toBeTruthy();
    expect(screen.getByText("Register anton.dev before the launch post.")).toBeTruthy();
    expect(screen.getByText("risk:low")).toBeTruthy();
    expect(screen.getByText("size:S")).toBeTruthy();
    expect(screen.getByText("3d ago")).toBeTruthy();
  });

  it("links a run target to its epic page, where its run actions live", () => {
    render(<OperatorQueue slug="anton" items={[item()]} onOpenTicket={() => {}} />);
    const link = screen.getByRole("link", { name: "Buy the domain" });
    expect(link.getAttribute("href")).toBe("/projects/anton/epics/anton-t1");
  });

  it("opens a parented ticket in the ticket dialog, not the run-target page", () => {
    // The epic page offers run-target actions — Approve, Force run — and approving a parented task
    // is rejected outright, so it is the one surface that cannot answer this row. The dialog is
    // where the ticket's editor and state controls actually live.
    const onOpenTicket = vi.fn();
    render(
      <OperatorQueue
        slug="anton"
        items={[
          item({
            id: "anton-f1.1",
            title: "Sign the contract",
            runTarget: { id: "anton-f1", title: "Ship billing" },
            holdsRun: true,
          }),
        ]}
        onOpenTicket={onOpenTicket}
      />,
    );

    expect(screen.queryByRole("link", { name: "Sign the contract" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Sign the contract" }));
    expect(onOpenTicket).toHaveBeenCalledWith("anton-f1.1");
  });

  it("sends a held row to the gate that resumes the run, not to closing the ticket", () => {
    // The run holds an open human gate on this ticket and anton never auto-resolves it: the operator
    // resolves it from the escalation strip and the resumed run closes the ticket. Telling them to
    // close it instead leaves the gate open and the run parked for good.
    render(
      <OperatorQueue
        slug="anton"
        items={[
          item({
            id: "anton-f1.1",
            runTarget: { id: "anton-f1", title: "Ship billing" },
            holdsRun: true,
          }),
        ]}
        onOpenTicket={() => {}}
      />,
    );

    const held = screen.getByRole("listitem").textContent ?? "";
    expect(held).toContain("Resolve & resume");
    expect(held).toContain("Waiting on you");
    expect(held).toContain("the run is what closes this ticket");
    expect(held).not.toMatch(/until you close this/);
  });

  it("separates a run nothing will start from a run already held", () => {
    // The two cost a founder different things: a human target is simply not moving, while a held
    // ticket has a run parked on it — so the row says which, and links the run it holds.
    render(
      <OperatorQueue
        slug="anton"
        items={[
          item({
            id: "anton-f1.1",
            runTarget: { id: "anton-f1", title: "Ship billing" },
            holdsRun: true,
          }),
          item({ id: "anton-t2", title: "Sign the contract" }),
        ]}
        onOpenTicket={() => {}}
      />,
    );
    expect(screen.getByText("holds a run")).toBeTruthy();
    expect(screen.getByText("no agent will start it")).toBeTruthy();
    expect(screen.getByRole("link", { name: "anton-f1" }).getAttribute("href")).toBe(
      "/projects/anton/epics/anton-f1",
    );
  });

  it("says a run is refused at the target, not held, when the target is a person's work too", () => {
    // execute-epic poisons an `agent:human` target before dispatching any child, so no gate is ever
    // armed on this ticket. Telling the operator to "Resolve & resume" would send them after an
    // escalation row that does not exist (PR #214 review).
    render(
      <OperatorQueue
        slug="anton"
        items={[
          item({
            id: "anton-f1.1",
            runTarget: { id: "anton-f1", title: "Buy the domain" },
            holdsRun: false,
          }),
        ]}
        onOpenTicket={() => {}}
      />,
    );

    const row = screen.getByRole("listitem").textContent ?? "";
    expect(screen.getByText("no agent will start it")).toBeTruthy();
    expect(row).not.toContain("Resolve & resume");
    expect(row).toContain("which is yours as well");
    // Still a parented ticket, so it still opens where its controls live.
    expect(screen.getByRole("button", { name: "Buy the domain" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "anton-f1" })).toBeTruthy();
  });

  it("marks an ask someone has already picked up, and leaves an untouched one unchipped", () => {
    // Without it an in-progress ask reads exactly like one nobody has opened — the queue's own
    // reason for keeping `in_progress` rows is that the work is being done (PR #214 review).
    render(
      <OperatorQueue
        slug="anton"
        items={[
          item({ id: "anton-t1", title: "Started", stage: "implementing" }),
          item({ id: "anton-t2", title: "Untouched" }),
        ]}
        onOpenTicket={() => {}}
      />,
    );

    expect(screen.getByText("in progress")).toBeTruthy();
    const untouched = screen.getAllByRole("listitem")[1].textContent ?? "";
    expect(untouched).not.toContain("in progress");
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
        onOpenTicket={() => {}}
      />,
    );
    const titles = screen
      .getAllByRole("listitem")
      .map((row) => row.querySelector("a")?.textContent);
    expect(titles).toEqual(["Newest", "Older", "Oldest"]);
  });
});
