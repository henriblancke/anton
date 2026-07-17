import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { ClaimControl, InheritedOwner } from "@/components/board/claim-control";

describe("ClaimControl", () => {
  it("offers Claim when the run target is unclaimed", () => {
    const html = renderToStaticMarkup(
      <ClaimControl slug="anton" itemId="e-1" owner={null} operator="alice" />,
    );
    expect(html).toContain("Unclaimed");
    expect(html).toMatch(/Claim/);
    expect(html).not.toMatch(/Release/);
    expect(html).not.toMatch(/Steal/);
  });

  it("offers Release when the target is claimed by me", () => {
    const html = renderToStaticMarkup(
      <ClaimControl slug="anton" itemId="e-1" owner="alice" operator="alice" />,
    );
    expect(html).toContain("You"); // my own claim reads as "You", not my name
    expect(html).toMatch(/Release/);
    expect(html).not.toMatch(/Steal/);
    expect(html).not.toMatch(/>Claim</);
  });

  it("offers Steal and names the owner when the target is claimed by someone else", () => {
    const html = renderToStaticMarkup(
      <ClaimControl slug="anton" itemId="e-1" owner="bob" operator="alice" />,
    );
    expect(html).toContain("bob"); // the current owner is shown
    expect(html).toMatch(/Steal/);
    expect(html).not.toMatch(/Release/);
  });

  it("shows the owner read-only until the operator identity resolves", () => {
    // operator=null (resolved to "nobody") still can't claim someone else's — no Steal/Release,
    // but the owner is always visible.
    const html = renderToStaticMarkup(
      <ClaimControl slug="anton" itemId="e-1" owner="bob" operator={null} />,
    );
    expect(html).toContain("bob");
    expect(html).not.toMatch(/Steal/);
    expect(html).not.toMatch(/Release/);
  });
});

describe("InheritedOwner", () => {
  it("shows the inherited epic owner read-only with no claim control", () => {
    const html = renderToStaticMarkup(<InheritedOwner owner="carol" />);
    expect(html).toContain("carol");
    expect(html).toContain("inherited");
    expect(html).not.toMatch(/Claim/);
    expect(html).not.toMatch(/Release/);
    expect(html).not.toMatch(/Steal/);
  });

  it("reads as Unclaimed when the epic has no owner", () => {
    const html = renderToStaticMarkup(<InheritedOwner owner={null} />);
    expect(html).toContain("Unclaimed");
  });
});
