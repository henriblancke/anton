// @vitest-environment jsdom
/**
 * The Jev section (anton-p32iy): the toggle/key/pinned-model surface is explicit and visible, the
 * key is never round-tripped once stored, the per-point disclosure lists exactly what `stateFields`
 * would send, and health reads honestly — "no calls yet" until something has actually happened.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import { JevSection } from "@/components/settings/sections/jev-section";
import type { SettingsForm } from "@/components/settings/use-settings-form";
import type { JevHealth } from "@/lib/decide/backends/jev-fallback";

const refresh = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh }) }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

function renderSection(opts: {
  apiKeyConfigured?: boolean;
  disclosure?: { id: string; stateFields: string[] }[];
  health?: JevHealth;
  patchSettings?: SettingsForm["patchSettings"];
} = {}) {
  const set = vi.fn();
  const patchSettings = opts.patchSettings ?? vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));
  const form = {
    draft: { jevEnabled: false, jevApiKey: "", jevModel: "" },
    set,
    patchSettings,
  } as unknown as SettingsForm;
  render(
    <JevSection
      form={form}
      apiKeyConfigured={opts.apiKeyConfigured ?? false}
      disclosure={opts.disclosure ?? []}
      health={opts.health}
    />,
  );
  return { set, patchSettings };
}

afterEach(() => {
  cleanup();
  refresh.mockClear();
});

describe("JevSection — opt-in is explicit", () => {
  it("renders an off-by-default toggle that stages jevEnabled", () => {
    const { set } = renderSection();
    const toggle = screen.getByLabelText("Use Jev for decide()");
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    fireEvent.click(toggle);
    expect(set).toHaveBeenCalledWith("jevEnabled", true);
  });

  it("states that off keeps every point on claude-local", () => {
    renderSection();
    expect(screen.getByText(/claude-local/i)).toBeTruthy();
  });

  it("refuses an unpinned version in the field's own hint", () => {
    renderSection();
    expect(screen.getByText(/jev-latest.*refused/i)).toBeTruthy();
  });

  it("stages typed edits to the API key and pinned model", () => {
    const { set } = renderSection();
    fireEvent.change(screen.getByLabelText("API key"), { target: { value: "sk-test" } });
    expect(set).toHaveBeenCalledWith("jevApiKey", "sk-test");
    fireEvent.change(screen.getByLabelText("Pinned model"), { target: { value: "jev-1.13.0" } });
    expect(set).toHaveBeenCalledWith("jevModel", "jev-1.13.0");
  });
});

describe("JevSection — the key is never round-tripped", () => {
  it("masks the key field as a password input", () => {
    renderSection();
    expect(screen.getByLabelText("API key").getAttribute("type")).toBe("password");
  });

  it("invites a fresh paste when no key is stored, and never implies one already is", () => {
    renderSection({ apiKeyConfigured: false });
    expect(screen.getByLabelText("API key").getAttribute("placeholder")).toMatch(/paste/i);
    expect(screen.queryByRole("button", { name: /clear stored key/i })).toBeNull();
  });

  it("says a key is already stored without ever showing it, and offers to clear it", () => {
    renderSection({ apiKeyConfigured: true });
    expect(screen.getByText(/already stored/i)).toBeTruthy();
    expect(screen.getByText(/never shown here again/i)).toBeTruthy();
    expect(screen.getByRole("button", { name: /clear stored key/i })).toBeTruthy();
  });

  it("clearing the key PATCHes jevApiKey: null and jevEnabled: false, not the staged draft value", async () => {
    // jevEnabled must ride along: the server's own cross-check (checkJevConfigured in
    // settings-patch.ts) refuses `jevEnabled: true` with no key, so clearing a key that's actively
    // in use would otherwise 400 the whole PATCH — see settings-patch.test.ts for that real path.
    const patchSettings = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));
    renderSection({ apiKeyConfigured: true, patchSettings });
    fireEvent.click(screen.getByRole("button", { name: /clear stored key/i }));
    await vi.waitFor(() =>
      expect(patchSettings).toHaveBeenCalledWith({ jevApiKey: null, jevEnabled: false }),
    );
  });

  it("stages jevEnabled back to off locally once the clear succeeds", async () => {
    const { set } = renderSection({ apiKeyConfigured: true });
    fireEvent.click(screen.getByRole("button", { name: /clear stored key/i }));
    await vi.waitFor(() => expect(set).toHaveBeenCalledWith("jevEnabled", false));
  });

  it("refreshes the router once the clear succeeds, so the SSR-seeded apiKeyConfigured prop stops reading stale", async () => {
    renderSection({ apiKeyConfigured: true });
    fireEvent.click(screen.getByRole("button", { name: /clear stored key/i }));
    await vi.waitFor(() => expect(refresh).toHaveBeenCalled());
  });
});

describe("JevSection — per-point field disclosure", () => {
  it("lists every registered point and exactly the state fields it would send", () => {
    renderSection({
      disclosure: [
        { id: "department", stateFields: ["ticketText", "customerTier"] },
        { id: "is_urgent", stateFields: ["ticketText"] },
      ],
    });
    expect(screen.getByText("department")).toBeTruthy();
    expect(screen.getByText("ticketText, customerTier")).toBeTruthy();
    expect(screen.getByText("is_urgent")).toBeTruthy();
    expect(screen.getByText("ticketText")).toBeTruthy();
  });

  it("says plainly when no points are registered yet", () => {
    renderSection({ disclosure: [] });
    expect(screen.getByText(/no decision points are registered yet/i)).toBeTruthy();
  });
});

describe("JevSection — health reads honestly", () => {
  it("shows 'no calls yet' when nothing has exercised the backend", () => {
    renderSection();
    expect(screen.getByText(/no calls yet/i)).toBeTruthy();
  });

  it("shows healthy with no failures", () => {
    renderSection({ health: { status: "healthy", consecutiveFailures: 0 } });
    expect(screen.getByText("Healthy")).toBeTruthy();
    expect(screen.getByText(/no failures in a row/i)).toBeTruthy();
  });

  it("shows unhealthy with the failure streak and last error, after repeated failures", () => {
    renderSection({
      health: {
        status: "unhealthy",
        consecutiveFailures: 3,
        lastError: "decide/jev: systemone responded 503",
      },
    });
    expect(screen.getByText("Unhealthy")).toBeTruthy();
    expect(screen.getByText(/3 failure\(s\) in a row/i)).toBeTruthy();
    expect(screen.getByText(/systemone responded 503/)).toBeTruthy();
    expect(screen.getByText(/falling back to claude-local/i)).toBeTruthy();
  });
});
