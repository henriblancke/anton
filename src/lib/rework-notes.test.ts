/**
 * Unit tests for what a rework WRITES IN WORDS (anton-51oq): the instruction note both modes land,
 * the follow-up bead's contract sections, the phrase every rollback record opens with, and the note
 * predicates the double-submit guards read back.
 *
 * Pure module, so this suite is pure too — the strings are the behaviour. That the right one reaches
 * the right bead is src/lib/rework.test.ts's job.
 */
import { describe, expect, it } from "vitest";
import type { Bead } from "./beads/bd";
import { validateBeadContract } from "./beads/contract";
import { formatHumanNote } from "./beads/notes";
import type { ReviewFinding } from "./jobs/review-context";
import {
  followUpDescription,
  hasAnyHumanNote,
  hasHumanNote,
  originNoteBody,
  reworkNoteBody,
  settledPhrase,
} from "./rework-notes";

const INSTRUCTIONS = "Add a test that fails without the null guard.";

function makeBead(over: Partial<Bead> & { id: string }): Bead {
  return { title: over.id, status: "open", issue_type: "task", labels: [], ...over };
}

const ticket = () => makeBead({ id: "t1", title: "Ticket one" });

const noteArgs = {
  mode: "follow-up" as const,
  targetId: "feat",
  summary: "harden the retry",
  instructions: INSTRUCTIONS,
  findings: [] as ReviewFinding[],
  originId: "t1",
};

describe("reworkNoteBody", () => {
  it("says which judgement the founder made, per mode", () => {
    expect(reworkNoteBody({ ...noteArgs, mode: "reopen" })).toContain(
      "Rework — acceptance not met. Sent back from feat's self-review: harden the retry",
    );
    expect(reworkNoteBody(noteArgs)).toContain(
      "Follow-up on t1 — its acceptance stands; feat's self-review",
    );
  });

  it("renders a REDIRECTED send-back apart — it says the opposite thing", () => {
    const body = reworkNoteBody({ ...noteArgs, mode: "reopen", redirected: true });
    expect(body).toContain("acceptance not met on t1, but feat has already merged");
    expect(body).not.toContain("its acceptance stands");
  });

  it("redirects a follow-up's head too — what moved the fix is the merge, not the mode", () => {
    expect(reworkNoteBody({ ...noteArgs, redirected: true })).toContain(
      "but feat has already merged",
    );
  });

  it("carries the instructions verbatim, under the head", () => {
    const body = reworkNoteBody(noteArgs);
    expect(body).toContain(INSTRUCTIONS);
    expect(body.indexOf(INSTRUCTIONS)).toBeGreaterThan(body.indexOf("Follow-up on t1"));
  });

  it("appends the selected findings in the reviewer's own words, with their severity", () => {
    const body = reworkNoteBody({
      ...noteArgs,
      findings: [
        { severity: "blocking", location: "src/lib/rework.ts:12", note: "no null guard" },
        { severity: "advisory", location: "(general)", note: "naming drifts" },
      ],
    });
    expect(body).toContain("Findings to fix (from the self-review):");
    expect(body).toContain("- [blocking] src/lib/rework.ts:12 — no null guard");
    expect(body).toContain("- [advisory] (general) — naming drifts");
  });

  it("writes no findings section at all when none were selected", () => {
    const body = reworkNoteBody(noteArgs);
    expect(body).not.toContain("Findings to fix");
    expect(body.trimEnd()).toBe(body);
  });
});

describe("followUpDescription", () => {
  const args = { summary: "harden the retry", ticket: ticket(), targetId: "feat" };

  it("writes a bead the contract judges as complete — an unshaped one poison-parks the runner", () => {
    const description = followUpDescription({ ...args, parentId: "feat" });
    expect(validateBeadContract(makeBead({ id: "anton-new", description }))).toEqual([]);
  });

  it("writes every section by name, in the contract's own headings", () => {
    const description = followUpDescription({ ...args, parentId: "feat" });
    for (const heading of [
      "## Goal",
      "## Acceptance Criteria",
      "## Context",
      "## Out of scope",
      "## Verify",
    ]) {
      expect(description).toContain(heading);
    }
  });

  it("never repeats the instructions — they are the human note, and two copies would drift", () => {
    expect(followUpDescription({ ...args, parentId: "feat" })).not.toContain(INSTRUCTIONS);
  });

  it("tells a parented bead it runs as a ticket, and a parentless one that it is its own target", () => {
    expect(followUpDescription({ ...args, parentId: "feat" })).toContain(
      "It runs as a ticket of feat",
    );
    expect(followUpDescription(args)).toContain("It is its own run target — approve it to run.");
  });

  it("names the ticket it was discovered from, and says that ticket's acceptance was MET", () => {
    const description = followUpDescription(args);
    expect(description).toContain("Discovered from t1 — Ticket one");
    expect(description).toContain("That ticket's acceptance was met and it keeps its review score");
  });

  it("says WHY the fix moved instead, when a merge redirected it", () => {
    const description = followUpDescription({
      ...args,
      pipeline: { outcome: "shipped", pr: "gh-42", redirected: true },
    });
    expect(description).toContain("The founder judged its acceptance unmet");
    expect(description).toContain("(gh-42) had already merged, so this bead carries the fix");
    expect(description).not.toContain("That ticket's acceptance was met");
  });

  it("keeps an ORDINARY pipeline's provenance unredirected — a retire didn't move anything", () => {
    expect(
      followUpDescription({
        ...args,
        pipeline: { outcome: "retired", pr: "gh-42", redirected: false },
      }),
    ).toContain("That ticket's acceptance was met");
  });
});

describe("originNoteBody", () => {
  it("points the original at its follow-up and leaves its acceptance standing", () => {
    const body = originNoteBody("anton-new");
    expect(body).toContain("Follow-up anton-new was opened from this ticket's review");
    expect(body).toContain("its acceptance stands");
  });

  it("keeps a redirected pointer from claiming the acceptance stood", () => {
    const body = originNoteBody("anton-new", {
      outcome: "shipped",
      pr: "gh-42",
      redirected: true,
    });
    expect(body).toContain("judged its acceptance unmet");
    expect(body).toContain("gh-42 had already merged");
    expect(body).not.toContain("its acceptance stands");
  });

  it("reads as an ordinary follow-up for a pipeline that only retired a live PR", () => {
    expect(
      originNoteBody("anton-new", { outcome: "retired", pr: "gh-42", redirected: false }),
    ).toContain("its acceptance stands");
  });
});

describe("settledPhrase", () => {
  it("keeps 'unreadable' distinct from a state change — they are fixed differently", () => {
    expect(settledPhrase("gh-42", "unknown")).toBe(
      "gh-42's state could no longer be read as it was applying",
    );
    for (const state of ["open", "merged", "closed"] as const) {
      expect(settledPhrase("gh-42", state)).toBe(`gh-42 reads as ${state} now`);
    }
  });
});

describe("hasHumanNote", () => {
  const body = reworkNoteBody(noteArgs);
  const withNote = (text: string) =>
    makeBead({ id: "t1", notes: formatHumanNote(text, "founder", new Date()) });

  it("matches its own blob back through the note header and its indentation", () => {
    expect(hasHumanNote(withNote(body), body)).toBe(true);
  });

  it("is whitespace-insensitive, so a note round-tripped through the blob still matches itself", () => {
    expect(hasHumanNote(withNote(body), `\n  ${body.replace(/\n/g, "\n\n")}  `)).toBe(true);
  });

  it("does not match a DIFFERENT request — a changed instruction is a new send-back", () => {
    expect(hasHumanNote(withNote(body), `${body}\n\nand one more thing`)).toBe(false);
    expect(hasHumanNote(withNote(`${body} plus`), body)).toBe(false);
  });

  it("is false on a bead with no notes at all", () => {
    expect(hasHumanNote(makeBead({ id: "t1" }), body)).toBe(false);
    expect(hasHumanNote(makeBead({ id: "t1", notes: "" }), body)).toBe(false);
  });

  it("ignores anton's own note carrying the same words — only a human note is a request", () => {
    expect(hasHumanNote(makeBead({ id: "t1", notes: body }), body)).toBe(false);
  });

  it("finds the note among several, whoever wrote the others", () => {
    const bead = makeBead({
      id: "t1",
      notes: [
        "anton: run failed after 2 tickets",
        formatHumanNote("an earlier steer", "founder", new Date()),
        formatHumanNote(body, "founder", new Date()),
      ].join("\n"),
    });
    expect(hasHumanNote(bead, body)).toBe(true);
  });
});

describe("hasAnyHumanNote", () => {
  it("ignores anton's own bookkeeping — only a request leaves a human note", () => {
    expect(hasAnyHumanNote(makeBead({ id: "t1", notes: "anton: rework — retired" }))).toBe(false);
  });

  it("is false for a bead with no notes — that follow-up speaks for no request", () => {
    expect(hasAnyHumanNote(makeBead({ id: "t1" }))).toBe(false);
    expect(hasAnyHumanNote(makeBead({ id: "t1", notes: "   " }))).toBe(false);
  });

  it("is true as soon as one human note is there", () => {
    expect(
      hasAnyHumanNote(makeBead({ id: "t1", notes: formatHumanNote("hi", "founder", new Date()) })),
    ).toBe(true);
  });
});
