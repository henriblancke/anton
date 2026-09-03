/**
 * The `dep-missing` repair (anton-qg4h / R5.4).
 *
 * The claims, in the order they matter:
 *   • A RESOLVABLE prerequisite draws one `blocks` edge in the direction bd reads as "the
 *     prerequisite blocks the target", and the target is parked rather than retried.
 *   • THE REPAIR NEVER CREATES WORK. A prerequisite that resolves to no bead on the board escalates,
 *     and so does every other reading anton would have to guess at: several beads named, one already
 *     closed, an ordering already recorded, an edge bd would reject.
 *   • THE EDGE IS REVERSIBLE, and the repair uses that itself: a record it cannot write takes the
 *     edge back rather than leaving an ordering nothing on the board explains.
 *   • ONE REPAIR PER BEAD PER CLASS (R5.6) — the guard is repair.ts's, and it is asked first.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Bead } from "../beads/bd";

const linkMock =
  vi.fn<(repo: string, a: string, b: string, type: string) => Promise<string>>(async () => "");
const unlinkMock = vi.fn<(repo: string, a: string, b: string) => Promise<string>>(async () => "");
const tagMock = vi.fn<(repo: string, id: string, labels: string[]) => Promise<string>>(async () => "");
const noteMock = vi.fn<(repo: string, id: string, text: string) => Promise<string>>(async () => "");
const listMock = vi.fn<(repo: string, extra?: string[]) => Promise<unknown[]>>(async () => []);

vi.mock("../beads/bd", async () => {
  const actual = await vi.importActual<typeof import("../beads/bd")>("../beads/bd");
  return {
    ...actual,
    beads: {
      ...actual.beads,
      link: linkMock,
      unlink: unlinkMock,
      tag: tagMock,
      note: noteMock,
      list: listMock,
    },
  };
});

const { repairFingerprint, repairLabel, repairNote } = await import("./repair");
const {
  namedPrereqs,
  refusalNote,
  repairDepMissing,
  resolvePrereq,
  reversalNote,
  revertPrereqEdge,
} = await import("./repair-dep-missing");
const { indexBoard } = await import("./board-index");

const REPO = "/repo";
const TARGET = "anton-qg4h";
const PREREQ = "anton-blkr";
const T0 = Date.UTC(2026, 8, 3, 11, 0, 0);

const bead = (id: string, over: Partial<Bead> = {}): Bead =>
  ({ id, title: id, status: "open", issue_type: "task", ...over }) as Bead;

const blocks = (blocked: string, blocker: string) => ({
  issue_id: blocked,
  depends_on_id: blocker,
  type: "blocks",
});
const discoveredFrom = (discovered: string, source: string) => ({
  issue_id: discovered,
  depends_on_id: source,
  type: "discovered-from",
});

/** The board every case starts from: the blocked target and an open prerequisite, unrelated. */
const board = (over: Partial<Bead> = {}, extra: Bead[] = []): Bead[] => [
  bead(TARGET, over),
  bead(PREREQ),
  ...extra,
];

/** The block as the classified self-report hands it over — the prose after `dep-missing — `. */
const block = (reason?: string) => ({ reason });

/** The repaired bead as {@link repairDepMissing} leaves it, for the second-block cases. */
const alreadyRepaired = (attempted = `recorded \`${PREREQ}\` as a blocker`): Bead =>
  bead(TARGET, {
    labels: [repairLabel(TARGET, "dep-missing", T0), "domain:eng"],
    notes: repairNote(repairFingerprint(TARGET, "dep-missing"), attempted),
  } as Partial<Bead>);

beforeEach(() => {
  for (const m of [linkMock, unlinkMock, tagMock, noteMock, listMock]) m.mockClear();
  listMock.mockImplementation(async () => board());
});

describe("the prerequisite the agent named", () => {
  it("reads every bead id out of the prose, once, in the order written", () => {
    expect(namedPrereqs("needs anton-blkr to land, see anton-287p.1 and anton-blkr again")).toEqual([
      "anton-blkr",
      "anton-287p.1",
    ]);
  });

  it("finds none in prose that names no id", () => {
    expect(namedPrereqs("waiting on the auth module to exist")).toEqual([]);
    expect(namedPrereqs(undefined)).toEqual([]);
    expect(namedPrereqs("")).toEqual([]);
  });

  it("resolves one open bead the board holds", () => {
    expect(resolvePrereq(indexBoard(board()), TARGET, `blocked on ${PREREQ}`)).toEqual({
      state: "resolved",
      id: PREREQ,
    });
  });

  it("refuses prose that names no bead — the repair records ordering, it does not create work", () => {
    const verdict = resolvePrereq(indexBoard(board()), TARGET, "waiting on the auth module");
    expect(verdict.state).toBe("unresolved");
    expect(verdict).toMatchObject({ why: expect.stringContaining("no bead id") });
  });

  it("refuses an id the board does not hold", () => {
    const verdict = resolvePrereq(indexBoard(board()), TARGET, "blocked on anton-ghost");
    expect(verdict).toMatchObject({
      state: "unresolved",
      why: expect.stringContaining("holds no such bead"),
    });
  });

  it("refuses to pick between two beads it names", () => {
    const verdict = resolvePrereq(
      indexBoard(board({}, [bead("anton-othr")])),
      TARGET,
      `blocked on ${PREREQ} and anton-othr`,
    );
    expect(verdict).toMatchObject({
      state: "unresolved",
      why: expect.stringContaining("which one the work is waiting on"),
    });
  });

  it("ignores the target's own id, so a reason that quotes it still resolves", () => {
    expect(
      resolvePrereq(indexBoard(board()), TARGET, `${TARGET} needs ${PREREQ} first`),
    ).toEqual({ state: "resolved", id: PREREQ });
  });

  it("refuses a prerequisite that is already closed — parking behind it would park for good", () => {
    const closed = [bead(TARGET), bead(PREREQ, { status: "closed" })];
    expect(resolvePrereq(indexBoard(closed), TARGET, `blocked on ${PREREQ}`)).toMatchObject({
      state: "unresolved",
      why: expect.stringContaining("already settled"),
    });
  });

  it("refuses an ordering the board already records", () => {
    const linked = board({ dependencies: [blocks(TARGET, PREREQ)] } as Partial<Bead>);
    expect(resolvePrereq(indexBoard(linked), TARGET, `blocked on ${PREREQ}`)).toMatchObject({
      state: "unresolved",
      why: expect.stringContaining("already records"),
    });
  });

  it("refuses the edge that would close a cycle, which bd rejects anyway", () => {
    const cyclic = [
      bead(TARGET),
      bead(PREREQ, { dependencies: [blocks(PREREQ, "anton-mid")] } as Partial<Bead>),
      bead("anton-mid", { dependencies: [blocks("anton-mid", TARGET)] } as Partial<Bead>),
    ];
    expect(resolvePrereq(indexBoard(cyclic), TARGET, `blocked on ${PREREQ}`)).toMatchObject({
      state: "unresolved",
      why: expect.stringContaining("cycle"),
    });
  });

  it("refuses a pair whose one edge is already provenance (anton-wsap)", () => {
    const discovered = board({ dependencies: [discoveredFrom(TARGET, PREREQ)] } as Partial<Bead>);
    expect(resolvePrereq(indexBoard(discovered), TARGET, `blocked on ${PREREQ}`)).toMatchObject({
      state: "unresolved",
      why: expect.stringContaining("anton-wsap"),
    });
  });

  it("refuses a parent/child pair, which sequences through the hierarchy", () => {
    const parented = board({ parent: PREREQ } as Partial<Bead>);
    expect(resolvePrereq(indexBoard(parented), TARGET, `blocked on ${PREREQ}`)).toMatchObject({
      state: "unresolved",
      why: expect.stringContaining("parent chain"),
    });
  });
});

describe("repairDepMissing", () => {
  it("draws the edge, stamps the repair with the agent's reason, and parks the target", async () => {
    const outcome = await repairDepMissing({
      repoPath: REPO,
      bead: bead(TARGET),
      block: block(`the schema ${PREREQ} adds has to land first`),
      now: T0,
      autonomy: "apply",
    });

    expect(outcome).toMatchObject({ action: "parked", blockerId: PREREQ });
    // `bd link a b --type blocks` = b blocks a: the target depends on the prerequisite.
    expect(linkMock).toHaveBeenCalledWith(REPO, TARGET, PREREQ, "blocks");
    expect(unlinkMock).not.toHaveBeenCalled();
    // Recorded as a repair: the label is the suppression, the note carries the agent's own words.
    expect(tagMock).toHaveBeenCalledWith(REPO, TARGET, [repairLabel(TARGET, "dep-missing", T0)]);
    const [[, , written]] = noteMock.mock.calls;
    expect(written).toContain(repairFingerprint(TARGET, "dep-missing"));
    expect(written).toContain(`the schema ${PREREQ} adds has to land first`);
    expect(written.split("\n")).toHaveLength(1);
  });

  it("armed at `shadow`: resolves the prerequisite and draws NO edge (R5.3)", async () => {
    const outcome = await repairDepMissing({
      repoPath: REPO,
      bead: bead(TARGET),
      block: block(`the schema ${PREREQ} adds has to land first`),
      now: T0,
      autonomy: "shadow",
    });

    // The armed answer, minus the writes: the same blocker, so the record says what arming would
    // actually have drawn.
    expect(outcome).toMatchObject({ action: "shadow", blockerId: PREREQ });
    expect(outcome.action === "shadow" && outcome.attempted).toContain(PREREQ);
    expect(linkMock).not.toHaveBeenCalled();
    // No stamp either: nothing holds the target back, so the one repair the guard allows is still
    // available when the operator arms the class.
    expect(tagMock).not.toHaveBeenCalled();
    expect(noteMock).not.toHaveBeenCalled();
  });

  it("armed at `propose`: escalates before it even reads the board", async () => {
    const outcome = await repairDepMissing({
      repoPath: REPO,
      bead: bead(TARGET),
      block: block(`the schema ${PREREQ} adds has to land first`),
      now: T0,
      autonomy: "propose",
    });

    expect(outcome.action).toBe("escalate");
    if (outcome.action !== "escalate") return;
    expect(outcome.why).toContain("not armed to repair");
    expect(linkMock).not.toHaveBeenCalled();
    expect(tagMock).not.toHaveBeenCalled();
  });

  it("creates nothing when the prerequisite is not on the board — it escalates", async () => {
    const outcome = await repairDepMissing({
      repoPath: REPO,
      bead: bead(TARGET),
      block: block("blocked on anton-ghost, which nobody filed"),
      now: T0,
      autonomy: "apply",
    });

    expect(outcome.action).toBe("escalate");
    expect(linkMock).not.toHaveBeenCalled();
    expect(tagMock).not.toHaveBeenCalled();
    if (outcome.action !== "escalate") throw new Error("unreachable");
    expect(refusalNote(outcome)).toContain("did not repair this as `dep-missing`");
    expect(refusalNote(outcome).split("\n")).toHaveLength(1);
  });

  it("escalates an unnamed prerequisite rather than guessing at the board", async () => {
    const outcome = await repairDepMissing({
      repoPath: REPO,
      bead: bead(TARGET),
      block: block(undefined),
      now: T0,
      autonomy: "apply",
    });
    expect(outcome).toMatchObject({
      action: "escalate",
      evidence: [expect.stringContaining("named no prerequisite")],
    });
    expect(linkMock).not.toHaveBeenCalled();
  });

  it("reads the board fresh unless one is handed to it", async () => {
    await repairDepMissing({
      repoPath: REPO,
      bead: bead(TARGET),
      block: block(`blocked on ${PREREQ}`),
      now: T0,
      autonomy: "apply",
      board: board(),
    });
    expect(listMock).not.toHaveBeenCalled();

    await repairDepMissing({
      repoPath: REPO,
      bead: bead(TARGET),
      block: block(`blocked on ${PREREQ}`),
      now: T0,
      autonomy: "apply",
    });
    expect(listMock).toHaveBeenCalledWith(REPO, ["--status", "all"]);
  });

  it("still resolves the prerequisite on a bd that rejects `--status all`", async () => {
    // The flag is unsupported on some bd versions and this read's failure is swallowed by the
    // caller's outer catch — so a direct `bd list --status all` would make every armed repair
    // silently escalate there. `loadAllIssues` merges the open and closed listings instead.
    listMock.mockImplementation(async (_repo, extra) => {
      if (extra?.includes("all")) throw new Error("unknown flag: --status all");
      return extra?.includes("closed") ? [] : board();
    });

    const outcome = await repairDepMissing({
      repoPath: REPO,
      bead: bead(TARGET),
      block: block(`blocked on ${PREREQ}`),
      now: T0,
      autonomy: "apply",
    });

    expect(outcome).toMatchObject({ action: "parked", blockerId: PREREQ });
    expect(linkMock).toHaveBeenCalledWith(REPO, TARGET, PREREQ, "blocks");
  });

  it("KEEPS the edge when only the repair's note fails — the stamp is what the guard reads", async () => {
    noteMock.mockRejectedValueOnce(new Error("bd note: database is locked"));
    const quiet = vi.spyOn(console, "error").mockImplementation(() => {});

    const outcome = await repairDepMissing({
      repoPath: REPO,
      bead: bead(TARGET),
      block: block(`blocked on ${PREREQ}`),
      now: T0,
      autonomy: "apply",
    });

    // Rolling back here would remove the edge while leaving the suppression label behind, so every
    // later `dep-missing` block on this bead is refused as a repair whose edge no longer exists.
    expect(outcome).toMatchObject({ action: "parked", blockerId: PREREQ });
    expect(unlinkMock).not.toHaveBeenCalled();
    quiet.mockRestore();
  });

  it("takes the edge back when the repair cannot be recorded", async () => {
    tagMock.mockRejectedValueOnce(new Error("bd update: database is locked"));

    const outcome = await repairDepMissing({
      repoPath: REPO,
      bead: bead(TARGET),
      block: block(`blocked on ${PREREQ}`),
      now: T0,
      autonomy: "apply",
    });

    expect(linkMock).toHaveBeenCalledWith(REPO, TARGET, PREREQ, "blocks");
    expect(unlinkMock).toHaveBeenCalledWith(REPO, TARGET, PREREQ);
    expect(outcome).toMatchObject({
      action: "escalate",
      evidence: [
        expect.stringContaining("database is locked"),
        expect.stringContaining("taken back"),
      ],
    });
  });

  it("names the edge it could NOT take back, so a human can", async () => {
    tagMock.mockRejectedValueOnce(new Error("bd update: database is locked"));
    unlinkMock.mockRejectedValueOnce(new Error("bd dep remove: database is locked"));

    const outcome = await repairDepMissing({
      repoPath: REPO,
      bead: bead(TARGET),
      block: block(`blocked on ${PREREQ}`),
      now: T0,
      autonomy: "apply",
    });

    expect(outcome).toMatchObject({ action: "escalate" });
    if (outcome.action !== "escalate") throw new Error("unreachable");
    expect(outcome.evidence.join(" ")).toContain(`bd dep remove ${TARGET} ${PREREQ}`);
  });

  it("repairs a bead ONCE: the second dep-missing block escalates with what it already did (R5.6)", async () => {
    const outcome = await repairDepMissing({
      repoPath: REPO,
      bead: alreadyRepaired(`recorded \`${PREREQ}\` as a blocker of ${TARGET}`),
      block: block(`still blocked on ${PREREQ}`),
      now: T0 + 60_000,
      autonomy: "apply",
    });

    expect(outcome.action).toBe("escalate");
    if (outcome.action !== "escalate") throw new Error("unreachable");
    expect(outcome.prior?.klass).toBe("dep-missing");
    expect(outcome.evidence.join(" ")).toContain(`recorded \`${PREREQ}\` as a blocker of ${TARGET}`);
    // The guard is asked BEFORE the board read: a disproved diagnosis costs no bd call to refuse.
    expect(listMock).not.toHaveBeenCalled();
    expect(linkMock).not.toHaveBeenCalled();
  });
});

describe("reversing the edge", () => {
  it("removes it with bd's own undo of the link, and notes why", async () => {
    await revertPrereqEdge(REPO, TARGET, PREREQ, "the operator says the ordering is wrong");

    expect(unlinkMock).toHaveBeenCalledWith(REPO, TARGET, PREREQ);
    expect(noteMock).toHaveBeenCalledWith(
      REPO,
      TARGET,
      reversalNote(PREREQ, "the operator says the ordering is wrong"),
    );
    expect(reversalNote(PREREQ, "x").split("\n")).toHaveLength(1);
  });

  it("leaves the repair STAMP in place, so the reversed edge is not drawn again", async () => {
    await revertPrereqEdge(REPO, TARGET, PREREQ, "wrong ordering");
    expect(tagMock).not.toHaveBeenCalled();

    // And the guard still reads that stamp: the next block of this class escalates.
    const outcome = await repairDepMissing({
      repoPath: REPO,
      bead: alreadyRepaired(),
      block: block(`blocked on ${PREREQ}`),
      now: T0 + 60_000,
      autonomy: "apply",
    });
    expect(outcome.action).toBe("escalate");
    expect(linkMock).not.toHaveBeenCalled();
  });

  it("writes no note when none is given — the write-failure path has nothing to say on the bead", async () => {
    await revertPrereqEdge(REPO, TARGET, PREREQ);
    expect(unlinkMock).toHaveBeenCalledWith(REPO, TARGET, PREREQ);
    expect(noteMock).not.toHaveBeenCalled();
  });
});
