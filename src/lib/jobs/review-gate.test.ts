/**
 * Unit tests for the pre-PR self-review gate's converge loop (anton-cbak), driven by a FAKE claude
 * driver: a scripted queue of replies plus the prompts each dispatch received. The db is real (an
 * in-memory anton.db) so "each review and each fix is its own recorded session" is asserted on the
 * rows the UI reads, not on a spy.
 *
 * The verify gates are deliberately left unconfigured here: `runVerifyGates` takes the host-wide
 * verify-gate lock and shells out, which belongs to the execute-epic integration suite (anton-omum),
 * not to a loop test.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { asc } from "drizzle-orm";

import { makeTestDb, type TestDb } from "../db/testing";
import { schema } from "../db";
import type { Bead } from "../beads/bd";
import type { ClaudeResult, RunClaudeOptions } from "../claude/driver";
import type { BranchDiff } from "../git/ops";
import type { ProjectSettings } from "../projects";
import { UsageLimitError, isPoisonError } from "./errors";
import type { Clock } from "./queue";
import {
  blockingFindings,
  runReviewGate,
  type ReviewGateContext,
  type ReviewGateResult,
} from "./review-gate";

/** Ticks a second per read, so `sessions.startedAt` orders the gate's sessions deterministically. */
class TickingClock implements Clock {
  constructor(private t: number) {}
  now() {
    this.t += 1000;
    return this.t;
  }
}

const target: Bead = {
  id: "anton-gate1",
  title: "Ship the gate",
  status: "in_progress",
  issue_type: "epic",
  description: "## Goal\n\nThe gate ships.\n\n## Acceptance\n\n- [ ] it converges\n",
};

const ticket: Bead = {
  id: "anton-gate1.1",
  title: "Build the loop",
  status: "closed",
  issue_type: "task",
  parent: "anton-gate1",
  description: "## Goal\n\nA bounded loop.\n\n## Acceptance\n\n- [ ] bounded\n",
};

const diff: BranchDiff = {
  files: ["src/lib/jobs/review-gate.ts"],
  patch: "diff --git a/src/lib/jobs/review-gate.ts\n+export const runReviewGate = () => null;\n",
  truncated: false,
};

/** A reviewer report in the protocol's shape, as claude's final message would carry it. */
function report(score: number, findings: Array<{ severity: string; location: string; note: string }>): string {
  return ["reviewed.", "```json", JSON.stringify({ score, rationale: `scored ${score}`, findings }), "```"].join("\n");
}

const BLOCKING = { severity: "blocking", location: "src/a.ts:4", note: "the loop is unbounded" };
const ADVISORY = { severity: "advisory", location: "src/a.ts:9", note: "the name could be clearer" };

/**
 * A scripted claude: each reply is consumed in dispatch order. A string is a successful final
 * message, an Error is thrown as-is, and a ClaudeResult is returned verbatim (how a failed dispatch
 * that still returned looks).
 */
type ScriptedReply = string | Error | ClaudeResult;

function fakeClaude(replies: ScriptedReply[]) {
  const calls: RunClaudeOptions[] = [];
  const run = async (options: RunClaudeOptions): Promise<ClaudeResult> => {
    calls.push(options);
    const next = replies[calls.length - 1];
    if (next === undefined) throw new Error(`unscripted claude dispatch #${calls.length}`);
    if (next instanceof Error) throw next;
    return typeof next === "string" ? { ok: true, text: next } : next;
  };
  return { run, calls };
}

let dir: string;
let tdb: TestDb;
let projectId: string;
let priorSessionsRoot: string | undefined;
const clock = new TickingClock(1_700_000_000_000);
const ctx: ReviewGateContext = {
  signal: new AbortController().signal,
  heartbeat: async () => {},
  report: () => {},
};

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "anton-review-gate-"));
  priorSessionsRoot = process.env.ANTON_SESSIONS_ROOT;
  process.env.ANTON_SESSIONS_ROOT = join(dir, "sessions");
  tdb = makeTestDb();
  projectId = randomUUID();
  await tdb.db.insert(schema.projects).values({
    id: projectId,
    slug: "sandbox",
    name: "sandbox",
    repoPath: dir,
    defaultBranch: "main",
  });
});

afterEach(() => {
  tdb.close();
  if (priorSessionsRoot === undefined) delete process.env.ANTON_SESSIONS_ROOT;
  else process.env.ANTON_SESSIONS_ROOT = priorSessionsRoot;
  rmSync(dir, { recursive: true, force: true });
});

/**
 * An in-memory stand-in for the worktree the read-only guard fingerprints. `mutateOn` names the
 * claude dispatches (1-based) after which the tree "changed" — how a reviewer that edits the code it
 * is judging looks to the gate. `commitOn` names the dispatches after which the agent COMMITTED its
 * write: HEAD moves and the tree reads clean, which is the shape a later `settleBaseline` cannot
 * tell from a settled worktree.
 */
function fakeWorktree(mutateOn: number[] = [], initialStatus = "", commitOn: number[] = []) {
  const state = { head: "c0ffee", status: initialStatus };
  const restores: string[] = [];
  let dispatches = 0;
  let commits = 0;
  return {
    restores,
    /** Called by the fake claude, so a "mutation" lands between the guard's before/after reads. */
    onDispatch: () => {
      dispatches += 1;
      if (mutateOn.includes(dispatches)) state.status = `?? reviewer-edit-${dispatches}.ts`;
      if (commitOn.includes(dispatches)) {
        state.head = `r0gue${dispatches}`;
        state.status = "";
      }
    },
    /** Mirrors `commitAll`: a committed fix advances HEAD and leaves the tree clean. */
    onCommit: () => {
      commits += 1;
      state.head = `c0mm1t${commits}`;
      state.status = "";
    },
    readState: async () => ({ ...state }),
    restoreState: async (_path: string, to: { head: string; status: string }) => {
      restores.push(state.status);
      state.status = to.status;
      state.head = to.head;
    },
  };
}

/** Run the gate against the fake driver. `commits` scripts each fix session's commit verdict. */
function gate(
  replies: ScriptedReply[],
  settings: ProjectSettings = {},
  commits: boolean[] = [],
  worktree = fakeWorktree(),
): {
  result: Promise<ReviewGateResult>;
  calls: RunClaudeOptions[];
  commitMessages: string[];
  restores: string[];
  /** The worktree's dirt as each round's diff was read — the review must see a settled tree. */
  diffStates: string[];
} {
  const { run, calls } = fakeClaude(replies);
  const commitMessages: string[] = [];
  const diffStates: string[] = [];
  const result = runReviewGate({
    db: tdb.db,
    clock,
    ctx,
    projectId,
    target,
    tickets: [ticket],
    settings,
    worktreePath: dir,
    baseBranch: "main",
    deps: {
      runClaude: async (options) => {
        worktree.onDispatch();
        return run(options);
      },
      diff: async () => {
        diffStates.push((await worktree.readState()).status);
        return diff;
      },
      commit: async (_path, message) => {
        commitMessages.push(message);
        const committed = commits[commitMessages.length - 1] ?? true;
        if (committed) worktree.onCommit();
        return { committed };
      },
      readState: worktree.readState,
      restoreState: worktree.restoreState,
    },
  });
  return { result, calls, commitMessages, restores: worktree.restores, diffStates };
}

/** The recorded sessions in start order — the UI's view of the gate. */
async function sessionKinds(): Promise<Array<{ kind: string; status: string; beadId: string | null }>> {
  const rows = await tdb.db.select().from(schema.sessions).orderBy(asc(schema.sessions.startedAt));
  return rows.map((r) => ({ kind: r.kind, status: r.status, beadId: r.beadId ?? null }));
}

describe("runReviewGate — convergence", () => {
  it("stops after one review when nothing blocking is reported", async () => {
    const { result, calls, commitMessages } = gate([report(9, [ADVISORY])]);
    const out = await result;

    expect(out.outcome).toBe("clean");
    expect(out.score).toBe(9);
    expect(out.rounds).toHaveLength(1);
    expect(out.rounds[0]).toMatchObject({ round: 1, score: 9, rationale: "scored 9", blocking: 0, advisory: 1 });
    expect(out.rounds[0].fixSessionId).toBeUndefined();
    // Advisory findings are still returned — the call-site surfaces them, it does not park on them.
    expect(out.unresolved).toEqual([
      { severity: "advisory", location: "src/a.ts:9", note: "the name could be clearer" },
    ]);
    expect(blockingFindings(out.unresolved)).toEqual([]);
    expect(calls).toHaveLength(1); // one review, no fix
    expect(commitMessages).toEqual([]);
  });

  it("fixes a blocking finding, re-reviews, and converges — every round's score recorded", async () => {
    const { result, calls, commitMessages } = gate([
      report(4, [BLOCKING, ADVISORY]),
      "fixed the loop bound",
      report(9, [ADVISORY]),
    ]);
    const out = await result;

    expect(out.outcome).toBe("clean");
    expect(out.rounds.map((r) => r.score)).toEqual([4, 9]);
    expect(out.rounds[0]).toMatchObject({ blocking: 1, advisory: 1, fixCommitted: true });
    expect(out.rounds[0].fixSessionId).toBeTruthy();
    expect(out.score).toBe(9);
    expect(blockingFindings(out.unresolved)).toEqual([]);
    expect(calls).toHaveLength(3); // review → fix → review
    expect(commitMessages).toEqual(["anton-gate1: address self-review findings (round 1)"]);
  });

  it("dispatches only the BLOCKING findings to the fix session", async () => {
    const { result, calls } = gate([report(4, [BLOCKING, ADVISORY]), "fixed", report(8, [])]);
    await result;

    expect(calls[1].prompt).toContain("the loop is unbounded");
    expect(calls[1].prompt).not.toContain("the name could be clearer");
    // The fixer runs under the layered execution contract; the reviewer never does (below).
    expect(calls[1].appendSystemPrompt).toBeTruthy();
  });
});

describe("runReviewGate — bounds", () => {
  it("stops at reviewMaxRounds with the unresolved findings rather than looping forever", async () => {
    const stubborn = report(5, [BLOCKING, ADVISORY]);
    const { result, calls, commitMessages } = gate([stubborn, "tried", stubborn, "tried again", stubborn], {
      reviewMaxRounds: 3,
    });
    const out = await result;

    expect(out.outcome).toBe("unresolved");
    expect(out.rounds).toHaveLength(3);
    expect(out.score).toBe(5);
    // Findings carry their severity so the call-site can park on blocking and surface advisory.
    expect(blockingFindings(out.unresolved)).toEqual([
      { severity: "blocking", location: "src/a.ts:4", note: "the loop is unbounded" },
    ]);
    expect(out.unresolved).toHaveLength(2);
    // 3 reviews + 2 fixes: the LAST round is a review, never a fix nothing re-reviews.
    expect(calls).toHaveLength(5);
    expect(commitMessages).toHaveLength(2);
  });

  it("stops when a fix session changes nothing — re-reviewing the same diff cannot help", async () => {
    const { result, calls } = gate([report(4, [BLOCKING]), "every finding is wrong; left as-is"], { reviewMaxRounds: 3 }, [
      false,
    ]);
    const out = await result;

    expect(out.outcome).toBe("stalled");
    expect(out.rounds).toHaveLength(1);
    expect(out.rounds[0].fixCommitted).toBe(false);
    expect(blockingFindings(out.unresolved)).toHaveLength(1);
    expect(calls).toHaveLength(2); // no third dispatch: the loop bailed instead of re-reviewing
  });

  it("never passes a protocol violation as a clean review, and dispatches no fix for it", async () => {
    const { result, calls } = gate(["I read everything and it looks fine."], { reviewMaxRounds: 3 });
    const out = await result;

    expect(out.outcome).toBe("protocol-violation");
    expect(out.rounds[0]).toMatchObject({ violation: "no-report", blocking: 0, advisory: 0 });
    expect(out.rounds[0].score).toBeUndefined();
    expect(out.score).toBeUndefined();
    expect(calls).toHaveLength(1);
  });

  it("fails loud when the cap forbids the gate from ever reviewing", async () => {
    const { result, calls } = gate([], { reviewMaxRounds: 0 });
    // Poison, so the run parks for a human instead of reaching the PR as "reviewed".
    const error = await result.then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(isPoisonError(error)).toBe(true);
    expect((error as Error).message).toMatch(/reviewMaxRounds is 0/);
    expect(calls).toEqual([]);
  });
});

describe("runReviewGate — sessions", () => {
  it("records each review and each fix as its own session against the run target", async () => {
    const { result } = gate([report(4, [BLOCKING]), "fixed", report(9, [])]);
    await result;

    expect(await sessionKinds()).toEqual([
      { kind: "review", status: "done", beadId: "anton-gate1" },
      { kind: "review-fix", status: "done", beadId: "anton-gate1" },
      { kind: "review", status: "done", beadId: "anton-gate1" },
    ]);
  });

  it("reviews in a NEW context — never resumed, never under the implementer's system prompt", async () => {
    const { result, calls } = gate([report(4, [BLOCKING]), "fixed", report(9, [])]);
    await result;

    for (const review of [calls[0], calls[2]]) {
      expect(review.resumeSessionId).toBeUndefined();
      expect(review.appendSystemPrompt).toBeUndefined();
      expect(review.prompt).toContain("You are the **second opinion** on work you did not write.");
      expect(review.prompt).toContain("Run target: anton-gate1 — Ship the gate");
    }
  });
});

describe("runReviewGate — quota", () => {
  it("propagates a usage limit from the review and marks that session failed", async () => {
    const { result } = gate([new UsageLimitError("Claude usage limit reached", 1_700_000_600)]);
    await expect(result).rejects.toBeInstanceOf(UsageLimitError);
    expect(await sessionKinds()).toEqual([{ kind: "review", status: "failed", beadId: "anton-gate1" }]);
  });

  it("propagates a usage limit from the fix session too", async () => {
    const { result } = gate([report(4, [BLOCKING]), new UsageLimitError("Claude usage limit reached")]);
    await expect(result).rejects.toBeInstanceOf(UsageLimitError);
    expect(await sessionKinds()).toEqual([
      { kind: "review", status: "done", beadId: "anton-gate1" },
      { kind: "review-fix", status: "failed", beadId: "anton-gate1" },
    ]);
  });

  it("marks the review session failed when claude reports an error result", async () => {
    const failing = async (): Promise<ClaudeResult> => ({ ok: false, text: "boom" });
    const worktree = fakeWorktree();
    await expect(
      runReviewGate({
        db: tdb.db,
        clock,
        ctx,
        projectId,
        target,
        tickets: [ticket],
        settings: {},
        worktreePath: dir,
        baseBranch: "main",
        deps: {
          runClaude: failing,
          diff: async () => diff,
          commit: async () => ({ committed: true }),
          readState: worktree.readState,
          restoreState: worktree.restoreState,
        },
      }),
    ).rejects.toThrow(/claude reported an error reviewing anton-gate1/);
    expect(await sessionKinds()).toEqual([{ kind: "review", status: "failed", beadId: "anton-gate1" }]);
  });
});

describe("runReviewGate — the review is read-only", () => {
  it("reverts a reviewer that edited the worktree and refuses to trust its verdict", async () => {
    // The dangerous shape: the reviewer quietly fixes what it found and then reports clean. Its fix
    // would be thrown away when anton pushes the reviewed HEAD, shipping the defect with a 9/10.
    const worktree = fakeWorktree([1]);
    const { result, calls, restores } = gate([report(9, [])], { reviewMaxRounds: 3 }, [], worktree);
    const out = await result;

    expect(out.outcome).toBe("protocol-violation");
    expect(out.rounds[0]).toMatchObject({ violation: "worktree-modified" });
    expect(out.rounds[0].score).toBeUndefined();
    expect(out.score).toBeUndefined();
    // The edit is undone, and the loop stops rather than dispatching a fix off an untrusted review.
    expect(restores).toEqual(["?? reviewer-edit-1.ts"]);
    expect((await worktree.readState()).status).toBe("");
    expect(calls).toHaveLength(1);
  });

  it("keeps the findings a worktree-editing reviewer reported, as context for the human", async () => {
    const { result } = gate([report(4, [BLOCKING])], { reviewMaxRounds: 3 }, [], fakeWorktree([1]));
    const out = await result;

    expect(out.outcome).toBe("protocol-violation");
    expect(out.unresolved).toEqual([
      { severity: "blocking", location: "src/a.ts:4", note: "the loop is unbounded" },
    ]);
  });

  it("discards a dirty worktree before reading the diff, so the review grades what the PR pushes", async () => {
    // The dangerous shape: a retried job inherits the uncommitted leftovers of a fix session whose
    // verify gates failed. The diff still comes from HEAD, so a reviewer reading those files on disk
    // could pass work `openPullRequest` never pushes — and the removed worktree then loses it.
    const worktree = fakeWorktree([], "M src/a.ts");
    const { result, restores, diffStates } = gate([report(9, [])], { reviewMaxRounds: 2 }, [], worktree);
    const out = await result;

    expect(out.outcome).toBe("clean");
    expect(restores).toEqual(["M src/a.ts"]);
    // Settled BEFORE the diff is read, so the prompt and the tree the reviewer can read agree.
    expect(diffStates).toEqual([""]);
    expect((await worktree.readState()).status).toBe("");
  });

  it("does not mistake the leftovers it discarded for a reviewer that edited the worktree", async () => {
    // The baseline is re-read after the reset, so the guard's before/after compare clean-to-clean.
    const { result } = gate(
      [report(4, [BLOCKING]), "fixed it", report(9, [])],
      { reviewMaxRounds: 2 },
      [],
      fakeWorktree([], "?? leftover.ts"),
    );
    const out = await result;

    expect(out.outcome).toBe("clean");
    expect(out.rounds.map((r) => r.violation)).toEqual([undefined, undefined]);
  });

  it("reverts what a reviewer wrote before it died mid-dispatch", async () => {
    // The guard runs on the success path only, so a review that throws would otherwise leave its
    // edits behind for the runner's retry to inherit.
    const worktree = fakeWorktree([1]);
    const { result, restores } = gate([new UsageLimitError("Claude usage limit reached")], {}, [], worktree);

    await expect(result).rejects.toBeInstanceOf(UsageLimitError);
    expect(restores).toEqual(["?? reviewer-edit-1.ts"]);
    expect(await worktree.readState()).toEqual({ head: "c0ffee", status: "" });
  });

  it("reverts a COMMIT a reviewer landed before reporting an error", async () => {
    // The dangerous shape the dirty-tree guard can't catch on retry: a committed write reads as a
    // clean tree, so `settleBaseline` would adopt it as the baseline and a later clean review would
    // hand it to the PR unreviewed.
    const worktree = fakeWorktree([], "", [1]);
    const { result, restores } = gate([{ ok: false, text: "boom" }], {}, [], worktree);

    await expect(result).rejects.toThrow(/claude reported an error reviewing anton-gate1/);
    expect(restores).toHaveLength(1);
    expect(await worktree.readState()).toEqual({ head: "c0ffee", status: "" });
    expect(await sessionKinds()).toEqual([{ kind: "review", status: "failed", beadId: "anton-gate1" }]);
  });

  it("propagates the original failure when the revert itself fails", async () => {
    // Backoff depends on the runner seeing UsageLimitError, not a git error from the cleanup.
    const worktree = fakeWorktree([1]);
    const { result } = gate([new UsageLimitError("Claude usage limit reached")], {}, [], {
      ...worktree,
      restoreState: async () => {
        throw new Error("git reset --hard failed");
      },
    });

    await expect(result).rejects.toBeInstanceOf(UsageLimitError);
  });

  it("leaves a failed review that wrote nothing alone — no pointless reset", async () => {
    const worktree = fakeWorktree();
    const { result, restores } = gate([new UsageLimitError("Claude usage limit reached")], {}, [], worktree);

    await expect(result).rejects.toBeInstanceOf(UsageLimitError);
    expect(restores).toEqual([]);
  });

  it("leaves a well-behaved reviewer alone — no restore, and the fix session may still write", async () => {
    // Dispatch 2 is the FIX session: it is supposed to change the tree, and the guard must not see
    // its work as a review that misbehaved.
    const worktree = fakeWorktree([2]);
    const { result, restores } = gate(
      [report(4, [BLOCKING]), "fixed the loop bound", report(9, [])],
      { reviewMaxRounds: 2 },
      [],
      worktree,
    );
    const out = await result;

    expect(out.outcome).toBe("clean");
    expect(restores).toEqual([]);
  });
});
