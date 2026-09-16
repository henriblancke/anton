/**
 * Direct suite for hygiene.ts (anton-ql1n): the argv builders and parsers for bd's own hygiene
 * verbs, tested against the module itself. Fixtures are the same recorded-verbatim bd output used
 * by bd-hygiene.test.ts (bd 1.1.2 and the 1.1.0 floor, byte-identical on both —
 * .product/decisions/2026-07-28-bd-workflow-primitives.md); what's new here is that the parsers are
 * exercised directly rather than only through `beads.*` in ./bd.
 */
import { describe, expect, it } from "vitest";
import {
  buildLintArgs,
  buildStaleArgs,
  parseDepCycles,
  parseDuplicateGroups,
  parseEpicCloseEligible,
  parseLintReport,
  parseOrphans,
  parseRecomputeBlocked,
} from "@/lib/beads/hygiene";

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
  it("defaults to every status, bd's own window, and an unlimited result set", () => {
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

  it("refuses days < 1 up front, before a spawn bd would reject the same way", () => {
    expect(() => buildStaleArgs({ days: 0 })).toThrow(/--days must be an integer >= 1/);
    expect(() => buildStaleArgs({ days: 1.5 })).toThrow(/--days must be an integer >= 1/);
  });
});

describe("parseEpicCloseEligible", () => {
  const PREVIEW = `[
    {
      "epic": { "id": "probe-cb1", "title": "done epic", "status": "open" },
      "total_children": 1,
      "closed_children": 1,
      "eligible_for_close": true
    }
  ]`;
  const APPLIED = `{ "closed": ["probe-cb1"], "count": 1, "schema_version": 1 }`;
  const APPLIED_NOTHING = "[]";

  it("reads a preview into candidates with their child counts", () => {
    expect(parseEpicCloseEligible(PREVIEW, true)).toEqual({
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
    expect(parseEpicCloseEligible(APPLIED, false)).toEqual({ dryRun: false, eligible: [], closed: ["probe-cb1"] });
  });

  it("reads the applied-but-nothing-eligible case, where bd answers a bare []", () => {
    expect(parseEpicCloseEligible(APPLIED_NOTHING, false)).toEqual({ dryRun: false, eligible: [], closed: [] });
  });

  it("fails loud on an unreadable answer rather than reporting 'nothing to close'", () => {
    expect(() => parseEpicCloseEligible('{"count": 1}', false)).toThrow(/could not read its --json output/);
    expect(() => parseEpicCloseEligible("Error: boom\n", false)).toThrow(/output was not JSON/);
  });
});

describe("parseLintReport", () => {
  const LINT_JSON = `{
    "total": 2,
    "issues": 1,
    "results": [
      { "id": "probe-aje", "title": "broken thing", "type": "bug",
        "missing": ["## Steps to Reproduce", "## Acceptance Criteria"], "warnings": 2 }
    ]
  }`;
  const LINT_CLEAN = `{ "total": 0, "issues": 0, "results": null }`;

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

  it("handles the clean board, whose results is null rather than []", () => {
    expect(parseLintReport(LINT_CLEAN)).toEqual({ warnings: 0, issues: 0, violations: [] });
  });
});

describe("parseOrphans", () => {
  const ORPHANS_JSON = `[
    { "issue_id": "probe-vx2", "title": "no acceptance here", "status": "open",
      "latest_commit": "ba4d775", "latest_commit_message": "fix(probe-vx2): work" }
  ]`;

  it("normalises bd's issue_id to id and carries the commit it matched", () => {
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

  it("reads bd's empty answer, a bare null rather than []", () => {
    expect(parseOrphans("null\n")).toEqual([]);
  });
});

describe("parseDepCycles", () => {
  it("reads 'no cycle' — the only shape a real bd can be made to produce", () => {
    expect(parseDepCycles("[]\n")).toEqual([]);
  });

  it("reads a cycle, extracting ids from every encoding bd plausibly uses", () => {
    const raws: unknown[] = [
      ["a-1", "a-2"],
      { cycle: ["b-1", "b-2"] },
      { path: [{ id: "c-1" }, { id: "c-2" }] },
    ];
    expect(parseDepCycles(JSON.stringify(raws))).toEqual([
      { ids: ["a-1", "a-2"], raw: raws[0] },
      { ids: ["b-1", "b-2"], raw: raws[1] },
      { ids: ["c-1", "c-2"], raw: raws[2] },
    ]);
  });

  it("still reports a malformed cycle it cannot name ids for, rather than dropping it", () => {
    expect(parseDepCycles(JSON.stringify([{ weird: 1 }]))).toEqual([{ ids: [], raw: { weird: 1 } }]);
  });

  it("throws on a non-array top level rather than treating it as cycle-free", () => {
    expect(() => parseDepCycles('{"not": "an array"}')).toThrow(
      /could not read its --json output/,
    );
  });
});

describe("parseDuplicateGroups", () => {
  const DUPLICATES_JSON = `{
    "duplicate_groups": 1,
    "groups": [
      {
        "issues": [
          { "id": "probe-79b", "is_merge_target": true, "priority": 2, "references": 0, "status": "open", "title": "same title" },
          { "id": "probe-7es", "is_merge_target": false, "priority": 2, "references": 0, "status": "open", "title": "same title" }
        ],
        "note": "Duplicate: probe-7es (same content as probe-79b)",
        "suggested_action": "bd close probe-7es",
        "suggested_sources": ["probe-7es"],
        "suggested_target": "probe-79b",
        "title": "same title"
      }
    ]
  }`;

  it("reads the envelope into groups with their merge target and members", () => {
    expect(parseDuplicateGroups(DUPLICATES_JSON)).toEqual([
      {
        title: "same title",
        target: "probe-79b",
        sources: ["probe-7es"],
        note: "Duplicate: probe-7es (same content as probe-79b)",
        suggestedAction: "bd close probe-7es",
        members: [
          { id: "probe-79b", title: "same title", status: "open", priority: 2, references: 0, isMergeTarget: true },
          { id: "probe-7es", title: "same title", status: "open", priority: 2, references: 0, isMergeTarget: false },
        ],
      },
    ]);
  });

  it("reads an empty groups list", () => {
    expect(parseDuplicateGroups('{"duplicate_groups": 0, "groups": []}')).toEqual([]);
  });
});

describe("parseRecomputeBlocked", () => {
  it("reads rows_corrected", () => {
    expect(parseRecomputeBlocked('{"rows_corrected": 3, "schema_version": 1}')).toBe(3);
  });

  it("throws rather than silently reporting 0 repairs on an unreadable answer", () => {
    expect(() => parseRecomputeBlocked('{"schema_version": 1}')).toThrow(/could not read rows_corrected/);
  });
});
