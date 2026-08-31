/**
 * What vocabulary does THIS board speak (anton-g631)?
 *
 * anton ships no label vocabulary, so a policy editor that offered `domain:` and `risk:` to a
 * payments board that writes `severity:` and `team:` would be anton quoting itself. Discovery is the
 * read that makes the editor repo-agnostic: it reports the namespaces the board actually uses, the
 * values observed under each, and how often — the criteria an operator picks from.
 *
 * Pure over a board snapshot a caller already holds (`loadAllIssues`), and dependency-free beyond the
 * shared bead shapes, so it can run server-side or ship to the panel.
 *
 * Two things it deliberately does NOT do. It never infers a value ORDER: {@link
 * DiscoveredNamespace.rankingCandidate} is a hint that a namespace looks like a scale, offered so the
 * operator can rank it by hand, and the values stay in OBSERVATION order regardless. And it filters
 * nothing but the machine noise {@link boardLabelVocabulary} already drops — deciding which
 * namespaces make defensible criteria belongs to the tier above (see `POLICY_CONTROL_NAMESPACES` in
 * ./types), not to the read that describes the board.
 */
import { boardLabelVocabulary, type LabelUsage } from "../beads/labels";
import type { Bead } from "../beads/types";
import { valueOf } from "./types";

/** One value observed under a namespace, BARE (`"eng"`, not `"domain:eng"`), with its label count. */
export interface DiscoveredValue {
  value: string;
  count: number;
}

/** One `ns:value` namespace the board uses, with everything observed under it. */
export interface DiscoveredNamespace {
  /** The `ns`, as the board writes it — `"domain"`, not `"domain:"`. */
  namespace: string;
  /**
   * Values observed under the namespace, most-used first. This is observation frequency and NOTHING
   * else: even when {@link rankingCandidate} is set, this order is not a rank and must not be read as
   * one — ranking a discovered namespace is the operator's act.
   */
  values: DiscoveredValue[];
  /** Labels observed under this namespace, summed across values. */
  count: number;
  /**
   * The values look like a scale (`S/M/L`, `low/high`, `P0/P1`), so this namespace is worth OFFERING
   * to rank. A hint for the operator, never an applied ordering.
   */
  rankingCandidate?: boolean;
}

/** Every namespace the board uses, plus the labels that have no `ns:value` shape at all. */
export interface BoardVocabulary {
  namespaces: DiscoveredNamespace[];
  /**
   * Labels carrying no usable namespace — a bare `approved`, or a malformed `severity:` / `:eng`.
   * They are meaningful (`blocking-PR` says something) and a criterion tier may yet want them, so
   * they are reported whole rather than dropped for not fitting the shape.
   */
  flat: LabelUsage[];
}

/**
 * Value sets that read as a scale. Held as unordered SETS on purpose: membership is all discovery is
 * allowed to know, and an array here would be an order this module has no business asserting.
 */
const ORDINAL_FAMILIES: readonly ReadonlySet<string>[] = [
  new Set(["xs", "s", "m", "l", "xl", "xxl"]),
  new Set(["tiny", "small", "medium", "large", "huge"]),
  new Set(["none", "low", "medium", "moderate", "high", "critical"]),
  new Set(["trivial", "minor", "moderate", "major", "critical", "blocker"]),
];

/** `3`, `P0`, `t2`, `v1.5` — a number, optionally behind a short scale letter. */
const NUMBERED = /^[a-z]*\d+(\.\d+)?$/i;

/**
 * Does this value set look ordinal? Either every value is numbered, or every value belongs to one
 * known scale family. Two distinct values are the minimum — a namespace with one value has nothing to
 * rank, and calling it a ranking candidate would just add a control that does nothing.
 */
function looksOrdinal(values: readonly string[]): boolean {
  if (values.length < 2) return false;
  if (values.every((v) => NUMBERED.test(v))) return true;
  const lowered = values.map((v) => v.toLowerCase());
  return ORDINAL_FAMILIES.some((family) => lowered.every((v) => family.has(v)));
}

/**
 * The board's own label vocabulary. An empty or label-free board returns empty lists, never throws:
 * that is the state of a fresh repo, and the editor above has to render it as "nothing discovered
 * yet" rather than as a failure.
 */
export function discoverVocabulary(board: readonly Bead[]): BoardVocabulary {
  const namespaces: DiscoveredNamespace[] = [];
  const flat: LabelUsage[] = [];

  for (const group of boardLabelVocabulary(board)) {
    if (!group.namespace) {
      flat.push(...group.labels);
      continue;
    }

    const values: DiscoveredValue[] = [];
    for (const { label, count } of group.labels) {
      const value = valueOf(label);
      // `severity:` with nothing after the colon names no value; keep the raw label rather than
      // record an empty one.
      if (value) values.push({ value, count });
      else flat.push({ label, count });
    }
    if (!values.length) continue;

    const count = values.reduce((sum, v) => sum + v.count, 0);
    const ordinal = looksOrdinal(values.map((v) => v.value));
    namespaces.push({
      namespace: group.namespace,
      values,
      count,
      ...(ordinal ? { rankingCandidate: true } : {}),
    });
  }

  flat.sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
  return { namespaces, flat };
}
