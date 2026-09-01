// @vitest-environment jsdom
/**
 * The two vetoes (anton-jqvy / R3.9). What these pin is the difference between them: both record a
 * decline on one target, and only `Never` carries the operator to the rule that admitted it.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

import { VetoActions, criterionLabel, policyHref } from "@/components/board/veto-actions";

const refresh = vi.fn();
const push = vi.fn();
const success = vi.fn();
const error = vi.fn();

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh, push }) }));
vi.mock("sonner", () => ({
  toast: {
    success: (...a: unknown[]) => success(...a),
    error: (...a: unknown[]) => error(...a),
  },
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

const UNTIL = Date.now() + 24 * 60 * 60 * 1000;

function stubFetch(body: unknown, status = 200) {
  const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(body), { status }));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function mount(over: Partial<Parameters<typeof VetoActions>[0]> = {}) {
  return render(<VetoActions slug="anton" beadId="anton-a" {...over} />);
}

describe("✕ not now", () => {
  it("defers that ONE target and refreshes the surface that draws the hold", async () => {
    const fetchMock = stubFetch({ beadId: "anton-a", action: "not-now", deferredUntil: UNTIL });
    const onVetoed = vi.fn();
    mount({ onVetoed });

    fireEvent.click(screen.getByRole("button", { name: /not now/i }));

    await waitFor(() => expect(refresh).toHaveBeenCalled());
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/projects/anton/picker/veto",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ beadId: "anton-a", action: "not-now" }),
      }),
    );
    expect(onVetoed).toHaveBeenCalledWith(UNTIL);
    // It sets one target aside; it never navigates away from the board.
    expect(push).not.toHaveBeenCalled();
  });

  it("says nothing happened when the write failed, and lets the operator try again", async () => {
    stubFetch({ error: "anton.db is locked" }, 500);
    mount();

    fireEvent.click(screen.getByRole("button", { name: /not now/i }));

    await waitFor(() => expect(error).toHaveBeenCalledWith("anton.db is locked"));
    expect(refresh).not.toHaveBeenCalled();
    expect(
      screen.getByRole("button", { name: /not now/i }).hasAttribute("disabled"),
    ).toBe(false);
  });
});

describe("Never", () => {
  it("records the decline and opens the policy at the criterion that admitted the bead", async () => {
    const fetchMock = stubFetch({
      beadId: "anton-a",
      action: "never",
      deferredUntil: UNTIL,
      criterion: "labels:domain",
    });
    mount();

    fireEvent.click(screen.getByRole("button", { name: "Never" }));

    await waitFor(() =>
      expect(push).toHaveBeenCalledWith("/projects/anton/settings?criterion=labels%3Adomain#policy"),
    );
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/projects/anton/picker/veto",
      expect.objectContaining({ body: JSON.stringify({ beadId: "anton-a", action: "never" }) }),
    );
  });

  it("defers the target too — the veto holds while the operator edits the rule", async () => {
    stubFetch({ deferredUntil: UNTIL, criterion: "types" });
    const onVetoed = vi.fn();
    mount({ onVetoed });

    fireEvent.click(screen.getByRole("button", { name: "Never" }));

    await waitFor(() => expect(onVetoed).toHaveBeenCalledWith(UNTIL));
  });

  it("opens the panel, not a control, when no criterion admits it — and says so", async () => {
    stubFetch({ deferredUntil: UNTIL, criterion: null });
    mount();

    fireEvent.click(screen.getByRole("button", { name: "Never" }));

    await waitFor(() => expect(push).toHaveBeenCalledWith("/projects/anton/settings#policy"));
    expect(success).toHaveBeenCalledWith(
      "Declined — tighten the rule",
      expect.objectContaining({
        description: expect.stringContaining("No criterion admits this yet"),
      }),
    );
  });
});

describe("a target already set aside", () => {
  it("reads as deferred with its own countdown, rather than offering the veto again", () => {
    mount({ notNowUntil: UNTIL });

    expect(screen.getByText(/set aside/i)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /not now/i })).toBeNull();
    expect(screen.queryByRole("button", { name: "Never" })).toBeNull();
  });
});

describe("the policy deep link", () => {
  it("names the criterion as the editor labels it", () => {
    expect(criterionLabel("labels:severity")).toBe("severity:");
    expect(criterionLabel("priority")).toBe("priority");
  });

  it("keeps the section in the hash and the criterion beside it", () => {
    expect(policyHref("anton", "labels:domain")).toBe(
      "/projects/anton/settings?criterion=labels%3Adomain#policy",
    );
    expect(policyHref("anton")).toBe("/projects/anton/settings#policy");
  });
});
