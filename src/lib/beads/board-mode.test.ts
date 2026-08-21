/**
 * Board-mode detection and the sync behaviour that hangs off it (anton-4gd2, anton-0tul). The
 * other consumer — the per-project scoping of a bd spawn's environment — is covered by
 * `bd-env.test.ts`; this file owns only what metadata.json is read to say.
 *
 * The embedded-mode assertions are not padding: every change here is gated on mode precisely so
 * that a board WITHOUT a shared server keeps its existing sync behaviour, and these are what hold
 * that line.
 */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PREFLIGHT_TTL_MS, createDoltSync, getSyncStatus, resetServerPreflight, runDoltSync } from "./bd";
import { isServerMode, pinBoardMode, readBoardMode, resetBoardModeCache } from "./board-mode";
import { BOARD_READ_PROBE } from "./config.mjs";

/** Mirrors bd.ts's internal BdExec seam; kept local so the test does not widen that module's API. */
type TestExec = (cwd: string, args: string[]) => Promise<string>;

const dirs: string[] = [];

function repo(metadata: Record<string, unknown> | null): string {
  const dir = mkdtempSync(join(tmpdir(), "board-mode-"));
  dirs.push(dir);
  if (metadata) {
    mkdirSync(join(dir, ".beads"), { recursive: true });
    writeFileSync(join(dir, ".beads", "metadata.json"), JSON.stringify(metadata));
  }
  resetBoardModeCache();
  return dir;
}

afterEach(() => {
  resetBoardModeCache();
  // The preflight registry is globalThis-anchored, so it outlives this file's module instance.
  // Cleared here so one test's successful preflight can never satisfy another's.
  resetServerPreflight();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("readBoardMode", () => {
  it("reads server mode and its connection details from metadata.json", () => {
    const dir = repo({
      dolt_mode: "server",
      dolt_server_host: "dolt.example.dev",
      dolt_server_port: 3306,
      dolt_server_user: "anton",
      dolt_database: "anton",
    });
    expect(readBoardMode(dir)).toEqual({
      mode: "server",
      host: "dolt.example.dev",
      port: 3306,
      database: "anton",
      user: "anton",
    });
  });

  it("reports embedded for an explicitly embedded board", () => {
    expect(readBoardMode(repo({ dolt_mode: "embedded" })).mode).toBe("embedded");
  });

  // Degrading to "embedded" is the safe direction: embedded syncs, and a spurious sync is noise,
  // whereas a wrong "server" verdict would silently disable a solo board's only propagation path.
  it.each([
    ["no .beads directory at all", null],
    ["metadata without dolt_mode", { database: "dolt" } as Record<string, unknown>],
    ["an unrecognised mode", { dolt_mode: "sideways" } as Record<string, unknown>],
  ])("falls back to embedded given %s", (_label, meta) => {
    expect(readBoardMode(repo(meta)).mode).toBe("embedded");
  });

  // The cache may not outlive the file it caches: these fields choose a bd spawn's password and its
  // transport, so an operator correcting a wrong user/host/TLS in metadata.json must not need a
  // restart nobody documented to be believed (PR #174 review).
  it("picks up an edited metadata.json on the next read", () => {
    const dir = repo({ dolt_mode: "embedded" });
    expect(readBoardMode(dir).mode).toBe("embedded");

    writeFileSync(
      join(dir, ".beads", "metadata.json"),
      JSON.stringify({ dolt_mode: "server", dolt_server_host: "fixed.example.dev", dolt_server_user: "anton", dolt_server_tls: true }),
    );

    expect(readBoardMode(dir)).toMatchObject({ mode: "server", host: "fixed.example.dev", user: "anton", tls: true });
  });

  // Creating the file counts as a change too — a repo read before `bd init` must not be stuck
  // reporting embedded once it has a real connection.
  it("picks up a metadata.json that did not exist at the first read", () => {
    const dir = repo(null);
    expect(readBoardMode(dir).mode).toBe("embedded");

    mkdirSync(join(dir, ".beads"), { recursive: true });
    writeFileSync(join(dir, ".beads", "metadata.json"), JSON.stringify({ dolt_mode: "server", dolt_server_host: "h" }));

    expect(readBoardMode(dir).mode).toBe("server");
  });

  // The one deliberate exception, and it belongs to tests alone: pinning survives the file so a
  // suite can make anton believe in a server bd is not talking to.
  it("holds a pinned mode against the file until the cache is reset", () => {
    const dir = repo({ dolt_mode: "embedded" });
    pinBoardMode(dir, { mode: "server", host: "pinned.example.dev" });

    expect(readBoardMode(dir)).toEqual({ mode: "server", host: "pinned.example.dev" });
    writeFileSync(join(dir, ".beads", "metadata.json"), JSON.stringify({ dolt_mode: "embedded", note: "touched" }));
    expect(readBoardMode(dir).mode).toBe("server");

    resetBoardModeCache();
    expect(readBoardMode(dir).mode).toBe("embedded");
  });

  it("falls back to embedded on malformed JSON rather than throwing", () => {
    const dir = mkdtempSync(join(tmpdir(), "board-mode-"));
    dirs.push(dir);
    mkdirSync(join(dir, ".beads"), { recursive: true });
    writeFileSync(join(dir, ".beads", "metadata.json"), "{ not json");
    resetBoardModeCache();
    expect(() => readBoardMode(dir)).not.toThrow();
    expect(readBoardMode(dir).mode).toBe("embedded");
  });
});

describe("runDoltSync — server mode is a no-op (anton-0tul)", () => {
  it("spawns no bd process and reports shared-server", async () => {
    const dir = repo({ dolt_mode: "server", dolt_server_host: "h", dolt_server_port: 3306 });
    const calls: string[][] = [];
    const exec: TestExec = async (_cwd: string, args: string[]) => {
      calls.push(args);
      return "";
    };
    // The preflight is the one permitted call; it is `dolt test`, never pull/commit/push. Asserted
    // positively as well as negatively: without the `toContain`, silently dropping the preflight
    // would still satisfy both `not.toContain`s.
    await expect(runDoltSync(dir, exec, "full")).resolves.toBe("shared-server");
    expect(calls.map((a) => a.join(" "))).toContain("dolt test");
    expect(calls.map((a) => a.join(" "))).not.toContain("dolt pull");
    expect(calls.map((a) => a.join(" "))).not.toContain("dolt commit");
    expect(calls.map((a) => a.join(" "))).not.toContain("dolt push");
  });

  // The "a server that comes back is picked up on the next beat" guarantee (anton-eg46). The
  // mechanism is that the preflight records the cwd only on SUCCESS, so a failure leaves nothing
  // cached and the next pass retries. Deliberately no resetServerPreflight() between the two calls
  // — clearing the cache by hand would prove nothing about the retry.
  it("retries the preflight on the next pass when the server was unreachable", async () => {
    const dir = repo({ dolt_mode: "server", dolt_server_host: "h", dolt_server_port: 3306 });
    let attempts = 0;
    const exec: TestExec = async (_cwd: string, args: string[]) => {
      if (args.join(" ") === "dolt test" && ++attempts === 1) {
        throw new Error("dial tcp 127.0.0.1:3306: connection refused");
      }
      return "";
    };
    await expect(runDoltSync(dir, exec, "full")).rejects.toThrow(/unreachable/);
    await expect(runDoltSync(dir, exec, "full")).resolves.toBe("shared-server");
    expect(attempts).toBe(2);
  });

  // The other half of that contract: a SUCCESSFUL preflight is not repeated for the same repo
  // while it is still fresh — the ~10s beat must not become a `bd dolt test` every ~10s.
  it("preflights once per repo across passes once the server answers", async () => {
    const dir = repo({ dolt_mode: "server", dolt_server_host: "h", dolt_server_port: 3306 });
    let attempts = 0;
    const exec: TestExec = async (_cwd: string, args: string[]) => {
      if (args.join(" ") === "dolt test") attempts++;
      return "";
    };
    await expect(runDoltSync(dir, exec, "full")).resolves.toBe("shared-server");
    await expect(runDoltSync(dir, exec, "full")).resolves.toBe("shared-server");
    expect(attempts).toBe(1);
  });

  /**
   * The registry key is versioned because its VALUE SHAPE changed (PR #174 review): #157 stored a
   * `Set<string>` under `anton.beads.preflight`, and `Symbol.for` survives module replacement — so
   * a Next.js dev hot reload would hand this module the old Set and the first heartbeat would die
   * on `.get is not a function`. Simulated here by seeding the legacy key the way a reloaded
   * process would have left it.
   */
  it("ignores the legacy Set a hot-reloaded process left under the old registry key", async () => {
    const dir = repo({ dolt_mode: "server", dolt_server_host: "h", dolt_server_port: 3306 });
    const legacy = Symbol.for("anton.beads.preflight");
    const g = globalThis as unknown as Record<symbol, unknown>;
    g[legacy] = new Set([dir]);
    try {
      const calls: string[][] = [];
      const exec: TestExec = async (_cwd: string, args: string[]) => {
        calls.push(args);
        return "";
      };
      // Probes still run: the stale entry claiming this repo was already preflighted is unreachable.
      await expect(runDoltSync(dir, exec, "full")).resolves.toBe("shared-server");
      expect(calls.map((a) => a.join(" "))).toContain("dolt test");
    } finally {
      delete g[legacy];
    }
  });

  /**
   * The reason that cache EXPIRES (PR #174 review). A server that passed the probe at startup and
   * then went down would otherwise be reported healthy forever: server mode does nothing else on
   * the beat, so nothing would ever contradict the cached pass. After the TTL the probe runs again
   * and the outage rejects the pass, which is what puts it in the sync-status registry.
   */
  it("re-probes after the TTL, so a server that dies post-startup surfaces", async () => {
    const dir = repo({ dolt_mode: "server", dolt_server_host: "h", dolt_server_port: 3306 });
    let up = true;
    let attempts = 0;
    const exec: TestExec = async (_cwd: string, args: string[]) => {
      if (args.join(" ") === "dolt test") {
        attempts++;
        if (!up) throw new Error("dial tcp 127.0.0.1:3306: connection refused");
      }
      return "";
    };

    vi.useFakeTimers();
    try {
      await expect(runDoltSync(dir, exec, "full")).resolves.toBe("shared-server");
      up = false;
      // Still inside the TTL: the cached pass holds and the dead server goes unnoticed.
      vi.advanceTimersByTime(PREFLIGHT_TTL_MS - 1);
      await expect(runDoltSync(dir, exec, "full")).resolves.toBe("shared-server");
      expect(attempts).toBe(1);

      vi.advanceTimersByTime(1);
      await expect(runDoltSync(dir, exec, "full")).rejects.toThrow(/unreachable/);
      expect(attempts).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  /**
   * The other half of what that cache may not outlive (PR #174 review). Keyed on the repo path
   * alone, a pass recorded for one server vouches for whatever metadata.json names next — so an
   * operator correcting a wrong host, database, account or transport gets "healthy shared board"
   * for up to five minutes from a target nothing has probed. The probe follows the connection.
   */
  it("re-probes within the TTL when metadata.json is pointed at a different server", async () => {
    const dir = repo({ dolt_mode: "server", dolt_server_host: "old.example.dev", dolt_server_port: 3306 });
    const probed: string[] = [];
    const exec: TestExec = async (cwd: string, args: string[]) => {
      if (args.join(" ") === "dolt test") probed.push(readBoardMode(cwd).host ?? "?");
      return "";
    };

    await expect(runDoltSync(dir, exec, "full")).resolves.toBe("shared-server");
    await expect(runDoltSync(dir, exec, "full")).resolves.toBe("shared-server");
    expect(probed).toEqual(["old.example.dev"]);

    // The correction an operator makes when the host was wrong. Well inside the TTL.
    writeFileSync(
      join(dir, ".beads", "metadata.json"),
      JSON.stringify({ dolt_mode: "server", dolt_server_host: "new-server.example.dev", dolt_server_port: 3306 }),
    );
    await expect(runDoltSync(dir, exec, "full")).resolves.toBe("shared-server");
    expect(probed).toEqual(["old.example.dev", "new-server.example.dev"]);
  });

  /**
   * The second half of the health probe (PR #174 review). `bd dolt test` proves the SERVER answered
   * and nothing about this project's database, so a preflight that stopped there would keep the pass
   * resolving `shared-server` — and the sync status healthy — while every board operation is refused
   * by bd's identity guard. The read is what makes that an outage the operator sees.
   */
  it("fails the pass when the server answers but will not serve this project's board", async () => {
    const dir = repo({ dolt_mode: "server", dolt_server_host: "h", dolt_server_port: 3306 });
    const calls: string[][] = [];
    const exec: TestExec = async (_cwd: string, args: string[]) => {
      calls.push(args);
      if (args.join(" ") === BOARD_READ_PROBE.join(" ")) {
        throw new Error("PROJECT IDENTITY MISMATCH — refusing to connect");
      }
      return "";
    };

    // Worded for the board, not the server: "unreachable" would send the reader after a network
    // fault that isn't there.
    await expect(runDoltSync(dir, exec, "full")).rejects.toThrow(/will not serve the board/);
    expect(calls.map((a) => a.join(" "))).toEqual(["dolt test", BOARD_READ_PROBE.join(" ")]);

    // Nothing was cached, so the next pass re-probes rather than waiting out a TTL it never earned.
    await expect(runDoltSync(dir, exec, "full")).rejects.toThrow(/will not serve the board/);
    expect(calls).toHaveLength(4);
  });

  it("still runs the full pull/commit/push in embedded mode", async () => {
    const dir = repo({ dolt_mode: "embedded" });
    const calls: string[][] = [];
    const exec: TestExec = async (_cwd: string, args: string[]) => {
      calls.push(args);
      return "";
    };
    await expect(runDoltSync(dir, exec, "full")).resolves.toBe("synced");
    expect(calls.map((a) => a.join(" "))).toEqual(["dolt pull", "dolt commit", "dolt push"]);
  });

  it("still runs a pull-only pass in embedded mode", async () => {
    const dir = repo({ dolt_mode: "embedded" });
    const calls: string[][] = [];
    const exec: TestExec = async (_cwd: string, args: string[]) => {
      calls.push(args);
      return "";
    };
    await expect(runDoltSync(dir, exec, "pull")).resolves.toBe("synced");
    expect(calls.map((a) => a.join(" "))).toEqual(["dolt pull"]);
  });
});

/**
 * The seam every caller actually holds — `beads.sync`/`backstop`/`pull` all route through the
 * coalescer, not through runDoltSync directly. What matters here is that a server-mode pass settles
 * as its OWN terminal state rather than borrowing "synced": the backlog stays at zero and the repo
 * counts as reconciled, so the heartbeat never escalates a beat into a full push pass looking for
 * work that cannot exist (anton-0tul).
 */
describe("the sync coalescer in server mode (anton-0tul)", () => {
  it("settles as shared-server with no backlog, and keeps the backstop cheap", async () => {
    const dir = repo({ dolt_mode: "server", dolt_server_host: "h", dolt_server_port: 3306 });
    const calls: string[][] = [];
    const sync = createDoltSync(async (_cwd: string, args: string[]) => {
      calls.push(args);
      return "";
    });

    await expect(sync(dir, "full")).resolves.toBe("shared-server");
    expect(getSyncStatus(dir)).toMatchObject({ state: "shared-server", unpushedCount: 0, lastError: null });

    // The backstop is the heartbeat's request; an unreconciled repo would force a full pull/commit/
    // push pass. Here it costs the health probes and nothing else — never pull/commit/push.
    calls.length = 0;
    await expect(sync(dir, "backstop")).resolves.toBe("shared-server");
    expect(calls.map((a) => a.join(" "))).toEqual(["dolt test", BOARD_READ_PROBE.join(" ")]);

    // ...and the probes' TTL keeps the next beat free, so the ~10s heartbeat is not a `bd dolt
    // test` every ~10s.
    calls.length = 0;
    await expect(sync(dir, "backstop")).resolves.toBe("shared-server");
    expect(calls).toEqual([]);
  });

  /**
   * The false-failure this suppression exists to prevent (PR #174 review). `publishLease` writes the
   * lease and then awaits `beads.sync` purely to confirm delivery; on a shared server that write
   * already published itself. A probe here is a second, independent failure boundary AFTER a
   * successful write — a blip on it rejects the pass, and the caller reads that as "the lease never
   * published" and fails the run closed over a lease every other machine can already see.
   */
  it("runs no health probe on a post-write pass, so a blip cannot fail a published write", async () => {
    const dir = repo({ dolt_mode: "server", dolt_server_host: "h", dolt_server_port: 3306 });
    const calls: string[][] = [];
    const sync = createDoltSync(async (_cwd: string, args: string[]) => {
      calls.push(args);
      if (args.join(" ") === "dolt test") throw new Error("dial tcp 127.0.0.1:3306: connection refused");
      return "";
    });

    // The write-nudge (`beads.sync`) and the durable push job both follow a board write.
    await expect(sync(dir, "full")).resolves.toBe("shared-server");
    await expect(sync(dir, "push")).resolves.toBe("shared-server");
    expect(calls).toEqual([]);
  });

  // The other half: anton-eg46's fail-loud is untouched on the passes that have no write vouching
  // for them — the heartbeat and the read-freshness pull still surface an unreachable server.
  it("still fails loud on the heartbeat and on a read-freshness pull", async () => {
    const dir = repo({ dolt_mode: "server", dolt_server_host: "h", dolt_server_port: 3306 });
    const sync = createDoltSync(async (_cwd: string, args: string[]) => {
      if (args.join(" ") === "dolt test") throw new Error("dial tcp 127.0.0.1:3306: connection refused");
      return "";
    });

    await expect(sync(dir, "backstop")).rejects.toThrow(/unreachable/);
    await expect(sync(dir, "pull")).rejects.toThrow(/unreachable/);
    expect(getSyncStatus(dir).state).toBe("failing");
  });

  /**
   * Suppression has to survive coalescing, because a coalesced pass resolves for EVERY request
   * riding it: a write-nudge that lands on a queued heartbeat pass would otherwise inherit that
   * pass's probe and the exact false failure above. One post-write caller disqualifies the probe
   * for the whole pass; the heartbeat re-probes on the next beat.
   */
  it("suppresses the probe for a whole pass when a write-nudge coalesces into a heartbeat", async () => {
    const dir = repo({ dolt_mode: "server", dolt_server_host: "h", dolt_server_port: 3306 });
    const calls: string[][] = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let first = true;
    const sync = createDoltSync(async (_cwd: string, args: string[]) => {
      calls.push(args);
      if (first) {
        first = false;
        await gate; // hold the in-flight pass open so the next requests must queue behind it
      }
      if (args.join(" ") === "dolt test") throw new Error("dial tcp 127.0.0.1:3306: connection refused");
      return "";
    });

    // The in-flight heartbeat probes and FAILS, so nothing is cached — without that, the probe's
    // TTL alone would keep the trailing pass quiet and this would prove nothing about suppression.
    const running = sync(dir, "backstop");
    const queued = sync(dir, "backstop"); // queues a trailing pass that would probe
    const nudge = sync(dir, "full"); // ...the write-nudge rides it, so it must not
    release();

    await expect(running).rejects.toThrow(/unreachable/);
    await expect(queued).resolves.toBe("shared-server");
    await expect(nudge).resolves.toBe("shared-server");
    expect(calls.map((a) => a.join(" "))).toEqual(["dolt test"]); // the trailing pass probed nothing
  });

  it("leaves an embedded repo's pass reporting synced", async () => {
    const dir = repo({ dolt_mode: "embedded" });
    const sync = createDoltSync(async () => "");
    await expect(sync(dir, "full")).resolves.toBe("synced");
    expect(getSyncStatus(dir).state).toBe("synced");
  });
});

describe("isServerMode", () => {
  it("is a thin predicate over readBoardMode", () => {
    expect(isServerMode(repo({ dolt_mode: "server" }))).toBe(true);
    expect(isServerMode(repo({ dolt_mode: "embedded" }))).toBe(false);
  });
});
