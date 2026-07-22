import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

// loading.tsx derives the slug from the committed pathname (it receives no params).
vi.mock("next/navigation", () => ({
  usePathname: () => "/projects/acme/tickets",
}));

import TicketsLoading from "./loading";

describe("projects/[slug]/tickets/loading", () => {
  it("renders the tickets fallback frame with the slug breadcrumb", () => {
    const html = renderToStaticMarkup(<TicketsLoading />);
    // Route-level fallback: covers the initial getTickets() await, which the page's
    // inner <Suspense> cannot (the await resolves before the boundary is returned).
    expect(html).toContain("Loading tickets");
    expect(html).toContain("acme");
    expect(html).toContain("Tickets");
  });
});
