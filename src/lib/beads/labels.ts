import type { Bead } from "./types";

/**
 * Label prefixes anton writes as runtime bookkeeping, excluded from the vocabulary an operator picks
 * from. `run-lease:` carries an expiry timestamp, so every lease is its own unique "value" — offering
 * them would bury the board's real namespaces under machine noise.
 */
const MACHINE_LABEL_PREFIXES = ["run-lease:"];

/** One label the board actually uses, with how many beads carry it — the picker's ordering signal. */
export interface LabelUsage {
  label: string;
  count: number;
}

/** A `ns:` group of the board's labels. `namespace` is `""` for bare labels like `approved`. */
export interface LabelNamespace {
  namespace: string;
  labels: LabelUsage[];
}

/**
 * The label vocabulary a board actually uses, grouped by `ns:` namespace (anton-prng). anton ships no
 * vocabulary of its own, so any surface that asks an operator to nominate labels — value ranking
 * today, picker criteria next — has to read the board to know what there is to nominate.
 *
 * Ordered by usage, not alphabetically: the namespace a board leans on is the one an operator is
 * looking for. Bare (namespace-less) labels sort last, since a `ns:value` convention is what carries
 * meaning worth ranking on.
 */
export function boardLabelVocabulary(beads: readonly Bead[]): LabelNamespace[] {
  const counts = new Map<string, number>();
  for (const bead of beads) {
    for (const label of bead.labels ?? []) {
      if (MACHINE_LABEL_PREFIXES.some((prefix) => label.startsWith(prefix))) continue;
      counts.set(label, (counts.get(label) ?? 0) + 1);
    }
  }

  const groups = new Map<string, LabelUsage[]>();
  for (const [label, count] of counts) {
    const namespace = label.includes(":") ? label.slice(0, label.indexOf(":")) : "";
    const group = groups.get(namespace);
    if (group) group.push({ label, count });
    else groups.set(namespace, [{ label, count }]);
  }

  const byUsageThenName = (a: LabelUsage, b: LabelUsage) =>
    b.count - a.count || a.label.localeCompare(b.label);

  return [...groups.entries()]
    .map(([namespace, labels]) => ({ namespace, labels: labels.sort(byUsageThenName) }))
    .sort((a, b) => {
      if (!a.namespace !== !b.namespace) return a.namespace ? -1 : 1; // bare labels last
      const total = (g: LabelNamespace) => g.labels.reduce((sum, l) => sum + l.count, 0);
      return total(b) - total(a) || a.namespace.localeCompare(b.namespace);
    });
}
