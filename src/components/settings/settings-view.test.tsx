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

/**
 * The autopilot brakes (anton-nmy7). These four decide when anton stops STARTING work, and one of
 * them latches a freeze only a human lifts — so an operator who cannot reach them here has to hand
 * craft an API request to tune or disable a brake that is already holding their project.
 */
describe("SettingsView autopilot brakes (anton-nmy7)", () => {
  showing("autopilot");

  it("falls back to the shipped defaults when nothing is persisted", () => {
    renderView({});
    expect((screen.getByLabelText("Open PRs in review") as HTMLInputElement).value).toBe("3");
    expect((screen.getByLabelText("Failed runs in a row") as HTMLInputElement).value).toBe("3");
    expect((screen.getByLabelText("Score floor") as HTMLInputElement).value).toBe("7");
    expect((screen.getByLabelText("Consecutive runs below it") as HTMLInputElement).value).toBe("3");
  });

  it("seeds every knob from persisted settings (round-trip in)", () => {
    renderView({
      autopilotWipLimit: 5,
      autopilotFailureStreak: 4,
      autopilotScoreFloor: 8,
      autopilotScoreWindow: 2,
    });
    expect((screen.getByLabelText("Open PRs in review") as HTMLInputElement).value).toBe("5");
    expect((screen.getByLabelText("Failed runs in a row") as HTMLInputElement).value).toBe("4");
    expect((screen.getByLabelText("Score floor") as HTMLInputElement).value).toBe("8");
    expect((screen.getByLabelText("Consecutive runs below it") as HTMLInputElement).value).toBe("2");
  });

  it("PATCHes the edited brakes on Save (round-trip out)", () => {
    const fetchMock = stubFetch();
    renderView({});

    fireEvent.change(screen.getByLabelText("Open PRs in review"), { target: { value: "6" } });
    fireEvent.change(screen.getByLabelText("Score floor"), { target: { value: "9" } });
    fireEvent.click(screen.getByRole("button", { name: /save changes/i }));

    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(body).toMatchObject({
      autopilotWipLimit: 6,
      autopilotFailureStreak: 3,
      autopilotScoreFloor: 9,
      autopilotScoreWindow: 3,
    });
  });

  it("sends a disabling 0 as a real value, not as a cleared override", () => {
    // null would reset the knob to the shipped default — the exact opposite of what an operator
    // turning a brake off asked for.
    const fetchMock = stubFetch();
    renderView({});

    fireEvent.change(screen.getByLabelText("Failed runs in a row"), { target: { value: "0" } });
    fireEvent.click(screen.getByRole("button", { name: /save changes/i }));

    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(body.autopilotFailureStreak).toBe(0);
  });

  it("says which brakes are off, rather than showing a 0 that reads as 'immediately'", () => {
    renderView({ autopilotWipLimit: 0, autopilotFailureStreak: 0, autopilotScoreFloor: 0 });
    expect(screen.getByText(/off · anton starts work however many PRs are waiting on you/)).toBeTruthy();
    expect(screen.getByText(/off · anton keeps starting runs however many fail/)).toBeTruthy();
    expect(screen.getByText(/off · anton keeps starting runs however they score/)).toBeTruthy();
    // The window is meaningless with no floor — disabled, never silently reset.
    expect((screen.getByLabelText("Consecutive runs below it") as HTMLInputElement).disabled).toBe(
      true,
    );
  });

  it("clamps an out-of-range knob to the range the API would have rejected", () => {
    renderView({});
    const floor = screen.getByLabelText("Score floor") as HTMLInputElement;
    fireEvent.change(floor, { target: { value: "99" } });
    expect(floor.value).toBe("10");
  });

  it("names the hold's release condition — the one brake nobody has to clear", () => {
    renderView({});
    expect(screen.getByText(/releases itself the moment one of those PRs merges or closes/i)).toBeTruthy();
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
      within(groupBox("Writes history")).getByText(/the claim it writes outlives the undo/),
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
