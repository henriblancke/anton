// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

import {
  Select,
  SelectContent,
  SelectItem,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

const items = [
  { value: "hourly", label: "Hourly" },
  { value: "daily", label: "Daily" },
  { value: "custom", label: "Custom cron…" },
];

/** The cadence-picker shape the primitive exists for: presets, then a divided tail group. */
function Cadence({
  onValueChange,
  disabledItem = false,
}: {
  onValueChange?: (value: string | null) => void;
  disabledItem?: boolean;
}) {
  return (
    <Select items={items} onValueChange={onValueChange}>
      <SelectTrigger aria-label="Cadence">
        <SelectValue placeholder="Pick a cadence" />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="hourly">Hourly</SelectItem>
        <SelectItem value="daily" disabled={disabledItem}>
          Daily
        </SelectItem>
        <SelectSeparator />
        <SelectItem value="custom">Custom cron…</SelectItem>
      </SelectContent>
    </Select>
  );
}

afterEach(cleanup);

describe("Select", () => {
  it("renders the placeholder until a value is chosen and keeps the popup closed", () => {
    render(<Cadence />);
    expect(screen.getByRole("combobox", { name: "Cadence" })).toBeDefined();
    expect(screen.getByText("Pick a cadence")).toBeDefined();
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("opens from the keyboard, moves with arrows, selects with Enter, and returns focus", async () => {
    const onValueChange = vi.fn();
    render(<Cadence onValueChange={onValueChange} />);
    const trigger = screen.getByRole("combobox", { name: "Cadence" });
    trigger.focus();

    fireEvent.keyDown(trigger, { key: "ArrowDown" });
    const listbox = await screen.findByRole("listbox");

    const highlighted = () => listbox.querySelector("[data-highlighted]");
    await waitFor(() => expect(highlighted()?.textContent).toBe("Hourly"));
    fireEvent.keyDown(listbox, { key: "ArrowDown" });
    await waitFor(() => expect(highlighted()?.textContent).toBe("Daily"));

    fireEvent.keyDown(highlighted()!, { key: "Enter" });
    await waitFor(() => expect(onValueChange).toHaveBeenCalledWith("daily", expect.anything()));
    // Focus must land back on the trigger, or keyboard users are stranded on <body>.
    await waitFor(() => expect(document.activeElement).toBe(trigger));
    expect(trigger.textContent).toContain("Daily");
  });

  it("closes on Escape without changing the value", async () => {
    const onValueChange = vi.fn();
    render(<Cadence onValueChange={onValueChange} />);
    const trigger = screen.getByRole("combobox", { name: "Cadence" });
    trigger.focus();

    fireEvent.keyDown(trigger, { key: "ArrowDown" });
    const listbox = await screen.findByRole("listbox");
    fireEvent.keyDown(listbox, { key: "Escape" });

    await waitFor(() => expect(screen.queryByRole("listbox")).toBeNull());
    expect(onValueChange).not.toHaveBeenCalled();
    await waitFor(() => expect(document.activeElement).toBe(trigger));
  });

  it("marks a disabled item unselectable and renders the divider before the tail group", async () => {
    const onValueChange = vi.fn();
    render(<Cadence onValueChange={onValueChange} disabledItem />);
    fireEvent.click(screen.getByRole("combobox", { name: "Cadence" }));
    const listbox = await screen.findByRole("listbox");

    const daily = screen.getByRole("option", { name: "Daily" });
    expect(daily.getAttribute("data-disabled")).not.toBeNull();
    fireEvent.click(daily);
    expect(onValueChange).not.toHaveBeenCalled();

    expect(listbox.querySelector('[data-slot="select-separator"]')).not.toBeNull();
    expect(screen.getByRole("option", { name: "Custom cron…" })).toBeDefined();
  });

  it("ignores interaction entirely when the select is disabled", () => {
    render(
      <Select disabled>
        <SelectTrigger aria-label="Cadence">
          <SelectValue placeholder="Pick a cadence" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="hourly">Hourly</SelectItem>
        </SelectContent>
      </Select>,
    );
    const trigger = screen.getByRole("combobox", { name: "Cadence" });
    expect(trigger.getAttribute("data-disabled")).not.toBeNull();
    fireEvent.click(trigger);
    expect(screen.queryByRole("listbox")).toBeNull();
  });
});
