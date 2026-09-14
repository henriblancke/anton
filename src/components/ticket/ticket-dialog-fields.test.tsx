// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import { ContractField, Select, TitleField } from "@/components/ticket/ticket-dialog-fields";

afterEach(cleanup);

describe("TitleField", () => {
  it("renders the current title under its accessible name and reports edits", () => {
    const onChange = vi.fn();
    render(<TitleField value="Do the thing" onChange={onChange} />);

    const input = screen.getByLabelText("Title") as HTMLInputElement;
    expect(input.value).toBe("Do the thing");

    fireEvent.change(input, { target: { value: "Do it better" } });
    expect(onChange).toHaveBeenCalledWith("Do it better");
  });
});

describe("Select", () => {
  const options = (
    <>
      <option value="open">Open</option>
      <option value="closed">Closed</option>
    </>
  );

  it("labels the select, shows the selected option, and reports the picked value", () => {
    const onChange = vi.fn();
    render(
      <Select label="Status" value="open" onChange={onChange}>
        {options}
      </Select>,
    );

    const select = screen.getByLabelText("Status") as HTMLSelectElement;
    expect(select.value).toBe("open");
    expect(screen.getByText("Status")).toBeDefined();

    fireEvent.change(select, { target: { value: "closed" } });
    expect(onChange).toHaveBeenCalledWith("closed");
  });

  it("renders read-only when disabled", () => {
    render(
      <Select label="Status" value="open" onChange={vi.fn()} disabled>
        {options}
      </Select>,
    );
    expect((screen.getByLabelText("Status") as HTMLSelectElement).disabled).toBe(true);
  });
});

describe("ContractField", () => {
  it("renders a labelled textarea with its hint, rows and placeholder", () => {
    render(
      <ContractField
        label="Acceptance"
        hint="one checkbox per outcome"
        value="- [ ] it ships"
        onChange={vi.fn()}
        rows={6}
        placeholder="- [ ] …"
      />,
    );

    const textarea = screen.getByLabelText("Acceptance") as HTMLTextAreaElement;
    expect(textarea.value).toBe("- [ ] it ships");
    expect(textarea.rows).toBe(6);
    expect(textarea.placeholder).toBe("- [ ] …");
    expect(screen.getByText("one checkbox per outcome")).toBeDefined();
  });

  it("omits the hint when none is given, and reports edits", () => {
    const onChange = vi.fn();
    render(<ContractField label="Goal" value="Ship it" onChange={onChange} rows={3} />);

    expect(screen.queryByText("one checkbox per outcome")).toBeNull();
    expect((screen.getByLabelText("Goal") as HTMLTextAreaElement).placeholder).toBe("");
    fireEvent.change(screen.getByLabelText("Goal"), { target: { value: "Ship it twice" } });
    expect(onChange).toHaveBeenCalledWith("Ship it twice");
  });
});
