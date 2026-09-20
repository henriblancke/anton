/**
 * Shared best-effort wrapper for job-layer bd side effects (anton-uumc — hoisted out of
 * execute-epic-persist.ts, review-fix-board.ts and orphan-grooming.ts, which had each grown their
 * own copy).
 */

/**
 * Swallow errors from a best-effort side effect (already-applied labels, etc.). Reports whether
 * `fn` actually completed, so a caller whose write carries content that exists nowhere else can
 * fall back instead of assuming it landed.
 */
export async function safe(fn: () => Promise<unknown>): Promise<boolean> {
  try {
    await fn();
    return true;
  } catch {
    return false; // best-effort
  }
}
