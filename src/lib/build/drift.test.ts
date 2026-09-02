/**
 * The seam the server itself uses (anton-pzfb): boot stamps what this process is running, and every
 * later read compares that stamp with the code on disk. What matters here is the round trip and the
 * silence — a server started from the current checkout must produce no verdict at all, and neither
 * must a process that never booted a server (every unit test in this repo is one).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let dir: string;
const realDb = process.env.ANTON_DB;

/** A fresh module instance per case — `bootedFrom` is module state, and boot is what's under test. */
function freshModule() {
  vi.resetModules();
  return import("./drift");
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "anton-drift-"));
  process.env.ANTON_DB = join(dir, "anton.db");
});

afterEach(() => {
  process.env.ANTON_DB = realDb;
  rmSync(dir, { recursive: true, force: true });
});

describe("recordServerBuild / serverBuildDrift", () => {
  it("reports no drift for a server booted from the checkout it is reading", async () => {
    const { recordServerBuild, serverBuildDrift } = await freshModule();
    recordServerBuild();
    expect(serverBuildDrift()).toBeNull();
  });

  it("records beside anton.db, naming this process so a later reader can tell it is still up", async () => {
    const { recordServerBuild } = await freshModule();
    recordServerBuild();
    const record = JSON.parse(readFileSync(join(dir, "server-build.json"), "utf8"));
    expect(record.pid).toBe(process.pid);
    expect(record.version).toMatch(/^\d+\.\d+\.\d+/);
    expect(record.bootedAt).toBeGreaterThan(0);
  });

  // The 2026-08-17 shape, forced: the process is up and the record says it booted somewhere else.
  it("reports the drift once the code on disk is no longer what this process booted from", async () => {
    const { recordServerBuild, serverBuildDrift } = await freshModule();
    recordServerBuild();
    const path = join(dir, "server-build.json");
    const record = JSON.parse(readFileSync(path, "utf8"));
    writeFileSync(path, JSON.stringify({ ...record, version: "0.0.1" }));

    const drift = serverBuildDrift();
    expect(drift?.state).toBe("outdated");
    expect(drift?.running?.version).toBe("0.0.1");
    expect(drift?.onDisk.version).toBe(record.version);
  });

  // Restart is the whole remediation: a new boot overwrites the record, and the verdict is gone.
  it("clears on the next boot with nothing else done", async () => {
    const { recordServerBuild, serverBuildDrift } = await freshModule();
    recordServerBuild();
    const path = join(dir, "server-build.json");
    writeFileSync(path, JSON.stringify({ ...JSON.parse(readFileSync(path, "utf8")), version: "0.0.1" }));
    expect(serverBuildDrift()).not.toBeNull();

    recordServerBuild();

    expect(serverBuildDrift()).toBeNull();
  });

  it("says nothing in a process that never booted a server", async () => {
    const { serverBuildDrift } = await freshModule();
    expect(serverBuildDrift()).toBeNull();
  });
});
