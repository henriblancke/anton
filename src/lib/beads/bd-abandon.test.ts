/**
 * Argv-level unit test for the won't-do primitive (anton-6xj0): `beads.abandon` must write the
 * `abandoned` label and then bd's own `close --reason` (the decision's durable record) — beads has
 * no cancelled status, so that pair IS the outcome. The close goes through `bd batch` so a cascade
 * settles as one transaction (anton-aijz). `spawn` is faked so no bd is launched.
 * Mirrors bd-defer.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BD_BIN_ENV, resetBdBinCache } from "./bd-bin";

// bd.ts spawns bd's RESOLVED absolute path (anton-346), not the bare name. Pin it to this test
// runner's own executable so resolveBdBin() resolves hermetically — with no bd on the box, it would
// otherwise fail loud. These are argv-level assertions (which bd subcommand), not about bd's path.
const BD = process.execPath;

const { spawned } = vi.hoisted(() => ({
  spawned: [] as Array<{
    file: string;
    args: string[];
    options: Record<string, unknown> | undefined;
    stdin?: string;
  }>,
}));

vi.mock("node:child_process", async () => {
  const { makeFakeSpawn } = await import("../testing/spawn");
  return { spawn: makeFakeSpawn(spawned) };
});

const { beads } = await import("./bd");

const calls = () => spawned.map((c) => [c.file, ...c.args]);

describe("beads.abandon", () => {
  beforeEach(() => {
    spawned.length = 0;
    process.env[BD_BIN_ENV] = BD;
    resetBdBinCache();
  });
  afterEach(() => {
    delete process.env[BD_BIN_ENV];
    resetBdBinCache();
  });

  it("tags the bead abandoned and clears its stage, then closes it with the reason", async () => {
    await beads.abandon("/repo", "bd-1", "superseded by bd-9");
    expect(calls()).toEqual([
      [
        BD,
        "update",
        "bd-1",
        "--add-label",
        "abandoned",
        "--remove-label",
        "stage:implementing",
        "--remove-label",
        "stage:in-review",
      ],
      [BD, "batch", "--json"],
    ]);
    expect(spawned[1].stdin).toBe('close bd-1 "abandoned: superseded by bd-9"\n');
  });

  it("trims the reason", async () => {
    await beads.abandon("/repo", "bd-1", "  no longer needed \n");
    expect(spawned[1].stdin).toContain("abandoned: no longer needed");
  });

  it("refuses a blank reason — and writes nothing", async () => {
    await expect(beads.abandon("/repo", "bd-1", "   ")).rejects.toThrow(/reason/i);
    expect(calls()).toEqual([]);
  });
});

describe("beads.isAbandoned", () => {
  it("reads the abandoned label, and nothing else", () => {
    const bead = (labels: string[], status = "closed") => ({ id: "x", title: "x", status, labels }) as never;
    expect(beads.isAbandoned(bead(["abandoned"]))).toBe(true);
    expect(beads.isAbandoned(bead(["approved", "abandoned"]))).toBe(true);
    // A plain close means shipped — only the label distinguishes a won't-do outcome.
    expect(beads.isAbandoned(bead([]))).toBe(false);
    expect(beads.isAbandoned(bead(["approved"], "open"))).toBe(false);
    expect(beads.isAbandoned({ id: "x", title: "x", status: "closed" } as never)).toBe(false);
  });
});
