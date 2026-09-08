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

  it("refuses instructions that are only the formula's TODO placeholder with nothing attached", () => {
    expect(() =>
      validateReworkInput(
        input({ instructions: "- [ ] TODO — a concrete, checkable statement of done" }),
      ),
    ).toThrow(ReworkInvalidError);
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
  /** The criteria as text — every case here is unfenced, so the shape is one line per criterion. */
  const texts = (instructions: string) => instructionCriteria(instructions).map((c) => c.text);

  it("makes one criterion per non-blank line, shorn of its list marker", () => {
    expect(
      texts("Some prose.\n\n- a bullet\n* starred\n1. numbered\n2) also\n- [ ] boxed\n[x] ticked"),
    ).toEqual(["Some prose.", "a bullet", "starred", "numbered", "also", "boxed", "ticked"]);
  });

  it("reads a bare marker as scaffolding, not as a criterion", () => {
    // `-` alone and `- [ ]` are what the founder leaves behind when they start a list and stop.
    expect(texts("-\n- \n1.\n- [ ]\n[ ]\n  ")).toEqual([]);
    // `+` is CommonMark's third bullet; alone it is the same abandoned list, not a criterion.
    expect(texts("+\n+ \n+ [ ]")).toEqual([]);
    // The zero-character box lib/beads/contract.ts accepts is the same abandoned list here.
    expect(texts("[]\n- []\n* []\n1. []\n- [] []\n> []")).toEqual([]);
    expect(texts("- [] boxed empty\n[] bare")).toEqual(["boxed empty", "bare"]);
  });

  it("reads a heading as scaffolding — a section label is not a step, in the contract's own rule", () => {
    // `## Backend` over `- Fix the retry` labels the step; boxing it filed `- [ ] ## Backend`.
    expect(texts("## Backend\n- Fix the retry\n### UI\nRe-run the snapshot")).toEqual([
      "Fix the retry",
      "Re-run the snapshot",
    ]);
    expect(texts("# Title\n## Backend ##\n######\n#")).toEqual([]);
    // A heading exposed once the outer markers are gone is still a heading, as a rule is.
    expect(texts("- ## Backend\n> ## Quoted\n1. [ ] ### Boxed")).toEqual([]);
    // The marker must be followed by whitespace or end the line: an issue number keeps its `#`.
    expect(texts("#123 fixed the retry\n- #a11y must pass")).toEqual([
      "#123 fixed the retry",
      "#a11y must pass",
    ]);
  });

  it("reads nested markers as scaffolding too — shearing one layer must not leave the next as a criterion", () => {
    // `- -`, `1. -` and `- [ ] [ ]` are a list started twice and abandoned; one strip leaves a bare
    // `-` or `[ ]`, which would file `- [ ] -` as the follow-up's one criterion.
    expect(texts("- -\n1. -\n- [ ] [ ]\n* * [x]\n- - - -\n1) 2) 3)")).toEqual([]);
    // A rule that only appears once the outer markers are gone is still a rule.
    expect(texts("- - ---\n1. - ***")).toEqual([]);
    // Nested markers ahead of real text are shorn all the way down to the text.
    expect(texts("- - nested bullet\n1. [ ] [x] twice boxed")).toEqual([
      "nested bullet",
      "twice boxed",
    ]);
  });

  it("reads a thematic break as scaffolding — it renders as a rule, not as text", () => {
    // The same set lib/beads/contract.ts refuses: three or more of one of `-`, `*`, `_`, spaces
    // between allowed. Boxing one would file `- [ ] ---` as the follow-up's only criterion.
    expect(texts("---\n***\n___\n- - -\n_ _ _\n* * *\n-----")).toEqual([]);
  });

  it("reads a rule nested in a list item as scaffolding too — `- ---` is a rule once shorn", () => {
    expect(texts("- ---\n1. ***\n* ___\n- [ ] ---\n[x] - - -\n2) _ _ _")).toEqual([]);
  });

  it("keeps a line that merely CONTAINS a rule, and a short dash run that is not one", () => {
    expect(texts("--- keep the header\n--\n* -- not a rule")).toEqual([
      "--- keep the header",
      "--",
      "-- not a rule",
    ]);
  });

  it("keeps a sign or a version that merely LOOKS like a marker", () => {
    expect(texts("-1 is the sentinel\n+1 on the rename\n1.2 ships this")).toEqual([
      "-1 is the sentinel",
      "+1 on the rename",
      "1.2 ships this",
    ]);
  });

  it("keeps a checkbox that is not followed by a separator — bracket syntax, not a ticked box", () => {
    // A bullet needs whitespace after it to be a marker; a box is held to the same rule, so a CSS
    // attribute selector at the head of a line is a criterion, and the criterion matches the note.
    expect(
      texts("[x].disabled must stay matched\n- [ ]{2} is two spaces\n[X] done"),
    ).toEqual(["[x].disabled must stay matched", "[ ]{2} is two spaces", "done"]);
  });

  it("reads the formula's TODO placeholder as scaffolding, in every list shape it can be pasted in", () => {
    // `- [ ] TODO — a concrete, checkable statement of done` is the acceptance box a bead is cooked
    // with. lib/beads/contract.ts refuses a section holding only that as unwritten; boxing it here
    // would file the very placeholder rubric that gate exists to refuse.
    expect(
      texts(
        [
          "- [ ] TODO — a concrete, checkable statement of done",
          "TODO — one sentence: what this delivers",
          "1. TODO: fill in",
          "* TODO - later",
          "- - [ ] TODO – nested",
          "[x] TODO—no space",
        ].join("\n"),
      ),
    ).toEqual([]);
  });

  it("strips a blockquote marker before judging — `> ` styles a line, it does not author one", () => {
    // A ticket's placeholder acceptance is often pasted as the callout it renders in. The contract
    // gate unquotes before it classifies (lib/beads/contract.ts); judging the quoted line as
    // authored here filed a `> -` or `> TODO` box the gate would then refuse.
    expect(
      texts(
        [
          "> -",
          "> ---",
          "> - [ ] TODO — a concrete, checkable statement of done",
          ">> TODO: nested callout",
          "- > [ ]",
          "> > - - ***",
          ">",
        ].join("\n"),
      ),
    ).toEqual([]);
    expect(texts("> - keep the quoted step\n> quoted prose\n- > nested quote")).toEqual([
      "keep the quoted step",
      "quoted prose",
      "nested quote",
    ]);
  });

  it("keeps a `>` glued to its text — a comparison, not a callout, and the note still says it", () => {
    // CommonMark would render `>95% coverage` as a quote, but what is filed here is the acceptance
    // box, and shearing the operator files `95% coverage` against a note that demands MORE than that.
    // A founder styling a callout types `> `; the space is what tells the two apart.
    expect(
      texts(">95% coverage on the retry path\n- >= 3 retries before giving up\n>>fast"),
    ).toEqual([">95% coverage on the retry path", ">= 3 retries before giving up", ">>fast"]);
    // A run of `>` followed by a space is still one nested callout, and a bare one is scaffolding.
    expect(texts(">> nested callout\n> > spaced\n>>\n> >")).toEqual([
      "nested callout",
      "spaced",
    ]);
  });

  it("keeps an authored line that merely mentions a TODO — the prompt is anchored on its separator", () => {
    expect(
      texts("- [ ] the TODO banner clears on save\nTODOs are listed in the readme"),
    ).toEqual(["the TODO banner clears on save", "TODOs are listed in the readme"]);
  });

  it("keeps a number too long to be an ordered marker — CommonMark stops at nine digits", () => {
    expect(texts("1234567890) must remain supported\n999999999. is a marker")).toEqual([
      "1234567890) must remain supported",
      "is a marker",
    ]);
  });

  it("keeps a fenced block verbatim, as one criterion — its content is literal, not markup", () => {
    // A pasted example carries lines that LOOK like a heading, a bullet, a rule and the TODO prompt.
    // Judged line by line they were dropped or shorn, so the acceptance asked for less than the
    // note the implementer reads. The contract judge reads fenced content as authored, and so does this.
    const example = ["```md", "## Expected", "- item", "---", "TODO — keep me", "  indented", "```"];
    expect(instructionCriteria(["Output must match:", ...example].join("\n"))).toEqual([
      { text: "Output must match:", fenced: false },
      { text: example.join("\n"), fenced: true },
    ]);
  });

  it("reads a tilde fence and a longer closer the way CommonMark does, and keeps fenced blank lines", () => {
    expect(texts("~~~\nfirst\n\nsecond\n~~~~\nafter")).toEqual(["~~~\nfirst\n\nsecond\n~~~~", "after"]);
    // A shorter run does not close the fence; it is content, and the block runs on to the real closer.
    expect(texts("````\n```\nstill inside\n````")).toEqual(["````\n```\nstill inside\n````"]);
  });

  it("reads an empty fence as scaffolding — an example that shows nothing states no step", () => {
    expect(instructionCriteria("```\n```")).toEqual([]);
    expect(instructionCriteria("```js\n\n   \n```\n- [ ]")).toEqual([]);
    expect(texts("```\n```\nthen this")).toEqual(["then this"]);
  });

  it("closes an unclosed fence — verbatim, it would swallow every section filed after it", () => {
    expect(texts("Expect:\n```sh\nnpm test")).toEqual(["Expect:", "```sh\nnpm test\n```"]);
    expect(texts("~~~~\nx")).toEqual(["~~~~\nx\n~~~~"]);
    // Unclosed and empty is still empty.
    expect(instructionCriteria("```\n\n")).toEqual([]);
  });

  it("does not open a fence on a backtick run with a backtick in its info string, nor on an indented one", () => {
    // CommonMark: `` ```a`b `` is a paragraph, and a delimiter indented four spaces is code, not a
    // fence — so it is filed as code, inside a fence long enough that its own backticks cannot close.
    expect(texts("```a`b\ninside?")).toEqual(["```a`b", "inside?"]);
    expect(texts("    ```\n## still a heading\n    ```")).toEqual([
      "````\n```\n````",
      "````\n```\n````",
    ]);
  });

  it("keeps an indented code block literal — its bullet is content the note renders as code", () => {
    // `Expected output:`, a blank line, then a four-space-indented line is an indented code block.
    // Shearing its marker filed `item` while the note still showed `- item`.
    expect(instructionCriteria("Expected output:\n\n    - item\n    ## not a heading")).toEqual([
      { text: "Expected output:", fenced: false },
      { text: "```\n- item\n## not a heading\n```", fenced: true },
    ]);
    // A tab indents the same way, and a heading or a rule opens the block as a blank line does.
    expect(texts("## Expected\n\t- item")).toEqual(["```\n- item\n```"]);
    expect(texts("---\n    1. step")).toEqual(["```\n1. step\n```"]);
    expect(texts("```\nx\n```\n    - after a fence")).toEqual(["```\nx\n```", "```\n- after a fence\n```"]);
  });

  it("keeps blank lines inside an indented block and drops the ones that trail it", () => {
    expect(texts("\n    first\n\n    second\n\n\nthen this")).toEqual([
      "```\nfirst\n\nsecond\n```",
      "then this",
    ]);
    expect(instructionCriteria("    only\n    \n")).toEqual([{ text: "```\nonly\n```", fenced: true }]);
  });

  it("still shears indented lines under a list item or a paragraph — nested steps, not code", () => {
    // Four-space nesting is how founders (and rich-text pastes) indent sub-bullets; CommonMark reads
    // both shapes as list content, and a founder who indents steps under `Add a retry:` means steps.
    expect(texts("- Add a retry:\n    - up to 3 times\n\n    - with backoff")).toEqual([
      "Add a retry:",
      "up to 3 times",
      "with backoff",
    ]);
    expect(texts("1. step\n    - sub\n  - two-space sub")).toEqual(["step", "sub", "two-space sub"]);
    expect(texts("Add a retry:\n    - up to 3 times")).toEqual(["Add a retry:", "up to 3 times"]);
    // A paragraph line after a blank ends the list, so the next indented block is code again.
    expect(texts("- item\n\nprose\n\n    - code")).toEqual(["item", "prose", "```\n- code\n```"]);
    // A heading or a rule ends the list too, and cannot be continued.
    expect(texts("- item\n## Section\n    - code")).toEqual(["item", "```\n- code\n```"]);
  });

  it("fences an indented block with one backtick more than any run its content opens with", () => {
    expect(texts("    ````\n    inner\n    ````")).toEqual(["`````\n````\ninner\n````\n`````"]);
    expect(texts("    a `tick` inline")).toEqual(["```\na `tick` inline\n```"]);
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
    expect(doneGap("---", [])).toMatch(/only list markers, headings or rules/);
    expect(doneGap("- \n***\n_ _ _", [])).not.toBeNull();
    expect(doneGap("- ---\n1. ***", [])).toMatch(/only list markers, headings or rules/);
    expect(doneGap("- -\n1. -\n- [ ] [ ]", [])).toMatch(/only list markers, headings or rules/);
    expect(doneGap("---\nAdd the missing test.", [])).toBeNull();
    expect(doneGap("---", [finding])).toBeNull();
  });

  it("refuses an empty code block, and accepts one with content — the judge reads it the same way", () => {
    expect(doneGap("```\n```", [])).toMatch(/empty code blocks/);
    expect(doneGap("```\n\n```\n---", [])).not.toBeNull();
    expect(doneGap("```\n## Expected\n```", [])).toBeNull();
    expect(doneGap("```\n```", [finding])).toBeNull();
    // An indented block is never empty — whitespace-only lines are blank — so it always states one.
    expect(doneGap("\n    - item", [])).toBeNull();
  });

  it("refuses instructions that are only headings or empty boxes — labels and blanks, not steps", () => {
    expect(doneGap("## Backend\n### UI", [])).toMatch(/only list markers, headings or rules/);
    expect(doneGap("[]\n- []", [])).toMatch(/only list markers, headings or rules/);
    expect(doneGap("- [] TODO — a concrete, checkable statement of done", [])).toMatch(
      /formula's TODO placeholder/,
    );
    expect(doneGap("## Backend\n- Fix the retry", [])).toBeNull();
    expect(doneGap("## Backend", [finding])).toBeNull();
  });

  it("refuses instructions that are only the formula's TODO placeholder — a prompt, not a step", () => {
    const placeholder = "- [ ] TODO — a concrete, checkable statement of done";
    expect(doneGap(placeholder, [])).toMatch(/formula's TODO placeholder/);
    expect(doneGap(`- \n${placeholder}\n---`, [])).not.toBeNull();
    // A placeholder left beside a written step is the founder's call, as in the contract gate.
    expect(doneGap(`${placeholder}\nAdd the missing test.`, [])).toBeNull();
    expect(doneGap(placeholder, [finding])).toBeNull();
  });
});
