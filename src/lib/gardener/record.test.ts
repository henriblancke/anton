/**
 * The record (anton-hzce): the line a pass writes about one proposal, and reading it back.
 *
 * The property that matters here is the ROUND TRIP. The formatter and the reader are the producer
 * and the consumer of the only evidence an unattended write leaves, so a format change that the
 * reader doesn't follow is a jobs page reporting a clean pass over a log full of board writes — a
 * failure that is silent by construction. Every case below therefore goes through `passRecordLine`
 * rather than a hand-typed string, except the ones deliberately asserting on legacy/foreign text.
 */
import { describe, expect, it } from "vitest";

import {
  isCleanPass,
  passRecordCounts,
  passRecordGroup,
  passRecordLine,
  readPassRecords,
  type PassRecordLine,
} from "./record";

/** A pass's log line as the producers write it: the prefix, the record, a newline. */
function logged(producer: string, line: PassRecordLine): string {
  return `[${producer}] ${passRecordLine(line)}\n`;
}

const APPLIED: PassRecordLine = {
  mode: "apply",
  proposal: "p-1",
  kind: "shipped-orphan",
  move: "retire",
  retireAs: "close",
  subjects: ["t-4"],
  verdict: "APPLIED",
  detail: "closed t-4 as shipped",
};

const SHADOWED: PassRecordLine = {
  mode: "shadow",
  proposal: "p-2",
  kind: "superseded",
  move: "retire",
  retireAs: "supersede",
  subjects: ["t-6"],
  target: "t-5",
  verdict: "WOULD APPLY",
  detail: "closed t-6 as superseded by t-5",
};

describe("passRecordLine", () => {
  it("writes the whole ask, so a reader never has to open the bead to know which one this is", () => {
    expect(passRecordLine(APPLIED)).toBe(
      "APPLY p-1 (shipped-orphan) retire/close t-4 — APPLIED: closed t-4 as shipped",
    );
    expect(passRecordLine(SHADOWED)).toBe(
      "SHADOW p-2 (superseded) retire/supersede t-6 → t-5 — WOULD APPLY: closed t-6 as superseded by t-5",
    );
  });

  it("collapses a multi-line detail, because one record has to be one line", () => {
    // A bd failure arrives with newlines in it. Left alone it would split the record across lines
    // and the reader would keep only the half that still parses.
    const line = passRecordLine({
      ...APPLIED,
      verdict: "COULD NOT APPLY",
      detail: "applying p-1 failed:\n  bd exited 1\n",
    });
    expect(line).toBe(
      "APPLY p-1 (shipped-orphan) retire/close t-4 — COULD NOT APPLY: applying p-1 failed: bd exited 1",
    );
    expect(readPassRecords(`[gardener] ${line}\n`).records).toHaveLength(1);
  });
});

describe("readPassRecords", () => {
  it("reads a record back whole, with the outcome a founder counts it as", () => {
    const { records } = readPassRecords(logged("gardener", APPLIED) + logged("gardener", SHADOWED));

    expect(records).toEqual([
      {
        producer: "gardener",
        mode: "apply",
        proposal: "p-1",
        kind: "shipped-orphan",
        verb: "retire/close",
        subjects: ["t-4"],
        target: undefined,
        verdict: "APPLIED",
        outcome: "applied",
        detail: "closed t-4 as shipped",
      },
      {
        producer: "gardener",
        mode: "shadow",
        proposal: "p-2",
        kind: "superseded",
        verb: "retire/supersede",
        subjects: ["t-6"],
        target: "t-5",
        verdict: "WOULD APPLY",
        outcome: "shadowed",
        detail: "closed t-6 as superseded by t-5",
      },
    ]);
  });

  it("keeps a refusal's reason verbatim, em dashes and all", () => {
    // The reason is the whole point of the entry: "the board moved under it" and "the evidence went
    // stale" are different problems, and a detail truncated at its own em dash tells neither.
    const detail =
      "cannot apply p-1: t-4 was written after this proposal was filed — its evidence is stale";
    const { records } = readPassRecords(
      logged("gardener", { ...APPLIED, verdict: "REFUSED", detail }),
    );

    expect(records[0].outcome).toBe("refused");
    expect(records[0].detail).toBe(detail);
  });

  it("counts an apply that BROKE apart from one the board refused", () => {
    // Two proposals, not one: a second line about the SAME proposal is that apply's outcome
    // superseding its own reservation, which is a different property (proved below).
    const log =
      logged("gardener", { ...APPLIED, verdict: "REFUSED", detail: "premise moved" }) +
      logged("gardener", { ...APPLIED, proposal: "p-5", verdict: "COULD NOT APPLY", detail: "bd exploded" });
    const summary = readPassRecords(log);

    // Conflating them would tell a founder the board declined when in fact anton failed mid-write.
    expect(passRecordCounts(summary)).toEqual({
      applied: 0,
      unsettled: 0,
      stranded: 0,
      shadowed: 0,
      refused: 1,
      unrecorded: 0,
      "apply-failed": 1,
      "shadow-failed": 0,
    });
  });

  it("counts an apply that LANDED and could not be settled apart from one that broke", () => {
    // The third member of that family, and the one neither of the others may absorb: the move is on
    // the board and its ask is still open. `APPLIED` would hide the standing proposal; `COULD NOT
    // APPLY` promises a board nothing landed on, and would hide a bead a pass moved unattended.
    const summary = readPassRecords(
      logged("gardener", {
        ...APPLIED,
        verdict: "APPLIED BUT NOT SETTLED",
        detail: "the move LANDED (t-4) and was not rolled back, but the proposal could not be closed",
      }),
    );

    expect(summary.records[0].outcome).toBe("unsettled");
    expect(summary.records.map(passRecordGroup)).toEqual(["unsettled"]);
    expect(passRecordCounts(summary)).toMatchObject({
      unsettled: 1,
      applied: 0,
      "apply-failed": 0,
    });
  });

  it("lets an outcome supersede the reservation that bought it — one apply, one record", async () => {
    // An apply writes twice about one proposal: the line that reserves it against the pass's cap,
    // then what the board actually did. Read as two, the page would report a write nobody made and
    // the write budget would charge a retry for an apply that never happened.
    const summary = readPassRecords(
      logged("gardener", { ...APPLIED, verdict: "APPLYING", detail: "attempted unattended" }) +
        logged("gardener", APPLIED),
    );

    expect(summary.records).toHaveLength(1);
    expect(summary.records[0].verdict).toBe("APPLIED");
    expect(passRecordCounts(summary).applied).toBe(1);
  });

  it("keeps a reservation with no outcome behind it as neither a write nor a failure", async () => {
    // The one thing nobody can say about this proposal is what happened to it: anton started the
    // write and never got to record how it went, so the bead itself is the only evidence. Counting
    // it as applied invents a move; counting it as failed denies one that may well have landed.
    const summary = readPassRecords(
      logged("gardener", { ...APPLIED, verdict: "APPLYING", detail: "attempted unattended" }),
    );

    expect(summary.records[0].outcome).toBe("unrecorded");
    expect(summary.records.map(passRecordGroup)).toEqual(["unrecorded"]);
    expect(passRecordCounts(summary).applied).toBe(0);
    expect(passRecordCounts(summary)["apply-failed"]).toBe(0);
  });

  it("supersedes per proposal and per producer, never across them", async () => {
    // Two passes are two accounts, and one pass applies several proposals: collapsing either would
    // lose a real unattended write.
    const summary = readPassRecords(
      logged("gardener", { ...APPLIED, verdict: "APPLYING", detail: "attempted" }) +
        logged("product-master", { ...APPLIED, verdict: "APPLYING", detail: "attempted" }) +
        logged("gardener", { ...APPLIED, proposal: "p-9" }),
    );

    expect(summary.records.map((r) => [r.producer, r.proposal, r.verdict])).toEqual([
      ["gardener", "p-1", "APPLYING"],
      ["product-master", "p-1", "APPLYING"],
      ["gardener", "p-9", "APPLIED"],
    ]);
  });

  it("counts a shadow that broke apart from an apply that broke", async () => {
    // Both are `error`, and only one of them touched the board: an apply that broke was a write,
    // rolled back, while a shadow that broke never attempted one. A reader told "could not apply"
    // about the second would go looking for a write that was never made.
    const log =
      logged("gardener", { ...APPLIED, verdict: "COULD NOT APPLY", detail: "bd exploded" }) +
      logged("gardener", { ...SHADOWED, verdict: "COULD NOT SHADOW", detail: "board unreadable" });
    const summary = readPassRecords(log);

    expect(summary.records.map(passRecordGroup)).toEqual(["apply-failed", "shadow-failed"]);
    expect(passRecordCounts(summary)["apply-failed"]).toBe(1);
    expect(passRecordCounts(summary)["shadow-failed"]).toBe(1);
  });

  it("counts a rollback that could not finish apart from one that did", async () => {
    // Both applies BROKE, and only one of them left the board moved. Folded together, the page would
    // tell a founder "nothing landed" over beads anton moved unattended and cannot un-move — the
    // whole reason this record exists (gardener/armed.ts `verdictOf`).
    const log =
      logged("gardener", {
        ...APPLIED,
        verdict: "COULD NOT ROLL BACK",
        detail: "applying p-1 failed: bd exploded — ROLLBACK INCOMPLETE: t-4 could not be restored",
      }) +
      logged("gardener", {
        ...APPLIED,
        proposal: "p-9",
        verdict: "COULD NOT APPLY",
        detail: "applying p-9 failed: bd exploded — the 1 write(s) were rolled back",
      });
    const summary = readPassRecords(log);

    expect(summary.records.map(passRecordGroup)).toEqual(["stranded", "apply-failed"]);
    expect(passRecordCounts(summary)).toMatchObject({ stranded: 1, "apply-failed": 1, applied: 0 });
  });

  it("counts every shadow verdict as shadowed — nothing was written on any of them", () => {
    const log = (["WOULD APPLY", "WOULD REFUSE", "ALREADY SETTLED"] as const)
      .map((verdict) => logged("gardener", { ...SHADOWED, verdict }))
      .join("");

    expect(passRecordCounts(readPassRecords(log)).shadowed).toBe(3);
    expect(passRecordCounts(readPassRecords(log)).applied).toBe(0);
  });

  it("reads several subjects back as a list", () => {
    const { records } = readPassRecords(
      logged("gardener", {
        mode: "apply",
        proposal: "p-3",
        kind: "parentless-cluster",
        move: "reparent",
        subjects: ["t-1", "t-2", "t-3"],
        target: "f-9",
        verdict: "APPLIED",
        detail: "re-parented 3 beads under f-9",
      }),
    );

    expect(records[0].subjects).toEqual(["t-1", "t-2", "t-3"]);
    expect(records[0].target).toBe("f-9");
  });

  it("keeps the write cap's own line as a note rather than losing it", () => {
    // Never a silent cap: an operator who armed a kind and finds three beads moved has to be able
    // to tell "that was all of it" from "we stopped at three".
    const summary = readPassRecords(
      "[gardener] APPLY held back 2 armed proposal(s) — one pass applies at most 3; they stay " +
        "open as ordinary asks (p-8, p-9)\n" +
        logged("gardener", APPLIED),
    );

    expect(summary.records).toHaveLength(1);
    expect(summary.notes).toEqual([
      "APPLY held back 2 armed proposal(s) — one pass applies at most 3; they stay open as " +
        "ordinary asks (p-8, p-9)",
    ]);
  });

  it("keeps a shadow that could not run at all, so it never reads as a clean pass", () => {
    const summary = readPassRecords(
      "[gardener] SHADOW could not read the board — bd unreachable; nothing shadowed\n",
    );

    expect(summary.records).toEqual([]);
    expect(isCleanPass(summary)).toBe(false);
  });

  it("ignores everything that is not one of the pass's own lines", () => {
    // A product-master pass logs a whole claude transcript above its record, and an assistant is
    // perfectly capable of typing the word APPLY.
    const summary = readPassRecords(
      "[assistant] I would APPLY p-1 (shipped-orphan) here — REFUSED: nope\n" +
        "[gardener] filed 2 proposal(s)\n" +
        "\n" +
        logged("product-master", { ...APPLIED, proposal: "p-7" }),
    );

    expect(summary.records.map((r) => r.proposal)).toEqual(["p-7"]);
    expect(summary.records[0].producer).toBe("product-master");
    expect(summary.notes).toEqual([]);
  });

  it("ignores a foreign line that is shaped EXACTLY like a record", () => {
    // The near-miss above is caught by position; this one is not. A model asked to reason about the
    // pass's own log can reproduce a record verbatim, and the only thing separating a write anton
    // made from a sentence a model wrote is which producer claims to have made it — so the producer
    // is the check. Neither a record nor a note: attributing a board write to "assistant" is worse
    // than dropping the line, and counting it as a note would cost the pass its clean bill.
    const summary = readPassRecords(logged("assistant", APPLIED) + logged("claude", SHADOWED));

    expect(summary.records).toEqual([]);
    expect(summary.notes).toEqual([]);
    expect(isCleanPass(summary)).toBe(true);
  });

  it("reads an unrecognised verdict as a failure, never as a write", () => {
    // This reader is one anton behind whatever wrote the log whenever another machine ran a newer
    // build. Guessing that an unknown word meant "applied" is the one wrong answer available.
    const summary = readPassRecords(
      "[gardener] APPLY p-1 (stale) defer t-4 — HALF APPLIED: who knows\n",
    );

    expect(summary.records[0].outcome).toBe("error");
    expect(summary.records[0].verdict).toBe("HALF APPLIED");
  });
});

describe("isCleanPass", () => {
  it("is true only for a pass that recorded nothing at all", () => {
    expect(isCleanPass(readPassRecords(""))).toBe(true);
    expect(isCleanPass(readPassRecords("[gardener] filed 3 proposal(s)\n"))).toBe(true);
    expect(isCleanPass(readPassRecords(logged("gardener", APPLIED)))).toBe(false);
  });
});
