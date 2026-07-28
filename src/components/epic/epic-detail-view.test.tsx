// @vitest-environment jsdom
/**
 * The detail breadcrumb's two states (anton-9pkk.6): a feature under a product epic gets the epic
 * badge hop, a run target without one gets no hop at all — an empty crumb would be worse than none.
 */
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

import { DetailBreadcrumb } from "@/components/epic/epic-detail-view";

afterEach(cleanup);

describe("DetailBreadcrumb", () => {
  it("shows the epic badge, then the feature title and id", () => {
    render(
      <DetailBreadcrumb
        slug="anton"
        id="anton-ftj"
        title="Ship the ontology editor"
        parentEpic={{ id: "anton-9pkk", title: "Ontology editing for curators" }}
      />,
    );

    const crumb = screen.getByLabelText("Breadcrumb");
    expect(crumb.textContent).toMatch(
      /Ontology editing for curators.*Ship the ontology editor.*anton-ftj/,
    );
  });

  it("links the badge through to the board filtered to that epic", () => {
    render(
      <DetailBreadcrumb
        slug="anton"
        id="anton-ftj"
        title="Ship the ontology editor"
        parentEpic={{ id: "anton-9pkk", title: "Ontology editing for curators" }}
      />,
    );

    const badge = screen.getByRole("link", { name: /Ontology editing for curators/ });
    expect(badge.getAttribute("href")).toBe("/projects/anton?epic=anton-9pkk");
  });

  it("renders no epic hop for a run target with no parent epic", () => {
    render(<DetailBreadcrumb slug="anton" id="anton-ftj" title="Legacy run target" />);

    const crumb = screen.getByLabelText("Breadcrumb");
    // Only the Board root remains — no badge, and no crumb separator left dangling behind it.
    expect(screen.getAllByRole("link")).toHaveLength(1);
    expect(screen.getByRole("link", { name: "Board" }).getAttribute("href")).toBe(
      "/projects/anton",
    );
    expect(crumb.textContent).toMatch(/^Board\s*\/\s*Legacy run target\s*·\s*anton-ftj$/);
  });
});
