/**
 * Pure argv builders for bd's write verbs — `update`, `batch`, `prune` — and the batch line
 * encoding they ride on (anton-lsad). Nothing here spawns bd: every function maps typed input to
 * the exact argv (or stdin) bd receives, so a test asserts the bytes and the exec path in ./bd
 * stays a one-liner per verb. LABELS itself stays in ./bd — this module only knows the managed
 * prefixes a patch may move.
 */
/** The managed-metadata label prefixes anton edits. Control labels (approved, stage:*,
 * source:*) are NOT in this set and are never touched by a patch.
 * `area` is the epic tier's product-surface designator — its own axis, deliberately not folded into
 * `domain:` (.product/decisions/2026-07-26-engine-designator-prefix.md). */
export const LABEL_PREFIXES = ["agent", "risk", "size", "domain", "area"] as const;
export type LabelPrefix = (typeof LABEL_PREFIXES)[number];

/**
 * A field patch for a bead. Every field is optional; an undefined (or empty-string) field is a
 * no-op that never clobbers the current value. `labels` carries new values for the managed
 * prefixes only — each is diffed against the bead's current labels so a single prefix moves.
 */
export interface BeadPatch {
  title?: string;
  status?: string;
  priority?: number;
  acceptance?: string;
  description?: string;
  labels?: Partial<Record<LabelPrefix, string>>;
}

/** Read the value of a single-valued `prefix:` label off a bead's labels, or undefined. */
export function labelValueOf(labels: string[] | undefined, prefix: string): string | undefined {
  const label = labels?.find((l) => l.startsWith(`${prefix}:`));
  return label ? label.slice(prefix.length + 1) : undefined;
}

/**
 * Build the single `bd update` argv for a patch, or `null` when nothing changed (no write).
 * Label edits diff each managed prefix against `currentLabels`, so only the prefix that
 * actually changed is remove/add-labelled — approved, stage:*, and source:* are preserved.
 */
export function buildUpdateArgs(
  id: string,
  patch: BeadPatch,
  currentLabels: string[] = [],
): string[] | null {
  const args = ["update", id];
  if (patch.title) args.push("--title", patch.title);
  if (patch.status) args.push("--status", patch.status);
  if (patch.priority !== undefined) args.push("--priority", String(patch.priority));
  if (patch.acceptance) args.push("--acceptance", patch.acceptance);
  if (patch.description) args.push("--description", patch.description);
  if (patch.labels) {
    for (const prefix of LABEL_PREFIXES) {
      const next = patch.labels[prefix];
      if (!next) continue; // untouched (undefined) or empty prefix — no-op
      const current = labelValueOf(currentLabels, prefix);
      if (current === next) continue; // unchanged
      if (current !== undefined) args.push("--remove-label", `${prefix}:${current}`);
      args.push("--add-label", `${prefix}:${next}`);
    }
  }
  return args.length > 2 ? args : null;
}

// ── multi-bead transactions (`bd batch`, anton-aijz) ──
//
// A sequence of independent `bd` calls can fail half-way and strand a unit in a state no reader can
// interpret — half a merged epic closed, half a cascade abandoned. `bd batch` reads its commands
// from stdin and applies them inside ONE dolt transaction: on any error the whole batch rolls back.

/**
 * One line of a `bd batch` transaction. Only the two verbs anton's multi-bead mutations need —
 * bd's grammar also accepts `create` and `dep`, deliberately left out (anton-aijz out of scope).
 */
export type BatchOp =
  | { op: "close"; id: string; reason?: string }
  | { op: "update"; id: string; fields: BatchUpdateFields };

/**
 * The ONLY fields bd's batch `update` accepts. Notably NOT labels: every label write (`abandoned`,
 * `stage:*`, `run-lease:*`) has to stay its own `bd update` and therefore cannot join a
 * transaction — which is why the abandon path labels FIRST and closes in the batch (see
 * {@link beads.abandonAll}).
 */
export interface BatchUpdateFields {
  status?: string;
  priority?: number;
  title?: string;
  assignee?: string;
}

/** Fixed key order, so an encoded `update` line is deterministic regardless of object literal order. */
const BATCH_UPDATE_KEYS = ["status", "priority", "title", "assignee"] as const;

/**
 * Quote a free-text value for bd's batch tokenizer: whitespace-separated tokens, double-quoted
 * strings whose ONLY escapes are `\"` and `\\`. There is no newline escape and the grammar is one
 * command per line, so embedded newlines collapse to spaces — a multi-line abandon reason keeps
 * every word, not its line breaks.
 */
export function quoteBatchValue(value: string): string {
  return `"${value.replace(/\s+/g, " ").trim().replace(/([\\"])/g, "\\$1")}"`;
}

/** Render one op as a batch line. */
function encodeBatchOp(op: BatchOp): string {
  // A whitespace-bearing id would silently become two tokens (a different command entirely), so it
  // is a bug to report rather than to quote around.
  if (!op.id || /[\s"\\]/.test(op.id)) throw new Error(`bd batch: unusable bead id ${JSON.stringify(op.id)}`);
  if (op.op === "close") {
    const reason = op.reason?.trim();
    return reason ? `close ${op.id} ${quoteBatchValue(reason)}` : `close ${op.id}`;
  }
  const fields = BATCH_UPDATE_KEYS.filter((k) => op.fields[k] !== undefined).map(
    (k) => `${k}=${quoteBatchValue(String(op.fields[k]))}`,
  );
  if (fields.length === 0) throw new Error(`bd batch: update ${op.id} sets no fields`);
  return `update ${op.id} ${fields.join(" ")}`;
}

/** Render batch ops as the line-oriented input `bd batch` reads from stdin. */
export function encodeBatchOps(ops: BatchOp[]): string {
  return ops.map(encodeBatchOp).join("\n") + "\n";
}

/** The argv that applies one batch op on its own — the sequential (non-transactional) fallback. */
export function batchOpArgs(op: BatchOp): string[] {
  if (op.op === "close") {
    const reason = op.reason?.trim();
    return reason ? ["close", op.id, "--reason", reason] : ["close", op.id];
  }
  const args = ["update", op.id];
  for (const key of BATCH_UPDATE_KEYS) {
    const value = op.fields[key];
    if (value !== undefined) args.push(`--${key}`, String(value));
  }
  return args;
}

/**
 * Force the pre-batch sequential path: set `ANTON_BD_BATCH` to `0`/`off`/`false`/`no` for a bd too
 * old to have `batch`, or to bisect a suspected batch bug. Read per call so a change lands without
 * a module reload. Unset (the default) uses the transaction.
 */
export const BD_BATCH_ENV = "ANTON_BD_BATCH";

export function batchEnabled(): boolean {
  const raw = (process.env[BD_BATCH_ENV] ?? "").trim().toLowerCase();
  return raw !== "0" && raw !== "off" && raw !== "false" && raw !== "no";
}

/**
 * Cobra's subcommand-not-found line, verbatim: `Error: unknown command "batch" for "bd"`. bd emits
 * nothing machine-readable for this case, so the whole gate is a heuristic on that one string —
 * kept strict (both quoted operands, and the diagnostic must BE the line, not sit inside one) so no
 * batch line's own text can forge it. bd reports a rolled-back op as `line 1 (close bd-9 "…"): …`,
 * echoing the operation mid-line, so an abandon reason quoting this phrase never anchors here.
 */
const MISSING_BATCH_COMMAND = /^(?:Error:\s*)?unknown command "batch" for "[^"\n]+"\r?$/im;

/**
 * Does this failure mean "this bd has no `batch` subcommand" rather than "the transaction failed"?
 * Only the former may fall back to sequential writes: bd rolls the batch back on every other error,
 * so retrying those one-at-a-time would convert a clean no-op into exactly the half-applied unit
 * the transaction exists to prevent.
 *
 * Each field is tested on its own — concatenating them would let a stderr ending in "unknown
 * command" and an unrelated message supply half the phrase each. An unrecognized variant falls
 * through to "the transaction failed", which is the safe direction: loud, with nothing half
 * applied, and `ANTON_BD_BATCH=0` as the deliberate opt-out. Recheck the pattern above when
 * upgrading bd across a cobra major — a reworded error silently costs the fallback, not safety.
 */
export function isMissingBatchCommand(e: unknown): boolean {
  const err = e as { stderr?: unknown; message?: unknown } | null | undefined;
  return [err?.stderr, err?.message].some(
    (field) => typeof field === "string" && MISSING_BATCH_COMMAND.test(field),
  );
}

/** Age scope for `beads.prune`: a relative window bd accepts, or "all" (every closed bead). */
export type PruneAge = "30d" | "90d" | "all";

/**
 * Pure argv builder for `bd prune`, exposed for testing (like buildUpdateArgs). bd requires
 * `--older-than` OR `--pattern` as a safety gate; "all" maps to `--pattern '*'` (sweep every
 * closed bead). Preview is `--dry-run`; only `force` actually deletes.
 */
export function buildPruneArgs(age: PruneAge, opts: { force?: boolean } = {}): string[] {
  return [
    "prune",
    ...(age === "all" ? ["--pattern", "*"] : ["--older-than", age]),
    opts.force ? "--force" : "--dry-run",
    "--json",
  ];
}
