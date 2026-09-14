/**
 * The settled-proposal record (anton-m29g), derived from the board and from nothing else.
 *
 * Three claims carry it, and each is a way the record could invert the floor it feeds:
 *   • an abandoned proposal is a DECLINE — the founder's recorded won't-do;
 *   • a plain close is an APPLY — the move landed;
 *   • a FOLDED duplicate is NEITHER, because `reconcileDuplicateProposals` plainly closes twins on
 *     purpose. Counting a fold as an apply would score noise as success exactly when a detector is
 *     at its noisiest.
 *   • an ARMED kind's own apply is neither — anton wrote it and nobody was asked, so counting it
 *     would let an armed kind ratchet its own record to 100% and pin the floor open forever.
 * And the window ROLLS, so a rewritten detector is not judged by the record of the one it replaced.
 */
import { describe, expect, it } from "vitest";

import { LABELS, type Bead } from "../beads/bd";
import {
  EARNED_AUTONOMY_WINDOW,
  autonomyFor,
  earnedAutonomyOfKind,
  type ProposalAutonomyPolicy,
} from "./autonomy";
import {
  GARDENER_DETECTION_KINDS,
  KINDS,
  proposalFingerprint,
  type GardenerDetectionKind,
} from "./detections";
import { appliedCloseReason } from "./apply";
import { foldReason } from "./emit";
import { proposalTrackRecord } from "./track-record";

let seq = 0;

/** A proposal bead of `kind`, carrying a real fingerprint label — the record's only kind signal. */
function proposal(
  kind: GardenerDetectionKind,
  settled: "applied" | "declined" | "folded" | "armed" | "open",
  atMs = Date.UTC(2026, 0, 1) + seq * 86_400_000,
): Bead {
  seq += 1;
  const id = `anton-p${seq}`;
  const fingerprint = proposalFingerprint(kind, `${kind}:subject-${seq}`);
  const base: Bead = {
    id,
    title: `${kind} proposal`,
    status: "closed",
    issue_type: "task",
    labels: [fingerprint],
    closed_at: new Date(atMs).toISOString(),
  };
  if (settled === "open") return { ...base, status: "open", closed_at: undefined };
  if (settled === "declined") {
    return { ...base, labels: [fingerprint, LABELS.abandoned], close_reason: "abandoned: no" };
  }
  if (settled === "folded") {
    return { ...base, close_reason: foldReason("anton-keep", fingerprint) };
  }
  const summary = "re-parented anton-a under anton-b";
  return { ...base, close_reason: appliedCloseReason(summary, settled === "armed" ? "policy" : "approval") };
}

const ALL_APPLY: ProposalAutonomyPolicy = Object.fromEntries(
  GARDENER_DETECTION_KINDS.map((kind) => [kind, "apply"]),
) as ProposalAutonomyPolicy;

describe("proposalTrackRecord", () => {
  it("counts an abandoned proposal as a decline and a plain close as an apply", () => {
    const record = proposalTrackRecord([
      proposal("implied-order", "applied"),
      proposal("implied-order", "applied"),
      proposal("implied-order", "declined"),
    ]);
    expect(record["implied-order"]).toEqual({ settled: 3, applied: 2 });
  });

  it("does NOT count a folded duplicate as an applied proposal", () => {
    // The fold trap: `reconcileDuplicateProposals` closes twins PLAINLY so folding cannot poison the
    // survivor's fingerprint, so a naive plainly-closed = applied count scores every fold as a
    // success. Four duplicates of one claim would have read as four applies.
    const record = proposalTrackRecord([
      proposal("parentless-cluster", "applied"),
      proposal("parentless-cluster", "folded"),
      proposal("parentless-cluster", "folded"),
      proposal("parentless-cluster", "folded"),
      proposal("parentless-cluster", "folded"),
    ]);
    expect(record["parentless-cluster"]).toEqual({ settled: 1, applied: 1 });
  });

  it("does NOT count an armed kind's own unattended apply as a founder verdict", () => {
    // The ratchet: an armed kind closes its own proposals through the same `applyProposal` an
    // approval calls, so counting those would let it drive its record to 100% applied with nobody
    // asked — and the floor could never re-engage on a detector that regressed. Only the two the
    // founder actually decided survive here.
    const record = proposalTrackRecord([
      proposal("implied-order", "applied"),
      proposal("implied-order", "declined"),
      ...Array.from({ length: EARNED_AUTONOMY_WINDOW }, () => proposal("implied-order", "armed")),
    ]);
    expect(record["implied-order"]).toEqual({ settled: 2, applied: 1 });
    // And the ratchet is what that stops: 50% on two verdicts is below every bar.
    expect(earnedAutonomyOfKind("implied-order", record).eligible).toBe(false);
  });

  it("ignores proposals still standing — an open ask is a question nobody has answered", () => {
    const record = proposalTrackRecord([
      proposal("stale", "open"),
      proposal("stale", "open"),
      proposal("stale", "applied"),
    ]);
    expect(record.stale).toEqual({ settled: 1, applied: 1 });
  });

  it("ignores beads that are not proposals at all", () => {
    const ordinary: Bead = {
      id: "anton-work",
      title: "ordinary ticket",
      status: "closed",
      labels: ["approved", "domain:eng"],
    };
    const record = proposalTrackRecord([ordinary]);
    for (const kind of GARDENER_DETECTION_KINDS) {
      expect(record[kind]).toEqual({ settled: 0, applied: 0 });
    }
  });

  it("keeps every kind separate — one kind's record never speaks for its neighbour", () => {
    const record = proposalTrackRecord([
      proposal("implied-order", "applied"),
      proposal("missing-order", "declined"),
    ]);
    expect(record["implied-order"]).toEqual({ settled: 1, applied: 1 });
    expect(record["missing-order"]).toEqual({ settled: 1, applied: 0 });
    expect(record.misfiled).toEqual({ settled: 0, applied: 0 });
  });

  it("is total over the kinds — a kind with nothing settled is an explicit zero", () => {
    const record = proposalTrackRecord([]);
    expect(Object.keys(record).sort()).toEqual([...GARDENER_DETECTION_KINDS].sort());
  });

  it("rolls: settled proposals beyond the window do not hold a kind back", () => {
    // anton-9hpp rewrites `detectParentlessClusters`, and a rewritten detector's old record
    // describes a different algorithm. The window is what self-heals after the fix.
    const old = Array.from({ length: EARNED_AUTONOMY_WINDOW }, (_, i) =>
      proposal("implied-order", "declined", Date.UTC(2026, 0, 1) + i * 3_600_000),
    );
    const fresh = Array.from({ length: EARNED_AUTONOMY_WINDOW }, (_, i) =>
      proposal("implied-order", "applied", Date.UTC(2026, 5, 1) + i * 3_600_000),
    );

    const record = proposalTrackRecord([...old, ...fresh]);
    expect(record["implied-order"]).toEqual({
      settled: EARNED_AUTONOMY_WINDOW,
      applied: EARNED_AUTONOMY_WINDOW,
    });
    expect(earnedAutonomyOfKind("implied-order", record).eligible).toBe(true);
  });

  it("orders the window by when a proposal SETTLED, not by board order", () => {
    const record = proposalTrackRecord([
      // Newest first in the array, oldest last — the sort has to disagree with the input order.
      proposal("implied-order", "declined", Date.UTC(2026, 5, 1)),
      ...Array.from({ length: EARNED_AUTONOMY_WINDOW }, (_, i) =>
        proposal("implied-order", "applied", Date.UTC(2026, 0, 1) + i * 3_600_000),
      ),
    ]);
    // The one decline is the NEWEST settlement, so it is inside the window and an apply falls out.
    expect(record["implied-order"]).toEqual({
      settled: EARNED_AUTONOMY_WINDOW,
      applied: EARNED_AUTONOMY_WINDOW - 1,
    });
  });
});

describe("the board as it stands (2026-08-18)", () => {
  /**
   * Every proposal bead this project's board actually carries, as `[kind, outcome]` — read off
   * `bd list --status all`. The point of the fixture is that it is not arranged: it is the whole
   * settled-proposal record anton has, and not one kind of the twelve clears its bar.
   */
  const BOARD: Array<[GardenerDetectionKind, "applied" | "declined" | "open"]> = [
    ["low-value", "open"],
    ["misfiled", "applied"],
    ["mispriority", "applied"],
    ["mispriority", "declined"],
    ["missing-order", "applied"],
    ["missing-order", "applied"],
    ["missing-order", "declined"],
    ["oversized", "open"],
    ["oversized", "open"],
    ...(["applied", "applied", "applied", "applied"] as const).map(
      (o) => ["parentless-cluster", o] as [GardenerDetectionKind, "applied"],
    ),
    ...Array.from(
      { length: 13 },
      () => ["parentless-cluster", "declined"] as [GardenerDetectionKind, "declined"],
    ),
  ];

  const record = proposalTrackRecord(BOARD.map(([kind, outcome]) => proposal(kind, outcome)));

  it("scores parentless-cluster on its declines, and every other kind as having no record", () => {
    expect(record["parentless-cluster"]).toEqual({ settled: 17, applied: 4 });
    // The rest have one or two settlements between them — nothing that could be called evidence.
    expect(record["missing-order"]).toEqual({ settled: 3, applied: 2 });
    expect(record.misfiled).toEqual({ settled: 1, applied: 1 });
    expect(record.superseded).toEqual({ settled: 0, applied: 0 });
  });

  it("resolves EVERY kind to propose under an all-apply policy", () => {
    // The acceptance in one assertion: eleven for want of a record, `parentless-cluster` on its rate.
    for (const kind of GARDENER_DETECTION_KINDS) {
      const plan = { ...KINDS[kind], target: "anton-target" };
      expect(autonomyFor(kind, plan, ALL_APPLY, record)).toBe("propose");
    }
    expect(earnedAutonomyOfKind("parentless-cluster", record).reason).toContain("4/17 applied (24%)");
  });
});
