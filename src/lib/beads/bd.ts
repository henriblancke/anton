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
  /** Truly claimable work (excludes in_progress/blocked/deferred). */
  ready: (cwd: string) => bd(cwd, ["ready", "--json"]).then(asArray<Bead>),

  /**
   * ONE call for the whole board: `bd list --json` carries each issue's `parent` and inline
   * `dependencies`, so grouping + edges are derived in-process — no per-epic/per-ticket spawns.
   * Reads the Dolt working set (reliable), unlike the JSONL export which lags uncommitted writes.
   */
  list: (cwd: string, extra: string[] = []) =>
    bd(cwd, ["list", "--json", ...extra]).then(asArray<Bead>),

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
  reopen: (cwd: string, id: string) => bd(cwd, ["reopen", id]),
  setStatus: (cwd: string, id: string, status: string) =>
    bd(cwd, ["update", id, "--status", status]),

  // ── convenience: anton's stage/approval semantics, all in beads ──
  approve: (cwd: string, epicId: string) => beads.tag(cwd, epicId, [LABELS.approved]),
  isApproved: (b: Bead) => b.labels?.includes(LABELS.approved) ?? false,
  isEpic: (b: Bead) => b.issue_type === "epic",
};
