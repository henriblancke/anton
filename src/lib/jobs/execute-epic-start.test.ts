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
import { attachCycleEvidence } from "../beads/cycle-evidence";
import { proposalFingerprint } from "../gardener/detections";
import type { ProjectSettings } from "../projects";
import { quotaMeterKey } from "../quota-meter";
import { PoisonEpic, RouteAdmissionStaleError } from "./errors";

const loadAllIssuesMock = vi.fn();
const createRunMock = vi.fn();
const updateRunMock = vi.fn();
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
    updateRun: (...args: unknown[]) => updateRunMock(...args),
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
async function start(
  board: Bead[],
  targetId: string,
  opts: { admittedMeterKey?: string } = {},
): Promise<unknown> {
  loadAllIssuesMock.mockResolvedValue(board);
  return beginEpicRun({
    db: {} as never,
    ctx: {
      payload: { projectId: "p1", epicBeadId: targetId },
      admittedMeterKey: opts.admittedMeterKey,
    } as never,
  }).then(
    (run) => run,
    (e: unknown) => e,
  );
}

beforeEach(() => {
  loadAllIssuesMock.mockReset();
  createRunMock.mockReset();
  updateRunMock.mockReset();
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

  it("refreshes the provenance on resume — the reopened attempt drives the current gateway", async () => {
    // A parked run resumed after its project's gateway setting changed drives the newly resolved
    // endpoint, so the reused row must move with it rather than keep the old route it was opened on.
    findOpenRunForEpicMock.mockResolvedValue({ id: "existing-run" });
    projectSettings = {
      claudeBaseUrl: "https://token@router.local:20128/v1",
      claudeAuthTokenEnv: "GATEWAY_TOKEN",
    };

    await start([bead("t1")], "t1");

    expect(createRunMock).not.toHaveBeenCalled();
    expect(updateRunMock).toHaveBeenCalledTimes(1);
    expect(updateRunMock.mock.calls[0][3]).toMatchObject({ endpointHost: "router.local:20128" });
  });
});

describe("beginEpicRun — refuses a start whose routing outran its budget admission (PR #269 review)", () => {
  // Budget admission (the governor's per-tick check) is granted against a meterKey snapshot that can
  // still be stale by the time a start takes its OWN settings read, closest to the point it would
  // actually hold anything. The admitted meter is carried through the lease as `ctx.admittedMeterKey`
  // so a mismatch here — routing moved again since admission — refuses the start rather than
  // dispatching through a meter that never cleared `budgetGate`.
  it("refuses when the current route no longer matches what admitted this tick", async () => {
    projectSettings = {
      claudeBaseUrl: "https://token@router.local:20128/v1",
      claudeAuthTokenEnv: "GATEWAY_TOKEN",
      routerConnectionId: "conn-1",
    };

    const refusal = await start([bead("t1")], "t1", { admittedMeterKey: "anthropic" });

    expect(refusal).toBeInstanceOf(RouteAdmissionStaleError);
    expect((refusal as Error).message).toContain("anthropic");
    // Nothing held: no run row means no lease, no worktree and no claim can follow.
    expect(createRunMock).not.toHaveBeenCalled();
  });

  it("proceeds when the current route still matches the admitted meter", async () => {
    projectSettings = {
      claudeBaseUrl: "https://token@router.local:20128/v1",
      claudeAuthTokenEnv: "GATEWAY_TOKEN",
      routerConnectionId: "conn-1",
    };

    const refusal = await start([bead("t1")], "t1", {
      admittedMeterKey: quotaMeterKey(projectSettings),
    });

    expect(refusal).not.toBeInstanceOf(Error);
    expect(createRunMock).toHaveBeenCalledTimes(1);
  });

  it("proceeds unchecked when the tick admitted nothing to compare against (ungoverned project)", async () => {
    projectSettings = {
      claudeBaseUrl: "https://token@router.local:20128/v1",
      claudeAuthTokenEnv: "GATEWAY_TOKEN",
      routerConnectionId: "conn-1",
    };

    const refusal = await start([bead("t1")], "t1");

    expect(refusal).not.toBeInstanceOf(Error);
    expect(createRunMock).toHaveBeenCalledTimes(1);
  });
});

describe("beginEpicRun — the run-row model", () => {
  it("keeps the configured fallback instead of claiming a target-label route ran for every ticket", async () => {
    projectSettings = {
      model: "fallback",
      modelRoutes: [{ jobType: "execute-epic", label: "risk:high", model: "routed" }],
    };

    await start([bead("t1", { labels: [LABELS.approved, "risk:high"] })], "t1");

    expect(createRunMock.mock.calls[0][2]).toMatchObject({ model: "fallback" });
  });
});

describe("beginEpicRun — the structure/cycle re-check (PR #274 review)", () => {
  // Approval only guarantees a run's own tickets were cycle-free AT APPROVAL TIME. A cross-machine
  // Dolt merge can land an internal `blocks` cycle among this run's own tickets after that check
  // passed but before the job dispatches — `runReadiness` treats an internal edge as ordering, not a
  // blocker, so it never sees the cycle, and `orderTickets` (execute-epic-board.ts) falls back to
  // input order rather than refusing. This gate is what refuses the run instead of dispatching a
  // ticket ahead of a prerequisite the edges say it must follow.
  it("poisons a run whose own tickets sit in a blocks cycle bd reports", async () => {
    const target = bead("e1", { issue_type: "epic" });
    const t1 = bead("t1", { parent: "e1", dependencies: [{ type: "blocks", issue_id: "t1", depends_on_id: "t2" }] });
    const t2 = bead("t2", { parent: "e1", dependencies: [{ type: "blocks", issue_id: "t2", depends_on_id: "t1" }] });
    const board = [target, t1, t2];
    attachCycleEvidence(board, [{ ids: ["t1", "t2"], raw: {} }]);

    const refusal = await start(board, "e1");

    expect(refusal).toBeInstanceOf(PoisonEpic);
    const message = (refusal as Error).message;
    expect(message).toContain("e1");
    expect(message).toContain("breaks the tier structure");
    expect(message).toContain("sits in a blocks cycle");
    expect(message).toContain("t1");
    expect(message).toContain("t2");
    // Nothing held: the run never reaches a worktree or a claim over a graph it cannot dispatch.
    expect(createRunMock).not.toHaveBeenCalled();
  });

  it("leaves a cycle-free target alone — bd's own evidence says the graph is safe to dispatch", async () => {
    const target = bead("e2", { issue_type: "epic" });
    const t1 = bead("t1", { parent: "e2" });
    const t2 = bead("t2", { parent: "e2", dependencies: [{ type: "blocks", issue_id: "t2", depends_on_id: "t1" }] });
    const board = [target, t1, t2];
    attachCycleEvidence(board, []);

    await start(board, "e2");

    expect(createRunMock).toHaveBeenCalledTimes(1);
  });
});
