/**
 * Everything a run does BEFORE it holds anything (anton-1lix — extracted from execute-epic.ts).
 *
 * One board read, the gates that read it, and the run row. Nothing here writes to the board or the
 * filesystem, which is the point: every refusal in this phase costs an operator a message and
 * nothing else — no lease to clear, no checkout to reap, no reservation to hand back.
 */
import { randomUUID } from "node:crypto";
import {
  getProjectById,
  getProjectSettings,
  resolveTicketTimeoutMs,
  type ProjectSettings,
} from "../projects";
import { claudeRouting } from "../claude/driver-routing";
import { quotaMeterKey } from "../quota-meter";
import {
  ANTHROPIC_DEFAULT_ENDPOINT_HOST,
  createRun,
  endpointHostFromBaseUrl,
  findOpenRunForEpic,
  updateRun,
} from "../runs";
import { PoisonEpic, RouteAdmissionStaleError } from "./errors";
import { resolveRunTarget } from "./execute-epic-target";
import { makeRunLease } from "./execute-epic-lease";
import { makeEpicRun, type EpicRun } from "./execute-epic-run";
import { systemClock, type AntonDb, type Clock } from "./queue";
import type { JobContext } from "./runner";

/** The payload the runner hands the `execute-epic` handler. */
export interface ExecuteEpicPayload {
  projectId: string;
  epicBeadId: string;
}

/**
 * Read the board, refuse everything that must never start, and open (or resume) the run row.
 *
 * Answers `null` — not an error — for an ABANDONED target (anton-6xj0): a human declared the work
 * won't be done, and a park would put their own decision back in front of them as a job needing
 * attention. There is no run row yet, so nothing can be mistaken for a delivery.
 */
export async function beginEpicRun(args: {
  db: AntonDb;
  clock?: Clock;
  branchPrefix?: string;
  ctx: JobContext;
}): Promise<EpicRun | null> {
  const { db, ctx } = args;
  const clock = args.clock ?? systemClock;
  const { projectId, epicBeadId } = ctx.payload as ExecuteEpicPayload;
  const project = await getProjectById(db, projectId);
  if (!project) throw new PoisonEpic(`project ${projectId} not found`);

  const repo = project.repoPath;
  const settings = await getProjectSettings(db, projectId);

  // Budget admission (the governor's per-tick `budgetGate`, narrowed by one more revalidation read
  // right before lease — see `revalidateAdmittedGovernorMeters`) ran against a settings snapshot
  // that can still be stale by the time this run takes its OWN read, closest to the point it would
  // actually hold anything (PR #269 review). Compare against the meter that snapshot admitted: a
  // mismatch means routing moved again after that last check, so the meter this run is about to
  // dispatch through never cleared `budgetGate` — refuse now rather than spend an unvalidated
  // (possibly exhausted) pool. `undefined` means this project's admission carries no meter to
  // compare against (ungoverned, or budget pacing isn't wired) — proceed as before.
  if (ctx.admittedMeterKey !== undefined) {
    const currentMeterKey = quotaMeterKey(settings);
    if (currentMeterKey !== ctx.admittedMeterKey) {
      throw new RouteAdmissionStaleError(
        `project ${projectId} routing changed from admitted meter "${ctx.admittedMeterKey}" to ` +
          `"${currentMeterKey}" before dispatch`,
      );
    }
  }

  // Everything about resolving WHAT this run executes — the board read, the runnability gates, the
  // structure/cycle and readiness re-checks, the ticket set — lives behind one module (anton-ejx2)
  // so this start path's own import surface stops growing with every board read it merely aggregates.
  const resolved = await resolveRunTarget(repo, epicBeadId);
  if (!resolved) return null;
  const { all, target, targetIsUnit, standaloneRun, tickets, userAgentIds, readiness } = resolved;
  // Branches keep the `prefix/id` slash (git convention); only the worktree *path* segment is
  // sanitized (in worktreePathFor). Bead ids are already filesystem-/ref-safe.
  const branch = `${args.branchPrefix ?? "anton"}/${epicBeadId}`;
  const { runId, existing } = await openRunRow({
    db,
    clock,
    ctx,
    projectId,
    epicBeadId,
    branch,
    // A multi-ticket run may dispatch each ticket (and each pipeline step) to a different routed
    // model. The run row has one model field, so preserve only the project's configured fallback;
    // recording a model selected from the union of all labels would falsely claim every dispatch
    // used it.
    model: settings.model,
    // Record where this run will actually drive its traffic (anton-oom5). Derived from the SAME
    // routing resolver the spawn honors (claudeRouting), not the raw base URL, so a base URL that
    // resolves unrouted (no token env) records the Claude API host it truly drives — never a
    // gateway it never reached.
    endpointHost: resolveEndpointHost(settings),
  });

  return makeEpicRun({
    db,
    clock,
    ctx,
    projectId,
    project,
    settings,
    repo,
    targetId: epicBeadId,
    branch,
    runId,
    existing,
    targetIsUnit,
    ticketTimeoutMs: resolveTicketTimeoutMs(settings),
    userAgentIds,
    // Cross-machine run-liveness lease (anton-jz1). Owns nothing until the foreign-lease gate has
    // passed, so the cleanup's clear can never take another machine's live lease. `runId` stamps the
    // owner onto every publish, so a later resume can tell this run's own crash leftover from a
    // foreign lease.
    lease: makeRunLease({ repo, targetId: epicBeadId, runId, clock }),
    all,
    target,
    standaloneRun,
    tickets,
    readiness,
  });
}

/**
 * The endpoint host this run will drive (anton-oom5) — resolved through `claudeRouting`, the same
 * decision the spawn env delta honors, so the recorded provenance is where traffic actually goes.
 * A routed project records its gateway host (never the token — {@link endpointHostFromBaseUrl}
 * keeps only `URL.host`); an unrouted one — including a base URL that resolves unrouted for want of
 * a token env — records the Claude API default.
 */
function resolveEndpointHost(settings: ProjectSettings): string {
  const routing = claudeRouting(settings);
  return routing.routed
    ? endpointHostFromBaseUrl(routing.baseUrl)
    : ANTHROPIC_DEFAULT_ENDPOINT_HOST;
}

/** Resume an open run or start a new one. */
async function openRunRow(args: {
  db: AntonDb;
  clock: Clock;
  ctx: JobContext;
  projectId: string;
  epicBeadId: string;
  branch: string;
  model: string | undefined;
  endpointHost: string;
}): Promise<{ runId: string; existing: Awaited<ReturnType<typeof findOpenRunForEpic>> }> {
  const { db, clock, ctx, projectId, epicBeadId, branch, model, endpointHost } = args;
  const existing = await findOpenRunForEpic(db, projectId, epicBeadId);
  const runId = existing?.id ?? randomUUID();
  if (!existing) {
    await createRun(db, clock, {
      id: runId,
      projectId,
      epicBeadId,
      jobId: ctx.jobId,
      branch,
      model,
      endpointHost,
      status: "running",
    });
    return { runId, existing };
  }
  // The score goes with the attempt that earned it (anton-cekf). A resume REUSES the parked row, so
  // leaving it would let a resumed attempt that never reaches review settle carrying the previous
  // attempt's number — and the score breaker, which reads one score per row, would judge this
  // attempt on a review it never had and could re-latch the disarm a human just cleared. Cleared
  // here, and rewritten by the gate the moment this attempt is reviewed. `jobId` moves with the
  // attempt (anton-rgso): a resume is a NEW job over the same row, and a cancel the operator raises
  // from here names that job, not the one that first parked. `attemptStartedAt` moves for the same
  // reason (anton-tebf): the repair weigher orders a failure against when its attempt began, and a
  // `dep-missing` repair parks the run it repaired — so a row still claiming the original start
  // would price the resumed attempt's failure as if it predated the repair.
  //
  // The interval that rewrite DISCARDS is what `run_attempts` keeps (anton-rnrdr): `updateRun` reads
  // `attemptStartedAt` as the signal that a new attempt has begun and appends a row for it, having
  // already closed the previous one when its park settled. So this column keeps its meaning and the
  // earlier intervals survive beside it — nothing here changes, which is the point.
  await updateRun(db, clock, runId, {
    status: "running",
    jobId: ctx.jobId,
    error: null,
    reviewScore: null,
    attemptStartedAt: clock.now(),
    // The resumed attempt drives the freshly resolved endpoint (anton-oom5). Rewrite the provenance
    // so a resume after the project's gateway setting changed isn't attributed to the old route.
    endpointHost,
    // `lastGateFailure` is deliberately NOT in this list (anton-vynb8). Every other value here is
    // scoped to the attempt that wrote it, which is why the resume clears them; a red gate is the
    // one thing the NEXT attempt needs to inherit, and this clear is precisely what it has to
    // survive. It is stale only when the gate goes green or the run finishes, and those two clear
    // it themselves.
  });
  return { runId, existing };
}
