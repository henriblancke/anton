/**
 * The scan step's window rules (anton-xdgw), exercised without a stringer binary or a runner: a
 * pass that dies before triage must hand its `--delta` window back, and must PARK when it can't.
 * The false green those two prevent — a retry that rescans an advanced baseline, finds nothing and
 * closes over untriaged findings — is the one failure this job cannot recover from.
 */
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { emptyScanCounts } from "../scan-health";
import { PoisonError } from "./errors";
import { restoreScanWindow, scanShippedTree, type ScanPass } from "./nightly-stringer-scan";
import type { Project } from "../types";

/** Substring whose session-log write blows up — how a full disk is spelled in these tests. */
let failLogWrite: string | undefined;

// Real appends (the log is read back below) with one injectable failure: a log write can fail for
// reasons that have nothing to do with the scan, and where in the pass it fails is the point.
vi.mock("../sessions", async () => {
  const { appendFile, mkdir } = await import("node:fs/promises");
  const { dirname } = await import("node:path");
  return {
    appendSessionLog: async (path: string, chunk: string) => {
      if (failLogWrite && chunk.includes(failLogWrite)) throw new Error("ENOSPC: no space left");
      await mkdir(dirname(path), { recursive: true });
      await appendFile(path, chunk);
    },
  };
});

vi.mock("../git/refresh", () => ({
  refreshCheckout: async () => ({ head: "abc1234" }),
}));

const scanned = vi.hoisted(() => ({ restoreBaseline: async (): Promise<string | undefined> => undefined }));

vi.mock("../stringer", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../stringer")>();
  return {
    ...actual,
    // A scan that consumed its window and lost a collector on the way — so a diagnostic line is
    // written after the baseline has already advanced.
    scan: async ({ scanFile }: { scanFile: string }) => ({
      scanFile,
      signals: [],
      collectorFailures: [{ name: "gitlog", error: "opening repo: broken" }],
      untracked: { dropped: [] },
      coupling: { dropped: [], recounted: [] },
      duplication: {
        dropped: [{ path: "src/doc.ts", kind: "code-clone", reason: "6 comment line(s)" }],
      },
      secrets: { dropped: [] },
      deltaState: { before: "state-1", after: "state-2" },
      restoreBaseline: () => scanned.restoreBaseline(),
    }),
  };
});

let dir: string;
let logPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "anton-stringer-scan-"));
  logPath = join(dir, "session.log");
  failLogWrite = undefined;
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true });
});

function pass(restoreBaseline: () => Promise<string | undefined>): ScanPass {
  return {
    scanFile: join(dir, "scan.json"),
    scannedSha: "abc1234",
    counts: emptyScanCounts(),
    collectorFailures: 0,
    deltaState: { after: "state-2" },
    restoreBaseline,
    reportDiagnostics: async () => {},
  };
}

const project = { slug: "sandbox", repoPath: "/repo", defaultBranch: "main" } as Project;

const runScan = () =>
  scanShippedTree({
    project,
    sessionId: "sess-1",
    logPath,
    signal: new AbortController().signal,
  });

it("gives the untriaged window back and rethrows the original failure", async () => {
  const restore = vi.fn(async () => undefined);
  const err = new Error("usage-limit");

  expect(await restoreScanWindow(err, pass(restore), logPath)).toBe(err);
  expect(restore).toHaveBeenCalledOnce();
  expect(readFileSync(logPath, "utf8")).toContain("--delta baseline restored");
});

it("parks for a human when the window cannot go back — a retry would close green over it", async () => {
  const failure = await restoreScanWindow(
    new Error("usage-limit"),
    pass(async () => "state file is read-only"),
    logPath,
  );

  expect(failure).toBeInstanceOf(PoisonError);
  expect((failure as PoisonError).message).toContain("state file is read-only");
  const log = readFileSync(logPath, "utf8");
  expect(log).toContain("[stringer] ERROR:");
  expect(log).not.toContain("baseline restored;");
});

it("hands back the window handle before it logs anything that can fail", async () => {
  // The scan has already advanced stringer's baseline by the time diagnostics are written, so a
  // failing log write must not swallow the only handle that can put it back.
  failLogWrite = "gitlog";
  const restore = vi.fn(async () => undefined);
  scanned.restoreBaseline = restore;

  const result = await runScan();

  await expect(result.reportDiagnostics()).rejects.toThrow("ENOSPC");
  expect(await restoreScanWindow(new Error("boom"), result, logPath)).toBeInstanceOf(Error);
  expect(restore).toHaveBeenCalledOnce();
});

it("reports what the scan lost when the log is writable", async () => {
  const result = await runScan();
  await result.reportDiagnostics();

  const log = readFileSync(logPath, "utf8");
  expect(log).toContain("gitlog");
  // The duplication filter can remove most of a scan; silence would read as a collector that
  // found nothing (anton-vb2h).
  expect(log).toContain("dropped 1 duplication signal(s)");
});
