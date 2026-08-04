// @vitest-environment jsdom
/**
 * Budget-policy knobs in the settings form (anton-egrg): the daytime-reserve and weekly-target
 * inputs seed from a persisted policy (round-trip in), and Save PATCHes the edited values back.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { toast } from "sonner";

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
  window.location.hash = "";
});

/**
 * The nav switches which panel renders (anton-ue90.3) and the URL hash is that choice, so a test
 * that exercises one section says which one before rendering — exactly as a deep link would.
 */
function showing(section: string) {
  beforeEach(() => {
    window.location.hash = `#${section}`;
  });
}

describe("SettingsView budget policy (anton-egrg)", () => {
  showing("execution");

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
  showing("execution");

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
    // Save is only offered once something is staged (anton-ue90.3), so dirty an unrelated knob: the
    // claim under test is that the untouched flag still goes out as an explicit false, not as an
    // omission the server would read as "leave it alone".
    fireEvent.click(screen.getByRole("switch", { name: "Autonomous execution" }));
    fireEvent.click(screen.getByRole("button", { name: /save changes/i }));
    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(body.budgetAware).toBe(false);
  });
});

describe("SettingsView self-review section (anton-of1m)", () => {
  showing("review");

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
    expect((screen.getByLabelText("Minimum score") as HTMLInputElement).value).toBe("5");
    expect((screen.getByLabelText("Consecutive low rounds") as HTMLInputElement).value).toBe("2");
    expect((screen.getByLabelText("Review prompt") as HTMLTextAreaElement).value).toBe("");
  });

  it("seeds, clamps and PATCHes the score-alarm thresholds (anton-i98r)", () => {
    const fetchMock = stubFetch();
    renderView({ reviewMaxRounds: 3, reviewMinScore: 7, reviewLowScoreRounds: 3 }, reviewers);
    expect((screen.getByLabelText("Minimum score") as HTMLInputElement).value).toBe("7");
    expect((screen.getByLabelText("Consecutive low rounds") as HTMLInputElement).value).toBe("3");

    // Clamped in the field, so a typo lands on the bound instead of round-tripping as a 400.
    fireEvent.change(screen.getByLabelText("Minimum score"), { target: { value: "99" } });
    expect((screen.getByLabelText("Minimum score") as HTMLInputElement).value).toBe("10");

    fireEvent.change(screen.getByLabelText("Minimum score"), { target: { value: "4" } });
    fireEvent.click(screen.getByRole("button", { name: /save changes/i }));
    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(body).toMatchObject({ reviewMinScore: 4, reviewLowScoreRounds: 3 });
  });

  it("says the alarm can never fire when the streak outruns the round cap", () => {
    renderView({ reviewMaxRounds: 2, reviewMinScore: 5, reviewLowScoreRounds: 4 }, reviewers);
    expect(screen.getByText(/never fires · 4 low rounds can't happen in 2 review rounds/)).toBeTruthy();

    // Raising the cap past the streak restores the ordinary summary.
    fireEvent.change(screen.getByLabelText("Max review rounds"), { target: { value: "4" } });
    expect(screen.getByText(/park after 4 rounds below 5\/10/)).toBeTruthy();
  });

  it("turns the alarm off at a minimum score of 0, and says so", () => {
    renderView({ reviewMinScore: 0 }, reviewers);
    expect(screen.getByText(/off · the loop runs to the round cap/)).toBeTruthy();
    // The streak knob is meaningless with no threshold — disabled, never silently reset.
    expect((screen.getByLabelText("Consecutive low rounds") as HTMLInputElement).disabled).toBe(true);
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
    expect((screen.getByLabelText("Minimum score") as HTMLInputElement).disabled).toBe(true);
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
  showing("variants");

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

describe("SettingsView automation table (anton-ue90.4 / anton-ue90.5)", () => {
  showing("automation");

  /**
   * Anchored to the real clock, a comfortable distance from the rounding boundary: the Next-run
   * column is a countdown, so a fixed calendar instant would drift into the past and read "due now".
   */
  const NEXT_RUN = Math.floor(Date.now() / 1000) + 2 * 3600 + 60;
  const LAST_RUN = Math.floor(Date.now() / 1000) - 3 * 3600 - 60;

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

  const cadenceButton = (name = "nightly-stringer") =>
    screen.getByRole("button", { name: `${name} cadence` });

  /** Open one row's cadence editor. A popover, so the rows below it never move. */
  function openEditor(name = "nightly-stringer") {
    fireEvent.click(cadenceButton(name));
  }

  const frequency = (label: string) => screen.getByRole("button", { name: label });
  const setCadence = () => screen.getByRole("button", { name: "Set cadence" }) as HTMLButtonElement;

  afterEach(() => {
    vi.mocked(toast.error).mockClear();
    vi.mocked(toast.success).mockClear();
  });

  it("shows the stored cadence, and when it last and next fires", () => {
    renderView({}, [], stringer({ lastRunAt: LAST_RUN }));

    expect(cadenceButton().textContent).toContain("Every 30 minutes");
    expect(screen.getByText("in 2h")).toBeTruthy();
    expect(screen.getByText("3h ago")).toBeTruthy();
    // The cron strings that used to be baked into AUTOMATIONS are gone from the row copy.
    expect(screen.queryByText(/0 3 \* \* \*/)).toBeNull();
  });

  it("says an automation has never run rather than leaving the column blank", () => {
    renderView({}, [], stringer());
    // Every row but the stringer has no schedule row at all, so "never" is the honest answer.
    expect(screen.getAllByText("never").length).toBeGreaterThan(0);
  });

  it("reads 'not scheduled' when the automation is off or has no row", () => {
    renderView({}, [], stringer({ enabled: false, nextRunAt: undefined }));

    expect(screen.getAllByText("not scheduled").length).toBe(7);
    // gardener has no row at all — it still shows the cadence it would be created at.
    expect(cadenceButton("gardener").textContent).toContain("Daily at 05:00");
  });

  it("says which automations are idle because the one that feeds them is off", () => {
    // unstick acts on run-health's findings, and both ship disabled. Without this the operator reads
    // a healthy no-op as a failure.
    renderView({}, [], stringer());
    expect(screen.getByText(/idle until run-health is on/)).toBeTruthy();
  });

  it("PATCHes a cadence built from the frequency picker, with no cron typed", async () => {
    const fetchMock = stubSchedulePatch({
      type: "nightly-stringer",
      enabled: true,
      cron: "0 * * * *",
      nextRunAt: NEXT_RUN + 3600,
    });
    renderView({}, [], stringer());

    openEditor();
    fireEvent.click(frequency("Hourly"));
    fireEvent.click(setCadence());

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(fetchMock.mock.calls[0][0]).toBe("/api/projects/tmp/schedules");
    expect(body(fetchMock)).toEqual({ type: "nightly-stringer", cron: "0 * * * *" });
    await waitFor(() => expect(cadenceButton().textContent).toContain("Hourly, on the hour"));
    // Committing closes the popover — the operator is done with it.
    expect(screen.queryByRole("button", { name: "Set cadence" })).toBeNull();
  });

  it("previews when the cadence will actually fire, before it is committed", () => {
    renderView({}, [], stringer());
    openEditor();
    fireEvent.click(frequency("Daily"));

    expect(screen.getByText("Next 3 runs")).toBeTruthy();
    // The footer shows the expression the draft stands for — staged, not stored: the row behind the
    // popover still reads the cadence that actually fires.
    expect(screen.getByText("0 3 * * *")).toBeTruthy();
    expect(cadenceButton().textContent).toContain("Every 30 minutes");
  });

  it("reverts the row and toasts when the PATCH fails", async () => {
    stubSchedulePatch({ error: "invalid cron" }, 400);
    renderView({}, [], stringer());

    openEditor();
    fireEvent.click(frequency("Hourly"));
    fireEvent.click(setCadence());

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("invalid cron"));
    expect(cadenceButton().textContent).toContain("Every 30 minutes");
    expect(screen.getByText("in 2h")).toBeTruthy();
  });

  it("keeps the raw expression reachable, seeded with what the picker would store", () => {
    renderView({}, [], stringer());
    openEditor();
    fireEvent.click(frequency("Cron"));

    expect(
      (screen.getByLabelText("nightly-stringer cron expression") as HTMLInputElement).value,
    ).toBe("*/30 * * * *");
  });

  it("opens straight on the raw editor for an expression no preset can spell", () => {
    // A hand-written cadence must round-trip: opening the editor on a preset would silently offer to
    // overwrite it.
    renderView({}, [], stringer({ cron: "0 0,12 * * 1-5" }));
    openEditor();

    expect(
      (screen.getByLabelText("nightly-stringer cron expression") as HTMLInputElement).value,
    ).toBe("0 0,12 * * 1-5");
  });

  it("blocks an invalid cron with the parser's own message, then saves a valid one", async () => {
    const fetchMock = stubSchedulePatch({
      type: "nightly-stringer",
      enabled: true,
      cron: "0 6 * * *",
      nextRunAt: NEXT_RUN,
    });
    renderView({}, [], stringer());

    openEditor();
    fireEvent.click(frequency("Cron"));
    const input = screen.getByLabelText("nightly-stringer cron expression") as HTMLInputElement;

    fireEvent.change(input, { target: { value: "nope" } });
    expect(screen.getByText(/must have 5 fields/)).toBeTruthy();
    expect(setCadence().disabled).toBe(true);
    fireEvent.click(setCadence());
    expect(fetchMock).not.toHaveBeenCalled();

    fireEvent.change(input, { target: { value: "0 6 * * *" } });
    expect(screen.queryByText(/must have 5 fields/)).toBeNull();
    expect(setCadence().disabled).toBe(false);
    fireEvent.click(setCadence());

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(body(fetchMock)).toEqual({ type: "nightly-stringer", cron: "0 6 * * *" });
  });

  it("names a fast cadence's cost in runs per day, and still lets it save", async () => {
    const fetchMock = stubSchedulePatch({
      type: "nightly-stringer",
      enabled: true,
      cron: "*/2 * * * *",
      nextRunAt: NEXT_RUN,
    });
    renderView({}, [], stringer());

    openEditor();
    fireEvent.click(frequency("Cron"));
    fireEvent.change(screen.getByLabelText("nightly-stringer cron expression"), {
      target: { value: "*/2 * * * *" },
    });

    // The threshold constant means nothing to an operator; 720 runs a day does.
    expect(screen.getByText(/720 runs a day/)).toBeTruthy();
    expect(setCadence().disabled).toBe(false);
    fireEvent.click(setCadence());

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(body(fetchMock)).toEqual({ type: "nightly-stringer", cron: "*/2 * * * *" });
  });

  it("resets an edited cadence to the automation's default", async () => {
    const fetchMock = stubSchedulePatch({
      type: "nightly-stringer",
      enabled: true,
      cron: "0 3 * * *",
      nextRunAt: NEXT_RUN,
    });
    renderView({}, [], stringer({ cron: "0 9 * * *" }));
    expect(cadenceButton().textContent).toContain("Daily at 09:00");

    openEditor();
    fireEvent.click(screen.getByRole("button", { name: "Reset" }));
    // Reset stages the default like every other edit in this popover; nothing is stored until Set.
    expect(fetchMock).not.toHaveBeenCalled();
    fireEvent.click(setCadence());

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(body(fetchMock)).toEqual({ type: "nightly-stringer", cron: "0 3 * * *" });
    await waitFor(() => expect(cadenceButton().textContent).toContain("Daily at 03:00"));
  });

  it("offers no reset once the row is already at its default cadence", () => {
    stubSchedulePatch();
    renderView({}, [], stringer({ cron: "0 3 * * *" }));

    openEditor();
    expect((screen.getByRole("button", { name: "Reset" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("keeps the enable toggle patching schedules.enabled as before", async () => {
    const fetchMock = stubSchedulePatch({
      type: "gardener",
      enabled: true,
      cron: "0 5 * * *",
      nextRunAt: NEXT_RUN,
    });
    renderView({}, [], stringer());

    fireEvent.click(screen.getByRole("switch", { name: "gardener" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(body(fetchMock)).toEqual({ type: "gardener", enabled: true });
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith("gardener enabled"));
  });
});

describe("SettingsView navigation (anton-ue90.3)", () => {
  const navButton = (name: string | RegExp) => screen.getByRole("button", { name });

  it("lists every section that renders, and renders only the one selected", () => {
    renderView({});

    // The old nav named six of eight sections; these four were unreachable by name.
    for (const label of ["Verify gates", "Pipeline variants", "Self-review", "Danger zone"]) {
      expect(navButton(label)).toBeTruthy();
    }
    // General is the default panel, and nothing else is on screen with it.
    expect(screen.getByRole("heading", { name: "General" })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Verify gates" })).toBeNull();
  });

  it("changes what is displayed when a section is clicked", () => {
    renderView({});
    fireEvent.click(navButton("Verify gates"));

    expect(screen.getByRole("heading", { name: "Verify gates" })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "General" })).toBeNull();
    // …and says so in the URL, so a reload and a shared link land in the same place.
    expect(window.location.hash).toBe("#gates");
  });

  it("opens on the section named by the URL", () => {
    window.location.hash = "#automation";
    renderView({});
    expect(screen.getByRole("heading", { name: "Automation" })).toBeTruthy();
  });

  it("falls back to General for a hash that names nothing", () => {
    window.location.hash = "#does-not-exist";
    renderView({});
    expect(screen.getByRole("heading", { name: "General" })).toBeTruthy();
  });

  it("names which sections are unsaved, and offers Save only when something is", () => {
    window.location.hash = "#prompt";
    renderView({});
    const save = () => screen.getByRole("button", { name: /save changes/i }) as HTMLButtonElement;
    expect(save().disabled).toBe(true);

    fireEvent.change(screen.getByLabelText("Seed prompt"), { target: { value: "prefer RSC" } });
    expect(save().disabled).toBe(false);
    expect(screen.getByText("execution prompt")).toBeTruthy();
  });

  it("saves an edit made in a panel that is no longer displayed", async () => {
    // The panels are a view, not a form boundary: staged edits survive navigating away from them.
    const fetchMock = stubFetch();
    window.location.hash = "#prompt";
    renderView({});

    fireEvent.change(screen.getByLabelText("Seed prompt"), { target: { value: "prefer RSC" } });
    fireEvent.click(navButton("Verify gates"));
    fireEvent.click(screen.getByRole("button", { name: /save changes/i }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const sent = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(sent.seedPrompt).toBe("prefer RSC");
  });
});
