/**
 * bd write/read durability for the execute-epic run (anton-1lix — extracted from execute-epic.ts).
 *
 * Three levels, and the choice between them is a correctness decision, not a style one: `safe` for a
 * write whose absence a reader survives, {@link mustPersist} for one the run may not proceed
 * without, {@link mustRead} for the read a guarded write is decided on.
 */
import { beads, type Bead } from "../beads/bd";

/**
 * Swallow errors from best-effort bd side effects (already-applied labels, etc.). Reports whether
 * the write actually landed, so a caller whose write carries content that exists nowhere else can
 * fall back instead of assuming it (see {@link reviewParkMessage}).
 */
export async function safe(fn: () => Promise<unknown>): Promise<boolean> {
  try {
    await fn();
    return true;
  } catch {
    return false; // best-effort
  }
}

/** Backoff between {@link mustPersist} attempts — long enough to outlast a contended Dolt write. */
export const PERSIST_RETRY_MS = 500;

/**
 * A bd write the run is NOT allowed to proceed without, retried before it is permitted to fail.
 * Answers whether it landed, so the caller escalates instead of carrying on as if it had.
 *
 * `safe` is right for a label whose absence a reader can survive. It is wrong for the
 * `not-delivered` marker (anton-67xj): that label is merge finalization's ONLY signal that a ticket
 * is in no diff, so swallowing its failure lets the run open a PR whose merge closes never-written
 * work as shipped — silently, and against the note on the bead telling the operator to re-run it.
 *
 * Every refusal is LOGGED rather than swallowed (PR #199 review): the callers escalate to a park
 * whose message can only say "check the beads DB", so bd's own reason for refusing is what makes
 * that park actionable — and it exists nowhere else once this has returned.
 */
export async function mustPersist(fn: () => Promise<unknown>, attempts = 3): Promise<boolean> {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      await fn();
      return true;
    } catch (e) {
      console.error(`[execute-epic] bd write failed (attempt ${attempt}/${attempts}):`, e);
      if (attempt < attempts) await delayMs(PERSIST_RETRY_MS);
    }
  }
  return false;
}

/**
 * A bd read a guarded write is decided on, retried on {@link PERSIST_RETRY_MS} exactly like the
 * write itself. Answers `undefined` only once bd has refused it every time, so the caller escalates
 * on a board that is genuinely unreachable rather than on one contended round trip.
 *
 * `beads.show(...).catch(() => undefined)` is right where "unreadable" is evidence of nothing and
 * the caller simply does less. It is wrong ahead of a write whose correctness depends on WHOSE the
 * bead still is (see {@link LABELS.notDelivered} in the skip path): there, a silent undefined turns
 * a compare-and-swap into an unconditional write.
 */
export async function mustRead(
  repo: string,
  id: string,
  attempts = 3,
): Promise<Bead | undefined> {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await beads.show(repo, id);
    } catch (e) {
      console.error(`[execute-epic] bd read failed (attempt ${attempt}/${attempts}):`, e);
      if (attempt < attempts) await delayMs(PERSIST_RETRY_MS);
    }
  }
  return undefined;
}

const delayMs = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    if (typeof t.unref === "function") t.unref();
  });
