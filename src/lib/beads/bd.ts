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
} as const;

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

function labelValueOf(labels: string[] | undefined, prefix: string): string | undefined {
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
  // Local callers expect their next read to observe the completed write, so discard old data.
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
  /** ms epoch of the last successful pass; survives later failures for "last synced Xs ago". */
  lastSyncedAt: number | null;
  lastError: string | null;
}

const SYNC_STATUS_KEY = Symbol.for("anton.beads.syncStatus");

function statusRegistry(): Map<string, SyncStatus> {
  const g = globalThis as unknown as Record<symbol, Map<string, SyncStatus> | undefined>;
  return (g[SYNC_STATUS_KEY] ??= new Map());
}

export function getSyncStatus(cwd: string): SyncStatus {
  return statusRegistry().get(cwd) ?? { state: "unknown", lastSyncedAt: null, lastError: null };
}

/**
 * Compact token for board refreshes. Repeated successful heartbeats do not change it, while every
 * user-visible health transition does (including gaining the first successful-sync timestamp).
 */
export function getSyncStatusToken(cwd: string): string {
  const status = getSyncStatus(cwd);
  return `${status.state}:${status.lastSyncedAt === null ? "never" : "seen"}:${status.lastError ?? ""}`;
}

function recordStatus(cwd: string, patch: Partial<SyncStatus>): void {
  statusRegistry().set(cwd, { ...getSyncStatus(cwd), ...patch });
}

/**
 * Sync pass modes. "full" (write-nudged): pull → commit → push. "pull": pull only — used by the
 * heartbeat, which must NOT push when there are no local changes; every anton instance pushing
 * a shared remote every ~10s is the concurrent-push manifest-corruption pattern (beads GH#2466).
 */
export type SyncMode = "full" | "pull";

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
 */
export function createDoltSync(exec: BdExec = bd): (cwd: string, mode?: SyncMode) => Promise<void> {
  const running = new Map<string, Promise<void>>();
  const trailing = new Map<string, { promise: Promise<void>; mode: SyncMode }>();
  const trailingMode = new Map<string, SyncMode>(); // live handle so an upgrade reaches the queued run

  const start = (cwd: string, mode: SyncMode): Promise<void> => {
    recordStatus(cwd, { state: "syncing" });
    const p = runDoltSync(cwd, exec, mode).then((outcome) => {
      if (outcome === "not-wired") {
        recordStatus(cwd, { state: "not-wired", lastError: null });
      } else {
        // Retain the last valid data while a background read refreshes after the remote pull.
        invalidateIssueSnapshot(cwd);
        recordStatus(cwd, { state: "synced", lastSyncedAt: Date.now(), lastError: null });
      }
    });
    running.set(cwd, p);
    // Bookkeeping only — callers hold `p` and see its rejection; this chain must not re-reject.
    void p
      .catch((e: Error) => {
        recordStatus(cwd, { state: "failing", lastError: e.message });
      })
      .finally(() => {
        if (running.get(cwd) === p) running.delete(cwd);
      });
    return p;
  };

  return function sync(cwd: string, mode: SyncMode = "full"): Promise<void> {
    const queued = trailing.get(cwd);
    if (queued) {
      if (mode === "full") trailingMode.set(cwd, "full");
      return queued.promise;
    }
    const current = running.get(cwd);
    if (!current) return start(cwd, mode);
    trailingMode.set(cwd, mode);
    const next = current
      .catch(() => {}) // the current run's failure belongs to its own callers
      .then(() => {
        trailing.delete(cwd);
        const m = trailingMode.get(cwd) ?? "full";
        trailingMode.delete(cwd);
        return start(cwd, m);
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

  /** Clear a bead's assignee (`bd assign <id> ""`) — used when releasing a stale claim. */
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
};
