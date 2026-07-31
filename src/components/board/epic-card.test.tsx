import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import type { Bead } from "@/lib/beads/types";
import { contractStatusOf } from "@/lib/beads/contract";
import type { Epic } from "@/lib/types";
import { EpicCard } from "@/components/board/epic-card";

function makeEpic(over: Partial<Epic> = {}): Epic {
  return {
    id: "anton-1",
    title: "Resumable crawl checkpoints",
    type: "feature",
    approved: false,
    stage: "backlog",
    assignee: null,
    createdAt: "2026-07-20T00:00:00.000Z",
    createdBy: null,
    blockedBy: [],
    ready: true,
    rank: 0,
    priority: 2,
    abandoned: false,
    tickets: [],
    ...over,
  };
}

describe("EpicCard type language", () => {
  it("presents a feature card as a feature, not an epic", () => {
    const html = renderToStaticMarkup(<EpicCard slug="anton" epic={makeEpic()} />);
    expect(html).toContain("Feature"); // the compact type badge
    expect(html).not.toContain("Epic");
    expect(html).toContain("feature id"); // copy affordance + delete/open wording
    expect(html).toContain("Delete feature");
    expect(html).toContain("Open feature");
  });

  it("still reads as an epic for a legacy run target", () => {
    const html = renderToStaticMarkup(<EpicCard slug="anton" epic={makeEpic({ type: "epic" })} />);
    expect(html).toContain("Epic");
    expect(html).toContain("epic id");
    expect(html).toContain("Delete epic");
  });

  it("carries the type onto a done card too", () => {
    const html = renderToStaticMarkup(
      <EpicCard slug="anton" epic={makeEpic({ stage: "done", tickets: [] })} />,
    );
    expect(html).toContain("feature id");
    expect(html).not.toContain("epic id");
  });
});

describe("EpicCard contract marking", () => {
  // Built through the shared validator rather than hand-written violations, so the card is tested
  // against the wording approve and the runner would use.
  const statusOf = (over: Partial<Bead>) =>
    contractStatusOf({
      id: "anton-1",
      title: "Resumable crawl checkpoints",
      status: "open",
      issue_type: "feature",
      created_at: "2026-07-20T00:00:00.000Z",
      ...over,
    });

  const SHAPED = "## Goal\nG\n\n## Context\nC\n\n## Out of scope\nO\n\n## Verify\nV";

  it("marks a blocking gap and replaces Approve with an inert affordance naming it", () => {
    const html = renderToStaticMarkup(
      <EpicCard slug="anton" epic={makeEpic({ contract: statusOf({ description: SHAPED }) })} />,
    );
    // Visibly marked, by the section that is missing.
    expect(html).toContain("needs Acceptance");
    // The affordance stays, says what is missing, and can't be clicked into a 422.
    expect(html).toContain("Can&#x27;t approve — no Acceptance criteria");
    expect(html).toContain('disabled=""');
  });

  it("shows an advisory gap as a nudge and still offers Approve", () => {
    const html = renderToStaticMarkup(
      <EpicCard
        slug="anton"
        epic={makeEpic({
          contract: statusOf({
            description: "## Goal\nG\n\n## Context\nC\n\n## Out of scope\nO",
            acceptance_criteria: "- [ ] done",
          }),
        })}
      />,
    );
    expect(html).toContain("1 spec gap");
    // A nudge never withholds the run.
    expect(html).not.toContain("needs ");
    expect(html).not.toContain('disabled=""');
    expect(html).toContain("Approve");
  });

  it("leaves a conformant card unmarked", () => {
    const html = renderToStaticMarkup(
      <EpicCard
        slug="anton"
        epic={makeEpic({
          contract: statusOf({ description: `${SHAPED}\n\n## Acceptance\n- [ ] done` }),
        })}
      />,
    );
    expect(html).not.toContain("spec gap");
    expect(html).not.toContain("needs ");
    expect(html).not.toContain('disabled=""');
  });
});
