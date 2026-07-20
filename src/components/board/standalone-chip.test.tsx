import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import type { StandaloneItem } from "@/lib/types";
import { StandaloneChip } from "@/components/board/standalone-chip";
import { StandaloneGroup } from "@/components/board/standalone-group";
import { TypeBadge } from "@/components/board/type-language";

function makeItem(over: Partial<StandaloneItem> = {}): StandaloneItem {
  return {
    id: "t-1",
    title: "Loose task",
    type: "task",
    status: "open",
    stage: "backlog",
    approved: false,
    assignee: null,
    createdAt: "",
    createdBy: null,
    blockedBy: [],
    ready: true,
    unread: false,
    deferred: false,
    ...over,
  };
}

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
