import { afterEach, describe, expect, it } from "vitest";
import { withBeadWriteLock, withBeadWriteLocks } from "./claim-lock";

/**
 * The lock's chain map, read the way the module anchors it — on globalThis under a `Symbol.for` key.
 * Reaching for it is the only way to assert the bookkeeping half of the contract (an entry exists
 * while a chain is in flight, and is gone once it drains), which is what keeps the map from growing
 * with the board.
 */
const chains = (): Map<string, Promise<unknown>> =>
  (globalThis as unknown as Record<symbol, Map<string, Promise<unknown>>>)[
    Symbol.for("anton.beads.claimChains")
  ] ?? new Map();

const chainKeys = (repoPath: string) =>
  [...chains().keys()].filter((key) => key.startsWith(`${repoPath}\0`));

/** A fresh repo path per case: the chain map is process-wide, so keys are what isolates the tests. */
let repos = 0;
const repo = () => `/tmp/claim-lock-${++repos}`;

interface Deferred {
  promise: Promise<void>;
  resolve: () => void;
}

function defer(): Deferred {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/** Drain the microtask queue, so "did the next write start?" is answered after everything that could. */
const settle = () => new Promise((r) => setTimeout(r, 0));

/** Fail fast rather than hanging the suite for the whole test timeout when a lock never releases. */
function noDeadlock<T>(work: Promise<T>): Promise<T> {
  return Promise.race([
    work,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("deadlocked: the lock was never released")), 2_000),
    ),
  ]);
}

afterEach(() => chains().clear());

describe("withBeadWriteLock", () => {
  it("serializes two concurrent writes to the same repo+bead", async () => {
    const path = repo();
    const held = defer();
    const log: string[] = [];

    const first = withBeadWriteLock(path, "bd-1", async () => {
      log.push("first:start");
      await held.promise;
      log.push("first:end");
      return "first";
    });
    const second = withBeadWriteLock(path, "bd-1", async () => {
      log.push("second:start");
      return "second";
    });

    // The whole point: the second body must not have run a single statement yet.
    await settle();
    expect(log).toEqual(["first:start"]);

    held.resolve();
    await expect(noDeadlock(first)).resolves.toBe("first");
    await expect(noDeadlock(second)).resolves.toBe("second");
    expect(log).toEqual(["first:start", "first:end", "second:start"]);
  });

  it("runs writes to different beads without waiting on each other", async () => {
    const path = repo();
    const held = defer();

    const blocked = withBeadWriteLock(path, "bd-1", () => held.promise.then(() => "blocked"));
    // Completes while bd-1's chain is still held — unrelated beads never queue behind each other.
    await expect(noDeadlock(withBeadWriteLock(path, "bd-2", async () => "free"))).resolves.toBe(
      "free",
    );

    held.resolve();
    await expect(noDeadlock(blocked)).resolves.toBe("blocked");
  });

  it("scopes the lock to the repo: the same bead id in another checkout is a separate chain", async () => {
    const held = defer();
    const one = repo();
    const other = repo();

    const blocked = withBeadWriteLock(one, "bd-1", () => held.promise.then(() => "one"));
    await expect(noDeadlock(withBeadWriteLock(other, "bd-1", async () => "other"))).resolves.toBe(
      "other",
    );

    held.resolve();
    await expect(noDeadlock(blocked)).resolves.toBe("one");
  });

  it("keys on repo + bead with a NUL separator, which no path or bead id can contain", async () => {
    const path = repo();
    const held = defer();
    const run = withBeadWriteLock(path, "bd-1", () => held.promise);

    expect(chainKeys(path)).toEqual([`${path}\0bd-1`]);

    held.resolve();
    await noDeadlock(run);
  });

  it("releases the lock when fn rejects, and reports the rejection to its caller", async () => {
    const path = repo();

    await expect(
      withBeadWriteLock(path, "bd-1", async () => {
        throw new Error("write failed");
      }),
    ).rejects.toThrow("write failed");

    await expect(noDeadlock(withBeadWriteLock(path, "bd-1", async () => "after"))).resolves.toBe(
      "after",
    );
  });

  it("runs a write already queued behind one that rejects", async () => {
    const path = repo();
    const held = defer();

    const failing = withBeadWriteLock(path, "bd-1", async () => {
      await held.promise;
      throw new Error("write failed");
    });
    const queued = withBeadWriteLock(path, "bd-1", async () => "queued");

    held.resolve();
    await expect(failing).rejects.toThrow("write failed");
    await expect(noDeadlock(queued)).resolves.toBe("queued");
  });

  it("drops the chain entry once it drains — settled and rejected alike", async () => {
    const path = repo();
    const held = defer();

    const run = withBeadWriteLock(path, "bd-1", () => held.promise);
    expect(chainKeys(path)).toHaveLength(1);
    held.resolve();
    await noDeadlock(run);
    await settle();
    expect(chainKeys(path)).toEqual([]);

    await expect(
      withBeadWriteLock(path, "bd-1", async () => {
        throw new Error("write failed");
      }),
    ).rejects.toThrow("write failed");
    await settle();
    expect(chainKeys(path)).toEqual([]);
  });

  it("keeps the chain entry while a later write still holds it", async () => {
    const path = repo();
    const first = defer();
    const second = defer();

    const running = withBeadWriteLock(path, "bd-1", () => first.promise);
    const waiting = withBeadWriteLock(path, "bd-1", () => second.promise);

    first.resolve();
    await noDeadlock(running);
    await settle();
    // The drained run must not delete a key the queued run now owns, or the next write serializes
    // against nothing.
    expect(chainKeys(path)).toEqual([`${path}\0bd-1`]);

    second.resolve();
    await noDeadlock(waiting);
    await settle();
    expect(chainKeys(path)).toEqual([]);
  });
});

describe("withBeadWriteLocks", () => {
  it("holds every id for the duration of fn", async () => {
    const path = repo();
    const entered = defer();
    const held = defer();
    const started: string[] = [];

    const multi = withBeadWriteLocks(path, ["bd-1", "bd-2"], async () => {
      entered.resolve();
      await held.promise;
    });
    // The ids are taken one at a time, so the guarantee only holds once fn itself is running: by
    // then every lock in the set is acquired.
    await entered.promise;
    await settle();

    const one = withBeadWriteLock(path, "bd-1", async () => void started.push("bd-1"));
    const two = withBeadWriteLock(path, "bd-2", async () => void started.push("bd-2"));

    await settle();
    expect(started).toEqual([]);

    held.resolve();
    await noDeadlock(Promise.all([multi, one, two]));
    expect(started.sort()).toEqual(["bd-1", "bd-2"]);
  });

  it("dedupes ids, so a repeated id does not wait on the lock this call already holds", async () => {
    const path = repo();
    await expect(
      noDeadlock(withBeadWriteLocks(path, ["bd-1", "bd-1"], async () => "ok")),
    ).resolves.toBe("ok");
  });

  it("takes overlapping sets in sorted order, so two callers cannot hold each other's ids", async () => {
    const path = repo();
    const log: string[] = [];

    // Reversed input orders: without the sort these acquire bd-1/bd-2 in opposite sequences and
    // each ends up waiting on the id the other holds.
    const ascending = withBeadWriteLocks(path, ["bd-1", "bd-2"], async () => {
      await settle();
      log.push("ascending");
    });
    const descending = withBeadWriteLocks(path, ["bd-2", "bd-1"], async () => {
      await settle();
      log.push("descending");
    });

    await noDeadlock(Promise.all([ascending, descending]));
    expect(log).toEqual(["ascending", "descending"]);
  });

  it("releases every id when fn rejects", async () => {
    const path = repo();

    await expect(
      withBeadWriteLocks(path, ["bd-1", "bd-2"], async () => {
        throw new Error("write failed");
      }),
    ).rejects.toThrow("write failed");

    await expect(
      noDeadlock(withBeadWriteLocks(path, ["bd-1", "bd-2"], async () => "after")),
    ).resolves.toBe("after");
    await settle();
    expect(chainKeys(path)).toEqual([]);
  });
});
