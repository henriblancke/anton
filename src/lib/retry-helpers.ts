/**
 * The two helpers every retry loop in the board's write path leans on — the beads claim, the
 * gardener's publish, and the picker's approve-and-claim all pause between attempts and report the
 * attempt that failed. One definition, so their contracts cannot drift apart per module (anton-dsgq).
 *
 * Lives at `src/lib` rather than under `beads/` so the jobs layer does not pick up a dependency on
 * bd's package for a sleep.
 */

/**
 * Resolve after `ms`. The timer is unref'd so a pending pause never holds the process open — a
 * retry loop that outlives its caller must not keep anton alive on its own.
 */
export const sleepMs = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    if (typeof t.unref === "function") t.unref();
  });

/** The error's message when it is an `Error`, otherwise its string form. */
export function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
