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
const claimMock = vi.fn();
const showMock = vi.fn();
const unlinkMock = vi.fn();
const setStatusMock = vi.fn();
const unassignMock = vi.fn();
const syncMock = vi.fn();
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
      claim: (...args: unknown[]) => claimMock(...args),
      show: (...args: unknown[]) => showMock(...args),
      unlink: (...args: unknown[]) => unlinkMock(...args),
      setStatus: (...args: unknown[]) => setStatusMock(...args),
      unassign: (...args: unknown[]) => unassignMock(...args),
      sync: (...args: unknown[]) => syncMock(...args),
    },
  };
});

vi.mock("../sessions", async () => {
  const actual = await vi.importActual<typeof import("../sessions")>("../sessions");
  return { ...actual, endSession: (...args: unknown[]) => endSessionMock(...args) };
});

const { finishTicket, claimTicket } = await import("./execute-epic-ticket-bookends");
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

describe("claimTicket — clears a stale supersedes edge before running (PR #238 review)", () => {
  const SURVIVOR = "anton-t9";
  // A reopened retirement: `bd reopen` returns it to `open` but leaves the `supersedes` edge behind.
  const reopened = {
    id: "anton-t2",
    title: "Expose the schema",
    status: "open",
    labels: [],
    dependencies: [{ issue_id: "anton-t2", depends_on_id: SURVIVOR, type: "supersedes" }],
  } as unknown as Bead;

  beforeEach(() => {
    vi.resetAllMocks();
    claimMock.mockResolvedValue(undefined);
    tagMock.mockResolvedValue(undefined);
    untagMock.mockResolvedValue(undefined);
    setStatusMock.mockResolvedValue(undefined);
    unassignMock.mockResolvedValue(undefined);
    syncMock.mockResolvedValue(undefined);
    unlinkMock.mockResolvedValue(undefined);
    showMock.mockResolvedValue(reopened);
  });

  it("removes the stale edge on the authoritative read the claim just earned", async () => {
    await claimTicket(run(), reopened, "op");
    expect(showMock).toHaveBeenCalledWith(REPO, reopened.id);
    expect(unlinkMock).toHaveBeenCalledWith(REPO, reopened.id, SURVIVOR);
  });

  it("leaves a ticket with no stale edge untouched", async () => {
    showMock.mockResolvedValue({ ...reopened, dependencies: [] });
    await claimTicket(run(), reopened, "op");
    expect(unlinkMock).not.toHaveBeenCalled();
  });

  it("parks — restoring the claim — when the authoritative read fails (PR #238 review)", async () => {
    // A transient `bd show` failure tells us NOTHING about the edge; treating the unreadable bead
    // as edge-free would run the ticket and let a surviving `supersedes` reach the close/resume
    // that drops the rerun's work. So fail closed rather than proceed on an unverified read.
    showMock.mockRejectedValue(new Error("database is locked"));

    const err = await claimTicket(run(), reopened, "op").then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(PoisonEpic);
    expect((err as Error).message).toMatch(/could not be re-read after claiming/);
    expect(unlinkMock).not.toHaveBeenCalled();
    // The claim the gate took is handed back so the resume's own claim gate can re-take it.
    expect(setStatusMock).toHaveBeenCalledWith(REPO, reopened.id, "open");
    expect(unassignMock).toHaveBeenCalledWith(REPO, reopened.id);
  });

  it("parks — restoring the claim — when bd refuses to remove the edge", async () => {
    unlinkMock.mockRejectedValue(new Error("Command failed: bd dep remove\ndatabase is locked"));

    const err = await claimTicket(run(), reopened, "op").then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(PoisonEpic);
    expect((err as Error).message).toMatch(/stale `supersedes` edge/);
    expect(unlinkMock).toHaveBeenCalledTimes(3); // mustPersist retries before it gives up
    // The claim the gate took is handed back so the resume's own claim gate can re-take it.
    expect(setStatusMock).toHaveBeenCalledWith(REPO, reopened.id, "open");
    expect(unassignMock).toHaveBeenCalledWith(REPO, reopened.id);
  }, 10_000);
});
