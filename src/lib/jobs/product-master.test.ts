/**
 * The product-master pass (anton-d2sx), driven through a REAL `JobRunner` against a real (in-memory)
 * anton.db, with `bd`, claude and the sync nudge stubbed — the pass's whole outside world.
 *
 * Four properties carry this job, and each is a way it could silently do harm:
 *   • the session gets no way to write. The board writes anton makes are proposal CREATES and
 *     nothing else, whatever the session reports — until an operator arms a kind by hand, which is
 *     the last describe here (anton-4ab3) and the only path to any other verb.
 *   • a healthy board files nothing, and a BROKEN pass is not a healthy board: an unreadable report
 *     fails the job rather than publishing a clean bill of health nobody reached.
 *   • a claim the board refuses is reported, not dropped — a pass whose every claim was refused must
 *     not look like a pass that found nothing.
 *   • the fingerprints are anton's, so a second pass over an unfixed board asks once.
 */
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ne } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { driveJob, expectJobStatus, makeJobRunner } from "@/lib/testing/jobs";
import type { Bead } from "../beads/bd";
import { LABELS } from "../beads/bd";
import type { ApplyDecision, ApplyMoment } from "../gardener/apply";
import { EARNED_AUTONOMY_BARS } from "../gardener/autonomy";
import {
  parseGardenerPlan,
  proposalFingerprint,
  type GardenerPlan,
} from "../gardener/detections";
import * as schema from "../db/schema";
import { makeTestDb, type TestDb } from "../db/testing";
import type { ClaudeResult, RunClaudeOptions } from "../claude/driver";
import type { Clock } from "./queue";

const pullMock = vi.fn<(cwd: string) => Promise<void>>();
const listMock = vi.fn<(cwd: string, extra?: string[]) => Promise<Bead[]>>();
const showWithCommentsMock = vi.fn<(cwd: string, id: string) => Promise<Bead>>();
/** Only an ARMED apply re-reads a bead under its write lock; every other pass answers from `list`. */
const showMock = vi.fn<(cwd: string, id: string) => Promise<Bead>>();
const createMock = vi.fn<(cwd: string, opts: ProposalCreate) => Promise<string>>();

interface ProposalCreate {
  title: string;
  labels?: string[];
  description?: string;
  deps?: string[];
  metadata?: Record<string, unknown>;
}

/** Every bd WRITE the pass made — the evidence for "it only ever files proposals". */
const writes: string[] = [];

vi.mock("../beads/bd", async () => {
  const actual = await vi.importActual<typeof import("../beads/bd")>("../beads/bd");
  return {
    ...actual,
    beads: {
      ...actual.beads,
      pull: (...a: [string]) => pullMock(...a),
      // The armed walk AWAITS its publish (gardener/armed.ts), so this seam is load-bearing here:
      // unstubbed it would shell out to a real `bd dolt push` from a unit suite.
      push: async () => "synced" as const,
      list: (...a: [string, string[]?]) => listMock(...a),
      showWithComments: (...a: [string, string]) => showWithCommentsMock(...a),
      show: (...a: [string, string]) => showMock(...a),
      create: (cwd: string, opts: ProposalCreate) => {
        writes.push(`create ${opts.title}`);
        return createMock(cwd, opts);
      },
      // Recorded, and by default REFUSED — see `writeVerbMock`.
      close: (_c: string, id: string) => wrote("close", id),
      defer: (_c: string, id: string) => wrote("defer", id),
      update: (_c: string, id: string) => wrote("update", id),
      reparent: (_c: string, id: string) => wrote("reparent", id),
      link: (_c: string, id: string) => wrote("link", id),
      note: (_c: string, id: string) => wrote("note", id),
      untag: (_c: string, id: string) => wrote("untag", id),
    },
  };
});

/**
 * Every write verb a pass can only reach through an ARMED apply (anton-4ab3). Recorded either way,
 * so `writes` stays the whole record of what the pass did to the board — and rejecting by default,
 * so a pass that reaches for one with nothing armed fails loudly instead of quietly mutating.
 */
const writeVerbMock = vi.fn<(verb: string, id: string) => Promise<string>>();

function wrote(verb: string, id: string): Promise<string> {
  writes.push(`${verb} ${id}`);
  return writeVerbMock(verb, id);
}

/**
 * The decision seam, spied rather than replaced: shadow mode's whole claim is that it asks the SAME
 * `planApply` an approval asks, so the default is the real one and only the "it threw" case swaps it.
 */
const planApplyMock =
  vi.fn<(plan: GardenerPlan, board: Bead[], at: ApplyMoment) => ApplyDecision>();

vi.mock("../gardener/apply", async () => {
  const actual = await vi.importActual<typeof import("../gardener/apply")>("../gardener/apply");
  return {
    ...actual,
    planApply: (...a: [GardenerPlan, Bead[], ApplyMoment]) => planApplyMock(...a),
  };
});

const { planApply: realPlanApply } =
  await vi.importActual<typeof import("../gardener/apply")>("../gardener/apply");

const { makeProductMasterHandler } = await import("./product-master");

const NOW = Date.parse("2026-08-04T12:00:00Z");
const REPO = "/tmp/product-master-repo";
/** Movable so a test can let wall-clock time pass DURING the session, as a real pass does. */
let nowMs = NOW;
const clock: Clock = { now: () => nowMs };

let t: TestDb;
let projectId: string;
const nudge = vi.fn();
/** The prompt the last dispatched session was handed — asserted on for the appended board context. */
let dispatched: RunClaudeOptions | undefined;
let sessionText = "";
/** Runs while the session is "thinking" — where a test makes time pass mid-pass. */
let duringSession: (() => void) | undefined;

function bead(id: string, o: Partial<Bead> = {}): Bead {
  return { id, title: id, status: "open", issue_type: "task", priority: 2, ...o };
}

const report = (body: string): string => `Judgment:\n\n\`\`\`json\n${body}\n\`\`\``;

const claim = (o: Record<string, unknown> = {}): string =>
  JSON.stringify({
    proposals: [
      {
        kind: "kill",
        bead: "anton-a",
        summary: "nothing wants this",
        evidence: ["three reviews at 3, 2, 2"],
        ...o,
      },
    ],
  });

const fakeClaude = async (opts: RunClaudeOptions): Promise<ClaudeResult> => {
  dispatched = opts;
  duringSession?.();
  return { ok: true, text: sessionText } as ClaudeResult;
};

/** One pass, driven to settlement. Returns the job id so a caller can read its row. */
function runPass(): Promise<string> {
  return driveJob({
    db: t.db,
    clock,
    type: "product-master",
    handler: ({ db, clock: c }) =>
      makeProductMasterHandler({ db, clock: c, nudge, runClaude: fakeClaude }),
    projectId,
  });
}

/** The pass's session log — where every line an operator reads about this pass lands. */
async function sessionLog(): Promise<string> {
  const [row] = await t.db.select().from(schema.sessions);
  return row?.logPath ? readFileSync(row.logPath, "utf8") : "";
}

let sessionsDir: string;
let priorSessionsRoot: string | undefined;

beforeEach(async () => {
  sessionsDir = mkdtempSync(join(tmpdir(), "anton-product-master-"));
  priorSessionsRoot = process.env.ANTON_SESSIONS_ROOT;
  process.env.ANTON_SESSIONS_ROOT = join(sessionsDir, "sessions");
  t = makeTestDb();
  projectId = randomUUID();
  await t.db.insert(schema.projects).values({
    id: projectId,
    slug: "sandbox",
    name: "sandbox",
    repoPath: REPO,
    defaultBranch: "main",
  });

  writes.length = 0;
  writeVerbMock.mockImplementation((verb, id) =>
    Promise.reject(new Error(`the pass must not ${verb} ${id}`)),
  );
  planApplyMock.mockImplementation(realPlanApply);
  dispatched = undefined;
  duringSession = undefined;
  nowMs = NOW;
  nudge.mockClear();
  sessionText = report(`{"proposals":[]}`);
  pullMock.mockResolvedValue(undefined);
  listMock.mockResolvedValue([bead("anton-a")]);
  showWithCommentsMock.mockImplementation(async (_c, id) => bead(id, { comments: [] }));
  showMock.mockRejectedValue(new Error("no such bead"));
  let n = 0;
  createMock.mockImplementation(async () => `anton-p${++n}`);
});

afterEach(() => {
  t.close();
  vi.clearAllMocks();
  if (priorSessionsRoot === undefined) delete process.env.ANTON_SESSIONS_ROOT;
  else process.env.ANTON_SESSIONS_ROOT = priorSessionsRoot;
  rmSync(sessionsDir, { recursive: true, force: true });
});

describe("product-master pass", () => {
  it("dispatches a session that CANNOT write, with the board appended beneath the contract", async () => {
    await expectJobStatus(t.db, await runPass(), "done");

    expect(dispatched?.cwd).toBe(REPO);
    // The whole safety case for arming this job: the session has no shell and no editor, so it has
    // no `bd` and no way to touch the board even if its instructions told it to.
    for (const denied of ["Bash", "Write", "Edit"]) {
      expect(dispatched?.disallowedTools).toContain(denied);
    }
    // Contract first, then anton's board and anton's wire format — an operator prompt may restyle
    // the judgment, never what is judged or how the answer is read.
    expect(dispatched?.prompt).toContain("# The product-master pass");
    expect(dispatched?.prompt).toContain("## Board context");
    expect(dispatched?.prompt).toContain("## Reporting format (required)");
    expect(dispatched?.prompt).toContain("- anton-a ");
  });

  it("uses the project's own prompt when the operator set one, and still appends the board", async () => {
    await t.db
      .update(schema.projects)
      .set({ settingsJson: JSON.stringify({ productMasterPrompt: "Judge it my way." }) });
    await expectJobStatus(t.db, await runPass(), "done");

    expect(dispatched?.prompt).toContain("Judge it my way.");
    expect(dispatched?.prompt).not.toContain("# The product-master pass");
    expect(dispatched?.prompt).toContain("## Reporting format (required)");
  });

  it("files NOTHING on a healthy board, and does not nudge a remote it wrote nothing to", async () => {
    await expectJobStatus(t.db, await runPass(), "done");
    expect(writes).toEqual([]);
    expect(nudge).not.toHaveBeenCalled();
  });

  it("files one proposal per accepted claim — and no other board write", async () => {
    listMock.mockResolvedValue([bead("anton-a"), bead("anton-b", { priority: 4 })]);
    sessionText = report(
      JSON.stringify({
        proposals: [
          { kind: "kill", bead: "anton-a", summary: "dead", evidence: ["no score above 3"] },
          {
            kind: "reprioritize",
            bead: "anton-b",
            priority: "P1",
            summary: "it blocks the roadmap",
            evidence: ["anton-b blocks two P1 features"],
          },
        ],
      }),
    );

    await expectJobStatus(t.db, await runPass(), "done");

    expect(writes).toEqual([
      "create Product master: defer anton-a",
      "create Product master: move anton-b to P1",
    ]);
    const [kill, rank] = createMock.mock.calls.map(([, opts]) => opts);
    // The pm namespace, so a fingerprint can never collide with the gardener's over the same bead.
    expect(kill.labels).toEqual(expect.arrayContaining(["source:pm"]));
    expect(kill.labels?.find((l) => l.startsWith("pm:low-value:"))).toBeTruthy();
    expect(rank.labels?.find((l) => l.startsWith("pm:mispriority:"))).toBeTruthy();
    // Provenance: the proposal is reachable from the bead it would act on.
    expect(kill.deps).toEqual(["discovered-from:anton-a"]);
    // The move rides as data, so approving it never depends on parsing prose.
    expect(rank.metadata?.gardener).toMatchObject({ move: "reprioritize", detail: "P1" });
    expect(nudge).toHaveBeenCalledWith({ id: projectId, repoPath: REPO });
  });

  it("asks once: a second pass over the same board files nothing new", async () => {
    sessionText = report(claim());
    await expectJobStatus(t.db, await runPass(), "done");
    const filed = createMock.mock.calls[0][1];

    // The proposal it just filed is now on the board, carrying its fingerprint.
    listMock.mockResolvedValue([
      bead("anton-a"),
      bead("anton-p1", { labels: filed.labels }),
    ]);
    writes.length = 0;
    await expectJobStatus(t.db, await runPass(), "done");
    expect(writes).toEqual([]);
  });

  it("stays silent about a claim a human already declined", async () => {
    sessionText = report(claim());
    await expectJobStatus(t.db, await runPass(), "done");
    const filed = createMock.mock.calls[0][1];

    listMock.mockResolvedValue([
      bead("anton-a"),
      // Declined: closed + abandoned, still carrying the fingerprint. That IS the memory.
      bead("anton-p1", {
        status: "closed",
        labels: [...(filed.labels ?? []), LABELS.abandoned],
      }),
    ]);
    writes.length = 0;
    await expectJobStatus(t.db, await runPass(), "done");
    expect(writes).toEqual([]);
  });

  it("refuses a claim the board contradicts instead of filing a proposal that can only fail", async () => {
    sessionText = report(claim({ bead: "anton-ghost" }));
    await expectJobStatus(t.db, await runPass(), "done");
    expect(writes).toEqual([]);
  });

  // A session runs for many minutes. Checking its claims against the clock AFTER it answers would
  // read a lease that was live at the read as expired, and file a proposal racing that very run.
  it("checks the claims against the board it read, not against the clock the session finished at", async () => {
    listMock.mockResolvedValue([bead("anton-a", { labels: [LABELS.runLease(NOW + 600_000, "abc")] })]);
    sessionText = report(claim());
    duringSession = () => {
      nowMs = NOW + 20 * 60_000; // the lease expired while the session was thinking
    };

    await expectJobStatus(t.db, await runPass(), "done");
    expect(writes).toEqual([]);
  });

  // The one confusion this job is built to prevent. An unreadable report means anton learned
  // nothing; recording it as "no proposals" would publish a clean board the pass never saw.
  it.each([
    ["no report at all", "I read the board and it looked fine to me."],
    ["a report anton cannot parse", "```json\n{\"proposals\": [{\n```"],
    ["a report with prose after it", `${report(`{"proposals":[]}`)}\n\nActually, ignore that.`],
  ])("fails the pass on %s rather than calling the board healthy", async (_label, text) => {
    sessionText = text;
    const job = await expectJobStatus(t.db, await runPass(), "queued");
    expect(job.lastError).toMatch(/report protocol/);
    expect(writes).toEqual([]);
  });

  it("carries the review-score series the board alone cannot show", async () => {
    listMock.mockResolvedValue([bead("anton-a", { labels: ["review-score:3"] })]);
    showWithCommentsMock.mockResolvedValue(
      bead("anton-a", {
        comments: [7, 4, 3].map((score, i) => ({
          text: `\`\`\`json\n${JSON.stringify({
            kind: "anton.review-score",
            round: i + 1,
            score,
            blocking: 0,
            advisory: 0,
            verdict: "clean",
          })}\n\`\`\``,
        })),
      }),
    );

    await expectJobStatus(t.db, await runPass(), "done");
    expect(dispatched?.prompt).toContain("review scores 7,4,3");
  });

  // The hydration budget is small and the board context only renders open work: a settled bead that
  // still carries its score label must not spend a slot the session will never see the result of.
  it("spends its score-series budget on open work only", async () => {
    listMock.mockResolvedValue([
      bead("anton-done", { status: "closed", labels: ["review-score:2"] }),
      bead("anton-a", { labels: ["review-score:3"] }),
    ]);

    await expectJobStatus(t.db, await runPass(), "done");
    expect(showWithCommentsMock.mock.calls.map(([, id]) => id)).toEqual(["anton-a"]);
  });

  it("keeps its judgment when a bead's review history will not load", async () => {
    listMock.mockResolvedValue([bead("anton-a", { labels: ["review-score:3"] })]);
    showWithCommentsMock.mockRejectedValue(new Error("bd exploded"));

    await expectJobStatus(t.db, await runPass(), "done");
    // The label-derived score is still real evidence; losing the thread must not lose the bead.
    expect(dispatched?.prompt).toContain("review scores 3");
  });

  it("pulls the board before judging it, so it never re-raises another machine's ask", async () => {
    await expectJobStatus(t.db, await runPass(), "done");
    expect(pullMock).toHaveBeenCalledWith(REPO);
  });
});

/**
 * Shadow mode (anton-lmps): the pass says what arming a kind WOULD have done with the proposal it
 * just filed, and writes nothing to say it.
 *
 * The same code the gardener patrol shadows through, so the record reads identically from both
 * producers — and `writes` stays the evidence that the only board write is still the create.
 */
describe("product-master pass · shadow mode", () => {
  /** Untouched since well before the pass read the board, so the premise fence still holds. */
  const cold = bead("anton-a", { updated_at: "2026-01-01T00:00:00Z" });

  /** Arm a kind at a level for this project — the operator's stored autonomy policy (anton-nbyy). */
  const arm = (overrides: Record<string, string>) =>
    t.db
      .update(schema.projects)
      .set({ settingsJson: JSON.stringify({ proposalAutonomy: overrides }) });

  beforeEach(async () => {
    sessionText = report(claim());
    listMock.mockResolvedValue([cold]);
    await arm({ "low-value": "shadow" });
  });

  it("records the move it would have applied, and files nothing else to record it", async () => {
    await expectJobStatus(t.db, await runPass(), "done");

    expect(await sessionLog()).toContain(
      "[product-master] SHADOW anton-p1 (low-value) retire/defer anton-a — " +
        "WOULD APPLY: deferred anton-a out of the ready set\n",
    );
    // The proposal create is still the pass's ONLY board write: a shadowed defer defers nothing.
    expect(writes).toEqual(["create Product master: defer anton-a"]);
  });

  it("lands the record on a session the settled job still points at", async () => {
    const jobId = await runPass();
    await expectJobStatus(t.db, jobId, "done");

    const [session] = await t.db.select().from(schema.sessions);
    // The pass writes no run row and the runner's live handle dies with the job, so this link is
    // the jobs page's only route to a finished pass's log — the shadow records included.
    expect(session.jobId).toBe(jobId);
    expect(session.status).toBe("done");
  });

  it("carries planApply's refusal verbatim — the reason is what an operator arms on", async () => {
    // Somebody rewrote the bead while the session was judging it, so the evidence the proposal rests
    // on is stale by the time the shadow decides. That gap is the whole reason the shadow re-reads
    // the board; the point here is that the log carries apply's real words for it.
    const rewritten = bead("anton-a", { updated_at: "2026-08-04T13:00:00Z" });
    let reads = 0;
    listMock.mockImplementation(async () => [++reads > 1 ? rewritten : cold]);

    await expectJobStatus(t.db, await runPass(), "done");

    const plan = parseGardenerPlan(createMock.mock.calls[0][1].metadata?.gardener) as GardenerPlan;
    const decision = realPlanApply(plan, [rewritten], { nowMs: NOW, observedAtMs: NOW });
    expect(decision.status).toBe("refuse");
    expect(await sessionLog()).toContain(
      `WOULD REFUSE: ${decision.status === "refuse" ? decision.reason : ""}\n`,
    );
    expect(writes).toEqual(["create Product master: defer anton-a"]);
  });

  it("shadows nothing for a kind left at propose", async () => {
    await arm({ stale: "shadow" }); // armed, but not the kind this pass files

    await expectJobStatus(t.db, await runPass(), "done");

    expect(writes).toEqual(["create Product master: defer anton-a"]);
    expect(await sessionLog()).not.toContain("SHADOW");
  });

  it("keeps the pass green when planApply throws — the proposal is the work, the shadow is not", async () => {
    planApplyMock.mockImplementation(() => {
      throw new Error("indexBoard exploded");
    });

    await expectJobStatus(t.db, await runPass(), "done");

    expect(await sessionLog()).toContain(
      "SHADOW anton-p1 (low-value) retire/defer anton-a — COULD NOT SHADOW: indexBoard exploded\n",
    );
    expect(writes).toEqual(["create Product master: defer anton-a"]);
  });
});

/**
 * ARMED mode (anton-4ab3): the pass APPLIES what it just filed for a kind an operator armed, through
 * the same `applyProposal` the approve route calls — and through the SAME loop the gardener patrol
 * applies with, so the record reads identically from both producers.
 *
 * `writes` stays the whole record of what the pass did to the board, so each case here says exactly
 * which verbs an arming bought — and the default rejection on every one of them stays in force for
 * every other suite in this file.
 */
describe("product-master pass · armed", () => {
  /** Untouched since well before the pass read the board, so the premise fence still holds. */
  const cold = bead("anton-a", { updated_at: "2026-01-01T00:00:00Z" });

  /** The proposals this pass has filed so far, as the board hands them back. */
  const filed = (): Bead[] =>
    createMock.mock.calls.map(([, draft], i) =>
      bead(`anton-p${i + 1}`, {
        title: draft.title,
        labels: draft.labels,
        metadata: draft.metadata,
        created_at: new Date(nowMs).toISOString(),
      }),
    );

  /**
   * The settled-proposal record that has EARNED `low-value` (anton-m29g): the founder's own accepted
   * kills, plainly closed and still carrying their fingerprints. A `retire`/`defer` is the middle
   * tier, so this is the bar that one clears.
   *
   * Every board in this suite carries it, because these cases are about the armed WALK and the
   * earned floor would otherwise decide all of them before the walk ran — the floor itself is
   * exercised where it lives (gardener/autonomy.test.ts, gardener/track-record.test.ts) and against
   * this handler by the one case below that reads a board without it.
   */
  const earned = (): Bead[] =>
    (["low-value", "degraded-approval"] as const).flatMap((kind) =>
      Array.from({ length: EARNED_AUTONOMY_BARS.dequeued.minSettled }, (_, i) =>
        bead(`anton-rec-${kind}-${i}`, {
          status: "closed",
          labels: [proposalFingerprint(kind, `earned:${i}`)],
          close_reason: `applied: settled a ${kind} ask`,
          closed_at: "2026-01-01T00:00:00Z",
        }),
      ),
    );

  /** Every read answers with these beads plus whatever the pass has filed about them. */
  function boardIs(subjects: () => Bead[], record: () => Bead[] = earned): void {
    const board = () => [...record(), ...subjects(), ...filed()];
    listMock.mockImplementation(async () => board());
    showMock.mockImplementation(async (_c, id) => {
      const found = board().find((b) => b.id === id);
      if (!found) throw new Error(`no such bead: ${id}`);
      return found;
    });
  }

  /** Arm a kind at a level for this project — the operator's stored autonomy policy (anton-nbyy). */
  const arm = (overrides: Record<string, string>) =>
    t.db
      .update(schema.projects)
      .set({ settingsJson: JSON.stringify({ proposalAutonomy: overrides }) });

  beforeEach(async () => {
    sessionText = report(claim());
    boardIs(() => [cold]);
    await arm({ "low-value": "apply" });
  });

  it("applies what it filed, names POLICY as the actor, and records it as the patrol does", async () => {
    writeVerbMock.mockResolvedValue("");

    await expectJobStatus(t.db, await runPass(), "done");

    // The whole loop in the order it runs: file the ask, make the move, say who made it, settle.
    expect(writes).toEqual([
      "create Product master: defer anton-a",
      "defer anton-a",
      "note anton-p1",
      "close anton-p1",
    ]);
    // Byte-identical in shape to the gardener's line (gardener.test.ts) — one loop, two producers.
    expect(await sessionLog()).toContain(
      "[product-master] APPLY anton-p1 (low-value) retire/defer anton-a — " +
        "APPLIED: deferred anton-a out of the ready set\n",
    );
    expect(nudge).toHaveBeenCalledWith({ id: projectId, repoPath: REPO });
  });

  it("applies nothing for an armed kind the board's own record has not earned (anton-m29g)", async () => {
    // The setting says `apply` and the pass still writes nothing but the ask itself. The product
    // master's kinds are JUDGMENT — whether a bead is really low-value is not a question a clean
    // shadow can answer — so the founder's own verdicts are the only evidence there is.
    boardIs(() => [cold], () => []);
    writeVerbMock.mockResolvedValue("");

    await expectJobStatus(t.db, await runPass(), "done");

    expect(writes).toEqual(["create Product master: defer anton-a"]);
    expect(await sessionLog()).not.toContain("APPLY anton-p1");
  });

  it("spends ONE write cap across both tiers — the budget is the pass's, not the tier's", async () => {
    // Approval rot files ahead of the session (anton-xg5y), so tier 1 can spend the whole cap before
    // tier 2 has filed anything. A per-tier cap would let one pass write twice what it may.
    const degraded = [1, 2, 3].flatMap((n) => [
      bead(`anton-x${n}`, { issue_type: "epic", labels: [LABELS.approved] }),
      bead(`anton-f${n}`, { issue_type: "feature", parent: `anton-x${n}` }),
    ]);
    boardIs(() => [cold, ...degraded]);
    await arm({ "low-value": "apply", "degraded-approval": "apply" });
    writeVerbMock.mockResolvedValue("");

    await expectJobStatus(t.db, await runPass(), "done");

    // Three unapproves — the cap — and NOT the fourth armed move the session asked for.
    expect(writes.filter((w) => w.startsWith("untag "))).toHaveLength(3);
    expect(writes).not.toContain("defer anton-a");
    const log = await sessionLog();
    // The cap names the PASS's budget and what tier 1 already spent of it, so "held back 1 — one
    // pass applies at most 3" never reads as a cap that should have let this one through.
    expect(log).toContain(
      "APPLY held back 1 armed proposal(s) — one pass applies at most 3, and 3 of those were " +
        "already spent earlier in this pass; they stay open as ordinary asks (anton-p4)",
    );
    // Held back is an ask still standing, not a write deferred to later in the same pass.
    expect(writes).not.toContain("close anton-p4");
  });

  it("shares ONE write cap with the earlier attempts of the same job", async () => {
    // The runner retries a pass that died after its writes under the same job id, and each attempt
    // opens its own session. A fresh cap per attempt would let one scheduled pass apply several
    // caps' worth unattended — the exact failure the cap exists to prevent.
    writeVerbMock.mockResolvedValue("");
    const runner = makeJobRunner({
      db: t.db,
      clock,
      type: "product-master",
      handler: ({ db, clock: c }) =>
        makeProductMasterHandler({ db, clock: c, nudge, runClaude: fakeClaude }),
    });
    const jobId = await runner.enqueue({
      type: "product-master",
      projectId,
      payload: { projectId },
    });
    const spentPath = join(sessionsDir, "first-attempt.log");
    writeFileSync(
      spentPath,
      [1, 2, 3]
        .map(
          (n) =>
            `[product-master] APPLY anton-q${n} (low-value) retire/defer anton-b${n} — ` +
            `APPLIED: deferred anton-b${n}\n`,
        )
        .join(""),
    );
    await t.db.insert(schema.sessions).values({
      id: "s-first-attempt",
      projectId,
      jobId,
      kind: "product-master",
      status: "failed",
      logPath: spentPath,
      startedAt: new Date(NOW - 60_000),
    });

    expect(await runner.tickOnce()).toBe(1);
    await runner.whenIdle();
    await expectJobStatus(t.db, jobId, "done");

    // The ask is filed as always; what the earlier attempt spent is what stops it being applied.
    expect(writes).toEqual(["create Product master: defer anton-a"]);
    const [row] = await t.db
      .select()
      .from(schema.sessions)
      .where(ne(schema.sessions.id, "s-first-attempt"));
    const log = readFileSync(row.logPath as string, "utf8");
    expect(log).toContain(
      "APPLY budget: earlier attempt(s) of this job already spent 3 of the unattended write " +
        "budget on apply attempts — the cap counts attempts, so some may have been refused or " +
        "have failed rather than moved the board; this job's record carries each one's verdict " +
        "— one pass applies at most 3, so this attempt may apply 0",
    );
    expect(log).toContain("APPLY held back 1 armed proposal(s)");
  });

  it("judges the board tier 1 LEFT, not the one it found", async () => {
    // Revalidation armed at `apply` withdraws approvals BEFORE the session runs. Handed the
    // pre-write snapshot, the session would reason about a board this same pass had already
    // changed — and its claims are then eligible for unattended application in tier 2.
    const rotted = [
      bead("anton-x1", { issue_type: "epic", labels: [LABELS.approved] }),
      bead("anton-f1", { issue_type: "feature", parent: "anton-x1" }),
    ];
    // Stands in for everything tier 1's writes leave behind: only a board read AFTER the unapprove
    // can carry it.
    const afterTheWrite = bead("anton-late", { title: "landed while tier 1 was writing" });
    let wroteTier1 = false;
    boardIs(() => [cold, ...rotted, ...(wroteTier1 ? [afterTheWrite] : [])]);
    await arm({ "low-value": "apply", "degraded-approval": "apply" });
    writeVerbMock.mockImplementation(async (verb) => {
      if (verb === "untag") wroteTier1 = true;
      return "";
    });

    await expectJobStatus(t.db, await runPass(), "done");

    expect(writes).toContain("untag anton-x1");
    expect(dispatched?.prompt).toContain("anton-late");
  });

  it("re-reads after an apply that SETTLED without touching the subject", async () => {
    // Another actor made the move between this pass's read and its apply. `applyProposal` finds the
    // board already says what the ask wanted, so it closes this pass's proposal and writes nothing
    // (`changed: []`) — and BOTH the subject and the ask are now other than the snapshot holds.
    // Judging tier 2 against it would reason about a pre-move bead and a proposal that is closed.
    const child = bead("anton-f1", { issue_type: "feature", parent: "anton-x1" });
    const approved = bead("anton-x1", { issue_type: "epic", labels: [LABELS.approved] });
    const withdrawn = bead("anton-x1", { issue_type: "epic" });
    // Stands in for everything the other actor's write left behind: only a board read AFTER the
    // apply settled can carry it.
    const afterTheMove = bead("anton-late", { title: "landed while the other actor was writing" });
    let reads = 0;
    boardIs(() =>
      ++reads > 1 ? [cold, withdrawn, child, afterTheMove] : [cold, approved, child],
    );
    await arm({ "low-value": "apply", "degraded-approval": "apply" });
    writeVerbMock.mockResolvedValue("");

    await expectJobStatus(t.db, await runPass(), "done");

    // The pass touched the subject not at all — it only settled the ask about it.
    expect(writes).not.toContain("untag anton-x1");
    expect(writes).toContain("close anton-p1");
    expect(dispatched?.prompt).toContain("anton-late");
  });

  it("judges the board it read when tier 1 wrote nothing — no second read for a quiet tier", async () => {
    // The re-read is bought by a WRITE, not by a tier running: a pass whose tier 1 found nothing
    // pays for one board read, as it did before anything was armed.
    const listCalls = () => listMock.mock.calls.length;
    let atDispatch = 0;
    duringSession = () => {
      atDispatch = listCalls();
    };
    // Nothing armed at all, so no apply and no write.
    await arm({});

    await expectJobStatus(t.db, await runPass(), "done");

    expect(writes).toEqual(["create Product master: defer anton-a"]);
    expect(atDispatch).toBe(1);
  });

  it("keeps the pass green when an apply blows up, and leaves the ask standing", async () => {
    writeVerbMock.mockImplementation((verb) =>
      verb === "defer" ? Promise.reject(new Error("bd defer exploded")) : Promise.resolve(""),
    );

    await expectJobStatus(t.db, await runPass(), "done");

    expect(await sessionLog()).toContain(
      "APPLY anton-p1 (low-value) retire/defer anton-a — COULD NOT APPLY: applying anton-p1 failed",
    );
    // The proposal is never settled by a move that did not land — it keeps the failure as a note and
    // waits for a human, exactly as a failed approval does.
    expect(writes).toContain("note anton-p1");
    expect(writes).not.toContain("close anton-p1");
  });
});
