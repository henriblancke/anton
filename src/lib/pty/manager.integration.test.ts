/**
 * anton-bm4.1: end-to-end proof against a REAL node-pty. Spawns `bash`, drives it bidirectionally
 * (write a command → observe its echoed output), then tears it down cleanly. Self-skips when the
 * node-pty native addon can't spawn on this machine (its prebuilt often mismatches the Node ABI in
 * CI; run `cd node_modules/node-pty && npx node-gyp rebuild` locally — see DESIGN.md §8).
 */
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

import { PtyManager, type PtyEvent, type PtyLike, type SpawnFn } from "./manager";

const require = createRequire(import.meta.url);

/** Build a real node-pty spawn fn, or null if the native addon can't spawn here. */
function realSpawnOrNull(): SpawnFn | null {
  try {
    const nodePty = require("node-pty") as {
      spawn: (file: string, args: string[], opts: Record<string, unknown>) => PtyLike;
    };
    // Probe: a pty that exits immediately. A prebuilt/ABI mismatch throws here (posix_spawnp failed).
    const probe = nodePty.spawn("bash", ["-lc", "exit 0"], {
      name: "xterm-256color",
      cwd: process.cwd(),
      env: process.env,
      cols: 80,
      rows: 24,
    });
    probe.kill();
    return ({ file, args, cwd, env, cols, rows }) =>
      nodePty.spawn(file, args, { name: "xterm-256color", cwd, env, cols, rows });
  } catch {
    return null;
  }
}

const spawn = realSpawnOrNull();
const suite = spawn ? describe : describe.skip;

suite("PtyManager (real node-pty)", () => {
  it("streams a live bash pty bidirectionally and tears it down cleanly", async () => {
    const manager = new PtyManager({ spawn: spawn! });
    const events: PtyEvent[] = [];
    let exitCode: number | undefined;

    manager.spawn({
      sessionId: "real",
      file: "bash",
      args: ["--noprofile", "--norc", "-i"],
      cwd: process.cwd(),
      env: { ...process.env, PS1: "$ " },
    });
    manager.attach("real", (e) => {
      events.push(e);
      if (e.type === "exit") exitCode = e.exitCode;
    });

    // Drive it: send a command over stdin, expect the marker echoed back through the pty.
    manager.write("real", "echo bm4-ok-$((6*7))\r");
    await waitFor(() => output(events).includes("bm4-ok-42"));

    // Ask the shell to exit → the pty closes and the manager reports a clean exit.
    manager.write("real", "exit\r");
    await waitFor(() => exitCode !== undefined);
    expect(exitCode).toBe(0);
    expect(manager.status("real")).toBe("exited");
  });

  it("kill() terminates a running pty", async () => {
    const manager = new PtyManager({ spawn: spawn! });
    let exited = false;
    manager.spawn({
      sessionId: "victim",
      file: "bash",
      args: ["--noprofile", "--norc", "-c", "sleep 30"],
      cwd: process.cwd(),
      env: process.env,
    });
    manager.attach("victim", (e) => {
      if (e.type === "exit") exited = true;
    });

    expect(manager.kill("victim")).toBe(true);
    expect(manager.has("victim")).toBe(false);
    // The killed process exits; listeners were notified synchronously by kill().
    expect(exited).toBe(true);
  });
});

function output(events: PtyEvent[]): string {
  return events
    .filter((e): e is { type: "data"; data: string } => e.type === "data")
    .map((e) => e.data)
    .join("");
}

async function waitFor(pred: () => boolean, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, 20));
  }
}
