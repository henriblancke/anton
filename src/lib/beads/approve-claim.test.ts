/**
 * The compensation half of approve+claim (PR #218 review): what `unwindApproveClaim` takes back,
 * what it refuses to take back, and the lock it holds while it does.
 *
 * Driven against a fake board through spies on the `beads` surface, because the guard these assert
 * is the process-wide claim lock — the same one the approve route and the picker's apply queue on —
 * and a hand-rolled second guard would serialize nothing against it.
 *
 * The forward sequence is covered where its callers are (`jobs/picker-apply.test.ts`, the approve
 * route suite); what only shows up here is the unwind's own concurrency.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { beads, LABELS } from "./bd";
import { setAssigneeIfOwner } from "./claim";
import { unwindApproveClaim } from "./approve-claim";
import type { Bead } from "./types";

const ID = "bd-1";

/** One bead, in a map the spies below read and write. */
const board = new Map<string, Bead>();

/** A repo path per test: the claim lock is keyed on it, so sharing one would order unrelated cases. */
let repo = "";
let n = 0;

function put(o: Partial<Bead> = {}): void {
  board.set(ID, { id: ID, title: ID, status: "open", issue_type: "task", ...o } as Bead);
}

function read(): Bead {
  return board.get(ID)!;
}

beforeEach(() => {
  board.clear();
  repo = `/tmp/approve-claim-${(n += 1)}`;
  vi.spyOn(beads, "show").mockImplementation(async (_cwd, id) => {
    const b = board.get(id);
    if (!b) throw new Error(`no such bead ${id}`);
    return { ...b };
  });
  vi.spyOn(beads, "assign").mockImplementation(async (_cwd, id, actor) => {
    board.get(id)!.assignee = actor;
    return "";
  });
  vi.spyOn(beads, "unassign").mockImplementation(async (_cwd, id) => {
    board.get(id)!.assignee = undefined;
    return "";
  });
  vi.spyOn(beads, "untag").mockImplementation(async (_cwd, id, labels) => {
    const b = board.get(id)!;
    b.labels = (b.labels ?? []).filter((l) => !labels.includes(l));
    return "";
  });
});
afterEach(() => vi.restoreAllMocks());

describe("unwindApproveClaim", () => {
  it("takes both writes back and reports nothing left", async () => {
    put({ labels: [LABELS.approved], assignee: "anton-box" });

    await expect(
      unwindApproveClaim({
        repoPath: repo,
        beadId: ID,
        owner: "anton-box",
        restoreTo: undefined,
        wroteLabel: true,
        wroteClaim: true,
      }),
    ).resolves.toBeUndefined();

    expect(read().labels).not.toContain(LABELS.approved);
    expect(read().assignee).toBeUndefined();
  });

  it("reports a claim leftover when the release read back as still ours", async () => {
    // `bd unassign` is no more atomic than `bd assign`: it can be undone inside the read-back window
    // by another process restoring the same machine-scoped owner, or simply not take. The swap comes
    // back as a LOST CAS naming us — an object, and so truthy — and reporting that as a clean unwind
    // would tell the caller nothing was left while the reservation still hides the target from every
    // later pass.
    put({ assignee: "anton-box" });
    vi.spyOn(beads, "unassign").mockResolvedValue("");

    await expect(
      unwindApproveClaim({
        repoPath: repo,
        beadId: ID,
        owner: "anton-box",
        restoreTo: undefined,
        wroteLabel: false,
        wroteClaim: true,
      }),
    ).resolves.toBe("claim");

    expect(read().assignee).toBe("anton-box");
  });

  it("reports nothing when the release lost to a third party", async () => {
    // The other side of the same verdict: someone else holds the reservation now, which is a safe
    // final state and not ours to repair — reporting it would send an operator to clear a claim that
    // is doing its job.
    put({ assignee: "other-box" });

    await expect(
      unwindApproveClaim({
        repoPath: repo,
        beadId: ID,
        owner: "anton-box",
        restoreTo: undefined,
        wroteLabel: false,
        wroteClaim: true,
      }),
    ).resolves.toBeUndefined();

    expect(read().assignee).toBe("other-box");
  });

  it("leaves both writes alone when the reservation changed hands mid-compensation", async () => {
    // The untag is the one UNCONDITIONAL write here, and the lock orders this process only: on a
    // shared-server board a competing picker can win the assignee race between the ambiguous
    // `beads.approve` and this compensation. Stripping the label then erases the approval the WINNER
    // is running on, so the whole unwind stands down instead (PR #218 review).
    put({ labels: [LABELS.approved], assignee: "other-box" });

    await expect(
      unwindApproveClaim({
        repoPath: repo,
        beadId: ID,
        owner: "anton-box",
        restoreTo: undefined,
        wroteLabel: true,
        wroteClaim: true,
      }),
    ).resolves.toBe("transferred");

    expect(read().labels).toContain(LABELS.approved);
    expect(read().assignee).toBe("other-box");
    expect(beads.untag).not.toHaveBeenCalled();
  });

  it("takes the approval back when the reservation was merely RELEASED", async () => {
    // The other half of that same read (PR #218 review): a human clearing the assignee leaves nobody
    // whose decision the approval has become. Standing down on it the way a transfer does would
    // publish an approved, unassigned target with no run behind it — the exact shape a picker pass
    // or a worker starts on — so a cleared assignee unwinds like any other failure.
    put({ labels: [LABELS.approved] });

    await expect(
      unwindApproveClaim({
        repoPath: repo,
        beadId: ID,
        owner: "anton-box",
        restoreTo: undefined,
        wroteLabel: true,
        wroteClaim: true,
      }),
    ).resolves.toBeUndefined();

    expect(read().labels).not.toContain(LABELS.approved);
    expect(read().assignee).toBeUndefined();
  });

  it("writes nothing and reports the approval when the bead cannot be re-read", async () => {
    // An unreadable board answers neither question, and the untag is unconditional (PR #218 review):
    // assuming the reservation is still ours would strip the approval a successor's run is already
    // executing on, over a transient `bd show`. So the unwind stops and names what it left, which is
    // a state a person can see and undo.
    put({ labels: [LABELS.approved], assignee: "anton-box" });
    vi.spyOn(beads, "show").mockRejectedValue(new Error("bd is down"));

    await expect(
      unwindApproveClaim({
        repoPath: repo,
        beadId: ID,
        owner: "anton-box",
        restoreTo: undefined,
        wroteLabel: true,
        wroteClaim: true,
      }),
    ).resolves.toBe("approval");

    expect(read().labels).toContain(LABELS.approved);
    expect(read().assignee).toBe("anton-box");
    expect(beads.untag).not.toHaveBeenCalled();
  });

  it("holds the bead lock across the whole unwind, so a retry cannot land between its legs", async () => {
    // Unlocked, the untag and the release are separately ordered: a concurrent approval of the same
    // target could take the reservation between them and have this release hand it straight back,
    // leaving its fresh approval standing over an unassigned target.
    put({ labels: [LABELS.approved], assignee: "anton-box" });
    const order: string[] = [];
    vi.spyOn(beads, "untag").mockImplementation(async (_cwd, id, labels) => {
      // Slow enough that an unlocked retry would win the race to the assignee.
      await new Promise((r) => setTimeout(r, 20));
      const b = board.get(id)!;
      b.labels = (b.labels ?? []).filter((l) => !labels.includes(l));
      order.push("unapproved");
      return "";
    });

    const unwinding = unwindApproveClaim({
      repoPath: repo,
      beadId: ID,
      owner: "anton-box",
      restoreTo: undefined,
      wroteLabel: true,
      wroteClaim: true,
    }).then((leftover) => {
      order.push("released");
      return leftover;
    });
    const retrying = setAssigneeIfOwner(repo, ID, "anton-box", "other-box").then((r) => {
      order.push("retry");
      return r;
    });

    await expect(unwinding).resolves.toBeUndefined();
    // The retry ran after the whole unwind, so it gated on an owner nobody holds any more and lost —
    // rather than taking the target mid-compensation and having it released underneath.
    await expect(retrying).resolves.toEqual({ ok: false, owner: undefined });
    expect(order).toEqual(["unapproved", "released", "retry"]);
    expect(read().assignee).toBeUndefined();
  });
});
