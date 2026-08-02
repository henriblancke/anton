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

function renderView(
  settings: Parameters<typeof SettingsView>[0]["settings"] = {},
  agents: Parameters<typeof SettingsView>[0]["agents"] = [],
) {
  return render(
    <SettingsView
      project={project}
      settings={settings}
      basePrompt="base"
      schedules={[]}
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
    expect((screen.getByLabelText("Minimum score") as HTMLInputElement).value).toBe("5");
    expect((screen.getByLabelText("Consecutive low rounds") as HTMLInputElement).value).toBe("2");
    expect((screen.getByLabelText("Review prompt") as HTMLTextAreaElement).value).toBe("");
  });

  it("seeds, clamps and PATCHes the score-alarm thresholds (anton-i98r)", () => {
    const fetchMock = stubFetch();
    renderView({ reviewMinScore: 7, reviewLowScoreRounds: 3 }, reviewers);
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
