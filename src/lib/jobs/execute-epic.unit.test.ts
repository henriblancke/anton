/**
 * Unit tests for the active-agents allowlist enforcement (anton-dm7): which tickets dispatch
 * must refuse to run. The park behavior itself (PoisonEpic → run failed + job parked) is
 * exercised end-to-end in execute-epic.integration.test.ts.
 */
import { describe, expect, it } from "vitest";
import { LABELS, type Bead, type BeadDep, type Gate } from "../beads/bd";
import { latestBlockNoteCommit } from "../beads/block-note";
import { formatHumanNote, parseTicketNotes } from "../beads/notes";
import {
  blockedTailReason,
  isForeignRunOwner,
  parkedAskGateId,
  parkedAskGateIds,
  poisonBlockerIds,
  PoisonEpic,
  RunAlreadyLiveError,
} from "./errors";
import { splitFormulaPhases } from "./execute-epic-formula";
import {
  deliveredTickets,
  humanHeldPoison,
  humanHeldTickets,
  inactiveAgentTickets,
  orderTickets,
  reopenAbsorbedTimeouts,
  reorderForPrereq,
  reorderNote,
  reopenableAfterStop,
  runReadiness,
  runTargetDrift,
  skipNote,
  skippedDependents,
  ticketSetDrift,
  type ReopenBoard,
} from "./execute-epic-board";
import {
  askSettleError,
  NeedsHumanError,
  ParkedAskError,
} from "./execute-epic-errors";
import {
  adoptRefreshedTarget,
  humanGatePlan,
  humanGateReason,
  HUMAN_GATE_ARMED_LABEL,
} from "./execute-epic-human-gate";
import { branchDelivery, landableTicketIds } from "./execute-epic-dispatch";
import { mergeGatePlan } from "./execute-epic-merge-gate";
import { reviewParkMessage, stalePrBodyNote } from "./execute-epic-review";
import { assertDelivered, displacesSelfReport, selfReportRank } from "./execute-epic-ticket";
import { claudeResumeDecision, continuationPrompt } from "./execute-epic-ticket-claude";
import { ticketClaimFailure } from "./execute-epic-ticket-bookends";
import {
  satisfiedClaim,
  ticketBlockNote,
  timedOutTicketNote,
  type TicketProgress,
} from "./execute-epic-ticket-settle";
import { withBeadWriteLock } from "../beads/claim-lock";
import { runTickets } from "../ticket-view";
import { BUILTIN_STEPS, ticketPrompt, type StepFacts } from "./step-registry";
import type { ResolvedStep } from "./run-formula";

/** A promise the test resolves by hand, to hold a lock open across a deliberate interleave. */
function defer(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function ticket(id: string, labels?: string[]): Bead {
  return { id, title: id, status: "open", labels } as Bead;
}

/** A resolved pipeline addressed the way a formula does: one `step:<name>` per step. */
function pipeline(...names: string[]): { source: string; steps: ResolvedStep[] } {
  return {
    source: "/repo/.beads/formulas/anton-run.formula.toml",
    steps: names.map((name) => ({
      step: { id: name, labels: [`step:${name}`] },
      definition: BUILTIN_STEPS[name],
    })),
  };
}

describe("splitFormulaPhases — where a ticket's work ends and the run's begins (anton-lnkt)", () => {
  const names = (steps: ResolvedStep[]) => steps.map((s) => s.definition.name);

  it("splits the shipped pipeline at its commit: per-ticket work, then the run's own steps", () => {
    const { ticketSteps, runSteps } = splitFormulaPhases(
      pipeline("implement", "verify", "commit", "review", "pr"),
    );
    expect(names(ticketSteps)).toEqual(["implement", "verify", "commit"]);
    expect(names(runSteps)).toEqual(["review", "pr"]);
  });

  it("moves the boundary when the project moves the step — reorder is the whole point", () => {
    // Verify gates after the commit: one run-wide verification instead of one per ticket, with no
    // anton code change.
    const { ticketSteps, runSteps } = splitFormulaPhases(
      pipeline("implement", "commit", "verify", "pr"),
    );
    expect(names(ticketSteps)).toEqual(["implement", "commit"]);
    expect(names(runSteps)).toEqual(["verify", "pr"]);
  });

  it("fails loud on a pipeline with no commit — a run with no evidence of record", () => {
    expect(() => splitFormulaPhases(pipeline("implement", "pr"))).toThrow(PoisonEpic);
    expect(() => splitFormulaPhases(pipeline("implement", "pr"))).toThrow(/no `step:commit`/);
  });
});

describe("inactiveAgentTickets", () => {
  it("flags a ticket whose agent: label is not in a non-empty allowlist", () => {
    const out = inactiveAgentTickets(
      [ticket("t-1", ["agent:terraform", "domain:eng"])],
      ["fastapi", "nextjs"],
    );
    expect(out).toEqual([{ id: "t-1", agent: "terraform" }]);
  });

  it("passes tickets with an enabled agent or with no agent: label", () => {
    const out = inactiveAgentTickets(
      [ticket("t-1", ["agent:nextjs"]), ticket("t-2", ["domain:eng"]), ticket("t-3")],
      ["nextjs"],
    );
    expect(out).toEqual([]);
  });

  it("treats an absent allowlist as all agents active", () => {
    expect(inactiveAgentTickets([ticket("t-1", ["agent:kubernetes"])], undefined)).toEqual([]);
  });

  it("treats an EMPTY allowlist as no BUNDLED agent active — parks bundled, not user agents", () => {
    // The operator toggled every bundled agent off; the API persists [] as a real "no agents"
    // value distinct from clearing (undefined), so dispatch must honor it for bundled agents. A
    // user agent (`my-custom` in userAgentIds) still runs; only unlabeled tickets otherwise pass.
    expect(
      inactiveAgentTickets(
        [ticket("t-1", ["agent:kubernetes"]), ticket("t-2", ["agent:my-custom"]), ticket("t-3")],
        [],
        ["my-custom"],
      ),
    ).toEqual([{ id: "t-1", agent: "kubernetes" }]);
  });

  it("never gates the project's own user agents, whatever the allowlist (anton-dvo.1 reversal)", () => {
    // `my-custom` is a `.claude/agents` agent (in userAgentIds) — it always runs, even when the
    // allowlist omits it and only lists a bundled agent.
    expect(
      inactiveAgentTickets([ticket("t-1", ["agent:my-custom"])], ["fastapi"], ["my-custom"]),
    ).toEqual([]);
    expect(
      inactiveAgentTickets([ticket("t-1", ["agent:my-custom"])], [], ["my-custom"]),
    ).toEqual([]);
  });

  it("still parks a disabled bundled agent or an unknown tag not among the user agents", () => {
    // The safety net stands: an `agent:` tag that is neither active nor a known user agent — a
    // disabled bundled specialist, or a typo resolving nowhere — is parked.
    expect(
      inactiveAgentTickets(
        [ticket("t-1", ["agent:terraform"]), ticket("t-2", ["agent:typoo"])],
        ["fastapi"],
        ["my-custom"],
      ),
    ).toEqual([
      { id: "t-1", agent: "terraform" },
      { id: "t-2", agent: "typoo" },
    ]);
  });

  it("never reports agent:human — there is no toggle to enable, and its ticket is gated (anton-mv70)", () => {
    // Failure path this closes: `agent:human` is in neither AGENT_OPTIONS nor `.claude/agents`, so
    // under ANY persisted allowlist it read as "a disabled bundled agent" and poison-parked the
    // WHOLE feature with "enable them in Settings → Agents" — pointing at a switch that cannot
    // exist and killing the human ticket's independent siblings with it. A human ticket is held by
    // its own gate instead (0b-pre), and its siblings still ship.
    expect(inactiveAgentTickets([ticket("t-1", ["agent:human"])], ["fastapi"])).toEqual([]);
    expect(inactiveAgentTickets([ticket("t-1", ["agent:human"])], [])).toEqual([]);
    expect(inactiveAgentTickets([ticket("t-1", ["agent:human"])], [], ["my-custom"])).toEqual([]);
    // …and it does not mask a genuinely disabled agent on a sibling.
    expect(
      inactiveAgentTickets(
        [ticket("t-1", ["agent:human"]), ticket("t-2", ["agent:terraform"])],
        ["fastapi"],
      ),
    ).toEqual([{ id: "t-2", agent: "terraform" }]);
  });

  it("reports every offending ticket, not just the first", () => {
    const out = inactiveAgentTickets(
      [ticket("t-1", ["agent:docker"]), ticket("t-2", ["agent:alembic"]), ticket("t-3", ["agent:fastapi"])],
      ["fastapi"],
    );
    expect(out).toEqual([
      { id: "t-1", agent: "docker" },
      { id: "t-2", agent: "alembic" },
    ]);
  });
});

/**
 * anton-fude: a child ticket in a status bd refuses `--claim` on is one NO run can dispatch — and
 * the state that puts one there is anton's own no-delivery block. Every resume then re-derived the
 * same child set and walked that ticket into runTicket's hard claim gate, which reported a foreign
 * claim or a locked Dolt DB. What the board gate has to answer is: which tickets, and what does the
 * operator do about each.
 */
describe("humanHeldTickets — the children only a person can release (anton-fude)", () => {
  const held = (id: string, status: string, notes?: string): Bead =>
    ({ id, title: id, status, ...(notes ? { notes } : {}) }) as Bead;

  it("reports a blocked child with the note the run left on it", () => {
    const note = "anton: run made no changes (clean agent exit, zero diff) — nothing was delivered.";
    expect(humanHeldTickets([held("anton-od4", "blocked", note)])).toEqual([
      { id: "anton-od4", status: "blocked", note },
    ]);
  });

  it("reports a deferred child the same way — bd refuses that claim too", () => {
    expect(humanHeldTickets([held("anton-od4", "deferred")])).toEqual([
      { id: "anton-od4", status: "deferred" },
    ]);
  });

  it("leaves the statuses a run settles for itself to the loop", () => {
    // `open` is the only status bd claims; `closed` is skipped or reopened by the dispatch loop, and
    // `in_progress` is an ownership question runTicket's own claim gate answers.
    expect(
      humanHeldTickets([
        held("t-1", "open"),
        held("t-2", "closed"),
        held("t-3", "in_progress"),
      ]),
    ).toEqual([]);
  });

  it("never reports an abandoned ticket — a human already settled it and the run drops it", () => {
    const abandoned = { ...held("t-1", "blocked"), labels: [LABELS.abandoned] } as Bead;
    expect(humanHeldTickets([abandoned])).toEqual([]);
  });

  it("carries anton's NEWEST note, not a human's steer and not a stale earlier verdict", () => {
    // Machine notes live one per line in the blob (beads/notes.ts), newest last; a human's steer is
    // written to the agent, so the operator reading this park is owed anton's own account instead.
    const notes = [
      "anton: skipped behind a timeout",
      formatHumanNote("try the other helper", "Henri Blancke", new Date(0)),
      "anton: blocked for review — zero diff",
    ].join("\n");
    expect(humanHeldTickets([held("t-1", "blocked", notes)])[0].note).toBe(
      "anton: blocked for review — zero diff",
    );
  });

  it("caps a runaway note rather than pouring it into the run row", () => {
    const note = humanHeldTickets([held("t-1", "blocked", `anton: ${"x".repeat(500)}`)])[0].note!;
    expect(note.length).toBeLessThanOrEqual(301);
    expect(note.endsWith("…")).toBe(true);
  });

  it("reads the committed sha off the block note anton itself wrote", () => {
    const note = ticketBlockNote({
      kind: "post-commit",
      selfReport: null,
      error: new Error("push rejected"),
      sessionId: "sess-1",
      branch: "anton/anton-e1",
      committed: true,
      head: "0123456789abcdef0123456789abcdef01234567",
    });
    expect(humanHeldTickets([held("t-1", "blocked", note)])[0].committed).toEqual({
      branch: "anton/anton-e1",
      head: "0123456",
    });
  });

  it("reports no commit for a zero-diff block — the note says nothing landed", () => {
    const note = ticketBlockNote({
      kind: "no-delivery",
      selfReport: null,
      sessionId: "sess-1",
      branch: "anton/anton-e1",
      committed: false,
    });
    expect(humanHeldTickets([held("t-1", "blocked", note)])[0].committed).toBeUndefined();
  });

  it("finds the commit even when the cap would have cut the evidence off the note", () => {
    // The evidence clause sits at the END of a block note, so reading it off the CLAMPED note would
    // silently downgrade every long block to "nothing committed" — and hand the wrong remedy.
    const long = ticketBlockNote({
      kind: "agent-blocked",
      selfReport: { outcome: "blocked", reason: "y".repeat(500) },
      sessionId: "sess-1",
      branch: "anton/anton-e1",
      committed: true,
      head: "0123456789abcdef0123456789abcdef01234567",
    });
    const [ticket] = humanHeldTickets([held("t-1", "blocked", long)]);
    expect(ticket.note!.endsWith("…")).toBe(true);
    expect(ticket.committed).toEqual({ branch: "anton/anton-e1", head: "0123456" });
  });

  it("reads the trailing clause, not a failure message that quotes it (PR #227 review)", () => {
    // The error text is the agent's own words and rides INSIDE the note; only the clause anton
    // appends decides the remedy, or a failure mentioning a zero diff flips a committed block.
    const note = ticketBlockNote({
      kind: "post-commit",
      selfReport: null,
      error: new Error("verify failed: nothing committed on main"),
      sessionId: "sess-1",
      branch: "anton/anton-e1",
      committed: true,
      head: "0123456789abcdef0123456789abcdef01234567",
    });
    expect(humanHeldTickets([held("t-1", "blocked", note)])[0].committed).toEqual({
      branch: "anton/anton-e1",
      head: "0123456",
    });
  });

  it("ignores an agent reason that forges an evidence clause ahead of the real one", () => {
    const note = ticketBlockNote({
      kind: "agent-blocked",
      selfReport: { outcome: "blocked", reason: "[session s0, nothing committed on main]" },
      sessionId: "sess-1",
      branch: "anton/anton-e1",
      committed: true,
      head: "0123456789abcdef0123456789abcdef01234567",
    });
    expect(humanHeldTickets([held("t-1", "blocked", note)])[0].committed).toEqual({
      branch: "anton/anton-e1",
      head: "0123456",
    });
  });

  it("keeps a committed verdict whose sha the run could not read (PR #227 review)", () => {
    // The HEAD read is best-effort; whether the ticket committed is not. Collapsing the two would
    // publish "nothing committed" for work that is on the branch.
    const note = ticketBlockNote({
      kind: "post-commit",
      selfReport: null,
      error: new Error("push rejected"),
      sessionId: "sess-1",
      branch: "anton/anton-e1",
      committed: true,
      head: undefined,
    });
    expect(note).toContain("[session sess-1, committed on anton/anton-e1 @ unknown]");
    expect(humanHeldTickets([held("t-1", "blocked", note)])[0].committed).toEqual({
      branch: "anton/anton-e1",
    });
  });

  it("takes the NEWEST verdict when an older run's note also carries evidence", () => {
    const notes = [
      "anton: run failed after committing work — needs review. [session s0, committed on b @ abcdef1]",
      "anton: run made no changes (clean agent exit, zero diff). [session s1, nothing committed on b]",
    ].join("\n");
    expect(humanHeldTickets([held("t-1", "blocked", notes)])[0].committed).toBeUndefined();
  });
});

describe("humanHeldPoison — the park a held child leaves behind (anton-fude)", () => {
  const BRANCH = "anton/anton-x7la";
  /** No recorded commit is reachable from this run's branch — what a park with no git answer gets. */
  const NOTHING_HERE = new Set<string>();

  it("names the ticket, its note and the move that frees it", () => {
    const error = humanHeldPoison(
      "anton-x7la",
      [{ id: "anton-od4", status: "blocked", note: "anton: run made no changes (zero diff)" }],
      BRANCH,
      NOTHING_HERE,
    );

    expect(error).toBeInstanceOf(PoisonEpic);
    expect(error.message).toContain("anton-x7la");
    expect(error.message).toContain("anton-od4 is blocked pending human review");
    expect(error.message).toContain("anton: run made no changes (zero diff)");
    expect(error.message).toContain("bd update anton-od4 --status open");
    expect(error.message).toMatch(/resume the run$/);
  });

  it("tells a deferred child's own remedy apart from a blocked one's", () => {
    const error = humanHeldPoison(
      "anton-x7la",
      [{ id: "anton-od4", status: "deferred" }],
      BRANCH,
      NOTHING_HERE,
    );
    expect(error.message).toContain("is deferred");
    expect(error.message).toContain("bd undefer anton-od4");
    expect(error.message).not.toContain("--status open");
  });

  it("sends a VERIFIED committed block to review-and-close, not to reopen-and-re-run", () => {
    // Reopening does not satisfy `resumeSkipped` (only `closed` does), so the resumed run would
    // dispatch the agent again on top of the commit already on the branch — straight back to the
    // zero diff that blocked it. Closing is the move that actually lets the run walk past it.
    const error = humanHeldPoison(
      "anton-x7la",
      [{ id: "anton-od4", status: "blocked", committed: { branch: BRANCH, head: "0123456" } }],
      BRANCH,
      new Set(["anton-od4"]),
    );
    expect(error.message).toContain("ALREADY COMMITTED");
    expect(error.message).toContain("@ 0123456");
    expect(error.message).toContain("bd close anton-od4");
    expect(error.message).toContain("stays in this run's pull request");
    expect(error.message).not.toContain("drops the work from this run");
  });

  it("refuses the close remedy for a commit on ANOTHER branch (PR #227 review)", () => {
    // A re-parented ticket keeps the note its ORIGINAL run wrote, naming that run's branch. Its
    // commit is in no pull request this target opens, so "review and close" would settle the board
    // over work this run never ships — and the abandon hint must not promise the commit rides along.
    const error = humanHeldPoison(
      "anton-x7la",
      [
        {
          id: "anton-od4",
          status: "blocked",
          committed: { branch: "anton/anton-fude", head: "0123456" },
        },
      ],
      BRANCH,
      NOTHING_HERE,
    );
    expect(error.message).toContain("committed on anton/anton-fude (@ 0123456)");
    expect(error.message).toContain("NOT on this run's branch");
    expect(error.message).toContain(BRANCH);
    expect(error.message).toContain("bd update anton-od4 --status open");
    expect(error.message).not.toContain("ALREADY COMMITTED");
    expect(error.message).not.toContain("bd close");
    expect(error.message).toContain("drops the work from this run");
  });

  it("refuses the close remedy when the commit is not on THIS machine's branch (PR #227 review)", () => {
    // anton's branch names are deterministic per target, so a run resumed on another machine derives
    // the SAME name over a checkout that lacks the commit — the original machine committed and
    // parked before pushing. Offering "abandon it, the commit stays in the PR" there drops the work:
    // partitionTickets discards the abandoned ticket and an incomplete pull request proceeds.
    const error = humanHeldPoison(
      "anton-x7la",
      [{ id: "anton-od4", status: "blocked", committed: { branch: BRANCH, head: "0123456" } }],
      BRANCH,
      NOTHING_HERE,
    );
    expect(error.message).toContain("@ 0123456");
    expect(error.message).toContain(`NOT on this machine's ${BRANCH}`);
    expect(error.message).toContain("bd update anton-od4 --status open");
    expect(error.message).not.toContain("ALREADY COMMITTED");
    expect(error.message).not.toContain("bd close");
    expect(error.message).toContain("drops the work from this run");
  });

  it("neither closes nor redoes a commit whose sha was never recorded (PR #227 review)", () => {
    // The run that blocked this ticket committed, then failed to read HEAD. Both settled remedies
    // are wrong on the wrong guess — closing may settle the board over work in no pull request,
    // reopening may redo work already on the branch — so the operator is sent to git to decide.
    const error = humanHeldPoison(
      "anton-x7la",
      [{ id: "anton-od4", status: "blocked", committed: { branch: BRANCH } }],
      BRANCH,
      NOTHING_HERE,
    );
    expect(error.message).toContain("its work WAS committed on");
    expect(error.message).toContain("could not read the commit's sha");
    expect(error.message).toContain(`git log --oneline ${BRANCH} | grep anton-od4`);
    expect(error.message).toContain("bd close anton-od4");
    expect(error.message).toContain("bd update anton-od4 --status open");
    expect(error.message).not.toContain("ALREADY COMMITTED");
    // Unverified is not "here": the abandon hint must not promise the commit rides along.
    expect(error.message).toContain("drops the work from this run");
  });

  it("keeps the reopen remedy for a block that committed nothing", () => {
    const error = humanHeldPoison(
      "anton-x7la",
      [{ id: "anton-od4", status: "blocked" }],
      BRANCH,
      NOTHING_HERE,
    );
    expect(error.message).toContain("bd update anton-od4 --status open");
    expect(error.message).not.toContain("bd close");
    expect(error.message).toContain("drops the work from this run");
  });

  it("names WHICH commits survive an abandon when the held set is mixed (PR #227 review)", () => {
    // One ticket's work is on this branch, the other's is on another machine's. An unqualified "a
    // commit already on the branch stays in the pull request" reads as covering both, so an operator
    // abandoning the pair would drop the work this checkout does not have.
    const error = humanHeldPoison(
      "anton-x7la",
      [
        { id: "anton-od4", status: "blocked", committed: { branch: BRANCH, head: "0123456" } },
        { id: "anton-9zz", status: "blocked", committed: { branch: BRANCH, head: "89abcde" } },
      ],
      BRANCH,
      new Set(["anton-od4"]),
    );
    expect(error.message).toContain("only the commit already on this branch (anton-od4)");
    expect(error.message).toContain("abandoning the rest drops that work from this run");
  });

  it("names every held ticket, not just the first", () => {
    const error = humanHeldPoison(
      "anton-x7la",
      [
        { id: "anton-od4", status: "blocked" },
        { id: "anton-9zz", status: "deferred" },
      ],
      BRANCH,
      NOTHING_HERE,
    );
    expect(error.message).toContain("2 tickets");
    expect(error.message).toContain("anton-od4");
    expect(error.message).toContain("anton-9zz");
  });
});

/**
 * anton-fude: runTicket's claim gate used to give one answer — a foreign operator, or a locked DB —
 * to every refusal, including the one it could not possibly be: a status bd will never accept.
 */
describe("ticketClaimFailure — why the ticket claim gate refused (anton-fude)", () => {
  const bdRefusal = (stderr: string) =>
    Object.assign(new Error(`Command failed: bd update t-1 --claim\n${stderr}`), { stderr });

  it("parks on a status refusal, naming the status rather than a foreign claim or a locked DB", () => {
    const error = ticketClaimFailure(
      "anton-od4",
      "alice",
      bdRefusal("Error claiming anton-od4: issue not claimable: status blocked"),
    );

    expect(error).toBeInstanceOf(PoisonEpic);
    expect(error.message).toContain('status is "blocked"');
    expect(error.message).toContain("bd update anton-od4 --status open");
    expect(error.message).not.toMatch(/already claimed by another operator|beads DB is locked/);
    // bd's own words survive into the park, so the operator sees what it actually said.
    expect(error.message).toContain("issue not claimable: status blocked");
  });

  it("keeps the retryable answer for a foreign claim — an owner can still release it", () => {
    const error = ticketClaimFailure(
      "anton-od4",
      "alice",
      bdRefusal("Error claiming anton-od4: issue already claimed by bob"),
    );

    expect(error).not.toBeInstanceOf(PoisonEpic);
    expect(error.message).toContain("already claimed by another operator, or the beads DB is locked");
    expect(error.message).toContain("alice");
  });

  it("keeps it retryable for a FOREIGN in_progress claim — the holder can still release it", () => {
    // bd words somebody else's live claim as a status refusal too (`not claimable: status
    // in_progress`), but it is an ownership conflict, not a decision written to the board: poisoning
    // it would park the whole run permanently over a sibling run's ticket that clears on its own.
    const error = ticketClaimFailure(
      "anton-od4",
      "alice",
      bdRefusal("Error claiming anton-od4: issue not claimable: status in_progress"),
    );

    expect(error).not.toBeInstanceOf(PoisonEpic);
    expect(error.message).toContain("already claimed by another operator, or the beads DB is locked");
  });

  it("keeps it retryable when the ticket CLOSED under the run's snapshot", () => {
    // PR #227 review: another actor closing the ticket between the board read and this claim is a
    // stale snapshot, not a held status. A retry refreshes the board and the dispatch loop's own
    // closed-ticket handling takes over — skipping a commit already on the branch, or reopening the
    // bead to regenerate work this branch lacks. Poisoning it would ask a person to reopen a ticket
    // anton reopens by itself.
    const error = ticketClaimFailure(
      "anton-od4",
      "alice",
      bdRefusal("Error claiming anton-od4: issue not claimable: status closed"),
    );

    expect(error).not.toBeInstanceOf(PoisonEpic);
    expect(error.message).toContain("closed after this run read the board");
    expect(error.message).not.toMatch(/beads DB is locked/);
  });

  it("keeps it for a wedged DB too — the state a later attempt may find changed", () => {
    const error = ticketClaimFailure("anton-od4", undefined, bdRefusal("Error 1105: database is locked"));
    expect(error).not.toBeInstanceOf(PoisonEpic);
    expect(error.message).toContain("this operator");
  });
});

/**
 * anton-1two: the run gate is per TICKET, not per target. A target whose tail child waits on
 * another run must still run the children nothing holds — the all-or-nothing verdict is what
 * stalled a whole feature over one edge (issue #58) — while never dispatching the held one.
 */
describe("runReadiness — what a partially-gated run may start (anton-1two)", () => {
  const feature = (id: string, extra: Partial<Bead> = {}): Bead =>
    ({ id, title: id, status: "open", issue_type: "feature", ...extra }) as Bead;
  const child = (id: string, parent: string, extra: Partial<Bead> = {}): Bead =>
    ({ id, title: id, status: "open", issue_type: "task", parent, ...extra }) as Bead;
  const standaloneTask = (id: string, extra: Partial<Bead> = {}): Bead =>
    ({ id, title: id, status: "open", issue_type: "task", ...extra }) as Bead;
  const blocks = (from: string, to: string): BeadDep => ({
    issue_id: from,
    depends_on_id: to,
    type: "blocks",
  });

  /** F1 owns t-1 (independent) and t-2 (blocked by a ticket in the OTHER feature). */
  const partiallyGated = (): Bead[] => [
    feature("F1"),
    feature("F2"),
    child("t-1", "F1"),
    child("t-2", "F1", { dependencies: [blocks("t-2", "t-9")] }),
    child("t-9", "F2"),
  ];

  it("runs the independent children and holds only the cross-run-gated one", () => {
    const r = runReadiness(partiallyGated(), "F1", true);
    expect(r.runnable).toBe(true);
    expect(r.gated).toEqual(["t-2"]);
    // The blockers still name the UNIT that ships the blocking work, for the park reason.
    expect(r.blockers).toEqual(["F2"]);
  });

  it("holds a child queued behind a gated sibling — inside-the-run ordering propagates", () => {
    const board = [...partiallyGated(), child("t-3", "F1", { dependencies: [blocks("t-3", "t-2")] })];
    const r = runReadiness(board, "F1", true);
    expect(r.runnable).toBe(true);
    expect(r.gated.sort()).toEqual(["t-2", "t-3"]);
  });

  it("holds a child gated cross-run even when its OTHER blocker is work this run does", () => {
    // The premise of the held-tail/timeout overlap (anton-67xj): t-2 waits on t-9 in another feature
    // AND on its own sibling t-1, so it lands in the HELD set and never enters the dispatch loop —
    // which is why a timeout on t-1 has to be reconciled against the held tail, not just the loop.
    const board = [
      feature("F1"),
      feature("F2"),
      child("t-1", "F1"),
      child("t-2", "F1", { dependencies: [blocks("t-2", "t-9"), blocks("t-2", "t-1")] }),
      child("t-9", "F2"),
    ];
    const r = runReadiness(board, "F1", true);
    expect(r.runnable).toBe(true);
    expect(r.gated).toEqual(["t-2"]);
  });

  it("refuses the run only when NO child can start", () => {
    const board = [
      feature("F1"),
      feature("F2"),
      child("t-1", "F1", { dependencies: [blocks("t-1", "t-9")] }),
      child("t-2", "F1", { dependencies: [blocks("t-2", "t-9")] }),
      child("t-9", "F2"),
    ];
    const r = runReadiness(board, "F1", true);
    expect(r.runnable).toBe(false);
    expect(r.gated.sort()).toEqual(["t-1", "t-2"]);
  });

  it("holds nothing once the blocker's run target is done", () => {
    const board = [
      feature("F1"),
      feature("F2", { status: "closed" }),
      child("t-1", "F1"),
      child("t-2", "F1", { dependencies: [blocks("t-2", "t-9")] }),
      child("t-9", "F2", { status: "closed" }),
    ];
    const r = runReadiness(board, "F1", true);
    expect(r).toEqual({ blockers: [], gated: [], runnable: true });
  });

  it("keeps a standalone target all-or-nothing — it IS its own single ticket", () => {
    const blocked = [
      standaloneTask("s-1", { dependencies: [blocks("s-1", "s-2")] }),
      standaloneTask("s-2"),
    ];
    expect(runReadiness(blocked, "s-1", false)).toEqual({
      blockers: ["s-2"],
      gated: ["s-1"],
      runnable: false,
    });
    expect(runReadiness([standaloneTask("s-1")], "s-1", false)).toEqual({
      blockers: [],
      gated: [],
      runnable: true,
    });
  });

  it("lets a run whose tickets are all closed proceed — an empty set is not a blocked one", () => {
    // The closed-PR recovery shape: nothing left to dispatch, only the agent-free PR step. Reading
    // "no ready children" as blocked there would park a run that has nothing to wait for.
    const board = [feature("F1"), child("t-1", "F1", { status: "closed" })];
    expect(runReadiness(board, "F1", true).runnable).toBe(true);
  });
});

describe("blockedTailReason — the park a held tail leaves behind (anton-1two)", () => {
  const reason = blockedTailReason("F1", {
    blockers: ["F2", "F3"],
    held: ["t-2"],
    ran: ["t-1"],
  });

  it("stays readable by the run-health parser, so a partial park reports its blockers too", () => {
    expect(poisonBlockerIds(reason)).toEqual(["F2", "F3"]);
  });

  it("names what ran, what is held, and that no PR opens yet", () => {
    expect(reason).toContain("t-2");
    expect(reason).toContain("t-1");
    expect(reason).toMatch(/no pull request opens/);
    expect(reason).toMatch(/Resume the run once the blocker\(s\) complete/);
  });

  it("says nothing about committed work when the run had none to do", () => {
    const nothingRan = blockedTailReason("F1", { blockers: ["F2"], held: ["t-2"], ran: [] });
    expect(nothingRan).not.toMatch(/commits are on the branch/);
    expect(poisonBlockerIds(nothingRan)).toEqual(["F2"]);
  });
});

describe("ParkedAskError — the park a run takes behind its own armed gate (anton-287p)", () => {
  const parked = new ParkedAskError(new NeedsHumanError("t-1", "rotate the staging password"), "g-7");

  it("names the gate, so run-health reads one wait rather than a second failure", () => {
    // The runner parks the job on this message, and the sweep reports every poison park as an
    // exhausted job. The id is what lets it recognise the gate's own wait and drop the duplicate
    // (PR #205 review).
    expect(parkedAskGateId(parked.message)).toBe("g-7");
    expect(parkedAskGateId(`poison: ${parked.message}`)).toBe("g-7");
  });

  it("still carries the ask and the ticket that raised it", () => {
    expect(parked.message).toContain("t-1 needs a human: rotate the staging password");
    expect(parked.ticketId).toBe("t-1");
    expect(parked.name).toBe("PoisonError"); // still parks rather than burning retries
  });

  it("reads nothing back out of a park that names no gate", () => {
    expect(parkedAskGateId(new NeedsHumanError("t-1", "an ask").message)).toBeUndefined();
    expect(parkedAskGateIds(new NeedsHumanError("t-1", "an ask").message)).toBeUndefined();
  });

  it("names the holds that outlive the ask, so answering anton's gate alone isn't read as failure", () => {
    // A person's own hold keeps the target blocked after this ask is answered (PR #205 review). The
    // sweep suppresses the park while ANY named gate is open, so the ids have to be IN the message.
    const held = new ParkedAskError(
      new NeedsHumanError("t-1", "rotate the staging password"),
      "g-7",
      ["g-8", "g-9"],
    );
    expect(parkedAskGateIds(held.message)).toEqual(["g-7", "g-8", "g-9"]);
    expect(parkedAskGateId(held.message)).toBe("g-7");
    expect(held.message).toContain("g-8, g-9");
  });

  it("reads back just the armed gate when nothing else holds the target", () => {
    expect(parkedAskGateIds(parked.message)).toEqual(["g-7"]);
  });

  it("reads the MACHINE clause, not an ask that quotes it (PR #205 review)", () => {
    // The ask is agent prose and sits in front of the machine-appended clause: an agent asking a
    // person to resolve an existing gate can quote this exact sentence. A first-match parse would
    // hand the sweeps `g-quoted` — suppressing the park against a gate this run never armed while
    // the real one stays open.
    const quoting = new ParkedAskError(
      new NeedsHumanError(
        "t-1",
        "the run is parked on human gate g-quoted until someone answers it; please close it. " +
          "Even then it is also held by human gate(s) g-bogus.",
      ),
      "g-7",
      ["g-8"],
    );
    expect(parkedAskGateId(quoting.message)).toBe("g-7");
    expect(parkedAskGateIds(quoting.message)).toEqual(["g-7", "g-8"]);
  });

  it("reads ids that contain a PERIOD back whole — bd's own child ids do (PR #205 review)", () => {
    // A period-terminated capture truncates `gate-287p.1` to `gate-287p`, and the sweeps that
    // suppress on the ids would then match nothing: the park re-raises as a permanent failure while
    // the wait is still open.
    const dotted = new ParkedAskError(new NeedsHumanError("t-1.2", "an ask"), "gate-287p.1", [
      "gate-287p.2",
      "g-9",
    ]);
    expect(parkedAskGateId(dotted.message)).toBe("gate-287p.1");
    expect(parkedAskGateIds(dotted.message)).toEqual(["gate-287p.1", "gate-287p.2", "g-9"]);
    // …and still with the runner's poison prefix and prose trailing the clause.
    expect(parkedAskGateIds(`poison: ${dotted.message} Re-run once answered.`)).toEqual([
      "gate-287p.1",
      "gate-287p.2",
      "g-9",
    ]);
  });
});

describe("ticketSetDrift — the selection-to-lease window (anton-e42l)", () => {
  // A run picks its tickets before it publishes the lease that makes it visible, so for that window
  // the target reads as free to an approved gardener re-parent. The newcomer is never dispatched and
  // merge finalization closes it unrun — so the run re-confirms its set once the lease is live, and
  // a set that moved has to retry rather than run the stale half of the race.
  it("names a ticket attached to the target while the run was starting", () => {
    expect(ticketSetDrift([ticket("t-1")], [ticket("t-1"), ticket("t-2")])).toBe("attached t-2");
  });

  it("names one pulled out of the target too — the same race, the other direction", () => {
    expect(ticketSetDrift([ticket("t-1"), ticket("t-2")], [ticket("t-1")])).toBe("detached t-2");
  });

  it("reports both sides when a re-parent swapped one for another", () => {
    expect(ticketSetDrift([ticket("t-1")], [ticket("t-2")])).toBe("attached t-2; detached t-1");
  });

  it("catches a standalone target that gained its first child — the shape changed too", () => {
    expect(ticketSetDrift([], [ticket("t-1")])).toBe("attached t-1");
  });

  // runTickets filters on shape, not state, so a ticket another machine merely closed is in both
  // sets. Tripping on it would retry every run that races an ordinary cross-machine close.
  it("does not trip on a ticket whose STATE changed, or on ordering", () => {
    const closed = { ...ticket("t-2"), status: "closed" } as Bead;
    expect(ticketSetDrift([ticket("t-1"), ticket("t-2")], [closed, ticket("t-1")])).toBeUndefined();
  });
});

describe("runTargetDrift — the target's own shape in that same window (anton-e42l)", () => {
  const bead = (id: string, extra: Partial<Bead> = {}): Bead =>
    ({ id, title: id, status: "open", issue_type: "task", ...extra }) as Bead;

  // The case ticketSetDrift structurally cannot see: a parentless task has no tickets before OR
  // after the move, so the set check stays silent while the bead itself became someone else's
  // ticket — and this run would execute it alongside the run that now owns it.
  it("catches a parentless task re-parented under another card mid-startup", () => {
    const board = [bead("t-1", { parent: "epic-1" }), bead("epic-1", { issue_type: "epic" })];
    expect(ticketSetDrift([], runTickets(board, "t-1"))).toBeUndefined();
    expect(runTargetDrift("t-1", board)).toBe("it now hangs under epic-1, whose run owns it as a ticket");
  });

  it("catches a legacy epic that gained a feature child — a container is nobody's run", () => {
    const board = [
      bead("epic-1", { issue_type: "epic" }),
      bead("f-1", { issue_type: "feature", parent: "epic-1" }),
    ];
    expect(runTargetDrift("epic-1", board)).toMatch(/container epic/);
  });

  it("catches a target re-typed into something anton never runs on its own", () => {
    expect(runTargetDrift("c-1", [bead("c-1", { issue_type: "chore" })])).toBe(
      'its type is now "chore", which anton never runs on its own',
    );
  });

  it("catches a target that left the board entirely", () => {
    expect(runTargetDrift("t-1", [bead("other")])).toBe("it is no longer on the board");
  });

  it("stays silent for a target that is still a run target", () => {
    const board = [bead("f-1", { issue_type: "feature" }), bead("t-1", { parent: "f-1" })];
    expect(runTargetDrift("f-1", board)).toBeUndefined();
    expect(runTargetDrift("t-1", board)).toBe("it now hangs under f-1, whose run owns it as a ticket");
  });
});

describe("adoptRefreshedTarget — the target the human-ticket arm re-reads (PR #213 review)", () => {
  const bead = (id: string, extra: Partial<Bead> = {}): Bead =>
    ({ id, title: id, status: "open", issue_type: "feature", ...extra }) as Bead;

  // The failure this closes: `armHumanGate` pulls the shared board before every arm, so a relabel
  // another machine pushed becomes visible in the re-read that follows. That re-read rebuilt only
  // the ticket set, so `target` stayed at its pre-arm snapshot — and since the top-of-handler
  // backstop is the ONLY place that asks `agent:human`, the run went on to dispatch a person's work
  // to the default agent.
  it("refuses a target relabelled agent:human while the gates were being armed", () => {
    const stale = bead("f-1");
    const board = [bead("f-1", { labels: [LABELS.agentHuman] }), bead("t-1", { parent: "f-1" })];
    expect(() => adoptRefreshedTarget(board, "f-1", stale)).toThrow(PoisonEpic);
    expect(() => adoptRefreshedTarget(board, "f-1", stale)).toThrow(/is labelled agent:human/);
  });

  it("adopts the refreshed bead so later steps read the board's labels, not the pre-arm ones", () => {
    const stale = bead("f-1", { labels: ["approved"] });
    const fresh = bead("f-1", { labels: ["approved", "agent:fastapi"] });
    expect(adoptRefreshedTarget([fresh, bead("t-1", { parent: "f-1" })], "f-1", stale)).toBe(fresh);
  });

  // Losing the bead is runTargetDrift's question, asked under the run-lease. Answering it here too
  // would give an operator two different accounts of the same disappearance.
  it("keeps the caller's target when the refreshed board no longer carries it", () => {
    const stale = bead("f-1");
    expect(adoptRefreshedTarget([bead("other")], "f-1", stale)).toBe(stale);
  });
});

describe("orderTickets / skippedDependents — the run's own dependency graph (anton-67xj)", () => {
  const dep = (from: string, to: string): BeadDep => ({
    issue_id: from,
    depends_on_id: to,
    type: "blocks",
  });
  /** `c` depends on `b`, `b` depends on `a`; `d` is independent of all three. */
  const chain = (): Bead[] => [
    ticket("a"),
    { ...ticket("b"), dependencies: [dep("b", "a")] } as Bead,
    { ...ticket("c"), dependencies: [dep("c", "b")] } as Bead,
    ticket("d"),
  ];
  const ids = (beads: Bead[]) => beads.map((b) => b.id);
  /** A ticket the budget stopped before it delivered — the only kind whose skip cascades. */
  const rolledBack = (...tickets: string[]) => tickets.map((id) => ({ id, delivered: false }));

  it("dispatches a chain blocker-first, whatever order the board hands it back in", () => {
    const board = chain();
    const shuffled = [board[2], board[3], board[1], board[0]];
    expect(ids(orderTickets(shuffled, board))).toEqual(["d", "a", "b", "c"]);
  });

  it("skips the whole chain behind a timed-out ticket, transitively", () => {
    const board = chain();
    const cause = skippedDependents(rolledBack("a"), board, board);
    expect([...cause.keys()].sort()).toEqual(["b", "c"]);
    // The direct dependent names `a`; the transitive one names the sibling it queued behind — and
    // both name the ticket a human has to act on.
    expect(cause.get("b")).toEqual({ waitingOn: "a", stopped: "a" });
    expect(cause.get("c")).toEqual({ waitingOn: "b", stopped: "a" });
  });

  it("walks THROUGH an abandoned ticket rather than stopping at it (PR #199)", () => {
    // The run never dispatches an abandoned `b`, but it still sits on the a→b→c chain: reading the
    // graph over the live tickets alone drops both of its edges, and `c` runs against a mechanism
    // `a`'s rollback took off the branch. It is crossed, never named — `c` is the only skip here.
    const board = chain().map((t) =>
      t.id === "b" ? ({ ...t, labels: ["abandoned"] } as Bead) : t,
    );
    const cause = skippedDependents(rolledBack("a"), board, board);
    expect([...cause.keys()]).toEqual(["c"]);
    expect(cause.get("c")).toEqual({ waitingOn: "b", stopped: "a" });
  });

  it("leaves a ticket with no edge to the timed-out one alone — the run narrows, it does not halt", () => {
    const board = chain();
    expect(skippedDependents(rolledBack("a"), board, board).has("d")).toBe(false);
    // …and a timeout further down the chain takes only what is actually behind it.
    expect([...skippedDependents(rolledBack("b"), board, board).keys()]).toEqual(["c"]);
  });

  it("ignores `blocks` edges that leave the run, and non-blocking edges inside it", () => {
    const outside = [
      ticket("a"),
      { ...ticket("b"), dependencies: [dep("b", "x-9")] } as Bead,
      { ...ticket("c"), dependencies: [{ ...dep("c", "a"), type: "related" }] } as Bead,
    ];
    expect(skippedDependents(rolledBack("a"), outside, outside).size).toBe(0);
  });

  it("terminates on a cycle instead of walking it forever", () => {
    const cyclic = [
      { ...ticket("a"), dependencies: [dep("a", "c")] } as Bead,
      { ...ticket("b"), dependencies: [dep("b", "a")] } as Bead,
      { ...ticket("c"), dependencies: [dep("c", "b")] } as Bead,
    ];
    const cause = skippedDependents(rolledBack("a"), cyclic, cyclic);
    expect([...cause.keys()].sort()).toEqual(["b", "c"]);
    // orderTickets can't topologically sort a cycle either — it hands back the input order.
    expect(ids(orderTickets(cyclic, cyclic))).toEqual(["a", "b", "c"]);
  });

  it("does NOT cascade a timeout that landed after the ticket delivered", () => {
    const board = chain();
    // The deadline hit the bookkeeping, not the code: `a`'s work is on the branch, so everything
    // written against it still has what it needs and must still run. Deleting the delivered check
    // turns this into the whole chain being skipped for work that actually shipped.
    expect(skippedDependents([{ id: "a", delivered: true }], board, board).size).toBe(0);
    // …and in a run where BOTH happen, only the rolled-back one takes its dependents down: `a`
    // delivered, so `b` still ran; `b` did not, so only `c` behind it is skipped.
    const mixed = skippedDependents(
      [
        { id: "a", delivered: true },
        { id: "b", delivered: false },
      ],
      board,
      board,
    );
    expect([...mixed.keys()]).toEqual(["c"]);
    expect(mixed.get("c")).toEqual({ waitingOn: "b", stopped: "b" });
  });

  it("stops the cascade at a ticket already committed on THIS branch (PR #199 review)", () => {
    const board = chain();
    // A resume finds `b` closed on the board with its commit already on this worktree, so it is
    // delivered whatever `a` did — the same delivered-node stopping rule merge finalization uses.
    // `c` has the mechanism it was written against, so skipping it would leave valid work out of
    // the run's pull request for no reason.
    expect(skippedDependents(rolledBack("a"), board, board, new Set(["b"])).size).toBe(0);
    // …and a delivered ticket further down stops nothing above it: `b`'s own prerequisite is gone.
    expect([
      ...skippedDependents(rolledBack("a"), board, board, new Set(["c"])).keys(),
    ]).toEqual(["b"]);
  });

  it("says on the bead which ticket it waited on and which one a human must re-scope", () => {
    const direct = skipNote({ waitingOn: "a", stopped: "a" });
    expect(direct).toContain("depends on a, which ran out of time");
    expect(direct).toMatch(/Re-scope a/);

    const transitive = skipNote({ waitingOn: "b", stopped: "a" });
    expect(transitive).toContain("depends on b, which was itself skipped behind a");
    expect(transitive).toMatch(/Re-scope a/);
  });
});

describe("reorderForPrereq — a prerequisite the run holds itself (anton-0gm2)", () => {
  const dep = (from: string, to: string): BeadDep => ({
    issue_id: from,
    depends_on_id: to,
    type: "blocks",
  });
  const ids = (beads: Bead[]) => beads.map((b) => b.id);

  it("dispatches the prerequisite NEXT and puts the blocked ticket back behind it", () => {
    // `wiring` blocked naming `schema`, which the run has not reached yet. `other` is independent
    // and equally ready — the prerequisite still goes first, because that is the whole correction.
    const board = [ticket("wiring"), ticket("other"), ticket("schema")];
    const reorder = reorderForPrereq({
      ticket: ticket("wiring"),
      remaining: [ticket("other"), ticket("schema")],
      blockerId: "schema",
      drawn: [],
      all: board,
    });
    expect(reorder.ok).toBe(true);
    if (!reorder.ok) return;
    expect(ids(reorder.order)).toEqual(["schema", "other", "wiring"]);
    expect(reorder.prereqPending).toBe(true);
  });

  it("still obeys the edges already on the board — the prerequisite is a preference, not an override", () => {
    // `schema` waits on `migration`, so it cannot go first however much the re-order wants it to.
    const board = [
      ticket("wiring"),
      { ...ticket("schema"), dependencies: [dep("schema", "migration")] } as Bead,
      ticket("migration"),
    ];
    const reorder = reorderForPrereq({
      ticket: ticket("wiring"),
      remaining: [ticket("schema"), ticket("migration")],
      blockerId: "schema",
      drawn: [],
      all: board,
    });
    expect(reorder.ok).toBe(true);
    if (!reorder.ok) return;
    expect(ids(reorder.order)).toEqual(["migration", "schema", "wiring"]);
  });

  it("takes the blocked ticket LAST when the run already dispatched the prerequisite", () => {
    // Nothing is left to schedule ahead of it, so the retry the repair earned costs the tickets
    // that have not failed yet nothing — they go first.
    const board = [ticket("wiring"), ticket("other"), ticket("schema")];
    const reorder = reorderForPrereq({
      ticket: ticket("wiring"),
      remaining: [ticket("other")],
      blockerId: "schema",
      drawn: [],
      all: board,
    });
    expect(reorder.ok).toBe(true);
    if (!reorder.ok) return;
    expect(ids(reorder.order)).toEqual(["other", "wiring"]);
    expect(reorder.prereqPending).toBe(false);
  });

  it("keeps a ticket that depends on the blocked one behind it, wherever it lands", () => {
    const board = [
      ticket("wiring"),
      { ...ticket("after"), dependencies: [dep("after", "wiring")] } as Bead,
      ticket("schema"),
    ];
    const reorder = reorderForPrereq({
      ticket: ticket("wiring"),
      remaining: [ticket("after"), ticket("schema")],
      blockerId: "schema",
      drawn: [],
      all: board,
    });
    expect(reorder.ok).toBe(true);
    if (!reorder.ok) return;
    expect(ids(reorder.order)).toEqual(["schema", "wiring", "after"]);
  });

  it("honours the orderings EARLIER re-orders in the same run drew", () => {
    // Three tickets, no edges on the board. `page` blocks naming `api`, so the run records that and
    // re-orders. `api` then blocks naming `schema` — and THAT sort has to honour the first ordering
    // too: forgetting it puts `page` back ahead of `api`, where it blocks on the same missing
    // prerequisite again and the repair's one-per-bead guard parks the run on the very incident
    // this correction exists to prevent.
    const board = [ticket("page"), ticket("api"), ticket("schema")];
    const first = reorderForPrereq({
      ticket: ticket("page"),
      remaining: [ticket("api"), ticket("schema")],
      blockerId: "api",
      drawn: [],
      all: board,
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(ids(first.order)).toEqual(["api", "schema", "page"]);

    const second = reorderForPrereq({
      ticket: ticket("api"),
      remaining: [ticket("schema"), ticket("page")],
      blockerId: "schema",
      drawn: [{ blockerId: "api", ticketId: "page" }],
      all: board,
    });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(ids(second.order)).toEqual(["schema", "api", "page"]);
  });

  it("counts a carried ordering once, and ignores one nothing left can obey", () => {
    // An edge stated twice would count twice in the in-degree and read as a cycle no edge closes,
    // and an ordering whose prerequisite the loop has already passed constrains nothing left to sort.
    const board = [
      ticket("page"),
      { ...ticket("api"), dependencies: [dep("api", "schema")] } as Bead,
      ticket("schema"),
    ];
    const reorder = reorderForPrereq({
      ticket: ticket("page"),
      remaining: [ticket("api"), ticket("schema")],
      blockerId: "api",
      drawn: [
        { blockerId: "schema", ticketId: "api" }, // already on the board
        { blockerId: "api", ticketId: "page" }, // the very edge this re-order is drawing
        { blockerId: "gone", ticketId: "page" }, // dispatched already — not in what is left
      ],
      all: board,
    });
    expect(reorder.ok).toBe(true);
    if (!reorder.ok) return;
    expect(ids(reorder.order)).toEqual(["schema", "api", "page"]);
  });

  it("REFUSES a cycle rather than falling through to input order", () => {
    // `schema` already waits on `wiring`, so the new wiring→schema edge closes the loop. The
    // fallback orderTickets takes here — hand the input back — would dispatch `wiring` first all
    // over again, which is how a bad edge gets executed.
    const board = [
      ticket("wiring"),
      { ...ticket("schema"), dependencies: [dep("schema", "wiring")] } as Bead,
      ticket("other"),
    ];
    expect(ids(orderTickets([ticket("wiring"), ticket("schema")], board))).toEqual([
      "wiring",
      "schema",
    ]);
    const reorder = reorderForPrereq({
      ticket: ticket("wiring"),
      remaining: [ticket("schema"), ticket("other")],
      blockerId: "schema",
      drawn: [],
      all: board,
    });
    expect(reorder.ok).toBe(false);
    if (reorder.ok) return;
    expect(reorder.cycle.sort()).toEqual(["schema", "wiring"]);
  });

  it("says on the bead what was re-ordered and why, in both shapes", () => {
    const pending = reorderNote({
      ticketId: "wiring",
      blockerId: "schema",
      reorder: {
        ok: true,
        order: [ticket("schema"), ticket("wiring")],
        prereqPending: true,
      },
    });
    expect(pending).toContain("re-ordered, not parked");
    expect(pending).toContain("`schema`");
    expect(pending).toContain("dispatches it next");
    expect(pending).toContain("Remaining order: schema \u2192 wiring.");

    const already = reorderNote({
      ticketId: "wiring",
      blockerId: "schema",
      reorder: { ok: true, order: [ticket("wiring")], prereqPending: false },
    });
    expect(already).toContain("had already been dispatched by this run");
    expect(already).toContain("one retry");
  });
});

describe("landableTicketIds — which prerequisites this run can still land (anton-0gm2)", () => {
  const ledger = (skipped: string[] = []) => ({
    skipCause: new Map(skipped.map((id) => [id, { waitingOn: "x", stopped: "x" }])),
    skipped: new Map(),
    onBranch: new Set<string>(),
    satisfied: new Map(),
  });
  const board = () => [ticket("schema"), ticket("api"), ticket("wiring")];

  it("holds every ticket the run can still dispatch", () => {
    expect(landableTicketIds(board(), ledger(), [])).toEqual(["schema", "api", "wiring"]);
  });

  it("drops one skipped behind a rolled-back timeout — its wait is genuine, so it parks", () => {
    expect(landableTicketIds(board(), ledger(["schema"]), [])).toEqual(["api", "wiring"]);
  });

  // The stopped ticket itself is never in `skipCause` (that map holds only its DEPENDENTS), so
  // reading the skip map alone would call it a sibling and re-order the run around work that
  // already ran and rolled back — one dispatch, the identical block, then generic no-delivery.
  it("drops the timed-out ticket itself when its own work rolled back", () => {
    const timedOut = [{ id: "schema", delivered: false }];
    expect(landableTicketIds(board(), ledger(), timedOut)).toEqual(["api", "wiring"]);
  });

  // An explicitly incomplete commit is not the mechanism the blocked ticket waits for, so a
  // preserved timeout parks the same way a rolled-back one does (anton-d967).
  it("drops a timeout whose partial work was only PRESERVED — nobody finished it", () => {
    const timedOut = [{ id: "schema", delivered: false, preserved: true }];
    expect(landableTicketIds(board(), ledger(), timedOut)).toEqual(["api", "wiring"]);
  });

  it("keeps a timeout that delivered before the deadline — its work is on the branch", () => {
    const timedOut = [{ id: "schema", delivered: true }];
    expect(landableTicketIds(board(), ledger(), timedOut)).toContain("schema");
  });
});

describe("branchDelivery — whose commit on this branch carries a ticket (anton-ag76)", () => {
  /**
   * The branch as the reads see it: `<id>:` subjects, one commit's satisfies-trailers, and whether
   * that commit is one the branch ADDED (`inBase` puts it in base history instead).
   */
  const branch = (
    opts: {
      subjects?: string[];
      satisfies?: string[];
      /** Ticket ids whose BEAD NOTE records a settlement this branch bears out (PR #258 review). */
      noted?: string[];
      inBase?: boolean;
    } = {},
  ) => {
    const asked: string[] = [];
    const claim = {
      sha: "c0ffee1c0ffee1c0ffee1c0ffee1c0ffee1c0ffee",
      subject: "t-sibling: the commit that did the work",
      ticketIds: opts.satisfies ?? [],
    };
    const noted = (id: string) => ({
      sha: "dabbad0dabbad0dabbad0dabbad0dabbad0dabba",
      subject: "t-sibling: the commit the bead's note names",
      ticketIds: [id],
    });
    return {
      claim,
      noted,
      asked,
      reads: {
        hasCommitFor: async (id: string) => {
          asked.push(`subject:${id}`);
          return (opts.subjects ?? []).includes(id);
        },
        satisfiedBy: async (id: string) => {
          asked.push(`trailer:${id}`);
          return claim.ticketIds.includes(id) ? claim : undefined;
        },
        notedSatisfiedBy: async (t: Bead) => {
          asked.push(`note:${t.id}`);
          return (opts.noted ?? []).includes(t.id) ? noted(t.id) : undefined;
        },
        branchAdded: async (sha: string) => {
          asked.push(`added:${sha.slice(0, 7)}`);
          return !opts.inBase;
        },
      },
    };
  };

  /** The bead as the dispatch hands it over — only its id is read by the predicate. */
  const bead = (id: string): Bead => ({ id, title: id, status: "closed" });

  it("reads a ticket's OWN commit as delivery, without asking about siblings", async () => {
    const b = branch({ subjects: ["t-1"] });
    expect(await branchDelivery(b.reads, bead("t-1"))).toEqual({ how: "own-commit" });
    // The subject read is the cheaper, more specific answer; a hit settles it.
    expect(b.asked).toEqual(["subject:t-1"]);
  });

  it("reads a SIBLING's claim as delivery, naming the commit that made it", async () => {
    // The whole point: no commit here is subjected `t-2:`, but a sibling's commit says its work met
    // t-2's acceptance in full. Dispatching t-2 again can only produce the zero diff that blocks it.
    const b = branch({ subjects: ["t-sibling"], satisfies: ["t-2"] });
    expect(await branchDelivery(b.reads, bead("t-2"))).toEqual({
      how: "sibling",
      by: b.claim,
      inherited: false,
    });
  });

  /**
   * PR #258 review: a trailer can come from a commit already in the BASE — merged into the trunk
   * long before this run existed. The skip is right either way (the work is in the tree), but the
   * pull request must not call base history an earlier commit of this run and cite a sha its diff
   * does not contain.
   */
  it("flags a claim from BASE history as inherited, so the body does not credit this run", async () => {
    const b = branch({ subjects: ["t-sibling"], satisfies: ["t-2"], inBase: true });
    expect(await branchDelivery(b.reads, bead("t-2"))).toEqual({
      how: "sibling",
      by: b.claim,
      inherited: true,
    });
    expect(b.asked).toEqual(["subject:t-2", "trailer:t-2", "added:c0ffee1"]);
  });

  it("answers 'nothing here' when neither a subject nor a trailer claims the ticket", async () => {
    // The cross-machine shape (anton-5slr / anton-jz1): closed on the shared board, but its commit
    // lives only in another machine's unpushed worktree. Still regenerated, exactly as before.
    const b = branch({ subjects: ["t-1"], satisfies: ["t-2"] });
    expect(await branchDelivery(b.reads, bead("t-3"))).toBeUndefined();
    // No provenance read at all: there is no claim to place.
    expect(b.asked).toEqual(["subject:t-3", "trailer:t-3", "note:t-3"]);
  });

  /**
   * PR #258 review: the bead NOTE (anton-8h4b) shipped a release ahead of the commit trailer, so a
   * ticket settled in between — or one an operator closed by hand after writing the same clause — is
   * closed with a full account of which commit did its work and no trailer anywhere on the branch.
   * Without this fallback the resume reads that as the cross-machine shape and re-dispatches it into
   * the zero diff the trailer exists to prevent.
   */
  it("falls back to the bead's OWN satisfied note when no trailer claims the ticket", async () => {
    const b = branch({ subjects: ["t-sibling"], noted: ["t-2"] });
    expect(await branchDelivery(b.reads, bead("t-2"))).toEqual({
      how: "sibling",
      by: b.noted("t-2"),
      inherited: false,
    });
    // Asked in order of authority: the branch's own trailer before the note's pointer.
    expect(b.asked).toEqual(["subject:t-2", "trailer:t-2", "note:t-2", "added:dabbad0"]);
  });

  it("prefers the TRAILER over the note when both speak for the ticket", async () => {
    const b = branch({ subjects: ["t-sibling"], satisfies: ["t-2"], noted: ["t-2"] });
    expect(await branchDelivery(b.reads, bead("t-2"))).toEqual({
      how: "sibling",
      by: b.claim,
      inherited: false,
    });
    expect(b.asked).not.toContain("note:t-2");
  });

  it("fails closed to 'nothing here' when the branch read finds nothing — never to a skip", async () => {
    // Both underlying reads swallow a failed `git log` into an empty answer, and that must land on
    // re-running work rather than skipping it.
    expect(await branchDelivery(branch().reads, bead("t-1"))).toBeUndefined();
  });
});

describe("ticketPrompt", () => {
  it("inlines the full spec (description/acceptance/context) so it survives a dead in-worktree bd", () => {
    const p = ticketPrompt({
      id: "t-1",
      title: "Do the thing",
      status: "open",
      description: "## Goal\nMake it work.",
      acceptance_criteria: "- [ ] it works",
      context: "touches src/foo.ts",
    } as Bead);
    // Spec is carried in the prompt itself, not fetched via bd — the whole point of the ticket.
    expect(p).toContain("t-1 — Do the thing");
    expect(p).toContain("Make it work.");
    expect(p).toContain("- [ ] it works");
    expect(p).toContain("touches src/foo.ts");
  });

  it("frames an empty spec + failing bd as fail-loud/blocked, never a silent bailout", () => {
    const p = ticketPrompt({ id: "t-1", title: "Bare", status: "open" } as Bead);
    expect(p).toContain("(none stated)");
    expect(p).toMatch(/report the ticket as blocked/);
    expect(p).toMatch(/not guess or silently bail/);
  });

  it("inlines a description-only Acceptance section, even past the description's truncation cap", () => {
    // The gate accepts a rubric that lives only in the description; a fields-only read said
    // "(none stated)" for it whenever the truncated description block cut the section off.
    const p = ticketPrompt({
      id: "t-1",
      title: "T",
      status: "open",
      description: `## Context\n${"x".repeat(5000)}\n\n## Acceptance\n- [ ] the buried criterion`,
    } as Bead);
    expect(p).not.toContain("(none stated)");
    expect(p.slice(p.indexOf("## Acceptance criteria"))).toContain("- [ ] the buried criterion");
  });

  it("prefers acceptance_criteria but falls back to the legacy acceptance field", () => {
    const p = ticketPrompt({
      id: "t-1",
      title: "T",
      status: "open",
      acceptance: "- [ ] legacy criterion",
    } as Bead);
    expect(p).toContain("- [ ] legacy criterion");
  });

  it("does not repeat Context when it is already folded into the description markdown", () => {
    const body = "## Goal\nG\n\n## Context\ntouches src/foo.ts";
    const p = ticketPrompt({
      id: "t-1",
      title: "T",
      status: "open",
      description: body,
      context: body,
    } as Bead);
    // The standalone context block is skipped, so the folded body appears exactly once — not
    // duplicated once from `description` and again from the separate `context` column.
    expect(p.match(/touches src\/foo\.ts/g) ?? []).toHaveLength(1);
  });

  it("truncates an oversized body so it cannot bloat the prompt", () => {
    const huge = "x".repeat(10_000);
    const p = ticketPrompt({
      id: "t-1",
      title: "T",
      status: "open",
      description: huge,
      acceptance_criteria: "- [ ] ok",
    } as Bead);
    expect(p).toContain("[truncated");
    expect(p).not.toContain(huge);
  });

  it("carries the operator's human notes as binding steering, after the contract (anton-bfy4)", () => {
    const p = ticketPrompt({
      id: "t-1",
      title: "T",
      status: "open",
      acceptance_criteria: "- [ ] it works",
      notes: [
        "anton: run failed after committing work — needs review",
        formatHumanNote("reuse the existing helper", "Henri Blancke", new Date(0)),
      ].join("\n"),
    } as Bead);
    expect(p).toContain("## Human notes on this ticket");
    expect(p).toContain("reuse the existing helper");
    expect(p).toContain("Henri Blancke");
    // The steer must land after the acceptance criteria it refines, and anton's own machine notes
    // stay out — they narrate past failures, not the human's intent.
    expect(p.indexOf("Human notes")).toBeGreaterThan(p.indexOf("- [ ] it works"));
    expect(p).not.toContain("run failed after committing work");
  });

  it("adds no notes section when the bead has none", () => {
    const p = ticketPrompt({ id: "t-1", title: "T", status: "open" } as Bead);
    expect(p).not.toContain("Human notes");
  });
});

describe("continuationPrompt (anton-juar)", () => {
  it("is a brief continuation that does not re-inline the full ticket spec", () => {
    const t = {
      id: "t-1",
      title: "Do X",
      description: "## Goal\nThe whole detailed spec body",
      acceptance_criteria: "- [ ] everything",
    } as Bead;
    const p = continuationPrompt(t);
    expect(p).toContain("t-1");
    expect(p).toContain("resumed");
    expect(p).toContain("do NOT");
    // The resumed session already holds the spec, so it must not be re-inlined.
    expect(p).not.toContain("The whole detailed spec body");
  });

  // The ticket phase can dispatch several agents (a project's `step:claude` after `implement`), and
  // they all inherit this driver — so a resumed custom step must not be told its session was the
  // ticket's implementation.
  it("names the step being resumed, not just the ticket", () => {
    const t = { id: "t-1", title: "Do X", status: "open" } as Bead;
    expect(continuationPrompt(t, undefined, "smoke-test")).toContain("`smoke-test` step of t-1");
    expect(continuationPrompt(t)).toContain("t-1");
  });

  it("injects the prior error ONLY when it may be agent-caused (oversized output/context)", () => {
    const t = { id: "t-1", title: "Do X", status: "open" } as Bead;
    const agentCaused = continuationPrompt(t, "API Error: prompt is too long: 250000 tokens > 200000");
    expect(agentCaused).toContain("prompt is too long");
    expect(agentCaused).toContain("adjust your approach");
  });

  it("does NOT inject a pure-infra error the agent can't act on", () => {
    const t = { id: "t-1", title: "Do X", status: "open" } as Bead;
    const infra = continuationPrompt(t, "claude exited with code 1: Connection closed mid-response");
    expect(infra).not.toContain("Connection closed mid-response");
    expect(infra).not.toContain("adjust your approach");
  });
});

describe("claudeResumeDecision (anton-juar)", () => {
  it("escalates immediately when a resumed session repeats the same failure signature", () => {
    expect(
      claudeResumeDecision(
        { sessionId: "sess-1", signature: "connection-closed" },
        1,
        "connection-closed",
      ),
    ).toEqual({ resume: false, reason: "repeated connection-closed" });
  });

  it("allows two distinct resume attempts, then escalates when the budget is exhausted", () => {
    expect(
      claudeResumeDecision({ sessionId: "sess-1", signature: "connection-closed" }, 0),
    ).toEqual({ resume: true });
    expect(
      claudeResumeDecision(
        { sessionId: "sess-1", signature: "service-unavailable" },
        1,
        "connection-closed",
      ),
    ).toEqual({ resume: true });
    expect(
      claudeResumeDecision(
        { sessionId: "sess-1", signature: "gateway-time-out" },
        2,
        "service-unavailable",
      ),
    ).toEqual({ resume: false, reason: "resume budget spent" });
  });
});

describe("reviewParkMessage (anton-3apm)", () => {
  const note = [
    "anton: the pre-PR self-review left 1 blocking finding(s) unresolved after 2 round(s):",
    "- src/z.ts:1 — AC-2 is not implemented",
    "",
    "Resolve them (or correct the ticket), then resume the run.",
  ].join("\n");

  const message = (noted: boolean) =>
    reviewParkMessage({
      targetId: "anton-x1",
      outcome: "unresolved",
      reason: "1 blocking finding(s) survived the gate",
      note,
      noted,
      orphan: undefined,
    });

  it("points at the bead when the note landed there", () => {
    const out = message(true);
    expect(out).toContain("anton-x1 did not pass its pre-PR self-review (unresolved)");
    expect(out).toContain("the findings are on the bead");
    // The bead holds them, so the run error stays a pointer rather than a second copy.
    expect(out).not.toContain("AC-2 is not implemented");
  });

  it("reproduces the findings in full when the bd write FAILED — the run error is their only copy", () => {
    // No PR body exists on a parked run and the score comments carry counts, not notes: without
    // this the locked-DB path discards every actionable detail while telling the founder to read
    // them on the bead.
    const out = message(false);
    expect(out).toContain("writing the findings to anton-x1 FAILED");
    expect(out).not.toContain("the findings are on the bead;");
    expect(out).toContain("AC-2 is not implemented");
    expect(out).toContain("Resolve them (or correct the ticket), then resume the run.");
  });
});

/**
 * PR #253 review: a reused PR whose body could not be refreshed shows an earlier attempt's text, and
 * the note that salvages this run's findings is the only other home for its satisfied attribution —
 * no commit carries a satisfied ticket's name, so a note that dropped it would leave the founder
 * matching tickets to commits that do not exist.
 */
describe("stalePrBodyNote — the satisfied attribution rides the salvage too (PR #253 review)", () => {
  const pr = { url: "https://github.com/acme/repo/pull/42", ref: "gh-42", number: 42, bodyStale: true };
  const base = { status: "open", issue_type: "task" } as const;
  const first = { ...base, id: "anton-t1", title: "Add the schema" };
  const second = { ...base, id: "anton-t2", title: "Expose the schema" };
  const third = { ...base, id: "anton-t3", title: "Document the schema" };
  const sha = "0123456789abcdef0123456789abcdef01234567";
  const finding = { severity: "advisory" as const, location: "src/a.ts:10", note: "extract the mapper" };

  it("names each satisfied ticket against its commit, after the findings", () => {
    const note = stalePrBodyNote(
      pr,
      [finding],
      [first, second, third],
      new Map([
        [second.id, { commit: sha, subject: "anton-t1: Add the schema", closed: true }],
        [third.id, { commit: sha, subject: "anton-t1: Add the schema", closed: false }],
      ]),
    );
    expect(note).toContain("could NOT rewrite its title/body");
    expect(note).toContain("- src/a.ts:10 — extract the mapper");
    expect(note).toContain("Satisfied by earlier commits of this run (no commit of their own):");
    expect(note).toContain(`- anton-t2 — Expose the schema — by 0123456 "anton-t1: Add the schema"\n`);
    // The timed-out close is not reported as a close here either.
    expect(note).toContain(`- anton-t3 — Document the schema — by 0123456 "anton-t1: Add the schema" — NOT closed:`);
    expect(note).not.toContain("anton-t1 —");
    expect(note.indexOf("extract the mapper")).toBeLessThan(note.indexOf("Satisfied by"));
    // A note is line-delimited on the bead: no trailing blank line to leave a stray paragraph.
    expect(note.endsWith("\n")).toBe(false);
  });

  it("stays exactly as it was when nothing settled that way", () => {
    const withEmptyLedger = stalePrBodyNote(pr, [], [first, second], new Map());
    expect(withEmptyLedger).toBe(stalePrBodyNote(pr, []));
    expect(withEmptyLedger).toContain("reported no advisory findings.");
    expect(withEmptyLedger).not.toContain("Satisfied by");
  });
});

/**
 * The delivery-evidence gate's judgement on WHOSE work the commit is (anton-d967 / PR #228 review).
 *
 * A commit adopted from a previous attempt's preserved `WIP` is the one kind of evidence that says
 * of itself that it is unfinished — it exists only because a timeout cut the ticket off. So it is
 * delivery only when this run's agent affirms the ticket is done; a zero diff with no parseable
 * `ANTON-RESULT` would otherwise turn an explicitly incomplete commit into a shipped ticket.
 */
describe("assertDelivered — an adopted preserve needs this run's agent to say it is finished", () => {
  const ticket: Bead = {
    id: "anton-d967",
    title: "A ticket timeout destroys finished work",
    status: "in_progress",
    issue_type: "feature",
  };
  const progress = (selfReport: TicketProgress["selfReport"]): TicketProgress => ({
    committed: false,
    delivered: false,
    selfReport,
  });
  /** A branch read no case here needs — the gate must decide these without asking git. */
  const neverAsked = async (): Promise<boolean> => {
    throw new Error("assertDelivered asked the branch about a case that has no satisfied claim");
  };
  const gate = (facts: StepFacts, p: TicketProgress) => assertDelivered(ticket, facts, p, neverAsked);

  it("passes work THIS run committed, self-report or not", async () => {
    await expect(gate({ committed: true }, progress(null))).resolves.toBeUndefined();
  });

  it("blocks an adopted preserve the agent never affirmed", async () => {
    const err = await gate({ committed: true, preservedAdoption: true }, progress(null)).then(
      () => null,
      (e: Error) => e,
    );

    expect(err?.name).toBe("PoisonError");
    expect(err?.message).toMatch(/produced no delivery/);
    expect(err?.message).toMatch(/PRESERVED/);
  });

  it("passes an adopted preserve the agent reported delivered — the resume it exists for", async () => {
    await expect(
      gate({ committed: true, preservedAdoption: true }, progress({ outcome: "delivered" })),
    ).resolves.toBeUndefined();
  });

  it("still blocks on the agent's own word first when it reported blocked", async () => {
    await expect(
      gate(
        { committed: true, preservedAdoption: true },
        progress({ outcome: "blocked", reason: "the acceptance criteria contradict each other" }),
      ),
    ).rejects.toThrow(/self-reported blocked/);
  });

  it("records the commit verdict on the progress the ticket's exits read", async () => {
    const p = progress(null);
    await expect(gate({ committed: false }, p)).rejects.toThrow(/no delivery/);
    expect(p.committed).toBe(false);
    expect(p.delivered).toBe(false);
  });

  // The deadline can land while this gate is refusing, and the timeout then settles the ticket from
  // `progress` alone (PR #228 review). It must find the tree fact and the delivery verdict apart:
  // `committed` keeps the refused commit from being reset off the branch, `delivered` is what keeps
  // it out of the `not-delivered` skip and out of the pull request's delivered list.
  it("separates the commit on the branch from the delivery it was refused as", async () => {
    const accepted = progress(null);
    await gate({ committed: true }, accepted);
    expect(accepted).toMatchObject({ committed: true, delivered: true });

    const adopted = progress(null);
    await expect(gate({ committed: true, preservedAdoption: true }, adopted)).rejects.toThrow(
      /produced no delivery/,
    );
    expect(adopted).toMatchObject({ committed: true, delivered: false });

    const declared = progress({ outcome: "blocked", reason: "the API it needs does not exist" });
    await expect(gate({ committed: true }, declared)).rejects.toThrow(/self-reported blocked/);
    expect(declared).toMatchObject({ committed: true, delivered: false });
  });
});

/**
 * anton-nuft: a `satisfied` self-report (anton-6l0q) says an earlier commit of this run already did
 * the step's work. The gate settles it on the BRANCH — is the named commit one the run added over
 * its base — never on the claim, because a claim on an empty tree is the false success from issue
 * #46 whatever verb it uses. Every other row of the gate is pinned here unchanged.
 */
describe("assertDelivered — a satisfied step settles on evidence, never on the claim (anton-nuft)", () => {
  const ticket: Bead = {
    id: "anton-nuft",
    title: "assertDelivered settles a satisfied step on evidence",
    status: "in_progress",
    issue_type: "task",
  };
  const progress = (selfReport: TicketProgress["selfReport"]): TicketProgress => ({
    committed: false,
    delivered: false,
    selfReport,
  });
  const ON_BRANCH = "a1b2c3d4e5f";
  /** The branch as git would answer for it: one commit added over the base, everything else absent. */
  const branch = (added: string) => {
    const asked: string[] = [];
    const read = async (commit: string) => {
      asked.push(commit);
      return commit === added;
    };
    return { read, asked };
  };
  const neverAsked = async (): Promise<boolean> => {
    throw new Error("assertDelivered asked the branch about a case that has no satisfied claim");
  };
  const satisfied = (commit?: string): TicketProgress["selfReport"] => ({
    outcome: "satisfied",
    ...(commit ? { commit } : {}),
    reason: "anton-6l0q's change already covers this step",
  });
  const failure = (run: Promise<void>) => run.then(() => null, (e: Error) => e);

  it("settles a satisfied claim naming a commit the branch added, and lets the run continue", async () => {
    const evidence = branch(ON_BRANCH);
    const p = progress(satisfied(ON_BRANCH));

    await expect(assertDelivered(ticket, { committed: false }, p, evidence.read)).resolves.toBeUndefined();

    // The tree fact stays true — this ticket committed nothing — and the verdict is delivery.
    expect(p).toMatchObject({ committed: false, delivered: true });
    expect(evidence.asked).toEqual([ON_BRANCH]);
  });

  it("parks a satisfied claim naming a commit the branch did not add, as no delivery", async () => {
    const evidence = branch(ON_BRANCH);
    const p = progress(satisfied("0123456"));

    const err = await failure(assertDelivered(ticket, { committed: false }, p, evidence.read));

    expect(err?.name).toBe("PoisonError");
    expect(err?.message).toMatch(/anton-nuft produced no delivery: claude exited cleanly/);
    expect(err?.message).toMatch(/ANTON-RESULT: satisfied — 0123456/);
    expect(err?.message).toMatch(/names no commit this run's branch added over its base/);
    expect(err?.message).toMatch(/unverified — a false success on an unchanged tree/);
    expect(p).toMatchObject({ committed: false, delivered: false });
    expect(evidence.asked).toEqual(["0123456"]);
  });

  it("parks a satisfied claim naming no commit without asking the branch anything", async () => {
    const evidence = branch(ON_BRANCH);
    const p = progress(satisfied());

    const err = await failure(assertDelivered(ticket, { committed: false }, p, evidence.read));

    expect(err?.name).toBe("PoisonError");
    expect(err?.message).toMatch(/produced no delivery/);
    expect(err?.message).toMatch(/satisfied — \(no commit named\)/);
    expect(err?.message).toMatch(/names no commit this run's branch added over its base/);
    expect(p).toMatchObject({ committed: false, delivered: false });
    expect(evidence.asked).toEqual([]);
  });

  it("parks a zero diff with no satisfied claim exactly as today — the message is unchanged", async () => {
    const plain = await failure(assertDelivered(ticket, { committed: false }, progress(null), neverAsked));
    expect(plain?.name).toBe("PoisonError");
    expect(plain?.message).toBe(
      "anton-nuft produced no delivery: claude exited cleanly and passed the verify gates but " +
        "left no changes to commit (zero diff). Blocking the ticket for operator review and " +
        "halting the epic — nothing landed, so closing it would be a false success.",
    );

    const claimed = await failure(
      assertDelivered(ticket, { committed: false }, progress({ outcome: "delivered" }), neverAsked),
    );
    expect(claimed?.message).toBe(
      `${plain?.message} The agent self-reported ANTON-RESULT: delivered — a false success on an ` +
        "unchanged tree.",
    );

    const blocked = await failure(
      assertDelivered(
        ticket,
        { committed: false },
        progress({ outcome: "blocked", klass: "other", reason: "the spec is empty" }),
        neverAsked,
      ),
    );
    expect(blocked?.message).toBe(
      `${plain?.message} The agent self-reported blocked — the spec is empty, corroborating the block.`,
    );
  });

  it("leaves a normal commit-backed delivery untouched, whatever the agent reported", async () => {
    for (const report of [null, { outcome: "delivered" as const }, satisfied(ON_BRANCH), satisfied("0123456")]) {
      const p = progress(report);
      await expect(assertDelivered(ticket, { committed: true }, p, neverAsked)).resolves.toBeUndefined();
      expect(p).toMatchObject({ committed: true, delivered: true });
    }
  });

  it("keeps refusing the preserved-WIP case — preserved work is still not a delivery", async () => {
    const expected =
      "anton-nuft produced no delivery: claude left no changes to commit (zero diff) and no " +
      "`ANTON-RESULT` from this run says the ticket is finished, so the only work on the branch " +
      "is the explicitly incomplete commit a previous attempt PRESERVED when it ran out of time. " +
      "Blocking the ticket for operator " +
      "review and halting the epic — nothing this run did says that work is finished, so " +
      "adopting it as the delivery would be a false success. Finish it by hand or resume the run " +
      "with a raised ticketTimeoutMinutes.";

    const unaffirmed = progress(null);
    const plain = await failure(
      assertDelivered(ticket, { committed: true, preservedAdoption: true }, unaffirmed, neverAsked),
    );
    expect(plain?.name).toBe("PoisonError");
    expect(plain?.message).toBe(expected);
    expect(unaffirmed).toMatchObject({ committed: true, delivered: false });

    // A satisfied claim is not the affirmation the preserve needs, even for the commit it names:
    // the evidence on the branch is explicitly incomplete, and the branch is never asked.
    const claimed = progress(satisfied(ON_BRANCH));
    const refused = await failure(
      assertDelivered(ticket, { committed: true, preservedAdoption: true }, claimed, neverAsked),
    );
    expect(refused?.message).toBe(expected);
    expect(claimed).toMatchObject({ committed: true, delivered: false });
  });
});

/**
 * anton-vqql: a blocked ticket's note has to say WHY. The agent's reason is already parsed and
 * logged; these cases pin it to the bead, alongside the evidence an operator would otherwise dig
 * for — and pin the invariant that keeps the notes blob parseable: exactly one line per note.
 */
/**
 * anton-8h4b: the close is the same for a committed step and a satisfied one, so the settle path has
 * to read which it was off the progress the gate wrote — and only the shape the gate produces for a
 * verified satisfied claim (`delivered` without `committed`) may settle as satisfied.
 */
describe("satisfiedClaim — how a finished ticket settled", () => {
  const satisfied = { outcome: "satisfied" as const, commit: "a1b2c3d", reason: "covered by t1" };

  it("reads the commit and the agent's account off a verified satisfied step", () => {
    expect(satisfiedClaim({ committed: false, delivered: true, selfReport: satisfied })).toEqual({
      commit: "a1b2c3d",
      note: "covered by t1",
    });
  });

  it("answers null for a step that committed its own work, whatever it self-reported", () => {
    for (const selfReport of [null, { outcome: "delivered" as const }, satisfied]) {
      expect(satisfiedClaim({ committed: true, delivered: true, selfReport })).toBeNull();
    }
  });

  it("answers null for a step the gate did not deliver, even with a satisfied claim on it", () => {
    expect(satisfiedClaim({ committed: false, delivered: false, selfReport: satisfied })).toBeNull();
  });

  it("answers null for a zero-diff delivery with no satisfied claim — nothing to attribute", () => {
    expect(satisfiedClaim({ committed: false, delivered: true, selfReport: null })).toBeNull();
    expect(
      satisfiedClaim({ committed: false, delivered: true, selfReport: { outcome: "delivered" } }),
    ).toBeNull();
  });
});

describe("ticketBlockNote (anton-vqql)", () => {
  const HEAD = "0123456789abcdef0123456789abcdef01234567";
  const note = (over: Partial<Parameters<typeof ticketBlockNote>[0]> = {}) =>
    ticketBlockNote({
      kind: "agent-blocked",
      selfReport: { outcome: "blocked", reason: "the migration this depends on does not exist yet" },
      sessionId: "sess-1",
      branch: "anton/anton-e1",
      committed: true,
      head: HEAD,
      ...over,
    });

  /** What an operator's board actually shows: the blob parsed back into attributed entries. */
  const parsed = (text: string) => parseTicketNotes(text);

  it("carries the agent's stated reason on the agent-blocked note", () => {
    const out = note();
    expect(out).toContain(`"the migration this depends on does not exist yet"`);
    expect(out).toContain("self-reported ANTON-RESULT: blocked");
  });

  it("names its evidence — session, and the branch + short sha of the committed work", () => {
    expect(note()).toContain("[session sess-1, committed on anton/anton-e1 @ 0123456]");
  });

  it("says nothing was committed when the tree was empty", () => {
    const out = note({ kind: "no-delivery", selfReport: null, committed: false, head: undefined });
    expect(out).toContain("[session sess-1, nothing committed on anton/anton-e1]");
  });

  it("reads a `delivered` claim on an empty tree as the false success it is", () => {
    const out = note({ kind: "no-delivery", selfReport: { outcome: "delivered" }, committed: false, head: undefined });
    expect(out).toContain("run made no changes");
    expect(out).toContain("self-reported ANTON-RESULT: delivered — a false success on an unchanged tree");
  });

  it("carries a `blocked` self-report onto the no-delivery note too", () => {
    const out = note({
      kind: "no-delivery",
      selfReport: { outcome: "blocked", reason: "the acceptance criteria contradict each other" },
      committed: false,
      head: undefined,
    });
    expect(out).toContain("the acceptance criteria contradict each other");
    expect(out).toContain("corroborating the block");
  });

  it("carries the underlying error on a post-commit failure instead of a bare 'needs review'", () => {
    const out = note({ kind: "post-commit", selfReport: null, error: new Error("push rejected: non-fast-forward") });
    expect(out).toContain("run failed after committing work");
    expect(out).toContain("It failed with: push rejected: non-fast-forward");
  });

  it("degrades to the category text when the ANTON-RESULT line was missing or unparseable", () => {
    // Never an empty quote, never the string "undefined" — the two ways a naive interpolation
    // turns a missing reason into noise on the board.
    for (const out of [
      note({ selfReport: null }),
      note({ selfReport: { outcome: "blocked" } }),
      note({ selfReport: { outcome: "blocked", reason: "   " } }),
      note({ kind: "no-delivery", selfReport: { outcome: "blocked", reason: "   " }, committed: false, head: undefined }),
      note({ kind: "post-commit", selfReport: null, error: undefined }),
    ]) {
      expect(out).not.toContain('""');
      expect(out).not.toContain("undefined");
      expect(out).not.toContain("null");
    }
    expect(note({ selfReport: null })).toContain("declared the ticket incomplete (no reason given)");
    expect(note({ kind: "post-commit", selfReport: null })).toContain("needs review");
  });

  it("flattens a multi-line reason into ONE machine note", () => {
    const out = note({
      selfReport: {
        outcome: "blocked",
        reason: "criterion 3 is impossible:\n  - the API has no such field\n  - and no migration adds one",
      },
    });
    expect(out).not.toContain("\n");
    const entries = parsed(out);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ source: "system", author: "anton" });
    expect(entries[0]!.text).toContain("the API has no such field - and no migration adds one");
  });

  it("caps an overlong reason, still as ONE machine note, keeping the evidence", () => {
    const out = note({ selfReport: { outcome: "blocked", reason: "x".repeat(5_000) } });
    expect(out.length).toBeLessThan(900);
    expect(out).toContain("…");
    expect(out).toContain("[session sess-1, committed on anton/anton-e1 @ 0123456]");
    expect(parsed(out)).toHaveLength(1);
  });

  it("keeps a note appended after a human note attributed to anton, not swallowed into it", () => {
    // The blob is append-only: a machine note that leaked a newline would be re-read as a second,
    // context-free entry — or worse, as body of the human note above it.
    const blob = [
      formatHumanNote("finish the migration first", "Henri", new Date("2026-08-05T00:00:00.000Z")),
      note(),
    ].join("\n");
    const entries = parsed(blob);
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({ source: "human", author: "Henri" });
    expect(entries[1]).toMatchObject({ source: "system", author: "anton" });
    expect(entries[1]!.text).toContain("the migration this depends on does not exist yet");
  });
});

/**
 * PR #227 review: a timeout the run ABSORBS leaves the ticket blocked, and the next run's park gate
 * reads its note to choose a remedy. Without the shared evidence clause a committed timeout reads as
 * "no commit" and gets told to reopen and redo work that is already on the branch.
 */
describe("timedOutTicketNote (anton-t1mo)", () => {
  const HEAD = "0123456789abcdef0123456789abcdef01234567";
  const timedOut = (over: Partial<Parameters<typeof timedOutTicketNote>[0]> = {}) =>
    timedOutTicketNote({
      ticketId: "anton-e1",
      timeoutMs: 30 * 60_000,
      committed: true,
      delivered: true,
      leftovers: false,
      preservedOn: null,
      worktreePath: "/tmp/wt",
      sessionId: "sess-1",
      branch: "anton/anton-e1",
      head: HEAD,
      ...over,
    });

  it("records a committed timeout in the grammar the park gate reads", () => {
    const out = timedOut();
    expect(out).toContain("outlived its budget");
    expect(out).toContain("Its work IS committed on the branch");
    expect(out).toContain("[session sess-1, committed on anton/anton-e1 @ 0123456]");
    expect(latestBlockNoteCommit([out])).toEqual({
      committed: true,
      branch: "anton/anton-e1",
      head: "0123456",
    });
  });

  it("keeps a committed timeout committed when the HEAD read failed (PR #227 review)", () => {
    // `readWorktreeState` can fail on a tree that is momentarily unreadable. The sha is lost; the
    // fact that this ticket's work is on the branch is not, and the park gate turns on it.
    const out = timedOut({ head: undefined });
    expect(out).toContain("Its work IS committed on the branch");
    expect(out).toContain("[session sess-1, committed on anton/anton-e1 @ unknown]");
    expect(latestBlockNoteCommit([out])).toEqual({ committed: true, branch: "anton/anton-e1" });
  });

  it("records a rolled-back timeout as the zero-diff block it is", () => {
    const out = timedOut({ committed: false, head: undefined });
    expect(out).toContain("rolled back");
    expect(latestBlockNoteCommit([out])).toEqual({ committed: false, branch: "anton/anton-e1" });
  });

  it("reports a commit the delivery gate REFUSED as kept but undelivered", () => {
    const out = timedOut({ delivered: false });
    expect(out).toContain("REFUSED");
    expect(out).toContain("is in no pull request");
    expect(latestBlockNoteCommit([out])).toEqual({
      committed: true,
      branch: "anton/anton-e1",
      head: "0123456",
    });
  });

  // A preserve is on the branch though the ticket committed nothing of its own (anton-d967). Read as
  // a zero-diff block, the next park would tell the operator to redo the work the preserve kept.
  it("reports PRESERVED work as committed evidence", () => {
    const out = timedOut({ committed: false, delivered: false, preservedOn: "anton/anton-e1" });
    expect(out).toContain("PRESERVED on branch `anton/anton-e1`");
    expect(latestBlockNoteCommit([out])).toEqual({
      committed: true,
      branch: "anton/anton-e1",
      head: "0123456",
    });
  });

  it("names the marker a person must write for work anton could not mark", () => {
    const out = timedOut({ committed: false, delivered: false, unmarkedOn: "anton/anton-e1" });
    expect(out).toContain("could not record");
    expect(out).toContain("`WIP anton-e1:`");
    expect(latestBlockNoteCommit([out])?.committed).toBe(true);
  });

  it("still points at the worktree when the rollback failed — as ONE machine note", () => {
    const out = timedOut({ committed: false, leftovers: true, head: undefined });
    expect(out).toContain("/tmp/wt");
    expect(out).not.toContain("\n");
    expect(parseTicketNotes(out)).toHaveLength(1);
  });
});

/**
 * anton-k0kj: arming the merge wait is a decision about EVERY gate on the target, not just the
 * first one seen — a resolve that failed on an earlier run leaves a stale gate open alongside the
 * live one, and bd never auto-resolves it (a closed-unmerged PR escalates forever).
 */
describe("mergeGatePlan", () => {
  const gate = (id: string, awaitId: string, o: Partial<Gate> = {}): Gate =>
    ({ id, title: id, status: "open", issue_type: "gate", await_type: "gh:pr", await_id: awaitId, ...o }) as Gate;

  const target = (...gateIds: string[]): Bead =>
    ({
      id: "f-1",
      title: "f-1",
      status: "open",
      dependencies: gateIds.map((g) => ({ issue_id: "f-1", depends_on_id: g, type: "blocks" })),
    }) as Bead;

  it("creates the wait when the target carries none", () => {
    expect(mergeGatePlan([target()], "f-1", "9")).toEqual({ stale: [], create: true });
  });

  it("creates nothing when this PR's wait is already armed", () => {
    const board = [target("g-9"), gate("g-9", "9")];
    expect(mergeGatePlan(board, "f-1", "9")).toEqual({ stale: [], create: false });
  });

  it("resolves EVERY stale gate even when the current one is seen first", () => {
    // The failure this guards: a prior gateResolve that failed leaves #3 open next to #9. Returning
    // at #9 would leave #3 to be surfaced later as a stall against a PR nobody is waiting on.
    const board = [target("g-9", "g-3"), gate("g-9", "9"), gate("g-3", "3")];
    const plan = mergeGatePlan(board, "f-1", "9");
    expect(plan.stale.map((g) => g.id)).toEqual(["g-3"]);
    expect(plan.create).toBe(false); // …and no second gate races the live wait
  });

  it("supersedes an old PR's wait and arms the new one", () => {
    const board = [target("g-3"), gate("g-3", "3")];
    const plan = mergeGatePlan(board, "f-1", "9");
    expect(plan.stale.map((g) => g.id)).toEqual(["g-3"]);
    expect(plan.create).toBe(true);
  });

  it("ignores closed gates, non-blocks edges, and gates of another flavour", () => {
    const board = [
      target("g-closed", "g-related", "g-timer"),
      gate("g-closed", "3", { status: "closed" }),
      gate("g-related", "4"),
      gate("g-timer", "5", { await_type: "timer" }),
    ];
    const withRelated = [
      { ...board[0], dependencies: [{ issue_id: "f-1", depends_on_id: "g-related", type: "related" }] } as Bead,
      board[1],
      board[2],
      board[3],
    ];
    expect(mergeGatePlan(board, "f-1", "9").stale.map((g) => g.id)).toEqual(["g-related"]);
    expect(mergeGatePlan(withRelated, "f-1", "9")).toEqual({ stale: [], create: true });
  });
});

/**
 * anton-287p.4: the human wait must be re-enterable. A settle lost after the gate landed, a resume,
 * or a fresh worktree on another machine all re-run the arm — and unlike every other flavour, a
 * human gate is a REAL blocker that nothing but a person ever closes, so both a duplicate and a
 * superseded leftover keep the target unrunnable.
 */
describe("humanGatePlan", () => {
  const ASK = "the sandbox Stripe key is not something I can create";
  /** A gate as bd returns it: the reason lives inside the description bd composes. */
  const gate = (id: string, reason: string, o: Partial<Gate> = {}): Gate =>
    ({
      id,
      title: "Gate: human",
      status: "open",
      issue_type: "gate",
      await_type: "human",
      description: `Ad-hoc gate blocking f-1\n\nReason: ${reason}`,
      labels: [HUMAN_GATE_ARMED_LABEL],
      ...o,
    }) as Gate;

  /** The other author: a hold a person hung on the target by hand, carrying no anton label. */
  const handHeld = (id: string, reason: string, o: Partial<Gate> = {}): Gate =>
    gate(id, reason, { labels: [], ...o });

  const target = (...gateIds: string[]): Bead =>
    ({
      id: "f-1",
      title: "f-1",
      status: "open",
      dependencies: gateIds.map((g) => ({ issue_id: "f-1", depends_on_id: g, type: "blocks" })),
    }) as Bead;

  it("creates the wait when the target carries none", () => {
    expect(humanGatePlan([target()], "f-1", ASK)).toEqual({ stale: [], held: [], open: undefined });
  });

  it("reuses the gate already carrying this ask rather than racing it with a second", () => {
    const plan = humanGatePlan([target("g-1"), gate("g-1", ASK)], "f-1", ASK);
    expect(plan.open?.id).toBe("g-1");
    expect(plan.stale).toEqual([]);
  });

  it("supersedes a gate whose ask no longer applies", () => {
    const plan = humanGatePlan([target("g-old"), gate("g-old", "an older ask")], "f-1", ASK);
    expect(plan.stale.map((g) => g.id)).toEqual(["g-old"]);
    expect(plan.held).toEqual([]);
    expect(plan.open).toBeUndefined();
  });

  it("leaves a hold a person armed alone, however stale its reason looks", () => {
    // The contract this protects: `bd gate create --blocks f-1` is a founder's "stop until I say
    // so". Reading it as anton's leftover would auto-resolve someone's explicit hold the moment an
    // agent stopped for an unrelated ask.
    const board = [target("g-mine", "g-theirs"), gate("g-mine", "an older ask"), handHeld("g-theirs", "hold: talking to legal")];
    const plan = humanGatePlan(board, "f-1", ASK);
    expect(plan.stale.map((g) => g.id)).toEqual(["g-mine"]);
    expect(plan.held.map((g) => g.id)).toEqual(["g-theirs"]);
  });

  it("still reuses an anton gate whose label write was lost, rather than arming a twin", () => {
    // Ownership narrows what may be CLOSED, never what may be reused: an arm that created the gate
    // and then failed to tag it must still re-enter onto that same wait.
    const plan = humanGatePlan([target("g-1"), handHeld("g-1", ASK)], "f-1", ASK);
    expect(plan.open?.id).toBe("g-1");
    expect(plan.stale).toEqual([]);
    expect(plan.held).toEqual([]);
  });

  it("resolves EVERY stale gate even when the live one is seen first", () => {
    // The failure this guards: a gateResolve that failed on an earlier run leaves the old ask open
    // next to the current one. Stopping at the live gate would leave it blocking the target forever
    // — no `bd gate check` and no expiry pass ever looks at a human gate.
    const board = [target("g-1", "g-a", "g-b"), gate("g-1", ASK), gate("g-a", "ask A"), gate("g-b", "ask B")];
    const plan = humanGatePlan(board, "f-1", ASK);
    expect(plan.open?.id).toBe("g-1");
    expect(plan.stale.map((g) => g.id)).toEqual(["g-a", "g-b"]);
  });

  it("ignores resolved gates, non-blocks edges, and gates of another flavour", () => {
    const board = [
      target("g-closed", "g-related", "g-merge"),
      gate("g-closed", ASK, { status: "closed" }),
      gate("g-related", "a related ask"),
      gate("g-merge", "merge wait", { await_type: "gh:pr" }),
    ];
    // A closed gate is a wait a person already ended — its ask must not be reused, so this arms anew.
    expect(humanGatePlan(board, "f-1", ASK)).toMatchObject({ open: undefined });
    expect(humanGatePlan(board, "f-1", ASK).stale.map((g) => g.id)).toEqual(["g-related"]);
    const related = [
      { ...board[0], dependencies: [{ issue_id: "f-1", depends_on_id: "g-related", type: "related" }] } as Bead,
      board[2],
    ];
    expect(humanGatePlan(related, "f-1", ASK)).toEqual({ stale: [], held: [], open: undefined });
  });

  it("matches the ask an agent that named none gets, so that gate is reused too", () => {
    const reason = humanGateReason("f-1", { ticketId: "t-1", ask: undefined });
    const plan = humanGatePlan([target("g-1"), gate("g-1", reason)], "f-1", reason);
    expect(plan.open?.id).toBe("g-1");
  });

  it("names the asking TICKET in the reason, not just the target the gate blocks", () => {
    // The gate blocks the run target, so on a feature with several children its own id is the only
    // thing the escalation surface could otherwise recover (PR #205 review) — and an answer left on
    // the feature reaches no dispatch: the resumed session reads notes off the ticket it re-runs.
    expect(humanGateReason("f-1", { ticketId: "t-9", ask: ASK })).toBe(`t-9 needs a human: ${ASK}`);
    expect(humanGateReason("f-1", { ticketId: "t-9", ask: undefined })).toContain("t-9 needs a human:");
  });
});

describe("askSettleError — a cancellation that overtakes the ask (anton-287p)", () => {
  const ask = new NeedsHumanError("t-1", "someone must approve the vendor contract");

  it("keeps the ask when nothing cancelled the run, so the gate is armed", () => {
    expect(askSettleError(ask, new AbortController().signal)).toBe(ask);
  });

  it("reads the signal at the settle, not when the error was caught", () => {
    // The regression this guards: the handler unwinds through several awaited bd writes (releasing
    // the children it reserved) before it settles, so a kill can land AFTER the catch. A snapshot
    // taken on the way in would still arm a `human` gate — permanent board state blocking a target
    // nobody is waiting on — for a run an operator just killed.
    const controller = new AbortController();
    expect(askSettleError(ask, controller.signal)).toBe(ask);
    controller.abort();
    const settled = askSettleError(ask, controller.signal);
    expect(settled).not.toBe(ask);
    expect((settled as Error).name).toBe("PoisonError"); // still parks; a retry can't answer an ask
    expect((settled as Error).message).toContain("armed NO gate");
    expect((settled as Error).message).toContain("someone must approve the vendor contract");
  });

  it("passes every other error through untouched, cancelled or not", () => {
    const other = new Error("the build broke");
    const controller = new AbortController();
    controller.abort();
    expect(askSettleError(other, controller.signal)).toBe(other);
    expect(askSettleError(other, new AbortController().signal)).toBe(other);
  });
});

describe("isForeignRunOwner — what proves another machine owns the branch (anton-hrun.1)", () => {
  it("accepts only a CONFIRMED foreign lease", () => {
    expect(isForeignRunOwner(new RunAlreadyLiveError("another machine is running it", "foreign"))).toBe(
      true,
    );
  });

  it("refuses a lease this run merely couldn't keep — an unproven conflict names no owner", () => {
    // The teardown and the orphan reconcile both hand the branch over on this: read as foreign, an
    // `unproven` conflict strands a worktree and branch nobody else claims until a later sweep.
    expect(isForeignRunOwner(new RunAlreadyLiveError("lease expired mid-run"))).toBe(false);
    expect(isForeignRunOwner(new RunAlreadyLiveError("lease expired mid-run", "unproven"))).toBe(false);
  });

  it("refuses any other failure — a crash is not a foreign owner", () => {
    expect(isForeignRunOwner(new Error("boom"))).toBe(false);
    expect(isForeignRunOwner(undefined)).toBe(false);
  });
});

describe("deliveredTickets — what the run's own steps speak for", () => {
  const human = (id: string) => ticket(id, [LABELS.agentHuman]);
  /** The branch, as `worktreeHasCommitFor` reads it. */
  const branch = (...ids: string[]) => {
    const asked: string[] = [];
    const has = async (id: string) => {
      asked.push(id);
      return ids.includes(id);
    };
    return { has, asked };
  };

  it("drops a rolled-back ticket and a human one that left no commit", async () => {
    const b = branch("t-1");
    expect(
      (await deliveredTickets([ticket("t-1"), ticket("t-2"), human("t-3")], new Set(["t-2"]), b.has))
        .map((t) => t.id),
    ).toEqual(["t-1"]);
    // Only a human ticket is worth a git call — the label is what makes the branch the tie-breaker.
    expect(b.asked).toEqual(["t-3"]);
  });

  it("keeps a human-labelled ticket a SIBLING's commit satisfied (PR #258 review)", async () => {
    // An agent attempted t-2 and a sibling's commit met its acceptance in full; someone relabelled
    // it `agent:human` before the parked run resumed. Nothing on the branch carries its id, so the
    // branch question cannot see it — but the ledger proved the work is here, and the PR body owes
    // a reader the commit that did it. Dropping it would omit the attribution entirely.
    const b = branch();
    expect(
      (await deliveredTickets([human("t-2")], new Set(), b.has, new Set(["t-2"]))).map((t) => t.id),
    ).toEqual(["t-2"]);
    // The ledger already answered — no git call is worth making.
    expect(b.asked).toEqual([]);
  });

  it("keeps a human-labelled ticket whose commit IS on the branch (PR #213 review)", async () => {
    // An agent committed and closed t-2 on an earlier attempt; someone labelled it `agent:human`
    // before the parked run resumed. Its code is in the diff, so the review contract and the PR body
    // must carry it — and, as the ONLY ticket, dropping it made the no-delivery park claim an empty
    // branch that has commits on it.
    const b = branch("t-2");
    expect((await deliveredTickets([human("t-2")], new Set(), b.has)).map((t) => t.id)).toEqual([
      "t-2",
    ]);
  });
});

describe("reopenableAfterStop — whose timed-out ticket is it now (PR #199 review)", () => {
  /** The state runTicket's rolled-back timeout leaves behind, and the run's release then unowns. */
  const stalled = (over: Partial<Bead> = {}): Bead =>
    ({
      id: "t1",
      title: "t1",
      status: "blocked",
      labels: ["not-delivered"],
      ...over,
    }) as Bead;

  it("reopens the ticket this run's timeout left blocked", () => {
    expect(reopenableAfterStop(stalled())).toBe(true);
  });

  it("reopens one the best-effort block write never reached", () => {
    // `beads.setStatus(blocked)` is best-effort in the timeout path, so its failure leaves the bead
    // `in_progress` and unowned — which `bd update --claim` refuses just as flatly.
    expect(reopenableAfterStop(stalled({ status: "in_progress" }))).toBe(true);
  });

  it("leaves a ticket somebody has since CLAIMED alone", () => {
    // A resumed attempt on another machine took this bead while the run walked its independent
    // tickets. Resetting it to `open` advertises live work as claimable and invites a second run.
    expect(
      reopenableAfterStop(stalled({ status: "in_progress", assignee: "someone@else" })),
    ).toBe(false);
  });

  it("leaves a human's own verdict alone", () => {
    // Closed or abandoned is a person's decision about this ticket; reopening re-queues work they
    // just killed.
    expect(reopenableAfterStop(stalled({ status: "closed" }))).toBe(false);
    expect(
      reopenableAfterStop(stalled({ status: "closed", labels: ["not-delivered", "abandoned"] })),
    ).toBe(false);
  });

  it("leaves a ticket that has since been RE-RUN alone", () => {
    // runTicket clears `not-delivered` the moment it claims the bead, so a marker that is gone means
    // another attempt is delivering this work — its status is that run's to hold, not ours to reset.
    expect(reopenableAfterStop(stalled({ labels: [] }))).toBe(false);
  });

  it("writes nothing to a ticket already back at `open`", () => {
    expect(reopenableAfterStop(stalled({ status: "open" }))).toBe(false);
  });
});

describe("reopenAbsorbedTimeouts — the predicate and the write, under one lock (PR #199 review)", () => {
  /** A fresh repo path per case: the lock's chain map is process-wide, so keys are what isolates. */
  let repos = 0;
  const repo = () => `/tmp/reopen-timeouts-${++repos}`;

  /** The board as a mutable row, so a competing claim and the reopen contend over ONE state. */
  function board(initial: Partial<Bead> = {}) {
    let row = {
      id: "t1",
      title: "t1",
      status: "blocked",
      labels: ["not-delivered"],
      ...initial,
    } as Bead;
    return {
      get current() {
        return row;
      },
      show: async () => row,
      setStatus: async (_cwd: string, _id: string, status: string) => {
        row = { ...row, status } as Bead;
      },
      claim: (actor: string) => {
        row = { ...row, status: "in_progress", assignee: actor } as Bead;
      },
    };
  }

  /** Drain the queue, so "did it read yet?" is answered after everything that could have run. */
  const settle = () => new Promise((r) => setTimeout(r, 0));

  it("reopens a rolled-back timeout and leaves a delivered one blocked", async () => {
    const bd = board();
    await reopenAbsorbedTimeouts(repo(), "epic-1", [{ id: "t1", delivered: false }], bd);
    expect(bd.current.status).toBe("open");

    const delivered = board();
    await reopenAbsorbedTimeouts(repo(), "epic-1", [{ id: "t1", delivered: true }], delivered);
    expect(delivered.current.status).toBe("blocked");
  });

  it("holds the lock across the read, so a claim cannot land between predicate and write", async () => {
    // The race this closes: a concurrent claim (another run's claim gate, an operator's Claim) that
    // arrives after the ticket reads as reopenable. Unserialized, the unconditional `open` below
    // would knock that freshly-claimed bead back into `bd ready` while its agent runs.
    const path = repo();
    const bd = board();
    const reading = defer(); // the reopen has entered its re-read
    const release = defer(); // …and is held there until the competing claim has been attempted

    const reopen = reopenAbsorbedTimeouts(path, "epic-1", [{ id: "t1", delivered: false }], {
      show: async () => {
        reading.resolve();
        await release.promise;
        return bd.show();
      },
      setStatus: bd.setStatus,
    });

    await reading.promise;
    let claimed = false;
    const claim = withBeadWriteLock(path, "t1", async () => {
      bd.claim("someone@else");
      claimed = true;
    });
    await settle();
    expect(claimed).toBe(false); // queued on the bead's chain, not landing mid-sequence

    release.resolve();
    await Promise.all([reopen, claim]);

    // The reopen finished on the ticket it read; the claim then took the ticket it left at `open`.
    expect(bd.current.status).toBe("in_progress");
    expect(bd.current.assignee).toBe("someone@else");
  });

  it("sees a claim taken before its turn and writes nothing", async () => {
    // The other order on the same chain: the claim wins, and the reopen's re-read — taken INSIDE
    // the lock, so it cannot be stale — finds an owner and leaves the ticket alone.
    const path = repo();
    const bd = board();
    const held = defer();
    const writes: string[] = [];
    // Hold the ticket's lock so the claim is guaranteed to reach the chain before the reopen does.
    const gate = withBeadWriteLock(path, "t1", () => held.promise);
    const claim = withBeadWriteLock(path, "t1", async () => {
      bd.claim("someone@else");
    });
    const reopen = reopenAbsorbedTimeouts(path, "epic-1", [{ id: "t1", delivered: false }], {
      show: bd.show,
      setStatus: async (cwd, id, status) => {
        writes.push(status);
        return bd.setStatus(cwd, id, status);
      },
    });

    held.resolve();
    await Promise.all([gate, claim, reopen]);

    expect(writes).toEqual([]);
    expect(bd.current.status).toBe("in_progress");
    expect(bd.current.assignee).toBe("someone@else");
  });

  it("takes the lock before it reads, so the predicate can never be decided outside it", async () => {
    const path = repo();
    const bd = board();
    const held = defer();
    let read = false;
    const gate = withBeadWriteLock(path, "t1", () => held.promise);

    const reopen = reopenAbsorbedTimeouts(path, "epic-1", [{ id: "t1", delivered: false }], {
      show: async () => {
        read = true;
        return bd.show();
      },
      setStatus: bd.setStatus,
    } as ReopenBoard);

    await settle();
    expect(read).toBe(false); // still queued — nothing has been decided yet

    held.resolve();
    await Promise.all([gate, reopen]);
    expect(read).toBe(true);
    expect(bd.current.status).toBe("open");
  });

  it("leaves the ticket as it stands when the re-read fails, and never throws", async () => {
    const bd = board();
    await expect(
      reopenAbsorbedTimeouts(repo(), "epic-1", [{ id: "t1", delivered: false }], {
        show: async () => {
          throw new Error("bd unavailable");
        },
        setStatus: bd.setStatus,
      } as ReopenBoard),
    ).resolves.toBeUndefined();
    expect(bd.current.status).toBe("blocked");
  });
});

/**
 * The phase's sticky self-report keeps the most ACTIONABLE outcome any of its steps made. The
 * fourth outcome (anton-6l0q) is placed at the bottom on purpose: a step that says "an earlier
 * commit already covers me" must not talk down a sibling that delivered, blocked, or asked.
 */
describe("selfReportRank — where `satisfied` sits among the outcomes (anton-6l0q)", () => {
  it("orders ask > block > delivered > satisfied > nothing", () => {
    expect(selfReportRank("needs-human")).toBeGreaterThan(selfReportRank("blocked"));
    expect(selfReportRank("blocked")).toBeGreaterThan(selfReportRank("delivered"));
    expect(selfReportRank("delivered")).toBeGreaterThan(selfReportRank("satisfied"));
    expect(selfReportRank("satisfied")).toBeGreaterThan(selfReportRank(undefined));
  });

  it("lets a satisfied report set the phase's report only when nothing else has", () => {
    const satisfied = { outcome: "satisfied", commit: "0a76266d" } as const;
    expect(displacesSelfReport(satisfied, null)).toBe(true);
    expect(displacesSelfReport({ ...satisfied, commit: "f6348077" }, satisfied)).toBe(true);
    expect(displacesSelfReport(satisfied, { outcome: "delivered" })).toBe(false);
    expect(displacesSelfReport(satisfied, { outcome: "blocked", klass: "other" })).toBe(false);
    expect(displacesSelfReport(satisfied, { outcome: "needs-human" })).toBe(false);
  });

  // The phase may dispatch a project's own `step:claude` after `implement` (PR #253 review). It
  // reports on its own work, and "delivered" on the tree the implementer left unchanged would
  // replace the one report carrying the commit the gate can settle that zero diff against.
  it("keeps a satisfied claim over a later `delivered`, though delivered outranks it", () => {
    const satisfied = { outcome: "satisfied", commit: "0a76266d" } as const;
    expect(selfReportRank("delivered")).toBeGreaterThan(selfReportRank("satisfied"));
    expect(displacesSelfReport({ outcome: "delivered" }, satisfied)).toBe(false);
    // Everything more actionable than a delivery still displaces it.
    expect(displacesSelfReport({ outcome: "blocked", klass: "env" }, satisfied)).toBe(true);
    expect(displacesSelfReport({ outcome: "needs-human", reason: "a key" }, satisfied)).toBe(true);
    // And a delivery replaces a delivery, so the ordinary phase keeps its last word.
    expect(displacesSelfReport({ outcome: "delivered" }, { outcome: "delivered" })).toBe(true);
    expect(displacesSelfReport({ outcome: "delivered" }, null)).toBe(true);
  });
});
