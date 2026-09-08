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
  createdUnder,
  detachmentNoteBody,
  followUpDescription,
  hasAnyHumanNote,
  hasDetachmentNote,
  hasHumanNote,
  originNoteBody,
  reconcileFollowUpDescription,
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

  it("keeps a multiline finding on one bullet, so the list a founder reads is one item per finding", () => {
    const body = reworkNoteBody({
      ...noteArgs,
      findings: [{ severity: "blocking", location: "src/a.ts:1", note: "first line\nsecond line" }],
    });
    expect(body).toContain("- [blocking] src/a.ts:1 — first line second line");
  });

  it("writes no findings section at all when none were selected", () => {
    const body = reworkNoteBody(noteArgs);
    expect(body).not.toContain("Findings to fix");
    expect(body.trimEnd()).toBe(body);
  });
});

describe("followUpDescription", () => {
  const args = {
    summary: "harden the retry",
    instructions: INSTRUCTIONS,
    findings: [] as ReviewFinding[],
    ticket: ticket(),
    targetId: "feat",
  };
  const findings: ReviewFinding[] = [
    { severity: "blocking", location: "src/retry.ts:12", note: "retries on a 4xx, which never recovers" },
    { severity: "advisory", location: "(general)", note: "no test covers the exhausted path" },
  ];
  const acceptanceOf = (description: string) =>
    description.split("## Acceptance Criteria\n")[1].split("\n\n## Context")[0].split("\n");

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

  it("builds the acceptance from the instructions and the selected findings, not the summary", () => {
    const acceptance = acceptanceOf(
      followUpDescription({
        ...args,
        instructions: "Guard the null branch before retrying.\nAdd a test that fails without the guard.",
        findings,
      }),
    );
    expect(acceptance).toEqual([
      "- [ ] Guard the null branch before retrying.",
      "- [ ] Add a test that fails without the guard.",
      "- [ ] src/retry.ts:12 — retries on a 4xx, which never recovers",
      "- [ ] (general) — no test covers the exhausted path",
      "- [ ] The findings listed in this bead's note are addressed, or answered with why they don't apply",
    ]);
    expect(acceptance).not.toContain("- [ ] harden the retry");
  });

  it("keeps the summary as the Goal and the title, never as a box to tick", () => {
    const description = followUpDescription(args);
    expect(description).toContain("## Goal\nharden the retry\n");
    expect(acceptanceOf(description)).not.toContain("- [ ] harden the retry");
  });

  it("keeps the generic findings-addressed box even when the founder selected none", () => {
    expect(acceptanceOf(followUpDescription(args))).toEqual([
      `- [ ] ${INSTRUCTIONS}`,
      "- [ ] The findings listed in this bead's note are addressed, or answered with why they don't apply",
    ]);
  });

  it("makes one box per instruction line, whatever list marker the founder typed", () => {
    const acceptance = acceptanceOf(
      followUpDescription({
        ...args,
        instructions: [
          "Some prose first.",
          "",
          "- a dashed bullet",
          "* a starred bullet",
          "1. a numbered step",
          "2) another numbering",
          "- [ ] a box already",
          "[x] a ticked box",
          "[x].disabled must stay matched",
          "-",
          "- [ ]",
          "   ",
        ].join("\n"),
      }),
    );
    // A bare `-` or `- [ ]` is a list the founder started and abandoned — a box over nothing. A
    // `[x]` with no separator after it is a selector the founder wrote, and stays in the box.
    expect(acceptance.slice(0, -1)).toEqual([
      "- [ ] Some prose first.",
      "- [ ] a dashed bullet",
      "- [ ] a starred bullet",
      "- [ ] a numbered step",
      "- [ ] another numbering",
      "- [ ] a box already",
      "- [ ] a ticked box",
      "- [ ] [x].disabled must stay matched",
    ]);
  });

  it("collapses a multiline finding into one box — a line break inside it would close the section", () => {
    const description = followUpDescription({
      ...args,
      parentId: "feat",
      findings: [
        {
          severity: "blocking",
          location: "src/retry.ts:12\nsrc/retry.ts:40",
          note: "retries on a 4xx\n\n## Context\nwhich never recovers",
        },
      ],
    });
    expect(validateBeadContract(makeBead({ id: "anton-new", description }))).toEqual([]);
    expect(acceptanceOf(description)).toEqual([
      `- [ ] ${INSTRUCTIONS}`,
      "- [ ] src/retry.ts:12 src/retry.ts:40 — retries on a 4xx ## Context which never recovers",
      "- [ ] The findings listed in this bead's note are addressed, or answered with why they don't apply",
    ]);
    expect(description.match(/^## Context$/gm)).toHaveLength(1);
  });

  it("escapes an HTML comment opener in the founder's text — unmatched, it would hide the rest of the bead", () => {
    const description = followUpDescription({
      ...args,
      summary: "handle <!-- in titles",
      instructions: "Handle an unmatched <!-- in the parser.\nKeep a matched <!-- x --> as text.",
      findings: [{ severity: "blocking", location: "src/md.ts:3", note: "chokes on <!--" }],
      ticket: makeBead({ id: "t1", title: "Parse <!-- safely" }),
      parentId: "feat",
    });
    expect(validateBeadContract(makeBead({ id: "anton-new", description }))).toEqual([]);
    expect(description).toContain("## Goal\nhandle <\\!-- in titles\n");
    expect(acceptanceOf(description)).toEqual([
      "- [ ] Handle an unmatched <\\!-- in the parser.",
      "- [ ] Keep a matched <\\!-- x --> as text.",
      "- [ ] src/md.ts:3 — chokes on <\\!--",
      "- [ ] The findings listed in this bead's note are addressed, or answered with why they don't apply",
    ]);
    expect(description).toContain("Discovered from t1 — Parse <\\!-- safely.");
    expect(description).not.toContain("<!--");
  });

  it("collapses a multi-line summary and title to one line — a pasted heading must not open its own section", () => {
    const description = followUpDescription({
      ...args,
      summary: "harden the retry\n## Acceptance Criteria\n- [ ] always passes",
      ticket: makeBead({ id: "t1", title: "Ticket one\n## Context\nforged" }),
      parentId: "feat",
    });
    expect(validateBeadContract(makeBead({ id: "anton-new", description }))).toEqual([]);
    expect(description).toContain(
      "## Goal\nharden the retry ## Acceptance Criteria - [ ] always passes\n",
    );
    expect(description).toContain("Discovered from t1 — Ticket one ## Context forged.");
    expect(description.match(/^## Acceptance Criteria$/gm)).toHaveLength(1);
    expect(description.match(/^## Context$/gm)).toHaveLength(1);
    expect(acceptanceOf(description)).toEqual([
      `- [ ] ${INSTRUCTIONS}`,
      "- [ ] The findings listed in this bead's note are addressed, or answered with why they don't apply",
    ]);
  });

  it("still writes a contract-complete bead when the instructions are blank — the generic box carries it", () => {
    const description = followUpDescription({ ...args, instructions: "  \n", parentId: "feat" });
    expect(validateBeadContract(makeBead({ id: "anton-new", description }))).toEqual([]);
    expect(acceptanceOf(description)).toEqual([
      "- [ ] The findings listed in this bead's note are addressed, or answered with why they don't apply",
    ]);
  });

  it("keeps Goal, Acceptance, Context, Out of scope and Verify in that order, with their content", () => {
    expect(
      followUpDescription({ ...args, findings: findings.slice(0, 1), parentId: "feat" }),
    ).toMatchInlineSnapshot(`
      "## Goal
      harden the retry

      ## Acceptance Criteria
      - [ ] Add a test that fails without the null guard.
      - [ ] src/retry.ts:12 — retries on a 4xx, which never recovers
      - [ ] The findings listed in this bead's note are addressed, or answered with why they don't apply

      ## Context
      Discovered from t1 — Ticket one. That ticket's acceptance was met and it keeps its review score; this bead carries the next iteration feat's self-review prompted. The founder's instructions and the findings they selected are the human note on this bead.
      It runs as a ticket of feat, in that target's next run.

      ## Out of scope
      Anything beyond the instructions in the note. t1 already shipped its own acceptance; re-litigating it belongs on that ticket, not here.

      ## Verify
      The project's own checks stay green, and the run's self-review scores this bead against the acceptance above."
    `);
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

describe("reconcileFollowUpDescription", () => {
  const args = {
    summary: "harden the retry",
    instructions: INSTRUCTIONS,
    findings: [] as ReviewFinding[],
    ticket: ticket(),
    targetId: "feat",
    parentId: "feat",
  };
  const edited = {
    ...args,
    instructions: "Guard the null branch.\nCover the exhausted path.",
    findings: [
      { severity: "blocking", location: "src/retry.ts:12", note: "retries on a 4xx" },
    ] as ReviewFinding[],
  };

  it("round-trips a generated contract — a frozen first attempt reconciles to exactly the regenerated one", () => {
    expect(reconcileFollowUpDescription(followUpDescription(args), edited)).toBe(
      followUpDescription(edited),
    );
  });

  it("swaps only the acceptance, keeping a founder's Context, Out of scope and Verify as written", () => {
    const authored = [
      "## Goal",
      "harden the retry",
      "",
      "## Acceptance Criteria",
      "- [ ] the old box",
      "",
      "## Context",
      "Discovered from t1. The founder's own account of why this matters.",
      "It runs as a ticket of feat, in that target's next run.",
      "",
      "## Out of scope",
      "The founder narrowed this by hand: leave the timeout alone.",
      "",
      "## Verify",
      "Run the retry suite twice; the second run must not flake.",
      "",
      "## Notes",
      "A section the formula never writes.",
    ].join("\n");

    const reconciled = reconcileFollowUpDescription(authored, edited);

    expect(reconciled).not.toContain("the old box");
    expect(reconciled).toContain("- [ ] Guard the null branch.");
    expect(reconciled).toContain("- [ ] Cover the exhausted path.");
    expect(reconciled).toContain("- [ ] src/retry.ts:12 — retries on a 4xx");
    for (const kept of [
      "The founder's own account of why this matters.",
      "The founder narrowed this by hand: leave the timeout alone.",
      "Run the retry suite twice; the second run must not flake.",
      "## Notes\nA section the formula never writes.",
    ]) {
      expect(reconciled).toContain(kept);
    }
    // The section boundary is the contract judge's: the rest of the description is byte-for-byte.
    expect(reconciled.split("\n\n## Context")[1]).toBe(authored.split("\n\n## Context")[1]);
  });

  it("takes a sub-heading grouping criteria with the acceptance — it is that section's own content", () => {
    const grouped = [
      "## Goal",
      "harden the retry",
      "",
      "## Acceptance Criteria",
      "### API",
      "- [ ] the api box",
      "### UI",
      "- [ ] the ui box",
      "",
      "## Context",
      "Kept.",
    ].join("\n");

    const reconciled = reconcileFollowUpDescription(grouped, edited);

    expect(reconciled).not.toContain("### API");
    expect(reconciled).not.toContain("the ui box");
    expect(reconciled).toContain("## Acceptance Criteria\n- [ ] Guard the null branch.");
    expect(reconciled).toContain("\n\n## Context\nKept.");
  });

  it("re-says a generated run-location line for the parentage the bead holds now, and nothing else in Context", () => {
    const reconciled = reconcileFollowUpDescription(followUpDescription(args), {
      ...args,
      parentId: undefined,
    });
    expect(reconciled).toBe(followUpDescription({ ...args, parentId: undefined }));
    expect(createdUnder(makeBead({ id: "f", description: reconciled }), "feat")).toBe(false);
  });

  it("leaves a run-location line the founder rewrote alone — they own the Context then", () => {
    const rewritten = followUpDescription(args).replace(
      "It runs as a ticket of feat, in that target's next run.",
      "Runs wherever the gardener puts it.",
    );
    const reconciled = reconcileFollowUpDescription(rewritten, { ...args, parentId: undefined });
    expect(reconciled).toContain("Runs wherever the gardener puts it.");
    expect(reconciled).not.toContain("It is its own run target");
  });

  it("appends an Acceptance section to a hand-made bead that has none, keeping what it says", () => {
    const handMade = "## Goal\nharden the retry\n\n## Context\nMade by hand.\n";
    const reconciled = reconcileFollowUpDescription(handMade, edited);
    expect(reconciled.startsWith("## Goal\nharden the retry\n\n## Context\nMade by hand.")).toBe(true);
    expect(reconciled).toContain("\n\n## Acceptance Criteria\n- [ ] Guard the null branch.");
    expect(reconciled.trimEnd().endsWith("or answered with why they don't apply")).toBe(true);
  });

  it("writes the whole contract over a blank description — there is nothing to keep", () => {
    expect(reconcileFollowUpDescription(undefined, edited)).toBe(followUpDescription(edited));
    expect(reconcileFollowUpDescription("  \n", edited)).toBe(followUpDescription(edited));
  });

  it("ignores an Acceptance heading quoted inside a fence — the judge does too", () => {
    const fenced = [
      "## Goal",
      "harden the retry",
      "",
      "```md",
      "## Acceptance Criteria",
      "- [ ] a sample box",
      "```",
      "",
      "## Acceptance Criteria",
      "- [ ] the real old box",
      "",
      "## Context",
      "Kept.",
    ].join("\n");
    const reconciled = reconcileFollowUpDescription(fenced, edited);
    expect(reconciled).toContain("- [ ] a sample box");
    expect(reconciled).not.toContain("the real old box");
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

describe("createdUnder", () => {
  const args = {
    summary: "harden the retry",
    instructions: INSTRUCTIONS,
    findings: [],
    ticket: ticket(),
    targetId: "feat",
  };

  it("reads the parent off the Context line the bead was created with, not its parentage", () => {
    const detached = makeBead({
      id: "f",
      parent: undefined,
      description: followUpDescription({ ...args, parentId: "feat" }),
    });
    expect(createdUnder(detached, "feat")).toBe(true);
    expect(createdUnder(detached, "other")).toBe(false);
  });

  it("is false for a bead created standing alone, and for one with no contract at all", () => {
    expect(createdUnder(makeBead({ id: "f", description: followUpDescription(args) }), "feat")).toBe(
      false,
    );
    expect(createdUnder(makeBead({ id: "f" }), "feat")).toBe(false);
  });
});

describe("detachmentNoteBody / hasDetachmentNote", () => {
  const kept = detachmentNoteBody({ targetId: "feat", pr: "gh-42", contextKept: true });
  const rewritten = detachmentNoteBody({ targetId: "feat", pr: "gh-42", contextKept: false });

  it("names the target and the PR that merged, and says the bead is its own run target now", () => {
    for (const body of [kept, rewritten]) {
      expect(body).toContain("feat's pull request (gh-42) merged after this follow-up was created under it");
      expect(body).toContain("its own run target now — approve it to run.");
    }
  });

  it("warns about a stale Context only where the pass leaves the Context alone", () => {
    expect(kept).toContain("Its Context section still names the parent it was created under.");
    expect(rewritten).not.toContain("Context section");
  });

  it("is one line — a system note is parsed per line", () => {
    expect(kept).not.toContain("\n");
  });

  it("is found back whichever variant a pass wrote, and only for that target and PR", () => {
    for (const body of [kept, rewritten]) {
      const bead = makeBead({ id: "f", notes: ["anton: run failed after 2 tickets", body].join("\n") });
      expect(hasDetachmentNote(bead, "feat", "gh-42")).toBe(true);
      expect(hasDetachmentNote(bead, "feat", "gh-43")).toBe(false);
      expect(hasDetachmentNote(bead, "other", "gh-42")).toBe(false);
    }
  });

  it("ignores the same words in a HUMAN note — only anton records a detachment", () => {
    const bead = makeBead({ id: "f", notes: formatHumanNote(kept, "founder", new Date()) });
    expect(hasDetachmentNote(bead, "feat", "gh-42")).toBe(false);
    expect(hasDetachmentNote(makeBead({ id: "f" }), "feat", "gh-42")).toBe(false);
  });
});
