/**
 * Unit tests for the review-fix-rounds PR-body region content (anton-te6nr): building a round from
 * the fixer's own per-thread report, round-tripping the region's rendered text back into rounds,
 * and capping accumulated rounds. The gh read/write orchestration around this is covered by
 * review-fix-body.integration.test.ts.
 */
import { describe, expect, it } from "vitest";
import { BODY_REGION_END, BODY_REGION_START } from "./steps/prompts";
import {
  extractFixRoundsRegion,
  fixRoundFrom,
  nextFixRoundsRegion,
  parseDroppedCount,
  parseFixRounds,
  renderFixRounds,
  type FixRound,
} from "./review-fix-body";
import type { ThreadOutcome } from "./review-fix-context";

const now = new Date("2026-09-23T12:00:00Z");

describe("fixRoundFrom", () => {
  it("renders a round from a thread report, one line per fixed thread", () => {
    const report: ThreadOutcome[] = [
      { id: "RT_1", outcome: "fixed", reply: "renamed foo to bar" },
      { id: "RT_2", outcome: "fixed", reply: "added the missing null check" },
    ];

    expect(fixRoundFrom(report, true, now)).toEqual({
      date: "2026-09-23",
      fixed: ["renamed foo to bar", "added the missing null check"],
    });
  });

  it("falls back to naming the thread when a fixed outcome carries no reply", () => {
    const report: ThreadOutcome[] = [{ id: "RT_1", outcome: "fixed" }];
    expect(fixRoundFrom(report, true, now)).toEqual({ date: "2026-09-23", fixed: ["thread RT_1"] });
  });

  it("an empty report renders nothing", () => {
    expect(fixRoundFrom([], true, now)).toBeUndefined();
  });

  it("excludes left/needs-human outcomes — only what was fixed is named", () => {
    const report: ThreadOutcome[] = [
      { id: "RT_1", outcome: "left", reply: "not worth changing" },
      { id: "RT_2", outcome: "needs-human", reply: "founder call" },
    ];
    expect(fixRoundFrom(report, true, now)).toBeUndefined();
  });

  it("excludes a fabricated fix — a 'fixed' claim with nothing pushed, same rule applyThreadOutcomes uses", () => {
    const report: ThreadOutcome[] = [{ id: "RT_1", outcome: "fixed", reply: "renamed foo to bar" }];
    expect(fixRoundFrom(report, false, now)).toBeUndefined();
  });

  it("keeps genuinely-fixed threads alongside an excluded fabricated one", () => {
    const report: ThreadOutcome[] = [
      { id: "RT_1", outcome: "fixed", reply: "real fix" },
      { id: "RT_2", outcome: "left", reply: "declined" },
    ];
    // pushed=true here, so RT_1 is not fabricated.
    expect(fixRoundFrom(report, true, now)).toEqual({ date: "2026-09-23", fixed: ["real fix"] });
  });

  it("falls back to the verdict reasons when a pushed round carries no thread report", () => {
    // e.g. a run triggered solely by a failing check or merge conflict, which emits no reporting
    // contract at all — `report` comes back empty even though a real fix pushed.
    expect(fixRoundFrom([], true, now, ["failing checks: claude-review"])).toEqual({
      date: "2026-09-23",
      fixed: ["failing checks: claude-review"],
    });
  });

  it("prefers the thread report over the fallback reasons when both are present", () => {
    const report: ThreadOutcome[] = [{ id: "RT_1", outcome: "fixed", reply: "real fix" }];
    expect(fixRoundFrom(report, true, now, ["failing checks: claude-review"])).toEqual({
      date: "2026-09-23",
      fixed: ["real fix"],
    });
  });

  it("does not fall back to reasons when nothing pushed — a fabrication either way", () => {
    expect(fixRoundFrom([], false, now, ["failing checks: claude-review"])).toBeUndefined();
  });

  it("strips a quoted region marker out of a thread reply so it can't plant a nested marker", () => {
    const report: ThreadOutcome[] = [
      {
        id: "RT_1",
        outcome: "fixed",
        reply: `quoted the reviewer's own ${BODY_REGION_START} marker verbatim`,
      },
    ];
    const round = fixRoundFrom(report, true, now);
    expect(round?.fixed[0]).not.toContain(BODY_REGION_START);
  });

  it("strips a quoted region marker out of a fallback reason", () => {
    const round = fixRoundFrom([], true, now, [`reason quoting ${BODY_REGION_END}`]);
    expect(round?.fixed[0]).not.toContain(BODY_REGION_END);
  });

  it("flattens an embedded newline so it can't masquerade as a continuation round", () => {
    const report: ThreadOutcome[] = [
      { id: "RT_1", outcome: "fixed", reply: "fixed the bug\n- 2026-01-01: fake round" },
    ];
    const round = fixRoundFrom(report, true, now);
    expect(round?.fixed[0]).toBe("fixed the bug - 2026-01-01: fake round");
  });

  it("does not fall back to reasons when the report is nonempty but nothing was fixed", () => {
    // A report that only declined threads (left/needs-human) means the fixer looked and fixed
    // nothing — the verdict's reasons must not be misreported as what got fixed.
    const report: ThreadOutcome[] = [{ id: "RT_1", outcome: "left", reply: "not worth changing" }];
    expect(fixRoundFrom(report, true, now, ["failing checks: claude-review"])).toBeUndefined();
  });
});

describe("renderFixRounds / parseFixRounds round-trip", () => {
  it("renders one dated line per round, oldest first", () => {
    const rounds: FixRound[] = [
      { date: "2026-09-20", fixed: ["fixed A"] },
      { date: "2026-09-21", fixed: ["fixed B", "fixed C"] },
    ];
    const rendered = renderFixRounds(rounds);
    expect(rendered).toBe(
      ["### Review-fix rounds", "", "- 2026-09-20: fixed A", "- 2026-09-21: fixed B; fixed C"].join(
        "\n",
      ),
    );
  });

  it("renders nothing for an empty round list", () => {
    expect(renderFixRounds([])).toBe("");
  });

  it("round-trips through parseFixRounds", () => {
    const rounds: FixRound[] = [
      { date: "2026-09-20", fixed: ["fixed A"] },
      { date: "2026-09-21", fixed: ["fixed B", "fixed C"] },
    ];
    expect(parseFixRounds(renderFixRounds(rounds))).toEqual(rounds);
  });

  it("parses nothing out of undefined/empty content", () => {
    expect(parseFixRounds(undefined)).toEqual([]);
    expect(parseFixRounds("")).toEqual([]);
  });

  it("caps at the round limit — the oldest are dropped with a marker saying so", () => {
    const rounds: FixRound[] = Array.from({ length: 25 }, (_, i) => ({
      date: `2026-09-${String(i + 1).padStart(2, "0")}`,
      fixed: [`fixed round ${i + 1}`],
    }));

    const rendered = renderFixRounds(rounds);

    expect(rendered).toContain("… 5 earlier rounds dropped");
    expect(rendered).not.toContain("fixed round 1\n"); // the oldest 5 (1..5) were dropped
    expect(rendered).not.toContain("2026-09-05");
    expect(rendered).toContain("2026-09-06"); // the 20 most recent survive
    expect(rendered).toContain("2026-09-25");

    // The dropped-rounds marker itself does not round-trip back into a fake round.
    expect(parseFixRounds(rendered)).toHaveLength(20);
  });

  it("singular wording for exactly one dropped round", () => {
    const rounds: FixRound[] = Array.from({ length: 21 }, (_, i) => ({
      date: `2026-09-${String(i + 1).padStart(2, "0")}`,
      fixed: [`fixed round ${i + 1}`],
    }));
    expect(renderFixRounds(rounds)).toContain("… 1 earlier round dropped");
  });

  it("accumulates the dropped count across repeated cap-crossings instead of resetting to 1", () => {
    // Simulate the region already carrying a "1 earlier round dropped" marker (21 rounds seen once
    // before), then adding one more round via the full nextFixRoundsRegion pipeline.
    const rounds: FixRound[] = Array.from({ length: 21 }, (_, i) => ({
      date: `2026-09-${String(i + 1).padStart(2, "0")}`,
      fixed: [`fixed round ${i + 1}`],
    }));
    const priorRegion = renderFixRounds(rounds);
    expect(priorRegion).toContain("… 1 earlier round dropped");

    const body = `${BODY_REGION_START}\n${priorRegion}\n${BODY_REGION_END}`;
    const report: ThreadOutcome[] = [{ id: "RT_1", outcome: "fixed", reply: "fixed round 22" }];
    const next = nextFixRoundsRegion(body, report, true, new Date("2026-10-01T00:00:00Z"));

    expect(next).toContain("… 2 earlier rounds dropped");
    expect(next).not.toContain("fixed round 2\n"); // round 2 is now dropped too
    expect(next).toContain("fixed round 22"); // the newest round survives
  });

  it("pre-fits to the char budget by dropping further oldest rounds, with an accurate count", () => {
    // Well under MAX_ROUNDS (20), but each entry is long enough that the round-count cap alone
    // doesn't keep the region under MAX_BODY_REGION_CHARS.
    const rounds: FixRound[] = Array.from({ length: 5 }, (_, i) => ({
      date: `2026-09-1${i}`,
      fixed: ["x".repeat(1000)],
    }));

    const rendered = renderFixRounds(rounds);

    expect(rendered.length).toBeLessThanOrEqual(4000);
    expect(rendered).toMatch(/… \d+ earlier rounds? dropped/);
    expect(parseFixRounds(rendered).length).toBeLessThan(rounds.length);
  });

  it("truncates rather than drops the newest round when it alone exceeds the char budget", () => {
    // An oversized newest round used to make the pre-fit loop shift rounds off until `capped` was
    // empty, silently dropping the just-pushed fix with no trace and no chance for
    // `upsertBodyRegion`'s own hard-truncation fallback to run (PR #321 review).
    const oldRound: FixRound = { date: "2026-09-01", fixed: ["an earlier, unremarkable fix"] };
    const newestRound: FixRound = { date: "2026-09-23", fixed: ["x".repeat(5000)] };

    const rendered = renderFixRounds([oldRound, newestRound]);

    expect(rendered.length).toBeLessThanOrEqual(4000);
    expect(rendered).toContain("2026-09-23"); // newest round survives, even truncated
    expect(rendered).not.toContain("2026-09-01"); // the old round is dropped to make room
  });

  it("carries the char-truncation dropped count forward across a refresh, even once the region shrinks back under budget", () => {
    // A region that previously had to drop long rounds to fit the char cap, then gets a new, short
    // round appended — the retained tail plus the new round now easily fit under the cap. The
    // dropped-count marker must still say rounds were lost rather than silently disappearing and
    // making the remaining history look complete (PR #321 review).
    const longRounds: FixRound[] = Array.from({ length: 5 }, (_, i) => ({
      date: `2026-09-1${i}`,
      fixed: ["x".repeat(1000)],
    }));
    const priorRegion = renderFixRounds(longRounds);
    const priorDropped = parseDroppedCount(priorRegion);
    expect(priorDropped).toBeGreaterThan(0);

    const body = `${BODY_REGION_START}\n${priorRegion}\n${BODY_REGION_END}`;
    const report: ThreadOutcome[] = [{ id: "RT_1", outcome: "fixed", reply: "short fix" }];
    const next = nextFixRoundsRegion(body, report, true, new Date("2026-10-01T00:00:00Z"));

    expect(next).toBeDefined();
    expect(parseDroppedCount(next)).toBeGreaterThanOrEqual(priorDropped);
    expect(next).toContain("short fix");
  });
});

describe("extractFixRoundsRegion", () => {
  it("extracts the region's content from a full body", () => {
    const body = `Narrative.\n\n${BODY_REGION_START}\n### Review-fix rounds\n\n- 2026-09-20: fixed A\n${BODY_REGION_END}\n\n🤖 footer`;
    expect(extractFixRoundsRegion(body)).toBe("### Review-fix rounds\n\n- 2026-09-20: fixed A");
  });

  it("returns undefined for a body with no region yet", () => {
    expect(extractFixRoundsRegion("Just a narrative, no region.")).toBeUndefined();
    expect(extractFixRoundsRegion(undefined)).toBeUndefined();
  });

  it("returns undefined for a malformed/partial marker pair rather than guessing", () => {
    expect(extractFixRoundsRegion(`only ${BODY_REGION_START} here`)).toBeUndefined();
    expect(extractFixRoundsRegion(`only ${BODY_REGION_END} here`)).toBeUndefined();
  });

  it("treats markers merely quoted in prose as no region, even with a dated bullet between them", () => {
    // Same trap `upsertBodyRegion` already guards against (PR #321 review): a review comment that
    // quotes both marker strings inline, with unrelated human-authored text — including something
    // that happens to look like a dated round — sitting between them. A plain substring search
    // would mine that prose as if it were real history; only a standalone-line match may do so.
    const body = [
      "Narrative discussing the region mechanics.",
      `As discussed, the region uses ${BODY_REGION_START} and includes lines like`,
      "- 2026-09-20: this is just an example in the comment, not a real round",
      `before the ${BODY_REGION_END} marker.`,
    ].join("\n");

    expect(extractFixRoundsRegion(body)).toBeUndefined();
  });
});

describe("nextFixRoundsRegion", () => {
  it("appends this round to the rounds already in the body's region", () => {
    const body = `Narrative.\n\n${BODY_REGION_START}\n### Review-fix rounds\n\n- 2026-09-20: fixed A\n${BODY_REGION_END}`;
    const report: ThreadOutcome[] = [{ id: "RT_1", outcome: "fixed", reply: "fixed B" }];

    const next = nextFixRoundsRegion(body, report, true, new Date("2026-09-21T00:00:00Z"));

    expect(next).toBe(
      ["### Review-fix rounds", "", "- 2026-09-20: fixed A", "- 2026-09-21: fixed B"].join("\n"),
    );
  });

  it("starts a fresh region when the body carries none yet", () => {
    const report: ThreadOutcome[] = [{ id: "RT_1", outcome: "fixed", reply: "fixed A" }];
    const next = nextFixRoundsRegion(undefined, report, true, now);
    expect(next).toBe(["### Review-fix rounds", "", "- 2026-09-23: fixed A"].join("\n"));
  });

  it("an empty report renders nothing, regardless of the body's existing rounds", () => {
    const body = `${BODY_REGION_START}\n### Review-fix rounds\n\n- 2026-09-20: fixed A\n${BODY_REGION_END}`;
    expect(nextFixRoundsRegion(body, [], true, now)).toBeUndefined();
  });

  it("a fabricated fix (nothing pushed) renders nothing to add", () => {
    const report: ThreadOutcome[] = [{ id: "RT_1", outcome: "fixed", reply: "would-be fix" }];
    expect(nextFixRoundsRegion(undefined, report, false, now)).toBeUndefined();
  });

  it("falls back to the verdict reasons when a pushed round has no thread report at all", () => {
    const next = nextFixRoundsRegion(undefined, [], true, now, ["failing checks: claude-review"]);
    expect(next).toBe(
      ["### Review-fix rounds", "", "- 2026-09-23: failing checks: claude-review"].join("\n"),
    );
  });
});
