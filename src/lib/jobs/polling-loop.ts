/**
 * The polling-loop lifecycle shared by JobRunner and Scheduler (anton-vc5). Both are the same
 * background loop: an idempotent `running` guard so a second start() doesn't double-schedule, a
 * re-entrancy `ticking` flag so a slow tick never overlaps the next, a try/catch/finally around the
 * tick so one throw can't wedge the loop, and a `setTimeout` re-arm on `tickMs`. Each caller keeps
 * its own tick body, log message, and interval; only this scaffold is shared.
 *
 * Stop semantics deliberately stay with the caller — the runner aborts in-flight jobs and waits out
 * a grace window, the scheduler just clears the timer — so this helper owns only the timer/flags and
 * exposes stop() to tear the loop down without draining.
 */
export interface PollingLoopDeps {
  /** Poll interval between ticks, in ms. */
  tickMs: number;
  /** One iteration of work. Runs at most once at a time (guarded by the re-entrancy flag). */
  tick: () => Promise<void>;
  /** Called with whatever a tick throws so the caller can log it in its own voice. */
  onError: (e: unknown) => void;
}

export class PollingLoop {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private ticking = false;

  constructor(private readonly deps: PollingLoopDeps) {}

  /**
   * Start the loop. Idempotent: a call while already running is a no-op and returns false, so a
   * caller only logs "started" (and only starts) on the transition. Returns true when this call
   * actually started the loop.
   */
  start(): boolean {
    if (this.running) return false;
    this.running = true;
    const loop = async () => {
      if (!this.running) return;
      if (!this.ticking) {
        this.ticking = true;
        try {
          await this.deps.tick();
        } catch (e) {
          this.deps.onError(e);
        } finally {
          this.ticking = false;
        }
      }
      if (this.running) this.timer = setTimeout(loop, this.deps.tickMs);
    };
    this.timer = setTimeout(loop, 0);
    return true;
  }

  /**
   * Stop re-arming and clear any pending timer. Does not wait for an in-flight tick to finish —
   * callers that need to drain (the runner) do so themselves after calling this.
   */
  stop(): void {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
}
