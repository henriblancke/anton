/**
 * The single place anton talks to beads (bd). beads is the git-shareable source of truth for
 * work: epics/tickets, and — via labels + external-ref — approval, stage, and the PR link.
 * anton reads/writes here and never duplicates that state in anton.db. See DESIGN.md §3.
 */
import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { githubRepoSlug } from "../git/remote";
import { resolveBdBin } from "./bd-bin";
import { withBeadWriteLock } from "./claim-lock";
import { isPipelineArtifact } from "./contract";
import { invalidateIssueSnapshot } from "./snapshot";

// Bead/BeadDep live in the leaf ./types module so snapshot.ts can share them without importing
// bd.ts back (breaking the bd ↔ snapshot cycle, anton-mur). Re-exported here so every existing
// `from ".../beads/bd"` import keeps working.
export type { Bead, BeadDep } from "./types";
import type { Bead } from "./types";

export const LABELS = {
  approved: "approved",
  stage: (s: "implementing" | "in-review") => `stage:${s}`,
  source: (s: string) => `source:${s}`,
  /**
   * Won't-do outcome (anton-6xj0). beads has no `cancelled` status, so an abandoned bead is
   * `closed` + this label: the history/contract survives (unlike delete) while the label keeps it
   * from reading as shipped (unlike a plain close). Every "was this delivered?" check must consult
   * it — see beads.isAbandoned.
   */
  abandoned: "abandoned",
  /**
   * Cross-machine run-liveness lease (anton-jz1): `run-lease:<expiresAtEpochMs>[:<ownerRunId>]` on
   * the run target. Present + unexpired ⇒ a run is actively executing this epic on SOME machine, so
   * a Force run started elsewhere must not spawn a second concurrent run. This is the shared
   * (beads/dolt) mirror of the machine-local jobs lease: the `jobs` table is disposable and
   * per-machine, so it can't stop machine B double-running an epic already live on machine A.
   * Heartbeat-refreshed by execute-epic while the run is executing; cleared when the run settles;
   * an EXPIRED lease is ignored so a crashed/killed machine's run is re-triggerable (a stuck
   * `stage:implementing` label alone would otherwise wedge Force run — its whole purpose). The
   * optional `:<ownerRunId>` suffix identifies the publishing run so a resuming handler can tell its
   * OWN crash leftover (safe to sweep) from another machine's live lease (a park condition). See
   * DESIGN.md §3 (state by shareability).
   */
  runLease: (expiresAtMs: number, owner?: string) =>
    owner ? `run-lease:${expiresAtMs}:${owner}` : `run-lease:${expiresAtMs}`,
  /**
   * Latest pre-PR self-review score on a run target (anton-omum): `review-score:<0-10>`. A state
   * label, not a bd custom status — divergent label writes merge clean while divergent status
   * writes hard-wedge Dolt sync (docs/design/2026-07-30-custom-statuses-vs-stage-labels.md).
   * Written prefix-diffed (remove the old value, add the new) in one update like `stage:*`, so the
   * dimension stays single-valued; the full per-round history lives in the append-only score
   * comments beside it.
   */
  reviewScore: (score: number) => `review-score:${score}`,
} as const;

/** Prefix of the run-lease label (see LABELS.runLease). */
const RUN_LEASE_PREFIX = "run-lease:";

/** Prefix of the review-score label (see LABELS.reviewScore). */
const REVIEW_SCORE_PREFIX = "review-score:";

/**
 * Shape of a GitHub PR pointer (`gh-<number>`). The ONLY `external_ref` value anton treats as a PR:
 * the getPrRef fallback honors it until the one-time migration (anton-ftar) moves it to metadata.pr,
 * and that migration clears external_ref ONLY for refs matching this — a tracker URL is left alone.
 */
export const GH_PR_REF = /^gh-\d+$/i;

/**
 * Parse a `run-lease:<expiry>[:<owner>]` label into its expiry (ms epoch) and optional owner (the
 * publishing run's id, anton-jz1). `expiry` is undefined for a malformed/non-numeric value. A label
 * with no `:<owner>` suffix (legacy format, or a liveness-only publish) parses `owner: undefined`.
 */
function parseRunLease(label: string): { expiry: number | undefined; owner: string | undefined } {
  const rest = label.slice(RUN_LEASE_PREFIX.length);
  const sep = rest.indexOf(":");
  const expStr = sep === -1 ? rest : rest.slice(0, sep);
  const owner = sep === -1 ? undefined : rest.slice(sep + 1) || undefined;
  const n = Number(expStr);
  return { expiry: Number.isFinite(n) ? n : undefined, owner };
}

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

/**
 * Wall-clock budget for ONE `bd` invocation. Note what it does NOT bound: it is a per-step budget,
 * so a full sync pass (pull → commit → push) may legitimately spend 3× it. Callers that need a
 * bounded PASS must add their own deadline on top (see beatDeadlineMs in sync-engine.ts).
 */
export const BD_STEP_TIMEOUT_MS = 60_000;

/** Override the per-step budget (tests shrink it; also an ops escape hatch). Read per call so a
 * change lands without a module reload. */
export const BD_STEP_TIMEOUT_ENV = "ANTON_BD_STEP_TIMEOUT_MS";

/** Override the SIGTERM→SIGKILL grace (tests shrink it). Read per call. */
export const BD_KILL_GRACE_ENV = "ANTON_BD_KILL_GRACE_MS";

/**
 * How long a bd that blew its budget gets to unwind on SIGTERM before SIGKILL. bd traps SIGTERM to
 * release the exclusive Dolt lock, so the polite signal comes first — but a bd that then blocks on
 * its own wedged `git fetch` survived that SIGTERM in the field for days, so the escalation is
 * mandatory, not optional (anton-jfjw.1).
 */
const DEFAULT_BD_KILL_GRACE_MS = 5_000;

/**
 * How long to keep draining stdio after bd exits. `close` is the only event that guarantees the
 * pipes drained, but a grandchild that inherited them holds them open long after bd is gone — and
 * waiting on it is exactly what left the caller's promise pending for days while a heartbeat sat
 * wedged. So `exit` starts a bounded drain and the promise settles either way. A normal bd exits
 * with nothing else holding the pipes, so `close` lands immediately and this never comes into play.
 */
const DRAIN_AFTER_EXIT_MS = 2_000;

/** Output ceiling per stream, carried over from the execFile `maxBuffer` this replaced: a runaway
 * stream is killed rather than grown until the server OOMs. A whole-board `bd list --json` is
 * comfortably under it. */
const BD_MAX_BUFFER = 32 * 1024 * 1024;

/** Override the per-stream output ceiling (tests shrink it so the overflow path is exercisable
 * without producing 32 MB). Read per call, like the budget and the kill grace. */
export const BD_MAX_BUFFER_ENV = "ANTON_BD_MAX_BUFFER";

function stepTimeoutMs(): number {
  const raw = Number(process.env[BD_STEP_TIMEOUT_ENV]);
  return Number.isFinite(raw) && raw > 0 ? raw : BD_STEP_TIMEOUT_MS;
}

function maxBuffer(): number {
  const raw = Number(process.env[BD_MAX_BUFFER_ENV]);
  return Number.isFinite(raw) && raw > 0 ? raw : BD_MAX_BUFFER;
}

function killGraceMs(): number {
  const raw = Number(process.env[BD_KILL_GRACE_ENV]);
  return Number.isFinite(raw) && raw >= 0 ? raw : DEFAULT_BD_KILL_GRACE_MS;
}

/** Per-invocation knobs for {@link bd}: extra env, and stdin for the commands that read it. */
interface BdOpts {
  /** Merged over `process.env` (e.g. BEADS_ACTOR for an attributed write). An `undefined` value
   * REMOVES the variable rather than inheriting the server's — see {@link childEnv}. */
  env?: Record<string, string | undefined>;
  /** Written to bd's stdin, which is then closed. Required by `bd batch`, which reads its
   * commands from stdin — without it bd would block on an open pipe until the step budget. */
  stdin?: string;
}

/**
 * The server's env with `overrides` applied, where an `undefined` override REMOVES the variable
 * rather than leaving whatever the server was launched with. That deletion is the point: a gate call
 * that can't derive a slug must not inherit an ambient `GH_REPO`, which would override `gh`'s repo
 * resolution and answer this project's gates with another repository's verdict.
 */
function childEnv(overrides: Record<string, string | undefined>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, ...overrides };
  for (const [key, value] of Object.entries(overrides)) if (value === undefined) delete env[key];
  return env;
}

/**
 * Run one `bd` command and return its stdout.
 *
 * Two properties this owes its callers, both learned the hard way (anton-jfjw.1 — a `bd dolt pull`
 * whose `git fetch` entered uninterruptible wait when the network died under it, leaving the parent
 * alive for two days, the Dolt lock held, and anton's heartbeat pinned forever):
 *
 * 1. **The reap targets the process group.** bd's own git/dolt children are what actually wedge, and
 *    signalling only bd leaves them running — still holding the exclusive Dolt lock that then fails
 *    every later `bd list` in that repo. So bd leads its own group and the budget kills the group,
 *    escalating SIGTERM → SIGKILL.
 * 2. **The promise settles on `exit`, not on stdio `close`.** A leaked grandchild holds the inherited
 *    pipes open, so `close` may never fire; and past the budget the caller is released immediately —
 *    the reap runs on in the background, because a grandchild in uninterruptible wait can survive
 *    even SIGKILL and must not be able to hold a caller hostage while it does.
 *
 * `async` so a resolveBdBin() failure (no bd on the box) surfaces as a rejection rather than a
 * synchronous throw — every call site awaits or `.catch()`es this.
 */
async function bd(cwd: string, args: string[], opts?: BdOpts): Promise<string> {
  // Spawn bd by its resolved absolute path (anton-346): a background-launched server's PATH may not
  // reach bd's install dir, so a bare `spawn("bd", …)` fails with `spawn bd ENOENT`.
  const bin = resolveBdBin();
  const budgetMs = stepTimeoutMs();
  const bufferLimit = maxBuffer();
  const startedAt = Date.now();

  return new Promise<string>((resolve, reject) => {
    const child = spawn(bin, args, {
      cwd,
      // POSIX: make bd the leader of a new process group so the whole tree is reachable as one.
      detached: process.platform !== "win32",
      ...(opts?.env ? { env: childEnv(opts.env) } : {}),
    });

    if (opts?.stdin !== undefined) {
      // EPIPE is expected whenever bd rejects its input and exits before draining the pipe (a batch
      // whose first line is malformed): the exit code carries the verdict, so the write error is
      // noise. Ignoring it keeps the real failure — bd's own stderr — as the one the caller sees.
      child.stdin?.on("error", () => {});
      child.stdin?.end(opts.stdin);
    }

    // StringDecoder, not per-chunk toString: a multi-byte character split across two chunks would
    // otherwise corrupt the JSON every read path parses.
    const outDecoder = new StringDecoder("utf8");
    const errDecoder = new StringDecoder("utf8");
    let stdout = "";
    let stderr = "";
    let settled = false;
    let drainTimer: NodeJS.Timeout | undefined;
    let escalateTimer: NodeJS.Timeout | undefined;

    const killGroup = (sig: NodeJS.Signals) => {
      if (process.platform !== "win32" && child.pid) {
        try {
          process.kill(-child.pid, sig);
          return;
        } catch {
          // The group may never have formed (spawn failed, or the leader is already reaped) — fall
          // back to the direct child handle so the reap still reaches bd itself.
        }
      }
      child.kill(sig);
    };

    const settle = (emit: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(budgetTimer);
      if (drainTimer) clearTimeout(drainTimer);
      emit();
    };

    /** Drop the pipes a leaked grandchild is still holding — nothing will read them again. */
    const dropPipes = () => {
      child.stdout?.destroy();
      child.stderr?.destroy();
    };

    /**
     * execFile-shaped failure for a non-zero exit: promisified execFile attached the captured
     * streams to the error, and runDoltSync's benign/first-publish matchers read them off it.
     */
    const exitFailure = (code: number | null, signal: NodeJS.Signals | null) =>
      Object.assign(new Error(`Command failed: ${[bin, ...args].join(" ")}\n${stderr}`), {
        cmd: [bin, ...args].join(" "),
        code: code ?? undefined,
        signal,
        killed: child.killed,
        stdout,
        stderr,
      });

    const finish = (code: number | null, signal: NodeJS.Signals | null) => {
      // Flush whatever the decoders held back (an output that ends mid-character), as execFile did.
      stdout += outDecoder.end();
      stderr += errDecoder.end();
      if (code === 0) resolve(stdout);
      else reject(exitFailure(code, signal));
    };

    const budgetTimer = setTimeout(() => {
      killGroup("SIGTERM");
      // The escalation deliberately outlives the promise (as in runShell): the caller unwinds now,
      // while the group still gets killed. Cleared as soon as bd actually exits.
      escalateTimer = setTimeout(() => killGroup("SIGKILL"), killGraceMs());
      settle(() => {
        dropPipes();
        // Partial stdout/stderr is deliberately NOT attached: a wedged step's captured output is
        // startup noise, and runDoltSync prefers it over the message — which would bury the real
        // cause exactly as it did for stringer (anton-be1s).
        reject(
          Object.assign(
            new Error(
              `bd ${args.join(" ")} in ${cwd} exceeded its ${budgetMs}ms budget ` +
                `(elapsed ${Date.now() - startedAt}ms) and its process group was killed. ` +
                `bd or a child of it (typically \`git fetch\` against an unreachable remote) hung; ` +
                `if it held the Dolt lock, later bd calls in this repo may fail until the tree is gone.`,
            ),
            { killed: true, signal: "SIGTERM" as NodeJS.Signals },
          ),
        );
      });
    }, budgetMs);

    /** maxBuffer parity: kill the tree and reject rather than buffer without bound. */
    const overflow = (stream: "stdout" | "stderr") => {
      killGroup("SIGKILL");
      settle(() => {
        dropPipes();
        reject(
          Object.assign(
            new Error(
              `bd ${args.join(" ")} in ${cwd}: ${stream} exceeded ${bufferLimit} bytes ` +
                `(maxBuffer length exceeded)`,
            ),
            { code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER", killed: true, stdout, stderr },
          ),
        );
      });
    };

    child.stdout?.on("data", (c: Buffer) => {
      stdout += outDecoder.write(c);
      if (stdout.length > bufferLimit) overflow("stdout");
    });
    child.stderr?.on("data", (c: Buffer) => {
      stderr += errDecoder.write(c);
      if (stderr.length > bufferLimit) overflow("stderr");
    });

    // `spawn bd ENOENT` and friends — bd never ran, so there is no group to reap.
    child.on("error", (err) => settle(() => reject(err)));

    // The fast path for every healthy call: `close` follows `exit` immediately when nothing else
    // holds the pipes, so stdout is complete and capture is byte-identical to the execFile it replaced.
    child.on("close", (code, signal) => settle(() => finish(code, signal)));

    child.on("exit", (code, signal) => {
      if (escalateTimer) clearTimeout(escalateTimer); // bd is gone; no SIGKILL needed
      if (settled) return; // already timed out (or overflowed) — the caller has its verdict
      drainTimer = setTimeout(
        () =>
          settle(() => {
            dropPipes();
            finish(code, signal);
          }),
        DRAIN_AFTER_EXIT_MS,
      );
    });
  });
}

/**
 * Test-only handle on the single bd invoker (anton-jfjw.1): the process-lifecycle suite drives real
 * fake-`bd` scripts through it to prove the group reap and the settle-on-exit contract. Production
 * code goes through the `beads` object.
 */
export const runBdForTest = bd;

async function bdWrite(cwd: string, args: string[], opts?: BdOpts): Promise<string> {
  const stdout = await bd(cwd, args, opts);
  // Mark the snapshot stale (keeping last-good data) and force a fresh post-write read, so the
  // next board read never blocks on a cold `bd list` queued behind the Dolt lock.
  invalidateIssueSnapshot(cwd, true);
  return stdout;
}

type BdExec = typeof bd;

// ── Dolt sync: push every bd write to the remote explicitly (anton-nyf) ──
//
// refs/dolt/data only moves when `bd dolt push` runs; git hooks are per-machine and don't fire
// for anton's own writes, so every write path syncs explicitly through here.

/**
 * Benign sync outcomes that must NOT fail a sync: a clean working set ("Nothing to commit.")
 * and a workspace with no Dolt remote ("No remote is configured — skipping."). Current bd exits
 * 0 for both; the matcher keeps sync tolerant if a bd version turns them into errors.
 */
const BENIGN_SYNC_OUTPUT = [/nothing to commit/i, /no remotes? (?:is )?configured/i];

export function isBenignSyncOutput(output: string): boolean {
  return BENIGN_SYNC_OUTPUT.some((re) => re.test(output));
}

/**
 * A workspace with no Dolt remote — not an error, but a distinct visible state (not-wired): the
 * board must show "not wired to a shared remote" rather than pretending it's synced.
 *
 * bd words the SAME condition differently per verb: `dolt push` prints "No remote is configured —
 * skipping.", while `dolt pull` fails with dolt's own `fetch from origin/main: Error 1105: no
 * remote`. Matching only the push wording left a solo board reading as `failing` on every heartbeat
 * pull, and would have failed a verified claim closed on a board that has no second machine to race
 * (anton-9anc). The pull pattern is deliberately strict — the whole `fetch from <ref>: Error <n>: no
 * remote` shape, and it must END the line, so a genuine fetch failure that merely starts that way
 * ("… no remote branch found") can't be read as "this workspace has no remote".
 */
const NOT_WIRED_OUTPUT = [
  /no remotes? (?:is )?configured/i,
  /fetch from \S+: Error \d+: no remote\s*$/im,
];

export function isNotWiredOutput(output: string): boolean {
  return NOT_WIRED_OUTPUT.some((re) => re.test(output));
}

/**
 * The ONLY `bd dolt pull` failure that is benign: a never-pushed remote has no refs/dolt/data yet,
 * so the first pull finds no dolt branches on the remote ("no branches found in remote", or on some
 * git backends "couldn't find remote ref"). In a full pass the push that follows publishes it; on a
 * heartbeat it just means "nothing to pull yet" and must NOT mark the project failing. Every OTHER
 * pull failure (auth, network, unreachable remote, dirty local state, real divergence) must reject —
 * in a full pass, before push — or a pass that never applied inbound changes could still be recorded
 * as "synced" whenever the trailing push happens to be a no-op (anton-live-sync review).
 */
const FIRST_PUBLISH_PULL_OUTPUT = [
  /no branches found in remote/i,
  /(?:could ?n['’]t|could not) find remote ref/i,
  /remote ref .*does not exist/i,
];

export function isFirstPublishPullOutput(output: string): boolean {
  return FIRST_PUBLISH_PULL_OUTPUT.some((re) => re.test(output));
}

// ── Sync status registry (anton-live-sync) ──
//
// Keyed on globalThis via Symbol.for: the instrumentation-started sync engine and Next.js API
// route handlers can load DIFFERENT compiled instances of this module (separate bundles), so a
// plain module-level Map would leave routes reading an empty registry forever.

export type SyncState = "unknown" | "not-wired" | "syncing" | "stalled" | "synced" | "failing";

export interface SyncStatus {
  state: SyncState;
  /** ms epoch of the last successful pass (pull OR push); survives later failures for "last synced Xs ago". */
  lastSyncedAt: number | null;
  /** ms epoch of the last successful PUSH. Distinct from lastSyncedAt: a pull-only pass moves
   * lastSyncedAt but NOT this, so "unpushed for a while" is visible even while pulls keep succeeding. */
  lastPushedAt: number | null;
  /** Write-nudged full passes that committed new local work but failed to push, since the last
   * successful push — the count of local changes queued for the backstop to retry. 0 when the repo
   * is caught up with its remote; >0 means work is queued locally. Backstop retries never grow it:
   * they re-attempt already-counted commits, so a flaky remote can't inflate one stranded change
   * into "N unpushed". */
  unpushedCount: number;
  lastError: string | null;
  /** How long the pass has been pinned at `syncing`, once past the staleness window. Non-null only
   * for state `stalled` — it is what lets the badge say "stuck 4h" instead of spinning forever. */
  stalledForMs: number | null;
}

/** What the registry actually stores. `stalled` is never written — it is derived on read from
 * `syncingSince`, so a wedged process (which by definition runs no more code) still ages out. */
interface SyncRecord extends Omit<SyncStatus, "stalledForMs"> {
  /** ms epoch this pass stamped `syncing`; null in every terminal state. The stall clock. */
  syncingSince: number | null;
}

/**
 * How long a pass may sit in `syncing` before the registry reads it as `stalled`. A hang is not a
 * rejection: nothing throws, so the `.catch` that records `failing` never runs and the repo would
 * otherwise stay pinned at `syncing` forever — the anton-jfjw.3 defect, where two boards were
 * un-syncable for days with nothing anywhere saying so. Ten missed heartbeats (30s each): long
 * enough that a genuinely slow pull over a big board is not flagged, short enough that an operator
 * sees the stall in minutes rather than days. `ANTON_SYNC_STALL_MS` overrides it (read per call so
 * a change lands without a module reload).
 */
export const SYNC_STALL_MS = 300_000;

function stallWindowMs(): number {
  const raw = Number(process.env.ANTON_SYNC_STALL_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : SYNC_STALL_MS;
}

const SYNC_STATUS_KEY = Symbol.for("anton.beads.syncStatus");
const SYNC_STALL_LOGGED_KEY = Symbol.for("anton.beads.syncStallLogged");

function statusRegistry(): Map<string, SyncRecord> {
  const g = globalThis as unknown as Record<symbol, Map<string, SyncRecord> | undefined>;
  return (g[SYNC_STATUS_KEY] ??= new Map());
}

/** cwd → the `syncingSince` of the stall already logged, so a stall is announced once per
 * occurrence rather than once per read (the board polls getSyncStatus every few seconds). */
function stallLogRegistry(): Map<string, number> {
  const g = globalThis as unknown as Record<symbol, Map<string, number> | undefined>;
  return (g[SYNC_STALL_LOGGED_KEY] ??= new Map());
}

function rawStatus(cwd: string): SyncRecord {
  return (
    statusRegistry().get(cwd) ?? {
      state: "unknown",
      lastSyncedAt: null,
      lastPushedAt: null,
      unpushedCount: 0,
      lastError: null,
      syncingSince: null,
    }
  );
}

/**
 * The repo's sync health, with a wedged pass aged out of `syncing` into `stalled`. Every consumer
 * of the registry reads through here, so the backstop needs no timer and no cooperation from the
 * hung pass itself — which is the point: the process that would have reported the failure is the
 * one that is stuck. `now` is injectable for tests.
 */
export function getSyncStatus(cwd: string, now: number = Date.now()): SyncStatus {
  const { syncingSince, ...view } = rawStatus(cwd);
  if (view.state !== "syncing" || syncingSince === null) return { ...view, stalledForMs: null };
  const stuckForMs = now - syncingSince;
  if (stuckForMs < stallWindowMs()) return { ...view, stalledForMs: null };
  logStallOnce(cwd, syncingSince, stuckForMs, view.lastSyncedAt);
  return { ...view, state: "stalled", stalledForMs: stuckForMs };
}

/** One line per distinct stall, matching sync-engine's log-on-change discipline — an operator
 * tailing the console sees the wedge without running `ps`, and a polling board doesn't flood it. */
function logStallOnce(
  cwd: string,
  syncingSince: number,
  stuckForMs: number,
  lastSyncedAt: number | null,
): void {
  const logged = stallLogRegistry();
  if (logged.get(cwd) === syncingSince) return;
  logged.set(cwd, syncingSince);
  const mins = Math.round(stuckForMs / 60_000);
  const lastSynced =
    lastSyncedAt === null ? "never synced" : `last synced ${new Date(lastSyncedAt).toISOString()}`;
  console.error(
    `[beads.sync] ${cwd} has been stuck in 'syncing' for ${mins}m with no completion and no ` +
      `error — the sync pass is wedged (${lastSynced}).`,
  );
}

/**
 * Compact token for board refreshes. Repeated successful heartbeats do not change it, while every
 * user-visible health transition does (including gaining the first successful-sync timestamp and any
 * change to the unpushed-backlog count, which the badge renders). While stalled it also advances
 * once a minute: the badge renders a server-computed "stuck Xm", which would otherwise freeze at
 * the value captured when the stall was first detected — exactly the frozen-truth failure this
 * state exists to fix.
 */
export function getSyncStatusToken(cwd: string, now: number = Date.now()): string {
  const status = getSyncStatus(cwd, now);
  const seen = status.lastSyncedAt === null ? "never" : "seen";
  const stuck = status.stalledForMs === null ? "" : `:${Math.floor(status.stalledForMs / 60_000)}`;
  return `${status.state}:${seen}:${status.unpushedCount}:${status.lastError ?? ""}${stuck}`;
}

function recordStatus(cwd: string, patch: Partial<SyncRecord>): void {
  const next = { ...rawStatus(cwd), ...patch };
  // Single owner of the stall clock: it starts the moment a pass stamps `syncing` and is cleared by
  // any terminal state, so `syncingSince` always means "the pass currently in flight began here".
  if (patch.state !== undefined) next.syncingSince = patch.state === "syncing" ? Date.now() : null;
  statusRegistry().set(cwd, next);
}

/**
 * Concrete sync passes runDoltSync executes. "full" (write-nudged): pull → commit → push.
 * "pull": pull only — the heartbeat's default, which must NOT push when there are no local
 * changes; every anton instance pushing a shared remote every ~10s is the concurrent-push
 * manifest-corruption pattern (beads GH#2466).
 */
export type SyncMode = "full" | "pull";

/**
 * What the coalescer accepts. "backstop" is the heartbeat's push safety net (anton-sr8f): the
 * coalescer resolves it to "full" when the repo has unpushed local commits (a prior push failed) OR
 * has not yet been reconciled by this process (a cold start after a crash can't trust the in-memory
 * backlog count), and to "pull" otherwise — so stranded commits are always retried until they land,
 * while a caught-up, reconciled repo stays quiet. Routes through the same per-repo coalescer as
 * "full"/"pull", so a backstop push can never overlap a write-nudged one (beads GH#2466).
 *
 * "push" is the durable sync-push job's request (anton-nowq): it ALWAYS runs a full push pass to
 * retry the write's commit, but — unlike "full" — never grows the unpushed backlog (its work is
 * already counted by the write-nudged pass). "backstop" is wrong for the job: it snapshots
 * `unpushedCount` at call time and, if it coalesces behind a still-in-flight write push, reads 0 and
 * drops to pull-only — so a push that then fails goes unretried by the very job meant to retry/park
 * it. "push" forces the retry unconditionally without the count-inflation "full" would cause.
 */
export type SyncRequest = SyncMode | "backstop" | "push";

export type SyncOutcome = "synced" | "not-wired";

/**
 * One sync pass. Full mode: `bd dolt pull` (remote changes land locally, and pull-before-push
 * shrinks divergence windows), then `bd dolt commit` (a no-op under dolt.auto-commit, but
 * catches externally-made changes), then `bd dolt push`. Pull mode runs only the pull.
 *
 * Outcomes: benign steps are skipped; a workspace with no remote resolves "not-wired" and stops
 * the pass. A pull failure in FULL mode is tolerated (a never-pushed remote has no refs/dolt
 * yet — the push that follows publishes it); a real commit/push failure (auth, network, remote
 * conflict) rejects with the bd output attached — callers surface it, never swallow it.
 * `exec` is injectable for tests.
 *
 * No explicit `bd recompute-blocked` here: bd 1.1.0 recomputes the denormalized `is_blocked` flag
 * automatically on every pull, scoped to what the merge changed, so `bd ready` never reads a stale
 * flag on the hot sync path. The unconditional repair (`bd recompute-blocked`) is reserved for the
 * places that gap can't reach — a freshly bootstrapped clone that never ran a local merge (see
 * configureBeadsForRepo in config.mjs) — rather than paid on every heartbeat pull.
 */
export async function runDoltSync(
  cwd: string,
  exec: BdExec = bd,
  mode: SyncMode = "full",
): Promise<SyncOutcome> {
  const steps =
    mode === "pull"
      ? [["dolt", "pull"]]
      : [
          ["dolt", "pull"],
          ["dolt", "commit"],
          ["dolt", "push"],
        ];
  for (const args of steps) {
    try {
      await exec(cwd, args);
    } catch (e) {
      const err = e as Error & { stdout?: string; stderr?: string };
      const output = `${err.stderr ?? ""}\n${err.stdout ?? ""}`.trim() || err.message;
      if (isNotWiredOutput(output)) return "not-wired";
      if (isBenignSyncOutput(output)) continue;
      // A pull tolerates ONLY the first-publish case (a never-pushed remote has no dolt branches
      // yet): in a full pass the push that follows publishes them; on a heartbeat it's just
      // "nothing to pull yet". Any OTHER pull failure (auth, network, unreachable remote, dirty
      // local state, real divergence) rejects here — in a full pass, before push — so a pass that
      // never applied inbound changes is never silently recorded as "synced" on a no-op push.
      if (args[1] === "pull" && isFirstPublishPullOutput(output)) continue;
      throw new Error(`bd ${args.join(" ")} failed in ${cwd}: ${output}`, { cause: e });
    }
  }
  return "synced";
}

/**
 * Coalescing wrapper around runDoltSync, keyed by cwd: while a sync runs, every request that
 * arrives shares ONE trailing sync (which starts after the current one and therefore sees all
 * their writes) — a burst of writes costs one extra push, not one each. A "pull" request
 * piggybacks on any in-flight or queued pass (full ⊃ pull); a "full" request upgrades a queued
 * pull-only trailing pass. Updates the sync status registry on every pass. Exported for testing.
 *
 * Also tracks the per-repo unpushed backlog on the sync-status registry (anton-sr8f, anton-rn88): a
 * write-nudged full pass that fails to reach "synced" committed new local work it couldn't push, so
 * the repo is left ahead of its remote — recorded as `unpushedCount > 0`. A backstop retry that also
 * fails does NOT grow the count: it re-attempts the same stranded commits and adds no new work, so a
 * flaky remote can't inflate one change into "N unpushed". That count lets a "backstop" request (the
 * heartbeat) resolve to a push-retry while a caught-up repo stays pull-only, and it is the
 * operator-visible "N unpushed" surface. A full pass that reaches "synced"/"not-wired" clears the
 * count and stamps `lastPushedAt` (nothing left to push).
 *
 * Resolves with the pass's `SyncOutcome` so callers can tell delivery from non-delivery: a
 * "not-wired" repo has no remote to publish to, so the write is still only local. The durable
 * sync-push job depends on that distinction — resolving void would let it settle `done` on work it
 * never delivered (anton-x7la review). Coalesced callers share the outcome of the pass that covers
 * them, which is the pass their own request ran in.
 */
export function createDoltSync(
  exec: BdExec = bd,
): (cwd: string, mode?: SyncRequest) => Promise<SyncOutcome> {
  const running = new Map<string, Promise<SyncOutcome>>();
  const trailing = new Map<string, { promise: Promise<SyncOutcome>; mode: SyncMode }>();
  const trailingMode = new Map<string, SyncMode>(); // live handle so an upgrade reaches the queued run
  const trailingNewWork = new Map<string, boolean>(); // did any queued request carry new local work?

  // Repos whose backlog this process has reconciled against the remote — a full pass has pushed
  // (or resolved not-wired) at least once. `unpushedCount` lives only in memory, so after a restart
  // a repo left ahead by a crashed process reads count 0; until reconciled, a backstop must run a
  // full pass rather than trust that 0 to mean "caught up" and pull forever (anton-z908 review).
  const reconciled = new Set<string>();

  // `newWork` is true only for a write-nudged full pass, which may carry a genuinely new local
  // commit. A backstop retry (newWork=false) re-attempts already-counted work and commits nothing
  // new, so it must never grow the backlog — otherwise a flaky remote turns one stranded change into
  // "N unpushed" after N failed retries (anton-rn88 review).
  const start = (cwd: string, mode: SyncMode, newWork: boolean): Promise<SyncOutcome> => {
    recordStatus(cwd, { state: "syncing" });
    const p = runDoltSync(cwd, exec, mode).then((outcome) => {
      if (outcome === "not-wired") {
        recordStatus(cwd, { state: "not-wired", lastError: null });
        reconciled.add(cwd); // no remote to reconcile against — stop forcing full backstop passes
      } else {
        // Retain the last valid data while a background read refreshes after the remote pull.
        invalidateIssueSnapshot(cwd);
        const now = Date.now();
        // A full pass pushed everything — stamp the push and clear the backlog. A pull-only pass
        // moves lastSyncedAt but leaves lastPushedAt/unpushedCount alone (it never pushes).
        recordStatus(cwd, {
          state: "synced",
          lastSyncedAt: now,
          lastError: null,
          ...(mode === "full" ? { lastPushedAt: now, unpushedCount: 0 } : {}),
        });
        if (mode === "full") reconciled.add(cwd); // a full pass pushed — the backlog is reconciled
      }
      return outcome;
    });
    running.set(cwd, p);
    // Bookkeeping only — callers hold `p` and see its rejection; this chain must not re-reject.
    void p
      .catch((e: Error) => {
        // A write-nudged full pass committed new work but never landed its push — grow the unpushed
        // backlog so the next heartbeat backstop retries, and the operator sees a truthful "N
        // unpushed" count instead of the failure hiding in server logs. A backstop retry (newWork
        // false) or a pull-only failure leaves the count as-is: the stranded work is already counted.
        const patch: Partial<SyncRecord> = { state: "failing", lastError: e.message };
        if (mode === "full" && newWork) patch.unpushedCount = getSyncStatus(cwd).unpushedCount + 1;
        recordStatus(cwd, patch);
      })
      .finally(() => {
        if (running.get(cwd) === p) running.delete(cwd);
      });
    return p;
  };

  return function sync(cwd: string, request: SyncRequest = "full"): Promise<SyncOutcome> {
    // Resolve the backstop to a push-retry when a prior push failed (recorded backlog) OR when this
    // process has not yet reconciled the repo — the backlog is in-memory only, so a cold start after
    // a crash that stranded local commits reads count 0 and must NOT pull forever without shipping
    // them (anton-z908 review). A caught-up, already-reconciled repo stays pull-only and quiet.
    const mode: SyncMode =
      request === "backstop"
        ? getSyncStatus(cwd).unpushedCount > 0 || !reconciled.has(cwd)
          ? "full"
          : "pull"
        : request === "push"
          ? "full" // durable job: always retry the push, regardless of the (possibly stale) count
          : request;
    // Only a write-nudge introduces new local work; a backstop or durable "push" retry re-attempts
    // already-counted commits and must never inflate the backlog (anton-rn88).
    const newWork = request === "full";
    const queued = trailing.get(cwd);
    if (queued) {
      if (mode === "full") trailingMode.set(cwd, "full");
      if (newWork) trailingNewWork.set(cwd, true); // a coalesced write carries new work into the pass
      return queued.promise;
    }
    const current = running.get(cwd);
    if (!current) return start(cwd, mode, newWork);
    trailingMode.set(cwd, mode);
    trailingNewWork.set(cwd, newWork);
    const next = current
      .catch(() => {}) // the current run's failure belongs to its own callers
      .then(() => {
        trailing.delete(cwd);
        const m = trailingMode.get(cwd) ?? "full";
        const nw = trailingNewWork.get(cwd) ?? false;
        trailingMode.delete(cwd);
        trailingNewWork.delete(cwd);
        return start(cwd, m, nw);
      });
    trailing.set(cwd, { promise: next, mode });
    return next;
  };
}

// The singleton is globalThis-anchored for the same cross-bundle reason as the status registry:
// two module instances with separate coalescing maps would defeat the never-overlap invariant.
const DOLT_SYNC_KEY = Symbol.for("anton.beads.doltSync");
const doltSync = ((globalThis as unknown as Record<symbol, ReturnType<typeof createDoltSync>>)[
  DOLT_SYNC_KEY
] ??= createDoltSync());

/**
 * bd --json returns either a top-level array or a `{ <key>: [...] }` envelope. Normalize to an
 * array. `molecules` is `bd ready --gated`'s envelope (`{ count, molecules }`).
 */
function asArray<T>(raw: string): T[] {
  const d = JSON.parse(raw || "[]");
  if (Array.isArray(d)) return d;
  if (d && Array.isArray(d.issues)) return d.issues;
  if (d && Array.isArray(d.results)) return d.results;
  if (d && Array.isArray(d.molecules)) return d.molecules;
  return [];
}

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

// ── gate seam (anton-uk95) ──
//
// A gate is a real bead (`issue_type: gate`) that blocks its step with an ordinary `blocks` edge, so
// an async wait is board-visible state and costs nothing while it waits. `bd gate check` evaluates
// open timer/GitHub gates and closes the satisfied ones.
//
// THE INVARIANT EVERY CALL HERE EXISTS TO HOLD: bd is spawned with `cwd` = the project repo, and
// NEVER with `-C`. `bd -C <dir>` changes only which DATABASE bd reads — it does not change the
// process cwd — while the `gh` subprocess bd spawns to evaluate a `gh:run` / `gh:pr` gate resolves
// its repository from that cwd. So `-C` yields a verdict from whatever repo the caller happened to
// start in, in BOTH directions: a green CI run in project A resolves project B's gate (a false
// green), and a failed run in A escalates B's (a false escalation). Proven on bd 1.1.0 and 1.1.2 in
// .product/decisions/2026-07-28-bd-workflow-primitives.md §5; locked in by gate-cwd.integration.test.ts.
// `bd gate discover` draws its candidate runs from the same cwd, so the rule covers it too.

/** Gate flavours `bd gate create --type` accepts. `bead` is deliberately absent — unresolvable here. */
export type GateType = "human" | "timer" | "gh:run" | "gh:pr";

/** What `bd gate check --type` may be scoped to: one gate type, `gh` (both GitHub types), or all. */
export type GateCheckScope = GateType | "gh" | "bead" | "all";

/** A gate bead, as `bd gate list --json` returns it. */
export interface Gate extends Bead {
  /** The gate's flavour (bd's `await_type`). */
  await_type?: GateType;
  /** The condition identifier — a workflow run id for `gh:run`, a PR number for `gh:pr`. */
  await_id?: string;
  /**
   * Timeout in NANOSECONDS — bd serialises a Go `time.Duration` as an integer, so `--timeout=2h`
   * reads back as 7.2e12. Absent when the gate has no deadline (bd's default: wait forever).
   * {@link gateDeadline} is the only place that converts it.
   */
  timeout?: number;
}

export interface GateCreateOpts {
  /** Bead the gate blocks (required by bd). */
  blocks: string;
  /** Defaults to bd's own default, `human`. */
  type?: GateType;
  /** Workflow run id (`gh:run`) or PR number (`gh:pr`). Omit for a gate `gate discover` will fill. */
  awaitId?: string;
  /** Timer gates only, e.g. `2h`. */
  timeout?: string;
  reason?: string;
}

export interface GateCheckOpts {
  scope?: GateCheckScope;
  /** Report the verdicts without closing anything. */
  dryRun?: boolean;
  /** Also run bd's escalation for failed/expired gates. Escalation does NOT close the gate. */
  escalate?: boolean;
}

export interface GateDiscoverOpts {
  dryRun?: boolean;
  /** Branch whose runs are candidates; bd defaults to the cwd repo's current branch. */
  branch?: string;
  /** Max runs to query from GitHub. */
  limit?: number;
  /** Max age for gate/run matching, e.g. `30m`. */
  maxAge?: string;
}

/**
 * What one `bd gate check` pass did. `errors` is the field that must never be ignored: a gate bd
 * could not evaluate (no `gh`, an API failure) is UNKNOWN — not resolved and not unresolved — so a
 * caller must treat `errors > 0` the way execute-epic treats an unreadable PR state: retry with a
 * counting error rather than reading `resolved: 0` as "still waiting".
 */
export interface GateCheckResult {
  checked: number;
  resolved: number;
  escalated: number;
  errors: number;
  dryRun: boolean;
}

/** One entry of `bd ready --gated` — a molecule whose gate closed, with the step now runnable. */
export interface GatedMolecule {
  molecule_id: string;
  molecule_title?: string;
  closed_gate?: Gate;
  ready_step?: Bead;
}

/** Pure argv builder for `bd gate create`, exposed for testing (like buildUpdateArgs). */
export function buildGateCreateArgs(opts: GateCreateOpts): string[] {
  if (!opts.blocks) throw new Error("bd gate create requires the id of the bead the gate blocks");
  const args = ["gate", "create", "--blocks", opts.blocks];
  if (opts.type) args.push("--type", opts.type);
  if (opts.awaitId) args.push("--await-id", opts.awaitId);
  if (opts.timeout) args.push("--timeout", opts.timeout);
  if (opts.reason) args.push("--reason", opts.reason);
  args.push("--json"); // plain output appends dispatch hints (for `bd sling`, which doesn't exist)
  return args;
}

/** Pure argv builder for `bd gate check`, exposed for testing. */
export function buildGateCheckArgs(opts: GateCheckOpts = {}): string[] {
  const args = ["gate", "check"];
  if (opts.scope) args.push("--type", opts.scope);
  if (opts.dryRun) args.push("--dry-run");
  if (opts.escalate) args.push("--escalate");
  args.push("--json");
  return args;
}

/** Pure argv builder for `bd gate discover`, exposed for testing. */
export function buildGateDiscoverArgs(opts: GateDiscoverOpts = {}): string[] {
  const args = ["gate", "discover"];
  if (opts.dryRun) args.push("--dry-run");
  if (opts.branch) args.push("--branch", opts.branch);
  if (opts.limit !== undefined) args.push("--limit", String(opts.limit));
  if (opts.maxAge) args.push("--max-age", opts.maxAge);
  return args;
}

/**
 * Pull the trailing `--json` object out of a bd stdout that also carries progress lines. `bd gate
 * check --json` prints its per-gate verdicts and a "Checked N gates" summary on STDOUT before the
 * JSON, so a plain JSON.parse of the whole stream throws. Scans candidate `{` offsets from the last
 * back to the first and returns the first that parses, so a future nested summary still lands.
 */
function parseJsonTail(raw: string): unknown {
  // The `i > 0` guard is load-bearing: `lastIndexOf("{", -1)` clamps its start to 0 rather than
  // giving up, so a leading `{` that fails to parse would hand back 0 forever.
  for (let i = raw.lastIndexOf("{"); i >= 0; i = i > 0 ? raw.lastIndexOf("{", i - 1) : -1) {
    try {
      return JSON.parse(raw.slice(i));
    } catch {
      // not the start of the summary object — keep walking left
    }
  }
  return undefined;
}

/**
 * Read a `bd gate check` summary, or THROW. The throw is the point: a check whose result can't be
 * read is the unknown state, and returning zeros would render it as "nothing satisfied yet" — a
 * wait that never ends on a bd whose output format moved. Fail loud instead.
 */
export function parseGateCheck(raw: string): GateCheckResult {
  const s = parseJsonTail(raw) as Record<string, unknown> | undefined;
  if (!s || typeof s.checked !== "number") {
    throw new Error(
      `bd gate check: could not read its --json summary (bd output format changed?) — refusing to ` +
        `report an unreadable check as "no gates resolved". Output: ${raw.slice(0, 200)}`,
    );
  }
  const n = (v: unknown) => (typeof v === "number" ? v : 0);
  return {
    checked: s.checked,
    resolved: n(s.resolved),
    escalated: n(s.escalated),
    errors: n(s.errors),
    dryRun: s.dry_run === true,
  };
}

/**
 * The ONE invoker every gate call goes through. It exists so the cwd invariant cannot be forgotten
 * at a call site: `repo` is bd's spawn cwd (empty is a loud failure, never the server's own cwd),
 * and `GH_REPO` is set alongside it — belt and braces for the case a future call site can't control
 * cwd, since GH_REPO overrides gh's repo resolution outright. A non-github.com origin (or no remote)
 * yields no slug, and then GH_REPO is explicitly UNSET rather than left inherited: a server launched
 * with GH_REPO in its own environment would otherwise have every gate here evaluated against that
 * other repository. No slug means cwd alone governs. Never pass `-C` in `args`.
 */
async function bdGate(repo: string, args: string[]): Promise<string> {
  if (!repo) throw new Error(`bd ${args.join(" ")}: a gate call requires the project repo as cwd`);
  const slug = await githubRepoSlug(repo).catch(() => undefined);
  return bd(repo, args, { env: { GH_REPO: slug } });
}

/** {@link bdGate} for the calls that mutate gates — invalidates the board snapshot like bdWrite. */
async function bdGateWrite(repo: string, args: string[]): Promise<string> {
  const stdout = await bdGate(repo, args);
  invalidateIssueSnapshot(repo, true);
  return stdout;
}

// ── formula cooking (anton-brdg) ──
//
// `bd cook` resolves a `.formula.{toml,json}` into its steps. This is the ONLY place anton shells a
// formula verb, so the pipeline stays swappable: the loader (anton-hrql) and the invariant-floor
// validator (anton-6b99) consume {@link CookedFormula}, never bd stdout.
//
// Deliberately a READ: `--persist` is never passed. Persisting materialises a proto bead, which is a
// write — it would need bdWrite's snapshot invalidation and a dolt sync, and anton has no use for a
// stored proto (it cooks per run). See formula.ts for why anton cooks rather than pours.

/**
 * A step's gate — the async wait condition bd blocks it on. `type` is bd's gate kind (`human`,
 * `timer`, `gh:run`, `gh:pr`, `bead`); `await_id` and `timeout` are that kind's parameter. Read-only
 * here: resolving gates is anton-uk95's, so this seam reports a gate rather than acting on one.
 */
export interface CookedGate {
  type: string;
  /** What the gate waits on: a run/PR ref for `gh:*`, `<rig>:<bead-id>` for `bead`. */
  await_id?: string;
  /** `timer` only — the window after which the gate expires. */
  timeout?: string;
}

/**
 * One resolved step of a cooked formula, in declaration order.
 *
 * `labels` is where a step names its handler (`step:<name>`) and its prompt: `bd cook` silently
 * DROPS step keys it doesn't recognise, so anton's per-step configuration has to ride on labels
 * rather than a custom formula key. `needs` carries the DAG edges (a `blocks` edge once poured).
 */
export interface CookedStep {
  id: string;
  title?: string;
  /** The bd issue type the step materialises as (`task`, `feature`, …). */
  type?: string;
  labels?: string[];
  /** Ids of the steps this one depends on — bd's `needs` AND `depends_on` merged (see {@link needsOf}). */
  needs?: string[];
  gate?: CookedGate;
}

/** A cooked formula — the resolved pipeline the runtime walks. */
export interface CookedFormula {
  /** The formula's own name. bd's key is `formula`, NOT `name`: a formula written with `name`
   * parses and then fails cook with "name is required" (verified on bd 1.1.2, anton-upfc). */
  formula: string;
  description?: string;
  /** Absolute path bd cooked from — what a park message must name so an operator finds the file. */
  source?: string;
  steps: CookedStep[];
}

/**
 * How a formula is cooked. `compile` keeps `{{var}}` placeholders (modelling, validation of the
 * shipped default); `runtime` substitutes them and requires every variable to have a value —
 * a missing one exits non-zero rather than rendering a half-resolved pipeline.
 */
export type CookMode = "compile" | "runtime";

export interface CookOptions {
  /** Defaults to `runtime` when `vars` are given, `compile` otherwise. */
  mode?: CookMode;
  /** `{{var}}` values for this run, passed as `--var k=v`. */
  vars?: Record<string, string>;
}

/**
 * Pure argv builder for `bd cook`, exposed for testing (like {@link buildUpdateArgs}).
 *
 * `--mode` is always explicit so the argv never depends on bd's implicit "any --var enables runtime"
 * rule. That rule is also why `mode: "compile"` WITH vars is rejected rather than emitted: bd
 * substitutes whenever a `--var` is present, so such an argv would declare an intent bd ignores.
 */
export function buildCookArgs(formula: string, opts: CookOptions = {}): string[] {
  const vars = Object.entries(opts.vars ?? {});
  if (opts.mode === "compile" && vars.length > 0) {
    throw new Error(
      `bd cook ${formula}: mode "compile" cannot be combined with vars — bd substitutes whenever ` +
        `--var is present, so the placeholders would not survive. Cook without vars, or use "runtime".`,
    );
  }
  for (const [k] of vars) {
    // bd splits `--var k=v` on the FIRST `=`, so a key containing one silently sets a different
    // variable (values may contain `=` freely). Fail loud rather than parameterise the wrong var.
    if (!k || k.includes("=")) {
      throw new Error(`bd cook ${formula}: invalid variable name ${JSON.stringify(k)}`);
    }
  }
  const mode: CookMode = opts.mode ?? (vars.length > 0 ? "runtime" : "compile");
  return [
    "cook",
    formula,
    `--mode=${mode}`,
    ...vars.flatMap(([k, v]) => ["--var", `${k}=${v}`]),
    "--json",
  ];
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v ? v : undefined;
}

function strings(v: unknown): string[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out = v.filter((x): x is string => typeof x === "string");
  return out.length > 0 ? out : undefined;
}

/**
 * A step's prerequisites, from EITHER spelling bd accepts. bd cooks `needs` and `depends_on` through
 * verbatim — it normalises neither into the other (measured on bd 1.1.2) — so reading only `needs`
 * would hand the walker a formula with no edges at all: it would run in declaration order, or be
 * rejected by the invariant floor for an ordering the file actually expressed. Merged and deduped
 * here so every consumer downstream reads ONE field.
 */
function needsOf(s: Record<string, unknown> | null | undefined): string[] | undefined {
  const merged = [...(strings(s?.needs) ?? []), ...(strings(s?.depends_on) ?? [])];
  return merged.length > 0 ? [...new Set(merged)] : undefined;
}

function gateOf(v: unknown): CookedGate | undefined {
  const g = v as Record<string, unknown> | null | undefined;
  const type = str(g?.type);
  if (!type) return undefined;
  return { type, ...pick("await_id", str(g?.await_id)), ...pick("timeout", str(g?.timeout)) };
}

/** Include a key only when it has a value, so an absent field stays absent rather than `undefined`. */
function pick<K extends string, V>(key: K, value: V | undefined): Partial<Record<K, V>> {
  return value === undefined ? {} : ({ [key]: value } as Record<K, V>);
}

/**
 * Parse `bd cook --json` into the typed pipeline, normalising each step to {@link CookedStep} so no
 * caller ever touches bd's raw output. Fails loud on anything that is not a cooked formula —
 * a step with no id has no handler, no park message, and no place in the DAG, so it cannot be
 * silently dropped. `formula` names the cooked formula in every message.
 */
export function parseCookedFormula(raw: string, formula: string): CookedFormula {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new Error(
      `bd cook ${formula}: output was not JSON (got ${JSON.stringify(raw.slice(0, 200))})`,
      { cause: e },
    );
  }
  const doc = parsed as Record<string, unknown> | null;
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) {
    throw new Error(`bd cook ${formula}: expected a formula object, got ${typeof parsed}`);
  }
  if (!Array.isArray(doc.steps)) {
    throw new Error(`bd cook ${formula}: cooked output has no steps array`);
  }
  const steps = doc.steps.map((step, i): CookedStep => {
    const s = step as Record<string, unknown> | null;
    const id = str(s?.id)?.trim();
    if (!id) {
      throw new Error(`bd cook ${formula}: step ${i} has no id — every step must declare one`);
    }
    return {
      id,
      ...pick("title", str(s?.title)),
      ...pick("type", str(s?.type)),
      ...pick("labels", strings(s?.labels)),
      ...pick("needs", needsOf(s)),
      ...pick("gate", gateOf(s?.gate)),
    };
  });
  return {
    formula: str(doc.formula) ?? formula,
    ...pick("description", str(doc.description)),
    ...pick("source", str(doc.source)),
    steps,
  };
}

// ── board hygiene verbs (anton-6qbc) ──
//
// The typed seam for the gardener patrol (anton-bci0): bd's own hygiene commands, so anton composes
// them rather than reimplementing epic-closure, staleness or duplicate detection over a board read.
// Every verb here rides the same budgeted, process-group-reaped spawn as the rest of the file, and
// the two WRITE-class ones (`epic close-eligible` applying, `recompute-blocked`) go through bdWrite
// so the board snapshot invalidates exactly like any other write.
//
// All seven support `--json`, verified by EXECUTING each against a seeded scratch board on bd 1.1.2
// AND on the 1.1.0 floor (`~/.local/bin/bd.1.1.0.bak`) — output was identical on both. Per
// .product/decisions/2026-07-28-bd-workflow-primitives.md, `--help` is not an oracle; the shapes
// below are what bd actually printed. Three of them are traps a `--help` reading would have missed:
//
//   1. `bd epic close-eligible --json` returns TWO different shapes — an ARRAY of candidates on
//      `--dry-run`, an OBJECT `{closed, count}` when it applies (and a bare `[]` when it applies and
//      nothing was eligible). See {@link parseEpicCloseEligible}.
//   2. `bd lint --json`'s `total` is the WARNING count and `issues` is the ISSUE count — one bug
//      missing two sections reports `{total: 2, issues: 1}`. Reading `total` as "beads to fix"
//      overcounts, so the wrapper renames both.
//   3. `bd orphans --json` prints bare `null` (not `[]`) when nothing is orphaned, and `bd lint
//      --json` prints `"results": null` — both would crash a naive `.map`.
//
// Only READ verbs and the two safe writes live here. `bd duplicates --auto-merge` and `bd orphans
// --fix` are deliberately absent: they are judgment moves the patrol must never make (anton-bci0
// "Out of scope"), and a wrapper is the easiest place for one to leak in.

/**
 * One epic `bd epic close-eligible --dry-run` judged ready to close, with the counts behind the
 * verdict so a report can say WHY. bd lists only eligible epics (an epic with an open child, and a
 * childless epic, are both omitted — measured), so `eligible` is expected true; it is carried
 * verbatim rather than assumed, and a `false` entry is dropped by the parser.
 */
export interface EpicCloseCandidate {
  epic: Bead;
  totalChildren: number;
  closedChildren: number;
  eligible: boolean;
}

/**
 * The outcome of one `bd epic close-eligible` pass. The two halves are populated by the two modes
 * bd answers in, never both: a preview fills `eligible`, an apply fills `closed`.
 */
export interface EpicCloseSweep {
  /** Was this a preview? A preview closes nothing. */
  dryRun: boolean;
  /** Epics bd judged eligible — PREVIEW ONLY: an apply reports ids alone, not the counts. */
  eligible: EpicCloseCandidate[];
  /** The epic ids bd actually closed — empty on a preview. */
  closed: string[];
}

/** One bead `bd lint` flags, with the template sections it is missing. */
export interface LintViolation {
  id: string;
  title: string;
  /** The bead's issue type — what decided which sections were required. */
  type: string;
  /** Section headings bd expected and did not find, e.g. `## Acceptance Criteria`. */
  missing: string[];
  /** How many warnings this bead accrued (one per missing section). */
  warnings: number;
}

/**
 * `bd lint --json`, with bd's two counters renamed to what they actually count: bd's `total` is the
 * WARNING count and its `issues` is the number of beads carrying them (a bug missing both required
 * sections reports `{total: 2, issues: 1}`).
 */
export interface LintReport {
  /** Total warnings across every flagged bead — bd's `total`. */
  warnings: number;
  /** How many beads were flagged — bd's `issues`, and always `violations.length`. */
  issues: number;
  violations: LintViolation[];
}

/** What `bd lint` may be scoped to. `status: "all"` includes closed beads; the default is open only. */
export interface LintOpts {
  status?: string;
  type?: string;
}

/** The statuses `bd stale -s` accepts. Omit for every non-closed status at once. */
export type StaleStatus = "open" | "in_progress" | "blocked" | "deferred";

export interface StaleOpts {
  /** One status, or omitted for all of them — the gardener sweeps open and in_progress separately,
   * because "untouched for 30 days" means something different for each. */
  status?: StaleStatus;
  /** bd's `--days` window. bd REJECTS 0 ("--days must be at least 1"), so this does too, up front. */
  days?: number;
  /** bd's `--limit`; 0 is unlimited and is this seam's default (bd's own default of 50 truncates). */
  limit?: number;
}

/** A bead named by a commit message that is still open — `bd orphans`: shipped but never closed. */
export interface OrphanBead {
  /** bd's field here is `issue_id`; normalized to `id` so it reads like every other bead value. */
  id: string;
  title: string;
  status: string;
  /** Abbreviated sha of the most recent commit bd matched to this bead. */
  latestCommit?: string;
  latestCommitMessage?: string;
}

/**
 * One cycle in the dependency graph, as `bd dep cycles` reports it.
 *
 * `raw` is carried deliberately. bd REFUSES to create a blocking cycle at every write path there is
 * — `dep add` (with and without `--no-cycle-check`), `link`, `batch`, and `import` (which skips the
 * offending edge) all reject it, measured on 1.1.0 and 1.1.2 — so a populated cycle list can only
 * come from a merge or a corrupted graph, and the EMPTY shape (`[]`) is the only one obtainable to
 * pin a parse against. Rather than guess, {@link parseDepCycles} extracts ids from the encodings bd
 * plausibly uses and hands the untouched element through as `raw`, so a report can always render
 * something truthful even if `ids` comes back empty.
 */
export interface DepCycle {
  /** The bead ids on the cycle, best-effort — may be empty if bd's element shape is unrecognised. */
  ids: string[];
  /** bd's element, untouched. */
  raw: unknown;
}

/** One member of a `bd duplicates` group. */
export interface DuplicateMember {
  id: string;
  title: string;
  status: string;
  priority?: number;
  /** How many other beads reference this one — bd's tiebreak for picking the merge target. */
  references: number;
  /** Did bd pick this bead as the group's merge target? */
  isMergeTarget: boolean;
}

/** A set of beads with identical content (title + body + design + acceptance), per `bd duplicates`. */
export interface DuplicateGroup {
  title: string;
  /** The bead bd suggests keeping. */
  target?: string;
  /** The beads bd suggests folding into `target`. */
  sources: string[];
  /** bd's own summary line and the shell command it suggests — reported, NEVER executed here. */
  note?: string;
  suggestedAction?: string;
  members: DuplicateMember[];
}

/** Pure argv builder for `bd lint`, exposed for testing (like {@link buildUpdateArgs}). */
export function buildLintArgs(opts: LintOpts = {}): string[] {
  return [
    "lint",
    ...(opts.status ? ["--status", opts.status] : []),
    ...(opts.type ? ["--type", opts.type] : []),
    "--json",
  ];
}

/**
 * Pure argv builder for `bd stale`, exposed for testing. `--limit 0` (unlimited) is the default for
 * the same reason `list`/`ready` pass it: bd's own default of 50 silently drops findings.
 */
export function buildStaleArgs(opts: StaleOpts = {}): string[] {
  // bd exits with `{"error": "--days must be at least 1"}` — refuse here so the caller gets a
  // message naming ITS mistake instead of a spawn whose JSON is an error envelope.
  if (opts.days !== undefined && (!Number.isInteger(opts.days) || opts.days < 1)) {
    throw new Error(`bd stale: --days must be an integer >= 1, got ${opts.days}`);
  }
  const limit = opts.limit ?? 0;
  return [
    "stale",
    ...(opts.status ? ["--status", opts.status] : []),
    ...(opts.days !== undefined ? ["--days", String(opts.days)] : []),
    "--limit",
    String(limit),
    "--json",
  ];
}

/** JSON.parse with the verb named in the failure — bd printing non-JSON is a format change, not data. */
function parseHygieneJson(raw: string, verb: string): unknown {
  try {
    return JSON.parse(raw.trim() || "null");
  } catch (e) {
    throw new Error(
      `bd ${verb}: output was not JSON (got ${JSON.stringify(raw.slice(0, 200))})`,
      { cause: e },
    );
  }
}

function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

/**
 * Read one `bd epic close-eligible --json` pass, keyed on the SHAPE bd returned rather than on the
 * flag we passed — the two are meant to agree, and if they ever stop, the payload is the truth.
 * A preview answers an array of candidates; an apply answers `{closed: [...], count: n}`, except
 * when nothing was eligible, where it answers a bare `[]` (which reads correctly as neither).
 */
export function parseEpicCloseEligible(raw: string, dryRun: boolean): EpicCloseSweep {
  const parsed = parseHygieneJson(raw, "epic close-eligible");
  if (Array.isArray(parsed)) {
    const eligible = parsed
      .map((entry): EpicCloseCandidate | undefined => {
        const e = entry as Record<string, unknown> | null;
        const epic = e?.epic as Bead | undefined;
        if (!epic?.id) return undefined;
        return {
          epic,
          totalChildren: num(e?.total_children) ?? 0,
          closedChildren: num(e?.closed_children) ?? 0,
          eligible: e?.eligible_for_close !== false,
        };
      })
      .filter((c): c is EpicCloseCandidate => c !== undefined && c.eligible);
    return { dryRun, eligible, closed: [] };
  }
  const closed = (parsed as Record<string, unknown> | null)?.closed;
  if (Array.isArray(closed)) {
    return { dryRun, eligible: [], closed: closed.filter((id): id is string => typeof id === "string") };
  }
  throw new Error(
    `bd epic close-eligible: could not read its --json output (bd output format changed?) — ` +
      `refusing to report an unreadable sweep as "nothing to close". Output: ${raw.slice(0, 200)}`,
  );
}

/** Read `bd lint --json`. `results` is `null` (not `[]`) on a clean board — hence the guard. */
export function parseLintReport(raw: string): LintReport {
  const doc = parseHygieneJson(raw, "lint") as Record<string, unknown> | null;
  const results = Array.isArray(doc?.results) ? doc.results : [];
  const violations = results.flatMap((r): LintViolation[] => {
    const v = r as Record<string, unknown> | null;
    const id = str(v?.id);
    if (!id) return [];
    const missing = strings(v?.missing) ?? [];
    return [
      {
        id,
        title: str(v?.title) ?? "",
        type: str(v?.type) ?? "",
        missing,
        warnings: num(v?.warnings) ?? missing.length,
      },
    ];
  });
  return {
    warnings: num(doc?.total) ?? violations.reduce((n, v) => n + v.warnings, 0),
    issues: num(doc?.issues) ?? violations.length,
    violations,
  };
}

/** Read `bd orphans --json`, whose empty answer is a bare `null`. */
export function parseOrphans(raw: string): OrphanBead[] {
  const parsed = parseHygieneJson(raw, "orphans");
  if (!Array.isArray(parsed)) return [];
  return parsed.flatMap((entry): OrphanBead[] => {
    const o = entry as Record<string, unknown> | null;
    const id = str(o?.issue_id) ?? str(o?.id);
    if (!id) return [];
    return [
      {
        id,
        title: str(o?.title) ?? "",
        status: str(o?.status) ?? "",
        ...pick("latestCommit", str(o?.latest_commit)),
        ...pick("latestCommitMessage", str(o?.latest_commit_message)),
      },
    ];
  });
}

/**
 * Read `bd dep cycles --json`. The empty answer (`[]`) is pinned against real bd; the populated one
 * cannot be — no bd write path will create a cycle (see {@link DepCycle}) — so ids are extracted
 * best-effort from the encodings bd plausibly uses and the element is preserved either way. A cycle
 * whose ids can't be read is still REPORTED (never dropped): "the graph has a cycle we can't name"
 * is the finding, and swallowing it would hide the one condition this verb exists to surface.
 */
export function parseDepCycles(raw: string): DepCycle[] {
  const parsed = parseHygieneJson(raw, "dep cycles");
  if (!Array.isArray(parsed)) return [];
  const idsOf = (raw: unknown): string[] => {
    if (typeof raw === "string") return [raw];
    if (Array.isArray(raw)) return raw.flatMap(idsOf);
    const o = raw as Record<string, unknown> | null;
    if (!o || typeof o !== "object") return [];
    const named = o.cycle ?? o.path ?? o.ids ?? o.issue_ids ?? o.issues ?? o.nodes;
    if (named !== undefined) return idsOf(named);
    const id = str(o.id) ?? str(o.issue_id);
    return id ? [id] : [];
  };
  return parsed.map((entry) => ({ ids: idsOf(entry), raw: entry }));
}

/** Read `bd duplicates --json` — an object envelope, `{duplicate_groups, groups, schema_version}`. */
export function parseDuplicateGroups(raw: string): DuplicateGroup[] {
  const doc = parseHygieneJson(raw, "duplicates") as Record<string, unknown> | null;
  const groups = Array.isArray(doc?.groups) ? doc.groups : [];
  return groups.map((entry): DuplicateGroup => {
    const g = entry as Record<string, unknown> | null;
    const members = (Array.isArray(g?.issues) ? g.issues : []).flatMap(
      (issue): DuplicateMember[] => {
        const m = issue as Record<string, unknown> | null;
        const id = str(m?.id);
        if (!id) return [];
        return [
          {
            id,
            title: str(m?.title) ?? "",
            status: str(m?.status) ?? "",
            ...pick("priority", num(m?.priority)),
            references: num(m?.references) ?? 0,
            isMergeTarget: m?.is_merge_target === true,
          },
        ];
      },
    );
    return {
      title: str(g?.title) ?? "",
      ...pick("target", str(g?.suggested_target)),
      sources: strings(g?.suggested_sources) ?? [],
      ...pick("note", str(g?.note)),
      ...pick("suggestedAction", str(g?.suggested_action)),
      members,
    };
  });
}

/**
 * Read `bd recompute-blocked --json` (`{"rows_corrected": n}`) — or THROW. The throw is the point:
 * this verb exists to report how many stale `is_blocked` flags it repaired, and a silent 0 on an
 * unreadable answer would render a repair anton could not see as "the graph was already consistent".
 */
export function parseRecomputeBlocked(raw: string): number {
  const doc = parseHygieneJson(raw, "recompute-blocked") as Record<string, unknown> | null;
  const rows = num(doc?.rows_corrected);
  if (rows === undefined) {
    throw new Error(
      `bd recompute-blocked: could not read rows_corrected from its --json output (bd output ` +
        `format changed?). Output: ${raw.slice(0, 200)}`,
    );
  }
  return rows;
}

// ── the claimable set + the verified claim (anton-9anc) ──
//
// ONE definition of "what any worker may claim" and "how a claim becomes trustworthy", so a second
// anton, a headless job, and a plain Claude Code session on another machine all pick up the same
// work in the same order and never both believe they hold it. Everything else (the runner's pickup,
// the ready-count nudge, board ordering) consumes this rather than re-deriving the rule.

/** A bead's claim holder, normalized — blank/whitespace assignee means unclaimed. */
export const ownerOf = (b: Bead | undefined): string | undefined => b?.assignee?.trim() || undefined;

/**
 * A claimable run target plus the facts it was ranked on, so "why is this next?" is answerable from
 * the value itself rather than by re-deriving the comparator at each consumer.
 */
export interface ClaimableTarget {
  bead: Bead;
  /** bd priority: 0 = critical … 4 = lowest. A bead with none is treated as lowest. */
  priority: number;
  /** How many open beads this target transitively unblocks via `blocks` edges. */
  unblocks: number;
  /** The bead's `created_at`, the age tiebreak (oldest first); "" when bd reported none. */
  createdAt: string;
}

/**
 * The claimable POOL query: every approved, unclaimed bead bd itself considers ready — its
 * blocker-aware `GetReadyWork` semantics, which also drop in_progress/blocked/deferred/hooked work.
 * Readiness is bd's to answer and is deliberately not re-derived here; anton only narrows the answer
 * (see {@link rankClaimableTargets}).
 *
 * Deliberately WITHOUT `--type feature`, which the shaped ticket named: bd's `-t/--type` takes ONE
 * type (verified on bd 1.1.2) while the claimable set spans features, parentless task/bug
 * epics-of-one, and legacy childless epics — so a per-type argv would cost three spawns whose
 * results couldn't even be read as one consistent board. The type split happens in-process against
 * the board read {@link beads.claimableTargets} needs anyway for parentage and `blocks` edges.
 */
export function buildClaimableReadyArgs(): string[] {
  return ["ready", "--label", LABELS.approved, "--unassigned", "--json", "--limit", "0"];
}

/** Missing bead priority sorts after every explicit priority (bd uses 0=critical … 4=lowest). */
const DEFAULT_CLAIMABLE_PRIORITY = 4;

/** A bead with no `created_at` sorts LAST on the age tiebreak — an unstamped bead must not jump
 * the queue ahead of work that has genuinely been waiting. */
const UNDATED = "\uffff";

/**
 * May a worker claim this bead and run it? The anton-side half of the claimable rule, applied to a
 * bead bd already reported as ready:
 *   - `open` — a claimed/closed/deferred bead is somebody's or nobody's work, never free work.
 *   - `approved` — the human gate. execute-epic poisons an unapproved target, so a set that
 *     included one would name work anton refuses to run.
 *   - unassigned — a claim already held is not up for grabs, even when bd's `--unassigned` filter
 *     wasn't the source of this pool.
 *   - {@link beads.isRunTarget} — the SAME predicate the approve route and the runner gate on, so
 *     the claimable set can never disagree with what anton will actually execute. That is what
 *     keeps container epics (their features each run on their own) and child tickets (executed as
 *     part of their target's run, never distributed) out of the set.
 */
function isClaimable(b: Bead, board: Bead[]): boolean {
  return (
    b.status === "open" &&
    beads.isApproved(b) &&
    !ownerOf(b) &&
    beads.isRunTarget(b, board)
  );
}

/**
 * `id → how many open beads it transitively unblocks`, built once per board.
 *
 * A `blocks` edge is (from = dependent, to = blocker), so the dependents of a target are what its
 * completion releases; the count is the transitive closure of that, restricted to beads that are
 * still open (a closed dependent was never waiting). Cycle-guarded via `seen`, and a dependent that
 * isn't on the board is traversed but not counted — it is evidence of an edge, not of open work.
 */
function unblockCounter(board: Bead[]): (id: string) => number {
  const dependents = new Map<string, string[]>();
  for (const e of beads.edgesOf(board)) {
    if (e.type !== "blocks") continue;
    const list = dependents.get(e.to);
    if (list) list.push(e.from);
    else dependents.set(e.to, [e.from]);
  }
  const openIds = new Set(board.filter((b) => b.status !== "closed").map((b) => b.id));

  return (id: string): number => {
    const seen = new Set<string>([id]);
    const queue = [id];
    let count = 0;
    while (queue.length) {
      for (const next of dependents.get(queue.shift() as string) ?? []) {
        if (seen.has(next)) continue;
        seen.add(next);
        queue.push(next);
        if (openIds.has(next)) count++;
      }
    }
    return count;
  };
}

/**
 * The rank order itself — priority, then unblocking value, then age, then id. Total and
 * deterministic (the id tiebreak is what makes it total), so two machines reading the same board
 * agree on what anton picks up next.
 */
function compareClaimable(a: ClaimableTarget, b: ClaimableTarget): number {
  if (a.priority !== b.priority) return a.priority - b.priority; // P0 first
  if (a.unblocks !== b.unblocks) return b.unblocks - a.unblocks; // frees the most work first
  const ageA = a.createdAt || UNDATED;
  const ageB = b.createdAt || UNDATED;
  if (ageA !== ageB) return ageA < ageB ? -1 : 1; // oldest first
  return a.bead.id < b.bead.id ? -1 : 1;
}

/**
 * Narrow bd's ready pool to the claimable run targets and RANK them (see {@link compareClaimable}).
 * Pure over its input — no bd spawn — so the rule is testable against fixture boards and reusable by
 * any caller that already holds a board.
 *
 * `pool` is bd's blocker-aware ready answer; `board` is the full `--status all` list, which supplies
 * the parentage, `blocks` edges and feature children the narrowing and the unblocking count need.
 */
export function rankClaimableTargets(pool: Bead[], board: Bead[]): ClaimableTarget[] {
  const unblocks = unblockCounter(board);
  return pool
    .filter((b) => isClaimable(b, board))
    .map((bead) => ({
      bead,
      priority: bead.priority ?? DEFAULT_CLAIMABLE_PRIORITY,
      unblocks: unblocks(bead.id),
      createdAt: bead.created_at ?? "",
    }))
    .sort(compareClaimable);
}

/**
 * Propagation window a verified claim settles for before it trusts its own read. Reused verbatim
 * from the run-lease arbitration (execute-epic's RUN_LEASE_SETTLE_MS): concluding "we hold it" from
 * seeing only our own assignee is a decision made on the ABSENCE of a rival claim, and absence is
 * unreliable on an eventually-consistent board — a machine that claimed the same instant may not
 * have propagated yet. Comfortably above sync round-trip latency, far below any run's lifetime.
 */
export const CLAIM_SETTLE_MS = 2_000;

/**
 * The verdict of {@link beads.claimVerified}. `lost` is a VALUE, not an exception: losing a race is
 * the protocol working, and a pickup loop must be able to move to the next target without a
 * try/catch — and `lost` with an undefined `owner` means the bead read back unassigned, so it is
 * neither ours nor anyone else's and retrying it is safe. `unverified` is the fail-closed answer —
 * the claim could not be proven, so the caller must NOT run the target; it may retry (a same-actor
 * claim is idempotent). `stale` is the claim we WON on work that left the claimable set while we
 * settled — ours on paper, not runnable: a retry can only reach the same verdict, and the local
 * claim is the caller's to release.
 */
export type ClaimVerification =
  | { ok: true; bead: Bead }
  | { ok: false; reason: "lost"; owner: string | undefined }
  | { ok: false; reason: "stale"; detail: string; bead: Bead }
  | { ok: false; reason: "unverified"; detail: string };

/** The seam a verified claim drives, injectable so tests can interleave claimers without a board. */
export interface ClaimVerifiedDeps {
  pull?: (cwd: string) => Promise<unknown>;
  push?: (cwd: string) => Promise<SyncOutcome>;
  claim?: (cwd: string, id: string, actor: string) => Promise<unknown>;
  show?: (cwd: string, id: string) => Promise<Bead>;
  /** Fresh `--status all` board, for the post-settle re-validation (see {@link staleClaimReason}). */
  board?: (cwd: string) => Promise<Bead[]>;
  sleep?: (ms: number) => Promise<void>;
  settleMs?: number;
}

/**
 * Why this target is no longer runnable, or undefined when it still is — the post-settle half of
 * {@link isClaimable}, applied to the bead WE now hold (anton-9anc review).
 *
 * Owning the assignee proves the race was won, not that the prize is still worth having: another
 * machine can close or abandon the target, drop `approved`, or land a feature under a legacy epic
 * (turning it into a container) inside the very settle window this protocol waits out. Re-asserting
 * the rest of the claimable rule against a FRESH board is what keeps a verified claim from licensing
 * a run the claimable set would refuse.
 *
 * The assignee/`open` legs of {@link isClaimable} are deliberately NOT re-checked: `bd update
 * --claim` has by now made us the assignee and flipped the status to in_progress, so both would
 * reject the very claim they were meant to confirm.
 */
export function staleClaimReason(bead: Bead, board: Bead[]): string | undefined {
  if (beads.isAbandoned(bead)) return "the target was abandoned while the claim settled";
  if (bead.status !== "open" && bead.status !== "in_progress") {
    return `the target is ${bead.status} — no longer runnable work`;
  }
  if (!beads.isApproved(bead)) return "approval was withdrawn while the claim settled";
  if (!beads.isRunTarget(bead, board)) {
    return "the target is no longer a run target (a container epic or a child ticket)";
  }
  return undefined;
}

const sleepMs = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    if (typeof t.unref === "function") t.unref();
  });

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * Claim `id` for `actor` and prove the claim held — the write half of the cross-machine pickup
 * protocol (anton-9anc). See {@link beads.claimVerified} for the contract; this is the body, split
 * out so the whole sequence is one readable unit.
 */
async function runClaimVerified(
  cwd: string,
  id: string,
  actor: string,
  deps: ClaimVerifiedDeps,
): Promise<ClaimVerification> {
  const pull = deps.pull ?? beads.pull;
  const push = deps.push ?? beads.push;
  const claim = deps.claim ?? beads.claim;
  const show = deps.show ?? beads.show;
  const readBoard = deps.board ?? ((c: string) => beads.list(c, ["--status", "all"]));
  const sleep = deps.sleep ?? sleepMs;
  const settleMs = deps.settleMs ?? CLAIM_SETTLE_MS;
  const unverified = (detail: string): ClaimVerification => ({
    ok: false,
    reason: "unverified",
    detail: `${id}: ${detail}`,
  });

  // 1. Pull first, so a claim another machine already published is visible locally — bd's own
  //    `--claim` then refuses ours outright, and we lose cheaply without writing anything.
  try {
    await pull(cwd);
  } catch (e) {
    return unverified(`could not refresh the board before claiming (${errorText(e)})`);
  }

  // 2. Claim. `bd update --claim` is the atomic local compare-and-swap (it refuses a bead already
  //    claimed by someone else and is idempotent for the same actor), so no read-then-write CAS is
  //    re-implemented here. On refusal, read the board for the holder rather than parsing bd's
  //    message: the assignee IS the evidence, and it can't rot the way an error string can.
  try {
    await claim(cwd, id, actor);
  } catch (e) {
    const current = await show(cwd, id).catch(() => null);
    const holder = ownerOf(current ?? undefined);
    if (current && holder && holder !== actor) return { ok: false, reason: "lost", owner: holder };
    return unverified(`bd refused the claim (${errorText(e)})`);
  }

  // 3. Publish it. A claim no other machine can see is not a claim; if the push fails we cannot
  //    prove we hold it, so we fail closed. The local claim stands and a retry re-claims idempotently.
  let outcome: SyncOutcome;
  try {
    outcome = await push(cwd);
  } catch (e) {
    return unverified(`claimed locally but could not publish the claim (${errorText(e)})`);
  }

  // 4/5. Settle, then re-pull — but only when there is a remote at all. A not-wired board has no
  //      second machine to race, so waiting out a propagation window it can't have would stall every
  //      single-machine pickup for nothing.
  if (outcome !== "not-wired") {
    await sleep(settleMs);
    try {
      await pull(cwd);
    } catch (e) {
      return unverified(`could not re-read the board to verify the claim (${errorText(e)})`);
    }
  }

  // 6. Assert the assignee. This is the only step that makes the claim trustworthy: after the merge
  //    of two concurrent claims exactly one actor survives on the bead, and a worker may run only if
  //    that actor is itself. A `lost` with NO owner is the bead reading back unassigned — our claim
  //    did not survive the merge, so it is not ours to run, but nobody else holds it either: the
  //    target may simply be free again, and re-claiming it is safe (a same-actor claim is idempotent).
  const verified = await show(cwd, id).catch(() => null);
  if (!verified) return unverified("could not re-read the bead to verify the claim");
  const owner = ownerOf(verified);
  if (owner !== actor) return { ok: false, reason: "lost", owner };

  // 7. Re-assert the REST of the claimable rule against a fresh board. Winning the assignee proves
  //    the race, not that the target is still work anton may run — see staleClaimReason. The board
  //    read is the same `--status all` list claimableTargets narrows, so the two can't disagree.
  let board: Bead[];
  try {
    board = await readBoard(cwd);
  } catch (e) {
    return unverified(`could not re-read the board to re-validate the target (${errorText(e)})`);
  }
  // Judge the BOARD's copy when it has one: `bd list` is the read the claimable rule was written
  // against (it carries parentage the way isRunTarget expects), so judging it keeps this verdict and
  // claimableTargets from disagreeing on the same bead. `show`'s copy stays the assignee evidence.
  const onBoard = board.find((b) => b.id === id) ?? verified;
  const stale = staleClaimReason(onBoard, board);
  return stale
    ? { ok: false, reason: "stale", detail: `${id}: ${stale}`, bead: verified }
    : { ok: true, bead: verified };
}

export const beads = {
  /**
   * Truly claimable work (excludes in_progress/blocked/deferred). `--limit 0` = unlimited:
   * `bd ready` (like `bd list`) defaults to 50 results, which would silently drop work in a
   * repo with a large ready queue.
   */
  ready: (cwd: string) => bd(cwd, ["ready", "--json", "--limit", "0"]).then(asArray<Bead>),

  // ── gates (anton-uk95) ── every call spawns in `repo`, never with `-C`; see bdGate above.

  /**
   * Create a gate that blocks `opts.blocks` until it resolves; returns the gate bead's id. A
   * `gh:run`/`gh:pr` gate created here is later evaluated against THIS repo, because that is the
   * cwd its check runs in.
   */
  async gateCreate(repo: string, opts: GateCreateOpts): Promise<string> {
    const out = await bdGateWrite(repo, buildGateCreateArgs(opts));
    const parsed = JSON.parse(out);
    const gate = Array.isArray(parsed) ? parsed[0] : parsed;
    if (!gate?.id) throw new Error("bd gate create: could not parse gate id from output");
    return gate.id as string;
  },

  /**
   * Evaluate this repo's open gates and close the satisfied ones. The GitHub verdicts come from a
   * `gh` subprocess that resolves its repository from the cwd this spawns in — which is why the
   * project repo is a required argument and `-C` is never used.
   *
   * Callers MUST branch on `errors`: an un-evaluatable gate is unknown, not unresolved (see
   * {@link GateCheckResult}).
   */
  gateCheck: (repo: string, opts: GateCheckOpts = {}): Promise<GateCheckResult> =>
    (opts.dryRun ? bdGate : bdGateWrite)(repo, buildGateCheckArgs(opts)).then(parseGateCheck),

  /** Manually resolve (close) a gate — the human-gate path, and the operator override for the rest. */
  gateResolve: (repo: string, id: string, reason?: string) =>
    bdGateWrite(repo, ["gate", "resolve", id, ...(reason ? ["--reason", reason] : [])]),

  /**
   * This repo's gates — open only by default, `all` to include resolved ones. `--limit 0`
   * (unlimited) for the same reason `list` passes it: bd's default 50 would silently truncate.
   */
  gateList: (repo: string, opts: { all?: boolean } = {}): Promise<Gate[]> =>
    bdGate(repo, [
      "gate",
      "list",
      "--json",
      "--limit",
      "0",
      ...(opts.all ? ["--all"] : []),
    ]).then(asArray<Gate>),

  /**
   * Fill in the `await_id` of `gh:run` gates created before their workflow run existed, by matching
   * recent runs on branch/SHA/time. Its candidate runs come from the cwd repo's GitHub remote, so it
   * carries the same cwd rule as `gateCheck` — run from the wrong directory it matches another
   * project's runs. Returns bd's human summary: at bd 1.1.2 `gate discover` emits no JSON.
   */
  gateDiscover: (repo: string, opts: GateDiscoverOpts = {}): Promise<string> =>
    (opts.dryRun ? bdGate : bdGateWrite)(repo, buildGateDiscoverArgs(opts)),

  /**
   * A `gh:pr` gate — the merge wait anton arms on a run target when it opens that target's PR
   * (anton-k0kj). It is the ONE gate flavour anton creates on work it runs, and it is deliberately
   * NOT a prerequisite: it awaits the target's OWN pull request, so every "what blocks this bead?"
   * computation skips it (see epic-graph). Anything else would make an in-review target read as
   * blocked by itself and refuse the recovery run its closed-unmerged PR needs.
   *
   * `await_type` lives on {@link Gate}, and gate beads reach a board read through
   * `bd list --type gate` (loadAllIssues), which carries the field — so the cast is the seam's, not
   * a caller's.
   */
  isMergeWaitGate: (b: Bead): b is Gate =>
    b.issue_type === "gate" && (b as Gate).await_type === "gh:pr",

  /**
   * Molecules whose gate has closed and whose next step is runnable — the gate-resume discovery
   * call. It is `bd ready --gated`, NOT `bd mol ready --gated`: that form errors with "unknown flag:
   * --gated" on both 1.1.0 and 1.1.2 (contradicting its own usage line), and bare `bd mol ready`
   * lists EVERY ready molecule step, so it is not a substitute.
   *
   * PARENTED BEADS ONLY (measured on 1.1.0 and 1.1.2, anton-k0kj): bd reports a gated bead here
   * only when it HAS a parent — which it names as the `molecule_id`, molecule or not. A gate hung on
   * a PARENTLESS bead (a standalone task/bug run target, a top-level feature, the target a run's own
   * `gh:pr` merge gate blocks) never appears, before or after it closes: that bead simply returns to
   * ordinary `bd ready`, which nothing in anton polls. So both board-derived halves of gate-check —
   * the merge finalization and `plainGateResumes` — exist because this call cannot see them.
   */
  readyGated: (repo: string): Promise<GatedMolecule[]> =>
    bdGate(repo, ["ready", "--gated", "--json", "--limit", "0"]).then(asArray<GatedMolecule>),

  /**
   * ONE call for the whole board: `bd list --json` carries each issue's `parent` and inline
   * `dependencies`, so grouping + edges are derived in-process — no per-epic/per-ticket spawns.
   * Reads the Dolt working set (reliable), unlike the JSONL export which lags uncommitted writes.
   *
   * `--limit 0` (unlimited) is REQUIRED: `bd list` defaults to 50 results, so without it a repo
   * with >50 issues returns a truncated slice — epics show only the children that happened to
   * land in the window (wrong ticket counts + wrong completion), and the autonomous jobs operate
   * on partial data. Callers may still override by passing their own `--limit` in `extra`.
   */
  list: (cwd: string, extra: string[] = []) =>
    bd(cwd, ["list", "--json", "--limit", "0", ...extra]).then(asArray<Bead>),

  show: async (cwd: string, id: string): Promise<Bead> => {
    // Count-only `bd show --json` (bd 1.1.0): deliberately WITHOUT --include-comments /
    // --include-dependents, so it returns the bead's fields + dependency counts without streaming
    // full comment/dependent bodies (slow on hub beads). anton's callers only need the bead itself
    // and its counts here; opt into hydration explicitly at the (rare) call site that needs it.
    // `bd show --json` returns an array (one or more issues), not an object.
    const parsed = JSON.parse(await bd(cwd, ["show", id, "--json"]));
    if (Array.isArray(parsed)) return parsed[0];
    return parsed.issue ?? parsed;
  },

  /** Pure argv builder for cook, exposed for testing (see buildUpdateArgs). */
  buildCookArgs,

  /**
   * Resolve a formula into its steps (`bd cook`, anton-brdg) — the ONLY place anton shells a formula
   * verb. `formula` is a path to a `.formula.{toml,json}` or a bare name bd resolves through its
   * search paths (`.beads/formulas/` first). Returns the typed pipeline; callers never parse stdout.
   *
   * A cook failure (unreadable file, unknown key, a runtime cook missing a variable) rejects with
   * {@link bd}'s error, whose message already carries the full argv — formula path included — and
   * bd's stderr, so a park message can name the file without this wrapper reformatting it.
   *
   * `exec` is injectable for tests, like {@link runDoltSync}; production passes none, so every cook
   * goes through the same bounded, process-group-reaped spawn as the rest of the seam.
   */
  cook: async (
    cwd: string,
    formula: string,
    opts: CookOptions = {},
    exec: BdExec = bd,
  ): Promise<CookedFormula> => {
    const out = await exec(cwd, buildCookArgs(formula, opts));
    return parseCookedFormula(out, formula);
  },

  /** All parent-child + blocks + related edges among the given beads, from inline `dependencies`. */
  edgesOf(beads: Bead[]): Array<{ from: string; to: string; type: string }> {
    const out: Array<{ from: string; to: string; type: string }> = [];
    for (const b of beads) {
      for (const d of b.dependencies ?? []) {
        if (d?.issue_id && d?.depends_on_id && d?.type) {
          out.push({ from: d.issue_id, to: d.depends_on_id, type: d.type });
        }
      }
    }
    return out;
  },

  /** Create a bead; returns its id (bd prints the id on the last line). */
  async create(
    cwd: string,
    opts: {
      title: string;
      type: "epic" | "feature" | "task" | "bug" | "chore";
      acceptance?: string;
      context?: string;
      description?: string; // the whole contract markdown (Goal / Acceptance / Context / …)
      labels?: string[]; // e.g. ["area:reports", "domain:eng"] — set at create time, not patched after
      deps?: string[]; // e.g. ["parent-child:bd-100"]
    },
  ): Promise<string> {
    const args = ["create", opts.title, "--type", opts.type];
    if (opts.acceptance) args.push("--acceptance", opts.acceptance);
    if (opts.context) args.push("--context", opts.context);
    // `bd tag` takes one label per call, so the whole set goes on the create (skills/bd/SKILL.md).
    if (opts.labels?.length) args.push("--labels", opts.labels.join(","));
    if (opts.deps?.length) args.push("--deps", opts.deps.join(","));
    if (opts.description) args.push("--description", opts.description);
    args.push("--json"); // plain output appends tips/status lines after the id; JSON is clean
    const out = await bdWrite(cwd, args);
    const parsed = JSON.parse(out);
    const bead = Array.isArray(parsed) ? parsed[0] : parsed;
    if (!bead?.id) throw new Error("bd create: could not parse bead id from output");
    return bead.id as string;
  },

  // `bd tag` takes a single label; use the repeatable --add-label/--remove-label instead.
  tag: (cwd: string, id: string, labels: string[]) =>
    bdWrite(cwd, ["update", id, ...labels.flatMap((l) => ["--add-label", l])]),
  untag: (cwd: string, id: string, labels: string[]) =>
    bdWrite(cwd, ["update", id, ...labels.flatMap((l) => ["--remove-label", l])]),

  link: (cwd: string, a: string, b: string, type: string) =>
    bdWrite(cwd, ["link", a, b, "--type", type]),

  /** Attach the PR to the bead as its external reference (git-shareable). */
  setExternalRef: (cwd: string, id: string, ref: string) =>
    bdWrite(cwd, ["update", id, "--external-ref", ref]),

  /**
   * Write the PR pointer to `metadata.pr` — the single seam anton uses for the PR link (anton-is7x).
   * Keeping it out of `external_ref` frees that field for tracker integrations; every read goes
   * through getPrRef, every write through here, so no call site touches `external_ref` for PRs.
   */
  setPrRef: (cwd: string, id: string, ref: string) =>
    bdWrite(cwd, ["update", id, "--set-metadata", `pr=${ref}`]),

  /**
   * Read a bead's PR pointer through the seam (anton-is7x). `metadata.pr` is authoritative; until the
   * one-time migration (anton-ftar) moves legacy pointers over, a `gh-*` `external_ref` is honored as
   * a fallback. A NON-`gh-` `external_ref` (e.g. a tracker URL) is deliberately ignored — external_ref
   * is no longer the PR channel, so a tracker link there must never read as a PR / in-review.
   */
  getPrRef: (b: Bead): string | undefined => {
    const pr = b.metadata?.pr;
    if (typeof pr === "string" && pr) return pr;
    const ref = b.external_ref;
    return ref && GH_PR_REF.test(ref) ? ref : undefined;
  },

  /**
   * One-time cutover primitive (anton-ftar): move a legacy `gh-*` external_ref onto `metadata.pr`
   * and clear external_ref in a SINGLE atomic `bd update` — no partial state to recover from. Only
   * ever called for gh- shaped refs (see planPrRefMigration), so a tracker URL in external_ref is
   * never touched. `--external-ref ""` is bd's clear-the-field form (like `--defer ""`).
   */
  migratePrRef: (cwd: string, id: string, ref: string) =>
    bdWrite(cwd, ["update", id, "--set-metadata", `pr=${ref}`, "--external-ref", ""]),

  /**
   * Append to a bead's notes blob (`bd note`). `actor` attributes the write in bd's audit trail —
   * pass it for a human note so the entry isn't stamped with whatever unix user the server runs
   * as; anton's own job notes leave it unset. The visible authorship a reader sees comes from the
   * note header itself (see beads/notes.ts), not from bd.
   */
  note: (cwd: string, id: string, text: string, actor?: string) =>
    bdWrite(cwd, ["note", id, text], actor ? { env: { BEADS_ACTOR: actor } } : undefined),

  /**
   * Append an entry to a bead's comment thread (`bd comment`). Unlike {@link note} — one blob that
   * later writes edit around — comments are append-only and individually timestamped, which is what
   * makes them the home for a history a reader replays in order (the per-round review scores,
   * anton-omum).
   */
  comment: (cwd: string, id: string, text: string) => bdWrite(cwd, ["comment", id, text]),

  /** The bead's existing `review-score:*` labels — the stale set {@link setReviewScore} replaces. */
  reviewScoreLabels: (b: Bead): string[] =>
    (b.labels ?? []).filter((l) => l.startsWith(REVIEW_SCORE_PREFIX)),

  /**
   * Publish the latest review score as a state label in ONE update: drop every prior
   * `review-score:*` (pass them as `stale`) and add the new value, so the prefix stays
   * single-valued the way `stage:*` does.
   */
  setReviewScore: (cwd: string, id: string, score: number, stale: string[] = []) =>
    bdWrite(cwd, [
      "update",
      id,
      ...stale.flatMap((l) => ["--remove-label", l]),
      "--add-label",
      LABELS.reviewScore(score),
    ]),

  close: (cwd: string, id: string) => bdWrite(cwd, ["close", id]),

  /**
   * Apply several board writes as ONE `bd batch` transaction (anton-aijz): every op lands or none
   * does, so a mid-flight failure leaves each bead in its prior state instead of stranding a
   * half-closed unit. Empty ops spawn nothing.
   *
   * Rejects on a real failure — with the batch already rolled back, so the caller's retry starts
   * from the state it expected. The ONE tolerated failure is a bd with no `batch` subcommand: those
   * ops are re-applied sequentially (loudly, since that path is not atomic), which is also what
   * `ANTON_BD_BATCH=0` selects up front.
   */
  batch: async (cwd: string, ops: BatchOp[]): Promise<void> => {
    if (ops.length === 0) return;
    if (batchEnabled()) {
      try {
        await bdWrite(cwd, ["batch", "--json"], { stdin: encodeBatchOps(ops) });
        return;
      } catch (e) {
        if (!isMissingBatchCommand(e)) throw e;
        console.warn(
          `[beads.batch] this bd has no 'batch' subcommand — applying ${ops.length} writes ` +
            `sequentially, which is NOT all-or-nothing. Upgrade bd, or set ${BD_BATCH_ENV}=0 to ` +
            `choose the sequential path deliberately and silence this.`,
        );
      }
    }
    for (const op of ops) await bdWrite(cwd, batchOpArgs(op));
  },

  /**
   * Permanently delete a bead and clean up references (`bd delete --force`). `cascade` also
   * deletes every dependent recursively — used for epics so their child tickets go with them;
   * without it, deleting an issue that still has dependents fails. This is irreversible.
   */
  delete: (cwd: string, id: string, opts: { cascade?: boolean } = {}) =>
    bdWrite(cwd, ["delete", id, "--force", ...(opts.cascade ? ["--cascade"] : [])]),

  /** Pure argv builder for prune, exposed for testing (see buildUpdateArgs). */
  buildPruneArgs,

  /**
   * Prune piled-up closed beads (`bd prune`, anton-uobe) — permanent deletion of closed,
   * non-ephemeral, non-pinned beads only; open/in_progress beads are never touched (bd itself
   * guarantees this — never weaken it here). Default is a dry-run preview; `force` deletes (a
   * write, so the board snapshot invalidates and counts refresh). Returns the affected count:
   * bd emits `prune_count` on a dry-run and `pruned_count` on a force AND on the
   * nothing-to-prune message — read both.
   */
  prune: async (cwd: string, age: PruneAge, opts: { force?: boolean } = {}): Promise<number> => {
    const args = buildPruneArgs(age, opts);
    const out = opts.force ? await bdWrite(cwd, args) : await bd(cwd, args);
    const parsed = JSON.parse(out || "{}") as { prune_count?: number; pruned_count?: number };
    const count = parsed.pruned_count ?? parsed.prune_count;
    if (count === undefined) {
      // Neither field present — likely a bd output-format change; surface it instead of a silent 0.
      console.warn("[beads.prune] unexpected bd output — no prune_count/pruned_count:", out.slice(0, 200));
    }
    return count ?? 0;
  },

  // ── board hygiene (anton-6qbc) ── the gardener patrol's verbs; see the section above for the
  // measured output shapes and for why `--auto-merge` / `--fix` are absent.

  /** Pure argv builders for the two hygiene verbs that take options (see buildUpdateArgs). */
  buildLintArgs,
  buildStaleArgs,

  /**
   * `bd epic close-eligible` — close epics whose children are ALL closed. The one structural write
   * the patrol may make, so it defaults to a preview: pass `apply` to actually close. The apply is a
   * bdWrite (snapshot invalidates); the preview is a plain read.
   *
   * bd itself owns the eligibility rule, deliberately — an epic with an open child is not eligible,
   * and neither is a CHILDLESS epic (both measured), which is what keeps a freshly-created empty
   * epic from being closed out from under the person shaping it.
   */
  epicCloseEligible: async (
    cwd: string,
    opts: { apply?: boolean } = {},
  ): Promise<EpicCloseSweep> => {
    const dryRun = !opts.apply;
    const args = ["epic", "close-eligible", ...(dryRun ? ["--dry-run"] : []), "--json"];
    const out = await (dryRun ? bd : bdWrite)(cwd, args);
    return parseEpicCloseEligible(out, dryRun);
  },

  /** `bd lint` — beads missing the template sections their type requires. Read-only. */
  lintReport: (cwd: string, opts: LintOpts = {}): Promise<LintReport> =>
    bd(cwd, buildLintArgs(opts)).then(parseLintReport),

  /**
   * `bd stale` — beads untouched for `days` (bd's default: 30), optionally scoped to ONE status.
   * The patrol sweeps per status because the thresholds differ: a month-old `open` bead is backlog,
   * a month-old `in_progress` one is an abandoned run. Read-only; returns ordinary beads.
   */
  staleList: (cwd: string, opts: StaleOpts = {}): Promise<Bead[]> =>
    bd(cwd, buildStaleArgs(opts)).then(asArray<Bead>),

  /**
   * `bd orphans` — beads named by a commit message that are still open: work that shipped and was
   * never closed. bd matches commits from the cwd repo's git history, so this carries the same
   * "spawn in the project repo" rule the gate verbs do. Read-only: `--fix` is never passed.
   */
  orphansList: (cwd: string): Promise<OrphanBead[]> =>
    bd(cwd, ["orphans", "--json"]).then(parseOrphans),

  /** `bd dep cycles` — blocking cycles in the dependency graph. Read-only; see {@link DepCycle}. */
  depCycles: (cwd: string): Promise<DepCycle[]> =>
    bd(cwd, ["dep", "cycles", "--json"]).then(parseDepCycles),

  /**
   * `bd duplicates` — groups of beads with identical content, with bd's suggested merge target.
   * Read-only by construction: `--auto-merge` is never passed, because merging duplicates is a
   * judgment move the patrol reports rather than makes.
   */
  duplicateGroups: (cwd: string): Promise<DuplicateGroup[]> =>
    bd(cwd, ["duplicates", "--json"]).then(parseDuplicateGroups),

  /**
   * `bd recompute-blocked` — rebuild the denormalized `is_blocked` flag from the dependency graph,
   * returning how many rows were wrong. Idempotent (a consistent board corrects 0 rows) but a WRITE:
   * it commits, so it goes through bdWrite. This is the patrol's other safe verb — `bd ready` trusts
   * that flag, so a stale one hides ready work or serves blocked work to a claimer.
   */
  recomputeBlocked: (cwd: string): Promise<number> =>
    bdWrite(cwd, ["recompute-blocked", "--json"]).then(parseRecomputeBlocked),

  reopen: (cwd: string, id: string) => bdWrite(cwd, ["reopen", id]),

  /**
   * Snooze a bead (`bd defer`) / restore it (`bd undefer`) — the "not now, but not dead" state
   * (anton-ywi8). A deferred bead keeps its contract, notes, and edges but drops out of `bd ready`,
   * so the runtime never picks it up; undefer returns it to `open`. Deliberately distinct from
   * close (finished) and from blocked (waiting on a specific dependency). Manual only — bd's
   * `--until <date>` scheduling is out of scope.
   */
  defer: (cwd: string, id: string) => bdWrite(cwd, ["defer", id]),
  undefer: (cwd: string, id: string) => bdWrite(cwd, ["undefer", id]),

  /** A bead snoozed out of the ready queue (`bd defer`). */
  isDeferred: (b: Bead) => b.status === "deferred",

  /**
   * Abandon a whole unit of work — the won't-do outcome (anton-6xj0), applied as a transaction
   * (anton-aijz). A cascade passes every bead it settles (descendants first, the target last); a
   * single abandon is the one-entry case. Each reason is REQUIRED — it is the durable record of the
   * decision — and every reason is validated before the first write, so a blank one writes nothing.
   * Deliberately NOT a delete (that destroys the history a won't-do decision is made of) and NOT a
   * plain close (that reads as shipped).
   *
   * Two phases, in this order:
   *   1. label each bead `abandoned` and drop its stage label. The stage is a claim on in-flight
   *      work — an abandoned bead has none, and leaving `stage:implementing` behind (set by the run
   *      that was killed to make room for this abandon) would keep it reading as in-flight. bd's
   *      batch grammar has no label key, so these stay N separate updates.
   *   2. close them all, with their reasons, in ONE `bd batch` — all-or-nothing.
   *
   * Label-then-close (the reverse of the original single-bead order) is what makes a cascade
   * recoverable. The only state a crash can leave is "open + abandoned", which no run picks up —
   * execute-epic gates on the LABEL, not the status — and which re-running abandon finishes,
   * because an open bead is still found by openDescendants and still passes the already-closed
   * guard. Closing first would leave N beads closed-without-the-label, reading as SHIPPED, with no
   * path left to correct them.
   */
  abandonAll: async (cwd: string, entries: Array<{ id: string; reason: string }>): Promise<void> => {
    const closes = entries.map(({ id, reason }): BatchOp => {
      const why = reason.trim();
      if (!why) throw new Error("abandon requires a reason");
      return { op: "close", id, reason: `abandoned: ${why}` };
    });
    if (closes.length === 0) return;
    for (const { id } of entries) {
      await bdWrite(cwd, [
        "update",
        id,
        "--add-label",
        LABELS.abandoned,
        "--remove-label",
        LABELS.stage("implementing"),
        "--remove-label",
        LABELS.stage("in-review"),
      ]);
    }
    await beads.batch(cwd, closes);
  },

  /** Abandon a single bead — see {@link beads.abandonAll}, of which this is the one-entry case. */
  abandon: (cwd: string, id: string, reason: string): Promise<void> =>
    beads.abandonAll(cwd, [{ id, reason }]),

  /** A bead a human abandoned (closed + `abandoned`) — closed, but explicitly NOT delivered. */
  isAbandoned: (b: Bead) => b.labels?.includes(LABELS.abandoned) ?? false,

  setStatus: (cwd: string, id: string, status: string) =>
    bdWrite(cwd, ["update", id, "--status", status]),

  /**
   * Atomically claim a bead: assignee + status in_progress, idempotent when already claimed by
   * the same actor (`bd update --claim`). The actor is passed explicitly via BEADS_ACTOR (bd's
   * highest-precedence identity) so the claim lands on the human operator who owns this anton
   * instance — not whatever unix user the server happens to run as.
   *
   * REJECTS when another actor already holds the bead ("issue already claimed by …"), which is what
   * makes this the local compare-and-swap {@link beads.claimVerified} builds the cross-machine
   * protocol on. It is the automation primitive: it flips status, so a human reservation goes
   * through {@link beads.assign} instead.
   */
  claim: (cwd: string, id: string, actor?: string) =>
    bdWrite(cwd, ["update", id, "--claim"], actor ? { env: { BEADS_ACTOR: actor } } : undefined),

  /** Pure argv builder for the claimable pool query, exposed for testing (see buildUpdateArgs). */
  buildClaimableReadyArgs,

  /** Pure ranker over an already-loaded board — see {@link rankClaimableTargets}. */
  rankClaimableTargets,

  /** Pure post-claim re-validation of a held target — see {@link staleClaimReason}. */
  staleClaimReason,

  /**
   * What any worker may claim right now, RANKED (anton-9anc): approved, unclaimed, blocker-free run
   * targets, ordered by priority, then by how many open beads each transitively unblocks, then by
   * age. One deterministic, explainable answer to "what does anton pick up next" — every consumer
   * reads this order rather than inventing its own, so the runner, the board, and the ready-count
   * nudge can never disagree about the queue.
   *
   * Two reads, taken together: bd's own ready query (blocker-awareness stays bd's job) and the full
   * board (`--status all`, the same read the approve route and execute-epic gate on, so a target
   * this returns is one anton will actually run). Reads only — claiming is {@link beads.claimVerified}.
   * `deps` is injectable for tests, like {@link runDoltSync}'s `exec`.
   */
  claimableTargets: async (
    cwd: string,
    deps: {
      ready?: (cwd: string) => Promise<Bead[]>;
      board?: (cwd: string) => Promise<Bead[]>;
    } = {},
  ): Promise<ClaimableTarget[]> => {
    const readPool = deps.ready ?? ((c: string) => bd(c, buildClaimableReadyArgs()).then(asArray<Bead>));
    const readBoard = deps.board ?? ((c: string) => beads.list(c, ["--status", "all"]));
    const [pool, board] = await Promise.all([readPool(cwd), readBoard(cwd)]);
    return rankClaimableTargets(pool, board);
  },

  /**
   * Claim a target for `actor` and PROVE the claim held (anton-9anc) — pull, claim, push, settle,
   * re-pull, re-show, assert assignee, re-validate the target. Never throws: it answers `ok` (we
   * hold it and it is still runnable), `lost` (another actor holds it — the protocol working, so a
   * pickup loop moves on), `stale` (we hold it but it left the claimable set while we settled; the
   * caller must not run it and owns releasing the claim) or `unverified` (we could not prove either
   * way, so the caller must not run the target; a retry is safe).
   *
   * Why each leg exists — claims ride eventually-consistent Dolt sync, so no single step is enough:
   * the pull surfaces a claim another machine already published (bd then refuses ours for free), the
   * push publishes ours, the settle gives a near-simultaneous rival time to reach the remote, and
   * the re-read is what turns "we wrote it" into "we hold it" after the merge picks a winner. This
   * is the run-lease arbitration pattern (anton-jz1) applied to the assignee, and it NARROWS rather
   * than closes the window — a real cross-process lock needs a bd primitive that doesn't exist
   * (anton-od4), which is why a claim remains advisory.
   *
   * Composes with the human-claim guard rather than duplicating it: the whole sequence runs on the
   * SAME per-bead write chain claim.ts's CAS uses, so an operator's Claim and a worker's pickup are
   * ordered against each other in this process, and bd's `--claim` — not a re-implemented
   * read-then-write CAS — is the local compare-and-swap. Never call it from inside a
   * `withClaimLock` body (it would wait on the lock that body holds).
   */
  claimVerified: (
    cwd: string,
    id: string,
    actor: string,
    deps: ClaimVerifiedDeps = {},
  ): Promise<ClaimVerification> => {
    const who = actor.trim();
    // A blank actor can't be asserted against the post-claim assignee (bd would fall back to
    // git user.name / $USER), so every verdict below would be a guess. Caller bug — fail loud.
    if (!who) throw new Error(`claimVerified(${id}): an actor is required to verify a claim`);
    return withBeadWriteLock(cwd, id, () => runClaimVerified(cwd, id, who, deps));
  },

  /**
   * Set a bead's assignee WITHOUT touching status (`bd assign <id> <actor>`). This is the
   * human-reservation primitive: unlike `claim`, it never flips the bead to in_progress, so the
   * bead stays `open` and deriveStage stays `backlog` — a person reserves it without triggering a
   * run. `actor` is a positional arg (not BEADS_ACTOR) because `bd assign` names the assignee
   * directly; do NOT route human claims through `claim`, which is the automation-run primitive.
   */
  assign: (cwd: string, id: string, actor: string) => bdWrite(cwd, ["assign", id, actor]),

  /** Clear a bead's assignee (`bd assign <id> ""`) — used when releasing a claim. */
  unassign: (cwd: string, id: string) => bdWrite(cwd, ["assign", id, ""]),

  /** Pure argv builder, exposed for testing and callers that want to inspect the write. */
  buildUpdateArgs,

  /**
   * Apply a field patch as ONE `bd update` invocation. `currentLabels` are the bead's existing
   * labels, needed to diff managed prefixes without disturbing control labels. A patch that
   * touches nothing is a no-op (no bd is spawned).
   */
  update: async (
    cwd: string,
    id: string,
    patch: BeadPatch,
    currentLabels: string[] = [],
  ): Promise<void> => {
    const args = buildUpdateArgs(id, patch, currentLabels);
    if (!args) return;
    await bdWrite(cwd, args);
  },

  /**
   * Full sync with the Dolt remote (pull, commit if needed, then push), coalescing concurrent
   * calls per repo. Tolerant of a clean working set and of a workspace with no remote; REJECTS
   * on a real push failure — call sites must log or rethrow, never ignore the promise. Fire-and-
   * forget callers read delivery from the sync-status registry, not the resolution — only the
   * durable job needs the outcome, so only `push` surfaces it.
   */
  sync: async (cwd: string): Promise<void> => {
    await doltSync(cwd, "full");
  },

  /**
   * Pull-only sync (heartbeat): remote changes land locally without pushing. Never pushes —
   * see SyncMode. Shares the per-repo coalescing with `sync`, so passes never overlap.
   */
  pull: async (cwd: string): Promise<void> => {
    await doltSync(cwd, "pull");
  },

  /**
   * Heartbeat backstop pass (anton-sr8f): pulls, plus retries a push when this repo has unpushed
   * local commits (a prior write-nudged push failed) OR has not yet been reconciled by this process
   * — the first backstop after a (re)start runs one reconciling full pass so commits stranded by a
   * crash before their push still ship, since the in-memory backlog count can't survive a restart
   * (anton-z908). A caught-up, reconciled repo pulls only — idle repos stay quiet. Shares the
   * per-repo coalescer with `sync`/`pull`, so a backstop push can never overlap a write-nudged one
   * (beads GH#2466); a not-wired repo is unaffected.
   */
  backstop: async (cwd: string): Promise<void> => {
    await doltSync(cwd, "backstop");
  },

  /**
   * Durable sync-push job pass (anton-nowq): always runs a full push to retry a write's commit,
   * unlike `backstop` which snapshots the (possibly stale) unpushed count and can drop to pull-only
   * when it coalesces behind a still-in-flight write push — leaving a push that then fails unretried
   * by the very job meant to retry/park it. Never inflates the backlog (the work is already counted).
   * Shares the per-repo coalescer with `sync`/`pull`/`backstop`, so it can never overlap another push
   * (beads GH#2466). REJECTS on a real push failure so the runner applies its retry/backoff/park
   * policy, and resolves "not-wired" when the repo has no remote — nothing was delivered, so the
   * caller must not treat that as a completed push (see makeSyncPushHandler).
   */
  push: (cwd: string): Promise<SyncOutcome> => doltSync(cwd, "push"),

  // ── convenience: anton's stage/approval semantics, all in beads ──
  approve: (cwd: string, epicId: string) => beads.tag(cwd, epicId, [LABELS.approved]),
  isApproved: (b: Bead) => b.labels?.includes(LABELS.approved) ?? false,
  isEpic: (b: Bead) => b.issue_type === "epic",

  /** The bead's parent id, from whichever field the bd read populated (`list` vs `show`). */
  parentOf: (b: Bead): string | undefined => (b.parent ?? b.parent_id) as string | undefined,

  /**
   * A bead that GROUPS run targets rather than being one: an epic with at least one `feature`
   * child. Each feature is its own run (own worktree, own PR), so executing or approving the epic
   * above them would be one button launching N PRs — not a gate. The rule is structural, not
   * type-only, so no existing bead needs re-typing: an epic becomes a container the moment a
   * feature lands under it (docs/design/2026-07-26-tier-and-linear-ux.md).
   */
  isContainer: (b: Bead, board: Bead[]): boolean =>
    beads.isEpic(b) && board.some((c) => c.issue_type === "feature" && beads.parentOf(c) === b.id),

  /**
   * A bead anton can execute as a run: a `feature` (the shippable delivery unit — one worktree,
   * one PR), a parentless task/bug (an "epic-of-one" — a single-ticket run), or a legacy `epic`
   * with no feature children (its own children batch into one PR, exactly as before the tier
   * split). A task/bug WITH a parent is a child ticket, executed as part of its run target's run;
   * every other type (chore, learning, molecule, …) is never runnable on its own. Shared by
   * execute-epic (the run gate) and the approve route (validating targets before enqueue) so both
   * agree on what "runnable" means.
   *
   * `board` — the bead list the container check reads — is REQUIRED, deliberately: a permissive
   * default would answer the pre-tier question (every epic is runnable) at every boundary that
   * holds only a single `bd show` bead, letting a container epic be claimed, PR-linked and moved
   * to review, after which review-fix would run it and close its feature children on merge. Every
   * classification site loads the full list already; pass it.
   *
   * Pipeline plumbing (`molecule`/`gate`) is refused UP FRONT rather than left to fall out of the
   * whitelist below (anton-ve2r): the whitelist excludes it only by luck of type, and a run target
   * is what approval enqueues — a gate reaching it would hand a run an async wait to execute.
   */
  isRunTarget: (b: Bead, board: Bead[]): boolean =>
    !isPipelineArtifact(b) &&
    (b.issue_type === "feature" ||
      (beads.isEpic(b) && !beads.isContainer(b, board)) ||
      ((b.issue_type === "task" || b.issue_type === "bug") && !beads.parentOf(b))),

  /**
   * Does this run target execute its CHILDREN as its tickets, rather than being its own single
   * ticket? An epic always groups (a childless one is a poison run, exactly as before the tier
   * split); a feature groups only once tickets are shaped under it — a feature shaped as one unit
   * of work IS its own ticket. Everything else is a leaf. Shared by execute-epic (which tickets a
   * run works through) and epic-detail (which tickets its page shows) so the run and its detail
   * page never disagree about what the target contains.
   */
  groupsChildren: (b: Bead, children: Bead[]): boolean =>
    beads.isEpic(b) || (b.issue_type === "feature" && children.length > 0),

  // ── cross-machine run-liveness lease (anton-jz1) ──

  /** The `run-lease:*` labels currently on a bead (normally 0 or 1; a crashed refresh may leave 2). */
  runLeaseLabels: (b: Bead): string[] =>
    (b.labels ?? []).filter((l) => l.startsWith(RUN_LEASE_PREFIX)),

  /**
   * Expiry (ms epoch) of the bead's run-lease, or undefined when absent/malformed. Takes the MAX
   * across labels so a lingering older lease can't make a fresher one read as expired.
   */
  runLeaseExpiry: (b: Bead): number | undefined => {
    let max: number | undefined;
    for (const l of b.labels ?? []) {
      if (!l.startsWith(RUN_LEASE_PREFIX)) continue;
      const { expiry } = parseRunLease(l);
      if (expiry !== undefined && (max === undefined || expiry > max)) max = expiry;
    }
    return max;
  },

  /**
   * Is a run actively executing this bead on some machine right now? True iff it carries a
   * run-lease whose expiry is still in the future. An expired lease (crashed/killed machine that
   * stopped heartbeating, or a settled run) reads false so the epic is re-triggerable (anton-jz1).
   */
  isRunLive: (b: Bead, nowMs: number): boolean => {
    const exp = beads.runLeaseExpiry(b);
    return exp !== undefined && exp > nowMs;
  },

  /**
   * Does the bead carry an UNEXPIRED run-lease owned by a run OTHER than `ownRunId` (anton-jz1)? A
   * queued execute-epic job that reschedules (quota/backoff) re-enters its handler WITHOUT the
   * enqueue-time liveRunCheck, so if a Force run started on another machine while this job was
   * parked, the fresh target now carries that machine's live lease. The handler treats this as a
   * park/retry condition rather than overwriting the lease — replacing it would let both machines
   * run the epic at once. This run's OWN lease (same owner, e.g. a crash leftover) and any expired
   * lease read false, so a resume sweeps and re-publishes its own lease normally. An owner-less lease
   * (legacy format, or a liveness-only publish that recorded no owner) is conservatively treated as
   * foreign when unexpired: parking is recoverable, a double-run is not.
   */
  foreignRunLeaseLive: (b: Bead, nowMs: number, ownRunId: string): boolean => {
    for (const l of b.labels ?? []) {
      if (!l.startsWith(RUN_LEASE_PREFIX)) continue;
      const { expiry, owner } = parseRunLease(l);
      if (expiry !== undefined && expiry > nowMs && owner !== ownRunId) return true;
    }
    return false;
  },

  /**
   * The bead's run-lease labels OWNED by `ownRunId` (anton-jz1) — the leases this run itself
   * published, matched by the `:<owner>` suffix. Used to sweep a run's OWN crash leftover on an
   * idempotent short-circuit that returns BEFORE the general lease-adoption step (the external-ref
   * early return in execute-epic): clearing these lets a stopped run free the epic immediately
   * instead of leaving it looking live until the TTL, while a foreign machine's lease is deliberately
   * left for its own owner/TTL to clear — honoring "finally clears only what we own".
   */
  ownRunLeaseLabels: (b: Bead, ownRunId: string): string[] =>
    (b.labels ?? []).filter(
      (l) => l.startsWith(RUN_LEASE_PREFIX) && parseRunLease(l).owner === ownRunId,
    ),

  /**
   * Tiebreak for two runs that acquired the lease at the same instant (anton-jz1). The foreign-lease
   * gate reads the board BEFORE a run publishes its own lease, so two machines force-running an epic
   * simultaneously can both clear that gate before either lease is visible remotely. After publishing,
   * a handler re-pulls and re-reads the target and calls this: it returns true iff `ownRunId` should
   * KEEP the lease and proceed, i.e. no OTHER live lease on the bead has an owner that sorts
   * lexicographically at or below `ownRunId`. Because every colliding run applies the same
   * lowest-owner-wins rule against the same merged label set, exactly one proceeds and the rest park.
   * An owner-less foreign live lease (legacy / liveness-only publish) can't be arbitrated, so this
   * yields (returns false): parking is recoverable, a double-run is not. No foreign live lease at all
   * → true (the run is uncontested).
   *
   * The lowest-owner-wins tiebreak is ONLY sound for that SYMMETRIC case — two fresh runs that raced
   * before either lease was visible. It is NOT safe against an already-live INCUMBENT (a run that
   * started earlier, only arbitrates at its own startup, and won't yield): from the label set alone
   * this function can't tell an incumbent from a co-racer, so a latecomer whose owner sorts lower
   * would wrongly "win" and double-run. The caller must therefore park on any foreign live lease when
   * its pre-check was stale (couldn't rule out an incumbent) and only reach this arbitration after a
   * trusted, fresh pre-check — see execute-epic step 1b (`preCheckTrusted`).
   */
  winsRunLeaseRace: (b: Bead, nowMs: number, ownRunId: string): boolean => {
    for (const l of b.labels ?? []) {
      if (!l.startsWith(RUN_LEASE_PREFIX)) continue;
      const { expiry, owner } = parseRunLease(l);
      if (expiry === undefined || expiry <= nowMs) continue; // expired: not a live contender
      if (owner === ownRunId) continue; // our own lease
      if (owner === undefined || owner <= ownRunId) return false; // a foreign owner sorts first → it wins
    }
    return true;
  },

  /**
   * Publish/refresh the run-lease on the target, atomically replacing any existing lease labels
   * (`stale`, e.g. the prior expiry this process published, or leftovers from a crashed run) in a
   * single `bd update`. Removing a label that isn't present is a bd no-op, so a slightly-stale
   * `stale` list is harmless. `owner` stamps the publishing run's id onto the lease so a resuming
   * handler can distinguish its own lease from another machine's (see foreignRunLeaseLive).
   */
  publishRunLease: (
    cwd: string,
    id: string,
    expiresAtMs: number,
    stale: string[] = [],
    owner?: string,
  ) =>
    bdWrite(cwd, [
      "update",
      id,
      ...stale.flatMap((l) => ["--remove-label", l]),
      "--add-label",
      LABELS.runLease(expiresAtMs, owner),
    ]),

  /** Remove the given run-lease labels from the target (run settled). No-op when there are none. */
  clearRunLease: (cwd: string, id: string, stale: string[]): Promise<string> =>
    stale.length === 0
      ? Promise.resolve("")
      : bdWrite(cwd, ["update", id, ...stale.flatMap((l) => ["--remove-label", l])]),
};
