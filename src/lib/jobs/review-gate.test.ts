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
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { asc } from "drizzle-orm";

import { makeTestDb, type TestDb } from "../db/testing";
import { schema } from "../db";
import type { Bead } from "../beads/bd";
import type { ClaudeResult, RunClaudeOptions } from "../claude/driver";
import type { BranchDiff, WorktreeState } from "../git/ops";
import type { ProjectSettings } from "../projects";
import { UsageLimitError, isPoisonError } from "./errors";
import type { ReviewFinding } from "./review-context";
import type { Clock } from "./queue";
import {
  blockingFindings,
  runReviewGate,
  REVIEW_SETTING_SOURCES,
  type ReviewGateContext,
  type ReviewGateResult,
  type ReviewRound,
} from "./review-gate";

/** A one-commit `main` repo: the least a gate round needs to read its (absent) rules from. */
function initRepo(path: string): void {
  const g = (args: string[]) => execFileSync("git", ["-C", path, ...args], { stdio: "ignore" });
  execFileSync("git", ["init", "-q", "-b", "main", path], { stdio: "ignore" });
  g(["config", "user.email", "t@example.com"]);
  g(["config", "user.name", "anton-test"]);
  writeFileSync(join(path, "README.md"), "# gate\n");
  g(["add", "-A"]);
  g(["commit", "-q", "-m", "init"]);
}

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
/** What an earlier `step:review` left open, as the caller seeds it into the next gate's carry. */
const EARLIER_ADVISORY: ReviewFinding = {
  severity: "advisory",
  location: "src/b.ts:2",
  note: "an earlier gate flagged this",
};

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
  // A real one-commit repo even though claude, the diff and the worktree state are all faked: the
  // gate reads its trusted inputs (the rulebook) at the base commit and FAILS on a read it cannot
  // make, so a bare temp dir would fail every case with "not a git repository".
  initRepo(dir);
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

/** The branch the run's worktree sits on — what `openPullRequest` would push. */
const RUN_REF = "refs/heads/anton/gate1";

/**
 * An in-memory stand-in for the worktree the read-only guard fingerprints. `mutateOn` names the
 * claude dispatches (1-based) after which the tree "changed" — how a reviewer that edits the code it
 * is judging looks to the gate. `commitOn` names the dispatches after which the agent COMMITTED its
 * write: HEAD moves and the tree reads clean, which is the shape a later `settleBaseline` cannot
 * tell from a settled worktree. `branchOn` names the dispatches after which the agent checked out a
 * branch of its own AT THE SAME COMMIT — invisible to a fingerprint that records only HEAD + status.
 */
function fakeWorktree(
  mutateOn: number[] = [],
  initialStatus = "",
  commitOn: number[] = [],
  branchOn: number[] = [],
) {
  const state: WorktreeState = { head: "c0ffee", ref: RUN_REF, status: initialStatus };
  const restores: string[] = [];
  let dispatches = 0;
  let commits = 0;
  return {
    restores,
    /** Called by the fake claude, so a "mutation" lands between the guard's before/after reads. */
    onDispatch: () => {
      dispatches += 1;
      if (mutateOn.includes(dispatches)) state.status = `?? reviewer-edit-${dispatches}.ts`;
      if (branchOn.includes(dispatches)) state.ref = `refs/heads/review-work-${dispatches}`;
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
    restoreState: async (_path: string, to: WorktreeState) => {
      restores.push(state.status);
      state.status = to.status;
      state.head = to.head;
      state.ref = to.ref;
    },
  };
}

/**
 * A worktree whose fingerprint stops being READABLE partway through — git failing under the cleanup
 * that has to decide whether the dead session left a commit behind. `graceReads` lets the reads
 * before the one under test through.
 */
function unreadableAfterDispatch(inner: ReturnType<typeof fakeWorktree>, dispatch: number, graceReads = 0) {
  let dispatches = 0;
  let reads = 0;
  return {
    ...inner,
    onDispatch: () => {
      dispatches += 1;
      inner.onDispatch();
    },
    readState: async () => {
      if (dispatches >= dispatch && reads++ >= graceReads) throw new Error("git rev-parse failed");
      return inner.readState();
    },
  };
}

/**
 * Run the gate against the fake driver. `commits` scripts each fix session's commit verdict;
 * `carried` seeds the open advisories an earlier `step:review` left, as execute-epic passes them.
 */
function gate(
  replies: ScriptedReply[],
  settings: ProjectSettings = {},
  commits: boolean[] = [],
  worktree = fakeWorktree(),
  assertLeaseHeld?: () => void,
  carried?: ReviewFinding[],
): {
  result: Promise<ReviewGateResult>;
  calls: RunClaudeOptions[];
  commitMessages: string[];
  restores: string[];
  /** The worktree's dirt as each round's diff was read — the review must see a settled tree. */
  diffStates: string[];
  /** The caller's accumulator: what the gate completed, readable even when `result` rejects. */
  rounds: ReviewRound[];
} {
  const { run, calls } = fakeClaude(replies);
  const commitMessages: string[] = [];
  const diffStates: string[] = [];
  const rounds: ReviewRound[] = [];
  const result = runReviewGate({
    rounds,
    db: tdb.db,
    clock,
    ctx,
    projectId,
    target,
    tickets: [ticket],
    settings,
    worktreePath: dir,
    baseBranch: "main",
    ...(assertLeaseHeld ? { assertLeaseHeld } : {}),
    ...(carried ? { carried } : {}),
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
  return { result, calls, commitMessages, restores: worktree.restores, diffStates, rounds };
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

  it("shows an open advisory to the confirming review and drops the one it does not restate", async () => {
    // Nothing dispatched the advisory — only blocking findings reach a fix session — but the fix may
    // well have removed its cause, so the confirming review is handed it and its omission settles it.
    // Reporting it anyway would tell the founder to act on something that is no longer true.
    const { result, calls } = gate([report(4, [BLOCKING, ADVISORY]), "fixed the loop bound", report(9, [])]);
    const out = await result;

    expect(calls[0].prompt).not.toContain("Advisories still open from an earlier review");
    expect(calls[2].prompt).toContain("Advisories still open from an earlier review");
    expect(calls[2].prompt).toContain("src/a.ts:9 — the name could be clearer");
    expect(out.outcome).toBe("clean");
    expect(out.unresolved).toEqual([]);
  });

  it("lists a carried advisory once when the confirming review repeats it", async () => {
    const { result } = gate([report(4, [BLOCKING, ADVISORY]), "fixed", report(9, [ADVISORY])]);
    const out = await result;

    expect(out.unresolved).toEqual([
      { severity: "advisory", location: "src/a.ts:9", note: "the name could be clearer" },
    ]);
  });

  it("seeds the carry from an EARLIER review step, so this gate's first round is not blind", async () => {
    // A formula may run `step:review` twice. Each step is its own gate, so without the seed the
    // second reviewer never sees what the first left open — and the caller, which replaces its
    // advisory set with each gate's verdict, would drop those findings before the PR body is built.
    const { result, calls } = gate([report(9, [EARLIER_ADVISORY])], {}, [], fakeWorktree(), undefined, [
      EARLIER_ADVISORY,
    ]);
    const out = await result;

    expect(calls[0].prompt).toContain("Advisories still open from an earlier review");
    expect(calls[0].prompt).toContain("src/b.ts:2 — an earlier gate flagged this");
    // Restated once, not twice: this reviewer's report IS the whole open set.
    expect(out.unresolved).toEqual([EARLIER_ADVISORY]);
  });

  it("settles an earlier STEP's advisory the same way a round's: by the next reviewer's silence", async () => {
    const { result } = gate([report(9, [])], {}, [], fakeWorktree(), undefined, [EARLIER_ADVISORY]);

    expect((await result).unresolved).toEqual([]);
  });

  it("keeps an earlier STEP's advisory when this gate's reviewer breaks the protocol", async () => {
    // Silence settles nothing, so the finding the previous gate reported still needs a human.
    const { result } = gate(["I had a look. Seems fine."], {}, [], fakeWorktree(), undefined, [
      EARLIER_ADVISORY,
    ]);
    const out = await result;

    expect(out.outcome).toBe("protocol-violation");
    expect(out.unresolved).toEqual([EARLIER_ADVISORY]);
  });

  it("carries advisories through a round that ends on a protocol violation", async () => {
    // A round that never reported settled nothing — omission there is silence, not a disposition —
    // so the earlier advisory rides along: the salvaged findings are why a human is being asked.
    const { result } = gate([report(4, [BLOCKING, ADVISORY]), "fixed", "no report at all"]);
    const out = await result;

    expect(out.outcome).toBe("protocol-violation");
    expect(out.unresolved).toEqual([
      { severity: "advisory", location: "src/a.ts:9", note: "the name could be clearer" },
    ]);
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

  it("treats a fixer that committed its OWN changes as progress, not a stall", async () => {
    // Project instructions routinely tell an agent to commit, whatever the fix prompt asks. HEAD has
    // moved, so the branch already carries the repair — reading the empty index as "nothing changed"
    // would park a run whose fix is done. Dispatch 2 is the fix session.
    const worktree = fakeWorktree([], "", [2]);
    const { result, calls } = gate(
      [report(4, [BLOCKING]), "fixed it and committed", report(9, [])],
      { reviewMaxRounds: 2 },
      [false], // `commitAll` finds nothing staged
      worktree,
    );
    const out = await result;

    expect(out.outcome).toBe("clean");
    expect(out.rounds[0].fixCommitted).toBe(true);
    expect(calls).toHaveLength(3); // the confirming review still ran
  });

  it("parks when the fixer committed onto a branch of its OWN instead of the run's", async () => {
    // The limit of the rule above: anton pushes the run's branch by NAME, so a fix landed on
    // `review-work` is readable by the confirming review and invisible to the PR. Counting a moved
    // HEAD as progress without checking the branch would pass a PR missing the fix it just approved.
    const worktree = fakeWorktree([], "", [2], [2]);
    const { result, calls } = gate(
      [report(4, [BLOCKING]), "fixed it on a branch of my own", report(9, [])],
      { reviewMaxRounds: 2 },
      [],
      worktree,
    );

    const error = await result.then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(isPoisonError(error)).toBe(true);
    expect((error as Error).message).toMatch(/on a branch of its own: r0gue2 \(on review-work-2\)/);
    expect(calls).toHaveLength(2); // no confirming review on work the PR would never carry
  });

  it("still stalls when the fixer neither staged nor committed anything", async () => {
    const { result, calls } = gate([report(4, [BLOCKING]), "every finding is wrong"], { reviewMaxRounds: 3 }, [false]);
    const out = await result;

    expect(out.outcome).toBe("stalled");
    expect(out.rounds[0].fixCommitted).toBe(false);
    expect(calls).toHaveLength(2);
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

/**
 * The score-regression alarm (anton-i98r): the loop stops grinding when the reviewer keeps scoring
 * the run low, and hands the founder the series instead of another fix round.
 */
describe("runReviewGate — the score-regression alarm", () => {
  /** minScore 5 / K 2, with room to spare on the round cap so "stops EARLY" is observable. */
  const ALARM = { reviewMinScore: 5, reviewLowScoreRounds: 2, reviewMaxRounds: 4 };

  it("stops the loop on K consecutive low rounds, carrying the streak as evidence", async () => {
    const low = report(3, [BLOCKING]);
    const { result, calls, commitMessages } = gate([low, "tried", low, "tried again", low], ALARM);
    const out = await result;

    expect(out.outcome).toBe("score-regression");
    expect(out.regression).toEqual({ streak: [3, 3], minScore: 5 });
    expect(out.score).toBe(3);
    expect(out.rounds).toHaveLength(2);
    // Early: the cap allowed four rounds, and the second review ends it — no third fix is dispatched.
    expect(calls).toHaveLength(3); // review → fix → review
    expect(commitMessages).toHaveLength(1);
  });

  it("resets on recovery — a round at or above the minimum zeroes the streak", async () => {
    // 3 → 8 → 3 → clean. Without the reset the third round's 3 would complete a [3, 3] streak and
    // park a run that had already shown it could recover.
    const { result } = gate(
      [report(3, [BLOCKING]), "fixed", report(8, [BLOCKING]), "fixed", report(3, [BLOCKING]), "fixed", report(9, [])],
      { ...ALARM, reviewMaxRounds: 5 },
    );
    const out = await result;

    expect(out.outcome).toBe("clean");
    expect(out.regression).toBeUndefined();
    expect(out.rounds.map((r) => r.score)).toEqual([3, 8, 3, 9]);
  });

  it("never fires on an advisory-only round ABOVE the threshold, even at K=1", async () => {
    const { result } = gate([report(6, [ADVISORY])], { ...ALARM, reviewLowScoreRounds: 1 });
    const out = await result;

    expect(out.outcome).toBe("clean");
    expect(out.regression).toBeUndefined();
  });

  it("parks a low-scoring round that blocks NOTHING — a 3/10 is not a merge-ready PR", async () => {
    // The alarm outranks the clean exit: the reviewer cleared the blocking finding but still says
    // the work is a 3, twice running. That verdict must not reach the founder wearing a PR.
    const { result } = gate([report(3, [BLOCKING]), "fixed", report(3, [ADVISORY])], ALARM);
    const out = await result;

    expect(out.outcome).toBe("score-regression");
    expect(out.regression).toEqual({ streak: [3, 3], minScore: 5 });
    expect(blockingFindings(out.unresolved)).toEqual([]);
    // The advisory still rides out on `unresolved`, so the park note can record it.
    expect(out.unresolved).toHaveLength(1);
  });

  it("honors K=1 — a single low round parks before any fix is dispatched", async () => {
    const { result, calls, commitMessages } = gate([report(3, [BLOCKING])], {
      ...ALARM,
      reviewLowScoreRounds: 1,
    });
    const out = await result;

    expect(out.outcome).toBe("score-regression");
    expect(out.regression).toEqual({ streak: [3], minScore: 5 });
    expect(calls).toHaveLength(1);
    expect(commitMessages).toEqual([]);
  });

  it("is off at a minimum score of 0 — the loop runs to the cap whatever it scores", async () => {
    const low = report(0, [BLOCKING]);
    const { result } = gate([low, "tried", low], { reviewMinScore: 0, reviewMaxRounds: 2 });
    const out = await result;

    expect(out.outcome).toBe("unresolved");
    expect(out.regression).toBeUndefined();
  });

  it("leaves a round that never scored to its own protocol violation, not to the alarm", async () => {
    const { result } = gate(["no report at all"], { ...ALARM, reviewLowScoreRounds: 1 });
    const out = await result;

    expect(out.outcome).toBe("protocol-violation");
    expect(out.regression).toBeUndefined();
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

  it("denies the reviewer every write tool and `git`, but leaves the fix session free", async () => {
    // The editing tools cost a read-only review nothing to lose, and reverting after the fact is a
    // worse guard than not handing them over. `git` goes too because the worktree fingerprint cannot
    // see a written ref: `git branch anton/<future-bead> HEAD` leaves HEAD, the symbolic ref, and the
    // status identical, and `createWorktree` adopts an existing branch — so reviewer-chosen commits
    // would ride into an unrelated later run's PR. Deny rules are the guard, since the ref store is
    // shared with concurrent runs and cannot be restored blindly.
    const { result, calls } = gate([report(4, [BLOCKING]), "fixed", report(9, [])]);
    await result;

    for (const review of [calls[0], calls[2]]) {
      expect(review.disallowedTools).toEqual(["Write", "Edit", "MultiEdit", "NotebookEdit", "Bash(git:*)"]);
    }
    // The fixer writes code and commits it; denying it those tools would break the round.
    expect(calls[1].disallowedTools).toBeUndefined();
  });

  it("loads the reviewer from the operator's settings only, never the branch's", async () => {
    // `.claude/settings.json` is source-controlled, so a diff that adds one would configure the
    // session judging it — and settings register hooks, which run shell commands. The same flag
    // gates Claude Code's project-memory discovery, so `user` is also what keeps the worktree's
    // `CLAUDE.md` / `AGENTS.md` (root and nested) out of the reviewer's context.
    const { result, calls } = gate([report(4, [BLOCKING]), "fixed", report(9, [])]);
    await result;

    expect(calls[0].settingSources).toEqual([...REVIEW_SETTING_SOURCES]);
    expect(calls[2].settingSources).toEqual([...REVIEW_SETTING_SOURCES]);
    // The fixer is an implementer: the project's own hooks apply to the code it writes.
    expect(calls[1].settingSources).toBeUndefined();
  });

  it("sandboxes the reviewer's shell with the repository's ref store denied (anton-t6tu)", async () => {
    // The half no tool-name filter reaches: `Bash` stays, and a shell writes bytes without any of
    // the denied tools — `printf <sha> > <repo>/.git/refs/heads/anton/<future-bead>` plants a branch
    // `createWorktree` later adopts, leaving this worktree byte-identical. Only OS-level containment
    // closes it, so the dispatch has to CARRY the sandbox settings, not merely be entitled to them.
    const { result, calls } = gate([report(4, [BLOCKING]), "fixed", report(9, [])]);
    await result;

    const commonDir = execFileSync("git", ["-C", dir, "rev-parse", "--path-format=absolute", "--git-common-dir"])
      .toString()
      .trim();
    for (const review of [calls[0], calls[2]]) {
      const { sandbox } = JSON.parse(review.settingsJson!);
      expect(sandbox.enabled).toBe(true);
      expect(sandbox.failIfUnavailable).toBe(true);
      expect(sandbox.allowUnsandboxedCommands).toBe(false);
      // The ref store, in both the form git reports and the form anton configured — on macOS a temp
      // path reaches the kernel symlink-resolved, and a deny rule only bites the path it names.
      expect(sandbox.filesystem.denyWrite).toContain(commonDir);
      expect(sandbox.filesystem.denyWrite).toContain(join(dir, ".git"));
    }
    // The fixer commits its work through git: sandboxing it out of the ref store would break the round.
    expect(calls[1].settingsJson).toBeUndefined();
  });
});

describe("runReviewGate — the run-lease is re-asserted between dispatches", () => {
  it("re-checks before every review and every fix, not just on the way in", async () => {
    // A review → fix → re-review sequence outlives the 15-minute lease TTL, so a gate checked only
    // at its edges keeps dispatching after another machine may already have taken the epic.
    const boundaries: number[] = [];
    const { result, calls } = gate(
      [report(4, [BLOCKING]), "fixed it", report(9, [])],
      { reviewMaxRounds: 2 },
      [],
      fakeWorktree(),
      // `calls` grows as each dispatch starts, so this records how many had run at each check.
      () => boundaries.push(calls.length),
    );
    const out = await result;

    expect(out.outcome).toBe("clean");
    // One check immediately BEFORE each dispatch: review 1, fix 1, review 2.
    expect(boundaries).toEqual([0, 1, 2]);
  });

  it("stops the loop mid-converge when the lease has lapsed", async () => {
    let checks = 0;
    const { result, calls } = gate(
      [report(4, [BLOCKING]), "fixed it", report(9, [])],
      { reviewMaxRounds: 2 },
      [],
      fakeWorktree(),
      () => {
        checks += 1;
        // Lapsed by the time the fix would be dispatched: nothing further may be written here.
        if (checks > 1) throw new Error("anton-gate1 run-lease expired mid-run");
      },
    );

    await expect(result).rejects.toThrow(/run-lease expired mid-run/);
    expect(calls).toHaveLength(1); // the review ran; no fix was dispatched under a dead lease
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
    expect(await worktree.readState()).toEqual({ head: "c0ffee", ref: RUN_REF, status: "" });
  });

  it("reverts a COMMIT a reviewer landed before reporting an error", async () => {
    // The dangerous shape the dirty-tree guard can't catch on retry: a committed write reads as a
    // clean tree, so `settleBaseline` would adopt it as the baseline and a later clean review would
    // hand it to the PR unreviewed.
    const worktree = fakeWorktree([], "", [1]);
    const { result, restores } = gate([{ ok: false, text: "boom" }], {}, [], worktree);

    await expect(result).rejects.toThrow(/claude reported an error reviewing anton-gate1/);
    expect(restores).toHaveLength(1);
    expect(await worktree.readState()).toEqual({ head: "c0ffee", ref: RUN_REF, status: "" });
    expect(await sessionKinds()).toEqual([{ kind: "review", status: "failed", beadId: "anton-gate1" }]);
  });

  it("propagates the original failure when the revert of an UNCOMMITTED write fails", async () => {
    // Backoff depends on the runner seeing UsageLimitError, not a git error from the cleanup — and
    // the leftover dirt is harmless: the retry's `settleBaseline` discards it before reading anything.
    const worktree = fakeWorktree([1]);
    const { result } = gate([new UsageLimitError("Claude usage limit reached")], {}, [], {
      ...worktree,
      restoreState: async () => {
        throw new Error("git reset --hard failed");
      },
    });

    await expect(result).rejects.toBeInstanceOf(UsageLimitError);
  });

  it("parks instead of retrying when the reviewer's COMMIT cannot be reverted", async () => {
    // The one case where losing the original error's backoff is the safer trade: an unrevertable
    // rogue HEAD reads as a settled tree, so a retry would adopt the reviewer's own commit as the
    // reviewed baseline and open a PR on code no reviewer ever saw.
    const worktree = fakeWorktree([], "", [1]);
    const { result } = gate([new UsageLimitError("Claude usage limit reached")], {}, [], {
      ...worktree,
      restoreState: async () => {
        throw new Error("git reset --hard failed");
      },
    });

    const error = await result.then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(isPoisonError(error)).toBe(true);
    expect((error as Error).message).toMatch(/WROTE to its own worktree/);
    expect((error as Error).message).toMatch(/is left at r0gue1 \(on anton\/gate1\)/);
    // The original failure is carried, not lost — it's why a human is being asked.
    expect((error as Error).message).toMatch(/Claude usage limit reached/);
    expect(await sessionKinds()).toEqual([{ kind: "review", status: "failed", beadId: "anton-gate1" }]);
  });

  it("resets the worktree anyway when the post-failure state cannot be READ", async () => {
    // An unreadable fingerprint says nothing about what the dead reviewer left — treating it as
    // "unchanged" would let a commit it landed survive as the next attempt's baseline. The reset
    // runs regardless, and because it succeeds the runner still sees the error that drives backoff.
    const inner = fakeWorktree([], "", [1]);
    const { result, restores } = gate(
      [new UsageLimitError("Claude usage limit reached")],
      {},
      [],
      unreadableAfterDispatch(inner, 1),
    );

    await expect(result).rejects.toBeInstanceOf(UsageLimitError);
    expect(restores).toHaveLength(1);
    expect(await inner.readState()).toEqual({ head: "c0ffee", ref: RUN_REF, status: "" });
  });

  it("parks when the post-failure state can be neither read nor reset", async () => {
    // Nothing can vouch for this worktree: it may carry the reviewer's own commit, and no retry may
    // adopt it as a reviewed baseline.
    const inner = fakeWorktree([], "", [1]);
    const { result } = gate([new UsageLimitError("Claude usage limit reached")], {}, [], {
      ...unreadableAfterDispatch(inner, 1),
      restoreState: async () => {
        throw new Error("git reset --hard failed");
      },
    });

    const error = await result.then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(isPoisonError(error)).toBe(true);
    expect((error as Error).message).toMatch(/left in a state that could not be read/);
    expect((error as Error).message).toMatch(/Claude usage limit reached/);
  });

  it("leaves a failed review that wrote nothing alone — no pointless reset", async () => {
    const worktree = fakeWorktree();
    const { result, restores } = gate([new UsageLimitError("Claude usage limit reached")], {}, [], worktree);

    await expect(result).rejects.toBeInstanceOf(UsageLimitError);
    expect(restores).toEqual([]);
  });

  it("rejects a reviewer that checked out a branch of its own at the SAME commit", async () => {
    // The shape a HEAD-and-status fingerprint reads as untouched: `git checkout -b review-work` moves
    // nothing the old guard recorded, but every later fix commit then lands on a branch the PR push
    // never sees — the confirming review passes work `openPullRequest` would silently drop.
    const worktree = fakeWorktree([], "", [], [1]);
    const { result, calls } = gate([report(9, [])], { reviewMaxRounds: 3 }, [], worktree);
    const out = await result;

    expect(out.outcome).toBe("protocol-violation");
    expect(out.rounds[0]).toMatchObject({ violation: "worktree-modified" });
    // Back on the branch anton pushes, and the loop stops rather than fixing onto the stray one.
    expect((await worktree.readState()).ref).toBe(RUN_REF);
    expect(calls).toHaveLength(1);
  });

  it("parks instead of retrying when a stray branch checkout cannot be reverted", async () => {
    // Same hazard as an unrevertable commit: the retry reads a clean tree at the reviewed commit and
    // adopts it, while the branch it fixes and the branch it pushes have quietly diverged.
    const worktree = fakeWorktree([], "", [], [1]);
    const { result } = gate([new UsageLimitError("Claude usage limit reached")], {}, [], {
      ...worktree,
      restoreState: async () => {
        throw new Error("git checkout --force failed");
      },
    });

    const error = await result.then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(isPoisonError(error)).toBe(true);
    expect((error as Error).message).toMatch(/is left at c0ffee \(on review-work-1\)/);
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

/**
 * Gates run before the commit so a failure leaves the fix uncommitted — but only for a fixer that
 * left its work staged. One that committed first (as project instructions routinely tell an agent to)
 * would otherwise keep that commit through the failure, and the runner's retry reuses this worktree:
 * `settleBaseline` discards dirt but adopts a COMMIT as the settled baseline, so the next round would
 * review an unverified fix clean and open the PR with the gate it failed never having passed.
 *
 * Dispatch 2 is the fix session throughout.
 */
describe("runReviewGate — a failed fix leaves nothing behind", () => {
  it("rolls back the fixer's OWN commit when a verify gate fails", async () => {
    const worktree = fakeWorktree([], "", [2]);
    const { result, restores } = gate(
      [report(4, [BLOCKING]), "fixed it and committed"],
      { reviewMaxRounds: 2, testCommand: "exit 1" },
      [],
      worktree,
    );

    await expect(result).rejects.toThrow(/tests gate failed after review round 1 for anton-gate1/);
    expect(restores).toHaveLength(1);
    // Back at the baseline the round started from: nothing a later `settleBaseline` could adopt.
    expect(await worktree.readState()).toEqual({ head: "c0ffee", ref: RUN_REF, status: "" });
  });

  it("rolls back a commit the fix landed before it died mid-dispatch", async () => {
    // Not just gate failures: an abort or an exhausted quota strands the same unverified commit.
    const worktree = fakeWorktree([], "", [2]);
    const { result, restores } = gate(
      [report(4, [BLOCKING]), new UsageLimitError("Claude usage limit reached")],
      { reviewMaxRounds: 2 },
      [],
      worktree,
    );

    await expect(result).rejects.toBeInstanceOf(UsageLimitError);
    expect(restores).toHaveLength(1);
    expect(await worktree.readState()).toEqual({ head: "c0ffee", ref: RUN_REF, status: "" });
  });

  it("propagates the gate failure when rolling back an UNCOMMITTED fix fails", async () => {
    // Dirt is harmless — the retry's `settleBaseline` discards it — so a failed rollback must not
    // replace the error the runner needs to see.
    const worktree = fakeWorktree([2]);
    const { result } = gate([report(4, [BLOCKING]), "fixed it"], { reviewMaxRounds: 2, testCommand: "exit 1" }, [], {
      ...worktree,
      restoreState: async () => {
        throw new Error("git reset --hard failed");
      },
    });

    const error = await result.then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(isPoisonError(error)).toBe(false);
    expect((error as Error).message).toMatch(/tests gate failed after review round 1/);
  });

  it("parks instead of retrying when a failed fix's COMMIT cannot be rolled back", async () => {
    const worktree = fakeWorktree([], "", [2]);
    const { result } = gate([report(4, [BLOCKING]), "fixed it and committed"], { reviewMaxRounds: 2, testCommand: "exit 1" }, [], {
      ...worktree,
      restoreState: async () => {
        throw new Error("git reset --hard failed");
      },
    });

    const error = await result.then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(isPoisonError(error)).toBe(true);
    expect((error as Error).message).toMatch(/the review fix of anton-gate1 WROTE to its own worktree/);
    expect((error as Error).message).toMatch(/is left at r0gue2 \(on anton\/gate1\)/);
    // The gate that actually failed is carried into the park reason, not lost to the cleanup error.
    expect((error as Error).message).toMatch(/tests gate failed after review round 1/);
  });

  it("rolls back a self-committed fix whose post-failure state cannot be READ", async () => {
    // The exact hole a read-first cleanup leaves: the fixer commits, the gate fails, and the
    // fingerprint read that would spot the commit throws. Reading it as "nothing to undo" would hand
    // the next attempt a clean tree carrying a fix whose gates never passed.
    const inner = fakeWorktree([], "", [2]);
    const { result, restores } = gate(
      [report(4, [BLOCKING]), "fixed it and committed"],
      { reviewMaxRounds: 2, testCommand: "exit 1" },
      [],
      unreadableAfterDispatch(inner, 2, 1), // the stray-branch check reads first; the cleanup's read fails
    );

    await expect(result).rejects.toThrow(/tests gate failed after review round 1 for anton-gate1/);
    expect(restores).toHaveLength(1);
    expect(await inner.readState()).toEqual({ head: "c0ffee", ref: RUN_REF, status: "" });
  });

  it("keeps the commits of a fixer that used a branch of its OWN — parked for a human, not reverted", async () => {
    // The one failure that must NOT roll back: those commits are the human's to move, and reverting
    // them would bury the work the park reason is asking them to rescue.
    const worktree = fakeWorktree([], "", [2], [2]);
    const { result, restores, rounds } = gate(
      [report(4, [BLOCKING]), "fixed it on a branch of my own"],
      { reviewMaxRounds: 2 },
      [],
      worktree,
    );

    const error = await result.then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(isPoisonError(error)).toBe(true);
    expect((error as Error).message).toMatch(/on a branch of its own/);
    expect(restores).toEqual([]);
    expect(await worktree.readState()).toMatchObject({ head: "r0gue2", ref: "refs/heads/review-work-2" });
    // A poison exit returns no result, so the rounds it DID finish are left in the caller's
    // accumulator — the call-site persists them, and the park the founder opens still shows its
    // score history.
    expect(rounds).toMatchObject([{ round: 1, score: 4, blocking: 1, advisory: 0 }]);
  });

  it("hands back the completed rounds of a RETRYABLE death, with the error's own type intact", async () => {
    // A usage limit reschedules the run and the resumed gate restarts at round 1, so a round that
    // reviewed and scored before the quota ran out exists nowhere else. Wrapping the error to carry
    // it out would have cost the runner the backoff it keys off the type, so the rounds come back on
    // the accumulator instead.
    const { result, rounds } = gate(
      [report(4, [BLOCKING]), new UsageLimitError("out of quota")],
      { reviewMaxRounds: 2 },
    );

    await expect(result).rejects.toBeInstanceOf(UsageLimitError);
    expect(rounds).toMatchObject([{ round: 1, score: 4, blocking: 1, advisory: 0 }]);
  });

  it("leaves a fix that PASSED its gates alone — the round's own commit is not rolled back", async () => {
    const worktree = fakeWorktree([], "", [2]);
    const { result, restores } = gate(
      [report(4, [BLOCKING]), "fixed it and committed", report(9, [])],
      { reviewMaxRounds: 2, testCommand: "exit 0" },
      [false], // `commitAll` finds nothing staged — the fixer already committed
      worktree,
    );
    const out = await result;

    expect(out.outcome).toBe("clean");
    expect(restores).toEqual([]);
    expect((await worktree.readState()).head).toBe("r0gue2");
  });
});

/**
 * REAL git, unlike the rest of this file: the drift guarded against here is a property of the base
 * REF, which a fake diff cannot express. The gate resolves the fork point once and hands that SHA to
 * both the patch and the reviewer's trusted inputs.
 */
describe("runReviewGate — the base is pinned to the fork point", () => {
  let repo: string;

  const g = (args: string[]) => execFileSync("git", ["-C", repo, ...args], { stdio: "ignore" });
  const commitFile = (rel: string, body: string) => {
    mkdirSync(join(repo, rel, ".."), { recursive: true });
    writeFileSync(join(repo, rel), body);
    g(["add", "-A"]);
    g(["commit", "-q", "-m", `write ${rel}`]);
  };

  beforeEach(() => {
    repo = join(dir, "repo");
    mkdirSync(repo);
    execFileSync("git", ["init", "-q", "-b", "main", repo], { stdio: "ignore" });
    g(["config", "user.email", "t@example.com"]);
    g(["config", "user.name", "anton-test"]);
    commitFile(".product/principles.md", "- Every finding must cite a bead.\n");
    commitFile("CLAUDE.md", "- Extensionless imports only.\n");
    g(["checkout", "-q", "-b", "anton/gate1"]);
    commitFile("src/a.ts", "export const a = 1;\n");
  });

  it("grades against the rules the run branched from, not a base that moved since", async () => {
    // The base is a MOVABLE ref: a sibling run's fetch, or a resume, advances it mid-review. Reading
    // the rules from the new tip while the patch comes from the old fork point would let whatever
    // commit landed in between decide which rules grade this branch — including by deleting one.
    g(["checkout", "-q", "main"]);
    commitFile(".product/principles.md", "- Anything goes.\n");
    writeFileSync(join(repo, "CLAUDE.md"), "");
    g(["add", "-A"]);
    g(["commit", "-q", "-m", "drop the instruction file"]);
    g(["checkout", "-q", "anton/gate1"]);

    const { run, calls } = fakeClaude([report(9, [])]);
    const out = await runReviewGate({
      db: tdb.db,
      clock,
      ctx,
      projectId,
      target,
      tickets: [ticket],
      settings: { reviewPrompt: "OPERATOR CONTRACT." },
      worktreePath: repo,
      baseBranch: "main",
      deps: { runClaude: run },
    });

    expect(out.outcome).toBe("clean");
    expect(calls[0].prompt).toContain("- Every finding must cite a bead.");
    expect(calls[0].prompt).toContain("- Extensionless imports only.");
    expect(calls[0].prompt).not.toContain("- Anything goes.");
    // And the patch comes from that same commit: the base's own work is not this run's.
    expect(calls[0].prompt).toContain("src/a.ts");
    expect(calls[0].prompt).not.toContain("drop the instruction file");
  });

  it("fails the round when a rulebook file cannot be READ, instead of reviewing without it", async () => {
    // A read that FAILS is not a project with no rules. The reviewer is told the inlined rules are
    // the only ones grading the run, so a corrupt object (or a timeout) that reported itself as
    // "absent" would grade the diff against a rulebook nobody ever read — and pass it.
    const blob = execFileSync("git", ["-C", repo, "rev-parse", "main:.product/principles.md"], {
      encoding: "utf8",
    }).trim();
    rmSync(join(repo, ".git/objects", blob.slice(0, 2), blob.slice(2)), { force: true });

    const { run, calls } = fakeClaude([report(9, [])]);
    await expect(
      runReviewGate({
        db: tdb.db,
        clock,
        ctx,
        projectId,
        target,
        tickets: [ticket],
        settings: {},
        worktreePath: repo,
        baseBranch: "main",
        deps: { runClaude: run },
      }),
    ).rejects.toThrow();

    // And no reviewer was dispatched on the half-read rulebook.
    expect(calls).toEqual([]);
  });
});
