/**
 * `step:describe` — writes the run's PR narrative from its committed diff, in the one slot where the
 * diff exists and the PR has not opened yet (anton-xl51z registers the step and its slot between
 * `step:commit` and `step:pr`; dispatching a describer agent is a sibling ticket).
 *
 * Until that ticket lands this is a deliberate no-op: it reports success with no narrative, so a
 * formula naming this step today sees nothing change.
 */
import type { StepContext } from "./context";
import type { StepResult } from "./result";

export async function describeStep(ctx: StepContext): Promise<StepResult> {
  void ctx; // unused until the describer dispatch (sibling ticket) reads the run's diff from it
  return { ok: true, detail: "no describer wired yet" };
}
