// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

import { TicketDialogFooter } from "@/components/ticket/ticket-dialog-footer";
import type { TicketDetail } from "@/lib/types";

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() } }));

const detail = (over: Partial<TicketDetail> = {}): TicketDetail =>
  ({
    id: "bd-1",
    title: "Do the thing",
    status: "open",
    stage: "backlog",
    type: "task",
    assignee: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    createdBy: null,
    approved: false,
    deferred: false,
    abandoned: false,
    notes: [],
    ...over,
  }) as TicketDetail;

type Props = React.ComponentProps<typeof TicketDialogFooter>;

function show(over: Partial<Props> = {}) {
  const handlers = {
    onRun: vi.fn(),
    onReset: vi.fn(),
    onSave: vi.fn(),
    onDelete: vi.fn(async () => {}),
  };
  render(
    <TicketDialogFooter
      detail={detail()}
      approved={false}
      running={false}
      saving={false}
      changed={false}
      {...handlers}
      {...over}
    />,
  );
  return handlers;
}

const button = (name: RegExp | string) =>
  screen.getByRole("button", { name }) as HTMLButtonElement;

afterEach(cleanup);

describe("the edit actions", () => {
  it("leaves Save and Reset dead while there is nothing to PATCH", () => {
    show({ changed: false });
    expect(button("Reset").disabled).toBe(true);
    expect(button("Save").disabled).toBe(true);
  });

  it("arms Save and Reset once the draft is dirty", () => {
    const { onSave, onReset } = show({ changed: true });
    fireEvent.click(button("Save"));
    fireEvent.click(button("Reset"));
    expect(onSave).toHaveBeenCalled();
    expect(onReset).toHaveBeenCalled();
  });

  it("shows the save in flight and locks both actions while it runs", () => {
    show({ changed: true, saving: true });
    expect(button("Saving…").disabled).toBe(true);
    expect(button("Reset").disabled).toBe(true);
  });
});

describe("the run action", () => {
  it("offers a first approval on an unapproved standalone target", () => {
    const { onRun } = show();
    fireEvent.click(button("Approve & run"));
    expect(onRun).toHaveBeenCalled();
  });

  it("reads as a Force run once approved, and as pending while starting", () => {
    show({ approved: true });
    expect(button("Force run")).toBeDefined();

    cleanup();
    show({ approved: true, running: true });
    expect(button("Starting…").disabled).toBe(true);
  });

  it("withholds the run the way the approve route would, naming the blocking gap", () => {
    const contract = {
      blocking: [{ section: "Acceptance", severity: "blocking", message: "missing Acceptance" }],
      advisory: [],
    } as unknown as TicketDetail["contract"];
    const { onRun } = show({ detail: detail({ contract }) });

    const blocked = button(/Approve & run:/);
    expect(blocked.disabled).toBe(true);
    fireEvent.click(blocked);
    expect(onRun).not.toHaveBeenCalled();
  });

  it("hides the run entirely where approving could only 422 or duplicate work", () => {
    // A child ticket runs via its epic; a done target already produced its PR; a snoozed one is
    // explicitly "not yet".
    for (const over of [
      { epicId: "anton-epic" },
      { type: "learning" },
      { stage: "done" as const },
      { deferred: true },
    ]) {
      show({ detail: detail(over) });
      expect(screen.queryByRole("button", { name: /run/i })).toBeNull();
      cleanup();
    }
  });
});

describe("delete", () => {
  it("stays behind an inline confirm before it fires", async () => {
    const { onDelete } = show();

    fireEvent.click(button("Delete ticket"));
    expect(onDelete).not.toHaveBeenCalled();

    fireEvent.click(button("Confirm delete"));
    await waitFor(() => expect(onDelete).toHaveBeenCalled());
  });
});
