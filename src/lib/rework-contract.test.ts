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
  doneGap,
  instructionCriteria,
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

  it("refuses instructions that state no step — marker-only text with nothing attached (anton-xwf1)", () => {
    // Blank instructions are already refused; "- " passes that check and would file a bead whose
    // only criterion is the generic one. The route refuses it the way the dialog does.
    expect(() => validateReworkInput(input({ instructions: "- \n1.\n[ ]" }))).toThrow(
      /hold only list markers/,
    );
    expect(() => validateReworkInput(input({ instructions: "-" }))).toThrow(ReworkInvalidError);
  });

  it("lets marker-only instructions through when a finding is attached — the finding is the criterion", () => {
    const findings: ReviewFinding[] = [
      { severity: "blocking", location: "src/lib/rework.ts:12", note: "no null guard" },
    ];
    expect(validateReworkInput(input({ instructions: "- ", findings })).instructions).toBe("-");
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

describe("instructionCriteria", () => {
  it("makes one criterion per non-blank line, shorn of its list marker", () => {
    expect(
      instructionCriteria("Some prose.\n\n- a bullet\n* starred\n1. numbered\n2) also\n- [ ] boxed\n[x] ticked"),
    ).toEqual(["Some prose.", "a bullet", "starred", "numbered", "also", "boxed", "ticked"]);
  });

  it("reads a bare marker as scaffolding, not as a criterion", () => {
    // `-` alone and `- [ ]` are what the founder leaves behind when they start a list and stop.
    expect(instructionCriteria("-\n- \n1.\n- [ ]\n[ ]\n  ")).toEqual([]);
    // `+` is CommonMark's third bullet; alone it is the same abandoned list, not a criterion.
    expect(instructionCriteria("+\n+ \n+ [ ]")).toEqual([]);
  });

  it("reads nested markers as scaffolding too — shearing one layer must not leave the next as a criterion", () => {
    // `- -`, `1. -` and `- [ ] [ ]` are a list started twice and abandoned; one strip leaves a bare
    // `-` or `[ ]`, which would file `- [ ] -` as the follow-up's one criterion.
    expect(instructionCriteria("- -\n1. -\n- [ ] [ ]\n* * [x]\n- - - -\n1) 2) 3)")).toEqual([]);
    // A rule that only appears once the outer markers are gone is still a rule.
    expect(instructionCriteria("- - ---\n1. - ***")).toEqual([]);
    // Nested markers ahead of real text are shorn all the way down to the text.
    expect(instructionCriteria("- - nested bullet\n1. [ ] [x] twice boxed")).toEqual([
      "nested bullet",
      "twice boxed",
    ]);
  });

  it("reads a thematic break as scaffolding — it renders as a rule, not as text", () => {
    // The same set lib/beads/contract.ts refuses: three or more of one of `-`, `*`, `_`, spaces
    // between allowed. Boxing one would file `- [ ] ---` as the follow-up's only criterion.
    expect(instructionCriteria("---\n***\n___\n- - -\n_ _ _\n* * *\n-----")).toEqual([]);
  });

  it("reads a rule nested in a list item as scaffolding too — `- ---` is a rule once shorn", () => {
    expect(instructionCriteria("- ---\n1. ***\n* ___\n- [ ] ---\n[x] - - -\n2) _ _ _")).toEqual([]);
  });

  it("keeps a line that merely CONTAINS a rule, and a short dash run that is not one", () => {
    expect(instructionCriteria("--- keep the header\n--\n* -- not a rule")).toEqual([
      "--- keep the header",
      "--",
      "-- not a rule",
    ]);
  });

  it("keeps a sign or a version that merely LOOKS like a marker", () => {
    expect(instructionCriteria("-1 is the sentinel\n+1 on the rename\n1.2 ships this")).toEqual([
      "-1 is the sentinel",
      "+1 on the rename",
      "1.2 ships this",
    ]);
  });

  it("keeps a checkbox that is not followed by a separator — bracket syntax, not a ticked box", () => {
    // A bullet needs whitespace after it to be a marker; a box is held to the same rule, so a CSS
    // attribute selector at the head of a line is a criterion, and the criterion matches the note.
    expect(
      instructionCriteria("[x].disabled must stay matched\n- [ ]{2} is two spaces\n[X] done"),
    ).toEqual(["[x].disabled must stay matched", "[ ]{2} is two spaces", "done"]);
  });

  it("keeps a number too long to be an ordered marker — CommonMark stops at nine digits", () => {
    expect(instructionCriteria("1234567890) must remain supported\n999999999. is a marker")).toEqual([
      "1234567890) must remain supported",
      "is a marker",
    ]);
  });
});

describe("doneGap", () => {
  const finding: ReviewFinding = { severity: "advisory", location: "(general)", note: "naming" };

  it("is silent when the instructions yield a criterion, or a finding does", () => {
    expect(doneGap("Add the missing test.", [])).toBeNull();
    expect(doneGap("- ", [finding])).toBeNull();
  });

  it("names both things that are missing when neither yields one", () => {
    const gap = doneGap("- \n- ", []);
    expect(gap).toMatch(/only list markers/);
    expect(gap).toMatch(/no finding is attached/);
  });

  it("refuses instructions that are only a rule — `---` is a separator, not a definition of done", () => {
    expect(doneGap("---", [])).toMatch(/only list markers or rules/);
    expect(doneGap("- \n***\n_ _ _", [])).not.toBeNull();
    expect(doneGap("- ---\n1. ***", [])).toMatch(/only list markers or rules/);
    expect(doneGap("- -\n1. -\n- [ ] [ ]", [])).toMatch(/only list markers or rules/);
    expect(doneGap("---\nAdd the missing test.", [])).toBeNull();
    expect(doneGap("---", [finding])).toBeNull();
  });
});
