/**
 * The driver's quota seam (anton-kvag): which channel is trusted to say "usage limit" and how the
 * reset time is read back. The asymmetry is the point — a terse machine banner is trusted anywhere,
 * the model-reproducible spend-limit sentence only where a model could not have authored it.
 */
import { describe, expect, it } from "vitest";
import { parseResetAt, usageLimitError, type ClaudeChannels } from "./driver-limits";

const EMPTY: ClaudeChannels = { transcript: "", resultText: "", stderr: "" };
const channels = (overrides: Partial<ClaudeChannels>): ClaudeChannels => ({ ...EMPTY, ...overrides });

const SPEND_BANNER = "You've hit your monthly spend limit · raise it at claude.ai/settings/usage";

// Observed verbatim in anton.db escalations.evidence_json (anton-2gsj): three consecutive
// autopilot-disarm and exhausted-job entries, all parked on this exact banner.
const SESSION_LIMIT_BANNER = "You've hit your session limit · resets 9pm (America/New_York)";

// Observed verbatim in anton.db escalations.evidence_json (anton-2gsj): repeated exhausted-job
// entries for parked review-fix jobs.
const USAGE_CREDITS_BANNER =
  "You're out of usage credits. Switch to another model, or manage usage credits at claude.ai/settings/usage?from=cc_cli_limit_message, to continue.";

// Observed verbatim in .anton/sessions/*.log for PR #238 and #252 (anton-x96g): OpenRouter's
// billing stop, delivered inside a 503 envelope that otherwise matches driver-exit.ts's bare `503`
// transient regex.
const GATEWAY_402_ENVELOPE =
  'API Error: 503 [openrouter/anthropic/claude-sonnet-5] [402]: {"error":{"message":"This request requires more credits, or fewer max_tokens.","code":402}}';

// Observed verbatim in anton.db escalations.evidence_json (anton-fmlb, 2026-09-09 21:49/21:51/21:52):
// three consecutive RESUMEs against a wall that never moved because the bare `429` inside this
// envelope also matches driver-exit.ts's TRANSIENT_STDERR_RE.
const RATE_LIMIT_429_ENVELOPE =
  'API Error: 503 [claude/claude-opus-5] [429]: {"type":"error","error":{"type":"rate_limit_error","message":"This request would exceed your (reset after 2m 41s)."}}';

describe("parseResetAt", () => {
  it("reads the trailing epoch stamp, normalizing milliseconds to seconds", () => {
    expect(parseResetAt("Claude AI usage limit reached|1700000000")).toBe(1700000000);
    expect(parseResetAt("Claude AI usage limit reached|1700000000000")).toBe(1700000000);
  });

  it("falls back to 'resets at <when>', then to any ISO timestamp", () => {
    expect(parseResetAt("5-hour limit reached; resets at 2026-01-02T03:04:05Z")).toBe(
      Math.floor(Date.parse("2026-01-02T03:04:05Z") / 1000),
    );
    expect(parseResetAt("limit reached, back at 2026-01-02T03:04:05Z")).toBe(
      Math.floor(Date.parse("2026-01-02T03:04:05Z") / 1000),
    );
  });

  it("answers undefined for missing or unparseable text rather than guessing", () => {
    expect(parseResetAt(undefined)).toBeUndefined();
    expect(parseResetAt("usage limit reached; resets at some point soon")).toBeUndefined();
  });

  // 2026-01-15T10:00:00Z = 2026-01-15 05:00 America/New_York (EST, UTC-5) — well before 9pm today,
  // so the zoned form below resolves to *today's* 9pm and stays comfortably in the future.
  const NOW_MS = Date.parse("2026-01-15T10:00:00Z");

  it.each([
    {
      name: "clock-time prose with an explicit IANA zone",
      text: "resets 9pm (America/New_York)",
      expected: Math.floor(Date.parse("2026-01-16T02:00:00Z") / 1000), // 21:00 EST = 02:00Z next day
    },
    {
      name: "relative duration prose",
      text: "(reset after 2m 41s)",
      expected: Math.floor(NOW_MS / 1000) + 161,
    },
  ])("parses $name against an injected clock", ({ text, expected }) => {
    const resetAt = parseResetAt(text, NOW_MS);
    expect(resetAt).toBe(expected);
    expect(resetAt).toBeGreaterThan(Math.floor(NOW_MS / 1000));
  });

  it("rolls the zoned clock-time form to tomorrow once today's time has already passed", () => {
    // 2026-01-16T03:00:00Z = 2026-01-15 22:00 EST — an hour past today's 9pm in that zone.
    const afterNineMs = Date.parse("2026-01-16T03:00:00Z");
    expect(parseResetAt("resets 9pm (America/New_York)", afterNineMs)).toBe(
      Math.floor(Date.parse("2026-01-17T02:00:00Z") / 1000), // tomorrow's 21:00 EST
    );
  });

  it("yields undefined for an unparseable reset, leaving the runner's own cooloff to apply", () => {
    expect(parseResetAt("(reset shortly)", NOW_MS)).toBeUndefined();
  });
});

describe("usageLimitError", () => {
  it("trusts the terse banner in any channel, and carries the parsed resetAt", () => {
    const fromResult = usageLimitError(channels({ resultText: "Claude AI usage limit reached|1700000000" }));
    expect(fromResult?.resetAt).toBe(1700000000);
    expect(fromResult?.message).toContain("usage limit reached");

    expect(usageLimitError(channels({ transcript: "weekly limit reached\n" }))).not.toBeNull();
    expect(usageLimitError(channels({ stderr: "5-hour limit reached" }))).not.toBeNull();
  });

  it("ignores a banner quoted mid-sentence — it must lead a line", () => {
    expect(usageLimitError(channels({ transcript: "the docs say usage limit reached is the wording" }))).toBeNull();
  });

  it("trusts the spend-limit banner on stderr, Claude Code's own channel", () => {
    expect(usageLimitError(channels({ stderr: `${SPEND_BANNER}\n` }))).not.toBeNull();
  });

  it("trusts the spend-limit banner in the result only when it is the WHOLE result", () => {
    expect(usageLimitError(channels({ resultText: SPEND_BANNER }))).not.toBeNull();
    // An agent that quotes the banner and then reports its own unrelated failure is NOT quota-limited;
    // misreading it would reschedule a real failure forever (anton-b9l).
    expect(
      usageLimitError(channels({ resultText: `${SPEND_BANNER}\n\nBut three tests still fail.` })),
    ).toBeNull();
  });

  it("never reads the spend-limit sentence out of the model-authored transcript", () => {
    expect(usageLimitError(channels({ transcript: `${SPEND_BANNER}\n` }))).toBeNull();
  });

  it("falls back through the channels for the message, then to a default", () => {
    expect(usageLimitError(channels({ stderr: "  5-hour limit reached  " }))?.message).toBe(
      "5-hour limit reached",
    );
    expect(usageLimitError(channels({ transcript: "usage limit reached\n" }))?.message).toBe(
      "usage limit reached",
    );
  });

  it("classifies OpenRouter's [402] billing stop as a quota hit even though it arrives inside a 503 envelope (anton-x96g)", () => {
    expect(usageLimitError(channels({ stderr: GATEWAY_402_ENVELOPE }))).not.toBeNull();
    expect(usageLimitError(channels({ transcript: `${GATEWAY_402_ENVELOPE}\n` }))).not.toBeNull();
    expect(usageLimitError(channels({ resultText: GATEWAY_402_ENVELOPE }))).not.toBeNull();
  });

  it("leaves a genuine gateway 503 with no [402] inside untouched — it must still resolve as transient (anton-x96g)", () => {
    expect(usageLimitError(channels({ stderr: "API Error: 503 [openrouter/anthropic/claude-sonnet-5] Service Unavailable" }))).toBeNull();
  });

  it("classifies a rate_limit_error payload as a quota hit even wrapped in a 503 envelope (anton-h8z4)", () => {
    expect(usageLimitError(channels({ stderr: RATE_LIMIT_429_ENVELOPE }))).not.toBeNull();
    expect(usageLimitError(channels({ transcript: `${RATE_LIMIT_429_ENVELOPE}\n` }))).not.toBeNull();
    expect(usageLimitError(channels({ resultText: RATE_LIMIT_429_ENVELOPE }))).not.toBeNull();
  });

  it("classifies a bare [429] from the API or a gateway as a quota hit (anton-h8z4)", () => {
    expect(usageLimitError(channels({ stderr: "API Error: 500 [openrouter] [429]: rate limited" }))).not.toBeNull();
  });

  it("classifies the session-limit banner as a quota hit (anton-2gsj)", () => {
    expect(usageLimitError(channels({ stderr: SESSION_LIMIT_BANNER }))).not.toBeNull();
    expect(usageLimitError(channels({ resultText: SESSION_LIMIT_BANNER }))).not.toBeNull();
  });

  it("ignores the session-limit banner when a model merely quotes it in its own prose (anton-2gsj)", () => {
    expect(
      usageLimitError(channels({ transcript: `${SESSION_LIMIT_BANNER}\n` })),
    ).toBeNull();
    expect(
      usageLimitError(
        channels({ resultText: `${SESSION_LIMIT_BANNER}\n\nBut three tests still fail.` }),
      ),
    ).toBeNull();
  });

  it("classifies the out-of-usage-credits banner as a quota hit (anton-2gsj)", () => {
    expect(usageLimitError(channels({ stderr: USAGE_CREDITS_BANNER }))).not.toBeNull();
    expect(usageLimitError(channels({ resultText: USAGE_CREDITS_BANNER }))).not.toBeNull();
  });

  it("ignores the out-of-usage-credits banner when a model merely quotes it in its own prose (anton-2gsj)", () => {
    expect(
      usageLimitError(channels({ transcript: `${USAGE_CREDITS_BANNER}\n` })),
    ).toBeNull();
    expect(
      usageLimitError(
        channels({ resultText: `${USAGE_CREDITS_BANNER}\n\nBut three tests still fail.` }),
      ),
    ).toBeNull();
  });
});
