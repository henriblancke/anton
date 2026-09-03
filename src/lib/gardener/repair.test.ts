/**
 * The auto-repair loop guard (anton-rys7 / R5.6, R5.8).
 *
 * Five claims, and each is a way an unattended repair pass could do real harm:
 *   • NOTHING WRITES UNARMED. A class the project has not armed escalates without touching the
 *     board, and a class armed at `shadow` records the move rather than making it (R5.3).
 *   • ONE REPAIR PER (BEAD, CLASS). The second identical block escalates instead of spending another
 *     run on a diagnosis that has already been disproved.
 *   • THE GUARD READS THE BOARD, NOT MEMORY. Everything it decides on is a label the bead carries, so
 *     a restart between the repair and the next block changes nothing.
 *   • THE ESCALATION CARRIES THE CASE. What anton attempted, and why it did not help.
 *   • A FAILED REPAIR COUNTS DOUBLE — and only failures that actually FOLLOWED one.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { formatHumanNote } from "../beads/notes";

const tagMock = vi.fn<(repo: string, id: string, labels: string[]) => Promise<string>>(async () => "");
const noteMock = vi.fn<(repo: string, id: string, text: string) => Promise<string>>(async () => "");

vi.mock("../beads/bd", async () => {
  const actual = await vi.importActual<typeof import("../beads/bd")>("../beads/bd");
  return { ...actual, beads: { ...actual.beads, tag: tagMock, note: noteMock } };
});

const {
  FAILED_REPAIR_WEIGHT,
  REPAIR_CLASSES,
  decideRepair,
  isRepairClass,
  priorRepair,
  recordRepair,
  repairAttemptsOf,
  repairFingerprint,
  repairLabel,
  repairNote,
  repairedFailureWeight,
  shadowNote,
} = await import("./repair");

const REPO = "/repo";
const BEAD = "anton-a1b2";
const T0 = Date.UTC(2026, 7, 20, 12, 0, 0);

/** A bead as the board hands it back, carrying whatever a past repair stamped on it. */
function bead(labels: string[] = [], notes?: string) {
  return { id: BEAD, labels, ...(notes === undefined ? {} : { notes }) };
}

/** The bead exactly as a repair leaves it — the label and the note, in one value. */
function repaired(klass: "ref-stale" | "dep-missing", attempted: string, at = T0) {
  return bead(
    [repairLabel(BEAD, klass, at), "domain:eng"],
    repairNote(repairFingerprint(BEAD, klass), attempted),
  );
}

beforeEach(() => {
  tagMock.mockClear();
  noteMock.mockClear();
});

describe("the repairable classes", () => {
  it("are matched exactly — a prefix of one is not one", () => {
    expect(REPAIR_CLASSES.every(isRepairClass)).toBe(true);
    for (const notAClass of ["ref", "env", "other", "REF-STALE", "ref-stale-ish", "", undefined]) {
      expect(isRepairClass(notAClass)).toBe(false);
    }
  });
});

describe("decideRepair", () => {
  it("repairs a class anton knows, on a bead nothing has been done to", () => {
    const decision = decideRepair(bead(), "ref-stale", { reason: "src/a.ts is gone" }, "apply");
    expect(decision).toEqual({
      action: "repair",
      klass: "ref-stale",
      fingerprint: repairFingerprint(BEAD, "ref-stale"),
    });
  });

  it("escalates a class it does not repair rather than guessing at one", () => {
    for (const klass of ["env", "other", "ref", undefined]) {
      const decision = decideRepair(bead(), klass, { reason: "toolchain will not install" }, "apply");
      expect(decision.action).toBe("escalate");
      if (decision.action !== "escalate") return;
      expect(decision.prior).toBeUndefined();
      expect(decision.why).toContain("does not repair");
    }
  });

  it("escalates the SECOND identical block instead of repairing again", () => {
    const subject = repaired("ref-stale", "rewrote the pointer src/a.ts → src/moved/a.ts");
    const decision = decideRepair(subject, "ref-stale", { reason: "src/moved/a.ts is gone too" }, "apply");

    expect(decision.action).toBe("escalate");
    if (decision.action !== "escalate") return;
    expect(decision.prior?.fingerprint).toBe(repairFingerprint(BEAD, "ref-stale"));
    expect(decision.why).toContain("again after anton already repaired it");
  });

  it("carries what was attempted and why it did not help", () => {
    const subject = repaired("ref-stale", "rewrote the pointer src/a.ts → src/moved/a.ts");
    const decision = decideRepair(subject, "ref-stale", { reason: "src/moved/a.ts is gone too" }, "apply");
    if (decision.action !== "escalate") throw new Error("expected an escalation");

    const evidence = decision.evidence.join("\n");
    expect(evidence).toContain("rewrote the pointer src/a.ts → src/moved/a.ts");
    expect(evidence).toContain("src/moved/a.ts is gone too");
    expect(evidence).toContain(repairFingerprint(BEAD, "ref-stale"));
  });

  it("still escalates when the note behind the repair is gone — the LABEL is the guard", () => {
    const subject = bead([repairLabel(BEAD, "ref-stale", T0)], "anton: run failed after 3 attempts");
    const decision = decideRepair(subject, "ref-stale", { reason: "still stale" }, "apply");

    expect(decision.action).toBe("escalate");
    if (decision.action !== "escalate") return;
    expect(decision.evidence.join("\n")).toContain("was not recorded on the bead");
  });

  it("is per (bead, class) — a different class on a repaired bead still repairs", () => {
    const subject = repaired("ref-stale", "rewrote the pointer");
    expect(decideRepair(subject, "dep-missing", {}, "apply").action).toBe("repair");
  });

  it("escalates a class this project has not armed, and says how to arm it (R5.3)", () => {
    const decision = decideRepair(bead(), "ref-stale", { reason: "src/a.ts is gone" }, "propose");

    expect(decision.action).toBe("escalate");
    if (decision.action !== "escalate") return;
    expect(decision.prior).toBeUndefined();
    expect(decision.why).toContain("not armed to repair");
    const evidence = decision.evidence.join("\n");
    expect(evidence).toContain("src/a.ts is gone");
    expect(evidence).toContain("`propose`");
    expect(evidence).toContain("`apply`");
  });

  it("shadows a class armed at `shadow` — the same identity, no write", () => {
    const decision = decideRepair(bead(), "ref-stale", { reason: "src/a.ts is gone" }, "shadow");
    expect(decision).toEqual({
      action: "shadow",
      klass: "ref-stale",
      fingerprint: repairFingerprint(BEAD, "ref-stale"),
    });
  });

  it("holds the loop guard against a SHADOW too — a disproved diagnosis is not re-described", () => {
    const subject = repaired("ref-stale", "rewrote the pointer src/a.ts → src/moved/a.ts");
    for (const level of ["shadow", "apply"] as const) {
      expect(decideRepair(subject, "ref-stale", { reason: "still stale" }, level).action).toBe(
        "escalate",
      );
    }
  });

  it("names the missing reason rather than printing nothing", () => {
    const decision = decideRepair(repaired("dep-missing", "drew anton-b blocks anton-a"), "dep-missing", {}, "apply");
    if (decision.action !== "escalate") throw new Error("expected an escalation");
    expect(decision.evidence.join("\n")).toContain("no reason given");
  });
});

describe("the stamp on the bead", () => {
  it("writes the guard first and the reasoning second", async () => {
    const label = await recordRepair(REPO, bead(), "ref-stale", "rewrote src/a.ts → src/b.ts", T0);

    expect(label).toBe(repairLabel(BEAD, "ref-stale", T0));
    expect(tagMock).toHaveBeenCalledWith(REPO, BEAD, [label]);
    expect(noteMock).toHaveBeenCalledWith(
      REPO,
      BEAD,
      `anton: repaired \`${repairFingerprint(BEAD, "ref-stale")}\` — rewrote src/a.ts → src/b.ts`,
    );
    expect(tagMock.mock.invocationCallOrder[0]!).toBeLessThan(noteMock.mock.invocationCallOrder[0]!);
  });

  it("keeps a stamped repair when only its note fails to write", async () => {
    // The label is already durable at that point, so rejecting would hand the caller a failed
    // outcome it rolls back — leaving the bead suppressed for a repair that no longer exists.
    noteMock.mockRejectedValueOnce(new Error("bd note: database is locked"));
    const quiet = vi.spyOn(console, "error").mockImplementation(() => {});

    const label = await recordRepair(REPO, bead(), "dep-missing", "drew anton-b blocks anton-a", T0);

    expect(label).toBe(repairLabel(BEAD, "dep-missing", T0));
    expect(tagMock).toHaveBeenCalledWith(REPO, BEAD, [label]);
    expect(quiet).toHaveBeenCalled();
    quiet.mockRestore();
  });

  it("still rejects when the STAMP itself fails — nothing suppressed, so nothing to keep", async () => {
    tagMock.mockRejectedValueOnce(new Error("bd tag: database is locked"));
    await expect(recordRepair(REPO, bead(), "dep-missing", "drew the edge", T0)).rejects.toThrow(
      "bd tag",
    );
    expect(noteMock).not.toHaveBeenCalled();
  });

  it("survives the round trip through the board — a later pass reads it back and escalates", async () => {
    await recordRepair(REPO, bead(), "dep-missing", "drew anton-b blocks anton-a, parked anton-a", T0);
    const [, , labels] = tagMock.mock.calls[0]!;
    const [, , note] = noteMock.mock.calls[0]!;

    // The bead as a FRESH process reads it: nothing but what bd stored.
    const reread = bead(labels, note);
    const attempt = priorRepair(reread, "dep-missing");
    expect(attempt).toMatchObject({
      klass: "dep-missing",
      at: T0,
      attempted: "drew anton-b blocks anton-a, parked anton-a",
    });
    expect(decideRepair(reread, "dep-missing", { reason: "still blocked" }, "apply").action).toBe("escalate");
  });

  it("records a shadow WITHOUT the fingerprint — the guard must stay free for a real repair", () => {
    const note = shadowNote("ref-stale", "rewrote src/a.ts → src/b.ts");

    expect(note).toContain("did not repair this as `ref-stale`");
    expect(note).toContain("`shadow`");
    expect(note).toContain("rewrote src/a.ts → src/b.ts");
    // The fingerprint is the suppression, and nothing happened — a shadow note that carried one
    // would read back through `repairAttemptsOf` as a repair the labels never recorded.
    expect(note).not.toContain(repairFingerprint(BEAD, "ref-stale"));
    expect(note.split("\n")).toHaveLength(1);
  });

  it("flattens a multi-line reason so the notes blob stays one note per line", () => {
    const note = repairNote(repairFingerprint(BEAD, "ref-stale"), "rewrote\n  the\n  pointer");
    expect(note.split("\n")).toHaveLength(1);
    expect(note).toContain("rewrote the pointer");
  });

  it("reads its own note out of a blob a human has also written to", () => {
    const notes = [
      formatHumanNote("try the other path", "Henri", new Date(T0)),
      repairNote(repairFingerprint(BEAD, "ref-stale"), "rewrote src/a.ts → src/b.ts"),
    ].join("\n");
    expect(priorRepair(bead([repairLabel(BEAD, "ref-stale", T0)], notes), "ref-stale")).toMatchObject(
      { attempted: "rewrote src/a.ts → src/b.ts" },
    );
  });

  it("ignores labels that only look like a stamp", () => {
    const notAStamp = ["repair:ref-stale:nothex000000:1", "repair:ref-stale:aaaaaaaaaaaa", "repairish"];
    expect(repairAttemptsOf(bead(notAStamp))).toEqual([]);
  });
});

describe("repairedFailureWeight", () => {
  const run = (over: Record<string, unknown> = {}) =>
    ({
      id: "r1",
      epicBeadId: BEAD,
      status: "failed",
      startedAt: Math.floor(T0 / 1000) + 60,
      ...over,
    }) as Parameters<ReturnType<typeof repairedFailureWeight>>[0];

  it("counts a failure that FOLLOWED a repair double", () => {
    const weigh = repairedFailureWeight([repaired("ref-stale", "rewrote the pointer")]);
    expect(weigh(run())).toBe(FAILED_REPAIR_WEIGHT);
  });

  it("counts the block that PROVOKED the repair once", () => {
    const weigh = repairedFailureWeight([repaired("ref-stale", "rewrote the pointer")]);
    expect(weigh(run({ startedAt: Math.floor(T0 / 1000) - 600 }))).toBe(1);
  });

  it("weighs a repair stamped inside the attempt's own start second once", () => {
    // The run's start is stored whole-second and the stamp keeps milliseconds, so a repair anywhere
    // in that second could equally have come after the attempt began — it is not evidence.
    const weigh = repairedFailureWeight([repaired("ref-stale", "rewrote the pointer", T0 + 900)]);
    expect(weigh(run({ startedAt: Math.floor(T0 / 1000) }))).toBe(1);
  });

  it("finds the repair on the TICKET a grouped run stopped inside", () => {
    const weigh = repairedFailureWeight([repaired("ref-stale", "rewrote the pointer")]);
    expect(weigh(run({ epicBeadId: "anton-epic", ticketBeadId: BEAD }))).toBe(FAILED_REPAIR_WEIGHT);
  });

  it("weighs a run with no recorded start plainly rather than guessing", () => {
    const weigh = repairedFailureWeight([repaired("ref-stale", "rewrote the pointer")]);
    expect(weigh(run({ startedAt: undefined }))).toBe(1);
  });

  it("leaves an unrepaired board weighing every failure once", () => {
    expect(repairedFailureWeight([bead(["domain:eng"])])(run())).toBe(1);
  });

  describe("once the repaired bead has DELIVERED", () => {
    /** Seconds, as the run rows carry them. */
    const sec = (ms: number) => Math.floor(ms / 1000);
    const deliveries = (...at: number[]) => new Map([[BEAD, at.map(sec)]]);

    it("stops weighing a failure double — the delivery answered the repair", () => {
      // Repaired at T0, delivered a minute later, reopened for rework and failed again. The
      // intervening delivery proved the repair; the rework failure is a new story.
      const weigh = repairedFailureWeight(
        [repaired("ref-stale", "rewrote the pointer")],
        deliveries(T0 + 60_000),
      );
      expect(weigh(run({ startedAt: sec(T0) + 600 }))).toBe(1);
    });

    it("still counts a repair stamped SINCE that delivery", () => {
      const bead = repaired("ref-stale", "rewrote the pointer");
      bead.labels.push(repairLabel(BEAD, "dep-missing", T0 + 120_000));
      const weigh = repairedFailureWeight([bead], deliveries(T0 + 60_000));
      expect(weigh(run({ startedAt: sec(T0) + 600 }))).toBe(FAILED_REPAIR_WEIGHT);
    });

    it("ignores a delivery the attempt did not follow", () => {
      // The bead delivered after this attempt began — a later run's evidence, not this one's.
      const weigh = repairedFailureWeight(
        [repaired("ref-stale", "rewrote the pointer")],
        deliveries(T0 + 900_000),
      );
      expect(weigh(run({ startedAt: sec(T0) + 60 }))).toBe(FAILED_REPAIR_WEIGHT);
    });

    it("spends the repair on a delivery in the repair's own second, which may have followed it", () => {
      // Whole-second delivery, millisecond stamp: the delivery could have come after the repair, so
      // the ambiguous second goes to weight 1 — the same cheaper error the repair's fence takes.
      const weigh = repairedFailureWeight(
        [repaired("ref-stale", "rewrote the pointer", T0 + 400)],
        deliveries(T0),
      );
      expect(weigh(run({ startedAt: sec(T0) + 600 }))).toBe(1);
    });

    it("says nothing about a different bead's deliveries", () => {
      const weigh = repairedFailureWeight(
        [repaired("ref-stale", "rewrote the pointer")],
        new Map([["anton-other", [sec(T0 + 60_000)]]]),
      );
      expect(weigh(run({ startedAt: sec(T0) + 600 }))).toBe(FAILED_REPAIR_WEIGHT);
    });
  });
});
