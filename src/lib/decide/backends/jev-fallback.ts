/**
 * Opt-in safety net for the jev backend (anton-p32iy): turning Jev on must never make a decision
 * answer-less that claude-local alone would have answered, and a backend that keeps failing has to
 * say so somewhere an operator can see it.
 *
 * {@link createJevFallbackCaller} wraps a jev {@link ModelCaller} and a claude-local one into a
 * single caller decide() can be handed: every call still tries jev first (a recovered backend is
 * noticed on the very next decision — nothing here skips it once unhealthy), and ONLY on failure
 * does it retry the same point/state against claude-local. decide() itself never sees the jev
 * failure; from its side the call simply answered, via whichever backend actually did.
 *
 * Health is tracked in the closure, not persisted: the decisions log (decide/log.ts) can only ever
 * record the ONE backend that answered a given row, so a jev failure that fell back to claude-local
 * leaves no durable trace to recover health from after the fact. In-memory is the honest tradeoff —
 * it resets on restart, which matches a single local process with no distributed state to reconcile.
 */
import type { ModelAnswer, ModelCaller } from "../index";

export type JevHealthStatus = "healthy" | "unhealthy";

export interface JevHealth {
  status: JevHealthStatus;
  /** Jev failures in a row, right up to now — reset to 0 the moment jev answers again. */
  consecutiveFailures: number;
  lastError?: string;
  lastFailureAt?: number;
  lastSuccessAt?: number;
}

/**
 * Consecutive jev failures before Settings reads the backend as unhealthy. Three, not one: a single
 * timeout is the kind of blip the per-call fallback already absorbs silently, and flipping to
 * "unhealthy" on the first one would make the status flicker on ordinary network jitter rather than
 * on an actually broken backend.
 */
export const JEV_UNHEALTHY_THRESHOLD = 3;

function initialHealth(): JevHealth {
  return { status: "healthy", consecutiveFailures: 0 };
}

export interface JevFallbackCaller {
  ask: ModelCaller;
  /** A snapshot, not a live reference — a caller cannot mutate tracked state through it. */
  health(): JevHealth;
}

/**
 * Builds the composite caller. `threshold`/`clock` are overridable for the unit test, not for
 * production tuning — out of scope to expose either as a project setting.
 */
export function createJevFallbackCaller(
  jev: ModelCaller,
  claudeLocal: ModelCaller,
  opts: { threshold?: number; clock?: () => number } = {},
): JevFallbackCaller {
  const threshold = opts.threshold ?? JEV_UNHEALTHY_THRESHOLD;
  const clock = opts.clock ?? Date.now;
  const health = initialHealth();

  const ask: ModelCaller = async (point, state): Promise<ModelAnswer> => {
    try {
      const answer = await jev(point, state);
      health.status = "healthy";
      health.consecutiveFailures = 0;
      health.lastSuccessAt = clock();
      return answer;
    } catch (error) {
      health.consecutiveFailures += 1;
      health.lastError = error instanceof Error ? error.message : String(error);
      health.lastFailureAt = clock();
      if (health.consecutiveFailures >= threshold) health.status = "unhealthy";
      // Same point, same (unnarrowed) state — claude-local narrows it again on its own terms, the
      // same as it would for a point that never had jev in front of it.
      return claudeLocal(point, state);
    }
  };

  return { ask, health: () => ({ ...health }) };
}
