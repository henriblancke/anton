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
    headSha: "sha1",
    url: "https://github.com/o/r/pull/7",
    reviews: [],
    failingChecks: [],
    failingCheckAttempts: [],
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

  // anton-091jr review round 6 (chatgpt-codex-connector): a conflict-only round must add a
  // non-`base:*`/`thread:*` fingerprint entry, or `fingerprintHasNonThreadReasons` (review-fix.ts)
  // sees only the cache-busting `base:*` entry and treats it as having no non-thread reason at all.
  it("adds a non-base fingerprint entry for merge conflicts, keyed on the head sha", () => {
    const before = classifyReview(pr({ mergeable: "CONFLICTING", headSha: "sha1" }));
    expect(before.fingerprint).toContain("conflict:sha1");
    const after = classifyReview(pr({ mergeable: "CONFLICTING", headSha: "sha2" }));
    expect(after.fingerprint).toContain("conflict:sha2");
    expect(before.fingerprint).not.toEqual(after.fingerprint);
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

  // anton-091jr: a repeat CHANGES_REQUESTED review whose body adds no new inline comments must
  // still change `reasons` — that's what lifts enqueueReviewFixPrIfAbsent's answered-unchanged
  // suppression (anton-dfuvz) for a genuinely new review.
  it("changes reasons when a second CHANGES_REQUESTED review arrives, even with the same decision", () => {
    const first = classifyReview(
      pr({
        reviewDecision: "CHANGES_REQUESTED",
        reviews: [{ author: "alice", state: "CHANGES_REQUESTED", body: "fix this" }],
      }),
    );
    const second = classifyReview(
      pr({
        reviewDecision: "CHANGES_REQUESTED",
        reviews: [
          { author: "alice", state: "CHANGES_REQUESTED", body: "fix this" },
          { author: "alice", state: "CHANGES_REQUESTED", body: "still not fixed" },
        ],
      }),
    );
    expect(first.reasons).not.toEqual(second.reasons);
    expect(second.reasons.join()).toMatch(/2 review\(s\)/);
  });

  // anton-091jr review (chatgpt-codex-connector): `reasons` is coarse display text (a count) and
  // must NOT be what the answered-suppression fingerprint keys on — a new reply on an
  // already-counted thread has to change the fingerprint even though the count doesn't.
  it("changes fingerprint (but not reasons) when a thread gets a new reply, same count", () => {
    const before = classifyReview(pr({ threads: [thread({ comments: [{ id: 100, author: "alice", body: "x" }] })] }));
    const after = classifyReview(pr({ threads: [thread({ comments: [{ id: 100, author: "alice", body: "x" }, { id: 101, author: "alice", body: "still broken" }] })] }));
    expect(before.reasons).toEqual(after.reasons);
    expect(before.fingerprint).not.toEqual(after.fingerprint);
    expect(after.fingerprint).toContain("thread:RT_1:101");
  });

  it("fingerprint is stable regardless of thread ordering", () => {
    const t1 = thread({ id: "RT_1", comments: [{ id: 1, author: "alice", body: "a" }] });
    const t2 = thread({ id: "RT_2", comments: [{ id: 2, author: "alice", body: "b" }] });
    const a = classifyReview(pr({ threads: [t1, t2] }));
    const b = classifyReview(pr({ threads: [t2, t1] }));
    expect(a.fingerprint).toEqual(b.fingerprint);
  });

  // anton-091jr review round 2 (chatgpt-codex-connector): a check rerun at the same head, same
  // name, keeps `reasons` identical (display text is name-only) but must still change the
  // fingerprint — otherwise a fresh failure with different output gets matched against a stale
  // "answered" row from the PRIOR run of the same check.
  it("changes fingerprint (but not reasons) when a failing check reruns with a new attempt id, same name", () => {
    const before = classifyReview(
      pr({ failingChecks: ["build"], failingCheckAttempts: ["build@https://ci/run/1"] }),
    );
    const after = classifyReview(
      pr({ failingChecks: ["build"], failingCheckAttempts: ["build@https://ci/run/2"] }),
    );
    expect(before.reasons).toEqual(after.reasons);
    expect(before.fingerprint).not.toEqual(after.fingerprint);
    expect(after.fingerprint).toContain("check:build@https://ci/run/2");
  });

  // anton-091jr review round 2 (chatgpt-codex-connector): a CI provider can reuse the same
  // detailsUrl/targetUrl across reruns — the fingerprint must still change on the timestamp so a
  // check that goes green and fails again at the same head isn't matched against a stale row.
  it("changes fingerprint when only the timestamp differs and the check URL is reused", () => {
    const before = classifyReview(
      pr({
        failingChecks: ["build"],
        failingCheckAttempts: ["build@https://ci/run/1|2026-01-01T00:00:00Z"],
      }),
    );
    const after = classifyReview(
      pr({
        failingChecks: ["build"],
        failingCheckAttempts: ["build@https://ci/run/1|2026-01-02T00:00:00Z"],
      }),
    );
    expect(before.fingerprint).not.toEqual(after.fingerprint);
  });

  it("check fingerprint falls back to the plain name when no attempt identity is available", () => {
    const v = classifyReview(pr({ failingChecks: ["build", "lint"] }));
    expect(v.fingerprint).toEqual(["check:build", "check:lint", "base:unknown"]);
  });

  // anton-091jr review round 5 (chatgpt-codex-connector): the review-fix worker unconditionally
  // premerges the base before running gates, so the base tip must enter the fingerprint for EVERY
  // actionable reason, not just CONFLICTING — otherwise a mergeable PR with an answered/no-push
  // round keeps matching a stale answered row even after the base (and thus what gets premerged
  // and verified) has moved on.
  it("changes fingerprint when only the base tip advances, reasons and everything else unchanged", () => {
    const before = classifyReview(
      pr({ reviewDecision: "CHANGES_REQUESTED", reviews: [{ author: "alice", state: "CHANGES_REQUESTED", body: "fix" }], baseRefOid: "base1" }),
    );
    const after = classifyReview(
      pr({ reviewDecision: "CHANGES_REQUESTED", reviews: [{ author: "alice", state: "CHANGES_REQUESTED", body: "fix" }], baseRefOid: "base2" }),
    );
    expect(before.reasons).toEqual(after.reasons);
    expect(before.fingerprint).not.toEqual(after.fingerprint);
    expect(after.fingerprint).toContain("base:base2");
  });

  // anton-091jr review round 2 (chatgpt-codex-connector): a dismissed review followed by a
  // DIFFERENT reviewer requesting changes at the same head can return the same count — the
  // fingerprint must key on the requesting review's own identity, not just how many there are.
  it("changes fingerprint (but not the count in reasons) when a different reviewer requests changes", () => {
    const first = classifyReview(
      pr({
        reviewDecision: "CHANGES_REQUESTED",
        reviews: [
          { author: "alice", state: "CHANGES_REQUESTED", body: "fix", id: "PRR_1", submittedAt: "2026-01-01T00:00:00Z" },
        ],
      }),
    );
    const second = classifyReview(
      pr({
        reviewDecision: "CHANGES_REQUESTED",
        reviews: [
          { author: "bob", state: "CHANGES_REQUESTED", body: "also fix", id: "PRR_2", submittedAt: "2026-01-02T00:00:00Z" },
        ],
      }),
    );
    expect(first.reasons).toEqual(second.reasons);
    expect(first.fingerprint).not.toEqual(second.fingerprint);
  });

  // anton-091jr review round 3 (chatgpt-codex-connector): editing an already-submitted
  // CHANGES_REQUESTED review's body leaves its id, author, submittedAt, and the PR head all
  // unchanged, so the fingerprint must key on the body too — otherwise the amended feedback matches
  // a stale answered row and the dispatcher suppresses it forever.
  it("changes fingerprint when a review's body is edited with id/author/submittedAt unchanged", () => {
    const before = classifyReview(
      pr({
        reviewDecision: "CHANGES_REQUESTED",
        reviews: [
          { author: "alice", state: "CHANGES_REQUESTED", body: "fix this", id: "PRR_1", submittedAt: "2026-01-01T00:00:00Z" },
        ],
      }),
    );
    const after = classifyReview(
      pr({
        reviewDecision: "CHANGES_REQUESTED",
        reviews: [
          { author: "alice", state: "CHANGES_REQUESTED", body: "fix this instead, and also that", id: "PRR_1", submittedAt: "2026-01-01T00:00:00Z" },
        ],
      }),
    );
    expect(before.reasons).toEqual(after.reasons);
    expect(before.fingerprint).not.toEqual(after.fingerprint);
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

  it("preserves already-fetched pages when a later page fails", async () => {
    // Overwrite the fake gh so page 2 errors (page 1 still reports hasNextPage) — the first page's
    // unresolved thread must survive rather than the whole fetch collapsing to [].
    const fakeGh = join(binDir, "gh");
    writeFileSync(
      fakeGh,
      `#!/usr/bin/env node
const a = process.argv.slice(2);
if (a[0] === 'repo' && a[1] === 'view') { process.stdout.write('o/r\\n'); process.exit(0); }
if (a[0] === 'pr' && a[1] === 'view') {
  process.stdout.write(JSON.stringify({
    number: 7, state: 'OPEN', reviewDecision: null, mergeable: 'MERGEABLE',
    headRefName: 'anton/epic-1', url: 'https://github.com/o/r/pull/7',
    reviews: [], statusCheckRollup: [],
  }));
  process.exit(0);
}
if (a[0] === 'api' && a[1] === 'graphql') {
  const hasCursor = a.some((x) => x.startsWith('cursor='));
  if (!hasCursor) {
    process.stdout.write(JSON.stringify({ data: { repository: { pullRequest: { reviewThreads: {
      pageInfo: { hasNextPage: true, endCursor: 'PAGE2' },
      nodes: [{ id: 'RT_1', isResolved: false, isOutdated: false, path: 'a.ts', line: 1, comments: { nodes: [{ databaseId: 1, author: { login: 'alice' }, body: 'please fix' }] } }],
    } } } } }));
    process.exit(0);
  }
  process.stderr.write('boom');
  process.exit(1);
}
process.exit(0);
`,
    );
    chmodSync(fakeGh, 0o755);

    const review = await getPrReview(sandbox, 7);
    expect(review.threads.map((t) => t.id)).toEqual(["RT_1"]);
    expect(classifyReview(review).actionable).toBe(true);
  });

  it("pairs each failing check's name with its own detailsUrl in failingCheckAttempts", async () => {
    const fakeGh = join(binDir, "gh");
    writeFileSync(
      fakeGh,
      `#!/usr/bin/env node
const a = process.argv.slice(2);
if (a[0] === 'repo' && a[1] === 'view') { process.stdout.write('o/r\\n'); process.exit(0); }
if (a[0] === 'pr' && a[1] === 'view') {
  process.stdout.write(JSON.stringify({
    number: 7, state: 'OPEN', reviewDecision: null, mergeable: 'MERGEABLE',
    headRefName: 'anton/epic-1', url: 'https://github.com/o/r/pull/7',
    reviews: [],
    statusCheckRollup: [
      { __typename: 'CheckRun', name: 'build', status: 'COMPLETED', conclusion: 'FAILURE', detailsUrl: 'https://ci/run/42' },
    ],
  }));
  process.exit(0);
}
if (a[0] === 'api' && a[1] === 'graphql') {
  process.stdout.write(JSON.stringify({ data: { repository: { pullRequest: { reviewThreads: {
    pageInfo: { hasNextPage: false, endCursor: null }, nodes: [],
  } } } } }));
  process.exit(0);
}
process.exit(0);
`,
    );
    chmodSync(fakeGh, 0o755);

    const review = await getPrReview(sandbox, 7);
    expect(review.failingChecks).toEqual(["build"]);
    expect(review.failingCheckAttempts).toEqual(["build@https://ci/run/42"]);
  });

  // anton-091jr review round 2 (chatgpt-codex-connector): a provider that reuses the same
  // detailsUrl across reruns still changes completedAt — both must ride in the attempt id, not
  // just whichever of the two happens to come first in the `||` chain.
  it("composes detailsUrl and completedAt in failingCheckAttempts rather than picking one", async () => {
    const fakeGh = join(binDir, "gh");
    writeFileSync(
      fakeGh,
      `#!/usr/bin/env node
const a = process.argv.slice(2);
if (a[0] === 'repo' && a[1] === 'view') { process.stdout.write('o/r\\n'); process.exit(0); }
if (a[0] === 'pr' && a[1] === 'view') {
  process.stdout.write(JSON.stringify({
    number: 7, state: 'OPEN', reviewDecision: null, mergeable: 'MERGEABLE',
    headRefName: 'anton/epic-1', url: 'https://github.com/o/r/pull/7',
    reviews: [],
    statusCheckRollup: [
      { __typename: 'CheckRun', name: 'build', status: 'COMPLETED', conclusion: 'FAILURE', detailsUrl: 'https://ci/run/42', completedAt: '2026-01-01T00:00:00Z' },
    ],
  }));
  process.exit(0);
}
if (a[0] === 'api' && a[1] === 'graphql') {
  process.stdout.write(JSON.stringify({ data: { repository: { pullRequest: { reviewThreads: {
    pageInfo: { hasNextPage: false, endCursor: null }, nodes: [],
  } } } } }));
  process.exit(0);
}
process.exit(0);
`,
    );
    chmodSync(fakeGh, 0o755);

    const review = await getPrReview(sandbox, 7);
    expect(review.failingCheckAttempts).toEqual([
      "build@https://ci/run/42|2026-01-01T00:00:00Z",
    ]);
  });
});
