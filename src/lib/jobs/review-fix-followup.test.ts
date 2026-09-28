/**
 * The follow-up epic's `## Outcome IDs` body for a legacy target with nothing to carry over
 * (PR #334 review): a fallback that reads back as prose would tokenize into bogus `outcome:<word>`
 * labels the next time this follow-up is itself the target of a send-back.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { extractOutcomeIdsSection, outcomeIdTokens } from "../backlog";
import type { Bead } from "../beads/bd";

const updateMock = vi.fn();

vi.mock("../beads/bd", async () => {
  const actual = await vi.importActual<typeof import("../beads/bd")>("../beads/bd");
  return {
    ...actual,
    beads: { ...actual.beads, update: (...args: unknown[]) => updateMock(...args) },
  };
});

const { blankOutcomeIdsPlaceholder, outcomeIdsBody, resolveFollowUp } = await import(
  "./review-fix-followup"
);

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

function makeBead(over: Partial<Bead> & { id: string }): Bead {
  return { title: over.id, status: "open", issue_type: "epic", labels: [], ...over };
}

// A follow-up an EARLIER, pre-outcome-ids version of this job created and finalization is only
// now reusing (found by its `rehomeOf` stamp, never by contract shape) — resolveFollowUp must not
// hand it back with `## Outcome IDs` still missing (PR #334 review: the orphan-grooming reuse path
// already does this repair for its own reused epic).
describe("resolveFollowUp reuse", () => {
  beforeEach(() => {
    updateMock.mockReset();
    updateMock.mockResolvedValue(undefined);
  });

  it("patches a missing ## Outcome IDs onto a reused legacy follow-up before handing it back", async () => {
    const epic = makeBead({ id: "epic1", labels: ["outcome:reports-are-shareable"] });
    const legacy = makeBead({
      id: "dup",
      metadata: { rehomeOf: "epic1" },
      description: "## Goal\n\nfollow up\n\n## Acceptance Criteria\n- [ ] done",
    });

    const result = await resolveFollowUp({
      repo: "/repo",
      epic,
      all: [legacy],
      ids: "t1",
      reread: async (id) => (id === "dup" ? legacy : undefined),
    });

    expect(result).toMatchObject({ ok: true, home: { id: "dup", disposable: true } });
    expect(updateMock).toHaveBeenCalledTimes(1);
    const [repo, id, patch] = updateMock.mock.calls[0]!;
    expect(repo).toBe("/repo");
    expect(id).toBe("dup");
    const patched = (patch as { description: string }).description;
    const { present, body } = extractOutcomeIdsSection(patched);
    expect(present).toBe(true);
    expect(outcomeIdTokens(body)).toEqual(["reports-are-shareable"]);
    // The rest of the legacy contract is left alone — only Outcome IDs is ever added here.
    expect(patched).toContain("## Acceptance Criteria\n- [ ] done");
  });

  it("does not touch a reused follow-up that already carries Outcome IDs", async () => {
    const epic = makeBead({ id: "epic1" });
    const current = makeBead({
      id: "dup",
      metadata: { rehomeOf: "epic1" },
      description: "## Outcome IDs\n\noutcome:codebase-health",
    });

    await resolveFollowUp({
      repo: "/repo",
      epic,
      all: [current],
      ids: "t1",
      reread: async (id) => (id === "dup" ? current : undefined),
    });

    expect(updateMock).not.toHaveBeenCalled();
  });
});
