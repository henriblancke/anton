/**
 * anton-287p.4 — what arming a human gate does when the board underneath it misbehaves: a read that
 * fails, a supersede that fails, and a gate somebody else armed.
 *
 * The board read IS the idempotency decision: bd omits gate beads from every ordinary listing, so a
 * `--type gate` leg that fails hands back a board that looks bare even when this exact ask is
 * already armed. Creating on that reading makes a SECOND human gate — and two are worse than none.
 * Nothing ever auto-resolves a human gate (`bd gate check` does not evaluate one, the expiry pass
 * skips it), the park message names only the newer gate, and closing that one leaves the target
 * blocked by its twin forever, with no resume.
 *
 * So the read is strict and its failure aborts the arm — as does a superseded gate that stays open,
 * which blocks the target exactly like that twin. The run then settles FAILED carrying the ask,
 * which a person can still act on — recoverable, unlike a wait resolving cannot end.
 *
 * The other half is ORDER: the replacement is armed before the wait it supersedes is retired, so no
 * failure and no kill can leave the target carrying no human gate on an ask nobody answered.
 *
 * The last sections are the SETTLE that follows a successful arm and the CLEANUP that follows the
 * settle — the two places left where the gate and the run row can still tell different stories: the
 * row write can fail outright, a kill can land inside it after every check in the arm has passed,
 * and a kill can land later still, in the uninterruptible lease-clear/sync the run ends with.
 *
 * Mocked at the bd seam, because the states under test are bd calls that fail: the end-to-end shapes
 * of the arm live in execute-epic.needs-human.integration.test.ts against real bd.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { LABELS, type Bead, type Gate } from "../beads/bd";
import { parkedAskGateId, parkedAskGateIds } from "./errors";

const loadAllIssuesMock = vi.fn();
const gateCreateMock = vi.fn();
const gateResolveMock = vi.fn();
const tagMock = vi.fn();
const untagMock = vi.fn();
const showMock = vi.fn();
const pullMock = vi.fn();
const closeMock = vi.fn();

vi.mock("../beads/issues", async () => {
  const actual = await vi.importActual<typeof import("../beads/issues")>("../beads/issues");
  return { ...actual, loadAllIssues: (...args: unknown[]) => loadAllIssuesMock(...args) };
});

vi.mock("../beads/bd", async () => {
  const actual = await vi.importActual<typeof import("../beads/bd")>("../beads/bd");
  return {
    ...actual,
    beads: {
      ...actual.beads,
      gateCreate: (...args: unknown[]) => gateCreateMock(...args),
      gateResolve: (...args: unknown[]) => gateResolveMock(...args),
      tag: (...args: unknown[]) => tagMock(...args),
      untag: (...args: unknown[]) => untagMock(...args),
      show: (...args: unknown[]) => showMock(...args),
      pull: (...args: unknown[]) => pullMock(...args),
      close: (...args: unknown[]) => closeMock(...args),
    },
  };
});

const {
  armHumanGate,
  armHumanTicketGates,
  preflightHumanTickets,
  MAX_HUMAN_TICKET_PASSES,
  humanGateReason,
  humanTicketAsk,
  concludeCancelledArmedPark,
  undoCancelledTicketGates,
  HUMAN_GATE_ARMED_LABEL,
  liveArmedAsk,
  reconcileCancelledArmedPark,
  settleArmedAsk,
} = await import("./execute-epic-human-gate");
const { NeedsHumanError, StrandedHumanGateError } = await import("./execute-epic-errors");

const REPO = "/tmp/anton";
const TICKET = "t-1";
const ASK = "the staging DB password has to be rotated by a person";
/** The ask AND the ticket that raised it — what the run's catch hands the arm. */
const ASKED = { ticketId: TICKET, ask: ASK };
/** The reason the arm composes onto the gate: the ask, prefixed by the ticket that raised it. */
const REASON = `${TICKET} needs a human: ${ASK}`;

/** A target blocked by the given gates, as a board read returns it. */
const target = (...gateIds: string[]): Bead =>
  ({
    id: "f-1",
    title: "f-1",
    status: "open",
    issue_type: "feature",
    dependencies: gateIds.map((g) => ({ issue_id: "f-1", depends_on_id: g, type: "blocks" })),
  }) as Bead;

const gate = (id: string, reason: string, labels: string[] = [HUMAN_GATE_ARMED_LABEL]): Gate =>
  ({
    id,
    title: "Gate: human",
    status: "open",
    issue_type: "gate",
    await_type: "human",
    description: `Ad-hoc gate blocking f-1\n\nReason: ${reason}`,
    labels,
  }) as Gate;

beforeEach(() => {
  loadAllIssuesMock.mockReset();
  gateCreateMock.mockReset();
  gateResolveMock.mockReset().mockResolvedValue(undefined);
  tagMock.mockReset().mockResolvedValue(undefined);
  untagMock.mockReset().mockResolvedValue(undefined);
  // The re-read a failed retire makes before it restores the marker: the wait still stands.
  showMock.mockReset().mockImplementation(async (_repo: string, id: string) => gate(id, REASON, []));
  pullMock.mockReset().mockResolvedValue(undefined);
  closeMock.mockReset().mockResolvedValue(undefined);
});

it("pulls the shared board before it plans, so a gate another machine armed is visible", async () => {
  // The run's step-0 pull is a whole run old by the time an ask lands here (PR #205 review): a
  // human gate armed elsewhere since then lives only on the remote, and planning against the stale
  // local working set would read the target as bare and arm a SECOND wait for the same ask.
  const order: string[] = [];
  pullMock.mockImplementation(async () => {
    order.push("pull");
  });
  loadAllIssuesMock.mockImplementation(async () => {
    order.push("read");
    return [target("g-elsewhere"), gate("g-elsewhere", REASON, [])];
  });

  await expect(armHumanGate(REPO, "f-1", ASKED)).resolves.toEqual({
    gateId: "g-elsewhere",
    held: [],
  });
  // Pull-then-read twice: once to PLAN, once to reconcile what the target holds after the arm — the
  // window between them is where a concurrent gate lands (PR #205 review).
  expect(order).toEqual(["pull", "read", "pull", "read"]);
  expect(pullMock).toHaveBeenCalledWith(REPO);
  expect(gateCreateMock).not.toHaveBeenCalled();
});

it("refuses to arm on a board it could not refresh, rather than planning against a stale copy", async () => {
  // A pull that rejects means anton cannot establish it is looking at the current board — the one
  // state in which "nothing is armed" is unprovable. Failing here settles the run FAILED carrying
  // the ask, which a person can act on; a duplicate human gate is a wait no resolve can end.
  pullMock.mockRejectedValue(new Error("dolt pull: remote unreachable"));

  await expect(armHumanGate(REPO, "f-1", ASKED)).rejects.toThrow("could not be refreshed");
  expect(loadAllIssuesMock).not.toHaveBeenCalled();
  expect(gateCreateMock).not.toHaveBeenCalled();
});

it("reads the board strictly, so a failed gate listing can never read as 'nothing armed'", async () => {
  loadAllIssuesMock.mockResolvedValue([]);
  gateCreateMock.mockResolvedValue("g-new");

  await expect(armHumanGate(REPO, "f-1", ASKED)).resolves.toEqual({
    gateId: "g-new",
    held: [],
    undo: expect.any(Function),
  });
  expect(loadAllIssuesMock).toHaveBeenCalledWith(REPO, { strictGates: true });
});

it("refuses to arm on a board it could not read, rather than stacking a second wait on the same ask", async () => {
  loadAllIssuesMock.mockRejectedValue(new Error("bd: database is locked"));

  await expect(armHumanGate(REPO, "f-1", ASKED)).rejects.toThrow("database is locked");
  expect(gateCreateMock).not.toHaveBeenCalled();
});

it("labels the gate it arms, so a later ask can tell its own leftover from a person's hold", async () => {
  loadAllIssuesMock.mockResolvedValue([target()]);
  gateCreateMock.mockResolvedValue("g-new");

  await armHumanGate(REPO, "f-1", ASKED);
  expect(tagMock).toHaveBeenCalledWith(REPO, "g-new", [HUMAN_GATE_ARMED_LABEL]);
});

it("still parks on the gate when the label write is lost — the ask is already on the board", async () => {
  loadAllIssuesMock.mockResolvedValue([target()]);
  gateCreateMock.mockResolvedValue("g-new");
  tagMock.mockRejectedValue(new Error("bd: database is locked"));

  await expect(armHumanGate(REPO, "f-1", ASKED)).resolves.toEqual({
    gateId: "g-new",
    held: [],
    undo: expect.any(Function),
  });
});

it("aborts when its own superseded gate cannot be resolved, instead of parking behind it", async () => {
  // The failure this guards: the stale gate blocks the target for good (nothing auto-resolves a
  // human gate), so resolving the gate the park NAMES would leave the run parked forever. Both ids
  // ride out in the error — the replacement is already armed by the time the supersede is tried.
  loadAllIssuesMock.mockResolvedValue([target("g-old"), gate("g-old", "an older ask")]);
  gateCreateMock.mockResolvedValue("g-new");
  gateResolveMock.mockRejectedValue(new Error("bd: database is locked"));

  const failure = await armHumanGate(REPO, "f-1", ASKED).catch((e) => e);
  expect(failure).toBeInstanceOf(StrandedHumanGateError);
  expect(failure.gateIds).toEqual(["g-new", "g-old"]);
  expect(failure.message).toContain("bd gate resolve g-old");
});

it("arms the replacement BEFORE retiring the wait it supersedes", async () => {
  // Ordering is the whole safety property (anton-287p): retire-then-arm leaves the target carrying
  // no human gate at all for the width of the `gate create` — unanswered ask, and on a shared board
  // claimable by another machine in that window.
  loadAllIssuesMock.mockResolvedValue([target("g-old"), gate("g-old", "an older ask")]);
  gateCreateMock.mockResolvedValue("g-new");

  // No `undo` past the retire: `g-old` is closed, so taking `g-new` back would leave the target
  // with no wait at all on an ask nobody answered.
  await expect(armHumanGate(REPO, "f-1", ASKED)).resolves.toEqual({
    gateId: "g-new",
    held: [],
    undo: undefined,
  });
  expect(gateResolveMock).toHaveBeenCalledWith(REPO, "g-old", expect.stringMatching(/superseded/));
  expect(gateCreateMock.mock.invocationCallOrder[0]).toBeLessThan(
    gateResolveMock.mock.invocationCallOrder[0],
  );
});

it("leaves the superseded wait open when the replacement cannot be created", async () => {
  // The create is what the old ordering gambled on: fail it after the retire and the target is bare.
  // Armed-first means this failure costs nothing — the older gate still blocks, and the run settles
  // FAILED carrying the ask.
  loadAllIssuesMock.mockResolvedValue([target("g-old"), gate("g-old", "an older ask")]);
  gateCreateMock.mockRejectedValue(new Error("bd: database is locked"));

  await expect(armHumanGate(REPO, "f-1", ASKED)).rejects.toThrow("database is locked");
  expect(gateResolveMock).not.toHaveBeenCalled();
});

it("keeps the superseded wait when the kill lands inside `gate create` and the new gate is undone", async () => {
  // The undo is only ever safe here BECAUSE the retire has not run yet: the target keeps `g-old`,
  // so a cancelled arm can never be what hands an unanswered target back to the board.
  const controller = new AbortController();
  loadAllIssuesMock.mockResolvedValue([target("g-old"), gate("g-old", "an older ask")]);
  gateCreateMock.mockImplementation(async () => {
    controller.abort();
    return "g-new";
  });

  await expect(armHumanGate(REPO, "f-1", ASKED, controller.signal)).rejects.toThrow(/cancelled/);
  expect(gateResolveMock).toHaveBeenCalledTimes(1);
  expect(gateResolveMock).toHaveBeenCalledWith(REPO, "g-new", expect.stringMatching(/cancelled/));
});

it("lets the armed gate stand when the kill lands inside the supersede, and names it", async () => {
  // Past the point of undo: `g-old` is already closed, so resolving `g-new` too would leave the
  // target with no wait on an unanswered ask. The gate stays and rides out in the error instead.
  const controller = new AbortController();
  loadAllIssuesMock.mockResolvedValue([target("g-old"), gate("g-old", "an older ask")]);
  gateCreateMock.mockResolvedValue("g-new");
  gateResolveMock.mockImplementation(async () => {
    controller.abort();
  });

  const failure = await armHumanGate(REPO, "f-1", ASKED, controller.signal).catch((e) => e);
  expect(failure).toBeInstanceOf(StrandedHumanGateError);
  expect(failure.gateIds).toEqual(["g-new"]);
  expect(gateResolveMock).toHaveBeenCalledTimes(1); // only the supersede — g-new is never undone
});

it("retires the superseded wait on the REUSE path too, behind the gate already carrying the ask", async () => {
  // The reused gate IS the armed replacement, so the ordering already holds — but skipping the
  // retire here would leave an earlier attempt's stale wait open beside it, blocking the target
  // after the named gate is resolved.
  loadAllIssuesMock.mockResolvedValue([
    target("g-mine", "g-old"),
    gate("g-mine", REASON),
    gate("g-old", "an older ask"),
  ]);

  await expect(armHumanGate(REPO, "f-1", ASKED)).resolves.toEqual({ gateId: "g-mine", held: [] });
  expect(gateCreateMock).not.toHaveBeenCalled();
  expect(gateResolveMock).toHaveBeenCalledWith(REPO, "g-old", expect.stringMatching(/superseded/));
});

it("never resolves a human gate anton did not arm, and reports it back for the park message", async () => {
  // `bd gate create --blocks f-1` by hand is a founder's "stop until I say so" — an ask arriving
  // afterwards must arm beside it, not close it. The hold rides back to the caller because it still
  // blocks the target: a park naming only `g-new` would promise a resume that cannot happen.
  loadAllIssuesMock.mockResolvedValue([
    target("g-theirs"),
    gate("g-theirs", "hold: talking to legal", []),
  ]);
  gateCreateMock.mockResolvedValue("g-new");

  await expect(armHumanGate(REPO, "f-1", ASKED)).resolves.toEqual({
    gateId: "g-new",
    held: ["g-theirs"],
    undo: expect.any(Function),
  });
  expect(gateResolveMock).not.toHaveBeenCalled();
});

it("names a gate that landed AFTER the plan, so the park does not promise a resume it cannot give", async () => {
  // The plan and the create are separate bd transactions with nothing serializing them (PR #205
  // review): an operator — or another machine, on a shared server where every bd commit is global
  // immediately — can arm a hold in the window between them. Invisible to the plan, it would hold
  // the target after the park's named gate is resolved, with nothing naming it.
  loadAllIssuesMock
    .mockResolvedValueOnce([target()])
    .mockResolvedValueOnce([
      target("g-meanwhile"),
      gate("g-meanwhile", "hold: talking to legal", []),
    ]);
  gateCreateMock.mockResolvedValue("g-new");

  await expect(armHumanGate(REPO, "f-1", ASKED)).resolves.toEqual({
    gateId: "g-new",
    held: ["g-meanwhile"],
    undo: expect.any(Function),
  });
  // Reported, never resolved: it was never judged against this ask, whoever armed it.
  expect(gateResolveMock).not.toHaveBeenCalled();
});

it("leaves the waits it is about to supersede out of the reconciled holds", async () => {
  // The reconcile runs BEFORE the retire (the replacement is armed first, always), so anton's own
  // superseded gate is still open in the re-read. Naming it would send the operator after a gate
  // that closes moments later.
  loadAllIssuesMock.mockResolvedValue([target("g-old"), gate("g-old", "an older ask")]);
  gateCreateMock.mockResolvedValue("g-new");

  await expect(armHumanGate(REPO, "f-1", ASKED)).resolves.toEqual({ gateId: "g-new", held: [] });
  expect(gateResolveMock).toHaveBeenCalledWith(REPO, "g-old", expect.stringMatching(/superseded/));
});

it("undoes the gate it armed when the reconcile read fails, rather than parking on a partial list", async () => {
  // The planned holds are exactly the reading that cannot see a concurrent gate (PR #205 review):
  // falling back to them would park the run promising that resolving `g-new` resumes it, while a
  // wait nothing names keeps blocking the target. The undo is safe here — nothing was superseded —
  // so the arm costs a re-run instead.
  loadAllIssuesMock
    .mockResolvedValueOnce([target("g-theirs"), gate("g-theirs", "hold: talking to legal", [])])
    .mockRejectedValueOnce(new Error("bd: database is locked"));
  gateCreateMock.mockResolvedValue("g-new");

  const failure = await armHumanGate(REPO, "f-1", ASKED).catch((e) => e);
  expect(failure.message).toContain("could not be re-read");
  expect(failure.message).toContain("database is locked");
  expect(failure.message).toContain("carries no wait from this run");
  expect(gateResolveMock).toHaveBeenCalledWith(REPO, "g-new", expect.stringMatching(/abandoned/));
});

it("fails the same way when the reconcile PULL fails, not just the read", async () => {
  // The concurrent writer may be another machine, so an unreachable remote is the same blindness as
  // an unreadable board — the local copy simply cannot show the gate.
  loadAllIssuesMock.mockResolvedValue([target()]);
  gateCreateMock.mockResolvedValue("g-new");
  pullMock.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error("remote unreachable"));

  await expect(armHumanGate(REPO, "f-1", ASKED)).rejects.toThrow(/remote unreachable/);
  expect(gateResolveMock).toHaveBeenCalledWith(REPO, "g-new", expect.stringMatching(/abandoned/));
});

it("names the gate it could not take back when the reconcile fails AND the undo fails", async () => {
  // Nothing automatic closes a human gate, so an undo that fails leaves `g-new` blocking the target
  // for good; the id has to ride out in the error, because nothing else on the board names it.
  loadAllIssuesMock
    .mockResolvedValueOnce([target()])
    .mockRejectedValueOnce(new Error("bd: database is locked"));
  gateCreateMock.mockResolvedValue("g-new");
  gateResolveMock.mockRejectedValue(new Error("bd: database is locked"));

  const failure = await armHumanGate(REPO, "f-1", ASKED).catch((e) => e);
  expect(failure).toBeInstanceOf(StrandedHumanGateError);
  expect(failure.gateIds).toEqual(["g-new"]);
  expect(failure.message).toContain("bd gate resolve g-new");
});

it("leaves a reused gate standing when the reconcile fails, and names it", async () => {
  // An earlier attempt armed `g-mine` for this same ask: it is not this run's to resolve, so the
  // failure carries it instead of taking it back. The supersede never runs — the arm ends first.
  loadAllIssuesMock
    .mockResolvedValueOnce([
      target("g-mine", "g-old"),
      gate("g-mine", REASON),
      gate("g-old", "an older ask"),
    ])
    .mockRejectedValueOnce(new Error("bd: database is locked"));

  const failure = await armHumanGate(REPO, "f-1", ASKED).catch((e) => e);
  expect(failure).toBeInstanceOf(StrandedHumanGateError);
  expect(failure.gateIds).toEqual(["g-mine"]);
  expect(gateResolveMock).not.toHaveBeenCalled();
});

it("refuses the arm when the kill lands inside the reconcile read", async () => {
  // The re-read is an uninterruptible await like every other, so the cancellation check that follows
  // it is what keeps a killed run from riding out as a successful arm and parking behind the gate.
  const controller = new AbortController();
  loadAllIssuesMock.mockResolvedValueOnce([target()]).mockImplementationOnce(async () => {
    controller.abort();
    return [target("g-new"), gate("g-new", REASON)];
  });
  gateCreateMock.mockResolvedValue("g-new");

  await expect(armHumanGate(REPO, "f-1", ASKED, controller.signal)).rejects.toThrow(/cancelled/);
  expect(gateResolveMock).toHaveBeenCalledWith(REPO, "g-new", expect.stringMatching(/cancelled/));
});

it("creates no gate when the run is killed while the board is being read (anton-287p)", async () => {
  // The window the settle's own signal read cannot cover: the strict board read is an uninterruptible
  // await, so a force-kill landing inside it arrives AFTER the caller sampled a live signal. Arming
  // anyway would leave a killed run's target blocked by a gate only a person can clear.
  const controller = new AbortController();
  loadAllIssuesMock.mockImplementation(async () => {
    controller.abort();
    return [target()];
  });

  await expect(armHumanGate(REPO, "f-1", ASKED, controller.signal)).rejects.toThrow(/cancelled/);
  expect(gateCreateMock).not.toHaveBeenCalled();
});

it("leaves its own superseded gate alone when the kill lands mid-read, rather than clearing the target's only wait", async () => {
  // Resolving the older ask while arming nothing would hand the target back to `bd ready` on an ask
  // nobody answered — the opposite failure from the duplicate gate, and just as permanent.
  const controller = new AbortController();
  loadAllIssuesMock.mockImplementation(async () => {
    controller.abort();
    return [target("g-old"), gate("g-old", "an older ask")];
  });

  await expect(armHumanGate(REPO, "f-1", ASKED, controller.signal)).rejects.toThrow(/cancelled/);
  expect(gateResolveMock).not.toHaveBeenCalled();
  expect(gateCreateMock).not.toHaveBeenCalled();
});

it("undoes the gate it just created when the kill lands inside `gate create` (anton-287p)", async () => {
  // The window no pre-write check can cover: `gate create` is itself an uninterruptible await, so a
  // force-kill arriving while it runs leaves a gate the caller would read as a successful arm — and
  // a cancelled run would park behind a wait nobody is waiting on, blocking the target for good.
  const controller = new AbortController();
  loadAllIssuesMock.mockResolvedValue([target()]);
  gateCreateMock.mockImplementation(async () => {
    controller.abort();
    return "g-new";
  });

  await expect(armHumanGate(REPO, "f-1", ASKED, controller.signal)).rejects.toThrow(/cancelled/);
  expect(gateResolveMock).toHaveBeenCalledWith(REPO, "g-new", expect.stringMatching(/cancelled/));
  expect(tagMock).not.toHaveBeenCalled(); // nothing is left to label
});

it("names the gate it could not undo, because nothing else ever will", async () => {
  // Both halves lost: the gate exists and its resolve failed, so no automatic pass will close it and
  // the target stays blocked. The id has to ride out in the error — the run settles FAILED on it.
  const controller = new AbortController();
  loadAllIssuesMock.mockResolvedValue([target()]);
  gateCreateMock.mockImplementation(async () => {
    controller.abort();
    return "g-new";
  });
  gateResolveMock.mockRejectedValue(new Error("bd: database is locked"));

  const failure = await armHumanGate(REPO, "f-1", ASKED, controller.signal).catch((e) => e);
  expect(failure).toBeInstanceOf(StrandedHumanGateError);
  expect(failure.gateId).toBe("g-new");
  expect(failure.message).toContain("bd gate resolve g-new");
});

it("undoes the gate when the kill lands inside the label write, the last uninterruptible await", async () => {
  // The window past every earlier check: the gate is created and live, and the label write is the
  // final await before the successful return the caller PARKS on. A kill arriving there would ride
  // out as a good arm and leave a cancelled run's target blocked by a gate only a person can clear.
  const controller = new AbortController();
  loadAllIssuesMock.mockResolvedValue([target()]);
  gateCreateMock.mockResolvedValue("g-new");
  tagMock.mockImplementation(async () => {
    controller.abort();
  });

  await expect(armHumanGate(REPO, "f-1", ASKED, controller.signal)).rejects.toThrow(/cancelled/);
  expect(gateResolveMock).toHaveBeenCalledWith(REPO, "g-new", expect.stringMatching(/cancelled/));
});

it("names the gate it could not undo after a kill inside the label write", async () => {
  const controller = new AbortController();
  loadAllIssuesMock.mockResolvedValue([target()]);
  gateCreateMock.mockResolvedValue("g-new");
  tagMock.mockImplementation(async () => {
    controller.abort();
  });
  gateResolveMock.mockRejectedValue(new Error("bd: database is locked"));

  const failure = await armHumanGate(REPO, "f-1", ASKED, controller.signal).catch((e) => e);
  expect(failure).toBeInstanceOf(StrandedHumanGateError);
  expect(failure.gateId).toBe("g-new");
});

it("refuses to REUSE an armed gate when the kill lands mid-read, rather than parking a dead run", async () => {
  // The reuse path writes nothing, so it reaches neither guarded write — but returning a gate is
  // exactly what makes the caller park, and a cancelled run parked on a human gate waits forever.
  // The gate stays: an earlier attempt armed it for this same ask, so it is not this run's to undo.
  const controller = new AbortController();
  loadAllIssuesMock.mockImplementation(async () => {
    controller.abort();
    return [target("g-mine"), gate("g-mine", REASON)];
  });

  await expect(armHumanGate(REPO, "f-1", ASKED, controller.signal)).rejects.toThrow(/cancelled/);
  expect(gateResolveMock).not.toHaveBeenCalled();
  expect(gateCreateMock).not.toHaveBeenCalled();
});

it("arms as usual while the run is still live", async () => {
  loadAllIssuesMock.mockResolvedValue([target()]);
  gateCreateMock.mockResolvedValue("g-new");

  const controller = new AbortController();
  await expect(armHumanGate(REPO, "f-1", ASKED, controller.signal)).resolves.toEqual({
    gateId: "g-new",
    held: [],
    undo: expect.any(Function),
  });
});

it("offers the caller an undo for the gate it created, for a kill that lands after the arm returns", async () => {
  // The last window of all (anton-287p): the settle write is uninterruptible too, so a kill can land
  // after every check inside the arm has passed. Nothing was superseded here, so taking the gate
  // back returns the target to exactly the state the arm found — the caller's only safe correction.
  loadAllIssuesMock.mockResolvedValue([target()]);
  gateCreateMock.mockResolvedValue("g-new");

  const armed = await armHumanGate(REPO, "f-1", ASKED);
  await expect(armed.undo!()).resolves.toBe(true);
  expect(gateResolveMock).toHaveBeenCalledWith(REPO, "g-new", expect.stringMatching(/cancelled/));
});

it("reports an undo that failed, so the caller names the gate instead of assuming it is gone", async () => {
  loadAllIssuesMock.mockResolvedValue([target()]);
  gateCreateMock.mockResolvedValue("g-new");

  const armed = await armHumanGate(REPO, "f-1", ASKED);
  gateResolveMock.mockRejectedValue(new Error("bd: database is locked"));
  await expect(armed.undo!()).resolves.toBe(false);
});

it("offers NO undo for a wait an earlier attempt armed — it is not this run's to take back", async () => {
  loadAllIssuesMock.mockResolvedValue([target("g-mine"), gate("g-mine", REASON)]);

  await expect(armHumanGate(REPO, "f-1", ASKED)).resolves.toEqual({
    gateId: "g-mine",
    held: [],
    undo: undefined,
  });
});

it("reports a person's hold beside a wait it REUSES, not only beside one it creates", async () => {
  loadAllIssuesMock.mockResolvedValue([
    target("g-mine", "g-theirs"),
    gate("g-mine", REASON),
    gate("g-theirs", "hold: talking to legal", []),
  ]);

  await expect(armHumanGate(REPO, "f-1", ASKED)).resolves.toEqual({
    gateId: "g-mine",
    held: ["g-theirs"],
  });
  expect(gateCreateMock).not.toHaveBeenCalled();
});

// ── the settle behind a live gate (anton-287p) ──

const ASK_ERROR = () => new NeedsHumanError("t-1", ASK);

/** A row writer that records every patch and can be told to fail. */
const recorder = (failure?: string) => {
  const patches: Record<string, unknown>[] = [];
  return {
    patches,
    settle: async (patch: Record<string, unknown>) => {
      patches.push(patch);
      return failure;
    },
  };
};

it("parks the run behind the gate and throws the ask while the run is still live", async () => {
  const row = recorder();
  const { thrown, parked, awaitsHumanGate } = await settleArmedAsk({
    targetId: "f-1",
    ask: ASK_ERROR(),
    raw: ASK_ERROR(),
    gate: { gateId: "g-new", held: [], undo: async () => true },
    signal: new AbortController().signal,
    now: () => 1,
    settle: row.settle,
  });

  expect(row.patches).toEqual([{ status: "parked", error: expect.stringContaining(ASK) }]);
  expect(row.patches[0].error).toContain("bd gate resolve g-new");
  // An ask that is a DECISION needs somewhere for the answer to LAND (PR #205 review): resolving
  // the gate carries nothing back, so the park names the ticket whose human notes the resumed
  // session reads — otherwise the same question is asked again on resume, forever.
  expect(row.patches[0].error).toContain("note on t-1");
  expect(thrown).toBeInstanceOf(NeedsHumanError);
  // The error the RUNNER parks the job on names the gate (PR #205 review). Without that id the
  // sweep reads the poison park as a permanent failure and escalates the same wait twice — once as
  // the gate a person can resolve, once as an exhausted job that never was one.
  expect(parkedAskGateId((thrown as Error).message)).toBe("g-new");
  expect((thrown as Error).message).toContain(ASK);
  // The park LANDED, so the caller still owns this arm through its cleanup: a kill arriving in the
  // awaits that follow has to take it back, and only this verdict tells the caller there is
  // something left to take back.
  expect(parked).toBe(true);
  // …and the checkout belongs to the resume, not to the reaper: whoever answers the ask comes back
  // to this very run (PR #205 review).
  expect(awaitsHumanGate).toBe(true);
});

it("names the person's hold in the JOB park too, not only in the run's", async () => {
  // Anton's gate can be answered first while the hold still blocks the target, so the run does not
  // resume (PR #205 review). A park naming only the armed gate would read to the run-health sweep as
  // a permanent failure from that moment — with an Abandon offered on a run that is merely waiting.
  const row = recorder();
  const { thrown } = await settleArmedAsk({
    targetId: "f-1",
    ask: ASK_ERROR(),
    raw: ASK_ERROR(),
    gate: { gateId: "g-new", held: ["g-hold"], undo: async () => true },
    signal: new AbortController().signal,
    now: () => 1,
    settle: row.settle,
  });

  expect(parkedAskGateIds((thrown as Error).message)).toEqual(["g-new", "g-hold"]);
  // The run row still says what the operator does about the hold.
  expect(String(row.patches[0].error)).toContain("g-hold");
});

it("takes the arm back when the kill lands INSIDE the park write, and fails the row", async () => {
  // The window the arm's own checks cannot cover: the settle is an uninterruptible await too, and
  // nothing follows it — so a force-kill landing here would leave the run reading as parked behind
  // a wait nobody is servicing, blocking the target until someone clears it by hand.
  const controller = new AbortController();
  const row = {
    patches: [] as Record<string, unknown>[],
    settle: async (patch: Record<string, unknown>) => {
      row.patches.push(patch);
      controller.abort(); // the kill lands while the park is being written
      return undefined;
    },
  };
  let undone = false;

  const { thrown, parked, awaitsHumanGate } = await settleArmedAsk({
    targetId: "f-1",
    ask: ASK_ERROR(),
    raw: ASK_ERROR(),
    gate: {
      gateId: "g-new",
      held: [],
      undo: async () => {
        undone = true;
        return true;
      },
    },
    signal: controller.signal,
    now: () => 42,
    settle: row.settle,
  });

  expect(undone).toBe(true);
  expect(row.patches.map((p) => p.status)).toEqual(["parked", "failed"]);
  expect(row.patches[1].endedAt).toBe(42);
  // Nothing on the board carries the ask any more, and the error says exactly that.
  expect(String(row.patches[1].error)).toContain("armed NO gate");
  expect((thrown as Error).message).toContain("armed NO gate");
  // Already unwound here — the caller must NOT unwind it a second time in its cleanup, where
  // `undo` would resolve a gate that is already gone and report the ask as stranded.
  expect(parked).toBe(false);
  // No wait survives, so nothing is coming back for the checkout — the teardown releases it.
  expect(awaitsHumanGate).toBe(false);
});

it("names the gate that STANDS when the kill lands mid-write and undoing is unsafe", async () => {
  // No `undo` — the arm superseded an older wait behind this gate, so resolving it would leave the
  // target with none at all. The gate blocks the target with no run coming back for it, so both the
  // row and the thrown error have to name the id; nothing else on the board would.
  const controller = new AbortController();
  const row = {
    patches: [] as Record<string, unknown>[],
    settle: async (patch: Record<string, unknown>) => {
      row.patches.push(patch);
      controller.abort();
      return undefined;
    },
  };

  const { thrown } = await settleArmedAsk({
    targetId: "f-1",
    ask: ASK_ERROR(),
    raw: ASK_ERROR(),
    gate: { gateId: "g-new", held: [] },
    signal: controller.signal,
    now: () => 42,
    settle: row.settle,
  });

  expect(row.patches.map((p) => p.status)).toEqual(["parked", "failed"]);
  expect(String(row.patches[1].error)).toContain("bd gate resolve g-new");
  expect((thrown as Error).name).toBe("PoisonError"); // no retry can answer an ask
  expect((thrown as Error).message).toContain("bd gate resolve g-new");
});

it("names the gate that stands when the undo itself fails after the kill", async () => {
  const controller = new AbortController();
  const row = {
    patches: [] as Record<string, unknown>[],
    settle: async (patch: Record<string, unknown>) => {
      row.patches.push(patch);
      controller.abort();
      return undefined;
    },
  };

  const { thrown } = await settleArmedAsk({
    targetId: "f-1",
    ask: ASK_ERROR(),
    raw: ASK_ERROR(),
    gate: { gateId: "g-new", held: [], undo: async () => false },
    signal: controller.signal,
    now: () => 42,
    settle: row.settle,
  });

  expect(String(row.patches[1].error)).toContain("bd gate resolve g-new");
  expect((thrown as Error).message).toContain("bd gate resolve g-new");
});

it("keeps the gate and parks the JOB loudly when the row cannot be settled at all", async () => {
  // The failure is on the run's own database, not on the board — so undoing the gate would leave
  // NOTHING carrying the ask, and the next attempt would meet an ask with no record of itself. The
  // gate stays and the error names it, ask included.
  const row = recorder("SQLITE_BUSY: database is locked");
  let undone = false;

  const { thrown, parked, awaitsHumanGate } = await settleArmedAsk({
    targetId: "f-1",
    ask: ASK_ERROR(),
    raw: ASK_ERROR(),
    gate: {
      gateId: "g-new",
      held: [],
      undo: async () => {
        undone = true;
        return true;
      },
    },
    signal: new AbortController().signal,
    now: () => 1,
    settle: row.settle,
  });

  expect(undone).toBe(false);
  // Not the caller's to take back in its cleanup either: the row never recorded the park, so undoing
  // the gate later would leave NOTHING carrying the ask.
  expect(parked).toBe(false);
  // But the WAIT is live, and it is the checkout's verdict that matters here (PR #205 review): the
  // row reads failed while the gate stands, and releasing the worktree on that would discard the
  // partial work the resumed session continues from.
  expect(awaitsHumanGate).toBe(true);
  expect((thrown as Error).name).toBe("PoisonError");
  expect((thrown as Error).message).toContain(ASK);
  expect((thrown as Error).message).toContain("bd gate resolve g-new");
  expect((thrown as Error).message).toContain("database is locked");
});

it("keeps the UNDONE verdict when the corrective write fails after a mid-park kill", async () => {
  // The undo landed — no gate carries the ask any more — but the row write that records that
  // failed. Reporting the gate as armed would send the operator to `bd gate resolve` for an id
  // that no longer exists, and leave them waiting on a resume that is never coming.
  const controller = new AbortController();
  const row = {
    patches: [] as Record<string, unknown>[],
    settle: async (patch: Record<string, unknown>) => {
      row.patches.push(patch);
      if (row.patches.length === 1) {
        controller.abort(); // the kill lands while the park is being written
        return undefined;
      }
      return "SQLITE_BUSY: database is locked";
    },
  };
  let undone = false;

  const { thrown } = await settleArmedAsk({
    targetId: "f-1",
    ask: ASK_ERROR(),
    raw: ASK_ERROR(),
    gate: {
      gateId: "g-new",
      held: [],
      undo: async () => {
        undone = true;
        return true;
      },
    },
    signal: controller.signal,
    now: () => 42,
    settle: row.settle,
  });

  expect(undone).toBe(true);
  expect(row.patches.map((p) => p.status)).toEqual(["parked", "failed"]);
  expect((thrown as Error).name).toBe("PoisonError");
  expect((thrown as Error).message).toContain("armed NO gate");
  expect((thrown as Error).message).toContain("database is locked");
  expect((thrown as Error).message).not.toContain("bd gate resolve g-new");
});

it("keeps the STRANDED verdict when the corrective write fails after a mid-park kill", async () => {
  // Undoing was unsafe, so the gate stands with no run coming back for it. The id must still reach
  // the operator, alongside the row write that could not record any of it.
  const controller = new AbortController();
  const row = {
    patches: [] as Record<string, unknown>[],
    settle: async (patch: Record<string, unknown>) => {
      row.patches.push(patch);
      if (row.patches.length === 1) {
        controller.abort();
        return undefined;
      }
      return "SQLITE_BUSY: database is locked";
    },
  };

  const { thrown } = await settleArmedAsk({
    targetId: "f-1",
    ask: ASK_ERROR(),
    raw: ASK_ERROR(),
    gate: { gateId: "g-new", held: [] },
    signal: controller.signal,
    now: () => 42,
    settle: row.settle,
  });

  expect((thrown as Error).name).toBe("PoisonError");
  expect((thrown as Error).message).toContain("bd gate resolve g-new");
  expect((thrown as Error).message).toContain("re-run the target");
  expect((thrown as Error).message).toContain("database is locked");
});

it("unwinds the cancellation even when the park write ITSELF failed", async () => {
  // The window the old `!unsettled && signal.aborted` missed (PR #205 review): a force-kill can land
  // inside a settle that then also rejects (SQLITE_BUSY), and gating the unwind on the write having
  // landed reported that stopped run as an ordinary armed ask — leaving the gate this run created
  // blocking a target nobody is coming back for.
  const controller = new AbortController();
  const row = {
    patches: [] as Record<string, unknown>[],
    settle: async (patch: Record<string, unknown>) => {
      row.patches.push(patch);
      if (row.patches.length === 1) {
        controller.abort(); // the kill lands while the park write is failing
        return "SQLITE_BUSY: database is locked";
      }
      return undefined;
    },
  };
  let undone = false;

  const { thrown } = await settleArmedAsk({
    targetId: "f-1",
    ask: ASK_ERROR(),
    raw: ASK_ERROR(),
    gate: {
      gateId: "g-new",
      held: [],
      undo: async () => {
        undone = true;
        return true;
      },
    },
    signal: controller.signal,
    now: () => 42,
    settle: row.settle,
  });

  expect(undone).toBe(true);
  expect(row.patches.map((p) => p.status)).toEqual(["parked", "failed"]);
  // The corrective write landed, so the row is accurate and the failed park before it is spent
  // history: the ask reached no gate, and nothing sends the operator to `bd gate resolve`.
  expect(String(row.patches[1].error)).toContain("armed NO gate");
  expect((thrown as Error).message).toContain("armed NO gate");
  expect((thrown as Error).message).not.toContain("bd gate resolve g-new");
  expect((thrown as Error).message).not.toContain("database is locked");
});

it("carries BOTH write failures when the corrective write fails after a failed park write", async () => {
  // Neither write landed, so both are still true of the row — the run history may say anything at
  // all, and the error is the only place the operator learns what the board actually holds.
  const controller = new AbortController();
  const row = {
    patches: [] as Record<string, unknown>[],
    settle: async (patch: Record<string, unknown>) => {
      row.patches.push(patch);
      if (row.patches.length === 1) {
        controller.abort();
        return "SQLITE_BUSY: the park write";
      }
      return "SQLITE_BUSY: the corrective write";
    },
  };

  const { thrown } = await settleArmedAsk({
    targetId: "f-1",
    ask: ASK_ERROR(),
    raw: ASK_ERROR(),
    // No `undo` — the arm superseded an older wait, so the gate stands and has to be named.
    gate: { gateId: "g-new", held: [] },
    signal: controller.signal,
    now: () => 42,
    settle: row.settle,
  });

  expect((thrown as Error).name).toBe("PoisonError");
  expect((thrown as Error).message).toContain("bd gate resolve g-new");
  expect((thrown as Error).message).toContain("the park write");
  expect((thrown as Error).message).toContain("the corrective write");
});

// ── which settlements the cleanup's kill window still owes a reconcile ──

const ARM = () => ({
  gate: { gateId: "g-new", held: [], undo: async () => true },
  ask: ASK_ERROR(),
  raw: ASK_ERROR(),
});

it("hands the cleanup the arm behind an ordinary park", () => {
  const arm = ARM();
  expect(liveArmedAsk(arm, { thrown: null, parked: true, awaitsHumanGate: true })).toEqual({
    ...arm,
    parkRecorded: true,
  });
});

it("hands it the arm whose park write FAILED too — the gate is open all the same", () => {
  // The regression (PR #205 review): keyed on the park row, this settlement left NO arm, so a kill
  // arriving in the cleanup skipped the reconcile entirely — the run cancelled while its gate kept
  // blocking the target, advertising a resume for a job that is never coming back.
  const arm = ARM();
  expect(liveArmedAsk(arm, { thrown: null, parked: false, awaitsHumanGate: true })).toEqual({
    ...arm,
    parkRecorded: false,
  });
});

it("hands it nothing once the settle's own unwind has taken the wait back", () => {
  // Already reconciled one await earlier: the gate is undone or named as stranded, and taking it
  // back twice would send the operator after an id that no longer exists.
  expect(liveArmedAsk(ARM(), { thrown: null, parked: false, awaitsHumanGate: false })).toBeUndefined();
});

// ── the kill that lands in the CLEANUP, after the park landed (PR #205 review) ──

it("leaves a standing park alone while the run has not been cancelled", async () => {
  // The ordinary end of a needs-human run: the cleanup ran, nothing killed it, and the park behind
  // the live gate IS the verdict. Reconciling here would tear down a wait a person is expected to
  // answer — so it must write nothing at all.
  const row = recorder();

  const reconciled = await reconcileCancelledArmedPark({
    targetId: "f-1",
    ask: ASK_ERROR(),
    raw: ASK_ERROR(),
    gate: { gateId: "g-new", held: [], undo: async () => true },
    signal: new AbortController().signal,
    now: () => 42,
    settle: row.settle,
  });

  expect(reconciled).toBeUndefined();
  expect(row.patches).toEqual([]);
});

it("takes the arm back when the kill lands in the cleanup AFTER the park was recorded", async () => {
  // The window every check inside the arm and the settle still misses: releasing the lease and
  // syncing the board are uninterruptible awaits that run after the last signal read, and a board
  // sync is seconds of network. Without this the stopped run leaves its gate blocking a target no
  // resume is coming for, and a row that reads as patiently parked.
  const controller = new AbortController();
  controller.abort();
  const row = recorder();
  let undone = false;

  const reconciled = await reconcileCancelledArmedPark({
    targetId: "f-1",
    ask: ASK_ERROR(),
    raw: ASK_ERROR(),
    gate: {
      gateId: "g-new",
      held: [],
      undo: async () => {
        undone = true;
        return true;
      },
    },
    signal: controller.signal,
    now: () => 42,
    settle: row.settle,
  });

  expect(undone).toBe(true);
  expect(row.patches).toEqual([
    { status: "failed", error: expect.stringContaining("armed NO gate"), endedAt: 42 },
  ]);
  // The resolve is a LOCAL board write, so the caller is told about it: nothing else knows there is
  // a gate undo still to publish (PR #205 review).
  expect(reconciled?.undone).toBe(true);
  // Nothing on the board carries the ask any more, so nothing sends the operator to a resolve.
  expect((reconciled?.thrown as Error).message).toContain("armed NO gate");
  expect((reconciled?.thrown as Error).message).not.toContain("bd gate resolve g-new");
});

it("does not claim a park was recorded when the park write had failed", async () => {
  // Same unwind, different window: this run never got its wait into the row, so the stranded-gate
  // message must not tell the operator it did (PR #205 review).
  const controller = new AbortController();
  controller.abort();
  const row = recorder();

  const reconciled = await reconcileCancelledArmedPark({
    targetId: "f-1",
    ask: ASK_ERROR(),
    raw: ASK_ERROR(),
    gate: { gateId: "g-new", held: [] }, // no undo — the message names the window it stranded in
    signal: controller.signal,
    parkRecorded: false,
    now: () => 42,
    settle: row.settle,
  });

  expect((reconciled?.thrown as Error).message).toContain("its park could not be recorded");
  expect((reconciled?.thrown as Error).message).toContain("bd gate resolve g-new");
});

it("names the gate that STANDS when undoing after the cleanup kill is unsafe", async () => {
  // No `undo` — the arm superseded an older wait behind this gate, so resolving it would leave the
  // target with none at all. The id has to reach the operator; nothing else on the board names it.
  const controller = new AbortController();
  controller.abort();
  const row = recorder();

  const reconciled = await reconcileCancelledArmedPark({
    targetId: "f-1",
    ask: ASK_ERROR(),
    raw: ASK_ERROR(),
    gate: { gateId: "g-new", held: [] },
    signal: controller.signal,
    now: () => 42,
    settle: row.settle,
  });

  expect(row.patches.map((p) => p.status)).toEqual(["failed"]);
  expect(String(row.patches[0].error)).toContain("bd gate resolve g-new");
  expect((reconciled?.thrown as Error).name).toBe("PoisonError"); // no retry can answer an ask
  expect((reconciled?.thrown as Error).message).toContain("re-run the target");
  // Nothing was taken back, so there is no local-only undo for the caller to publish.
  expect(reconciled?.undone).toBe(false);
});

it("keeps the cancelled verdict when the corrective write fails after the cleanup kill", async () => {
  // The row may still read as parked, so the error is the only accurate account of the board: the
  // gate is gone, and sending the operator to resolve it would leave them waiting on an id that no
  // longer exists.
  const controller = new AbortController();
  controller.abort();
  const row = recorder("SQLITE_BUSY: database is locked");

  const reconciled = await reconcileCancelledArmedPark({
    targetId: "f-1",
    ask: ASK_ERROR(),
    raw: ASK_ERROR(),
    gate: { gateId: "g-new", held: [], undo: async () => true },
    signal: controller.signal,
    now: () => 42,
    settle: row.settle,
  });

  expect((reconciled?.thrown as Error).name).toBe("PoisonError");
  expect((reconciled?.thrown as Error).message).toContain("armed NO gate");
  expect((reconciled?.thrown as Error).message).toContain("database is locked");
  expect((reconciled?.thrown as Error).message).not.toContain("bd gate resolve g-new");
});


// ── what the cleanup's kill window still owes: the checkout, and the push (PR #205 review) ──

/** The three effects `concludeCancelledArmedPark` drives, recorded. */
const conclusion = (opts: {
  reconciled?: { thrown: unknown; undone: boolean };
  pushed?: boolean;
  kept?: boolean;
}) => {
  const effects = { released: false, queued: 0 };
  return {
    effects,
    args: {
      gateId: "g-new",
      reconcile: async () => opts.reconciled,
      releaseKeptWorktree: opts.kept
        ? async () => {
            effects.released = true;
          }
        : undefined,
      push: async () => opts.pushed ?? true,
      queuePush: () => {
        effects.queued += 1;
      },
    },
  };
};

it("leaves the checkout and the board alone when the run was not cancelled after all", async () => {
  // The ordinary end of a needs-human run: the park stands, a person is expected to answer it, and
  // the checkout is the resume's. Touching either here would tear down a live wait.
  const c = conclusion({ reconciled: undefined, kept: true });

  await expect(concludeCancelledArmedPark(c.args)).resolves.toBeUndefined();
  expect(c.effects).toEqual({ released: false, queued: 0 });
});

it("hands back the checkout the park kept once the cleanup kill unseats that park", async () => {
  // The teardown kept this tree because the run WAS parked behind a live gate; the reconcile just
  // turned that into a failed run nothing resumes. Nothing else reclaims it — the scheduled reaper
  // keeps every checkout whose bead is still open — so the cancelled run's partial edits would sit
  // there for the next run on the branch to inherit.
  const cancelled = new Error("cancelled");
  const c = conclusion({ reconciled: { thrown: cancelled, undone: true }, kept: true });

  await expect(concludeCancelledArmedPark(c.args)).resolves.toEqual({ thrown: cancelled });
  expect(c.effects).toEqual({ released: true, queued: 0 });
});

it("names the unpublished undo and queues the durable push when the sync fails", async () => {
  // The undo lives only in this checkout's Dolt working set: every other machine still reads the
  // gate as OPEN on a target this run has failed, while the run's own error says it armed none.
  const c = conclusion({
    reconciled: { thrown: new Error("the run armed NO gate"), undone: true },
    pushed: false,
    kept: true,
  });

  const concluded = await concludeCancelledArmedPark(c.args);

  expect(c.effects).toEqual({ released: true, queued: 1 });
  expect((concluded?.thrown as Error).name).toBe("PoisonError");
  expect((concluded?.thrown as Error).message).toContain("the run armed NO gate");
  expect((concluded?.thrown as Error).message).toContain("g-new");
  expect((concluded?.thrown as Error).message).toContain("sync-push");
});

it("keeps a STRANDED gate's verdict when the sync fails — the board already agrees with it", async () => {
  // Undoing was unsafe, so the gate is open here and open everywhere else; the verdict already
  // sends the operator to resolve it by hand. Restating it as unpublished would invent a
  // disagreement, but the push is still owed — the row and lease writes ride on it.
  const stranded = new Error("bd gate resolve g-new");
  const c = conclusion({ reconciled: { thrown: stranded, undone: false }, pushed: false });

  await expect(concludeCancelledArmedPark(c.args)).resolves.toEqual({ thrown: stranded });
  expect(c.effects).toEqual({ released: false, queued: 1 });
});

/**
 * A kill that lands BETWEEN two ticket arms (PR #213 review). 0b-pre arms one human gate per human
 * ticket, and `armHumanGate` unwinds only the gate it was arming when the signal flipped — the waits
 * earlier iterations already returned survive it, blocking their tickets for a run nothing comes
 * back for, each promising that resolving it resumes that run.
 */
describe("undoCancelledTicketGates — the arms a cancelled preflight pass already made", () => {
  /** One armed ticket gate, produced by the real arm so its undo rights are the real ones. */
  const armOne = async (gateId: string) => {
    loadAllIssuesMock.mockResolvedValue([target()]);
    gateCreateMock.mockResolvedValue(gateId);
    const gate = await armHumanGate(REPO, "f-1", ASKED);
    gateResolveMock.mockClear();
    return { ticketId: TICKET, gate };
  };

  const cancelled = () => {
    const c = new AbortController();
    c.abort();
    return c.signal;
  };

  it("resolves them, and settles under the error the cancelled arm already threw", async () => {
    const armed = await armOne("g-first");
    const cause = new Error("refusing to arm t-2's human gate — the run was cancelled");

    await expect(undoCancelledTicketGates([armed], cancelled(), cause)).resolves.toBe(cause);
    expect(gateResolveMock).toHaveBeenCalledWith(
      REPO,
      "g-first",
      expect.stringContaining("cancelled"),
    );
  });

  it("leaves them where they are when the pass failed for any other reason", async () => {
    // A locked DB or a rejected create is a RESUMABLE failure: the run comes back, and 0b-pre reuses
    // this very wait rather than arming a second one. Undoing here would take back a live ask.
    const armed = await armOne("g-first");

    const cause = new Error("database is locked");
    await expect(
      undoCancelledTicketGates([armed], new AbortController().signal, cause),
    ).resolves.toBe(cause);
    expect(gateResolveMock).not.toHaveBeenCalled();
  });

  it("names every wait it could not take back — nothing else on the board points at them", async () => {
    // Two ways an undo is unavailable: the resolve fails, and an arm that spent its undo retiring an
    // older wait (taking the replacement back would leave the ticket bare). Both stay open and only
    // this error carries their ids.
    const armed = await armOne("g-first");
    gateResolveMock.mockRejectedValue(new Error("database is locked"));

    const thrown = (await undoCancelledTicketGates(
      [armed, { ticketId: "t-2", gate: { gateId: "g-superseding", held: [] } }],
      cancelled(),
      new Error("the run was cancelled"),
    )) as Error;

    expect(thrown.message).toContain("the run was cancelled");
    expect(thrown.message).toContain(`g-first (${TICKET})`);
    expect(thrown.message).toContain("g-superseding (t-2)");
  });
});

// ── the human tickets' half of preflight (anton-mv70, PR #213 review) ──

describe("armHumanTicketGates — closing what a person answered, arming what they have not", () => {
  /** A human ticket, optionally blocked by the given beads. */
  const ticket = (id: string, title: string, ...blockedBy: string[]): Bead =>
    ({
      id,
      title,
      status: "open",
      issue_type: "task",
      labels: [LABELS.agentHuman],
      dependencies: blockedBy.map((b) => ({ issue_id: id, depends_on_id: b, type: "blocks" })),
    }) as Bead;

  /** The gate a person ANSWERED for that ticket: anton's own, closed, carrying that exact ask. */
  const answered = (id: string, t: Bead): Gate =>
    ({
      ...gate(id, humanGateReason(t.id, { ticketId: t.id, ask: humanTicketAsk(t) })),
      status: "closed",
    }) as Gate;

  it("closes a ticket whose only remaining blocker this same pass just closed", async () => {
    // Two answered human tickets in a row ("sign the contract, then wire the account"). The board
    // was read BEFORE the pass, so the prerequisite still reads as open to the ticket that waits on
    // it — held there, the run parks on a blocker the next board read shows closed, and no event
    // remains that would ever resume it.
    const first = ticket("t-sign", "Sign the order form", "g-sign");
    const second = ticket("t-wire", "Wire the live key", "g-wire", "t-sign");
    const board = [first, second, answered("g-sign", first), answered("g-wire", second)];

    // Listed dependent-first, to prove the pass walks them in dependency order.
    const held = await armHumanTicketGates(REPO, "f-1", board, [second, first], undefined);

    expect(held.size).toBe(0);
    expect(closeMock.mock.calls.map((c) => c[1])).toEqual(["t-sign", "t-wire"]);
    expect(gateCreateMock).not.toHaveBeenCalled();
  });

  it("still holds a ticket whose ORDINARY prerequisite has not landed", async () => {
    // The in-pass closes must not over-reach: work no one did is still a blocker, and the ticket is
    // held (never re-asked) until the resume that follows it.
    const human = ticket("t-sign", "Sign the DPA", "g-sign", "t-api");
    const board = [
      human,
      { id: "t-api", title: "Ship the API", status: "open", issue_type: "task" } as Bead,
      answered("g-sign", human),
    ];

    const held = await armHumanTicketGates(REPO, "f-1", board, [human], undefined);

    expect([...held]).toEqual([["t-sign", ["t-api"]]]);
    expect(closeMock).not.toHaveBeenCalled();
  });

  it("takes back every wait when the kill lands after the LAST arm, which no iteration observes", async () => {
    // The loop exits normally here — the signal flipped between two board writes, not inside one —
    // so nothing in `armHumanGate` unwinds. Left standing, the gate blocks its ticket for a run that
    // is not coming back, promising a person that resolving it resumes that run.
    const armIt = ticket("t-buy", "Buy the Business plan");
    const doneAlready = ticket("t-sign", "Sign the order form", "g-sign");
    const board = [armIt, doneAlready, answered("g-sign", doneAlready)];
    loadAllIssuesMock.mockResolvedValue([target()]);
    gateCreateMock.mockResolvedValue("g-buy");
    const controller = new AbortController();
    closeMock.mockImplementation(async () => controller.abort()); // the kill lands AFTER the arm

    await expect(
      armHumanTicketGates(REPO, "f-1", board, [armIt, doneAlready], controller.signal),
    ).rejects.toThrow(/cancelled after its human ticket gate\(s\) were armed/);
    expect(gateResolveMock).toHaveBeenCalledWith(
      REPO,
      "g-buy",
      expect.stringContaining("cancelled"),
    );
  });

  it("arms every unanswered ticket and reports nothing held while the run is live", async () => {
    const one = ticket("t-buy", "Buy the Business plan");
    const two = ticket("t-sign", "Sign the order form");
    loadAllIssuesMock.mockResolvedValue([target()]);
    gateCreateMock.mockResolvedValueOnce("g-buy").mockResolvedValueOnce("g-sign");

    const held = await armHumanTicketGates(REPO, "f-1", [one, two], [one, two], undefined);

    expect(held.size).toBe(0);
    expect(gateCreateMock).toHaveBeenCalledTimes(2);
    expect(gateResolveMock).not.toHaveBeenCalled();
  });
});

describe("preflightHumanTickets — classifying again after the arm's own board refresh", () => {
  /** A ticket under f-1, human only while it carries the label. */
  const child = (id: string, human: boolean, ...blockedBy: string[]): Bead =>
    ({
      id,
      title: id,
      status: "open",
      issue_type: "task",
      parent: "f-1",
      labels: human ? [LABELS.agentHuman] : [],
      dependencies: blockedBy.map((b) => ({ issue_id: id, depends_on_id: b, type: "blocks" })),
    }) as Bead;

  /** The gate a person ANSWERED for that ticket: anton's own, closed, carrying that exact ask. */
  const answeredGate = (id: string, t: Bead): Gate =>
    ({
      ...gate(id, humanGateReason(t.id, { ticketId: t.id, ask: humanTicketAsk(t) })),
      status: "closed",
    }) as Gate;

  /** The shared board every read sees — reassigned to model another machine writing to it. */
  let board: Bead[] = [];

  const preflight = (children: Bead[]) =>
    preflightHumanTickets({
      repo: REPO,
      targetId: "f-1",
      board,
      target: target(),
      children,
      standaloneRun: false,
      isResumeSkipped: (t: Bead) => t.status === "closed",
      signal: undefined,
    });

  beforeEach(() => {
    loadAllIssuesMock.mockImplementation(async () => board);
    gateCreateMock.mockImplementation(async () => `g-${gateCreateMock.mock.calls.length}`);
  });

  it("arms a sibling another machine relabelled while the first arm was in flight", async () => {
    // The relabel lands inside `armHumanGate`'s own pull, so the refresh below ADOPTS it — but
    // readiness never asks about the label. Classified only once, this ticket stays dispatchable
    // and the run reaches the dispatch loop's backstop naming a wait nobody ever armed.
    const human = child("t-buy", true);
    const ordinary = child("t-ship", false);
    board = [target(), human, ordinary];
    gateCreateMock.mockImplementationOnce(async () => {
      board = [target(), human, child("t-ship", true)];
      return "g-buy";
    });

    const out = await preflight([human, ordinary]);

    expect(out.armed).toBe(true);
    expect(gateCreateMock).toHaveBeenCalledTimes(2);
    expect(out.tickets.map((t) => t.id)).toEqual(["t-buy", "t-ship"]);
    expect(out.tickets.every((t) => t.labels?.includes(LABELS.agentHuman))).toBe(true);
  });

  it("arms an unchanged ticket exactly once — the confirming pass finds nothing new", async () => {
    const human = child("t-buy", true);
    board = [target(), human];

    const out = await preflight([human]);

    expect(gateCreateMock).toHaveBeenCalledTimes(1);
    expect(out.answeredButBlocked.size).toBe(0);
    expect(out.tickets.map((t) => t.id)).toEqual(["t-buy"]);
  });

  it("touches nothing at all when no ticket is a person's work", async () => {
    board = [target(), child("t-ship", false)];

    const out = await preflight([child("t-ship", false)]);

    expect(out.armed).toBe(false);
    expect(out.board).toBe(board);
    expect(loadAllIssuesMock).not.toHaveBeenCalled();
    expect(gateCreateMock).not.toHaveBeenCalled();
  });

  it("keeps a hold an earlier pass reported when a later pass arms a newcomer", async () => {
    // The held ticket is the run's verdict, not this pass's bookkeeping: dropped when the second
    // pass overwrites the first's answer, the dispatch loop reaches it as open human work and parks
    // on the backstop instead of holding it by the ordinary blocked-child rule.
    const signed = child("t-sign", true, "g-sign", "t-api");
    const buy = child("t-buy", true);
    const ship = child("t-ship", false);
    const api = child("t-api", false);
    board = [target(), signed, buy, ship, api, answeredGate("g-sign", signed)];
    gateCreateMock.mockImplementationOnce(async () => {
      board = [target(), signed, buy, child("t-ship", true), api, answeredGate("g-sign", signed)];
      return "g-buy";
    });

    const out = await preflight([signed, buy, ship, api]);

    expect([...out.answeredButBlocked]).toEqual([["t-sign", ["t-api"]]]);
    expect(gateCreateMock).toHaveBeenCalledTimes(2); // t-buy, then the relabelled t-ship
  });

  it("takes back an EARLIER pass's wait when the kill lands in a later one", async () => {
    // Multi-pass arming must keep the invariant a single pass already had: a gate left standing for
    // a cancelled run promises a person that resolving it resumes a run nothing is coming back for.
    const human = child("t-buy", true);
    board = [target(), human, child("t-ship", false)];
    const controller = new AbortController();
    gateCreateMock
      .mockImplementationOnce(async () => {
        board = [target(), human, child("t-ship", true)];
        return "g-buy";
      })
      .mockImplementationOnce(async () => {
        controller.abort(); // the kill lands inside the SECOND pass's arm
        return "g-ship";
      });

    await expect(
      preflightHumanTickets({
        repo: REPO,
        targetId: "f-1",
        board,
        target: target(),
        children: [human, child("t-ship", false)],
        standaloneRun: false,
        isResumeSkipped: (t: Bead) => t.status === "closed",
        signal: controller.signal,
      }),
    ).rejects.toThrow();
    expect(gateResolveMock.mock.calls.map((c) => c[1])).toContain("g-buy");
  });

  it("hands the run back rather than arming behind labels that keep moving", async () => {
    // Each arm relabels another sibling `agent:human`, so no pass ever confirms a settled board. A
    // plain Error, not a park: the next attempt re-gates from a board that has stopped moving,
    // which no loop here can wait out. The ticket SET never changes — that is the drift check's
    // question, and answering it here too would hide the one this bound exists for.
    const ids = Array.from({ length: MAX_HUMAN_TICKET_PASSES + 1 }, (_, i) => `t-${i}`);
    const humanThrough = (n: number) => [target(), ...ids.map((id, i) => child(id, i <= n))];
    board = humanThrough(0);
    gateCreateMock.mockImplementation(async () => {
      const n = gateCreateMock.mock.calls.length;
      board = humanThrough(n);
      return `g-${n}`;
    });

    await expect(preflight(ids.map((id, i) => child(id, i === 0)))).rejects.toThrow(
      new RegExp(`kept finding newly-labelled ${LABELS.agentHuman} tickets after ` +
        `${MAX_HUMAN_TICKET_PASSES} arming passes`),
    );
    expect(gateCreateMock).toHaveBeenCalledTimes(MAX_HUMAN_TICKET_PASSES);
  });

  it("hands the run back when a child is ATTACHED while its human tickets are gated", async () => {
    // The refresh below would otherwise replace the set step 1c confirmed under the run-lease, and
    // the newcomer would ride into this run behind the approval, contract and agent-allowlist gates
    // that already ran on the old set.
    const human = child("t-buy", true);
    const ship = child("t-ship", false);
    board = [target(), human, ship];
    gateCreateMock.mockImplementationOnce(async () => {
      board = [target(), human, ship, child("t-new", false)];
      return "g-buy";
    });

    await expect(preflight([human, ship])).rejects.toThrow(
      /ticket set changed while its human tickets were gated \(attached t-new\)/,
    );
  });

  it("closes a held ticket whose ordinary blocker landed while the arm was writing", async () => {
    // The hold was judged against the PRE-arm board, and every arm pulls the shared board — so a
    // prerequisite that closes in that window leaves the caller parking the run behind a bead that
    // is already closed, with no blocker event left to resume it.
    const signed = child("t-sign", true, "g-sign", "t-api");
    const buy = child("t-buy", true);
    const api = child("t-api", false);
    board = [target(), signed, buy, api, answeredGate("g-sign", signed)];
    gateCreateMock.mockImplementationOnce(async () => {
      board = [
        target(),
        signed,
        buy,
        { ...api, status: "closed" } as Bead,
        answeredGate("g-sign", signed),
      ];
      return "g-buy";
    });

    const out = await preflight([signed, buy, api]);

    expect(out.answeredButBlocked.size).toBe(0);
    expect(closeMock).toHaveBeenCalledWith(REPO, "t-sign", expect.stringContaining("g-sign"));
  });

  it("retires the wait it armed when an operator drops the label mid-arm", async () => {
    // Nothing auto-resolves a human gate, so a ticket reclassified while its own arm was in flight
    // stays blocked by an ask that no longer applies — and the run parks asking a person to do work
    // the operator just handed back to an agent.
    const buy = child("t-buy", true);
    const sign = child("t-sign", true);
    board = [target(), buy, sign];
    gateCreateMock
      .mockImplementationOnce(async () => "g-buy")
      .mockImplementationOnce(async () => {
        board = [target(), buy, child("t-sign", false)];
        return "g-sign";
      });

    const out = await preflight([buy, sign]);

    expect(gateResolveMock).toHaveBeenCalledWith(
      REPO,
      "g-sign",
      expect.stringContaining(`no longer labelled ${LABELS.agentHuman}`),
    );
    // Retired, not answered: the marker goes with the wait, so a later pass cannot read this close
    // as a person having done work the operator just handed back to an agent (PR #213 review).
    expect(untagMock).toHaveBeenCalledWith(REPO, "g-sign", [HUMAN_GATE_ARMED_LABEL]);
    expect(gateCreateMock).toHaveBeenCalledTimes(2); // never re-armed on the pass that retired it
    expect(out.answeredButBlocked.size).toBe(0);
  });
});


// ── what a CLOSED human gate means: answered, or taken back (PR #213 review) ──

/**
 * A gate anton resolves itself — a cancelled arm, an ask the operator relabelled away, a wait a
 * newer ask supersedes — must not read as a person's answer on the next run. Nothing on a closed
 * gate records who ended it, so the armed label is the marker, and every retire strips it.
 */
describe("retiring anton's own human gate — a close it made is not an answer", () => {
  const cancelled = () => {
    const c = new AbortController();
    c.abort();
    return c.signal;
  };

  /** One armed ticket gate, produced by the real arm so its undo rights are the real ones. */
  const armOne = async (gateId: string) => {
    loadAllIssuesMock.mockResolvedValue([target()]);
    gateCreateMock.mockResolvedValue(gateId);
    const armed = { ticketId: TICKET, gate: await armHumanGate(REPO, "f-1", ASKED) };
    gateResolveMock.mockClear();
    untagMock.mockClear();
    return armed;
  };

  /** A human ticket held by its own gate. */
  const humanTicket = (id: string, title: string, gateId: string): Bead =>
    ({
      id,
      title,
      status: "open",
      issue_type: "task",
      labels: [LABELS.agentHuman],
      dependencies: [{ issue_id: id, depends_on_id: gateId, type: "blocks" }],
    }) as Bead;

  /** The gate that carried that ticket's ask, now closed — labelled as anton armed it or not. */
  const closedGate = (id: string, t: Bead, labels: string[]): Gate =>
    ({
      ...gate(id, humanGateReason(t.id, { ticketId: t.id, ask: humanTicketAsk(t) }), labels),
      status: "closed",
    }) as Gate;

  it("strips the armed label BEFORE it resolves, so no close it made can read as an answer", async () => {
    const armed = await armOne("g-first");

    await undoCancelledTicketGates([armed], cancelled(), new Error("the run was cancelled"));

    expect(untagMock).toHaveBeenCalledWith(REPO, "g-first", [HUMAN_GATE_ARMED_LABEL]);
    expect(untagMock.mock.invocationCallOrder[0]).toBeLessThan(
      gateResolveMock.mock.invocationCallOrder[0],
    );
  });

  it("leaves the wait STANDING when the marker cannot be stripped", async () => {
    // Resolving anyway would close the gate with the marker intact — a false answer no later run can
    // tell from a real one. A still-open wait, named in the error, is the recoverable failure.
    const armed = await armOne("g-first");
    untagMock.mockRejectedValue(new Error("bd: database is locked"));

    const thrown = (await undoCancelledTicketGates(
      [armed],
      cancelled(),
      new Error("the run was cancelled"),
    )) as Error;

    expect(gateResolveMock).not.toHaveBeenCalled();
    expect(thrown.message).toContain(`g-first (${TICKET})`);
  });

  it("puts the marker BACK when the resolve fails and the wait is still standing", async () => {
    // The gate keeps its ask, and a ticket ask tells the person to do the work and resolve it. An
    // unlabelled leftover would make that answer invisible: the next run re-asks for work already
    // done. Restored, the answer reads as one (PR #213 review).
    const armed = await armOne("g-first");
    tagMock.mockClear();
    gateResolveMock.mockRejectedValue(new Error("bd: database is locked"));

    const thrown = (await undoCancelledTicketGates(
      [armed],
      cancelled(),
      new Error("the run was cancelled"),
    )) as Error;

    expect(tagMock).toHaveBeenCalledWith(REPO, "g-first", [HUMAN_GATE_ARMED_LABEL]);
    expect(untagMock.mock.invocationCallOrder[0]).toBeLessThan(
      tagMock.mock.invocationCallOrder[0],
    );
    expect(thrown.message).toContain(`g-first (${TICKET})`);
  });

  it("leaves the marker OFF when the resolve actually landed and only its reporting failed", async () => {
    // Relabelling a gate anton closed is exactly the false answer the untag-first order exists to
    // prevent, so the restore is conditioned on the gate still being open.
    const armed = await armOne("g-first");
    tagMock.mockClear();
    gateResolveMock.mockRejectedValue(new Error("bd: connection reset"));
    showMock.mockImplementation(async (_repo: string, id: string) => ({
      ...gate(id, REASON, []),
      status: "closed",
    }));

    await undoCancelledTicketGates([armed], cancelled(), new Error("the run was cancelled"));

    expect(tagMock).not.toHaveBeenCalled();
  });

  it("asks again for a ticket whose gate anton took back, rather than closing it", async () => {
    // The failure this closes: cleanup resolved the gate but left the ticket human and its ask
    // intact. Read as an answer, the next run closes a still-human ticket without executing it and
    // without anyone doing the work. With the marker gone there is no answer, so the ask is re-armed
    // — which is the state the board is actually in.
    const buy = humanTicket("t-buy", "Buy the Business plan", "g-buy");
    loadAllIssuesMock.mockResolvedValue([target()]);
    gateCreateMock.mockResolvedValue("g-buy-2");

    const held = await armHumanTicketGates(
      REPO,
      "f-1",
      [buy, closedGate("g-buy", buy, [])],
      [buy],
      undefined,
    );

    expect(held.size).toBe(0);
    expect(closeMock).not.toHaveBeenCalled();
    expect(gateCreateMock).toHaveBeenCalledTimes(1);
  });

  it("still closes a ticket whose gate a PERSON resolved — the marker survives their answer", async () => {
    // The other half of the same contract: nothing untags a gate a human ran `bd gate resolve` on,
    // so the answer still lands and the exchange the label exists for keeps working.
    const buy = humanTicket("t-buy", "Buy the Business plan", "g-buy");

    const held = await armHumanTicketGates(
      REPO,
      "f-1",
      [buy, closedGate("g-buy", buy, [HUMAN_GATE_ARMED_LABEL])],
      [buy],
      undefined,
    );

    expect(held.size).toBe(0);
    expect(closeMock).toHaveBeenCalledWith(REPO, "t-buy", expect.stringContaining("g-buy"));
    expect(gateCreateMock).not.toHaveBeenCalled();
  });
});
