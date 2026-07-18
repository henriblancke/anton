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

  it("treats an empty-string owner as unclaimed (a released target reads as Claim)", () => {
    // Beads returns a released assignee as "" (`bd assign <id> ""`), not null. The control must fold
    // it to unclaimed rather than render a blank owner with a Steal button.
    const html = renderToStaticMarkup(
      <ClaimControl slug="anton" itemId="e-1" owner="" operator="alice" />,
    );
    expect(html).toContain("Unclaimed");
    expect(html).toMatch(/Claim/);
    expect(html).not.toMatch(/Release/);
    expect(html).not.toMatch(/Steal/);
  });

  it("shows the owner read-only when locked (approved), even for my own claim", () => {
    // Once approved the claim route 409s any write, so the control must show the owner without a
    // Release/Steal/Claim action it can never satisfy — ownership then moves only via Approve.
    const html = renderToStaticMarkup(
      <ClaimControl slug="anton" itemId="e-1" owner="alice" operator="alice" readOnly />,
    );
    expect(html).toContain("You");
    expect(html).not.toMatch(/Release/);
    expect(html).not.toMatch(/Steal/);
    expect(html).not.toMatch(/>Claim</);
  });

  it("offers Take over on an approved target another operator holds when steal-on-approve is safe", () => {
    // The claim route 409s an approved target, so Steal is gone — but steal-on-approve is still a
    // valid move for a backlog target (the approve route skips the enqueue for an already-approved
    // target that has a run, so no second run). Surface it, or the documented take-over flow would
    // be unreachable from the UI.
    const html = renderToStaticMarkup(
      <ClaimControl slug="anton" itemId="e-1" owner="bob" operator="alice" readOnly canTakeOver />,
    );
    expect(html).toContain("bob");
    expect(html).toMatch(/Take over/);
    expect(html).not.toMatch(/Steal/);
  });

  it("keeps an approved target read-only when the caller doesn't allow a take-over", () => {
    // Past backlog the run is already executing under its owner's reservation; moving it is not a
    // claim-control affordance, so callers leave canTakeOver false and no action is offered.
    const html = renderToStaticMarkup(
      <ClaimControl slug="anton" itemId="e-1" owner="bob" operator="alice" readOnly />,
    );
    expect(html).toContain("bob");
    expect(html).not.toMatch(/Take over/);
    expect(html).not.toMatch(/Steal/);
  });

  it("does not offer Take over without an operator identity to reassign to", () => {
    // The approve route 409s a steal it can't attribute to an operator, so the button would only
    // ever fail.
    const html = renderToStaticMarkup(
      <ClaimControl slug="anton" itemId="e-1" owner="bob" operator={null} readOnly canTakeOver />,
    );
    expect(html).toContain("bob");
    expect(html).not.toMatch(/Take over/);
  });

  it("does not offer Take over on a claim that is already mine", () => {
    const html = renderToStaticMarkup(
      <ClaimControl slug="anton" itemId="e-1" owner="alice" operator="alice" readOnly canTakeOver />,
    );
    expect(html).toContain("You");
    expect(html).not.toMatch(/Take over/);
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

  it("reads as Unclaimed for a released epic claim, which beads reports as an empty assignee", () => {
    const html = renderToStaticMarkup(<InheritedOwner owner="" />);
    expect(html).toContain("Unclaimed");
    expect(html).toContain("The epic is unclaimed");
  });
});
