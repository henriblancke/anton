/**
 * What the pass is required to SAY BACK (anton-d2sx). One property carries this module: an EMPTY
 * report is the healthy answer and a BROKEN one is a failure, and nothing may blur them — reading a
 * garbled report as "the board is healthy" is how a pass reports a clean bill of health it never
 * reached.
 */
import { describe, expect, it } from "vitest";
import { parsePmReport } from "./report";

/** A report block exactly as the protocol demands it — the shape every parse case varies from. */
const report = (body: string): string => `Here is what I found.\n\n\`\`\`json\n${body}\n\`\`\``;

describe("parsePmReport", () => {
  it("reads the claims out of the last report block", () => {
    const result = parsePmReport(
      report(`{"proposals":[{"kind":"kill","bead":"anton-a","summary":"s","evidence":["e"]}]}`),
    );
    expect(result).toEqual({
      ok: true,
      claims: [{ kind: "kill", bead: "anton-a", summary: "s", evidence: ["e"] }],
    });
  });

  it("reads a home claim as the subject and the home it names", () => {
    const result = parsePmReport(
      report(
        `{"proposals":[{"kind":"rehome","bead":"anton-a","home":"anton-epic","summary":"s","evidence":["e"]}]}`,
      ),
    );
    expect(result).toEqual({
      ok: true,
      claims: [
        { kind: "rehome", bead: "anton-a", home: "anton-epic", summary: "s", evidence: ["e"] },
      ],
    });
  });

  it("reads an EMPTY list as the healthy answer, not as a failure", () => {
    expect(parsePmReport(report(`{"proposals":[]}`))).toEqual({ ok: true, claims: [] });
  });

  // The one confusion the whole protocol exists to prevent: a pass that said nothing anton could
  // read must never be recorded as a board with nothing to say.
  it.each([
    ["no report at all", "I looked at the board and it seems fine."],
    ["a null list", report(`{"proposals":null}`)],
    ["one garbled entry", report(`{"proposals":[{"kind":"kill","bead":"anton-a"}]}`)],
    ["an unknown kind", report(`{"proposals":[{"kind":"rewrite","bead":"a","summary":"s","evidence":["e"]}]}`)],
    ["a reprioritize with no priority", report(`{"proposals":[{"kind":"reprioritize","bead":"a","summary":"s","evidence":["e"]}]}`)],
    ["a reprioritize with a bogus priority", report(`{"proposals":[{"kind":"reprioritize","bead":"a","priority":"P9","summary":"s","evidence":["e"]}]}`)],
    ["a split with a single piece", report(`{"proposals":[{"kind":"split","bead":"a","pieces":["one"],"summary":"s","evidence":["e"]}]}`)],
    // A home claim names two beads, and "this is misfiled" without the second names no move at all.
    ["a rehome with no home", report(`{"proposals":[{"kind":"rehome","bead":"a","summary":"s","evidence":["e"]}]}`)],
    ["a rehome whose home is blank", report(`{"proposals":[{"kind":"rehome","bead":"a","home":"  ","summary":"s","evidence":["e"]}]}`)],
    ["evidence-free judgment", report(`{"proposals":[{"kind":"kill","bead":"a","summary":"s","evidence":[]}]}`)],
  ])("refuses %s rather than reading it as a healthy board", (_label, text) => {
    const result = parsePmReport(text);
    expect(result.ok).toBe(false);
    expect((result as { claims?: unknown }).claims).toBeUndefined();
  });

  it("refuses trailing prose, which is where a session takes a report back", () => {
    const text = `${report(`{"proposals":[]}`)}\n\nCorrection: anton-a should actually be killed.`;
    expect(parsePmReport(text)).toEqual({ ok: false, violation: "trailing-content" });
  });

  it("skips an unrelated json block on the way to the report", () => {
    const text = `\`\`\`json\n{"some":"bead body"}\n\`\`\`\n\n${report(`{"proposals":[]}`)}`;
    expect(parsePmReport(text)).toEqual({ ok: true, claims: [] });
  });

  it("does not fall back to an earlier draft when the final block is broken", () => {
    const text = `${report(`{"proposals":[]}`)}\n\n${report(`{"proposals":[{`)}`;
    // A block that tried to be the report and failed IS the report — say WHICH way it broke, so a
    // log reader can tell a garbled report from a session that emitted none.
    expect(parsePmReport(text)).toEqual({ ok: false, violation: "malformed-proposals" });
  });
});
