/**
 * The product-master pass (anton-d2sx), driven through a REAL `JobRunner` against a real (in-memory)
 * anton.db, with `bd`, claude and the sync nudge stubbed — the pass's whole outside world.
 *
 * Four properties carry this job, and each is a way it could silently do harm:
 *   • the session gets no way to write. The board writes anton makes are proposal CREATES and
 *     nothing else, whatever the session reports.
 *   • a healthy board files nothing, and a BROKEN pass is not a healthy board: an unreadable report
 *     fails the job rather than publishing a clean bill of health nobody reached.
 *   • a claim the board refuses is reported, not dropped — a pass whose every claim was refused must
 *     not look like a pass that found nothing.
 *   • the fingerprints are anton's, so a second pass over an unfixed board asks once.
 */
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { driveJob, expectJobStatus } from "@/lib/testing/jobs";
import type { Bead } from "../beads/bd";
import { LABELS } from "../beads/bd";
import * as schema from "../db/schema";
import { makeTestDb, type TestDb } from "../db/testing";
import type { ClaudeResult, RunClaudeOptions } from "../claude/driver";
import type { Clock } from "./queue";

const pullMock = vi.fn<(cwd: string) => Promise<void>>();
const listMock = vi.fn<(cwd: string, extra?: string[]) => Promise<Bead[]>>();
const showWithCommentsMock = vi.fn<(cwd: string, id: string) => Promise<Bead>>();
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
      list: (...a: [string, string[]?]) => listMock(...a),
      showWithComments: (...a: [string, string]) => showWithCommentsMock(...a),
      create: (cwd: string, opts: ProposalCreate) => {
        writes.push(`create ${opts.title}`);
        return createMock(cwd, opts);
      },
      // Named so a pass that reached for one fails loudly rather than silently mutating the board.
      close: (_c: string, id: string) => trap("close", id),
      defer: (_c: string, id: string) => trap("defer", id),
      update: (_c: string, id: string) => trap("update", id),
      reparent: (_c: string, id: string) => trap("reparent", id),
      link: (_c: string, id: string) => trap("link", id),
    },
  };
});

function trap(verb: string, id: string): Promise<never> {
  writes.push(`${verb} ${id}`);
  return Promise.reject(new Error(`the pass must not ${verb} ${id}`));
}

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

beforeEach(async () => {
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
  dispatched = undefined;
  duringSession = undefined;
  nowMs = NOW;
  nudge.mockClear();
  sessionText = report(`{"proposals":[]}`);
  pullMock.mockResolvedValue(undefined);
  listMock.mockResolvedValue([bead("anton-a")]);
  showWithCommentsMock.mockImplementation(async (_c, id) => bead(id, { comments: [] }));
  let n = 0;
  createMock.mockImplementation(async () => `anton-p${++n}`);
});

afterEach(() => {
  t.close();
  vi.clearAllMocks();
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
