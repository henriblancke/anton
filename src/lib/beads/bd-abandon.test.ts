/**
 * Argv-level unit test for the won't-do primitive (anton-6xj0): `beads.abandon` must issue bd's own
 * `close --reason` (the decision's durable record) followed by the `abandoned` label — beads has no
 * cancelled status, so that pair IS the outcome. `node:child_process` is mocked so no bd is spawned.
 * Mirrors bd-defer.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BD_BIN_ENV, resetBdBinCache } from "./bd-bin";

// bd.ts spawns bd's RESOLVED absolute path (anton-346), not the bare name. Pin it to this test
// runner's own executable so resolveBdBin() resolves hermetically — with no bd on the box, it would
// otherwise fail loud. These are argv-level assertions (which bd subcommand), not about bd's path.
const BD = process.execPath;

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

describe("beads.abandon", () => {
  beforeEach(() => {
    calls.length = 0;
    process.env[BD_BIN_ENV] = BD;
    resetBdBinCache();
  });
  afterEach(() => {
    delete process.env[BD_BIN_ENV];
    resetBdBinCache();
  });

  it("closes with the reason, then tags the bead abandoned and clears its stage", async () => {
    await beads.abandon("/repo", "bd-1", "superseded by bd-9");
    expect(calls).toEqual([
      [BD, "close", "bd-1", "--reason", "abandoned: superseded by bd-9"],
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
    ]);
  });

  it("trims the reason", async () => {
    await beads.abandon("/repo", "bd-1", "  no longer needed \n");
    expect(calls[0]).toContain("abandoned: no longer needed");
  });

  it("refuses a blank reason — and writes nothing", async () => {
    await expect(beads.abandon("/repo", "bd-1", "   ")).rejects.toThrow(/reason/i);
    expect(calls).toEqual([]);
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
