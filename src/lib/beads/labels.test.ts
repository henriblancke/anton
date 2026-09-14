/**
 * Board label vocabulary (anton-prng): what an operator picks value nominations from. anton ships no
 * vocabulary, so this read IS the vocabulary — it has to reflect the board's own namespaces, ordered
 * by what the board actually leans on, and drop anton's machine bookkeeping.
 */
import { describe, expect, it } from "vitest";
import type { Bead } from "./types";
import { boardLabelVocabulary } from "./labels";

function bead(id: string, labels: string[]): Bead {
  return { id, title: id, status: "open", labels };
}

describe("boardLabelVocabulary", () => {
  it("groups labels by namespace, most-used namespace first", () => {
    const vocabulary = boardLabelVocabulary([
      bead("a", ["risk:high", "size:M", "approved"]),
      bead("b", ["risk:low", "size:M"]),
      bead("c", ["risk:low"]),
    ]);
    expect(vocabulary.map((g) => g.namespace)).toEqual(["risk", "size", ""]);
    expect(vocabulary[0].labels).toEqual([
      { label: "risk:low", count: 2 },
      { label: "risk:high", count: 1 },
    ]);
    // Bare labels are their own group, sorted last — a `ns:value` convention is what carries meaning.
    expect(vocabulary[2].labels).toEqual([{ label: "approved", count: 1 }]);
  });

  it("drops run-lease labels — each carries an expiry, so they are noise, not vocabulary", () => {
    const vocabulary = boardLabelVocabulary([
      bead("a", ["run-lease:1750000000000:run-1", "risk:high"]),
      bead("b", ["run-lease:1750000009999"]),
    ]);
    expect(vocabulary.map((g) => g.namespace)).toEqual(["risk"]);
  });

  it("is empty for a board with no labels, and tolerates beads carrying none", () => {
    expect(boardLabelVocabulary([])).toEqual([]);
    expect(boardLabelVocabulary([{ id: "a", title: "a", status: "open" }])).toEqual([]);
  });
});
