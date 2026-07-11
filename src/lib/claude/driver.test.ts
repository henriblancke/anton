/**
 * Headless claude driver (anton-dzh.3): stream-json parsing, event normalization, and
 * usage-limit detection against fake claude binaries (no network / no real claude needed).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isUsageLimitError } from "../jobs/errors";
import { CLAUDE_BIN_ENV, runClaude, type ClaudeEvent } from "./driver";

let dir: string;
let prevBin: string | undefined;

function writeFakeClaude(name: string, ndjsonLines: string[], exitCode = 0): string {
  const path = join(dir, name);
  const body = [
    "#!/usr/bin/env node",
    `const lines = ${JSON.stringify(ndjsonLines)};`,
    "for (const l of lines) { process.stdout.write(l + \"\\n\"); }",
    `process.exitCode = ${exitCode};`,
    "",
  ].join("\n");
  writeFileSync(path, body, "utf8");
  chmodSync(path, 0o755);
  return path;
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "anton-fake-claude-"));
  prevBin = process.env[CLAUDE_BIN_ENV];
});

afterAll(() => {
  if (prevBin === undefined) delete process.env[CLAUDE_BIN_ENV];
  else process.env[CLAUDE_BIN_ENV] = prevBin;
  rmSync(dir, { recursive: true, force: true });
});

describe("runClaude", () => {
  it("resolves the final result and streams normalized events on the happy path", async () => {
    const bin = writeFakeClaude("happy-claude", [
      JSON.stringify({ type: "system", subtype: "init", session_id: "sess-1" }),
      JSON.stringify({
        type: "assistant",
        message: { content: [{ type: "text", text: "hello" }] },
      }),
      JSON.stringify({
        type: "result",
        subtype: "success",
        is_error: false,
        session_id: "sess-1",
        num_turns: 2,
        total_cost_usd: 0.01,
        result: "done",
      }),
    ]);
    process.env[CLAUDE_BIN_ENV] = bin;

    const events: ClaudeEvent[] = [];
    const result = await runClaude({
      cwd: dir,
      prompt: "do the thing",
      onEvent: (e) => events.push(e),
    });

    expect(result.ok).toBe(true);
    expect(result.isError).toBe(false);
    expect(result.text).toBe("done");
    expect(result.sessionId).toBe("sess-1");
    expect(result.numTurns).toBe(2);
    expect(result.costUsd).toBe(0.01);

    expect(events.some((e) => e.type === "assistant" && e.text === "hello")).toBe(true);
    expect(events.some((e) => e.type === "result" && e.text === "done")).toBe(true);
    expect(events.some((e) => e.type === "system")).toBe(true);
  });

  it("rejects with UsageLimitError (and a parsed resetAt) when claude reports an exhausted quota", async () => {
    const bin = writeFakeClaude(
      "limited-claude",
      [
        JSON.stringify({
          type: "result",
          subtype: "error",
          is_error: true,
          result: "Claude AI usage limit reached|1700000000",
        }),
      ],
      1,
    );
    process.env[CLAUDE_BIN_ENV] = bin;

    let caught: unknown;
    try {
      await runClaude({ cwd: dir, prompt: "do the thing" });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeDefined();
    expect(isUsageLimitError(caught)).toBe(true);
    expect((caught as { resetAt?: number }).resetAt).toBe(1700000000);
  });

  it("passes model, permission-mode, appendSystemPrompt, and allowedTools through as args", async () => {
    const bin = writeFakeClaude("args-claude", [
      JSON.stringify({
        type: "result",
        is_error: false,
        session_id: "sess-2",
        result: "ok",
      }),
    ]);
    process.env[CLAUDE_BIN_ENV] = bin;

    const result = await runClaude({
      cwd: dir,
      prompt: "do the thing",
      model: "sonnet",
      appendSystemPrompt: "extra instructions",
      permissionMode: "acceptEdits",
      allowedTools: ["Read", "Write"],
    });

    expect(result.ok).toBe(true);
    expect(result.text).toBe("ok");
  });
});
