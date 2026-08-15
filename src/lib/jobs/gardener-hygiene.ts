/**
 * The gardener patrol's two MECHANICAL tiers (anton-l4do), split out of gardener.ts so the handler
 * reads as an orchestration and each tier can be exercised without a job queue.
 *
 *   • {@link applySafeVerbs} — the only two writes the patrol may make, both provably mechanical.
 *   • {@link collectFindings} — the read-only report verbs, and the pure builders that turn each
 *     one's output into report rows.
 *
 * The ordering between the two is the handler's contract, not this module's: the writes run first so
 * the report describes the board as it now stands (see jobs/gardener.ts).
 */
import { beads, type DuplicateGroup } from "../beads/bd";
import type { HygieneActions, HygieneFinding } from "../hygiene";
import type { JobContext } from "./runner";

/**
 * How long untouched is "stale", per status. The two differ because the same silence means different
 * things: a month-old `open` bead is backlog (bd's own default window), while an `in_progress` one
 * untouched for a week is an abandoned run that still reads as in-flight to every other reader of
 * the board — including anton's own claim protocol.
 */
export const STALE_OPEN_DAYS = 30;
export const STALE_IN_PROGRESS_DAYS = 7;

/** Trim a bead title for a one-line finding — a wrapped title reads as noise in a report. */
function short(title: string | undefined, max = 80): string {
  const text = (title ?? "").trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

// ── finding builders (pure; each turns one bd verb's output into report rows) ──

/** `bd lint`: beads missing the template sections their type requires. */
export function lintFindings(
  violations: Array<{ id: string; title: string; type: string; missing: string[] }>,
): HygieneFinding[] {
  return violations.map((v) => ({
    kind: "lint" as const,
    key: `lint:${v.id}`,
    beadId: v.id,
    title: short(v.title),
    detail: v.missing.length
      ? `${v.type || "bead"} is missing ${v.missing.join(", ")}`
      : `${v.type || "bead"} does not match its template`,
  }));
}

/**
 * `bd stale`, scoped to one status. Kept separate per status rather than merged into one kind
 * because the two need different answers: a stale `open` bead is a backlog decision, a stale
 * `in_progress` one is a run nobody finished.
 */
export function staleFindings(
  beadsList: Array<{ id: string; title?: string; assignee?: string | null }>,
  status: "open" | "in_progress",
  days: number,
): HygieneFinding[] {
  const kind = status === "open" ? ("stale-open" as const) : ("stale-in-progress" as const);
  return beadsList.map((b) => ({
    kind,
    key: `${kind}:${b.id}`,
    beadId: b.id,
    title: short(b.title),
    detail:
      status === "open"
        ? `open and untouched for over ${days} days`
        : `in progress and untouched for over ${days} days${b.assignee ? ` (assignee ${b.assignee})` : ""}`,
  }));
}

/** `bd orphans`: work a commit shipped that nobody ever closed. */
export function orphanFindings(
  orphans: Array<{ id: string; title: string; status: string; latestCommit?: string }>,
): HygieneFinding[] {
  return orphans.map((o) => ({
    kind: "orphan" as const,
    key: `orphan:${o.id}`,
    beadId: o.id,
    title: short(o.title),
    detail: `named by a commit${o.latestCommit ? ` (${o.latestCommit})` : ""} but still ${o.status}`,
  }));
}

/**
 * `bd dep cycles`. A cycle whose member ids bd's payload doesn't spell out is still reported — "the
 * graph has a cycle we can't name" is the finding, and dropping it would hide the one condition this
 * verb exists to surface. Unnamed cycles are keyed by index so two of them don't collapse into one.
 */
export function cycleFindings(cycles: Array<{ ids: string[] }>): HygieneFinding[] {
  return cycles.map((cycle, i) => ({
    kind: "dep-cycle" as const,
    key: `dep-cycle:${cycle.ids.length ? [...cycle.ids].sort().join("+") : `unnamed-${i}`}`,
    ids: cycle.ids,
    detail: cycle.ids.length
      ? `dependency cycle: ${cycle.ids.join(" → ")}`
      : "dependency cycle bd reported in a shape anton could not read — inspect with `bd dep cycles`",
  }));
}

/**
 * `bd duplicates`: groups of beads with identical content, with bd's suggested merge target carried
 * through. Reported only — the merge is a judgment move, so the finding names the target instead of
 * applying it. Keyed on the whole member set so a group that gains a third duplicate reads as a new
 * finding rather than silently mutating the old one.
 */
export function duplicateFindings(groups: DuplicateGroup[]): HygieneFinding[] {
  return groups.flatMap((group) => {
    const ids = group.members.map((m) => m.id).sort();
    if (ids.length < 2) return []; // not a duplicate group at all
    return [
      {
        kind: "duplicate" as const,
        key: `duplicate:${ids.join("+")}`,
        ids,
        title: short(group.title),
        detail:
          `${ids.length} beads with identical content: ${ids.join(", ")}` +
          (group.target ? ` — bd suggests keeping ${group.target}` : ""),
      },
    ];
  });
}

/** The heartbeat half of a job context — all these tiers need of the runner. */
type Beating = Pick<JobContext, "heartbeat">;

/**
 * TIER 1 — the two safe verbs, the patrol's only mechanical writes.
 *
 * `bd epic close-eligible` (an epic whose children are ALL closed is done by definition; bd refuses
 * an epic with an open child and a childless one) and `bd recompute-blocked` (rebuild the
 * denormalized `is_blocked` flag from the graph — `bd ready` trusts that flag, so a stale one hides
 * ready work or serves blocked work to a claimer). Both idempotent, which is what lets a retry after
 * a later failure re-run them harmlessly.
 */
export async function applySafeVerbs(repo: string, ctx: Beating): Promise<HygieneActions> {
  const sweep = await beads.epicCloseEligible(repo, { apply: true });
  await ctx.heartbeat();
  const rowsRecomputed = await beads.recomputeBlocked(repo);
  await ctx.heartbeat();
  return { closedEpics: sweep.closed, rowsRecomputed };
}

/**
 * TIER 2 — the report verbs, all read-only. Everything they find is REPORTED and nothing more:
 * merging duplicates, retiring stale work and relinking orphans are judgment moves that reach the
 * board as proposals, never as a patrol's write.
 *
 * A failure propagates rather than degrading to "nothing found": the report REPLACES what the board
 * shows, so a partial one is indistinguishable from a clean bill of health.
 */
export async function collectFindings(repo: string, ctx: Beating): Promise<HygieneFinding[]> {
  const lint = await beads.lintReport(repo);
  const staleOpen = await beads.staleList(repo, { status: "open", days: STALE_OPEN_DAYS });
  const staleInProgress = await beads.staleList(repo, {
    status: "in_progress",
    days: STALE_IN_PROGRESS_DAYS,
  });
  await ctx.heartbeat();
  const orphans = await beads.orphansList(repo);
  const cycles = await beads.depCycles(repo);
  const duplicates = await beads.duplicateGroups(repo);

  return [
    ...lintFindings(lint.violations),
    ...staleFindings(staleOpen, "open", STALE_OPEN_DAYS),
    ...staleFindings(staleInProgress, "in_progress", STALE_IN_PROGRESS_DAYS),
    ...orphanFindings(orphans),
    ...cycleFindings(cycles),
    ...duplicateFindings(duplicates),
  ];
}
