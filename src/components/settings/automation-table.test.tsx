// @vitest-environment jsdom
/**
 * The Automation schedule table (anton-ue90.4), tested at its own boundary (anton-8t1f).
 *
 * The claim under test is that every cell reads from the schedule row and nothing else: a cadence
 * phrase, a countdown or a last-run age that disagreed with the row that actually fires would be
 * worse than a blank column. The cadence cell carries most of that weight — it is the only control
 * here that opens an editor, and it has to stay honest whether the row is on a preset, on a
 * hand-written expression, off, or not created yet.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import {
  AutomationTable,
  type AutomationScheduleState,
  type AutomationSpec,
  type CadenceOffer,
} from "@/components/settings/automation-table";

afterEach(cleanup);

const NOW_SEC = () => Math.floor(Date.now() / 1000);

const AUTOMATIONS: AutomationSpec[] = [
  {
    id: "nightly-stringer",
    label: "nightly-stringer",
    description: "mines the repo for work",
    group: "Board maintenance",
  },
  { id: "run-health", label: "run-health", description: "watches live runs", group: "Run health" },
  {
    id: "unstick",
    label: "unstick",
    description: "nudges stalled runs",
    dependsOn: "run-health",
    group: "Run health",
  },
  {
    id: "board-picker",
    label: "board-picker",
    description: "ranks what could run next · records the plan · starts nothing yet",
    group: "Board maintenance",
  },
  {
    id: "product-master",
    label: "product-master",
    description: "product judgment",
    group: "Board maintenance",
  },
];

const DEFAULT_CRONS: Record<string, string> = {
  "nightly-stringer": "0 3 * * *",
  "run-health": "0 * * * *",
  unstick: "10 * * * *",
  "board-picker": "*/10 * * * *",
  "product-master": "0 6 * * 1",
};

/** Every automation gets a row, so the table renders the same shape the settings page passes in. */
function renderTable(
  overrides: Record<string, Partial<AutomationScheduleState>> = {},
  cadenceOffer: CadenceOffer | null = null,
) {
  const state: Record<string, AutomationScheduleState> = {};
  for (const automation of AUTOMATIONS) {
    state[automation.id] = {
      enabled: false,
      cron: DEFAULT_CRONS[automation.id],
      ...overrides[automation.id],
    };
  }
  const onCronChange = vi.fn<(id: string, cron: string) => void>();
  const onToggle = vi.fn<(id: string, next: boolean) => void>();
  const onAcceptCadenceOffer = vi.fn();
  const onDeclineCadenceOffer = vi.fn();
  render(
    <AutomationTable
      automations={AUTOMATIONS}
      state={state}
      defaultCrons={DEFAULT_CRONS}
      cadenceOffer={cadenceOffer}
      onCronChange={onCronChange}
      onToggle={onToggle}
      onAcceptCadenceOffer={onAcceptCadenceOffer}
      onDeclineCadenceOffer={onDeclineCadenceOffer}
    />,
  );
  return { onCronChange, onToggle, onAcceptCadenceOffer, onDeclineCadenceOffer };
}

const cadenceButton = (id = "nightly-stringer") =>
  screen.getByRole("button", { name: `${id} cadence` });
const openEditor = (id?: string) => fireEvent.click(cadenceButton(id));
const setCadence = () => screen.getByRole("button", { name: "Set cadence" });
const editorIsOpen = () => screen.queryByRole("button", { name: "Set cadence" }) !== null;

describe("the cadence cell", () => {
  it("reads a known preset as its phrase, with the expression behind it", () => {
    renderTable({ "nightly-stringer": { cron: "*/30 * * * *" } });
    const button = cadenceButton();

    expect(button.textContent).toContain("Every 30 minutes");
    // The phrase is what an operator scans; the exact expression stays one hover away.
    expect(button.getAttribute("title")).toBe("*/30 * * * *");
  });

  it("reads a hand-written expression as itself rather than inventing a phrase", () => {
    // Lists and ranges are outside the preset vocabulary. Describing `0 0,12 * * 1-5` as anything
    // but its own text would be a guess, and the cadence it names is not one the picker can spell.
    renderTable({ "nightly-stringer": { cron: "0 0,12 * * 1-5" } });
    expect(cadenceButton().textContent).toContain("0 0,12 * * 1-5");
  });

  it("flags a cadence faster than the threshold on the row, not only in the editor", () => {
    // The editor is only open while someone is choosing; the dot is the state they left behind.
    renderTable({ "nightly-stringer": { cron: "*/2 * * * *" } });
    expect(cadenceButton().querySelector("[aria-hidden='true']")).not.toBeNull();
    expect(cadenceButton("run-health").querySelector("[aria-hidden='true']")).toBeNull();
  });

  it("stays readable and editable while the automation is off", () => {
    renderTable({ "nightly-stringer": { enabled: false, cron: "*/30 * * * *" } });
    expect(cadenceButton().textContent).toContain("Every 30 minutes");

    // Off is not the same as unconfigurable — the cadence a disabled automation would run at is
    // exactly what an operator sets before turning it on.
    openEditor();
    expect(editorIsOpen()).toBe(true);
  });

  it("shows the cadence an automation with no row yet would be created at", () => {
    renderTable({ "nightly-stringer": { enabled: null, cron: DEFAULT_CRONS["nightly-stringer"] } });
    expect(cadenceButton().textContent).toContain("Daily at 03:00");
    expect(screen.getAllByText("not scheduled").length).toBe(AUTOMATIONS.length);
  });

  it("opens the editor in a popover and reports it through aria", () => {
    renderTable();
    const button = cadenceButton();
    expect(button.getAttribute("aria-expanded")).toBe("false");
    expect(editorIsOpen()).toBe(false);

    openEditor();
    expect(button.getAttribute("aria-expanded")).toBe("true");
    expect(document.getElementById(button.getAttribute("aria-controls")!)).not.toBeNull();
  });

  it("hands the committed cadence back, keyed by automation", () => {
    const { onCronChange } = renderTable({ "run-health": { cron: "0 * * * *" } });
    openEditor("run-health");
    fireEvent.click(screen.getByRole("button", { name: "Daily" }));
    fireEvent.click(setCadence());

    expect(onCronChange).toHaveBeenCalledWith("run-health", "0 3 * * *");
    // Committing is the end of the interaction — the popover goes away with it.
    expect(editorIsOpen()).toBe(false);
  });

  it("edits one row's cadence without touching another's", () => {
    renderTable({
      "nightly-stringer": { cron: "*/30 * * * *" },
      "run-health": { cron: "0 * * * *" },
    });
    openEditor();
    expect(screen.getAllByRole("button", { name: "Set cadence" })).toHaveLength(1);
    expect(cadenceButton("run-health").textContent).toContain("Hourly, on the hour");
  });

  it("closes on Escape and on a click genuinely outside it", () => {
    renderTable();
    openEditor();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(editorIsOpen()).toBe(false);

    openEditor();
    fireEvent.mouseDown(document.body);
    expect(editorIsOpen()).toBe(false);
  });

  it("does not read picking a time inside the editor as clicking away", () => {
    // The editor's pickers portal their menus outside this subtree, so "outside the popover" and
    // "outside the editor" are different places. Untested, a picker that stopped carrying the
    // marker the guard keys on would silently bin the draft on every click.
    renderTable();
    openEditor();
    fireEvent.click(screen.getByRole("button", { name: "Daily" }));
    fireEvent.click(screen.getByLabelText("Hour"));
    const option = screen.getAllByRole("option")[0];
    expect(document.querySelector("[data-slot='select-positioner']")?.contains(option)).toBe(true);

    fireEvent.mouseDown(option);
    expect(editorIsOpen()).toBe(true);
  });

  it("discards an uncommitted draft when the popover is dismissed", () => {
    const { onCronChange } = renderTable({ "nightly-stringer": { cron: "*/30 * * * *" } });
    openEditor();
    fireEvent.click(screen.getByRole("button", { name: "Hourly" }));
    fireEvent.mouseDown(document.body);

    expect(onCronChange).not.toHaveBeenCalled();
    expect(cadenceButton().textContent).toContain("Every 30 minutes");
  });
});

describe("the automation rows", () => {
  it("counts how many automations are running", () => {
    renderTable({ "run-health": { enabled: true } });
    expect(screen.getByText(`1 of ${AUTOMATIONS.length} running`)).toBeTruthy();
  });

  it("groups the rows so several automations read as a few concerns", () => {
    renderTable();
    for (const group of ["Board maintenance", "Run health"]) {
      expect(screen.getByRole("columnheader", { name: group })).toBeTruthy();
    }
    // Delivery has no rows here — an empty group heading would be a column with nothing under it.
    expect(screen.queryByRole("columnheader", { name: "Delivery" })).toBeNull();
  });

  it("counts down to the next run, with the exact instant one hover away", () => {
    const at = NOW_SEC() + 2 * 3600 + 60;
    renderTable({ "nightly-stringer": { enabled: true, nextRunAt: at } });
    expect(screen.getByText("in 2h")).toBeTruthy();
    expect(screen.getByText("in 2h").getAttribute("title")).toBeTruthy();
  });

  it("says an automation is not scheduled while it is off, even with a stored next run", () => {
    // A disabled row keeps its nextRunAt in the database; printing it would promise a fire that
    // the scheduler will never make.
    renderTable({
      "nightly-stringer": { enabled: false, nextRunAt: NOW_SEC() + 3600 },
    });
    expect(screen.getAllByText("not scheduled").length).toBe(AUTOMATIONS.length);
  });

  it("says an automation has never run rather than leaving the column blank", () => {
    renderTable({ "nightly-stringer": { lastRunAt: NOW_SEC() - 3 * 3600 - 60 } });
    expect(screen.getByText("3h ago")).toBeTruthy();
    expect(screen.getAllByText("never").length).toBe(AUTOMATIONS.length - 1);
  });

  // "3h ago" alone reads as healthy whether the pass did work, found nothing, or parked on an
  // error — which is what made the column unanswerable (anton-znoz).

  it("says what came of the last fire, not just when it was", () => {
    renderTable({
      "nightly-stringer": {
        lastRunAt: NOW_SEC() - 3 * 3600 - 60,
        lastRun: {
          outcome: "ok",
          at: NOW_SEC() - 3 * 3600 - 60,
          enqueuedAt: NOW_SEC() - 3 * 3600 - 60,
          note: "triaged 4 signal(s)",
        },
      },
    });
    expect(screen.getByText("3h ago")).toBeTruthy();
    expect(screen.getByText("triaged 4 signal(s)")).toBeTruthy();
  });

  it("tells a fire that did nothing apart from one that did work", () => {
    renderTable({
      "run-health": {
        lastRunAt: NOW_SEC() - 60,
        lastRun: {
          outcome: "noop",
          at: NOW_SEC() - 60,
          enqueuedAt: NOW_SEC() - 60,
          note: "no stalls found",
        },
      },
    });
    expect(screen.getByText("no stalls found")).toBeTruthy();
    // The no-op is named for a screen reader too, where the note alone would not carry the verdict.
    expect(screen.getByText("nothing to do —")).toBeTruthy();
  });

  it("shows a failed fire with the error that explains it", () => {
    renderTable({
      "run-health": {
        lastRunAt: NOW_SEC() - 120,
        lastRun: {
          outcome: "failed",
          at: NOW_SEC() - 120,
          enqueuedAt: NOW_SEC() - 120,
          note: "gh: not authenticated",
        },
      },
    });
    expect(screen.getByText("gh: not authenticated")).toBeTruthy();
    expect(screen.getByText("failed —")).toBeTruthy();
  });

  // A schedule's FIRST fire has been enqueued and has settled nothing, so there is no previous
  // result to date it against. Without saying "in progress" the row is a bare timestamp, and the
  // automation's first execution looks like one that reported nothing at all.
  it("shows a first fire with no settled result as in progress", () => {
    renderTable({ "run-health": { enabled: true, lastRunAt: NOW_SEC() - 120 } });
    expect(screen.getByText("2m ago")).toBeTruthy();
    expect(screen.getByText("in progress")).toBeTruthy();
    expect(screen.queryByText("nothing to do")).toBeNull();
  });

  // `lastRunAt` is stamped at enqueue, `lastRun` is the newest SETTLED job — so for the whole length
  // of a fire the outcome beside it belongs to the PREVIOUS one. Reading last night's green result
  // as the verdict on a run that started two minutes ago is the failure this guards.
  it("does not credit a still-running fire with the previous fire's result", () => {
    renderTable({
      "nightly-stringer": {
        enabled: true,
        lastRunAt: NOW_SEC() - 120,
        lastRun: {
          outcome: "ok",
          at: NOW_SEC() - 3 * 3600 - 60,
          enqueuedAt: NOW_SEC() - 3 * 3600 - 60,
          note: "triaged 4 signal(s)",
        },
      },
    });

    expect(screen.getByText("2m ago")).toBeTruthy();
    expect(screen.queryByText("triaged 4 signal(s)")).toBeNull();
    // The older result is not hidden, it is dated to the run it came from.
    expect(screen.getByText("in progress · ok 3h ago")).toBeTruthy();
  });

  it("does not blame a running fire for yesterday's failure", () => {
    renderTable({
      "run-health": {
        enabled: true,
        lastRunAt: NOW_SEC() - 120,
        lastRun: {
          outcome: "failed",
          at: NOW_SEC() - 26 * 3600,
          enqueuedAt: NOW_SEC() - 26 * 3600,
          note: "gh: not authenticated",
        },
      },
    });

    expect(screen.queryByText("gh: not authenticated")).toBeNull();
    expect(screen.queryByText("failed —")).toBeNull();
    expect(screen.getByText(/^in progress · failed 1d ago$/)).toBeTruthy();
  });

  // Disabling a schedule leaves an already enqueued job queued and unleased (jobs/runner.ts) while
  // preserving `lastRunAt`, so the unsettled reading would otherwise claim a handler is running for
  // as long as the automation stays off.
  it("calls an unleased fire held, not in progress, while the automation is off", () => {
    renderTable({
      "run-health": { enabled: false, lastRunAt: NOW_SEC() - 120, pendingRun: "queued" },
    });

    expect(screen.getByText("held · automation off")).toBeTruthy();
    expect(screen.queryByText(/in progress/)).toBeNull();
  });

  // The other half of the same fact: the runner gates the CLAIM on the switch, never the handler, so
  // a job leased before the switch went off runs to completion. Calling that held would tell an
  // operator nothing is happening while a session is mid-flight.
  it("keeps an already-leased fire in progress after the automation is switched off", () => {
    renderTable({
      "run-health": { enabled: false, lastRunAt: NOW_SEC() - 120, pendingRun: "running" },
    });

    expect(screen.getByText("in progress")).toBeTruthy();
    expect(screen.queryByText(/held/)).toBeNull();
  });

  // An armed schedule whose fire nothing has picked up yet is waiting on a worker, not working.
  it("calls an unleased fire queued while the automation is on", () => {
    renderTable({
      "run-health": { enabled: true, lastRunAt: NOW_SEC() - 120, pendingRun: "queued" },
    });

    expect(screen.getByText("queued")).toBeTruthy();
    expect(screen.queryByText(/in progress/)).toBeNull();
  });

  // With no pending job to read — a poll that has not landed yet — the switch is all there is.
  it("falls back to the switch when the fire's own status is unknown", () => {
    renderTable({ "run-health": { enabled: false, lastRunAt: NOW_SEC() - 120 } });

    expect(screen.getByText("held · automation off")).toBeTruthy();
    expect(screen.queryByText(/in progress/)).toBeNull();
  });

  it("dates the previous outcome behind a held fire without crediting it", () => {
    renderTable({
      "nightly-stringer": {
        enabled: false,
        pendingRun: "queued",
        lastRunAt: NOW_SEC() - 120,
        lastRun: {
          outcome: "ok",
          at: NOW_SEC() - 3 * 3600 - 60,
          enqueuedAt: NOW_SEC() - 3 * 3600 - 60,
          note: "triaged 4 signal(s)",
        },
      },
    });

    expect(screen.getByText("held · automation off · ok 3h ago")).toBeTruthy();
    expect(screen.queryByText("triaged 4 signal(s)")).toBeNull();
  });

  // The mirror check: a settled fire always settles at or after it was enqueued, so the in-flight
  // reading must never swallow a real outcome.
  it("shows the outcome of a fire that settled after it was enqueued", () => {
    const firedAt = NOW_SEC() - 3 * 3600 - 60;
    renderTable({
      "nightly-stringer": {
        lastRunAt: firedAt,
        lastRun: { outcome: "ok", at: firedAt + 90, enqueuedAt: firedAt, note: "triaged 4 signal(s)" },
      },
    });

    expect(screen.getByText("triaged 4 signal(s)")).toBeTruthy();
    expect(screen.queryByText(/in progress/)).toBeNull();
  });

  // The outcomes are matched on ENQUEUE time, not settlement: an operator resuming a week-old parked
  // fire settles it today, AFTER the fire now running was enqueued. Comparing settlement times would
  // hand that stale failure to the running fire as its verdict.
  it("does not hand a running fire the verdict of an older fire resumed after it started", () => {
    renderTable({
      "nightly-stringer": {
        enabled: true,
        lastRunAt: NOW_SEC() - 120,
        lastRun: {
          outcome: "failed",
          at: NOW_SEC() - 30,
          enqueuedAt: NOW_SEC() - 7 * 86_400,
          note: "bd exited 1",
        },
      },
    });

    expect(screen.queryByText("bd exited 1")).toBeNull();
    expect(screen.getByText("in progress · failed 7d ago")).toBeTruthy();
  });

  // unstick acts on run-health's findings. With the producer off it is not broken, it is idle —
  // and without saying so the row reads as a failure.
  it("says which automations are idle because the one that feeds them is off", () => {
    renderTable({ "run-health": { enabled: false } });
    expect(screen.getByText(/idle until run-health is on/)).toBeTruthy();
  });

  it("says which automations are fed once the one that feeds them is on", () => {
    renderTable({ "run-health": { enabled: true } });
    expect(screen.getByText(/fed by run-health/)).toBeTruthy();
  });

  it("says what the board-picker does and how often it would fire", () => {
    // The pass decides only — it ranks the board and records the plan, and starts nothing. A row
    // that promised a start would have an operator flip the switch and watch nothing happen, so the
    // copy has to name the limit, not just the ambition.
    renderTable();
    expect(screen.getByText(/ranks what could run next/)).toBeTruthy();
    expect(screen.getByText(/starts nothing yet/)).toBeTruthy();
    expect(cadenceButton("board-picker").textContent).toContain("Every 10 minutes");
  });

  it("hands a toggle back as the state the operator asked for", () => {
    const { onToggle } = renderTable({ "run-health": { enabled: false } });
    fireEvent.click(screen.getByRole("switch", { name: "run-health" }));
    expect(onToggle).toHaveBeenCalledWith("run-health", true);
  });
});

/**
 * The cadence offer (anton-3xa9). The claim under test is that it is an OFFER: it says why, it says
 * which cadence would become which, and neither button is the one that already happened — the table
 * changes nothing on its own.
 */
describe("the cadence offer", () => {
  const OFFER: CadenceOffer = {
    automationId: "product-master",
    cron: "0 6 * * *",
    reason: "product-master's judgment now feeds the board-picker — what it ranks is executed.",
    acceptLabel: "Raise to daily",
    declineLabel: "Keep weekly",
  };

  it("shows nothing at all when there is no offer", () => {
    renderTable();
    expect(screen.queryByRole("button", { name: "Raise to daily" })).toBeNull();
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("states the reason and the cadence change, next to the row it would change", () => {
    renderTable({}, OFFER);

    const offer = screen.getByRole("status");
    expect(offer.textContent).toContain("feeds the board-picker");
    // Both sides, as phrases: the operator is deciding between two cadences, not two cron strings.
    expect(offer.textContent).toContain("Weekly on Monday at 06:00");
    expect(offer.textContent).toContain("Daily at 06:00");
    // Under the automation it is about — the cadence cell is still the row's own, untouched.
    expect(cadenceButton("product-master").textContent).toContain("Weekly on Monday at 06:00");
  });

  it("names both answers as decisions rather than as OK and Cancel", () => {
    const { onAcceptCadenceOffer, onDeclineCadenceOffer } = renderTable({}, OFFER);

    fireEvent.click(screen.getByRole("button", { name: "Raise to daily" }));
    expect(onAcceptCadenceOffer).toHaveBeenCalledTimes(1);
    expect(onDeclineCadenceOffer).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Keep weekly" }));
    expect(onDeclineCadenceOffer).toHaveBeenCalledTimes(1);
  });

  it("changes no cadence by itself — accepting is a callback, not a write", () => {
    const { onCronChange } = renderTable({}, OFFER);
    fireEvent.click(screen.getByRole("button", { name: "Raise to daily" }));
    expect(onCronChange).not.toHaveBeenCalled();
  });
});
