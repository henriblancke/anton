/**
 * THE DECISION HALF of apply-on-approve (anton-1t3n): what `planApply` means by an approval, decided
 * against fixture boards rather than a live one because it writes nothing at all.
 *
 * The preconditions here are what protect other people's beads, and the claim they add up to is that
 * A STALE PLAN WRITES NOTHING: a proposal describes the board as it was, and approving it re-checks
 * every fact and refuses when one has changed. The writes those decisions turn into are asserted in
 * `apply-steps.test.ts`; the composition of the two in `apply.test.ts`.
 */
import { describe, expect, it } from "vitest";

import { LABELS, type Bead } from "../beads/bd";
import { planApply } from "./apply-plan";
import { type GardenerPlan } from "./detections";
import {
  bead,
  blockedBy,
  CARD,
  CARRIED,
  child,
  CLOSE,
  CLUSTER,
  cold,
  DEFER,
  edged,
  EPIC,
  FEATURE,
  FILED,
  GROUPED,
  inReview,
  landed,
  leased,
  LINK,
  MISFILED,
  NOW,
  ordered,
  planFor,
  provenanced,
  REPARENT,
  retirements,
  runCard,
  SUPERSEDE,
  supersededBy,
  ticket,
  warm,
} from "./apply.fixture";

/**
 * Decide against a fixture board the way the route does: now, against a proposal filed a month ago.
 * A test that needs a different pair of moments calls `planApply` itself.
 */
const decide = (plan: GardenerPlan, board: Bead[], nowMs: number = NOW) =>
  planApply(plan, board, { nowMs, observedAtMs: Date.parse(FILED) });

describe("planApply — what an approval means against the board as it now is", () => {
  it("re-parents every subject that isn't already home, remembering the parent to undo to", () => {
    const board = [CARD, CARRIED, child("anton-a", "anton-container"), bead("anton-b")];
    const decision = decide(CLUSTER, board);

    expect(decision).toEqual({
      status: "apply",
      summary: "re-parented anton-a, anton-b under anton-card",
      steps: [
        // `claim`/`parentClaim` empty — neither end of the move is owned by a run, which is the
        // pair the write re-checks under the locks it takes on both. The fence rides along for the
        // ONE re-parent kind a fresh board read cannot re-derive (`misfiled`); this one carries no
        // premise, so it changes nothing here.
        {
          verb: "reparent",
          id: "anton-a",
          claim: "",
          parent: "anton-card",
          undoParent: "anton-container",
          parentClaim: "",
          kind: "parentless-cluster",
          observedAtMs: Date.parse(FILED),
          // The two premises the WRITE re-asks under its locks: the ids to keep out of the home's
          // carried-ticket count, the membership to re-group, and the home's own pre-existing
          // tickets the container bar is counted over, plus the beads those tickets reach the home
          // through — empty here, this one sits directly under the card (apply-steps.ts
          // `assertClusterHolds`). None is readable from the step's two ends alone, and each names a
          // bead the write must lock.
          cluster: {
            named: ["anton-a", "anton-b"],
            members: ["anton-a", "anton-b"],
            carriers: [CARRIED.id],
            carrierPaths: [],
          },
        },
        // A parentless subject undoes to bd's detach form, not to some invented parent.
        {
          verb: "reparent",
          id: "anton-b",
          claim: "",
          parent: "anton-card",
          undoParent: "",
          parentClaim: "",
          kind: "parentless-cluster",
          observedAtMs: Date.parse(FILED),
          cluster: {
            named: ["anton-a", "anton-b"],
            members: ["anton-a", "anton-b"],
            carriers: [CARRIED.id],
            carrierPaths: [],
          },
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
    const board = [ordered(), bead("anton-bb")];
    expect(decide(LINK, board)).toEqual({
      status: "apply",
      summary: "recorded that anton-bb blocks anton-aa",
      steps: [
        {
          verb: "link",
          id: "anton-aa",
          claim: "",
          blocker: "anton-bb",
          kind: "implied-order",
          // Carried by every link, consulted only by `missing-order`: an `implied-order` resolves to
          // no premise, because its evidence is re-derived from the board under the pair's locks.
          observedAtMs: Date.parse(FILED),
        },
      ],
    });
  });

  it("settles a link whose edge already runs the way the proposal states", () => {
    expect(decide(LINK, edged("anton-aa", "anton-bb"))).toEqual({
      status: "settled",
      summary: "a blocks edge already records anton-bb → anton-aa",
    });
  });

  // bd stores ONE edge per directed pair and answers a second type with "already exists with type
  // discovered-from … remove it first", so an ask whose pair already carries provenance can only
  // ever be approved into that error and would sit open until a human declined it (anton-wsap).
  it("refuses a link over a pair the board already records as discovered-from", () => {
    const decision = decide(LINK, [provenanced(), bead("anton-bb")]);
    expect(decision).toMatchObject({ status: "refuse" });
    expect(decision.status === "refuse" && decision.reason).toMatch(
      /already records anton-aa as discovered from anton-bb/,
    );
  });

  // The REVERSE edge is somebody's recorded decision that the ordering runs the other way — never
  // something to overwrite, and never something to close this proposal over: settling would file a
  // summary claiming an edge (`anton-b → anton-a`) the board does not hold.
  it("refuses a link the board already records in the opposite direction", () => {
    const decision = decide(LINK, edged("anton-bb", "anton-aa"));
    expect(decision).toMatchObject({ status: "refuse" });
    expect(decision.status === "refuse" && decision.reason).toMatch(
      /opposite ordering — anton-aa blocks anton-bb/,
    );
  });

  // bd rejects a blocking cycle at every write path, so an edge that closes one can only ever be
  // approved into a 500 — leaving an open proposal that will never apply. The DIRECT reverse pair is
  // caught above; this is the transitive case, where the pair looks unrelated.
  it("refuses a link that would close a dependency cycle through other beads", () => {
    // anton-bb waits on anton-cc, which waits on anton-aa — "anton-bb blocks anton-aa" closes the loop.
    const board = [
      ordered(),
      blockedBy("anton-bb", "anton-cc"),
      blockedBy("anton-cc", "anton-aa"),
    ];
    const decision = decide(LINK, board);
    expect(decision).toMatchObject({ status: "refuse" });
    expect(decision.status === "refuse" && decision.reason).toMatch(
      /anton-bb is already blocked by anton-aa through other beads/,
    );
  });

  it("still records an edge whose chain runs the other way — that is an ordering, not a cycle", () => {
    // anton-aa already waits on anton-cc: adding anton-bb as another blocker closes nothing.
    const board = [ordered(blockedBy("anton-aa", "anton-cc")), bead("anton-bb"), bead("anton-cc")];
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

    /**
     * The home is validated when the PATROL runs and then read by a human days later. Two cluster
     * proposals (anton-a7hp, anton-z5jn) named targets that had CLOSED by the time they were read;
     * approving either would have parented open work under a shipped feature (anton-9hpp). So the
     * target's freedom is re-asked here, against the board the writes would actually land on.
     */
    it("refuses a target that settled or was picked up since the proposal was filed", () => {
      const settled = [{ ...CARD, status: "closed" }, bead("anton-a"), bead("anton-b")];
      expect(refusal(decide(CLUSTER, settled))).toMatch(
        /anton-card is closed — re-parenting work under it would hang it off a card nothing will run/,
      );

      const claimed = [
        warm(CARD.id, { issue_type: "feature", status: "in_progress", assignee: "runner-7" }),
        bead("anton-a"),
        bead("anton-b"),
      ];
      expect(refusal(decide(CLUSTER, claimed))).toMatch(
        /anton-card is held by runner-7 and it was claimed since this proposal was filed/,
      );

      // …and the same for a run that got as far as publishing its lease.
      const leasedHome = [
        { ...leased(CARD.id, NOW), issue_type: "feature" },
        bead("anton-a"),
        bead("anton-b"),
      ];
      expect(refusal(decide(CLUSTER, leasedHome))).toMatch(/anton-card/);
    });

    /**
     * The home's OTHER premise, and the one nothing else restates: a cluster detector calls a card
     * obvious only when the board already files tickets under it (reparent.ts
     * `MIN_CARRIED_TICKETS`). Delete or re-home that last ticket between the filing and the read and
     * the card is a leaf again — one PR's worth of work — so approving would turn somebody's card
     * into somebody else's epic. The grouping re-check cannot see it: it reads titles and labels.
     */
    it("refuses a cluster whose home stopped carrying tickets of its own", () => {
      const leaf = [CARD, bead("anton-a"), bead("anton-b")];
      expect(refusal(decide(CLUSTER, leaf))).toMatch(
        /anton-card carries no tickets of its own any more/,
      );
    });

    // …and the cluster's own members may not stand in for the ticket that left: half-applying the
    // move by hand would otherwise let the proposal prove its own premise with the very move it asks
    // for. Only tickets the home carried BEFORE this ask count.
    it("does not let the cluster's own members prove the home still carries work", () => {
      const halfApplied = [CARD, child("anton-a", CARD.id), bead("anton-b")];
      expect(refusal(decide(CLUSTER, halfApplied))).toMatch(/carries no tickets of its own/);
    });

    // …nor may a member's SUBTREE stand in for it. `cardOf` walks the whole parent chain, so a
    // hand-moved member drags its own children onto the home too — and they reach it only through
    // the move being asked for, which is the same circularity by one more hop.
    it("does not let a named member's descendants prove it either", () => {
      const halfApplied = [
        CARD,
        child("anton-a", CARD.id),
        child("anton-a1", "anton-a"),
        bead("anton-b"),
      ];
      expect(refusal(decide(CLUSTER, halfApplied))).toMatch(/carries no tickets of its own/);
    });

    // And the same subtree is kept out of the carriers the WRITE half re-asks the bar over: a
    // premise recorded on the proposal's own descendants would be re-proved by its own move.
    it("records only independent carriers on the step's premise", () => {
      const decision = decide(CLUSTER, [
        CARD,
        CARRIED,
        child("anton-a", CARD.id),
        child("anton-a1", "anton-a"),
        bead("anton-b"),
      ]);
      expect(decision.status).toBe("apply");
      const carriers = (decision.status === "apply" ? decision.steps : []).map((step) =>
        step.verb === "reparent" ? step.cluster?.carriers : undefined,
      );
      expect(carriers).toEqual([[CARRIED.id]]);
    });

    // A carrier reaches the home through whatever sits between them, and an intermediate the count
    // never sees — an exempt type is no ticket of anybody's — is deleted under its own lock alone.
    // So the premise records the PATH as well as its ends, which is what lets the write half hold it
    // (apply-steps.ts `lockedBeads`) instead of trusting it to survive until the write.
    it("records the beads a nested carrier reaches the home through", () => {
      const decision = decide(CLUSTER, [
        CARD,
        child("anton-note", CARD.id, { issue_type: "learning" }),
        child("anton-t0", "anton-note"),
        bead("anton-a"),
        bead("anton-b"),
      ]);
      expect(decision.status).toBe("apply");
      const premise = (decision.status === "apply" ? decision.steps : []).map((step) =>
        step.verb === "reparent" ? step.cluster : undefined,
      )[0];
      expect(premise?.carriers).toEqual(["anton-t0"]);
      expect(premise?.carrierPaths).toEqual(["anton-note"]);
    });

    it("refuses a home that is not a board card — the state the proposal exists to fix", () => {
      // An epic WITH a feature child is a container: work parented to it rides no card.
      const container = bead("anton-card", { issue_type: "epic" });
      const board = [container, child("anton-f", container.id, { issue_type: "feature" }), bead("anton-a")];
      expect(refusal(decide(REPARENT, board))).toMatch(/not a board card/);
    });

    // The tier taxonomy asks for A HOME ONE TIER UP (`epic → feature → ticket`), so which home is
    // legal depends on what is being moved: the working layer wants the card that runs it, a CARD
    // wants the container epic that groups it. One question for both refused every card move.
    describe("a home one tier up — the bar depends on the subject's tier", () => {
      const move = (subject: string, target: string): GardenerPlan =>
        planFor({ kind: "container-orphan", move: "reparent", subjects: [subject], target });

      it("moves a card under the container epic that groups it", () => {
        const board = [EPIC, GROUPED, FEATURE];
        expect(decide(move(FEATURE.id, EPIC.id), board)).toMatchObject({ status: "apply" });
      });

      it("refuses a card under a feature — both are run targets, so it would ship twice", () => {
        expect(refusal(decide(move(FEATURE.id, CARD.id), [CARD, FEATURE]))).toMatch(
          /anton-card is not an epic .*feature-under-non-epic/,
        );
      });

      // An epic that groups no cards is a run target itself, and renders as a card: landing a
      // feature under it cancels its own run and strands whatever tickets it carries.
      it("refuses a card under an epic that groups none — the move would demote it", () => {
        const board = [EPIC, FEATURE, child("anton-t1", EPIC.id)];
        expect(refusal(decide(move(FEATURE.id, EPIC.id), board))).toMatch(
          /anton-epic is not a container epic .*ticket-under-container-epic/,
        );
      });

      it("refuses a working-layer bead under a container epic — it would ride no card", () => {
        const board = [EPIC, GROUPED, bead("anton-a")];
        expect(refusal(decide(move("anton-a", EPIC.id), board))).toMatch(
          /anton-epic is not a board card/,
        );
      });

      it("still moves a working-layer bead under a board card", () => {
        expect(decide(move("anton-a", CARD.id), [CARD, bead("anton-a")]).status).toBe("apply");
      });

      // The SUBJECT end of the same taxonomy, which has to be asked positively: every bar around it
      // reads "not a board card", and a container epic satisfies that as surely as a ticket does. A
      // product-master report naming one is untrusted input, and left to the working layer's bar the
      // move is accepted — after which `cardOf` walks THROUGH the container and hands that card's run
      // every ticket beneath it.
      it("refuses a container epic as the SUBJECT — no card can carry one", () => {
        expect(refusal(decide(move(EPIC.id, CARD.id), [EPIC, GROUPED, CARD]))).toMatch(
          /anton-epic is not a bead a card can carry — it is a container epic/,
        );
      });

      it("refuses a subject the taxonomy names no home for at all", () => {
        const learning = bead("anton-l", { issue_type: "learning" });
        expect(refusal(decide(move(learning.id, CARD.id), [CARD, learning]))).toMatch(
          /anton-l is a learning, which is neither a board card nor working-layer work/,
        );
      });
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
      const board = [ordered(), bead("anton-bb", { status: "closed" })];
      expect(refusal(decide(LINK, board))).toMatch(/anton-bb is closed/);
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
        // A cluster drops a mid-run member rather than refusing over it (see "a cluster member the
        // board has answered"); what this test asserts of it is the same thing — nothing is written
        // to a bead a run owns.
        const cluster = decide(CLUSTER, [CARD, CARRIED, live, bead("anton-b")], NOW);
        expect(cluster.status === "apply" ? cluster.steps.map((s) => s.id) : []).not.toContain(
          "anton-a",
        );
        const liveBlocked = ordered(live.assignee ? leased("anton-aa", NOW) : inReview("anton-aa"));
        expect(refusal(decide(LINK, [liveBlocked, bead("anton-bb")], NOW))).toMatch(
          /anton-aa is mid-run/,
        );
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
      const claimedBlocked = ordered(warm("anton-aa", { assignee: "runner-7", status: "in_progress" }));
      expect(reason(decide(LINK, [claimedBlocked, bead("anton-bb")]))).toMatch(
        /recording it as blocked/,
      );
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
    });

    /**
     * …but ONE answered member does not take the rest of a cluster down with it. A cluster's claim
     * is its target now, not its membership (anton-9hpp), so the proposal standing open suppresses
     * the fresh cluster the next patrol derives from the members nobody has answered — and refusing
     * the whole plan over `anton-a` would leave that valid claim unapplyable until a human declined
     * this bead by hand. The newer decision is still never written over: `anton-a` gets no step.
     */
    /** The members an apply decision actually writes to, in order. */
    const moved = (decision: ReturnType<typeof decide>): string[] =>
      decision.status === "apply" ? decision.steps.map((s) => s.id) : [];

    describe("a cluster member the board has answered", () => {
      /** Three members, so dropping one still leaves the detector's own MIN_CLUSTER_SIZE behind. */
      const THREE = planFor({
        kind: "parentless-cluster",
        move: "reparent",
        subjects: ["anton-a", "anton-b", "anton-c"],
        target: CARD.id,
      });
      const rest = [CARD, CARRIED, bead("anton-b"), bead("anton-c")];

      it("drops the member somebody re-homed and moves the ones nobody answered", () => {
        const other = bead("anton-other", { issue_type: "feature" });
        const decision = decide(THREE, [...rest, other, child("anton-a", other.id)]);

        expect(decision.status).toBe("apply");
        expect(moved(decision)).toEqual(["anton-b", "anton-c"]);
        expect(decision.status === "apply" ? decision.summary : "").toBe(
          "re-parented anton-b, anton-c under anton-card (1 member(s) no longer in the cluster)",
        );
      });

      /**
       * The other two ways a member stops being one of the loose beads the cluster was derived from
       * (reparent.ts `isClusterCandidate`). Both used to refuse the whole plan while the proposal's
       * target-only fingerprint went on suppressing the fresh cluster the remaining members form.
       */
      it("drops a member closed since the filing", () => {
        const decision = decide(THREE, [...rest, bead("anton-a", { status: "closed" })]);
        expect(moved(decision)).toEqual(["anton-b", "anton-c"]);
      });

      // `bd delete` is the third way a member leaves, and the only one that leaves no bead behind to
      // read the departure from — so it used to refuse the plan before the answered path was reached.
      it("drops a member deleted since the filing", () => {
        const decision = decide(THREE, rest);
        expect(moved(decision)).toEqual(["anton-b", "anton-c"]);
        expect(decision.status === "apply" ? decision.summary : "").toContain(
          "(1 member(s) no longer in the cluster)",
        );
      });

      it("drops a member a run has picked up since the filing", () => {
        for (const live of [leased("anton-a", NOW), inReview("anton-a")]) {
          expect(moved(decide(THREE, [...rest, live], NOW))).toEqual(["anton-b", "anton-c"]);
        }
      });

      // Nothing left to write is not a settle: the ask never reached the target it names, and an
      // approver told "already sit under anton-card" would be told the opposite of what happened.
      it("refuses a cluster whose every member was answered elsewhere", () => {
        const other = bead("anton-other", { issue_type: "feature" });
        const board = [CARD, CARRIED, other, child("anton-a", other.id), child("anton-b", other.id)];
        expect(reason(decide(CLUSTER, board))).toMatch(/now rides board card anton-other/);
      });

      /**
       * Dropping members may not smuggle the move below the bar the DETECTOR holds itself to: one
       * loose bead sharing a topic with a card is the weak evidence this detector was rebuilt to stop
       * proposing on, and the re-home that took the other member away may be the newer reading of
       * where the work belongs.
       */
      it("refuses what is left of a two-member cluster once one member is answered", () => {
        const other = bead("anton-other", { issue_type: "feature" });
        const board = [CARD, CARRIED, other, child("anton-a", other.id), bead("anton-b")];
        expect(reason(decide(CLUSTER, board))).toMatch(
          /anton-b is all that is left of this cluster — it takes 2 beads stating one subject anton-card states too/,
        );
      });

      // …but a member somebody already filed under the target IS the cluster the ask wanted, so it
      // counts towards the floor rather than reading as one more member that left.
      it("counts a member already sitting under the home towards the minimum", () => {
        const decision = decide(CLUSTER, [CARD, CARRIED, child("anton-a", CARD.id), bead("anton-b")]);
        expect(moved(decision)).toEqual(["anton-b"]);
      });

      /**
       * …only while it is still one of the loose beads the cluster was derived from. A member moved
       * under the home by hand and THEN closed, promoted or picked up left the cluster exactly as a
       * re-homed one did — and counting it would carry the lone survivor past a floor a fresh
       * detector pass would refuse, moving a bead no cluster remains to justify.
       */
      it("drops an in-place member the board has since answered", () => {
        const answered = [
          child("anton-a", CARD.id, { status: "closed" }),
          child("anton-a", CARD.id, { issue_type: "feature" }),
          child("anton-a", CARD.id, leased("anton-a", NOW)),
        ];
        for (const member of answered) {
          expect(reason(decide(CLUSTER, [CARD, CARRIED, member, bead("anton-b")], NOW))).toMatch(
            /anton-b is all that is left of this cluster/,
          );
        }
      });

      /**
       * …and once what already sits under the home is a cluster in its own right, the ask is DONE.
       * Two members filed there by hand are the outcome this proposal wanted, so a third that closed
       * or moved on leaves nothing to write — reporting its refusal instead left a proposal no
       * approval could ever settle, because every later approve reached the same refusal while the
       * valid cluster sat on the board.
       */
      it("settles a cluster the board already holds, whatever became of the other members", () => {
        const board = [
          CARD,
          CARRIED,
          child("anton-a", CARD.id),
          child("anton-b", CARD.id),
          bead("anton-c", { status: "closed" }),
        ];
        expect(decide(THREE, board)).toEqual({
          status: "settled",
          // Named from the members that ARE there: anton-c never reached the target.
          summary: "anton-a, anton-b already sit under anton-card",
        });
      });

      // …but two in-place members that no longer agree about anything are not a cluster, so the
      // departure that unravelled it is still the answer the approver gets.
      it("does not settle on in-place members that no longer state one subject", () => {
        const board = [
          CARD,
          CARRIED,
          child("anton-a", CARD.id, { title: "anton-a: docker image cache" }),
          child("anton-b", CARD.id),
          bead("anton-c", { status: "closed" }),
        ];
        expect(reason(decide(THREE, board))).toMatch(/anton-c is closed/);
      });

      /**
       * The fourth way a member leaves, and the one every bar around it read as a fatal HOME refusal:
       * promoted to a `feature`, it is a board card, and the tier taxonomy rejects the move as
       * `feature-under-non-epic` before any member is judged — taking the pair that is still a cluster
       * down with it, while the target-only fingerprint suppressed their fresh proposal.
       */
      it("drops a member promoted out of the working layer since the filing", () => {
        const decision = decide(THREE, [...rest, bead("anton-a", { issue_type: "feature" })]);
        expect(moved(decision)).toEqual(["anton-b", "anton-c"]);
        expect(decision.status === "apply" ? decision.summary : "").toContain(
          "(1 member(s) no longer in the cluster)",
        );
      });
    });

    /**
     * A proposal's subjects are the UNION of every topic group its home hosts, so one target can
     * carry an escalation pair AND a docker pair. Lose one member of each and the raw count still
     * reads as a cluster while the survivors agree about nothing — a fresh patrol, which groups
     * before it counts, would propose nothing at all. So the grouping is recomputed over whoever is
     * left rather than trusted from the filing.
     */
    describe("a cluster whose surviving members no longer state one subject", () => {
      const HOME = bead("anton-card", {
        issue_type: "feature",
        title: "Escalation banner and docker image",
      });
      const member = (id: string, title: string): Bead => bead(id, { title });
      const PAIRS = planFor({
        kind: "parentless-cluster",
        move: "reparent",
        subjects: ["anton-a1", "anton-a2", "anton-d1", "anton-d2"],
        target: HOME.id,
      });
      const escalation = [
        member("anton-a1", "Escalation banner rollout"),
        member("anton-a2", "Escalation banner copy"),
      ];
      const docker = [
        member("anton-d1", "Docker image cache"),
        member("anton-d2", "Docker image build"),
      ];

      it("moves both groups while both still hold", () => {
        const decision = decide(PAIRS, [HOME, CARRIED, ...escalation, ...docker]);
        expect(moved(decision)).toEqual(["anton-a1", "anton-a2", "anton-d1", "anton-d2"]);
      });

      // One survivor from each pair reaches MIN_CLUSTER_SIZE by count alone and by nothing else.
      it("refuses two unrelated survivors that only add up to the floor", () => {
        const board = [HOME, CARRIED, escalation[0]!, docker[0]!];
        expect(reason(decide(PAIRS, board))).toMatch(
          /anton-a1, anton-d1 is all that is left of this cluster — it takes 2 beads stating one subject anton-card states too/,
        );
      });

      // …and the pair that DOES still hold is not held hostage to the survivor that no longer does.
      it("moves the group that still holds and drops the survivor that does not", () => {
        const decision = decide(PAIRS, [HOME, CARRIED, ...escalation, docker[0]!]);
        expect(moved(decision)).toEqual(["anton-a1", "anton-a2"]);
        expect(decision.status === "apply" ? decision.summary : "").toContain(
          "(2 member(s) no longer in the cluster)",
        );
      });
    });

    // A move under another CONTAINER leaves the bead exactly as unreachable as the proposal says,
    // so it is still the fix rather than a decision to preserve.
    it("still re-homes a subject moved under something that is not a card", () => {
      expect(decide(REPARENT, [CARD, child("anton-a", "anton-container")]).status).toBe("apply");
    });

    // The `misfiled` half of the same verb (anton-02po). Its subject rides a perfectly good card —
    // that IS the claim — so the card check above would refuse every one of them; what stands in is
    // the evidence fence, asked at BOTH ends because a home claim is a match between two contracts.
    describe("a misfiled home claim", () => {
      /** The card the subject rides today: a real board card, which is what makes it misfiled. */
      const wrongHome = bead("anton-card9", { issue_type: "feature" });
      const subject = (extra: Partial<Bead> = {}): Bead =>
        child("anton-a", wrongHome.id, { updated_at: "2025-01-01T00:00:00Z", ...extra });
      const home = (extra: Partial<Bead> = {}): Bead =>
        cold(CARD.id, { issue_type: "feature", ...extra });

      it("moves a subject that already rides a card, which the gardener's kinds refuse", () => {
        const board = [home(), wrongHome, subject()];
        expect(decide(MISFILED, board).status).toBe("apply");
        // Same board, the gardener's claim: "no card carries this" is re-derivable and now false.
        expect(reason(decide(REPARENT, board))).toMatch(/now rides board card anton-card9/);
      });

      it("refuses when the subject was rewritten after the filing", () => {
        expect(reason(decide(MISFILED, [home(), wrongHome, subject(warm("anton-a"))]))).toMatch(
          /no longer the bead whose contract this home was chosen for/,
        );
        expect(reason(decide(MISFILED, [home(), wrongHome, child("anton-a", wrongHome.id)]))).toMatch(
          /no write stamp/,
        );
      });

      // The HOME's end of the match, and the one nothing else notices: every other bar asks whether
      // the home is still open, unclaimed and the right tier, all of which a rewrite leaves intact.
      it("refuses when the HOME was rewritten after the filing", () => {
        expect(
          reason(decide(MISFILED, [warm(CARD.id, { issue_type: "feature" }), wrongHome, subject()])),
        ).toMatch(/no longer the home whose contract this bead was judged to belong under/);
      });

      // The card the subject is LEAVING is a run target too, and the only place a run over it is
      // visible: a ticket that run selected but has not yet reached carries no lease, no PR ref and
      // no claim of its own. Moving it out now leaves the run's commit landing in the old card's PR
      // while the bead hangs off the new one — the same raid a retirement makes, by another verb.
      it("refuses to move a ticket out of the ticket set of a card a run owns", () => {
        const live = { ...wrongHome, labels: [LABELS.runLease(NOW + 60_000, "run-9")] };
        expect(reason(decide(MISFILED, [home(), live, subject()]))).toMatch(
          /anton-card9 is mid-run .* moving anton-a out of its ticket set/,
        );
        const claimed = warm(wrongHome.id, {
          issue_type: "feature",
          assignee: "runner-7",
          status: "in_progress",
        });
        expect(reason(decide(MISFILED, [home(), claimed, subject()]))).toMatch(
          /anton-card9 is held by runner-7 .* moving anton-a out of its ticket set/,
        );
      });

      // The outcome the ask wanted, put there by hand, is still the outcome — and re-homing a bead
      // is itself a write since the filing, so a fence asked before the settle check would refuse
      // the one answer the proposal most wants.
      it("settles a subject somebody has already moved home, fence or no fence", () => {
        expect(decide(MISFILED, [home(), warm("anton-a", { parent: CARD.id })])).toEqual({
          status: "settled",
          summary: "anton-a already sits under anton-card",
        });
      });

      // bd nesting runs to any depth, so the card that SHIPS the subject can be its grandparent —
      // and re-homing the bead in between hands the whole subtree to another card while leaving the
      // subject's own parent and stamp untouched. Every other bar re-derives ownership from the
      // fresh board and so records that newcomer as its own baseline; the PATH's stamps are the only
      // thing that dates the subtree's move against the filing.
      describe("whose subject reaches its card through another bead", () => {
        const via = (extra: Partial<Bead> = {}): Bead => child("anton-mid", wrongHome.id, extra);
        const nested = (mid: Bead): Bead[] => [
          home(),
          wrongHome,
          mid,
          child("anton-a", mid.id, { updated_at: "2025-01-01T00:00:00Z" }),
        ];

        it("moves it while the whole path predates the filing", () => {
          const decision = decide(MISFILED, nested(via({ updated_at: "2025-01-01T00:00:00Z" })));
          expect(decision.status).toBe("apply");
        });

        it("refuses when the bead in between was written after the filing", () => {
          expect(
            reason(decide(MISFILED, nested(via({ updated_at: "2026-07-15T00:00:00Z" })))),
          ).toMatch(
            /anton-a reaches the card that ships it through anton-mid, and anton-mid has been written to since this proposal was filed/,
          );
        });

        it("refuses when nothing dates the bead in between against the filing", () => {
          expect(reason(decide(MISFILED, nested(via())))).toMatch(
            /anton-a reaches the card that ships it through anton-mid, which carries no write stamp/,
          );
        });
      });
    });

    // An `implied-order` ask rests on ONE piece of evidence — a body phrase on one end of the pair —
    // and nothing downstream re-derives it: the step carries only the pair, and the
    // under-lock re-check asks whether the beads are writable, never whether the ordering is still
    // stated. Removing the evidence is a newer decision than the proposal, so drawing the edge
    // anyway would take the blocked bead back out of the ready set that edit put it in.
    it("refuses a link whose implied ordering the board no longer states", () => {
      expect(reason(decide(LINK, [bead("anton-aa"), bead("anton-bb")]))).toMatch(
        /nothing on the board still places anton-aa after anton-bb/,
      );
    });

    it("applies a link the board still implies, from either end's prose", () => {
      expect(decide(LINK, [ordered(), bead("anton-bb")]).status).toBe("apply");

      // The same signal read from the OTHER end: the blocker's own body puts itself first.
      const spelled = planFor({
        kind: "implied-order",
        move: "link",
        subjects: ["anton-aaa"],
        target: "anton-bbb",
      });
      const board = [
        bead("anton-aaa"),
        bead("anton-bbb", { description: "this blocks anton-aaa" }),
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
