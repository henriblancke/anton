/**
 * The send-back marks (anton-464lw) — the coupling test, not a restatement of the strings.
 *
 * `countSendBacks` (feature-ledger.ts) reads a friction figure off notes the rework path renders, and
 * the failure mode this guards is silent: a reword on the rendering side alone leaves every send-back
 * uncounted, and a counter that quietly reports 0 looks exactly like a feature nobody had to send
 * back. So each case asserts the predicate against the REAL renderer's output rather than against a
 * literal — a test that hard-coded the phrase would go green through the very drift it exists to
 * catch.
 */
import { describe, expect, it } from "vitest";

import { isSendBackNote } from "./rework-marks";
import {
  detachmentNoteBody,
  originNoteBody,
  reworkNoteBody,
  settledPhrase,
} from "./rework-notes";

describe("what the rework path writes is what the counter matches", () => {
  it("recognises a reopen's instruction note", () => {
    const note = reworkNoteBody({
      mode: "reopen",
      targetId: "anton-tgt",
      summary: "the ledger double-counts gates",
      instructions: "subtract the overlap",
      findings: [{ severity: "blocking", location: "feature-ledger.ts:12", note: "sums twice" }],
    });
    expect(isSendBackNote(note)).toBe(true);
  });

  it("recognises a follow-up's pointer on its origin ticket, plain and redirected", () => {
    expect(isSendBackNote(originNoteBody("anton-new"))).toBe(true);
    expect(
      isSendBackNote(originNoteBody("anton-new", { outcome: "shipped", pr: "#42", redirected: true })),
    ).toBe(true);
  });
});

describe("what it must NOT match", () => {
  it("does not match the note the follow-up BEAD receives", () => {
    // The same send-back seen from the other end. Counting it too would double every send-back whose
    // follow-up landed in the origin's own feature — see rework-marks.ts.
    const received = reworkNoteBody({
      mode: "follow-up",
      targetId: "anton-tgt",
      summary: "another pass",
      instructions: "do the thing",
      findings: [],
      originId: "anton-orig",
    });
    expect(isSendBackNote(received)).toBe(false);
  });

  it("does not match anton's own bookkeeping notes about a PR", () => {
    const detachment = detachmentNoteBody({ targetId: "anton-tgt", pr: "#42", contextKept: true });
    expect(isSendBackNote(detachment)).toBe(false);
    expect(isSendBackNote(`anton: rework — ${settledPhrase("#42", "merged")}`)).toBe(false);
  });

  it("does not match prose that merely mentions a follow-up", () => {
    expect(isSendBackNote("Follow-up work is tracked on the epic")).toBe(false);
    expect(isSendBackNote("Rework was discussed but not requested")).toBe(false);
  });
});
