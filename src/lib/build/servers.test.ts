/**
 * The search for servers of this checkout that no build record accounts for (anton-pzfb).
 *
 * The claim: every listener of this install is probed, each answering process is named once, and
 * the probes do not queue behind each other — the upgrade window this check exists for is exactly
 * the one with several listeners up, and the operator meets it through a health page render.
 */
import { describe, expect, it } from "vitest";

import { unstampedServers } from "./servers.mjs";

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
