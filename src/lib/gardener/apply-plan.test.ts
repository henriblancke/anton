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
  child,
  CLOSE,
  CLUSTER,
  cold,
  DEFER,
  edged,
  FILED,
  inReview,
  landed,
  leased,
  LINK,
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
        expect(refusal(decide(CLUSTER, [CARD, live, bead("anton-b")], NOW))).toMatch(
          /anton-a is mid-run/,
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
      expect(reason(decide(CLUSTER, [CARD, other, rehomed, bead("anton-b")]))).toMatch(
        /now rides board card anton-other/,
      );
    });

    // A move under another CONTAINER leaves the bead exactly as unreachable as the proposal says,
    // so it is still the fix rather than a decision to preserve.
    it("still re-homes a subject moved under something that is not a card", () => {
      expect(decide(REPARENT, [CARD, child("anton-a", "anton-container")]).status).toBe("apply");
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
