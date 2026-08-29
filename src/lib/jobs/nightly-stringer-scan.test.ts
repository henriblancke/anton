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
import { restoreScanWindow, type ScanPass } from "./nightly-stringer-scan";

let dir: string;
let logPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "anton-stringer-scan-"));
  logPath = join(dir, "session.log");
});

afterEach(() => {
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
  };
}

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
