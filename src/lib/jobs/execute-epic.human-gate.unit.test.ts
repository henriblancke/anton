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
 * The last section is the SETTLE that follows a successful arm — the one place left where the gate
 * and the run row can still tell different stories: the row write can fail outright, and a kill can
 * land inside it after every check in the arm has passed.
 *
 * Mocked at the bd seam, because the states under test are bd calls that fail: the end-to-end shapes
 * of the arm live in execute-epic.needs-human.integration.test.ts against real bd.
 */
import { beforeEach, expect, it, vi } from "vitest";
import type { Bead, Gate } from "../beads/bd";

const loadAllIssuesMock = vi.fn();
const gateCreateMock = vi.fn();
const gateResolveMock = vi.fn();
const tagMock = vi.fn();
const pullMock = vi.fn();

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
      pull: (...args: unknown[]) => pullMock(...args),
    },
  };
});

const {
  armHumanGate,
  HUMAN_GATE_ARMED_LABEL,
  NeedsHumanError,
  settleArmedAsk,
  StrandedHumanGateError,
} = await import("./execute-epic");

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
  pullMock.mockReset().mockResolvedValue(undefined);
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
  expect(order).toEqual(["pull", "read"]);
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
  const thrown = await settleArmedAsk({
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

  const thrown = await settleArmedAsk({
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

  const thrown = await settleArmedAsk({
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

  const thrown = await settleArmedAsk({
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

  const thrown = await settleArmedAsk({
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

  const thrown = await settleArmedAsk({
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

  const thrown = await settleArmedAsk({
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

  const thrown = await settleArmedAsk({
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

  const thrown = await settleArmedAsk({
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
