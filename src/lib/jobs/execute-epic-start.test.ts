/**
 * anton-x37c — the runner's pre-flight refusal of a PROPOSAL target, branch by branch.
 *
 * A proposal is a decision about the board, not work on it: anton files one as a parentless task
 * carrying a full contract, so every other gate in {@link beginEpicRun} admits it and the run would
 * go on to warm a worktree and dispatch an agent at a board move anton applies itself on approval.
 * The claimable set and the picker already refuse one; this is the backstop for every other way a
 * run starts — a Force run, an API enqueue, a job queued before the label landed.
 *
 * What is pinned here is that the refusal lands BEFORE anything is held (no run row, so no worktree
 * and no claim can follow) and that it is the LABEL that decides — not the bead's shape, its type or
 * its approval, each of which reads exactly like ordinary work. The end-to-end proof against real
 * bd/git lives in execute-epic.recovery.integration.test.ts.
 *
 * Mocked at the module seam: the gate under test runs before any I/O of its own, and a real project
 * row would only buy a bd spawn per case.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { LABELS, type Bead } from "../beads/bd";
import { proposalFingerprint } from "../gardener/detections";
import type { ProjectSettings } from "../projects";
import { PoisonEpic } from "./errors";

const loadAllIssuesMock = vi.fn();
const createRunMock = vi.fn();
const findOpenRunForEpicMock = vi.fn();

// The settings a start reads — mutable so a case can route the project before starting it.
let projectSettings: ProjectSettings = {};

vi.mock("../beads/issues", () => ({
  loadAllIssues: (...args: unknown[]) => loadAllIssuesMock(...args),
}));

vi.mock("../projects", async () => {
  const actual = await vi.importActual<typeof import("../projects")>("../projects");
  return {
    ...actual,
    getProjectById: async () => ({ id: "p1", slug: "p1", name: "p1", repoPath: "/tmp/anton-start" }),
    getProjectSettings: async () => projectSettings,
  };
});

// The run row is the first thing a start HOLDS — every refusal under test must land ahead of it.
vi.mock("../runs", async () => {
  const actual = await vi.importActual<typeof import("../runs")>("../runs");
  return {
    ...actual,
    findOpenRunForEpic: (...args: unknown[]) => findOpenRunForEpicMock(...args),
    createRun: (...args: unknown[]) => createRunMock(...args),
  };
});

// Agent discovery reads the project's `.claude/agents` off disk; the sandbox has none.
vi.mock("../agents-discovery", () => ({
  discoverAgents: async () => [],
  bundledAgentIds: async () => [],
}));

const { beginEpicRun } = await import("./execute-epic-start");

/** A dated, contract-shaped parentless task — an ordinary epic-of-one run target. */
function bead(id: string, o: Partial<Bead> = {}): Bead {
  return {
    id,
    title: id,
    status: "open",
    issue_type: "task",
    description: "## Goal\n\nShip it.\n",
    acceptance_criteria: "- [ ] it ships",
    labels: [LABELS.approved],
    ...o,
  } as Bead;
}

/** The same bead a producer files a decision as: identical in every way but the fingerprint. */
function proposal(id: string, kind: "stale" | "low-value" = "stale"): Bead {
  return bead(id, { labels: [LABELS.approved, proposalFingerprint(kind, "t9")] });
}

/** Start a run against `board`, and hand back whatever it refused with. */
async function start(board: Bead[], targetId: string): Promise<unknown> {
  loadAllIssuesMock.mockResolvedValue(board);
  return beginEpicRun({
    db: {} as never,
    ctx: { payload: { projectId: "p1", epicBeadId: targetId } } as never,
  }).then(
    (run) => run,
    (e: unknown) => e,
  );
}

beforeEach(() => {
  loadAllIssuesMock.mockReset();
  createRunMock.mockReset();
  findOpenRunForEpicMock.mockReset().mockResolvedValue(undefined);
  projectSettings = {};
});

describe("beginEpicRun — a proposal target (anton-x37c)", () => {
  it("refuses one before any run row exists, naming the label and the gesture that ends it", async () => {
    const target = proposal("p1-bead");

    const refusal = await start([target], "p1-bead");

    expect(refusal).toBeInstanceOf(PoisonEpic);
    const message = (refusal as Error).message;
    expect(message).toContain("p1-bead");
    expect(message).toContain("is a proposal, not work");
    expect(message).toContain(proposalFingerprint("stale", "t9"));
    expect(message).toMatch(/approv/i);
    // Nothing held: no run row means no lease, no worktree and no claim can follow.
    expect(createRunMock).not.toHaveBeenCalled();
  });

  it("refuses a pm proposal in the same words — the fingerprint says decision, not the producer", async () => {
    const refusal = await start([proposal("p2-bead", "low-value")], "p2-bead");

    expect(refusal).toBeInstanceOf(PoisonEpic);
    expect((refusal as Error).message).toContain(proposalFingerprint("low-value", "t9"));
    expect(createRunMock).not.toHaveBeenCalled();
  });

  it("refuses an UNAPPROVED proposal as a proposal, not as work awaiting a signature", async () => {
    // Ordering matters to the operator: "approve it" is the wrong instruction for a bead whose
    // approval would apply a board move rather than start a run.
    const target = proposal("p3-bead");
    target.labels = [proposalFingerprint("stale", "t9")];

    const refusal = await start([target], "p3-bead");

    expect((refusal as Error).message).toContain("is a proposal, not work");
    expect((refusal as Error).message).not.toContain("is not approved");
  });

  it("still refuses an unapproved ordinary task for its approval — the label is the difference", async () => {
    const target = bead("t1", { labels: [] });

    const refusal = await start([target], "t1");

    expect((refusal as Error).message).toContain("is not approved");
    expect((refusal as Error).message).not.toContain("is a proposal");
  });

  it("leaves an ordinary approved target alone — it opens its run row as before", async () => {
    await start([bead("t1")], "t1");

    expect(createRunMock).toHaveBeenCalledTimes(1);
  });
});

describe("beginEpicRun — the created run records its endpoint host (anton-oom5)", () => {
  // The one input a board read can never carry: where a run's traffic went. A routed project must
  // stamp its gateway onto the row it opens, or the provenance defaults to the Claude API for work
  // that never touched it.
  const endpointHostOf = () => createRunMock.mock.calls[0]?.[2]?.endpointHost;

  it("stamps the gateway host a routed project drives", async () => {
    projectSettings = {
      claudeBaseUrl: "https://token@router.local:20128/v1",
      claudeAuthTokenEnv: "GATEWAY_TOKEN",
    };

    await start([bead("t1")], "t1");

    expect(createRunMock).toHaveBeenCalledTimes(1);
    // The HOST only — never the userinfo token that rode on the base URL.
    expect(endpointHostOf()).toBe("router.local:20128");
  });

  it("stamps the Claude API default for an unrouted project", async () => {
    await start([bead("t1")], "t1");

    expect(endpointHostOf()).toBe("api.anthropic.com");
  });

  it("stamps the Claude API default when a base URL resolves unrouted for want of a token env", async () => {
    // The base URL alone does not route — the run drives the Claude API, and the provenance must say
    // so rather than claiming a gateway it never reached.
    projectSettings = { claudeBaseUrl: "https://router.local:20128/v1" };

    await start([bead("t1")], "t1");

    expect(endpointHostOf()).toBe("api.anthropic.com");
  });
});
