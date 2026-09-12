/**
 * Direct tests for the agent-dispatching steps: what `step:implement` hands each ticket's agent, and
 * where `step:claude` gets its reasoning from.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { beads, type Bead } from "../../beads/bd";
import { RunAlreadyLiveError } from "../errors";
import { claudeStep, implementStep, readForDispatch } from "./agent";
import { closeSandbox, fakeClaude, openSandbox, target } from "./step.fixture";

let sandbox: Awaited<ReturnType<typeof openSandbox>>;

beforeEach(async () => {
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
});
