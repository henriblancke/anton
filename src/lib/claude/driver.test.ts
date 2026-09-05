/**
 * Headless claude driver (anton-dzh.3): stream-json parsing, event normalization, and
 * usage-limit detection against fake claude binaries (no network / no real claude needed).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { isRecoverableClaudeError, isUsageLimitError, type RecoverableClaudeError } from "../jobs/errors";
import { ABORT_GRACE_ENV, CLAUDE_BIN_ENV, runClaude, type ClaudeEvent, type RunClaudeOptions } from "./driver";

let dir: string;
let prevBin: string | undefined;

/** One stream-json event a fake claude writes to stdout; serialized by the fake factories. */
type FakeClaudeEvent = Record<string, unknown>;

function writeFakeClaude(name: string, events: FakeClaudeEvent[], exitCode = 0, stderr = ""): string {
  const path = join(dir, name);
  const body = [
    "#!/usr/bin/env node",
    `const lines = ${JSON.stringify(events.map((e) => JSON.stringify(e)))};`,
    "for (const l of lines) { process.stdout.write(l + \"\\n\"); }",
    `const stderr = ${JSON.stringify(stderr)};`,
    "if (stderr) { process.stderr.write(stderr); }",
    `process.exitCode = ${exitCode};`,
    "",
  ].join("\n");
  writeFileSync(path, body, "utf8");
  chmodSync(path, 0o755);
  return path;
}

/** A fake that emits `events`, then hangs forever without exiting — the wedged-session case. */
function writeFakeHangingClaude(name: string, events: FakeClaudeEvent[]): string {
  const path = join(dir, name);
  const body = [
    "#!/usr/bin/env node",
    `const lines = ${JSON.stringify(events.map((e) => JSON.stringify(e)))};`,
    "for (const l of lines) { process.stdout.write(l + \"\\n\"); }",
    "setInterval(() => {}, 1 << 30);", // never exits, never writes again
    "",
  ].join("\n");
  writeFileSync(path, body, "utf8");
  chmodSync(path, 0o755);
  return path;
}

/** A wedged Claude stand-in with a child process, proving the watchdog kills the whole tree. */
function writeFakeHangingClaudeWithChild(name: string, childPidPath: string): string {
  const path = join(dir, name);
  const body = [
    "#!/usr/bin/env node",
    "const { spawn } = require('node:child_process');",
    "const { writeFileSync } = require('node:fs');",
    "const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1 << 30)']);",
    `writeFileSync(${JSON.stringify(childPidPath)}, String(child.pid));`,
    "process.stdout.write(JSON.stringify({ type: 'system', subtype: 'init', session_id: 'sess-tree' }) + '\\n');",
    "setInterval(() => {}, 1 << 30);",
    "",
  ].join("\n");
  writeFileSync(path, body, "utf8");
  chmodSync(path, 0o755);
  return path;
}

/** Whether a pid is still around — asked with no grace period at all. */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForProcessExit(pid: number, timeoutMs = 2_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return false;
}

/**
 * A fake that traps SIGTERM and keeps working for `lingerMs` before exiting — the agent that is
 * SIGNALLED but not yet stopped. It writes `markerPath` on its way out, so a driver that settled on
 * the signal rather than on the exit is provable: the marker is absent when the promise rejects.
 */
function writeFakeLingeringClaude(name: string, markerPath: string, lingerMs: number): string {
  const path = join(dir, name);
  const body = [
    "#!/usr/bin/env node",
    "const { writeFileSync } = require('node:fs');",
    "process.on('SIGTERM', () => {",
    `  setTimeout(() => { writeFileSync(${JSON.stringify(markerPath)}, 'late'); process.exit(0); }, ${lingerMs});`,
    "});",
    "process.stdout.write(JSON.stringify({ type: 'system', subtype: 'init', session_id: 'sess-abort' }) + '\\n');",
    "setInterval(() => {}, 1 << 30);",
    "",
  ].join("\n");
  writeFileSync(path, body, "utf8");
  chmodSync(path, 0o755);
  return path;
}

/** A fake that ignores SIGTERM outright and writes its pid — only SIGKILL ends it. */
function writeFakeUnkillableClaude(name: string, pidPath: string): string {
  const path = join(dir, name);
  const body = [
    "#!/usr/bin/env node",
    "const { writeFileSync } = require('node:fs');",
    "process.on('SIGTERM', () => {});",
    `writeFileSync(${JSON.stringify(pidPath)}, String(process.pid));`,
    "process.stdout.write(JSON.stringify({ type: 'system', subtype: 'init', session_id: 'sess-kill' }) + '\\n');",
    "setInterval(() => {}, 1 << 30);",
    "",
  ].join("\n");
  writeFileSync(path, body, "utf8");
  chmodSync(path, 0o755);
  return path;
}

/**
 * A fake that exits promptly on SIGTERM but leaves behind a descendant that IGNORES it — the tool
 * process (a test runner, a formatter) still writing the worktree after claude has gone. Its stdio
 * is detached from claude's pipes, so nothing about it holds `close` back.
 */
function writeFakeClaudeWithStubbornChild(name: string, pidPath: string): string {
  const path = join(dir, name);
  const grandchild = [
    "process.on('SIGTERM', () => {});",
    `require('node:fs').writeFileSync(${JSON.stringify(pidPath)}, String(process.pid));`,
    "setInterval(() => {}, 1 << 30);",
  ].join("");
  const body = [
    "#!/usr/bin/env node",
    "const { spawn } = require('node:child_process');",
    `spawn(process.execPath, ['-e', ${JSON.stringify(grandchild)}], { stdio: 'ignore' });`,
    "process.on('SIGTERM', () => process.exit(0));",
    "process.stdout.write(JSON.stringify({ type: 'system', subtype: 'init', session_id: 'sess-group' }) + '\\n');",
    "setInterval(() => {}, 1 << 30);",
    "",
  ].join("\n");
  writeFileSync(path, body, "utf8");
  chmodSync(path, 0o755);
  return path;
}

/**
 * A fake that finishes its turn and EXITS at once, leaving a descendant holding its stdout open —
 * the window where the direct process is already gone but `close` has not fired yet. An abort that
 * lands here is never delivered to anything (node kills only a live child), so it produces no
 * `error` event and nothing but the signal itself says the session was cancelled.
 */
function writeFakeExitedClaudeHoldingPipe(name: string, holdMs: number): string {
  const path = join(dir, name);
  const events: FakeClaudeEvent[] = [
    { type: "system", subtype: "init", session_id: "sess-exited" },
    { type: "result", subtype: "success", result: "ANTON-RESULT: delivered", is_error: false },
  ];
  const body = [
    "#!/usr/bin/env node",
    "const { spawn } = require('node:child_process');",
    `const lines = ${JSON.stringify(events.map((e) => JSON.stringify(e)))};`,
    "for (const l of lines) { process.stdout.write(l + \"\\n\"); }",
    // Inherits stdout, so the driver's pipe stays open after this process is gone.
    `spawn(process.execPath, ['-e', 'setTimeout(() => {}, ${holdMs})'], { stdio: ['ignore', 1, 'ignore'] });`,
    "process.exit(0);",
    "",
  ].join("\n");
  writeFileSync(path, body, "utf8");
  chmodSync(path, 0o755);
  return path;
}

/** A fake that emits each event `gapMs` apart — slow but demonstrably alive. */
function writeFakeDripClaude(name: string, gapMs: number, events: FakeClaudeEvent[]): string {
  const path = join(dir, name);
  const body = [
    "#!/usr/bin/env node",
    `const lines = ${JSON.stringify(events.map((e) => JSON.stringify(e)))};`,
    `const gap = ${gapMs};`,
    "let i = 0;",
    "const t = setInterval(() => {",
    "  if (i >= lines.length) { clearInterval(t); return; }",
    "  process.stdout.write(lines[i++] + \"\\n\");",
    "}, gap);",
    "",
  ].join("\n");
  writeFileSync(path, body, "utf8");
  chmodSync(path, 0o755);
  return path;
}

/**
 * Arrange + act for every failure-path test: point the driver at `bin`, run it, and hand back the
 * error so each test asserts only on the classification it cares about. A call that RESOLVES is
 * itself a failure — surfacing that loudly beats leaving `caught` undefined and every downstream
 * matcher silently passing on it.
 */
async function runClaudeExpectingError(bin: string, opts: Partial<RunClaudeOptions> = {}): Promise<unknown> {
  process.env[CLAUDE_BIN_ENV] = bin;
  try {
    await runClaude({ cwd: dir, prompt: "do the thing", ...opts });
  } catch (err) {
    return err;
  }
  throw new Error(`expected runClaude to reject for ${basename(bin)}, but it resolved`);
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
      { type: "system", subtype: "init", session_id: "sess-1" },
      {
        type: "assistant",
        message: { content: [{ type: "text", text: "hello" }] },
      },
      {
        type: "result",
        subtype: "success",
        is_error: false,
        session_id: "sess-1",
        num_turns: 2,
        total_cost_usd: 0.01,
        result: "done",
      },
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

  it("refuses to spawn the real binary under vitest when ANTON_CLAUDE_BIN is unset", async () => {
    // A missing override under vitest must fail loud — never fall through to spawning the real,
    // billable `claude` against a temp worktree (anton-lixu). The guard runs before spawn(), so a
    // rejection here proves no process was launched; the error must name the env var to fix.
    const saved = process.env[CLAUDE_BIN_ENV];
    delete process.env[CLAUDE_BIN_ENV];
    try {
      await expect(runClaude({ cwd: dir, prompt: "do the thing" })).rejects.toThrow(CLAUDE_BIN_ENV);
    } finally {
      if (saved === undefined) delete process.env[CLAUDE_BIN_ENV];
      else process.env[CLAUDE_BIN_ENV] = saved;
    }
  });

  it("rejects with UsageLimitError (and a parsed resetAt) when claude reports an exhausted quota", async () => {
    const bin = writeFakeClaude(
      "limited-claude",
      [
        {
          type: "result",
          subtype: "error",
          is_error: true,
          result: "Claude AI usage limit reached|1700000000",
        },
      ],
      1,
    );

    const caught = await runClaudeExpectingError(bin);

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
        { type: "system", subtype: "init", session_id: "abc123", model: "claude-opus-4-8" },
        {
          type: "result",
          subtype: "error_during_execution",
          is_error: true,
          duration_ms: 4213,
          duration_api_ms: 3987,
          num_turns: 1,
          session_id: "abc123",
          total_cost_usd: 0,
          result: `Claude AI usage limit reached|${resetSec}`,
        },
      ],
      1,
    );

    const caught = await runClaudeExpectingError(bin);

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
        {
          type: "assistant",
          message: { content: [{ type: "text", text: `Claude AI usage limit reached|${resetSec}` }] },
        },
        { type: "result", subtype: "error", is_error: true, result: "error" },
      ],
      1,
    );

    const caught = await runClaudeExpectingError(bin);

    expect(isUsageLimitError(caught)).toBe(true);
    expect((caught as { resetAt?: number }).resetAt).toBe(resetSec);
  });

  it("throws UsageLimitError with no resetAt for the captured monthly spend-limit payload", async () => {
    // The exact wording captured on 2026-07-15 (run 36efe52b…): Claude Code surfaces a monthly
    // spend-limit hit as `You've hit your monthly spend limit · raise it at claude.ai/settings/usage`
    // with a non-zero exit and no reset timestamp. Before anton-b9l this slipped past USAGE_LIMIT_RE
    // (which only knew usage/5-hour/weekly wording), so the runner surfaced the plain stderr exit
    // error, burned maxAttempts, and parked. It must now route to UsageLimitError. Because the format
    // supplies no reset time, resetAt is undefined → the runner falls back to quotaCooloffMs and
    // refunds the attempt.
    const spendLimitText = "You've hit your monthly spend limit · raise it at claude.ai/settings/usage";
    const bin = writeFakeClaude(
      "spend-limited-claude",
      [
        { type: "system", subtype: "init", session_id: "sess-spend" },
        {
          type: "assistant",
          message: { content: [{ type: "text", text: spendLimitText }] },
        },
        {
          type: "result",
          subtype: "error_during_execution",
          is_error: true,
          session_id: "sess-spend",
          total_cost_usd: 0,
          result: spendLimitText,
        },
      ],
      1,
    );

    const caught = await runClaudeExpectingError(bin);

    expect(isUsageLimitError(caught)).toBe(true);
    // No parseable reset time → runner uses the fallback cool-off (quotaCooloffMs) and refunds.
    expect((caught as { resetAt?: number }).resetAt).toBeUndefined();
    expect((caught as Error).message).toContain("monthly spend limit");
  });

  it("throws UsageLimitError for the no-link monthly spend-limit banner (/usage-credits variant)", async () => {
    // anton-b9l review follow-up (PR #43): Claude Code 2.1.172 (anthropics/claude-code#67579)
    // surfaces the monthly quota with no claude.ai/settings/usage URL — the banner is
    // `You've hit your monthly spend limit.` followed on the next line by `/usage-credits …`.
    // The earlier monthly branch required the settings/usage link on the same line, so this
    // variant fell through as a plain `claude exited` error, burning attempts and parking. It
    // must now route to UsageLimitError via the `/usage-credits` remediation pointer.
    const spendLimitText = "You've hit your monthly spend limit.\n/usage-credits to check your usage and remaining credits";
    const bin = writeFakeClaude(
      "spend-limited-nolink-claude",
      [
        { type: "system", subtype: "init", session_id: "sess-nolink" },
        {
          type: "assistant",
          message: { content: [{ type: "text", text: spendLimitText }] },
        },
        {
          type: "result",
          subtype: "error_during_execution",
          is_error: true,
          session_id: "sess-nolink",
          total_cost_usd: 0,
          result: spendLimitText,
        },
      ],
      1,
    );

    const caught = await runClaudeExpectingError(bin);

    expect(isUsageLimitError(caught)).toBe(true);
    expect((caught as { resetAt?: number }).resetAt).toBeUndefined();
    expect((caught as Error).message).toContain("monthly spend limit");
  });

  it("does NOT misclassify a clean success whose transcript mentions a monthly spend limit", async () => {
    // Success false-positive guard, extended to the spend-limit wording (anton-b9l): a run that
    // exits 0 with is_error false is a success even if its output says "monthly spend limit" (e.g. an
    // agent working this very ticket). It must resolve, not throw UsageLimitError.
    const bin = writeFakeClaude("mentions-spend-limit-claude", [
      {
        type: "assistant",
        message: {
          content: [
            { type: "text", text: 'Made "monthly spend limit" reschedule instead of parking the job.' },
          ],
        },
      },
      {
        type: "result",
        subtype: "success",
        is_error: false,
        session_id: "sess-ok2",
        total_cost_usd: 0.01,
        result: "Implemented the monthly spend-limit detection and pushed.",
      },
    ]);
    process.env[CLAUDE_BIN_ENV] = bin;

    const result = await runClaude({ cwd: dir, prompt: "work the anton-b9l ticket" });

    expect(result.ok).toBe(true);
    expect(result.isError).toBe(false);
    expect(result.text).toBe("Implemented the monthly spend-limit detection and pushed.");
  });

  it("does NOT misclassify a non-zero exit whose transcript mentions the words 'monthly spend limit'", async () => {
    // anton-b9l narrowing: the matcher keys on the captured payload wording ("hit your monthly spend
    // limit"), not any occurrence of the bare words "monthly spend limit". A run that fails for an
    // unrelated reason (e.g. an agent working this very ticket, whose output describes the monthly
    // spend limit feature, whose tests or push then fail, exiting non-zero) must NOT be reclassified
    // as a quota hit — that would refund the attempt and reschedule the real failure forever. It must
    // surface as a plain error for a human.
    const bin = writeFakeClaude(
      "mentions-monthly-spend-limit-claude",
      [
        {
          type: "assistant",
          message: {
            content: [
              { type: "text", text: "Narrowed the monthly spend limit matcher, but the push failed." },
            ],
          },
        },
        {
          type: "result",
          subtype: "error_during_execution",
          is_error: true,
          session_id: "sess-bare",
          total_cost_usd: 0.01,
          result: "Narrowed the monthly spend limit matcher, but the push failed.",
        },
      ],
      1,
    );

    const caught = await runClaudeExpectingError(bin, { prompt: "work the anton-b9l ticket" });

    expect(isUsageLimitError(caught)).toBe(false);
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toContain("claude exited with code 1");
  });

  it("does NOT misclassify a non-zero exit that quotes the exact spend-limit payload mid-prose", async () => {
    // anton-b9l review follow-up: the spend-limit payload is an ordinary sentence a model can
    // reproduce verbatim — e.g. an agent working this very ticket says it "added a test for
    // 'You've hit your monthly spend limit'" and then its tests/push fail, exiting non-zero. The
    // phrase is present in both the assistant and result text, but embedded mid-sentence rather than
    // as Claude Code's own leading notice. Because USAGE_LIMIT_RE anchors to the start of a line, an
    // embedded quote does NOT match, so the run surfaces as a plain error for a human instead of
    // being refunded and rescheduled forever.
    const quoted = "Added a test for the \"You've hit your monthly spend limit\" payload, but the push failed.";
    const bin = writeFakeClaude(
      "quotes-spend-limit-payload-claude",
      [
        {
          type: "assistant",
          message: { content: [{ type: "text", text: quoted }] },
        },
        {
          type: "result",
          subtype: "error_during_execution",
          is_error: true,
          session_id: "sess-quote",
          total_cost_usd: 0.01,
          result: quoted,
        },
      ],
      1,
    );

    const caught = await runClaudeExpectingError(bin, { prompt: "work the anton-b9l ticket" });

    expect(isUsageLimitError(caught)).toBe(false);
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toContain("claude exited with code 1");
  });

  it("does NOT misclassify a non-zero exit that opens a line with the spend-limit phrase but no link", async () => {
    // anton-b9l review follow-up (PR #43): line-anchoring alone is not enough for the monthly-spend
    // wording — it's a whole English sentence a model can just as easily put at the *start* of a
    // line (a heading, a leading quote in a fixture) while discussing this very behavior. Here an
    // assistant block and the result field each begin with "You've hit your monthly spend limit"
    // but WITHOUT Claude Code's trailing `raise it at claude.ai/settings/usage` link, then the run
    // fails for an unrelated reason (exit 1). Because the monthly branch additionally requires that
    // link on the same line, this leading quote does NOT match, so the real failure surfaces as a
    // plain error for a human instead of being refunded and rescheduled forever.
    const heading = "You've hit your monthly spend limit — here's the fixture I added, but the tests fail.";
    const bin = writeFakeClaude(
      "spend-limit-heading-no-link-claude",
      [
        {
          type: "assistant",
          message: { content: [{ type: "text", text: heading }] },
        },
        {
          type: "result",
          subtype: "error_during_execution",
          is_error: true,
          session_id: "sess-heading",
          total_cost_usd: 0.01,
          result: heading,
        },
      ],
      1,
    );

    const caught = await runClaudeExpectingError(bin, { prompt: "work the anton-b9l ticket" });

    expect(isUsageLimitError(caught)).toBe(false);
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toContain("claude exited with code 1");
  });

  it("does NOT misclassify a non-zero exit that quotes the FULL no-link banner at line start in assistant prose", async () => {
    // anton-b9l review follow-up (PR #43, thread PRRT_kwDOTWcq...): the earlier guards (line-anchor
    // + required remediation pointer) still matched an agent that quotes the *whole* no-link banner
    // — including the `/usage-credits` pointer — at the start of a line while working this very code
    // path (e.g. adding a fixture), then fails for an unrelated reason. Because the model-authored
    // assistant transcript is no longer scanned for the monthly-spend wording (only Claude Code's
    // own result field + stderr are), this verbatim quote in an assistant block does NOT match. The
    // result field here is a generic failure summary with no banner, so the run surfaces as a plain
    // error for a human instead of being refunded and rescheduled forever.
    const quotedBanner =
      "You've hit your monthly spend limit.\n/usage-credits to check your usage and remaining credits\n\n" +
      "^ Added the above as a fixture for the no-link variant, but three tests still fail.";
    const bin = writeFakeClaude(
      "quotes-full-nolink-banner-claude",
      [
        {
          type: "assistant",
          message: { content: [{ type: "text", text: quotedBanner }] },
        },
        {
          type: "result",
          subtype: "error_during_execution",
          is_error: true,
          session_id: "sess-fullquote",
          total_cost_usd: 0.02,
          result: "3 tests failed in driver.test.ts; the push was rejected.",
        },
      ],
      1,
    );

    const caught = await runClaudeExpectingError(bin, { prompt: "work the anton-b9l ticket" });

    expect(isUsageLimitError(caught)).toBe(false);
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toContain("claude exited with code 1");
  });

  it("does NOT misclassify a non-zero exit whose RESULT field opens with the full no-link banner then adds failure prose", async () => {
    // anton-b9l review follow-up (PR #43, thread PRRT_kwDOTWcq...): the result field is ALSO
    // model-authored final text on an ordinary failed run, so excluding only the assistant
    // transcript was not enough — a leading quote of the full banner in the *result* field would
    // still match a loose scan. Here an agent working this very ticket makes its final result text
    // begin with the verbatim no-link banner (including the `/usage-credits` pointer) and then
    // reports that its own work failed. Because the result field is trusted for the spend-limit
    // wording ONLY when the banner is the WHOLE result (SPEND_LIMIT_RESULT_RE is end-anchored), the
    // trailing failure prose defeats the match, so the run surfaces as a plain error for a human
    // instead of being refunded and rescheduled forever.
    const resultText =
      "You've hit your monthly spend limit.\n/usage-credits to check your usage and remaining credits\n\n" +
      "^ Added the above as a fixture for the no-link variant, but three tests still fail.";
    const bin = writeFakeClaude(
      "result-quotes-full-nolink-banner-claude",
      [
        {
          type: "result",
          subtype: "error_during_execution",
          is_error: true,
          session_id: "sess-resultquote",
          total_cost_usd: 0.02,
          result: resultText,
        },
      ],
      1,
    );

    const caught = await runClaudeExpectingError(bin, { prompt: "work the anton-b9l ticket" });

    expect(isUsageLimitError(caught)).toBe(false);
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toContain("claude exited with code 1");
  });

  it("throws UsageLimitError for a genuine monthly spend-limit banner surfaced only on stderr", async () => {
    // anton-b9l review follow-up (PR #43): stderr is Claude Code's own diagnostic channel (the model
    // streams to stdout, never the process stderr), so the spend-limit banner there is trusted with
    // the loose matcher even when the result field is a generic error — a genuine abort that lands
    // the banner on stderr must still route to UsageLimitError so the runner reschedules.
    const bin = writeFakeClaude(
      "spend-limited-stderr-claude",
      [
        { type: "system", subtype: "init", session_id: "sess-spend-stderr" },
        {
          type: "result",
          subtype: "error_during_execution",
          is_error: true,
          session_id: "sess-spend-stderr",
          total_cost_usd: 0,
        },
      ],
      1,
      "You've hit your monthly spend limit · raise it at claude.ai/settings/usage\n",
    );

    const caught = await runClaudeExpectingError(bin);

    expect(isUsageLimitError(caught)).toBe(true);
    expect((caught as Error).message).toContain("monthly spend limit");
  });

  it("does NOT misclassify a clean success whose transcript merely mentions a usage limit", async () => {
    // Regression for the anton-ner.2 transcript-scan false positive: a run that exits 0 with
    // is_error false is a success, even if an assistant text block contains "usage limit reached"
    // (e.g. an agent working the anton-ner epic itself, editing these very comments/tests). Such a
    // run must resolve, not throw UsageLimitError — otherwise a completed run is rescheduled forever.
    const bin = writeFakeClaude("mentions-limit-claude", [
      {
        type: "assistant",
        message: {
          content: [
            { type: "text", text: 'Wrote the guard so "Claude AI usage limit reached" reschedules instead of parking.' },
          ],
        },
      },
      {
        type: "result",
        subtype: "success",
        is_error: false,
        session_id: "sess-ok",
        num_turns: 3,
        total_cost_usd: 0.02,
        result: "Implemented the 5-hour limit reached handling and pushed.",
      },
    ]);
    process.env[CLAUDE_BIN_ENV] = bin;

    const result = await runClaude({ cwd: dir, prompt: "work the anton-ner epic" });

    expect(result.ok).toBe(true);
    expect(result.isError).toBe(false);
    expect(result.text).toBe("Implemented the 5-hour limit reached handling and pushed.");
  });

  it("passes model, permission-mode, appendSystemPrompt, and allowedTools through as args", async () => {
    const bin = writeFakeClaude("args-claude", [
      {
        type: "result",
        is_error: false,
        session_id: "sess-2",
        result: "ok",
      },
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

  it("passes disallowedTools through as --disallowedTools, alongside bypassPermissions", async () => {
    // The review gate's guard against a reviewer writing git refs: deny rules bind even under
    // bypassPermissions, so BOTH flags must reach argv together for it to mean anything.
    const dumpPath = join(dir, "deny-argv-dump.json");
    const path = join(dir, "deny-argv-claude");
    writeFileSync(
      path,
      [
        "#!/usr/bin/env node",
        "const fs = require('node:fs');",
        `fs.writeFileSync(${JSON.stringify(dumpPath)}, JSON.stringify(process.argv.slice(2)));`,
        "process.stdout.write(JSON.stringify({ type: 'result', is_error: false, session_id: 'sess-deny', result: 'ok' }) + '\\n');",
        "",
      ].join("\n"),
      "utf8",
    );
    chmodSync(path, 0o755);
    process.env[CLAUDE_BIN_ENV] = path;

    const result = await runClaude({
      cwd: dir,
      prompt: "review the diff",
      permissionMode: "bypassPermissions",
      disallowedTools: ["Bash(git:*)", "Bash(gh:*)"],
    });

    expect(result.ok).toBe(true);
    const argv = JSON.parse(readFileSync(dumpPath, "utf8")) as string[];
    expect(argv[argv.indexOf("--disallowedTools") + 1]).toBe("Bash(git:*),Bash(gh:*)");
    expect(argv[argv.indexOf("--permission-mode") + 1]).toBe("bypassPermissions");
  });

  it("passes settingSources through as --setting-sources, and omits the flag when unset", async () => {
    // The review gate's guard against the branch under review configuring (and hooking) the session
    // that judges it: project/local settings come out of the worktree.
    const dumpPath = join(dir, "sources-argv-dump.json");
    const path = join(dir, "sources-argv-claude");
    writeFileSync(
      path,
      [
        "#!/usr/bin/env node",
        "const fs = require('node:fs');",
        `fs.writeFileSync(${JSON.stringify(dumpPath)}, JSON.stringify(process.argv.slice(2)));`,
        "process.stdout.write(JSON.stringify({ type: 'result', is_error: false, session_id: 'sess-src', result: 'ok' }) + '\\n');",
        "",
      ].join("\n"),
      "utf8",
    );
    chmodSync(path, 0o755);
    process.env[CLAUDE_BIN_ENV] = path;

    await runClaude({ cwd: dir, prompt: "review the diff", settingSources: ["user"] });
    let argv = JSON.parse(readFileSync(dumpPath, "utf8")) as string[];
    expect(argv[argv.indexOf("--setting-sources") + 1]).toBe("user");

    // Every other session keeps Claude Code's own default — the project's hooks are meant to apply
    // to an implementer.
    await runClaude({ cwd: dir, prompt: "implement the ticket" });
    argv = JSON.parse(readFileSync(dumpPath, "utf8")) as string[];
    expect(argv).not.toContain("--setting-sources");
  });

  it("delivers the task prompt on stdin and the system prompt via --append-system-prompt-file, with neither on argv (anton-14tj)", async () => {
    // The whole point of anton-14tj: no bead/contract text may land on the child's command line, so
    // `ps` during an autonomous run reveals neither. A fake that echoes its stdin and the contents of
    // the file named by --append-system-prompt-file proves both arrived by those channels, and that
    // argv carries neither the prompt body nor the system-prompt body (and never --append-system-prompt).
    const dumpPath = join(dir, "stdin-echo-dump.json");
    const path = join(dir, "stdin-echo-claude");
    const body = [
      "#!/usr/bin/env node",
      "const fs = require('node:fs');",
      "const a = process.argv.slice(2);",
      "const get = (f) => { const i = a.indexOf(f); return i >= 0 ? a[i + 1] : undefined; };",
      "const sysFile = get('--append-system-prompt-file');",
      "const append = sysFile ? fs.readFileSync(sysFile, 'utf8') : undefined;",
      "let stdin = '';",
      "process.stdin.setEncoding('utf8');",
      "process.stdin.on('data', (c) => { stdin += c; });",
      "process.stdin.on('end', () => {",
      `  fs.writeFileSync(${JSON.stringify(dumpPath)}, JSON.stringify({ stdin, append, argv: a }));`,
      "  process.stdout.write(JSON.stringify({ type: 'result', is_error: false, session_id: 'sess-stdin', result: 'ok' }) + '\\n');",
      "  process.exit(0);",
      "});",
      "",
    ].join("\n");
    writeFileSync(path, body, "utf8");
    chmodSync(path, 0o755);
    process.env[CLAUDE_BIN_ENV] = path;

    const promptBody = "PROMPT_MARKER_QZX implement ticket anton-14tj";
    const systemBody = "SYSTEM_MARKER_QZX operating contract for the run";
    const result = await runClaude({
      cwd: dir,
      prompt: promptBody,
      appendSystemPrompt: systemBody,
    });

    expect(result.ok).toBe(true);
    const dump = JSON.parse(readFileSync(dumpPath, "utf8")) as {
      stdin: string;
      append?: string;
      argv: string[];
    };
    // Both prompts arrived by their off-argv channel.
    expect(dump.stdin).toBe(promptBody);
    expect(dump.append).toBe(systemBody);
    // Neither body is visible on the command line, and the inline flag is never used.
    const joinedArgv = dump.argv.join(" ");
    expect(joinedArgv).not.toContain("PROMPT_MARKER_QZX");
    expect(joinedArgv).not.toContain("SYSTEM_MARKER_QZX");
    expect(dump.argv).not.toContain("--append-system-prompt");
    expect(dump.argv).toContain("--append-system-prompt-file");
  });

  it("surfaces a transient mid-stream death as a RecoverableClaudeError carrying the init session id (anton-juar)", async () => {
    // A run that emits the `system` init event (carrying session_id) and then dies mid-stream —
    // "Connection closed mid-response" on stderr, exit 1, NO final result event. The session id is
    // captured from init (not the missing result), and the failure classifies transient/resume-eligible.
    const bin = writeFakeClaude(
      "midstream-death-claude",
      [{ type: "system", subtype: "init", session_id: "sess-mid" }],
      1,
      "API Error: Connection closed mid-response\n",
    );

    const caught = await runClaudeExpectingError(bin);

    expect(isRecoverableClaudeError(caught)).toBe(true);
    expect((caught as { sessionId?: string }).sessionId).toBe("sess-mid");
    expect(isUsageLimitError(caught)).toBe(false);
  });

  it("classifies an is_error result on a clean exit as recoverable when the text is transient (anton-juar)", async () => {
    // Claude Code can surface a mid-stream drop as an error result that STILL exits 0 — e.g. a final
    // result with is_error:true and "Connection closed mid-response". The transient classification
    // must run here too (not only on non-zero exits), else it resolves { ok: false } → fresh restart
    // instead of an in-place resume.
    const bin = writeFakeClaude("iserror-exit0-claude", [
      { type: "system", subtype: "init", session_id: "sess-ie0" },
      {
        type: "result",
        subtype: "error",
        is_error: true,
        session_id: "sess-ie0",
        result: "API Error: Connection closed mid-response",
      },
    ]);

    const caught = await runClaudeExpectingError(bin);

    expect(isRecoverableClaudeError(caught)).toBe(true);
    expect((caught as { sessionId?: string }).sessionId).toBe("sess-ie0");
    expect((caught as { signature?: string }).signature).toBe("connection-closed");
  });

  it("resolves { ok: false } for an is_error result on a clean exit with no transient signal (anton-juar)", async () => {
    // A deterministic content failure that exits 0 with is_error:true — no network/transient phrasing.
    // It must stay a plain { ok: false } (runTicket throws → fresh restart), never a resume that would
    // replay bad state.
    const bin = writeFakeClaude("iserror-exit0-deterministic-claude", [
      { type: "system", subtype: "init", session_id: "sess-ie0d" },
      {
        type: "result",
        subtype: "error",
        is_error: true,
        session_id: "sess-ie0d",
        result: "the agent could not satisfy the acceptance criteria",
      },
    ]);
    process.env[CLAUDE_BIN_ENV] = bin;

    const result = await runClaude({ cwd: dir, prompt: "do the thing" });
    expect(result.ok).toBe(false);
    expect(result.isError).toBe(true);
  });

  it("classifies an exit-without-result (exit 0, no result event) as recoverable (anton-juar)", async () => {
    // A truncated/interrupted stream that exits cleanly but never emits the final result event is a
    // transient death — resume-eligible, carrying the init session id.
    const bin = writeFakeClaude("no-result-claude", [
      { type: "system", subtype: "init", session_id: "sess-noresult" },
      { type: "assistant", message: { content: [{ type: "text", text: "working" }] } },
    ]);

    const caught = await runClaudeExpectingError(bin);

    expect(isRecoverableClaudeError(caught)).toBe(true);
    expect((caught as { sessionId?: string }).sessionId).toBe("sess-noresult");
    expect((caught as { signature?: string }).signature).toBe("exit-without-result");
  });

  it("does NOT classify a deterministic non-zero exit (real result, no transient signal) as recoverable (anton-juar)", async () => {
    // The agent genuinely errored: a real result event, exit 1, no network/transient phrasing. This
    // must stay a plain Error so the runner does a fresh restart / park — resuming would replay bad state.
    const bin = writeFakeClaude(
      "deterministic-fail-claude",
      [
        { type: "system", subtype: "init", session_id: "sess-det" },
        {
          type: "result",
          subtype: "error_during_execution",
          is_error: true,
          session_id: "sess-det",
          result: "the tool call failed with a syntax error",
        },
      ],
      1,
    );

    const caught = await runClaudeExpectingError(bin);

    expect(isRecoverableClaudeError(caught)).toBe(false);
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toContain("claude exited with code 1");
  });

  it("does NOT resume when a model-authored result summary merely mentions an upstream status code (anton-juar)", async () => {
    // The agent's OWN final summary names a bare status code / generic upstream error as the reason a
    // deterministic task failed. That is model-authored prose, not a Claude Code transient, so the
    // broad status-code matcher must not fire on the result text — otherwise the real failure is lost
    // to an "interrupted" resume. It stays a plain Error → fresh restart, and the summary is surfaced.
    const bin = writeFakeClaude(
      "model-status-code-claude",
      [
        { type: "system", subtype: "init", session_id: "sess-mac" },
        {
          type: "result",
          subtype: "error_during_execution",
          is_error: true,
          session_id: "sess-mac",
          result: "The local endpoint returned 503 Service Unavailable; the migration could not run.",
        },
      ],
      1,
    );

    const caught = await runClaudeExpectingError(bin);

    expect(isRecoverableClaudeError(caught)).toBe(false);
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toContain("503 Service Unavailable");
  });

  it("still resumes when Claude Code's own stderr carries an upstream status code (anton-juar)", async () => {
    // The same status-code wording on Claude Code's OWN stderr channel IS a real transient — the broad
    // matcher stays in force there, so the run is resume-eligible.
    const bin = writeFakeClaude(
      "stderr-status-code-claude",
      [{ type: "system", subtype: "init", session_id: "sess-ssc" }],
      1,
      "API Error: 503 Service Unavailable\n",
    );

    const caught = await runClaudeExpectingError(bin);

    expect(isRecoverableClaudeError(caught)).toBe(true);
    expect((caught as { sessionId?: string }).sessionId).toBe("sess-ssc");
    expect((caught as { signature?: string }).signature).toBe("503");
  });

  it("passes --resume <id> through as an argument when resumeSessionId is set (anton-juar)", async () => {
    // The fake records its argv so we can assert the resume flag reached claude.
    const argvPath = join(dir, "resume-argv.json");
    const path = join(dir, "resume-claude");
    const body = [
      "#!/usr/bin/env node",
      `require('fs').writeFileSync(${JSON.stringify(argvPath)}, JSON.stringify(process.argv.slice(2)));`,
      `process.stdout.write(JSON.stringify({ type: 'result', is_error: false, session_id: 'sess-r', result: 'ok' }) + "\\n");`,
      "",
    ].join("\n");
    writeFileSync(path, body, "utf8");
    chmodSync(path, 0o755);
    process.env[CLAUDE_BIN_ENV] = path;

    const result = await runClaude({ cwd: dir, prompt: "continue", resumeSessionId: "sess-abc" });

    expect(result.ok).toBe(true);
    const argv: string[] = JSON.parse(readFileSync(argvPath, "utf8"));
    const i = argv.indexOf("--resume");
    expect(i).toBeGreaterThanOrEqual(0);
    expect(argv[i + 1]).toBe("sess-abc");
  });

  it("falls back to the last assistant text when a success omits the result field (anton-juar)", async () => {
    // A resumed run can finish is_error:false but omit the final `result` field, leaving the agent's
    // ANTON-RESULT self-report only in its last assistant message. Without the fallback, `text` would
    // be undefined and a `blocked` self-report on partial work would be lost — a false success.
    const bin = writeFakeClaude("resultless-success-claude", [
      { type: "system", subtype: "init", session_id: "sess-rl" },
      {
        type: "assistant",
        message: { content: [{ type: "text", text: "Could not finish.\nANTON-RESULT: blocked — schema mismatch" }] },
      },
      { type: "result", subtype: "success", is_error: false, session_id: "sess-rl" },
    ]);
    process.env[CLAUDE_BIN_ENV] = bin;

    const result = await runClaude({ cwd: dir, prompt: "continue", resumeSessionId: "sess-rl" });

    expect(result.ok).toBe(true);
    expect(result.text).toContain("ANTON-RESULT: blocked");
  });

  // anton-0oi: a session that wedges on a shell wait-loop emits nothing and looks alive until the
  // lease expires. Silence is the only available signal, so the watchdog kills on it — and resumes,
  // since work may already be banked and the caller escalates a repeated signature to a fresh run.
  it("kills a session that goes silent past stallTimeoutMs and reports it as resume-eligible", async () => {
    const bin = writeFakeHangingClaude("stalled-claude", [
      { type: "system", subtype: "init", session_id: "sess-stall" },
    ]);

    // stallTimeoutMs is comfortably longer than node's spawn time: the fake must get its init event
    // out before the watchdog fires, or this would assert on a session id that never arrived.
    const caught = await runClaudeExpectingError(bin, { prompt: "wedge", stallTimeoutMs: 1_500 });

    expect(isRecoverableClaudeError(caught)).toBe(true);
    const err = caught as RecoverableClaudeError;
    expect(err.signature).toBe("stalled");
    // The id from the `system` init event survives even though no result event ever arrived.
    expect(err.sessionId).toBe("sess-stall");
  });

  it.runIf(process.platform !== "win32")("kills descendants when a session stalls", async () => {
    const childPidPath = join(dir, "stalled-child.pid");
    const bin = writeFakeHangingClaudeWithChild("stalled-tree-claude", childPidPath);

    const caught = await runClaudeExpectingError(bin, { prompt: "wedge tree", stallTimeoutMs: 1_500 });
    expect(caught).toMatchObject({ signature: "stalled" });

    const childPid = Number(readFileSync(childPidPath, "utf8"));
    expect(await waitForProcessExit(childPid)).toBe(true);
  });

  // PR #228 review: the ticket-timeout path re-runs the verify gates and COMMITS the worktree as
  // soon as this promise settles, so settling on the SIGNAL rather than on the exit hands it a tree
  // the agent is still writing — an inconsistent commit, and later writes discarded with the run.
  it.runIf(process.platform !== "win32")(
    "waits for a cancelled session to actually exit before it settles",
    async () => {
      const marker = join(dir, "lingering-claude.marker");
      const bin = writeFakeLingeringClaude("lingering-claude", marker, 400);
      process.env[CLAUDE_BIN_ENV] = bin;
      const control = new AbortController();

      const run = runClaude({ cwd: dir, prompt: "cancel me", signal: control.signal });
      // Abort only once the fake is up and has trapped SIGTERM — before that it would die on the
      // default disposition and prove nothing.
      await new Promise((r) => setTimeout(r, 300));
      control.abort();

      await expect(run).rejects.toMatchObject({ name: "AbortError" });
      // The write the agent made AFTER the signal is on disk by the time the caller is told, which
      // is the whole property: nothing verifies or commits the tree until the writer has gone.
      expect(existsSync(marker)).toBe(true);
    },
  );

  it.runIf(process.platform !== "win32")(
    "escalates to SIGKILL for a cancelled session that ignores SIGTERM",
    async () => {
      const pidPath = join(dir, "unkillable-claude.pid");
      const bin = writeFakeUnkillableClaude("unkillable-claude", pidPath);
      process.env[CLAUDE_BIN_ENV] = bin;
      // Shrink the grace so the escalation lands inside the test rather than 10s later.
      process.env[ABORT_GRACE_ENV] = "300";
      const control = new AbortController();

      try {
        const run = runClaude({ cwd: dir, prompt: "trap sigterm", signal: control.signal });
        await new Promise((r) => setTimeout(r, 300));
        control.abort();

        await expect(run).rejects.toMatchObject({ name: "AbortError" });
        expect(await waitForProcessExit(Number(readFileSync(pidPath, "utf8")))).toBe(true);
      } finally {
        delete process.env[ABORT_GRACE_ENV];
      }
    },
  );

  // The same property one level down (PR #228 review): `close` on the direct child proves only that
  // CLAUDE exited. A tool process it spawned that ignores SIGTERM and holds none of its pipes is
  // still in the group, still writing the tree — so the rejection must wait for the group, not the
  // handle, or the timeout path commits a snapshot under active edit.
  it.runIf(process.platform !== "win32")(
    "waits for claude's descendants, not just claude, before a cancellation settles",
    async () => {
      const pidPath = join(dir, "stubborn-descendant.pid");
      const bin = writeFakeClaudeWithStubbornChild("group-claude", pidPath);
      process.env[CLAUDE_BIN_ENV] = bin;
      // Long enough that the grace timer cannot be what kills the descendant: only the escalation
      // the close handler delivers itself can end this inside the window below.
      process.env[ABORT_GRACE_ENV] = "5000";
      const control = new AbortController();

      try {
        const run = runClaude({ cwd: dir, prompt: "cancel my tree", signal: control.signal });
        await new Promise((r) => setTimeout(r, 400));
        control.abort();

        await expect(run).rejects.toMatchObject({ name: "AbortError" });
        // Asked the instant the caller is told, with no waiting: by then the writer must be gone.
        expect(alive(Number(readFileSync(pidPath, "utf8")))).toBe(false);
      } finally {
        delete process.env[ABORT_GRACE_ENV];
      }
    },
  );

  // PR #228 review: node delivers an abort only to a LIVE child, so one arriving after claude has
  // exited — while a descendant still holds its stdout and `close` is pending — emits no `error`
  // at all. Read from the `error` alone, the cancellation would vanish and the session would settle
  // as an ordinary success: on a formula with no verify step nothing downstream consumes the
  // signal, and the commit step would commit a cancelled ticket and update its bead.
  it.runIf(process.platform !== "win32")(
    "rejects a session cancelled after the process exited, with no child error to read it from",
    async () => {
      const bin = writeFakeExitedClaudeHoldingPipe("exited-claude", 3_000);
      process.env[CLAUDE_BIN_ENV] = bin;
      const control = new AbortController();

      const run = runClaude({ cwd: dir, prompt: "cancel after exit", signal: control.signal });
      // Long enough for the fake to have finished and exited, short enough that its descendant is
      // still holding the pipe: the window where only the signal knows the run was cancelled.
      await new Promise((r) => setTimeout(r, 500));
      control.abort();

      await expect(run).rejects.toMatchObject({ name: "AbortError" });
    },
  );

  it("does not kill a slow session that keeps emitting output", async () => {
    // Liveness is any byte, not a completed turn. The budget must exceed node's spawn time plus one
    // gap — not the whole run — so keep the gap well under it and let the total (3 gaps) exceed it:
    // that is what proves the timer is REARMED per chunk rather than bounding the session.
    const bin = writeFakeDripClaude("drip-claude", 600, [
      { type: "system", subtype: "init", session_id: "sess-drip" },
      { type: "assistant", message: { content: [{ type: "text", text: "working" }] } },
      { type: "result", subtype: "success", is_error: false, session_id: "sess-drip", result: "done" },
    ]);
    process.env[CLAUDE_BIN_ENV] = bin;

    // 3 gaps of 600ms = 1.8s of runtime under a 1.5s budget — the session outlives the timeout while
    // no single silence does. That gap is the whole point: a session-length timer kills this, a
    // per-chunk rearm lets it finish.
    const result = await runClaude({ cwd: dir, prompt: "slow but alive", stallTimeoutMs: 1_500 });

    expect(result.ok).toBe(true);
    expect(result.text).toBe("done");
  });
});
