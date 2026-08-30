// @vitest-environment jsdom
/**
 * The cadence offer's lifecycle around a HAND edit (anton-3xa9). The claim under test is that an
 * edit which never reached the server leaves no question stranded: the row rolls back to the
 * cadence the offer is about, so the offer belongs back on screen — including when it was never
 * opened, because a concurrent arm decided against the optimistic cron and stayed silent.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";

import type { AutomationScheduleState } from "@/components/settings/automation-table";
import { useCadenceOffer } from "@/components/settings/use-cadence-offer";

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const WEEKLY = "0 6 * * 1";
const DAILY = "0 6 * * *";
const HAND_PICKED = "30 9 * * *";

type Rows = Record<string, AutomationScheduleState>;

function render(seed: Rows, keepWeekly = false) {
  const rows = { current: seed };
  const patchSettings = vi.fn(async () => new Response("{}", { status: 200 }));
  const setCron = vi.fn(async () => true);
  const { result } = renderHook(() =>
    useCadenceOffer({ rows, initialRows: seed, keepWeekly, patchSettings, setCron }),
  );
  return { result, rows, setCron };
}

/** The board-picker off, product-master running weekly — the state an arm opens the offer from. */
const disarmed = (over: Partial<AutomationScheduleState> = {}): Rows => ({
  "board-picker": { enabled: false, cron: "*/10 * * * *" },
  "product-master": { enabled: true, cron: WEEKLY, ...over },
});

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  cleanup();
});

describe("a hand cadence edit that does not land", () => {
  it("re-opens the question an arm swallowed while the edit was optimistically applied", async () => {
    const { result, rows } = render(disarmed());

    // The arm goes out first and is still open when the operator retimes product-master.
    let landArm!: (ok: boolean) => void;
    let arm!: Promise<void>;
    act(() => {
      arm = result.current.aroundToggle("board-picker", true, () => {
        rows.current = { ...rows.current, "board-picker": { enabled: true, cron: "*/10 * * * *" } };
        return new Promise<boolean>((resolve) => {
          landArm = resolve;
        });
      });
    });

    let failEdit!: (ok: boolean) => void;
    let edit!: Promise<void>;
    act(() => {
      edit = result.current.aroundSetCron("product-master", () => {
        rows.current = { ...rows.current, "product-master": { enabled: true, cron: HAND_PICKED } };
        return new Promise<boolean>((resolve) => {
          failEdit = resolve;
        });
      });
    });

    // The arm lands against the OPTIMISTIC cron, which is not weekly, so it asks nothing.
    await act(async () => {
      landArm(true);
      await arm;
    });
    expect(result.current.offer).toBeNull();

    // The edit then fails and the row goes back to weekly — with the picker armed, that is exactly
    // the question the arm would have asked.
    await act(async () => {
      rows.current = { ...rows.current, "product-master": { enabled: true, cron: WEEKLY } };
      failEdit(false);
      await edit;
    });

    expect(result.current.offer).toMatchObject({ automationId: "product-master", cron: DAILY });
  });

  it("puts back the offer it superseded, rather than leaving the operator to cycle the picker", async () => {
    const { result, rows } = render(disarmed());
    await act(() => result.current.aroundToggle("board-picker", true, async () => true));
    expect(result.current.offer).not.toBeNull();

    await act(() =>
      result.current.aroundSetCron("product-master", async () => {
        rows.current = { ...rows.current, "product-master": { enabled: true, cron: HAND_PICKED } };
        // The write fails and the optimistic cron is rolled back before the caller resumes.
        rows.current = { ...rows.current, "product-master": { enabled: true, cron: WEEKLY } };
        return false;
      }),
    );

    expect(result.current.offer).toMatchObject({ automationId: "product-master", cron: DAILY });
  });

  it("stays silent while the premise is gone — the picker was never armed", async () => {
    const { result } = render(disarmed());
    await act(() => result.current.aroundSetCron("product-master", async () => false));
    expect(result.current.offer).toBeNull();
  });

  it("asks nothing for a row the offer is not about", async () => {
    const { result } = render(disarmed());
    await act(() => result.current.aroundToggle("board-picker", true, async () => true));
    await act(() => result.current.aroundSetCron("nightly-stringer", async () => false));
    expect(result.current.offer).toMatchObject({ automationId: "product-master" });
  });
});

describe("a hand cadence edit that lands", () => {
  it("supersedes the pending offer and asks nothing back", async () => {
    const { result, rows } = render(disarmed());
    await act(() => result.current.aroundToggle("board-picker", true, async () => true));
    expect(result.current.offer).not.toBeNull();

    await act(() =>
      result.current.aroundSetCron("product-master", async () => {
        rows.current = { ...rows.current, "product-master": { enabled: true, cron: HAND_PICKED } };
        return true;
      }),
    );

    expect(result.current.offer).toBeNull();
  });
});

/**
 * The question survives the operator walking away from it. Nothing about "the picker is armed and
 * product-master still runs weekly" expires when the page unmounts, and only an ANSWER — accept, so
 * the cadence is no longer weekly; decline, so the opt-out is on record — ends it.
 */
describe("a remount with the question unanswered", () => {
  /** The board-picker armed, product-master still weekly — an offer left standing by a reload. */
  const armed = (over: Partial<AutomationScheduleState> = {}): Rows => ({
    "board-picker": { enabled: true, cron: "*/10 * * * *" },
    "product-master": { enabled: true, cron: WEEKLY, ...over },
  });

  it("restores it from the persisted answer and the live rows", () => {
    const { result } = render(armed());
    expect(result.current.offer).toMatchObject({ automationId: "product-master", cron: DAILY });
  });

  it("still answers — a restored offer is the same question, not a read-only banner", async () => {
    const { result, setCron } = render(armed());
    await act(() => result.current.accept());
    expect(setCron).toHaveBeenCalledWith("product-master", DAILY);
    expect(result.current.offer).toBeNull();
  });

  it("stays silent once the operator has said keep weekly", () => {
    const { result } = render(armed(), true);
    expect(result.current.offer).toBeNull();
  });

  it("stays silent when the picker is not armed", () => {
    const { result } = render(disarmed());
    expect(result.current.offer).toBeNull();
  });

  it("stays silent when product-master is off, or already runs daily-or-faster", () => {
    expect(render(armed({ enabled: false })).result.current.offer).toBeNull();
    cleanup();
    expect(render(armed({ cron: DAILY })).result.current.offer).toBeNull();
    cleanup();
    // A hand-written expression is not ours to rewrite — there is no "the same time, but daily".
    expect(render(armed({ cron: "0 0,12 * * 1-5" })).result.current.offer).toBeNull();
  });
});
