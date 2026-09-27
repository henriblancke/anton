/** Offline build-identity benchmark (anton-fzarz): what a display read costs the request event loop.
 *
 * The number that matters is not how long the scan takes — a worker does not make git faster — but how
 * long the CALLING loop is blocked while it runs. `readBuildIdentity` spawns git synchronously, so a
 * health render landing on a cache miss stalls every other request in the process behind it; the
 * worker turns that block into a message round trip.
 *
 * Measures against a TEMPORARY repository by default, so it never reads the checkout it runs from and
 * needs no live anton. Pass a path to measure a real one.
 *
 *   node --import tsx scripts/bench-build-identity.mts [REPO_PATH]
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Worker } from "node:worker_threads";

import { readBuildIdentity } from "../src/lib/build/identity.mjs";

const WORKER = join(import.meta.dirname, "..", "src", "lib", "build", "identity-worker.mjs");
const SAMPLES = 8;

/** A throwaway checkout with uncommitted work, so the digest half of the scan actually runs. */
function makeRepo(): { path: string; cleanup: () => void } {
  const path = mkdtempSync(join(tmpdir(), "anton-identity-bench-"));
  const git = (...args: string[]) => execFileSync("git", args, { cwd: path, stdio: "pipe" });
  git("init", "-q");
  git("config", "user.email", "bench@example.com");
  git("config", "user.name", "bench");
  writeFileSync(join(path, "package.json"), JSON.stringify({ name: "bench", version: "9.9.9" }));
  for (let i = 0; i < 40; i++) writeFileSync(join(path, `file-${i}.ts`), `export const n${i} = ${i};\n`);
  git("add", "-A");
  git("commit", "-qm", "bench");
  writeFileSync(join(path, "uncommitted.ts"), "export const dirty = true;\n");
  return { path, cleanup: () => rmSync(path, { recursive: true, force: true }) };
}

/**
 * The worst stall a 5 ms timer saw while `run` was working — the cost a concurrent request pays.
 * Sampled with a timer rather than derived, because that IS the experience being measured: a request
 * that should have been served and was not.
 */
async function eventLoopDelay(run: () => Promise<void> | void): Promise<number> {
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  let worst = 0;
  let last = performance.now();
  const timer = setInterval(() => {
    const now = performance.now();
    worst = Math.max(worst, now - last - 5);
    last = now;
  }, 5);
  try {
    await sleep(20); // let the timer settle before the work starts
    await run();
    await sleep(20);
    return worst;
  } finally {
    clearInterval(timer);
  }
}

function readOffThread(appRoot: string): Promise<unknown> {
  const worker = new Worker(WORKER, { workerData: { appRoot } });
  return new Promise((resolve, reject) => {
    worker.once("message", resolve);
    worker.once("error", reject);
  }).finally(() => void worker.terminate());
}

async function measure(name: string, run: () => Promise<void> | void) {
  const wall: number[] = [];
  const delay: number[] = [];
  for (let i = 0; i < SAMPLES; i++) {
    const start = performance.now();
    delay.push(await eventLoopDelay(run));
    wall.push(performance.now() - start - 40); // less the two settling sleeps
  }
  const median = (xs: number[]) => +[...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)].toFixed(1);
  const max = (xs: number[]) => +Math.max(...xs).toFixed(1);
  console.log(name, {
    samples: SAMPLES,
    wallMedianMs: median(wall),
    eventLoopDelayMedianMs: median(delay),
    eventLoopDelayMaxMs: max(delay),
  });
  return median(delay);
}

const supplied = process.argv[2];
const repo = supplied ? { path: supplied, cleanup: () => {} } : makeRepo();
try {
  console.log(`repo: ${repo.path}${supplied ? "" : "  (temporary)"}\n`);
  const identity = readBuildIdentity(repo.path);
  console.log("identity", identity, "\n");
  const sync = await measure("synchronous (gate path)", () => void readBuildIdentity(repo.path));
  const off = await measure("off-thread  (display path)", async () => void (await readOffThread(repo.path)));
  console.log(`\nevent-loop delay: ${sync} ms → ${off} ms (${(sync / Math.max(off, 0.1)).toFixed(0)}× less blocking)`);
} finally {
  repo.cleanup();
}
