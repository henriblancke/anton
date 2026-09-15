/**
 * Unit tests for classifyFindingClass (anton-oqzc) — a pure, model-free mapping from a
 * ReviewFinding's note text to a coarse class label. Notes below are drawn in style from the kind
 * of finding chatgpt-codex-connector and claude review bots actually leave (the audit this ticket
 * cites), not synthesized to game the regex.
 */
import { describe, expect, it } from "vitest";
import { classifyFindingClass } from "./finding-class";
import type { ReviewFinding } from "./review-context";

function finding(note: string): ReviewFinding {
  return { severity: "blocking", location: "src/lib/jobs/runner.ts:120", note };
}

describe("classifyFindingClass", () => {
  it("classifies a TOCTOU / fencing finding", () => {
    const note =
      "This is a classic TOCTOU: the lease is read, then written back several lines later without " +
      "holding the lock, so another worker can race with this update between the check and the write.";
    expect(classifyFindingClass(finding(note))).toBe("fencing-toctou");
  });

  it("classifies a cancellation-after-await finding", () => {
    const note =
      "The request continues after the abort signal fires — this code ignores the AbortSignal and " +
      "keeps writing to the response after cancellation, leaving an orphaned task running in the background.";
    expect(classifyFindingClass(finding(note))).toBe("cancellation");
  });

  it("classifies a fail-open finding", () => {
    const note =
      "When the permission check throws, the catch block swallows the error and proceeds as if the " +
      "user were authorized — this fails open instead of denying access on an unexpected error.";
    expect(classifyFindingClass(finding(note))).toBe("fail-open");
  });

  it("classifies a work-loss-on-error-path finding", () => {
    const note =
      "On the error path here, the partially-processed batch is silently discarded rather than " +
      "requeued — a transient failure here means that work is lost with no retry and no log.";
    expect(classifyFindingClass(finding(note))).toBe("work-loss");
  });

  it("classifies a scope/over-broad-match finding", () => {
    const note =
      "The glob `**/*.ts` is too broad here — it matches generated files and vendored code that " +
      "were never meant to be in scope, so this change has scope creep beyond what the ticket asked for.";
    expect(classifyFindingClass(finding(note))).toBe("scope");
  });

  it("classifies an unmatched finding as the single catch-all rather than throwing", () => {
    const note = "The variable name `tmp2` is unclear — rename it to something that says what it holds.";
    expect(() => classifyFindingClass(finding(note))).not.toThrow();
    expect(classifyFindingClass(finding(note))).toBe("other");
  });

  it("classifies an empty note as the catch-all", () => {
    expect(classifyFindingClass(finding(""))).toBe("other");
  });
});
