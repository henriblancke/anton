/**
 * finalizeMergedEpic's board write (anton-aijz): a merged run target and its still-open children
 * must close in ONE bd transaction, and `stage:in-review` may only drop once that transaction
 * lands — a failure has to leave the label in place so the next sweep re-selects the epic and
 * retries, rather than orphaning a still-open ticket behind a run already marked done.
 *
 * And what that transaction may contain (anton-67xj.1): the children the run never delivered — the
 * ones it blocked, and the ones left waiting behind them — stay open, or the merge silently retires
 * work a human still has to run.
 *
 * And when it may run (PR #199): last. A closed run target is invisible to the next sweep whatever
 * labels it carries, so the close has to follow every other finalization write — otherwise a stop
 * between them leaves the undelivered children stranded under a merged target with nothing on the
 * board left to retry.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { LABELS, type Bead } from "../beads/bd";
import { contractGaps } from "../beads/contract";

const batchMock = vi.fn();
const untagMock = vi.fn();
const noteMock = vi.fn();
const createMock = vi.fn();
const reparentMock = vi.fn();
const deleteMock = vi.fn();
const unassignMock = vi.fn();
const setStatusMock = vi.fn();
const showMock = vi.fn();
/** id → current assignee, so the claim guard's CAS (show → unassign → show) reads a live board. */
const assignees = new Map<string, string>();
/** id → current status, so the re-read before a status write sees the board, not the snapshot. */
const statuses = new Map<string, string>();
/** id → current parent, so the re-read before a reparent sees the board, not the snapshot. */
const parents = new Map<string, string | undefined>();
/** id → current labels, so a re-read still carries the `not-delivered` marker the lane turns on. */
const boardLabels = new Map<string, string[]>();

vi.mock("../beads/bd", async () => {
  const actual =
    await vi.importActual<typeof import("../beads/bd")>("../beads/bd");
  return {
    ...actual,
    beads: {
      ...actual.beads,
      batch: (...args: unknown[]) => batchMock(...args),
      untag: (...args: unknown[]) => untagMock(...args),
      note: (...args: unknown[]) => noteMock(...args),
      create: (...args: unknown[]) => createMock(...args),
      reparent: (...args: unknown[]) => reparentMock(...args),
      delete: (...args: unknown[]) => deleteMock(...args),
      unassign: (...args: unknown[]) => unassignMock(...args),
      setStatus: (...args: unknown[]) => setStatusMock(...args),
      show: (...args: unknown[]) => showMock(...args),
    },
  };
});

vi.mock("../git/worktree", () => ({
  findWorktree: vi.fn().mockResolvedValue(undefined),
  removeWorktree: vi.fn().mockResolvedValue(undefined),
  worktreePathFor: (repo: string, branch: string) => `${repo}/.wt/${branch}`,
  createWorktree: vi.fn(),
}));

const findOpenRunMock = vi.fn();
const updateRunMock = vi.fn();

vi.mock("../runs", () => ({
  findOpenRunForEpic: (...args: unknown[]) => findOpenRunMock(...args),
  updateRun: (...args: unknown[]) => updateRunMock(...args),
}));

const { finalizeMergedEpic, undeliveredAtMerge } = await import("./review-fix");

/** Seeds the live board with the same status, so a re-read agrees with the snapshot by default. */
const bead = (id: string, status = "open", labels: string[] = []): Bead => {
  statuses.set(id, status);
  boardLabels.set(id, labels);
  return { id, title: id, status, labels } as Bead;
};

/** A bead reserved by `owner`, seeded into the live-board map the claim CAS re-reads. */
const claimed = (b: Bead, owner: string): Bead => {
  assignees.set(b.id, owner);
  return { ...b, assignee: owner } as Bead;
};

/** A ticket that waits on `blocker` — the `blocks` edge bd carries inline on the dependent. */
const waitsOn = (id: string, blocker: string, status = "open"): Bead =>
  ({
    ...bead(id, status),
    dependencies: [{ issue_id: id, depends_on_id: blocker, type: "blocks" }],
  }) as Bead;

/**
 * A ticket nested under another TICKET rather than directly under the run target — the shape
 * `runTickets` hands a run at arbitrary depth. Seeds both the snapshot link and the live board.
 */
const under = (parent: string, b: Bead): Bead => {
  parents.set(b.id, parent);
  return { ...b, parent } as Bead;
};

/** `rest` is the rest of the board — the product epic a feature target hangs off, say. */
const finalize = (epic: Bead, children: Bead[], rest: Bead[] = []) => {
  // Children hang off the target they were run under (the snapshot the sweep read), unless a case
  // nested them explicitly. `parents` is the LIVE board, so a case can seed a takeover there alone.
  const linked = children.map((c) => {
    if (c.id === epic.id) return c;
    if (!parents.has(c.id)) parents.set(c.id, epic.id);
    return { ...c, parent: c.parent ?? epic.id } as Bead;
  });
  return finalizeMergedEpic({
    db: {} as never,
    clock: { now: () => 0 } as never,
    repo: "/repo",
    projectId: "p1",
    epic,
    children: linked,
    branch: "anton/epic-1",
    all: [epic, ...linked, ...rest],
  });
};

describe("finalizeMergedEpic", () => {
  beforeEach(() => {
    batchMock.mockReset().mockResolvedValue(undefined);
    untagMock.mockReset().mockResolvedValue(undefined);
    noteMock.mockReset().mockResolvedValue(undefined);
    createMock.mockReset().mockResolvedValue("epic-2");
    reparentMock.mockReset().mockResolvedValue(undefined);
    deleteMock.mockReset().mockResolvedValue(undefined);
    assignees.clear();
    statuses.clear();
    parents.clear();
    boardLabels.clear();
    unassignMock
      .mockReset()
      .mockImplementation(async (_repo: string, id: string) => {
        assignees.delete(id);
      });
    setStatusMock.mockReset().mockResolvedValue(undefined);
    findOpenRunMock.mockReset().mockResolvedValue(null);
    updateRunMock.mockReset().mockResolvedValue(undefined);
    showMock.mockReset().mockImplementation(
      async (_repo: string, id: string) =>
        ({
          id,
          title: id,
          status: statuses.get(id) ?? "open",
          labels: boardLabels.get(id) ?? [],
          assignee: assignees.get(id),
          parent: parents.get(id),
        }) as Bead,
    );
  });

  it("closes the still-open children and the target in one batch, children first", async () => {
    await finalize(bead("epic-1"), [
      bead("t1"),
      bead("t2", "closed"),
      bead("t3"),
    ]);

    expect(batchMock).toHaveBeenCalledTimes(1);
    // Already-closed t2 is left out: re-closing it is noise, and its outcome is already settled.
    expect(batchMock.mock.calls[0][1]).toEqual([
      { op: "close", id: "t1" },
      { op: "close", id: "t3" },
      { op: "close", id: "epic-1" },
    ]);
    expect(untagMock).toHaveBeenCalledWith("/repo", "epic-1", [
      "stage:in-review",
    ]);
  });

  it("leaves an already-closed target out of the batch but still clears the stage", async () => {
    // The idempotent re-run: a prior sweep closed everything and only the label write failed.
    await finalize(bead("epic-1", "closed"), [bead("t1", "closed")]);

    expect(batchMock.mock.calls[0][1]).toEqual([]); // nothing left to close (the seam spawns no bd)
    expect(untagMock).toHaveBeenCalledWith("/repo", "epic-1", [
      "stage:in-review",
    ]);
  });

  it("leaves a `not-delivered` child open — a merged PR does not contain it", async () => {
    // The run that opened this PR absorbed a ticket timeout: `t2` was rolled back and `t3` was
    // skipped behind it, so neither is in the merged diff. Closing them here would file work that
    // was never done as shipped and lose it silently.
    await finalize(bead("epic-1"), [
      bead("t1"),
      bead("t2", "blocked", ["not-delivered"]),
      bead("t3", "open", ["not-delivered"]),
    ]);

    expect(batchMock.mock.calls[0][1]).toEqual([
      { op: "close", id: "t1" },
      { op: "close", id: "epic-1" },
    ]);
    // The target still closes — the PR it points at is merged and terminal — so the preserved
    // tickets say for themselves why they outlived it.
    expect(untagMock).toHaveBeenCalledWith("/repo", "epic-1", [
      "stage:in-review",
    ]);
    expect(noteMock.mock.calls.map((c) => c[1])).toEqual(["t2", "t3"]);
    expect(noteMock.mock.calls[0][2]).toContain("merged WITHOUT this ticket");
  });

  it("rehomes the preserved tickets under a new run target", async () => {
    // A ticket parented to the merged (now closed) target is not a run target, and the target
    // itself short-circuits on its merged PR ref — so without a new home the note telling the
    // operator to re-run this work names nothing anton can claim.
    await finalize(bead("epic-1", "open", ["area:runs", "approved"]), [
      bead("t1"),
      bead("t2", "blocked", ["not-delivered"]),
    ]);

    expect(createMock).toHaveBeenCalledTimes(1);
    const opts = createMock.mock.calls[0][1];
    expect(opts.type).toBe("epic"); // an epic with no feature children IS a run target
    expect(opts.labels).toEqual(["area:runs"]); // inherited; `approved` deliberately is NOT
    // Runnable means runnable: the follow-up must clear the same contract gate the approve route
    // and execute-epic apply, or anton would refuse the target it just wrote for itself.
    const created = {
      id: "epic-2",
      issue_type: opts.type,
      acceptance: opts.acceptance,
      description: opts.description,
      labels: opts.labels,
    } as Bead;
    expect(contractGaps([created], "blocking")).toEqual([]);
    expect(reparentMock).toHaveBeenCalledWith("/repo", "t2", "epic-2");
    expect(noteMock.mock.calls[0][2]).toContain("now lives under epic-2");
  });

  it("takes the follow-up's area: off the product epic when the merged target is a feature", async () => {
    // The normal shape: Add-work puts `area:` on the PRODUCT EPIC, never on the feature under it.
    // Reading only the feature's labels would file the follow-up arealess — ungrouped on the
    // roadmap and without the Linear routing key — and it lands top-level, so nothing downstream
    // can derive one for it either.
    const feature = {
      ...bead("feat-1"),
      issue_type: "feature",
      parent: "epic-p",
    } as Bead;
    const product = bead("epic-p", "open", ["area:runs", "approved"]);

    await finalize(
      feature,
      [bead("t2", "blocked", ["not-delivered"])],
      [product],
    );

    expect(createMock.mock.calls[0][1].labels).toEqual(["area:runs"]);
  });

  it("names the manual remedy when the ticket cannot be rehomed", async () => {
    createMock.mockRejectedValue(new Error("bd create: DB locked"));

    await finalize(bead("epic-1"), [bead("t2", "blocked", ["not-delivered"])]);

    // Finalization still completes — its closes already landed — but the note must not claim a
    // home the ticket never reached.
    expect(untagMock).toHaveBeenCalledWith("/repo", "epic-1", [
      "stage:in-review",
    ]);
    expect(noteMock.mock.calls[0][2]).toContain("could NOT be rehomed");
  });

  it("deletes the follow-up target again when no ticket reaches it", async () => {
    reparentMock.mockRejectedValue(new Error("bd update: DB locked"));

    await finalize(bead("epic-1"), [bead("t2", "blocked", ["not-delivered"])]);

    // A childless epic is a poison run, not a home — leaving one behind trades an unreachable
    // ticket for an unrunnable target.
    expect(deleteMock).toHaveBeenCalledWith("/repo", "epic-2");
    expect(noteMock.mock.calls[0][2]).toContain("could NOT be rehomed");
  });

  it("releases the reservation the skipping run still holds on a preserved ticket", async () => {
    // The rerun path the note advertises only works if the ticket can be claimed again: a claim
    // that outlived its run hides it from `bd ready --unassigned` and refuses the claim cascade of
    // whoever approves the follow-up target.
    const reserved = claimed(bead("t2", "blocked", ["not-delivered"]), "op-1");

    await finalize(claimed(bead("epic-1"), "op-1"), [reserved]);

    expect(unassignMock).toHaveBeenCalledWith("/repo", "t2");
    expect(noteMock.mock.calls[0][2]).not.toContain("still assigned");
  });

  it("names the manual remedy when the reservation cannot be released", async () => {
    unassignMock.mockRejectedValue(new Error("bd assign: DB locked"));
    const reserved = claimed(bead("t2", "blocked", ["not-delivered"]), "op-1");

    await finalize(claimed(bead("epic-1"), "op-1"), [reserved]);

    // Finalization still completes; the note must not advertise a rerun the operator cannot start.
    expect(noteMock.mock.calls[0][2]).toContain("still assigned to op-1");
    expect(untagMock).toHaveBeenCalledWith("/repo", "epic-1", [
      "stage:in-review",
    ]);
  });

  it("leaves an unclaimed preserved ticket alone rather than writing to bd for nothing", async () => {
    await finalize(bead("epic-1"), [bead("t2", "blocked", ["not-delivered"])]);

    expect(unassignMock).not.toHaveBeenCalled();
  });

  it("leaves an assignee that is not the run's own intact (anton-67xj)", async () => {
    // A PR can sit in review for days. An operator who claimed this preserved ticket in that window
    // is doing live work — clearing their reservation would advertise it as claimable and invite a
    // duplicate run of the very ticket they hold.
    const takenOver = claimed(bead("t2", "blocked", ["not-delivered"]), "op-2");

    await finalize(claimed(bead("epic-1"), "op-1"), [takenOver]);

    expect(unassignMock).not.toHaveBeenCalled();
    const note = noteMock.mock.calls[0][2];
    expect(note).toContain("assigned to op-2");
    expect(note).toContain("not to the actor this run reserved it for");
  });

  it("keeps a takeover that landed after the sweep read the board", async () => {
    // The snapshot still names the run's own actor, so the actor test alone would clear it. The CAS
    // re-reads under the claim lock and loses to whoever holds it now.
    const reserved = claimed(bead("t2", "blocked", ["not-delivered"]), "op-1");
    assignees.set("t2", "op-2"); // takeover landed between the sweep's read and here

    await finalize(claimed(bead("epic-1"), "op-1"), [reserved]);

    expect(unassignMock).not.toHaveBeenCalled();
    expect(noteMock.mock.calls[0][2]).toContain("still assigned to op-1");
  });

  it("leaves every assignee alone when the run had no identity to reserve under", async () => {
    // No operator identity means execute-epic ran no claim cascade at all, so nothing here is this
    // run's to release — whoever owns the ticket owns it for some other reason.
    const owned = claimed(bead("t2", "blocked", ["not-delivered"]), "op-2");

    await finalize(bead("epic-1"), [owned]);

    expect(unassignMock).not.toHaveBeenCalled();
    expect(noteMock.mock.calls[0][2]).toContain("assigned to op-2");
  });

  it("reopens the ticket the timeout left blocked, so the follow-up target can claim it", async () => {
    // Rehoming alone advertises a rerun the operator cannot start: bd refuses to claim a `blocked`
    // bead, so approving the follow-up would park every attempt at execute-epic's claim gate.
    await finalize(bead("epic-1"), [bead("t2", "blocked", ["not-delivered"])]);

    expect(setStatusMock).toHaveBeenCalledWith("/repo", "t2", "open");
    expect(noteMock.mock.calls[0][2]).not.toContain("--status open");
  });

  it("leaves an already-open preserved ticket's status alone", async () => {
    // A dependent skipped behind the timeout never left `open` — it is claimable as it stands.
    await finalize(bead("epic-1"), [bead("t2", "open", ["not-delivered"])]);

    expect(setStatusMock).not.toHaveBeenCalled();
  });

  it("does not reopen a ticket another worker claimed after the sweep (anton-67xj)", async () => {
    // `bead.status` is the sweep's snapshot and a PR can sit in review for days. An operator who
    // picked this ticket up in that window is mid-run: writing `open` over their claim would
    // downgrade live work and advertise it for a second run.
    const preserved = bead("t2", "blocked", ["not-delivered"]);
    statuses.set("t2", "in_progress");
    assignees.set("t2", "op-2");

    await finalize(bead("epic-1"), [preserved]);

    expect(setStatusMock).not.toHaveBeenCalled();
    expect(noteMock.mock.calls[0][2]).toContain(
      "Its status is now `in_progress` under op-2",
    );
  });

  it("does not reopen a ticket that closed after the sweep read the board", async () => {
    // Someone finished this work by hand while the PR sat in review — reopening it would put
    // completed work back on the queue as claimable.
    const preserved = bead("t2", "blocked", ["not-delivered"]);
    statuses.set("t2", "closed");

    await finalize(bead("epic-1"), [preserved]);

    expect(setStatusMock).not.toHaveBeenCalled();
    const note = noteMock.mock.calls[0][2];
    expect(note).toContain("Its status is now `closed`");
    expect(note).not.toContain("--status open");
  });

  it("names the manual remedy when the ticket cannot be re-read", async () => {
    // No fresh read means no evidence the snapshot still holds, and the snapshot alone is not
    // enough to move a status — so the write is skipped and the operator gets the command.
    showMock.mockRejectedValue(new Error("bd show: DB locked"));

    await finalize(bead("epic-1"), [bead("t2", "blocked", ["not-delivered"])]);

    expect(setStatusMock).not.toHaveBeenCalled();
    expect(noteMock.mock.calls[0][2]).toContain("`bd update t2 --status open`");
  });

  it("names the manual remedy when the blocked status cannot be cleared", async () => {
    setStatusMock.mockRejectedValue(new Error("bd update: DB locked"));

    await finalize(bead("epic-1"), [bead("t2", "blocked", ["not-delivered"])]);

    expect(noteMock.mock.calls[0][2]).toContain("`bd update t2 --status open`");
    expect(untagMock).toHaveBeenCalledWith("/repo", "epic-1", [
      "stage:in-review",
    ]);
  });

  it("keeps a ticket stopped AFTER its commit off the rerun path", async () => {
    // A post-commit timeout (or post-commit failure) leaves the bead `blocked` but deliberately
    // WITHOUT `not-delivered`, because the commit it made is on the merged branch. Reopening and
    // rehoming it would advertise a rerun that redoes shipped work; it stays where it is, blocked,
    // on the manual-review path its own note already asks for.
    await finalize(bead("epic-1"), [bead("t1"), bead("t2", "blocked")]);

    expect(createMock).not.toHaveBeenCalled();
    expect(reparentMock).not.toHaveBeenCalled();
    expect(setStatusMock).not.toHaveBeenCalled();
    // Still not closed — the merge does not get to decide a ticket a human has to rule on.
    expect(batchMock.mock.calls[0][1]).toEqual([
      { op: "close", id: "t1" },
      { op: "close", id: "epic-1" },
    ]);
    const note = noteMock.mock.calls[0][2];
    expect(note).toContain("NOT queued for a rerun");
    expect(note).not.toContain("merged WITHOUT this ticket");
  });

  it("keeps a snoozed ticket off the rerun path (anton-67xj)", async () => {
    // An operator deferred this preserved ticket while the PR sat in review — a snooze is a human's
    // own decision about when the work happens. Rehoming and reopening it would erase that and put
    // the ticket straight back under a runnable target.
    await finalize(bead("epic-1"), [bead("t2", "deferred", ["not-delivered"])]);

    expect(createMock).not.toHaveBeenCalled();
    expect(reparentMock).not.toHaveBeenCalled();
    expect(setStatusMock).not.toHaveBeenCalled();
    // Still preserved, and the note tells the truth about why it is parked rather than claiming its
    // work is in the merged diff.
    expect(batchMock.mock.calls[0][1]).toEqual([{ op: "close", id: "epic-1" }]);
    const note = noteMock.mock.calls[0][2];
    expect(note).toContain("merged WITHOUT this ticket");
    expect(note).toContain("Its status is `deferred`");
    expect(note).toContain("did NOT queue it for a rerun");
  });

  it("leaves a ticket another operator reparented under their target (anton-67xj)", async () => {
    // `rerunnable` is the sweep's snapshot; the reparent is a write days later. Moving this ticket
    // into the follow-up would steal it out of a target that may already be running it — and that
    // run would then park on its own ticket-set drift check.
    const preserved = bead("t2", "blocked", ["not-delivered"]);
    parents.set("t2", "epic-9");

    await finalize(bead("epic-1"), [preserved]);

    expect(reparentMock).not.toHaveBeenCalled();
    // Nothing reached the follow-up, so the empty target it would have been is taken back off the board.
    expect(deleteMock).toHaveBeenCalledWith("/repo", "epic-2");
    // Its status is part of the state that other target runs it in — left alone too.
    expect(setStatusMock).not.toHaveBeenCalled();
    const note = noteMock.mock.calls[0][2];
    expect(note).toContain("Another operator moved it under epic-9");
    expect(note).not.toContain("--parent <new-epic>");
  });

  it("rehomes a ticket nested under a DELIVERED ticket (anton-67xj)", async () => {
    // bd nesting is arbitrary-depth, so a run owns descendants whose parent is another ticket. t2
    // shipped and closes with the merge; t3 hangs off it and did not. Judging belonging by the
    // direct parent read t3 as work another operator had moved, so it was left beneath a merged,
    // closed target with no run path left to reach it.
    await finalize(bead("epic-1"), [
      bead("t2"),
      under("t2", bead("t3", "blocked", ["not-delivered"])),
    ]);

    expect(batchMock.mock.calls[0][1]).toEqual([
      { op: "close", id: "t2" },
      { op: "close", id: "epic-1" },
    ]);
    expect(reparentMock.mock.calls).toEqual([["/repo", "t3", "epic-2"]]);
    expect(setStatusMock).toHaveBeenCalledWith("/repo", "t3", "open");
    expect(noteMock.mock.calls[0][2]).toContain("now lives under epic-2");
  });

  it("moves a nested ticket with its parent rather than flattening it (anton-67xj)", async () => {
    // Both are undelivered, so the whole sub-tree moves: only the ROOT is reparented and t3 rides
    // along on t2, which keeps the nesting its work was scoped in. It must still be reopened —
    // treating it as another operator's move skipped that, leaving a `blocked` ticket bd refuses
    // to claim under a follow-up nobody could run it from.
    await finalize(bead("epic-1"), [
      bead("t2", "blocked", ["not-delivered"]),
      under("t2", bead("t3", "blocked", ["not-delivered"])),
    ]);

    expect(reparentMock.mock.calls).toEqual([["/repo", "t2", "epic-2"]]);
    expect(setStatusMock.mock.calls).toEqual([
      ["/repo", "t2", "open"],
      ["/repo", "t3", "open"],
    ]);
    expect(noteMock.mock.calls[0][2]).toContain("now lives under epic-2");
    const nested = noteMock.mock.calls[1][2];
    expect(nested).toContain("stays nested under t2");
    expect(nested).toContain("moved onto epic-2");
    expect(nested).not.toContain("Another operator moved it");
  });

  it("gives a nested ticket its own home when its parent's reparent fails", async () => {
    // The ride-along is decided on what actually MOVED: a parent bd refused to move is still stuck
    // under the merged target, so following it would strand the descendant too.
    reparentMock.mockImplementation(async (_r: string, id: string) => {
      if (id === "t2") throw new Error("bd update: DB locked");
    });

    await finalize(bead("epic-1"), [
      bead("t2", "blocked", ["not-delivered"]),
      under("t2", bead("t3", "blocked", ["not-delivered"])),
    ]);

    expect(reparentMock.mock.calls).toEqual([
      ["/repo", "t2", "epic-2"],
      ["/repo", "t3", "epic-2"],
    ]);
    expect(noteMock.mock.calls[0][2]).toContain("could NOT be rehomed");
    expect(noteMock.mock.calls[1][2]).toContain("now lives under epic-2");
  });

  it("leaves a nested ticket another operator moved out of the subtree", async () => {
    // Ancestry, not "has a parent that isn't the epic": the fresh read puts t3 under a target
    // outside this run, which is still somebody else's work to own.
    const nestedTicket = under("t2", bead("t3", "blocked", ["not-delivered"]));
    parents.set("t3", "epic-9");

    await finalize(bead("epic-1"), [
      bead("t2", "blocked", ["not-delivered"]),
      nestedTicket,
    ]);

    expect(reparentMock.mock.calls).toEqual([["/repo", "t2", "epic-2"]]);
    expect(setStatusMock.mock.calls).toEqual([["/repo", "t2", "open"]]);
    expect(noteMock.mock.calls[1][2]).toContain(
      "Another operator moved it under epic-9",
    );
  });

  it("leaves an ancestor put when an excluded descendant rides on it (anton-67xj)", async () => {
    // A reparent is an edge on the ancestor alone: t3 keeps its own parent, so moving t2 would
    // carry op-2's live claim onto a target anton wrote — and contradict t3's own note, which says
    // anton left it under the merged target.
    const nestedTicket = under("t2", bead("t3", "blocked", ["not-delivered"]));
    statuses.set("t3", "in_progress");
    assignees.set("t3", "op-2");

    await finalize(bead("epic-1"), [
      bead("t2", "blocked", ["not-delivered"]),
      nestedTicket,
    ]);

    expect(reparentMock).not.toHaveBeenCalled();
    expect(deleteMock).toHaveBeenCalledWith("/repo", "epic-2");
    // Still handed back in a claimable state — the manual move the note asks for is all it needs.
    expect(setStatusMock.mock.calls).toEqual([["/repo", "t2", "open"]]);
    const note = noteMock.mock.calls[0][2];
    expect(note).toContain("t3 still hangs off it");
    expect(note).toContain("--parent <new-epic>");
    expect(note).not.toContain("now lives under");
  });

  it("leaves an ancestor put when a descendant a human deferred rides on it", async () => {
    // t3 never reaches pass 1 — the rerun allowlist drops a snooze before that. It still pins t2:
    // the deferral is a decision about when this work happens, not an invitation to requeue it.
    await finalize(bead("epic-1"), [
      bead("t2", "blocked", ["not-delivered"]),
      under("t2", bead("t3", "deferred", ["not-delivered"])),
    ]);

    expect(reparentMock).not.toHaveBeenCalled();
    expect(noteMock.mock.calls[0][2]).toContain("t3 still hangs off it");
    expect(noteMock.mock.calls[1][2]).toContain("did NOT queue it for a rerun");
  });

  it("still gives a takeable sibling its own home under a pinned ancestor", async () => {
    // Pinning t2 must not strand the rest of its subtree: t4 flattens onto the follow-up exactly as
    // it would when bd refuses its parent's reparent.
    await finalize(bead("epic-1"), [
      bead("t2", "blocked", ["not-delivered"]),
      under("t2", bead("t3", "deferred", ["not-delivered"])),
      under("t2", bead("t4", "blocked", ["not-delivered"])),
    ]);

    expect(reparentMock.mock.calls).toEqual([["/repo", "t4", "epic-2"]]);
    expect(noteMock.mock.calls[0][2]).toContain("t3 still hangs off it");
    expect(noteMock.mock.calls[2][2]).toContain("now lives under epic-2");
  });

  it("detaches a delivered descendant before moving its ancestor (anton-67xj)", async () => {
    // Only PRESERVED tickets pin — blocking on delivered work would strand t2 merely because part
    // of its subtree shipped. But t3 must not RIDE ALONG either: a squash-merge leaves no `t3:`
    // commit subject on the follow-up's fresh branch, so execute-epic would read the closed t3 as a
    // cross-machine resume and re-run work this merge already shipped. It goes back onto the merged
    // target, which is closed and terminal, and t2 moves without it.
    await finalize(bead("epic-1"), [
      bead("t2", "blocked", ["not-delivered"]),
      under("t2", bead("t3")),
    ]);

    expect(batchMock.mock.calls[0][1]).toEqual([
      { op: "close", id: "t3" },
      { op: "close", id: "epic-1" },
    ]);
    expect(reparentMock.mock.calls).toEqual([
      ["/repo", "t3", "epic-1"],
      ["/repo", "t2", "epic-2"],
    ]);
    expect(noteMock.mock.calls[0][2]).toContain("now lives under epic-2");
  });

  it("leaves a delivered descendant another operator moved off the ancestor alone", async () => {
    // The snapshot says t3 hangs off t2; the live board says it does not. Detaching it would
    // rewrite an edge that belongs to whoever moved it, and nothing rides onto the follow-up.
    const shipped = under("t2", bead("t3"));
    parents.set("t3", "epic-9");

    await finalize(bead("epic-1"), [
      bead("t2", "blocked", ["not-delivered"]),
      shipped,
    ]);

    expect(reparentMock.mock.calls).toEqual([["/repo", "t2", "epic-2"]]);
  });

  it("leaves the ancestor put when a delivered descendant cannot be detached", async () => {
    // The detach is what makes the move safe, so a bd refusal takes the move with it — moving t2
    // anyway would carry the shipped t3 onto a branch that has no commit for it.
    reparentMock.mockImplementation(async (_r: string, id: string) => {
      if (id === "t3") throw new Error("bd update: DB locked");
    });

    await finalize(bead("epic-1"), [
      bead("t2", "blocked", ["not-delivered"]),
      under("t2", bead("t3")),
    ]);

    expect(reparentMock.mock.calls).toEqual([["/repo", "t3", "epic-1"]]);
    expect(deleteMock).toHaveBeenCalledWith("/repo", "epic-2");
    // Still handed back claimable, with the manual remedy named — the pinned lane exactly.
    expect(setStatusMock.mock.calls).toEqual([["/repo", "t2", "open"]]);
    expect(noteMock.mock.calls[0][2]).toContain("t3 still hangs off it");
  });

  it("leaves a ticket whose ANCESTOR another operator reparented since the sweep (anton-67xj)", async () => {
    // Belonging is read off the live chain, not the snapshot: t2 shipped and another operator has
    // since moved it under their own target, taking t3 with it. Resolving t2 from the sweep's
    // snapshot answered "still on the merged target" and reparented t3 out of their run into this
    // follow-up.
    const shipped = bead("t2");
    parents.set("t2", "epic-9");

    await finalize(bead("epic-1"), [
      shipped,
      under("t2", bead("t3", "blocked", ["not-delivered"])),
    ]);

    expect(reparentMock).not.toHaveBeenCalled();
    expect(deleteMock).toHaveBeenCalledWith("/repo", "epic-2");
    expect(setStatusMock).not.toHaveBeenCalled();
    expect(noteMock.mock.calls[0][2]).toContain("Another operator moved it under t2");
  });

  it("moves nothing when an ancestor in the chain cannot be re-read", async () => {
    // An unreadable link proves neither that t3 still rides on the merged target nor that somebody
    // took it, so it moves nothing and its note claims neither.
    showMock.mockImplementation(async (_repo: string, id: string) => {
      if (id === "t2") throw new Error("bd show: DB locked");
      return {
        id,
        title: id,
        status: statuses.get(id) ?? "open",
        labels: boardLabels.get(id) ?? [],
        assignee: assignees.get(id),
        parent: parents.get(id),
      } as Bead;
    });

    await finalize(bead("epic-1"), [
      bead("t2"),
      under("t2", bead("t3", "blocked", ["not-delivered"])),
    ]);

    expect(reparentMock).not.toHaveBeenCalled();
    expect(deleteMock).toHaveBeenCalledWith("/repo", "epic-2");
    const note = noteMock.mock.calls[0][2];
    expect(note).toContain("could NOT be rehomed");
    expect(note).not.toContain("Another operator moved it");
  });

  it("reruns a marker-bearing ticket the timeout left in_progress (anton-67xj)", async () => {
    // The timeout writes `blocked` best-effort but RETRIES the `not-delivered` marker, so a bd
    // hiccup can leave a rolled-back ticket sitting on the claim it was dispatched under. Nothing
    // of it is in the merged diff, so stranding it on the manual-review path over that bookkeeping
    // failure would lose the work the marker exists to protect.
    const stalled = claimed(
      bead("t2", "in_progress", ["not-delivered"]),
      "op-1",
    );

    await finalize(claimed(bead("epic-1"), "op-1"), [stalled]);

    expect(reparentMock.mock.calls).toEqual([["/repo", "t2", "epic-2"]]);
    expect(setStatusMock).toHaveBeenCalledWith("/repo", "t2", "open");
    expect(noteMock.mock.calls[0][2]).toContain("now lives under epic-2");
  });

  it("keeps a marker-bearing in_progress ticket held by another operator off the rerun path", async () => {
    // Same shape, different owner: this claim is somebody's live run, not the dead run's leftover.
    const held = claimed(bead("t2", "in_progress", ["not-delivered"]), "op-2");

    await finalize(claimed(bead("epic-1"), "op-1"), [held]);

    expect(reparentMock).not.toHaveBeenCalled();
    expect(setStatusMock).not.toHaveBeenCalled();
    expect(noteMock.mock.calls[0][2]).toContain("did NOT queue it for a rerun");
  });

  it("does not reparent a ticket claimed after the sweep computed the rerun lane (anton-67xj)", async () => {
    // `rerunnable` is the snapshot; the reparent lands days later. Moving a ticket someone has since
    // picked up hands a second run their work.
    const preserved = bead("t2", "blocked", ["not-delivered"]);
    statuses.set("t2", "in_progress");
    assignees.set("t2", "op-2");

    await finalize(bead("epic-1"), [preserved]);

    expect(reparentMock).not.toHaveBeenCalled();
    expect(deleteMock).toHaveBeenCalledWith("/repo", "epic-2");
    expect(setStatusMock).not.toHaveBeenCalled();
    const note = noteMock.mock.calls[0][2];
    expect(note).toContain("Its status is now `in_progress` under op-2");
    expect(note).not.toContain("now lives under");
  });

  it("does not reparent a ticket closed after the sweep computed the rerun lane", async () => {
    // A closed ticket under a follow-up branch that carries no commit for it is exactly what
    // execute-epic reads as a cross-machine resume — it would run the finished work again.
    const preserved = bead("t2", "blocked", ["not-delivered"]);
    statuses.set("t2", "closed");

    await finalize(bead("epic-1"), [preserved]);

    expect(reparentMock).not.toHaveBeenCalled();
    expect(noteMock.mock.calls[0][2]).toContain("Its status is now `closed`");
  });

  it("does not reparent a ticket whose claim changed hands after the sweep", async () => {
    // The status still reads rerunnable, but the reservation is another operator's now.
    const reserved = claimed(bead("t2", "blocked", ["not-delivered"]), "op-1");
    assignees.set("t2", "op-2");

    await finalize(claimed(bead("epic-1"), "op-1"), [reserved]);

    expect(reparentMock).not.toHaveBeenCalled();
    expect(noteMock.mock.calls[0][2]).toContain(
      "Its status is now `blocked` under op-2",
    );
  });

  it("does not reparent a ticket another operator held before the sweep (anton-67xj)", async () => {
    // The rerun allowlist weighs the assignee only on the in_progress lane, so a `blocked` ticket
    // reserved by someone else reads as rerunnable — and as no takeover either, since the snapshot
    // carries the same owner. Moving it advertises work op-2 holds under a second target.
    const held = claimed(bead("t2", "blocked", ["not-delivered"]), "op-2");

    await finalize(claimed(bead("epic-1"), "op-1"), [held]);

    expect(reparentMock).not.toHaveBeenCalled();
    expect(deleteMock).toHaveBeenCalledWith("/repo", "epic-2");
    expect(setStatusMock).not.toHaveBeenCalled();
    expect(unassignMock).not.toHaveBeenCalled();
    const note = noteMock.mock.calls[0][2];
    expect(note).toContain("Its status is now `blocked` under op-2");
    expect(note).not.toContain("now lives under");
    expect(note).toContain("assigned to op-2");
  });

  it("does not reparent a ticket held by anyone when the run had no identity", async () => {
    // No runOwner means nothing anton reserved, so any assignee at all is somebody else's.
    const held = claimed(bead("t2", "blocked", ["not-delivered"]), "op-2");

    await finalize(bead("epic-1"), [held]);

    expect(reparentMock).not.toHaveBeenCalled();
    expect(noteMock.mock.calls[0][2]).toContain(
      "Its status is now `blocked` under op-2",
    );
  });

  it("still rehomes the tickets skipped behind a post-commit timeout", async () => {
    // Only the timed-out ticket's own work is in the diff. t3 was never dispatched, so it carries
    // no marker and no commit — the lane split must keep it runnable rather than strand it too.
    await finalize(bead("epic-1"), [
      bead("t2", "blocked"),
      waitsOn("t3", "t2"),
    ]);

    expect(reparentMock.mock.calls).toEqual([["/repo", "t3", "epic-2"]]);
    expect(noteMock.mock.calls[1][2]).toContain("now lives under epic-2");
  });

  it("releases a stale claim on a ticket held for manual review", async () => {
    // Nobody is running it, so a dead run's claim only misreports who owns the review it waits for.
    const reserved = claimed(bead("t2", "blocked"), "op-1");

    await finalize(claimed(bead("epic-1"), "op-1"), [reserved]);

    expect(unassignMock).toHaveBeenCalledWith("/repo", "t2");
    expect(noteMock.mock.calls[0][2]).not.toContain("still assigned");
  });

  it("closes a leaf target marked not-delivered rather than preserving itself", async () => {
    // A leaf run target is its own ticket, so it appears on both sides. Excluding it from the close
    // would leave `stage:in-review` on forever and re-select it on every sweep.
    const leaf = bead("epic-1", "open", ["not-delivered"]);

    await finalize(leaf, [leaf]);

    expect(batchMock.mock.calls[0][1]).toEqual([{ op: "close", id: "epic-1" }]);
    expect(createMock).not.toHaveBeenCalled();
    expect(untagMock).toHaveBeenCalledWith("/repo", "epic-1", [
      "stage:in-review",
    ]);
  });

  it("closes the target only after the preserved tickets are rehomed (PR #199)", async () => {
    await finalize(bead("epic-1"), [
      bead("t1"),
      bead("t2", "blocked", [LABELS.notDelivered]),
    ]);

    // The close is what ends this epic: inReviewEpics drops a CLOSED run target whatever labels it
    // carries, so a stop between the close and the rehome would strand t2 under a merged target
    // anton cannot run, with nothing left on the board to re-select and retry.
    const closedAt = batchMock.mock.invocationCallOrder[0];
    expect(reparentMock.mock.invocationCallOrder[0]).toBeLessThan(closedAt);
    expect(noteMock.mock.invocationCallOrder[0]).toBeLessThan(closedAt);
    expect(untagMock.mock.invocationCallOrder[0]).toBeGreaterThan(closedAt);
  });

  it("leaves the target open and in review when finalization fails before the close", async () => {
    findOpenRunMock.mockRejectedValue(new Error("db: connection lost"));

    await expect(
      finalize(bead("epic-1"), [
        bead("t1"),
        bead("t2", "blocked", [LABELS.notDelivered]),
      ]),
    ).rejects.toThrow("connection lost");

    // Nothing closed and the label survives, so the next sweep re-selects this epic and finalizes
    // again from the top — the rehomed t2 has left the subtree, so it is not rehomed twice.
    expect(batchMock).not.toHaveBeenCalled();
    expect(untagMock).not.toHaveBeenCalled();
    expect(reparentMock).toHaveBeenCalledWith("/repo", "t2", "epic-2");
  });

  it("keeps stage:in-review when the transaction fails, so the next sweep retries", async () => {
    batchMock.mockRejectedValue(new Error("bd batch: rolled back"));

    await finalize(bead("epic-1"), [bead("t1")]);

    // Nothing closed (bd rolled the batch back) and the epic is still in review — the two halves
    // of "retryable" that a half-closed unit would have destroyed.
    expect(untagMock).not.toHaveBeenCalled();
  });

  it("leaves a blocked child open and still closes the target and the plain open one", async () => {
    // The shape anton-67xj.1 exists for: t1 ran out of its budget and was rolled back, so its work
    // is on no branch. The merge must not close it — its note tells a human to re-scope and run it.
    await finalize(bead("epic-1"), [bead("t1", "blocked"), bead("t2")]);

    expect(batchMock.mock.calls[0][1]).toEqual([
      { op: "close", id: "t2" },
      { op: "close", id: "epic-1" },
    ]);
    expect(untagMock).toHaveBeenCalledWith("/repo", "epic-1", [
      "stage:in-review",
    ]);
  });

  it("leaves a ticket skipped behind a blocked one open too", async () => {
    // t2 was never dispatched (anton-67xj) — it stays `open` for the board, so only the `blocks`
    // edge to the rolled-back t1 tells the merge it delivered nothing.
    await finalize(bead("epic-1"), [
      bead("t1", "blocked"),
      waitsOn("t2", "t1"),
      bead("t3"),
    ]);

    expect(batchMock.mock.calls[0][1]).toEqual([
      { op: "close", id: "t3" },
      { op: "close", id: "epic-1" },
    ]);
  });

  it("leaves a ticket stranded behind an abandoned dependency open", async () => {
    // t2 was abandoned by hand — closed, but with no commit behind it — so t3 was never dispatched
    // and must not be retired by the merge.
    await finalize(bead("epic-1"), [
      bead("t1", "blocked"),
      { ...waitsOn("t2", "t1", "closed"), labels: [LABELS.abandoned] } as Bead,
      waitsOn("t3", "t2"),
    ]);

    expect(batchMock.mock.calls[0][1]).toEqual([{ op: "close", id: "epic-1" }]);
  });

  it("closes a delivered dependent whose close write failed, repairing it", async () => {
    // t1 timed out AFTER committing, so the run carried on and t2 ran and committed too — but t2's
    // best-effort `beads.close` failed, leaving it claimed and `in_progress`. The merge is what
    // repairs that, so t2 (and t3 behind it) must close rather than be read as never-dispatched.
    await finalize(bead("epic-1"), [
      bead("t1", "blocked"),
      waitsOn("t2", "t1", "in_progress"),
      waitsOn("t3", "t2"),
    ]);

    expect(batchMock.mock.calls[0][1]).toEqual([
      { op: "close", id: "t2" },
      { op: "close", id: "t3" },
      { op: "close", id: "epic-1" },
    ]);
  });
});

describe("undeliveredAtMerge", () => {
  it("holds back the blocked child and everything transitively behind it", () => {
    const children = [
      bead("t1", "blocked"),
      waitsOn("t2", "t1"),
      waitsOn("t3", "t2"), // transitive: t3 waits on a ticket that itself never ran
      bead("t4"),
    ];

    expect(undeliveredAtMerge(children)).toEqual(new Set(["t1", "t2", "t3"]));
  });

  it("stops at a closed dependent — its commit is on the branch whatever its blocker did", () => {
    // t2 committed before t1's budget ran out, so t3 has the mechanism it was written against.
    const children = [
      bead("t1", "blocked"),
      waitsOn("t2", "t1", "closed"),
      waitsOn("t3", "t2"),
    ];

    expect(undeliveredAtMerge(children)).toEqual(new Set(["t1"]));
  });

  it("stops at an in_progress dependent — it committed, only its close write failed", () => {
    // A blocker that timed out after its commit doesn't stop the run, so t2 was dispatched and
    // committed; `beads.close` is best-effort, so a transient bd failure is all that stands between
    // it and `closed`. Neither it nor t3 behind it is undelivered work.
    const children = [
      bead("t1", "blocked"),
      waitsOn("t2", "t1", "in_progress"),
      waitsOn("t3", "t2"),
    ];

    expect(undeliveredAtMerge(children)).toEqual(new Set(["t1"]));
  });

  it("walks through an abandoned dependent — it is closed on a won't-do, not on a commit", () => {
    // `abandoned` is the one closed status that carries no delivery: execute-epic drops such a
    // ticket from `live` for exactly this reason, so t3 behind it never ran either.
    const abandoned = {
      ...waitsOn("t2", "t1", "closed"),
      labels: [LABELS.abandoned],
    } as Bead;
    const children = [bead("t1", "blocked"), abandoned, waitsOn("t3", "t2")];

    expect(undeliveredAtMerge(children)).toEqual(new Set(["t1", "t2", "t3"]));
  });

  it("ignores non-blocks edges and edges leaving the run", () => {
    const parented = {
      ...bead("t2"),
      dependencies: [
        { issue_id: "t2", depends_on_id: "t1", type: "parent-child" },
      ],
    } as Bead;
    const outside = waitsOn("t3", "other-epic-ticket");

    expect(
      undeliveredAtMerge([bead("t1", "blocked"), parented, outside]),
    ).toEqual(new Set(["t1"]));
  });

  it("holds back a ticket the run marked not-delivered, and everything behind it", () => {
    // A skipped ticket keeps the `open` status the board offers it under, so the label is the only
    // thing that distinguishes it from an ordinary open child — and what waits on it never ran
    // either.
    const children = [
      bead("t1", "open", [LABELS.notDelivered]),
      waitsOn("t2", "t1"),
      bead("t3"),
    ];

    expect(undeliveredAtMerge(children)).toEqual(new Set(["t1", "t2"]));
  });

  it("walks through a dependent that is closed but marked not-delivered", () => {
    // Closed on another machine, its commit on no branch here: the run reopens it, but a bd
    // failure can leave it closed — the marker still says its work is in no diff, so t3 behind it
    // is undelivered too.
    const marked = {
      ...waitsOn("t2", "t1", "closed"),
      labels: [LABELS.notDelivered],
    } as Bead;

    expect(
      undeliveredAtMerge([bead("t1", "blocked"), marked, waitsOn("t3", "t2")]),
    ).toEqual(new Set(["t1", "t2", "t3"]));
  });

  it("holds nothing back when every child delivered", () => {
    expect(undeliveredAtMerge([bead("t1"), waitsOn("t2", "t1")])).toEqual(
      new Set(),
    );
  });

  it("terminates on a dependency cycle", () => {
    const children = [
      bead("t1", "blocked"),
      waitsOn("t2", "t1"),
      waitsOn("t1b", "t2"),
    ];
    children[0] = {
      ...children[0],
      dependencies: [{ issue_id: "t1", depends_on_id: "t1b", type: "blocks" }],
    } as Bead;

    expect(undeliveredAtMerge(children)).toEqual(new Set(["t1", "t2", "t1b"]));
  });
});
