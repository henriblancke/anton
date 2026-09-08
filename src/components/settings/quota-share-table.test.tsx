// @vitest-environment jsdom
/**
 * The Quota shares panel (anton-68hl / R6.3), tested at its own boundary.
 *
 * The claim under test is honesty, not layout: every figure anton estimated carries the approximate
 * marker, the reason attribution is sampled is stated where it will be read, editing a share redraws
 * the split it produces, and an idle project's share reads as reallocated with the control that
 * would keep it in reach. A number here that read as exact would be reconciled against a bill.
 */
import { useState } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";

import { QuotaShareTable } from "@/components/settings/quota-share-table";
import type { QuotaShareProject } from "@/lib/quota-share";

afterEach(cleanup);

function project(overrides: Partial<QuotaShareProject> & { id: string }): QuotaShareProject {
  return {
    slug: overrides.id,
    name: overrides.id,
    sharePct: 50,
    declared: true,
    governed: true,
    reserved: false,
    eligible: true,
    spentWeeklyPct: null,
    seeded: false,
    ...overrides,
  };
}

/** The table as the settings section drives it: controlled, with the staged edit fed straight back. */
function Harness({
  projects,
  share = 50,
  reserved = false,
}: {
  projects: QuotaShareProject[];
  share?: number | null;
  reserved?: boolean;
}) {
  const [staged, setStaged] = useState<number | null>(share);
  const [keep, setKeep] = useState(reserved);
  return (
    <QuotaShareTable
      projects={projects}
      currentProjectId={projects[0].id}
      share={staged}
      reserved={keep}
      equalSplitPct={100 / projects.filter((p) => p.governed).length}
      onShareChange={setStaged}
      onReserveChange={setKeep}
    />
  );
}

const TWO = [project({ id: "mine", name: "mine" }), project({ id: "other", name: "other" })];

const rowFor = (name: string) => screen.getByText(name).closest("tr")!;
const shareInput = (name = "mine") =>
  screen.getByRole("spinbutton", { name: `${name} quota share, percent` });

describe("the spend column", () => {
  it("marks every figure approximate rather than exact (R6.3)", () => {
    render(
      <Harness
        projects={[
          project({ id: "mine", name: "mine", spentWeeklyPct: 4.2 }),
          project({ id: "other", name: "other", spentWeeklyPct: 1.75 }),
        ]}
      />,
    );

    expect(within(rowFor("mine")).getByText("≈ 4.2%")).toBeTruthy();
    expect(within(rowFor("other")).getByText("≈ 1.8%")).toBeTruthy();
    // The total is derived from the same sampled averages, so it wears the same marker.
    expect(screen.getByText(/≈ 6.0% of the weekly quota attributed/)).toBeTruthy();
  });

  it("reads an unattributed project as unsampled, never as zero spend", () => {
    // The two are opposite facts: a busy machine attributes almost nothing, and rendering that as
    // `0%` is the exact misreading this panel exists to prevent.
    render(<Harness projects={TWO} />);

    expect(within(rowFor("mine")).getByText("not sampled yet")).toBeTruthy();
    expect(screen.getByText(/no spend attributed to any project yet/)).toBeTruthy();
  });

  it("says when the estimate still leans on tier seeds", () => {
    render(<Harness projects={[project({ id: "mine", spentWeeklyPct: 2, seeded: true }), TWO[1]]} />);
    expect(screen.getByText(/estimated from tier seeds/)).toBeTruthy();
  });
});

describe("the explanation", () => {
  it("states in one line why attribution is sampled", () => {
    render(<Harness projects={TWO} />);

    // Load-bearing: an operator who doesn't know the burn window only opens for a solo run reads
    // sparse attribution as a broken panel.
    const explanation = screen.getByText(/Spend is sampled, not metered/);
    expect(explanation.textContent).toContain("had the machine to itself");
    expect(explanation.textContent).toContain("every figure here is an estimate");
  });
});

describe("editing a share", () => {
  it("redraws the split the edit would produce, not the one last saved", () => {
    render(<Harness projects={TWO} />);
    expect(within(rowFor("mine")).getByText("≈ 50%")).toBeTruthy();

    fireEvent.change(shareInput(), { target: { value: "75" } });

    // 75/50 declared → 60/40 in force, and the panel says the declared total no longer reads 100.
    expect(within(rowFor("mine")).getByText("≈ 60%")).toBeTruthy();
    expect(within(rowFor("other")).getByText("≈ 40%")).toBeTruthy();
    expect(screen.getByText(/Shares add up to 125%, not 100%/)).toBeTruthy();
  });

  it("clears back to the equal split rather than to a number nobody chose", () => {
    render(<Harness projects={TWO} share={80} />);
    fireEvent.click(screen.getByRole("button", { name: "Reset" }));

    expect((shareInput() as HTMLInputElement).value).toBe("");
    expect(screen.getByText("equal split")).toBeTruthy();
    expect(within(rowFor("mine")).getByText("≈ 50%")).toBeTruthy();
  });

  it("holds the declared share inside 0–100", () => {
    render(<Harness projects={TWO} />);
    fireEvent.change(shareInput(), { target: { value: "140" } });
    expect((shareInput() as HTMLInputElement).value).toBe("100");
  });
});

describe("an idle project", () => {
  it("shows its share as reallocated, with the reserve control in the same row", () => {
    render(<Harness projects={[project({ id: "mine", name: "mine", eligible: false }), TWO[1]]} />);
    const idle = within(rowFor("mine"));

    expect(idle.getByText("share in use elsewhere")).toBeTruthy();
    expect(idle.getByText("≈ 0%")).toBeTruthy();
    // Adjacent by design: the answer to what the row just said is one control away from it.
    expect(idle.getByRole("switch", { name: "Reserve my share" })).toBeTruthy();
    // And the neighbour is visibly the beneficiary — the share went somewhere, it wasn't lost.
    expect(within(rowFor("other")).getByText("≈ 100%")).toBeTruthy();
  });

  it("keeps the share once it is reserved, without a save", () => {
    render(<Harness projects={[project({ id: "mine", name: "mine", eligible: false }), TWO[1]]} />);
    fireEvent.click(screen.getByRole("switch", { name: "Reserve my share" }));

    expect(within(rowFor("mine")).queryByText("share in use elsewhere")).toBeNull();
    expect(within(rowFor("mine")).getByText("≈ 50%")).toBeTruthy();
    expect(within(rowFor("mine")).getByText("reserved while idle")).toBeTruthy();
  });

  it("names whose share is in use elsewhere, and says it comes back on its own", () => {
    // "Renormalized" is arithmetic; an operator needs the beneficiary and the horizon. Without the
    // name, a cut reading higher than the number they typed looks like a bug in their own settings.
    render(
      <Harness
        projects={[
          project({ id: "mine", name: "mine", sharePct: 40 }),
          project({ id: "other", name: "other", sharePct: 60, eligible: false }),
        ]}
        share={40}
      />,
    );

    const line = screen.getByText(/in use elsewhere right now/);
    expect(line.textContent).toContain("60% of the split");
    expect(line.textContent).toContain("other has no eligible work");
    expect(line.textContent).toContain("comes back on the next pass");
  });

  it("says nothing was observed rather than calling an unwatched project idle", () => {
    // board-picker is opt-in: with no pass to read, "no eligible work" would be a claim about a
    // question nobody asked, and it would move a share on the strength of it.
    render(<Harness projects={[project({ id: "mine", name: "mine", eligible: null }), TWO[1]]} />);

    expect(within(rowFor("mine")).getByText("eligibility not observed here")).toBeTruthy();
    expect(within(rowFor("mine")).getByText("≈ 50%")).toBeTruthy();
    expect(screen.queryByText("share in use elsewhere")).toBeNull();
  });

  it("does not call a reserved project idle when its eligibility was never observed", () => {
    // Reserved says the share stays put; "idle" is a claim about a picker pass this repo never ran.
    render(
      <Harness
        projects={[project({ id: "mine", name: "mine", eligible: null, reserved: true }), TWO[1]]}
        reserved
      />,
    );

    expect(within(rowFor("mine")).getByText("eligibility not observed here")).toBeTruthy();
    expect(within(rowFor("mine")).queryByText("reserved while idle")).toBeNull();
  });

  it("does not claim a share moved when no project can spend it", () => {
    render(
      <Harness
        projects={[
          project({ id: "mine", name: "mine", eligible: false }),
          project({ id: "other", name: "other", eligible: false }),
        ]}
      />,
    );
    expect(screen.queryByText("share in use elsewhere")).toBeNull();
  });
});

describe("an unpaced project", () => {
  it("is listed but sits outside the split", () => {
    render(
      <Harness
        projects={[project({ id: "mine", name: "mine" }), project({ id: "other", governed: false })]}
      />,
    );

    expect(within(rowFor("other")).getByText("not paced")).toBeTruthy();
    expect(within(rowFor("other")).getByText(/budget-aware execution off/)).toBeTruthy();
    // Its declared share is out of the denominator, so the paced project holds all of it.
    expect(within(rowFor("mine")).getByText("≈ 100%")).toBeTruthy();
  });
});
