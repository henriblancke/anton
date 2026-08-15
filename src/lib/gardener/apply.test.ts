/**
 * Apply-on-approve (anton-1t3n) COMPOSED: the plan read off a proposal bead, the decision handed to
 * the writes, and the proposal's own settlement — over fixture boards with the bd seam's WRITES
 * stubbed.
 *
 * The decision half is asserted in `apply-plan.test.ts` and the per-step re-checks and rollbacks in
 * `apply-steps.test.ts`; what is left here is what only the composition can be held to:
 *   • THE PLAN IS READ STRICTLY. It decides what gets mutated, so a bead whose metadata disagrees
 *     with its own fingerprint is refused rather than executed.
 *   • APPLIED ≠ DECLINED. Applying closes the proposal plainly (the board changed, so the detector
 *     has nothing left to find); declining abandons it, which is what suppresses the fingerprint.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { LABELS, type Bead } from "../beads/bd";
import { parseGardenerPlan } from "./detections";
import {
  apply,
  applyWith,
  bead,
  calls,
  CARD,
  child,
  CLOSE,
  CLUSTER,
  cold,
  DEFER,
  FILED,
  inReview,
  leased,
  listBoard,
  liveBeads,
  NOW,
  planFor,
  proposalFor,
  record,
  REPARENT,
  REPO,
  resetSeam,
  setSnapshot,
  showBead,
  SUPERSEDE,
  warm,
} from "./apply.fixture";

// Every reference to the seam sits INSIDE a wrapper: vitest hoists this factory above the imports
// above, so touching one while building the object would read it before it is initialised.
vi.mock("../beads/bd", async () => {
  const actual = await vi.importActual<typeof import("../beads/bd")>("../beads/bd");
  return {
    ...actual,
    beads: {
      ...actual.beads,
      show: (_cwd: string, id: string) => showBead(id),
      list: (_cwd: string, extra: string[] = []) => listBoard(extra),
      reparent: (_cwd: string, id: string, parent: string) => record("reparent", id, parent),
      link: (_cwd: string, a: string, b: string, type: string) => record("link", a, b, type),
      close: (_cwd: string, id: string, reason?: string) => record("close", id, reason ?? ""),
      supersede: (_cwd: string, id: string, w: string) => record("supersede", id, w),
      defer: (_cwd: string, id: string) => record("defer", id),
      update: (_cwd: string, id: string, patch: { priority?: number }) =>
        record("update", id, `P${patch.priority}`),
      note: (_cwd: string, id: string, text: string) => record("note", id, text),
      untag: (_cwd: string, id: string, labels: string[]) => record("untag", id, labels.join(",")),
    },
  };
});

const { ProposalApplyError, applyProposal, declineNote, planApply } = await import("./apply");

beforeEach(resetSeam);

describe("the plan a proposal carries — read strictly, because it decides what gets mutated", () => {
  it("accepts what the emitter writes and nothing else", () => {
    expect(parseGardenerPlan(REPARENT)).toEqual(REPARENT);
    expect(parseGardenerPlan(SUPERSEDE)).toEqual(SUPERSEDE);
  });

  it.each([
    ["not an object", "reparent"],
    ["a move this anton has no executor for", { ...REPARENT, move: "compact" }],
    ["a kind no detector emits", { ...REPARENT, kind: "vibes" }],
    ["a fingerprint that isn't one", { ...REPARENT, fingerprint: "gardener:stale:nope" }],
    ["no subjects to act on", { ...REPARENT, subjects: [] }],
    ["a subject that isn't an id", { ...REPARENT, subjects: [7] }],
    // A retirement with no verb has no safe default: close, defer and supersede say different things.
    ["a retirement with no verb", { ...SUPERSEDE, retireAs: undefined }],
    ["a retirement verb bd has no wrapper for", { ...SUPERSEDE, retireAs: "delete" }],
    ["a retirement verb on a move that takes none", { ...REPARENT, retireAs: "close" }],
  ])("rejects %s", (_case, value) => {
    expect(parseGardenerPlan(value)).toBeUndefined();
  });

  // The fingerprint is what an approver's bead and its plan have IN COMMON, so every field it
  // covers has to be recomputed from the plan rather than trusted — otherwise editing the metadata
  // and keeping the hash makes the bead describe one move and execute another.
  it.each([
    ["subjects swapped under a kept fingerprint", { ...REPARENT, subjects: ["anton-zzz"] }],
    ["a target redirected under a kept fingerprint", { ...REPARENT, target: "anton-elsewhere" }],
    ["a subject appended under a kept fingerprint", { ...CLUSTER, subjects: ["anton-a", "anton-b", "anton-c"] }],
  ])("rejects %s", (_case, value) => {
    expect(parseGardenerPlan(value)).toBeUndefined();
  });

  // `move` and `retireAs` are the two fields the hash can't cover, so the kind→verb pairing is what
  // binds them: a bead whose prose says "defer" must never execute a close.
  it("rejects a move or a retirement verb its kind does not mean", () => {
    expect(parseGardenerPlan({ ...DEFER, retireAs: "close" })).toBeUndefined();
    expect(parseGardenerPlan({ ...CLOSE, retireAs: "defer" })).toBeUndefined();
    expect(parseGardenerPlan({ ...REPARENT, move: "link" })).toBeUndefined();
    // …and a `stale` bead that kept its own verb still reads fine.
    expect(parseGardenerPlan(DEFER)).toEqual(DEFER);
  });

  // Subjects are a SET: the fingerprint sorts them, so a reordered list is the same claim.
  it("accepts subjects in any order — the identity is the set, not the listing", () => {
    const reordered = { ...CLUSTER, subjects: ["anton-b", "anton-a"] };
    expect(parseGardenerPlan(reordered)).toEqual(reordered);
  });
});

describe("applyProposal — the writes, and the proposal's own settlement", () => {
  it("applies the move, then notes and closes the proposal with what changed", async () => {
    const proposal = proposalFor(REPARENT);
    const board = [CARD, bead("anton-a"), proposal];

    const result = await apply(proposal, board);

    expect(result).toMatchObject({
      proposalId: proposal.id,
      summary: "re-parented anton-a under anton-card",
      changed: ["anton-a"],
    });
    expect(calls).toEqual([
      "reparent anton-a anton-card",
      `note ${proposal.id} gardener: applied — re-parented anton-a under anton-card.`,
      `close ${proposal.id} applied: re-parented anton-a under anton-card`,
    ]);
  });

  it("names POLICY on the note when nobody was asked — the same move, a different event", async () => {
    const proposal = proposalFor(REPARENT);

    const result = await apply(proposal, [CARD, bead("anton-a"), proposal], "policy");

    // The board move is identical to the approved one above, which is exactly why the note has to
    // differ: it is the only place the board records that nobody approved this, and which setting
    // did — the first thing a founder who finds a bead moved overnight goes looking for.
    expect(result.changed).toEqual(["anton-a"]);
    expect(calls).toEqual([
      "reparent anton-a anton-card",
      `note ${proposal.id} gardener: applied by POLICY — re-parented anton-a under anton-card. ` +
        "Nobody approved this: this project's proposal autonomy for `container-orphan` is set to apply.",
      `close ${proposal.id} applied: re-parented anton-a under anton-card`,
    ]);
  });

  it("closes a proposal the board already satisfied WITHOUT touching a subject bead", async () => {
    const proposal = proposalFor(REPARENT);
    const result = await apply(proposal, [CARD, child("anton-a", CARD.id), proposal]);

    expect(result.changed).toEqual([]);
    expect(calls.filter((c) => c.startsWith("reparent"))).toEqual([]);
    expect(calls.at(-1)).toContain(`close ${proposal.id}`);
  });

  // A settled decision runs no step, so nothing else re-reads the beads it rests on — its whole
  // claim is the caller's snapshot. Closing on a snapshot the board has since contradicted would
  // settle the proposal as applied over a state that is no longer there.
  it("refuses to settle when the move was undone after the snapshot", async () => {
    const proposal = proposalFor(REPARENT);
    liveBeads.set("anton-a", bead("anton-a")); // moved back out from under the card since

    await expect(
      apply(proposal, [CARD, child("anton-a", CARD.id), proposal]),
    ).rejects.toMatchObject({
      failure: "refused",
      message: expect.stringContaining("no longer reads as applied"),
    });
    expect(calls.filter((c) => !c.startsWith("note"))).toEqual([]);
  });

  it("refuses to settle when the live board now refuses the move outright", async () => {
    // The subject still sits where the proposal wanted it, but the home has closed since — the same
    // answer a fresh snapshot would give, rather than a close resting on the stale one.
    const proposal = proposalFor(REPARENT);
    liveBeads.set(CARD.id, { ...CARD, status: "closed" });

    await expect(
      apply(proposal, [CARD, child("anton-a", CARD.id), proposal]),
    ).rejects.toMatchObject({
      failure: "refused",
      message: expect.stringContaining("no longer reads as applied"),
    });
    expect(calls.filter((c) => !c.startsWith("note"))).toEqual([]);
  });

  // The snapshot is stale the instant it is taken, and a runner publishing a lease in that window is
  // exactly what the in-flight bar exists for — so the last word belongs to a read taken under the
  // subject's own write lock, the one a run's claim also queues on.
  // Two Approve clicks on one proposal: the settled check at the top ran against a snapshot taken
  // before the first one landed, so the loser reaches the apply — and must find, under the lock, a
  // proposal already answered and write nothing at all.
  it("refuses a proposal a concurrent approve already settled, re-running nothing", async () => {
    const proposal = proposalFor(REPARENT);
    liveBeads.set(proposal.id, { ...proposal, status: "closed" });

    await expect(apply(proposal, [CARD, bead("anton-a"), proposal])).rejects.toMatchObject({
      failure: "unusable",
      message: expect.stringContaining("already settled"),
    });
    expect(calls).toEqual([]);
  });

  // The proposal is what RECORDS the decision, and settling it happens outside the rollback. One we
  // cannot read is one we probably cannot close either, so moving subjects first would leave board
  // writes with nothing saying who authorized them.
  it("refuses when the proposal itself cannot be re-read under its lock", async () => {
    const proposal = proposalFor(REPARENT);
    liveBeads.set(proposal.id, undefined); // deleted since the route took its snapshot

    await expect(apply(proposal, [CARD, bead("anton-a"), proposal])).rejects.toMatchObject({
      failure: "refused",
      message: expect.stringContaining("could not be re-read"),
    });
    expect(calls).toEqual([]);
  });

  // The interleave the proposal lock exists for: two approvals of one CLUSTER, whose per-subject
  // locks are released between steps. Unserialized, the loser could restore a subject to its stale
  // `undoParent` while the winner closed the proposal — a settled proposal claiming a move the board
  // only half holds.
  it("serializes two approvals of one cluster — the loser writes nothing", async () => {
    const proposal = proposalFor(CLUSTER);
    const board = [CARD, bead("anton-a"), bead("anton-b"), proposal];
    setSnapshot(board); // the winner's close lands on this board, and is what the loser then reads

    const [winner, loser] = await Promise.allSettled([
      applyProposal(REPO, proposal, board, "approval"),
      applyProposal(REPO, proposal, board, "approval"),
    ]);

    expect(winner.status).toBe("fulfilled");
    expect(loser).toMatchObject({ status: "rejected", reason: { failure: "unusable" } });
    // One application's worth of writes, start to finish — no second pass over the subjects.
    expect(calls).toEqual([
      "reparent anton-a anton-card",
      "reparent anton-b anton-card",
      `note ${proposal.id} gardener: applied — re-parented anton-a, anton-b under anton-card.`,
      `close ${proposal.id} applied: re-parented anton-a, anton-b under anton-card`,
    ]);
  });

  it("reports only the members it actually wrote to", async () => {
    const proposal = proposalFor(CLUSTER);
    liveBeads.set("anton-a", child("anton-a", CARD.id));

    const result = await apply(proposal, [CARD, bead("anton-a"), bead("anton-b"), proposal]);

    expect(result.changed).toEqual(["anton-b"]);
    expect(calls.filter((c) => c.startsWith("reparent"))).toEqual(["reparent anton-b anton-card"]);
  });

  it("refuses a stale plan without writing anything, and notes why on the proposal", async () => {
    const proposal = proposalFor(REPARENT);
    const board = [CARD, bead("anton-a", { status: "closed" }), proposal];

    await expect(apply(proposal, board)).rejects.toMatchObject({
      failure: "refused",
    });
    expect(calls).toEqual([
      `note ${proposal.id} gardener: apply FAILED — cannot apply ${proposal.id}: anton-a is closed — the board moved on since this was proposed`,
    ]);
  });

  it("refuses to touch a bead a run claimed since the proposal was filed", async () => {
    // Dated off the wall clock the apply itself reads, which is what makes the lease unexpired.
    const proposal = proposalFor(DEFER);
    const live = leased("anton-a", Date.now());

    await expect(apply(proposal, [live, proposal])).rejects.toMatchObject({
      failure: "refused",
    });
    // Nothing but the explanation on the proposal: the subject bead is left to its run.
    expect(calls).toEqual([
      `note ${proposal.id} gardener: apply FAILED — cannot apply ${proposal.id}: anton-a is mid-run — a run holds a live lease on it (runner-1), so retiring it would race the run that owns it`,
    ]);

    calls.length = 0;
    const reparent = proposalFor(REPARENT);
    await expect(
      apply(reparent, [CARD, inReview("anton-a"), reparent]),
    ).rejects.toMatchObject({ failure: "refused" });
    expect(calls.filter((c) => !c.startsWith("note"))).toEqual([]);
  });

  // A pass reads the board ONCE and then files its proposals through sequential bd writes, so a
  // subject edited inside that window is a change the detection never saw — while the proposal's own
  // `created_at`, stamped at the end of it, would date the edit as already-observed. The fence is the
  // snapshot the emitter recorded, which is what makes a late proposal in the loop as safe as the
  // first one.
  it("dates a premise from the board snapshot, not from when the bead was written", async () => {
    const proposal = proposalFor(DEFER, {
      metadata: { gardener: DEFER, gardenerObservedAt: "2026-07-01T00:00:00Z" },
      created_at: "2026-07-01T00:00:30Z", // filed half a minute into the same pass
    });
    // Edited inside the window: after the snapshot, before this proposal existed.
    const edited = bead("anton-a", { updated_at: "2026-07-01T00:00:20Z" });

    await expect(apply(proposal, [edited, proposal])).rejects.toMatchObject({
      failure: "refused",
    });
    // Nothing but the explanation: the edit is refused, not written over.
    expect(calls).toEqual([
      expect.stringContaining("anton-a has been written to since this proposal was filed"),
    ]);
  });

  // Metadata is hand-editable, and a fence pushed LATER is the one edit that would launder a write
  // the detection never saw into "the board the patrol judged". Clamped to the bead's own creation
  // stamp, the worst a rewritten value can do is refuse more.
  it("never lets a stamped snapshot push the fence later than the bead's own creation", async () => {
    const proposal = proposalFor(DEFER, {
      metadata: { gardener: DEFER, gardenerObservedAt: "2026-08-01T00:00:00Z" },
      created_at: FILED,
    });
    await expect(apply(proposal, [warm("anton-a"), proposal])).rejects.toMatchObject({
      failure: "refused",
    });
  });

  it("refuses a bead whose plan cannot be read, rather than guessing one from its prose", async () => {
    const noPlan = bead("anton-p2", { labels: [REPARENT.fingerprint] });
    await expect(apply(noPlan, [noPlan])).rejects.toMatchObject({
      failure: "unusable",
    });

    // A plan whose fingerprint disagrees with the bead's label is not this bead's plan.
    const mismatched = proposalFor(REPARENT, { labels: [CLUSTER.fingerprint] });
    await expect(apply(mismatched, [mismatched])).rejects.toMatchObject({
      failure: "unusable",
    });

    // Neither writes to a subject bead.
    expect(calls.filter((c) => !c.startsWith("note"))).toEqual([]);
  });

  it("refuses a bead that is not a proposal, and one that already settled", async () => {
    const plain = bead("anton-x");
    await expect(apply(plain, [plain])).rejects.toThrow(/not a proposal bead/);

    const settled = proposalFor(REPARENT, { status: "closed" });
    await expect(apply(settled, [settled])).rejects.toThrow(/already settled/);
    expect(calls).toEqual([]);
  });

  it("carries a failure class every caller can map to a status", async () => {
    const proposal = proposalFor(REPARENT);
    const err = await apply(proposal, [proposal]).catch((e) => e);
    expect(err).toBeInstanceOf(ProposalApplyError);
    expect(err.failure).toBe("refused");
  });
});

describe("declining — the board's own memory of a no", () => {
  it("names the fingerprint that will no longer be asked, and how to undo the decline", () => {
    const proposal = proposalFor(REPARENT);
    const note = declineNote(proposal);
    expect(note).toContain(REPARENT.fingerprint);
    expect(note).toContain(LABELS.abandoned);
  });

  it("has nothing to say about a bead that is not a proposal", () => {
    expect(declineNote(bead("anton-x"))).toBeUndefined();
  });
});

/**
 * The product master's two new moves (anton-d2sx), applied through the same machinery.
 *
 * `reprioritize` is the first verb that rewrites a FIELD rather than the graph, so it earns its own
 * bars: the priority must be part of the plan's identity (a hand-edited P0 must not ride a P3's
 * fingerprint), a board that already agrees must SETTLE rather than write twice, and the evidence
 * fence must not refuse the very state the ask wanted. `split` is the opposite case — a proposal
 * anton deliberately cannot run, which has to refuse with an answer rather than a shrug.
 */
describe("the product master's moves", () => {
  const MISPRIORITY = planFor({
    kind: "mispriority",
    move: "reprioritize",
    subjects: ["anton-a"],
    detail: "P1",
  });
  const KILL = planFor({
    kind: "low-value",
    move: "retire",
    retireAs: "defer",
    subjects: ["anton-a"],
  });
  const SPLIT = planFor({ kind: "oversized", move: "split", subjects: ["anton-a"] });
  const ORDER = planFor({
    kind: "missing-order",
    move: "link",
    subjects: ["anton-aa"],
    target: "anton-bb",
  });

  it("writes the priority the plan names, and closes the proposal as applied", async () => {
    const subject = cold("anton-a", { priority: 3 });
    const result = await applyWith(proposalFor(MISPRIORITY), [subject]);
    expect(calls).toEqual([
      "update anton-a P1",
      "note anton-p1 pm: applied — moved anton-a from P3 to P1.",
      "close anton-p1 applied: moved anton-a from P3 to P1",
    ]);
    expect(result.changed).toEqual(["anton-a"]);
  });

  it("settles rather than writing when the board already carries the asked-for priority", async () => {
    // Warm on purpose: setting it by hand IS a write since the filing, and the evidence fence must
    // not turn the outcome the ask wanted into a refusal.
    await applyWith(proposalFor(MISPRIORITY), [warm("anton-a", { priority: 1 })]);
    expect(calls.filter((c) => c.startsWith("update"))).toEqual([]);
    expect(calls).toContain("close anton-p1 applied: anton-a is already at priority P1");
  });

  it("refuses a priority judgment about a bead somebody has since rewritten", async () => {
    const err = (await applyWith(proposalFor(MISPRIORITY), [warm("anton-a", { priority: 3 })]).catch(
      (e) => e,
    )) as InstanceType<typeof ProposalApplyError>;
    expect(err.failure).toBe("refused");
    expect(err.message).toMatch(/written to since this proposal was filed/);
    expect(calls.filter((c) => c.startsWith("update"))).toEqual([]);
  });

  it("refuses to re-rank a bead a run has claimed since the filing", async () => {
    const claimed = warm("anton-a", { priority: 3, status: "in_progress", assignee: "runner-1" });
    const err = (await applyWith(proposalFor(MISPRIORITY), [claimed]).catch((e) => e)) as InstanceType<
      typeof ProposalApplyError
    >;
    expect(err.failure).toBe("refused");
    expect(calls.filter((c) => c.startsWith("update"))).toEqual([]);
  });

  // The fingerprint is what binds the ask a human read to the write anton runs. Without the detail
  // in the hash, editing `P3` to `P0` on the bead would keep the label valid and change the write.
  it("invalidates a plan whose priority was edited after it was filed", () => {
    const tampered = { ...MISPRIORITY, detail: "P0" };
    expect(parseGardenerPlan(tampered)).toBeUndefined();
    expect(parseGardenerPlan(MISPRIORITY)).toEqual(MISPRIORITY);
  });

  it("defers a kill rather than closing it — a judgment call must stay reversible", async () => {
    await applyWith(proposalFor(KILL), [cold("anton-a")]);
    expect(calls[0]).toBe("defer anton-a");
    expect(calls.some((c) => c.startsWith("close anton-a"))).toBe(false);
  });

  it("records the ordering edge a missing-order ask names, with no body phrase to re-derive", async () => {
    // Unlike the gardener's `implied-order`, this ask rests on the pass's judgment rather than on a
    // phrase in the bead — so apply must not hold it to the phrase check that kind carries.
    const untouched = [cold("anton-aa"), cold("anton-bb")];
    const decision = planApply(ORDER, untouched, { nowMs: NOW, observedAtMs: Date.parse(FILED) });
    expect(decision.status).toBe("apply");
    await applyWith(proposalFor(ORDER), untouched);
    expect(calls[0]).toBe("link anton-aa anton-bb blocks");
  });

  it("refuses an ordering judgment about a bead somebody has since rewritten", async () => {
    // The judgment was made about a contract that no longer exists: nothing on the board restates
    // it, and every other bar here only asks whether the pair is still writable — which a rescoping
    // edit leaves exactly as the pass found it. So the filing stamp is the only fence there is.
    const err = (await applyWith(proposalFor(ORDER), [warm("anton-aa"), cold("anton-bb")]).catch(
      (e) => e,
    )) as InstanceType<typeof ProposalApplyError>;
    expect(err.failure).toBe("refused");
    expect(err.message).toMatch(/written to since this proposal was filed/);
    expect(calls.filter((c) => c.startsWith("link"))).toEqual([]);
  });

  /**
   * Post-approval re-validation (anton-xg5y). Unlike every other pm move, this one's premise is
   * RE-DERIVED at approve time rather than fenced against the filing stamp — because repairing the
   * bead is the other answer to the ask, and a fence would have refused exactly that outcome.
   */
  describe("withdrawing an approval that stopped holding", () => {
    const UNAPPROVE = planFor({
      kind: "degraded-approval",
      move: "unapprove",
      subjects: ["anton-a"],
    });

    /** Approved, and missing the one section that blocks a run: no rubric, no definition of done. */
    const degraded = (extra: Partial<Bead> = {}): Bead =>
      cold("anton-a", { labels: [LABELS.approved], ...extra });

    /** The same bead repaired — the gaps the ask names are gone, so the approval is sound again. */
    const repaired = (): Bead =>
      warm("anton-a", {
        labels: [LABELS.approved],
        description: "## Goal\nship it\n\n## Context\nhere\n\n## Out of scope\nnothing\n\n## Verify\ntests",
        acceptance_criteria: "- [ ] it ships",
      });

    it("takes the label off and leaves the reason ON THE BEAD, not only on the proposal", async () => {
      const result = await applyWith(proposalFor(UNAPPROVE), [degraded()]);
      // The note lands FIRST: a bead that drops out of the queue must never be the only trace.
      expect(calls[0]).toMatch(/^note anton-a pm: approval withdrawn by an approved proposal — /);
      expect(calls[0]).toMatch(/no Acceptance criteria/);
      expect(calls[1]).toBe(`untag anton-a ${LABELS.approved}`);
      expect(result.changed).toEqual(["anton-a"]);
      expect(calls.at(-1)).toMatch(/^close anton-p1 applied: withdrew the approval on anton-a/);
    });

    it("settles with the approval INTACT once the gaps are repaired — fix is the other answer", async () => {
      await applyWith(proposalFor(UNAPPROVE), [repaired()]);
      expect(calls.filter((c) => c.startsWith("untag"))).toEqual([]);
      expect(calls.at(-1)).toBe(
        "close anton-p1 applied: anton-a meets the approve gate again — the gaps were repaired, so the approval stands",
      );
    });

    it("settles when somebody dropped the label by hand — the ask's outcome, whoever wrote it", async () => {
      await applyWith(proposalFor(UNAPPROVE), [warm("anton-a")]);
      expect(calls.filter((c) => c.startsWith("untag"))).toEqual([]);
      expect(calls.at(-1)).toMatch(/close anton-p1 applied: anton-a no longer carries/);
    });

    it("refuses while a run owns it: withdrawing approval does not race that run, it kills it", async () => {
      const claimed = degraded({ status: "in_progress", assignee: "runner-1", updated_at: "2026-07-15T00:00:00Z" });
      const err = (await applyWith(proposalFor(UNAPPROVE), [claimed]).catch(
        (e) => e,
      )) as InstanceType<typeof ProposalApplyError>;
      expect(err.failure).toBe("refused");
      expect(err.message).toMatch(/re-checks the approval after its claim settles/);
      expect(calls.filter((c) => c.startsWith("untag"))).toEqual([]);
    });

    it("refuses a repair that landed between the decision and the write, under the bead's own lock", async () => {
      // The snapshot still shows the degraded bead; the read taken inside the write lock shows the
      // repair. Every other bar — open, unclaimed, still approved — is untouched by that edit, so
      // only the re-derived gate can catch it.
      liveBeads.set("anton-a", repaired());
      const err = (await applyWith(proposalFor(UNAPPROVE), [degraded()]).catch(
        (e) => e,
      )) as InstanceType<typeof ProposalApplyError>;
      expect(err.failure).toBe("refused");
      expect(err.message).toMatch(/meets the approve gate again/);
      expect(calls.filter((c) => !c.startsWith("note anton-p1"))).toEqual([]);
    });
  });

  it("refuses a split with an answer, because anton will not write new contracts on its own", async () => {
    const err = (await applyWith(proposalFor(SPLIT), [bead("anton-a")]).catch((e) => e)) as InstanceType<
      typeof ProposalApplyError
    >;
    expect(err.failure).toBe("refused");
    expect(err.message).toMatch(/\/shape/);
    expect(err.message).toMatch(/decline this proposal/);
    // Nothing but the refusal note: the board is untouched.
    expect(calls.filter((c) => !c.startsWith("note"))).toEqual([]);
  });
});
