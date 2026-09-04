/**
 * anton-vsg3 — how {@link claimRunTarget} classifies a `bd update --claim` refusal, and what the
 * runner then does with the error it throws.
 *
 * The classification is the whole point: a refusal bd will repeat identically forever (`issue not
 * claimable: status blocked`) has to park on the FIRST attempt, while a Dolt lock or a CLI timeout
 * has to keep its retry. Bucketing the first as the second burned the budget on three identical
 * failures and parked telling the operator the DB was locked — the cause it demonstrably wasn't.
 * `unclaimableStatus`'s own matching is covered in beads/bd.test.ts; what's proven here is that the
 * claim path routes each bucket to the right error, all the way through the runner's durability
 * policy (`classifyError` → `nextAction`), which is where "does not reach attempt 2" is decided.
 *
 * Mocked at the bd seam: the states under test are bd calls that FAIL, which a real board can't be
 * asked for on demand.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Bead } from "../beads/bd";

const showMock = vi.fn();
const claimMock = vi.fn();
const tagMock = vi.fn();

vi.mock("../beads/bd", async () => {
  const actual = await vi.importActual<typeof import("../beads/bd")>("../beads/bd");
  return {
    ...actual,
    beads: {
      ...actual.beads,
      show: (...args: unknown[]) => showMock(...args),
      claim: (...args: unknown[]) => claimMock(...args),
      tag: (...args: unknown[]) => tagMock(...args),
    },
  };
});

const { claimRunTarget } = await import("./execute-epic-claim");
const { isPoisonError } = await import("./errors");
const { classifyError, nextAction, DEFAULT_CONFIG } = await import("./runner");
const { resetOperatorCache, resolveOperator } = await import("../operator");
import type { EpicRun } from "./execute-epic-run";

const REPO = "/tmp/anton";
const TARGET = "anton-mw90";
const OPERATOR = "alice";
const NOW = 1_700_000_000_000;

/** How bd's rejection reaches the claim path: the raw stderr, carried on the error and its message. */
function bdRefusal(stderr: string): Error {
  return Object.assign(new Error(`Command failed: bd update ${TARGET} --claim\n${stderr}`), {
    stderr,
  });
}

function bead(assignee: string | undefined, status = "open"): Bead {
  return { id: TARGET, title: TARGET, status, assignee } as Bead;
}

/** The minimal run `claimRunTarget` reads — it takes only the repo and the target off it. */
function run(): EpicRun {
  return { repo: REPO, targetId: TARGET } as EpicRun;
}

/** What the runner would do with this error on the FIRST attempt. */
function firstAttemptAction(e: unknown) {
  return nextAction(DEFAULT_CONFIG, { attempts: 1 }, classifyError(e), NOW);
}

/** Run the claim and hand back the error it refused with (failing if it didn't refuse). */
async function refusalFrom(): Promise<Error> {
  const caught = await claimRunTarget(run()).then(
    () => undefined,
    (e: unknown) => e as Error,
  );
  expect(caught).toBeInstanceOf(Error);
  return caught as Error;
}

beforeEach(() => {
  showMock.mockReset();
  claimMock.mockReset();
  tagMock.mockReset();
  tagMock.mockResolvedValue(undefined);
  process.env.ANTON_OPERATOR = OPERATOR;
  resetOperatorCache();
});

afterEach(() => {
  delete process.env.ANTON_OPERATOR;
  resetOperatorCache();
});

describe("claimRunTarget — permanent refusals", () => {
  // The regression (observed on anton-mw90): the zero-diff guard blocked the target, so every
  // follow-on run re-did worktree setup and hit the identical refusal, three times, before parking
  // with the wrong cause.
  it("parks on the first attempt when bd refuses on the bead's status", async () => {
    showMock.mockResolvedValue(bead(OPERATOR, "blocked"));
    claimMock.mockRejectedValue(
      bdRefusal(`Error claiming ${TARGET}: issue not claimable: status blocked`),
    );

    const error = await refusalFrom();

    expect(isPoisonError(error)).toBe(true);
    expect(firstAttemptAction(error).action).toBe("park");
    // One attempt at the claim, not one per retry — the classification happens before the budget.
    expect(claimMock).toHaveBeenCalledTimes(1);
  });

  it("names the status and the operator's fix, not a locked DB", async () => {
    showMock.mockResolvedValue(bead(OPERATOR, "blocked"));
    claimMock.mockRejectedValue(
      bdRefusal(`Error claiming ${TARGET}: issue not claimable: status blocked`),
    );

    const error = await refusalFrom();

    expect(error.message).toContain('status is "blocked"');
    expect(error.message).toContain(TARGET);
    expect(error.message).toMatch(/reopen\/unblock/i);
    expect(error.message).not.toMatch(/beads DB is locked|transiently|retrying/i);
    // The raw bd line survives into the park, so the operator can see what bd actually said.
    expect(error.message).toContain("issue not claimable: status blocked");
  });

  // `in_progress` is the same shape of refusal — a status another actor's run wrote — and must not
  // be special-cased into the retryable bucket.
  it("parks the same way on an in_progress refusal", async () => {
    showMock.mockResolvedValue(bead(OPERATOR, "in_progress"));
    claimMock.mockRejectedValue(bdRefusal("issue not claimable: status in_progress"));

    const error = await refusalFrom();

    expect(isPoisonError(error)).toBe(true);
    expect(error.message).toContain('status is "in_progress"');
  });
});

describe("claimRunTarget — transient refusals", () => {
  // The half the fix must NOT break: poisoning these would park a perfectly valid approved target
  // that the very next attempt would claim cleanly.
  it.each([
    ["a locked Dolt DB", "Error 1105: database is locked"],
    ["a CLI timeout", "bd update --claim exceeded its 60000ms budget"],
  ])("keeps the retry for %s", async (_case, stderr) => {
    showMock.mockResolvedValue(bead(OPERATOR));
    claimMock.mockRejectedValue(bdRefusal(stderr));

    const error = await refusalFrom();

    expect(isPoisonError(error)).toBe(false);
    expect(firstAttemptAction(error).action).toBe("reschedule");
    expect(error.message).toContain("retrying");
    expect(error.message).toContain(stderr);
  });
});

describe("claimRunTarget — the take-over branch", () => {
  // Unchanged by the status bucket: a DIFFERENT owner still poisons, and still explains itself as a
  // take-over rather than as a status the operator would go looking for on the board.
  it("poisons on a take-over the pre-read sees, without attempting the claim", async () => {
    showMock.mockResolvedValue(bead("bob"));

    const error = await refusalFrom();

    expect(isPoisonError(error)).toBe(true);
    expect(error.message).toContain("reserved by bob");
    expect(claimMock).not.toHaveBeenCalled();
  });

  it("poisons on a take-over that lands between the pre-read and the claim", async () => {
    showMock.mockResolvedValueOnce(bead(OPERATOR)).mockResolvedValue(bead("bob"));
    claimMock.mockRejectedValue(bdRefusal(`Error claiming ${TARGET}: issue already claimed by bob`));

    const error = await refusalFrom();

    expect(isPoisonError(error)).toBe(true);
    expect(error.message).toContain("reserved by bob");
    expect(firstAttemptAction(error).action).toBe("park");
  });
});

describe("claimRunTarget — the normal path", () => {
  it("claims the target for the operator and tags it implementing", async () => {
    showMock.mockResolvedValue(bead(OPERATOR));
    claimMock.mockResolvedValue(undefined);
    const r = run();

    await claimRunTarget(r);

    expect(claimMock).toHaveBeenCalledWith(REPO, TARGET, OPERATOR);
    expect(tagMock).toHaveBeenCalledWith(REPO, TARGET, ["stage:implementing"]);
    expect(r.operator).toBe(await resolveOperator());
  });
});
