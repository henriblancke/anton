/**
 * The start gate's build source must not answer from `build/drift`'s on-disk cache (PR #257 review).
 *
 * A source-only `git pull` by an operator fires no `checkoutMoved`, so inside the 15s window the
 * checkout half reads current (HEAD moved, the fetch is live), the dependency half never moved, and
 * a CACHED build read would compare this process against the pre-pull disk — three current halves,
 * and `execute-epic` admits a run onto the code the pull just superseded.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let dir: string;
const realDb = process.env.ANTON_DB;

/** The boot identity is anchored on globalThis precisely so it survives a registry reset. */
function unboot() {
  delete (globalThis as unknown as Record<symbol, unknown>)[Symbol.for("anton.build.bootedFrom")];
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "anton-gate-freshness-"));
  process.env.ANTON_DB = join(dir, "anton.db");
});

afterEach(() => {
  unboot();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.doUnmock("../build/identity.mjs");
  process.env.ANTON_DB = realDb;
  rmSync(dir, { recursive: true, force: true });
});

describe("SELF.buildDrift", () => {
  it("sees a checkout that moved without an invalidation, where the cached read still says current", async () => {
    vi.stubEnv("ANTON_APP_ROOT", join(dir, "app"));
    let onDisk = { version: "0.4.0", revision: null };
    vi.resetModules();
    unboot();
    const identity = await vi.importActual<typeof import("../build/identity.mjs")>(
      "../build/identity.mjs",
    );
    vi.doMock("../build/identity.mjs", () => ({ ...identity, readBuildIdentity: () => onDisk }));
    const { recordServerBuild, serverBuildDrift } = await import("../build/drift");
    const { SELF } = await import("./self-freshness");

    recordServerBuild({ runner: true });
    onDisk = { version: "0.4.1", revision: null }; // the operator's `git pull`, inside the TTL

    // What a display surface still sees — the read taken at boot, held as a rate limit.
    expect(serverBuildDrift()).toBeNull();
    // What the gate must see: the process is behind the code on disk, so no run may start.
    expect((await SELF.buildDrift())?.state).toBe("outdated");
  });
});
