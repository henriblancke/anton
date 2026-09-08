/**
 * What has stopped the autopilot, as one answer (anton-wy9y / R4.1).
 *
 * Several brakes can be on at once — a stale process, a disarmed project, a full review queue — and
 * the lane header shows exactly one band. This module owns that precedence, so a surface never has
 * to decide it:
 *
 *   1. STALE wins. It is machine-wide (anton-mh3c): a process behind its own code refuses to START
 *      any run across every project, so nothing a per-project disarm or hold clears would let work
 *      start while it stands. It is also the one an operator can act on in seconds (update, restart).
 *   2. DISARM over hold, because a disarm needs a human and a hold does not. Leading with a hold
 *      would tell an operator "nothing for you to do" about a policy frozen until they act.
 */
import { currentDisarm } from "./autopilot-disarm";
import { currentWipHold } from "./jobs/picker-wip-hold";
import { checkSelfFreshness, selfRepoRoot } from "./jobs/self-freshness";
import { staleBreaker, type AutopilotBreaker } from "./autopilot-breaker";
import type { Project } from "./types";

/** The band to show, or undefined when the autopilot is running. */
export async function currentBreaker(project: Project): Promise<AutopilotBreaker | undefined> {
  // Read against anton's OWN root, not the project checkout: the staleness is about the process, and
  // it is identical for every project. The freshness read fetches one upstream ref — a network read
  // in the same class as the hold's `gh` calls below, and it degrades to no band on any indeterminate
  // verdict, so an offline board never shows a false stale stop.
  const stale = staleBreaker(await checkSelfFreshness(selfRepoRoot()));
  if (stale) return stale;
  // Sequential on purpose: a disarmed project needs no PR read to explain itself, and the hold's
  // read is the only one here that can spawn `gh`.
  return (await currentDisarm(project.id)) ?? (await currentWipHold(project));
}
