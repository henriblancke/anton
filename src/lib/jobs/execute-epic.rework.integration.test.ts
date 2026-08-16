/**
 * End-to-end proof that a SEND-BACK has a run path back past the target's own pull request
 * (anton-leit). Drives the REAL rework action and the REAL execute-epic handler against a temp
 * bd/git repo with a bare `origin`, using fake `claude`/`gh` binaries — the same sandbox its sibling
 * `execute-epic.*.integration.test.ts` suites build.
 *
 * This is the case a unit test cannot reach: rework's writes are only worth anything if the NEXT
 * RUN executes, and what stops it is execute-epic's step 0a — the short-circuit that finishes an
 * attempt as already-complete on a live PR ref. So every assertion here is about what the run
 * actually did: which beads it dispatched (sessions), and which pull request it ended on.
 *
 * Skipped when bd/git are absent.
 */
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { beads } from "../beads/bd";
import { loadAllIssues } from "../beads/issues";
import * as schema from "../db/schema";
import { resetOperatorCache } from "../operator";
import { getJob } from "./queue";
import { describeBd } from "@/lib/testing/integration";
import { expectJobStatus } from "@/lib/testing/jobs";
import { reworkTicket } from "../rework";
import type { Project } from "../types";
import {
  BASE_TIME_MS,
  resetPerCaseState,
  FakeClock,
  writeBin,
  createExecuteEpicSandbox,
  makeEpicRunner,
  driveEpicRun,
  type ExecuteEpicSandbox,
} from "./execute-epic.fixture";

/**
 * A `gh` that reports every PR in `state` and opens new ones at #99 — the seam both halves of this
 * feature read: `pullRequestState` (which decides HOW a send-back goes back) and
 * `lookupOpenPullRequest` (which decides whether the next run reuses the PR or opens its own).
 * `openPr` is what `pr list --head <branch>` answers with: a live PR to reuse, or none.
 */
function ghReporting(
  binDir: string,
  name: string,
  state: "OPEN" | "MERGED",
  openPr: number | null,
): string {
  const list = openPr === null ? "[]" : JSON.stringify([{ url: prUrl(openPr), number: openPr, isDraft: false }]);
  return writeBin(
    binDir,
    name,
    `const a=process.argv.slice(2);
if(a[0]==='pr'&&a[1]==='view'){process.stdout.write(JSON.stringify({state:'${state}'})+'\\n');process.exit(0);}
if(a[0]==='pr'&&a[1]==='list'){process.stdout.write(${JSON.stringify(list)}+'\\n');process.exit(0);}
if(a[0]==='pr'&&a[1]==='create'){process.stdout.write('${prUrl(99)}\\n');process.exit(0);}
process.exit(0);`,
  );
}

const prUrl = (n: number) => `https://github.com/acme/repo/pull/${n}`;

let tdb: ExecuteEpicSandbox["tdb"];
// rework's live-run guard reads anton's process db (jobs/service → @/lib/db), while the runner
// drives the sandbox's own. Point both at the SAME database so the guard is exercised against the
// runs this suite actually starts rather than an empty one.
vi.mock("@/lib/db", () => ({ getDb: () => tdb.db, schema }));

/** A shaped standalone run target — the contract gate refuses anything less. */
const CONTRACT = (goal: string) =>
  [
    `## Goal`,
    goal,
    ``,
    `## Acceptance Criteria`,
    `- [ ] work file exists`,
    ``,
    `## Context`,
    `fixture`,
    ``,
    `## Out of scope`,
    `everything else`,
    ``,
    `## Verify`,
    `the suite stays green`,
  ].join("\n");

describeBd("execute-epic e2e — a send-back's run path back (real handler · real bd/git · fake claude/gh)", () => {
  let repo: string;
  let binDir: string;
  let clock: FakeClock;
  let projectId: string;
  let successClaude: string;
  let ctx: ExecuteEpicSandbox;
  let project: Project;

  beforeAll(async () => {
    ctx = await createExecuteEpicSandbox();
    ({ repo, binDir, tdb, clock, projectId, successClaude } = ctx);
    project = { id: projectId, slug: "sandbox", name: "sandbox", repoPath: repo } as Project;
  });

  afterAll(() => {
    ctx?.restoreEnv();
    resetOperatorCache();
    ctx?.cleanup();
  });

  beforeEach(async () => {
    clock.set(BASE_TIME_MS);
    process.env.ANTON_CLAUDE_BIN = successClaude;
    await resetPerCaseState(tdb);
  });

  /** Sessions the runs in this case opened, by the bead each was dispatched for. */
  const sessionBeads = async (): Promise<string[]> =>
    (await tdb.db.select().from(schema.sessions)).map((s) => s.beadId ?? "");

  /** Close the `gh:pr` merge waits the run armed on `id` — what `bd gate check` does on a merge. */
  async function resolveMergeGates(id: string): Promise<void> {
    const all = await loadAllIssues(repo);
    const blocking = new Set(
      (all.find((b) => b.id === id)?.dependencies ?? [])
        .filter((d) => d.type === "blocks")
        .map((d) => d.depends_on_id),
    );
    for (const gate of all.filter((b) => blocking.has(b.id) && beads.isMergeWaitGate(b))) {
      await beads.gateResolve(repo, gate.id, "PR merged");
    }
  }

  /** A fresh approved standalone target, carried by one run to in-review on PR #42. */
  async function targetInReview(title: string): Promise<string> {
    const id = await beads.create(repo, {
      title,
      type: "bug",
      acceptance: "work file exists",
      description: CONTRACT(title),
    });
    await beads.approve(repo, id);
    const job = await driveEpicRun(makeEpicRunner(ctx), { projectId, epicBeadId: id });
    await expectJobStatus(tdb.db, job, "done");
    expect(beads.getPrRef(await beads.show(repo, id))).toBe("gh-42");
    return id;
  }

  it("a reworked target whose PR MERGED runs the send-back as its own target, on its own PR", async () => {
    const bugId = await targetInReview("Merged, then sent back");
    // The state a merge leaves behind: `bd gate check` closes the run's `gh:pr` wait, and
    // review-fix's finalization closes the target and drops it out of review. Its PR ref STAYS —
    // that is the record of where the work landed.
    await resolveMergeGates(bugId);
    await beads.untag(repo, bugId, ["stage:in-review"]);
    await beads.close(repo, bugId);

    const okGh = process.env.ANTON_GH_BIN!;
    process.env.ANTON_GH_BIN = ghReporting(binDir, "gh-merged-leit", "MERGED", null);
    try {
      const result = await reworkTicket(project, bugId, {
        ticketId: bugId,
        mode: "reopen",
        summary: "The backoff cap is still missing",
        instructions: "Bound the retry backoff at 30s and cover it with a test.",
      });

      // Merged work can't be un-shipped, so the reopen becomes a run target of its own — reported,
      // not silent, and the merged bead is left exactly as it shipped.
      expect(result.pipeline).toEqual({ outcome: "shipped", pr: "gh-42", redirected: true });
      expect(result.mode).toBe("follow-up");
      expect(result.reworkedId).not.toBe(bugId);
      const merged = await beads.show(repo, bugId);
      expect(merged.status).toBe("closed");
      expect(beads.getPrRef(merged)).toBe("gh-42");

      // The founder's approval is the run trigger, exactly as for any standalone target.
      await beads.approve(repo, result.reworkedId);
      await resetPerCaseState(tdb);
      const job = await driveEpicRun(makeEpicRunner(ctx), {
        projectId,
        epicBeadId: result.reworkedId,
      });

      // What the ticket is actually about: the run DISPATCHED the reworked bead (rather than
      // short-circuiting on the merged target's ref) and opened a pull request of its own.
      await expectJobStatus(tdb.db, job, "done");
      expect(await sessionBeads()).toContain(result.reworkedId);
      const followUp = await beads.show(repo, result.reworkedId);
      expect(beads.getPrRef(followUp)).toBe("gh-99");
      expect(followUp.labels ?? []).toContain("stage:in-review");
    } finally {
      process.env.ANTON_GH_BIN = okGh;
    }
  });

  it("a reworked target whose PR is still OPEN re-runs onto the same branch and updates that PR", async () => {
    const bugId = await targetInReview("Open PR, sent back");

    const okGh = process.env.ANTON_GH_BIN!;
    process.env.ANTON_GH_BIN = ghReporting(binDir, "gh-open-leit", "OPEN", 42);
    try {
      const result = await reworkTicket(project, bugId, {
        ticketId: bugId,
        mode: "reopen",
        summary: "The backoff cap is still missing",
        instructions: "Bound the retry backoff at 30s and cover it with a test.",
      });

      expect(result.pipeline).toEqual({ outcome: "retired", pr: "gh-42", redirected: false });
      // Retired, not merely warned about: without both of these the next run finishes as
      // already-complete at step 0a and the reopened bead sits open forever.
      const retired = await beads.show(repo, bugId);
      expect(beads.getPrRef(retired)).toBeUndefined();
      expect(retired.labels ?? []).not.toContain("stage:in-review");
      expect(retired.status).not.toBe("closed");

      await resetPerCaseState(tdb);
      const job = await driveEpicRun(makeEpicRunner(ctx), { projectId, epicBeadId: bugId });

      // The agent ran again — the whole point of a send-back — and the run landed back on the SAME
      // pull request rather than opening a second one beside it.
      await expectJobStatus(tdb.db, job, "done");
      expect(await sessionBeads()).toContain(bugId);
      const after = await beads.show(repo, bugId);
      expect(beads.getPrRef(after)).toBe("gh-42");
      expect(after.labels ?? []).toContain("stage:in-review");
    } finally {
      process.env.ANTON_GH_BIN = okGh;
    }
  });

  it("a retired PR that MERGES before the rerun parks it, rather than re-dispatching shipped work", async () => {
    const bugId = await targetInReview("Open PR, sent back, then merged");

    const okGh = process.env.ANTON_GH_BIN!;
    process.env.ANTON_GH_BIN = ghReporting(binDir, "gh-open-then-merged-leit", "OPEN", 42);
    try {
      const result = await reworkTicket(project, bugId, {
        ticketId: bugId,
        mode: "reopen",
        summary: "The backoff cap is still missing",
        instructions: "Bound the retry backoff at 30s and cover it with a test.",
      });
      expect(result.pipeline).toEqual({ outcome: "retired", pr: "gh-42", redirected: false });
      // The retire took the live pointer off — but left the PR named on the bead, which is the only
      // thing that can tell this target apart from one that never had a PR at all.
      const retired = await beads.show(repo, bugId);
      expect(beads.getPrRef(retired)).toBeUndefined();
      expect(beads.getRetiredPrRef(retired)).toBe("gh-42");

      // The founder merges gh-42 anyway, before the run the send-back released gets its slot.
      process.env.ANTON_GH_BIN = ghReporting(binDir, "gh-merged-after-retire-leit", "MERGED", null);
      await resetPerCaseState(tdb);
      const job = await driveEpicRun(makeEpicRunner(ctx), { projectId, epicBeadId: bugId });

      // Its work is on the base branch now, so running would re-dispatch shipped tickets onto a
      // closed PR's branch. Park for the founder instead, naming the PR and the way back.
      const parked = await expectJobStatus(tdb.db, job, "parked");
      expect(parked.lastError).toContain("gh-42");
      expect(parked.lastError).toMatch(/merged/);
      expect(await sessionBeads()).not.toContain(bugId);
      // ...and a fresh send-back now reads that same pointer and carries the fix as its own target.
      const followUp = await reworkTicket(project, bugId, {
        ticketId: bugId,
        mode: "reopen",
        summary: "The backoff cap is still missing",
        instructions: "Bound the retry backoff at 30s and cover it with a test.",
      });
      expect(followUp.pipeline).toEqual({ outcome: "shipped", pr: "gh-42", redirected: true });
      expect(followUp.reworkedId).not.toBe(bugId);
    } finally {
      process.env.ANTON_GH_BIN = okGh;
    }
  });

  it("a retired PR whose state can't be READ retries too, rather than running on a guess", async () => {
    const bugId = await targetInReview("Open PR, sent back, then unreadable");

    const okGh = process.env.ANTON_GH_BIN!;
    process.env.ANTON_GH_BIN = ghReporting(binDir, "gh-open-then-broken-leit", "OPEN", 42);
    try {
      await reworkTicket(project, bugId, {
        ticketId: bugId,
        mode: "reopen",
        summary: "The backoff cap is still missing",
        instructions: "Bound the retry backoff at 30s and cover it with a test.",
      });
      expect(beads.getRetiredPrRef(await beads.show(repo, bugId))).toBe("gh-42");

      // `gh` goes away before the rerun gets its slot. Unknown is proof of nothing: if gh-42 in fact
      // merged, executing re-dispatches shipped work — so the run must retry, not fall through.
      process.env.ANTON_GH_BIN = writeBin(binDir, "gh-broken-after-retire-leit", `process.exit(1);`);
      await resetPerCaseState(tdb);
      const job = await driveEpicRun(makeEpicRunner(ctx), { projectId, epicBeadId: bugId });

      // A COUNTING failure (rescheduled, run row failed), and no agent was dispatched for the
      // target — proof it bailed at step 0a rather than anywhere downstream.
      expect((await getJob(tdb.db, job))?.status).not.toBe("done");
      const runsForBug = (await tdb.db.select().from(schema.runs)).filter(
        (r) => r.epicBeadId === bugId,
      );
      expect(runsForBug.some((r) => r.status === "failed")).toBe(true);
      expect(runsForBug.some((r) => r.status === "done")).toBe(false);
      expect(await sessionBeads()).not.toContain(bugId);
      // The pointer is untouched, so a later attempt (or a readable `gh`) still decides correctly.
      expect(beads.getRetiredPrRef(await beads.show(repo, bugId))).toBe("gh-42");
    } finally {
      process.env.ANTON_GH_BIN = okGh;
    }
  });

  it("a FOLLOW-UP off an open-PR target runs as its own target, leaving that PR's target intact", async () => {
    const bugId = await targetInReview("Open PR, follow-up");

    const okGh = process.env.ANTON_GH_BIN!;
    // OPEN is what rework reads off gh-42; the follow-up's own branch carries no PR, so its run
    // opens one of its own rather than landing back on the target's.
    process.env.ANTON_GH_BIN = ghReporting(binDir, "gh-open-followup-leit", "OPEN", null);
    try {
      const result = await reworkTicket(project, bugId, {
        ticketId: bugId,
        mode: "follow-up",
        summary: "Cap the retry backoff",
        instructions: "Bound the retry backoff at 30s and cover it with a test.",
      });

      // A standalone target's follow-up is parentless — its own run target — so this target's next
      // run was never going to carry the fix. Retiring here would strip the merge gate off a PR
      // that is still open and hand the claimer work already sitting on its branch.
      expect(result.pipeline).toBeUndefined();
      const untouched = await beads.show(repo, bugId);
      expect(beads.getPrRef(untouched)).toBe("gh-42");
      expect(untouched.labels ?? []).toContain("stage:in-review");

      await beads.approve(repo, result.reworkedId);
      await resetPerCaseState(tdb);
      const job = await driveEpicRun(makeEpicRunner(ctx), {
        projectId,
        epicBeadId: result.reworkedId,
      });

      // The fix still has a run path — on the follow-up's own branch and its own pull request.
      await expectJobStatus(tdb.db, job, "done");
      expect(await sessionBeads()).toContain(result.reworkedId);
      expect(beads.getPrRef(await beads.show(repo, result.reworkedId))).toBe("gh-99");
    } finally {
      process.env.ANTON_GH_BIN = okGh;
    }
  });

  it("refuses rather than guesses when `gh` can't say what the target's PR did", async () => {
    const bugId = await targetInReview("Unreadable PR");

    const okGh = process.env.ANTON_GH_BIN!;
    process.env.ANTON_GH_BIN = writeBin(binDir, "gh-broken-leit", `process.exit(1);`);
    try {
      await expect(
        reworkTicket(project, bugId, {
          ticketId: bugId,
          mode: "reopen",
          summary: "Cannot tell",
          instructions: "Nothing should be written.",
        }),
      ).rejects.toThrow(/can't read the state/);
      // Nothing written: the merged and open paths are opposites, so a guess strands the send-back.
      const untouched = await beads.show(repo, bugId);
      expect(beads.getPrRef(untouched)).toBe("gh-42");
      expect(String(untouched.notes ?? "")).not.toContain("Nothing should be written.");
    } finally {
      process.env.ANTON_GH_BIN = okGh;
    }
  });
});
