/**
 * `unlinked-outcome` (anton-vie0k), driven over fixture boards.
 *
 * Deliberately NOT part of {@link detectBoard}'s composed set (see detect.ts) — it asks about a
 * label the outcome contract predates rather than about how the board hangs together, so it is
 * composed on its own by `gardener-proposals.ts` instead. These tests drive
 * {@link detectUnlinkedOutcomes} directly for the same reason, through the same `indexWorkBoard`
 * every other detector is handed its board through.
 */
import { describe, expect, it } from "vitest";

import type { Bead } from "../beads/bd";
import { indexWorkBoard } from "./detect";
import {
  STRINGER_OUTCOME,
  UNKNOWN_OUTCOME,
  detectUnlinkedOutcomes,
  suggestOutcome,
} from "./unlinked-outcome";

const bead = (id: string, over: Partial<Bead> = {}): Bead => ({
  id,
  title: id,
  status: "open",
  issue_type: "task",
  ...over,
});

const epic = (id: string, over: Partial<Bead> = {}) => bead(id, { issue_type: "epic", ...over });
const feature = (id: string, over: Partial<Bead> = {}) =>
  bead(id, { issue_type: "feature", ...over });

const NOW_MS = Date.parse("2026-01-01T00:00:00Z");

const detect = (board: Bead[]) => detectUnlinkedOutcomes(indexWorkBoard(board), NOW_MS);

const only = (board: Bead[]) => {
  const detections = detect(board);
  expect(detections).toHaveLength(1);
  return detections[0];
};

describe("unlinked-outcome (anton-vie0k)", () => {
  it("flags an open run target with no outcome:<id>, suggesting unknown when nothing else fires", () => {
    const detection = only([feature("anton-feat", { title: "The runnable feature" })]);

    expect(detection.kind).toBe("unlinked-outcome");
    expect(detection.move).toBe("attach-outcome");
    expect(detection.subjects).toEqual(["anton-feat"]);
    expect(detection.detail).toBe(UNKNOWN_OUTCOME);
    expect(detection.evidence.join("\n")).toContain("anton-feat");
  });

  it("inherits the parent epic's outcome when it carries exactly one", () => {
    const detection = only([
      epic("anton-epic", { labels: ["outcome:oriented-operator"] }),
      feature("anton-feat", { parent: "anton-epic" }),
    ]);

    expect(detection.detail).toBe("oriented-operator");
    expect(detection.evidence.join("\n")).toContain("anton-epic");
  });

  it("asks the operator when the parent epic carries more than one outcome", () => {
    const detection = only([
      epic("anton-epic", { labels: ["outcome:oriented-operator", "outcome:codebase-health"] }),
      feature("anton-feat", { parent: "anton-epic" }),
    ]);

    expect(detection.detail).toBe(UNKNOWN_OUTCOME);
  });

  it("suggests codebase-health for stringer-filed work with no epic outcome to inherit", () => {
    const detection = only([bead("anton-bug", { issue_type: "bug", labels: ["source:stringer"] })]);

    expect(detection.detail).toBe(STRINGER_OUTCOME);
    expect(detection.evidence.join("\n")).toContain("source:stringer");
  });

  it("prefers the epic's own outcome over the stringer default when both are present", () => {
    // A bug with a parent rides that parent's run rather than being a run target itself (only a
    // PARENTLESS task/bug is), so the epic-inheriting subject here has to be a feature.
    const detection = only([
      epic("anton-epic", { labels: ["outcome:trustworthy-board"] }),
      feature("anton-feat", { labels: ["source:stringer"], parent: "anton-epic" }),
    ]);

    expect(detection.detail).toBe("trustworthy-board");
  });

  it("stays silent once the run target already carries an outcome:<id> label", () => {
    expect(detect([feature("anton-feat", { labels: ["outcome:oriented-operator"] })])).toEqual([]);
  });

  it("stays silent for a standalone epic whose contract states its outcome as body text", () => {
    expect(
      detect([
        epic("anton-epic", {
          description: "## Outcome IDs\n\noutcome:oriented-operator\n",
        }),
      ]),
    ).toEqual([]);
  });

  it("falls straight to unknown for a parentless task or bug with no epic to inherit from", () => {
    // No epic to inherit from (it has no parent at all), so it falls straight to unknown.
    const detection = only([bead("anton-task", { issue_type: "task" })]);
    expect(detection.detail).toBe(UNKNOWN_OUTCOME);
  });

  it("stays silent for a ticket that is not itself a run target", () => {
    // A task parented under a feature rides that feature's run; it is not its own run target, and
    // the digest groups it through the feature rather than by its own outcome label.
    expect(
      detect([
        feature("anton-feat", { labels: ["outcome:oriented-operator"] }),
        bead("anton-ticket", { parent: "anton-feat" }),
      ]),
    ).toEqual([]);
  });

  it("never names a container epic as a subject — it groups run targets rather than being one", () => {
    // The container itself is missing an outcome too, but it is not a RUN TARGET (an epic with a
    // feature child groups run targets rather than being one), so only the feature is ever asked.
    const detection = only([
      epic("anton-cont"),
      feature("anton-feat", { parent: "anton-cont" }),
    ]);
    expect(detection.subjects).toEqual(["anton-feat"]);
  });

  it("skips a closed run target", () => {
    expect(detect([feature("anton-feat", { status: "closed" })])).toEqual([]);
  });

  it("skips a deferred run target", () => {
    expect(detect([feature("anton-feat", { status: "deferred" })])).toEqual([]);
  });

  it("skips a run target a worker has already claimed", () => {
    expect(
      detect([feature("anton-feat", { status: "in_progress", assignee: "worker-1" })]),
    ).toEqual([]);
  });

  it("skips a run target with an unexpired run-lease", () => {
    expect(
      detect([feature("anton-feat", { labels: [`run-lease:${NOW_MS + 100_000}`] })]),
    ).toEqual([]);
  });

  it("skips the gardener's own proposal beads", () => {
    const proposal = feature("anton-p1", {
      labels: ["gardener:unlinked-outcome:abcdef012345"],
    });
    expect(detect([proposal])).toEqual([]);
  });

  it("quotes the bead's own Goal as evidence — the only thing left to judge an unknown by", () => {
    const detection = only([
      feature("anton-feat", { description: "## Goal\n\nShip the thing that matters.\n" }),
    ]);
    expect(detection.detail).toBe(UNKNOWN_OUTCOME);
    expect(detection.evidence.join("\n")).toContain("Ship the thing that matters.");
  });

  it("says nothing about a Goal when the bead states none", () => {
    const detection = only([feature("anton-feat")]);
    expect(detection.evidence.some((line) => line.includes("its own Goal"))).toBe(false);
  });

  // suggestOutcome's `parent` tells a caller which epic to lock before writing (apply-steps.ts
  // premiseBeadsOf) — it has to name the epic whenever the epic's OWN label count decided the
  // rung, not only on the rung that actually inherited from it (anton-9... PR #351 review).
  describe("suggestOutcome's parent (what apply-steps.ts has to lock)", () => {
    it("names the parent epic even when it falls through to the stringer default", () => {
      const index = indexWorkBoard([
        epic("anton-epic"),
        feature("anton-feat", { labels: ["source:stringer"], parent: "anton-epic" }),
      ]);
      const suggestion = suggestOutcome(index, index.byId.get("anton-feat")!);

      expect(suggestion.outcome).toBe(STRINGER_OUTCOME);
      expect(suggestion.parent).toBe("anton-epic");
    });

    it("names the parent epic even when it falls through to unknown", () => {
      const index = indexWorkBoard([epic("anton-epic"), feature("anton-feat", { parent: "anton-epic" })]);
      const suggestion = suggestOutcome(index, index.byId.get("anton-feat")!);

      expect(suggestion.outcome).toBe(UNKNOWN_OUTCOME);
      expect(suggestion.parent).toBe("anton-epic");
    });

    it("names no parent for a bead with no parent epic at all", () => {
      const index = indexWorkBoard([bead("anton-task", { issue_type: "task" })]);
      const suggestion = suggestOutcome(index, index.byId.get("anton-task")!);

      expect(suggestion.outcome).toBe(UNKNOWN_OUTCOME);
      expect(suggestion.parent).toBeUndefined();
    });
  });

  it("fingerprints each subject distinctly and stably across repeated passes", () => {
    const board = [feature("anton-a"), feature("anton-b")];
    const first = detect(board);
    const second = detect(board);

    expect(first.map((d) => d.subjects[0]).sort()).toEqual(["anton-a", "anton-b"]);
    expect(new Set(first.map((d) => d.fingerprint)).size).toBe(2);
    expect(first.map((d) => d.fingerprint).sort()).toEqual(second.map((d) => d.fingerprint).sort());
  });
});
