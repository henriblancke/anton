import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { contractStatusOf } from "@/lib/beads/contract";
import type { Bead } from "@/lib/beads/types";
import { makeStandaloneItem } from "@/components/board/standalone-item.fixture";
import { StandaloneChip } from "@/components/board/standalone-chip";
import { StandaloneGroup } from "@/components/board/standalone-group";
import { TypeBadge } from "@/components/board/type-language";

const makeItem = makeStandaloneItem;

describe("StandaloneChip", () => {
  it("renders a task chip with its type label and an Approve & run affordance in the backlog", () => {
    const html = renderToStaticMarkup(<StandaloneChip slug="anton" item={makeItem()} />);
    expect(html).toContain("Loose task");
    expect(html).toContain("Task"); // the compact type badge
    expect(html).toMatch(/Approve/);
    expect(html).toMatch(/run/);
  });

  it("carries the bug type and shows an unread marker for a self-filed unread bug", () => {
    const html = renderToStaticMarkup(
      <StandaloneChip
        slug="anton"
        item={makeItem({ id: "b-1", title: "Loose bug", type: "bug", unread: true })}
      />,
    );
    expect(html).toContain("Loose bug");
    expect(html).toContain("Bug");
    expect(html).toContain('aria-label="Unread"');
  });

  it("hides the run affordance once approved and outside the backlog", () => {
    const html = renderToStaticMarkup(
      <StandaloneChip slug="anton" item={makeItem({ stage: "implementing", approved: true })} />,
    );
    expect(html).not.toMatch(/Approve &amp; run/);
    // An implementing chip shows the live "working" indicator instead.
    expect(html).toContain("working");
  });

  it("hides the run affordance and shows a blocked chip while a prerequisite is open", () => {
    const html = renderToStaticMarkup(
      <StandaloneChip slug="anton" item={makeItem({ ready: false, blockedBy: ["t-9"] })} />,
    );
    // A blocked standalone target can't be approved (the route 409s), so no Approve & run.
    expect(html).not.toMatch(/Approve/);
    expect(html).toContain("blocked by t-9");
  });

  it("offers a snooze toggle in the backlog and marks a snoozed item, hiding its run affordance", () => {
    const awake = renderToStaticMarkup(<StandaloneChip slug="anton" item={makeItem()} />);
    expect(awake).toContain('aria-label="Snooze"');
    expect(awake).not.toContain("snoozed");

    const snoozed = renderToStaticMarkup(
      <StandaloneChip slug="anton" item={makeItem({ deferred: true })} />,
    );
    expect(snoozed).toContain("snoozed");
    // The toggle flips to restore, and the one control that would start a run is gone.
    expect(snoozed).toContain('aria-label="Un-snooze"');
    expect(snoozed).not.toMatch(/Approve/);
  });

  it("marks an abandoned item with its own chip and never with the shipped/done tint", () => {
    const shipped = renderToStaticMarkup(
      <StandaloneChip
        slug="anton"
        item={makeItem({ stage: "done", status: "closed", prRef: "gh-42" })}
      />,
    );
    expect(shipped).not.toContain("abandoned");
    expect(shipped).toContain("text-stage-done");

    const dropped = renderToStaticMarkup(
      <StandaloneChip
        slug="anton"
        item={makeItem({ stage: "done", status: "closed", prRef: "gh-42", abandoned: true })}
      />,
    );
    expect(dropped).toContain("abandoned");
    // Closed, but nothing shipped — the done tint belongs to delivered work only.
    expect(dropped).not.toContain("text-stage-done");
  });

  it("links a PR chip when the standalone item is in review", () => {
    const html = renderToStaticMarkup(
      <StandaloneChip
        slug="anton"
        item={makeItem({ stage: "in-review", prRef: "gh-42", prUrl: "https://x/pull/42" })}
      />,
    );
    expect(html).toContain("#42");
    expect(html).toContain("https://x/pull/42");
  });
});

describe("StandaloneChip contract marking", () => {
  // Built through the shared validator, so the chip is tested against the wording approve would use.
  const statusOf = (over: Partial<Bead>) =>
    contractStatusOf({
      id: "t-1",
      title: "Loose task",
      status: "open",
      issue_type: "task",
      created_at: "2026-07-20T00:00:00.000Z",
      ...over,
    });

  const SHAPED = "## Goal\nG\n\n## Context\nC\n\n## Out of scope\nO\n\n## Verify\nV";

  it("marks a blocking gap and keeps Approve & run in place but inert, naming what is missing", () => {
    const html = renderToStaticMarkup(
      <StandaloneChip slug="anton" item={makeItem({ contract: statusOf({ description: SHAPED }) })} />,
    );
    expect(html).toContain("needs Acceptance");
    expect(html).toContain("Can&#x27;t approve — no Acceptance criteria");
    expect(html).toContain("Approve &amp; run"); // the affordance explains rather than vanishing
    expect(html).toContain('disabled=""');
  });

  it("shows an advisory gap as a nudge and still runs", () => {
    const html = renderToStaticMarkup(
      <StandaloneChip
        slug="anton"
        item={makeItem({
          contract: statusOf({
            description: "## Goal\nG\n\n## Context\nC\n\n## Out of scope\nO",
            acceptance_criteria: "- [ ] done",
          }),
        })}
      />,
    );
    expect(html).toContain("1 spec gap");
    expect(html).not.toContain("needs ");
    expect(html).not.toContain('disabled=""');
    expect(html).toContain("Approve &amp; run");
  });

  it("drops the mark on a closed item — its spec gaps can no longer strand a run", () => {
    const html = renderToStaticMarkup(
      <StandaloneChip
        slug="anton"
        item={makeItem({
          stage: "done",
          status: "closed",
          contract: statusOf({ description: SHAPED, status: "closed" }),
        })}
      />,
    );
    expect(html).not.toContain("needs Acceptance");
  });
});

describe("TypeBadge", () => {
  it("labels an epic distinctly from a chip type", () => {
    expect(renderToStaticMarkup(<TypeBadge type="epic" />)).toContain("Epic");
  });
});

describe("StandaloneGroup", () => {
  it("shows a standalone divider with the full count and caps the list with a +N more expander", () => {
    const items = Array.from({ length: 5 }, (_, i) =>
      makeItem({ id: `x-${i}`, title: `item-${i}` }),
    );
    const html = renderToStaticMarkup(<StandaloneGroup slug="anton" items={items} />);
    expect(html).toContain("standalone");
    expect(html).toContain(">5<"); // divider count reflects ALL items, not the visible cap
    // Only the first three chips render; the overflow hides behind the expander.
    expect(html).toContain("item-0");
    expect(html).toContain("item-2");
    expect(html).not.toContain("item-3");
    expect(html).not.toContain("item-4");
    expect(html).toContain("+2 more");
  });

  it("renders nothing when there are no standalone items", () => {
    expect(renderToStaticMarkup(<StandaloneGroup slug="anton" items={[]} />)).toBe("");
  });
});

describe("StandaloneChip review score (anton-tprv)", () => {
  it("shows a scored standalone target's latest score", () => {
    const html = renderToStaticMarkup(
      <StandaloneChip slug="anton" item={makeItem({ stage: "done", reviewScore: 6 })} />,
    );
    expect(html).toContain("review 6/10");
  });

  it("shows nothing for one no review has scored", () => {
    const html = renderToStaticMarkup(<StandaloneChip slug="anton" item={makeItem()} />);
    expect(html).not.toMatch(/review \d/);
  });
});
