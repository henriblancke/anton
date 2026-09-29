/**
 * anton-wjfkn: an agent that sets its own work aside and hands its turn back must never be settled as
 * a zero-diff no-delivery.
 *
 * The incident (2026-09-27, fati run 46dc05f7, ticket fati-8sme): the agent implemented the ticket
 * (+171 lines, tests green), hit a coverage floor, ran `git stash -u` to measure the baseline, started
 * that measurement in the background and scheduled a wakeup. anton read the yielded turn as a clean
 * exit over an empty tree — `[no-delivery]`, the ticket blocked, the epic halted, the worktree removed
 * — and a stash commit in the shared repository was left as the only copy of the work.
 *
 * Two independent readings were wrong, and both are pinned here:
 *
 *   • the TREE was never empty (it was stashed), so the delivery gate may not call it a zero diff;
 *   • the TURN was never finished (it was yielded), so no gate downstream should have run at all.
 *
 * Unit-level: the gate and the walk's yield check, over injected stash reads. The end-to-end proof
 * against real git/bd is `execute-epic.stashed-work.integration.test.ts`.
 */
import { describe, expect, it } from "vitest";
import type { Bead } from "../beads/bd";
import {
  AgentYieldedError,
  holdsRecoverableWork,
  StashBaselineUnreadableError,
  StashedWorkError,
} from "./execute-epic-errors";
import {
  assertDelivered,
  recordStepReport,
  stashEntryOnBranch,
  type StashRecovery,
} from "./execute-epic-ticket";
import type { TicketProgress } from "./execute-epic-ticket-settle";
import { ticketBlockNote } from "./execute-epic-ticket-settle";
import type { StepFacts } from "./step-registry";

const TICKET: Bead = {
  id: "anton-wjfkn",
  title: "A stashing agent is settled as zero-diff no-delivery",
  status: "in_progress",
  issue_type: "task",
};

const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);

const progress = (selfReport: TicketProgress["selfReport"] = null): TicketProgress => ({
  committed: false,
  delivered: false,
  selfReport,
});

/** The branch read no case here needs — nothing below makes a `satisfied` claim. */
const neverAsked = async (): Promise<boolean> => {
  throw new Error("the gate asked the branch about a case that has no satisfied claim");
};

/**
 * A stash stack that GAINED `gained` while the ticket ran, recording which shas the gate asked to
 * apply and answering each from `fails`.
 */
const stashing = (gained: string[], fails: string[] = []) => {
  const applied: string[] = [];
  const stash: StashRecovery = {
    gained: async () => gained.map((sha) => ({ sha, subject: `On anton/wjfkn: ${sha.slice(0, 4)}` })),
    apply: async (sha) => {
      applied.push(sha);
      return !fails.includes(sha);
    },
  };
  return { stash, applied };
};

const NO_STASH: StashRecovery = {
  gained: async () => [],
  apply: async () => {
    throw new Error("the gate applied a stash entry for a tree that gained none");
  },
};

const failure = (run: Promise<unknown>) => run.then(() => null, (e: Error) => e);

/**
 * anton-wjfkn round 2 (pre-PR review): `refs/stash` is repository-wide, and anton runs several
 * epics' worktrees off one repo concurrently — a sibling ticket's OWN push can land between this
 * ticket's baseline read and its own gained-check, which the baseline-by-sha diff alone cannot
 * distinguish from this ticket's own entry. The subject is the one field that names whose checkout
 * pushed it, so `gained()` must scope by it too.
 */
describe("stashEntryOnBranch — telling a sibling worktree's push from this ticket's own (anton-wjfkn)", () => {
  it("matches an explicit `git stash push -m` on this ticket's branch", () => {
    expect(stashEntryOnBranch({ sha: SHA_A, subject: "On anton/anton-wjfkn: measuring" }, "anton/anton-wjfkn")).toBe(
      true,
    );
  });

  it("matches a bare autostash (`WIP on <branch>`) on this ticket's branch", () => {
    expect(
      stashEntryOnBranch({ sha: SHA_A, subject: "WIP on anton/anton-wjfkn: abc1234 msg" }, "anton/anton-wjfkn"),
    ).toBe(true);
  });

  it("refuses a sibling ticket's entry pushed from a DIFFERENT branch", () => {
    expect(stashEntryOnBranch({ sha: SHA_A, subject: "On anton/anton-other: their work" }, "anton/anton-wjfkn")).toBe(
      false,
    );
  });

  // A prefix match (`anton/anton-wjfkn-2` starting with `anton/anton-wjfkn`) is exactly the kind of
  // false positive an unanchored substring check would produce — the branch name must match to the
  // colon, not merely appear as a prefix of a longer one.
  it("refuses a branch name that only shares this ticket's branch as a prefix", () => {
    expect(
      stashEntryOnBranch({ sha: SHA_A, subject: "On anton/anton-wjfkn-2: their work" }, "anton/anton-wjfkn"),
    ).toBe(false);
  });

  it("treats a branch name containing regex metacharacters as a literal", () => {
    expect(stashEntryOnBranch({ sha: SHA_A, subject: "On feature/a.b+c: work" }, "feature/a.b+c")).toBe(true);
    expect(stashEntryOnBranch({ sha: SHA_A, subject: "On featureXaXbXc: work" }, "feature/a.b+c")).toBe(false);
  });
});

describe("assertDelivered — an empty tree that is merely SET ASIDE is no zero diff (anton-wjfkn)", () => {
  it("refuses the no-delivery block when the worktree gained a stash entry", async () => {
    const { stash } = stashing([SHA_A]);
    const p = progress();

    const err = await failure(assertDelivered(TICKET, { committed: false }, p, neverAsked, stash));

    // NOT a NoDeliveryError: the class is what the settle, the block note and the worktree teardown
    // all branch on, so the distinction has to be in the type rather than only in the prose.
    expect(err).toBeInstanceOf(StashedWorkError);
    expect((err as StashedWorkError).stashes).toEqual([SHA_A]);
    // Still poison — re-running the agent finds the same set-aside tree — and still not a delivery.
    expect(err?.name).toBe("PoisonError");
    expect(p).toMatchObject({ committed: false, delivered: false });
  });

  it("restores the stashed work into the tree, oldest entry first", async () => {
    // Two entries: a measure-the-baseline loop can stash more than once, and replaying a STACK
    // newest-first would lay an earlier snapshot over a later one.
    const { stash, applied } = stashing([SHA_B, SHA_A]);

    await failure(assertDelivered(TICKET, { committed: false }, progress(), neverAsked, stash));

    expect(applied).toEqual([SHA_A, SHA_B]);
  });

  it("names every stash sha in the message, so the durable copy is reachable", async () => {
    const { stash } = stashing([SHA_B, SHA_A]);

    const err = await failure(assertDelivered(TICKET, { committed: false }, progress(), neverAsked, stash));

    expect(err?.message).toContain(SHA_A);
    expect(err?.message).toContain(SHA_B);
    expect(err?.message).toContain("gained 2 stash entries");
    expect(err?.message).toContain("git stash apply <sha>");
    // The remedy: recover, not re-implement. A zero-diff park says the opposite.
    expect(err?.message).toContain("worktree is KEPT");
    expect(err?.message).not.toMatch(/zero diff/);
  });

  it("reports an apply that failed rather than claiming the work is back in the tree", async () => {
    const { stash } = stashing([SHA_A], [SHA_A]);

    const err = await failure(assertDelivered(TICKET, { committed: false }, progress(), neverAsked, stash));

    expect(err?.message).toContain("could NOT apply");
    expect(err?.message).toContain("only copy");
    // The entry is still named, which is the whole recovery path when the apply cannot land.
    expect((err as StashedWorkError).stashes).toEqual([SHA_A]);
  });

  it("says so when only some entries came back", async () => {
    const { stash } = stashing([SHA_B, SHA_A], [SHA_B]);

    const err = await failure(assertDelivered(TICKET, { committed: false }, progress(), neverAsked, stash));

    expect(err?.message).toContain("applied 1 of 2");
    expect(err?.message).toContain(SHA_B);
  });

  // The agent's own word still travels, exactly as it does on a zero-diff block: a `delivered` claim
  // over a stashed tree is the same false success, and the operator is owed the quote either way.
  it("folds the agent's self-report into the reason", async () => {
    const { stash } = stashing([SHA_A]);
    const p = progress({ outcome: "delivered" });

    const err = await failure(assertDelivered(TICKET, { committed: false }, p, neverAsked, stash));

    expect(err?.message).toContain("ANTON-RESULT: delivered");
    expect((err as StashedWorkError).selfReport).toEqual({ outcome: "delivered" });
    // The structural half stays anton's own account, recoverable without re-parsing the message.
    expect((err as StashedWorkError).structural).not.toContain("ANTON-RESULT: delivered");
  });

  /**
   * The stash is checked even on a committed tree (anton-wjfkn, PR #333 review round 2): a commit that
   * closes cleanly with nothing gained on the stack is exactly as ordinary a delivery as it always was.
   */
  it("asks the stash even when the ticket committed, and delivers when it gained nothing", async () => {
    const asked = { gained: false };
    const stash: StashRecovery = {
      gained: async () => {
        asked.gained = true;
        return [];
      },
      apply: async () => true,
    };

    await expect(
      assertDelivered(TICKET, { committed: true }, progress(), neverAsked, stash),
    ).resolves.toBeUndefined();
    expect(asked.gained).toBe(true);
  });

  /**
   * The gap this closes (anton-wjfkn, PR #333 review round 2): an agent that commits most of its diff
   * and stashes the rest — deliberately or by mistake — used to sail through here, because the stash
   * check only ever ran on the zero-diff path. `committed: true` must not exempt a ticket from it: the
   * commit alone is not proof the whole change is on the branch.
   */
  it("refuses delivery when the ticket committed only part of its work and the rest is stashed", async () => {
    const { stash } = stashing([SHA_A]);
    const p = progress();

    const err = await failure(assertDelivered(TICKET, { committed: true }, p, neverAsked, stash));

    expect(err).toBeInstanceOf(StashedWorkError);
    expect((err as StashedWorkError).stashes).toEqual([SHA_A]);
    expect(err?.message).toContain("committed only PART");
    expect(err?.message).toContain(SHA_A);
    expect(err?.message).toContain("worktree is KEPT");
    // The tree fact stays true — a commit really did land — even though the ticket is refused.
    expect(p).toMatchObject({ committed: true, delivered: false });
  });

  /**
   * The same check runs AHEAD of the `satisfied` branch entirely (anton-wjfkn, PR #333 review round
   * 2) — the branch is never even asked. A verified commit proves that ticket's earlier work landed,
   * not that this session left nothing else behind.
   */
  it("refuses delivery over a gained stash before a satisfied claim is ever verified", async () => {
    const { stash } = stashing([SHA_A]);
    const p = progress({ outcome: "satisfied", commit: "deadbeef" });

    const err = await failure(assertDelivered(TICKET, { committed: false }, p, neverAsked, stash));

    expect(err).toBeInstanceOf(StashedWorkError);
    expect(p).toMatchObject({ committed: false, delivered: false });
  });

  it("leaves the plain zero-diff block exactly as it was when the stack gained nothing", async () => {
    const err = await failure(
      assertDelivered(TICKET, { committed: false }, progress(), neverAsked, NO_STASH),
    );

    expect(err).not.toBeInstanceOf(StashedWorkError);
    expect(err?.message).toContain("produced no delivery");
    expect(err?.message).toContain("zero diff");
  });

  /**
   * A stash read that FAILS must not be read as "gained none" either (PR #333 review round 2), and a
   * bare rethrow is just as wrong as guessing (PR #333 review round 3): a `git stash list` failure
   * here is not "no new stash", and a bare `Error` is invisible to `holdsRecoverableWork`, so the
   * teardown would force-remove this worktree and (with `committed: false`) silently reopen the
   * ticket with no note at all. Wrapped into the SAME `RecoverableWork`-shaped stop the baseline read
   * throws, so the worktree is kept and the block note says the stash state is unknown.
   */
  it("wraps a stash read failure into a RecoverableWork stop, exactly like the baseline read", async () => {
    const stash: StashRecovery = {
      gained: async () => {
        throw new Error("git stash list exploded");
      },
      apply: async () => true,
    };

    const err = await failure(assertDelivered(TICKET, { committed: false }, progress(), neverAsked, stash));

    expect(err).not.toBeInstanceOf(StashedWorkError);
    expect(err).toBeInstanceOf(StashBaselineUnreadableError);
    expect(holdsRecoverableWork(err)).toBe(true);
    expect((err as StashBaselineUnreadableError).readFailed).toBe(true);
    expect(err?.message).toContain("git stash list exploded");
    expect(err?.message).toContain("KEPT");
  });

  /**
   * The same wrap applies over a COMMITTED tree (PR #333 review round 3): a partial commit beside an
   * unreadable stash list is exactly the case the gate must not silently drop into an ordinary
   * `post-commit` block, losing the fact that some of the change may still be sitting unread on the
   * stack.
   */
  it("wraps a stash read failure the same way when the ticket already committed", async () => {
    const stash: StashRecovery = {
      gained: async () => {
        throw new Error("git stash list exploded");
      },
      apply: async () => true,
    };

    const err = await failure(assertDelivered(TICKET, { committed: true }, progress(), neverAsked, stash));

    expect(err).toBeInstanceOf(StashBaselineUnreadableError);
    expect(holdsRecoverableWork(err)).toBe(true);
  });
});

/**
 * The other half of the incident: the SESSION never finished. An agent whose last message armed a
 * wakeup, a monitor or a background job and that emitted no `ANTON-RESULT` handed its turn back to
 * something an autonomous run never delivers — so it is a stop, and every gate downstream would
 * misread it.
 */
describe("a yielded turn is its own outcome, not a clean exit (anton-wjfkn)", () => {
  it("records a dispatching step's yield on the ticket's progress", () => {
    const p = progress();
    recordStepReport(p, { yielded: ["ScheduleWakeup"] } satisfies StepFacts);
    expect(p.yielded).toEqual(["ScheduleWakeup"]);
  });

  it("leaves an ordinary step's progress with no yield at all", () => {
    const p = progress();
    recordStepReport(p, { selfReport: { outcome: "delivered" } } satisfies StepFacts);
    expect(p.yielded).toBeUndefined();
  });

  it("names the armed tools, the step, and the stash it left behind", () => {
    const err = new AgentYieldedError(TICKET.id, ["ScheduleWakeup", "Bash (run_in_background)"], [SHA_A], "implement");

    expect(err.name).toBe("PoisonError"); // poison: another attempt reproduces the same yield
    expect(err.message).toContain("ENDED ITS TURN");
    expect(err.message).toContain("ScheduleWakeup, Bash (run_in_background)");
    expect(err.message).toContain("`implement`");
    expect(err.message).toContain(SHA_A);
    expect(err.message).toContain("KEPT this worktree");
    expect(err.message).toContain("FOREGROUND");
    expect(err.stashes).toEqual([SHA_A]);
  });

  it("describes a yield that stashed nothing as work loose in the worktree", () => {
    const err = new AgentYieldedError(TICKET.id, ["Monitor"], []);

    expect(err.message).toContain("loose in the run's worktree");
    expect(err.message).toContain("KEPT rather than removed");
    expect(err.stashes).toEqual([]);
  });

  // The claim this message makes is the one an operator acts on without re-reading the diff.
  // Asserting the restore succeeded when every apply failed sends them to a worktree that does not
  // hold the change (PR #333 review) — mirrors the same three-way phrasing `recoverStashed`'s
  // `summary` and `ticketBlockNote` already use for `StashedWorkError`.
  it("does not claim the change survives in the tree when every restore failed", () => {
    const err = new AgentYieldedError(
      TICKET.id,
      ["ScheduleWakeup"],
      [SHA_A],
      "implement",
      null,
      [SHA_A],
    );

    expect(err.message).not.toContain("so the change survives");
    expect(err.message).toContain("could NOT restore");
    expect(err.message).toContain("only copy");
    expect(err.message).toContain("KEPT this worktree");
  });

  it("says so when only some stash entries came back", () => {
    const err = new AgentYieldedError(
      TICKET.id,
      ["ScheduleWakeup"],
      [SHA_A, SHA_B],
      "implement",
      null,
      [SHA_B],
    );

    expect(err.message).toContain("restored 1 of 2");
    expect(err.message).toContain(`could not apply \`${SHA_B}\``);
    expect(err.message).not.toContain("so the change survives");
  });

  // The final `git stash list` read can itself fail (PR #333 review, round 2): `stashes` is then `[]`
  // for lack of a read, not because there was nothing there. The message must say so rather than
  // claim the tree is the only place to look — the false version is what a caller would get by
  // silently catching the read failure into `[]`.
  it("says the stash list is unknown rather than claiming the tree is all there is, when its read failed", () => {
    const err = new AgentYieldedError(TICKET.id, ["Monitor"], [], "implement", null, [], true);

    expect(err.message).toContain("UNKNOWN");
    expect(err.message).toContain("git stash list");
    expect(err.message).not.toContain("loose in the run's worktree");
    expect(err.stashes).toEqual([]);
    expect(err.stashReadFailed).toBe(true);
    // `RecoverableWork.readFailed` is an alias of the class's own `stashReadFailed` field, so a
    // reader that only has the interface (a `blockFailedTicket` cast) still sees it.
    expect(err.readFailed).toBe(true);
    expect(holdsRecoverableWork(err)).toBe(true);
  });

  // Unlike `StashedWorkError` (whose caller mixes the suffix into the message it passes in), this
  // class builds its own message internally — so the self-report has to be folded in by the
  // constructor itself, or it is dropped from `err.message`/`job.error` entirely (PR #333 review).
  it("folds the agent's self-report into its own message, not just onto `.selfReport`", () => {
    const err = new AgentYieldedError(TICKET.id, ["Monitor"], [], "implement", {
      outcome: "blocked",
      reason: "needs review",
    });

    expect(err.message).toContain("self-reported");
    expect(err.message).toContain("needs review");
  });

  /**
   * The one question the worktree teardown asks. All three classes hold uncommitted (or possibly
   * uncommitted) work, so a `--force` release over any of them is how a recoverable stop becomes lost
   * work — and neither ordinary block nor a plain failure may be kept, or every failed run leaks a
   * checkout.
   */
  it("marks all three recoverable-work classes, and nothing else", () => {
    expect(holdsRecoverableWork(new StashedWorkError("stashed", [SHA_A]))).toBe(true);
    expect(holdsRecoverableWork(new AgentYieldedError(TICKET.id, ["Monitor"]))).toBe(true);
    expect(holdsRecoverableWork(new StashBaselineUnreadableError(TICKET.id, new Error("boom")))).toBe(
      true,
    );
    expect(holdsRecoverableWork(new Error("an ordinary failure"))).toBe(false);
    expect(holdsRecoverableWork(undefined)).toBe(false);
  });
});

/**
 * anton could not even read the ticket's stash BASELINE before any of its steps ran (anton-wjfkn, PR
 * #333 review round 2) — a resumed checkout that already held uncommitted work from an earlier stop
 * (a human-gate park, a prior yield) must not be force-removed just because this transient read failed.
 */
describe("a baseline read failure is its own conservative stop, not an ordinary failure (anton-wjfkn)", () => {
  it("names the ticket and the underlying read failure, and is poison-classified", () => {
    const err = new StashBaselineUnreadableError(TICKET.id, new Error("git stash list exploded"));

    expect(err.name).toBe("PoisonError");
    expect(err.message).toContain(TICKET.id);
    expect(err.message).toContain("git stash list exploded");
    expect(err.message).toContain("KEPT");
  });

  it("carries no shas — nothing could be confirmed, so nothing is named", () => {
    const err = new StashBaselineUnreadableError(TICKET.id, new Error("boom"));

    expect(err.stashes).toEqual([]);
    expect(err.restoreFailures).toEqual([]);
    expect(err.readFailed).toBe(true);
  });
});

/**
 * The bead is where an operator meets the stop, so the note has to send them to the work rather than
 * to a keyboard. A zero-diff note's remedy — implement the ticket — is the wrong move here and loses
 * or duplicates a change that already exists.
 */
describe("the block note tells an operator to RECOVER, not to re-implement (anton-wjfkn)", () => {
  const note = (
    kind: "stashed-work" | "agent-yielded" | "baseline-unreadable",
    stashes: string[] = [],
    restoreFailures: string[] = [],
    selfReport: TicketProgress["selfReport"] = null,
    opts: { committed?: boolean; readFailed?: boolean } = {},
  ) =>
    ticketBlockNote({
      ticketId: TICKET.id,
      kind,
      selfReport,
      sessionId: "sess-1",
      branch: "anton/anton-wjfkn",
      committed: opts.committed ?? false,
      stashes,
      restoreFailures,
      readFailed: opts.readFailed,
      worktreePath: "/tmp/anton-worktrees/wjfkn",
    });

  // Dropped from this note before this test existed (PR #333 review): a self-report an earlier
  // dispatching step already produced — before a LATER step yielded, or before the commit step found
  // the stashed-empty tree — is exactly the account an operator reading `bd show <id>` wants, and this
  // bead is where they meet the stop. The run row's own `error` ages out of attention long before it.
  it("carries the agent's self-report, same as the zero-diff notes already do", () => {
    for (const kind of ["stashed-work", "agent-yielded"] as const) {
      const text = note(kind, [SHA_A], [], { outcome: "blocked", reason: "hit a coverage floor" });

      expect(text).toContain("self-reported");
      expect(text).toContain("hit a coverage floor");
    }
  });

  it("names the stash shas, the worktree, and the recovery commands", () => {
    const text = note("stashed-work", [SHA_A]);

    expect(text).toContain("STASHED its own work");
    expect(text).toContain(SHA_A);
    expect(text).toContain("/tmp/anton-worktrees/wjfkn");
    expect(text).toContain("git stash show -p <sha>");
    expect(text).toContain("Do NOT re-implement it from scratch");
  });

  // The block leaves the bead `blocked` (PR #333 review), and bd's claim gate refuses that status —
  // so a note that only says "resume the run" sends the operator to a resume that dies on its own
  // first step. The remedy must name the reopen.
  it("tells the operator to reopen the ticket before resuming, since the block leaves it blocked", () => {
    const text = note("agent-yielded", [SHA_A]);

    expect(text).toContain(`bd update ${TICKET.id} --status open`);
    expect(text).toContain("claim gate refuses");
  });

  it("describes a yielded stop as a stop, with no stash clause when there was none", () => {
    const text = note("agent-yielded");

    expect(text).toContain("ENDED ITS TURN");
    expect(text).not.toContain("git stash");
    expect(text).toContain("Do NOT re-implement it from scratch");
  });

  // Every block note carries the shared trailing evidence clause the board's park gate reads back to
  // pick its remedy (block-note.ts). These two kinds are no exception, and both committed nothing.
  it("carries the shared evidence clause, reporting nothing committed", () => {
    for (const kind of ["stashed-work", "agent-yielded"] as const) {
      expect(note(kind, [SHA_A])).toContain("[session sess-1, nothing committed on anton/anton-wjfkn]");
    }
  });

  it("stays a single line, so the notes blob parses it back as one machine note", () => {
    expect(note("stashed-work", [SHA_A, SHA_B]).includes("\n")).toBe(false);
  });

  // The claim this note makes is the one an operator acts on without re-reading the diff. Asserting
  // it restored when the apply actually failed sends them to a worktree that does not hold the change.
  it("does not claim the work is back in the tree when every apply failed", () => {
    const text = note("stashed-work", [SHA_A], [SHA_A]);

    expect(text).not.toContain("anton put the work back");
    expect(text).toContain("anton could NOT put the work back");
    expect(text).toContain("only copy");
  });

  it("says so when only some entries came back", () => {
    const text = note("stashed-work", [SHA_A, SHA_B], [SHA_B]);

    expect(text).toContain(`anton put 1 of 2 back`);
    expect(text).toContain(`could not reapply \`${SHA_B}\``);
  });

  it("still says the work was put back when every apply landed", () => {
    const text = note("stashed-work", [SHA_A]);

    expect(text).toContain("anton put the work back");
  });

  /**
   * anton-wjfkn, PR #333 review round 2: a `stashed-work` stop can now carry a real commit (a partial
   * commit beside a partial stash). The note must say PART, not claim nothing was committed at all —
   * and the shared evidence clause (checked elsewhere) already reflects the commit independently.
   */
  it("says the commit was only PART of the work when the ticket committed alongside a gained stash", () => {
    const text = note("stashed-work", [SHA_A], [], null, { committed: true });

    expect(text).toContain("committed only PART of its work");
    expect(text).not.toContain("Nothing was verified or committed");
    expect(text).toContain("would ship it PARTIAL");
    expect(text).toContain("[session sess-1, committed on anton/anton-wjfkn @ unknown]");
  });

  /**
   * anton-wjfkn, PR #333 review round 3: a failed FINAL stash read leaves `stashes` empty for lack of
   * a read, not because the stack is confirmed empty — the note must say so rather than claim the
   * worktree is the whole story.
   */
  it("says the stash list is unknown, not confirmed empty, when the read failed", () => {
    const readFailed = note("agent-yielded", [], [], null, { readFailed: true });
    const confirmedEmpty = note("agent-yielded", [], [], null, { readFailed: false });

    expect(readFailed).toContain("UNKNOWN");
    expect(readFailed).toContain("git stash list");
    expect(confirmedEmpty).not.toContain("UNKNOWN");
    expect(confirmedEmpty).not.toContain("git stash list");
  });

  /**
   * anton-wjfkn, PR #333 review round 2: a stash list anton could not even read gets its own kind,
   * distinct from an agent action — nothing here is the agent's doing.
   */
  it("describes a stash read failure as anton's own stop, not the agent's", () => {
    const text = note("baseline-unreadable", [], [], null, { readFailed: true });

    expect(text).toContain("anton could not read this worktree's stash list");
    expect(text).not.toContain("STASHED its own work");
    expect(text).not.toContain("ENDED ITS TURN");
    expect(text).toContain("Do NOT re-implement it from scratch");
    expect(text).toContain(`bd update ${TICKET.id} --status open`);
  });

  /**
   * anton-wjfkn, PR #333 review round 3: this same kind now also covers the delivery gate's OWN read
   * (after the commit step, possibly alongside a real commit) — the opening must not claim "before
   * its steps ran" over a stop that can carry a commit right there in the evidence clause.
   */
  it("says nothing about WHEN the read failed, so a committed round-3 stop isn't misdescribed", () => {
    const text = note("baseline-unreadable", [], [], null, { readFailed: true, committed: true });

    expect(text).not.toContain("steps");
    expect(text).toContain("[session sess-1, committed on anton/anton-wjfkn @ unknown]");
  });

  // anton-wjfkn round 3 review: this note is re-surfaced to an operator through
  // `execute-epic-board.ts`'s `clampNote`, which cuts a held ticket's note at 300 characters for the
  // run-row park. A trailing "Do NOT re-implement it from scratch" is exactly the clause that cap
  // drops — so it has to survive being cut to the same width this note actually gets read at.
  it("keeps its central warning inside the first 300 characters a park note ever shows", () => {
    const text = note("stashed-work", [SHA_A, SHA_B]);
    const clamped = text.slice(0, 300);

    expect(clamped).toContain("Do NOT re-implement it from scratch");
  });
});
