// @vitest-environment jsdom
/**
 * The Health page's own view of `rankAttention`'s `attention`-severity items: a dependency cycle or
 * an abandoned run reads with its full detail sentence, a rework-band score links to its target, and
 * an empty list draws nothing — an empty section is not a "clean" claim here, just not drawn.
 */
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

import { WorthALookSection } from "@/components/health/worth-a-look-section";
import type { AttentionItem } from "@/lib/attention";
import type { HygieneFinding, ScoredTarget } from "@/lib/types";

afterEach(cleanup);

function hygieneItem(finding: Partial<HygieneFinding> & { kind: "dep-cycle" | "stale-in-progress" }, key = "h-1"): AttentionItem {
  return {
    key,
    severity: "attention",
    source: "hygiene",
    finding: { key: `${finding.kind}:x`, detail: "detail", ...finding },
  };
}

function reviewItem(target: Partial<ScoredTarget> = {}): AttentionItem {
  return {
    key: `review:${target.id ?? "anton-bad"}`,
    severity: "attention",
    source: "review",
    target: { id: "anton-bad", title: "the bad one", score: 3, ...target },
  };
}

describe("WorthALookSection", () => {
  it("renders nothing when there is nothing to look at", () => {
    const { container } = render(<WorthALookSection slug="anton" items={[]} />);
    expect(container.innerHTML).toBe("");
  });

  it("carries the count in the header", () => {
    render(
      <WorthALookSection
        slug="anton"
        items={[hygieneItem({ kind: "dep-cycle" }), reviewItem()]}
      />,
    );
    expect(screen.getByText("2 to look at")).toBeTruthy();
  });

  it("shows a dependency cycle with every ring member linked and its detail sentence in full", () => {
    render(
      <WorthALookSection
        slug="anton"
        items={[
          hygieneItem({
            kind: "dep-cycle",
            detail: "anton-a → anton-b → anton-a",
            ids: ["anton-a", "anton-b"],
          }),
        ]}
      />,
    );
    expect(screen.getByText("Dependency cycle")).toBeTruthy();
    expect(screen.getByText("anton-a → anton-b → anton-a")).toBeTruthy();
    expect(screen.getByTitle("Open anton-a")).toBeTruthy();
    expect(screen.getByTitle("Open anton-b")).toBeTruthy();
  });

  it("links a rework-band score to its epic, with the score chip", () => {
    render(<WorthALookSection slug="anton" items={[reviewItem({ id: "anton-bad", score: 3 })]} />);
    expect(screen.getByText("Substantial rework")).toBeTruthy();
    expect(screen.getByText("review 3/10")).toBeTruthy();
    expect(screen.getByRole("link", { name: "anton-bad" }).getAttribute("href")).toBe(
      "/projects/anton/epics/anton-bad",
    );
  });
});
