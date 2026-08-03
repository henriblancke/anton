// @vitest-environment jsdom
/**
 * Budget-policy knobs in the settings form (anton-egrg): the daytime-reserve and weekly-target
 * inputs seed from a persisted policy (round-trip in), and Save PATCHes the edited values back.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { toast } from "sonner";

import { SettingsView } from "@/components/settings/settings-view";
import { formatExactTime } from "@/lib/time";
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

/** Mirrors DEFAULT_SCHEDULES (src/lib/schedules.ts), which the page passes in from the server. */
const DEFAULT_CRONS = {
  "review-fix": "*/15 * * * *",
  "nightly-stringer": "0 3 * * *",
  "orphan-grooming": "0 4 * * 1",
  "run-health": "0 * * * *",
  unstick: "10 * * * *",
  "gate-check": "*/10 * * * *",
  gardener: "0 5 * * *",
};

function renderView(
  settings: Parameters<typeof SettingsView>[0]["settings"] = {},
  agents: Parameters<typeof SettingsView>[0]["agents"] = [],
  schedules: Parameters<typeof SettingsView>[0]["schedules"] = [],
) {
  return render(
    <SettingsView
      project={project}
      settings={settings}
      basePrompt="base"
      schedules={schedules}
      defaultCrons={DEFAULT_CRONS}
      agents={agents}
      bundledIds={[]}
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

describe("SettingsView self-review section (anton-of1m)", () => {
  const reviewers: Parameters<typeof SettingsView>[0]["agents"] = [
    { id: "nextjs", source: "bundled", description: "frontend" },
    { id: "my-reviewer", source: "project" },
  ];

  it("is ON with the default knobs when nothing is persisted", () => {
    renderView({}, reviewers);
    expect(
      screen.getByRole("switch", { name: "Review before opening the PR" }).getAttribute("aria-checked"),
    ).toBe("true");
    expect((screen.getByLabelText("Reviewer") as HTMLSelectElement).value).toBe("");
    expect((screen.getByLabelText("Max review rounds") as HTMLInputElement).value).toBe("2");
    expect((screen.getByLabelText("Review prompt") as HTMLTextAreaElement).value).toBe("");
  });

  it("seeds every knob from persisted settings (round-trip in)", () => {
    renderView(
      {
        reviewEnabled: true,
        reviewAgent: "my-reviewer",
        reviewPrompt: "Only data loss.",
        reviewMaxRounds: 4,
      },
      reviewers,
    );
    expect((screen.getByLabelText("Reviewer") as HTMLSelectElement).value).toBe("my-reviewer");
    expect((screen.getByLabelText("Max review rounds") as HTMLInputElement).value).toBe("4");
    expect((screen.getByLabelText("Review prompt") as HTMLTextAreaElement).value).toBe(
      "Only data loss.",
    );
  });

  it("PATCHes the edited reviewer, prompt and cap on Save (round-trip out)", () => {
    const fetchMock = stubFetch();
    renderView({}, reviewers);

    fireEvent.change(screen.getByLabelText("Reviewer"), { target: { value: "my-reviewer" } });
    fireEvent.change(screen.getByLabelText("Max review rounds"), { target: { value: "3" } });
    fireEvent.change(screen.getByLabelText("Review prompt"), { target: { value: "Only data loss." } });
    fireEvent.click(screen.getByRole("button", { name: /save changes/i }));

    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(body).toMatchObject({
      reviewEnabled: true,
      reviewAgent: "my-reviewer",
      reviewPrompt: "Only data loss.",
      reviewMaxRounds: 3,
    });
  });

  it("PATCHes reviewEnabled:false and disables the knobs when turned off", () => {
    const fetchMock = stubFetch();
    renderView({}, reviewers);

    fireEvent.click(screen.getByRole("switch", { name: "Review before opening the PR" }));
    expect((screen.getByLabelText("Reviewer") as HTMLSelectElement).disabled).toBe(true);
    expect((screen.getByLabelText("Max review rounds") as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByLabelText("Review prompt") as HTMLTextAreaElement).disabled).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: /save changes/i }));
    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(body.reviewEnabled).toBe(false);
  });

  it("clears the reviewer swap to null so the server falls back to the shipped contract", () => {
    const fetchMock = stubFetch();
    renderView({ reviewAgent: "nextjs" }, reviewers);

    fireEvent.change(screen.getByLabelText("Reviewer"), { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: /save changes/i }));

    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(body.reviewAgent).toBeNull();
  });

  it("keeps a persisted reviewer that no longer resolves selectable, flagged as missing", () => {
    renderView({ reviewAgent: "deleted-agent" }, reviewers);
    const select = screen.getByLabelText("Reviewer") as HTMLSelectElement;
    expect(select.value).toBe("deleted-agent");
    expect(screen.getByText(/no longer exists/)).toBeTruthy();
  });

  it("omits a missing reviewer from the save, so unrelated settings still apply", () => {
    // The API rejects an unknown agent id, so resubmitting the stale one would fail every save
    // until the operator worked out that the reviewer field was the culprit.
    const fetchMock = stubFetch();
    renderView({ reviewAgent: "deleted-agent" }, reviewers);

    fireEvent.change(screen.getByLabelText("Max review rounds"), { target: { value: "4" } });
    fireEvent.click(screen.getByRole("button", { name: /save changes/i }));

    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect("reviewAgent" in body).toBe(false); // key absent → the server leaves the stored id alone
    expect(body.reviewMaxRounds).toBe(4);
  });

  it("submits the replacement once a missing reviewer is swapped for a live agent", () => {
    const fetchMock = stubFetch();
    renderView({ reviewAgent: "deleted-agent" }, reviewers);

    fireEvent.change(screen.getByLabelText("Reviewer"), { target: { value: "nextjs" } });
    fireEvent.click(screen.getByRole("button", { name: /save changes/i }));

    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(body.reviewAgent).toBe("nextjs");
  });

  // The prompt ranks BELOW a named reviewer (buildReviewPrompt), so the copy must say so —
  // an operator who reads it as additive silently loses the focus they asked for.
  it("describes the review prompt as a fallback once a reviewer is named", () => {
    renderView({}, reviewers);
    expect(screen.getByText(/Empty = shipped default \(skills\/review\)/)).toBeTruthy();

    fireEvent.change(screen.getByLabelText("Reviewer"), { target: { value: "my-reviewer" } });
    expect(screen.getByText(/my-reviewer brings its own contract/)).toBeTruthy();
    expect(screen.queryByText(/Empty = shipped default \(skills\/review\)/)).toBeNull();
  });

  it("clamps the round cap to [1,5]", () => {
    renderView({}, reviewers);
    const cap = screen.getByLabelText("Max review rounds") as HTMLInputElement;
    fireEvent.change(cap, { target: { value: "9" } });
    expect(cap.value).toBe("5");
    fireEvent.change(cap, { target: { value: "0" } });
    expect(cap.value).toBe("1");
  });
});

describe("SettingsView pipeline variants (anton-aa3m)", () => {
  it("shows the zero-config state: no variants, one pipeline for everything", () => {
    renderView({});
    expect(screen.getByText(/No variants — every run walks/)).toBeTruthy();
  });

  it("seeds the rows from the persisted map, in precedence order", () => {
    renderView({
      formulaVariants: [
        { label: "risk:high", formula: "anton-run-risk-high" },
        { label: "domain:docs", formula: "anton-run-docs" },
      ],
    });
    expect((screen.getByLabelText("Variant 1 label") as HTMLInputElement).value).toBe("risk:high");
    expect((screen.getByLabelText("Variant 2 formula") as HTMLInputElement).value).toBe(
      "anton-run-docs",
    );
  });

  it("PATCHes an added mapping on Save, dropping the half-filled row", () => {
    const fetchMock = stubFetch();
    renderView({});

    fireEvent.click(screen.getByRole("button", { name: /add variant/i }));
    fireEvent.change(screen.getByLabelText("Variant 1 label"), { target: { value: " risk:high " } });
    fireEvent.change(screen.getByLabelText("Variant 1 formula"), {
      target: { value: "anton-run-risk-high" },
    });
    // A second row the operator started and abandoned must not fail the save.
    fireEvent.click(screen.getByRole("button", { name: /add variant/i }));
    fireEvent.change(screen.getByLabelText("Variant 2 label"), { target: { value: "size:S" } });
    fireEvent.click(screen.getByRole("button", { name: /save changes/i }));

    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(body.formulaVariants).toEqual([
      { label: "risk:high", formula: "anton-run-risk-high" },
    ]);
  });

  it("reorders a mapping — the list's order is the precedence, so it must be editable", () => {
    const fetchMock = stubFetch();
    renderView({
      formulaVariants: [
        { label: "risk:high", formula: "heavy" },
        { label: "size:S", formula: "light" },
      ],
    });

    fireEvent.click(screen.getByRole("button", { name: "Move variant 2 up" }));
    expect((screen.getByLabelText("Variant 1 label") as HTMLInputElement).value).toBe("size:S");

    fireEvent.click(screen.getByRole("button", { name: /save changes/i }));
    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(body.formulaVariants).toEqual([
      { label: "size:S", formula: "light" },
      { label: "risk:high", formula: "heavy" },
    ]);
  });

  it("removes a mapping, and an emptied list clears the map", () => {
    const fetchMock = stubFetch();
    renderView({ formulaVariants: [{ label: "risk:high", formula: "heavy" }] });

    fireEvent.click(screen.getByRole("button", { name: "Remove variant 1" }));
    fireEvent.click(screen.getByRole("button", { name: /save changes/i }));

    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(body.formulaVariants).toEqual([]);
  });
});

describe("SettingsView automation cadence (anton-bfwq)", () => {
  /** A fixed future instant, in the epoch SECONDS the schedules row stores. */
  const NEXT_RUN = Math.floor(Date.UTC(2026, 7, 3, 10, 0, 0) / 1000);
  const LATER_RUN = NEXT_RUN + 3600;

  /** The schedule row shape the settings page passes through, defaulted to a half-hourly stringer. */
  function stringer(
    overrides: Partial<NonNullable<Parameters<typeof renderView>[2]>[number]> = {},
  ) {
    return [
      {
        type: "nightly-stringer",
        enabled: true,
        cron: "*/30 * * * *",
        nextRunAt: NEXT_RUN,
        ...overrides,
      },
    ];
  }

  /** Stub fetch with the PATCH response the schedules route returns (the row as stored). */
  function stubSchedulePatch(schedule?: Record<string, unknown>, status = 200) {
    const fetchMock = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(
      () =>
        Promise.resolve(
          new Response(JSON.stringify(status === 200 ? { schedule } : schedule), { status }),
        ),
    );
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }

  function body(fetchMock: ReturnType<typeof stubSchedulePatch>, call = 0) {
    return JSON.parse((fetchMock.mock.calls[call][1] as RequestInit).body as string);
  }

  const cadencePicker = () => screen.getByRole("combobox", { name: "nightly-stringer cadence" });

  /**
   * Open the row's picker and choose one of its items. The popup commits on pointerup (base-ui),
   * so a bare click never selects — drive the same pointer sequence a mouse produces.
   */
  async function chooseCadence(option: string | RegExp) {
    fireEvent.click(cadencePicker());
    const item = await screen.findByRole("option", { name: option });
    fireEvent.pointerDown(item, { pointerType: "mouse", button: 0 });
    fireEvent.pointerUp(item, { pointerType: "mouse", button: 0 });
    fireEvent.click(item);
  }

  const at = (seconds: number) => formatExactTime(new Date(seconds * 1000).toISOString());

  afterEach(() => {
    vi.mocked(toast.error).mockClear();
    vi.mocked(toast.success).mockClear();
  });

  it("shows the stored cadence and next run, not hardcoded copy", () => {
    renderView({}, [], stringer());

    expect(cadencePicker().textContent).toContain("Every 30 minutes");
    expect(screen.getByText(`scan → triage · next ${at(NEXT_RUN)}`)).toBeTruthy();
    // The cron strings that used to be baked into AUTOMATIONS are gone from the row copy.
    expect(screen.queryByText(/0 3 \* \* \*/)).toBeNull();
    expect(screen.queryByText(/poll PRs every 15m/)).toBeNull();
  });

  it("reads 'not scheduled' when the automation is off or has no row", () => {
    renderView({}, [], stringer({ enabled: false, nextRunAt: undefined }));

    expect(screen.getByText("scan → triage · not scheduled")).toBeTruthy();
    // gardener has no row at all — it still shows the cadence it would be created at.
    expect(
      screen.getByRole("combobox", { name: "gardener cadence" }).textContent,
    ).toContain("Daily at 05:00");
    expect(screen.getByText(/board hygiene patrol.*· not scheduled$/)).toBeTruthy();
  });

  it("PATCHes a chosen preset and renders the next run the server computed", async () => {
    const fetchMock = stubSchedulePatch({
      type: "nightly-stringer",
      enabled: true,
      cron: "0 * * * *",
      nextRunAt: LATER_RUN,
    });
    renderView({}, [], stringer());

    await chooseCadence("Hourly, on the hour");

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(fetchMock.mock.calls[0][0]).toBe("/api/projects/tmp/schedules");
    expect(body(fetchMock)).toEqual({ type: "nightly-stringer", cron: "0 * * * *" });
    await waitFor(() =>
      expect(screen.getByText(`scan → triage · next ${at(LATER_RUN)}`)).toBeTruthy(),
    );
    expect(cadencePicker().textContent).toContain("Hourly, on the hour");
  });

  it("reverts the row and toasts when the PATCH fails", async () => {
    stubSchedulePatch({ error: "invalid cron" }, 400);
    renderView({}, [], stringer());

    await chooseCadence("Hourly, on the hour");

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("invalid cron"));
    expect(cadencePicker().textContent).toContain("Every 30 minutes");
    expect(screen.getByText(`scan → triage · next ${at(NEXT_RUN)}`)).toBeTruthy();
  });

  it("blocks an invalid custom cron with the parser's own message, then saves a valid one", async () => {
    const fetchMock = stubSchedulePatch({
      type: "nightly-stringer",
      enabled: true,
      cron: "0 6 * * *",
      nextRunAt: LATER_RUN,
    });
    renderView({}, [], stringer());

    await chooseCadence("Custom cron…");
    const input = screen.getByLabelText("nightly-stringer cron expression") as HTMLInputElement;
    expect(input.value).toBe("*/30 * * * *");

    fireEvent.change(input, { target: { value: "nope" } });
    const save = screen.getByRole("button", { name: "Save cadence" }) as HTMLButtonElement;
    expect(screen.getByText(/must have 5 fields/)).toBeTruthy();
    expect(save.disabled).toBe(true);
    fireEvent.click(save);
    expect(fetchMock).not.toHaveBeenCalled();

    fireEvent.change(input, { target: { value: "0 6 * * *" } });
    expect(screen.queryByText(/must have 5 fields/)).toBeNull();
    expect(save.disabled).toBe(false);
    fireEvent.click(save);

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(body(fetchMock)).toEqual({ type: "nightly-stringer", cron: "0 6 * * *" });
  });

  it("warns that a sub-5-minute cadence burns budget, but still lets it save", async () => {
    const fetchMock = stubSchedulePatch({
      type: "nightly-stringer",
      enabled: true,
      cron: "*/2 * * * *",
      nextRunAt: LATER_RUN,
    });
    renderView({}, [], stringer());

    await chooseCadence("Custom cron…");
    fireEvent.change(screen.getByLabelText("nightly-stringer cron expression"), {
      target: { value: "*/2 * * * *" },
    });

    expect(screen.getByText(/burn budget/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Save cadence" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(body(fetchMock)).toEqual({ type: "nightly-stringer", cron: "*/2 * * * *" });
    // The warning survives the save — it describes the cadence that is now stored.
    await waitFor(() => expect(screen.getByText(/burn budget/)).toBeTruthy());
  });

  it("resets an edited cadence to the automation's default", async () => {
    const fetchMock = stubSchedulePatch({
      type: "nightly-stringer",
      enabled: true,
      cron: "0 3 * * *",
      nextRunAt: LATER_RUN,
    });
    renderView({}, [], stringer({ cron: "0 9 * * *" }));
    expect(cadencePicker().textContent).toContain("Daily at 09:00");

    await chooseCadence("Reset to default");

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(body(fetchMock)).toEqual({ type: "nightly-stringer", cron: "0 3 * * *" });
    await waitFor(() => expect(cadencePicker().textContent).toContain("Daily at 03:00"));
  });

  it("offers no reset once the row is already at its default cadence", async () => {
    stubSchedulePatch();
    renderView({}, [], stringer({ cron: "0 3 * * *" }));

    fireEvent.click(cadencePicker());
    const reset = await screen.findByRole("option", { name: "Reset to default" });
    expect(reset.getAttribute("data-disabled")).not.toBeNull();
  });

  it("keeps the enable toggle patching schedules.enabled as before", async () => {
    const fetchMock = stubSchedulePatch({
      type: "gardener",
      enabled: true,
      cron: "0 5 * * *",
      nextRunAt: LATER_RUN,
    });
    renderView({}, [], stringer());

    fireEvent.click(screen.getByRole("switch", { name: "gardener" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(body(fetchMock)).toEqual({ type: "gardener", enabled: true });
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith("gardener enabled"));
  });
});
