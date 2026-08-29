/**
 * Unit tests for the rework request contract (anton-51oq): what a send-back must say before
 * anything is read off the board, and the five refusals the layers above map onto status codes.
 *
 * Pure module, so this suite is pure too — no bd, no `gh`, no board. That the whole send-back holds
 * together is src/lib/rework.test.ts's job.
 */
import { describe, expect, it } from "vitest";
import type { ReviewFinding } from "./jobs/review-context";
import {
  ReworkConflictError,
  ReworkInvalidError,
  ReworkNotAllowedError,
  ReworkNotFoundError,
  ReworkUnavailableError,
  validateReworkInput,
  type ReworkInput,
} from "./rework-contract";
import { MAX_REWORK_INSTRUCTIONS_CHARS, MAX_REWORK_SUMMARY_CHARS } from "./types";

const input = (over: Partial<ReworkInput> = {}): ReworkInput => ({
  ticketId: "t1",
  mode: "reopen",
  summary: "the API is still untested",
  instructions: "Add a test that fails without the null guard.",
  ...over,
});

describe("validateReworkInput", () => {
  it("returns the request trimmed, with findings defaulted to the empty case", () => {
    expect(
      validateReworkInput({
        ticketId: " t1 ",
        mode: "follow-up",
        summary: "  needs a test  ",
        instructions: "  add one  ",
      }),
    ).toEqual({
      ticketId: "t1",
      mode: "follow-up",
      summary: "needs a test",
      instructions: "add one",
      findings: [],
    });
  });

  it("carries the selected findings through untouched — they land verbatim in the note", () => {
    const findings: ReviewFinding[] = [
      { severity: "blocking", location: "src/lib/rework.ts:12", note: "no null guard" },
    ];
    expect(validateReworkInput(input({ findings })).findings).toEqual(findings);
  });

  it("refuses a missing id FIRST, so it is never reported as a membership failure", () => {
    // Both fields are blank: the id must still be what the refusal names, or the request falls
    // through to the board and comes back as `'' is not part of <target>'s run`.
    expect(() => validateReworkInput(input({ ticketId: "  ", summary: "" }))).toThrow(
      /ticket to send back/,
    );
    expect(() => validateReworkInput(input({ ticketId: undefined as never }))).toThrow(
      ReworkInvalidError,
    );
  });

  it("names the field that is missing", () => {
    expect(() => validateReworkInput(input({ summary: " " }))).toThrow(/one-line summary/);
    expect(() => validateReworkInput(input({ summary: undefined as never }))).toThrow(
      /one-line summary/,
    );
    expect(() => validateReworkInput(input({ instructions: "" }))).toThrow(/Fix instructions/);
    expect(() => validateReworkInput(input({ instructions: undefined as never }))).toThrow(
      /Fix instructions/,
    );
  });

  it("refuses oversized text rather than truncating it downstream, and reports both numbers", () => {
    expect(() =>
      validateReworkInput(input({ summary: "x".repeat(MAX_REWORK_SUMMARY_CHARS + 1) })),
    ).toThrow(new RegExp(`Summary is too long \\(${MAX_REWORK_SUMMARY_CHARS + 1} > 200`));
    expect(() =>
      validateReworkInput(
        input({ instructions: "x".repeat(MAX_REWORK_INSTRUCTIONS_CHARS + 1) }),
      ),
    ).toThrow(new RegExp(`Instructions are too long \\(${MAX_REWORK_INSTRUCTIONS_CHARS + 1} > 2000`));
  });

  it("accepts text exactly at the bound — the cap is what is refused, not what is allowed", () => {
    const request = validateReworkInput(
      input({
        summary: "x".repeat(MAX_REWORK_SUMMARY_CHARS),
        instructions: "y".repeat(MAX_REWORK_INSTRUCTIONS_CHARS),
      }),
    );
    expect(request.summary).toHaveLength(MAX_REWORK_SUMMARY_CHARS);
    expect(request.instructions).toHaveLength(MAX_REWORK_INSTRUCTIONS_CHARS);
  });

  it("measures the bound on the TRIMMED text, so surrounding whitespace can't refuse a valid one", () => {
    expect(() =>
      validateReworkInput(input({ summary: `  ${"x".repeat(MAX_REWORK_SUMMARY_CHARS)}  ` })),
    ).not.toThrow();
  });

  it("refuses a mode it doesn't implement rather than guessing one", () => {
    expect(() => validateReworkInput(input({ mode: "delete" as never }))).toThrow(
      /Unknown rework mode "delete"/,
    );
    expect(() => validateReworkInput(input({ mode: undefined as never }))).toThrow(
      /Unknown rework mode/,
    );
    expect(validateReworkInput(input({ mode: "reopen" })).mode).toBe("reopen");
    expect(validateReworkInput(input({ mode: "follow-up" })).mode).toBe("follow-up");
  });

  it("raises every refusal as ReworkInvalidError — the caller's fault is one status", () => {
    for (const bad of [
      input({ ticketId: "" }),
      input({ summary: "" }),
      input({ instructions: "" }),
      input({ summary: "x".repeat(MAX_REWORK_SUMMARY_CHARS + 1) }),
      input({ mode: "delete" as never }),
    ]) {
      expect(() => validateReworkInput(bad)).toThrow(ReworkInvalidError);
    }
  });
});

describe("the five refusals", () => {
  const classes = [
    ReworkInvalidError,
    ReworkNotAllowedError,
    ReworkConflictError,
    ReworkNotFoundError,
    ReworkUnavailableError,
  ];

  it("are all Errors, and keep the message the route reports", () => {
    for (const Refusal of classes) {
      const error = new Refusal("why");
      expect(error).toBeInstanceOf(Error);
      expect(error.message).toBe("why");
    }
  });

  it("are five distinct classes — each maps onto its own status, so none may catch another's", () => {
    for (const Thrown of classes) {
      const error = new Thrown("why");
      for (const Caught of classes) {
        expect(error instanceof Caught).toBe(Thrown === Caught);
      }
    }
  });
});
