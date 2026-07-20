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
 * This run cannot safely proceed because it can't prove it exclusively holds the epic's live
 * run-lease (anton-jz1). Two triggers, same recovery:
 *   1. Another machine already holds a live run-lease — a Force run started elsewhere is
 *      legitimately executing the epic, and running here too would double-run it.
 *   2. THIS run can't confirm or keep its OWN lease on the shared board — its pre-work publish
 *      couldn't be pushed/pulled to arbitrate, or its refresh writes lapsed past the TTL — so
 *      another machine may now see the epic as free.
 * In every case the safe move is to yield: the runner reschedules the job after a cool-off (like a
 * quota park) to retry and re-check liveness once the other run settles / the board is reachable,
 * and does NOT count the attempt against `maxAttempts` (a foreign run may hold the lease for a long
 * time, and a transient board outage should self-heal rather than park the job for a human).
 */
export class RunAlreadyLiveError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RunAlreadyLiveError";
  }
}

/**
 * A headless `claude` run died mid-stream from a TRANSIENT/recoverable cause (anton-juar) —
 * a network drop ("Connection closed mid-response"), a truncated stream, a 5xx/overloaded reply,
 * `ECONNRESET`, or an exit that never emitted the final `result` event. Unlike a deterministic
 * failure (bad code, a rejected push, a content block), the in-session progress is worth keeping:
 * the runner can retry with `claude --resume <sessionId>` to continue from where the agent left off
 * instead of re-running the whole ticket from scratch.
 *
 * `sessionId` is Claude's own session id — captured from the `system` init event so it survives even
 * when the mid-stream death prevented the final `result` event that normally carries it. Absent when
 * the run died before init; resume is then impossible and the caller falls back to a fresh spawn.
 * `signature` is a coarse category of the transient cause so the caller can refuse to resume
 * repeatedly on the SAME failure signature (a resume that dies the same way escalates to a fresh
 * restart rather than looping). Being a RecoverableClaudeError IS the "resume-eligible" signal — the
 * driver throws it ONLY for transient causes, so a deterministic error is never resumed.
 */
export class RecoverableClaudeError extends Error {
  /** Claude's session id for `--resume`, when it was captured before the stream died. */
  readonly sessionId?: string;
  /** Coarse transient-cause category, so a caller won't resume twice on the same signature. */
  readonly signature: string;
  constructor(message: string, opts: { sessionId?: string; signature: string }) {
    super(message);
    this.name = "RecoverableClaudeError";
    this.sessionId = opts.sessionId;
    this.signature = opts.signature;
  }
}

export function isUsageLimitError(e: unknown): e is UsageLimitError {
  return e instanceof UsageLimitError || (e as { name?: string })?.name === "UsageLimitError";
}

export function isRecoverableClaudeError(e: unknown): e is RecoverableClaudeError {
  return (
    e instanceof RecoverableClaudeError ||
    (e as { name?: string })?.name === "RecoverableClaudeError"
  );
}

export function isPoisonError(e: unknown): e is PoisonError {
  return e instanceof PoisonError || (e as { name?: string })?.name === "PoisonError";
}

export function isRunAlreadyLiveError(e: unknown): e is RunAlreadyLiveError {
  return (
    e instanceof RunAlreadyLiveError || (e as { name?: string })?.name === "RunAlreadyLiveError"
  );
}
