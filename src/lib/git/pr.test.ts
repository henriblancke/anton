/**
 * Unit tests for the pure PR helpers (anton-3t2.2): ref parsing, the actionable classifier, and
 * the re-request reviewer set. No `gh` — these are the decision functions the job relies on.
 *
 * A second suite below drives `getPrReview` against a fake `gh` to prove its GraphQL review-thread
 * fetch paginates rather than silently truncating at 100 nodes (the bug behind "examined N PRs,
 * dispatched 0" on a PR whose unresolved thread landed on page 2).
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GH_BIN_ENV } from "./ops";
import {
  ANTON_MARK,
  classifyReview,
  getPrReview,
  prNumberFromRef,
  reviewersRequestingChanges,
  threadsNeedingAttention,
  type PrReview,
  type ReviewThread,
} from "./pr";

function pr(overrides: Partial<PrReview> = {}): PrReview {
  return {
    number: 7,
    state: "OPEN",
    reviewDecision: null,
    mergeable: null,
    headRefName: "anton/epic-1",
    url: "https://github.com/o/r/pull/7",
    reviews: [],
    failingChecks: [],
    pendingChecks: 0,
    threads: [],
    ...overrides,
  };
}

function thread(overrides: Partial<ReviewThread> = {}): ReviewThread {
  return {
    id: "RT_1",
    isResolved: false,
    isOutdated: false,
    path: "src/a.ts",
    line: 3,
    comments: [{ id: 100, author: "alice", body: "rename foo to bar" }],
    ...overrides,
  };
}

describe("prNumberFromRef", () => {
  it("parses gh-<n> and pull urls", () => {
    expect(prNumberFromRef("gh-123")).toBe(123);
    expect(prNumberFromRef("https://github.com/o/r/pull/45")).toBe(45);
  });
  it("returns undefined for missing / non-PR refs", () => {
    expect(prNumberFromRef(undefined)).toBeUndefined();
    expect(prNumberFromRef("some-url")).toBeUndefined();
  });
});

describe("classifyReview", () => {
  it("is actionable when changes are requested", () => {
    const v = classifyReview(pr({ reviewDecision: "CHANGES_REQUESTED" }));
    expect(v.actionable).toBe(true);
    expect(v.reasons.join()).toMatch(/changes requested/);
  });

  it("is actionable when a check is failing", () => {
    const v = classifyReview(pr({ failingChecks: ["build", "lint"] }));
    expect(v.actionable).toBe(true);
    expect(v.reasons.join()).toMatch(/build, lint/);
  });

  it("is actionable when the branch conflicts with its base", () => {
    const v = classifyReview(pr({ mergeable: "CONFLICTING" }));
    expect(v.actionable).toBe(true);
    expect(v.reasons.join()).toMatch(/merge conflicts/);
  });

  it("is actionable when an unresolved thread awaits anton (even without CHANGES_REQUESTED)", () => {
    const v = classifyReview(pr({ threads: [thread()] }));
    expect(v.actionable).toBe(true);
    expect(v.reasons.join()).toMatch(/unresolved review thread/);
  });

  it("is NOT actionable when approved / clean / only pending", () => {
    expect(classifyReview(pr({ reviewDecision: "APPROVED" })).actionable).toBe(false);
    expect(classifyReview(pr({ pendingChecks: 3 })).actionable).toBe(false);
    expect(classifyReview(pr({ mergeable: "MERGEABLE" })).actionable).toBe(false);
    expect(classifyReview(pr()).actionable).toBe(false);
  });

  it("is NOT actionable for resolved threads or threads anton already replied to", () => {
    expect(classifyReview(pr({ threads: [thread({ isResolved: true })] })).actionable).toBe(false);
    const replied = thread({
      comments: [
        { id: 100, author: "alice", body: "rename foo to bar" },
        { id: 101, author: "anton", body: `${ANTON_MARK} left as-is: churn` },
      ],
    });
    expect(classifyReview(pr({ threads: [replied] })).actionable).toBe(false);
  });

  it("is NOT actionable when the PR is not open", () => {
    const v = classifyReview(pr({ state: "MERGED", reviewDecision: "CHANGES_REQUESTED" }));
    expect(v.actionable).toBe(false);
  });
});

describe("threadsNeedingAttention", () => {
  it("keeps unresolved threads and re-activates when a human replies after anton", () => {
    const backAndForth = thread({
      id: "RT_2",
      comments: [
        { id: 1, author: "alice", body: "fix this" },
        { id: 2, author: "anton", body: `${ANTON_MARK} left as-is` },
        { id: 3, author: "alice", body: "no, really fix it" },
      ],
    });
    const p = pr({ threads: [thread(), thread({ id: "RT_3", isResolved: true }), backAndForth] });
    expect(threadsNeedingAttention(p).map((t) => t.id)).toEqual(["RT_1", "RT_2"]);
  });
});

describe("reviewersRequestingChanges", () => {
  it("returns only reviewers whose latest state is CHANGES_REQUESTED", () => {
    const p = pr({
      reviews: [
        { author: "alice", state: "CHANGES_REQUESTED", body: "fix" },
        { author: "bob", state: "APPROVED", body: "" },
      ],
    });
    expect(reviewersRequestingChanges(p)).toEqual(["alice"]);
  });

  it("uses the latest review per author (approval supersedes earlier changes)", () => {
    const p = pr({
      reviews: [
        { author: "alice", state: "CHANGES_REQUESTED", body: "fix" },
        { author: "alice", state: "APPROVED", body: "lgtm now" },
      ],
    });
    expect(reviewersRequestingChanges(p)).toEqual([]);
  });
});

describe("getPrReview (fake gh)", () => {
  let sandbox: string;
  let binDir: string;
  let prevGh: string | undefined;

  // Fake gh: `pr view` answers a minimal OPEN PR; `api graphql` serves review threads two pages
  // deep — page 1 has no cursor and reports hasNextPage, page 2 is reached via `-f cursor=...` and
  // carries the one unresolved thread. A real >100-node PR looks exactly like this, just wider.
  function installFakeGh(): void {
    const fakeGh = join(binDir, "gh");
    writeFileSync(
      fakeGh,
      `#!/usr/bin/env node
const a = process.argv.slice(2);
if (a[0] === 'pr' && a[1] === 'view') {
  process.stdout.write(JSON.stringify({
    number: 7, state: 'OPEN', reviewDecision: null, mergeable: 'MERGEABLE',
    headRefName: 'anton/epic-1', url: 'https://github.com/o/r/pull/7',
    reviews: [], statusCheckRollup: [],
  }));
  process.exit(0);
}
if (a[0] === 'repo' && a[1] === 'view') {
  process.stdout.write('o/r\\n');
  process.exit(0);
}
if (a[0] === 'api' && a[1] === 'graphql') {
  const hasCursor = a.some((x) => x.startsWith('cursor='));
  if (!hasCursor) {
    process.stdout.write(JSON.stringify({ data: { repository: { pullRequest: { reviewThreads: {
      pageInfo: { hasNextPage: true, endCursor: 'PAGE2' },
      nodes: [{ id: 'RT_1', isResolved: true, isOutdated: false, path: 'a.ts', line: 1, comments: { nodes: [{ databaseId: 1, author: { login: 'bot' }, body: 'old, resolved' }] } }],
    } } } } }));
  } else {
    process.stdout.write(JSON.stringify({ data: { repository: { pullRequest: { reviewThreads: {
      pageInfo: { hasNextPage: false, endCursor: null },
      nodes: [{ id: 'RT_2', isResolved: false, isOutdated: false, path: 'b.ts', line: 5, comments: { nodes: [{ databaseId: 2, author: { login: 'alice' }, body: 'please fix' }] } }],
    } } } } }));
  }
  process.exit(0);
}
process.exit(0);
`,
    );
    chmodSync(fakeGh, 0o755);
  }

  beforeEach(() => {
    sandbox = mkdtempSync(join(tmpdir(), "anton-prreview-"));
    binDir = join(sandbox, "bin");
    mkdirSync(binDir);
    installFakeGh();
    prevGh = process.env[GH_BIN_ENV];
    process.env[GH_BIN_ENV] = join(binDir, "gh");
  });

  afterEach(() => {
    if (prevGh === undefined) delete process.env[GH_BIN_ENV];
    else process.env[GH_BIN_ENV] = prevGh;
    rmSync(sandbox, { recursive: true, force: true });
  });

  it("follows pageInfo.hasNextPage across review-thread pages instead of truncating at 100", async () => {
    const review = await getPrReview(sandbox, 7);
    expect(review.threads.map((t) => t.id)).toEqual(["RT_1", "RT_2"]);
    // The unresolved thread lived on page 2 — proving it actually reached the classifier is the
    // whole point: a truncated fetch would report this PR clean.
    expect(classifyReview(review).actionable).toBe(true);
  });
});
