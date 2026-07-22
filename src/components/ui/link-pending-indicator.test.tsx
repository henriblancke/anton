import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { LinkPendingIndicator } from "@/components/ui/link-pending-indicator";

// The indicator reads its pending state from next/link's useLinkStatus (Link context);
// stub it so both states are renderable without a real router.
let pending = false;
vi.mock("next/link", () => ({
  useLinkStatus: () => ({ pending }),
}));

describe("LinkPendingIndicator", () => {
  beforeEach(() => {
    pending = false;
  });

  it("renders the idle affordance and no pending marker while navigation is settled", () => {
    const html = renderToStaticMarkup(
      <LinkPendingIndicator idle={<span data-testid="chevron" />} />,
    );
    expect(html).toContain("chevron");
    expect(html).not.toContain("data-pending");
    expect(html).not.toContain("animate-spin");
  });

  it("swaps to a spinner and exposes data-pending (for parent dimming) while pending", () => {
    pending = true;
    const html = renderToStaticMarkup(
      <LinkPendingIndicator idle={<span data-testid="chevron" />} />,
    );
    expect(html).toContain("data-pending");
    expect(html).toContain("animate-spin");
    // Delayed fade-in so instant (prefetched) navigations never flash the spinner.
    expect(html).toContain("anton-nav-pending-in");
    expect(html).not.toContain("chevron");
  });

  it("always reserves its fixed-size slot so toggling never shifts layout", () => {
    const idleHtml = renderToStaticMarkup(<LinkPendingIndicator />);
    pending = true;
    const pendingHtml = renderToStaticMarkup(<LinkPendingIndicator />);
    for (const html of [idleHtml, pendingHtml]) {
      expect(html).toContain("size-3.5");
      expect(html).toContain('aria-hidden="true"');
    }
  });
});
