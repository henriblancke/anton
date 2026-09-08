/**
 * The precedence between the brakes (anton-wy9y / R4.1, anton-mh3c). One band, several things that
 * can be true at once — and getting the order wrong tells an operator "nothing for you to do" about a
 * policy that is frozen until they act, or leaves a stale process explaining itself as a quality
 * disarm it never was.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AutopilotDisarm, AutopilotHold } from "./autopilot-breaker";
import type { SelfFreshness } from "./jobs/self-freshness";
import type { Project } from "./types";

const currentDisarm = vi.hoisted(() => vi.fn());
const currentWipHold = vi.hoisted(() => vi.fn());
const checkSelfFreshness = vi.hoisted(() => vi.fn());
vi.mock("./autopilot-disarm", () => ({ currentDisarm }));
vi.mock("./jobs/picker-wip-hold", () => ({ currentWipHold }));
vi.mock("./jobs/self-freshness", () => ({
  checkSelfFreshness,
  selfRepoRoot: () => "/self",
}));

const FRESH: SelfFreshness = { checkout: { state: "current" }, dependencies: { state: "match" } };

const { currentBreaker } = await import("./autopilot-state");

const project = { id: "p1", slug: "p1", name: "P1", repoPath: "/repo" } as Project;

const disarm: AutopilotDisarm = {
  kind: "disarm",
  reason: "score-regression",
  detail: "3 consecutive runs scored below 7/10",
  evidence: [],
};
const hold: AutopilotHold = { kind: "hold", reason: "wip-limit", detail: "3 open PRs" };

beforeEach(() => checkSelfFreshness.mockResolvedValue(FRESH));
afterEach(() => vi.clearAllMocks());

describe("currentBreaker", () => {
  it("shows nothing while the autopilot is running", async () => {
    currentDisarm.mockResolvedValue(undefined);
    currentWipHold.mockResolvedValue(undefined);

    expect(await currentBreaker(project)).toBeUndefined();
  });

  it("shows a stale stop over everything, and never pays for the board reads to find that out", async () => {
    // A process behind its own code refuses to start ANY run, so nothing a disarm or hold clears
    // would let work start while it stands — the stale band wins, and the per-project reads never run.
    checkSelfFreshness.mockResolvedValue({
      checkout: { state: "behind", behind: 2, upstream: "origin/main" },
      dependencies: { state: "match" },
    } satisfies SelfFreshness);
    currentDisarm.mockResolvedValue(disarm);
    currentWipHold.mockResolvedValue(hold);

    const breaker = await currentBreaker(project);
    expect(breaker?.kind).toBe("stale");
    expect(currentDisarm).not.toHaveBeenCalled();
    expect(currentWipHold).not.toHaveBeenCalled();
  });

  it("falls through to the per-project brakes when anton is running its own latest code", async () => {
    currentDisarm.mockResolvedValue(disarm);
    currentWipHold.mockResolvedValue(hold);

    expect(await currentBreaker(project)).toBe(disarm);
  });

  it("shows the hold when only the review queue is full", async () => {
    currentDisarm.mockResolvedValue(undefined);
    currentWipHold.mockResolvedValue(hold);

    expect(await currentBreaker(project)).toBe(hold);
  });

  it("shows the disarm over the hold, and never pays for the PR read to find that out", async () => {
    currentDisarm.mockResolvedValue(disarm);
    currentWipHold.mockResolvedValue(hold);

    expect(await currentBreaker(project)).toBe(disarm);
    expect(currentWipHold).not.toHaveBeenCalled();
  });
});
