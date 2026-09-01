/**
 * Where a surface sends an operator to READ the rule behind an automated decision (anton-jqvy,
 * anton-cqxd).
 *
 * One definition, because two callers now land here for opposite reasons and must land in the same
 * place: `Never` on a pick (veto-actions) opens the criterion to TIGHTEN, and `◈ policy` on a card
 * opens the same criterion to CHECK. A second copy of this URL grammar is how the two would drift.
 *
 * Pure and component-free so a server-rendered badge can call it — the settings panel reads the
 * params back on the client.
 */

/**
 * The settings page's policy panel, optionally anchored.
 *
 * The panel itself is selected by the HASH, which is how every settings section is addressed
 * (`useActiveSection`); the criterion and the bead ride beside it as search params because a hash
 * holds one id. Both are optional and independently useful: a bead with no admitting criterion still
 * opens the panel at its own evaluation, and a criterion with no bead still opens the control.
 */
export function policyHref(slug: string, criterion?: string, beadId?: string): string {
  const params = new URLSearchParams();
  if (criterion) params.set("criterion", criterion);
  if (beadId) params.set("bead", beadId);
  const query = params.toString();
  return `/projects/${slug}/settings${query ? `?${query}` : ""}#policy`;
}

/** A criterion key as the editor labels it — `severity:`, not `labels:severity`. */
export function criterionLabel(criterion: string): string {
  return criterion.startsWith("labels:") ? `${criterion.slice("labels:".length)}:` : criterion;
}
