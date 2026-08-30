/**
 * The armed walk's CANCEL and PUBLISH contracts (anton-4ab3), over a stubbed board.
 *
 * Everything else about this walk is exercised through the real handler (jobs/gardener.test.ts
 * "gardener patrol · armed"). What needs a seam of its own is what a job runner cannot be asked to
 * produce on demand: an abort arriving mid-walk — specifically inside one of the two long reads that
 * precede an unattended write — and a push the shared remote refuses. Two things must hold about the
 * first, and each is a way the armed path could do quiet harm:
 *
 *   • THE CANCEL PROPAGATES. A walk that resolved normally would let the pass be recorded as one
 *     that finished (jobs/runner.ts) — and no later pass re-decides these proposals, because their
 *     fingerprints now suppress the re-file. The asks would sit open under a clean pass record.
 *   • NOTHING IS WRITTEN AFTER IT. The board write is the last step of an iteration whose awaits all
 *     precede it, so a cancel landing in one of them must stop the apply rather than be noticed
 *     after it.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Bead } from "../beads/bd";
import type { ArmedRecord } from "./armed";
import { makeDetection, type GardenerDetection } from "./detections";
import {
  emptyTrackRecord,
  resolveProposalAutonomyPolicy,
  type ProposalTrackRecord,
} from "./autonomy";
import { MAX_APPLIES_PER_PASS, type EmittedProposal } from "./emit";
import { passRecordCounts, readPassRecords } from "./record";

const pullMock = vi.fn<(cwd: string) => Promise<void>>();
/** The awaited publish: the only thing that can tell an unattended write from a stranded one. */
const pushMock = vi.fn<(cwd: string) => Promise<"synced" | "not-wired">>();
vi.mock("../beads/bd", async () => {
  const actual = await vi.importActual<typeof import("../beads/bd")>("../beads/bd");
  return {
    ...actual,
    beads: {
      ...actual.beads,
      pull: (...a: [string]) => pullMock(...a),
      push: (...a: [string]) => pushMock(...a),
    },
  };
});

const loadMock =
  vi.fn<(cwd: string, opts?: { strictGates?: boolean }) => Promise<Bead[]>>();
vi.mock("../beads/issues", () => ({
  loadAllIssues: (...a: [string, { strictGates?: boolean }?]) => loadMock(...a),
}));

/** The apply seam: the armed walk reimplements none of it, so the walk's own tests stub it whole. */
const applyMock =
  vi.fn<
    (
      repo: string,
      proposal: Bead,
      signal?: AbortSignal,
    ) => Promise<{ summary: string; changed: string[] }>
  >();
vi.mock("./apply", async () => {
  const actual = await vi.importActual<typeof import("./apply")>("./apply");
  return {
    ...actual,
    // The signal is forwarded, not dropped: apply's own cancel checkpoint is the only thing that
    // covers the awaits on ITS side of this seam (its write lock, and the re-read under it).
    applyProposal: (...a: [string, Bead, Bead[], string, AbortSignal | undefined]) =>
      applyMock(a[0], a[1], a[4]),
  };
});

const {
  applyArmedProposals,
  armedTargets,
  heldBackNote,
  movedTheBoard,
  outcomeOf,
  stopNote,
  stranding,
  summaryOf,
  unpublishedNote,
  verdictOf,
} = await import("./armed");
/** The real class — the mock above spreads the actual module, so `changed` behaves as it ships. */
const { ProposalApplyError } = await import("./apply");

const REPO = "/tmp/armed-repo";
/** Only `shipped-orphan` is armed, and it is the only kind these fixtures file. */
const policy = resolveProposalAutonomyPolicy({ "shipped-orphan": "apply" });

/**
 * A record that has EARNED `shipped-orphan` (anton-m29g). These fixtures are about the walk's cancel
 * and publish contracts, so the second gate is cleared here and exercised on its own in
 * autonomy.test.ts — a `retire`/`close` is the dearest tier, hence the full twenty.
 */
const record: ProposalTrackRecord = {
  ...emptyTrackRecord(),
  "shipped-orphan": { settled: 20, applied: 20 },
};

/** A shipped-orphan ask about one subject — the simplest armed move there is. */
function shippedOrphan(subject: string): GardenerDetection {
  return makeDetection({
    kind: "shipped-orphan",
    move: "retire",
    retireAs: "close",
    subjects: [subject],
    summary: `${subject} shipped in abc1234 and is still open`,
    evidence: [`${subject} names commit abc1234`],
  });
}

/** An ask of a kind this policy left at `propose` — what the armed selection must NOT take. */
function staleAsk(subject: string): GardenerDetection {
  return makeDetection({
    kind: "stale",
    move: "retire",
    retireAs: "defer",
    subjects: [subject],
    summary: `${subject} has not moved in 90 days`,
    evidence: [`${subject} last updated 90 days ago`],
  });
}

/** One outcome, as the walk records it — the shape the verdict and summary helpers read. */
const armedRecord = (
  over: Partial<ArmedRecord> & Pick<ArmedRecord, "proposal" | "outcome">,
): ArmedRecord => ({
  kind: "shipped-orphan",
  move: "retire",
  retireAs: "close",
  subjects: ["t-1"],
  detail: "closed the subject as shipped",
  changed: [],
  ...over,
});

/** What the pass filed, in the order it filed it — proposal `p-1` about `t-1`, and so on. */
const filed = (n: number): EmittedProposal[] =>
  Array.from({ length: n }, (_, i) => {
    const detection = shippedOrphan(`t-${i + 1}`);
    return { id: `p-${i + 1}`, fingerprint: detection.fingerprint, detection };
  });

const log = vi.fn<(chunk: string) => Promise<void>>();
const nudge = vi.fn();
/** Everything the pass recorded, as one string — the record a founder reads on the jobs page. */
const recorded = (): string => log.mock.calls.map(([chunk]) => chunk).join("");
/** The stops, which go to the console even when the log that would have carried them is broken. */
const consoleStops = (): string =>
  vi.mocked(console.error).mock.calls.map((args) => args.join(" ")).join("\n");
/** The walk's console line — the OTHER surface, and the one an operator greps after a 03:00 pass. */
const consoleSummary = (): string =>
  vi.mocked(console.log).mock.calls.map((args) => args.join(" ")).join("\n");

function walk(created: EmittedProposal[], signal: AbortSignal) {
  return applyArmedProposals({
    repo: REPO,
    created,
    policy,
    record,
    producer: "[gardener]",
    log,
    nudge,
    signal,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  // A record that will not take a write warns rather than throwing (armed.ts `write`).
  vi.spyOn(console, "warn").mockImplementation(() => {});
  log.mockResolvedValue(undefined);
  pullMock.mockResolvedValue(undefined);
  pushMock.mockResolvedValue("synced");
  // The board reads only ever reach the seam below, so the proposal just has to be findable.
  loadMock.mockImplementation(async () => filed(3).map(({ id }) => ({ id, title: id, status: "open" })));
  applyMock.mockImplementation(async (_repo, proposal) => ({
    summary: `closed the subject of ${proposal.id} as shipped`,
    changed: [proposal.id],
  }));
});

describe("armed walk · cancelled", () => {
  it("propagates a cancel that arrives before the first apply, rather than resolving clean", async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(walk(filed(2), controller.signal)).rejects.toThrow();
    // Not one board read, let alone a write: the pass is over before it starts.
    expect(applyMock).not.toHaveBeenCalled();
    expect(loadMock).not.toHaveBeenCalled();
  });

  it("names the armed asks a cancel caught between the creates and the walk", async () => {
    // The one window a caller cannot report for itself: emission SUCCEEDED, the abort landed, the
    // shadow returned early on it, and this walk is the first thing to see it. Throwing here without
    // a word would leave the proposals just filed neither applied nor named, while their own
    // fingerprints stop any later pass re-deciding them — so the ask an operator armed would sit
    // open under a pass record that never mentions it.
    const controller = new AbortController();
    controller.abort();

    await expect(walk(filed(2), controller.signal)).rejects.toThrow();

    expect(recorded()).toContain("APPLY stopped — the pass was cancelled");
    expect(recorded()).toContain("2 armed proposal(s) stay open as ordinary asks (p-1, p-2)");
    // Nothing was written, so there is nothing to publish: a walk that stopped before its first
    // apply must not push or count itself into the unpushed backlog.
    expect(nudge).not.toHaveBeenCalled();
    expect(pushMock).not.toHaveBeenCalled();
    expect(recorded()).not.toContain("APPLYING");
  });

  it("propagates a cancel that arrives INSIDE the pull, without applying the proposal it preceded", async () => {
    // The window the walk's own comment names: the pull is the longest await between the loop's
    // last check and the write it authorises. Cancelling during it used to be invisible until the
    // proposal had already been applied — an unattended write out of a stopped pass.
    const controller = new AbortController();
    pullMock.mockImplementation(async () => {
      controller.abort();
    });

    await expect(walk(filed(2), controller.signal)).rejects.toThrow();

    expect(applyMock).not.toHaveBeenCalled();
    // The cap is unspent: the check lands BEFORE the line that buys an attempt against it, so the
    // retry of this job inherits the whole cap rather than paying for a write never made.
    expect(recorded()).not.toContain("APPLYING");
    // And never silently — the asks that stay open are named, by count and by id.
    expect(recorded()).toContain("APPLY stopped — the pass was cancelled");
    expect(recorded()).toContain("2 armed proposal(s) stay open as ordinary asks (p-1, p-2)");
  });

  it("propagates a cancel that arrives INSIDE the board read, without applying the proposal it precedes", async () => {
    // The pull's twin, one await further in. `loadAllIssues` is a second bd call over the whole
    // board, and the loop's last check lands BEFORE it — so a cancel arriving here was invisible
    // until apply had already closed, deferred or reparented the subject.
    const controller = new AbortController();
    loadMock.mockImplementation(async () => {
      controller.abort();
      return filed(3).map(({ id }) => ({ id, title: id, status: "open" }) as Bead);
    });

    await expect(walk(filed(2), controller.signal)).rejects.toThrow();

    expect(applyMock).not.toHaveBeenCalled();
    // The attempt was bought before the read, so it is given its outcome rather than left as an
    // `APPLYING` line that sends a founder to the board to find out whether anything moved.
    expect(recorded()).toContain(
      "— COULD NOT APPLY: the pass was cancelled before the board was touched",
    );
    expect(recorded()).toContain("1 armed proposal(s) stay open as ordinary asks (p-2)");
    expect(passRecordCounts(readPassRecords(recorded()))).toMatchObject({
      unrecorded: 0,
      "apply-failed": 1,
    });
  });

  it("propagates a cancel apply saw under its own write lock, having written nothing", async () => {
    // The window on the far side of this seam: the walk's last check lands before `applyProposal`,
    // which then awaits the proposal's write lock and re-reads it under that lock. A cancel arriving
    // in either is invisible here — the walk would resolve as a pass that finished while the apply
    // it authorised moved the subject and closed the ask over it.
    const stopped = new Error("the runner stopped this job");
    const controller = new AbortController();
    applyMock.mockImplementation(async (_repo, _proposal, signal) => {
      controller.abort(stopped);
      signal?.throwIfAborted(); // apply's own checkpoint, before its first mutation (apply.ts)
      throw new Error("unreachable: apply must stop at its cancel checkpoint");
    });

    await expect(walk(filed(2), controller.signal)).rejects.toBe(stopped);

    // The signal REACHED apply — the checkpoint above is worth nothing if the walk keeps it.
    expect(applyMock).toHaveBeenCalledTimes(1);
    expect(applyMock).toHaveBeenCalledWith(
      REPO,
      expect.objectContaining({ id: "p-1" }),
      controller.signal,
    );
    expect(recorded()).toContain(
      "— COULD NOT APPLY: the pass was cancelled before the board was touched",
    );
    expect(recorded()).toContain("1 armed proposal(s) stay open as ordinary asks (p-2)");
    expect(passRecordCounts(readPassRecords(recorded()))).toMatchObject({
      unrecorded: 0,
      "apply-failed": 1,
    });
  });

  it("still reports an apply that FAILED while the cancel was landing beside it", async () => {
    // Why the cancel is told apart by the reason's identity and not by `signal.aborted`: a pass
    // stopped while an apply was breaking must still say what that apply did to the board. Filed as
    // "nothing was written", the move below — which LANDED — would vanish from the record.
    const stopped = new Error("the runner stopped this job");
    const controller = new AbortController();
    applyMock.mockImplementation(async () => {
      controller.abort(stopped);
      throw new ProposalApplyError(
        "unsettled",
        "applying p-1 could not be settled: the move LANDED (t-1) and was not rolled back",
        ["t-1"],
      );
    });

    await expect(walk(filed(2), controller.signal)).rejects.toBe(stopped);

    expect(recorded()).toContain("— APPLIED BUT NOT SETTLED:");
    expect(recorded()).toContain("the move LANDED (t-1)");
    expect(recorded()).toContain("1 armed proposal(s) stay open as ordinary asks (p-2)");
  });

  it("resolves an attempt the cancel caught between its reservation and its write", async () => {
    // The reservation buys the write before it is made, so a cancel landing inside that log write
    // leaves a bought attempt anton knows was never spent. It gets its outcome rather than standing
    // as an `APPLYING` line nobody can resolve — which reads as "the board is the only evidence"
    // and sends a founder looking for a move that never happened.
    const controller = new AbortController();
    log.mockImplementation(async (chunk) => {
      if (chunk.includes("APPLYING")) controller.abort();
    });

    await expect(walk(filed(2), controller.signal)).rejects.toThrow();

    expect(applyMock).not.toHaveBeenCalled();
    expect(recorded()).toContain(
      "— COULD NOT APPLY: the pass was cancelled before the board was touched",
    );
    expect(recorded()).toContain("1 armed proposal(s) stay open as ordinary asks (p-2)");
    // Superseded, not doubled: the record reads as one attempt with a known outcome.
    expect(passRecordCounts(readPassRecords(recorded()))).toMatchObject({
      unrecorded: 0,
      "apply-failed": 1,
    });
  });

  it("keeps the applies behind the cancel, and still publishes them", async () => {
    // A cancel is not a rollback. What the walk wrote before it is real board state, and an
    // unattended move no other machine can see is half a move.
    const controller = new AbortController();
    applyMock.mockImplementationOnce(async (_repo, proposal) => {
      controller.abort();
      return { summary: `closed the subject of ${proposal.id} as shipped`, changed: ["t-1"] };
    });

    await expect(walk(filed(3), controller.signal)).rejects.toThrow();

    expect(applyMock).toHaveBeenCalledTimes(1);
    expect(recorded()).toContain("— APPLIED: closed the subject of p-1 as shipped");
    expect(recorded()).toContain("2 armed proposal(s) stay open as ordinary asks (p-2, p-3)");
    expect(nudge).toHaveBeenCalledTimes(1);
  });

  it("propagates a cancel that lands after the LAST apply, which no next iteration would see", async () => {
    // The window on the far side of the walk: the final proposal cleared every checkpoint, so the
    // abort arrives with no iteration left to observe it. Resolving here would hand the runner a
    // handler that finished — and it settles a resolved handler as success even when its own
    // no-progress timer fired the abort (jobs/runner.ts), so a guillotined pass would be recorded as
    // done rather than retried.
    const stopped = new Error("the runner stopped this job");
    const controller = new AbortController();
    applyMock.mockImplementation(async (_repo, proposal) => {
      controller.abort(stopped);
      return { summary: `closed the subject of ${proposal.id} as shipped`, changed: ["t-1"] };
    });

    await expect(walk(filed(1), controller.signal)).rejects.toBe(stopped);

    // The apply is kept, published, and recorded: a cancel is not a rollback, and nothing is left
    // standing to name — the stop line carries no open asks because the walk had none left.
    expect(recorded()).toContain("— APPLIED: closed the subject of p-1 as shipped");
    expect(recorded()).toContain("APPLY stopped — the pass was cancelled");
    expect(recorded()).not.toContain("stay open as ordinary asks");
    expect(nudge).toHaveBeenCalledTimes(1);
    expect(passRecordCounts(readPassRecords(recorded()))).toMatchObject({ unrecorded: 0 });
  });

  it("propagates a cancel that arrives INSIDE the awaited publish", async () => {
    // The walk's last await, and the longest one after the final write: a cancel landing in the push
    // is invisible to every check that precedes it.
    const stopped = new Error("the runner stopped this job");
    const controller = new AbortController();
    pushMock.mockImplementation(async () => {
      controller.abort(stopped);
      return "synced";
    });

    await expect(walk(filed(1), controller.signal)).rejects.toBe(stopped);

    // Published before it propagates — the applies behind a cancel are still owed their push.
    expect(pushMock).toHaveBeenCalledTimes(1);
    expect(recorded()).toContain("— APPLIED: closed the subject of p-1 as shipped");
    expect(recorded()).toContain("APPLY stopped — the pass was cancelled");
  });

  it("throws the abort reason, so the runner records the pass as stopped rather than done", async () => {
    const reason = new Error("the runner stopped this job");
    const controller = new AbortController();
    pullMock.mockImplementation(async () => {
      controller.abort(reason);
    });

    await expect(walk(filed(1), controller.signal)).rejects.toBe(reason);
  });
});

/**
 * The pre-write read, and why it is the STRICT one (anton-ve2r).
 *
 * bd omits gate beads from every ordinary listing while carrying the `blocks` edge a gate puts on the
 * bead it gates, and a blocker absent from the list reads as still open everywhere (epic-graph.ts).
 * That fail-safe inverts here: an approved target's own `gh:pr` gate would read as a real blocker, a
 * `blocked` approval gap, and `degraded-approval` armed at `apply` would strip the label off sound
 * work with nobody watching. A board anton cannot see whole must refuse the apply, not authorise it.
 */
describe("armed walk · a board it cannot see whole", () => {
  const running = (): AbortSignal => new AbortController().signal;

  it("reads the gates with the board, so a gate it cannot see is never an unknown blocker", async () => {
    await walk(filed(1), running());

    expect(loadMock).toHaveBeenCalledWith(REPO, { strictGates: true });
  });

  it("leaves the ask open when the gate listing fails, rather than applying against a partial board", async () => {
    loadMock.mockRejectedValueOnce(new Error("bd list --type gate failed: database is locked"));

    const result = await walk(filed(2), running());

    // Nothing written for the proposal whose read failed — and the walk carries on to the next ask,
    // because a read that failed once is this proposal's outcome, not the pass's.
    expect(applyMock).toHaveBeenCalledTimes(1);
    expect(applyMock).toHaveBeenCalledWith(
      REPO,
      expect.objectContaining({ id: "p-2" }),
      expect.any(AbortSignal),
    );
    expect(result.records.map((r) => r.outcome)).toEqual(["error", "applied"]);
    expect(result.records[0]).toMatchObject({ changed: [] });
    expect(recorded()).toContain(
      "— COULD NOT APPLY: the board could not be read completely before applying",
    );
    expect(recorded()).toContain("database is locked");
  });
});

/**
 * The apply that LANDED and could not close its own ask (apply.ts `settleProposal`): the one failure
 * that is also a board write.
 *
 * Recorded as `COULD NOT APPLY` with no subjects, it would be the record's worst lie — that verdict
 * promises a board nothing landed on, and here the pass moved a bead unattended. Nothing corrects it
 * later, either: the proposal stays open, and an open proposal's fingerprint is exactly what stops a
 * later pass re-filing, and so re-deciding, the same claim.
 */
describe("armed walk · a move that could not be settled", () => {
  const running = (): AbortSignal => new AbortController().signal;

  /** apply's own answer when its steps landed and the proposal's own close did not. */
  const unsettled = (subject: string) =>
    new ProposalApplyError(
      "unsettled",
      `applying p-1 could not be settled: the move LANDED (${subject}) and was not rolled back`,
      [subject],
    );

  /**
   * The same failure over a board that ALREADY carried the move: `planApply` read it as settled, so
   * the settlement wrote nothing to any subject and `changed` is empty (apply.ts `settleUnwritten`).
   */
  const unsettledUnwritten = () =>
    new ProposalApplyError(
      "unsettled",
      "applying p-1 could not be settled: the board already carried the move, so nothing was " +
        "written, but the proposal itself could not be closed",
    );

  it("records the bead it moved, rather than a board nothing happened to", async () => {
    applyMock.mockRejectedValueOnce(unsettled("t-1"));

    const result = await walk(filed(2), running());

    expect(result.records[0]).toMatchObject({ outcome: "unsettled", changed: ["t-1"] });
    expect(recorded()).toContain("— APPLIED BUT NOT SETTLED: applying p-1 could not be settled");
    // Counted apart from a clean apply AND from a failed one: the board moved and the ask is open,
    // so a founder has something to do about it that neither of the other two asks of them.
    expect(passRecordCounts(readPassRecords(recorded()))).toMatchObject({
      unsettled: 1,
      applied: 1,
      "apply-failed": 0,
    });
  });

  it("still reports an open ask when the settlement wrote nothing at all", async () => {
    // Zero changed steps is NOT "nothing landed": another actor had already made the move, the board
    // carries it, and the proposal is still standing over it. Read off `changed` this would record as
    // `COULD NOT APPLY` — the Jobs page would say nothing landed instead of sending the operator to
    // settle the still-open ask, and no later pass re-decides it (its fingerprint suppresses the file).
    applyMock.mockRejectedValueOnce(unsettledUnwritten());

    const result = await walk(filed(1), running());

    expect(result.records[0]).toMatchObject({ outcome: "unsettled", changed: [] });
    expect(recorded()).toContain("— APPLIED BUT NOT SETTLED: applying p-1 could not be settled");
    expect(passRecordCounts(readPassRecords(recorded()))).toMatchObject({
      unsettled: 1,
      "apply-failed": 0,
    });
  });

  it("keeps applying what is behind it — one unlucky bead never freezes the armed path", async () => {
    applyMock.mockRejectedValueOnce(unsettled("t-1"));

    const result = await walk(filed(3), running());

    expect(applyMock).toHaveBeenCalledTimes(3);
    expect(result.records.map((r) => r.outcome)).toEqual(["unsettled", "applied", "applied"]);
    expect(result.deferred).toEqual([]);
  });

  it("names it among the writes stranded on this machine when the publish fails", async () => {
    // It IS a board write, so it owes the same correction as a settled one — a note naming only the
    // clean applies would leave this move reading as published to the shared board.
    applyMock.mockRejectedValueOnce(unsettled("t-1"));
    pushMock.mockRejectedValue(new Error("bd dolt push failed: conflict in issues"));

    await walk(filed(2), running());

    const notes = readPassRecords(recorded()).notes.join("\n");
    expect(notes).toContain("APPLY could not publish this pass's board writes");
    expect(notes).toContain("(p-1, p-2)");
  });
});

/**
 * The OTHER failure that is also a board write: a cluster re-parent whose rollback could not put
 * every step back (apply.ts `stepFailure`, apply-steps.ts `rollbackSteps`).
 *
 * `COULD NOT APPLY` promises a rolled-back board, so this earns a verdict of its own: the beads the
 * undo could not reach are readable only off `changed`, which the record line cannot carry, and a
 * reader that saw the failure alone would be told nothing landed over a board anton part-moved. The
 * same `changed` is what keeps the pass itself honest — it must not hand the next tier a snapshot the
 * surviving move already invalidated, nor leave that move out of the note naming what is stranded on
 * this machine.
 */
describe("armed walk · a rollback that could not finish", () => {
  const running = (): AbortSignal => new AbortController().signal;

  /** apply's answer when a later cluster member failed and an earlier one would not come back. */
  const halfRolledBack = (subject: string) =>
    new ProposalApplyError(
      "failed",
      `applying p-1 failed: bd reparent exploded — ROLLBACK INCOMPLETE: ${subject} could not be ` +
        `restored — a human has to settle it`,
      [subject],
    );

  it("records the bead the rollback left moved, under a verdict that does not promise an untouched board", async () => {
    applyMock.mockRejectedValueOnce(halfRolledBack("t-1"));

    const result = await walk(filed(2), running());

    expect(result.records[0]).toMatchObject({ outcome: "error", changed: ["t-1"] });
    expect(movedTheBoard(result.records[0])).toBe(true);
    expect(recorded()).toContain("— COULD NOT ROLL BACK: applying p-1 failed");
    expect(recorded()).toContain("ROLLBACK INCOMPLETE");
    // And the reader groups it apart from the apply that WAS rolled back: the Jobs page is the only
    // surface an unattended write is audited on, and "could not apply" reads there as "nothing
    // landed".
    expect(passRecordCounts(readPassRecords(recorded()))).toMatchObject({
      stranded: 1,
      "apply-failed": 0,
      applied: 1,
    });
  });

  it("names it among the writes stranded on this machine when the publish fails", async () => {
    applyMock.mockRejectedValueOnce(halfRolledBack("t-1"));
    pushMock.mockRejectedValue(new Error("bd dolt push failed: conflict in issues"));

    await walk(filed(2), running());

    const notes = readPassRecords(recorded()).notes.join("\n");
    expect(notes).toContain("APPLY could not publish this pass's board writes");
    expect(notes).toContain("(p-1, p-2)");
  });

  it("names it apart from a clean failure in the console summary, not under one 'could not' count", async () => {
    // The Jobs page already shows the two apart (`stranded` vs `apply-failed`); the console is the
    // other surface an unattended pass is audited on, and one clause for both tells the operator
    // grepping it at 03:00 that nothing landed over a board this pass part-moved.
    applyMock.mockRejectedValueOnce(halfRolledBack("t-1"));
    applyMock.mockRejectedValueOnce(
      new ProposalApplyError("failed", "applying p-2 failed: the writes were rolled back"),
    );

    await walk(filed(3), running());

    const summary = consoleSummary();
    expect(summary).toContain("could NOT roll back 1 proposal(s)");
    expect(summary).toContain("(p-1)");
    // And the rollback that DID finish keeps its own clause — the two never merge into "2 could
    // not be applied", which is the reading that loses the part-moved board.
    expect(summary).toContain("1 could not be applied");
    expect(summary).not.toContain("2 could not be applied");
  });

  it("still reports an untouched board when the rollback DID put everything back", async () => {
    // The ordinary half-applied cluster: nothing survives the undo, so nothing is owed a publish and
    // the next tier's snapshot is still good.
    applyMock.mockRejectedValueOnce(
      new ProposalApplyError(
        "failed",
        "applying p-1 failed: bd reparent exploded — the 1 write(s) already made were rolled " +
          "back, so the board is unchanged",
      ),
    );

    const result = await walk(filed(1), running());

    expect(result.records[0]).toMatchObject({ outcome: "error", changed: [] });
    expect(movedTheBoard(result.records[0])).toBe(false);
    expect(recorded()).toContain("— COULD NOT APPLY: applying p-1 failed");
    expect(passRecordCounts(readPassRecords(recorded()))).toMatchObject({
      stranded: 0,
      "apply-failed": 1,
    });
  });
});

/**
 * The other half of an UNATTENDED write: it is not made until another machine can see it.
 *
 * Two anton machines can each clear their pre-apply pull before either publishes — the bead locks
 * serialize inside one process only — so the loser's push can fail on a divergence Dolt cannot
 * merge. The fire-and-forget nudge every other anton write uses cannot report that, because a human
 * made those writes and is watching the request; here the record is the only witness there is.
 */
describe("armed walk · publish", () => {
  const running = (): AbortSignal => new AbortController().signal;

  it("says the moves it recorded are still on this machine when the publish fails", async () => {
    pushMock.mockRejectedValue(new Error("bd dolt push failed: conflict in issues"));

    const result = await walk(filed(2), running());

    // The applies stand — they are real local board state, and the durable sync retry the nudge
    // enqueued is what lands them. What must not stand is a record claiming a move the shared
    // board never received.
    expect(result.records.map((r) => r.outcome)).toEqual(["applied", "applied"]);
    const summary = readPassRecords(recorded());
    expect(passRecordCounts(summary).applied).toBe(2);
    // A NOTE, not a seventh proposal: it is the pass's correction to the counts above it, so it
    // renders beside them (components/runs/pass-record.tsx) rather than as an ask of its own.
    expect(summary.notes).toContainEqual(
      expect.stringContaining("APPLY could not publish this pass's board writes"),
    );
    expect(summary.notes.join("\n")).toContain("(p-1, p-2)");
    expect(summary.notes.join("\n")).toContain("conflict in issues");
  });

  /** The session log refusing exactly the correction — the counts above it landed fine. */
  const logRefusing = (marker: string) =>
    log.mockImplementation(async (chunk: string) => {
      if (chunk.includes(marker)) throw new Error("session log store is unavailable");
    });

  it("fails the pass when the note saying the moves are unpublished cannot be recorded", async () => {
    // Both halves failed: the moves are on this machine only, and the record still calls them
    // APPLIED. Resolving here would file a pass that finished over a record that lies about the
    // shared board — and nothing later corrects it, because no pass re-decides a filed proposal.
    pushMock.mockRejectedValue(new Error("bd dolt push failed: conflict in issues"));
    logRefusing("could not publish");

    await expect(walk(filed(2), running())).rejects.toThrow(
      /claims moves the shared board has not received/,
    );

    // The applies themselves stand — a failed pass is not a rollback, and the durable sync retry the
    // nudge enqueued is still what lands them.
    expect(applyMock).toHaveBeenCalledTimes(2);
    expect(nudge).toHaveBeenCalled();
    expect(recorded()).toContain("— APPLIED: closed the subject of p-1 as shipped");
  });

  it("does not fail a pass that moved nothing, however the note went", async () => {
    // Every ask refused: the pass wrote reasons onto its own proposals and touched no subject, so an
    // unpublished note is worth the console warning and not a failed pass. Failing here would park
    // the armed path over the outcome that IS the armed path working.
    applyMock.mockRejectedValue(
      new ProposalApplyError("refused", "applying p-1 was refused: the premise moved"),
    );
    pushMock.mockRejectedValue(new Error("bd dolt push failed: conflict in issues"));
    logRefusing("could not publish");

    const result = await walk(filed(2), running());

    expect(result.records.map((r) => r.outcome)).toEqual(["refused", "refused"]);
  });

  it("lets the cancel win when a stopped walk cannot record the note either", async () => {
    // Two failures at once, and the abort is the louder one: the runner reads its reason to record a
    // stopped pass rather than a done one, and swapping it for the log failure would file a
    // guillotined pass as an ordinary error the runner retries against a board it never re-reads.
    const reason = new Error("the runner stopped this job");
    const controller = new AbortController();
    applyMock.mockImplementationOnce(async (_repo, proposal) => {
      controller.abort(reason);
      return { summary: `closed the subject of ${proposal.id} as shipped`, changed: ["t-1"] };
    });
    pushMock.mockRejectedValue(new Error("bd dolt push failed: remote unreachable"));
    logRefusing("could not publish");

    await expect(walk(filed(2), controller.signal)).rejects.toBe(reason);
  });

  it("stays silent when the publish lands", async () => {
    await walk(filed(2), running());

    expect(pushMock).toHaveBeenCalledWith(REPO);
    expect(readPassRecords(recorded()).notes).toEqual([]);
  });

  it("publishes nothing, and says nothing, for a walk that attempted nothing", async () => {
    // Nothing armed: no records, so no board write to publish and no push to pay for.
    await applyArmedProposals({
      repo: REPO,
      created: filed(2),
      policy: resolveProposalAutonomyPolicy({ "shipped-orphan": "propose" }),
      record,
      producer: "[gardener]",
      log,
      nudge,
      signal: running(),
    });

    expect(nudge).not.toHaveBeenCalled();
    expect(pushMock).not.toHaveBeenCalled();
  });

  it("attempts nothing for an ARMED kind whose record has not earned it (anton-m29g)", async () => {
    // The policy says `apply` and the walk still writes nothing: the earned floor answers before the
    // policy is consulted, exactly as the manual floor does, so an unearned kind has no walk at all.
    await applyArmedProposals({
      repo: REPO,
      created: filed(2),
      policy,
      record: emptyTrackRecord(),
      producer: "[gardener]",
      log,
      nudge,
      signal: running(),
    });

    expect(applyMock).not.toHaveBeenCalled();
    expect(nudge).not.toHaveBeenCalled();
    expect(pushMock).not.toHaveBeenCalled();
  });

  it("publishes what a CANCELLED walk wrote, and reports a publish it could not prove", async () => {
    // A cancel is not a rollback, so the writes behind it owe the same publish — and the same
    // answer about whether it landed.
    const controller = new AbortController();
    applyMock.mockImplementationOnce(async (_repo, proposal) => {
      controller.abort();
      return { summary: `closed the subject of ${proposal.id} as shipped`, changed: ["t-1"] };
    });
    pushMock.mockRejectedValue(new Error("bd dolt push failed: remote unreachable"));

    await expect(walk(filed(3), controller.signal)).rejects.toThrow();

    expect(pushMock).toHaveBeenCalledWith(REPO);
    expect(readPassRecords(recorded()).notes).toContainEqual(
      expect.stringContaining("APPLY could not publish this pass's board writes"),
    );
  });
});

/**
 * A sync failure is MULTI-LINE where it matters most: bd hands back the Dolt output it failed on, and
 * the reason a founder needs is at the END of it. The reader matches one record and one note per
 * physical line (record.ts), so an uncollapsed message does not read as wrapped text — every
 * continuation is dropped, leaving a note that says the board could not be pulled and never says why.
 */
describe("armed walk · a sync failure the note must carry whole", () => {
  const running = (): AbortSignal => new AbortController().signal;

  const multiLine = (headline: string) =>
    new Error(`${headline}\n  diverged from origin/main\n  hint: pull before pushing`);

  it("keeps a multi-line push failure on one line, reason and all", async () => {
    pushMock.mockRejectedValue(multiLine("bd dolt push failed"));

    await walk(filed(1), running());

    const note = readPassRecords(recorded()).notes.find((n) =>
      n.startsWith("APPLY could not publish"),
    );
    expect(note).toContain("bd dolt push failed diverged from origin/main hint: pull before pushing");
  });

  it("keeps a multi-line pull failure on one line, so the stop names what stopped it", async () => {
    pullMock.mockRejectedValue(multiLine("bd dolt pull failed"));

    const result = await walk(filed(2), running());

    // Fails closed: nothing is applied against a board anton cannot prove is current.
    expect(applyMock).not.toHaveBeenCalled();
    expect(result.records).toEqual([]);
    const note = readPassRecords(recorded()).notes.find((n) => n.includes("could not be pulled"));
    expect(note).toContain("bd dolt pull failed diverged from origin/main hint: pull before pushing");
    expect(note).toContain("(p-1, p-2)");
  });
});

/**
 * The walk's decisions, each on its own (anton-ser8).
 *
 * The suites above drive them through a whole pass, which is the only way to prove the ORDER they
 * run in — but it is a poor way to prove what any one of them says. These reach each decision
 * directly: which asks are armed, what the cap holds back, what a stop and an unpublished write tell
 * a founder, and which verdict a failure earns. A reworded refusal that the walk's own assertions
 * would never notice fails here.
 */
describe("armedTargets", () => {
  it("takes the kinds the policy armed, in the order the pass filed them", () => {
    const created = filed(2);

    expect(armedTargets(created, policy, record).map((t) => t.proposal.id)).toEqual(["p-1", "p-2"]);
  });

  it("leaves a kind the policy did not arm to the shadow walk", () => {
    const detection = staleAsk("t-9");
    const created = [{ id: "p-9", fingerprint: detection.fingerprint, detection }];

    expect(armedTargets(created, policy, record)).toEqual([]);
  });

  it("refuses an armed kind whose record has not earned it (anton-m29g)", () => {
    expect(armedTargets(filed(1), policy, emptyTrackRecord())).toEqual([]);
  });

  it("carries the plan beside the proposal, so no step re-derives the move", () => {
    const [target] = armedTargets(filed(1), policy, record);

    expect(target.plan.move).toBe("retire");
    expect(target.plan.retireAs).toBe("close");
    expect(target.plan.subjects).toEqual(["t-1"]);
  });
});

describe("heldBackNote", () => {
  it("says nothing when the cap held nothing back", () => {
    expect(heldBackNote([], MAX_APPLIES_PER_PASS)).toBeUndefined();
  });

  it("names the count, the pass cap and every ask it holds back", () => {
    const note = heldBackNote(["p-4", "p-5"], MAX_APPLIES_PER_PASS);

    expect(note).toContain("held back 2 armed proposal(s)");
    expect(note).toContain(`one pass applies at most ${MAX_APPLIES_PER_PASS}`);
    expect(note).toContain("stay open as ordinary asks (p-4, p-5)");
  });

  it("names what an earlier tier of the same pass already spent, so the cap reads right", () => {
    expect(heldBackNote(["p-4"], MAX_APPLIES_PER_PASS - 2)).toContain(
      "2 of those were already spent earlier in this pass",
    );
  });

  it("leaves the spend clause out for a pass that had spent nothing", () => {
    expect(heldBackNote(["p-4"], MAX_APPLIES_PER_PASS)).not.toContain("already spent");
  });
});

describe("stopNote", () => {
  it("names the reason and the asks left standing behind it", () => {
    const note = stopNote("the pass was cancelled", ["p-2", "p-3"]);

    expect(note).toBe(
      "APPLY stopped — the pass was cancelled; 2 armed proposal(s) stay open as ordinary asks " +
        "(p-2, p-3)",
    );
  });

  it("is just the reason when the stop left nothing untried", () => {
    expect(stopNote("the pass was cancelled", [])).toBe("APPLY stopped — the pass was cancelled");
  });
});

describe("unpublishedNote", () => {
  it("names the moves that are on this machine only, by id", () => {
    const note = unpublishedNote(["p-1", "p-2"], "bd dolt push failed");

    expect(note).toContain("the 2 move(s) recorded above (p-1, p-2) are on this machine only");
    expect(note).toContain("bd dolt push failed");
  });

  it("claims no moves for a pass whose asks the board all refused", () => {
    const note = unpublishedNote([], "bd dolt push failed");

    expect(note).toContain("what this pass wrote is on this machine only");
    expect(note).not.toContain("move(s) recorded above");
  });
});

describe("stranding", () => {
  it("fails nothing when the pass moved nothing — an unpublished refusal is not a lie", () => {
    expect(stranding([], "bd dolt push failed")).toBeUndefined();
  });

  it("says the record claims moves the shared board never received", () => {
    const failure = stranding(["p-1"], "bd dolt push failed");

    expect(failure).toContain("applied 1 proposal(s) (p-1)");
    expect(failure).toContain("bd dolt push failed");
    expect(failure).toContain("claims moves the shared board has not received");
  });
});

describe("outcomeOf", () => {
  it("calls a throw that was not an apply failure anton's own error", () => {
    expect(outcomeOf(undefined)).toBe("error");
  });

  it("keeps a move the board holds under an ask nobody closed apart from a failure", () => {
    expect(outcomeOf(new ProposalApplyError("unsettled", "could not close the proposal"))).toBe(
      "unsettled",
    );
  });

  it("reads a rolled-back write as anton failing, never as the board refusing", () => {
    expect(outcomeOf(new ProposalApplyError("failed", "bd close failed"))).toBe("error");
  });

  it.each(["refused", "unusable"] as const)("reads %s as the board declining", (failure) => {
    expect(outcomeOf(new ProposalApplyError(failure, "the subject moved since we asked"))).toBe(
      "refused",
    );
  });
});

describe("verdictOf", () => {
  it.each([
    ["applied", "APPLIED"],
    ["unsettled", "APPLIED BUT NOT SETTLED"],
    ["refused", "REFUSED"],
    ["error", "COULD NOT APPLY"],
  ] as const)("writes a clean %s record under %s", (outcome, verdict) => {
    expect(verdictOf(armedRecord({ proposal: "p-1", outcome }))).toBe(verdict);
  });

  it("never promises an untouched board for a rollback that left beads moved", () => {
    expect(verdictOf(armedRecord({ proposal: "p-1", outcome: "error", changed: ["t-1"] }))).toBe(
      "COULD NOT ROLL BACK",
    );
  });
});

describe("summaryOf", () => {
  it("leaves 'applied 0' out — a pass the board refused is the armed path working", () => {
    const summary = summaryOf([armedRecord({ proposal: "p-1", outcome: "refused" })]);

    expect(summary).toBe("1 refused");
  });

  it("spells out the applied and unsettled asks by id, and counts the refusals", () => {
    const summary = summaryOf([
      armedRecord({ proposal: "p-1", outcome: "applied", changed: ["t-1"] }),
      armedRecord({ proposal: "p-2", outcome: "unsettled", changed: ["t-2"] }),
      armedRecord({ proposal: "p-3", outcome: "refused" }),
    ]);

    expect(summary).toContain("applied 1 proposal(s) unattended (p-1)");
    expect(summary).toContain("could NOT settle 1 proposal(s) whose move the board now holds");
    expect(summary).toContain("(p-2)");
    expect(summary).toContain("1 refused");
  });

  it("counts a part-moved board apart from a failure nothing landed from", () => {
    const summary = summaryOf([
      armedRecord({ proposal: "p-1", outcome: "error", changed: ["t-1"] }),
      armedRecord({ proposal: "p-2", outcome: "error" }),
    ]);

    expect(summary).toContain("could NOT roll back 1 proposal(s)");
    expect(summary).toContain("(p-1)");
    expect(summary).toContain("1 could not be applied");
  });
});

/**
 * A record that will not take the walk's own accounting.
 *
 * The spend is written BEFORE the write it pays for (jobs/pass-budget.ts reconstructs the cap from
 * these very lines), so a log that refuses is not a cosmetic failure: an attempt anton cannot account
 * for is one it must not make, and one whose outcome it cannot record is the last it may reserve.
 * Both stops go to the console, because the surface that would have carried them is what failed.
 */
describe("armed walk · a record that will not take the spend", () => {
  const running = (): AbortSignal => new AbortController().signal;

  it("never applies an attempt whose reservation could not be recorded", async () => {
    log.mockImplementation(async (chunk) => {
      if (chunk.includes("APPLYING")) throw new Error("the log store is full");
    });

    const result = await walk(filed(2), running());

    expect(applyMock).not.toHaveBeenCalled();
    expect(result.records).toEqual([]);
    // Both stay open: the walk cannot account for the first, and the log is no healthier for the
    // second.
    expect(result.deferred).toEqual(["p-1", "p-2"]);
    expect(consoleStops()).toContain("can no longer account for what it spends");
  });

  it("stops after an apply whose outcome could not be recorded, rather than reserving again", async () => {
    log.mockImplementation(async (chunk) => {
      if (chunk.includes("APPLIED")) throw new Error("the log store is full");
    });

    const result = await walk(filed(2), running());

    // The first apply happened and is kept — what was lost is the line saying what it did.
    expect(applyMock).toHaveBeenCalledTimes(1);
    expect(result.records.map((r) => r.proposal)).toEqual(["p-1"]);
    expect(result.deferred).toEqual(["p-2"]);
    expect(consoleStops()).toContain("the outcome of p-1 could not be recorded");
  });
});
