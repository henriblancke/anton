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
import {
  detectionSubjectKey,
  gardenerFingerprint,
  parseGardenerPlan,
  type GardenerPlan,
} from "./detections";

/** Every bd write the module made, in order: `<verb> <args…>`. */
const calls: string[] = [];
/**
 * What `bd show` answers with under the write lock — the board AS OF THE WRITE, which is a different
 * question from the snapshot `applyProposal` decided on. Defaults to the snapshot; a test primes an
 * entry here to stage the exact race the lock exists for (a run claiming mid-approval).
 */
const liveBeads = new Map<string, Bead | undefined>();
/**
 * Writes primed to reject, keyed by `<verb>:<id>` → which occurrence fails (1-based). The occurrence
 * matters: rolling a re-parent back re-issues the SAME verb on the SAME bead, so "fail the second
 * one" is the only way to test a rollback that itself fails.
 */
const failOn = new Map<string, number>();
const seen = new Map<string, number>();
/**
 * Run after every write that landed — the seam a test uses to make the board ANSWER differently once
 * something has been written to it, which is how a second concurrent approve is staged.
 */
let onWrite: ((call: string) => void) | undefined;

function record(verb: string, ...args: string[]): Promise<string> {
  const key = `${verb}:${args[0]}`;
  const call = [verb, ...args].join(" ");
  calls.push(call);
  const nth = (seen.get(key) ?? 0) + 1;
  seen.set(key, nth);
  if (failOn.get(key) === nth) return Promise.reject(new Error(`bd ${verb} exploded`));
  // bd reflects a write immediately, and this module re-reads what it wrote — the rollback before it
  // undoes a move, the next approval before it re-applies one. A board that answered with pre-write
  // state would make those guards untestable.
  if (verb === "reparent") setLive(args[0] as string, { parent: args[1] || undefined });
  if (verb === "close") setLive(args[0] as string, { status: "closed" });
  onWrite?.(call);
  return Promise.resolve("");
}

/** What the next `bd show` of this bead answers with — the board as the writes have left it. */
function setLive(id: string, patch: Partial<Bead>): void {
  const current = liveBeads.get(id) ?? snapshot.find((b) => b.id === id);
  if (current) liveBeads.set(id, { ...current, ...patch });
}

/**
 * The board a `bd list` taken under the write lock answers with: the snapshot with every
 * {@link liveBeads} override applied, INCLUDING ids the snapshot never carried — which is how a test
 * stages work another approval attached mid-apply.
 */
function liveBoard(): Bead[] {
  const merged = new Map(snapshot.map((b) => [b.id, b]));
  for (const [id, live] of liveBeads) {
    if (live) merged.set(id, live);
    else merged.delete(id);
  }
  return [...merged.values()];
}

/** The board `applyProposal` was handed — what the under-lock re-read sees unless a test overrides it. */
let snapshot: Bead[] = [];

/**
 * A `bd list` that answers by the FLAGS it was given, when a test needs one — the way to stage a bd
 * that rejects `--status all`. Unset, every listing answers with the whole {@link liveBoard}.
 */
let listByFlags: ((extra: string[]) => Promise<Bead[]>) | undefined;

vi.mock("../beads/bd", async () => {
  const actual = await vi.importActual<typeof import("../beads/bd")>("../beads/bd");
  return {
    ...actual,
    beads: {
      ...actual.beads,
      // Reads stay out of `calls`: what matters is which WRITE hit which bead.
      show: (_cwd: string, id: string) => {
        const live = liveBeads.has(id) ? liveBeads.get(id) : snapshot.find((b) => b.id === id);
        return live ? Promise.resolve(live) : Promise.reject(new Error(`bd show: no such issue ${id}`));
      },
      list: (_cwd: string, extra: string[] = []) =>
        listByFlags ? listByFlags(extra) : Promise.resolve(liveBoard()),
      reparent: (_cwd: string, id: string, parent: string) => record("reparent", id, parent),
      link: (_cwd: string, a: string, b: string, type: string) => record("link", a, b, type),
      close: (_cwd: string, id: string, reason?: string) => record("close", id, reason ?? ""),
      supersede: (_cwd: string, id: string, w: string) => record("supersede", id, w),
      defer: (_cwd: string, id: string) => record("defer", id),
      note: (_cwd: string, id: string, text: string) => record("note", id, text),
    },
  };
});

const { ProposalApplyError, applyProposal, declineNote, planApply } = await import("./apply");

const REPO = "/tmp/gardener-apply";

/**
 * Apply against `board`, with that same board answering the under-lock re-read of every subject —
 * i.e. nothing changed between the decision and the writes. A test that wants something to change
 * primes {@link liveBeads} for the bead it wants to move under the apply.
 */
function apply(proposal: Bead, board: Bead[]) {
  snapshot = board;
  return applyProposal(REPO, proposal, board);
}

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

/** A bead waiting on `blocker`, carried the way `bd list --json` carries a blocks edge. */
function blockedBy(id: string, blocker: string, extra: Partial<Bead> = {}): Bead {
  return {
    ...bead(id, extra),
    dependencies: [{ issue_id: id, depends_on_id: blocker, type: "blocks" }],
  };
}

/** A closed bead the board records as superseded by `survivor` — the edge `bd supersede` writes. */
function supersededBy(id: string, survivor: string, extra: Partial<Bead> = {}): Bead {
  return {
    ...bead(id, { status: "closed", ...extra }),
    dependencies: [{ issue_id: id, depends_on_id: survivor, type: "supersedes" }],
  };
}

/** The `anton-a`/`anton-b` pair with ONE blocks edge between them: `from` waits on `to`. */
const edged = (from: string, to: string): Bead[] =>
  ["anton-a", "anton-b"].map((id) => (id === from ? blockedBy(id, to) : bead(id)));

/**
 * A plan fingerprinted the way the emitter would fingerprint it — through the SAME key builder, not
 * a copy of it, because apply now recomputes that hash from the plan's own fields and a fixture with
 * a hand-rolled fingerprint would prove the opposite of what these tests claim.
 */
function planFor(input: Omit<GardenerPlan, "fingerprint">): GardenerPlan {
  return {
    ...input,
    fingerprint: gardenerFingerprint(
      input.kind,
      detectionSubjectKey(input.kind, input.subjects, input.target),
    ),
  };
}

/**
 * The proposal bead as the board hands it back: fingerprint label + the plan as metadata, filed at
 * {@link FILED}. The filing stamp is not decoration — it is what dates a claim or an edit as "since
 * we asked", so a proposal without one fails those checks closed.
 */
function proposalFor(plan: GardenerPlan, extra: Partial<Bead> = {}): Bead {
  return bead("anton-p1", {
    title: "Gardener: do the thing",
    labels: [plan.fingerprint, "domain:eng", "source:gardener"],
    metadata: { gardener: plan },
    created_at: FILED,
    ...extra,
  });
}

/** The moment every decision below is judged at — only the run-lease checks read it. */
const NOW = Date.parse("2026-08-03T00:00:00Z");

/** When the proposals below were FILED: the board their evidence describes is a month old. */
const FILED = "2026-07-01T00:00:00Z";

/**
 * A bead nobody has written to in over a year — what a `stale` proposal's subject still has to look
 * like at approve time, and old enough that any claim on it long predates {@link FILED}.
 */
const cold = (id: string, extra: Partial<Bead> = {}): Bead =>
  bead(id, { updated_at: "2025-01-01T00:00:00Z", ...extra });

/** Its opposite: a bead written SINCE {@link FILED} — a change the approver was never shown. */
const warm = (id: string, extra: Partial<Bead> = {}): Bead =>
  bead(id, { updated_at: "2026-07-15T00:00:00Z", ...extra });

/**
 * A {@link LINK} subject still carrying the `discovered-from` edge its proposal read. An
 * `implied-order` ask rests on nothing but that edge or a body phrase, so apply re-derives it from
 * the board — a bead the board no longer places after its blocker is a proposal whose only evidence
 * somebody removed.
 */
const ordered = (base: Bead = bead("anton-a")): Bead => ({
  ...base,
  dependencies: [
    ...(base.dependencies ?? []),
    { issue_id: base.id, depends_on_id: "anton-b", type: "discovered-from" },
  ],
});

/**
 * The landed twin a {@link SUPERSEDE} points at, untouched since the filing like its subject: the
 * contents match is symmetric, so the survivor's own edits falsify it too.
 */
const landed = (extra: Partial<Bead> = {}): Bead =>
  cold("anton-b", { status: "closed", ...extra });

/**
 * Decide against a fixture board the way the route does: now, against a proposal filed a month ago.
 * A test that needs a different pair of moments calls `planApply` itself.
 */
const decide = (plan: GardenerPlan, board: Bead[], nowMs: number = NOW) =>
  planApply(plan, board, { nowMs, observedAtMs: Date.parse(FILED) });

/** A bead a run owns right now: an unexpired lease, dated relative to `at`. */
const leased = (id: string, at: number): Bead =>
  bead(id, { assignee: "runner-1", labels: [LABELS.runLease(at + 60_000, "run-9")] });

/** The other half of the same bar (board-index `isInFlight`): a run whose PR is up. */
const inReview = (id: string): Bead => bead(id, { labels: ["stage:in-review"] });

/** A feature card with an open ticket under it — a legal re-parent home. */
const CARD = bead("anton-card", { issue_type: "feature" });

/**
 * The run target a retirement subject can ride as a TICKET. A grouped run publishes ONE lease, on
 * this bead — its tickets carry no liveness signal of their own — so this is where "a run is already
 * under way over that work" is readable at all.
 */
const runCard = (extra: Partial<Bead> = {}): Bead =>
  bead("anton-run", { issue_type: "feature", ...extra });

/** The subject as a ticket of {@link runCard}, untouched since the filing like every retirement's. */
const ticket = (extra: Partial<Bead> = {}): Bead =>
  child("anton-a", "anton-run", { updated_at: "2025-01-01T00:00:00Z", ...extra });

/** The three retirement plans against one subject, with the board each needs. */
const retirements = (board: Bead[]): [GardenerPlan, Bead[]][] => [
  [DEFER, board],
  [CLOSE, board],
  [SUPERSEDE, [...board, landed()]],
];

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
  liveBeads.clear();
  onWrite = undefined;
  snapshot = [];
  listByFlags = undefined;
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

describe("planApply — what an approval means against the board as it now is", () => {
  it("re-parents every subject that isn't already home, remembering the parent to undo to", () => {
    const board = [CARD, child("anton-a", "anton-container"), bead("anton-b")];
    const decision = decide(CLUSTER, board);

    expect(decision).toEqual({
      status: "apply",
      summary: "re-parented anton-a, anton-b under anton-card",
      steps: [
        // `claim`/`parentClaim` empty — neither end of the move is owned by a run, which is the
        // pair the write re-checks under the locks it takes on both.
        {
          verb: "reparent",
          id: "anton-a",
          claim: "",
          parent: "anton-card",
          undoParent: "anton-container",
          parentClaim: "",
        },
        // A parentless subject undoes to bd's detach form, not to some invented parent.
        {
          verb: "reparent",
          id: "anton-b",
          claim: "",
          parent: "anton-card",
          undoParent: "",
          parentClaim: "",
        },
      ],
    });
  });

  it("settles a re-parent the board already reads as applied, rather than writing again", () => {
    const board = [CARD, child("anton-a", CARD.id)];
    expect(decide(REPARENT, board)).toEqual({
      status: "settled",
      summary: "anton-a already sits under anton-card",
    });
  });

  it("records the blocks edge in the direction the detection states", () => {
    const board = [ordered(), bead("anton-b")];
    expect(decide(LINK, board)).toEqual({
      status: "apply",
      summary: "recorded that anton-b blocks anton-a",
      steps: [{ verb: "link", id: "anton-a", claim: "", blocker: "anton-b" }],
    });
  });

  it("settles a link whose edge already runs the way the proposal states", () => {
    expect(decide(LINK, edged("anton-a", "anton-b"))).toEqual({
      status: "settled",
      summary: "a blocks edge already records anton-b → anton-a",
    });
  });

  // The REVERSE edge is somebody's recorded decision that the ordering runs the other way — never
  // something to overwrite, and never something to close this proposal over: settling would file a
  // summary claiming an edge (`anton-b → anton-a`) the board does not hold.
  it("refuses a link the board already records in the opposite direction", () => {
    const decision = decide(LINK, edged("anton-b", "anton-a"));
    expect(decision).toMatchObject({ status: "refuse" });
    expect(decision.status === "refuse" && decision.reason).toMatch(
      /opposite ordering — anton-a blocks anton-b/,
    );
  });

  // bd rejects a blocking cycle at every write path, so an edge that closes one can only ever be
  // approved into a 500 — leaving an open proposal that will never apply. The DIRECT reverse pair is
  // caught above; this is the transitive case, where the pair looks unrelated.
  it("refuses a link that would close a dependency cycle through other beads", () => {
    // anton-b waits on anton-c, which waits on anton-a — so "anton-b blocks anton-a" closes the loop.
    const board = [
      ordered(),
      blockedBy("anton-b", "anton-c"),
      blockedBy("anton-c", "anton-a"),
    ];
    const decision = decide(LINK, board);
    expect(decision).toMatchObject({ status: "refuse" });
    expect(decision.status === "refuse" && decision.reason).toMatch(
      /anton-b is already blocked by anton-a through other beads/,
    );
  });

  it("still records an edge whose chain runs the other way — that is an ordering, not a cycle", () => {
    // anton-a already waits on anton-c: adding anton-b as another of its blockers closes nothing.
    const board = [ordered(blockedBy("anton-a", "anton-c")), bead("anton-b"), bead("anton-c")];
    expect(decide(LINK, board).status).toBe("apply");
  });

  it("maps each retirement to ITS OWN verb — close, defer and supersede are not interchangeable", () => {
    expect(decide(CLOSE, [cold("anton-a")])).toMatchObject({
      status: "apply",
      steps: [{ verb: "close", id: "anton-a" }],
    });
    expect(decide(DEFER, [cold("anton-a")])).toMatchObject({
      status: "apply",
      steps: [{ verb: "defer", id: "anton-a" }],
    });
    expect(decide(SUPERSEDE, [cold("anton-a"), landed()])).toMatchObject({
      status: "apply",
      steps: [{ verb: "supersede", id: "anton-a", replacement: "anton-b" }],
    });
  });

  it("settles a retirement the board already carried out, however it was carried out", () => {
    expect(decide(CLOSE, [bead("anton-a", { status: "closed" })]).status).toBe("settled");
    expect(decide(DEFER, [bead("anton-a", { status: "deferred" })]).status).toBe("settled");
    // Even half-abandoned (the state a crashed abandon leaves): closing it would read as shipped.
    expect(
      decide(CLOSE, [bead("anton-a", { labels: [LABELS.abandoned] })]),
    ).toEqual({ status: "settled", summary: "anton-a is already abandoned" });
  });

  // A supersede's outcome is narrower than "the subject settled": it is the POINTER at where the
  // work landed. A subject closed by any other means since the filing carries no such edge, so
  // closing the proposal as answered would claim a record the board never got.
  it("settles a supersede only where the board records the edge, and refuses where it does not", () => {
    const survivor = bead("anton-b", { status: "closed" });
    expect(decide(SUPERSEDE, [supersededBy("anton-a", "anton-b"), survivor])).toEqual({
      status: "settled",
      summary: "anton-a is already superseded by anton-b",
    });

    const byHand = decide(SUPERSEDE, [bead("anton-a", { status: "closed" }), survivor]);
    expect(byHand).toMatchObject({ status: "refuse" });
    expect(byHand.status === "refuse" && byHand.reason).toMatch(
      /nothing on the board records it as superseded by anton-b/,
    );
    // An abandoned subject is the same gap: a won't-do says nothing about where work landed.
    const abandoned = bead("anton-a", { labels: [LABELS.abandoned], status: "closed" });
    expect(decide(SUPERSEDE, [abandoned, survivor])).toMatchObject({ status: "refuse" });
    // …and an edge pointing at some OTHER bead is not this proposal's answer either.
    expect(
      decide(SUPERSEDE, [supersededBy("anton-a", "anton-c"), survivor]),
    ).toMatchObject({ status: "refuse" });
  });

  describe("refusals — every one of them writes nothing at all", () => {
    const refusal = (decision: ReturnType<typeof planApply>): string => {
      expect(decision.status).toBe("refuse");
      return decision.status === "refuse" ? decision.reason : "";
    };

    it("refuses when a bead the plan names has left the board", () => {
      expect(refusal(decide(REPARENT, [CARD]))).toMatch(/anton-a is no longer on the board/);
      expect(refusal(decide(REPARENT, [bead("anton-a")]))).toMatch(/anton-card is no longer/);
    });

    it("refuses to move a subject that settled since the proposal was filed", () => {
      const board = [CARD, bead("anton-a", { status: "closed" })];
      expect(refusal(decide(REPARENT, board))).toMatch(/anton-a is closed/);
      const abandoned = [CARD, bead("anton-a", { labels: [LABELS.abandoned], status: "closed" })];
      expect(refusal(decide(REPARENT, abandoned))).toMatch(/anton-a is abandoned/);
    });

    it("refuses a home that is not a board card — the state the proposal exists to fix", () => {
      // An epic WITH a feature child is a container: work parented to it rides no card.
      const container = bead("anton-card", { issue_type: "epic" });
      const board = [container, child("anton-f", container.id, { issue_type: "feature" }), bead("anton-a")];
      expect(refusal(decide(REPARENT, board))).toMatch(/not a board card/);
    });

    // The home is written to as surely as the subject is, just indirectly: a run that has already
    // selected its tickets would never dispatch the newcomers, and settles the card out from under
    // them when it finishes.
    it("refuses a home a run owns — the subjects would strand under a card about to settle", () => {
      for (const live of [{ ...leased(CARD.id, NOW), issue_type: "feature" }, { ...inReview(CARD.id), issue_type: "feature" }]) {
        expect(refusal(decide(REPARENT, [live, bead("anton-a")], NOW))).toMatch(
          /anton-card is mid-run .* hanging more work under it/,
        );
      }
    });

    it("refuses a re-parent that would make a subtree its own ancestor", () => {
      const board = [child(CARD.id, "anton-a", { issue_type: "feature" }), bead("anton-a")];
      expect(refusal(decide(REPARENT, board))).toMatch(/its own ancestor/);
    });

    it("refuses a proposal that names no home — it asks a human to choose one", () => {
      const homeless = planFor({ kind: "container-orphan", move: "reparent", subjects: ["anton-a"] });
      expect(refusal(decide(homeless, [bead("anton-a")]))).toMatch(/names no new parent/);
    });

    it("refuses an ordering edge once the blocker has landed", () => {
      const board = [bead("anton-a"), bead("anton-b", { status: "closed" })];
      expect(refusal(decide(LINK, board))).toMatch(/anton-b is closed/);
    });

    it("refuses to supersede when the survivor is open again — nothing landed over there", () => {
      const board = [cold("anton-a"), bead("anton-b")];
      expect(refusal(decide(SUPERSEDE, board))).toMatch(/has not landed/);
    });

    // Abandoned is `closed` PLUS a label, so a status check alone reads a recorded won't-do as
    // delivered work — and retires the last live copy of it in favour of a bead nobody will finish.
    it("refuses to supersede onto an ABANDONED survivor — closed, but nothing was delivered", () => {
      const dropped = bead("anton-b", { labels: [LABELS.abandoned], status: "closed" });
      expect(refusal(decide(SUPERSEDE, [cold("anton-a"), dropped]))).toMatch(
        /anton-b is abandoned — a recorded won't-do delivered nothing/,
      );
    });

    // Settling a run target with work still under it is how an approval could CREATE the very state
    // the gardener exists to flag: tickets left beneath a card no run will ever reach.
    it("refuses to close or supersede a bead that still has open work under it, at any depth", () => {
      const feature = cold("anton-a", { issue_type: "feature" });
      const survivor = bead("anton-b", { status: "closed" });
      const shipped = child("anton-t1", "anton-a", { status: "closed" });
      const buried = child("anton-t2", "anton-t1");

      const board = [feature, survivor, shipped, buried];
      expect(refusal(decide(CLOSE, board))).toMatch(/still has open work under it \(anton-t2\)/);
      expect(refusal(decide(SUPERSEDE, board))).toMatch(/anton-t2/);
    });

    it("closes a bead whose whole subtree has settled", () => {
      const board = [
        cold("anton-a", { issue_type: "feature" }),
        child("anton-t1", "anton-a", { status: "closed" }),
        child("anton-t2", "anton-a", { labels: [LABELS.abandoned], status: "closed" }),
      ];
      expect(decide(CLOSE, board).status).toBe("apply");
    });

    // Deferring is the reversible half: the subtree parks with its contract intact and reopening the
    // parent undoes it, so open children are not a reason to refuse.
    it("defers a bead with open children rather than refusing", () => {
      const board = [cold("anton-a", { issue_type: "feature" }), child("anton-t1", "anton-a")];
      expect(decide(DEFER, board).status).toBe("apply");
    });

    // The bar every detector proposes under (board-index `isInFlight`), re-checked HERE because the
    // run usually claims the bead AFTER the proposal was filed: approving last night's ask would
    // re-parent or retire work an agent is mid-flight over.
    it("refuses every move against a bead a run owns — live lease or open PR alike", () => {
      for (const live of [leased("anton-a", NOW), inReview("anton-a")]) {
        expect(refusal(decide(REPARENT, [CARD, live], NOW))).toMatch(/anton-a is mid-run/);
        expect(refusal(decide(CLUSTER, [CARD, live, bead("anton-b")], NOW))).toMatch(
          /anton-a is mid-run/,
        );
        expect(refusal(decide(LINK, [live, bead("anton-b")], NOW))).toMatch(/anton-a is mid-run/);
        expect(refusal(decide(DEFER, [live], NOW))).toMatch(/anton-a is mid-run/);
        expect(refusal(decide(CLOSE, [live], NOW))).toMatch(/anton-a is mid-run/);
        const survivor = bead("anton-b", { status: "closed" });
        expect(refusal(decide(SUPERSEDE, [live, survivor], NOW))).toMatch(/anton-a is mid-run/);
      }
    });

    it("names the run that owns it, so the operator knows what they are waiting on", () => {
      expect(refusal(decide(DEFER, [leased("anton-a", NOW)], NOW))).toMatch(
        /live lease on it \(runner-1\)/,
      );
      expect(refusal(decide(DEFER, [inReview("anton-a")], NOW))).toMatch(/it is in review/);
    });

    it("applies against an EXPIRED lease — a crashed run owns nothing", () => {
      const dead = cold("anton-a", { labels: [LABELS.runLease(NOW - 1, "run-9")] });
      expect(decide(DEFER, [dead], NOW).status).toBe("apply");
    });

    // The other half of that bar, and the half a per-bead signal cannot answer: a grouped run's
    // lease lives on the CARD its tickets hang under, so a ticket that run has selected but not yet
    // reached reads as free work. Retiring it takes a bead out of a live run's ticket set, and the
    // run aborts when its claim reaches a bead the board no longer holds.
    it("refuses to retire a ticket of a card a run is executing, at any depth", () => {
      for (const live of [
        runCard({ labels: [LABELS.runLease(NOW + 60_000, "run-9")] }),
        runCard({ labels: ["stage:in-review"] }),
      ]) {
        for (const [plan, board] of retirements([live, ticket()])) {
          expect(refusal(decide(plan, board, NOW))).toMatch(
            /anton-run is mid-run .* retiring anton-a out of its ticket set/,
          );
        }
        // Nesting is arbitrary-depth: a subtask under a task ships in the same run as the task.
        const deep = [live, child("anton-mid", live.id), ticket({ parent: "anton-mid" })];
        expect(refusal(decide(DEFER, deep, NOW))).toMatch(/anton-run is mid-run/);
      }
    });

    it("retires a ticket of a card nothing is running", () => {
      for (const [plan, board] of retirements([runCard(), ticket()])) {
        expect(decide(plan, board, NOW).status).toBe("apply");
      }
      // An expired lease is a crashed run: it holds no ticket set either.
      const dead = runCard({ labels: [LABELS.runLease(NOW - 1, "run-9")] });
      expect(decide(DEFER, [dead, ticket()], NOW).status).toBe("apply");
    });

    it("still SETTLES a mid-run bead the board already retired — there is nothing to write", () => {
      const done = { ...leased("anton-a", NOW), status: "deferred" };
      expect(decide(DEFER, [done], NOW).status).toBe("settled");
    });
  });

  // The filing→approval window, which the in-flight bar and the under-lock re-check both miss: the
  // first because the signals it reads can be absent for a bead a run owns, the second because it
  // compares against the approval's own snapshot, which is already downstream of the change.
  describe("what moved between the filing and the approval — a premise, not just a safety bar", () => {
    const reason = (decision: ReturnType<typeof planApply>): string => {
      expect(decision.status).toBe("refuse");
      return decision.status === "refuse" ? decision.reason : "";
    };

    // `bd --claim` writes the assignee and in_progress as one act and publishes the run-lease a
    // moment later; a grouped run's tickets never carry a lease of their own at all — it lives on
    // the target they hang under. So a bead a run owns can read as free to every liveness signal,
    // and the only thing separating it from the dead claim a retirement is usually about is WHEN
    // the claim was taken.
    it("refuses every move against a subject claimed since the filing, lease or no lease", () => {
      const claimed = warm("anton-a", { assignee: "runner-7", status: "in_progress" });
      expect(reason(decide(DEFER, [claimed]))).toMatch(/is held by runner-7/);
      expect(reason(decide(CLOSE, [claimed]))).toMatch(/retiring it would pull the bead out/);
      expect(reason(decide(LINK, [claimed, bead("anton-b")]))).toMatch(/recording it as blocked/);
      expect(reason(decide(REPARENT, [CARD, claimed]))).toMatch(/moving it would pull the bead/);
    });

    // The stale-in-progress detector proposes against claimed beads on purpose — a claim that
    // outlived its run IS the finding — so the claim the proposal was made about is not news.
    it("applies against the claim the proposal was made about", () => {
      const outlived = cold("anton-a", { assignee: "runner-7", status: "in_progress" });
      expect(decide(DEFER, [outlived]).status).toBe("apply");
    });

    // Fails closed both ways: without two stamps nothing shows the claim predates the ask.
    it("refuses a claim nothing can date against the filing", () => {
      const undated = bead("anton-a", { assignee: "runner-7", status: "in_progress" });
      expect(reason(decide(DEFER, [undated]))).toMatch(/nothing dates that claim/);

      const unfiled = planApply(DEFER, [cold("anton-a", { status: "in_progress" })], {
        nowMs: NOW,
        observedAtMs: undefined,
      });
      expect(reason(unfiled)).toMatch(/nothing dates that claim/);
    });

    // The HOME's half of the same window, and the one the step's `parentClaim` baseline rests on: a
    // target claimed after the filing reads as free to every liveness signal, so approving would
    // record that newcomer's claim as the step's own baseline — and the under-lock re-check, which
    // compares against exactly that value, would then wave the move through and hang the tickets
    // under a run that has already chosen what it will work through.
    const heldHome = (make: (id: string, extra: Partial<Bead>) => Bead): Bead =>
      make("anton-card", { issue_type: "feature", assignee: "runner-7", status: "in_progress" });

    it("refuses to hang work under a home claimed since the filing", () => {
      const home = heldHome(warm);
      expect(reason(decide(REPARENT, [home, cold("anton-a")]))).toMatch(
        /anton-card is held by runner-7 and it was claimed since this proposal was filed/,
      );
      expect(reason(decide(CLUSTER, [home, cold("anton-a"), cold("anton-b")]))).toMatch(
        /riding along unrun/,
      );
    });

    // Same rule as the subject's: the claim the plan was made against is not news, and a home whose
    // claim predates the filing is the one `parentClaim` legitimately carries forward.
    it("applies under a home whose claim the proposal was made against", () => {
      expect(decide(REPARENT, [heldHome(cold), cold("anton-a")]).status).toBe("apply");
    });

    it("refuses a home claim nothing can date against the filing", () => {
      expect(reason(decide(REPARENT, [heldHome(bead), cold("anton-a")]))).toMatch(
        /nothing dates that claim/,
      );
    });

    // Approving would record that newer card as the step's own `undoParent` and write straight over
    // it — and the under-lock re-check, which compares against exactly that value, cannot object.
    it("refuses to re-home a subject somebody has already given a card", () => {
      const other = bead("anton-other", { issue_type: "feature" });
      const rehomed = child("anton-a", other.id);
      expect(reason(decide(REPARENT, [CARD, other, rehomed]))).toMatch(
        /now rides board card anton-other/,
      );
      expect(reason(decide(CLUSTER, [CARD, other, rehomed, bead("anton-b")]))).toMatch(
        /now rides board card anton-other/,
      );
    });

    // A move under another CONTAINER leaves the bead exactly as unreachable as the proposal says,
    // so it is still the fix rather than a decision to preserve.
    it("still re-homes a subject moved under something that is not a card", () => {
      expect(decide(REPARENT, [CARD, child("anton-a", "anton-container")]).status).toBe("apply");
    });

    // An `implied-order` ask rests on ONE piece of evidence — a body phrase or a discovered-from
    // edge — and nothing downstream re-derives it: the step carries only the pair, and the
    // under-lock re-check asks whether the beads are writable, never whether the ordering is still
    // stated. Removing the evidence is a newer decision than the proposal, so drawing the edge
    // anyway would take the blocked bead back out of the ready set that edit put it in.
    it("refuses a link whose implied ordering the board no longer states", () => {
      expect(reason(decide(LINK, [bead("anton-a"), bead("anton-b")]))).toMatch(
        /nothing on the board still places anton-a after anton-b/,
      );
    });

    it("applies a link the board still implies, by provenance or by prose", () => {
      expect(decide(LINK, [ordered(), bead("anton-b")]).status).toBe("apply");

      // The other signal, read through the detector's own scanner: a body that still spells the
      // ordering out in words.
      const spelled = planFor({
        kind: "implied-order",
        move: "link",
        subjects: ["anton-aaa"],
        target: "anton-bbb",
      });
      const board = [
        bead("anton-aaa", { description: "blocked on anton-bbb" }),
        bead("anton-bbb"),
      ];
      expect(decide(spelled, board).status).toBe("apply");
    });

    // A `stale` proposal's whole premise is silence — a claim about the moment the patrol looked,
    // which no fresh board read can restate. An edit, a re-prioritisation or a fresh pickup since
    // makes the bead no longer the untouched one the ask describes.
    it("refuses a stale retirement whose subject has been written to since the filing", () => {
      expect(reason(decide(DEFER, [warm("anton-a")]))).toMatch(/written to since this proposal/);
      expect(reason(decide(DEFER, [bead("anton-a")]))).toMatch(/no write stamp/);
    });

    // Silence that held at filing has only lengthened, so an untouched bead still applies.
    it("applies a stale retirement to a bead nobody has touched since", () => {
      expect(decide(DEFER, [cold("anton-a")]).status).toBe("apply");
    });

    // The ticket owner's half of the same window: a run that picked the CARD up after the filing has
    // already selected the tickets it will work through, and neither the card nor the ticket carries
    // a lease yet for the in-flight bar to read.
    it("refuses to retire a ticket of a card claimed since the filing", () => {
      const held = runCard({ assignee: "runner-7", status: "in_progress" });
      const since = { ...held, updated_at: "2026-07-15T00:00:00Z" };
      for (const [plan, board] of retirements([since, ticket()])) {
        expect(reason(decide(plan, board))).toMatch(
          /anton-run is held by runner-7 and it was claimed since this proposal was filed — retiring anton-a out of its ticket set/,
        );
      }
      // Fails closed with nothing to date the claim against, exactly like the subject's own.
      const undated = { ...held, updated_at: undefined, created_at: undefined };
      expect(reason(decide(DEFER, [undated, ticket()]))).toMatch(/nothing dates that claim/);
    });

    // A claim the plan was made against is the finding, not news — the same rule the subject and a
    // re-parent's home are held to, and what lets a dead run's stale ticket be retired at all.
    it("retires a ticket of a card whose claim the proposal was made against", () => {
      const outlived = runCard({
        assignee: "runner-7",
        status: "in_progress",
        updated_at: "2025-01-01T00:00:00Z",
      });
      expect(decide(DEFER, [outlived, ticket()]).status).toBe("apply");
    });

    // bd stamps at one-second resolution, so a stamp EQUAL to the filing second orders nothing: the
    // write may have landed either side of it. Reading it as "the board the patrol judged" would let
    // a claim taken in that second be recorded as the step's own baseline and compared against
    // itself under the lock — the one place nothing else re-asks the question.
    it("treats a stamp in the filing's own second as ambiguous, not as the board it judged", () => {
      const claimed = bead("anton-a", {
        assignee: "runner-7",
        status: "in_progress",
        updated_at: FILED,
      });
      expect(reason(decide(DEFER, [claimed]))).toMatch(/nothing dates that claim/);
      expect(reason(decide(CLOSE, [claimed]))).toMatch(/nothing dates that claim/);

      const home = { ...heldHome(bead), updated_at: FILED };
      expect(reason(decide(REPARENT, [home, cold("anton-a")]))).toMatch(/nothing dates that claim/);

      // And a `stale` subject's silence is unprovable in that second for the same reason.
      expect(reason(decide(DEFER, [bead("anton-a", { updated_at: FILED })]))).toMatch(
        /nothing confirms it is still the untouched bead/,
      );
    });

    // Every retirement measured something about the bead's CONTENTS at patrol time, and an edit
    // since is exactly what invalidates it: a supersede's twin match no longer holds if the subject
    // was rescoped, and a shipped-orphan's commit — immutable itself — says nothing about work added
    // to the bead after it landed. Settling either would lose that work silently; refusing is loud.
    it("holds every retirement kind to the subject its evidence describes", () => {
      expect(reason(decide(CLOSE, [warm("anton-a")]))).toMatch(
        /no longer the bead the commit behind this ask shipped/,
      );
      expect(reason(decide(SUPERSEDE, [warm("anton-a"), bead("anton-b", { status: "closed" })]))).toMatch(
        /no longer the bead whose contents matched the twin this supersede points at/,
      );
      // …and fails closed on a subject nothing can date against the filing, like `stale` does.
      expect(reason(decide(CLOSE, [bead("anton-a")]))).toMatch(/no write stamp/);
    });

    // The twin match is symmetric, and the SURVIVOR's end is the one nothing else notices: it stays
    // closed and non-abandoned however far its contents drift, so `survivorUnusable` still reads it
    // as landed work. Superseding onto a twin that no longer holds the work would retire the only
    // copy of it the board still has open.
    it("holds a supersede to the twin its evidence describes, not just the subject", () => {
      expect(
        reason(decide(SUPERSEDE, [cold("anton-a"), warm("anton-b", { status: "closed" })])),
      ).toMatch(/anton-b has been written to since this proposal was filed — it is no longer the landed twin/);
      // …and fails closed on a survivor nothing can date against the filing, like the subject does.
      expect(
        reason(decide(SUPERSEDE, [cold("anton-a"), bead("anton-b", { status: "closed" })])),
      ).toMatch(/anton-b carries no write stamp/);
    });

    // Silence, a twin match and a shipping commit all still stand over a bead nobody has written to.
    it("applies every retirement kind to a subject untouched since the filing", () => {
      for (const [plan, board] of retirements([cold("anton-a")])) {
        expect(decide(plan, board).status).toBe("apply");
      }
    });
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

  // Every topology re-check treats a board read it could not make as a refusal, so on a bd without
  // `--status all` a sound approval would refuse forever. The read goes through `loadAllIssues`,
  // which falls back to merging the open and closed listings.
  it("applies against a bd whose `list --status all` is unsupported", async () => {
    const proposal = proposalFor(REPARENT);
    listByFlags = async (extra) => {
      if (extra.includes("all")) throw new Error("unknown value for --status: all");
      const live = liveBoard();
      return extra.includes("closed")
        ? live.filter((b) => b.status === "closed")
        : live.filter((b) => b.status !== "closed");
    };

    const result = await apply(proposal, [CARD, bead("anton-a"), proposal]);

    expect(result.changed).toEqual(["anton-a"]);
    expect(calls[0]).toBe("reparent anton-a anton-card");
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
    snapshot = board; // the winner's close lands on this board, and is what the loser then reads

    const [winner, loser] = await Promise.allSettled([
      applyProposal(REPO, proposal, board),
      applyProposal(REPO, proposal, board),
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

  // The other half of the same staleness: the bead a step points AT. A run claiming the HOME between
  // the snapshot and the write has already selected its tickets, so subjects attached now ride along
  // unrun and strand when that run settles the card.
  it("refuses a home a run claimed AFTER the snapshot, without moving a subject", async () => {
    const proposal = proposalFor(REPARENT);
    liveBeads.set(CARD.id, { ...leased(CARD.id, Date.now()), issue_type: "feature" });

    await expect(apply(proposal, [CARD, bead("anton-a"), proposal])).rejects.toMatchObject({
      failure: "refused",
    });
    expect(calls).toEqual([
      `note ${proposal.id} gardener: apply FAILED — cannot apply ${proposal.id}: anton-card is mid-run — a run holds a live lease on it (runner-1), so hanging more work under it would race the run that owns it`,
    ]);
  });

  // The home's half of the window `isInFlight` cannot see: `bd --claim` writes assignee +
  // in_progress and publishes the lease a moment later, and a run that got that far has already
  // selected its tickets — so a subject attached now rides along unrun and strands when that run
  // settles the card. A claim the PLAN itself saw is not news and still applies — but only one the
  // filing stamp can DATE as older than the ask, which is what keeps the baseline honest.
  it("refuses a home claimed after the snapshot, before its run-lease is published", async () => {
    const held = { issue_type: "feature" as const, assignee: "runner-7", status: "in_progress" };
    const proposal = proposalFor(REPARENT);
    liveBeads.set(CARD.id, bead(CARD.id, held));

    await expect(apply(proposal, [CARD, bead("anton-a"), proposal])).rejects.toMatchObject({
      failure: "refused",
    });
    expect(calls).toEqual([
      `note ${proposal.id} gardener: apply FAILED — cannot apply ${proposal.id}: anton-card was claimed by runner-7 since this proposal was decided — that run has already selected the tickets it will work through, so work hung under it now would ride along unrun`,
    ]);

    calls.length = 0;
    liveBeads.clear();
    const sawItClaimed = cold(CARD.id, held);
    liveBeads.set(CARD.id, sawItClaimed);
    const again = proposalFor(REPARENT);
    await expect(apply(again, [sawItClaimed, bead("anton-a"), again])).resolves.toMatchObject({
      changed: ["anton-a"],
    });
    expect(calls[0]).toBe("reparent anton-a anton-card");
  });

  // Card attribution is board-wide, but the write that revokes it takes THIS lock: a legacy epic
  // stops being a card the instant a feature lands under it, and hanging one there is a re-parent
  // whose home is this same epic. Left with the snapshot, both approvals pass and the subject ends
  // up directly under a container epic — riding no card, which is the state the proposal fixes.
  it("refuses a home that stopped being a board card since the snapshot", async () => {
    const epic = bead("anton-epic", { issue_type: "epic" });
    const plan = planFor({
      kind: "container-orphan",
      move: "reparent",
      subjects: ["anton-a"],
      target: epic.id,
    });
    const proposal = proposalFor(plan);
    // Another approval hangs a feature under the epic between the snapshot and this write.
    liveBeads.set("anton-f1", child("anton-f1", epic.id, { issue_type: "feature" }));

    await expect(apply(proposal, [epic, bead("anton-a"), proposal])).rejects.toMatchObject({
      failure: "refused",
    });
    expect(calls).toEqual([
      `note ${proposal.id} gardener: apply FAILED — cannot apply ${proposal.id}: anton-epic is no longer a board card — re-parenting under it would leave the work riding no card, which is the state this proposal is about`,
    ]);
  });

  it("refuses a blocker that landed, and a survivor that reopened, under the write lock", async () => {
    const link = proposalFor(LINK);
    liveBeads.set("anton-b", bead("anton-b", { status: "closed" }));
    await expect(
      apply(link, [ordered(), bead("anton-b"), link]),
    ).rejects.toMatchObject({ failure: "refused" });
    expect(calls).toEqual([
      `note ${link.id} gardener: apply FAILED — cannot apply ${link.id}: anton-b is closed — the work anton-a was waiting on has landed, so the edge would only make anton-a read as blocked forever`,
    ]);

    calls.length = 0;
    liveBeads.clear();
    const supersede = proposalFor(SUPERSEDE);
    // The snapshot says the survivor landed; by the time the write runs it is open again.
    liveBeads.set("anton-b", bead("anton-b", { status: "open" }));
    await expect(
      apply(supersede, [cold("anton-a"), landed(), supersede]),
    ).rejects.toMatchObject({ failure: "refused" });
    expect(calls).toEqual([
      `note ${supersede.id} gardener: apply FAILED — cannot apply ${supersede.id}: anton-b is open again — it has not landed, so anton-a is not superseded by it`,
    ]);
  });

  // A survivor abandoned in the window between the proposal and the approval stays `closed`, so the
  // status alone still reads as "the work landed over there". It did not: superseding onto it would
  // retire the last live copy of the work in favour of a recorded won't-do.
  it("refuses a survivor abandoned since the snapshot, under the write lock", async () => {
    const supersede = proposalFor(SUPERSEDE);
    liveBeads.set("anton-b", bead("anton-b", { labels: [LABELS.abandoned], status: "closed" }));

    await expect(
      apply(supersede, [cold("anton-a"), landed(), supersede]),
    ).rejects.toMatchObject({ failure: "refused" });
    expect(calls).toEqual([
      `note ${supersede.id} gardener: apply FAILED — cannot apply ${supersede.id}: anton-b is abandoned — a recorded won't-do delivered nothing, so anton-a is not superseded by it`,
    ]);
  });

  // Every retirement rests on a claim about the subject's CONTENTS, and an edit that rescopes the
  // work leaves status, liveness, claim and topology exactly as the plan found them — so nothing
  // else under the lock notices. The filing-time check ran against the route's snapshot, which is
  // already stale when the first write spawns; the step carries the fence forward so the locked
  // re-read asks it again.
  it("refuses a retirement whose subject was rewritten after the snapshot", async () => {
    for (const [plan, still] of [
      [DEFER, "the untouched bead the ask describes"],
      [CLOSE, "the bead the commit behind this ask shipped"],
    ] as const) {
      calls.length = 0;
      liveBeads.clear();
      const proposal = proposalFor(plan);
      liveBeads.set("anton-a", warm("anton-a"));

      await expect(apply(proposal, [cold("anton-a"), proposal])).rejects.toMatchObject({
        failure: "refused",
      });
      expect(calls).toEqual([
        `note ${proposal.id} gardener: apply FAILED — cannot apply ${proposal.id}: anton-a has been written to since this proposal was filed — it is no longer ${still}, and ${plan === DEFER ? "deferring it now would park work somebody has since picked back up" : "closing it as shipped now would record a landing for work that may have been rescoped since"}`,
      ]);
    }
  });

  // The survivor's end of the same premise. It stays `closed` and non-abandoned however far its
  // contents drift, so `survivorUnusable` waves it through — and superseding onto a twin that no
  // longer holds the work would close the last live copy of it.
  it("refuses a supersede whose survivor was rewritten after the snapshot", async () => {
    const proposal = proposalFor(SUPERSEDE);
    liveBeads.set("anton-b", warm("anton-b", { status: "closed" }));

    await expect(
      apply(proposal, [cold("anton-a"), landed(), proposal]),
    ).rejects.toMatchObject({ failure: "refused" });
    expect(calls).toEqual([
      `note ${proposal.id} gardener: apply FAILED — cannot apply ${proposal.id}: anton-b has been written to since this proposal was filed — it is no longer the landed twin whose contents this bead matched, and superseding onto it now could retire the only copy of that work still open`,
    ]);
  });

  // A re-parent is the one verb whose subject can move without changing status, so the status checks
  // above see nothing: another approval or an operator re-homing it is a NEWER decision than this
  // plan, and applying over it would silently undo their move.
  it("refuses a subject another write has re-parented since the plan was made", async () => {
    const proposal = proposalFor(REPARENT);
    liveBeads.set("anton-a", child("anton-a", "anton-elsewhere"));

    await expect(
      apply(proposal, [CARD, child("anton-a", "anton-old"), proposal]),
    ).rejects.toMatchObject({ failure: "refused" });
    expect(calls).toEqual([
      `note ${proposal.id} gardener: apply FAILED — cannot apply ${proposal.id}: anton-a now sits under anton-elsewhere rather than anton-old — it was re-parented since this proposal was filed, and moving it to anton-card would overwrite that`,
    ]);
  });

  // Two approvals whose snapshots each say the card is empty: a re-parent attaching work under it
  // takes the SAME lock this settle holds, so re-reading the subtree under that lock is what orders
  // them. Without it the newcomer is left beneath a card no run will ever reach.
  it("refuses to settle a bead that gained open work under it since the snapshot", async () => {
    const proposal = proposalFor(CLOSE);
    liveBeads.set("anton-t9", child("anton-t9", "anton-a"));

    await expect(
      apply(proposal, [cold("anton-a", { issue_type: "feature" }), proposal]),
    ).rejects.toMatchObject({ failure: "refused" });
    expect(calls).toEqual([
      `note ${proposal.id} gardener: apply FAILED — cannot apply ${proposal.id}: anton-a has open work under it (anton-t9) since this proposal was filed — settling it would strand that work beneath a card nothing will run`,
    ]);
  });

  it("settles a bead whose subtree is all closed, on the board as the lock reads it", async () => {
    const proposal = proposalFor(CLOSE);
    const board = [
      cold("anton-a", { issue_type: "feature" }),
      child("anton-t1", "anton-a", { status: "closed" }),
      proposal,
    ];

    const result = await apply(proposal, board);

    expect(result.changed).toEqual(["anton-a"]);
    expect(calls[0]).toBe("close anton-a closed by an approved gardener proposal (shipped-orphan)");
  });

  // A rollback must undo THIS apply's move, not whatever the bead's parent happens to be now: a
  // concurrent approval of a different proposal can move the same subject between the per-step
  // locks, and restoring the old parent over it would clobber a move that is now the board's truth.
  it("leaves a rolled-back subject alone when another write has since moved it", async () => {
    const proposal = proposalFor(CLUSTER);
    const board = [CARD, child("anton-a", "anton-old"), bead("anton-b"), proposal];
    failOn.set("reparent:anton-b", 1);
    // Somebody else re-parents anton-a the moment this apply moves on to anton-b.
    onWrite = (call) => {
      if (call === "reparent anton-a anton-card") setLive("anton-a", { parent: "anton-elsewhere" });
    };

    await expect(apply(proposal, board)).rejects.toThrow(/another write has since moved/);

    // No second write to anton-a: its undo would have fought the move that overtook it.
    expect(calls.filter((c) => c.startsWith("reparent anton-a"))).toEqual([
      "reparent anton-a anton-card",
    ]);
    expect(calls.some((c) => c.startsWith(`close ${proposal.id}`))).toBe(false);
  });

  // A cluster member somebody else has already moved to the target is accepted as idempotent — the
  // same move, so refusing would fail the whole cluster over an agreement. But it is not OUR write,
  // and a later member failing must not restore `undoParent` over the other writer's move.
  it("never rolls back a member the board already satisfied — that write was not ours", async () => {
    const proposal = proposalFor(CLUSTER);
    const board = [CARD, child("anton-a", "anton-old"), bead("anton-b"), proposal];
    // Another approval lands anton-a's move between the snapshot and this apply's per-step lock.
    liveBeads.set("anton-a", child("anton-a", CARD.id));
    failOn.set("reparent:anton-b", 1);

    await expect(apply(proposal, board)).rejects.toThrow(/nothing had been written/);

    // Neither a redundant re-write nor — the bug — an undo back to anton-old.
    expect(calls.filter((c) => c.startsWith("reparent anton-a"))).toEqual([]);
    expect(calls.some((c) => c.startsWith(`close ${proposal.id}`))).toBe(false);
  });

  it("reports only the members it actually wrote to", async () => {
    const proposal = proposalFor(CLUSTER);
    liveBeads.set("anton-a", child("anton-a", CARD.id));

    const result = await apply(proposal, [CARD, bead("anton-a"), bead("anton-b"), proposal]);

    expect(result.changed).toEqual(["anton-b"]);
    expect(calls.filter((c) => c.startsWith("reparent"))).toEqual(["reparent anton-b anton-card"]);
  });

  it("refuses a subject a run claimed AFTER the snapshot, without writing to it", async () => {
    const proposal = proposalFor(DEFER);
    liveBeads.set("anton-a", leased("anton-a", Date.now()));

    await expect(apply(proposal, [cold("anton-a"), proposal])).rejects.toMatchObject({
      failure: "refused",
    });
    // The snapshot said "open and unclaimed"; the locked read said otherwise, and nothing was written.
    expect(calls).toEqual([
      `note ${proposal.id} gardener: apply FAILED — cannot apply ${proposal.id}: anton-a is mid-run — a run holds a live lease on it (runner-1), so retiring it would race the run that owns it`,
    ]);
  });

  // The lease is published a moment AFTER the assignee and in_progress that `bd --claim` writes as
  // one act, so for that window a freshly claimed bead reads as unowned work to the in-flight bar.
  // A pickup queues on the same per-bead chain this apply locks, which is what makes the window
  // closable at all: take the claim protocol's lock and then ignore what the claim wrote, and the
  // move lands on work a runner has already started.
  it("refuses a subject claimed after the snapshot, before its run-lease is published", async () => {
    const proposal = proposalFor(DEFER);
    liveBeads.set("anton-a", bead("anton-a", { assignee: "runner-7", status: "in_progress" }));

    await expect(apply(proposal, [cold("anton-a"), proposal])).rejects.toMatchObject({
      failure: "refused",
    });
    expect(calls).toEqual([
      `note ${proposal.id} gardener: apply FAILED — cannot apply ${proposal.id}: anton-a was claimed by runner-7 since this proposal was decided — retiring it would pull the bead out from under the run that now owns it`,
    ]);
  });

  // A retirement's subject can be a TICKET of a run target, and that target is where a run becomes
  // visible at all. A run picks it up on the very per-bead chain this apply locks, so the claim
  // either lands before this read or queues behind the write — and refusing here is what makes that
  // ordering worth anything. The run's own post-lease re-confirmation (execute-epic step 1c) closes
  // the other side.
  it("refuses to retire a ticket of a card a run claimed AFTER the snapshot", async () => {
    const proposal = proposalFor(DEFER);
    liveBeads.set("anton-run", runCard({ assignee: "runner-7", status: "in_progress" }));

    await expect(apply(proposal, [runCard(), ticket(), proposal])).rejects.toMatchObject({
      failure: "refused",
    });
    expect(calls).toEqual([
      `note ${proposal.id} gardener: apply FAILED — cannot apply ${proposal.id}: anton-run was claimed by runner-7 since this proposal was decided — that run has already selected the tickets it will work through, so retiring anton-a out of its ticket set would abort it when its claim reaches a bead the board no longer holds`,
    ]);
  });

  it("refuses to retire a ticket of a card whose run published its lease after the snapshot", async () => {
    const proposal = proposalFor(DEFER);
    liveBeads.set("anton-run", runCard({ labels: [LABELS.runLease(Date.now() + 60_000, "run-9")] }));

    await expect(apply(proposal, [runCard(), ticket(), proposal])).rejects.toMatchObject({
      failure: "refused",
    });
    expect(calls.some((c) => c.startsWith("defer"))).toBe(false);
    expect(calls[0]).toMatch(/anton-run is mid-run .* retiring anton-a out of its ticket set/);
  });

  // The owner is captured from the SNAPSHOT, so re-reading it only answers "has that card started".
  // A re-parent approval landing in the window puts the subject under a different run target — one
  // this step never locked and never re-reads — and retiring it there aborts a run this approval
  // never looked at. The re-parent takes the subject's own lock, so the two orders are serialized.
  it("refuses to retire a subject moved onto another card's ticket set since the snapshot", async () => {
    const other = bead("anton-other", { issue_type: "feature" });
    for (const plan of [DEFER, CLOSE]) {
      calls.length = 0;
      liveBeads.clear();
      const proposal = proposalFor(plan);
      liveBeads.set("anton-a", { ...ticket(), parent: other.id });

      await expect(
        apply(proposal, [runCard(), ticket(), other, proposal]),
      ).rejects.toMatchObject({ failure: "refused" });
      expect(calls).toEqual([
        `note ${proposal.id} gardener: apply FAILED — cannot apply ${proposal.id}: anton-a now rides anton-other's ticket set rather than anton-run's ticket set — the run target it hangs under changed since this proposal was decided, so retiring anton-a out of its ticket set would act on a ticket set this approval never looked at`,
      ]);
    }
  });

  // The same gap from the other side: a subject that rode NO ticket set when the plan was made, and
  // has since been hung under a card. Nothing on the step names an owner at all, so there is no
  // re-read to catch it — only re-deriving ownership under the lock does.
  it("refuses to retire a subject given a ticket set it did not have at decision time", async () => {
    const proposal = proposalFor(DEFER);
    liveBeads.set("anton-a", { ...cold("anton-a"), parent: "anton-run" });

    await expect(
      apply(proposal, [runCard(), cold("anton-a"), proposal]),
    ).rejects.toMatchObject({ failure: "refused" });
    expect(calls[0]).toMatch(/anton-a now rides anton-run's ticket set rather than no ticket set/);
    expect(calls.some((c) => c.startsWith("defer"))).toBe(false);
  });

  // The card is not written to, so a run that RELEASED it since — or held it all along, which is
  // what a stale ticket under a dead run looks like — is no reason to refuse.
  it("retires a ticket of a card no run holds under the lock", async () => {
    const proposal = proposalFor(DEFER);
    liveBeads.set("anton-run", runCard());

    const held = runCard({
      assignee: "runner-7",
      status: "in_progress",
      updated_at: "2025-01-01T00:00:00Z",
    });
    await expect(apply(proposal, [held, ticket(), proposal])).resolves.toMatchObject({
      changed: ["anton-a"],
    });
    expect(calls[0]).toBe("defer anton-a");
  });

  // The stale-in-progress detector proposes against beads that are ALREADY claimed — a claim that
  // outlived its run is the whole finding. Refusing on the claim the plan itself was decided against
  // would make that proposal permanently unapprovable.
  // Both live reads stay `cold`: the locked re-read re-asks the retirement's PREMISE too, and a
  // subject with no write stamp — or one dated since the filing — refuses on that instead, which
  // would prove nothing about the claim baseline this case is here for.
  it("applies to a bead whose claim the plan already saw, and to one released since", async () => {
    for (const live of [
      cold("anton-a", { assignee: "runner-7", status: "in_progress" }),
      cold("anton-a", { status: "open" }),
    ]) {
      calls.length = 0;
      liveBeads.clear();
      liveBeads.set("anton-a", live);
      const proposal = proposalFor(DEFER);
      const claimed = cold("anton-a", { assignee: "runner-7", status: "in_progress" });

      await expect(apply(proposal, [claimed, proposal])).resolves.toMatchObject({
        changed: ["anton-a"],
      });
      expect(calls[0]).toBe("defer anton-a");
    }
  });

  it("refuses a subject that settled after the snapshot, per verb", async () => {
    for (const [plan, gone] of [
      [REPARENT, bead("anton-a", { status: "closed" })],
      [LINK, bead("anton-a", { labels: [LABELS.abandoned], status: "closed" })],
      [CLOSE, undefined], // left the board entirely
    ] as const) {
      calls.length = 0;
      liveBeads.clear();
      liveBeads.set("anton-a", gone);
      const proposal = proposalFor(plan);
      await expect(
        apply(proposal, [CARD, bead("anton-a"), bead("anton-b"), proposal]),
      ).rejects.toMatchObject({ failure: "refused" });
      expect(calls.filter((c) => !c.startsWith("note"))).toEqual([]);
    }
  });

  // A cluster that loses its second subject mid-apply is a PARTIAL application, not a clean refusal:
  // the prefix has to come back out, and the proposal has to stay open saying so.
  it("rolls back the prefix when a later subject moves under the apply", async () => {
    const proposal = proposalFor(CLUSTER);
    liveBeads.set("anton-b", leased("anton-b", Date.now()));

    await expect(
      apply(proposal, [CARD, child("anton-a", "anton-old"), bead("anton-b"), proposal]),
    ).rejects.toMatchObject({ failure: "failed" });

    expect(calls).toEqual([
      "reparent anton-a anton-card",
      "reparent anton-a anton-old", // undone, back to where it was
      `note ${proposal.id} gardener: apply FAILED — applying ${proposal.id} failed: anton-b is mid-run — a run holds a live lease on it (runner-1), so moving it would race the run that owns it — the 1 write(s) already made were rolled back, so the board is unchanged`,
    ]);
    expect(calls.some((c) => c.startsWith(`close ${proposal.id}`))).toBe(false);
  });

  it("rolls back a half-applied cluster and leaves the proposal OPEN with the error attached", async () => {
    const proposal = proposalFor(CLUSTER);
    const board = [CARD, child("anton-a", "anton-old"), bead("anton-b"), proposal];
    failOn.set("reparent:anton-b", 1);

    await expect(apply(proposal, board)).rejects.toThrow(/rolled back/);

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

    await expect(apply(proposal, board)).rejects.toThrow(/ROLLBACK INCOMPLETE/);
    expect(calls.some((c) => c.startsWith(`close ${proposal.id}`))).toBe(false);
  });

  // The ownership read is what tells a rollback the step is still ours to undo. When it FAILS it
  // proves nothing — and restoring blind would overwrite a newer move with no trace that it happened,
  // so the step is named for a human instead.
  it("strands a rolled-back subject whose ownership read fails, rather than restoring blind", async () => {
    const proposal = proposalFor(CLUSTER);
    const board = [CARD, child("anton-a", "anton-old"), bead("anton-b"), proposal];
    failOn.set("reparent:anton-b", 1);
    // anton-a becomes unreadable the moment its move lands, so the rollback can't prove it owns it.
    onWrite = (call) => {
      if (call === "reparent anton-a anton-card") liveBeads.set("anton-a", undefined);
    };

    await expect(apply(proposal, board)).rejects.toThrow(
      /ROLLBACK INCOMPLETE: anton-a could not be restored/,
    );

    // One write to anton-a: the move. No blind restore behind an unreadable board.
    expect(calls.filter((c) => c.startsWith("reparent anton-a"))).toEqual([
      "reparent anton-a anton-card",
    ]);
    expect(calls.some((c) => c.startsWith(`close ${proposal.id}`))).toBe(false);
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
    await expect(apply(plain, [plain])).rejects.toThrow(/not a gardener proposal/);

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
