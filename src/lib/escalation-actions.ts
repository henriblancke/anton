/**
 * The two answers a founder can give an escalation (anton-wvcy): retry the work, or call it won't-do.
 *
 * Both settle the escalation FIRST, with the status CAS in `settleEscalation` as the lock: whoever
 * flips `open → resolved` owns the decision, so a double-click (or two operators on one board)
 * cannot resume the same epic twice or abandon a bead that is already closing. The action then runs.
 * If it fails, the escalation is already resolved but the stall is not — which is recoverable rather
 * than silent: the finding is still in the next run-health report, so the next unstick pass raises a
 * fresh escalation for it.
 *
 * The verbs themselves are reused, never re-implemented: resume shares `resumeEpic` with the
 * automatic path, and abandon is the same `abandonTicket` the board's own abandon uses (kill the
 * live run, cascade to open descendants, close with a reason).
 */
import { getDb } from "./db";
import { abandonTicket } from "./abandon";
import { getEscalation, settleEscalation, toEscalationView } from "./escalations";
import { resumeStalledEpic } from "./jobs/service";
import { systemClock } from "./jobs/queue";
import { MAX_ABANDON_REASON_CHARS } from "./types";
import type { EscalationView } from "./escalations";
import type { Project } from "./types";

export type EscalationAction = "resume" | "abandon";

export function isEscalationAction(value: unknown): value is EscalationAction {
  return value === "resume" || value === "abandon";
}

/**
 * Why an action couldn't run:
 *   • `not-found`  — no such escalation in this project (404).
 *   • `not-open`   — someone already settled it (409).
 *   • `no-target`  — the finding names no bead/epic, so there is nothing to resume or abandon (409).
 */
export type EscalationActionFailure = "not-found" | "not-open" | "no-target";

export type EscalationActionResult =
  | { ok: true; action: EscalationAction; escalation: EscalationView; detail: string }
  | { ok: false; reason: EscalationActionFailure };

/** The abandon reason recorded on the bead — the escalation's own evidence, capped to bd's limit. */
function abandonReason(escalation: EscalationView): string {
  const reason = `Abandoned from a run-health escalation (${escalation.kind}): ${escalation.reason}`;
  return reason.slice(0, MAX_ABANDON_REASON_CHARS);
}

/**
 * Apply a founder's decision to one escalation. Project-scoped so a route can't settle another
 * project's item by id.
 */
export async function actOnEscalation(
  project: Project,
  escalationId: string,
  action: EscalationAction,
): Promise<EscalationActionResult> {
  const db = getDb();
  const row = await getEscalation(db, project.id, escalationId);
  if (!row) return { ok: false, reason: "not-found" };
  if (row.status !== "open") return { ok: false, reason: "not-open" };

  const view = toEscalationView(row);
  const target = action === "resume" ? view.epicBeadId : view.beadId;
  if (!target) return { ok: false, reason: "no-target" };

  // Claim the decision before acting — see the module note: the CAS is the lock.
  if (!(await settleEscalation(db, systemClock, escalationId, resolutionOf(action)))) {
    return { ok: false, reason: "not-open" };
  }

  if (action === "resume") {
    const outcome = await resumeStalledEpic(project.id, target);
    return { ok: true, action, escalation: view, detail: outcome };
  }

  await abandonTicket(project, target, abandonReason(view));
  return { ok: true, action, escalation: view, detail: "abandoned" };
}

function resolutionOf(action: EscalationAction): "resumed" | "abandoned" {
  return action === "resume" ? "resumed" : "abandoned";
}
