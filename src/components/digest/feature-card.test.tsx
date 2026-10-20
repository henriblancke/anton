// @vitest-environment jsdom
/**
 * `DigestFeatureCardView` (anton-y1uxp): every field the acceptance names actually renders — the
 * headline, the quoted Why (and its absence), the outcome chip, stage, PR link, review score,
 * cost, next step, and the last-five-events list.
 */
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

import { DigestFeatureCardView } from "@/components/digest/feature-card";
import type { DigestFeatureCard } from "@/lib/digest/feature-cards";

afterEach(cleanup);

function cardOf(overrides: Partial<DigestFeatureCard> = {}): DigestFeatureCard {
  return {
    id: "feat-1",
    title: "Reports are shareable",
    headline: "2 events: PR opened, run finished",
    why: "Serves oriented-operator.",
    outcomeId: "oriented-operator",
    stage: "in-review",
    prRef: "gh-218",
    prUrl: "https://github.com/acme/repo/pull/218",
    reviewScore: 8,
    costUsd: 1.23,
    nextStep: "Awaiting merge",
    events: [
      { kind: "run.pr_opened", at: 2_000, label: "PR opened" },
      { kind: "run.started", at: 1_000, label: "run started" },
    ],
    ...overrides,
  };
}

describe("DigestFeatureCardView", () => {
  it("renders the title, headline, and next step", () => {
    render(<DigestFeatureCardView slug="anton" card={cardOf()} />);
    const titleLink = screen.getByRole("link", { name: "Reports are shareable" });
    expect(titleLink.getAttribute("href")).toBe("/projects/anton/epics/feat-1");
    expect(screen.getByText("2 events: PR opened, run finished")).toBeTruthy();
    expect(screen.getByText("Awaiting merge")).toBeTruthy();
  });

  it("quotes the Why", () => {
    render(<DigestFeatureCardView slug="anton" card={cardOf()} />);
    expect(screen.getByText("“Serves oriented-operator.”")).toBeTruthy();
  });

  it("renders no Why block when the feature authored none", () => {
    render(<DigestFeatureCardView slug="anton" card={cardOf({ why: undefined })} />);
    expect(screen.queryByText(/“/)).toBeNull();
  });

  it("renders the outcome chip, and omits it when the feature links no outcome", () => {
    render(<DigestFeatureCardView slug="anton" card={cardOf()} />);
    expect(screen.getByText("outcome:oriented-operator")).toBeTruthy();
    cleanup();
    render(<DigestFeatureCardView slug="anton" card={cardOf({ outcomeId: undefined })} />);
    expect(screen.queryByText(/^outcome:/)).toBeNull();
  });

  it("links the PR by its short label and resolved URL", () => {
    render(<DigestFeatureCardView slug="anton" card={cardOf()} />);
    const prLink = screen.getByRole("link", { name: "#218" });
    expect(prLink.getAttribute("href")).toBe("https://github.com/acme/repo/pull/218");
  });

  it("renders the review score and cost", () => {
    render(<DigestFeatureCardView slug="anton" card={cardOf()} />);
    expect(screen.getByText("review 8/10")).toBeTruthy();
    expect(screen.getByText("$1.23")).toBeTruthy();
  });

  it("renders unpriced cost as a dash, never as $0.00", () => {
    render(<DigestFeatureCardView slug="anton" card={cardOf({ costUsd: undefined })} />);
    expect(screen.getByText("—")).toBeTruthy();
  });

  it("lists the last events, newest first, and renders nothing when there are none", () => {
    render(<DigestFeatureCardView slug="anton" card={cardOf()} />);
    const items = screen.getAllByRole("listitem");
    expect(items).toHaveLength(2);
    expect(items[0]!.textContent).toContain("PR opened");
    expect(items[1]!.textContent).toContain("run started");
    cleanup();
    render(<DigestFeatureCardView slug="anton" card={cardOf({ events: [] })} />);
    expect(screen.queryAllByRole("listitem")).toHaveLength(0);
  });
});
