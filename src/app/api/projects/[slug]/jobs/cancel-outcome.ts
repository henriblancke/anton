import type { CancelResult } from "@/lib/jobs/service";

/** Why a service-level cancel refused: the failure half of {@link CancelResult}. */
export type CancelFailureReason = Extract<CancelResult, { ok: false }>["reason"];

/**
 * Human-readable copy for each cancel refusal, shared by the single-job and batch cancel routes so
 * a refusal reads identically whichever surface the founder killed from.
 */
export const CANCEL_FAILURE_MESSAGES: Record<CancelFailureReason, string> = {
  "not-found": "Job not found",
  "not-cancellable": "Job is not cancellable (already terminal)",
};
