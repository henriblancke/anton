/**
 * Unit tests for the review-fix protocol helpers (anton-l6u): the concrete PR context handed to
 * claude (reviewFixContext) and the per-thread outcome report parsed back out (parseThreadReport).
 * The end-to-end flow is covered by review-fix.integration.test.ts.
 */
import { describe, expect, it } from "vitest";
import { labelValue, parseThreadReport, reviewFixContext } from "./review-fix-context";
import type { PrReview } from "../git/pr";
import type { Bead } from "../beads/bd";

const epic = { id: "anton-x1", title: "Ship X" } as Bead;

function makePr(overrides: Partial<PrReview> = {}): PrReview {
  return {
    number: 7,
    state: "OPEN",
    reviewDecision: "CHANGES_REQUESTED",
    mergeable: "MERGEABLE",
    headRefName: "anton/anton-x1",
    url: "https://github.com/acme/repo/pull/7",
    reviews: [],
    failingChecks: [],
    pendingChecks: 0,
    threads: [],
    ...overrides,
  } as PrReview;
}

describe("labelValue", () => {
  it("returns the value after the prefix", () => {
    expect(labelValue(["agent:nextjs", "risk:low"], "agent")).toBe("nextjs");
  });
  it("returns undefined when absent or labels missing", () => {
    expect(labelValue(["risk:low"], "agent")).toBeUndefined();
    expect(labelValue(undefined, "agent")).toBeUndefined();
  });
});

describe("reviewFixContext", () => {
  it("always includes the epic/PR header and the reason", () => {
    const out = reviewFixContext(epic, makePr(), ["failing checks: build"]);
    expect(out).toContain("## This PR");
    expect(out).toContain("Epic: anton-x1 — Ship X");
    expect(out).toContain("PR: #7 (https://github.com/acme/repo/pull/7)");
    expect(out).toContain("Branch: anton/anton-x1");
    expect(out).toContain("Why this needs action: failing checks: build.");
  });

  it("lists reviewer summaries that requested changes (and skips empty bodies)", () => {
    const out = reviewFixContext(
      epic,
      makePr({
        reviews: [
          { author: "alice", state: "CHANGES_REQUESTED", body: "rename foo to bar" },
          { author: "bob", state: "CHANGES_REQUESTED", body: "   " },
          { author: "carol", state: "APPROVED", body: "lgtm" },
        ],
      }),
      ["reviewer requested changes"],
    );
    expect(out).toContain("Reviewer summaries requesting changes:");
    expect(out).toContain("- @alice: rename foo to bar");
    expect(out).not.toContain("@bob");
    expect(out).not.toContain("@carol");
  });

  it("surfaces unresolved threads with location + outdated marker and the report format", () => {
    const out = reviewFixContext(
      epic,
      makePr({
        threads: [
          {
            id: "RT_1",
            isResolved: false,
            isOutdated: true,
            path: "src/a.ts",
            line: 12,
            comments: [{ id: 100, author: "alice", body: "fix this" }],
          },
        ],
      }),
      ["unresolved review threads"],
    );
    expect(out).toContain("[thread RT_1] src/a.ts:12 (outdated diff)");
    expect(out).toContain("- @alice: fix this");
    expect(out).toContain("## Reporting format (required)");
    expect(out).toContain('{"threads":[{"id":"<thread id>"');
  });

  it("omits the reporting format when there are no threads", () => {
    const out = reviewFixContext(epic, makePr({ failingChecks: ["build"] }), ["failing checks: build"]);
    expect(out).toContain("Failing CI checks: build.");
    expect(out).not.toContain("## Reporting format (required)");
  });

  it("lists merge conflicts when present", () => {
    const out = reviewFixContext(epic, makePr(), ["conflicts"], ["src/a.ts", "src/b.ts"]);
    expect(out).toContain("Merge conflicts:");
    expect(out).toContain("- src/a.ts");
    expect(out).toContain("- src/b.ts");
  });
});

describe("parseThreadReport", () => {
  it("parses the fenced json report block", () => {
    const text = [
      "I renamed foo to bar and left the style nit.",
      "```json",
      '{"threads":[{"id":"RT_1","outcome":"fixed","reply":"renamed foo to bar"},{"id":"RT_2","outcome":"left","reply":"style-only; skipped"}]}',
      "```",
    ].join("\n");
    expect(parseThreadReport(text)).toEqual([
      { id: "RT_1", outcome: "fixed", reply: "renamed foo to bar" },
      { id: "RT_2", outcome: "left", reply: "style-only; skipped" },
    ]);
  });

  it("uses the LAST report block when several json blocks appear", () => {
    const text = [
      "```json",
      '{"threads":[{"id":"RT_stale","outcome":"fixed"}]}',
      "```",
      "actually, final report:",
      "```json",
      '{"threads":[{"id":"RT_1","outcome":"needs-human","reply":"product call needed"}]}',
      "```",
    ].join("\n");
    expect(parseThreadReport(text)).toEqual([
      { id: "RT_1", outcome: "needs-human", reply: "product call needed" },
    ]);
  });

  it("skips a trailing non-report json block and finds the report before it", () => {
    const text = [
      "```json",
      '{"threads":[{"id":"RT_1","outcome":"fixed"}]}',
      "```",
      "for reference, the config I touched:",
      "```json",
      '{"compilerOptions":{"strict":true}}',
      "```",
    ].join("\n");
    expect(parseThreadReport(text)).toEqual([{ id: "RT_1", outcome: "fixed" }]);
  });

  it("drops malformed entries but keeps valid ones", () => {
    const text = [
      "```json",
      '{"threads":[{"id":"RT_1","outcome":"fixed"},{"outcome":"left"},{"id":"RT_3","outcome":"maybe"},"junk"]}',
      "```",
    ].join("\n");
    expect(parseThreadReport(text)).toEqual([{ id: "RT_1", outcome: "fixed" }]);
  });

  it("returns [] for missing / malformed / absent reports", () => {
    expect(parseThreadReport(undefined)).toEqual([]);
    expect(parseThreadReport("all done, no threads to report")).toEqual([]);
    expect(parseThreadReport("```json\n{not json\n```")).toEqual([]);
    expect(parseThreadReport('```json\n{"threads":"nope"}\n```')).toEqual([]);
  });
});
