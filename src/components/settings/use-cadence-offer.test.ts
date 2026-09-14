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
/** A weekly cadence the operator chose themselves — still weekly, so the offer would still apply. */
const HAND_WEEKLY = "30 9 * * 3";

type Rows = Record<string, AutomationScheduleState>;

function render(seed: Rows, keepWeekly = false) {
  const rows = { current: seed };
  const patchSettings = vi.fn(async () => new Response("{}", { status: 200 }));
  const setCron = vi.fn(async () => true);
  const { result } = renderHook(() =>
    useCadenceOffer({ rows, initialRows: seed, keepWeekly, patchSettings, setCron }),
  );
  return { result, rows, setCron, patchSettings };
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

  it("leaves an earlier hand-picked weekly cadence alone rather than re-offering to raise it", async () => {
    const { result, rows } = render(disarmed());
    await act(() => result.current.aroundToggle("board-picker", true, async () => true));
    expect(result.current.offer).not.toBeNull();

    // The operator answers the question by hand — a weekly cadence of their own choosing.
    await act(() =>
      result.current.aroundSetCron("product-master", async () => {
        rows.current = { ...rows.current, "product-master": { enabled: true, cron: HAND_WEEKLY } };
        return true;
      }),
    );
    expect(result.current.offer).toBeNull();

    // A later edit fails and rolls back to that same weekly cadence. It is the operator's, not the
    // question's, so nothing is asked again.
    await act(() =>
      result.current.aroundSetCron("product-master", async () => {
        rows.current = { ...rows.current, "product-master": { enabled: true, cron: HAND_PICKED } };
        rows.current = { ...rows.current, "product-master": { enabled: true, cron: HAND_WEEKLY } };
        return false;
      }),
    );

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
 * A hand edit made while an ANSWER is in flight. The offer is already off screen, so the edit has no
 * question to take away — but the answer can still put one back, and an edit that lands afterwards
 * would not remove it. The operator would be left with a prompt to overwrite the cadence they just
 * chose by hand.
 */
describe("a hand cadence edit while an answer is in flight", () => {
  it("keeps a failed accept from resurrecting a question the edit has already answered", async () => {
    const rows = {
      current: {
        "board-picker": { enabled: true, cron: "*/10 * * * *" },
        "product-master": { enabled: true, cron: WEEKLY },
      } as Rows,
    };
    let failAccept!: (ok: boolean) => void;
    const setCron = vi.fn(() => {
      rows.current = { ...rows.current, "product-master": { enabled: true, cron: DAILY } };
      return new Promise<boolean>((resolve) => {
        failAccept = resolve;
      });
    });
    const { result } = renderHook(() =>
      useCadenceOffer({
        rows,
        initialRows: rows.current,
        keepWeekly: false,
        patchSettings: vi.fn(async () => new Response("{}", { status: 200 })),
        setCron,
      }),
    );
    expect(result.current.offer).not.toBeNull();

    // The accept goes out and is still open when the operator picks the original weekly cadence
    // back by hand — the very cron the offer was derived from.
    let accepting!: Promise<void>;
    act(() => {
      accepting = result.current.accept();
    });
    expect(result.current.offer).toBeNull();

    let landEdit!: (ok: boolean) => void;
    let edit!: Promise<void>;
    act(() => {
      edit = result.current.aroundSetCron("product-master", () => {
        rows.current = { ...rows.current, "product-master": { enabled: true, cron: WEEKLY } };
        return new Promise<boolean>((resolve) => {
          landEdit = resolve;
        });
      });
    });

    // The accept fails against a row that reads exactly like the offer's premise — but that premise
    // is the operator's own later choice, not the one the question was asked about.
    await act(async () => {
      failAccept(false);
      await accepting;
    });
    expect(result.current.offer).toBeNull();

    // The edit lands, so nothing re-asks: it withdrew the question rather than deferring it.
    await act(async () => {
      landEdit(true);
      await edit;
    });
    expect(result.current.offer).toBeNull();
  });

  it("re-opens the question a failed edit could not put back under an optimistic decline", async () => {
    const rows = {
      current: {
        "board-picker": { enabled: true, cron: "*/10 * * * *" },
        "product-master": { enabled: true, cron: WEEKLY },
      } as Rows,
    };
    let failDecline!: (res: Response) => void;
    const patchSettings = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          failDecline = resolve;
        }),
    );
    const { result } = renderHook(() =>
      useCadenceOffer({
        rows,
        initialRows: rows.current,
        keepWeekly: false,
        patchSettings,
        setCron: vi.fn(async () => true),
      }),
    );
    expect(result.current.offer).not.toBeNull();

    // The decline goes out and is still open when the operator retimes product-master by hand.
    let declining!: Promise<void>;
    act(() => {
      declining = result.current.decline();
    });
    expect(result.current.offer).toBeNull();

    // The edit fails FIRST, rolling the row back to the cadence the question is about — but its own
    // re-ask reads the decline's optimistic opt-out and stays silent, and it withdrew the question
    // this decline is holding, so the answer's captured offer is no longer restorable either.
    await act(() =>
      result.current.aroundSetCron("product-master", async () => {
        rows.current = { ...rows.current, "product-master": { enabled: true, cron: HAND_PICKED } };
        rows.current = { ...rows.current, "product-master": { enabled: true, cron: WEEKLY } };
        return false;
      }),
    );
    expect(result.current.offer).toBeNull();

    // The decline then fails too: the opt-out goes back, and the question is live again — armed
    // picker, product-master enabled and weekly — with nothing else left to put it on screen.
    await act(async () => {
      failDecline(new Response(JSON.stringify({ error: "nope" }), { status: 500 }));
      await declining;
    });

    expect(result.current.offer).toMatchObject({ automationId: "product-master", cron: DAILY });
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

/**
 * The coupling has two halves, and the offer's premise is completed by whichever lands second. An
 * arm against an already-running product-master is the obvious one; the mirror — enabling
 * product-master under a picker that is already armed — is the same premise reached from the other
 * side, and must ask the same question rather than wait for a reload.
 */
describe("enabling product-master under an already armed picker", () => {
  /** The picker armed, product-master switched off — nothing to offer until it comes back. */
  const coupledOff = (): Rows => ({
    "board-picker": { enabled: true, cron: "*/10 * * * *" },
    "product-master": { enabled: false, cron: WEEKLY },
  });

  it("opens the question the moment the enable lands", async () => {
    const { result, rows } = render(coupledOff());
    expect(result.current.offer).toBeNull();

    await act(() =>
      result.current.aroundToggle("product-master", true, async () => {
        rows.current = { ...rows.current, "product-master": { enabled: true, cron: WEEKLY } };
        return true;
      }),
    );

    expect(result.current.offer).toMatchObject({ automationId: "product-master", cron: DAILY });
  });

  it("stays silent when the enable does not land", async () => {
    const { result } = render(coupledOff());
    await act(() => result.current.aroundToggle("product-master", true, async () => false));
    expect(result.current.offer).toBeNull();
  });

  it("stays silent once the operator has said keep weekly", async () => {
    const { result, rows } = render(coupledOff(), true);
    await act(() =>
      result.current.aroundToggle("product-master", true, async () => {
        rows.current = { ...rows.current, "product-master": { enabled: true, cron: WEEKLY } };
        return true;
      }),
    );
    expect(result.current.offer).toBeNull();
  });

  it("puts back a question its own off/on sequence withdrew", async () => {
    const { result, rows } = render({
      "board-picker": { enabled: true, cron: "*/10 * * * *" },
      "product-master": { enabled: true, cron: WEEKLY },
    });
    expect(result.current.offer).not.toBeNull();

    await act(() =>
      result.current.aroundToggle("product-master", false, async () => {
        rows.current = { ...rows.current, "product-master": { enabled: false, cron: WEEKLY } };
        return true;
      }),
    );
    expect(result.current.offer).toBeNull();

    await act(() =>
      result.current.aroundToggle("product-master", true, async () => {
        rows.current = { ...rows.current, "product-master": { enabled: true, cron: WEEKLY } };
        return true;
      }),
    );
    expect(result.current.offer).toMatchObject({ automationId: "product-master", cron: DAILY });
  });

  it("stays silent when the picker is not armed", async () => {
    const { result, rows } = render({
      "board-picker": { enabled: false, cron: "*/10 * * * *" },
      "product-master": { enabled: false, cron: WEEKLY },
    });
    await act(() =>
      result.current.aroundToggle("product-master", true, async () => {
        rows.current = { ...rows.current, "product-master": { enabled: true, cron: WEEKLY } };
        return true;
      }),
    );
    expect(result.current.offer).toBeNull();
  });
});

/**
 * Two picker toggles queued on the same row, neither of which reaches the server. The intent the
 * second one restores has to come from the row the failure rolled back to, not from the value the
 * first click optimistically left behind — that value describes an arm that never happened.
 */
describe("an arm and a disarm queued together, both failing", () => {
  it("leaves the picker disarmed and asks nothing", async () => {
    const { result, rows } = render(disarmed());

    // The arm goes out first and is still open when the operator changes their mind.
    let failArm!: (ok: boolean) => void;
    let arm!: Promise<void>;
    act(() => {
      arm = result.current.aroundToggle("board-picker", true, () => {
        rows.current = { ...rows.current, "board-picker": { enabled: true, cron: "*/10 * * * *" } };
        return new Promise<boolean>((resolve) => {
          failArm = resolve;
        });
      });
    });

    let failDisarm!: (ok: boolean) => void;
    let disarm!: Promise<void>;
    act(() => {
      disarm = result.current.aroundToggle("board-picker", false, () => {
        rows.current = { ...rows.current, "board-picker": { enabled: false, cron: "*/10 * * * *" } };
        return new Promise<boolean>((resolve) => {
          failDisarm = resolve;
        });
      });
    });

    // Both are rejected, and the row rolls back to the disabled picker the server still holds.
    await act(async () => {
      failArm(false);
      await arm;
    });
    await act(async () => {
      rows.current = { ...rows.current, "board-picker": { enabled: false, cron: "*/10 * * * *" } };
      failDisarm(false);
      await disarm;
    });

    expect(result.current.offer).toBeNull();

    // And the stale intent must not survive to be read by the OTHER half of the coupling either.
    await act(() =>
      result.current.aroundToggle("product-master", true, async () => {
        rows.current = { ...rows.current, "product-master": { enabled: true, cron: WEEKLY } };
        return true;
      }),
    );
    expect(result.current.offer).toBeNull();
  });

  it("takes back a question the other half of the coupling asked while the arm was open", async () => {
    const { result, rows } = render({
      "board-picker": { enabled: false, cron: "*/10 * * * *" },
      "product-master": { enabled: false, cron: WEEKLY },
    });

    let failArm!: (ok: boolean) => void;
    let arm!: Promise<void>;
    act(() => {
      arm = result.current.aroundToggle("board-picker", true, () => {
        rows.current = { ...rows.current, "board-picker": { enabled: true, cron: "*/10 * * * *" } };
        return new Promise<boolean>((resolve) => {
          failArm = resolve;
        });
      });
    });

    // product-master writes its own row, so its enable can land while the arm is still open — and
    // it asks, because the picker reads as armed.
    await act(() =>
      result.current.aroundToggle("product-master", true, async () => {
        rows.current = { ...rows.current, "product-master": { enabled: true, cron: WEEKLY } };
        return true;
      }),
    );
    expect(result.current.offer).not.toBeNull();

    await act(async () => {
      rows.current = { ...rows.current, "board-picker": { enabled: false, cron: "*/10 * * * *" } };
      failArm(false);
      await arm;
    });

    expect(result.current.offer).toBeNull();
  });

  it("still restores the arm when the row goes back to armed", async () => {
    const { result, rows } = render({
      "board-picker": { enabled: true, cron: "*/10 * * * *" },
      "product-master": { enabled: true, cron: WEEKLY },
    });

    await act(() =>
      result.current.aroundToggle("board-picker", false, async () => {
        rows.current = { ...rows.current, "board-picker": { enabled: false, cron: "*/10 * * * *" } };
        rows.current = { ...rows.current, "board-picker": { enabled: true, cron: "*/10 * * * *" } };
        return false;
      }),
    );

    expect(result.current.offer).toMatchObject({ automationId: "product-master", cron: DAILY });
  });
});

/**
 * A toggle that fails while an ANSWER is in flight. The offer is already off screen, so the toggle
 * withdraws nothing and the answer's own failure reads the optimistic row and declines to restore —
 * which leaves the operator with a live premise and no question unless the failed toggle re-asks.
 */
describe("a product-master toggle that does not land while an answer is in flight", () => {
  const armed = (): Rows => ({
    "board-picker": { enabled: true, cron: "*/10 * * * *" },
    "product-master": { enabled: true, cron: WEEKLY },
  });

  it("re-opens the question neither the failed decline nor the failed toggle could put back", async () => {
    const rows = { current: armed() };
    let failDecline!: (res: Response) => void;
    const patchSettings = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          failDecline = resolve;
        }),
    );
    const { result } = renderHook(() =>
      useCadenceOffer({
        rows,
        initialRows: rows.current,
        keepWeekly: false,
        patchSettings,
        setCron: vi.fn(async () => true),
      }),
    );
    expect(result.current.offer).not.toBeNull();

    // The decline goes out and is still open when the operator switches product-master off.
    let declining!: Promise<void>;
    act(() => {
      declining = result.current.decline();
    });
    expect(result.current.offer).toBeNull();

    let failToggle!: (ok: boolean) => void;
    let toggle!: Promise<void>;
    act(() => {
      toggle = result.current.aroundToggle("product-master", false, () => {
        rows.current = { ...rows.current, "product-master": { enabled: false, cron: WEEKLY } };
        return new Promise<boolean>((resolve) => {
          failToggle = resolve;
        });
      });
    });

    // The decline fails against the optimistically disabled row: the opt-out is reverted, but there
    // is no live question to put back yet.
    await act(async () => {
      failDecline(new Response(JSON.stringify({ error: "nope" }), { status: 500 }));
      await declining;
    });
    expect(result.current.offer).toBeNull();

    // The toggle then fails too and product-master goes back to enabled-and-weekly under an armed
    // picker — the unanswered question, live again.
    await act(async () => {
      rows.current = { ...rows.current, "product-master": { enabled: true, cron: WEEKLY } };
      failToggle(false);
      await toggle;
    });

    expect(result.current.offer).toMatchObject({ automationId: "product-master", cron: DAILY });
  });

  it("stays silent when the decline landed — the operator answered, the failure is not a re-ask", async () => {
    const rows = { current: armed() };
    const { result } = renderHook(() =>
      useCadenceOffer({
        rows,
        initialRows: rows.current,
        keepWeekly: false,
        patchSettings: vi.fn(async () => new Response("{}", { status: 200 })),
        setCron: vi.fn(async () => true),
      }),
    );

    await act(() => result.current.decline());
    await act(() =>
      result.current.aroundToggle("product-master", false, async () => {
        rows.current = { ...rows.current, "product-master": { enabled: false, cron: WEEKLY } };
        rows.current = { ...rows.current, "product-master": { enabled: true, cron: WEEKLY } };
        return false;
      }),
    );

    expect(result.current.offer).toBeNull();
  });
});

/**
 * The mirror of a failed arm: the COUPLED enable is the half that does not land. The arm can land
 * inside that window and ask against the optimistically enabled row, so the question is standing on
 * a job the server still has switched off — and the failure has no offer of its own to put back.
 */
describe("an arm and a coupled enable clicked together, the enable failing", () => {
  it("withdraws the question the arm asked against the optimistic row", async () => {
    const { result, rows } = render({
      "board-picker": { enabled: false, cron: "*/10 * * * *" },
      "product-master": { enabled: false, cron: WEEKLY },
    });

    let failEnable!: (ok: boolean) => void;
    let enable!: Promise<void>;
    act(() => {
      enable = result.current.aroundToggle("product-master", true, () => {
        rows.current = { ...rows.current, "product-master": { enabled: true, cron: WEEKLY } };
        return new Promise<boolean>((resolve) => {
          failEnable = resolve;
        });
      });
    });

    // The picker writes its own row, so the arm can land while the enable is still open — and it
    // asks, because product-master reads as enabled and weekly.
    await act(() =>
      result.current.aroundToggle("board-picker", true, async () => {
        rows.current = { ...rows.current, "board-picker": { enabled: true, cron: "*/10 * * * *" } };
        return true;
      }),
    );
    expect(result.current.offer).not.toBeNull();

    await act(async () => {
      rows.current = { ...rows.current, "product-master": { enabled: false, cron: WEEKLY } };
      failEnable(false);
      await enable;
    });

    expect(result.current.offer).toBeNull();
  });

  it("keeps the question when the enable's rollback still leaves the premise standing", async () => {
    const { result, rows } = render({
      "board-picker": { enabled: false, cron: "*/10 * * * *" },
      "product-master": { enabled: true, cron: WEEKLY },
    });

    // A disable that never reaches the server: the row goes back to enabled-and-weekly under a
    // picker the operator has since armed, which is the question, not a stale one.
    let failDisable!: (ok: boolean) => void;
    let disable!: Promise<void>;
    act(() => {
      disable = result.current.aroundToggle("product-master", false, () => {
        rows.current = { ...rows.current, "product-master": { enabled: false, cron: WEEKLY } };
        return new Promise<boolean>((resolve) => {
          failDisable = resolve;
        });
      });
    });

    await act(() =>
      result.current.aroundToggle("board-picker", true, async () => {
        rows.current = { ...rows.current, "board-picker": { enabled: true, cron: "*/10 * * * *" } };
        return true;
      }),
    );

    await act(async () => {
      rows.current = { ...rows.current, "product-master": { enabled: true, cron: WEEKLY } };
      failDisable(false);
      await disable;
    });

    expect(result.current.offer).toMatchObject({ automationId: "product-master", cron: DAILY });
  });
});

/**
 * A withdrawal that was itself rolled back, taken while an ANSWER was in flight. The toggle's own
 * recovery reads the answer's optimistic row and stays silent, so the answer failing is the last
 * chance to notice the question is live again — the alternative is an armed picker, a weekly
 * product-master, no opt-out and nothing on screen until a reload.
 */
describe("an accept that fails after a disarm failed first", () => {
  const armed = (): Rows => ({
    "board-picker": { enabled: true, cron: "*/10 * * * *" },
    "product-master": { enabled: true, cron: WEEKLY },
  });

  it("re-opens the question the disarm's own recovery could not put back", async () => {
    const rows = { current: armed() };
    let failAccept!: (ok: boolean) => void;
    const { result } = renderHook(() =>
      useCadenceOffer({
        rows,
        initialRows: rows.current,
        keepWeekly: false,
        patchSettings: vi.fn(async () => new Response("{}", { status: 200 })),
        setCron: vi.fn(() => {
          rows.current = { ...rows.current, "product-master": { enabled: true, cron: DAILY } };
          return new Promise<boolean>((resolve) => {
            failAccept = resolve;
          });
        }),
      }),
    );
    expect(result.current.offer).not.toBeNull();

    let accepting!: Promise<void>;
    act(() => {
      accepting = result.current.accept();
    });
    expect(result.current.offer).toBeNull();

    // The disarm never reaches the server. It withdrew the question anyway, and its recovery is
    // silent because the accept has optimistically moved the row off weekly.
    await act(() =>
      result.current.aroundToggle("board-picker", false, async () => {
        rows.current = { ...rows.current, "board-picker": { enabled: false, cron: "*/10 * * * *" } };
        rows.current = { ...rows.current, "board-picker": { enabled: true, cron: "*/10 * * * *" } };
        return false;
      }),
    );
    expect(result.current.offer).toBeNull();

    // The cadence PATCH fails too and the row goes back to weekly — armed picker, weekly
    // product-master, nothing answered.
    await act(async () => {
      rows.current = { ...rows.current, "product-master": { enabled: true, cron: WEEKLY } };
      failAccept(false);
      await accepting;
    });

    expect(result.current.offer).toMatchObject({ automationId: "product-master", cron: DAILY });
  });

  it("stays silent when the disarm landed — nothing consumes the priorities any more", async () => {
    const rows = { current: armed() };
    let failAccept!: (ok: boolean) => void;
    const { result } = renderHook(() =>
      useCadenceOffer({
        rows,
        initialRows: rows.current,
        keepWeekly: false,
        patchSettings: vi.fn(async () => new Response("{}", { status: 200 })),
        setCron: vi.fn(() => {
          rows.current = { ...rows.current, "product-master": { enabled: true, cron: DAILY } };
          return new Promise<boolean>((resolve) => {
            failAccept = resolve;
          });
        }),
      }),
    );

    let accepting!: Promise<void>;
    act(() => {
      accepting = result.current.accept();
    });

    await act(() =>
      result.current.aroundToggle("board-picker", false, async () => {
        rows.current = { ...rows.current, "board-picker": { enabled: false, cron: "*/10 * * * *" } };
        return true;
      }),
    );

    await act(async () => {
      rows.current = { ...rows.current, "product-master": { enabled: true, cron: WEEKLY } };
      failAccept(false);
      await accepting;
    });

    expect(result.current.offer).toBeNull();
  });
});

describe("an answer given with no question on screen", () => {
  it("records no opt-out — a stray decline must not answer for the operator", async () => {
    const { result, patchSettings } = render(disarmed());
    expect(result.current.offer).toBeNull();

    await act(() => result.current.decline());

    expect(patchSettings).not.toHaveBeenCalled();
  });
});
