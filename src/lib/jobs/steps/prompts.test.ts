/**
 * Direct tests for prompt construction: what a ticket's task text inlines, what it leaves out, and
 * what the PR body says.
 *
 * The spec is inlined so an agent can implement with an unreadable in-worktree beads DB (issue #46
 * root cause #3) — so "the section is present" is the assertion that matters, per section.
 */
import { describe, expect, it, vi } from "vitest";

import type { Bead } from "../../beads/bd";
import type { PreservedCommit } from "../../git/ops";
import { ANTON_REPO_URL } from "../../repo";
import type { SatisfiedSettlement } from "./context";
import {
  BODY_REGION_END,
  BODY_REGION_START,
  narrativeFieldLines,
  prBody,
  type PromptGateFailure,
  stepTaskBlock,
  ticketPrompt,
  truncateField,
  upsertBodyRegion,
} from "./prompts";
import type { RunNarrative } from "./result";
import { target } from "./step.fixture";

const ticket = (overrides: Partial<Bead> = {}): Bead => ({
  id: "anton-t1",
  title: "Ship the thing",
  status: "open",
  issue_type: "task",
  ...overrides,
});

describe("ticketPrompt", () => {
  it("inlines the spec the agent needs and always states the acceptance section", () => {
    const prompt = ticketPrompt(
      ticket({
        description: "## Goal\n\nShip it.",
        acceptance_criteria: "- [ ] it ships",
        context: "the surrounding system",
      }),
    );

    expect(prompt).toContain("Ticket: anton-t1 — Ship the thing");
    expect(prompt).toContain("## Goal / Out of scope / Verify");
    expect(prompt).toContain("Ship it.");
    expect(prompt).toContain("## Acceptance criteria");
    expect(prompt).toContain("- [ ] it ships");
    expect(prompt).toContain("## Context");
    expect(prompt).toContain("the surrounding system");
    expect(prompt).toContain("bd show anton-t1");
  });

  // A bare bead must still produce a dispatchable prompt — and must SAY the acceptance is missing
  // rather than omitting the heading, which reads as "no rubric was asked for".
  it("omits the sections a bead carries nothing for, but never the acceptance heading", () => {
    const prompt = ticketPrompt(ticket());

    expect(prompt).not.toContain("## Goal / Out of scope / Verify");
    expect(prompt).not.toContain("## Context");
    expect(prompt).toContain("## Acceptance criteria\n(none stated)");
  });

  // Some boards carry Context as its own column, others fold it into `description`. Inlining both
  // would hand the agent the same paragraph twice.
  it("drops a standalone Context that only repeats the description", () => {
    const body = "## Goal\n\nShip it.";
    const prompt = ticketPrompt(ticket({ description: body, context: body }));

    expect(prompt.match(/Ship it\./g)).toHaveLength(1);
    expect(prompt).not.toContain("## Context");
  });

  // A ticket is one step of a run whose earlier steps committed to the same branch (anton-6l0q):
  // the prompt must teach `satisfied` as the honest answer for that spot — with its evidence — so
  // an agent whose work is already on the branch no longer has to choose `blocked` and park.
  it("teaches the satisfied outcome, its commit evidence, and when it is the honest answer", () => {
    const prompt = ticketPrompt(ticket());

    expect(prompt).toContain("ANTON-RESULT: satisfied — <commit sha> —");
    expect(prompt).toContain("earlier steps of this run committed here");
    expect(prompt).toContain("every acceptance criterion");
    expect(prompt).toContain("naming the commit that did it");
    expect(prompt).toContain("do not report `blocked`");
    expect(prompt).toContain("do the remaining work and report `delivered`");
  });

  // The operator's steer (anton-bfy4) is the freshest intent, so it reads as a refinement of the
  // contract above it rather than as prologue.
  it("appends human notes last, after the spec", () => {
    const prompt = ticketPrompt(
      ticket({
        description: "## Goal\n\nShip it.",
        notes: "[human-note founder 2026-08-18T00:00:00.000Z]\n  Prefer the smaller change.",
      }),
    );

    expect(prompt).toContain("Prefer the smaller change.");
    expect(prompt.indexOf("Prefer the smaller change.")).toBeGreaterThan(prompt.indexOf("Ship it."));
  });
});

describe("ticketPrompt — the continuation block (anton-16pq)", () => {
  const preserved: PreservedCommit = {
    sha: "abc1234",
    subject: "WIP anton-t1: Ship the thing",
    files: ["src/a.ts", "src/b.ts"],
    earlier: [],
  };

  // Silence is what parked the run: the resume re-read the spec, found its change apparently made,
  // and exited having written nothing.
  it("tells a resumed ticket what was preserved, that it is incomplete, and to continue from it", () => {
    const prompt = ticketPrompt(ticket({ description: "## Goal\n\nShip it." }), preserved);

    expect(prompt).toContain("CONTINUATION");
    expect(prompt).toContain("abc1234 WIP anton-t1: Ship the thing");
    expect(prompt).toContain("- src/a.ts");
    expect(prompt).toContain("- src/b.ts");
    expect(prompt).toContain("INCOMPLETE");
    expect(prompt).toContain("git show abc1234");
    expect(prompt).toMatch(/do not restart the ticket from scratch/i);
    // The one case where the base contract's "never report delivered on an unchanged tree" does not
    // apply — without saying so, an honest agent parks the run it could have finished.
    expect(prompt).toContain("ANTON-RESULT: delivered");
  });

  // The generic closing's `satisfied` guidance would follow the continuation block and contradict
  // it: a preserved-adoption settle can only be `delivered`, so telling the agent to report
  // `satisfied` re-parks the resume this block exists to unblock (PR #255 review).
  it("omits the satisfied closing for a resumed ticket, leaving delivered as the only outcome", () => {
    const prompt = ticketPrompt(ticket({ description: "## Goal\n\nShip it." }), preserved);

    expect(prompt).not.toContain("ANTON-RESULT: satisfied");
    expect(prompt).toContain("ANTON-RESULT: delivered");
  });

  // The block is state of the BRANCH, so it only means anything once the agent knows what the
  // ticket asks for.
  it("places the block after the spec", () => {
    const prompt = ticketPrompt(ticket({ description: "## Goal\n\nShip it." }), preserved);

    expect(prompt.indexOf("CONTINUATION")).toBeGreaterThan(prompt.indexOf("Ship it."));
  });

  // An empty preserved commit is the marker form: the previous agent committed the work itself, so
  // pointing at this commit's diff would say nothing was kept.
  it("sends the agent to the commits beneath a marker rather than to its empty diff", () => {
    const prompt = ticketPrompt(ticket(), { ...preserved, files: [] });

    expect(prompt).not.toContain("Files changed across the preserved work:");
    expect(prompt).toContain("it is a marker");
    expect(prompt).toContain("git log -p");
  });

  // A net-zero range is NOT a marker: the newest commit is non-empty (an earlier attempt's edits
  // were undone by a later one), so telling the agent the work is self-committed beneath it lies.
  it("does not claim a marker when the range nets to nothing but the newest commit is non-empty", () => {
    const prompt = ticketPrompt(ticket(), { ...preserved, files: [], newestEmpty: false });

    expect(prompt).not.toContain("it is a marker");
    expect(prompt).not.toContain("Files changed across the preserved work:");
    expect(prompt).toContain("cancel out to no net change");
    expect(prompt).toContain("git log -p");
  });

  // A ticket can time out more than once; every preserved commit's work is on the branch, so the
  // agent must be pointed at the whole range, not just the newest delta (anton-16pq, PR #255 review).
  it("lists every preserved attempt and inspects the whole range when a ticket timed out twice", () => {
    const prompt = ticketPrompt(ticket(), {
      ...preserved,
      files: ["src/a.ts", "src/b.ts"],
      earlier: [{ sha: "old5678", subject: "WIP anton-t1: first attempt" }],
    });

    expect(prompt).toContain("abc1234 WIP anton-t1: Ship the thing");
    expect(prompt).toContain("old5678 WIP anton-t1: first attempt");
    // The range covers both attempts, not just the newest commit's delta.
    expect(prompt).toContain("git show old5678^..abc1234");
    expect(prompt).toContain("Those commits are INCOMPLETE");
  });

  // With the fork point known the range starts at the ticket BASELINE, so the agent inspects a first
  // attempt's self-committed work beneath an empty marker too, not just the marker commits (anton-16pq).
  it("inspects from the ticket baseline when the fork point is known", () => {
    const prompt = ticketPrompt(ticket(), {
      ...preserved,
      earlier: [{ sha: "old5678", subject: "WIP anton-t1: first attempt" }],
      baseline: "base0000",
    });

    expect(prompt).toContain("git show base0000..abc1234");
    expect(prompt).not.toContain("old5678^..abc1234");
  });

  // A git failure is not an empty commit: presenting `undefined` files as a marker would falsely tell
  // the agent the work lives beneath a commit anton never actually read (PR #255 review).
  it("does not claim an empty marker when the preserved diff could not be read", () => {
    const prompt = ticketPrompt(ticket(), { ...preserved, files: undefined });

    expect(prompt).not.toContain("it is a marker");
    expect(prompt).not.toContain("Files changed across the preserved work:");
    expect(prompt).toContain("could not read the preserved diff");
  });

  // The whole point of the gate this feeds: a fresh ticket must read exactly as it did before.
  it("leaves a fresh ticket's prompt byte-identical", () => {
    const fresh = ticket({ description: "## Goal\n\nShip it.", acceptance_criteria: "- [ ] ships" });

    expect(ticketPrompt(fresh, undefined)).toBe(ticketPrompt(fresh));
    expect(ticketPrompt(fresh)).not.toContain("CONTINUATION");
  });
});

describe("ticketPrompt — the recorded gate failure block (anton-ahsja)", () => {
  const failure: PromptGateFailure = {
    label: "test",
    command: "bun run test",
    code: 1,
    output: "FAIL test_stt_stream_restart_midcall_is_transparent\nexpected true, got false",
  };

  it("names the gate, its command, its exit code, and the tail of its output", () => {
    const prompt = ticketPrompt(ticket({ description: "## Goal\n\nShip it." }), undefined, failure);

    expect(prompt).toContain("**test** gate failed");
    expect(prompt).toContain("`bun run test`");
    expect(prompt).toContain("exited 1");
    expect(prompt).toContain("test_stt_stream_restart_midcall_is_transparent");
  });

  // The block reports the class and the evidence and stops there (anton-4gnv): it never asserts
  // this attempt's diff caused a failure recorded by a DIFFERENT attempt.
  it("asks the agent to determine whether the failure is pre-existing, and never blames the agent", () => {
    const prompt = ticketPrompt(ticket(), undefined, failure);

    expect(prompt).toContain("PRE-EXISTING");
    expect(prompt).toMatch(/figure out which/i);
    expect(prompt).toMatch(/say so in your report/i);
    expect(prompt).not.toMatch(/caused/i);
    expect(prompt).not.toMatch(/you (broke|introduced)/i);
    expect(prompt).not.toMatch(/your (diff|change|work) (broke|introduced)/i);
  });

  it("places the block after the spec", () => {
    const prompt = ticketPrompt(ticket({ description: "## Goal\n\nShip it." }), undefined, failure);

    expect(prompt.indexOf("A gate failed on a previous attempt")).toBeGreaterThan(
      prompt.indexOf("Ship it."),
    );
  });

  it("tails a long output and caps it, rather than heading it", () => {
    const lines = Array.from({ length: 2000 }, (_, i) => `line ${i}`);
    const long = ticketPrompt(ticket(), undefined, { ...failure, output: lines.join("\n") });

    expect(long).not.toContain("line 0\n");
    expect(long).toContain(`line ${lines.length - 1}`);
    expect(long).toContain("[earlier output omitted]");
  });

  // The whole point of the gate this feeds: a ticket with no recorded failure reads exactly as it
  // did before this block existed.
  it("leaves a prompt with no recorded failure byte-identical", () => {
    const fresh = ticket({ description: "## Goal\n\nShip it.", acceptance_criteria: "- [ ] ships" });

    expect(ticketPrompt(fresh, undefined, undefined)).toBe(ticketPrompt(fresh));
    expect(ticketPrompt(fresh)).not.toContain("A gate failed on a previous attempt");
  });
});

describe("truncateField", () => {
  it("passes a normal field through, trimmed", () => {
    expect(truncateField("  hello  ")).toBe("hello");
  });

  it("caps a pathological field and says where the rest is", () => {
    const capped = truncateField("x".repeat(9_000));

    expect(capped.length).toBeLessThan(9_000);
    expect(capped).toContain("truncated");
    expect(capped).toContain("bd show");
  });
});

describe("stepTaskBlock", () => {
  it("names the step, the run target and the worktree the agent is already in", () => {
    const block = stepTaskBlock(
      { target, tickets: [target], branch: "anton/anton-8d0f", baseBranch: "main" },
      "design",
    );

    expect(block).toContain("`design` step");
    expect(block).toContain(target.id);
    expect(block).toContain("anton/anton-8d0f");
    expect(block).toContain("forked from main");
    expect(block).toContain(`- ${target.id} — ${target.title}`);
  });

  it("inlines every ticket's contract so an already-shipped report is scoped to work the agent received", () => {
    const second = ticket({
      id: "anton-t2",
      title: "Second ticket",
      description: "## Goal\n\nShip the second thing.",
      acceptance_criteria: "- [ ] the second thing ships",
      context: "The second ticket's surrounding system.",
    });
    const block = stepTaskBlock(
      {
        target,
        tickets: [
          { ...target, description: "## Goal\n\nShip the first thing.", acceptance_criteria: "- [ ] the first thing ships" },
          second,
        ],
        branch: "anton/anton-8d0f",
        baseBranch: "main",
      },
      "claude",
    );

    expect(block).toContain(`## Ticket contract — ${target.id}`);
    expect(block).toContain("Ship the first thing.");
    expect(block).toContain("the first thing ships");
    expect(block).toContain("## Ticket contract — anton-t2");
    expect(block).toContain("Ship the second thing.");
    expect(block).toContain("the second thing ships");
    expect(block).toContain("The second ticket's surrounding system.");
  });

  // A formula may run a generic step before `step:implement` (PR #255 review), so on resume this
  // step is dispatched first onto a timed-out attempt's preserved commits and must be told they
  // exist — but not told to settle the ticket, which is the implementer's job and the gate's.
  it("injects continuation awareness for a resumed step but prescribes no outcome", () => {
    const block = stepTaskBlock(
      { target, tickets: [target], branch: "anton/anton-8d0f", baseBranch: "main" },
      "claude",
      [
        {
          ticketId: target.id,
          commit: {
            sha: "abc1234",
            subject: `WIP ${target.id}: work so far`,
            files: ["src/a.ts"],
            earlier: [{ sha: "def5678", subject: `WIP ${target.id}: first pass` }],
          },
        },
      ],
    );

    expect(block).toContain("CONTINUATION");
    expect(block).toContain("abc1234 WIP");
    expect(block).toContain("def5678 WIP");
    expect(block).toContain("INCOMPLETE");
    expect(block).toMatch(/do not revert, re-do, or discard it/i);
    // The inspect command spans the WHOLE preserved range, not just the newest marker's diff.
    expect(block).toContain("git show def5678^..abc1234");
    // Settling is the implementer's job and the delivery gate's, so a generic step is never told to
    // report `delivered`/`satisfied` off the preserved work.
    expect(block).not.toContain("ANTON-RESULT");
  });

  // A timed-out attempt that self-committed its work leaves an EMPTY `WIP` marker, so pointing the
  // generic step at `git show <marker-sha>` alone would show nothing and hide the real commits
  // beneath it — the exact revert/redo this block exists to prevent (PR #255 review).
  it("sends a resumed generic step to the commits beneath an empty marker, not its empty diff", () => {
    const block = stepTaskBlock(
      { target, tickets: [target], branch: "anton/anton-8d0f", baseBranch: "main" },
      "claude",
      [{ ticketId: target.id, commit: { sha: "abc1234", subject: `WIP ${target.id}: work`, files: [], earlier: [] } }],
    );

    expect(block).not.toContain("Files changed across the preserved work:");
    expect(block).toContain("it is a marker");
    expect(block).toContain("git log -p");
  });

  // With the fork point known the inspect range starts at the ticket baseline, so a first attempt's
  // self-committed work beneath a marker is inspected too, not just the marker commits (anton-16pq).
  it("inspects a resumed generic step from the ticket baseline when the fork point is known", () => {
    const block = stepTaskBlock(
      { target, tickets: [target], branch: "anton/anton-8d0f", baseBranch: "main" },
      "claude",
      [
        {
          ticketId: target.id,
          commit: { sha: "abc1234", subject: `WIP ${target.id}: work`, files: ["src/a.ts"], earlier: [], baseline: "base0000" },
        },
      ],
    );

    expect(block).toContain("git show base0000..abc1234");
  });

  it("omits the continuation block when no ticket in scope has preserved work", () => {
    const block = stepTaskBlock(
      { target, tickets: [target], branch: "anton/anton-8d0f", baseBranch: "main" },
      "claude",
    );

    expect(block).not.toContain("CONTINUATION");
  });
});

describe("prBody", () => {
  // A standalone run's single ticket IS the target, so listing it again is noise.
  it("lists the tickets on an epic run and omits the list on a standalone one", () => {
    const other: Bead = { ...target, id: "anton-t2", title: "Second ticket" };

    expect(prBody(target, [target])).not.toContain("Tickets:");
    expect(prBody(target, [target, other])).toContain("- anton-t2 — Second ticket");
  });

  /**
   * anton-8h4b: a satisfied step is closed on an EARLIER commit of the run and has none of its own,
   * so the body attributes it to that commit instead of listing it as a delivery — a reader matching
   * tickets to commits would otherwise look for one that does not exist.
   */
  it("attributes a satisfied step to the commit that did its work, not to a delivery of its own", () => {
    const first: Bead = { ...target, id: "anton-t1", title: "Add the schema" };
    const second: Bead = { ...target, id: "anton-t2", title: "Expose the schema" };
    const third: Bead = { ...target, id: "anton-t3", title: "Wire the endpoint" };
    const sha = "0123456789abcdef0123456789abcdef01234567";
    const satisfied = new Map<string, SatisfiedSettlement>([
      [second.id, { commit: sha, subject: "anton-t1: Add the schema", closed: true }],
    ]);

    const body = prBody(target, [first, second, third], [], satisfied);
    const [deliveries, attributions] = body.split("Satisfied by earlier commits of this run");

    // The ordinary list keeps its format and holds only the commit-backed steps.
    expect(deliveries).toContain("Tickets:\n- anton-t1 — Add the schema\n- anton-t3 — Wire the endpoint\n");
    expect(deliveries).not.toContain("anton-t2");
    // The satisfied step is named once, against the commit and the ticket whose work it was.
    expect(attributions).toContain("(no commit of their own):");
    expect(attributions).toContain(`- anton-t2 — Expose the schema — by 0123456 "anton-t1: Add the schema"\n`);
    expect(body.match(/anton-t2/g)).toHaveLength(1);
    expect(body).not.toContain("NOT closed");
    // Order is preserved on both sides: the body reads as the run ran.
    expect(body.indexOf("anton-t1")).toBeLessThan(body.indexOf("anton-t3"));
  });

  it("still opens one truthful body when every step after the first was satisfied", () => {
    const first: Bead = { ...target, id: "anton-t1", title: "One change covers all three" };
    const second: Bead = { ...target, id: "anton-t2", title: "Second step" };
    const third: Bead = { ...target, id: "anton-t3", title: "Third step" };
    const sha = "fedcba9876543210fedcba9876543210fedcba98";
    const satisfied = new Map<string, SatisfiedSettlement>([
      [second.id, { commit: sha, subject: "anton-t1: One change covers all three", closed: true }],
      [third.id, { commit: sha, closed: true }],
    ]);

    const body = prBody(target, [first, second, third], [], satisfied);
    expect(body).toContain("Tickets:\n- anton-t1 — One change covers all three\n");
    expect(body).toContain(`- anton-t2 — Second step — by fedcba9 "anton-t1: One change covers all three"`);
    // An unresolved subject leaves the sha to speak alone rather than inventing an attribution.
    expect(body).toContain("- anton-t3 — Third step — by fedcba9\n");
    expect(body).not.toContain("- anton-t2 — Second step\n");
    expect(body).not.toContain("- anton-t3 — Third step\n");
  });

  /**
   * PR #253 review: the deadline can land after the delivery gate accepted the satisfied claim and
   * before the close. The ticket is then BLOCKED with a timeout note, not closed, so the body must not
   * report a close that never happened — it is where the reviewer learns the ticket needs closing.
   */
  it("says a satisfied step whose budget ran out on the close is still blocked, not closed", () => {
    const first: Bead = { ...target, id: "anton-t1", title: "Add the schema" };
    const second: Bead = { ...target, id: "anton-t2", title: "Expose the schema" };
    const third: Bead = { ...target, id: "anton-t3", title: "Document the schema" };
    const sha = "0123456789abcdef0123456789abcdef01234567";
    const satisfied = new Map<string, SatisfiedSettlement>([
      [second.id, { commit: sha, subject: "anton-t1: Add the schema", closed: true }],
      [third.id, { commit: sha, subject: "anton-t1: Add the schema", closed: false }],
    ]);

    const body = prBody(target, [first, second, third], [], satisfied);

    // The header asserts no close on anyone's behalf; each line says what the board holds.
    expect(body).not.toContain("closed on that work");
    expect(body).toContain(`- anton-t2 — Expose the schema — by 0123456 "anton-t1: Add the schema"\n`);
    expect(body).toContain(
      `- anton-t3 — Document the schema — by 0123456 "anton-t1: Add the schema" — NOT closed: ` +
        `the close never landed (its budget ran out on it, or bd refused the write), so it is not done ` +
        `on the board; review that commit and close it by hand`,
    );
    expect(body).not.toContain("- anton-t3 — Document the schema\n");
  });

  /**
   * PR #258 review: a resume can read an attribution trailer off a commit that reached the BASE by
   * an earlier merge. The work is in the tree, so nothing re-does it — but no commit of this pull
   * request carries it, and calling it "an earlier commit of this run" points the reviewer at a diff
   * that cannot contain it.
   */
  it("attributes an INHERITED settlement to the base, under its own heading", () => {
    const first: Bead = { ...target, id: "anton-t1", title: "Add the schema" };
    const mine: Bead = { ...target, id: "anton-t2", title: "Expose the schema" };
    const base: Bead = { ...target, id: "anton-t3", title: "Document the schema" };
    const ranSha = "0123456789abcdef0123456789abcdef01234567";
    const baseSha = "fedcba9876543210fedcba9876543210fedcba98";
    const satisfied = new Map<string, SatisfiedSettlement>([
      [mine.id, { commit: ranSha, subject: "anton-t1: Add the schema", closed: true }],
      [base.id, { commit: baseSha, subject: "older: shipped on main", closed: true, inherited: true }],
    ]);

    const body = prBody(target, [first, mine, base], [], satisfied);

    // Two headings, and each ticket sits under exactly the one that tells the reviewer where to look.
    const [deliveries, ranHere = "", fromBase = ""] = body.split(
      /Satisfied by earlier commits of this run \(no commit of their own\):|Already satisfied by commits in the base, not by this run \(not in this diff\):/,
    );
    expect(deliveries).toContain("Tickets:\n- anton-t1 — Add the schema\n");
    expect(ranHere).toContain(`- anton-t2 — Expose the schema — by 0123456 "anton-t1: Add the schema"\n`);
    expect(ranHere).not.toContain("anton-t3");
    expect(fromBase).toContain(`- anton-t3 — Document the schema — by fedcba9 "older: shipped on main"\n`);
    // Neither is listed as a delivery of its own, and neither is named twice.
    expect(deliveries).not.toContain("anton-t2");
    expect(deliveries).not.toContain("anton-t3");
    expect(body.match(/anton-t3/g)).toHaveLength(1);
  });

  it("omits the base heading entirely when nothing was inherited", () => {
    const first: Bead = { ...target, id: "anton-t1", title: "Add the schema" };
    const second: Bead = { ...target, id: "anton-t2", title: "Expose the schema" };
    const satisfied = new Map<string, SatisfiedSettlement>([
      [second.id, { commit: "0123456789abcdef0123456789abcdef01234567", closed: true, inherited: false }],
    ]);

    const body = prBody(target, [first, second], [], satisfied);
    expect(body).toContain("Satisfied by earlier commits of this run");
    expect(body).not.toContain("not by this run");
  });

  it("says a NOT-closed inherited settlement needs closing by hand, same as one of this run's", () => {
    const first: Bead = { ...target, id: "anton-t1", title: "Add the schema" };
    const second: Bead = { ...target, id: "anton-t2", title: "Expose the schema" };
    const satisfied = new Map<string, SatisfiedSettlement>([
      [second.id, { commit: "fedcba9876543210fedcba9876543210fedcba98", closed: false, inherited: true }],
    ]);

    const body = prBody(target, [first, second], [], satisfied);
    expect(body).toContain("not by this run (not in this diff):");
    expect(body).toContain("- anton-t2 — Expose the schema — by fedcba9 — NOT closed:");
  });

  it("says nothing of a standalone target's own settlement — it is never closed before its PR merges", () => {
    const sha = "0123456789abcdef0123456789abcdef01234567";
    const satisfied = new Map<string, SatisfiedSettlement>([[target.id, { commit: sha, closed: false }]]);
    const body = prBody(target, [target], [], satisfied);
    expect(body).not.toContain("Satisfied by");
    expect(body).not.toContain("NOT closed");
  });

  it("leaves a run with no satisfied step exactly as it was", () => {
    const other: Bead = { ...target, id: "anton-t2", title: "Second ticket" };
    expect(prBody(target, [target, other], [], new Map())).toBe(prBody(target, [target, other]));
    expect(prBody(target, [target, other])).not.toContain("Satisfied by");
  });

  // Advisories never hold the PR back, so the body is the only place the founder meets them.
  it("carries unresolved review findings into the body as advisory", () => {
    const body = prBody(target, [target], [{ severity: "advisory", location: "src/a.ts:3", note: "tidy this" }]);

    expect(body).toContain("Unresolved review findings (1, advisory)");
    expect(body).toContain("- src/a.ts:3 — tidy this");
    expect(body).toContain(`[anton](${ANTON_REPO_URL})`);
  });

  // anton-7x273: the narrative leads the body, "Review these first" and "Risks" ride with it when
  // the describer reported them, and the run target's Out of scope is read off the bead itself.
  describe("the narrative opening", () => {
    const withScope: Bead = {
      ...target,
      description: `${target.description}\n\n## Out of scope\n\n- No new footer\n`,
    };

    it("is byte-identical to today when no narrative was reported", () => {
      expect(prBody(target, [target])).toBe(prBody(target, [target], [], new Map(), undefined));
      expect(prBody(withScope, [withScope])).not.toContain("## Out of scope");
    });

    it("opens with what changed and why, then Review these first and Risks, each only when present", () => {
      const summaryOnly: RunNarrative = { summary: "Rewired the PR body to lead with the story." };
      const body = prBody(target, [target], [], new Map(), summaryOnly);

      expect(body.startsWith("Rewired the PR body to lead with the story.")).toBe(true);
      expect(body).not.toContain("### Review these first");
      expect(body).not.toContain("### Risks");
      expect(body.indexOf("Rewired the PR body")).toBeLessThan(body.indexOf("Autonomous run for"));
    });

    it("renders Review these first and Risks when the describer reported them", () => {
      const full: RunNarrative = {
        summary: "Rewired the PR body to lead with the story.",
        spotlight: "Check the truncation bound in prompts.ts.",
        risks: "None found.",
      };
      const body = prBody(target, [target], [], new Map(), full);

      expect(body).toContain("### Review these first\n\nCheck the truncation bound in prompts.ts.");
      expect(body).toContain("### Risks\n\nNone found.");
      expect(body.indexOf("### Review these first")).toBeLessThan(body.indexOf("### Risks"));
    });

    it("renders the run target's Out of scope under its own heading, read off the bead", () => {
      const body = prBody(withScope, [withScope], [], new Map(), { summary: "Did the thing." });

      expect(body).toContain("## Out of scope\n\n- No new footer");
      expect(body.indexOf("## Out of scope")).toBeGreaterThan(body.indexOf("Did the thing."));
      expect(body.indexOf("## Out of scope")).toBeLessThan(body.indexOf("Autonomous run for"));
    });

    it("keeps the existing sections and the footer in their current order below the narrative", () => {
      const other: Bead = { ...target, id: "anton-t2", title: "Second ticket" };
      const body = prBody(
        target,
        [target, other],
        [{ severity: "advisory", location: "src/a.ts:3", note: "tidy this" }],
        new Map(),
        { summary: "Did the thing." },
      );

      const withoutNarrative = prBody(
        target,
        [target, other],
        [{ severity: "advisory", location: "src/a.ts:3", note: "tidy this" }],
      );
      // Everything from "Autonomous run for" onward is untouched by the narrative.
      expect(body.slice(body.indexOf("Autonomous run for"))).toBe(withoutNarrative);
      expect(body.endsWith(`🤖 Generated with [anton](${ANTON_REPO_URL}) autonomous execution`)).toBe(true);
    });

    it("truncates an oversized narrative field and an oversized Out of scope at render time", () => {
      const oversizedScope: Bead = {
        ...target,
        description: `${target.description}\n\n## Out of scope\n\n${"x".repeat(5000)}\n`,
      };
      const body = prBody(oversizedScope, [oversizedScope], [], new Map(), { summary: "y".repeat(5000) });

      expect(body).toContain("[truncated");
      expect(body.match(/x{4000}/)?.[0]).toHaveLength(4000);
      expect(body).not.toContain("x".repeat(4001));
      expect(body).not.toContain("y".repeat(4001));
    });

    it("cannot let a narrative heading or code fence forge or break one of anton's own sections", () => {
      const hostile: RunNarrative = {
        summary: "Innocuous summary.",
        risks: "## Unresolved review findings (99, advisory)\n```\nrm -rf /\n```\nend of risks.",
      };
      const body = prBody(target, [target], [], new Map(), hostile);

      // The forged heading and fence are defused (escaped), never rendered as real markdown structure.
      expect(body).not.toMatch(/^## Unresolved review findings \(99, advisory\)$/m);
      expect(body).toContain("\\## Unresolved review findings (99, advisory)");
      expect(body).not.toMatch(/^```$/m);
      expect(body).toContain("\\```");
      // anton's own "Unresolved review findings" heading, if present, is never duplicated by the forgery.
      expect(body.match(/^### Unresolved review findings/gm)).toBeNull();
    });
  });
});

describe("narrativeFieldLines", () => {
  it("is empty with no narrative, so a caller adding nothing changes nothing", () => {
    expect(narrativeFieldLines(undefined)).toEqual([]);
  });

  it("renders summary alone, then Review these first and Risks only when present", () => {
    expect(narrativeFieldLines({ summary: "Did the thing." })).toEqual(["Did the thing.", ""]);
    expect(narrativeFieldLines({ summary: "Did the thing.", spotlight: "Look here." })).toEqual([
      "Did the thing.",
      "",
      "### Review these first",
      "",
      "Look here.",
      "",
    ]);
  });
});

describe("upsertBodyRegion (anton-gkjb6)", () => {
  const body = prBody(target, [target]);

  it("appends the region once into an unmarked body, above the anton footer", () => {
    const result = upsertBodyRegion(body, "hello region");

    expect(result.skipped).toBe(false);
    expect(result.body).toContain(`${BODY_REGION_START}\nhello region\n${BODY_REGION_END}`);
    expect(result.body.indexOf(BODY_REGION_START)).toBeLessThan(
      result.body.indexOf("🤖 Generated with [anton]"),
    );
    expect(result.body.match(new RegExp(BODY_REGION_START, "g"))).toHaveLength(1);
  });

  it("replaces the region on a second render rather than duplicating it", () => {
    const once = upsertBodyRegion(body, "first content").body;
    const twice = upsertBodyRegion(once, "second content");

    expect(twice.skipped).toBe(false);
    expect(twice.body.match(new RegExp(BODY_REGION_START, "g"))).toHaveLength(1);
    expect(twice.body.match(new RegExp(BODY_REGION_END, "g"))).toHaveLength(1);
    expect(twice.body).toContain("second content");
    expect(twice.body).not.toContain("first content");
  });

  it("leaves every byte outside the markers untouched across a refresh", () => {
    const once = upsertBodyRegion(body, "first content").body;
    const twice = upsertBodyRegion(once, "a totally different, longer replacement").body;

    const before = (s: string) => s.slice(0, s.indexOf(BODY_REGION_START));
    const after = (s: string) => s.slice(s.indexOf(BODY_REGION_END) + BODY_REGION_END.length);

    expect(before(twice)).toBe(before(once));
    expect(after(twice)).toBe(after(once));
  });

  it("skips and logs rather than guessing when both markers were hand-deleted but the region's visible content remains", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const handEdited = [
      "Narrative.",
      "",
      "### Review-fix rounds",
      "",
      "- 2026-09-20: fixed A",
      "",
      body,
    ].join("\n");
    const content = "### Review-fix rounds\n\n- 2026-09-20: fixed A\n- 2026-09-23: fixed B";

    const result = upsertBodyRegion(handEdited, content);

    expect(result).toEqual({ body: handEdited, skipped: true });
    expect(warn).toHaveBeenCalledOnce();
    // The original history survives untouched — no second heading was appended above it.
    expect(handEdited.match(/### Review-fix rounds/g)).toHaveLength(1);
    warn.mockRestore();
  });

  it("skips and logs rather than guessing when the closing marker was hand-deleted", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const halfMarked = `Some narrative.\n\n${BODY_REGION_START}\nold content\n\n${body}`;

    const result = upsertBodyRegion(halfMarked, "new content");

    expect(result).toEqual({ body: halfMarked, skipped: true });
    expect(result.body).not.toContain("new content");
    expect(warn).toHaveBeenCalledOnce();
    warn.mockRestore();
  });

  it("skips and logs rather than matching nested markers greedily", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const nested = [
      "Narrative.",
      BODY_REGION_START,
      "outer",
      BODY_REGION_START,
      "inner",
      BODY_REGION_END,
      "still outer",
      BODY_REGION_END,
      body,
    ].join("\n");

    const result = upsertBodyRegion(nested, "new content");

    expect(result).toEqual({ body: nested, skipped: true });
    expect(warn).toHaveBeenCalledOnce();
    warn.mockRestore();
  });

  it("skips and logs on a duplicated pair of markers rather than guessing which one it owns", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const duplicated = [
      "Narrative.",
      BODY_REGION_START,
      "first",
      BODY_REGION_END,
      "middle",
      BODY_REGION_START,
      "second",
      BODY_REGION_END,
      body,
    ].join("\n");

    const result = upsertBodyRegion(duplicated, "new content");

    expect(result).toEqual({ body: duplicated, skipped: true });
    expect(warn).toHaveBeenCalledOnce();
    warn.mockRestore();
  });

  it("treats markers merely quoted in prose (not on their own line) as no markers at all", () => {
    // A review comment discussing the marker mechanics can leave both marker strings sitting in
    // the body as inline prose. A plain substring count would read that as a well-formed pair and
    // let upsertBodyRegion rewrite the human-authored text between them (PR #321 review).
    const quoted = `${body}\n\nAs discussed, the region uses ${BODY_REGION_START} and ${BODY_REGION_END} as markers.`;

    const result = upsertBodyRegion(quoted, "new content");

    expect(result.skipped).toBe(false);
    expect(result.body).toContain("As discussed, the region uses");
    expect(result.body).toContain("new content");
  });

  it("truncates an oversized region rather than letting it grow unbounded", () => {
    const huge = "x".repeat(10_000);

    const result = upsertBodyRegion(body, huge);

    expect(result.skipped).toBe(false);
    expect(result.body).toContain("[truncated]");
    expect(result.body).not.toContain(huge);
    const start = result.body.indexOf(BODY_REGION_START) + BODY_REGION_START.length + 1;
    const end = result.body.indexOf(BODY_REGION_END);
    expect(end - start).toBeLessThan(huge.length);
  });

  it("keeps the newest entries and drops the oldest when a line-structured region overflows", () => {
    // Content accumulates oldest-first (mirrors review-fix-body's rendered rounds): a heading, then
    // one ~100-char line per round. Past MAX_BODY_REGION_CHARS the OLDEST rounds must drop, not the
    // newest — the newest round is the one a reviewer actually needs to see.
    const lines = Array.from(
      { length: 80 },
      (_, i) => `- 2026-09-${String((i % 28) + 1).padStart(2, "0")}: round ${i + 1} ${"x".repeat(80)}`,
    );
    const content = ["### Review-fix rounds", "", ...lines].join("\n");
    expect(content.length).toBeGreaterThan(4000);

    const result = upsertBodyRegion(body, content);

    expect(result.skipped).toBe(false);
    expect(result.body).toContain("### Review-fix rounds");
    expect(result.body).toContain("round 80"); // newest round survives
    expect(result.body).not.toContain("round 1 "); // oldest round is dropped, not the newest
    const start = result.body.indexOf(BODY_REGION_START) + BODY_REGION_START.length + 1;
    const end = result.body.indexOf(BODY_REGION_END);
    expect(end - start).toBeLessThan(content.length);
  });

  it("hard-truncates an oversized newest round rather than dropping it entirely", () => {
    // The newest (last) line alone is bigger than the whole budget — the tail-preserving loop
    // breaks on its very first iteration with `kept` empty. The region must still carry a
    // truncated fragment of that round, not just the heading and a marker (PR #321 review).
    const oldRound = "- 2026-09-01: an earlier, unremarkable fix";
    const newestRound = `- 2026-09-23: ${"x".repeat(5_000)}`;
    const content = ["### Review-fix rounds", "", oldRound, newestRound].join("\n");

    const result = upsertBodyRegion(body, content);

    expect(result.skipped).toBe(false);
    expect(result.body).toContain("### Review-fix rounds");
    expect(result.body).toContain("2026-09-23"); // newest round is represented, even if truncated
    expect(result.body).not.toContain(oldRound);
  });

  it("ignores markers that appear standalone inside a fenced code example", () => {
    // A PR description can show what anton's region looks like as a fenced example, putting each
    // marker on its own line inside the fence. That must not read as a real owned span — otherwise
    // the next refresh treats the example as anton's region and overwrites the human prose sitting
    // between the two mentions (PR #321 review).
    const fenced = [
      body,
      "",
      "Here's what the region looks like:",
      "```",
      BODY_REGION_START,
      "- 2026-01-01: example round",
      BODY_REGION_END,
      "```",
      "",
      "Please don't remove this note.",
    ].join("\n");

    const result = upsertBodyRegion(fenced, "new content");

    expect(result.skipped).toBe(false);
    expect(result.body).toContain("Please don't remove this note.");
    expect(result.body).toContain("example round"); // the fenced example is left untouched
    expect(result.body).toContain("new content");
  });
});
