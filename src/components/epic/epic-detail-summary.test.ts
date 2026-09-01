/**
 * The numbers and verdicts the epic detail page renders from. They used to be derived inline in the
 * view, where the only way to check them was to render the page; kept here so the arithmetic (which
 * excludes abandoned tickets) and the action gates are pinned on their own.
 */
import { describe, expect, it } from "vitest";

import { contractStatusOf } from "@/lib/beads/contract";
import type { EpicDetail, Ticket } from "@/lib/types";
import { makeEpic } from "@/components/board/epic.fixture";
import { parseAcceptance, summarizeEpicDetail } from "@/components/epic/epic-detail-summary";

function makeTicket(over: Partial<Ticket> = {}): Ticket {
  return {
    id: "anton-t1",
    title: "Checkpoint the crawl cursor",
    status: "open",
    stage: "backlog",
    assignee: null,
    createdAt: "2026-07-20T00:00:00.000Z",
    createdBy: null,
    deferred: false,
    abandoned: false,
    ...over,
  };
}

function makeDetail(over: Partial<EpicDetail> = {}): EpicDetail {
  return { epic: makeEpic(), tickets: [], edges: [], ...over };
}

describe("parseAcceptance", () => {
  it("reads the checked state off `- [x]` / `- [ ]` markers", () => {
    expect(parseAcceptance("- [x] shipped\n- [ ] pending")).toEqual([
      { text: "shipped", checked: true },
      { text: "pending", checked: false },
    ]);
  });

  it("takes an unmarked bullet as an unchecked item, and drops blank lines", () => {
    expect(parseAcceptance("* plain bullet\n\n  bare line  ")).toEqual([
      { text: "plain bullet", checked: false },
      { text: "bare line", checked: false },
    ]);
  });
});

describe("summarizeEpicDetail", () => {
  it("counts done / in-progress / to-do against the non-abandoned tickets only", () => {
    const summary = summarizeEpicDetail(
      makeDetail({
        tickets: [
          makeTicket({ id: "t-1", stage: "done" }),
          makeTicket({ id: "t-2", stage: "implementing" }),
          makeTicket({ id: "t-3", stage: "backlog" }),
          makeTicket({ id: "t-4", stage: "done", abandoned: true }),
        ],
      }),
    );

    // The abandoned ticket is out of the denominator — it was never delivered, so it can't count as
    // done, and leaving it in would quietly shrink the epic's completion.
    expect(summary).toMatchObject({
      total: 3,
      done: 1,
      inProgress: 1,
      todo: 1,
      abandoned: 1,
      pct: 33,
      inProgressPct: 33,
    });
  });

  it("names the bead's own type rather than calling every run target an epic", () => {
    expect(summarizeEpicDetail(makeDetail({ epic: makeEpic({ type: "task" }) })).word).toBe("task");
    expect(summarizeEpicDetail(makeDetail()).word).toBe("feature");
  });

  it("blocks the run action on the same blocking violations approve refuses", () => {
    // Judged by the shared validator, so the page gates on exactly what the approve route enforces.
    const contract = contractStatusOf({
      id: "anton-1",
      title: "Resumable crawl checkpoints",
      status: "open",
      issue_type: "feature",
      created_at: "2026-07-20T00:00:00.000Z",
      description: "## Goal\nG\n\n## Context\nC\n\n## Out of scope\nO\n\n## Verify\nV",
    });
    const summary = summarizeEpicDetail(makeDetail({ epic: makeEpic({ contract }) }));

    expect(summary.contractBlocked).toBe(true);
    expect(summary.blocking.map((v) => v.message).join(" ")).toContain("Acceptance");
  });

  it("offers rework only once a live target has work a run has already produced", () => {
    const tickets = [makeTicket()];
    const rework = (over: Parameters<typeof makeEpic>[0], ts: Ticket[] = tickets) =>
      summarizeEpicDetail(makeDetail({ epic: makeEpic(over), tickets: ts })).canRework;

    expect(rework({ stage: "in-review" })).toBe(true);
    // Nothing has run yet, nothing to send back.
    expect(rework({ stage: "backlog" })).toBe(false);
    expect(rework({ stage: "in-review" }, [])).toBe(false);
    // An abandoned target has no work to redo.
    expect(rework({ stage: "in-review", abandoned: true })).toBe(false);
  });
});
