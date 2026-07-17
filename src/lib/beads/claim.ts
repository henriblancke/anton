/**
 * Compare-and-swap for a run target's assignee — the write half of the human-claim soft-lock.
 *
 * bd offers no conditional assignee write: `bd assign` is shorthand for an unconditional
 * `bd update --assignee`, and the one atomic primitive (`bd update --claim`) also flips status to
 * in_progress, which a human claim must never do (it would read as a run in flight). So a
 * read-then-`assign` pair in a route is a lost-update race: two operators can both pass the owner
 * check against the same pre-write snapshot and the later write silently stomps the earlier claim,
 * with both requests returning 200.
 *
 * The guard is therefore built here, in two layers:
 *   1. Writes for one bead are serialized in this process, and the expected owner is re-read
 *      INSIDE that lock — so concurrent requests to this anton server (the case the soft-lock
 *      exists for: two operators clicking Claim) are ordered, and the loser sees the winner.
 *   2. The assignee is re-read after the write and verified, so a write another bd client had
 *      already landed is caught rather than reported as our success.
 *
 * What this does NOT do: make the swap atomic across processes. Layer 1 only orders writes it
 * shares a Map with, and layer 2 verifies the assignee as of its own read — so two anton servers
 * (or a teammate's `bd` CLI) can still interleave read→assign→verify and both return `{ ok: true }`,
 * with the later write winning. bd exposes no conditional assignee write to close this: `bd assign`
 * is unconditional, and the one atomic primitive (`bd update --claim`) also flips status to
 * in_progress, which a human claim must never do. That residual window is why a claim is specified
 * as ADVISORY, not a hard lock (DESIGN.md §Soft-lock) — it narrows the race that a single anton
 * server can actually order, and approval (the act with consequences) re-settles ownership under
 * this same guard before it enqueues. A cross-process hard lock needs a new bd primitive: anton-od4.
 *
 * A bare swap settles ownership only for the instant of its own write, which isn't enough for
 * either route: approve must still own the target through the `approved` label (that label is what
 * locks the reservation), and claim must still see it unapproved through its write (or it steals a
 * reservation approval just locked). So the lock is exposed as `withClaimLock`, which runs a whole
 * read-decide-write sequence on the bead's chain; `setAssigneeIfOwner` is the one-shot swap built
 * on it.
 */
import { beads, type Bead } from "./bd";

/** The outcome of a swap: `ok` when the assignee is now `next`, else the owner that beat us. */
export type SwapResult = { ok: true } | { ok: false; owner: string | undefined };

/** The bd surface a swap needs, injectable so tests can drive it without a real board. */
export interface AssigneeStore {
  show: (cwd: string, id: string) => Promise<Bead>;
  assign: (cwd: string, id: string, actor: string) => Promise<unknown>;
  unassign: (cwd: string, id: string) => Promise<unknown>;
}

/** A bead's claim holder, normalized — blank/whitespace assignee means unclaimed. */
export const ownerOf = (b: Bead | undefined): string | undefined => b?.assignee?.trim() || undefined;

/**
 * The 409 body for a swap that lost the race, so claim and approve report a stolen window the
 * same way. `owner` is who holds the claim now — undefined when it was released mid-flight.
 */
export function conflictBody(id: string, owner: string | undefined): { error: string; owner?: string } {
  return owner
    ? { error: `${id} was claimed by ${owner} while this request was in flight — reload and retry`, owner }
    : { error: `${id}'s claim changed while this request was in flight — reload and retry` };
}

/** The CAS handed to a `withClaimLock` body: the swap, minus the lock the body already holds. */
export type LockedSwap = (
  expectedOwner: string | undefined,
  next: string | undefined,
) => Promise<SwapResult>;

/** A claim guard bound to one bd surface: the per-bead lock, plus the one-shot swap built on it. */
export interface ClaimGuard {
  /**
   * Run `fn` holding `id`'s claim-write lock, so a whole read-decide-write sequence is serialized
   * against every other claim write to that bead in this process. `fn` gets a CAS bound to the
   * bead — it must swap through that rather than calling `setAssigneeIfOwner`, which would wait on
   * the very lock `fn` is holding and deadlock.
   */
  withClaimLock<T>(repoPath: string, id: string, fn: (swap: LockedSwap) => Promise<T>): Promise<T>;
  /** Set `id`'s assignee to `next` (undefined releases it) only if it still reads as `expectedOwner`. */
  setAssigneeIfOwner(
    repoPath: string,
    id: string,
    expectedOwner: string | undefined,
    next: string | undefined,
  ): Promise<SwapResult>;
}

/**
 * Build a claim guard bound to a bd surface. Exported for testing; production callers use the
 * module's default instance, whose in-process lock only serializes work it shares a Map with.
 */
export function createClaimGuard(store: AssigneeStore = beads): ClaimGuard {
  // Per repo+bead write chain. Keyed so unrelated beads never wait on each other; entries are
  // dropped once their chain drains, so this can't grow with the board. The separator is NUL —
  // it can't occur in a path or a bead id, so no pair of distinct beads can collide on one key.
  const chains = new Map<string, Promise<unknown>>();

  const swapUnlocked =
    (repoPath: string, id: string): LockedSwap =>
    async (expectedOwner, next) => {
      // Re-read inside the lock: `expectedOwner` came from a snapshot the caller took before its
      // gates ran, and a claim landing in that window must lose here rather than be overwritten.
      const before = ownerOf(await store.show(repoPath, id));
      if (before !== expectedOwner) return { ok: false, owner: before };
      // Already where we want it (re-claiming your own, releasing an unclaimed target) — writing
      // would be a no-op, so skip bd entirely and stay idempotent.
      if (before === next) return { ok: true };

      if (next) await store.assign(repoPath, id, next);
      else await store.unassign(repoPath, id);

      const after = ownerOf(await store.show(repoPath, id));
      return after === next ? { ok: true } : { ok: false, owner: after };
    };

  function withClaimLock<T>(
    repoPath: string,
    id: string,
    fn: (swap: LockedSwap) => Promise<T>,
  ): Promise<T> {
    const key = `${repoPath}\u0000${id}`;
    const prev = chains.get(key) ?? Promise.resolve();
    const run = prev.catch(() => {}).then(() => fn(swapUnlocked(repoPath, id)));
    chains.set(key, run);
    void run
      .catch(() => {}) // the caller owns this run's rejection; this chain is bookkeeping only
      .finally(() => {
        if (chains.get(key) === run) chains.delete(key);
      });
    return run;
  }

  return {
    withClaimLock,
    setAssigneeIfOwner: (repoPath, id, expectedOwner, next) =>
      withClaimLock(repoPath, id, (swap) => swap(expectedOwner, next)),
  };
}

/**
 * The process-wide claim guard. Claim and approve both go through THIS instance — a per-module
 * guard would let them race each other, which is exactly the approve-vs-claim window the soft-lock
 * has to cover.
 *
 * Anchored on globalThis via Symbol.for for the same cross-bundle reason as bd.ts's sync
 * singletons: the /claim and /approve route handlers can load DIFFERENT compiled instances of this
 * module, and two guards with separate `chains` maps serialize nothing against each other.
 */
const CLAIM_GUARD_KEY = Symbol.for("anton.beads.claimGuard");
export const claimGuard = ((globalThis as unknown as Record<symbol, ClaimGuard>)[
  CLAIM_GUARD_KEY
] ??= createClaimGuard());

/** Run `fn` under `id`'s claim-write lock. See {@link ClaimGuard.withClaimLock}. */
export const withClaimLock: ClaimGuard["withClaimLock"] = (repoPath, id, fn) =>
  claimGuard.withClaimLock(repoPath, id, fn);

/** Set `id`'s assignee to `next` (undefined releases it) only if it still reads as `expectedOwner`. */
export const setAssigneeIfOwner: ClaimGuard["setAssigneeIfOwner"] = (
  repoPath,
  id,
  expectedOwner,
  next,
) => claimGuard.setAssigneeIfOwner(repoPath, id, expectedOwner, next);
