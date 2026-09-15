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

  it("does not classify a bare 'cancels' finding about an unrelated code change as cancellation", () => {
    const note = "This migration cancels the effect of PR #200, reverting the retry backoff to its old value.";
    expect(classifyFindingClass(finding(note))).toBe("other");
  });

  it("does not classify a bare 'cancel' finding describing a missing UI affordance as cancellation", () => {
    const note = "The button has no way to cancel the upload, so users are stuck waiting for it to finish.";
    expect(classifyFindingClass(finding(note))).toBe("other");
  });

  it("does not classify a bare 'canceled' transaction/error finding as cancellation", () => {
    const note =
      "The transaction was canceled by the database after a constraint failure, but the code reports success.";
    expect(classifyFindingClass(finding(note))).toBe("other");
  });

  it("classifies a 'cancels' (active present-tense) finding as cancellation", () => {
    const note = "When the caller cancels the request, the handler keeps writing to the response anyway.";
    expect(classifyFindingClass(finding(note))).toBe("cancellation");
  });

  it("classifies an active 'aborts ... during this await' finding as cancellation", () => {
    const note =
      "The caller aborts the request during this await, but the handler still writes the response.";
    expect(classifyFindingClass(finding(note))).toBe("cancellation");
  });

  it("classifies an active 'Aborting ... during this await' finding as cancellation", () => {
    const note = "Aborting the run during this await does not stop the worker.";
    expect(classifyFindingClass(finding(note))).toBe("cancellation");
  });

  it("does not classify an unrelated transaction abort as cancellation", () => {
    const note =
      "The transaction aborts when the unique constraint is violated, rolling back all pending writes.";
    expect(classifyFindingClass(finding(note))).toBe("other");
  });

  it("does not classify a bare 'aborted' transaction finding as cancellation", () => {
    const note =
      "The transaction was aborted after the unique constraint failed, but the code reports success.";
    expect(classifyFindingClass(finding(note))).toBe("other");
  });

  it("classifies a 'signal.aborted' finding as cancellation even without a nearby await", () => {
    const note = "The handler never checks signal.aborted before writing the response.";
    expect(classifyFindingClass(finding(note))).toBe("cancellation");
  });

  it("classifies an 'aborted' finding as cancellation when await is nearby", () => {
    const note = "The request was aborted during this await, but the handler keeps writing to the response.";
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

  it("classifies a plural passive 'are discarded' work-loss finding", () => {
    const note = "The queued jobs are discarded if processing fails, with no requeue and no log.";
    expect(classifyFindingClass(finding(note))).toBe("work-loss");
  });

  it("classifies a plural passive 'are silently discarded' work-loss finding", () => {
    const note = "Both queue entries are silently discarded on an exception, losing the caller's submission.";
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

  it("does not classify a parsing bug as work-loss when a colon separates the work noun's clause", () => {
    const note = "For each request: the first character is dropped when parsing a negative number.";
    expect(classifyFindingClass(finding(note))).toBe("other");
  });

  it("does not classify a parsing bug as work-loss when the work noun is only a preposition's object", () => {
    const note = "For each request the first character is dropped when parsing a negative number.";
    expect(classifyFindingClass(finding(note))).toBe("other");
  });

  it("does not classify a parsing bug as work-loss when the work noun is only a following gerund's object", () => {
    const note = "The first character is dropped when parsing a request, corrupting the result.";
    expect(classifyFindingClass(finding(note))).toBe("other");
  });

  it("does not classify a numeric-precision bug as work-loss merely because it says 'data loss'", () => {
    const note = "Casting this bigint to number causes data loss for large IDs.";
    expect(classifyFindingClass(finding(note))).toBe("other");
  });

  it("classifies a 'data loss' finding as work-loss when a work-bearing noun is nearby", () => {
    const note = "A crash here causes data loss on the pending job before it can be retried.";
    expect(classifyFindingClass(finding(note))).toBe("work-loss");
  });

  it("classifies an active 'loses the job' finding as work-loss", () => {
    const note = "The handler loses the job when processing throws, with no requeue and no log.";
    expect(classifyFindingClass(finding(note))).toBe("work-loss");
  });

  it("classifies an active 'loses the queued job' finding as work-loss", () => {
    const note = "The error path loses the queued job before it can be retried.";
    expect(classifyFindingClass(finding(note))).toBe("work-loss");
  });

  it("classifies an active 'drops the job' finding as work-loss", () => {
    const note = "The handler drops the job when processing throws, with no requeue and no log.";
    expect(classifyFindingClass(finding(note))).toBe("work-loss");
  });

  it("classifies an active 'discards the queued task' finding as work-loss", () => {
    const note = "The worker discards the queued task before retry, so the client's submission is never processed.";
    expect(classifyFindingClass(finding(note))).toBe("work-loss");
  });

  it("does not classify an object-less 'drops' finding as work-loss", () => {
    const note = "This release drops support for the legacy config format without a migration path.";
    expect(classifyFindingClass(finding(note))).toBe("other");
  });

  it("does not classify an object-less 'discards' finding as work-loss", () => {
    const note = "The pool discards the idle connection after the timeout elapses.";
    expect(classifyFindingClass(finding(note))).toBe("other");
  });

  it("does not classify unfenced Markdown as fencing/TOCTOU without ownership context", () => {
    const note = "The Markdown example is unfenced, so the prose renders as code instead of a code block.";
    expect(classifyFindingClass(finding(note))).toBe("other");
  });

  it("classifies fencing/TOCTOU when an unrelated unfenced-Markdown mention precedes the real lease race by more than 60 chars", () => {
    const note =
      "The Markdown example above is unfenced, so the prose renders as code instead of a code block. " +
      "Separately, and much more seriously, this unfenced lease read lets another worker replace the owner before update.";
    expect(classifyFindingClass(finding(note))).toBe("fencing-toctou");
  });

  it("classifies work-loss when a prepositional work noun precedes the real subject", () => {
    const note = "For each request the queued job is lost when processing fails, with no retry.";
    expect(classifyFindingClass(finding(note))).toBe("work-loss");
  });

  it("does not classify an active 'drops support for' finding as work-loss", () => {
    const note = "The API drops support for queue items in this release, without a migration path.";
    expect(classifyFindingClass(finding(note))).toBe("other");
  });

  it("does not classify an active 'drops a field from' finding as work-loss", () => {
    const note = "The parser drops a field from the request while normalizing the payload.";
    expect(classifyFindingClass(finding(note))).toBe("other");
  });

  it("does not classify a numeric-precision bug as work-loss when a work noun follows a semicolon", () => {
    const note = "Casting this bigint to number causes data loss; the job status remains correct.";
    expect(classifyFindingClass(finding(note))).toBe("other");
  });

  it("does not classify an unhandled rejection without work context as work-loss", () => {
    const note = "This unhandled rejection causes the endpoint to return 500 instead of the validation response.";
    expect(classifyFindingClass(finding(note))).toBe("other");
  });

  it("classifies an unhandled rejection with work context as work-loss", () => {
    const note = "This unhandled rejection swallows the pending job update with no retry and no log.";
    expect(classifyFindingClass(finding(note))).toBe("work-loss");
  });

  it("does not classify a numeric-precision bug as work-loss merely because 'error' is nearby", () => {
    const note = "Converting the error code to number causes data loss for large values.";
    expect(classifyFindingClass(finding(note))).toBe("other");
  });

  it("classifies a past-tense passive 'were discarded' work-loss finding", () => {
    const note = "The queued jobs were discarded when processing failed, with no requeue and no log.";
    expect(classifyFindingClass(finding(note))).toBe("work-loss");
  });

  it("classifies a perfect-passive 'has been discarded' work-loss finding", () => {
    const note = "The queued job has been discarded after the retry limit was reached, losing the submission.";
    expect(classifyFindingClass(finding(note))).toBe("work-loss");
  });

  it("classifies an active 'drops all queued jobs' finding as work-loss (quantifier before the direct object)", () => {
    const note = "The handler drops all queued jobs when processing throws, with no requeue and no log.";
    expect(classifyFindingClass(finding(note))).toBe("work-loss");
  });

  it("classifies an active 'loses every pending task' finding as work-loss (quantifier before the direct object)", () => {
    const note = "The worker loses every pending task before it can retry.";
    expect(classifyFindingClass(finding(note))).toBe("work-loss");
  });

  it("classifies an active 'discards both queued requests' finding as work-loss (quantifier before the direct object)", () => {
    const note = "The service discards both queued requests when the connection resets.";
    expect(classifyFindingClass(finding(note))).toBe("work-loss");
  });

  it("classifies a fail-open finding phrased as returned authorization after a failed dependency", () => {
    const note = "The permission check returns true when the database lookup throws, granting access it shouldn't.";
    expect(classifyFindingClass(finding(note))).toBe("fail-open");
  });

  it("classifies a fail-open finding phrased as a catch returning an allowed verdict", () => {
    const note = "On an unexpected error the catch returns allowed instead of denying the request.";
    expect(classifyFindingClass(finding(note))).toBe("fail-open");
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
