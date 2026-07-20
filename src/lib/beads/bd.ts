/**
 * The single place anton talks to beads (bd). beads is the git-shareable source of truth for
 * work: epics/tickets, and — via labels + external-ref — approval, stage, and the PR link.
 * anton reads/writes here and never duplicates that state in anton.db. See DESIGN.md §3.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { invalidateIssueSnapshot } from "./snapshot";

// Bead/BeadDep live in the leaf ./types module so snapshot.ts can share them without importing
// bd.ts back (breaking the bd ↔ snapshot cycle, anton-mur). Re-exported here so every existing
// `from ".../beads/bd"` import keeps working.
export type { Bead, BeadDep } from "./types";
import type { Bead } from "./types";

const execFileAsync = promisify(execFile);

export const LABELS = {
  approved: "approved",
  stage: (s: "implementing" | "in-review") => `stage:${s}`,
  source: (s: string) => `source:${s}`,
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
} as const;

/** Prefix of the run-lease label (see LABELS.runLease). */
const RUN_LEASE_PREFIX = "run-lease:";

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
 * source:*) are NOT in this set and are never touched by a patch. */
export const LABEL_PREFIXES = ["agent", "risk", "size", "domain"] as const;
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

async function bd(cwd: string, args: string[], env?: Record<string, string>): Promise<string> {
  const { stdout } = await execFileAsync("bd", args, {
    cwd,
    maxBuffer: 32 * 1024 * 1024,
    timeout: 60_000,
    ...(env ? { env: { ...process.env, ...env } } : {}),
  });
  return stdout;
}

async function bdWrite(cwd: string, args: string[], env?: Record<string, string>): Promise<string> {
  const stdout = await bd(cwd, args, env);
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

/** A workspace with no Dolt remote — not an error, but a distinct visible state (not-wired):
 * the board must show "not wired to a shared remote" rather than pretending it's synced. */
const NOT_WIRED_OUTPUT = [/no remotes? (?:is )?configured/i];

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

export type SyncState = "unknown" | "not-wired" | "syncing" | "synced" | "failing";

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
}

const SYNC_STATUS_KEY = Symbol.for("anton.beads.syncStatus");

function statusRegistry(): Map<string, SyncStatus> {
  const g = globalThis as unknown as Record<symbol, Map<string, SyncStatus> | undefined>;
  return (g[SYNC_STATUS_KEY] ??= new Map());
}

export function getSyncStatus(cwd: string): SyncStatus {
  return (
    statusRegistry().get(cwd) ?? {
      state: "unknown",
      lastSyncedAt: null,
      lastPushedAt: null,
      unpushedCount: 0,
      lastError: null,
    }
  );
}

/**
 * Compact token for board refreshes. Repeated successful heartbeats do not change it, while every
 * user-visible health transition does (including gaining the first successful-sync timestamp and any
 * change to the unpushed-backlog count, which the badge renders).
 */
export function getSyncStatusToken(cwd: string): string {
  const status = getSyncStatus(cwd);
  const seen = status.lastSyncedAt === null ? "never" : "seen";
  return `${status.state}:${seen}:${status.unpushedCount}:${status.lastError ?? ""}`;
}

function recordStatus(cwd: string, patch: Partial<SyncStatus>): void {
  statusRegistry().set(cwd, { ...getSyncStatus(cwd), ...patch });
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
 */
export type SyncRequest = SyncMode | "backstop";

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
 */
export function createDoltSync(exec: BdExec = bd): (cwd: string, mode?: SyncRequest) => Promise<void> {
  const running = new Map<string, Promise<void>>();
  const trailing = new Map<string, { promise: Promise<void>; mode: SyncMode }>();
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
  const start = (cwd: string, mode: SyncMode, newWork: boolean): Promise<void> => {
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
    });
    running.set(cwd, p);
    // Bookkeeping only — callers hold `p` and see its rejection; this chain must not re-reject.
    void p
      .catch((e: Error) => {
        // A write-nudged full pass committed new work but never landed its push — grow the unpushed
        // backlog so the next heartbeat backstop retries, and the operator sees a truthful "N
        // unpushed" count instead of the failure hiding in server logs. A backstop retry (newWork
        // false) or a pull-only failure leaves the count as-is: the stranded work is already counted.
        const patch: Partial<SyncStatus> = { state: "failing", lastError: e.message };
        if (mode === "full" && newWork) patch.unpushedCount = getSyncStatus(cwd).unpushedCount + 1;
        recordStatus(cwd, patch);
      })
      .finally(() => {
        if (running.get(cwd) === p) running.delete(cwd);
      });
    return p;
  };

  return function sync(cwd: string, request: SyncRequest = "full"): Promise<void> {
    // Resolve the backstop to a push-retry when a prior push failed (recorded backlog) OR when this
    // process has not yet reconciled the repo — the backlog is in-memory only, so a cold start after
    // a crash that stranded local commits reads count 0 and must NOT pull forever without shipping
    // them (anton-z908 review). A caught-up, already-reconciled repo stays pull-only and quiet.
    const mode: SyncMode =
      request === "backstop"
        ? getSyncStatus(cwd).unpushedCount > 0 || !reconciled.has(cwd)
          ? "full"
          : "pull"
        : request;
    // Only a write-nudge introduces new local work; a backstop is a retry of already-counted commits.
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

/** bd --json returns either a top-level array or `{ issues: [...] }`. Normalize to an array. */
function asArray<T>(raw: string): T[] {
  const d = JSON.parse(raw || "[]");
  if (Array.isArray(d)) return d;
  if (d && Array.isArray(d.issues)) return d.issues;
  if (d && Array.isArray(d.results)) return d.results;
  return [];
}

export const beads = {
  /**
   * Truly claimable work (excludes in_progress/blocked/deferred). `--limit 0` = unlimited:
   * `bd ready` (like `bd list`) defaults to 50 results, which would silently drop work in a
   * repo with a large ready queue.
   */
  ready: (cwd: string) => bd(cwd, ["ready", "--json", "--limit", "0"]).then(asArray<Bead>),

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
    // `bd show --json` returns an array (one or more issues), not an object.
    const parsed = JSON.parse(await bd(cwd, ["show", id, "--json"]));
    if (Array.isArray(parsed)) return parsed[0];
    return parsed.issue ?? parsed;
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
      type: "epic" | "task" | "bug";
      acceptance?: string;
      context?: string;
      description?: string; // Goal / Out of scope / Verify (markdown)
      deps?: string[]; // e.g. ["parent-child:bd-100"]
    },
  ): Promise<string> {
    const args = ["create", opts.title, "--type", opts.type];
    if (opts.acceptance) args.push("--acceptance", opts.acceptance);
    if (opts.context) args.push("--context", opts.context);
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

  note: (cwd: string, id: string, text: string) => bdWrite(cwd, ["note", id, text]),
  close: (cwd: string, id: string) => bdWrite(cwd, ["close", id]),

  /**
   * Permanently delete a bead and clean up references (`bd delete --force`). `cascade` also
   * deletes every dependent recursively — used for epics so their child tickets go with them;
   * without it, deleting an issue that still has dependents fails. This is irreversible.
   */
  delete: (cwd: string, id: string, opts: { cascade?: boolean } = {}) =>
    bdWrite(cwd, ["delete", id, "--force", ...(opts.cascade ? ["--cascade"] : [])]),
  reopen: (cwd: string, id: string) => bdWrite(cwd, ["reopen", id]),
  setStatus: (cwd: string, id: string, status: string) =>
    bdWrite(cwd, ["update", id, "--status", status]),

  /**
   * Atomically claim a bead: assignee + status in_progress, idempotent when already claimed by
   * the same actor (`bd update --claim`). The actor is passed explicitly via BEADS_ACTOR (bd's
   * highest-precedence identity) so the claim lands on the human operator who owns this anton
   * instance — not whatever unix user the server happens to run as.
   */
  claim: (cwd: string, id: string, actor?: string) =>
    bdWrite(cwd, ["update", id, "--claim"], actor ? { BEADS_ACTOR: actor } : undefined),

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
   * on a real push failure — call sites must log or rethrow, never ignore the promise.
   */
  sync: (cwd: string): Promise<void> => doltSync(cwd, "full"),

  /**
   * Pull-only sync (heartbeat): remote changes land locally without pushing. Never pushes —
   * see SyncMode. Shares the per-repo coalescing with `sync`, so passes never overlap.
   */
  pull: (cwd: string): Promise<void> => doltSync(cwd, "pull"),

  /**
   * Heartbeat backstop pass (anton-sr8f): pulls, plus retries a push when this repo has unpushed
   * local commits (a prior write-nudged push failed) OR has not yet been reconciled by this process
   * — the first backstop after a (re)start runs one reconciling full pass so commits stranded by a
   * crash before their push still ship, since the in-memory backlog count can't survive a restart
   * (anton-z908). A caught-up, reconciled repo pulls only — idle repos stay quiet. Shares the
   * per-repo coalescer with `sync`/`pull`, so a backstop push can never overlap a write-nudged one
   * (beads GH#2466); a not-wired repo is unaffected.
   */
  backstop: (cwd: string): Promise<void> => doltSync(cwd, "backstop"),

  // ── convenience: anton's stage/approval semantics, all in beads ──
  approve: (cwd: string, epicId: string) => beads.tag(cwd, epicId, [LABELS.approved]),
  isApproved: (b: Bead) => b.labels?.includes(LABELS.approved) ?? false,
  isEpic: (b: Bead) => b.issue_type === "epic",

  /**
   * A bead anton can execute as a run: an epic (all its children batch into one PR) OR a
   * parentless task/bug (an "epic-of-one" — runs as a single-ticket run: branch anton/<id>, its
   * own PR, ticket closed). A task/bug WITH a parent is a child ticket, executed as part of its
   * epic's run, not a run target on its own; every other type (learning, molecule, …) is never
   * runnable. Shared by execute-epic (the run gate) and the approve route (validating targets
   * before enqueue) so both agree on what "runnable" means.
   */
  isRunTarget: (b: Bead) =>
    beads.isEpic(b) ||
    ((b.issue_type === "task" || b.issue_type === "bug") && !(b.parent ?? b.parent_id)),

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
