// @vitest-environment jsdom
/**
 * Budget-policy knobs in the settings form (anton-egrg): the daytime-reserve and weekly-target
 * inputs seed from a persisted policy (round-trip in), and Save PATCHes the edited values back.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { toast } from "sonner";

import { SettingsView } from "@/components/settings/settings-view";
import { GARDENER_DETECTION_KINDS } from "@/lib/gardener/detections";
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
  "board-picker": "*/10 * * * *",
  "product-master": "0 6 * * 1",
};

type Earned = Parameters<typeof SettingsView>[0]["earned"];

/**
 * The settled-proposal record the server hands in (anton-m29g). The default is the board every
 * project starts on — nothing settled, so no kind has earned `apply` — because that is what the
 * control has to render correctly first.
 */
const NO_RECORD: Earned = Object.fromEntries(
  GARDENER_DETECTION_KINDS.map((kind) => [
    kind,
    { applied: 0, settled: 0, eligible: false, reason: "no settled proposals yet — apply unlocks at 10 settled with 80% applied" },
  ]),
);

/** A record that has earned `apply` on every kind — for the tests that are about the POLICY. */
const EARNED: Earned = Object.fromEntries(
  GARDENER_DETECTION_KINDS.map((kind) => [kind, { applied: 30, settled: 30, eligible: true }]),
);

function renderView(
  settings: Parameters<typeof SettingsView>[0]["settings"] = {},
  agents: Parameters<typeof SettingsView>[0]["agents"] = [],
  schedules: Parameters<typeof SettingsView>[0]["schedules"] = [],
  earned: Earned = NO_RECORD,
  labelVocabulary: Parameters<typeof SettingsView>[0]["labelVocabulary"] = [],
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
      labelVocabulary={labelVocabulary}
      earned={earned}
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

describe("SettingsView work value (anton-prng)", () => {
  showing("value");

  /** A board whose namespaces are its own — the picker must offer these, not labels anton assumed. */
  const VOCABULARY = [
    {
      namespace: "severity",
      labels: [
        { label: "severity:sev1", count: 4 },
        { label: "severity:sev2", count: 2 },
      ],
    },
    { namespace: "", labels: [{ label: "approved", count: 9 }] },
  ];

  it("shows the zero-config state: nothing nominated, ranking by age alone", () => {
    renderView({});
    expect(screen.getByText(/Nothing nominated/)).toBeTruthy();
  });

  it("seeds the rows from the persisted nominations, in band order", () => {
    renderView({ valueLabels: ["risk:high", "blocking-PR"] });
    expect((screen.getByLabelText("Value label 1") as HTMLInputElement).value).toBe("risk:high");
    expect((screen.getByLabelText("Value label 2") as HTMLInputElement).value).toBe("blocking-PR");
  });

  it("offers the board's OWN labels, grouped by namespace, and nominates one on click", () => {
    const fetchMock = stubFetch();
    renderView({}, [], [], NO_RECORD, VOCABULARY);

    expect(screen.getByText("severity:")).toBeTruthy();
    const chip = screen.getByRole("button", { name: /severity:sev1/ });
    expect(chip.getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(chip);
    expect(
      (screen.getByLabelText("Value label 1") as HTMLInputElement).value,
    ).toBe("severity:sev1");
    expect(
      screen.getByRole("button", { name: /severity:sev1/ }).getAttribute("aria-pressed"),
    ).toBe("true");

    fireEvent.click(screen.getByRole("button", { name: /save changes/i }));
    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(body.valueLabels).toEqual(["severity:sev1"]);
  });

  it("PATCHes typed nominations on Save, dropping blank and repeat rows", () => {
    const fetchMock = stubFetch();
    renderView({});

    fireEvent.click(screen.getByRole("button", { name: /add label/i }));
    fireEvent.change(screen.getByLabelText("Value label 1"), { target: { value: " risk:high " } });
    // A repeat could never reach its tier (first match wins) and would 400 the whole save.
    fireEvent.click(screen.getByRole("button", { name: /add label/i }));
    fireEvent.change(screen.getByLabelText("Value label 2"), { target: { value: "risk:high" } });
    // An abandoned scaffolding row is not a nomination.
    fireEvent.click(screen.getByRole("button", { name: /add label/i }));
    fireEvent.click(screen.getByRole("button", { name: /save changes/i }));

    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(body.valueLabels).toEqual(["risk:high"]);
  });

  it("reorders a nomination — the list's order is the band order, so it must be editable", () => {
    const fetchMock = stubFetch();
    renderView({ valueLabels: ["risk:high", "blocking-PR"] });

    fireEvent.click(screen.getByRole("button", { name: "Move value label 2 up" }));
    expect((screen.getByLabelText("Value label 1") as HTMLInputElement).value).toBe("blocking-PR");

    fireEvent.click(screen.getByRole("button", { name: /save changes/i }));
    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(body.valueLabels).toEqual(["blocking-PR", "risk:high"]);
  });

  it("removes a nomination, and an emptied list clears them", () => {
    const fetchMock = stubFetch();
    renderView({ valueLabels: ["risk:high"] });

    fireEvent.click(screen.getByRole("button", { name: "Remove value label 1" }));
    fireEvent.click(screen.getByRole("button", { name: /save changes/i }));

    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(body.valueLabels).toEqual([]);
  });

  it("says so when the board read came back empty, instead of offering nothing at all", () => {
    renderView({});
    expect(screen.getByText(/No labels read off this board yet/)).toBeTruthy();
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

  /**
   * The PATCH calls only. The open panel also GETs the rows — once on arrival and then on its poll —
   * so "the write this test made" is no longer "the first fetch this test saw".
   */
  function patches(fetchMock: ReturnType<typeof stubSchedulePatch>) {
    return fetchMock.mock.calls.filter((c) => (c[1] as RequestInit | undefined)?.method === "PATCH");
  }

  function body(fetchMock: ReturnType<typeof stubSchedulePatch>, call = 0) {
    return JSON.parse((patches(fetchMock)[call][1] as RequestInit).body as string);
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

  it("ships the board-picker row off, at the cadence it would be created at", () => {
    // Seeded disabled (schedules.ts) because nothing an operator did not ask for should start
    // running; the panel is where that choice is made, so the row must be visible while still off.
    renderView({}, [], stringer());

    expect(cadenceButton("board-picker").textContent).toContain("Every 10 minutes");
    expect(screen.getByRole("switch", { name: "board-picker" }).getAttribute("aria-checked")).toBe(
      "false",
    );
    // The pass decides only. The row must promise the ranking and NOT a start, or arming it reads
    // as autopilot and the operator waits for work that was never going to begin.
    expect(screen.getByText(/ranks what could run next/)).toBeTruthy();
    expect(screen.getByText(/starts nothing yet/)).toBeTruthy();
  });

  it("reads 'not scheduled' when the automation is off or has no row", () => {
    renderView({}, [], stringer({ enabled: false, nextRunAt: undefined }));

    expect(screen.getAllByText("not scheduled").length).toBe(9);
    // gardener has no row at all — it still shows the cadence it would be created at.
    expect(cadenceButton("gardener").textContent).toContain("Daily at 05:00");
  });

  /** Mirrors SCHEDULE_POLL_MS in settings-view.tsx — how often the open panel re-reads the rows. */
  const POLL_MS = 30_000;

  /**
   * The panel left open, with the clock and the poll both under our control.
   *
   * The clock is pinned to a WHOLE second before anything reads it: the countdown floors to the
   * second, so starting part-way through one would make "90s out" render as "in 1m" or "in 89s"
   * depending on when the test happened to run.
   *
   * `fetch` is stubbed even where the poll's answer does not matter — the countdown test advances
   * past the poll interval, and an unstubbed poll would reach for a relative URL jsdom cannot serve.
   */
  function openPanel(
    schedulesFor: (nowSec: number) => Parameters<typeof renderView>[2],
    polledFor: (nowSec: number) => unknown[] = () => [],
  ) {
    const nowSec = Math.floor(Date.now() / 1000);
    vi.useFakeTimers();
    vi.setSystemTime(nowSec * 1000);
    const fetchMock = vi.fn(() =>
      Promise.resolve(new Response(JSON.stringify({ schedules: polledFor(nowSec) }))),
    );
    vi.stubGlobal("fetch", fetchMock);
    renderView({}, [], schedulesFor(nowSec));
    return { fetchMock, nowSec };
  }

  /** Advance the fake clock AND let the poll's promise chain settle, inside act(). */
  async function tick(ms: number) {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(ms);
    });
  }

  it("counts the next run down while the panel sits open, without a reload", async () => {
    // The defect this pins: the countdown was read only during a render, and nothing on this panel
    // re-renders on its own — so a row that said "in 1m" kept saying it long after the run was due.
    openPanel((nowSec) => stringer({ nextRunAt: nowSec + 90 }));
    try {
      expect(screen.getByText("in 1m")).toBeTruthy();

      await tick(60_000);
      expect(screen.getByText("in 30s")).toBeTruthy();

      await tick(35_000);
      expect(screen.getByText("due now")).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });

  it("re-reads the schedule rows so a fire refreshes both time columns", async () => {
    const { fetchMock } = openPanel(
      (nowSec) => stringer({ nextRunAt: nowSec + 60 }),
      (nowSec) => [
        {
          type: "nightly-stringer",
          enabled: true,
          // Deliberately different from the row on screen — the poll must NOT move the cadence.
          cron: "0 * * * *",
          nextRunAt: nowSec + 1800,
          lastRunAt: nowSec - 60,
        },
      ],
    );
    try {
      // Rendered from the page's snapshot: due in a minute, and never run.
      expect(screen.getAllByText("never").length).toBe(9);

      // Arriving at the panel re-reads once — a hash switch is not a navigation, so the snapshot
      // this page was rendered with could be an hour old.
      await tick(0);
      expect(fetchMock).toHaveBeenCalledWith("/api/projects/tmp/schedules");
      // Both time columns moved to what the server now holds...
      expect(screen.getByText("in 30m")).toBeTruthy();
      expect(screen.getByText("1m ago")).toBeTruthy();
      expect(screen.getAllByText("never").length).toBe(8);
      // ...while the cadence stayed the operator's, not the poll's.
      expect(cadenceButton().textContent).toContain("Every 30 minutes");

      // ...and it keeps re-reading for as long as the panel stays open.
      await tick(POLL_MS);
      expect(fetchMock).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
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

    await waitFor(() => expect(patches(fetchMock)).toHaveLength(1));
    expect(patches(fetchMock)[0][0]).toBe("/api/projects/tmp/schedules");
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

  /**
   * The cadence editor is a popover that closes on a click outside it, and its time pickers render
   * their menus in a portal — outside that subtree, at the end of <body>. So "outside the popover"
   * and "outside the editor" are not the same place, and the guard that tells them apart keys on
   * the marker the Select portal carries. Untested, a picker that stopped emitting that marker
   * would fail SILENTLY: every click on an hour would close the editor and bin the draft, with no
   * error anywhere. These two tests are the tripwire — one on the guard, one on the contract it
   * depends on.
   */
  describe("the click-away guard vs. the portalled pickers", () => {
    /** Open the editor on Daily, then open its hour picker. Returns the menu's options. */
    function openHourPicker() {
      openEditor();
      fireEvent.click(frequency("Daily"));
      fireEvent.click(screen.getByLabelText("Hour"));
      return screen.getAllByRole("option");
    }

    it("does not read picking an hour as clicking away", () => {
      renderView({}, [], stringer());
      const options = openHourPicker();
      const nine = options.find((o) => o.textContent === "09");
      expect(nine).toBeTruthy();

      // mousedown is what the guard listens for, and it bubbles to the document from the portal.
      fireEvent.mouseDown(nine as Element);

      // Still open: the draft survived, and "Set cadence" only exists inside the popover.
      expect(setCadence()).toBeTruthy();
    });

    it("still closes on a click that is genuinely outside the editor", () => {
      renderView({}, [], stringer());
      openEditor();
      fireEvent.mouseDown(document.body);
      expect(screen.queryByRole("button", { name: "Set cadence" })).toBeNull();
    });

    it("keys on a marker the Select portal actually renders", () => {
      // The guard's premise, asserted against the real component rather than assumed. If the Select
      // primitive is ever swapped or restyled out of this attribute, this fails here — loudly, in
      // CI — instead of out in the UI as a dropdown that silently discards what the operator typed.
      renderView({}, [], stringer());
      const options = openHourPicker();
      const positioner = document.querySelector("[data-slot='select-positioner']");
      expect(positioner).not.toBeNull();
      expect(positioner?.contains(options[0])).toBe(true);
    });
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
    expect(patches(fetchMock)).toHaveLength(0);

    fireEvent.change(input, { target: { value: "0 6 * * *" } });
    expect(screen.queryByText(/must have 5 fields/)).toBeNull();
    expect(setCadence().disabled).toBe(false);
    fireEvent.click(setCadence());

    await waitFor(() => expect(patches(fetchMock)).toHaveLength(1));
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

    await waitFor(() => expect(patches(fetchMock)).toHaveLength(1));
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
    expect(patches(fetchMock)).toHaveLength(0);
    fireEvent.click(setCadence());

    await waitFor(() => expect(patches(fetchMock)).toHaveLength(1));
    expect(body(fetchMock)).toEqual({ type: "nightly-stringer", cron: "0 3 * * *" });
    await waitFor(() => expect(cadenceButton().textContent).toContain("Daily at 03:00"));
  });

  it("offers no reset once the row is already at its default cadence", () => {
    stubSchedulePatch();
    renderView({}, [], stringer({ cron: "0 3 * * *" }));

    openEditor();
    expect((screen.getByRole("button", { name: "Reset" }) as HTMLButtonElement).disabled).toBe(true);
  });

  /**
   * Two writes to one row are queued, so the second one's call-time view of the row is the FIRST
   * one's optimistic guess — never the server's. Rolling back to that snapshot leaves the table
   * reporting a state the server never held, with no error left on screen to explain it.
   */
  it("rolls a failed write back to the server's row, not to a queued write's guess", async () => {
    let failDisable: (() => void) | undefined;
    const fetchMock = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(
      (_input, init) => {
        if (init?.method !== "PATCH") {
          return Promise.resolve(new Response(JSON.stringify({ schedules: [] })));
        }
        const patch = JSON.parse(init.body as string) as Record<string, unknown>;
        const refused = () =>
          new Response(JSON.stringify({ error: `${patch.enabled ? "enable" : "disable"} refused` }), {
            status: 500,
          });
        // The disable is held so the enable is clicked while it is still open.
        if (patch.enabled === false) {
          return new Promise<Response>((resolve) => {
            failDisable = () => resolve(refused());
          });
        }
        return Promise.resolve(refused());
      },
    );
    vi.stubGlobal("fetch", fetchMock);
    renderView({}, [], stringer());

    const toggle = () => screen.getByRole("switch", { name: "nightly-stringer" });
    expect(toggle().getAttribute("aria-checked")).toBe("true");

    fireEvent.click(toggle());
    await waitFor(() => expect(failDisable).toBeTruthy());
    fireEvent.click(toggle());
    failDisable!();

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("disable refused"));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("enable refused"));
    // Neither write landed, so the row reads what the server still holds: on.
    expect(toggle().getAttribute("aria-checked")).toBe("true");
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

    await waitFor(() => expect(patches(fetchMock)).toHaveLength(1));
    expect(body(fetchMock)).toEqual({ type: "gardener", enabled: true });
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith("gardener enabled"));
  });
});

describe("SettingsView proposal autonomy (anton-3mqq)", () => {
  showing("proposals");

  const KINDS: readonly string[] = GARDENER_DETECTION_KINDS;

  const choice = (kind: string, level: string) =>
    screen.getByRole("radio", { name: `${kind} · ${level}` }) as HTMLInputElement;

  const groupBox = (title: string) => screen.getByRole("group", { name: title });

  it("renders every kind at propose, the shipped default", () => {
    renderView({});
    for (const kind of KINDS) {
      expect(choice(kind, "propose").checked).toBe(true);
      expect(choice(kind, "shadow").checked).toBe(false);
    }
  });

  it("renders exactly the kinds the detector knows about", () => {
    // The panel's catalogue is a hand-maintained mirror of GARDENER_DETECTION_KINDS (this module
    // never imports server code), so it can drift the moment a kind is added. Asserted against the
    // real list rather than a copy of it: a new kind with no row would otherwise ship as a policy
    // the operator cannot see, silently stuck at whatever a settings blob happened to hold.
    renderView({});
    const rendered = screen
      .getAllByRole("radio")
      .map((r) => r.getAttribute("aria-label")?.split(" · ")[0])
      .filter((kind, i, all) => all.indexOf(kind) === i);
    expect(rendered.sort()).toEqual([...KINDS].sort());
  });

  it("groups the kinds by reversibility, and says how each group is undone", () => {
    renderView({});

    // The point of the grouping: a link and a close are not the same decision, so they are not in
    // the same box — and each box states what it does and what taking it back costs.
    const reversible = groupBox("Undone by one write");
    expect(within(reversible).getByRole("radio", { name: "implied-order · propose" })).toBeTruthy();
    expect(within(reversible).queryByRole("radio", { name: "shipped-orphan · propose" })).toBeNull();
    expect(within(reversible).getByText(/One bd write puts it back/)).toBeTruthy();

    const dequeued = groupBox("Takes work out of the queue");
    expect(within(dequeued).getByRole("radio", { name: "stale · propose" })).toBeTruthy();
    expect(within(dequeued).getByText(/bd undefer puts a deferred bead straight back/)).toBeTruthy();

    // A close is the one move that writes a claim about what happened — said in the group, so the
    // founder never has to read the source to know a shipped-orphan closes.
    const history = groupBox("Writes history");
    expect(within(history).getByRole("radio", { name: "shipped-orphan · propose" })).toBeTruthy();
    expect(within(history).getByText(/stays in the board's history/)).toBeTruthy();
  });

  it("shows split as not armable, with the reason, rather than offering it", () => {
    renderView({});
    const manual = groupBox("Nothing to arm");

    expect(within(manual).getByRole("radio", { name: "oversized · propose" })).toBeTruthy();
    expect(within(manual).getByText(/a split writes new contracts/)).toBeTruthy();
    // Every level disabled, not just apply: autonomyFor answers `propose` for a split whatever the
    // policy says, so an offered `shadow` would be a setting the pass silently ignores.
    for (const level of ["propose", "shadow", "apply"]) {
      expect(choice("oversized", level).disabled).toBe(true);
    }
  });

  it("says a targetless re-parent is never applied, whatever the kind is set to", () => {
    renderView({});
    // Per-proposal, not per-kind: a container-orphan WITH a home is applicable, so the kind stays
    // armable and the floor is stated where both re-parent kinds live.
    expect(
      within(groupBox("Undone by one write")).getByText(/never applied, whatever this says/),
    ).toBeTruthy();
    expect(choice("container-orphan", "shadow").disabled).toBe(false);
  });

  it("lets apply be picked on every armable kind whose record has earned it (anton-hzce)", () => {
    // The passes can perform the write now (anton-4ab3), so the level is real. What is still off the
    // table is a kind autonomyFor pins at propose whatever the policy says.
    renderView({}, [], [], EARNED);
    for (const kind of KINDS.filter((k) => k !== "oversized")) {
      expect(choice(kind, "apply").disabled).toBe(false);
    }
    expect(choice("oversized", "apply").disabled).toBe(true);
  });

  it("locks apply on a kind whose record has not earned it, WITH the counts and the reason", () => {
    // The failure this floor exists to stop repeating is evidence printed and not read. A disabled
    // control an operator cannot account for is exactly that failure, one surface over — so the row
    // states what it is locked on and what would unlock it.
    renderView({}, [], [], {
      ...EARNED,
      "parentless-cluster": {
        applied: 3,
        settled: 12,
        eligible: false,
        reason: "3/12 applied (25%) — apply unlocks at 10 settled with 80% applied",
      },
    });

    expect(screen.getByText(/apply locked · 3\/12 applied \(25%\)/)).toBeTruthy();
    expect(screen.getByText(/apply unlocks at 10 settled with 80% applied/)).toBeTruthy();
    expect(choice("parentless-cluster", "apply").disabled).toBe(true);
    // Only `apply` goes: `shadow` is how a record becomes readable in the first place and writes
    // nothing, so gating it would lock the door and pocket the key.
    expect(choice("parentless-cluster", "shadow").disabled).toBe(false);
    expect(choice("parentless-cluster", "propose").disabled).toBe(false);
    // Its neighbours are untouched — the record is per kind.
    expect(choice("container-orphan", "apply").disabled).toBe(false);
  });

  it("locks apply on a verdict that carries NO reason — eligible is the gate, reason only the label", () => {
    // `eligible` and `reason` are separate fields, and the server omits the reason whenever it has
    // none to give (an unreadable board yields counts of zero and nothing to say). A gate derived
    // from the reason would read that as "no lock" and leave apply CLICKABLE on a kind with no
    // record at all — the one direction this floor may never fail in.
    renderView({}, [], [], {
      ...EARNED,
      misfiled: { applied: 0, settled: 0, eligible: false },
    });

    expect(choice("misfiled", "apply").disabled).toBe(true);
    // Still accountable: a disabled control that names no reason is the failure one surface over.
    expect(screen.getByText(/apply locked · no record could be read/)).toBeTruthy();
    expect(choice("misfiled", "shadow").disabled).toBe(false);
  });

  it("locks every kind on the board as it stands — nothing has earned apply yet", () => {
    renderView({});
    for (const kind of KINDS) expect(choice(kind, "apply").disabled).toBe(true);
    expect(screen.getAllByText(/no settled proposals yet/).length).toBe(KINDS.length - 1);
  });

  it("shows the record on a kind that CLEARS the bar, not only on one that does not", () => {
    // A bar that speaks only when it refuses gives an operator no way to know it was consulted.
    renderView({}, [], [], EARNED);
    expect(screen.getAllByText(/record · 30\/30 applied — clears the bar/).length).toBe(
      KINDS.length - 1,
    );
  });

  it("states what arming apply costs in each group, not once for all of them", () => {
    // The whole point of the boxes: arming a link and arming a close are not the same decision, so
    // a single blanket warning at the top would flatten exactly the difference they exist to show.
    renderView({});

    expect(
      within(groupBox("Undone by one write")).getByText(/the cheapest group to arm first/),
    ).toBeTruthy();
    expect(
      within(groupBox("Takes work out of the queue")).getByText(
        /work stops being picked up while you sleep/,
      ),
    ).toBeTruthy();
    expect(
      within(groupBox("Writes history")).getByText(/what it writes outlives the undo/),
    ).toBeTruthy();
  });

  it("says where an unattended write is recorded, at the moment one is armed", () => {
    // An applied proposal closes as it is filed, so it never stands on the board as an ask. An
    // operator arming a kind has to be told where the evidence will be before they arm it.
    renderView({});
    const jobs = screen.getByRole("link", { name: "Jobs page" });
    expect(jobs.getAttribute("href")).toBe("/projects/tmp/jobs");
  });

  it("arming a kind at apply round-trips through the save", () => {
    const fetchMock = stubFetch();
    renderView({}, [], [], EARNED);

    fireEvent.click(choice("stale", "apply"));
    fireEvent.click(screen.getByRole("button", { name: /save changes/i }));

    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(body.proposalAutonomy.stale).toBe("apply");
  });

  it("survives a reload: a kind armed at apply comes back armed", () => {
    renderView({ proposalAutonomy: { stale: "apply" } }, [], [], EARNED);

    expect(choice("stale", "apply").checked).toBe(true);
    expect(choice("stale", "propose").checked).toBe(false);
  });

  it("seeds the control from a persisted policy (round-trip in)", () => {
    renderView({ proposalAutonomy: { stale: "shadow", "shipped-orphan": "shadow" } });

    expect(choice("stale", "shadow").checked).toBe(true);
    expect(choice("shipped-orphan", "shadow").checked).toBe(true);
    // Untouched kinds stay at the shipped default rather than inheriting a neighbour's level.
    expect(choice("mispriority", "propose").checked).toBe(true);
  });

  it("floors a stored level the kind can never reach back to propose", () => {
    // A hand-edited blob can name anything. Showing `oversized` as armed when autonomyFor would
    // answer `propose` for it is the one lie this control cannot tell.
    renderView({ proposalAutonomy: { oversized: "apply", stale: "nonsense" } }, [], [], EARNED);
    expect(choice("oversized", "propose").checked).toBe(true);
    expect(choice("stale", "propose").checked).toBe(true);
  });

  it("floors a stored apply the RECORD has not earned back to propose (anton-m29g)", () => {
    // Same lie, second floor: the pass resolves an unearned `apply` to `propose`, so a control
    // showing it armed would be describing a write that never happens.
    renderView({ proposalAutonomy: { stale: "apply" } });
    expect(choice("stale", "propose").checked).toBe(true);
    expect(choice("stale", "apply").checked).toBe(false);
  });

  it("PATCHes the whole policy on Save (round-trip out)", () => {
    const fetchMock = stubFetch();
    renderView({});

    const save = () => screen.getByRole("button", { name: /save changes/i }) as HTMLButtonElement;
    expect(save().disabled).toBe(true);

    fireEvent.click(choice("stale", "shadow"));
    expect(save().disabled).toBe(false);
    expect(screen.getByText("proposal autonomy")).toBeTruthy();

    fireEvent.click(save());
    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(body.proposalAutonomy.stale).toBe("shadow");
    // Explicit `propose` for the rest: the server merges per kind, so an omitted kind would keep
    // whatever it already held — which is how disarming one would silently fail to persist.
    expect(body.proposalAutonomy["shipped-orphan"]).toBe("propose");
    expect(Object.keys(body.proposalAutonomy).sort()).toEqual([...KINDS].sort());
  });

  it("survives a reload: what was saved comes back armed", () => {
    // The reload the operator actually performs — the page re-renders from the stored row.
    const { unmount } = renderView({});
    fireEvent.click(choice("low-value", "shadow"));
    unmount();

    renderView({ proposalAutonomy: { "low-value": "shadow" } });
    expect(choice("low-value", "shadow").checked).toBe(true);
    expect((screen.getByRole("button", { name: /save changes/i }) as HTMLButtonElement).disabled).toBe(
      true,
    );
  });

  it("disarming a kind is a save, not a no-op", () => {
    const fetchMock = stubFetch();
    renderView({ proposalAutonomy: { stale: "shadow" } });

    fireEvent.click(choice("stale", "propose"));
    fireEvent.click(screen.getByRole("button", { name: /save changes/i }));

    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(body.proposalAutonomy.stale).toBe("propose");
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

  /**
   * A save has to MOVE what "saved" means. Diffing against the SSR snapshot forever leaves the
   * operator with a page that says it has unsaved work seconds after it saved, and — worse — one
   * that refuses to persist a reversal because it mistakes the original value for the stored one.
   */
  describe("the dirty baseline after a save", () => {
    /** Save resolving with the row the server stored, as the real PATCH route answers. */
    function stubSaveReturning(stored: Record<string, unknown>) {
      const fetchMock = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(
        () => Promise.resolve(new Response(JSON.stringify({ settings: stored }), { status: 200 })),
      );
      vi.stubGlobal("fetch", fetchMock);
      return fetchMock;
    }

    it("clears the unsaved indicators once the save lands", async () => {
      const fetchMock = stubSaveReturning({ seedPrompt: "prefer RSC" });
      window.location.hash = "#prompt";
      renderView({});
      const save = () => screen.getByRole("button", { name: /save changes/i }) as HTMLButtonElement;

      fireEvent.change(screen.getByLabelText("Seed prompt"), { target: { value: "prefer RSC" } });
      expect(save().disabled).toBe(false);
      expect(screen.getByText("execution prompt")).toBeTruthy();

      fireEvent.click(save());
      await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

      await waitFor(() => expect(save().disabled).toBe(true));
      expect(screen.queryByText("execution prompt")).toBeNull();
    });

    it("re-arms Save when a field is put back to what it held before the save", async () => {
      // The server now holds "prefer RSC". Typing the original text back is an EDIT against that,
      // and it must be submittable — otherwise the only way to undo a save is to reload the page.
      const fetchMock = stubSaveReturning({ seedPrompt: "prefer RSC" });
      window.location.hash = "#prompt";
      renderView({ seedPrompt: "original" });
      const save = () => screen.getByRole("button", { name: /save changes/i }) as HTMLButtonElement;
      const field = () => screen.getByLabelText("Seed prompt");

      fireEvent.change(field(), { target: { value: "prefer RSC" } });
      fireEvent.click(save());
      await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
      await waitFor(() => expect(save().disabled).toBe(true));

      fireEvent.change(field(), { target: { value: "original" } });
      expect(save().disabled).toBe(false);

      fireEvent.click(save());
      await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
      const sent = JSON.parse((fetchMock.mock.calls[1][1] as RequestInit).body as string);
      expect(sent.seedPrompt).toBe("original");
    });

    it("leaves the baseline alone when the save fails, so the edit is not lost", async () => {
      const fetchMock = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(
        () => Promise.resolve(new Response(JSON.stringify({ error: "nope" }), { status: 400 })),
      );
      vi.stubGlobal("fetch", fetchMock);
      window.location.hash = "#prompt";
      renderView({});
      const save = () => screen.getByRole("button", { name: /save changes/i }) as HTMLButtonElement;

      fireEvent.change(screen.getByLabelText("Seed prompt"), { target: { value: "prefer RSC" } });
      fireEvent.click(save());
      await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

      await waitFor(() => expect(vi.mocked(toast.error)).toHaveBeenCalledWith("nope"));
      expect(save().disabled).toBe(false);
    });
  });
});

/**
 * The cadence coupling (anton-3xa9, design R7.1): arming the board-picker is what turns
 * product-master's judgment from something a human reads into something anton executes, so it — and
 * only it — offers to raise that cadence. What is under test is the whole contract of an offer: it
 * appears on ARM, it says WHY, a refusal sticks, and nothing moves a schedule on its own.
 */
describe("SettingsView product-master cadence offer (anton-3xa9)", () => {
  showing("automation");

  const WEEKLY = "0 6 * * 1";
  const DAILY = "0 6 * * *";

  /** Both coupled rows as the server would hand them in: picker off, product-master on and weekly. */
  function coupledSchedules(
    overrides: { picker?: Record<string, unknown>; pm?: Record<string, unknown> } = {},
  ) {
    return [
      { type: "board-picker", enabled: false, cron: "*/10 * * * *", ...overrides.picker },
      { type: "product-master", enabled: true, cron: WEEKLY, ...overrides.pm },
    ];
  }

  /**
   * One stub for both writes this panel makes — the schedules PATCH (echoing the row as stored, the
   * way the route does) and the settings PATCH the opt-out goes through — plus the panel's own GET
   * poll, which would otherwise reach for a relative URL jsdom cannot serve.
   */
  function stubPanelFetch() {
    const fetchMock = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(
      (input, init) => {
        const url = String(input);
        if (init?.method !== "PATCH") {
          return Promise.resolve(new Response(JSON.stringify({ schedules: [] })));
        }
        if (!url.endsWith("/schedules")) {
          return Promise.resolve(new Response(JSON.stringify({ settings: {} })));
        }
        const patch = JSON.parse(init.body as string) as Record<string, unknown>;
        const type = patch.type as keyof typeof DEFAULT_CRONS;
        return Promise.resolve(
          new Response(
            JSON.stringify({
              schedule: { enabled: true, cron: DEFAULT_CRONS[type], ...patch },
            }),
          ),
        );
      },
    );
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }

  const patchesTo = (fetchMock: ReturnType<typeof stubPanelFetch>, path: string) =>
    fetchMock.mock.calls.filter(
      (c) => (c[1] as RequestInit | undefined)?.method === "PATCH" && String(c[0]).endsWith(path),
    );

  const bodyOf = (call: unknown[]) => JSON.parse((call[1] as RequestInit).body as string);

  const arm = () => fireEvent.click(screen.getByRole("switch", { name: "board-picker" }));
  const offer = () => screen.queryByRole("status");
  const cadenceOf = (name: string) =>
    screen.getByRole("button", { name: `${name} cadence` }).textContent;

  it("offers the daily cadence once the arm lands, and says why it is asking", async () => {
    stubPanelFetch();
    renderView({}, [], coupledSchedules());

    expect(offer()).toBeNull();
    arm();

    // Not before the write: the offer's premise is that the picker IS armed.
    expect(offer()).toBeNull();
    await waitFor(() => expect(offer()).toBeTruthy());
    const prompt = offer();
    // The WHY, not the mechanism: the picker consumes these priorities now, so staleness costs
    // something. And only what the build actually does — the picker records a plan, it starts
    // nothing — because the offer buys a daily claude session and must not sell an absent feature.
    expect(prompt!.textContent).toMatch(/ranks what could run next/);
    expect(prompt!.textContent).toMatch(/starts nothing yet/);
    expect(prompt!.textContent).not.toMatch(/executed/);
    expect(prompt!.textContent).toContain("Weekly on Monday at 06:00");
    expect(prompt!.textContent).toContain("Daily at 06:00");
    // Asking is not doing — the cadence is untouched until the operator answers.
    expect(cadenceOf("product-master")).toContain("Weekly on Monday at 06:00");
  });

  it("raises the cadence only on an explicit accept, keeping the operator's time of day", async () => {
    const fetchMock = stubPanelFetch();
    renderView({}, [], coupledSchedules({ pm: { cron: "30 22 * * 5" } }));

    arm();
    await waitFor(() => expect(offer()).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Raise to daily" }));

    await waitFor(() => expect(patchesTo(fetchMock, "/schedules")).toHaveLength(2));
    // The arm itself, then the cadence — 22:30 preserved, only the day-of-week dropped.
    expect(bodyOf(patchesTo(fetchMock, "/schedules")[1])).toEqual({
      type: "product-master",
      cron: "30 22 * * *",
    });
    await waitFor(() => expect(cadenceOf("product-master")).toContain("Daily at 22:30"));
    expect(offer()).toBeNull();
  });

  it("honours keep-weekly, persists it, and never asks again", async () => {
    const fetchMock = stubPanelFetch();
    renderView({}, [], coupledSchedules());

    arm();
    await waitFor(() => expect(offer()).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Keep weekly" }));

    // The answer is stored, not just dismissed — otherwise the next arm asks it all over again.
    await waitFor(() => expect(patchesTo(fetchMock, "/settings")).toHaveLength(1));
    expect(bodyOf(patchesTo(fetchMock, "/settings")[0])).toEqual({
      keepProductMasterWeekly: true,
    });
    expect(offer()).toBeNull();
    expect(cadenceOf("product-master")).toContain("Weekly on Monday at 06:00");

    // Disarm, arm again: the question is answered, so it stays answered.
    arm();
    arm();
    await waitFor(() => expect(patchesTo(fetchMock, "/schedules")).toHaveLength(3));
    expect(offer()).toBeNull();
    expect(patchesTo(fetchMock, "/schedules").every((c) => bodyOf(c).cron === undefined)).toBe(true);
  });

  it("does not re-ask an operator who already answered in a previous session", () => {
    stubPanelFetch();
    renderView({ keepProductMasterWeekly: true }, [], coupledSchedules());

    arm();
    expect(offer()).toBeNull();
  });

  it("puts the opt-out back when it could not be stored, rather than swallowing it", async () => {
    const fetchMock = stubPanelFetch();
    fetchMock.mockImplementation((input, init) => {
      if (init?.method === "PATCH" && String(input).endsWith("/settings")) {
        return Promise.resolve(new Response(JSON.stringify({ error: "disk full" }), { status: 500 }));
      }
      if (init?.method !== "PATCH") {
        return Promise.resolve(new Response(JSON.stringify({ schedules: [] })));
      }
      const patch = JSON.parse(init.body as string) as Record<string, unknown>;
      return Promise.resolve(
        new Response(JSON.stringify({ schedule: { cron: WEEKLY, ...patch } })),
      );
    });
    renderView({}, [], coupledSchedules());

    arm();
    await waitFor(() => expect(offer()).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Keep weekly" }));

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("disk full"));
    // Nothing was stored, so the question comes straight back on screen: an operator told the write
    // failed and then shown the outcome of it succeeding has to trust two contradictory things.
    expect(offer()).toBeTruthy();

    // And the standing answer went back with it, so a later arm asks again too.
    arm();
    expect(offer()).toBeNull();
    arm();
    await waitFor(() => expect(offer()).toBeTruthy());
  });

  it("opens no offer when the arm itself failed — the condition it names never happened", async () => {
    const fetchMock = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(
      (_input, init) =>
        Promise.resolve(
          init?.method === "PATCH"
            ? new Response(JSON.stringify({ error: "schedule store down" }), { status: 500 })
            : new Response(JSON.stringify({ schedules: [] })),
        ),
    );
    vi.stubGlobal("fetch", fetchMock);
    renderView({}, [], coupledSchedules());

    arm();

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("schedule store down"));
    // The toggle rolled back, so nothing on screen claims the picker is armed — and nothing offers
    // to raise a cadence because it is.
    expect(offer()).toBeNull();
    expect(screen.getByRole("switch", { name: "board-picker" }).getAttribute("aria-checked")).toBe(
      "false",
    );
  });

  it("disarming changes no cadence and withdraws an unanswered question", async () => {
    const fetchMock = stubPanelFetch();
    renderView({}, [], coupledSchedules({ picker: { enabled: true } }));

    // Disarm: no offer, and above all no cadence PATCH — a schedule that sprang back on its own
    // would make this table untrustworthy about the one thing it exists to report.
    fireEvent.click(screen.getByRole("switch", { name: "board-picker" }));
    expect(offer()).toBeNull();
    await waitFor(() => expect(patchesTo(fetchMock, "/schedules")).toHaveLength(1));
    expect(bodyOf(patchesTo(fetchMock, "/schedules")[0])).toEqual({
      type: "board-picker",
      enabled: false,
    });
    expect(cadenceOf("product-master")).toContain("Weekly on Monday at 06:00");

    // Re-arm with the offer open, then disarm again: the question goes, the cadence stays.
    arm();
    await waitFor(() => expect(offer()).toBeTruthy());
    fireEvent.click(screen.getByRole("switch", { name: "board-picker" }));
    expect(offer()).toBeNull();
    expect(cadenceOf("product-master")).toContain("Weekly on Monday at 06:00");
  });

  it("puts the question back when the toggle that withdrew it never landed", async () => {
    const fetchMock = stubPanelFetch();
    fetchMock.mockImplementation((_input, init) => {
      if (init?.method !== "PATCH") {
        return Promise.resolve(new Response(JSON.stringify({ schedules: [] })));
      }
      const patch = JSON.parse(init.body as string) as Record<string, unknown>;
      // Only the disables refuse, so the arm that opens the question still lands. Each names its own
      // row, so the two failures below are told apart by their message.
      if (patch.enabled === false) {
        return Promise.resolve(
          new Response(JSON.stringify({ error: `${patch.type} store down` }), { status: 500 }),
        );
      }
      const type = patch.type as keyof typeof DEFAULT_CRONS;
      return Promise.resolve(
        new Response(
          JSON.stringify({ schedule: { enabled: true, cron: DEFAULT_CRONS[type], ...patch } }),
        ),
      );
    });
    renderView({}, [], coupledSchedules());

    arm();
    await waitFor(() => expect(offer()).toBeTruthy());

    // Disarming withdraws the question ahead of the write — but the write refused, so the picker is
    // armed after all and the question is true again. Left withdrawn, an operator would have to
    // cycle the toggle until a write succeeded before they could answer it.
    fireEvent.click(screen.getByRole("switch", { name: "board-picker" }));
    expect(offer()).toBeNull();
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("board-picker store down"));
    expect(offer()).toBeTruthy();
    expect(screen.getByRole("switch", { name: "board-picker" }).getAttribute("aria-checked")).toBe(
      "true",
    );

    // The same for the job the question is ABOUT: a product-master disable that refused leaves it
    // enabled and weekly, which is the premise the offer names.
    fireEvent.click(screen.getByRole("switch", { name: "product-master" }));
    expect(offer()).toBeNull();
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("product-master store down"));
    expect(offer()).toBeTruthy();
    expect(cadenceOf("product-master")).toContain("Weekly on Monday at 06:00");
    expect(screen.getByRole("button", { name: "Raise to daily" })).toBeTruthy();
  });

  it("puts the offer back when the cadence write failed, so the answer can be given again", async () => {
    const fetchMock = stubPanelFetch();
    fetchMock.mockImplementation((_input, init) => {
      if (init?.method !== "PATCH") {
        return Promise.resolve(new Response(JSON.stringify({ schedules: [] })));
      }
      const patch = JSON.parse(init.body as string) as Record<string, unknown>;
      if (patch.cron !== undefined) {
        return Promise.resolve(
          new Response(JSON.stringify({ error: "invalid cron" }), { status: 500 }),
        );
      }
      return Promise.resolve(
        new Response(JSON.stringify({ schedule: { enabled: true, cron: "*/10 * * * *", ...patch } })),
      );
    });
    renderView({}, [], coupledSchedules());

    arm();
    await waitFor(() => expect(offer()).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Raise to daily" }));

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("invalid cron"));
    // The cadence rolled back to weekly, so the question is true again — and an operator who chose
    // daily and landed back on weekly with the offer gone would have no way to say it a second time.
    expect(cadenceOf("product-master")).toContain("Weekly on Monday at 06:00");
    expect(offer()).toBeTruthy();
    expect(screen.getByRole("button", { name: "Raise to daily" })).toBeTruthy();
  });

  it("does not resurrect a question the operator killed while the accept was in flight", async () => {
    let failCadence: (() => void) | undefined;
    const fetchMock = stubPanelFetch();
    fetchMock.mockImplementation((_input, init) => {
      if (init?.method !== "PATCH") {
        return Promise.resolve(new Response(JSON.stringify({ schedules: [] })));
      }
      const patch = JSON.parse(init.body as string) as Record<string, unknown>;
      if (patch.cron === undefined) {
        return Promise.resolve(
          new Response(
            JSON.stringify({ schedule: { enabled: patch.enabled, cron: "*/10 * * * *", ...patch } }),
          ),
        );
      }
      return new Promise<Response>((resolve) => {
        failCadence = () =>
          resolve(new Response(JSON.stringify({ error: "invalid cron" }), { status: 500 }));
      });
    });
    renderView({}, [], coupledSchedules());

    arm();
    await waitFor(() => expect(offer()).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Raise to daily" }));
    await waitFor(() => expect(failCadence).toBeTruthy());

    // Disarm with the cadence PATCH still open. The offer's premise is gone, so the failure must
    // restore nothing: an offer to speed up a pass whose output feeds nothing is a question about
    // a picker that is now off.
    fireEvent.click(screen.getByRole("switch", { name: "board-picker" }));
    failCadence!();

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("invalid cron"));
    expect(offer()).toBeNull();
  });

  it("opens no offer for a job switched off while the arm was still in flight", async () => {
    let finishArm: (() => void) | undefined;
    const fetchMock = stubPanelFetch();
    fetchMock.mockImplementation((_input, init) => {
      if (init?.method !== "PATCH") {
        return Promise.resolve(new Response(JSON.stringify({ schedules: [] })));
      }
      const patch = JSON.parse(init.body as string) as Record<string, unknown>;
      const stored = (row: Record<string, unknown>) =>
        new Response(JSON.stringify({ schedule: { enabled: true, cron: WEEKLY, ...row } }));
      if (patch.type !== "board-picker") return Promise.resolve(stored(patch));
      return new Promise<Response>((resolve) => {
        finishArm = () => resolve(stored({ cron: "*/10 * * * *", ...patch }));
      });
    });
    renderView({}, [], coupledSchedules());

    arm();
    await waitFor(() => expect(finishArm).toBeTruthy());

    // Switch product-master off with the arm still open. The offer is decided when the arm LANDS,
    // and by then its premise is gone: asking how often a job that no longer runs should run.
    fireEvent.click(screen.getByRole("switch", { name: "product-master" }));
    finishArm!();

    await waitFor(() => expect(toast.success).toHaveBeenCalledWith("board-picker enabled"));
    expect(offer()).toBeNull();
  });

  it("opens no offer for a picker disarmed while its own arm was still in flight", async () => {
    let finishArm: (() => void) | undefined;
    let finishDisarm: (() => void) | undefined;
    const fetchMock = stubPanelFetch();
    fetchMock.mockImplementation((_input, init) => {
      if (init?.method !== "PATCH") {
        return Promise.resolve(new Response(JSON.stringify({ schedules: [] })));
      }
      const patch = JSON.parse(init.body as string) as Record<string, unknown>;
      const stored = (row: Record<string, unknown>) =>
        new Response(JSON.stringify({ schedule: { enabled: true, cron: WEEKLY, ...row } }));
      // Both picker writes are held, so the test decides which response lands first.
      if (patch.type !== "board-picker") return Promise.resolve(stored(patch));
      return new Promise<Response>((resolve) => {
        const answer = () => resolve(stored({ cron: "*/10 * * * *", ...patch }));
        if (patch.enabled === true) finishArm = answer;
        else finishDisarm = answer;
      });
    });
    renderView({}, [], coupledSchedules());

    arm();
    await waitFor(() => expect(finishArm).toBeTruthy());

    // Disarm the SAME row with its arm still open. The withdrawal fires before any offer exists, so
    // nothing but the operator's last click stops the arm's response putting a question on screen
    // about a picker they have already turned off — and accepting it would raise product-master to
    // daily for a picker that executes nothing.
    fireEvent.click(screen.getByRole("switch", { name: "board-picker" }));
    // The disarm is QUEUED, not sent: same row, and the route read-modify-writes it (see
    // `scheduleWrites`). Its PATCH goes out only once the arm's response has landed.
    expect(finishDisarm).toBeUndefined();
    expect(patchesTo(fetchMock, "/schedules")).toHaveLength(1);

    finishArm!();
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith("board-picker enabled"));
    expect(offer()).toBeNull();

    await waitFor(() => expect(finishDisarm).toBeTruthy());
    finishDisarm!();
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith("board-picker disabled"));
    expect(offer()).toBeNull();
    expect(screen.getByRole("switch", { name: "board-picker" }).getAttribute("aria-checked")).toBe(
      "false",
    );
  });

  it("asks the question a failed disarm suppressed, once the picker turns out to be armed", async () => {
    let finishArm: (() => void) | undefined;
    let failDisarm: (() => void) | undefined;
    const fetchMock = stubPanelFetch();
    fetchMock.mockImplementation((_input, init) => {
      if (init?.method !== "PATCH") {
        return Promise.resolve(new Response(JSON.stringify({ schedules: [] })));
      }
      const patch = JSON.parse(init.body as string) as Record<string, unknown>;
      const stored = (row: Record<string, unknown>) =>
        new Response(JSON.stringify({ schedule: { enabled: true, cron: WEEKLY, ...row } }));
      if (patch.type !== "board-picker") return Promise.resolve(stored(patch));
      // Both picker writes are held, so the test decides when each answer lands — the disarm's is
      // a refusal.
      return new Promise<Response>((resolve) => {
        if (patch.enabled === true) finishArm = () => resolve(stored({ cron: "*/10 * * * *", ...patch }));
        else
          failDisarm = () =>
            resolve(new Response(JSON.stringify({ error: "picker store down" }), { status: 500 }));
      });
    });
    renderView({}, [], coupledSchedules());

    arm();
    await waitFor(() => expect(finishArm).toBeTruthy());

    // Disarm with the arm still open: the arm lands first and its question is rightly suppressed,
    // because the operator's last click asked for the picker to be off.
    fireEvent.click(screen.getByRole("switch", { name: "board-picker" }));
    finishArm!();
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith("board-picker enabled"));
    await waitFor(() => expect(failDisarm).toBeTruthy());
    expect(offer()).toBeNull();

    // Then the disarm refuses. The picker is armed after all, and the question that click
    // suppressed was never asked at all — left unasked, only cycling the toggle would get it back.
    failDisarm!();
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("picker store down"));
    await waitFor(() => expect(offer()).toBeTruthy());
    expect(offer()!.textContent).toContain("Daily at 06:00");
    expect(screen.getByRole("switch", { name: "board-picker" }).getAttribute("aria-checked")).toBe(
      "true",
    );
  });

  it("does not put an answered offer back once its job was switched off mid-write", async () => {
    let failOptOut: (() => void) | undefined;
    const fetchMock = stubPanelFetch();
    fetchMock.mockImplementation((input, init) => {
      if (init?.method !== "PATCH") {
        return Promise.resolve(new Response(JSON.stringify({ schedules: [] })));
      }
      if (String(input).endsWith("/settings")) {
        return new Promise<Response>((resolve) => {
          failOptOut = () =>
            resolve(new Response(JSON.stringify({ error: "disk full" }), { status: 500 }));
        });
      }
      const patch = JSON.parse(init.body as string) as Record<string, unknown>;
      return Promise.resolve(
        new Response(JSON.stringify({ schedule: { enabled: true, cron: WEEKLY, ...patch } })),
      );
    });
    renderView({}, [], coupledSchedules());

    arm();
    await waitFor(() => expect(offer()).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Keep weekly" }));
    await waitFor(() => expect(failOptOut).toBeTruthy());

    // Switching product-master off does not withdraw an offer that is already off screen, so only
    // re-reading the row catches it: the opt-out failed and is reverted, but the question it
    // answered is dead on its own terms and must not come back.
    fireEvent.click(screen.getByRole("switch", { name: "product-master" }));
    failOptOut!();

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("disk full"));
    expect(offer()).toBeNull();
  });

  /**
   * The opt-out and "Save changes" write the SAME settings row, and the route read-modify-writes the
   * whole of it — so two in flight at once is a lost update, and the loser is whichever replies
   * first, with a success toast either way.
   */
  it("queues the opt-out behind an open save, so neither PATCH drops the other's fields", async () => {
    let finishSave: (() => void) | undefined;
    const fetchMock = stubPanelFetch();
    fetchMock.mockImplementation((input, init) => {
      if (init?.method !== "PATCH") {
        return Promise.resolve(new Response(JSON.stringify({ schedules: [] })));
      }
      if (String(input).endsWith("/settings")) {
        // The form save is held open; the opt-out answers immediately if it ever gets sent.
        if ((init.body as string).includes("keepProductMasterWeekly")) {
          return Promise.resolve(new Response(JSON.stringify({ settings: {} })));
        }
        return new Promise<Response>((resolve) => {
          finishSave = () => resolve(new Response(JSON.stringify({ settings: {} })));
        });
      }
      const patch = JSON.parse(init.body as string) as Record<string, unknown>;
      return Promise.resolve(
        new Response(JSON.stringify({ schedule: { enabled: true, cron: WEEKLY, ...patch } })),
      );
    });
    renderView({}, [], coupledSchedules());

    // Stage an edit in another section so Save is offered at all, then come back and raise the offer.
    fireEvent.click(screen.getByRole("button", { name: "Execution prompt" }));
    fireEvent.change(screen.getByLabelText("Seed prompt"), { target: { value: "prefer RSC" } });
    fireEvent.click(screen.getByRole("button", { name: "Automation" }));
    arm();
    await waitFor(() => expect(offer()).toBeTruthy());

    fireEvent.click(screen.getByRole("button", { name: /save changes/i }));
    await waitFor(() => expect(finishSave).toBeTruthy());

    // Answered with the save still open: the second PATCH must not be sent yet, or it reads a row
    // the save has not written and rewrites it without the staged prompt.
    fireEvent.click(screen.getByRole("button", { name: "Keep weekly" }));
    expect(patchesTo(fetchMock, "/settings")).toHaveLength(1);

    finishSave!();
    await waitFor(() => expect(patchesTo(fetchMock, "/settings")).toHaveLength(2));
    expect(bodyOf(patchesTo(fetchMock, "/settings")[1])).toEqual({ keepProductMasterWeekly: true });
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith("product-master stays weekly"));
  });

  it("withdraws the offer when the operator sets that cadence by hand instead", async () => {
    const fetchMock = stubPanelFetch();
    renderView({}, [], coupledSchedules());

    arm();
    await waitFor(() => expect(offer()).toBeTruthy());

    // A hand edit answers the question by superseding it. Leaving the offer up would let an accept
    // afterwards overwrite the cadence just chosen with one computed from the row it replaced.
    fireEvent.click(screen.getByRole("button", { name: "product-master cadence" }));
    fireEvent.click(screen.getByRole("button", { name: "Daily" }));
    fireEvent.click(screen.getByRole("button", { name: "Set cadence" }));

    await waitFor(() => expect(patchesTo(fetchMock, "/schedules")).toHaveLength(2));
    expect(bodyOf(patchesTo(fetchMock, "/schedules")[1]).type).toBe("product-master");
    expect(offer()).toBeNull();
  });

  it("withdraws the offer when product-master itself is switched off", async () => {
    stubPanelFetch();
    renderView({}, [], coupledSchedules());

    arm();
    await waitFor(() => expect(offer()).toBeTruthy());

    // Its cadence is moot once it is off — the offer would be asking how often a job that no longer
    // runs should run.
    fireEvent.click(screen.getByRole("switch", { name: "product-master" }));
    expect(offer()).toBeNull();
  });

  /**
   * Two clicks on one row: the route read-modify-writes it, so the second PATCH is queued behind the
   * first (see `queueRowWrite`) and the first answer describes a row the operator has already moved
   * past. Applying that answer whole would put the superseded state back on screen — and the offer,
   * decided against the live rows, would then be asked about it.
   */
  it("keeps a queued disable on screen when the enable's response lands first", async () => {
    const answers: Array<() => void> = [];
    const fetchMock = stubPanelFetch();
    fetchMock.mockImplementation((_input, init) => {
      if (init?.method !== "PATCH") {
        return Promise.resolve(new Response(JSON.stringify({ schedules: [] })));
      }
      const patch = JSON.parse(init.body as string) as Record<string, unknown>;
      const stored = new Response(JSON.stringify({ schedule: { cron: WEEKLY, ...patch } }));
      return new Promise<Response>((resolve) => answers.push(() => resolve(stored)));
    });
    // Picker already armed and product-master off: enabling it is the half that completes the
    // coupling, so its response is the one that would open the offer.
    renderView({}, [], coupledSchedules({ picker: { enabled: true }, pm: { enabled: false } }));

    const pm = () => screen.getByRole("switch", { name: "product-master" });
    fireEvent.click(pm());
    await waitFor(() => expect(answers).toHaveLength(1));

    // Switched straight back off. The second write is QUEUED, not sent — but it is what the operator
    // asked for, and it is already on screen.
    fireEvent.click(pm());
    expect(patchesTo(fetchMock, "/schedules")).toHaveLength(1);
    expect(pm().getAttribute("aria-checked")).toBe("false");

    answers[0]!();
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith("product-master enabled"));
    // The enable's answer is true of its own write and stale of the row: the later click stands, and
    // no offer is opened to raise the cadence of a job that is on its way off.
    expect(pm().getAttribute("aria-checked")).toBe("false");
    expect(offer()).toBeNull();

    await waitFor(() => expect(answers).toHaveLength(2));
    answers[1]!();
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith("product-master disabled"));
    expect(pm().getAttribute("aria-checked")).toBe("false");
    expect(offer()).toBeNull();
  });

  it("keeps a cadence edit queued behind a toggle, rather than restoring the echoed cron", async () => {
    const answers: Array<() => void> = [];
    const fetchMock = stubPanelFetch();
    fetchMock.mockImplementation((_input, init) => {
      if (init?.method !== "PATCH") {
        return Promise.resolve(new Response(JSON.stringify({ schedules: [] })));
      }
      const patch = JSON.parse(init.body as string) as Record<string, unknown>;
      const stored = new Response(
        JSON.stringify({ schedule: { enabled: true, cron: WEEKLY, ...patch } }),
      );
      return new Promise<Response>((resolve) => answers.push(() => resolve(stored)));
    });
    renderView({}, [], coupledSchedules({ picker: { enabled: true }, pm: { enabled: false } }));

    fireEvent.click(screen.getByRole("switch", { name: "product-master" }));
    await waitFor(() => expect(answers).toHaveLength(1));

    // Retimed while the toggle is still open. The toggle's answer echoes the cadence as it was when
    // that write ran — weekly — which must not overwrite the daily the operator has just picked.
    fireEvent.click(screen.getByRole("button", { name: "product-master cadence" }));
    fireEvent.click(screen.getByRole("button", { name: "Daily" }));
    fireEvent.click(screen.getByRole("button", { name: "Set cadence" }));
    expect(cadenceOf("product-master")).toContain("Daily at 06:00");

    answers[0]!();
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith("product-master enabled"));
    expect(cadenceOf("product-master")).toContain("Daily at 06:00");

    await waitFor(() => expect(answers).toHaveLength(2));
    answers[1]!();
    await waitFor(() => expect(patchesTo(fetchMock, "/schedules")).toHaveLength(2));
    expect(cadenceOf("product-master")).toContain("Daily at 06:00");
  });

  it("stays quiet when there is nothing to raise", () => {
    stubPanelFetch();
    // Already daily — and a hand-written expression or an off product-master are the same silence:
    // an offer that promised a change it would not make is worse than no offer.
    const { unmount } = renderView({}, [], coupledSchedules({ pm: { cron: DAILY } }));
    arm();
    expect(offer()).toBeNull();
    unmount();

    renderView({}, [], coupledSchedules({ pm: { enabled: false } }));
    arm();
    expect(offer()).toBeNull();
  });
});
