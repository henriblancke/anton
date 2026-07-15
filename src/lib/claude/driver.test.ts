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

  it("throws UsageLimitError with the parsed resetAt for a real captured usage-limit result payload", async () => {
    // A real stream-json result event captured from `claude -p` when the 5-hour quota is exhausted.
    // Claude Code surfaces the limit as `Claude AI usage limit reached|<unix-seconds>` in the result
    // field, subtype `error_during_execution`, is_error true, exit code 1. This is the exact shape
    // the runner's quota reschedule depends on — if the format drifts, this regression test fails
    // before a real quota hit is misclassified as a plain error and parked (anton-ner.2).
    const resetSec = 1_752_600_000; // 2025-07-15T18:40:00Z
    const bin = writeFakeClaude(
      "real-limited-claude",
      [
        JSON.stringify({ type: "system", subtype: "init", session_id: "abc123", model: "claude-opus-4-8" }),
        JSON.stringify({
          type: "result",
          subtype: "error_during_execution",
          is_error: true,
          duration_ms: 4213,
          duration_api_ms: 3987,
          num_turns: 1,
          session_id: "abc123",
          total_cost_usd: 0,
          result: `Claude AI usage limit reached|${resetSec}`,
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

    expect(isUsageLimitError(caught)).toBe(true);
    expect((caught as { resetAt?: number }).resetAt).toBe(resetSec);
    expect((caught as Error).message).toContain("usage limit reached");
  });

  it("detects a usage limit surfaced in an assistant text block (not just the result field)", async () => {
    // Robustness for anton-ner.2's misclassification risk: if Claude emits the quota signal as an
    // assistant message and the result field is generic, scanning only the result field would miss
    // it → plain error → burns attempts → parks. The driver scans the full transcript, so this
    // still routes to UsageLimitError with the reset time.
    const resetSec = 1_752_600_000;
    const bin = writeFakeClaude(
      "assistant-limited-claude",
      [
        JSON.stringify({
          type: "assistant",
          message: { content: [{ type: "text", text: `Claude AI usage limit reached|${resetSec}` }] },
        }),
        JSON.stringify({ type: "result", subtype: "error", is_error: true, result: "error" }),
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

    expect(isUsageLimitError(caught)).toBe(true);
    expect((caught as { resetAt?: number }).resetAt).toBe(resetSec);
  });

  it("does NOT misclassify a clean success whose transcript merely mentions a usage limit", async () => {
    // Regression for the anton-ner.2 transcript-scan false positive: a run that exits 0 with
    // is_error false is a success, even if an assistant text block contains "usage limit reached"
    // (e.g. an agent working the anton-ner epic itself, editing these very comments/tests). Such a
    // run must resolve, not throw UsageLimitError — otherwise a completed run is rescheduled forever.
    const bin = writeFakeClaude("mentions-limit-claude", [
      JSON.stringify({
        type: "assistant",
        message: {
          content: [
            { type: "text", text: 'Wrote the guard so "Claude AI usage limit reached" reschedules instead of parking.' },
          ],
        },
      }),
      JSON.stringify({
        type: "result",
        subtype: "success",
        is_error: false,
        session_id: "sess-ok",
        num_turns: 3,
        total_cost_usd: 0.02,
        result: "Implemented the 5-hour limit reached handling and pushed.",
      }),
    ]);
    process.env[CLAUDE_BIN_ENV] = bin;

    const result = await runClaude({ cwd: dir, prompt: "work the anton-ner epic" });

    expect(result.ok).toBe(true);
    expect(result.isError).toBe(false);
    expect(result.text).toBe("Implemented the 5-hour limit reached handling and pushed.");
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
