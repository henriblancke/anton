/**
 * Direct tests for the agent-dispatching steps: what `step:implement` hands each ticket's agent, and
 * where `step:claude` gets its reasoning from.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { InvocationDimensions } from "../../claude-invocations";
import { beads, type Bead } from "../../beads/bd";
import { schema } from "../../db";
import { updateRun } from "../../runs";
import { RunAlreadyLiveError, VerifyGateFailedError } from "../errors";
import { encodeGateFailure } from "../gate-failure-record";

/**
 * Capture what reaches the spend ledger's metered boundary. Wrapping rather than stubbing: the
 * dispatch still runs, so what is asserted is the dimensions a real dispatch produced.
 */
const metered: InvocationDimensions[] = [];

vi.mock("../../claude-invocations", async () => {
  const actual = await vi.importActual<typeof import("../../claude-invocations")>(
    "../../claude-invocations",
  );
  return {
    ...actual,
    metered: (
      db: Parameters<typeof actual.metered>[0],
      clock: Parameters<typeof actual.metered>[1],
      dimensions: InvocationDimensions,
      driver: Parameters<typeof actual.metered>[3],
    ) => {
      metered.push(dimensions);
      return actual.metered(db, clock, dimensions, driver);
    },
  };
});

const { claudeStep, implementStep, readForDispatch } = await import("./agent");
const { BRANCH, closeSandbox, clock, fakeClaude, openSandbox, target } = await import("./step.fixture");

let sandbox: Awaited<ReturnType<typeof openSandbox>>;

beforeEach(async () => {
  metered.length = 0;
  sandbox = await openSandbox("steps-agent");
});

afterEach(() => closeSandbox(sandbox));

const ticket = (id: string): Bead => ({ ...target, id, title: `ticket ${id}` });

describe("step:implement", () => {
  it("dispatches once per ticket, in order, with that ticket's spec on stdin", async () => {
    const claude = fakeClaude("ANTON-RESULT: delivered", "ANTON-RESULT: delivered");

    const result = await implementStep(
      sandbox.context({
        tickets: [ticket("anton-a"), ticket("anton-b")],
        deps: { runClaude: claude.run },
      }),
    );

    expect(result.ok).toBe(true);
    expect(claude.calls).toHaveLength(2);
    expect(claude.calls[0].prompt).toContain("anton-a");
    expect(claude.calls[1].prompt).toContain("anton-b");
    // Every dispatch is recorded, in dispatch order, so the caller can file them all.
    expect(result.facts.sessionIds).toHaveLength(2);
    // And the bead the LAST agent was prompted with rides out with the report — the read an
    // `already-shipped` claim is fenced on (PR #238 review). No board here, so it is the snapshot.
    expect(result.facts.dispatched).toEqual(ticket("anton-b"));
  });

  // A failed ticket must not silently pull the rest of the run along behind it.
  it("stops at the first ticket the agent could not deliver, and still reports its sessions", async () => {
    const claude = fakeClaude({ ok: false, text: "the model gave up", modelUsage: [] });

    const result = await implementStep(
      sandbox.context({
        tickets: [ticket("anton-a"), ticket("anton-b")],
        deps: { runClaude: claude.run },
      }),
    );

    expect(result.ok).toBe(false);
    expect(result.detail).toContain("anton-a");
    expect(claude.calls).toHaveLength(1);
    expect(result.facts.sessionIds).toHaveLength(1);
  });

  // `runs.agent_tag` is per-RUN, so a run whose tickets used different specialists records one of
  // them. Which agent ran is a per-TICKET fact, and the ledger's grain is where it stays true.
  it("attributes each ticket's invocation to that ticket's own agent", async () => {
    const claude = fakeClaude("ANTON-RESULT: delivered", "ANTON-RESULT: delivered");
    const tagged = (id: string, tag?: string): Bead => ({
      ...ticket(id),
      labels: tag ? [`agent:${tag}`, "domain:eng"] : ["domain:eng"],
    });

    await implementStep(
      sandbox.context({
        tickets: [tagged("anton-a", "nextjs"), tagged("anton-b")],
        deps: { runClaude: claude.run },
      }),
    );

    // The second names no agent, so it records null rather than inheriting its neighbour's.
    expect(metered.map((d) => [d.beadId, d.agentTag])).toEqual([
      ["anton-a", "nextjs"],
      ["anton-b", undefined],
    ]);
  });

  it("honours the run lease — a lapsed lease yields before any dispatch", async () => {
    const claude = fakeClaude("never dispatched");

    await expect(
      implementStep(
        sandbox.context({
          assertLeaseHeld: () => {
            throw new RunAlreadyLiveError("lease lapsed", "unproven");
          },
          deps: { runClaude: claude.run },
        }),
      ),
    ).rejects.toThrow(/lease lapsed/);
    expect(claude.calls).toHaveLength(0);
  });
});

// Records a red verify gate against the sandbox's run row, the same way `gateFailurePatch`
// (execute-epic-settle.ts) does, so `implementStep`'s branch-scoped read has something to find —
// this row is the only one on the sandbox's branch, so it stands in for whichever attempt (this run
// or an earlier, now-`failed` one on the same branch) actually recorded it.
async function recordGateFailure(beadId: string, overrides: Partial<{ label: string; command: string; output: string }> = {}): Promise<void> {
  const label = overrides.label ?? "tests";
  const command = overrides.command ?? "bun run test";
  const e = new VerifyGateFailedError(
    `${label} gate failed for ${beadId} (exit 1)`,
    { label, command, ok: false, code: 1, output: overrides.output ?? "FAIL something" },
    { beadId },
  );
  await updateRun(sandbox.tdb.db, clock, sandbox.runId, {
    lastGateFailure: encodeGateFailure(e, { beadId }) ?? null,
  });
}

describe("step:implement — the recorded gate failure (anton-pm3kv)", () => {
  // The whole point of the gate this feeds: a first attempt has no row to read, so its prompt must
  // read exactly as it did before this wiring existed.
  it("dispatches without the block when the run has no recorded gate failure", async () => {
    const claude = fakeClaude("ANTON-RESULT: delivered");

    await implementStep(sandbox.context({ tickets: [ticket("anton-a")], deps: { runClaude: claude.run } }));

    expect(claude.calls[0].prompt).not.toContain("A gate failed on a previous attempt");
  });

  // A gate failure always settles its row `failed`, so the attempt that recorded one is never THIS
  // run's own row on a real retry — the branch-scoped read is what reaches across that boundary,
  // and this is the read half of anton-vynb8 that actually reaches the agent.
  it("names the failing gate when a previous attempt on this branch recorded one", async () => {
    await recordGateFailure("anton-a", { label: "typecheck", command: "bun run typecheck" });
    const claude = fakeClaude("ANTON-RESULT: delivered");

    await implementStep(sandbox.context({ tickets: [ticket("anton-a")], deps: { runClaude: claude.run } }));

    expect(claude.calls[0].prompt).toContain("A gate failed on a previous attempt");
    expect(claude.calls[0].prompt).toContain("**typecheck** gate failed");
    expect(claude.calls[0].prompt).toContain("`bun run typecheck`");
  });

  // The real shape a retry hits: a PRIOR row on this branch settled `failed` with the gate recorded
  // (findOpenRunForEpic never resumes it), and the current attempt is a wholly separate, fresh row —
  // no `lastGateFailure` of its own. Proves the branch-scoped read actually reaches across that row
  // boundary, not just within one row (anton-q0lpo finding: a runId-scoped read never could).
  it("names the failing gate a DIFFERENT, now-failed row on this branch recorded", async () => {
    const priorRunId = randomUUID();
    const e = new VerifyGateFailedError(
      "lint gate failed for anton-a (exit 1)",
      { label: "lint", command: "bun run lint", ok: false, code: 1, output: "FAIL lint" },
      { beadId: "anton-a" },
    );
    await sandbox.tdb.db.insert(schema.runs).values({
      id: priorRunId,
      projectId: sandbox.projectId,
      epicBeadId: target.id,
      branch: BRANCH,
      status: "failed",
      lastGateFailure: encodeGateFailure(e, { beadId: "anton-a" }),
    });
    const claude = fakeClaude("ANTON-RESULT: delivered");

    await implementStep(sandbox.context({ tickets: [ticket("anton-a")], deps: { runClaude: claude.run } }));

    expect(claude.calls[0].prompt).toContain("A gate failed on a previous attempt");
    expect(claude.calls[0].prompt).toContain("**lint** gate failed");
  });

  // The record names the bead its gate ran under; a run-phase gate names the run target, and a
  // sibling ticket in this walk must not be told about a failure that was never its own.
  it("shows the block only to the ticket the recorded failure names", async () => {
    await recordGateFailure("anton-a");
    const claude = fakeClaude("ANTON-RESULT: delivered", "ANTON-RESULT: delivered");

    await implementStep(
      sandbox.context({
        tickets: [ticket("anton-a"), ticket("anton-b")],
        deps: { runClaude: claude.run },
      }),
    );

    expect(claude.calls[0].prompt).toContain("A gate failed on a previous attempt");
    expect(claude.calls[1].prompt).not.toContain("A gate failed on a previous attempt");
  });

  // Read fresh at dispatch, not cached across the call: a multi-ticket walk where an earlier
  // ticket's own `step:verify` clears the row (a pass) must not still show the failure to a later
  // ticket dispatched within the same run.
  it("stops naming the failure once the row it reads has been cleared", async () => {
    await recordGateFailure("anton-a");
    await updateRun(sandbox.tdb.db, clock, sandbox.runId, { lastGateFailure: null });
    const claude = fakeClaude("ANTON-RESULT: delivered");

    await implementStep(sandbox.context({ tickets: [ticket("anton-a")], deps: { runClaude: claude.run } }));

    expect(claude.calls[0].prompt).not.toContain("A gate failed on a previous attempt");
  });

  // A resumed ticket can carry both an earlier attempt's preserved commit AND a recorded gate
  // failure at once. ticketPrompt already orders the two (anton-ahsja); this proves implementStep
  // actually resolves and hands it both rather than just one.
  it("hands a ticket both the recorded-failure and continuation blocks, failure first", async () => {
    const git = (...args: string[]) => execFileSync("git", args, { cwd: sandbox.dir, stdio: "ignore" });
    git("init", "-q", "-b", "main");
    git("config", "user.email", "anton@example.com");
    git("config", "user.name", "anton");
    git("commit", "-q", "--allow-empty", "-m", "WIP anton-a: partial work, stopped at its budget");
    await recordGateFailure("anton-a");
    const claude = fakeClaude("ANTON-RESULT: delivered");

    await implementStep(sandbox.context({ tickets: [ticket("anton-a")], deps: { runClaude: claude.run } }));

    const prompt = claude.calls[0].prompt;
    expect(prompt).toContain("A gate failed on a previous attempt");
    expect(prompt).toContain("CONTINUATION");
    expect(prompt.indexOf("A gate failed on a previous attempt")).toBeLessThan(prompt.indexOf("CONTINUATION"));
  });
});

describe("readForDispatch", () => {
  afterEach(() => vi.restoreAllMocks());

  /** A board row as a listing that drops the description hands it over. */
  const row: Bead = { id: "anton-a", title: "ticket anton-a", status: "in_progress", issue_type: "task" };

  // `bd show` failing (a locked DB, a frozen in-worktree Dolt) must never block the run.
  it("falls back to the board snapshot when bd cannot be read", async () => {
    const snapshot = ticket("anton-a");

    expect(await readForDispatch(join(sandbox.dir, "not-a-repo"), snapshot)).toEqual(snapshot);
  });

  // A listing that dropped the description (the one field `bd list` omits on some bd versions)
  // would otherwise prompt the agent without the contract — and leave the `already-shipped` fence
  // with no dispatch-time contract to hold the claim to (PR #238 review).
  it("carries the full read's description when the snapshot row dropped it", async () => {
    const contract = "## Goal\nShip it.\n## Acceptance\n- [ ] it ships";
    vi.spyOn(beads, "show").mockResolvedValue({ ...row, description: contract, notes: "anton: steer" });

    expect(await readForDispatch(sandbox.dir, row)).toEqual({ ...row, description: contract, notes: "anton: steer" });
  });

  it("dispatches an empty description, not an unknown one, when the full read carries none", async () => {
    vi.spyOn(beads, "show").mockResolvedValue({ ...row });

    expect(await readForDispatch(sandbox.dir, row)).toEqual({ ...row, description: "" });
  });

  it("keeps the snapshot's own description over the full read's", async () => {
    const snapshot = { ...ticket("anton-a"), description: "as listed" };
    vi.spyOn(beads, "show").mockResolvedValue({ ...snapshot, description: "as shown" });

    expect(await readForDispatch(sandbox.dir, snapshot)).toEqual(snapshot);
  });
});

describe("step:claude", () => {
  it("dispatches the project-named prompt above the run's own task block", async () => {
    mkdirSync(join(sandbox.dir, ".claude", "agents"), { recursive: true });
    writeFileSync(join(sandbox.dir, ".claude", "agents", "audit.md"), "Audit the design system.");
    const claude = fakeClaude("ANTON-RESULT: delivered");

    const result = await claudeStep(
      sandbox.context({
        step: { id: "audit", labels: ["step:claude", "prompt:audit"] },
        deps: { runClaude: claude.run },
      }),
    );

    expect(result.ok).toBe(true);
    const prompt = claude.calls[0].prompt;
    expect(prompt).toContain("Audit the design system.");
    expect(prompt).toContain("`audit` step");
    // The reasoning contract comes first; the run context reads as what it applies TO.
    expect(prompt.indexOf("Audit the design system.")).toBeLessThan(prompt.indexOf("`audit` step"));
  });

  it("inlines the dispatched ticket contract and records it with a single-ticket report", async () => {
    mkdirSync(join(sandbox.dir, ".claude", "agents"), { recursive: true });
    writeFileSync(join(sandbox.dir, ".claude", "agents", "audit.md"), "Audit the design system.");
    const claude = fakeClaude("ANTON-RESULT: blocked — already-shipped — anton-survivor already shipped it");
    const dispatched = ticket("anton-a");
    dispatched.description = "## Goal\n\nShip it.\n\n## Acceptance\n\n- [ ] it ships";
    dispatched.acceptance_criteria = "- [ ] it ships";

    const result = await claudeStep(
      sandbox.context({
        tickets: [dispatched],
        step: { id: "audit", labels: ["step:claude", "prompt:audit"] },
        deps: { runClaude: claude.run },
      }),
    );

    expect(claude.calls[0].prompt).toContain(`## Ticket contract — ${dispatched.id}`);
    expect(claude.calls[0].prompt).toContain("- [ ] it ships");
    expect(result.facts?.dispatched).toEqual(dispatched);
  });

  it("attributes the invocation to the prompt it resolved, with no skill beside it", async () => {
    mkdirSync(join(sandbox.dir, ".claude", "agents"), { recursive: true });
    writeFileSync(join(sandbox.dir, ".claude", "agents", "audit.md"), "Audit the design system.");

    await claudeStep(
      sandbox.context({
        step: { id: "audit", labels: ["step:claude", "prompt:audit"] },
        deps: { runClaude: fakeClaude("ANTON-RESULT: delivered").run },
      }),
    );

    expect(metered).toHaveLength(1);
    expect(metered[0]).toMatchObject({ step: "audit", promptId: "audit" });
    expect(metered[0].skillId).toBeUndefined();
    expect(metered[0].skillDigest).toBeUndefined();
    expect(metered[0].promptBodyDigest).toMatch(/^[0-9a-f]{12}$/);
  });

  // The skill that ran is versioned, not just named: it resolves project-local-first and is edited
  // in place, so the id alone cannot tell two cohorts' instructions apart.
  it("attributes the invocation to the skill it resolved, at the version that ran", async () => {
    mkdirSync(join(sandbox.dir, ".claude", "skills", "smoke"), { recursive: true });
    writeFileSync(join(sandbox.dir, ".claude", "skills", "smoke", "SKILL.md"), "Smoke it.");

    await claudeStep(
      sandbox.context({
        step: { id: "smoke", labels: ["step:claude", "skill:smoke"] },
        deps: { runClaude: fakeClaude("ANTON-RESULT: delivered").run },
      }),
    );

    expect(metered[0]).toMatchObject({ step: "smoke", skillId: "smoke" });
    expect(metered[0].promptId).toBeUndefined();
    expect(metered[0].skillDigest).toMatch(/^[0-9a-f]{12}$/);
    expect(metered[0].promptBodyDigest).toBeUndefined();
  });
});
