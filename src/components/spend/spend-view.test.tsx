// @vitest-environment jsdom
/**
 * The Spend page (anton-1kdm), tested at its own boundary.
 *
 * The claim under test is honesty about what each number IS. A page that rendered `$0.00` for a
 * project nobody has metered would be read as "the runs were free"; a page that borrowed the quota
 * panel's `≈` would throw away the one thing this feature adds over the sampled estimate it sits
 * beside. Each case below is a way the numbers could mislead, not a way the layout could shift.
 */
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";

import { SpendView } from "@/components/spend/spend-view";
import { breakdownBy, type SpendRow } from "@/lib/spend-breakdown";
import {
  divergenceSummary,
  groupInvocations,
  type InvocationDimensionRow,
} from "@/lib/model-divergence";

afterEach(cleanup);

const AT = new Date("2026-09-09T12:00:00Z");

function row(overrides: Partial<SpendRow> = {}): SpendRow {
  return {
    modelReported: "claude-opus-5",
    jobType: "execute-epic",
    step: "implement",
    inputTokens: 40_000,
    outputTokens: 20_000,
    cacheReadInputTokens: 900_000,
    cacheCreationInputTokens: 30_000,
    ...overrides,
  };
}

/** The ledger row shape the divergence read needs, which carries dimensions the fold does not. */
function ledgerRow(overrides: Partial<SpendRow> = {}): SpendRow & InvocationDimensionRow {
  return {
    ...row(overrides),
    projectId: "proj-a",
    jobId: "job-a",
    runId: "run-a",
    beadId: "anton-aaaa",
    claudeSessionId: "sess-a",
    modelRequested: "opus",
    endpointHost: null,
    outcome: "ok",
    recordedAt: AT,
  };
}

/** The page as its server component drives it: both folds and the verdict, over one row set. */
function view(rows: SpendRow[], ledger = rows.map((r) => ledgerRow(r))) {
  return (
    <SpendView
      slug="acme"
      window="7d"
      model={breakdownBy(rows, "model")}
      task={breakdownBy(rows, "task")}
      divergence={divergenceSummary(groupInvocations(ledger))}
    />
  );
}

const tableFor = (caption: string) =>
  screen.getByRole("columnheader", { name: caption }).closest("table")!;

describe("a project with recorded calls", () => {
  const ROWS = [
    row({ modelReported: "claude-opus-5", step: "implement" }),
    row({ modelReported: "claude-haiku-4-5", step: "implement", outputTokens: 2_000 }),
    row({ modelReported: "claude-sonnet-5", step: "review", outputTokens: 8_000 }),
  ];

  it("breaks spend down by model AND by task", () => {
    render(view(ROWS));

    const models = within(tableFor("Model"));
    expect(models.getByText("claude-opus-5")).toBeTruthy();
    expect(models.getByText("claude-haiku-4-5")).toBeTruthy();
    expect(models.getByText("claude-sonnet-5")).toBeTruthy();

    const tasks = within(tableFor("Task"));
    expect(tasks.getByText("implement")).toBeTruthy();
    expect(tasks.getByText("review")).toBeTruthy();
  });

  it("shows tokens and derived cost side by side", () => {
    render(view(ROWS));

    // The pair the whole ledger exists for, on one row: what it consumed AND what that cost.
    const cells = screen.getByText("claude-opus-5").closest("tr")!.querySelectorAll("td");
    expect(cells[1].textContent).toBe("990K");
    expect(cells[4].textContent).toMatch(/^\$\d/);
    // The exact count rides in the title, so compaction never hides the measurement.
    expect(cells[1].getAttribute("title")).toBe("990,000 tokens");
  });

  it("marks the figures as measured, and never as approximations", () => {
    const { container } = render(view(ROWS));

    expect(screen.getByText(/Measured, not sampled/)).toBeTruthy();
    // The distinction stated outright, so an operator knows which of anton's two spend surfaces is
    // reconcilable against a bill.
    expect(screen.getByText(/none of it is an estimate/)).toBeTruthy();
    // The `≈` appears exactly once — in the sentence saying these figures do NOT wear it. No
    // FIGURE on this page may carry it (that marker belongs to quota-share's sampled attribution).
    const rows = container.querySelectorAll("tbody tr, tfoot tr");
    for (const tr of rows) expect(tr.textContent).not.toContain("≈");
  });

  it("totals both folds to the same dollar figure, being the same rows", () => {
    render(view(ROWS));

    const totals = screen
      .getAllByRole("row", { name: /Total/ })
      .map((tr) => within(tr).getByText(/^\$/).textContent);
    expect(totals).toHaveLength(2);
    expect(totals[0]).toBe(totals[1]);
  });
});

describe("a model anton has no price for", () => {
  const UNKNOWN = "some-gateway/mistral-large";
  const ROWS = [
    row({ modelReported: "claude-opus-5" }),
    row({ modelReported: UNKNOWN, step: "review" }),
  ];

  it("shows its tokens with a dash for cost, rather than reporting it as free", () => {
    render(view(ROWS));

    const unpriced = within(tableFor("Model")).getByText(UNKNOWN).closest("tr")!;
    expect(within(unpriced).getByText("—")).toBeTruthy();
    expect(within(unpriced).queryByText("$0.00")).toBeNull();
    // The tokens are still counted — unpriceable is not unmeasured.
    expect(within(unpriced).getByText("990K")).toBeTruthy();
    expect(within(unpriced).getByText(/pricing unverified/)).toBeTruthy();
  });

  it("says the window total is a floor rather than letting it read as complete", () => {
    render(view(ROWS));

    expect(screen.getByText(/could not be priced/)).toBeTruthy();
    expect(screen.getByText(/floor rather than a total/)).toBeTruthy();
    // And names what to add to the price table, in the banner rather than only in the row.
    const banner = screen.getByText(/could not be priced/).closest("p")!;
    expect(within(banner).getByText(UNKNOWN)).toBeTruthy();
    expect(banner.textContent).toContain("they are not free");
  });

  it("marks a partly-priced task group rather than reporting a bare total for it", () => {
    render(view([row({ step: "review" }), row({ step: "review", modelReported: UNKNOWN })]));

    const review = within(tableFor("Task")).getByText("review").closest("tr")!;
    expect(within(review).getByText(/1 unpriced/)).toBeTruthy();
  });

  it("distinguishes a call that reported no usage from one anton cannot price", () => {
    render(
      view([
        row({ modelReported: UNKNOWN }),
        row({
          modelReported: null,
          inputTokens: null,
          outputTokens: null,
          cacheReadInputTokens: null,
          cacheCreationInputTokens: null,
        }),
      ]),
    );

    const models = within(tableFor("Model"));
    expect(models.getByText(/pricing unverified/)).toBeTruthy();
    expect(models.getByText(/reported no usage/)).toBeTruthy();
  });
});

describe("a project with no recorded calls", () => {
  it("renders empty rather than zero spend", () => {
    render(view([]));

    expect(screen.getByText(/No calls recorded/)).toBeTruthy();
    expect(screen.getByText(/empty ledger, not zero spend/)).toBeTruthy();
    // The whole point: nothing measured must never render as a dollar figure of any kind.
    expect(screen.queryByText("$0.00")).toBeNull();
    expect(screen.queryByRole("table")).toBeNull();
  });

  it("points an all-time empty window at the meter rather than at a wider window", () => {
    render(
      <SpendView
        slug="acme"
        window="all"
        model={breakdownBy([], "model")}
        task={breakdownBy([], "task")}
        divergence={{ invocations: 0, diverged: 0, unknown: 0, substitutions: [] }}
      />,
    );

    expect(screen.getByText(/No calls recorded yet/)).toBeTruthy();
    expect(screen.getByText(/nothing has been measured here yet/i)).toBeTruthy();
  });
});

describe("a gateway that served something else", () => {
  it("says the per-model split is what answered, not what was asked for", () => {
    render(
      <SpendView
        slug="acme"
        window="7d"
        model={breakdownBy([row()], "model")}
        task={breakdownBy([row()], "task")}
        divergence={{
          invocations: 4,
          diverged: 2,
          unknown: 0,
          substitutions: [{ requested: "opus", served: ["gpt-4o"], count: 2 }],
        }}
      />,
    );

    expect(screen.getByText(/served by a model other than the one anton asked for/)).toBeTruthy();
    expect(screen.getByText(/opus → gpt-4o/)).toBeTruthy();
  });

  it("stays silent for a project whose models always agreed", () => {
    render(view([row()]));
    expect(screen.queryByText(/served by a model other than/)).toBeNull();
  });
});

describe("the chosen window", () => {
  it("offers every window as a link, marking the active one", () => {
    render(view([row()]));

    const nav = within(screen.getByRole("navigation", { name: "Spend window" }));
    expect(nav.getByRole("link", { name: "Last 24 hours" }).getAttribute("href")).toBe(
      "/projects/acme/spend?window=24h",
    );
    expect(nav.getByRole("link", { name: "Last 7 days" }).getAttribute("aria-current")).toBe("page");
  });
});
