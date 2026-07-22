import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

// loading.tsx derives the slug from the committed pathname (it receives no params).
vi.mock("next/navigation", () => ({
  usePathname: () => "/projects/acme",
  useRouter: () => ({ push: vi.fn() }),
}));

import ProjectLoading from "./loading";

describe("projects/[slug]/(board)/loading", () => {
  it("renders the board skeleton inside the board frame with the topbar for the target project", () => {
    const html = renderToStaticMarkup(<ProjectLoading />);
    // Route-level fallback: the skeleton shows immediately while getBoard() resolves.
    expect(html).toContain("Loading board");
    // The topbar renders with the slug from the pathname, so the breadcrumb and its
    // links stay present (and interactive once hydrated) during the load.
    expect(html).toContain("acme");
    expect(html).toContain("Add work");
  });
});
