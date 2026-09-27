// @vitest-environment jsdom
/**
 * The feature ledger panel (anton-1u6lm), tested at its own boundary over a fold of real rows.
 *
 * Every case is a way the panel could MISLEAD, not a way the layout could shift. The fold below it is
 * careful about three things — an unpriced bucket is not free, an unrecorded scope is not zero, and
 * cost is never split — and a renderer is where each of those is thrown away. So the fixtures drive
 * `ledgerTotals` / `ledgerTiming` / `ledgerFriction` rather than hand-writing their output: a panel
 * tested against an invented shape proves nothing about the one it will actually be handed.
 */
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";

import { LedgerPanel } from "@/components/ledger/ledger-panel";
import {
  ledgerFriction,
  ledgerTiming,
  ledgerTotals,
  type LedgerFriction,
  type LedgerTotalsRow,
} from "@/lib/feature-ledger";
import { REOPEN_NOTE_HEAD } from "@/lib/rework-marks";

afterEach(cleanup);

const START = Date.parse("2026-09-20T09:00:00Z");

/** One ledger row, at the grain `claude_invocations` actually writes: (invocation, model). */
function row(overrides: Partial<LedgerTotalsRow> = {}): LedgerTotalsRow {
  return {
    invocationId: `inv-${counter++}`,
    projectId: "proj-a",
    jobType: "execute-epic",
    jobId: "job-a",
    step: "implement",
    stepHandler: "implement",
    runId: "run-a",
    beadId: "anton-aaaa",
    claudeSessionId: "sess-a",
    modelRequested: "opus",
    modelReported: "claude-opus-5",
    // `null` here means "unknown billing mode", which `model-pricing` refuses to price at all — so a
    // fixture that wants a dollar figure has to name the endpoint that served it.
    endpointHost: "api.anthropic.com",
    outcome: "ok",
    recordedAt: new Date(START),
    durationMs: 60_000,
    durationApiMs: 40_000,
    numTurns: 12,
    inputTokens: 40_000,
    outputTokens: 20_000,
    cacheReadInputTokens: 900_000,
    cacheCreationInputTokens: 30_000,
    ...overrides,
  };
}

let counter = 0;

/**
 * A feature that went through every phase the ledger can bill to it, plus the two buckets it
 * deliberately keeps outside that bill.
 *
 * Each row's `(jobType, stepHandler)` pair is the real predicate `ledgerPhase` classifies on — the
 * PR-fix pair includes the in-formula correction round, which stays under `execute-epic` and would
 * otherwise read as implement spend.
 */
const EVERY_PHASE: LedgerTotalsRow[] = [
  row({ stepHandler: "implement", durationMs: 600_000, recordedAt: new Date(START) }),
  row({ stepHandler: "commit", durationMs: 30_000, recordedAt: new Date(START + 700_000) }),
  row({
    step: "review",
    stepHandler: "review",
    durationMs: 120_000,
    recordedAt: new Date(START + 900_000),
  }),
  row({
    step: "describe",
    stepHandler: "describe",
    durationMs: 45_000,
    recordedAt: new Date(START + 1_000_000),
  }),
  // The in-formula correction round: `execute-epic`, handler `review`, but `step = review-fix`.
  row({
    step: "review-fix",
    stepHandler: "review",
    durationMs: 90_000,
    recordedAt: new Date(START + 1_100_000),
  }),
  row({
    jobType: "review-fix-pr",
    step: null,
    stepHandler: null,
    durationMs: 150_000,
    recordedAt: new Date(START + 1_300_000),
  }),
  // Outside the feature's bill, and each for its own reason: a board-wide pass (§D4), and a row
  // whose handler classifies to nothing.
  row({
    jobType: "gardener",
    step: null,
    stepHandler: null,
    durationMs: 20_000,
    recordedAt: new Date(START + 1_400_000),
  }),
  row({
    jobType: "execute-epic",
    step: "code-ticket",
    stepHandler: null,
    durationMs: 10_000,
    recordedAt: new Date(START + 1_500_000),
  }),
];

/** The delivery the lead span ends at, well after the last invocation. */
const DELIVERED_AT = START + 40_000_000;

const FRICTION: LedgerFriction = ledgerFriction({
  rounds: [{ verdict: "changes" }, { verdict: "clean" }],
  jobs: [
    { type: "review-fix-pr", status: "done" },
    { type: "execute-epic", status: "cancelled" },
    { type: "execute-epic", status: "done", quotaParkCount: 3, failureParkCount: 1 },
  ],
  escalations: [{ kind: "needs-human" }, { kind: "parked-run" }],
  // The literal phrase the rework path writes (`REOPEN_NOTE_HEAD`) — the counter matches that, so an
  // invented sentence here would count zero and pass for the wrong reason.
  notes: [{ text: `${REOPEN_NOTE_HEAD}anton-bbbb: the acceptance criteria were not met.` }],
});

function panel(rows: LedgerTotalsRow[], deliveredAtMs: number | "undelivered" = DELIVERED_AT) {
  // Not a default parameter: `panel(rows, undefined)` would fall back to it, and the undelivered case
  // is precisely the one that must reach the fold as absent.
  const deliveredAt = deliveredAtMs === "undelivered" ? undefined : deliveredAtMs;
  return (
    <LedgerPanel
      totals={ledgerTotals(rows)}
      timing={ledgerTiming(rows, deliveredAt)}
      friction={FRICTION}
    />
  );
}

const rowFor = (phase: string) => screen.getByText(phase).closest("tr")!;

/**
 * One duration's value cell, found through its own term rather than by position in the section.
 *
 * Scoped to the Durations section because "Active" is also a column heading on the phase table — the
 * two are different figures over the same feature, and a global query would silently read one for
 * the other.
 */
function durationValue(label: string): HTMLElement {
  const durations = within(screen.getByLabelText("Durations"));
  return durations.getByText(label).nextElementSibling as HTMLElement;
}

const duration = (label: string) =>
  durationValue(label).firstElementChild as HTMLElement;

/** What the figure is NOT — `floor`, `not delivered`, `not split` — or undefined for a plain total. */
const qualifier = (label: string) =>
  durationValue(label).children[1]?.textContent ?? undefined;

describe("a feature that went through every phase", () => {
  it("gives each phase its own row, with tokens, dollars and active time", () => {
    render(panel(EVERY_PHASE));

    for (const phase of ["Implement", "Self-review", "Describe", "PR fix"]) {
      const cells = rowFor(phase).querySelectorAll("td");
      // Tokens, cost, active — the three figures the phase split exists to put side by side.
      expect(cells[1].textContent).toMatch(/^\d/);
      expect(cells[2].textContent).toMatch(/^\$\d/);
      expect(cells[3].textContent).toMatch(/^\d+[smhd]/);
    }
  });

  it("bills the in-formula correction round to PR fix, not to implement", () => {
    render(panel(EVERY_PHASE));

    // Two calls: the `step = review-fix` round under `execute-epic`, and the `review-fix-pr` job.
    expect(within(rowFor("PR fix")).getByText(/2 calls/)).toBeTruthy();
    // Implement holds only its own two, so the correction did not leak into the cost of doing it.
    expect(within(rowFor("Implement")).getByText(/2 calls/)).toBeTruthy();
    expect(within(rowFor("Self-review")).getByText(/1 call\b/)).toBeTruthy();
  });

  it("keeps board overhead out of the feature's total, but counts the unattributed row in it", () => {
    const totals = ledgerTotals(EVERY_PHASE);
    render(panel(EVERY_PHASE));

    // The footer is the feature's own bill: phases + unattributed, and never the board-wide pass.
    const footer = screen.getByRole("row", { name: /Total/ });
    expect(totals.overhead).toBeDefined();
    expect(totals.totals.rows).toBe(EVERY_PHASE.length - 1);
    expect(within(footer).getByText(/^\$/)).toBeTruthy();
  });

  it("omits a phase that recorded nothing rather than rendering it as a zero row", () => {
    render(panel(EVERY_PHASE.filter((r) => r.stepHandler !== "describe")));

    expect(screen.queryByText("Describe")).toBeNull();
    expect(screen.getByText("Implement")).toBeTruthy();
  });

  it("marks a phase's active time as a floor when not every call in it reported a duration", () => {
    render(
      panel([
        row({ stepHandler: "implement", durationMs: 60_000 }),
        row({ stepHandler: "implement", durationMs: null }),
      ]),
    );

    const cell = rowFor("Implement").querySelectorAll("td")[3]!;
    expect(cell.textContent).toContain("+");
    expect(cell.getAttribute("title")).toMatch(/only 1 of 2 calls reported a duration/);
  });

  it("says nothing about a floor when every call in the phase reported a duration", () => {
    render(panel(EVERY_PHASE));

    const cell = rowFor("Implement").querySelectorAll("td")[3]!;
    expect(cell.textContent).not.toContain("+");
  });
});

describe("the three durations", () => {
  it("reports active, lead and waiting as separate figures", () => {
    render(panel(EVERY_PHASE));

    // ~17m worked against ~11h elapsed: the split the whole section exists for. Three distinct
    // figures, so no two of them can be the same number by construction.
    const figures = ["Active", "Lead", "Waiting"].map((label) => duration(label).textContent);
    expect(new Set(figures).size).toBe(3);
    // Every figure derivable from the fixture: active is the 1,065s of recorded duration; lead runs
    // from the first call's reconstructed start to the delivery 40,600s later; waiting is the
    // difference — the ~11h this feature spent not being worked on.
    expect(figures).toEqual(["17m 45s", "11h 16m", "10h 58m"]);
  });

  it("says outright that there is no wall-clock figure, rather than leaving a gap", () => {
    render(panel(EVERY_PHASE));

    expect(screen.getByText(/no wall-clock figure/)).toBeTruthy();
    expect(screen.getByText(/not recoverable for the runs already recorded/)).toBeTruthy();
  });

  it("marks lead and waiting absent — not zero — for a feature that has not delivered", () => {
    render(panel(EVERY_PHASE, "undelivered"));

    expect(duration("Lead").textContent).toBe("—");
    expect(qualifier("Lead")).toBe("not delivered");
    expect(duration("Waiting").textContent).toBe("—");
    // Active is still exact — nothing about an undelivered feature makes what claude worked unknown.
    expect(duration("Active").textContent).not.toBe("—");
    expect(qualifier("Active")).toBeUndefined();
  });

  it("refuses the waiting split when a call ended in the same second as the delivery", () => {
    const rows = [row({ durationMs: 60_000, recordedAt: new Date(START) })];
    render(panel(rows, START));

    expect(duration("Waiting").textContent).toBe("—");
    expect(qualifier("Waiting")).toBe("not split");
    // And says why, rather than picking a side and reporting a confident wrong number.
    expect(duration("Waiting").getAttribute("title")).toMatch(/cannot say which came first/);
  });

  it("marks active as a floor when not every call reported a duration", () => {
    render(panel([row({ durationMs: 60_000 }), row({ durationMs: null })]));

    expect(qualifier("Active")).toBe("floor");
    expect(duration("Active").getAttribute("title")).toMatch(
      /only 1 of 2 calls reported a duration/,
    );
  });
});

describe("friction", () => {
  it("labels the counts as proxy signals rather than as a quality score", () => {
    render(panel(EVERY_PHASE));

    expect(screen.getByText(/observed signals, not a quality score/)).toBeTruthy();
    const caveat = screen.getByText(/for how/).closest("p")!;
    expect(caveat.textContent).toContain("proxy");
    expect(caveat.textContent).toContain("None of them measures how well the work was done");
    // Nothing on the panel grades the feature.
    expect(screen.queryByText(/quality score:/i)).toBeNull();
  });

  it("renders each counter with its own labelled figure", () => {
    render(panel(EVERY_PHASE));

    const count = (label: string) =>
      screen.getByText(label).parentElement!.querySelector("dd")!.textContent;

    expect(count("Review rounds")).toBe("2");
    expect(count("PR fixes")).toBe("1");
    expect(count("Escalations")).toBe("2");
    expect(count("Human gates")).toBe("1");
    expect(count("Send-backs")).toBe("1");
    expect(count("Cancels")).toBe("1");
    expect(count("Quota parks")).toBe("3");
    expect(count("Failure parks")).toBe("1");
  });

  it("sums the human touches with each gate counted exactly once", () => {
    render(panel(EVERY_PHASE));

    // 1 non-gate escalation + 1 gate + 1 send-back + 1 cancel. Summing escalations AND gates would
    // give 5, double-counting the gate — the bug the fold's own split exists to prevent.
    expect(FRICTION.humanTouches).toBe(4);
    expect(screen.getByText("Human touches — 4")).toBeTruthy();
  });

  it("keeps the parks visibly outside the touch count", () => {
    render(panel(EVERY_PHASE));

    const parks = screen.getByText(/Parks — outside the touch count/);
    expect(parks).toBeTruthy();
    expect(parks.getAttribute("title")).toMatch(/not a person intervening/);
    // The quota park sits under that heading, not under the sum.
    expect(within(parks.parentElement!).getByText("Quota parks")).toBeTruthy();
  });
});

/**
 * The four refusals (anton-524h1) — the cases where the fold declines to invent a number and the
 * panel is the last place that can throw the refusal away.
 *
 * Each asserts the SHAPE of the honesty, not the wording: that a figure exists where tokens were
 * measured, that the marker is not a zero, that the remainder is inside the bill and the overhead is
 * outside it. A test pinned to a sentence would pass a rewrite that quietly dropped the meaning.
 */
describe("what could not be attributed or priced", () => {
  const UNKNOWN = "some-gateway/mistral-large";

  describe("unpriced tokens", () => {
    it("renders the tokens with an explicit no-price marker, never $0", () => {
      render(panel([row({ modelReported: UNKNOWN })]));

      const cells = rowFor("Implement").querySelectorAll("td");
      // The tokens are still evidence that calls happened — this is not an absent row.
      expect(cells[1].textContent).toBe("990K");
      // And the cost says which kind of nothing it is. A bare dash would be indistinguishable from
      // the phases this table omits entirely.
      expect(cells[2].textContent).toContain("—");
      expect(cells[2].textContent).toContain("no price");
      expect(screen.queryByText("$0.00")).toBeNull();
      expect(screen.queryByText("$0")).toBeNull();
    });

    it("distinguishes a model it cannot price from a call that measured nothing", () => {
      // A crashed invocation: priced model, no counts. Not a gap in the price table, and saying
      // "no price" here would send an operator to fix a table that is already correct.
      // `null`, not 0: an absent count is what a crashed result writes, and `model-pricing` reads a
      // zero as a measured free call — which is a third, genuinely different fact.
      render(
        panel([
          row({
            inputTokens: null,
            outputTokens: null,
            cacheReadInputTokens: null,
            cacheCreationInputTokens: null,
            outcome: "error",
          }),
        ]),
      );

      const cells = rowFor("Implement").querySelectorAll("td");
      expect(cells[2].textContent).toContain("no usage");
      expect(cells[2].textContent).not.toContain("no price");
    });

    it("names the models it has no price for, so the total is actionable", () => {
      render(panel([row(), row({ modelReported: UNKNOWN })]));

      const note = screen.getByRole("status");
      expect(note.textContent).toContain(UNKNOWN);
      expect(note.textContent).toMatch(/floor rather than a total/);
      expect(note.textContent).toMatch(/they are not free/);
    });

    it("marks a partly-priced phase as a floor rather than as a total", () => {
      render(panel([row(), row({ modelReported: UNKNOWN })]));

      const implement = within(rowFor("Implement"));
      expect(implement.getByText(/1 unpriced/)).toBeTruthy();
      expect(implement.getByTitle(/At least this/)).toBeTruthy();
    });

    it("says nothing about pricing when every row was priced", () => {
      render(panel([row()]));

      expect(screen.queryByRole("status")).toBeNull();
    });
  });

  describe("the unattributed bucket", () => {
    it("renders as its own row when non-empty, labelled as spend anton cannot place", () => {
      const totals = ledgerTotals(EVERY_PHASE);
      expect(totals.unattributed).toBeDefined();
      render(panel(EVERY_PHASE));

      const unattributed = rowFor("Unattributed");
      const cells = unattributed.querySelectorAll("td");
      // Tokens and active time, like any bucket — it is real spend, not a placeholder.
      expect(cells[1].textContent).toMatch(/^\d/);
      expect(cells[3].textContent).toMatch(/^\d+[smhd]/);
      expect(within(unattributed).getByText(/1 call\b/)).toBeTruthy();
      // Labelled as an absence of knowledge, not as a sixth kind of work.
      expect(screen.getByTitle(/classifies to no phase/)).toBeTruthy();
    });

    it("counts the remainder inside the feature's total rather than dropping it", () => {
      const withRemainder = ledgerTotals(EVERY_PHASE);
      const withoutRemainder = ledgerTotals(EVERY_PHASE.filter((r) => r.step !== "code-ticket"));

      // Dropping unplaceable spend would understate the bill — the same failure as pricing an
      // unpriced row at zero, one level up.
      expect(withRemainder.totals.runs).toBe(withoutRemainder.totals.runs + 1);
      expect(withRemainder.totals.usd!).toBeGreaterThan(withoutRemainder.totals.usd!);
    });

    it("is absent, not a zero row, when every call classified to a phase", () => {
      const attributed = EVERY_PHASE.filter((r) => r.step !== "code-ticket");
      expect(ledgerTotals(attributed).unattributed).toBeUndefined();
      render(panel(attributed));

      expect(screen.queryByText("Unattributed")).toBeNull();
    });
  });

  describe("project-level overhead", () => {
    it("shows the board pass as unallocated, outside the feature's bill", () => {
      render(panel(EVERY_PHASE));

      const unallocated = within(screen.getByLabelText("Unallocated"));
      expect(screen.getByText(/Unallocated — not billed to this feature/)).toBeTruthy();
      // Its own figures, so the money is visible rather than merely excluded.
      expect(unallocated.getByText("Cost")).toBeTruthy();
      expect(unallocated.getByText("Tokens")).toBeTruthy();
      expect(unallocated.getByText(/divided into no feature at all/)).toBeTruthy();
    });

    it("is not folded into the feature's phases or its total", () => {
      const totals = ledgerTotals(EVERY_PHASE);
      render(panel(EVERY_PHASE));

      // The gardener row is the only overhead in the fixture, and it reaches neither the phase map
      // nor the footer — §D4's whole claim.
      expect(totals.overhead!.runs).toBe(1);
      expect(totals.totals.rows).toBe(EVERY_PHASE.length - 1);
      expect([...totals.phases.keys()]).not.toContain("overhead");
      // And it is not a row in the table either, where the footer would sum it.
      expect(screen.queryByText("Overhead")).toBeNull();
      const table = screen.getByRole("table");
      expect(within(table).queryByText(/not billed to this feature/)).toBeNull();
    });

    it("omits the section entirely when no scheduled pass touched the feature", () => {
      const featureOnly = EVERY_PHASE.filter((r) => r.jobType !== "gardener");
      expect(ledgerTotals(featureOnly).overhead).toBeUndefined();
      render(panel(featureOnly));

      expect(screen.queryByLabelText("Unallocated")).toBeNull();
    });
  });

  describe("an unrecorded scope", () => {
    it("renders an empty state distinct from a measured zero", () => {
      render(panel([], "undelivered"));

      // The empty state, and NONE of the surfaces a zero total would render.
      expect(screen.getByText(/Nothing recorded for this feature yet/)).toBeTruthy();
      expect(screen.queryByRole("table")).toBeNull();
      expect(screen.queryByLabelText("Unallocated")).toBeNull();
      expect(screen.queryByLabelText("Durations")).toBeNull();
      expect(screen.queryByText("Unattributed")).toBeNull();
    });

    it("reads differently from a scope that recorded a call costing nearly nothing", () => {
      // The contrast the criterion is about: this feature WAS measured, and the meter's answer was
      // a real, tiny number. It must not borrow the empty state's wording.
      render(
        panel([
          row({
            inputTokens: 1,
            outputTokens: 1,
            cacheReadInputTokens: 0,
            cacheCreationInputTokens: 0,
          }),
        ]),
      );

      expect(screen.queryByText(/Nothing recorded for this feature yet/)).toBeNull();
      expect(screen.getByRole("table")).toBeTruthy();
      // Priced, and shown as a fraction of a cent rather than rounded to $0.00 — `formatUsd`'s own
      // rule, and the reason a measured near-zero is still distinguishable from an unpriced one.
      const cost = rowFor("Implement").querySelectorAll("td")[2].textContent!;
      expect(cost).toMatch(/^\$0\.\d+/);
      expect(cost).not.toContain("no price");
    });
  });
});

describe("a feature with nothing recorded", () => {
  it("renders an empty state rather than a wall of zeros", () => {
    render(panel([], "undelivered"));

    expect(screen.getByText(/Nothing recorded for this feature yet/)).toBeTruthy();
    expect(screen.getByText(/empty ledger, not zero spend/)).toBeTruthy();
    // No table, no $0.00, no 0s duration — a measured zero and an unmeasured scope are opposite facts.
    expect(screen.queryByRole("table")).toBeNull();
    expect(screen.queryByText("$0.00")).toBeNull();
    expect(screen.queryByText("0s")).toBeNull();
  });
});

/**
 * jsdom does no layout, so these assert the STRUCTURAL properties that make horizontal overflow
 * impossible — no minimum width, no scroll container, wrapping stat rows, and a label sub-line free
 * to break — rather than measuring a scrollWidth that is always 0 here. That is the honest limit of a
 * component test on this criterion; what it does buy is a regression guard, since the usual way this
 * panel would acquire a scroller is someone copying `spend-table`'s `min-w-[34rem]` wrapper into it.
 */
describe("narrow viewports", () => {
  it("gives the phase table no minimum width, so it reflows instead of scrolling", () => {
    const { container } = render(panel(EVERY_PHASE));

    const table = container.querySelector("table")!;
    expect(table.className).toContain("w-full");
    expect(table.className).not.toMatch(/min-w-/);
    // And nothing wraps it in a horizontal scroller either.
    for (const el of container.querySelectorAll("div")) {
      expect(el.className).not.toContain("overflow-x-auto");
    }
  });

  it("wraps the stat and counter rows rather than clipping figures out of reach", () => {
    const { container } = render(panel(EVERY_PHASE));

    const wrappers = [...container.querySelectorAll("div, dl")].filter((el) =>
      el.className.includes("flex-wrap"),
    );
    // The durations row plus the three friction groups.
    expect(wrappers.length).toBeGreaterThanOrEqual(4);
  });

  it("lets a phase row's qualifying counts wrap rather than holding the column open", () => {
    render(panel(EVERY_PHASE));

    // The longest text in the table — "N calls · N turns · N unpriced". Held on one line it would set
    // a floor under the label column that the three figure columns then have to fit beside.
    const subline = within(rowFor("Implement")).getByText(/calls/);
    expect(subline.className).not.toContain("whitespace-nowrap");
  });
});
