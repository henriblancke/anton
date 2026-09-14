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
import { REJUDGE_DEFERRED_DAYS } from "../gardener/detect";
import { MAX_PROPOSALS_PER_PASS } from "../gardener/emit";
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

/** A bead parked `days` before the pass's clock and untouched since — the re-judgement's subject. */
const parked = (id: string, days: number): Bead =>
  bead(id, {
    status: "deferred",
    title: `parked ${id}`,
    updated_at: new Date(OBSERVED_AT - days * 86_400_000).toISOString(),
  });

/** Which kinds a pass filed, in the order it filed them. */
const filedKinds = (): string[] =>
  createMock.mock.calls.map(
    ([, draft]) => draft.labels?.find((l) => l.startsWith("gardener:"))?.split(":")[1] ?? "",
  );

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

/**
 * The re-judgement of parked work (anton-30vo), riding the patrol's own cadence.
 *
 * Two properties carry it, and they are the same property from either side: a board whose parked
 * work is still recent produces NOTHING and that is the pass succeeding, while a bead nobody has
 * looked at for a quarter produces exactly one ask. The third is the budget — a tier that files at
 * most ten does not get to file eleven because a new detector joined it.
 */
describe("fileGardenerProposals · re-judging parked work", () => {
  it("asks about a bead parked past the window, and leaves it parked", async () => {
    listMock.mockResolvedValue([parked("t-9", REJUDGE_DEFERRED_DAYS)]);
    const scope = fakeScope(REPO);

    expect(await file(scope, [])).toBe(1);
    const [, draft] = createMock.mock.calls[0];
    expect(draft.title).toContain("t-9");
    expect(draft.labels?.some((l) => l.startsWith("gardener:aged-defer:"))).toBe(true);
    // The ask is the whole write: undeferring t-9 is the approver's move, never the patrol's.
    expect(closeMock).not.toHaveBeenCalled();
    expect(scope.nudged).toEqual([scope.project]);
  });

  it("files nothing while the parking is still recent — and that is the pass succeeding", async () => {
    listMock.mockResolvedValue([parked("t-9", REJUDGE_DEFERRED_DAYS - 1)]);
    const scope = fakeScope(REPO);

    expect(await file(scope, [])).toBe(0);
    expect(createMock).not.toHaveBeenCalled();
    expect(scope.nudged).toEqual([]);
  });

  it("respects the pass's write budget, spending it on live work before parked work", async () => {
    // Twelve re-judgements and one shipped orphan, for a cap of ten: the cap is what a founder reads
    // in a morning, and a detector added to the tier shares it rather than extending it. Board SHAPE
    // goes first — work that is still live outranks work parked a quarter ago — and the oldest
    // silence takes the rest, so what the next patrol picks up is the least forgotten.
    const parkedIds = Array.from({ length: MAX_PROPOSALS_PER_PASS + 2 }, (_, i) => `t-${100 + i}`);
    listMock.mockResolvedValue([
      bead("t-4", { title: "shipped" }),
      // Oldest first, so `parkedIds` reads in the order the detector ranks them.
      ...parkedIds.map((id, i) => parked(id, REJUDGE_DEFERRED_DAYS + parkedIds.length - i)),
    ]);

    expect(await file(fakeScope(REPO))).toBe(MAX_PROPOSALS_PER_PASS);
    expect(filedKinds()).toEqual([
      "shipped-orphan",
      ...Array.from({ length: MAX_PROPOSALS_PER_PASS - 1 }, () => "aged-defer"),
    ]);
    const asked = createMock.mock.calls.map(([, draft]) => draft.title).join("\n");
    const held = parkedIds.slice(MAX_PROPOSALS_PER_PASS - 1);
    for (const id of parkedIds.slice(0, MAX_PROPOSALS_PER_PASS - 1)) expect(asked).toContain(id);
    // The three youngest silences are held back, not lost: the next patrol files them.
    expect(held).toHaveLength(3);
    for (const id of held) expect(asked).not.toContain(id);
  });
});
