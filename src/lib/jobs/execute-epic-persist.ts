/**
 * bd write/read durability for the execute-epic run (anton-1lix — extracted from execute-epic.ts).
 *
 * Three levels, and the choice between them is a correctness decision, not a style one: `safe` for a
 * write whose absence a reader survives, {@link mustPersist} for one the run may not proceed
 * without, {@link mustRead} for the read a guarded write is decided on.
 */
import { beads, type Bead } from "../beads/bd";
import { readCurrentClosureVersion } from "../beads/closure-cycle";
import { loadAllIssues } from "../beads/issues";
import { sleepMs } from "../retry-helpers";

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
      if (attempt < attempts) await sleepMs(PERSIST_RETRY_MS);
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
      if (attempt < attempts) await sleepMs(PERSIST_RETRY_MS);
    }
  }
  return undefined;
}

/**
 * Like {@link mustRead}, but for a caller that needs `dependencies` too — {@link beads.show} is
 * deliberately count-only (see its own docstring) and never carries them, while `bd list --json`
 * inlines them for every issue it returns. Takes the whole batch of ids in ONE `bd list --id
 * a,b,c --json` call rather than one `bd show` subprocess per id, which is both cheaper and the
 * only way to get edges without a second round trip. `--all` so a CLOSED bead (e.g. a standalone
 * board-only target closed at merge) still resolves instead of silently dropping out of the
 * result — `bd list` filters to open issues by default.
 *
 * Answers `undefined` only once bd has refused every attempt, exactly like {@link mustRead}; an id
 * bd's read genuinely has nothing for (never existed, or filtered out by something other than
 * status) simply has no entry in the returned map, which the caller must distinguish from a wholly
 * failed read.
 */
export async function mustReadWithDependencies(
  repo: string,
  ids: readonly string[],
  attempts = 3,
): Promise<Map<string, Bead> | undefined> {
  if (ids.length === 0) return new Map();
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const found = await beads.list(repo, ["--id", ids.join(","), "--all"]);
      return new Map(found.map((b) => [b.id, b]));
    } catch (e) {
      console.error(`[execute-epic] bd list (by id) read failed (attempt ${attempt}/${attempts}):`, e);
      if (attempt < attempts) await sleepMs(PERSIST_RETRY_MS);
    }
  }
  return undefined;
}

/**
 * {@link readCurrentClosureVersion}, retried like every other guarded read here. Distinguishes "bd
 * history refused every attempt" (`read: false`) from "bd history answered and this ticket has no
 * closure episode" (`read: true, closure: undefined`) — a bare `.catch(() => undefined)` folds both
 * into the same value, which a caller writing a closure fence cannot tell apart from a genuinely
 * fenceless confirmation. That matters because an unfenced `{ ids }` confirmation is treated by
 * `confirmedForThisCycle` (execute-epic-dispatch.ts) as "cannot verify, pass anyway" — the same
 * pass-through meant for a confirmation written before the fence existed — so a transient read
 * failure must not be allowed to silently produce one.
 */
export async function mustReadClosureVersion(
  repo: string,
  id: string,
  attempts = 3,
): Promise<{ read: true; closure: string | undefined } | { read: false }> {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return { read: true, closure: await readCurrentClosureVersion(repo, id) };
    } catch (e) {
      console.error(`[execute-epic] bd history read failed (attempt ${attempt}/${attempts}):`, e);
      if (attempt < attempts) await sleepMs(PERSIST_RETRY_MS);
    }
  }
  return { read: false };
}

/**
 * The FULL board, retried like {@link mustRead} — for the read a guarded write is decided on when
 * the decision needs parentage the board carries and a single bead does not (a ticket's run target
 * is its first run-target ancestor, and an intermediate reparent moves it without touching the
 * ticket's own edge). Answers `undefined` only once bd has refused every attempt, so the caller
 * escalates on a genuinely unreachable board rather than on one contended round trip.
 *
 * Through {@link loadAllIssues}, never a bare `bd list --status all` (PR #238 review). On a bd
 * variant that does not support that flag the bare form is PERMANENTLY invalid, so every retry here
 * would refuse it identically and the caller would park a run the compatibility path can serve — that
 * loader falls back to separate open and closed listings for exactly those versions. It also picks up
 * the gate listing, `strictGates` like every other job-side board read: a swallowed gate failure
 * leaves a `blocks` edge dangling, and a rejected read is the retryable failure this loop is for.
 */
export async function mustReadBoard(
  repo: string,
  attempts = 3,
): Promise<Bead[] | undefined> {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await loadAllIssues(repo, { strictGates: true });
    } catch (e) {
      console.error(`[execute-epic] bd board read failed (attempt ${attempt}/${attempts}):`, e);
      if (attempt < attempts) await sleepMs(PERSIST_RETRY_MS);
    }
  }
  return undefined;
}
