/**
 * The precedence between the two brakes (anton-wy9y / R4.1). One band, two things that can be true
 * at once — and getting the order wrong tells an operator "nothing for you to do" about a policy
 * that is frozen until they act.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AutopilotDisarm, AutopilotHold } from "./autopilot-breaker";
import type { Project } from "./types";

const currentDisarm = vi.hoisted(() => vi.fn());
const currentWipHold = vi.hoisted(() => vi.fn());
vi.mock("./autopilot-disarm", () => ({ currentDisarm }));
vi.mock("./jobs/picker-wip-hold", () => ({ currentWipHold }));

const { currentBreaker } = await import("./autopilot-state");

const project = { id: "p1", slug: "p1", name: "P1", repoPath: "/repo" } as Project;

const disarm: AutopilotDisarm = {
  kind: "disarm",
  reason: "score-regression",
  detail: "3 consecutive runs scored below 7/10",
  evidence: [],
};
const hold: AutopilotHold = { kind: "hold", reason: "wip-limit", detail: "3 open PRs" };

afterEach(() => vi.clearAllMocks());

describe("currentBreaker", () => {
  it("shows nothing while the autopilot is running", async () => {
    currentDisarm.mockResolvedValue(undefined);
    currentWipHold.mockResolvedValue(undefined);

    expect(await currentBreaker(project)).toBeUndefined();
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
