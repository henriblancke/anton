/**
 * The `ref-stale` repair, end to end (anton-fzas / R5.4, R5.10) — REAL execute-epic handler, REAL
 * job runner, REAL bd and git, a fake claude that delivers nothing.
 *
 * Three claims, and only the first is about the repair itself:
 *   • a block whose bead cites a MOVED path is repaired: the `## Context` is rewritten to where the
 *     file actually is, and the repair is stamped on the bead;
 *   • the run then goes back through the NORMAL QUEUE (R5.10) — the job reschedules on the runner's
 *     own backoff and burns one of its own attempts, instead of the poison park a block earns
 *     today — and the ticket is left claimable so that retry can actually start;
 *   • the SECOND identical block escalates (R5.6): anton's diagnosis has been disproved, so the run
 *     parks for a human rather than spending another night re-repairing one bead.
 *
 * Deliberately its own sandbox rather than the shared `execute-epic.fixture` one: the whole case
 * turns on a rename sitting in the repo's git history, and committing one into the shared fixture
 * would change the base every sibling suite runs against.
 */
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beads } from "../beads/bd";
import { parseTicketNotes } from "../beads/notes";
import * as schema from "../db/schema";
import { repairFingerprint } from "../gardener/repair";
import { getJob } from "./queue";
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
  enqueueEpicJob,
  tickToIdle,
  type ExecuteEpicSandbox,
} from "./execute-epic.fixture";
import { insertProject } from "@/lib/testing/project";

/** Where the bead points, and where the file actually is after the rename. */
const STALE = "src/moved/target.ts";
const RESOLVED = "src/lib/target.ts";
/** A pointer with nowhere to have gone — deleted, never renamed. */
const DELETED = "src/dropped/gone.ts";

describeBd("execute-epic e2e — the ref-stale repair (real handler · real bd/git · fake claude)", () => {
  let repo: string;
  let binDir: string;
  let tdb: ExecuteEpicSandbox["tdb"];
  let clock: FakeClock;
  let ctx: ExecuteEpicSandbox;
  let projectId: string;
  let shadowProjectId: string;
  /** A claude that exits cleanly and changes nothing — the zero-diff block the repair answers. */
  let noopClaude: string;

  beforeAll(async () => {
    ctx = await createExecuteEpicSandbox();
    ({ repo, binDir, tdb, clock } = ctx);

    // The rename the bead's pointer is stale against, committed on main and pushed so the run's
    // branch is cut from a base that carries it.
    const g = (args: string[]) => execFileSync("git", args, { cwd: repo, stdio: "ignore" });
    mkdirSync(join(repo, "src/moved"), { recursive: true });
    writeFileSync(
      join(repo, STALE),
      "export const target = 'a module long enough for git to pair on similarity';\n",
    );
    g(["add", "-A"]);
    g(["commit", "-qm", "add the module"]);
    mkdirSync(join(repo, "src/lib"), { recursive: true });
    g(["mv", STALE, RESOLVED]);
    g(["commit", "-qm", "move the module"]);

    // And a path that was DELETED rather than moved — the pointer anton must refuse to guess at.
    mkdirSync(join(repo, "src/dropped"), { recursive: true });
    writeFileSync(
      join(repo, DELETED),
      "export const gone = 'a module that was dropped, not moved anywhere';\n",
    );
    g(["add", "-A"]);
    g(["commit", "-qm", "add the doomed module"]);
    g(["rm", "-q", DELETED]);
    g(["commit", "-qm", "drop the module"]);
    g(["push", "-q", "origin", "main"]);

    // No verify gates, so what the run stops on is the zero-diff delivery gate and nothing else.
    // ARMED at `apply`: a repair is an unattended write, and the shipped policy is `shadow`, so a
    // project that wants the rewrite has to say so (R5.3).
    projectId = insertProject(tdb.db, {
      slug: "sandbox-refstale",
      name: "sandbox-refstale",
      repoPath: repo,
      settingsJson: JSON.stringify({
        reviewEnabled: false,
        repairAutonomy: { "ref-stale": "apply" },
      }),
    });

    // The same repo through a project that armed NOTHING — what every project gets on upgrade.
    shadowProjectId = insertProject(tdb.db, {
      slug: "sandbox-refstale-shadow",
      name: "sandbox-refstale-shadow",
      repoPath: repo,
      settingsJson: JSON.stringify({ reviewEnabled: false }),
    });

    noopClaude = writeBin(
      binDir,
      "claude-noop-refstale",
      fakeClaudeReadingStdin(`const e=o=>process.stdout.write(JSON.stringify(o)+'\\n');
e({type:'system',subtype:'init',session_id:'srs'});
e({type:'assistant',message:{content:[{type:'text',text:'the file the ticket names is not here'}]}});
e({type:'result',subtype:'success',result:'done',session_id:'srs',num_turns:1,is_error:false});
process.exit(0);`),
    );
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

  /** An approved epic of one ticket whose `## Context` points at `cited`. */
  async function seedStaleEpic(
    title: string,
    cited: string = STALE,
  ): Promise<{ epic: string; ticket: string; description: string }> {
    const epic = await beads.create(repo, {
      title,
      type: "epic",
      acceptance: "the module is wired up",
      description: "## Goal\nWire it up.",
    });
    await beads.approve(repo, epic);
    const ticket = createTicket(repo, { title: `${title} — ticket`, parent: epic });
    const description = [
      "## Goal",
      "Wire the module up.",
      "",
      "## Context",
      `touches \`${cited}\` and nothing else.`,
      "",
      "## Verify",
      "unit tests",
    ].join("\n");
    await beads.update(repo, ticket, { description });
    return { epic, ticket, description };
  }

  it("rewrites the moved pointer, stamps the repair, and re-queues the ticket for one retry (R5.10)", async () => {
    const { epic, ticket } = await seedStaleEpic("Ref-stale epic");
    const runner = makeEpicRunner(ctx);
    const prev = process.env.ANTON_CLAUDE_BIN;
    process.env.ANTON_CLAUDE_BIN = noopClaude;
    try {
      const jobId = await enqueueEpicJob(runner, { projectId, epicBeadId: epic });
      expect(await tickToIdle(runner)).toBe(1);

      // NOT parked. A block parks for a human today; a repaired block goes back through the
      // runner's own retry budget and backoff — the normal queue, with no special standing.
      const job = await getJob(tdb.db, jobId);
      expect(job?.status).toBe("queued");
      expect(job?.attempts).toBe(1);
      expect(job?.lastError).toMatch(/anton repaired it/i);
      expect(job?.lastError ?? "").not.toMatch(/^poison:/);

      // The pointer now names where the file actually is, and nothing else about the bead moved.
      const repaired = await beads.show(repo, ticket);
      expect(repaired.description).toContain(`\`${RESOLVED}\``);
      expect(repaired.description).not.toContain(STALE);
      expect(repaired.description).toContain("## Verify");

      // One repair, fingerprinted on the bead itself — the record the guard reads back (R5.6).
      const stamp = (repaired.labels ?? []).find((l) => l.startsWith("repair:ref-stale:"));
      expect(stamp).toBeDefined();
      expect(stamp).toContain(repairFingerprint(ticket, "ref-stale"));
      const noteText = parseTicketNotes(repaired.notes)
        .filter((n) => n.source === "system")
        .map((n) => n.text)
        .join("\n");
      expect(noteText).toContain(RESOLVED);

      // Claimable, or the retry the park promises dies on `bd update --claim`.
      expect(repaired.status).toBe("open");
      expect(repaired.assignee ?? null).toBeNull();
      expect(repaired.labels ?? []).not.toContain("stage:implementing");

      // The retry runs against the corrected bead — and with an agent that can now find the file,
      // the run delivers exactly as any other retried job would.
      process.env.ANTON_CLAUDE_BIN = ctx.successClaude;
      clock.set(BASE_TIME_MS + 60_000);
      expect(await tickToIdle(runner)).toBe(1);
      expect((await getJob(tdb.db, jobId))?.status).toBe("done");
      expect((await beads.show(repo, ticket)).status).toBe("closed");
    } finally {
      process.env.ANTON_CLAUDE_BIN = prev;
    }
  });

  it("repairs a bead ONCE — the block after the retry parks for a human (R5.6)", async () => {
    const { epic, ticket } = await seedStaleEpic("Ref-stale twice epic");
    const runner = makeEpicRunner(ctx);
    const prev = process.env.ANTON_CLAUDE_BIN;
    process.env.ANTON_CLAUDE_BIN = noopClaude;
    try {
      const jobId = await enqueueEpicJob(runner, { projectId, epicBeadId: epic });
      expect(await tickToIdle(runner)).toBe(1);
      expect((await getJob(tdb.db, jobId))?.status).toBe("queued");

      // Same agent, same empty result. The pointer is already correct, so there is no second
      // diagnosis to make and nothing to repair: the run parks on the block's own poison, exactly
      // as it would have the first time. One repair per bead per class, and this is the "one".
      clock.set(BASE_TIME_MS + 60_000);
      expect(await tickToIdle(runner)).toBe(1);

      const job = await getJob(tdb.db, jobId);
      expect(job?.status).toBe("parked");
      expect(job?.lastError).toMatch(/no delivery/i);

      const blocked = await beads.show(repo, ticket);
      expect(blocked.status).toBe("blocked");
      expect((blocked.labels ?? []).filter((l) => l.startsWith("repair:ref-stale:"))).toHaveLength(1);
      expect(blocked.description).toContain(RESOLVED);
      const notes = parseTicketNotes(blocked.notes)
        .filter((n) => n.source === "system")
        .map((n) => n.text)
        .join("\n");
      expect(notes).toContain("run made no changes");
      const runRow = (await tdb.db.select().from(schema.runs)).find((r) => r.epicBeadId === epic)!;
      expect(runRow.error).toMatch(/no delivery/i);
    } finally {
      process.env.ANTON_CLAUDE_BIN = prev;
    }
  });

  it("refuses to guess at a DELETED pointer: it escalates, on the record (R5.4)", async () => {
    const { epic, ticket, description } = await seedStaleEpic("Deleted pointer epic", DELETED);
    const runner = makeEpicRunner(ctx);
    const prev = process.env.ANTON_CLAUDE_BIN;
    process.env.ANTON_CLAUDE_BIN = noopClaude;
    try {
      const jobId = await enqueueEpicJob(runner, { projectId, epicBeadId: epic });
      expect(await tickToIdle(runner)).toBe(1);

      // Today's behaviour, untouched: poison park, blocked bead, no rewrite, no stamp. The one
      // thing that is new is the account of WHY anton did not repair it.
      expect((await getJob(tdb.db, jobId))?.status).toBe("parked");
      const blocked = await beads.show(repo, ticket);
      expect(blocked.status).toBe("blocked");
      expect(blocked.description).toBe(description);
      expect((blocked.labels ?? []).some((l) => l.startsWith("repair:"))).toBe(false);
      const notes = parseTicketNotes(blocked.notes)
        .filter((n) => n.source === "system")
        .map((n) => n.text);
      const refusal = notes.find((t) => t.includes("did not repair this as `ref-stale`"))!;
      expect(refusal).toBeDefined();
      expect(refusal).toContain("deleted");
      expect(refusal.split("\n")).toHaveLength(1);
    } finally {
      process.env.ANTON_CLAUDE_BIN = prev;
    }
  });

  it("writes NOTHING on a project that armed nothing — the shipped `shadow` default (R5.3)", async () => {
    const { epic, ticket, description } = await seedStaleEpic("Unarmed ref-stale epic");
    const runner = makeEpicRunner(ctx);
    const prev = process.env.ANTON_CLAUDE_BIN;
    process.env.ANTON_CLAUDE_BIN = noopClaude;
    try {
      const jobId = await enqueueEpicJob(runner, {
        projectId: shadowProjectId,
        epicBeadId: epic,
      });
      expect(await tickToIdle(runner)).toBe(1);

      // The block settles exactly as it did before auto-repair existed: poison park, blocked bead.
      expect((await getJob(tdb.db, jobId))?.status).toBe("parked");
      const blocked = await beads.show(repo, ticket);
      expect(blocked.status).toBe("blocked");

      // Not one byte of the bead moved, and no stamp — a shadow leaves the guard free, so arming
      // the class later still gets its one repair.
      expect(blocked.description).toBe(description);
      expect((blocked.labels ?? []).some((l) => l.startsWith("repair:"))).toBe(false);

      // But the record IS there: what `apply` would have written, in the repair's own words.
      const notes = parseTicketNotes(blocked.notes)
        .filter((n) => n.source === "system")
        .map((n) => n.text);
      const shadow = notes.find((t) => t.includes("did not repair this as `ref-stale`"))!;
      expect(shadow).toBeDefined();
      expect(shadow).toContain("`shadow`");
      expect(shadow).toContain(RESOLVED);
      expect(shadow.split("\n")).toHaveLength(1);
    } finally {
      process.env.ANTON_CLAUDE_BIN = prev;
    }
  });
});
