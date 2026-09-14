// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import { TicketDetailsSection } from "@/components/ticket/ticket-details-section";
import { draftFromDetail, type TicketDraft } from "@/components/ticket/ticket-dialog-utils";
import type { TicketDetail } from "@/lib/types";

const draft = (over: Partial<TicketDraft> = {}): TicketDraft => ({
  ...draftFromDetail({
    id: "bd-1",
    title: "Do the thing",
    status: "open",
    stage: "backlog",
    type: "task",
    priority: 2,
    agent: "nextjs",
    risk: "low",
    size: "M",
    assignee: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    createdBy: null,
    approved: false,
    deferred: false,
    abandoned: false,
    notes: [],
  } as TicketDetail),
  ...over,
});

function show(over: Partial<TicketDraft> = {}, deferred = false) {
  const set = vi.fn();
  render(<TicketDetailsSection draft={draft(over)} deferred={deferred} set={set} />);
  return set;
}

const option = (select: HTMLSelectElement, value: string) =>
  [...select.options].find((o) => o.value === value);

afterEach(cleanup);

describe("the collapsed summary", () => {
  it("folds the whole draft into one line, omitting absent labels", () => {
    show();
    expect(screen.getByText("· Open · P2 · nextjs · risk:low · size:M")).toBeDefined();

    cleanup();
    show({ priority: undefined, agent: "", risk: "", size: "" });
    expect(screen.getByText("· Open")).toBeDefined();
  });

  it("reads a snoozed ticket as Snoozed, whatever the draft's raw status says", () => {
    show({ priority: undefined, agent: "", risk: "", size: "" }, true);
    expect(screen.getByText("· Snoozed")).toBeDefined();
  });
});

describe("the fields grid", () => {
  it("shows every editable field seeded from the draft", () => {
    show();
    expect((screen.getByLabelText("Status") as HTMLSelectElement).value).toBe("open");
    expect((screen.getByLabelText("Priority") as HTMLSelectElement).value).toBe("2");
    expect((screen.getByLabelText("Agent") as HTMLSelectElement).value).toBe("nextjs");
    expect((screen.getByLabelText("Risk") as HTMLSelectElement).value).toBe("low");
    expect((screen.getByLabelText("Size") as HTMLSelectElement).value).toBe("M");
  });

  it("sets the draft field its select owns", () => {
    const set = show();

    fireEvent.change(screen.getByLabelText("Status"), { target: { value: "in_progress" } });
    expect(set).toHaveBeenCalledWith("status", "in_progress");

    fireEvent.change(screen.getByLabelText("Agent"), { target: { value: "supabase" } });
    expect(set).toHaveBeenCalledWith("agent", "supabase");

    fireEvent.change(screen.getByLabelText("Risk"), { target: { value: "high" } });
    expect(set).toHaveBeenCalledWith("risk", "high");

    fireEvent.change(screen.getByLabelText("Size"), { target: { value: "L" } });
    expect(set).toHaveBeenCalledWith("size", "L");
  });

  it("labels risk and size with their bd label spelling", () => {
    show();
    expect(option(screen.getByLabelText("Risk") as HTMLSelectElement, "high")!.text).toBe(
      "risk:high",
    );
    expect(option(screen.getByLabelText("Size") as HTMLSelectElement, "S")!.text).toBe("size:S");
  });
});

describe("Status on a snoozed ticket", () => {
  it("shows Snoozed read-only — the state bar owns that status", () => {
    show({}, true);
    const status = screen.getByLabelText("Status") as HTMLSelectElement;
    expect(status.disabled).toBe(true);
    expect(status.value).toBe("deferred");
    expect(status.options.length).toBe(1);
  });
});

describe("Priority", () => {
  it("keeps an em-dash option only while the bead has no priority, and sends a number", () => {
    const set = show({ priority: undefined });
    const priority = screen.getByLabelText("Priority") as HTMLSelectElement;
    expect(priority.value).toBe("");
    expect(option(priority, "")).toBeDefined();

    fireEvent.change(priority, { target: { value: "0" } });
    expect(set).toHaveBeenCalledWith("priority", 0);

    cleanup();
    show({ priority: 2 });
    expect(option(screen.getByLabelText("Priority") as HTMLSelectElement, "")).toBeUndefined();
  });
});

describe("optional label fields", () => {
  it('offers "none" only while the label is unset — the API can set a label but not clear one', () => {
    show({ agent: "" });
    expect(option(screen.getByLabelText("Agent") as HTMLSelectElement, "")!.text).toBe("none");

    cleanup();
    show({ agent: "nextjs" });
    expect(option(screen.getByLabelText("Agent") as HTMLSelectElement, "")).toBeUndefined();
  });
});
