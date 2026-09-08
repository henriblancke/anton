/**
 * PR #253 review — {@link finishTicket} answers whether the bead actually CLOSED. The close is
 * best-effort (`safe`), so a bd that refuses the write leaves the ticket open; the run's ledger and
 * the pull request body it feeds must carry that fact, not a close inferred from the run's shape.
 * A satisfied step's attribution note is NOT best-effort: it is what makes the close honest, so a
 * note bd refuses stops the close and halts the run rather than closing a bead that cannot say why.
 *
 * Mocked at the bd seam: a close that FAILS is a state a real board can't be asked for on demand.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Bead } from "../beads/bd";

const closeMock = vi.fn();
const noteMock = vi.fn();
const tagMock = vi.fn();
const untagMock = vi.fn();
const endSessionMock = vi.fn();

vi.mock("../beads/bd", async () => {
  const actual = await vi.importActual<typeof import("../beads/bd")>("../beads/bd");
  return {
    ...actual,
    beads: {
      ...actual.beads,
      close: (...args: unknown[]) => closeMock(...args),
      note: (...args: unknown[]) => noteMock(...args),
      tag: (...args: unknown[]) => tagMock(...args),
      untag: (...args: unknown[]) => untagMock(...args),
    },
  };
});

vi.mock("../sessions", async () => {
  const actual = await vi.importActual<typeof import("../sessions")>("../sessions");
  return { ...actual, endSession: (...args: unknown[]) => endSessionMock(...args) };
});

const { finishTicket } = await import("./execute-epic-ticket-bookends");
import { PoisonEpic } from "./errors";
import type { StepContext } from "./step-registry";

const REPO = "/tmp/anton";
const ticket = { id: "anton-t2", title: "Expose the schema", status: "in_progress" } as Bead;
const satisfied = {
  how: "satisfied" as const,
  by: { commit: "0123456789abcdef0123456789abcdef01234567", subject: "anton-t1: Add the schema" },
};

/** The minimal run `finishTicket` reads: the repo it writes to, the branch its note names, and the session store. */
function run(): Omit<StepContext, "tickets"> {
  return { repoPath: REPO, branch: "anton/anton-f1", db: {}, clock: { now: () => 0 } } as unknown as Omit<
    StepContext,
    "tickets"
  >;
}

describe("finishTicket — reports whether the close landed (PR #253 review)", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    closeMock.mockResolvedValue(undefined);
    noteMock.mockResolvedValue(undefined);
    tagMock.mockResolvedValue(undefined);
    untagMock.mockResolvedValue(undefined);
    endSessionMock.mockResolvedValue(undefined);
  });

  it("answers closed when bd accepted the close", async () => {
    await expect(finishTicket(run(), ticket, "s1", true, satisfied)).resolves.toEqual({ closed: true });
    expect(closeMock).toHaveBeenCalledWith(REPO, ticket.id);
    expect(endSessionMock).toHaveBeenCalledWith({}, expect.anything(), "s1", "done");
  });

  it("does NOT close a satisfied step whose attribution bd refused to record (PR #253 review)", async () => {
    // The satisfied record is the closed bead's only account of itself: the run's ledger is lost
    // by a later park, and the pull request that would cite it may never open. So a note bd refuses
    // — after every retry — refuses the close too, and the run halts on a park a person can act on.
    noteMock.mockRejectedValue(new Error("Command failed: bd note anton-t2\ndatabase is locked"));

    const err = await finishTicket(run(), ticket, "s1", true, satisfied).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(PoisonEpic);
    expect((err as Error).message).toMatch(/bd would not record/);
    expect((err as Error).message).toContain("0123456");
    expect(noteMock).toHaveBeenCalledTimes(3);
    expect(closeMock).not.toHaveBeenCalled();
    expect(endSessionMock).not.toHaveBeenCalled();
  });

  it("answers NOT closed when bd refused the close, and still ends the session", async () => {
    closeMock.mockRejectedValue(new Error("Command failed: bd close anton-t2\ndatabase is locked"));

    await expect(finishTicket(run(), ticket, "s1", true, satisfied)).resolves.toEqual({ closed: false });
    // The record of HOW it settled was still written — it is what a reader needs to close it by hand.
    expect(noteMock).toHaveBeenCalledWith(REPO, ticket.id, expect.stringContaining("anton: satisfied by"));
    expect(endSessionMock).toHaveBeenCalledWith({}, expect.anything(), "s1", "done");
  });

  it("answers NOT closed for a standalone target, which moves to in-review instead", async () => {
    await expect(finishTicket(run(), ticket, "s1", false)).resolves.toEqual({ closed: false });
    expect(closeMock).not.toHaveBeenCalled();
    expect(tagMock).toHaveBeenCalledWith(REPO, ticket.id, ["stage:in-review"]);
    expect(untagMock).toHaveBeenCalledWith(REPO, ticket.id, ["stage:implementing"]);
  });
});
