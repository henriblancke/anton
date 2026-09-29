/**
 * One off-thread read of a checkout's build identity (anton-fzarz) — the worker behind the DISPLAY
 * half of build drift.
 *
 * `readBuildIdentity` is synchronous by construction: it spawns git six times on a cold path, hashes
 * whatever the checkout holds beyond HEAD, and walks the route tree for inlined env names. Measured
 * at 87–275 ms per read, that is a block the request event loop cannot pay — and the health page and
 * the breaker band read it on a 15-second cadence, so every operator refresh landed on a miss stalled
 * every other request in the process behind it.
 *
 * A worker thread has its own loop, so the same read costs the request loop a message round trip
 * (measured: 88 ms of blocking becomes ~1 ms). It changes no verdict: the answer is the identical
 * return value of the identical function, and the job-start gate still reads it SYNCHRONOUSLY on the
 * request-free path where a worker would only add latency (`serverBuildDrift({ fresh: true })`).
 *
 * One-shot by design. It posts a single identity and exits, so nothing holds a thread — or a module
 * graph of a runtime dir `anton update` is free to delete — open between reads. The spawn costs ~10 ms
 * against a 15-second cadence, which buys a worker that cannot go stale.
 *
 * `workerData.appRoot` is the checkout to read. The environment comes from this thread's own
 * `process.env`, which Node seeds as a copy of the parent's — the env digest must see exactly the
 * variables the parent would have compiled in, so it may not be re-derived here.
 *
 * Pure Node, no deps, and a plain `.mjs` for the reason `identity.mjs` is: it is loaded as a real
 * file by path at run time, never through the webpack graph, so it must resolve from BOTH a source
 * checkout and an installed bundle (see `next.config.ts` tracing includes and `scripts/build-bundle.mjs`).
 */
import { parentPort, workerData } from "node:worker_threads";

import { readBuildIdentity } from "./identity.mjs";

// An unusable invocation is a thrown error, which the caller reads as "no worker" and answers with
// its own synchronous read — never as an identity nothing established.
if (!parentPort) throw new Error("identity-worker must be started as a worker thread");
const appRoot = workerData?.appRoot;
if (typeof appRoot !== "string" || !appRoot) throw new Error("identity-worker needs a workerData.appRoot");

parentPort.postMessage(readBuildIdentity(appRoot));
