/**
 * anton-qbz.1: the SSE tail. These exercise the log-following generator directly (no HTTP): the
 * replay-then-follow behavior, the terminal `end` after a session goes done, live appends being
 * picked up, and clean abort on client disconnect.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { appendFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { tailSessionLog, type LogChunk } from "./sessions";

let dir: string;
let logPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "anton-tail-"));
  logPath = join(dir, "session.log");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** Drain a tail generator into a flat list of chunks (bounded by its own `end`/abort). */
async function drain(gen: AsyncGenerator<LogChunk>): Promise<LogChunk[]> {
  const out: LogChunk[] = [];
  for await (const c of gen) out.push(c);
  return out;
}

describe("tailSessionLog", () => {
  it("replays an existing finished log then emits end", async () => {
    await writeFile(logPath, "[assistant] done\n");
    const chunks = await drain(
      tailSessionLog(logPath, { isDone: async () => true, pollMs: 10 }),
    );
    expect(chunks).toEqual([
      { type: "data", text: "[assistant] done\n" },
      { type: "end" },
    ]);
  });

  it("emits end even when no log file was ever created", async () => {
    const chunks = await drain(
      tailSessionLog(logPath, { isDone: async () => true, pollMs: 10 }),
    );
    expect(chunks).toEqual([{ type: "end" }]);
  });

  it("follows live appends, then ends when the session goes terminal", async () => {
    await writeFile(logPath, "[system] init\n");

    // Session is running until we flip this after the first append lands.
    let running = true;
    const gen = tailSessionLog(logPath, {
      isDone: async () => !running,
      pollMs: 10,
    });

    const chunks: LogChunk[] = [];
    const collector = (async () => {
      for await (const c of gen) chunks.push(c);
    })();

    // Give the first read a tick, append more, then let it flush and finish.
    await new Promise((r) => setTimeout(r, 30));
    await appendFile(logPath, "[assistant] working\n");
    await new Promise((r) => setTimeout(r, 30));
    running = false;
    await collector;

    const text = chunks
      .filter((c): c is { type: "data"; text: string } => c.type === "data")
      .map((c) => c.text)
      .join("");
    expect(text).toContain("[system] init\n");
    expect(text).toContain("[assistant] working\n");
    expect(chunks.at(-1)).toEqual({ type: "end" });
  });

  it("stops promptly when the client aborts (never terminal)", async () => {
    await writeFile(logPath, "[system] init\n");
    const ctrl = new AbortController();
    const gen = tailSessionLog(logPath, {
      isDone: async () => false, // never finishes on its own
      signal: ctrl.signal,
      pollMs: 10,
    });

    const chunks: LogChunk[] = [];
    const collector = (async () => {
      for await (const c of gen) chunks.push(c);
    })();

    await new Promise((r) => setTimeout(r, 30));
    ctrl.abort();
    await collector;

    // Got the replay, and no terminal `end` (aborted, not finished).
    expect(chunks.some((c) => c.type === "data")).toBe(true);
    expect(chunks.some((c) => c.type === "end")).toBe(false);
  });
});
