import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

// loading.tsx derives the slug from the committed pathname (it receives no params).
vi.mock("next/navigation", () => ({
  usePathname: () => "/projects/acme/roadmap",
}));

import RoadmapLoading from "./loading";

describe("projects/[slug]/roadmap/loading", () => {
  it("renders the roadmap fallback frame with the slug breadcrumb", () => {
    const html = renderToStaticMarkup(<RoadmapLoading />);
    // Route-level fallback: covers the page's getRoadmap() await, which resolves before any
    // markup — and so before an inner Suspense boundary could exist.
    expect(html).toContain("Loading roadmap");
    expect(html).toContain("acme");
    expect(html).toContain("Roadmap");
  });
});
