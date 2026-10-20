// @vitest-environment jsdom
/**
 * `DigestFeatureGroups` (anton-y1uxp): named-outcome sections render open, the unlinked group
 * carries its badge, and the housekeeping group starts collapsed behind its own Show/Hide fold —
 * the same pattern `HousekeepingSection` already uses for hygiene findings.
 */
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import { DigestFeatureGroups } from "@/components/digest/feature-groups";
import type { DigestFeatureCard, DigestFeatureGroup } from "@/lib/digest/feature-cards";

afterEach(cleanup);

function cardOf(overrides: Partial<DigestFeatureCard> & { id: string }): DigestFeatureCard {
  return {
    title: overrides.id,
    headline: "1 event: run finished",
    why: undefined,
    outcomeId: undefined,
    stage: "implementing",
    prRef: undefined,
    prUrl: undefined,
    reviewScore: undefined,
    costUsd: undefined,
    nextStep: "Running",
    events: [],
    ...overrides,
  };
}

describe("DigestFeatureGroups", () => {
  it("renders nothing when there are no groups", () => {
    const { container } = render(<DigestFeatureGroups slug="anton" groups={[]} />);
    expect(container.innerHTML).toBe("");
  });

  it("renders a named-outcome group open, with its summary as the header", () => {
    const groups: DigestFeatureGroup[] = [
      {
        key: "outcome:oriented-operator",
        kind: "outcome",
        outcomeId: "oriented-operator",
        label: "The operator always knows what anton did.",
        cards: [cardOf({ id: "feat-a", title: "A since-you-looked timeline" })],
      },
    ];
    render(<DigestFeatureGroups slug="anton" groups={groups} />);
    expect(screen.getByText("The operator always knows what anton did.")).toBeTruthy();
    expect(screen.getByRole("link", { name: "A since-you-looked timeline" })).toBeTruthy();
    expect(screen.queryByText("unlinked")).toBeNull();
  });

  it("badges the unlinked group so it reads apart from a real outcome", () => {
    const groups: DigestFeatureGroup[] = [
      {
        key: "unlinked",
        kind: "unlinked",
        label: "No outcome linked",
        cards: [cardOf({ id: "feat-a" })],
      },
    ];
    render(<DigestFeatureGroups slug="anton" groups={groups} />);
    expect(screen.getByText("No outcome linked")).toBeTruthy();
    expect(screen.getByText("unlinked")).toBeTruthy();
  });

  it("collapses the housekeeping group behind a Show/Hide fold, closed by default", () => {
    const groups: DigestFeatureGroup[] = [
      {
        key: "housekeeping",
        kind: "housekeeping",
        label: "Housekeeping",
        cards: [cardOf({ id: "feat-a", title: "Lint cleanup" })],
      },
    ];
    render(<DigestFeatureGroups slug="anton" groups={groups} />);
    expect(screen.getByText("Housekeeping · 1 feature")).toBeTruthy();
    // Collapsed: the card's own content is not yet visible...
    expect(screen.queryByRole("link", { name: "Lint cleanup" })).toBeNull();
    // ...until Show is clicked.
    fireEvent.click(screen.getByRole("button", { name: /show/i }));
    expect(screen.getByRole("link", { name: "Lint cleanup" })).toBeTruthy();
  });

  it("pluralizes the housekeeping count", () => {
    const groups: DigestFeatureGroup[] = [
      {
        key: "housekeeping",
        kind: "housekeeping",
        label: "Housekeeping",
        cards: [cardOf({ id: "feat-a" }), cardOf({ id: "feat-b" })],
      },
    ];
    render(<DigestFeatureGroups slug="anton" groups={groups} />);
    expect(screen.getByText("Housekeeping · 2 features")).toBeTruthy();
  });
});
