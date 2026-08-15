/**
 * THE WRITE HALF of apply-on-approve (anton-1t3n): a decided step re-checked under the write lock of
 * every bead it rests on, and undone again when a later step of the same cluster fails.
 *
 * Driven through `applyProposal`, because a step is only ever reached that way, and asserted through
 * the recorded seam calls — what matters is exactly which bd verb ran against which bead. Two claims
 * carry this file:
 *   • THE SNAPSHOT IS NOT THE LAST WORD. It is stale the instant it is taken, so every fact a step
 *     rests on is re-asked under the lock a competing run's claim also queues on.
 *   • NO PARTIAL APPLICATION. The only multi-write move is a cluster re-parent; a failure part-way
 *     rolls back what landed and leaves the proposal OPEN with the error attached.
 *
 * The decision these steps execute is asserted in `apply-plan.test.ts`; the composition of the two,
 * and the proposal's own settlement, in `apply.test.ts`.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { LABELS } from "../beads/bd";
import {
  apply,
  applyWith,
  bead,
  calls,
  CARD,
  child,
  CLOSE,
  CLUSTER,
  cold,
  DEFER,
  EPIC,
  failOn,
  FEATURE,
  GROUPED,
  landed,
  leased,
  LINK,
  listBoard,
  listByFlags,
  liveBeads,
  liveBoard,
  MISFILED,
  onWrite,
  ordered,
  planFor,
  proposalFor,
  record,
  REPARENT,
  resetSeam,
  runCard,
  setLive,
  showBead,
  SUPERSEDE,
  ticket,
  warm,
} from "./apply.fixture";

// Every reference to the seam sits INSIDE a wrapper: vitest hoists this factory above the imports
// above, so touching one while building the object would read it before it is initialised.
vi.mock("../beads/bd", async () => {
  const actual = await vi.importActual<typeof import("../beads/bd")>("../beads/bd");
  return {
    ...actual,
    beads: {
      ...actual.beads,
      show: (_cwd: string, id: string) => showBead(id),
      list: (_cwd: string, extra: string[] = []) => listBoard(extra),
      reparent: (_cwd: string, id: string, parent: string) => record("reparent", id, parent),
      link: (_cwd: string, a: string, b: string, type: string) => record("link", a, b, type),
      close: (_cwd: string, id: string, reason?: string) => record("close", id, reason ?? ""),
      supersede: (_cwd: string, id: string, w: string) => record("supersede", id, w),
      defer: (_cwd: string, id: string) => record("defer", id),
      update: (_cwd: string, id: string, patch: { priority?: number }) =>
        record("update", id, `P${patch.priority}`),
      note: (_cwd: string, id: string, text: string) => record("note", id, text),
      untag: (_cwd: string, id: string, labels: string[]) => record("untag", id, labels.join(",")),
    },
  };
});

beforeEach(resetSeam);

describe("under the write lock — what a decided step re-asks before it lands", () => {
  // Every topology re-check treats a board read it could not make as a refusal, so on a bd without
  // `--status all` a sound approval would refuse forever. The read goes through `loadAllIssues`,
  // which falls back to merging the open and closed listings.
  it("applies against a bd whose `list --status all` is unsupported", async () => {
    const proposal = proposalFor(REPARENT);
    listByFlags(async (extra) => {
      if (extra.includes("all")) throw new Error("unknown value for --status: all");
      const live = liveBoard();
      return extra.includes("closed")
        ? live.filter((b) => b.status === "closed")
        : live.filter((b) => b.status !== "closed");
    });

    const result = await apply(proposal, [CARD, bead("anton-a"), proposal]);

    expect(result.changed).toEqual(["anton-a"]);
    expect(calls[0]).toBe("reparent anton-a anton-card");
  });

  // The other half of the same staleness: the bead a step points AT. A run claiming the HOME between
  // the snapshot and the write has already selected its tickets, so subjects attached now ride along
  // unrun and strand when that run settles the card.
  it("refuses a home a run claimed AFTER the snapshot, without moving a subject", async () => {
    const proposal = proposalFor(REPARENT);
    liveBeads.set(CARD.id, { ...leased(CARD.id, Date.now()), issue_type: "feature" });

    await expect(apply(proposal, [CARD, bead("anton-a"), proposal])).rejects.toMatchObject({
      failure: "refused",
    });
    expect(calls).toEqual([
      `note ${proposal.id} gardener: apply FAILED — cannot apply ${proposal.id}: anton-card is mid-run — a run holds a live lease on it (runner-1), so hanging more work under it would race the run that owns it`,
    ]);
  });

  // The home's half of the window `isInFlight` cannot see: `bd --claim` writes assignee +
  // in_progress and publishes the lease a moment later, and a run that got that far has already
  // selected its tickets — so a subject attached now rides along unrun and strands when that run
  // settles the card. A claim the PLAN itself saw is not news and still applies — but only one the
  // filing stamp can DATE as older than the ask, which is what keeps the baseline honest.
  it("refuses a home claimed after the snapshot, before its run-lease is published", async () => {
    const held = { issue_type: "feature" as const, assignee: "runner-7", status: "in_progress" };
    const proposal = proposalFor(REPARENT);
    liveBeads.set(CARD.id, bead(CARD.id, held));

    await expect(apply(proposal, [CARD, bead("anton-a"), proposal])).rejects.toMatchObject({
      failure: "refused",
    });
    expect(calls).toEqual([
      `note ${proposal.id} gardener: apply FAILED — cannot apply ${proposal.id}: anton-card was claimed by runner-7 since this proposal was decided — that run has already selected the tickets it will work through, so work hung under it now would ride along unrun`,
    ]);

    calls.length = 0;
    liveBeads.clear();
    const sawItClaimed = cold(CARD.id, held);
    liveBeads.set(CARD.id, sawItClaimed);
    const again = proposalFor(REPARENT);
    await expect(apply(again, [sawItClaimed, bead("anton-a"), again])).resolves.toMatchObject({
      changed: ["anton-a"],
    });
    expect(calls[0]).toBe("reparent anton-a anton-card");
  });

  // Card attribution is board-wide, but the write that revokes it takes THIS lock: a legacy epic
  // stops being a card the instant a feature lands under it, and hanging one there is a re-parent
  // whose home is this same epic. Left with the snapshot, both approvals pass and the subject ends
  // up directly under a container epic — riding no card, which is the state the proposal fixes.
  it("refuses a home that stopped being a board card since the snapshot", async () => {
    const epic = bead("anton-epic", { issue_type: "epic" });
    const plan = planFor({
      kind: "container-orphan",
      move: "reparent",
      subjects: ["anton-a"],
      target: epic.id,
    });
    const proposal = proposalFor(plan);
    // Another approval hangs a feature under the epic between the snapshot and this write.
    liveBeads.set("anton-f1", child("anton-f1", epic.id, { issue_type: "feature" }));

    await expect(apply(proposal, [epic, bead("anton-a"), proposal])).rejects.toMatchObject({
      failure: "refused",
    });
    expect(calls).toEqual([
      `note ${proposal.id} gardener: apply FAILED — cannot apply ${proposal.id}: anton-epic is no longer a board card — re-parenting under it would leave the work riding no card, which is the state this proposal is about`,
    ]);
  });

  // The mirror image, one tier up: an epic stops being a CONTAINER the instant its last feature
  // leaves, and that move takes this same epic's write lock as its own subject's old home. Left with
  // the snapshot, a card lands under an epic that is now a run target in its own right — demoting it
  // out of its own run, which is the harm the tier bar exists to prevent.
  it("refuses a home that stopped being a container epic since the snapshot", async () => {
    const plan = planFor({
      kind: "container-orphan",
      move: "reparent",
      subjects: [FEATURE.id],
      target: EPIC.id,
    });
    const proposal = proposalFor(plan);
    // The one feature that made it a container is re-parented away between the snapshot and this
    // write, leaving the epic grouping nothing.
    liveBeads.set(GROUPED.id, bead(GROUPED.id, { issue_type: "feature" }));

    await expect(apply(proposal, [EPIC, GROUPED, FEATURE, proposal])).rejects.toMatchObject({
      failure: "refused",
    });
    expect(calls).toEqual([
      `note ${proposal.id} gardener: apply FAILED — cannot apply ${proposal.id}: anton-epic is no longer a container epic — it groups no cards, so it is a run target in its own right, and landing anton-feat under it would demote it: its own run is cancelled and any ticket it carries is left beneath a card nothing will reach (\`ticket-under-container-epic\`)`,
    ]);
  });

  it("refuses a blocker that landed, and a survivor that reopened, under the write lock", async () => {
    const link = proposalFor(LINK);
    liveBeads.set("anton-bb", bead("anton-bb", { status: "closed" }));
    await expect(
      apply(link, [ordered(), bead("anton-bb"), link]),
    ).rejects.toMatchObject({ failure: "refused" });
    expect(calls).toEqual([
      `note ${link.id} gardener: apply FAILED — cannot apply ${link.id}: anton-bb is closed — the work anton-aa was waiting on has landed, so the edge would only make anton-aa read as blocked forever`,
    ]);

    calls.length = 0;
    liveBeads.clear();
    const supersede = proposalFor(SUPERSEDE);
    // The snapshot says the survivor landed; by the time the write runs it is open again.
    liveBeads.set("anton-b", bead("anton-b", { status: "open" }));
    await expect(
      apply(supersede, [cold("anton-a"), landed(), supersede]),
    ).rejects.toMatchObject({ failure: "refused" });
    expect(calls).toEqual([
      `note ${supersede.id} gardener: apply FAILED — cannot apply ${supersede.id}: anton-b is open again — it has not landed, so anton-a is not superseded by it`,
    ]);
  });

  // The link's own premise, which nothing else under the lock reads: the blocker stays perfectly
  // usable while the ONE piece of evidence for the ordering — the prose on either end — is edited
  // away. A body edit takes these very locks (ticket-detail's updateTicket), so re-deriving the
  // premise from a board read taken inside them is what orders the two; left with the snapshot, the
  // edge is drawn after its evidence is gone and the blocked bead leaves the ready set that edit
  // put it in.
  it("refuses a link whose ordering evidence was removed after the snapshot", async () => {
    const gone = `nothing on the board still places anton-aa after anton-bb — the body phrase this proposal read has been removed since it was filed, so recording the edge would restore an ordering a newer decision took away`;

    const link = proposalFor(LINK);
    liveBeads.set("anton-aa", bead("anton-aa")); // the ordering phrase, rewritten mid-approval
    await expect(apply(link, [ordered(), bead("anton-bb"), link])).rejects.toMatchObject({
      failure: "refused",
    });
    expect(calls).toEqual([
      `note ${link.id} gardener: apply FAILED — cannot apply ${link.id}: ${gone}`,
    ]);

    calls.length = 0;
    liveBeads.clear();
    // The same premise read from the other end: the BLOCKER's body carried the phrase, and it went.
    const prose = proposalFor(LINK);
    const spelled = bead("anton-bb", { description: "this blocks anton-aa" });
    liveBeads.set("anton-bb", bead("anton-bb", { description: "rewritten" }));
    await expect(
      apply(prose, [bead("anton-aa"), spelled, prose]),
    ).rejects.toMatchObject({ failure: "refused" });
    expect(calls).toEqual([
      `note ${prose.id} gardener: apply FAILED — cannot apply ${prose.id}: ${gone}`,
    ]);
  });

  // A survivor abandoned in the window between the proposal and the approval stays `closed`, so the
  // status alone still reads as "the work landed over there". It did not: superseding onto it would
  // retire the last live copy of the work in favour of a recorded won't-do.
  it("refuses a survivor abandoned since the snapshot, under the write lock", async () => {
    const supersede = proposalFor(SUPERSEDE);
    liveBeads.set("anton-b", bead("anton-b", { labels: [LABELS.abandoned], status: "closed" }));

    await expect(
      apply(supersede, [cold("anton-a"), landed(), supersede]),
    ).rejects.toMatchObject({ failure: "refused" });
    expect(calls).toEqual([
      `note ${supersede.id} gardener: apply FAILED — cannot apply ${supersede.id}: anton-b is abandoned — a recorded won't-do delivered nothing, so anton-a is not superseded by it`,
    ]);
  });

  // Every retirement rests on a claim about the subject's CONTENTS, and an edit that rescopes the
  // work leaves status, liveness, claim and topology exactly as the plan found them — so nothing
  // else under the lock notices. The filing-time check ran against the route's snapshot, which is
  // already stale when the first write spawns; the step carries the fence forward so the locked
  // re-read asks it again.
  it("refuses a retirement whose subject was rewritten after the snapshot", async () => {
    for (const [plan, still] of [
      [DEFER, "the untouched bead the ask describes"],
      [CLOSE, "the bead the commit behind this ask shipped"],
    ] as const) {
      calls.length = 0;
      liveBeads.clear();
      const proposal = proposalFor(plan);
      liveBeads.set("anton-a", warm("anton-a"));

      await expect(apply(proposal, [cold("anton-a"), proposal])).rejects.toMatchObject({
        failure: "refused",
      });
      expect(calls).toEqual([
        `note ${proposal.id} gardener: apply FAILED — cannot apply ${proposal.id}: anton-a has been written to since this proposal was filed — it is no longer ${still}, and ${plan === DEFER ? "deferring it now would park work somebody has since picked back up" : "closing it as shipped now would record a landing for work that may have been rescoped since"}`,
      ]);
    }
  });

  // The survivor's end of the same premise. It stays `closed` and non-abandoned however far its
  // contents drift, so `survivorUnusable` waves it through — and superseding onto a twin that no
  // longer holds the work would close the last live copy of it.
  it("refuses a supersede whose survivor was rewritten after the snapshot", async () => {
    const proposal = proposalFor(SUPERSEDE);
    liveBeads.set("anton-b", warm("anton-b", { status: "closed" }));

    await expect(
      apply(proposal, [cold("anton-a"), landed(), proposal]),
    ).rejects.toMatchObject({ failure: "refused" });
    expect(calls).toEqual([
      `note ${proposal.id} gardener: apply FAILED — cannot apply ${proposal.id}: anton-b has been written to since this proposal was filed — it is no longer the landed twin whose contents this bead matched, and superseding onto it now could retire the only copy of that work still open`,
    ]);
  });

  // The home claim's two ends, re-asked against reads taken INSIDE the write locks. The snapshot
  // decision cleared both, and it is already stale when the first write spawns — an edit landing in
  // that window leaves status, liveness, claim and tier exactly as the plan found them, so nothing
  // else under the lock objects.
  it.each([
    ["subject", "anton-a", "the bead whose contract this home was chosen for"],
    ["home", CARD.id, "the home whose contract this bead was judged to belong under"],
  ])("refuses a misfiled move whose %s was rewritten after the snapshot", async (_end, id, still) => {
    const proposal = proposalFor(MISFILED);
    const home = cold(CARD.id, { issue_type: "feature" });
    const subject = child("anton-a", "anton-card9", { updated_at: "2025-01-01T00:00:00Z" });
    liveBeads.set(id, warm(id, id === CARD.id ? { issue_type: "feature" } : { parent: "anton-card9" }));

    await expect(
      apply(proposal, [home, bead("anton-card9", { issue_type: "feature" }), subject, proposal]),
    ).rejects.toMatchObject({ failure: "refused" });
    expect(calls).toEqual([
      expect.stringContaining(`${id} has been written to since this proposal was filed — it is no longer ${still}`),
    ]);
  });

  // A re-parent is the one verb whose subject can move without changing status, so the status checks
  // above see nothing: another approval or an operator re-homing it is a NEWER decision than this
  // plan, and applying over it would silently undo their move.
  it("refuses a subject another write has re-parented since the plan was made", async () => {
    const proposal = proposalFor(REPARENT);
    liveBeads.set("anton-a", child("anton-a", "anton-elsewhere"));

    await expect(
      apply(proposal, [CARD, child("anton-a", "anton-old"), proposal]),
    ).rejects.toMatchObject({ failure: "refused" });
    expect(calls).toEqual([
      `note ${proposal.id} gardener: apply FAILED — cannot apply ${proposal.id}: anton-a now sits under anton-elsewhere rather than anton-old — it was re-parented since this proposal was filed, and moving it to anton-card would overwrite that`,
    ]);
  });

  // Two approvals whose snapshots each say the card is empty: a re-parent attaching work under it
  // takes the SAME lock this settle holds, so re-reading the subtree under that lock is what orders
  // them. Without it the newcomer is left beneath a card no run will ever reach.
  it("refuses to settle a bead that gained open work under it since the snapshot", async () => {
    const proposal = proposalFor(CLOSE);
    liveBeads.set("anton-t9", child("anton-t9", "anton-a"));

    await expect(
      apply(proposal, [cold("anton-a", { issue_type: "feature" }), proposal]),
    ).rejects.toMatchObject({ failure: "refused" });
    expect(calls).toEqual([
      `note ${proposal.id} gardener: apply FAILED — cannot apply ${proposal.id}: anton-a has open work under it (anton-t9) since this proposal was filed — settling it would strand that work beneath a card nothing will run`,
    ]);
  });

  it("settles a bead whose subtree is all closed, on the board as the lock reads it", async () => {
    const proposal = proposalFor(CLOSE);
    const board = [
      cold("anton-a", { issue_type: "feature" }),
      child("anton-t1", "anton-a", { status: "closed" }),
      proposal,
    ];

    const result = await apply(proposal, board);

    expect(result.changed).toEqual(["anton-a"]);
    expect(calls[0]).toBe("close anton-a closed by an approved gardener proposal (shipped-orphan)");
  });

  it("refuses a subject a run claimed AFTER the snapshot, without writing to it", async () => {
    const proposal = proposalFor(DEFER);
    liveBeads.set("anton-a", leased("anton-a", Date.now()));

    await expect(apply(proposal, [cold("anton-a"), proposal])).rejects.toMatchObject({
      failure: "refused",
    });
    // The snapshot said "open and unclaimed"; the locked read said otherwise, and nothing was written.
    expect(calls).toEqual([
      `note ${proposal.id} gardener: apply FAILED — cannot apply ${proposal.id}: anton-a is mid-run — a run holds a live lease on it (runner-1), so retiring it would race the run that owns it`,
    ]);
  });

  // The lease is published a moment AFTER the assignee and in_progress that `bd --claim` writes as
  // one act, so for that window a freshly claimed bead reads as unowned work to the in-flight bar.
  // A pickup queues on the same per-bead chain this apply locks, which is what makes the window
  // closable at all: take the claim protocol's lock and then ignore what the claim wrote, and the
  // move lands on work a runner has already started.
  it("refuses a subject claimed after the snapshot, before its run-lease is published", async () => {
    const proposal = proposalFor(DEFER);
    liveBeads.set("anton-a", bead("anton-a", { assignee: "runner-7", status: "in_progress" }));

    await expect(apply(proposal, [cold("anton-a"), proposal])).rejects.toMatchObject({
      failure: "refused",
    });
    expect(calls).toEqual([
      `note ${proposal.id} gardener: apply FAILED — cannot apply ${proposal.id}: anton-a was claimed by runner-7 since this proposal was decided — retiring it would pull the bead out from under the run that now owns it`,
    ]);
  });

  // A retirement's subject can be a TICKET of a run target, and that target is where a run becomes
  // visible at all. A run picks it up on the very per-bead chain this apply locks, so the claim
  // either lands before this read or queues behind the write — and refusing here is what makes that
  // ordering worth anything. The run's own post-lease re-confirmation (execute-epic step 1c) closes
  // the other side.
  it("refuses to retire a ticket of a card a run claimed AFTER the snapshot", async () => {
    const proposal = proposalFor(DEFER);
    liveBeads.set("anton-run", runCard({ assignee: "runner-7", status: "in_progress" }));

    await expect(apply(proposal, [runCard(), ticket(), proposal])).rejects.toMatchObject({
      failure: "refused",
    });
    expect(calls).toEqual([
      `note ${proposal.id} gardener: apply FAILED — cannot apply ${proposal.id}: anton-run was claimed by runner-7 since this proposal was decided — that run has already selected the tickets it will work through, so retiring anton-a out of its ticket set would abort it when its claim reaches a bead the board no longer holds`,
    ]);
  });

  it("refuses to retire a ticket of a card whose run published its lease after the snapshot", async () => {
    const proposal = proposalFor(DEFER);
    liveBeads.set("anton-run", runCard({ labels: [LABELS.runLease(Date.now() + 60_000, "run-9")] }));

    await expect(apply(proposal, [runCard(), ticket(), proposal])).rejects.toMatchObject({
      failure: "refused",
    });
    expect(calls.some((c) => c.startsWith("defer"))).toBe(false);
    expect(calls[0]).toMatch(/anton-run is mid-run .* retiring anton-a out of its ticket set/);
  });

  // The owner is captured from the SNAPSHOT, so re-reading it only answers "has that card started".
  // A re-parent approval landing in the window puts the subject under a different run target — one
  // this step never locked and never re-reads — and retiring it there aborts a run this approval
  // never looked at. The re-parent takes the subject's own lock, so the two orders are serialized.
  it("refuses to retire a subject moved onto another card's ticket set since the snapshot", async () => {
    const other = bead("anton-other", { issue_type: "feature" });
    for (const plan of [DEFER, CLOSE]) {
      calls.length = 0;
      liveBeads.clear();
      const proposal = proposalFor(plan);
      liveBeads.set("anton-a", { ...ticket(), parent: other.id });

      await expect(
        apply(proposal, [runCard(), ticket(), other, proposal]),
      ).rejects.toMatchObject({ failure: "refused" });
      expect(calls).toEqual([
        `note ${proposal.id} gardener: apply FAILED — cannot apply ${proposal.id}: anton-a now rides anton-other's ticket set rather than anton-run's ticket set — the run target it hangs under changed since this proposal was decided, so retiring anton-a out of its ticket set would act on a ticket set this approval never looked at`,
      ]);
    }
  });

  // A re-parent raids a ticket set exactly as a retirement does — it hands the bead to another card
  // — so it locks the card the subject is LEAVING and re-reads it too. The pickup queues on that
  // same per-bead chain, so either the claim lands before this read or it queues behind the write.
  it("refuses to move a ticket out of a card a run claimed AFTER the snapshot", async () => {
    const proposal = proposalFor(MISFILED);
    const from = bead("anton-card9", { issue_type: "feature" });
    liveBeads.set(from.id, { ...from, assignee: "runner-7", status: "in_progress" });

    const board = [cold(CARD.id, { issue_type: "feature" }), from, cold("anton-a", { parent: from.id })];
    await expect(apply(proposal, [...board, proposal])).rejects.toMatchObject({
      failure: "refused",
    });
    expect(calls.some((c) => c.startsWith("reparent"))).toBe(false);
    expect(calls[0]).toMatch(
      /anton-card9 was claimed by runner-7 since this proposal was decided .* moving anton-a out of its ticket set/,
    );
  });

  // The same gap from the other side: a subject that rode NO ticket set when the plan was made, and
  // has since been hung under a card. Nothing on the step names an owner at all, so there is no
  // re-read to catch it — only re-deriving ownership under the lock does.
  it("refuses to retire a subject given a ticket set it did not have at decision time", async () => {
    const proposal = proposalFor(DEFER);
    liveBeads.set("anton-a", { ...cold("anton-a"), parent: "anton-run" });

    await expect(
      apply(proposal, [runCard(), cold("anton-a"), proposal]),
    ).rejects.toMatchObject({ failure: "refused" });
    expect(calls[0]).toMatch(/anton-a now rides anton-run's ticket set rather than no ticket set/);
    expect(calls.some((c) => c.startsWith("defer"))).toBe(false);
  });

  // The card is not written to, so a run that RELEASED it since — or held it all along, which is
  // what a stale ticket under a dead run looks like — is no reason to refuse.
  it("retires a ticket of a card no run holds under the lock", async () => {
    const proposal = proposalFor(DEFER);
    liveBeads.set("anton-run", runCard());

    const held = runCard({
      assignee: "runner-7",
      status: "in_progress",
      updated_at: "2025-01-01T00:00:00Z",
    });
    await expect(apply(proposal, [held, ticket(), proposal])).resolves.toMatchObject({
      changed: ["anton-a"],
    });
    expect(calls[0]).toBe("defer anton-a");
  });

  // The stale-in-progress detector proposes against beads that are ALREADY claimed — a claim that
  // outlived its run is the whole finding. Refusing on the claim the plan itself was decided against
  // would make that proposal permanently unapprovable.
  // Both live reads stay `cold`: the locked re-read re-asks the retirement's PREMISE too, and a
  // subject with no write stamp — or one dated since the filing — refuses on that instead, which
  // would prove nothing about the claim baseline this case is here for.
  it("applies to a bead whose claim the plan already saw, and to one released since", async () => {
    for (const live of [
      cold("anton-a", { assignee: "runner-7", status: "in_progress" }),
      cold("anton-a", { status: "open" }),
    ]) {
      calls.length = 0;
      liveBeads.clear();
      liveBeads.set("anton-a", live);
      const proposal = proposalFor(DEFER);
      const claimed = cold("anton-a", { assignee: "runner-7", status: "in_progress" });

      await expect(apply(proposal, [claimed, proposal])).resolves.toMatchObject({
        changed: ["anton-a"],
      });
      expect(calls[0]).toBe("defer anton-a");
    }
  });

  // Each verb re-reads its OWN subject, so a case carries the board that subject lives on: a link is
  // asked of the `anton-aa`/`anton-bb` pair its ordering evidence is written on, not the `anton-a`
  // the other two move. The refusal is asserted by REASON, because a subject the board never carried
  // refuses too — on "no longer on the board" — and would pass a bare `failure: "refused"` while
  // proving nothing about the settlement this case is here for.
  it("refuses a subject that settled after the snapshot, per verb", async () => {
    const settled = "— the board moved on since this was proposed";
    for (const [plan, id, gone, board, why] of [
      [
        REPARENT,
        "anton-a",
        bead("anton-a", { status: "closed" }),
        [CARD, bead("anton-a")],
        `anton-a is closed ${settled}`,
      ],
      [
        LINK,
        "anton-aa",
        ordered(bead("anton-aa", { labels: [LABELS.abandoned], status: "closed" })),
        [ordered(), bead("anton-bb")],
        `anton-aa is abandoned ${settled}`,
      ],
      // …and the same subject gone from the board entirely, which bd answers as a failed `show`
      // rather than an absent bead — so the refusal names the READ, not a vanishing. Its snapshot
      // self is `cold`, because a retirement re-asks its own premise here too: a subject with no
      // write stamp refuses on that instead, before the re-read this case is about.
      [
        CLOSE,
        "anton-a",
        undefined,
        [cold("anton-a")],
        "anton-a could not be re-read before applying the move (bd show: no such issue anton-a) — nothing was written",
      ],
    ] as const) {
      calls.length = 0;
      liveBeads.clear();
      liveBeads.set(id, gone);
      const proposal = proposalFor(plan);
      await expect(applyWith(proposal, [...board])).rejects.toMatchObject({ failure: "refused" });
      // The note is the whole record: the reason it refused for, and no write beside it.
      expect(calls).toEqual([
        `note ${proposal.id} gardener: apply FAILED — cannot apply ${proposal.id}: ${why}`,
      ]);
    }
  });
});

describe("rolling back a cluster that failed part-way — the board must end unchanged", () => {
  // A rollback must undo THIS apply's move, not whatever the bead's parent happens to be now: a
  // concurrent approval of a different proposal can move the same subject between the per-step
  // locks, and restoring the old parent over it would clobber a move that is now the board's truth.
  it("leaves a rolled-back subject alone when another write has since moved it", async () => {
    const proposal = proposalFor(CLUSTER);
    const board = [CARD, child("anton-a", "anton-old"), bead("anton-b"), proposal];
    failOn.set("reparent:anton-b", 1);
    // Somebody else re-parents anton-a the moment this apply moves on to anton-b.
    onWrite((call) => {
      if (call === "reparent anton-a anton-card") setLive("anton-a", { parent: "anton-elsewhere" });
    });

    await expect(apply(proposal, board)).rejects.toThrow(/another write has since moved/);

    // No second write to anton-a: its undo would have fought the move that overtook it.
    expect(calls.filter((c) => c.startsWith("reparent anton-a"))).toEqual([
      "reparent anton-a anton-card",
    ]);
    expect(calls.some((c) => c.startsWith(`close ${proposal.id}`))).toBe(false);
  });

  // A cluster member somebody else has already moved to the target is accepted as idempotent — the
  // same move, so refusing would fail the whole cluster over an agreement. But it is not OUR write,
  // and a later member failing must not restore `undoParent` over the other writer's move.
  it("never rolls back a member the board already satisfied — that write was not ours", async () => {
    const proposal = proposalFor(CLUSTER);
    const board = [CARD, child("anton-a", "anton-old"), bead("anton-b"), proposal];
    // Another approval lands anton-a's move between the snapshot and this apply's per-step lock.
    liveBeads.set("anton-a", child("anton-a", CARD.id));
    failOn.set("reparent:anton-b", 1);

    await expect(apply(proposal, board)).rejects.toThrow(/nothing had been written/);

    // Neither a redundant re-write nor — the bug — an undo back to anton-old.
    expect(calls.filter((c) => c.startsWith("reparent anton-a"))).toEqual([]);
    expect(calls.some((c) => c.startsWith(`close ${proposal.id}`))).toBe(false);
  });

  // A cluster that loses its second subject mid-apply is a PARTIAL application, not a clean refusal:
  // the prefix has to come back out, and the proposal has to stay open saying so.
  it("rolls back the prefix when a later subject moves under the apply", async () => {
    const proposal = proposalFor(CLUSTER);
    liveBeads.set("anton-b", leased("anton-b", Date.now()));

    await expect(
      apply(proposal, [CARD, child("anton-a", "anton-old"), bead("anton-b"), proposal]),
    ).rejects.toMatchObject({ failure: "failed" });

    expect(calls).toEqual([
      "reparent anton-a anton-card",
      "reparent anton-a anton-old", // undone, back to where it was
      `note ${proposal.id} gardener: apply FAILED — applying ${proposal.id} failed: anton-b is mid-run — a run holds a live lease on it (runner-1), so moving it would race the run that owns it — the 1 write(s) already made were rolled back, so the board is unchanged`,
    ]);
    expect(calls.some((c) => c.startsWith(`close ${proposal.id}`))).toBe(false);
  });

  it("rolls back a half-applied cluster and leaves the proposal OPEN with the error attached", async () => {
    const proposal = proposalFor(CLUSTER);
    const board = [CARD, child("anton-a", "anton-old"), bead("anton-b"), proposal];
    failOn.set("reparent:anton-b", 1);

    await expect(apply(proposal, board)).rejects.toThrow(/rolled back/);

    expect(calls).toEqual([
      "reparent anton-a anton-card",
      "reparent anton-b anton-card", // the failure
      "reparent anton-a anton-old", // undone, back to where it was
      `note ${proposal.id} gardener: apply FAILED — applying ${proposal.id} failed: bd reparent exploded — the 1 write(s) already made were rolled back, so the board is unchanged`,
    ]);
    // The one thing a failed apply must never do.
    expect(calls.some((c) => c.startsWith(`close ${proposal.id}`))).toBe(false);
  });

  it("says so loudly when the rollback ITSELF fails — a board a human has to look at", async () => {
    const proposal = proposalFor(CLUSTER);
    const board = [CARD, child("anton-a", "anton-old"), bead("anton-b"), proposal];
    failOn.set("reparent:anton-b", 1);
    // The SECOND write to anton-a is its undo — fail that too, and the board is left half-moved.
    failOn.set("reparent:anton-a", 2);

    await expect(apply(proposal, board)).rejects.toThrow(/ROLLBACK INCOMPLETE/);
    expect(calls.some((c) => c.startsWith(`close ${proposal.id}`))).toBe(false);
  });

  // The rollback's other end: an early cluster member lands, a run starts on the HOME and confirms
  // that member into its ticket set (execute-epic step 1c, under the home's own lock), and only then
  // does a later member fail. Detaching now would pull a ticket out of a selection that run has
  // already fixed — so the move is left in place and named, which is why the rollback takes the
  // home's lock as well as the subject's.
  it("leaves a rolled-back subject under a home a run has since started on", async () => {
    const proposal = proposalFor(CLUSTER);
    const board = [CARD, child("anton-a", "anton-old"), bead("anton-b"), proposal];
    // The run picks the card up the instant the first member lands under it.
    onWrite((call) => {
      if (call === "reparent anton-a anton-card") {
        liveBeads.set(CARD.id, leased(CARD.id, Date.now()));
      }
    });

    await expect(apply(proposal, board)).rejects.toThrow(
      /ROLLBACK INCOMPLETE: anton-a was left in place because a run has since started on the card/,
    );

    // One write to anton-a: the move. No detach out from under the run that now owns the card.
    expect(calls.filter((c) => c.startsWith("reparent anton-a"))).toEqual([
      "reparent anton-a anton-card",
    ]);
    expect(calls.some((c) => c.startsWith(`close ${proposal.id}`))).toBe(false);
  });

  // The ownership read is what tells a rollback the step is still ours to undo. When it FAILS it
  // proves nothing — and restoring blind would overwrite a newer move with no trace that it happened,
  // so the step is named for a human instead.
  it("strands a rolled-back subject whose ownership read fails, rather than restoring blind", async () => {
    const proposal = proposalFor(CLUSTER);
    const board = [CARD, child("anton-a", "anton-old"), bead("anton-b"), proposal];
    failOn.set("reparent:anton-b", 1);
    // anton-a becomes unreadable the moment its move lands, so the rollback can't prove it owns it.
    onWrite((call) => {
      if (call === "reparent anton-a anton-card") liveBeads.set("anton-a", undefined);
    });

    await expect(apply(proposal, board)).rejects.toThrow(
      /ROLLBACK INCOMPLETE: anton-a could not be restored/,
    );

    // One write to anton-a: the move. No blind restore behind an unreadable board.
    expect(calls.filter((c) => c.startsWith("reparent anton-a"))).toEqual([
      "reparent anton-a anton-card",
    ]);
    expect(calls.some((c) => c.startsWith(`close ${proposal.id}`))).toBe(false);
  });

  // An incomplete rollback is the one message a human acts on by hand, so it has to name EVERY bead
  // left somewhere other than where it started — including the ones a concurrent write moved, which
  // are otherwise only reported when the rollback was otherwise clean.
  it("names overtaken subjects alongside the ones it could not restore", async () => {
    const plan = planFor({
      kind: "parentless-cluster",
      move: "reparent",
      subjects: ["anton-a", "anton-b", "anton-c"],
      target: CARD.id,
    });
    const proposal = proposalFor(plan);
    const board = [
      CARD,
      child("anton-a", "anton-old"),
      child("anton-b", "anton-old"),
      child("anton-c", "anton-old"),
      proposal,
    ];
    failOn.set("reparent:anton-c", 1);
    onWrite((call) => {
      if (call !== "reparent anton-b anton-card") return;
      // Someone else's approval moves anton-a on; anton-b becomes unreadable.
      liveBeads.set("anton-a", child("anton-a", "anton-elsewhere"));
      liveBeads.set("anton-b", undefined);
    });

    await expect(apply(proposal, board)).rejects.toThrow(
      /ROLLBACK INCOMPLETE: anton-b could not be restored; anton-a was left where another write has since moved it/,
    );

    // Neither was written to twice: no blind restore, no clobbering the newer move.
    expect(calls.filter((c) => c.startsWith("reparent"))).toEqual([
      "reparent anton-a anton-card",
      "reparent anton-b anton-card",
      "reparent anton-c anton-card",
    ]);
    expect(calls.some((c) => c.startsWith(`close ${proposal.id}`))).toBe(false);
  });
});
