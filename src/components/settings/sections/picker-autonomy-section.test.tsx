// @vitest-environment jsdom
/**
 * The optimistic overlay's reconciliation (PR #218 review). `router.refresh()` re-renders this
 * Client Component with fresh server props but KEEPS its state, so the pending choice has to be
 * dropped when the server's answer moves — otherwise the control goes on reporting a level the
 * picker is no longer running at.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

import {
  NO_PICKER_RECORD,
  PickerAutonomySection,
  type EarnedPicker,
} from "@/components/settings/sections/picker-autonomy-section";

const refresh = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh }) }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const EARNED: EarnedPicker = { accepted: 20, settled: 20, eligible: true };

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  refresh.mockClear();
});

const radio = (level: string) => screen.getByLabelText(`picker · ${level}`) as HTMLInputElement;

describe("PickerAutonomySection", () => {
  it("drops the pending choice once the server's resolved level moves under it", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const { rerender } = render(
      <PickerAutonomySection slug="p1" armed stored={undefined} earned={EARNED} />,
    );

    fireEvent.click(radio("apply"));
    await waitFor(() => expect(refresh).toHaveBeenCalled());
    expect(radio("apply").checked).toBe(true);

    // The refresh lands: the server now stores what was chosen, and the overlay agrees with it.
    rerender(<PickerAutonomySection slug="p1" armed stored="apply" earned={EARNED} />);
    expect(radio("apply").checked).toBe(true);

    // The work policy is removed in the panel above. The structural floor demotes the picker to
    // `shadow`, and the control has to say so rather than keep showing the choice that is now void.
    rerender(
      <PickerAutonomySection slug="p1" armed={false} stored="apply" earned={NO_PICKER_RECORD} />,
    );
    expect(radio("apply").checked).toBe(false);
    expect(radio("shadow").checked).toBe(true);
    expect(screen.getByText(/anton is running this picker at/)).toBeTruthy();
  });

  it("keeps showing the pending choice while the save is still in flight", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    render(<PickerAutonomySection slug="p1" armed stored="shadow" earned={EARNED} />);
    fireEvent.click(radio("apply"));

    // No refreshed props yet — the overlay is the only thing that can report the operator's act.
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(radio("apply").checked).toBe(true);
  });

  it("lets the operator drop a floored `apply` by choosing the level it is already running at", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    // Stored `apply`, floored to `shadow` by an empty record: the shadow radio already reads as
    // checked, so the click that cancels the pending return to apply emits no change event.
    render(
      <PickerAutonomySection slug="p1" armed stored="apply" earned={NO_PICKER_RECORD} />,
    );
    expect(radio("shadow").checked).toBe(true);

    fireEvent.click(radio("shadow"));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({
      pickerAutonomy: "shadow",
    });
  });

  it("saves a real selection once, not twice", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    render(<PickerAutonomySection slug="p1" armed stored="shadow" earned={EARNED} />);
    fireEvent.click(radio("apply"));

    await waitFor(() => expect(refresh).toHaveBeenCalled());
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("falls back to the stored level when the save is refused", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: "nope" }), { status: 400 })),
    );

    render(<PickerAutonomySection slug="p1" armed stored="shadow" earned={EARNED} />);
    fireEvent.click(radio("apply"));

    await waitFor(() => expect(radio("shadow").checked).toBe(true));
    expect(radio("apply").checked).toBe(false);
  });
});
