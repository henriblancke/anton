/**
 * What the approve route says when the RUN it just promised did not start (PR #214 review).
 *
 * The route keeps the approval when `enqueueExecuteEpic` throws — the label is the operator's
 * decision and it has already landed — and reports `run: "failed"`. Everything else in the body has
 * to honour that: the human-gate lines describe a run reaching each ticket and holding there, and
 * every surface that consumes this body toasts them as "anton runs the rest and holds these". Said
 * next to a failed enqueue, that is a promise about a run that does not exist.
 *
 * Its own file because it mocks the jobs service, which the sibling `approve-*` suites assert
 * against for real. Skipped when `bd`/`git` are absent.
 */
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { setupApproveSuite, type ApproveSuiteCtx } from "../approve.fixture";
import { describeBd } from "@/lib/testing/integration";

vi.mock("@/lib/jobs/service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/jobs/service")>();
  return {
    ...actual,
    enqueueExecuteEpic: vi.fn(async () => {
      throw new Error("queue unreachable");
    }),
  };
});

let fileDb: ApproveSuiteCtx["fileDb"];
let bdRepo: ApproveSuiteCtx["bdRepo"];
let repo: string;
let approve: ApproveSuiteCtx["approve"];
let beads: ApproveSuiteCtx["beads"];
let resetOperatorCache: ApproveSuiteCtx["resetOperatorCache"];

describeBd("POST /api/projects/[slug]/epics/[epicId]/approve — a run that never started", () => {
  beforeAll(async () => {
    const s = await setupApproveSuite();
    ({ fileDb, bdRepo, repo, approve, beads, resetOperatorCache } = s);
    // The enqueue failure is logged by design; keep the suite output honest without silencing it.
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterAll(() => {
    vi.restoreAllMocks();
    fileDb?.cleanup();
    bdRepo?.cleanup();
    delete process.env.ANTON_OPERATOR;
    resetOperatorCache?.();
  });

  it("withholds the human-gate lines when the enqueue failed, and keeps the approval", async () => {
    const target = await beads.create(repo, {
      title: "Feature with human work",
      type: "feature",
      acceptance: "- [ ] it works",
    });
    const personWork = await beads.create(repo, {
      title: "Buy the domain",
      type: "task",
      acceptance: "- [ ] the domain resolves",
      labels: ["agent:human"],
    });
    await beads.link(repo, personWork, target, "parent-child");

    const res = await approve(target);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.run).toBe("failed");
    // "anton runs the rest and holds these" contradicts the failure reported in the same body.
    expect(body).not.toHaveProperty("humanGates");
    // The decision still landed — the operator re-runs it, they don't re-decide it.
    expect(beads.isApproved(await beads.show(repo, target))).toBe(true);
  });

  it("still hands back a human TARGET — no agent-run starts however the enqueue went", async () => {
    const target = await beads.create(repo, {
      title: "Sign the contract",
      type: "task",
      acceptance: "- [ ] it is signed",
      labels: ["agent:human"],
    });

    const res = await approve(target);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.run).toBe("failed");
    expect(body.humanTarget).toBe(true);
  });
});
