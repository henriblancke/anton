/**
 * The phase mapping (anton-6p4kd), tested where it can go quietly wrong.
 *
 * The claims are ADR-0001 clause 3's: every job type and every builtin step id maps to exactly one
 * phase, the classification keys on the recorded HANDLER rather than the formula author's step id,
 * and a pair anton actually records that maps to nothing FAILS — naming the pair — instead of
 * draining into a bucket nobody reads.
 *
 * Kept beside the timing suite rather than inside it: the two halves of the fold share a module but
 * not a subject, and an exhaustiveness failure should name the mapping, not a duration.
 */
import { describe, expect, it } from "vitest";

import {
  BY_HANDLER,
  FEATURE_PHASES,
  HANDLER_PHASES,
  isProjectLevelPhase,
  JOB_TYPE_PHASES,
  LEDGER_PHASES,
  ledgerPhase,
  type LedgerPhase,
} from "./feature-ledger";
import { JOB_TYPES } from "./jobs-filters";
import { BUILTIN_STEP_IDS, PIPELINE_JOB_TYPE } from "./jobs/step-ids";

/** The scheduled passes D4 keeps off every feature's bill. */
const SCHEDULED_PASSES = ["gardener", "product-master", "board-picker", "nightly-stringer"] as const;

describe("exhaustiveness", () => {
  it("maps every job type to exactly one phase", () => {
    const unmapped = JOB_TYPES.filter((type) => !Object.hasOwn(JOB_TYPE_PHASES, type));
    expect(unmapped, `job types declaring no phase: ${unmapped.join(", ")}`).toEqual([]);
  });

  it("maps every builtin step handler to exactly one phase", () => {
    const unmapped = BUILTIN_STEP_IDS.filter((id) => !Object.hasOwn(HANDLER_PHASES, id));
    expect(unmapped, `step handlers declaring no phase: ${unmapped.join(", ")}`).toEqual([]);
  });

  it("classifies every (jobType, handler) pair anton can record", () => {
    // Every pair the runtime can actually write: a formula-walking type crossed with each handler,
    // plus every other type, which walks no formula and records no handler at all.
    const pairs: Array<{ jobType: string; stepHandler?: string }> = [
      ...BUILTIN_STEP_IDS.map((stepHandler) => ({ jobType: PIPELINE_JOB_TYPE, stepHandler })),
      ...JOB_TYPES.filter((type) => JOB_TYPE_PHASES[type] !== BY_HANDLER)
        .filter((type) => JOB_TYPE_PHASES[type] !== null)
        .map((jobType) => ({ jobType })),
    ];

    const unclassified = pairs.filter((pair) => ledgerPhase(pair) === undefined);
    const named = unclassified.map((p) => `(${p.jobType}, ${p.stepHandler ?? "—"})`).join(", ");
    expect(unclassified, `pairs matching no phase: ${named}`).toEqual([]);
  });

  it("fails loudly on a synthetic unmapped pair, naming it", () => {
    // The negative half of the check above: the mapping returns undefined rather than a default, so
    // an unclassified pair is visible as one instead of inflating whichever bucket it fell into.
    const pair = { jobType: "teleport-epic", stepHandler: "implement" };
    const phase = ledgerPhase(pair);
    expect(phase, `(${pair.jobType}, ${pair.stepHandler}) matched no phase`).toBeUndefined();
    expect(ledgerPhase({ jobType: PIPELINE_JOB_TYPE, stepHandler: "transpile" })).toBeUndefined();
  });

  it("declares a phase for every type the queue defines, without inventing one", () => {
    // `JOB_TYPES` is derived from the queue's own union, so this is the coupling ADR-0001 relies on:
    // a phase table with a key the queue does not define has drifted just as badly as a missing one.
    expect(Object.keys(JOB_TYPE_PHASES).sort()).toEqual([...JOB_TYPES].sort());
    expect(Object.keys(HANDLER_PHASES).sort()).toEqual([...BUILTIN_STEP_IDS].sort());
  });
});

describe("classification keys on the handler, not the step id", () => {
  it("folds a custom step id whose handler is implement into implement", () => {
    // The PR #311 finding: a project formula may call its implement step anything. The id is the
    // author's label; only the handler says what ran.
    expect(
      ledgerPhase({ jobType: "execute-epic", step: "code-ticket", stepHandler: "implement" }),
    ).toBe("implement");
  });

  it("ignores a step id that LOOKS like a handler but is not the one recorded", () => {
    // The inverse trap: an author who names a step `review` does not thereby make it review spend.
    expect(ledgerPhase({ jobType: "execute-epic", step: "review", stepHandler: "implement" })).toBe(
      "implement",
    );
  });

  it("cannot classify a row whose handler was never recorded", () => {
    // Rows written before `step_handler` existed carry null forever. Falling back to `step` here
    // would be exactly the author-id guess this module refuses.
    expect(ledgerPhase({ jobType: "execute-epic", step: "implement" })).toBeUndefined();
    expect(
      ledgerPhase({ jobType: "execute-epic", step: "implement", stepHandler: null }),
    ).toBeUndefined();
  });
});

describe("the review gate's two sessions", () => {
  it("maps its review session to self-review", () => {
    expect(ledgerPhase({ jobType: "execute-epic", step: "review", stepHandler: "review" })).toBe(
      "self-review",
    );
  });

  it("maps a review-fix step under execute-epic to pr-fix, not implement", () => {
    // The gate's correction round runs inside the run, so its job type is still `execute-epic`.
    // Counting it as implement would hide the cost of fixing a run inside the cost of doing it.
    expect(
      ledgerPhase({ jobType: "execute-epic", step: "review-fix", stepHandler: "review" }),
    ).toBe("pr-fix");
  });

  it("maps a review-fix handler to pr-fix whatever the step is called", () => {
    expect(
      ledgerPhase({ jobType: "execute-epic", step: "tidy-up", stepHandler: "review-fix" }),
    ).toBe("pr-fix");
  });

  it("maps both standalone PR-fix job types to pr-fix", () => {
    expect(ledgerPhase({ jobType: "review-fix", stepHandler: "review-fix" })).toBe("pr-fix");
    expect(ledgerPhase({ jobType: "review-fix-pr", stepHandler: "review-fix" })).toBe("pr-fix");
  });
});

describe("overhead is project-level", () => {
  it("maps every scheduled pass to overhead", () => {
    for (const jobType of SCHEDULED_PASSES) {
      expect(ledgerPhase({ jobType, stepHandler: "scan-triage" }), jobType).toBe("overhead");
    }
  });

  it("keeps overhead out of the phases a feature's totals may carry (design D4)", () => {
    // Splitting a board-wide pass across features would be a fabricated number. The predicate is
    // exported so a caller enforces the rule rather than remembering it.
    expect(isProjectLevelPhase("overhead")).toBe(true);
    expect(FEATURE_PHASES).not.toContain<LedgerPhase>("overhead");
    expect(FEATURE_PHASES).toEqual(["implement", "self-review", "describe", "pr-fix"]);
    expect(LEDGER_PHASES.filter((p) => !isProjectLevelPhase(p))).toEqual(FEATURE_PHASES);
  });
});

describe("job types that declare they spend nothing", () => {
  it("classifies a row under one as unattributed rather than guessing", () => {
    // A mechanical job dispatches no claude, so a ledger row under one is an anomaly. Reporting it
    // as unattributed is what makes the anomaly visible; a default bucket would hide it.
    expect(ledgerPhase({ jobType: "sync-push", stepHandler: "implement" })).toBeUndefined();
    expect(ledgerPhase({ jobType: "worktree-reaper" })).toBeUndefined();
  });

  it("cannot classify a job type this anton no longer defines", () => {
    expect(ledgerPhase({ jobType: null })).toBeUndefined();
    expect(ledgerPhase({ jobType: undefined })).toBeUndefined();
    expect(ledgerPhase({ jobType: "retired-pass" })).toBeUndefined();
  });
});
