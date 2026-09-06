/**
 * The per-job policy sources the runner reads at lease time (anton-6fo2): a project's
 * concurrency/timeout/retry policy, the budget governor's policy, the cross-machine run-liveness
 * gate, and the bead labels the value gate ranks on. Split out of service.ts so anton's public job
 * API doesn't carry the settings + beads fan-out these four resolvers need. Wired into the runner
 * by ./service-runner.
 */
import { getDb } from "../db";
import {
  DEFAULT_CONCURRENCY,
  DEFAULT_JOB_TIMEOUT_MINUTES,
  DEFAULT_MAX_RETRIES,
  getProjectById,
  getProjectSettings,
  resolveBudgetPolicy as resolveBudgetPolicyFromSettings,
} from "../projects";
import { beads } from "../beads/bd";
import { allIssues } from "../beads/issues";

/** Read a project's job policy from its settings, filling in defaults for any unset field. */
export async function resolvePolicy(projectId: string | undefined) {
  const settings = projectId ? await getProjectSettings(getDb(), projectId) : {};
  return {
    concurrency: settings.concurrency ?? DEFAULT_CONCURRENCY,
    timeoutMs: (settings.jobTimeoutMinutes ?? DEFAULT_JOB_TIMEOUT_MINUTES) * 60_000,
    maxAttempts: settings.maxRetries ?? DEFAULT_MAX_RETRIES,
    // Autonomy master-switch (anton-y3l): off pauses claiming of this project's execute-epic
    // jobs (they stay queued); absent defaults to on. See JobPolicy.autonomy in runner.ts.
    autonomy: settings.autonomy ?? true,
  };
}

/**
 * Per-project budget policy for the proactive governor (anton-szld), gated by the budget-aware
 * master-switch (anton-7mpv.1). Returns `null` unless the project has `budgetAware` turned ON — off is
 * the default — which the runner reads as "not governed": it never defers that project's work AND
 * never reads Claude usage on its behalf, so the nav usage pill isn't starved of the shared cache.
 * When on, it projects the operator's knobs onto the governor's full {@link BudgetPolicy}. A
 * project-less job is never budget-aware (empty settings → off).
 */
export async function resolveBudgetPolicy(projectId: string | undefined) {
  const settings = projectId ? await getProjectSettings(getDb(), projectId) : {};
  if (!settings.budgetAware) return null;
  return resolveBudgetPolicyFromSettings(settings);
}

/**
 * Cross-machine run-liveness source for the runner (anton-jz1). Reads the shared beads board to
 * tell whether an execute-epic run is already live for this epic on ANOTHER machine — the `jobs`
 * table is machine-local, so a Force run on machine B can't otherwise see a run executing on
 * machine A and would double-run it. Pulls the shared board FIRST: the local Dolt working set can
 * be a sync heartbeat (~30s) behind, so without a pull a lease machine A published moments ago
 * reads as absent and this gate lets B enqueue a second concurrent run — the exact race the lease
 * exists to close. Fails open (returns false) so a transient beads read never blocks a legitimate
 * run; the local dedupe + `jobs_active_epic_unique` still backstop same-machine.
 */
export async function liveRunCheck(projectId: string, epicBeadId: string): Promise<boolean> {
  try {
    const project = await getProjectById(getDb(), projectId);
    if (!project) return false;
    // Best-effort: a pull failure (offline, transient) falls back to the local snapshot rather
    // than blocking the check — the same fail-open posture as the surrounding try/catch.
    await beads.pull(project.repoPath).catch(() => {});
    const bead = await beads.show(project.repoPath, epicBeadId);
    return beads.isRunLive(bead, Date.now());
  } catch {
    return false;
  }
}

/**
 * Bead-label source for the runner's per-job value gate (anton-k05r): the labels of a queued
 * execute-epic job's target bead, so `jobValueScore` can rank governed work at lease time. Serves
 * off the shared issue snapshot (warm within its max-age) rather than `bd show`, so the 2s runner
 * tick never spawns bd per queued job. Returns `null` on any miss — the gate fails open on null.
 */
export async function readBeadLabels(
  projectId: string,
  beadId: string,
): Promise<readonly string[] | null> {
  try {
    const project = await getProjectById(getDb(), projectId);
    if (!project) return null;
    const bead = (await allIssues(project.repoPath)).find((b) => b.id === beadId);
    return bead?.labels ?? null;
  } catch {
    return null;
  }
}
