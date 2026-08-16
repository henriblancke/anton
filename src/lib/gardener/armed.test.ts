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
import { makeDetection, type GardenerDetection } from "./detections";
import { resolveProposalAutonomyPolicy } from "./autonomy";
import type { EmittedProposal } from "./emit";
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

const { applyArmedProposals } = await import("./armed");
/** The real class — the mock above spreads the actual module, so `changed` behaves as it ships. */
const { ProposalApplyError } = await import("./apply");

const REPO = "/tmp/armed-repo";
/** Only `shipped-orphan` is armed, and it is the only kind these fixtures file. */
const policy = resolveProposalAutonomyPolicy({ "shipped-orphan": "apply" });

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

function walk(created: EmittedProposal[], signal: AbortSignal) {
  return applyArmedProposals({
    repo: REPO,
    created,
    policy,
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
      producer: "[gardener]",
      log,
      nudge,
      signal: running(),
    });

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
