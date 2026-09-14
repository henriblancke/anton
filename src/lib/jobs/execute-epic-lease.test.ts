/**
 * anton-1lix — the run-lease protocol, now that it owns a module of its own.
 *
 * The invariants under test are the ones a stopped run breaks silently when they slip: the lease
 * this run OWNS (so a settle never clears another machine's), the expiry it may only advance once
 * the push has confirmed (so `assertHeld` parks before an unpushed lease lapses), and the two-read
 * arbitration that must run BOTH times rather than trusting one uncontested look.
 *
 * Mocked at the bd seam, because every case here is a bd call that fails or a board that changed
 * between two reads; the end-to-end shapes live in the execute-epic integration suites.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { LABELS, type Bead } from "../beads/bd";
import { isRunAlreadyLiveError } from "./errors";

const publishRunLeaseMock = vi.fn();
const clearRunLeaseMock = vi.fn();
const syncMock = vi.fn();
const pullMock = vi.fn();
const showMock = vi.fn();

vi.mock("../beads/bd", async () => {
  const actual = await vi.importActual<typeof import("../beads/bd")>("../beads/bd");
  return {
    ...actual,
    beads: {
      ...actual.beads,
      publishRunLease: (...args: unknown[]) => publishRunLeaseMock(...args),
      clearRunLease: (...args: unknown[]) => clearRunLeaseMock(...args),
      sync: (...args: unknown[]) => syncMock(...args),
      pull: (...args: unknown[]) => pullMock(...args),
      show: (...args: unknown[]) => showMock(...args),
    },
  };
});

const { makeRunLease } = await import("./execute-epic-lease");

const REPO = "/tmp/anton";
const TARGET = "t-1";
const RUN = "run-b";
const NOW = 1_000_000;
const TTL_MS = 15 * 60_000;

function bead(labels: string[] = []): Bead {
  return { id: TARGET, title: TARGET, status: "open", labels } as Bead;
}

/** A clock the test drives by hand; `sleep` is omitted, so the arbitration settle is a no-op. */
function fakeClock(start = NOW) {
  let now = start;
  return { now: () => now, advance: (ms: number) => (now += ms) };
}

function lease(clock: { now(): number }) {
  return makeRunLease({ repo: REPO, targetId: TARGET, runId: RUN, clock });
}

beforeEach(() => {
  vi.clearAllMocks();
  publishRunLeaseMock.mockResolvedValue("");
  clearRunLeaseMock.mockResolvedValue("");
  syncMock.mockResolvedValue(undefined);
  pullMock.mockResolvedValue(undefined);
  showMock.mockResolvedValue(bead([LABELS.runLease(NOW + TTL_MS, RUN)]));
});

describe("refuseForeign", () => {
  it("parks when another machine holds an unexpired lease", () => {
    const clock = fakeClock();
    expect(() => lease(clock).refuseForeign(bead([LABELS.runLease(NOW + TTL_MS, "run-other")])))
      .toThrow(/already running on another machine/);
  });

  it("lets this run's own leftover lease through — it is a sweep leftover, not a rival", () => {
    const clock = fakeClock();
    expect(() => lease(clock).refuseForeign(bead([LABELS.runLease(NOW + TTL_MS, RUN)]))).not.toThrow();
  });
});

describe("claim", () => {
  it("publishes, pushes, then arbitrates TWICE before committing to run", async () => {
    const clock = fakeClock();
    await lease(clock).claim(true);
    expect(publishRunLeaseMock).toHaveBeenCalledTimes(1);
    expect(syncMock).toHaveBeenCalledTimes(1);
    // The settle window between the two reads is what makes an uncontested win trustworthy.
    expect(pullMock).toHaveBeenCalledTimes(2);
    expect(showMock).toHaveBeenCalledTimes(2);
  });

  it("parks (never fails) when the lease cannot be pushed to the shared remote", async () => {
    syncMock.mockRejectedValueOnce(new Error("dolt remote unreachable"));
    const l = lease(fakeClock());
    await expect(l.claim(true)).rejects.toThrow(/could not publish its run-lease/);
    await l.claim(true).catch((e) => expect(isRunAlreadyLiveError(e)).toBe(true));
  });

  it("parks when the arbitration pull fails — a stale view cannot prove the race was won", async () => {
    pullMock.mockRejectedValueOnce(new Error("offline"));
    await expect(lease(fakeClock()).claim(true)).rejects.toThrow(/arbitrate the run-lease race/);
  });

  it("parks when the arbitration re-read fails, rather than proceeding unproven", async () => {
    showMock.mockRejectedValueOnce(new Error("db locked"));
    await expect(lease(fakeClock()).claim(true)).rejects.toThrow(/could not re-read the target/);
  });

  it("refuses to steal from an incumbent surfaced after a STALE pre-check", async () => {
    // Lower runId would win the ordinary tiebreak — but an incumbent that never re-arbitrates must
    // not be stolen from, so an untrusted pre-check parks on any foreign live lease.
    showMock.mockResolvedValue(bead([LABELS.runLease(NOW + TTL_MS, "run-a")]));
    await expect(lease(fakeClock()).claim(false)).rejects.toThrow(/after a stale pre-check/);
  });

  it("arbitrates by owner order when the pre-check WAS trusted", async () => {
    showMock.mockResolvedValue(
      bead([LABELS.runLease(NOW + TTL_MS, "run-a"), LABELS.runLease(NOW + TTL_MS, RUN)]),
    );
    // "run-a" sorts below "run-b", so this run loses and parks instead of double-running.
    await expect(lease(fakeClock()).claim(true)).rejects.toThrow(/lost the run-lease race/);
  });
});

describe("assertHeld", () => {
  it("parks once the lease this run last PUSHED has lapsed", async () => {
    const clock = fakeClock();
    const l = lease(clock);
    await l.claim(true);
    expect(() => l.assertHeld()).not.toThrow();
    clock.advance(TTL_MS + 1);
    expect(() => l.assertHeld()).toThrow(/run-lease expired mid-run/);
  });

  it("parks a run that never published — an unheld lease is never assumed held", () => {
    expect(() => lease(fakeClock()).assertHeld()).toThrow(/run-lease expired mid-run/);
  });

  it("does not advance the expiry when the PUSH failed, even though the label was written", async () => {
    const clock = fakeClock();
    const l = lease(clock);
    syncMock.mockRejectedValueOnce(new Error("push failed"));
    await l.claim(true).catch(() => {});
    // The label landed locally, but nothing proves other machines can see it — so the guard parks.
    expect(publishRunLeaseMock).toHaveBeenCalledTimes(1);
    expect(() => l.assertHeld()).toThrow(/run-lease expired mid-run/);
  });
});

describe("settle", () => {
  it("clears nothing when the run never adopted or published a lease", async () => {
    await lease(fakeClock()).settle();
    expect(clearRunLeaseMock).toHaveBeenCalledWith(REPO, TARGET, []);
  });

  it("clears the freshest label this run published, not the one it adopted", async () => {
    const clock = fakeClock();
    const l = lease(clock);
    const stale = LABELS.runLease(NOW - 1, RUN);
    l.adopt(bead([stale]));
    await l.claim(true);
    await l.settle();
    // The publish swept the adopted leftover; the clear removes what the publish actually wrote.
    expect(publishRunLeaseMock).toHaveBeenCalledWith(REPO, TARGET, NOW + TTL_MS, [stale], RUN);
    expect(clearRunLeaseMock).toHaveBeenCalledWith(REPO, TARGET, [
      LABELS.runLease(NOW + TTL_MS, RUN),
    ]);
  });

  it("adoptOwn takes back only THIS run's leftover, leaving a foreign lease to its owner", async () => {
    const clock = fakeClock();
    const l = lease(clock);
    const mine = LABELS.runLease(NOW + TTL_MS, RUN);
    l.adoptOwn(bead([mine, LABELS.runLease(NOW + TTL_MS, "run-other")]));
    await l.settle();
    expect(clearRunLeaseMock).toHaveBeenCalledWith(REPO, TARGET, [mine]);
  });
});
