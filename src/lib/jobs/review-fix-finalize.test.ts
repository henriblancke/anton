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
import { withBeadWriteLock } from "../beads/claim-lock";
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
/** The board read the rehome takes when the sweep's snapshot names no follow-up candidate. */
const listMock = vi.fn();
/** id → current assignee, so the claim guard's CAS (show → unassign → show) reads a live board. */
const assignees = new Map<string, string>();
/** id → current status, so the re-read before a status write sees the board, not the snapshot. */
const statuses = new Map<string, string>();
/** id → current parent, so the re-read before a reparent sees the board, not the snapshot. */
const parents = new Map<string, string | undefined>();
/** id → current labels, so a re-read still carries the `not-delivered` marker the lane turns on. */
const boardLabels = new Map<string, string[]>();
/** id → creation time, which is how two racing processes agree on which follow-up survives. */
const createdAt = new Map<string, string>();

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
      list: (...args: unknown[]) => listMock(...args),
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

/** The note anton left on `id` — the finalization writes one per preserved ticket. */
const noteFor = (id: string): string =>
  noteMock.mock.calls.find((c: unknown[]) => c[1] === id)?.[2] as string;

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
    createdAt.clear();
    unassignMock
      .mockReset()
      .mockImplementation(async (_repo: string, id: string) => {
        assignees.delete(id);
      });
    setStatusMock.mockReset().mockResolvedValue(undefined);
    listMock.mockReset().mockResolvedValue([]);
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
          created_at: createdAt.get(id),
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

  it("holds the close back when the follow-up cannot be created (PR #199)", async () => {
    createMock.mockRejectedValue(new Error("bd create: DB locked"));

    await finalize(bead("epic-1"), [bead("t2", "blocked", ["not-delivered"])]);

    // The note must not claim a home the ticket never reached…
    expect(noteMock.mock.calls[0][2]).toContain("could NOT be rehomed");
    // …and the close must not land on top of it: a closed run target is invisible to the next
    // sweep, so a swallowed create failure would leave t2 parented to a merged target with nothing
    // on the board left to retry the create. Open and `stage:in-review`, the next sweep does.
    expect(batchMock).not.toHaveBeenCalled();
    expect(untagMock).not.toHaveBeenCalled();
  });

  it("deletes the follow-up target again when no ticket reaches it", async () => {
    reparentMock.mockRejectedValue(new Error("bd update: DB locked"));

    await finalize(bead("epic-1"), [bead("t2", "blocked", ["not-delivered"])]);

    // A childless epic is a poison run, not a home — leaving one behind trades an unreachable
    // ticket for an unrunnable target.
    expect(deleteMock).toHaveBeenCalledWith("/repo", "epic-2");
    expect(batchMock).toHaveBeenCalledTimes(1); // cleanup landed — finalization completes
    expect(noteMock.mock.calls[0][2]).toContain("could NOT be rehomed");
  });

  it("does not force-delete a childless follow-up somebody has since taken (PR #199 review)", async () => {
    // `beads.delete` is an irreversible `bd delete --force`, and the follow-up's own description
    // asks to be approved: a human doing exactly that — or a worker claiming it — between the
    // create and this cleanup turns it into somebody's run, and every earlier `untouched` read is
    // older than the writes in between. Deleting on those would destroy a target already in flight.
    reparentMock.mockImplementation(async () => {
      boardLabels.set("epic-2", ["approved"]); // approved while this pass was moving tickets
      throw new Error("bd update: DB locked");
    });

    await finalize(bead("epic-1"), [bead("t2", "blocked", ["not-delivered"])]);

    expect(deleteMock).not.toHaveBeenCalled();
    // It is somebody's run now and nothing reached it, so finalization is left undone: the merged
    // source stays open and `stage:in-review` for the next sweep to settle.
    expect(batchMock).not.toHaveBeenCalled();
    expect(untagMock).not.toHaveBeenCalled();
  });

  it("keeps the merged target open when the childless follow-up cannot be deleted (PR #199)", async () => {
    reparentMock.mockRejectedValue(new Error("bd update: DB locked"));
    deleteMock.mockRejectedValue(new Error("bd delete: DB locked"));

    await finalize(bead("epic-1"), [bead("t2", "blocked", ["not-delivered"])]);

    // Closing the target is what makes it undiscoverable, so a cleanup that did not land must not
    // be followed by one: the childless follow-up would sit there for good, asking to be approved
    // into a run with nothing in it. Left open and `stage:in-review`, the next sweep retries.
    expect(deleteMock).toHaveBeenCalledWith("/repo", "epic-2");
    expect(batchMock).not.toHaveBeenCalled();
    expect(untagMock).not.toHaveBeenCalled();
  });

  it("does not delete a childless follow-up another operator filled mid-pass (PR #199 review)", async () => {
    // The follow-up's own description asks to be approved, and this pass has been writing to a
    // shared board since it was created: a ticket parented to it in that window is on no snapshot
    // anton holds, because the epic did not exist when the board was read. `bd delete --force` does
    // not cascade, so deleting it would leave that ticket parentless.
    const boardNow: Bead[] = [];
    listMock.mockImplementation(async () => [...boardNow]);
    reparentMock.mockImplementation(async () => {
      boardNow.push({ ...bead("t9"), parent: "epic-2" } as Bead);
      throw new Error("bd update: DB locked");
    });

    await finalize(bead("epic-1"), [bead("t2", "blocked", ["not-delivered"])]);

    expect(deleteMock).not.toHaveBeenCalled();
    // It is a real home now, not the childless poison run the cleanup exists for, so nothing is
    // left undone: the merged source closes.
    expect(batchMock).toHaveBeenCalledTimes(1);
  });

  it("keeps the merged target open when childlessness cannot be re-read (PR #199 review)", async () => {
    reparentMock.mockRejectedValue(new Error("bd update: DB locked"));
    let reads = 0;
    listMock.mockImplementation(async () => {
      reads += 1;
      if (reads > 2) throw new Error("bd list: DB locked"); // the read the delete is decided on
      return [];
    });

    await finalize(bead("epic-1"), [bead("t2", "blocked", ["not-delivered"])]);

    // A board anton cannot read is not evidence the follow-up is empty, and the delete is the
    // irreversible half: it stands, and the source stays open and `stage:in-review` to retry.
    expect(deleteMock).not.toHaveBeenCalled();
    expect(batchMock).not.toHaveBeenCalled();
    expect(untagMock).not.toHaveBeenCalled();
  });

  it("reuses the follow-up an interrupted sweep already created (PR #199)", async () => {
    // `beads.create` is a persistent write, and the sweep that made this one stopped before it
    // could move anything onto it. The target is still open, so finalization re-runs from the top —
    // creating a second follow-up here would leave the first childless on the board forever.
    const leftover = {
      ...bead("epic-7"),
      issue_type: "epic",
      metadata: { rehomeOf: "epic-1" },
    } as Bead;

    await finalize(
      bead("epic-1"),
      [bead("t2", "blocked", ["not-delivered"])],
      [leftover],
    );

    expect(createMock).not.toHaveBeenCalled();
    expect(reparentMock).toHaveBeenCalledWith("/repo", "t2", "epic-7");
    expect(noteMock.mock.calls[0][2]).toContain("now lives under epic-7");
  });

  it("stamps the follow-up with the target it was created for", async () => {
    await finalize(bead("epic-1"), [bead("t2", "blocked", ["not-delivered"])]);

    // Written in the create itself: a stamp that arrives in a second write leaves a window in
    // which a retry cannot recognize its own follow-up.
    expect(createMock.mock.calls[0][1].metadata).toEqual({
      rehomeOf: "epic-1",
    });
  });

  it("creates a fresh follow-up when the leftover one is already a run of its own", async () => {
    // A human approved it, so it is somebody's target now — adding tickets to a live run's set is
    // the drift that parks it.
    const approved = {
      ...bead("epic-7", "open", ["approved"]),
      issue_type: "epic",
      metadata: { rehomeOf: "epic-1" },
    } as Bead;

    await finalize(
      bead("epic-1"),
      [bead("t2", "blocked", ["not-delivered"])],
      [approved],
    );

    expect(createMock).toHaveBeenCalledTimes(1);
    expect(reparentMock).toHaveBeenCalledWith("/repo", "t2", "epic-2");
  });

  it("creates a fresh follow-up when the leftover one is no longer open (PR #199 review)", async () => {
    // A human deferred it — the lane's "not now". The picker skips every non-open target and the
    // claim gate refuses one, so filling this epic and closing the merged source would park the
    // remaining tickets somewhere no approval can start.
    const deferred = {
      ...bead("epic-7", "deferred"),
      issue_type: "epic",
      metadata: { rehomeOf: "epic-1" },
    } as Bead;

    await finalize(
      bead("epic-1"),
      [bead("t2", "blocked", ["not-delivered"])],
      [deferred],
    );

    expect(createMock).toHaveBeenCalledTimes(1);
    expect(reparentMock).toHaveBeenCalledWith("/repo", "t2", "epic-2");
  });

  it("does not reuse a leftover follow-up claimed since the sweep (PR #199)", async () => {
    // The snapshot only nominates it. A PR sits in review for days, and an operator who claimed
    // this epic in that window is running it — adding tickets to a live run's ticket set is the
    // drift that parks it.
    const leftover = {
      ...bead("epic-7"),
      issue_type: "epic",
      metadata: { rehomeOf: "epic-1" },
    } as Bead;
    assignees.set("epic-7", "op-9");

    await finalize(
      bead("epic-1"),
      [bead("t2", "blocked", ["not-delivered"])],
      [leftover],
    );

    expect(createMock).toHaveBeenCalledTimes(1);
    expect(reparentMock).toHaveBeenCalledWith("/repo", "t2", "epic-2");
  });

  it("holds the close back when the leftover follow-up cannot be re-read (PR #199)", async () => {
    // An unreadable candidate proves neither that it is still reusable nor that it is somebody's
    // run now. Creating a second follow-up on that silence would strand this one on the board, so
    // finalization stops short of the close and the next sweep retries the whole rehome.
    const leftover = {
      ...bead("epic-7"),
      issue_type: "epic",
      metadata: { rehomeOf: "epic-1" },
    } as Bead;
    showMock.mockImplementation(async (_repo: string, id: string) => {
      if (id === "epic-7") throw new Error("bd show: DB locked");
      return {
        id,
        title: id,
        status: statuses.get(id) ?? "open",
        labels: boardLabels.get(id) ?? [],
        assignee: assignees.get(id),
        parent: parents.get(id),
      } as Bead;
    });

    await finalize(
      bead("epic-1"),
      [bead("t2", "blocked", ["not-delivered"])],
      [leftover],
    );

    expect(createMock).not.toHaveBeenCalled();
    expect(reparentMock).not.toHaveBeenCalled();
    expect(batchMock).not.toHaveBeenCalled();
    expect(untagMock).not.toHaveBeenCalled();
  });

  it("keeps a reused follow-up that already carries an earlier sweep's tickets", async () => {
    // Nothing reached it THIS time, but the sweep that made it moved t9 onto it — deleting the
    // childless-target way would take that ticket's only home with it.
    reparentMock.mockRejectedValue(new Error("bd update: DB locked"));
    const leftover = {
      ...bead("epic-7"),
      issue_type: "epic",
      metadata: { rehomeOf: "epic-1" },
    } as Bead;
    const carried = { ...bead("t9"), parent: "epic-7" } as Bead;

    await finalize(
      bead("epic-1"),
      [bead("t2", "blocked", ["not-delivered"])],
      [leftover, carried],
    );

    expect(deleteMock).not.toHaveBeenCalled();
    expect(noteMock.mock.calls[0][2]).toContain("could NOT be rehomed");
  });

  it("deletes a reused follow-up that is still childless", async () => {
    reparentMock.mockRejectedValue(new Error("bd update: DB locked"));
    const leftover = {
      ...bead("epic-7"),
      issue_type: "epic",
      metadata: { rehomeOf: "epic-1" },
    } as Bead;

    await finalize(
      bead("epic-1"),
      [bead("t2", "blocked", ["not-delivered"])],
      [leftover],
    );

    expect(deleteMock).toHaveBeenCalledWith("/repo", "epic-7");
  });

  it("stops moving onto a reused follow-up approved mid-pass (PR #199)", async () => {
    // Reuse is decided once, at the top of the pass; the moves are bd round trips after it. A human
    // who approves the leftover epic in that window has made it a run of its own, and every further
    // ticket added to it is the ticket-set drift that parks that run.
    const leftover = {
      ...bead("epic-7"),
      issue_type: "epic",
      metadata: { rehomeOf: "epic-1" },
    } as Bead;
    reparentMock.mockImplementation(async (_repo: string, id: string) => {
      if (id === "m1") boardLabels.set("epic-7", ["approved"]);
    });

    await finalize(
      bead("epic-1"),
      [
        bead("m1", "blocked", ["not-delivered"]),
        bead("m2", "blocked", ["not-delivered"]),
      ],
      [leftover],
    );

    expect(reparentMock.mock.calls).toEqual([["/repo", "m1", "epic-7"]]);
    expect(deleteMock).not.toHaveBeenCalled(); // it is somebody's run now, not anton's to remove
    // Finalization is left undone, so the merged target stays open and `stage:in-review` for the
    // next sweep — which finds the candidate no longer untouched and makes a fresh follow-up.
    expect(batchMock).not.toHaveBeenCalled();
    expect(untagMock).not.toHaveBeenCalled();
  });

  it("reuses a follow-up the sweep's snapshot could not have seen (PR #199)", async () => {
    // `enqueueReviewFixIfAbsent` lets the project-wide sweep and a gate-check's targeted fix both
    // reach one merged target, and whichever finalizes second read the board before the first
    // created its follow-up. Nominating off that snapshot alone would create a SECOND target and
    // split the preserved tickets across the two.
    const concurrent = {
      ...bead("epic-7"),
      issue_type: "epic",
      metadata: { rehomeOf: "epic-1" },
    } as Bead;
    listMock.mockResolvedValue([concurrent]);

    await finalize(bead("epic-1"), [bead("t2", "blocked", ["not-delivered"])]);

    expect(createMock).not.toHaveBeenCalled();
    expect(reparentMock).toHaveBeenCalledWith("/repo", "t2", "epic-7");
  });

  it("holds the close back when the board cannot be re-read for a follow-up (PR #199)", async () => {
    // A list that fails says neither that a concurrent finalization made a follow-up nor that none
    // exists — and creating one on that silence is exactly how the tickets end up split. The merged
    // target stays open and `stage:in-review` so the next sweep retries the whole rehome.
    listMock.mockRejectedValue(new Error("bd list: DB locked"));

    await finalize(bead("epic-1"), [bead("t2", "blocked", ["not-delivered"])]);

    expect(createMock).not.toHaveBeenCalled();
    expect(reparentMock).not.toHaveBeenCalled();
    expect(batchMock).not.toHaveBeenCalled();
    expect(untagMock).not.toHaveBeenCalled();
  });

  it("stops moving onto a FRESH follow-up taken mid-pass (PR #199 review)", async () => {
    // Seconds old makes it no less reachable: the epic anton just created sits on a board humans
    // watch, and its own description asks to be approved. Once it is, it is a run of its own, and
    // every further ticket added to it is the ticket-set drift that parks that run — the same
    // reason a reused leftover is re-read, so the guard cannot depend on who created the home.
    reparentMock.mockImplementation(async (_repo: string, id: string) => {
      if (id === "m1") boardLabels.set("epic-2", ["approved"]);
    });

    await finalize(bead("epic-1"), [
      bead("m1", "blocked", ["not-delivered"]),
      bead("m2", "blocked", ["not-delivered"]),
    ]);

    expect(reparentMock.mock.calls).toEqual([["/repo", "m1", "epic-2"]]);
    expect(deleteMock).not.toHaveBeenCalled(); // it is somebody's run now, not anton's to remove
    // Finalization is left undone, so the merged target stays open for the next sweep.
    expect(batchMock).not.toHaveBeenCalled();
    expect(untagMock).not.toHaveBeenCalled();
  });

  it("defers to the older follow-up when another PROCESS created one too (PR #199 review)", async () => {
    // `finalizeLockKey` orders finalizations inside one process; two anton servers sharing a board
    // both read a stamp-free board and both create, and bd has no board-level uniqueness to key the
    // create on. So the create is verified after the fact: read the stamp back, and let the oldest
    // follow-up win — a rule both processes reach, so the preserved tickets stay under ONE target.
    const rival = {
      ...bead("epic-7"),
      issue_type: "epic",
      metadata: { rehomeOf: "epic-1" },
      created_at: "2026-01-01T00:00:00.000Z",
    } as Bead;
    createdAt.set("epic-2", "2026-01-01T00:00:05.000Z");
    listMock.mockResolvedValueOnce([]).mockResolvedValue([rival]);

    await finalize(bead("epic-1"), [bead("t2", "blocked", ["not-delivered"])]);

    expect(createMock).toHaveBeenCalledTimes(1);
    expect(deleteMock).toHaveBeenCalledWith("/repo", "epic-2"); // the duplicate, before anything lands on it
    expect(reparentMock).toHaveBeenCalledWith("/repo", "t2", "epic-7");
    expect(untagMock).toHaveBeenCalledWith("/repo", "epic-1", [
      "stage:in-review",
    ]);
  });

  it("ignores an older stamped follow-up somebody already TOOK (PR #199 review)", async () => {
    // A stamped epic a human approved is a run of its own — it failed the reuse test above for
    // exactly that reason. Counting it as a rival would elect it the older winner, delete the home
    // just created, then reject that winner as non-untouched: the remaining tickets would be
    // rehomed by no sweep, and every later pass would repeat the same create-and-delete.
    const taken = {
      ...bead("epic-7", "open", ["approved"]),
      issue_type: "epic",
      metadata: { rehomeOf: "epic-1" },
      created_at: "2026-01-01T00:00:00.000Z",
    } as Bead;
    createdAt.set("epic-2", "2026-01-01T00:00:05.000Z");
    listMock.mockResolvedValueOnce([]).mockResolvedValue([taken]);

    await finalize(bead("epic-1"), [bead("t2", "blocked", ["not-delivered"])]);

    expect(createMock).toHaveBeenCalledTimes(1);
    expect(deleteMock).not.toHaveBeenCalled(); // the fresh follow-up is the only home going spare
    expect(reparentMock).toHaveBeenCalledWith("/repo", "t2", "epic-2");
    expect(untagMock).toHaveBeenCalledWith("/repo", "epic-1", [
      "stage:in-review",
    ]);
  });

  it("keeps its own follow-up when the rival's is the younger one (PR #199 review)", async () => {
    // The other half of the same rule. A process that cannot see its rival's create is necessarily
    // the older one, so keeping its own is the verdict the rival reaches when it sees both.
    const rival = {
      ...bead("epic-7"),
      issue_type: "epic",
      metadata: { rehomeOf: "epic-1" },
      created_at: "2026-01-01T00:00:05.000Z",
    } as Bead;
    createdAt.set("epic-2", "2026-01-01T00:00:00.000Z");
    listMock.mockResolvedValueOnce([]).mockResolvedValue([rival]);

    await finalize(bead("epic-1"), [bead("t2", "blocked", ["not-delivered"])]);

    expect(deleteMock).not.toHaveBeenCalledWith("/repo", "epic-2");
    expect(reparentMock).toHaveBeenCalledWith("/repo", "t2", "epic-2");
  });

  it("leaves its OWN losing follow-up standing once somebody takes it (PR #199 review)", async () => {
    // The window between electing the winner and deleting the loser is the same one the losing
    // rivals above are guarded against: a human can approve this epic, or a worker claim it, and
    // `bd delete --force` is irreversible — it would take a globally claimed run off the board.
    // So the delete is decided on a read taken immediately before it, and a follow-up that has
    // been taken is left standing with the merged source held open. The next sweep converges
    // anyway: a touched epic is neither a reuse candidate nor a rival.
    const rival = {
      ...bead("epic-7"),
      issue_type: "epic",
      metadata: { rehomeOf: "epic-1" },
      created_at: "2026-01-01T00:00:00.000Z",
    } as Bead;
    createdAt.set("epic-2", "2026-01-01T00:00:05.000Z"); // ours loses — it is the younger
    listMock.mockResolvedValueOnce([]).mockResolvedValue([rival]);
    const board = showMock.getMockImplementation()!;
    let ourReads = 0;
    showMock.mockImplementation(async (repo: string, id: string) => {
      // A worker claims our follow-up after the election read and before the delete.
      if (id === "epic-2" && ++ourReads > 1) assignees.set("epic-2", "op-2");
      return board(repo, id);
    });

    await finalize(bead("epic-1"), [bead("t2", "blocked", ["not-delivered"])]);

    expect(deleteMock).not.toHaveBeenCalled();
    // Nothing moves onto the winner either — the preserved ticket would then be split across two
    // live homes — and finalization is left undone, so the merged target stays open.
    expect(reparentMock).not.toHaveBeenCalled();
    expect(batchMock).not.toHaveBeenCalled();
    expect(untagMock).not.toHaveBeenCalled();
  });

  it("leaves its OWN losing follow-up standing once tickets hang off it (PR #199 review)", async () => {
    // Being untouched says who owns the duplicate, not what has been parented to it. Its stamp
    // makes it a reuse candidate for any other sweep of the same merged target, so one can be
    // filling it while it is still open, unassigned and unapproved — and `bd delete --force` does
    // not cascade, so deleting it would leave those tickets parentless.
    const rival = {
      ...bead("epic-7"),
      issue_type: "epic",
      metadata: { rehomeOf: "epic-1" },
      created_at: "2026-01-01T00:00:00.000Z",
    } as Bead;
    createdAt.set("epic-2", "2026-01-01T00:00:05.000Z"); // ours loses — it is the younger
    const adopted = { ...bead("t9"), parent: "epic-2" } as Bead;
    parents.set("t9", "epic-2");
    listMock
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([rival])
      // The read taken immediately before the delete — another sweep got there first.
      .mockResolvedValue([rival, adopted]);

    await finalize(bead("epic-1"), [bead("t2", "blocked", ["not-delivered"])]);

    expect(deleteMock).not.toHaveBeenCalled();
    // Nothing moves onto the winner either, and the merged target stays open for the next sweep.
    expect(reparentMock).not.toHaveBeenCalled();
    expect(batchMock).not.toHaveBeenCalled();
    expect(untagMock).not.toHaveBeenCalled();
  });

  it("leaves its OWN losing follow-up standing when childlessness cannot be read (PR #199 review)", async () => {
    // A list that fails rules nothing out, and the delete is the irreversible half. Left standing
    // with the source held open, exactly as a delete that did not land leaves it.
    const rival = {
      ...bead("epic-7"),
      issue_type: "epic",
      metadata: { rehomeOf: "epic-1" },
      created_at: "2026-01-01T00:00:00.000Z",
    } as Bead;
    createdAt.set("epic-2", "2026-01-01T00:00:05.000Z");
    listMock
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([rival])
      .mockRejectedValue(new Error("bd list: DB locked"));

    await finalize(bead("epic-1"), [bead("t2", "blocked", ["not-delivered"])]);

    expect(deleteMock).not.toHaveBeenCalled();
    expect(reparentMock).not.toHaveBeenCalled();
    expect(untagMock).not.toHaveBeenCalled();
  });

  it("reconciles a younger rival whose process died after creating it (PR #199 review)", async () => {
    // The losing process normally deletes its own duplicate the moment it sees this one — but a
    // process that crashes right after its create never gets there. Cleaning up only this process's
    // OWN loser leaves that childless stamped epic on the board for good: the merged source closes
    // here, so no later sweep re-selects it and reconciles, and an empty run target sits on the
    // board asking to be approved into a run with nothing in it.
    const rival = {
      ...bead("epic-7"),
      issue_type: "epic",
      metadata: { rehomeOf: "epic-1" },
      created_at: "2026-01-01T00:00:05.000Z",
    } as Bead;
    createdAt.set("epic-2", "2026-01-01T00:00:00.000Z");
    listMock.mockResolvedValueOnce([]).mockResolvedValue([rival]);

    await finalize(bead("epic-1"), [bead("t2", "blocked", ["not-delivered"])]);

    expect(deleteMock).toHaveBeenCalledWith("/repo", "epic-7");
    expect(reparentMock).toHaveBeenCalledWith("/repo", "t2", "epic-2");
    // The orphan is gone, so this finalization is complete and the merged target closes.
    expect(untagMock).toHaveBeenCalledWith("/repo", "epic-1", [
      "stage:in-review",
    ]);
  });

  it("leaves a losing rival that already carries tickets, and one somebody took (PR #199 review)", async () => {
    // `bd delete` does not cascade here, so removing a rival that is already a home would strand its
    // children parentless — and one a human has since approved is a run of its own. Neither is
    // anton's to remove, and neither is an empty target inviting approval.
    const filled = {
      ...bead("epic-7"),
      issue_type: "epic",
      metadata: { rehomeOf: "epic-1" },
      created_at: "2026-01-01T00:00:05.000Z",
    } as Bead;
    const approved = {
      ...bead("epic-8", "open", ["approved"]),
      issue_type: "epic",
      metadata: { rehomeOf: "epic-1" },
      created_at: "2026-01-01T00:00:06.000Z",
    } as Bead;
    const orphanTicket = { ...bead("t9"), parent: "epic-7" } as Bead;
    parents.set("t9", "epic-7");
    createdAt.set("epic-2", "2026-01-01T00:00:00.000Z");
    listMock
      .mockResolvedValueOnce([])
      .mockResolvedValue([filled, approved, orphanTicket]);

    await finalize(bead("epic-1"), [bead("t2", "blocked", ["not-delivered"])]);

    // `approved` is not even a rival — it failed the untouched test the reuse path uses.
    expect(deleteMock).not.toHaveBeenCalled();
    expect(reparentMock).toHaveBeenCalledWith("/repo", "t2", "epic-2");
    expect(untagMock).toHaveBeenCalledWith("/repo", "epic-1", [
      "stage:in-review",
    ]);
  });

  it("holds the close back when a losing rival cannot be deleted (PR #199 review)", async () => {
    // The orphan is still there, so finalization is NOT done: closing the merged source would put
    // the only bead that names this rehome out of reach, and nothing would ever clean it up.
    const rival = {
      ...bead("epic-7"),
      issue_type: "epic",
      metadata: { rehomeOf: "epic-1" },
      created_at: "2026-01-01T00:00:05.000Z",
    } as Bead;
    createdAt.set("epic-2", "2026-01-01T00:00:00.000Z");
    listMock.mockResolvedValueOnce([]).mockResolvedValue([rival]);
    deleteMock.mockRejectedValue(new Error("bd delete: DB locked"));

    await finalize(bead("epic-1"), [bead("t2", "blocked", ["not-delivered"])]);

    // The move that CAN be made is still made — only the close waits.
    expect(reparentMock).toHaveBeenCalledWith("/repo", "t2", "epic-2");
    expect(batchMock).not.toHaveBeenCalled();
    expect(untagMock).not.toHaveBeenCalled();
  });

  it("holds the close back when the board cannot be re-read after the create (PR #199 review)", async () => {
    // A list that fails cannot rule a duplicate out, and filling a home that may be one splits the
    // preserved tickets across two run targets. The follow-up keeps its stamp, so the next sweep
    // reuses this very epic and reconciles then.
    listMock
      .mockResolvedValueOnce([])
      .mockRejectedValue(new Error("bd list: DB locked"));

    await finalize(bead("epic-1"), [bead("t2", "blocked", ["not-delivered"])]);

    expect(createMock).toHaveBeenCalledTimes(1);
    expect(reparentMock).not.toHaveBeenCalled();
    expect(batchMock).not.toHaveBeenCalled();
    expect(untagMock).not.toHaveBeenCalled();
  });

  it("finalizes one merged target once when two jobs sweep it at the same time (PR #199)", async () => {
    // The two jobs queue.ts deliberately lets coexist, racing on one target. Unserialized, both
    // plan against a board with no follow-up on it and both create one — two run targets holding
    // half the preserved work each, and each pass overwriting the other's reparents.
    const created: Bead[] = [];
    createMock.mockImplementation(
      async (_repo: string, opts: { metadata?: Record<string, string> }) => {
        const id = `epic-${created.length + 2}`;
        created.push({
          id,
          title: id,
          status: "open",
          labels: [],
          metadata: opts.metadata,
        } as Bead);
        return id;
      },
    );
    listMock.mockImplementation(async () => created);
    reparentMock.mockImplementation(
      async (_repo: string, id: string, parent: string) => {
        parents.set(id, parent);
      },
    );
    const epic = bead("epic-1");
    const preserved = bead("t2", "blocked", ["not-delivered"]);

    await Promise.all([
      finalize(epic, [preserved]),
      finalize(epic, [preserved]),
    ]);

    expect(createMock).toHaveBeenCalledTimes(1);
    expect(reparentMock.mock.calls).toEqual([["/repo", "t2", "epic-2"]]);
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

  it("checks the ticket and clears the claim as one locked step (PR #199)", async () => {
    // A second run for the same operator adopts this ticket — reparents it onto a target of its
    // own and reserves it there, under the very actor string this release's CAS expects. Between
    // an unlocked check and the swap, that adoption lands and the swap then clears the live
    // reservation it just made. Under the ticket's claim lock the adoption can only queue behind
    // the whole check-and-swap, so it either loses the ticket cleanly or never races it at all.
    const events: string[] = [];
    const reserved = claimed(bead("t2", "blocked", ["not-delivered"]), "op-1");
    const adopt = () =>
      withBeadWriteLock("/repo", "t2", async () => {
        events.push("adopt");
        parents.set("t2", "epic-9");
        assignees.set("t2", "op-1");
      });
    unassignMock.mockImplementation(async (_repo: string, id: string) => {
      events.push("unassign");
      assignees.delete(id);
    });
    let reads = 0;
    showMock.mockImplementation(async (_repo: string, id: string) => {
      // The release's own read — the plan read t2 once already, before it took the lock.
      if (id === "t2" && ++reads === 2) void adopt();
      return {
        id,
        title: id,
        status: statuses.get(id) ?? "open",
        labels: boardLabels.get(id) ?? [],
        assignee: assignees.get(id),
        parent: parents.get(id),
      } as Bead;
    });

    await finalize(claimed(bead("epic-1"), "op-1"), [reserved]);

    expect(events).toEqual(["unassign", "adopt"]);
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

  it("finishes a ticket's setup before detaching it from the merged target (PR #199)", async () => {
    // A reparent takes the ticket out of `runTickets(all, epic.id)`, so the next sweep's
    // finalization never sees it again — whatever is still owed to it after the move is owed
    // forever. A ticket left `blocked`, or still assigned, beneath the un-approved follow-up parks
    // every claim at execute-epic's gate, so both writes have to land while the ticket is still
    // where a re-run of finalization would find it.
    const reserved = claimed(bead("t2", "blocked", ["not-delivered"]), "op-1");

    await finalize(claimed(bead("epic-1"), "op-1"), [reserved]);

    const detached = reparentMock.mock.invocationCallOrder[0];
    expect(detached).toBeGreaterThan(0);
    expect(unassignMock.mock.invocationCallOrder[0]).toBeLessThan(detached);
    expect(setStatusMock.mock.invocationCallOrder[0]).toBeLessThan(detached);
    // …and the note, which cannot name a home until the move lands, still comes after it.
    expect(noteMock.mock.invocationCallOrder[0]).toBeGreaterThan(detached);
    expect(noteMock.mock.calls[0][2]).toContain("now lives under epic-2");
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

  it("does not reopen a ticket reparented onto another target after the plan (PR #199 review)", async () => {
    // The window is anton's OWN release round trip, between planRehome's read and this write.
    // Status and owner alone let a reparented ticket through — its ancestry is never compared with
    // the snapshot — and the reopen would then write `open` inside somebody else's run, overriding
    // their state and possibly making the ticket runnable there. The later ancestry check only
    // declines to MOVE it, which does nothing about a status already written.
    const epic = claimed(bead("epic-1"), "op-1");
    const preserved = claimed(bead("t2", "blocked", ["not-delivered"]), "op-1");
    unassignMock.mockImplementation(async (_repo: string, id: string) => {
      assignees.delete(id);
      if (id === "t2") parents.set("t2", "epic-9");
    });

    await finalize(epic, [preserved]);

    expect(setStatusMock).not.toHaveBeenCalled();
    expect(reparentMock).not.toHaveBeenCalled();
    expect(noteFor("t2")).toContain(
      "under epic-9 rather than the target the run left it in",
    );
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
    // Nothing was left for a follow-up to take, so none is written to the board at all
    // (PR #199) — an epic created and deleted in one pass is two writes to a shared board that
    // leave nothing behind but the window in which an empty run target was claimable.
    expect(createMock).not.toHaveBeenCalled();
    expect(deleteMock).not.toHaveBeenCalled();
    // Its status is part of the state that other target runs it in — left alone too.
    expect(setStatusMock).not.toHaveBeenCalled();
    const note = noteMock.mock.calls[0][2];
    expect(note).toContain("Another operator moved it under epic-9");
    expect(note).not.toContain("--parent <new-epic>");
  });

  it("keeps the claim on a ticket a second run already owns (PR #199)", async () => {
    // Concurrency lets one operator hold two runs at once, so the second run's reservation carries
    // the SAME actor string this one claimed under. The actor-only CAS matches it, and clearing it
    // would advertise a ticket that run is executing as globally unassigned.
    const reserved = claimed(bead("t2", "blocked", ["not-delivered"]), "op-1");
    parents.set("t2", "epic-9"); // reparented into the second run while the PR sat in review

    await finalize(claimed(bead("epic-1"), "op-1"), [reserved]);

    expect(unassignMock).not.toHaveBeenCalled();
    expect(reparentMock).not.toHaveBeenCalled();
    const note = noteFor("t2");
    expect(note).toContain("Another operator moved it under epic-9");
    expect(note).toContain("still assigned to op-1");
    expect(note).not.toContain("could not be released");
  });

  it("keeps the claim on a ticket the board moved on in place (PR #199)", async () => {
    // Same reasoning without a reparent: whoever snoozed this ticket may be running it under the
    // run's own actor, and the release is decided on that actor alone.
    const reserved = claimed(bead("t2", "blocked", ["not-delivered"]), "op-1");
    statuses.set("t2", "deferred"); // moved on after the sweep read the board

    await finalize(claimed(bead("epic-1"), "op-1"), [reserved]);

    expect(unassignMock).not.toHaveBeenCalled();
    expect(setStatusMock).not.toHaveBeenCalled();
    expect(noteFor("t2")).toContain("still assigned to op-1");
  });

  it("keeps a claim a second run took between the plan and the release (PR #199)", async () => {
    // The plan cleared t2, and the release is a bd round trip later — behind every ticket settled
    // ahead of it. A second run for the same operator reparents t2 onto a target of its own and
    // reserves it there in that window: the actor-only CAS matches the string it expects and would
    // clear a live reservation, which no later ancestry check can give back.
    const reserved = claimed(bead("t2", "blocked", ["not-delivered"]), "op-1");
    showMock.mockImplementation(async (_repo: string, id: string) => {
      const live = {
        id,
        title: id,
        status: statuses.get(id) ?? "open",
        labels: boardLabels.get(id) ?? [],
        assignee: assignees.get(id),
        parent: parents.get(id),
      } as Bead;
      // The plan reads t2 here and clears it; the takeover lands immediately after that read.
      if (id === "t2") parents.set("t2", "epic-9");
      return live;
    });

    await finalize(claimed(bead("epic-1"), "op-1"), [reserved]);

    expect(unassignMock).not.toHaveBeenCalled();
    expect(setStatusMock).not.toHaveBeenCalled();
    expect(reparentMock).not.toHaveBeenCalled();
    expect(noteFor("t2")).toContain("still assigned to op-1");
  });

  it("does not move a ticket claimed between the plan and the reparent (PR #199)", async () => {
    // The plan cleared t2, and then anton's OWN release and reopen writes — bd round-trips on a
    // board other operators share — left a window before the move. A claim that lands in it makes
    // t2 somebody's live work, and moving it would advertise that work under a second target.
    setStatusMock.mockImplementation(async (_repo: string, id: string) => {
      if (id === "t2") assignees.set("t2", "op-2");
    });

    await finalize(bead("epic-1"), [bead("t2", "blocked", ["not-delivered"])]);

    expect(reparentMock).not.toHaveBeenCalled();
    expect(deleteMock).toHaveBeenCalledWith("/repo", "epic-2"); // nothing reached it
    const note = noteMock.mock.calls[0][2];
    expect(note).toContain("between planning the move and making it");
    expect(note).toContain("under op-2");
  });

  it("does not move a ticket reparented between the plan and the reparent (PR #199)", async () => {
    // Same window, the other write: another operator gave t2 a target of their own, so the ancestry
    // the plan validated is stale and the move would steal it back out of their run.
    setStatusMock.mockImplementation(async (_repo: string, id: string) => {
      if (id === "t2") parents.set("t2", "epic-9");
    });

    await finalize(bead("epic-1"), [bead("t2", "blocked", ["not-delivered"])]);

    expect(reparentMock).not.toHaveBeenCalled();
    const note = noteMock.mock.calls[0][2];
    expect(note).toContain("another operator moved it under epic-9");
    expect(note).not.toContain("--parent <new-epic>");
  });

  it("pins an ancestor whose descendant was claimed in that window (PR #199)", async () => {
    // A reparent carries the whole subtree, so a ticket taken over mid-finalization has to stop its
    // ancestor moving too — otherwise t3 rides onto the follow-up on t2's edge, exactly the move
    // the re-read refused to make directly.
    setStatusMock.mockImplementation(async (_repo: string, id: string) => {
      if (id === "t3") assignees.set("t3", "op-2");
    });

    await finalize(bead("epic-1"), [
      bead("t2", "blocked", ["not-delivered"]),
      under("t2", bead("t3", "blocked", ["not-delivered"])),
    ]);

    expect(reparentMock).not.toHaveBeenCalled();
    expect(deleteMock).toHaveBeenCalledWith("/repo", "epic-2");
    expect(noteMock.mock.calls[0][2]).toContain("t3 still hangs off it");
    expect(noteMock.mock.calls[1][2]).toContain(
      "between planning the move and making it",
    );
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

  it("decides the ride-along on the LIVE parent, not the planned one (PR #199)", async () => {
    // Another operator reparents t3 off t2 and onto t4 — still beneath the merged target, so the
    // re-read still clears it to move. Riding along on the PLANNED parent would record it as nested
    // under t2 and issue no reparent, leaving it under a delivered ticket on the merged target
    // while its note claimed it reached epic-2.
    setStatusMock.mockImplementation(async (_repo: string, id: string) => {
      if (id === "t3") parents.set("t3", "t4");
    });

    await finalize(bead("epic-1"), [
      bead("t2", "blocked", ["not-delivered"]),
      under("t2", bead("t3", "blocked", ["not-delivered"])),
      bead("t4"),
    ]);

    expect(reparentMock.mock.calls).toEqual([
      ["/repo", "t2", "epic-2"],
      ["/repo", "t3", "epic-2"],
    ]);
    expect(noteMock.mock.calls[1][2]).toContain("now lives under epic-2");
    expect(noteMock.mock.calls[1][2]).not.toContain("stays nested under t2");
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

  it("pins the ancestor when a delivered descendant was reopened since the sweep (PR #199)", async () => {
    // The closing batch is built from the same snapshot that called t3 delivered, so a t3 reopened
    // while the PR was being finalized is left out of it. Detaching it onto the merged target would
    // leave it open beneath a closed home nothing anton runs reaches — neither rehomed with t2 nor
    // closed with the merge.
    const shipped = under("t2", bead("t3", "closed"));
    statuses.set("t3", "open");

    await finalize(bead("epic-1"), [
      bead("t2", "blocked", ["not-delivered"]),
      shipped,
    ]);

    expect(reparentMock).not.toHaveBeenCalled();
    expect(deleteMock).toHaveBeenCalledWith("/repo", "epic-2");
    expect(noteFor("t2")).toContain("t3 still hangs off it");
  });

  it("pins the ancestor when a delivered descendant is claimed since the sweep (PR #199)", async () => {
    // A claim is live work whatever the status: detaching t3 would pull it out of the subtree its
    // operator selected, onto a target anton is about to close.
    const shipped = claimed(under("t2", bead("t3", "closed")), "op-2");

    await finalize(bead("epic-1"), [
      bead("t2", "blocked", ["not-delivered"]),
      shipped,
    ]);

    expect(reparentMock).not.toHaveBeenCalled();
    expect(noteFor("t2")).toContain("t3 still hangs off it");
  });

  it("re-reads a delivered child at its detach, not through the prepass memo (PR #199)", async () => {
    // a1 is an ANCESTOR of the mover t2, so pass 1a's ancestry walk already memoised it as closed.
    // It is reopened in the window d0's own detach opens — a bd round trip on a shared board — so a
    // detach decided on that memo moves a live a1 onto epic-1, which the closing snapshot leaves out
    // of the batch: open beneath a closed target nothing anton runs reaches again.
    reparentMock.mockImplementation(async (_repo: string, id: string) => {
      if (id === "d0") statuses.set("a1", "open");
    });

    await finalize(bead("epic-1"), [
      bead("m1", "blocked", ["not-delivered"]),
      under("m1", bead("d0")),
      under("m1", bead("a1", "closed")),
      under("a1", bead("t2", "blocked", ["not-delivered"])),
    ]);

    // a1 never left m1, so m1 stays put with the reason named; t2 takes a home of its own.
    expect(reparentMock.mock.calls).toEqual([
      ["/repo", "d0", "epic-1"],
      ["/repo", "t2", "epic-2"],
    ]);
    expect(noteFor("m1")).toContain("a1 still hangs off it");
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

  it("re-reads each mover at its own reparent, not just in the prepass (PR #199)", async () => {
    // Pass 1a cleared both, and then t2's own reparent — a bd round trip on a board other workers
    // share — gave the claim on t3 a window to land in. Validating once up front and moving on that
    // verdict put somebody's live work under a second target.
    reparentMock.mockImplementation(async (_repo: string, id: string) => {
      if (id === "t2") assignees.set("t3", "op-2");
    });

    await finalize(bead("epic-1"), [
      bead("t2", "blocked", ["not-delivered"]),
      bead("t3", "blocked", ["not-delivered"]),
    ]);

    expect(reparentMock.mock.calls).toEqual([["/repo", "t2", "epic-2"]]);
    const note = noteFor("t3");
    expect(note).toContain("between planning the move and making it");
    expect(note).toContain("under op-2");
  });

  it("re-reads the whole ancestor chain at the guarded move (PR #199)", async () => {
    // t2 hangs off a1, which shipped in this merge — so pass 1a reads a1 and memoises it under the
    // merged target. Another operator then moves a1 onto a target of their own, in the window m1's
    // own reparent opens. Re-reading only the mover leaves that memo answering "still on the merged
    // target", and t2 is reparented out of their subtree.
    reparentMock.mockImplementation(async (_repo: string, id: string) => {
      if (id === "m1") parents.set("a1", "epic-9");
    });

    await finalize(bead("epic-1"), [
      bead("m1", "blocked", ["not-delivered"]),
      bead("a1"),
      under("a1", bead("t2", "blocked", ["not-delivered"])),
    ]);

    expect(reparentMock.mock.calls).toEqual([["/repo", "m1", "epic-2"]]);
    const note = noteFor("t2");
    expect(note).toContain("between planning the move and making it");
    expect(note).toContain("another operator moved it under a1");
  });

  it("pins an ancestor whose rider is claimed after the prepass (PR #199)", async () => {
    // t3 rides along on t2's edge, so it never gets a reparent of its own to be guarded at. The
    // claim lands while the delivered child t4 is being detached — after pass 1a — so only a
    // re-read taken at t2's write can stop the move that would carry it.
    reparentMock.mockImplementation(async (_repo: string, id: string) => {
      if (id === "t4") assignees.set("t3", "op-2");
    });

    await finalize(bead("epic-1"), [
      bead("t2", "blocked", ["not-delivered"]),
      under("t2", bead("t3", "blocked", ["not-delivered"])),
      under("t2", bead("t4")),
    ]);

    expect(reparentMock.mock.calls).toEqual([["/repo", "t4", "epic-1"]]);
    expect(deleteMock).toHaveBeenCalledWith("/repo", "epic-2"); // nothing reached it
    expect(noteFor("t2")).toContain("t3 still hangs off it");
    expect(noteFor("t3")).toContain("between planning the move and making it");
  });

  it("pins an ancestor an EXCLUDED ticket is reparented under after the prepass (PR #199)", async () => {
    // x1 is deferred, so the plan refused it and pass 1b pinned on the ancestry it had THEN — as a
    // sibling of m1. Another operator hangs it off m1 while the delivered child d0 is being
    // detached, and a rider scan that only walks `takeable` never sees it: m1's move would carry
    // their snoozed ticket onto a target anton wrote.
    reparentMock.mockImplementation(async (_repo: string, id: string) => {
      if (id === "d0") parents.set("x1", "m1");
    });

    await finalize(bead("epic-1"), [
      bead("m1", "blocked", ["not-delivered"]),
      under("m1", bead("d0")),
      bead("x1", "deferred", ["not-delivered"]),
    ]);

    expect(reparentMock.mock.calls).toEqual([["/repo", "d0", "epic-1"]]);
    expect(deleteMock).toHaveBeenCalledWith("/repo", "epic-2"); // nothing reached it
    expect(noteFor("m1")).toContain("x1 still hangs off it");
  });

  it("pins an ancestor a DELIVERED ticket is reparented under after the detaches (PR #199 review)", async () => {
    // d1 shipped in this merge, and pass 1c only inspects the ancestor its SNAPSHOT named — the
    // merged target, which is not moving — so it is detached by nothing. Another operator hangs it
    // off m1 while d0 is being detached, and a rider scan that walks only `takeable` and `excluded`
    // never sees it: m1's move would carry a ticket this merge already shipped onto the follow-up,
    // whose squash-merged branch shows none of its commits, and the next run would redo that work.
    reparentMock.mockImplementation(async (_repo: string, id: string) => {
      if (id === "d0") parents.set("d1", "m1");
    });

    await finalize(bead("epic-1"), [
      bead("m1", "blocked", ["not-delivered"]),
      under("m1", bead("d0")),
      bead("d1", "closed"),
    ]);

    expect(reparentMock.mock.calls).toEqual([["/repo", "d0", "epic-1"]]);
    expect(deleteMock).toHaveBeenCalledWith("/repo", "epic-2"); // nothing reached it
    expect(noteFor("m1")).toContain("d1 still hangs off it");
  });

  it("re-reads a candidate before deciding it does not ride along (PR #199)", async () => {
    // t3 was a SIBLING when the prepass read it, so the ride-along test answers from that memo. In
    // the window the delivered child d0's detach opens, another operator hangs t3 off t2 and claims
    // it — and t2's reparent then carries their live work onto the follow-up on an edge the stale
    // read said did not exist.
    reparentMock.mockImplementation(async (_repo: string, id: string) => {
      if (id === "d0") {
        parents.set("t3", "t2");
        assignees.set("t3", "op-2");
      }
    });

    await finalize(bead("epic-1"), [
      bead("t2", "blocked", ["not-delivered"]),
      under("t2", bead("d0")),
      bead("t3", "blocked", ["not-delivered"]),
    ]);

    expect(reparentMock.mock.calls).toEqual([["/repo", "d0", "epic-1"]]);
    expect(deleteMock).toHaveBeenCalledWith("/repo", "epic-2"); // nothing reached it
    expect(noteFor("t2")).toContain("t3 still hangs off it");
    expect(noteFor("t3")).toContain("under op-2");
  });

  it("does not detach a delivered child from an ancestor that went stale (PR #199)", async () => {
    // Another operator gave t2 a target of their own in the window before the writes, so pass 1a
    // marks it stale and it never moves. Its delivered child t3 must not be detached either: that
    // subtree is theirs now, and the detach would rewrite an edge inside the run they are executing.
    setStatusMock.mockImplementation(async (_repo: string, id: string) => {
      if (id === "t2") parents.set("t2", "epic-9");
    });

    await finalize(bead("epic-1"), [
      bead("t2", "blocked", ["not-delivered"]),
      under("t2", bead("t3")),
    ]);

    expect(reparentMock).not.toHaveBeenCalled();
    expect(deleteMock).toHaveBeenCalledWith("/repo", "epic-2");
    expect(noteMock.mock.calls[0][2]).toContain(
      "another operator moved it under epic-9",
    );
  });

  it("re-reads the ancestor at its child's detach, not just in the prepass (PR #199)", async () => {
    // m1's own delivered child d0 is detached first, and that bd round trip is the window the claim
    // on t2 lands in — after pass 1a cleared it. Deciding t3's detach on that prepass verdict
    // rewrites an edge inside the subtree op-2 now owns, and strands the shipped t3 under a target
    // anton is about to close.
    reparentMock.mockImplementation(async (_repo: string, id: string) => {
      if (id === "d0") assignees.set("t2", "op-2");
    });

    await finalize(bead("epic-1"), [
      bead("m1", "blocked", ["not-delivered"]),
      under("m1", bead("d0")),
      bead("t2", "blocked", ["not-delivered"]),
      under("t2", bead("t3")),
    ]);

    expect(reparentMock.mock.calls).toEqual([
      ["/repo", "d0", "epic-1"],
      ["/repo", "m1", "epic-2"],
    ]);
    const note = noteFor("t2");
    expect(note).toContain("between planning the move and making it");
    expect(note).toContain("under op-2");
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
    expect(createMock).not.toHaveBeenCalled(); // nothing to take, so no follow-up is written
    expect(deleteMock).not.toHaveBeenCalled();
    expect(setStatusMock).not.toHaveBeenCalled();
    expect(noteMock.mock.calls[0][2]).toContain(
      "Another operator moved it under t2",
    );
  });

  it("holds the close back when an ancestor in the chain cannot be re-read", async () => {
    // An unreadable link proves neither that t3 still rides on the merged target nor that somebody
    // took it, so it moves nothing and its note claims neither. Nor may the target CLOSE over it
    // (PR #199 review): a ticket no verdict covers is indistinguishable from one anton left behind
    // on purpose, and closing epic-1 would strand t3 undelivered beneath a target no later sweep
    // re-selects.
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
    expect(createMock).not.toHaveBeenCalled(); // nothing to take, so no follow-up is written
    expect(deleteMock).not.toHaveBeenCalled();
    const note = noteMock.mock.calls[0][2];
    expect(note).toContain("could not confirm it still hangs under epic-1");
    expect(note).not.toContain("Another operator moved it");
    // Left open and `stage:in-review`, so the next sweep plans the whole rehome again.
    expect(batchMock).not.toHaveBeenCalled();
    expect(untagMock).not.toHaveBeenCalled();
  });

  it("holds the close back when a preserved ticket itself cannot be re-read (PR #199)", async () => {
    // Same silence one step nearer: the candidate's OWN read fails, so anton knows nothing about
    // whether it is still this run's to move. Omitted from every verdict it would read as
    // intentionally excluded, and the closing batch would retire the merged target over it.
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

    await finalize(bead("epic-1"), [bead("t2", "blocked", ["not-delivered"])]);

    expect(createMock).not.toHaveBeenCalled();
    expect(reparentMock).not.toHaveBeenCalled();
    expect(batchMock).not.toHaveBeenCalled();
    expect(untagMock).not.toHaveBeenCalled();
    expect(noteMock.mock.calls[0][2]).toContain(
      "could not re-read it from the board",
    );
  });

  it("still moves what it can when another candidate is unreadable (PR #199)", async () => {
    // The moves that CAN be made are worth making — a rehome is not all-or-nothing — but the
    // unreadable one is finalization left undone all the same, so the target stays open for the
    // next sweep rather than closing over a ticket nobody decided about.
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
      bead("t2", "blocked", ["not-delivered"]),
      bead("t3", "blocked", ["not-delivered"]),
    ]);

    expect(reparentMock).toHaveBeenCalledWith("/repo", "t3", "epic-2");
    expect(batchMock).not.toHaveBeenCalled();
    expect(untagMock).not.toHaveBeenCalled();
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
    expect(createMock).not.toHaveBeenCalled(); // nothing to take, so no follow-up is written
    expect(deleteMock).not.toHaveBeenCalled();
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
    expect(createMock).not.toHaveBeenCalled(); // nothing to take, so no follow-up is written
    expect(deleteMock).not.toHaveBeenCalled();
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
