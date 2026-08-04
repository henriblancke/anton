/**
 * Proposal emission (anton-9qwq), over fixture boards with the bd seam's `create` stubbed.
 *
 * Three claims are worth a test here, because each is a way emission could do harm:
 *   • ASK ONCE. A nightly patrol over a board nobody has fixed must file one proposal, not thirty —
 *     so the same fixture is emitted twice and the second pass writes nothing.
 *   • DECLINED STAYS DECLINED. A human's "no" is the one answer the patrol must not re-litigate.
 *   • A PROPOSAL IS A BEAD. It is judged by the SAME contract validator the approve route and the
 *     board render through, not by a bespoke assertion about its markdown — a proposal the board
 *     shows as unshaped is a proposal nobody can act on.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { LABELS, type Bead } from "../beads/bd";
import { contractGaps } from "../beads/contract";
import { parseAcceptance, parseGoal, toStandaloneItem } from "../ticket-view";
import { detectBoard } from "./detect";
import {
  concernedBeads,
  makeDetection,
  proposalPlanOf,
  type DetectionInput,
  type GardenerDetection,
} from "./detections";
import type { HygieneFinding } from "../hygiene";

/** Every proposal this pass filed, as the bead bd would hand back on the next board read. */
const createdBeads: Bead[] = [];
const createMock = vi.fn(async (_cwd: string, opts: Record<string, unknown>) => {
  const id = `anton-p${createdBeads.length + 1}`;
  createdBeads.push({
    id,
    title: opts.title as string,
    status: "open",
    issue_type: opts.type as string,
    labels: opts.labels as string[],
    description: opts.description as string,
    acceptance_criteria: opts.acceptance as string,
  });
  return id;
});

/**
 * What a locked re-read hands back, per bead id — the reconciliation cases drive this to make a twin
 * change under the lock (approved, claimed, already settled) between the snapshot and the fold.
 */
const liveBeads = new Map<string, Bead>();
const showMock = vi.fn(async (_cwd: string, id: string) => {
  const live = liveBeads.get(id);
  if (!live) throw new Error(`no such bead: ${id}`);
  return live;
});
const closeMock = vi.fn(async (...args: [string, string, string?]) => {
  // Reflected into the live map so a folded twin reads as settled to anything that looks again.
  const [, id] = args;
  const live = liveBeads.get(id);
  if (live) liveBeads.set(id, { ...live, status: "closed" });
  return "";
});
const abandonMock = vi.fn(async () => "");

vi.mock("../beads/bd", async () => {
  const actual = await vi.importActual<typeof import("../beads/bd")>("../beads/bd");
  return {
    ...actual,
    beads: {
      ...actual.beads,
      create: (...a: [string, Record<string, unknown>]) => createMock(...a),
      show: (...a: [string, string]) => showMock(...a),
      close: (...a: [string, string, string?]) => closeMock(...a),
      abandon: () => abandonMock(),
    },
  };
});

const {
  MAX_PROPOSALS_PER_PASS,
  PROPOSAL_LABELS,
  PartialEmissionError,
  emitProposals,
  planEmission,
  planReconciliation,
  proposalDraft,
  reconcileDuplicateProposals,
  suppressedFingerprints,
} = await import("./emit");

const REPO = "/tmp/gardener-repo";
const NOW = Date.parse("2026-08-03T00:00:00Z");
const daysAgo = (days: number) => new Date(NOW - days * 86_400_000).toISOString();

const bead = (id: string, over: Partial<Bead> = {}): Bead => ({
  id,
  title: id,
  status: "open",
  issue_type: "task",
  updated_at: daysAgo(1),
  ...over,
});

/** The misparented-ticket fixture from the feature's Verify — one container epic, one lost task. */
const MISPARENTED: Bead[] = [
  bead("anton-cont", { issue_type: "epic", title: "Container epic" }),
  bead("anton-feat", { issue_type: "feature", title: "The runnable feature", parent: "anton-cont" }),
  bead("anton-lost", { title: "Loose ticket", parent: "anton-cont" }),
];

const detect = (board: Bead[], findings: HygieneFinding[] = []): GardenerDetection[] =>
  detectBoard({ board, hygiene: { findings }, now: NOW });

const reparent = (over: Partial<DetectionInput> = {}) =>
  makeDetection({
    kind: "container-orphan",
    move: "reparent",
    subjects: ["anton-lost"],
    target: "anton-feat",
    summary: "anton-lost rides no board card — re-parent it under anton-feat",
    evidence: ["anton-cont is a container epic", "anton-lost has no board-card ancestor"],
    ...over,
  });

/** A proposal bead carrying `fingerprint`, in whatever lifecycle state the case is about. */
const proposal = (fingerprint: string, over: Partial<Bead> = {}): Bead =>
  bead("anton-prop", { labels: [fingerprint, ...PROPOSAL_LABELS], ...over });

beforeEach(() => {
  createdBeads.length = 0;
  liveBeads.clear();
  createMock.mockClear();
  showMock.mockClear();
  closeMock.mockClear();
  abandonMock.mockClear();
});

describe("the proposal bead", () => {
  it("carries the full ticket contract, so the board renders it like any other bead", () => {
    const detection = reparent();
    const draft = proposalDraft(detection);

    const asBoardSees: Bead = {
      id: "anton-prop",
      title: draft.title,
      status: "open",
      issue_type: draft.type,
      labels: draft.labels,
      description: draft.description,
      acceptance_criteria: draft.acceptance,
    };

    // The validator both gates and the board read through — not a bespoke markdown assertion.
    expect(contractGaps([asBoardSees], "blocking")).toEqual([]);
    expect(contractGaps([asBoardSees], "advisory")).toEqual([]);
    expect(parseGoal(asBoardSees)).toContain("anton-lost");
    expect(parseAcceptance(asBoardSees)).toContain("- [ ]");

    // Parentless task ⇒ a standalone chip on the board, unapproved until a human says so.
    const chip = toStandaloneItem(asBoardSees);
    expect(chip.type).toBe("task");
    expect(chip.stage).toBe("backlog");
    expect(chip.approved).toBe(false);
  });

  it("carries its fingerprint, its provenance labels, and the evidence behind the claim", () => {
    const detection = reparent();
    const draft = proposalDraft(detection);

    expect(draft.labels).toContain(detection.fingerprint);
    expect(draft.labels).toEqual(expect.arrayContaining([...PROPOSAL_LABELS]));
    // No agent: a proposal is a decision, not work an agent implements.
    expect(draft.labels.some((l) => l.startsWith("agent:"))).toBe(false);
    for (const line of detection.evidence) expect(draft.description).toContain(line);
    expect(draft.description).toContain(detection.fingerprint);
  });

  it("carries its MOVE as metadata, so applying it never has to parse the prose (anton-1t3n)", () => {
    const detection = reparent();
    const draft = proposalDraft(detection);

    // The bead as the next board read hands it back: label + metadata, both written by this create.
    const asBoardSees: Bead = {
      id: "anton-prop",
      title: draft.title,
      status: "open",
      issue_type: draft.type,
      labels: draft.labels,
      metadata: draft.metadata,
    };
    expect(proposalPlanOf(asBoardSees)).toEqual({
      kind: detection.kind,
      move: detection.move,
      fingerprint: detection.fingerprint,
      subjects: detection.subjects,
      target: detection.target,
    });
    // A plan whose fingerprint disagrees with the bead's own label is not this bead's plan.
    expect(proposalPlanOf({ ...asBoardSees, labels: ["gardener:stale:0123456789ab"] })).toBeUndefined();
  });

  // Apply dates every "has this moved since we asked" check against this stamp. It has to be the
  // snapshot's moment rather than the bead's `created_at`, because a pass reads the board once and
  // then files up to ten proposals through sequential writes — a subject edited in that window is a
  // change the detection never saw, and `created_at` would date it as already-observed.
  it("carries the moment its evidence describes, which is not when the bead was written", () => {
    const observedAtMs = Date.parse("2026-08-01T09:30:00Z");
    expect(proposalDraft(reparent(), observedAtMs).metadata).toMatchObject({
      gardenerObservedAt: "2026-08-01T09:30:00.000Z",
    });
    // Absent rather than null when a caller names no snapshot — apply falls back to `created_at`.
    expect(proposalDraft(reparent()).metadata).not.toHaveProperty("gardenerObservedAt");
  });

  it("hangs a discovered-from edge off EVERY bead the move concerns, not just the one it acts on", () => {
    const draft = proposalDraft(reparent());
    expect(concernedBeads(reparent())).toEqual(["anton-feat", "anton-lost"]);
    expect(draft.deps).toEqual(["discovered-from:anton-feat", "discovered-from:anton-lost"]);
  });

  it("states the applied board state per move, so each rubric is checkable on its own", () => {
    expect(proposalDraft(reparent()).acceptance).toContain("anton-lost is parented to anton-feat");

    const link = makeDetection({
      kind: "implied-order",
      move: "link",
      subjects: ["anton-b"],
      target: "anton-a",
      summary: "ordering stated in prose, never edged",
      evidence: ["the body says anton-b comes after anton-a"],
    });
    expect(proposalDraft(link).acceptance).toContain("blocks edge records anton-a → anton-b");

    const defer = makeDetection({
      kind: "stale",
      move: "retire",
      retireAs: "defer",
      subjects: ["anton-old"],
      summary: "untouched for 200 days",
      evidence: ["last written 200 days ago"],
    });
    expect(proposalDraft(defer).title).toBe("Gardener: defer anton-old");
    expect(proposalDraft(defer).acceptance).toContain("anton-old is deferred");

    const supersede = makeDetection({
      kind: "superseded",
      move: "retire",
      retireAs: "supersede",
      subjects: ["anton-dup"],
      target: "anton-kept",
      summary: "anton-dup is superseded by anton-kept",
      evidence: ["identical content"],
    });
    expect(proposalDraft(supersede).acceptance).toContain("superseded by anton-kept");
  });

  // A container orphan with no single obvious home files without a target on purpose, and apply
  // refuses every targetless re-parent — so the bead must not read as one an approval can settle.
  it("tells a proposal that names no home to be applied by hand and DECLINED, not approved", () => {
    const homeless = reparent({ target: undefined });
    const draft = proposalDraft(homeless);

    expect(draft.description).toContain("Approve is refused");
    expect(draft.description).toContain("bd update <id> --parent <card>");
    expect(draft.description).not.toContain("approving it applies the move");
    expect(draft.acceptance).toContain("DECLINED");
  });
});

describe("dedup by fingerprint", () => {
  const detection = reparent();

  it("suppresses a fingerprint an OPEN proposal already carries", () => {
    const board = [...MISPARENTED, proposal(detection.fingerprint)];
    expect([...suppressedFingerprints(board)]).toEqual([detection.fingerprint]);

    const plan = planEmission({ detections: [detection], board });
    expect(plan.emit).toEqual([]);
    expect(plan.suppressed).toEqual([detection]);
  });

  it("suppresses a DECLINED fingerprint — a human's no is not re-litigated", () => {
    const declined = proposal(detection.fingerprint, {
      status: "closed",
      labels: [detection.fingerprint, ...PROPOSAL_LABELS, LABELS.abandoned],
    });
    const plan = planEmission({ detections: [detection], board: [...MISPARENTED, declined] });
    expect(plan.emit).toEqual([]);
    expect(plan.suppressed).toEqual([detection]);
  });

  it("does NOT suppress an APPLIED proposal — a plain close means the move landed", () => {
    // If the shape is still wrong after the move was applied, the board really did regress, and the
    // patrol saying so again is the honest answer.
    const applied = proposal(detection.fingerprint, { status: "closed" });
    const plan = planEmission({ detections: [detection], board: [...MISPARENTED, applied] });
    expect(plan.emit).toEqual([detection]);
  });

  it("ignores a label that only looks like a fingerprint", () => {
    const mislabelled = bead("anton-x", { labels: ["gardener:some-note", "gardener"] });
    expect(suppressedFingerprints([mislabelled]).size).toBe(0);
  });

  it("collapses two detections that reached the same claim", () => {
    const plan = planEmission({ detections: [detection, reparent()], board: MISPARENTED });
    expect(plan.emit).toHaveLength(1);
  });

  it("defers the overflow past the per-pass cap instead of dropping it", () => {
    const many = Array.from({ length: MAX_PROPOSALS_PER_PASS + 3 }, (_, i) =>
      reparent({ subjects: [`anton-lost${i}`] }),
    );
    const plan = planEmission({ detections: many, board: MISPARENTED });
    expect(plan.emit).toHaveLength(MAX_PROPOSALS_PER_PASS);
    expect(plan.deferred).toHaveLength(3);
    expect([...plan.emit, ...plan.deferred]).toEqual(many);
  });
});

/**
 * Suppression is only atomic within ONE patrol: it checks a local working set the other machine's
 * proposal has not synced into yet, and no cross-process lock exists to serialize the check with the
 * create. So the same claim can reach the board twice, and folding the twins afterwards is the only
 * thing that ever undoes it.
 */
describe("duplicate proposals from overlapping patrols", () => {
  const fingerprint = reparent().fingerprint;

  const twin = (id: string, over: Partial<Bead> = {}): Bead =>
    bead(id, { labels: [fingerprint, ...PROPOSAL_LABELS], ...over });

  const approved = (id: string) =>
    twin(id, { labels: [fingerprint, ...PROPOSAL_LABELS, LABELS.approved] });

  /** Put these on the board AND behind the locked re-read every fold takes. */
  const onBoard = (...board: Bead[]): Bead[] => {
    for (const b of board) liveBeads.set(b.id, b);
    return board;
  };

  it("folds the later ask into the first, deterministically on every machine", () => {
    // Ordered by id, not by board order: two patrols reconciling the same board concurrently must
    // pick the same survivor, or they fold each other away and no ask survives.
    expect(planReconciliation([twin("anton-p2"), twin("anton-p1")])).toEqual([
      { fingerprint, keep: "anton-p1", fold: ["anton-p2"], held: [] },
    ]);
  });

  it("keeps the twin a human approved, however late it was filed", () => {
    const [duplicate] = planReconciliation([twin("anton-p1"), approved("anton-p2")]);
    expect(duplicate.keep).toBe("anton-p2");
    expect(duplicate.fold).toEqual(["anton-p1"]);
  });

  it("keeps the twin a run is applying rather than closing it mid-flight", () => {
    const claimed = twin("anton-p2", { status: "in_progress", assignee: "runner-1" });
    const [duplicate] = planReconciliation([twin("anton-p1"), claimed]);
    expect(duplicate.keep).toBe("anton-p2");
    expect(duplicate.fold).toEqual(["anton-p1"]);
  });

  it("leaves a second APPROVED twin standing — folding one discards a decision", () => {
    const [duplicate] = planReconciliation([approved("anton-p1"), approved("anton-p2")]);
    expect(duplicate.fold).toEqual([]);
    expect(duplicate.held).toEqual(["anton-p2"]);
  });

  it("sees no duplicate in a settled twin: only OPEN asks stand on the board", () => {
    const declined = twin("anton-p2", {
      status: "closed",
      labels: [fingerprint, ...PROPOSAL_LABELS, LABELS.abandoned],
    });
    expect(planReconciliation([twin("anton-p1"), declined])).toEqual([]);
    expect(planReconciliation([twin("anton-p1"), twin("anton-p2", { status: "closed" })])).toEqual([]);
  });

  it("closes the fold plainly, naming the survivor — never as abandoned", async () => {
    const board = onBoard(twin("anton-p1"), twin("anton-p2"));

    const result = await reconcileDuplicateProposals(REPO, board);

    expect(result.folded).toEqual([{ id: "anton-p2", into: "anton-p1" }]);
    expect(closeMock).toHaveBeenCalledTimes(1);
    const [, closedId, reason] = closeMock.mock.calls[0];
    expect(closedId).toBe("anton-p2");
    expect(reason).toContain("anton-p1");
    // Abandoning would read as "a human declined this claim" and suppress the fingerprint FOREVER —
    // the patrol would stop re-asking a question the survivor is still asking.
    expect(abandonMock).not.toHaveBeenCalled();
  });

  it("leaves the fingerprint suppressed by the survivor alone", () => {
    const folded = twin("anton-p2", { status: "closed" });
    expect(suppressedFingerprints([twin("anton-p1"), folded])).toEqual(new Set([fingerprint]));
    expect(suppressedFingerprints([folded]).size).toBe(0);
  });

  it("skips a twin approved under the lock — the snapshot is not what it writes against", async () => {
    const board = onBoard(twin("anton-p1"), twin("anton-p2"));
    liveBeads.set("anton-p2", approved("anton-p2")); // approved while this fold waited for the lock

    const result = await reconcileDuplicateProposals(REPO, board);

    expect(result.folded).toEqual([]);
    expect(closeMock).not.toHaveBeenCalled();
  });

  it("keeps the last ask standing when the survivor was deleted under the lock", async () => {
    const board = onBoard(twin("anton-p1"), twin("anton-p2"));
    liveBeads.delete("anton-p1"); // an operator deleted the survivor while this fold waited

    const result = await reconcileDuplicateProposals(REPO, board);

    // Folding here would close the only open twin as a duplicate of a bead that is no longer there,
    // leaving the claim with no standing ask at all until a later patrol re-derived it.
    expect(result.folded).toEqual([]);
    expect(closeMock).not.toHaveBeenCalled();
  });

  it("keeps the last ask standing when the survivor no longer carries the fingerprint", async () => {
    const board = onBoard(twin("anton-p1"), twin("anton-p2"));
    liveBeads.set("anton-p1", bead("anton-p1", { labels: [...PROPOSAL_LABELS] }));

    const result = await reconcileDuplicateProposals(REPO, board);

    expect(result.folded).toEqual([]);
    expect(closeMock).not.toHaveBeenCalled();
  });

  it("reports a fold that failed instead of costing the pass its proposals", async () => {
    const board = onBoard(twin("anton-p1"), twin("anton-p2"));
    closeMock.mockRejectedValueOnce(new Error("bd close exploded"));

    const result = await reconcileDuplicateProposals(REPO, board);

    expect(result.failed).toEqual(["anton-p2"]);
    expect(result.folded).toEqual([]);
  });

  it("stops folding when the patrol is cancelled", async () => {
    const board = onBoard(twin("anton-p1"), twin("anton-p2"));
    const controller = new AbortController();
    controller.abort();

    const result = await reconcileDuplicateProposals(REPO, board, controller.signal);

    expect(result.folded).toEqual([]);
    expect(closeMock).not.toHaveBeenCalled();
  });
});

describe("a patrol pass", () => {
  it("files one proposal for the misparented ticket, and files nothing the second time", async () => {
    const first = await emitProposals(REPO, { board: MISPARENTED, detections: detect(MISPARENTED) });
    expect(first.created).toHaveLength(1);
    expect(createMock).toHaveBeenCalledTimes(1);
    expect(createdBeads[0].title).toBe("Gardener: re-parent anton-lost under anton-feat");

    // The next patrol reads the board the first one wrote to — proposal included.
    const board = [...MISPARENTED, ...createdBeads];
    const second = await emitProposals(REPO, { board, detections: detect(board) });
    expect(second.created).toEqual([]);
    expect(second.suppressed).toBe(1);
    expect(createMock).toHaveBeenCalledTimes(1);
  });

  it("files nothing at all once the proposal is declined", async () => {
    const declined: Bead = {
      ...proposal(detect(MISPARENTED)[0].fingerprint),
      status: "closed",
      labels: [detect(MISPARENTED)[0].fingerprint, ...PROPOSAL_LABELS, LABELS.abandoned],
    };
    const board = [...MISPARENTED, declined];

    const result = await emitProposals(REPO, { board, detections: detect(board) });
    expect(result.created).toEqual([]);
    expect(result.suppressed).toBe(1);
    expect(createMock).not.toHaveBeenCalled();
  });

  it("never gardens its own proposals — they are beads about the board, not part of its shape", async () => {
    await emitProposals(REPO, { board: MISPARENTED, detections: detect(MISPARENTED) });
    const board = [...MISPARENTED, ...createdBeads];

    // Two parentless proposals sharing a topic would otherwise read as a cluster, and an old one as
    // a retirement candidate — the patrol proposing to garden itself.
    const stale: HygieneFinding[] = createdBeads.map((b) => ({
      kind: "stale-open" as const,
      key: `stale-open:${b.id}`,
      beadId: b.id,
      detail: "open and untouched for over 30 days",
    }));
    const aged = board.map((b) =>
      createdBeads.some((p) => p.id === b.id) ? { ...b, updated_at: daysAgo(400) } : b,
    );

    expect(detect(aged, stale).flatMap((d) => d.subjects)).not.toContain(createdBeads[0].id);
  });

  // The proposals a failed pass already filed are real board state, but only in the LOCAL working
  // set. Losing them with the error would leave the caller with nothing to propagate — and if the
  // failing create keeps failing, the job parks and no other machine ever sees them.
  it("hands back the proposals that DID land when a later create fails", async () => {
    const detections = [reparent(), reparent({ subjects: ["anton-other"] })];
    createMock.mockImplementationOnce(async () => "anton-p1").mockImplementationOnce(async () => {
      throw new Error("bd create exploded");
    });

    const error = await emitProposals(REPO, { board: MISPARENTED, detections }).catch((e) => e);

    expect(error).toBeInstanceOf(PartialEmissionError);
    expect(error.result.created.map((p: { id: string }) => p.id)).toEqual(["anton-p1"]);
    expect(error.message).toContain("bd create exploded");
  });

  // A cancel arriving after the first create must stop the rest of the pass. Checked only before the
  // loop, a cancelled patrol would still run every judgment-tier write it had planned.
  it("stops filing when a cancel arrives mid-pass, handing back what landed", async () => {
    const detections = [reparent(), reparent({ subjects: ["anton-b"] }), reparent({ subjects: ["anton-c"] })];
    const controller = new AbortController();
    createMock.mockImplementationOnce(async () => {
      controller.abort();
      return "anton-p1";
    });

    const error = await emitProposals(REPO, {
      board: MISPARENTED,
      detections,
      signal: controller.signal,
    }).catch((e) => e);

    expect(error).toBeInstanceOf(PartialEmissionError);
    expect(error.result.created.map((p: { id: string }) => p.id)).toEqual(["anton-p1"]);
    expect(createMock).toHaveBeenCalledTimes(1);
  });

  it("writes nothing on a quiet board", async () => {
    const quiet = [bead("anton-f", { issue_type: "feature" }), bead("anton-t", { parent: "anton-f" })];
    const result = await emitProposals(REPO, { board: quiet, detections: detect(quiet) });
    expect(result).toEqual({ created: [], suppressed: 0, deferred: 0 });
    expect(createMock).not.toHaveBeenCalled();
  });
});
