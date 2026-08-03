/**
 * Apply-on-approve (anton-1t3n), over fixture boards with the bd seam's WRITES stubbed.
 *
 * The decision half (`planApply`) is pure, so the preconditions that protect other people's beads
 * are asserted against fixture boards rather than a live one. The execution half is asserted through
 * the recorded seam calls, because what matters is exactly which bd verb ran against which bead —
 * a `close` where a `defer` was proposed is the one mistake a retirement must never make.
 *
 * Three claims are worth the most here:
 *   • A STALE PLAN WRITES NOTHING. A proposal describes the board as it was; approving it re-checks
 *     every fact and refuses when one has changed.
 *   • NO PARTIAL APPLICATION. The only multi-write move is a cluster re-parent; a failure part-way
 *     rolls back what landed and leaves the proposal OPEN with the error attached.
 *   • APPLIED ≠ DECLINED. Applying closes the proposal plainly (the board changed, so the detector
 *     has nothing left to find); declining abandons it, which is what suppresses the fingerprint.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { LABELS, type Bead } from "../beads/bd";
import { gardenerFingerprint, parseGardenerPlan, type GardenerPlan } from "./detections";

/** Every bd write the module made, in order: `<verb> <args…>`. */
const calls: string[] = [];
/**
 * Writes primed to reject, keyed by `<verb>:<id>` → which occurrence fails (1-based). The occurrence
 * matters: rolling a re-parent back re-issues the SAME verb on the SAME bead, so "fail the second
 * one" is the only way to test a rollback that itself fails.
 */
const failOn = new Map<string, number>();
const seen = new Map<string, number>();

function record(verb: string, ...args: string[]): Promise<string> {
  const key = `${verb}:${args[0]}`;
  calls.push([verb, ...args].join(" "));
  const nth = (seen.get(key) ?? 0) + 1;
  seen.set(key, nth);
  if (failOn.get(key) === nth) return Promise.reject(new Error(`bd ${verb} exploded`));
  return Promise.resolve("");
}

vi.mock("../beads/bd", async () => {
  const actual = await vi.importActual<typeof import("../beads/bd")>("../beads/bd");
  return {
    ...actual,
    beads: {
      ...actual.beads,
      reparent: (_cwd: string, id: string, parent: string) => record("reparent", id, parent),
      link: (_cwd: string, a: string, b: string, type: string) => record("link", a, b, type),
      close: (_cwd: string, id: string, reason?: string) => record("close", id, reason ?? ""),
      supersede: (_cwd: string, id: string, w: string) => record("supersede", id, w),
      defer: (_cwd: string, id: string) => record("defer", id),
      note: (_cwd: string, id: string, text: string) => record("note", id, text),
    },
  };
});

const {
  ProposalApplyError,
  applyProposal,
  declineNote,
  declinedFingerprints,
  planApply,
} = await import("./apply");

const REPO = "/tmp/gardener-apply";

// ── fixture builders ──

function bead(id: string, extra: Partial<Bead> = {}): Bead {
  return { id, title: id, status: "open", issue_type: "task", ...extra };
}

/** A bead with a parent, expressed the way `bd list --json` carries it (field + inline edge). */
function child(id: string, parent: string, extra: Partial<Bead> = {}): Bead {
  return {
    ...bead(id, extra),
    parent,
    dependencies: [{ issue_id: id, depends_on_id: parent, type: "parent-child" }],
  };
}

function planFor(input: Omit<GardenerPlan, "fingerprint">): GardenerPlan {
  return { ...input, fingerprint: gardenerFingerprint(input.kind, input.subjects.join("+")) };
}

/** The proposal bead as the board hands it back: fingerprint label + the plan as metadata. */
function proposalFor(plan: GardenerPlan, extra: Partial<Bead> = {}): Bead {
  return bead("anton-p1", {
    title: "Gardener: do the thing",
    labels: [plan.fingerprint, "domain:eng", "source:gardener"],
    metadata: { gardener: plan },
    ...extra,
  });
}

/** The moment every decision below is judged at — only the run-lease checks read it. */
const NOW = Date.parse("2026-08-03T00:00:00Z");

/** A bead a run owns right now: an unexpired lease, dated relative to `at`. */
const leased = (id: string, at: number): Bead =>
  bead(id, { assignee: "runner-1", labels: [LABELS.runLease(at + 60_000, "run-9")] });

/** The other half of the same bar (board-index `isInFlight`): a run whose PR is up. */
const inReview = (id: string): Bead => bead(id, { labels: ["stage:in-review"] });

/** A feature card with an open ticket under it — a legal re-parent home. */
const CARD = bead("anton-card", { issue_type: "feature" });

const REPARENT = planFor({
  kind: "container-orphan",
  move: "reparent",
  subjects: ["anton-a"],
  target: CARD.id,
});

const CLUSTER = planFor({
  kind: "parentless-cluster",
  move: "reparent",
  subjects: ["anton-a", "anton-b"],
  target: CARD.id,
});

const LINK = planFor({
  kind: "implied-order",
  move: "link",
  subjects: ["anton-a"],
  target: "anton-b",
});

const DEFER = planFor({
  kind: "stale",
  move: "retire",
  retireAs: "defer",
  subjects: ["anton-a"],
});

const CLOSE = planFor({
  kind: "shipped-orphan",
  move: "retire",
  retireAs: "close",
  subjects: ["anton-a"],
});

const SUPERSEDE = planFor({
  kind: "superseded",
  move: "retire",
  retireAs: "supersede",
  subjects: ["anton-a"],
  target: "anton-b",
});

beforeEach(() => {
  calls.length = 0;
  failOn.clear();
  seen.clear();
});

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
});

describe("planApply — what an approval means against the board as it now is", () => {
  it("re-parents every subject that isn't already home, remembering the parent to undo to", () => {
    const board = [CARD, child("anton-a", "anton-container"), bead("anton-b")];
    const decision = planApply(CLUSTER, board);

    expect(decision).toEqual({
      status: "apply",
      summary: "re-parented anton-a, anton-b under anton-card",
      steps: [
        { verb: "reparent", id: "anton-a", parent: "anton-card", undoParent: "anton-container" },
        // A parentless subject undoes to bd's detach form, not to some invented parent.
        { verb: "reparent", id: "anton-b", parent: "anton-card", undoParent: "" },
      ],
    });
  });

  it("settles a re-parent the board already reads as applied, rather than writing again", () => {
    const board = [CARD, child("anton-a", CARD.id)];
    expect(planApply(REPARENT, board)).toEqual({
      status: "settled",
      summary: "anton-a already sits under anton-card",
    });
  });

  it("records the blocks edge in the direction the detection states", () => {
    const board = [bead("anton-a"), bead("anton-b")];
    expect(planApply(LINK, board)).toEqual({
      status: "apply",
      summary: "recorded that anton-b blocks anton-a",
      steps: [{ verb: "link", id: "anton-a", blocker: "anton-b" }],
    });
  });

  it("settles a link whose edge already exists — in EITHER direction", () => {
    const edged = (from: string, to: string): Bead[] => [
      {
        ...bead("anton-a"),
        dependencies: [{ issue_id: from, depends_on_id: to, type: "blocks" }],
      },
      bead("anton-b"),
    ];
    // A reversed edge is somebody's recorded decision, never something to overwrite.
    expect(planApply(LINK, edged("anton-a", "anton-b")).status).toBe("settled");
    expect(planApply(LINK, edged("anton-b", "anton-a")).status).toBe("settled");
  });

  it("maps each retirement to ITS OWN verb — close, defer and supersede are not interchangeable", () => {
    expect(planApply(CLOSE, [bead("anton-a")])).toMatchObject({
      status: "apply",
      steps: [{ verb: "close", id: "anton-a" }],
    });
    expect(planApply(DEFER, [bead("anton-a")])).toMatchObject({
      status: "apply",
      steps: [{ verb: "defer", id: "anton-a" }],
    });
    expect(
      planApply(SUPERSEDE, [bead("anton-a"), bead("anton-b", { status: "closed" })]),
    ).toMatchObject({
      status: "apply",
      steps: [{ verb: "supersede", id: "anton-a", replacement: "anton-b" }],
    });
  });

  it("settles a retirement the board already carried out, however it was carried out", () => {
    expect(planApply(CLOSE, [bead("anton-a", { status: "closed" })]).status).toBe("settled");
    expect(planApply(DEFER, [bead("anton-a", { status: "deferred" })]).status).toBe("settled");
    // Even half-abandoned (the state a crashed abandon leaves): closing it would read as shipped.
    expect(
      planApply(CLOSE, [bead("anton-a", { labels: [LABELS.abandoned] })]),
    ).toEqual({ status: "settled", summary: "anton-a is already abandoned" });
  });

  describe("refusals — every one of them writes nothing at all", () => {
    const refusal = (decision: ReturnType<typeof planApply>): string => {
      expect(decision.status).toBe("refuse");
      return decision.status === "refuse" ? decision.reason : "";
    };

    it("refuses when a bead the plan names has left the board", () => {
      expect(refusal(planApply(REPARENT, [CARD]))).toMatch(/anton-a is no longer on the board/);
      expect(refusal(planApply(REPARENT, [bead("anton-a")]))).toMatch(/anton-card is no longer/);
    });

    it("refuses to move a subject that settled since the proposal was filed", () => {
      const board = [CARD, bead("anton-a", { status: "closed" })];
      expect(refusal(planApply(REPARENT, board))).toMatch(/anton-a is closed/);
      const abandoned = [CARD, bead("anton-a", { labels: [LABELS.abandoned], status: "closed" })];
      expect(refusal(planApply(REPARENT, abandoned))).toMatch(/anton-a is abandoned/);
    });

    it("refuses a home that is not a board card — the state the proposal exists to fix", () => {
      // An epic WITH a feature child is a container: work parented to it rides no card.
      const container = bead("anton-card", { issue_type: "epic" });
      const board = [container, child("anton-f", container.id, { issue_type: "feature" }), bead("anton-a")];
      expect(refusal(planApply(REPARENT, board))).toMatch(/not a board card/);
    });

    it("refuses a re-parent that would make a subtree its own ancestor", () => {
      const board = [child(CARD.id, "anton-a", { issue_type: "feature" }), bead("anton-a")];
      expect(refusal(planApply(REPARENT, board))).toMatch(/its own ancestor/);
    });

    it("refuses a proposal that names no home — it asks a human to choose one", () => {
      const homeless = planFor({ kind: "container-orphan", move: "reparent", subjects: ["anton-a"] });
      expect(refusal(planApply(homeless, [bead("anton-a")]))).toMatch(/names no new parent/);
    });

    it("refuses an ordering edge once the blocker has landed", () => {
      const board = [bead("anton-a"), bead("anton-b", { status: "closed" })];
      expect(refusal(planApply(LINK, board))).toMatch(/anton-b is closed/);
    });

    it("refuses to supersede when the survivor is open again — nothing landed over there", () => {
      const board = [bead("anton-a"), bead("anton-b")];
      expect(refusal(planApply(SUPERSEDE, board))).toMatch(/has not landed/);
    });

    // The bar every detector proposes under (board-index `isInFlight`), re-checked HERE because the
    // run usually claims the bead AFTER the proposal was filed: approving last night's ask would
    // re-parent or retire work an agent is mid-flight over.
    it("refuses every move against a bead a run owns — live lease or open PR alike", () => {
      for (const live of [leased("anton-a", NOW), inReview("anton-a")]) {
        expect(refusal(planApply(REPARENT, [CARD, live], NOW))).toMatch(/anton-a is mid-run/);
        expect(refusal(planApply(CLUSTER, [CARD, live, bead("anton-b")], NOW))).toMatch(
          /anton-a is mid-run/,
        );
        expect(refusal(planApply(LINK, [live, bead("anton-b")], NOW))).toMatch(/anton-a is mid-run/);
        expect(refusal(planApply(DEFER, [live], NOW))).toMatch(/anton-a is mid-run/);
        expect(refusal(planApply(CLOSE, [live], NOW))).toMatch(/anton-a is mid-run/);
        const survivor = bead("anton-b", { status: "closed" });
        expect(refusal(planApply(SUPERSEDE, [live, survivor], NOW))).toMatch(/anton-a is mid-run/);
      }
    });

    it("names the run that owns it, so the operator knows what they are waiting on", () => {
      expect(refusal(planApply(DEFER, [leased("anton-a", NOW)], NOW))).toMatch(
        /live lease on it \(runner-1\)/,
      );
      expect(refusal(planApply(DEFER, [inReview("anton-a")], NOW))).toMatch(/it is in review/);
    });

    it("applies against an EXPIRED lease — a crashed run owns nothing", () => {
      const dead = bead("anton-a", { labels: [LABELS.runLease(NOW - 1, "run-9")] });
      expect(planApply(DEFER, [dead], NOW).status).toBe("apply");
    });

    it("still SETTLES a mid-run bead the board already retired — there is nothing to write", () => {
      const done = { ...leased("anton-a", NOW), status: "deferred" };
      expect(planApply(DEFER, [done], NOW).status).toBe("settled");
    });
  });
});

describe("applyProposal — the writes, and the proposal's own settlement", () => {
  it("applies the move, then notes and closes the proposal with what changed", async () => {
    const proposal = proposalFor(REPARENT);
    const board = [CARD, bead("anton-a"), proposal];

    const result = await applyProposal(REPO, proposal, board);

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

  it("closes a proposal the board already satisfied WITHOUT touching a subject bead", async () => {
    const proposal = proposalFor(REPARENT);
    const result = await applyProposal(REPO, proposal, [CARD, child("anton-a", CARD.id), proposal]);

    expect(result.changed).toEqual([]);
    expect(calls.filter((c) => c.startsWith("reparent"))).toEqual([]);
    expect(calls.at(-1)).toContain(`close ${proposal.id}`);
  });

  it("rolls back a half-applied cluster and leaves the proposal OPEN with the error attached", async () => {
    const proposal = proposalFor(CLUSTER);
    const board = [CARD, child("anton-a", "anton-old"), bead("anton-b"), proposal];
    failOn.set("reparent:anton-b", 1);

    await expect(applyProposal(REPO, proposal, board)).rejects.toThrow(/rolled back/);

    expect(calls).toEqual([
      "reparent anton-a anton-card",
      "reparent anton-b anton-card", // the failure
      "reparent anton-a anton-old", // undone, back to where it was
      `note ${proposal.id} gardener: apply FAILED — applying ${proposal.id} failed: bd reparent exploded — the 1 write(s) already made were rolled back, so the board is unchanged`,
    ]);
    // The one thing a failed apply must never do.
    expect(calls.some((c) => c.startsWith(`close ${proposal.id}`))).toBe(false);
  });

  it("says so loudly when the rollback ITSELF fails — a board a human has to look at", async () => {
    const proposal = proposalFor(CLUSTER);
    const board = [CARD, child("anton-a", "anton-old"), bead("anton-b"), proposal];
    failOn.set("reparent:anton-b", 1);
    // The SECOND write to anton-a is its undo — fail that too, and the board is left half-moved.
    failOn.set("reparent:anton-a", 2);

    await expect(applyProposal(REPO, proposal, board)).rejects.toThrow(/ROLLBACK INCOMPLETE/);
    expect(calls.some((c) => c.startsWith(`close ${proposal.id}`))).toBe(false);
  });

  it("refuses a stale plan without writing anything, and notes why on the proposal", async () => {
    const proposal = proposalFor(REPARENT);
    const board = [CARD, bead("anton-a", { status: "closed" }), proposal];

    await expect(applyProposal(REPO, proposal, board)).rejects.toMatchObject({
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

    await expect(applyProposal(REPO, proposal, [live, proposal])).rejects.toMatchObject({
      failure: "refused",
    });
    // Nothing but the explanation on the proposal: the subject bead is left to its run.
    expect(calls).toEqual([
      `note ${proposal.id} gardener: apply FAILED — cannot apply ${proposal.id}: anton-a is mid-run — a run holds a live lease on it (runner-1), so retiring it would race the run that owns it`,
    ]);

    calls.length = 0;
    const reparent = proposalFor(REPARENT);
    await expect(
      applyProposal(REPO, reparent, [CARD, inReview("anton-a"), reparent]),
    ).rejects.toMatchObject({ failure: "refused" });
    expect(calls.filter((c) => !c.startsWith("note"))).toEqual([]);
  });

  it("refuses a bead whose plan cannot be read, rather than guessing one from its prose", async () => {
    const noPlan = bead("anton-p2", { labels: [REPARENT.fingerprint] });
    await expect(applyProposal(REPO, noPlan, [noPlan])).rejects.toMatchObject({
      failure: "unusable",
    });

    // A plan whose fingerprint disagrees with the bead's label is not this bead's plan.
    const mismatched = proposalFor(REPARENT, { labels: [CLUSTER.fingerprint] });
    await expect(applyProposal(REPO, mismatched, [mismatched])).rejects.toMatchObject({
      failure: "unusable",
    });

    // Neither writes to a subject bead.
    expect(calls.filter((c) => !c.startsWith("note"))).toEqual([]);
  });

  it("refuses a bead that is not a proposal, and one that already settled", async () => {
    const plain = bead("anton-x");
    await expect(applyProposal(REPO, plain, [plain])).rejects.toThrow(/not a gardener proposal/);

    const settled = proposalFor(REPARENT, { status: "closed" });
    await expect(applyProposal(REPO, settled, [settled])).rejects.toThrow(/already settled/);
    expect(calls).toEqual([]);
  });

  it("carries a failure class every caller can map to a status", async () => {
    const proposal = proposalFor(REPARENT);
    const err = await applyProposal(REPO, proposal, [proposal]).catch((e) => e);
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

  it("reads declines off ABANDONED proposals only — an applied one is not a no", () => {
    const declined = proposalFor(REPARENT, {
      status: "closed",
      labels: [REPARENT.fingerprint, LABELS.abandoned],
    });
    const applied = proposalFor(CLUSTER, { id: "anton-p3", status: "closed" });
    expect([...declinedFingerprints([declined, applied, bead("anton-x")])]).toEqual([
      REPARENT.fingerprint,
    ]);
  });
});
