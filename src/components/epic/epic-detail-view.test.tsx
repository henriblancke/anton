// @vitest-environment jsdom
/**
 * The detail breadcrumb's two states (anton-9pkk.6): a feature under a product epic gets the epic
 * badge hop, a run target without one gets no hop at all — an empty crumb would be worse than none.
 * Plus the header's run actions, which answer to the same contract gate the approve route enforces.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

import { contractStatusOf } from "@/lib/beads/contract";
import type { EpicDetail } from "@/lib/types";
import { makeEpic } from "@/components/board/epic.fixture";
import { DetailBreadcrumb, EpicDetailView } from "@/components/epic/epic-detail-view";

// The graph is ReactFlow — measured, canvas-ish, and irrelevant to the header actions under test.
vi.mock("@/components/epic/dependency-graph", () => ({ DependencyGraph: () => null }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

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

describe("EpicDetailView run actions", () => {
  const SHAPED = "## Goal\nG\n\n## Context\nC\n\n## Out of scope\nO\n\n## Verify\nV";

  /** The contract as the shared validator judges it, so the page is tested against approve's wording. */
  const contractOf = (description: string) =>
    contractStatusOf({
      id: "anton-1",
      title: "Resumable crawl checkpoints",
      status: "open",
      issue_type: "feature",
      created_at: "2026-07-20T00:00:00.000Z",
      description,
    });

  function renderDetail(description: string, over: Partial<EpicDetail["epic"]> = {}) {
    const detail: EpicDetail = {
      epic: makeEpic({ contract: contractOf(description), ...over }),
      description,
      tickets: [],
      edges: [],
    };
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ detail }), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    render(<EpicDetailView slug="anton" epicId="anton-1" />);
    return fetchMock;
  }

  it("renders the run action inert and names the missing section when the contract blocks", async () => {
    // The board card already refuses to advertise this run; the detail page posts to the same route,
    // so an enabled button here is a guaranteed 422 the operator learns nothing from.
    const fetchMock = renderDetail(SHAPED); // shaped prose, no Acceptance anywhere

    const action = await screen.findByRole("button", { name: /Run feature/ });
    expect(action.hasAttribute("disabled")).toBe(true);
    expect(action.getAttribute("aria-label")).toContain("no Acceptance criteria");
    // Reads only — no approve POST is reachable from the inert control.
    const posts = fetchMock.mock.calls.filter(
      ([, init]) => (init as RequestInit | undefined)?.method === "POST",
    );
    expect(posts).toEqual([]);
  });

  it("keeps Force run inert on a blocked target that is already implementing", async () => {
    renderDetail(SHAPED, { stage: "implementing" });

    const action = await screen.findByRole("button", { name: /Force run/ });
    expect(action.hasAttribute("disabled")).toBe(true);
  });

  it("leaves the run action live when only advisory gaps remain", async () => {
    // Advisory gaps cost quality, not runnability — nothing may withhold the run over them.
    renderDetail("## Acceptance\n- [ ] it works");

    const action = await screen.findByRole("button", { name: "Run feature" });
    expect(action.hasAttribute("disabled")).toBe(false);
  });
});
