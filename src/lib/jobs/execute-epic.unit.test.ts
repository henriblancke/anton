/**
 * Unit tests for the active-agents allowlist enforcement (anton-dm7): which tickets dispatch
 * must refuse to run. The park behavior itself (PoisonEpic → run failed + job parked) is
 * exercised end-to-end in execute-epic.integration.test.ts.
 */
import { describe, expect, it } from "vitest";
import type { Bead } from "../beads/bd";
import { inactiveAgentTickets } from "./execute-epic";

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

  it("treats an EMPTY allowlist as no agents active — parks every labeled ticket", () => {
    // The operator toggled every agent off; the API persists [] as a real "no agents" value
    // distinct from clearing (undefined), so dispatch must honor it rather than run anyway.
    // Both bundled and custom agents are parked; only unlabeled (default agent) tickets pass.
    expect(
      inactiveAgentTickets(
        [ticket("t-1", ["agent:kubernetes"]), ticket("t-2", ["agent:my-custom"]), ticket("t-3")],
        [],
      ),
    ).toEqual([
      { id: "t-1", agent: "kubernetes" },
      { id: "t-2", agent: "my-custom" },
    ]);
  });

  it("gates user-provided custom agents like bundled ones (anton-dvo.1)", () => {
    // Custom `.claude/agents` are discoverable and toggleable now, so a disabled custom agent
    // parks; an enabled one passes.
    expect(inactiveAgentTickets([ticket("t-1", ["agent:my-custom"])], ["fastapi"])).toEqual([
      { id: "t-1", agent: "my-custom" },
    ]);
    expect(inactiveAgentTickets([ticket("t-1", ["agent:my-custom"])], ["my-custom"])).toEqual([]);
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
