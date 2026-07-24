/**
 * Unit tests for the active-agents allowlist enforcement (anton-dm7): which tickets dispatch
 * must refuse to run. The park behavior itself (PoisonEpic → run failed + job parked) is
 * exercised end-to-end in execute-epic.integration.test.ts.
 */
import { describe, expect, it } from "vitest";
import type { Bead } from "../beads/bd";
import { formatHumanNote } from "../beads/notes";
import {
  claudeResumeDecision,
  continuationPrompt,
  inactiveAgentTickets,
  ticketPrompt,
} from "./execute-epic";

function ticket(id: string, labels?: string[]): Bead {
  return { id, title: id, status: "open", labels } as Bead;
}

describe("inactiveAgentTickets", () => {
  it("flags a ticket whose agent: label is not in a non-empty allowlist", () => {
    const out = inactiveAgentTickets(
      [ticket("t-1", ["agent:terraform", "domain:eng"])],
      ["fastapi", "nextjs"],
    );
    expect(out).toEqual([{ id: "t-1", agent: "terraform" }]);
  });

  it("passes tickets with an enabled agent or with no agent: label", () => {
    const out = inactiveAgentTickets(
      [ticket("t-1", ["agent:nextjs"]), ticket("t-2", ["domain:eng"]), ticket("t-3")],
      ["nextjs"],
    );
    expect(out).toEqual([]);
  });

  it("treats an absent allowlist as all agents active", () => {
    expect(inactiveAgentTickets([ticket("t-1", ["agent:kubernetes"])], undefined)).toEqual([]);
  });

  it("treats an EMPTY allowlist as no BUNDLED agent active — parks bundled, not user agents", () => {
    // The operator toggled every bundled agent off; the API persists [] as a real "no agents"
    // value distinct from clearing (undefined), so dispatch must honor it for bundled agents. A
    // user agent (`my-custom` in userAgentIds) still runs; only unlabeled tickets otherwise pass.
    expect(
      inactiveAgentTickets(
        [ticket("t-1", ["agent:kubernetes"]), ticket("t-2", ["agent:my-custom"]), ticket("t-3")],
        [],
        ["my-custom"],
      ),
    ).toEqual([{ id: "t-1", agent: "kubernetes" }]);
  });

  it("never gates the project's own user agents, whatever the allowlist (anton-dvo.1 reversal)", () => {
    // `my-custom` is a `.claude/agents` agent (in userAgentIds) — it always runs, even when the
    // allowlist omits it and only lists a bundled agent.
    expect(
      inactiveAgentTickets([ticket("t-1", ["agent:my-custom"])], ["fastapi"], ["my-custom"]),
    ).toEqual([]);
    expect(
      inactiveAgentTickets([ticket("t-1", ["agent:my-custom"])], [], ["my-custom"]),
    ).toEqual([]);
  });

  it("still parks a disabled bundled agent or an unknown tag not among the user agents", () => {
    // The safety net stands: an `agent:` tag that is neither active nor a known user agent — a
    // disabled bundled specialist, or a typo resolving nowhere — is parked.
    expect(
      inactiveAgentTickets(
        [ticket("t-1", ["agent:terraform"]), ticket("t-2", ["agent:typoo"])],
        ["fastapi"],
        ["my-custom"],
      ),
    ).toEqual([
      { id: "t-1", agent: "terraform" },
      { id: "t-2", agent: "typoo" },
    ]);
  });

  it("reports every offending ticket, not just the first", () => {
    const out = inactiveAgentTickets(
      [ticket("t-1", ["agent:docker"]), ticket("t-2", ["agent:alembic"]), ticket("t-3", ["agent:fastapi"])],
      ["fastapi"],
    );
    expect(out).toEqual([
      { id: "t-1", agent: "docker" },
      { id: "t-2", agent: "alembic" },
    ]);
  });
});

describe("ticketPrompt", () => {
  it("inlines the full spec (description/acceptance/context) so it survives a dead in-worktree bd", () => {
    const p = ticketPrompt({
      id: "t-1",
      title: "Do the thing",
      status: "open",
      description: "## Goal\nMake it work.",
      acceptance_criteria: "- [ ] it works",
      context: "touches src/foo.ts",
    } as Bead);
    // Spec is carried in the prompt itself, not fetched via bd — the whole point of the ticket.
    expect(p).toContain("t-1 — Do the thing");
    expect(p).toContain("Make it work.");
    expect(p).toContain("- [ ] it works");
    expect(p).toContain("touches src/foo.ts");
  });

  it("frames an empty spec + failing bd as fail-loud/blocked, never a silent bailout", () => {
    const p = ticketPrompt({ id: "t-1", title: "Bare", status: "open" } as Bead);
    expect(p).toContain("(none stated)");
    expect(p).toMatch(/report the ticket as blocked/);
    expect(p).toMatch(/not guess or silently bail/);
  });

  it("prefers acceptance_criteria but falls back to the legacy acceptance field", () => {
    const p = ticketPrompt({
      id: "t-1",
      title: "T",
      status: "open",
      acceptance: "- [ ] legacy criterion",
    } as Bead);
    expect(p).toContain("- [ ] legacy criterion");
  });

  it("does not repeat Context when it is already folded into the description markdown", () => {
    const body = "## Goal\nG\n\n## Context\ntouches src/foo.ts";
    const p = ticketPrompt({
      id: "t-1",
      title: "T",
      status: "open",
      description: body,
      context: body,
    } as Bead);
    // The standalone context block is skipped, so the folded body appears exactly once — not
    // duplicated once from `description` and again from the separate `context` column.
    expect(p.match(/touches src\/foo\.ts/g) ?? []).toHaveLength(1);
  });

  it("truncates an oversized body so it cannot bloat the prompt", () => {
    const huge = "x".repeat(10_000);
    const p = ticketPrompt({
      id: "t-1",
      title: "T",
      status: "open",
      description: huge,
      acceptance_criteria: "- [ ] ok",
    } as Bead);
    expect(p).toContain("[truncated");
    expect(p).not.toContain(huge);
  });

  it("carries the operator's human notes as binding steering, after the contract (anton-bfy4)", () => {
    const p = ticketPrompt({
      id: "t-1",
      title: "T",
      status: "open",
      acceptance_criteria: "- [ ] it works",
      notes: [
        "anton: run failed after committing work — needs review",
        formatHumanNote("reuse the existing helper", "Henri Blancke", new Date(0)),
      ].join("\n"),
    } as Bead);
    expect(p).toContain("## Human notes on this ticket");
    expect(p).toContain("reuse the existing helper");
    expect(p).toContain("Henri Blancke");
    // The steer must land after the acceptance criteria it refines, and anton's own machine notes
    // stay out — they narrate past failures, not the human's intent.
    expect(p.indexOf("Human notes")).toBeGreaterThan(p.indexOf("- [ ] it works"));
    expect(p).not.toContain("run failed after committing work");
  });

  it("adds no notes section when the bead has none", () => {
    const p = ticketPrompt({ id: "t-1", title: "T", status: "open" } as Bead);
    expect(p).not.toContain("Human notes");
  });
});

describe("continuationPrompt (anton-juar)", () => {
  it("is a brief continuation that does not re-inline the full ticket spec", () => {
    const t = {
      id: "t-1",
      title: "Do X",
      description: "## Goal\nThe whole detailed spec body",
      acceptance_criteria: "- [ ] everything",
    } as Bead;
    const p = continuationPrompt(t);
    expect(p).toContain("t-1");
    expect(p).toContain("resumed");
    expect(p).toContain("do NOT");
    // The resumed session already holds the spec, so it must not be re-inlined.
    expect(p).not.toContain("The whole detailed spec body");
  });

  it("injects the prior error ONLY when it may be agent-caused (oversized output/context)", () => {
    const t = { id: "t-1", title: "Do X", status: "open" } as Bead;
    const agentCaused = continuationPrompt(t, "API Error: prompt is too long: 250000 tokens > 200000");
    expect(agentCaused).toContain("prompt is too long");
    expect(agentCaused).toContain("adjust your approach");
  });

  it("does NOT inject a pure-infra error the agent can't act on", () => {
    const t = { id: "t-1", title: "Do X", status: "open" } as Bead;
    const infra = continuationPrompt(t, "claude exited with code 1: Connection closed mid-response");
    expect(infra).not.toContain("Connection closed mid-response");
    expect(infra).not.toContain("adjust your approach");
  });
});

describe("claudeResumeDecision (anton-juar)", () => {
  it("escalates immediately when a resumed session repeats the same failure signature", () => {
    expect(
      claudeResumeDecision(
        { sessionId: "sess-1", signature: "connection-closed" },
        1,
        "connection-closed",
      ),
    ).toEqual({ resume: false, reason: "repeated connection-closed" });
  });

  it("allows two distinct resume attempts, then escalates when the budget is exhausted", () => {
    expect(
      claudeResumeDecision({ sessionId: "sess-1", signature: "connection-closed" }, 0),
    ).toEqual({ resume: true });
    expect(
      claudeResumeDecision(
        { sessionId: "sess-1", signature: "service-unavailable" },
        1,
        "connection-closed",
      ),
    ).toEqual({ resume: true });
    expect(
      claudeResumeDecision(
        { sessionId: "sess-1", signature: "gateway-time-out" },
        2,
        "service-unavailable",
      ),
    ).toEqual({ resume: false, reason: "resume budget spent" });
  });
});
