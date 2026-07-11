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
  context?: string;
  labels?: string[];
  external_ref?: string;
  priority?: number;
  [k: string]: unknown;
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

  /** All open issues, optionally filtered (e.g. `["--label", "approved"]`). */
  list: (cwd: string, extra: string[] = []) =>
    bd(cwd, ["list", "--json", ...extra]).then(asArray<Bead>),

  show: async (cwd: string, id: string): Promise<Bead> =>
    JSON.parse(await bd(cwd, ["show", id, "--json"])),

  /** Child beads of an epic. */
  children: (cwd: string, epicId: string) =>
    bd(cwd, ["children", epicId, "--json"]).then(asArray<Bead>),

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
    const out = await bd(cwd, args);
    const id = out.trim().split("\n").pop()?.trim();
    if (!id) throw new Error("bd create: could not parse bead id from output");
    return id;
  },

  tag: (cwd: string, id: string, labels: string[]) => bd(cwd, ["tag", id, ...labels]),
  untag: (cwd: string, id: string, labels: string[]) =>
    bd(cwd, ["label", "remove", id, ...labels]),

  link: (cwd: string, a: string, b: string, type: string) =>
    bd(cwd, ["link", a, b, "--type", type]),

  /** Attach the PR to the bead as its external reference (git-shareable). */
  setExternalRef: (cwd: string, id: string, ref: string) =>
    bd(cwd, ["update", id, "--external-ref", ref]),

  note: (cwd: string, id: string, text: string) => bd(cwd, ["note", id, text]),
  close: (cwd: string, id: string) => bd(cwd, ["close", id]),

  // ── convenience: anton's stage/approval semantics, all in beads ──
  approve: (cwd: string, epicId: string) => beads.tag(cwd, epicId, [LABELS.approved]),
  isApproved: (b: Bead) => b.labels?.includes(LABELS.approved) ?? false,
  isEpic: (b: Bead) => b.issue_type === "epic",
};
