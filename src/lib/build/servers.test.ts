/**
 * The search for servers of this checkout that no build record accounts for (anton-pzfb).
 *
 * The claim: every listener of this install is probed, each answering process is named once, and
 * the probes do not queue behind each other — the upgrade window this check exists for is exactly
 * the one with several listeners up, and the operator meets it through a health page render.
 */
import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { pidFileVerdict, unstampedServers } from "./servers.mjs";

/** A probe that reports how many of its kind were in flight at once, and answers for one port. */
function probes(answers: number[], expected: number) {
  let inFlight = 0;
  let peak = 0;
  let open = () => {};
  // Released once every probe is in flight — or, if they queued, after a bounded wait, so a
  // sequential implementation fails on `peak` rather than by timing out.
  const gate = new Promise<void>((resolve) => (open = resolve));
  const timer = setTimeout(() => open(), 250);
  const answering = async (port: number) => {
    inFlight += 1;
    peak = Math.max(peak, inFlight);
    if (inFlight === expected) {
      clearTimeout(timer);
      open();
    }
    await gate;
    inFlight -= 1;
    return answers.includes(port);
  };
  return { answering, peak: () => peak };
}

describe("the unstamped servers of this checkout", () => {
  it("probes every candidate port at once, so a silent listener does not delay the rest", async () => {
    const listeners = [
      { pid: 11, port: 3000 },
      { pid: 22, port: 3001 },
      { pid: 33, port: 3002 },
    ];
    const { answering, peak } = probes([3002], listeners.length);

    const found = await unstampedServers({ appRoot: "/app", servers: () => listeners, answering });

    expect(found).toEqual([33]);
    expect(peak()).toBe(listeners.length);
  });

  it("names a process once however many ports it holds", async () => {
    const listeners = [
      { pid: 11, port: 3000 },
      { pid: 11, port: 3001 },
    ];
    // Only the second port answers: a pid is unstamped if ANY of its ports is anton's page.
    const { answering } = probes([3001], listeners.length);

    expect(await unstampedServers({ appRoot: "/app", servers: () => listeners, answering })).toEqual([11]);
  });

  it("leaves out the listeners a live build record already speaks for", async () => {
    const listeners = [
      { pid: 11, port: 3000 },
      { pid: 22, port: 3001 },
    ];
    const probed: number[] = [];
    const answering = async (port: number) => {
      probed.push(port);
      return true;
    };

    const found = await unstampedServers({
      appRoot: "/app",
      livePids: new Set([11]),
      servers: () => listeners,
      answering,
    });

    expect(found).toEqual([22]);
    expect(probed).toEqual([3001]);
  });
});

/**
 * The daemon pidfile read, over the case no fixture of a live process can produce: the stamp is
 * there and the birth time cannot be read back. `anton stop` acts on this answer by signalling the
 * pid, so an unverifiable stamp must name nobody — and must not cost the file that carries it.
 */
describe("the daemon pidfile verdict", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function stamped(startedAt: string): string {
    const dir = mkdtempSync(join(tmpdir(), "anton-pid-"));
    dirs.push(dir);
    const path = join(dir, "anton.pid");
    writeFileSync(path, `${process.pid}\n${startedAt}\n`);
    return path;
  }

  it("answers with the pid while the birth stamp still matches", () => {
    expect(pidFileVerdict(stamped("born-then"), () => "born-then")).toEqual({
      pid: process.pid,
      stale: false,
      unverifiable: null,
    });
  });

  // The reuse case proven: this number belongs to something else, and the file is the CLI's to clear.
  it("reads a reused pid as stopped and the file as stale", () => {
    expect(pidFileVerdict(stamped("born-then"), () => "born-now")).toEqual({ pid: null, stale: true, unverifiable: null });
  });

  // Unreadable procfs, or a `ps` that failed or timed out. Reuse and liveness are indistinguishable
  // here, so answering would hand `anton stop` a pid it goes on to SIGKILL — but the file is KEPT,
  // so the next read that CAN prove the stamp still finds the daemon. The pid comes back under
  // `unverifiable` so a lifecycle command can tell this from a proven-stopped daemon (PR #217 review).
  it("names nobody when a stamped pid cannot be revalidated, and keeps the file", () => {
    expect(pidFileVerdict(stamped("born-then"), () => null)).toEqual({
      pid: null,
      stale: false,
      unverifiable: process.pid,
    });
  });

  // Same silence for a stamp the recheck can only answer in the OTHER reader's spelling: procfs
  // counts clock ticks, `ps` prints a date, and reading one against the other as proof of reuse
  // deletes the pidfile of a live daemon `update` and `uninstall --purge` then walk over.
  it("names nobody when the recheck answers from a different birth-time reader", () => {
    expect(pidFileVerdict(stamped("proc:4212345"), () => "ps:Wed Sep  2 07:16:57 2026")).toEqual({
      pid: null,
      stale: false,
      unverifiable: process.pid,
    });
    expect(pidFileVerdict(stamped("proc:4212345"), () => "proc:9999999")).toEqual({
      pid: null,
      stale: true,
      unverifiable: null,
    });
  });

  // A pidfile written before the stamp existed never claimed one, so there is nothing to revalidate.
  it("still answers on the pid alone for a file that carries no stamp", () => {
    const path = stamped("");
    writeFileSync(path, String(process.pid));
    expect(pidFileVerdict(path, () => null)).toEqual({ pid: process.pid, stale: false, unverifiable: null });
  });
});
