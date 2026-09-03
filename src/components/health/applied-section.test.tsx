// @vitest-environment jsdom
/**
 * The decision log (anton-vfvg / R3.10): what ran unattended and what the operator refused, in the
 * section that already reported the gardener's own writes. What these pin is that each entry kind is
 * readable without opening a run — the target, what happened, the rule behind it — that both of its
 * links go somewhere concrete, and that a picker record with nothing in it draws no log at all.
 */
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

import { AppliedSection } from "@/components/health/applied-section";
import type { PickerLogEntry } from "@/lib/picker-log";
import type { HygieneReport } from "@/lib/types";

afterEach(cleanup);

const NOW = Date.now();

function report(over: Partial<HygieneReport["actions"]> = {}): HygieneReport {
  return {
    id: "h-1",
    projectId: "p1",
    generatedAt: Math.floor(Date.now() / 1000),
    actions: { closedEpics: [], rowsRecomputed: 0, ...over },
    findings: [],
    counts: {
      lint: 0,
      "stale-open": 0,
      "stale-in-progress": 0,
      orphan: 0,
      "dep-cycle": 0,
      duplicate: 0,
    },
  };
}

function entry(over: Partial<PickerLogEntry> = {}): PickerLogEntry {
  return {
    key: "start:anton-a:1",
    kind: "start",
    beadId: "anton-a",
    atMs: NOW - 60_000,
    rule: "the work policy armed on this machine",
    rank: 1,
    ranked: 4,
    ...over,
  };
}

/** The `◈ policy` link on the row for `beadId` — the entry's second piece of evidence. */
function policyLink(beadId: string): HTMLAnchorElement {
  const link = screen
    .getAllByRole("link")
    .find((a) => a.getAttribute("href")?.includes(`bead=${beadId}`));
  if (!link) throw new Error(`no policy link for ${beadId}`);
  return link as HTMLAnchorElement;
}

describe("AppliedSection", () => {
  it("renders nothing for a never-patrolled project with no picker record", () => {
    const { container } = render(<AppliedSection slug="anton" hygiene={undefined} />);
    expect(container.innerHTML).toBe("");
  });

  it("renders nothing when the patrol applied nothing", () => {
    const { container } = render(<AppliedSection slug="anton" hygiene={report()} />);
    expect(container.innerHTML).toBe("");
  });

  it("renders nothing for an empty picker record — no log, not an empty one", () => {
    const { container } = render(
      <AppliedSection slug="anton" hygiene={report()} pickerLog={[]} />,
    );
    expect(container.innerHTML).toBe("");
  });

  it("names the epics the patrol closed, not just how many", () => {
    render(<AppliedSection slug="anton" hygiene={report({ closedEpics: ["anton-e1", "anton-e2"] })} />);
    expect(screen.getByText("anton-e1")).toBeTruthy();
    expect(screen.getByText("anton-e2")).toBeTruthy();
  });

  it("names how many is_blocked rows it repaired, with the explanatory title", () => {
    render(<AppliedSection slug="anton" hygiene={report({ rowsRecomputed: 4 })} />);
    expect(screen.getByText(/repaired 4 blocked rows/)).toBeTruthy();
    expect(screen.getByText(/repaired 4 blocked rows/).getAttribute("title")).toContain(
      "bd ready trusts that flag",
    );
  });

  it("reports a picker start beside the patrol's own applies", () => {
    render(
      <AppliedSection
        slug="anton"
        hygiene={report({ closedEpics: ["anton-e1"] })}
        pickerLog={[entry()]}
      />,
    );
    expect(screen.getByText("started")).toBeTruthy();
    expect(screen.getByText("anton-a")).toBeTruthy();
    expect(screen.getByText("anton-e1")).toBeTruthy();
  });

  it("says a start was anton's alone, and where the pick stood — without opening the run", () => {
    render(<AppliedSection slug="anton" hygiene={undefined} pickerLog={[entry()]} />);
    const summary = screen.getByText(/anton started this on its own/);
    expect(summary.textContent).toContain("rank 1 of 4");
    expect(summary.textContent).toContain("nobody approved it");
  });

  it("links a start to its bead and to the rule that admitted it", () => {
    render(<AppliedSection slug="anton" hygiene={undefined} pickerLog={[entry()]} />);
    expect(screen.getByRole("button", { name: "anton-a" })).toBeTruthy();
    const link = policyLink("anton-a");
    expect(link.getAttribute("href")).toBe("/projects/anton/settings?bead=anton-a#policy");
    expect(link.getAttribute("title")).toContain("the work policy armed on this machine");
  });

  it("reports a deferral with the window it bought", () => {
    render(
      <AppliedSection
        slug="anton"
        hygiene={undefined}
        pickerLog={[
          entry({
            key: "deferral:anton-b:1",
            kind: "deferral",
            beadId: "anton-b",
            rank: 2,
            ranked: undefined,
            heldUntilMs: NOW + 3 * 3600_000 + 30_000,
          }),
        ]}
      />,
    );
    expect(screen.getByText("not now")).toBeTruthy();
    expect(screen.getByText(/you set this pick aside/).textContent).toContain("held 3h 0m longer");
  });

  it("says so when a deferral's hold has already run out", () => {
    render(
      <AppliedSection
        slug="anton"
        hygiene={undefined}
        pickerLog={[
          entry({ key: "d:1", kind: "deferral", beadId: "anton-b", heldUntilMs: NOW - 1_000 }),
        ]}
      />,
    );
    expect(screen.getByText(/the hold has run out/)).toBeTruthy();
  });

  it("reports a `Never` as a veto, and links it at the criterion it sent the operator to tighten", () => {
    render(
      <AppliedSection
        slug="anton"
        hygiene={undefined}
        pickerLog={[
          entry({
            key: "veto:anton-c:1",
            kind: "veto",
            beadId: "anton-c",
            criterion: "labels:severity",
            heldUntilMs: NOW + 3600_000,
          }),
        ]}
      />,
    );
    expect(screen.getByText("never")).toBeTruthy();
    // The criterion as the editor labels it — `severity:`, never `labels:severity`.
    expect(screen.getByText(/you refused this pick/).textContent).toContain("tighten the policy at severity:");
    expect(policyLink("anton-c").getAttribute("href")).toBe(
      "/projects/anton/settings?criterion=labels%3Aseverity&bead=anton-c#policy",
    );
  });

  it("stamps every entry with when it happened", () => {
    render(
      <AppliedSection
        slug="anton"
        hygiene={undefined}
        pickerLog={[entry({ atMs: NOW - 3 * 3600_000 })]}
      />,
    );
    expect(screen.getByText("3h ago")).toBeTruthy();
  });
});
