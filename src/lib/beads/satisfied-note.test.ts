import { describe, expect, it } from "vitest";
import { blockNoteCommit, latestBlockNoteCommit } from "./block-note";
import { formatHumanNote, parseTicketNotes } from "./notes";
import {
  formatSatisfiedNote,
  latestSatisfiedRecord,
  parseSatisfiedNote,
  shortSha,
} from "./satisfied-note";

const SHA = "0123456789abcdef0123456789abcdef01234567";
const note = (over: Partial<Parameters<typeof formatSatisfiedNote>[0]["by"]> = {}) =>
  formatSatisfiedNote({
    by: { commit: SHA, subject: "anton-t1: Ticket one", ...over },
    sessionId: "sess-1",
    branch: "anton/anton-e0y2",
  });

/**
 * anton-8h4b: a satisfied step closes without a commit of its own, so the bead has to say which
 * commit it was settled against — and say it in the machine-note channel every other anton note
 * uses, so a reader later parses it back rather than guessing from the close alone.
 */
describe("formatSatisfiedNote / parseSatisfiedNote round-trip", () => {
  it("names the satisfying commit, its subject, and the evidence a reader parses back", () => {
    const text = note();
    expect(text).toMatch(/^anton: satisfied by 0123456 "anton-t1: Ticket one" — /);
    expect(text).toContain("no commit of its own");
    expect(parseSatisfiedNote(text)).toEqual({
      sessionId: "sess-1",
      branch: "anton/anton-e0y2",
      commit: SHA,
    });
  });

  it("is exactly one machine note, whatever the agent's account contained", () => {
    const text = note({ note: "the schema change\n\nalready covers\r\nthis step" });
    expect(text).not.toMatch(/[\r\n]/);
    expect(text).toContain("Agent's account: the schema change already covers this step");
    const parsed = parseTicketNotes(text);
    expect(parsed).toHaveLength(1);
    expect(parsed[0]?.source).toBe("system");
  });

  it("caps a runaway account so the append-only blob stays a summary", () => {
    const text = note({ note: "x".repeat(2_000) });
    expect(text.length).toBeLessThan(1_000);
    expect(text).toContain("…");
    // The cap never eats the evidence clause the reader depends on.
    expect(parseSatisfiedNote(text)?.commit).toBe(SHA);
  });

  it("carries the sha as named when the run could not resolve it, and no subject", () => {
    const text = formatSatisfiedNote({
      by: { commit: "a1b2c3d" },
      sessionId: "sess-1",
      branch: "anton/x",
    });
    expect(text).toMatch(/^anton: satisfied by a1b2c3d — /);
    expect(parseSatisfiedNote(text)).toEqual({ sessionId: "sess-1", branch: "anton/x", commit: "a1b2c3d" });
  });

  // The park gate reads a block note's trailing bracket to pick the operator's remedy; a satisfied
  // record shares the bracket shape but not the words, so it must never read as a block verdict.
  it("is never mistaken for a block note's evidence, and a block note is never mistaken for it", () => {
    const text = note();
    expect(blockNoteCommit(text)).toBeUndefined();
    expect(latestBlockNoteCommit([text])).toBeUndefined();
    const block = "anton: run failed after committing work — needs review [session s, committed on anton/x @ 0123456]";
    expect(parseSatisfiedNote(block)).toBeUndefined();
  });

  it("does not parse a note that merely mentions the words outside the trailing bracket", () => {
    expect(parseSatisfiedNote("anton: satisfied on anton/x by 0123456 — not the clause")).toBeUndefined();
    expect(parseSatisfiedNote("anton: [session s, satisfied on anton/x by 0123456] trailing prose")).toBeUndefined();
  });
});

describe("latestSatisfiedRecord — the newest record on a bead's notes blob", () => {
  it("reads the record back through a blob mixing human notes and other machine notes", () => {
    const blob = [
      formatHumanNote("reuse the helper", "Henri Blancke", new Date(0)),
      "anton: run failed after committing work — needs review [session s0, committed on anton/x @ 0123456]",
      note(),
      "anton: 1 ticket(s) ran out of time and did not finish — anton-t9.",
    ].join("\n");
    expect(latestSatisfiedRecord(blob)).toEqual({
      sessionId: "sess-1",
      branch: "anton/anton-e0y2",
      commit: SHA,
    });
  });

  it("answers undefined for a bead never settled that way, and for an empty blob", () => {
    expect(latestSatisfiedRecord(undefined)).toBeUndefined();
    expect(latestSatisfiedRecord("")).toBeUndefined();
    expect(latestSatisfiedRecord("anton: run failed after committing work — needs review")).toBeUndefined();
  });

  it("ignores a human note quoting the clause — a steer is not a settlement", () => {
    const blob = formatHumanNote(`[session s, satisfied on anton/x by ${SHA}]`, "Henri", new Date(0));
    expect(latestSatisfiedRecord(blob)).toBeUndefined();
  });

  it("prefers the newest of two records", () => {
    const older = formatSatisfiedNote({ by: { commit: "a".repeat(40) }, sessionId: "s1", branch: "anton/x" });
    const newer = formatSatisfiedNote({ by: { commit: "b".repeat(40) }, sessionId: "s2", branch: "anton/x" });
    expect(latestSatisfiedRecord(`${older}\n${newer}`)?.commit).toBe("b".repeat(40));
  });
});

describe("shortSha", () => {
  it("is the seven-character form a person reads", () => {
    expect(shortSha(SHA)).toBe("0123456");
    expect(shortSha("abc")).toBe("abc");
  });
});
