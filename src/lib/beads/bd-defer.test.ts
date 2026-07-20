/**
 * Argv-level unit test for the snooze primitives (anton-ywi8): `beads.defer`/`beads.undefer` must
 * spawn bd's own `defer`/`undefer` subcommands, not a hand-rolled `update --status deferred` (bd
 * owns the transition and its audit trail). `node:child_process` is mocked so no bd is spawned.
 */
import { describe, expect, it, vi } from "vitest";

const { calls } = vi.hoisted(() => ({ calls: [] as string[][] }));

vi.mock("node:child_process", () => {
  const promisified = async (file: string, args: string[]) => {
    calls.push([file, ...args]);
    return { stdout: "", stderr: "" };
  };
  // bd.ts wraps execFile with util.promisify — the custom symbol is what promisify picks up.
  const execFile = Object.assign(() => undefined, {
    [Symbol.for("nodejs.util.promisify.custom")]: promisified,
  });
  return { execFile };
});

const { beads } = await import("./bd");

describe("beads.defer / beads.undefer", () => {
  it("issues `bd defer <id>` and `bd undefer <id>`", async () => {
    await beads.defer("/repo", "bd-1");
    await beads.undefer("/repo", "bd-1");
    expect(calls).toEqual([
      ["bd", "defer", "bd-1"],
      ["bd", "undefer", "bd-1"],
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
