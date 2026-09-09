/**
 * Requested vs served (anton-r0y6) — the verdict, and the noise it must not produce.
 *
 * The load-bearing case is the NEGATIVE one: an unrouted project must summarize to silence. Two
 * things would break that, and both are covered below — comparing raw ids (a pinned release date
 * reads as a substitution) and comparing per ROW (an opus invocation's haiku sidecar row does).
 */
import { describe, expect, it } from "vitest";
import {
  classifyDivergence,
  divergedInvocations,
  divergenceSummary,
  groupInvocations,
  modelsMatch,
  normalizeModelId,
  type InvocationDimensionRow,
} from "./model-divergence";

const AT = new Date("2026-09-09T12:00:00Z");

/** A ledger row with the dimensions of one ordinary implement step, overridable per case. */
function row(overrides: Partial<InvocationDimensionRow> = {}): InvocationDimensionRow {
  return {
    projectId: "proj-1",
    jobType: "execute-epic",
    jobId: "job-1",
    step: "implement",
    runId: "run-1",
    beadId: "anton-r0y6",
    claudeSessionId: "sess-1",
    modelRequested: "claude-opus-4-8",
    modelReported: "claude-opus-4-8-20260115",
    endpointHost: null,
    outcome: "ok",
    recordedAt: AT,
    ...overrides,
  };
}

describe("normalizeModelId", () => {
  it.each([
    ["cc/claude-opus-5[1m]", "opus-5"],
    ["claude-opus-5", "opus-5"],
    ["anthropic/claude-opus-5", "opus-5"],
    ["us.anthropic.claude-opus-5-v1:0", "opus-5"],
    ["claude-haiku-4-5-20251001", "haiku-4-5"],
    ["Claude-Sonnet-5-latest", "sonnet-5"],
    ["  claude-opus-4-8  ", "opus-4-8"],
  ])("reduces %s to the model it names", (raw, expected) => {
    expect(normalizeModelId(raw)).toBe(expected);
  });

  it.each([[null], [undefined], ["   "]])("has nothing to reduce for %s", (raw) => {
    expect(normalizeModelId(raw)).toBe("");
  });

  it("keeps an id it does not recognize rather than mangling it into a false match", () => {
    expect(normalizeModelId("glm-4.6")).toBe("glm-4.6");
    expect(normalizeModelId("openrouter/qwen3-coder:free")).toBe("qwen3-coder:free");
  });
});

describe("modelsMatch", () => {
  it.each([
    ["a pinned release date", "claude-opus-4-8", "claude-opus-4-8-20260115"],
    ["a vendor route prefix", "claude-sonnet-5", "anthropic/claude-sonnet-5"],
    ["anton's own cc/ spelling", "cc/claude-opus-5[1m]", "claude-opus-5"],
    ["a context-window variant", "claude-opus-5", "claude-opus-5[1m]"],
    ["a bedrock revision", "claude-opus-5", "us.anthropic.claude-opus-5-v1:0"],
    ["an unpinned family alias", "claude-opus", "claude-opus-4-8-20260115"],
  ])("is the same model across %s", (_label, requested, reported) => {
    expect(modelsMatch(requested, reported)).toBe(true);
  });

  it.each([
    ["a different tier", "claude-opus-4-8", "claude-haiku-4-5"],
    ["a different point release", "claude-opus-4-8", "claude-opus-4-5"],
    ["another vendor entirely", "claude-opus-5", "glm-4.6"],
    ["a free-tier fallback", "claude-sonnet-5", "qwen3-coder:free"],
  ])("is not the same model across %s", (_label, requested, reported) => {
    expect(modelsMatch(requested, reported)).toBe(false);
  });

  it("cannot match when either side is missing", () => {
    expect(modelsMatch(null, "claude-opus-5")).toBe(false);
    expect(modelsMatch("claude-opus-5", null)).toBe(false);
  });
});

describe("classifyDivergence", () => {
  it("is served when a reported model is the one that was asked for", () => {
    expect(classifyDivergence("claude-opus-4-8", ["claude-opus-4-8-20260115"])).toBe("served");
  });

  /**
   * The grain rule: an ordinary opus invocation ALSO reports a haiku row, because Claude Code runs
   * that model for its own small tasks. Any of the reported models matching is what makes the
   * invocation served — requiring all of them would flag every run ever recorded.
   */
  it("is served when the request answered alongside a sidecar model", () => {
    expect(
      classifyDivergence("claude-opus-4-8", ["claude-haiku-4-5-20251001", "claude-opus-4-8"]),
    ).toBe("served");
  });

  it("is diverged when something else answered", () => {
    expect(classifyDivergence("claude-opus-4-8", ["claude-haiku-4-5-20251001"])).toBe("diverged");
  });

  it("is diverged when a gateway fell back to a free-tier model", () => {
    expect(classifyDivergence("claude-opus-5", ["qwen3-coder:free"])).toBe("diverged");
  });

  /**
   * A call that reports no model at all is UNKNOWN, not diverged — a crashed or startup-error
   * result answers nothing, and calling that a substitution invents a routing finding out of a
   * failure that has nothing to do with routing.
   */
  it.each([
    ["nothing reported", []],
    ["a null model", [null]],
    ["a blank model", ["   "]],
  ])("is unknown for a call with %s", (_label, reported) => {
    expect(classifyDivergence("claude-opus-4-8", reported)).toBe("unknown");
  });

  it.each([
    ["nothing was requested", null],
    ["the request was blank", "  "],
  ])("is unknown when %s — the CLI's default cannot diverge from itself", (_label, requested) => {
    expect(classifyDivergence(requested, ["claude-opus-4-8"])).toBe("unknown");
  });
});

describe("groupInvocations", () => {
  /**
   * The per-row trap, end to end. These two rows are ONE opus invocation that also reported its
   * haiku sidecar; per-row comparison calls the haiku row a substitution.
   */
  it("judges one invocation, not one row per model", () => {
    const facts = groupInvocations([
      row({ modelReported: "claude-haiku-4-5-20251001" }),
      row({ modelReported: "claude-opus-4-8-20260115" }),
    ]);

    expect(facts).toHaveLength(1);
    expect(facts[0].modelsReported).toEqual([
      "claude-haiku-4-5-20251001",
      "claude-opus-4-8-20260115",
    ]);
    expect(facts[0].divergence).toBe("served");
    expect(facts[0].rows).toHaveLength(2);
  });

  it("keeps invocations of one run separate when their dimensions differ", () => {
    const facts = groupInvocations([
      row({ step: "implement", claudeSessionId: "sess-a" }),
      row({ step: "review", claudeSessionId: "sess-b" }),
    ]);

    expect(facts.map((f) => f.step)).toEqual(["implement", "review"]);
    expect(facts.every((f) => f.divergence === "served")).toBe(true);
  });

  it("carries the dimensions a reader needs to locate a diverged call", () => {
    const [fact] = groupInvocations([
      row({ modelReported: "glm-4.6", endpointHost: "gw.example.com" }),
    ]);

    expect(fact).toMatchObject({
      divergence: "diverged",
      runId: "run-1",
      beadId: "anton-r0y6",
      step: "implement",
      jobType: "execute-epic",
      endpointHost: "gw.example.com",
      outcome: "ok",
      recordedAt: AT,
    });
  });

  it("reads an unknown-usage row as unknown rather than as a substitution", () => {
    const [fact] = groupInvocations([row({ modelReported: null, outcome: "error" })]);

    expect(fact.modelsReported).toEqual([]);
    expect(fact.divergence).toBe("unknown");
  });

  it("has nothing to group for a project with no rows", () => {
    expect(groupInvocations([])).toEqual([]);
  });
});

describe("divergenceSummary", () => {
  /** Criterion 3: the two always agree here, so the read must be silent — not merely small. */
  it("produces no divergence rows for an unrouted project", () => {
    const facts = groupInvocations([
      row({ claudeSessionId: "sess-a", modelReported: "claude-opus-4-8-20260115" }),
      row({ claudeSessionId: "sess-a", modelReported: "claude-haiku-4-5-20251001" }),
      row({ claudeSessionId: "sess-b", step: "review", modelReported: "claude-opus-4-8" }),
    ]);

    expect(divergedInvocations(facts)).toEqual([]);
    expect(divergenceSummary(facts)).toEqual({
      invocations: 2,
      diverged: 0,
      unknown: 0,
      substitutions: [],
    });
  });

  it("names each substitution with the ids the gateway actually answered with", () => {
    const facts = groupInvocations([
      row({ claudeSessionId: "sess-a", modelReported: "glm-4.6" }),
      row({ claudeSessionId: "sess-b", modelReported: "glm-4.6" }),
      row({ claudeSessionId: "sess-c", modelReported: "qwen3-coder:free" }),
      row({ claudeSessionId: "sess-d", modelReported: "claude-opus-4-8-20260115" }),
      row({ claudeSessionId: "sess-e", modelReported: null }),
    ]);

    expect(divergenceSummary(facts)).toEqual({
      invocations: 5,
      diverged: 3,
      unknown: 1,
      // Most frequent first — the substitution worth deciding about is the one that keeps happening.
      substitutions: [
        { requested: "claude-opus-4-8", served: ["glm-4.6"], count: 2 },
        { requested: "claude-opus-4-8", served: ["qwen3-coder:free"], count: 1 },
      ],
    });
  });

  it("reads an empty window as empty rather than as clean routing", () => {
    expect(divergenceSummary([])).toEqual({
      invocations: 0,
      diverged: 0,
      unknown: 0,
      substitutions: [],
    });
  });
});
