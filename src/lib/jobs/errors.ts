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

export function isUsageLimitError(e: unknown): e is UsageLimitError {
  return e instanceof UsageLimitError || (e as { name?: string })?.name === "UsageLimitError";
}

export function isPoisonError(e: unknown): e is PoisonError {
  return e instanceof PoisonError || (e as { name?: string })?.name === "PoisonError";
}
