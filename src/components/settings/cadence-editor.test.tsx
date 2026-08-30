// @vitest-environment jsdom
/**
 * The cadence editor (anton-ue90.5), tested at its own boundary (anton-8t1f).
 *
 * The contract this pins is narrow and load-bearing: every frequency the picker offers builds its
 * expression through {@link cronForPreset}, so what the editor stores round-trips back to the
 * control the operator used. These assertions read the value handed to `onCommit` rather than the
 * footer text, because the stored string is the thing that decides when an automation actually
 * fires — a phrase that merely looks right is not the claim.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import { CadenceEditor } from "@/components/settings/cadence-editor";

afterEach(cleanup);

const LABEL = "nightly-stringer";

function renderEditor({
  cron = "0 3 * * *",
  defaultCron = "0 3 * * *",
}: { cron?: string; defaultCron?: string } = {}) {
  const onCommit = vi.fn<(cron: string) => void>();
  const onClose = vi.fn();
  render(
    <CadenceEditor
      label={LABEL}
      cron={cron}
      defaultCron={defaultCron}
      onCommit={onCommit}
      onClose={onClose}
    />,
  );
  return { onCommit, onClose };
}

const setCadence = () => screen.getByRole("button", { name: "Set cadence" }) as HTMLButtonElement;
const chooseFrequency = (name: string) => fireEvent.click(screen.getByRole("button", { name }));
const cronInput = () => screen.getByLabelText(`${LABEL} cron expression`) as HTMLInputElement;

/**
 * Pick a value from one of the editor's number pickers. They render their menus in a portal, and
 * base-ui commits a highlighted item on Enter — the same path a keyboard operator takes.
 */
function pick(field: string, option: string) {
  fireEvent.click(screen.getByLabelText(field));
  const item = screen.getAllByRole("option").find((o) => o.textContent === option);
  if (!item) throw new Error(`the ${field} picker offers no "${option}"`);
  fireEvent.keyDown(item, { key: "Enter" });
}

/** Open an editor on `cron`, drive it, commit — and answer with what it tried to store. */
function committed(cron: string, drive: () => void): string | undefined {
  const { onCommit } = renderEditor({ cron });
  drive();
  fireEvent.click(setCadence());
  return onCommit.mock.calls[0]?.[0];
}

describe("CadenceEditor frequency → cron", () => {
  it("opens on the frequency the stored expression was built from", () => {
    renderEditor({ cron: "0 4 * * 1" });
    const pressed = screen
      .getAllByRole("button")
      .filter((b) => b.getAttribute("aria-pressed") === "true");
    expect(pressed.map((b) => b.textContent)).toEqual(["Weekly"]);
  });

  it.each([
    ["5", "*/5 * * * *"],
    ["10", "*/10 * * * *"],
    ["15", "*/15 * * * *"],
    ["30", "*/30 * * * *"],
  ])("builds a %s-minute step as %s", (step, expected) => {
    expect(
      committed("0 3 * * *", () => {
        chooseFrequency("Minutes");
        pick("Minutes between runs", step);
      }),
    ).toBe(expected);
  });

  it("builds the plain hourly preset when the minute is on the hour", () => {
    // Minute 0 is `hourly`, not `hourly-at` — the two spell the same fire, and only one of them
    // round-trips back through presetForCron to the control that produced it.
    expect(committed("0 3 * * *", () => chooseFrequency("Hourly"))).toBe("0 * * * *");
  });

  it("builds the parameterised hourly preset for any other minute", () => {
    expect(
      committed("0 3 * * *", () => {
        chooseFrequency("Hourly");
        pick("Minute", "30");
      }),
    ).toBe("30 * * * *");
  });

  it("builds a daily cadence from the hour and minute pickers", () => {
    expect(
      committed("0 * * * *", () => {
        chooseFrequency("Daily");
        pick("Hour", "09");
        pick("Minute", "45");
      }),
    ).toBe("45 9 * * *");
  });

  it("builds a weekly cadence from the weekday, hour and minute pickers", () => {
    expect(
      committed("0 * * * *", () => {
        chooseFrequency("Weekly");
        pick("Day of week", "Friday");
        pick("Hour", "06");
      }),
    ).toBe("0 6 * * 5");
  });

  it("carries the time already set across a frequency change", () => {
    // "Daily at 06:30" → Weekly must read "Weekly on Monday at 06:30", not silently reset the clock.
    expect(committed("30 6 * * *", () => chooseFrequency("Weekly"))).toBe("30 6 * * 1");
  });

  it("keeps a stored value the menu does not list, so the operator can return to it", () => {
    // Minutes are offered in fives; `13 * * * *` is a perfectly good cadence and must stay reachable
    // after the picker is touched at all.
    renderEditor({ cron: "13 * * * *" });
    fireEvent.click(screen.getByLabelText("Minute"));
    expect(screen.getAllByRole("option").map((o) => o.textContent)).toContain("13");
  });
});

describe("CadenceEditor raw expression", () => {
  it("seeds the box with the expression the current draft stands for", () => {
    // An escape hatch, not a blank page: switching to Cron must hand over what is already staged.
    renderEditor({ cron: "0 3 * * *" });
    chooseFrequency("Weekly");
    chooseFrequency("Cron");
    expect(cronInput().value).toBe("0 3 * * 1");
  });

  it("opens straight on the raw box for an expression no preset can spell", () => {
    renderEditor({ cron: "0 0,12 * * 1-5" });
    expect(cronInput().value).toBe("0 0,12 * * 1-5");
  });

  it("stores a hand-written expression verbatim", () => {
    expect(
      committed("0 3 * * *", () => {
        chooseFrequency("Cron");
        fireEvent.change(cronInput(), { target: { value: "0 0,12 * * 1-5" } });
      }),
    ).toBe("0 0,12 * * 1-5");
  });

  it("previews the fires a cadence will produce before anything is committed", () => {
    renderEditor({ cron: "0 3 * * *" });
    chooseFrequency("Weekly");
    expect(screen.getByText("Next 3 runs")).toBeTruthy();
    // The footer prints the expression the draft stands for — staged, never stored.
    expect(screen.getByText("0 3 * * 1")).toBeTruthy();
  });

  it("names a fast cadence's cost in runs per day, and still lets it save", () => {
    // The editor warns, it never refuses: 720 runs a day is a number the operator can weigh.
    expect(
      committed("0 3 * * *", () => {
        chooseFrequency("Cron");
        fireEvent.change(cronInput(), { target: { value: "*/2 * * * *" } });
        expect(screen.getByText(/720 runs a day/)).toBeTruthy();
        expect(setCadence().disabled).toBe(false);
      }),
    ).toBe("*/2 * * * *");
  });
});

describe("CadenceEditor refusals", () => {
  it("refuses an unparseable expression with the parser's own message", () => {
    const { onCommit, onClose } = renderEditor({ cron: "0 3 * * *" });
    chooseFrequency("Cron");
    fireEvent.change(cronInput(), { target: { value: "nope" } });

    expect(screen.getByText(/must have 5 fields/)).toBeTruthy();
    expect(cronInput().getAttribute("aria-invalid")).toBe("true");
    expect(setCadence().disabled).toBe(true);

    fireEvent.click(setCadence());
    expect(onCommit).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("refuses an emptied box by asking for the five fields", () => {
    renderEditor({ cron: "0 3 * * *" });
    chooseFrequency("Cron");
    fireEvent.change(cronInput(), { target: { value: "   " } });

    expect(screen.getByText("Enter a 5-field cron expression")).toBeTruthy();
    expect(setCadence().disabled).toBe(true);
  });

  it("recovers once the expression parses again", () => {
    const { onCommit } = renderEditor({ cron: "0 3 * * *" });
    chooseFrequency("Cron");
    fireEvent.change(cronInput(), { target: { value: "nope" } });
    fireEvent.change(cronInput(), { target: { value: "0 6 * * *" } });

    expect(screen.queryByText(/must have 5 fields/)).toBeNull();
    expect(setCadence().disabled).toBe(false);
    fireEvent.click(setCadence());
    expect(onCommit).toHaveBeenCalledWith("0 6 * * *");
  });

  it("refuses to re-store the cadence that is already stored", () => {
    const { onCommit } = renderEditor({ cron: "0 3 * * *" });
    expect(setCadence().disabled).toBe(true);
    fireEvent.click(setCadence());
    expect(onCommit).not.toHaveBeenCalled();
  });

  it("closes itself once a cadence is committed", () => {
    const { onCommit, onClose } = renderEditor({ cron: "0 3 * * *" });
    chooseFrequency("Hourly");
    fireEvent.click(setCadence());
    expect(onCommit).toHaveBeenCalledWith("0 * * * *");
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe("CadenceEditor reset", () => {
  it("stages the default rather than storing it — nothing leaves this popover uncommitted", () => {
    const { onCommit } = renderEditor({ cron: "0 9 * * *", defaultCron: "0 3 * * *" });
    fireEvent.click(screen.getByRole("button", { name: "Reset" }));
    expect(onCommit).not.toHaveBeenCalled();

    fireEvent.click(setCadence());
    expect(onCommit).toHaveBeenCalledWith("0 3 * * *");
  });

  it("offers no reset once the cadence is already the default", () => {
    renderEditor({ cron: "0 3 * * *", defaultCron: "0 3 * * *" });
    expect((screen.getByRole("button", { name: "Reset" }) as HTMLButtonElement).disabled).toBe(true);
  });
});
