import { describe, expect, it } from "vitest";

import { runOutcomeMessage } from "@/components/epic/use-epic-detail";

describe("runOutcomeMessage", () => {
  it("says a forced run is a re-run, whatever pacing it was given", () => {
    // Force run only appears on an implementing target: the job resumes, it does not start.
    expect(runOutcomeMessage({ force: true, immediate: true, title: "Loose task" })).toBe(
      'Re-running "Loose task"',
    );
  });

  it("distinguishes running now from queuing for the budget governor", () => {
    expect(runOutcomeMessage({ immediate: true, title: "Loose task" })).toBe(
      'Run started for "Loose task"',
    );
    expect(runOutcomeMessage({ immediate: false, title: "Loose task" })).toBe(
      'Queued "Loose task" for optimal usage',
    );
  });
});
