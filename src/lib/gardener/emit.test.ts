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

vi.mock("../beads/bd", async () => {
  const actual = await vi.importActual<typeof import("../beads/bd")>("../beads/bd");
  return {
    ...actual,
    beads: { ...actual.beads, create: (...a: [string, Record<string, unknown>]) => createMock(...a) },
  };
});

const {
  MAX_PROPOSALS_PER_PASS,
  PROPOSAL_LABELS,
  PartialEmissionError,
  emitProposals,
  planEmission,
  proposalDraft,
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
  createMock.mockClear();
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

  it("writes nothing on a quiet board", async () => {
    const quiet = [bead("anton-f", { issue_type: "feature" }), bead("anton-t", { parent: "anton-f" })];
    const result = await emitProposals(REPO, { board: quiet, detections: detect(quiet) });
    expect(result).toEqual({ created: [], suppressed: 0, deferred: 0 });
    expect(createMock).not.toHaveBeenCalled();
  });
});
