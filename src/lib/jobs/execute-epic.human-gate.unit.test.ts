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
 * Mocked at the bd seam, because the states under test are bd calls that fail: the end-to-end shapes
 * of the arm live in execute-epic.needs-human.integration.test.ts against real bd.
 */
import { beforeEach, expect, it, vi } from "vitest";
import type { Bead, Gate } from "../beads/bd";

const loadAllIssuesMock = vi.fn();
const gateCreateMock = vi.fn();
const gateResolveMock = vi.fn();
const tagMock = vi.fn();

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
    },
  };
});

const { armHumanGate, HUMAN_GATE_ARMED_LABEL, StrandedHumanGateError } = await import(
  "./execute-epic"
);

const REPO = "/tmp/anton";
const ASK = "the staging DB password has to be rotated by a person";

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
});

it("reads the board strictly, so a failed gate listing can never read as 'nothing armed'", async () => {
  loadAllIssuesMock.mockResolvedValue([]);
  gateCreateMock.mockResolvedValue("g-new");

  await expect(armHumanGate(REPO, "f-1", ASK)).resolves.toEqual({ gateId: "g-new", held: [] });
  expect(loadAllIssuesMock).toHaveBeenCalledWith(REPO, { strictGates: true });
});

it("refuses to arm on a board it could not read, rather than stacking a second wait on the same ask", async () => {
  loadAllIssuesMock.mockRejectedValue(new Error("bd: database is locked"));

  await expect(armHumanGate(REPO, "f-1", ASK)).rejects.toThrow("database is locked");
  expect(gateCreateMock).not.toHaveBeenCalled();
});

it("labels the gate it arms, so a later ask can tell its own leftover from a person's hold", async () => {
  loadAllIssuesMock.mockResolvedValue([target()]);
  gateCreateMock.mockResolvedValue("g-new");

  await armHumanGate(REPO, "f-1", ASK);
  expect(tagMock).toHaveBeenCalledWith(REPO, "g-new", [HUMAN_GATE_ARMED_LABEL]);
});

it("still parks on the gate when the label write is lost — the ask is already on the board", async () => {
  loadAllIssuesMock.mockResolvedValue([target()]);
  gateCreateMock.mockResolvedValue("g-new");
  tagMock.mockRejectedValue(new Error("bd: database is locked"));

  await expect(armHumanGate(REPO, "f-1", ASK)).resolves.toEqual({ gateId: "g-new", held: [] });
});

it("aborts when its own superseded gate cannot be resolved, instead of parking behind it", async () => {
  // The failure this guards: the stale gate blocks the target for good (nothing auto-resolves a
  // human gate), so resolving the gate the park NAMES would leave the run parked forever.
  loadAllIssuesMock.mockResolvedValue([target("g-old"), gate("g-old", "an older ask")]);
  gateResolveMock.mockRejectedValue(new Error("bd: database is locked"));

  await expect(armHumanGate(REPO, "f-1", ASK)).rejects.toThrow(/superseded human gate g-old/);
  expect(gateCreateMock).not.toHaveBeenCalled();
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

  await expect(armHumanGate(REPO, "f-1", ASK)).resolves.toEqual({
    gateId: "g-new",
    held: ["g-theirs"],
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

  await expect(armHumanGate(REPO, "f-1", ASK, controller.signal)).rejects.toThrow(/cancelled/);
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

  await expect(armHumanGate(REPO, "f-1", ASK, controller.signal)).rejects.toThrow(/cancelled/);
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

  await expect(armHumanGate(REPO, "f-1", ASK, controller.signal)).rejects.toThrow(/cancelled/);
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

  const failure = await armHumanGate(REPO, "f-1", ASK, controller.signal).catch((e) => e);
  expect(failure).toBeInstanceOf(StrandedHumanGateError);
  expect(failure.gateId).toBe("g-new");
  expect(failure.message).toContain("bd gate resolve g-new");
});

it("arms as usual while the run is still live", async () => {
  loadAllIssuesMock.mockResolvedValue([target()]);
  gateCreateMock.mockResolvedValue("g-new");

  const controller = new AbortController();
  await expect(armHumanGate(REPO, "f-1", ASK, controller.signal)).resolves.toEqual({
    gateId: "g-new",
    held: [],
  });
});

it("reports a person's hold beside a wait it REUSES, not only beside one it creates", async () => {
  loadAllIssuesMock.mockResolvedValue([
    target("g-mine", "g-theirs"),
    gate("g-mine", ASK),
    gate("g-theirs", "hold: talking to legal", []),
  ]);

  await expect(armHumanGate(REPO, "f-1", ASK)).resolves.toEqual({
    gateId: "g-mine",
    held: ["g-theirs"],
  });
  expect(gateCreateMock).not.toHaveBeenCalled();
});
