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
const supersedeMock = vi.fn();
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
      supersede: (...args: unknown[]) => supersedeMock(...args),
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
  // A reopened retirement as the run's board SNAPSHOT holds it: `bd reopen` returns it to `open`
  // but leaves the `supersedes` edge behind.
  const reopened = {
    id: "anton-t2",
    title: "Expose the schema",
    status: "open",
    labels: [],
    dependencies: [{ issue_id: "anton-t2", depends_on_id: SURVIVOR, type: "supersedes" }],
  } as unknown as Bead;
  /**
   * The same bead as bd answers AFTER the gate's own claim: `bd update --claim` flips it to
   * `in_progress` and assigns the operator. That claim is the baseline the edge is judged against —
   * an edge on a bead still reading this way can only predate it (PR #238 review).
   */
  const claimed = { ...reopened, status: "in_progress", assignee: "op" } as Bead;

  beforeEach(() => {
    vi.resetAllMocks();
    claimMock.mockResolvedValue(undefined);
    tagMock.mockResolvedValue(undefined);
    untagMock.mockResolvedValue(undefined);
    setStatusMock.mockResolvedValue(undefined);
    unassignMock.mockResolvedValue(undefined);
    syncMock.mockResolvedValue(undefined);
    unlinkMock.mockResolvedValue(undefined);
    supersedeMock.mockResolvedValue(undefined);
    showMock.mockResolvedValue(claimed);
  });

  it("removes the stale edge on the authoritative read the claim just earned", async () => {
    await claimTicket(run(), reopened, "op");
    expect(showMock).toHaveBeenCalledWith(REPO, reopened.id);
    expect(unlinkMock).toHaveBeenCalledWith(REPO, reopened.id, SURVIVOR);
  });

  it("leaves a ticket with no stale edge untouched", async () => {
    showMock.mockResolvedValue({ ...claimed, dependencies: [] });
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

  // The window the fix closes (PR #238 review): another process superseded this ticket AFTER the
  // claim landed, so the edge on the post-claim read is a VALID retirement, not the stale pointer a
  // reopen kept. Clearing it would run a ticket that hand already settled and record its close as
  // ordinary delivery.
  it("keeps a retirement that landed after the claim, and retries instead of running the ticket", async () => {
    showMock.mockResolvedValue({ ...claimed, status: "closed" });

    const err = await claimTicket(run(), reopened, "op").then(
      () => undefined,
      (e: unknown) => e,
    );
    expect((err as Error).message).toMatch(/retired as superseded by anton-t9 after this run claimed it/);
    // Retryable, so the next attempt re-reads the board and drops it as the settled retirement.
    expect(err).not.toBeInstanceOf(PoisonEpic);
    expect(unlinkMock).not.toHaveBeenCalled();
    // Nothing is handed back: the bead belongs to whoever settled it, and reopening a closed
    // retirement is exactly what must not happen.
    expect(setStatusMock).not.toHaveBeenCalled();
    expect(unassignMock).not.toHaveBeenCalled();
  });

  it("keeps one whose claim moved to another operator in the same window", async () => {
    showMock.mockResolvedValue({ ...claimed, assignee: "someone-else" });

    const err = await claimTicket(run(), reopened, "op").then(
      () => undefined,
      (e: unknown) => e,
    );
    expect((err as Error).message).toMatch(/after this run claimed it/);
    expect(unlinkMock).not.toHaveBeenCalled();
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

  // The window the pre-unlink check cannot see (PR #238 review): another process supersedes the
  // ticket against the SAME survivor between that check and the unlink, so the write strips the NEW
  // retirement's edge rather than the reopened one's — and because the survivor matches, nothing
  // downstream can tell. Only a read taken with the unlink on the board can have seen that writer.
  it("retries instead of running when a retirement landed while the edge was being removed", async () => {
    showMock
      .mockResolvedValueOnce(claimed) // pre-unlink: still ours, so the edge reads as stale
      .mockResolvedValue({ ...claimed, status: "closed" }); // post-unlink: another hand settled it

    const err = await claimTicket(run(), reopened, "op").then(
      () => undefined,
      (e: unknown) => e,
    );
    expect((err as Error).message).toMatch(
      /retired as superseded by anton-t9 while anton was removing the stale `supersedes` edge/,
    );
    // Retryable, so the next attempt re-reads the board and drops it as the settled retirement.
    expect(err).not.toBeInstanceOf(PoisonEpic);
    // …but only because the edge the unlink took off that settlement went BACK first (PR #238
    // review). Left off, the ticket is closed with no survivor, which the next attempt reads as a
    // cross-machine resume: it reopens the bead and re-runs work the other hand settled.
    expect(supersedeMock).toHaveBeenCalledWith(REPO, reopened.id, SURVIVOR);
    // The claim is still not handed back: the bead belongs to whoever settled it.
    expect(setStatusMock).not.toHaveBeenCalled();
    expect(unassignMock).not.toHaveBeenCalled();
  });

  // The restore is what makes the retry safe, so a bd that refuses it PARKS rather than handing the
  // next attempt a closed ticket with no survivor recorded (PR #238 review).
  it("parks when the retirement's edge cannot be written back", async () => {
    showMock.mockResolvedValueOnce(claimed).mockResolvedValue({ ...claimed, status: "closed" });
    supersedeMock.mockRejectedValue(new Error("Command failed: bd supersede\ndatabase is locked"));

    const err = await claimTicket(run(), reopened, "op").then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(PoisonEpic);
    expect((err as Error).message).toMatch(/bd supersede anton-t2 --with anton-t9/);
    expect(supersedeMock).toHaveBeenCalledTimes(3); // mustPersist retries before it gives up
    expect(setStatusMock).not.toHaveBeenCalled();
  }, 10_000);

  it("retries when the same-survivor retirement moved the claim rather than the status", async () => {
    showMock
      .mockResolvedValueOnce(claimed)
      .mockResolvedValue({ ...claimed, assignee: "someone-else" });

    const err = await claimTicket(run(), reopened, "op").then(
      () => undefined,
      (e: unknown) => e,
    );
    expect((err as Error).message).toMatch(/while anton was removing the stale `supersedes` edge/);
    expect(err).not.toBeInstanceOf(PoisonEpic);
    // Nothing was superseded — the ticket is still in_progress, just held by another hand — so the
    // edge that came off was the stale one this run came for, and re-closing the bead as superseded
    // would destroy that live claim (PR #238 review).
    expect(supersedeMock).not.toHaveBeenCalled();
  });

  // An abandoned bead needs no restore either: dispatch drops it as abandoned with or without the
  // edge, and re-superseding it would overwrite a person's recorded won't-do.
  it("does not re-draw the edge when the ticket was abandoned in the window", async () => {
    showMock
      .mockResolvedValueOnce(claimed)
      .mockResolvedValue({ ...claimed, status: "closed", labels: ["abandoned"] });

    const err = await claimTicket(run(), reopened, "op").then(
      () => undefined,
      (e: unknown) => e,
    );
    expect((err as Error).message).toMatch(/while anton was removing the stale `supersedes` edge/);
    expect(err).not.toBeInstanceOf(PoisonEpic);
    expect(supersedeMock).not.toHaveBeenCalled();
  });

  // "Could not read back" is not "nothing landed": proceeding would run the ticket on exactly the
  // race this fence exists to catch.
  it("retries when the ticket cannot be read back after the edge came off", async () => {
    showMock.mockResolvedValueOnce(claimed).mockRejectedValue(new Error("database is locked"));

    const err = await claimTicket(run(), reopened, "op").then(
      () => undefined,
      (e: unknown) => e,
    );
    expect((err as Error).message).toMatch(/bd would not read the ticket back/);
    expect(err).not.toBeInstanceOf(PoisonEpic);
  });

  it("runs the ticket when the post-unlink read still shows this run's own claim", async () => {
    await claimTicket(run(), reopened, "op");
    expect(unlinkMock).toHaveBeenCalledWith(REPO, reopened.id, SURVIVOR);
    // Two reads: the one the unlink is decided on, and the one that fences it.
    expect(showMock).toHaveBeenCalledTimes(2);
  });
});
