/**
 * Real-db + real-bd route test for the rework action (anton-4ocm):
 *   POST /api/projects/[slug]/epics/[epicId]/rework  → send one ticket back
 *
 * The report this decision is made from is the sibling `review` route's, tested there.
 *
 * The assertions are deliberately made against the BOARD and against the shared predicates the
 * runtime itself uses — `runTickets`/`resumeSkipped` (what the next run dispatches) and
 * `ticketPrompt` (what the implementer is actually handed) — not against the route's return value.
 * A rework that answers 200 while the reopened bead is still skipped by the run, or whose note never
 * reaches the prompt, has done nothing. Skipped when `bd`/`git` are absent.
 */
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import {
  type BdRepo,
  type FileDb,
  describeBd,
  jsonRequest,
  makeBdRepo,
  makeFileDb,
  paramsCtx,
  withOperator,
} from "@/lib/testing/integration";

const post = (slug: string, id: string, body?: unknown) =>
  POST(jsonRequest("POST", body), paramsCtx({ slug, epicId: id }));

let fileDb: FileDb;
let bdRepo: BdRepo;
let repo: string;
let projectId: string;
let POST: typeof import("./route").POST;
let beads: typeof import("@/lib/beads/bd").beads;
let loadAllIssues: typeof import("@/lib/beads/issues").loadAllIssues;
let runTickets: typeof import("@/lib/ticket-view").runTickets;
let resumeSkipped: typeof import("@/lib/ticket-view").resumeSkipped;
let ticketPrompt: typeof import("@/lib/jobs/step-registry").ticketPrompt;
let getDb: typeof import("@/lib/db").getDb;
let schema: typeof import("@/lib/db/schema");
let resetOperatorCache: typeof import("@/lib/operator").resetOperatorCache;

/** A shaped ticket — the contract gate refuses anything less, so every fixture ships one. */
const CONTRACT = (goal: string) =>
  [
    `## Goal`,
    goal,
    ``,
    `## Acceptance Criteria`,
    `- [ ] ${goal}`,
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

describeBd("rework route (temp anton.db + real bd)", () => {
  let feature = "";
  let ticket = "";

  beforeAll(async () => {
    fileDb = makeFileDb();

    ({ POST } = await import("./route"));
    ({ beads } = await import("@/lib/beads/bd"));
    ({ loadAllIssues } = await import("@/lib/beads/issues"));
    ({ runTickets, resumeSkipped } = await import("@/lib/ticket-view"));
    ({ ticketPrompt } = await import("@/lib/jobs/step-registry"));
    ({ getDb } = await import("@/lib/db"));
    schema = await import("@/lib/db/schema");
    ({ resetOperatorCache } = await import("@/lib/operator"));

    bdRepo = makeBdRepo();
    repo = bdRepo.repo;

    projectId = randomUUID();
    await getDb().insert(schema.projects).values({
      id: projectId,
      slug: "reworky",
      name: "reworky",
      repoPath: repo,
    });
  });

  afterAll(() => {
    bdRepo?.cleanup();
    fileDb?.cleanup();
    delete process.env.ANTON_OPERATOR;
    resetOperatorCache?.();
  });

  beforeEach(async () => {
    await withOperator("founder");
    // A fresh feature + ticket per case, so a rework in one case can't leak into the next.
    feature = await beads.create(repo, {
      title: "Reworkable feature",
      type: "feature",
      description: CONTRACT("ship the feature"),
    });
    ticket = await beads.create(repo, {
      title: "The ticket that shipped",
      type: "task",
      description: CONTRACT("do the work"),
      labels: ["agent:nextjs", "size:S"],
      deps: [`parent-child:${feature}`],
    });
    await getDb().delete(schema.jobs);
  });

  it("reopen: the ticket re-enters the next run, carrying the note in the implementer's prompt", async () => {
    // The state a finished run leaves: the ticket closed, wearing the stage label that makes a
    // resume skip it.
    await beads.tag(repo, ticket, ["stage:in-review"]);
    await beads.close(repo, ticket);

    const res = await post("reworky", feature, {
      ticketId: ticket,
      mode: "reopen",
      summary: "the retry path is still untested",
      instructions: "Add a test that fails without the backoff cap.",
      findings: [{ severity: "blocking", location: "src/retry.ts:20", note: "no backoff cap" }],
    });
    expect(res.status).toBe(200);
    expect((await res.json()).result).toMatchObject({ mode: "reopen", reworkedId: ticket, applied: true });

    const bead = await beads.show(repo, ticket);
    expect(bead.status).toBe("open");
    expect(bead.labels ?? []).not.toContain("stage:in-review");

    // What the NEXT run will do with it: dispatch it (not skip it) and hand the agent the note.
    const all = await loadAllIssues(repo);
    expect(runTickets(all, feature).map((b) => b.id)).toContain(ticket);
    expect(resumeSkipped(bead, false)).toBe(false);
    const prompt = ticketPrompt(bead);
    expect(prompt).toContain("Add a test that fails without the backoff cap.");
    expect(prompt).toContain("no backoff cap");
    expect(prompt).toContain("Human notes on this ticket");
  });

  it("reopen is idempotent: a double submit writes nothing the second time", async () => {
    await beads.close(repo, ticket);
    const body = {
      ticketId: ticket,
      mode: "reopen",
      summary: "not actually done",
      instructions: "Finish the error path.",
    };

    const first = await post("reworky", feature, body);
    expect((await first.json()).result.applied).toBe(true);
    const second = await post("reworky", feature, body);
    expect(second.status).toBe(200);
    expect((await second.json()).result).toMatchObject({ applied: false, reworkedId: ticket });

    // One note, not two — the founder's instruction must not read as if they said it twice.
    const notes = String((await beads.show(repo, ticket)).notes ?? "");
    expect(notes.split("Finish the error path.").length - 1).toBe(1);
  });

  it("follow-up: creates a linked bead under the target, leaving the original as it shipped", async () => {
    await beads.close(repo, ticket);

    const res = await post("reworky", feature, {
      ticketId: ticket,
      mode: "follow-up",
      summary: "Cap the retry backoff",
      instructions: "Bound the backoff at 30s and cover it with a test.",
    });
    expect(res.status).toBe(200);
    const { result } = await res.json();
    expect(result).toMatchObject({ mode: "follow-up", ticketId: ticket, applied: true });

    // Provenance: the discovered-from edge, on the NEW bead, pointing at the original.
    const all = await loadAllIssues(repo);
    const followUp = all.find((b) => b.id === result.reworkedId)!;
    expect(followUp.status).toBe("open");
    expect(
      (followUp.dependencies ?? []).some(
        (d) => d.type === "discovered-from" && d.depends_on_id === ticket,
      ),
    ).toBe(true);
    // It re-enters as one of the target's tickets, shaped well enough to run and routed to the same agent.
    expect(runTickets(all, feature).map((b) => b.id)).toContain(followUp.id);
    expect(followUp.labels ?? []).toContain("agent:nextjs");
    expect(ticketPrompt(await beads.show(repo, followUp.id))).toContain(
      "Bound the backoff at 30s and cover it with a test.",
    );

    // The original keeps the outcome it earned — closed, un-reopened.
    expect((await beads.show(repo, ticket)).status).toBe("closed");
  });

  it("follow-up is idempotent: a double submit reuses the bead it already created", async () => {
    const body = {
      ticketId: ticket,
      mode: "follow-up",
      summary: "Cap the retry backoff",
      instructions: "Bound the backoff at 30s.",
    };
    const first = (await (await post("reworky", feature, body)).json()).result;
    const second = (await (await post("reworky", feature, body)).json()).result;

    expect(second).toMatchObject({ applied: false, reworkedId: first.reworkedId });
    // One follow-up hangs off this ticket, not two — counted by the provenance edge rather than the
    // title, since the board also carries the identically-titled follow-up an earlier case made.
    const all = await loadAllIssues(repo);
    const linked = all.filter((b) =>
      (b.dependencies ?? []).some((d) => d.type === "discovered-from" && d.depends_on_id === ticket),
    );
    expect(linked.map((b) => b.id)).toEqual([first.reworkedId]);
  });

  it("409s a rework raced against a live run on the same target, writing nothing", async () => {
    getDb()
      .insert(schema.jobs)
      .values({
        id: randomUUID(),
        type: "execute-epic",
        projectId,
        payloadJson: JSON.stringify({ projectId, epicBeadId: feature }),
        status: "running",
      })
      .run();

    const res = await post("reworky", feature, {
      ticketId: ticket,
      mode: "reopen",
      summary: "not done",
      instructions: "Fix it.",
    });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toContain(feature);
    expect(String((await beads.show(repo, ticket)).notes ?? "")).not.toContain("Fix it.");
  });

  it("422s a ticket that isn't part of this target's run", async () => {
    const stranger = await beads.create(repo, {
      title: "Someone else's work",
      type: "task",
      description: CONTRACT("unrelated"),
    });
    const res = await post("reworky", feature, {
      ticketId: stranger,
      mode: "reopen",
      summary: "no",
      instructions: "no",
    });
    expect(res.status).toBe(422);
  });

  it("400s a rework with no instructions — an empty steer is worse than none", async () => {
    const res = await post("reworky", feature, { ticketId: ticket, mode: "reopen", summary: "why" });
    expect(res.status).toBe(400);
  });
});
