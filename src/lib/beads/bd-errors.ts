/**
 * Readers for the refusals bd writes into a rejected spawn (anton-lsad). Each answers ONE question
 * about a thrown `bd` error — was the bead deleted, is its status permanently unclaimable — so a
 * caller acts on bd's answer rather than on the shape of its failure. Pure over the error object;
 * nothing here spawns bd.
 */
/**
 * Did bd ANSWER that there is no such bead, or did it fail to answer at all? A lookup for a deleted
 * id exits non-zero with `no issue found matching …`, and that is evidence the work was removed on
 * purpose. Every other failure — bd absent, dolt wedged, the step budget expired — is the absence of
 * evidence, so a caller that acts on a deletion (refusing to resume work that no longer exists) must
 * not read it as one. Matches stderr first and the message second: {@link bd}'s rejection carries the
 * raw stderr on both.
 *
 * Both alternatives name an ISSUE, because "not found" on its own is a shape half of bd's
 * operational failures share — a missing database, a missing schema, an unresolvable remote — and
 * reading one of those as a deletion turns "bd couldn't answer" into "the bead was deleted", which
 * is the one conversion every caller here is written to prevent.
 */
export function isMissingBeadError(e: unknown): boolean {
  const err = e as { stderr?: unknown; message?: unknown } | null | undefined;
  const stderr = typeof err?.stderr === "string" ? err.stderr : "";
  const message = typeof err?.message === "string" ? err.message : "";
  return /no issues? found|\bissues?(?: \S+)? not found/i.test(`${stderr}\n${message}`);
}

/**
 * Did bd refuse a `--claim` because the bead's STATUS can never be claimed — `issue not claimable:
 * status blocked` (also `closed`, `deferred`, `in_progress` when the bead isn't already ours)? That
 * refusal is permanent: a status is a decision written to the board, so the identical call repeats
 * the identical error and a caller that buckets it with a Dolt lock burns its whole retry budget
 * before parking with the wrong cause (anton-e5ix). Returns the status bd named so the caller can
 * report it; undefined for every other failure — including "already claimed by <other>", which is an
 * ownership conflict, not a status one — which keeps the retryable path unchanged.
 *
 * Reads stderr first and the message second: {@link bd}'s rejection carries the raw stderr on both.
 */
export function unclaimableStatus(e: unknown): string | undefined {
  const err = e as { stderr?: unknown; message?: unknown } | null | undefined;
  const stderr = typeof err?.stderr === "string" ? err.stderr : "";
  const message = typeof err?.message === "string" ? err.message : "";
  return /not claimable:\s*status\s+([a-z_]+)/i.exec(`${stderr}\n${message}`)?.[1];
}
