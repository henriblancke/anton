/**
 * Approving a gardener PROPOSAL is not a run (anton-1t3n): the route applies its board move and
 * closes the bead, so the surfaces that offer Approve must not report a run that never started.
 *
 * The route answers such an approval with `applied.summary` — one line naming what changed — and
 * answers an ordinary approval without it. That presence is the whole signal; a caller reads it
 * before toasting so the operator is told what actually happened.
 */

/** The "what changed" line an approve answers with, or undefined when this approval started a run. */
export function appliedSummaryOf(body: unknown): string | undefined {
  const summary = (body as { applied?: { summary?: unknown } } | null)?.applied?.summary;
  return typeof summary === "string" && summary.trim() ? summary.trim() : undefined;
}

/**
 * Read an accepted approve response WITHOUT consuming it, so the caller can still hand the same
 * response to the advisory reporter. Never throws: a body that isn't JSON simply carries no summary,
 * and an approval that already succeeded must not be reported as a failure by its own reporting.
 */
export async function readAppliedSummary(res: Response): Promise<string | undefined> {
  try {
    return appliedSummaryOf(await res.clone().json());
  } catch {
    return undefined;
  }
}
