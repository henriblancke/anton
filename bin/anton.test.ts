/**
 * Smoke tests for the anton CLI (anton-hji). Only exercises argument dispatch — the paths that
 * don't depend on external tools or a build — so it's deterministic in CI (where bd/gh/stringer
 * aren't installed). setup/start/doctor behavior is covered by the manual run + the prereq logic.
 */
import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const CLI = join(dirname(fileURLToPath(import.meta.url)), "anton.mjs");

function run(args: string[]) {
  return spawnSync("node", [CLI, ...args], { encoding: "utf8" });
}

describe("anton CLI dispatch", () => {
  it("--help prints usage and exits 0", () => {
    const r = run(["--help"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("anton <command>");
    expect(r.stdout).toContain("setup");
    expect(r.stdout).toContain("start");
  });

  it("no command prints usage and exits non-zero", () => {
    const r = run([]);
    expect(r.status).toBe(1);
    expect(r.stdout).toContain("Usage:");
  });

  it("unknown command exits non-zero with an error", () => {
    const r = run(["bogus"]);
    expect(r.status).toBe(1);
    expect(r.stdout).toContain("unknown command: bogus");
  });
});
