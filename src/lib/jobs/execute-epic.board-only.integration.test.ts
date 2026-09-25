/**
 * End-to-end proof of anton-fc5x: a run target shaped `delivery:board` (LABELS.boardOnly) whose
 * entire deliverable is bd writes can be DELIVERED — the zero-diff guard reads the board instead of
 * the git tree for it — and a board-only ticket that genuinely delivers nothing still blocks, but
 * stays claimable (`open`, never `blocked`) so a resumed run can reclaim it without a human editing
 * bd status by hand.
 *
 * Replays the anton-f5f3 shape: an agent that makes real bd writes (here, a standalone bead) and NO
 * file changes in its worktree. Drives the REAL execute-epic handler + REAL job runner + REAL bd and
 * git against a temp repo with a bare `origin`, using fake `claude`/`gh` binaries. Skipped without
 * bd + git.
 */
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { beads, LABELS } from "../beads/bd";
import { parseTicketNotes } from "../beads/notes";
import { getJob, park } from "./queue";
import { resetOperatorCache } from "../operator";
import { describeBd } from "@/lib/testing/integration";
import {
  BASE_TIME_MS,
  resetPerCaseState,
  FakeClock,
  writeBin,
  fakeClaudeReadingStdin,
  createExecuteEpicSandbox,
  createTicket,
  makeEpicRunner,
  driveEpicRun,
  type ExecuteEpicSandbox,
} from "./execute-epic.fixture";
import { insertProject } from "@/lib/testing/project";

describeBd("execute-epic e2e — a board-only ticket settles on board evidence, not the git tree (anton-fc5x)", () => {
  let repo: string;
  let binDir: string;
  let tdb: ExecuteEpicSandbox["tdb"];
  let clock: FakeClock;
  let successClaude: string;
  let ctx: ExecuteEpicSandbox;

  beforeAll(async () => {
    ctx = await createExecuteEpicSandbox();
    ({ repo, binDir, tdb, clock, successClaude } = ctx);
  });

  afterAll(() => {
    ctx?.restoreEnv();
    resetOperatorCache();
    ctx?.cleanup();
  });

  beforeEach(async () => {
    clock.set(BASE_TIME_MS);
    await resetPerCaseState(tdb);
  });

  /** This suite's project: no `testCommand`, so there are no verify gates to satisfy — the
   * zero-diff/board-evidence path is what's exercised either way. */
  const noGateProject = () =>
    insertProject(tdb.db, {
      slug: `sandbox-boardonly-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      name: "sandbox-boardonly",
      repoPath: repo,
      // No testCommand → no verify gates. Review off, like the shared sandbox project: the pre-PR
      // self-review gate is a separate concern (execute-epic.review-gate.integration.test.ts) and
      // this suite's fake claude doesn't speak its report protocol.
      settingsJson: JSON.stringify({ reviewEnabled: false }),
    });

  it("delivers a board-only ticket that made real bd writes and left no git diff", async () => {
    const projectId = noGateProject();
    const epicId = await beads.create(repo, {
      title: "Vocabulary sweep",
      type: "epic",
      acceptance: "board updated",
      description: "## Goal\nSweep it.",
    });
    await beads.approve(repo, epicId);
    const ticketId = createTicket(repo, {
      title: "Sweep vocabulary across the board",
      parent: epicId,
      labels: [LABELS.boardOnly],
      acceptance: "the swept beads are updated",
    });

    // A standalone bead the fake claude writes to for real via `bd create` — this ticket's
    // deliverable, checkable after the fact by anyone reading the board, not by trusting the
    // agent's transcript. Created OUTSIDE the run's own epic so it can't be read as a new child.
    const decoyId = await beads.create(repo, {
      title: "Some other bead the sweep touches",
      type: "task",
      acceptance: "x",
      description: "## Goal\nold wording",
    });

    // The write deliberately does NOT set `cwd` on the child process — it inherits the REAL dispatch
    // cwd (the worktree, per dispatch.ts), and instead points `bd` at the live board the same way the
    // board-only system-prompt carve-out instructs a compliant agent to (`-C <repoPath>`, PR #284
    // review). Hardcoding `cwd: repo` here would mask exactly the gap that instruction exists to
    // close: on an embedded (non-server) Dolt board the worktree carries its own separate, unsynced
    // copy, so a write left at the worktree's own cwd would never reach the board this ticket's
    // evidence check reads.
    const boardOnlyClaude = writeBin(
      binDir,
      "claude-boardonly",
      fakeClaudeReadingStdin(`const cp=require('child_process');
cp.execFileSync('bd',['-C',${JSON.stringify(repo)},'update',${JSON.stringify(decoyId)},'--description','## Goal\\nswept wording']);
const text='Swept the vocabulary on the board.\\n\\nANTON-RESULT: delivered';
const e=o=>process.stdout.write(JSON.stringify(o)+'\\n');
e({type:'system',subtype:'init',session_id:'bo'});
e({type:'assistant',message:{content:[{type:'text',text}]}});
e({type:'result',subtype:'success',result:text,session_id:'bo',num_turns:1,is_error:false});
process.exit(0);`),
    );

    const runner = makeEpicRunner(ctx);
    process.env.ANTON_CLAUDE_BIN = boardOnlyClaude;
    let jobId: string;
    try {
      jobId = await driveEpicRun(runner, { projectId, epicBeadId: epicId });

      // No NoDeliveryError, no park: the run reaches a terminal state a human can read without
      // editing bd status by hand.
      const job = await getJob(tdb.db, jobId);
      expect(job?.status).toBe("done");

      // The ticket is CLOSED, not blocked and not left open-and-unclaimed — a false success would
      // instead have left it `blocked` (the zero-diff guard) with no ticket work credited.
      const ticket = await beads.show(repo, ticketId);
      expect(ticket.status).toBe("closed");
      expect(beads.isNotDelivered(ticket)).toBe(false);

      // The board write this ticket made is really on the board — the checkable evidence, not the
      // agent's word alone.
      const decoy = await beads.show(repo, decoyId);
      expect(decoy.description).toContain("swept wording");

      // The epic advanced to in-review with a PR — the ordinary successful-run shape.
      const epic = await beads.show(repo, epicId);
      expect(beads.getPrRef(epic)).toBeTruthy();
      expect(epic.labels ?? []).toContain("stage:in-review");
    } finally {
      process.env.ANTON_CLAUDE_BIN = successClaude;
      if (jobId!) await park(tdb.db, clock, jobId, "test cleanup: not re-dispatched");
    }
  });

  it("blocks a board-only ticket that made no bd writes, but leaves it OPEN so a resume can reclaim it", async () => {
    const projectId = noGateProject();
    const epicId = await beads.create(repo, {
      title: "Sweep that finds nothing to do",
      type: "epic",
      acceptance: "board updated",
      description: "## Goal\nSweep it.",
    });
    await beads.approve(repo, epicId);
    const ticketId = createTicket(repo, {
      title: "Sweep vocabulary that isn't there",
      parent: epicId,
      labels: [LABELS.boardOnly],
      acceptance: "the swept beads are updated",
    });

    // Reports delivered, like a false-success agent would, but touches bd and the tree not at all.
    const noopBoardClaude = writeBin(
      binDir,
      "claude-boardonly-noop",
      fakeClaudeReadingStdin(`const text='Nothing needed sweeping.\\n\\nANTON-RESULT: delivered';
const e=o=>process.stdout.write(JSON.stringify(o)+'\\n');
e({type:'system',subtype:'init',session_id:'bon'});
e({type:'assistant',message:{content:[{type:'text',text}]}});
e({type:'result',subtype:'success',result:text,session_id:'bon',num_turns:1,is_error:false});
process.exit(0);`),
    );

    const runner = makeEpicRunner(ctx);
    process.env.ANTON_CLAUDE_BIN = noopBoardClaude;
    let jobId: string;
    try {
      jobId = await driveEpicRun(runner, { projectId, epicBeadId: epicId });

      // The run still parks — a board-only ticket that delivered nothing is exactly as much a false
      // success as a git zero diff, and this guard still fires for it.
      const job = await getJob(tdb.db, jobId);
      expect(job?.status).toBe("parked");
      expect(job?.lastError).toMatch(/no delivery/i);

      // But the bead is left OPEN and unassigned (never `blocked`) — the guard's own finding does
      // not wedge the ticket out of the claimable set the way the anton-f5f3 incident did. A plain
      // code ticket's zero diff (execute-epic.gating.integration.test.ts, issue #46) is unaffected
      // by this and still ends up `blocked` — this is a board-only-only carve-out.
      const ticket = await beads.show(repo, ticketId);
      expect(ticket.status).toBe("open");
      expect(ticket.assignee ?? null).toBeNull();
      expect(beads.isNotDelivered(ticket)).toBe(true);
      expect(ticket.labels ?? []).not.toContain("stage:implementing");

      // The note says why, on the same channel a human reads any other block from.
      const noteText = parseTicketNotes(ticket.notes).filter((n) => n.source === "system").at(-1)!
        .text;
      expect(noteText).toMatch(/no bd write landed on the board|board-only ticket/i);
      expect(noteText).not.toContain("undefined");
    } finally {
      process.env.ANTON_CLAUDE_BIN = successClaude;
      if (jobId!) await park(tdb.db, clock, jobId, "test cleanup: not re-dispatched");
    }
  });
});
