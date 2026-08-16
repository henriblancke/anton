/**
 * The collapsed row's chips (anton-zy7f) — the only place an unattended board write is visible
 * BEFORE a founder finds a bead already moved.
 *
 * Read off real log text through `readPassRecords`, never from hand-built summaries: the chips exist
 * to describe what a pass wrote, and a fixture that skipped the parser would keep passing on the day
 * the record's wording and the reader's regex disagreed.
 */
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { readPassRecords } from "@/lib/gardener/record";
import { PassRecordChips } from "@/components/runs/pass-record";

const APPLIED = (n: number) =>
  `[gardener] APPLY p-${n} (shipped-orphan) retire/close t-${n} — APPLIED: closed t-${n} as shipped`;

/** The write cap holding an ask back — a note, and one that only ever occurs ALONGSIDE applies. */
const HELD_BACK =
  "[gardener] APPLY held back 1 armed proposal(s) — one pass applies at most 3; they stay open " +
  "as ordinary asks (p-4)";

const chips = (log: string) =>
  renderToStaticMarkup(<PassRecordChips summary={readPassRecords(log)} />);

describe("PassRecordChips", () => {
  it("renders nothing for a clean pass", () => {
    expect(chips("[gardener] nothing to propose")).toBe("");
  });

  it("counts the applies", () => {
    expect(chips([APPLIED(1), APPLIED(2)].join("\n"))).toContain("2 applied");
  });

  it("shows the notes chip alongside the applies, not only instead of them", () => {
    // The combination that matters most operationally: the pass moved beads AND held one back. A
    // chip suppressed whenever there are records hides the hold-back until the row is expanded —
    // which is exactly the row an operator most needs pulled open.
    const html = chips([APPLIED(1), APPLIED(2), APPLIED(3), HELD_BACK].join("\n"));
    expect(html).toContain("3 applied");
    expect(html).toContain("1 note");
  });

  it("chips a move that landed and could not be settled apart from a clean apply", () => {
    // Folded into "applied" it would read as a finished ask; folded into "could not apply" it would
    // read as a board nothing happened to. It is both, and it is the only chip asking the founder to
    // act — the proposal is still open over a board that already carries its move.
    const unsettled =
      "[gardener] APPLY p-2 (shipped-orphan) retire/close t-2 — APPLIED BUT NOT SETTLED: the move " +
      "LANDED (t-2) and was not rolled back, but the proposal could not be closed";
    const html = chips([APPLIED(1), unsettled].join("\n"));

    expect(html).toContain("1 applied, not settled");
    expect(html).toContain("1 applied");
    expect(html).not.toContain("could not apply");
  });

  it("pluralises the notes chip", () => {
    const unpublished =
      "[gardener] APPLY could not publish this pass's board writes — the 1 move(s) recorded " +
      "above (p-1) are on this machine only";
    expect(chips([APPLIED(1), HELD_BACK, unpublished].join("\n"))).toContain("2 notes");
    expect(chips([APPLIED(1), HELD_BACK].join("\n"))).toContain("1 note");
    expect(chips([APPLIED(1), HELD_BACK].join("\n"))).not.toContain("1 notes");
  });
});
