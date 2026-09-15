/**
 * The stale breaker's derivation (anton-mh3c): a self-freshness verdict becomes a card only when
 * anton can act on it by rebuilding — HEAD behind its own upstream, or installed packages that drift
 * from the lockfile. Every clean or INDETERMINATE verdict returns nothing, so the band never appears
 * on an offline board or a healthy one, and the remedy command is carried in the card it does make.
 */
import { describe, expect, it } from "vitest";

import { clearingCondition, staleBreaker } from "./autopilot-breaker";
import type { SelfFreshness } from "./jobs/self-freshness";

function freshness(o: Partial<SelfFreshness> = {}): SelfFreshness {
  return {
    checkout: { state: "current" },
    dependencies: { state: "match" },
    build: { state: "current" },
    schema: { state: "current" },
    ...o,
  };
}

describe("staleBreaker", () => {
  it("makes no band when anton is running its own latest code", () => {
    expect(staleBreaker(freshness())).toBeUndefined();
  });

  it("makes no band on an indeterminate verdict — an unreachable remote or unread lockfile", () => {
    // Refusing to say "stale" off a check that never answered is the same line the run-side refusal
    // draws: an offline runner is not a behind one.
    expect(
      staleBreaker(
        freshness({
          checkout: { state: "unreachable", reason: "network down" },
          dependencies: { state: "unknown", reason: "bun.lock unreadable" },
        }),
      ),
    ).toBeUndefined();
    expect(staleBreaker(freshness({ checkout: { state: "no-upstream" } }))).toBeUndefined();
  });

  it("names the checkout distance and the command that clears it", () => {
    const stale = staleBreaker(
      freshness({ checkout: { state: "behind", behind: 3, upstream: "origin/main" } }),
    );
    expect(stale?.kind).toBe("stale");
    expect(stale?.detail).toContain("3 commits behind origin/main");
    expect(stale?.evidence).toEqual(["Checkout is 3 commits behind origin/main — run `git pull`"]);
  });

  it("names the drifted packages and the command that clears them", () => {
    const stale = staleBreaker(
      freshness({ dependencies: { state: "drift", packages: ["drizzle-orm", "next"] } }),
    );
    expect(stale?.evidence).toEqual([
      "Installed packages no longer match bun.lock (drizzle-orm, next) — run `bun install`",
    ]);
    expect(stale?.detail).toContain("2 installed packages out of date");
  });

  it("names a running build the disk has moved past — the half a pull cannot fix", () => {
    // A `git pull`/`bun install` clears the checkout and dependency halves at once, but the live
    // process keeps its boot-time build until a restart; the band must stay up across that gap.
    const stale = staleBreaker(freshness({ build: { state: "drifted", drift: "outdated" } }));
    expect(stale?.kind).toBe("stale");
    expect(stale?.detail).toContain("its running build is out of date");
    expect(stale?.evidence).toEqual([
      "The code on disk has moved past the build anton is running — restart anton",
    ]);
  });

  // The `bun install` the drift half prescribes fixes node_modules and moves no build identity, so
  // without a latch on the reinstall itself the remedy would clear the band on a process still
  // importing the old packages (PR #257 review).
  it("names packages reinstalled under the running process — the half the remedy does not clear", () => {
    const stale = staleBreaker(freshness({ dependencies: { state: "replaced" } }));
    expect(stale?.kind).toBe("stale");
    expect(stale?.detail).toContain("its running packages were reinstalled");
    expect(stale?.evidence).toEqual([
      "Packages were reinstalled under the ones anton is running — restart anton to load them",
    ]);
  });

  it("makes no band when the build half could not be established", () => {
    // A read that failed is not a stale process: the runner's drift enumerates the machine's
    // sockets, and grounding the board on a check that threw is the line this module never crosses.
    expect(staleBreaker(freshness({ build: { state: "unknown", reason: "lsof missing" } }))).toBeUndefined();
  });

  // Without this, `staleCheckoutRefusal` (anton-sm1l) defers every non-`execute-epic` job the
  // instant schema goes pending while this band — the operator's only OTHER signal — stayed empty,
  // breaking "nothing renders when the checkout is clean": the checkout is not clean, work is
  // piling up in `queued`, and only each job's own `lastError` said so (PR #281 review).
  it("names the pending migrations and the command that clears them", () => {
    const stale = staleBreaker(
      freshness({ schema: { state: "pending", migrations: ["0038_add_base_fork_sha.sql"] } }),
    );
    expect(stale?.kind).toBe("stale");
    expect(stale?.detail).toContain("1 pending migration");
    expect(stale?.evidence).toEqual([
      "anton.db has pending migration (0038_add_base_fork_sha.sql) — run `bun run db:migrate`",
    ]);
  });

  // `bun run db:migrate` invokes drizzle-kit, a devDep `scripts/build-bundle.mjs` deliberately never
  // ships — a release bundle applies its migrations in-process on every `anton start` instead, so its
  // remedy is the restart the card's other halves already prescribe (PR #281 review).
  it("names a bundle-compatible remedy for pending migrations when isBundle is set", () => {
    const stale = staleBreaker(
      freshness({ schema: { state: "pending", migrations: ["0038_add_base_fork_sha.sql"] } }),
      { isBundle: true },
    );
    expect(stale?.evidence).toEqual([
      "anton.db has pending migration (0038_add_base_fork_sha.sql) — restart anton " +
        "(`anton stop` && `anton start`) to apply them",
    ]);
  });

  it("clears for every process at once — no restart to wait for, unlike the other latched halves", () => {
    const stale = staleBreaker(
      freshness({
        schema: {
          state: "pending",
          migrations: ["0038_add_base_fork_sha.sql", "0039_add_thing.sql"],
        },
      }),
    );
    expect(stale?.detail).toContain("2 pending migrations");
    expect(stale?.evidence).toEqual([
      "anton.db has pending migrations (0038_add_base_fork_sha.sql, 0039_add_thing.sql) — run " +
        "`bun run db:migrate`",
    ]);
  });

  it("carries one evidence line per stale half when both are behind", () => {
    const stale = staleBreaker(
      freshness({
        checkout: { state: "behind", behind: 1, upstream: "origin/main" },
        dependencies: { state: "drift", packages: ["zod"] },
      }),
    );
    // Singular grammar on the count-of-one halves — "1 commit", "package … matches".
    expect(stale?.evidence).toEqual([
      "Checkout is 1 commit behind origin/main — run `git pull`",
      "Installed package no longer matches bun.lock (zod) — run `bun install`",
    ]);
  });

  it("clears on an update and restart, not on a re-arm", () => {
    const stale = staleBreaker(
      freshness({ checkout: { state: "behind", behind: 1, upstream: "origin/main" } }),
    );
    expect(clearingCondition(stale!)).toBe("Update anton and restart it. Nothing starts new work until you do.");
  });
});
