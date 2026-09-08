/**
 * The board-hygiene seam (anton-6qbc): typed shapes, argv builders and parsers for bd's own
 * hygiene verbs. Lifted out of ./bd (anton-lsad); the `beads.*` wrappers there are the spawns,
 * everything here is pure over bd's stdout.
 */
import { num, pick, str, strings } from "./bd-json";
import type { Bead } from "./types";

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
  const idsOf = (node: unknown): string[] => {
    if (typeof node === "string") return [node];
    if (Array.isArray(node)) return node.flatMap(idsOf);
    const o = node as Record<string, unknown> | null;
    if (!o || typeof o !== "object") return [];
    const named = o.cycle ?? o.path ?? o.ids ?? o.issue_ids ?? o.issues ?? o.nodes;
    if (named !== undefined) return idsOf(named);
    const id = str(o.id) ?? str(o.issue_id);
    return id ? [id] : [];
  };
  return parsed.map((entry) => ({ ids: idsOf(entry), raw: entry }));
}

/**
 * Read `bd duplicates --json` — an object envelope `{duplicate_groups, groups, schema_version}`
 * where `groups` carries the groups and `duplicate_groups` is their COUNT, not a second encoding of
 * them. Only `groups` is read; the count is redundant with it.
 */
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
