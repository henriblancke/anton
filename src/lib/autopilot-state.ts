/**
 * What has stopped the autopilot, as one answer (anton-wy9y / R4.1).
 *
 * Two brakes can be on at once — a project can be disarmed AND at its review limit — and the lane
 * header shows exactly one band. This module owns that precedence, so a surface never has to decide
 * it: the DISARM wins, because it is the one that needs a human. Leading with a hold there would
 * tell an operator "nothing for you to do" about a policy that is frozen until they act.
 */
import { currentDisarm } from "./autopilot-disarm";
import { currentWipHold } from "./jobs/picker-wip-hold";
import type { AutopilotBreaker } from "./autopilot-breaker";
import type { Project } from "./types";

/** The band to show, or undefined when the autopilot is running. */
export async function currentBreaker(project: Project): Promise<AutopilotBreaker | undefined> {
  // Sequential on purpose: a disarmed project needs no PR read to explain itself, and the hold's
  // read is the only one here that can spawn `gh`.
  return (await currentDisarm(project.id)) ?? (await currentWipHold(project));
}
