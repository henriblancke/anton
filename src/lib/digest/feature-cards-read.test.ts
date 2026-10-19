/**
 * `digestFeatureGroups` (anton-y1uxp): the wiring that turns a seeded board plus a window of
 * timeline events into the digest's grouped feature cards — proving each card's cost actually comes
 * off `feature-ledger-read.ts`, its PR resolves through the real `git/remote.ts` attach helper, and
 * a feature outside the window contributes no card at all.
 *
 * The pure fold (`featureCardOf`/`groupFeatureCards`) and the per-field rules are already exhaustively
 * covered by feature-cards.test.ts; this file's job, like feature-ledger-read.test.ts's own, is only
 * to prove the wiring: the right board, the right ledger, the right base URL.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { beads, type Bead } from "../beads/bd";
import { resetIssueSnapshots } from "../beads/snapshot";
import * as schema from "../db/schema";
import type { TimelineEvent } from "../timeline";
import { makeProjectDb, type TestProjectDb } from "../testing/project";
import { digestFeatureGroups } from "./feature-cards-read";

vi.mock("../git/remote", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../git/remote")>();
  return { ...actual, githubBaseUrl: vi.fn(async () => "https://github.com/acme/repo") };
});

const bead = (over: Partial<Bead> & { id: string }): Bead =>
  ({ title: over.id, status: "open", issue_type: "feature", labels: [], ...over }) as Bead;

const BOARD: Bead[] = [
  bead({ id: "feat-1", external_ref: "gh-218" }),
  bead({ id: "feat-2", labels: ["outcome:codebase-health"] }),
];

function fakeBoard(board: Bead[]) {
  return vi.spyOn(beads, "list").mockImplementation(async () => [...board]);
}

function fakeThread() {
  return vi.spyOn(beads, "showWithComments").mockImplementation(async (_cwd, id) => ({
    ...bead({ id }),
    comments: [],
  }));
}

let t: TestProjectDb;
let seq = 0;

function eventOf(featureId: string, overrides: Partial<TimelineEvent> = {}): TimelineEvent {
  seq += 1;
  return {
    at: seq,
    projectId: t.projectId,
    featureId,
    kind: "run.finished",
    data: {},
    sourceRefs: [`src-${seq}`],
    ...overrides,
  };
}

beforeEach(() => {
  resetIssueSnapshots();
  t = makeProjectDb({ repoPath: "/repo" });
  fakeThread();
});
afterEach(() => vi.restoreAllMocks());

describe("digestFeatureGroups", () => {
  it("is undefined for a project id this anton.db does not carry", async () => {
    fakeBoard(BOARD);
    expect(await digestFeatureGroups(t.db, "no-such-project", [])).toBeUndefined();
  });

  it("builds no card for a feature the window never mentions", async () => {
    fakeBoard(BOARD);
    const groups = await digestFeatureGroups(t.db, t.projectId, []);
    expect(groups).toEqual([]);
  });

  it("resolves a feature's real cost off the ledger, and groups by its outcome label", async () => {
    fakeBoard(BOARD);
    await t.db.insert(schema.claudeInvocations).values({
      id: "i1",
      projectId: t.projectId,
      jobType: "execute-epic",
      step: "implement",
      stepHandler: "implement",
      runId: "r1",
      beadId: "feat-1",
      modelRequested: "claude-opus-5",
      modelReported: "claude-opus-5",
      // A null endpointHost means "unknown billing mode" and prices as nothing on purpose
      // (model-pricing.ts's `resolvePrice`) — name the direct API host to get a real figure.
      endpointHost: "api.anthropic.com",
      inputTokens: 1000,
      outputTokens: 1000,
      outcome: "ok",
      recordedAt: new Date("2026-09-20T09:10:00Z"),
      durationMs: 60_000,
    });

    const events = [eventOf("feat-1"), eventOf("feat-2")];
    const groups = await digestFeatureGroups(t.db, t.projectId, events);

    expect(groups).toBeDefined();
    // feat-1 names no outcome at all -> unlinked; feat-2 names the built-in codebase-health outcome
    // -> housekeeping. Both groups render, ordered unlinked-then-housekeeping.
    expect(groups!.map((g) => g.kind)).toEqual(["unlinked", "housekeeping"]);

    const feat1 = groups!.find((g) => g.kind === "unlinked")!.cards[0]!;
    expect(feat1.id).toBe("feat-1");
    expect(feat1.costUsd).toBeGreaterThan(0);
    // `external_ref: "gh-218"` resolves as a PR pointer, and the mocked base turns it into a URL.
    expect(feat1.prRef).toBe("gh-218");
    expect(feat1.prUrl).toBe("https://github.com/acme/repo/pull/218");

    const feat2 = groups!.find((g) => g.kind === "housekeeping")!.cards[0]!;
    expect(feat2.id).toBe("feat-2");
    // No invocation rows recorded for feat-2 -> nothing to price, never a fabricated $0.
    expect(feat2.costUsd).toBeUndefined();
  });

  it("accepts the caller's own board snapshot instead of re-fetching one", async () => {
    const spy = fakeBoard(BOARD);
    await digestFeatureGroups(t.db, t.projectId, [eventOf("feat-1")], { board: BOARD });
    expect(spy).not.toHaveBeenCalled();
  });
});
