/**
 * End-to-end proof of apply-on-approve (anton-1t3n): the REAL approve route, against REAL bd, on a
 * scratch board — one case per move the gardener can propose. The proposals are built by the REAL
 * emitter (`proposalDraft`), so what these cases apply is exactly what a patrol files, metadata and
 * all; nothing here hand-writes a plan the emitter would not produce.
 *
 * What only a live board can prove, and what the unit suite therefore cannot:
 *   1. bd's verbs actually do what the plan claims — `--parent` moves the bead, `link` draws the
 *      edge in the stated direction, `supersede`/`close`/`defer` each settle it their own way;
 *   2. the proposal itself settles: closed, with a note naming what changed;
 *   3. a REFUSED apply is inert — the board is byte-for-byte what it was, the proposal is still
 *      open, and the reason is on the bead (fail loud, no partial silent state);
 *   4. DECLINING (abandon) suppresses recurrence: the next patrol, run over the real board through
 *      the real emitter, files nothing for that fingerprint.
 *
 * Skipped when `bd`/`git` are absent. Sibling of the other `approve-*.route.integration.test.ts`
 * suites; shares their fixture harness (temp anton.db + real bd repo).
 */
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { setupApproveSuite, type ApproveSuiteCtx } from "../approve.fixture";
import { describeBd } from "@/lib/testing/integration";
import { resetIssueSnapshots } from "@/lib/beads/snapshot";
import { makeDetection, type DetectionInput } from "@/lib/gardener/detections";
import { proposalDraft } from "@/lib/gardener/emit";
import type { Bead } from "@/lib/beads/bd";

let fileDb: ApproveSuiteCtx["fileDb"];
let bdRepo: ApproveSuiteCtx["bdRepo"];
let repo: string;
let approve: ApproveSuiteCtx["approve"];
let beads: ApproveSuiteCtx["beads"];

describeBd("POST approve — gardener proposals apply their move (temp anton.db + real bd)", () => {
  /** File a proposal the way the patrol would: the emitter's own draft, created through the seam. */
  const file = async (input: DetectionInput): Promise<{ id: string; fingerprint: string }> => {
    const detection = makeDetection(input);
    const id = await beads.create(repo, proposalDraft(detection));
    return { id, fingerprint: detection.fingerprint };
  };

  const show = (id: string): Promise<Bead> => beads.show(repo, id);
  const notesOf = async (id: string): Promise<string> => String((await show(id)).notes ?? "");

  const applied = async (proposalId: string) => {
    const res = await approve(proposalId);
    const body = (await res.json()) as { applied?: { summary?: string }; error?: string };
    expect({ status: res.status, error: body.error }).toEqual({ status: 200, error: undefined });
    return body.applied!;
  };

  beforeAll(async () => {
    const s = await setupApproveSuite();
    ({ fileDb, bdRepo, repo, approve, beads } = s);
  }, 180_000);

  afterAll(() => {
    resetIssueSnapshots();
    bdRepo?.cleanup();
    fileDb?.cleanup();
  });

  // The cases share one repo, so a warm snapshot would serve a pre-write board to the next case.
  beforeEach(() => {
    resetIssueSnapshots();
  });

  it("re-parents a cluster under its card, and settles the proposal with what changed", async () => {
    const card = await beads.create(repo, { title: "The home", type: "feature", acceptance: "- [ ] a" });
    const one = await beads.create(repo, { title: "Loose one", type: "task", acceptance: "- [ ] a" });
    const two = await beads.create(repo, { title: "Loose two", type: "task", acceptance: "- [ ] a" });
    const proposal = await file({
      kind: "parentless-cluster",
      move: "reparent",
      subjects: [one, two],
      target: card,
      summary: "two loose beads belong under the card",
      evidence: ["they share the card's topic"],
    });

    const result = await applied(proposal.id);

    expect(result.summary).toContain(card);
    expect(beads.parentOf(await show(one))).toBe(card);
    expect(beads.parentOf(await show(two))).toBe(card);
    // The ask is answered: closed PLAINLY (not abandoned — only a decline suppresses) and the note
    // says what changed, so the bead explains itself without the board.
    const settled = await show(proposal.id);
    expect(settled.status).toBe("closed");
    expect(beads.isAbandoned(settled)).toBe(false);
    // Subjects are sorted by `makeDetection`, so the note reads in the fingerprint's own order.
    const sorted = [one, two].sort().join(", ");
    expect(String(settled.notes ?? "")).toContain(`re-parented ${sorted} under ${card}`);
  });

  it("draws the blocks edge in the direction the proposal states", async () => {
    const blocker = await beads.create(repo, { title: "Goes first", type: "task", acceptance: "- [ ] a" });
    const blocked = await beads.create(repo, { title: "Goes second", type: "task", acceptance: "- [ ] a" });
    const proposal = await file({
      kind: "implied-order",
      move: "link",
      subjects: [blocked],
      target: blocker,
      summary: "the body states the ordering, nothing records it",
      evidence: [`${blocked}'s body names ${blocker}`],
    });

    await applied(proposal.id);

    // `blocked` depends on `blocker`, so bd itself keeps it out of the ready queue. The edge is read
    // off the LIST (the shape `edgesOf` parses); `bd show` carries dependencies in another form.
    expect(beads.edgesOf(await beads.list(repo, ["--status", "all"]))).toContainEqual({
      from: blocked,
      to: blocker,
      type: "blocks",
    });
    expect((await beads.ready(repo)).map((b) => b.id)).not.toContain(blocked);
    expect((await show(proposal.id)).status).toBe("closed");
  });

  it("retires with the verb the proposal named: close, defer and supersede each settle differently", async () => {
    const shipped = await beads.create(repo, { title: "Already shipped", type: "task", acceptance: "- [ ] a" });
    const cold = await beads.create(repo, { title: "Gone quiet", type: "task", acceptance: "- [ ] a" });
    const survivor = await beads.create(repo, { title: "The one that landed", type: "task", acceptance: "- [ ] a" });
    const twin = await beads.create(repo, { title: "The duplicate", type: "task", acceptance: "- [ ] a" });
    await beads.close(repo, survivor);

    const closeIt = await file({
      kind: "shipped-orphan",
      move: "retire",
      retireAs: "close",
      subjects: [shipped],
      summary: "a commit shipped it, the board never closed it",
      evidence: ["bd orphans named it"],
    });
    const deferIt = await file({
      kind: "stale",
      move: "retire",
      retireAs: "defer",
      subjects: [cold],
      summary: "untouched far past the retirement window",
      evidence: ["bd stale named it"],
    });
    const supersedeIt = await file({
      kind: "superseded",
      move: "retire",
      retireAs: "supersede",
      subjects: [twin],
      target: survivor,
      summary: "its identical twin already landed",
      evidence: ["bd duplicates grouped them"],
    });

    await applied(closeIt.id);
    await applied(deferIt.id);
    await applied(supersedeIt.id);

    // Closed means shipped; deferred keeps the contract but leaves the ready set; superseded points
    // at where the work actually landed. A shared "close everything" would erase those distinctions.
    expect((await show(shipped)).status).toBe("closed");
    expect((await show(cold)).status).toBe("deferred");
    expect((await show(twin)).status).toBe("closed");
    expect(beads.edgesOf(await beads.list(repo, ["--status", "all"]))).toContainEqual({
      from: twin,
      to: survivor,
      type: "supersedes",
    });
  });

  it("closes a proposal the board already satisfied, without writing to a subject twice", async () => {
    const card = await beads.create(repo, { title: "Home already", type: "feature", acceptance: "- [ ] a" });
    const ticket = await beads.create(repo, {
      title: "Already home",
      type: "task",
      acceptance: "- [ ] a",
      deps: [`parent-child:${card}`],
    });
    const proposal = await file({
      kind: "container-orphan",
      move: "reparent",
      subjects: [ticket],
      target: card,
      summary: "it rides no card",
      evidence: ["its parent is a container epic"],
    });

    const result = await applied(proposal.id);

    expect(result.summary).toContain("already");
    expect(beads.parentOf(await show(ticket))).toBe(card);
    expect((await show(proposal.id)).status).toBe("closed");
  });

  it("refuses a stale proposal: nothing is written, it stays open, and the reason is on the bead", async () => {
    const card = await beads.create(repo, { title: "A home", type: "feature", acceptance: "- [ ] a" });
    const ticket = await beads.create(repo, { title: "Moved on", type: "task", acceptance: "- [ ] a" });
    const proposal = await file({
      kind: "container-orphan",
      move: "reparent",
      subjects: [ticket],
      target: card,
      summary: "it rides no card",
      evidence: ["its parent is a container epic"],
    });
    // The board moves after the proposal was filed — the case every nightly patrol eventually hits.
    await beads.close(repo, ticket);
    resetIssueSnapshots();

    const res = await approve(proposal.id);
    const body = (await res.json()) as { error?: string };

    expect(res.status).toBe(409);
    expect(body.error).toContain(ticket);
    // Inert: the subject keeps its parent (none), and the proposal is still there to be re-decided.
    expect(beads.parentOf(await show(ticket))).toBeUndefined();
    const still = await show(proposal.id);
    expect(still.status).toBe("open");
    // Never labelled approved — approving a proposal is applying it, not queuing a run.
    expect(beads.isApproved(still)).toBe(false);
    expect(String(still.notes ?? "")).toContain("apply FAILED");
  });

  // The filing→approval window a live board is the only place to prove: `bd update --claim` writes
  // the assignee and in_progress with NO run-lease behind it, so the bead reads as free work to
  // every liveness signal the approval consults. What dates it as news is bd's own write stamp
  // against the proposal's creation.
  it("refuses a subject a run claimed after the proposal was filed, lease or no lease", async () => {
    const card = await beads.create(repo, { title: "Claim home", type: "feature", acceptance: "- [ ] a" });
    const ticket = await beads.create(repo, { title: "Picked up", type: "task", acceptance: "- [ ] a" });
    const proposal = await file({
      kind: "container-orphan",
      move: "reparent",
      subjects: [ticket],
      target: card,
      summary: "it rides no card",
      evidence: ["its parent is a container epic"],
    });
    // bd stamps at one-second resolution, so the claim has to land in a LATER second than the
    // proposal's creation for the two to be orderable at all.
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    await beads.claim(repo, ticket, "runner-e2e");
    resetIssueSnapshots();

    const res = await approve(proposal.id);
    const body = (await res.json()) as { error?: string };

    expect(res.status).toBe(409);
    expect(body.error).toContain("claimed since this proposal was filed");
    // Inert: the run keeps its ticket exactly as it claimed it.
    const held = await show(ticket);
    expect(beads.parentOf(held)).toBeUndefined();
    expect(held.status).toBe("in_progress");
    expect((await show(proposal.id)).status).toBe("open");
  });

  it("declines through abandon: the reason is recorded and the patrol never re-files it", async () => {
    const { abandonTicket } = await import("@/lib/abandon");
    const { getProjectBySlug } = await import("@/lib/projects");
    const { emitProposals } = await import("@/lib/gardener/emit");

    const ticket = await beads.create(repo, { title: "Leave it be", type: "task", acceptance: "- [ ] a" });
    const input: DetectionInput = {
      kind: "stale",
      move: "retire",
      retireAs: "defer",
      subjects: [ticket],
      summary: "untouched far past the retirement window",
      evidence: ["bd stale named it"],
    };
    const proposal = await file(input);

    const project = (await getProjectBySlug("approvy"))!;
    await abandonTicket(project, proposal.id, "this one is deliberately parked");

    const declined = await show(proposal.id);
    expect(declined.status).toBe("closed");
    expect(beads.isAbandoned(declined)).toBe(true);
    expect(String(declined.notes ?? "")).toContain(proposal.fingerprint);

    // The next patrol, over the real board, with the same detection: the "no" is remembered.
    resetIssueSnapshots();
    const board = await beads.list(repo, ["--status", "all"]);
    const emission = await emitProposals(repo, { board, detections: [makeDetection(input)] });
    expect(emission).toMatchObject({ created: [], suppressed: 1 });

    // And the subject itself was never touched by a decision that said "don't".
    expect((await show(ticket)).status).toBe("open");
  });

  it("declines are not applied: approving a declined proposal is refused", async () => {
    const ticket = await beads.create(repo, { title: "Also parked", type: "task", acceptance: "- [ ] a" });
    const proposal = await file({
      kind: "stale",
      move: "retire",
      retireAs: "defer",
      subjects: [ticket],
      summary: "untouched far past the retirement window",
      evidence: ["bd stale named it"],
    });
    await beads.abandon(repo, proposal.id, "no");
    resetIssueSnapshots();

    const res = await approve(proposal.id);
    expect(res.status).toBe(422);
    expect((await show(ticket)).status).toBe("open");
  });

  it("never mentions notes it did not write", async () => {
    // Guard against the note format drifting silently: a system note is one unindented line, which
    // is what makes the ticket dialog render it as anton's rather than swallow it into a human's.
    const ticket = await beads.create(repo, { title: "Note shape", type: "task", acceptance: "- [ ] a" });
    const proposal = await file({
      kind: "shipped-orphan",
      move: "retire",
      retireAs: "close",
      subjects: [ticket],
      summary: "a commit shipped it",
      evidence: ["bd orphans named it"],
    });
    await applied(proposal.id);

    const lines = (await notesOf(proposal.id)).split("\n").filter(Boolean);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^gardener: applied — /);
  });
});
