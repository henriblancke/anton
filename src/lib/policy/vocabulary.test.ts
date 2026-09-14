/**
 * Vocabulary discovery (anton-g631). The claims worth pinning: a board's namespaces come back in its
 * OWN words whatever those are, a label with no namespace survives instead of being dropped, an
 * ordinal-looking namespace is flagged but never reordered, and a board with nothing to say returns
 * nothing rather than throwing.
 */
import { describe, expect, it } from "vitest";
import type { Bead } from "../beads/types";
import { discoverVocabulary } from "./vocabulary";

const bead = (id: string, labels: string[]): Bead => ({
  id,
  title: id,
  status: "open",
  labels,
});

describe("discoverVocabulary", () => {
  it("reports anton's own vocabulary with observed values and counts", () => {
    const vocabulary = discoverVocabulary([
      bead("a", ["domain:eng", "agent:nextjs", "approved"]),
      bead("b", ["domain:eng", "agent:supabase"]),
      bead("c", ["domain:marketing"]),
    ]);

    expect(vocabulary.namespaces).toEqual([
      {
        namespace: "domain",
        count: 3,
        values: [
          { value: "eng", count: 2 },
          { value: "marketing", count: 1 },
        ],
      },
      {
        namespace: "agent",
        count: 2,
        values: [
          { value: "nextjs", count: 1 },
          { value: "supabase", count: 1 },
        ],
      },
    ]);
  });

  it("speaks a foreign board's words, knowing none of them in advance", () => {
    const vocabulary = discoverVocabulary([
      bead("a", ["severity:sev2", "team:payments"]),
      bead("b", ["severity:sev1", "team:payments"]),
      bead("c", ["team:risk"]),
    ]);

    expect(vocabulary.namespaces.map((n) => n.namespace)).toEqual([
      "team",
      "severity",
    ]);
    expect(vocabulary.namespaces[0].values).toEqual([
      { value: "payments", count: 2 },
      { value: "risk", count: 1 },
    ]);
    expect(vocabulary.namespaces[0].rankingCandidate).toBeUndefined();
    // `sev1`/`sev2` are numbered, so the namespace is offered for ranking.
    expect(vocabulary.namespaces[1].rankingCandidate).toBe(true);
  });

  it("keeps labels with no colon as a flat set", () => {
    const vocabulary = discoverVocabulary([
      bead("a", ["blocking-PR", "approved", "risk:high"]),
      bead("b", ["approved"]),
    ]);

    expect(vocabulary.flat).toEqual([
      { label: "approved", count: 2 },
      { label: "blocking-PR", count: 1 },
    ]);
    expect(vocabulary.namespaces.map((n) => n.namespace)).toEqual(["risk"]);
  });

  it("keeps a label whose namespace or value is missing, rather than recording an empty one", () => {
    const vocabulary = discoverVocabulary([
      bead("a", ["severity:", ":eng", "team:payments"]),
    ]);

    expect(vocabulary.flat).toEqual([
      { label: ":eng", count: 1 },
      { label: "severity:", count: 1 },
    ]);
    expect(vocabulary.namespaces.map((n) => n.namespace)).toEqual(["team"]);
  });

  it("flags scale-shaped namespaces as ranking candidates without ordering their values", () => {
    const vocabulary = discoverVocabulary([
      bead("a", ["size:L", "risk:high", "priority:P2", "domain:eng"]),
      bead("b", ["size:L", "risk:low", "priority:P0", "domain:ops"]),
      bead("c", ["size:S", "risk:low", "priority:P0"]),
      bead("d", ["size:S"]),
    ]);
    const byName = new Map(vocabulary.namespaces.map((n) => [n.namespace, n]));

    expect(byName.get("size")?.rankingCandidate).toBe(true);
    expect(byName.get("risk")?.rankingCandidate).toBe(true);
    expect(byName.get("priority")?.rankingCandidate).toBe(true);
    expect(byName.get("domain")?.rankingCandidate).toBeUndefined();

    // Observation order, not scale order: `low` leads `high` because it is used more, and `P0`
    // leads `P2` for the same reason. Ranking stays the operator's act.
    expect(byName.get("risk")?.values.map((v) => v.value)).toEqual([
      "low",
      "high",
    ]);
    expect(byName.get("priority")?.values.map((v) => v.value)).toEqual([
      "P0",
      "P2",
    ]);
  });

  it("never calls a single-valued namespace a ranking candidate — there is nothing to rank", () => {
    const [only] = discoverVocabulary([
      bead("a", ["size:M"]),
      bead("b", ["size:M"]),
    ]).namespaces;
    expect(only).toEqual({
      namespace: "size",
      count: 2,
      values: [{ value: "M", count: 2 }],
    });
  });

  it("returns an empty result for an empty or label-free board", () => {
    expect(discoverVocabulary([])).toEqual({ namespaces: [], flat: [] });
    expect(
      discoverVocabulary([{ id: "a", title: "a", status: "open" }]),
    ).toEqual({
      namespaces: [],
      flat: [],
    });
    expect(discoverVocabulary([bead("a", [])])).toEqual({
      namespaces: [],
      flat: [],
    });
  });
});
