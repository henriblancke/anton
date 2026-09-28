/**
 * The follow-up epic's `## Outcome IDs` body for a legacy target with nothing to carry over
 * (PR #334 review): a fallback that reads back as prose would tokenize into bogus `outcome:<word>`
 * labels the next time this follow-up is itself the target of a send-back.
 */
import { describe, expect, it } from "vitest";
import { extractOutcomeIdsSection, outcomeIdTokens } from "../backlog";
import { blankOutcomeIdsPlaceholder, outcomeIdsBody } from "./review-fix-followup";

describe("outcomeIdsBody + blankOutcomeIdsPlaceholder", () => {
  it("carries real ids straight through", () => {
    const body = outcomeIdsBody(["reports-are-shareable", "report-sharing"]);
    expect(body).toBe("outcome:reports-are-shareable, outcome:report-sharing");
    // Round-trips through the SAME reader a later send-back would use on this epic.
    expect(outcomeIdTokens(body)).toEqual(["reports-are-shareable", "report-sharing"]);
  });

  it("renders a non-empty placeholder for no ids, so the formula never falls back to its own TODO default", () => {
    const body = outcomeIdsBody([]);
    expect(body.trim()).not.toBe("");
  });

  it("strips back to a genuinely empty section once blanked, not to tokenizable prose", () => {
    const rendered = `## Goal\n\nsomething happened\n\n## Outcome IDs\n\n${outcomeIdsBody([])}`;
    const blanked = blankOutcomeIdsPlaceholder(rendered, []);
    const { present, body } = extractOutcomeIdsSection(blanked);
    expect(present).toBe(true);
    expect(body).toBe("");
    // The exact regression: re-reading this bead's `## Outcome IDs` must yield zero ids, never
    // a sentence's words tokenized as `outcome:predates` etc.
    expect(outcomeIdTokens(body)).toEqual([]);
  });

  it("leaves a description with real ids untouched", () => {
    const rendered = `## Outcome IDs\n\n${outcomeIdsBody(["reports-are-shareable"])}`;
    expect(blankOutcomeIdsPlaceholder(rendered, ["reports-are-shareable"])).toBe(rendered);
  });
});
