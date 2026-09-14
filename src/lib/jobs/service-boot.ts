/**
 * The boot-time preflights that must clear before the runner loop starts (anton-6fo2): resolve bd,
 * assert each configured repo's beads schema, then backfill schedule types shipped since those
 * projects were registered. Lifted out of service.ts as one unit because the ORDER is load-bearing
 * — each block below says why it runs where it does.
 */
import { join } from "node:path";
import { getDb } from "../db";
import { listProjects } from "../projects";
import { backfillDefaultSchedules } from "../schedules";
import { assertRepoSchemaCurrent, preflightBd } from "../beads/bd-bin";
import { hasLocalDoltDb } from "../beads/config.mjs";
import { systemClock } from "./queue";
import type { RunnerLogger } from "./runner";

/** Fails loud on an unusable bd/beads setup; best-effort for everything a boot can survive. */
export async function bootPreflight(log: RunnerLogger): Promise<void> {
  // Preflight (anton-346): resolve bd before any job can spawn it. A server launched with a PATH
  // that can't reach bd fails loud HERE with actionable guidance, instead of booting and then
  // parking execute-epic/review-fix jobs mid-run with `spawn bd ENOENT`.
  const bin = preflightBd();

  // Schema preflight (anton-x7la review): the binary is new enough (above), but a configured repo's
  // remote-backed DB may still be on a pre-1.1 schema that bd 1.1.0 gates on open — it refuses dolt
  // push/pull until the one-clone migration runbook runs. Catch that HERE per repo so we fail loud
  // with the runbook instead of booting and parking every bd call against that repo. Repos with no
  // local Dolt DB are the bootstrap path (hydrated on first configure), not a migration target, so
  // they're skipped; assertRepoSchemaCurrent itself fails open on any signal it can't read cleanly.
  for (const project of await listProjects()) {
    if (!hasLocalDoltDb(join(project.repoPath, ".beads"))) continue;
    assertRepoSchemaCurrent(bin, project.repoPath);
  }

  // Backfill schedule types shipped since each project was registered (anton-wvcy): seeding runs
  // only at project creation and no migration adds schedule rows, so without this an upgraded
  // installation never gets a new automation at all — enabling run-health would leave unstick
  // unscheduled, piling up reports with nothing acting on them. Best-effort: a scheduling hiccup
  // must not block boot, exactly as it doesn't block project creation.
  try {
    for (const { projectId, created } of await backfillDefaultSchedules(getDb(), systemClock)) {
      log.info(`seeded missing schedules for ${projectId}: ${created.join(", ")}`);
    }
  } catch (e) {
    log.error("backfilling default schedules failed", e);
  }
}
