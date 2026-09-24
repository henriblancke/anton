/**
 * The six friction counters (anton-464lw), each tested in ISOLATION.
 *
 * The isolation is the point rather than a testing style. The counters compose into sums a sibling
 * ticket owns — `humanTouches`, and the quota-park exclusion from it — and PR #311's double-count
 * bug was invisible in a total: escalations and gates each looked right, and only their sum lied. So
 * every counter here gets a fixture that exercises IT and asserts the other five stay at zero, which
 * is what makes a later sum provable one term at a time.
 */
import { describe, expect, it } from "vitest";

import {
  countCancels,
  countEscalations,
  countHumanGates,
  countPrFixRounds,
  countQuotaParks,
  countReviewRounds,
  countSendBacks,
  type FrictionEscalationRow,
  type FrictionJobRow,
  type FrictionNote,
  type FrictionReviewRound,
} from "./feature-ledger";
import type { EscalationRow } from "./escalations";
import type { TicketNote } from "./beads/notes";
import type { JobRow } from "./jobs/queue";
import type { ReviewScoreEntry } from "./jobs/review-score";
import type { ReviewReportRound } from "./review-report";
import { originNoteBody, reworkNoteBody } from "./rework-notes";

/** Every counter's reading of one scope — so a fixture can assert what it did NOT move. */
function counts(scope: {
  rounds?: FrictionReviewRound[];
  jobs?: FrictionJobRow[];
  escalations?: FrictionEscalationRow[];
  notes?: FrictionNote[];
}) {
  const { rounds = [], jobs = [], escalations = [], notes = [] } = scope;
  return {
    reviewRounds: countReviewRounds(rounds),
    prFixRounds: countPrFixRounds(jobs),
    escalations: countEscalations(escalations),
    humanGates: countHumanGates(escalations),
    sendBacks: countSendBacks(notes),
    cancels: countCancels(jobs),
    quotaParks: countQuotaParks(jobs),
  };
}

const ZEROES = {
  reviewRounds: 0,
  prFixRounds: 0,
  escalations: 0,
  humanGates: 0,
  sendBacks: 0,
  cancels: 0,
  quotaParks: 0,
};

describe("a feature with no friction", () => {
  it("reports zeros on every counter", () => {
    expect(counts({})).toEqual(ZEROES);
  });

  it("is a different fact from an unrecorded scope, which the caller reports from `recorded`", () => {
    // Nothing here can tell "measured, and nothing happened" from "never measured" — that
    // distinction lives on the ledger's own `recorded` flag, which is why these are plain numbers
    // and not `undefined`. The zeroes above are the honest answer for a scope that WAS read.
    expect(counts({ jobs: [job({ type: "execute-epic", status: "done" })] })).toEqual(ZEROES);
  });
});

describe("reviewRounds — rounds to a clean verdict", () => {
  it("counts up to and including the round that came back clean", () => {
    const rounds = [
      { verdict: "fixed" },
      { verdict: "fixed" },
      { verdict: "clean" },
    ];
    expect(counts({ rounds })).toEqual({ ...ZEROES, reviewRounds: 3 });
  });

  it("counts ROUNDS, not the comments the thread holds", () => {
    // A single round that found five blocking findings is still one trip back through the gate.
    // Counting comments — or findings — would report this feature as five times as frictional as
    // the one below it, which went back through the gate twice as often.
    const oneNoisyRound = [{ verdict: "clean" }];
    const twoQuietRounds = [{ verdict: "fixed" }, { verdict: "clean" }];
    expect(countReviewRounds(oneNoisyRound)).toBe(1);
    expect(countReviewRounds(twoQuietRounds)).toBe(2);
  });

  it("ignores rounds after the clean one — they belong to a later gate", () => {
    // A resumed gate restarts at round 1 and a send-back re-reviews the same target, so the thread
    // can hold a second arc. Only the rounds spent reaching clean are this arc's.
    const rounds = [
      { verdict: "fixed" },
      { verdict: "clean" },
      { verdict: "fixed" },
      { verdict: "unresolved" },
    ];
    expect(countReviewRounds(rounds)).toBe(2);
  });

  it("reports every round of a thread that never reached clean", () => {
    // The worst outcome must not read as the best one: these rounds were really spent.
    const rounds = [{ verdict: "fixed" }, { verdict: "fixed" }, { verdict: "unresolved" }];
    expect(countReviewRounds(rounds)).toBe(3);
  });

  it("does not read the round NUMBER, which a resume restarts", () => {
    // A resumed gate restarts its numbering, so `round` is not a total order across attempts (see
    // review-report.ts) — position in the thread is the only ordering the board can vouch for. The
    // input type carries no `round` at all, which is how that is enforced rather than merely tested;
    // a real `ReviewScoreEntry` carrying one still satisfies it structurally and is read by position.
    const replayed: ReviewScoreEntry[] = [
      { round: 1, blocking: 1, advisory: 0, verdict: "interrupted" },
      { round: 1, blocking: 0, advisory: 0, verdict: "clean" },
    ];
    const rounds: FrictionReviewRound[] = replayed;
    expect(countReviewRounds(rounds)).toBe(2);
  });

  it("treats a round with no verdict as unsettled rather than clean", () => {
    expect(countReviewRounds([{ verdict: null }, { verdict: undefined }])).toBe(2);
  });
});

describe("prFixRounds — the PR corrected after it opened", () => {
  it("counts settled review-fix jobs and moves nothing else", () => {
    const jobs = [
      job({ type: "review-fix-pr", status: "done" }),
      job({ type: "review-fix-pr", status: "done" }),
    ];
    expect(counts({ jobs })).toEqual({ ...ZEROES, prFixRounds: 2 });
  });

  it("counts both PR-fix job types, matching the one `pr-fix` phase their spend bills to", () => {
    const jobs = [
      job({ type: "review-fix", status: "done" }),
      job({ type: "review-fix-pr", status: "done" }),
    ];
    expect(countPrFixRounds(jobs)).toBe(2);
  });

  it("counts a round that parked or failed — it cost the attention this measures", () => {
    const jobs = [
      job({ type: "review-fix-pr", status: "parked" }),
      job({ type: "review-fix-pr", status: "failed" }),
    ];
    expect(countPrFixRounds(jobs)).toBe(2);
  });

  it("ignores a round still in flight, so the figure never falls back down", () => {
    const jobs = [
      job({ type: "review-fix-pr", status: "queued" }),
      job({ type: "review-fix-pr", status: "running" }),
    ];
    expect(countPrFixRounds(jobs)).toBe(0);
  });

  it("ignores the run that did the work", () => {
    expect(countPrFixRounds([job({ type: "execute-epic", status: "done" })])).toBe(0);
  });
});

describe("escalations and humanGates — a total and the subset inside it", () => {
  it("counts every escalation, whatever it was raised from", () => {
    const escalations = [{ kind: "parked-run" }, { kind: "stale-pr" }];
    expect(counts({ escalations })).toEqual({ ...ZEROES, escalations: 2 });
  });

  it("counts a gate in BOTH figures — `needs-human` is a kind within the same table", () => {
    // The PR #311 bug in one assertion: these two are not siblings to be added. A lone gate is one
    // escalation that is also one gate, and the sum rule (anton-l6a9z) subtracts the overlap.
    const escalations = [{ kind: "needs-human" }];
    expect(counts({ escalations })).toEqual({ ...ZEROES, escalations: 1, humanGates: 1 });
  });

  it("separates the gates from the rest of the total", () => {
    const escalations = [
      { kind: "needs-human" },
      { kind: "needs-human" },
      { kind: "exhausted-job" },
    ];
    expect(countEscalations(escalations)).toBe(3);
    expect(countHumanGates(escalations)).toBe(2);
  });

  it("does not read an autopilot disarm as a gate", () => {
    const escalations = [{ kind: "autopilot-disarm" }];
    expect(countEscalations(escalations)).toBe(1);
    expect(countHumanGates(escalations)).toBe(0);
  });
});

describe("sendBacks — work a human returned for another pass", () => {
  it("counts a reopen's instruction note and moves nothing else", () => {
    const notes = [
      { text: reopenNote("anton-tgt", "the acceptance was never met") },
    ];
    expect(counts({ notes })).toEqual({ ...ZEROES, sendBacks: 1 });
  });

  it("counts a follow-up's pointer on the ticket it came from", () => {
    expect(countSendBacks([{ text: originNoteBody("anton-new") }])).toBe(1);
  });

  it("counts a redirected send-back — a merged PR still means work went back", () => {
    const redirected = originNoteBody("anton-new", {
      outcome: "shipped",
      pr: "#42",
      redirected: true,
    });
    expect(countSendBacks([{ text: redirected }])).toBe(1);
  });

  it("counts each send-back ONCE when its follow-up runs under the same feature", () => {
    // Every send-back writes on both ends. The follow-up BEAD's own note opens `Follow-up on
    // <origin> — its acceptance stands`, and a match on a bare `Follow-up ` prefix would count it
    // too — doubling exactly the features whose follow-ups stayed in scope.
    const origin = originNoteBody("anton-new");
    const received = reworkNoteBody({
      mode: "follow-up",
      targetId: "anton-tgt",
      summary: "another pass",
      instructions: "do the thing",
      findings: [],
      originId: "anton-orig",
    });
    expect(countSendBacks([{ text: origin }, { text: received }])).toBe(1);
  });

  it("ignores anton's own machine notes on the same blob", () => {
    const notes = [
      { text: "anton: run failed after 3 attempts" },
      { text: "anton: rework — #42 is still open, so this target's finished-run marker was retired" },
    ];
    expect(countSendBacks(notes)).toBe(0);
  });
});

describe("cancels — the one signal that needs no heuristic", () => {
  it("counts an operator-cancelled job and moves nothing else", () => {
    const jobs = [job({ type: "execute-epic", status: "cancelled" })];
    expect(counts({ jobs })).toEqual({ ...ZEROES, cancels: 1 });
  });

  it("does not read a park or a failure as a cancel", () => {
    const jobs = [
      job({ type: "execute-epic", status: "parked" }),
      job({ type: "execute-epic", status: "failed" }),
    ];
    expect(countCancels(jobs)).toBe(0);
  });
});

describe("quotaParks — reported beside the human touches, never inside them", () => {
  it("counts a usage-limit pause and moves nothing else", () => {
    // The counter that must stay isolated most of all: folding a quota window into the human-touch
    // sum would make the metric degrade every time anton is used MORE.
    const jobs = [job({ type: "execute-epic", status: "queued", lastError: usageLimit() })];
    expect(counts({ jobs })).toEqual({ ...ZEROES, quotaParks: 1 });
  });

  it("reads the park REASON, not the status — a quota pause reschedules rather than parks", () => {
    const jobs = [
      job({ type: "execute-epic", status: "queued", lastError: usageLimit() }),
      job({ type: "execute-epic", status: "parked", lastError: usageLimit() }),
    ];
    expect(countQuotaParks(jobs)).toBe(2);
  });

  it("does not count a park a human has to clear", () => {
    const jobs = [
      job({ type: "execute-epic", status: "parked", lastError: "poison: anton-x is not a run target" }),
      job({ type: "execute-epic", status: "parked", lastError: "failed 3×: push rejected" }),
    ];
    expect(countQuotaParks(jobs)).toBe(0);
  });
});

/** A `jobs` row as the counters read it. */
function job(overrides: Partial<FrictionJobRow> = {}): FrictionJobRow {
  return { type: "execute-epic", status: "done", lastError: null, ...overrides };
}

/** The runner's own quota marker, as `nextAction` writes it (jobs/runner.ts). */
function usageLimit(): string {
  return `usage-limit: resumes at ${new Date("2026-09-21T03:00:00Z").toISOString()}`;
}

/** A reopen's instruction note, rendered by the path that actually writes it. */
function reopenNote(targetId: string, summary: string): string {
  return reworkNoteBody({ mode: "reopen", targetId, summary, instructions: "redo it", findings: [] });
}

describe("the structural row types match the tables they claim to read", () => {
  it("accepts a real `jobs` row and a real `escalations` row", () => {
    // The counters are deliberately structural so the pure fold needs no db import — which also
    // means a column RENAME would not fail typecheck at the fold, it would just stop matching and
    // silently report zero friction. These assignments are where that fails loudly instead: a
    // persisted row must still satisfy the shape each counter reads.
    const persistedJob: JobRow = {
      id: "j1",
      type: "review-fix-pr",
      projectId: "p1",
      payloadJson: "{}",
      status: "done",
      runAt: new Date(),
      leaseExpiresAt: null,
      attempts: 1,
      spentAttempts: 1,
      lastError: null,
      outcome: null,
      outcomeNote: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    const asFriction: FrictionJobRow = persistedJob;
    expect(countPrFixRounds([asFriction])).toBe(1);

    const persistedEscalation: Pick<EscalationRow, "kind"> = { kind: "needs-human" };
    const asEscalation: FrictionEscalationRow = persistedEscalation;
    expect(countHumanGates([asEscalation])).toBe(1);
  });

  it("accepts a parsed ticket note and a replayed review round", () => {
    const parsed: TicketNote[] = [
      { source: "human", author: "Henri Blancke", at: "2026-09-21T00:00:00Z", text: originNoteBody("anton-new") },
    ];
    const asNotes: FrictionNote[] = parsed;
    expect(countSendBacks(asNotes)).toBe(1);

    const replayed: ReviewReportRound[] = [{ round: 1, blocking: 0, advisory: 0, verdict: "clean" }];
    const asRounds: FrictionReviewRound[] = replayed;
    expect(countReviewRounds(asRounds)).toBe(1);
  });
});
