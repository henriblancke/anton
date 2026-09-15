/**
 * The driver's exit classification (anton-kvag). The ORDER of these checks is the contract the
 * runner's durability logic rests on — a stall outranks everything, a quota hit outranks the exit
 * code — so each test here pins one rung of that ladder.
 */
import { describe, expect, it } from "vitest";
import {
  isPoisonError,
  isRecoverableClaudeError,
  isUsageLimitError,
  type RecoverableClaudeError,
} from "../jobs/errors";
import { createStreamState, type StreamState } from "./driver-events";
import { exitError, toClaudeResult, transientSignature, type ClaudeExit } from "./driver-exit";

function stream(overrides: Partial<StreamState> = {}): StreamState {
  return { ...createStreamState(), ...overrides };
}

function exit(overrides: Partial<ClaudeExit> = {}): ClaudeExit {
  return { code: 0, stalled: false, stallMs: 60_000, stderr: "", stream: stream(), ...overrides };
}

const recoverable = (err: Error | null) => err as RecoverableClaudeError;

describe("exitError", () => {
  it("returns null for a clean run that emitted a result", () => {
    expect(exitError(exit({ stream: stream({ resultRaw: { type: "result", result: "done" } }) }))).toBeNull();
  });

  it("reports a stall first, and resumes from the id captured at session start", () => {
    // A stalled run is killed, so it also looks like a signal death — the stall must win, or the
    // runner reports a bare "exited with code null" for a hang (anton-0oi).
    const err = exitError(
      exit({ code: null, stalled: true, stallMs: 120_000, stream: stream({ initSessionId: "sess-1" }) }),
    );

    expect(isRecoverableClaudeError(err)).toBe(true);
    expect(recoverable(err).signature).toBe("stalled");
    expect(recoverable(err).sessionId).toBe("sess-1");
    expect(err?.message).toContain("no output for 2m");
  });

  it("reports a quota hit ahead of the exit code, so it never burns an attempt", () => {
    const err = exitError(
      exit({
        code: 1,
        stream: stream({ resultRaw: { type: "result", is_error: true, result: "Claude AI usage limit reached|1700000000" } }),
      }),
    );

    expect(isUsageLimitError(err)).toBe(true);
    expect((err as { resetAt?: number }).resetAt).toBe(1700000000);
  });

  it("never reclassifies a clean success that merely mentions a usage limit", () => {
    const err = exitError(
      exit({
        stream: stream({
          transcript: "usage limit reached\n",
          resultRaw: { type: "result", is_error: false, result: "edited the usage-limit docs" },
        }),
      }),
    );

    expect(err).toBeNull();
  });

  it("makes a deterministic non-zero exit a plain Error, preferring the agent's own summary", () => {
    const err = exitError(
      exit({
        code: 2,
        stderr: "some noise",
        stream: stream({ resultRaw: { type: "result", is_error: true, result: "three tests fail" } }),
      }),
    );

    expect(isRecoverableClaudeError(err)).toBe(false);
    expect(err?.message).toBe("claude exited with code 2: three tests fail");
  });

  it("parks a nonexistent/inaccessible model id on the first attempt, naming it and where it's configured (anton-ggf6)", () => {
    // Observed verbatim in anton.db — Claude Code's own refusal when --model doesn't resolve.
    const err = exitError(
      exit({
        code: 1,
        stderr:
          "There's an issue with the selected model (claude-opus-4-8). It may not exist or you may not have access to it. Run --model to pick a different model.",
      }),
    );

    expect(isPoisonError(err)).toBe(true);
    expect(isRecoverableClaudeError(err)).toBe(false);
    expect(err?.message).toContain("claude-opus-4-8");
    expect(err?.message).toContain("General default model");
    expect(err?.message).toContain("settings_json.modelRoutes");
  });

  it("still retries a transient 5xx from the same endpoint rather than parking (anton-ggf6)", () => {
    const err = exitError(
      exit({
        code: 1,
        stderr: "API Error: 503 Service Unavailable",
      }),
    );

    expect(isPoisonError(err)).toBe(false);
    expect(isRecoverableClaudeError(err)).toBe(true);
  });

  it("classifies a gateway [402] billing stop as a quota hit, not a resumed transient (anton-x96g)", () => {
    // Observed verbatim in .anton/sessions/*.log for PR #238 and #252: OpenRouter's billing stop
    // arrives wrapped in a 503 envelope, which otherwise matches TRANSIENT_STDERR_RE's bare `503`
    // and gets resumed against a wall that never moves. Quota must win ahead of the exit-code path.
    const err = exitError(
      exit({
        code: 1,
        stderr:
          'API Error: 503 [openrouter/anthropic/claude-sonnet-5] [402]: {"error":{"message":"This request requires more credits, or fewer max_tokens.","code":402}}',
      }),
    );

    expect(isUsageLimitError(err)).toBe(true);
    expect(isRecoverableClaudeError(err)).toBe(false);
  });

  it("still resumes a genuine gateway 503 with no [402] inside as transient (anton-x96g)", () => {
    const err = exitError(
      exit({
        code: 1,
        stderr: "API Error: 503 [openrouter/anthropic/claude-sonnet-5] Service Unavailable",
      }),
    );

    expect(isUsageLimitError(err)).toBe(false);
    expect(isRecoverableClaudeError(err)).toBe(true);
    expect(recoverable(err).signature).toBe("503");
  });

  it("classifies a rate_limit_error [429] as a quota hit, not a resumed transient (anton-h8z4)", () => {
    // Observed verbatim in anton.db (anton-fmlb): three consecutive RESUMEs in ~60s against a wall
    // that never moved, because the bare `429` in this envelope also matches TRANSIENT_STDERR_RE.
    const err = exitError(
      exit({
        code: 1,
        stderr:
          'API Error: 503 [claude/claude-opus-5] [429]: {"type":"error","error":{"type":"rate_limit_error","message":"This request would exceed your (reset after 2m 41s)."}}',
      }),
    );

    expect(isUsageLimitError(err)).toBe(true);
    expect(isRecoverableClaudeError(err)).toBe(false);
  });

  it("makes a transient non-zero exit resume-eligible, signed by its cause", () => {
    const err = exitError(
      exit({
        code: 1,
        stderr: "Error: socket hang up",
        stream: stream({ initSessionId: "sess-2", resultRaw: { type: "result", is_error: true } }),
      }),
    );

    expect(isRecoverableClaudeError(err)).toBe(true);
    expect(recoverable(err).signature).toBe("socket-hang-up");
    expect(recoverable(err).sessionId).toBe("sess-2");
  });

  it("treats a clean exit with no result event as a truncated stream", () => {
    const err = exitError(exit({ stream: stream({ initSessionId: "sess-3" }) }));

    expect(isRecoverableClaudeError(err)).toBe(true);
    expect(recoverable(err).signature).toBe("exit-without-result");
    expect(recoverable(err).sessionId).toBe("sess-3");
  });

  it("resumes an is_error result that names a transient cause, but not a real failure", () => {
    const transient = exitError(
      exit({
        stream: stream({ resultRaw: { type: "result", is_error: true, session_id: "sess-4", result: "Connection closed mid-response" } }),
      }),
    );
    expect(isRecoverableClaudeError(transient)).toBe(true);
    expect(recoverable(transient).sessionId).toBe("sess-4");

    // An agent-authored failure that merely mentions a status code stays a result the caller sees
    // as `{ ok: false }` — resuming it would paper over a real failure (anton-juar).
    const real = exitError(
      exit({ stream: stream({ resultRaw: { type: "result", is_error: true, result: "the local endpoint returned 500" } }) }),
    );
    expect(real).toBeNull();
  });
});

describe("transientSignature", () => {
  it("scans stderr broadly and the model-authored result narrowly", () => {
    expect(transientSignature("", "upstream returned 503", true)).toBe("503");
    expect(transientSignature("the endpoint returned 503", "", true)).toBeNull();
    expect(transientSignature("Connection closed mid-response", "", true)).toBe("connection-closed");
  });

  it("treats a missing result event as transient on its own", () => {
    expect(transientSignature("", "", false)).toBe("exit-without-result");
    expect(transientSignature("", "", true)).toBeNull();
  });
});

describe("toClaudeResult", () => {
  it("maps the result line, ignoring fields of the wrong shape", () => {
    expect(
      toClaudeResult(
        stream({
          resultRaw: {
            type: "result",
            is_error: false,
            session_id: "sess-5",
            num_turns: 3,
            total_cost_usd: 0.25,
            result: "done",
          },
        }),
      ),
    ).toEqual({
      ok: true,
      sessionId: "sess-5",
      numTurns: 3,
      costUsd: 0.25,
      modelUsage: [],
      durationMs: undefined,
      durationApiMs: undefined,
      text: "done",
      isError: false,
    });

    expect(toClaudeResult(stream({ resultRaw: { type: "result", num_turns: "3" } }))).toMatchObject({
      numTurns: undefined,
      costUsd: undefined,
    });
  });

  it("carries the per-model usage and the durations the result reported (anton-77l9)", () => {
    const result = toClaudeResult(
      stream({
        resultRaw: {
          type: "result",
          is_error: false,
          num_turns: 37,
          duration_ms: 4_368_913,
          duration_api_ms: 444_789,
          modelUsage: {
            "claude-haiku-4-5-20251001": { inputTokens: 1820, outputTokens: 28 },
            "claude-opus-5[1m]": { inputTokens: 438, outputTokens: 29177, thinkingTokens: 10732 },
          },
        },
      }),
    );

    expect(result.modelUsage).toEqual([
      { model: "claude-haiku-4-5-20251001", inputTokens: 1820, outputTokens: 28 },
      { model: "claude-opus-5[1m]", inputTokens: 438, outputTokens: 29177, thinkingTokens: 10732 },
    ]);
    expect(result.durationMs).toBe(4_368_913);
    expect(result.durationApiMs).toBe(444_789);
  });

  it("reports unknown usage rather than throwing on a result that omits or garbles modelUsage", () => {
    // Claude Code omits the field entirely on a crash/startup-error result, and a gateway can
    // return something else in its place. Neither may cost the caller its result.
    expect(toClaudeResult(stream({ resultRaw: { type: "result" } })).modelUsage).toEqual([]);
    expect(
      toClaudeResult(stream({ resultRaw: { type: "result", modelUsage: "lots" } })).modelUsage,
    ).toEqual([]);
    expect(
      toClaudeResult(stream({ resultRaw: { type: "result", duration_ms: "9s" } })).durationMs,
    ).toBeUndefined();
  });

  it("falls back to the last assistant text only when the result field is absent", () => {
    expect(toClaudeResult(stream({ resultRaw: { type: "result" }, lastAssistantText: "ANTON-RESULT: delivered" })).text).toBe(
      "ANTON-RESULT: delivered",
    );
    // An empty result field is still the agent's answer — it must not be replaced.
    expect(toClaudeResult(stream({ resultRaw: { type: "result", result: "" }, lastAssistantText: "earlier" })).text).toBe("");
  });
});
