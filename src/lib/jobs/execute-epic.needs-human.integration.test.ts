/**
 * End-to-end proof of anton-287p.2: an agent that reports `ANTON-RESULT: needs-human — <ask>` turns
 * that ask into board state — one open `human` gate on the run target carrying the ask — and parks
 * the run behind it.
 *
 * Two shapes, because the ask is legitimate in both and they take opposite routes through the
 * ticket's exits:
 *
 * 1. **With a diff.** The agent got somewhere and then hit the wall. Without this the run would
 *    settle `done` and open a PR for work its own agent said isn't finished.
 * 2. **With NO diff.** The commoner shape — nothing could be done at all. Without this the ask is
 *    swallowed by the zero-diff delivery gate and reaches the operator as a generic false stall.
 * 3. **With the NEXT step failing on what the ask is about.** The verify gate throws on the missing
 *    credential the agent just asked for. Without this the step failure masks the ask entirely and
 *    the run fails behind no gate.
 *
 * The run target is a FEATURE, not the fixture's legacy epic: bd refuses a gate edge onto an epic
 * ("epics can only block other epics"), so the gated shape only exists for the targets the tier
 * split actually produces.
 *
 * The rest of the file is anton-287p.4 — the same ask arriving twice. A human gate is the one
 * flavour nothing automates away, so both failure modes are permanent once they land: a duplicate
 * gate is a wait resolving cannot end, and a park with NO gate is a wait nothing can end at all.
 *
 * Drives the REAL handler + runner + bd/git with fake `claude`/`gh`. Skipped without bd + git.
 */
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { beads, gateReason, type Gate } from "../beads/bd";
import { loadAllIssues } from "../beads/issues";
import * as schema from "../db/schema";
import { armHumanGate, HUMAN_GATE_ARMED_LABEL } from "./execute-epic";
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

describeBd("execute-epic e2e — the human gate (real handler · real bd/git · fake claude/gh)", () => {
  let repo: string;
  let binDir: string;
  let tdb: ExecuteEpicSandbox["tdb"];
  let clock: FakeClock;
  let projectId: string;
  let successClaude: string;
  let ctx: ExecuteEpicSandbox;

  beforeAll(async () => {
    ctx = await createExecuteEpicSandbox();
    ({ repo, binDir, tdb, clock, projectId, successClaude } = ctx);
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

  /** Merge a settings patch into the sandbox project's settingsJson. */
  const patchSettings = async (patch: Record<string, unknown>) => {
    const proj = (
      await tdb.db.select().from(schema.projects).where(eq(schema.projects.id, projectId))
    )[0];
    const base = JSON.parse(proj.settingsJson ?? "{}") as Record<string, unknown>;
    await tdb.db
      .update(schema.projects)
      .set({ settingsJson: JSON.stringify({ ...base, ...patch }) })
      .where(eq(schema.projects.id, projectId));
  };

  /** An approved FEATURE run target with one child ticket — the shape bd accepts a gate edge on. */
  const approvedFeature = async (title: string) => {
    const id = await beads.create(repo, {
      title,
      type: "feature",
      acceptance: "work file exists",
      description: `## Goal\n${title}`,
    });
    await beads.approve(repo, id);
    return { id, ticket: createTicket(repo, { title: `${title} ticket`, parent: id }) };
  };

  /**
   * A claude that ends its final message with an ask for a human. `withDiff` decides whether it
   * leaves work behind first — the two routes the ask has to survive.
   */
  const askingClaude = (name: string, ask: string, withDiff: boolean) =>
    writeBin(
      binDir,
      name,
      fakeClaudeReadingStdin(`${
        withDiff
          ? `fs.appendFileSync(path.join(process.cwd(),'AGENT_WORK.md'),'partial '+Date.now()+'\\n');`
          : ``
      }
const e=o=>process.stdout.write(JSON.stringify(o)+'\\n');
const text='I got as far as I could.\\n\\nANTON-RESULT: needs-human — '+${JSON.stringify(ask)};
e({type:'system',subtype:'init',session_id:'ask'});
e({type:'assistant',message:{content:[{type:'text',text}]}});
e({type:'result',subtype:'success',result:text,session_id:'ask',num_turns:1,is_error:false});
process.exit(0);`),
    );

  /** The open gates blocking `targetId`, read off the board's own `blocks` edges. */
  const gatesBlocking = async (targetId: string): Promise<Gate[]> => {
    const board = await loadAllIssues(repo);
    const blocking = new Set(
      (board.find((b) => b.id === targetId)?.dependencies ?? [])
        .filter((d) => d.type === "blocks")
        .map((d) => d.depends_on_id),
    );
    return (await beads.gateList(repo)).filter((g) => blocking.has(g.id));
  };

  const runFor = async (targetId: string) =>
    (await tdb.db.select().from(schema.runs)).find((r) => r.epicBeadId === targetId)!;

  it("arms one open human gate carrying the ask and parks the run — with a diff", async () => {
    const ask = "the sandbox Stripe key (STRIPE_SECRET_KEY_MARKER) is not something I can create";
    const feature = await approvedFeature("Needs a key");
    const claude = askingClaude("claude-ask-diff", ask, true);

    const runner = makeEpicRunner(ctx);
    process.env.ANTON_CLAUDE_BIN = claude;
    let jobId: string | undefined;
    try {
      jobId = await driveEpicRun(runner, { projectId, epicBeadId: feature.id });

      // EXACTLY ONE gate, `human`, open, and its reason is the agent's ask verbatim.
      const gates = await gatesBlocking(feature.id);
      expect(gates).toHaveLength(1);
      expect(gates[0].await_type).toBe("human");
      expect(gates[0].status).not.toBe("closed");
      expect(gates[0].description ?? "").toContain(ask);

      // The run is PARKED (not done, not failed) with no endedAt — it is waiting on a person, and
      // the resume reuses this row. Its error names the ask and the command that releases it.
      const run = await runFor(feature.id);
      expect(run.status).toBe("parked");
      expect(run.endedAt ?? null).toBeNull();
      expect(run.error).toContain(ask);
      expect(run.error).toContain(`bd gate resolve ${gates[0].id}`);

      // The job parked too (poison, not a retry): another attempt cannot answer an ask.
      expect((await getJob(tdb.db, jobId))?.status).toBe("parked");

      // Nothing settled as delivered: no PR, and the target is not in review.
      expect(beads.getPrRef(await beads.show(repo, feature.id)) ?? null).toBeNull();
    } finally {
      process.env.ANTON_CLAUDE_BIN = successClaude;
      if (jobId) await park(tdb.db, clock, jobId, "test cleanup: not re-dispatched");
    }
  });

  it("re-entering a target that already waits on a human adds no second gate", async () => {
    // The re-entry this covers is the cheap one to get wrong: the same target executed twice. The
    // first run leaves the ask on the board; the second must not stack a second wait behind it,
    // because resolving either would leave the target blocked by the other.
    const ask = "someone has to pick which of the two schemas MARKER_SCHEMA_PICK we keep";
    const feature = await approvedFeature("Needs a decision");
    const claude = askingClaude("claude-ask-twice", ask, true);

    const runner = makeEpicRunner(ctx);
    process.env.ANTON_CLAUDE_BIN = claude;
    const jobIds: string[] = [];
    try {
      jobIds.push(await driveEpicRun(runner, { projectId, epicBeadId: feature.id }));
      const armed = await gatesBlocking(feature.id);
      expect(armed).toHaveLength(1);

      jobIds.push(await driveEpicRun(runner, { projectId, epicBeadId: feature.id }));

      // Still exactly one open wait, and it is the SAME gate — the ask a person is holding.
      const after = await gatesBlocking(feature.id);
      expect(after.map((g) => g.id)).toEqual([armed[0].id]);
      // …and re-entry never claimed a delivery on the way: no PR was opened by either run.
      expect(beads.getPrRef(await beads.show(repo, feature.id)) ?? null).toBeNull();
    } finally {
      process.env.ANTON_CLAUDE_BIN = successClaude;
      for (const id of jobIds) await park(tdb.db, clock, id, "test cleanup: not re-dispatched");
    }
  });

  it("reuses the wait for the same ask and supersedes one whose ask no longer applies", async () => {
    // Straight at the arm, because the states it has to survive are the ones a full run cannot
    // reach: a settle lost after the gate landed, and a resumed run that stops for a NEW reason.
    const ask = "the staging DB password MARKER_PW has to be rotated by a person";
    const feature = await approvedFeature("Needs a rotation");

    const { gateId: first } = await armHumanGate(repo, feature.id, ask);
    // same ask ⇒ same wait
    expect((await armHumanGate(repo, feature.id, ask)).gateId).toBe(first);
    expect((await gatesBlocking(feature.id)).map((g) => g.id)).toEqual([first]);

    // The label is what makes the supersede below anton's to make — a gate without it reads as a
    // person's own hold. Asserted against real bd because the write is a `bd update` on a GATE bead.
    expect((await gatesBlocking(feature.id))[0].labels ?? []).toContain(HUMAN_GATE_ARMED_LABEL);

    const newer = "actually MARKER_ZONE needs a DNS record first";
    const { gateId: second } = await armHumanGate(repo, feature.id, newer);
    expect(second).not.toBe(first);

    // One open wait, carrying the current ask. Nothing else would ever have closed the old one:
    // `bd gate check` does not evaluate a human gate and the expiry pass skips it — so left open it
    // would block this target on an ask nobody is answering.
    const open = await gatesBlocking(feature.id);
    expect(open.map((g) => g.id)).toEqual([second]);
    expect(gateReason(open[0])).toBe(newer);
    const all = await beads.gateList(repo, { all: true });
    expect(all.find((g) => g.id === first)?.status).toBe("closed");
  });

  it("arms beside a hold a person created rather than resolving someone else's gate", async () => {
    // A hand-made `bd gate create --blocks <target>` is a founder's "stop until I say so". It looks
    // exactly like a stale anton wait — a human gate with a different reason — so only the label
    // anton stamps on its own keeps this ask from auto-releasing someone's explicit hold.
    const feature = await approvedFeature("Held by hand");
    const hold = await beads.gateCreate(repo, {
      blocks: feature.id,
      type: "human",
      reason: "hold: MARKER_HOLD until the contract is signed",
    });

    const armed = await armHumanGate(repo, feature.id, "the sandbox key MARKER_KEY is not mine to make");

    const open = await gatesBlocking(feature.id);
    expect(open.map((g) => g.id).sort()).toEqual([armed.gateId, hold].sort());
    // The hold comes back with the arm so the park can name it — resolving the armed gate alone
    // leaves the target blocked, and nothing else would tell the operator what still holds it.
    expect(armed.held).toEqual([hold]);
  });

  it("refuses an epic target loudly instead of littering the board with a gate that blocks nothing", async () => {
    // bd rejects a gate edge onto an epic ("epics can only block other epics") and STILL leaves the
    // gate bead behind, blocking nothing. Refusing up front is what keeps a retry from filing one
    // orphan per attempt.
    const before = (await beads.gateList(repo, { all: true })).length;
    await expect(armHumanGate(repo, ctx.epicId, "an ask an epic cannot carry")).rejects.toThrow(
      /is an epic/,
    );
    expect((await beads.gateList(repo, { all: true })).length).toBe(before);
  });

  it("arms the gate rather than tripping the zero-diff delivery gate — with NO diff", async () => {
    const ask = "the DNS record MARKER_ZONE_APEX has to be added in the registrar console";
    const feature = await approvedFeature("Needs a DNS record");
    const claude = askingClaude("claude-ask-nodiff", ask, false);

    const runner = makeEpicRunner(ctx);
    process.env.ANTON_CLAUDE_BIN = claude;
    let jobId: string | undefined;
    try {
      // The sandbox's verify gate asserts the agent wrote a file; an ask with no diff never does.
      await patchSettings({ testCommand: "true" });
      jobId = await driveEpicRun(runner, { projectId, epicBeadId: feature.id });

      const gates = await gatesBlocking(feature.id);
      expect(gates).toHaveLength(1);
      expect(gates[0].await_type).toBe("human");
      expect(gates[0].description ?? "").toContain(ask);

      // The ask beat the zero-diff gate: the run says what a person owes it, not "produced no
      // delivery" — the generic stall the operator would otherwise have to decode.
      const run = await runFor(feature.id);
      expect(run.status).toBe("parked");
      expect(run.error).toContain(ask);
      expect(run.error).not.toMatch(/produced no delivery/i);
    } finally {
      process.env.ANTON_CLAUDE_BIN = successClaude;
      await patchSettings({ testCommand: "test -f AGENT_WORK.md" });
      if (jobId) await park(tdb.db, clock, jobId, "test cleanup: not re-dispatched");
    }
  });

  it("arms the gate even when the step after the ask fails on the very thing it asks for", async () => {
    // The ask is usually ABOUT what the next step needs — the credential nobody issued, the account
    // nobody created — so the run's own verify gate is the likeliest thing to throw right after it.
    // Allowed to run, it replaces the ask with a generic step failure and the run takes the ordinary
    // failure path: no gate, and a person reading "tests failed" instead of what they owe. Here the
    // sandbox's real verify command (`test -f AGENT_WORK.md`) fails, because an ask with no diff
    // never writes the file — no settings patch, unlike the case above.
    const ask = "the CI service account MARKER_CI_ACCOUNT has to be created by an admin";
    const feature = await approvedFeature("Needs an account");
    const claude = askingClaude("claude-ask-verify-fails", ask, false);

    const runner = makeEpicRunner(ctx);
    process.env.ANTON_CLAUDE_BIN = claude;
    let jobId: string | undefined;
    try {
      jobId = await driveEpicRun(runner, { projectId, epicBeadId: feature.id });

      const gates = await gatesBlocking(feature.id);
      expect(gates).toHaveLength(1);
      expect(gates[0].await_type).toBe("human");
      expect(gates[0].description ?? "").toContain(ask);

      // Parked on the gate with the ask — not failed on the verify the ask predicted.
      const run = await runFor(feature.id);
      expect(run.status).toBe("parked");
      expect(run.endedAt ?? null).toBeNull();
      expect(run.error).toContain(ask);
      expect(run.error).toContain(`bd gate resolve ${gates[0].id}`);
      expect(run.error).not.toMatch(/AGENT_WORK|step:verify/);
    } finally {
      process.env.ANTON_CLAUDE_BIN = successClaude;
      if (jobId) await park(tdb.db, clock, jobId, "test cleanup: not re-dispatched");
    }
  });

  it("fails the run loudly when the ask cannot become a gate — never parks behind nothing", async () => {
    // The forced failure is a real one, not a stub: the run target is the fixture's LEGACY EPIC, and
    // bd refuses a gate edge onto an epic. A park here would be a wait no `bd gate resolve` could
    // ever end — the run would sit in the waiting-on-a-person surface until someone read the logs.
    const ask = "only a person can decide whether MARKER_EPIC_SPLIT ships as one epic or two";
    const claude = askingClaude("claude-ask-epic", ask, true);

    const runner = makeEpicRunner(ctx);
    process.env.ANTON_CLAUDE_BIN = claude;
    let jobId: string | undefined;
    try {
      jobId = await driveEpicRun(runner, { projectId, epicBeadId: ctx.epicId });

      // No gate was created — including no orphan one blocking nothing.
      expect(await gatesBlocking(ctx.epicId)).toEqual([]);

      // FAILED, ended, and the error carries the ask plus why nothing on the board holds it.
      const run = await runFor(ctx.epicId);
      expect(run.status).toBe("failed");
      expect(run.endedAt ?? null).not.toBeNull();
      expect(run.error).toContain(ask);
      expect(run.error).toMatch(/human gate could NOT be created/);
      expect(run.error).not.toMatch(/closing that gate resumes this run/);
    } finally {
      process.env.ANTON_CLAUDE_BIN = successClaude;
      if (jobId) await park(tdb.db, clock, jobId, "test cleanup: not re-dispatched");
    }
  });
});
