/**
 * Unit tests for the review-fix protocol helpers (anton-l6u): the concrete PR context handed to
 * claude (reviewFixContext) and the per-thread outcome report parsed back out (parseThreadReport).
 * The end-to-end flow is covered by review-fix.integration.test.ts.
 */
import { describe, expect, it } from "vitest";
import {
  buildReviewFixPrompt,
  CLUSTERED_FINDINGS_THRESHOLD,
  labelValue,
  NON_THREAD_REPORT_ID,
  parseThreadReport,
  reviewFixContext,
  triageOutcomes,
  type ThreadOutcome,
} from "./review-fix-context";
import { ANTON_MARK, type PrReview, type ReviewThread } from "../git/pr";
import type { Bead } from "../beads/bd";
import type { ProjectSettings } from "../projects";

const epic = { id: "anton-x1", title: "Ship X" } as Bead;

function makePr(overrides: Partial<PrReview> = {}): PrReview {
  return {
    number: 7,
    state: "OPEN",
    reviewDecision: "CHANGES_REQUESTED",
    mergeable: "MERGEABLE",
    headRefName: "anton/anton-x1",
    baseRefName: "main",
    headSha: "sha1",
    url: "https://github.com/acme/repo/pull/7",
    reviews: [],
    failingChecks: [],
    pendingChecks: 0,
    threads: [],
    threadsComplete: true,
    ...overrides,
  } as PrReview;
}

describe("buildReviewFixPrompt — reasoning attribution", () => {
  const pr = makePr();
  const settings = {} as ProjectSettings;

  it("names the shipped review-fix skill when no operator override is configured", async () => {
    const { attribution } = await buildReviewFixPrompt({
      epic,
      pr,
      reasons: ["failing checks"],
      conflicts: [],
      settings,
      projectDir: "/tmp/anton-review-fix-context-test-nonexistent",
    });
    expect(attribution).toMatchObject({ skillId: "review-fix", skillIsDefault: true });
    expect(attribution.skillDigest).toMatch(/^[0-9a-f]{12}$/);
    expect(attribution.promptBodyDigest).toBeUndefined();
  });

  it("digests the operator's own reviewFixPrompt text instead, when one is set", async () => {
    const override = { ...settings, reviewFixPrompt: "Resolve it MY way." } as ProjectSettings;
    const { attribution } = await buildReviewFixPrompt({
      epic,
      pr,
      reasons: ["failing checks"],
      conflicts: [],
      settings: override,
      projectDir: "/tmp/anton-review-fix-context-test-nonexistent",
    });
    expect(attribution.skillId).toBeUndefined();
    expect(attribution.promptBodyDigest).toMatch(/^[0-9a-f]{12}$/);
    // A different override text digests to a different stamp — the whole point of recording one.
    const { attribution: other } = await buildReviewFixPrompt({
      epic,
      pr,
      reasons: ["failing checks"],
      conflicts: [],
      settings: { ...settings, reviewFixPrompt: "Resolve it a THIRD way." } as ProjectSettings,
      projectDir: "/tmp/anton-review-fix-context-test-nonexistent",
    });
    expect(other.promptBodyDigest).not.toBe(attribution.promptBodyDigest);
  });

  // anton-pwekp: the follow-up round's prompt must actually carry the gate output, not just the
  // reasoning contract — this is what the agent sees when deciding what to fix.
  it("carries the gate label + output in the prompt when a gate just failed", async () => {
    const { prompt } = await buildReviewFixPrompt({
      epic,
      pr,
      reasons: ["the tests gate failed after the fix (exit 3)"],
      conflicts: [],
      gateFailure: { label: "tests", output: "boom-output" },
      settings,
      projectDir: "/tmp/anton-review-fix-context-test-nonexistent",
    });
    expect(prompt).toContain("## Gate failure (one follow-up round)");
    expect(prompt).toContain("tests gate failed after the fix above");
    expect(prompt).toContain("boom-output");
  });
});

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

  // anton-091jr review round 2 (chatgpt-codex-connector): a round with no inline threads is still
  // actionable (CI-only, conflict-only, or a reviewer summary with no inline comments) and must
  // still ask for a report — the sentinel entry is what proves claude actually addressed the
  // reason, rather than a successful-but-silent run being mistaken for one that did.
  it("asks for a sentinel-keyed report when there are no threads but the round is still actionable", () => {
    const out = reviewFixContext(epic, makePr({ failingChecks: ["build"] }), ["failing checks: build"]);
    expect(out).toContain("Failing CI checks: build.");
    expect(out).toContain("## Reporting format (required)");
    expect(out).toContain(NON_THREAD_REPORT_ID);
  });

  it("omits the reporting format entirely when there are no threads and no reasons", () => {
    const out = reviewFixContext(epic, makePr({ failingChecks: [] }), []);
    expect(out).not.toContain("## Reporting format (required)");
  });

  // PR #338 review (chatgpt-codex-connector): a round with BOTH inline threads and a non-thread
  // reason (a failing check here) must ask for the sentinel too, not just the per-thread report —
  // otherwise claude never has a chance to acknowledge the non-thread reason and
  // allWaitingThreadsAnswered can never see the positive evidence it requires for one.
  it("also asks for the sentinel-keyed entry when threads AND a non-thread reason are both present", () => {
    const threads: ReviewThread[] = [threadOn("src/a.ts", "RT_1")];
    const out = reviewFixContext(
      epic,
      makePr({ threads, failingChecks: ["build"] }),
      ["failing checks: build", "1 unresolved review thread(s)"],
      [],
      undefined,
      true,
    );
    expect(out).toContain('{"threads":[{"id":"<thread id>"');
    expect(out).toContain(NON_THREAD_REPORT_ID);
  });

  it("does not mention the sentinel when threads are present but nothing else is actionable", () => {
    const threads: ReviewThread[] = [threadOn("src/a.ts", "RT_1")];
    const out = reviewFixContext(epic, makePr({ threads }), ["1 unresolved review thread(s)"]);
    expect(out).toContain('{"threads":[{"id":"<thread id>"');
    expect(out).not.toContain(NON_THREAD_REPORT_ID);
  });

  it("lists merge conflicts when present", () => {
    const out = reviewFixContext(epic, makePr(), ["conflicts"], ["src/a.ts", "src/b.ts"]);
    expect(out).toContain("Merge conflicts:");
    expect(out).toContain("- src/a.ts");
    expect(out).toContain("- src/b.ts");
  });

  // anton-pwekp: the bounded follow-up round's own context, beside conflictsSection.
  it("includes the gate failure section when a gate just failed", () => {
    const out = reviewFixContext(epic, makePr(), ["gate failed"], [], {
      label: "tests",
      output: "boom-output",
    });
    expect(out).toContain("## Gate failure (one follow-up round)");
    expect(out).toContain("The tests gate failed after the fix above.");
    expect(out).toContain("boom-output");
  });

  it("omits the gate failure section when no gate failed", () => {
    const out = reviewFixContext(epic, makePr(), ["conflicts"], ["src/a.ts"]);
    expect(out).not.toContain("## Gate failure");
  });

  // PR #338 review (@claude): a gate-failure follow-up is the one bounded round the gate gets, not
  // a re-diagnosis of the review feedback — it must not carry the reviewer summaries, thread
  // listings, cluster callout, or a thread-report ask, even when the (pre-fix) `pr` snapshot still
  // has them. Nothing reads this dispatch's result text, so the reporting ask is pure noise here.
  it("trims the prompt to header + gate output when a gate just failed, even with threads/reviews present", () => {
    const threads: ReviewThread[] = Array.from({ length: CLUSTERED_FINDINGS_THRESHOLD }, (_, i) =>
      threadOn("src/broken.ts", `RT_${i}`),
    );
    const out = reviewFixContext(
      epic,
      makePr({
        threads,
        failingChecks: ["build"],
        reviews: [{ author: "alice", state: "CHANGES_REQUESTED", body: "rename foo to bar" }],
      }),
      ["the tests gate failed after the fix (exit 3)"],
      [],
      { label: "tests", output: "boom-output" },
    );
    expect(out).toContain("## Gate failure (one follow-up round)");
    expect(out).toContain("boom-output");
    expect(out).not.toContain("Reviewer summaries requesting changes:");
    expect(out).not.toContain("[thread RT_0]");
    expect(out).not.toContain("## Clustered findings");
    expect(out).not.toContain("Failing CI checks:");
    expect(out).not.toContain("## Reporting format (required)");
  });

  function threadOn(path: string, id: string): ReviewThread {
    return {
      id,
      isResolved: false,
      isOutdated: false,
      path,
      comments: [{ id: 1, author: "alice", body: "problem" }],
    };
  }

  it("names a path carrying at least the threshold count of findings, asking for root cause", () => {
    expect(CLUSTERED_FINDINGS_THRESHOLD).toBe(3);
    const threads = Array.from({ length: CLUSTERED_FINDINGS_THRESHOLD }, (_, i) =>
      threadOn("src/broken.ts", `RT_${i}`),
    );
    const out = reviewFixContext(epic, makePr({ threads }), ["unresolved review threads"]);
    expect(out).toContain("## Clustered findings");
    expect(out).toContain(`src/broken.ts (${CLUSTERED_FINDINGS_THRESHOLD} findings)`);
    expect(out).toContain("root cause");
  });

  it("omits the cluster section just below the threshold", () => {
    const threads = Array.from({ length: CLUSTERED_FINDINGS_THRESHOLD - 1 }, (_, i) =>
      threadOn("src/almost.ts", `RT_${i}`),
    );
    const out = reviewFixContext(epic, makePr({ threads }), ["unresolved review threads"]);
    expect(out).not.toContain("## Clustered findings");
  });

  it("omits the cluster section when findings are spread one per file", () => {
    const threads = [threadOn("src/a.ts", "RT_1"), threadOn("src/b.ts", "RT_2"), threadOn("src/c.ts", "RT_3")];
    const out = reviewFixContext(epic, makePr({ threads }), ["unresolved review threads"]);
    expect(out).not.toContain("## Clustered findings");
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

/**
 * The shared triage filter (anton-z5e3g): the outcomes anton ACTS ON. Two readers depend on it
 * answering identically — `applyThreadOutcomes` replies through it, `recordReviewRound` counts
 * through it — so what it admits is what makes a recorded fix count reconcile with the PR.
 */
describe("triageOutcomes", () => {
  const thread = (id: string, comments: Array<[string, string]>): ReviewThread => ({
    id,
    isResolved: false,
    isOutdated: false,
    comments: comments.map(([author, body], i) => ({ id: 100 + i, author, body })),
  });

  it("admits a reported thread that is waiting, with its opening comment as the anchor", () => {
    const pr = makePr({ threads: [thread("RT_1", [["alice", "rename foo"]])] });
    const triaged = triageOutcomes(pr, [{ id: "RT_1", outcome: "fixed" }], true);

    expect(triaged).toHaveLength(1);
    expect(triaged[0].thread.id).toBe("RT_1");
    // The REST id a reply/reaction anchors to — the thread's FIRST comment, not its last.
    expect(triaged[0].anchor.id).toBe(100);
  });

  it("drops a fabricated fix — a 'fixed' claim with nothing pushed", () => {
    const pr = makePr({ threads: [thread("RT_1", [["alice", "rename foo"]])] });
    expect(triageOutcomes(pr, [{ id: "RT_1", outcome: "fixed" }], false)).toEqual([]);
    // A decline is still a decline with nothing pushed: it is answered, and counted.
    expect(triageOutcomes(pr, [{ id: "RT_1", outcome: "left" }], false)).toHaveLength(1);
  });

  it("drops an outcome naming a thread that is not this round's to answer", () => {
    const pr = makePr({
      threads: [
        { ...thread("RT_resolved", [["alice", "nit"]]), isResolved: true },
        thread("RT_answered", [
          ["alice", "rename foo"],
          ["anton", `${ANTON_MARK} renamed`],
        ]),
        { ...thread("RT_empty", []) },
      ],
    });
    const report: ThreadOutcome[] = [
      { id: "RT_resolved", outcome: "fixed" },
      { id: "RT_answered", outcome: "fixed" },
      { id: "RT_empty", outcome: "fixed" },
      { id: "RT_invented", outcome: "fixed" },
    ];

    expect(triageOutcomes(pr, report, true)).toEqual([]);
  });

  it("preserves the reported order, so replies land as the fixer wrote them", () => {
    const pr = makePr({
      threads: [thread("RT_1", [["alice", "a"]]), thread("RT_2", [["bob", "b"]])],
    });
    const report: ThreadOutcome[] = [
      { id: "RT_2", outcome: "left" },
      { id: "RT_1", outcome: "fixed" },
    ];

    expect(triageOutcomes(pr, report, true).map((t) => t.item.id)).toEqual(["RT_2", "RT_1"]);
  });

  it("keeps only the first reported outcome for a duplicated thread id", () => {
    const pr = makePr({ threads: [thread("RT_1", [["alice", "rename foo"]])] });
    const report: ThreadOutcome[] = [
      { id: "RT_1", outcome: "left" },
      { id: "RT_1", outcome: "fixed" },
    ];

    const triaged = triageOutcomes(pr, report, true);
    expect(triaged).toHaveLength(1);
    expect(triaged[0].item.outcome).toBe("left");
  });
});
