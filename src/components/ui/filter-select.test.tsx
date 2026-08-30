// @vitest-environment jsdom
/**
 * The one native filter select the board, jobs and tickets bars share (anton-xhm4). What each bar
 * keeps for itself — the id prefix, the empty-option label, the wrapper — is exactly what these
 * assertions pin, because that is what a careless "simplification" of the shared component would
 * flatten across all three surfaces at once.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import { FilterSelect, withActive } from "@/components/ui/filter-select";

const OPTIONS = [
  { value: "high", label: "High" },
  { value: "low", label: "Low" },
];

afterEach(() => {
  cleanup();
});

describe("FilterSelect", () => {
  it("namespaces the id per surface and labels the control for screen readers only", () => {
    render(
      <FilterSelect
        idPrefix="ticket-filter"
        field="risk"
        label="Risk"
        value=""
        options={OPTIONS}
        onChange={() => {}}
      />,
    );

    const select = screen.getByLabelText("Risk") as HTMLSelectElement;
    expect(select.id).toBe("ticket-filter-risk");
    expect(select.tagName).toBe("SELECT");
    expect(document.querySelector("label[for='ticket-filter-risk']")?.className).toContain("sr-only");
  });

  it("prepends the empty option only when the call site names one", () => {
    const { unmount } = render(
      <FilterSelect
        idPrefix="board-filter"
        field="epic"
        label="Epic"
        emptyLabel="Epic: All"
        value=""
        options={OPTIONS}
        onChange={() => {}}
      />,
    );
    expect([...(screen.getByLabelText("Epic") as HTMLSelectElement).options].map((o) => o.text)).toEqual([
      "Epic: All",
      "High",
      "Low",
    ]);
    unmount();

    // The jobs bar carries its own `value=""` entry ("Active"), so a second one would be a bug.
    render(
      <FilterSelect
        idPrefix="job-filter"
        field="status"
        label="Status"
        value=""
        options={OPTIONS}
        onChange={() => {}}
      />,
    );
    expect([...(screen.getByLabelText("Status") as HTMLSelectElement).options].map((o) => o.text)).toEqual([
      "High",
      "Low",
    ]);
  });

  it("wraps label and select only when the bar asks for a wrapper", () => {
    const { container, unmount } = render(
      <FilterSelect
        idPrefix="board-filter"
        field="area"
        label="Area"
        value=""
        options={OPTIONS}
        onChange={() => {}}
      />,
    );
    // The board bar lays its own flex row out; a wrapper would break the row.
    expect(container.querySelector("div")).toBeNull();
    expect(container.firstElementChild?.tagName).toBe("LABEL");
    unmount();

    const stacked = render(
      <FilterSelect
        idPrefix="ticket-filter"
        field="area"
        label="Area"
        wrapperClassName="flex flex-col gap-1"
        value=""
        options={OPTIONS}
        onChange={() => {}}
      />,
    );
    const wrapper = stacked.container.firstElementChild as HTMLElement;
    expect(wrapper.tagName).toBe("DIV");
    expect(wrapper.className).toBe("flex flex-col gap-1");
    expect(wrapper.querySelector("select")).toBeTruthy();
  });

  it("lets a call site override a width without losing the shared control styling", () => {
    render(
      <FilterSelect
        idPrefix="job-filter"
        field="type"
        label="Type"
        className="min-w-28"
        value=""
        options={OPTIONS}
        onChange={() => {}}
      />,
    );

    const className = (screen.getByLabelText("Type") as HTMLSelectElement).className;
    expect(className).toContain("min-w-28");
    expect(className).not.toContain("min-w-24");
    expect(className).toContain("border-border");
    expect(className).toContain("focus-visible:ring-ring/50");
  });

  it("reports the raw picked value, empty string included", () => {
    const onChange = vi.fn();
    render(
      <FilterSelect
        idPrefix="board-filter"
        field="epic"
        label="Epic"
        emptyLabel="Epic: All"
        value="high"
        options={OPTIONS}
        onChange={onChange}
      />,
    );

    const select = screen.getByLabelText("Epic") as HTMLSelectElement;
    expect(select.value).toBe("high");
    fireEvent.change(select, { target: { value: "" } });
    expect(onChange).toHaveBeenCalledWith("");
  });
});

describe("withActive", () => {
  it("keeps a filtered-to value selectable after it drops out of the result set", () => {
    expect(withActive(OPTIONS, "gone")).toEqual([...OPTIONS, { value: "gone", label: "gone" }]);
  });

  it("leaves the list alone when the active value is already offered, or absent", () => {
    expect(withActive(OPTIONS, "high")).toBe(OPTIONS);
    expect(withActive(OPTIONS, undefined)).toBe(OPTIONS);
    expect(withActive(OPTIONS, "")).toBe(OPTIONS);
  });
});
