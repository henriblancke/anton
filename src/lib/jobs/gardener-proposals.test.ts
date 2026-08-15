/**
 * The gardener patrol's judgment tier, exercised DIRECTLY (anton-l4do) — the one tier that files
 * beads, with only `bd` and the sync nudge stubbed.
 *
 * What carries it: the tier turns a finding a human must judge into an ASK, never into the move
 * itself; it asks once; and whatever it managed to file is reported and propagated even when the
 * pass is about to fail — a proposal that exists only in the local working set is invisible to every
 * other machine.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Bead, SyncOutcome } from "../beads/bd";
import type { HygieneFinding } from "../hygiene";
import { fakeScope } from "./pass.fixture";

const listMock = vi.fn<(cwd: string, extra?: string[]) => Promise<Bead[]>>();
const showMock = vi.fn<(cwd: string, id: string) => Promise<Bead>>();
const closeMock = vi.fn<(cwd: string, id: string, reason?: string) => Promise<string>>();
const createMock =
  vi.fn<(cwd: string, opts: { title: string; labels?: string[] }) => Promise<string>>();
const pushMock = vi.fn<(cwd: string) => Promise<SyncOutcome>>();
const pullMock = vi.fn<(cwd: string) => Promise<void>>();

vi.mock("../beads/bd", async () => {
  const actual = await vi.importActual<typeof import("../beads/bd")>("../beads/bd");
  return {
    ...actual,
    beads: {
      ...actual.beads,
      pull: (...a: [string]) => pullMock(...a),
      list: (...a: [string, string[]?]) => listMock(...a),
      show: (...a: [string, string]) => showMock(...a),
      close: (...a: [string, string, string?]) => closeMock(...a),
      create: (...a: [string, { title: string; labels?: string[] }]) => createMock(...a),
    },
  };
});

const { fileGardenerProposals } = await import("./gardener-proposals");

const REPO = "/tmp/gardener-proposals";
const OBSERVED_AT = 1_700_000_000_000;

/** An orphan bd's report names and the patrol proposes retiring: shipped by a commit, still open. */
const ORPHAN_FINDING: HygieneFinding = {
  kind: "orphan",
  key: "orphan:t-4",
  beadId: "t-4",
  title: "shipped",
  detail: "named by a commit (abc1234) but still open",
};

const bead = (id: string, o: Partial<Bead> = {}): Bead => ({
  id,
  title: id,
  status: "open",
  issue_type: "task",
  ...o,
});

/** The arbitration seam: a settle that costs no wall-clock, and no remote to race by default. */
const arbitration = { push: (...a: [string]) => pushMock(...a), sleep: async () => {} };

const file = (scope: ReturnType<typeof fakeScope>, findings = [ORPHAN_FINDING]) =>
  fileGardenerProposals(scope, { findings, observedAtMs: OBSERVED_AT, arbitration });

beforeEach(() => {
  vi.clearAllMocks();
  listMock.mockResolvedValue([bead("t-4", { title: "shipped" })]);
  // Fails closed: an unreadable bead makes every fold stand down, so only a case that stages a twin
  // can produce one.
  showMock.mockRejectedValue(new Error("no such bead"));
  closeMock.mockResolvedValue("");
  createMock.mockResolvedValue("p-1");
  pushMock.mockResolvedValue("not-wired");
  pullMock.mockResolvedValue(undefined);
});

describe("fileGardenerProposals", () => {
  it("asks about the judgment the report can only describe, and propagates the ask", async () => {
    const scope = fakeScope(REPO);
    await file(scope);

    expect(createMock).toHaveBeenCalledTimes(1);
    const [, draft] = createMock.mock.calls[0];
    expect(draft.title).toContain("t-4");
    expect(draft.labels?.some((l) => l.startsWith("gardener:shipped-orphan:"))).toBe(true);
    // t-4 itself is untouched: the proposal is this tier's only write.
    expect(closeMock).not.toHaveBeenCalled();
    expect(scope.nudged).toEqual([scope.project]);
  });

  it("files nothing for a clean board, and stays quiet on the remote", async () => {
    const scope = fakeScope(REPO);
    await file(scope, []);

    expect(createMock).not.toHaveBeenCalled();
    expect(scope.nudged).toEqual([]);
  });

  it("asks once: a fingerprint already on the board files nothing", async () => {
    const first = fakeScope(REPO);
    await file(first);
    const [, draft] = createMock.mock.calls[0];

    listMock.mockResolvedValue([
      bead("t-4", { title: "shipped" }),
      bead("p-1", { title: draft.title, labels: draft.labels }),
    ]);
    createMock.mockClear();
    const second = fakeScope(REPO);

    await file(second);
    expect(createMock).not.toHaveBeenCalled();
    expect(second.nudged).toEqual([]);
  });

  it("files nothing when the pass was cancelled while it read the board", async () => {
    // `ctx.heartbeat()` does not inspect the signal, so a cancel arriving during the board read is
    // invisible until the check that guards the first write.
    const scope = fakeScope(REPO);
    listMock.mockImplementation(async () => {
      scope.ctx.abort();
      return [bead("t-4", { title: "shipped" })];
    });

    await expect(file(scope)).rejects.toThrow();
    expect(createMock).not.toHaveBeenCalled();
  });

  it("propagates what landed when a later create fails, then fails the pass", async () => {
    // A create that fails part-way leaves the earlier proposals in the local working set only. If
    // the failing one keeps failing the pass parks, so the nudge has to happen on the way out.
    const findings: HygieneFinding[] = [
      ORPHAN_FINDING,
      {
        kind: "orphan",
        key: "orphan:t-5",
        beadId: "t-5",
        title: "also shipped",
        detail: "named by a commit (def5678) but still open",
      },
    ];
    listMock.mockResolvedValue([
      bead("t-4", { title: "shipped" }),
      bead("t-5", { title: "also shipped" }),
    ]);
    createMock.mockImplementationOnce(async () => "p-1").mockImplementationOnce(async () => {
      throw new Error("bd create exploded");
    });
    const scope = fakeScope(REPO);

    await expect(file(scope, findings)).rejects.toThrow("bd create exploded");
    expect(scope.nudged).toEqual([scope.project]);
  });

  it("withdraws its own proposal when another machine had already filed the same claim", async () => {
    // The cross-machine race (anton-x4ks): suppression read a working set the rival's create had not
    // synced into, so the claim reached the board twice. The pass publishes, re-reads, and folds its
    // own twin rather than leaving an operator the same ask to answer twice.
    const boardNow = (): Bead[] => {
      const [, draft] = createMock.mock.calls[0] ?? [];
      const shipped = bead("t-4", { title: "shipped" });
      if (!draft) return [shipped];
      const twin = (id: string) => bead(id, { title: draft.title, labels: draft.labels });
      return [shipped, twin("p-0"), twin("p-1")]; // p-0 the rival's, filed first
    };
    listMock.mockImplementation(async () => boardNow());
    showMock.mockImplementation(async (_cwd, id) => {
      const found = boardNow().find((b) => b.id === id);
      if (!found) throw new Error(`no such bead: ${id}`);
      return found;
    });
    pushMock.mockResolvedValue("synced");

    await file(fakeScope(REPO));

    expect(pushMock).toHaveBeenCalledWith(REPO);
    const [, closedId, reason] = closeMock.mock.calls[0];
    expect(closedId).toBe("p-1"); // ours: the total order both machines compute keeps p-0
    expect(reason).toContain("p-0");
  });

  it("keeps the tier green when arbitration cannot publish", async () => {
    // Fails open: a duplicate the next patrol folds must never cost this pass the proposal it filed.
    pushMock.mockRejectedValue(new Error("dolt push exploded"));

    await file(fakeScope(REPO));

    expect(createMock).toHaveBeenCalledTimes(1);
    expect(closeMock).not.toHaveBeenCalled();
  });

  it("records what an armed patrol would have done, and writes nothing to record it", async () => {
    const scope = fakeScope(REPO, {
      policy: { "shipped-orphan": "shadow" } as ReturnType<typeof fakeScope>["policy"],
    });
    // Untouched since well before the patrol read the board, so the premise fence still holds.
    listMock.mockResolvedValue([
      bead("t-4", { title: "shipped", updated_at: "2023-01-01T00:00:00Z" }),
    ]);

    await file(scope);

    expect(scope.logged.join("")).toContain(
      "[gardener] SHADOW p-1 (shipped-orphan) retire/close t-4 — WOULD APPLY: closed t-4 as shipped\n",
    );
    expect(closeMock).not.toHaveBeenCalled();
  });
});
