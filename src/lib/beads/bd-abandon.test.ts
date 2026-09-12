/**
 * Argv-level unit test for the won't-do primitive (anton-6xj0): `beads.abandon` must write the
 * `abandoned` label and then bd's own `close --reason` (the decision's durable record) — beads has
 * no cancelled status, so that pair IS the outcome. Its sibling predicate `beads.supersededBy`
 * (anton-5bpd) is asserted here too: both answer "closed, but this branch delivered none of it",
 * and every caller that tells a settled bead from a cross-machine close reads the pair together. The close goes through `bd batch` so a cascade
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

// Only `spawn` is faked: bd.ts's own imports (git/remote's execFile) must keep working, so the rest
// of the module is passed through rather than replaced.
vi.mock("node:child_process", async (importActual) => {
  const { makeFakeSpawn } = await import("../testing/spawn");
  return { ...(await importActual<typeof import("node:child_process")>()), spawn: makeFakeSpawn(spawned) };
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

describe("beads.supersededBy", () => {
  const bead = (status: string, deps?: Array<Record<string, string>>) =>
    ({ id: "x", title: "x", status, ...(deps ? { dependencies: deps } : {}) }) as never;
  const superseded = (survivor: string) => [
    { issue_id: "x", depends_on_id: survivor, type: "supersedes" },
  ];

  it("names the survivor the board's `supersedes` edge points at", () => {
    expect(beads.supersededBy(bead("closed", superseded("bd-9")))).toBe("bd-9");
  });

  // `bd show --json` does not carry edge rows: its `dependencies` are the depended-on ISSUES, each
  // stamped with `dependency_type` (bd 1.1.2). A fresh `show` of a bead just superseded must read as
  // superseded, or a post-write fence reading it (repair-already-shipped) sees its own close as
  // somebody else's.
  it("reads the survivor off a `bd show` read, whose dependencies are issues stamped with a type", () => {
    const shown = [
      { id: "bd-2", title: "where it came from", status: "closed", dependency_type: "discovered-from" },
      { id: "bd-9", title: "the survivor", status: "closed", dependency_type: "supersedes" },
    ];
    expect(beads.supersededBy(bead("closed", shown))).toBe("bd-9");
    expect(beads.supersededBy(bead("closed", shown.slice(0, 1)))).toBeUndefined();
    expect(beads.supersededBy(bead("open", shown))).toBeUndefined();
  });

  it("answers nothing for a bead the board records no retirement for", () => {
    expect(beads.supersededBy(bead("closed"))).toBeUndefined();
    expect(beads.supersededBy(bead("closed", []))).toBeUndefined();
    // Other edge types on the same bead say nothing about where its work went.
    expect(
      beads.supersededBy(bead("closed", [{ issue_id: "x", depends_on_id: "bd-9", type: "blocks" }])),
    ).toBeUndefined();
    // The edge pointing the other way: this bead is the SURVIVOR, and survivors are live work.
    expect(
      beads.supersededBy(
        bead("closed", [{ issue_id: "bd-9", depends_on_id: "x", type: "supersedes" }]),
      ),
    ).toBeUndefined();
  });

  it("answers nothing once the bead is reopened — a live bead is work again, pointer or not", () => {
    expect(beads.supersededBy(bead("open", superseded("bd-9")))).toBeUndefined();
    expect(beads.supersededBy(bead("in_progress", superseded("bd-9")))).toBeUndefined();
  });
});

describe("beads.supersedesTarget", () => {
  const bead = (status: string, deps?: Array<Record<string, string>>) =>
    ({ id: "x", title: "x", status, ...(deps ? { dependencies: deps } : {}) }) as never;
  const superseded = (survivor: string) => [
    { issue_id: "x", depends_on_id: survivor, type: "supersedes" },
  ];

  // The status-agnostic reader supersededBy gates on `closed`: a run re-executing a reopened
  // retirement must see the stale edge to clear it (PR #238 review), and supersededBy withholds it.
  it("names the survivor whatever the bead's status — including a reopened retirement", () => {
    expect(beads.supersedesTarget(bead("closed", superseded("bd-9")))).toBe("bd-9");
    expect(beads.supersedesTarget(bead("open", superseded("bd-9")))).toBe("bd-9");
    expect(beads.supersedesTarget(bead("in_progress", superseded("bd-9")))).toBe("bd-9");
  });

  it("reads the survivor off a `bd show` read too, whose deps are issues stamped with a type", () => {
    const shown = [{ id: "bd-9", title: "the survivor", status: "closed", dependency_type: "supersedes" }];
    expect(beads.supersedesTarget(bead("open", shown))).toBe("bd-9");
  });

  it("answers nothing when no `supersedes` edge points off this bead", () => {
    expect(beads.supersedesTarget(bead("open"))).toBeUndefined();
    expect(beads.supersedesTarget(bead("open", [{ issue_id: "x", depends_on_id: "bd-9", type: "blocks" }]))).toBeUndefined();
    // This bead is the SURVIVOR of someone else's retirement, not the retired one.
    expect(
      beads.supersedesTarget(bead("open", [{ issue_id: "bd-9", depends_on_id: "x", type: "supersedes" }])),
    ).toBeUndefined();
  });
});
