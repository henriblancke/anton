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
});
