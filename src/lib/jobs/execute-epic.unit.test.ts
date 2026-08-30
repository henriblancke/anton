/**
 * Unit tests for the active-agents allowlist enforcement (anton-dm7): which tickets dispatch
 * must refuse to run. The park behavior itself (PoisonEpic → run failed + job parked) is
 * exercised end-to-end in execute-epic.integration.test.ts.
 */
import { describe, expect, it } from "vitest";
import type { Bead, BeadDep, Gate } from "../beads/bd";
import { formatHumanNote, parseTicketNotes } from "../beads/notes";
import { blockedTailReason, poisonBlockerIds, PoisonEpic } from "./errors";
import {
  claudeResumeDecision,
  continuationPrompt,
  inactiveAgentTickets,
  mergeGatePlan,
  orderTickets,
  reviewParkMessage,
  runReadiness,
  runTargetDrift,
  skipNote,
  skippedDependents,
  splitFormulaPhases,
  ticketBlockNote,
  ticketSetDrift,
} from "./execute-epic";
import { runTickets } from "../ticket-view";
import { BUILTIN_STEPS, ticketPrompt } from "./step-registry";
import type { ResolvedStep } from "./run-formula";

function ticket(id: string, labels?: string[]): Bead {
  return { id, title: id, status: "open", labels } as Bead;
}

/** A resolved pipeline addressed the way a formula does: one `step:<name>` per step. */
function pipeline(...names: string[]): { source: string; steps: ResolvedStep[] } {
  return {
    source: "/repo/.beads/formulas/anton-run.formula.toml",
    steps: names.map((name) => ({
      step: { id: name, labels: [`step:${name}`] },
      definition: BUILTIN_STEPS[name],
    })),
  };
}

describe("splitFormulaPhases — where a ticket's work ends and the run's begins (anton-lnkt)", () => {
  const names = (steps: ResolvedStep[]) => steps.map((s) => s.definition.name);

  it("splits the shipped pipeline at its commit: per-ticket work, then the run's own steps", () => {
    const { ticketSteps, runSteps } = splitFormulaPhases(
      pipeline("implement", "verify", "commit", "review", "pr"),
    );
    expect(names(ticketSteps)).toEqual(["implement", "verify", "commit"]);
    expect(names(runSteps)).toEqual(["review", "pr"]);
  });

  it("moves the boundary when the project moves the step — reorder is the whole point", () => {
    // Verify gates after the commit: one run-wide verification instead of one per ticket, with no
    // anton code change.
    const { ticketSteps, runSteps } = splitFormulaPhases(
      pipeline("implement", "commit", "verify", "pr"),
    );
    expect(names(ticketSteps)).toEqual(["implement", "commit"]);
    expect(names(runSteps)).toEqual(["verify", "pr"]);
  });

  it("fails loud on a pipeline with no commit — a run with no evidence of record", () => {
    expect(() => splitFormulaPhases(pipeline("implement", "pr"))).toThrow(PoisonEpic);
    expect(() => splitFormulaPhases(pipeline("implement", "pr"))).toThrow(/no `step:commit`/);
  });
});

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

/**
 * anton-1two: the run gate is per TICKET, not per target. A target whose tail child waits on
 * another run must still run the children nothing holds — the all-or-nothing verdict is what
 * stalled a whole feature over one edge (issue #58) — while never dispatching the held one.
 */
describe("runReadiness — what a partially-gated run may start (anton-1two)", () => {
  const feature = (id: string, extra: Partial<Bead> = {}): Bead =>
    ({ id, title: id, status: "open", issue_type: "feature", ...extra }) as Bead;
  const child = (id: string, parent: string, extra: Partial<Bead> = {}): Bead =>
    ({ id, title: id, status: "open", issue_type: "task", parent, ...extra }) as Bead;
  const standaloneTask = (id: string, extra: Partial<Bead> = {}): Bead =>
    ({ id, title: id, status: "open", issue_type: "task", ...extra }) as Bead;
  const blocks = (from: string, to: string): BeadDep => ({
    issue_id: from,
    depends_on_id: to,
    type: "blocks",
  });

  /** F1 owns t-1 (independent) and t-2 (blocked by a ticket in the OTHER feature). */
  const partiallyGated = (): Bead[] => [
    feature("F1"),
    feature("F2"),
    child("t-1", "F1"),
    child("t-2", "F1", { dependencies: [blocks("t-2", "t-9")] }),
    child("t-9", "F2"),
  ];

  it("runs the independent children and holds only the cross-run-gated one", () => {
    const r = runReadiness(partiallyGated(), "F1", true);
    expect(r.runnable).toBe(true);
    expect(r.gated).toEqual(["t-2"]);
    // The blockers still name the UNIT that ships the blocking work, for the park reason.
    expect(r.blockers).toEqual(["F2"]);
  });

  it("holds a child queued behind a gated sibling — inside-the-run ordering propagates", () => {
    const board = [...partiallyGated(), child("t-3", "F1", { dependencies: [blocks("t-3", "t-2")] })];
    const r = runReadiness(board, "F1", true);
    expect(r.runnable).toBe(true);
    expect(r.gated.sort()).toEqual(["t-2", "t-3"]);
  });

  it("holds a child gated cross-run even when its OTHER blocker is work this run does", () => {
    // The premise of the held-tail/timeout overlap (anton-67xj): t-2 waits on t-9 in another feature
    // AND on its own sibling t-1, so it lands in the HELD set and never enters the dispatch loop —
    // which is why a timeout on t-1 has to be reconciled against the held tail, not just the loop.
    const board = [
      feature("F1"),
      feature("F2"),
      child("t-1", "F1"),
      child("t-2", "F1", { dependencies: [blocks("t-2", "t-9"), blocks("t-2", "t-1")] }),
      child("t-9", "F2"),
    ];
    const r = runReadiness(board, "F1", true);
    expect(r.runnable).toBe(true);
    expect(r.gated).toEqual(["t-2"]);
  });

  it("refuses the run only when NO child can start", () => {
    const board = [
      feature("F1"),
      feature("F2"),
      child("t-1", "F1", { dependencies: [blocks("t-1", "t-9")] }),
      child("t-2", "F1", { dependencies: [blocks("t-2", "t-9")] }),
      child("t-9", "F2"),
    ];
    const r = runReadiness(board, "F1", true);
    expect(r.runnable).toBe(false);
    expect(r.gated.sort()).toEqual(["t-1", "t-2"]);
  });

  it("holds nothing once the blocker's run target is done", () => {
    const board = [
      feature("F1"),
      feature("F2", { status: "closed" }),
      child("t-1", "F1"),
      child("t-2", "F1", { dependencies: [blocks("t-2", "t-9")] }),
      child("t-9", "F2", { status: "closed" }),
    ];
    const r = runReadiness(board, "F1", true);
    expect(r).toEqual({ blockers: [], gated: [], runnable: true });
  });

  it("keeps a standalone target all-or-nothing — it IS its own single ticket", () => {
    const blocked = [
      standaloneTask("s-1", { dependencies: [blocks("s-1", "s-2")] }),
      standaloneTask("s-2"),
    ];
    expect(runReadiness(blocked, "s-1", false)).toEqual({
      blockers: ["s-2"],
      gated: ["s-1"],
      runnable: false,
    });
    expect(runReadiness([standaloneTask("s-1")], "s-1", false)).toEqual({
      blockers: [],
      gated: [],
      runnable: true,
    });
  });

  it("lets a run whose tickets are all closed proceed — an empty set is not a blocked one", () => {
    // The closed-PR recovery shape: nothing left to dispatch, only the agent-free PR step. Reading
    // "no ready children" as blocked there would park a run that has nothing to wait for.
    const board = [feature("F1"), child("t-1", "F1", { status: "closed" })];
    expect(runReadiness(board, "F1", true).runnable).toBe(true);
  });
});

describe("blockedTailReason — the park a held tail leaves behind (anton-1two)", () => {
  const reason = blockedTailReason("F1", {
    blockers: ["F2", "F3"],
    held: ["t-2"],
    ran: ["t-1"],
  });

  it("stays readable by the run-health parser, so a partial park reports its blockers too", () => {
    expect(poisonBlockerIds(reason)).toEqual(["F2", "F3"]);
  });

  it("names what ran, what is held, and that no PR opens yet", () => {
    expect(reason).toContain("t-2");
    expect(reason).toContain("t-1");
    expect(reason).toMatch(/no pull request opens/);
    expect(reason).toMatch(/Resume the run once the blocker\(s\) complete/);
  });

  it("says nothing about committed work when the run had none to do", () => {
    const nothingRan = blockedTailReason("F1", { blockers: ["F2"], held: ["t-2"], ran: [] });
    expect(nothingRan).not.toMatch(/commits are on the branch/);
    expect(poisonBlockerIds(nothingRan)).toEqual(["F2"]);
  });
});

describe("ticketSetDrift — the selection-to-lease window (anton-e42l)", () => {
  // A run picks its tickets before it publishes the lease that makes it visible, so for that window
  // the target reads as free to an approved gardener re-parent. The newcomer is never dispatched and
  // merge finalization closes it unrun — so the run re-confirms its set once the lease is live, and
  // a set that moved has to retry rather than run the stale half of the race.
  it("names a ticket attached to the target while the run was starting", () => {
    expect(ticketSetDrift([ticket("t-1")], [ticket("t-1"), ticket("t-2")])).toBe("attached t-2");
  });

  it("names one pulled out of the target too — the same race, the other direction", () => {
    expect(ticketSetDrift([ticket("t-1"), ticket("t-2")], [ticket("t-1")])).toBe("detached t-2");
  });

  it("reports both sides when a re-parent swapped one for another", () => {
    expect(ticketSetDrift([ticket("t-1")], [ticket("t-2")])).toBe("attached t-2; detached t-1");
  });

  it("catches a standalone target that gained its first child — the shape changed too", () => {
    expect(ticketSetDrift([], [ticket("t-1")])).toBe("attached t-1");
  });

  // runTickets filters on shape, not state, so a ticket another machine merely closed is in both
  // sets. Tripping on it would retry every run that races an ordinary cross-machine close.
  it("does not trip on a ticket whose STATE changed, or on ordering", () => {
    const closed = { ...ticket("t-2"), status: "closed" } as Bead;
    expect(ticketSetDrift([ticket("t-1"), ticket("t-2")], [closed, ticket("t-1")])).toBeUndefined();
  });
});

describe("runTargetDrift — the target's own shape in that same window (anton-e42l)", () => {
  const bead = (id: string, extra: Partial<Bead> = {}): Bead =>
    ({ id, title: id, status: "open", issue_type: "task", ...extra }) as Bead;

  // The case ticketSetDrift structurally cannot see: a parentless task has no tickets before OR
  // after the move, so the set check stays silent while the bead itself became someone else's
  // ticket — and this run would execute it alongside the run that now owns it.
  it("catches a parentless task re-parented under another card mid-startup", () => {
    const board = [bead("t-1", { parent: "epic-1" }), bead("epic-1", { issue_type: "epic" })];
    expect(ticketSetDrift([], runTickets(board, "t-1"))).toBeUndefined();
    expect(runTargetDrift("t-1", board)).toBe("it now hangs under epic-1, whose run owns it as a ticket");
  });

  it("catches a legacy epic that gained a feature child — a container is nobody's run", () => {
    const board = [
      bead("epic-1", { issue_type: "epic" }),
      bead("f-1", { issue_type: "feature", parent: "epic-1" }),
    ];
    expect(runTargetDrift("epic-1", board)).toMatch(/container epic/);
  });

  it("catches a target re-typed into something anton never runs on its own", () => {
    expect(runTargetDrift("c-1", [bead("c-1", { issue_type: "chore" })])).toBe(
      'its type is now "chore", which anton never runs on its own',
    );
  });

  it("catches a target that left the board entirely", () => {
    expect(runTargetDrift("t-1", [bead("other")])).toBe("it is no longer on the board");
  });

  it("stays silent for a target that is still a run target", () => {
    const board = [bead("f-1", { issue_type: "feature" }), bead("t-1", { parent: "f-1" })];
    expect(runTargetDrift("f-1", board)).toBeUndefined();
    expect(runTargetDrift("t-1", board)).toBe("it now hangs under f-1, whose run owns it as a ticket");
  });
});

describe("orderTickets / skippedDependents — the run's own dependency graph (anton-67xj)", () => {
  const dep = (from: string, to: string): BeadDep => ({
    issue_id: from,
    depends_on_id: to,
    type: "blocks",
  });
  /** `c` depends on `b`, `b` depends on `a`; `d` is independent of all three. */
  const chain = (): Bead[] => [
    ticket("a"),
    { ...ticket("b"), dependencies: [dep("b", "a")] } as Bead,
    { ...ticket("c"), dependencies: [dep("c", "b")] } as Bead,
    ticket("d"),
  ];
  const ids = (beads: Bead[]) => beads.map((b) => b.id);
  /** A ticket the budget stopped BEFORE its commit — the only kind whose skip cascades. */
  const rolledBack = (...tickets: string[]) => tickets.map((id) => ({ id, committed: false }));

  it("dispatches a chain blocker-first, whatever order the board hands it back in", () => {
    const board = chain();
    const shuffled = [board[2], board[3], board[1], board[0]];
    expect(ids(orderTickets(shuffled, board))).toEqual(["d", "a", "b", "c"]);
  });

  it("skips the whole chain behind a timed-out ticket, transitively", () => {
    const board = chain();
    const cause = skippedDependents(rolledBack("a"), board, board);
    expect([...cause.keys()].sort()).toEqual(["b", "c"]);
    // The direct dependent names `a`; the transitive one names the sibling it queued behind — and
    // both name the ticket a human has to act on.
    expect(cause.get("b")).toEqual({ waitingOn: "a", stopped: "a" });
    expect(cause.get("c")).toEqual({ waitingOn: "b", stopped: "a" });
  });

  it("leaves a ticket with no edge to the timed-out one alone — the run narrows, it does not halt", () => {
    const board = chain();
    expect(skippedDependents(rolledBack("a"), board, board).has("d")).toBe(false);
    // …and a timeout further down the chain takes only what is actually behind it.
    expect([...skippedDependents(rolledBack("b"), board, board).keys()]).toEqual(["c"]);
  });

  it("ignores `blocks` edges that leave the run, and non-blocking edges inside it", () => {
    const outside = [
      ticket("a"),
      { ...ticket("b"), dependencies: [dep("b", "x-9")] } as Bead,
      { ...ticket("c"), dependencies: [{ ...dep("c", "a"), type: "related" }] } as Bead,
    ];
    expect(skippedDependents(rolledBack("a"), outside, outside).size).toBe(0);
  });

  it("terminates on a cycle instead of walking it forever", () => {
    const cyclic = [
      { ...ticket("a"), dependencies: [dep("a", "c")] } as Bead,
      { ...ticket("b"), dependencies: [dep("b", "a")] } as Bead,
      { ...ticket("c"), dependencies: [dep("c", "b")] } as Bead,
    ];
    const cause = skippedDependents(rolledBack("a"), cyclic, cyclic);
    expect([...cause.keys()].sort()).toEqual(["b", "c"]);
    // orderTickets can't topologically sort a cycle either — it hands back the input order.
    expect(ids(orderTickets(cyclic, cyclic))).toEqual(["a", "b", "c"]);
  });

  it("does NOT cascade a timeout that landed after the ticket committed", () => {
    const board = chain();
    // The deadline hit the bookkeeping, not the code: `a`'s work is on the branch, so everything
    // written against it still has what it needs and must still run. Deleting the committed-ness
    // check turns this into the whole chain being skipped for work that actually shipped.
    expect(skippedDependents([{ id: "a", committed: true }], board, board).size).toBe(0);
    // …and in a run where BOTH happen, only the rolled-back one takes its dependents down: `a`
    // committed, so `b` still ran; `b` did not, so only `c` behind it is skipped.
    const mixed = skippedDependents(
      [
        { id: "a", committed: true },
        { id: "b", committed: false },
      ],
      board,
      board,
    );
    expect([...mixed.keys()]).toEqual(["c"]);
    expect(mixed.get("c")).toEqual({ waitingOn: "b", stopped: "b" });
  });

  it("says on the bead which ticket it waited on and which one a human must re-scope", () => {
    const direct = skipNote({ waitingOn: "a", stopped: "a" });
    expect(direct).toContain("depends on a, which ran out of time");
    expect(direct).toMatch(/Re-scope a/);

    const transitive = skipNote({ waitingOn: "b", stopped: "a" });
    expect(transitive).toContain("depends on b, which was itself skipped behind a");
    expect(transitive).toMatch(/Re-scope a/);
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

  it("inlines a description-only Acceptance section, even past the description's truncation cap", () => {
    // The gate accepts a rubric that lives only in the description; a fields-only read said
    // "(none stated)" for it whenever the truncated description block cut the section off.
    const p = ticketPrompt({
      id: "t-1",
      title: "T",
      status: "open",
      description: `## Context\n${"x".repeat(5000)}\n\n## Acceptance\n- [ ] the buried criterion`,
    } as Bead);
    expect(p).not.toContain("(none stated)");
    expect(p.slice(p.indexOf("## Acceptance criteria"))).toContain("- [ ] the buried criterion");
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

  // The ticket phase can dispatch several agents (a project's `step:claude` after `implement`), and
  // they all inherit this driver — so a resumed custom step must not be told its session was the
  // ticket's implementation.
  it("names the step being resumed, not just the ticket", () => {
    const t = { id: "t-1", title: "Do X", status: "open" } as Bead;
    expect(continuationPrompt(t, undefined, "smoke-test")).toContain("`smoke-test` step of t-1");
    expect(continuationPrompt(t)).toContain("t-1");
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

describe("reviewParkMessage (anton-3apm)", () => {
  const note = [
    "anton: the pre-PR self-review left 1 blocking finding(s) unresolved after 2 round(s):",
    "- src/z.ts:1 — AC-2 is not implemented",
    "",
    "Resolve them (or correct the ticket), then resume the run.",
  ].join("\n");

  const message = (noted: boolean) =>
    reviewParkMessage({
      targetId: "anton-x1",
      outcome: "unresolved",
      reason: "1 blocking finding(s) survived the gate",
      note,
      noted,
      orphan: undefined,
    });

  it("points at the bead when the note landed there", () => {
    const out = message(true);
    expect(out).toContain("anton-x1 did not pass its pre-PR self-review (unresolved)");
    expect(out).toContain("the findings are on the bead");
    // The bead holds them, so the run error stays a pointer rather than a second copy.
    expect(out).not.toContain("AC-2 is not implemented");
  });

  it("reproduces the findings in full when the bd write FAILED — the run error is their only copy", () => {
    // No PR body exists on a parked run and the score comments carry counts, not notes: without
    // this the locked-DB path discards every actionable detail while telling the founder to read
    // them on the bead.
    const out = message(false);
    expect(out).toContain("writing the findings to anton-x1 FAILED");
    expect(out).not.toContain("the findings are on the bead;");
    expect(out).toContain("AC-2 is not implemented");
    expect(out).toContain("Resolve them (or correct the ticket), then resume the run.");
  });
});

/**
 * anton-vqql: a blocked ticket's note has to say WHY. The agent's reason is already parsed and
 * logged; these cases pin it to the bead, alongside the evidence an operator would otherwise dig
 * for — and pin the invariant that keeps the notes blob parseable: exactly one line per note.
 */
describe("ticketBlockNote (anton-vqql)", () => {
  const HEAD = "0123456789abcdef0123456789abcdef01234567";
  const note = (over: Partial<Parameters<typeof ticketBlockNote>[0]> = {}) =>
    ticketBlockNote({
      kind: "agent-blocked",
      selfReport: { outcome: "blocked", reason: "the migration this depends on does not exist yet" },
      sessionId: "sess-1",
      branch: "anton/anton-e1",
      head: HEAD,
      ...over,
    });

  /** What an operator's board actually shows: the blob parsed back into attributed entries. */
  const parsed = (text: string) => parseTicketNotes(text);

  it("carries the agent's stated reason on the agent-blocked note", () => {
    const out = note();
    expect(out).toContain(`"the migration this depends on does not exist yet"`);
    expect(out).toContain("self-reported ANTON-RESULT: blocked");
  });

  it("names its evidence — session, and the branch + short sha of the committed work", () => {
    expect(note()).toContain("[session sess-1, committed on anton/anton-e1 @ 0123456]");
  });

  it("says nothing was committed when the tree was empty", () => {
    const out = note({ kind: "no-delivery", selfReport: null, head: undefined });
    expect(out).toContain("[session sess-1, nothing committed on anton/anton-e1]");
  });

  it("reads a `delivered` claim on an empty tree as the false success it is", () => {
    const out = note({ kind: "no-delivery", selfReport: { outcome: "delivered" }, head: undefined });
    expect(out).toContain("run made no changes");
    expect(out).toContain("self-reported ANTON-RESULT: delivered — a false success on an unchanged tree");
  });

  it("carries a `blocked` self-report onto the no-delivery note too", () => {
    const out = note({
      kind: "no-delivery",
      selfReport: { outcome: "blocked", reason: "the acceptance criteria contradict each other" },
      head: undefined,
    });
    expect(out).toContain("the acceptance criteria contradict each other");
    expect(out).toContain("corroborating the block");
  });

  it("carries the underlying error on a post-commit failure instead of a bare 'needs review'", () => {
    const out = note({ kind: "post-commit", selfReport: null, error: new Error("push rejected: non-fast-forward") });
    expect(out).toContain("run failed after committing work");
    expect(out).toContain("It failed with: push rejected: non-fast-forward");
  });

  it("degrades to the category text when the ANTON-RESULT line was missing or unparseable", () => {
    // Never an empty quote, never the string "undefined" — the two ways a naive interpolation
    // turns a missing reason into noise on the board.
    for (const out of [
      note({ selfReport: null }),
      note({ selfReport: { outcome: "blocked" } }),
      note({ selfReport: { outcome: "blocked", reason: "   " } }),
      note({ kind: "no-delivery", selfReport: { outcome: "blocked", reason: "   " }, head: undefined }),
      note({ kind: "post-commit", selfReport: null, error: undefined }),
    ]) {
      expect(out).not.toContain('""');
      expect(out).not.toContain("undefined");
      expect(out).not.toContain("null");
    }
    expect(note({ selfReport: null })).toContain("declared the ticket incomplete (no reason given)");
    expect(note({ kind: "post-commit", selfReport: null })).toContain("needs review");
  });

  it("flattens a multi-line reason into ONE machine note", () => {
    const out = note({
      selfReport: {
        outcome: "blocked",
        reason: "criterion 3 is impossible:\n  - the API has no such field\n  - and no migration adds one",
      },
    });
    expect(out).not.toContain("\n");
    const entries = parsed(out);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ source: "system", author: "anton" });
    expect(entries[0]!.text).toContain("the API has no such field - and no migration adds one");
  });

  it("caps an overlong reason, still as ONE machine note, keeping the evidence", () => {
    const out = note({ selfReport: { outcome: "blocked", reason: "x".repeat(5_000) } });
    expect(out.length).toBeLessThan(900);
    expect(out).toContain("…");
    expect(out).toContain("[session sess-1, committed on anton/anton-e1 @ 0123456]");
    expect(parsed(out)).toHaveLength(1);
  });

  it("keeps a note appended after a human note attributed to anton, not swallowed into it", () => {
    // The blob is append-only: a machine note that leaked a newline would be re-read as a second,
    // context-free entry — or worse, as body of the human note above it.
    const blob = [
      formatHumanNote("finish the migration first", "Henri", new Date("2026-08-05T00:00:00.000Z")),
      note(),
    ].join("\n");
    const entries = parsed(blob);
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({ source: "human", author: "Henri" });
    expect(entries[1]).toMatchObject({ source: "system", author: "anton" });
    expect(entries[1]!.text).toContain("the migration this depends on does not exist yet");
  });
});

/**
 * anton-k0kj: arming the merge wait is a decision about EVERY gate on the target, not just the
 * first one seen — a resolve that failed on an earlier run leaves a stale gate open alongside the
 * live one, and bd never auto-resolves it (a closed-unmerged PR escalates forever).
 */
describe("mergeGatePlan", () => {
  const gate = (id: string, awaitId: string, o: Partial<Gate> = {}): Gate =>
    ({ id, title: id, status: "open", issue_type: "gate", await_type: "gh:pr", await_id: awaitId, ...o }) as Gate;

  const target = (...gateIds: string[]): Bead =>
    ({
      id: "f-1",
      title: "f-1",
      status: "open",
      dependencies: gateIds.map((g) => ({ issue_id: "f-1", depends_on_id: g, type: "blocks" })),
    }) as Bead;

  it("creates the wait when the target carries none", () => {
    expect(mergeGatePlan([target()], "f-1", "9")).toEqual({ stale: [], create: true });
  });

  it("creates nothing when this PR's wait is already armed", () => {
    const board = [target("g-9"), gate("g-9", "9")];
    expect(mergeGatePlan(board, "f-1", "9")).toEqual({ stale: [], create: false });
  });

  it("resolves EVERY stale gate even when the current one is seen first", () => {
    // The failure this guards: a prior gateResolve that failed leaves #3 open next to #9. Returning
    // at #9 would leave #3 to be surfaced later as a stall against a PR nobody is waiting on.
    const board = [target("g-9", "g-3"), gate("g-9", "9"), gate("g-3", "3")];
    const plan = mergeGatePlan(board, "f-1", "9");
    expect(plan.stale.map((g) => g.id)).toEqual(["g-3"]);
    expect(plan.create).toBe(false); // …and no second gate races the live wait
  });

  it("supersedes an old PR's wait and arms the new one", () => {
    const board = [target("g-3"), gate("g-3", "3")];
    const plan = mergeGatePlan(board, "f-1", "9");
    expect(plan.stale.map((g) => g.id)).toEqual(["g-3"]);
    expect(plan.create).toBe(true);
  });

  it("ignores closed gates, non-blocks edges, and gates of another flavour", () => {
    const board = [
      target("g-closed", "g-related", "g-timer"),
      gate("g-closed", "3", { status: "closed" }),
      gate("g-related", "4"),
      gate("g-timer", "5", { await_type: "timer" }),
    ];
    const withRelated = [
      { ...board[0], dependencies: [{ issue_id: "f-1", depends_on_id: "g-related", type: "related" }] } as Bead,
      board[1],
      board[2],
      board[3],
    ];
    expect(mergeGatePlan(board, "f-1", "9").stale.map((g) => g.id)).toEqual(["g-related"]);
    expect(mergeGatePlan(withRelated, "f-1", "9")).toEqual({ stale: [], create: true });
  });
});
