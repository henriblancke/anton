/**
 * Unit tests for the pre-PR self-review gate's converge loop (anton-cbak), driven by a FAKE claude
 * driver: a scripted queue of replies plus the prompts each dispatch received. The db is real (an
 * in-memory anton.db) so "each review and each fix is its own recorded session" is asserted on the
 * rows the UI reads, not on a spy.
 *
 * The verify gates are left unconfigured in most cases here: running a real suite belongs to the
 * execute-epic integration suite (anton-omum), not to a loop test. The exception is the block at the
 * bottom, which pins a trivial `echo` gate — the gate evidence the reviewer is handed is loop
 * behavior (which session runs the gates, and how often), so it is asserted where the loop is.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { asc } from "drizzle-orm";

import { selfBuildVersion } from "../build/drift";
import { systemPromptDigest } from "../claude/system-prompt";
import { schema } from "../db";
import type { Bead } from "../beads/bd";
import { pinBoardMode, resetBoardModeCache } from "../beads/board-mode";
import type { ClaudeResult, RunClaudeOptions } from "../claude/driver";

// `runReviewGate`'s durable persist of board-fix evidence (PR #284 review, "Persist board-fix
// evidence IDs across review retries") shells out to real `bd` via `beads.setBoardEvidenceConfirmed`
// / `beads.push` — mocked here so the many board-only fix tests below, which pass a fake `repoPath`
// ("/repos/anton"), don't pay `mustPersist`'s real retry backoff against a `bd` that can never
// succeed there. `beads.show` is mocked too (chatgpt-codex-connector review, "Re-read tickets before
// preserving closure fences") — the persist step now re-reads each board-only ticket's live state
// before deriving its closure fence, which otherwise shells out for real and, unmocked, exhausts
// `mustRead`'s retries against a `bd` that can never succeed at this fake path. Every fixture ticket
// here is already closed, so the default mirrors that rather than leaving `beads.show` unmocked.
// `beads.history` is mocked for the same reason (chatgpt-codex-connector, PR #284 review, "Fail
// closed when the review-fix closure read fails"): the persist step now REQUIRES this read to
// succeed for a closed ticket with no stored closure yet, via the retrying `mustReadClosureVersion`,
// rather than tolerating a failure — unmocked, that would exhaust its retries against a `bd` that can
// never succeed at this fake path and poison every board-only fix test below. `beads.isBoardOnly` and
// everything else stays real: only these four calls shell out.
const setBoardEvidenceConfirmedMock =
  vi.fn<
    (repo: string, id: string, ids: readonly string[], closure?: string, origin?: string) => Promise<string>
  >();
const boardPushMock = vi.fn<(repo: string) => Promise<string>>();
const boardShowMock = vi.fn<(repo: string, id: string) => Promise<Bead>>();
const boardHistoryMock = vi.fn<(repo: string, id: string) => Promise<import("../beads/bd").BeadVersion[]>>();
// The self-review gate's own board-only baseline persist/release (chatgpt-codex-connector, PR
// #284 review, "Persist the self-review board baseline before dispatch") shells out to real `bd`
// via `beads.setReviewGateBoardBaseline` / `beads.clearReviewGateBoardBaseline` — mocked here for
// the same reason the four calls above are: the many board-only fix tests below pass a fake
// `repoPath` a real `bd` can never succeed against.
const setReviewGateBoardBaselineMock = vi.fn<(repo: string, id: string, fingerprint: Record<string, string>) => Promise<string>>();
const clearReviewGateBoardBaselineMock = vi.fn<(repo: string, id: string) => Promise<string>>();
vi.mock("../beads/bd", async () => {
  const actual = await vi.importActual<typeof import("../beads/bd")>("../beads/bd");
  return {
    ...actual,
    beads: {
      ...actual.beads,
      setBoardEvidenceConfirmed: (...args: [string, string, readonly string[], string?, string?]) =>
        setBoardEvidenceConfirmedMock(...args),
      push: (...args: [string]) => boardPushMock(...args),
      show: (...args: [string, string]) => boardShowMock(...args),
      history: (...args: [string, string]) => boardHistoryMock(...args),
      setReviewGateBoardBaseline: (...args: [string, string, Record<string, string>]) =>
        setReviewGateBoardBaselineMock(...args),
      clearReviewGateBoardBaseline: (...args: [string, string]) => clearReviewGateBoardBaselineMock(...args),
    },
  };
});
setBoardEvidenceConfirmedMock.mockResolvedValue("");
boardPushMock.mockResolvedValue("synced");
setReviewGateBoardBaselineMock.mockResolvedValue("");
clearReviewGateBoardBaselineMock.mockResolvedValue("");
boardShowMock.mockImplementation(async (_repo, id) => ({ id, status: "closed", title: "", issue_type: "task" }));
// A single closed version by default — every fixture ticket above is already closed, and this is
// what real `bd history` returns for an ordinary bead that went through open → closed once: at
// least one version with `status: "closed"`, which `readCurrentClosureVersion` folds to that
// version's hash. `[]` (bd answering with NO history at all — an imported/legacy bead) is reserved
// for the dedicated test below (chatgpt-codex-connector, PR #284 review, "Reject empty closure
// histories before confirming fixes"): every OTHER board-only fix test needs a real closure fence
// to persist, or the fail-closed guard that finding added would poison them all on this shared
// default instead of exercising the behavior each of them actually tests.
boardHistoryMock.mockResolvedValue([{ hash: "closure-hash", at: "2026-01-01T00:00:00.000Z", status: "closed" }]);
import type { BranchDiff, WorktreeState } from "../git/ops";
import type { ProjectSettings } from "../projects";
import { UsageLimitError, isPoisonError } from "./errors";
import type { ReviewFinding } from "./review-context";
import type { Clock } from "./queue";
import {
  blockingFindings,
  reviewDeniedTools,
  runReviewGate,
  REVIEW_DENIED_TOOLS,
  REVIEW_SETTING_SOURCES,
  type ReviewGateContext,
  type ReviewGateResult,
  type ReviewRound,
} from "./review-gate";
import { makeProjectDb, type TestProjectDb } from "@/lib/testing/project";

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
  labels: ["risk:high"],
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
    // `modelUsage: []` is what a result with no readable usage carries (anton-77l9).
    return typeof next === "string" ? { ok: true, text: next, modelUsage: [] } : next;
  };
  return { run, calls };
}

let dir: string;
let tdb: TestProjectDb;
let projectId: string;
let priorSessionsRoot: string | undefined;
const clock = new TickingClock(1_700_000_000_000);
/** What each session reported live — asserted so an investigate terminal can hit the right endpoint. */
let reportedInfos: Parameters<ReviewGateContext["report"]>[0][] = [];
const ctx: ReviewGateContext = {
  signal: new AbortController().signal,
  heartbeat: async () => {},
  report: (info) => reportedInfos.push(info),
  claudeReached: async () => {},
  jobId: "job-test",
  type: "execute-epic",
};

beforeEach(async () => {
  reportedInfos = [];
  dir = mkdtempSync(join(tmpdir(), "anton-review-gate-"));
  // A real one-commit repo even though claude, the diff and the worktree state are all faked: the
  // gate reads its trusted inputs (the rulebook) at the base commit and FAILS on a read it cannot
  // make, so a bare temp dir would fail every case with "not a git repository".
  initRepo(dir);
  priorSessionsRoot = process.env.ANTON_SESSIONS_ROOT;
  process.env.ANTON_SESSIONS_ROOT = join(dir, "sessions");
  tdb = makeProjectDb({ repoPath: dir });
  projectId = tdb.projectId;
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
  hashTree?: (worktreePath: string) => Promise<string>,
): {
  result: Promise<ReviewGateResult>;
  calls: RunClaudeOptions[];
  commitMessages: string[];
  commitOptions: Array<{ timeoutMs?: number; signal?: AbortSignal }>;
  restores: string[];
  /** The worktree's dirt as each round's diff was read — the review must see a settled tree. */
  diffStates: string[];
  /** The caller's accumulator: what the gate completed, readable even when `result` rejects. */
  rounds: ReviewRound[];
} {
  const { run, calls } = fakeClaude(replies);
  const commitMessages: string[] = [];
  const commitOptions: Array<{ timeoutMs?: number; signal?: AbortSignal }> = [];
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
      commit: async (_path, message, options) => {
        commitMessages.push(message);
        commitOptions.push(options ?? {});
        const committed = commits[commitMessages.length - 1] ?? true;
        if (committed) worktree.onCommit();
        return { committed };
      },
      readState: worktree.readState,
      restoreState: worktree.restoreState,
      ...(hashTree ? { hashTree } : {}),
    },
  });
  return { result, calls, commitMessages, commitOptions, restores: worktree.restores, diffStates, rounds };
}

/** The recorded sessions in start order — the UI's view of the gate. */
async function sessionKinds(): Promise<Array<{ kind: string; status: string; beadId: string | null }>> {
  const rows = await tdb.db.select().from(schema.sessions).orderBy(asc(schema.sessions.startedAt));
  return rows.map((r) => ({ kind: r.kind, status: r.status, beadId: r.beadId ?? null }));
}

describe("runReviewGate — convergence", () => {
  it("stops after one review when nothing blocking is reported", async () => {
    const { result, calls, commitMessages } = gate([report(9, [ADVISORY])], {
      model: "fallback",
      modelRoutes: [{ jobType: "execute-epic", step: "review", model: "review-model" }],
    });
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
    expect(calls[0].model).toBe("review-model");
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

  it("gives the self-review fix commit the project's configured budget", async () => {
    const { result, commitOptions } = gate([report(4, [BLOCKING]), "fixed", report(9, [])], {
      commitTimeoutMinutes: 10,
    });

    await result;

    expect(commitOptions).toHaveLength(1);
    expect(commitOptions[0]?.timeoutMs).toBe(10 * 60_000);
    expect(commitOptions[0]?.signal).toBe(ctx.signal);
  });

  it("keeps child-ticket label routing through review fixes", async () => {
    const { result, calls } = gate([report(4, [BLOCKING]), "fixed", report(9, [])], {
      model: "fallback",
      modelRoutes: [{ jobType: "execute-epic", step: "review", label: "risk:high", model: "careful" }],
    });

    await result;

    expect(calls.map((call) => call.model)).toEqual(["careful", "careful", "careful"]);
  });

  it("pins every session report to the run's routing — so investigate hits the reviewed endpoint", async () => {
    // A same-machine resume that skips every runTicket never seeds the live handle with routing;
    // the gate's own reports must carry it, or an investigate terminal falls back to current settings.
    const routed: ProjectSettings = { claudeBaseUrl: "https://gw.example/api", claudeAuthTokenEnv: "GW_TOKEN" };
    const { result } = gate([report(4, [BLOCKING]), "fixed", report(9, [])], routed);
    await result;

    // review → fix → re-review: each session's live report carries the pinned gateway route.
    expect(reportedInfos).toHaveLength(3);
    for (const info of reportedInfos) {
      expect(info.routing).toEqual({
        routed: true,
        baseUrl: "https://gw.example/api",
        authTokenEnv: "GW_TOKEN",
        gatewayModelDiscovery: false,
      });
    }
  });

  it("dispatches only the BLOCKING findings to the fix session", async () => {
    const { result, calls } = gate([report(4, [BLOCKING, ADVISORY]), "fixed", report(8, [])]);
    await result;

    expect(calls[1].prompt).toContain("the loop is unbounded");
    expect(calls[1].prompt).not.toContain("the name could be clearer");
    // The fixer runs under the layered execution contract; the reviewer never does (below).
    expect(calls[1].appendSystemPrompt).toBeTruthy();
  });

  it("carries a blocking finding's CLASS into the next round's review prompt", async () => {
    const FENCING_BLOCKING = {
      severity: "blocking",
      location: "src/a.ts:4",
      note: "classic time-of-check-time-of-use race between the check and the write",
    };
    const { result, calls } = gate([report(4, [FENCING_BLOCKING]), "fixed", report(9, [])]);
    await result;

    expect(calls[0].prompt).not.toContain("Blocking classes from the previous round");
    expect(calls[2].prompt).toContain("Blocking classes from the previous round");
    expect(calls[2].prompt).toContain("fencing-toctou: 1");
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

  it(
    "treats a board-only fixer's bd write as progress, not a stall (PR #284 review round 13) — " +
      "the fix leaves no git diff by design, so only the board's own before/after tells them apart",
    async () => {
      const boardOnlyTarget: Bead = { ...target, labels: ["delivery:board"] };
      const boardOnlyTicket: Bead = { ...ticket, labels: ["delivery:board"] };
      const worktree = fakeWorktree();
      let reads = 0;
      // First read is the pre-fix baseline; the second (post-fix) reports the bead changed.
      const readBoardFingerprint = async () => {
        reads += 1;
        return { beads: new Map([[boardOnlyTicket.id, reads === 1 ? "before" : "after"]]) };
      };
      const { run, calls } = fakeClaude([report(4, [BLOCKING]), "closed the bead via bd -C", report(9, [])]);
      const out = await runReviewGate({
        db: tdb.db,
        clock,
        ctx,
        projectId,
        target: boardOnlyTarget,
        tickets: [boardOnlyTicket],
        settings: { reviewMaxRounds: 2 },
        worktreePath: dir,
        baseBranch: "main",
        repoPath: "/repos/anton",
        deps: {
          runClaude: async (options) => {
            worktree.onDispatch();
            return run(options);
          },
          diff: async () => ({ files: [], patch: "", truncated: false }),
          commit: async () => ({ committed: false }), // board-only: nothing ever staged
          readState: worktree.readState,
          restoreState: worktree.restoreState,
          readBoardFingerprint,
          syncBoard: async () => true, // the fix's board write is confirmed synced
        },
      });

      expect(out.outcome).toBe("clean");
      expect(out.rounds[0].fixCommitted).toBe(true);
      expect(calls).toHaveLength(3); // the confirming review still ran, unlike a stalled loop
    },
  );

  it(
    "still gives the fix session board-fix handling for a MIXED run — one ticket is `delivery:board`, " +
      "another is not (PR #284 review round 15) — so a fix to the board-only ticket isn't sent " +
      "against the worktree's frozen bd copy and a real bd-only repair isn't misread as a stall",
    async () => {
      const codeTarget: Bead = { ...target, labels: [] };
      const boardOnlyTicket: Bead = { ...ticket, id: "anton-gate1.1", labels: ["delivery:board"] };
      const plainTicket: Bead = { ...ticket, id: "anton-gate1.2", labels: [] };
      const worktree = fakeWorktree();
      let reads = 0;
      const readBoardFingerprint = async () => {
        reads += 1;
        return { beads: new Map([[boardOnlyTicket.id, reads === 1 ? "before" : "after"]]) };
      };
      const { run, calls } = fakeClaude([report(4, [BLOCKING]), "closed the bead via bd -C", report(9, [])]);
      const out = await runReviewGate({
        db: tdb.db,
        clock,
        ctx,
        projectId,
        target: codeTarget,
        tickets: [boardOnlyTicket, plainTicket],
        settings: { reviewMaxRounds: 2 },
        worktreePath: dir,
        baseBranch: "main",
        repoPath: "/repos/anton",
        deps: {
          runClaude: async (options) => {
            worktree.onDispatch();
            return run(options);
          },
          diff: async () => ({ files: [], patch: "", truncated: false }),
          commit: async () => ({ committed: false }), // no code change staged — the fix was on the board
          readState: worktree.readState,
          restoreState: worktree.restoreState,
          readBoardFingerprint,
          syncBoard: async () => true,
        },
      });

      // Board handling kicked in even though this run is NOT all-board-only: the fix session's own
      // prompt was told about the live board, and the bd-only write counted as progress rather than
      // a stall.
      expect(calls[1]?.prompt).toContain("This run may deliver via the board");
      // Shell-quoted, matching `shellQuotePath` (review-context.ts) — this assertion predated that
      // and never followed the quoting change, failing every run regardless of this PR's own edits.
      expect(calls[1]?.prompt).toContain(`bd -C '/repos/anton' update`);
      // chatgpt-codex-connector, PR #284 review, "Avoid the board-only system contract for mixed
      // runs": this run mixes `boardOnlyTicket` with `plainTicket`, so the SYSTEM prompt must use the
      // softened mixed-run wording — never the unconditional "editing the tree is neither required
      // nor expected" carve-out a run where EVERY ticket is board-only can safely state.
      expect(calls[1]?.appendSystemPrompt).toContain("This run includes a board-only ticket");
      expect(calls[1]?.appendSystemPrompt).not.toContain("This ticket is board-only");
      expect(out.outcome).toBe("clean");
      expect(out.rounds[0].fixCommitted).toBe(true);
      expect(calls).toHaveLength(3); // the confirming review still ran, unlike a stalled loop
    },
  );

  it(
    "fails closed rather than persist an unfenced board-fix confirmation when `bd history` stays " +
      "unavailable (chatgpt-codex-connector, PR #284 review, \"Fail closed when the review-fix " +
      "closure read fails\") — a closed ticket with no stored closure yet must have one READ, not " +
      "silently dropped, or a later reopen-and-reclose could reuse this round's ids with no new work",
    async () => {
      boardHistoryMock.mockRejectedValue(new Error("database is locked"));
      // No `beforeEach` clears this mock's call history across the file's tests, so the baseline is
      // whatever earlier tests already left behind — not zero.
      const callsBefore = setBoardEvidenceConfirmedMock.mock.calls.length;
      try {
        const boardOnlyTarget: Bead = { ...target, labels: ["delivery:board"] };
        const boardOnlyTicket: Bead = { ...ticket, labels: ["delivery:board"] };
        const worktree = fakeWorktree();
        let reads = 0;
        const readBoardFingerprint = async () => {
          reads += 1;
          return { beads: new Map([[boardOnlyTicket.id, reads === 1 ? "before" : "after"]]) };
        };
        const { run } = fakeClaude([report(4, [BLOCKING]), "closed the bead via bd -C", report(9, [])]);
        const result = runReviewGate({
          db: tdb.db,
          clock,
          ctx,
          projectId,
          target: boardOnlyTarget,
          tickets: [boardOnlyTicket],
          settings: { reviewMaxRounds: 2 },
          worktreePath: dir,
          baseBranch: "main",
          repoPath: "/repos/anton",
          deps: {
            runClaude: async (options) => {
              worktree.onDispatch();
              return run(options);
            },
            diff: async () => ({ files: [], patch: "", truncated: false }),
            commit: async () => ({ committed: false }),
            readState: worktree.readState,
            restoreState: worktree.restoreState,
            readBoardFingerprint,
            syncBoard: async () => true,
          },
        });

        const error = await result.then(
          () => undefined,
          (e: unknown) => e,
        );
        expect(isPoisonError(error)).toBe(true);
        expect((error as Error).message).toContain("board-fix evidence");
        // Never reached the write it would have needed a closure fence for.
        expect(setBoardEvidenceConfirmedMock.mock.calls.length).toBe(callsBefore);
      } finally {
        boardHistoryMock.mockResolvedValue([
          { hash: "closure-hash", at: "2026-01-01T00:00:00.000Z", status: "closed" },
        ]);
      }
    },
  );

  it(
    "fails closed rather than persist an unfenced board-fix confirmation when `bd history` answers " +
      "with NO closed version at all (chatgpt-codex-connector, PR #284 review, \"Reject empty " +
      "closure histories before confirming fixes\") — an imported/legacy closed bead whose history " +
      "is genuinely empty must not be treated as a successful-but-fenceless read, or a later " +
      "reopen-and-reclose could reuse this round's ids with no new work",
    async () => {
      boardHistoryMock.mockResolvedValue([]);
      const callsBefore = setBoardEvidenceConfirmedMock.mock.calls.length;
      try {
        const boardOnlyTarget: Bead = { ...target, labels: ["delivery:board"] };
        const boardOnlyTicket: Bead = { ...ticket, labels: ["delivery:board"] };
        const worktree = fakeWorktree();
        let reads = 0;
        const readBoardFingerprint = async () => {
          reads += 1;
          return { beads: new Map([[boardOnlyTicket.id, reads === 1 ? "before" : "after"]]) };
        };
        const { run } = fakeClaude([report(4, [BLOCKING]), "closed the bead via bd -C", report(9, [])]);
        const result = runReviewGate({
          db: tdb.db,
          clock,
          ctx,
          projectId,
          target: boardOnlyTarget,
          tickets: [boardOnlyTicket],
          settings: { reviewMaxRounds: 2 },
          worktreePath: dir,
          baseBranch: "main",
          repoPath: "/repos/anton",
          deps: {
            runClaude: async (options) => {
              worktree.onDispatch();
              return run(options);
            },
            diff: async () => ({ files: [], patch: "", truncated: false }),
            commit: async () => ({ committed: false }),
            readState: worktree.readState,
            restoreState: worktree.restoreState,
            readBoardFingerprint,
            syncBoard: async () => true,
          },
        });

        const error = await result.then(
          () => undefined,
          (e: unknown) => e,
        );
        expect(isPoisonError(error)).toBe(true);
        expect((error as Error).message).toContain("board-fix evidence");
        // Never reached the write it would have needed a closure fence for.
        expect(setBoardEvidenceConfirmedMock.mock.calls.length).toBe(callsBefore);
      } finally {
        boardHistoryMock.mockResolvedValue([
          { hash: "closure-hash", at: "2026-01-01T00:00:00.000Z", status: "closed" },
        ]);
      }
    },
  );

  it(
    "preserves a still-open standalone ticket's stored confirmation `origin` when extending it with " +
      "this round's evidence (chatgpt-codex-connector, PR #284 review, \"Preserve the confirmation " +
      "origin when extending evidence\") — an open ticket in its second delivery lifecycle already " +
      "carries the previous closure in `origin`; overwriting it with a bare `{ ids }` would erase the " +
      "identity `stampConfirmedClosures` (review-fix-finalize.ts) later compares against, leaving the " +
      "eventual merge close permanently unfenceable and the ticket stuck at `stage:in-review`",
    async () => {
      const boardOnlyTarget: Bead = { ...target, labels: ["delivery:board"] };
      const boardOnlyTicket: Bead = { ...ticket, labels: ["delivery:board"] };
      // Both the initial live read and the post-write recheck must see the ticket still open — the
      // default `boardShowMock` implementation (below) answers "closed", which would otherwise make
      // the recheck take the closed-on-recheck fence path this test isn't about.
      const stillOpen = {
        id: boardOnlyTicket.id,
        status: "open" as const,
        title: "",
        issue_type: "task",
        metadata: { boardEvidenceConfirmed: JSON.stringify({ ids: ["prior-id"], origin: "prior-cycle-sha" }) },
      };
      boardShowMock.mockResolvedValueOnce(stillOpen).mockResolvedValueOnce(stillOpen);
      const worktree = fakeWorktree();
      let reads = 0;
      const readBoardFingerprint = async () => {
        reads += 1;
        return { beads: new Map([[boardOnlyTicket.id, reads === 1 ? "before" : "after"]]) };
      };
      const { run } = fakeClaude([report(4, [BLOCKING]), "fixed it", report(9, [])]);
      await runReviewGate({
        db: tdb.db,
        clock,
        ctx,
        projectId,
        target: boardOnlyTarget,
        tickets: [boardOnlyTicket],
        settings: { reviewMaxRounds: 2 },
        worktreePath: dir,
        baseBranch: "main",
        repoPath: "/repos/anton",
        deps: {
          runClaude: async (options) => {
            worktree.onDispatch();
            return run(options);
          },
          diff: async () => ({ files: [], patch: "", truncated: false }),
          commit: async () => ({ committed: false }),
          readState: worktree.readState,
          restoreState: worktree.restoreState,
          readBoardFingerprint,
          syncBoard: async () => true,
        },
      });
      expect(setBoardEvidenceConfirmedMock).toHaveBeenCalledWith(
        "/repos/anton",
        boardOnlyTicket.id,
        expect.any(Array),
        undefined,
        "prior-cycle-sha",
      );
    },
  );

  it(
    "gives the fix session the UNCONDITIONAL board-only system carve-out when EVERY ticket in the " +
      "run is board-only (chatgpt-codex-connector, PR #284 review, \"Avoid the board-only system " +
      "contract for mixed runs\") — only a MIXED run needs the softened wording, since here there is " +
      "no ordinary ticket a blanket 'editing the tree is neither required nor expected' could " +
      "wrongly excuse",
    async () => {
      const boardOnlyTarget: Bead = { ...target, labels: ["delivery:board"] };
      const boardOnlyTicket: Bead = { ...ticket, labels: ["delivery:board"] };
      const worktree = fakeWorktree();
      let reads = 0;
      const readBoardFingerprint = async () => {
        reads += 1;
        return { beads: new Map([[boardOnlyTicket.id, reads === 1 ? "before" : "after"]]) };
      };
      const { run, calls } = fakeClaude([report(4, [BLOCKING]), "closed the bead via bd -C", report(9, [])]);
      const out = await runReviewGate({
        db: tdb.db,
        clock,
        ctx,
        projectId,
        target: boardOnlyTarget,
        tickets: [boardOnlyTicket],
        settings: { reviewMaxRounds: 2 },
        worktreePath: dir,
        baseBranch: "main",
        repoPath: "/repos/anton",
        deps: {
          runClaude: async (options) => {
            worktree.onDispatch();
            return run(options);
          },
          diff: async () => ({ files: [], patch: "", truncated: false }),
          commit: async () => ({ committed: false }),
          readState: worktree.readState,
          restoreState: worktree.restoreState,
          readBoardFingerprint,
          syncBoard: async () => true,
        },
      });

      expect(calls[1]?.appendSystemPrompt).toContain("This ticket is board-only");
      expect(calls[1]?.appendSystemPrompt).not.toContain("This run includes a board-only ticket");
      expect(out.outcome).toBe("clean");
      expect(out.rounds[0].fixCommitted).toBe(true);
    },
  );

  it(
    "refuses to dispatch a board-only fix when the pre-fix board baseline could not be read " +
      "(PR #284 review round 15) — the same fail-closed rule execute-epic-ticket.ts already applies " +
      "before a ticket's first dispatch, so a fixer never runs with nothing to diff its bd writes against",
    async () => {
      const boardOnlyTarget: Bead = { ...target, labels: ["delivery:board"] };
      const boardOnlyTicket: Bead = { ...ticket, labels: ["delivery:board"] };
      const worktree = fakeWorktree();
      const { run, calls } = fakeClaude([report(4, [BLOCKING]), "closed the bead via bd -C"]);
      const error = await runReviewGate({
        db: tdb.db,
        clock,
        ctx,
        projectId,
        target: boardOnlyTarget,
        tickets: [boardOnlyTicket],
        settings: { reviewMaxRounds: 3 },
        worktreePath: dir,
        baseBranch: "main",
        repoPath: "/repos/anton",
        deps: {
          runClaude: async (options) => {
            worktree.onDispatch();
            return run(options);
          },
          diff: async () => ({ files: [], patch: "", truncated: false }),
          commit: async () => ({ committed: false }),
          readState: worktree.readState,
          restoreState: worktree.restoreState,
          readBoardFingerprint: async () => undefined, // mustReadBoard exhausted its retries
        },
      }).then(
        () => undefined,
        (e: unknown) => e,
      );

      expect(isPoisonError(error)).toBe(true);
      expect((error as Error).message).toMatch(/could not read a board-only baseline/);
      // The review itself still ran (round 1 dispatched a review), but the fix session it triggered
      // was refused before it ever reached claude.
      expect(calls).toHaveLength(1);
    },
  );

  it(
    "still refuses to dispatch on an unreadable board baseline in a MIXED run even when the round's " +
      "blocking finding is against the NON-board-only ticket (@claude, PR #284 review) — `boardOnly` " +
      "is deliberately the any-ticket predicate (see runReviewGate's own comment on `hasBoardOnlyTicket` " +
      "vs `isBoardOnlyDelivery`): a fix session has no way to tell, from a finding's `file:line` alone, " +
      "which ticket it concerns, so a transient board-read failure fails the WHOLE round closed rather " +
      "than risk dispatching a fixer this run could not durably anchor if it turned out to touch the " +
      "board-only ticket after all",
    async () => {
      const codeTarget: Bead = { ...target, labels: [] };
      const boardOnlyTicket: Bead = { ...ticket, id: "anton-gate1.1", labels: ["delivery:board"] };
      const plainTicket: Bead = { ...ticket, id: "anton-gate1.2", labels: [] };
      const worktree = fakeWorktree();
      // The blocking finding names only a file that belongs to the plain, non-board-only ticket —
      // nothing here implicates the board-only one.
      const { run, calls } = fakeClaude([report(4, [{ severity: "blocking", location: "src/plain.ts:1", note: "plain bug" }]), "fixed it"]);
      const error = await runReviewGate({
        db: tdb.db,
        clock,
        ctx,
        projectId,
        target: codeTarget,
        tickets: [boardOnlyTicket, plainTicket],
        settings: { reviewMaxRounds: 3 },
        worktreePath: dir,
        baseBranch: "main",
        repoPath: "/repos/anton",
        deps: {
          runClaude: async (options) => {
            worktree.onDispatch();
            return run(options);
          },
          diff: async () => ({ files: [], patch: "", truncated: false }),
          commit: async () => ({ committed: false }),
          readState: worktree.readState,
          restoreState: worktree.restoreState,
          readBoardFingerprint: async () => undefined, // mustReadBoard exhausted its retries (network blip)
        },
      }).then(
        () => undefined,
        (e: unknown) => e,
      );

      expect(isPoisonError(error)).toBe(true);
      expect((error as Error).message).toMatch(/could not read a board-only baseline/);
      expect(calls).toHaveLength(1);
    },
  );

  it(
    "parks instead of treating an unreadable post-fix board read as no change (PR #284 review round " +
      "16) — a board-capable fixer's real write must never fold into a false no-progress signal just " +
      "because the confirming read failed",
    async () => {
      const boardOnlyTarget: Bead = { ...target, labels: ["delivery:board"] };
      const boardOnlyTicket: Bead = { ...ticket, labels: ["delivery:board"] };
      const worktree = fakeWorktree();
      let reads = 0;
      // First read (pre-fix baseline) succeeds; the second (post-fix) exhausts its retries.
      const readBoardFingerprint = async () => {
        reads += 1;
        return reads === 1 ? { beads: new Map([[boardOnlyTicket.id, "before"]]) } : undefined;
      };
      const { run, calls } = fakeClaude([report(4, [BLOCKING]), "closed the bead via bd -C"]);
      const error = await runReviewGate({
        db: tdb.db,
        clock,
        ctx,
        projectId,
        target: boardOnlyTarget,
        tickets: [boardOnlyTicket],
        settings: { reviewMaxRounds: 3 },
        worktreePath: dir,
        baseBranch: "main",
        repoPath: "/repos/anton",
        deps: {
          runClaude: async (options) => {
            worktree.onDispatch();
            return run(options);
          },
          diff: async () => ({ files: [], patch: "", truncated: false }),
          commit: async () => ({ committed: false }),
          readState: worktree.readState,
          restoreState: worktree.restoreState,
          readBoardFingerprint,
        },
      }).then(
        () => undefined,
        (e: unknown) => e,
      );

      expect(isPoisonError(error)).toBe(true);
      expect((error as Error).message).toMatch(/could not read the board fingerprint after round/);
      expect((error as Error).message).toContain(boardOnlyTarget.id);
      expect(calls).toHaveLength(2); // no confirming review dispatched after the park
    },
  );

  it(
    "reverts a mixed fixer's git changes before poisoning on an unreadable post-fix board read " +
      "(PR #284 review, \"restore git state before poisoning on an unreadable board\") — a fixer " +
      "that also touched the git tree has an UNVERIFIED tree at that point (no gates ran, nothing " +
      "committed), so the poison must not bypass the same discard a red gate would trigger",
    async () => {
      const boardOnlyTarget: Bead = { ...target, labels: ["delivery:board"] };
      const boardOnlyTicket: Bead = { ...ticket, labels: ["delivery:board"] };
      // dispatch #2 is the fix session — it dirties the tree, mimicking a fixer that wrote both a
      // file AND a bd update before the confirming board read fails.
      const worktree = fakeWorktree([2]);
      let reads = 0;
      const readBoardFingerprint = async () => {
        reads += 1;
        return reads === 1 ? { beads: new Map([[boardOnlyTicket.id, "before"]]) } : undefined;
      };
      const { run, calls } = fakeClaude([report(4, [BLOCKING]), "touched a file and wrote to bd"]);
      const error = await runReviewGate({
        db: tdb.db,
        clock,
        ctx,
        projectId,
        target: boardOnlyTarget,
        tickets: [boardOnlyTicket],
        settings: { reviewMaxRounds: 3 },
        worktreePath: dir,
        baseBranch: "main",
        repoPath: "/repos/anton",
        deps: {
          runClaude: async (options) => {
            worktree.onDispatch();
            return run(options);
          },
          diff: async () => ({ files: [], patch: "", truncated: false }),
          commit: async () => ({ committed: false }),
          readState: worktree.readState,
          restoreState: worktree.restoreState,
          readBoardFingerprint,
        },
      }).then(
        () => undefined,
        (e: unknown) => e,
      );

      expect(isPoisonError(error)).toBe(true);
      // The whole point: the git dirt the fixer left standing was reverted BEFORE the run parked —
      // discardSessionWrites only calls restoreState when the post-session state differs from the
      // pre-round baseline, so a non-empty call here proves the rollback actually ran.
      expect(worktree.restores.length).toBeGreaterThan(0);
      expect(calls).toHaveLength(2); // no confirming review dispatched after the park
    },
  );

  it(
    "poisons instead of treating an unreadable failure-audit as no board change (PR #284 review, " +
      '"poison when the failed-fix board audit is unreadable") — a fixer that mutated the board and ' +
      "THEN failed (e.g. because its own sync came back false) must not have that write waved through " +
      "as an ordinary retryable stall just because the audit read itself could not confirm it",
    async () => {
      const boardOnlyTarget: Bead = { ...target, labels: ["delivery:board"] };
      const boardOnlyTicket: Bead = { ...ticket, labels: ["delivery:board"] };
      const worktree = fakeWorktree();
      let reads = 0;
      const readBoardFingerprint = async () => {
        reads += 1;
        // The pre-fix baseline succeeds; every read taken AFTER the fixer's own failure is
        // unreadable — `mustReadBoard` exhausted its retries on a genuinely contended board.
        return reads === 1 ? { beads: new Map([[boardOnlyTicket.id, "before"]]) } : undefined;
      };
      const { run, calls } = fakeClaude([
        report(4, [BLOCKING]),
        new Error("the board write could not be confirmed synced"),
      ]);
      const error = await runReviewGate({
        db: tdb.db,
        clock,
        ctx,
        projectId,
        target: boardOnlyTarget,
        tickets: [boardOnlyTicket],
        settings: { reviewMaxRounds: 3 },
        worktreePath: dir,
        baseBranch: "main",
        repoPath: "/repos/anton",
        deps: {
          runClaude: async (options) => {
            worktree.onDispatch();
            return run(options);
          },
          diff: async () => ({ files: [], patch: "", truncated: false }),
          commit: async () => ({ committed: false }),
          readState: worktree.readState,
          restoreState: worktree.restoreState,
          readBoardFingerprint,
        },
      }).then(
        () => undefined,
        (e: unknown) => e,
      );

      expect(isPoisonError(error)).toBe(true);
      expect((error as Error).message).toMatch(/post-failure board audit could not be read/);
      expect((error as Error).message).toContain(boardOnlyTarget.id);
      // The original failure survives in the poison, so a human sees WHY the fixer stopped, not
      // just that the audit read afterward was unreadable.
      expect((error as Error).message).toContain("could not be confirmed synced");
      expect(calls).toHaveLength(2); // no confirming review dispatched after the park
    },
  );

  it(
    "includes the changed beads in the stray-branch poison when a board-capable fixer also " +
      'switches branches (PR #284 review, "Audit board changes even when the fixer switches ' +
      'branches") — the outer catch skips the failed-fix board audit entirely for a PoisonError ' +
      "like the stray-branch one, so that poison itself has to say a live board write already " +
      "escaped before anyone reviewed it",
    async () => {
      const boardOnlyTarget: Bead = { ...target, labels: ["delivery:board"] };
      const boardOnlyTicket: Bead = { ...ticket, labels: ["delivery:board"] };
      // Dispatch 2 is the fix session — it writes to the board AND checks out a branch of its own.
      const worktree = fakeWorktree([], "", [], [2]);
      let reads = 0;
      const readBoardFingerprint = async () => {
        reads += 1;
        return { beads: new Map([[boardOnlyTicket.id, reads === 1 ? "before" : "after"]]) };
      };
      const { run, calls } = fakeClaude([report(4, [BLOCKING]), "fixed it on a branch of my own, via bd -C"]);
      const error = await runReviewGate({
        db: tdb.db,
        clock,
        ctx,
        projectId,
        target: boardOnlyTarget,
        tickets: [boardOnlyTicket],
        settings: { reviewMaxRounds: 2 },
        worktreePath: dir,
        baseBranch: "main",
        repoPath: "/repos/anton",
        deps: {
          runClaude: async (options) => {
            worktree.onDispatch();
            return run(options);
          },
          diff: async () => ({ files: [], patch: "", truncated: false }),
          commit: async () => ({ committed: false }),
          readState: worktree.readState,
          restoreState: worktree.restoreState,
          readBoardFingerprint,
          syncBoard: async () => true, // the fixer's board write is confirmed synced
        },
      }).then(
        () => undefined,
        (e: unknown) => e,
      );

      expect(isPoisonError(error)).toBe(true);
      expect((error as Error).message).toMatch(/on a branch of its own/);
      expect((error as Error).message).toContain(boardOnlyTicket.id);
      expect(calls).toHaveLength(2); // no confirming review on work the PR would never carry
    },
  );

  it(
    "parks instead of stalling when a board-only fix's write cannot be confirmed synced " +
      "(PR #284 review round 15) — a local-only Dolt write must not read as a normal no-progress " +
      "round, since a resume or this run's own best-effort final sync could later publish it with no " +
      "confirming review ever having looked at it",
    async () => {
      const boardOnlyTarget: Bead = { ...target, labels: ["delivery:board"] };
      const boardOnlyTicket: Bead = { ...ticket, labels: ["delivery:board"] };
      const worktree = fakeWorktree();
      let reads = 0;
      const readBoardFingerprint = async () => {
        reads += 1;
        return { beads: new Map([[boardOnlyTicket.id, reads === 1 ? "before" : "after"]]) };
      };
      const { run, calls } = fakeClaude([report(4, [BLOCKING]), "closed the bead via bd -C"]);
      const error = await runReviewGate({
        db: tdb.db,
        clock,
        ctx,
        projectId,
        target: boardOnlyTarget,
        tickets: [boardOnlyTicket],
        settings: { reviewMaxRounds: 3 },
        worktreePath: dir,
        baseBranch: "main",
        repoPath: "/repos/anton",
        deps: {
          runClaude: async (options) => {
            worktree.onDispatch();
            return run(options);
          },
          diff: async () => ({ files: [], patch: "", truncated: false }),
          commit: async () => ({ committed: false }),
          readState: worktree.readState,
          restoreState: worktree.restoreState,
          readBoardFingerprint,
          syncBoard: async () => false, // the confirming push never lands
        },
      }).then(
        () => undefined,
        (e: unknown) => e,
      );

      expect(isPoisonError(error)).toBe(true);
      expect((error as Error).message).toMatch(/could not be confirmed synced/);
      expect((error as Error).message).toContain(boardOnlyTicket.id);
      expect(calls).toHaveLength(2); // no confirming review dispatched after the park
    },
  );

  it(
    "parks instead of retrying when a board-only fix FAILS after already writing to the live board " +
      "(PR #284 review round 14) — the git side is reverted, but the bd write already landed on the " +
      "shared board with none of this round's gates having passed on it, so the run halts for a human " +
      "rather than letting a retry or the run's own best-effort sync treat it as settled",
    async () => {
      const boardOnlyTarget: Bead = { ...target, labels: ["delivery:board"] };
      const boardOnlyTicket: Bead = { ...ticket, labels: ["delivery:board"] };
      const worktree = fakeWorktree();
      let reads = 0;
      // First read is the pre-fix baseline; the second (from the catch block, after the fixer
      // crashed) reports the bead already changed — the fixer's own `bd` write landed before it died.
      const readBoardFingerprint = async () => {
        reads += 1;
        return { beads: new Map([[boardOnlyTicket.id, reads === 1 ? "before" : "after"]]) };
      };
      const { run, calls } = fakeClaude([report(4, [BLOCKING]), new Error("claude crashed after writing to bd")]);
      const error = await runReviewGate({
        db: tdb.db,
        clock,
        ctx,
        projectId,
        target: boardOnlyTarget,
        tickets: [boardOnlyTicket],
        settings: { reviewMaxRounds: 3 },
        worktreePath: dir,
        baseBranch: "main",
        repoPath: "/repos/anton",
        deps: {
          runClaude: async (options) => {
            worktree.onDispatch();
            return run(options);
          },
          diff: async () => ({ files: [], patch: "", truncated: false }),
          commit: async () => ({ committed: false }),
          readState: worktree.readState,
          restoreState: worktree.restoreState,
          readBoardFingerprint,
        },
      }).then(
        () => undefined,
        (e: unknown) => e,
      );

      expect(isPoisonError(error)).toBe(true);
      expect((error as Error).message).toMatch(/FAILED after writing directly to the board/);
      expect((error as Error).message).toContain(boardOnlyTicket.id);
      expect(calls).toHaveLength(2); // no confirming review dispatched after the park
    },
  );

  it(
    "still stalls a board-only fix that changed neither the tree nor the board — a genuinely " +
      "declined or no-op fix must not be read as progress just because the run is board-only",
    async () => {
      const boardOnlyTarget: Bead = { ...target, labels: ["delivery:board"] };
      const boardOnlyTicket: Bead = { ...ticket, labels: ["delivery:board"] };
      const worktree = fakeWorktree();
      // Same fingerprint every read: nothing on the board moved either.
      const readBoardFingerprint = async () => ({ beads: new Map([[boardOnlyTicket.id, "unchanged"]]) });
      const { run, calls } = fakeClaude([report(4, [BLOCKING]), "every finding is wrong; left as-is"]);
      const out = await runReviewGate({
        db: tdb.db,
        clock,
        ctx,
        projectId,
        target: boardOnlyTarget,
        tickets: [boardOnlyTicket],
        settings: { reviewMaxRounds: 3 },
        worktreePath: dir,
        baseBranch: "main",
        repoPath: "/repos/anton",
        deps: {
          runClaude: async (options) => {
            worktree.onDispatch();
            return run(options);
          },
          diff: async () => ({ files: [], patch: "", truncated: false }),
          commit: async () => ({ committed: false }),
          readState: worktree.readState,
          restoreState: worktree.restoreState,
          readBoardFingerprint,
        },
      });

      expect(out.outcome).toBe("stalled");
      expect(out.rounds[0].fixCommitted).toBe(false);
      expect(calls).toHaveLength(2); // no confirming review dispatched on a stall
    },
  );

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

  it(
    "also denies `Bash` outright when the board is server-backed (PR #284 review, \"Block " +
      "server-backed board writes during review\", hardened round 18 \"Deny Bash instead of only " +
      "the bd command prefix\") — the OS sandbox only pins a filesystem-backed board shut, and a " +
      "`Bash(bd:*)` command-prefix rule only matches a command that itself starts with `bd`, which " +
      "a shell can route around (`cd` first, a wrapper script, an alias) — so a shared-server board " +
      "gets the whole tool denied instead",
    () => {
      try {
        pinBoardMode("/repos/server-board", { mode: "server" });
        expect(reviewDeniedTools("/repos/server-board")).toEqual([...REVIEW_DENIED_TOOLS, "Bash"]);
        // Unaffected for an embedded board, or when no live board path is in play at all.
        expect(reviewDeniedTools("/repos/anton")).toEqual(REVIEW_DENIED_TOOLS);
        expect(reviewDeniedTools(undefined)).toEqual(REVIEW_DENIED_TOOLS);
      } finally {
        resetBoardModeCache();
      }
    },
  );

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
    const failing = async (): Promise<ClaudeResult> => ({ ok: false, text: "boom", modelUsage: [] });
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
    const { result, restores } = gate([{ ok: false, text: "boom", modelUsage: [] }], {}, [], worktree);

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

/**
 * The gates the REVIEWER is handed instead of running (anton-3jwh's fallout). A trivial `echo` gate
 * stands in for the project's suite: what is under test is which session runs the gates and how
 * often, not what they do.
 */
describe("verify-gate evidence", () => {
  it("runs the project's gates in the review session and hands the reviewer their output", async () => {
    const { result, calls } = gate([report(9, [])], { testCommand: "echo unit-suite-green" });
    await expect(result).resolves.toMatchObject({ outcome: "clean", score: 9 });
    expect(calls[0].prompt).toContain("The checks anton already ran");
    expect(calls[0].prompt).toContain("`echo unit-suite-green`");
    // The reviewer reads the result rather than re-deriving it — the whole point of running it here.
    expect(calls[0].prompt).toContain("unit-suite-green");
  });

  it("runs the gates ONCE per tree, reusing the fix session's run for the next round", async () => {
    const counter = join(dir, "gate-runs");
    const { result } = gate(
      [report(4, [BLOCKING]), "fixed it", report(9, [])],
      { testCommand: `echo ran >> ${counter}` },
      [true],
    );
    await expect(result).resolves.toMatchObject({ outcome: "clean", score: 9 });
    // Round 1's review ran them, then the fix session ran them on what it committed. Round 2 is
    // handed that evidence: a third run would be the suite twice on one tree, which is the
    // contention this whole change exists to remove.
    expect(readFileSync(counter, "utf8").trim().split("\n")).toHaveLength(2);
  });

  it("tells a reviewer with no gates to run the checks itself, in the foreground", async () => {
    const { result, calls } = gate([report(9, [])]);
    await expect(result).resolves.toMatchObject({ outcome: "clean" });
    expect(calls[0].prompt).not.toContain("The checks anton already ran");
    expect(calls[0].prompt).toContain("This project pins no verify gates");
  });

  it("DISCARDS what a gate wrote where git can see it, rather than adopting it as the baseline", async () => {
    // Adopting it would let the reviewer grade content off disk that `openPullRequest` never
    // pushes; blaming the reviewer for it would reject a good report for anton's own write. The
    // third answer is to throw it away before the reviewer runs.
    const sentinel = join(dir, "gate-wrote-this");
    const worktree = fakeWorktree();
    let restored = false;
    const dirty = {
      ...worktree,
      readState: async () => {
        const state = await worktree.readState();
        const dirtyNow = existsSync(sentinel) && !restored;
        return dirtyNow ? { ...state, status: "?? generated-by-the-gate.ts" } : state;
      },
      restoreState: async (path: string, to: WorktreeState) => {
        restored = true;
        return worktree.restoreState(path, to);
      },
    };
    const { result } = gate([report(9, [])], { testCommand: `touch ${sentinel}` }, [], dirty);
    await expect(result).resolves.toMatchObject({ outcome: "clean", score: 9 });
    expect(restored).toBe(true); // the gate's write was thrown away, not reviewed
  });

  it("voids the gate RESULTS too, not just the writes — a later gate may have consumed them", async () => {
    const sentinel = join(dir, "generated-by-gate-one");
    const worktree = fakeWorktree();
    let restored = false;
    const dirty = {
      ...worktree,
      readState: async () => {
        const state = await worktree.readState();
        return existsSync(sentinel) && !restored ? { ...state, status: "?? generated.ts" } : state;
      },
      restoreState: async (path: string, to: WorktreeState) => {
        restored = true;
        return worktree.restoreState(path, to);
      },
    };
    const { result, calls } = gate([report(9, [])], { testCommand: `touch ${sentinel}` }, [], dirty);
    await expect(result).resolves.toMatchObject({ outcome: "clean", score: 9 });
    // The reviewer is told the gates ran and their results were discarded — never shown a "passed"
    // for a tree that has since been reverted out from under it.
    expect(calls[0].prompt).toContain("The checks anton ran, and threw away");
    expect(calls[0].prompt).not.toContain("The checks anton already ran");
  });

  it("re-asserts the run lease after the gates, before spending a reviewer session", async () => {
    // The gates can run for minutes; the round's earlier check is stale by the time claude starts.
    let asserts = 0;
    const { result, calls } = gate(
      [report(9, [])],
      { testCommand: "echo slow-suite" },
      [],
      fakeWorktree(),
      () => {
        asserts += 1;
        if (asserts === 2) throw new Error("run lease lapsed");
      },
    );
    await expect(result).rejects.toThrow("run lease lapsed");
    expect(calls).toEqual([]); // no reviewer session was charged under the lapsed lease
  });
});

/**
 * The fix session's evidence is only good for the tree it describes (PR #254 review). `commitAll`
 * runs the project's hooks, and a lint-staged that rewrites files leaves HEAD holding content the
 * gates never saw — this repo's own pre-commit hook does exactly that.
 */
describe("verify-gate evidence across a commit hook", () => {
  it("drops the fix session's evidence when a hook rewrote the tree, so the next round re-runs", async () => {
    const counter = join(dir, "hooked-gate-runs");
    let hashes = 0;
    const { result } = gate(
      [report(4, [BLOCKING]), "fixed it", report(9, [])],
      { testCommand: `echo ran >> ${counter}` },
      [true],
      fakeWorktree(),
      undefined,
      undefined,
      // Every call differs: the tree the gates tested is never the tree that got committed.
      async () => `tree${++hashes}`,
    );
    await expect(result).resolves.toMatchObject({ outcome: "clean", score: 9 });
    // Round 1's review, the fix session's own gates, and round 2 re-running them: three, not two.
    expect(readFileSync(counter, "utf8").trim().split("\n")).toHaveLength(3);
  });

  it("never rolls back a committed fix because the tree hash could not be taken", async () => {
    // The hash only decides whether the evidence is reusable. A git that cannot answer must not put
    // a verified, committed fix behind the failure path's `discardSessionWrites`.
    const counter = join(dir, "unhashable-gate-runs");
    const worktree = fakeWorktree();
    const { result, commitMessages } = gate(
      [report(4, [BLOCKING]), "fixed it", report(9, [])],
      { testCommand: `echo ran >> ${counter}` },
      [true],
      worktree,
      undefined,
      undefined,
      async () => {
        throw new Error("git write-tree failed");
      },
    );
    await expect(result).resolves.toMatchObject({ outcome: "clean", score: 9 });
    expect(commitMessages).toHaveLength(1); // the fix committed, and was kept
    expect(worktree.restores).toEqual([]); // nothing was discarded
    // Unproven evidence is not reused, so round 2 runs the gates itself.
    expect(readFileSync(counter, "utf8").trim().split("\n")).toHaveLength(3);
  });

  it("keeps the evidence when the commit left the tree the gates tested", async () => {
    const counter = join(dir, "unhooked-gate-runs");
    const { result } = gate(
      [report(4, [BLOCKING]), "fixed it", report(9, [])],
      { testCommand: `echo ran >> ${counter}` },
      [true],
      fakeWorktree(),
      undefined,
      undefined,
      async () => "same-tree",
    );
    await expect(result).resolves.toMatchObject({ outcome: "clean", score: 9 });
    expect(readFileSync(counter, "utf8").trim().split("\n")).toHaveLength(2);
  });
});

/**
 * The self-review half of the attribution stamps (anton-234ja). This gate is one of the two sites
 * PR #311 found the original plan would have left unstamped — it dispatches its own driver and never
 * touches `dispatchClaude` — so "every invocation through `metered(...)` is stamped" is asserted
 * here, on the rows, rather than assumed from the wrapper.
 */
describe("runReviewGate — what produced each invocation", () => {
  it("stamps the fix round with the target's agent, and the review with none when no reviewAgent is set", async () => {
    const { run, calls } = fakeClaude([report(4, [BLOCKING]), "fixed it", report(9, [])]);
    await runReviewGate({
      db: tdb.db,
      clock,
      ctx,
      projectId,
      runId: undefined,
      target: { ...target, labels: ["agent:nextjs"] },
      tickets: [ticket],
      formulaDigest: "9c2e4410ab77",
      settings: {},
      worktreePath: dir,
      baseBranch: "main",
      deps: {
        runClaude: run,
        diff: async () => diff,
        commit: async () => ({ committed: true }),
        readState: async () => ({ head: "c0ffee", ref: RUN_REF, status: "" }),
        restoreState: async () => {},
      },
    });

    // By when they were RECORDED — `id` is a random uuid, which orders nothing. The suite's clock
    // ticks a second per read, so dispatch order and record order are the same here.
    const rows = await tdb.db
      .select()
      .from(schema.claudeInvocations)
      .orderBy(asc(schema.claudeInvocations.recordedAt));
    // Three dispatches: review, fix, re-review — each its own invocation, each its own row.
    expect(rows).toHaveLength(3);
    // The two kinds of session are metered APART by `step` — a review reads a diff, a fix rewrites
    // the tree — while both are the same `review` handler, which is what the phase fold reads.
    expect(rows.map((r) => r.step)).toEqual(["review", "review-fix", "review"]);
    expect(rows.map((r) => r.stepHandler)).toEqual(["review", "review", "review"]);
    for (const row of rows) {
      expect(row).toMatchObject({ beadId: target.id, formulaDigest: "9c2e4410ab77" });
      // Resolved inside the meter: this gate passes no version and still records one.
      expect(row.antonVersion).toBe(selfBuildVersion());
    }
    // No `reviewAgent` is configured, so the shipped default reviews — no named agent ran it, and
    // pooling it under the target's tag would mix "who reviewed" with "who implemented" (PR #313
    // review). The FIX session really is the target's own agent repairing its own work.
    expect(rows.map((r) => r.agentTag)).toEqual([null, "nextjs", null]);
    // The FIX session composes a system prompt (the operating contract + the epic's agent layer);
    // the review deliberately does not, and records the absence rather than a digest of nothing.
    expect(rows[1].promptDigest).toBe(systemPromptDigest(calls[1].appendSystemPrompt ?? ""));
    expect(rows[0].promptDigest).toBeNull();
    // `promptDigest` staying null does NOT mean the review's own reasoning contract went
    // unattributed (PR #313 review): the shipped `review` skill it ran with is named here instead,
    // the same way a `step:claude` step names its skill.
    expect(rows[0]).toMatchObject({ skillId: "review" });
    expect(rows[0].skillDigest).toMatch(/^[0-9a-f]{12}$/);
    // The fix round runs the target's own agent, whose content already rides the `promptDigest`
    // asserted above — it carries no separate skill/prompt-body stamp of its own.
    expect(rows[1]).toMatchObject({ skillId: null, promptBodyDigest: null });
  });

  it("stamps the review with the configured reviewAgent, distinct from the target's own agent", async () => {
    const REVIEWER_ID = "anton-security-reviewer";
    const agentDir = join(dir, ".claude", "agents");
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(join(agentDir, `${REVIEWER_ID}.md`), `---\nname: ${REVIEWER_ID}\n---\n\nREVIEW AS SECURITY.\n`);
    execFileSync("git", ["-C", dir, "add", "-A"], { stdio: "ignore" });
    execFileSync("git", ["-C", dir, "commit", "-qm", "add reviewer agent"], { stdio: "ignore" });

    const { run } = fakeClaude([report(9, [])]);
    await runReviewGate({
      db: tdb.db,
      clock,
      ctx,
      projectId,
      runId: undefined,
      target: { ...target, labels: ["agent:nextjs"] },
      tickets: [ticket],
      settings: { reviewAgent: REVIEWER_ID },
      worktreePath: dir,
      baseBranch: "main",
      deps: {
        runClaude: run,
        diff: async () => diff,
        commit: async () => ({ committed: true }),
        readState: async () => ({ head: "c0ffee", ref: RUN_REF, status: "" }),
        restoreState: async () => {},
      },
    });

    const rows = await tdb.db
      .select()
      .from(schema.claudeInvocations)
      .orderBy(asc(schema.claudeInvocations.recordedAt));
    expect(rows).toHaveLength(1); // clean on round 1, no fix dispatched
    // The reviewer that actually ran (`reviewAgent`) is distinct from the target's implementer, and
    // each column must say which one it is (PR #313 review).
    expect(rows[0]).toMatchObject({ beadId: target.id, agentTag: REVIEWER_ID });
    // `agentTag` names WHO reviewed; a content digest of the agent file it read from is what tells
    // an edit to that same file apart from the text that actually ran (PR #313 review) — the review
    // driver call sets no `appendSystemPrompt` for `metered` to digest on its own.
    expect(rows[0].promptBodyDigest).toMatch(/^[0-9a-f]{12}$/);
    expect(rows[0].skillId).toBeNull();
  });
});
