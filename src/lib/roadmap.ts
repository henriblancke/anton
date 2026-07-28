/**
 * The roadmap: one row per product epic — the epic tier's own page. It answers "what is in flight,
 * and where does it live in Linear" and nothing else; it is read, not operated, which is why it is
 * a table and not a second board (docs/design/2026-07-26-tier-and-linear-ux.md).
 *
 * The rollup is pure over a bead list (like computeEpicGraph), so it costs no extra bd spawn and is
 * testable from a fixture board. The Linear ref is DISPLAYED, never fetched — no Linear API call
 * lives here or anywhere downstream of here.
 */
import { beads, GH_PR_REF, labelValueOf } from "./beads/bd";
import { allIssues } from "./beads/issues";
import { deriveStage } from "./ticket-view";
import type { Bead } from "./beads/bd";
import type { Project, RoadmapRow } from "./types";

/** Missing bead priority sorts after every explicit priority (bd uses 0=critical … 4=lowest). */
const DEFAULT_PRIORITY = 4;

/**
 * The tracker ref `bd linear sync --push` writes into `external_ref`. A `gh-<n>` value there is a
 * legacy PR pointer honoured by beads.getPrRef, never a Linear issue — surfacing it would show an
 * epic as synced that was never pushed.
 */
function linearRefOf(epic: Bead): string | undefined {
  const ref = epic.external_ref;
  return ref && !GH_PR_REF.test(ref) ? ref : undefined;
}

/** In-flight epics first, then the shipped ones; within each, the highest-priority and
 * longest-open work reads at the top. Stable on ties so the table never reshuffles between reads. */
function compareEpics(a: Bead, b: Bead): number {
  const doneA = deriveStage(a) === "done";
  const doneB = deriveStage(b) === "done";
  if (doneA !== doneB) return doneA ? 1 : -1;
  const pa = a.priority ?? DEFAULT_PRIORITY;
  const pb = b.priority ?? DEFAULT_PRIORITY;
  if (pa !== pb) return pa - pb;
  const ca = a.created_at ?? "";
  const cb = b.created_at ?? "";
  if (ca !== cb) return ca < cb ? -1 : 1;
  return a.id < b.id ? -1 : 1;
}

/**
 * Roll a full bead list up into roadmap rows: every epic-tier bead, its `area:` designator, its
 * feature rollup, and its tracker ref. Legacy epics (no `feature` children) are listed too — with
 * no area and no features they are exactly the un-migrated state the page exists to make visible.
 */
export function buildRoadmap(all: Bead[]): RoadmapRow[] {
  const featuresByEpic = new Map<string, Bead[]>();
  for (const bead of all) {
    if (bead.issue_type !== "feature") continue;
    const parent = beads.parentOf(bead);
    if (!parent) continue;
    const siblings = featuresByEpic.get(parent);
    if (siblings) siblings.push(bead);
    else featuresByEpic.set(parent, [bead]);
  }

  return all
    // An abandoned epic is a won't-do decision, not in-flight work — it has no place on a roadmap.
    .filter((bead) => beads.isEpic(bead) && !beads.isAbandoned(bead))
    .sort(compareEpics)
    .map((epic): RoadmapRow => {
      // An abandoned feature was never a delivery, so it leaves BOTH sides of the ratio — counted
      // in the denominator it would park an otherwise-complete epic at "1 / 2" forever.
      const features = (featuresByEpic.get(epic.id) ?? []).filter((f) => !beads.isAbandoned(f));
      return {
        id: epic.id,
        title: epic.title,
        area: labelValueOf(epic.labels, "area"),
        // Same fallback compareEpics sorts on, so the column can never disagree with the order.
        priority: epic.priority ?? DEFAULT_PRIORITY,
        features: features.length,
        shipped: features.filter((f) => deriveStage(f) === "done").length,
        linearRef: linearRefOf(epic),
      };
    });
}

/** The roadmap for a project, off the warm issue snapshot the board already reads. */
export async function getRoadmap(project: Project): Promise<RoadmapRow[]> {
  return buildRoadmap(await allIssues(project.repoPath));
}
