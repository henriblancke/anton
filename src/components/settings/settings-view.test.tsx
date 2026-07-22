// @vitest-environment jsdom
/**
 * Budget-policy knobs in the settings form (anton-egrg): the daytime-reserve and weekly-target
 * inputs seed from a persisted policy (round-trip in), and Save PATCHes the edited values back.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import { SettingsView } from "@/components/settings/settings-view";
import type { Project } from "@/lib/types";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const project: Project = {
  id: "p1",
  slug: "tmp",
  name: "tmp",
  repoPath: "/tmp/p1",
  defaultBranch: "main",
  hasBeads: true,
  createdAt: 0,
};

function renderView(settings: Parameters<typeof SettingsView>[0]["settings"] = {}) {
  return render(
    <SettingsView
      project={project}
      settings={settings}
      basePrompt="base"
      schedules={[]}
      agents={[]}
    />,
  );
}

/** Stub fetch so Save's PATCH resolves; return the mock to assert the request body. */
function stubFetch() {
  const fetchMock = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(() =>
    Promise.resolve(new Response(JSON.stringify({ settings: {} }), { status: 200 })),
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("SettingsView budget policy (anton-egrg)", () => {
  it("seeds the two knobs from a persisted policy (round-trip in)", () => {
    renderView({ budgetPolicy: { daytimeReservePct: 25, weeklyTargetPct: 80 } });
    expect((screen.getByLabelText("Daytime reserve") as HTMLInputElement).value).toBe("25");
    expect((screen.getByLabelText("Weekly cap") as HTMLInputElement).value).toBe("80");
  });

  it("falls back to defaults when no policy is persisted", () => {
    renderView({});
    expect((screen.getByLabelText("Daytime reserve") as HTMLInputElement).value).toBe("15");
    expect((screen.getByLabelText("Weekly cap") as HTMLInputElement).value).toBe("90");
  });

  it("PATCHes the edited knobs on Save (round-trip out)", async () => {
    const fetchMock = stubFetch();
    renderView({});

    // The knobs are gated behind the budget-aware toggle (off by default) — enable it first.
    fireEvent.click(screen.getByRole("switch", { name: "Budget-aware execution" }));
    fireEvent.change(screen.getByLabelText("Daytime reserve"), { target: { value: "30" } });
    fireEvent.change(screen.getByLabelText("Weekly cap"), { target: { value: "70" } });
    fireEvent.click(screen.getByRole("button", { name: /save changes/i }));

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/projects/tmp/settings",
      expect.objectContaining({ method: "PATCH" }),
    );
    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(body.budgetAware).toBe(true);
    expect(body.budgetPolicy).toEqual({ daytimeReservePct: 30, weeklyTargetPct: 70 });
  });

  it("clamps an out-of-range knob to [0,100]", () => {
    renderView({});
    fireEvent.click(screen.getByRole("switch", { name: "Budget-aware execution" }));
    const reserve = screen.getByLabelText("Daytime reserve") as HTMLInputElement;
    fireEvent.change(reserve, { target: { value: "150" } });
    expect(reserve.value).toBe("100");
  });
});

describe("SettingsView budget-aware master-switch (anton-7mpv.1)", () => {
  it("is off by default and disables the knobs", () => {
    renderView({});
    expect(screen.getByRole("switch", { name: "Budget-aware execution" }).getAttribute("aria-checked")).toBe("false");
    expect((screen.getByLabelText("Daytime reserve") as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByLabelText("Weekly cap") as HTMLInputElement).disabled).toBe(true);
  });

  it("seeds ON from persisted settings and enables the knobs (round-trip in)", () => {
    renderView({ budgetAware: true });
    expect(screen.getByRole("switch", { name: "Budget-aware execution" }).getAttribute("aria-checked")).toBe("true");
    expect((screen.getByLabelText("Daytime reserve") as HTMLInputElement).disabled).toBe(false);
  });

  it("PATCHes budgetAware:false when left off (round-trip out)", () => {
    const fetchMock = stubFetch();
    renderView({});
    fireEvent.click(screen.getByRole("button", { name: /save changes/i }));
    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(body.budgetAware).toBe(false);
  });
});
