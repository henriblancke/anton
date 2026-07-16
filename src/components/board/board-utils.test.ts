import { describe, expect, it } from "vitest";
import {
  STAGE_ACCENT_DOT,
  STAGE_LABELS,
  moveEpicBetweenColumns,
} from "@/components/board/board-utils";
import { STAGES, type Epic, type Stage } from "@/lib/types";

describe("STAGE_LABELS", () => {
  it("has a human label for every stage", () => {
    for (const stage of STAGES) {
      expect(STAGE_LABELS[stage]).toBeTruthy();
    }
  });
});

describe("STAGE_ACCENT_DOT", () => {
  it("has an accent class for every stage", () => {
    for (const stage of STAGES) {
      expect(STAGE_ACCENT_DOT[stage]).toBeTruthy();
    }
  });
});

describe("moveEpicBetweenColumns", () => {
  function makeColumns(): Record<Stage, Epic[]> {
    return {
      backlog: [
        {
          id: "e1",
          title: "Epic 1",
          approved: false,
          stage: "backlog",
          assignee: null,
          createdAt: "",
          createdBy: null,
          tickets: [],
        },
      ],
      implementing: [],
      "in-review": [],
      done: [],
    };
  }

  it("moves the epic to the target stage and updates its stage field", () => {
    const next = moveEpicBetweenColumns(makeColumns(), "e1", "implementing");
    expect(next.backlog).toEqual([]);
    expect(next.implementing).toHaveLength(1);
    expect(next.implementing[0]).toMatchObject({ id: "e1", stage: "implementing" });
  });

  it("is a no-op when the epic id doesn't exist", () => {
    const columns = makeColumns();
    const next = moveEpicBetweenColumns(columns, "missing", "done");
    expect(next).toEqual(columns);
  });

  it("prepends the moved epic in the destination column", () => {
    const columns = makeColumns();
    columns.done.push({
      id: "e2",
      title: "Epic 2",
      approved: true,
      stage: "done",
      assignee: null,
      createdAt: "",
      createdBy: null,
      tickets: [],
    });
    const next = moveEpicBetweenColumns(columns, "e1", "done");
    expect(next.done.map((e) => e.id)).toEqual(["e1", "e2"]);
  });
});
