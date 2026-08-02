/**
 * The board-hygiene seam (anton-6qbc): the seven verbs the gardener patrol composes. Each fixture
 * below is RECORDED VERBATIM from a real bd run against a seeded scratch board — re-run on bd 1.1.2
 * and on the 1.1.0 floor (`~/.local/bin/bd.1.1.0.bak`), byte-identical on both — because `--help` is
 * not an oracle for output shape (.product/decisions/2026-07-28-bd-workflow-primitives.md).
 *
 * `spawn` is faked (as in bd-batch.test.ts) so no bd is launched: what is under test here is which
 * argv each wrapper builds, what it makes of bd's bytes, and whether it invalidates the board
 * snapshot. The real round-trip — including the eligibility rule and the two-shape close-eligible
 * output — lives in bd-hygiene.integration.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { vi } from "vitest";
import { BD_BIN_ENV, resetBdBinCache } from "./bd-bin";
import { issueSnapshotVersion, resetIssueSnapshots } from "./snapshot";

// Pin bd's resolved path to this runner's own executable so resolveBdBin() answers hermetically
// on a box with no bd (the bd-abandon.test.ts / bd-batch.test.ts convention).
const BD = process.execPath;
const REPO = "/repos/widgets";

const { spawned, reply } = vi.hoisted(() => ({
  spawned: [] as Array<{
    file: string;
    args: string[];
    options: Record<string, unknown> | undefined;
    stdin?: string;
  }>,
  /** stdout the fake bd answers with, keyed by the subcommand under test. */
  reply: { stdout: "" as string },
}));

vi.mock("node:child_process", async (importActual) => {
  const { makeFakeSpawn } = await import("../testing/spawn");
  return {
    ...(await importActual<typeof import("node:child_process")>()),
    spawn: makeFakeSpawn(spawned, () => ({ stdout: reply.stdout })),
  };
});

const {
  beads,
  buildLintArgs,
  buildStaleArgs,
  parseDepCycles,
  parseDuplicateGroups,
  parseEpicCloseEligible,
  parseLintReport,
  parseOrphans,
  parseRecomputeBlocked,
} = await import("./bd");

/** The argv of the single bd spawn a case made — every wrapper here owes exactly one. */
function onlyArgs(): string[] {
  expect(spawned).toHaveLength(1);
  return spawned[0].args;
}

beforeEach(() => {
  spawned.length = 0;
  reply.stdout = "";
  process.env[BD_BIN_ENV] = BD;
  resetBdBinCache();
  resetIssueSnapshots();
});

afterEach(() => {
  delete process.env[BD_BIN_ENV];
  resetBdBinCache();
  resetIssueSnapshots();
});

// ── recorded bd output ──

/** `bd epic close-eligible --dry-run --json` with one epic whose only child is closed. */
const CLOSE_ELIGIBLE_PREVIEW = `[
  {
    "epic": {
      "id": "probe-cb1",
      "title": "done epic",
      "status": "open",
      "priority": 2,
      "issue_type": "epic",
      "owner": "t@example.com",
      "created_at": "2026-08-02T16:58:59Z",
      "created_by": "anton-test",
      "updated_at": "2026-08-02T16:58:59Z"
    },
    "total_children": 1,
    "closed_children": 1,
    "eligible_for_close": true
  }
]
`;

/** `bd epic close-eligible --json` (applying) — an OBJECT, not the preview's array. */
const CLOSE_ELIGIBLE_APPLIED = `{
  "closed": [
    "probe-cb1"
  ],
  "count": 1,
  "schema_version": 1
}
`;

/** The same apply when nothing was eligible: bd answers a bare `[]`, not `{"closed": []}`. */
const CLOSE_ELIGIBLE_NOTHING = "[]\n";

/**
 * `bd lint --json` on a board with a bug missing BOTH its required sections. This is the fixture
 * that disambiguates bd's counters: 2 warnings across 1 issue → `{"total": 2, "issues": 1}`.
 */
const LINT_JSON = `{
  "total": 2,
  "issues": 1,
  "results": [
    {
      "id": "probe-aje",
      "title": "broken thing",
      "type": "bug",
      "missing": [
        "## Steps to Reproduce",
        "## Acceptance Criteria"
      ],
      "warnings": 2
    }
  ]
}
`;

/** `bd lint --json` on a clean board — `results` is null, NOT an empty array. */
const LINT_CLEAN = `{
  "total": 0,
  "issues": 0,
  "results": null
}
`;

/** `bd stale --json` — a plain array of beads, one per status. */
const STALE_JSON = `[
  {
    "id": "probe-old1",
    "title": "forgotten open bead",
    "status": "open",
    "priority": 2,
    "issue_type": "task",
    "created_at": "2025-01-01T00:00:00Z",
    "updated_at": "2025-01-02T00:00:00Z"
  },
  {
    "id": "probe-old2",
    "title": "abandoned in progress",
    "status": "in_progress",
    "priority": 1,
    "issue_type": "task",
    "assignee": "someone",
    "created_at": "2025-01-01T00:00:00Z",
    "updated_at": "2025-01-03T00:00:00Z"
  }
]
`;

/** `bd orphans --json` — note bd's field is `issue_id`, and the sha is abbreviated. */
const ORPHANS_JSON = `[
  {
    "issue_id": "probe-vx2",
    "title": "no acceptance here",
    "status": "open",
    "latest_commit": "ba4d775",
    "latest_commit_message": "fix(probe-vx2): work"
  }
]
`;

/** `bd duplicates --json` — an envelope, and `&&` arrives HTML-escaped in the suggested command. */
const DUPLICATES_JSON = `{
  "duplicate_groups": 1,
  "groups": [
    {
      "issues": [
        {
          "dependencies": 0,
          "dependents": 0,
          "id": "probe-79b",
          "is_merge_target": true,
          "priority": 2,
          "references": 0,
          "status": "open",
          "title": "same title",
          "weight": 0
        },
        {
          "dependencies": 0,
          "dependents": 0,
          "id": "probe-7es",
          "is_merge_target": false,
          "priority": 2,
          "references": 0,
          "status": "open",
          "title": "same title",
          "weight": 0
        }
      ],
      "note": "Duplicate: probe-7es (same content as probe-79b)",
      "suggested_action": "bd close probe-7es \\u0026\\u0026 bd dep add probe-7es probe-79b --type related",
      "suggested_sources": [
        "probe-7es"
      ],
      "suggested_target": "probe-79b",
      "title": "same title"
    }
  ],
  "schema_version": 1
}
`;

const RECOMPUTE_JSON = `{
  "rows_corrected": 3,
  "schema_version": 1
}
`;

// ── argv builders ──

describe("buildLintArgs", () => {
  it("lints open beads by default and always asks for JSON", () => {
    expect(buildLintArgs()).toEqual(["lint", "--json"]);
  });

  it("passes status and type through", () => {
    expect(buildLintArgs({ status: "all", type: "bug" })).toEqual([
      "lint",
      "--status",
      "all",
      "--type",
      "bug",
      "--json",
    ]);
  });
});

describe("buildStaleArgs", () => {
  it("defaults to every status, bd's own 30-day window, and an UNLIMITED result set", () => {
    // `--limit 0`, like list/ready: bd's default of 50 would silently drop findings from a report
    // whose whole job is to be complete.
    expect(buildStaleArgs()).toEqual(["stale", "--limit", "0", "--json"]);
  });

  it("scopes to one status and window when asked", () => {
    expect(buildStaleArgs({ status: "in_progress", days: 7, limit: 10 })).toEqual([
      "stale",
      "--status",
      "in_progress",
      "--days",
      "7",
      "--limit",
      "10",
      "--json",
    ]);
  });

  it("refuses days < 1 up front — bd rejects it, and its error arrives as a JSON envelope", () => {
    expect(() => buildStaleArgs({ days: 0 })).toThrow(/--days must be an integer >= 1/);
    expect(() => buildStaleArgs({ days: -3 })).toThrow(/--days must be an integer >= 1/);
    expect(() => buildStaleArgs({ days: 1.5 })).toThrow(/--days must be an integer >= 1/);
  });
});

// ── parsers, against the recorded output ──

describe("parseEpicCloseEligible", () => {
  it("reads a preview into candidates with their child counts", () => {
    const sweep = parseEpicCloseEligible(CLOSE_ELIGIBLE_PREVIEW, true);
    expect(sweep).toEqual({
      dryRun: true,
      closed: [],
      eligible: [
        {
          epic: expect.objectContaining({ id: "probe-cb1", title: "done epic" }),
          totalChildren: 1,
          closedChildren: 1,
          eligible: true,
        },
      ],
    });
  });

  it("reads an apply's OBJECT into the ids bd closed — the other shape of the same verb", () => {
    expect(parseEpicCloseEligible(CLOSE_ELIGIBLE_APPLIED, false)).toEqual({
      dryRun: false,
      eligible: [],
      closed: ["probe-cb1"],
    });
  });

  it("reads the applied-but-nothing-eligible case, where bd answers a bare []", () => {
    expect(parseEpicCloseEligible(CLOSE_ELIGIBLE_NOTHING, false)).toEqual({
      dryRun: false,
      eligible: [],
      closed: [],
    });
  });

  it("drops an entry bd marked ineligible, and one with no epic", () => {
    const doc = JSON.stringify([
      { epic: { id: "e-1" }, total_children: 2, closed_children: 1, eligible_for_close: false },
      { total_children: 1, closed_children: 1, eligible_for_close: true },
    ]);
    expect(parseEpicCloseEligible(doc, true).eligible).toEqual([]);
  });

  it("fails loud on an unreadable answer rather than reporting 'nothing to close'", () => {
    expect(() => parseEpicCloseEligible('{"count": 1}', false)).toThrow(
      /could not read its --json output/,
    );
    expect(() => parseEpicCloseEligible("Error: boom\n", false)).toThrow(/output was not JSON/);
  });
});

describe("parseLintReport", () => {
  it("renames bd's counters to what they COUNT: total is warnings, issues is beads", () => {
    const report = parseLintReport(LINT_JSON);
    expect(report.warnings).toBe(2);
    expect(report.issues).toBe(1);
    expect(report.violations).toEqual([
      {
        id: "probe-aje",
        title: "broken thing",
        type: "bug",
        missing: ["## Steps to Reproduce", "## Acceptance Criteria"],
        warnings: 2,
      },
    ]);
  });

  it("handles the clean board, whose `results` is null rather than []", () => {
    expect(parseLintReport(LINT_CLEAN)).toEqual({ warnings: 0, issues: 0, violations: [] });
  });

  it("skips a result with no id and derives counters bd omitted", () => {
    const doc = JSON.stringify({ results: [{ title: "nameless" }, { id: "x", missing: ["## A"] }] });
    expect(parseLintReport(doc)).toEqual({
      warnings: 1,
      issues: 1,
      violations: [{ id: "x", title: "", type: "", missing: ["## A"], warnings: 1 }],
    });
  });
});

describe("parseOrphans", () => {
  it("normalises bd's `issue_id` to `id` and carries the commit it matched", () => {
    expect(parseOrphans(ORPHANS_JSON)).toEqual([
      {
        id: "probe-vx2",
        title: "no acceptance here",
        status: "open",
        latestCommit: "ba4d775",
        latestCommitMessage: "fix(probe-vx2): work",
      },
    ]);
  });

  it("reads bd's empty answer, which is a bare `null` and not `[]`", () => {
    expect(parseOrphans("null\n")).toEqual([]);
  });
});

describe("parseDepCycles", () => {
  it("reads the empty answer — the only shape a real bd can be made to produce", () => {
    expect(parseDepCycles("[]\n")).toEqual([]);
  });

  it("extracts ids from every encoding bd plausibly uses, keeping the element verbatim", () => {
    const raws: unknown[] = [
      ["a-1", "a-2"],
      { cycle: ["b-1", "b-2"] },
      { path: [{ id: "c-1" }, { id: "c-2" }] },
      { issue_ids: ["d-1"] },
    ];
    expect(parseDepCycles(JSON.stringify(raws))).toEqual([
      { ids: ["a-1", "a-2"], raw: raws[0] },
      { ids: ["b-1", "b-2"], raw: raws[1] },
      { ids: ["c-1", "c-2"], raw: raws[2] },
      { ids: ["d-1"], raw: raws[3] },
    ]);
  });

  it("still REPORTS a cycle whose ids it cannot read — an unnameable cycle is the finding", () => {
    expect(parseDepCycles(JSON.stringify([{ weird: 1 }]))).toEqual([
      { ids: [], raw: { weird: 1 } },
    ]);
  });
});

describe("parseDuplicateGroups", () => {
  it("reads the envelope into groups with their merge target and members", () => {
    expect(parseDuplicateGroups(DUPLICATES_JSON)).toEqual([
      {
        title: "same title",
        target: "probe-79b",
        sources: ["probe-7es"],
        note: "Duplicate: probe-7es (same content as probe-79b)",
        suggestedAction:
          "bd close probe-7es && bd dep add probe-7es probe-79b --type related",
        members: [
          {
            id: "probe-79b",
            title: "same title",
            status: "open",
            priority: 2,
            references: 0,
            isMergeTarget: true,
          },
          {
            id: "probe-7es",
            title: "same title",
            status: "open",
            priority: 2,
            references: 0,
            isMergeTarget: false,
          },
        ],
      },
    ]);
  });

  it("reads the clean board's empty envelope", () => {
    expect(
      parseDuplicateGroups('{"duplicate_groups": 0, "groups": [], "schema_version": 1}'),
    ).toEqual([]);
  });
});

describe("parseRecomputeBlocked", () => {
  it("returns the rows bd corrected", () => {
    expect(parseRecomputeBlocked(RECOMPUTE_JSON)).toBe(3);
    expect(parseRecomputeBlocked('{"rows_corrected": 0, "schema_version": 1}')).toBe(0);
  });

  it("throws rather than report an unreadable repair as a consistent graph", () => {
    expect(() => parseRecomputeBlocked('{"schema_version": 1}')).toThrow(
      /could not read rows_corrected/,
    );
  });
});

// ── the wrappers: argv, cwd, and the snapshot contract ──

describe("beads.epicCloseEligible", () => {
  it("previews by default — --dry-run, and the board snapshot is untouched", async () => {
    reply.stdout = CLOSE_ELIGIBLE_PREVIEW;
    const before = issueSnapshotVersion(REPO);
    const sweep = await beads.epicCloseEligible(REPO);
    expect(onlyArgs()).toEqual(["epic", "close-eligible", "--dry-run", "--json"]);
    expect(spawned[0].options?.cwd).toBe(REPO);
    expect(sweep.dryRun).toBe(true);
    expect(sweep.eligible.map((c) => c.epic.id)).toEqual(["probe-cb1"]);
    expect(sweep.closed).toEqual([]);
    expect(issueSnapshotVersion(REPO)).toBe(before);
  });

  it("applying drops --dry-run and invalidates the board snapshot like every other write", async () => {
    reply.stdout = CLOSE_ELIGIBLE_APPLIED;
    const before = issueSnapshotVersion(REPO);
    const sweep = await beads.epicCloseEligible(REPO, { apply: true });
    expect(onlyArgs()).toEqual(["epic", "close-eligible", "--json"]);
    expect(sweep.closed).toEqual(["probe-cb1"]);
    expect(issueSnapshotVersion(REPO)).toBe(before + 1);
  });
});

describe("beads.lintReport", () => {
  it("reads the board without writing to it", async () => {
    reply.stdout = LINT_JSON;
    const before = issueSnapshotVersion(REPO);
    const report = await beads.lintReport(REPO, { status: "all" });
    expect(onlyArgs()).toEqual(["lint", "--status", "all", "--json"]);
    expect(report.violations[0].id).toBe("probe-aje");
    expect(issueSnapshotVersion(REPO)).toBe(before);
  });
});

describe("beads.staleList", () => {
  it("sweeps one status at a time and returns ordinary beads", async () => {
    reply.stdout = STALE_JSON;
    const stale = await beads.staleList(REPO, { status: "in_progress", days: 7 });
    expect(onlyArgs()).toEqual([
      "stale",
      "--status",
      "in_progress",
      "--days",
      "7",
      "--limit",
      "0",
      "--json",
    ]);
    expect(stale.map((b) => b.id)).toEqual(["probe-old1", "probe-old2"]);
    expect(stale[1].assignee).toBe("someone");
  });

  it("reads the empty board", async () => {
    reply.stdout = "[]\n";
    expect(await beads.staleList(REPO)).toEqual([]);
  });
});

describe("beads.orphansList", () => {
  it("asks bd for orphans and NEVER passes --fix", async () => {
    reply.stdout = ORPHANS_JSON;
    const orphans = await beads.orphansList(REPO);
    expect(onlyArgs()).toEqual(["orphans", "--json"]);
    expect(onlyArgs()).not.toContain("--fix");
    expect(orphans[0].id).toBe("probe-vx2");
  });
});

describe("beads.depCycles", () => {
  it("asks bd for cycles", async () => {
    reply.stdout = "[]\n";
    expect(await beads.depCycles(REPO)).toEqual([]);
    expect(onlyArgs()).toEqual(["dep", "cycles", "--json"]);
  });
});

describe("beads.duplicateGroups", () => {
  it("reports duplicates and NEVER passes --auto-merge — merging is a judgment move", async () => {
    reply.stdout = DUPLICATES_JSON;
    const before = issueSnapshotVersion(REPO);
    const groups = await beads.duplicateGroups(REPO);
    expect(onlyArgs()).toEqual(["duplicates", "--json"]);
    expect(onlyArgs()).not.toContain("--auto-merge");
    expect(groups[0].target).toBe("probe-79b");
    expect(issueSnapshotVersion(REPO)).toBe(before);
  });
});

describe("beads.recomputeBlocked", () => {
  it("returns the rows it corrected and invalidates the snapshot — it commits", async () => {
    reply.stdout = RECOMPUTE_JSON;
    const before = issueSnapshotVersion(REPO);
    expect(await beads.recomputeBlocked(REPO)).toBe(3);
    expect(onlyArgs()).toEqual(["recompute-blocked", "--json"]);
    expect(issueSnapshotVersion(REPO)).toBe(before + 1);
  });
});

describe("the hygiene seam stays inside the safe verb set (anton-bci0)", () => {
  it("spawns bd in the repo it was GIVEN, never process.cwd()", async () => {
    const cwd = "/repos/some-other-project";
    expect(cwd).not.toBe(process.cwd());
    reply.stdout = "[]\n";
    await beads.depCycles(cwd);
    expect(spawned[0].options?.cwd).toBe(cwd);
  });

  it("never reaches for a mutating flag on a report verb", async () => {
    for (const [run, stdout] of [
      [() => beads.lintReport(REPO), LINT_CLEAN],
      [() => beads.staleList(REPO), "[]\n"],
      [() => beads.orphansList(REPO), "null\n"],
      [() => beads.depCycles(REPO), "[]\n"],
      [() => beads.duplicateGroups(REPO), '{"duplicate_groups": 0, "groups": []}'],
    ] as Array<[() => Promise<unknown>, string]>) {
      spawned.length = 0;
      reply.stdout = stdout;
      const before = issueSnapshotVersion(REPO);
      await run();
      expect(onlyArgs()).not.toContain("--fix");
      expect(onlyArgs()).not.toContain("--auto-merge");
      // A report verb that bumped the version would be writing to the board.
      expect(issueSnapshotVersion(REPO)).toBe(before);
    }
  });
});
