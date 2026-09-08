/**
 * Direct tests for prompt construction: what a ticket's task text inlines, what it leaves out, and
 * what the PR body says.
 *
 * The spec is inlined so an agent can implement with an unreadable in-worktree beads DB (issue #46
 * root cause #3) — so "the section is present" is the assertion that matters, per section.
 */
import { describe, expect, it } from "vitest";

import type { Bead } from "../../beads/bd";
import { ANTON_REPO_URL } from "../../repo";
import type { SatisfiedSettlement } from "./context";
import { prBody, stepTaskBlock, ticketPrompt, truncateField } from "./prompts";
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
});
