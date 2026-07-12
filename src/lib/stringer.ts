/**
 * The single place anton runs `stringer` (anton-3t2.3). stringer mines a repo for actionable
 * signals (TODOs, churn, CVEs, …) and emits them as JSON; the nightly-stringer job then hands the
 * scan file to claude with the /scan-triage prompt to convert the few worth doing into beads.
 *
 * The binary is injectable (ANTON_STRINGER_BIN) so tests point it at a fake. `--delta` limits a
 * scan to signals new since the last run (stringer keeps its own baseline in the repo), keeping the
 * nightly pass cheap and the board from re-flooding.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

const execFileAsync = promisify(execFile);

/** Override the stringer binary (tests point this at a fake that writes a canned scan file). */
export const STRINGER_BIN_ENV = "ANTON_STRINGER_BIN";

export interface ScanResult {
  /** Absolute path to the JSON scan file written by stringer. */
  scanFile: string;
  /** Number of signals in the scan (0 → nothing to triage). */
  signalCount: number;
}

/** stringer JSON is either a top-level array or an object carrying `signals`/`issues`. */
function countSignals(parsed: unknown): number {
  if (Array.isArray(parsed)) return parsed.length;
  if (parsed && typeof parsed === "object") {
    const o = parsed as Record<string, unknown>;
    for (const key of ["signals", "issues", "results"]) {
      if (Array.isArray(o[key])) return (o[key] as unknown[]).length;
    }
  }
  return 0;
}

/**
 * Run `stringer scan <repo> --delta --format json -o <scanFile>` and report how many signals it
 * produced. `delta` (default true) restricts to new signals since the last scan. Throws on a
 * stringer failure (fail loud) — the job then retries/parks per the runner's policy.
 */
export async function scan(opts: {
  repoPath: string;
  scanFile: string;
  delta?: boolean;
  signal?: AbortSignal;
}): Promise<ScanResult> {
  const bin = process.env[STRINGER_BIN_ENV] ?? "stringer";
  await mkdir(dirname(opts.scanFile), { recursive: true });

  const args = ["scan", opts.repoPath, "--format", "json", "-o", opts.scanFile];
  if (opts.delta ?? true) args.push("--delta");

  await execFileAsync(bin, args, {
    timeout: 10 * 60_000,
    maxBuffer: 64 * 1024 * 1024,
    signal: opts.signal,
  });

  let signalCount = 0;
  try {
    const raw = await readFile(opts.scanFile, "utf8");
    signalCount = countSignals(JSON.parse(raw || "[]"));
  } catch {
    // No file / unparseable output → treat as zero signals (nothing to triage).
    signalCount = 0;
  }
  return { scanFile: opts.scanFile, signalCount };
}
