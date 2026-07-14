/**
 * The single place anton talks to beads (bd). beads is the git-shareable source of truth for
 * work: epics/tickets, and — via labels + external-ref — approval, stage, and the PR link.
 * anton reads/writes here and never duplicates that state in anton.db. See DESIGN.md §3.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface Bead {
  id: string;
  title: string;
  status: string; // open | in_progress | blocked | closed | ...
  assignee?: string; // who owns the bead — set by an automated run's claim (anton-ner.1)
  issue_type?: string; // epic | task | bug | ...
  description?: string;
  acceptance?: string;
  acceptance_criteria?: string; // the field bd show/dep return
  context?: string;
  labels?: string[];
  external_ref?: string;
  priority?: number;
  parent?: string; // parent epic id (present in `bd list --json` for structured boards)
  parent_id?: string;
  dependencies?: BeadDep[]; // edges carried inline by `bd list --json`
  dependency_type?: string; // set on beads returned by `bd dep list`
  [k: string]: unknown;
}

export interface BeadDep {
  issue_id: string; // the dependent
  depends_on_id: string; // what it depends on / is a child of
  type: string; // parent-child | blocks | related | discovered-from
}

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

async function bd(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("bd", args, {
    cwd,
    maxBuffer: 32 * 1024 * 1024,
    timeout: 60_000,
  });
  return stdout;
}

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
    const out = await bd(cwd, args);
    const parsed = JSON.parse(out);
    const bead = Array.isArray(parsed) ? parsed[0] : parsed;
    if (!bead?.id) throw new Error("bd create: could not parse bead id from output");
    return bead.id as string;
  },

  // `bd tag` takes a single label; use the repeatable --add-label/--remove-label instead.
  tag: (cwd: string, id: string, labels: string[]) =>
    bd(cwd, ["update", id, ...labels.flatMap((l) => ["--add-label", l])]),
  untag: (cwd: string, id: string, labels: string[]) =>
    bd(cwd, ["update", id, ...labels.flatMap((l) => ["--remove-label", l])]),

  link: (cwd: string, a: string, b: string, type: string) =>
    bd(cwd, ["link", a, b, "--type", type]),

  /** Attach the PR to the bead as its external reference (git-shareable). */
  setExternalRef: (cwd: string, id: string, ref: string) =>
    bd(cwd, ["update", id, "--external-ref", ref]),

  note: (cwd: string, id: string, text: string) => bd(cwd, ["note", id, text]),
  close: (cwd: string, id: string) => bd(cwd, ["close", id]),

  /**
   * Permanently delete a bead and clean up references (`bd delete --force`). `cascade` also
   * deletes every dependent recursively — used for epics so their child tickets go with them;
   * without it, deleting an issue that still has dependents fails. This is irreversible.
   */
  delete: (cwd: string, id: string, opts: { cascade?: boolean } = {}) =>
    bd(cwd, ["delete", id, "--force", ...(opts.cascade ? ["--cascade"] : [])]),
  reopen: (cwd: string, id: string) => bd(cwd, ["reopen", id]),
  setStatus: (cwd: string, id: string, status: string) =>
    bd(cwd, ["update", id, "--status", status]),

  /**
   * Claim a bead for an actor: set `in_progress` AND an `--assignee` in one write, so the board
   * shows who owns in-flight work (not just that it's in progress) and a human or a second run can
   * see the ticket is taken (anton-ner.1). Use a stable actor (e.g. `anton`) so re-claiming on a
   * resume is a harmless no-op — `bd update --assignee anton` on an already-claimed bead just
   * rewrites the same values.
   */
  claim: (cwd: string, id: string, actor: string) =>
    bd(cwd, ["update", id, "--status", "in_progress", "--assignee", actor]),

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
    await bd(cwd, args);
  },

  // ── convenience: anton's stage/approval semantics, all in beads ──
  approve: (cwd: string, epicId: string) => beads.tag(cwd, epicId, [LABELS.approved]),
  isApproved: (b: Bead) => b.labels?.includes(LABELS.approved) ?? false,
  isEpic: (b: Bead) => b.issue_type === "epic",
};
