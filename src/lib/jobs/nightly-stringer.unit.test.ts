/**
 * The handler's failure path, with every step stubbed: whatever kills a pass AFTER the scan, the
 * consumed `--delta` window goes back and the point the scan measured still lands. The end-to-end
 * versions live in nightly-stringer.integration.test.ts / .refresh.test.ts; this pins the ordering
 * inside `runNightlyPass`, which is the only place that holds the window handle.
 */
import { beforeEach, expect, it, vi } from "vitest";
import { emptyScanCounts } from "../scan-health";
import type { ScanPass } from "./nightly-stringer-scan";
import type { AntonDb, Clock } from "./queue";
import type { JobContext } from "./runner";
import { makeNightlyStringerHandler } from "./nightly-stringer";

const recordHealth = vi.fn(async () => {});
const scanShippedTree = vi.fn();
const restoreScanWindow = vi.fn(async (err: unknown) => err);
const runTriage = vi.fn(async () => ({}));

vi.mock("./nightly-stringer-pass", () => ({
  openPass: async () => ({
    project: { slug: "sandbox", repoPath: "/repo", defaultBranch: "main" },
    settings: {},
    sessionId: "sess-1",
    logPath: "/tmp/sess-1.log",
    onEvent: () => {},
    log: async () => {},
    end: async () => {},
    recordHealth,
    triaged: false,
  }),
}));

vi.mock("./nightly-stringer-scan", () => ({
  scanShippedTree: (...args: unknown[]) => scanShippedTree(...args),
  restoreScanWindow: (...args: unknown[]) => restoreScanWindow(...(args as [unknown])),
}));

vi.mock("./nightly-stringer-triage", () => ({ runTriage: () => runTriage() }));
vi.mock("./nightly-stringer-board", () => ({ syncBoard: async () => {} }));

function scanPass(overrides: Partial<ScanPass> = {}): ScanPass {
  return {
    scanFile: "/tmp/scan.json",
    scannedSha: "abc1234",
    counts: emptyScanCounts(),
    collectorFailures: 0,
    deltaState: { after: "state-2" },
    restoreBaseline: async () => undefined,
    reportDiagnostics: async () => {},
    ...overrides,
  };
}

const ctx = {
  jobId: "job-1",
  type: "nightly-stringer",
  payload: { projectId: "proj-1" },
  attempt: 1,
  heartbeat: async () => {},
  signal: new AbortController().signal,
  report: () => {},
} as unknown as JobContext;

const run = () =>
  makeNightlyStringerHandler({ db: {} as AntonDb, clock: { now: () => 0 } as Clock })(ctx);

beforeEach(() => {
  vi.clearAllMocks();
});

it("restores the window when reporting the scan's diagnostics fails", async () => {
  // The scan already advanced stringer's baseline; a diagnostics log write dying afterwards must
  // not strand that window, or the retry measures the NEXT one and closes green over these signals.
  const pass = scanPass({
    reportDiagnostics: async () => {
      throw new Error("ENOSPC: no space left");
    },
  });
  scanShippedTree.mockResolvedValue(pass);

  await expect(run()).rejects.toThrow("ENOSPC");

  expect(restoreScanWindow).toHaveBeenCalledWith(expect.any(Error), pass, "/tmp/sess-1.log");
  expect(recordHealth).toHaveBeenCalledWith(pass);
  expect(runTriage).not.toHaveBeenCalled();
});

it("leaves the window alone when nothing was scanned", async () => {
  scanShippedTree.mockRejectedValue(new Error("checkout drift"));

  await expect(run()).rejects.toThrow("checkout drift");

  expect(restoreScanWindow).not.toHaveBeenCalled();
  expect(recordHealth).not.toHaveBeenCalled();
});
