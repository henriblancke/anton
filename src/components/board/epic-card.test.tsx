import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

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
