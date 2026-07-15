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

  it("treats an EMPTY allowlist as all agents active (no regression for unset projects)", () => {
    expect(inactiveAgentTickets([ticket("t-1", ["agent:kubernetes"])], [])).toEqual([]);
  });

  it("never blocks user-provided custom agents outside KNOWN_AGENTS", () => {
    // The settings UI/API can only allowlist KNOWN_AGENTS, so a custom project agent
    // (anton-3n5.4) could never be enabled — it stays outside the toggle system.
    expect(inactiveAgentTickets([ticket("t-1", ["agent:my-custom"])], ["fastapi"])).toEqual([]);
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
