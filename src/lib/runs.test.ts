/**
 * `findRunFormulaForBranch` (anton-aa3m): which pipeline a later attempt on a branch pins to, and
 * the order `listRecentRunOutcomes` hands the autopilot breakers their evidence in (anton-rgso).
 *
 * The failure it exists to prevent: an ordinary handler error settles the run row `failed`, and the
 * runner's automatic retry reuses the prior attempt's worktree and skips its committed tickets — but
 * `findOpenRunForEpic` never returns a failed row, so that retry would re-SELECT its pipeline from
 * labels and a variant map that may have changed during the backoff. Half the branch would then have
 * walked one formula and half another.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeTestDb, type TestDb } from "./db/testing";
import * as schema from "./db/schema";
import { MAX_GATE_OUTPUT_CHARS } from "./jobs/gate-output";
import { encodeGateFailure } from "./jobs/gate-failure-record";
import { VerifyGateFailedError } from "./jobs/errors";
import { settleStoppedRun } from "./jobs/execute-epic-settle";
import type { EpicRun } from "./jobs/execute-epic-run";
import {
  ANTHROPIC_DEFAULT_ENDPOINT_HOST,
  createRun,
  endpointHostFromBaseUrl,
  findOpenRunForEpic,
  findRunFormulaForBranch,
  findRunGateFailureForBranch,
  findRunReviewKeyForBranch,
  getRunBaseForkSha,
  getRunGateFailure,
  listDeliveriesByBead,
  listRecentRunOutcomes,
  updateRun,
} from "./runs";
import { eq } from "drizzle-orm";
import type { Clock } from "./jobs/queue";

let t: TestDb;
const PROJECT = "p1";
const EPIC = "anton-abc";
const BRANCH = "anton/anton-abc";

beforeEach(async () => {
  t = makeTestDb();
  await t.db.insert(schema.projects).values({
    id: PROJECT,
    slug: "p1",
    name: "P1",
    repoPath: "/repo",
  });
});
afterEach(() => t.close());

interface SeedRun {
  id: string;
  status: string;
  updatedAt: number;
  formula?: string;
  formulaVariant?: string;
  branch?: string;
  epicBeadId?: string;
  projectId?: string;
  startedAt?: number;
  endedAt?: number;
  ticketBeadId?: string;
  reviewKey?: string;
  reviewKeyAdvisories?: string;
  reviewScore?: number;
  reviewKeyScore?: number;
  narrative?: string;
  delivered?: boolean;
  lastGateFailure?: string;
}

async function seed(run: SeedRun): Promise<void> {
  await t.db.insert(schema.runs).values({
    id: run.id,
    projectId: run.projectId ?? PROJECT,
    epicBeadId: run.epicBeadId ?? EPIC,
    branch: run.branch ?? BRANCH,
    status: run.status,
    formula: run.formula,
    formulaVariant: run.formulaVariant,
    ticketBeadId: run.ticketBeadId,
    reviewKey: run.reviewKey,
    reviewKeyAdvisories: run.reviewKeyAdvisories,
    reviewScore: run.reviewScore,
    reviewKeyScore: run.reviewKeyScore,
    narrative: run.narrative,
    lastGateFailure: run.lastGateFailure,
    startedAt: new Date(run.startedAt ?? run.updatedAt),
    endedAt: run.endedAt === undefined ? null : new Date(run.endedAt),
    updatedAt: new Date(run.updatedAt),
    ...(run.delivered === undefined ? {} : { delivered: run.delivered }),
  });
}

/** A ticket's own `execute` session — the per-child completion record a grouped run leaves. */
async function seedSession(row: {
  id: string;
  beadId: string;
  status: string;
  endedAt?: number;
  kind?: string;
  pushed?: boolean;
  runId?: string;
}): Promise<void> {
  await t.db.insert(schema.sessions).values({
    id: row.id,
    projectId: PROJECT,
    runId: row.runId,
    kind: row.kind ?? "execute",
    beadId: row.beadId,
    status: row.status,
    endedAt: row.endedAt === undefined ? null : new Date(row.endedAt),
    pushed: row.pushed,
  });
}

describe("findRunFormulaForBranch", () => {
  it("recovers the pipeline a FAILED attempt recorded — the retry's row is not open", async () => {
    await seed({
      id: "r1",
      status: "failed",
      updatedAt: 1_000_000,
      formula: "/repo/.beads/formulas/heavy.formula.toml",
      formulaVariant: "risk:high",
    });

    expect(await findRunFormulaForBranch(t.db, PROJECT, EPIC, BRANCH)).toEqual({
      source: "/repo/.beads/formulas/heavy.formula.toml",
      variant: "risk:high",
    });
  });

  it("reports no variant when the attempt walked the default", async () => {
    await seed({
      id: "r1",
      status: "failed",
      updatedAt: 1_000_000,
      formula: "/repo/.beads/formulas/anton-run.formula.toml",
    });

    expect(await findRunFormulaForBranch(t.db, PROJECT, EPIC, BRANCH)).toEqual({
      source: "/repo/.beads/formulas/anton-run.formula.toml",
      variant: undefined,
    });
  });

  it("takes the MOST RECENT attempt that recorded one, skipping rows that never got that far", async () => {
    await seed({ id: "old", status: "failed", updatedAt: 1_000_000, formula: "/repo/first.toml" });
    await seed({ id: "newer", status: "failed", updatedAt: 2_000_000, formula: "/repo/second.toml" });
    // Crashed before the formula was validated — it pins nothing, so the choice above still stands.
    await seed({ id: "newest", status: "running", updatedAt: 3_000_000 });

    expect(await findRunFormulaForBranch(t.db, PROJECT, EPIC, BRANCH)).toEqual({
      source: "/repo/second.toml",
      variant: undefined,
    });
  });

  it("selects fresh for a branch nothing has walked", async () => {
    await seed({
      id: "other-branch",
      status: "failed",
      updatedAt: 1_000_000,
      branch: "anton/anton-xyz",
      formula: "/repo/other.toml",
    });

    expect(await findRunFormulaForBranch(t.db, PROJECT, EPIC, BRANCH)).toBeUndefined();
  });

  it("never crosses epics or projects", async () => {
    await seed({
      id: "other-epic",
      status: "failed",
      updatedAt: 1_000_000,
      epicBeadId: "anton-zzz",
      formula: "/repo/other.toml",
    });

    expect(await findRunFormulaForBranch(t.db, PROJECT, "anton-zzz", BRANCH)).toEqual({
      source: "/repo/other.toml",
      variant: undefined,
    });
    expect(await findRunFormulaForBranch(t.db, "p2", "anton-zzz", BRANCH)).toBeUndefined();
  });
});

describe("findRunReviewKeyForBranch (anton-nyz1v)", () => {
  it("recovers the resume key a FAILED attempt recorded — the retry's row is not open", async () => {
    await seed({
      id: "r1",
      status: "failed",
      updatedAt: 1_000_000,
      reviewKey: "base:head:fp",
      reviewKeyAdvisories: "[]",
      reviewKeyScore: 8,
    });

    expect(await findRunReviewKeyForBranch(t.db, PROJECT, EPIC, BRANCH, "r2")).toEqual({
      reviewKey: "base:head:fp",
      reviewKeyAdvisories: "[]",
      reviewScore: 8,
      narrative: null,
    });
  });

  it("reads the score bound to the key, never the row's mutable latest score (PR #280 review)", async () => {
    // A second step:review in the same formula overwrote `reviewScore` on this very row after the
    // first gate's clean verdict recorded `reviewKey`/`reviewKeyScore` — exactly what happens when a
    // later gate blocks or only partially completes. The recovered score must stay bound to the key
    // that matched, not follow the row's now-unrelated latest score.
    await seed({
      id: "r1",
      status: "failed",
      updatedAt: 1_000_000,
      reviewKey: "base:head:fp",
      reviewKeyAdvisories: "[]",
      reviewKeyScore: 8,
      reviewScore: 3,
    });

    expect(await findRunReviewKeyForBranch(t.db, PROJECT, EPIC, BRANCH, "r2")).toEqual({
      reviewKey: "base:head:fp",
      reviewKeyAdvisories: "[]",
      reviewScore: 8,
      narrative: null,
    });
  });

  it("recovers the narrative describe wrote on the same failed attempt (anton-fpkk8)", async () => {
    await seed({
      id: "r1",
      status: "failed",
      updatedAt: 1_000_000,
      reviewKey: "base:head:fp",
      reviewKeyAdvisories: "[]",
      reviewKeyScore: 8,
      narrative: JSON.stringify({ summary: "what changed" }),
    });

    expect(await findRunReviewKeyForBranch(t.db, PROJECT, EPIC, BRANCH, "r2")).toEqual({
      reviewKey: "base:head:fp",
      reviewKeyAdvisories: "[]",
      reviewScore: 8,
      narrative: JSON.stringify({ summary: "what changed" }),
    });
  });

  it("takes the MOST RECENT attempt that recorded one, skipping rows that never got that far", async () => {
    await seed({ id: "old", status: "failed", updatedAt: 1_000_000, reviewKey: "old:key:fp" });
    await seed({ id: "newer", status: "failed", updatedAt: 2_000_000, reviewKey: "new:key:fp" });
    // Crashed before the gate ever reported a verdict — it pins nothing, so the choice above stands.
    await seed({ id: "newest", status: "running", updatedAt: 3_000_000 });

    expect(await findRunReviewKeyForBranch(t.db, PROJECT, EPIC, BRANCH, "r-current")).toMatchObject({
      reviewKey: "new:key:fp",
    });
  });

  it("EXCLUDES the calling run's own row — a formula's second step:review must not skip off the first's write", async () => {
    // Both steps run inside ONE attempt and therefore share ONE run id. The first step:review
    // writes its clean verdict onto that row before the second ever runs; without the exclusion the
    // second would find its own attempt's fresh write and skip itself.
    await seed({ id: "this-attempt", status: "running", updatedAt: 2_000_000, reviewKey: "self:key:fp" });
    await seed({ id: "earlier-attempt", status: "failed", updatedAt: 1_000_000, reviewKey: "prior:key:fp" });

    expect(
      await findRunReviewKeyForBranch(t.db, PROJECT, EPIC, BRANCH, "this-attempt"),
    ).toMatchObject({ reviewKey: "prior:key:fp" });
  });

  it("selects nothing for a branch nothing has walked", async () => {
    await seed({
      id: "other-branch",
      status: "failed",
      updatedAt: 1_000_000,
      branch: "anton/anton-xyz",
      reviewKey: "other:key:fp",
    });

    expect(await findRunReviewKeyForBranch(t.db, PROJECT, EPIC, BRANCH, "r-current")).toBeUndefined();
  });

  it("never crosses epics or projects", async () => {
    await seed({
      id: "other-epic",
      status: "failed",
      updatedAt: 1_000_000,
      epicBeadId: "anton-zzz",
      reviewKey: "other:key:fp",
    });

    expect(
      await findRunReviewKeyForBranch(t.db, PROJECT, "anton-zzz", BRANCH, "r-current"),
    ).toMatchObject({ reviewKey: "other:key:fp" });
    expect(await findRunReviewKeyForBranch(t.db, "p2", "anton-zzz", BRANCH, "r-current")).toBeUndefined();
  });
});

/** A gate failure encoded exactly as `gateFailurePatch` (execute-epic-settle.ts) writes it. */
function encodedGate(beadId: string, label = "tests"): string {
  return encodeGateFailure(
    new VerifyGateFailedError(
      `${label} gate failed for ${beadId} (exit 1)`,
      { label, command: "bun run test", ok: false, code: 1, output: "FAIL one" },
      { beadId },
    ),
    { beadId },
  )!;
}

describe("findRunGateFailureForBranch (anton-q0lpo / anton-pm3kv)", () => {
  // The scenario the read exists for: `gateFailurePatch` only ever fires bundled with
  // `status:"failed"` (execute-epic-settle.ts), so the row that recorded it is never open again —
  // the retry's own row is a fresh one, keyed by run id alone it would find nothing.
  it("recovers the gate a FAILED attempt recorded — the retry's row is not open", async () => {
    await seed({ id: "r1", status: "failed", updatedAt: 1_000_000, lastGateFailure: encodedGate("anton-t1") });

    expect(await findRunGateFailureForBranch(t.db, PROJECT, EPIC, BRANCH)).toEqual({
      label: "tests",
      command: "bun run test",
      code: 1,
      output: "FAIL one",
      beadId: "anton-t1",
    });
  });

  it("takes the MOST RECENT attempt that recorded one, skipping rows that never got that far", async () => {
    await seed({ id: "old", status: "failed", updatedAt: 1_000_000, lastGateFailure: encodedGate("anton-t1", "lint") });
    await seed({ id: "newer", status: "failed", updatedAt: 2_000_000, lastGateFailure: encodedGate("anton-t1", "typecheck") });
    // Crashed before any gate ran — it recorded nothing, so the choice above still stands.
    await seed({ id: "newest", status: "failed", updatedAt: 3_000_000 });

    expect((await findRunGateFailureForBranch(t.db, PROJECT, EPIC, BRANCH))?.label).toBe("typecheck");
  });

  it("reads as absent for a branch nothing has recorded a gate failure on", async () => {
    await seed({ id: "r1", status: "failed", updatedAt: 1_000_000 });

    expect(await findRunGateFailureForBranch(t.db, PROJECT, EPIC, BRANCH)).toBeUndefined();
  });

  it("never crosses branches, epics or projects", async () => {
    await seed({
      id: "other-branch",
      status: "failed",
      updatedAt: 1_000_000,
      branch: "anton/anton-xyz",
      lastGateFailure: encodedGate("anton-t1"),
    });
    await seed({
      id: "other-epic",
      status: "failed",
      updatedAt: 1_000_000,
      epicBeadId: "anton-zzz",
      lastGateFailure: encodedGate("anton-t1"),
    });

    expect(await findRunGateFailureForBranch(t.db, PROJECT, EPIC, BRANCH)).toBeUndefined();
    expect(await findRunGateFailureForBranch(t.db, PROJECT, "anton-zzz", BRANCH)).toBeDefined();
    expect(await findRunGateFailureForBranch(t.db, "p2", "anton-zzz", BRANCH)).toBeUndefined();
  });

  // The real write→retry join: the REAL settle path (settleStoppedRun) records the gate failure on
  // the failing attempt's row, and the retry — a wholly separate row `openRunRow` creates because
  // `findOpenRunForEpic` will not return a `failed` one — is what this read has to serve. Neither
  // row is hand-written; both go through the same code the runner does (`updateRun`, `createRun`).
  it("survives the row boundary a real gate failure always creates on retry", async () => {
    const NOW = 1_700_000_000_000;
    const clock: Clock = { now: () => NOW };
    const failedRunId = "r-attempt1";
    await createRun(t.db, clock, { id: failedRunId, projectId: PROJECT, epicBeadId: EPIC, branch: BRANCH });

    const fakeRun = {
      db: t.db,
      clock,
      ctx: { signal: new AbortController().signal },
      projectId: PROJECT,
      repo: "/tmp/anton-repo-does-not-exist",
      targetId: EPIC,
      runId: failedRunId,
      orphanNotice: "",
      timedOut: [],
      childCascade: null,
      worktree: undefined,
    } as unknown as EpicRun;
    await settleStoppedRun(
      fakeRun,
      new VerifyGateFailedError(
        "tests gate failed for anton-t1 (exit 1)",
        { label: "tests", command: "bun run test", ok: false, code: 1, output: "FAIL one" },
        { beadId: "anton-t1" },
      ),
    );

    // The row settleStoppedRun just wrote is terminal, not resumable — the premise findings
    // anton-q0lpo/anton-pm3kv turned on.
    expect(await findOpenRunForEpic(t.db, PROJECT, EPIC)).toBeUndefined();

    // The retry: a fresh row on the same branch, exactly as `openRunRow` creates one.
    const retryRunId = "r-attempt2";
    await createRun(t.db, clock, { id: retryRunId, projectId: PROJECT, epicBeadId: EPIC, branch: BRANCH });

    expect(await findRunGateFailureForBranch(t.db, PROJECT, EPIC, BRANCH)).toEqual({
      label: "tests",
      command: "bun run test",
      code: 1,
      output: "FAIL one",
      beadId: "anton-t1",
    });
  });
});

describe("listRecentRunOutcomes", () => {
  // Whole seconds; `updatedAt` stores nothing finer, so concurrent runs settle onto the same value.
  const SETTLED = 1_800_000_000_000;

  it("orders same-second settlements by attempt, not by whatever SQLite returns", async () => {
    // The breakers read this list as a SEQUENCE. Left to tie, a delivered run could come back either
    // side of two same-second failures — resetting a streak on one read and latching a disarm on the
    // next, off rows that never changed.
    await seed({ id: "earlier", status: "failed", updatedAt: SETTLED, startedAt: SETTLED - 600_000 });
    await seed({ id: "later", status: "done", updatedAt: SETTLED, startedAt: SETTLED - 60_000 });

    const runs = await listRecentRunOutcomes(t.db, PROJECT, 10);

    expect(runs.map((r) => r.id)).toEqual(["later", "earlier"]);
  });

  it("orders same-second settlements by which run SETTLED last, not which started last", async () => {
    // Start order is only a proxy, and it inverts exactly where it matters: two runs overlap, the
    // one that started first settles second. Read by start order the later-started delivery sorts
    // newest and resets the streak that the failure settling after it should have kept.
    const clock: Clock = { now: () => SETTLED };
    await createRun(t.db, clock, { id: "started-first", projectId: PROJECT, epicBeadId: EPIC });
    await createRun(t.db, clock, { id: "started-second", projectId: PROJECT, epicBeadId: EPIC });
    await updateRun(t.db, clock, "started-second", { status: "done", endedAt: SETTLED });
    await updateRun(t.db, clock, "started-first", { status: "failed", endedAt: SETTLED });

    expect((await listRecentRunOutcomes(t.db, PROJECT, 10)).map((r) => r.id)).toEqual([
      "started-first",
      "started-second",
    ]);
  });

  it("is still total when the attempts also started in the same second", async () => {
    await seed({ id: "first", status: "failed", updatedAt: SETTLED, startedAt: SETTLED - 60_000 });
    await seed({ id: "second", status: "failed", updatedAt: SETTLED, startedAt: SETTLED - 60_000 });

    // Insertion order is the last thing left that says which run came after which.
    expect((await listRecentRunOutcomes(t.db, PROJECT, 10)).map((r) => r.id)).toEqual([
      "second",
      "first",
    ]);
    // And the `limit` boundary takes the same row every time rather than an arbitrary one.
    expect((await listRecentRunOutcomes(t.db, PROJECT, 1)).map((r) => r.id)).toEqual(["second"]);
  });
});

/**
 * The delivery evidence the repair weigher bounds itself with (gardener/repair.ts): a repair only
 * weighs a later failure double until the bead it was made on next DELIVERS, and a delivery that old
 * is behind the streak window the breaker walks.
 */
describe("getRunBaseForkSha (anton-5bpd)", () => {
  const NOW = 1_800_000_000_000;
  const clock: Clock = { now: () => NOW };

  it("round-trips the fork sha a run pinned at creation", async () => {
    await createRun(t.db, clock, { id: "r-fork", projectId: PROJECT, epicBeadId: EPIC });
    await updateRun(t.db, clock, "r-fork", { baseForkSha: "f0f0f0forkcommit" });

    expect(await getRunBaseForkSha(t.db, "r-fork")).toBe("f0f0f0forkcommit");
  });

  // A first attempt has pinned nothing yet — the caller must resolve and store it, not read a stale
  // value. A row from before the column existed reads the same way.
  it("is undefined for a run that has not pinned one", async () => {
    await createRun(t.db, clock, { id: "r-unpinned", projectId: PROJECT, epicBeadId: EPIC });

    expect(await getRunBaseForkSha(t.db, "r-unpinned")).toBeUndefined();
    expect(await getRunBaseForkSha(t.db, "r-missing")).toBeUndefined();
  });
});

describe("listDeliveriesByBead", () => {
  const SETTLED = 1_800_000_000_000;
  const sec = (ms: number) => Math.floor(ms / 1000);

  it("names every delivery of a bead, as target and as the ticket a run stopped inside", async () => {
    await seed({ id: "d1", status: "done", updatedAt: SETTLED, endedAt: SETTLED });
    await seed({
      id: "d2",
      status: "done",
      updatedAt: SETTLED + 60_000,
      endedAt: SETTLED + 60_000,
      epicBeadId: "anton-epic",
      ticketBeadId: EPIC,
    });

    const deliveries = await listDeliveriesByBead(t.db, PROJECT, [EPIC]);

    expect([...(deliveries.get(EPIC) ?? [])].sort()).toEqual([sec(SETTLED), sec(SETTLED + 60_000)]);
  });

  it("counts only runs that DELIVERED, for the beads asked about", async () => {
    await seed({ id: "failed", status: "failed", updatedAt: SETTLED, endedAt: SETTLED });
    await seed({ id: "parked", status: "parked", updatedAt: SETTLED, endedAt: SETTLED });
    await seed({
      id: "other-bead",
      status: "done",
      updatedAt: SETTLED,
      endedAt: SETTLED,
      epicBeadId: "anton-zzz",
    });

    expect(await listDeliveriesByBead(t.db, PROJECT, [EPIC])).toEqual(new Map());
    // No ids, no query: an unrepaired board asks nothing of the runs table.
    expect(await listDeliveriesByBead(t.db, PROJECT, [])).toEqual(new Map());
  });

  it("excludes a done run that verified-retired its target rather than publishing anything", async () => {
    // `finishRun`'s `targetRetired` path (and its recovery twin, `settleRetiredStandalone`) settle
    // the row `done` with no pull request ever opened — a `status: "done"` row alone is not
    // publication evidence (PR #320 review).
    await seed({ id: "retired", status: "done", updatedAt: SETTLED, endedAt: SETTLED, delivered: false });
    await seed({
      id: "delivered",
      status: "done",
      updatedAt: SETTLED + 60_000,
      endedAt: SETTLED + 60_000,
    });

    expect(await listDeliveriesByBead(t.db, PROJECT, [EPIC])).toEqual(
      new Map([[EPIC, [sec(SETTLED + 60_000)]]]),
    );
  });

  it("credits a grouped run's EVERY completed child, not only the ticket its row kept", async () => {
    // `openTicketSession` rewrites `ticketBeadId` per child, so the row remembers the LAST one. A
    // child repaired and delivered earlier in the same run would otherwise have no delivery at all,
    // and its stamp would go on weighing later unrelated failures double.
    await seed({
      id: "grouped",
      status: "done",
      updatedAt: SETTLED + 120_000,
      endedAt: SETTLED + 120_000,
      epicBeadId: "anton-epic",
      ticketBeadId: "anton-last",
    });
    await seedSession({ id: "s1", beadId: EPIC, status: "done", endedAt: SETTLED + 60_000 });
    await seedSession({ id: "s2", beadId: "anton-last", status: "done", endedAt: SETTLED + 120_000 });

    const deliveries = await listDeliveriesByBead(t.db, PROJECT, [EPIC, "anton-last"]);

    expect(deliveries.get(EPIC)).toEqual([sec(SETTLED + 60_000)]);
    expect(deliveries.get("anton-last")).toEqual([sec(SETTLED + 120_000), sec(SETTLED + 120_000)]);
  });

  it("counts only the ticket sessions that COMPLETED their work", async () => {
    await seedSession({ id: "failed", beadId: EPIC, status: "failed", endedAt: SETTLED });
    await seedSession({ id: "running", beadId: EPIC, status: "running" });

    expect(await listDeliveriesByBead(t.db, PROJECT, [EPIC])).toEqual(new Map());
  });

  it("reads a row written before `endedAt` existed at the time it settled", async () => {
    await seed({ id: "legacy", status: "done", updatedAt: SETTLED });

    expect(await listDeliveriesByBead(t.db, PROJECT, [EPIC])).toEqual(
      new Map([[EPIC, [sec(SETTLED)]]]),
    );
  });

  it("credits a review-fix session that actually pushed a correction", async () => {
    // A PR fixed after it opened is delivered again by that push, not by the run row (which named
    // only the PR-opening execute session) — see PR #320 review.
    await seedSession({
      id: "fix1",
      beadId: EPIC,
      kind: "review-fix",
      status: "done",
      endedAt: SETTLED + 90_000,
      pushed: true,
    });

    expect(await listDeliveriesByBead(t.db, PROJECT, [EPIC])).toEqual(
      new Map([[EPIC, [sec(SETTLED + 90_000)]]]),
    );
  });

  it("excludes local ticket commits when the caller asks for delivery evidence only", async () => {
    // The feature ledger's use (PR #320 review): a run that parks or fails before pushing must not
    // let a child's own local commit count as the feature having delivered. A pushed review-fix
    // correction still counts — it genuinely reached the remote.
    await seedSession({ id: "s1", beadId: EPIC, status: "done", endedAt: SETTLED });
    await seedSession({
      id: "fix1",
      beadId: EPIC,
      kind: "review-fix",
      status: "done",
      endedAt: SETTLED + 60_000,
      pushed: true,
    });

    expect(
      await listDeliveriesByBead(t.db, PROJECT, [EPIC], { includeLocalCommits: false }),
    ).toEqual(new Map([[EPIC, [sec(SETTLED + 60_000)]]]));
    // The default keeps counting the local commit too.
    const withLocalCommits = await listDeliveriesByBead(t.db, PROJECT, [EPIC]);
    expect([...(withLocalCommits.get(EPIC) ?? [])].sort()).toEqual(
      [sec(SETTLED), sec(SETTLED + 60_000)].sort(),
    );
  });

  it("still credits a reparented grouped-run child whose own run delivered (PR #320 review, P2)", async () => {
    // A grouped run's row keeps only its FINAL child's `ticketBeadId` — a non-final child later
    // reparented onto a different feature has no run-row evidence in the new scope at all (the row
    // still names the OLD epic and the LAST child). Its own `execute` session is the only evidence
    // left, and it must still count once the run it was opened inside actually delivered.
    await seed({
      id: "grouped",
      status: "done",
      updatedAt: SETTLED,
      endedAt: SETTLED,
      epicBeadId: "anton-old-epic",
      ticketBeadId: "anton-final-child",
    });
    await seedSession({
      id: "s1",
      beadId: EPIC,
      status: "done",
      endedAt: SETTLED,
      runId: "grouped",
    });

    expect(
      await listDeliveriesByBead(t.db, PROJECT, [EPIC], { includeLocalCommits: false }),
    ).toEqual(new Map([[EPIC, [sec(SETTLED)]]]));
  });

  it("uses the containing run's delivery time, not the reparented child's earlier local commit (PR #320 review, P2)", async () => {
    // The child's own execute session settled well before the run it was opened inside actually
    // published — the run kept working (gates, other children) after this one committed locally.
    // Reading the session's own `endedAt` as the delivery time would end `leadMs` at that local
    // commit instead of the later publish it actually waited for.
    await seed({
      id: "grouped",
      status: "done",
      updatedAt: SETTLED + 120_000,
      endedAt: SETTLED + 120_000,
      epicBeadId: "anton-old-epic",
      ticketBeadId: "anton-final-child",
    });
    await seedSession({
      id: "s1",
      beadId: EPIC,
      status: "done",
      endedAt: SETTLED,
      runId: "grouped",
    });

    expect(
      await listDeliveriesByBead(t.db, PROJECT, [EPIC], { includeLocalCommits: false }),
    ).toEqual(new Map([[EPIC, [sec(SETTLED + 120_000)]]]));
  });

  it("excludes a reparented child's local commit when its own run parked or failed", async () => {
    // `delivered` defaults `true` at row creation and is only ever rewritten when a run finishes
    // `status: "done"` — a parked or failed run never gets it flipped to `false`. So excluding this
    // local commit needs the run's `status`, not just its `delivered` flag.
    await seed({ id: "parked", status: "parked", updatedAt: SETTLED, endedAt: SETTLED });
    await seedSession({
      id: "s1",
      beadId: EPIC,
      status: "done",
      endedAt: SETTLED,
      runId: "parked",
    });

    expect(
      await listDeliveriesByBead(t.db, PROJECT, [EPIC], { includeLocalCommits: false }),
    ).toEqual(new Map());
  });

  it("excludes a review-fix session that settled done without pushing anything", async () => {
    // "answered the review feedback; nothing to push" still settles `status: "done"` — it must not
    // read as a delivery the same way a pushed correction does.
    await seedSession({
      id: "fix-answered",
      beadId: EPIC,
      kind: "review-fix",
      status: "done",
      endedAt: SETTLED,
      pushed: false,
    });
    await seedSession({
      id: "fix-legacy",
      beadId: EPIC,
      kind: "review-fix",
      status: "done",
      endedAt: SETTLED,
    });

    expect(await listDeliveriesByBead(t.db, PROJECT, [EPIC])).toEqual(new Map());
  });
});

/** The endpoint a run drove is recorded as provenance (anton-oom5). */
describe("endpoint host", () => {
  const clock: Clock = { now: () => 1_800_000_000_000 };

  it("reduces a routing base URL to its host, never carrying userinfo or a token", () => {
    const host = endpointHostFromBaseUrl("https://user:sk-secret-token@gateway.example:20128/v1");
    expect(host).toBe("gateway.example:20128");
    expect(host).not.toContain("sk-secret-token");
    expect(host).not.toContain("user");
    expect(host).not.toContain("@");
  });

  it("keeps the port, which is how a local gateway is told from Anthropic direct", () => {
    expect(endpointHostFromBaseUrl("http://localhost:20128")).toBe("localhost:20128");
  });

  it("treats a missing or unparseable base URL as unrouted — the Anthropic default", () => {
    expect(endpointHostFromBaseUrl(undefined)).toBe(ANTHROPIC_DEFAULT_ENDPOINT_HOST);
    expect(endpointHostFromBaseUrl("")).toBe(ANTHROPIC_DEFAULT_ENDPOINT_HOST);
    expect(endpointHostFromBaseUrl("   ")).toBe(ANTHROPIC_DEFAULT_ENDPOINT_HOST);
    expect(endpointHostFromBaseUrl("not a url")).toBe(ANTHROPIC_DEFAULT_ENDPOINT_HOST);
  });

  async function endpointHostOf(id: string): Promise<string | null> {
    const row = t.sqlite.prepare("select endpoint_host from runs where id = ?").get(id) as {
      endpoint_host: string | null;
    };
    return row.endpoint_host;
  }

  it("records the Anthropic default for an unrouted run, distinct from a pre-column NULL", async () => {
    await createRun(t.db, clock, { id: "unrouted", projectId: PROJECT, epicBeadId: EPIC });

    expect(await endpointHostOf("unrouted")).toBe(ANTHROPIC_DEFAULT_ENDPOINT_HOST);
  });

  it("records the gateway host for a routed run", async () => {
    await createRun(t.db, clock, {
      id: "routed",
      projectId: PROJECT,
      epicBeadId: EPIC,
      endpointHost: endpointHostFromBaseUrl("https://token@router.local:20128"),
    });

    expect(await endpointHostOf("routed")).toBe("router.local:20128");
  });
});

/**
 * The recorded gate failure (anton-vynb8): what the row remembers between attempts, and the two
 * events that make it forget.
 *
 * The failure it exists to prevent: a resume clears `error`, `reviewScore` and `attemptStartedAt` so
 * the new attempt is judged on its own, and that clear used to take the only account of WHY the last
 * attempt stopped with it — so every retry was dispatched blind into the same red gate.
 */
describe("the run row's recorded gate failure", () => {
  const NOW = 1_700_000_000_000;
  const clock: Clock = { now: () => NOW };

  /** A red gate as the throwing half of `runVerifyGates` reports it. */
  function redGate(output = "FAIL src/lib/runs.test.ts\n1 failed"): VerifyGateFailedError {
    return new VerifyGateFailedError("tests gate failed for anton-t1 (exit 1)", {
      label: "tests",
      command: "bun run test",
      ok: false,
      code: 1,
      output,
    });
  }

  async function record(runId: string, e: unknown, beadId = EPIC): Promise<void> {
    await updateRun(t.db, clock, runId, { lastGateFailure: encodeGateFailure(e, { beadId }) ?? null });
  }

  it("round-trips the gate, its command, its exit code, its output and where it failed", async () => {
    await createRun(t.db, clock, { id: "r-gate", projectId: PROJECT, epicBeadId: EPIC });
    await record("r-gate", new VerifyGateFailedError("tests gate failed for anton-t1 (exit 1)", {
      label: "tests",
      command: "bun run test",
      ok: false,
      code: 1,
      output: "FAIL one",
    }, { beadId: "anton-t1", stepId: "verify" }));

    expect(await getRunGateFailure(t.db, "r-gate")).toEqual({
      label: "tests",
      command: "bun run test",
      code: 1,
      output: "FAIL one",
      beadId: "anton-t1",
      stepId: "verify",
    });
  });

  // A gate thrown without a site still has to name a bead a re-attempt can act on.
  it("falls back to the run target when the gate named no bead of its own", async () => {
    await createRun(t.db, clock, { id: "r-nosite", projectId: PROJECT, epicBeadId: EPIC });
    await record("r-nosite", redGate());

    expect((await getRunGateFailure(t.db, "r-nosite"))?.beadId).toBe(EPIC);
  });

  // A suite prints its dots first and its failures last, so the kept end is the one that says why.
  it("caps the stored output at the reviewer's own bound, keeping the tail", async () => {
    await createRun(t.db, clock, { id: "r-big", projectId: PROJECT, epicBeadId: EPIC });
    const output = `${"progress dot line\n".repeat(2000)}FAIL the one that matters`;
    await record("r-big", redGate(output));

    const stored = (await getRunGateFailure(t.db, "r-big"))!.output;
    expect(stored.length).toBeLessThanOrEqual(MAX_GATE_OUTPUT_CHARS + "… [earlier output omitted]\n".length);
    expect(stored).toContain("FAIL the one that matters");
    expect(stored).toContain("… [earlier output omitted]");
  });

  // THE point of the column: the resume's clear is what it has to outlive.
  it("survives the resume that clears error, reviewScore and attemptStartedAt", async () => {
    await createRun(t.db, clock, { id: "r-resume", projectId: PROJECT, epicBeadId: EPIC });
    await updateRun(t.db, clock, "r-resume", { status: "parked", error: "tests gate failed", reviewScore: 4 });
    await record("r-resume", redGate());

    // Exactly the patch `openRunRow` writes when it picks a parked row back up.
    await updateRun(t.db, clock, "r-resume", {
      status: "running",
      error: null,
      reviewScore: null,
      attemptStartedAt: NOW + 60_000,
    });

    const [row] = await t.db.select().from(schema.runs).where(eq(schema.runs.id, "r-resume"));
    expect(row.error).toBeNull();
    expect(row.reviewScore).toBeNull();
    expect((await getRunGateFailure(t.db, "r-resume"))?.label).toBe("tests");
  });

  it("is forgotten when the gate passes and when the run settles done", async () => {
    for (const [id, patch] of [
      ["r-green", { lastGateFailure: null }],
      ["r-done", { status: "done" as const, endedAt: NOW, error: null, lastGateFailure: null }],
    ] as const) {
      await createRun(t.db, clock, { id, projectId: PROJECT, epicBeadId: EPIC });
      await record(id, redGate());
      expect(await getRunGateFailure(t.db, id)).toBeDefined();

      await updateRun(t.db, clock, id, patch);

      expect(await getRunGateFailure(t.db, id)).toBeUndefined();
    }
  });

  // A first attempt, and a row written before the column existed, read the same way: no record.
  it("reads as absent for a fresh run", async () => {
    await createRun(t.db, clock, { id: "r-fresh", projectId: PROJECT, epicBeadId: EPIC });

    expect(await getRunGateFailure(t.db, "r-fresh")).toBeUndefined();
  });

  // A re-attempt that CRASHES on its predecessor's record is worse than one that starts without it.
  it("reads as absent rather than throwing on a record it cannot parse", async () => {
    await createRun(t.db, clock, { id: "r-junk", projectId: PROJECT, epicBeadId: EPIC });
    await updateRun(t.db, clock, "r-junk", { lastGateFailure: "{not json" });
    expect(await getRunGateFailure(t.db, "r-junk")).toBeUndefined();

    await updateRun(t.db, clock, "r-junk", { lastGateFailure: JSON.stringify({ label: "tests" }) });
    expect(await getRunGateFailure(t.db, "r-junk")).toBeUndefined();
  });

  // Any other failure has learned nothing about the gates; blanking here would blind the retry.
  it("encodes nothing for a failure that was not a red gate", () => {
    expect(encodeGateFailure(new Error("push rejected"), { beadId: EPIC })).toBeUndefined();
  });
});
