/**
 * Control-flow signals a job handler can throw to steer the runner's durability logic.
 * See DESIGN.md §4. These are the *only* way a handler asks for backoff vs. poison-pill vs.
 * plain retry — the runner never inspects error messages.
 */

/**
 * The handler hit an API/usage limit it cannot retry through. The runner PARKS the job and
 * reschedules it past `resetAt` (or a default cool-off if unknown). You cannot retry an
 * exhausted quota, so this does NOT count against `maxAttempts`.
 */
export class UsageLimitError extends Error {
  /** Unix seconds when the quota resets, if the provider told us. */
  readonly resetAt?: number;
  constructor(message: string, resetAt?: number) {
    super(message);
    this.name = "UsageLimitError";
    this.resetAt = resetAt;
  }
}

/**
 * The handler failed in a way that is permanent — do not retry, park for a human immediately
 * (skips the remaining `maxAttempts` budget).
 */
export class PoisonError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PoisonError";
  }
}

/**
 * Another machine already holds a live run-lease for this epic (anton-jz1) — a Force run started
 * elsewhere is legitimately executing it, and running here too would double-run it. This is NOT a
 * failure of THIS job, so the runner reschedules it after a cool-off (like a quota park) to retry
 * once the other run settles and clears its lease, and does NOT count the attempt against
 * `maxAttempts` (a foreign run may hold the lease for a long time; parking this job for a human
 * would be wrong).
 */
export class RunAlreadyLiveError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RunAlreadyLiveError";
  }
}

export function isUsageLimitError(e: unknown): e is UsageLimitError {
  return e instanceof UsageLimitError || (e as { name?: string })?.name === "UsageLimitError";
}

export function isPoisonError(e: unknown): e is PoisonError {
  return e instanceof PoisonError || (e as { name?: string })?.name === "PoisonError";
}

export function isRunAlreadyLiveError(e: unknown): e is RunAlreadyLiveError {
  return (
    e instanceof RunAlreadyLiveError || (e as { name?: string })?.name === "RunAlreadyLiveError"
  );
}
