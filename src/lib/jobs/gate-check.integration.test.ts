/**
 * End-to-end proof of anton-286r's acceptance, against REAL bd and the REAL handler: a satisfied
 * gate closes and its run is re-enqueued exactly once across two OVERLAPPING passes, a human gate is
 * untouched, a gate that blew its timeout is surfaced for a human instead of being retried forever,
 * and a gate on a PARENTLESS target — the one `bd ready --gated` never reports — resumes anyway.
 * Skipped without bd.
 *
 * Two deliberate choices in the fixture:
 *
 *   • The clock is the REAL one. Gate deadlines are bd's own (`created_at + timeout`, evaluated by
 *     bd), so a fake clock would put anton hours away from the gates it is judging — the timer gate
 *     would resolve while the expired one read as fresh. The suite pays ~1.5s of real waiting for
 *     the 1s timeouts instead.
 *   • The expired gate is a `bead` gate — a type this bd cannot resolve (decision doc §2), so it is
 *     never scoped into a `bd gate check` pass. That keeps the expiry proof free of `gh`, which an
 *     unauthenticated CI box does not have, while exercising the exact same surfacing path a
 *     timed-out `gh:pr` gate takes.
 */
import { afterAll, beforeAll, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { describeBd, makeBdRepo, type BdRepo } from "@/lib/testing/integration";
import { makeJobRunner } from "@/lib/testing/jobs";
import { makeTestDb, type TestDb } from "../db/testing";
import { beads } from "../beads/bd";
import { resetIssueSnapshots } from "../beads/snapshot";
import * as schema from "../db/schema";
import { systemClock } from "./queue";
import { GATE_EXPIRED_LABEL, GATE_RESUMED_LABEL, makeGateCheckHandler } from "./gate-check";

/** A child ticket under `parent`, contract-shaped enough for bd to accept it. */
function createTicket(repo: string, title: string, parent: string): string {
  const raw = execFileSync(
    "bd",
    ["create", title, "--type", "task", "--acceptance", "x", "--parent", parent, "--json"],
    { cwd: repo, encoding: "utf8" },
  );
  const p = JSON.parse(raw);
  return (Array.isArray(p) ? p[0] : (p.issue ?? p)).id as string;
}

/** An approved PARENTLESS task — an epic-of-one, and the shape `bd ready --gated` cannot report. */
async function createStandalone(repo: string, name: string): Promise<string> {
  const id = await beads.create(repo, {
    title: name,
    type: "task",
    acceptance: "- [ ] x",
  });
  await beads.approve(repo, id);
  return id;
}

/** An approved epic with one ticket under it — the shape anton runs. */
async function createRun(repo: string, name: string): Promise<{ epic: string; ticket: string }> {
  const epic = await beads.create(repo, {
    title: name,
    type: "epic",
    description: "## Goal\nx\n\n## Acceptance\n- [ ] x",
  });
  await beads.approve(repo, epic);
  return { epic, ticket: createTicket(repo, `${name} ticket`, epic) };
}

describeBd("gate-check e2e (real handler · real bd)", () => {
  let bdRepo: BdRepo;
  let repo: string;
  let tdb: TestDb;
  let projectId: string;

  let timed: { epic: string; ticket: string };
  let human: { epic: string; ticket: string };
  let expired: { epic: string; ticket: string };
  let plain: string;
  let timerGate: string;
  let humanGate: string;
  let expiredGate: string;
  let plainGate: string;

  /** Run `count` gate-check passes CONCURRENTLY — the overlap the idempotence claim is about. */
  async function runPasses(count: number): Promise<void> {
    const runner = makeJobRunner({
      db: tdb.db,
      clock: systemClock,
      type: "gate-check",
      handler: makeGateCheckHandler,
      config: { maxConcurrent: count },
    });
    for (let i = 0; i < count; i += 1) {
      await runner.enqueue({ type: "gate-check", projectId, payload: { projectId } });
    }
    expect(await runner.tickOnce()).toBe(count);
    await runner.whenIdle();
  }

  const executeEpicJobs = async () =>
    (await tdb.db.select().from(schema.jobs).where(eq(schema.jobs.type, "execute-epic"))).map(
      (j) => JSON.parse(j.payloadJson).epicBeadId as string,
    );

  const gateStatus = async (id: string) =>
    (await beads.gateList(repo, { all: true })).find((g) => g.id === id);

  const notesOf = async (id: string) => ((await beads.show(repo, id)).notes as string) ?? "";

  beforeAll(async () => {
    bdRepo = makeBdRepo({ initialCommit: true });
    repo = bdRepo.repo;

    timed = await createRun(repo, "Timer-gated epic");
    human = await createRun(repo, "Human-gated epic");
    expired = await createRun(repo, "Expired-gate epic");
    plain = await createStandalone(repo, "Timer-gated standalone task");

    timerGate = await beads.gateCreate(repo, {
      blocks: timed.ticket,
      type: "timer",
      timeout: "1s",
    });
    plainGate = await beads.gateCreate(repo, { blocks: plain, type: "timer", timeout: "1s" });
    humanGate = await beads.gateCreate(repo, {
      blocks: human.ticket,
      type: "human",
      reason: "the founder decides",
    });
    // `bead` is outside GateType (anton never creates one) — hand-rolled so the fixture can hold a
    // gate whose only possible end is its deadline.
    expiredGate = JSON.parse(
      execFileSync(
        "bd",
        ["gate", "create", "--blocks", expired.ticket, "--type", "bead", "--timeout", "1s", "--json"],
        { cwd: repo, encoding: "utf8" },
      ),
    ).id as string;

    tdb = makeTestDb();
    projectId = randomUUID();
    await tdb.db.insert(schema.projects).values({
      id: projectId,
      slug: "sandbox",
      name: "sandbox",
      repoPath: repo,
      defaultBranch: "main",
    });

    // The tickets were created through raw bd, which can't invalidate anton's board snapshot.
    resetIssueSnapshots();
    // Both 1s timeouts must actually be in the past before the first pass — bd judges them itself.
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    await runPasses(2);
  }, 60_000);

  afterAll(() => {
    tdb?.close();
    bdRepo.cleanup();
  });

  it("closes the satisfied timer gate", async () => {
    expect((await gateStatus(timerGate))?.status).toBe("closed");
  });

  it("re-enqueues the ungated run exactly once across two overlapping passes", async () => {
    expect((await executeEpicJobs()).sort()).toEqual([plain, timed.epic].sort());
  });

  it("resumes a PLAIN target too — the case `bd ready --gated` cannot report", async () => {
    // Measured on bd 1.1.2: `bd ready --gated` reports a gated bead only when it has a PARENT (it
    // names that parent as `molecule_id`). A gate hung on a parentless run target — an approved
    // standalone task/bug, or a top-level feature — never appears there, before or after it closes:
    // the bead just returns to ordinary `bd ready`, which nothing in anton polls. So the resume is
    // derived from the board, and marked on the gate so it happens exactly once.
    expect((await beads.readyGated(repo)).some((g) => g.ready_step?.id === plain)).toBe(false);
    expect(await executeEpicJobs()).toContain(plain);
    expect((await gateStatus(plainGate))?.labels ?? []).toContain(GATE_RESUMED_LABEL);
  });

  it("never touches the human gate, and never runs the work it blocks", async () => {
    expect((await gateStatus(humanGate))?.status).toBe("open");
    expect(await executeEpicJobs()).not.toContain(human.epic);
  });

  it("surfaces a gate that blew its timeout on the bead it blocks, and never runs it", async () => {
    const gate = await gateStatus(expiredGate);
    expect(gate?.status).toBe("open"); // surfaced, NOT auto-resolved — only a human ends this wait
    expect(gate?.labels ?? []).toContain(GATE_EXPIRED_LABEL);

    const notes = await notesOf(expired.ticket);
    expect(notes).toContain(expiredGate);
    expect(notes).toContain("needs a human");
    expect(await executeEpicJobs()).not.toContain(expired.epic);
  });

  it("raises a blown gate once, not once per pass", async () => {
    const before = await notesOf(expired.ticket);
    await runPasses(1);
    expect(await notesOf(expired.ticket)).toBe(before);
    // …and the re-dispatch stays idempotent on a later pass too: still one run each for the ungated
    // epic and the ungated plain target, whose closed gate stays on its bead forever.
    expect((await executeEpicJobs()).sort()).toEqual([plain, timed.epic].sort());
  });
});
