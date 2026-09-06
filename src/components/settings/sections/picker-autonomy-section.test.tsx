// @vitest-environment jsdom
/**
 * The picker autonomy panel: the optimistic overlay's reconciliation (PR #218 review), and the three
 * states the ladder has to render honestly (anton-z1lp) — locked, earned, and deliberately armed.
 *
 * `router.refresh()` re-renders this Client Component with fresh server props but KEEPS its state,
 * so the pending choice has to be dropped when the server's answer moves — otherwise the control
 * goes on reporting a level the picker is no longer running at.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

import { EARNED_AUTONOMY_BARS, PICKER_AUTONOMY_TIER } from "@/lib/gardener/autonomy";
import {
  NO_PICKER_RECORD,
  PICKER_BAR,
  PickerAutonomySection,
  type EarnedPicker,
} from "@/components/settings/sections/picker-autonomy-section";

const refresh = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh }) }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const EARNED: EarnedPicker = {
  accepted: 20,
  settled: 20,
  bar: PICKER_BAR,
  arming: "earned",
};

/** A record short of the bar, with the server's own reason for it. */
const LOCKED: EarnedPicker = {
  accepted: 12,
  settled: 15,
  bar: PICKER_BAR,
  reason: "12/15 released — apply unlocks at 20 answered with 90% released",
};

/** The same record, with an operator's signature standing in for it. */
const DELIBERATE: EarnedPicker = {
  ...LOCKED,
  arming: "deliberate",
  deliberate: { by: "henri", at: "2026-09-06T17:10:05.000Z" },
};

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  refresh.mockClear();
});

const radio = (level: string) => screen.getByLabelText(`picker · ${level}`) as HTMLInputElement;
const okFetch = () => {
  const fetchMock = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
};

describe("PickerAutonomySection", () => {
  it("drops the pending choice once the server's resolved level moves under it", async () => {
    okFetch();

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
    const fetchMock = okFetch();

    render(<PickerAutonomySection slug="p1" armed stored="shadow" earned={EARNED} />);
    fireEvent.click(radio("apply"));

    // No refreshed props yet — the overlay is the only thing that can report the operator's act.
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(radio("apply").checked).toBe(true);
  });

  it("lets the operator drop a floored `apply` by choosing the level it is already running at", async () => {
    const fetchMock = okFetch();

    // Stored `apply`, floored to `shadow` by an empty record: the shadow radio already reads as
    // checked, so the click that cancels the pending return to apply emits no change event.
    render(<PickerAutonomySection slug="p1" armed stored="apply" earned={NO_PICKER_RECORD} />);
    expect(radio("shadow").checked).toBe(true);

    fireEvent.click(radio("shadow"));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({
      pickerAutonomy: "shadow",
    });
  });

  it("saves a real selection once, not twice", async () => {
    const fetchMock = okFetch();

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

describe("PickerAutonomySection ladder (anton-z1lp)", () => {
  it("mirrors the server's own bar, so the fallback record can never quote a stale one", () => {
    expect(PICKER_BAR).toEqual(EARNED_AUTONOMY_BARS[PICKER_AUTONOMY_TIER]);
  });

  it("locked: shows the counts, both rungs of the bar, and why apply is unavailable", () => {
    render(<PickerAutonomySection slug="p1" armed stored="shadow" earned={LOCKED} />);

    expect(screen.getByText("15/20")).toBeTruthy();
    expect(screen.getByText("80%/90%")).toBeTruthy();
    expect(screen.getByText("12 of 15 answered")).toBeTruthy();
    expect(screen.getByText(/apply locked · 12\/15 released — apply unlocks at 20 answered/)).toBeTruthy();
    expect(radio("apply").disabled).toBe(true);
  });

  it("locked: offers the deliberate arming, and only behind an acknowledged confirmation", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ armedBy: "henri" }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    render(<PickerAutonomySection slug="p1" armed stored="shadow" earned={LOCKED} />);
    fireEvent.click(screen.getByRole("button", { name: /Arm deliberately/ }));

    // The confirmation names what it bypasses AND what still holds — the record's own reason, the
    // work policy, the brakes, the budget, the log, and that it can be revoked.
    const dialog = within(screen.getByRole("dialog"));
    expect(dialog.getByText("What this bypasses")).toBeTruthy();
    expect(dialog.getByText("What still protects this project")).toBeTruthy();
    expect(dialog.getByText(/12\/15 released — apply unlocks at 20 answered/)).toBeTruthy();
    expect(dialog.getByText(/work policy/)).toBeTruthy();
    expect(dialog.getByText(/brakes/)).toBeTruthy();
    expect(dialog.getByText(/budget/)).toBeTruthy();
    expect(dialog.getByText(/decision log/)).toBeTruthy();
    expect(dialog.getByText(/revocable/)).toBeTruthy();

    // Unacknowledged, the confirm is inert — no acknowledgement, no arming.
    const confirm = dialog.getByRole("button", {
      name: /Arm apply deliberately/,
    }) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    fireEvent.click(confirm);
    expect(fetchMock).not.toHaveBeenCalled();

    fireEvent.click(dialog.getByRole("checkbox"));
    fireEvent.click(dialog.getByRole("button", { name: /Arm apply deliberately/ }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe("/api/projects/p1/picker/arming");
    expect(fetchMock.mock.calls[0]?.[1]?.method).toBe("POST");
    await waitFor(() => expect(refresh).toHaveBeenCalled());
  });

  it("earned: says the record clears the bar, and offers no bypass of a floor that is not holding", () => {
    render(<PickerAutonomySection slug="p1" armed stored="apply" earned={EARNED} />);

    expect(radio("apply").checked).toBe(true);
    expect(screen.getByText(/this record clears the bar/)).toBeTruthy();
    expect(screen.getByText(/earned by the record below/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Arm deliberately/ })).toBeNull();
  });

  it("deliberate: labels the level as armed, never as earned, and names who signed for it", () => {
    render(<PickerAutonomySection slug="p1" armed stored="apply" earned={DELIBERATE} />);

    expect(radio("apply").checked).toBe(true);
    expect(screen.getByText(/armed deliberately — not earned/)).toBeTruthy();
    expect(screen.queryByText(/earned by the record below/)).toBeNull();
    expect(screen.getByText("henri")).toBeTruthy();
    // The record it stands in for is still shown, unblurred by the signature.
    expect(
      screen.getByText(/record does not support apply · 12\/15 released — apply unlocks/),
    ).toBeTruthy();
  });

  it("deliberate: revoking is one click, and settles on the level the server reports back", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ autonomy: "shadow" }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    render(<PickerAutonomySection slug="p1" armed stored="apply" earned={DELIBERATE} />);
    fireEvent.click(screen.getByRole("button", { name: /Revoke arming/ }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe("/api/projects/p1/picker/arming");
    expect(fetchMock.mock.calls[0]?.[1]?.method).toBe("DELETE");
    await waitFor(() => expect(refresh).toHaveBeenCalled());
  });

  it("a project with no work policy is offered no arming — the structural floor moves for nobody", () => {
    render(<PickerAutonomySection slug="p1" armed={false} stored="shadow" earned={LOCKED} />);

    expect(screen.queryByRole("button", { name: /Arm deliberately/ })).toBeNull();
    expect(screen.getByText(/apply also needs a work policy/)).toBeTruthy();
  });

  it("a standing signature is still shown once the record has caught up, and no longer claims to hold apply up", () => {
    render(
      <PickerAutonomySection
        slug="p1"
        armed
        stored="apply"
        earned={{ ...EARNED, deliberate: DELIBERATE.deliberate }}
      />,
    );

    expect(screen.getByText(/earned by the record below/)).toBeTruthy();
    expect(screen.getByText("henri")).toBeTruthy();
    expect(screen.getByText(/no longer rests on this signature/)).toBeTruthy();
  });
});
