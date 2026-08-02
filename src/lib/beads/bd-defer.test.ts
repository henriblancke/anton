/**
 * Argv-level unit test for the snooze primitives (anton-ywi8): `beads.defer`/`beads.undefer` must
 * spawn bd's own `defer`/`undefer` subcommands, not a hand-rolled `update --status deferred` (bd
 * owns the transition and its audit trail). `spawn` is faked so no bd is launched.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BD_BIN_ENV, resetBdBinCache } from "./bd-bin";

// bd.ts spawns bd's RESOLVED absolute path (anton-346), not the bare name. Pin it to this test
// runner's own executable so resolveBdBin() resolves hermetically — with no bd on the box, it would
// otherwise fail loud. These are argv-level assertions (which bd subcommand), not about bd's path.
const BD = process.execPath;

const { spawned } = vi.hoisted(() => ({
  spawned: [] as Array<{ file: string; args: string[]; options: Record<string, unknown> | undefined }>,
}));

// Only `spawn` is faked: bd.ts's own imports (git/remote's execFile) must keep working, so the rest
// of the module is passed through rather than replaced.
vi.mock("node:child_process", async (importActual) => {
  const { makeFakeSpawn } = await import("../testing/spawn");
  return { ...(await importActual<typeof import("node:child_process")>()), spawn: makeFakeSpawn(spawned) };
});

const { beads } = await import("./bd");

const calls = () => spawned.map((c) => [c.file, ...c.args]);

describe("beads.defer / beads.undefer", () => {
  beforeEach(() => {
    spawned.length = 0;
    process.env[BD_BIN_ENV] = BD;
    resetBdBinCache();
  });
  afterEach(() => {
    delete process.env[BD_BIN_ENV];
    resetBdBinCache();
  });

  it("issues `bd defer <id>` and `bd undefer <id>`", async () => {
    await beads.defer("/repo", "bd-1");
    await beads.undefer("/repo", "bd-1");
    expect(calls()).toEqual([
      [BD, "defer", "bd-1"],
      [BD, "undefer", "bd-1"],
    ]);
  });
});

describe("beads.isDeferred", () => {
  it("reads bd's deferred status, and nothing else", () => {
    const bead = (status: string) => ({ id: "x", title: "x", status }) as never;
    expect(beads.isDeferred(bead("deferred"))).toBe(true);
    expect(beads.isDeferred(bead("open"))).toBe(false);
    expect(beads.isDeferred(bead("blocked"))).toBe(false);
    expect(beads.isDeferred(bead("closed"))).toBe(false);
  });
});
