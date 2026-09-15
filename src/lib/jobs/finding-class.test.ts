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

  it("classifies an 'unfenced' finding as fencing/TOCTOU even without a word boundary before 'fenc'", () => {
    const note = "The unfenced lease read lets another worker replace the owner before update.";
    expect(classifyFindingClass(finding(note))).toBe("fencing-toctou");
  });

  it("classifies a 're-read before releasing a retired claim' finding as fencing/TOCTOU", () => {
    const note =
      "This claim is released without a re-read before releasing a retired claim — another machine's " +
      "sync could have already reassigned it by the time this write lands.";
    expect(classifyFindingClass(finding(note))).toBe("fencing-toctou");
  });

  it("classifies a 'reassert the claim after the final policy await' finding as fencing/TOCTOU", () => {
    const note =
      "The code should reassert the claim after the final policy await instead of trusting the value " +
      "read before it — the policy check can yield and let another run retire the claim first.";
    expect(classifyFindingClass(finding(note))).toBe("fencing-toctou");
  });

  it("classifies a cancellation finding mentioning a final await as cancellation, not fencing/TOCTOU", () => {
    const note =
      "This should recheck cancellation after the final WIP await — the handler keeps writing to the " +
      "response after the abort signal fires instead of bailing out once the pending work resolves.";
    expect(classifyFindingClass(finding(note))).toBe("cancellation");
  });

  it("classifies a fail-open finding mentioning a final await as fail-open, not fencing/TOCTOU", () => {
    const note =
      "After the final retry await, the catch block swallows the error and proceeds as if the request " +
      "succeeded — this fails open instead of surfacing the failure to the caller.";
    expect(classifyFindingClass(finding(note))).toBe("fail-open");
  });

  it("classifies a finding describing the abort signal firing mid-await as cancellation", () => {
    const note = "The abort signal can fire during this await, and the code keeps writing to the response anyway.";
    expect(classifyFindingClass(finding(note))).toBe("cancellation");
  });

  it("classifies a finding describing signal.aborted as true as cancellation", () => {
    const note = "The run continues when signal.aborted is true instead of bailing out of the loop.";
    expect(classifyFindingClass(finding(note))).toBe("cancellation");
  });

  it("classifies a 'cancelling' (active, double-L) finding as cancellation", () => {
    const note = "Cancelling the run during this await does not stop the handler from finishing its work.";
    expect(classifyFindingClass(finding(note))).toBe("cancellation");
  });

  it("classifies a 'canceling' (active, single-L) finding as cancellation", () => {
    const note = "Canceling the upload mid-flight leaves the temp file behind on disk.";
    expect(classifyFindingClass(finding(note))).toBe("cancellation");
  });

  it("classifies a 'cancels' (active present-tense) finding as cancellation", () => {
    const note = "When the caller cancels the request, the handler keeps writing to the response anyway.";
    expect(classifyFindingClass(finding(note))).toBe("cancellation");
  });

  it("classifies a passive 'is lost' work-loss finding", () => {
    const note = "The job is lost after dequeue if the handler throws before it acknowledges the message.";
    expect(classifyFindingClass(finding(note))).toBe("work-loss");
  });

  it("classifies a passive 'is dropped' work-loss finding", () => {
    const note = "The queue entry is dropped when processing fails, with no requeue and no log of the failure.";
    expect(classifyFindingClass(finding(note))).toBe("work-loss");
  });

  it("classifies a lease-expiry ownership race as fencing/TOCTOU", () => {
    const note =
      "The lease can expire during this await, so ownership may transfer before this write lands, " +
      "letting another worker's claim win the race.";
    expect(classifyFindingClass(finding(note))).toBe("fencing-toctou");
  });

  it("does not classify a dropped-character parsing bug as work-loss", () => {
    const note = "The first character is dropped when parsing a negative number, corrupting the result.";
    expect(classifyFindingClass(finding(note))).toBe("other");
  });

  it("does not classify a lost error-context finding as work-loss", () => {
    const note = "The diagnostic context is lost after wrapping the error, making the cause hard to trace.";
    expect(classifyFindingClass(finding(note))).toBe("other");
  });

  it("does not classify generic error-path phrasing without a loss signal as work-loss", () => {
    const note = "On the error path, the handler returns the wrong status code instead of a 500.";
    expect(classifyFindingClass(finding(note))).toBe("other");
  });

  it("does not classify a bare 'catch block swallows' mention without a loss signal as work-loss", () => {
    const note = "The catch block swallows the exception but logs a misleading message about the cause.";
    expect(classifyFindingClass(finding(note))).toBe("other");
  });

  it("does not classify a 'silently drops' finding without work context as work-loss", () => {
    const note = "This validator silently drops invalid UTF-8 characters instead of erroring.";
    expect(classifyFindingClass(finding(note))).toBe("other");
  });

  it("does not classify a 'silently drops' finding about metric labels as work-loss", () => {
    const note = "The logger silently drops duplicate metric labels, which skews the aggregated counts.";
    expect(classifyFindingClass(finding(note))).toBe("other");
  });

  it("classifies a 'silently drops' finding with work context as work-loss", () => {
    const note = "The worker silently drops the job when the connection resets, with no retry and no log.";
    expect(classifyFindingClass(finding(note))).toBe("work-loss");
  });

  it("does not classify a parsing bug as work-loss merely because an incidental noun is nearby", () => {
    const note = "While parsing a request, the first character is dropped when decoding a negative number.";
    expect(classifyFindingClass(finding(note))).toBe("other");
  });

  it("does not classify a parsing bug as work-loss merely because a work noun is in an earlier sentence", () => {
    const note =
      "Even though the item queue was recently updated, the first character is dropped when decoding a negative number.";
    expect(classifyFindingClass(finding(note))).toBe("other");
  });

  it("does not classify a parsing bug as work-loss merely because a work noun possesses the real subject", () => {
    const note = "The request body's first character is dropped when decoding a negative number.";
    expect(classifyFindingClass(finding(note))).toBe("other");
  });

  it("does not classify unfenced Markdown as fencing/TOCTOU without ownership context", () => {
    const note = "The Markdown example is unfenced, so the prose renders as code instead of a code block.";
    expect(classifyFindingClass(finding(note))).toBe("other");
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
