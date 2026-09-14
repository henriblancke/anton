/**
 * DB timestamp → epoch seconds, in one place (anton-mw7q).
 *
 * Drizzle hands back either a `Date` (timestamp columns) or a raw number (integer columns)
 * depending on the column mode, so every row mapper in the lib layer has to normalize. Two
 * missing-value conventions are in play and both are load-bearing: view models with optional
 * timestamps want `undefined`, while report/job views treat epoch 0 as the missing-time sentinel
 * their formatters already read as "absent".
 *
 * Pure and dependency-free — importing this must never pull the DB connection in.
 */

/** Epoch seconds for a DB timestamp, or `undefined` when the column is null. */
export function toEpoch(value: unknown): number | undefined {
  if (value == null) return undefined;
  if (value instanceof Date) return Math.floor(value.getTime() / 1000);
  return Number(value);
}

/** Epoch seconds for a DB timestamp, collapsing a null column to the 0 sentinel. */
export function epochOrZero(value: unknown): number {
  return toEpoch(value) ?? 0;
}
