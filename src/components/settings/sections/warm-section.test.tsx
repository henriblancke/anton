// @vitest-environment jsdom
/**
 * The warming panel (anton-z5li2). Two claims are gated here:
 *
 * 1. Both knobs render, drive the draft, and round-trip a stored row through seed → save.
 * 2. The copy keeps "empty command" and "skip the warm" APART. An operator who clears the field
 *    expecting no warm gets lockfile detection instead, so the precedence line and the toggle's
 *    "this is how you skip it" are the panel's whole reason for existing.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import { WarmSection } from "@/components/settings/sections/warm-section";
import { draftFromSettings, settingsPatchBody } from "@/components/settings/settings-draft";
import type { EditableSettings } from "@/components/settings/settings-types";
import type { SettingsForm } from "@/components/settings/use-settings-form";

afterEach(cleanup);

/** Only `draft` and `set` are read here; the rest of the form is another suite's concern. */
function renderSection(settings: EditableSettings = {}) {
  const set = vi.fn();
  const form = {
    draft: draftFromSettings(settings, [], {}),
    set,
  } as unknown as SettingsForm;
  render(<WarmSection form={form} />);
  return { set };
}

/** The panel's copy as one string — for assertions on a sentence a <code> element splits. */
const flatText = (): string => document.body.textContent?.replace(/\s+/g, " ") ?? "";

describe("warm section — the two controls (anton-z5li2)", () => {
  it("renders the command field and the enable toggle", () => {
    renderSection();
    expect(screen.getByLabelText("Warm command")).toBeTruthy();
    expect(screen.getByRole("switch", { name: /warm each run's worktree/i })).toBeTruthy();
  });

  it("seeds both from the stored row", () => {
    renderSection({ warmCommand: "make setup", warmEnabled: false });
    expect(screen.getByLabelText<HTMLInputElement>("Warm command").value).toBe("make setup");
    expect(screen.getByRole("switch").getAttribute("aria-checked")).toBe("false");
  });

  /** Absent is ON: every project already warms, so nobody has to opt in to keep what they had. */
  it("reads an absent toggle as on", () => {
    renderSection();
    expect(screen.getByRole("switch").getAttribute("aria-checked")).toBe("true");
  });

  it("drives the draft from both controls", () => {
    const { set } = renderSection();
    fireEvent.change(screen.getByLabelText("Warm command"), { target: { value: "uv sync" } });
    expect(set).toHaveBeenCalledWith("warmCommand", "uv sync");

    fireEvent.click(screen.getByRole("switch"));
    expect(set).toHaveBeenCalledWith("warmEnabled", false);
  });
});

describe("warm section — empty is not skip (anton-z5li2)", () => {
  it("states the precedence the pinned command wins", () => {
    renderSection();
    expect(flatText()).toMatch(/wins over ANTON_WARM_COMMAND and lockfile detection/i);
  });

  it("says an empty command falls back rather than skipping", () => {
    renderSection();
    expect(flatText()).toMatch(/Empty falls back to those — it does not skip the warm/i);
  });

  it("points at the toggle as the documented way to skip warming", () => {
    renderSection();
    expect(flatText()).toMatch(/the switch above is how you do that/i);
    expect(flatText()).toMatch(/turn this off to skip warming for this repo entirely/i);
  });
});

describe("warm settings round-trip through the draft (anton-z5li2)", () => {
  it("carries both fields from a stored row back out of the save", () => {
    const stored: EditableSettings = { warmCommand: "make setup", warmEnabled: false };
    const body = settingsPatchBody(draftFromSettings(stored, [], {}), [], []);
    expect(body.warmCommand).toBe("make setup");
    expect(body.warmEnabled).toBe(false);
  });

  /** "" is the API's `null` — clear the PIN, keep warming. The skip rides on the boolean alone. */
  it("sends a cleared command as null while warming stays on", () => {
    const body = settingsPatchBody(draftFromSettings({}, [], {}), [], []);
    expect(body.warmCommand).toBeNull();
    expect(body.warmEnabled).toBe(true);
  });

  /** A pin survives the skip, so turning warming back on restores the operator's command. */
  it("keeps the pinned command while warming is off", () => {
    const off: EditableSettings = { warmCommand: "bun install", warmEnabled: false };
    const body = settingsPatchBody(draftFromSettings(off, [], {}), [], []);
    expect(body.warmCommand).toBe("bun install");
    expect(body.warmEnabled).toBe(false);
  });
});
