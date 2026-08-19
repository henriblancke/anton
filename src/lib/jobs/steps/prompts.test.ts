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

  // Advisories never hold the PR back, so the body is the only place the founder meets them.
  it("carries unresolved review findings into the body as advisory", () => {
    const body = prBody(target, [target], [{ severity: "advisory", location: "src/a.ts:3", note: "tidy this" }]);

    expect(body).toContain("Unresolved review findings (1, advisory)");
    expect(body).toContain("- src/a.ts:3 — tidy this");
    expect(body).toContain(`[anton](${ANTON_REPO_URL})`);
  });
});
