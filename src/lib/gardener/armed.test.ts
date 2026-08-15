/**
 * The armed walk's CANCEL contract (anton-4ab3), over a stubbed board.
 *
 * Everything else about this walk is exercised through the real handler (jobs/gardener.test.ts
 * "gardener patrol · armed"). What needs a seam of its own is the one path a job runner cannot be
 * asked to produce on demand: an abort arriving mid-walk, and specifically INSIDE the pull that
 * precedes an unattended write. Two things must hold, and each is a way the armed path could do
 * quiet harm:
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
vi.mock("../beads/bd", async () => {
  const actual = await vi.importActual<typeof import("../beads/bd")>("../beads/bd");
  return {
    ...actual,
    beads: { ...actual.beads, pull: (...a: [string]) => pullMock(...a) },
  };
});

const loadMock = vi.fn<(cwd: string) => Promise<Bead[]>>();
vi.mock("../beads/issues", () => ({ loadAllIssues: (...a: [string]) => loadMock(...a) }));

/** The apply seam: the armed walk reimplements none of it, so the walk's own tests stub it whole. */
const applyMock = vi.fn<(repo: string, proposal: Bead) => Promise<{ summary: string; changed: string[] }>>();
vi.mock("./apply", async () => {
  const actual = await vi.importActual<typeof import("./apply")>("./apply");
  return {
    ...actual,
    applyProposal: (...a: [string, Bead, Bead[], string]) => applyMock(a[0], a[1]),
  };
});

const { applyArmedProposals } = await import("./armed");

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

  it("throws the abort reason, so the runner records the pass as stopped rather than done", async () => {
    const reason = new Error("the runner stopped this job");
    const controller = new AbortController();
    pullMock.mockImplementation(async () => {
      controller.abort(reason);
    });

    await expect(walk(filed(1), controller.signal)).rejects.toBe(reason);
  });
});
