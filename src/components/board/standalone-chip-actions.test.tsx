import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { contractStatusOf } from "@/lib/beads/contract";
import type { StandaloneItem } from "@/lib/types";
import { makeStandaloneItem } from "@/components/board/standalone-item.fixture";
import {
  ApproveRunAction,
  ChipBacklogActions,
  canOfferRun,
} from "@/components/board/standalone-chip-actions";
import type { StandaloneApproval } from "@/components/board/use-standalone-approval";

const approval = (over: Partial<StandaloneApproval> = {}): StandaloneApproval => ({
  approved: false,
  deferred: false,
  running: false,
  approveRun: vi.fn(),
  setDeferred: vi.fn(),
  ...over,
});

const contractOf = (over: Partial<Parameters<typeof contractStatusOf>[0]>) =>
  contractStatusOf({
    id: "t-1",
    title: "Loose task",
    status: "open",
    issue_type: "task",
    created_at: "2026-07-20T00:00:00.000Z",
    ...over,
  });

const SHAPED = "## Goal\nG\n\n## Context\nC\n\n## Out of scope\nO\n\n## Verify\nV";

/** The rendered `<button>` tag carrying `marker`, so a test can assert on one half of the split. */
const buttonTag = (html: string, marker: string) => {
  const at = html.indexOf(marker);
  return at < 0 ? "" : html.slice(html.lastIndexOf("<button", at), html.indexOf(">", at) + 1);
};

describe("canOfferRun", () => {
  const item = makeStandaloneItem();

  it("offers a run for a ready, unapproved, awake backlog item", () => {
    expect(canOfferRun(item, false, false)).toBe(true);
  });

  it.each<[string, StandaloneItem, boolean, boolean]>([
    ["already approved", item, true, false],
    ["snoozed out of the queue", item, false, true],
    // The approve route 409s a blocked target, so offering the run would only teach a failure.
    ["still blocked", makeStandaloneItem({ ready: false, blockedBy: ["t-9"] }), false, false],
    ["past the backlog", makeStandaloneItem({ stage: "implementing" }), false, false],
  ])("withholds the run when %s", (_why, subject, approved, deferred) => {
    expect(canOfferRun(subject, approved, deferred)).toBe(false);
  });
});

describe("ApproveRunAction", () => {
  it("renders a single Approve & run button when the project is not budget-aware", () => {
    const html = renderToStaticMarkup(
      <ApproveRunAction item={makeStandaloneItem()} budgetAware={false} approval={approval()} />,
    );
    expect(html).toContain("Approve &amp; run");
    expect(html).not.toContain("Queue");
  });

  it("splits into Queue and Approve when the project is budget-aware", () => {
    const html = renderToStaticMarkup(
      <ApproveRunAction item={makeStandaloneItem()} budgetAware approval={approval()} />,
    );
    expect(html).toContain("Queue");
    expect(html).toContain(">Approve<");
    expect(html).not.toContain("Approve &amp; run");
  });

  it("disables both budget-aware buttons while an approve is in flight", () => {
    const html = renderToStaticMarkup(
      <ApproveRunAction
        item={makeStandaloneItem()}
        budgetAware
        approval={approval({ running: true })}
      />,
    );
    // Both halves lock, not just the one that was clicked — either would start the same run.
    expect(buttonTag(html, "Queue this run")).toContain('disabled=""');
    expect(buttonTag(html, "Approve and run now")).toContain('disabled=""');
    expect(html).toContain("…");
  });

  it("says the run is starting while a plain approve is in flight", () => {
    const html = renderToStaticMarkup(
      <ApproveRunAction
        item={makeStandaloneItem()}
        budgetAware={false}
        approval={approval({ running: true })}
      />,
    );
    expect(html).toContain("Starting…");
  });

  it("keeps the affordance in place but inert when the contract blocks the run", () => {
    const html = renderToStaticMarkup(
      <ApproveRunAction
        item={makeStandaloneItem({ contract: contractOf({ description: SHAPED }) })}
        budgetAware
        approval={approval()}
      />,
    );
    // Naming the missing section teaches more than a click that 422s — and it outranks the split.
    expect(html).toContain("Can&#x27;t approve — no Acceptance criteria");
    expect(html).toContain("Approve &amp; run");
    expect(html).toContain('disabled=""');
    expect(html).not.toContain("Queue");
  });

  it("renders nothing at all when this item may not offer a run", () => {
    expect(
      renderToStaticMarkup(
        <ApproveRunAction
          item={makeStandaloneItem()}
          budgetAware
          approval={approval({ approved: true })}
        />,
      ),
    ).toBe("");
  });
});

describe("ChipBacklogActions", () => {
  it("pairs the claim control with the run and snooze affordances", () => {
    const html = renderToStaticMarkup(
      <ChipBacklogActions
        slug="anton"
        item={makeStandaloneItem()}
        budgetAware={false}
        approval={approval()}
        hasOverlay
      />,
    );
    expect(html).toContain("Unclaimed");
    expect(html).toContain("Approve &amp; run");
    expect(html).toContain('aria-label="Snooze"');
  });

  it("locks the claim once approved — the claim route 409s an approved target", () => {
    const html = renderToStaticMarkup(
      <ChipBacklogActions
        slug="anton"
        item={makeStandaloneItem({ assignee: "bob" })}
        budgetAware={false}
        approval={approval({ approved: true })}
        hasOverlay
      />,
    );
    expect(html).toContain("locked while approved");
    expect(html).not.toContain("Steal");
  });

  it("drives the snooze toggle off the optimistic value, so it flips before the board polls", () => {
    const html = renderToStaticMarkup(
      <ChipBacklogActions
        slug="anton"
        item={makeStandaloneItem({ deferred: false })}
        budgetAware={false}
        approval={approval({ deferred: true })}
        hasOverlay
      />,
    );
    expect(html).toContain('aria-label="Un-snooze"');
  });
});
