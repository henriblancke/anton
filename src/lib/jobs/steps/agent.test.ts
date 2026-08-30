/**
 * Direct tests for the agent-dispatching steps: what `step:implement` hands each ticket's agent, and
 * where `step:claude` gets its reasoning from.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { Bead } from "../../beads/bd";
import { RunAlreadyLiveError } from "../errors";
import { claudeStep, implementStep, withDispatchNotes } from "./agent";
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
  });

  // A failed ticket must not silently pull the rest of the run along behind it.
  it("stops at the first ticket the agent could not deliver, and still reports its sessions", async () => {
    const claude = fakeClaude({ ok: false, text: "the model gave up" });

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

describe("withDispatchNotes", () => {
  // `bd show` failing (a locked DB, a frozen in-worktree Dolt) must never block the run.
  it("falls back to the board snapshot when bd cannot be read", async () => {
    const snapshot = ticket("anton-a");

    expect(await withDispatchNotes(join(sandbox.dir, "not-a-repo"), snapshot)).toEqual(snapshot);
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
