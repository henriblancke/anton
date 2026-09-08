// @vitest-environment jsdom
/**
 * The Quota shares section's STAGED preview (PR #248 review).
 *
 * The claim under test is that turning budget-aware execution on here previews the split that save
 * would actually produce. The equal-split default is what every undeclared project rides, so a
 * project joining the denominator moves ALL of those rows at once — refreshing only the row being
 * edited leaves the rest on the server's pre-edit default and previews a split that does not add up.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

import { QuotaSection } from "@/components/settings/sections/quota-section";
import { draftFromSettings } from "@/components/settings/settings-draft";
import type { SettingsForm } from "@/components/settings/use-settings-form";
import type { QuotaShareProject } from "@/lib/quota-share";

afterEach(cleanup);

function project(id: string, governed: boolean): QuotaShareProject {
  return {
    id,
    slug: id,
    name: id,
    // What the server resolves an undeclared row to: an equal cut of the two projects it saw
    // governed at render time.
    sharePct: 50,
    declared: false,
    governed,
    reserved: false,
    eligible: true,
    spentWeeklyPct: null,
    seeded: false,
  };
}

/** Only `draft` and `set` are read here; the rest of the form is another panel's concern. */
function form(budgetAware: boolean): SettingsForm {
  return {
    draft: { ...draftFromSettings({ budgetAware }, [], {}) },
    set: vi.fn(),
  } as unknown as SettingsForm;
}

/** Two governed neighbours plus this project, which the operator is about to arm. */
const BOARD = [project("mine", false), project("a", true), project("b", true)];

describe("QuotaSection", () => {
  it("rebuilds every undeclared row off the staged split, so the preview adds up", () => {
    render(<QuotaSection form={form(true)} project={{ id: "mine" }} quotaProjects={BOARD} />);

    // Three undeclared rows at a third each — not this row at 33% beside two stale 50%s.
    expect(screen.getByText(/Declared 100% across 3 paced projects/)).toBeTruthy();
    expect(screen.queryByText(/Shares add up to/)).toBeNull();
  });

  it("holds the stored split while the switch is off", () => {
    render(<QuotaSection form={form(false)} project={{ id: "mine" }} quotaProjects={BOARD} />);

    expect(screen.getByText(/Declared 100% across 2 paced projects/)).toBeTruthy();
    expect(screen.queryByText(/Shares add up to/)).toBeNull();
  });
});
